'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { HarnessProcessManager, STATUS } = require('../src/process/harness-process-manager');
const health = require('../src/health/harness-health-checker');

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function createChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function createManager(options = {}) {
  return new HarnessProcessManager({ logger: createLogger(), ...options });
}

function descriptor(overrides = {}) {
  return {
    kind: 'managed',
    version: '1.2.3',
    rootPath: 'C:/runtime/versions/1.2.3',
    packagePath: 'C:/runtime/versions/1.2.3/node_modules/@deepseek-ai/dsh',
    cliEntry: 'C:/runtime/versions/1.2.3/node_modules/@deepseek-ai/dsh/bin/dsh.js',
    args: ['C:/runtime/versions/1.2.3/node_modules/@deepseek-ai/dsh/bin/dsh.js', 'web'],
    command: 'C:/node/node.exe',
    source: 'managed',
    ...overrides,
  };
}

test('descriptor-aware start spawns the exact command and args without a shell', async () => {
  const child = createChild();
  const calls = [];
  const manager = createManager({
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });
  const runtimeDescriptor = descriptor();

  const started = manager.start(runtimeDescriptor);
  child.emit('spawn');

  assert.equal(await started, true);
  assert.deepEqual(calls, [{
    command: runtimeDescriptor.command,
    args: runtimeDescriptor.args,
    options: {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  }]);
  assert.deepEqual(manager.getRuntimeDescriptor(), runtimeDescriptor);
  assert.equal(manager.ownsHarness(), true);

  child.emit('exit', 0, null);
  assert.equal(manager.getRuntimeDescriptor(), null);
  assert.equal(manager.getStatus(), STATUS.CRASHED);
});

test('legacy start without a descriptor uses the legacy resolver', async () => {
  const child = createChild(4322);
  let resolverCalls = 0;
  const resolved = {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npx', '@deepseek-ai/dsh', 'web'],
  };
  const spawnCalls = [];
  const manager = createManager({
    resolveCommandImpl() {
      resolverCalls += 1;
      return resolved;
    },
    spawnImpl(command, args) {
      spawnCalls.push({ command, args });
      return child;
    },
  });

  const started = manager.start();
  child.emit('spawn');

  assert.equal(await started, true);
  assert.equal(resolverCalls, 1);
  assert.deepEqual(spawnCalls, [resolved]);
  assert.equal(manager.getRuntimeDescriptor(), null);
  child.emit('exit', 0, null);
});

test('external Harness stop never invokes process-tree killing', async () => {
  let killCalls = 0;
  const manager = createManager({
    killTreeImpl() {
      killCalls += 1;
      return Promise.resolve({ ok: true, err: '' });
    },
  });

  manager.markExternal('http://127.0.0.1:3080');

  assert.equal(await manager.stop(), true);
  assert.equal(killCalls, 0);
  assert.equal(manager.ownsHarness(), false);
  assert.equal(manager.getRuntimeDescriptor(), null);
  assert.equal(manager.getStatus(), STATUS.RUNNING);
});

test('descriptor is cleared when an owned child emits an error', async () => {
  const child = createChild(4323);
  const manager = createManager({ spawnImpl: () => child });
  const runtimeDescriptor = descriptor({ version: '1.2.4' });

  const started = manager.start(runtimeDescriptor);
  child.emit('error', new Error('spawn failed'));

  assert.equal(await started, false);
  assert.equal(manager.getRuntimeDescriptor(), null);
  assert.equal(manager.getPid(), null);
  assert.equal(manager.getStatus(), STATUS.FAILED);
});

test('restart reuses the currently active runtime descriptor', async () => {
  const firstChild = createChild(4325);
  const secondChild = createChild(4326);
  const children = [firstChild, secondChild];
  const spawnCalls = [];
  let killCalls = 0;
  const manager = createManager({
    spawnImpl(command, args) {
      spawnCalls.push({ command, args });
      return children.shift();
    },
    killTreeImpl() {
      killCalls += 1;
      firstChild.emit('exit', 0, null);
      return Promise.resolve({ ok: true, err: '' });
    },
    isAliveImpl: () => false,
  });
  const runtimeDescriptor = descriptor({ version: '1.2.5' });

  const started = manager.start(runtimeDescriptor);
  firstChild.emit('spawn');
  assert.equal(await started, true);

  const restarted = manager.restart();
  assert.equal(killCalls, 1);
  await Promise.resolve();
  secondChild.emit('spawn');

  assert.equal(await restarted, true);
  assert.deepEqual(spawnCalls, [
    { command: runtimeDescriptor.command, args: runtimeDescriptor.args },
    { command: runtimeDescriptor.command, args: runtimeDescriptor.args },
  ]);
  assert.deepEqual(manager.getRuntimeDescriptor(), runtimeDescriptor);
  secondChild.emit('exit', 0, null);
});

test('stdout URL detection and injected health checks remain compatible', async () => {
  const child = createChild(4324);
  const urls = [];
  const manager = createManager({ spawnImpl: () => child });
  manager.on('url-detected', (url) => urls.push(url));

  const started = manager.start(descriptor({ kind: 'bundled', source: 'bundled', version: '2.0.0' }));
  child.emit('spawn');
  assert.equal(await started, true);

  child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:3080\n'));
  assert.deepEqual(urls, ['http://127.0.0.1:3080']);
  assert.equal(manager.getUrl(), 'http://127.0.0.1:3080');
  assert.equal(manager.getStatus(), STATUS.WAITING_FOR_SERVER);

  let calls = 0;
  const result = await health.waitUntilReady('http://127.0.0.1:3080', {
    interval: 0,
    timeout: 100,
    checkFn: async (url, options) => {
      calls += 1;
      assert.equal(url, 'http://127.0.0.1:3080');
      assert.equal(typeof options.transport, 'function');
      return { ready: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);

  child.emit('exit', 0, null);
});
