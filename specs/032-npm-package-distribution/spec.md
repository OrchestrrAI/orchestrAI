---
id: 032-npm-package-distribution
title: npm Package Distribution (bunx/npx orchestrai)
area: distribution
change_type: feature
status: implemented
verification: partial
created: 2026-08-21
updated: 2026-08-21
approved_by: Yusuf
approved_on: 2026-08-21
implemented_on: 2026-08-21
amends: []
supersedes: []
superseded_by: []
related:
  - 017-standalone-binary-distribution
  - 019-cicd-recreate-and-binary-builds
---

# Spec: npm Package Distribution (bunx/npx orchestrai)

> Implemented 2026-08-21. See `verification.md` for the full record,
> including a load-bearing design change made mid-implementation (see
> "Superseded design" below) and what remains unverified pending real npm
> publish credentials.

## Purpose

Let a user run `bunx orchestrai` (or `npx orchestrai`) without cloning this
repository, without a GitHub account, and without depending on this
repository's own visibility — npm resolves and installs the package, which
runs the already-existing compiled binary for the caller's platform.

This is **distribution packaging only**. It adds no runtime behavior: the
thing that ends up running is the exact same `orchestrai` binary
`specs/017`/`019` already build and verify. This spec does not touch
`apps/supervisor/index.ts`'s own logic at all.

## Superseded design — found and corrected during implementation

This spec's original draft proposed a single npm package whose postinstall
script downloads the binary from this repository's **GitHub Releases** at
install time ("Pattern B"). That design has a fatal, load-bearing flaw
found live during implementation, not anticipated at drafting: **this
repository is private**, and GitHub returns `404 Not Found` for both the
Releases API and the raw asset-download URL on a fully unauthenticated
request — confirmed directly with plain `curl`, no token involved. No
amount of correct wrapper code changes that; an unauthenticated
`bunx`/`npx` invocation on a machine with no repo access could never reach
the release at all.

**Resolved design**: publish the binaries as npm packages' own tarball
content instead. npm's registry is public and has no dependency on GitHub
repo visibility whatsoever. This is "Pattern A" from the original draft
(per-platform packages + `optionalDependencies`), originally deferred as
unnecessary extra infrastructure — it turned out to be the only design
that actually achieves this spec's purpose while the repo stays private.

The remaining question this raised — whether npm's own tarball size limit
could hold three ~140-165 MB binaries — was answered with real evidence,
not assumption: npm's registry enforces a **fixed 256 MB per-tarball
limit**, confirmed against real reported `413 Payload Too Large` errors
(`package size is too large: 282071924 bytes, max size allowed is
268435456 bytes` = exactly 256 MB) and a direct npm-support quote that it
is not raisable even on a paid plan. A real, local `npm pack` (not a
dry-run — an actual tarball, extracted and executed) of the Windows binary
packed to **71.3 MB**, comfortably under the limit with **185 MB to
spare**. Splitting per-platform still matters, though: all three
binaries bundled into *one* tarball together would total roughly
440–480 MB uncompressed, which would exceed the limit even accounting for
compression — hence three platform packages, not one.

## Verified Current State

