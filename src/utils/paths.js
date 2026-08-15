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

module.exports = { APP_ROOT, asset, renderer, getLogsDir };
