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
const { RuntimeStateStore, createDefaultRuntimeState } = require('../src/runtime/runtime-state-store');
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
    stateStore: state ? { load: async () => state } : new RuntimeStateStore({ filePath: path.join(runtimeRoot, 'runtime-state.json'), logger }),
    runtimeRoot,
    bundledRoot,
    logger,
    nodeCommandResolver: async () => 'C:\\node\\node.exe',
  });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function runtimeReference(version, relativePath = version) {
  return { relativePath, kind: 'managed', version };
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

test('managed state with a corrupt relativePath falls back to bundled even when its version exists', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const bundledRoot = path.join(directory, 'bundled-runtime');
    await writeRuntime(path.join(runtimeRoot, 'versions', '1.2.3'), '1.2.3');
    await writeRuntime(bundledRoot, '2.0.0');
    const errors = [];
    const state = createDefaultRuntimeState();
    state.current = { relativePath: '..\\outside', kind: 'managed', version: '1.2.3' };

    const descriptor = await createManager({
      state,
      runtimeRoot,
      bundledRoot,
      logger: { error: (...args) => errors.push(args) },
    }).resolveCurrentRuntime();

    assert.equal(descriptor.kind, 'bundled');
    assert.equal(descriptor.version, '2.0.0');
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /managed runtime state/i);
  });
});

test('null bundled manifest logs and falls through to legacy', async () => {
  await withTempDir(async (directory) => {
    const bundledRoot = path.join(directory, 'bundled-runtime');
    const packagePath = path.join(bundledRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    await fs.mkdir(path.dirname(packagePath), { recursive: true });
    await fs.writeFile(packagePath, 'null', 'utf8');
    const errors = [];

    const descriptor = await createManager({
      state: createDefaultRuntimeState(),
      runtimeRoot: path.join(directory, 'runtime'),
      bundledRoot,
      logger: { error: (...args) => errors.push(args) },
    }).resolveCurrentRuntime();

    assert.equal(descriptor.kind, 'legacy');
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /bundled runtime/i);
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

test('promotes staging by rename and removes staging root', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const stagingRoot = path.join(runtimeRoot, 'staging', '1.2.3-install-1');
    await writeRuntime(stagingRoot, '1.2.3');
    const manager = createManager({ state: null, runtimeRoot, bundledRoot: path.join(directory, 'bundled') });

    const descriptor = await manager.promoteStaging(stagingRoot, '1.2.3');

    assert.equal(descriptor.kind, 'managed');
    assert.equal(descriptor.version, '1.2.3');
    assert.equal(descriptor.rootPath, path.join(runtimeRoot, 'versions', '1.2.3'));
    assert.equal(await pathExists(stagingRoot), false);
    assert.equal(await pathExists(descriptor.rootPath), true);
  });
});

test('reuses an already valid target version', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const targetRoot = path.join(runtimeRoot, 'versions', '1.2.3');
    const stagingRoot = path.join(runtimeRoot, 'staging', '1.2.3-install-2');
    await writeRuntime(targetRoot, '1.2.3');
    await writeRuntime(stagingRoot, '1.2.3');
    await fs.writeFile(path.join(targetRoot, 'target-marker.txt'), 'keep me', 'utf8');
    const manager = createManager({ state: null, runtimeRoot, bundledRoot: path.join(directory, 'bundled') });

    const descriptor = await manager.promoteStaging(stagingRoot, '1.2.3');

    assert.equal(descriptor.rootPath, targetRoot);
    assert.equal(await fs.readFile(path.join(targetRoot, 'target-marker.txt'), 'utf8'), 'keep me');
    assert.equal(await pathExists(stagingRoot), true);
  });
});

test('invalid target is isolated and replaced safely', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const targetRoot = path.join(runtimeRoot, 'versions', '1.2.3');
    const stagingRoot = path.join(runtimeRoot, 'staging', '1.2.3-install-3');
    await fs.mkdir(targetRoot, { recursive: true });
    await fs.writeFile(path.join(targetRoot, 'untrusted.txt'), 'do not overwrite', 'utf8');
    await writeRuntime(stagingRoot, '1.2.3');
    const manager = createManager({ state: null, runtimeRoot, bundledRoot: path.join(directory, 'bundled') });

    const descriptor = await manager.promoteStaging(stagingRoot, '1.2.3');
    const versionEntries = await fs.readdir(path.join(runtimeRoot, 'versions'));
    const isolatedName = versionEntries.find((entry) => entry.startsWith('1.2.3.invalid-'));

    assert.equal(descriptor.rootPath, targetRoot);
    assert.equal(await fs.readFile(path.join(targetRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8').then(JSON.parse).then((pkg) => pkg.version), '1.2.3');
    assert.ok(isolatedName);
    assert.equal(await fs.readFile(path.join(runtimeRoot, 'versions', isolatedName, 'untrusted.txt'), 'utf8'), 'do not overwrite');
    assert.equal(await pathExists(stagingRoot), false);
  });
});

