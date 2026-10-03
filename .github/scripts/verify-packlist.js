'use strict';

const fs = require('node:fs');

// Keep this list intentionally explicit. Adding a distributable file requires a
// reviewed change here as well as a change to package.json's files allowlist.
const EXPECTED_FILES = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'bin/hqd-toolkits.js',
  'hqd-toolkits',
  'commands/knowledge.sh',
  'commands/stripe.sh',
  'scripts/install-extensions.js',
  'scripts/knowledge/knowledge-manager.js',
  'scripts/knowledge/knowledge-manager.sh',
  'scripts/stripe/check_multi_customers.sh',
  'scripts/stripe/example.sh',
]);

function fail(message) {
  throw new Error(`packlist verification failed: ${message}`);
}

function readInput() {
  const inputPath = process.argv[2];
  if (process.argv.length > 3 || inputPath === '--help' || inputPath === '-h') {
    if (inputPath === '--help' || inputPath === '-h') {
      process.stdout.write('Usage: npm pack --dry-run --ignore-scripts --json | node .github/scripts/verify-packlist.js [json-file]\n');
      process.exit(0);
    }
    fail('expected at most one JSON file argument');
  }

  try {
    return inputPath
      ? fs.readFileSync(inputPath, 'utf8')
      : fs.readFileSync(0, 'utf8');
  } catch (error) {
    fail(`could not read npm output: ${error.message}`);
  }
}

function parsePacklist(raw) {
  if (!raw.trim()) fail('npm output is empty');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`npm output is not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
    fail('expected npm pack --json output to be an array containing one pack record');
  }

  const record = parsed[0];
  if (!Array.isArray(record.files)) fail('pack record is missing its files array');
  return record.files;
}

function validateEntry(entry, seen) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('each files entry must be an object');
  if (typeof entry.path !== 'string' || entry.path.length === 0) fail('each files entry must have a non-empty path');

  const filePath = entry.path;
  if (filePath.includes('\\') || filePath.startsWith('/') || filePath.startsWith('../') || filePath.includes('/../') || filePath === '..' || filePath.includes('\0')) {
    fail(`unsafe path: ${JSON.stringify(filePath)}`);
  }
  const normalized = filePath.split('/').filter(Boolean).join('/');
  if (normalized !== filePath || filePath.split('/').includes('.')) fail(`non-canonical path: ${JSON.stringify(filePath)}`);
  if (seen.has(filePath)) fail(`duplicate path: ${JSON.stringify(filePath)}`);
  seen.add(filePath);

  if (Object.prototype.hasOwnProperty.call(entry, 'type') && !['file', 'regular'].includes(entry.type)) {
    fail(`non-regular entry ${JSON.stringify(filePath)} has type ${JSON.stringify(entry.type)}`);
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'size') && (!Number.isInteger(entry.size) || entry.size < 0)) {
    fail(`invalid size for ${JSON.stringify(filePath)}`);
  }
  if (!EXPECTED_FILES.has(filePath)) fail(`unexpected file: ${JSON.stringify(filePath)}`);
}

function main() {
  const files = parsePacklist(readInput());
  const seen = new Set();
  for (const entry of files) validateEntry(entry, seen);

  const missing = [...EXPECTED_FILES].filter((filePath) => !seen.has(filePath));
  if (missing.length > 0) fail(`missing required files: ${missing.join(', ')}`);

  process.stdout.write(`packlist verified: ${seen.size} files\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

