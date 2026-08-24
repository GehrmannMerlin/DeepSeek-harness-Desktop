'use strict';
const { Tray, Menu } = require('electron');

// Owns the system tray icon and its dynamic menu. Actions are injected as
// callbacks so the tray never touches child_process or the window directly.
class TrayManager {
  constructor({
    iconPath,
    appName,
    getStatusLabel,
    getRuntimeVersion,
    getUpdateMenuItem,
    onCheckForUpdates,
    onUpdate,
    onShow,
    onHide,
    onRestart,
    onOpenBrowser,
    onQuit,
  }) {
    this.getStatusLabel = getStatusLabel;
    this.getRuntimeVersion = getRuntimeVersion;
    this.getUpdateMenuItem = getUpdateMenuItem;
    this.onCheckForUpdates = onCheckForUpdates;
    this.onUpdate = onUpdate;
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
    const version = this.getRuntimeVersion ? this.getRuntimeVersion() : '未知';
    const updateItem = normalizeUpdateMenuItem(this.getUpdateMenuItem, this.onUpdate);
    this.tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate({
      version,
      status,
      updateItem,
      onCheckForUpdates: this.onCheckForUpdates,
      onShow: this.onShow,
      onHide: this.onHide,
      onRestart: this.onRestart,
      onOpenBrowser: this.onOpenBrowser,
      onQuit: this.onQuit,
    })));
  }

  destroy() {
    this.tray.destroy();
  }
}

function normalizeUpdateMenuItem(getUpdateMenuItem, onUpdate) {
  if (typeof getUpdateMenuItem !== 'function') return null;
  const item = getUpdateMenuItem();
  if (!item) return null;
  if (typeof item === 'string') return { label: item, click: () => onUpdate && onUpdate() };
  if (typeof item !== 'object' || !item.label) return null;
  return {
    ...item,
    click: item.click || (() => onUpdate && onUpdate()),
  };
}

function buildTrayTemplate({
  version = '未知',
  status = '未知',
  updateItem = null,
  update = null,
  onCheckForUpdates,
  onShow,
  onHide,
  onRestart,
  onOpenBrowser,
  onQuit,
} = {}) {
  const resolvedUpdate = updateItem || (update
    ? { label: typeof update === 'string' ? `⬆ 更新到 ${update}` : update.label, click: update.click }
    : null);
  const menu = [
    { label: '打开 DeepSeek Harness', click: () => onShow && onShow() },
    { label: '隐藏窗口', click: () => onHide && onHide() },
    { type: 'separator' },
    { label: `DSH Runtime：${version}`, enabled: false },
    { label: `Agent：${status}`, enabled: false },
    { label: '检查更新', click: () => onCheckForUpdates && onCheckForUpdates() },
  ];
  if (resolvedUpdate && resolvedUpdate.label) menu.push(resolvedUpdate);
  menu.push(
    { label: '重新启动 Agent', click: () => onRestart && onRestart() },
    { label: '在浏览器中打开', click: () => onOpenBrowser && onOpenBrowser() },
    { type: 'separator' },
    { label: '退出', click: () => onQuit && onQuit() },
  );
  return menu;
}

module.exports = { TrayManager, buildTrayTemplate };
