'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { check, createReleaseE2eHealthChecker } = require('../src/health/harness-health-checker');

test('recognizes the current DSH bootstrap marker emitted through globalThis', async () => {
  const result = await check('http://127.0.0.1:3080/', {
    transport: async () => ({
      status: 200,
      body: '<script>globalThis["__DSH_BOOT__"] = {"rev":"rc2"}</script>',
    }),
  });

  assert.deepEqual(result, {
    ready: true,
    isHarness: true,
    status: 200,
    error: null,
  });
});

test('release E2E health failure is version-scoped and one-shot', async () => {
  const calls = [];
  const realChecker = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, elapsed: 7 };
  };
  const checker = createReleaseE2eHealthChecker({
    env: { DSH_RELEASE_E2E: '1', DSH_RELEASE_E2E_FAIL_HEALTH_VERSION: '0.1.1-rc.2' },
    realChecker,
  });

  const first = await checker('http://127.0.0.1:3080/', {
    runtime: { version: '0.1.1-rc.2' },
    phase: 'post_activation_update_health',
  });
  const second = await checker('http://127.0.0.1:3080/', {
    runtime: { version: '0.1.1-rc.2' },
    phase: 'post_activation_update_health',
  });

  assert.equal(first.ok, false);
  assert.equal(first.controlledFailure, true);
  assert.deepEqual(second, { ok: true, elapsed: 7 });
  assert.equal(calls.length, 1);
});

test('release E2E health failure does not affect other versions or phases', async () => {
  const calls = [];
  const checker = createReleaseE2eHealthChecker({
    env: { DSH_RELEASE_E2E: '1', DSH_RELEASE_E2E_FAIL_HEALTH_VERSION: '0.1.1-rc.2' },
    realChecker: async (_url, options) => {
      calls.push(options);
      return { ok: true };
    },
  });

  const otherVersion = await checker('http://127.0.0.1:3080/', {
    runtime: { version: '0.1.0-rc.7' },
    phase: 'post_activation_update_health',
  });
  const otherPhase = await checker('http://127.0.0.1:3080/', {
    runtime: { version: '0.1.1-rc.2' },
    phase: 'startup_health',
  });

  assert.deepEqual(otherVersion, { ok: true });
  assert.deepEqual(otherPhase, { ok: true });
  assert.equal(calls.length, 2);
});

test('release E2E health failure is disabled in production mode', async () => {
  let calls = 0;
  const checker = createReleaseE2eHealthChecker({
    env: {},
    realChecker: async () => {
      calls += 1;
      return { ok: true };
    },
  });

  const result = await checker('http://127.0.0.1:3080/', {
    runtime: { version: '0.1.1-rc.2' },
    phase: 'post_activation_update_health',
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});
