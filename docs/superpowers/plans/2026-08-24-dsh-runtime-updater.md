# DSH Runtime Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, user-confirmed, npm-latest-driven DSH Runtime update system with side-by-side installation, atomic activation, health-checked restart, External Harness protection, and automatic rollback.

**Architecture:** Keep Desktop orchestration in `AppLifecycle`, make `DshRuntimeManager` the only producer of DSH runtime descriptors, make `DshUpdateManager` the only owner of update state and operations, and keep process lifecycle in `HarnessProcessManager`. Package a pinned immutable fallback under `resources/bundled-runtime` outside `app.asar`; install updates only below `app.getPath('userData')/runtime`.

**Tech Stack:** Electron 43 main process, Node.js CommonJS modules, Electron `contextBridge` preload, Node `https`, `child_process.spawn`/`execFile`, Node built-in `node:test`, and the `semver` package.

**Spec:** `docs/superpowers/specs/2026-08-23-dsh-runtime-updater-design.md`

## Global Constraints

- Follow npm `dist-tags.latest` only; GitHub is not an install source.
- Never silently install an update; installation starts only after explicit user confirmation.
- Never put the Registry check on the startup critical path.
- Never modify `app.asar`, Program Files, the Desktop package lock, or the user's npm configuration at runtime.
- Keep Bundled Runtime immutable and never delete it.
- Install Managed Runtime versions side-by-side under `app.getPath('userData')/runtime/versions`.
- Install into operation-specific staging first; promote only after package and CLI verification.
- Use `semver.valid()` and `semver.gt()`; reject invalid remote versions and never downgrade when npm latest is lower.
- Pass npm/package data through spawn argument arrays; never construct a shell command from Registry content.
- Never stop or kill an External Harness; use `WAITING_FOR_EXTERNAL_HARNESS` and durable pending activation.
- Stop owned Harness only after install and verification succeed, and only through `HarnessProcessManager.stop()`.
- Run a health check after every applied runtime restart and roll back to previous, then Bundled fallback, on failure.
- Keep Electron renderer isolation: `nodeIntegration:false`, `contextIsolation:true`; update renderer receives only the minimal IPC API.
- Automatic update-check failures are silent apart from concise logs; manual-check failures may be shown to the user.
- Do not modify the DeepSeek Harness Web DOM.

---

## File Map

### New runtime modules

- Create `src/runtime/runtime-descriptor.js`: descriptor shape, validation, and durable relative-state conversion.
- Create `src/runtime/runtime-state-store.js`: schema defaults, validation, atomic read/write, and state update helper.
- Create `src/runtime/dsh-runtime-manager.js`: Bundled/Managed/legacy resolution, promotion, activation, rollback, pending validation, and cleanup.

### New update modules

- Create `src/update/npm-registry-update-source.js`: one bounded HTTPS metadata request for `@deepseek-ai/dsh`.
- Create `src/update/npm-installer.js`: exact-version npm installation into staging with output capture and timeout.
- Create `src/update/runtime-verifier.js`: package metadata, `bin`, and CLI version verification.
- Create `src/update/dsh-update-manager.js`: single update state machine, operation lock, check/install/apply/rollback flow, and events.

### Existing main-process modules

- Modify `src/utils/paths.js`: expose runtime roots and the bundled resource root.
- Modify `src/utils/npx-resolver.js`: expose resolved Node/npm/npx executables and retain the legacy npx command.
- Modify `src/process/harness-process-manager.js`: accept a runtime descriptor for owned launches without changing External ownership behavior.
- Modify `src/health/harness-health-checker.js`: expose injectable/short-timeout health calls for update restart checks without changing existing startup defaults.
- Modify `src/window/main-window.js`: emit a Harness-ready event after the Harness page finishes loading.
- Modify `src/tray/tray-manager.js`: add version, check, and update menu entries through callbacks.
- Modify `src/lifecycle/app-lifecycle.js`: construct managers, resolve runtime before boot, schedule post-ready checks, and orchestrate update UI/restart messages.
- Modify `src/utils/boot-timeline.js`: use lifecycle marks for update check scheduling/start/finish.

### New Desktop-owned update UI

- Create `src/window/update-dialog.js`: local confirmation/progress/result BrowserWindow.
- Create `src/window/update-preload.js`: minimal context-isolated API.
- Create `renderer/update.html`: localized dialog markup and status areas.
- Create `renderer/update.css`: local styles and spinner; no CDN or remote font.

### Build, package, tests, and docs

- Create `scripts/prepare-bundled-runtime.js`: prepare the pinned fallback tree outside asar.
- Modify `electron-builder.yml`: include `build/bundled-runtime` as `extraResources` to `bundled-runtime`.
- Modify `.gitignore`: ignore generated `build/bundled-runtime` output.
- Modify `package.json` and `package-lock.json`: add `semver`, test scripts, and build preparation commands.
- Create `test/runtime-descriptor.test.js`.
- Create `test/runtime-state-store.test.js`.
- Create `test/dsh-runtime-manager.test.js`.
- Create `test/npm-registry-update-source.test.js`.
- Create `test/runtime-verifier.test.js`.
- Create `test/dsh-update-manager.test.js`.
- Create `test/npm-installer.test.js`.
- Create `test/harness-process-manager.test.js`.
- Create `test/app-lifecycle-update-flow.test.js`.
- Create `test/update-dialog.test.js`.
- Create `test/prepare-bundled-runtime.test.js`.
- Create `test/update-integration.test.js`.
- Update `docs/runtime/dsh-runtime-update-architecture.md` with final implementation paths and observed behavior.
- Create `docs/runtime/dsh-runtime-update-verification.md`.

