# DSH Runtime Production Distribution Design

Date: 2026-08-25  
Branch: `codex/dsh-runtime-distribution`  
Status: Approved for implementation planning

## 1. Goal and boundary

This subsystem turns the already-merged Verified Runtime Artifact and Runtime
Updater into a production-capable distribution pipeline for Windows x64.
It discovers the npm `dist-tags.latest` version, resolves an exact upstream
source tag, builds and verifies a candidate with the existing Runtime Factory,
publishes an immutable candidate Release Asset, re-verifies the public HTTPS
asset, and waits for an explicit human promotion before changing the stable
runtime channel.

The Desktop remains a manual-update client. It consumes only the stable
`runtime-index.json` configured through `DSH_VERIFIED_RUNTIME_INDEX_URL`; it
does not enumerate GitHub Releases, resolve npm dependencies, or silently
install a candidate.

This round does not publish a Desktop installer, change the Desktop version,
add code signing, implement delta updates, add Electron auto-update, or add
non-Windows targets.

Remote mutation is outside the local implementation gate. The code, workflows,
tests, and local dry run must pass before any branch push, Release creation,
Pages enablement, Pages deployment, or production promotion is attempted.

## 2. Current repository facts

- `main` contains the Runtime Updater integration through `68ce90b`.
- The new implementation is isolated on
  `codex/dsh-runtime-distribution`.
- The repository is public on GitHub and currently has no checked-in Actions
  workflows or visible Releases.
- No existing object-storage service or Pages deployment is part of the local
  repository configuration.
- The existing artifact contract is `schemaVersion: 1` with an `artifacts`
  array. The Desktop source validates `packageName`, exact SemVer, platform,
  architecture, HTTPS/HTTP URL, byte size, SHA-256, and manifest identity.
- The existing Factory entry point is
  `scripts/build-verified-runtime-artifact.js` and already performs package
  identity, CLI, Web, health, native, archive, extraction, and second-smoke
  validation.
- The known source repository is `deepseek-ai/deepseek-harness`. The source
  mapping for a target version is the exact tag `dsh-v<VERSION>`; a missing tag
  is a hard failure and never falls back to `master` or another branch.

## 3. Hosting architecture

The first production implementation uses two GitHub-hosted surfaces:

1. GitHub Release Assets hold immutable, versioned runtime ZIPs and their
   metadata. Candidate Release tags use `dsh-runtime-v<VERSION>`.
2. GitHub Pages serves a small stable index at
   `runtime/stable/runtime-index.json`. A Pages deployment is generated as a
   complete site and deployed once, so the stable pointer is not written before
   the referenced artifact exists and has passed remote verification.

The stable index is the only Desktop update entry point. Candidate Releases
are not a client discovery API. Pages history and the Git history/deployment
history preserve previous stable index states for operator rollback.

The production URL is configuration, not a hidden fallback in the updater. A
missing `DSH_VERIFIED_RUNTIME_INDEX_URL` remains a safe, explicit
`VERIFIED_RUNTIME_SOURCE_NOT_CONFIGURED` condition. The runbook records the
public Pages URL to use once Pages is enabled and deployed.

## 4. Version and channel model

The pipeline keeps three distinct values:

```text
upstreamLatest  = npm registry dist-tags.latest
candidateVersion = exact version with a built and published candidate
verifiedLatest  = version represented by the stable runtime-index.json
```

`upstreamLatest` is observed from the official npm registry and must be valid
SemVer. `candidateVersion` becomes eligible only after the complete local and
remote verification contract passes. `verifiedLatest` changes only through a
manual Promotion workflow.

The stable index continues to use the existing `schemaVersion: 1` and
`artifacts: []` contract. It contains only promoted, exact artifact entries.
Older entries may be retained for rollback only if the Desktop's current
selection behavior remains correct; the default promotion output contains the
chosen stable artifact and does not expose unpromoted candidates.

## 5. Candidate build and source identity

The Factory workflow runs only on a Windows runner and pins the verified
toolchain:

