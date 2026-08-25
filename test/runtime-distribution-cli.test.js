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
const { createFileCandidateStore } = require('../scripts/runtime-distribution/candidate-store');
const { validateStableIndex } = require('../scripts/runtime-distribution/stable-index');

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
  try {
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
    const events = [];
    const actualStore = createFileCandidateStore({ root: path.join(root, 'candidates'), now: () => '2026-08-25T00:00:00.000Z' });
    fixture.candidateStore = {
      async publish(candidate) {
        events.push(`candidate-publish:${candidate.version}`);
        return actualStore.publish(candidate);
      },
      async read(version) {
        events.push(`candidate-read:${version}`);
        return actualStore.read(version);
      },
    };
    const indexPath = path.join(root, 'runtime', 'stable', 'runtime-index.json');
    fixture.indexPublication = {
      indexPath,
      historyDirectory: path.join(root, 'runtime', 'history'),
      async read() {
        let value;
        try {
          value = JSON.parse(await fs.readFile(indexPath, 'utf8'));
        } catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
        events.push('stable-index-read');
        return value;
      },
      validate(value) {
        events.push('stable-index-validate');
        return validateStableIndex(value);
      },
    };
    fixture.remoteVerification = async ({ candidate }) => {
      events.push(`remote-verify:${candidate.version}`);
      return { status: 'REMOTE_VERIFIED', observedSize: candidate.sizeBytes, sha256: candidate.sha256 };
    };
    let factoryCalls = 0;
    let npmCalls = 0;
    fixture.factory = { async buildCandidate() { factoryCalls += 1; } };
    fixture.npmInstaller = {
      async install() { npmCalls += 1; throw new Error('npm installer must not run'); },
      getCallCount() { return npmCalls; },
    };

    const result = await runDryRun({
      root,
      fixture,
      now: () => '2026-08-25T00:00:00.000Z',
      logger: { log() {}, warn() {} },
    });

    assert.equal(result.candidatePublishStatus, 'PUBLISHED');
    assert.equal(result.upstreamLatest, '0.1.1-rc.2');
    assert.equal(result.candidateVersion, '0.1.1-rc.2');
    assert.equal(result.remoteStatus, 'REMOTE_VERIFIED');
    assert.equal(result.stableVersion, '0.1.1-rc.2');
    assert.equal(result.rollbackVersion, '0.1.0-rc.7');
    assert.equal(result.npmInstallCalls, 0);
    assert.equal(npmCalls, 0);
    assert.equal(factoryCalls, 0);

    const firstPublish = events.indexOf('candidate-publish:0.1.1-rc.2');
    const firstReadback = events.indexOf('candidate-read:0.1.1-rc.2', firstPublish + 1);
    const firstRemote = events.indexOf('remote-verify:0.1.1-rc.2');
    const firstIndexRead = events.indexOf('stable-index-read');
    const firstIndexValidate = events.indexOf('stable-index-validate');
    assert(firstPublish >= 0 && firstReadback > firstPublish);
    assert(firstRemote > firstReadback);
    assert(firstIndexRead > firstRemote);
    assert(firstIndexValidate > firstIndexRead);
    assert(events.indexOf('candidate-read:0.1.1-rc.2', firstRemote + 1) > firstRemote);
    assert(events.indexOf('candidate-read:0.1.0-rc.7') >= 0);
    const rollbackPublish = events.indexOf('candidate-publish:0.1.0-rc.7');
    const rollbackRead = events.indexOf('candidate-read:0.1.0-rc.7', rollbackPublish + 1);
    const rollbackRemote = events.indexOf('remote-verify:0.1.0-rc.7');
    assert(rollbackRead > rollbackPublish && rollbackRead < rollbackRemote);
    assert.deepEqual(events.filter(event => event.startsWith('remote-verify:')), [
      'remote-verify:0.1.1-rc.2',
      'remote-verify:0.1.0-rc.7',
    ]);

    const historyDirectory = path.join(root, 'runtime', 'history');
    const candidateHistoryPath = path.join(historyDirectory, '2026-08-25T00-00-00-000Z-0.1.1-rc.2.json');
    const rollbackHistoryPath = path.join(historyDirectory, '2026-08-25T00-00-00-000Z-0.1.0-rc.7.json');
    assert.deepEqual(JSON.parse(await fs.readFile(candidateHistoryPath, 'utf8')).artifacts[0].version, '0.1.1-rc.2');
    assert.deepEqual(JSON.parse(await fs.readFile(rollbackHistoryPath, 'utf8')).artifacts[0].version, '0.1.0-rc.7');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('second dry run is ALREADY_PUBLISHED and remains a no-op without Factory or npm calls', async () => {
  const root = await makeFixtureRoot();
  try {
    const fixture = makeFixture();
    let factoryCalls = 0;
    let npmCalls = 0;
    const publishAttempts = [];
    const publishStatuses = [];
    const remoteCalls = [];
    const actualStore = createFileCandidateStore({ root: path.join(root, 'candidates'), now: () => '2026-08-25T00:00:00.000Z' });
    fixture.factory = { async buildCandidate() { factoryCalls += 1; } };
    fixture.npmInstaller = { async install() { npmCalls += 1; }, getCallCount() { return npmCalls; } };
    fixture.candidateStore = {
      async publish(candidate) {
        publishAttempts.push(candidate.version);
        const result = await actualStore.publish(candidate);
        publishStatuses.push({ version: candidate.version, status: result.status });
        return result;
      },
      read: actualStore.read,
    };
    fixture.remoteVerification = async ({ candidate }) => {
      remoteCalls.push(candidate.version);
      return { status: 'REMOTE_VERIFIED', observedSize: candidate.sizeBytes, sha256: candidate.sha256 };
    };
    const first = await runDryRun({ root, fixture, now: () => '2026-08-25T00:00:00.000Z', logger: { log() {} } });
    const second = await runDryRun({ root, fixture, now: () => '2026-08-25T00:00:00.000Z', logger: { log() {} } });
    assert.equal(first.candidatePublishStatus, 'PUBLISHED');
    assert.equal(second.candidatePublishStatus, 'ALREADY_PUBLISHED');
    assert.deepEqual(publishAttempts.filter(version => version === '0.1.1-rc.2'), ['0.1.1-rc.2', '0.1.1-rc.2']);
    assert.deepEqual(publishStatuses.filter(entry => entry.version === '0.1.1-rc.2').map(entry => entry.status), ['PUBLISHED', 'ALREADY_PUBLISHED']);
    assert.deepEqual(remoteCalls, [
      '0.1.1-rc.2', '0.1.0-rc.7',
      '0.1.1-rc.2', '0.1.0-rc.7',
    ]);
    assert.equal(factoryCalls, 0);
    assert.equal(npmCalls, 0);
    assert.equal(second.npmInstallCalls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('detect does not invoke Factory when the upstream version is already known', async () => {
  const root = await makeFixtureRoot();
  try {
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
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('detect rejects a malformed registry adapter response', async () => {
  const root = await makeFixtureRoot();
  try {
    await assert.rejects(() => detect({
      root,
      registry: { readLatest: async () => ({ distTags: {} }) },
      sourceMapping: {},
      factory: {},
      candidateStore: { read: async () => null },
      indexPublication: { read: async () => null },
    }), error => error.code === 'DISTRIBUTION_REGISTRY_RESPONSE_INVALID');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
