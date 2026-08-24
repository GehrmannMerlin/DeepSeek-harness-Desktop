'use strict';

const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

async function withTempDir(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-updater-test-'));
  try {
    return await fn(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createPackageTree(root, options = {}) {
  const packageDirectory = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
  const cliRelativePath = options.cliRelativePath || 'bin/dsh.js';
  const packageJson = {
    name: '@deepseek-ai/dsh',
    version: options.version || '0.0.0-test',
    bin: { dsh: cliRelativePath },
    ...(options.packageJson || {})
  };
  const cliPath = path.join(packageDirectory, cliRelativePath);
  await writeJson(path.join(packageDirectory, 'package.json'), packageJson);
  await fs.mkdir(path.dirname(cliPath), { recursive: true });
  await fs.writeFile(cliPath, options.cliContents || '#!/usr/bin/env node\n', 'utf8');
  return { packageDirectory, packageJsonPath: path.join(packageDirectory, 'package.json'), cliPath };
}

module.exports = { withTempDir, writeJson, createPackageTree };