---

### Task 1: Add dependency and test/build seams

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Create: `test/test-helpers.js`

**Interfaces:**
- Produces the `semver` dependency used by all version logic.
- Produces `test/test-helpers.js` functions `withTempDir(fn)`, `writeJson(filePath, value)`, and `createPackageTree(root, options)`.
- Produces `npm test` as `node --test test`.

- [ ] **Step 1: Add the failing package assertions**

Assert that `package.json` contains the test/build scripts and that `require('semver').gt` is callable.

Run: `node --test test`

Expected: FAIL until the package script and dependency are present.

- [ ] **Step 2: Add the Desktop dependency and scripts**

Run:

```powershell
npm install --save semver
```

Add these scripts:

```json
"test": "node --test test",
"prepare:bundled-runtime": "node scripts/prepare-bundled-runtime.js",
"pack": "npm run prepare:bundled-runtime && electron-builder --dir",
"dist": "npm run prepare:bundled-runtime && electron-builder --win"
```

The updater's runtime npm install will not use or modify this Desktop lockfile.

- [ ] **Step 3: Implement isolated test helpers**

Use `fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-updater-test-'))`; pass the exact directory to the callback and remove only that directory in `finally`. `createPackageTree` writes `node_modules/@deepseek-ai/dsh/package.json` and a fixture CLI entry.

- [ ] **Step 4: Run the baseline test command**

Run: `npm test`

Expected: the existing URL detector test and new package assertions pass.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json .gitignore test/test-helpers.js
git commit -m "build: add runtime updater test seams"
```

### Task 2: Implement Runtime Descriptor and atomic State Store

**Files:**
- Create: `src/runtime/runtime-descriptor.js`
- Create: `src/runtime/runtime-state-store.js`
- Create: `test/runtime-descriptor.test.js`
- Create: `test/runtime-state-store.test.js`

**Interfaces:**
- Produces `createRuntimeDescriptor(input) -> RuntimeDescriptor`.
- Produces `isRuntimeDescriptor(value) -> boolean`.
- Produces `descriptorToState(descriptor, relativePath) -> StateRuntimeReference`.
- Produces `createDefaultRuntimeState() -> RuntimeState`.
- Produces `RuntimeStateStore.load() -> Promise<RuntimeState>`.
- Produces `RuntimeStateStore.save(state) -> Promise<void>`.
- Produces `RuntimeStateStore.update(mutator) -> Promise<RuntimeState>`.

- [ ] **Step 1: Write descriptor tests**

Cover accepted managed/bundled descriptors, rejected kinds, invalid SemVer, missing absolute paths, and invalid `args`:

```js
const descriptor = createRuntimeDescriptor({
  kind: 'managed', version: '0.1.1-rc.2', rootPath, packagePath, cliEntry,
  command: nodePath, args: [cliEntry, 'web'], source: 'managed'
});
assert.equal(descriptor.kind, 'managed');
assert.deepEqual(descriptor.args, [cliEntry, 'web']);
assert.throws(() => createRuntimeDescriptor({ kind: 'unknown' }), /descriptor/i);
```

Run: `node --test test/runtime-descriptor.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement the descriptor contract**

Allow only `managed`, `bundled`, and `legacy`. Require non-empty SemVer for managed/bundled descriptors, absolute filesystem paths, a string-array `args`, and a source consistent with the kind. Keep state serialization separate from absolute runtime paths.

- [ ] **Step 3: Write state-store tests**

Cover missing state defaults, atomic replacement with no leftover `.tmp`, and corrupt JSON fallback while recording a logger error. Use a temporary `filePath` and injected `fs`/logger.

Run: `node --test test/runtime-state-store.test.js`

Expected: FAIL until the store exists.

- [ ] **Step 4: Implement atomic state persistence**

