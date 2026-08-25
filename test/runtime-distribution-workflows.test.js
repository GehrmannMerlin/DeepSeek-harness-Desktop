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
  assert.ok(latest >= 0, 'workflow must use npm dist-tags.latest for automatic resolution');
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
