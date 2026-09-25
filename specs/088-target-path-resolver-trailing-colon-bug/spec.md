---
id: 088-target-path-resolver-trailing-colon-bug
title: "normalizeAbsolutePath() Leaves a Stray Trailing Colon When a Path Is Immediately Followed by ':'"
area: project-targeting
change_type: fix
status: implemented
verification: verified
created: 2026-09-15
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-15
implemented_on: 2026-09-15
amends:
  - 004-configurable-project-paths
  - 007-parsing-and-sse-reliability-fixes
  - 020-semantic-intent-fallback
  - 087-target-path-resolver-first-match-bug
related:
  - 083-coder-agent
supersedes: []
superseded_by: []
---

# Spec: normalizeAbsolutePath() Leaves a Stray Trailing Colon When a Path Is Immediately Followed by ':'

> Review gate: **APPROVED 2026-09-15 by Yusuf.**
>
> Found live, 2026-09-15, while live-verifying `specs/083`'s Coder Agent
> retry-with-feedback scenarios. Two real requests using the Coder
> Agent's own documented task-text convention
> (`"edit <file> at <path>: <instruction>"`) both failed with "Target
> file ... does not exist", even though the target file genuinely
> existed on disk. Reproduced directly against the real function before
> drafting this spec, not assumed.

## Purpose

`normalizeAbsolutePath()` (`packages/shared/index.ts`), used by both
`extractExplicitTargetPath()`/`resolveTargetPath()` (the target-path
resolver every agent's every skill depends on, most recently fixed by
`specs/087` for a different bug in the same area) strips a small set of
trailing punctuation characters off a captured path value before
validating it — `.replace(/[.,;]+$/, "")`. This set does not include
`:`. When a task's own explicit-path clause is immediately followed by
a colon with no intervening space — exactly the shape the Coder Agent's
own documented convention produces (`"edit index.js at C:\real\path:
change the greeting"`) — the captured value keeps that trailing colon
(`C:\real\path:`), which is then returned as the resolved target path.
That path does not exist on disk (no real directory has a trailing
colon in its name), so every downstream file operation fails with a
misleading "does not exist" error that has nothing to do with whether
the file is actually present.

## Verified Current State

Reproduced directly, 2026-09-15, via `bun -e` against the real,
unmodified function:

```
resolveTargetPath("edit index.js at C:\\real\\path: do the thing", { env: {} })
  → "C:\\real\\path:"      // WRONG — trailing colon retained
resolveTargetPath("edit index.js at C:\\real\\path do the thing", { env: {} })
  → "C:\\real\\path"       // correct, once the colon is removed
```

- `packages/shared/index.ts:37`: `normalizeAbsolutePath()`'s trimming
  line is `const candidate = value.trim().replace(/[.,;]+$/, "")` — the
  character class covers `.`, `,`, `;` but not `:`.
- **Live-reproduced against the real running Coder Agent, not just the
  bare function**: two real `POST /tasks` requests through the real
  Orchestrator (`"edit ambiguous.js at <real-path>: change the log
  message..."` and `"edit index.js at <real-path>: change the
  greeting..."`), both against files confirmed present on disk at the
  exact path given, both failed with
  `'Target file "..." does not exist — edit-file requires an existing
  file to edit'` — the literal error `handleEditFileSkill()`
  (`packages/agents/coder/index.ts:217`) produces when
  `read_project_file`'s own real MCP-server-side `existsSync()` check
  (`packages/mcp/index.ts:846`) genuinely finds nothing at the resolved
  path, because the resolved path itself was corrupted by the stray
  colon before ever reaching the MCP server.
- **`stripPathPhrases()` (same file, its own separate trailing-strip
  copy at line 93) is unaffected in practice**, checked directly: its
  `looksLikePath` check only tests the corrupted candidate's *prefix*
  (`WINDOWS_ABSOLUTE_PATH.test(candidate)`, i.e. `/^[A-Za-z]:[\\/]/`),
  which still matches regardless of a trailing colon, and the function
  only ever uses that boolean to decide whether to strip the *original,
  un-corrupted* matched text (`full`) from the sentence — the corrupted
  `candidate` value itself is never returned or used further. So this
  bug is real only where the trimmed value is itself returned and
  relied on as a real filesystem path — `normalizeAbsolutePath()`'s own
  two callers, `extractExplicitTargetPath()`/`resolveTargetPath()` and
  the `ORCHESTRAI_PROJECT_PATH` environment-variable path.
