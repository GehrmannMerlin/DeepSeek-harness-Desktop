# DSH Runtime Updater Design

Date: 2026-08-23

## Approved Product Constraints

- Follow npm `dist-tags.latest` only.
- Never silently install an update.
- Never put the Registry check on the startup critical path.
- Never update Electron Desktop in this task.
- Never modify `app.asar` or Program Files at runtime.
- Never modify the DSH Web DOM.
- Never kill an External Harness.
- Install new runtimes side-by-side under `app.getPath('userData')`.
- Verify before promotion, switch atomically, health-check after restart, and roll back on failure.

## Existing-System Findings

The current application launches `cmd.exe /d /s /c npx @deepseek-ai/dsh web` through `HarnessProcessManager`. The packaged `app.asar` contains no DSH package. The current local npx cache contains `@deepseek-ai/dsh@0.1.0-rc.7`, whose CLI is declared as `dsh: lib/bin.js`. The npm Registry currently reports `0.1.1-rc.2` as `latest`. Existing process ownership, health checks, Tray lifecycle, and Boot Timeline are reusable.

The full investigation is recorded in [`docs/runtime/current-dsh-runtime-analysis.md`](../../runtime/current-dsh-runtime-analysis.md). The target architecture is recorded in [`docs/runtime/dsh-runtime-update-architecture.md`](../../runtime/dsh-runtime-update-architecture.md).

## Chosen Approach

Use a side-by-side runtime manager with three ownership classes:

1. Build-time Bundled Runtime outside `app.asar` as an immutable fallback.
2. User-data Managed Runtimes under `userData/runtime/versions`.
3. External Harnesses that Desktop can reuse but never stop.

The build preparation script creates the Bundled Runtime from a pinned DSH version. This is necessary because the existing project has no packaged DSH. A legacy system-npx fallback remains for development and older packages without the new resource.

`DshRuntimeManager` produces descriptors; `HarnessProcessManager` only manages process lifecycle; `DshUpdateManager` owns the update state machine; `NpmRegistryUpdateSource` only queries metadata; `RuntimeStateStore` owns atomic state persistence.

## Data Flow

```text
Harness UI ready
  -> DshUpdateManager.checkForUpdates()
  -> NpmRegistryUpdateSource.getLatest()
  -> semver comparison
  -> Tray refresh + one notification when newer

User confirms
  -> Update Dialog sends intent
  -> DshUpdateManager installs into staging
  -> verifies package metadata and CLI
  -> promotes to versions/<version>
  -> owned: stop / activate / restart / health check
  -> external: persist pending activation
  -> failure: restore previous and health-check fallback
```

## File-Level Design

### Runtime and Update Modules

- `src/runtime/runtime-descriptor.js`: descriptor validation and path-safe relative state representation.
- `src/runtime/runtime-state-store.js`: schema validation, atomic read/write, and state defaults.
- `src/runtime/dsh-runtime-manager.js`: Bundled/Managed/legacy resolution, promotion, activation, rollback, cleanup, and self-heal.
- `src/update/npm-registry-update-source.js`: bounded HTTPS Registry metadata query.
- `src/update/dsh-update-manager.js`: update state machine, operation lock, staging installer orchestration, verification, apply, pending activation, notification events, and rollback.
- `src/update/npm-installer.js`: spawn/execFile-based npm installer with output capture and bounded process handling.
- `src/update/runtime-verifier.js`: package metadata, `bin`, CLI version, and timeout validation.

### Lifecycle and UI Integration

- `src/process/harness-process-manager.js`: accept a runtime descriptor for owned launches while preserving External ownership safety.
- `src/lifecycle/app-lifecycle.js`: wire managers, schedule the post-ready check, handle restart/apply/rollback, and refresh UI.
- `src/tray/tray-manager.js`: add version, check, and update actions through callbacks.
- `src/window/update-dialog.js`: local Desktop-owned confirmation/progress/result dialog.
- `src/window/update-preload.js`: minimal context-isolated API.
- `renderer/update.html` and `renderer/update.css`: local localized dialog.
- `src/main.js`: keep orchestration light; register only app/lifecycle wiring needed for the new manager.
- `src/utils/boot-timeline.js`: add update scheduling/start/finish marks at the lifecycle boundary.
- `src/utils/paths.js`: add user-data runtime and bundled-runtime path helpers.
- `src/utils/npx-resolver.js`: expose reliable Node/npm/npx resolution for Windows installer and legacy fallback.

### Packaging and Documentation

- `scripts/prepare-bundled-runtime.js`: build a pinned self-contained DSH tree in a temporary/build resource directory without touching the Desktop lockfile.
- `electron-builder.yml`: include the prepared runtime as `extraResources`, outside `app.asar`.
- `package.json` and `package-lock.json`: add the runtime updater's `semver` dependency and build/test scripts only; runtime npm installs never use this lockfile.
- `docs/runtime/current-dsh-runtime-analysis.md`: investigation evidence.
- `docs/runtime/dsh-runtime-update-architecture.md`: maintenance architecture.

## State and Error Rules

The single update state is the source of truth. Automatic checks are once per primary process and serialized with manual checks. Install and verification failures preserve the current runtime and current Harness. External ownership forces `WAITING_FOR_EXTERNAL_HARNESS` with durable `pending` state. Activation and rollback use atomic state writes and never require copying the current runtime.

Registry/network failures are silent for automatic checks and user-visible for manual checks. Invalid remote SemVer is rejected before any install command can be formed. npm is invoked with argument arrays and an exact package/version; no shell string contains remote metadata.

## Test Strategy

Use dependency injection for Registry transport, npm process runner, filesystem roots, runtime descriptors, health checks, and process ownership. Add focused tests for:

- SemVer newer/equal/older/prerelease/invalid.
- Registry timeout, HTTP errors, invalid JSON, and unexpected package metadata.
- Runtime state defaults, corruption fallback, and atomic replacement.
- Managed/Bundled/legacy resolution and current/previous transitions.
- Staging install success/failure and package/CLI verification.
- State transitions and repeated-operation de-duplication.
- Owned apply success and health-failure rollback.
- External pending activation with no stop call.
- Cleanup and corrupt-state self-heal.

Then run Windows-specific checks for the real Registry, prepared resources, `win-unpacked`, NSIS Setup.exe, installed user-data paths, offline startup, and Boot Timeline ordering.
