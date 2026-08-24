'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const test = require('node:test');

const { DshRuntimeManager } = require('../src/runtime/dsh-runtime-manager');
const { RuntimeStateStore, createDefaultRuntimeState } = require('../src/runtime/runtime-state-store');
const { DshUpdateManager, STATES } = require('../src/update/dsh-update-manager');
const { NpmRegistryUpdateSource, PACKAGE_NAME } = require('../src/update/npm-registry-update-source');
const { verifyRuntime } = require('../src/update/runtime-verifier');
const { createRuntimeDescriptor } = require('../src/runtime/runtime-descriptor');
const { withTempDir, writeJson } = require('./test-helpers');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const LATEST_VERSION = '1.1.0';
const CURRENT_VERSION = '1.0.0';
const PREVIOUS_VERSION = '0.9.0';

function runtimeReference(version) {
  return { relativePath: version, kind: 'managed', version };
}

async function writeRuntime(rootPath, version, { packageVersion = version, packageJson = {}, cliRelativePath = 'bin/dsh.js' } = {}) {
  const packageRoot = path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh');
  const cliPath = path.join(packageRoot, cliRelativePath);
  await fs.mkdir(path.dirname(cliPath), { recursive: true });
  await writeJson(path.join(packageRoot, 'package.json'), {
    name: PACKAGE_NAME,
    version: packageVersion,
    bin: { dsh: cliRelativePath },
    ...packageJson,
  });
  await fs.writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
  return { packageRoot, cliPath };
}

async function createRuntimeFixture(directory, {
  currentVersion = CURRENT_VERSION,
  previousVersion = null,
  bundledVersion = '0.8.0',
  includeBundled = true,
  state = {},
  legacyResolver = () => ({ command: 'npx.cmd', args: ['@deepseek-ai/dsh', 'web'] }),
} = {}) {
  const runtimeRoot = path.join(directory, 'runtime');
  const bundledRoot = path.join(directory, 'bundled-runtime');
  if (includeBundled) await writeRuntime(bundledRoot, bundledVersion);
  if (currentVersion && currentVersion !== 'bundled') {
    await writeRuntime(path.join(runtimeRoot, 'versions', currentVersion), currentVersion);
  }
  if (previousVersion) {
    await writeRuntime(path.join(runtimeRoot, 'versions', previousVersion), previousVersion);
  }

  const stateStore = new RuntimeStateStore({
    filePath: path.join(runtimeRoot, 'state.json'),
    logger: silentLogger,
  });
  const initialState = { ...createDefaultRuntimeState(), ...state };
  if (!Object.prototype.hasOwnProperty.call(state, 'current') && currentVersion && currentVersion !== 'bundled') {
    initialState.current = runtimeReference(currentVersion);
  }
  await stateStore.save(initialState);

  const runtimeManager = new DshRuntimeManager({
    stateStore,
    runtimeRoot,
    bundledRoot,
    legacyResolver,
    nodeCommandResolver: async () => process.execPath,
    logger: silentLogger,
  });
  return { runtimeRoot, bundledRoot, stateStore, runtimeManager };
}

function metadata(version = LATEST_VERSION) {
  return {
    name: PACKAGE_NAME,
    'dist-tags': { latest: version },
    versions: { [version]: { dist: { integrity: 'sha512-test', tarball: `https://registry.test/${version}.tgz` } } },
  };
}

function createProcessManager({ owned = true, calls, url = 'http://127.0.0.1:3000/' } = {}) {
  const processManager = new EventEmitter();
  processManager.ownsHarness = () => owned;
  processManager.getPid = () => owned ? 4321 : null;
  processManager.getUrl = () => url;
  processManager.stop = async () => {
    calls.push('stop');
    return true;
  };
  processManager.start = async (runtime) => {
    calls.push(['start', runtime.version]);
    return true;
  };
  processManager.restart = async () => {
    calls.push('restart');
    return true;
  };
  processManager.kill = async () => {
    calls.push('kill');
    return true;
  };
  return processManager;
}

function createVerifier() {
  return {
    verify(input) {
      return verifyRuntime({
        ...input,
        runCommand: async () => ({ code: 0, stdout: `${input.expectedVersion}\n`, stderr: '' }),
      });
    },
  };
}

