# DSH Runtime Update — Task 13 Verification

Date: 2026-08-24 (Asia/Shanghai)
Worktree: `D:\Develop\DeepSeek Agent\DeepSeek Agent Desktop\.worktrees\dsh-runtime-updater`
Branch: `codex/dsh-runtime-updater`
Verification mode: Windows x64, isolated temporary outputs only

## Environment

- OS: Windows NT 10.0.26200
- Node.js: v24.18.0 (`D:\Develop\node.js\node.exe`)
- npm CLIs observed: 11.16.0 and 11.11.0
- Electron: 43.4.0
- electron-builder: 26.15.3
- npm package: `@deepseek-ai/dsh@0.1.0-rc.7`
- Official Registry diagnostic: `https://registry.npmjs.org`
- Worktree npm configuration at the time of the build: `registry=https://registry.npmmirror.com`, `strict-ssl=false`; no global npm configuration was modified.

All generated build/install outputs used explicit paths below `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-*`. No existing installation, Program Files directory, or real application `userData` directory was targeted.

## Commands and results

### Real Registry checks

The following official Registry metadata query completed successfully:

```powershell
& 'D:\Develop\node.js\node.exe' `
  'D:\Develop\node.js\node_modules\npm\bin\npm-cli.js' `
  view '@deepseek-ai/dsh@0.1.0-rc.7' version `
  --registry='https://registry.npmjs.org' `
  --fetch-timeout=10000 --fetch-retries=0
```

Result: HTTP 200 and `0.1.0-rc.7`.

The real preparation hook was attempted with:

```powershell
npm run prepare:bundled-runtime
```

Observed sequence:

1. Before the fix, Windows `npm.cmd` with `shell:false` failed immediately with `spawn EINVAL`.
2. After the safe npm-shim fix, the same hook entered npm installation but reached the original 120-second timeout without output.
3. The build-only timeout was raised to 10 minutes. A subsequent default-version run reached approximately five minutes and the npm child exited with code 134 while resolving the very large DSH dependency tree.
4. Independent direct installs into unique temporary prefixes using npm 11.16 and npm 11.11, including the official Registry, remained in dependency-tree resolution for more than the bounded wait and were stopped with Ctrl+C. Their logs showed hundreds of DSH package manifests being resolved; no valid runtime was published.

Evidence logs retained until the final cleanup step:

- `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-prepare.log`
- npm debug logs `D:\Develop\node.js\node_cache\_logs\2026-08-24T04_08_33_888Z-debug-0.log` and `D:\Develop\node.js\node_cache\_logs\2026-08-24T04_12_27_543Z-debug-0.log`
- Direct-install prefixes beginning `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-install-`

Blocker: the real pinned DSH dependency installation did not complete in the bounded verification window and produced no verified real bundled runtime. Consequently, the standard `npm run pack` and `npm run dist` hooks were not allowed to retry the same blocked preparation. This is an evidence-backed environment/package-tree blocker, not a claim that the real runtime is valid.

### Tests before packaging

```powershell
npm test
```

Result: 105 tests passed, 0 failed.

Focused product-fix checks:

```powershell
node --test test/npm-command.test.js test/npm-installer.test.js test/prepare-bundled-runtime.test.js
```

Result: 11 tests passed, 0 failed.

The deterministic integration matrix remains covered by:

```powershell
node --test test/dsh-runtime-update-integration.test.js
```

The full suite above includes that matrix and all prior unit tests.

### Replacement-agent bounded re-verification

After the original live preparation attempt was stopped, the replacement
verification pass ran only bounded, non-installing checks:

```powershell
npm test
```

Result: **105 tests passed, 0 failed** (fresh run on 2026-08-24).

```powershell
& 'D:\Develop\node.js\node.exe' `
  'D:\Develop\node.js\node_modules\npm\bin\npm-cli.js' `
  view '@deepseek-ai/dsh@0.1.0-rc.7' version `
  --registry='https://registry.npmjs.org' `
  --fetch-timeout=10000 --fetch-retries=0
```

Result: **`0.1.0-rc.7`** (fresh official-Registry metadata check).

The real `prepare:bundled-runtime`, `npm run pack`, and `npm run dist` hooks
were intentionally not retried: they all depend on the same large real DSH
dependency installation that had already been bounded, timed out, and then
exited with code 134. This avoids turning the verification into an unbounded
live build.

A structural fixture already present under the task-owned
`build/bundled-runtime` was used for one additional bounded directory build:

```powershell
node node_modules/electron-builder/out/cli/cli.js --dir `
  --config electron-builder.yml `
  --config.directories.output=<task-owned-temp-output>
```

Result: electron-builder **26.15.3 exited 0** in 6.9 seconds. The fresh
unpacked output was written under:

`C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-reverify-91909938cdb7400693c84f694fc5ae67`

