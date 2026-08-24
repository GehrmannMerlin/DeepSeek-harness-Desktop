'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createRuntimeDescriptor } = require('../src/runtime/runtime-descriptor');
const { DshUpdateManager, STATES } = require('../src/update/dsh-update-manager');

const PACKAGE_NAME = '@deepseek-ai/dsh';
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function descriptor(version, kind = 'managed') {
  const rootPath = path.join(process.cwd(), 'test-fixtures', `${kind}-${version}`);
  return createRuntimeDescriptor({
    kind,
    version,
    rootPath,
    packagePath: path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh'),
    cliEntry: path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    args: [path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
    command: process.execPath,
    source: kind,
  });
}

function createHarness({
  latestVersion = '1.1.0',
  currentVersion = '1.0.0',
  ownsHarness = true,
  registryGetLatest,
  installerInstall,
  verifierVerify,
  healthResults = [{ ok: true }],
  failedVersions = {},
  clock = () => Date.parse('2026-08-24T00:00:00.000Z'),
} = {}) {
  const calls = [];
  const stateChanges = [];
  const progressEvents = [];
  const notifications = [];
  const updates = [];
  const current = descriptor(currentVersion);
  const prepared = descriptor(latestVersion);
  const previous = descriptor('0.9.0');
  const pending = descriptor(latestVersion);
  const healthQueue = [...healthResults];
  const runtimeManager = {
    runtimeRoot: path.join(process.cwd(), 'test-fixtures', 'runtime-root'),
    async resolveCurrentRuntime() { calls.push('resolve-current'); return current; },
    async getState() { calls.push('get-state'); return { failedVersions: { ...failedVersions } }; },
    async promoteStaging(stagingRoot, version) {
      calls.push(['promote', stagingRoot, version]);
      return prepared;
    },
    async activateRuntime(runtime) { calls.push(['activate', runtime.version]); return { current: runtime.version }; },
    async rollbackRuntime() { calls.push('rollback'); return previous; },
    async recordPending(runtime) { calls.push(['pending', runtime.version]); },
    async consumePendingIfValid() { calls.push('consume-pending'); return pending; },
    async nodeCommandResolver() { return process.execPath; },
  };
  const registry = {
    async getLatest() {
      calls.push('registry');
      if (registryGetLatest) return registryGetLatest();
      return { packageName: PACKAGE_NAME, version: latestVersion, distTag: 'latest' };
    },
    compareLatest(installed, latest) {
      if (installed === latest) return 'UP_TO_DATE';
      return latestVersion > installed ? 'UPDATE_AVAILABLE' : 'AHEAD_OF_LATEST';
    },
  };
  const installer = {
    async install(input) {
      calls.push(['install', input.version]);
      if (installerInstall) return installerInstall(input);
      return { ok: true, stagingRoot: input.stagingRoot };
    },
  };
  const verifier = {
    async verify(input) {
      calls.push(['verify', input.expectedVersion]);
      if (verifierVerify) return verifierVerify(input);
      return { ok: true };
    },
  };
  const processManager = {
    ownsHarness() { return ownsHarness; },
    getPid() { return ownsHarness ? 1234 : null; },
    getUrl() { return 'http://127.0.0.1:3000/'; },
    async stop() { calls.push('stop'); return true; },
    async start(runtime) { calls.push(['start', runtime.version]); return true; },
  };
  const healthChecker = {
    async waitUntilReady(url) {
      calls.push(['health', url]);
      return healthQueue.length > 0 ? healthQueue.shift() : { ok: true };
    },
  };
  const manager = new DshUpdateManager({
    runtimeManager,
    registry,
    installer,
    verifier,
    processManager,
    healthChecker,
    logger: silentLogger,
    clock,
  });
  manager.on('state-change', (event) => stateChanges.push(event));
  manager.on('progress', (event) => progressEvents.push(event));
  manager.on('notification', (event) => notifications.push(event));
  manager.on('update-available', (event) => updates.push(event));
  return { manager, calls, stateChanges, progressEvents, notifications, updates, runtimeManager, installer };
}

test('no newer runtime becomes UP_TO_DATE without installing or stopping', async () => {
  const h = createHarness({ latestVersion: '1.0.0', currentVersion: '1.0.0' });

  const snapshot = await h.manager.checkForUpdates();

  assert.equal(snapshot.state, STATES.UP_TO_DATE);
  assert.deepEqual(h.calls, ['resolve-current', 'get-state', 'registry']);
  assert.equal(h.calls.includes('install'), false);
  assert.equal(h.calls.includes('stop'), false);
});

test('newer latest emits one update event and exposes an immutable snapshot', async () => {
  const h = createHarness();

  const first = await h.manager.checkForUpdates();
  const second = await h.manager.checkForUpdates();

  assert.equal(first.state, STATES.UPDATE_AVAILABLE);
  assert.equal(second.state, STATES.UPDATE_AVAILABLE);
  assert.equal(h.updates.length, 1);
  assert.equal(h.notifications.length, 1);
  first.latest.version = '9.9.9';
  assert.equal(h.manager.getSnapshot().latest.version, '1.1.0');
});

test('automatic registry failure is visible as an error but not a notification', async () => {
  const h = createHarness({ registryGetLatest: async () => { throw new Error('offline'); } });
  const errors = [];
  h.manager.on('error', (event) => errors.push(event));

  const snapshot = await h.manager.checkForUpdates();

  assert.equal(snapshot.state, STATES.FAILED);
  assert.equal(errors.length, 1);
  assert.equal(h.notifications.length, 0);
});

test('manual registry failure emits a user-facing notification', async () => {
  const h = createHarness({ registryGetLatest: async () => { throw new Error('offline'); } });

  const snapshot = await h.manager.checkForUpdates({ manual: true });

  assert.equal(snapshot.state, STATES.FAILED);
  assert.equal(h.notifications.length, 1);
});

test('install failure leaves the current Harness running', async () => {
  const h = createHarness({ installerInstall: async () => ({ ok: false, error: 'npm failed' }) });
  await h.manager.checkForUpdates();

  const snapshot = await h.manager.confirmUpdate();

  assert.equal(snapshot.state, STATES.FAILED);
  assert.equal(h.calls.includes('stop'), false);
  assert.equal(h.calls.includes('activate'), false);
});

test('verification failure leaves the current Harness running', async () => {
  const h = createHarness({ verifierVerify: async () => ({ ok: false, reason: 'cli-version-mismatch' }) });
  await h.manager.checkForUpdates();

  const snapshot = await h.manager.confirmUpdate();

  assert.equal(snapshot.state, STATES.FAILED);
  assert.equal(h.calls.includes('stop'), false);
  assert.equal(h.calls.includes('activate'), false);
});

test('owned update installs, verifies, promotes, stops, activates, restarts, and health-checks in order', async () => {
  const h = createHarness();
  await h.manager.checkForUpdates();

  const snapshot = await h.manager.confirmUpdate();

  assert.equal(snapshot.state, STATES.SUCCESS);
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'resolve-current', 'get-state', 'registry', 'install', 'verify', 'promote', 'stop', 'activate', 'start', 'health',
  ]);
  assert.deepEqual(h.stateChanges.map((event) => event.to), [
    STATES.CHECKING, STATES.UPDATE_AVAILABLE, STATES.PREPARING, STATES.INSTALLING,
    STATES.VERIFYING, STATES.READY_TO_APPLY, STATES.STOPPING_CURRENT, STATES.SWITCHING,
    STATES.RESTARTING, STATES.SUCCESS,
  ]);
  assert.deepEqual(h.progressEvents.map((event) => event.progress && event.progress.phase), [
    'checking', null, 'preparing', 'installing', 'verifying', 'ready-to-apply',
    'stopping', 'switching', 'restarting', null,
  ]);
});

