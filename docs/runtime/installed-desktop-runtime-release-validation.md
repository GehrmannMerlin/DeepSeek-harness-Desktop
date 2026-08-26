# DeepSeek Harness Desktop — Installed Desktop Runtime Update Release Validation

> Validation date: 2026-08-24 / 2026-08-25 (Asia/Shanghai)  
> Branch: `codex/dsh-runtime-updater`  
> Overall status: **BLOCKED**  
> Merge status: **DO NOT MERGE**

## 1. Overall Status

Overall Release Gate remains **BLOCKED**.

The installed Desktop OLD → NEW update path passed through real Electron, real renderer IPC, real artifact download/extraction/verification/promotion, owned Harness stop/restart, NEW health, and restart persistence. The release cannot be promoted to PASS because:

1. The installation-level rollback injection did not reach `ROLLED_BACK`; the fallback pointer was restored, but the controlled port blocker also prevented the fallback Harness from becoming healthy, so the final UpdateManager state was `FAILED`.
2. External Harness and pending-activation recovery were not executed in this round.
3. Production Runtime Index hosting is not configured; only a task-local HTTP fixture was used.
4. The exact Update Operation ID was not persisted in the release evidence after success, so the required operation-level audit trail is incomplete.

## 2. Branch

- Branch: `codex/dsh-runtime-updater`
- No merge, rebase, or main-branch checkout was performed.
- The worktree was already dirty at task start; pre-existing changes were preserved.

## 3. Version Pair

| Role | Version | Evidence |
|---|---|---|
| OLD bundled runtime | `0.1.0-rc.7` | Installed `resources/bundled-runtime/runtime-manifest.json`; source revision `99f6f02fe` |
| NEW verified runtime | `0.1.1-rc.2` | Factory manifest and installed managed manifest; source revision `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| npm latest observed | `0.1.1-rc.2` | npm registry metadata queried on 2026-08-24 |
| Official source mapping | `dsh-v0.1.1-rc.2` → `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | `git ls-remote` against the official `deepseek-ai/deepseek-harness` repository |

The NEW factory used Node `24.18.0` and pnpm `11.7.0`. The packaged Desktop itself reported Node `24.18.1` and Electron `43.4.0`.

## 4. NEW Runtime Factory

Factory output root:

`C:\Users\韩吉衍\AppData\Local\Temp\dsh-runtime-factory\route-c-0.1.1-rc.2\factory-output-2`

NEW artifact:

- File: `dsh-runtime-0.1.1-rc.2-win32-x64.zip`
- Size: `404,668,424` bytes
- SHA-256: `65bec268bb49f2cea59c5256dad17a6580f6306859c36669a80e7854b4912bab`
- Frozen file count: `55,363`
- Platform/architecture: `win32/x64`
- Manifest CLI entry: `node_modules/@deepseek-ai/dsh/lib/bin.js`
- Source revision: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Immutable: `true`

Factory Acceptance passed: package identity, CLI version, Web startup, HTTP health, native dependency smoke, archive verification, and independent extraction smoke. The first factory run exposed a real health-check signature mismatch (`globalThis["__DSH_BOOT__"]` versus the older literal matcher); a regression test was added before the minimal checker fix, and the second factory run passed.

The task-local `runtime-index.json` pointed to this exact artifact metadata. It was served through a local fixture only; this is not a production hosting claim.

## 5. Installed App

Final isolated install used for the counted E2E:

`C:\Users\韩吉衍\AppData\Local\Temp\dsh-installed-release-e2e-20260824-2239`

The installed OLD manifest was verified before launch:

- Version: `0.1.0-rc.7`
- Source revision: `99f6f02fe`
- Node: `24.18.0`
- pnpm: `11.7.0`
- Files: `55,796`
- Installed directory size: `1,316,526,623` bytes
- `resources/bundled-runtime/runtime-manifest.json`: present

Isolated Electron userData:

`C:\Users\韩吉衍\AppData\Local\Temp\dsh-release-e2e-userdata-20260824-2245`

The test-only userData override is enabled only when `DSH_RELEASE_E2E=1` and an absolute `DSH_RELEASE_E2E_USER_DATA_DIR` is supplied. Normal production startup behavior is unchanged.

## 6. Real Cross-Version Update

**Result: PASS for the successful OLD → NEW path.**

Evidence from the installed Desktop log:

