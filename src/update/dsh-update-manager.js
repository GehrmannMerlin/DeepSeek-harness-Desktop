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
const DEFAULT_URL_WAIT_TIMEOUT_MS = 45 * 1000;

const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.IDLE]: new Set([STATES.CHECKING, STATES.READY_TO_APPLY, STATES.FAILED]),
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
    upstreamSource,
    verifiedSource,
    installer,
    artifactDownloader,
    verifier,
    processManager,
    healthChecker,
    logger = console,
    clock = () => Date.now(),
    urlWaitTimeoutMs = DEFAULT_URL_WAIT_TIMEOUT_MS,
  } = {}) {
    super();
    for (const [name, dependency] of Object.entries({ runtimeManager, registry: registry || upstreamSource, verifier, processManager, healthChecker })) {
      if (!dependency) throw new TypeError(`${name} is required`);
    }
    if (!installer && !artifactDownloader) throw new TypeError('installer or artifactDownloader is required');
    this.runtimeManager = runtimeManager;
    this.registry = registry || upstreamSource;
    this.verifiedSource = verifiedSource || null;
    this.installer = installer;
    this.artifactDownloader = artifactDownloader || null;
    this.verifier = verifier;
    this.processManager = processManager;
    this.healthChecker = healthChecker;
    this.logger = logger;
    this.clock = clock;
    this.urlWaitTimeoutMs = Number.isFinite(urlWaitTimeoutMs) && urlWaitTimeoutMs >= 0
      ? urlWaitTimeoutMs
      : DEFAULT_URL_WAIT_TIMEOUT_MS;
    this.operationPromise = null;
    this.operationCounter = 0;
    this.automaticCheckCompleted = false;
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
      upstreamLatestVersion: null,
      verifiedLatestVersion: null,
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
    const isManual = Boolean(manual);
    if (!isManual) {
      if (this.operationPromise) {
        this.automaticCheckCompleted = true;
        return this.operationPromise;
      }
      if (this.automaticCheckCompleted) return Promise.resolve(this.getSnapshot());
      this.automaticCheckCompleted = true;
    }
    return this._runOperation(() => this._checkForUpdates({ manual: isManual }));
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
    const operationId = this.snapshot.operationId && this.snapshot.state === STATES.UPDATE_AVAILABLE
      ? this.snapshot.operationId
      : this._newOperationId(null, {
        installedVersion: this.snapshot.currentRuntime && this.snapshot.currentRuntime.version,
        runtimeKind: this.snapshot.currentRuntime && this.snapshot.currentRuntime.kind,
      });
    this._patch({ operationId });
    this._transition(STATES.CHECKING, { error: null, progress: { phase: 'checking', version: null } });
    try {
      const currentRuntime = await this.runtimeManager.resolveCurrentRuntime();
      this._patch({ currentRuntime: clone(currentRuntime) });
      const state = typeof this.runtimeManager.getState === 'function'
        ? await this.runtimeManager.getState()
        : { failedVersions: {} };
      if (this.verifiedSource && typeof this.verifiedSource.isConfigured === 'function'
        && !this.verifiedSource.isConfigured()) {
        const error = {
          message: '在线更新服务尚未配置',
          code: 'VERIFIED_RUNTIME_SOURCE_NOT_CONFIGURED',
          fatal: false,
        };
        this._logInfo('verified_runtime_source_not_configured');
        this._transition(STATES.UP_TO_DATE, {
          latest: null,
          upstreamLatestVersion: null,
          verifiedLatestVersion: null,
          pending: Boolean(state && state.pending),
          updateAvailable: false,
          progress: null,
          error: null,
        });
        this._completeOperation('SOURCE_NOT_CONFIGURED');
        if (manual) this.emit('notification', { type: 'update-error', error, manual: true });
        return this.getSnapshot();
      }
      let upstreamLatest = null;
      let upstreamError = null;
      try {
        upstreamLatest = await this.registry.getLatest();
        this._validateLatest(upstreamLatest);
      } catch (error) {
        upstreamError = error;
        if (!this.verifiedSource) throw error;
        this._logError('DSH upstream registry observation failed; continuing with verified index', error);
      }
      const latest = this.verifiedSource
        ? await this.verifiedSource.getLatest({ platform: process.platform, arch: process.arch })
        : upstreamLatest;
      if (this.verifiedSource) this._validateVerifiedLatest(latest);
      this._patch({
        latest: clone(latest),
        upstreamLatestVersion: upstreamLatest ? upstreamLatest.version : null,
        verifiedLatestVersion: this.verifiedSource ? latest.version : null,
        lastCheckedAt: this._nowIso(),
        pending: Boolean(state && state.pending),
        error: upstreamError ? errorDetails(upstreamError) : null,
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
        this._completeOperation('UP_TO_DATE');
      }
    } catch (error) {
      return this._handleFailure(error, { manual });
    }
    return this.getSnapshot();
  }

  async _confirmUpdate() {
    if (this.snapshot.state !== STATES.UPDATE_AVAILABLE || !this.snapshot.latest) return this.getSnapshot();

    const latest = clone(this.snapshot.latest);
    const operationId = this.snapshot.operationId || this._newOperationId(latest.version, {
      installedVersion: this.snapshot.currentRuntime && this.snapshot.currentRuntime.version,
      runtimeKind: this.snapshot.currentRuntime && this.snapshot.currentRuntime.kind,
    });
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
      let preparedRoot = stagingRoot;
      if (this.artifactDownloader) {
        const artifactResult = await this.artifactDownloader.prepare({
          artifact: latest,
          stagingRoot: path.dirname(stagingRoot),
          operationId: path.basename(stagingRoot),
          packageName: PACKAGE_NAME,
          version: latest.version,
        });
        preparedRoot = artifactResult && (artifactResult.rootPath || artifactResult.stagingRoot);
        if (!preparedRoot) throw makeError('Runtime artifact preparation returned no root', 'RUNTIME_ARTIFACT_PREPARE_FAILED');
      } else {
        const installResult = await this.installer.install({
          stagingRoot,
          packageName: PACKAGE_NAME,
          version: latest.version,
        });
        if (!installResult || installResult.ok !== true) {
          throw makeError(this._resultError(installResult, 'Runtime installation failed'), 'RUNTIME_INSTALL_FAILED');
        }
      }

      this._transition(STATES.VERIFYING, { progress: { phase: 'verifying', version: latest.version } });
      const verifyResult = await this._verifyStaging(preparedRoot, latest.version);
      if (!verifyResult || verifyResult.ok !== true) {
        throw makeError(this._resultError(verifyResult, 'Runtime verification failed'), 'RUNTIME_VERIFY_FAILED');
      }

      prepared = await this.runtimeManager.promoteStaging(preparedRoot, latest.version);
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

    return this._applyOwned(prepared, {
      preservePendingUntilSuccess: false,
      manual: true,
      originalCurrent: this.snapshot.currentRuntime,
    });
  }

  async _recoverPendingActivation() {
    if (!this.processManager.ownsHarness()) return this.getSnapshot();
    let pending = null;
    let current = null;
    try {
      pending = await this.runtimeManager.consumePendingIfValid();
      if (!pending) return this.getSnapshot();
      current = await this.runtimeManager.resolveCurrentRuntime();
      this._transition(STATES.READY_TO_APPLY, {
        preparedRuntime: clone(pending),
        pending: true,
        operationId: this._newOperationId(pending.version),
        error: null,
        progress: { phase: 'ready-to-apply', version: pending.version },
      });
      this.newProcessStarted = false;
      this._transition(STATES.STOPPING_CURRENT, { progress: { phase: 'stopping', version: pending.version } });
      await this.processManager.stop();
      this._transition(STATES.RESTARTING, { progress: { phase: 'restarting', version: pending.version } });
      await this._startAndCheck(pending);
      await this.runtimeManager.activateRuntime(pending);
      this._transition(STATES.SUCCESS, {
        currentRuntime: clone(pending),
        pending: false,
        updateAvailable: false,
        latest: null,
        preparedRuntime: null,
        operationId: null,
        progress: null,
        error: null,
      });
    } catch (error) {
      if (!pending || !current) {
        return this._handleFailure(error, { manual: false });
      }
      await this._recordFailedVersion(pending.version);
      this._patch({ currentRuntime: clone(current), preparedRuntime: clone(pending), pending: true });
      return this._restoreCurrentRuntime(current, error, {
        manual: false,
        pending: true,
        preparedRuntime: pending,
      });
    }
    return this.getSnapshot();
  }

  async _applyOwned(prepared, { preservePendingUntilSuccess, manual = false, originalCurrent }) {
    let originalError = null;
    let activated = false;
    try {
      this.newProcessStarted = false;
      this._transition(STATES.STOPPING_CURRENT, { progress: { phase: 'stopping', version: prepared.version } });
      await this.processManager.stop();
      if (!preservePendingUntilSuccess) {
        this._transition(STATES.SWITCHING, { progress: { phase: 'switching', version: prepared.version } });
        await this.runtimeManager.activateRuntime(prepared);
        activated = true;
      }
      this._transition(STATES.RESTARTING, { progress: { phase: 'restarting', version: prepared.version } });
      await this._startAndCheck(prepared);
      if (preservePendingUntilSuccess) await this.runtimeManager.activateRuntime(prepared);
      this._transition(STATES.SUCCESS, {
        currentRuntime: clone(prepared),
        preparedRuntime: null,
        pending: false,
        updateAvailable: false,
        latest: null,
        operationId: null,
        progress: null,
        error: null,
      });
      return this.getSnapshot();
    } catch (error) {
      originalError = error;
    }

    await this._recordFailedVersion(prepared.version);
    if (!activated && originalCurrent) {
      return this._restoreCurrentRuntime(originalCurrent, originalError, { manual, pending: false });
    }
    return this._rollback(originalError, { manual });
  }

  async _restoreCurrentRuntime(currentRuntime, originalError, {
    manual = false,
    pending = false,
    preparedRuntime = null,
  } = {}) {
    this._transition(STATES.ROLLING_BACK, {
      progress: { phase: 'restoring-current', version: currentRuntime && currentRuntime.version },
      error: errorDetails(originalError),
    });
    try {
      await this._stopFailedOwnedProcess();
      this._transition(STATES.RESTARTING, {
        progress: { phase: 'restarting-current', version: currentRuntime.version },
      });
      await this._startAndCheck(currentRuntime);
      this._transition(STATES.ROLLED_BACK, {
        currentRuntime: clone(currentRuntime),
        pending,
        preparedRuntime: pending && preparedRuntime ? clone(preparedRuntime) : null,
        updateAvailable: false,
        latest: null,
        operationId: null,
        progress: null,
        error: errorDetails(originalError),
      });
      return this.getSnapshot();
    } catch (recoveryError) {
      await this._stopFailedOwnedProcess();
      return this._handleFailure(recoveryError, { manual, fatal: true });
    }
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
    const healthOptions = {
      runtime,
      phase: 'post_activation_update_health',
    };
    const check = typeof this.healthChecker === 'function'
      ? await this.healthChecker(url, healthOptions)
      : await (this.healthChecker.waitUntilReady
        ? this.healthChecker.waitUntilReady(url, healthOptions)
        : this.healthChecker.check(url, healthOptions));
    if (!check || (check.ok !== true && check.ready !== true)) throw makeError('New runtime health check failed', 'RUNTIME_HEALTH_FAILED');
    return check;
  }

  async _waitForHarnessUrl() {
    const current = this.processManager.getUrl && this.processManager.getUrl();
    if (current) return current;
    if (!this.processManager.once) return null;
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (url) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (typeof this.processManager.removeListener === 'function') {
          this.processManager.removeListener('url-detected', onUrl);
          this.processManager.removeListener('exit', onExit);
        }
        resolve(url || null);
      };
      const onUrl = (url) => finish(url);
      const onExit = () => finish(null);
      this.processManager.once('url-detected', onUrl);
      this.processManager.once('exit', onExit);
      timer = setTimeout(() => finish(null), this.urlWaitTimeoutMs);
      const afterAttach = this.processManager.getUrl && this.processManager.getUrl();
      if (afterAttach) finish(afterAttach);
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

  _validateVerifiedLatest(latest) {
    if (!latest || typeof latest !== 'object' || latest.packageName !== PACKAGE_NAME || !semver.valid(latest.version) ||
        (latest.platform && latest.platform !== process.platform) || (latest.arch && latest.arch !== process.arch)) {
      throw makeError('Verified runtime source returned invalid metadata', 'INVALID_VERIFIED_RUNTIME_RESULT');
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
    if (!this.snapshot.operationId) {
      const operationId = this._newOperationId(
        this.snapshot.latest && this.snapshot.latest.version,
        {
          installedVersion: this.snapshot.currentRuntime && this.snapshot.currentRuntime.version,
          runtimeKind: this.snapshot.currentRuntime && this.snapshot.currentRuntime.kind,
        },
      );
      this._patch({ operationId });
    }
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
    const operationId = this.snapshot.operationId || patch.operationId || null;
    if (current !== next && (!ALLOWED_TRANSITIONS[current] || !ALLOWED_TRANSITIONS[current].has(next))) {
      throw new Error(`Invalid DSH update state transition: ${current} -> ${next}`);
    }
    this.snapshot = { ...this.snapshot, ...clone(patch), state: next };
    if (current !== next) {
      if (operationId) {
        this._audit('update_state_transition', {
          operationId,
          from: current,
          state: next,
          oldVersion: this.snapshot.currentRuntime && this.snapshot.currentRuntime.version,
          targetVersion: (this.snapshot.preparedRuntime && this.snapshot.preparedRuntime.version)
            || (this.snapshot.latest && this.snapshot.latest.version)
            || null,
          pid: this.processManager && typeof this.processManager.getPid === 'function'
            ? this.processManager.getPid()
            : null,
        });
      }
      this.emit('state-change', { from: current, to: next, snapshot: this.getSnapshot() });
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'progress')) {
      this.emit('progress', { progress: clone(this.snapshot.progress), snapshot: this.getSnapshot() });
    }
    if (operationId && [STATES.SUCCESS, STATES.ROLLED_BACK, STATES.FAILED].includes(next)) {
      this._completeOperation(next, operationId);
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

  _newOperationId(version, { installedVersion = null, runtimeKind = null } = {}) {
    this.operationCounter += 1;
    const operationId = `update-${this._now()}-${this.operationCounter}`.replace(/[^A-Za-z0-9._-]/g, '-');
    this.operationStartedAt = this._now();
    this._audit('update_operation_created', {
      operationId,
      installedVersion,
      targetVersion: version || null,
      runtimeKind,
    });
    return operationId;
  }

  _completeOperation(result, operationId = this.snapshot.operationId) {
    if (!operationId || this.completedOperationId === operationId) return;
    this.completedOperationId = operationId;
    const durationMs = Math.max(0, this._now() - (this.operationStartedAt || this._now()));
    this._audit('operation_completed', { operationId, result, durationMs });
    if (this.snapshot.operationId === operationId) this._patch({ operationId: null });
    this.operationStartedAt = null;
  }

  _audit(event, fields = {}) {
    if (!this.logger || typeof this.logger.info !== 'function') return;
    const record = {
      timestamp: this._nowIso(),
      event,
      ...fields,
    };
    try {
      this.logger.info(JSON.stringify(record));
    } catch (_) {
      // Observability must never change update behavior.
    }
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

  _logInfo(message) {
    if (this.logger && typeof this.logger.info === 'function') this.logger.info(message);
  }
}

module.exports = { DshUpdateManager, STATES, DEFAULT_URL_WAIT_TIMEOUT_MS };
