'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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
  verifiedGetLatest,
  installerInstall,
  artifactPrepare,
  verifierVerify,
  healthResults = [{ ok: true }],
  failedVersions = {},
  clock = () => Date.parse('2026-08-24T00:00:00.000Z'),
  pendingVersion = latestVersion,
  runtimeActivate,
  runtimeRollback,
  processStop,
  processStart,
  deferredUrl = false,
  urlWaitTimeoutMs,
} = {}) {
  const calls = [];
  const stateChanges = [];
  const progressEvents = [];
  const notifications = [];
  const updates = [];
  const current = descriptor(currentVersion);
  const prepared = descriptor(latestVersion);
  const previous = descriptor('0.9.0');
  const pending = pendingVersion === null ? null : descriptor(pendingVersion);
  const healthQueue = [...healthResults];
  const runtimeManager = {
    runtimeRoot: path.join(process.cwd(), 'test-fixtures', 'runtime-root'),
    async resolveCurrentRuntime() { calls.push('resolve-current'); return current; },
    async getState() { calls.push('get-state'); return { failedVersions: { ...failedVersions } }; },
    async promoteStaging(stagingRoot, version) {
      calls.push(['promote', stagingRoot, version]);
      return prepared;
    },
    async activateRuntime(runtime) {
      calls.push(['activate', runtime.version]);
      if (runtimeActivate) return runtimeActivate(runtime);
      return { current: runtime.version };
    },
    async rollbackRuntime() {
      calls.push('rollback');
      if (runtimeRollback) return runtimeRollback();
      return previous;
    },
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
  const verifiedSource = verifiedGetLatest ? {
    async getLatest(input) {
      calls.push(['verified', input]);
      return verifiedGetLatest(input);
    },
  } : null;
  const artifactDownloader = artifactPrepare ? {
    async prepare(input) {
      calls.push(['artifact', input.version]);
      return artifactPrepare(input);
    },
  } : null;
  const verifier = {
    async verify(input) {
      calls.push(['verify', input.expectedVersion]);
      if (verifierVerify) return verifierVerify(input);
      return { ok: true };
    },
  };
  const processManager = deferredUrl ? new EventEmitter() : {
    ownsHarness() { return ownsHarness; },
    getPid() { return ownsHarness ? 1234 : null; },
    getUrl() { return 'http://127.0.0.1:3000/'; },
    async stop() {
      calls.push('stop');
      if (processStop) return processStop(calls.filter((call) => call === 'stop').length);
      return true;
    },
    async start(runtime) {
      calls.push(['start', runtime.version]);
      if (processStart) return processStart(runtime);
      return true;
    },
  };
  if (deferredUrl) {
    let url = null;
    Object.assign(processManager, {
      ownsHarness() { return ownsHarness; },
      getPid() { return ownsHarness ? 1234 : null; },
      getUrl() { return url; },
      async stop() {
        calls.push('stop');
        if (processStop) return processStop(calls.filter((call) => call === 'stop').length);
        return true;
      },
      async start(runtime) {
        calls.push(['start', runtime.version]);
        if (processStart) return processStart(runtime);
        setImmediate(() => {
          url = 'http://127.0.0.1:3000/';
          processManager.emit('url-detected', url);
        });
        return true;
      },
    });
  }
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
    verifiedSource,
    artifactDownloader,
    verifier,
    processManager,
    healthChecker,
    logger: silentLogger,
    clock,
    urlWaitTimeoutMs,
  });
  manager.on('state-change', (event) => stateChanges.push(event));
  manager.on('progress', (event) => progressEvents.push(event));
  manager.on('notification', (event) => notifications.push(event));
  manager.on('update-available', (event) => updates.push(event));
  return { manager, calls, stateChanges, progressEvents, notifications, updates, runtimeManager, installer, processManager, artifactDownloader };
}

test('uses verified artifact metadata and downloader instead of npm installer', async () => {
  let installerCalls = 0;
  const h = createHarness({
    latestVersion: '1.2.0',
    verifiedGetLatest: async () => ({
      packageName: PACKAGE_NAME,
      version: '1.1.0',
      platform: 'win32',
      arch: 'x64',
      artifactUrl: 'https://updates.example.test/dsh.zip',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      manifest: { schemaVersion: 1, packageName: PACKAGE_NAME, version: '1.1.0', platform: 'win32', arch: 'x64', cliEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js' },
    }),
    installerInstall: async () => { installerCalls += 1; throw new Error('npm installer must not run'); },
    artifactPrepare: async ({ stagingRoot }) => ({ rootPath: stagingRoot }),
  });

  const checked = await h.manager.checkForUpdates();
  assert.equal(checked.latest.version, '1.1.0');
  assert.equal(checked.upstreamLatestVersion, '1.2.0');
  const applied = await h.manager.confirmUpdate();
  assert.equal(applied.state, STATES.SUCCESS);
  assert.equal(installerCalls, 0);
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'resolve-current', 'get-state', 'registry', 'verified', 'artifact', 'verify', 'promote', 'stop', 'activate', 'start', 'health',
  ]);
});

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

