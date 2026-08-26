# DSH Runtime Release Gate

Date: 2026-08-24 (Asia/Shanghai)
Worktree: `D:\Develop\DeepSeek Agent\DeepSeek Agent Desktop\.worktrees\dsh-runtime-updater`
Branch: `codex/dsh-runtime-updater`

Status: BLOCKED

## Current Stage-1 production distribution blocker — 2026-08-26

The Distribution implementation is integrated on `main` at
`819ca2c076feddf478afb5411be4a2c3ff5d3bae`, but Stage 1 remains blocked. The
third real Windows Factory run was
`https://github.com/GehrmannMerlin/DeepSeek-harness-Desktop/actions/runs/32865356755`.
All pre-artifact steps passed; artifact assembly failed at
`2026-08-25T18:26:41Z` after approximately 3 hours 4 minutes with
`ENOSPC: no space left on device` in repeated `cloneMaterializedTree()` copy
operations. No fourth full Factory was started, no Candidate Release was
created, and no Pages index was deployed.

Scheduled run `32885958573` reproduced the same old-code `ENOSPC` failure
after approximately 3 hours 5 minutes. The post-change scheduled run
`32920257549` was cancelled at approximately 17 minutes in the artifact
phase and did not publish any remote resource.

The builder now has a direct-archive path and phase timing/heartbeat output,
covered by local tests. The exact verified rc.2 isolated tree was not retained
by the failed ephemeral runner, so no real rc.2 artifact-only benchmark has
been recorded. This is a performance blocker, not a successful Factory or
Remote Verification result.

## Initial blocker

Real DSH package installation through the historical npm path does not
complete successfully; one bounded real npm process exited with code 134.
The approved Route B Factory path now produced and independently self-smoked a
verified real artifact, but the Desktop update/restart/rollback and installer
gates are not complete, so the overall gate remains BLOCKED.

This document records fresh Release Gate evidence for this task. The historical
Task 13 record remains in `docs/runtime/dsh-runtime-update-verification.md` and
is not overwritten.

## Evidence log

### Route B verified artifact — PASS

Factory source: official DSH revision `99f6f02fe`, Node `24.18.0`,
`pnpm@11.7.0`, frozen lockfile, Windows `win32-x64`. The Factory assembled a
portable runtime without junctions, included the built `apps/web/dist`, wrote
the runtime manifest, created a ZIP, hashed it, independently extracted it,
and repeated CLI/Web/Health/native smoke against the extracted copy.

Artifact evidence:

- Archive: `C:\Users\韩吉衍\AppData\Local\Temp\dsh-runtime-factory\route-b\run-20260824-162959\factory-output-3\dsh-runtime-0.1.0-rc.7-win32-x64.zip`.
- Size: `285760485` bytes.
- SHA-256: `7028288f0dfd8f7bf1ef8a24e019bc0ec659c08cc33ddbd3a44a046817f6b01d`.
- Frozen files: `55725`.
- CLI `0.1.0-rc.7`, Web/Health, and native `node-pty` smoke: PASS.
- `prepareBundledRuntime()` consumed this ZIP with no npm invocation and
  published `source: verified-artifact` only after the same smoke checks.
- `DshRuntimeManager.resolveCurrentRuntime()` resolved the published output as
  a `bundled` descriptor with the nested DSH CLI entry and `web` argument.

The first Factory archive attempt was rejected because it was incomplete. The
second attempt was rejected because the frontend dist was missing. Only the
third frozen ZIP above is counted as artifact PASS.

### Real pack/dist/NSIS and isolated installed runtime — PASS

Using the same artifact through `DSH_VERIFIED_RUNTIME_ARTIFACT`:

- `npm run pack`: exit `0`; electron-builder `26.15.3` produced
  `dist\win-unpacked` with external `resources\bundled-runtime`.
- `npm run dist`: exit `0`; NSIS produced
  `dist\DeepSeek Harness Desktop Setup 1.0.0.exe`.
