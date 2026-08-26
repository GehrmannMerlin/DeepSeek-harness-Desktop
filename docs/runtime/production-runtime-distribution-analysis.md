# Production Runtime Distribution Analysis

Date: 2026-08-25 (Asia/Shanghai)
Scope: Task 9 documentation, observed from the current local checkout and read-only HTTPS probes.
Repository under review: `GehrmannMerlin/DeepSeek-harness-Desktop`

## Decision and evidence boundary

The production distribution design is implementable locally, but the Remote Publish Gate is not satisfied in this worktree. No GitHub Release was created or mutated, no GitHub Pages tree was uploaded or deployed, and no stable production URL is asserted below. Local workflow files, CLI validation, and dry-run behavior are implementation evidence only; they are not evidence that remote hosting exists or that Desktop can reach a deployed index.

The pre-Task-9 baseline is `2e33fcb3d931e2c1dd5456889b463708bb47f789`. The implementation-time observations below were collected on 2026-08-25.

## 2026-08-26 Factory performance blocker

The third real Windows Factory run was `32865356755` ([run URL](https://github.com/GehrmannMerlin/DeepSeek-harness-Desktop/actions/runs/32865356755)), on desktop commit `819ca2c076feddf478afb5411be4a2c3ff5d3bae`. Its pre-artifact phases passed, including the exact rc.2 source mapping, upstream build, isolated deploy, peer closure, and isolated CLI smoke. The run failed at `Build verified Windows x64 runtime artifact` at `2026-08-25T18:26:41Z`, after approximately 3 hours 4 minutes, with `ENOSPC: no space left on device` inside repeated `cloneMaterializedTree()` `copyFile()` calls.

This is a Factory performance/storage blocker. No fourth full Factory was started. The failed Windows runner was ephemeral and uploaded only `factory.log`; the verified isolated rc.2 runtime tree was not retained, so an exact-tree artifact-only benchmark cannot honestly be claimed from this checkout. The next authorized step is to run `npm run distribution:benchmark-artifact` against that same verified tree if it is retained by a future diagnostic workflow; it must finish ZIP, SHA, independent extraction, and verification before another full Factory run.

An additional scheduled run `32885958573` ([run URL](https://github.com/GehrmannMerlin/DeepSeek-harness-Desktop/actions/runs/32885958573)) on the same old commit reproduced the same `ENOSPC` in `cloneMaterializedTree()` after approximately 3 hours 5 minutes. After the direct-archive change was pushed, scheduled run `32920257549` was explicitly cancelled at approximately 17 minutes while still in the artifact phase; it produced no candidate or stable publication.

The artifact builder now defaults to direct ZIP entry generation from the scanned runtime tree. It preserves the existing ZIP layout contract, expands only regular file bytes, rejects links escaping the allowed runtime boundary, skips recursive back-edges, and reports millisecond timings and periodic heartbeats for pre-scan, materialization/copy, ZIP, SHA-256, independent extraction, and independent verification. Local fixture tests pass, but are implementation evidence only and are not rc.2 production evidence.

## Ten infrastructure questions

### 1. Does a public repository/remote exist?

Yes, a Git remote is configured locally:

```text
origin  https://github.com/GehrmannMerlin/DeepSeek-harness-Desktop
```

Read-only HTTPS HEAD probes returned HTTP 200 for the repository page, Releases page, and Actions page. This confirms an accessible GitHub repository endpoint and the configured remote URL. The GitHub API visibility request returned HTTP 403 because of API rate limiting, so this document does not infer additional account or permission facts from that API response.

### 2. What is the Releases state?

The repository Releases page was reachable over HTTPS, but no Release API listing was available locally because GitHub returned HTTP 403 rate limit exceeded. The checked-in Factory workflow defines the intended immutable candidate shape—tag `dsh-runtime-v<VERSION>`, a published prerelease, `dsh-runtime-<VERSION>-win32-x64.zip`, and `runtime-index.json`—but that local definition is not evidence that a candidate Release exists remotely.

Observed state for this task: `AWAITING AUTHORIZATION / NOT VERIFIED REMOTELY`. No Release was created, uploaded, patched, or deleted.

### 3. What is the Pages state?

The checked-in promotion workflow requests `pages: write` and uses `actions/upload-pages-artifact@v3` followed by `actions/deploy-pages@v4`. The expected stable path is:

```text
https://<owner>.github.io/<repository>/runtime/stable/runtime-index.json
```

For this repository, a read-only HEAD probe of the expected URL,
`https://gehrmannmerlin.github.io/DeepSeek-harness-Desktop/runtime/stable/runtime-index.json`,
returned HTTP 404. The GitHub API Pages endpoint also returned HTTP 403 rate limit exceeded. Therefore Pages is not proven enabled or deployed, and no stable URL is published in this documentation.

Observed state: `BLOCKED / NOT VERIFIED REMOTELY`.

### 4. Is another Pages site already using the repository or expected path?

No other Pages use was observed in the local repository contents or workflow configuration. The only Pages consumer in the Task 1–8 implementation is the runtime promotion workflow, which stages `runtime/stable/` and `runtime/history/` as one Pages artifact. A 404 from the expected stable index does not prove that no unrelated Pages site exists, so ownership and collision checks remain part of the Remote Publish Gate.

Observed state: `NOT VERIFIED REMOTELY`; local collision evidence: none observed.

### 5. Where is distribution storage?

The local dry run uses a filesystem root supplied to the distribution CLI and stores immutable candidates beneath `candidates/candidate-<VERSION>/`, with stable state beneath `runtime/stable/` and rollback history beneath `runtime/history/`. In production, the Factory stores the ZIP and `runtime-index.json` as GitHub Release assets; the promotion workflow downloads those assets into a temporary runner root and publishes the complete `runtime/` tree to GitHub Pages. Pages is the Desktop read surface; GitHub Release assets are the immutable candidate source.

The checked-in workflow also writes logs and optional metadata as Actions artifacts. Those are audit logs, not the Desktop distribution store. No remote Release asset or Pages object was created during this task.

### 6. What CI exists?

Two checked-in workflows exist:

- `.github/workflows/dsh-runtime-factory.yml` — scheduled every six hours and manually dispatchable; Windows runner; resolves npm latest or an exact requested version; checks out exact upstream `dsh-v<VERSION>`; builds the Windows x64 Factory artifact; reconciles candidate Release assets; performs remote readback; and writes a failure-derived summary.
- `.github/workflows/dsh-runtime-promote.yml` — manual dispatch only; accepts exact `version` and `operation` (`promote` or `rollback`); verifies candidate assets; generates the stable index; stages history; uploads the complete Pages tree; and deploys Pages.

Local scripts expose `npm run distribution:dry-run` and `npm run distribution:validate-workflows`. Local workflow validation passed in Task 8 evidence, but no GitHub Actions run was started from this worktree.

### 7. Is `contents: write` available?

The Factory workflow declares:

```yaml
permissions:
  contents: write
```

This is the workflow's requested permission for candidate Release creation, asset upload/reconciliation, and the durable remote-verification marker. The promotion workflow deliberately declares `contents: read`, `pages: write`, and `id-token: write`; it does not request contents write. A checked-in permission declaration is not proof that repository policy or the eventual run token grants it. The effective token permission remains to be confirmed during an authorized Remote Publish Gate run.

### 8. Where does Desktop get the index URL?

`src/update/verified-runtime-update-source.js` defines:

```js
const DEFAULT_INDEX_URL = process.env.DSH_VERIFIED_RUNTIME_INDEX_URL || '';
```

The `VerifiedRuntimeUpdateSource` constructor accepts an injected `indexUrl`, and otherwise uses that environment variable. There is no checked-in production GitHub Pages URL or GitHub HTML parsing fallback. The URL must be supplied by deployment/runtime configuration and the fetched JSON must pass the schema and artifact validation.

### 9. What happens when the source is absent?

An empty URL is not treated as npm latest and does not trigger an installer. The request path raises the typed `VERIFIED_RUNTIME_SOURCE_NOT_CONFIGURED` error; the update manager can record an unavailable verified source and leave the active runtime untouched. Invalid, unreachable, malformed, or empty artifact sets are likewise rejected. This is the safe behavior for development builds, first boot, an unconfigured production build, a missing Pages deployment, or a temporary Pages outage.

### 10. What evidence is still absent?

The following are not established by local implementation:

- an authorized candidate Release with the exact ZIP, manifest/index, provenance, source tag, source commit, SHA-256, and remote readback;
- an authorized Pages deployment with a real HTTPS stable index;
- installed Desktop E2E against that HTTPS index, including update, restart persistence, rollback, and external-process ownership;
- evidence that production update flows make zero npm/pnpm installation calls;
- a verified recovery run that points stable back to a previous candidate.

Consequently, public `RELEASE READY` remains `NO`.

## Stage 2 production HTTPS validation update (2026-08-26)

The earlier analysis above intentionally described a pre-authorization state.
The authorized Stage 2 run subsequently created/validated the rollback
candidate, promoted stable, exercised an installed Desktop, rolled stable back,
and restored stable. Historical statements remain unchanged; this section is
the current evidence boundary.

### Current remote state

The final stable index is live at
`https://gehrmannmerlin.github.io/DeepSeek-harness-Desktop/runtime/stable/runtime-index.json`
and returned HTTP 200. Its sole win32/x64 artifact is rc.2 with 69,086,249
bytes and SHA-256
`5f6efe25a0704da248e7ac2a6d34b6be4a5560b2c3cdebebc5d567c5edc4d837`, pointing
to the exact rc.2 GitHub Release asset. The candidate Release is independently
remote-verified. The rc.7 rollback candidate is also published and retained;
neither Release was deleted or overwritten.

### Production client path

The final installed executable was generated from the repaired source and
installed into an isolated task directory. The bundled runtime manifest was
rc.7 and the bundled CLI returned rc.7. With the production stable URL supplied
through the explicit E2E configuration seam, the real Electron/renderer path
recorded `UPDATE_AVAILABLE` rc.7 → rc.2, a 302→200 Release download,
69,086,249 exact bytes and SHA in 21,182 ms, extraction, verification,
promotion, owned Harness restart, health success, and renderer `SUCCESS`.

The persisted state after the first process was managed rc.2 with no pending
activation or failed-version suppression. A second launch started the managed
rc.2 CLI and ended `UP_TO_DATE` without downloading. This directly closes the
previously absent installed Desktop/restart gate.

### Rollback behavior

Official Promotion workflow run 32950819410 moved stable to rc.7. A managed
rc.2 client observed stable rc.7 as older and remained on managed rc.2 without
downgrade. A fresh OLD rc.7 client observed the same stable version and ended
`UP_TO_DATE` without download. Official Promotion workflow run 32951216611
then restored stable to rc.2; final HTTPS readback matched the Release asset.

### Runtime transport fixes

Two production compatibility issues were found by evidence rather than
assumption: cold Pages index tail latency exceeded the old 4-second default,
and GitHub Release assets use an ordinary 302 redirect. The source timeout is
now 15 seconds, still bounded and post-paint. Artifact download uses native
Node 24 fetch, a maximum of five HTTP/HTTPS redirects, `Readable.fromWeb`
streaming, SHA-256/byte-count verification, and structured progress logs. The
implementation does not install or resolve DSH through npm/pnpm.

### Factory gate and remaining boundary

`FACTORY_PERFORMANCE_ACCEPTED` is now `true` in the checked-in Factory
workflow. Cheap detection resolved latest rc.2, found the existing
`dsh-runtime-v0.1.1-rc.2` candidate, and selected `NO_OP`; no expensive Factory
was started. This exact detection path was run locally because waiting for a
cron tick would be opaque and would add no evidence after the candidate already
existed. A real scheduled event is therefore not claimed.

Final operational boundary: production runtime distribution and installed
Desktop update are validated; public Desktop installer publication was not
performed and Windows code signing was not configured.
