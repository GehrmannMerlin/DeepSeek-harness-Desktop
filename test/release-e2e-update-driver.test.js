'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { attachReleaseE2eUpdateDriver } = require('../src/lifecycle/release-e2e-update-driver');

function makeHarness() {
  const manager = new EventEmitter();
  const calls = [];
  const webContents = {
    isLoading: () => false,
    executeJavaScript: async (script) => {
      calls.push(['executeJavaScript', script]);
      return { state: 'SUCCESS' };
    },
  };
  const dialogWindow = { webContents };
  const lifecycle = {
    updateManager: manager,
    appLogger: { info: (message) => calls.push(['log', message]), error: (message) => calls.push(['error', message]) },
    _openUpdateDialog: (snapshot) => {
      calls.push(['open', snapshot]);
      return dialogWindow;
    },
  };
  return { lifecycle, manager, calls };
}

test('release E2E driver is inert unless explicitly enabled', () => {
  const { lifecycle, manager, calls } = makeHarness();
  const detach = attachReleaseE2eUpdateDriver(lifecycle, { env: {} });
  manager.emit('state-change', { snapshot: { state: 'UPDATE_AVAILABLE', latest: { version: '0.1.1-rc.2' } } });
  assert.equal(typeof detach, 'function');
  assert.deepEqual(calls, []);
});

test('release E2E driver opens the real dialog and invokes its renderer API', async () => {
  const { lifecycle, manager, calls } = makeHarness();
  const detach = attachReleaseE2eUpdateDriver(lifecycle, { env: { DSH_RELEASE_E2E: '1' } });
  manager.emit('state-change', { snapshot: { state: 'UPDATE_AVAILABLE', latest: { version: '0.1.1-rc.2' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0][0], 'log');
  assert.equal(calls[1][0], 'open');
  assert.equal(calls[2][0], 'executeJavaScript');
  assert.match(calls[2][1], /window\.updateApi\.confirmUpdate\(\)/);
  detach();
});

test('release E2E driver can request normal lifecycle quit at one configured state', async () => {
  const { lifecycle, manager, calls } = makeHarness();
  lifecycle.quit = async () => calls.push(['quit']);
  const detach = attachReleaseE2eUpdateDriver(lifecycle, {
    env: {
      DSH_RELEASE_E2E: '1',
      DSH_RELEASE_E2E_EXIT_AFTER_STATE: 'WAITING_FOR_EXTERNAL_HARNESS',
      DSH_RELEASE_E2E_EXIT_DELAY_MS: '0',
    },
  });

  manager.emit('state-change', { snapshot: { state: 'WAITING_FOR_EXTERNAL_HARNESS' } });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(calls.at(-1), ['quit']);
  detach();
});
