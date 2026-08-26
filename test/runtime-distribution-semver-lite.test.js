'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { valid, rcompare } = require('../scripts/runtime-distribution/semver-lite');

test('semver-lite accepts canonical exact versions and rejects ranges or non-canonical forms', () => {
  for (const version of ['0.1.1-rc.2', '1.2.3', '1.2.3+build.7', '10.20.30-alpha.1+build']) {
    assert.equal(valid(version), version);
  }
  for (const version of ['', 'v0.1.1', '0.1', '01.2.3', '1.2.3-01', '^1.2.3', '>=1.0.0', 'not-semver']) {
    assert.equal(valid(version), null);
  }
});

test('semver-lite compares release and prerelease versions in descending order', () => {
  const versions = ['0.1.0-rc.7', '0.1.1', '0.1.1-rc.2', '0.1.1-rc.10', '0.1.1-rc.2+build.9'];
  assert.deepEqual(versions.slice().sort(rcompare), [
    '0.1.1', '0.1.1-rc.10', '0.1.1-rc.2', '0.1.1-rc.2+build.9', '0.1.0-rc.7',
  ]);
});

test('promotion CLI loads when the external semver package is unavailable', () => {
  const script = [
    "const Module = require('node:module');",
    "const load = Module._load;",
    "Module._load = function(request, parent, isMain) { if (request === 'semver') throw new Error('semver blocked'); return load.apply(this, arguments); };",
    "require('./scripts/runtime-distribution/runtime-distribution-cli');",
    "process.stdout.write('loaded');",
  ].join(' ');
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(output, 'loaded');
});
