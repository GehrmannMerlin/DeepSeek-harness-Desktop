'use strict';
const { app, shell } = require('electron');
const { HarnessProcessManager, STATUS } = require('../process/harness-process-manager');
const { waitUntilReady, probe } = require('../health/harness-health-checker');
const { MainWindow } = require('../window/main-window');
const { TrayManager } = require('../tray/tray-manager');
const { getLogger } = require('../utils/logger');
const { asset, getLogsDir } = require('../utils/paths');
const { DEFAULT_URL } = require('../utils/url-detector');
const { checkToolchain } = require('../utils/npx-resolver');

const DEFAULT_PORT = 3080;
const STARTUP_TIMEOUT = 45000;

const STATUS_LABEL = {
  [STATUS.STOPPED]: '已停止',
  [STATUS.STARTING]: '正在启动',
  [STATUS.WAITING_FOR_SERVER]: '正在启动',
  [STATUS.RUNNING]: '运行中',
  [STATUS.STOPPING]: '正在停止',
  [STATUS.FAILED]: '启动失败',
  [STATUS.CRASHED]: '已停止',
};

// Orchestrates boot, reuse, restart, crash handling and the full quit flow.
// It wires the managers together; the managers own their specific concerns.
class AppLifecycle {
  constructor() {
    this.appLogger = getLogger('application.log');
    this.harnessLogger = getLogger('harness.log');
    this.isQuitting = false;
    this.processManager = new HarnessProcessManager({ logger: this.harnessLogger });
    this.window = null;
    this.tray = null;
  }

  async start() {
    this.appLogger.info('=== DeepSeek Harness Desktop start ===');
    this.appLogger.info(`node=${process.versions.node} electron=${process.versions.electron} packaged=${app.isPackaged}`);

    const missing = checkToolchain();
    if (missing.length) {
      this.appLogger.error(`toolchain missing: ${missing.join(', ')}`);
      this._createWindow();
      this._showError(`未找到必要的运行环境：${missing.join('、')}。\n\n请先安装 Node.js（含 npm / npx），并确认其位于系统 PATH 中。`);
      return;
    }

    this._createWindow();
    this.window.loadStarting();
    this._createTray();

    this.processManager.on('status-change', () => { if (this.tray) this.tray.refresh(); });
    this.processManager.on('exit', ({ code }) => this.appLogger.info(`harness exited code=${code}`));

    await this._boot();
  }

  _createWindow() {
    this.window = new MainWindow({ iconPath: asset('icon.png') });
  }

  _createTray() {
    this.tray = new TrayManager({
      iconPath: asset('tray.png'),
      appName: 'DeepSeek Harness Desktop',
      getStatusLabel: () => STATUS_LABEL[this.processManager.getStatus()] || '未知',
      onShow: () => this._showWindow(),
      onHide: () => { if (this.window) this.window.hide(); },
      onRestart: () => this._restart(),
      onOpenBrowser: () => shell.openExternal(this.processManager.getUrl() || DEFAULT_URL),
      onQuit: () => this.quit(),
    });
  }

  async _boot() {
    this.window.setStartingStatus('正在检查本地环境...');
    const state = await probe(DEFAULT_PORT);

    if (state === 'harness') {
      const url = `http://127.0.0.1:${DEFAULT_PORT}/`;
      this.appLogger.info(`reusing existing harness at ${url}`);
      this.processManager.markExternal(url);
      this.window.loadHarness(url);
      return;
    }

    if (state === 'foreign') {
      this.appLogger.error(`port ${DEFAULT_PORT} occupied by a non-harness process`);
      this._showError(`DeepSeek Harness 无法启动。\n\n端口 ${DEFAULT_PORT} 已被其他程序占用，且对方不是 DeepSeek Harness。\n\n请关闭占用该端口的程序后，从系统托盘选择“重新启动 Agent”。`);
      return;
    }

    this.window.setStartingStatus('正在启动 DeepSeek Harness...');
    const started = await this.processManager.start();
    if (!started) {
      this.appLogger.error('spawn failed');
      this._showError('DeepSeek Harness 启动失败：无法创建进程。');
      return;
    }

    this.window.setStartingStatus('正在等待 DeepSeek Harness 服务...');
    const url = this.processManager.getUrl() || DEFAULT_URL;
    const res = await waitUntilReady(url, { interval: 800, timeout: STARTUP_TIMEOUT });
    if (res.ok) {
      this.appLogger.info(`harness ready at ${url} in ${res.elapsed}ms`);
      this.processManager.markRunning();
      this.window.setStartingStatus('正在连接...');
      this.window.loadHarness(url);
    } else {
      const st = this.processManager.getStatus();
      this.appLogger.error(`harness not ready in time; status=${st}`);
      this._showError(st === STATUS.CRASHED
        ? 'DeepSeek Harness 启动后意外退出。\n\n请从系统托盘选择“重新启动 Agent”。'
        : 'DeepSeek Harness 启动超时。\n\n请从系统托盘选择“重新启动 Agent”。');
    }
  }

  async _restart() {
    if (this.isQuitting) return;
    this.appLogger.info('restart requested');
    await this.processManager.stop();
    this.window.loadStarting();
    await this._boot();
  }

  _showWindow() { if (this.window) this.window.focus(); }

  _showError(msg) {
    if (this.window) this.window.loadError(msg, getLogsDir());
  }

  async quit() {
    if (this.isQuitting) return;
    this.isQuitting = true;
    this.appLogger.info('=== quit ===');
    if (this.processManager.ownsHarness()) {
      this.appLogger.info('stopping owned harness...');
      await this.processManager.stop();
      this.appLogger.info('owned harness stopped');
    } else {
      this.appLogger.info('external harness left running');
    }
    if (this.tray) { this.tray.destroy(); this.tray = null; }
    if (this.window) { this.window.destroy(); this.window = null; }
    this.appLogger.info('quit complete');
    app.quit();
  }
}

module.exports = { AppLifecycle, STATUS_LABEL };
