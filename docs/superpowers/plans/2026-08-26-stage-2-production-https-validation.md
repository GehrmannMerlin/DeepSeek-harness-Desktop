# Stage 2 Production HTTPS Final Release Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the already-published `0.1.0-rc.7` bundled Desktop updating to the real Production HTTPS stable `0.1.1-rc.2`, surviving restart, respecting Stable rollback/restore semantics, and reopening the scheduled Factory gate only after all evidence passes.

**Architecture:** Treat the Production Stable Index and immutable GitHub Release asset as the only remote inputs. Exercise the installed Electron executable through AppLifecycle → renderer/preload IPC → main-process update manager, with isolated installation/userData/DSH_HOME and exact process ownership checks. Use the existing official GitHub Actions promotion workflow for Stable pointer rollback and restore; never edit Pages metadata directly.

**Tech Stack:** Windows PowerShell, Node.js/npm, Electron 43, electron-builder/NSIS, GitHub CLI/API, GitHub Pages HTTPS, Node test runner, existing DSH Runtime Distribution scripts and workflows.

**Spec:** User-pasted Stage 2 Production HTTPS Final Release Validation brief (`C:\Users\韩吉衍\.codex\attachments\5d17bf8a-c5ec-45b5-a2d5-81a252aed1e8\pasted-text.txt`).

## Global Constraints

- Stable before the run is `0.1.1-rc.2`; intended final Stable is `0.1.1-rc.2`.
- OLD bundled runtime is `0.1.0-rc.7`; NEW Production Stable runtime is `0.1.1-rc.2`.
- rc.2 identity is size `69086249` bytes and SHA-256 `5f6efe25a0704da248e7ac2a6d34b6be4a5560b2c3cdebebc5d567c5edc4d837`, unless the live Stable Index has a different formally read-back value.
- The Production Index must be HTTPS and trusted by main-process/app configuration; renderer input cannot choose an arbitrary URL.
- The client update path must use streaming artifact download, existing path/entry safety, `verifyRuntime`, and the real UI/IPC contract.
- Client-side `npm install`, `pnpm install`, `npx @deepseek-ai/dsh`, live dependency resolution, delta update, silent Desktop update, and forced client downgrade are forbidden.
- Do not delete Releases/assets, manually edit `runtime-index.json`, publish `Setup.exe`, or configure code signing.
- Any phase over two minutes receives progress/resource inspection; any phase over five minutes receives an efficiency review; no opaque wait over ten minutes.
- Reuse existing Remote Verified candidates and existing validated installers whenever binary inputs are unchanged; rebuild only when evidence proves it is required.

### Task 1: Freeze baseline and remote production assets

**Files:**
- Read: `.github/workflows/dsh-runtime-factory.yml`
- Read: `.github/workflows/dsh-runtime-promote.yml`
- Read: `src/update/verified-runtime-update-source.js`
- Read: `src/lifecycle/app-lifecycle.js`
- Read: `src/main.js`
- Evidence: `docs/runtime/dsh-runtime-release-gate.md`

**Interfaces:**
- Consumes: current Git branch/worktree, live Stable Index, rc.2 Release URL, existing workflow inputs.
- Produces: recorded HEAD/branch/remotes, exact HTTP 200 Index identity, rc.2 HEAD availability, trusted URL wiring, and identified workflow run interfaces.

- [ ] Run `git status --short --branch`, `git branch --show-current`, `git log --oneline -20`, and `git remote -v`; stop if the selected worktree is not clean.
- [ ] GET `https://gehrmannmerlin.github.io/DeepSeek-harness-Desktop/runtime/stable/runtime-index.json`; assert HTTP 200, schema v1, rc.2, win32/x64, exact size/hash, and immutable GitHub Release URL.
- [ ] HEAD the exact rc.2 ZIP URL; record status, Content-Length, elapsed time, and retry count without downloading the ZIP.
- [ ] Scan source, renderer, preload, workflow, package, and builder configuration; prove the final Desktop defaults to the trusted production URL and that renderer code has no arbitrary URL setter.
- [ ] Inspect promotion/factory workflow `workflow_dispatch` inputs and current GitHub auth/permissions; record whether remote rollback/restore can be invoked.

### Task 2: Reuse or rebuild the packaged OLD Desktop only from evidence

**Files:**
- Read: `electron-builder.yml`
- Read: `scripts/prepare-bundled-runtime.js`
- Read: `scripts/release-e2e-launch.js`
- Read: `test/runtime-artifact-update-e2e.test.js`
- Output: isolated temporary install/evidence directories outside the repository.

**Interfaces:**
- Consumes: Task 1 URL/configuration result and existing rc.7 validated package evidence.
- Produces: an installed NSIS whose packaged product inputs are identified, isolated install/userData/DSH_HOME paths, and verified bundled rc.7 manifest/CLI.

