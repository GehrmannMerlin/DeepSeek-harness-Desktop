'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildStableIndex,
  validateStableIndex,
  writeStableIndexAtomic,
  promoteStable,
  rollbackStable,
} = require('../scripts/runtime-distribution/stable-index');
const { VerifiedRuntimeUpdateSource } = require('../src/update/verified-runtime-update-source');

const manifest = {
  schemaVersion: 1,
  packageName: '@deepseek-ai/dsh',
  version: '0.1.1-rc.2',
  platform: 'win32',
  arch: 'x64',
  cliEntry: 'runtime-root/apps/cli/dist/index.js',
};

function candidate(version = manifest.version, overrides = {}) {
  return {
    schemaVersion: 1,
    packageName: '@deepseek-ai/dsh',
    version,
    platform: 'win32',
    arch: 'x64',
    artifactUrl: `https://github.com/example/release/download/${version}/runtime.zip`,
    sizeBytes: 1234,
    sha256: 'a'.repeat(64),
    manifest: { ...manifest, version },
    provenance: { source: 'factory' },
    status: 'REMOTE_VERIFIED',
    ...overrides,
  };
}

function indexFor(value = candidate()) {
  return buildStableIndex({ candidate: value, artifactUrl: value.artifactUrl });
}

test('buildStableIndex creates exactly the current schema-v1 artifact contract', () => {
  const index = indexFor();
  assert.deepEqual(Object.keys(index).sort(), ['artifacts', 'schemaVersion']);
  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(Object.keys(index.artifacts[0]).sort(), [
    'arch', 'artifactUrl', 'manifest', 'packageName', 'platform', 'sha256', 'sizeBytes', 'version',
  ]);
  assert.equal(validateStableIndex(index).artifacts[0].sha256, 'a'.repeat(64));
});

test('schema-v1 stable index round trips through VerifiedRuntimeUpdateSource', async () => {
  const index = indexFor();
  const source = VerifiedRuntimeUpdateSource({ indexUrl: 'https://index.example/runtime-index.json', requestJson: async () => index });
  assert.deepEqual(await source.getLatest({ platform: 'win32', arch: 'x64' }), index.artifacts[0]);
});

test('validateStableIndex rejects malformed schema, missing artifacts, wrong target, and invalid entry data', () => {
  for (const invalid of [
    {},
    { schemaVersion: 2, artifacts: [] },
    { schemaVersion: 1 },
    { schemaVersion: 1, artifacts: [] },
    { schemaVersion: 1, artifacts: [candidate(undefined, { platform: 'linux' })] },
    { schemaVersion: 1, artifacts: [candidate(undefined, { arch: 'arm64' })] },
    { schemaVersion: 1, artifacts: [candidate(undefined, { artifactUrl: 'http://localhost/runtime.zip' })] },
    { schemaVersion: 1, artifacts: [candidate(undefined, { sizeBytes: 0 })] },
    { schemaVersion: 1, artifacts: [candidate(undefined, { sha256: 'not-a-hash' })] },
    { schemaVersion: 1, artifacts: [candidate(undefined, { manifest: { ...manifest, version: '0.1.1-rc.3' } })] },
  ]) {
    assert.throws(() => validateStableIndex(invalid, { platform: 'win32', arch: 'x64' }));
  }
});

test('buildStableIndex and validateStableIndex reject v-prefixed and non-canonical versions', () => {
  const prefixed = candidate('v0.1.1', { manifest: { ...manifest, version: 'v0.1.1' } });
  assert.throws(() => buildStableIndex({ candidate: prefixed, artifactUrl: prefixed.artifactUrl }));
  assert.throws(() => validateStableIndex({
    schemaVersion: 1,
    artifacts: [{
      packageName: prefixed.packageName,
      version: prefixed.version,
      platform: prefixed.platform,
      arch: prefixed.arch,
      artifactUrl: prefixed.artifactUrl,
      sizeBytes: prefixed.sizeBytes,
      sha256: prefixed.sha256,
      manifest: prefixed.manifest,
    }],
  }));
  assert.equal(buildStableIndex({ candidate: candidate('0.1.1'), artifactUrl: candidate('0.1.1').artifactUrl }).artifacts[0].version, '0.1.1');
});

