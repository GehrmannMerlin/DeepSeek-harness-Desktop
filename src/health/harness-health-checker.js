'use strict';
const http = require('http');
const { mark } = require('../utils/boot-timeline');

// A page is "really DeepSeek Harness" when it carries the boot payload that
// only dsh web injects. Port-open alone is not enough (the port could be held
// by any other program).
const SIGNATURES = [
  'window.__DSH_BOOT__',
  'globalThis["__DSH_BOOT__"]',
  '<title>DeepSeek Harness</title>',
];
const MAX_BODY = 8192;

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      req = http.get(url, { timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
          if (body.length > MAX_BODY) { req.destroy(); done({ status: res.statusCode, body }); }
        });
        res.on('end', () => done({ status: res.statusCode, body }));
        res.on('error', (e) => done({ error: e.code || e.message }));
      });
    } catch (e) {
      return done({ error: e.code || e.message });
    }
    req.on('timeout', () => { req.destroy(); done({ error: 'timeout' }); });
    req.on('error', (e) => done({ error: e.code || e.message }));
  });
}

function looksLikeHarness(body) {
  return SIGNATURES.some((s) => (body || '').includes(s));
}

async function check(url, { timeout = 1500, transport = httpGet } = {}) {
  const res = await transport(url, timeout);
  if (res.error) return { ready: false, isHarness: false, status: null, error: res.error };
  const isHarness = res.status === 200 && looksLikeHarness(res.body);
  return { ready: isHarness, isHarness, status: res.status, error: null };
}

async function waitUntilReady(url, {
  interval = 800,
  timeout = 45000,
  checkFn = check,
  transport = httpGet,
} = {}) {
  const start = Date.now();
  mark('healthcheck_started', url);
  for (;;) {
    const remaining = Math.max(1, timeout - (Date.now() - start));
    const r = await checkFn(url, {
      timeout: Math.min(1500, remaining),
      transport,
    });
    if (r.ready) { mark('healthcheck_first_success', `${Date.now() - start}ms`); return { ok: true, elapsed: Date.now() - start }; }
    if (Date.now() - start >= timeout) return { ok: false, elapsed: Date.now() - start };
    await new Promise((res) => setTimeout(res, interval));
  }
}

function createReleaseE2eHealthChecker({ env = process.env, realChecker = waitUntilReady } = {}) {
  const enabled = env && env.DSH_RELEASE_E2E === '1';
  const targetVersion = env && env.DSH_RELEASE_E2E_FAIL_HEALTH_VERSION;
  let failureConsumed = false;

  return async function releaseE2eHealthChecker(url, options = {}) {
    const runtimeVersion = options.runtime && options.runtime.version;
    if (!failureConsumed && enabled && targetVersion &&
        runtimeVersion === targetVersion &&
        options.phase === 'post_activation_update_health') {
      failureConsumed = true;
      return { ok: false, elapsed: 0, controlledFailure: true };
    }
    return realChecker(url, options);
  };
}

// Probe the default port: 'harness' (real dsh) | 'foreign' (something else
// holds it) | 'free' (nothing listening).
async function probe(port, { timeout = 1500 } = {}) {
  const r = await check(`http://127.0.0.1:${port}/`, { timeout });
  if (r.ready) return 'harness';
  if (r.error === 'ECONNREFUSED') return 'free';
  return 'foreign';
}

module.exports = {
  check,
  waitUntilReady,
  createReleaseE2eHealthChecker,
  probe,
  looksLikeHarness,
  SIGNATURES,
};
