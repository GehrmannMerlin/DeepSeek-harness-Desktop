'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const https = require('node:https');
const path = require('node:path');
const { Transform, pipeline: pipelineCallback } = require('node:stream');
const { promisify } = require('node:util');

const { assertProductionHttpsUrl, assertTarget, candidateIdentity } = require('./distribution-contract');
const { extractZip } = require('../../src/update/runtime-artifact-downloader');
const { verifyRuntime } = require('../../src/update/runtime-verifier');
const { PACKAGE_NAME, validateManifest } = require('../../src/runtime/verified-runtime-artifact');
const { defaultSmoke } = require('../build-verified-runtime-artifact');

const pipeline = promisify(pipelineCallback);
const DEFAULT_TIMEOUT_MS = 120000;

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function classifyDownloadError(error) {
  if (error && (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT' || /timed out/i.test(error.message))) {
    return codedError('REMOTE_ARTIFACT_TIMEOUT', error.message, error);
  }
  return error;
}

function downloadRemoteArtifact(url, destination, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    assertProductionHttpsUrl(url);
  } catch (error) {
    throw codedError('REMOTE_ARTIFACT_URL_INVALID', error.message, error);
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    let bytes = 0;
    const hash = crypto.createHash('sha256');
    const digest = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const request = https.get(url, { headers: { accept: 'application/zip, application/octet-stream' } }, async (response) => {
      const statusCode = response.statusCode || 0;
      const contentLengthHeader = response.headers['content-length'];
      const contentLength = contentLengthHeader == null ? null : Number(contentLengthHeader);
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(codedError('REMOTE_ARTIFACT_HTTP_STATUS', `remote runtime artifact returned HTTP ${statusCode}`));
        return;
      }
      try {
        await pipeline(response, digest, fs.createWriteStream(destination, { flags: 'wx' }));
        if (contentLength != null && (!Number.isSafeInteger(contentLength) || contentLength !== bytes)) {
          throw codedError('REMOTE_ARTIFACT_CONTENT_LENGTH_MISMATCH', `remote Content-Length ${contentLength} does not match ${bytes} received bytes`);
        }
        resolve({ statusCode, contentLength, sizeBytes: bytes, sha256: hash.digest('hex'), durationMs: Date.now() - started });
      } catch (error) {
        reject(classifyDownloadError(error));
      }
    });
    request.setTimeout(timeoutMs, () => request.destroy(codedError('REMOTE_ARTIFACT_TIMEOUT', 'remote runtime artifact download timed out')));
    request.on('error', (error) => {
      if (!settled) reject(classifyDownloadError(error));
    });
  });
}

function assertCandidateManifest(candidate) {
  const manifest = candidate && candidate.manifest;
  if (candidate.packageName !== PACKAGE_NAME) throw new Error('candidate packageName is not the DSH package');
  validateManifest(manifest, {
    packageName: candidate.packageName,
    version: candidate.version,
    platform: candidate.platform,
    arch: candidate.arch,
  });
  if (manifest.packageName !== candidate.packageName || manifest.version !== candidate.version ||
      manifest.platform !== candidate.platform || manifest.arch !== candidate.arch) {
    throw new Error('candidate manifest identity does not match its descriptor');
  }
}

function validateCandidate(candidate) {
  try {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('candidate is required');
    candidateIdentity(candidate);
    assertTarget(candidate);
    assertCandidateManifest(candidate);
  } catch (error) {
    throw codedError('REMOTE_CANDIDATE_INVALID', error.message, error);
  }
}

function mapVerificationFailure(verification) {
  const reason = verification && verification.reason ? String(verification.reason) : 'unknown';
  if (/manifest|package-(name|version)-mismatch/i.test(reason)) return 'REMOTE_MANIFEST_MISMATCH';
  return 'REMOTE_RUNTIME_VERIFICATION_FAILED';
}

function smokeSucceeded(smokeResult) {
  if (!smokeResult || smokeResult.ok === false) return false;
  for (const component of ['web', 'health', 'native']) {
    const value = smokeResult[component];
    if (value === 'failed' || (value && typeof value === 'object' && value.ok === false)) return false;
  }
  return true;
}

