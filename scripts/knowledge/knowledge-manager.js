'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const toolId = 'hqd-knowledge';
const markerPrefix = 'HQD-KNOWLEDGE';
const stateRoot = path.resolve(process.env.HQD_HOME || path.join(os.homedir(), '.hqd'), 'state', 'knowledge');
let activeJournal = null;
let activeLock = null;
let handlingSignal = false;

function fail(message, code = 1) { const error = new Error(message); error.exitCode = code; throw error; }
function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

function noSymlinks(target) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail(`Refuse symlinked path: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function mkdirSafe(directory, onCreate) {
  const absolute = path.resolve(directory);
  const created = [];
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    noSymlinks(current);
    try { if (!fs.lstatSync(current).isDirectory()) fail(`Refuse non-directory path: ${current}`); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (onCreate) onCreate(current);
      fs.mkdirSync(current, { mode: 0o700 });
      created.push(current);
    }
  }
  return created;
}

function validatePrivateDirectory(directory) {
  const absolute = path.resolve(directory);
  if (absolute !== stateRoot && !absolute.startsWith(`${stateRoot}${path.sep}`)) fail(`Private state directory is outside ${stateRoot}: ${absolute}`);
  const directories = [stateRoot];
  let current = stateRoot;
  for (const part of path.relative(stateRoot, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    directories.push(current);
  }
  for (const item of directories) {
    noSymlinks(item);
    const stat = fs.lstatSync(item);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) fail(`Private knowledge state directory must be mode 0700: ${item}`);
  }
}

function ensurePrivateDirectory(directory) {
  mkdirSafe(directory);
  validatePrivateDirectory(directory);
}

function atomicWrite(file, data, mode = 0o600, exclusive = false) {
  noSymlinks(file);
  let previous = null;
  try { previous = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.isSymbolicLink() || previous?.isDirectory() || (exclusive && previous)) fail(`Refuse overwrite target: ${file}`);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', mode);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    noSymlinks(file);
    if (exclusive && fs.existsSync(file)) fail(`Target appeared during install: ${file}`);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, mode);
    const parent = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function projectRoot(input) {
  noSymlinks(input);
  try { return fs.realpathSync(input); } catch { fail(`Project directory does not exist: ${input}`, 2); }
}

function absolutePath(value, base) {
  if (!value) return '';
  if (/[\x00-\x1f\x7f]/.test(value)) fail('Paths cannot contain control characters.', 2);
  const expanded = value.replace(/^~(?=$|\/)/, os.homedir());
  const result = path.resolve(base, expanded);
  noSymlinks(result);
  return result;
}

function storageRoot() {
  const configured = process.env.XDG_DATA_HOME || '';
  const base = configured && path.isAbsolute(configured) && !/[\x00-\x1f\x7f]/.test(configured)
    ? path.resolve(configured)
    : path.join(os.homedir(), '.local', 'share');
  noSymlinks(base);
  return path.join(base, 'hqd-toolkits');
}

function ensureWritableParent(target) {
  const parent = path.dirname(target);
  let existing = parent;
  while (!fs.existsSync(existing)) {
    const next = path.dirname(existing);
    if (next === existing) fail(`No existing parent directory for ${target}`);
    existing = next;
  }
  noSymlinks(existing);
  if (!fs.statSync(existing).isDirectory()) fail(`Parent path is not a directory: ${existing}`);
  try { fs.accessSync(existing, fs.constants.W_OK | fs.constants.X_OK); }
  catch { fail(`Parent directory is not writable: ${existing}`); }
}

function resolveStorage(config, explicit = {}) {
  const root = storageRoot();
  const memory = explicit.memory || path.join(root, 'agent-memory', config.slug, 'memory.jsonl');
  const vault = explicit.vault || path.join(root, 'agent-knowledge');
  config.memory = path.resolve(memory);
  config.vault = path.resolve(vault);
  config.knowledge = path.join(config.vault, 'Projects', config.slug, 'Knowledge');
  for (const target of [config.memory, config.vault, config.knowledge]) noSymlinks(target);
  if ([config.memory, config.vault, config.knowledge].some(target => target === config.root || target.startsWith(`${config.root}${path.sep}`))) {
    fail('Memory, vault, and project knowledge targets must remain outside the project checkout.', 2);
  }
  if (fs.existsSync(config.memory) && !fs.lstatSync(config.memory).isFile()) fail(`Memory target is not a regular file: ${config.memory}`);
  if (fs.existsSync(config.vault) && !fs.lstatSync(config.vault).isDirectory()) fail(`Vault target is not a directory: ${config.vault}`);
  if (fs.existsSync(config.vault)) {
    try { fs.accessSync(config.vault, fs.constants.W_OK | fs.constants.X_OK); }
    catch { fail(`Vault directory is not writable: ${config.vault}`); }
  }
  ensureWritableParent(config.memory);
  ensureWritableParent(config.vault);
  config.installationId ||= crypto.randomUUID();
  return config;
}

function validateNoStorageCollision(config) {
  const directory = path.join(stateRoot, 'receipts');
  if (!fs.existsSync(directory)) return;
  validatePrivateDirectory(directory);
  for (const name of fs.readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    noSymlinks(file);
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (![1, 2].includes(receipt.schemaVersion) || !path.isAbsolute(receipt.projectRoot) || !Array.isArray(receipt.entries) ||
        typeof receipt.projectSlug !== 'string' || typeof receipt.vault !== 'string' || typeof receipt.memory !== 'string') {
      fail(`Malformed ownership receipt; refusing storage collision check: ${file}`);
    }
    if (path.resolve(receipt.projectRoot) !== receipt.projectRoot || path.basename(file) !== `${hash(receipt.projectRoot)}.json`) fail(`Malformed ownership receipt identity: ${file}`);
    if (receipt.projectRoot === config.root || (config.installationId && receipt.installationId === config.installationId)) continue;
    const otherKnowledge = path.join(receipt.vault, 'Projects', receipt.projectSlug, 'Knowledge');
    const knowledge = config.knowledge || path.join(config.vault, 'Projects', config.slug, 'Knowledge');
    if (receipt.memory === config.memory || otherKnowledge === knowledge) {
      fail(`Storage path collision with project ${receipt.projectRoot}. Choose a distinct --project-slug or custom --memory/--vault paths before installing.`);
    }
  }
}

function decodeLegacyValue(value) {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const character = value[i];
    if (character === '\\') {
      if (++i >= value.length || /[\x00-\x1f\x7f]/.test(value[i])) fail('Unsupported legacy metadata escape; no shell evaluation was attempted.');
      result += value[i];
    } else {
      if (/\s|[$`"']|[\x00-\x1f\x7f]/.test(character)) fail('Unsupported legacy metadata encoding; no shell evaluation was attempted.');
      result += character;
    }
  }
  return result;
}

