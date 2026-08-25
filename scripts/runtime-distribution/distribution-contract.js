'use strict';

const semver = require('semver');

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function invalidVersion() {
  const error = new Error('distribution version must be an exact SemVer without a v prefix');
  error.code = 'DISTRIBUTION_INVALID_VERSION';
  throw error;
}

function normalizeExactVersion(value) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('v')) invalidVersion();
  const normalized = semver.valid(value);
  if (normalized === null || normalized !== value) invalidVersion();
  return normalized;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function artifactFileName({ version, platform, arch }) {
  const normalizedVersion = normalizeExactVersion(version);
  const target = assertTarget({ platform, arch });
  return `dsh-runtime-${normalizedVersion}-${target.platform}-${target.arch}.zip`;
}

function candidateReleaseTag(version) {
  return `dsh-runtime-v${normalizeExactVersion(version)}`;
}

function assertTarget(value) {
  const target = requireObject(value, 'target');
  if (target.platform !== 'win32' || target.arch !== 'x64') {
    throw new Error('distribution target must be win32/x64');
  }
  return { platform: target.platform, arch: target.arch };
}

function assertProductionHttpsUrl(url) {
  if (typeof url !== 'string' || url.length === 0) throw new TypeError('production URL must be a string');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('production URL must be an absolute HTTPS URL');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
    throw new Error('production URL must be a non-loopback HTTPS URL');
  }
  return url;
}

function candidateIdentity({ version, sha256, sizeBytes }) {
  const normalizedVersion = normalizeExactVersion(version);
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new Error('candidate sha256 must be a 64-character hexadecimal digest');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('candidate sizeBytes must be a positive safe integer');
  }
  return { version: normalizedVersion, sha256: sha256.toLowerCase(), sizeBytes };
}

function compareCandidateIdentity(existing, next) {
  const current = candidateIdentity(existing);
  const candidate = candidateIdentity(next);
  if (current.version !== candidate.version) return 'NEW';
  if (current.sha256 !== candidate.sha256 || current.sizeBytes !== candidate.sizeBytes) return 'HASH_CONFLICT';
  return 'ALREADY_PUBLISHED';
}

module.exports = {
  normalizeExactVersion,
  artifactFileName,
  candidateReleaseTag,
  assertTarget,
  assertProductionHttpsUrl,
  candidateIdentity,
  compareCandidateIdentity,
};
