'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveNpmInvocation } = require('../src/update/npm-command');

test('resolves a Windows npm shim to node.exe and npm-cli.js for shell:false', async () => {
  const checked = [];
  const result = await resolveNpmInvocation('npm.cmd', {
    platform: 'win32',
    env: { Path: 'C:\\tools;C:\\other' },
    fsImpl: {
      async access(filePath) {
        checked.push(filePath);
        if (filePath === 'C:\\tools\\node.exe' || filePath === 'C:\\tools\\node_modules\\npm\\bin\\npm-cli.js') return;
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
    },
  });

  assert.deepEqual(result, {
    command: 'C:\\tools\\node.exe',
    argsPrefix: ['C:\\tools\\node_modules\\npm\\bin\\npm-cli.js'],
  });
  assert.deepEqual(checked, [
    'C:\\tools\\node.exe',
    'C:\\tools\\node_modules\\npm\\bin\\npm-cli.js',
  ]);
});

test('rejects a Windows npm shim when its Node.js runner is unavailable', async () => {
  await assert.rejects(
    () => resolveNpmInvocation('npm.cmd', {
      platform: 'win32',
      env: { Path: 'C:\\tools' },
      fsImpl: { async access() { throw new Error('missing'); } },
    }),
    /shell:false/,
  );
});