- [ ] Compare the selected source commit and packaged binary inputs with the prior validated NSIS evidence; if product code changed, run `npm run pack` and `npm run dist`, otherwise reuse only a hash-verified existing NSIS.
- [ ] Install via the real NSIS into an isolated path and verify installer exit code 0, Desktop EXE, bundled runtime, manifest, and CLI version rc.7.
- [ ] Launch only the installed Desktop EXE with isolated userData and DSH_HOME; do not use `npm start`, `electron .`, or direct manager calls.
- [ ] Record Desktop PID, bundled Harness PID, command lines, creation times, parent PIDs, runtime root, CLI entry, and `web` args.

### Task 3: Run the production HTTPS installed Desktop E2E

**Files:**
- Read: `src/lifecycle/app-lifecycle.js`
- Read: `src/update/dsh-update-manager.js`
- Read: `src/update/runtime-artifact-downloader.js`
- Read: `src/update/runtime-verifier.js`
- Read: `src/runtime/dsh-runtime-manager.js`
- Read: `src/health/harness-health-checker.js`
- Read: `renderer/update.html`
- Read: `src/window/update-preload.js`
- Evidence: isolated runtime state/logs/process ledger.

**Interfaces:**
- Consumes: installed rc.7 Desktop and live rc.2 Stable Index.
- Produces: update operation ID, lifecycle ordering, real UI/IPC update, streamed download metrics, verification/activation result, rc.2 health, audit trail, runtime state, and process cleanup evidence.

- [ ] Verify OLD Harness health and `harness_ui_ready` before `update_check_started`; record HTTP status, elapsed time, discovered version/platform/arch, and `UPDATE_AVAILABLE`.
- [ ] Confirm update is initiated through the real renderer/preload IPC contract and capture the single operation ID from creation through completion.
- [ ] Observe the real GitHub ZIP download; record total/downloaded bytes, throughput, duration, HTTP status, retries, `.part` usage, and 2/5-minute efficiency metrics if thresholds are crossed.
- [ ] Verify exact size/hash, ZIP path/entry safety, package/version/platform/arch manifest, and only then promote/activate; confirm OLD remains usable until activation.
- [ ] Verify OLD owned PID cleanup, managed rc.2 process metadata, NEW health, BrowserWindow recovery, SUCCESS state, audit events, `pending=null`, and no failed healthy rc.2 entry.
- [ ] Prove zero `npm install`, `pnpm install`, `npx @deepseek-ai/dsh`, and live dependency-resolution calls in the client process tree/logs.
- [ ] Quit Desktop normally, verify Desktop and owned NEW Harness exit while unrelated Node remains alive, relaunch with the same isolated userData, and verify managed rc.2 persistence, health PASS, and second-check `UP_TO_DATE` without a second download.

### Task 4: Execute official Stable rollback and restore

**Files:**
- Read: `.github/workflows/dsh-runtime-promote.yml`
- Evidence: GitHub Actions run IDs/URLs, public Index readbacks, isolated client logs.

**Interfaces:**
- Consumes: Remote Verified rc.7 candidate availability, existing managed rc.2 client, fresh isolated rc.7 Desktop.
- Produces: official rollback run evidence, public rc.7 Index, existing-new no-downgrade evidence, fresh-old no-update evidence, official restore run evidence, final public rc.2 Index.

- [ ] Inspect GitHub Releases, candidate metadata, prior verification markers, and Pages history for a Remote Verified rc.7 target; reuse it when present.
- [ ] Dispatch the formal rollback workflow with source Stable rc.2 and target rc.7; monitor queue/running phases with bounded polls and record run URL, duration, and result.
- [ ] GET the public Stable Index and assert HTTP 200/latest rc.7; run the already-managed rc.2 Desktop check and assert no rc.7 download/activation; run a fresh isolated bundled rc.7 Desktop and assert `UP_TO_DATE`/no update.
- [ ] Dispatch the formal promotion workflow rc.7 → rc.2; verify public HTTP 200/latest rc.2, immutable URL, exact size, and exact SHA.
- [ ] Do not delete or mutate either Release asset and do not edit Pages JSON directly.

### Task 5: Reopen scheduled Factory gate and prove existing-version no-op

**Files:**
- Modify: `.github/workflows/dsh-runtime-factory.yml` only if the user-authorized gate restoration requires a checked-in change.
- Evidence: scheduled detection result and GitHub Actions run.

**Interfaces:**
- Consumes: successful Production HTTPS update, rollback, restore, and final rc.2 Index.
- Produces: `FACTORY_PERFORMANCE_ACCEPTED=true` gate state and a no-op detection proving no expensive Factory/build for existing rc.2.

