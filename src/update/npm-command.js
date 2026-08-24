'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');

async function exists(filePath, fsImpl) {
  try {
    await fsImpl.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

function pathEntries(env) {
  const value = env && (env.Path || env.PATH);
  return typeof value === 'string' ? value.split(path.delimiter).filter(Boolean) : [];
}

async function resolveNpmInvocation(command, { platform = process.platform, env = process.env, fsImpl = fs } = {}) {
  if (platform !== 'win32' || typeof command !== 'string' || !/\.cmd$/i.test(command)) {
    return { command, argsPrefix: [] };
  }

  const candidates = path.isAbsolute(command)
    ? [command]
    : pathEntries(env).map((entry) => path.join(entry, command));
  for (const npmShim of candidates) {
    const baseDir = path.dirname(npmShim);
    const nodeCommand = path.join(baseDir, 'node.exe');
    const npmCli = path.join(baseDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (await exists(nodeCommand, fsImpl) && await exists(npmCli, fsImpl)) {
      return { command: nodeCommand, argsPrefix: [npmCli] };
    }
  }

  throw new Error(`Cannot launch ${command} with shell:false: npm shim and its Node.js CLI were not found on PATH`);
}

module.exports = { resolveNpmInvocation };
