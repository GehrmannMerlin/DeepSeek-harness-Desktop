'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveLegacyCommand,
  resolveNodeCommand,
  resolveNpmCommand,
  resolveNpxCommand,
} = require('../src/utils/npx-resolver');
const { DshRuntimeManager } = require('../src/runtime/dsh-runtime-manager');
const { createDefaultRuntimeState } = require('../src/runtime/runtime-state-store');
const { withTempDir } = require('./test-helpers');

async function writeRuntime(rootPath, version, bin = 'lib/bin.js') {
  const packagePath = path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh');
  const cliEntry = path.join(packagePath, typeof bin === 'string' ? bin : bin.dsh || 'missing.js');
  await fs.mkdir(path.dirname(cliEntry), { recursive: true });
  await fs.writeFile(path.join(packagePath, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version,
    bin,
  }), 'utf8');
  if (bin === 'lib/bin.js' || (bin && bin.dsh)) await fs.writeFile(cliEntry, '#!/usr/bin/env node', 'utf8');
  return cliEntry;
}

function createManager({ state, runtimeRoot, bundledRoot, logger = { error() {} } }) {
  return new DshRuntimeManager({
    stateStore: { load: async () => state },
    runtimeRoot,
    bundledRoot,
    logger,
    nodeCommandResolver: async () => 'C:\\node\\node.exe',
  });
}

test('managed current wins over bundled fallback', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const managedRoot = path.join(runtimeRoot, 'versions', '1.2.3');
    const bundledRoot = path.join(directory, 'bundled-runtime');
    await writeRuntime(managedRoot, '1.2.3');
    await writeRuntime(bundledRoot, '2.0.0');
    const state = createDefaultRuntimeState();
    state.current = { relativePath: '1.2.3', kind: 'managed', version: '1.2.3' };

    const descriptor = await createManager({ state, runtimeRoot, bundledRoot }).resolveCurrentRuntime();

    assert.equal(descriptor.kind, 'managed');
    assert.equal(descriptor.version, '1.2.3');
  });
});

test('corrupt state or invalid managed tree falls back to bundled', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const bundledRoot = path.join(directory, 'bundled-runtime');
    await writeRuntime(bundledRoot, '2.0.0');
    const errors = [];
    const state = createDefaultRuntimeState();
    state.current = { relativePath: '1.2.3', kind: 'managed', version: '1.2.3' };

    const descriptor = await createManager({
      state,
      runtimeRoot,
      bundledRoot,
      logger: { error: (...args) => errors.push(args) },
    }).resolveCurrentRuntime();

    assert.equal(descriptor.kind, 'bundled');
    assert.equal(descriptor.version, '2.0.0');
    assert.equal(errors.length, 1);
  });
});

test('no bundled runtime retains legacy npx fallback', async () => {
  await withTempDir(async (directory) => {
    const descriptor = await createManager({
      state: createDefaultRuntimeState(),
      runtimeRoot: path.join(directory, 'runtime'),
      bundledRoot: path.join(directory, 'absent-bundled-runtime'),
    }).resolveCurrentRuntime();

    assert.equal(descriptor.kind, 'legacy');
    assert.equal(descriptor.version, 'unknown');
    assert.deepEqual({ command: descriptor.command, args: descriptor.args }, resolveLegacyCommand());
  });
});

test('valid string and object bin entries resolve CLI', async () => {
  await withTempDir(async (directory) => {
    const stringRoot = path.join(directory, 'string');
    const objectRoot = path.join(directory, 'object');
    const stringCli = await writeRuntime(stringRoot, '1.0.0');
    const objectCli = await writeRuntime(objectRoot, '2.0.0', { dsh: 'cli/dsh.js' });
    const manager = createManager({ state: createDefaultRuntimeState(), runtimeRoot: directory, bundledRoot: directory });

    assert.equal((await manager.validateRuntime(stringRoot, '1.0.0')).cliEntry, stringCli);
    assert.equal((await manager.validateRuntime(objectRoot, '2.0.0')).cliEntry, objectCli);
  });
});

test('bin objects without a dsh entry are rejected', async () => {
  await withTempDir(async (directory) => {
    const rootPath = path.join(directory, 'invalid-bin');
    await writeRuntime(rootPath, '1.0.0', { other: 'cli/other.js' });
    const packageRoot = path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh');
    await fs.mkdir(path.join(packageRoot, 'cli'), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'cli', 'other.js'), '#!/usr/bin/env node', 'utf8');
    const manager = createManager({ state: createDefaultRuntimeState(), runtimeRoot: directory, bundledRoot: directory });

    assert.equal(await manager.validateRuntime(rootPath, '1.0.0'), null);
  });
});

test('path traversal version is rejected', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const outsideRoot = path.join(directory, 'outside');
    await writeRuntime(outsideRoot, '1.2.3');
    const manager = createManager({ state: createDefaultRuntimeState(), runtimeRoot, bundledRoot: outsideRoot });

    assert.equal(await manager.resolveManagedRuntime('..\\outside'), null);
    assert.equal(await manager.resolveManagedRuntime(path.resolve(outsideRoot)), null);
  });
});

test('tool resolver returns Windows executable paths asynchronously', async () => {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, `C:\\tools\\${args[0]}`, '');
  };

  assert.equal(await resolveNodeCommand({ execFile }), 'C:\\tools\\node.exe');
  assert.equal(await resolveNpmCommand({ execFile }), 'C:\\tools\\npm.cmd');
  assert.equal(await resolveNpxCommand({ execFile }), 'C:\\tools\\npx.cmd');
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['where', ['node.exe']],
    ['where', ['npm.cmd']],
    ['where', ['npx.cmd']],
  ]);
});
