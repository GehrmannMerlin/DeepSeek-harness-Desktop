'use strict';

const path = require('node:path');
const semver = require('semver');
const { EventEmitter } = require('node:events');

const { PACKAGE_NAME } = require('./npm-registry-update-source');

const STATES = Object.freeze({
  IDLE: 'IDLE',
  CHECKING: 'CHECKING',
  UP_TO_DATE: 'UP_TO_DATE',
  UPDATE_AVAILABLE: 'UPDATE_AVAILABLE',
  PREPARING: 'PREPARING',
  INSTALLING: 'INSTALLING',
  VERIFYING: 'VERIFYING',
  READY_TO_APPLY: 'READY_TO_APPLY',
  WAITING_FOR_EXTERNAL_HARNESS: 'WAITING_FOR_EXTERNAL_HARNESS',
  STOPPING_CURRENT: 'STOPPING_CURRENT',
  SWITCHING: 'SWITCHING',
  RESTARTING: 'RESTARTING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  ROLLING_BACK: 'ROLLING_BACK',
  ROLLED_BACK: 'ROLLED_BACK',
});

const DAY_MS = 24 * 60 * 60 * 1000;

const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.IDLE]: new Set([STATES.CHECKING, STATES.READY_TO_APPLY]),
  [STATES.CHECKING]: new Set([STATES.UP_TO_DATE, STATES.UPDATE_AVAILABLE, STATES.FAILED]),
  [STATES.UP_TO_DATE]: new Set([STATES.CHECKING, STATES.READY_TO_APPLY]),
  [STATES.UPDATE_AVAILABLE]: new Set([STATES.CHECKING, STATES.PREPARING, STATES.IDLE, STATES.READY_TO_APPLY]),
  [STATES.PREPARING]: new Set([STATES.INSTALLING, STATES.FAILED]),
  [STATES.INSTALLING]: new Set([STATES.VERIFYING, STATES.FAILED]),
  [STATES.VERIFYING]: new Set([STATES.READY_TO_APPLY, STATES.FAILED]),
  [STATES.READY_TO_APPLY]: new Set([STATES.WAITING_FOR_EXTERNAL_HARNESS, STATES.STOPPING_CURRENT, STATES.FAILED]),
  [STATES.WAITING_FOR_EXTERNAL_HARNESS]: new Set([STATES.CHECKING, STATES.READY_TO_APPLY]),
  [STATES.STOPPING_CURRENT]: new Set([STATES.SWITCHING, STATES.RESTARTING, STATES.ROLLING_BACK, STATES.FAILED]),
  [STATES.SWITCHING]: new Set([STATES.RESTARTING, STATES.ROLLING_BACK, STATES.FAILED]),
  [STATES.RESTARTING]: new Set([STATES.SUCCESS, STATES.ROLLING_BACK, STATES.ROLLED_BACK, STATES.FAILED]),
  [STATES.SUCCESS]: new Set([STATES.CHECKING, STATES.READY_TO_APPLY]),
  [STATES.FAILED]: new Set([STATES.CHECKING, STATES.PREPARING, STATES.READY_TO_APPLY]),
  [STATES.ROLLING_BACK]: new Set([STATES.RESTARTING, STATES.ROLLED_BACK, STATES.FAILED]),
  [STATES.ROLLED_BACK]: new Set([STATES.CHECKING, STATES.READY_TO_APPLY]),
});

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = clone(child);
    return output;
  }
  return value;
}

function errorDetails(error, { fatal = false } = {}) {
  const details = {
    message: error instanceof Error ? error.message : String(error || 'Unknown update error'),
    code: error && typeof error === 'object' && error.code ? error.code : null,
    fatal: Boolean(fatal),
  };
  return details;
}

function makeError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

