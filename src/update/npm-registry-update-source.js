'use strict';

const https = require('node:https');
const semver = require('semver');

const PACKAGE_NAME = '@deepseek-ai/dsh';
const ENDPOINT = 'https://registry.npmjs.org/@deepseek-ai%2fdsh';
const DIST_TAG = 'latest';
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function defaultRequestJson(endpoint, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(endpoint, { headers: { accept: 'application/json' } }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`npm registry returned HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      let size = 0;
      let overflowed = false;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > MAX_RESPONSE_BYTES) {
          overflowed = true;
          request.destroy(new Error('npm registry response exceeded 2 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (overflowed) return;
        try {
          resolve(JSON.parse(chunks.join('')));
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error('npm registry request timed out')));
    request.on('error', reject);
  });
}

function logFailure(logger, error) {
  if (logger && typeof logger.warn === 'function') {
    logger.warn(`DSH npm update check failed: ${error.message}`);
  }
}

function NpmRegistryUpdateSource({ requestJson = defaultRequestJson, timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
  async function getLatest() {
    try {
      const metadata = await requestJson(ENDPOINT, timeoutMs);
      if (!metadata || metadata.name !== PACKAGE_NAME) throw new Error('npm registry package name mismatch');

      const version = metadata['dist-tags'] && metadata['dist-tags'][DIST_TAG];
      if (!version || !semver.valid(version)) throw new Error('npm registry latest version is invalid');

      const dist = metadata.versions && metadata.versions[version] && metadata.versions[version].dist;
      if (!dist || typeof dist !== 'object') throw new Error('npm registry latest distribution is missing');

      return {
        packageName: PACKAGE_NAME,
        version,
        distTag: DIST_TAG,
        integrity: typeof dist.integrity === 'string' ? dist.integrity : null,
        tarball: typeof dist.tarball === 'string' ? dist.tarball : null,
      };
    } catch (error) {
      logFailure(logger, error);
      throw error;
    }
  }

  function compareLatest(installedVersion, latestVersion) {
    const installed = semver.valid(installedVersion);
    const latest = semver.valid(latestVersion);
    if (!latest || !installed) return 'UPDATE_AVAILABLE';
    if (semver.gt(latest, installed)) return 'UPDATE_AVAILABLE';
    if (semver.gt(installed, latest)) return 'AHEAD_OF_LATEST';
    return 'UP_TO_DATE';
  }

  return { getLatest, compareLatest };
}

module.exports = { NpmRegistryUpdateSource, PACKAGE_NAME, ENDPOINT, DIST_TAG };
