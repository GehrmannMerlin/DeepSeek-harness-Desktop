# DSH Runtime Production Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows x64 Runtime Factory distribution pipeline that produces immutable candidate Release Assets, remotely re-verifies them, and changes the stable schema-v1 Runtime Index only through manual promotion or rollback.

**Architecture:** Keep `scripts/build-verified-runtime-artifact.js` as the only runtime assembly and smoke implementation. Add small, dependency-free Distribution modules for source identity, candidate immutability, remote verification, stable-index generation, and local filesystem dry runs; wire those modules into a scheduled/manual Windows Factory workflow and a separate manual Promotion workflow. GitHub Releases hold immutable ZIP assets, while one complete GitHub Pages deployment serves `runtime/stable/runtime-index.json`.

**Tech Stack:** Node.js 24.18.0 for Factory CI, pnpm 11.7.0, Node built-in `https`/`http`/`fs`/`child_process` APIs, existing `semver`, `unzipper`, `runtime-verifier`, `HarnessHealthChecker`, GitHub Actions YAML, GitHub Release Assets, and GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-08-25-dsh-runtime-production-distribution-design.md`

## Global Constraints

- Target only `win32` + `x64`; do not produce Windows artifacts from Linux or macOS runners.
- Pin Factory Node to `24.18.0` and pnpm to `11.7.0`; do not use `latest` toolchain tags.
- Query official npm metadata and validate `dist-tags.latest` as SemVer; never infer upstream latest from GitHub HEAD.
- Resolve only `deepseek-ai/deepseek-harness` tag `dsh-v${version}`; missing mapping is `SOURCE_MAPPING_NOT_AVAILABLE`, with no branch fallback.
- Verify source package version equals the npm target version before Factory execution.
- Reuse `scripts/build-verified-runtime-artifact.js`; do not duplicate runtime assembly or smoke logic in CI.
- Reuse the current `schemaVersion: 1` and `artifacts: []` Verified Runtime contract; do not introduce schema v2.
- Candidate ZIPs are immutable; same version plus same SHA is a no-op, same version plus different SHA is a hard failure.
- Candidate publication must be followed by public HTTPS download, size/hash verification, extraction, CLI, Web, Health, and native verification.
- Stable index publication is the final operation after remote verification and full index validation.
- Stable promotion is manual; Factory build and verification may be automatic, but stable promotion must not be automatic.
- Production Desktop continues to read `DSH_VERIFIED_RUNTIME_INDEX_URL`; an absent value remains a safe skip.
- Local dry runs use a task-owned temporary root and must not mutate GitHub, push branches, create Releases, enable Pages, or deploy Pages.
- Do not publish a Desktop installer, change Desktop version, add signing, implement delta updates, or add Linux/macOS/ARM support.
- Preserve previous stable index history and candidate assets; never delete old verified runtimes as part of this feature.

---

## File and Interface Map

Create these focused modules under `scripts/runtime-distribution/`:

- `distribution-contract.js`: pure exact-version, target, URL, naming, provenance, and immutable-candidate validators.
- `source-mapping.js`: npm latest metadata, exact upstream tag resolution, and source package identity checks.
- `candidate-store.js`: task-owned filesystem Release Store semantics, including idempotent publish/readback.
- `remote-verification.js`: HTTPS artifact readback, size/hash checks, extraction, and reuse of existing runtime verification seams.
- `stable-index.js`: schema-v1 stable index generation, validation, atomic writes, history, promotion, and rollback.
- `runtime-distribution-cli.js`: deterministic `detect`, `dry-run`, `promote`, and `rollback` orchestration used by tests and workflow steps.

Create these tests:

- `test/runtime-distribution-contract.test.js`
- `test/runtime-source-mapping.test.js`
- `test/runtime-candidate-store.test.js`
- `test/runtime-remote-verification.test.js`
- `test/runtime-stable-index.test.js`
- `test/runtime-distribution-cli.test.js`
- `test/runtime-distribution-workflows.test.js`

Create these workflows:

- `.github/workflows/dsh-runtime-factory.yml`
- `.github/workflows/dsh-runtime-promote.yml`

Create or update these documentation files:

- `docs/runtime/production-runtime-distribution-analysis.md`
- `docs/runtime/production-runtime-distribution-architecture.md`
- `docs/runtime/production-runtime-distribution-runbook.md`
- `docs/runtime/dsh-runtime-release-gate.md` (append the Distribution phase without deleting historical evidence)

Modify `package.json` only to add local Distribution commands after the CLI exists:

```json
{
  "scripts": {
    "distribution:dry-run": "node scripts/runtime-distribution/runtime-distribution-cli.js dry-run",
    "distribution:validate-workflows": "node scripts/runtime-distribution/runtime-distribution-cli.js validate-workflows"
  }
}
```

---

### Task 1: Freeze the Distribution contract with failing tests

**Files:**
- Create: `test/runtime-distribution-contract.test.js`
- Create: `scripts/runtime-distribution/distribution-contract.js`
- Test existing: `src/runtime/verified-runtime-artifact.js`

**Interfaces:**
- Produces `normalizeExactVersion(value): string` and throws `DISTRIBUTION_INVALID_VERSION` for empty, `v`-prefixed, range, or invalid SemVer input.
- Produces `artifactFileName({ version, platform, arch }): string` with output `dsh-runtime-${version}-${platform}-${arch}.zip`.
- Produces `candidateReleaseTag(version): string` with output `dsh-runtime-v${version}`.
- Produces `assertTarget({ platform, arch }): { platform, arch }` and accepts only `{ platform: 'win32', arch: 'x64' }` for Distribution operations.
- Produces `assertProductionHttpsUrl(url): string` and rejects `http:`, loopback, localhost, malformed, and non-HTTPS URLs.
- Produces `candidateIdentity({ version, sha256, sizeBytes }): object` and `compareCandidateIdentity(existing, next): 'NEW' | 'ALREADY_PUBLISHED' | 'HASH_CONFLICT'`.

- [ ] **Step 1: Write the failing tests.** Cover exact SemVer acceptance (`0.1.1-rc.2`), invalid SemVer, artifact naming, Release tag naming, Windows x64 target enforcement, HTTPS URL acceptance, localhost rejection, SHA/size validation, same-hash no-op, and different-hash conflict.

```js
test('same version and hash is already published while a different hash is a conflict', () => {
  const existing = candidateIdentity({ version: '0.1.1-rc.2', sha256: 'a'.repeat(64), sizeBytes: 10 });
  assert.equal(compareCandidateIdentity(existing, existing), 'ALREADY_PUBLISHED');
  assert.equal(compareCandidateIdentity(existing, {
    version: '0.1.1-rc.2', sha256: 'b'.repeat(64), sizeBytes: 10,
  }), 'HASH_CONFLICT');
});
```

- [ ] **Step 2: Run the focused test to verify it fails for the expected reason.**

Run:

```text
node --test test/runtime-distribution-contract.test.js
```

Expected: FAIL because `scripts/runtime-distribution/distribution-contract.js` does not exist yet.

- [ ] **Step 3: Implement the minimal pure contract module.** Use the repository's existing `semver` dependency and return normalized lowercase SHA-256 values. Do not add a new dependency or call the network.

- [ ] **Step 4: Run the focused test and the existing artifact contract tests.**

```text
node --test test/runtime-distribution-contract.test.js test/verified-runtime-artifact.test.js
```

Expected: PASS with the existing schema-v1 tests unchanged.

- [ ] **Step 5: Commit the contract.**

```text
git add scripts/runtime-distribution/distribution-contract.js test/runtime-distribution-contract.test.js
git commit -m "feat: add runtime distribution contract"
```

### Task 2: Add npm latest and exact upstream source mapping

**Files:**
- Create: `test/runtime-source-mapping.test.js`
- Create: `scripts/runtime-distribution/source-mapping.js`
- Consume: `scripts/runtime-distribution/distribution-contract.js`
- Reference: `src/update/npm-registry-update-source.js`

**Interfaces:**
- Produces `readUpstreamLatest({ requestJson }): Promise<{ version, distIntegrity, metadata }>`; it requests `https://registry.npmjs.org/@deepseek-ai%2fdsh`, validates `dist-tags.latest`, and extracts the exact version's `dist.integrity`.
- Produces `resolveExactSourceTag({ version, lsRemote }): Promise<{ tag, commit }>`; it queries `https://github.com/deepseek-ai/deepseek-harness.git` tags and returns only `dsh-v${version}`.
- Produces `assertSourcePackageIdentity({ packageJson, version }): { name, version }`; it rejects wrong package name or version.
- Produces `createSourceMapping({ requestJson, lsRemote, readJson }): { readLatest, resolveTag, verifyPackage }` for injected deterministic tests.