- OLD process started from `resources/bundled-runtime/.../@deepseek-ai/dsh/lib/bin.js web`.
- Initial OLD health passed in `3,246 ms`.
- The Desktop boot timeline recorded `harness_ui_ready` before `update_check_started`.
- Verified update `0.1.1-rc.2` was discovered.
- Artifact staging grew to the full extracted NEW runtime; final runtime root contained `55,365` files and `1,645,711,321` bytes before later rollback setup.
- OLD Harness PID `34708` was stopped by the owned process manager.
- NEW Harness PID `33420` started from:

  `...\dsh-release-e2e-userdata-20260824-2245\runtime\versions\0.1.1-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js web`

- NEW health passed in `61 ms`.
- Renderer IPC completion was logged as `release_e2e_update_confirm_finished state=SUCCESS`.
- The managed state was persisted with `current.kind=managed`, `current.version=0.1.1-rc.2`, and `pending=null`.

The exact Update Operation ID was not retained in the final log/state snapshot after the manager clears it on success. This is an auditability gap and is listed as a blocker even though the lifecycle result was successful.

## 7. Update UI / IPC

**Result: PASS for the real installed dialog IPC path.**

The test-only driver did not call `DshUpdateManager.checkForUpdates()` or `confirmUpdate()` directly. It:

1. Observed the real `UPDATE_AVAILABLE` state event.
2. Opened the real `UpdateDialog` through the lifecycle path.
3. Executed `window.updateApi.confirmUpdate()` in the actual update-dialog renderer.
4. Let the existing preload `ipcRenderer.invoke('dsh-update:confirm')` and the existing trusted `ipcMain.handle` path perform the operation.

The driver is inert unless `DSH_RELEASE_E2E=1`. Focused driver tests passed `6/6` across the new driver, userData override, and health signature regression.

Tray click automation was not used; the update dialog path was exercised directly through the permitted minimal renderer driver.

## 8. npm Usage

**Result: PASS for the verified artifact updater.**

- Production `AppLifecycle` does not construct `NpmInstaller` for updates.
- The real artifact E2E asserted that the npm installer was not called.
- Installed process command lines show direct Node execution of the verified runtime CLI.
- The explicit artifact test passed with `DSH_REAL_RUNTIME_ARTIFACT` set to the real OLD factory ZIP:

  `real artifact HTTP download verifies and applies without npm installer` — PASS, 1 test, 82.2 seconds.

## 9. Runtime State

After successful update:

```json
{
  "schemaVersion": 1,
  "current": {
    "relativePath": "0.1.1-rc.2",
    "kind": "managed",
    "version": "0.1.1-rc.2"
  },
  "previous": null,
  "pending": null,
  "failedVersions": {},
  "lastNotifiedVersion": null
}
```

The managed manifest recorded the exact NEW identity and source revision. During the controlled rollback attempt, the fallback pointer was restored to bundled `0.1.0-rc.7` and the failed NEW version was recorded in `failedVersions`.

## 10. Restart Persistence

**Result: PASS.**

After successful update, the isolated Desktop was terminated and relaunched with the same userData. The second boot did not select the bundled runtime. It directly started:

`...\runtime\versions\0.1.1-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js web`

The second boot reached `harness_ui_ready`, completed the update check, and passed health in `1,631 ms`. No second update was available because the managed NEW version was already current.

The Desktop termination used for this persistence check was limited to the isolated E2E Desktop PID and its child tree; no external Harness was in scope for this check.

## 11. Rollback

**Result: BLOCKED / FAIL — not a release-grade rollback PASS.**

Controlled failure setup:

- The isolated state was reset to a valid bundled starting point without modifying the real NEW artifact.
- The malformed user credentials issue was isolated using a task-local `DSH_HOME` rather than touching the user’s existing `.dsh` files.
- OLD bundled Harness PID `28112` started healthy.
- A test-only blocker PID `3156` waited for OLD PID `28112` to stop, then occupied `127.0.0.1:3080` with a non-DSH HTML response.

Observed rollback sequence:

1. OLD Harness exited during the owned update apply.
2. Managed NEW PID `13268` was started and exited without exposing a Harness URL because the controlled port was occupied.
3. The manager attempted the bundled fallback; fallback PID `18684` also exited because the same controlled blocker was still active.
4. The final renderer result was `state=FAILED`, not `ROLLED_BACK`.
5. The persisted pointer was restored to bundled `0.1.0-rc.7`, with `failedVersions["0.1.1-rc.2"]` recorded.

