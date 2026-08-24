# DSH Runtime Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the confirmed V8 heap blocker from real DSH runtime preparation and prove the complete real Runtime, update, rollback, pending-activation, packaging, installer, and cleanup gates on Windows.

**Architecture:** Keep the existing Runtime Manager, Process Manager, state machine, UI, and ownership model unchanged. First test the smallest evidence-based preparation-only heap increase against a fresh real DSH install; if it succeeds, propagate that narrowly to the preparation npm child and only to the Managed installer if a separate real installer smoke proves it needs the same capacity. All release validation remains an explicit, networked, task-owned workflow and is not added to the default unit-test command.

**Tech Stack:** Windows PowerShell, Node.js 24.18.0, npm 11.16.0/11.11.0, Electron 43.4.0, electron-builder 26.15.3, Node test runner, `@deepseek-ai/dsh@0.1.0-rc.7`, official npm Registry.

**Spec:** `docs/runtime/dsh-runtime-install-blocker-root-cause.md`, `docs/runtime/dsh-runtime-release-gate.md`, and the user-provided Release Gate execution brief.

## Global Constraints

- Remain on `codex/dsh-runtime-updater`; do not merge, rebase, squash, switch to `main`, or delete the worktree.
- Do not modify Updater architecture, Tray, Update Dialog, UI, or DSH Web behavior.
- Use `https://registry.npmjs.org` explicitly for real validation; do not modify user/global npm configuration.
- Use exact DSH versions; never install `@latest` during a validation step.
- Keep all prefixes, caches, logs, installs, builds, and installer smoke outputs under task-owned temporary paths.
- Do not use fixtures for a Release Gate claim; a real package tree must contain the real package metadata, dependencies, and CLI.
- Do not add real network installation to `npm test`; preserve the existing deterministic test suite and its coverage floor of at least 107 passing tests and 0 failures.
- Do not use `--legacy-peer-deps`, `--force`, `--ignore-scripts`, mirror substitution, cache cleaning, package-manager replacement, or timeout expansion as a fix unless later evidence specifically proves that choice necessary; the preparation command's existing `--ignore-scripts` is retained only to preserve the current runtime contract.
- Every root-cause fix and every independent release-validation helper change receives its own commit.

---

### Task 1: Test the heap hypothesis with a real isolated install

**Files:**
- Create: task-owned temporary diagnostic script only under `C:\Users\韩吉衍\AppData\Local\Temp\dsh-release-gate-20260824-01\diagnostics` (not repository source)
- Read: `docs/runtime/dsh-runtime-install-blocker-root-cause.md`
- Record: `docs/runtime/dsh-runtime-release-gate.md`

**Interfaces:**
- Consumes: the exact preparation npm argument list and the real package `@deepseek-ai/dsh@0.1.0-rc.7`.
- Produces: a one-variable result for `NODE_OPTIONS=--max-old-space-size=4096`, including exit code, duration, peak process memory, last npm phase, and whether a real package tree was produced.

- [ ] **Step 1: Run the one-variable experiment.**

  Use Node 24.18.0, npm 11.16.0 direct CLI, official Registry, unique fresh prefix, unique fresh cache, the same `--ignore-scripts --no-package-lock --no-save --no-audit --no-fund` flags, and only add `NODE_OPTIONS=--max-old-space-size=4096` to the child environment. Bound the process to 12 minutes and sample the root process and descendants every 10 seconds.

- [ ] **Step 2: Verify the experiment result before editing source.**

  PASS requires npm exit 0, `node_modules/@deepseek-ai/dsh/package.json` present, the package version equal to `0.1.0-rc.7`, a real `lib/bin.js` present, and no V8 fatal error. A timeout, OOM, network-only failure, or missing tree keeps the Release Gate BLOCKED and sends the investigation back to the diagnostic phase; do not add a code workaround on a failed hypothesis.

- [ ] **Step 3: Append the result to the two evidence documents.**

  Include the exact command, environment, prefix, cache, duration, exit code, peak memory, npm phase, and tree result in `docs/runtime/dsh-runtime-release-gate.md` and the confirmed/rejected hypothesis section of `docs/runtime/dsh-runtime-install-blocker-root-cause.md`.

---

### Task 2: Add the minimal preparation-only heap propagation with TDD

**Files:**
- Modify: `scripts/prepare-bundled-runtime.js`
- Test: `test/prepare-bundled-runtime.test.js`
- Read: `src/update/npm-command.js`

**Interfaces:**
- Consumes: the existing `prepareBundledRuntime(options)` and `runNpmInstall` spawn boundary.
- Produces: the same preparation behavior, with a narrowly scoped child environment containing the evidence-backed V8 heap setting; no change to descriptor shape, process ownership, or update state.

- [ ] **Step 1: Write the failing focused test.**

  Extend the existing mocked spawn assertion so the preparation npm child receives an `env` object whose `NODE_OPTIONS` contains `--max-old-space-size=4096`, while unrelated inherited environment values remain available. Keep the existing command, arguments, `shell: false`, `windowsHide: true`, and stdio assertions unchanged.

