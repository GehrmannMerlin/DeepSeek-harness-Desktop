'use strict';
const { EventEmitter } = require('node:events');
const { BrowserWindow, shell } = require('electron');
const { renderer } = require('../utils/paths');
const { mark } = require('../utils/boot-timeline');

// Owns the single BrowserWindow: secure webPreferences, hide-on-close, and the
// starting/error/harness page transitions. Never spawns or kills the harness.
class MainWindow extends EventEmitter {
  constructor({ iconPath }) {
    super();
    this.harnessUrl = null;
    this._allowClose = false;
    this._page = 'none'; // 'starting' | 'harness' | 'error'
    this._shown = false;

    mark('window_create_started');
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
        // sandbox:false is a CORRECTNESS fix, not a performance one. On Windows
        // 11 25H2 the sandboxed renderer runs in an AppContainer (LPAC) that
        // aborts with STATUS_BREAKPOINT at install locations whose ACL lacks the
        // capability ACE -> permanent black window. nodeIntegration:false and
        // contextIsolation:true remain the primary isolation boundaries, and the
        // renderer only ever loads local content (file:// splash + localhost).
        sandbox: false,
      },
    });
    mark('window_created', this._windowState());

    // Show once the renderer has painted its first frame. This is the only
    // show path that keeps document.hidden=false in this environment — showing
    // before the renderer initializes (show:true, or an immediate show()) leaves
    // the renderer stuck hidden and the splash never paints (black window).
    this.win.once('ready-to-show', () => {
      mark('ready_to_show', this._windowState());
      this._showOnce('ready-to-show');
    });

    // Fallback for slow cold starts (Defender scanning, cold shader cache):
    // once the splash page itself has finished loading, show the shell shortly
    // after even if first paint is still pending. Showing after the page has
    // loaded does NOT trigger the hidden-state bug (that only happens when
    // showing before the renderer initializes). The user gets a dark shell
    // immediately, then the logo/spinner appears when the renderer paints.
    this.win.webContents.once('did-finish-load', () => {
      if (this._page === 'starting') {
        setTimeout(() => {
          if (!this._shown) {
            mark('window_show_fallback', this._windowState());
            this._showOnce('fallback');
          }
        }, 300);
      }
    });

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

    this._attachDiagnostics();
  }

  _windowState() {
    const w = this.win;
    if (w.isDestroyed()) return 'destroyed=true';
    return `visible=${w.isVisible()} minimized=${w.isMinimized()} focused=${w.isFocused()}`;
  }

  _showOnce(source) {
    if (this._shown) return;
    this._shown = true;
    mark('window_show_called', `${source} ${this._windowState()}`);
    this.win.show();
    mark('window_visible', this._windowState());
  }

  _attachDiagnostics() {
    const wc = this.win.webContents;
    const prefix = () => (this._page === 'harness' ? 'harness' : this._page === 'starting' ? 'splash' : this._page);

    wc.on('dom-ready', () => mark(`${prefix()}_dom_ready`, this._windowState()));
    wc.on('did-finish-load', () => {
      mark(`${prefix()}_did_finish_load`, this._windowState());
      if (this._page === 'harness') this.emit('harness-ready');
      if (this._page === 'starting') setTimeout(() => this._verifyPaint(), 600);
    });
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
      mark(`${prefix()}_did_fail_load`,
        `code=${errorCode} desc=${JSON.stringify(errorDescription)} url=${validatedURL} ${this._windowState()}`);
    });
    wc.on('render-process-gone', (_e, details) => {
      mark('render_process_gone', `reason=${details && details.reason} exitCode=${details && details.exitCode}`);
    });
    wc.on('unresponsive', () => mark('renderer_unresponsive'));
    wc.on('responsive', () => mark('renderer_responsive'));

    // The splash renderer reports DOMContentLoaded and its first animation
    // frame via console.log('[splash] ...'). Capture those as first-paint
    // observations (no preload/IPC needed with sandbox:true).
    wc.on('console-message', (_e, ...args) => {
      let message;
      if (typeof args[0] === 'object' && args[0] !== null) {
        message = args[0].message; // newer Electron: (event, details)
      } else {
        message = args[1]; // older Electron: (event, level, message, line, sourceId)
      }
      if (typeof message === 'string' && message.startsWith('[splash]')) {
        const tag = message.slice('[splash]'.length).trim();
        mark(`splash_${tag}`);
      }
    });
  }

  // Definitively verify the splash actually rendered (not a blank/black window)
  // by probing the renderer directly: visibility, logo decode, and whether the
  // compositor is producing frames (requestAnimationFrame fires). capturePage is
  // not used here — it throws UnknownVizError under software rendering.
  async _verifyPaint() {
    try {
      const r = await this.win.webContents.executeJavaScript(`(function () {
        var out = { hidden: document.hidden, readyState: document.readyState, logo: false };
        var img = document.querySelector('img.logo');
        if (img) out.logo = !!(img.complete && img.naturalWidth > 0);
        return new Promise(function (resolve) {
          var t = performance.now();
          requestAnimationFrame(function () { out.rAF = Math.round(performance.now() - t); resolve(out); });
          setTimeout(function () { resolve(out); }, 1200); // fallback if rAF never fires
        });
      })()`, true);
      mark('splash_paint_verified', JSON.stringify(r));
    } catch (e) {
      mark('splash_paint_verify_error', String((e && e.message) || e));
    }
  }

  loadStarting() {
    this._page = 'starting';
    mark('splash_load_started');
    this.win.loadFile(renderer('starting.html'));
  }

  loadHarness(url) {
    this.harnessUrl = url;
    this._page = 'harness';
    mark('harness_navigation_started', url);
    this.win.loadURL(url);
  }

  loadError(message, logPath) {
    this._page = 'error';
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
    mark('window_show_called', this._windowState());
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
    mark('window_visible', this._windowState());
  }

  destroy() {
    this._allowClose = true;
    this.win.destroy();
  }
}

module.exports = { MainWindow };
