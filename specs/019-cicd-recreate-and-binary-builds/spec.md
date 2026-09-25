---
id: 019-cicd-recreate-and-binary-builds
title: Recreate CI Workflow + Add Cross-Platform Binary Build/Publish
area: ci-cd
change_type: feature
status: implemented
verification: verified
created: 2026-08-09
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-09
implemented_on: 2026-08-09
amends:
  - 014-typecheck-ci
  - 017-standalone-binary-distribution
supersedes: []
superseded_by: []
related:
  - 017-standalone-binary-distribution
  - 014-typecheck-ci
---

# Spec: Recreate CI Workflow + Add Cross-Platform Binary Build/Publish

> Status: **APPROVED ("Approved as written") and IMPLEMENTED on 2026-08-09.
> See Verification Results below.**

## Purpose

Yusuf asked whether a Linux build is possible. Confirmed live via a real
spike (not documentation): `bun build --compile --target=bun-linux-x64`
successfully cross-compiles a genuine Linux ELF executable from this
Windows machine (after `bun install --os=linux --cpu=x64` fetches
OpenTUI's Linux-native optional dependency). Yusuf then asked for this
wired into CI so both Windows and Ubuntu users get a downloadable
artifact. While investigating, `.github/workflows/ci.yml` (built earlier
this session, externally modified once already, per a prior instruction
not to revert that specific modification) was found **entirely absent
from disk** — the whole `.github/workflows/` directory is gone, with no
git history (it was never committed). Yusuf asked to recreate basic CI
*and* add the binary-build workflow.

## Verified Current Behavior

- `.github/workflows/` does not exist (`ls` confirms no such directory);
  `git log --all -- .github/workflows/ci.yml` returns nothing (never
  committed, so its removal — by whatever means — left no trace to
  restore from). This spec recreates it from the known-good, already
  locally-verified command sequence rather than trying to recover
  whatever the externally-modified version specifically contained.
- Real spike performed before writing this: cross-compiling for Linux
  requires the target platform's native optional dependency
  (`@opentui/core-linux-x64`) to be present locally first —
  `bun install --os=linux --cpu=x64` fetches it (confirmed: "6 packages
  installed") without needing an actual Linux machine. The resulting
  binary is a genuine 64-bit Linux ELF (`file` confirms:
  "ELF 64-bit LSB executable, x86-64 ... for GNU/Linux"), ~134 MB (vs.
  106.4 MB for the native Windows build) — **larger, not smaller**, a real
  data point worth stating plainly, not glossed over.
- **Not verified**: actual runtime behavior of the Linux binary — this is
  a Windows machine, there is no way to execute an ELF file here. CI
  building natively on an `ubuntu-latest` runner (rather than
  cross-compiling from a Windows runner) sidesteps this entirely — GitHub
  Actions' own Ubuntu runner can execute and could smoke-test the binary
  it just built, which cross-compiling from Windows CI could not.
- Real, verified SHAs fetched via `gh api` before use (this repo's own
  established practice, avoiding the hallucinated-SHA risk from relying on
  memorized version tags): `actions/checkout@v4.2.2` →
  `11bd71901bbe5b1630ceea73d27597364c9af683`; `oven-sh/setup-bun@v2` →
  `0c5077e51419868618aeaa5fe8019c62421857d6`;
  `actions/upload-artifact@v4.4.3` →
  `b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882`.

## Proposed Behavior

### 1. Recreate `.github/workflows/ci.yml`

Single job, `ubuntu-latest`, running exactly the three commands already
locally verified this session in sequence (`specs/014-typecheck-ci/spec.md`'s
own local dry-run): `bun install --frozen-lockfile`, `bun run typecheck`,
`bun test`. Pinned action SHAs (see above), matching this repo's own
established security-conscious convention from earlier in this session.
Triggers: push to `main`, and pull requests targeting `main`.

### 2. New `.github/workflows/build-binaries.yml`

A **separate new file**, not folded into `ci.yml` — deliberately, so a
future external modification to one doesn't risk the other, and so the
(slower, larger-artifact) binary build doesn't block or slow down the fast
test/typecheck feedback loop on every PR.

- **Matrix**: `windows-latest` and `ubuntu-latest` — each builds **natively
  on its own platform**, not cross-compiled from one runner. This is
  simpler, more standard, and lets the Ubuntu runner actually execute a
  smoke-test of the binary it just built (a real correctness check
  cross-compiling from Windows CI could never provide) — deliberately
  chosen over cross-compilation despite the spike proving cross-compiling
  works, specifically for this smoke-test property.
- Each job: checkout, setup Bun, `bun install --frozen-lockfile`,
  `bun run build`, then a smoke test — start the built binary with
  `--only security-agent` (cheapest single agent, no MCP dependency),
  poll its `/healthz`, confirm HTTP 200, then stop it. (Windows runners in
  GitHub Actions can execute `.exe` directly; this is a real functional
  check, not just "did the build not error.")
- Upload the resulting binary as a workflow artifact
  (`orchestrai-windows-x64` / `orchestrai-linux-x64`), retained per
  GitHub's default artifact retention.
- **Trigger**: push to `main` only (not every PR — these are large,
  ~100-140 MB artifacts; rebuilding them for every draft PR would waste
  CI minutes and storage for no benefit at the hackathon-project stage)
  plus `workflow_dispatch` for on-demand manual runs.

### End result

Anyone can go to the repo's Actions tab after a push to `main`, open the
latest "Build Binaries" run, and download either platform's binary
directly — no local build step needed on the machine that will run it.

## Safety Constraints

- No change to what the compiled binary actually does — CI runs the exact
  same `bun run build` command already verified locally.
- No secrets, credentials, or publish-to-external-registry steps — GitHub
  Actions' own built-in artifact storage only, nothing external.
- Pinned action SHAs, not floating tags, for every action used — supply-
  chain hygiene consistent with this repo's own established convention.
- The Ubuntu build's smoke test only calls `localhost` endpoints already
  used throughout this session's own local verification — no new network
  surface.

## In Scope

1. `.github/workflows/ci.yml` (recreated).
2. `.github/workflows/build-binaries.yml` (new).
3. `README.md`/`CLAUDE.md`: mention both workflows and how to get a
   binary without a local build (download from Actions).

## Out of Scope / Non-Goals

- ~~Publishing to a GitHub Release~~ — revisited same day, see Extension
  below.
- **macOS builds** — not requested, not verified even via spike; would be
  its own follow-up.
- **Code signing / notarization** for either platform's binary.
- **Reducing binary size** — same accepted tradeoff as
  `specs/017-standalone-binary-distribution/spec.md`; the Linux binary being even
  larger than Windows's is noted, not solved, here.
- **Building on every PR** — explicitly `main`-only plus manual dispatch,
  per the reasoning above.

## Acceptance Criteria

- [x] Yusuf approves this spec ("Approved as written").
- [x] `ci.yml` recreated (install → typecheck → test, pinned SHAs).
- [x] `build-binaries.yml` added (matrix, native per-platform builds,
      smoke test, artifact upload, pinned SHAs).
- [x] `bun test` and `bun run typecheck` remain fully green locally.
- [~] The exact smoke-test shell logic used in `build-binaries.yml` was
      run locally against the real Windows binary and confirmed working
      (see Verification Results) — this is the strongest local proxy
      available for "will the CI job's smoke-test step pass," but the
      actual GitHub Actions run (both matrix legs, on GitHub's own
      runners) has not executed yet as of this write-up; needs a real push
      to `main` or a manual `workflow_dispatch` run to fully confirm.

## Verification Results (2026-08-09)

- Cross-compilation spike (informed this spec's "build natively, don't
  cross-compile" decision): `bun install --os=linux --cpu=x64` fetched
  OpenTUI's Linux-native optional dependency on this Windows machine ("6
  packages installed"), after which `bun build --compile
  --target=bun-linux-x64 ...` succeeded, producing a genuine Linux ELF
  binary confirmed via `file`: "ELF 64-bit LSB executable, x86-64 ... for
  GNU/Linux", **134 MB** — larger than the 106.4 MB Windows build. This
  binary could not be executed or otherwise verified on this Windows
  machine — exactly why CI builds natively on `ubuntu-latest` instead,
  where it can actually run and be smoke-tested.
- Real action SHAs fetched via `gh api` before use (not memorized):
  `actions/checkout@v4.2.2` → `11bd71901bbe5b1630ceea73d27597364c9af683`;
  `oven-sh/setup-bun@v2` → `0c5077e51419868618aeaa5fe8019c62421857d6`;
  `actions/upload-artifact@v4.4.3` →
  `b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882`.
- The exact smoke-test shell logic written into `build-binaries.yml` was
  extracted and run locally against the real `dist/bin/orchestrai.exe`
  (fresh port teardown first): started the binary with `--only
  security-agent` in the background, polled `/healthz` in a loop,
  confirmed "Binary is healthy." within the first second, matching exactly
  what the CI step is written to do — the strongest available local proxy
  for the actual GitHub Actions run.
- `bunx tsc --noEmit`: 0 errors. `bun test`: 121 pass, 0 fail (unaffected —
  CI/YAML-only change, no application code touched).
- `git diff --stat bun.lock` shows +136 lines from the `--os=linux
  --cpu=x64` spike install — left in place rather than reverted: harmless,
  standard for cross-platform optional native dependencies (each
  platform's `bun install` only actually installs the packages matching
  its own OS/arch, regardless of how many platform variants the lockfile
  records), and keeps this machine able to repeat the cross-compile spike
  later if wanted.
- **Now verified for real**: pushed to `main` (via `gh auth refresh -h
  github.com -s workflow`, needed since the original push was rejected —
  GitHub blocks pushing `.github/workflows/*` changes without the
  `workflow` OAuth scope, unrelated to anything in this repo's own code).
  Real run (`gh run view 31332017505`): both matrix legs passed —
  `build (ubuntu-latest)` in 14s, `build (windows-latest)` in 32s — and
  both artifacts (`orchestrai-windows-x64`, `orchestrai-linux-x64`)
  appeared, confirming the smoke test passed on both platforms, not just
  that the build didn't error.

## Extension (2026-08-09, same day): publish to a rolling "latest" Release

Yusuf asked why this used workflow artifacts instead of a GitHub Release
after seeing the real run. Correct call to revisit: workflow artifacts
expire (90 days by default) and require GitHub repo access to download —
fine for CI debugging, not for "here's a link, run this." A Release has a
stable, permanent, no-login-required URL, which is what "let someone on
Windows or Ubuntu download and run this" actually needs.

### Design

A new `release` job in `build-binaries.yml`, `needs: build` (waits for
*both* matrix legs, avoiding a race between two parallel jobs trying to
publish the same release):

1. Downloads both platforms' artifacts from the `build` job into one
   directory (`actions/download-artifact` with a glob pattern +
   `merge-multiple: true`).
2. Deletes any existing `latest` release/tag (`gh release delete latest
   --cleanup-tag`, ignoring failure the first time it doesn't exist yet).
3. Recreates it fresh (`gh release create latest <both binaries>`) —
   pointed at the current commit, titled "Latest build," with notes
   explicitly stating it's not a versioned release and always reflects the
   current state of `main`.

Chose **delete-and-recreate** over `gh release upload --clobber` on a
persistent release — simpler, and guarantees the two attached binaries are
always an exactly-matched pair from the same commit, never a stale one
lingering from a previous run if a later run only partially succeeds.

Deliberately **not** marked `--prerelease` — GitHub's own "latest release"
UI/API (`/releases/latest`) specifically excludes prereleases, which would
defeat the actual goal of making this discoverable via the repo's normal
Releases UI, not just a tag-specific URL.

Uses `gh` (GitHub CLI, preinstalled on every GitHub-hosted runner) with the
job's own `GITHUB_TOKEN` rather than a third-party release-publishing
action — one less external action to pin/audit, and `gh` is already this
repo's own established tool for verifying action SHAs.

### Safety

- `permissions: contents: write` scoped to only the `release` job, not the
  whole workflow — least privilege.
- No new secrets — `github.token` is the same ambient, scoped-to-this-repo
  token every job already implicitly has.
- Still the exact same already-verified binaries from the `build` job —
  this only changes where they end up, not what they are.

### Verification

- YAML structure reviewed; `bun test`/`bunx tsc --noEmit` unaffected
  (workflow-only change).
- **Not yet verified**: an actual run of the new `release` job — requires
  another push to `main`. Needs Yusuf's confirmation: the `latest` release
  appears under the repo's Releases tab (not just the Actions run), with
  both binaries attached, and re-running the workflow correctly replaces
  it rather than accumulating duplicate releases.

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/019-cicd-recreate-and-binary-builds/spec.md as written.
```

or list specific changes needed — in particular the trigger (main-only
push vs. every PR) and whether a GitHub Release should be added now
instead of deferred.
