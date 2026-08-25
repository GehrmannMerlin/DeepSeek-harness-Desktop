'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  detect,
  runDryRun,
} = require('../scripts/runtime-distribution/runtime-distribution-cli');

const PACKAGE_NAME = '@deepseek-ai/dsh';

function makeCandidate(version, bytes = Buffer.from(`runtime-${version}`)) {
  return {
    packageName: PACKAGE_NAME,
    version,
    platform: 'win32',
    arch: 'x64',
    artifactUrl: `https://github.com/example/releases/download/dsh-runtime-v${version}/dsh-runtime-${version}-win32-x64.zip`,
    sizeBytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    manifest: {
      schemaVersion: 1,
      packageName: PACKAGE_NAME,
      version,
      platform: 'win32',
      arch: 'x64',
      cliEntry: 'runtime-root/apps/cli/dist/index.js',
    },
    provenance: { source: 'deterministic-test-fixture', version },
    status: 'CANDIDATE_PUBLISHED',
  };
}

async function makeFixtureRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'runtime-distribution-cli-'));
}

function makeFixture() {
  return {
    upstreamLatest: { version: '0.1.1-rc.2', distIntegrity: 'sha512-fixture' },
    candidate: makeCandidate('0.1.1-rc.2'),
    rollbackCandidate: makeCandidate('0.1.0-rc.7'),
    sourceMapping: {
      async readLatest() { return this.latest; },
      latest: { version: '0.1.1-rc.2', distIntegrity: 'sha512-fixture' },
      async resolveTag(version) { return { tag: `dsh-v${version}`, commit: 'a'.repeat(40) }; },
      async verifyPackage(packageJson, version) { return { name: packageJson.name, version }; },
    },
    registry: {
      async readLatest() { return { version: '0.1.1-rc.2', distIntegrity: 'sha512-fixture' }; },
    },
    factory: {
      async buildCandidate() { throw new Error('Factory must not run for the deterministic fixture'); },
    },
    remoteVerification: async () => ({ status: 'REMOTE_VERIFIED', observedSize: 1, sha256: 'fixture' }),
  };
}

test('dry run publishes, promotes, reads back, and rolls back without npm install', async () => {
  const root = await makeFixtureRoot();
  const fixture = makeFixture();
  const candidateBytes = Buffer.from('candidate-runtime');
  const rollbackBytes = Buffer.from('rollback-runtime');
  fixture.candidate.sizeBytes = candidateBytes.length;
  fixture.candidate.sha256 = crypto.createHash('sha256').update(candidateBytes).digest('hex');
  fixture.rollbackCandidate.sizeBytes = rollbackBytes.length;
  fixture.rollbackCandidate.sha256 = crypto.createHash('sha256').update(rollbackBytes).digest('hex');
  fixture.writeCandidateAssets = async ({ candidate, destination }) => {
    const bytes = candidate.version === fixture.candidate.version ? candidateBytes : rollbackBytes;
    await fs.writeFile(destination, bytes);
  };

  const result = await runDryRun({
    root,
    fixture,
    now: () => '2026-08-25T00:00:00.000Z',
    logger: { log() {}, warn() {} },
  });

  assert.equal(result.upstreamLatest, '0.1.1-rc.2');
  assert.equal(result.candidateVersion, '0.1.1-rc.2');
  assert.equal(result.remoteStatus, 'REMOTE_VERIFIED');
  assert.equal(result.stableVersion, '0.1.1-rc.2');
  assert.equal(result.rollbackVersion, '0.1.0-rc.7');
  assert.equal(result.npmInstallCalls, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test('detect does not invoke Factory when the upstream version is already known', async () => {
  const root = await makeFixtureRoot();
  const fixture = makeFixture();
  let factoryCalls = 0;
  fixture.factory = { async buildCandidate() { factoryCalls += 1; } };

  const result = await detect({
    root,
    registry: fixture.registry,
    sourceMapping: fixture.sourceMapping,
    factory: fixture.factory,
    candidateStore: { read: async () => fixture.candidate },
    indexPublication: { read: async () => ({ schemaVersion: 1, artifacts: [fixture.candidate] }) },
  });

  assert.deepEqual(result, {
    upstreamLatest: '0.1.1-rc.2',
    candidateStatus: 'ALREADY_PUBLISHED',
    stableVersion: '0.1.1-rc.2',
  });
  assert.equal(factoryCalls, 0);
  await fs.rm(root, { recursive: true, force: true });
});
