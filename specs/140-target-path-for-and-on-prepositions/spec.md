---
id: 140-target-path-for-and-on-prepositions
title: Target Path Named After "for" or "on" Is Recognized
area: project-targeting
change_type: fix
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 087-target-path-resolver-first-match-bug
supersedes: []
superseded_by: []
related:
  - 088-target-path-resolver-trailing-colon-bug
  - 137-plan-step-acts-only-on-its-own-step
  - 138-model-authored-files-replace-templates
---

# Spec: Target Path Named After "for" or "on" Is Recognized

> Approved and implemented 2026-09-25.

## Purpose

During the specs/138 live run, the request "prepare a release for
`<abs path>`: in parallel, create a Dockerfile and create a GitHub Actions
CI workflow" produced two plan steps that previewed writes into
`ORCHESTRAI_PROJECT_PATH`, not the named folder. The user named a project
and got a preview for a different one. The approval preview showed the real
target, so nothing was written without a human seeing it. Still, it's the
wrong project, and the kind of mistake a reviewer can easily miss.

## Verified Current State

- specs/138's verification.md blamed specs/137. **That was wrong.**
  `buildPlanStepText()` (`packages/shared/plan-step-text.ts`) appends the
  user's full request after `PLAN_CONTEXT_MARKER`. Deterministic readers
  such as the project path see that whole text, so the path does reach the
  agent.
- The real cause: `extractExplicitTargetPath()` (`packages/shared/index.ts`)
  finds a path only after one of four words, through
  `EXPLICIT_PATH_PATTERN_GLOBAL = /(?:^|\s)(?:at|in|to|from)\s+…/gi`.
  "for `<path>`" and "on `<path>`" don't match, so the resolver falls back
  to `ORCHESTRAI_PROJECT_PATH`, silently. A direct, non-plan request worded
  the same way has the same bug.
- Every match is already validated as an absolute path before it's used
  (specs/087), and a trailing `:` is stripped (specs/088).
  `stripPathPhrases()` shares the same pattern.

## Proposed Behavior

1. Add `for` and `on` to the word list in `EXPLICIT_PATH_PATTERN_GLOBAL`:
   `(?:at|in|to|from|for|on)`.
2. Nothing else changes: the scan still goes match by match, keeps only a
   value that validates as an absolute path, and strips trailing
   punctuation. Output destinations (`save to` / `write to`) are still
   removed first, so they can't be mistaken for the target.
3. Correct the "Found, not fixed" note in specs/138's verification.md
   so it names the real cause and points here.

Why this is safe: "for" and "on" are common words ("tests for login", "on
port 4000"). A match counts only when the text after the word validates as
an absolute path, so "for login" or "on port" are skipped exactly as a
non-path "in the repo" is today. The only new behavior is that a real
absolute path after "for"/"on" now wins over `ORCHESTRAI_PROJECT_PATH`,
which is what the user asked for.

`stripPathPhrases()` shares the pattern, so it also removes "for `<abs
path>`" from the text it cleans. That's intended: the path is a target, not
an instruction.

## Scope

- `packages/shared/index.ts` (the pattern and its comment).
- `packages/shared/project-path.test.ts` (new cases).
- specs/138 `verification.md` note; worklog.

## Safety and Compatibility Constraints

- Absolute-path validation stays the gate; a relative path after "for" is
  still ignored, never resolved.
- The first valid match still wins, left to right, so if a request names
  a path with "at" and another with "for", the one written first wins, as
  it does today.
- No change to `extractSavePath()`, the MCP containment checks, or the
  approval gate.

## Out of Scope / Non-Goals

- Recognizing a bare absolute path with no preceding word.
- Asking the user when two different valid paths are named.
- Any model-based path extraction.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] Unit: "prepare a release for `C:\\proj`: …" and "run the tests on
      `/srv/app`" resolve to that path; "write tests for login" and "run
      on port 4000" resolve to null (so the env fallback applies);
      "save to `<abs>`" is still never the target; the existing
      `project-path.test.ts` cases pass unchanged.
- [x] Live: the same release request against a scratch copy previews
      both files inside the named folder, not the fixture.
- [x] `bun run typecheck` 0 errors; `bun test` no regressions.
- [x] specs/138's verification note is corrected; worklog updated.

## Verification Plan

Unit tests above; one live plan request on the isolated stack (ports
5000–5008), then reject both previews and check the fixture hash baseline.

## Verification Record

- Unit: 5 new cases in `project-path.test.ts` (25/25 pass).
- Live (isolated stack): "prepare a release for `<scratch>/fx-bun`: in
  parallel, create a Dockerfile and create a GitHub Actions CI workflow"
  previewed `fx-bun\Dockerfile` and `fx-bun\.github\workflows\ci.yml`,
  where before this fix it previewed the fixture. Both rejected; fixture
  hashes unchanged.
