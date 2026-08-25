'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs').promises;
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_BUNDLED_VERSION,
  DEFAULT_INSTALL_TIMEOUT_MS,
  exactSemver,
  prepareBundledRuntime,
  resolveBundledVersion,
} = require('../scripts/prepare-bundled-runtime');
const { withTempDir, writeJson } = require('./test-helpers');

function fakeChild({ code = 0, beforeExit = null } = {}) {
  const child = new EventEmitter();
  child.pid = 9876;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(async () => {
    if (beforeExit) await beforeExit();
    child.emit('exit', code, null);
  });
  return child;
}

async function installFixture(args, { version, invalid = null } = {}) {
  const prefix = args[args.indexOf('--prefix') + 1];
  const packageRoot = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh');
  const packageJson = {
    name: invalid === 'name' ? '@other/package' : '@deepseek-ai/dsh',
    version: invalid === 'version' ? '9.9.9' : version,
    bin: { dsh: 'bin/dsh.js' },
  };
  await writeJson(path.join(packageRoot, 'package.json'), packageJson);
  if (invalid !== 'cli') {
    await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'bin', 'dsh.js'), '#!/usr/bin/env node\n', 'utf8');
  }
}

test('bundled version defaults to the pinned exact SemVer and accepts only exact overrides', () => {
  assert.equal(DEFAULT_BUNDLED_VERSION, '0.1.0-rc.7');
  assert.equal(DEFAULT_INSTALL_TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(exactSemver('1.2.3'), '1.2.3');
  assert.equal(exactSemver('1.2.3-rc.1'), '1.2.3-rc.1');
  for (const invalid of ['', ' 1.2.3', 'v1.2.3', '1.2', '^1.2.3', 'latest', null]) {
    assert.equal(exactSemver(invalid), null, invalid);
  }
  const previous = process.env.DSH_BUNDLED_VERSION;
  try {
    delete process.env.DSH_BUNDLED_VERSION;
    assert.equal(resolveBundledVersion(), DEFAULT_BUNDLED_VERSION);
    process.env.DSH_BUNDLED_VERSION = '1.2.3-rc.4';
    assert.equal(resolveBundledVersion(), '1.2.3-rc.4');
    process.env.DSH_BUNDLED_VERSION = '';
    assert.throws(() => resolveBundledVersion(), /exact SemVer/);
    process.env.DSH_BUNDLED_VERSION = 'latest';
    assert.throws(() => resolveBundledVersion(), /exact SemVer/);
  } finally {
    if (previous === undefined) delete process.env.DSH_BUNDLED_VERSION;
    else process.env.DSH_BUNDLED_VERSION = previous;
  }
});

test('default preparation refuses to resolve DSH through live npm without a verified artifact', async () => {
  await withTempDir(async (directory) => {
    await assert.rejects(() => prepareBundledRuntime({
      outputRoot: path.join(directory, 'build', 'bundled-runtime'),
      version: '0.1.0-rc.7',
      npmCommand: 'missing-npm.cmd',
      logger: { info() {} },
    }), /verified runtime artifact/i);
  });
});

test('prepares a verified runtime with exact npm args and safe spawn options', async () => {
  await withTempDir(async (directory) => {
    const outputRoot = path.join(directory, 'build', 'bundled-runtime');
    const calls = [];
    const result = await prepareBundledRuntime({
      outputRoot,
      npmCommand: 'npm.cmd',
      version: '0.1.0-rc.7',
      spawnProcess(command, args, options) {
        calls.push({ command, args, options });
        return fakeChild({ beforeExit: () => installFixture(args, { version: '0.1.0-rc.7' }) });
      },
      runCommand: async (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.equal(args[1], '--version');
        assert.equal(options.timeoutMs, 10000);
        return { code: 0, stdout: 'dsh 0.1.0-rc.7\n', stderr: '' };
      },
      logger: { info() {} },
    });

    assert.equal(result.rootPath, outputRoot);
    assert.equal(result.version, '0.1.0-rc.7');
    assert.deepEqual(calls, [{
      command: 'npm.cmd',
      args: [
        'install', '--prefix', calls[0].args[2], '--ignore-scripts', '--no-package-lock', '--no-save',
        '--no-audit', '--no-fund', '@deepseek-ai/dsh@0.1.0-rc.7',
      ],
      options: { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    }]);
    assert.equal(calls[0].args[2].startsWith(path.join(directory, 'build')), true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(outputRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')), {
      name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', bin: { dsh: 'bin/dsh.js' },
    });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(outputRoot, 'runtime-manifest.json'), 'utf8')), {
      name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', source: 'npm-diagnostic', immutable: true,
    });
    assert.equal(await fs.access(path.join(outputRoot, 'package-lock.json')).then(() => true, () => false), false);
  });
});