- [ ] **Step 1: Write failing tests.** Cover valid npm latest with `dist.integrity`, invalid/missing latest, wrong package metadata, exact tag found, tag absent, annotated tag peeled commit, and explicit no-master-fallback behavior.

```js
test('missing exact source tag stops candidate mapping', async () => {
  const source = createSourceMapping({
    requestJson: async () => ({ 'dist-tags': { latest: '0.1.1-rc.3' }, versions: {} }),
    lsRemote: async () => 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e refs/tags/dsh-v0.1.1-rc.2\n',
  });
  await assert.rejects(() => source.resolveTag('0.1.1-rc.3'), error => error.code === 'SOURCE_MAPPING_NOT_AVAILABLE');
});
```

- [ ] **Step 2: Run the focused tests and confirm the expected missing-module or missing-function failures.**

```text
node --test test/runtime-source-mapping.test.js
```

- [ ] **Step 3: Implement registry parsing and exact tag resolution.** Use `https` through injected `requestJson` for production, validate the registry URL and response shape, parse `git ls-remote --tags` output through injected `lsRemote`, prefer the peeled `^{}` commit for annotated tags, and throw `SOURCE_MAPPING_NOT_AVAILABLE` when `refs/tags/dsh-v${version}` is absent.

- [ ] **Step 4: Run focused source mapping and contract tests.**

