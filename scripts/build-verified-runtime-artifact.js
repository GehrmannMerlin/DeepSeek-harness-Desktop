'use strict';

const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { deflateRawSync } = require('node:zlib');

const { verifyRuntime, resolveCliEntry } = require('../src/update/runtime-verifier');
const { validateManifest, PACKAGE_NAME } = require('../src/runtime/verified-runtime-artifact');
const { waitUntilReady } = require('../src/health/harness-health-checker');

const DEFAULT_PLATFORM = 'win32';
const DEFAULT_ARCH = 'x64';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function putUInt16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function putUInt32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function zipHeader(signature, fields) {
  return Buffer.concat([
    putUInt32(signature),
    ...fields.map((value, index) => index < 4 ? putUInt16(value) : putUInt32(value)),
  ]);
}

async function walkFiles(root, current = '') {
  const directory = path.join(root, current);
  const entries = (await fsp.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const relative = path.join(current, entry.name);
    const absolute = path.join(root, relative);
    if (entry.isDirectory()) files.push(...await walkFiles(root, relative));
    else if (entry.isFile()) {
      const stat = await fsp.stat(absolute);
      files.push({ absolute, relative: relative.split(path.sep).join('/'), sizeBytes: stat.size });
    }
    else throw new Error(`Factory output contains an unsupported link or special file: ${relative}`);
  }
  return files;
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function heartbeatIntervalMs() {
  const configured = Number(process.env.DSH_FACTORY_HEARTBEAT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 10000;
}

async function measurePhase(name, timings, operation) {
  const started = performance.now();
  const heartbeat = setInterval(() => {
    const elapsedMs = Math.round(performance.now() - started);
    console.error(`[FACTORY_HEARTBEAT] phase=${name} elapsedMs=${elapsedMs}`);
  }, heartbeatIntervalMs());
  heartbeat.unref?.();
  console.error(`[FACTORY_PHASE_START] phase=${name}`);
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    const elapsedMs = Math.round(performance.now() - started);
    timings[name] = elapsedMs;
    console.error(`[FACTORY_PHASE] phase=${name} elapsedMs=${elapsedMs}`);
  }
}

function readFreeDiskBytes(targetPath) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const root = path.parse(path.resolve(targetPath)).root;
    const stats = fs.statfsSync(root);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (_) {
    return null;
  }
}

function createProgressReporter(phase, onProgress) {
  const started = performance.now();
  let lastLog = 0;
  return ({ processedFiles, totalFiles = null, processedBytes, totalBytes = null, force = false }) => {
    const elapsedMs = Math.max(1, performance.now() - started);
    const elapsedSeconds = elapsedMs / 1000;
    const throughputFilesPerSec = processedFiles / elapsedSeconds;
    const throughputMBps = processedBytes / 1024 / 1024 / elapsedSeconds;
    const remainingFiles = Number.isFinite(totalFiles) ? Math.max(0, totalFiles - processedFiles) : null;
    const remainingBytes = Number.isFinite(totalBytes) ? Math.max(0, totalBytes - processedBytes) : null;
    const etaMs = remainingBytes != null && throughputMBps > 0
      ? Math.round((remainingBytes / 1024 / 1024) / throughputMBps * 1000)
      : remainingFiles != null && throughputFilesPerSec > 0
        ? Math.round(remainingFiles / throughputFilesPerSec * 1000)
        : null;
    const event = { phase, processedFiles, totalFiles, processedBytes, totalBytes, throughputFilesPerSec, throughputMBps, etaMs };
    if (typeof onProgress === 'function') onProgress(event);
    const now = performance.now();
    if (force || now - lastLog >= heartbeatIntervalMs()) {
      lastLog = now;
      console.error(`[FACTORY_PROGRESS] phase=${phase} files=${processedFiles}/${totalFiles ?? '?'} bytes=${processedBytes}/${totalBytes ?? '?'} throughputFilesPerSec=${throughputFilesPerSec.toFixed(2)} throughputMBps=${throughputMBps.toFixed(2)} etaMs=${etaMs ?? '?'}`);
    }
  };
}