test('prepares bundled runtime from a verified artifact without invoking npm', async () => {
  await withTempDir(async (directory) => {
    const outputRoot = path.join(directory, 'build', 'bundled-runtime');
    const artifactPath = path.join(directory, 'dsh-runtime.zip');
    const artifactBytes = Buffer.from('verified-artifact');
    await fs.writeFile(artifactPath, artifactBytes);
    const artifactMetadata = {
      sizeBytes: artifactBytes.length,
      sha256: crypto.createHash('sha256').update(artifactBytes).digest('hex'),
    };

    const result = await prepareBundledRuntime({
      outputRoot,
      artifactPath,
      artifactMetadata,
      version: '0.1.0-rc.7',
      spawnProcess() { throw new Error('npm must not be called for an artifact'); },
      extractArtifactImpl: async ({ extractionRoot }) => {
        await installFixture(['--prefix', extractionRoot], { version: '0.1.0-rc.7' });
        await writeJson(path.join(extractionRoot, 'runtime-manifest.json'), {
          schemaVersion: 1,
          packageName: '@deepseek-ai/dsh',
          version: '0.1.0-rc.7',
          platform: 'win32',
          arch: 'x64',
          cliEntry: 'node_modules/@deepseek-ai/dsh/bin/dsh.js',
        });
      },
      runCommand: async () => ({ code: 0, stdout: 'dsh 0.1.0-rc.7\n', stderr: '' }),
      smokeRuntimeImpl: async () => ({ ok: true }),
      logger: { info() {} },
    });

    assert.equal(result.source, 'verified-artifact');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(outputRoot, 'runtime-manifest.json'), 'utf8')), {
      schemaVersion: 1,
      packageName: '@deepseek-ai/dsh',
      version: '0.1.0-rc.7',
      platform: 'win32',
      arch: 'x64',
      cliEntry: 'node_modules/@deepseek-ai/dsh/bin/dsh.js',
    });
  });
});

test('rejects invalid metadata or CLI without publishing a partial output', async () => {
  for (const invalid of ['name', 'version', 'cli']) {
    await withTempDir(async (directory) => {
      const outputRoot = path.join(directory, 'build', 'bundled-runtime');
      await assert.rejects(() => prepareBundledRuntime({
        outputRoot,
        npmCommand: 'npm.cmd',
        version: '0.1.0-rc.7',
        spawnProcess(_command, args) {
          return fakeChild({ beforeExit: () => installFixture(args, { version: '0.1.0-rc.7', invalid }) });
        },
        runCommand: async () => ({ code: 0, stdout: 'dsh 0.1.0-rc.7', stderr: '' }),
        logger: { info() {} },
      }), /Bundled runtime verification failed/);
      assert.equal(await fs.access(outputRoot).then(() => true, () => false), false, invalid);
    });
  }
});

test('preserves a previously accepted output when a replacement fails validation', async () => {
  await withTempDir(async (directory) => {
    const outputRoot = path.join(directory, 'build', 'bundled-runtime');
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.writeFile(path.join(outputRoot, 'accepted.txt'), 'accepted', 'utf8');
    await assert.rejects(() => prepareBundledRuntime({
      outputRoot,
      version: '0.1.0-rc.7',
      spawnProcess(_command, args) {
        return fakeChild({ beforeExit: () => installFixture(args, { version: '0.1.0-rc.7', invalid: 'version' }) });
      },
      logger: { info() {} },
    }), /Bundled runtime verification failed/);
    assert.equal(await fs.readFile(path.join(outputRoot, 'accepted.txt'), 'utf8'), 'accepted');
  });
});

test('builder maps generated runtime outside asar and keeps build output ignored', async () => {
  const builder = await fs.readFile(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  const ignore = await fs.readFile(path.join(__dirname, '..', '.gitignore'), 'utf8');
  const packageJson = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(builder, /asar:\s*true/);
  assert.match(builder, /extraResources:/);
  assert.match(builder, /from:\s*build\/bundled-runtime/);
  assert.match(builder, /to:\s*bundled-runtime/);
  assert.match(builder, /'\*\*\/\*'/);
  assert.match(builder, /node_modules\/\*\*\/\*/);
  assert.match(builder, /from:\s*build\/bundled-runtime\/node_modules/);
  assert.match(ignore, /(?:^|\n)build\/bundled-runtime\/(?:\n|$)/);
  assert.match(packageJson.scripts['prepare:bundled-runtime'], /prepare-bundled-runtime/);
  assert.match(packageJson.scripts.pack, /prepare:bundled-runtime/);
  assert.match(packageJson.scripts.dist, /prepare:bundled-runtime/);
});