```text
node --test test/runtime-source-mapping.test.js test/runtime-distribution-contract.test.js
```

Expected: PASS with no network call in the deterministic tests.

- [ ] **Step 5: Commit source mapping.**

```text
git add scripts/runtime-distribution/source-mapping.js test/runtime-source-mapping.test.js
git commit -m "feat: resolve exact runtime source mappings"
```

### Task 3: Implement immutable candidate storage and publication decisions

**Files:**
- Create: `test/runtime-candidate-store.test.js`
- Create: `scripts/runtime-distribution/candidate-store.js`
- Consume: `scripts/runtime-distribution/distribution-contract.js`

**Interfaces:**
- Produces `createFileCandidateStore({ root, now }): { publish, read, list, assetPath }`.
- `publish(candidate): Promise<{ status: 'PUBLISHED' | 'ALREADY_PUBLISHED', candidate }>` writes a candidate directory atomically through a temporary directory and refuses hash conflicts.
- `read(version): Promise<object | null>` reads the candidate descriptor and all required metadata.
- `list(): Promise<object[]>` returns candidates sorted by SemVer descending.
- `assetPath(version): string` returns the exact versioned ZIP path without a mutable `latest` alias.
- Candidate descriptor fields are `{ schemaVersion: 1, packageName, version, platform, arch, artifactUrl, sizeBytes, sha256, manifest, provenance, status }`.

- [ ] **Step 1: Write failing tests.** Cover publication of a new candidate, required files, same version/same hash no-op, same version/different hash hard failure with code `CANDIDATE_HASH_CONFLICT`, no overwrite of the original ZIP, and list ordering.

- [ ] **Step 2: Run the focused test.**

```text
node --test test/runtime-candidate-store.test.js
```

Expected: FAIL because the store module does not exist.

- [ ] **Step 3: Implement atomic local publication.** Copy the ZIP and metadata into `candidate-${version}.tmp`, write JSON with a final newline, fsync/close where the existing Node APIs permit, rename to `candidate-${version}`, and remove only the temporary directory on failure. Use `fs.promises.mkdir`, `copyFile`, `rename`, and `rm`; never overwrite an existing candidate directory.

- [ ] **Step 4: Run candidate store tests plus the full existing suite.**

```text
node --test test/runtime-candidate-store.test.js
npm test
```

- [ ] **Step 5: Commit candidate storage.**

```text
git add scripts/runtime-distribution/candidate-store.js test/runtime-candidate-store.test.js
git commit -m "feat: add immutable runtime candidate store"
```

### Task 4: Add remote artifact verification using existing runtime contracts

