# Current DSH Runtime Analysis

Date: 2026-08-23

## Summary

The current Desktop does not bundle `@deepseek-ai/dsh` in the Electron application or in `resources/app.asar`. It starts DSH through the user's system `npx` command and reuses an already-running Harness on the fixed local port when one is detected.

The authoritative code path is:

```text
AppLifecycle._boot()
  -> HarnessProcessManager.start()
     -> resolveCommand()
        -> cmd.exe /d /s /c npx @deepseek-ai/dsh web
```

## Repository and Build Evidence

- Application entry: `src/main.js`
- Lifecycle orchestration: `src/lifecycle/app-lifecycle.js`
- DSH process owner: `src/process/harness-process-manager.js`
- Command resolver: `src/utils/npx-resolver.js`
- Packaged archive: `dist/win-unpacked/resources/app.asar`
- Packaged archive contents include Desktop source, renderer assets, and `package.json`; they do not include `@deepseek-ai/dsh` or a DSH `node_modules` tree.
- `electron-builder.yml` currently packages `src/**`, `renderer/**`, `assets/**`, and `package.json` into an asar archive. It has no `extraResources` entry for a DSH runtime.

## Current DSH Version and Package Metadata

The local npx cache contains the package used by the existing development environment:

```text
Package: @deepseek-ai/dsh
Version: 0.1.0-rc.7
Bin: dsh -> lib/bin.js
Main: absent/null
Exports: absent/null
Package type: module
```

The npm Registry currently reports the `latest` dist-tag as `0.1.1-rc.2` during this investigation. The current cached package is evidence of the runtime available to the existing `npx` path; the application source itself does not pin that version.

## Launch Command and Arguments

`src/utils/npx-resolver.js` returns:

```js
{
  command: 'cmd.exe',
  args: ['/d', '/s', '/c', 'npx', '@deepseek-ai/dsh', 'web']
}
```

The `cmd.exe` wrapper is used so that `npx` resolves through the ambient Windows PATH. The current implementation does not use `node_modules/.bin/dsh.cmd`, a fixed package directory, or a bundled Node executable.

## Node/npm/npx Resolution

The current machine resolves the tools from:

```text
node: D:\Develop\node.js\node.exe
npm:  D:\Develop\node.js\npm.cmd
npx:  D:\Develop\node.js\npx.cmd
```

The current `checkToolchain()` verifies `node`, `npm`, and `npx` with asynchronous `where` calls. The existing process manager still launches the command returned by `resolveCommand()`.

## Process Ownership and PID Management

`HarnessProcessManager` is the only module that starts and stops the Desktop-owned DSH process.

- PID is captured from the spawned child process.
- stdout/stderr are captured for logging and URL detection.
- URL detection transitions the process from `STARTING` to `WAITING_FOR_SERVER`.
- `markRunning()` is called after the health checker confirms the Harness page.
- shutdown uses `taskkill /pid <pid> /t` and, after a grace period, `/f` on the same process tree.
- the code never uses `taskkill /im node.exe`.
- an already-running Harness is marked `external`, has no owned PID, and is never stopped by Desktop shutdown.

## Startup and Health Check

`AppLifecycle.start()` creates the BrowserWindow and Tray before the asynchronous toolchain check. `_boot()` then probes `127.0.0.1:3080`, reuses a valid Harness, or starts a new process and waits for the Harness health signature.

The current health checker requires HTTP 200 plus one of:

```text
window.__DSH_BOOT__
<title>DeepSeek Harness</title>
```

The existing startup timeout is 45 seconds, with an 800 ms polling interval after the initial probe.

## Packaging and Installation Findings

The existing build produces:

```text
dist/win-unpacked/DeepSeek Harness Desktop.exe
dist/DeepSeek Harness Desktop Setup 1.0.0.exe
```

The installed application currently depends on system Node/npm/npx. It does not write or update the installation directory, `app.asar`, or Program Files at runtime.

## Consequences for the Runtime Update System

The update implementation must introduce an immutable Bundled Runtime at build time because the existing application has no packaged DSH fallback. The recommended build shape is an `extraResources` directory outside `app.asar`, such as `resources/bundled-runtime`, containing a self-contained npm-installed DSH tree.

Managed versions must be installed only below:

```text
app.getPath('userData')/runtime/
```

The legacy system `npx` path should remain as a compatibility fallback for development and older packages that do not yet contain `bundled-runtime`, but it must not be used as the managed update target.
