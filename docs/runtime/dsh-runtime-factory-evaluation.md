# DSH Runtime Factory Evaluation

Date: 2026-08-24 (Asia/Shanghai)
Branch: `codex/dsh-runtime-updater`
Target: `@deepseek-ai/dsh@0.1.0-rc.7`
Platform: Windows `win32-x64`

## Decision

`ROUTE_A_REJECTED`. Route A can install a package tree with
`--legacy-peer-deps`, but the resulting tree is not a usable DSH runtime.

`ROUTE_B_SELECTED`. The official DSH source revision `99f6f02fe` (the rc.7
release commit) was checked out and built with the source-declared Node and
package-manager contract: Node `24.18.0`, Corepack `pnpm@11.7.0`, and the
repository `pnpm-lock.yaml` with lockfile version `9.0`. The official
`pnpm run build` completed, and the workspace runtime passed CLI, Web, health,
and native smoke checks.

The first `pnpm deploy --prod` output was intentionally rejected during
artifact validation. DSH's Web profile loads workspace packages through its
profile/plugin tree and peer dependencies that are not all represented in the
published package's ordinary dependency closure. The accepted Factory input
therefore includes the frozen-lock external store, all built runtime-mounted
workspace packages, and the Windows native optional packages required by the
profile. A deployment is not accepted until the extracted archive itself
passes the same Web and health contract.

## Acceptance matrix

| Route | Install | Reproducible | CLI | Web | Health | Native | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A: npm + `--legacy-peer-deps` | PASS, exit 0; 427 packages; 2m | NOT ACCEPTED | FAIL | FAIL | NOT RUN | NOT ACCEPTED | `ROUTE_A_REJECTED` |
| B: official pnpm source build | PASS, `pnpm install --frozen-lockfile` | PASS, frozen lock and exact source revision | PASS, `0.1.0-rc.7` | PASS, `http://127.0.0.1:3080` | PASS, `HarnessHealthChecker` | PASS, `node-pty` smoke exit 0 | `ROUTE_B_SELECTED` |

## Route A evidence

The isolated run used a fresh prefix and cache below:

```text
C:\Users\韩吉衍\AppData\Local\Temp\dsh-runtime-factory\route-a\run-20260824-162645
```

The command used the official registry, exact version, real lifecycle scripts,
and no `--ignore-scripts`:

```text
node <npm-cli.js> install
  --prefix <isolated-runtime>
  --legacy-peer-deps
  --no-audit
  --no-fund
  --registry=https://registry.npmjs.org
  --cache <fresh-cache>
  @deepseek-ai/dsh@0.1.0-rc.7
```

Observed result:

- npm exit code: `0`.
- npm output: `added 427 packages in 2m`.
- Runtime files: `29,159`.
- Runtime bytes: `194,554,110`.
- DSH package metadata: name and version correct; `bin.dsh` points to `lib/bin.js`.
- Lifecycle evidence: `node-pty`, `koffi`, and `@deepseek-ai/dsh-subprocess-local` lifecycle steps ran.
- CLI result: FAIL. The real CLI terminated while loading the Web/plugin graph with `ERR_MODULE_NOT_FOUND: @deepseek-ai/cordis-plugin-group`.

This is a functional runtime failure, not an install failure. Publishing this
tree would violate the acceptance contract, so the Route A install is not a
candidate artifact.

## Route B evidence

Official source contract read from the rc.7 revision:

- Source revision: `99f6f02fe`.
- Root version: `0.1.0-rc.7`.
- `packageManager`: `pnpm@11.7.0`.
- Node engine: `^22.19.0 || >=24.0.0`.
- Lockfile: `pnpm-lock.yaml`, `lockfileVersion: '9.0'`.
- Build: `pnpm run build`, which runs the official `build:lib` and `build:web` scripts.

The clean source checkout and build lived under:

```text
C:\Users\韩吉衍\AppData\Local\Temp\dsh-runtime-factory\route-b\run-20260824-162959
```

The workspace build runtime passed:

- `node apps/cli/lib/bin.js --version` → `0.1.0-rc.7`, exit `0`.
- `node apps/cli/lib/bin.js web` → `http://127.0.0.1:3080`.
- Existing `HarnessHealthChecker.waitUntilReady` → `{ "ok": true, "elapsed": 12 }`.
- `node-pty` smoke: benign `cmd.exe /c exit 0`, exit code `0`.

The portable runtime assembly required the official workspace package set in
addition to the normal pnpm deployment closure. It then passed:

- `lib/bin.js --version` → `0.1.0-rc.7`, exit `0`.
- `lib/bin.js web` → `http://127.0.0.1:3080`.
- Existing `HarnessHealthChecker.waitUntilReady` → `{ "ok": true, "elapsed": 15 }`.
- `node-pty` smoke: exit code `0`.

The first archive attempt was rejected because it was created while the
temporary assembly was still changing and did not contain `lib/bin.js`. This
document deliberately does not mark the archive self-smoke as complete until
the production artifact builder creates a frozen ZIP, computes its SHA-256,
and verifies the extracted copy.

### Frozen artifact result — PASS

The implemented `scripts/build-verified-runtime-artifact.js` then created a
frozen, junction-free artifact from the accepted Route B deployment and the
officially built frontend dist. The first retry was rejected because the
runtime closure did not contain `apps/web/dist`; the Factory now requires that
closure input and includes it as `@deepseek-ai/dsh-web-frontend/dist`.

The third run passed all gates:

- Archive: `dsh-runtime-0.1.0-rc.7-win32-x64.zip`.
- Size: `285760485` bytes.
- SHA-256: `7028288f0dfd8f7bf1ef8a24e019bc0ec659c08cc33ddbd3a44a046817f6b01d`.
- Frozen file count: `55725`.
- CLI version: `0.1.0-rc.7`.
- Web URL and `HarnessHealthChecker`: PASS.
- Windows native `node-pty` smoke: PASS.
- Independent ZIP extraction followed by CLI/Web/native self-smoke: PASS.
- `runtime-index.json`: emitted with exact package/version/target,
  byte-size, SHA-256, artifact URL, and manifest identity.

The artifact was subsequently consumed by `prepareBundledRuntime()` with no
npm invocation and resolved by `DshRuntimeManager` as a valid bundled runtime.
This advances the Factory and bundled-runtime rows only; it does not advance
the Desktop update, restart, rollback, NSIS, or installed-app rows.

## Factory requirements carried into implementation

1. Build on Windows for the Windows artifact; native packages are not copied
   from a different platform.
2. Keep the exact source revision, Node version, pnpm version, lockfile hash,
   package version, and artifact SHA-256 in provenance metadata.
3. Assemble the full runtime closure required by the DSH Web profile, not only
   the npm package's direct dependencies.
4. Verify the assembled runtime before archive creation and verify the
   extracted archive again after hash validation.
5. Keep this Factory path outside the Desktop user's update path. The Desktop
   updater consumes the artifact and never invokes npm or pnpm.