- **Every real caller of the affected resolver confirmed** via `grep`:
  `apps/orchestrator/index.ts`, `apps/supervisor/index.ts`, and all six
  agents' own `index.ts` files (`code-review`, `coder`, `devops`,
  `documentation`, `security`, `testing`) — the same universally-shared
  scope `specs/087` already established for this file.
- **No existing test in `packages/shared/project-path.test.ts` covers
  this shape.** Every existing "explicit path wins" test either has
  nothing following the path at all, or has a space before the next
  word — none end the path clause with an immediately-adjacent colon.

## Proposed Behavior

`normalizeAbsolutePath()`'s trailing-punctuation strip is extended to
also remove one or more trailing `:` characters, alongside the existing
`.`/`,`/`;` — i.e. `.replace(/[.,:;]+$/, "")` (character order within
the class is immaterial; the fix is adding `:` to the set, nothing
else). This is the single, minimal correction: the function already
strips exactly this class of "text that follows a path in ordinary
prose" trailing punctuation; a colon introducing a following clause
(the Coder Agent's own convention, and a natural way to write
`"...at <path>: <do this>"` in English generally) is the same kind of
noise `.`/`,`/`;` already are, just not yet handled.

`stripPathPhrases()`'s own separate, duplicated trim copy
(`.trim().replace(/[.,;]+$/, "")` at line 93) is updated identically
for consistency — even though the investigation above confirms it is
not currently exploitable as a bug (its trimmed value is discarded, not
returned), leaving the two copies to silently diverge on what "trailing
punctuation" means would be a real, if currently dormant, footgun for
a future edit to either function.

No other function changes.

## Scope

- `packages/shared/index.ts`: `normalizeAbsolutePath()`'s trailing-strip
  regex; `stripPathPhrases()`'s own separate copy, for consistency.
- Tests: `packages/shared/project-path.test.ts` gains the two new cases
  above (the exact real Coder Agent phrasing shape, and the minimal
  hand-written repro) plus confirmation every pre-existing test still
  passes completely unmodified.
- **Out of scope / unchanged**: `EXPLICIT_PATH_PATTERN_GLOBAL` itself
  (the matching regex, untouched by this fix — this is purely about
  what gets trimmed off a captured value after it's already matched);
  `extractSavePath()`/`OUTPUT_PATH_PATTERN`; the Coder Agent's own task-
  text parsing (`extractTargetFileToken()`/`extractInstruction()`) — its
  `"edit <file> at <path>: <instruction>"` convention is a legitimate,
  reasonable thing to write; the resolver should handle it correctly,
  which is the entire point of this fix, not something to work around
  by asking the convention to change.

## Safety and Compatibility Constraints

- **Strictly additive, never a behavior change for text that already
  resolved correctly.** Every existing passing test in
  `project-path.test.ts` must continue to pass completely unmodified.
- **No change to what counts as a valid path beyond trimming one more
  trailing character class.** The `WINDOWS_ABSOLUTE_PATH`/leading-`/`
  validation itself is untouched.
- **Fail-closed unchanged.** A text with genuinely no valid absolute
  path anywhere still falls through to `ORCHESTRAI_PROJECT_PATH`, then
  the same actionable `TARGET_PATH_REQUIRED_ERROR`.

## Out of Scope / Non-Goals

- Any change to the Coder Agent's own `"edit <file> at <path>: ..."`
  convention, or any other agent's task-text parsing.
- Handling other trailing-punctuation shapes not yet seen live (e.g. a
  trailing `!`/`?`) — not the failure mode found here, not attempted.
- Any change to `EXPLICIT_PATH_PATTERN_GLOBAL`'s own matching pattern.

## Acceptance Criteria

- [x] The exact real Coder Agent phrasing shape (`"edit index.js at
      C:\...\live-verify-project: change the greeting"`) now resolves
      to the real path with no trailing colon.
- [x] A hand-written minimal version of the same shape resolves
      correctly.
- [x] All pre-existing tests in `project-path.test.ts` (18, after
      `specs/087`'s own two additions) pass completely unmodified.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of one of the two exact Coder Agent requests that
      surfaced this bug reaches a real read of the target file instead
      of a false "does not exist" error.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

See `verification.md` for the full transcript.

## Verification Plan

- Unit: the two new cases above, plus a full, unmodified re-run of
  `project-path.test.ts`'s existing tests.
- Live, with a real provider key (already available this session): one
  of the two exact Coder Agent requests that surfaced this bug, re-run
  against the same real scratch project, confirming the file is now
  found and the request proceeds to the real edit-proposal harness.

## Approval Requested

Approve to proceed. A small, surgical, low-risk fix to the same
foundational, widely-shared function `specs/087` already touched this
session — adds one character to an existing trimming character class,
reuses the exact same fix shape.
