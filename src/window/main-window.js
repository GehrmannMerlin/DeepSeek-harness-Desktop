'use strict';
const { BrowserWindow, shell } = require('electron');
const { renderer } = require('../utils/paths');

// Owns the single BrowserWindow: secure webPreferences, hide-on-close, and the
// starting/error/harness page transitions. Never spawns or kills the harness.
class MainWindow {
  constructor({ iconPath }) {
    this.harnessUrl = null;
    this._allowClose = false;

    this.win = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 940,
      minHeight: 620,
      show: false,
      icon: iconPath,
      backgroundColor: '#0f1115',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    this.win.once('ready-to-show', () => this.win.show());

    // Close button -> hide to tray, not quit.
    this.win.on('close', (e) => {
      if (!this._allowClose) {
        e.preventDefault();
        this.win.hide();
      }
    });

    // Any new window / external link goes to the system browser.
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    // Block navigation away from the harness origin.
    this.win.webContents.on('will-navigate', (e, url) => {
      if (!this.harnessUrl) return;
      try {
        if (new URL(url).origin !== new URL(this.harnessUrl).origin) {
          e.preventDefault();
          shell.openExternal(url);
        }
      } catch (_) {
        e.preventDefault();
      }
    });
  }

  loadStarting() {
    this.win.loadFile(renderer('starting.html'));
  }

  loadHarness(url) {
    this.harnessUrl = url;
    this.win.loadURL(url);
  }

  loadError(message, logPath) {
    this.win.loadFile(renderer('error.html'), { query: { msg: message, logs: logPath || '' } });
  }

  // Best-effort status update on the starting page (no preload/IPC needed).
  setStartingStatus(text) {
    try {
      this.win.webContents
        .executeJavaScript(`(function(){var el=document.getElementById('status');if(el){el.textContent=${JSON.stringify(text)}}})()`)
        .catch(() => {});
    } catch (_) {}
  }

  show() { this.win.show(); }
  hide() { this.win.hide(); }
  isVisible() { return this.win.isVisible(); }

  focus() {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  destroy() {
    this._allowClose = true;
    this.win.destroy();
  }
}

module.exports = { MainWindow };
