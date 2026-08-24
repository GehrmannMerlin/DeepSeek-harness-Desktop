'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { NpmRegistryUpdateSource } = require('../src/update/npm-registry-update-source');

const packageName = '@deepseek-ai/dsh';

function sourceWith(response) {
  return NpmRegistryUpdateSource({
    requestJson: async () => response,
    logger: { warn() {} },
  });
}

function registryResponse(version = '0.1.1') {
  return {
    name: packageName,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        dist: {
          integrity: 'sha512-example',
          tarball: `https://registry.npmjs.org/${packageName}/-/${packageName.split('/')[1]}-${version}.tgz`,
        },
      },
    },
  };
}

test('returns latest version and dist metadata', async () => {
  const source = sourceWith(registryResponse('0.1.1'));

  assert.deepEqual(await source.getLatest(), {
    packageName,
    version: '0.1.1',
    distTag: 'latest',
    integrity: 'sha512-example',
    tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.1.tgz',
  });
});

test('accepts latest prerelease', async () => {
  const source = sourceWith(registryResponse('0.1.1-rc.2'));

  assert.equal((await source.getLatest()).version, '0.1.1-rc.2');
});

for (const [reason, response] of [
  ['timeout', new Error('timeout')],
  ['http-500', new Error('npm registry returned HTTP 500')],
  ['invalid-json', new SyntaxError('invalid json')],
  ['wrong-package', { ...registryResponse(), name: '@other/package' }],
  ['invalid-semver', registryResponse('not-semver')],
]) {
  test(`rejects ${reason}`, async () => {
    const source = NpmRegistryUpdateSource({
      requestJson: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
      logger: { warn() {} },
    });

    await assert.rejects(source.getLatest());
  });
}

test('compares newer, equal, older, and invalid local versions', () => {
  const source = sourceWith(registryResponse('2.0.0'));

  assert.equal(source.compareLatest('1.9.9', '2.0.0'), 'UPDATE_AVAILABLE');
  assert.equal(source.compareLatest('2.0.0', '2.0.0'), 'UP_TO_DATE');
  assert.equal(source.compareLatest('2.1.0', '2.0.0'), 'AHEAD_OF_LATEST');
  assert.equal(source.compareLatest('not-semver', '2.0.0'), 'UPDATE_AVAILABLE');
});
