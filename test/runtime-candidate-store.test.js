'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { artifactFileName } = require('../scripts/runtime-distribution/distribution-contract');
const { createFileCandidateStore } = require('../scripts/runtime-distribution/candidate-store');

const VERSION = '0.1.1-rc.2';
const MANIFEST = { packageName: '@deepseek-ai/dsh', version: VERSION, platform: 'win32', arch: 'x64' };
const PROVENANCE = { sourceTag: `dsh-v${VERSION}`, sourceCommit: 'a'.repeat(40), acceptance: { cli: 'PASS' } };

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dsh-candidate-store-'));
}

async function makeZip(root, contents = 'runtime bytes') {
  const source = path.join(root, `input-${crypto.createHash('sha1').update(contents).digest('hex')}.zip`);
  await fs.writeFile(source, contents);
  return source;
}

function candidate(zipPath, version = VERSION, status = 'REMOTE_VERIFIED') {
  const bytes = require('node:fs').readFileSync(zipPath);
  return {
    packageName: '@deepseek-ai/dsh', version, platform: 'win32', arch: 'x64',
    artifactUrl: `https://github.com/example/repo/releases/download/dsh-runtime-v${version}/${artifactFileName({ version, platform: 'win32', arch: 'x64' })}`,
    sizeBytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    manifest: { ...MANIFEST, version }, provenance: { ...PROVENANCE, sourceTag: `dsh-v${version}` }, status,
    zipPath,
  };
}

test('publishes an immutable candidate with all required files and an exact descriptor', async () => {
  const root = await makeRoot();
  try {
    const zipPath = await makeZip(root);
    const store = createFileCandidateStore({ root, now: () => '2026-08-25T00:00:00.000Z' });
    const input = candidate(zipPath);
    const result = await store.publish(input);
    const directory = path.join(root, `candidate-${VERSION}`);
    const zipName = artifactFileName(input);

    assert.equal(result.status, 'PUBLISHED');
    assert.deepEqual(result.candidate, {
      schemaVersion: 1, packageName: input.packageName, version: VERSION, platform: 'win32', arch: 'x64',
      artifactUrl: input.artifactUrl, sizeBytes: input.sizeBytes, sha256: input.sha256,
      manifest: input.manifest, provenance: input.provenance, status: input.status,
    });
    assert.deepEqual((await fs.readdir(directory)).sort(), [
      'candidate-runtime-index.json', `${zipName}.sha256`, 'factory-provenance.json', 'runtime-manifest.json', zipName,
    ].sort());
    assert.equal(await fs.readFile(path.join(directory, 'candidate-runtime-index.json'), 'utf8'), `${JSON.stringify(result.candidate, null, 2)}\n`);
    assert.deepEqual(await fs.readFile(path.join(directory, zipName)), await fs.readFile(zipPath));
    assert.equal(store.assetPath(VERSION), path.join(directory, zipName));
    assert.equal(await store.read(VERSION).then(value => JSON.stringify(value)), JSON.stringify(result.candidate));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('same version and SHA is an idempotent no-op', async () => {
  const root = await makeRoot();
  try {
    const zipPath = await makeZip(root);
    const store = createFileCandidateStore({ root });
    const input = candidate(zipPath);
    assert.equal((await store.publish(input)).status, 'PUBLISHED');
    assert.equal((await store.publish({ ...input, zipPath: await makeZip(root, 'same bytes') })).status, 'ALREADY_PUBLISHED');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('same version with a different SHA throws without overwriting the original ZIP', async () => {
  const root = await makeRoot();
  try {
    const firstZip = await makeZip(root, 'original bytes');
    const secondZip = await makeZip(root, 'replacement bytes');
    const store = createFileCandidateStore({ root });
    const first = candidate(firstZip);
    await store.publish(first);
    await assert.rejects(() => store.publish(candidate(secondZip)), error => error.code === 'CANDIDATE_HASH_CONFLICT');
    assert.equal(await fs.readFile(store.assetPath(VERSION), 'utf8'), 'original bytes');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('lists candidates in descending SemVer order', async () => {
  const root = await makeRoot();
  try {
    const zipPath = await makeZip(root);
    const store = createFileCandidateStore({ root });
    for (const version of ['0.1.0-rc.7', '0.1.1', '0.1.1-rc.2']) await store.publish(candidate(zipPath, version));
    assert.deepEqual((await store.list()).map(item => item.version), ['0.1.1', '0.1.1-rc.2', '0.1.0-rc.7']);
    assert.equal(await store.read('9.9.9'), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