- `package.json` at repo root: `"name": "orchestrai"`, `"private": true`.
  Untouched by this spec — the npm packages live entirely under a new
  top-level `npm-package/` directory, outside the Bun workspace's
  `packages/*`/`packages/agents/*`/`apps/*` globs (confirmed by reading
  root `package.json`'s own `workspaces` field), so they cannot be swept
  into the main monorepo's dependency graph.
- `bun run build` (`scripts/build-binary.ts`) is host-platform-only, and
  its own `bunTarget()` already maps `darwin` correctly (line 31) — the
  build script has always supported macOS, nothing had asked it to run on
  one. `.github/workflows/build-binaries.yml`'s matrix, before this spec,
  built only `windows-latest`/`ubuntu-latest`.
- The compiled binary needs neither Bun nor this source tree to run
  (`specs/017`, live-verified) — the property this checkpoint depends on.
- **The GitHub repository is confirmed private**
  (`gh repo view --json visibility` → `"PRIVATE"`), and its Releases API
  and asset-download URLs are confirmed to 404 for unauthenticated
  requests. This fact, not assumption, is why the design above changed.
- A full history audit (58 commits, every diff) found no committed
  secrets: no `.env` file ever committed, no key/cert-named file ever
  committed, no match for any known API-key pattern (including the exact
  shape of the two credentials pasted into chat earlier in this project's
  history), and every long token-like string in the diff history is
  either a `bun.lock` integrity hash, a SHA-256 *content*-verification
  hash used as evidence in a verification doc, or a task/child UUID from
  a live-run capture. Recorded here because it was the direct trigger for
  reconsidering repo visibility, even though this spec's final design no
  longer depends on that decision either way.

## Proposed (and Implemented) Behavior

1. Four new packages under `npm-package/`, each with its own
   **non-private** `package.json`:
   - `orchestrai-win32-x64`, `orchestrai-linux-x64`,
     `orchestrai-darwin-arm64` — one per supported platform, each
     restricted to its own OS/architecture via package.json's `os`/`cpu`
     fields, each containing only that platform's binary under `bin/`.
   - `orchestrai` — the thin meta package a user actually installs.
     `optionalDependencies` on all three platform packages, pinned to the
     exact same version. npm's own install-time platform filtering means
     **exactly one** of the three physically lands in `node_modules` on
     any given machine — no custom download/checksum code needed
     anywhere; npm's registry already computes and verifies each
     tarball's integrity (a real `sha512-...` integrity hash, confirmed
     via an actual local `npm pack`).
2. `orchestrai`'s `bin/orchestrai.js` dispatcher: resolves
   `${process.platform}-${process.arch}` against a fixed map to the
   matching platform package's binary path via `require.resolve()`
   (correct whether installed for real or run from a local
   `node_modules` layout during testing), then `spawnSync`s it with argv,
   stdio, and exit code forwarded unchanged. An unsupported platform, or
   a missing optional dependency (e.g. installed with `--no-optional`),
   produces a clear, specific error message — never a confusing crash.
