'use strict';
const { execFile } = require('child_process');

// Run taskkill and never reject: a non-zero exit just means the target was
// already gone, which is a successful cleanup from our point of view.
function runTaskkill(args) {
  return new Promise((resolve) => {
    execFile('taskkill', args, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

// Kill a specific process and its whole descendant tree. SAFETY: only the tree
// rooted at `pid` is touched — never `taskkill /IM node.exe` (would kill other
// dev projects: Codex, Claude Code, Vite, etc.).
function killTree(pid, { force = true } = {}) {
  const args = ['/pid', String(pid), '/t'];
  if (force) args.push('/f');
  return runTaskkill(args);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but owned by another user
  }
}

module.exports = { killTree, isAlive };
