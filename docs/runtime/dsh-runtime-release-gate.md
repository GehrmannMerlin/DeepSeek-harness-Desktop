# DSH Runtime Release Gate

Date: 2026-08-24 (Asia/Shanghai)
Worktree: `D:\Develop\DeepSeek Agent\DeepSeek Agent Desktop\.worktrees\dsh-runtime-updater`
Branch: `codex/dsh-runtime-updater`

Status: BLOCKED

## Initial blocker

Real DSH package installation does not complete successfully.
One bounded real npm process exited with code 134.
No verified real bundled runtime exists.

This document records fresh Release Gate evidence for this task. The historical
Task 13 record remains in `docs/runtime/dsh-runtime-update-verification.md` and
is not overwritten.

## Evidence log

Fresh evidence will be appended below as each Release Gate step is completed.

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
- [ ] Real pinned DSH install PASS — BLOCKED by idealTree V8 heap exhaustion / bounded non-completion
- [ ] Real bundled-runtime preparation PASS — not run after real install remained unproven
- [ ] Real bundled package/CLI/descriptor/web/health PASS — no real runtime exists
- [ ] Real Managed update, restart persistence, rollback, external ownership, and pending activation PASS — not executable without a real runtime
- [ ] Standard `npm run pack` and `npm run dist` PASS — intentionally not run against a missing real runtime
- [ ] Real NSIS install, installed launch/update, and process cleanup PASS — not executable without a real runtime
- [x] Existing deterministic tests previously passed at `107 passed`, `0 failed`; a fresh final regression is still required
- [ ] `git diff --check` — final check pending

## Gate decision

Status remains: **BLOCKED**

DO NOT MERGE. The real DSH install has not produced a verified runtime after
the Node 24/npm 11.16, Node 24/npm 11.11, 4096-heap, and 8192-heap attempts.
