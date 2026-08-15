'use strict';
const http = require('http');
const { mark } = require('../utils/boot-timeline');

// A page is "really DeepSeek Harness" when it carries the boot payload that
// only dsh web injects. Port-open alone is not enough (the port could be held
// by any other program).
const SIGNATURES = ['window.__DSH_BOOT__', '<title>DeepSeek Harness</title>'];
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

async function check(url, { timeout = 1500 } = {}) {
  const res = await httpGet(url, timeout);
  if (res.error) return { ready: false, isHarness: false, status: null, error: res.error };
  const isHarness = res.status === 200 && looksLikeHarness(res.body);
  return { ready: isHarness, isHarness, status: res.status, error: null };
}

async function waitUntilReady(url, { interval = 800, timeout = 45000 } = {}) {
  const start = Date.now();
  mark('healthcheck_started', url);
  for (;;) {
    const r = await check(url);
    if (r.ready) { mark('healthcheck_first_success', `${Date.now() - start}ms`); return { ok: true, elapsed: Date.now() - start }; }
    if (Date.now() - start >= timeout) return { ok: false, elapsed: Date.now() - start };
    await new Promise((res) => setTimeout(res, interval));
  }
}

// Probe the default port: 'harness' (real dsh) | 'foreign' (something else
// holds it) | 'free' (nothing listening).
async function probe(port, { timeout = 1500 } = {}) {
  const r = await check(`http://127.0.0.1:${port}/`, { timeout });
  if (r.ready) return 'harness';
  if (r.error === 'ECONNREFUSED') return 'free';
  return 'foreign';
}

module.exports = { check, waitUntilReady, probe, looksLikeHarness, SIGNATURES };
