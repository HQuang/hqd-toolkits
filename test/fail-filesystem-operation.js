'use strict';

const fs = require('node:fs');
const path = require('node:path');

const operation = process.env.HQD_TEST_FAIL_OPERATION;
const target = process.env.HQD_TEST_FAIL_TARGET && path.resolve(process.env.HQD_TEST_FAIL_TARGET);
let failed = false;

function inject(method, requestedTarget) {
  if (!failed && operation === method && path.resolve(requestedTarget) === target) {
    failed = true;
    const error = new Error(`injected filesystem failure for ${method}: ${target}`);
    error.code = 'EIO';
    throw error;
  }
}

const renameSync = fs.renameSync;
fs.renameSync = function patchedRenameSync(from, to) {
  inject('rename', to);
  return renameSync.call(this, from, to);
};

const mkdirSync = fs.mkdirSync;
fs.mkdirSync = function patchedMkdirSync(directory, options) {
  inject('mkdir', directory);
  return mkdirSync.call(this, directory, options);
};