test('writeStableIndexAtomic preserves the previous index when writing fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stable-index-'));
  const indexPath = path.join(root, 'runtime-index.json');
  const historyDirectory = path.join(root, 'history');
  await fs.writeFile(indexPath, '{"previous":true}\n');
  await fs.writeFile(historyDirectory, 'not a directory');
  await assert.rejects(() => writeStableIndexAtomic({
    indexPath,
    index: indexFor(),
    historyDirectory,
  }));
  assert.equal(await fs.readFile(indexPath, 'utf8'), '{"previous":true}\n');
});

test('history failure restores the previous index through a restore temp file and rename', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stable-index-'));
  const indexPath = path.join(root, 'runtime-index.json');
  const historyDirectory = path.join(root, 'history');
  const previous = '{"previous":"intact"}\n';
  await fs.writeFile(indexPath, previous);
  const renameCalls = [];
  const fileSystem = {
    ...require('node:fs/promises'),
    async open(filePath, flags) {
      if (filePath === indexPath) throw new Error('direct index restoration is not atomic');
      return require('node:fs/promises').open(filePath, flags);
    },
    async mkdir(directory, options) {
      if (directory === historyDirectory) throw new Error('injected history publication failure');
      return require('node:fs/promises').mkdir(directory, options);
    },
    async rename(source, destination) {
      renameCalls.push({ source, destination });
      return require('node:fs/promises').rename(source, destination);
    },
  };
  await assert.rejects(() => writeStableIndexAtomic({ indexPath, index: indexFor(), historyDirectory, fileSystem }));
  assert.equal(await fs.readFile(indexPath, 'utf8'), previous);
  assert.equal(renameCalls.filter(call => call.destination === indexPath).length, 2);
  assert(renameCalls[1].source.includes('.restore-'));
});

test('writeStableIndexAtomic renames a complete JSON file before writing history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stable-index-'));
  const indexPath = path.join(root, 'runtime-index.json');
  const result = await writeStableIndexAtomic({ indexPath, index: indexFor(), historyDirectory: path.join(root, 'history'), now: () => '2026-08-25T00:00:00.000Z' });
  assert.equal(await fs.readFile(indexPath, 'utf8'), `${JSON.stringify(indexFor(), null, 2)}\n`);
  assert.equal(path.basename(result.historyPath), '2026-08-25T00-00-00-000Z-0.1.1-rc.2.json');
  assert.equal((await fs.readdir(path.join(root, 'history'))).length, 1);
});

test('promoteStable remotely verifies before publishing and never invokes a build callback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stable-index-'));
  const value = candidate();
  const calls = [];
  const result = await promoteStable({
    candidateStore: { read: async version => version === value.version ? value : null },
    candidateVersion: value.version,
    remoteVerifier: async ({ candidate: candidateValue }) => { calls.push(candidateValue.version); return { status: 'REMOTE_VERIFIED' }; },
    indexPath: path.join(root, 'runtime-index.json'),
    historyDirectory: path.join(root, 'history'),
    build: () => { throw new Error('Factory must not be called'); },
  });
  assert.deepEqual(calls, [value.version]);
  assert.equal(result.version, value.version);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'runtime-index.json'))), result.index);
});

test('promotion rejects missing candidates and remote failures without changing the stable index', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stable-index-'));
  const indexPath = path.join(root, 'runtime-index.json');
  await fs.writeFile(indexPath, '{"stable":"old"}\n');
  await assert.rejects(() => promoteStable({ candidateStore: { read: async () => null }, candidateVersion: '0.1.1-rc.2', remoteVerifier: async () => ({ status: 'REMOTE_VERIFIED' }), indexPath, historyDirectory: path.join(root, 'history') }));
  await assert.rejects(() => promoteStable({ candidateStore: { read: async () => candidate() }, candidateVersion: '0.1.1-rc.2', remoteVerifier: async () => { throw new Error('not verified'); }, indexPath, historyDirectory: path.join(root, 'history') }));
  assert.equal(await fs.readFile(indexPath, 'utf8'), '{"stable":"old"}\n');
});

test('rollbackStable uses the same verified promotion path for an existing candidate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stable-index-'));
  const value = candidate('0.1.0-rc.7');
  let verified = false;
  const result = await rollbackStable({
    candidateStore: { read: async version => version === value.version ? value : null },
    targetVersion: value.version,
    remoteVerifier: async () => { verified = true; return { status: 'REMOTE_VERIFIED' }; },
    indexPath: path.join(root, 'runtime-index.json'),
    historyDirectory: path.join(root, 'history'),
  });
  assert.equal(verified, true);
  assert.equal(result.version, value.version);
});