```text
Node 24.18.0
pnpm 11.7.0
platform win32
arch x64
```

The workflow first performs a cheap latest check. If the npm latest version is
already represented by an accepted candidate or the stable channel, the job
ends without installing dependencies or rebuilding the approximately 400 MB
runtime.

For a new version, the workflow resolves:

```text
@deepseek-ai/dsh dist-tags.latest = V
official source tag = dsh-vV
```

It verifies that the checked-out package version equals `V`, records the exact
source commit, and uses the official frozen-lockfile build path. Any missing
tag or version mismatch stops the candidate with a structured reason and does
not change the stable index.

The existing `buildVerifiedRuntimeArtifact()` implementation remains the sole
runtime assembly and smoke implementation. The Distribution layer supplies
the exact source runtime root, the predictable immutable Release URL, and the
provenance fields; it does not duplicate Factory logic.

## 6. Candidate artifact and provenance

The candidate artifact name is:

```text
dsh-runtime-<VERSION>-win32-x64.zip
```

The Candidate Release contains at least:

```text
dsh-runtime-<VERSION>-win32-x64.zip
runtime-manifest.json
dsh-runtime-<VERSION>-win32-x64.zip.sha256
factory-provenance.json
candidate-runtime-index.json
```

The existing `runtime-manifest.json` remains compatible with the current
manifest validator. Additional factory evidence is stored in
`factory-provenance.json` rather than forcing a new Desktop manifest schema.
Provenance includes package, version, source tag, source commit, npm
`dist.integrity`, Node, pnpm, platform, architecture, creation time, artifact
hash, artifact size, file count, and each acceptance result.

Candidate publication is immutable and idempotent:

- Same version and same hash returns `ALREADY_PUBLISHED` without uploading.
- Same version and different hash is `HARD_FAIL` and is reported as a
  supply-chain anomaly.
- Existing candidate assets are never overwritten.
- A rebuild that changes bytes requires a new build revision or version.

## 7. Remote re-verification

Local Factory success is not sufficient for promotion. After candidate upload,
the workflow downloads the Release Asset again from its public HTTPS URL and
records HTTP status, Content-Length, observed size, SHA-256, and duration.
The downloaded ZIP is independently extracted and passed through the existing
manifest, CLI, Web, health, native, and runtime verification contracts.

Only a complete result receives the logical state `REMOTE_VERIFIED`. A failed
download, size mismatch, hash mismatch, unsafe archive, wrong platform,
invalid manifest, or failed smoke leaves the existing stable index untouched.

## 8. Workflow responsibilities

### `dsh-runtime-factory.yml`

The workflow supports `workflow_dispatch` and a six-hour schedule. It uses a
Windows x64 job, fixed Node/pnpm versions, and a cheap latest check before the
Factory. It calls the existing Factory entry point, creates or reuses the
immutable candidate Release according to the idempotency rules, performs
remote re-verification, and emits a summary containing:

- upstream version
- source tag and source commit
- artifact version
- artifact SHA-256 and size
- CLI, Web, health, and native results
- remote publish result
- remote verification result
- stable promotion status, which is always `WAITING_FOR_PROMOTION` for this
  workflow

The workflow does not promote stable automatically.

### `dsh-runtime-promote.yml`

The Promotion workflow is manual and accepts an exact candidate version. It
does not rebuild. It reads the already-published Candidate Release, validates
all required assets and provenance, performs remote re-download verification,
generates a complete Pages deployment tree, validates the stable index with the
same schema contract used by Desktop, and deploys the complete site once.

Promotion and rollback use the same path. Rollback selects an older immutable,
remote-verified candidate and produces a new stable index pointing back to it.

The workflows declare only the permissions needed by their actions. Candidate
publication requires `contents: write`; Pages deployment requires the Pages
write and deployment identity permissions. No workflow is triggered by its own
Release publication, and the workflow triggers are designed to avoid
release/push/workflow-run loops.

## 9. Distribution implementation boundaries

