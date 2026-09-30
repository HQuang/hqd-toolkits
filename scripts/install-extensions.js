'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const hqdHome = path.resolve(process.env.HQD_HOME || path.join(os.homedir(), '.hqd'));
const receiptPath = path.join(hqdHome, 'state', 'extensions', 'receipt.json');
const extensions = [
  ['commands', path.join(packageRoot, 'commands')],
  ['scripts', path.join(packageRoot, 'scripts')]
];
const legacyDigests = {
  'commands/knowledge.sh': ['f56e714b9818af933a590bd7a78121357409d6a50bf53668905489cb14ba9961'],
  'commands/stripe.sh': ['047a2453d14a8f8dc630354eb87786cba5bbf477720dfddc364ae29f72f9aaa8'],
  'scripts/knowledge/knowledge-manager.sh': ['02de2d0ce94d11b6d8488fdae788b3847e9d51519afa045e11ea8a04c548f4e9'],
  'scripts/stripe/check_multi_customers.sh': ['6560d91cbf438cb26b011fff2f8046185593d1a3a0c3d3dcc57cc40479280e5b'],
  'scripts/stripe/example.sh': ['47b65b7a798c40f8ccfe4ef850a872e7086e8a3df0bbd4d8eb97a6f64b84d08b']
};

function digestFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ensureDirectory(directory, mode = 0o755) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`refusing symlink or non-directory path: ${current}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: current === absolute ? mode : 0o755 });
    }
  }
}

function assertNoSymlink(file) {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`refusing symlink path: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function readReceipt() {
  assertNoSymlink(receiptPath);
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (!receipt || receipt.version !== 1 || !receipt.managed || !receipt.transitions ||
        typeof receipt.managed !== 'object' || Array.isArray(receipt.managed) ||
        typeof receipt.transitions !== 'object' || Array.isArray(receipt.transitions)) {
      throw new Error('unsupported extension ownership receipt schema');
    }
    for (const [name, hash] of Object.entries(receipt.managed)) {
      if (!/^(commands|scripts)\/[A-Za-z0-9._/-]+\.(sh|js)$/.test(name) || name.includes('..') || !/^[a-f0-9]{64}$/.test(hash)) {
        throw new Error('malformed extension ownership receipt entry');
      }
    }
    for (const [name, transition] of Object.entries(receipt.transitions)) {
      if (!/^(commands|scripts)\/[A-Za-z0-9._/-]+\.(sh|js)$/.test(name) || name.includes('..') ||
          !transition || (transition.oldDigest !== null && !/^[a-f0-9]{64}$/.test(transition.oldDigest)) ||
          !/^[a-f0-9]{64}$/.test(transition.newDigest) || typeof transition.operationId !== 'string') {
        throw new Error('malformed extension ownership transition');
      }
    }
    return receipt;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, packageVersion: '', managed: {}, transitions: {} };
    throw error;
  }
}

function writeReceipt(receipt) {
  ensureDirectory(path.join(hqdHome, 'state'), 0o700);
  ensureDirectory(path.dirname(receiptPath), 0o700);
  fs.chmodSync(path.join(hqdHome, 'state'), 0o700);
  fs.chmodSync(path.dirname(receiptPath), 0o700);
  const temporary = `${receiptPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, receiptPath);
  fs.chmodSync(receiptPath, 0o600);
  const directory = fs.openSync(path.dirname(receiptPath), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function collectSources() {
  const files = new Map();
  for (const [rootName, sourceRoot] of extensions) {
    function visit(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const source = path.join(directory, entry.name);
        const relative = `${rootName}/${path.relative(sourceRoot, source).split(path.sep).join('/')}`;
        if (entry.isDirectory()) visit(source);
        else if (entry.isFile() && (entry.name.endsWith('.sh') || relative === 'scripts/knowledge/knowledge-manager.js')) files.set(relative, source);
      }
    }
    visit(sourceRoot);
  }
  return files;
}

function destinationFor(relative) {
  return path.join(hqdHome, ...relative.split('/'));
}

function reconcileTransitions(receipt) {
  for (const [relative, transition] of Object.entries(receipt.transitions)) {
    const destination = destinationFor(relative);
    assertNoSymlink(destination);
    let actual = null;
    try {
      if (!fs.lstatSync(destination).isFile()) throw new Error(`refusing non-file extension target: ${destination}`);
      actual = digestFile(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (actual === transition.newDigest) {
      receipt.managed[relative] = transition.newDigest;
    } else if (actual === transition.oldDigest) {
      if (actual) receipt.managed[relative] = actual;
      else delete receipt.managed[relative];
    } else {
      throw new Error(`extension update recovery required for ${destination}; current content matches neither recorded digest`);
    }
    delete receipt.transitions[relative];
    writeReceipt(receipt);
  }
}

function atomicCopy(source, destination, mode) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, mode & 0o777);
    const descriptor = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    assertNoSymlink(destination);
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function install() {
  assertNoSymlink(hqdHome);
  const sources = collectSources();
  let receipt = readReceipt();
  ensureDirectory(path.dirname(receiptPath), 0o700);
  reconcileTransitions(receipt);
  let installed = 0;
  let updated = 0;
  let preserved = 0;
  let recoveryRequired = false;

  for (const [relative, source] of sources) {
    const destination = destinationFor(relative);
    ensureDirectory(path.dirname(destination));
    assertNoSymlink(destination);
    const expected = digestFile(source);
    let current = null;
    try {
      const stat = fs.lstatSync(destination);
      if (!stat.isFile()) throw new Error(`refusing non-file extension target: ${destination}`);
      current = digestFile(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const ownedDigest = receipt.managed[relative];
    const knownLegacy = !ownedDigest && (legacyDigests[relative] || []).includes(current);
    if (current && !knownLegacy && current !== ownedDigest) {
      console.warn(`hqd-toolkits: preserved modified or custom extension ${destination}; it still shadows the bundled file.`);
      preserved += 1;
      continue;
    }

    if (current === expected) {
      if (ownedDigest || knownLegacy) receipt.managed[relative] = expected;
      continue;
    }

    const oldDigest = current;
    const transition = {
      operationId: crypto.randomUUID(),
      oldDigest,
      newDigest: expected
    };
    receipt.transitions[relative] = transition;
    writeReceipt(receipt);
    try {
      atomicCopy(source, destination, fs.statSync(source).mode);
      if (digestFile(destination) !== expected) throw new Error(`digest mismatch after replacing ${destination}`);
      receipt.managed[relative] = expected;
      delete receipt.transitions[relative];
      receipt.packageVersion = process.env.HQD_PACKAGE_VERSION || '';
      writeReceipt(receipt);
      if (oldDigest) updated += 1;
      else installed += 1;
    } catch (error) {
      try {
        const actual = fs.existsSync(destination) ? digestFile(destination) : null;
        if (actual !== oldDigest && actual !== expected) recoveryRequired = true;
      } catch { recoveryRequired = true; }
      if (recoveryRequired) {
        console.error(`hqd-toolkits: extension update recovery required for ${destination}; keep the file and receipt for the next run.`);
      }
      throw error;
    }
  }

  receipt.packageVersion = process.env.HQD_PACKAGE_VERSION || receipt.packageVersion;
  writeReceipt(receipt);
  console.log(`hqd-toolkits: installed ${installed}, upgraded ${updated}, preserved ${preserved} extension(s) in ${hqdHome}.`);
  if (recoveryRequired) process.exitCode = 1;
}

if (require.main === module) {
  try {
    install();
  } catch (error) {
    console.error(`hqd-toolkits: could not install extensions in ${hqdHome}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { install };
