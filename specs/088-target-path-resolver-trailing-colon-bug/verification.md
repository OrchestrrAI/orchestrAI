# Verification: normalizeAbsolutePath() Trailing Colon Bug

## What changed

`packages/shared/index.ts`: a new shared `TRAILING_PATH_PUNCTUATION`
constant (`/[.,:;]+$/`, adding `:` to the previous `/[.,;]+$/`) is now
used by both `normalizeAbsolutePath()` and `stripPathPhrases()`'s own
separate trim copy, closing the risk of the two silently diverging on
what counts as trailing noise. No other function changed.

## Unit-level

`packages/shared/project-path.test.ts` gained two new tests, both
passing, appended inside the existing `describe("resolveTargetPath",
...)` block:

- A hand-written minimal case: `"edit index.js at C:\real\path: do the
  thing"` → resolves to `C:\real\path` (previously
  `C:\real\path:`, with the stray colon).
- The exact real Coder Agent request text that surfaced this bug live
  (`"edit index.js at C:\...\live-verify-project: change the
  greeting..."`) → resolves to the real path with no trailing colon
  (previously produced a corrupted path that genuinely doesn't exist on
  disk).

`bun test packages/shared/project-path.test.ts`: **20 pass, 0 fail** —
the 18 pre-existing tests (16 original + `specs/087`'s own 2) all pass
completely unmodified, confirming this is a strict widening, not a
behavior change for any input that already worked.

Full suite: `bun test` → **1084 pass, 0 fail** across 73 files (up from
1082, the 2 new tests). `bun run typecheck` → 0 errors.

## Live re-verification

Restarted `coder-agent` (Bun processes don't hot-reload source edits)
carrying the fix, re-dispatched the exact real request that had
previously failed: `"edit index.js at C:\...\live-verify-project:
change the greeting to say hello world"`.

Result: the target file was correctly resolved and read (no more
"Target file ... does not exist" false negative), and the real Gemini-
backed harness produced a genuine, correctly-anchored edit proposal —
```
content: "console.log('hello world')\n"
previousContent: "console.log('hi')\n// change\n"
```
reaching a real `input-required` approval with a real content diff.
This is the decisive live proof: not just that no exception was thrown,
but that the correct real file was found, read, and edited by the real
model. Rejected the approval to close out without writing.

## Acceptance criteria

- [x] The exact real Coder Agent phrasing shape now resolves to the
      real path with no trailing colon (unit-tested and live-confirmed).
- [x] A hand-written minimal version of the same shape resolves
      correctly (unit-tested).
- [x] All 18 pre-existing tests in `project-path.test.ts` pass
      completely unmodified.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of one of the two exact Coder Agent requests that
      surfaced this bug reaches a real read of the target file instead
      of a false "does not exist" error (confirmed — reached a genuine
      approval preview with a real diff).
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Out of scope, confirmed untouched

- `EXPLICIT_PATH_PATTERN_GLOBAL`'s own matching pattern — unmodified.
- `extractSavePath()`/`OUTPUT_PATH_PATTERN` — unmodified.
- The Coder Agent's own task-text parsing
  (`extractTargetFileToken()`/`extractInstruction()`) — unmodified; its
  convention is legitimate, the resolver now handles it correctly.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**`specs/088-target-path-resolver-trailing-colon-bug/spec.md`
(implemented, verified, 2026-09-15)** fixed a second, distinct bug in
the same function found the same day while live-verifying the Coder
Agent's own retry-with-feedback scenarios: `normalizeAbsolutePath()`'s
trailing-punctuation strip (`/[.,;]+$/`) didn't include `:`. The Coder
Agent's own documented convention — `"edit <file> at <path>:
<instruction>"` — puts a colon immediately after the path clause with
no space, so the resolved path kept a stray trailing colon
(`C:\real\path:`), which then genuinely doesn't exist on disk, producing
a misleading "file does not exist" error unrelated to whether the file
was actually present. Fixed by adding `:` to the trimmed character class
(now a single shared `TRAILING_PATH_PUNCTUATION` constant used by both
`normalizeAbsolutePath()` and `stripPathPhrases()`'s own separate copy).
Live re-confirmed: the exact real Coder Agent request that previously
failed now correctly reads the target file and reaches a genuine,
correctly-anchored edit proposal.