test('automatic checks run once per manager while manual checks bypass the automatic gate', async () => {
  const h = createHarness();

  await h.manager.checkForUpdates();
  await h.manager.checkForUpdates();
  await h.manager.checkForUpdates({ manual: true });

  assert.equal(h.calls.filter((call) => call === 'registry').length, 2);
});

test('invalid Registry metadata fails before any installer operation', async () => {
  const h = createHarness({
    registryGetLatest: async () => ({ packageName: PACKAGE_NAME, version: 'not-semver', distTag: 'latest' }),
  });

  const snapshot = await h.manager.checkForUpdates();

  assert.equal(snapshot.state, STATES.FAILED);
  assert.equal(h.calls.includes('install'), false);
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
  assert.equal(snapshot.updateAvailable, false);
  assert.equal(snapshot.latest, null);
  assert.equal(snapshot.preparedRuntime, null);
  assert.equal(snapshot.operationId, null);
});

test('owned failure before activation restores the original current descriptor without runtime rollback', async () => {
  const h = createHarness({ runtimeActivate: async () => { throw new Error('state write failed'); } });
  await h.manager.checkForUpdates();

  const snapshot = await h.manager.confirmUpdate();

  assert.equal(snapshot.state, STATES.ROLLED_BACK);
  assert.equal(snapshot.currentRuntime.version, '1.0.0');
  assert.equal(h.calls.includes('rollback'), false);
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call).slice(-4), [
    'stop', 'activate', 'start', 'health',
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

test('pending start or health failure restores the current descriptor and preserves pending', async () => {
  const h = createHarness({ healthResults: [{ ok: false }, { ok: true }] });

  const snapshot = await h.manager.recoverPendingActivation();

  assert.equal(snapshot.state, STATES.ROLLED_BACK);
  assert.equal(snapshot.pending, true);
  assert.equal(snapshot.currentRuntime.version, '1.0.0');
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'consume-pending', 'resolve-current', 'stop', 'start', 'health', 'stop', 'start', 'health',
  ]);
});

test('pending stop failure still attempts current-runtime recovery and preserves pending', async () => {
  const h = createHarness({ processStop: (count) => { if (count === 1) throw new Error('stop failed'); return true; } });

  const snapshot = await h.manager.recoverPendingActivation();

  assert.equal(snapshot.state, STATES.ROLLED_BACK);
  assert.equal(snapshot.pending, true);
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'consume-pending', 'resolve-current', 'stop', 'start', 'health',
  ]);
});

test('pending activation failure restores current runtime without clearing pending', async () => {
  const h = createHarness({ runtimeActivate: async () => { throw new Error('pending state write failed'); } });

  const snapshot = await h.manager.recoverPendingActivation();

  assert.equal(snapshot.state, STATES.ROLLED_BACK);
  assert.equal(snapshot.pending, true);
  assert.equal(snapshot.currentRuntime.version, '1.0.0');
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'consume-pending', 'resolve-current', 'stop', 'start', 'health', 'activate', 'stop', 'start', 'health',
  ]);
});

test('pending recovery failure becomes fatal when the original current runtime cannot recover', async () => {
  const h = createHarness({ healthResults: [{ ok: false }, { ok: false }] });

  const snapshot = await h.manager.recoverPendingActivation();

  assert.equal(snapshot.state, STATES.FAILED);
  assert.equal(snapshot.error.fatal, true);
  assert.equal(snapshot.pending, true);
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'consume-pending', 'resolve-current', 'stop', 'start', 'health', 'stop', 'start', 'health', 'stop',
  ]);
});

test('rollback fallback failure becomes fatal after an activated runtime fails health', async () => {
  const h = createHarness({
    healthResults: [{ ok: false }],
    runtimeRollback: async () => { throw new Error('fallback unavailable'); },
  });
  await h.manager.checkForUpdates();

  const snapshot = await h.manager.confirmUpdate();

  assert.equal(snapshot.state, STATES.FAILED);
  assert.equal(snapshot.error.fatal, true);
  assert.equal(h.calls.includes('rollback'), true);
});

test('URL detection wait is injectable and captures a URL event after start', async () => {
  const h = createHarness({ deferredUrl: true, urlWaitTimeoutMs: 10 });
  await h.manager.checkForUpdates();

  const snapshot = await h.manager.confirmUpdate();

  assert.equal(snapshot.state, STATES.SUCCESS);
  assert.equal(h.calls.filter((call) => Array.isArray(call) && call[0] === 'health').length, 1);
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
