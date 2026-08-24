'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];

  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
    this.loadedFile = null;
    FakeBrowserWindow.instances.push(this);
  }

  loadFile(file) { this.loadedFile = file; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  focus() {}
  destroy() { this.destroyed = true; this.emit('closed'); }
}

function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };
}

function makeUpdateManager(snapshot = {}) {
  const manager = new EventEmitter();
  manager.snapshot = {
    state: 'UPDATE_AVAILABLE',
    currentRuntime: { version: '0.1.0-rc.7' },
    latest: { version: '0.1.1-rc.2', releaseNotes: 'Fixes and improvements' },
    progress: null,
    error: null,
    ...snapshot,
  };
  manager.calls = { check: 0, confirm: 0, cancel: 0 };
  manager.getSnapshot = () => JSON.parse(JSON.stringify(manager.snapshot));
  manager.operation = null;
  manager.confirmUpdate = () => {
    if (manager.operation) return manager.operation;
    manager.calls.confirm += 1;
    manager.operation = Promise.resolve(manager.getSnapshot()).finally(() => { manager.operation = null; });
    return manager.operation;
  };
  manager.cancelUpdate = () => {
    if (manager.operation) return manager.operation;
    manager.calls.cancel += 1;
    manager.operation = Promise.resolve(manager.getSnapshot()).finally(() => { manager.operation = null; });
    return manager.operation;
  };
  manager.checkForUpdates = async () => {
    manager.calls.check += 1;
    manager.snapshot.state = 'UPDATE_AVAILABLE';
    manager.snapshot.error = null;
    manager.snapshot.updateAvailable = true;
    return manager.getSnapshot();
  };
  return manager;
}

function loadDialogModule() {
  const electronStub = {
    BrowserWindow: FakeBrowserWindow,
    ipcMain: makeIpcMain(),
    shell: { openPath: async () => '' },
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { module: require('../src/window/update-dialog'), electronStub };
  } finally {
    Module._load = originalLoad;
  }
}

function makeDialog(options = {}) {
  const { module } = loadDialogModule();
  const ipcMain = options.ipcMain || makeIpcMain();
  const manager = options.updateManager || makeUpdateManager();
  const ownerWindow = options.ownerWindow || { webContents: new FakeWebContents() };
  const shell = options.shell || { openPath: async () => '' };
  const dialog = new module.UpdateDialog({
    updateManager: manager,
    BrowserWindowImpl: FakeBrowserWindow,
    ipcMainImpl: ipcMain,
    shellImpl: shell,
    ownerWindow,
    rendererPath: path.join(__dirname, '..', 'renderer', 'update.html'),
    preloadPath: path.join(__dirname, '..', 'src', 'window', 'update-preload.js'),
    logPath: path.join('C:', 'Users', 'tester', 'logs', 'application.log'),
  });
  return { dialog, manager, ipcMain, ownerWindow, shell };
}

test('dialog loads local update HTML with secure Electron preferences', () => {
  FakeBrowserWindow.instances.length = 0;
  const { dialog } = makeDialog();
  dialog.show();
  const win = FakeBrowserWindow.instances.at(-1);

  assert.equal(win.loadedFile, path.join(__dirname, '..', 'renderer', 'update.html'));
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.sandbox, false);
  assert.equal(win.options.webPreferences.preload, path.join(__dirname, '..', 'src', 'window', 'update-preload.js'));
  dialog.destroy();
});

test('preload exposes only the explicit update API', () => {
  const exposed = {};
  const calls = [];
  const contextBridge = { exposeInMainWorld(name, api) { exposed[name] = api; } };
  const ipcRenderer = {
    invoke(channel) { calls.push(channel); return Promise.resolve({ state: 'IDLE' }); },
    on() {},
    removeListener() {},
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return { contextBridge, ipcRenderer };
    return originalLoad.call(this, request, parent, isMain);
  };
  let preload;
  try {
    preload = require('../src/window/update-preload');
  } finally {
    Module._load = originalLoad;
  }
  assert.deepEqual(Object.keys(exposed), ['updateApi']);
  assert.deepEqual(Object.keys(exposed.updateApi).sort(), [
    'cancelUpdate', 'confirmUpdate', 'getState', 'onStateChange', 'openUpdateLog', 'retryUpdate',
  ]);
  assert.equal(typeof preload.createUpdateApi, 'function');
  assert.equal(Object.prototype.hasOwnProperty.call(exposed.updateApi, 'ipcRenderer'), false);
  return exposed.updateApi.getState().then(() => {
    assert.deepEqual(calls, ['dsh-update:get-state']);
  });
});