**Files:**
- Create: `test/runtime-remote-verification.test.js`
- Create: `scripts/runtime-distribution/remote-verification.js`
- Consume: `src/update/runtime-artifact-downloader.js`
- Consume: `src/update/runtime-verifier.js`
- Consume: `scripts/build-verified-runtime-artifact.js`

**Interfaces:**
- Produces `verifyRemoteCandidate({ candidate, download, extractZip, verifyRuntime, smoke, tempRoot }): Promise<{ status: 'REMOTE_VERIFIED', observedSize, sha256, durationMs, verification }>`.
- `download(url, destination): Promise<{ statusCode, contentLength, sizeBytes, sha256, durationMs }>` is injected in tests and uses HTTPS in production.
- The verifier must compare expected `sizeBytes` and `sha256` before extraction, call existing `extractZip`, call existing `verifyRuntime`, then call existing `defaultSmoke` or an injected equivalent.
- Any failure throws a coded error and does not return `REMOTE_VERIFIED`.

- [ ] **Step 1: Write failing tests.** Cover public HTTPS readback success, HTTP 404, timeout, Content-Length mismatch, SHA mismatch before extraction, unsafe ZIP, wrong manifest identity, CLI failure, Web/Health failure, native failure, and cleanup of the task staging root.

```js
test('remote hash mismatch never extracts or verifies the candidate', async () => {
  let extracted = false;
  await assert.rejects(() => verifyRemoteCandidate({
    candidate: makeCandidate(),
    download: async () => ({ statusCode: 200, contentLength: 10, sizeBytes: 10, sha256: 'b'.repeat(64), durationMs: 5 }),
    extractZip: async () => { extracted = true; },
    verifyRuntime: async () => ({ ok: true }),
    smoke: async () => ({ ok: true }),
    tempRoot: await fs.mkdtemp(path.join(os.tmpdir(), 'distribution-')),
  }), error => error.code === 'REMOTE_ARTIFACT_HASH_MISMATCH');
  assert.equal(extracted, false);
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure.**

```text
node --test test/runtime-remote-verification.test.js
```

- [ ] **Step 3: Implement streaming HTTPS download and verification.** Reuse the existing artifact downloader's safe extraction implementation, compute SHA-256 while streaming, reject non-2xx responses, enforce the expected byte size, and use `fs.promises.rm` in a `finally` block for partial files and temporary extraction roots.

- [ ] **Step 4: Run focused remote verification tests and existing artifact download tests.**

```text
node --test test/runtime-remote-verification.test.js test/runtime-artifact-downloader.test.js test/runtime-artifact-update-e2e.test.js
```

- [ ] **Step 5: Commit remote verification.**

```text
git add scripts/runtime-distribution/remote-verification.js test/runtime-remote-verification.test.js
git commit -m "feat: reverify remote runtime candidates"
```

### Task 5: Generate, validate, atomically publish, and roll back the stable index

**Files:**
- Create: `test/runtime-stable-index.test.js`
- Create: `scripts/runtime-distribution/stable-index.js`
- Consume: `src/runtime/verified-runtime-artifact.js`
- Consume: `src/update/verified-runtime-update-source.js`

**Interfaces:**
- Produces `buildStableIndex({ candidate, artifactUrl }): object` with `{ schemaVersion: 1, artifacts: [entry] }`, where `entry` is accepted by `VerifiedRuntimeArtifact.fromIndexEntry`.
- Produces `validateStableIndex(index, { platform: 'win32', arch: 'x64' }): object` and rejects malformed schema, missing artifacts, wrong target, non-HTTPS production URLs, invalid hash/size, and manifest mismatch.
- Produces `writeStableIndexAtomic({ indexPath, index, historyDirectory, now }): Promise<{ indexPath, historyPath }>`; it writes a complete temporary JSON, renames it atomically, then stores a timestamped history copy.
- Produces `promoteStable({ candidateStore, candidateVersion, remoteVerifier, indexPath, historyDirectory }): Promise<{ version, index }>` and never calls the Factory.
- Produces `rollbackStable({ candidateStore, targetVersion, remoteVerifier, indexPath, historyDirectory }): Promise<{ version, index }>` using the same promotion path.

- [ ] **Step 1: Write failing tests.** Cover valid index generation, schema-v1 round trip through `VerifiedRuntimeUpdateSource`, invalid entry rejection, localhost rejection, atomic replacement preserving the previous file on failure, valid promotion, missing candidate rejection, promotion after remote verification, rollback to a previous candidate, and proof that promotion does not invoke a build callback.

- [ ] **Step 2: Run the focused tests and verify they fail before implementation.**

```text
node --test test/runtime-stable-index.test.js
```

- [ ] **Step 3: Implement pure index generation and validation.** Build only the existing `artifacts` contract; do not add `latest`, `runtimes`, or schema-v2-only fields. Keep history outside the client-consumed JSON under `runtime/history/`.

- [ ] **Step 4: Implement atomic write and promotion/rollback.** Validate candidate metadata, await `REMOTE_VERIFIED`, write the new JSON to `runtime-index.json.tmp`, rename it, and only then write the history copy. If validation, remote verification, or write fails, leave the prior index untouched.

- [ ] **Step 5: Run focused stable-index tests and current source tests.**

```text
node --test test/runtime-stable-index.test.js test/verified-runtime-update-source.test.js
```

- [ ] **Step 6: Commit stable index operations.**

```text
git add scripts/runtime-distribution/stable-index.js test/runtime-stable-index.test.js
git commit -m "feat: add stable runtime index promotion and rollback"
```

### Task 6: Add the shared Distribution CLI and deterministic local dry run

**Files:**
- Create: `test/runtime-distribution-cli.test.js`
- Create: `scripts/runtime-distribution/runtime-distribution-cli.js`
- Modify: `package.json`
- Consume: all modules from Tasks 1–5

**Interfaces:**
- CLI commands are `detect`, `dry-run`, `promote`, `rollback`, and `validate-workflows`.
- Produces `runDryRun({ root, fixture, now, logger }): Promise<{ upstreamLatest, candidateVersion, remoteStatus, stableVersion, rollbackVersion, npmInstallCalls }>`.
- `dry-run` must execute detection → candidate fixture → publish → remote-like readback → promotion → Desktop index readback → rollback without network mutation.
- `detect` returns `upstreamLatest`, candidate status, and stable version without running the Factory when the version is already known.
- `promote` and `rollback` accept an exact version and use `stable-index.js`; they never invoke `buildVerifiedRuntimeArtifact`.

- [ ] **Step 1: Write failing integration tests.** Use a temporary root and deterministic fixtures to assert the entire local sequence, stable index last publication, rollback, safe no-op for already-built candidate, and zero npm installer/dependency-resolution calls during the production update path.

```js
test('dry run publishes, promotes, reads back, and rolls back without npm install', async () => {
  const result = await runDryRun({ root: await makeDistributionRoot(), fixture: makeFixture(), now: () => '2026-08-25T00:00:00.000Z' });
  assert.equal(result.remoteStatus, 'REMOTE_VERIFIED');
  assert.equal(result.stableVersion, '0.1.1-rc.2');
  assert.equal(result.rollbackVersion, '0.1.0-rc.7');
  assert.equal(result.npmInstallCalls, 0);
});
```

- [ ] **Step 2: Run the focused CLI test and verify the expected failure.**

```text
node --test test/runtime-distribution-cli.test.js
```

- [ ] **Step 3: Implement the CLI orchestration and argument parser.** Use explicit injected adapters for registry, source mapping, Factory, Release Store, remote verification, and index publication. The default CLI may use real adapters only when a workflow supplies the required paths and URLs; local tests must never depend on GitHub credentials or a live 400 MB artifact.

- [ ] **Step 4: Add package scripts and run the dry run.**

```text
npm run distribution:dry-run
```

Expected: deterministic candidate publication, `REMOTE_VERIFIED`, stable promotion, Desktop-compatible index readback, rollback, and `npmInstallCalls: 0`.

- [ ] **Step 5: Run the full suite and commit the CLI.**

```text
npm test
git add scripts/runtime-distribution/runtime-distribution-cli.js test/runtime-distribution-cli.test.js package.json package-lock.json
git commit -m "feat: add local runtime distribution dry run"
```

### Task 7: Implement the Windows x64 Runtime Factory workflow

**Files:**
- Create: `.github/workflows/dsh-runtime-factory.yml`
- Modify: `scripts/runtime-distribution/runtime-distribution-cli.js` if workflow arguments require a small adapter
- Test: `test/runtime-distribution-workflows.test.js`

**Interfaces:**
- Workflow dispatch inputs: optional `version` for deterministic manual rerun; when empty, use npm `dist-tags.latest`.
- Workflow environment: `RUNTIME_PLATFORM=win32`, `RUNTIME_ARCH=x64`, `NODE_VERSION=24.18.0`, `PNPM_VERSION=11.7.0`.
- Workflow calls the existing Factory with `sourceRuntimeRoot=upstream/apps/cli`, `frontendDistRoot=upstream/apps/web/dist`, `frontendPackageJsonPath=upstream/apps/web/package.json`, and a predictable Release URL `https://github.com/${{ github.repository }}/releases/download/dsh-runtime-v${version}/dsh-runtime-${version}-win32-x64.zip`.
- Workflow summary fields are upstream version, source tag/commit, artifact version/hash/size, CLI/Web/Health/Native, remote publish, remote verify, and `WAITING_FOR_PROMOTION`.

