'use strict';
const { Tray, Menu } = require('electron');

// Owns the system tray icon and its dynamic menu. Actions are injected as
// callbacks so the tray never touches child_process or the window directly.
class TrayManager {
  constructor({ iconPath, appName, getStatusLabel, onShow, onHide, onRestart, onOpenBrowser, onQuit }) {
    this.getStatusLabel = getStatusLabel;
    this.onShow = onShow;
    this.onHide = onHide;
    this.onRestart = onRestart;
    this.onOpenBrowser = onOpenBrowser;
    this.onQuit = onQuit;

    this.tray = new Tray(iconPath);
    this.tray.setToolTip(appName);
    this.tray.on('click', () => this.onShow());
    this.tray.on('double-click', () => this.onShow());
    this.refresh();
  }

  refresh() {
    const status = this.getStatusLabel ? this.getStatusLabel() : '未知';
    const menu = Menu.buildFromTemplate([
      { label: '打开 DeepSeek Harness', click: () => this.onShow() },
      { label: '隐藏窗口', click: () => this.onHide() },
      { type: 'separator' },
      { label: `Agent：${status}`, enabled: false },
      { label: '重新启动 Agent', click: () => this.onRestart() },
      { label: '在浏览器中打开', click: () => this.onOpenBrowser() },
      { type: 'separator' },
      { label: '退出', click: () => this.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy() {
    this.tray.destroy();
  }
}

module.exports = { TrayManager };
