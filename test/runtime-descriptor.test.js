'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRuntimeDescriptor,
  isRuntimeDescriptor,
  descriptorToState,
} = require('../src/runtime/runtime-descriptor');

test('creates and validates a managed descriptor', () => {
  const descriptor = createRuntimeDescriptor({
    kind: 'managed',
    version: '1.2.3',
    rootPath: 'C:\\dsh\\1.2.3',
    packagePath: 'C:\\dsh\\1.2.3\\node_modules\\@deepseek-ai\\dsh',
    cliEntry: 'C:\\dsh\\1.2.3\\node_modules\\@deepseek-ai\\dsh\\bin\\dsh.js',
    args: ['--desktop'],
    command: 'C:\\Program Files\\nodejs\\node.exe',
    source: 'managed',
  });

  assert.deepEqual(descriptor.args, ['--desktop']);
  assert.equal(descriptor.kind, 'managed');
  assert.equal(descriptor.version, '1.2.3');
  assert.equal(descriptor.source, 'managed');
  assert.equal(isRuntimeDescriptor(descriptor), true);
  assert.deepEqual(descriptorToState(descriptor, '1.2.3'), {
    relativePath: '1.2.3',
    kind: 'managed',
    version: '1.2.3',
  });
});

test('rejects an unknown kind, invalid version, and relative required path', () => {
  const base = {
    kind: 'managed',
    version: '1.2.3',
    rootPath: 'C:\\dsh\\1.2.3',
    packagePath: 'C:\\dsh\\1.2.3\\package',
    cliEntry: 'C:\\dsh\\1.2.3\\bin\\dsh.js',
    args: [],
    command: 'node',
    source: 'managed',
  };

  assert.throws(() => createRuntimeDescriptor({ ...base, kind: 'other', source: 'other' }), /kind/);
  assert.throws(() => createRuntimeDescriptor({ ...base, version: 'not-semver' }), /version/);
  assert.throws(() => createRuntimeDescriptor({ ...base, rootPath: 'relative/path' }), /absolute/);
});

