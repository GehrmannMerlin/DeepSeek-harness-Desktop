'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const semver = require('./semver-lite');
const { isDeepStrictEqual } = require('node:util');

const {
  artifactFileName,
  assertProductionHttpsUrl,
  assertTarget,
  candidateIdentity,
  compareCandidateIdentity,
  normalizeExactVersion,
} = require('./distribution-contract');

const DESCRIPTOR_FIELDS = [
  'schemaVersion', 'packageName', 'version', 'platform', 'arch', 'artifactUrl',
  'sizeBytes', 'sha256', 'manifest', 'provenance', 'status',
];

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function candidateDirectory(root, version) {
  return path.join(root, `candidate-${normalizeExactVersion(version)}`);
}

function descriptorFor(candidate) {
  const version = normalizeExactVersion(candidate && candidate.version);
  const target = assertTarget(candidate);
  const identity = candidateIdentity(candidate);
  if (typeof candidate.packageName !== 'string' || candidate.packageName.length === 0) {
    throw new TypeError('candidate packageName must be a non-empty string');
  }
  assertProductionHttpsUrl(candidate.artifactUrl);
  if (!candidate.manifest || typeof candidate.manifest !== 'object' || Array.isArray(candidate.manifest)) {
    throw new TypeError('candidate manifest must be an object');
  }
  if (!candidate.provenance || typeof candidate.provenance !== 'object' || Array.isArray(candidate.provenance)) {
    throw new TypeError('candidate provenance must be an object');
  }
  if (typeof candidate.status !== 'string' || candidate.status.length === 0) {
    throw new TypeError('candidate status must be a non-empty string');
  }
  return {
    schemaVersion: 1,
    packageName: candidate.packageName,
    version,
    platform: target.platform,
    arch: target.arch,
    artifactUrl: candidate.artifactUrl,
    sizeBytes: identity.sizeBytes,
    sha256: identity.sha256,
    manifest: candidate.manifest,
    provenance: candidate.provenance,
    status: candidate.status,
  };
}

function assertDescriptorShape(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw codedError('CANDIDATE_INVALID_METADATA', 'candidate descriptor must be an object');
  }
  if (Object.keys(descriptor).sort().join('\0') !== DESCRIPTOR_FIELDS.slice().sort().join('\0')) {
    throw codedError('CANDIDATE_INVALID_METADATA', 'candidate descriptor fields are invalid');
  }
  if (descriptor.schemaVersion !== 1) {
    throw codedError('CANDIDATE_INVALID_METADATA', 'candidate descriptor schema version is invalid');
  }
  return descriptorFor(descriptor);
}

async function exists(directory) {
  try { await fsp.access(directory); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readDescriptor(root, version) {
  const normalized = normalizeExactVersion(version);
  const directory = candidateDirectory(root, normalized);
  if (!(await exists(directory))) return null;
  try {
    let descriptor;
    try {
      descriptor = JSON.parse(await fsp.readFile(path.join(directory, 'candidate-runtime-index.json'), 'utf8'));
    } catch (error) {
      throw codedError('CANDIDATE_INVALID_METADATA', `candidate descriptor cannot be read: ${error.message}`);
    }
    if (descriptor.version !== normalized) {
      throw codedError('CANDIDATE_INVALID_METADATA', 'candidate descriptor version does not match its directory');
    }
    const validated = assertDescriptorShape(descriptor);
    const zipName = artifactFileName(validated);
    const required = [
      zipName,
      'runtime-manifest.json',
      `${zipName}.sha256`,
      'factory-provenance.json',
      'candidate-runtime-index.json',
    ];
    for (const file of required) {
      if (!(await exists(path.join(directory, file)))) {
        throw codedError('CANDIDATE_INVALID_METADATA', `candidate asset is missing: ${file}`);
      }
    }

    let manifest;
    let provenance;
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(directory, 'runtime-manifest.json'), 'utf8'));
      provenance = JSON.parse(await fsp.readFile(path.join(directory, 'factory-provenance.json'), 'utf8'));
    } catch (error) {
      throw codedError('CANDIDATE_INVALID_METADATA', `candidate metadata cannot be parsed: ${error.message}`);
    }
    if (!isDeepStrictEqual(manifest, validated.manifest)) {
      throw codedError('CANDIDATE_INVALID_METADATA', 'runtime manifest does not match candidate descriptor');
    }
    if (!isDeepStrictEqual(provenance, validated.provenance)) {
      throw codedError('CANDIDATE_INVALID_METADATA', 'factory provenance does not match candidate descriptor');
    }

    const checksumText = await fsp.readFile(path.join(directory, `${zipName}.sha256`), 'utf8');
    const checksumMatch = /^([a-f0-9]{64})\s+(.+?)\s*$/.exec(checksumText);
    if (!checksumMatch || checksumMatch[1].toLowerCase() !== validated.sha256 || checksumMatch[2] !== zipName) {
      throw codedError('CANDIDATE_INVALID_METADATA', 'checksum metadata does not match candidate descriptor');
    }
    const zipPath = path.join(directory, zipName);
    const [zipBytes, zipStat] = await Promise.all([fsp.readFile(zipPath), fsp.stat(zipPath)]);
    const observedSha256 = crypto.createHash('sha256').update(zipBytes).digest('hex');
    if (zipStat.size !== validated.sizeBytes || observedSha256 !== validated.sha256) {
      throw codedError('CANDIDATE_INVALID_METADATA', 'candidate ZIP identity does not match descriptor');
    }
    return validated;
  } catch (error) {
    if (error.code === 'CANDIDATE_INVALID_METADATA') throw error;
    throw codedError('CANDIDATE_INVALID_METADATA', `candidate metadata is invalid: ${error.message}`);
  }
}