This proves the failure path and pointer restoration were exercised, but it does not prove a healthy rollback. A follow-up controlled failure must release the blocker at the correct boundary or inject a smaller post-activation health failure so that the previous/bundled runtime can become healthy and the manager can reach `ROLLED_BACK`.

## 12. Process Ledger

| Process / resource | PID | Result / ownership |
|---|---:|---|
| Final NSIS installer | `33464` | Exited after isolated install completed |
| Successful installed Desktop | `34764` | E2E-owned; stopped for persistence relaunch |
| Successful OLD Harness | `34708` | E2E-owned; stopped by update manager |
| Successful NEW Harness | `33420` | E2E-owned; started from managed `0.1.1-rc.2`, health PASS |
| Persistence relaunch Desktop | `24500` | E2E-owned; stopped before rollback setup |
| Rollback OLD Harness | `28112` | E2E-owned; stopped by update manager |
| Rollback NEW attempt | `13268` | E2E-owned; exited under controlled port failure |
| Rollback fallback attempt | `18684` | E2E-owned; exited while blocker remained |
| Rollback Desktop | `9672` | E2E-owned; stopped during cleanup |
| Port blocker | `3156` | Test-owned; stopped during cleanup |

The task-local HTTP fixture and all E2E processes were stopped after validation. No listener remained on `3080`; only normal Windows `TIME_WAIT` entries were observed.

## 13. External Harness

**Result: NOT RUN — BLOCKED.**

The successful lifecycle used an owned Harness, as required for the update-apply path. A separate external Harness ownership scenario was not executed in this round, so the Desktop’s no-kill/no-restart behavior for an external owner lacks installed-level evidence.

## 14. Pending Recovery

**Result: NOT RUN — BLOCKED.**

No installed-level pending activation failure/restart/recovery matrix was run. The existing unit suite covers pending activation and recovery contracts, but that is not a substitute for the requested installed Desktop evidence.

## 15. Tests

Default regression:

- Command: `npm test`
- Tests: `138`
- Pass: `137`
- Fail: `0`
- Skip: `1`
- The single skip is the large real-artifact test under its required environment gate.

Explicit real artifact test:

- Command: `DSH_REAL_RUNTIME_ARTIFACT=<real rc.7 ZIP> node --test test/runtime-artifact-update-e2e.test.js`
- Pass: `1`
- Fail: `0`
- Skip: `0`
- Duration: approximately `82.2 s`

Focused new/regression tests:

- Driver/userData/health checks: `6/6` pass.

## 16. Pack / Dist

Using the verified OLD rc.7 artifact as the bundled input:

- `npm run pack`: PASS (final post-adjustment run)
- `npm run dist`: PASS (final post-adjustment run)
- Electron Builder: `26.15.3`
- Electron: `43.4.0`
- Windows target: `win32/x64`

The test-only launcher was adjusted to support isolated `DSH_HOME`; the final `pack`/`dist` rerun was completed after that adjustment.

## 17. Final NSIS

Final installer produced after the launcher-only adjustment:

- Path: `D:\Develop\DeepSeek Agent\DeepSeek Agent Desktop\.worktrees\dsh-runtime-updater\dist\DeepSeek Harness Desktop Setup 1.0.0.exe`
- Size: `320,197,071` bytes
- SHA-256: `090BA1B2B902EDC2DD2850CC536A9236E9E7C81C7B0CD3ED3527FF9AF0B35AD1`

The isolated install used the same final build content before the launcher-only adjustment; the final post-adjustment NSIS artifact has now been regenerated and hash-verified. The launcher is external test tooling and is not packaged into the Electron app.

Final post-adjustment isolated install smoke:

- Install path: `C:\Users\韩吉衍\AppData\Local\Temp\dsh-installed-release-e2e-final-20260825`
- Installer PID: `10700`, exited normally
- Installed files: `55,795`
- Installed size: `1,316,525,865` bytes
- OLD manifest: present, `0.1.0-rc.7`, immutable, source revision `99f6f02fe`
- Installed CLI `--version`: exit `0`, output `0.1.0-rc.7`
- Desktop EXE: present

## 18. Production Hosting

**Result: BLOCKED.**

The installed E2E used a task-local HTTP fixture at `127.0.0.1` to serve the verified index and NEW ZIP. This validates the client download and verification path only. No production Runtime Index or artifact hosting endpoint was created or claimed in this task.

The local fixture is not a public release channel and must not be used as a production hosting conclusion.

