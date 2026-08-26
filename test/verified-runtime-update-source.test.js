'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { VerifiedRuntimeUpdateSource } = require('../src/update/verified-runtime-update-source');

function indexWith(entries) {
  return { schemaVersion: 1, artifacts: entries };
}

function entry(version, overrides = {}) {
  return {
    packageName: '@deepseek-ai/dsh',
    version,
    platform: 'win32',
    arch: 'x64',
    artifactUrl: `https://updates.example.test/dsh-${version}.zip`,
    sizeBytes: 10,
    sha256: 'b'.repeat(64),
    manifest: {
      schemaVersion: 1,
      packageName: '@deepseek-ai/dsh',
      version,
      platform: 'win32',
      arch: 'x64',
      cliEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
    },
    ...overrides,
  };
}

test('loads the highest verified version for the exact target', async () => {
  const source = VerifiedRuntimeUpdateSource({
    indexUrl: 'https://updates.example.test/runtime-index.json',
    requestJson: async () => indexWith([
      entry('0.1.0-rc.7'),
      entry('0.1.0-rc.8'),
      entry('0.1.0-rc.9', { platform: 'linux' }),
    ]),
  });

  const latest = await source.getLatest({ platform: 'win32', arch: 'x64' });
  assert.equal(latest.version, '0.1.0-rc.8');
  assert.equal(latest.platform, 'win32');
  assert.equal(latest.arch, 'x64');
  assert.equal(source.isConfigured(), true);
});

test('uses a production-safe default timeout for cold HTTPS index latency', async () => {
  let observedTimeoutMs;
  const source = VerifiedRuntimeUpdateSource({
    indexUrl: 'https://gehrmannmerlin.github.io/DeepSeek-harness-Desktop/runtime/stable/runtime-index.json',
    requestJson: async (_url, timeoutMs) => {
      observedTimeoutMs = timeoutMs;
      return indexWith([entry('0.1.1-rc.2')]);
    },
  });

  await source.getLatest({ platform: 'win32', arch: 'x64' });

  assert.equal(observedTimeoutMs, 15_000);
});

test('missing index URL is an explicit safe unavailable condition', async () => {
  const source = VerifiedRuntimeUpdateSource({ indexUrl: '' });

  assert.equal(source.isConfigured(), false);
  await assert.rejects(
    source.getLatest({ platform: 'win32', arch: 'x64' }),
    (error) => error.code === 'VERIFIED_RUNTIME_SOURCE_NOT_CONFIGURED',
  );
});

test('malformed index URL is a controlled configuration error', async () => {
  const source = VerifiedRuntimeUpdateSource({ indexUrl: 'not a URL' });

  assert.equal(source.isConfigured(), true);
  await assert.rejects(
    source.getLatest({ platform: 'win32', arch: 'x64' }),
    (error) => error.code === 'VERIFIED_RUNTIME_SOURCE_INVALID',
  );
});

test('unreachable configured source remains a controlled source error', async () => {
  const source = VerifiedRuntimeUpdateSource({
    indexUrl: 'https://updates.example.test/runtime-index.json',
    requestJson: async () => {
      const error = new Error('offline');
      error.code = 'ECONNREFUSED';
      throw error;
    },
  });

  await assert.rejects(
    source.getLatest({ platform: 'win32', arch: 'x64' }),
    (error) => error.code === 'VERIFIED_RUNTIME_SOURCE_UNREACHABLE',
  );
});

test('fails closed when the index has no exact target', async () => {
  const source = VerifiedRuntimeUpdateSource({
    requestJson: async () => indexWith([entry('0.1.0-rc.8', { arch: 'arm64' })]),
  });

  await assert.rejects(source.getLatest({ platform: 'win32', arch: 'x64' }));
});

test('rejects malformed index JSON and schema', async () => {
  for (const payload of [null, {}, { schemaVersion: 2, artifacts: [] }]) {
    const source = VerifiedRuntimeUpdateSource({ requestJson: async () => payload });
    await assert.rejects(source.getLatest({ platform: 'win32', arch: 'x64' }));
  }
});
