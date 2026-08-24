'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { verifyRuntime } = require('../src/update/runtime-verifier');
const { createPackageTree, withTempDir, writeJson } = require('./test-helpers');

test('verifier accepts exact package and CLI version', async () => {
  await withTempDir(async (rootPath) => {
    const { cliPath } = await createPackageTree(rootPath, { version: '1.2.3' });
    const result = await verifyRuntime({
      rootPath,
      expectedVersion: '1.2.3',
      nodeCommand: 'node',
      runCommand: async (command, args, options) => {
        assert.equal(command, 'node');
        assert.deepEqual(args, [cliPath, '--version']);
        assert.equal(options.timeoutMs, 10000);
        return { code: 0, stdout: 'dsh 1.2.3\n', stderr: '' };
      },
    });
    assert.deepEqual(result, { ok: true, packagePath: path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), cliEntry: cliPath, reportedVersion: '1.2.3', reason: null, code: 0, timedOut: false });
  });
});

test('verifier rejects package name/version/bin mismatch', async () => {
  await withTempDir(async (rootPath) => {
    const { packageJsonPath } = await createPackageTree(rootPath, { version: '1.2.3' });
    await writeJson(packageJsonPath, { name: '@other/package', version: '1.2.3', bin: { dsh: 'bin/dsh.js' } });
    let result = await verifyRuntime({ rootPath, expectedVersion: '1.2.3', nodeCommand: 'node', runCommand: async () => ({ code: 0, stdout: '1.2.3' }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'package-name-mismatch');

    await writeJson(packageJsonPath, { name: '@deepseek-ai/dsh', version: '1.2.4', bin: { dsh: 'bin/dsh.js' } });
    result = await verifyRuntime({ rootPath, expectedVersion: '1.2.3', nodeCommand: 'node', runCommand: async () => ({ code: 0, stdout: '1.2.3' }) });
    assert.equal(result.reason, 'package-version-mismatch');

    await writeJson(packageJsonPath, { name: '@deepseek-ai/dsh', version: '1.2.3', bin: { dsh: 'one.js', other: 'two.js' } });
    result = await verifyRuntime({ rootPath, expectedVersion: '1.2.3', nodeCommand: 'node', runCommand: async () => ({ code: 0, stdout: '1.2.3' }) });
    assert.equal(result.reason, 'invalid-bin');
  });
});

test('verifier rejects CLI nonzero, mismatch, and timeout', async () => {
  await withTempDir(async (rootPath) => {
    await createPackageTree(rootPath, { version: '1.2.3' });
    for (const [response, reason] of [
      [{ code: 1, stdout: '1.2.3', stderr: 'failure' }, 'cli-nonzero-exit'],
      [{ code: 0, stdout: '1.2.4', stderr: '' }, 'cli-version-mismatch'],
      [{ code: 0, stdout: '1.2.3-dev', stderr: '' }, 'cli-version-mismatch'],
      [{ code: null, stdout: '', stderr: '', timedOut: true }, 'cli-timeout'],
    ]) {
      const result = await verifyRuntime({ rootPath, expectedVersion: '1.2.3', nodeCommand: 'node', runCommand: async () => response });
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
    }
  });
});
