'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const http = require('node:http');
const path = require('node:path');
const semver = require('semver');
const test = require('node:test');

const { createRuntimeDescriptor } = require('../src/runtime/runtime-descriptor');
const { DshUpdateManager, STATES } = require('../src/update/dsh-update-manager');
const { RuntimeArtifactDownloader } = require('../src/update/runtime-artifact-downloader');
const { verifyRuntime } = require('../src/update/runtime-verifier');
const { createPackageTree, withTempDir } = require('./test-helpers');

const artifactPath = process.env.DSH_REAL_RUNTIME_ARTIFACT;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function descriptor(rootPath, version) {
  const cliEntry = path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return createRuntimeDescriptor({
    kind: 'managed',
    version,
    rootPath,
    packagePath: path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh'),
    cliEntry,
    args: [cliEntry],
    command: process.execPath,
    source: 'managed',
  });
}

test('real artifact HTTP download verifies and applies without npm installer', { skip: !artifactPath }, async () => {
  await withTempDir(async (root) => {
    const body = await fs.readFile(artifactPath);
    const sha256 = require('node:crypto').createHash('sha256').update(body).digest('hex');
    const version = '0.1.0-rc.7';
    const currentVersion = '0.1.0-rc.6';
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-length': body.length, 'content-type': 'application/zip' });
      response.end(body);
    });
    await listen(server);
    try {
      const artifact = {
        packageName: '@deepseek-ai/dsh', version, platform: 'win32', arch: 'x64',
        artifactUrl: `http://127.0.0.1:${server.address().port}/dsh.zip`,
        sizeBytes: body.length, sha256,
        manifest: { schemaVersion: 1, packageName: '@deepseek-ai/dsh', version, platform: 'win32', arch: 'x64', cliEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js' },
      };
      const currentRoot = path.join(root, 'current');
      await createPackageTree(currentRoot, { version: currentVersion, cliRelativePath: 'lib/bin.js' });
      const calls = [];
      let active = descriptor(currentRoot, currentVersion);
      const runtimeManager = {
        getRuntimeRoot: () => root,
        async resolveCurrentRuntime() { return active; },
        async getState() { return { failedVersions: {} }; },
        async promoteStaging(stagingRoot, promotedVersion) {
          calls.push(['promote', stagingRoot]);
          active = descriptor(stagingRoot, promotedVersion);
          return active;
        },
        async activateRuntime(runtime) { calls.push(['activate', runtime.version]); active = runtime; },
        async recordFailedVersion() {},
      };
      const processManager = {
        ownsHarness: () => true,
        getPid: () => 123,
        getUrl: () => 'http://127.0.0.1:3080/',
        async stop() { calls.push('stop'); },
        async start(runtime) { calls.push(['start', runtime.version]); return true; },
      };
      let installerCalls = 0;
      const manager = new DshUpdateManager({
        runtimeManager,
        registry: {
          async getLatest() { return { packageName: '@deepseek-ai/dsh', version, distTag: 'latest' }; },
          compareLatest(installed, latest) { return semver.gt(latest, installed) ? 'UPDATE_AVAILABLE' : 'UP_TO_DATE'; },
        },
        verifiedSource: { async getLatest() { return artifact; } },
        artifactDownloader: RuntimeArtifactDownloader(),
        installer: { async install() { installerCalls += 1; throw new Error('npm installer must not run'); } },
        verifier: { verify: verifyRuntime },
        processManager,
        healthChecker: { async waitUntilReady() { calls.push('health'); return { ok: true }; } },
        logger: { error() {}, warn() {} },
      });

      assert.equal((await manager.checkForUpdates()).state, STATES.UPDATE_AVAILABLE);
      const result = await manager.confirmUpdate();
      assert.equal(result.state, STATES.SUCCESS);
      assert.equal(installerCalls, 0);
      assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'promote'));
      assert.ok(calls.includes('health'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
