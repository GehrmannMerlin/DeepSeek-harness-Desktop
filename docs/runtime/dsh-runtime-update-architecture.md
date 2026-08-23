# DSH Runtime Update Architecture

Date: 2026-08-23

## Scope

This design updates only the `@deepseek-ai/dsh` runtime used by DeepSeek Harness Desktop. It does not update Electron Desktop itself and does not modify the DeepSeek Harness Web UI, Agent, tools, sessions, workflows, providers, or permissions.

The only remote authority for an installable version is the npm Registry `latest` dist-tag for `@deepseek-ai/dsh`.

## Runtime Ownership Model

```text
Bundled Runtime  -> Desktop installer owns it; immutable at runtime
Managed Runtime  -> DshRuntimeManager owns it below userData/runtime
External Harness  -> User owns it; Desktop may reuse but never stops it
```

### Bundled Runtime

The build process prepares a pinned DSH package tree under an `extraResources` directory outside `app.asar`, for example:

```text
resources/bundled-runtime/
├── package.json
└── node_modules/
    └── @deepseek-ai/dsh/
```

Its files are never overwritten or deleted by the updater. It is the final local recovery target. The current legacy project has no such tree, so the build pipeline must create it; older builds without it retain the system-npx compatibility fallback.

### Managed Runtime

Managed versions are side-by-side and mutable only through the update pipeline:

```text
<userData>/runtime/
├── versions/
│   ├── <version>/
│   │   ├── package.json
│   │   └── node_modules/
│   └── ...
├── staging/
│   └── <version>-<operation-id>/
└── runtime-state.json
```

The updater never installs directly into `versions/<version>`. It installs into staging, verifies the result, and moves the verified directory into `versions` on the same filesystem.

### External Harness

An existing Harness discovered on port 3080 is external unless it was spawned by the current `HarnessProcessManager`. External ownership has no PID controlled by Desktop. It can be used for browsing, but it is not treated as the Desktop's current Managed/Bundled version and is never killed by update or shutdown.

## Runtime Descriptor

`DshRuntimeManager` is the sole producer of runtime descriptors. A descriptor contains:

```js
{
  kind: 'managed' | 'bundled' | 'legacy',
  version: string,
  rootPath: string,
  packagePath: string,
  cliEntry: string,
  command: string,
  args: string[],
  source: 'managed' | 'bundled' | 'system-npx'
}
```

The CLI entry is resolved from the installed package's `bin` metadata and validated against the filesystem. No Tray, Window, Lifecycle, or Updater module reconstructs DSH paths independently.

## State Store

`runtime-state.json` is the durable pointer for current and previous Desktop-owned runtimes:

```json
{
  "schemaVersion": 1,
  "current": {
    "kind": "managed",
    "version": "0.1.1-rc.2",
    "path": "versions/0.1.1-rc.2"
  },
  "previous": {
    "kind": "bundled",
    "version": "0.1.0-rc.7"
  },
  "pending": null,
  "failedVersions": {},
  "lastNotifiedVersion": null
}
```

Writes use a temporary file followed by a completed rename. Invalid JSON, missing paths, schema mismatch, and invalid runtimes are logged and ignored; resolution then falls back to Bundled and finally the legacy system-npx path.

## Update Source and Version Rules

`NpmRegistryUpdateSource` requests the public package metadata endpoint:

```text
https://registry.npmjs.org/@deepseek-ai%2fdsh
```

It reads `dist-tags.latest`, validates the version with `semver.valid()`, and returns the package version plus optional integrity and tarball metadata. It has a short timeout of approximately four seconds. It never installs packages, starts DSH, updates UI, or changes npm configuration.

Comparison is always:

```text
semver.gt(latest, installed)
```

The npm `latest` tag is authoritative even when it points to a prerelease. A lower remote version does not trigger downgrade. Invalid remote data is a failed check, not an install target.

## Update State Machine

