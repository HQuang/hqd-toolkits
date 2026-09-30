'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const managerPath = path.resolve(__dirname, '../scripts/knowledge/knowledge-manager.js');
const roots = [];

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hqd-knowledge-test-'));
  roots.push(base);
  const project = path.join(base, 'project');
  const vault = path.join(base, 'vault');
  const userHome = path.join(base, 'user-home');
  fs.mkdirSync(project);
  fs.mkdirSync(userHome);
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  for (const command of ['node', 'npx', 'codex']) {
    const file = path.join(bin, command);
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(file, 0o755);
  }
  return { base, project, vault, home: path.join(base, 'hqd'), userHome, xdg: path.join(base, 'xdg'), bin };
}

async function call(environment, action, args = []) {
  const prior = process.env.HQD_HOME;
  const priorPath = process.env.PATH;
  const priorHome = process.env.HOME;
  const priorXdg = process.env.XDG_DATA_HOME;
  process.env.HQD_HOME = environment.home;
  process.env.PATH = `${environment.bin}${path.delimiter}${priorPath}`;
  process.env.HOME = environment.userHome;
  if (environment.xdg === null) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = environment.xdg;
  delete require.cache[require.resolve(managerPath)];
  const manager = require(managerPath);
  const output = { stdout: [], stderr: [], status: 0 };
  const oldLog = console.log;
  const oldWarn = console.warn;
  const oldError = console.error;
  try {
    console.log = (...items) => output.stdout.push(items.join(' '));
    console.warn = (...items) => output.stderr.push(items.join(' '));
    console.error = (...items) => output.stderr.push(items.join(' '));
    await manager.main([action, '--project-dir', environment.project, ...args]);
  } catch (error) {
    output.status = error.exitCode || 1;
    output.stderr.push(error.message);
  } finally {
    console.log = oldLog;
    console.warn = oldWarn;
    console.error = oldError;
    if (prior === undefined) delete process.env.HQD_HOME;
    else process.env.HQD_HOME = prior;
    process.env.PATH = priorPath;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorXdg;
  }
  return { ...output, stdout: output.stdout.join('\n'), stderr: output.stderr.join('\n') };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('install, status, doctor, and default uninstall preserve external runtime data', async () => {
  const environment = setup();
  const memory = path.join(environment.base, 'data', 'memory.jsonl');
  const install = await call(environment, 'install', ['--vault', environment.vault, '--memory', memory]);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /Knowledge workflow installed/);
  assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), true);
  const knowledgeState = path.join(environment.home, 'state', 'knowledge');
  const receipt = path.join(knowledgeState, 'receipts', `${crypto.createHash('sha256').update(environment.project).digest('hex')}.json`);
  assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
  for (const directory of [knowledgeState, ...['receipts', 'locks', 'transactions'].map(item => path.join(knowledgeState, item))]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700, `${directory} must be private`);
  }

  const status = await call(environment, 'status');
  assert.equal(status.status, 0, status.stderr);
  const diagnosis = await call(environment, 'doctor');
  assert.equal(diagnosis.status, 0, diagnosis.stderr);
  const uninstall = await call(environment, 'uninstall');
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(memory), true);
  assert.equal(fs.existsSync(path.join(environment.vault, 'Projects', 'project', 'Knowledge')), true);
});

