## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

  `specs/019-cicd-recreate-and-binary-builds/spec.md` recreated
  `.github/workflows/ci.yml` (found missing from disk entirely, with no
  git history to recover from — recreated from the already-locally-
  verified command sequence rather than guessing at what was lost) and
  added `.github/workflows/build-binaries.yml`, which builds and
  smoke-tests the standalone binary natively on both a Windows and a Linux
  GitHub Actions runner (not cross-compiled from one, so the Linux leg can
  actually execute and verify its own output) and publishes both to a
  rolling `latest` GitHub Release (recreated fresh on every push, via `gh
  release delete`+`create`, not a third-party action) — a stable,
  permanent, no-login-required URL, chosen over workflow-run artifacts
  (which expire and require repo access) once Yusuf asked why artifacts
  rather than a release. A local cross-compilation spike (Windows → Linux,
  via `bun install --os=linux --cpu=x64` then `bun build --compile
  --target=bun-linux-x64`) confirmed cross-compiling is *possible* — the
  output was a genuine Linux ELF binary — but at 134 MB (vs. 106.4 MB
  native Windows) and with no way to execute-verify it on a Windows
  machine, which is exactly why CI builds natively per-platform instead.
  Both workflows have now run for real on GitHub Actions (not just
  locally simulated): both matrix legs passed (`gh run view` confirms
  `build (ubuntu-latest)` and `build (windows-latest)` both green, both
  artifacts present). The new `release` job itself has not yet had a
  confirmed real run as of this writing — needs Yusuf to push once more
  and confirm the `latest` release appears under the repo's Releases tab
  with both binaries attached. **Correction, found during
  `specs/032`:** the "no-login-required URL" framing above was true only
  for anyone with repository access — this repository is confirmed
  **private**, and both the Releases API and the raw asset-download URLs
  return HTTP 404 for a fully unauthenticated request (verified live with
  plain `curl`). The release remains genuinely useful for collaborators;
  it is not a public distribution channel as long as the repo stays
  private.

See specs/020-semantic-intent-fallback/verification.md for the relocated narrative covering this checkpoint.

See specs/016-orchestrai-supervisor/verification.md for the relocated narrative covering this checkpoint.
