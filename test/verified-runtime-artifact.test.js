'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  VerifiedRuntimeArtifact,
  validateArchiveEntry,
} = require('../src/runtime/verified-runtime-artifact');

const PACKAGE_NAME = '@deepseek-ai/dsh';

function validEntry(overrides = {}) {
  return {
    packageName: PACKAGE_NAME,
    version: '0.1.0-rc.7',
    platform: 'win32',
    arch: 'x64',
    artifactUrl: 'https://updates.example.test/dsh-0.1.0-rc.7-win32-x64.zip',
    sizeBytes: 1234,
    sha256: 'a'.repeat(64),
    manifest: {
      schemaVersion: 1,
      packageName: PACKAGE_NAME,
      version: '0.1.0-rc.7',
      platform: 'win32',
      arch: 'x64',
      cliEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
    },
    ...overrides,
  };
}

test('validates a verified runtime artifact entry for the requested target', () => {
  const artifact = VerifiedRuntimeArtifact.fromIndexEntry(validEntry(), {
    platform: 'win32',
    arch: 'x64',
  });

  assert.deepEqual(artifact, {
    packageName: PACKAGE_NAME,
    version: '0.1.0-rc.7',
    platform: 'win32',
    arch: 'x64',
    artifactUrl: 'https://updates.example.test/dsh-0.1.0-rc.7-win32-x64.zip',
    sizeBytes: 1234,
    sha256: 'a'.repeat(64),
    manifest: validEntry().manifest,
  });
});

for (const [label, overrides] of [
  ['missing sha256', { sha256: '' }],
  ['invalid size', { sizeBytes: 0 }],
  ['invalid semver', { version: 'not-semver' }],
  ['wrong package', { packageName: '@other/package' }],
  ['wrong platform', { platform: 'linux' }],
  ['wrong architecture', { arch: 'arm64' }],
  ['non-http artifact URL', { artifactUrl: 'file:///artifact.zip' }],
  ['manifest identity mismatch', { manifest: { ...validEntry().manifest, version: '0.1.0-rc.6' } }],
]) {
  test(`rejects ${label}`, () => {
    assert.throws(() => VerifiedRuntimeArtifact.fromIndexEntry(validEntry(overrides), {
      platform: 'win32',
      arch: 'x64',
    }));
  });
}

for (const entryName of [
  '../evil.txt',
  '/absolute/file.txt',
  'C:\\absolute\\file.txt',
  'nested/../../evil.txt',
]) {
  test(`rejects unsafe ZIP entry ${entryName}`, () => {
    assert.throws(() => validateArchiveEntry(entryName, 'C:\\tmp\\extract-root'));
  });
}

test('accepts a normalized ZIP entry under the extraction root', () => {
  assert.deepEqual(
    validateArchiveEntry('node_modules/@deepseek-ai/dsh/package.json', 'C:\\tmp\\extract-root'),
    'C:\\tmp\\extract-root\\node_modules\\@deepseek-ai\\dsh\\package.json',
  );
});