class DshUpdateManager extends EventEmitter {
  constructor({
    runtimeManager,
    registry,
    installer,
    verifier,
    processManager,
    healthChecker,
    logger = console,
    clock = () => Date.now(),
  } = {}) {
    super();
    for (const [name, dependency] of Object.entries({ runtimeManager, registry, installer, verifier, processManager, healthChecker })) {
      if (!dependency) throw new TypeError(`${name} is required`);
    }
    this.runtimeManager = runtimeManager;
    this.registry = registry;
    this.installer = installer;
    this.verifier = verifier;
    this.processManager = processManager;
    this.healthChecker = healthChecker;
    this.logger = logger;
    this.clock = clock;
    this.operationPromise = null;
    this.operationCounter = 0;
    this.availableEventVersion = null;
    this.notificationVersion = null;
    this.newProcessStarted = false;
    // EventEmitter treats `error` specially and throws when no listener is
    // attached. Update failures must remain observable without crashing the
    // main process when no UI has subscribed yet.
    this.on('error', () => {});
    this.snapshot = {
      state: STATES.IDLE,
      currentRuntime: null,
      latest: null,
      preparedRuntime: null,
      updateAvailable: false,
      pending: false,
      operationId: null,
      progress: null,
      error: null,
      lastCheckedAt: null,
    };
  }

  getSnapshot() {
    return clone(this.snapshot);
  }

  checkForUpdates({ manual = false } = {}) {
    return this._runOperation(() => this._checkForUpdates({ manual: Boolean(manual) }));
  }

  confirmUpdate() {
    return this._runOperation(() => this._confirmUpdate());
  }

  cancelUpdate() {
    return this._runOperation(async () => {
      if (this.snapshot.state === STATES.UPDATE_AVAILABLE) {
        this._transition(STATES.IDLE, {
          latest: null,
          updateAvailable: false,
          error: null,
          progress: null,
        });
      }
      return this.getSnapshot();
    });
  }

  recoverPendingActivation() {
    return this._runOperation(() => this._recoverPendingActivation());
  }

  _runOperation(operation) {
    if (this.operationPromise) return this.operationPromise;
    const promise = Promise.resolve().then(operation);
    const settled = promise.finally(() => {
      if (this.operationPromise === settled) this.operationPromise = null;
    });
    this.operationPromise = settled;
    return settled;
  }

  async _checkForUpdates({ manual }) {
    this._transition(STATES.CHECKING, { error: null, progress: { phase: 'checking', version: null } });
    try {
      const currentRuntime = await this.runtimeManager.resolveCurrentRuntime();
      this._patch({ currentRuntime: clone(currentRuntime) });
      const state = typeof this.runtimeManager.getState === 'function'
        ? await this.runtimeManager.getState()
        : { failedVersions: {} };
      const latest = await this.registry.getLatest();
      this._validateLatest(latest);
      this._patch({
        latest: clone(latest),
        lastCheckedAt: this._nowIso(),
        pending: Boolean(state && state.pending),
        error: null,
      });

      const comparison = this._compareLatest(currentRuntime && currentRuntime.version, latest.version);
      if (comparison === 'UPDATE_AVAILABLE') {
        this._transition(STATES.UPDATE_AVAILABLE, {
          updateAvailable: true,
          progress: null,
        });
        this._emitUpdateAvailable(latest, { manual, state });
      } else {
        this._transition(STATES.UP_TO_DATE, {
          updateAvailable: false,
          progress: null,
        });
      }
    } catch (error) {
      return this._handleFailure(error, { manual });
    }
    return this.getSnapshot();
  }

