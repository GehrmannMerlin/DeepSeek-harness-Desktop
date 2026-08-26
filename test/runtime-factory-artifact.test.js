'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const path = require('node:path');
const test = require('node:test');
const unzipper = require('unzipper');

const { buildVerifiedRuntimeArtifact, copyTree } = require('../scripts/build-verified-runtime-artifact');
const { withTempDir, writeJson } = require('./test-helpers');

test('factory creates a portable ZIP, index identity, and archive self-smoke', async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, 'source-runtime');
    await writeJson(path.join(source, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', bin: { dsh: 'lib/bin.js' } });
    await fs.mkdir(path.join(source, 'lib'), { recursive: true });
    await fs.writeFile(path.join(source, 'lib', 'bin.js'), '#!/usr/bin/env node\n', 'utf8');
    const output = path.join(root, 'artifacts');

    const result = await buildVerifiedRuntimeArtifact({
      sourceRuntimeRoot: source,
      outputDirectory: output,
      version: '0.1.0-rc.7',
      artifactUrl: 'https://updates.example.test/dsh-0.1.0-rc.7-win32-x64.zip',
      sourceRevision: '99f6f02fe',
      pnpmVersion: '11.7.0',
      runCommand: async (_command, args) => {
        assert.equal(args.at(-1), '--version');
        return { code: 0, stdout: 'dsh 0.1.0-rc.7\n', stderr: '' };
      },
      smokeImpl: async () => ({ web: 'passed', native: 'passed' }),
    });

    assert.equal(result.indexEntry.sizeBytes > 0, true);
    assert.match(result.indexEntry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.archiveMode, 'direct');
    for (const phase of ['preScanMs', 'materializationMs', 'zipMs', 'sha256Ms', 'independentExtractionMs', 'independentVerificationMs']) {
      assert.equal(typeof result.timings[phase], 'number', `missing timing ${phase}`);
      assert.equal(result.timings[phase] >= 0, true, `invalid timing ${phase}`);
    }
    const archive = await unzipper.Open.file(result.archivePath);
    const names = archive.files.map((file) => file.path);
    assert.ok(names.includes('runtime-manifest.json'));
    assert.ok(names.includes('node_modules/@deepseek-ai/dsh/package.json'));
    assert.ok(names.includes('node_modules/@deepseek-ai/dsh/lib/bin.js'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'runtime-index.json'), 'utf8')).artifacts, [result.indexEntry]);
  });
});

test('factory direct archive reports progress, disk snapshots, and zero full-tree copies', async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, 'source-runtime');
    await writeJson(path.join(source, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', bin: { dsh: 'lib/bin.js' } });
    await fs.mkdir(path.join(source, 'lib'), { recursive: true });
    await fs.writeFile(path.join(source, 'lib', 'bin.js'), '#!/usr/bin/env node\n', 'utf8');
    const progress = [];

    const result = await buildVerifiedRuntimeArtifact({
      sourceRuntimeRoot: source,
      outputDirectory: path.join(root, 'artifacts'),
      version: '0.1.0-rc.7',
      artifactUrl: 'https://updates.example.test/dsh-0.1.0-rc.7-win32-x64.zip',
      onProgress: (event) => progress.push(event),
      runCommand: async () => ({ code: 0, stdout: 'dsh 0.1.0-rc.7\n', stderr: '' }),
      smokeImpl: async () => ({ web: 'passed', native: 'passed' }),
    });

    assert.equal(result.timings.materializationMs, 0);
    assert.equal(result.fullTreeCopyCount, 0);
    assert.ok(Array.isArray(result.diskSnapshots));
    assert.ok(progress.some((event) => event.phase === 'preScanMs' && event.processedFiles > 0));
    assert.ok(progress.some((event) => event.phase === 'zipMs' && event.processedFiles === event.totalFiles));
    assert.ok(progress.some((event) => event.phase === 'independentExtractionMs' && event.processedFiles === event.totalFiles));
  });
});

test('factory direct archive avoids materializing the complete runtime tree', async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, 'source-runtime');
    await writeJson(path.join(source, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', bin: { dsh: 'lib/bin.js' } });
    await fs.mkdir(path.join(source, 'lib'), { recursive: true });
    await fs.writeFile(path.join(source, 'lib', 'bin.js'), '#!/usr/bin/env node\n', 'utf8');
    const output = path.join(root, 'artifacts');
    const originalCopyFile = fs.copyFile;
    fs.copyFile = async () => {
      throw new Error('direct archive must not materialize the runtime tree');
    };
    try {
      const result = await buildVerifiedRuntimeArtifact({
        sourceRuntimeRoot: source,
        outputDirectory: output,
        version: '0.1.0-rc.7',
        artifactUrl: 'https://updates.example.test/dsh-0.1.0-rc.7-win32-x64.zip',
        sourceRevision: '99f6f02fe',
        pnpmVersion: '11.7.0',
        runCommand: async () => ({ code: 0, stdout: 'dsh 0.1.0-rc.7\n', stderr: '' }),
        smokeImpl: async () => ({ web: 'passed', native: 'passed' }),
      });
      assert.equal(result.fileCount >= 4, true);
    } finally {
      fs.copyFile = originalCopyFile;
    }
  });
});