3. `.github/workflows/build-binaries.yml`:
   - a `macos-latest` matrix leg, producing an **unsigned**
     `orchestrai-macos-arm64` binary (renamed before upload to avoid
     colliding with Linux's identically-named bare `orchestrai` output —
     found and fixed before it could silently overwrite an artifact);
   - the workflow now also triggers on `v*` tag pushes, in addition to
     the existing `main`-push/`workflow_dispatch` triggers;
   - a new `publish-npm` job, gated on the same tag-push trigger as a
     new immutable-release path (see below): copies the three build
     artifacts into their platform packages, sets all four packages'
     `version` (and the meta package's `optionalDependencies` pins) to
     the exact tag, and runs `npm publish --access public` for the three
     platform packages followed by the meta package. Requires an
     `NPM_TOKEN` repository secret this spec does not create — see
     Non-Goals.
   - the existing `release` job gained a second step, also gated on a
     `v*` tag push: publishes an **immutable** GitHub Release under that
     exact tag (never deleted/recreated, unlike the existing rolling
     `latest`) — kept alongside the npm publish as an independent,
     unrelated-to-repo-visibility distribution channel for anyone who
     does have repo access.
4. No checksum-publishing CI step was added — a real finding, not an
   omission. GitHub's Release API already serves a `digest` field
   (`"sha256:<hex>"`) per asset natively (confirmed live via `gh api`),
   and npm's own registry independently computes and verifies each
   package's integrity hash automatically as part of `npm publish`/
   `npm install`. Neither distribution channel needed this repository to
   invent its own checksum step.

## Safety Constraints

- **No custom download/checksum code exists in the shipped dispatcher.**
  The original design's "verify a downloaded binary's checksum before
  executing it" constraint is satisfied structurally instead: npm's own
  install mechanism is the only thing that ever fetches the binary, and
  npm's registry already verifies tarball integrity before it's usable.
  There is no code path in `bin/orchestrai.js` that downloads anything at
  runtime at all.
- **No configurable/attacker-controlled resolution point.** The
  platform-to-package map in `bin/orchestrai.js` is a fixed object
  literal; nothing about which package or binary gets resolved is
  influenced by an environment variable, a flag, or any other
  user-suppliable input.
- The platform packages contain **only** a binary and a `package.json` —
  no scripts, no postinstall hooks, nothing that executes automatically
  at install time in any of the four packages.
- npm publish credentials are **never** stored in this repository in
  plaintext — the `publish-npm` CI job reads `secrets.NPM_TOKEN`, a
  GitHub Actions secret this spec does not create (see Non-Goals).
- The macOS binary is unsigned; this is disclosed plainly in the meta
  package's own README, with the exact `xattr` workaround, rather than
  left for a user to discover as an unexplained Gatekeeper block.

## Open Decision A — resolved: pin per npm version, immutable tags

Unchanged from the original decision: a real `v*` git tag push now
triggers both an immutable GitHub Release and the `publish-npm` job,
alongside (not replacing) the existing rolling `latest` GitHub Release.
Cutting a tag remains a manual, deliberate act (`git tag vX.Y.Z && git
push --tags`) — never automated, matching the Non-Goal against automatic
version bumping.

## Open Decision B — resolved: build macOS, don't sign it

Unchanged from the original decision. The `macos-latest` CI leg is
implemented and ships an unsigned binary; the Gatekeeper workaround is
documented in the npm package's README. Code signing/notarization remains
explicitly out of scope (see Non-Goals) — a separate, recurring-cost
decision.

## Scope

- `npm-package/orchestrai/` (meta package: `package.json`, `README.md`,
  `bin/orchestrai.js`), `npm-package/win32-x64/`, `npm-package/
  linux-x64/`, `npm-package/darwin-arm64/` (each: `package.json` only —
  `bin/` is populated at pack/publish time, never committed).
- `scripts/npm-pack-check.ts` — a local, credential-free verification
  harness: copies whatever's under `dist/bin/` into place and runs `npm
  pack --dry-run` on every package, checked against the real 256 MB
  limit. Not wired into `bun test`/CI; a manual verification tool.
- `.github/workflows/build-binaries.yml` — `macos-latest` matrix leg,
  `v*` tag trigger, immutable-release step, new `publish-npm` job.
- `.gitignore` — `npm-package/*/bin/*` (built binaries are never
  committed, matching the existing "never commit a compiled executable"
  rule already in that file for `dist/`/`/orchestrai`/`/orchestrai.exe`).
- `CLAUDE.md`, `README.md`, `context/worklog.md`.

## Out of Scope / Non-Goals

- **Creating the `NPM_TOKEN` secret or performing a real `npm publish`.**
  This spec builds and locally verifies everything short of the actual
  publish, which needs registry credentials this session does not have
  and should not create unilaterally. The `publish-npm` CI job is real
  and correct but has never executed — see Known Gaps.
- **Cutting the first real version tag.** Deliberately Yusuf's own call,
  not automated or performed by this checkpoint.
- **macOS code signing and notarization.** The binary itself is in scope
  (Open Decision B); making it Gatekeeper-clean is not.
- Publishing the *source* as an importable library/API — this is a CLI
  distribution mechanism only (see `specs/031`'s equivalent Non-Goals
  note).
- Any change to what the binary itself does at runtime.
- Deciding whether the underlying GitHub repository should become public.
  A history audit was performed (see Verified Current State) because it
  was directly relevant to a design option that was ultimately not
  chosen; the visibility decision itself remains entirely Yusuf's.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation, including
      Open Decision B's confirmation.
- [x] The chosen npm package names are confirmed available on the
      registry before any code was written against them (`orchestrai`,
      `orchestrai-win32-x64`, `orchestrai-linux-x64`,
      `orchestrai-darwin-arm64` — all checked live via the public
      registry API, all returned 404/"not found").
- [x] A real, local `npm pack` (not dry-run) of at least one platform
      package succeeds, produces a tarball under npm's 256 MB limit, and
      the binary extracted from that real tarball actually runs and
      produces correct output.
- [x] The dispatcher's platform-resolution and error-handling logic is
      verified against a realistic `node_modules` layout: the happy path
      (binary present, correct platform package) runs the real binary
      with argv forwarded correctly; the missing-dependency path produces
      the documented clear error and exit code 1, not a crash.
- [x] The workflow YAML is valid (parsed with a real YAML parser, not
      eyeballed) and every pinned GitHub Action SHA was verified against
      the real upstream repository, not fabricated.
- [x] The exact version-bump logic the CI job runs was tested locally
      against the real `npm-package/*/package.json` files and produces
      correct output for all four packages, then reverted to the
      `0.0.0` placeholder before committing.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` all pass for
      the main repository, confirming `npm-package/` doesn't interfere
      with the Bun workspace.
- [x] A real `npm publish` of all four packages — done, live on the
      registry, most recently as of 2026-08-21 at `orchestrai@0.1.4`
      (`orchestrai-windows-x64@0.1.4` — renamed from
      `orchestrai-win32-x64` after a live spam-filter rejection, see
      `verification.md` — `orchestrai-linux-x64@0.1.4`,
      `orchestrai-darwin-arm64@0.1.4`), all four consistently cross-pinned
      to `0.1.4`.
- [x] `bunx orchestrai`/`npx orchestrai` from a real machine with no
      local clone — verified for Windows, most recently against
      `orchestrai@latest` (`0.1.4`): a genuinely fresh scratch directory
      resolved the correct platform package and ran the real compiled
      binary.
- [x] **CI's own `publish-npm` job completing a real automated run** —
      done 2026-08-21. `NPM_TOKEN` is now a configured repository secret;
      the `v0.1.4` tag push ran `build` → `release` → `publish-npm`
      entirely through GitHub Actions with every job green, publishing
      all four packages with correctly cross-pinned versions. The prior
      `v0.1.3` attempt is recorded as a genuine, useful negative result,
      not discarded: it failed on exactly the meta package, because that
      version had already been published manually shortly before with
      stale dependency pins — see `verification.md`.
- [ ] **Still not verified**: a real macOS/Linux execution (published,
      but no external machine available to execute either); a
      deliberately corrupted install actually failing closed; a pinned
      version continuing to resolve after a newer one is published. See
      `verification.md`'s Known Gaps.
- [x] `CLAUDE.md`, `README.md`, `context/worklog.md` updated.

## Verification Plan

- Automated: full main-repo suite, typecheck, spec governance — run
  after the new `npm-package/` directory exists, confirming no
  interference.
- Local, credential-free (all performed): registry name-availability
  checks against the real public npm API; a real `npm pack` (not just
  `--dry-run`) with the tarball extracted and the binary executed;
  dispatcher logic tested against a constructed `node_modules` layout
  for both the happy path and the missing-dependency path; the CI
  version-bump logic tested against the real package.json files; the
  workflow YAML parsed and validated; every pinned Action SHA verified
  against the real upstream repo via the GitHub API.
- Deferred, needs real credentials (see Known Gaps in `verification.md`):
  an actual `npm publish`; `bunx`/`npx` end-to-end from a machine with no
  local clone; the macOS and Linux platforms specifically (only Windows
  was locally buildable/testable this session); induced checksum/
  corruption failure against the real published registry; pinned-version
  resolution after a subsequent publish.

## Approval Requested

Approval authorizes: publishing the compiled binaries as four npm
packages (a meta package plus three platform-restricted packages)
instead of downloading them from GitHub Releases at install time; adding
a `macos-latest` CI leg producing an unsigned binary; adding a `v*`
tag-triggered immutable GitHub Release and a `publish-npm` CI job (which
requires an `NPM_TOKEN` secret this spec does not create); and the
history-audit finding recorded above. It does not authorize creating that
secret, performing a real `npm publish`, cutting a version tag, code
signing/notarization, or changing this repository's visibility.
