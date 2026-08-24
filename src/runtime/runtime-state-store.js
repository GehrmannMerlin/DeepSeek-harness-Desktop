'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');
const semver = require('semver');

const SCHEMA_VERSION = 1;
const RUNTIME_KINDS = new Set(['managed', 'bundled', 'legacy']);

function createDefaultRuntimeState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    current: null,
    previous: null,
    pending: null,
    failedVersions: {},
    lastNotifiedVersion: null,
  };
}

function isRuntimeReference(value) {
  return value === null || (
    value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.relativePath === 'string' && value.relativePath.trim().length > 0 &&
    !path.isAbsolute(value.relativePath) &&
    RUNTIME_KINDS.has(value.kind) &&
    (value.kind === 'legacy' ? (value.version === 'unknown' || semver.valid(value.version) !== null) : semver.valid(value.version) !== null)
  );
}

function isValidRuntimeState(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    value.schemaVersion === SCHEMA_VERSION &&
    isRuntimeReference(value.current) &&
    isRuntimeReference(value.previous) &&
    isRuntimeReference(value.pending) &&
    value.failedVersions && typeof value.failedVersions === 'object' && !Array.isArray(value.failedVersions) &&
    Object.keys(value.failedVersions).every((version) => semver.valid(version) !== null) &&
    (value.lastNotifiedVersion === null || semver.valid(value.lastNotifiedVersion) !== null));
}

function copyState(state) {
  return JSON.parse(JSON.stringify(state));
}

class RuntimeStateStore {
  constructor({ filePath, fsImpl = fs, logger = console }) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('filePath is required');
    this.filePath = filePath;
    this.fs = fsImpl;
    this.logger = logger;
  }

  async load() {
    let raw;
    try {
      raw = await this.fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this.logger.error('Runtime state file missing; using defaults', this.filePath);
        return createDefaultRuntimeState();
      }
      this.logger.error('Unable to read runtime state; using defaults', error);
      return createDefaultRuntimeState();
    }
    let state;
    try {
      state = JSON.parse(raw);
    } catch (error) {
      this.logger.error('Unable to parse runtime state; using defaults', error);
      return createDefaultRuntimeState();
    }
    if (!isValidRuntimeState(state)) {
      this.logger.error('Invalid runtime state schema; using defaults');
      return createDefaultRuntimeState();
    }
    return copyState(state);
  }

  async save(state) {
    if (!isValidRuntimeState(state)) throw new TypeError('Invalid runtime state');
    const temporaryPath = `${this.filePath}.tmp`;
    await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    let handle;
    try {
      handle = await this.fs.open(temporaryPath, 'w');
      await handle.writeFile(serialized, 'utf8');
      await handle.close();
      handle = undefined;
      await this.fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await this.fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async update(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
    const state = await this.load();
    const result = await mutator(copyState(state));
    if (!isValidRuntimeState(result)) throw new TypeError('Mutator returned invalid runtime state');
    const savedState = copyState(result);
    await this.save(savedState);
    return savedState;
  }
}

module.exports = {
  SCHEMA_VERSION,
  RuntimeStateStore,
  createDefaultRuntimeState,
  isValidRuntimeState,
};