The Distribution code is organized around testable local contracts and a
task-owned filesystem store. The planned modules are:

```text
scripts/runtime-distribution/
  distribution-contract.js
  source-mapping.js
  candidate-store.js
  stable-index.js
  runtime-distribution-cli.js
```

- `distribution-contract.js` validates exact versions, target identity, URL
  scheme, file names, byte identity, provenance, and immutable candidate rules.
- `source-mapping.js` queries npm metadata, validates `dist-tags.latest`,
  resolves the exact upstream tag, and verifies package identity.
- `candidate-store.js` implements local dry-run Release Store semantics,
  duplicate/no-op behavior, hash conflict rejection, and remote-like readback.
- `stable-index.js` generates and validates the current schema-v1 index,
  performs atomic replacement, preserves index history, and supports rollback.
- `runtime-distribution-cli.js` exposes the shared orchestration used by local
  dry runs and workflow steps without putting GitHub mutation into the Desktop
  runtime.

The implementation may collapse modules if the existing repository patterns
make a smaller boundary clearer, but the public responsibilities and test
contracts remain separate.

## 10. Local dry run

Before any remote mutation, the new tests and CLI execute this complete local
sequence under a task-owned temporary root:

```text
latest detection
  → exact source mapping fixture
  → candidate build fixture using the existing Factory seam
  → candidate publish
  → remote-like download/readback
  → remote verification
  → manual promotion
  → stable index generation
  → Desktop source readback/update E2E
  → stable rollback
```

The dry run uses deterministic files and injected command/network adapters. It
does not bind a production URL, mutate GitHub, push a branch, create a Release,
or deploy Pages.

## 11. Failure and atomicity rules

Any Factory, publish, readback, verification, promotion, or index validation
failure has the same safety result: the previously published stable index is
unchanged and the previous `verifiedLatest` continues serving users.

The stable index is generated only after the artifact is available at its
immutable public URL and remote verification has passed. The complete Pages
site is assembled in a temporary directory and deployed as one unit. Local
index writes use a temporary file followed by an atomic rename.

Production HTTPS URLs must reject localhost, loopback, unsupported schemes,
and malformed URLs in the Distribution contract. Desktop's existing safe
behavior for an absent or unreachable configured source is preserved.

## 12. Test contract

Deterministic tests cover:

- npm latest SemVer validation and exact source-tag mapping
- package/source version mismatch
- candidate identity and artifact naming
- duplicate candidate with same hash as a safe no-op
- duplicate candidate with different hash as a hard failure
- missing candidate asset or manifest rejection
- remote size/hash mismatch
- stable promotion with a valid candidate
- promotion rejection for a missing or invalid candidate
- stable rollback
- HTTPS URL validation and localhost production rejection
- index schema validation and atomic replacement
- no index mutation after Factory or remote verification failure
- local dry-run readback and Desktop update selection
- YAML syntax and all workflow-referenced script paths
- fixed Node/pnpm/platform values
- no npm dependency-resolution call in the production update path

The full `npm test`, Distribution-focused tests, `git diff --check`, and any
available lightweight YAML/static checks are required before the local
implementation gate is marked pass.

## 13. Remote Publish Gate

The implementation stops after local tests, dry run, and documentation unless
all of the following are explicitly available and authorized:

- GitHub authentication and `contents: write`
- permission to create candidate Releases
- Pages enabled or permission to enable it
- Pages deployment permissions and identity configuration
- explicit authorization to publish the first real candidate

The first real candidate, if the gate is later authorized, is the already
verified `0.1.1-rc.2`; the workflow must rebuild it through the final Factory
path and then remote-verify it before promotion. No fake test version is used.

Until the real HTTPS artifact, stable index, and installed Desktop E2E are
verified, the correct conclusion remains:

```text
PRODUCTION DISTRIBUTION CODE: PASS or BLOCKED based on local evidence
REMOTE DEPLOYMENT: NOT PERFORMED
PUBLIC RELEASE READY: NO
```
