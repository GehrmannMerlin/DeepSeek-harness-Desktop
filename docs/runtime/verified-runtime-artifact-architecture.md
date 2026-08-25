# Verified Runtime Artifact Architecture

## Purpose

DeepSeek Harness Desktop must not make a Desktop user resolve the mutable DSH
dependency graph. A Runtime Factory builds an exact DSH runtime in a
controlled Windows environment, verifies it with the real CLI/Web/health
contract, archives it, and publishes a machine-readable manifest. Desktop
downloads and verifies that artifact; it does not run npm or pnpm as part of a
production update.

## Version semantics

The runtime update domain carries two independent versions:

- `upstreamLatestVersion`: the version observed from npm `dist-tags.latest`.
  The existing `NpmRegistryUpdateSource` remains an observation source and may
  log this value.
- `verifiedLatestVersion`: the highest exact version present in a validated
  `runtime-index.json` for the current platform and architecture.

Only `verifiedLatestVersion` can produce `UPDATE_AVAILABLE`. If upstream is
newer but has no verified artifact, the Desktop records that fact in logs and
does not show an update button.

## Artifact layout

The first artifact is a ZIP named:

```text
dsh-runtime-<exact-version>-win32-x64.zip
```

Its root is the deployable runtime root expected by `DshRuntimeManager`:

```text
runtime/
├── package.json
├── runtime-package.json
├── package-lock.json or pnpm-lock.yaml provenance copy
├── node_modules/
└── lib/ or the exact source-built CLI entry tree
```

The archive is not trusted merely because it extracts. Its SHA-256 is checked
before extraction, extraction is confined to the operation staging directory,
and the existing `verifyRuntime()` contract is run against the extracted root.

## Manifest and index

`runtime-manifest.json` describes one immutable artifact:

```json
{
  "schemaVersion": 1,
  "package": "@deepseek-ai/dsh",
  "version": "0.1.0-rc.7",
  "platform": "win32",
  "arch": "x64",
  "sha256": "...",
  "size": 0,
  "createdAt": "2026-08-24T00:00:00.000Z",
  "source": {
    "registry": "https://registry.npmjs.org",
    "packageVersion": "0.1.0-rc.7",
    "integrity": null,
    "sourceRevision": "99f6f02fe"
  },
  "verification": {
    "cliVersion": true,
    "webLaunch": true,
    "healthCheck": true,
    "nativeSmoke": true
  }
}
```

`runtime-index.json` contains only exact verified versions:

```json
{
  "schemaVersion": 1,
  "latest": "0.1.0-rc.7",
  "runtimes": {
    "0.1.0-rc.7": {
      "platform": "win32",
      "arch": "x64",
      "url": "https://example.invalid/release/dsh-runtime-0.1.0-rc.7-win32-x64.zip",
      "sha256": "...",
      "size": 0,
      "manifestUrl": "https://example.invalid/release/runtime-manifest.json"
    }
  }
}
```

The source and index are validated before use: JSON/schema, exact package
name, valid SemVer, platform/arch, URL, hash and size are all required. The
update manager never parses GitHub HTML.

## Desktop update pipeline

```text
load verified index
  → compare installed runtime with verified latest
  → show UPDATE_AVAILABLE only when verified is newer
  → user confirmation
  → stream ZIP to staging/<operation-id>/artifact.zip.part
  → rename to artifact.zip after download completes
  → SHA-256 verification
  → safe extraction (reject absolute paths and ../ traversal)
  → existing verifyRuntime()
  → existing promotion
  → stop only an owned Harness
  → activate/start/health
  → success or existing rollback
```

The existing `DshRuntimeManager`, `RuntimeStateStore`, promotion, activation,
rollback, pending recovery, `HarnessProcessManager`, and
`HarnessHealthChecker` remain the owners of their existing responsibilities.
`NpmInstaller` remains available as a legacy/development fallback during the
migration, but the production `VerifiedRuntimeUpdateSource` path never calls
it.

If the Harness is external, the artifact may be downloaded, verified,
extracted, promoted, and recorded as pending, but Desktop must not stop or kill
that process. Pending activation is retried after the external process exits.

## Bundled runtime preparation

`prepare:bundled-runtime` consumes a selected verified artifact and an explicit
`DSH_BUNDLED_VERSION`; it does not query `latest` and does not run npm install.
The build records the artifact SHA and extracts the runtime into
`build/bundled-runtime`, then `electron-builder` includes that directory as an
`extraResources` runtime. A source commit plus DSH version plus artifact hash
therefore identifies the complete bundled-runtime input.

## Security and failure rules

- A download error removes only the `.part` file and leaves the active runtime untouched.
- A hash mismatch fails before extraction and promotion.
- Zip Slip (`../`, absolute paths, drive-qualified paths, or an extraction path outside the staging root) is rejected.
- Verification failure never changes the current pointer.
- Start/health failure uses the existing rollback path.
- Automatic update checks remain asynchronous after the Harness UI is ready.
- The production updater has a testable zero-call contract for npm installation.
