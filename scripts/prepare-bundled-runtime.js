'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs').promises;
const path = require('node:path');
const semver = require('semver');

const { verifyRuntime } = require('../src/update/runtime-verifier');
const { resolveNpmInvocation } = require('../src/update/npm-command');
const { extractZip } = require('../src/update/runtime-artifact-downloader');
const { validateManifest } = require('../src/runtime/verified-runtime-artifact');
const { defaultSmoke } = require('./build-verified-runtime-artifact');

const PACKAGE_NAME = '@deepseek-ai/dsh';
const DEFAULT_BUNDLED_VERSION = '0.1.0-rc.7';
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function exactSemver(value) {
  return typeof value === 'string' && semver.valid(value) === value ? value : null;
}

function resolveBundledVersion(version) {
  const requested = version === undefined
    ? (process.env.DSH_BUNDLED_VERSION === undefined ? DEFAULT_BUNDLED_VERSION : process.env.DSH_BUNDLED_VERSION)
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

async function runNpmInstall({ npmCommand, stagingRoot, version, spawnProcess, installTimeoutMs }) {
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

  let invocation;
  try {
    invocation = spawnProcess === defaultSpawnProcess
      ? await resolveNpmInvocation(npmCommand)
      : { command: npmCommand, argsPrefix: [] };
  } catch (error) {
    throw error;
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(invocation.command, [...invocation.argsPrefix, ...args], {
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

async function hashFile(filePath, fsImpl) {
  const hash = createHash('sha256');
  const contents = await fsImpl.readFile(filePath);
  hash.update(contents);
  return { sizeBytes: contents.length, sha256: hash.digest('hex') };
}

async function prepareFromVerifiedArtifact({
  artifactPath,
  artifactMetadata,
  tempRoot,
  exactVersion,
  extractArtifactImpl,
  verifyRuntimeImpl,
  nodeCommand,
  runCommand,
  smokeRuntimeImpl = defaultSmoke,
  fsImpl,
}) {
  const resolvedArtifactPath = path.resolve(artifactPath);
  const localIdentity = {
    packageName: PACKAGE_NAME,
    version: exactVersion,
    platform: process.platform,
    arch: process.arch,
  };
  if (artifactMetadata) {
    if (!Number.isSafeInteger(artifactMetadata.sizeBytes) || typeof artifactMetadata.sha256 !== 'string') {
      throw new Error('Verified runtime artifact metadata is incomplete');
    }
    const observed = await hashFile(resolvedArtifactPath, fsImpl);
    if (observed.sizeBytes !== artifactMetadata.sizeBytes || observed.sha256 !== artifactMetadata.sha256.toLowerCase()) {
      throw new Error('Verified runtime artifact file identity does not match its metadata');
    }
  }
  await extractArtifactImpl({ archivePath: resolvedArtifactPath, extractionRoot: tempRoot });
  let manifest;
  try {
    manifest = JSON.parse(await fsImpl.readFile(path.join(tempRoot, 'runtime-manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error(`Verified runtime artifact manifest is missing or invalid: ${error.message}`);
  }
  validateManifest(manifest, localIdentity);
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
  const smoke = await smokeRuntimeImpl({ rootPath: tempRoot, manifest });
  if (!smoke || smoke.ok === false || smoke.web === 'failed' || smoke.native === 'failed') throw new Error('Bundled runtime Web/native smoke failed');
  return { manifest, resolvedArtifactPath };
}

async function prepareBundledRuntime({
  outputRoot,
  artifactPath = process.env.DSH_VERIFIED_RUNTIME_ARTIFACT,
  artifactMetadata,
  extractArtifactImpl = extractZip,
  npmCommand = DEFAULT_NPM_COMMAND,
  version,
  spawnProcess = defaultSpawnProcess,
  verifyRuntimeImpl = verifyRuntime,
  nodeCommand = process.execPath,
  runCommand,
  smokeRuntimeImpl = defaultSmoke,
  logger = console,
  fsImpl = fs,
  installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
} = {}) {
  const exactVersion = resolveBundledVersion(version);
  const finalRoot = normalizeOutputRoot(outputRoot);
  const legacyInstallWasExplicitlyInjected = spawnProcess !== defaultSpawnProcess;
  if (!artifactPath && !legacyInstallWasExplicitlyInjected) {
    throw new Error('A verified runtime artifact is required; set DSH_VERIFIED_RUNTIME_ARTIFACT or pass artifactPath');
  }
  const parentRoot = path.dirname(finalRoot);
  const tempRoot = path.join(parentRoot, `.bundled-runtime-${process.pid}-${Date.now()}-${randomUUID()}`);

  await fsImpl.mkdir(parentRoot, { recursive: true });
  try {
    await fsImpl.mkdir(tempRoot, { recursive: true });
    if (artifactPath) {
      await prepareFromVerifiedArtifact({
        artifactPath,
        artifactMetadata,
        tempRoot,
        exactVersion,
        extractArtifactImpl,
        verifyRuntimeImpl,
        nodeCommand,
        runCommand,
        smokeRuntimeImpl,
        fsImpl,
      });
    } else {
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
        source: 'npm-diagnostic',
        immutable: true,
      }, null, 2)}\n`, 'utf8');
    }
    await replaceOutput(tempRoot, finalRoot, fsImpl);
    if (logger && typeof logger.info === 'function') logger.info(`Prepared immutable bundled DSH runtime ${exactVersion} at ${finalRoot}`);
    return { rootPath: finalRoot, version: exactVersion, source: artifactPath ? 'verified-artifact' : 'npm-diagnostic' };
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
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_NPM_COMMAND,
  PACKAGE_NAME,
  exactSemver,
  resolveBundledVersion,
  prepareBundledRuntime,
  prepareFromVerifiedArtifact,
  main,
};