async function scanRuntimeFiles(sourceRoot, { onProgress } = {}) {
  const root = await fsp.realpath(sourceRoot);
  const boundary = await fsp.realpath(path.dirname(sourceRoot));
  const files = [];
  let processedBytes = 0;
  const report = createProgressReporter('preScanMs', onProgress);

  async function visit(candidate, relative, active) {
    const realCandidate = await fsp.realpath(candidate);
    if (!isWithinRoot(boundary, realCandidate)) {
      throw new Error(`Factory source link escapes the allowed runtime boundary: ${candidate}`);
    }
    const stat = await fsp.lstat(candidate);
    if (stat.isSymbolicLink()) {
      if (active.has(realCandidate)) return;
      return visit(realCandidate, relative, active);
    }
    if (active.has(realCandidate)) throw new Error(`Factory source contains a recursive link: ${candidate}`);
    active.add(realCandidate);
    try {
      if (stat.isDirectory()) {
        const entries = (await fsp.readdir(candidate, { withFileTypes: true }))
          .filter((entry) => !(path.basename(candidate) === 'node_modules' && (entry.name === '.pnpm' || entry.name === '.pnpm-workspace-state-v1.json')))
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) await visit(path.join(candidate, entry.name), path.join(relative, entry.name), active);
        return;
      }
      if (!stat.isFile()) throw new Error(`Factory source contains an unsupported link or special file: ${candidate}`);
      files.push({ absolute: realCandidate, relative: normalizeRelativePath(relative), sizeBytes: stat.size });
      processedBytes += stat.size;
      report({ processedFiles: files.length, processedBytes });
    } finally {
      active.delete(realCandidate);
    }
  }

  await visit(root, '', new Set());
  report({ processedFiles: files.length, totalFiles: files.length, processedBytes, totalBytes: processedBytes, force: true });
  return files;
}

async function cloneMaterializedTree(source, destination, state) {
  const entries = (await fsp.readdir(source, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  await fsp.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await cloneMaterializedTree(sourceEntry, destinationEntry, state);
    } else if (entry.isFile()) {
      await fsp.mkdir(path.dirname(destinationEntry), { recursive: true });
      if (state.hardLinksEnabled) {
        try {
          await fsp.link(sourceEntry, destinationEntry);
          continue;
        } catch (error) {
          if (error.code === 'EEXIST') continue;
          state.hardLinksEnabled = false;
        }
      }
      await fsp.copyFile(sourceEntry, destinationEntry);
      state.fullTreeCopyCount = (state.fullTreeCopyCount || 0) + 1;
    } else {
      throw new Error(`Factory materialized cache contains an unsupported file: ${sourceEntry}`);
    }
  }
}

async function copyTree(source, destination, active = new Set(), state = { materialized: new Map(), hardLinksEnabled: true }) {
  const realSource = await fsp.realpath(source);
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink()) {
    if (active.has(realSource)) return;
    return copyTree(realSource, destination, active, state);
  }
  if (active.has(realSource)) throw new Error(`Factory source contains a recursive link: ${source}`);
  const cachedDestination = state.materialized.get(realSource);
  if (cachedDestination) {
    await cloneMaterializedTree(cachedDestination, destination, state);
    return;
  }
  active.add(realSource);
  state.materialized.set(realSource, destination);
  try {
    if (stat.isDirectory()) {
      await fsp.mkdir(destination, { recursive: true });
      const entries = (await fsp.readdir(source, { withFileTypes: true }))
        .filter((entry) => !(path.basename(source) === 'node_modules' && (entry.name === '.pnpm' || entry.name === '.pnpm-workspace-state-v1.json')))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) await copyTree(path.join(source, entry.name), path.join(destination, entry.name), active, state);
      return;
    }
    if (!stat.isFile()) throw new Error(`Factory source contains an unsupported file: ${source}`);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(realSource, destination);
    state.fullTreeCopyCount = (state.fullTreeCopyCount || 0) + 1;
  } finally {
    active.delete(realSource);
  }
}