test('default storage follows absolute XDG_DATA_HOME and receipt paths survive environment changes', async () => {
  const environment = setup();
  const memory = path.join(environment.xdg, 'hqd-toolkits', 'agent-memory', 'project', 'memory.jsonl');
  const vault = path.join(environment.xdg, 'hqd-toolkits', 'agent-knowledge');
  const install = await call(environment, 'install');
  assert.equal(install.status, 0, install.stderr);
  const config = fs.readFileSync(path.join(environment.project, '.codex/config.toml'), 'utf8');
  assert.match(config, new RegExp(memory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(config, new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(fs.readFileSync(path.join(environment.project, 'AGENTS.md'), 'utf8').includes(path.join(vault, 'Projects/project/Knowledge')));
  assert.ok(fs.readFileSync(path.join(environment.project, '.agents/skills/knowledge-sync/SKILL.md'), 'utf8').includes(path.join(vault, 'Projects/project/Knowledge')));
  assert.equal(fs.existsSync(memory), true);
  assert.equal(fs.existsSync(path.join(vault, 'Projects', 'project', 'Knowledge')), true);

  environment.xdg = path.join(environment.base, 'changed-xdg');
  const status = await call(environment, 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(memory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const diagnosis = await call(environment, 'doctor');
  assert.equal(diagnosis.status, 0, diagnosis.stderr);
  assert.match(diagnosis.stdout, new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const repeated = await call(environment, 'install');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already installed/);
  assert.ok(repeated.stdout.includes(memory));
  assert.equal(fs.existsSync(path.join(environment.xdg, 'hqd-toolkits/agent-memory/project/memory.jsonl')), false);
  const conflicting = await call(environment, 'install', ['--memory', path.join(environment.base, 'other.jsonl')]);
  assert.notEqual(conflicting.status, 0);
  assert.match(conflicting.stderr, /data is never relocated automatically/);
  assert.equal(fs.existsSync(path.join(environment.base, 'other.jsonl')), false);
});

test('relative XDG_DATA_HOME falls back beneath the temporary user home', async () => {
  const environment = setup();
  environment.xdg = 'relative-data-home';
  const install = await call(environment, 'install');
  assert.equal(install.status, 0, install.stderr);
  assert.equal(fs.existsSync(path.join(environment.userHome, '.local/share/hqd-toolkits/agent-memory/project/memory.jsonl')), true);
  assert.equal(fs.existsSync(path.join(environment.userHome, '.local/share/hqd-toolkits/agent-knowledge/Projects/project/Knowledge')), true);
});

test('unset XDG_DATA_HOME falls back beneath the temporary user home', async () => {
  const environment = setup();
  environment.xdg = null;
  const install = await call(environment, 'install');
  assert.equal(install.status, 0, install.stderr);
  assert.equal(fs.existsSync(path.join(environment.userHome, '.local/share/hqd-toolkits/agent-memory/project/memory.jsonl')), true);
  assert.equal(fs.existsSync(path.join(environment.userHome, '.local/share/hqd-toolkits/agent-knowledge/Projects/project/Knowledge')), true);
});

test('project-contained storage overrides fail before project files or state are created', async () => {
  const environment = setup();
  const rejected = await call(environment, 'install', ['--memory', path.join(environment.project, 'memory.jsonl')]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /must remain outside the project checkout/);
  for (const file of ['AGENTS.md', '.codex/config.toml', '.hqd-knowledge']) {
    assert.equal(fs.existsSync(path.join(environment.project, file)), false, `${file} was written despite invalid path input`);
  }
});

test('a moved project checkout keeps using its receipt paths for status, doctor, and uninstall', async () => {
  const environment = setup();
  assert.equal((await call(environment, 'install')).status, 0);
  const oldRoot = environment.project;
  const oldMemory = path.join(environment.xdg, 'hqd-toolkits/agent-memory/project/memory.jsonl');
  const oldVault = path.join(environment.xdg, 'hqd-toolkits/agent-knowledge');
  const movedRoot = path.join(environment.base, 'moved-project');
  fs.renameSync(oldRoot, movedRoot);
  environment.project = movedRoot;
  environment.xdg = path.join(environment.base, 'new-xdg');

  const status = await call(environment, 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(oldVault));
  assert.ok(status.stdout.includes(oldMemory));
  const diagnosis = await call(environment, 'doctor');
  assert.equal(diagnosis.status, 0, diagnosis.stderr);
  const uninstall = await call(environment, 'uninstall');
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(fs.existsSync(path.join(movedRoot, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(oldMemory), true);
});

test('a moved checkout recovers an interrupted transaction at the recorded external paths', async () => {
  const environment = setup();
  const oldRoot = environment.project;
  const installationId = crypto.randomUUID();
  const memory = path.join(environment.xdg, 'hqd-toolkits/agent-memory/project/memory.jsonl');
  const vault = path.join(environment.xdg, 'hqd-toolkits/agent-knowledge');
  const stateDirectory = path.join(oldRoot, '.hqd-knowledge');
  fs.mkdirSync(stateDirectory);
  const metadata = { schemaVersion: 2, toolId: 'hqd-knowledge', projectRoot: oldRoot, installationId, projectSlug: 'project', vault, memory };
  const metadataFile = path.join(stateDirectory, 'install.json');
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  fs.writeFileSync(metadataFile, metadataText);
  const partial = 'partial managed content\n';
  const agentsFile = path.join(oldRoot, 'AGENTS.md');
  fs.writeFileSync(agentsFile, partial);
  const transactions = path.join(environment.home, 'state/knowledge/transactions');
  fs.mkdirSync(transactions, { recursive: true, mode: 0o700 });
  for (const directory of [path.join(environment.home, 'state'), path.join(environment.home, 'state/knowledge'), transactions]) fs.chmodSync(directory, 0o700);
  const rootHash = crypto.createHash('sha256').update(oldRoot).digest('hex');
  const journal = {
    schemaVersion: 1, projectRoot: oldRoot, installationId, vault, memory, slug: 'project',
    operations: [
      { id: `directory:${crypto.createHash('sha256').update(stateDirectory).digest('hex')}`, kind: 'directory', target: stateDirectory },
      { id: 'file:metadata', kind: 'file', target: metadataFile, before: null, beforeMode: null, after: crypto.createHash('sha256').update(metadataText).digest('hex') },
      { id: 'file:agents', kind: 'file', target: agentsFile, before: null, beforeMode: null, after: crypto.createHash('sha256').update(partial).digest('hex') }
    ]
  };
  fs.writeFileSync(path.join(transactions, `${rootHash}.json`), JSON.stringify(journal), { mode: 0o600 });
  const movedRoot = path.join(environment.base, 'moved-project');
  fs.renameSync(oldRoot, movedRoot);
  environment.project = movedRoot;
  environment.xdg = path.join(environment.base, 'new-xdg');

  const retried = await call(environment, 'install');
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stdout, /Recovered the previous install transaction/);
  assert.match(retried.stdout, new RegExp(memory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(memory), true);
  assert.equal(fs.existsSync(path.join(vault, 'Projects/project/Knowledge')), true);
  assert.doesNotMatch(fs.readFileSync(path.join(movedRoot, 'AGENTS.md'), 'utf8'), /partial managed content/);
});

test('Memory and vault overrides are independent and recorded as canonical paths', async () => {
  const customVault = setup();
  const customVaultPath = path.join(customVault.base, 'chosen-vault');
  const defaultMemory = path.join(customVault.xdg, 'hqd-toolkits/agent-memory/project/memory.jsonl');
  const first = await call(customVault, 'install', ['--vault', customVaultPath]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(fs.readFileSync(path.join(customVault.project, '.codex/config.toml'), 'utf8'), new RegExp(defaultMemory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(path.join(customVaultPath, 'Projects/project/Knowledge')), true);

  const customMemory = setup();
  const customMemoryPath = path.join(customMemory.base, 'custom-memory.jsonl');
  const second = await call(customMemory, 'install', ['--memory', customMemoryPath]);
  assert.equal(second.status, 0, second.stderr);
  const defaultVault = path.join(customMemory.xdg, 'hqd-toolkits/agent-knowledge');
  const secondConfig = fs.readFileSync(path.join(customMemory.project, '.codex/config.toml'), 'utf8');
  assert.match(secondConfig, new RegExp(customMemoryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(secondConfig, new RegExp(defaultVault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('two distinct projects with the same slug cannot claim the same default storage', async () => {
  const first = setup();
  first.project = path.join(first.base, 'first', 'same-name');
  fs.mkdirSync(first.project, { recursive: true });
  assert.equal((await call(first, 'install')).status, 0);
  const second = setup();
  second.project = path.join(second.base, 'second', 'same-name');
  fs.mkdirSync(second.project, { recursive: true });
  second.home = first.home;
  second.xdg = first.xdg;
  const rejected = await call(second, 'install');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Storage path collision/);
  assert.equal(fs.existsSync(path.join(second.project, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(second.project, '.hqd-knowledge')), false);
});

test('purge requires matching selectors and removes only unchanged installer-created data', async () => {
  const environment = setup();
  const memory = path.join(environment.base, 'memory.jsonl');
  assert.equal((await call(environment, 'install', ['--vault', environment.vault, '--memory', memory])).status, 0);
  const missingSelectors = await call(environment, 'uninstall', ['--purge-empty-data']);
  assert.notEqual(missingSelectors.status, 0);
  assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), true);

  const purge = await call(environment, 'uninstall', ['--purge-empty-data', '--memory', memory, '--vault', environment.vault]);
  assert.equal(purge.status, 0, purge.stderr);
  assert.equal(fs.existsSync(memory), false);
  assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), false);
});

test('purge after XDG changes preserves edited Memory, project notes, and sibling-project data', async () => {
  const environment = setup();
  const memory = path.join(environment.xdg, 'hqd-toolkits/agent-memory/project/memory.jsonl');
  const vault = path.join(environment.xdg, 'hqd-toolkits/agent-knowledge');
  assert.equal((await call(environment, 'install')).status, 0);
  const projectNote = path.join(vault, 'Projects/project/Knowledge/notes.md');
  const siblingNote = path.join(vault, 'Projects/sibling/Knowledge/notes.md');
  fs.writeFileSync(projectNote, 'project knowledge\n');
  fs.mkdirSync(path.dirname(siblingNote), { recursive: true });
  fs.writeFileSync(siblingNote, 'sibling knowledge\n');
  fs.writeFileSync(memory, '{"user":"kept"}\n');
  environment.xdg = path.join(environment.base, 'changed-xdg');

  const purge = await call(environment, 'uninstall', ['--purge-empty-data', '--memory', memory, '--vault', vault]);
  assert.equal(purge.status, 0, purge.stderr);
  assert.equal(fs.readFileSync(projectNote, 'utf8'), 'project knowledge\n');
  assert.equal(fs.readFileSync(siblingNote, 'utf8'), 'sibling knowledge\n');
  assert.equal(fs.readFileSync(memory, 'utf8'), '{"user":"kept"}\n');
});

test('a forged manifest is rejected before its outside target can be removed', async () => {
  const environment = setup();
  const memory = path.join(environment.base, 'memory.jsonl');
  assert.equal((await call(environment, 'install', ['--vault', environment.vault, '--memory', memory])).status, 0);
  const outside = path.join(environment.base, 'outside.txt');
  fs.writeFileSync(outside, 'keep me');
  const manifest = path.join(environment.project, '.hqd-knowledge/manifest.json');
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  data.entries[0].target = outside;
  fs.writeFileSync(manifest, JSON.stringify(data));

  for (const action of ['status', 'doctor']) {
    const inspection = await call(environment, action);
    assert.notEqual(inspection.status, 0, `${action} accepted a forged manifest`);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me');
    assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), true);
  }
  const result = await call(environment, 'uninstall');
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me');
  assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), true);
});

test('a corrupted private receipt is rejected before uninstall mutates the project', async () => {
  const environment = setup();
  assert.equal((await call(environment, 'install')).status, 0);
  const receiptPath = path.join(environment.home, 'state/knowledge/receipts', `${crypto.createHash('sha256').update(environment.project).digest('hex')}.json`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  receipt.memory = path.join(environment.base, 'outside.jsonl');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const result = await call(environment, 'uninstall');
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), true);
  assert.equal(fs.existsSync(path.join(environment.base, 'outside.jsonl')), false);
});

test('uninstall preserves edited, duplicate, reversed, and nested managed blocks', async () => {
  const cases = [
    ['edited', text => text.replace('MCP Memory is the concise knowledge index', 'edited user content')],
    ['duplicate', text => text.replace('# >>> HQD-KNOWLEDGE:AGENTS >>>', '# >>> HQD-KNOWLEDGE:AGENTS >>>\n# >>> HQD-KNOWLEDGE:AGENTS >>>')],
    ['reversed', text => text.replace('# >>> HQD-KNOWLEDGE:AGENTS >>>', '\u0000').replace('# <<< HQD-KNOWLEDGE:AGENTS <<<', '# >>> HQD-KNOWLEDGE:AGENTS >>>').replace('\u0000', '# <<< HQD-KNOWLEDGE:AGENTS <<<')],
    ['nested', text => text.replace('# <<< HQD-KNOWLEDGE:AGENTS <<<', '# >>> HQD-KNOWLEDGE:AGENTS >>>\n# <<< HQD-KNOWLEDGE:AGENTS <<<')]
  ];

  for (const [label, edit] of cases) {
    const environment = setup();
    const memory = path.join(environment.base, 'memory.jsonl');
    assert.equal((await call(environment, 'install', ['--vault', environment.vault, '--memory', memory])).status, 0);
    const agents = path.join(environment.project, 'AGENTS.md');
    fs.writeFileSync(agents, edit(fs.readFileSync(agents, 'utf8')));
    const preserved = fs.readFileSync(agents, 'utf8');
    const result = await call(environment, 'uninstall');

    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /Preserved edited or ambiguous managed block/);
    assert.equal(fs.readFileSync(agents, 'utf8'), preserved);
  }
});

test('symlink targets are rejected before project files are written', async () => {
  const environment = setup();
  const outside = path.join(environment.base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(environment.project, '.codex'));
  const result = await call(environment, 'install', ['--vault', environment.vault]);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(outside, 'config.toml')), false);

  const dangling = setup();
  fs.symlinkSync(path.join(dangling.base, 'missing-target'), path.join(dangling.project, 'AGENTS.md'));
  const danglingResult = await call(dangling, 'install', ['--vault', dangling.vault]);
  assert.notEqual(danglingResult.status, 0);
  assert.equal(fs.lstatSync(path.join(dangling.project, 'AGENTS.md')).isSymbolicLink(), true);
});

test('legacy metadata decoding rejects shell syntax without evaluating it', () => {
  const manager = require(managerPath);
  assert.equal(manager.decodeLegacyValue("/tmp/a\\ b\\'quote"), "/tmp/a b'quote");
  assert.throws(() => manager.decodeLegacyValue('$(touch /tmp/not-executed)'), /Unsupported legacy metadata encoding/);
});

test('a held per-project mutation lock blocks installation without changing the project', async () => {
  const environment = setup();
  const rootHash = crypto.createHash('sha256').update(environment.project).digest('hex');
  const state = path.join(environment.home, 'state', 'knowledge');
  const lock = path.join(state, 'locks', `${rootHash}.lock`);
  fs.mkdirSync(lock, { recursive: true });
  fs.chmodSync(state, 0o700);
  fs.chmodSync(path.dirname(lock), 0o700);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 4242, host: 'test', projectRoot: environment.project }));

  const result = await call(environment, 'install', ['--vault', environment.vault]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mutation lock is held/);
  assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(environment.project, '.hqd-knowledge')), false);
});

