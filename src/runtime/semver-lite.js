'use strict';

const IDENTIFIER = '[0-9A-Za-z-]+';
const NUMERIC_IDENTIFIER = '(?:0|[1-9]\\d*)';
const VERSION_PATTERN = new RegExp(
  `^(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})` +
  `(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?` +
  `(?:\\+(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`,
);

function parse(version) {
  if (typeof version !== 'string') return null;
  const match = VERSION_PATTERN.exec(version);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((identifier) => /^0\d+$/.test(identifier))) return null;
  return {
    version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function valid(version) {
  return parse(version) ? version : null;
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compare(left, right) {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new TypeError('semver-lite.compare requires exact SemVer values');
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= a.prerelease.length) return -1;
    if (index >= b.prerelease.length) return 1;
    const result = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (result !== 0) return result < 0 ? -1 : 1;
  }
  return 0;
}

function rcompare(left, right) {
  return compare(right, left);
}

function gt(left, right) {
  return compare(left, right) > 0;
}

module.exports = { valid, compare, rcompare, gt };
