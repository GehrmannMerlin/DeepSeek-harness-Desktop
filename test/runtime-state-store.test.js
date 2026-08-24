'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createDefaultRuntimeState,
  RuntimeStateStore,
} = require('../src/runtime/runtime-state-store');
const { withTempDir } = require('./test-helpers');

test('missing state returns defaults without throwing', async () => {
  await withTempDir(async (directory) => {
    const store = new RuntimeStateStore({ filePath: path.join(directory, 'nested', 'state.json') });
    assert.deepEqual(await store.load(), createDefaultRuntimeState());
  });
});

test('save leaves valid JSON and no .tmp file', async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, 'nested', 'state.json');
    const store = new RuntimeStateStore({ filePath });
    const state = createDefaultRuntimeState();
    state.current = { relativePath: '1.2.3', kind: 'managed', version: '1.2.3' };
    await store.save(state);
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), state);
    await assert.rejects(fs.stat(`${filePath}.tmp`), { code: 'ENOENT' });
  });
});

test('corrupt JSON returns defaults and logs the parse failure', async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, 'state.json');
    await fs.writeFile(filePath, '{broken', 'utf8');
    const errors = [];
    const store = new RuntimeStateStore({ filePath, logger: { error: (...args) => errors.push(args) } });
    assert.deepEqual(await store.load(), createDefaultRuntimeState());
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /state/i);
  });
});

test('update validates and atomically persists the mutation', async () => {
  await withTempDir(async (directory) => {
    const store = new RuntimeStateStore({ filePath: path.join(directory, 'state.json') });
    const result = await store.update((state) => ({
      ...state,
      current: { relativePath: '2.0.0', kind: 'managed', version: '2.0.0' },
      pending: { relativePath: '3.0.0', kind: 'bundled', version: '3.0.0' },
    }));
    assert.equal(result.current.version, '2.0.0');
    assert.equal((await store.load()).pending.version, '3.0.0');
    await assert.rejects(fs.stat(`${store.filePath}.tmp`), { code: 'ENOENT' });
  });
});

