'use strict';
const fs = require('fs');
const path = require('path');
const { getLogsDir } = require('./paths');

class Logger {
  constructor(name) {
    this.name = name;
    const file = path.join(getLogsDir(), name);
    this.stream = fs.createWriteStream(file, { flags: 'a' });
  }

  _write(level, message) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    try {
      this.stream.write(line);
    } catch (_) {
      /* logging must never crash the app */
    }
  }

  info(m) { this._write('INFO', m); }
  warn(m) { this._write('WARN', m); }
  error(m) { this._write('ERROR', m); }

  close() {
    try { this.stream.end(); } catch (_) {}
  }
}

const cache = new Map();

function getLogger(name) {
  if (!cache.has(name)) cache.set(name, new Logger(name));
  return cache.get(name);
}

function closeAll() {
  for (const l of cache.values()) l.close();
  cache.clear();
}

module.exports = { Logger, getLogger, closeAll };