- [ ] **Step 1: Add static workflow tests before the YAML.** Assert the workflow file will contain `workflow_dispatch`, `schedule`, a Windows runner, `actions/checkout` for the repository and upstream tag, `actions/setup-node` with `24.18.0`, pnpm setup with `11.7.0`, `contents: write`, no Linux/macOS runner, no `latest` toolchain value, and calls to the existing Factory/CLI paths.

- [ ] **Step 2: Run the static test to verify it fails because the workflow does not exist.**

```text
node --test test/runtime-distribution-workflows.test.js
```

- [ ] **Step 3: Write the workflow.** Use `0 */6 * * *`; run cheap latest detection before checkout/install; stop with a no-op summary when the version already has an accepted candidate or is stable; checkout `deepseek-ai/deepseek-harness` at the exact `dsh-v${version}` tag; run `corepack prepare pnpm@11.7.0 --activate`, `pnpm install --frozen-lockfile`, and `pnpm run build`; verify package JSON version; call the existing Factory; publish candidate assets with immutable/idempotent behavior; run remote readback verification; and upload only logs/metadata as workflow artifacts.

- [ ] **Step 4: Add `workflow_dispatch` and schedule tests for the exact required controls.** Validate that no step updates the stable index and no `release`, `push`, or `workflow_run` trigger can recursively invoke this workflow.

