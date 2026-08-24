'use strict';
const { app, shell, Notification } = require('electron');
const { HarnessProcessManager, STATUS } = require('../process/harness-process-manager');
const { waitUntilReady, probe } = require('../health/harness-health-checker');
const { MainWindow } = require('../window/main-window');
const { TrayManager } = require('../tray/tray-manager');
const { getLogger } = require('../utils/logger');
const {
  asset,
  getLogsDir,
  getRuntimeStatePath,
} = require('../utils/paths');
const { DEFAULT_URL } = require('../utils/url-detector');
const { checkToolchain } = require('../utils/npx-resolver');
const { RuntimeStateStore } = require('../runtime/runtime-state-store');
const { DshRuntimeManager } = require('../runtime/dsh-runtime-manager');
const { NpmRegistryUpdateSource } = require('../update/npm-registry-update-source');
const { NpmInstaller } = require('../update/npm-installer');
const { verifyRuntime } = require('../update/runtime-verifier');
const { DshUpdateManager, STATES: UPDATE_STATES } = require('../update/dsh-update-manager');
const { mark, attach, dump } = require('../utils/boot-timeline');

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
  constructor({
    appImpl = app,
    shellImpl = shell,
    notificationCtor = Notification,
    loggerFactory = getLogger,
    appLogger,
    harnessLogger,
    processManager,
    stateStore,
    runtimeManager,
    registry,
    installer,
    verifier,
    healthChecker,
    updateManager,
    windowFactory = ({ iconPath }) => new MainWindow({ iconPath }),
    trayFactory = (options) => new TrayManager(options),
    checkToolchainImpl = checkToolchain,
    probeImpl = probe,
    waitUntilReadyImpl = waitUntilReady,
    markImpl = mark,
    onOpenUpdateDialog,
    onShowUpdateMessage,
  } = {}) {
    this.app = appImpl;
    this.shell = shellImpl;
    this.Notification = notificationCtor;
    this.checkToolchain = checkToolchainImpl;
    this.probe = probeImpl;
    this.waitUntilReady = waitUntilReadyImpl;
    this.mark = markImpl;
    this.appLogger = appLogger || loggerFactory('application.log');
    this.harnessLogger = harnessLogger || loggerFactory('harness.log');
    this.isQuitting = false;
    this.processManager = processManager || new HarnessProcessManager({ logger: this.harnessLogger });
    this.stateStore = stateStore || new RuntimeStateStore({
      filePath: getRuntimeStatePath(),
      logger: this.appLogger,
    });
    this.runtimeManager = runtimeManager || new DshRuntimeManager({
      stateStore: this.stateStore,
      logger: this.appLogger,
    });
    this.registry = registry || NpmRegistryUpdateSource({ logger: this.appLogger });
    this.installer = installer || NpmInstaller({
      npmCommand: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      logger: this.appLogger,
    });
    this.verifier = verifier || { verify: verifyRuntime };
    this.healthChecker = healthChecker || { waitUntilReady };
    this.updateManager = updateManager || new DshUpdateManager({
      runtimeManager: this.runtimeManager,
      registry: this.registry,
      installer: this.installer,
      verifier: this.verifier,
      processManager: this.processManager,
      healthChecker: this.healthChecker,
      logger: this.appLogger,
    });
    this.windowFactory = windowFactory;
    this.trayFactory = trayFactory;
    this.onOpenUpdateDialog = onOpenUpdateDialog;
    this.onShowUpdateMessage = onShowUpdateMessage;
    this.window = null;
    this.tray = null;
    this.currentRuntime = null;
    this.updateCheckScheduled = false;
    this.notifiedVersions = new Set();

    this.updateManager.on('state-change', ({ snapshot }) => this._handleUpdateState(snapshot));
    this.updateManager.on('notification', (event) => this._handleUpdateNotification(event));
    this.updateManager.on('error', ({ error }) => {
      this.appLogger.error(`DSH update error: ${error && error.message ? error.message : String(error)}`);
    });
  }

  async start() {
    // Durable boot timeline + mirror into application.log from here on.
    attach(getLogsDir(), (m) => this.appLogger.info(m));

    this.appLogger.info('=== DeepSeek Harness Desktop start ===');
    this.appLogger.info(`node=${process.versions.node} electron=${process.versions.electron} packaged=${this.app.isPackaged}`);
    this.appLogger.info(`splashOnly=${this._isSplashOnly()}`);

    // Show the window (splash) first, before any environment detection, so the
    // user gets immediate feedback. The toolchain check is async and runs after.
    this._createWindow();
    this.window.loadStarting();
    this._createTray();
    this.mark('tray_created');

    this.processManager.on('status-change', () => { if (this.tray) this.tray.refresh(); });
    this.processManager.on('exit', ({ code }) => this.appLogger.info(`harness exited code=${code}`));

    this.mark('toolchain_check_started');
    const missing = await this.checkToolchain();
    this.mark('toolchain_check_finished', `missing=[${missing.join(',')}]`);

    if (missing.length) {
      this.appLogger.error(`toolchain missing: ${missing.join(', ')}`);
      this._showError(`未找到必要的运行环境：${missing.join('、')}。\n\n请先安装 Node.js（含 npm / npx），并确认其位于系统 PATH 中。`);
      return;
    }

    await this._prepareRuntimeBeforeBoot();
    await this._boot();
  }

  _isSplashOnly() {
    return process.argv.includes('--splash-only') || process.env.DSH_DESKTOP_SPLASH_ONLY === '1';
  }

  _createWindow() {
    this.window = this.windowFactory({ iconPath: asset('icon.png') });
    if (this.window && typeof this.window.on === 'function') {
      this.window.on('harness-ready', () => this._onHarnessReady());
    }
  }

  _createTray() {
    this.tray = this.trayFactory({
      iconPath: asset('tray.png'),
      appName: 'DeepSeek Harness Desktop',
      getStatusLabel: () => STATUS_LABEL[this.processManager.getStatus()] || '未知',
      getRuntimeVersion: () => this._getRuntimeVersion(),
      getUpdateMenuItem: () => this._getUpdateMenuItem(),
      onCheckForUpdates: () => this._checkForUpdatesManually(),
      onUpdate: () => this._openUpdateDialog(),
      onShow: () => this._showWindow(),
      onHide: () => { if (this.window) this.window.hide(); },
      onRestart: () => this._restart(),
      onOpenBrowser: () => this.shell.openExternal(this.processManager.getUrl() || DEFAULT_URL),
      onQuit: () => this.quit(),
    });
  }

  async _boot() {
    this.mark('bootstrap_started');

    // Diagnostic: render the local splash and stop here, to isolate the
    // Electron/renderer path from the harness bootstrap path.
    if (this._isSplashOnly()) {
      this.appLogger.info('splash-only mode: skipping harness bootstrap');
      return;
    }

    this.window.setStartingStatus('正在检查本地环境...');
    this.mark('existing_harness_check_started');
    const state = await this.probe(DEFAULT_PORT);
    this.mark('existing_harness_check_finished', `state=${state}`);

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
    let runtimeDescriptor;
    try {
      runtimeDescriptor = await this.runtimeManager.resolveCurrentRuntime();
      this.currentRuntime = runtimeDescriptor;
    } catch (error) {
      this.appLogger.error(`Unable to resolve current DSH runtime: ${error.message}`);
      this._showError('DeepSeek Harness 启动失败：无法解析本地 Runtime。');
      return;
    }
    const started = await this.processManager.start(runtimeDescriptor);
    if (!started) {
      this.appLogger.error('spawn failed');
      this._showError('DeepSeek Harness 启动失败：无法创建进程。');
      return;
    }

    this.window.setStartingStatus('正在等待 DeepSeek Harness 服务...');
    const url = this.processManager.getUrl() || DEFAULT_URL;
    const res = await this.waitUntilReady(url, { interval: 800, timeout: STARTUP_TIMEOUT });
    if (res.ok) {
      this.appLogger.info(`harness ready at ${url} in ${res.elapsed}ms`);
      this.processManager.markRunning();
      await this._recoverPendingAfterBoot();
      this.window.setStartingStatus('正在连接...');
      this.window.loadHarness(this.processManager.getUrl() || url);
    } else {
      const st = this.processManager.getStatus();
      this.appLogger.error(`harness not ready in time; status=${st}`);
      this._showError(st === STATUS.CRASHED
        ? 'DeepSeek Harness 启动后意外退出。\n\n请从系统托盘选择“重新启动 Agent”。'
        : 'DeepSeek Harness 启动超时。\n\n请从系统托盘选择“重新启动 Agent”。');
    }
  }

  async _prepareRuntimeBeforeBoot() {
    try {
      if (typeof this.runtimeManager.consumePendingIfValid === 'function') {
        await this.runtimeManager.consumePendingIfValid();
      }
      if (typeof this.runtimeManager.cleanupStaging === 'function') {
        await this.runtimeManager.cleanupStaging();
      }
      if (typeof this.runtimeManager.cleanupOldVersions === 'function') {
        await this.runtimeManager.cleanupOldVersions();
      }
    } catch (error) {
      this.appLogger.warn(`Local DSH runtime self-heal skipped: ${error.message}`);
    }
  }

  async _recoverPendingAfterBoot() {
    if (!this.updateManager || typeof this.updateManager.recoverPendingActivation !== 'function') return;
    try {
      const snapshot = await this.updateManager.recoverPendingActivation();
      if (snapshot && snapshot.currentRuntime) this.currentRuntime = snapshot.currentRuntime;
      if (this.processManager.markRunning) this.processManager.markRunning();
    } catch (error) {
      this.appLogger.error(`Pending DSH runtime recovery failed: ${error.message}`);
    }
  }

  _onHarnessReady() {
    this.mark('harness_ui_ready');
    this._scheduleUpdateCheck();
  }

  _scheduleUpdateCheck() {
    if (this.updateCheckScheduled) return;
    this.updateCheckScheduled = true;
    this.mark('update_check_scheduled');
    const run = () => {
      this.mark('update_check_started');
      Promise.resolve()
        .then(() => this.updateManager.checkForUpdates({ manual: false }))
        .catch((error) => this.appLogger.error(`Automatic DSH update check failed: ${error.message}`))
        .finally(() => this.mark('update_check_finished'));
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else setImmediate(run);
  }

  _checkForUpdatesManually() {
    return this.updateManager.checkForUpdates({ manual: true })
      .catch((error) => {
        this.appLogger.error(`Manual DSH update check failed: ${error.message}`);
        this._showUpdateMessage('检查更新失败，请稍后重试。');
        return this.updateManager.getSnapshot();
      });
  }

  _getRuntimeVersion() {
    const snapshot = this.updateManager && this.updateManager.getSnapshot
      ? this.updateManager.getSnapshot()
      : null;
    return (this.currentRuntime && this.currentRuntime.version)
      || (snapshot && snapshot.currentRuntime && snapshot.currentRuntime.version)
      || '未知';
  }

  _getUpdateMenuItem() {
    const snapshot = this.updateManager.getSnapshot();
    const canApply = snapshot.state === UPDATE_STATES.UPDATE_AVAILABLE
      || snapshot.state === UPDATE_STATES.READY_TO_APPLY
      || snapshot.state === UPDATE_STATES.WAITING_FOR_EXTERNAL_HARNESS;
    const version = snapshot.latest && snapshot.latest.version
      || snapshot.preparedRuntime && snapshot.preparedRuntime.version;
    if (!canApply || !version) return null;
    return {
      label: `⬆ 更新到 ${version}`,
      click: () => this._openUpdateDialog(),
    };
  }

  _handleUpdateState(snapshot) {
    if (snapshot && snapshot.currentRuntime) this.currentRuntime = snapshot.currentRuntime;
    if (this.tray) this.tray.refresh();
  }

  _handleUpdateNotification(event) {
    if (!event) return;
    if (event.type === 'update-available' && event.version) {
      if (this.notifiedVersions.has(event.version)) return;
      this.notifiedVersions.add(event.version);
      try {
        if (typeof this.Notification === 'function') {
          const notification = new this.Notification({
            title: 'DeepSeek Harness Desktop',
            body: `发现 DSH Runtime 更新：${event.version}`,
          });
          if (notification && typeof notification.show === 'function') notification.show();
        }
      } catch (error) {
        this.appLogger.warn(`Unable to show DSH update notification: ${error.message}`);
      }
      return;
    }
    if (event.type === 'update-error' && event.manual) {
      this._showUpdateMessage(event.error && event.error.message || '检查更新失败，请稍后重试。');
    }
  }

  _openUpdateDialog(snapshot = this.updateManager.getSnapshot()) {
    if (typeof this.onOpenUpdateDialog === 'function') {
      return this.onOpenUpdateDialog(snapshot);
    }
    this.appLogger.info(`DSH update requested for ${snapshot && snapshot.latest && snapshot.latest.version || 'unknown'}`);
    return null;
  }

  _showUpdateMessage(message) {
    if (typeof this.onShowUpdateMessage === 'function') return this.onShowUpdateMessage(message);
    this.appLogger.warn(`DSH update message: ${message}`);
    return null;
  }

  async _restart() {
    if (this.isQuitting) return;
    this.appLogger.info('restart requested');
    await this.processManager.stop();
    this.window.loadStarting();
    await this._boot();
  }

  _showWindow() {
    if (this.window) this.window.focus();
  }

  _showError(msg) {
    if (this.window) this.window.loadError(msg, getLogsDir());
  }

  async quit() {
    if (this.isQuitting) return;
    this.isQuitting = true;
    this.mark('shutdown_started');
    this.appLogger.info('=== quit ===');
    if (this.processManager.ownsHarness()) {
      this.appLogger.info('stopping owned harness...');
      await this.processManager.stop();
      this.appLogger.info('owned harness stopped');
    } else {
      this.appLogger.info('external harness left running');
    }
    this.appLogger.info('--- boot timeline ---\n' + dump());
    if (this.tray) { this.tray.destroy(); this.tray = null; }
    if (this.window) { this.window.destroy(); this.window = null; }
    this.appLogger.info('quit complete');
    this.app.quit();
  }
}

module.exports = { AppLifecycle, STATUS_LABEL };
