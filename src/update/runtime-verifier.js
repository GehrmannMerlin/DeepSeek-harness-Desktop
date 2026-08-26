'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs').promises;
const path = require('node:path');
const semver = require('../runtime/semver-lite');

const PACKAGE_NAME = '@deepseek-ai/dsh';
const CLI_TIMEOUT_MS = 10000;

function defaultRunCommand(command, args, { timeoutMs }) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout: stdout || '', stderr: stderr || '', timedOut: Boolean(error && error.killed) });
    });
  });
}

function result({ ok = false, packagePath, cliEntry = null, reportedVersion = null, reason, code = null, timedOut = false }) {
  return { ok, packagePath, cliEntry, reportedVersion, reason, code, timedOut };
}

function resolveCliEntry(packageRoot, bin) {
  let entry;
  if (typeof bin === 'string') entry = bin;
  else if (bin && typeof bin === 'object' && !Array.isArray(bin) && typeof bin.dsh === 'string') entry = bin.dsh;
  else return null;
  if (!entry || path.isAbsolute(entry)) return null;
  const cliEntry = path.resolve(packageRoot, entry);
  const packagePrefix = `${path.resolve(packageRoot)}${path.sep}`;
  return cliEntry.startsWith(packagePrefix) ? cliEntry : null;
}

function containsExactVersion(output, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9A-Za-z.-])${escaped}(?=$|[^0-9A-Za-z.-])`).test(output);
}

async function verifyRuntime({ rootPath, expectedVersion, nodeCommand, runCommand = defaultRunCommand } = {}) {
  const packageRoot = path.join(rootPath || '', 'node_modules', '@deepseek-ai', 'dsh');
  const packagePath = path.join(packageRoot, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  } catch (_) {
    return result({ packagePath, reason: 'package-json-invalid' });
  }
  if (manifest.name !== PACKAGE_NAME) return result({ packagePath, reason: 'package-name-mismatch' });
  if (!semver.valid(manifest.version) || !semver.valid(expectedVersion) || manifest.version !== expectedVersion) return result({ packagePath, reason: 'package-version-mismatch' });

  const cliEntry = resolveCliEntry(packageRoot, manifest.bin);
  if (!cliEntry) return result({ packagePath, reason: 'invalid-bin' });
  try {
    const stat = await fs.stat(cliEntry);
    if (!stat.isFile()) return result({ packagePath, cliEntry, reason: 'cli-entry-missing' });
  } catch (_) {
    return result({ packagePath, cliEntry, reason: 'cli-entry-missing' });
  }

  let execution;
  try {
    execution = await runCommand(nodeCommand, [cliEntry, '--version'], { timeoutMs: CLI_TIMEOUT_MS });
  } catch (_) {
    return result({ packagePath, cliEntry, reason: 'cli-run-failed' });
  }
  const code = execution && execution.code != null ? execution.code : null;
  const timedOut = Boolean(execution && execution.timedOut);
  const output = `${execution && execution.stdout ? execution.stdout : ''}\n${execution && execution.stderr ? execution.stderr : ''}`;
  const reportedVersion = semver.valid((output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/) || [])[0]) || null;
  if (timedOut) return result({ packagePath, cliEntry, reportedVersion, reason: 'cli-timeout', code, timedOut: true });
  if (code !== 0) return result({ packagePath, cliEntry, reportedVersion, reason: 'cli-nonzero-exit', code, timedOut: false });
  if (!containsExactVersion(output, expectedVersion)) return result({ packagePath, cliEntry, reportedVersion, reason: 'cli-version-mismatch', code, timedOut: false });
  return result({ ok: true, packagePath, cliEntry, reportedVersion: expectedVersion, reason: null, code, timedOut: false });
}

module.exports = { verifyRuntime, resolveCliEntry, containsExactVersion, CLI_TIMEOUT_MS };
