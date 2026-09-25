---
id: 133-supervisor-edit-file-names-its-file
title: Supervisor Names the File in Every edit-file Step, and Plans a Multi-File Change as One edit-files Step
area: routing-planning
change_type: fix
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 121-skill-description-grounded-routing
supersedes: []
superseded_by: []
related:
  - 126-write-tests-description-grounded-routing
  - 114-coder-multi-file-edit-and-create
  - 120-supervisor-parallel-write-dispatch
  - 083-coder-agent
  - 130-tui-dashboard-parity
---

# Spec: Supervisor Names the File in Every edit-file Step, and Plans a Multi-File Change as One edit-files Step

> Status: **APPROVED by Muhamad-Yussuf on 2026-09-25** ("ok go ahead in them all"), together with specs 133–136. **IMPLEMENTED and VERIFIED live** the same day — see `verification.md`.

## Purpose

Found live during spec 130 phase 2 (`specs/130-tui-dashboard-parity/verification.md`):
"Edit two files in C:\Users\moham\test-target-project: add a one-line comment
// config module at the top of src/config.ts, and add a one-line comment
// server entry at the top of src/server.ts" became a plan with two
`edit-file` steps. **Both failed** with Coder's own refusal:

> No file named — expected e.g. "edit src/foo.ts: <what to change>".
> edit-file never guesses which file to edit.

That refusal is correct and stays (`specs/083`). The defect is upstream, in
what the supervisor writes into the step, exactly the class of defect
`specs/126` fixed for `write-tests`. Rephrased as "one multi-file edit", the
same request routed straight to `edit-files` and produced a correct two-file
proposal. This is a demo-visible failure: a natural "change these two files"
request fails outright.

## Verified Current State

- **How the step reaches Coder.** A plan step's child text is
  `` `${step.skill}: ${step.description} — ${parentTask.text}` ``
  (`apps/orchestrator/index.ts:1237`, and the fallback at `:1194`).
- **How Coder finds the file.** `extractTargetFileToken()`
  (`packages/agents/coder/index.ts:169`) matches only
  `/\b(?:edit|modify|change)\s+([^\s]+\.\w+)/i`.
  - In the failing text, `edit-file:` doesn't match: a hyphen follows
    "edit", not whitespace.
  - "Edit two files" doesn't match either: "two" is not a path.
  - The supervisor's description, "Add a one-line comment // config module
    at the top of the file.", names no file at all.
- **What the supervisor is told.** `SKILL_DESCRIPTIONS["edit-file"]`
  (`apps/orchestrator/supervisor-graph.ts:152`) describes what the skill
  does, but, unlike `write-tests` after `specs/126` (`:150`), not that the
  step description must name the file, or how.
  `SKILL_DESCRIPTIONS["edit-files"]` (`:153`) says it handles
  "potentially multi-file" changes but gives no rule for choosing it over
  several `edit-file` steps.
- **Interaction with `specs/120`.** The duplicate-write refusal is keyed on
  `` `${skill}::${target}` `` (`supervisor-graph.ts:514`). `dispatch_skill`'s
  `target` is described as "Absolute path to the target project."
  (`:359`), not a file.
  - So two `edit-file` steps against the same project root share a key,
    and the second is refused ("already dispatched in this run") whether
    they are sequential or in one parallel batch.
  - **Unverified:** in the live failure, both `edit-file` children *were*
    dispatched, so the model must have passed two different `target`
    strings (plausibly file paths). This must be confirmed from the audit
    or decision log during implementation, not assumed.
- **Interaction with `specs/114`.** `edit-files` is bounded to
  `MAX_FILES_PER_EDIT = 6` by its Zod schema. It produces one approval
  whose preview carries `files[]`, and each file's fingerprint is
  re-verified before any file is written.
- **Interaction with `specs/120`'s grouped review.** An `edit-files` branch
  takes part in the disjointness gate through its `files[]` targets
  (`resolvePreviewPaths()`). One `edit-files` step is therefore one branch,
  and one approval covering every file.

## Proposed Behavior

Description wording only, following `specs/126`'s approved precedent: no
deterministic guard, no parser change in Coder.

1. **`edit-file`'s supervisor description** (`SKILL_DESCRIPTIONS` in
   `supervisor-graph.ts`) states:
   - the step is for exactly ONE existing file;
   - the step description MUST begin `edit <relative/path.ext>: <what to
     change>` (e.g. `edit src/config.ts: add a comment line at the top`),
     or the step fails;
   - for a change to two or more files, use ONE `edit-files` step instead
     of several `edit-file` steps.
2. **`edit-files`' supervisor description** states that it is the choice
   whenever a request changes or creates more than one file (up to 6), as
   a single step whose description carries the whole instruction.
3. **The router's view.** The router sees the Agent Card descriptions
   (`specs/121`), not `SKILL_DESCRIPTIONS`. Coder's `edit-file` card
   description gains the same one-file rule, so a direct (non-plan)
   multi-file request is steered to `edit-files` too. The `specs/121`
   bounded-length rule for card descriptions still holds.