- [ ] **Step 5: Run static validation and commit the Factory workflow.**

```text
npm run distribution:validate-workflows
git diff --check
git add .github/workflows/dsh-runtime-factory.yml test/runtime-distribution-workflows.test.js scripts/runtime-distribution/runtime-distribution-cli.js
git commit -m "ci: automate verified runtime candidate factory"
```

### Task 8: Implement the manual Promotion and rollback workflow

**Files:**
- Create: `.github/workflows/dsh-runtime-promote.yml`
- Modify: `scripts/runtime-distribution/runtime-distribution-cli.js` if a workflow adapter is needed
- Test: `test/runtime-distribution-workflows.test.js`

**Interfaces:**
- `workflow_dispatch` inputs: required `version`, required `operation` with values `promote` or `rollback`.
- Promotion reads the Candidate Release for the exact version, validates ZIP/manifest/SHA/provenance/target, performs remote re-download verification, then calls stable-index generation.
- Rollback reads a prior remote-verified candidate and uses the same stable-index path; it does not rebuild or upload a new ZIP.
- Pages output root contains `runtime/stable/runtime-index.json` and `runtime/history/${timestamp}-${version}.json`.
- Workflow permissions include `contents: read`, `pages: write`, and `id-token: write`; it must not use `contents: write` unless a Release metadata read requires it.

- [ ] **Step 1: Extend static tests with promotion assertions.** Assert manual dispatch only, required exact version input, no build/factory invocation, remote verification before `stable-index.js`, Pages artifact upload, Pages deployment, and no `push`/`release` trigger.

- [ ] **Step 2: Run the focused static test and verify it fails before the promotion workflow exists.**

- [ ] **Step 3: Write the workflow.** Checkout the distribution branch, download or query the exact candidate asset, run the shared CLI validation and remote verifier, construct the complete Pages tree in a temporary directory, validate the final schema-v1 JSON, upload the Pages artifact, and deploy once using the official Pages actions. Keep the old stable index in the history tree before replacing the current one.

