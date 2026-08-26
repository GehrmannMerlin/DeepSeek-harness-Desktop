'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const { RuntimeArtifactDownloader } = require('../src/update/runtime-artifact-downloader');
const { verifyRuntime } = require('../src/update/runtime-verifier');
const { createZip } = require('../scripts/build-verified-runtime-artifact');
const { withTempDir } = require('./test-helpers');
const { createPackageTree, writeJson } = require('./test-helpers');

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}/runtime.zip`;
}

function validArtifact(url, body) {
  return {
    packageName: '@deepseek-ai/dsh',
    version: '0.1.0-rc.7',
    platform: 'win32',
    arch: 'x64',
    artifactUrl: url,
    sizeBytes: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    manifest: { schemaVersion: 1, packageName: '@deepseek-ai/dsh', version: '0.1.0-rc.7', platform: 'win32', arch: 'x64', cliEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js' },
  };
}

test('streams, hashes, renames, and extracts a verified artifact', async () => {
  await withTempDir(async (root) => {
    const body = Buffer.from('test-runtime-zip');
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-length': body.length });
      response.end(body);
    });
    try {
      const artifact = validArtifact(serverUrl(server), body);
      const downloader = RuntimeArtifactDownloader({
        extractArchive: async ({ archivePath, extractionRoot }) => {
          assert.equal(await fs.readFile(archivePath, 'utf8'), body.toString());
          await fs.mkdir(path.join(extractionRoot, 'runtime'), { recursive: true });
          return path.join(extractionRoot, 'runtime');
        },
      });
      const result = await downloader.prepare({ artifact, stagingRoot: root, operationId: 'op-1' });

      assert.equal(result.rootPath, path.join(root, 'op-1', 'runtime'));
      assert.equal(await fs.readFile(path.join(root, 'op-1', 'artifact.zip'), 'utf8'), body.toString());
      await assert.rejects(fs.access(path.join(root, 'op-1', 'artifact.zip.part')));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('follows a bounded HTTPS-compatible redirect before hashing the artifact', async () => {
  await withTempDir(async (root) => {
    const body = Buffer.from('redirected-runtime-zip');
    const server = await startServer((request, response) => {
      if (request.url === '/runtime.zip') {
        response.writeHead(302, { location: '/asset/runtime.zip' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-length': body.length, 'content-type': 'application/zip' });
      response.end(body);
    });
    try {
      const artifact = validArtifact(serverUrl(server), body);
      const downloader = RuntimeArtifactDownloader({
        extractArchive: async ({ archivePath, extractionRoot }) => {
          assert.equal(await fs.readFile(archivePath, 'utf8'), body.toString());
          await fs.mkdir(path.join(extractionRoot, 'runtime'), { recursive: true });
          return path.join(extractionRoot, 'runtime');
        },
      });
      const result = await downloader.prepare({ artifact, stagingRoot: root, operationId: 'op-redirect' });

      assert.equal(result.artifact.version, artifact.version);
      assert.equal(await fs.readFile(path.join(root, 'op-redirect', 'artifact.zip'), 'utf8'), body.toString());
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('rejects a hash mismatch and cleans the partial artifact', async () => {
  await withTempDir(async (root) => {
    const body = Buffer.from('not-the-published-bytes');
    const server = await startServer((_request, response) => response.end(body));
    try {
      const artifact = validArtifact(serverUrl(server), body);
      artifact.sha256 = 'c'.repeat(64);
      const downloader = RuntimeArtifactDownloader({ extractArchive: async () => { throw new Error('must not extract'); } });
      await assert.rejects(downloader.prepare({ artifact, stagingRoot: root, operationId: 'op-2' }), /sha-256|hash/i);
      await assert.rejects(fs.access(path.join(root, 'op-2', 'artifact.zip.part')));
      await assert.rejects(fs.access(path.join(root, 'op-2', 'artifact.zip')));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('extracts a real ZIP and preserves the verifier contract', async () => {
  await withTempDir(async (root) => {
    const sourceRoot = path.join(root, 'source');
    const archivePath = path.join(root, 'runtime.zip');
    await createPackageTree(sourceRoot, { version: '0.1.0-rc.7', cliRelativePath: 'lib/bin.js' });
    await writeJson(path.join(sourceRoot, 'runtime-manifest.json'), {
      schemaVersion: 1,
      packageName: '@deepseek-ai/dsh',
      version: '0.1.0-rc.7',
      platform: 'win32',
      arch: 'x64',
      cliEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
    });
    await createZip(sourceRoot, archivePath);
    const body = await fs.readFile(archivePath);
    const server = await startServer((_request, response) => response.end(body));
    try {
      const artifact = validArtifact(serverUrl(server), body);
      const downloader = RuntimeArtifactDownloader();
      const result = await downloader.prepare({ artifact, stagingRoot: root, operationId: 'op-real-zip' });
      const verification = await verifyRuntime({
        rootPath: result.rootPath,
        expectedVersion: '0.1.0-rc.7',
        nodeCommand: process.execPath,
        runCommand: async () => ({ code: 0, stdout: 'dsh 0.1.0-rc.7\n', stderr: '' }),
      });
      assert.equal(verification.ok, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