Validate `schemaVersion === 1`, `current`, `previous`, `pending`, `failedVersions`, and `lastNotifiedVersion`. Ensure the parent exists, write `${filePath}.tmp` as UTF-8, close the file, and rename it over the target. On read parse failure or schema mismatch, log and return `createDefaultRuntimeState()`.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/runtime-descriptor.test.js test/runtime-state-store.test.js`

Expected: PASS.

```powershell
git add src/runtime test/runtime-descriptor.test.js test/runtime-state-store.test.js
git commit -m "feat: add runtime descriptors and atomic state store"
```

### Task 3: Add runtime paths and DSH resolution

**Files:**
- Modify: `src/utils/paths.js`
- Modify: `src/utils/npx-resolver.js`
- Create: `src/runtime/dsh-runtime-manager.js`
- Create: `test/dsh-runtime-manager.test.js`

**Interfaces:**
- Produces `getRuntimeRoot()`, `getManagedVersionsDir()`, `getStagingDir()`, `getRuntimeStatePath()`, and `getBundledRuntimeRoot()`.
- Produces `resolveNodeCommand()`, `resolveNpmCommand()`, `resolveNpxCommand()`, and unchanged `resolveLegacyCommand()`.
- Produces `DshRuntimeManager.resolveCurrentRuntime() -> Promise<RuntimeDescriptor>`.
- Produces `DshRuntimeManager.resolveBundledFallback() -> Promise<RuntimeDescriptor|null>`.
- Produces `DshRuntimeManager.resolveManagedRuntime(version) -> Promise<RuntimeDescriptor|null>`.
- Produces `DshRuntimeManager.validateRuntime(rootPath, expectedVersion) -> Promise<RuntimeDescriptor|null>`.

- [ ] **Step 1: Write runtime-resolution tests**

Use temporary roots and injected state:

```js
test('managed current wins over bundled fallback', async () => {
  const current = await makeManager({ managedVersion: '0.1.1-rc.2', bundledVersion: '0.1.0-rc.7' }).resolveCurrentRuntime();
  assert.equal(current.kind, 'managed');
});

test('corrupt state or invalid managed tree falls back to bundled', async () => {
  writeFileSync(statePath, '{bad');
  assert.equal((await manager.resolveCurrentRuntime()).kind, 'bundled');
});

test('no bundled runtime retains legacy npx fallback', async () => {
  assert.equal((await makeManager({ bundledVersion: null }).resolveCurrentRuntime()).kind, 'legacy');
});
```

Run: `node --test test/dsh-runtime-manager.test.js`

Expected: FAIL until the resolver exists.

- [ ] **Step 2: Implement runtime path helpers**

Use `app.getPath('userData')` for runtime roots and `process.resourcesPath` when packaged. In development, resolve the bundled fixture from `build/bundled-runtime`. Pure path helpers return absolute paths and do not create directories.

- [ ] **Step 3: Implement Windows tool resolution**

Retain the legacy command `{ command: 'cmd.exe', args: ['/d', '/s', '/c', 'npx', '@deepseek-ai/dsh', 'web'] }`. Add async `where`-based resolution for Node, npm, and npx, preferring `npm.cmd`/`npx.cmd` on Windows. Return a structured missing-tool error only when installation needs npm and no executable is available.

- [ ] **Step 4: Implement descriptor discovery**

Load state, validate the Managed current reference, validate Bundled package metadata/bin, then return legacy npx only when neither managed nor bundled is valid. Resolve a string bin or the `dsh` property of an object bin to `<root>/node_modules/@deepseek-ai/dsh/<entry>` and reject ambiguous bin objects.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/dsh-runtime-manager.test.js`

Expected: PASS.

```powershell
git add src/utils/paths.js src/utils/npx-resolver.js src/runtime/dsh-runtime-manager.js test/dsh-runtime-manager.test.js
git commit -m "feat: resolve bundled and managed DSH runtimes"
```

### Task 4: Implement npm Registry latest source

**Files:**
- Create: `src/update/npm-registry-update-source.js`
- Create: `test/npm-registry-update-source.test.js`

**Interfaces:**
- Produces `NpmRegistryUpdateSource({ requestJson, timeoutMs, logger })`.
- Produces `getLatest() -> Promise<LatestPackageInfo>` with `{ packageName, version, distTag, integrity, tarball }`.
- Produces `compareLatest(installedVersion, latestVersion) -> 'UPDATE_AVAILABLE'|'UP_TO_DATE'|'AHEAD_OF_LATEST'`.

- [ ] **Step 1: Write injected transport tests**

Use a fixture containing `name`, `dist-tags.latest`, and `versions[latest].dist`. Assert successful extraction and rejection for timeout, HTTP 500, invalid JSON, wrong package, empty version, and non-SemVer version.

Run: `node --test test/npm-registry-update-source.test.js`

Expected: FAIL until the provider exists.

- [ ] **Step 2: Implement the HTTPS transport**

Request exactly `https://registry.npmjs.org/@deepseek-ai%2fdsh` with `https.get`, a 4,000 ms timeout, a bounded body, JSON parsing, and non-2xx rejection. Never invoke npm, install packages, start DSH, or update UI from this module.

- [ ] **Step 3: Implement SemVer comparison**