  async _confirmUpdate() {
    if (this.snapshot.state !== STATES.UPDATE_AVAILABLE || !this.snapshot.latest) return this.getSnapshot();

    const latest = clone(this.snapshot.latest);
    const operationId = this._newOperationId(latest.version);
    const stagingRoot = path.join(this._runtimeRoot(), 'staging', `${latest.version}-${operationId}`);
    this._transition(STATES.PREPARING, {
      operationId,
      preparedRuntime: null,
      error: null,
      progress: { phase: 'preparing', version: latest.version },
    });

    let prepared;
    try {
      this._transition(STATES.INSTALLING, { progress: { phase: 'installing', version: latest.version } });
      const installResult = await this.installer.install({
        stagingRoot,
        packageName: PACKAGE_NAME,
        version: latest.version,
      });
      if (!installResult || installResult.ok !== true) {
        throw makeError(this._resultError(installResult, 'Runtime installation failed'), 'RUNTIME_INSTALL_FAILED');
      }

      this._transition(STATES.VERIFYING, { progress: { phase: 'verifying', version: latest.version } });
      const verifyResult = await this._verifyStaging(stagingRoot, latest.version);
      if (!verifyResult || verifyResult.ok !== true) {
        throw makeError(this._resultError(verifyResult, 'Runtime verification failed'), 'RUNTIME_VERIFY_FAILED');
      }

      prepared = await this.runtimeManager.promoteStaging(stagingRoot, latest.version);
      if (!prepared || typeof prepared !== 'object') throw makeError('Runtime promotion returned no descriptor', 'RUNTIME_PROMOTE_FAILED');
      this._transition(STATES.READY_TO_APPLY, {
        preparedRuntime: clone(prepared),
        progress: { phase: 'ready-to-apply', version: latest.version },
      });
    } catch (error) {
      await this._recordFailedVersion(latest.version);
      return this._handleFailure(error, { manual: true });
    }

    if (!this.processManager.ownsHarness()) {
      try {
        await this.runtimeManager.recordPending(prepared);
        this._transition(STATES.WAITING_FOR_EXTERNAL_HARNESS, {
          pending: true,
          progress: null,
        });
      } catch (error) {
        await this._recordFailedVersion(latest.version);
        return this._handleFailure(error, { manual: true });
      }
      return this.getSnapshot();
    }

    return this._applyOwned(prepared, { preservePendingUntilSuccess: false, manual: true });
  }

  async _recoverPendingActivation() {
    if (!this.processManager.ownsHarness()) return this.getSnapshot();
    const pending = await this.runtimeManager.consumePendingIfValid();
    if (!pending) return this.getSnapshot();

    const current = await this.runtimeManager.resolveCurrentRuntime();
    this._transition(STATES.READY_TO_APPLY, {
      preparedRuntime: clone(pending),
      pending: true,
      operationId: this._newOperationId(pending.version),
      error: null,
      progress: { phase: 'ready-to-apply', version: pending.version },
    });
    try {
      this.newProcessStarted = false;
      this._transition(STATES.STOPPING_CURRENT, { progress: { phase: 'stopping', version: pending.version } });
      await this.processManager.stop();
      this._transition(STATES.RESTARTING, { progress: { phase: 'restarting', version: pending.version } });
      await this._startAndCheck(pending);
      await this.runtimeManager.activateRuntime(pending);
      this._transition(STATES.SUCCESS, { currentRuntime: clone(pending), pending: false, progress: null, error: null });
    } catch (error) {
      await this._stopFailedOwnedProcess();
      await this._recordFailedVersion(pending.version);
      this._patch({ currentRuntime: clone(current), preparedRuntime: clone(pending), pending: true });
      return this._handleFailure(error, { manual: false });
    }
    return this.getSnapshot();
  }

  async _applyOwned(prepared, { preservePendingUntilSuccess, manual = false }) {
    let originalError = null;
    try {
      this.newProcessStarted = false;
      this._transition(STATES.STOPPING_CURRENT, { progress: { phase: 'stopping', version: prepared.version } });
      await this.processManager.stop();
      if (!preservePendingUntilSuccess) {
        this._transition(STATES.SWITCHING, { progress: { phase: 'switching', version: prepared.version } });
        await this.runtimeManager.activateRuntime(prepared);
      }
      this._transition(STATES.RESTARTING, { progress: { phase: 'restarting', version: prepared.version } });
      await this._startAndCheck(prepared);
      if (preservePendingUntilSuccess) await this.runtimeManager.activateRuntime(prepared);
      this._transition(STATES.SUCCESS, {
        currentRuntime: clone(prepared),
        preparedRuntime: clone(prepared),
        pending: false,
        progress: null,
        error: null,
      });
      return this.getSnapshot();
    } catch (error) {
      originalError = error;
    }

    await this._recordFailedVersion(prepared.version);
    return this._rollback(originalError, { manual });
  }

