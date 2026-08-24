'use strict';

const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs').promises;
const path = require('node:path');
const semver = require('semver');

const { verifyRuntime } = require('../src/update/runtime-verifier');

const PACKAGE_NAME = '@deepseek-ai/dsh';
const DEFAULT_BUNDLED_VERSION = '0.1.0-rc.7';
const DEFAULT_INSTALL_TIMEOUT_MS = 120000;
const DEFAULT_NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function exactSemver(value) {
  return typeof value === 'string' && semver.valid(value) === value ? value : null;
}

function resolveBundledVersion(version) {
  const requested = version === undefined
    ? (process.env.DSH_BUNDLED_VERSION || DEFAULT_BUNDLED_VERSION)
    : version;
  const exact = exactSemver(requested);
  if (!exact) {
    throw new TypeError(`DSH_BUNDLED_VERSION must be an exact SemVer; received ${JSON.stringify(requested)}`);
  }
  return exact;
}

function normalizeOutputRoot(outputRoot) {
  const resolved = path.resolve(outputRoot || path.join(__dirname, '..', 'build', 'bundled-runtime'));
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || !path.basename(resolved)) {
    throw new TypeError('Bundled runtime output must be a non-root directory');
  }
  return resolved;
}

function defaultSpawnProcess(command, args, options) {
  return spawn(command, args, options);
}

function runNpmInstall({ npmCommand, stagingRoot, version, spawnProcess, installTimeoutMs }) {
  const args = [
    'install',
    '--prefix', stagingRoot,
    '--ignore-scripts',
    '--no-package-lock',
    '--no-save',
    '--no-audit',
    '--no-fund',
    `${PACKAGE_NAME}@${version}`,
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(npmCommand, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    if (!child || typeof child.once !== 'function') {
      reject(new Error('spawnProcess did not return a child process'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (error, code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      if (timedOut || code !== 0) {
        const failure = new Error(timedOut
          ? 'Bundled runtime npm install timed out'
          : `Bundled runtime npm install exited with code ${code}`);
        failure.code = code;
        failure.signal = signal || null;
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
        return;
      }
      resolve({ code, signal: signal || null, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid != null && child.kill && typeof child.kill === 'function') {
        try { child.kill(); } catch (_) { /* the timeout result is authoritative */ }
      }
      finish(null, null, 'SIGTERM');
    }, installTimeoutMs);

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => { stdout += Buffer.from(chunk).toString('utf8'); });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr += Buffer.from(chunk).toString('utf8'); });
    }
    child.once('error', (error) => finish(error, null, null));
    child.once('exit', (code, signal) => finish(null, code, signal));
  });
}

async function exists(directory, fsImpl) {
  try {
    await fsImpl.lstat(directory);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function replaceOutput(tempRoot, outputRoot, fsImpl) {
  const backupRoot = `${outputRoot}.previous-${randomUUID()}`;
  const hadPrevious = await exists(outputRoot, fsImpl);
  if (hadPrevious) await fsImpl.rename(outputRoot, backupRoot);
  try {
    await fsImpl.rename(tempRoot, outputRoot);
  } catch (error) {
    if (hadPrevious && !(await exists(outputRoot, fsImpl))) {
      try { await fsImpl.rename(backupRoot, outputRoot); } catch (_) { /* preserve original failure */ }
    }
    throw error;
  }
  if (hadPrevious) await fsImpl.rm(backupRoot, { recursive: true, force: true });
}

async function prepareBundledRuntime({
  outputRoot,
  npmCommand = DEFAULT_NPM_COMMAND,
  version,
  spawnProcess = defaultSpawnProcess,
  verifyRuntimeImpl = verifyRuntime,
  nodeCommand = process.execPath,
  runCommand,
  logger = console,
  fsImpl = fs,
  installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
} = {}) {
  const exactVersion = resolveBundledVersion(version);
  const finalRoot = normalizeOutputRoot(outputRoot);
  const parentRoot = path.dirname(finalRoot);
  const tempRoot = path.join(parentRoot, `.bundled-runtime-${process.pid}-${Date.now()}-${randomUUID()}`);

  await fsImpl.mkdir(parentRoot, { recursive: true });
  try {
    await fsImpl.mkdir(tempRoot, { recursive: true });
    await fsImpl.writeFile(path.join(tempRoot, 'package.json'), '{"private":true}\n', 'utf8');
    await runNpmInstall({
      npmCommand,
      stagingRoot: tempRoot,
      version: exactVersion,
      spawnProcess,
      installTimeoutMs,
    });

    const verification = await verifyRuntimeImpl({
      rootPath: tempRoot,
      expectedVersion: exactVersion,
      nodeCommand,
      ...(runCommand ? { runCommand } : {}),
    });
    if (!verification || !verification.ok) {
      const reason = verification && verification.reason ? verification.reason : 'runtime-verification-failed';
      throw new Error(`Bundled runtime verification failed: ${reason}`);
    }

    await fsImpl.writeFile(path.join(tempRoot, 'runtime-manifest.json'), `${JSON.stringify({
      name: PACKAGE_NAME,
      version: exactVersion,
      source: 'npm',
      immutable: true,
    }, null, 2)}\n`, 'utf8');
    await replaceOutput(tempRoot, finalRoot, fsImpl);
    if (logger && typeof logger.info === 'function') logger.info(`Prepared immutable bundled DSH runtime ${exactVersion} at ${finalRoot}`);
    return { rootPath: finalRoot, version: exactVersion };
  } catch (error) {
    try { await fsImpl.rm(tempRoot, { recursive: true, force: true }); } catch (_) { /* retain the original failure */ }
    throw error;
  }
}

async function main(options = {}) {
  return prepareBundledRuntime(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_BUNDLED_VERSION,
  DEFAULT_NPM_COMMAND,
  PACKAGE_NAME,
  exactSemver,
  resolveBundledVersion,
  prepareBundledRuntime,
  main,
};
