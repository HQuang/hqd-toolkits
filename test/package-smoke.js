'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'hqd-toolkits.js');
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hqd-toolkits-test-'));

function run(args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tempHome, XDG_DATA_HOME: path.join(tempHome, 'xdg'), HQD_HOME: path.join(tempHome, '.hqd') }
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`command failed: hqd-toolkits ${args.join(' ')}${result.error ? ` (${result.error.message})` : ''}`);
  }
  return `${result.stdout}${result.stderr}`;
}

const version = run(['--version']);
if (!version.includes('hqd-toolkits 0.1.0')) throw new Error('version output mismatch');

const help = run(['--help']);
if (!help.includes('knowledge')) throw new Error('knowledge command missing from help');
if (!help.includes('stripe')) throw new Error('stripe command missing from help');

const knowledgeHelp = run(['knowledge', '--help']);
if (!knowledgeHelp.includes('install') || !knowledgeHelp.includes('uninstall')) {
  throw new Error(`knowledge help missing install/uninstall: ${knowledgeHelp}`);
}
for (const phrase of ['agent-memory', 'agent-knowledge', 'XDG_DATA_HOME', 'No data is moved']) {
  if (!knowledgeHelp.includes(phrase)) throw new Error(`knowledge help missing ${phrase}: ${knowledgeHelp}`);
}
for (const option of ['--project-dir', '--project-slug', '--vault', '--memory', '--purge-empty-data']) {
  if (!knowledgeHelp.includes(option)) throw new Error(`knowledge help missing ${option}: ${knowledgeHelp}`);
}

if (fs.existsSync(path.join(tempHome, '.hqd'))) {
  throw new Error('package smoke test unexpectedly mutated ~/.hqd');
}

console.log('package smoke tests passed');
