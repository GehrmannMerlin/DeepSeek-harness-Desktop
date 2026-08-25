# Final Release Gate Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the installed Runtime lifecycle release gates for rollback, external ownership/pending recovery, operation audit, and production hosting configuration without changing the established artifact architecture.

**Architecture:** Preserve `DshRuntimeManager`, `RuntimeStateStore`, `HarnessProcessManager`, `HarnessHealthChecker`, verified artifact download/verification, and the existing update state machine as the owners of their current responsibilities. Add only a test-environment, version-scoped one-shot health-failure seam; emit structured operation events through the existing logger; and make an absent/invalid/unreachable verified index a safe update-source condition while leaving normal startup unchanged.

**Tech Stack:** Windows Electron, Node.js `node:test`, JavaScript CommonJS modules, local HTTP fixtures, real packaged runtimes, Electron Builder NSIS.

**Spec:** User-provided `pasted-text.txt` — `DeepSeek Harness Desktop / Final Release Gate Closure`.

## Global Constraints

- Do not modify the Runtime Factory, Verified Artifact format, Downloader architecture, DSH Web, client-side npm resolution, or production release infrastructure.
- Do not touch the user’s real `C:\Users\\<user>\\.dsh` or repair credentials; every E2E uses task-owned install, userData, and `DSH_HOME` directories.
- Rollback fault injection must require both `DSH_RELEASE_E2E=1` and `DSH_RELEASE_E2E_FAIL_HEALTH_VERSION=<target>`; it must be target-version-only and one-shot.
- External Harnesses must never be stopped, restarted, replaced, or killed by Desktop.
- No broad process kills; only task-owned PIDs/trees may be terminated.
- Do not store historical `operationId` values in `runtime-state`; use the existing structured logger.
- Missing production Hosting must disable/skip verified updates safely without breaking startup, bundled/managed runtime use, Tray, or normal quit.
- No latest/next update channel, CI automation, GitHub Release automation, macOS/Linux/ARM, Electron updater, or artifact-size work.

## File Map

- Create `docs/runtime/final-release-gate-closure.md`: live gate status, evidence, timeline, and final decisions.
- Modify `docs/runtime/installed-desktop-runtime-release-validation.md`: append this round’s rollback, external/pending, audit, hosting, build, and smoke evidence without changing the historical failure section.
- Modify `src/health/harness-health-checker.js`: add a test-only one-shot version/phase failure seam while preserving the real checker by default.
- Modify `src/update/dsh-update-manager.js`: pass runtime/phase context to the health seam and emit correlated operation audit events for all required transitions and completion results.
- Modify `src/lifecycle/app-lifecycle.js` and `src/main.js`: wire the test-only health seam and safe source configuration behavior without exposing a user-controlled backdoor.
- Modify `src/update/verified-runtime-update-source.js`: distinguish missing configuration from malformed/unreachable configured sources and expose a safe unavailable result to the lifecycle.
- Modify `test/harness-health-checker.test.js`, `test/dsh-update-manager.test.js`, and `test/verified-runtime-update-source.test.js`: focused RED/GREEN tests for fault injection, audit chains, and hosting boundary behavior.
- Modify or add `scripts/release-e2e-*.js` and `test/*external*/*pending*` only as needed for one combined real installed External/Pending scenario, with process identity ledgers.
- Add/update test helpers only when they remain task-owned and deterministic; do not add product features or private-method-only recovery paths.

### Task 1: Establish final gate evidence document and capture rollback root cause

**Files:**
- Create: `docs/runtime/final-release-gate-closure.md`
- Modify: `docs/runtime/installed-desktop-runtime-release-validation.md`

- [ ] **Step 1: Create the initial blocked gate matrix** with `Rollback Gate: BLOCKED`, `External / Pending Gate: BLOCKED`, `Operation Audit Gate: BLOCKED`, and `Hosting Boundary Gate: UNKNOWN`.
- [ ] **Step 2: Append the exact prior rollback timeline** from `application.log`, `boot.log`, and `harness.log`, including NEW and fallback PIDs, `EADDRINUSE`, and the blocker’s lifetime.
- [ ] **Step 3: State the evidence-backed conclusion**: the previous port-blocker test affected both target and fallback, so it is an invalid recoverability test; do not label it Rollback PASS or implementation FAIL.
- [ ] **Step 4: Run `git diff --check`** and record any pre-existing whitespace findings without formatting historical evidence.

### Task 2: Add and prove the minimal one-shot health-failure seam

**Files:**
- Modify: `src/health/harness-health-checker.js`
- Modify: `src/update/dsh-update-manager.js`
- Modify: `src/lifecycle/app-lifecycle.js`
- Modify: `src/main.js`
- Test: `test/harness-health-checker.test.js`
- Test: `test/dsh-update-manager.test.js`

- [ ] **Step 1: Write RED tests** proving that production mode is unchanged, an unrelated version is unaffected, the target version fails only during `post_activation_update_health`, and the failure is consumed once before real health resumes.
- [ ] **Step 2: Run only those tests** and verify they fail because the seam does not yet exist or is not invoked.
- [ ] **Step 3: Implement the seam** as an explicit dependency/configuration object used only when both required environment variables are present; consume one failure and delegate every later check to the real checker.
- [ ] **Step 4: Pass `{ runtime, phase: 'post_activation_update_health' }` from `_startAndCheck()` only for the post-activation check; do not alter the real NEW process launch, PID, command line, or descriptor.
- [ ] **Step 5: Run the focused tests** and verify GREEN, including the existing health tests and update state tests.

