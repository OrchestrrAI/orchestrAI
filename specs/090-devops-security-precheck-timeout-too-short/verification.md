# Verification: DevOps→Security Pre-check Timeout Fix

## What changed

`packages/agents/devops/index.ts`'s `skillAnalyzeProject()`: the internal
A2A pre-check call to Security's `scan-secrets` now uses `timeoutMs: 45_000`
instead of the original `5_000`.

## A real, live correction made during this spec's own verification

The first implementation attempt used `20_000` (a reasoned estimate, not a
measurement). Live-verifying that attempt against this repository showed it
was itself still undersized — the real call (172 files scanned, 42 real
findings, real AI commentary generated over every one) took **~30 seconds**
end to end. `45_000` was chosen afterward, grounded in that actual
measurement with real margin above it, not the original estimate. This is
recorded here plainly rather than glossed over — the first fix genuinely
didn't fully work, and the second, evidence-grounded one does.

## Unit-level

- `bun test packages/agents/devops/` — 43 pass, 0 fail (no existing test
  asserted the old `5_000` value directly, so none needed updating).
- Full suite: `bun test` — 1084 pass, 0 fail across 73 files.
- `bun run typecheck` — 0 errors.

## Live re-verification

Restarted `devops-agent` with the fix (Bun processes don't hot-reload source
edits), re-dispatched the exact real request that originally surfaced this
bug (`analyze the project at C:\Users\moham\devops-mcp-server`).

Result: the task completed in **33 seconds** — genuinely inside the new 45s
budget — with a real, complete secrets pre-check result (not the "A2A call
timeout" warning): 172 files scanned, 42 findings, full AI commentary. This
directly confirms the fix; the earlier `20_000` attempt was also
live-tested first and confirmed to still fail the same way, which is what
prompted the correction above rather than assuming success.

## A separate, real finding surfaced by this same live pre-check — investigated, closed, not part of this spec

The pre-check's own AI commentary flagged 3 of the 42 findings as
"genuine, not a false positive." All three were checked directly and are,
in fact, false positives:

- `.claude/settings.local.json:16,30` — not API keys; Claude Code's own
  permission-allowlist entries containing numeric task-id strings
  (`task-1786106520677`) that the scanner's pattern matched incorrectly.
  This file is also gitignored (`.gitignore:76`), so even a real secret
  there would never have reached the remote repository.
- `specs/047-.../p047dic-final-state.json:9` — not an API key; a
  `parentTaskId` UUID (`task-cce54ace-...`) pattern-matched incorrectly.
  This file *is* tracked in git, but since it isn't actually a secret,
  there is nothing to rotate.

No real credential exposure exists in this repository. This is a real,
minor accuracy gap in Security's own AI-commentary judgment (recorded here
for visibility, not fixed) — out of scope for this spec, which is about the
DevOps-side timeout only, not the commentary layer's own accuracy.

## Acceptance criteria

- [x] `skillAnalyzeProject()`'s own pre-check timeout is `45_000`, not
      `5_000` (corrected from an initial `20_000` after live measurement
      showed it insufficient).
- [x] Existing DevOps A2A tests pass (none asserted the old value directly,
      so none needed updating).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact scenario that surfaced this completes with
      a genuine secrets pre-check result, not the timeout warning.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Out of scope, confirmed untouched

- `scan-secrets`'s own AI-commentary layer and `withAiCommentary()` —
  unmodified.
- `specs/077`'s own default-on decision — not reconsidered.
- `specs/055`'s own retry/backoff bounds — unmodified.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

See specs/094-analyze-project-security-precheck-opt-in/verification.md for the relocated narrative covering this checkpoint.
