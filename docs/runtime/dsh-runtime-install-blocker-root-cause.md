# DSH Runtime Install Blocker — Root Cause Report

Date: 2026-08-24 (Asia/Shanghai)
Worktree: `D:\Develop\DeepSeek Agent\DeepSeek Agent Desktop\.worktrees\dsh-runtime-updater`
Branch: `codex/dsh-runtime-updater`
Package under test: `@deepseek-ai/dsh@0.1.0-rc.7`

## Symptom

The real pinned DSH package does not produce a usable runtime in an isolated
prefix. The prefix remains empty because npm fails during dependency-tree
resolution before reify/extraction can publish a package tree.

## Reproduction

Both diagnostic installs used the project preparation flags and changed only
the npm CLI version between cases:

```text
node <npm-cli.js> install
  --prefix <fresh-prefix>
  --ignore-scripts --no-package-lock --no-save
  --no-audit --no-fund
  --registry https://registry.npmjs.org
  --cache <fresh-cache>
  --loglevel verbose --timing --foreground-scripts
  --fetch-retries 0 --fetch-timeout 30000
  @deepseek-ai/dsh@0.1.0-rc.7
```

The first connectivity probe used Node 24 with the current direct npm CLI and
ended after 5.6 seconds with `ECONNRESET` while opening the DSH packument. It
was not used as a root-cause claim. A repeat with the same official Registry
completed the intended resolution path and produced the diagnostic evidence
below.

## Environment

- OS: Windows 11 build 26200
- Node.js: `v24.18.0` (`D:\Develop\node.js\node.exe`)
- npm CLI case A: `11.16.0` (`D:\Develop\node.js\node_modules\npm\bin\npm-cli.js`)
- npm CLI case B: `11.11.0` (`D:\Develop\node.js\node_global\node_modules\npm\bin\npm-cli.js`)
- Official Registry: `https://registry.npmjs.org`
- Each case used a unique task-owned prefix and cache
- Free physical memory before testing: approximately `1847.9 MB`
- Free `C:` disk before testing: approximately `20.66 GB`

The package metadata declares no `engines`, `os`, or `cpu` restriction. Node
24 is therefore not rejected by the package contract, and was not assumed to
be incompatible.

## Evidence

### Case A — Node 24 + npm 11.16.0

- Diagnostic root: `C:\Users\韩吉衍\AppData\Local\Temp\dsh-release-gate-20260824-01\diagnostics\case-a2-node24-npm1116-official`
- Duration: `616.9 s`
- Last phase: `idealTree` / `fetch manifest` / `placeDep`
- Peak root process private memory: `2195.7 MB`
- Peak root process working set observed: approximately `2102.6 MB`
- Prefix result: zero files; no runtime produced
- Last manifest region: `@deepseek-ai/dsh-client-modules@^0.1.0-rc.8`
- Fatal error: `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`
- GC evidence: V8 mark-compact near a `2028 MB` heap
- Historical Task 13 run recorded the corresponding bounded npm result as exit
  code `134`; this fresh PowerShell process wrapper did not expose a numeric
  exit code after the V8 fatal termination, but the stderr fatal error is
  conclusive for the failure mechanism.

### Case B — Node 24 + npm 11.11.0

- Diagnostic root: `C:\Users\韩吉衍\AppData\Local\Temp\dsh-release-gate-20260824-01\diagnostics\case-b-node24-npm1111-official`
- Duration: `616.4 s`
- Last phase: `idealTree` / `fetch manifest` / `placeDep`
- Peak root process private memory: `2232.8 MB`
- Peak root process working set observed: approximately `2144.8 MB`
- Prefix result: zero files; no runtime produced
- Last manifest region: `@deepseek-ai/dsh-client-modules@^0.1.0-rc.8`
- Fatal error: `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`
- GC evidence: V8 mark-compact around a `2025 MB` heap

### Dependency graph evidence

The official `0.1.0-rc.7` metadata contains 61 direct dependencies. Its DSH
dependency ranges use caret ranges such as `^0.1.0-rc.7`, and npm resolved
many transitive DSH packages to `0.1.0-rc.8` while building the ideal tree.
The verbose log contains hundreds of manifest fetches and `placeDep` entries;
the process dies before extraction/reify and before a package tree can exist.

### Windows crash evidence

- Application Event Log query around the crash windows: no matching
  `Application Error`, `Windows Error Reporting`, `node.exe`, or `npm` event
  found.
- WER report archive/queue and the user CrashDumps directory: no new node/npm
  crash dump or report found.
- npm debug logs and stderr contain the V8 fatal heap message directly.

## Diagnostic matrix

| Case | Node | npm | Registry | Result | Duration | Peak private memory |
| --- | --- | --- | --- | --- | ---: | ---: |
| Connectivity probe | 24.18.0 | 11.16.0 direct CLI | official | `ECONNRESET`, no tree | 5.6 s | n/a |
| A | 24.18.0 | 11.16.0 | official | V8 heap OOM during idealTree; no tree | 616.9 s | 2195.7 MB |
| B | 24.18.0 | 11.11.0 | official | V8 heap OOM during idealTree; no tree | 616.4 s | 2232.8 MB |

## Root cause