test('installation rejects permissive per-user receipt roots before project writes', async () => {
  const environment = setup();
  const state = path.join(environment.home, 'state', 'knowledge');
  fs.mkdirSync(path.join(state, 'receipts'), { recursive: true, mode: 0o755 });
  fs.chmodSync(state, 0o755);
  const result = await call(environment, 'install', ['--vault', environment.vault]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be mode 0700/);
  assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(environment.project, '.hqd-knowledge')), false);
});

test('schema-v1 status reads bounded printf-escaped metadata and uninstall fails closed without a receipt', async () => {
  const environment = setup();
  const state = path.join(environment.project, '.hqd-knowledge');
  fs.mkdirSync(state);
  const metadataFile = path.join(state, ['install', 'env'].join('.'));
  const fields = [
    'TOOL_ID=hqd-knowledge', 'SCHEMA_VERSION=1', `PROJECT_DIR=${environment.project}`,
    'PROJECT_SLUG=project', `VAULT=${environment.vault.replaceAll(' ', '\\ ')}`,
    `MEMORY=${path.join(environment.base, 'memory.jsonl')}`
  ];
  fs.writeFileSync(metadataFile, `${fields.join('\n')}\n`);
  fs.writeFileSync(path.join(state, 'manifest.tsv'), `STATE_DIR\t${state}\t\t\t\n`);
  const userFile = path.join(environment.project, 'AGENTS.md');
  fs.writeFileSync(userFile, 'preserve legacy project content\n');

  const status = await call(environment, 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /legacy schema-v1/);
  const uninstall = await call(environment, 'uninstall');
  assert.notEqual(uninstall.status, 0);
  assert.match(uninstall.stderr, /no trusted ownership receipt/);
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'preserve legacy project content\n');

  fs.writeFileSync(metadataFile, `${fields.slice(0, 3).join('\n')}\nPROJECT_SLUG=$(touch ${path.join(environment.base, 'unexpected')})\n`);
  const forged = await call(environment, 'status');
  assert.notEqual(forged.status, 0);
  assert.equal(fs.existsSync(path.join(environment.base, 'unexpected')), false);
});