async function createZip(sourceRoot, archivePath, entries = null, { onProgress } = {}) {
  const files = entries || await walkFiles(sourceRoot);
  const totalBytes = files.reduce((sum, file) => sum + (file.sizeBytes ?? file.data?.length ?? 0), 0);
  let processedBytes = 0;
  const report = createProgressReporter('zipMs', onProgress);
  const handle = await fsp.open(archivePath, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const file of files) {
      const name = Buffer.from(file.relative, 'utf8');
      const input = file.data || await fsp.readFile(file.absolute);
      const compressed = deflateRawSync(input, { level: 9 });
      const method = compressed.length < input.length ? 8 : 0;
      const body = method === 8 ? compressed : input;
      const checksum = crc32(input);
      const local = Buffer.concat([
        putUInt32(0x04034b50), putUInt16(20), putUInt16(0x0800), putUInt16(method),
        putUInt16(0), putUInt16(0), putUInt32(checksum), putUInt32(body.length),
        putUInt32(input.length), putUInt16(name.length), putUInt16(0), name, body,
      ]);
      await handle.write(local);
      central.push(Buffer.concat([
        putUInt32(0x02014b50), putUInt16(20), putUInt16(20), putUInt16(0x0800), putUInt16(method),
        putUInt16(0), putUInt16(0), putUInt32(checksum), putUInt32(body.length), putUInt32(input.length),
        putUInt16(name.length), putUInt16(0), putUInt16(0), putUInt16(0), putUInt16(0), putUInt32(0),
        putUInt32(offset), name,
      ]));
      offset += local.length;
      processedBytes += input.length;
      report({ processedFiles: central.length, totalFiles: files.length, processedBytes, totalBytes });
    }
    const centralOffset = offset;
    const centralBody = Buffer.concat(central);
    await handle.write(centralBody);
    await handle.write(Buffer.concat([
      putUInt32(0x06054b50), putUInt16(0), putUInt16(0), putUInt16(files.length), putUInt16(files.length),
      putUInt32(centralBody.length), putUInt32(centralOffset), putUInt16(0),
    ]));
    report({ processedFiles: files.length, totalFiles: files.length, processedBytes, totalBytes, force: true });
  } finally {
    await handle.close();
  }
  return { fileCount: files.length };
}

async function fileIdentity(filePath) {
  const hash = createHash('sha256');
  const stat = await fsp.stat(filePath);
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return { sizeBytes: stat.size, sha256: hash.digest('hex') };
}

async function readPackage(rootPath) {
  const direct = path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const root = path.join(rootPath, 'package.json');
  for (const candidate of [direct, root]) {
    try {
      const value = JSON.parse(await fsp.readFile(candidate, 'utf8'));
      if (value && value.name === PACKAGE_NAME) return value;
    } catch (_) { /* try the next supported source layout */ }
  }
  throw new Error(`Factory output does not contain ${PACKAGE_NAME}/package.json`);
}