- Installer size: `320196300` bytes.
- Installer SHA-256:
  `2A9809AE8DC63FD01D4D2363FCD264F27FA488C648CB0AB98AA6DBA6F20D01AB`.
- Isolated silent install target:
  `C:\Users\韩吉衍\AppData\Local\Temp\dsh-artifact-nsis-install-20260824-b`.
- Installer exit code: `0`.
- Installed runtime CLI: `0.1.0-rc.7`, exit `0`.
- Installed runtime Web URL: `http://127.0.0.1:3080`.
- Installed runtime Health Checker: `{ "ok": true, "elapsed": 12 }`.
- Installed `runtime-manifest.json` SHA-256:
  `8A5C8C301EC11FC66A3D1D447E1DD00B8F4B546A677267D2AF5209BB18247473`.

The optional real updater E2E also passed against this ZIP through a local
HTTP server: download, byte/hash verification, real ZIP extraction,
`verifyRuntime`, promotion, restart health, and explicit zero npm installer
calls. This validates the updater artifact path, but its process/runtime
manager is task-isolated; it is not a substitute for the final installed
Desktop update/restart/rollback smoke.

The first installation target was intentionally not counted: the user
interrupted its wait and it was partial. The second target above completed
naturally and is the only install result counted.

## Environment snapshot

Collected on 2026-08-24 (Asia/Shanghai), before any diagnostic install:

- OS: Windows 11 build 26200 (`Microsoft Windows 11 家庭版 中文版`)
- Node.js: `v24.18.0`
- npm: `11.11.0`
- Node executable: `D:\Develop\node.js\node.exe`
- npm PowerShell shim: `D:\Develop\node.js\npm.ps1`
- npm command shim: `D:\Develop\node.js\npm.cmd`
- npm-configured registry: `https://registry.npmmirror.com` (not changed)
- npm cache: `D:\Develop\node.js\node_cache` (not used for the fresh baseline)
- Free physical memory at snapshot: `1847.9 MB`
- Free space on `C:` at snapshot: `20.66 GB`
- TEMP: `C:\Users\韩吉衍\AppData\Local\Temp`
- Task-owned diagnostic root: `C:\Users\韩吉衍\AppData\Local\Temp\dsh-release-gate-20260824-01`

## Official DSH package contract snapshot

Source: `https://registry.npmjs.org/@deepseek-ai%2fdsh/0.1.0-rc.7`, queried
with the official Registry before the baseline install.