test('interrupted install rolls back recorded changes and preserves concurrent edits for recovery', async () => {
  function recordInterrupted(environment, content) {
    const rootHash = crypto.createHash('sha256').update(environment.project).digest('hex');
    const state = path.join(environment.home, 'state', 'knowledge');
    const directory = path.join(state, 'transactions');
    fs.mkdirSync(directory, { recursive: true });
    fs.chmodSync(state, 0o700);
    fs.chmodSync(directory, 0o700);
    const journal = {
      schemaVersion: 1,
      projectRoot: environment.project,
      vault: environment.vault,
      memory: path.join(environment.base, 'memory.jsonl'),
      slug: 'project',
      operations: [{ id: 'file:agents', kind: 'file', target: path.join(environment.project, 'AGENTS.md'), before: null, beforeMode: null, after: crypto.createHash('sha256').update(content).digest('hex') }]
    };
    fs.writeFileSync(path.join(directory, `${rootHash}.json`), JSON.stringify(journal));
  }

  const recoverable = setup();
  const partial = 'partial installer content\n';
  fs.writeFileSync(path.join(recoverable.project, 'AGENTS.md'), partial);
  recordInterrupted(recoverable, partial);
  const retried = await call(recoverable, 'install', ['--vault', recoverable.vault, '--memory', path.join(recoverable.base, 'memory.jsonl')]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stdout, /Recovered the previous install transaction/);
  assert.doesNotMatch(fs.readFileSync(path.join(recoverable.project, 'AGENTS.md'), 'utf8'), /partial installer content/);

  const conflicting = setup();
  const userEdit = 'concurrent user edit\n';
  fs.writeFileSync(path.join(conflicting.project, 'AGENTS.md'), userEdit);
  recordInterrupted(conflicting, partial);
  const blocked = await call(conflicting, 'install', ['--vault', conflicting.vault, '--memory', path.join(conflicting.base, 'memory.jsonl')]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /recovery_required/);
  assert.equal(fs.readFileSync(path.join(conflicting.project, 'AGENTS.md'), 'utf8'), userEdit);
});