test('activation records current -> previous and clears pending', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const bundledRoot = path.join(directory, 'bundled');
    const oldRoot = path.join(runtimeRoot, 'versions', '1.0.0');
    const nextRoot = path.join(runtimeRoot, 'versions', '2.0.0');
    await writeRuntime(oldRoot, '1.0.0');
    await writeRuntime(nextRoot, '2.0.0');
    const manager = createManager({ state: null, runtimeRoot, bundledRoot });
    await manager.stateStore.save({
      ...createDefaultRuntimeState(),
      current: runtimeReference('1.0.0'),
      pending: runtimeReference('2.0.0'),
    });

    const state = await manager.activateRuntime(await manager.resolveManagedRuntime('2.0.0'));

    assert.deepEqual(state.current, runtimeReference('2.0.0'));
    assert.deepEqual(state.previous, runtimeReference('1.0.0'));
    assert.equal(state.pending, null);
    assert.deepEqual(await manager.getState(), state);
  });
});

test('rollback restores previous Managed or Bundled and records failed version', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const bundledRoot = path.join(directory, 'bundled');
    await writeRuntime(path.join(runtimeRoot, 'versions', '1.0.0'), '1.0.0');
    await writeRuntime(path.join(runtimeRoot, 'versions', '2.0.0'), '2.0.0');
    await writeRuntime(bundledRoot, '3.0.0');
    const manager = createManager({ state: null, runtimeRoot, bundledRoot });
    await manager.stateStore.save({
      ...createDefaultRuntimeState(),
      current: runtimeReference('2.0.0'),
      previous: runtimeReference('1.0.0'),
      pending: runtimeReference('2.0.0'),
    });

    const restored = await manager.rollbackRuntime();
    const state = await manager.getState();

    assert.equal(restored.kind, 'managed');
    assert.equal(restored.version, '1.0.0');
    assert.deepEqual(state.current, runtimeReference('1.0.0'));
    assert.equal(state.pending, null);
    assert.match(state.failedVersions['2.0.0'], /^\d{4}-\d{2}-\d{2}T/);

    await manager.stateStore.save({ ...createDefaultRuntimeState(), current: runtimeReference('2.0.0') });
    const fallback = await manager.rollbackRuntime();
    assert.equal(fallback.kind, 'bundled');
    assert.equal(fallback.version, '3.0.0');
  });
});

test('pending descriptor is validated before activation and invalid pending is cleared', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const managedRoot = path.join(runtimeRoot, 'versions', '2.0.0');
    await writeRuntime(managedRoot, '2.0.0');
    const manager = createManager({ state: null, runtimeRoot, bundledRoot: path.join(directory, 'bundled') });

    await manager.recordPending(await manager.resolveManagedRuntime('2.0.0'));
    const pending = await manager.consumePendingIfValid();
    assert.equal(pending.version, '2.0.0');
    assert.deepEqual((await manager.getState()).pending, runtimeReference('2.0.0'));

    await fs.rm(managedRoot, { recursive: true, force: true });
    assert.equal(await manager.consumePendingIfValid(), null);
    const state = await manager.getState();
    assert.equal(state.pending, null);
    assert.match(state.failedVersions['2.0.0'], /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('stale staging cleanup preserves active/current/previous/pending', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const stagingRoot = path.join(runtimeRoot, 'staging');
    const names = ['remove-me', '1.2.3-active-operation', 'current-ref', 'previous-ref', 'pending-ref'];
    await Promise.all(names.map((name) => fs.mkdir(path.join(stagingRoot, name), { recursive: true })));
    const stale = new Date(Date.now() - (25 * 60 * 60 * 1000));
    await Promise.all(names.map((name) => fs.utimes(path.join(stagingRoot, name), stale, stale)));
    const manager = createManager({ state: null, runtimeRoot, bundledRoot: path.join(directory, 'bundled') });
    await manager.stateStore.save({
      ...createDefaultRuntimeState(),
      current: runtimeReference('1.0.0', path.join('staging', 'current-ref')),
      previous: runtimeReference('1.1.0', path.join('staging', 'previous-ref')),
      pending: runtimeReference('1.2.0', path.join('staging', 'pending-ref')),
    });

    const deleted = await manager.cleanupStaging({ olderThanMs: 24 * 60 * 60 * 1000, activeOperationId: 'active-operation' });

    assert.deepEqual(deleted, [path.join(stagingRoot, 'remove-me')]);
    await Promise.all(['1.2.3-active-operation', 'current-ref', 'previous-ref', 'pending-ref'].map(async (name) => {
      assert.equal(await pathExists(path.join(stagingRoot, name)), true);
    }));
  });
});

test('old-version cleanup retains current/previous and two newest managed versions', async () => {
  await withTempDir(async (directory) => {
    const runtimeRoot = path.join(directory, 'runtime');
    const versions = ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0', '6.0.0'];
    await Promise.all(versions.map((version) => writeRuntime(path.join(runtimeRoot, 'versions', version), version)));
    const manager = createManager({ state: null, runtimeRoot, bundledRoot: path.join(directory, 'bundled') });
    await manager.stateStore.save({
      ...createDefaultRuntimeState(),
      current: runtimeReference('1.0.0'),
      previous: runtimeReference('2.0.0'),
      pending: runtimeReference('3.0.0'),
    });

    const deleted = await manager.cleanupOldVersions({ keepCount: 2 });

    assert.deepEqual(deleted, [path.join(runtimeRoot, 'versions', '4.0.0')]);
    await Promise.all(['1.0.0', '2.0.0', '3.0.0', '5.0.0', '6.0.0'].map(async (version) => {
      assert.equal(await pathExists(path.join(runtimeRoot, 'versions', version)), true);
    }));
  });
});
