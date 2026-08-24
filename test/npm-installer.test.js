'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs').promises;
const path = require('node:path');
const test = require('node:test');

const { NpmInstaller } = require('../src/update/npm-installer');
const { withTempDir } = require('./test-helpers');

function childProcess({ code = 0, signal = null, settle = true } = {}) {
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killTree = () => {
    child.killed = true;
    child.emit('exit', null, 'SIGTERM');
  };
  if (settle) {
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('installed\n'));
      child.stderr.emit('data', Buffer.from('notice\n'));
      child.emit('exit', code, signal);
    });
  }
  return child;
}

test('installer uses exact package args and shell:false', async () => {
  await withTempDir(async (directory) => {
    const stagingRoot = path.join(directory, 'staging', '1.2.3');
    const calls = [];
    const logs = [];
    const installer = NpmInstaller({
      npmCommand: 'npm.cmd',
      spawnProcess(command, args, options) {
        calls.push({ command, args, options });
        return childProcess();
      },
      logger: { info(message) { logs.push(message); }, warn() {}, error() {} },
      installTimeoutMs: 100,
    });

    const result = await installer.install({ stagingRoot, packageName: '@deepseek-ai/dsh', version: '1.2.3' });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{
      command: 'npm.cmd',
      args: ['install', '--prefix', stagingRoot, '--no-audit', '--no-fund', '@deepseek-ai/dsh@1.2.3'],
      options: { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    }]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(stagingRoot, 'package.json'), 'utf8')), { private: true });
    assert.match(logs[0], /stdout="installed\\n"/);
  });
});

test('installer returns failure for nonzero exit', async () => {
  await withTempDir(async (directory) => {
    const installer = NpmInstaller({ npmCommand: 'npm', spawnProcess: () => childProcess({ code: 7 }), logger: {} });
    const result = await installer.install({ stagingRoot: path.join(directory, 'staging'), packageName: '@deepseek-ai/dsh', version: '1.2.3' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 7);
    assert.equal(result.timedOut, false);
  });
});

test('installer returns failure and kills only install runner on timeout', async () => {
  await withTempDir(async (directory) => {
    const runner = childProcess({ settle: false });
    const killedPids = [];
    const installer = NpmInstaller({
      npmCommand: 'npm',
      spawnProcess: () => runner,
      killProcess: (pid) => { killedPids.push(pid); },
      logger: {},
      installTimeoutMs: 5,
    });
    const result = await installer.install({ stagingRoot: path.join(directory, 'staging'), packageName: '@deepseek-ai/dsh', version: '1.2.3' });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.deepEqual(killedPids, [4321]);
    assert.equal(runner.killed, undefined);
  });
});

test('installer rejects invalid package/version before spawn', async () => {
  await withTempDir(async (directory) => {
    let calls = 0;
    const installer = NpmInstaller({ npmCommand: 'npm', spawnProcess: () => { calls += 1; }, logger: {} });
    const result = await installer.install({ stagingRoot: path.join(directory, 'staging'), packageName: '@other/package', version: 'not-a-version' });
    assert.equal(result.ok, false);
    assert.match(result.error, /package name|version/i);
    assert.equal(calls, 0);
  });
});
