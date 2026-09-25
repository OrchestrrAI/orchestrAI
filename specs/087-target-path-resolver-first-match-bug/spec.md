---
id: 087-target-path-resolver-first-match-bug
title: "extractExplicitTargetPath() Stops at the First at/in/to/from Match, Even When It's Wrong"
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
related:
  - 028-orchestrator-langgraph-supervisor
  - 075-real-conversational-chat
supersedes: []
superseded_by: []
---

# Spec: extractExplicitTargetPath() Stops at the First at/in/to/from Match, Even When It's Wrong

> Review gate: **APPROVED 2026-09-15 by Yusuf.**
>
> Found live, 2026-09-15, during the specs/075/077/086/060 live-
> provider verification pass. A real, adaptive-supervisor-generated
> plan step ("List files in the target directory to understand its
> structure. — build and deploy the project at C:\...\live-verify-
> project") reached DevOps's `run-command` skill and failed with "No
> target project configured" — even though the real, valid absolute
> path was right there in the same string. Reproduced directly and
> traced to the actual root cause before drafting this spec, not
> assumed.

## Purpose

`resolveTargetPath()` (`packages/shared/index.ts`) is the single
function **every skill in every agent** (DevOps, Testing, Documentation,
Security, Code Review, Coder) calls to find the target project's
absolute path in a task's text. Its own `extractExplicitTargetPath()`
helper uses a **non-global** regex and takes whatever it matches
*first* — even when that first match is plain English, not a path —
instead of continuing to look for a real one later in the same string.
When a real absolute path genuinely is present but a `at/in/to/from
<ordinary word>` phrase happens to appear earlier in the text, the
function gives up entirely rather than finding it, and the whole
request fails with `"No target project configured"` even though the
information needed was right there.

## Verified Current State

Read and reproduced directly, 2026-09-15:

- `packages/shared/index.ts:7`: `EXPLICIT_PATH_PATTERN` is
  `/(?:^|\s)(?:at|in|to|from)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i` — no
  `g` flag.
- `packages/shared/index.ts:24-42`: `extractExplicitTargetPath()` calls
  `.match()` (implicitly first-match-only, consistent with the pattern
  having no global flag) and, if that one match's captured value fails
  `normalizeAbsolutePath()`'s validation, returns `null` **without ever
  trying a second match** — there is no loop, no continuation.
- **Reproduced directly**, not theorized: `bun -e` against the real
  function with the exact real dispatched-step text this session's
  live pass produced —
  `"run-command: List files in the target directory to understand its
  structure. — build and deploy the project at C:\Users\...\
  live-verify-project"` — throws `TARGET_PATH_REQUIRED_ERROR`. The
  first `at/in/to/from` match in that string is `"in the"` (captures
  `"the"`), fails path validation, and the function gives up — the
  real, valid `"at C:\Users\...\live-verify-project"` clause sitting
  later in the exact same string is never reached.
- **A sibling function already solved this correctly, for a different
  purpose.** `stripPathPhrases()` (same file, lines 80-93) has its own
  documented history (`specs/020`'s own verification) of hitting and
  fixing precisely this class of bug — its own
  `EXPLICIT_PATH_PATTERN_GLOBAL` (already defined, already exported
  from the same file, currently used only by `stripPathPhrases()`)
  scans **every** match and only acts on the one(s) that actually
  validate as an absolute path (`WINDOWS_ABSOLUTE_PATH.test(...)` or a
  leading `/`) — silent prose like `"in a container"` is correctly
  skipped, a real path anywhere in the string is correctly found. This
  exact mechanism was never ported to `extractExplicitTargetPath()`,
  the function every skill's own path resolution actually depends on.
- **The existing test suite does not cover this case.**
  `packages/shared/project-path.test.ts`'s own regression test for a
  similar-sounding bug (`"a false-positive preposition match on
  ordinary prose falls back to the configured path instead of
  throwing"`, added for a real live-reported defect) uses input text
  (`"if i need fully deploy how to do that in steps my project will be
  in bun"`) that contains **no real absolute path anywhere at all** —
  the correct behavior there (fall back to `ORCHESTRAI_PROJECT_PATH` or
  the actionable error) is exactly what happens today, and stays
  correct after this spec's own fix. The genuinely different case this
  spec addresses — a real path *is* present, but only reachable past an
  earlier false match — has no existing test and was never previously
  found.
- **Every caller confirmed** via `grep -rln
  "extractExplicitTargetPath\|resolveTargetPath" --include="*.ts"`
  excluding tests: `apps/orchestrator/index.ts`, `apps/supervisor/
  index.ts`, and all six agents' own `index.ts` files. This is
  genuinely foundational, shared logic — not a narrow, single-caller
  helper.

## Proposed Behavior

`extractExplicitTargetPath()` is changed to use the already-existing
`EXPLICIT_PATH_PATTERN_GLOBAL` instead of the non-global
`EXPLICIT_PATH_PATTERN`, scanning every match in the text (via
`matchAll()`) and returning the **first one whose captured value
actually validates as an absolute path** — the exact same
scan-and-validate approach `stripPathPhrases()` already uses
successfully, applied here to *finding* a path instead of *stripping*
one. A match that fails validation is skipped, not treated as
disqualifying; the function only returns `null` once **every** match in
the text has been tried and none validated — preserving the existing,
correct, already-tested "genuinely no path anywhere in this text" fall-
through to `ORCHESTRAI_PROJECT_PATH` / the actionable error.

`EXPLICIT_PATH_PATTERN` (the non-global pattern) becomes unused by this
change and is removed, since nothing else in the file references it
once this fix lands — confirmed by `grep` before implementing, not
assumed.

No other function changes. `stripPathPhrases()` is completely
untouched — it already does the right thing and already uses the
global pattern; this spec only brings `extractExplicitTargetPath()`
into agreement with it, not the other way around.

## Scope

- `packages/shared/index.ts`: `extractExplicitTargetPath()`'s own
  matching logic; removal of the now-unused `EXPLICIT_PATH_PATTERN`
  constant.
- Tests: `packages/shared/project-path.test.ts` gains the genuinely new
  case this spec exists for (a real path present after an earlier false
  `at/in/to/from` match, both in a hand-written example and the exact
  real string this session's live pass produced) plus confirmation that
  every one of the file's 17 existing tests still passes completely
  unmodified — proof this is a strict widening of what resolves
  correctly, never a behavior change for any input that already worked.
- **Out of scope / unchanged**: `stripPathPhrases()` itself (already
  correct); the separate `OUTPUT_PATH_PATTERN`/`extractSavePath()`
  machinery for "save to"/"write to" destinations; the adaptive
  supervisor's own step-text composition
  (`` `${step.skill}: ${step.description} — ${parentTask.text}` ``,
  `apps/orchestrator/index.ts`) — unrelated to this bug and not touched
  by this fix, even though it's what produced the real text that
  surfaced it; any change to `ORCHESTRAI_PROJECT_PATH` resolution
  itself.

## Safety and Compatibility Constraints

- **Strictly additive, never a behavior change for text that already
  resolved correctly.** Every existing passing test in
  `project-path.test.ts` must continue to pass completely unmodified —
  the acceptance criteria require this explicitly, not just "the suite
  is green."
- **No change to what counts as a valid path.** The exact same
  `normalizeAbsolutePath()`/`WINDOWS_ABSOLUTE_PATH` validation already
  used by both sibling functions is reused verbatim — this spec changes
  *how many matches are tried*, never *what makes one valid*.
- **Fail-closed unchanged.** A text with genuinely no valid absolute
  path anywhere still falls through to `ORCHESTRAI_PROJECT_PATH`, then
  the same actionable `TARGET_PATH_REQUIRED_ERROR` — never a guess,
  never a different error shape.
- **No new dependency, no new regex primitive** — `EXPLICIT_PATH_
  PATTERN_GLOBAL` and the validation check both already exist in this
  exact file, written and proven for `stripPathPhrases()`; this spec
  reuses them, not invents new ones.

## Out of Scope / Non-Goals

- Any change to how the adaptive supervisor composes a plan step's own
  dispatch text — the text that surfaced this bug is a legitimate,
  reasonable thing for it to produce; the resolver should handle it
  correctly, which is the entire point of this fix.
- Handling a text with **multiple** genuinely-valid absolute paths
  (ambiguous which one is the real target) — not the failure mode found
  here (only one real path was ever present), and not attempted; the
  function continues to return the first valid match found, the same
  "first one wins" precedent already implicit in every existing test.
- Any change to `extractSavePath()`/`OUTPUT_PATH_PATTERN` or the
  document-api "save to" disambiguation logic.

## Acceptance Criteria

- [x] The exact real string this session's live pass produced
      (`"run-command: List files in the target directory to understand
      its structure. — build and deploy the project at C:\...\
      live-verify-project"`) now resolves to the real path instead of
      throwing.
- [x] A hand-written, minimal version of the same shape (`"in the
      thing, check the project at C:\real\path"`) resolves correctly.
- [x] All pre-existing tests in `project-path.test.ts` pass
      completely unmodified — including the two false-positive-prose
      regression tests (lines 67-82), which must still correctly fall
      through to the environment/error path, not be broken into
      finding a spurious match. (Correction: the file had 16
      pre-existing tests, not this draft's stated 17 — an off-by-one in
      the original count, not a real discrepancy; all 16 pass
      unmodified.)
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact plan-task scenario that surfaced this
      (a real adaptive-supervisor multi-step plan including a
      `run-command`/similar step whose own auto-generated description
      contains an earlier `in/at/to/from` phrase) completes the
      previously-failing step successfully.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

See `verification.md` for the full transcript.

## Verification Plan

- Unit: the two new cases above, plus a full, unmodified re-run of
  `project-path.test.ts`'s existing 17 tests.
- Live, with a real provider key (already available this session): the
  exact `"build and deploy"` plan-task scenario that surfaced this bug,
  re-run against the same real scratch project, confirming the
  previously-failing `run-command` (or whichever step the model
  chooses) step now completes instead of triggering the
  supervisor's own `failed-ambiguous`/reconciliation-required
  terminal state.

## Approval Requested

Approve to proceed. A small, surgical, low-risk fix to foundational,
widely-shared logic — reuses an already-existing, already-proven
pattern and validation check from the same file rather than inventing
anything new. Nothing is implemented until approved.