An earlier PowerShell `Start-Process` wrapper attempt exited before invoking
electron-builder because the space-containing Node script path was split as
`D:\Develop\DeepSeek`; it produced no build result and was discarded. The
direct Node argument-array invocation above is the result used for packaging
verification.

Fresh structural observations:

- `resources\app.asar` contained 103 entries; `@electron/asar` found zero
  entries matching `bundled-runtime` or `runtime-manifest`.
- `resources\bundled-runtime\runtime-manifest.json` existed and declared
  `@deepseek-ai/dsh@0.1.0-rc.7`.
- The external fixture package metadata and CLI existed and both declared or
  exercised `0.1.0-rc.7`.
- Fresh hashes matched the previously recorded structural fixture:
  - `app.asar`: `8D70F68038D2548B6E7BE5055D093070CEAB1A3E1210BE446EAC6B847E4A5B32`
  - `runtime-manifest.json`: `E439027D2BEAC72DEF8C42C5C941CC1F3B2C98A6E3947CC340EE939313626044`
  - DSH `package.json`: `133F3F628C3B30F1339316BB53238A4B4F6FCD892472A411D9417664A112FB3D`
  - DSH CLI: `DA8AA3D63156BCF6426C9DBB270F784D5230A796B283BF934A9497A1D0F291AD`

This remains a structural packaging check, not proof that the real DSH
dependency tree was prepared. The real NSIS build and isolated installer
smoke results recorded above were produced from the same labeled structural
fixture; those temporary artifacts were subsequently removed.

### Product fixes exposed by real verification

Two minimal fixes were made and covered by regression tests:

1. Windows `.cmd` shims cannot be launched directly with `shell:false`. `src/update/npm-command.js` resolves an npm shim on PATH to its sibling `node.exe` and `node_modules/npm/bin/npm-cli.js`; both the build preparation script and runtime installer use that invocation only for their real default spawner.
2. A structural electron-builder build initially copied only `runtime-manifest.json`; nested bundled-runtime `node_modules` were excluded. `electron-builder.yml` now adds an explicit `build/bundled-runtime/node_modules` extra-resource mapping, and the packaging test asserts the mapping.

The build preparation timeout was also increased from 120 seconds to 10 minutes after the real DSH dependency tree exceeded the original limit. Even with that change, the observed npm child exited with code 134 before publishing a real runtime.

### Unpacked build and asar inspection

Because the real runtime preparation was blocked, a clearly labeled structural fixture was used only to exercise electron-builder resource copying. The fixture was not presented as a real DSH runtime and was removed after inspection.

Command:

```powershell
npx electron-builder --dir --config electron-builder.yml `
  --config.directories.output='C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-artifacts\win-unpacked'
```

Result: exit code 0.

Unpacked artifact:

- Directory: `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-artifacts\win-unpacked\win-unpacked`
- `resources\app.asar`: 529,595 bytes, SHA-256 `8D70F68038D2548B6E7BE5055D093070CEAB1A3E1210BE446EAC6B847E4A5B32`
- asar entries: 103
- asar entries matching `bundled-runtime` or `runtime-manifest`: 0
- external resource root: `resources\bundled-runtime`
- structural fixture `runtime-manifest.json`: 123 bytes, SHA-256 `E439027D2BEAC72DEF8C42C5C941CC1F3B2C98A6E3947CC340EE939313626044`
- structural fixture `node_modules\@deepseek-ai\dsh\package.json`: 100 bytes, SHA-256 `133F3F628C3B30F1339316BB53238A4B4F6FCD892472A411D9417664A112FB3D`
- structural fixture CLI: 442 bytes, SHA-256 `DA8AA3D63156BCF6426C9DBB270F784D5230A796B283BF934A9497A1D0F291AD`
- structural fixture manifest and package version: `0.1.0-rc.7`
- `verifyRuntime` against the packaged structural fixture: `{ ok: true, reportedVersion: "0.1.0-rc.7", code: 0 }`

The first structural build exposed the missing nested `node_modules`; after the explicit mapping was added, the second build contained all three fixture files above. This validates the resource layout contract, but not the size or completeness of a real DSH dependency tree.

### Windows installer build

The standard `npm run dist` command was blocked by its required real preparation hook, so it was not retried. The equivalent electron-builder target was run against the same isolated structural fixture:

```powershell
npx electron-builder --win --config electron-builder.yml `
  --config.directories.output='C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-artifacts\nsis'
```

Result: exit code 0.

Artifacts:

- Setup: `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-artifacts\nsis\DeepSeek Harness Desktop Setup 1.0.0.exe`
  - 99,985,167 bytes
  - SHA-256 `9E9B9645D119CEFB2D935FA1A57C4E3E2039B83DD41685ED71D74E8F255562E6`