Use `semver.valid()` and `semver.gt()`. Accept prereleases when npm assigns them to `latest`; return `AHEAD_OF_LATEST` for a higher local version and never create a downgrade target.

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/npm-registry-update-source.test.js`

Expected: PASS.

```powershell
git add src/update/npm-registry-update-source.js test/npm-registry-update-source.test.js
git commit -m "feat: check DSH updates from npm latest"
```

### Task 5: Implement staging installer and runtime verification

**Files:**
- Create: `src/update/npm-installer.js`
- Create: `src/update/runtime-verifier.js`
- Create: `test/npm-installer.test.js`
- Create: `test/runtime-verifier.test.js`

**Interfaces:**
- Produces `NpmInstaller({ npmCommand, spawnProcess, logger, installTimeoutMs })`.
- Produces `install({ stagingRoot, packageName, version }) -> Promise<InstallResult>`.
- Produces `verifyRuntime({ rootPath, expectedVersion, nodeCommand, runCommand, timeoutMs }) -> Promise<VerificationResult>`.

- [ ] **Step 1: Write installer tests**

Use an injected fake process runner to assert exact args, `shell:false`, success, non-zero exit, timeout, PID, and captured output:

```js
await installer.install({ stagingRoot, packageName: '@deepseek-ai/dsh', version: '0.1.1-rc.2' });
assert.deepEqual(calls[0].args, ['install', '--prefix', stagingRoot, '--no-audit', '--no-fund', '@deepseek-ai/dsh@0.1.1-rc.2']);
assert.equal(calls[0].options.shell, false);
```

Run: `node --test test/npm-installer.test.js`

Expected: FAIL until the installer exists.

- [ ] **Step 2: Implement exact argument-array installation**

Create staging and a minimal `{ "private": true }` package file. Run `spawn(npmCommand, args, { shell:false, windowsHide:true, stdio:['ignore','pipe','pipe'] })`; capture bounded stdout/stderr, PID, exit code, and duration; terminate the install tree on timeout. Never use `npm update`, `-g`, or a shell string.

- [ ] **Step 3: Write verifier tests**

Cover exact package name/version, string/object `bin`, missing entry, CLI version match/mismatch, non-zero exit, and timeout.

Run: `node --test test/runtime-verifier.test.js`

Expected: FAIL until the verifier exists.

- [ ] **Step 4: Implement two-layer verification**

Read `root/node_modules/@deepseek-ai/dsh/package.json`, require exact name/version, resolve the `dsh` bin entry, require the file to exist, then run `[cliEntry, '--version']` through the injected Node command with a 10,000 ms timeout. Accept only exit code 0 and output containing the exact target version.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/npm-installer.test.js test/runtime-verifier.test.js`

Expected: PASS.

```powershell
git add src/update/npm-installer.js src/update/runtime-verifier.js test/npm-installer.test.js test/runtime-verifier.test.js
git commit -m "feat: stage and verify DSH runtimes"
```

### Task 6: Complete RuntimeManager promotion, activation, rollback, and cleanup

**Files:**
- Modify: `src/runtime/dsh-runtime-manager.js`
- Modify: `src/runtime/runtime-state-store.js`
- Extend: `test/dsh-runtime-manager.test.js`

**Interfaces:**
- Produces `promoteStaging(stagingRoot, version) -> Promise<RuntimeDescriptor>`.
- Produces `activateRuntime(descriptor) -> Promise<RuntimeState>`.
- Produces `rollbackRuntime() -> Promise<RuntimeDescriptor>`.
- Produces `recordPending(descriptor) -> Promise<void>`.
- Produces `consumePendingIfValid() -> Promise<RuntimeDescriptor|null>`.
- Produces `cleanupStaging({ olderThanMs, activeOperationId }) -> Promise<string[]>`.
- Produces `cleanupOldVersions({ keepCount: 2 }) -> Promise<string[]>`.

- [ ] **Step 1: Write promotion and pointer-transition tests**

Assert staging is moved to `versions/<version>`, valid existing targets are reused, current becomes previous, and rollback restores previous:

```js
const promoted = await manager.promoteStaging(stagingRoot, '0.1.1-rc.2');
assert.equal(promoted.kind, 'managed');
assert.equal(fs.existsSync(stagingRoot), false);
await manager.activateRuntime(promoted);
assert.equal((await manager.getState()).current.version, '0.1.1-rc.2');
```

- [ ] **Step 2: Implement promotion and activation**

Use `fs.promises.rename` on the same user-data filesystem. If the target exists, validate and reuse it when valid; isolate an invalid target before retrying. `activateRuntime` records the previous descriptor, sets current, clears pending, and saves atomically.

- [ ] **Step 3: Implement pending activation and rollback**

Persist pending references as relative `versions/<version>` paths. Validate pending package metadata/bin before activation. Rollback chooses previous, then Bundled fallback, records the failed version timestamp, clears pending, and saves atomically.

- [ ] **Step 4: Implement cleanup rules**

Delete only stale staging older than 24 hours that is not active and not referenced by current/previous/pending. Retain the two newest valid Managed versions; never delete Bundled.

- [ ] **Step 5: Run tests and commit**

Run: `node --test test/dsh-runtime-manager.test.js`

Expected: PASS for corrupt-state fallback, atomic transitions, pending revalidation, stale staging, and retention.

```powershell
git add src/runtime/dsh-runtime-manager.js src/runtime/runtime-state-store.js test/dsh-runtime-manager.test.js
git commit -m "feat: add runtime promotion and rollback"
```

### Task 7: Integrate RuntimeDescriptor with HarnessProcessManager

**Files:**
- Modify: `src/process/harness-process-manager.js`
- Modify: `src/health/harness-health-checker.js`
- Create: `test/harness-process-manager.test.js`
- Extend: `test/url-detector.test.js` only if required by the runtime-start regression.

