'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const root = path.resolve(__dirname, '..');
const installer = path.join(root, 'scripts', 'install-extensions.js');
const homes = [];

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hqd-extension-test-'));
  homes.push(home);
  return home;
}

function run(home) {
  const previousHome = process.env.HQD_HOME;
  const previousVersion = process.env.HQD_PACKAGE_VERSION;
  const messages = { stdout: [], stderr: [] };
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  try {
    process.env.HQD_HOME = home;
    process.env.HQD_PACKAGE_VERSION = '0.1.1';
    delete require.cache[require.resolve(installer)];
    console.log = (...values) => messages.stdout.push(values.join(' '));
    console.warn = (...values) => messages.stderr.push(values.join(' '));
    console.error = (...values) => messages.stderr.push(values.join(' '));
    require(installer).install();
    return { status: 0, stdout: `${messages.stdout.join('\n')}\n`, stderr: messages.stderr.join('\n') };
  } catch (caught) {
    messages.stderr.push(`hqd-toolkits: could not install extensions in ${home}: ${caught.message}`);
    return { status: 1, stdout: messages.stdout.join('\n'), stderr: messages.stderr.join('\n') };
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
    if (previousHome === undefined) delete process.env.HQD_HOME;
    else process.env.HQD_HOME = previousHome;
    if (previousVersion === undefined) delete process.env.HQD_PACKAGE_VERSION;
    else process.env.HQD_PACKAGE_VERSION = previousVersion;
  }
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function receiptPath(home) {
  return path.join(home, 'state', 'extensions', 'receipt.json');
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

test('fresh install records copies and a repeated run is idempotent', () => {
  const home = setup();
  const first = run(home);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /installed [1-9]/);
  const receipt = JSON.parse(fs.readFileSync(receiptPath(home), 'utf8'));
  const destination = path.join(home, 'scripts', 'stripe', 'check_multi_customers.sh');
  assert.equal(receipt.managed['scripts/stripe/check_multi_customers.sh'], digest(destination));
  const knowledgeRuntime = path.join(home, 'scripts', 'knowledge', 'knowledge-manager.js');
  assert.equal(fs.readFileSync(knowledgeRuntime, 'utf8'), fs.readFileSync(path.join(root, 'scripts/knowledge/knowledge-manager.js'), 'utf8'));

  const second = run(home);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /installed 0, upgraded 0/);
});

test('known package copy upgrades, while modified and unknown copies are preserved', () => {
  const home = setup();
  const legacy = path.join(home, 'scripts', 'stripe', 'check_multi_customers.sh');
  const custom = path.join(home, 'commands', 'stripe.sh');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.mkdirSync(path.dirname(custom), { recursive: true });
  fs.writeFileSync(legacy, String.raw`#!/usr/bin/env bash
set -euo pipefail

for CUSTOMER_ID in "$@"; do
  HAS_ACTIVE=$(stripe subscriptions list --customer="$CUSTOMER_ID" \
    | jq -r '[.data[] | select(.status=="active" or .status=="trialing")] | length')

  if [[ "$HAS_ACTIVE" -gt 0 ]]; then
    echo "$CUSTOMER_ID | active"
  else
    echo "$CUSTOMER_ID | inactive"
  fi
done
`);
  assert.equal(digest(legacy), '6560d91cbf438cb26b011fff2f8046185593d1a3a0c3d3dcc57cc40479280e5b');
  fs.writeFileSync(custom, '# custom command\n');
  const customBefore = fs.readFileSync(custom);

  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /upgraded 1/);
  assert.match(result.stderr, /preserved modified or custom extension/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), fs.readFileSync(path.join(root, 'scripts/stripe/check_multi_customers.sh'), 'utf8'));
  assert.deepEqual(fs.readFileSync(custom), customBefore);
});

test('unreceipted unknown same-name file is never overwritten', () => {
  const home = setup();
  const custom = path.join(home, 'scripts', 'knowledge', 'knowledge-manager.sh');
  fs.mkdirSync(path.dirname(custom), { recursive: true });
  fs.writeFileSync(custom, '# user-owned\n');
  const before = fs.readFileSync(custom);

  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /preserved modified or custom extension/);
  assert.deepEqual(fs.readFileSync(custom), before);
});

test('interrupted replacement is reconciled only for a recorded old or new digest', () => {
  const home = setup();
  const relative = 'scripts/stripe/check_multi_customers.sh';
  const destination = path.join(home, relative);
  const oldContent = '# old complete copy\n';
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, oldContent);
  const oldDigest = digest(destination);
  fs.mkdirSync(path.dirname(receiptPath(home)), { recursive: true });
  fs.writeFileSync(receiptPath(home), JSON.stringify({
    version: 1,
    packageVersion: '0.1.0',
    managed: {},
    transitions: { [relative]: { operationId: 'op-1', oldDigest, newDigest: digest(path.join(root, relative)) } }
  }));

  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(destination, 'utf8'), fs.readFileSync(path.join(root, relative), 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(receiptPath(home), 'utf8'));
  assert.deepEqual(receipt.transitions, {});
  assert.equal(receipt.managed[relative], digest(destination));
});

test('malformed receipts and symlinked copy targets fail without following links', () => {
  const malformedHome = setup();
  fs.mkdirSync(path.dirname(receiptPath(malformedHome)), { recursive: true });
  fs.writeFileSync(receiptPath(malformedHome), '{bad json');
  const malformed = run(malformedHome);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /could not install extensions/);

  const symlinkHome = setup();
  const outside = path.join(symlinkHome, 'outside.sh');
  const target = path.join(symlinkHome, 'scripts', 'knowledge', 'knowledge-manager.sh');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(outside, 'untouched\n');
  fs.symlinkSync(outside, target);
  const symlink = run(symlinkHome);
  assert.notEqual(symlink.status, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched\n');
});
