'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs').promises;
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { Transform, pipeline: pipelineCallback } = require('node:stream');
const { promisify } = require('node:util');
const unzipper = require('unzipper');

const { validateArchiveEntry } = require('../runtime/verified-runtime-artifact');

const pipeline = promisify(pipelineCallback);
const DEFAULT_TIMEOUT_MS = 120000;

function downloadToFile(url, destination, expectedSize, timeoutMs) {
  const client = new URL(url).protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const hash = crypto.createHash('sha256');
    const digestTransform = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const request = client.get(url, { headers: { accept: 'application/zip, application/octet-stream' } }, async (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`runtime artifact download returned HTTP ${response.statusCode}`));
        return;
      }
      const writer = fs.createWriteStream(destination, { flags: 'wx' });
      try {
        await pipeline(response, digestTransform, writer);
        if (bytes !== expectedSize) throw new Error(`runtime artifact byte count mismatch: expected ${expectedSize}, received ${bytes}`);
        resolve({ bytes, sha256: hash.digest('hex') });
      } catch (error) {
        reject(error);
      }
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('runtime artifact download timed out')));
    request.on('error', reject);
  });
}

async function extractZip(archivePathOrOptions, extractionRootArgument) {
  const { archivePath, extractionRoot, onProgress } = typeof archivePathOrOptions === 'object'
    ? archivePathOrOptions
    : { archivePath: archivePathOrOptions, extractionRoot: extractionRootArgument };
  const directory = await unzipper.Open.file(archivePath);
  const entries = directory.files || [];
  const fileEntries = entries.filter((entry) => entry.type !== 'Directory' && !entry.path.endsWith('/'));
  const totalBytes = fileEntries.reduce((sum, entry) => sum + Number(entry.vars?.uncompressedSize || 0), 0);
  let processedFiles = 0;
  let processedBytes = 0;
  const destinations = entries.map((entry) => {
    if (entry.type && entry.type !== 'File' && entry.type !== 'Directory') {
      throw new Error(`runtime artifact archive entry type is not allowed: ${entry.path}`);
    }
    return { entry, destination: validateArchiveEntry(entry.path, extractionRoot) };
  });
  await fsp.mkdir(extractionRoot, { recursive: true });
  for (const { entry, destination } of destinations) {
    if (entry.type === 'Directory' || entry.path.endsWith('/')) {
      await fsp.mkdir(destination, { recursive: true });
      continue;
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await pipeline(entry.stream(), fs.createWriteStream(destination, { flags: 'wx' }));
    processedFiles += 1;
    processedBytes += Number(entry.vars?.uncompressedSize || 0);
    onProgress?.({ processedFiles, totalFiles: fileEntries.length, processedBytes, totalBytes });
  }
  return extractionRoot;
}

function RuntimeArtifactDownloader({ timeoutMs = DEFAULT_TIMEOUT_MS, extractArchive = extractZip } = {}) {
  async function prepare({ artifact, stagingRoot, operationId }) {
    if (!artifact || typeof artifact !== 'object') throw new Error('runtime artifact is required');
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(operationId)) throw new Error('runtime artifact operation id is invalid');
    const operationRoot = path.resolve(stagingRoot, operationId);
    const archivePartPath = path.join(operationRoot, 'artifact.zip.part');
    const archivePath = path.join(operationRoot, 'artifact.zip');
    const extractionRoot = operationRoot;
    await fsp.mkdir(operationRoot, { recursive: true });
    try {
      const result = await downloadToFile(artifact.artifactUrl, archivePartPath, artifact.sizeBytes, timeoutMs);
      if (result.sha256 !== artifact.sha256.toLowerCase()) throw new Error(`runtime artifact SHA-256 mismatch: expected ${artifact.sha256}, received ${result.sha256}`);
      await fsp.rename(archivePartPath, archivePath);
      const rootPath = await extractArchive({ archivePath, extractionRoot, artifact });
      return { rootPath, archivePath, operationRoot, artifact };
    } catch (error) {
      await Promise.all([
        fsp.rm(archivePartPath, { force: true }),
        fsp.rm(archivePath, { force: true }),
        fsp.rm(operationRoot, { recursive: true, force: true }),
      ]);
      throw error;
    }
  }

  return { prepare };
}

module.exports = { RuntimeArtifactDownloader, extractZip, downloadToFile };