- Package: `@deepseek-ai/dsh@0.1.0-rc.7`
- `bin`: `dsh -> lib/bin.js`
- Direct dependencies: 61
- `optionalDependencies`: absent
- `peerDependencies`: absent
- `scripts`: absent
- `engines`: absent
- `os`: absent
- `cpu`: absent
- Tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.0-rc.7.tgz`
- `dist.shasum`: `8a69013c06179d7af437de92fb4a9a2e1fd7d410`
- `dist.integrity`: `sha512-ZceDCJ8FAywih+USW/OMk9jEhunlvJBGEz4kqrhau23hPzbciOazZrywH0nBRsaalSeAJ1JGBmjtw4OSjToStw==`

The official package metadata does not declare a Node version requirement. A
Node 24 incompatibility therefore remains unconfirmed and must be tested rather
than assumed.

## Root-cause diagnostic evidence

### Case A — Node 24 + npm 11.16.0

- Fresh official-Registry install reached `idealTree` / `fetch manifest` /
  `placeDep` and naturally terminated after `616.9 s`.
- Peak root private memory: `2195.7 MB`; peak working set observed: about
  `2102.6 MB`.
- Fresh prefix remained empty.
- stderr ended with `FATAL ERROR: Reached heap limit Allocation failed -
  JavaScript heap out of memory`.
- Last debug-log region contained hundreds of DSH manifest fetches and
  `placeDep` entries, including DSH packages resolved to `0.1.0-rc.8` from
  caret ranges in the `0.1.0-rc.7` package graph.

Evidence root:
`C:\Users\韩吉衍\AppData\Local\Temp\dsh-release-gate-20260824-01\diagnostics\case-a2-node24-npm1116-official`

### Case B — Node 24 + npm 11.11.0

- Same command, official Registry, unique fresh prefix/cache, with only the
  npm CLI changed to `11.11.0`.
- Naturally terminated after `616.4 s` in the same dependency-resolution phase.
- Peak root private memory: `2232.8 MB`; peak working set observed: about
  `2144.8 MB`.
- Fresh prefix remained empty.
- stderr ended with `FATAL ERROR: Ineffective mark-compacts near heap limit
  Allocation failed - JavaScript heap out of memory`.

Evidence root:
`C:\Users\韩吉衍\AppData\Local\Temp\dsh-release-gate-20260824-01\diagnostics\case-b-node24-npm1111-official`

### Diagnostic conclusion

The blocker is confirmed as V8 heap exhaustion during npm Arborist ideal-tree
resolution of the real, large, caret-expanded DSH dependency graph. It is not
the previously fixed npm shim launch defect, an npm 11.16-only issue, a
Registry metadata failure, fresh-cache corruption, or timeout alone. No
Windows Application Error/WER record or crash dump was found; npm stderr and
the GC diagnostics identify the failure directly. The historical Task 13 run
recorded the corresponding bounded process result as exit code `134`.

Full report: `docs/runtime/dsh-runtime-install-blocker-root-cause.md`.

### Heap 4096 hypothesis test

An isolated Case C changed only the npm child environment to
`NODE_OPTIONS=--max-old-space-size=4096`.

- Duration: `730.6 s` bounded run
- Result: `TIMEOUT` after the diagnostic stop; no V8 fatal error observed
- Peak root private memory: approximately `3066.4 MB`
- Prefix result: empty; no verified runtime
- Evidence root:
  `C:\Users\韩吉衍\AppData\Local\Temp\dsh-release-gate-20260824-01\diagnostics\case-c-node24-npm1116-heap4096-official`

This confirms that the default V8 ceiling is causal but also that
`--max-old-space-size=4096` alone is not a sufficient Release Gate fix.

### Heap 8192 hypothesis tests

- First attempt with `NODE_OPTIONS=--max-old-space-size=8192` failed after
  `5.7 s` with official-Registry `ECONNRESET`; no graph evidence was used.
- Same-variable retry entered resolution and ran for `908.9 s` until the
  bounded diagnostic stop. It emitted no V8 fatal error, reached about
  `3433.2 MB` private memory, progressed farther into `idealTree`, but its
  prefix remained empty and no runtime was produced.
- Evidence root:
  `C:\Users\韩吉衍\AppData\Local\Temp\dsh-release-gate-20260824-01\diagnostics\case-e-node24-npm1116-heap8192-official-retry`

The heap setting changes the failure boundary but does not prove a stable real
install. The root-cause report records the full attempt matrix and recommends
a controlled lockfile/`npm ci` path or a CI-produced verified runtime artifact
if that remains necessary.

## Current Release Gate checklist

- [x] Real npm Registry metadata PASS
- [ ] Real pinned npm DSH install PASS — historical path BLOCKED by idealTree V8 heap exhaustion / bounded non-completion
- [x] Route B Factory artifact, hash, independent extraction, CLI/Web/Health/native PASS
- [x] Real bundled-runtime preparation consumes the verified artifact without npm
- [x] Real bundled package/CLI/descriptor/web/health PASS for the extracted/published artifact
- [ ] Real Managed update, restart persistence, rollback, external ownership, and pending activation PASS — not executable without a real runtime
- [x] Standard `npm run pack` PASS with explicit verified artifact
- [x] Standard `npm run dist`/NSIS PASS with explicit verified artifact
- [x] Isolated NSIS install and installed DSH CLI/Web/Health PASS
- [x] Real artifact updater E2E over local HTTP; npm installer calls: `0`
- [ ] Installed Electron Desktop update/restart/rollback and process cleanup PASS — not run; direct installed-runtime smoke is recorded above
- [x] Deterministic regression suite: `npm test` — `131 passed`, `0 failed`, exit 0
- [x] `git diff --check` — exit 0
- [x] Branch/worktree final check — `codex/dsh-runtime-updater`, clean after documentation commit
- [x] Diagnostic process cleanup — no baseline node/npm PID remained; reused PID 28700 was `WmiPrvSE`, not a diagnostic process

## Gate decision

Status remains: **BLOCKED**

DO NOT MERGE. The npm installation route remains blocked, and the verified
artifact route still lacks the real Desktop update/restart/rollback and
packaging/NSIS evidence required by this gate.



## Task 9 — Production Distribution evidence (2026-08-25)

This section appends Task 9 evidence and intentionally preserves all historical material above.

### Evidence classification

| Area | Status | Evidence and limitation |
| --- | --- | --- |
| Local production-distribution implementation | PASS | The checked-in Factory/Promotion workflows, CLI, candidate store, remote verification, stable-index, promotion, and rollback implementation are present at baseline `2e33fcb3d931e2c1dd5456889b463708bb47f789`. |
| Local dry run | PASS | Task 1–8 evidence records the deterministic dry-run and workflow-validation commands; Task 9 documentation does not reclassify this as remote deployment. |
| Factory workflow definition | PASS | `.github/workflows/dsh-runtime-factory.yml` has Windows x64 Factory, exact tag/commit resolution, candidate Release reconciliation, remote readback, durable marker, and no stable mutation. |
| Promotion workflow definition | PASS | `.github/workflows/dsh-runtime-promote.yml` is manual, validates exact candidates, requires the rollback marker, stages history, and deploys a complete Pages tree. |
| Public repository/remote | PASS | Local `origin` is `https://github.com/GehrmannMerlin/DeepSeek-harness-Desktop`; read-only repository/Release/Actions page probes returned HTTP 200. |
| Remote Releases state | BLOCKED | GitHub API returned HTTP 403 rate limit exceeded; no remote Release listing was independently established, and no Release mutation was attempted. |
| Remote Pages state | BLOCKED | Expected stable index probe returned HTTP 404; GitHub API Pages inspection returned HTTP 403 rate limit exceeded; no Pages deployment was attempted. |
| Remote Publish Gate authorization | AWAITING AUTHORIZATION | No explicit authorization or effective `contents: write`/Pages token verification was available for remote mutation. |
| Remote asset inspection | NOT PERFORMED | No candidate Release was created or available for authorized readback in this task. |
| Stable HTTPS index readback | NOT PERFORMED | No stable production URL is claimed or invented. |
| Installed Desktop HTTPS E2E | NOT PERFORMED | No installed Desktop run against a real Pages URL, restart persistence, or production rollback was performed. |
| Production zero npm/pnpm calls | NOT PERFORMED | Local implementation has the zero-call contract, but production installed E2E evidence is absent. |
| Public RELEASE READY | BLOCKED | Remains **NO** pending real production HTTPS hosting, installed Desktop E2E, restart persistence, and zero npm calls. |

