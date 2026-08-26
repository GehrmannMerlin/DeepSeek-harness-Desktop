# Production Runtime Distribution Runbook

Date: 2026-08-25 (Asia/Shanghai)
Audience: maintainers operating the checked-in Factory and stable-promotion workflows.

## Safety and authorization

The Factory and promotion workflows can mutate GitHub Releases or Pages. Do not run them against production without explicit authorization, valid repository permissions, and a preflight review. This task performed no remote mutation. Local dry-run and workflow validation are separate from the Remote Publish Gate.

Production identifiers are exact: package `@deepseek-ai/dsh`, source tag `dsh-v<VERSION>`, candidate tag `dsh-runtime-v<VERSION>`, Windows `win32-x64`, and ZIP `dsh-runtime-<VERSION>-win32-x64.zip`.

## Local preflight

From the repository root:

```powershell
npm run distribution:validate-workflows
npm run distribution:dry-run
```

The first command validates the checked-in workflow controls. The second exercises the offline orchestration path, including source resolution, candidate publication/no-op semantics, remote-verification handoff, stable-index promotion, rollback, and the zero-install-call contract. Neither command contacts GitHub to publish anything.

Before a production run, confirm the worktree contains the intended workflow files:

- `.github/workflows/dsh-runtime-factory.yml`
- `.github/workflows/dsh-runtime-promote.yml`

## Factory performance diagnosis before rerun

If artifact materialization or ZIP creation approaches 30 minutes, stop that
Factory run and do not dispatch another full Factory. The third run
(`32865356755`) failed after approximately 3 hours 4 minutes with `ENOSPC`
while `cloneMaterializedTree()` repeatedly copied cached dependency trees.

Do not rerun upstream resolution, installation, or build to diagnose this
failure. Reuse the retained isolated production tree that already passed the
CLI/Web/Health/peer-closure checks and run the artifact-only benchmark:

```powershell
npm run distribution:benchmark-artifact -- --source-runtime <verified-tree> --version 0.1.1-rc.2 --source-revision b150a551b8d465e31e418e1b2eaf5e79bbb7d28e --pnpm-version 11.7.0 --heartbeat-ms 10000 --output <benchmark-output>
```

The benchmark reports `preScanMs`, `materializationMs`, `zipMs`, `sha256Ms`,
`independentExtractionMs`, and `independentVerificationMs`, with stderr
heartbeats for long phases. The current implementation uses direct ZIP entry
generation, so `materializationMs=0` means the complete-tree copy was skipped;
it does not mean verification was skipped. A rerun is permitted only after
ZIP, SHA-256, independent extraction, CLI, Web/Health, and native smoke all
pass on the same tree. The current checkout has no retained rc.2 tree, so its
fixture results are not a substitute for this benchmark.

## Build a candidate in Factory

Dispatch `dsh-runtime-factory.yml` from the repository's Actions UI, leaving `version` empty to resolve npm `dist-tags.latest`, or enter an exact SemVer to rebuild. The workflow:

1. sets up Node `24.18.0` before npm resolution and pnpm `11.7.0`;
2. resolves the exact upstream tag `dsh-v<VERSION>` and peeled commit from `deepseek-ai/deepseek-harness`;
3. checks out that tag, installs with `pnpm install --frozen-lockfile`, and runs `pnpm run build`;
4. builds the full Windows runtime through `scripts/build-verified-runtime-artifact.js`;
5. verifies CLI version, Web launch, health, native smoke, ZIP bytes, SHA-256, size, and manifest/index identity;
6. creates or reconciles the prerelease Candidate Release without replacing immutable bytes;
7. downloads the remote ZIP and index again and compares them to the local output;
8. persists `REMOTE_VERIFY=REMOTE_VERIFIED` only after the remote readback passes.

A successful Factory is `WAITING_FOR_PROMOTION`, not stable production. A repeated exact candidate with matching identity is a validated no-op. The Factory never writes the stable Pages index.

## Build/provenance/SHA inspection

Record these values from the workflow summary, Factory log, and candidate Release notes:

```text
RUNTIME_VERSION=<exact SemVer>
SOURCE_TAG=dsh-v<VERSION>
SOURCE_COMMIT=<40-hex upstream commit>
NODE_VERSION=24.18.0
PNPM_VERSION=11.7.0
ARTIFACT_SHA256=<64-hex lowercase digest>
ARTIFACT_SIZE=<positive byte count>
REMOTE_VERIFY=REMOTE_VERIFIED
```

The ZIP name, candidate tag, index entry, manifest version/target, Release notes, checked-out source commit, and SHA/size must agree. Do not accept a SHA copied from a local file unless the remote asset has been downloaded and hashed again.

## Inspect remote candidate assets

With a read-capable GitHub CLI session and the exact version:

