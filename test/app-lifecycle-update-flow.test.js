'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const test = require('node:test');

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler() {}
  loadURL() {}
  loadFile() {}
  executeJavaScript() { return Promise.resolve(); }
}

class FakeBrowserWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  isFocused() { return false; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  restore() {}
  loadURL(url) { this.lastUrl = url; }
  loadFile(file) { this.lastFile = file; }
  destroy() { this.destroyed = true; }
}

class FakeTray extends EventEmitter {
  constructor() { super(); this.menus = []; }
  setToolTip() {}
  setContextMenu(menu) { this.menus.push(menu); }
  destroy() { this.destroyed = true; }
}

class FakeNotification {
  constructor(options) { FakeNotification.instances.push(options); }
  show() {}
}
FakeNotification.instances = [];

const electronStub = {
  app: {
    isPackaged: false,
    getPath() { return require('node:os').tmpdir(); },
    quit() {},
  },
  shell: { openExternal() {} },
  Notification: FakeNotification,
  BrowserWindow: FakeBrowserWindow,
  Tray: FakeTray,
  Menu: { buildFromTemplate(template) { return template; } },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};
const { AppLifecycle } = require('../src/lifecycle/app-lifecycle');
const { MainWindow } = require('../src/window/main-window');
const { TrayManager, buildTrayTemplate } = require('../src/tray/tray-manager');
Module._load = originalLoad;

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeUpdateManager(snapshot = {}) {
  const manager = new EventEmitter();
  manager.snapshot = {
    state: 'IDLE',
    currentRuntime: null,
    latest: null,
    preparedRuntime: null,
    ...snapshot,
  };
  manager.getSnapshot = () => JSON.parse(JSON.stringify(manager.snapshot));
  manager.checkCalls = [];
  manager.checkForUpdates = (options) => {
    manager.checkCalls.push(options);
    return Promise.resolve(manager.getSnapshot());
  };
  manager.recoverPendingActivation = async () => manager.getSnapshot();
  return manager;
}

function makeLifecycle(options = {}) {
  const processManager = options.processManager || Object.assign(new EventEmitter(), {
    getStatus: () => 'RUNNING',
    getUrl: () => 'http://127.0.0.1:3080/',
    ownsHarness: () => true,
    getPid: () => 123,
    markRunning() {},
    async start() { return true; },
    async stop() { return true; },
  });
  const runtimeManager = options.runtimeManager || {
    async resolveCurrentRuntime() {
      return { kind: 'bundled', version: '0.1.0-rc.7', command: 'node', args: ['dsh.js'] };
    },
    async consumePendingIfValid() { return null; },
    async cleanupStaging() {},
    async cleanupOldVersions() {},
  };
  const updateManager = options.updateManager || makeUpdateManager();
  const window = options.window || Object.assign(new EventEmitter(), {
    loadStarting() {},
    loadHarness(url) { this.loadedUrl = url; },
    setStartingStatus() {},
    loadError(message) { this.error = message; },
    hide() {},
    focus() {},
    destroy() {},
  });
  const tray = options.tray || { refreshCount: 0, refresh() { this.refreshCount += 1; }, destroy() {} };
  const timeline = options.timeline || [];
  const lifecycle = new AppLifecycle({
    appImpl: electronStub.app,
    shellImpl: electronStub.shell,
    notificationCtor: FakeNotification,
    appLogger: options.appLogger || silentLogger,
    harnessLogger: silentLogger,
    processManager,
    runtimeManager,
    stateStore: {},
    updateManager,
    windowFactory: () => window,
    trayFactory: () => tray,
    checkToolchainImpl: async () => [],
    probeImpl: async () => 'none',
    waitUntilReadyImpl: async () => ({ ok: true, elapsed: 1 }),
    markImpl: (name) => timeline.push(name),
    onShowUpdateMessage: options.onShowUpdateMessage,
    onOpenUpdateDialog: options.onOpenUpdateDialog,
  });
  return { lifecycle, processManager, runtimeManager, updateManager, window, tray, timeline };
}

test('MainWindow emits harness-ready after Harness load, not splash load', () => {
  const mainWindow = new MainWindow({ iconPath: 'icon.png' });
  let ready = 0;
  mainWindow.on('harness-ready', () => { ready += 1; });

  mainWindow.loadStarting();
  mainWindow.win.webContents.emit('did-finish-load');
  assert.equal(ready, 0);

  mainWindow.loadHarness('http://127.0.0.1:3080/');
  mainWindow.win.webContents.emit('did-finish-load');
  assert.equal(ready, 1);
});

test('update check is scheduled after Harness UI readiness and is not awaited', async () => {
  let resolveCheck;
  const updateManager = makeUpdateManager();
  updateManager.checkForUpdates = () => new Promise((resolve) => { resolveCheck = resolve; });
  const h = makeLifecycle({ updateManager });

  h.lifecycle._onHarnessReady();
  assert.deepEqual(h.timeline, ['harness_ui_ready', 'update_check_scheduled']);
  assert.equal(resolveCheck, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.timeline.slice(0, 3), ['harness_ui_ready', 'update_check_scheduled', 'update_check_started']);
  assert.equal(typeof resolveCheck, 'function');
  resolveCheck(h.updateManager.getSnapshot());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.timeline.at(-1), 'update_check_finished');
});