### Gate decision

Local implementation and dry-run evidence are separate from the Remote Publish Gate. The local rows do not authorize or imply a remote Release/Pages deployment. Overall status remains **BLOCKED**; no remote mutation was performed locally.

## Task 10 — Local production Distribution gate evidence (2026-08-25)

This section appends Task 10 verification evidence and preserves all historical
gate material above. It records local observations only; it does not authorize
or perform a GitHub Release, Pages deployment, branch push, or production
promotion.

### Execution context

- Worktree used: `D:\Develop\DeepSeek Agent\DeepSeek Agent Desktop\.worktrees\dsh-runtime-distribution`
- Branch: `codex/dsh-runtime-distribution`
- HEAD before the evidence-only documentation commit: `a5421bb7d98f0cda534edcf73c0114a754bb5cea`
- Worktree was clean before the documentation update.
- The nominal `dsh-runtime-updater` directory supplied as the initial working
  directory was not a Git worktree and did not contain the application sources,
  plan, or Task 10 brief. The actual distribution worktree above contained the
  requested sources and task documents and was used for verification.

### Exact command results

| Command | Result |
| --- | --- |
| `node --test test/runtime-distribution-contract.test.js test/runtime-source-mapping.test.js test/runtime-candidate-store.test.js test/runtime-remote-verification.test.js test/runtime-stable-index.test.js test/runtime-distribution-cli.test.js test/runtime-distribution-workflows.test.js` | PASS; 86 tests, 86 passed, 0 failed, 0 skipped; exit 0; 487.186 ms |
| `npm run distribution:dry-run` | PASS; `candidatePublish=PUBLISHED`, `remoteVerification=REMOTE_VERIFIED`, stable `0.1.1-rc.2`, rollback `0.1.0-rc.7`, `npmInstallCalls=0`; exit 0 |
| `npm test` | PASS; 235 tests, 234 passed, 0 failed, 1 skipped, 0 todo; exit 0; 1834.5008 ms |
| `git diff --check` | PASS; exit 0 |
| `npm run distribution:validate-workflows` | PASS; `valid=true`; discovered `dsh-runtime-factory.yml` and `dsh-runtime-promote.yml`; exit 0 |
| `actionlint .github/workflows/dsh-runtime-factory.yml .github/workflows/dsh-runtime-promote.yml` | SKIPPED / NOT INSTALLED; `actionlint` was not available on PATH, and no installation was attempted |
| `if ($env:DSH_REAL_RUNTIME_ARTIFACT) { node --test test/runtime-artifact-update-e2e.test.js } else { ... }` | SKIPPED / NOT AVAILABLE; `DSH_REAL_RUNTIME_ARTIFACT` was not set |