- [ ] Confirm all prerequisite gates PASS before changing the performance gate.
- [ ] Restore the scheduled path gate to `FACTORY_PERFORMANCE_ACCEPTED=true` using the project’s intended workflow configuration mechanism; do not promote a new upstream version.
- [ ] Run equivalent scheduled latest detection with upstream latest rc.2; assert candidate/stable already exists, detection completes, and no checkout/build/full Factory starts.
- [ ] If upstream latest changes during the task, record it but keep this Stage 2 validation pinned to rc.2 and do not auto-promote it.

### Task 6: Regression, cleanup, documentation, and final gate matrix

**Files:**
- Modify: `docs/runtime/dsh-runtime-release-gate.md`
- Modify: `docs/runtime/production-runtime-distribution-analysis.md`
- Modify: `docs/runtime/production-runtime-distribution-architecture.md`
- Modify: `docs/runtime/production-runtime-distribution-runbook.md`
- Modify: `docs/runtime/installed-desktop-runtime-release-validation.md`

**Interfaces:**
- Consumes: all evidence from Tasks 1–5.
- Produces: auditable Stage 2 documentation, clean process/resource state, fresh test outputs, and a final PASS/BLOCKED matrix.

- [ ] Run `npm test`, the explicit `DSH_REAL_RUNTIME_ARTIFACT` E2E only if a validated artifact path is available, `npm run distribution:validate-workflows`, and `git diff --check`; record exact counts and exit codes.
- [ ] Check port 3080, test-owned Harnesses, Desktop E2E processes, download fixtures, temporary blockers, and orphaned installer processes; clean only exact task-owned targets.
- [ ] Append Stage 2 evidence to all five required runtime documents, preserving historical failures and clearly separating real public evidence from local-only evidence.
- [ ] Re-read the brief line-by-line and fill the final matrix for Artifact Acceptance, Candidate/Remote/Stable, Installed Update, Persistence, npm-free, Rollback, No-Downgrade, Fresh Old, Restore, Schedule, Audit, Cleanup, and Regression.
- [ ] Apply `superpowers:verification-before-completion` and make the public decision `YES` only if every core gate has fresh evidence; otherwise report `NO` with exact blockers.

## Stage 2 execution record

The plan was executed in the registered worktree
`D:\Develop\DeepSeek Agent\DeepSeek Agent Desktop\.worktrees\dsh-factory-performance-closure`.
The initially supplied `dsh-runtime-updater` directory was not a registered
Git worktree and was not used for source edits.

### Production issues found and fixed by TDD

1. Cold GitHub Pages index latency exceeded the original 4,000 ms bound; a
   measured 6,097 ms sample justified the bounded default change to 15,000 ms.
2. GitHub Release asset download returned its normal HTTP 302 redirect; the
   downloader now follows at most five HTTP/HTTPS redirects before hashing.
3. Native direct HTTPS streaming was pathologically slow in the execution
   environment. Node 24 fetch with `Readable.fromWeb` now provides the same
   streaming, byte-count, SHA-256, and cleanup contract, using existing proxy
   variables only when present. No dependency or npm/pnpm installation was
   added.

Focused tests were red before each implementation and green afterward: source
timeout 7/7, downloader redirect suite 4/4, combined source/downloader 11/11,
and final `npm test` 252 total, 251 passed, 0 failed, 1 existing skip.

### Final evidence

- Final local NSIS: 320,199,558 bytes,
  SHA-256 `EBA64C21C52B32B7B31CD9A7566B6B084E8440563A957432B0DD880A88AB8DDA`.
- Installed OLD bundle: rc.7; manifest/CLI validated.
- Production update: operation `update-1787734603256-1`, rc.7 → rc.2,
  `UPDATE_AVAILABLE` → `SUCCESS`, 302→200, 69,086,249 bytes, exact SHA,
  21,182 ms download, 109,589 ms total, NEW health 74 ms.
- Restart persistence: operation `update-1787734841463-1`, managed rc.2,
  `UP_TO_DATE`, 6,203 ms, no second download.
- Official rollback: run `32950819410`; managed rc.2 and bundled rc.7 both
  no-op against stable rc.7.
- Official restore: run `32951216611`; final stable HTTPS readback is exact
  rc.2.
- Factory gate: `FACTORY_PERFORMANCE_ACCEPTED=true`; cheap detection found
  candidate rc.2 and returned `NO_OP`; no expensive Factory started.
- Local real artifact HTTP E2E: 1/1 passed in approximately 94.4 seconds;
  installer calls `0`.

Final boundary: production runtime distribution and installed Desktop
update/restart/rollback/restore **PASS**; public Desktop installer publication
**NOT PERFORMED**; Windows code signing **NOT CONFIGURED**. A real cron tick
was not artificially awaited after the cheap scheduled no-op path was verified.