async function normalizeRuntimeLayout(rootPath, packageJson, state) {
  const nested = path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  try {
    await fsp.access(nested);
    return 'node_modules/@deepseek-ai/dsh/lib/bin.js';
  } catch (_) { /* Route B deploy output can expose the package at its root. */ }
  const packageRoot = path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh');
  await fsp.mkdir(packageRoot, { recursive: true });
  await fsp.copyFile(path.join(rootPath, 'package.json'), path.join(packageRoot, 'package.json'));
  await copyTree(path.join(rootPath, 'lib'), path.join(packageRoot, 'lib'), new Set(), state);
  try {
    await copyTree(path.join(rootPath, 'config'), path.join(packageRoot, 'config'), new Set(), state);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  return 'node_modules/@deepseek-ai/dsh/lib/bin.js';
}

async function addFrontendDist({ rootPath, frontendDistRoot, frontendPackageJsonPath, version, state }) {
  if (!frontendDistRoot) return;
  const packageRoot = path.join(rootPath, 'node_modules', '@deepseek-ai', 'dsh-web-frontend');
  await fsp.mkdir(packageRoot, { recursive: true });
  await copyTree(frontendDistRoot, path.join(packageRoot, 'dist'), new Set(), state);
  if (frontendPackageJsonPath) await fsp.copyFile(frontendPackageJsonPath, path.join(packageRoot, 'package.json'));
  else await fsp.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh-web-frontend', version, type: 'module', exports: { './dist/*': './dist/*' } }, null, 2)}\n`, 'utf8');
}

async function assertNoLinks(rootPath) {
  const entries = await fsp.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const current = path.join(rootPath, entry.name);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Factory artifact contains a link: ${path.relative(rootPath, current)}`);
    if (stat.isDirectory()) await assertNoLinks(current);
  }
}

async function runNativeSmoke(rootPath) {
  const nodePtyRoot = path.join(rootPath, 'node_modules', 'node-pty');
  return new Promise((resolve, reject) => {
    const script = `const nodePty = require(process.argv[1]); const child = nodePty.spawn(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/c', 'exit', '0'] : ['-c', 'exit 0'], { name: 'xterm', cols: 80, rows: 24, cwd: process.argv[2], env: process.env }); child.onExit(({ exitCode }) => process.exit(exitCode === 0 ? 0 : 1));`;
    let child;
    try {
      child = spawn(process.execPath, ['-e', script, nodePtyRoot, rootPath], { cwd: rootPath, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += Buffer.from(chunk).toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* timeout is authoritative */ }
      reject(new Error('Factory native smoke timed out'));
    }, 30000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Factory native smoke could not start: ${error.message}`));
    });
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) resolve({ ok: true });
      else reject(new Error(`Factory native smoke exited with code ${exitCode}: ${stderr.slice(-1000)}`));
    });
  });
}

async function runWebSmoke({ rootPath, manifest }) {
  const cliPath = path.join(rootPath, manifest.cliEntry);
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-web-smoke-'));
  const child = spawn(process.execPath, [cliPath, 'web'], {
    cwd: rootPath,
    env: { ...process.env, DSH_HOME: home },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let url = null;
  const capture = (chunk) => {
    output += Buffer.from(chunk).toString('utf8');
    const match = output.match(/https?:\/\/127\.0\.0\.1:\d+\/?/);
    if (match) url = match[0];
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  try {
    const started = Date.now();
    while (!url && Date.now() - started < 30000) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!url) throw new Error(`Factory Web smoke did not expose a URL: ${output.slice(-2000)}`);
    const health = await waitUntilReady(url, { timeout: 30000, interval: 500 });
    if (!health.ok) throw new Error('Factory Web smoke health check failed');
    return { ok: true, url };
  } finally {
    if (child.pid != null) {
      try { child.kill(); } catch (_) { /* process may have already exited */ }
    }
    await fsp.rm(home, { recursive: true, force: true });
  }
}

async function defaultSmoke({ rootPath, manifest }) {
  const web = await runWebSmoke({ rootPath, manifest });
  const native = await runNativeSmoke(rootPath);
  return { ok: true, web, native };
}

async function createDirectArchiveEntries({ sourceRuntimeRoot, frontendDistRoot, frontendPackageJsonPath, version, manifest, onProgress }) {
  const sourceFiles = await scanRuntimeFiles(sourceRuntimeRoot, { onProgress });
  const entryMap = new Map(sourceFiles.filter((file) => file.relative !== 'runtime-manifest.json').map((file) => [file.relative, file]));
  const byRelative = new Map(sourceFiles.map((file) => [file.relative, file]));
  const nestedPackagePrefix = 'node_modules/@deepseek-ai/dsh/';
  const hasNestedPackage = byRelative.has(`${nestedPackagePrefix}package.json`);

  // Route B deploys expose @deepseek-ai/dsh at the runtime root. Preserve the
  // existing artifact contract by adding the canonical nested package layout
  // as virtual ZIP entries, without copying the complete dependency tree.
  if (!hasNestedPackage) {
    const virtualMappings = [
      ['package.json', `${nestedPackagePrefix}package.json`],
      ...sourceFiles.filter((file) => file.relative.startsWith('lib/')).map((file) => [file.relative, `${nestedPackagePrefix}${file.relative}`]),
      ...sourceFiles.filter((file) => file.relative.startsWith('config/')).map((file) => [file.relative, `${nestedPackagePrefix}${file.relative}`]),
    ];
    for (const [sourceRelative, archiveRelative] of virtualMappings) {
      const source = byRelative.get(sourceRelative);
      if (source) entryMap.set(archiveRelative, { ...source, relative: archiveRelative });
    }
  }

  if (frontendDistRoot) {
    const frontendFiles = await scanRuntimeFiles(frontendDistRoot, { onProgress });
    const prefix = 'node_modules/@deepseek-ai/dsh-web-frontend/dist/';
    for (const file of frontendFiles) entryMap.set(`${prefix}${file.relative}`, { ...file, relative: `${prefix}${file.relative}` });
    const packageData = frontendPackageJsonPath
      ? await fsp.readFile(frontendPackageJsonPath)
      : Buffer.from(`${JSON.stringify({ name: '@deepseek-ai/dsh-web-frontend', version, type: 'module', exports: { './dist/*': './dist/*' } }, null, 2)}\n`, 'utf8');
    entryMap.set('node_modules/@deepseek-ai/dsh-web-frontend/package.json', { data: packageData, relative: 'node_modules/@deepseek-ai/dsh-web-frontend/package.json' });
  }
  entryMap.set('runtime-manifest.json', { data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'), relative: 'runtime-manifest.json' });
  const entries = [...entryMap.values()];
  entries.sort((left, right) => left.relative.localeCompare(right.relative));
  const totalBytes = entries.reduce((sum, file) => sum + (file.sizeBytes ?? file.data?.length ?? 0), 0);
  if (typeof onProgress === 'function') onProgress({ phase: 'preScanMs', processedFiles: entries.length, totalFiles: entries.length, processedBytes: totalBytes, totalBytes, throughputFilesPerSec: 0, throughputMBps: 0, etaMs: 0 });
  return { entries, hasNestedPackage };
}

async function buildVerifiedRuntimeArtifact({
  sourceRuntimeRoot,
  outputDirectory,
  version,
  artifactUrl,
  frontendDistRoot,
  frontendPackageJsonPath,
  platform = DEFAULT_PLATFORM,
  arch = DEFAULT_ARCH,
  sourceRevision = null,
  nodeVersion = process.versions.node,
  pnpmVersion = null,
  verifyRuntimeImpl = verifyRuntime,
  nodeCommand = process.execPath,
  runCommand,
  smokeImpl = defaultSmoke,
  archiveMode = 'direct',
  onProgress,
} = {}) {
  if (!sourceRuntimeRoot || !outputDirectory || !version || !artifactUrl) throw new TypeError('sourceRuntimeRoot, outputDirectory, version, and artifactUrl are required');
  sourceRuntimeRoot = path.resolve(sourceRuntimeRoot);
  outputDirectory = path.resolve(outputDirectory);
  if (frontendDistRoot) frontendDistRoot = path.resolve(frontendDistRoot);
  if (frontendPackageJsonPath) frontendPackageJsonPath = path.resolve(frontendPackageJsonPath);
  const packageJson = await readPackage(sourceRuntimeRoot);
  if (packageJson.version !== version) throw new Error(`Factory package version mismatch: expected ${version}, received ${packageJson.version}`);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-factory-'));
  const artifactRoot = path.join(tempRoot, 'runtime');
  const archivePath = path.join(outputDirectory, `dsh-runtime-${version}-${platform}-${arch}.zip`);
  const timings = {};
  const diskSnapshots = [];
  const reportProgress = typeof onProgress === 'function' ? onProgress : () => {};
  const recordDisk = (phase, point, targetPath) => {
    const freeBytes = readFreeDiskBytes(targetPath);
    const snapshot = { phase, point, freeBytes };
    diskSnapshots.push(snapshot);
    console.error(`[FACTORY_DISK] phase=${phase} point=${point} freeBytes=${freeBytes ?? '?'}`);
    return snapshot;
  };
  try {
    const manifest = {
      schemaVersion: 1,
      packageName: PACKAGE_NAME,
      version,
      platform,
      arch,
      cliEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
      sourceRevision,
      nodeVersion,
      pnpmVersion,
      immutable: true,
    };
    validateManifest(manifest, { packageName: PACKAGE_NAME, version, platform, arch });

    let zipEntries = null;
    let verificationRoot = artifactRoot;
    let smokeRoot = artifactRoot;
    let smokeManifest = manifest;
    const materializationState = { materialized: new Map(), hardLinksEnabled: true, fullTreeCopyCount: 0 };
    if (archiveMode === 'direct') {
      const directPlan = await measurePhase('preScanMs', timings, () => createDirectArchiveEntries({
        sourceRuntimeRoot,
        frontendDistRoot,
        frontendPackageJsonPath,
        version,
        manifest,
        onProgress: reportProgress,
      }));
      zipEntries = directPlan.entries;
      timings.materializationMs = 0;
      console.error('[FACTORY_PHASE] phase=materializationMs elapsedMs=0 mode=direct skipped=complete-tree-copy');
      verificationRoot = sourceRuntimeRoot;
      smokeRoot = sourceRuntimeRoot;
      smokeManifest = directPlan.hasNestedPackage ? manifest : { ...manifest, cliEntry: 'lib/bin.js' };

      // A Route B deploy has the package at its root. Its canonical nested
      // layout is virtualized in the ZIP, so authoritative verification runs
      // after extraction; Web/native smoke still runs against the verified
      // source tree before archiving.
      if (directPlan.hasNestedPackage) {
        const verification = await verifyRuntimeImpl({ rootPath: verificationRoot, expectedVersion: version, nodeCommand, ...(runCommand ? { runCommand } : {}) });
        if (!verification || !verification.ok) throw new Error(`Factory CLI verification failed: ${verification && verification.reason || 'unknown'}`);
      }
    } else if (archiveMode === 'materialized') {
      await measurePhase('preScanMs', timings, () => scanRuntimeFiles(sourceRuntimeRoot));
      await measurePhase('materializationMs', timings, async () => {
        await copyTree(sourceRuntimeRoot, artifactRoot, new Set(), materializationState);
        const cliEntry = await normalizeRuntimeLayout(artifactRoot, packageJson, materializationState);
        manifest.cliEntry = cliEntry;
        await addFrontendDist({ rootPath: artifactRoot, frontendDistRoot, frontendPackageJsonPath, version, state: materializationState });
        await fsp.writeFile(path.join(artifactRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        await assertNoLinks(artifactRoot);
      });
    } else {
      throw new Error(`Unsupported Factory archive mode: ${archiveMode}`);
    }

    const smoke = await smokeImpl({ rootPath: smokeRoot, manifest: smokeManifest });
    if (!smoke || smoke.ok === false || smoke.web === 'failed' || smoke.native === 'failed') throw new Error('Factory runtime smoke failed');
    await fsp.mkdir(outputDirectory, { recursive: true });
    if (archiveMode === 'direct') {
      // The source tree has already passed link/junction safety scanning. The
      // archive contains only regular file bytes and therefore cannot carry
      // source links into the extracted artifact.
      recordDisk('zipMs', 'before', archivePath);
      await measurePhase('zipMs', timings, () => createZip(sourceRuntimeRoot, archivePath, zipEntries, { onProgress: reportProgress }));
      recordDisk('zipMs', 'after', archivePath);
    } else {
      await measurePhase('zipMs', timings, () => createZip(artifactRoot, archivePath));
    }
    const zipInfo = { fileCount: zipEntries ? zipEntries.length : (await walkFiles(artifactRoot)).length };
    const identity = await measurePhase('sha256Ms', timings, () => fileIdentity(archivePath));
    const extractedRoot = path.join(tempRoot, 'archive-self-smoke');
    const { extractZip } = require('../src/update/runtime-artifact-downloader');
    recordDisk('independentExtractionMs', 'before', extractedRoot);
    await measurePhase('independentExtractionMs', timings, () => extractZip({
      archivePath,
      extractionRoot: extractedRoot,
      onProgress: (event) => reportProgress({ phase: 'independentExtractionMs', ...event }),
    }));
    recordDisk('independentExtractionMs', 'after', extractedRoot);
    await measurePhase('independentVerificationMs', timings, async () => {
      const extractedVerification = await verifyRuntimeImpl({ rootPath: extractedRoot, expectedVersion: version, nodeCommand, ...(runCommand ? { runCommand } : {}) });
      if (!extractedVerification || !extractedVerification.ok) throw new Error(`Factory archive self-smoke failed: ${extractedVerification && extractedVerification.reason || 'unknown'}`);
      const extractedSmoke = await smokeImpl({ rootPath: extractedRoot, manifest });
      if (!extractedSmoke || extractedSmoke.ok === false || extractedSmoke.web === 'failed' || extractedSmoke.native === 'failed') throw new Error('Factory archive Web/native self-smoke failed');
    });
    const indexEntry = {
      packageName: PACKAGE_NAME, version, platform, arch, artifactUrl,
      sizeBytes: identity.sizeBytes, sha256: identity.sha256,
      manifest: { schemaVersion: 1, packageName: PACKAGE_NAME, version, platform, arch, cliEntry: manifest.cliEntry },
    };
    await fsp.writeFile(path.join(outputDirectory, 'runtime-index.json'), `${JSON.stringify({ schemaVersion: 1, artifacts: [indexEntry] }, null, 2)}\n`, 'utf8');
    return { archivePath, indexEntry, fileCount: zipInfo.fileCount, rootPath: archiveMode === 'direct' ? sourceRuntimeRoot : artifactRoot, archiveMode, timings, fullTreeCopyCount: materializationState.fullTreeCopyCount, diskSnapshots };
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    result[argument.slice(2).replaceAll('-', '')] = argv[index + 1];
    index += 1;
  }
  return result;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  buildVerifiedRuntimeArtifact({
    sourceRuntimeRoot: args.sourceruntime,
    outputDirectory: args.output,
    version: args.version,
    artifactUrl: args.artifacturl,
    platform: args.platform,
    arch: args.arch,
    sourceRevision: args.sourcerevision,
    pnpmVersion: args.pnpmversion,
    frontendDistRoot: args.frontenddist,
    frontendPackageJsonPath: args.frontendpackagejson,
    archiveMode: args.archivemode || 'direct',
  }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildVerifiedRuntimeArtifact,
  copyTree,
  createZip,
  defaultSmoke,
  addFrontendDist,
  fileIdentity,
  normalizeRuntimeLayout,
  scanRuntimeFiles,
  parseArgs,
};