test('boot starts the resolved runtime descriptor', async () => {
  const descriptor = { kind: 'managed', version: '1.1.0', command: 'node.exe', args: ['dsh.js'] };
  const h = makeLifecycle({
    runtimeManager: {
      async resolveCurrentRuntime() { return descriptor; },
      async consumePendingIfValid() {},
      async cleanupStaging() {},
      async cleanupOldVersions() {},
    },
  });
  h.lifecycle._createWindow();
  let startedWith;
  h.processManager.start = async (runtime) => { startedWith = runtime; return true; };

  await h.lifecycle._boot();

  assert.deepEqual(startedWith, descriptor);
  assert.deepEqual(h.window.loadedUrl, 'http://127.0.0.1:3080/');
});

test('Tray template exposes current version, check action, update action, and legacy actions', () => {
  const calls = [];
  const template = buildTrayTemplate({
    version: '0.1.0-rc.7',
    update: '0.1.1-rc.2',
    onShow: () => calls.push('show'),
    onHide: () => calls.push('hide'),
    onCheckForUpdates: () => calls.push('check'),
    onRestart: () => calls.push('restart'),
    onOpenBrowser: () => calls.push('browser'),
    onQuit: () => calls.push('quit'),
  });
  const labels = template.filter((item) => item.label).map((item) => item.label);
  assert.ok(labels.includes('DSH Runtime：0.1.0-rc.7'));
  assert.ok(labels.includes('检查更新'));
  assert.ok(labels.includes('⬆ 更新到 0.1.1-rc.2'));
  assert.ok(labels.includes('重新启动 Agent'));
  assert.ok(labels.includes('在浏览器中打开'));
  assert.ok(labels.includes('退出'));
  template.find((item) => item.label === '检查更新').click();
  template.find((item) => item.label === '打开 DeepSeek Harness').click();
  template.find((item) => item.label === '退出').click();
  assert.deepEqual(calls, ['check', 'show', 'quit']);
});

test('Tray refreshes on update state changes and update action is limited to available states', () => {
  const updateManager = makeUpdateManager({
    state: 'IDLE',
    currentRuntime: { version: '0.1.0-rc.7' },
  });
  const h = makeLifecycle({ updateManager });
  h.lifecycle._createTray();
  assert.equal(h.lifecycle._getUpdateMenuItem(), null);

  updateManager.snapshot = {
    ...updateManager.snapshot,
    state: 'UPDATE_AVAILABLE',
    latest: { version: '0.1.1-rc.2' },
  };
  updateManager.emit('state-change', { snapshot: updateManager.getSnapshot() });
  assert.equal(h.tray.refreshCount, 1);
  assert.equal(h.lifecycle._getUpdateMenuItem().label, '⬆ 更新到 0.1.1-rc.2');
});

test('automatic failures stay log-only while manual failures surface a message', () => {
  const messages = [];
  const h = makeLifecycle({ onShowUpdateMessage: (message) => messages.push(message) });
  h.lifecycle._handleUpdateNotification({ type: 'update-error', error: { message: 'offline' }, manual: false });
  assert.deepEqual(messages, []);
  h.lifecycle._handleUpdateNotification({ type: 'update-error', error: { message: 'manual offline' }, manual: true });
  assert.deepEqual(messages, ['manual offline']);
});

test('one Electron notification is shown per available version', () => {
  FakeNotification.instances.length = 0;
  const h = makeLifecycle();
  h.lifecycle._handleUpdateNotification({ type: 'update-available', version: '1.1.0' });
  h.lifecycle._handleUpdateNotification({ type: 'update-available', version: '1.1.0' });
  h.lifecycle._handleUpdateNotification({ type: 'update-available', version: '1.2.0' });
  assert.deepEqual(FakeNotification.instances.map((item) => item.body), [
    '发现 DSH Runtime 更新：1.1.0',
    '发现 DSH Runtime 更新：1.2.0',
  ]);
});

test('TrayManager refreshes its menu through injected callbacks', () => {
  const manager = new TrayManager({
    iconPath: 'tray.png',
    appName: 'DSH',
    getStatusLabel: () => '运行中',
    getRuntimeVersion: () => '0.1.0-rc.7',
    getUpdateMenuItem: () => ({ label: '⬆ 更新到 0.1.1-rc.2' }),
    onShow() {},
    onHide() {},
    onRestart() {},
    onOpenBrowser() {},
    onQuit() {},
  });
  const labels = manager.tray.menus[0].filter((item) => item.label).map((item) => item.label);
  assert.ok(labels.includes('DSH Runtime：0.1.0-rc.7'));
  assert.ok(labels.includes('⬆ 更新到 0.1.1-rc.2'));
  manager.destroy();
});
