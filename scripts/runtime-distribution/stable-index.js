'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const {
  assertProductionHttpsUrl,
  assertTarget,
  normalizeExactVersion,
} = require('./distribution-contract');
const {
  ARTIFACT_SCHEMA_VERSION,
  PACKAGE_NAME,
  VerifiedRuntimeArtifact,
} = require('../../src/runtime/verified-runtime-artifact');

function invalid(message, cause) {
  const error = new Error(`invalid stable runtime index: ${message}`, cause ? { cause } : undefined);
  error.code = 'INVALID_STABLE_RUNTIME_INDEX';
  return error;
}

function requireIndexShape(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw invalid('index must be an object');
  const keys = Object.keys(index).sort();
  if (index.schemaVersion !== ARTIFACT_SCHEMA_VERSION || keys.join('\0') !== 'artifacts\0schemaVersion') {
    throw invalid('only schemaVersion 1 with artifacts is supported');
  }
  if (!Array.isArray(index.artifacts) || index.artifacts.length === 0) throw invalid('artifacts must be non-empty');
}

function validateEntry(entry, target) {
  try {
    assertProductionHttpsUrl(entry && entry.artifactUrl);
    const artifact = VerifiedRuntimeArtifact.fromIndexEntry(entry, target);
    if (artifact.packageName !== PACKAGE_NAME || normalizeExactVersion(artifact.version) !== artifact.version) {
      throw new Error('artifact version must be an exact canonical SemVer');
    }
    return artifact;
  } catch (error) {
    throw invalid(error.message, error);
  }
}

function validateStableIndex(index, { platform = 'win32', arch = 'x64' } = {}) {
  try {
    const target = assertTarget({ platform, arch });
    requireIndexShape(index);
    return {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      artifacts: index.artifacts.map(entry => validateEntry(entry, target)),
    };
  } catch (error) {
    if (error && error.code === 'INVALID_STABLE_RUNTIME_INDEX') throw error;
    throw invalid(error.message, error);
  }
}

function buildStableIndex({ candidate, artifactUrl = candidate && candidate.artifactUrl } = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw invalid('candidate is required');
  const entry = {
    packageName: candidate.packageName,
    version: candidate.version,
    platform: candidate.platform,
    arch: candidate.arch,
    artifactUrl,
    sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256,
    manifest: candidate.manifest,
  };
  return validateStableIndex({ schemaVersion: ARTIFACT_SCHEMA_VERSION, artifacts: [entry] });
}

async function writeFileDurably(filePath, content, fileSystem = fsp) {
  const handle = await fileSystem.open(filePath, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function historyName(now, version) {
  const timestamp = String(now()).replace(/[^0-9A-Za-z-]/g, '-');
  return `${timestamp}-${normalizeExactVersion(version)}.json`;
}

async function readExisting(filePath, fileSystem = fsp) {
  try { return await fileSystem.readFile(filePath); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeStableIndexAtomic({ indexPath, index, historyDirectory, now = () => new Date().toISOString(), fileSystem = fsp } = {}) {
  if (typeof indexPath !== 'string' || typeof historyDirectory !== 'string') throw new TypeError('indexPath and historyDirectory are required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const validated = validateStableIndex(index);
  const json = `${JSON.stringify(validated, null, 2)}\n`;
  const directory = path.dirname(indexPath);
  const temporaryPath = `${indexPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const previous = await readExisting(indexPath, fileSystem);
  let renamed = false;
  let restoreTemporaryPath;
  try {
    await fileSystem.mkdir(directory, { recursive: true });
    await writeFileDurably(temporaryPath, json, fileSystem);
    await fileSystem.rename(temporaryPath, indexPath);
    renamed = true;
    await fileSystem.mkdir(historyDirectory, { recursive: true });
    const historyPath = path.join(historyDirectory, historyName(now, validated.artifacts[0].version));
    await writeFileDurably(historyPath, json, fileSystem);
    return { indexPath, historyPath };
  } catch (error) {
    if (renamed) {
      if (previous) {
        restoreTemporaryPath = `${indexPath}.restore-${process.pid}-${crypto.randomUUID()}`;
        await writeFileDurably(restoreTemporaryPath, previous, fileSystem);
        await fileSystem.rename(restoreTemporaryPath, indexPath);
      } else {
        await fileSystem.rm(indexPath, { force: true });
      }
    }
    throw error;
  } finally {
    await fileSystem.rm(temporaryPath, { force: true });
    if (restoreTemporaryPath) await fileSystem.rm(restoreTemporaryPath, { force: true });
  }
}

async function verifiedPromotion({ candidateStore, version, remoteVerifier, indexPath, historyDirectory, now }) {
  if (!candidateStore || typeof candidateStore.read !== 'function') throw new TypeError('candidateStore.read is required');
  const candidate = await candidateStore.read(version);
  if (!candidate) {
    const error = new Error(`candidate ${version} does not exist`);
    error.code = 'CANDIDATE_NOT_FOUND';
    throw error;
  }
  const index = buildStableIndex({ candidate, artifactUrl: candidate.artifactUrl });
  if (typeof remoteVerifier !== 'function' && (!remoteVerifier || typeof remoteVerifier.verify !== 'function')) {
    throw new TypeError('remoteVerifier is required');
  }
  const verify = typeof remoteVerifier === 'function' ? remoteVerifier : remoteVerifier.verify.bind(remoteVerifier);
  const verification = await verify({ candidate });
  if (!verification || verification.status !== 'REMOTE_VERIFIED') {
    const error = new Error('candidate was not remotely verified');
    error.code = 'REMOTE_VERIFICATION_REQUIRED';
    throw error;
  }
  await writeStableIndexAtomic({ indexPath, index, historyDirectory, now });
  return { version: candidate.version, index };
}

function promoteStable(options) {
  return verifiedPromotion({ ...options, version: options && options.candidateVersion });
}

function rollbackStable(options) {
  return verifiedPromotion({ ...options, version: options && options.targetVersion });
}

module.exports = {
  buildStableIndex,
  validateStableIndex,
  writeStableIndexAtomic,
  promoteStable,
  rollbackStable,
};