function createSystem({
  fixture,
  latestVersion = LATEST_VERSION,
  requestJson,
  installerOptions = {},
  owned = true,
  healthResults = [{ ok: true }],
  calls = [],
  clock = () => Date.parse('2026-08-24T12:00:00.000Z'),
} = {}) {
  const registryCalls = { count: 0 };
  const registry = NpmRegistryUpdateSource({
    logger: silentLogger,
    requestJson: async (...args) => {
      registryCalls.count += 1;
      if (requestJson) return requestJson(...args);
      return metadata(latestVersion);
    },
  });
  const installCalls = [];
  const installer = {
    async install(input) {
      installCalls.push(input);
      calls.push(['install', input.version]);
      if (installerOptions.result) return installerOptions.result(input);
      await writeRuntime(input.stagingRoot, input.version, installerOptions.runtime || {});
      return { ok: true, stagingRoot: input.stagingRoot };
    },
  };
  const verifier = createVerifier();
  const processManager = createProcessManager({ owned, calls });
  const healthCalls = [];
  const healthQueue = [...healthResults];
  const healthChecker = {
    async waitUntilReady(url) {
      healthCalls.push(url);
      calls.push(['health', url]);
      return healthQueue.length > 0 ? healthQueue.shift() : { ok: true };
    },
  };

  const originalPromote = fixture.runtimeManager.promoteStaging.bind(fixture.runtimeManager);
  fixture.runtimeManager.promoteStaging = async (stagingRoot, version) => {
    calls.push(['promote', version]);
    return originalPromote(stagingRoot, version);
  };
  const originalActivate = fixture.runtimeManager.activateRuntime.bind(fixture.runtimeManager);
  fixture.runtimeManager.activateRuntime = async (runtime) => {
    calls.push(['activate', runtime.version]);
    return originalActivate(runtime);
  };
  const originalRollback = fixture.runtimeManager.rollbackRuntime.bind(fixture.runtimeManager);
  fixture.runtimeManager.rollbackRuntime = async () => {
    calls.push('rollback');
    return originalRollback();
  };

  const manager = new DshUpdateManager({
    runtimeManager: fixture.runtimeManager,
    registry,
    installer,
    verifier,
    processManager,
    healthChecker,
    logger: silentLogger,
    clock,
    urlWaitTimeoutMs: 25,
  });
  return { manager, registryCalls, installCalls, processManager, healthCalls, calls, registry, installer, healthChecker };
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.visible = false;
  }

  loadFile(filePath) { this.loadedFile = filePath; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };
}

function loadDialogModule() {
  const electronStub = { BrowserWindow: FakeBrowserWindow, ipcMain: createIpcMain(), shell: { openPath: async () => '' } };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../src/window/update-dialog');
  } finally {
    Module._load = originalLoad;
  }
}

test('startup selects valid managed runtime over bundled and falls back for corrupt state', async () => {
  await withTempDir(async (directory) => {
    const managedFixture = await createRuntimeFixture(directory, {
      currentVersion: CURRENT_VERSION,
      bundledVersion: '0.8.0',
    });
    const managed = await managedFixture.runtimeManager.resolveCurrentRuntime();
    assert.equal(managed.kind, 'managed');
    assert.equal(managed.version, CURRENT_VERSION);

    const corruptFixture = await createRuntimeFixture(path.join(directory, 'corrupt'), {
      currentVersion: CURRENT_VERSION,
      bundledVersion: '0.8.0',
      state: { current: { relativePath: '..\\outside', kind: 'managed', version: CURRENT_VERSION } },
    });
    const fallback = await corruptFixture.runtimeManager.resolveCurrentRuntime();
    assert.equal(fallback.kind, 'bundled');
    assert.equal(fallback.version, '0.8.0');
  });
});

test('no bundled runtime preserves the legacy resolver contract', async () => {
  await withTempDir(async (directory) => {
    const fixture = await createRuntimeFixture(directory, {
      currentVersion: null,
      includeBundled: false,
      legacyResolver: () => ({ command: 'npx.cmd', args: ['@deepseek-ai/dsh', 'web'] }),
    });
    const descriptor = await fixture.runtimeManager.resolveCurrentRuntime();
    assert.equal(descriptor.kind, 'legacy');
    assert.equal(descriptor.version, 'unknown');
    assert.deepEqual({ command: descriptor.command, args: descriptor.args }, {
      command: 'npx.cmd',
      args: ['@deepseek-ai/dsh', 'web'],
    });
  });
});