- [ ] **Step 2: Run the focused test and verify it fails for the expected reason.**

  Run:

  ```powershell
  node --test test/prepare-bundled-runtime.test.js
  ```

  Expected: the new environment assertion fails because the current spawn options do not pass the preparation heap setting.

- [ ] **Step 3: Implement only the preparation environment change.**

  Add a named preparation constant and build the child environment at the existing npm spawn boundary:

  ```js
  const PREPARATION_NODE_OPTIONS = '--max-old-space-size=4096';
  const childEnv = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, PREPARATION_NODE_OPTIONS]
      .filter(Boolean)
      .join(' '),
  };
  ```

  Pass `env: childEnv` to the existing `spawnProcess` call. Do not alter the runtime descriptor, `NpmInstaller`, update manager, UI, or default user Node installation in this task.

- [ ] **Step 4: Run the focused test and the existing preparation checks.**

  Run:

  ```powershell
  node --test test/prepare-bundled-runtime.test.js test/npm-command.test.js test/npm-installer.test.js
  ```

  Expected: all focused tests pass and existing npm shim/installer contracts remain unchanged.

- [ ] **Step 5: Commit the isolated fix.**

  ```powershell
  git add scripts/prepare-bundled-runtime.js test/prepare-bundled-runtime.test.js
  git commit -m "fix: give bundled runtime preparation enough heap"
  ```

---

### Task 3: Prepare and verify the real bundled runtime

**Files:**
- Modify: `docs/runtime/dsh-runtime-release-gate.md`
- Generate: task-owned `build/bundled-runtime` through the real preparation hook

**Interfaces:**
- Consumes: the committed preparation fix and official exact package version.
- Produces: a real bundled runtime directory and verification evidence; no fixture substitution.

- [ ] **Step 1: Run the real preparation hook.**

  Run `npm run prepare:bundled-runtime` with the explicit official Registry and task-owned diagnostic output if the script supports an output override; otherwise use the repository's standard `build/bundled-runtime` path and preserve its generated output for the following checks.

- [ ] **Step 2: Verify the real package tree.**

  Confirm `runtime-manifest.json`, `node_modules/@deepseek-ai/dsh/package.json`, the real `bin.dsh` target, the complete dependency tree, package count, file count, byte size, and exact version `0.1.0-rc.7`. Run the project's real `verifyRuntime()` and the DSH CLI `--version`; record `reportedVersion`.

- [ ] **Step 3: Verify the resolved descriptor and real `web` launch.**

  Use `DshRuntimeManager` to resolve the Bundled descriptor and assert `args` equals `[cliEntry, 'web']`. Start it through `HarnessProcessManager`, record PID/stdout/stderr/URL/port/startup duration, then use `HarnessHealthChecker` for an HTTP readiness check. Stop only the owned process tree after health passes.

- [ ] **Step 4: Record the real bundled smoke.**

  Append the preparation path, install duration, counts, size, verification result, descriptor command/args, PID, detected URL, startup duration, health result, and cleanup result to the Release Gate document. Mark only the bundled-runtime checklist items proven by this evidence.

---

### Task 4: Verify whether the Managed installer needs the same preparation setting

**Files:**
- Modify only if the real test fails by the same V8 heap error: `src/update/npm-installer.js`
- Test only if modified: `test/npm-installer.test.js`
- Record: `docs/runtime/dsh-runtime-release-gate.md`

**Interfaces:**
- Consumes: the existing `NpmInstaller.install({ stagingRoot, packageName, version })` boundary and the latest exact DSH version from the official Registry.
- Produces: either evidence that the existing Managed installer works unchanged, or a separately tested minimal child-environment fix.

- [ ] **Step 1: Run a real isolated Managed install using the current installer path.**

  Use an isolated test `userData`/runtime root, exact version, official Registry, and the existing process ownership rules. Capture the same stdout/stderr, resource, and npm log evidence. Do not change source first.

- [ ] **Step 2: Decide from evidence.**

  If the Managed install succeeds, make no installer source change and record that the preparation-only fix is sufficient. If it fails with the same V8 heap-limit message, repeat the TDD sequence from Task 2 at the `NpmInstaller` spawn boundary, then commit a separate fix with message `fix: give managed runtime installs enough heap`.

- [ ] **Step 3: Verify the exact managed runtime.**

  Confirm package metadata, CLI `--version`, `verifyRuntime()`, descriptor args `[cliEntry, 'web']`, real health after launch, and cleanup before proceeding.

---

### Task 5: Execute real update, persistence, rollback, external ownership, and pending activation smoke

**Files:**
- Modify: `docs/runtime/dsh-runtime-release-gate.md`
- Generate: task-owned isolated runtime/userData directories and logs only

**Interfaces:**
- Consumes: real Bundled and Managed runtime descriptors, `DshUpdateManager`, `RuntimeStateStore`, `HarnessProcessManager`, and `HarnessHealthChecker`.
- Produces: evidence for exact version update, pointer switch, restart persistence, real rollback, external ownership, and pending activation.