### Task 3: Add correlated operation audit logging

**Files:**
- Modify: `src/update/dsh-update-manager.js`
- Modify: `src/utils/logger.js` only if structured JSON support is required by the existing logger contract
- Test: `test/dsh-update-manager.test.js`

- [ ] **Step 1: Write RED audit tests** using a capture logger and assert that SUCCESS, ROLLED_BACK, and FAILED operations each emit one `operationId` shared by `update_operation_created`, state transition events, and `operation_completed`.
- [ ] **Step 2: Run the audit tests** and verify the expected missing-event failures.
- [ ] **Step 3: Implement minimal event emission** at operation creation, every major transition, failure/rollback/fallback, and completion with sanitized fields only; keep `snapshot.operationId` cleanup unchanged.
- [ ] **Step 4: Add a completion record** with `result` and `durationMs`, and ensure a failure during preparation or checking still completes with `FAILED`.
- [ ] **Step 5: Run the focused audit tests** and verify all event chains and sensitive-data assertions pass.

### Task 4: Make the Hosting configuration boundary safe

**Files:**
- Modify: `src/update/verified-runtime-update-source.js`
- Modify: `src/update/dsh-update-manager.js`
- Modify: `src/lifecycle/app-lifecycle.js`
- Test: `test/verified-runtime-update-source.test.js`
- Test: `test/dsh-update-manager.test.js`

- [ ] **Step 1: Write RED tests** for configured source, missing source, malformed URL/index, and unreachable source; assert missing configuration is a safe unavailable condition and startup-facing code remains usable.
- [ ] **Step 2: Run the boundary tests** and verify they fail only on the new behavior.
- [ ] **Step 3: Implement safe source semantics**: no localhost or placeholder production default, explicit `verified_runtime_source_not_configured` logging, controlled manual message, and no update loop/unhandled rejection for automatic checks.
- [ ] **Step 4: Keep configured-source errors controlled** so current runtime remains active and malformed/unreachable source cannot mutate runtime state.
- [ ] **Step 5: Run the focused hosting tests** plus existing lifecycle/source tests.

### Task 5: Build one deterministic installed External + Pending E2E

**Files:**
- Modify/Create: `scripts/release-e2e-launch.js`, `scripts/release-e2e-http-fixture.js`, and one task-local scenario driver under `scripts/`
- Modify/Create: `test/release-e2e-external-pending.test.js`
- Modify: `src/process/harness-process-manager.js` only if existing attach/process identity hooks cannot provide evidence without changing ownership behavior

- [ ] **Step 1: Add deterministic test-driver assertions** for external process identity (PID, PPID, creation time, command line, runtime path/version), attach with `ownsHarnessProcess=false`, no duplicate Harness, pending state, Desktop quit survival, independent external exit, restart, pending activation, NEW health, and pending clear.
- [ ] **Step 2: Run the deterministic test first** and verify it fails because the real scenario/ledger is not present.
- [ ] **Step 3: Implement only test-driver/observability support** using task-owned paths and explicit PID/creation-time/command-line checks; never add arbitrary product IPC or a public control endpoint.
- [ ] **Step 4: Run the real installed scenario** with a real OLD external Harness and real NEW verified artifact, preserving the external process across Desktop exit and stopping it only from the test harness.
- [ ] **Step 5: Save the process ledger and state snapshots** as release evidence and verify no real user configuration was read or changed.

### Task 6: Run real installed Rollback E2E with isolated one-shot fault

**Files:**
- Modify/Create: rollback-specific task-local E2E driver and ledger script under `scripts/`
- Modify: `test/runtime-artifact-update-e2e.test.js` only if the real artifact path needs an explicit rollback scenario entry point

- [ ] **Step 1: Run the focused preflight** against isolated install/userData/DSH_HOME and confirm OLD real health before update.
- [ ] **Step 2: Run OLD → NEW through download, SHA, extraction, verification, promotion, owned stop, activation, real NEW PID, and post-activation one-shot failure.
- [ ] **Step 3: Verify `ROLLING_BACK`, NEW PID/tree gone, bundled OLD fallback PID started with real `HarnessHealthChecker`, and final state `ROLLED_BACK` with `pending=null` and NEW in `failedVersions`.
- [ ] **Step 4: Quit and restart the same isolated Desktop** and verify bundled OLD resolution and real health, with no automatic reactivation of NEW.
- [ ] **Step 5: Record the complete process matrix and correlated audit chain** in the final gate document.

### Task 7: Run regression, artifact E2E, packaging, install, and final smoke

**Files:**
- Modify: `docs/runtime/final-release-gate-closure.md`
- Modify: `docs/runtime/installed-desktop-runtime-release-validation.md`

- [ ] **Step 1: Run focused rollback, External/Pending, audit, and Hosting tests.**
- [ ] **Step 2: Run `npm test` and record total/pass/fail/skip.**
- [ ] **Step 3: Run the real artifact E2E with `DSH_REAL_RUNTIME_ARTIFACT` and verify npm installer calls are zero.**
- [ ] **Step 4: Run `git diff --check`, `npm run pack`, and `npm run dist`; record exit codes.**
- [ ] **Step 5: Record final NSIS path, byte size, SHA-256, perform isolated install, and run launch/runtime/health/Tray/quit/process cleanup smoke.**
- [ ] **Step 6: Complete the gate matrix and separate `FEATURE BRANCH MERGE READY` from `PUBLIC RELEASE READY`; hosting may leave the public result `NO` while code merge readiness is `YES` only if every lifecycle gate passes.
