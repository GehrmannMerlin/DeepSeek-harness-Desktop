'use strict';
const fs = require('fs');
const path = require('path');

// Lightweight monotonic boot timeline. T0 is captured at first require, which
// happens at the very top of main.js before any Electron API is touched, so
// `process_start` ≈ the real process start.
//
// All marks are buffered until attach() opens the backing file (the logs dir
// only becomes known after app.whenReady()). Buffering keeps the millisecond
// offsets accurate even though the file is opened a little later.
const T0 = Date.now();
const buffer = [];
let stream = null;
let onMark = null; // optional forwarder (e.g. application.log) once available

function line(entry) {
  return `[BOOT +${String(entry.ms).padStart(6)}ms] ${entry.name}${entry.extra ? ' ' + entry.extra : ''}\n`;
}

// Record an event. `extra` is an optional string (e.g. window state or a URL).
function mark(name, extra) {
  const entry = { ms: Date.now() - T0, name, extra };
  buffer.push(entry);
  if (stream) stream.write(line(entry));
  if (onMark) onMark(line(entry).trim());
  return entry;
}

// Open the durable boot.log and flush everything buffered so far.
function attach(logsDir, forwarder) {
  if (forwarder) onMark = forwarder;
  if (stream) return;
  try {
    stream = fs.createWriteStream(path.join(logsDir, 'boot.log'), { flags: 'a' });
    for (const e of buffer) stream.write(line(e));
  } catch (_) {
    /* timeline must never break the app */
  }
}

// Human-readable snapshot for on-demand logging.
function dump() {
  return buffer.map(line).join('');
}

module.exports = { mark, attach, dump, T0 };
