'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs').promises;
const semver = require('semver');
const { killTree } = require('../process/process-tree');

const PACKAGE_NAME = '@deepseek-ai/dsh';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_OUTPUT_BYTES = 16 * 1024;

function appendBounded(current, chunk) {
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
  if (remaining <= 0) return current;
  return current + Buffer.from(chunk).subarray(0, remaining).toString('utf8');
}

function logResult(logger, result) {
  if (!logger || typeof logger.info !== 'function') return;
  logger.info(`DSH npm install pid=${result.pid || 'unknown'} code=${result.code} signal=${result.signal || 'none'} timedOut=${result.timedOut} durationMs=${result.durationMs} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
}

function NpmInstaller({ npmCommand, spawnProcess = spawn, killProcess = killTree, logger, installTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  async function install({ stagingRoot, packageName, version } = {}) {
    const startedAt = Date.now();
    const baseResult = { stagingRoot, code: null, signal: null, timedOut: false, durationMs: 0, stdout: '', stderr: '', error: null };
    if (packageName !== PACKAGE_NAME) return { ok: false, ...baseResult, durationMs: Date.now() - startedAt, error: 'invalid package name' };
    if (!semver.valid(version)) return { ok: false, ...baseResult, durationMs: Date.now() - startedAt, error: 'invalid package version' };

    try {
      await fs.mkdir(stagingRoot, { recursive: true });
      await fs.writeFile(`${stagingRoot}/package.json`, '{"private":true}\n', 'utf8');
    } catch (error) {
      return { ok: false, ...baseResult, durationMs: Date.now() - startedAt, error: error.message };
    }

    const args = ['install', '--prefix', stagingRoot, '--no-audit', '--no-fund', `${PACKAGE_NAME}@${version}`];
    let child;
    try {
      child = spawnProcess(npmCommand, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return { ok: false, ...baseResult, durationMs: Date.now() - startedAt, error: error.message };
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const finish = (code, signal, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result = {
          ok: !timedOut && !error && code === 0,
          stagingRoot,
          pid: child && child.pid,
          code: code ?? null,
          signal: signal ?? null,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdout,
          stderr,
          error: error ? error.message : (timedOut ? 'npm install timed out' : (code === 0 ? null : `npm install exited with code ${code}`)),
        };
        logResult(logger, result);
        resolve(result);
      };
      const terminateInstaller = () => {
        timedOut = true;
        try {
          Promise.resolve(killProcess(child.pid)).catch(() => {});
        } catch (error) {
          finish(null, null, error);
          return;
        }
        finish(null, null, null);
      };
      const timer = setTimeout(terminateInstaller, installTimeoutMs);

      if (!child || typeof child.once !== 'function') {
        finish(null, null, new Error('spawnProcess did not return a child process'));
        return;
      }
      if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
      if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
      child.once('error', (error) => finish(null, null, error));
      child.once('exit', (code, signal) => finish(code, signal, null));
    });
  }

  return { install };
}

module.exports = { NpmInstaller, PACKAGE_NAME, MAX_OUTPUT_BYTES };