function readLegacy(file) {
  const fields = new Set(['TOOL_ID', 'SCHEMA_VERSION', 'PROJECT_DIR', 'PROJECT_SLUG', 'VAULT', 'MEMORY']);
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const at = line.indexOf('=');
    const key = line.slice(0, at);
    if (at < 1 || !fields.has(key) || Object.hasOwn(values, key)) fail('Malformed legacy metadata; no filesystem mutation was attempted.');
    values[key] = decodeLegacyValue(line.slice(at + 1));
  }
  if (Object.keys(values).length !== fields.size || values.TOOL_ID !== toolId || values.SCHEMA_VERSION !== '1' || path.resolve(values.PROJECT_DIR) !== values.PROJECT_DIR || !/^[A-Za-z0-9._-]+$/.test(values.PROJECT_SLUG)) fail('Unsupported legacy metadata; no shell evaluation was attempted.');
  return values;
}

function receiptPath(root) { return path.join(stateRoot, 'receipts', `${hash(root)}.json`); }
function lockPath(root) { return path.join(stateRoot, 'locks', `${hash(root)}.lock`); }
function journalPath(root) { return path.join(stateRoot, 'transactions', `${hash(root)}.json`); }

function findReceiptPath(root, metadata) {
  const direct = receiptPath(root);
  if (fs.existsSync(direct)) return direct;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(metadata.installationId || '')) return direct;
  const directory = path.dirname(direct);
  if (!fs.existsSync(directory)) return direct;
  validatePrivateDirectory(directory);
  const matches = [];
  for (const name of fs.readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    noSymlinks(file);
    const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (candidate.installationId === metadata.installationId) matches.push({ file, candidate });
  }
  if (matches.length !== 1) return direct;
  const match = matches[0];
  if (match.candidate.schemaVersion !== 2 || match.candidate.projectRoot === root ||
      path.resolve(match.candidate.projectRoot) !== match.candidate.projectRoot ||
      path.basename(match.file) !== `${hash(match.candidate.projectRoot)}.json` || fs.existsSync(match.candidate.projectRoot)) return direct;
  return match.file;
}

function rebaseReceipt(receipt, root) {
  const oldRoot = receipt.projectRoot;
  const rebase = target => target === oldRoot || target.startsWith(`${oldRoot}${path.sep}`)
    ? path.join(root, path.relative(oldRoot, target))
    : target;
  return {
    ...receipt,
    projectRoot: root,
    entries: receipt.entries.map(entry => ({ ...entry, target: rebase(entry.target) })),
    createdDirectories: receipt.createdDirectories.map(rebase)
  };
}

function installationMetadata(root) {
  const file = path.join(root, '.hqd-knowledge/install.json');
  if (!fs.existsSync(file)) return null;
  noSymlinks(file);
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (metadata.schemaVersion !== 2 || metadata.toolId !== toolId || !path.isAbsolute(metadata.projectRoot) ||
      path.resolve(metadata.projectRoot) !== metadata.projectRoot ||
      (metadata.installationId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(metadata.installationId))) fail('Malformed install identity; no filesystem mutation was attempted.');
  return metadata;
}

function findJournalPath(root) {
  const direct = journalPath(root);
  if (fs.existsSync(direct)) return direct;
  const metadata = installationMetadata(root);
  if (!metadata?.installationId) return direct;
  const directory = path.dirname(direct);
  if (!fs.existsSync(directory)) return direct;
  validatePrivateDirectory(directory);
  const matches = [];
  for (const name of fs.readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    noSymlinks(file);
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (journal.installationId === metadata.installationId && journal.projectRoot === metadata.projectRoot) matches.push({ file, journal });
  }
  if (matches.length !== 1 || metadata.projectRoot === root || fs.existsSync(metadata.projectRoot)) return direct;
  return matches[0].file;
}

function operationId(config, kind, target) {
  if (kind === 'directory') return `directory:${hash(target)}`;
  const targets = new Map([
    ...render(config).map(item => [item.target, item.id]),
    [path.join(config.root, '.hqd-knowledge/install.json'), 'metadata'],
    [path.join(config.root, '.hqd-knowledge/manifest.json'), 'manifest'],
    [receiptPath(config.root), 'receipt'],
    [config.memory, 'memory']
  ]);
  const id = targets.get(target);
  if (!id) fail(`Internal error: no operation id for ${target}`);
  return `file:${id}`;
}

