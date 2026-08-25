'use strict';

const CONFIRM_SCRIPT = 'window.updateApi.confirmUpdate()';

function log(lifecycle, level, message) {
  const logger = lifecycle && lifecycle.appLogger;
  if (logger && typeof logger[level] === 'function') logger[level](message);
}

function attachReleaseE2eUpdateDriver(lifecycle, { env = process.env } = {}) {
  if (!lifecycle || !lifecycle.updateManager || env.DSH_RELEASE_E2E !== '1') return () => {};
  const manager = lifecycle.updateManager;
  if (typeof manager.on !== 'function') return () => {};

  let triggered = false;
  let detached = false;
  let exitScheduled = false;

  const scheduleExit = (snapshot) => {
    const expectedState = env.DSH_RELEASE_E2E_EXIT_AFTER_STATE;
    if (exitScheduled || !expectedState || !lifecycle.quit || !snapshot || snapshot.state !== expectedState) return;
    exitScheduled = true;
    const parsedDelay = Number(env.DSH_RELEASE_E2E_EXIT_DELAY_MS);
    const delay = Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : 0;
    setTimeout(() => {
      Promise.resolve(lifecycle.quit())
        .catch((error) => log(lifecycle, 'error', `release_e2e_exit_failed ${error.message}`));
    }, delay);
  };

  const confirmFromRenderer = async (snapshot) => {
    if (detached || !lifecycle._openUpdateDialog) return;
    const dialogWindow = lifecycle._openUpdateDialog(snapshot);
    const webContents = dialogWindow && dialogWindow.webContents;
    if (!webContents || typeof webContents.executeJavaScript !== 'function') {
      throw new Error('release E2E update dialog has no executable webContents');
    }

    const execute = () => webContents.executeJavaScript(CONFIRM_SCRIPT)
      .then((result) => {
        const state = result && result.state ? result.state : 'unknown';
        log(lifecycle, 'info', `release_e2e_update_confirm_finished state=${state}`);
        return result;
      });

    if (typeof webContents.isLoading === 'function' && webContents.isLoading() && typeof webContents.once === 'function') {
      await new Promise((resolve, reject) => {
        webContents.once('did-finish-load', () => execute().then(resolve, reject));
      });
      return;
    }
    await execute();
  };

  const onStateChange = ({ snapshot } = {}) => {
    scheduleExit(snapshot);
    if (triggered || !snapshot || snapshot.state !== 'UPDATE_AVAILABLE') return;
    triggered = true;
    log(lifecycle, 'info', `release_e2e_update_confirm_started version=${snapshot.latest && snapshot.latest.version || 'unknown'}`);
    Promise.resolve()
      .then(() => confirmFromRenderer(snapshot))
      .catch((error) => log(lifecycle, 'error', `release_e2e_update_confirm_failed ${error.message}`));
  };

  manager.on('state-change', onStateChange);
  return () => {
    detached = true;
    if (typeof manager.removeListener === 'function') manager.removeListener('state-change', onStateChange);
  };
}

module.exports = { CONFIRM_SCRIPT, attachReleaseE2eUpdateDriver };