async function writeJson(filePath, value) {
  const handle = await fsp.open(filePath, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function createFileCandidateStore({ root, now = () => new Date().toISOString() }) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('root must be a non-empty string');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  async function read(version) {
    return readDescriptor(root, version);
  }

  async function publish(input) {
    const descriptor = descriptorFor(input);
    const finalDirectory = candidateDirectory(root, descriptor.version);
    const existing = await read(descriptor.version);
    if (existing) {
      const decision = compareCandidateIdentity(existing, descriptor);
      if (decision === 'ALREADY_PUBLISHED') return { status: 'ALREADY_PUBLISHED', candidate: existing };
      throw codedError('CANDIDATE_HASH_CONFLICT', `candidate ${descriptor.version} already has a different SHA-256`);
    }
    if (typeof input.zipPath !== 'string' || input.zipPath.length === 0) throw new TypeError('candidate zipPath is required');

    await fsp.mkdir(root, { recursive: true });
    const tempDirectory = path.join(root, `candidate-${descriptor.version}.tmp-${process.pid}-${crypto.randomUUID()}`);
    const zipName = artifactFileName(descriptor);
    try {
      await fsp.mkdir(tempDirectory);
      await fsp.copyFile(input.zipPath, path.join(tempDirectory, zipName), fs.constants.COPYFILE_EXCL);
      await writeJson(path.join(tempDirectory, 'runtime-manifest.json'), descriptor.manifest);
      await fsp.writeFile(path.join(tempDirectory, `${zipName}.sha256`), `${descriptor.sha256}  ${zipName}\n`, 'utf8');
      await writeJson(path.join(tempDirectory, 'factory-provenance.json'), descriptor.provenance);
      await writeJson(path.join(tempDirectory, 'candidate-runtime-index.json'), descriptor);
      try {
        await fsp.rename(tempDirectory, finalDirectory);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const raced = await read(descriptor.version);
        if (raced && compareCandidateIdentity(raced, descriptor) === 'ALREADY_PUBLISHED') {
          return { status: 'ALREADY_PUBLISHED', candidate: raced };
        }
        throw codedError('CANDIDATE_HASH_CONFLICT', `candidate ${descriptor.version} already has a different SHA-256`);
      }
      return { status: 'PUBLISHED', candidate: descriptor };
    } finally {
      if (await exists(tempDirectory)) await fsp.rm(tempDirectory, { recursive: true, force: true });
    }
  }

  async function list() {
    await fsp.mkdir(root, { recursive: true });
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^candidate-(?!.*\.tmp-)/.test(entry.name)) continue;
      const match = /^candidate-(.+)$/.exec(entry.name);
      if (match) candidates.push(await readDescriptor(root, match[1]));
    }
    return candidates.filter(Boolean).sort((left, right) => semver.rcompare(left.version, right.version));
  }

  return {
    publish,
    read,
    list,
    assetPath(version) {
      const normalized = normalizeExactVersion(version);
      return path.join(candidateDirectory(root, normalized), artifactFileName({ version: normalized, platform: 'win32', arch: 'x64' }));
    },
  };
}

module.exports = { createFileCandidateStore };