test('owned update rolls back after new runtime health failure', async () => {
  const h = createHarness({ healthResults: [{ ok: false }, { ok: true }] });
  await h.manager.checkForUpdates();

  const snapshot = await h.manager.confirmUpdate();

  assert.equal(snapshot.state, STATES.ROLLED_BACK);
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'resolve-current', 'get-state', 'registry', 'install', 'verify', 'promote', 'stop', 'activate', 'start', 'health',
    'stop', 'rollback', 'start', 'health',
  ]);
});

test('rollback health failure becomes fatal FAILED', async () => {
  const h = createHarness({ healthResults: [{ ok: false }, { ok: false }] });
  await h.manager.checkForUpdates();

  const snapshot = await h.manager.confirmUpdate();

  assert.equal(snapshot.state, STATES.FAILED);
  assert.equal(snapshot.error.fatal, true);
});

test('External ownership records pending and never stops, restarts, or kills', async () => {
  const h = createHarness({ ownsHarness: false });
  await h.manager.checkForUpdates();

  const snapshot = await h.manager.confirmUpdate();

  assert.equal(snapshot.state, STATES.WAITING_FOR_EXTERNAL_HARNESS);
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'resolve-current', 'get-state', 'registry', 'install', 'verify', 'promote', 'pending',
  ]);
  assert.equal(h.calls.includes('stop'), false);
  assert.equal(h.calls.includes('start'), false);
});

test('pending activation recovery activates only after successful health and clears pending', async () => {
  const h = createHarness();

  const snapshot = await h.manager.recoverPendingActivation();

  assert.equal(snapshot.state, STATES.SUCCESS);
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'consume-pending', 'resolve-current', 'stop', 'start', 'health', 'activate',
  ]);
});

test('automatic notification for a failed version is suppressed for 24 hours', async () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z');
  const h = createHarness({
    failedVersions: { '1.1.0': '2026-08-24T00:00:00.000Z' },
    clock: () => now,
  });

  const snapshot = await h.manager.checkForUpdates();

  assert.equal(snapshot.state, STATES.UPDATE_AVAILABLE);
  assert.equal(h.updates.length, 1);
  assert.equal(h.notifications.length, 0);
});

test('repeated checks and confirmations share one in-flight Promise', async () => {
  let resolveRegistry;
  const h = createHarness({
    registryGetLatest: () => new Promise((resolve) => { resolveRegistry = resolve; }),
  });

  const checkOne = h.manager.checkForUpdates();
  const checkTwo = h.manager.checkForUpdates();
  assert.strictEqual(checkOne, checkTwo);
  while (!resolveRegistry) await new Promise((resolve) => setImmediate(resolve));
  resolveRegistry({ packageName: PACKAGE_NAME, version: '1.1.0', distTag: 'latest' });
  await checkOne;

  let resolveInstall;
  let installCount = 0;
  h.installer.install = () => {
    installCount += 1;
    return new Promise((resolve) => { resolveInstall = resolve; });
  };
  const confirmOne = h.manager.confirmUpdate();
  const confirmTwo = h.manager.confirmUpdate();
  assert.strictEqual(confirmOne, confirmTwo);
  while (!resolveInstall) await new Promise((resolve) => setImmediate(resolve));
  resolveInstall({ ok: true });
  await confirmOne;
  assert.equal(installCount, 1);
});
