# Verification: npm Package Distribution

## Status

`partial` as of 2026-08-21 — deliberately not `verified`. Everything
that can be verified **without real npm publish credentials** was tested
live and passed. The parts that genuinely require a real registry publish
(an actual `npm publish`, `bunx`/`npx` from a fresh machine, macOS/Linux
platform runs) could not be performed in this session and are recorded
honestly as gaps, not glossed over or assumed.

## The design change that happened mid-implementation

The original approved design downloaded the binary from this
repository's GitHub Releases at npm install time. That was found to be
fundamentally broken **for this repository specifically**, not a
theoretical concern:

```
$ gh repo view Muhamad-Yussuf/devops-mcp-server --json visibility
{"visibility":"PRIVATE"}

$ curl -sI https://api.github.com/repos/Muhamad-Yussuf/devops-mcp-server/releases/tags/latest
HTTP/1.1 404 Not Found

$ curl -sI https://github.com/Muhamad-Yussuf/devops-mcp-server/releases/download/latest/orchestrai.exe
HTTP/1.1 404 Not Found
```

Both fully unauthenticated, both 404. No wrapper-code fix changes this —
an unauthenticated `bunx`/`npx` on a machine with no repo access could
never reach either endpoint. Reworked to publish the binary as npm
packages' own tarball content instead, which has no dependency on GitHub
repo visibility at all.

## History audit (performed before recommending repo-visibility as an option)

Searched all 58 commits, full diff history:

- Known API-key patterns (Anthropic, OpenAI, the exact Google/Gemini
  `AQ.` prefix shape from this project's own earlier chat-paste incident,
  GitHub `ghp_`, AWS `AKIA`, PEM private key blocks): **zero matches**.