The one full-suite skip is the existing real artifact HTTP/download E2E and is
consistent with the explicit environment-gated skip above. No real artifact
E2E result is claimed.

### Dry-run artifact and ordering evidence

The deterministic dry-run used the candidate fixture `0.1.1-rc.2` and the
previous candidate `0.1.0-rc.7`:

- Candidate artifact: 17 bytes,
  SHA-256 `f70cc052e512dc877d3fbcc8c1f254dc7270c7cb7e803a909a2c99a62ae71c2e`.
- Rollback artifact: 16 bytes,
  SHA-256 `a5565db19ccbcab3d505369668f576e1174c03e31b93338cb8c1a86cfd53b94a`.
- Stable promotion read back exact candidate version `0.1.1-rc.2`.
- Rollback read back exact previous version `0.1.0-rc.7`.
- npm dependency-resolution/installer calls: `0`.
- The CLI integration assertions observed candidate publication and readback,
  then `REMOTE_VERIFIED`, before stable-index read/validation/publication.
  Rollback likewise read the candidate before its remote verification and used
  the same verified promotion path.

### Remote-mutation and release-boundary audit

- No `git push`, `gh release create`, `gh release upload`, Pages deployment, or
  production URL write was executed.
- The deterministic tests and dry run use task-owned local temporary roots and
  injected adapters; they do not contact GitHub or mutate Releases/Pages.
- Workflow validation and static workflow tests preserve the boundary that
  Factory creates/verifies candidates while stable publication is a separate
  manual operation.
- Stable-index publication was observed only after remote-like verification in
  the local event-order assertions; no stable index was changed before
  verification.
- No remote Release, Pages, branch, or stable production state is inferred from
  these local results.

### Task 10 gate decision

Local Distribution implementation and deterministic local gates: **PASS**.
Remote mutation: **NOT PERFORMED**.
Real artifact E2E: **NOT PERFORMED — DSH_REAL_RUNTIME_ARTIFACT was not set**.
Public **RELEASE READY: NO**. The existing blockers remain: no real remote
candidate/Pages publication and no installed Desktop HTTPS update, restart,
rollback, and zero-npm production E2E evidence.
