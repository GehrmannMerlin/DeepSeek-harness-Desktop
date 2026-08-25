'use strict';

const path = require('node:path');

function applyReleaseE2eUserData(appImpl, env = process.env) {
  if (!env || env.DSH_RELEASE_E2E !== '1') return false;
  const userDataDir = env.DSH_RELEASE_E2E_USER_DATA_DIR;
  if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) {
    throw new Error('DSH_RELEASE_E2E_USER_DATA_DIR must be an absolute path');
  }
  appImpl.setPath('userData', path.resolve(userDataDir));
  return true;
}

module.exports = { applyReleaseE2eUserData };
