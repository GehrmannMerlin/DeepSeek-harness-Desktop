'use strict';

const path = require('node:path');
const { BrowserWindow, ipcMain, shell } = require('electron');
const { getLogsDir, renderer } = require('../utils/paths');

const CHANNELS = Object.freeze({
  getState: 'dsh-update:get-state',
  confirm: 'dsh-update:confirm',
  cancel: 'dsh-update:cancel',
  openLog: 'dsh-update:open-log',
  state: 'dsh-update:state',
});

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = clone(child);
    return result;
  }
  return value;
}

class UpdateDialog {
  constructor({
    updateManager,
    BrowserWindowImpl = BrowserWindow,
    ipcMainImpl = ipcMain,
    shellImpl = shell,
    ownerWindow = null,
    rendererPath = renderer('update.html'),
    preloadPath = path.join(__dirname, 'update-preload.js'),
    logPath = path.join(getLogsDir(), 'application.log'),
    logger = console,
  } = {}) {
    if (!updateManager) throw new TypeError('updateManager is required');
    this.updateManager = updateManager;
    this.BrowserWindow = BrowserWindowImpl;
    this.ipcMain = ipcMainImpl;
    this.shell = shellImpl;
    this.ownerWindow = ownerWindow;
    this.rendererPath = rendererPath;
    this.preloadPath = preloadPath;
    this.logPath = logPath;
    this.logger = logger;
    this.window = null;
    this.allowClose = false;
    this.handlersRegistered = false;
    this.listeners = [];
  }

  show(snapshot = this.updateManager.getSnapshot()) {
    this._ensureWindow();
    this._sendState({ type: 'snapshot', snapshot: clone(snapshot) });
    if (typeof this.window.show === 'function') this.window.show();
    if (typeof this.window.focus === 'function') this.window.focus();
    return this.window;
  }

  hide() {
    if (this.window && !this._isDestroyed() && typeof this.window.hide === 'function') this.window.hide();
  }

  destroy() {
    this.allowClose = true;
    this._removeManagerListeners();
    this._removeIpcHandlers();
    if (this.window && !this._isDestroyed() && typeof this.window.destroy === 'function') this.window.destroy();
    this.window = null;
  }

  _ensureWindow() {
    if (this.window && !this._isDestroyed()) return;
    const options = {
      width: 560,
      height: 620,
      minWidth: 480,
      minHeight: 500,
      show: false,
      resizable: false,
      title: 'DSH Runtime 更新',
      parent: this.ownerWindow || undefined,
      modal: false,
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        // Keep the repository's Windows-compatible renderer choice. The
        // preload/context bridge still provide the only renderer API.
        sandbox: false,
      },
    };
    this.window = new this.BrowserWindow(options);
    this.window.on('close', (event) => {
      if (this.allowClose) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.hide();
    });
    this.window.on('closed', () => {
      this.window = null;
    });
    if (this.window.webContents && typeof this.window.webContents.setWindowOpenHandler === 'function') {
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
    if (this.window.webContents && typeof this.window.webContents.on === 'function') {
      this.window.webContents.on('will-navigate', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
      });
    }
    this._registerIpcHandlers();
    this._registerManagerListeners();
    this.window.loadFile(this.rendererPath);
  }

  _registerManagerListeners() {
    if (this.listeners.length || !this.updateManager.on) return;
    const stateChange = ({ snapshot }) => this._sendState({ type: 'state-change', snapshot });
    const progress = ({ progress, snapshot }) => this._sendState({ type: 'progress', progress, snapshot });
    const error = ({ error, snapshot }) => this._sendState({ type: 'error', error, snapshot });
    this.updateManager.on('state-change', stateChange);
    this.updateManager.on('progress', progress);
    this.updateManager.on('error', error);
    this.listeners = [
      ['state-change', stateChange],
      ['progress', progress],
      ['error', error],
    ];
  }

  _removeManagerListeners() {
    if (!this.updateManager.removeListener) return;
    for (const [event, listener] of this.listeners) this.updateManager.removeListener(event, listener);
    this.listeners = [];
  }

  _registerIpcHandlers() {
    if (this.handlersRegistered || !this.ipcMain || typeof this.ipcMain.handle !== 'function') return;
    this._handle(CHANNELS.getState, () => this.updateManager.getSnapshot());
    this._handle(CHANNELS.confirm, () => this.updateManager.confirmUpdate());
    this._handle(CHANNELS.cancel, () => this.updateManager.cancelUpdate());
    this._handle(CHANNELS.openLog, () => this._openConfiguredLog());
    this.handlersRegistered = true;
  }

  _handle(channel, operation) {
    this.ipcMain.handle(channel, async (event) => {
      if (!this._isTrustedSender(event)) throw new Error('untrusted update dialog sender');
      return operation();
    });
  }

  _removeIpcHandlers() {
    if (!this.handlersRegistered || !this.ipcMain || typeof this.ipcMain.removeHandler !== 'function') return;
    for (const channel of [CHANNELS.getState, CHANNELS.confirm, CHANNELS.cancel, CHANNELS.openLog]) {
      this.ipcMain.removeHandler(channel);
    }
    this.handlersRegistered = false;
  }

  _isTrustedSender(event) {
    return Boolean(
      this.window &&
      !this._isDestroyed() &&
      event &&
      event.sender &&
      this.window.webContents &&
      event.sender === this.window.webContents,
    );
  }

  async _openConfiguredLog() {
    if (!this.shell || typeof this.shell.openPath !== 'function') return '';
    return this.shell.openPath(this.logPath);
  }

  _sendState(payload) {
    if (!this.window || this._isDestroyed() || !this.window.webContents || typeof this.window.webContents.send !== 'function') return;
    this.window.webContents.send(CHANNELS.state, clone(payload));
  }

  _isDestroyed() {
    return Boolean(this.window && typeof this.window.isDestroyed === 'function' && this.window.isDestroyed());
  }
}

module.exports = { UpdateDialog, CHANNELS };
