'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  readUpstreamLatest,
  resolveExactSourceTag,
  assertSourcePackageIdentity,
  createSourceMapping,
} = require('../scripts/runtime-distribution/source-mapping');

const VERSION = '0.1.1-rc.2';
const INTEGRITY = 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e';

function npmMetadata(version = VERSION, overrides = {}) {
  return {
    name: '@deepseek-ai/dsh',
    'dist-tags': { latest: version },
    versions: {
      [version]: { name: '@deepseek-ai/dsh', version, dist: { integrity: INTEGRITY } },
    },
    ...overrides,
  };
}

test('reads npm latest and exact dist integrity from the matching version', async () => {
  let requestedEndpoint;
  const result = await readUpstreamLatest({
    requestJson: async (endpoint) => {
      requestedEndpoint = endpoint;
      return npmMetadata();
    },
  });

  assert.equal(requestedEndpoint, 'https://registry.npmjs.org/@deepseek-ai%2fdsh');
  assert.deepEqual(result, { version: VERSION, distIntegrity: INTEGRITY, metadata: npmMetadata() });
});

test('rejects missing or invalid npm latest metadata', async () => {
  await assert.rejects(
    () => readUpstreamLatest({ requestJson: async () => ({ name: '@deepseek-ai/dsh', versions: {} }) }),
    error => error.code === 'SOURCE_MAPPING_NOT_AVAILABLE',
  );
  await assert.rejects(
    () => readUpstreamLatest({ requestJson: async () => npmMetadata('not-a-version') }),
    error => error.code === 'SOURCE_MAPPING_NOT_AVAILABLE',
  );
  await assert.rejects(
    () => readUpstreamLatest({ requestJson: async () => ({ ...npmMetadata(), versions: { [VERSION]: { dist: {} } } }) }),
    error => error.code === 'SOURCE_MAPPING_NOT_AVAILABLE',
  );
});

test('resolves the exact source tag', async () => {
  let requestedRepository;
  const result = await resolveExactSourceTag({
    version: VERSION,
    lsRemote: async (repository) => {
      requestedRepository = repository;
      return `${COMMIT} refs/tags/dsh-v${VERSION}\n`;
    },
  });

  assert.equal(requestedRepository, 'https://github.com/deepseek-ai/deepseek-harness.git');
  assert.deepEqual(result, { tag: `dsh-v${VERSION}`, commit: COMMIT });
});

test('uses the peeled commit for an annotated exact source tag', async () => {
  const tagObject = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const result = await resolveExactSourceTag({
    version: VERSION,
    lsRemote: async () => `${tagObject} refs/tags/dsh-v${VERSION}\n${COMMIT} refs/tags/dsh-v${VERSION}^{}\n`,
  });

  assert.deepEqual(result, { tag: `dsh-v${VERSION}`, commit: COMMIT });
});

test('missing exact source tag stops candidate mapping with no master fallback', async () => {
  let queried = '';
  const source = createSourceMapping({
    requestJson: async () => npmMetadata('0.1.1-rc.3'),
    lsRemote: async (repository) => {
      queried = repository;
      return `${COMMIT} refs/tags/dsh-v${VERSION}\n${COMMIT} refs/heads/master\n`;
    },
  });

  await assert.rejects(() => source.resolveTag('0.1.1-rc.3'), error => error.code === 'SOURCE_MAPPING_NOT_AVAILABLE');
  assert.equal(queried, 'https://github.com/deepseek-ai/deepseek-harness.git');
});

test('rejects a wrong source package name or version', () => {
  assert.deepEqual(assertSourcePackageIdentity({ packageJson: { name: '@deepseek-ai/dsh', version: VERSION }, version: VERSION }), {
    name: '@deepseek-ai/dsh',
    version: VERSION,
  });
  assert.throws(() => assertSourcePackageIdentity({ packageJson: { name: 'other-package', version: VERSION }, version: VERSION }), error => error.code === 'SOURCE_PACKAGE_IDENTITY_MISMATCH');
  assert.throws(() => assertSourcePackageIdentity({ packageJson: { name: '@deepseek-ai/dsh', version: '0.1.0' }, version: VERSION }), error => error.code === 'SOURCE_PACKAGE_IDENTITY_MISMATCH');
});

test('createSourceMapping injects all deterministic adapters', async () => {
  const source = createSourceMapping({
    requestJson: async () => npmMetadata(),
    lsRemote: async () => `${COMMIT} refs/tags/dsh-v${VERSION}\n`,
    readJson: async () => ({ name: '@deepseek-ai/dsh', version: VERSION }),
  });

  assert.equal((await source.readLatest()).version, VERSION);
  assert.equal((await source.resolveTag(VERSION)).commit, COMMIT);
  assert.deepEqual(await source.verifyPackage('package.json', VERSION), { name: '@deepseek-ai/dsh', version: VERSION });
});