test('an out-of-scope journal target is rejected without changing it or removing the journal', async () => {
  const environment = setup();
  const outside = path.join(environment.base, 'outside.txt');
  fs.writeFileSync(outside, 'keep me');
  const rootHash = crypto.createHash('sha256').update(environment.project).digest('hex');
  const transactions = path.join(environment.home, 'state/knowledge/transactions');
  fs.mkdirSync(transactions, { recursive: true, mode: 0o700 });
  for (const directory of [path.join(environment.home, 'state'), path.join(environment.home, 'state/knowledge'), transactions]) fs.chmodSync(directory, 0o700);
  const journalFile = path.join(transactions, `${rootHash}.json`);
  fs.writeFileSync(journalFile, JSON.stringify({
    schemaVersion: 1, projectRoot: environment.project, vault: environment.vault,
    memory: path.join(environment.base, 'memory.jsonl'), slug: 'project',
    operations: [{ id: 'file:agents', kind: 'file', target: outside, before: null, beforeMode: null, after: crypto.createHash('sha256').update('bad').digest('hex') }]
  }), { mode: 0o600 });

  const result = await call(environment, 'install', ['--vault', environment.vault, '--memory', path.join(environment.base, 'memory.jsonl')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /out-of-scope recovery operation/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me');
  assert.equal(fs.existsSync(journalFile), true);
  assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), false);
});

