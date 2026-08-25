'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  verifyRemoteCandidate,
} = require('../scripts/runtime-distribution/remote-verification');

const VERSION = '0.1.1-rc.2';
const BODY = Buffer.from('remote-runtime-zip');
const SHA256 = crypto.createHash('sha256').update(BODY).digest('hex');

function makeCandidate(overrides = {}) {
  return {
    packageName: '@deepseek-ai/dsh',
    version: VERSION,
    platform: 'win32',
    arch: 'x64',
    artifactUrl: 'https://github.com/example/repo/releases/download/dsh-runtime-v0.1.1-rc.2/runtime.zip',
    sizeBytes: BODY.length,
    sha256: SHA256,
    manifest: {
      schemaVersion: 1,
      packageName: '@deepseek-ai/dsh',
      version: VERSION,
      platform: 'win32',
      arch: 'x64',
      cliEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
    },
    ...overrides,
  };
}

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dsh-remote-verification-'));
}

function downloadBody(result = {}) {
  return async (_url, destination) => {
    await fs.writeFile(destination, BODY);
    return {
      statusCode: 200,
      contentLength: BODY.length,
      sizeBytes: BODY.length,
      sha256: SHA256,
      durationMs: 5,
      ...result,
    };
  };
}

async function runSuccess(overrides = {}) {
  const tempRoot = await makeRoot();
  const calls = [];
  try {
    const result = await verifyRemoteCandidate({
      candidate: makeCandidate(),
      download: downloadBody(),
      extractZip: async (options) => { calls.push(['extract', options]); return options.extractionRoot; },
      verifyRuntime: async (options) => { calls.push(['verify', options]); return { ok: true, reason: null }; },
      smoke: async (options) => { calls.push(['smoke', options]); return { ok: true, web: { ok: true }, native: { ok: true } }; },
      tempRoot,
      ...overrides,
    });
    return { result, calls, tempRoot };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

test('public HTTPS readback extracts, verifies, smokes, and returns the remote verification contract', async () => {
  const { result, calls, tempRoot } = await runSuccess();
  try {
    assert.equal(result.status, 'REMOTE_VERIFIED');
    assert.equal(result.observedSize, BODY.length);
    assert.equal(result.sha256, SHA256);
    assert.equal(typeof result.durationMs, 'number');
    assert.deepEqual(result.verification, { ok: true, reason: null });
    assert.deepEqual(calls.map(([name]) => name), ['extract', 'verify', 'smoke']);
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});

test('rejects HTTP 404 before extraction', async () => {
  const tempRoot = await makeRoot();
  let extracted = false;
  try {
    await assert.rejects(() => verifyRemoteCandidate({
      candidate: makeCandidate(),
      download: async () => ({ statusCode: 404, contentLength: 0, sizeBytes: 0, sha256: '', durationMs: 1 }),
      extractZip: async () => { extracted = true; },
      verifyRuntime: async () => ({ ok: true }), smoke: async () => ({ ok: true }), tempRoot,
    }), error => error.code === 'REMOTE_ARTIFACT_HTTP_STATUS');
    assert.equal(extracted, false);
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});

test('rejects timeout and cleans the task staging root', async () => {
  const tempRoot = await makeRoot();
  let archivePart;
  try {
    await assert.rejects(() => verifyRemoteCandidate({
      candidate: makeCandidate(),
      download: async (_url, destination) => { archivePart = destination; const error = new Error('timed out'); error.code = 'ETIMEDOUT'; throw error; },
      extractZip: async () => { throw new Error('must not extract'); },
      verifyRuntime: async () => ({ ok: true }), smoke: async () => ({ ok: true }), tempRoot,
    }), error => error.code === 'REMOTE_ARTIFACT_TIMEOUT');
    assert.equal(await fs.stat(tempRoot).then(() => true), true);
    await assert.rejects(fs.access(path.dirname(archivePart)));
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});

test('rejects Content-Length mismatch before extraction', async () => {
  const tempRoot = await makeRoot();
  try {
    await assert.rejects(() => verifyRemoteCandidate({
      candidate: makeCandidate(), download: downloadBody({ contentLength: BODY.length + 1 }),
      extractZip: async () => { throw new Error('must not extract'); },
      verifyRuntime: async () => ({ ok: true }), smoke: async () => ({ ok: true }), tempRoot,
    }), error => error.code === 'REMOTE_ARTIFACT_CONTENT_LENGTH_MISMATCH');
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});

test('remote hash mismatch never extracts or verifies the candidate', async () => {
  const tempRoot = await makeRoot();
  let extracted = false;
  try {
    await assert.rejects(() => verifyRemoteCandidate({
      candidate: makeCandidate(),
      download: downloadBody({ sha256: 'b'.repeat(64) }),
      extractZip: async () => { extracted = true; },
      verifyRuntime: async () => ({ ok: true }), smoke: async () => ({ ok: true }), tempRoot,
    }), error => error.code === 'REMOTE_ARTIFACT_HASH_MISMATCH');
    assert.equal(extracted, false);
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});

test('rejects expected size mismatch before extraction', async () => {
  const tempRoot = await makeRoot();
  try {
    await assert.rejects(() => verifyRemoteCandidate({
      candidate: makeCandidate({ sizeBytes: BODY.length + 1 }), download: downloadBody(),
      extractZip: async () => { throw new Error('must not extract'); },
      verifyRuntime: async () => ({ ok: true }), smoke: async () => ({ ok: true }), tempRoot,
    }), error => error.code === 'REMOTE_ARTIFACT_SIZE_MISMATCH');
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});

test('rejects invalid candidate identity before download or extraction with a stable coded error', async () => {
  const invalidCandidates = [
    makeCandidate({ version: 'not-semver' }),
    makeCandidate({ packageName: '@other/package' }),
    makeCandidate({ platform: 'linux' }),
    makeCandidate({ arch: 'arm64' }),
    makeCandidate({ sizeBytes: 0 }),
    makeCandidate({ sizeBytes: Number.MAX_SAFE_INTEGER + 1 }),
    makeCandidate({ sha256: 'bad-sha' }),
    makeCandidate({ manifest: { ...makeCandidate().manifest, version: '0.1.1-rc.3' } }),
  ];
  for (const candidate of invalidCandidates) {
    const tempRoot = await makeRoot();
    let downloads = 0;
    let extracted = 0;
    try {
      await assert.rejects(() => verifyRemoteCandidate({
        candidate,
        download: async () => { downloads += 1; return { statusCode: 200, contentLength: BODY.length, sizeBytes: BODY.length, sha256: SHA256, durationMs: 1 }; },
        extractZip: async () => { extracted += 1; },
        verifyRuntime: async () => ({ ok: true }), smoke: async () => ({ ok: true }), tempRoot,
      }), error => error.code === 'REMOTE_CANDIDATE_INVALID');
      assert.equal(downloads, 0);
      assert.equal(extracted, 0);
    } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
  }
});

test('rejects an invalid artifact URL with a coded verification error before download', async () => {
  const tempRoot = await makeRoot();
  let downloads = 0;
  try {
    await assert.rejects(() => verifyRemoteCandidate({
      candidate: makeCandidate({ artifactUrl: 'http://updates.example.test/runtime.zip' }),
      download: async () => { downloads += 1; return {}; },
      extractZip: async () => {}, verifyRuntime: async () => ({ ok: true }), smoke: async () => ({ ok: true }), tempRoot,
    }), error => error.code === 'REMOTE_ARTIFACT_URL_INVALID');
    assert.equal(downloads, 0);
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});

test('preserves a caller-owned tempRoot and sentinel on invalid candidate or URL preconditions', async () => {
  for (const [candidate, code] of [
    [makeCandidate({ sha256: 'not-a-sha' }), 'REMOTE_CANDIDATE_INVALID'],
    [makeCandidate({ artifactUrl: 'http://updates.example.test/runtime.zip' }), 'REMOTE_ARTIFACT_URL_INVALID'],
  ]) {
    const tempRoot = await makeRoot();
    const sentinel = path.join(tempRoot, 'caller-owned-sentinel.txt');
    await fs.writeFile(sentinel, 'must survive');
    try {
      await assert.rejects(() => verifyRemoteCandidate({
        candidate,
        download: async () => { throw new Error('must not download'); },
        extractZip: async () => { throw new Error('must not extract'); },
        verifyRuntime: async () => ({ ok: true }), smoke: async () => ({ ok: true }), tempRoot,
      }), error => error.code === code);
      assert.equal(await fs.readFile(sentinel, 'utf8'), 'must survive');
      assert.equal(await fs.stat(tempRoot).then(() => true), true);
    } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
  }
});

test('cleanup attempts every path and preserves the original verification error when rm fails', async (t) => {
  const tempRoot = await makeRoot();
  const rmCalls = [];
  const originalRm = fs.rm;
  t.mock.method(fs, 'rm', async (target, options) => {
    rmCalls.push({ target, options });
    if (rmCalls.length === 1) throw new Error('simulated cleanup failure');
    return originalRm(target, options);
  });
  try {
    await assert.rejects(() => verifyRemoteCandidate({
      candidate: makeCandidate(), download: async () => { throw Object.assign(new Error('download failed'), { code: 'REMOTE_DOWNLOAD_FAILED' }); },
      extractZip: async () => {}, verifyRuntime: async () => ({ ok: true }), smoke: async () => ({ ok: true }), tempRoot,
    }), error => error.code === 'REMOTE_DOWNLOAD_FAILED');
    assert.equal(rmCalls.length, 3);
    assert.equal(rmCalls[0].options.force, true);
    assert.equal(rmCalls[1].options.force, true);
    assert.equal(rmCalls[2].options.recursive, true);
    assert.notEqual(rmCalls.some(({ target }) => target === tempRoot), true);
  } finally {
    t.mock.restoreAll();
    await originalRm(tempRoot, { recursive: true, force: true });
  }
});

for (const [name, failure, code] of [
  ['unsafe ZIP', async () => { throw Object.assign(new Error('unsafe'), { code: 'ARCHIVE_ENTRY_UNSAFE' }); }, 'REMOTE_EXTRACTION_FAILED'],
  ['wrong manifest identity', async () => ({ ok: false, reason: 'manifest-mismatch' }), 'REMOTE_MANIFEST_MISMATCH'],
  ['CLI failure', async () => ({ ok: false, reason: 'cli-nonzero-exit' }), 'REMOTE_RUNTIME_VERIFICATION_FAILED'],
  ['Web/Health failure', async () => ({ ok: false, reason: 'web-health-failed' }), 'REMOTE_SMOKE_FAILED'],
  ['native failure', async () => ({ ok: false, reason: 'native-failed' }), 'REMOTE_SMOKE_FAILED'],
]) {
  test(`never returns REMOTE_VERIFIED for ${name}`, async () => {
    const tempRoot = await makeRoot();
    try {
      const options = {
        candidate: makeCandidate(), download: downloadBody(), extractZip: async ({ extractionRoot }) => extractionRoot,
        verifyRuntime: async () => ({ ok: true }), smoke: async () => ({ ok: true }), tempRoot,
      };
      if (name === 'unsafe ZIP') options.extractZip = failure;
      else if (name === 'wrong manifest identity') options.verifyRuntime = failure;
      else if (name === 'CLI failure') options.verifyRuntime = failure;
      else options.smoke = failure;
      await assert.rejects(() => verifyRemoteCandidate(options), error => error.code === code);
    } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
  });
}

test('rejects a nested structured smoke failure instead of returning REMOTE_VERIFIED', async () => {
  const tempRoot = await makeRoot();
  try {
    await assert.rejects(() => verifyRemoteCandidate({
      candidate: makeCandidate(), download: downloadBody(),
      extractZip: async ({ extractionRoot }) => extractionRoot,
      verifyRuntime: async () => ({ ok: true }),
      smoke: async () => ({ ok: true, web: { ok: false, reason: 'health-check-failed' }, health: { ok: true }, native: { ok: true } }),
      tempRoot,
    }), error => error.code === 'REMOTE_SMOKE_FAILED');
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});
