'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateWorkflows } = require('../scripts/runtime-distribution/runtime-distribution-cli');
const { createFileCandidateStore } = require('../scripts/runtime-distribution/candidate-store');
const { buildStableIndex, promoteStable, rollbackStable } = require('../scripts/runtime-distribution/stable-index');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'dsh-runtime-factory.yml');
const PROMOTION_WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'dsh-runtime-promote.yml');

function workflowText() {
  return fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
}

function promotionWorkflowText() {
  return fs.readFileSync(PROMOTION_WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
}

test('Windows runtime factory workflow has the required triggers and immutable toolchain', () => {
  const text = workflowText();
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /version:\s*\n\s*description:.*\n\s*required:\s*false/);
  assert.match(text, /schedule:\s*\n\s*-\s*cron:\s*['"]0 \*\/6 \* \* \*['"]/);
  assert.match(text, /runs-on:\s*windows-latest/);
  assert.doesNotMatch(text, /runs-on:\s*(?:ubuntu|macos)/i);
  assert.match(text, /NODE_VERSION:\s*['"]?24\.18\.0['"]?/);
  assert.match(text, /PNPM_VERSION:\s*['"]?11\.7\.0['"]?/);
  assert.match(text, /RUNTIME_PLATFORM:\s*['"]?win32['"]?/);
  assert.match(text, /RUNTIME_ARCH:\s*['"]?x64['"]?/);
  assert.doesNotMatch(text, /(?:NODE_VERSION|PNPM_VERSION|node-version|version:).*latest/i);
  assert.match(text, /permissions:\s*[\s\S]*contents:\s*write/);
  assert.match(text, /actions\/checkout@[^\s]+/);
  assert.match(text, /actions\/setup-node@[^\s]+[\s\S]*node-version:\s*\$\{\{\s*env\.NODE_VERSION\s*\}\}/);
  assert.match(text, /pnpm\/action-setup@[^\s]+[\s\S]*version:\s*\$\{\{\s*env\.PNPM_VERSION\s*\}\}/);
});

test('Windows runtime factory resolves latest before checkout and uses the exact upstream tag', () => {
  const text = workflowText();
  const checkout = text.indexOf('actions/checkout@');
  const latest = text.indexOf('npm view @deepseek-ai/dsh dist-tags.latest');
  const setupNode = text.indexOf('uses: actions/setup-node@');
  assert.ok(latest >= 0, 'workflow must use npm dist-tags.latest for automatic resolution');
  assert.ok(setupNode >= 0 && setupNode < latest, 'setup-node must precede npm latest resolution');
  assert.ok(latest < checkout, 'latest detection must precede checkout');
  assert.match(text, /deepseek-ai\/deepseek-harness/);
  assert.match(text, /ref:\s*dsh-v\$\{\{\s*env\.RUNTIME_VERSION\s*\}\}/);
  assert.doesNotMatch(text, /ref:\s*(?:master|main|branch|latest)/i);
  assert.match(text, /corepack prepare pnpm@11\.7\.0 --activate/);
  assert.match(text, /pnpm install --frozen-lockfile/);
  assert.match(text, /pnpm run build/);
  assert.match(text, /upstream\/apps\/cli/);
  assert.match(text, /upstream\/apps\/web\/dist/);
  assert.match(text, /upstream\/apps\/web\/package\.json/);
  assert.match(text, /package\.json.*version|version.*package\.json/s);
});

test('Windows runtime factory invokes existing factory and CLI paths with immutable candidate publication', () => {
  const text = workflowText();
  assert.match(text, /scripts\/build-verified-runtime-artifact\.js/);
  assert.match(text, /scripts\/runtime-distribution\/runtime-distribution-cli\.js/);
  assert.match(text, /https:\/\/github\.com\/\$\{\{\s*github\.repository\s*\}\}\/releases\/download\/dsh-runtime-v\$env:RUNTIME_VERSION\/dsh-runtime-\$env:RUNTIME_VERSION-win32-x64\.zip/);
  assert.match(text, /dsh-runtime-\$env:RUNTIME_VERSION-win32-x64\.zip/);
  assert.match(text, /releases\/download\/dsh-runtime-v/);
  assert.match(text, /gh release (?:create|upload)/);
  assert.match(text, /candidate|CANDIDATE_PUBLISHED/i);
  assert.match(text, /remote.*verif|verif.*remote/i);
  assert.match(text, /sha256|hash/i);
  assert.match(text, /size/i);
  assert.match(text, /WAITING_FOR_PROMOTION/);
  assert.match(text, /CLI/);
  assert.match(text, /Web/);
  assert.match(text, /Health/);
  assert.match(text, /Native/);
  assert.match(text, /actions\/upload-artifact@/);
});

test('candidate Release publication is serialized, explicit, idempotent, and conflict-safe', () => {
  const text = workflowText();
  const concurrencyGroup = text.match(/concurrency:\s*\n\s*group:\s*([^\n]+)/s);
  assert.ok(concurrencyGroup, 'workflow must declare a concurrency group');
  assert.match(concurrencyGroup[1], /dsh-runtime-factory.*github\.repository/);
  assert.doesNotMatch(concurrencyGroup[1], /inputs\.version|latest/);
  assert.match(text, /cancel-in-progress:\s*false/);
  assert.match(text, /gh api .*releases\/tags/);
  assert.match(text, /releaseJson.*(?:LASTEXITCODE|releaseExists)|release.*(?:absent|not found)/is);
  assert.match(text, /gh release create/);
  assert.match(text, /gh release upload/);
  assert.match(text, /missing.*asset|asset.*missing/i);
  assert.match(text, /conflict|mismatch/i);
  assert.match(text, /draft.*false|prerelease.*true|prerelease.*false/i);
  assert.match(text, /schemaVersion.*1/);
  assert.match(text, /win32.*x64|x64.*win32/s);
  assert.match(text, /https?:.*artifactUrl|artifactUrl.*https?/s);
  assert.match(text, /Get-FileHash/);
  assert.match(text, /contentLength|sizeBytes|Length/);
  assert.match(text, /SOURCE_TAG|SOURCE_COMMIT|sourceRevision/);
  assert.doesNotMatch(text, /gh release upload[^\n]*--clobber/);
  assert.match(text, /(?:after create|after upload|verify).*assets|assets.*(?:after create|after upload|verify)/is);
  assert.doesNotMatch(text, /gh release create[^\n]*(?:\.zip|runtime-index\.json)/i);
});

test('existing-candidate preflight resolves and compares the exact peeled upstream tag commit', () => {
  const text = workflowText();
  const tagResolution = text.indexOf('git ls-remote');
  const releaseRead = text.indexOf('releases/tags/');
  assert.ok(tagResolution >= 0, 'workflow must resolve the upstream tag commit read-only');
  assert.ok(tagResolution < releaseRead, 'exact source commit must resolve before Release preflight');
  assert.match(text, /refs\/tags\/dsh-v/);
  assert.match(text, /\^\{\}/);
  assert.match(text, /EXPECTED_SOURCE_COMMIT/);
  assert.match(text, /(?:peeled|peel|\^\{\}).*(?:direct|fallback)|(?:direct|fallback).*(?:peeled|peel|\^\{\})/is);
  assert.match(text, /if \(.*(?:EXPECTED_SOURCE_COMMIT|sourceCommit).*(?:-notmatch|empty|missing)|throw.*(?:tag|commit).*(?:absent|available|missing)/is);
  assert.match(text, /SOURCE_COMMIT.*EXPECTED_SOURCE_COMMIT|EXPECTED_SOURCE_COMMIT.*SOURCE_COMMIT/s);
  assert.match(text, /(?:sourceCommit|SOURCE_COMMIT).*-(?:ne|eq).*EXPECTED_SOURCE_COMMIT|EXPECTED_SOURCE_COMMIT.*(?:-ne|-eq).*sourceCommit/s);
  assert.match(text, /git -C upstream rev-parse HEAD/);
  assert.doesNotMatch(text, /refs\/heads\/(?:master|main)|ref:\s*(?:master|main)/i);
});

test('factory summary derives phase status and gates promotion readiness on complete success', () => {
  const text = workflowText();
  assert.match(text, /id:\s*(?:factory|publish|remote|verify)/);
  assert.match(text, /FACTORY_STATUS|factory.*status/i);
  assert.match(text, /PUBLISH_STATUS|publish.*status/i);
  assert.match(text, /REMOTE_VERIFY|remote.*status/i);
  assert.match(text, /CLI_STATUS|WEB_STATUS|HEALTH_STATUS|NATIVE_STATUS/i);
  assert.match(text, /failed phase|failed.*phase|CURRENT_PHASE/i);
  assert.match(text, /if \(.*(?:allSucceeded|completeSuccess|WAITING_FOR_PROMOTION).*\)/is);
  assert.match(text, /WAITING_FOR_PROMOTION/);
  assert.doesNotMatch(text, /- CLI: passed/);
  assert.doesNotMatch(text, /- Web: passed/);
  assert.doesNotMatch(text, /- Health: passed/);
  assert.doesNotMatch(text, /- Native: passed/);
  assert.match(text, /if \(.*(?:allSucceeded|completeSuccess).*\)[\s\S]*factory-metadata\.json/is);
  assert.match(text, /failure|FAILED|not ready/i);
});

test('existing candidate preflight validates both assets and identity before no-op', () => {
  const text = workflowText();
  assert.match(text, /(?:assetName|zipName)/);
  assert.match(text, /runtime-index\.json/);
  assert.match(text, /Invoke-WebRequest|browser_download_url/);
  assert.match(text, /ConvertFrom-Json/);
  assert.match(text, /packageName|schemaVersion/);
  assert.match(text, /artifactUrl/);
  assert.match(text, /source.*(?:tag|commit)|(?:tag|commit).*source/i);
  assert.match(text, /skip=true/);
  assert.match(text, /asset.*(?:hash|size)|(?:hash|size).*asset/i);
  assert.doesNotMatch(text, /asset\.Count -eq 1[\s\S]{0,250}skip=true/);
});

test('Windows runtime factory has no stable-index mutation or recursive workflow trigger', () => {
  const text = workflowText();
  assert.doesNotMatch(text, /runtime\/stable\/runtime-index\.json\s*(?:>|>>|Set-Content|Out-File)/i);
  assert.doesNotMatch(text, /^\s*(?:release|push|workflow_run):/m);
  assert.doesNotMatch(text, /stable-index.*(?:write|update)|(?:write|update).*stable-index/i);
  assert.doesNotMatch(text, /auto.?install|client.*install/i);
});

test('factory persists the remote verification marker only after complete remote readback and keeps failure summaries gated', () => {
  const text = workflowText();
  const remoteReadback = text.indexOf('Verify remote candidate metadata and ZIP readback');
  const markerStep = text.indexOf('Persist durable remote verification marker');
  const marker = text.indexOf('gh api --method PATCH', markerStep);
  assert.ok(remoteReadback >= 0, 'factory must have a remote readback phase');
  assert.ok(markerStep >= 0, 'factory must have a durable marker phase');
  assert.ok(marker > remoteReadback, 'durable verification marker must be written after remote readback');
  assert.match(text, /gh api[^\n]*(?:--method\s+PATCH|releases\/[^\n]*-X\s+PATCH)|gh release edit/i);
  assert.match(text, /MARKER_STATUS/);
  assert.match(text, /allSucceeded.*MARKER_STATUS|MARKER_STATUS.*allSucceeded/is);
  assert.match(text, /(?:Release marker|marker).*MARKER_STATUS|MARKER_STATUS.*(?:Release marker|marker)/is);
  assert.match(text, /verifiedRelease|markedRelease|marker.*body|body.*marker/i);
});

test('manual runtime promotion workflow has only the required dispatch inputs and permissions', () => {
  const text = promotionWorkflowText();
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /version:\s*\n\s*description:[^\n]*\n\s*required:\s*true/);
  assert.match(text, /operation:\s*\n\s*description:[^\n]*\n\s*required:\s*true[\s\S]*?type:\s*choice[\s\S]*?options:\s*\n\s*-\s*promote\s*\n\s*-\s*rollback/);
  assert.doesNotMatch(text, /^\s*(?:push|release|workflow_run|schedule):/m);
  assert.match(text, /permissions:\s*[\s\S]*contents:\s*read/);
  assert.match(text, /permissions:\s*[\s\S]*pages:\s*write/);
  assert.match(text, /permissions:\s*[\s\S]*id-token:\s*write/);
  assert.doesNotMatch(text, /contents:\s*write/);
});

test('manual runtime promotion reads the exact candidate Release and verifies shared artifacts remotely before stable-index generation', () => {
  const text = promotionWorkflowText();
  const candidateRead = text.indexOf('releases/tags/');
  const candidateDownload = text.indexOf('browser_download_url');
  const remoteVerify = text.search(/REMOTE_VERIFIED|remote-verification|verifyRemoteCandidate/i);
  const stableIndex = text.search(/Validate candidate and generate the stable index|stable-index\.js|runtime-distribution-cli\.js/);
  assert.ok(candidateRead >= 0, 'workflow must read the exact candidate Release');
  assert.ok(candidateDownload >= 0, 'workflow must download candidate Release assets');
  assert.ok(candidateRead < candidateDownload, 'Release metadata must be read before asset download');
  assert.ok(remoteVerify >= 0, 'workflow must perform remote re-download verification');
  assert.ok(stableIndex >= 0, 'workflow must use the shared stable-index path');
  assert.ok(remoteVerify < stableIndex, 'remote verification must precede stable-index generation');
  assert.match(text, /candidate-runtime-index\.json|candidate.*manifest|runtime-manifest\.json/i);
  assert.match(text, /factory-provenance\.json|provenance/i);
  assert.match(text, /Get-FileHash|sha256/i);
  assert.match(text, /win32/);
  assert.match(text, /x64/);
  assert.match(text, /artifactUrl/);
});

test('rollback requires the durable prior remote-verification marker before stable-index generation or Pages upload', () => {
  const text = promotionWorkflowText();
  const rollbackBranch = text.search(/RUNTIME_OPERATION[^\n]*rollback|operation[^\n]*rollback/i);
  const marker = text.indexOf('REMOTE_VERIFY=REMOTE_VERIFIED');
  const stable = text.indexOf('Validate candidate and generate the stable index');
  const upload = text.indexOf('actions/upload-pages-artifact@');
  assert.ok(rollbackBranch >= 0, 'workflow must branch on rollback operation');
  assert.ok(marker >= 0, 'workflow must check the durable verification marker');
  assert.ok(marker < stable, 'rollback marker gate must precede stable-index generation');
  assert.ok(marker < upload, 'rollback marker gate must precede Pages upload');
  assert.match(text, /rollback[^\n]*(?:REMOTE_VERIFY|REMOTE_VERIFIED)|(?:REMOTE_VERIFY|REMOTE_VERIFIED)[^\n]*rollback/i);
  assert.match(text, /body.*REMOTE_VERIFY|REMOTE_VERIFY.*body/i);
  assert.match(text, /throw[^\n]*(?:rollback|verified|marker)/i);
});

test('manual runtime promotion uses promotion and rollback without rebuilding, dependency installation, or contents write', () => {
  const text = promotionWorkflowText();
  assert.match(text, /operation.*promote|promote.*operation/is);
  assert.match(text, /operation.*rollback|rollback.*operation/is);
  assert.match(text, /rollbackStable|runtime-distribution-cli\.js\s+rollback|--operation\s+rollback|command.*rollback/i);
  assert.doesNotMatch(text, /build-verified-runtime-artifact|buildVerifiedRuntimeArtifact|(?:\bFactory\b.*(?:build|invoke)|(?:build|invoke).*\bFactory\b)/i);
  assert.doesNotMatch(text, /npm\s+(?:install|ci)|pnpm\s+install|dependency-resolution|auto.?install|client.*install/i);
  assert.doesNotMatch(text, /contents:\s*write/);
  assert.match(text, /remote-verified|REMOTE_VERIFIED|verified candidate/i);
});

test('manual runtime promotion builds and atomically publishes the complete Pages tree once', () => {
  const text = promotionWorkflowText();
  assert.match(text, /runtime[\\/]stable[\\/]runtime-index\.json/);
  assert.match(text, /runtime[\\/]history[\\/].*\.json|runtimeRoot.*history.*timestamp.*version/i);
  assert.match(text, /history.*stable|stable.*history/i);
  assert.match(text, /schemaVersion\s*[-=]?[>=]*\s*1|schemaVersion.*1/);
  assert.match(text, /artifacts/);
  assert.match(text, /runtime-index\.json\.tmp|atomic|Move-Item|rename/i);
  assert.match(text, /actions\/upload-pages-artifact@/);
  assert.match(text, /actions\/deploy-pages@/);
  assert.equal((text.match(/actions\/deploy-pages@/g) || []).length, 1, 'Pages must deploy exactly once');
  assert.equal((text.match(/actions\/upload-pages-artifact@/g) || []).length, 1, 'Pages artifact must upload exactly once');
});

test('invalid local promotion candidate leaves the prior stable index bytes unchanged', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-promotion-fixture-'));
  try {
    const candidateRoot = path.join(root, 'candidates');
    const indexPath = path.join(root, 'runtime', 'stable', 'runtime-index.json');
    const historyDirectory = path.join(root, 'runtime', 'history');
    const bytes = Buffer.from('valid-runtime-candidate');
    const candidate = {
      packageName: '@deepseek-ai/dsh',
      version: '0.1.1-rc.2',
      platform: 'win32',
      arch: 'x64',
      artifactUrl: 'https://github.com/example/releases/download/dsh-runtime-v0.1.1-rc.2/dsh-runtime-0.1.1-rc.2-win32-x64.zip',
      sizeBytes: bytes.length,
      sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
      manifest: {
        schemaVersion: 1,
        packageName: '@deepseek-ai/dsh',
        version: '0.1.1-rc.2',
        platform: 'win32',
        arch: 'x64',
        cliEntry: 'runtime-root/apps/cli/dist/index.js',
      },
      provenance: { sourceTag: 'dsh-v0.1.1-rc.2', sourceCommit: 'a'.repeat(40) },
      status: 'CANDIDATE_PUBLISHED',
    };
    const zipPath = path.join(root, 'candidate.zip');
    await fsp.writeFile(zipPath, bytes);
    const store = createFileCandidateStore({ root: candidateRoot });
    await store.publish({ ...candidate, zipPath });
    const previousVersion = '0.1.0-rc.7';
    const previous = buildStableIndex({ candidate: {
      ...candidate,
      version: previousVersion,
      artifactUrl: `https://github.com/example/releases/download/dsh-runtime-v${previousVersion}/dsh-runtime-${previousVersion}-win32-x64.zip`,
      manifest: { ...candidate.manifest, version: previousVersion },
    } });
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    await fsp.writeFile(indexPath, `${JSON.stringify(previous, null, 2)}\n`, 'utf8');
    const before = await fsp.readFile(indexPath);
    const descriptorPath = path.join(candidateRoot, 'candidate-0.1.1-rc.2', 'runtime-manifest.json');
    await fsp.writeFile(descriptorPath, JSON.stringify({ ...candidate.manifest, version: '0.1.1-rc.2-invalid' }), 'utf8');

    await assert.rejects(
      promoteStable({
        candidateStore: store,
        candidateVersion: candidate.version,
        remoteVerifier: async () => ({ status: 'REMOTE_VERIFIED' }),
        indexPath,
        historyDirectory,
      }),
      /candidate metadata is invalid|manifest/i,
    );
    assert.deepEqual(await fsp.readFile(indexPath), before);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('rollback fixture allows previously verified candidates, rejects never-verified candidates, and preserves prior index bytes', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-rollback-marker-'));
  const marker = 'REMOTE_VERIFY=REMOTE_VERIFIED';
  const version = '0.1.1-rc.2';
  const previousVersion = '0.1.0-rc.7';
  try {
    const bytes = Buffer.from('rollback-runtime-candidate');
    const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const makeCandidate = (candidateVersion) => ({
      packageName: '@deepseek-ai/dsh',
      version: candidateVersion,
      platform: 'win32',
      arch: 'x64',
      artifactUrl: `https://github.com/example/releases/download/dsh-runtime-v${candidateVersion}/dsh-runtime-${candidateVersion}-win32-x64.zip`,
      sizeBytes: bytes.length,
      sha256,
      manifest: {
        schemaVersion: 1,
        packageName: '@deepseek-ai/dsh',
        version: candidateVersion,
        platform: 'win32',
        arch: 'x64',
        cliEntry: 'runtime-root/apps/cli/dist/index.js',
      },
      provenance: { sourceTag: `dsh-v${candidateVersion}`, sourceCommit: 'b'.repeat(40) },
      status: 'CANDIDATE_PUBLISHED',
    });
    const zipPath = path.join(root, 'candidate.zip');
    await fsp.writeFile(zipPath, bytes);
    const store = createFileCandidateStore({ root: path.join(root, 'candidates') });
    await store.publish({ ...makeCandidate(version), zipPath });
    await store.publish({ ...makeCandidate(previousVersion), zipPath });
    const indexPath = path.join(root, 'runtime', 'stable', 'runtime-index.json');
    const historyDirectory = path.join(root, 'runtime', 'history');
    const previousIndex = buildStableIndex({ candidate: makeCandidate(previousVersion) });
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    await fsp.writeFile(indexPath, `${JSON.stringify(previousIndex, null, 2)}\n`, 'utf8');
    const beforeRejectedRollback = await fsp.readFile(indexPath);

    const rollbackFixture = async (releaseBody) => {
      if (!releaseBody.includes(marker)) {
        throw new Error('rollback candidate lacks prior REMOTE_VERIFY marker');
      }
      return rollbackStable({
        candidateStore: store,
        targetVersion: version,
        remoteVerifier: async () => ({ status: 'REMOTE_VERIFIED' }),
        indexPath,
        historyDirectory,
      });
    };

    const promoted = await promoteStable({
      candidateStore: store,
      candidateVersion: version,
      remoteVerifier: async () => ({ status: 'REMOTE_VERIFIED' }),
      indexPath,
      historyDirectory,
    });
    assert.equal(promoted.version, version, 'promotion remains allowed without a prior marker');
    await fsp.writeFile(indexPath, beforeRejectedRollback);

    const rollback = await rollbackFixture(`SOURCE_TAG=dsh-v${version}\n${marker}`);
    assert.equal(rollback.version, version, 'previously remotely verified rollback is allowed');
    await fsp.writeFile(indexPath, beforeRejectedRollback);

    await assert.rejects(
      rollbackFixture(`SOURCE_TAG=dsh-v${version}`),
      /lacks prior REMOTE_VERIFY marker/,
    );
    assert.deepEqual(await fsp.readFile(indexPath), beforeRejectedRollback);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('distribution workflow validation discovers YAML workflow files', async () => {
  const result = await validateWorkflows({ root: path.join(__dirname, '..') });
  assert.deepEqual(result, { valid: true, workflows: ['dsh-runtime-factory.yml', 'dsh-runtime-promote.yml'] });
});