test('IPC rejects a sender that is not the update dialog window', async () => {
  const { dialog, ipcMain } = makeDialog();
  dialog.show();
  const handler = ipcMain.handlers.get('dsh-update:confirm');
  await assert.rejects(
    handler({ sender: { id: 'untrusted' } }),
    /untrusted update dialog sender/,
  );
  dialog.destroy();
});

test('confirm and cancel IPC calls remain manager-deduplicated', async () => {
  const { dialog, manager, ipcMain } = makeDialog();
  dialog.show();
  const sender = dialog.window.webContents;
  await Promise.all([
    ipcMain.handlers.get('dsh-update:confirm')({ sender }),
    ipcMain.handlers.get('dsh-update:confirm')({ sender }),
  ]);
  await ipcMain.handlers.get('dsh-update:cancel')({ sender });
  assert.equal(manager.calls.confirm, 1);
  assert.equal(manager.calls.cancel, 1);
  dialog.destroy();
});

test('FAILED retry performs one manual check and one new update operation for duplicate clicks', async () => {
  const { dialog, manager, ipcMain } = makeDialog({
    updateManager: makeUpdateManager({
      state: 'FAILED',
      updateAvailable: false,
      error: { message: 'previous install failed' },
    }),
  });
  let releaseCheck;
  const retryManager = dialog.updateManager;
  retryManager.checkForUpdates = ({ manual }) => {
    assert.equal(manual, true);
    retryManager.calls.check += 1;
    return new Promise((resolve) => {
      releaseCheck = () => {
        retryManager.snapshot.state = 'UPDATE_AVAILABLE';
        retryManager.snapshot.error = null;
        retryManager.snapshot.updateAvailable = true;
        resolve(retryManager.getSnapshot());
      };
    });
  };
  dialog.show();
  const sender = dialog.window.webContents;
  const first = ipcMain.handlers.get('dsh-update:retry')({ sender });
  const second = ipcMain.handlers.get('dsh-update:retry')({ sender });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retryManager.calls.check, 1);
  releaseCheck();
  await Promise.all([first, second]);
  assert.equal(retryManager.calls.confirm, 1);
  dialog.destroy();
});

test('opening the dialog does not start installation', () => {
  const { dialog, manager } = makeDialog();
  dialog.show();
  assert.deepEqual(manager.calls, { check: 0, confirm: 0, cancel: 0 });
  dialog.destroy();
});

test('manager progress and error events reach the dialog without touching Harness', () => {
  const processManager = { stopCalls: 0, stop() { this.stopCalls += 1; } };
  const { dialog, manager } = makeDialog({ processManager });
  dialog.show();
  manager.emit('progress', { progress: { phase: 'installing', version: '0.1.1-rc.2' }, snapshot: manager.getSnapshot() });
  manager.emit('error', { error: { message: 'offline' }, snapshot: { ...manager.getSnapshot(), error: { message: 'offline' } } });
  const messages = dialog.window.webContents.sent;
  assert.equal(messages.at(-2).channel, 'dsh-update:state');
  assert.equal(messages.at(-2).payload.progress.phase, 'installing');
  assert.equal(messages.at(-1).payload.error.message, 'offline');
  dialog.window.emit('close', { preventDefault() {} });
  assert.equal(processManager.stopCalls, 0);
  assert.equal(dialog.window.visible, false);
  dialog.destroy();
});

test('log action opens only the configured local log path', async () => {
  const shell = { opened: [], async openPath(filePath) { this.opened.push(filePath); return ''; } };
  const { dialog, ipcMain } = makeDialog({ shell });
  dialog.show();
  await ipcMain.handlers.get('dsh-update:open-log')({ sender: dialog.window.webContents, path: 'C:\\outside.txt' });
  assert.deepEqual(shell.opened, [path.join('C:', 'Users', 'tester', 'logs', 'application.log')]);
  dialog.destroy();
});
