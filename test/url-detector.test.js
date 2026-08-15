'use strict';
// Minimal assertions for the pure URL parser (no test framework needed).
const assert = require('assert');
const { detectUrl, DEFAULT_URL } = require('../src/utils/url-detector');

const cases = [
  ['dsh web: http://127.0.0.1:3080', 'http://127.0.0.1:3080'],
  ['dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)', 'http://127.0.0.1:3080'],
  ['dsh web: http://localhost:8080', 'http://localhost:8080'],
  ['some unrelated log line', null],
  ['http://example.com:3000', null], // non-loopback host ignored
  [12345, null],
];

for (const [input, expected] of cases) {
  const got = detectUrl(input);
  assert.strictEqual(got, expected, `detectUrl(${JSON.stringify(input)}) => ${got}, want ${expected}`);
}

assert.strictEqual(DEFAULT_URL, 'http://127.0.0.1:3080');
console.log(`url-detector: ${cases.length} cases passed`);
