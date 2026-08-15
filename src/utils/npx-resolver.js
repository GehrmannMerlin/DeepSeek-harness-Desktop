'use strict';
const { execFileSync } = require('child_process');

const NPX_ARGS = ['@deepseek-ai/dsh', 'web'];

// Spawn through cmd.exe so npx resolves via the ambient PATH — exactly what the
// user runs by hand (`npx @deepseek-ai/dsh web`). This keeps the packaged app
// working as long as node/npx are on the system/user PATH (they are here:
// D:\Develop\node.js is in the machine PATH).
function resolveCommand() {
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npx', ...NPX_ARGS],
  };
}

// Returns the list of missing tools (empty means all present).
function checkToolchain() {
  const missing = [];
  for (const tool of ['node', 'npm', 'npx']) {
    try {
      const out = execFileSync('where', [tool], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      if (!out.trim()) missing.push(tool);
    } catch (_) {
      missing.push(tool);
    }
  }
  return missing;
}

module.exports = { NPX_ARGS, resolveCommand, checkToolchain };