## 19. Merge Readiness

**Not merge-ready.**

The branch remains unmerged. The rollback gate, external Harness gate, pending recovery gate, operation-ID evidence, hosting gate, and final post-adjustment package record are incomplete or blocked.

## 20. Public Release Readiness

**Not publicly release-ready.**

The Runtime/Artifact Gate is substantially passing, and the core owned installed update/restart path is passing, but the overall Release Gate is blocked by the failures and omissions listed above. No GitHub Release, production index publication, or external announcement was made.

## 21. Remaining Blockers

1. Make the installed controlled rollback reach `ROLLED_BACK` with a healthy fallback, then verify post-rollback Desktop restart.
2. Execute installed External Harness ownership E2E and confirm the Desktop never kills or restarts the external process.
3. Execute installed pending-activation recovery E2E across Desktop exit/restart.
4. Persist or capture the exact Update Operation ID in release evidence.
5. Configure and independently verify production Runtime Index/artifact hosting, or keep the Production Distribution Hosting Gate explicitly blocked.
6. Keep the user’s malformed `.dsh/.credentials.yaml` outside the test scope; repeatable E2E must continue using an isolated task-local `DSH_HOME` or an equivalent supported fixture.

Until all blockers are resolved and re-verified, the correct release decision is **BLOCKED — DO NOT MERGE**.

Sections 13–21 above are the historical pre-closure snapshot. Sections 22–24
below supersede its provisional gate decisions and record the final closure
rerun; the historical failed rollback and the earlier installer hash remain
preserved for auditability.

## 22. Final closure rerun — installed rollback

The final NSIS output used for this closure was:

- Path: `D:\Develop\DeepSeek Agent\DeepSeek Agent Desktop\.worktrees\dsh-runtime-updater\dist\DeepSeek Harness Desktop Setup 1.0.0.exe`
- Size: `320,198,438` bytes
- SHA-256: `3A322F0A446757E4E2A4A834F0F6B562D012D78E10A63F9885160E5BADE25685`

It was installed into the isolated directory
`C:\Users\韩吉衍\AppData\Local\Temp\dsh-final-installed-20260825-111614\install`.
The installed bundled manifest reported OLD `0.1.0-rc.7`, source revision
`99f6f02fe`, Node `24.18.0`, pnpm `11.7.0`, and immutable `true`; the installed
CLI returned `0.1.0-rc.7` with exit code `0`.

The final installed rollback root was
`C:\Users\韩吉衍\AppData\Local\Temp\dsh-final-installed-rollback-20260825-112438`.
The real update reached `ROLLED_BACK` with operation ID
`update-1787628284584-1`. The NEW runtime was intentionally failed only at the
version-scoped post-activation health decision; the bundled OLD fallback
started and passed health. The final state was bundled OLD `0.1.0-rc.7`,
`pending: null`, and `failedVersions["0.1.1-rc.2"]` recorded. A second launch
with the same userData preserved that state and safely skipped the update when
the hosting index URL was absent.

## 23. Final closure rerun — External Harness ownership and Pending Recovery

The isolated evidence root was
`C:\Users\韩吉衍\AppData\Local\Temp\dsh-final-external-pending-20260825-114000`.

An independently started installed bundled CLI process, PID `16032`, passed
the real health checker and owned `127.0.0.1:3080`. The installed Desktop
recorded `existing_harness_check_finished state=harness`, reused the external
URL, and reached `WAITING_FOR_EXTERNAL_HARNESS`. On normal quit it logged
`external harness left running`. The exact PID remained alive after Desktop
exit and was the only matching DSH web process; it was subsequently stopped
separately with exact task-owned `taskkill /PID 16032 /T /F`.

The same userData was then relaunched after the external process stopped. The
persisted pending target was recovered: the OLD runtime passed health, managed
NEW `0.1.1-rc.2` PID `34784` started and passed health, and the correlated
operation `update-1787628869680-1` ended `SUCCESS`. The follow-up check
operation `update-1787628874379-2` ended `UP_TO_DATE`. Final state was managed
NEW `0.1.1-rc.2`, `pending: null`, empty `failedVersions`, and no remaining
Desktop-owned runtime process or `3080` listener after normal shutdown.

## 24. Final decision boundary

FEATURE BRANCH MERGE READY: YES

PUBLIC RELEASE READY: NO

