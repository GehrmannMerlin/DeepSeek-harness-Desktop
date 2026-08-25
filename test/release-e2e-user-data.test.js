'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyReleaseE2eUserData } = require('../src/lifecycle/release-e2e-user-data');

test('applies only an explicit absolute userData directory in release E2E mode', () => {
  const calls = [];
  const app = { setPath(name, value) { calls.push([name, value]); } };

  const applied = applyReleaseE2eUserData(app, {
    DSH_RELEASE_E2E: '1',
    DSH_RELEASE_E2E_USER_DATA_DIR: 'C:\\Temp\\dsh-release-e2e-user-data',
  });

  assert.equal(applied, true);
  assert.deepEqual(calls, [['userData', 'C:\\Temp\\dsh-release-e2e-user-data']]);
});

test('leaves production userData behavior untouched without the explicit E2E flags', () => {
  const calls = [];
  const app = { setPath(name, value) { calls.push([name, value]); } };

  assert.equal(applyReleaseE2eUserData(app, {}), false);
  assert.deepEqual(calls, []);
});

test('rejects a relative E2E userData directory instead of falling back to real AppData', () => {
  const app = { setPath() {} };

  assert.throws(
    () => applyReleaseE2eUserData(app, {
      DSH_RELEASE_E2E: '1',
      DSH_RELEASE_E2E_USER_DATA_DIR: 'relative\\path',
    }),
    /absolute path/,
  );
});
