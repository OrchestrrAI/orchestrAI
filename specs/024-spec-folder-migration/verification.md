# Verification: Numbered Spec Feature Folders

Evidence for the approved `spec.md`. Final results are recorded only after the
complete migration and reruns finish.

## Environment

- Date: 2026-08-16
- Platform: Windows / PowerShell
- Runtime: Bun 1.3.14

## Acceptance Matrix

| Area | Evidence | Result |
|---|---|---|
| Source/destination safety | Explicit in-bounds 24-entry pre-move validation | Pass |
| Numbered folder population | 24 numbered folders, one `spec.md` each, zero root legacy specs | Pass |
| Metadata and relationships | `bun run specs:check` validates all 24 numbered IDs and relationship graph | Pass |
| Catalog and artifacts | Schema/templates present; catalog exposes scoped companion paths | Pass |
| Active path references | All 24 concrete old filenames absent from active paths | Pass |
| Type checking and tests | Typecheck 0 errors; 147 tests pass, 0 fail, 232 expectations | Pass |
| Diff/name-status review | Diff checks pass; 21 tracked moves are R100 and 3 prior drafts moved intact | Pass |

## Preliminary Evidence

- All 24 mapped source files existed before moving.
- All 24 destination `spec.md` files were absent before moving.
- Resolved source and destination paths remained under the intended `specs/`
  root.
- Tracked specs were moved through Git; current untracked drafts were moved
  without overwriting an existing destination.

## Commands and Results

- Layout audit: 24 numbered directories, exactly one `spec.md` each, zero root
  legacy specs; only features 022–024 contain the approved non-empty companion
  artifacts.
- `bun run specs:catalog`: generated Markdown/JSON output for 24 specs.
- `bun run specs:check`: passed for 24 specs. SHA-256 hashes of both generated
  outputs were unchanged before/after check mode, proving it was read-only.
- Focused governance suite: 9 pass, 0 fail, 21 expectations, including valid
  numbered discovery plus rejected root legacy, malformed, and missing-spec
  layouts.
- Concrete active-path audit: none of the 24 old filenames remains under active
  code/docs/spec/script/demo/CI/hook paths. Historical context/worklog entries
  remain intentionally untouched.
- `bun run typecheck`: 0 errors.
- Full `bun test`: 147 pass, 0 fail, 232 expectations across 15 files.
- `git diff --check` and `git diff --cached --check`: pass.
- Name-status review: the 21 previously tracked specs appear as exact `R100`
  moves. Features 022–024 were already untracked drafts/work from the current
  session and were moved intact; there is no unexplained delete.

## Failures and Retries

1. The first sandboxed `git mv` could not create `.git/index.lock`; the move was
   retried with the required permission after the already-completed in-bounds
   map validation. No source moved during the failed attempt.
2. Initial full-test attempts crashed inside Bun 1.3.14 while starting its HTTP
   client thread. Read-only process inspection found 16 orphaned processes from
   an earlier `bun run dev` tree. Their command lines were verified as this
   OrchestrAI workspace, then those exact PIDs were stopped. The next full run
   completed with all 147 tests passing.
3. The first diff check treated the existing Windows CRLF carriage return as
   trailing whitespace on reference-only edits. The existing CRLF style was
   preserved, and `.gitattributes` now declares `whitespace=cr-at-eol` for
   TypeScript/JavaScript so real trailing spaces still fail without false CRLF
   positives. Both final diff checks pass with small line-only diffs.

## Known Limitations

- Existing dated `context/history.md` and `context/worklog.md` entries preserve
  their old literal paths by design; the current catalog and final worklog map
  are the handoff for resolving those historical references.
- The six older specs already classified `partial` remain partial. This layout
  migration organizes their evidence but does not fabricate missing manual
  verification.