  async _rollback(originalError, { manual = false } = {}) {
    this._transition(STATES.ROLLING_BACK, { progress: { phase: 'rolling-back', version: this.snapshot.preparedRuntime && this.snapshot.preparedRuntime.version }, error: errorDetails(originalError) });
    try {
      await this._stopFailedOwnedProcess();
      const fallback = await this.runtimeManager.rollbackRuntime();
      if (!fallback) throw makeError('Runtime rollback returned no descriptor', 'RUNTIME_ROLLBACK_FAILED');
      this._transition(STATES.RESTARTING, { progress: { phase: 'restarting-fallback', version: fallback.version } });
      await this._startAndCheck(fallback);
      this._transition(STATES.ROLLED_BACK, {
        currentRuntime: clone(fallback),
        pending: false,
        progress: null,
        error: errorDetails(originalError),
      });
      return this.getSnapshot();
    } catch (rollbackError) {
      await this._stopFailedOwnedProcess();
      return this._handleFailure(rollbackError, { manual, fatal: true });
    }
  }

  async _stopFailedOwnedProcess() {
    if (this.newProcessStarted && this.processManager.ownsHarness() && this.processManager.getPid && this.processManager.getPid()) {
      await this.processManager.stop();
      this.newProcessStarted = false;
    }
  }

  async _startAndCheck(runtime) {
    const started = await this.processManager.start(runtime);
    if (started === false) throw makeError('New runtime failed to start', 'RUNTIME_START_FAILED');
    this.newProcessStarted = true;
    const url = await this._waitForHarnessUrl();
    if (!url) throw makeError('New runtime did not expose a Harness URL', 'RUNTIME_URL_MISSING');
    const check = typeof this.healthChecker === 'function'
      ? await this.healthChecker(url)
      : await (this.healthChecker.waitUntilReady
        ? this.healthChecker.waitUntilReady(url)
        : this.healthChecker.check(url));
    if (!check || (check.ok !== true && check.ready !== true)) throw makeError('New runtime health check failed', 'RUNTIME_HEALTH_FAILED');
    return check;
  }