**Confirmed:** the bounded `exit 134` is caused by Node/V8 JavaScript heap
exhaustion inside npm Arborist's ideal-tree dependency resolution. The DSH
package's large, caret-expanded dependency graph requires more than the
default roughly 2 GB V8 heap available to this Node process on this machine;
npm therefore aborts before it can reify a real package tree.

The primary root cause is the combination of the real DSH dependency graph and
the default V8 heap ceiling, not an npm shim launch failure, Registry metadata
failure, or a timeout by itself.

## Rejected hypotheses

- Windows `npm.cmd` + `shell:false`: already fixed by the committed npm
  invocation resolver; fresh direct-CLI runs reached dependency resolution.
- npm 11.16-only defect: rejected by the npm 11.11 A/B case, which failed with
  the same heap-limit mechanism and similar peak memory.
- Official Registry metadata access: metadata query returned `0.1.0-rc.7`
  successfully; both install cases fetched hundreds of official manifests.
- Registry mirror configuration: rejected as the only cause for the fresh
  cases because both explicitly used `https://registry.npmjs.org` and failed
  after substantial successful fetches.
- Cache corruption: rejected as the only cause because both cases used unique
  fresh caches and showed the same failure.
- Timeout as the sole cause: rejected because both npm processes naturally
  reached a V8 fatal error before the bounded diagnostic limit.
- Native package build/postinstall: rejected for these cases because
  `--ignore-scripts` was used and the crash occurred in idealTree before
  extraction.
- A package-declared Node incompatibility: rejected as unsupported by current
  metadata because `engines.node` is absent; the issue is still a toolchain
  capacity/graph-resolution problem.

## Fix decision gate

The next hypothesis to test is a preparation-only increase of the Node/V8 heap
for the real npm child, using the smallest bounded value that can complete the
real install on this machine. This is now evidence-based, not a speculative
workaround: both fresh cases ended with V8 heap-limit diagnostics at the
default ceiling. The updater architecture, UI, and runtime state machine do
not need to change for this root cause.

### Heap 4096 experiment

An isolated follow-up changed only the child environment to
`NODE_OPTIONS=--max-old-space-size=4096` while retaining Node 24.18.0, npm
11.16.0, the official Registry, fresh prefix/cache, and the same preparation
flags. The process ran for `730.6 s` until the bounded diagnostic stop, reached
approximately `3066.4 MB` private memory, emitted no V8 fatal error, but still
produced no package tree or runtime. Therefore the 4096 setting removes the
first default heap ceiling but is not, by itself, a sufficient Release Gate
fix within the bounded run.

### Heap 8192 experiment

A same-variable retry entered resolution successfully with
`NODE_OPTIONS=--max-old-space-size=8192` and a `15 minute` bounded window. It
did not emit a V8 fatal error, and its npm debug log progressed farther into
`idealTree` than the 4096 run, but it still timed out after `908.9 s` with an
empty prefix. Peak private memory was approximately `3433.2 MB`; the last log
entries were still `idealTree` manifest/placeDep work. A separate first 8192
attempt failed in `5.7 s` with the already observed official-Registry
`ECONNRESET` and is not used as a heap result.

The evidence therefore supports the following refined conclusion: the default
V8 heap ceiling is a confirmed trigger for the historical exit 134, but a live
desktop/build-time npm resolution of this DSH graph is not proven viable merely
by increasing the heap. A deterministic lockfile-based or verified prebuilt
runtime artifact is required before Release Validation can proceed on this
machine.

## Attempt matrix

| Attempt | Change | Result | Runtime produced? |
| --- | --- | --- | --- |
| A1 | Node 24 + npm 11.16, official, fresh prefix/cache | `ECONNRESET` while fetching DSH packument | No |
| A2 | Node 24 + npm 11.16, official, fresh prefix/cache | V8 heap OOM during idealTree after 616.9 s | No |
| B | Node 24 + npm 11.11, official, fresh prefix/cache | V8 heap OOM during idealTree after 616.4 s | No |
| C | A2 + `NODE_OPTIONS=--max-old-space-size=4096` | Bounded timeout after 730.6 s; no fatal, no tree | No |
| D | A2 + `NODE_OPTIONS=--max-old-space-size=8192` | `ECONNRESET` before graph resolution | No |
| E | D retry, same 8192 setting | Bounded timeout after 908.9 s; no fatal, no tree | No |

## Recommended next architecture

Do not make the Desktop release gate depend on resolving this mutable,
caret-expanded DSH graph live on the developer or end-user machine. The next
engineering decision should be one of these deterministic approaches, in
order:

1. In a controlled build/preparation environment, produce and review a
   version-pinned lockfile for the exact DSH runtime, then validate `npm ci`
   with a real package tree and repeat the full smoke. The lockfile must be
   regenerated and revalidated for every DSH version update.
2. If a verified lockfile install still cannot complete reliably, publish a
   CI-produced, hash-verified DSH runtime artifact containing the complete real
   dependency tree and bundle that artifact through the existing
   `extraResources` path. Keep the current Bundled/Managed/External ownership
   and state architecture unchanged.

Increasing `NODE_OPTIONS`, changing the npm timeout, switching package
managers, changing registries, or asking users to change Node versions is not a
validated Release Gate solution from the evidence collected here.
