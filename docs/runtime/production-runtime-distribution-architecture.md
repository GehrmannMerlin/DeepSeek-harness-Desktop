# Production Runtime Distribution Architecture

Date: 2026-08-25 (Asia/Shanghai)
Status: local implementation and documentation complete; Remote Publish Gate not performed.

## End-to-end flow

```text
npm dist-tags.latest
  -> exact upstream source tag dsh-v<VERSION> and peeled commit
  -> Windows x64 Factory
  -> immutable Candidate Release dsh-runtime-v<VERSION>
  -> remote candidate asset/index verification
  -> manual Promotion or Rollback
  -> GitHub Pages stable index
  -> Desktop VerifiedRuntimeUpdateSource
  -> download/hash/extract/verify/activate
  -> existing Desktop rollback on failure
```

The npm lookup is an upstream observation only. It selects a version to build; it never becomes a Desktop download source. The Factory must resolve and check out the exact upstream `dsh-v<VERSION>` tag and compare the checked-out commit with the resolved tag commit. No master/main fallback is allowed.

## Channels and state

| Channel | Durable location | Meaning | Allowed mutation |
| --- | --- | --- | --- |
| Candidate | GitHub Release tag `dsh-runtime-v<VERSION>`, published prerelease | One immutable Windows x64 artifact plus `runtime-index.json`, provenance, and a durable `REMOTE_VERIFY=REMOTE_VERIFIED` marker after readback | Factory may create the Release or add an absent asset. Existing bytes are compared and conflicting bytes fail. |
| Stable | GitHub Pages `runtime/stable/runtime-index.json` | The single version Desktop is allowed to select from the public distribution channel | Only the manual promotion workflow replaces it after candidate validation and remote verification. |
| Rollback | GitHub Pages `runtime/history/<timestamp>-<VERSION>.json` plus manual promotion to a prior verified Candidate | An auditable pointer change back to a prior candidate; it does not rebuild or mutate the old artifact | Manual promotion workflow only; rollback requires the candidate's durable remote-verification marker. |

Candidate and stable are separate channels. A successful Factory run ends in `WAITING_FOR_PROMOTION`; it must not mutate stable. A rollback changes the stable pointer and preserves the previous stable index in history; it does not delete Release assets.

## Exact names and URLs

For exact SemVer `<VERSION>` and repository `<OWNER>/<REPO>`:

- source tag: `dsh-v<VERSION>` in `https://github.com/deepseek-ai/deepseek-harness`;
- candidate Release tag: `dsh-runtime-v<VERSION>`;
- ZIP asset: `dsh-runtime-<VERSION>-win32-x64.zip`;
- candidate Release ZIP URL: `https://github.com/<OWNER>/<REPO>/releases/download/dsh-runtime-v<VERSION>/dsh-runtime-<VERSION>-win32-x64.zip`;
- candidate index asset: `https://github.com/<OWNER>/<REPO>/releases/download/dsh-runtime-v<VERSION>/runtime-index.json`;
- stable Pages index: `https://<OWNER>.github.io/<REPO>/runtime/stable/runtime-index.json`;
- history index: `https://<OWNER>.github.io/<REPO>/runtime/history/<timestamp>-<VERSION>.json`.

The `runtime-index.json` artifact entry must contain the exact package name `@deepseek-ai/dsh`, exact version, `win32`, `x64`, positive `sizeBytes`, lowercase hexadecimal SHA-256, a manifest, and the exact HTTPS candidate Release ZIP URL. Desktop consumes the stable Pages copy and then follows that validated `artifactUrl`; it never parses GitHub Releases HTML.

No stable production URL is claimed for the current repository: the expected path was probed read-only and returned 404, and no Pages deployment was performed.

## Atomicity and integrity

There are two publication boundaries:

1. Candidate publication is immutable. The Factory validates the local Factory output, compares the local hash and size with any existing remote asset, uploads only missing assets, and reads back exactly one uploaded ZIP and one index. A byte conflict fails the run. The source tag/commit is recorded in Release notes and must match the exact upstream resolution. The remote verification marker is written only after readback succeeds.
2. Stable publication is a complete-tree Pages publication. The promotion workflow downloads and verifies the candidate, writes the new stable index and history, stages the whole `runtime/` tree, validates the staged stable index and history, uploads one Pages artifact, and deploys it. It never exposes a partially written local tree as the final Pages artifact. Stable replacement is therefore atomic at the Pages deployment boundary from the workflow's perspective; the previous index is retained in history before replacement.

Desktop treats the fetched index and each artifact as untrusted until schema, identity, HTTPS URL, hash, size, ZIP safety, extracted runtime, CLI/Web/health/native verification, and existing promotion checks pass. Any failure leaves the active runtime and stable pointer unchanged.

## Ownership boundaries

| Owner | Responsibilities | Explicit non-responsibilities |
| --- | --- | --- |
| npm/upstream source | Announces `dist-tags.latest`; provides exact `dsh-v<VERSION>` source tag and commit | Does not host the Desktop runtime artifact or stable index |
| Windows Factory | Builds on Windows x64 with Node `24.18.0`, pnpm `11.7.0`, frozen lockfile; assembles the full Web/native closure; self-smokes; records provenance; creates/reconciles Candidate Release assets | Does not promote stable or run in the Desktop user's update path |
| Distribution workflows | Validates candidate identity and remote bytes; manually promotes or rolls back; stages Pages and history | Does not rebuild during promotion/rollback; does not use npm to install a Desktop runtime |
| GitHub Releases | Stores immutable Candidate ZIP and index assets | Is not the stable Desktop index |
| GitHub Pages | Serves the stable index and rollback history over HTTPS | Does not build the runtime |
| Desktop | Reads configured stable index; downloads, hashes, extracts, verifies, activates, persists, and rolls back runtime | Does not call npm/pnpm in the production verified-artifact path and does not mutate Releases or Pages |

## Failure and rollback invariants

- Missing or unconfigured index URL is safe and non-promoting.
- A newer npm version with no verified Candidate remains invisible to Desktop.
- A failed Factory may leave logs only; it cannot advance stable.
- A candidate with missing or conflicting assets cannot be promoted.
- Rollback must target a previously remote-verified candidate and must preserve the prior stable index in history.
- Desktop activation or health failure uses the existing runtime rollback path.
- No workflow in this architecture claims a remote deployment until an authorized run and HTTPS readback provide evidence.
