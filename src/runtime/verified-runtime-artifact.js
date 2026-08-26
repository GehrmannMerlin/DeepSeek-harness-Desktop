'use strict';

const path = require('node:path');
const semver = require('./semver-lite');

const PACKAGE_NAME = '@deepseek-ai/dsh';
const ARTIFACT_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function fail(message) {
  const error = new Error(`invalid verified runtime artifact: ${message}`);
  error.code = 'INVALID_VERIFIED_RUNTIME_ARTIFACT';
  throw error;
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function requireTarget(value, field) {
  if (value !== 'win32' && value !== 'linux' && value !== 'darwin') fail(`${field} is unsupported`);
  return value;
}

function requireArch(value, field) {
  if (value !== 'x64' && value !== 'arm64' && value !== 'ia32') fail(`${field} is unsupported`);
  return value;
}

function requireHttpUrl(value, field) {
  requireString(value, field);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${field} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') fail(`${field} must be an absolute HTTP(S) URL`);
  return value;
}

function validateManifest(manifest, identity) {
  const value = requireObject(manifest, 'manifest');
  if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION) fail('manifest schemaVersion is unsupported');
  if (value.packageName !== identity.packageName) fail('manifest packageName does not match artifact');
  if (value.version !== identity.version || !semver.valid(value.version)) fail('manifest version does not match artifact');
  if (value.platform !== identity.platform) fail('manifest platform does not match artifact');
  if (value.arch !== identity.arch) fail('manifest arch does not match artifact');
  requireString(value.cliEntry, 'manifest.cliEntry');
  validateArchiveEntry(value.cliEntry, 'runtime-root');
  return {
    schemaVersion: value.schemaVersion,
    packageName: value.packageName,
    version: value.version,
    platform: value.platform,
    arch: value.arch,
    cliEntry: value.cliEntry,
  };
}

function fromIndexEntry(entry, target = {}) {
  const value = requireObject(entry, 'entry');
  const packageName = value.packageName;
  if (packageName !== PACKAGE_NAME) fail('packageName is not DSH');
  const version = requireString(value.version, 'version');
  if (!semver.valid(version)) fail('version is not valid SemVer');
  const platform = requireTarget(value.platform, 'platform');
  const arch = requireArch(value.arch, 'arch');
  if (target.platform && target.platform !== platform) fail('platform does not match requested target');
  if (target.arch && target.arch !== arch) fail('arch does not match requested target');
  const artifactUrl = requireHttpUrl(value.artifactUrl, 'artifactUrl');
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) fail('sizeBytes must be a positive safe integer');
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) fail('sha256 must be a 64-character hexadecimal digest');
  const manifest = validateManifest(value.manifest, { packageName, version, platform, arch });
  return { packageName, version, platform, arch, artifactUrl, sizeBytes: value.sizeBytes, sha256: value.sha256.toLowerCase(), manifest };
}

function validateArchiveEntry(entryName, extractionRoot) {
  if (typeof entryName !== 'string' || entryName.length === 0 || entryName.includes('\0')) fail('archive entry name is invalid');
  const normalizedName = entryName.replaceAll('\\', '/');
  if (normalizedName.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedName)) fail(`archive entry is absolute: ${entryName}`);
  const root = path.resolve(extractionRoot);
  const destination = path.resolve(root, normalizedName);
  const relative = path.relative(root, destination);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`archive entry escapes extraction root: ${entryName}`);
  return destination;
}

const VerifiedRuntimeArtifact = Object.freeze({ fromIndexEntry, validateManifest });

module.exports = {
  ARTIFACT_SCHEMA_VERSION,
  PACKAGE_NAME,
  VerifiedRuntimeArtifact,
  validateArchiveEntry,
  validateManifest,
};
