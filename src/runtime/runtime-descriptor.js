'use strict';

const path = require('node:path');
const semver = require('semver');

const DESCRIPTOR_KINDS = new Set(['managed', 'bundled', 'legacy']);
const SOURCES = new Set(['managed', 'bundled', 'system-npx']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAbsolutePath(value) {
  return isNonEmptyString(value) && path.isAbsolute(value);
}

function assertDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Runtime descriptor must be an object');
  }
  if (!DESCRIPTOR_KINDS.has(value.kind)) {
    throw new TypeError('Runtime descriptor kind must be managed, bundled, or legacy');
  }
  const versionValid = value.version === 'unknown' || semver.valid(value.version) !== null;
  if ((value.kind === 'managed' || value.kind === 'bundled') && !isNonEmptyString(value.version)) {
    throw new TypeError('Managed and bundled descriptors require a version');
  }
  if (!versionValid || (value.kind !== 'legacy' && value.version === 'unknown')) {
    throw new TypeError('Runtime descriptor version must be valid SemVer');
  }
  for (const field of ['rootPath', 'packagePath', 'cliEntry']) {
    if (value[field] !== undefined && !isAbsolutePath(value[field])) {
      throw new TypeError(`${field} must be an absolute path`);
    }
  }
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('Runtime descriptor args must be a string array');
  }
  if (!isNonEmptyString(value.command)) {
    throw new TypeError('Runtime descriptor command must be a non-empty string');
  }
  const expectedSource = value.kind === 'legacy' ? 'system-npx' : value.kind;
  if (!SOURCES.has(value.source) || value.source !== expectedSource) {
    throw new TypeError(`Runtime descriptor source must be ${expectedSource}`);
  }
  return true;
}

function createRuntimeDescriptor(input) {
  assertDescriptor(input);
  return {
    ...input,
    args: [...input.args],
  };
}

function isRuntimeDescriptor(value) {
  try {
    assertDescriptor(value);
    return true;
  } catch {
    return false;
  }
}

function descriptorToState(descriptor, relativePath) {
  const normalized = createRuntimeDescriptor(descriptor);
  if (!isNonEmptyString(relativePath) || path.isAbsolute(relativePath)) {
    throw new TypeError('Runtime state relativePath must be a non-empty relative path');
  }
  return {
    relativePath,
    kind: normalized.kind,
    version: normalized.version,
  };
}

module.exports = {
  createRuntimeDescriptor,
  isRuntimeDescriptor,
  descriptorToState,
};