test('factory direct archive rejects links outside the runtime boundary', async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, 'source-runtime');
    const outside = path.join(path.dirname(root), `dsh-runtime-outside-${path.basename(root)}`);
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await writeJson(path.join(source, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', bin: { dsh: 'lib/bin.js' } });
    await fs.mkdir(path.join(source, 'lib'), { recursive: true });
    await fs.writeFile(path.join(source, 'lib', 'bin.js'), '#!/usr/bin/env node\n', 'utf8');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'must not enter artifact\n', 'utf8');
    await fs.symlink(outside, path.join(source, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await assert.rejects(
        buildVerifiedRuntimeArtifact({
          sourceRuntimeRoot: source,
          outputDirectory: path.join(root, 'artifacts'),
          version: '0.1.0-rc.7',
          artifactUrl: 'https://updates.example.test/dsh-0.1.0-rc.7-win32-x64.zip',
          smokeImpl: async () => ({ web: 'passed', native: 'passed' }),
        }),
        /escapes the allowed runtime boundary/,
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('factory skips recursive source links while preserving the portable runtime files', async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, 'source-runtime');
    await writeJson(path.join(source, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', bin: { dsh: 'lib/bin.js' } });
    await fs.mkdir(path.join(source, 'lib'), { recursive: true });
    await fs.writeFile(path.join(source, 'lib', 'bin.js'), '#!/usr/bin/env node\n', 'utf8');
    await fs.mkdir(path.join(source, 'config', 'agent-presets'), { recursive: true });
    await fs.writeFile(path.join(source, 'config', 'agent-presets', 'standard.yml'), 'name: standard\n', 'utf8');
    await fs.symlink(source, path.join(source, 'recursive-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const output = path.join(root, 'artifacts');

    const result = await buildVerifiedRuntimeArtifact({
      sourceRuntimeRoot: source,
      outputDirectory: output,
      version: '0.1.0-rc.7',
      artifactUrl: 'https://updates.example.test/dsh-0.1.0-rc.7-win32-x64.zip',
      sourceRevision: '99f6f02fe',
      pnpmVersion: '11.7.0',
      runCommand: async () => ({ code: 0, stdout: 'dsh 0.1.0-rc.7\n', stderr: '' }),
      smokeImpl: async () => ({ web: 'passed', native: 'passed' }),
    });

    const archive = await unzipper.Open.file(result.archivePath);
    const names = archive.files.map((file) => file.path);
    assert.ok(names.includes('runtime-manifest.json'));
    assert.ok(names.includes('node_modules/@deepseek-ai/dsh/lib/bin.js'));
    assert.ok(names.includes('node_modules/@deepseek-ai/dsh/config/agent-presets/standard.yml'));
    assert.ok(!names.some((name) => name.includes('recursive-link')));
  });
});

test('factory reuses materialized targets for repeated source links', async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, 'source-runtime');
    const shared = path.join(source, 'shared');
    const destination = path.join(root, 'destination');
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, 'payload.txt'), 'shared payload\n', 'utf8');
    await fs.symlink(shared, path.join(source, 'first'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(shared, path.join(source, 'second'), process.platform === 'win32' ? 'junction' : 'dir');

    const originalCopyFile = fs.copyFile;
    let copyFileCount = 0;
    fs.copyFile = async (...args) => {
      copyFileCount += 1;
      return originalCopyFile(...args);
    };
    try {
      await copyTree(source, destination);
    } finally {
      fs.copyFile = originalCopyFile;
    }

    assert.equal(copyFileCount, 1);
    assert.equal(await fs.readFile(path.join(destination, 'first', 'payload.txt'), 'utf8'), 'shared payload\n');
    assert.equal(await fs.readFile(path.join(destination, 'second', 'payload.txt'), 'utf8'), 'shared payload\n');
  });
});

test('factory falls back to copying when Windows cannot create a materialized hard link', async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, 'source-runtime');
    const shared = path.join(source, 'shared');
    const destination = path.join(root, 'destination');
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, 'payload.txt'), 'shared payload\n', 'utf8');
    await fs.writeFile(path.join(shared, 'second-payload.txt'), 'second shared payload\n', 'utf8');
    await fs.symlink(shared, path.join(source, 'first'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(shared, path.join(source, 'second'), process.platform === 'win32' ? 'junction' : 'dir');

    const originalLink = fs.link;
    let linkAttemptCount = 0;
    fs.link = async () => {
      linkAttemptCount += 1;
      const error = new Error('hard links are unavailable in this fixture');
      error.code = 'UNKNOWN';
      throw error;
    };
    try {
      await copyTree(source, destination);
    } finally {
      fs.link = originalLink;
    }

    assert.equal(await fs.readFile(path.join(destination, 'first', 'payload.txt'), 'utf8'), 'shared payload\n');
    assert.equal(await fs.readFile(path.join(destination, 'second', 'payload.txt'), 'utf8'), 'shared payload\n');
    assert.equal(linkAttemptCount, 1);
  });
});