`DshUpdateManager` owns one state value and one in-flight operation lock. The states are:

```text
IDLE
CHECKING
UP_TO_DATE
UPDATE_AVAILABLE
PREPARING
INSTALLING
VERIFYING
READY_TO_APPLY
WAITING_FOR_EXTERNAL_HARNESS
STOPPING_CURRENT
SWITCHING
RESTARTING
SUCCESS
FAILED
ROLLING_BACK
ROLLED_BACK
```

Automatic checks run once per primary Desktop process after Harness UI readiness. Tray manual checks may run again after the first check but are serialized with any active check. Repeated update clicks share one Promise and cannot launch multiple npm installers.

## Update Pipeline

```text
Registry check
  -> compare SemVer
  -> notify and expose Tray action

User confirmation
  -> create operation-specific staging directory
  -> npm install exact @deepseek-ai/dsh@<validated-version>
  -> verify package metadata and CLI version
  -> promote staging to versions/<version>

Owned Harness
  -> stop through HarnessProcessManager
  -> atomically activate managed runtime
  -> start descriptor
  -> health check
  -> SUCCESS or rollback

External Harness
  -> do not stop it
  -> persist pending activation
  -> WAITING_FOR_EXTERNAL_HARNESS
```

Install and verification happen while the current owned Harness remains usable. A failed install or verification never changes the current pointer and never stops the current process.

## Verification

The first verification layer checks:

- `node_modules/@deepseek-ai/dsh/package.json` exists.
- `name` equals `@deepseek-ai/dsh`.
- `version` equals the exact requested SemVer.
- `bin` resolves to a real CLI entry.

The second layer runs the resolved CLI version command with a bounded timeout and checks that its reported version matches the requested version. A timeout or non-zero exit is a verification failure.

## Activation and Rollback

Activation changes only the durable pointer; it does not copy the entire runtime. Before switching, the old descriptor is recorded as `previous`. The state store update is atomic, so a crash can at worst leave the previous valid pointer intact or cause the next process to ignore an invalid current pointer and use fallback.

If the new Harness fails to start or fails health check:

```text
stop failed new process
restore previous pointer
restart previous runtime
health check previous
```

The recovery chain is:

```text
current Managed
  -> previous Managed
  -> Bundled Runtime
```

The failed version is recorded to avoid repeatedly notifying for the same bad release during the suppression window. Bundled Runtime is never removed. At most the two newest Managed Runtime directories are retained after a later safe cleanup.

## UI, IPC, and Notifications

The Tray belongs to Desktop and shows the Desktop-owned Runtime version. It provides `检查更新` and, when appropriate, `⬆ 更新到 <version>`.

The Update Dialog is a local Desktop window. Its preload exposes only state/query/intent methods such as:

```text
getUpdateState()
confirmUpdate()
cancelUpdate()
openUpdateLog()
```

No filesystem, shell, spawn, npm, or arbitrary IPC capability is exposed to the renderer. The DSH Web DOM is never modified.

Automatic check failures are silent apart from concise logs. Manual failures may show a local error message. Notifications are shown once per version per Desktop process.

## Startup and Self-Heal

Startup first resolves a local current runtime, starts Harness, and waits for the existing health check. Only after Harness UI readiness is the update check scheduled asynchronously. Boot Timeline records:

```text
update_check_scheduled
update_check_started
update_check_finished
```

Self-heal performs only local validation and cleanup on startup. It never downloads npm packages on the critical path.

## Logging and Security

`update.log` records version, Registry timing/result, staging path, npm executable and argument shape, process result, verification, activation, restart, health check, rollback, and cleanup. It does not record conversation content, API keys, npm tokens, authorization headers, or secret environment variables.

The updater does not modify `app.asar`, Program Files, the Desktop package lock, the user's npm registry/proxy/cache settings, or global npm packages. Exact package versions are passed to `spawn`/`execFile` argument arrays; remote metadata is never interpolated into a shell command.