test('Registry dist-tags.latest is checked without installation until confirmation', async () => {
  await withTempDir(async (directory) => {
    const fixture = await createRuntimeFixture(directory, { currentVersion: 'bundled', bundledVersion: CURRENT_VERSION });
    const system = createSystem({ fixture });

    const checked = await system.manager.checkForUpdates();
    assert.equal(checked.state, STATES.UPDATE_AVAILABLE);
    assert.equal(system.registryCalls.count, 1);
    assert.equal(system.installCalls.length, 0);
    assert.equal(system.calls.includes('stop'), false);

    const applied = await system.manager.confirmUpdate();
    assert.equal(applied.state, STATES.SUCCESS);
    assert.equal(system.installCalls.length, 1);
  });
});

test('owned update keeps current Harness alive through ready-to-apply, then applies in order', async () => {
  await withTempDir(async (directory) => {
    const fixture = await createRuntimeFixture(directory, { currentVersion: CURRENT_VERSION, bundledVersion: '0.8.0' });
    const system = createSystem({ fixture });
    await system.manager.checkForUpdates();
    assert.deepEqual(system.calls, []);

    const applied = await system.manager.confirmUpdate();
    assert.equal(applied.state, STATES.SUCCESS);
    assert.deepEqual(system.calls.map((entry) => Array.isArray(entry) ? entry[0] : entry), [
      'install', 'promote', 'stop', 'activate', 'start', 'health',
    ]);
    assert.equal((await fixture.runtimeManager.getState()).current.version, LATEST_VERSION);
  });
});

test('External Harness records durable pending activation without stop, restart, or kill', async () => {
  await withTempDir(async (directory) => {
    const fixture = await createRuntimeFixture(directory, { currentVersion: CURRENT_VERSION, bundledVersion: '0.8.0' });
    const system = createSystem({ fixture, owned: false });
    await system.manager.checkForUpdates();

    const snapshot = await system.manager.confirmUpdate();
    const state = await fixture.runtimeManager.getState();
    assert.equal(snapshot.state, STATES.WAITING_FOR_EXTERNAL_HARNESS);
    assert.equal(state.pending.version, LATEST_VERSION);
    assert.equal(state.current.version, CURRENT_VERSION);
    assert.equal(system.calls.some((entry) => ['stop', 'restart', 'kill'].includes(entry)), false);
  });
});

test('new runtime health failure rolls back to previous managed runtime, then bundled fallback when previous is unavailable', async () => {
  await withTempDir(async (directory) => {
    const fixture = await createRuntimeFixture(directory, {
      currentVersion: CURRENT_VERSION,
      previousVersion: PREVIOUS_VERSION,
      bundledVersion: '0.8.0',
    });
    const system = createSystem({ fixture, healthResults: [{ ok: false }, { ok: true }] });
    await system.manager.checkForUpdates();
    const rolledBack = await system.manager.confirmUpdate();
    assert.equal(rolledBack.state, STATES.ROLLED_BACK);
    assert.equal(rolledBack.currentRuntime.version, CURRENT_VERSION);
    assert.equal((await fixture.runtimeManager.getState()).failedVersions[LATEST_VERSION] !== undefined, true);
    assert.deepEqual(system.calls.map((entry) => Array.isArray(entry) ? entry[0] : entry), [
      'install', 'promote', 'stop', 'activate', 'start', 'health', 'stop', 'rollback', 'start', 'health',
    ]);
  });

  await withTempDir(async (directory) => {
    const fixture = await createRuntimeFixture(directory, {
      currentVersion: 'bundled',
      previousVersion: null,
      bundledVersion: '0.8.0',
    });
    const system = createSystem({ fixture, healthResults: [{ ok: false }, { ok: true }] });
    await system.manager.checkForUpdates();
    const rolledBack = await system.manager.confirmUpdate();
    assert.equal(rolledBack.state, STATES.ROLLED_BACK);
    assert.equal(rolledBack.currentRuntime.version, '0.8.0');
    assert.equal((await fixture.runtimeManager.getState()).current.kind, 'bundled');
  });
});

test('invalid staged runtime is rejected while the current runtime and pointer remain intact', async () => {
  await withTempDir(async (directory) => {
    const fixture = await createRuntimeFixture(directory, { currentVersion: CURRENT_VERSION, bundledVersion: '0.8.0' });
    const system = createSystem({
      fixture,
      installerOptions: { runtime: { packageVersion: '9.9.9' } },
    });
    await system.manager.checkForUpdates();
    const failed = await system.manager.confirmUpdate();
    const state = await fixture.runtimeManager.getState();
    assert.equal(failed.state, STATES.FAILED);
    assert.equal(failed.currentRuntime.version, CURRENT_VERSION);
    assert.equal(state.current.version, CURRENT_VERSION);
    assert.equal(system.calls.includes('stop'), false);
    assert.equal(system.calls.some((entry) => Array.isArray(entry) && entry[0] === 'promote'), false);
  });
});