- [ ] **Step 1: Resolve the live latest version.**

  Query the official Registry `dist-tags.latest` on the validation day and record the exact result. Use that exact value for install; never re-resolve the tag during installation.

- [ ] **Step 2: Run real Managed update smoke.**

  In isolated userData, start the real old Bundled DSH, verify health, run the real update manager through `UPDATE_AVAILABLE`, stage/install/verify/promote/activate, stop only the owned old process, start the Managed runtime with `web`, and require HTTP health. Verify `runtime-state.json` has `current=managed/<latest>` and `previous=bundled/<old>`.

- [ ] **Step 3: Verify restart persistence.**

  Exit the Desktop-owned process, assert no owned child remains, restart the Desktop test path, resolve current runtime, and require the Managed latest descriptor and HTTP health. Record that restart did not revert to Bundled.

- [ ] **Step 4: Run real rollback smoke.**

  In a separate isolated test root, activate a test-only invalid runtime descriptor or controlled health-failure runtime without modifying the valid new DSH. Require the real Process Manager to start it, observe health failure, stop only that owned process, restore the previous pointer, start the previous real DSH, and require health PASS. Verify `pending` is empty and state pointers match the rollback design.

- [ ] **Step 5: Verify rollback persistence.**

  Restart the Desktop test path and require the previous real runtime and HTTP health again.

- [ ] **Step 6: Run external ownership and pending activation smoke.**

  Start a real external DSH with `npx @deepseek-ai/dsh web` in a task-owned environment, then start Desktop and verify `ownsHarnessProcess=false`. Exercise update preparation/promotion/pending without stopping, restarting, or taskkilling the external process. End the external harness normally, restart Desktop, and require pending validation, activation, Managed `web` launch, and HTTP health.

---

### Task 6: Build, inspect, install, and smoke the real NSIS artifact

**Files:**
- Modify: `docs/runtime/dsh-runtime-release-gate.md`
- Generate: task-owned pack/dist/NSIS/install directories only

**Interfaces:**
- Consumes: a verified real bundled runtime and all prior runtime smoke evidence.
- Produces: real unpacked resources, real NSIS Setup.exe metadata, isolated installation, installed runtime smoke, update smoke, and process cleanup evidence.

- [ ] **Step 1: Run the standard build commands without bypassing preparation.**

  Run `npm run pack`, then `npm run dist`. Record each actual exit code and keep the real preparation hook enabled.

- [ ] **Step 2: Inspect the real package layout.**

  Confirm `resources/app.asar` contains updater code, `resources/bundled-runtime` is outside asar, and the external runtime contains the real package tree. Record directory size, file count, package count, and hashes.

- [ ] **Step 3: Record the real NSIS artifact.**

  Locate `DeepSeek Harness Desktop Setup <version>.exe`, record absolute path, byte size, and SHA-256.

- [ ] **Step 4: Install to an isolated directory and launch the installed executable.**

  Use a task-owned silent-install target and isolated userData. Launch the installed EXE; verify Splash/Spinner, Bundled DSH `web`, Harness Ready via HTTP health, UI/tray/update-check behavior as observable without modifying product UI.

- [ ] **Step 5: Run installed-app update and cleanup smoke.**

  Use the installed app's real update manager with exact latest version, restart, require Managed Harness health, exit the app, and verify only the Desktop-owned process tree is gone. Do not kill all `node` processes; inspect the specific parent/child tree.

---

### Task 7: Final regression and release-gate closeout

**Files:**
- Modify: `docs/runtime/dsh-runtime-release-gate.md`
- Read: `docs/runtime/dsh-runtime-install-blocker-root-cause.md`

**Interfaces:**
- Consumes: all real evidence from Tasks 1–6.
- Produces: a binary final status, complete checklist, reproducible diagnostic matrix, and handoff without merging.

- [ ] **Step 1: Run focused tests for every changed source path.**

  Run the corresponding npm/preparation/runtime/process tests first and require zero failures.

- [ ] **Step 2: Run the complete deterministic suite.**

  ```powershell
  npm test
  ```

  Require at least `107 passed` and `0 failed`; record the exact count.

- [ ] **Step 3: Run syntax and whitespace checks.**

  ```powershell
  node --check scripts/prepare-bundled-runtime.js
  git diff --check
  ```

- [ ] **Step 4: Update every Release Gate checklist item from evidence.**

  Set `Status: RELEASE GATE PASS` only if real install, verify, Bundled/Managed `web` health, update, restart persistence, rollback, external ownership, pending activation, standard pack/dist, real NSIS install, installed update, cleanup, tests, and diff checks all pass. Otherwise keep `Status: BLOCKED`, list the exact remaining blocker, and write `DO NOT MERGE`.

- [ ] **Step 5: Commit only documentation/validation artifacts that belong in the branch.**

  Keep task-owned temporary diagnostics outside the repository. Commit source fixes and their focused tests separately from release evidence/documentation. Do not merge to `main`; return the user the choices to merge, push/PR, or keep the branch only if the gate is PASS.

---