async function verifyRemoteCandidate({
  candidate,
  download = downloadRemoteArtifact,
  extractZip: extractZipImpl = extractZip,
  verifyRuntime: verifyRuntimeImpl = verifyRuntime,
  smoke: smokeImpl = defaultSmoke,
  tempRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let started;
  let stagingRoot;
  let archivePart;
  let archivePath;
  let extractionRoot;
  let primaryError = null;
  try {
    if (typeof tempRoot !== 'string' || tempRoot.length === 0) throw codedError('REMOTE_CANDIDATE_INVALID', 'tempRoot is required');
    validateCandidate(candidate);
    try {
      assertProductionHttpsUrl(candidate.artifactUrl);
    } catch (error) {
      throw codedError('REMOTE_ARTIFACT_URL_INVALID', error.message, error);
    }
    started = Date.now();
    stagingRoot = path.join(tempRoot, `remote-${process.pid}-${crypto.randomUUID()}`);
    archivePart = path.join(stagingRoot, 'artifact.zip.part');
    archivePath = path.join(stagingRoot, 'artifact.zip');
    extractionRoot = path.join(stagingRoot, 'extracted');
    await fsp.mkdir(stagingRoot, { recursive: true });
    let observed;
    try {
      observed = await download(candidate.artifactUrl, archivePart, { timeoutMs });
    } catch (error) {
      if (error && error.code === 'ETIMEDOUT') throw codedError('REMOTE_ARTIFACT_TIMEOUT', error.message, error);
      throw error;
    }
    if (!observed || observed.statusCode < 200 || observed.statusCode >= 300) {
      throw codedError('REMOTE_ARTIFACT_HTTP_STATUS', `remote runtime artifact returned HTTP ${observed && observed.statusCode}`);
    }
    if (observed.contentLength != null && observed.contentLength !== observed.sizeBytes) {
      throw codedError('REMOTE_ARTIFACT_CONTENT_LENGTH_MISMATCH', `Content-Length ${observed.contentLength} does not match ${observed.sizeBytes} received bytes`);
    }
    if (observed.sizeBytes !== candidate.sizeBytes) {
      throw codedError('REMOTE_ARTIFACT_SIZE_MISMATCH', `expected ${candidate.sizeBytes} bytes, received ${observed.sizeBytes}`);
    }
    if (String(observed.sha256).toLowerCase() !== String(candidate.sha256).toLowerCase()) {
      throw codedError('REMOTE_ARTIFACT_HASH_MISMATCH', `expected ${candidate.sha256}, received ${observed.sha256}`);
    }
    await fsp.rename(archivePart, archivePath);

    let extractionResult;
    try {
      extractionResult = await extractZipImpl({ archivePath, extractionRoot, candidate });
    } catch (error) {
      throw codedError('REMOTE_EXTRACTION_FAILED', error.message, error);
    }
    const rootPath = extractionResult || extractionRoot;
    const verification = await verifyRuntimeImpl({ rootPath, expectedVersion: candidate.version, nodeCommand: process.execPath, candidate });
    if (!verification || !verification.ok) {
      throw codedError(mapVerificationFailure(verification), `remote runtime verification failed: ${verification && verification.reason || 'unknown'}`);
    }
    let smokeResult;
    try {
      smokeResult = await smokeImpl({ rootPath, manifest: candidate.manifest, candidate });
    } catch (error) {
      throw codedError('REMOTE_SMOKE_FAILED', error.message, error);
    }
    if (!smokeSucceeded(smokeResult)) throw codedError('REMOTE_SMOKE_FAILED', 'remote runtime smoke failed');
    return {
      status: 'REMOTE_VERIFIED',
      observedSize: observed.sizeBytes,
      sha256: String(observed.sha256).toLowerCase(),
      durationMs: Date.now() - started,
      verification,
    };
  } catch (error) {
    primaryError = error && error.code ? error : codedError('REMOTE_VERIFICATION_FAILED', error.message, error);
    throw primaryError;
  } finally {
    const cleanupTargets = [
      [archivePart, { force: true }],
      [archivePath, { force: true }],
      [stagingRoot, { recursive: true, force: true }],
      [tempRoot, { recursive: true, force: true }],
    ].filter(([target]) => typeof target === 'string');
    const cleanupErrors = [];
    for (const [target, options] of cleanupTargets) {
      try {
        await fsp.rm(target, options);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!primaryError && cleanupErrors.length > 0) {
      throw codedError('REMOTE_CLEANUP_FAILED', 'remote verification cleanup failed');
    }
  }
}

module.exports = { verifyRemoteCandidate, downloadRemoteArtifact, codedError };