**Interfaces:**
- Changes `HarnessProcessManager.start(runtimeDescriptor = null) -> Promise<boolean>`.
- Keeps `markExternal(url)`, `ownsHarness()`, `stop()`, and tree-scoped cleanup behavior unchanged.
- Produces `getRuntimeDescriptor() -> RuntimeDescriptor|null`.
- Keeps `waitUntilReady(url, options)` compatible while allowing an injected check function.

- [ ] **Step 1: Write process-manager tests**

Use an injected spawn and assert descriptor command/args are used; mark an External Harness and assert `stop()` never reaches `killTree`.

- [ ] **Step 2: Implement descriptor-aware start**

When a descriptor is supplied, spawn `descriptor.command` with `descriptor.args` and store the descriptor. When absent, use the legacy resolver. Keep stdout URL detection, PID capture, status transitions, and expected-stop behavior intact.

- [ ] **Step 3: Make health checking injectable**

Keep existing HTTP signatures and 45-second startup defaults. Add optional `checkFn`/transport injection only at module boundaries so update tests can simulate success, crash, timeout, and rollback.

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/harness-process-manager.test.js test/url-detector.test.js`

Expected: PASS, including zero kill calls for External ownership.

```powershell
git add src/process/harness-process-manager.js src/health/harness-health-checker.js test/harness-process-manager.test.js test/url-detector.test.js
git commit -m "feat: start DSH from resolved runtime descriptors"
```

### Task 8: Implement DshUpdateManager state machine and update operation flow

**Files:**
- Create: `src/update/dsh-update-manager.js`
- Create: `test/dsh-update-manager.test.js`

**Interfaces:**
- Produces `DshUpdateManager({ runtimeManager, registry, installer, verifier, processManager, healthChecker, logger, clock })`.
- Produces `getSnapshot() -> UpdateSnapshot`.
- Produces `checkForUpdates({ manual = false } = {}) -> Promise<UpdateSnapshot>`.
- Produces `confirmUpdate() -> Promise<UpdateSnapshot>`.
- Produces `cancelUpdate() -> Promise<UpdateSnapshot>`.
- Produces `recoverPendingActivation() -> Promise<UpdateSnapshot>`.
- Emits `state-change`, `progress`, `update-available`, `notification`, and `error`.
- Uses one `operationPromise` so concurrent calls return the same operation result.

- [ ] **Step 1: Write state transition tests**

Cover check, no update, newer update, invalid remote result, manual/automatic behavior, repeated check deduplication, and repeated confirm deduplication:

```js
test('newer latest transitions to UPDATE_AVAILABLE once', async () => {
  const manager = makeUpdateManager({ latest: '0.1.1-rc.2', current: '0.1.0-rc.7' });
  const result = await manager.checkForUpdates();
  assert.equal(result.state, 'UPDATE_AVAILABLE');
  assert.equal(result.availableVersion, '0.1.1-rc.2');
});

test('concurrent confirmations share one installer operation', async () => {
  const first = manager.confirmUpdate();
  const second = manager.confirmUpdate();
  assert.equal(first, second);
  await first;
  assert.equal(installerCalls, 1);
});
```

Run: `node --test test/dsh-update-manager.test.js`

Expected: FAIL until the manager exists.

- [ ] **Step 2: Implement check state and deduplication**

Set `CHECKING`, call `registry.getLatest()`, compare against `runtimeManager.resolveCurrentRuntime().version`, and set `UP_TO_DATE`, `AHEAD_OF_LATEST`, or `UPDATE_AVAILABLE`. Automatic checks use `automaticCheckDone` once per manager instance; manual checks bypass that flag but share the check lock. Network errors set the operation result to `FAILED` without affecting the current Harness.

- [ ] **Step 3: Implement prepare/verify/promote flow**

`confirmUpdate()` transitions through `PREPARING`, `INSTALLING`, `VERIFYING`, and `READY_TO_APPLY`. Create `runtime/staging/<target>-<operation-id>`, call the exact-version installer, verify the staging tree, promote it, and retain the prepared descriptor. On failure, remove/mark staging, set `FAILED`, and do not call `processManager.stop()`.

- [ ] **Step 4: Implement owned and External apply paths**

For an owned process, transition `STOPPING_CURRENT`, call `processManager.stop()`, then `SWITCHING`, `runtimeManager.activateRuntime(prepared)`, `RESTARTING`, `processManager.start(prepared)`, and health-check the detected URL. For External ownership, call `runtimeManager.recordPending(prepared)`, set `WAITING_FOR_EXTERNAL_HARNESS`, and never call stop or kill APIs.

- [ ] **Step 5: Implement rollback and recovery chain**

On new-runtime crash, startup timeout, or health failure, transition `ROLLING_BACK`, stop only the newly owned failed process, call `runtimeManager.rollbackRuntime()`, start the returned previous/Bundled descriptor, and health-check it. Set `ROLLED_BACK` when recovery succeeds; set `FAILED` with a fatal message only when the recovery chain is exhausted.

- [ ] **Step 6: Implement pending activation and failure suppression**

On startup, `recoverPendingActivation()` validates pending locally, checks that no External Harness is currently owned, activates it, and clears pending only after a successful apply. Record failed versions with a timestamp and suppress automatic notifications for the same version for 24 hours.

- [ ] **Step 7: Run tests and commit**

Run: `node --test test/dsh-update-manager.test.js`

Expected: PASS for no update, update available, install failure, verification failure, successful apply, health-failure rollback, External ownership, pending activation, and repeated clicks.

```powershell
git add src/update/dsh-update-manager.js test/dsh-update-manager.test.js
git commit -m "feat: add DSH update state machine"
```

### Task 9: Integrate lifecycle, Boot Timeline, Tray, and notifications

**Files:**
- Modify: `src/lifecycle/app-lifecycle.js`
- Modify: `src/window/main-window.js`
- Modify: `src/tray/tray-manager.js`
- Modify: `src/utils/boot-timeline.js`
- Modify: `src/main.js` only if construction wiring is required
- Create: `test/app-lifecycle-update-flow.test.js`

**Interfaces:**
- `MainWindow` emits `harness-ready` after `did-finish-load` when `_page === 'harness'`.
- `TrayManager` accepts `getRuntimeVersion`, `getUpdateMenuItem`, `onCheckForUpdates`, and `onUpdate` callbacks.
- `AppLifecycle` exposes private orchestration methods `_scheduleUpdateCheck()`, `_openUpdateDialog()`, `_handleUpdateState(snapshot)`, and `_showUpdateMessage(message)`.

- [ ] **Step 1: Write lifecycle ordering and Tray tests**

Assert that update checking is scheduled only after Harness-ready and that Tray labels reflect state:

```js
test('update check starts after harness-ready mark', async () => {
  const timeline = [];
  const lifecycle = makeLifecycle({ mark: name => timeline.push(name) });
  lifecycle._onHarnessReady();
  await flushPromises();
  assert.ok(timeline.indexOf('harness_ui_ready') < timeline.indexOf('update_check_started'));
});