4. Coder's refusal text, its parser, the child-text format, the
   duplicate-write key and the dispatch `target` meaning are all
   **unchanged**.

Why this fits `specs/114` and `specs/120`: steering a multi-file change to
one `edit-files` step gives one approval with a per-file diff, and
`edit-files`' all-or-nothing fingerprint preflight re-verifies every file
before any is written. It also never produces two same-`target` `edit-file`
writes for the duplicate-write refusal to block. Two genuinely independent
edits requested together still work, as separate named `edit-file` steps or
as one `edit-files` step, both correct.

## Scope

- `apps/orchestrator/supervisor-graph.ts`: the `edit-file` and `edit-files`
  entries of `SKILL_DESCRIPTIONS`.
- `packages/agents/coder/index.ts`: the `edit-file` (and, if needed for
  contrast, `edit-files`) Agent Card `description` strings only.
- Tests pinning the new wording (the existing `specs/121`/`126`
  description tests are the pattern).
- `CLAUDE.md` (one present-tense sentence), the worklog, and this spec's
  `verification.md`.

## Safety and Compatibility Constraints

- No change to any approval gate, tier classification, fingerprint check,
  the duplicate-write refusal, or `MAX_FILES_PER_EDIT`.
- **Parallel writes (`specs/120`) stay exactly as they are**: the
  concurrent fan-out of several write-capable skills in one supervisor
  turn, the disjointness gate, the grouped review (the dashboard card and
  the TUI's `g`) and `approve-batch`. This spec only changes how a
  multi-file *code edit* is planned: one `edit-files` approval instead of
  several `edit-file` steps. A batch of different skills (e.g.
  `create-gitignore` + `create-ci`) still fans out and still reaches the
  grouped review.
- Coder keeps refusing any `edit-file` text that names no file. The fix
  only makes the supervisor stop writing such text.
- Description strings stay within the `specs/121` length bound. The
  skill-collision test (`agent-card-skill-collision.test.ts`) must still
  pass.
- This is a model judgment, as in `specs/126`: wording steers it and does
  not guarantee it. The live verification below is what shows it works.

## Out of Scope / Non-Goals

- A deterministic orchestrator guard rejecting an unnamed `edit-file` step
  (considered and declined in favor of the `specs/126` precedent).
- Loosening Coder's `extractTargetFileToken()`: the parent text can name
  several files, and a looser match could pick the wrong one.
- Changing what `dispatch_skill`'s `target` means, or the duplicate-write
  key.
- Raising `MAX_FILES_PER_EDIT`.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] `SKILL_DESCRIPTIONS["edit-file"]` requires a description beginning
      `edit <path>: …` and directs multi-file changes to `edit-files`;
      `SKILL_DESCRIPTIONS["edit-files"]` names itself as the multi-file
      choice. Pinned by unit tests.
- [x] Coder's `edit-file` Agent Card description carries the one-file rule,
      within the `specs/121` bound; the skill-collision test passes.
- [x] Live: the exact phase 2 request ("Edit two files in <path>: … at the
      top of src/config.ts, and … at the top of src/server.ts") produces
      either one `edit-files` proposal naming both files, or two `edit-file`
      steps whose descriptions each begin `edit <path>:`. Every step
      reaches an approval preview; none fails with "No file named".
      Repeated at least 3 times.
- [x] Live: a single-file request ("edit src/config.ts: add a comment at the
      top") still routes to `edit-file` and reaches its preview.
- [x] Live regression check for `specs/120`: after the change, "Prepare
      this project for release - create a .gitignore and a GitHub Actions
      CI workflow" still dispatches both writes concurrently, and `g` in the
      TUI opens the grouped review with both branches. Both are rejected
      afterwards.
- [x] The live failure's actual `target` values are recorded in
      `verification.md`, confirming or correcting the duplicate-write
      analysis above.
- [x] `bun run typecheck` 0 errors; `bun test` no regressions.
- [x] Documentation and worklog are updated.

## Verification Plan

- Unit: assert the new substrings in both `SKILL_DESCRIPTIONS` entries and
  the Coder card description, and the description length bound.
- Live: an isolated stack (`--only orchestrator,coder-agent`) against the
  test fixture, with a real provider key. Run the phase 2 request at least 3
  times through `POST /tasks` (and once through the TUI Chat). Record each
  plan's steps, their descriptions and dispatch `target`s from the decision
  audit log, and each child's outcome. Reject every approval. Confirm the
  fixture's hash baseline afterwards.

## Approval Requested

Approval authorizes changing the `edit-file`/`edit-files` supervisor
descriptions and the `edit-file` Agent Card description as described. It
does not authorize a deterministic guard, a Coder parser change, or any
change to the duplicate-write rule or dispatch `target` semantics.
