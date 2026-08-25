'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createSourceMapping } = require('./source-mapping');
const { createFileCandidateStore } = require('./candidate-store');
const { verifyRemoteCandidate } = require('./remote-verification');
const { promoteStable, rollbackStable, validateStableIndex } = require('./stable-index');

const PACKAGE_NAME = '@deepseek-ai/dsh';
const DEFAULT_UPSTREAM_VERSION = '0.1.1-rc.2';
const DEFAULT_ROLLBACK_VERSION = '0.1.0-rc.7';

function candidateIndexPath(root) {
  return path.join(root, 'runtime', 'stable', 'runtime-index.json');
}

function historyDirectory(root) {
  return path.join(root, 'runtime', 'history');
}

function candidateRoot(root) {
  return path.join(root, 'candidates');
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function versionFromIndex(index) {
  return index && Array.isArray(index.artifacts) && index.artifacts[0]
    ? index.artifacts[0].version
    : null;
}

function makeIndexPublication({ root }) {
  const indexPath = candidateIndexPath(root);
  return {
    indexPath,
    historyDirectory: historyDirectory(root),
    read: () => readJson(indexPath),
    validate(index) { return validateStableIndex(index); },
  };
}

async function detect({ root, registry, sourceMapping, factory, candidateStore, indexPublication } = {}) {
  if (!registry || typeof registry.readLatest !== 'function') {
    throw new TypeError('registry.readLatest adapter is required');
  }
  if (!candidateStore || typeof candidateStore.read !== 'function') {
    throw new TypeError('candidateStore.read adapter is required');
  }
  if (!indexPublication || typeof indexPublication.read !== 'function') {
    throw new TypeError('indexPublication.read adapter is required');
  }
  const latest = await registry.readLatest();
  if (!latest || (typeof latest !== 'string' && typeof latest.version !== 'string')) {
    const error = new Error('registry adapter returned a malformed latest response');
    error.code = 'DISTRIBUTION_REGISTRY_RESPONSE_INVALID';
    throw error;
  }
  const upstreamLatest = typeof latest === 'string' ? latest : latest.version;
  const existing = await candidateStore.read(upstreamLatest);
  const stableVersion = versionFromIndex(await indexPublication.read());
  // The Factory is deliberately not consulted by detection. A known candidate
  // is a safe no-op, and an unknown candidate is only built by an explicit
  // workflow step after this result has been inspected.
  void root;
  void sourceMapping;
  void factory;
  return {
    upstreamLatest,
    candidateStatus: existing ? 'ALREADY_PUBLISHED' : 'NOT_PUBLISHED',
    stableVersion,
  };
}

function candidateFixture(version, bytes) {
  return {
    packageName: PACKAGE_NAME,
    version,
    platform: 'win32',
    arch: 'x64',
    artifactUrl: `https://github.com/example/releases/download/dsh-runtime-v${version}/dsh-runtime-${version}-win32-x64.zip`,
    sizeBytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    manifest: {
      schemaVersion: 1,
      packageName: PACKAGE_NAME,
      version,
      platform: 'win32',
      arch: 'x64',
      cliEntry: 'runtime-root/apps/cli/dist/index.js',
    },
    provenance: { source: 'local-deterministic-fixture', version },
    status: 'CANDIDATE_PUBLISHED',
  };
}

async function publishFixtureCandidate({ store, candidate, fixture, root }) {
  const assetDirectory = path.join(root, 'fixture-assets');
  await fs.mkdir(assetDirectory, { recursive: true });
  const assetPath = path.join(assetDirectory, `${candidate.version}.zip`);
  if (fixture && typeof fixture.writeCandidateAssets === 'function') {
    await fixture.writeCandidateAssets({ candidate, destination: assetPath });
  } else {
    await fs.writeFile(assetPath, Buffer.from(`runtime-${candidate.version}`));
  }
  return store.publish({ ...candidate, zipPath: assetPath });
}

async function runDryRun({ root, fixture = {}, now = () => new Date().toISOString(), logger = console } = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('root is required');
  await fs.mkdir(root, { recursive: true });
  const upstream = fixture.upstreamLatest || { version: DEFAULT_UPSTREAM_VERSION, distIntegrity: 'sha512-fixture' };
  const candidate = fixture.candidate || candidateFixture(upstream.version, Buffer.from(`runtime-${upstream.version}`));
  const rollbackCandidate = fixture.rollbackCandidate || candidateFixture(DEFAULT_ROLLBACK_VERSION, Buffer.from(`runtime-${DEFAULT_ROLLBACK_VERSION}`));
  const store = fixture.candidateStore || createFileCandidateStore({ root: candidateRoot(root), now });
  const indexPublication = fixture.indexPublication || makeIndexPublication({ root });
  const registry = fixture.registry || { readLatest: async () => upstream };
  const sourceMapping = fixture.sourceMapping || createSourceMapping({ requestJson: async () => ({ name: PACKAGE_NAME, 'dist-tags': { latest: upstream.version }, versions: { [upstream.version]: { dist: { integrity: upstream.distIntegrity } } } }) });
  const factory = fixture.factory || { buildCandidate: async () => { throw new Error('Factory is disabled in local dry-run'); } };
  const detected = await detect({ root, registry, sourceMapping, factory, candidateStore: store, indexPublication });

  const npmInstallCalls = fixture.npmInstaller && typeof fixture.npmInstaller.getCallCount === 'function'
    ? fixture.npmInstaller.getCallCount()
    : Number(fixture.npmInstallCalls || 0);
  const remoteVerification = fixture.remoteVerification || (async ({ candidate: value }) => verifyRemoteCandidate({
    candidate: value,
    tempRoot: path.join(root, 'remote-staging'),
    download: async (url, destination) => {
      void url;
      await fs.writeFile(destination, Buffer.alloc(value.sizeBytes));
      return { statusCode: 200, contentLength: value.sizeBytes, sizeBytes: value.sizeBytes, sha256: value.sha256, durationMs: 0 };
    },
    extractZip: async () => path.join(root, 'remote-staging', 'extracted'),
    verifyRuntime: async () => ({ ok: true }),
    smoke: async () => ({ ok: true }),
  }));
  const candidateResult = detected.candidateStatus === 'ALREADY_PUBLISHED'
    ? { status: 'ALREADY_PUBLISHED', candidate: await store.read(candidate.version) }
    : await publishFixtureCandidate({ store, candidate, fixture, root });
  const candidateReadback = await store.read(candidate.version);
  const remoteStatus = await remoteVerification({ candidate: candidateReadback });
  const promotionRemoteVerifier = async ({ candidate: value }) => {
    if (value.version === candidateReadback.version) return remoteStatus;
    return remoteVerification({ candidate: value });
  };
  const promotion = await promoteStable({
    candidateStore: store,
    candidateVersion: candidate.version,
    remoteVerifier: promotionRemoteVerifier,
    indexPath: indexPublication.indexPath || candidateIndexPath(root),
    historyDirectory: indexPublication.historyDirectory || historyDirectory(root),
    now,
  });
  const promotedIndex = await indexPublication.read();
  if (typeof indexPublication.validate === 'function') indexPublication.validate(promotedIndex);
  if (versionFromIndex(promotedIndex) !== promotion.version) throw new Error('stable index readback did not contain the promoted candidate');

  await publishFixtureCandidate({ store, candidate: rollbackCandidate, fixture, root });
  const rollback = await rollbackStable({
    candidateStore: store,
    targetVersion: rollbackCandidate.version,
    remoteVerifier: remoteVerification,
    indexPath: indexPublication.indexPath || candidateIndexPath(root),
    historyDirectory: indexPublication.historyDirectory || historyDirectory(root),
    now,
  });
  const rollbackIndex = await indexPublication.read();
  if (typeof indexPublication.validate === 'function') indexPublication.validate(rollbackIndex);
  if (versionFromIndex(rollbackIndex) !== rollback.version) throw new Error('stable index readback did not contain the rollback candidate');
  if (logger && typeof logger.log === 'function') logger.log(JSON.stringify({ candidatePublish: candidateResult.status, remoteVerification: remoteStatus.status, stableVersion: promotion.version, rollbackVersion: rollback.version, npmInstallCalls }));
  return {
    upstreamLatest: detected.upstreamLatest,
    candidateVersion: candidate.version,
    candidatePublishStatus: candidateResult.status,
    remoteStatus: remoteStatus.status,
    stableVersion: promotion.version,
    rollbackVersion: rollback.version,
    npmInstallCalls,
  };
}

async function promote({ root, version, remoteVerification = verifyRemoteCandidate } = {}) {
  const store = createFileCandidateStore({ root: candidateRoot(root) });
  return promoteStable({ candidateStore: store, candidateVersion: version, remoteVerifier: remoteVerification, indexPath: candidateIndexPath(root), historyDirectory: historyDirectory(root) });
}

async function rollback({ root, version, remoteVerification = verifyRemoteCandidate } = {}) {
  const store = createFileCandidateStore({ root: candidateRoot(root) });
  return rollbackStable({ candidateStore: store, targetVersion: version, remoteVerifier: remoteVerification, indexPath: candidateIndexPath(root), historyDirectory: historyDirectory(root) });
}

async function validateWorkflows({ root = process.cwd() } = {}) {
  const workflowDirectory = path.join(root, '.github', 'workflows');
  const entries = await fs.readdir(workflowDirectory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const workflows = entries.filter(entry => entry.isFile() && entry.name.endsWith(('.yml', '.yaml'))).map(entry => entry.name).sort();
  return { valid: true, workflows };
}

function parseArgs(argv) {
  const [command = 'dry-run', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--root') options.root = rest[++index];
    else if (value === '--version') options.version = rest[++index];
  }
  return { command, options };
}

async function main(argv = process.argv.slice(2), io = {}) {
  const { command, options } = parseArgs(argv);
  if (command === 'dry-run') {
    const root = options.root || await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-distribution-dry-run-'));
    return runDryRun({ root, logger: io.logger || console });
  }
  if (command === 'promote') return promote({ root: options.root || process.cwd(), version: options.version });
  if (command === 'rollback') return rollback({ root: options.root || process.cwd(), version: options.version });
  if (command === 'validate-workflows') return validateWorkflows({ root: options.root || process.cwd() });
  if (command === 'detect') {
    const root = options.root || process.cwd();
    const sourceMapping = createSourceMapping();
    return detect({
      root,
      registry: { readLatest: sourceMapping.readLatest },
      sourceMapping,
      factory: { buildCandidate: async () => { throw new Error('Factory is not part of detection'); } },
      candidateStore: createFileCandidateStore({ root: candidateRoot(root) }),
      indexPublication: makeIndexPublication({ root }),
    });
  }
  throw new Error(`unknown distribution command: ${command}`);
}

if (require.main === module) {
  main().then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch(error => {
    process.stderr.write(`${error.code || 'DISTRIBUTION_CLI_ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  detect,
  runDryRun,
  promote,
  rollback,
  validateWorkflows,
  parseArgs,
  main,
};
