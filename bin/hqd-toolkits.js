#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const pkg = require('../package.json');

const packageRoot = path.resolve(__dirname, '..');
const bashCli = path.join(packageRoot, 'hqd-toolkits');

if (!fs.existsSync(bashCli)) {
  console.error(`hqd-toolkits: missing bundled executable: ${bashCli}`);
  process.exit(1);
}

const result = spawnSync('bash', [bashCli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HQD_PACKAGE_HOME: packageRoot,
    HQD_PACKAGE_VERSION: pkg.version
  }
});

if (result.error) {
  if (result.error.code === 'ENOENT') {
    console.error('hqd-toolkits requires bash. Supported platforms: Linux and macOS.');
  } else {
    console.error(`hqd-toolkits: ${result.error.message}`);
  }
  process.exit(1);
}

process.exit(result.status ?? 1);