The code, focused tests, installed lifecycle evidence, audit correlation, and
client-side hosting boundary are ready for feature-branch review. Public
release remains blocked because no production Runtime Index or artifact
hosting endpoint was configured or deployed. The task-local fixture is test
evidence only and is not a release channel.

## 25. Stage 2 real Production HTTPS validation (2026-08-26)

This section records the final installed-EXE run and supersedes the earlier
production-hosting limitation for this stage; prior sections remain historical.

### Final installed package

- Installer: `D:\Develop\DeepSeek Agent\DeepSeek Agent Desktop\.worktrees\dsh-factory-performance-closure\dist\DeepSeek Harness Desktop Setup 1.0.0.exe`
- Size: `320199558` bytes
- SHA-256: `EBA64C21C52B32B7B31CD9A7566B6B084E8440563A957432B0DD880A88AB8DDA`
- Install root: `C:\Users\韩吉衍\AppData\Local\Temp\dsh-stage2-installed-20260826`
- Installed manifest: bundled `@deepseek-ai/dsh@0.1.0-rc.7`, win32/x64,
  source revision `99f6f02fe`; installed CLI returned `0.1.0-rc.7`.
- Installer was used only as a local validation artifact. It was not publicly
  published and no Windows signing configuration was added.

### Production update

Evidence root:
`C:\Users\韩吉衍\AppData\Local\Temp\dsh-stage2-e2e-final-proxy2-20260826`.
The final launch used real Electron, real renderer IPC, the production stable
URL, isolated userData/DSH_HOME, and the existing normal lifecycle quit seam.

Operation `update-1787734603256-1` recorded:

- `UPDATE_AVAILABLE`, old bundled `0.1.0-rc.7` → verified `0.1.1-rc.2`;
- stable HTTPS index accepted within the 15,000 ms bounded timeout;
- normal Release redirect HTTP 302, `github.com` →
  `release-assets.githubusercontent.com`;
- final response HTTP 200, downloaded `69086249/69086249` bytes in `21182` ms;
- SHA-256 exactly
  `5f6efe25a0704da248e7ac2a6d34b6be4a5560b2c3cdebebc5d567c5edc4d837`;
- extraction, runtime verification, promotion, old Harness stop, new Harness
  start from `userdata/runtime/versions/0.1.1-rc.2`, and health success in 74 ms;
- renderer IPC `release_e2e_update_confirm_finished state=SUCCESS`;
- operation result `SUCCESS`, duration `109589` ms.

Final persisted state:

```json
{
  "current": { "relativePath": "0.1.1-rc.2", "kind": "managed", "version": "0.1.1-rc.2" },
  "previous": null,
  "pending": null,
  "failedVersions": {}
}
```

### Restart persistence

The same installed EXE and userData were relaunched. The second process
started the managed rc.2 CLI, passed health, and operation
`update-1787734841463-1` ended `UP_TO_DATE` in 6,203 ms. No artifact download
was logged. Normal quit left no task-owned Desktop process and no port 3080
listener.

### Rollback and restore matrix

1. Official rollback run
   [32950819410](https://github.com/GehrmannMerlin/DeepSeek-harness-Desktop/actions/runs/32950819410)
   succeeded and stable readback became rc.7.
2. Managed rc.2 against stable rc.7 remained managed rc.2 and ended
   `UP_TO_DATE` without downgrade/download.
3. Fresh OLD bundled rc.7 against stable rc.7 ended `UP_TO_DATE` without
   download.
4. Official restore run
   [32951216611](https://github.com/GehrmannMerlin/DeepSeek-harness-Desktop/actions/runs/32951216611)
   succeeded; final stable HTTP 200 readback returned exact rc.2 identity.

### Production fixes discovered by the run

The first real attempt exposed a cold-index tail beyond the old 4-second
timeout; the measured 6.097-second sample justified the 15-second bounded
default. The next attempt exposed the normal 302 Release redirect. The final
downloader follows at most five HTTP/HTTPS redirects and streams through Node
24 fetch/`Readable.fromWeb` while preserving size/SHA verification and progress
logs. No npm/pnpm installer was invoked; the standalone real artifact HTTP E2E
also passed with installer calls equal to zero.

### Current decision

Installed OLD → NEW Production HTTPS update, extraction, verification,
promotion, health, restart persistence, rollback, restore, and zero-client-
installer gate: **PASS**.

Public Desktop installer publication: **NOT PERFORMED**.

Windows code signing: **NOT CONFIGURED**.
