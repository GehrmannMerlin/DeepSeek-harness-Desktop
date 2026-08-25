'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validateWorkflows } = require('../scripts/runtime-distribution/runtime-distribution-cli');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'dsh-runtime-factory.yml');

function workflowText() {
  return fs.readFileSync(WORKFLOW, 'utf8');
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

test('distribution workflow validation discovers YAML workflow files', async () => {
  const result = await validateWorkflows({ root: path.join(__dirname, '..') });
  assert.deepEqual(result, { valid: true, workflows: ['dsh-runtime-factory.yml'] });
});
