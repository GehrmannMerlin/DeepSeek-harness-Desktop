'use strict';
const { execFile } = require('child_process');

const NPX_ARGS = ['@deepseek-ai/dsh', 'web'];

// Spawn through cmd.exe so npx resolves via the ambient PATH — exactly what the
// user runs by hand (`npx @deepseek-ai/dsh web`). This keeps the packaged app
// working as long as node/npx are on the system/user PATH (they are here:
// D:\Develop\node.js is in the machine PATH).
function resolveCommand() {
  return resolveLegacyCommand();
}

function resolveLegacyCommand() {
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npx', ...NPX_ARGS],
  };
}

function resolveWithWhere(tool, { execFile: execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl('where', [tool], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (error, stdout) => {
      const command = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (!error && command) resolve(command);
      else reject(new Error(`Unable to resolve ${tool} from PATH`));
    });
  });
}

function resolveNodeCommand(options) {
  return resolveWithWhere(process.platform === 'win32' ? 'node.exe' : 'node', options);
}

function resolveNpmCommand(options) {
  return resolveWithWhere(process.platform === 'win32' ? 'npm.cmd' : 'npm', options);
}

function resolveNpxCommand(options) {
  return resolveWithWhere(process.platform === 'win32' ? 'npx.cmd' : 'npx', options);
}

// Resolve one tool to its missing status: resolves null when present, the tool
// name when missing. Async so it never blocks the main process / first paint.
function where(tool) {
  return new Promise((resolve) => {
    execFile('where', [tool], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (!err && String(stdout || '').trim()) resolve(null);
      else resolve(tool);
    });
  });
}

// Returns the list of missing tools (empty means all present).
async function checkToolchain() {
  const results = await Promise.all(['node', 'npm', 'npx'].map(where));
  return results.filter(Boolean);
}

module.exports = {
  NPX_ARGS,
  resolveCommand,
  resolveLegacyCommand,
  resolveNodeCommand,
  resolveNpmCommand,
  resolveNpxCommand,
  checkToolchain,
};