async function withLock(root, callback) {
  ensurePrivateDirectory(path.dirname(lockPath(root)));
  try { fs.mkdirSync(lockPath(root), { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') {
      let owner = 'owner metadata missing';
      try { owner = fs.readFileSync(path.join(lockPath(root), 'owner.json'), 'utf8'); } catch {}
      fail(`Knowledge mutation lock is held at ${lockPath(root)} (${owner}). Verify the recorded process before manual stale-lock removal.`);
    }
    throw error;
  }
  activeLock = lockPath(root);
  try {
    fs.writeFileSync(path.join(lockPath(root), 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    await callback();
  }
  finally { try { fs.unlinkSync(path.join(lockPath(root), 'owner.json')); fs.rmdirSync(lockPath(root)); } catch {} activeLock = null; }
}

function readState(root, requireReceipt = false) {
  const directory = path.join(root, '.hqd-knowledge');
  noSymlinks(directory);
  const meta = path.join(directory, 'install.json');
  const manifest = path.join(directory, 'manifest.json');
  if (fs.existsSync(meta) && fs.existsSync(manifest)) {
    noSymlinks(meta);
    noSymlinks(manifest);
    const metadata = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const listing = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const trustedPath = findReceiptPath(root, metadata);
    validatePrivateDirectory(path.dirname(trustedPath));
    noSymlinks(trustedPath);
    if (!fs.existsSync(trustedPath)) fail('No trusted ownership receipt found for this project; no filesystem mutation was attempted.');
    const receipt = JSON.parse(fs.readFileSync(trustedPath, 'utf8'));
    const originalRoot = receipt.projectRoot;
    const relocated = originalRoot !== root;
    if (metadata.schemaVersion !== 2 || metadata.toolId !== toolId || metadata.projectRoot !== originalRoot || !Array.isArray(listing.entries) ||
        (metadata.installationId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(metadata.installationId)) ||
        (relocated && (!metadata.installationId || fs.existsSync(originalRoot)))) fail('Malformed or ambiguous project identity; no filesystem mutation was attempted.');
    if (![1, 2].includes(receipt.schemaVersion) || !path.isAbsolute(originalRoot) || path.resolve(originalRoot) !== originalRoot || path.basename(trustedPath) !== `${hash(originalRoot)}.json` || !Array.isArray(receipt.entries) ||
        (receipt.schemaVersion === 2 && (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(receipt.installationId || '') || receipt.installationId !== metadata.installationId)) ||
        receipt.projectSlug !== metadata.projectSlug || receipt.vault !== metadata.vault || receipt.memory !== metadata.memory ||
        !/^[A-Za-z0-9._-]+$/.test(metadata.projectSlug) || path.resolve(metadata.vault) !== metadata.vault || path.resolve(metadata.memory) !== metadata.memory ||
        !Array.isArray(receipt.createdDirectories)) fail('Malformed trusted ownership receipt; no filesystem mutation was attempted.');
    if (JSON.stringify(listing.entries) !== JSON.stringify(receipt.entries)) fail('Manifest does not match trusted receipt; no filesystem mutation was attempted.');
    const expected = new Map([
      ['agents', path.join(originalRoot, 'AGENTS.md')], ['codexConfig', path.join(originalRoot, '.codex/config.toml')],
      ['skill', path.join(originalRoot, '.agents/skills/knowledge-sync/SKILL.md')],
      ['schema', path.join(originalRoot, '.agents/skills/knowledge-sync/references/schema.md')],
      ['noteTemplate', path.join(originalRoot, '.agents/skills/knowledge-sync/assets/obsidian-note-template.md')],
      ['memory', metadata.memory]
    ]);
    if (receipt.entries.length !== expected.size) fail('Ownership receipt has an unexpected entry count; no filesystem mutation was attempted.');
    const ids = new Set();
    for (const entry of receipt.entries) {
      if (!entry || !/^[A-Za-z][A-Za-z0-9]*$/.test(entry.id) || typeof entry.target !== 'string' || path.resolve(entry.target) !== entry.target ||
          !['block', 'file', 'memory', 'existing-data'].includes(entry.kind) || (entry.kind !== 'existing-data' && !/^[a-f0-9]{64}$/.test(entry.sha256 || ''))) fail('Malformed ownership receipt entry; no filesystem mutation was attempted.');
      if (ids.has(entry.id) || expected.get(entry.id) !== entry.target) fail('Ownership receipt target is outside the known integration paths; no filesystem mutation was attempted.');
      const expectedKind = entry.id === 'memory' ? ['memory', 'existing-data'] : ['agents', 'codexConfig'].includes(entry.id) ? ['block'] : ['file'];
      if (!expectedKind.includes(entry.kind) || typeof entry.created !== 'boolean' ||
          (entry.kind === 'block' && (typeof entry.begin !== 'string' || typeof entry.end !== 'string' || typeof entry.body !== 'string')) ||
          (entry.kind !== 'block' && entry.kind !== 'existing-data' && !/^[a-f0-9]{64}$/.test(entry.sha256 || ''))) fail('Malformed ownership receipt entry; no filesystem mutation was attempted.');
      ids.add(entry.id);
    }
    const externalAllowed = [metadata.memory, path.join(metadata.vault, 'Projects', metadata.projectSlug, 'Knowledge')];
    for (const directory of receipt.createdDirectories) {
      if (typeof directory !== 'string' || path.resolve(directory) !== directory ||
          !(directory.startsWith(`${originalRoot}${path.sep}`) || externalAllowed.some(target => target === directory || target.startsWith(`${directory}${path.sep}`)))) fail('Ownership receipt contains an out-of-scope directory; no filesystem mutation was attempted.');
    }
    const mode = fs.statSync(trustedPath).mode & 0o777;
    if (mode !== 0o600) fail('Ownership receipt permissions are not private; no filesystem mutation was attempted.');
    return { metadata, listing, receipt: relocated ? rebaseReceipt(receipt, root) : receipt, trustedPath, legacy: false };
  }
  const legacyMeta = path.join(directory, ['install', 'env'].join('.'));
  const legacyManifest = path.join(directory, 'manifest.tsv');
  if (fs.existsSync(legacyMeta) && fs.existsSync(legacyManifest)) {
    const metadata = readLegacy(legacyMeta);
    const entries = fs.readFileSync(legacyManifest, 'utf8').split('\n').filter(Boolean).map((line, index) => {
      const fields = line.split('\t');
      if (fields.length !== 5 || !['STATE_DIR','STATE_FILE','DIR','EXTERNAL_DIR','BLOCK','FILE','DATA_FILE','DATA_EXISTING','DATA_DIR','DATA_DIR_EXISTING'].includes(fields[0])) fail(`Malformed legacy manifest row ${index + 1}; no filesystem mutation was attempted.`);
      return fields;
    });
    if (requireReceipt) fail(`Legacy install has no trusted ownership receipt. No files or runtime data were removed. Review ${directory} manually.`);
    return { metadata, listing: { entries }, receipt: null, legacy: true };
  }
  fail(`No valid knowledge installation state found at ${directory}.`);
}

function render(config) {
  const begin = name => `# >>> ${markerPrefix}:${name} >>>`;
  const end = name => `# <<< ${markerPrefix}:${name} <<<`;
  const agentText = `## Project Knowledge Workflow (managed by hqd-toolkits)\n\nMCP Memory is the concise knowledge index, project files in the configured vault hold detailed notes, source code is current truth, and AgentKit is the investigation fallback. This project's notes belong in ${config.knowledge}. Search Memory first, read the exact linked note on a hit, and verify current behavior against source. Use filesystem operations for normal note reads, writes, and search; use content search such as rg for full-text search because filesystem search_files matches paths and filenames. Obsidian CLI is optional for app-native commands, and REST is optional for plugin-specific features. Separate concurrent writes to different notes or serialize writes to the same note. Route Memory edits through the configured Memory MCP service. Write detailed notes before updating concise Memory observations. Never invent project facts or store secrets.\n`;
  const skillText = `---\nname: knowledge-sync\ndescription: Look up, create, update, or repair project knowledge using MCP Memory and filesystem access to the configured vault.\n---\n\n# Knowledge Sync\n\nSearch MCP Memory first. This project's notes are in ${config.knowledge}. On a hit, read its exact linked note from the configured vault and verify source when relevant. On a miss, investigate project files and use AgentKit when useful. Use filesystem operations for note reads, writes, and search; use rg or equivalent content search for full-text queries because filesystem search_files searches paths and filenames. Obsidian CLI is optional for app-native commands, and REST is optional for plugin-specific features. Separate concurrent writes to different notes or serialize writes to one note. Route Memory edits through the configured Memory MCP service. For reusable knowledge, write the detailed note first, then update a concise Memory entity.\n`;
  const schemaText = `# Knowledge schema\n\nKeep a stable knowledge_id, concise Memory observations, and an exact obsidian_path. Obsidian notes use frontmatter for knowledge_id, project, type, tags, created, updated, and status.\n`;
  const noteText = `---\nknowledge_id: knowledge:<domain>:<topic>\nproject: ${config.slug}\ntype: knowledge\ntags: []\ncreated: YYYY-MM-DD\nupdated: YYYY-MM-DD\nstatus: active\n---\n\n# Title\n\n## Summary\n\n## Context\n\n## Current implementation\n\n## Decisions\n`;
  const codexText = `[mcp_servers.hqd_knowledge_memory]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-memory"]\n\n[mcp_servers.hqd_knowledge_memory.env]\nMEMORY_FILE_PATH = ${JSON.stringify(config.memory)}\n\n[mcp_servers.hqd_knowledge_obsidian]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-filesystem", ${JSON.stringify(config.vault)}]\n`;
  return [
    { id: 'agents', target: path.join(config.root, 'AGENTS.md'), type: 'block', begin: begin('AGENTS'), end: end('AGENTS'), body: agentText },
    { id: 'codexConfig', target: path.join(config.root, '.codex/config.toml'), type: 'block', begin: begin('CODEX-MCP'), end: end('CODEX-MCP'), body: codexText },
    { id: 'skill', target: path.join(config.root, '.agents/skills/knowledge-sync/SKILL.md'), type: 'file', body: skillText },
    { id: 'schema', target: path.join(config.root, '.agents/skills/knowledge-sync/references/schema.md'), type: 'file', body: schemaText },
    { id: 'noteTemplate', target: path.join(config.root, '.agents/skills/knowledge-sync/assets/obsidian-note-template.md'), type: 'file', body: noteText }
  ];
}

function preflight(config) {
  const state = path.join(config.root, '.hqd-knowledge');
  if ([config.memory, config.vault].some(target => target === config.root || target.startsWith(`${config.root}${path.sep}`))) fail('Memory and vault targets must remain outside the project checkout.', 2);
  noSymlinks(state);
  if (fs.existsSync(state)) fail(`${state} already exists; refusing to overwrite unknown install state.`);
  for (const item of render(config)) {
    noSymlinks(item.target);
    if (item.type === 'file' && fs.existsSync(item.target)) fail(`Refuse overwrite existing path: ${item.target}`);
    if (item.type === 'block' && fs.existsSync(item.target)) {
      const existing = fs.readFileSync(item.target, 'utf8');
      if (existing.includes(item.begin) || existing.includes(item.end)) fail(`Managed block already exists or is ambiguous in ${item.target}`);
    }
  }
  noSymlinks(config.memory);
  if (fs.existsSync(config.memory) && !fs.lstatSync(config.memory).isFile()) fail(`Memory target is not a regular file: ${config.memory}`);
  noSymlinks(config.vault);
}

function yieldToSignals() { return new Promise(resolve => setImmediate(resolve)); }

async function install(config) {
  preflight(config);
  ensurePrivateDirectory(path.dirname(receiptPath(config.root)));
  ensurePrivateDirectory(path.dirname(journalPath(config.root)));
  const state = path.join(config.root, '.hqd-knowledge');
  const journal = { schemaVersion: 1, projectRoot: config.root, installationId: config.installationId, vault: config.vault, memory: config.memory, slug: config.slug, operations: [] };
  activeJournal = journal;
  mkdirSafe(path.dirname(journalPath(config.root)));
  atomicWrite(journalPath(config.root), JSON.stringify(journal), 0o600, true);
  const createdDirectories = [];
  const entries = [];
  const ensureParent = async target => {
    const created = mkdirSafe(path.dirname(target), directory => {
    journal.operations.push({ id: operationId(config, 'directory', directory), kind: 'directory', target: directory });
    atomicWrite(journalPath(config.root), JSON.stringify(journal), 0o600);
    createdDirectories.push(directory);
    });
    if (created.length) await yieldToSignals();
  };
  const write = async (target, data, mode = 0o644, exclusive = false, track = true, entryId = '') => {
    await ensureParent(target);
    const priorStat = fs.existsSync(target) ? fs.statSync(target) : null;
    const before = priorStat ? fs.readFileSync(target) : null;
    journal.operations.push({ id: operationId(config, 'file', target), kind: 'file', target, before: before?.toString('base64') ?? null, beforeMode: priorStat ? priorStat.mode & 0o777 : null, after: hash(Buffer.from(data)) });
    atomicWrite(journalPath(config.root), JSON.stringify(journal), 0o600);
    atomicWrite(target, data, mode, exclusive);
    await yieldToSignals();
    if (track) entries.push({ id: entryId || path.basename(target).replace(/[^A-Za-z0-9]/g, '') || 'entry', target, kind: 'file', sha256: hash(Buffer.from(data)), created: before === null });
  };
  try {
    const metadata = { schemaVersion: 2, toolId, projectRoot: config.root, installationId: config.installationId, projectSlug: config.slug, vault: config.vault, memory: config.memory };
    if (mkdirSafe(state, directory => { journal.operations.push({ id: operationId(config, 'directory', directory), kind: 'directory', target: directory }); atomicWrite(journalPath(config.root), JSON.stringify(journal), 0o600); createdDirectories.push(directory); }).length) await yieldToSignals();
    await write(path.join(state, 'install.json'), `${JSON.stringify(metadata, null, 2)}\n`, 0o600, true, false);
    if (mkdirSafe(config.vault, directory => { journal.operations.push({ id: operationId(config, 'directory', directory), kind: 'directory', target: directory }); atomicWrite(journalPath(config.root), JSON.stringify(journal), 0o600); createdDirectories.push(directory); }).length) await yieldToSignals();
    for (const item of render(config)) {
      noSymlinks(item.target);
      if (item.type === 'block') {
        await ensureParent(item.target);
        const exists = fs.existsSync(item.target);
        const before = exists ? fs.readFileSync(item.target, 'utf8') : '';
        if (before.includes(item.begin) || before.includes(item.end)) fail(`Managed block already exists or is ambiguous in ${item.target}`);
        const prefix = before && !before.endsWith('\n') ? `${before}\n` : before;
        const result = `${prefix}${item.begin}\n${item.body}${item.end}\n`;
        const oldBytes = exists ? Buffer.from(before) : null;
        const beforeMode = exists ? fs.statSync(item.target).mode & 0o777 : null;
        journal.operations.push({ id: operationId(config, 'file', item.target), kind: 'file', target: item.target, before: oldBytes?.toString('base64') ?? null, beforeMode, after: hash(Buffer.from(result)) });
        atomicWrite(journalPath(config.root), JSON.stringify(journal), 0o600);
        atomicWrite(item.target, result, 0o644, !exists);
        await yieldToSignals();
        entries.push({ id: item.id, target: item.target, kind: 'block', sha256: hash(Buffer.from(result)), begin: item.begin, end: item.end, body: item.body, created: !exists });
      } else await write(item.target, item.body, 0o644, true, true, item.id);
    }
    const memoryParent = path.dirname(config.memory);
    if (mkdirSafe(memoryParent, directory => { journal.operations.push({ id: operationId(config, 'directory', directory), kind: 'directory', target: directory }); atomicWrite(journalPath(config.root), JSON.stringify(journal), 0o600); createdDirectories.push(directory); }).length) await yieldToSignals();
    if (!fs.existsSync(config.memory)) {
      await write(config.memory, '', 0o600, true);
      entries[entries.length - 1] = { ...entries[entries.length - 1], id: 'memory', kind: 'memory' };
    }
    else entries.push({ id: 'memory', target: config.memory, kind: 'existing-data', created: false });
    const vaultKnowledge = path.join(config.vault, 'Projects', config.slug, 'Knowledge');
    if (mkdirSafe(vaultKnowledge, directory => { journal.operations.push({ id: operationId(config, 'directory', directory), kind: 'directory', target: directory }); atomicWrite(journalPath(config.root), JSON.stringify(journal), 0o600); createdDirectories.push(directory); }).length) await yieldToSignals();
    const manifest = { schemaVersion: 1, entries };
    const receipt = { schemaVersion: 2, projectRoot: config.root, installationId: config.installationId, projectSlug: config.slug, vault: config.vault, memory: config.memory, entries, createdDirectories };
    await write(path.join(state, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600, true, false);
    if (mkdirSafe(path.dirname(receiptPath(config.root)), directory => { journal.operations.push({ id: operationId(config, 'directory', directory), kind: 'directory', target: directory }); atomicWrite(journalPath(config.root), JSON.stringify(journal), 0o600); }).length) await yieldToSignals();
    journal.operations.push({ id: operationId(config, 'file', receiptPath(config.root)), kind: 'file', target: receiptPath(config.root), before: null, beforeMode: null, after: hash(Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)) });
    atomicWrite(journalPath(config.root), JSON.stringify(journal), 0o600);
    atomicWrite(receiptPath(config.root), `${JSON.stringify(receipt, null, 2)}\n`, 0o600, true);
    await yieldToSignals();
    fs.unlinkSync(journalPath(config.root));
    activeJournal = null;
    console.log(`Knowledge workflow installed.\nProject : ${config.root}\nSlug    : ${config.slug}\nVault   : ${config.vault}\nMemory  : ${config.memory}`);
  } catch (error) {
    const conflicts = rollbackJournal(journal);
    if (!conflicts.length) { try { fs.unlinkSync(journalPath(config.root)); } catch {} }
    else error.message += `\nrecovery_required; preserved conflicting paths: ${conflicts.join(', ')}`;
    throw error;
  } finally {
    if (!fs.existsSync(journalPath(config.root))) activeJournal = null;
  }
}

function rollbackJournal(journal) {
  const conflicts = [];
  for (const operation of [...journal.operations].reverse()) {
    try {
      noSymlinks(operation.target);
      if (operation.kind === 'directory') {
        try { fs.rmdirSync(operation.target); }
        catch (error) { if (error.code === 'ENOENT') continue; if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') fail('directory contains concurrent or unowned content'); throw error; }
        continue;
      }
      if (!fs.existsSync(operation.target)) continue;
      const current = fs.readFileSync(operation.target);
      if (hash(current) !== operation.after) {
        if (operation.before !== null && hash(current) === hash(Buffer.from(operation.before, 'base64'))) continue;
        fail('content changed during rollback');
      }
      if (operation.before === null) fs.unlinkSync(operation.target);
      else atomicWrite(operation.target, Buffer.from(operation.before, 'base64'), operation.beforeMode ?? 0o644);
    } catch (error) { conflicts.push(`${operation.target}: ${error.message}`); }
  }
  return conflicts;
}

function recoverJournal(root, explicit = {}, file = journalPath(root)) {
  noSymlinks(file);
  if (!fs.existsSync(file)) return false;
  validatePrivateDirectory(path.dirname(file));
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  const originalRoot = journal.projectRoot;
  const relocated = originalRoot !== root;
  if (journal.schemaVersion !== 1 || !path.isAbsolute(originalRoot) || path.resolve(originalRoot) !== originalRoot ||
      path.basename(file) !== `${hash(originalRoot)}.json` || !Array.isArray(journal.operations) ||
      (relocated && (!journal.installationId || fs.existsSync(originalRoot)))) {
    fail(`Interrupted transaction needs the original install arguments. Journal preserved at ${file}.`);
  }
  const checked = { root, slug: journal.slug, installationId: journal.installationId || crypto.randomUUID(), vault: journal.vault, memory: journal.memory };
  checked.knowledge = path.join(checked.vault, 'Projects', checked.slug, 'Knowledge');
  if (!/^[A-Za-z0-9._-]+$/.test(checked.slug) || path.resolve(checked.vault) !== checked.vault || path.resolve(checked.memory) !== checked.memory) fail(`Malformed transaction journal preserved at ${file}.`);
  if ((explicit.vault !== undefined && explicit.vault !== checked.vault) ||
      (explicit.memory !== undefined && explicit.memory !== checked.memory) ||
      (explicit.slug !== undefined && explicit.slug !== checked.slug)) {
    fail(`Interrupted transaction needs its recorded --memory, --vault, and --project-slug values. Journal preserved at ${file}.`);
  }
  const original = { ...checked, root: originalRoot };
  const allowedFiles = new Set([...render(original).map(item => item.target), path.join(originalRoot, '.hqd-knowledge/install.json'), path.join(originalRoot, '.hqd-knowledge/manifest.json'), receiptPath(originalRoot), checked.memory]);
  const allowedDirectories = new Set();
  for (const filePath of allowedFiles) {
    let parent = path.dirname(filePath);
    while (parent !== path.dirname(parent)) { allowedDirectories.add(parent); parent = path.dirname(parent); }
  }
  for (const directoryPath of [checked.vault, path.join(checked.vault, 'Projects', checked.slug, 'Knowledge'), path.dirname(checked.memory), path.join(originalRoot, '.hqd-knowledge')]) {
    let current = path.resolve(directoryPath);
    while (current !== path.dirname(current)) { allowedDirectories.add(current); current = path.dirname(current); }
  }
  for (const operation of journal.operations) {
    if (!operation || !path.isAbsolute(operation.target) || path.resolve(operation.target) !== operation.target ||
        (operation.kind === 'file' ? !allowedFiles.has(operation.target) : operation.kind !== 'directory' || !allowedDirectories.has(operation.target))) fail(`Malformed or out-of-scope recovery operation in ${file}; journal preserved.`);
    if (operation.id !== operationId(original, operation.kind, operation.target)) fail(`Recovery operation id does not match its derived target in ${file}; journal preserved.`);
    if (operation.kind === 'file' && (typeof operation.after !== 'string' || !/^[a-f0-9]{64}$/.test(operation.after) ||
        (operation.before !== null && (typeof operation.before !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(operation.before) || !Number.isInteger(operation.beforeMode) || operation.beforeMode < 0 || operation.beforeMode > 0o777)) ||
        (operation.before === null && operation.beforeMode !== null))) fail(`Malformed recovery journal file preimage at ${file}; journal preserved.`);
  }
  if (relocated) {
    for (const operation of journal.operations) {
      if (operation.target === originalRoot || operation.target.startsWith(`${originalRoot}${path.sep}`)) {
        operation.target = path.join(root, path.relative(originalRoot, operation.target));
      }
    }
  }
  const conflicts = rollbackJournal(journal);
  if (conflicts.length) fail(`recovery_required; journal retained at ${file}: ${conflicts.join('; ')}`);
  fs.unlinkSync(file);
  return checked;
}

function uninstall(root, args) {
  const state = readState(root, true);
  const receipt = state.receipt;
  const purge = args.includes('--purge-empty-data');
  const selectedMemory = args.includes('--memory') ? absolutePath(args[args.indexOf('--memory') + 1], process.cwd()) : '';
  const selectedVault = args.includes('--vault') ? absolutePath(args[args.indexOf('--vault') + 1], process.cwd()) : '';
  if (purge && (!selectedMemory || !selectedVault || selectedMemory !== receipt.memory || selectedVault !== receipt.vault)) fail('Purge requires matching canonical --memory and --vault selectors; no files were changed.');
  const allowed = new Set([
    path.join(root, 'AGENTS.md'), path.join(root, '.codex/config.toml'),
    path.join(root, '.agents/skills/knowledge-sync/SKILL.md'), path.join(root, '.agents/skills/knowledge-sync/references/schema.md'),
    path.join(root, '.agents/skills/knowledge-sync/assets/obsidian-note-template.md'), path.join(root, '.hqd-knowledge/install.json'), path.join(root, '.hqd-knowledge/manifest.json'),
    receipt.memory, ...receipt.createdDirectories
  ]);
  for (const entry of receipt.entries) if (!allowed.has(entry.target)) fail(`Receipt entry is outside the fixed target allowlist: ${entry.target}`);
  for (const entry of receipt.entries) { noSymlinks(entry.target); }
  const externalDirectoriesToRemove = purge
    ? [path.dirname(receipt.memory), path.join(receipt.vault, 'Projects', receipt.projectSlug, 'Knowledge')]
    : [];
  for (const directory of receipt.createdDirectories) {
    if (directory.startsWith(`${root}${path.sep}`) || externalDirectoriesToRemove.includes(directory)) noSymlinks(directory);
  }
  for (const entry of [...receipt.entries].reverse()) {
    noSymlinks(entry.target);
    if (entry.kind === 'existing-data') { console.log(`Preserved runtime data: ${entry.target}`); continue; }
    if (entry.kind === 'memory' && !purge) { console.log(`Preserved runtime data: ${entry.target}`); continue; }
    if (entry.kind === 'memory' && receipt.memory !== selectedMemory) fail('Memory selector does not match the trusted receipt.');
    if (!fs.existsSync(entry.target)) continue;
    const current = fs.readFileSync(entry.target);
    if (entry.kind === 'block') {
      const text = current.toString('utf8');
      const block = `${entry.begin}\n${entry.body}${entry.end}\n`;
      const first = text.indexOf(entry.begin);
      const last = text.indexOf(entry.end);
      if (first < 0 || last < first || text.indexOf(entry.begin, first + 1) >= 0 || text.indexOf(entry.end, last + 1) >= 0 || text.slice(first, last + entry.end.length + 1) !== block) {
        console.warn(`Preserved edited or ambiguous managed block in ${entry.target}`); continue;
      }
      const updated = `${text.slice(0, first)}${text.slice(last + entry.end.length + 1)}`;
      if (entry.created && !updated.trim()) fs.unlinkSync(entry.target);
      else atomicWrite(entry.target, updated, 0o644);
    } else if (hash(current) === entry.sha256) fs.unlinkSync(entry.target);
    else console.warn(`Preserved modified file: ${entry.target}`);
  }
  const vaultData = path.join(receipt.vault, 'Projects', receipt.projectSlug, 'Knowledge');
  const memoryParent = path.dirname(receipt.memory);
  for (const directory of [...receipt.createdDirectories].sort((a, b) => b.length - a.length)) {
    const projectOwned = directory.startsWith(`${root}${path.sep}`);
    const purgeOwned = purge && (directory === memoryParent || directory === vaultData);
    if (!projectOwned && !purgeOwned) continue;
    noSymlinks(directory);
    try { fs.rmdirSync(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
  for (const file of [path.join(root, '.hqd-knowledge/manifest.json'), path.join(root, '.hqd-knowledge/install.json')]) if (fs.existsSync(file)) fs.unlinkSync(file);
  try { fs.rmdirSync(path.join(root, '.hqd-knowledge')); } catch {}
  fs.unlinkSync(state.trustedPath);
  console.log('Knowledge workflow uninstall completed safely.');
}

async function main(argv) {
  const action = argv[0];
  if (!action || ['-h', '--help'].includes(action)) {
    console.log(`Usage: knowledge <install|status|doctor|uninstall> [options]

Options:
  --project-dir PATH   Project directory (defaults to the current directory)
  --project-slug NAME  Project name used for generated integration paths
  --vault PATH         Obsidian vault path (default: $XDG_DATA_HOME/hqd-toolkits/agent-knowledge)
  --memory PATH        Agent Memory JSONL path (default: $XDG_DATA_HOME/hqd-toolkits/agent-memory/<slug>/memory.jsonl)
  --purge-empty-data   Remove unchanged installer-created empty runtime data

XDG_DATA_HOME must be absolute; otherwise $HOME/.local/share is used.
Install paths are saved in a private receipt and reused by later commands.
No data is moved when paths or environment variables change.
Purge requires --memory and --vault to match the trusted install receipt.
Unreceipted or modified files and non-empty data directories are preserved.`);
    return;
  }
  const args = argv.slice(1);
  let projectInput = process.cwd();
  const index = args.indexOf('--project-dir');
  if (index >= 0) { if (!args[index + 1]) fail('--project-dir requires PATH', 2); projectInput = args[index + 1]; args.splice(index, 2); }
  const root = projectRoot(projectInput);
  const explicit = {};
  let slug = path.basename(root);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--project-slug') { if (!args[i + 1]) fail('--project-slug requires NAME', 2); slug = args[++i]; explicit.slug = slug; }
    else if (args[i] === '--vault') { if (!args[i + 1]) fail('--vault requires PATH', 2); explicit.vault = absolutePath(args[++i], process.cwd()); }
    else if (args[i] === '--memory') { if (!args[i + 1]) fail('--memory requires PATH', 2); explicit.memory = absolutePath(args[++i], process.cwd()); }
    else if (args[i] !== '--purge-empty-data') fail(`Unknown option: ${args[i]}`, 2);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) fail('Invalid project slug', 2);
  if (action === 'status') {
    const journal = findJournalPath(root);
    if (fs.existsSync(journal)) { console.log(`Interrupted installation transaction requires recovery with the original install arguments: ${journal}`); return; }
    const state = readState(root);
    console.log(state.legacy
      ? `Status : legacy schema-v1 (cleanup disabled without trusted receipt)\nVault  : ${state.metadata.VAULT}\nMemory : ${state.metadata.MEMORY}`
      : `Status : installed\nOwned entries: ${state.receipt.entries.length}\nVault  : ${state.receipt.vault}\nMemory : ${state.receipt.memory}`);
    return;
  }
  if (!['install', 'uninstall', 'doctor'].includes(action)) fail(`Unknown action: ${action}`, 2);
  if (action === 'install' && !fs.existsSync(findJournalPath(root))) {
    const stateDirectory = path.join(root, '.hqd-knowledge');
    if (fs.existsSync(stateDirectory)) {
      const state = readState(root, true);
      const receipt = state.receipt;
      if ((explicit.vault !== undefined && explicit.vault !== receipt.vault) ||
          (explicit.memory !== undefined && explicit.memory !== receipt.memory) ||
          (explicit.slug !== undefined && explicit.slug !== receipt.projectSlug)) {
        fail(`This project is already installed with Vault ${receipt.vault} and Memory ${receipt.memory}. Use those paths or uninstall before reinstalling; data is never relocated automatically.`);
      }
    } else {
      const config = resolveStorage({ root, slug }, explicit);
      validateNoStorageCollision(config);
    }
  }
  await withLock(root, async () => {
    if (action === 'install') {
      let config;
      let alreadyInstalled = false;
      const pendingJournal = findJournalPath(root);
      if (fs.existsSync(pendingJournal)) {
        config = recoverJournal(root, explicit, pendingJournal);
        console.log('Recovered the previous install transaction.');
      } else {
        const stateDirectory = path.join(root, '.hqd-knowledge');
        if (fs.existsSync(stateDirectory)) {
          const state = readState(root, true);
          const receipt = state.receipt;
          if ((explicit.vault !== undefined && explicit.vault !== receipt.vault) ||
              (explicit.memory !== undefined && explicit.memory !== receipt.memory) ||
              (explicit.slug !== undefined && explicit.slug !== receipt.projectSlug)) {
            fail(`This project is already installed with Vault ${receipt.vault} and Memory ${receipt.memory}. Use those paths or uninstall before reinstalling; data is never relocated automatically.`);
          }
          config = { root, slug: receipt.projectSlug, installationId: receipt.installationId, vault: receipt.vault, memory: receipt.memory };
          alreadyInstalled = true;
        } else {
          config = resolveStorage({ root, slug }, explicit);
        }
      }
      if (alreadyInstalled) {
        console.log(`Knowledge workflow already installed.\nProject : ${root}\nSlug    : ${config.slug}\nVault   : ${config.vault}\nMemory  : ${config.memory}`);
        return;
      }
      validateNoStorageCollision(config);
      await install(config);
    }
    else if (action === 'uninstall') uninstall(root, args);
    else {
      const state = readState(root);
      if (state.legacy) console.warn('Legacy metadata parsed as data; it does not authorize external cleanup.');
      for (const command of ['node', 'npx', 'codex']) {
        const found = process.env.PATH.split(path.delimiter).some(directory => {
          try { fs.accessSync(path.join(directory, command), fs.constants.X_OK); return true; } catch { return false; }
        });
        if (!found) fail(`Required command not found: ${command}`);
      }
      if (state.receipt) {
        for (const item of state.receipt.entries) {
          if (['block', 'file'].includes(item.kind) && !fs.existsSync(item.target)) fail(`Missing integration: ${item.target}`);
        }
        if (!fs.statSync(state.receipt.memory).isFile()) fail(`Memory file is not reachable: ${state.receipt.memory}`);
        if (!fs.statSync(state.receipt.vault).isDirectory()) fail(`Obsidian vault is not reachable: ${state.receipt.vault}`);
      }
      if (state.receipt) console.log(`Doctor passed.\nVault  : ${state.receipt.vault}\nMemory : ${state.receipt.memory}`);
      else console.log('Doctor passed.');
    }
  });
}

function handleSignal(code) {
  if (handlingSignal) return;
  handlingSignal = true;
  if (process.env.HQD_DEBUG_SIGNALS) console.error(`received signal, active=${Boolean(activeJournal)}, listeners=${process.listenerCount('SIGTERM')}`);
  if (activeJournal) {
    const conflicts = rollbackJournal(activeJournal);
    if (conflicts.length) console.error(`recovery_required; journal retained at ${journalPath(activeJournal.projectRoot)}: ${conflicts.join('; ')}`);
    else { try { fs.unlinkSync(journalPath(activeJournal.projectRoot)); } catch {} }
  }
  if (activeLock) {
    try { fs.unlinkSync(path.join(activeLock, 'owner.json')); fs.rmdirSync(activeLock); } catch {}
    activeLock = null;
  }
  process.exit(code);
}

if (require.main === module) {
  process.on('SIGINT', () => handleSignal(130));
  process.on('SIGTERM', () => handleSignal(143));
  main(process.argv.slice(2)).catch(error => { console.error(`hqd-toolkits knowledge: ${error.message}`); process.exitCode = error.exitCode || 1; });
}

module.exports = { main, readLegacy, decodeLegacyValue };