- blockmap: `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-artifacts\nsis\DeepSeek Harness Desktop Setup 1.0.0.exe.blockmap`
  - 105,359 bytes
  - SHA-256 `574A65BFFD4EEA7DC4C777FA0195F726E31CEE7D9EFC3A1E3658D6C0C3BB419D`
- installer-side unpacked executable:
  - `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-artifacts\nsis\win-unpacked\DeepSeek Harness Desktop.exe`
  - 225,782,272 bytes
  - SHA-256 `038C88B839C24448A0E702E5D4CF10ACE30F641CDDB6F363707CF19539D954A3`

### Isolated installer smoke

The generated structural-fixture Setup was installed silently with:

```powershell
Start-Process -FilePath '...\DeepSeek Harness Desktop Setup 1.0.0.exe' `
  -ArgumentList @('/S', '/D=C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-artifacts\installed') `
  -Wait -PassThru
```

Result: installer exit code 0; target was the new directory:
`C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-artifacts\installed`.

Installed checks passed:

- `resources\app.asar` exists: 529,595 bytes, SHA-256 `8D70F68038D2548B6E7BE5055D093070CEAB1A3E1210BE446EAC6B847E4A5B32`.
- `resources\bundled-runtime` exists outside asar.
- Installed manifest, package metadata, and CLI files match the structural fixture hashes above.
- Installed executable exists: 225,782,272 bytes, SHA-256 `038C88B839C24448A0E702E5D4CF10ACE30F641CDDB6F363707CF19539D954A3`.

The final GUI launch/Harness smoke was not run after the user-directed bounded-wait stop. It would not constitute real DSH verification because the installed package used the structural fixture. Renderer update-dialog behavior, manual Registry error handling, and “no install before confirmation” remain covered deterministically by the Task 12 integration tests rather than by this fixture install.

## Cleanup

Before final cleanup, the following task-owned paths were recorded:

- `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-artifacts` (unpacked build, NSIS output, and isolated install)
- `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-install-0ab64cc91396439cb9370f91dcb5e598`
- `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-install-1ced168cae4f43738b1d54c6f8b882f3`
- `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-install-npm1111-606cb38b526f466f9f50dfa4fc11bb8c`
- `C:\Users\韩吉衍\AppData\Local\Temp\dsh-task13-prepare.log`
- worktree-generated structural fixture `build\bundled-runtime`

Only these explicit paths were removed. No Program Files path, existing installation, global npm configuration, or real userData path was modified.

## Final status

- Real Registry metadata: PASS.
- Real pinned bundled-runtime preparation: BLOCKED by npm dependency-tree resolution / child exit 134 after the initial shell-launch defect was fixed; no real runtime published.
- Focused tests: PASS, 11/11.
- Full tests: PASS, 105/105.
- Structural unpacked resource/asар inspection: PASS using a labeled fixture.
- Equivalent NSIS artifact build: PASS using the labeled fixture.
- Isolated silent install and installed resource inspection: PASS using the labeled fixture.
- Real DSH app launch/update smoke: NOT RUN; blocked by the absence of a real prepared runtime and final bounded-wait instruction.
- Replacement-agent bounded re-verification: PASS for the full test suite,
  official Registry metadata, and a structural unpacked-directory build;
  real runtime preparation remains BLOCKED as documented above.
- `git diff --check`: required as the final pre-commit gate.

## Verified Runtime Artifact implementation follow-up

The current implementation adds the artifact/index/downloader path described
in `docs/runtime/verified-runtime-artifact-architecture.md`:

- `VerifiedRuntimeArtifact` rejects wrong package, version, target, hash, size,
  URL, manifest identity, and unsafe archive entries.
- `VerifiedRuntimeUpdateSource` selects only the exact `win32-x64` entry from a
  validated index; the update manager records upstream and verified versions
  separately and compares only the verified version.
- `RuntimeArtifactDownloader` streams to `.part`, checks byte count and
  SHA-256 before rename, validates ZIP paths before extraction, and removes
  failed operation output.
- Default `AppLifecycle` wiring constructs the verified source and downloader;
  `NpmInstaller` is no longer constructed as the production update path.
- `prepare-bundled-runtime.js` refuses a missing verified artifact by default;
  its explicit npm path is retained only for diagnostic/test injection.

Fresh deterministic verification after this implementation:

```text
npm test
131 passed, 0 failed, exit 0
```

Fresh real Route B artifact verification is recorded in
`docs/runtime/dsh-runtime-release-gate.md` and
`docs/runtime/dsh-runtime-factory-evaluation.md`. The overall release gate is
still BLOCKED because real Desktop update/restart persistence, rollback,
external ownership/pending activation with the artifact, `pack`/`dist`, NSIS
install/update, and installed-app process cleanup remain to be executed.