test('filesystem failures after install mutation categories fully roll back and allow retry', async () => {
  const scenarios = [
    { operation: 'rename', target: project => path.join(project, '.agents/skills/knowledge-sync/SKILL.md'), label: 'managed block edits' },
    { operation: 'rename', target: project => path.join(project, '.agents/skills/knowledge-sync/references/schema.md'), label: 'generated-file writes' },
    { operation: 'rename', target: (_project, memory) => memory, label: 'memory-file creation' },
    ...[
      ['Projects'],
      ['Projects', project => path.basename(project)],
      ['Projects', project => path.basename(project), 'Knowledge']
    ].map(parts => ({
      operation: 'mkdir',
      target: (project, _memory, vault) => path.join(vault, ...parts.map(part => typeof part === 'function' ? part(project) : part)),
      label: `vault directory ${typeof parts.at(-1) === 'function' ? 'project slug' : parts.at(-1)}`
    }))
  ];

  for (const scenario of scenarios) {
    const environment = setup();
    fs.mkdirSync(environment.vault);
    const memoryParent = path.join(environment.base, 'data');
    const memory = path.join(memoryParent, 'memory.jsonl');
    const target = scenario.target(environment.project, memory, environment.vault);
    const args = ['install', '--project-dir', environment.project, '--vault', environment.vault, '--memory', memory];
    const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'fail-filesystem-operation.js'), managerPath, ...args], {
      cwd: environment.project,
      encoding: 'utf8',
      env: { ...process.env, HOME: environment.userHome, XDG_DATA_HOME: environment.xdg, HQD_HOME: environment.home, HQD_TEST_FAIL_OPERATION: scenario.operation, HQD_TEST_FAIL_TARGET: target }
    });

    assert.equal(result.status, 1, `${scenario.label} failure status: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /injected filesystem failure/, `${scenario.label}: ${JSON.stringify(result)}`);
    assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), false, `${scenario.label} left the managed block behind`);
    assert.equal(fs.existsSync(path.join(environment.project, '.agents')), false, `${scenario.label} left generated files behind`);
    assert.equal(fs.existsSync(memory), false, `${scenario.label} left memory behind`);
    assert.equal(fs.existsSync(path.join(environment.vault, 'Projects')), false, `${scenario.label} left vault directories behind`);
    const rootHash = crypto.createHash('sha256').update(environment.project).digest('hex');
    assert.equal(fs.existsSync(path.join(environment.home, 'state', 'knowledge', 'transactions', `${rootHash}.json`)), false, `${scenario.label} left a recovery journal behind`);
    assert.equal(fs.existsSync(path.join(environment.home, 'state', 'knowledge', 'locks', `${rootHash}.lock`)), false, `${scenario.label} left a mutation lock behind`);

    const retry = spawnSync(process.execPath, [managerPath, ...args], {
      cwd: environment.project,
      encoding: 'utf8',
      env: { ...process.env, HOME: environment.userHome, XDG_DATA_HOME: environment.xdg, HQD_HOME: environment.home, PATH: `${environment.bin}${path.delimiter}${process.env.PATH}` }
    });
    assert.equal(retry.status, 0, `${scenario.label} retry failed: ${retry.stdout}\n${retry.stderr}`);
    assert.equal(fs.existsSync(path.join(environment.project, '.hqd-knowledge/install.json')), true);
  }
});

test('SIGINT and SIGTERM during managed-file writes roll back and release the mutation lock', async () => {
  const cases = [
    { signal: 'SIGTERM', exitCode: 143, watch: 'project', filename: 'AGENTS.md' },
    { signal: 'SIGINT', exitCode: 130, watch: 'project', filename: '.agents' },
    { signal: 'SIGTERM', exitCode: 143, watch: 'memory', filename: 'memory.jsonl' },
    { signal: 'SIGINT', exitCode: 130, watch: 'vault', filename: 'Projects' },
    { signal: 'SIGTERM', exitCode: 143, watch: 'project', filename: '.hqd-knowledge' }
  ];
  for (const scenario of cases) {
    const environment = setup();
    const initial = 'user-owned preexisting AGENTS content\n';
    if (scenario.filename === 'AGENTS.md') fs.writeFileSync(path.join(environment.project, 'AGENTS.md'), initial);
    fs.mkdirSync(environment.vault);
    const memoryParent = path.join(environment.base, 'data');
    fs.mkdirSync(memoryParent);
    const directories = { project: environment.project, memory: memoryParent, vault: environment.vault };
    const rootHash = crypto.createHash('sha256').update(environment.project).digest('hex');
    const lock = path.join(environment.home, 'state', 'knowledge', 'locks', `${rootHash}.lock`);
    const journal = path.join(environment.home, 'state', 'knowledge', 'transactions', `${rootHash}.json`);
    const memory = path.join(memoryParent, 'memory.jsonl');
    const watchers = Object.values(directories).map(directory => fs.watch(directory, (_event, name) => {
      if (!signaled && directory === directories[scenario.watch] && name === scenario.filename) { signaled = true; child.kill(scenario.signal); }
    }));
    let signaled = false;
    const child = spawn(process.execPath, [managerPath, 'install', '--project-dir', environment.project, '--vault', environment.vault, '--memory', memory], {
      cwd: environment.project,
      env: { ...process.env, HOME: environment.userHome, XDG_DATA_HOME: environment.xdg, HQD_HOME: environment.home }
    });
    const timeout = setTimeout(() => child.kill(scenario.signal), 10000);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, receivedSignal) => resolve({ code, signal: receivedSignal }));
    });
    clearTimeout(timeout);
    for (const watcher of watchers) watcher.close();
    assert.equal(result.code, scenario.exitCode, `${scenario.signal} at ${scenario.filename} result was ${JSON.stringify(result)}`);
    if (scenario.filename === 'AGENTS.md') assert.equal(fs.readFileSync(path.join(environment.project, 'AGENTS.md'), 'utf8'), initial);
    else assert.equal(fs.existsSync(path.join(environment.project, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(journal), false);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.existsSync(path.join(environment.project, '.hqd-knowledge')), false);
    assert.equal(fs.existsSync(memory), false);
    assert.equal(fs.existsSync(path.join(environment.vault, 'Projects')), false);
  }
});
