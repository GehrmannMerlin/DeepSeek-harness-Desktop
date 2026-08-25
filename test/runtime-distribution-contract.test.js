'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeExactVersion,
  artifactFileName,
  candidateReleaseTag,
  assertTarget,
  assertProductionHttpsUrl,
  candidateIdentity,
  compareCandidateIdentity,
} = require('../scripts/runtime-distribution/distribution-contract');

test('accepts exact SemVer and preserves the normalized release version', () => {
  assert.equal(normalizeExactVersion('0.1.1-rc.2'), '0.1.1-rc.2');
});

for (const value of ['', 'v0.1.1-rc.2', '^0.1.1', '>=0.1.0', '0.1', 'not-semver']) {
  test(`rejects invalid exact version ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => normalizeExactVersion(value),
      (error) => error && error.code === 'DISTRIBUTION_INVALID_VERSION',
    );
  });
}

test('formats the distribution artifact filename', () => {
  assert.equal(
    artifactFileName({ version: '0.1.1-rc.2', platform: 'win32', arch: 'x64' }),
    'dsh-runtime-0.1.1-rc.2-win32-x64.zip',
  );
});

test('formats the candidate release tag', () => {
  assert.equal(candidateReleaseTag('0.1.1-rc.2'), 'dsh-runtime-v0.1.1-rc.2');
});

test('accepts only the Windows x64 distribution target', () => {
  assert.deepEqual(assertTarget({ platform: 'win32', arch: 'x64' }), {
    platform: 'win32',
    arch: 'x64',
  });
  assert.throws(() => assertTarget({ platform: 'linux', arch: 'x64' }));
  assert.throws(() => assertTarget({ platform: 'win32', arch: 'arm64' }));
});

test('accepts a production HTTPS URL', () => {
  assert.equal(
    assertProductionHttpsUrl('https://updates.example.test/releases/index.json'),
    'https://updates.example.test/releases/index.json',
  );
});

for (const url of [
  'http://updates.example.test/releases/index.json',
  'https://localhost/releases/index.json',
  'https://localhost./releases/index.json',
  'https://127.0.0.1/releases/index.json',
  'https://127.0.0.2/releases/index.json',
  'https://127.1.2.3/releases/index.json',
  'https://[::ffff:127.0.0.1]/releases/index.json',
  'https://[::1]/releases/index.json',
  'not a URL',
]) {
  test(`rejects non-production URL ${url}`, () => {
    assert.throws(() => assertProductionHttpsUrl(url));
  });
}

test('normalizes SHA-256 values and validates candidate size', () => {
  const identity = candidateIdentity({
    version: '0.1.1-rc.2',
    sha256: 'A'.repeat(64),
    sizeBytes: 10,
  });

  assert.deepEqual(identity, {
    version: '0.1.1-rc.2',
    sha256: 'a'.repeat(64),
    sizeBytes: 10,
  });
  assert.throws(() => candidateIdentity({ version: '0.1.1-rc.2', sha256: 'a', sizeBytes: 10 }));
  assert.throws(() => candidateIdentity({ version: '0.1.1-rc.2', sha256: 'a'.repeat(64), sizeBytes: 0 }));
});

test('same version and hash is already published while a different hash is a conflict', () => {
  const existing = candidateIdentity({ version: '0.1.1-rc.2', sha256: 'a'.repeat(64), sizeBytes: 10 });
  assert.equal(compareCandidateIdentity(existing, existing), 'ALREADY_PUBLISHED');
  assert.equal(compareCandidateIdentity(existing, {
    version: '0.1.1-rc.2', sha256: 'a'.repeat(64), sizeBytes: 20,
  }), 'ALREADY_PUBLISHED');
  assert.equal(compareCandidateIdentity(existing, {
    version: '0.1.1-rc.2', sha256: 'b'.repeat(64), sizeBytes: 10,
  }), 'HASH_CONFLICT');
});

test('a different version is a new candidate', () => {
  const existing = candidateIdentity({ version: '0.1.1-rc.1', sha256: 'a'.repeat(64), sizeBytes: 10 });
  const next = candidateIdentity({ version: '0.1.1-rc.2', sha256: 'a'.repeat(64), sizeBytes: 10 });
  assert.equal(compareCandidateIdentity(existing, next), 'NEW');
});
