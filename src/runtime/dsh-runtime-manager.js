'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');
const semver = require('semver');

const { createRuntimeDescriptor, descriptorToState } = require('./runtime-descriptor');
const { RuntimeStateStore, createDefaultRuntimeState } = require('./runtime-state-store');
const { resolveLegacyCommand, resolveNodeCommand } = require('../utils/npx-resolver');

const PACKAGE_SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh'];

function isPathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function directChildPath(parent, name) {
  if (typeof name !== 'string' || name.length === 0 || path.isAbsolute(name)) return null;
  const resolvedParent = path.resolve(parent);
  const candidate = path.resolve(resolvedParent, name);
  return isPathWithin(resolvedParent, candidate) && path.dirname(candidate) === resolvedParent ? candidate : null;
}

function referencePaths(state) {
  return [state.current, state.previous, state.pending]
    .filter((reference) => reference && typeof reference.relativePath === 'string')
    .map((reference) => reference.relativePath);
}

function failedAt() {
  return new Date().toISOString();
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
    const rootPath = directChildPath(versionsDir, version);
    if (!rootPath || !(await this.inspectManagedRoot(rootPath, versionsDir)).safe) return null;
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
        args: [cliEntry, 'web'],
        command,
        source: kind,
      });
    } catch {
      return null;
    }
  }

  async getState() {
    try {
      return await this.stateStore.load();
    } catch (error) {
      this.logger.error('Unable to load runtime state; using defaults', error);
      return createDefaultRuntimeState();
    }
  }

  async promoteStaging(stagingRoot, version) {
    if (typeof version !== 'string' || !semver.valid(version)) {
      throw new TypeError('Runtime version must be valid SemVer');
    }
    const stagingDir = path.join(this.runtimeRoot, 'staging');
    const versionsDir = path.join(this.runtimeRoot, 'versions');
    const resolvedStaging = typeof stagingRoot === 'string' ? path.resolve(stagingRoot) : null;
    if (!resolvedStaging || !isPathWithin(path.resolve(stagingDir), resolvedStaging) ||
        path.dirname(resolvedStaging) !== path.resolve(stagingDir) ||
        !path.basename(resolvedStaging).startsWith(`${version}-`)) {
      throw new TypeError('Staging runtime must be a direct child of runtime staging');
    }

    if (!(await this.inspectManagedRoot(resolvedStaging, stagingDir)).safe) {
      throw new Error('Staging runtime root is unsafe');
    }
    const validatedStaging = await this.validateRuntime(resolvedStaging, version, 'managed');
    if (!validatedStaging) throw new Error('Staging runtime failed validation');

    const targetRoot = directChildPath(versionsDir, version);
    if (!targetRoot) throw new Error('Invalid managed runtime target');
    await this.fs.mkdir(versionsDir, { recursive: true });
    const targetInspection = await this.inspectManagedRoot(targetRoot, versionsDir);
    if (targetInspection.exists && !targetInspection.safeForRename) {
      throw new Error('Managed runtime target is unsafe');
    }
    if (targetInspection.exists) {
      const existing = targetInspection.safe && await this.validateRuntime(targetRoot, version, 'managed');
      if (existing) return existing;
      await this.isolateInvalidTarget(versionsDir, targetRoot, version);
    }

    const stagingBeforeRename = await this.inspectManagedRoot(resolvedStaging, stagingDir);
    const targetBeforeRename = await this.inspectManagedRoot(targetRoot, versionsDir);
    if (!stagingBeforeRename.safe || targetBeforeRename.exists || !targetBeforeRename.safe) {
      throw new Error('Runtime promotion paths escaped their expected roots');
    }
    await this.fs.rename(resolvedStaging, targetRoot);
    if (!(await this.inspectManagedRoot(targetRoot, versionsDir)).safe) {
      throw new Error('Promoted runtime root is unsafe');
    }
    const promoted = await this.validateRuntime(targetRoot, version, 'managed');
    if (!promoted) throw new Error('Promoted runtime failed validation');
    return promoted;
  }

  async isolateInvalidTarget(versionsDir, targetRoot, version) {
    const resolvedVersions = path.resolve(versionsDir);
    if (!isPathWithin(resolvedVersions, targetRoot) || path.dirname(targetRoot) !== resolvedVersions) {
      throw new Error('Invalid runtime isolation target');
    }
    const targetInspection = await this.inspectManagedRoot(targetRoot, versionsDir);
    if (!targetInspection.exists || !targetInspection.safeForRename) {
      throw new Error('Invalid runtime isolation target');
    }
    let attempt = 0;
    while (true) {
      const suffix = attempt === 0 ? `${Date.now()}` : `${Date.now()}-${attempt}`;
      const isolated = directChildPath(versionsDir, `${version}.invalid-${suffix}`);
      if (!isolated) throw new Error('Invalid isolated runtime target');
      try {
        await this.fs.rename(targetRoot, isolated);
        return isolated;
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
  }

  async activateRuntime(descriptor) {
    const managed = await this.validManagedDescriptor(descriptor);
    if (!managed) throw new Error('Cannot activate an invalid managed runtime');
    return this.stateStore.update((state) => ({
      ...state,
      current: descriptorToState(managed, managed.version),
      previous: state.current || null,
      pending: null,
    }));
  }

  async rollbackRuntime() {
    const state = await this.getState();
    const previous = await this.resolveStateDescriptor(state.previous);
    const selected = previous || await this.resolveBundledFallback();
    if (!selected) {
      const error = new Error('No validated runtime is available for rollback');
      error.code = 'RUNTIME_ROLLBACK_UNAVAILABLE';
      throw error;
    }
    const relativePath = selected.kind === 'managed' ? selected.version : 'bundled';
    return this.stateStore.update((currentState) => {
      const failedVersions = { ...currentState.failedVersions };
      if (currentState.current && semver.valid(currentState.current.version)) {
        failedVersions[currentState.current.version] = failedAt();
      }
      return {
        ...currentState,
        current: descriptorToState(selected, relativePath),
        pending: null,
        failedVersions,
      };
    }).then(() => selected);
  }

  async recordPending(descriptor) {
    const managed = await this.validManagedDescriptor(descriptor);
    if (!managed) throw new Error('Cannot record an invalid managed runtime as pending');
    await this.stateStore.update((state) => ({
      ...state,
      pending: descriptorToState(managed, managed.version),
    }));
  }

  async consumePendingIfValid() {
    const state = await this.getState();
    const pending = await this.resolveStateDescriptor(state.pending);
    if (pending && pending.kind === 'managed') return pending;
    if (!state.pending) return null;
    await this.stateStore.update((currentState) => {
      const failedVersions = { ...currentState.failedVersions };
      if (currentState.pending && semver.valid(currentState.pending.version)) {
        failedVersions[currentState.pending.version] = failedAt();
      }
      return { ...currentState, pending: null, failedVersions };
    });
    this.logger.error('Pending runtime failed local validation and was cleared');
    return null;
  }

  async cleanupStaging({ olderThanMs = 24 * 60 * 60 * 1000, activeOperationId } = {}) {
    const stagingDir = path.resolve(this.runtimeRoot, 'staging');
    const cutoff = Date.now() - (Number.isFinite(olderThanMs) && olderThanMs >= 0 ? olderThanMs : 24 * 60 * 60 * 1000);
    const state = await this.getState();
    const protectedPaths = new Set(referencePaths(state)
      .map((relativePath) => path.resolve(this.runtimeRoot, relativePath))
      .filter((candidate) => isPathWithin(stagingDir, candidate) && path.dirname(candidate) === stagingDir));
    const deleted = [];
    let entries;
    try {
      entries = await this.fs.readdir(stagingDir, { withFileTypes: true });
    } catch (error) {
      if (!error || error.code !== 'ENOENT') this.logger.error('Unable to inspect runtime staging', error);
      return deleted;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === activeOperationId ||
          (typeof activeOperationId === 'string' && entry.name.endsWith(`-${activeOperationId}`))) continue;
      const candidate = directChildPath(stagingDir, entry.name);
      if (!candidate || protectedPaths.has(candidate)) continue;
      try {
        const stats = await this.fs.stat(candidate);
        if (stats.mtimeMs > cutoff) continue;
        if (!isPathWithin(stagingDir, candidate) || path.dirname(candidate) !== stagingDir) continue;
        await this.fs.rm(candidate, { recursive: true, force: true });
        deleted.push(candidate);
      } catch (error) {
        this.logger.error('Unable to clean stale runtime staging directory', error);
      }
    }
    return deleted;
  }

  async cleanupOldVersions({ keepCount = 2 } = {}) {
    const versionsDir = path.resolve(this.runtimeRoot, 'versions');
    const state = await this.getState();
    const protectedPaths = new Set(referencePaths(state)
      .map((relativePath) => path.resolve(this.runtimeRoot, 'versions', relativePath))
      .filter((candidate) => isPathWithin(versionsDir, candidate) && path.dirname(candidate) === versionsDir));
    let entries;
    try {
      entries = await this.fs.readdir(versionsDir, { withFileTypes: true });
    } catch (error) {
      if (!error || error.code !== 'ENOENT') this.logger.error('Unable to inspect managed runtime versions', error);
      return [];
    }
    const valid = [];
    for (const entry of entries) {
      const candidate = entry.isDirectory() && semver.valid(entry.name) ? directChildPath(versionsDir, entry.name) : null;
      if (!candidate) continue;
      if (await this.validateRuntime(candidate, entry.name, 'managed')) valid.push({ version: entry.name, rootPath: candidate });
    }
    valid.sort((left, right) => semver.rcompare(left.version, right.version));
    const retainedNewest = new Set(valid.slice(0, Math.max(0, Math.floor(keepCount))).map(({ rootPath }) => rootPath));
    const deleted = [];
    for (const { rootPath } of valid) {
      if (protectedPaths.has(rootPath) || retainedNewest.has(rootPath)) continue;
      if (!isPathWithin(versionsDir, rootPath) || path.dirname(rootPath) !== versionsDir) continue;
      try {
        await this.fs.rm(rootPath, { recursive: true, force: true });
        deleted.push(rootPath);
      } catch (error) {
        this.logger.error('Unable to clean old managed runtime version', error);
      }
    }
    return deleted;
  }

  async validManagedDescriptor(descriptor) {
    if (!descriptor || descriptor.kind !== 'managed' || !semver.valid(descriptor.version)) return null;
    const managed = await this.resolveManagedRuntime(descriptor.version);
    return managed && managed.rootPath === descriptor.rootPath ? managed : null;
  }

  async resolveStateDescriptor(reference) {
    if (!reference || typeof reference !== 'object') return null;
    if (reference.kind === 'managed' && reference.relativePath === reference.version) {
      return this.resolveManagedRuntime(reference.version);
    }
    if (reference.kind === 'bundled') return this.resolveBundledFallback();
    return null;
  }

  async inspectManagedRoot(rootPath, parentPath) {
    const resolvedParent = path.resolve(parentPath);
    const resolvedRoot = typeof rootPath === 'string' ? path.resolve(rootPath) : null;
    if (!resolvedRoot || !isPathWithin(resolvedParent, resolvedRoot) || path.dirname(resolvedRoot) !== resolvedParent) {
      return { exists: false, safe: false, safeForRename: false };
    }
    try {
      const [runtimeRealPath, parentStats, parentRealPath] = await Promise.all([
        this.fs.realpath(this.runtimeRoot),
        this.fs.lstat(resolvedParent),
        this.fs.realpath(resolvedParent),
      ]);
      if (!parentStats.isDirectory() || parentStats.isSymbolicLink() ||
          !isPathWithin(runtimeRealPath, parentRealPath) && runtimeRealPath !== parentRealPath) {
        return { exists: false, safe: false, safeForRename: false };
      }
    } catch {
      return { exists: false, safe: false, safeForRename: false };
    }
    let rootStats;
    try {
      rootStats = await this.fs.lstat(resolvedRoot);
    } catch (error) {
      return error && error.code === 'ENOENT'
        ? { exists: false, safe: true, safeForRename: true }
        : { exists: false, safe: false, safeForRename: false };
    }
    if (rootStats.isSymbolicLink()) return { exists: true, safe: false, safeForRename: false };
    try {
      const [runtimeRealPath, rootRealPath] = await Promise.all([
        this.fs.realpath(this.runtimeRoot),
        this.fs.realpath(resolvedRoot),
      ]);
      const physicallyContained = isPathWithin(runtimeRealPath, rootRealPath);
      return {
        exists: true,
        safe: rootStats.isDirectory() && physicallyContained,
        safeForRename: physicallyContained,
      };
    } catch {
      return { exists: true, safe: false, safeForRename: false };
    }
  }
}

module.exports = { DshRuntimeManager };
