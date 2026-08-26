'use strict';

const semver = require('semver');

const {
  ARTIFACT_SCHEMA_VERSION,
  VerifiedRuntimeArtifact,
} = require('../runtime/verified-runtime-artifact');

// A cold GitHub Pages TLS/DNS path can exceed four seconds even when the
// stable index is healthy. This remains bounded and runs after first paint.
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INDEX_URL = process.env.DSH_VERIFIED_RUNTIME_INDEX_URL || '';

function sourceError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function requestJsonDefault(endpoint, timeoutMs) {
  if (!endpoint) return Promise.reject(sourceError('verified runtime index URL is not configured', 'VERIFIED_RUNTIME_SOURCE_NOT_CONFIGURED'));
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch (error) {
    return Promise.reject(sourceError('verified runtime index URL is invalid', 'VERIFIED_RUNTIME_SOURCE_INVALID', error));
  }
  if (parsedEndpoint.protocol !== 'http:' && parsedEndpoint.protocol !== 'https:') {
    return Promise.reject(sourceError('verified runtime index URL is invalid', 'VERIFIED_RUNTIME_SOURCE_INVALID'));
  }
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY) process.env.NODE_USE_ENV_PROXY ||= '1';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(parsedEndpoint, {
    headers: { accept: 'application/json' },
    signal: controller.signal,
  }).then(async (response) => {
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw sourceError(`verified runtime index returned HTTP ${response.status}`, 'VERIFIED_RUNTIME_SOURCE_UNREACHABLE');
    }
    return JSON.parse(await response.text());
  }).catch((error) => {
    if (error && error.code === 'VERIFIED_RUNTIME_SOURCE_UNREACHABLE') throw error;
    if (controller.signal.aborted) throw sourceError('verified runtime index request timed out', 'VERIFIED_RUNTIME_SOURCE_UNREACHABLE', error);
    throw sourceError(error && error.message || 'verified runtime index is unreachable', 'VERIFIED_RUNTIME_SOURCE_UNREACHABLE', error);
  }).finally(() => clearTimeout(timeout));
}

function VerifiedRuntimeUpdateSource({ indexUrl = DEFAULT_INDEX_URL, requestJson = requestJsonDefault, timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
  async function getLatest({ platform = process.platform, arch = process.arch } = {}) {
    let index;
    try {
      index = await requestJson(indexUrl, timeoutMs);
    } catch (error) {
      if (error && (error.code === 'VERIFIED_RUNTIME_SOURCE_NOT_CONFIGURED'
        || error.code === 'VERIFIED_RUNTIME_SOURCE_INVALID'
        || error.code === 'VERIFIED_RUNTIME_SOURCE_UNREACHABLE')) throw error;
      throw sourceError(error && error.message || 'verified runtime index is unreachable', 'VERIFIED_RUNTIME_SOURCE_UNREACHABLE', error);
    }
    if (!index || typeof index !== 'object' || Array.isArray(index) || index.schemaVersion !== ARTIFACT_SCHEMA_VERSION || !Array.isArray(index.artifacts)) {
      throw new Error('invalid verified runtime index schema');
    }

    const matching = [];
    for (const entry of index.artifacts) {
      try {
        const artifact = VerifiedRuntimeArtifact.fromIndexEntry(entry, { platform, arch });
        matching.push(artifact);
      } catch (error) {
        if (logger && typeof logger.warn === 'function') logger.warn(`Ignoring invalid verified runtime entry: ${error.message}`);
      }
    }
    if (matching.length === 0) throw new Error(`verified runtime index has no valid ${platform}-${arch} artifact`);
    matching.sort((left, right) => semver.rcompare(left.version, right.version));
    return matching[0];
  }

  return {
    getLatest,
    indexUrl,
    isConfigured: () => Boolean(indexUrl),
  };
}

module.exports = { VerifiedRuntimeUpdateSource, DEFAULT_INDEX_URL };
