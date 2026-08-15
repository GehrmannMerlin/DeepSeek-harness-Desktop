'use strict';
const { app } = require('electron');
const { AppLifecycle } = require('./lifecycle/app-lifecycle');

// On Windows 11 25H2 (build 26200) the Chromium GPU process runs in an LPAC
// (Less-Privileged AppContainer) sandbox. Install dirs missing the matching ACE
// make that process fail to read its own DLLs and abort with STATUS_BREAKPOINT
// (0x80000003) -> "GPU process isn't usable. Goodbye.", killing the app and
// orphaning the spawned Harness. Disabling just the GPU sandbox avoids this
// while keeping the renderer sandbox intact. (disableHardwareAcceleration is
// optional here but reduces GPU dependency for a chat UI.)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-sandbox');

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  let lifecycle = null;

  // A second launch re-shows the already-running instance.
  app.on('second-instance', () => {
    // eslint-disable-next-line no-console
    console.log('[second-instance] another launch was requested');
    if (lifecycle) lifecycle._showWindow();
  });

  // Keep running in the tray when the window is closed (hidden).
  app.on('window-all-closed', () => {
    /* intentional no-op: the tray keeps the app alive */
  });

  app.whenReady().then(() => {
    lifecycle = new AppLifecycle();
    lifecycle.start().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('lifecycle error:', err);
      app.quit();
    });

    // Test seam (off in normal use): graceful auto-quit after N ms, so an
    // automated smoke test can verify the full shutdown/cleanup path.
    if (process.env.DSH_DESKTOP_AUTOSHUTDOWN_MS) {
      setTimeout(() => lifecycle.quit(), Number(process.env.DSH_DESKTOP_AUTOSHUTDOWN_MS));
    }
  });
}