- [ ] **Step 4: Add a local promotion/rollback workflow fixture test.** Use a task-owned Pages directory and assert an invalid candidate leaves the previous `runtime/stable/runtime-index.json` byte-for-byte unchanged.

- [ ] **Step 5: Run static validation and commit the Promotion workflow.**

```text
npm run distribution:validate-workflows
git diff --check
git add .github/workflows/dsh-runtime-promote.yml test/runtime-distribution-workflows.test.js scripts/runtime-distribution/runtime-distribution-cli.js
git commit -m "ci: add manual runtime stable promotion"
```

### Task 9: Add production Distribution documentation and release-gate evidence

**Files:**
- Create: `docs/runtime/production-runtime-distribution-analysis.md`
- Create: `docs/runtime/production-runtime-distribution-architecture.md`
- Create: `docs/runtime/production-runtime-distribution-runbook.md`
- Modify: `docs/runtime/dsh-runtime-release-gate.md`
- Reference: `docs/runtime/dsh-runtime-factory-evaluation.md`
- Reference: `docs/runtime/verified-runtime-artifact-architecture.md`

**Interfaces:**
- Documentation must report the repository/remote/Pages/Releases/Actions facts observed at implementation time without claiming remote deployment.
- Runbook commands must use exact local CLI commands and exact workflow names.
- Architecture must show npm upstream → exact source tag → Windows Factory → Candidate Release → remote verification → manual Promotion → Pages stable index → Desktop → rollback.
- Gate documentation must preserve prior Runtime Updater evidence and append Production Distribution rows with `PASS`, `BLOCKED`, `NOT PERFORMED`, or `AWAITING AUTHORIZATION` based on observed evidence.

- [ ] **Step 1: Write the analysis document.** Include answers to all ten required infrastructure questions: remote existence/visibility, Releases, Pages, other Pages use, storage, CI, `contents: write`, Desktop index URL source, and absent-source safe behavior.

- [ ] **Step 2: Write the architecture document.** Include channel state definitions, immutable artifact URL rules, index atomicity, candidate/promote/rollback sequence, and ownership boundaries between Factory, Distribution, Pages, and Desktop.

- [ ] **Step 3: Write the runbook.** Include exact instructions for building a candidate, inspecting provenance/SHA, inspecting remote assets, promoting, rolling back, diagnosing a failed Factory, and stopping distribution of a bad version by pointing stable back to a previous candidate.

- [ ] **Step 4: Append the gate evidence without deleting historical evidence.** Record that local implementation and dry run are evaluated separately from Remote Publish Gate and that public release remains `NO` until real HTTPS installed Desktop E2E passes.

- [ ] **Step 5: Run Markdown path checks, `git diff --check`, and commit documentation.**

```text
git diff --check
git add docs/runtime/production-runtime-distribution-analysis.md docs/runtime/production-runtime-distribution-architecture.md docs/runtime/production-runtime-distribution-runbook.md docs/runtime/dsh-runtime-release-gate.md
git commit -m "docs: add runtime distribution operations runbook"
```

### Task 10: Execute the local distribution gate and verify all requirements

**Files:**
- Modify only if verification exposes a defect in the preceding tasks.
- Evidence: `docs/runtime/production-runtime-distribution-analysis.md`, `docs/runtime/production-runtime-distribution-runbook.md`, and appended gate documentation.

**Interfaces:**
- No new public runtime interface is introduced in this task.
- Final local gate output must include branch/worktree/HEAD, test counts, dry-run result, candidate hash/size, stable promotion/rollback result, npm call count, workflow static checks, and remote mutation status.

- [ ] **Step 1: Run the complete deterministic Distribution test set.**

```text
node --test test/runtime-distribution-contract.test.js test/runtime-source-mapping.test.js test/runtime-candidate-store.test.js test/runtime-remote-verification.test.js test/runtime-stable-index.test.js test/runtime-distribution-cli.test.js test/runtime-distribution-workflows.test.js
```

Expected: 0 failures.

- [ ] **Step 2: Run the local dry run from a clean task-owned root.**

```text
npm run distribution:dry-run
```

Verify in output and generated files:

```text
candidate publish = PUBLISHED or ALREADY_PUBLISHED
remote verification = REMOTE_VERIFIED
stable index latest entry = exact candidate
rollback index latest entry = previous candidate
npm dependency-resolution calls = 0
```

