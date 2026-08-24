'use strict';
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { resolveCommand } = require('../utils/npx-resolver');
const { detectUrl } = require('../utils/url-detector');
const { killTree, isAlive } = require('./process-tree');
const { mark } = require('../utils/boot-timeline');

const STATUS = Object.freeze({
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  WAITING_FOR_SERVER: 'WAITING_FOR_SERVER',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  FAILED: 'FAILED',
  CRASHED: 'CRASHED',
});

// Single owner of the dsh child process. Only this module spawns, stops and
// restarts Harness; everything else (window, tray, lifecycle) reads its state.
class HarnessProcessManager extends EventEmitter {
  constructor({
    logger,
    spawnImpl = spawn,
    resolveCommandImpl = resolveCommand,
    killTreeImpl = killTree,
    isAliveImpl = isAlive,
  }) {
    super();
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.resolveCommandImpl = resolveCommandImpl;
    this.killTreeImpl = killTreeImpl;
    this.isAliveImpl = isAliveImpl;
    this.status = STATUS.STOPPED;
    this.child = null;
    this.pid = null;
    this.ownership = null; // 'owned' | 'external' | null
    this.runtimeDescriptor = null;
    this.url = null;
    this.exitCode = null;
    this._expectedStop = false;
  }

  getStatus() { return this.status; }
  isRunning() {
    return this.status === STATUS.STARTING
      || this.status === STATUS.WAITING_FOR_SERVER
      || this.status === STATUS.RUNNING;
  }
  ownsHarness() { return this.ownership === 'owned'; }
  getUrl() { return this.url; }
  getPid() { return this.pid; }
  getRuntimeDescriptor() { return this.runtimeDescriptor; }

  _setStatus(next) {
    if (this.status === next) return;
    const prev = this.status;
    this.status = next;
    this.logger.info(`status: ${prev} -> ${next}`);
    this.emit('status-change', { prev, next });
  }

  // Adopt an already-running Harness we did not spawn. Exit must NOT kill it.
  markExternal(url) {
    this.ownership = 'external';
    this.runtimeDescriptor = null;
    this.url = url;
    this.pid = null;
    this._setStatus(STATUS.RUNNING);
    this.logger.info(`adopted external harness at ${url}`);
  }

  // Called by the lifecycle once the health checker confirms the server is
  // actually serving Harness (WAITING_FOR_SERVER -> RUNNING).
  markRunning() {
    if (this.status === STATUS.WAITING_FOR_SERVER || this.status === STATUS.STARTING) {
      this._setStatus(STATUS.RUNNING);
    }
  }

  start(runtimeDescriptor = null) {
    if (this.child) {
      this.logger.warn('start() ignored: a child is already tracked');
      return Promise.resolve(false);
    }
    this.ownership = 'owned';
    this.runtimeDescriptor = runtimeDescriptor;
    this.url = null;
    this.exitCode = null;
    this._expectedStop = false;
    this._setStatus(STATUS.STARTING);

    const { command, args } = runtimeDescriptor || this.resolveCommandImpl();
    this.logger.info(`spawn: ${command} ${args.join(' ')}`);
    mark('dsh_spawn_started', `${command} ${args.join(' ')}`);

    return new Promise((resolve) => {
      const child = this.spawnImpl(command, args, {
        shell: false,
        windowsHide: true,           // no console window
        stdio: ['ignore', 'pipe', 'pipe'], // capture stdout/stderr for URL + logs
        env: process.env,
      });
      this.child = child;
      this.pid = child.pid;
      this.logger.info(`spawned pid=${child.pid}`);

      let settled = false;
      let stdoutFirst = true;
      let stderrFirst = true;
      const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };

      child.once('spawn', () => {
        this.logger.info('child process spawned');
        mark('dsh_spawned', `pid=${child.pid}`);
        settle(true);
      });
      child.once('error', (err) => {
        this.logger.error(`spawn error: ${err.message}`);
        settle(false);
        this.child = null;
        this.pid = null;
        this.runtimeDescriptor = null;
        this._setStatus(STATUS.FAILED);
      });

      child.stdout.on('data', (buf) => {
        if (stdoutFirst) { stdoutFirst = false; mark('dsh_stdout_first_byte'); }
        for (const line of buf.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.logger.info(`stdout: ${line}`);
          const url = detectUrl(line);
          if (url && !this.url) {
            this.url = url;
            this.logger.info(`url detected: ${url}`);
            mark('harness_url_detected', url);
            this.emit('url-detected', url);
            if (this.status === STATUS.STARTING) this._setStatus(STATUS.WAITING_FOR_SERVER);
          }
        }
      });

      child.stderr.on('data', (buf) => {
        if (stderrFirst) { stderrFirst = false; mark('dsh_stderr_first_byte'); }
        for (const line of buf.toString().split(/\r?\n/)) {
          if (line.trim()) this.logger.info(`stderr: ${line}`);
        }
      });

      child.on('exit', (code, signal) => {
        this.logger.info(`exit code=${code} signal=${signal} expectedStop=${this._expectedStop}`);
        this.exitCode = code;
        this.child = null;
        this.pid = null;
        this.runtimeDescriptor = null;
        this.emit('exit', { code, signal });
        if (this._expectedStop || this.status === STATUS.STOPPING) {
          this._setStatus(STATUS.STOPPED);
        } else {
          this._setStatus(STATUS.CRASHED);
        }
      });
    });
  }

  stop() {
    const pid = this.pid;
    if (!pid) {
      this.logger.info('stop(): nothing running');
      return Promise.resolve(true);
    }
    this._expectedStop = true;
    this._setStatus(STATUS.STOPPING);
    this.logger.info(`stop(): killing tree pid=${pid}`);

    return new Promise((resolve) => {
      let done = false;
      let forceTimer = null;
      const onExit = () => finish();
      const finish = () => {
        if (done) return;
        done = true;
        if (forceTimer) clearTimeout(forceTimer);
        this.removeListener('exit', onExit);
        resolve(true);
      };
      this.once('exit', onExit);
      forceTimer = setTimeout(finish, 6000);

      // Graceful first (best effort), then force if still alive.
      this.killTreeImpl(pid, { force: false }).then((res) => {
        this.logger.info(`stop(): graceful result ok=${res.ok} err=${res.err.trim()}`);
        setTimeout(() => {
          if (this.isAliveImpl(pid)) {
            this.logger.info(`stop(): still alive, force killing tree pid=${pid}`);
            this.killTreeImpl(pid, { force: true }).then((r2) => {
              this.logger.info(`stop(): force result ok=${r2.ok} err=${r2.err.trim()}`);
            });
          } else {
            this.logger.info('stop(): process gone after graceful kill');
          }
        }, 1500);
      });
    });
  }

  async restart() {
    const runtimeDescriptor = this.runtimeDescriptor;
    await this.stop();
    return this.start(runtimeDescriptor);
  }
}

module.exports = { HarnessProcessManager, STATUS };
