'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [executable, userDataDir, indexUrl, outputPath, errorPath, autoShutdownMs = '180000', dshHome = ''] = process.argv.slice(2);
if (!executable || !userDataDir || !indexUrl || !outputPath || !errorPath) {
  throw new Error('usage: release-e2e-launch <exe> <userDataDir> <indexUrl> <stdout> <stderr> [autoShutdownMs]');
}

fs.mkdirSync(userDataDir, { recursive: true });
const childEnv = {
  ...process.env,
  DSH_RELEASE_E2E: '1',
  DSH_RELEASE_E2E_USER_DATA_DIR: path.resolve(userDataDir),
  DSH_VERIFIED_RUNTIME_INDEX_URL: indexUrl,
  DSH_DESKTOP_AUTOSHUTDOWN_MS: autoShutdownMs,
};
if (dshHome) childEnv.DSH_HOME = path.resolve(dshHome);

const child = spawn(executable, [], {
  cwd: path.dirname(executable),
  env: childEnv,
  detached: true,
  windowsHide: false,
  stdio: ['ignore', fs.openSync(outputPath, 'a'), fs.openSync(errorPath, 'a')],
});

process.stdout.write(`${JSON.stringify({ pid: child.pid })}\n`);
child.unref();
