'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs').promises;
const path = require('node:path');
const { Readable, Transform, pipeline: pipelineCallback } = require('node:stream');
const { promisify } = require('node:util');
const unzipper = require('unzipper');

const { validateArchiveEntry } = require('../runtime/verified-runtime-artifact');

const pipeline = promisify(pipelineCallback);
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_REDIRECTS = 5;

function downloadToFile(url, destination, expectedSize, timeoutMs, { onRedirect, onProgress } = {}) {
  const hash = crypto.createHash('sha256');
  const startedAt = Date.now();
  let bytes = 0;
  let lastProgressBytes = 0;
  let finalStatusCode = null;
  let redirectCount = 0;

  const requestUrl = (currentUrl) => {
    const parsedUrl = new URL(currentUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`runtime artifact download protocol is not allowed: ${parsedUrl.protocol}`);
    }
    return parsedUrl;
  };

  const requestOnce = async (currentUrl) => {
    const parsedUrl = requestUrl(currentUrl);
    if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY) {
      // Node 24's fetch can use the same corporate/provisioning proxy as the
      // release tooling when this opt-in is enabled at runtime. Environments
      // without a proxy remain direct; no proxy is hard-coded here.
      process.env.NODE_USE_ENV_PROXY ||= '1';
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(parsedUrl, {
        headers: { accept: 'application/zip, application/octet-stream' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('runtime artifact download timed out');
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const statusCode = Number(response.status || 0);
    if (statusCode >= 300 && statusCode < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error(`runtime artifact download redirect missing location (HTTP ${statusCode})`);
      if (redirectCount >= MAX_REDIRECTS) throw new Error(`runtime artifact download exceeded ${MAX_REDIRECTS} redirects`);
      const nextUrl = new URL(location, parsedUrl).toString();
      redirectCount += 1;
      onRedirect?.({ from: parsedUrl, to: new URL(nextUrl), statusCode, redirectCount });
      return requestOnce(nextUrl);
    }
    if (statusCode < 200 || statusCode >= 300) {
      await response.body?.cancel();
      throw new Error(`runtime artifact download returned HTTP ${statusCode}`);
    }
    if (!response.body) throw new Error('runtime artifact download returned no body');
    finalStatusCode = statusCode;
    const digestTransform = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        if (bytes - lastProgressBytes >= 1024 * 1024 || bytes === expectedSize) {
          lastProgressBytes = bytes;
          onProgress?.({
            downloadedBytes: bytes,
            totalBytes: expectedSize,
            elapsedMs: Date.now() - startedAt,
          });
        }
        callback(null, chunk);
      },
    });
    const writer = fs.createWriteStream(destination, { flags: 'wx' });
    await pipeline(Readable.fromWeb(response.body), digestTransform, writer);
    if (bytes !== expectedSize) throw new Error(`runtime artifact byte count mismatch: expected ${expectedSize}, received ${bytes}`);
    return { bytes, sha256: hash.digest('hex'), statusCode: finalStatusCode, redirectCount, durationMs: Date.now() - startedAt };
  };

  return requestOnce(url);
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

function RuntimeArtifactDownloader({ timeoutMs = DEFAULT_TIMEOUT_MS, extractArchive = extractZip, logger } = {}) {
  async function prepare({ artifact, stagingRoot, operationId }) {
    if (!artifact || typeof artifact !== 'object') throw new Error('runtime artifact is required');
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(operationId)) throw new Error('runtime artifact operation id is invalid');
    const operationRoot = path.resolve(stagingRoot, operationId);
    const archivePartPath = path.join(operationRoot, 'artifact.zip.part');
    const archivePath = path.join(operationRoot, 'artifact.zip');
    const extractionRoot = operationRoot;
    await fsp.mkdir(operationRoot, { recursive: true });
    try {
      const downloadStartedAt = Date.now();
      logger?.info?.(`runtime_artifact_download_started expectedBytes=${artifact.sizeBytes} timeoutMs=${timeoutMs}`);
      const result = await downloadToFile(artifact.artifactUrl, archivePartPath, artifact.sizeBytes, timeoutMs, {
        onRedirect: ({ from, to, statusCode, redirectCount }) => logger?.info?.(`runtime_artifact_download_redirect status=${statusCode} redirect=${redirectCount} fromHost=${from.hostname} toHost=${to.hostname}`),
        onProgress: ({ downloadedBytes, totalBytes, elapsedMs }) => logger?.info?.(`runtime_artifact_download_progress downloadedBytes=${downloadedBytes} totalBytes=${totalBytes} elapsedMs=${elapsedMs}`),
      });
      if (result.sha256 !== artifact.sha256.toLowerCase()) throw new Error(`runtime artifact SHA-256 mismatch: expected ${artifact.sha256}, received ${result.sha256}`);
      logger?.info?.(`runtime_artifact_download_completed status=${result.statusCode} redirects=${result.redirectCount} downloadedBytes=${result.bytes} elapsedMs=${Date.now() - downloadStartedAt} sha256=${result.sha256}`);
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
