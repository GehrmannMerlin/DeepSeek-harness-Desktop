'use strict';

const http = require('node:http');
const https = require('node:https');
const semver = require('semver');

const {
  ARTIFACT_SCHEMA_VERSION,
  VerifiedRuntimeArtifact,
} = require('../runtime/verified-runtime-artifact');

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_INDEX_URL = process.env.DSH_VERIFIED_RUNTIME_INDEX_URL || '';

function sourceError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function requestJsonDefault(endpoint, timeoutMs) {
  if (!endpoint) return Promise.reject(sourceError('verified runtime index URL is not configured', 'VERIFIED_RUNTIME_SOURCE_NOT_CONFIGURED'));
  let client;
  try {
    client = new URL(endpoint).protocol === 'https:' ? https : http;
  } catch (error) {
    return Promise.reject(sourceError('verified runtime index URL is invalid', 'VERIFIED_RUNTIME_SOURCE_INVALID', error));
  }
  return new Promise((resolve, reject) => {
    const request = client.get(endpoint, { headers: { accept: 'application/json' } }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(sourceError(`verified runtime index returned HTTP ${response.statusCode}`, 'VERIFIED_RUNTIME_SOURCE_UNREACHABLE'));
        return;
      }
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(chunks.join('')));
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(sourceError('verified runtime index request timed out', 'VERIFIED_RUNTIME_SOURCE_UNREACHABLE')));
    request.on('error', (error) => reject(error.code === 'VERIFIED_RUNTIME_SOURCE_UNREACHABLE'
      ? error
      : sourceError(error.message || 'verified runtime index is unreachable', 'VERIFIED_RUNTIME_SOURCE_UNREACHABLE', error)));
  });
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
