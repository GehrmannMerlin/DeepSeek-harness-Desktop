'use strict';

const semver = require('./semver-lite');
const net = require('node:net');

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
  if (parsed.protocol !== 'https:' || isLoopbackOrLocalHostname(hostname)) {
    throw new Error('production URL must be a non-loopback HTTPS URL');
  }
  return url;
}

function isLoopbackOrLocalHostname(hostname) {
  const normalized = hostname.replace(/\.+$/, '').replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;

  if (net.isIP(normalized) === 4) {
    return normalized.split('.').map(Number)[0] === 127;
  }
  if (net.isIP(normalized) !== 6) return false;

  const groups = normalized.split(':');
  const expanded = [];
  const gap = groups.indexOf('');
  if (gap >= 0) {
    const left = groups.slice(0, gap).filter(Boolean);
    const right = groups.slice(gap + 1).filter(Boolean);
    expanded.push(...left, ...Array(8 - left.length - right.length).fill('0'), ...right);
  } else {
    expanded.push(...groups);
  }
  const words = expanded.map((group) => Number.parseInt(group || '0', 16));
  if (words.length !== 8) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  return words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff &&
    (words[6] >>> 8) === 0x7f;
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
  if (current.sha256 !== candidate.sha256) return 'HASH_CONFLICT';
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