```powershell
$version = '<VERSION>'
$tag = "dsh-runtime-v$version"
$zip = "dsh-runtime-$version-win32-x64.zip"
gh api "repos/$env:GITHUB_REPOSITORY/releases/tags/$tag"
gh release download $tag --repo $env:GITHUB_REPOSITORY --pattern $zip --pattern runtime-index.json --dir .emote-candidate
Get-FileHash ".\remote-candidate\$zip" -Algorithm SHA256
Get-Item ".\remote-candidate\$zip" | Select-Object Length
Get-Content .\remote-candidate\runtime-index.json -Raw
```

Confirm the Release is published, prerelease, and tagged exactly; exactly one ZIP and one `runtime-index.json` exist; the index has schema v1 and one `win32/x64` artifact; `artifactUrl` is the exact HTTPS Release URL; SHA-256 and `sizeBytes` match the downloaded ZIP; and Release notes contain `SOURCE_TAG=dsh-v<VERSION>`, the 40-hex `SOURCE_COMMIT`, and `REMOTE_VERIFY=REMOTE_VERIFIED`.

## Promote a verified candidate

Use the manual dispatch workflow `dsh-runtime-promote.yml` with:

```text
version: <VERSION>
operation: promote
```

The workflow downloads the exact candidate Release, validates its identity and provenance, re-downloads and hashes the ZIP, generates `runtime/stable/runtime-index.json`, preserves the previous stable index under `runtime/history/`, stages the complete Pages tree, uploads it, and deploys Pages. It does not run the Factory, npm, or pnpm. Treat the run as complete only after the deployment step succeeds and the stable index is fetched over real HTTPS and independently validated.

## Verify the stable endpoint

The workflow's repository-derived URL is:

```text
https://<OWNER>.github.io/<REPO>/runtime/stable/runtime-index.json
```

The Desktop process receives the actual URL through `DSH_VERIFIED_RUNTIME_INDEX_URL` (or an injected `indexUrl`) and must not use an invented or guessed URL. Validate the HTTPS response, JSON schema, exact artifact identity, and Release-asset hash before claiming the Remote Publish Gate is green.

## Roll back a bad stable version

If a promoted version is bad but the prior candidate remains available:

1. identify the exact previous version from Pages history or the prior stable index;
2. verify that the prior Candidate Release still has its exact ZIP/index and `REMOTE_VERIFY=REMOTE_VERIFIED` marker;
3. dispatch `dsh-runtime-promote.yml` with `version: <PREVIOUS_VERSION>` and `operation: rollback`;
4. confirm the workflow re-verifies the prior remote ZIP, writes a new stable index pointing to the prior exact Release URL, preserves the old stable index in `runtime/history/`, and deploys the complete Pages tree;
5. fetch the stable HTTPS index and confirm the version is the prior one;
6. run installed Desktop E2E: update detection, download/hash, extraction, restart persistence, health, and zero npm/pnpm installation calls.

Rollback is a pointer change, not a rebuild and not a deletion of the bad candidate. Keep the bad candidate and workflow logs for diagnosis unless a separately authorized retention action is approved.

## Diagnose a failed Factory

Use the failed phase in the failure-derived Actions summary and then inspect the uploaded `dsh-runtime-factory-<VERSION>` logs.

- `resolve`: check exact SemVer, npm `dist-tags.latest`, upstream tag `dsh-v<VERSION>`, peeled commit, and repository access. No master/main fallback is permitted.
- `upstream-build`: check Windows runner toolchain, Node `24.18.0`, pnpm `11.7.0`, frozen lockfile, and upstream build output.
- `factory`: check the full runtime closure, frontend dist, package version, CLI/Web/health/native smoke, ZIP creation, and manifest/index identity. Do not publish an incomplete or in-motion archive.
- `publish`: inspect candidate Release state, exact tag, duplicate assets, source commit notes, local/remote SHA and size. An immutable conflict is a stop condition; do not overwrite the asset.
- `remote-readback`: re-download both assets and compare hash, size, URL, schema, target, and version. A failed readback does not advance stable.
- `release-marker`: verify the candidate Release body still contains the exact source identity before adding `REMOTE_VERIFY=REMOTE_VERIFIED`.
- `workflow-validation`: run `npm run distribution:validate-workflows` locally and fix checked-in workflow syntax/control failures before rerunning.

A Factory failure can be retried only after its cause is understood. The stable Pages index is not touched by the Factory, so a failed Factory alone is not a rollback event.

## Stop distribution of a bad version

If a bad version has reached stable, stop new Desktop uptake by rolling stable back to a prior verified candidate as above. Do not point stable at an unverified local file, delete the stable index, or edit a Release asset in place. If no prior candidate has the durable marker, leave stable unchanged and treat the incident as blocked pending an authorized recovery plan.

After rollback, preserve:

- the failed version and prior version;
- candidate Release tags and source commits;
- ZIP SHA-256 and sizes;
- stable index before and after rollback;
- Pages history path;
- installed Desktop E2E and zero npm-call evidence.

Public `RELEASE READY` remains `NO` until real production HTTPS hosting, installed Desktop E2E, restart persistence, and zero npm calls are evidenced.
