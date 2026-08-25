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

function requestJsonDefault(endpoint, timeoutMs) {
  if (!endpoint) return Promise.reject(new Error('verified runtime index URL is not configured'));
  const client = new URL(endpoint).protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(endpoint, { headers: { accept: 'application/json' } }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`verified runtime index returned HTTP ${response.statusCode}`));
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
    request.setTimeout(timeoutMs, () => request.destroy(new Error('verified runtime index request timed out')));
    request.on('error', reject);
  });
}

function VerifiedRuntimeUpdateSource({ indexUrl = DEFAULT_INDEX_URL, requestJson = requestJsonDefault, timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
  async function getLatest({ platform = process.platform, arch = process.arch } = {}) {
    const index = await requestJson(indexUrl, timeoutMs);
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

  return { getLatest, indexUrl };
}

module.exports = { VerifiedRuntimeUpdateSource, DEFAULT_INDEX_URL };
