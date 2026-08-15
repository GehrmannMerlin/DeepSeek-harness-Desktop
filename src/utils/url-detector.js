'use strict';

// Default URL when stdout never yields one. The real default comes from the
// dsh web bundle: host 127.0.0.1, port 3080 (not 13080 as sometimes assumed).
const DEFAULT_URL = 'http://127.0.0.1:3080';

// Matches the loopback URL dsh-web-app prints, e.g.:
//   dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)
const LOOPBACK_URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}/;

function detectUrl(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(LOOPBACK_URL_RE);
  return m ? m[0] : null;
}

module.exports = { DEFAULT_URL, detectUrl };
