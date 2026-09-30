'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const script = path.resolve(__dirname, '../scripts/stripe/check_multi_customers.sh');
const roots = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqd-stripe-check-test-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const stripe = path.join(bin, 'stripe');
  fs.writeFileSync(stripe, `#!/usr/bin/env bash
set -euo pipefail
CUSTOMER=""
CURSOR=""
for arg in "$@"; do
  case "$arg" in
    --customer=*) CUSTOMER="${'${arg#--customer=}'}" ;;
    --starting-after=*) CURSOR="${'${arg#--starting-after=}'}" ;;
  esac
done
printf '%s\\n' "$*" >> "$STRIPE_CALL_LOG"
if [[ -n "$CURSOR" ]]; then FILE="$STRIPE_FIXTURES/$CUSTOMER-after-$CURSOR.json"; else FILE="$STRIPE_FIXTURES/$CUSTOMER-first.json"; fi
if [[ ! -f "$FILE" ]]; then echo "fixture not found: $FILE" >&2; exit 2; fi
if [[ "$(cat "$FILE")" == FAIL ]]; then echo "provider failed" >&2; exit 1; fi
cat "$FILE"
`);
  fs.chmodSync(stripe, 0o755);
  const fixtures = path.join(root, 'fixtures');
  fs.mkdirSync(fixtures);
  return { root, bin, fixtures, log: path.join(root, 'calls.log') };
}

function fixture(environment, name, value) {
  fs.writeFileSync(path.join(environment.fixtures, `${name}.json`), typeof value === 'string' ? value : JSON.stringify(value));
}

function run(environment, customers, { missingJq = false } = {}) {
  const pathValue = missingJq ? environment.bin : `${environment.bin}:/usr/bin:/bin`;
  return spawnSync('/bin/bash', [script, ...customers], {
    encoding: 'utf8',
    env: { ...process.env, PATH: pathValue, STRIPE_FIXTURES: environment.fixtures, STRIPE_CALL_LOG: environment.log }
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('finds active subscription on a later page and stops immediately', () => {
  const environment = setup();
  fixture(environment, 'cus_later-first', { data: [{ id: 'sub_1', status: 'canceled' }], has_more: true });
  fixture(environment, 'cus_later-after-sub_1', { data: [{ id: 'sub_2', status: 'trialing' }], has_more: true });
  const result = run(environment, ['cus_later']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'cus_later | active\n');
  const calls = fs.readFileSync(environment.log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /--limit=100/);
  assert.match(calls[0], /--status=all/);
  assert.match(calls[1], /--starting-after=sub_1/);
});

test('reports inactive only after all valid pages complete', () => {
  const environment = setup();
  fixture(environment, 'cus_none-first', { data: [{ id: 'sub_a', status: 'canceled' }], has_more: true });
  fixture(environment, 'cus_none-after-sub_a', { data: [{ id: 'sub_b', status: 'past_due' }], has_more: false });
  const result = run(environment, ['cus_none']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'cus_none | inactive\n');
  assert.equal(fs.readFileSync(environment.log, 'utf8').trim().split('\n').length, 2);
});

test('provider errors, invalid pages, empty pages, and non-advancing cursors never report inactive', () => {
  const environment = setup();
  fixture(environment, 'cus_error-first', 'FAIL');
  fixture(environment, 'cus_bad-first', '{invalid');
  fixture(environment, 'cus_empty-first', { data: [], has_more: true });
  fixture(environment, 'cus_repeat-first', { data: [{ id: 'sub_same', status: 'canceled' }], has_more: true });
  fixture(environment, 'cus_repeat-after-sub_same', { data: [{ id: 'sub_same', status: 'canceled' }], has_more: true });

  for (const customer of ['cus_error', 'cus_bad', 'cus_empty', 'cus_repeat']) {
    const result = run(environment, [customer]);
    assert.notEqual(result.status, 0, `${customer} unexpectedly passed`);
    assert.doesNotMatch(result.stdout, /inactive/);
    assert.match(result.stderr, new RegExp(customer));
  }
});

test('rejects missing jq before contacting Stripe', () => {
  const environment = setup();
  const result = run(environment, ['cus_missing_jq'], { missingJq: true });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /jq is required/);
  assert.equal(fs.existsSync(environment.log), false);
});
