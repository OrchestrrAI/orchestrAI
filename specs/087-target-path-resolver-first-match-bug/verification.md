# Verification: extractExplicitTargetPath() First-Match Bug

## What changed

`packages/shared/index.ts`'s `extractExplicitTargetPath()` now uses the
already-existing `EXPLICIT_PATH_PATTERN_GLOBAL` (via `matchAll()`) instead of
the old non-global `EXPLICIT_PATH_PATTERN` (via `.match()`), scanning every
`at/in/to/from <value>` match in the text and returning the first one that
validates as a real absolute path — instead of taking whatever matched first
and giving up entirely if that one failed validation. The now-unused
`EXPLICIT_PATH_PATTERN` constant was removed. `stripPathPhrases()` — the
sibling function that already had this exact scan-and-validate shape — is
completely untouched; both functions now share one pattern and one comment
explaining why.

## Unit-level

`packages/shared/project-path.test.ts` gained two new tests, both passing,
appended inside the existing `describe("resolveTargetPath", ...)` block:

- A hand-written minimal case: `"in the thing, check the project at
  C:\real\path"` → resolves to `C:\real\path` (previously threw).
- The exact real dispatched-step text that surfaced this bug live (a
  `run-command` step's auto-generated description, `"...in the target
  directory..."`, concatenated with the parent task's own `"...at
  C:\Users\...\live-verify-project"` clause) → resolves to the real path
  (previously threw `TARGET_PATH_REQUIRED_ERROR`).

`bun test packages/shared/project-path.test.ts`: **18 pass, 0 fail** — the
16 pre-existing tests (the spec's own draft said "17"; the actual count in
the file before this change was 16, confirmed by counting `test(` blocks —
correcting that inaccuracy here rather than leaving it uncorrected in the
spec text) all pass completely unmodified, including both false-positive-
prose regression tests (`"if i need fully deploy how to do that..."`), which
correctly still fall through to the configured/error path since those
specific strings contain no real path anywhere — proof this is a strict
widening, not a behavior change for anything that already worked.

Full suite: `bun test` → **1082 pass, 0 fail** across 73 files.
`bun run typecheck` → 0 errors.

## Live re-verification

Re-ran the exact real scenario that originally surfaced this bug, against a
restarted bare-metal stack carrying the fix (`devops-agent` and
`orchestrator` killed and relaunched after the code change — Bun processes
don't hot-reload source edits).

Re-dispatched the identical `POST /tasks` request
(`{"text":"build and deploy the project at C:\...\live-verify-project"}`)
that had previously failed. The resulting plan (`analyze-project` →
`docker-status` → `git-status` → `run-command`) reached the same
`run-command` step that had previously thrown `TARGET_PATH_REQUIRED_ERROR`.
Queried that child task directly at DevOps's own `/tasks/:id`:

```json
{
  "status": "input-required",
  "requiresApproval": true,
  "step": "waiting for human approval — will run: npm install",
  "approval": {
    "target": "command in C:\\Users\\...\\live-verify-project",
    "toolName": "run_command",
    "parameters": {
      "argv": ["npm", "install"],
      "cwd": "C:\\Users\\...\\live-verify-project",
      "project_root": "C:\\Users\\...\\live-verify-project"
    }
  }
}
```

The real target path is correctly populated in `target`, `cwd`, and
`project_root` — the exact text that previously failed to resolve at all
now resolves correctly, and the skill proceeded all the way through
DevOps's own LLM harness (`specs/077`/`086` default-on) to propose a real
command and reach a genuine approval gate. This is the decisive proof: not
just that no exception was thrown, but that the correct real path was used
throughout a real dispatch.

The approval was rejected (via DevOps's own endpoint directly, bypassing
the Orchestrator) to close it out without executing `npm install`. As
`specs/038`'s own verification record already established, rejecting this
way — rather than through the Orchestrator's own `/tasks/:id/reject` —
produces the parent plan's `failed`/`failed-ambiguous` reconciliation-
required terminal state rather than a clean terminal rejection; this is
expected, documented, pre-existing behavior unrelated to this spec, not a
regression it introduced.

## What was not separately re-verified

A second, independent live scenario forcing a *different* `at/in/to/from`
false-match shape (rather than the one real request already reproduced)
was not additionally sought — the real dispatched text used above already
contains a genuine false match (`"in the"`) ahead of the real path, which
is the exact failure mode this spec exists to fix; a synthetic second
example would add no new evidence beyond the unit test already covering
that shape.

## Out of scope, confirmed untouched

- `stripPathPhrases()` — unmodified, still uses the same
  `EXPLICIT_PATH_PATTERN_GLOBAL` it always did.
- `extractSavePath()`/`OUTPUT_PATH_PATTERN` ("save to"/"write to" handling)
  — unmodified.
- The adaptive supervisor's own plan-step text composition — unmodified;
  it's what produced the text that surfaced this bug, but the fix is
  entirely in the resolver, not in how that text is built.

## Acceptance criteria

- [x] The exact real string this session's live pass produced now resolves
      to the real path instead of throwing (unit-tested and live-confirmed).
- [x] A hand-written minimal version of the same shape resolves correctly
      (unit-tested).
- [x] All pre-existing tests in `project-path.test.ts` pass completely
      unmodified (16, not the spec draft's stated 17 — see correction
      above).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact plan-task scenario that surfaced this
      completes the previously-failing step successfully (confirmed via
      the `run-command` child reaching a correct `input-required` approval
      preview with the real path populated).
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**`specs/087-target-path-resolver-first-match-bug/spec.md` (implemented,
verified, 2026-09-15)** fixed a real, previously-unknown bug in step 1's
own extraction: `extractExplicitTargetPath()` used a non-global
`at/in/to/from` regex and took only its *first* match — if that first
match was plain English (e.g. `"in the target directory"`) rather than a
real path, the function gave up entirely and fell through to step 2/3,
even when a genuine absolute path sat later in the exact same string.
Found live during this session's own verification pass: a real adaptive-
supervisor plan step's auto-generated description (`"...in the target
directory to understand its structure. — build and deploy the project at
C:\...\live-verify-project"`) failed with `"No target project
configured"` despite the real path being right there. Fixed by porting
`stripPathPhrases()`'s own already-correct scan-and-validate approach
(`EXPLICIT_PATH_PATTERN_GLOBAL` + `matchAll()`, trying every match and
returning the first that validates as an absolute path) into
`extractExplicitTargetPath()` — both functions now share one pattern.
Strictly additive: every previously-working input resolves identically;
live re-confirmed against the exact real failing scenario, which now
reaches a correct `input-required` approval preview with the real path
populated throughout (`target`/`cwd`/`project_root`).

See specs/075-real-conversational-chat/verification.md for the relocated narrative covering this checkpoint.