- [ ] **Step 3: Run the existing full suite and required static checks.**

```text
npm test
git diff --check
npm run distribution:validate-workflows
```

If `actionlint` is already installed, run `actionlint .github/workflows/dsh-runtime-factory.yml .github/workflows/dsh-runtime-promote.yml`; do not install a large framework solely for this check.

- [ ] **Step 4: Run the real artifact E2E only when the real artifact path is available locally.**

```text
if ($env:DSH_REAL_RUNTIME_ARTIFACT) { node --test test/runtime-artifact-update-e2e.test.js } else { Write-Output 'SKIPPED / NOT AVAILABLE: DSH_REAL_RUNTIME_ARTIFACT is not set' }
```

Record `SKIPPED / NOT AVAILABLE` rather than fabricating an artifact if the local environment does not contain the real ZIP.

- [ ] **Step 5: Audit remote mutation boundaries.** Confirm the test and dry-run logs contain no `git push`, `gh release create`, `gh release upload`, Pages deployment, or production URL write. Confirm no stable index changed before remote verification.

- [ ] **Step 6: Update the gate documents with observed evidence and commit verification evidence.**

```text
git diff --check
git status --short --branch
git log --oneline --decorate -12
git commit -am "test: close runtime distribution local gates"
```

### Task 11: Apply the Remote Publish Gate only after explicit authorization

**Files:**
- No source change is required for authorization itself.
- Remote targets, if authorized: GitHub branch, Candidate Release, GitHub Pages deployment.

**Interfaces:**
- Required external inputs: GitHub authentication, `contents: write`, Pages enablement/deployment permission, and explicit authorization to publish the first real candidate.
- First real candidate: existing verified `0.1.1-rc.2`, rebuilt through the final Windows Factory path; no fake version.

- [ ] **Step 1: Stop and report local status if any required permission is missing.** Use exactly:

```text
PRODUCTION DISTRIBUTION CODE: PASS
REMOTE DEPLOYMENT: AWAITING AUTHORIZATION
PUBLIC RELEASE READY: NO
```

- [ ] **Step 2: If and only if authorization and permissions are present, run the Factory workflow for `0.1.1-rc.2`.** Verify the exact source tag, Factory acceptance, candidate publication, and public HTTPS re-download. Do not use a temporary ZIP outside the final Factory path.

- [ ] **Step 3: Manually promote `0.1.1-rc.2`.** Verify the stable Pages URL, schema, target, size, hash, and index-referenced artifact URL through independent HTTPS requests.

- [ ] **Step 4: Run the installed Desktop production E2E.** Start the isolated OLD bundled `0.1.0-rc.7` app with the real HTTPS stable index URL, confirm update availability, user confirmation, remote ZIP download, SHA/ZIP/runtime verification, managed `0.1.1-rc.2`, Health PASS, restart persistence, and operation audit chain. Confirm production update npm calls are zero.

- [ ] **Step 5: Run the production failure cases with mock/local tests only.** Cover artifact 404, index timeout, artifact timeout, hash mismatch, invalid index, wrong arch, unsupported scheme, and confirm current runtime never switches.

- [ ] **Step 6: Only after fresh evidence for every gate, write `PUBLIC RELEASE READY = YES`.** Otherwise report the exact remaining blocker and keep the stable index on the previous verified version.

---

## Plan Self-Review Checklist

- [x] Spec coverage: hosting, version channels, exact source mapping, Factory reuse, candidate immutability, remote verification, Promotion, rollback, Pages atomicity, local dry run, tests, docs, and Remote Publish Gate each have a task.
- [x] Placeholder scan: no step contains unfinished placeholder markers, says to implement something later, or refers to an undefined neighboring function.
- [x] Interface consistency: `candidate-store.js`, `remote-verification.js`, `stable-index.js`, and `runtime-distribution-cli.js` signatures are defined before workflows consume them.
- [x] Existing contract consistency: all generated Desktop indexes use `schemaVersion: 1` plus `artifacts: []` and are checked through the current validator.
- [x] Safety consistency: no task publishes stable before remote verification and no local task mutates GitHub.
- [x] Verification consistency: every implementation task has a failing-test step, focused green step, full-suite checkpoints, and a commit boundary.
