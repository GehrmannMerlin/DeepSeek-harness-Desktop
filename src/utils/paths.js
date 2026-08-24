'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// Project root in dev; the asar root when packaged (Electron reads through asar).
const APP_ROOT = path.join(__dirname, '..', '..');

function asset(name) {
  return path.join(APP_ROOT, 'assets', name);
}

function renderer(name) {
  return path.join(APP_ROOT, 'renderer', name);
}

function getLogsDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRuntimeRoot() {
  return path.join(app.getPath('userData'), 'runtime');
}

function getManagedVersionsDir() {
  return path.join(getRuntimeRoot(), 'versions');
}

function getStagingDir() {
  return path.join(getRuntimeRoot(), 'staging');
}

function getRuntimeStatePath() {
  return path.join(getRuntimeRoot(), 'state.json');
}

function getBundledRuntimeRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-runtime')
    : path.join(APP_ROOT, 'build', 'bundled-runtime');
}

module.exports = {
  APP_ROOT,
  asset,
  renderer,
  getLogsDir,
  getRuntimeRoot,
  getManagedVersionsDir,
  getStagingDir,
  getRuntimeStatePath,
  getBundledRuntimeRoot,
};
