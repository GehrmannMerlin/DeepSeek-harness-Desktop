'use strict';
const { mark } = require('./utils/boot-timeline');
mark('process_start');

const { app, Menu } = require('electron');
const { AppLifecycle } = require('./lifecycle/app-lifecycle');

// On Windows 11 25H2 (build 26200) Chromium runs the GPU process in an LPAC
// (Less-Privileged AppContainer) sandbox, and the renderer in an AppContainer
// sandbox when webPreferences.sandbox is true. Install dirs whose ACL lacks the
// matching capability ACE make those processes fail to read their own DLLs and
// abort with STATUS_BREAKPOINT (0x80000003) -> black window / app death.
//   - GPU process: disable-gpu-sandbox (below).
//   - Renderer: sandbox:false in window/main-window.js (AppContainer is not
//     controllable via a feature flag that actually works here).
// nodeIntegration:false + contextIsolation:true remain as the primary
// isolation boundaries. (disableHardwareAcceleration is optional but reduces
// GPU dependency for a chat UI.)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-sandbox');

mark('single_instance_lock_attempt');
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  mark('single_instance_lock_failed');
  app.quit();
} else {
  mark('single_instance_lock_acquired');
  let lifecycle = null;

  // A second launch re-shows the already-running instance.
  app.on('second-instance', () => {
    // eslint-disable-next-line no-console
    console.log('[second-instance] another launch was requested');
    mark('second_instance_received');
    if (lifecycle) lifecycle._showWindow();
  });

  // Keep running in the tray when the window is closed (hidden).
  app.on('window-all-closed', () => {
    /* intentional no-op: the tray keeps the app alive */
  });

  app.whenReady().then(() => {
    mark('app_ready');
    Menu.setApplicationMenu(null); // no default File/Edit/View/Window menu
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
