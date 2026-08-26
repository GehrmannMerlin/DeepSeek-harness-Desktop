'use strict';

const fs = require('node:fs/promises');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const semver = require('./semver-lite');

const {
  normalizeExactVersion,
} = require('./distribution-contract');
const {
  PACKAGE_NAME,
  ENDPOINT: NPM_ENDPOINT,
} = require('../../src/update/npm-registry-update-source');

const SOURCE_REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness.git';
const SOURCE_MAPPING_NOT_AVAILABLE = 'SOURCE_MAPPING_NOT_AVAILABLE';
const SOURCE_PACKAGE_IDENTITY_MISMATCH = 'SOURCE_PACKAGE_IDENTITY_MISMATCH';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function sourceMappingError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = SOURCE_MAPPING_NOT_AVAILABLE;
  return error;
}

function defaultRequestJson(endpoint, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const request = https.get(endpoint, { headers: { accept: 'application/json' } }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(sourceMappingError(`npm registry returned HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      let size = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(sourceMappingError('npm registry response exceeded 2 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(chunks.join('')));
        } catch (error) {
          reject(sourceMappingError('npm registry response was not valid JSON', error));
        }
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(sourceMappingError('npm registry request timed out')));
    request.on('error', reject);
  });
}

async function defaultLsRemote(repository) {
  const result = await execFileAsync('git', ['ls-remote', '--tags', repository], { maxBuffer: 2 * 1024 * 1024 });
  return result.stdout;
}

async function defaultReadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readUpstreamLatest({ requestJson = defaultRequestJson } = {}) {
  let metadata;
  try {
    metadata = await requestJson(NPM_ENDPOINT);
  } catch (error) {
    if (error && error.code === SOURCE_MAPPING_NOT_AVAILABLE) throw error;
    throw sourceMappingError('unable to read npm upstream metadata', error);
  }

  const version = metadata && metadata['dist-tags'] && metadata['dist-tags'].latest;
  const exactVersion = typeof version === 'string' && semver.valid(version) === version ? version : null;
  const distribution = exactVersion && metadata.versions && metadata.versions[exactVersion] && metadata.versions[exactVersion].dist;
  if (!metadata || metadata.name !== PACKAGE_NAME || !exactVersion || !distribution || typeof distribution.integrity !== 'string' || distribution.integrity.length === 0) {
    throw sourceMappingError('npm latest metadata is missing a valid package, version, or dist.integrity');
  }

  return { version: exactVersion, distIntegrity: distribution.integrity, metadata };
}

async function resolveExactSourceTag({ version, lsRemote = defaultLsRemote } = {}) {
  let exactVersion;
  try {
    exactVersion = normalizeExactVersion(version);
  } catch (error) {
    throw sourceMappingError(`source tag version is invalid: ${version}`, error);
  }

  const tag = `dsh-v${exactVersion}`;
  let output;
  try {
    output = await lsRemote(SOURCE_REPOSITORY);
  } catch (error) {
    throw sourceMappingError(`unable to resolve source tag ${tag}`, error);
  }

  const refs = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{40})\s+(refs\/tags\/[^\s]+)$/i);
    if (match) refs.set(match[2], match[1].toLowerCase());
  }
  const commit = refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`);
  if (!commit || !COMMIT_PATTERN.test(commit)) {
    throw sourceMappingError(`exact source tag ${tag} is not available`);
  }
  return { tag, commit };
}

function assertSourcePackageIdentity({ packageJson, version } = {}) {
  let exactVersion;
  try {
    exactVersion = normalizeExactVersion(version);
  } catch (error) {
    const mismatch = new Error('source package version is invalid', { cause: error });
    mismatch.code = SOURCE_PACKAGE_IDENTITY_MISMATCH;
    throw mismatch;
  }
  if (!packageJson || packageJson.name !== PACKAGE_NAME || packageJson.version !== exactVersion) {
    const error = new Error(`source package must be ${PACKAGE_NAME}@${exactVersion}`);
    error.code = SOURCE_PACKAGE_IDENTITY_MISMATCH;
    throw error;
  }
  return { name: packageJson.name, version: packageJson.version };
}

function createSourceMapping({ requestJson = defaultRequestJson, lsRemote = defaultLsRemote, readJson = defaultReadJson } = {}) {
  return {
    readLatest: () => readUpstreamLatest({ requestJson }),
    resolveTag: (version) => resolveExactSourceTag({ version, lsRemote }),
    verifyPackage: async (packageJsonOrPath, version) => {
      const packageJson = typeof packageJsonOrPath === 'string'
        ? await readJson(packageJsonOrPath)
        : packageJsonOrPath;
      return assertSourcePackageIdentity({ packageJson, version });
    },
  };
}

module.exports = {
  PACKAGE_NAME,
  NPM_ENDPOINT,
  SOURCE_REPOSITORY,
  readUpstreamLatest,
  resolveExactSourceTag,
  assertSourcePackageIdentity,
  createSourceMapping,
};