  async _waitForHarnessUrl() {
    const current = this.processManager.getUrl && this.processManager.getUrl();
    if (current) return current;
    if (!this.processManager.once) return null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (url) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof this.processManager.removeListener === 'function') {
          this.processManager.removeListener('url-detected', onUrl);
          this.processManager.removeListener('exit', onExit);
        }
        resolve(url || null);
      };
      const onUrl = (url) => finish(url);
      const onExit = () => finish(null);
      const timer = setTimeout(() => finish(null), 5000);
      this.processManager.once('url-detected', onUrl);
      this.processManager.once('exit', onExit);
    });
  }

  async _verifyStaging(stagingRoot, version) {
    const verify = typeof this.verifier === 'function'
      ? this.verifier
      : this.verifier.verify || this.verifier.validate;
    if (typeof verify !== 'function') throw makeError('Runtime verifier has no verify method', 'RUNTIME_VERIFY_UNAVAILABLE');
    const nodeCommand = typeof this.runtimeManager.nodeCommandResolver === 'function'
      ? await this.runtimeManager.nodeCommandResolver()
      : process.execPath;
    return verify({ rootPath: stagingRoot, expectedVersion: version, nodeCommand });
  }

  _validateLatest(latest) {
    if (!latest || typeof latest !== 'object' || (latest.packageName || latest.name) !== PACKAGE_NAME || latest.distTag !== 'latest' || !semver.valid(latest.version)) {
      throw makeError('Registry returned invalid latest metadata', 'INVALID_REGISTRY_RESULT');
    }
  }

  _compareLatest(installedVersion, latestVersion) {
    if (typeof this.registry.compareLatest === 'function') {
      const result = this.registry.compareLatest(installedVersion, latestVersion);
      if (result === 'UPDATE_AVAILABLE' || result === 'UP_TO_DATE' || result === 'AHEAD_OF_LATEST') return result;
    }
    if (!semver.valid(latestVersion)) throw makeError('Registry returned invalid latest SemVer', 'INVALID_REGISTRY_RESULT');
    return !semver.valid(installedVersion) || semver.gt(latestVersion, installedVersion)
      ? 'UPDATE_AVAILABLE'
      : 'UP_TO_DATE';
  }

  _emitUpdateAvailable(latest, { manual, state }) {
    if (this.availableEventVersion !== latest.version) {
      this.availableEventVersion = latest.version;
      this.emit('update-available', { latest: clone(latest), snapshot: this.getSnapshot() });
    }
    if (!this._notificationSuppressed(latest.version, state, manual) && this.notificationVersion !== latest.version) {
      this.notificationVersion = latest.version;
      this.emit('notification', { type: 'update-available', version: latest.version, latest: clone(latest), manual: Boolean(manual) });
    }
  }

  _notificationSuppressed(version, state, manual) {
    if (manual) return false;
    const value = state && state.failedVersions && state.failedVersions[version];
    if (!value) return false;
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(timestamp) && this._now() - timestamp >= 0 && this._now() - timestamp < DAY_MS;
  }

  _handleFailure(error, { manual, fatal = false }) {
    const details = errorDetails(error, { fatal });
    this._logError(details.message, error);
    this._transition(STATES.FAILED, { error: details, progress: null });
    this.emit('error', { error: clone(details), snapshot: this.getSnapshot() });
    if (manual) this.emit('notification', { type: 'update-error', error: clone(details), manual: true });
    return this.getSnapshot();
  }

  async _recordFailedVersion(version) {
    if (!semver.valid(version)) return;
    try {
      if (typeof this.runtimeManager.recordFailedVersion === 'function') {
        await this.runtimeManager.recordFailedVersion(version, this._nowIso());
        return;
      }
      const store = this.runtimeManager.stateStore;
      if (store && typeof store.update === 'function') {
        await store.update((state) => ({
          ...state,
          failedVersions: { ...(state.failedVersions || {}), [version]: this._nowIso() },
        }));
      }
    } catch (error) {
      this._logError(`Unable to record failed runtime ${version}`, error);
    }
  }

  _transition(next, patch = {}) {
    const current = this.snapshot.state;
    if (current !== next && (!ALLOWED_TRANSITIONS[current] || !ALLOWED_TRANSITIONS[current].has(next))) {
      throw new Error(`Invalid DSH update state transition: ${current} -> ${next}`);
    }
    this.snapshot = { ...this.snapshot, ...clone(patch), state: next };
    if (current !== next) {
      this.emit('state-change', { from: current, to: next, snapshot: this.getSnapshot() });
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'progress')) {
      this.emit('progress', { progress: clone(this.snapshot.progress), snapshot: this.getSnapshot() });
    }
  }

  _patch(patch) {
    this.snapshot = { ...this.snapshot, ...clone(patch) };
  }

  _runtimeRoot() {
    if (typeof this.runtimeManager.getRuntimeRoot === 'function') return this.runtimeManager.getRuntimeRoot();
    if (typeof this.runtimeManager.runtimeRoot === 'string') return this.runtimeManager.runtimeRoot;
    throw makeError('Runtime manager does not expose a runtime root', 'RUNTIME_ROOT_UNAVAILABLE');
  }

  _newOperationId(version) {
    this.operationCounter += 1;
    return `update-${this._now()}-${this.operationCounter}`.replace(/[^A-Za-z0-9._-]/g, '-');
  }

  _now() {
    const value = typeof this.clock === 'function' ? this.clock() : this.clock && typeof this.clock.now === 'function' ? this.clock.now() : Date.now();
    return value instanceof Date ? value.getTime() : Number(value);
  }

  _nowIso() {
    return new Date(this._now()).toISOString();
  }

  _resultError(result, fallback) {
    if (!result) return fallback;
    return result.error || result.reason || result.stderr || fallback;
  }

  _logError(message, error) {
    if (this.logger && typeof this.logger.error === 'function') this.logger.error(message, error);
  }
}

module.exports = { DshUpdateManager, STATES };
