'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { check } = require('../src/health/harness-health-checker');

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
