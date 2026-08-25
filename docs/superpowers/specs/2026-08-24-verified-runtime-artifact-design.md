# Verified Runtime Artifact Design

**Status:** Approved direction from the task brief; implementation proceeds on `codex/dsh-runtime-updater`.

## Context

The existing Desktop updater observes npm latest and then installs an exact DSH
version locally. The real rc.7 dependency graph causes npm Arborist to consume
the available V8 heap before it can create a usable tree. A successful
`--legacy-peer-deps` install is not sufficient: its real CLI failed to load the
Web/plugin graph because a runtime-mounted peer package was missing.

The Runtime Factory experiment established a working controlled route: the
official rc.7 source revision `99f6f02fe`, Node 24, `pnpm@11.7.0`, frozen
lockfile, official build, and a runtime closure containing the profile-mounted
workspace packages plus Windows native dependencies. That runtime passed CLI,
Web, health, and native smoke.

## Design

Introduce three focused boundaries:

1. `VerifiedRuntimeArtifact` validates one manifest and its exact ZIP identity.
2. `VerifiedRuntimeUpdateSource` reads and validates a machine-readable index
   and returns verified latest metadata for win32-x64.
3. `RuntimeArtifactDownloader` streams an artifact to an operation staging file,
   verifies SHA-256, safely extracts it, and returns the extracted root.

The existing runtime manager owns validation/promotion/activation/rollback. The
existing update state machine remains the orchestrator, but its production
preparation dependency changes from `NpmInstaller` to the artifact source and
downloader. `NpmRegistryUpdateSource` stays available for upstream observation
and diagnostics only.

## Data flow

`NpmRegistryUpdateSource.getLatest()` produces `upstreamLatestVersion`; it is
not compared directly to the installed runtime for UI. The verified source
loads `runtime-index.json`, validates all entries, selects `win32-x64`, and
produces `verifiedLatestVersion`. The update manager compares the installed
descriptor only with the verified version.

On confirmation, the downloader writes `artifact.zip.part`, closes the stream,
renames it to `artifact.zip`, checks the expected SHA-256, extracts under the
operation staging root, and invokes the existing `verifyRuntime()` function.
Only after verification does `DshRuntimeManager.promoteStaging()` run. Process
ownership and all rollback/pending semantics remain unchanged.

## Error handling

Invalid JSON, invalid SemVer, wrong package/platform/arch, missing hash/size,
HTTP errors, timeout, partial download, hash mismatch, unsafe archive entry,
and extracted runtime verification failure all produce a failed update without
changing the active runtime. `.part` files are cleaned on download failure.
The old runtime is never stopped for a failed hash or extraction operation.

## Testing strategy

Test-first implementation covers:

- valid/invalid index and manifest schema;
- upstream-versus-verified version semantics;
- stream download success, timeout, HTTP failure, and `.part` cleanup;
- SHA-256 match/mismatch;
- Zip Slip and absolute-path rejection;
- update integration proving zero npm installer calls;
- existing rollback, external ownership, pending activation and restart tests;
- artifact extraction followed by the real `verifyRuntime()` contract.

The final release gate remains blocked until the frozen ZIP itself, Desktop
artifact update, restart persistence, rollback, real bundled runtime, pack,
dist, NSIS install, installed update, and full regression suite all pass.
