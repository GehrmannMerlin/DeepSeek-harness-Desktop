# DeepSeek Harness Desktop — Final Release Gate Closure

> Validation round: 2026-08-25 (Asia/Shanghai)
> Branch: `codex/dsh-runtime-updater`
> Scope: Installed rollback, External Harness ownership/pending recovery, Update Operation Audit, and production Runtime Hosting boundary.

## Overall status

**STATUS: FEATURE BRANCH MERGE READY; PUBLIC RELEASE BLOCKED**

This is the opening record for the final closure round. The existing Runtime
Factory, Verified Runtime Artifact, artifact downloader, promotion/activation,
owned installed update, and restart-persistence evidence remain historical
inputs and are not rewritten here.

## Initial gate matrix

| Gate | Initial status | Closure evidence |
| --- | --- | --- |
| Rollback Gate | BLOCKED | Pending clean version-scoped one-shot fault E2E |
| External / Pending Gate | BLOCKED | Pending one combined installed lifecycle |
| Operation Audit Gate | BLOCKED | Pending persistent correlated event chain |
| Hosting Boundary Gate | UNKNOWN | Pending configured/missing/invalid/unreachable checks |

## Historical rollback failure — root-cause investigation

The previous test used a task-owned port blocker on `127.0.0.1:3080` after the
OLD Harness stopped. The evidence is preserved in the prior validation record;
the direct log lines were re-read during this round from the isolated userData
logs:

| Time | Evidence |
| --- | --- |
| T0 `2026-08-25T01:10:25.192Z` | Bundled OLD `0.1.0-rc.7`, PID `28112`, exposed `http://127.0.0.1:3080` and passed health. |
| T1 `2026-08-25T01:11:50.379Z` | Owned OLD stop began. |
| T2 | Test-owned blocker remained active on port `3080`. |
| T3 `2026-08-25T01:11:52.499Z` | Managed NEW `0.1.1-rc.2`, PID `13268`, started from the real managed CLI. |
| T4 `2026-08-25T01:11:55.263Z` | NEW stderr reported `listen EADDRINUSE: address already in use 127.0.0.1:3080`; NEW exposed no Harness URL. |
| T5/T6 | UpdateManager entered its rollback path and restored the bundled pointer. |
| T7 `2026-08-25T01:11:55.404Z` | Bundled OLD fallback PID `18684` started from the real bundled CLI. |
| T8 `2026-08-25T01:11:57.580Z` | Fallback OLD also reported `listen EADDRINUSE` on `127.0.0.1:3080`. |
| T9 `2026-08-25T01:11:57.604Z` | Renderer recorded `release_e2e_update_confirm_finished state=FAILED`. |

The prior test therefore affected both the target runtime and the fallback
runtime. It is not a reliable recoverability test. The correct classification
is:

> Previous rollback test was invalid for proving recoverability because the
> injected fault affected both the target runtime and the fallback runtime.

This evidence does not prove a Rollback implementation failure. The new test
must allow the real NEW process to start and fail only in the post-activation
health decision, after which the real bundled OLD fallback must run in a normal
system environment.

## Evidence log

New evidence will be appended below as each gate is completed. No production
hosting endpoint is assumed or created by this document.

## Closure evidence — 2026-08-25

### Installed Rollback Gate — PASS

The final NSIS installer was installed into an isolated directory and exercised
with the real packaged OLD runtime `0.1.0-rc.7`, a task-local verified index,
and the real managed NEW runtime `0.1.1-rc.2`. The controlled failure was
version-scoped and one-shot: it returned a failed post-activation health result
only for NEW `0.1.1-rc.2`; it did not hold port `3080` and did not affect the
bundled fallback.

Evidence root:
`C:\Users\韩吉衍\AppData\Local\Temp\dsh-final-installed-rollback-20260825-112438`

- Bundled OLD real Harness became healthy before the update.
- Operation ID: `update-1787628284584-1`.
- The observed transition sequence was:
  `CHECKING → UPDATE_AVAILABLE → PREPARING → INSTALLING → VERIFYING → READY_TO_APPLY → STOPPING_CURRENT → SWITCHING → RESTARTING → ROLLING_BACK → RESTARTING → ROLLED_BACK`.
- Managed NEW PID `25344` was started and reached the controlled post-activation
  failure boundary.
- Bundled OLD fallback PID `35808` started normally and passed real health.
- The terminal event was
  `operation_completed result=ROLLED_BACK durationMs=104108` followed by
  `release_e2e_update_confirm_finished state=ROLLED_BACK`.
- Persisted state ended at bundled OLD `0.1.0-rc.7`, `pending: null`, with
  `failedVersions["0.1.1-rc.2"]` recorded.
- Desktop exited through the normal quit path; exact task-owned process cleanup
  left port `3080` free.

The historical blocker test remains recorded above as invalid for proving
recoverability. It has not been rewritten or reclassified as a pass.

### External Harness Ownership Gate — PASS

Evidence root:
`C:\Users\韩吉衍\AppData\Local\Temp\dsh-final-external-pending-20260825-114000`

- External Harness PID `16032` was started independently from the installed
  bundled CLI and passed the real `waitUntilReady` check on `127.0.0.1:3080`.
- Desktop detected `existing_harness_check_finished state=harness` and logged
  `reusing existing harness at http://127.0.0.1:3080/`.
- The update reached `WAITING_FOR_EXTERNAL_HARNESS` after verification; no
  Desktop-owned stop/restart was attempted for the external process.