test('available update creates an update Tray item', () => {
  const menu = buildTrayTemplate({ version: '0.1.0-rc.7', update: '0.1.1-rc.2' });
  assert.equal(menu.some(item => item.label === '⬆ 更新到 0.1.1-rc.2'), true);
});
```

- [ ] **Step 2: Emit Harness-ready from MainWindow**

Keep existing diagnostics and navigation restrictions. In the existing `did-finish-load` listener, emit `harness-ready` only when the current page is `harness`; do not emit for splash or error pages.

- [ ] **Step 3: Wire runtime resolution and update manager**

Construct `RuntimeStateStore`, `DshRuntimeManager`, `NpmRegistryUpdateSource`, `NpmInstaller`, `RuntimeVerifier`, and `DshUpdateManager` in `AppLifecycle`. Run local self-heal and pending validation before `_boot()`, but do not make a Registry request until the Harness-ready event.

- [ ] **Step 4: Add Boot Timeline marks**

On Harness-ready, mark `harness_ui_ready`, then `update_check_scheduled`, schedule `checkForUpdates({ manual: false })` with `queueMicrotask`/`setImmediate`, and mark `update_check_started` / `update_check_finished` around the operation. Do not await the check from `_boot()`.

- [ ] **Step 5: Add Tray update actions and Electron Notification**

Refresh Tray on every update-manager state change. Show the Desktop-owned current Runtime version, `检查更新`, and `⬆ 更新到 <version>` only in `UPDATE_AVAILABLE`/prepared states. On `notification`, show one Electron `Notification` per version per process. Automatic failures do not open a dialog.

- [ ] **Step 6: Run tests and commit**

Run: `node --test test/app-lifecycle-update-flow.test.js test/url-detector.test.js`

Expected: PASS; Boot Timeline proves `update_check_started` is after Harness UI readiness.

```powershell
git add src/lifecycle/app-lifecycle.js src/window/main-window.js src/tray/tray-manager.js src/utils/boot-timeline.js src/main.js test/app-lifecycle-update-flow.test.js
git commit -m "feat: expose runtime updates through lifecycle and tray"
```

### Task 10: Add local Update Dialog and safe IPC

**Files:**
- Create: `src/window/update-dialog.js`
- Create: `src/window/update-preload.js`
- Create: `renderer/update.html`
- Create: `renderer/update.css`
- Modify: `src/lifecycle/app-lifecycle.js`
- Create: `test/update-dialog.test.js`

**Interfaces:**
- `UpdateDialog({ iconPath, onGetState, onConfirm, onCancel, onOpenLog, logger })`.
- `UpdateDialog.show(snapshot)`, `.update(snapshot)`, `.close()`, `.destroy()`.
- Preload API: `window.dshUpdate.getState()`, `.confirmUpdate()`, `.cancelUpdate()`, `.openUpdateLog()`.

- [ ] **Step 1: Write IPC allow-list tests**

Use a fake `ipcRenderer` and assert only the four named methods are exposed; assert no `spawn`, `exec`, filesystem path write, or arbitrary channel is present:

```js
test('update preload exposes only minimal intent API', () => {
  const api = loadPreloadWithFakeContextBridge();
  assert.deepEqual(Object.keys(api).sort(), ['cancelUpdate', 'confirmUpdate', 'getState', 'openUpdateLog']);
});
```

- [ ] **Step 2: Implement local dialog markup and style**

Create Chinese localized markup for current version, target version, warning text, spinner/stage text, and buttons `稍后` / `更新并重启`. Use only local CSS and the existing icon asset. Never load a remote URL and never call `executeJavaScript` against the Harness page.

- [ ] **Step 3: Implement secure preload and main-process handlers**

Use `contextBridge.exposeInMainWorld('dshUpdate', ...)` with four fixed `ipcRenderer.invoke` channels. Register handlers in `UpdateDialog`/`AppLifecycle` that call injected callbacks; renderer input cannot select a package, path, command, version, or filesystem operation.

- [ ] **Step 4: Connect state/progress/result updates**

When Tray update is clicked, open the dialog. Render state transitions and real stages without fake percentages. On success, show the new version and close after the Harness page is loaded; on rollback, show the recovered version and log path; on manual check failure, show the local retry message.

- [ ] **Step 5: Run tests and commit**

Run: `node --test test/update-dialog.test.js`

Expected: PASS for API allow-list, confirmation routing, cancellation, progress updates, and no DOM injection.

```powershell
git add src/window/update-dialog.js src/window/update-preload.js renderer/update.html renderer/update.css src/lifecycle/app-lifecycle.js test/update-dialog.test.js
git commit -m "feat: add desktop-owned DSH update dialog"
```

### Task 11: Add build-time Bundled Runtime and packaging configuration

**Files:**
- Create: `scripts/prepare-bundled-runtime.js`
- Modify: `electron-builder.yml`
- Modify: `.gitignore`
- Modify: `package.json`
- Create: `test/prepare-bundled-runtime.test.js`

**Interfaces:**
- Produces `prepareBundledRuntime({ outputRoot, npmCommand, version, spawnProcess, logger }) -> Promise<{ rootPath, version }>`.
- Default pinned fallback version is `0.1.0-rc.7`, overridable only at build time by `DSH_BUNDLED_VERSION`.

- [ ] **Step 1: Write build-script tests**

Assert exact package install arguments and generated package metadata:

```js
const result = await prepareBundledRuntime({ outputRoot, npmCommand: 'npm.cmd', version: '0.1.0-rc.7', spawnProcess: fakeNpmInstall });
assert.equal(result.version, '0.1.0-rc.7');
assert.equal(fakeArgs.includes('@deepseek-ai/dsh@0.1.0-rc.7'), true);
assert.equal(fs.existsSync(path.join(outputRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')), true);
```

- [ ] **Step 2: Implement isolated build preparation**

Remove only the exact generated `build/bundled-runtime` directory, create a minimal private package, run npm install with `--prefix`, `--no-audit`, `--no-fund`, and the exact package/version, then validate the resulting DSH package metadata/bin before returning. Do not read or modify the Desktop package lock and do not change npm config.

- [ ] **Step 3: Configure electron-builder**

Add:

```yaml
extraResources:
  - from: build/bundled-runtime
    to: bundled-runtime
    filter:
      - '**/*'
```

Keep `asar: true`; the DSH tree must be in `resources/bundled-runtime`, not in `app.asar`.

- [ ] **Step 4: Run build-preparation tests and commit**

Run: `node --test test/prepare-bundled-runtime.test.js`

Expected: PASS.

```powershell
git add scripts/prepare-bundled-runtime.js electron-builder.yml .gitignore package.json test/prepare-bundled-runtime.test.js
git commit -m "build: package immutable DSH fallback runtime"
```

### Task 12: Add full unit and integration coverage for failure paths

**Files:**
- Extend: `test/dsh-runtime-manager.test.js`
- Extend: `test/dsh-update-manager.test.js`
- Extend: `test/npm-installer.test.js`
- Extend: `test/runtime-verifier.test.js`
- Create: `test/update-integration.test.js`

**Interfaces:**
- Uses the exact injection contracts from Tasks 2–10.
- Produces a deterministic integration harness with fake RuntimeManager, ProcessManager, Installer, Verifier, Registry, and HealthChecker.

- [ ] **Step 1: Add the required matrix cases**

Implement tests for:

```text
No Update
Update Available
Network Timeout
Install Failure
Verification Failure
Successful Apply
Health Failure Rollback
Bundled Fallback
External Harness
Pending Activation
Repeated Click
Corrupt State
Offline Startup
Stale Staging
```

- [ ] **Step 2: Add the highest-risk rollback integration test**

Use this exact sequence:

```text
installer -> success
verifier -> success
runtimeManager.promote -> managed-new
processManager.ownsHarness -> true
processManager.stop -> success
processManager.start(new) -> success
healthChecker.waitUntilReady(new) -> failure
runtimeManager.rollbackRuntime -> bundled-old
processManager.start(old) -> success
healthChecker.waitUntilReady(old) -> success
```

Assert final state `ROLLED_BACK`, pointer `bundled-old`, and that the old Harness is usable.

- [ ] **Step 3: Add External ownership integration test**

Set `processManager.ownsHarness()` to false, make install and verification succeed, call `confirmUpdate()`, and assert `stopCalls === 0`, final state `WAITING_FOR_EXTERNAL_HARNESS`, and pending version equals the target.

- [ ] **Step 4: Run all tests and commit**

Run: `npm test`

Expected: PASS with no real Registry request and no real npm installation during unit tests.

```powershell
git add test
git commit -m "test: cover DSH runtime update recovery paths"
```

### Task 13: Run real Registry, runtime, and packaging validation

**Files:**
- Modify: `docs/runtime/dsh-runtime-update-architecture.md` only if implementation details differ from the design.
- Create: `docs/runtime/dsh-runtime-update-verification.md`
- Generated and ignored: `build/bundled-runtime/`, `dist/`, and installed user-data runtime directories.

**Interfaces:**
- Produces a verification record containing command, timestamp, result, and evidence path for each check.

- [ ] **Step 1: Run static and unit verification**

Run:

```powershell
Get-ChildItem src,scripts,test -Recurse -File -Filter *.js | ForEach-Object { node --check $_.FullName }
npm test
```

Expected: every JavaScript file passes syntax checking and all tests pass.

- [ ] **Step 2: Run one real npm Registry check**

Run the production source once:

```powershell
node -e "const {NpmRegistryUpdateSource}=require('./src/update/npm-registry-update-source'); new NpmRegistryUpdateSource({}).getLatest().then(console.log).catch(e=>{console.error(e);process.exit(1)})"
```

Record HTTP result, remote version, integrity presence, and duration. Do not install or alter npm configuration in this step.

- [ ] **Step 3: Prepare and inspect Bundled Runtime**

Run:

```powershell
$env:DSH_BUNDLED_VERSION='0.1.0-rc.7'
npm run prepare:bundled-runtime
```

Verify `build/bundled-runtime/node_modules/@deepseek-ai/dsh/package.json` has the expected name/version/bin and that the generated tree is outside source `node_modules` and outside `app.asar`.

- [ ] **Step 4: Build unpacked and inspect app.asar**

Run:

```powershell
npm run pack
```

Verify:

```text
dist/win-unpacked/DeepSeek Harness Desktop.exe exists
dist/win-unpacked/resources/app.asar contains updater source, dialog, and preload
dist/win-unpacked/resources/bundled-runtime contains the DSH package
app.asar does not contain node_modules/@deepseek-ai/dsh
```

- [ ] **Step 5: Build Setup.exe**

Run:

```powershell
npm run dist
```

Record the exact generated Setup.exe path and verify it is an NSIS artifact.

- [ ] **Step 6: Run installed Windows smoke tests**

Install the generated Setup.exe into a temporary user-selected directory and verify:

1. No-update path: Harness opens, Registry check runs after UI readiness, no update notification appears.
2. Simulated update path: injected fixture reports a newer version and Tray/dialog become visible.
3. Offline path: Harness still starts and automatic check only logs failure.
4. Corrupt state path: invalid `runtime-state.json` falls back to Bundled.
5. Stale staging path: a 24-hour-old unrelated staging directory is cleaned while current/previous/pending remain.
6. External Harness path: an externally started Harness is never stopped.
7. Repeated click path: one installer operation is observed.

- [ ] **Step 7: Record Boot Timeline evidence**

Capture `logs/boot.log` and prove the order:

```text
window_visible
harness_ui_ready
update_check_scheduled
update_check_started
update_check_finished
```

The update check must not appear before first paint or Harness bootstrap.

- [ ] **Step 8: Record results and commit verification docs**

Write every requested test as `PASS`, `FAIL`, or `BLOCKED` with the exact reason and artifact path. Do not claim installed or rollback coverage unless the evidence exists.

```powershell
git add docs/runtime/dsh-runtime-update-architecture.md docs/runtime/dsh-runtime-update-verification.md
git commit -m "docs: record DSH runtime updater verification"
```

### Task 14: Final review and handoff

**Files:**
- Review: all changed source, tests, build config, and runtime docs.
- Modify: only files with a demonstrated issue found during verification.

**Interfaces:**
- Final implementation leaves `git status` understandable and excludes generated `dist/`, `build/bundled-runtime/`, runtime logs, and user-data files.

- [ ] **Step 1: Inspect final diff and forbidden patterns**

Run:

```powershell
git status --short
git diff --check
git diff --stat HEAD~14..HEAD
Select-String -Path src,scripts,renderer -Pattern 'taskkill\s+/im|npm update|npm install -g|executeJavaScript|document\.querySelector|appendChild|MutationObserver' -SimpleMatch:$false
```

Review every match manually. The updater must not use global taskkill, shell interpolation, or DSH DOM injection.

- [ ] **Step 2: Run verification-before-completion**

Read and follow `superpowers:verification-before-completion`. Re-run relevant commands after any final fix, including `npm test`, `npm run pack`, and every installed-build check claimed in the final report.

- [ ] **Step 3: Produce the final report**

Report the real Bundled, Managed Current, and npm Latest versions; actual userData paths; state machine; update pipeline; atomic switching; rollback evidence; External Harness behavior; Tray/Notification/Dialog behavior; Boot Timeline ordering; each required test result; installed build and Setup.exe paths; app.asar/resource inspection; and known limitations.