- `.env` files ever committed: **none**.
- Key/cert/credential-named files ever committed: **none**.
- Every long token-like string across the entire history (295 candidates
  from `bun.lock` alone, 46 more elsewhere) manually triaged: all are
  `bun.lock` integrity hashes, SHA-256 *content*-verification hashes used
  as evidence in existing verification docs (e.g. "file unchanged, hash
  `4AB39858...`"), or task/child UUIDs from live-run captures. Nothing
  resembling a real secret.

Recorded for completeness even though the final design no longer depends
on this — it was the direct trigger for researching whether npm-hosted
binaries were even size-feasible, which is the evidence below.

## npm's real size limit — sourced, not assumed

Two independent live web searches confirmed the actual current limit,
sourced to real observed errors and a direct npm-support quote:

- A real `413` error message: `package size is too large: 282071924
  bytes, max size allowed is 268435456 bytes` — 268,435,456 bytes =
  **exactly 256 MB**.
  ([GitHub Discussion #110184](https://github.com/orgs/community/discussions/110184))
- npm support, quoted directly by a user who asked about raising it:
  *"this is the fixed size and nothing could be done — even saying that I
  would pay more only to use it."*
  ([npm/feedback Discussion #816](https://github.com/npm/feedback/discussions/816))

## Local, credential-free verification (all performed live)

### Package name availability

Checked against the real public npm registry API (`registry.npmjs.org`,
no auth needed for a GET):

| Name | Result |
|---|---|
| `orchestrai` | 404 — available |
| `orchestrai-win32-x64` | 404 — available |
| `orchestrai-linux-x64` | 404 — available |
| `orchestrai-darwin-arm64` | 404 — available |

### A real `npm pack` — not a dry-run

Built the real Windows binary (`bun run build`, 147,642,880 bytes),
copied it into `npm-package/win32-x64/bin/orchestrai.exe`, ran a genuine
`npm pack` (no `--dry-run`):

```
npm notice package: orchestrai-win32-x64@0.0.0
npm notice Tarball Contents
npm notice 147.6MB bin/orchestrai.exe
npm notice 431B package.json
npm notice package size: 71.3 MB
npm notice unpacked size: 147.6 MB
npm notice shasum: a7bf27ad8d2264d5dbd0c64892e700008f237df2
npm notice integrity: sha512-n2/4F1i7IAQeN[...]F8MtWFhZwoqQw==
npm notice total files: 2
```

**71.3 MB packed — 185 MB under the 256 MB limit.** The resulting
`.tgz` was then extracted with `tar` (not npm — proving the tarball
itself is a valid, standard archive) and the extracted binary was
executed directly: it printed the real `orchestrai` help text
correctly, confirming nothing about the binary was corrupted by the
pack/extract round trip.

The meta package (`orchestrai`) packed to a negligible size (3 files:
`package.json`, `README.md`, `bin/orchestrai.js`) — no binary content,
as designed.

Linux and macOS binaries could not be locally built or packed on this
Windows development machine (no cross-compilation, per `specs/017`'s own
Non-Goals) — their sizes are inferred from prior measurements
(`specs/019`: Linux ~164.7 MB uncompressed) to remain comfortably under
the limit even before compression, but this is not the same as a real
`npm pack` on those platforms. Recorded as a gap below.

### Dispatcher logic against a realistic `node_modules` layout

Constructed `node_modules/orchestrai-win32-x64/bin/orchestrai.exe` (the
real compiled binary) and `node_modules/orchestrai/bin/orchestrai.js`
(the real dispatcher script) by hand, matching exactly what npm's own
install would produce, then ran `node bin/orchestrai.js --help` from
inside that structure:

- **Happy path**: the dispatcher's `require.resolve()` correctly found
  the platform package, `spawnSync`'d the real binary, and the real
  supervisor help text printed — argv forwarding confirmed working.
- **Missing-dependency path**: removed the platform package entirely and
  reran — the dispatcher printed
  `orchestrai: The "orchestrai-win32-x64" optional dependency isn't
  installed. This usually means the install ran with --no-optional or
  --ignore-scripts...` and exited with code 1. No crash, no stack trace,
  the documented behavior exactly.

### CI workflow validated, not eyeballed

- The full `build-binaries.yml` (including the new `macos-latest` leg,
  the `v*` tag trigger, the immutable-release step, and the new
  `publish-npm` job) was parsed with a real YAML parser
  (`import { parse } from "yaml"`, already present in `node_modules`),
  confirming valid syntax and the correct job graph
  (`publish-npm` needs `build`, gated on `startsWith(github.ref,
  'refs/tags/v')`).
- **Every pinned Action SHA was verified against the real upstream
  repository**, not typed from memory and trusted: `actions/setup-node`'s
  SHA was looked up live via `gh api repos/actions/setup-node/git/refs/
  tags/v4.4.0` and confirmed to match exactly before being written into
  the workflow.
- The exact `node -e` version-bump snippets the CI job runs (setting all
  four packages' `version` and the meta package's `optionalDependencies`
  pins to a tag) were extracted and run locally against the real
  `npm-package/*/package.json` files with a test tag
  (`1.0.0-test`), confirmed to produce correct output for all four
  files, then reverted to the `0.0.0` placeholder before committing —
  never left in the modified state.

### No interference with the main repository

- `npm-package/` sits outside the Bun workspace's `packages/*`/
  `packages/agents/*`/`apps/*` globs (confirmed by reading root
  `package.json`'s own `workspaces` field) — it is not swept into the
  monorepo's dependency graph.
- `bun test`: 300 passed, 0 failed (unchanged). `bun run typecheck`: 0
  errors. `bun run specs:check`: passed for 33 specs.
- `.gitignore` updated so no binary ever built locally by
  `scripts/npm-pack-check.ts` gets accidentally committed
  (`npm-package/*/bin/*`), matching this repo's existing "never commit a
  compiled executable" precedent.

## No checksum-publishing CI step needed — a real finding

The original spec's Scope committed to adding a checksum-publishing step
to `build-binaries.yml`. That step was never added, deliberately: GitHub's
own Releases API already serves a `digest` field (`"sha256:<hex>"`) per
asset natively — confirmed live via `gh api repos/.../releases/tags/latest`
returning real `"digest":"sha256:..."` values for both existing assets,
with no extra workflow step required to produce them. Separately, npm's
own registry independently computes and verifies each package's integrity
hash (a real `sha512-...` value, observed directly in the `npm pack`
output above) automatically as part of publish/install. Neither
distribution channel needed this repository to invent its own checksum
mechanism.

## Known gaps — honest, not glossed over

Everything below requires a real, live npm registry publish, which needs
credentials this session does not have and should not create
unilaterally:

- **No actual `npm publish` has ever run.** The `publish-npm` CI job is
  real, YAML-valid, and its logic was tested piece by piece, but the job
  itself has never executed end to end (it requires an `NPM_TOKEN`
  secret that does not exist yet, and is gated on a version tag that has
  never been pushed).
- **`bunx orchestrai`/`npx orchestrai` has never been run from a genuinely
  fresh machine with no local clone.** The dispatcher was tested against
  a hand-constructed `node_modules` layout on the same development
  machine, which proves the *logic* is correct but not the full
  install-from-registry experience.
- **Linux and macOS were not locally testable at all** on this Windows
  development machine — no `npm pack`, no execution, no size
  confirmation beyond the documented 256 MB limit and prior binary-size
  measurements from other specs.
- **The Gatekeeper `xattr` workaround documented in the README was not
  verified against a real Gatekeeper block** — there is no macOS machine
  available in this session.
- **A deliberately corrupted/mismatched install was not induced against a
  real published package** — there is nothing published yet to corrupt.
- **Pinned-version resolution after a subsequent publish was not
  verified** for the same reason.

## Next step

Once Yusuf adds an `NPM_TOKEN` repository secret and pushes a real `v*`
tag (a deliberate, manual act this spec intentionally does not automate),
the `publish-npm` job will run for the first time. At that point the
remaining gaps above should be closed with real `bunx`/`npx` runs from a
genuinely external machine — not by this session, since it has no way to
simulate "a machine with no local clone" from inside the repository
itself.

## 2026-08-21 update: real `npm publish`, CI job failure, and a live spam-filter finding

The `v0.1.1` tag was pushed and triggered `Build Binaries`. The
`publish-npm` job's build/release legs succeeded, but the publish step
itself failed with:

```
npm error command git --no-replace-objects ls-remote
  ssh://git@github.com/npm-package/win32-x64.git
npm error git@github.com: Permission denied (publickey).
```

Root cause: `npm publish npm-package/win32-x64` (no leading `./`) is
parsed by npm as a GitHub shorthand spec (`owner/repo`), not a local
filesystem path. Reproduced locally with `npm publish
npm-package/win32-x64 --dry-run` (identical error), fixed by adding `./`
to all four `npm publish` invocations in the workflow — commit `fde2120`.
That same commit's message also claimed a fix for `repository.url`'s
`git+https://…` format (an npm auto-correction warning on every publish);
the actual diff in that commit did the opposite, leaving `git+https://…`
in place in all four `package.json` files. Found and corrected for real
in this update.

With CI's `NPM_TOKEN` secret still not created, Yusuf ran the four `npm
publish` commands **manually**, authenticated locally. Three succeeded:

| Package | Result |
|---|---|
| `orchestrai@0.1.1` | ✅ published — confirmed live via `npm view orchestrai version` |
| `orchestrai-linux-x64@0.1.1` | ✅ published — confirmed live |
| `orchestrai-darwin-arm64@0.1.1` | ✅ published — confirmed live |
| `orchestrai-win32-x64@0.1.1` | ❌ rejected, 3 attempts |

The Windows package was rejected on **three** separate attempts —
including one attempt that completed a full, non-interrupted, freshly
re-authenticated browser OTP flow — every time with the identical:

```
npm error code E403
npm error 403 403 Forbidden - PUT https://registry.npmjs.org/orchestrai-win32-x64
  - Package name triggered spam detection; if you believe this is in
  error, please contact support at https://npmjs.com/support
```

The first hypothesis was that an earlier *interrupted* publish attempt
(Ctrl+C'd mid-OTP-prompt) had left the name in a bad state. That was
ruled out live: the second and third attempts were clean, uninterrupted,
fully-authenticated runs and still hit the identical 403. A follow-up
`npm view orchestrai-win32-x64` after the failures returned a plain 404
(nothing landed, not a corrupted publish), ruling out a stuck partial
state. The three sibling packages, published in the same session with
the identical `orchestrai-<platform>-<arch>` naming shape, were
unaffected — pointing to something specific to the string
`orchestrai-win32-x64` (or possibly account-level abuse-heuristic
behavior that happened to land on that one request) rather than a
version, timing, or account-trust issue that a retry would clear.

**Fix applied:** renamed the package to `orchestrai-windows-x64` (a name
with no prior rejected-publish history), updated:
- `npm-package/win32-x64/` → `npm-package/windows-x64/` (`git mv`,
  `package.json` `name` field updated; `os`/`cpu` restrictions unchanged
  — those must stay Node's real platform values, `win32`/`x64`, only the
  npm *package name* changed)
- `npm-package/orchestrai/bin/orchestrai.js` — `PLATFORM_PACKAGES`'s
  `win32-x64` entry now points at `orchestrai-windows-x64`
- `npm-package/orchestrai/package.json` — `optionalDependencies` key
  swapped; version left at the `0.0.0` placeholder in the committed file
  (CI/manual publish sets the real version at publish time, per existing
  convention) — but since `orchestrai@0.1.1` is already published and its
  dependency pins are immutable, the corrected pin can only ship as
  `orchestrai@0.1.2`
- `.github/workflows/build-binaries.yml`'s `publish-npm` job — all three
  `win32-x64` references (mkdir/cp, version-bump loop, publish command)
  updated to `windows-x64`
- `README.md`, `npm-package/orchestrai/README.md`, `CLAUDE.md` — updated
  to the new name and the accurate 3-of-4-published state

**Update, same day, after Yusuf ran the publish commands manually:**
`orchestrai-windows-x64` published cleanly on the first try — no spam
filter, confirming the rename fixed it. It landed first at `0.0.0`
(this session's committed placeholder version, not yet bumped when Yusuf
ran the command) rather than `0.1.1`; rather than leave a stray `0.0.0`
version sitting on the registry, it was bumped to `0.1.2` and republished
alongside `orchestrai@0.1.2` (whose `optionalDependencies` now correctly
mixes pins: `orchestrai-windows-x64@0.1.2`, `orchestrai-linux-x64@0.1.1`,
`orchestrai-darwin-arm64@0.1.1` — the already-published Linux/macOS
packages didn't need to move). Both confirmed live via `npm view`
(`orchestrai` briefly still reported `0.1.1` immediately after
publishing — npm's own "package is being processed" queuing, resolved
within one 15s poll).

**All four packages are now published and live:**

| Package | Live version |
|---|---|
| `orchestrai` | `0.1.2` |
| `orchestrai-windows-x64` | `0.1.2` |
| `orchestrai-linux-x64` | `0.1.1` |
| `orchestrai-darwin-arm64` | `0.1.1` |

**One more real gap closed, not simulated:** `npm install orchestrai@0.1.2`
was run in a genuinely fresh scratch directory (no local clone, no
workspace context) — npm correctly resolved and installed only
`orchestrai-windows-x64` as the platform optional dependency, and
executing the installed `orchestrai` binary printed real supervisor help
output from the actual compiled binary. This is the first real evidence
that `bunx`/`npx orchestrai` works end to end on a machine with nothing
pre-installed — previously only reasoned about via a hand-built
`node_modules` layout on the same development machine.

**Correction to an earlier assumption in this file:** the `repository.url`
"fix" (bare `https://…` instead of `git+https://…`) does not actually
stop npm's auto-correction warning — every real publish in this session
still printed `npm warn publish "repository.url" was normalized to
"git+https://…"` regardless of the committed source format. npm always
normalizes to the `git+` form at publish time; there is no source format
that avoids the notice. It's harmless (a `npm notice`-level normalization,
not an error) and the bare-URL form is still arguably the more correct
thing to commit, but it should not have been described as "fixing" the
warning — corrected here rather than left stated inaccurately.

## 2026-08-21 update: EACCES on Linux/WSL — missing executable bit, fixed in the dispatcher

Yusuf's colleague hit `spawnSync .../orchestrai-linux-x64/bin/orchestrai
EACCES` running `npx orchestrai init` for real, from a genuine WSL Linux
`npx` (after separately fixing a WSL-resolves-Windows-npx issue — see
`specs/031`'s verification.md for that half of the session). Root-caused
live, not guessed:

```
$ npm pack orchestrai-linux-x64@0.1.1 && tar -tvf *.tgz
-rw-r--r-- 0/0  164680904  package/bin/orchestrai
```

No executable bit. Both `orchestrai-linux-x64@0.1.1` and
`orchestrai-darwin-arm64@0.1.1` were published manually from this
session's Windows machine (see the earlier 2026-08-21 entries above) —
NTFS has no Unix executable-bit concept, and npm/tar faithfully
preserved that absence into the published tarball. Confirmed
`orchestrai-windows-x64`'s `.exe` is unaffected (Windows binaries don't
use this permission model at all) and that this is not a corrupted or
truncated download — the file arrived complete, just with the wrong
mode bits.

**Fix:** rather than republish the ~100–160 MB platform packages (no
Linux/macOS machine available to do that properly, and the same mistake
could recur on any future manual Windows publish), made the dispatcher
self-healing — `npm-package/orchestrai/bin/orchestrai.js` now calls
`chmodSync(binPath, 0o755)` immediately before `spawnSync`, on every
non-`win32` platform, wrapped in a swallowed `try`/`catch` (a chmod
failure, e.g. a read-only filesystem, just falls through to
`spawnSync`'s own existing error handling). This is the same pattern
`esbuild`/`swc` use for the identical class of problem. Published as
`orchestrai@0.1.3` — a tiny (~3 KB) dispatcher-only republish; the
multi-hundred-MB platform packages were not touched.

**Live-verified as fixed**: after `orchestrai@0.1.3` published, Yusuf's
colleague ran `npx --yes orchestrai@0.1.3 init` from the same real WSL
session (npx cache cleared first) and the wizard ran successfully past
the point that previously failed — target path correctly defaulted to
the real cwd, and it proceeded into the interactive prompts. This is the
first genuine Linux/WSL end-to-end success for this spec, not simulated.

**Still not verified**: macOS (`orchestrai-darwin-arm64`) has the
identical missing-executable-bit defect by inspection (same publish
history, same tarball evidence above) and should be fixed by the same
`chmodSync` change, but has not been live-confirmed on a real Mac — no
macOS machine available in this session.

**Still genuinely unverified, deliberately not closed to full `verified`:**
- Linux and macOS packages were never locally testable on this Windows
  development machine — no `npm pack`, no execution, no size confirmation
  beyond the documented limit and prior binary-size measurements.
- The macOS Gatekeeper `xattr` workaround was never verified against a
  real Gatekeeper block — no macOS machine available.
- A corrupted/mismatched install and pinned-version resolution after a
  *third* republish were not induced/tested.
- CI's own `publish-npm` job has still never completed a real end-to-end
  run — every successful publish in this spec's history was run manually,
  outside CI, because `NPM_TOKEN` was never configured as a repository
  secret. The job's logic was fixed (the `./` path bug) but remains
  unexercised as an automated pipeline.

## 2026-08-21 (continued) — CI's `publish-npm` job runs for real; stale meta-package pin found and fixed

`NPM_TOKEN` was added as a repository secret today (confirmed via
`gh secret list`). This section records the first real, automated
`publish-npm` CI run and a genuine bug it caught.

**`v0.1.3` tag push — partial failure, useful, not discarded.** The
`build` (all 3 platforms) and `release` jobs completed successfully; the
new immutable `v0.1.3` GitHub release was published correctly. The
`publish-npm` job published `orchestrai-windows-x64@0.1.3`,
`orchestrai-linux-x64@0.1.3`, and `orchestrai-darwin-arm64@0.1.3`
successfully, then failed on the meta package with:

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/orchestrai -
You cannot publish over the previously published versions: 0.1.3.
```

Root cause, confirmed via `npm view orchestrai time --json`:
`orchestrai@0.1.3` had already been published **manually** at
`2026-08-21T11:16:45Z` (the dispatcher `chmodSync` fix recorded earlier
in this file), roughly 40 minutes before this CI run started. That
manual publish's `optionalDependencies` were necessarily pinned to
whatever platform-binary versions existed at that moment
(`orchestrai-windows-x64@0.1.2`, `orchestrai-linux-x64@0.1.1`,
`orchestrai-darwin-arm64@0.1.1`) — confirmed live via
`npm view orchestrai@0.1.3 optionalDependencies --json`. So the already-
live `orchestrai@0.1.3` was pointing at stale platform binaries even
after CI's own run published fresh `0.1.3` binaries alongside it: not a
broken install (those old pinned versions still resolve fine), but a
real drift bug — `npx orchestrai@latest` was silently serving binaries
that predated that day's specs 032/034 work, not the versions CI had
just built. npm's version immutability meant this could not be
corrected by republishing `0.1.3`.

**Fix: `v0.1.4` tag push — every job green.** `build` → `release` →
`publish-npm` all completed successfully, including the meta-package
publish step this time (`npm notice Your package is being processed and
may take a few minutes to become available` — npm's own propagation
notice, not an error; confirmed resolved ~15s later by polling
`npm view orchestrai version`). Live-confirmed after propagation:

```
$ npm view orchestrai dist-tags --json
{ "latest": "0.1.4" }
$ npm view orchestrai@0.1.4 optionalDependencies --json
{
  "orchestrai-linux-x64": "0.1.4",
  "orchestrai-windows-x64": "0.1.4",
  "orchestrai-darwin-arm64": "0.1.4"
}
```

All three platform packages independently confirmed at `0.1.4` via
`npm view <pkg> version`. A fresh-scratch-directory
`npm install orchestrai@latest` (no local clone) correctly resolved only
`orchestrai-windows-x64` and ran the real compiled binary's `--help`
output.

**Net effect on this spec's open items:** "CI's own `publish-npm` job
completing a real automated run" is now closed — genuinely, via the
`v0.1.4` run, not the earlier `v0.1.3` attempt (which is kept in this
record as evidence the failure mode was real and diagnosable, not
glossed over). Still open, unchanged by this entry: macOS/Linux
execution on a real external machine, the macOS Gatekeeper `xattr`
workaround, induced-corruption failing closed, and pinned-version
resolution after a subsequent publish (this entry's own `0.1.3`→`0.1.4`
transition is suggestive evidence for that last one — `orchestrai-*
@0.1.3` continued to resolve correctly for anyone who'd pinned it
throughout — but wasn't a deliberately designed test for it).

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

  `specs/032-npm-package-distribution/spec.md` (implemented, `partial`
  verification) adds `bunx orchestrai`/`npx orchestrai` as a second,
  **repo-visibility-independent** distribution channel: four npm
  packages — `orchestrai` (a thin dispatcher) plus one binary-only
  package per platform (`orchestrai-windows-x64`, `orchestrai-linux-x64`,
  `orchestrai-darwin-arm64`, each restricted via `package.json`'s
  `os`/`cpu` fields) — published under `npm-package/`, outside the Bun
  workspace. npm's own install-time platform filtering means exactly one
  binary-containing package ever lands in `node_modules`; the dispatcher
  just `require.resolve()`s it and `spawnSync`s it with argv/stdio/exit
  code forwarded. No custom download/checksum code exists anywhere in it
  — npm's own registry already verifies each package's integrity as part
  of a normal install, and GitHub's Release API separately already serves
  a `digest` field per asset natively, so neither channel needed this
  repository to invent a checksum step. Real, local `npm pack` (not a
  dry-run) confirmed the compiled Windows binary packs to 71.3 MB —
  comfortably under npm's fixed, non-negotiable 256 MB per-tarball limit
  (confirmed against real reported `413` errors and a direct npm-support
  quote, not assumed) — and the extracted binary was executed directly
  from the real tarball to confirm nothing was corrupted in the round
  trip. `build-binaries.yml` gained a `macos-latest` leg (unsigned, per
  that spec's Open Decision B — Gatekeeper's block is a documented
  one-line `xattr` workaround, not solved by signing/notarization here)
  and a `v*` tag-triggered `publish-npm` job requiring an `NPM_TOKEN`
  secret this checkpoint does not create.

  **The `v0.1.1` tag's CI `publish-npm` job failed** (`git ls-remote`
  error from a missing `./` prefix on the local package paths) — fixed
  live and confirmed with a clean dry-run. Yusuf then ran the `npm
  publish` commands **manually** (CI has still never successfully
  published — the automated path is fixed but unexercised, since
  `NPM_TOKEN` was never configured as a repository secret).
  `orchestrai-win32-x64@0.1.1` was rejected on **three** separate live
  attempts — including one full, non-interrupted, re-authenticated
  attempt — with an identical `403 Package name triggered spam
  detection` from npm, while the identically-shaped
  `orchestrai-linux-x64`/`orchestrai-darwin-arm64` names published
  cleanly in the same session. Diagnosed as name-specific rather than
  transient (an interrupted first attempt was the initial theory; ruled
  out once a fully clean retry hit the same error) and fixed by renaming
  the package to `orchestrai-windows-x64` — a fresh name with no prior
  rejected-publish history. **All four npm packages are now published
  and live**: `orchestrai@0.1.2`, `orchestrai-windows-x64@0.1.2`,
  `orchestrai-linux-x64@0.1.1`, `orchestrai-darwin-arm64@0.1.1`
  (confirmed via `npm view`, not assumed — `orchestrai@0.1.1`→`0.1.2`
  because its already-published `0.1.1` dependency pins were immutable
  and had to be corrected to the new name in a new version).
  **`bunx`/`npx orchestrai` is now real-machine verified for the first
  time**: `npm install orchestrai@0.1.2` in a genuinely fresh scratch
  directory (no local clone) correctly resolved only
  `orchestrai-windows-x64` as the platform dependency and ran the real
  compiled binary, printing its actual help output — previously only
  reasoned about via a hand-built `node_modules` layout on the same dev
  machine. One inaccurate claim corrected along the way: pre-setting
  `repository.url` to a bare `https://…` does **not** stop npm's
  auto-correction warning — npm normalizes to `git+https://…` at publish
  time regardless of source format; every real publish in this session
  printed that notice. It's harmless either way. **Still genuinely
  unverified:** Linux/macOS were never locally testable on this Windows
  dev machine (no execution, no size confirmation beyond documented
  limits); the macOS Gatekeeper `xattr` workaround was never checked
  against a real Gatekeeper block. A related full git-history audit (58
  commits) found no committed secrets — see that spec's verification.md.

  **Correction, 2026-08-21: CI's `publish-npm` job has now completed a
  real, fully automated run.** `NPM_TOKEN` was added as a repository
  secret; pushing tag `v0.1.3` ran the full pipeline for the first time
  and surfaced a genuine, useful finding rather than a clean pass: the
  meta package `orchestrai@0.1.3` had already been published **manually**
  shortly before, with its `optionalDependencies` pinned to the
  then-current platform-binary versions (`orchestrai-windows-x64@0.1.2`,
  `orchestrai-linux-x64@0.1.1`, `orchestrai-darwin-arm64@0.1.1`) — stale
  the moment CI's own run published fresh `0.1.3` platform binaries
  alongside it. npm correctly refused to let CI overwrite the
  already-published `orchestrai@0.1.3`, so the meta package publish step
  failed while the three platform binaries succeeded, leaving
  `npx orchestrai@latest` silently serving old binaries rather than a
  build containing that day's specs 032/034 fixes — not broken, just
  drifted from what CI had just built. Fixed by pushing `v0.1.4`, whose
  run completed **every job green**, including the meta-package publish
  (`npm notice Your package is being processed…` — the same brief
  registry-propagation lag noted in `specs/032`'s original session,
  confirmed resolved by polling `npm view` ~15s later). Live-confirmed
  after propagation: `orchestrai@0.1.4`'s `optionalDependencies` correctly
  pin all three platform packages at `0.1.4`, dist-tag `latest` resolves
  to `0.1.4` across all four packages, and a fresh-directory
  `npm install orchestrai@latest` correctly resolved only
  `orchestrai-windows-x64` and ran the real binary. This is now the
  authoritative first real evidence CI's automated publish path works end
  to end — see `specs/032-npm-package-distribution/verification.md` for
  the full record.

  **Correction, 2026-09-02: `orchestrai@0.1.16` published, closing a real
  gap left by the `0.1.4` run above.** The npm packages had silently
  drifted 18 commits (specs `039`-`043`) behind `main`, since nothing had
  pushed either the commits or a new release tag since `v0.1.13` — `npm
  view` showed the registry itself was actually two releases ahead of
  that at `0.1.15` (manual, untagged publishes), so tag history and
  registry history had quietly diverged. Publishing `v0.1.16` surfaced a
  new failure mode CI's automated path hadn't hit before: `npm error code
  EOTP` on the very first `npm publish` call — the `NPM_TOKEN` repository
  secret was a token type requiring a one-time password for publish,
  which an unattended CI runner structurally cannot supply. Not a flake;
  fixed by rotating the secret to an npm **Automation**-type token
  (npm's own type exempt from OTP-for-publish), then rerunning just the
  `publish-npm` job. Two other, unrelated failures were hit and resolved
  in the same session first: a real self-inflicted one (deleting a
  still-uploading run's own GitHub Actions artifacts while trying to
  clear the storage-quota problem `23b587f` already documented — fixed
  by a full rerun instead of touching artifacts again) and a transient
  registry-side 404 on an existing package (fixed by simply retrying).
  All four packages confirmed live at `0.1.16` via `npm view`
  (`dist-tags.latest` correct, `optionalDependencies` correctly
  cross-pinned), and — the decisive check — a genuinely fresh-directory
  `npm install orchestrai@latest` ran the real binary, whose
  zero-argument supervisor startup printed the new `spec 043`
  `[security-agent] LLM commentary: disabled (default)` line, direct
  proof the published build contains that day's actual work, not just a
  version bump. See `context/worklog.md`'s 2026-09-02 release entry for
  the full failure-by-failure trail.

See specs/019-cicd-recreate-and-binary-builds/verification.md for the relocated narrative covering this checkpoint.