- Desktop normal quit logged `external harness left running`.
- After Desktop exited, PID `16032` was still alive, still owned the `3080`
  listener, and was the only matching `@deepseek-ai\\dsh\\lib\\bin.js web`
  process.
- The external process was then stopped separately with exact task-owned
  `taskkill /PID 16032 /T /F`; port `3080` became free.

### Pending Recovery Gate — PASS

The same isolated Desktop userData was relaunched after the external process
was stopped. The pending activation was recovered using the real installed
Desktop and the task-local verified index:

- Bundled OLD Harness started and passed health.
- The persisted pending target `0.1.1-rc.2` was applied on restart.
- Managed NEW PID `34784` started from the persisted managed runtime and passed
  real health in `62ms`.
- The correlated operation ID was
  `update-1787628869680-1`; its terminal chain ended in
  `SUCCESS`, followed by a second check operation
  `update-1787628874379-2` ending in `UP_TO_DATE`.
- Final persisted state was managed `0.1.1-rc.2`, `pending: null`, empty
  `failedVersions`, and no managed process or `3080` listener remained after
  normal shutdown.

### Update Operation Audit Gate — PASS

The manager now emits structured JSON audit records through the existing
application logger without adding a database or changing the runtime-state
schema. Focused tests and the installed logs cover correlated operation IDs for
`SUCCESS`, `ROLLED_BACK`, `FAILED`, `UP_TO_DATE`, and the external waiting
boundary. Each normal terminal operation includes `operation_completed` with a
result and duration; state transitions carry the same `operationId`, old and
target versions, and PID where available.

### Runtime Hosting Boundary Gate — PASS for client boundary; production hosting remains unconfigured

The verified runtime source now has an explicit configuration boundary:

- configured task-local fixture: real installed download/verification/update
  path passed;
- missing index URL: source logs
  `verified_runtime_source_not_configured`, skips registry access and artifact
  mutation, and manual update reports
  `VERIFIED_RUNTIME_SOURCE_NOT_CONFIGURED`;
- malformed URL and unreachable endpoint: focused source tests pass with
  distinct source errors;
- no production hosting endpoint was created, deployed, or inferred from the
  task-local fixture.

This is intentionally a public-release boundary, not a claim that production
distribution hosting is live.

## Final gate matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| Installed Rollback | PASS | Final installed EXE, healthy OLD fallback, persisted rollback state |
| External Harness ownership | PASS | External PID survives Desktop normal quit; exact PID later stopped separately |
| Pending Recovery | PASS | Same userData restart activates NEW, clears pending, reaches UP_TO_DATE |
| Operation ID / Audit | PASS | Correlated structured records for success, rollback, failure, waiting, and up-to-date paths |
| Hosting client boundary | PASS | Configured, missing, malformed, and unreachable source cases covered |
| Production hosting | NOT CONFIGURED | No production endpoint was requested or deployed |

## Decision

FEATURE BRANCH MERGE READY: YES

PUBLIC RELEASE READY: NO

The feature branch is ready for review/merge from the code-and-test gate
perspective. Public release remains blocked because production Runtime Index
and artifact hosting are intentionally not configured or deployed in this
task. No GitHub Release, production publication, or external announcement was
made.

## Stage 2 Production HTTPS final gate (2026-08-26)

The previous decision above describes the earlier intentionally unconfigured
hosting boundary. Stage 2 subsequently validated the authorized production
candidate and Pages path with an installed Desktop; that historical decision is
preserved, while this section is the current Stage 2 result.

| Gate | Result | Evidence |
| --- | --- | --- |
| Stable HTTPS index | PASS | HTTP 200, final rc.2 exact size/SHA/URL |
| Candidate remote verification | PASS | rc.2 and rc.7 Release assets; `REMOTE_VERIFY=REMOTE_VERIFIED` |
| Installed OLD bundled runtime | PASS | NSIS install, bundled manifest/CLI rc.7 |
| Real Electron + renderer IPC update | PASS | `UPDATE_AVAILABLE` → `SUCCESS`, operation `update-1787734603256-1` |
| Artifact redirect/download/hash | PASS | 302→200, 69,086,249 bytes, 21,182 ms, exact SHA |
| Extraction/verifier/promotion/NEW health | PASS | managed rc.2 manifest and 74 ms restart health |
| Restart persistence | PASS | same userData managed rc.2, `UP_TO_DATE`, no download |
| Official rollback | PASS | workflow run 32950819410, stable rc.7 |
| Managed/OLD rollback no-op | PASS | both clients no download or downgrade |
| Official restore | PASS | workflow run 32951216611, stable rc.2 readback |
| npm/pnpm production installer path | PASS | verified artifact path; local real artifact E2E installer calls 0 |
| Factory performance gate | PASS | `FACTORY_PERFORMANCE_ACCEPTED=true`; cheap detection `NO_OP` |
| Public Desktop installer publication | NOT PERFORMED | local installer only |
| Windows code signing | NOT CONFIGURED | no certificate/configuration added |

### Stage 2 decision

Production runtime distribution and installed Desktop update/restart/rollback/
restore: **PASS**.

The public installer and code-signing boundaries remain explicitly outside this
run: **NOT PERFORMED** and **NOT CONFIGURED**, respectively. The checked-in
scheduled gate is restored; a real cron tick was not artificially awaited after
the cheap no-op path was directly verified.