test('pending activation clears only after health and activation both succeed', async () => {
  await withTempDir(async (directory) => {
    const fixture = await createRuntimeFixture(directory, {
      currentVersion: CURRENT_VERSION,
      previousVersion: null,
      bundledVersion: '0.8.0',
      state: { pending: runtimeReference(LATEST_VERSION) },
    });
    await writeRuntime(path.join(fixture.runtimeRoot, 'versions', LATEST_VERSION), LATEST_VERSION);
    const system = createSystem({ fixture, healthResults: [{ ok: true }, { ok: true }, { ok: true }] });
    const originalActivate = fixture.runtimeManager.activateRuntime.bind(fixture.runtimeManager);
    let failActivation = true;
    fixture.runtimeManager.activateRuntime = async (runtime) => {
      if (failActivation) {
        failActivation = false;
        throw new Error('activation write failed');
      }
      return originalActivate(runtime);
    };

    const first = await system.manager.recoverPendingActivation();
    assert.equal(first.state, STATES.ROLLED_BACK);
    assert.equal(first.pending, true);
    assert.equal((await fixture.runtimeManager.getState()).pending.version, LATEST_VERSION);

    const second = await system.manager.recoverPendingActivation();
    assert.equal(second.state, STATES.SUCCESS);
    assert.equal(second.pending, false);
    assert.equal((await fixture.runtimeManager.getState()).pending, null);
    assert.equal((await fixture.runtimeManager.getState()).current.version, LATEST_VERSION);
  });
});

test('failed-version suppression and automatic check-once policy are enforced per manager process', async () => {
  await withTempDir(async (directory) => {
    const now = Date.parse('2026-08-24T12:00:00.000Z');
    const fixture = await createRuntimeFixture(directory, {
      currentVersion: 'bundled',
      bundledVersion: CURRENT_VERSION,
      state: { failedVersions: { [LATEST_VERSION]: new Date(now - 60 * 60 * 1000).toISOString() } },
    });
    const system = createSystem({ fixture, clock: () => now });
    const notifications = [];
    system.manager.on('notification', (event) => notifications.push(event));

    const first = await system.manager.checkForUpdates();
    const second = await system.manager.checkForUpdates();
    assert.equal(first.state, STATES.UPDATE_AVAILABLE);
    assert.equal(second.state, STATES.UPDATE_AVAILABLE);
    assert.equal(system.registryCalls.count, 1);
    assert.equal(notifications.length, 0);

    await system.manager.checkForUpdates({ manual: true });
    assert.equal(system.registryCalls.count, 2);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].manual, true);
  });
});

test('update dialog retry performs one manual check and one deduplicated update operation', async () => {
  await withTempDir(async (directory) => {
    let requestCount = 0;
    const fixture = await createRuntimeFixture(directory, { currentVersion: CURRENT_VERSION, bundledVersion: '0.8.0' });
    const system = createSystem({
      fixture,
      requestJson: async () => {
        requestCount += 1;
        if (requestCount === 1) throw new Error('offline');
        return metadata(LATEST_VERSION);
      },
    });
    await system.manager.checkForUpdates();
    assert.equal(system.manager.getSnapshot().state, STATES.FAILED);

    const { UpdateDialog, CHANNELS } = loadDialogModule();
    const ipcMain = createIpcMain();
    const dialog = new UpdateDialog({
      updateManager: system.manager,
      BrowserWindowImpl: FakeBrowserWindow,
      ipcMainImpl: ipcMain,
      shellImpl: { openPath: async () => '' },
      rendererPath: path.join(directory, 'update.html'),
      preloadPath: path.join(directory, 'update-preload.js'),
      logPath: path.join(directory, 'application.log'),
      logger: silentLogger,
    });
    dialog.show();
    const sender = dialog.window.webContents;
    const first = ipcMain.handlers.get(CHANNELS.retry)({ sender });
    const second = ipcMain.handlers.get(CHANNELS.retry)({ sender });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(requestCount, 2);
    assert.equal(system.installCalls.length, 1);
    assert.equal(firstResult.state, STATES.SUCCESS);
    assert.equal(secondResult.state, STATES.SUCCESS);
    assert.equal(system.calls.filter((entry) => entry === 'stop').length, 1);
    dialog.destroy();
  });
});
