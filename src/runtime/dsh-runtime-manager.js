'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');
const semver = require('semver');

const { createRuntimeDescriptor } = require('./runtime-descriptor');
const { RuntimeStateStore } = require('./runtime-state-store');
const { resolveLegacyCommand, resolveNodeCommand } = require('../utils/npx-resolver');

const PACKAGE_SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh'];

function isPathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

class DshRuntimeManager {
  constructor({
    stateStore,
    runtimeRoot,
    bundledRoot,
    legacyResolver = resolveLegacyCommand,
    nodeCommandResolver = resolveNodeCommand,
    logger = console,
    fsImpl = fs,
  } = {}) {
    if (!runtimeRoot || !bundledRoot || !stateStore) {
      const {
        getRuntimeRoot,
        getRuntimeStatePath,
        getBundledRuntimeRoot,
      } = require('../utils/paths');
      runtimeRoot ||= getRuntimeRoot();
      bundledRoot ||= getBundledRuntimeRoot();
      stateStore ||= new RuntimeStateStore({ filePath: getRuntimeStatePath(), fsImpl, logger });
    }
    this.runtimeRoot = runtimeRoot;
    this.bundledRoot = bundledRoot;
    this.stateStore = stateStore;
    this.legacyResolver = legacyResolver;
    this.nodeCommandResolver = nodeCommandResolver;
    this.logger = logger;
    this.fs = fsImpl;
  }

  async resolveCurrentRuntime() {
    let state;
    try {
      state = await this.stateStore.load();
    } catch (error) {
      this.logger.error('Unable to load runtime state; ignoring managed runtime', error);
    }

    if (state && state.current !== null && state.current !== undefined) {
      const current = state.current;
      if (current.kind !== 'managed' || !semver.valid(current.version) ||
          typeof current.relativePath !== 'string' || path.isAbsolute(current.relativePath) ||
          current.relativePath !== current.version) {
        this.logger.error('Invalid managed runtime state; ignoring managed runtime');
      } else {
        const managed = await this.resolveManagedRuntime(current.version);
        if (managed) return managed;
        this.logger.error('Managed runtime state did not resolve; ignoring managed runtime', current.version);
      }
    }

    const bundled = await this.resolveBundledFallback();
    if (bundled) return bundled;

    const legacy = this.legacyResolver();
    return createRuntimeDescriptor({
      kind: 'legacy',
      version: 'unknown',
      args: legacy.args,
      command: legacy.command,
      source: 'system-npx',
    });
  }

  async resolveBundledFallback() {
    const packagePath = path.join(this.bundledRoot, ...PACKAGE_SEGMENTS, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(await this.fs.readFile(packagePath, 'utf8'));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') this.logger.error('Invalid bundled runtime manifest', error);
      return null;
    }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) || typeof pkg.version !== 'string') {
      this.logger.error('Invalid bundled runtime manifest');
      return null;
    }
    const descriptor = await this.validateRuntime(this.bundledRoot, pkg.version, 'bundled');
    if (!descriptor) this.logger.error('Invalid bundled runtime');
    return descriptor;
  }

  async resolveManagedRuntime(version) {
    if (typeof version !== 'string' || !semver.valid(version) || path.isAbsolute(version) ||
        version.includes('/') || version.includes('\\')) return null;
    const versionsDir = path.join(this.runtimeRoot, 'versions');
    const rootPath = path.resolve(versionsDir, version);
    if (!isPathWithin(versionsDir, rootPath)) return null;
    return this.validateRuntime(rootPath, version, 'managed');
  }

  async validateRuntime(rootPath, expectedVersion, kind = 'managed') {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || !semver.valid(expectedVersion) ||
        (kind !== 'managed' && kind !== 'bundled')) return null;

    const packageRoot = path.join(rootPath, ...PACKAGE_SEGMENTS);
    const packagePath = path.join(packageRoot, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(await this.fs.readFile(packagePath, 'utf8'));
    } catch {
      return null;
    }
    if (!pkg || pkg.name !== '@deepseek-ai/dsh' || pkg.version !== expectedVersion || !semver.valid(pkg.version)) return null;

    const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && typeof pkg.bin.dsh === 'string' ? pkg.bin.dsh : null;
    if (!binEntry) return null;
    const cliEntry = path.resolve(packageRoot, binEntry);
    if (!isPathWithin(packageRoot, cliEntry)) return null;
    try {
      const stats = await this.fs.stat(cliEntry);
      if (!stats.isFile()) return null;
      const command = await this.nodeCommandResolver();
      return createRuntimeDescriptor({
        kind,
        version: pkg.version,
        rootPath,
        packagePath: packageRoot,
        cliEntry,
        args: [cliEntry],
        command,
        source: kind,
      });
    } catch {
      return null;
    }
  }
}

module.exports = { DshRuntimeManager };
