# DSH Factory Performance Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the repeated Windows Factory `ENOSPC` blocker by proving a real rc.2 direct artifact path with zero duplicate runtime-tree materialization, measurable progress/disk evidence, and production distribution acceptance gates.

**Architecture:** Keep the existing ZIP contract and direct-entry archive design. Reuse one canonical safe pre-scan for source entries, expose bounded progress/disk telemetry, and gate scheduled expensive Factory runs until the performance acceptance flag is enabled. Use one freshly built isolated rc.2 runtime tree for artifact-only verification before any full Factory or remote promotion.

**Tech Stack:** Node.js 24-compatible CommonJS scripts, Node test runner, `unzipper`, GitHub Actions PowerShell, npm/gh CLI, Markdown runbook.

**Spec:** User-provided task text `# DeepSeek Harness Desktop — Factory Performance Closure + Production Artifact Acceptance`.

## Global Constraints

- Do not start another full Factory before artifact-only real rc.2 acceptance passes.
- Direct archive mode must perform zero full-tree `fs.copyFile()` materialization.
- Preserve ZIP, manifest, SHA-256, independent extraction, CLI, Web/Health, and Native contracts.
- Any local artifact phase reaching five minutes requires measured progress, throughput, ETA, CPU/disk/memory review; no opaque wait beyond ten minutes.
- Do not change the ZIP format to tar.gz or 7z, and do not skip independent extraction or runtime smoke.
- Build the real upstream runtime tree once, then benchmark strategies on that same tree.

### Task 1: Add failing regression coverage for observability and schedule gating

**Files:**
- Modify: `test/runtime-factory-artifact.test.js`
- Modify: `test/runtime-distribution-workflows.test.js`
- Modify: `.github/workflows/dsh-runtime-factory.yml`

- [ ] Add assertions that direct mode reports `materializationMs === 0`, `fullTreeCopyCount === 0`, canonical entry progress, and disk snapshots.
- [ ] Add workflow assertions for a temporary performance gate, a cheap schedule-only detection job, and manual-dispatch bypass.
- [ ] Run the focused tests and record the expected RED failures before implementation.

### Task 2: Implement bounded telemetry without changing artifact semantics

**Files:**
- Modify: `scripts/build-verified-runtime-artifact.js`
- Modify: `src/update/runtime-artifact-downloader.js`

- [ ] Extend pre-scan, ZIP, and extraction operations with processed file/byte counters, throughput, ETA, and periodic `[FACTORY_PROGRESS]` records.
- [ ] Record free-disk snapshots before/after runtime build, ZIP, and independent extraction when the host exposes `statfs` data.
- [ ] Keep the direct path on the canonical entry list and count every full-tree copy attempt so the structural invariant is testable.
- [ ] Run the focused artifact tests to GREEN.

### Task 3: Prevent scheduled runner waste and document the operating policy

**Files:**
- Modify: `.github/workflows/dsh-runtime-factory.yml`
- Modify: `docs/runtime/production-runtime-distribution-runbook.md`
- Modify: `docs/runtime/production-runtime-distribution-analysis.md`

- [ ] Add schedule-only cheap latest/candidate detection and a checked-in performance-acceptance gate; keep `workflow_dispatch` able to run controlled benchmarks.
- [ ] Document 2-minute inspection, 5-minute efficiency review, 10-minute anomaly stop, repeated-failure isolation, and no timeout inflation.
- [ ] Record the confirmed old algorithmic root cause and the new direct-archive evidence boundary.

### Task 4: Build and measure one fresh real rc.2 tree

**Files:**
- Create: external evidence directory on a disk with sufficient free space (not committed)
- Capture: benchmark JSON/log, tree inventory, disk snapshots, and process cleanup evidence

- [ ] Resolve exact npm `0.1.1-rc.2`, upstream `dsh-v0.1.1-rc.2`, Node `24.18.0`, and pnpm `11.7.0`.
- [ ] Build/deploy the isolated runtime once, immediately record file count, bytes, link count, duration, and free disk.
- [ ] Run `npm run distribution:benchmark-artifact -- --source-runtime <fresh-tree> ...` with a heartbeat no longer than ten seconds.
- [ ] Apply the five-minute gate to each local phase; if direct ZIP is within budget, do not add alternate archive strategies.

### Task 5: Complete acceptance and repository verification

**Files:**
- Modify: focused test files only if evidence requires a regression test
- Modify: `docs/runtime/production-runtime-distribution-runbook.md`

- [ ] Verify real ZIP filename, size, SHA-256, file count, manifest identity, independent extraction, extracted CLI/Web/Health/Native, and zero duplicate materialization.
- [ ] Run focused tests, full `npm test`, `npm run distribution:validate-workflows`, and `git diff --check`; clean test-owned processes and port 3080.
- [ ] Only after real artifact acceptance passes, run exactly one full Factory and then perform Candidate Release, HTTPS re-download, remote verification, stable promotion, and Pages index verification if authorization and remote state permit.
- [ ] Run fresh completion verification and report every required PASS/FAIL/NOT REACHED field with timing and disk evidence.

