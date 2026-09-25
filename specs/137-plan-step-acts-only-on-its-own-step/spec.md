---
id: 137-plan-step-acts-only-on-its-own-step
title: Every Plan Step Acts Only on Its Own Step, With the Full Request as Background
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
  - 028-orchestrator-langgraph-supervisor
supersedes: []
superseded_by: []
related:
  - 133-supervisor-edit-file-names-its-file
  - 120-supervisor-parallel-write-dispatch
  - 114-coder-multi-file-edit-and-create
  - 119-coder-verify-loop-and-reviewer-depth
  - 134-devops-harness-sees-the-request
---

# Spec: Every Plan Step Acts Only on Its Own Step, With the Full Request as Background

> Status: **APPROVED by Muhamad-Yussuf on 2026-09-25** ("approved"). **IMPLEMENTED and VERIFIED live** the same day — see `verification.md`.

## Purpose

Found live while verifying `specs/133`
(`specs/133-supervisor-edit-file-names-its-file/verification.md`).
The request was "add a comment at the top of src/config.ts and
src/server.ts, and also create a .gitignore for bun". The supervisor
correctly planned:
- step 1 `[edit-files]` "Add … to src/config.ts and … to src/server.ts";
- step 2 `[create-gitignore]`.

But in **2 of 2 runs**, the `edit-files` proposal also edited
`.gitignore`, which was step 2's job. The two parallel branches then shared
a target, so `specs/120`'s gate correctly refused the grouped review and
each branch fell back to its own approval. That was safe, but a plan step
doing another step's work is wrong, and it spoils the demo's
grouped-review scene for any mixed request.

## Verified Current State

- **Child text format.** Every agent-dispatched plan step gets the text
  `` `${step.skill}: ${step.description} — ${parentTask.text}` ``
  (`apps/orchestrator/index.ts:1252`). The no-agent inspection fallback
  uses the same shape (`:1209`). The full parent request is appended so
  agents can still find context the description omits.
- **What agents take from that text.**
  - The project path: `resolveTargetPath()` (`packages/shared/index.ts`)
    reads an explicit absolute path in the text, else
    `ORCHESTRAI_PROJECT_PATH`. The supervisor's `dispatch_skill` `target`
    is dropped at `index.ts:1391` and never reaches the agent.
  - Stated values: DevOps's `extractPort()`, and since `specs/134` its
    harness sees the whole text.
- **Coder uses the whole text as the instruction.** Its free-form
  instruction extractors strip only the trigger word and path phrases, so
  the entire parent request becomes the instruction:
  - `extractInstruction()` (`packages/agents/coder/index.ts:187`,
    `edit-file`);
  - `extractMultiFileInstruction()` (`:598`, `edit-files`);
  - `extractVerifyInstruction()` (`:698`, `edit-and-verify`).
  `runEditFilesHarness({ …, instruction })` (`llm-harness.ts:631`) has no
  way to tell the step from the background.
- **DevOps also hands the whole text to its models.**
  - `run-command` passes it as the harness `hint` ("Context: …";
    `packages/agents/devops/index.ts:393`, `llm-harness.ts:452`), so a
    `run-command` step could propose a command for another step's job.
  - Since `specs/134`, the dockerize, create-ci, create-gitignore and
    create-compose harnesses receive the whole text as `requestText`
    (`index.ts:435-451`).
- **No other agent sends user text to a model** (audited every
  `run…Harness({…})` call site):
  - Documentation's README and API harnesses get the project, the existing
    README, file content and routes.
  - Testing's `runTestCommandHarness` gets the project only;
    `runWriteTestsHarness` gets the named source file and runner.
  - Code Review gets the diff and codebase analysis.
  - Security has no harness taking text.
  None of these can act on another step's words, so they need no split.
  Each is still listed in the tests below, so that stays true if one is
  later given the request.
- **The separator is ambiguous.** `" — "` (an em dash) can also appear in
  a user's request or a step description, so splitting on it could cut
  the wrong place.
- No test pins the current child-text format (searched).

## Proposed Behavior

Split, don't drop (the approach chosen for this spec):

1. **An unambiguous marker.** The child text becomes
   `` `${step.skill}: ${step.description}${PLAN_CONTEXT_MARKER}${parentTask.text}` ``
   where `PLAN_CONTEXT_MARKER` is a fixed line that cannot occur by
   accident, e.g.
   `"\n\n[orchestrai:plan-context] The user's full request, for background only — act only on the step above:\n"`.
   It is one exported constant in `packages/shared`, used by both
   child-text sites.
2. **A shared split helper.** `splitPlanStepText(text)` in
   `packages/shared` returns `{ step, context }`:
   - `step` is everything before the first marker;
   - `context` is everything after it, or `null` when there is no marker
     (a direct, non-plan task, whose text is therefore unchanged in
     meaning);
   - it is pure and unit-tested.
3. **Coder acts on the step only.**
   - `edit-file`, `edit-files` and `edit-and-verify` derive their
     instruction from `step`.
   - `context`, when present, is passed to the harness as a separate,
     labelled, length-capped (2,000 characters, as in `specs/134`)
     background block with an explicit rule: "background only — change
     nothing the instruction does not ask for".
   - `runEditFilesHarness()` (and `edit-file`'s harness) gain an optional
     `context`; without it, behavior is byte-identical.
4. **DevOps's model-facing text is split the same way.**
   - `run-command`'s `hint` becomes the `step`. `context` is passed as the
     same labelled, capped background block.
   - The four template harnesses (`specs/134`) receive `step` as
     `requestText` and `context` as that background block.
     `STATED_VALUES_RULE` is extended so that a value stated in the
     background that applies to *this* step (for example "port 4000" for a
     dockerize step) still counts. Background can inform this step's
     parameters, but never widen what the step does.
5. **Every agent whose model reads the request follows one rule.** A
   shared `renderPlanBackground(context)` in `packages/shared` renders the
   capped, labelled block ("background only — do only the step; change
   nothing it does not ask for"), so Coder and DevOps word it
   identically. Any harness that later starts taking the request text is
   expected to use `splitPlanStepText()` and this helper; the spec's tests
   make that visible.
6. **Deterministic readers keep the whole text.** `resolveTargetPath()` and
   DevOps's `extractPort()` still read the full text, marker included, so
   an explicit project path or a stated port in the original request still
   reaches every step. Agents whose models never see the request
   (Documentation, Testing, Code Review, Security) need no change.

## Scope

- `packages/shared`: `PLAN_CONTEXT_MARKER`, `splitPlanStepText()`, and
  tests.
- `apps/orchestrator/index.ts`: the two child-text sites (`:1209`,
  `:1252`).
- `packages/agents/coder/index.ts`: the three instruction extractors use
  `step`; the harness calls pass `context`.
- `packages/agents/coder/llm-harness.ts`: the optional `context` in the
  edit-file and edit-files harness prompts.
- `packages/agents/devops/index.ts` and `llm-harness.ts`: `run-command`'s
  hint and the four template harnesses take `step` plus background, and
  `STATED_VALUES_RULE` gains its one-sentence extension.
- `packages/shared`: `renderPlanBackground()`.
- Tests for the above; `CLAUDE.md` (one present-tense sentence); the
  worklog; this spec's `verification.md`.

## Safety and Compatibility Constraints

- **No approval, tier, fingerprint, disjointness or duplicate-write change.**
  `specs/120`'s gate stays the safety net if a step still overreaches.
- **A direct task is unaffected.** With no marker, `context` is null and
  every Coder skill behaves exactly as today.
- **Deterministic.** The split is a fixed-string search, not a model
  judgment. What the harness then writes is still a model proposal behind
  the unchanged human approval.
- **Bounded.** The background block is capped, as in `specs/134`.
- **Path and stated values keep working,** because every other reader still
  sees the full text. The live check below proves it with a plan whose
  request names an explicit path.

## Out of Scope / Non-Goals

- Passing the supervisor's `dispatch_skill` `target` to agents, or any A2A
  task-envelope change (the considered "new envelope field" option; not
  chosen).
- Dropping the parent text from child tasks (the "step-only" option; not
  chosen, because it loses details a description omits).
- Changing Documentation, Testing, Code Review or Security. Their models
  never receive the request text, per the audit above.
- Changing any deterministic parser (path, port).
- Guaranteeing a model never overreaches. This removes the cause (being
  *told* the whole request as the instruction), and approval remains the
  guarantee.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] `splitPlanStepText()` returns the step and context around the marker,
      `context: null` without one, and splits only at the first marker. A
      step or request containing `" — "` splits correctly. Unit-tested.
- [x] Both child-text sites use the marker. The existing orchestrator tests
      pass, and a new test pins the format.
- [x] Coder's three skills build their instruction from `step` only, and the
      harness receives `context` separately, labelled and capped. Without a
      marker, the instruction and the harness input are unchanged.
      Unit-tested.
- [x] Live: the mixed request from `specs/133`'s verification produces an
      `edit-files` proposal whose files are only `src/config.ts` and
      `src/server.ts`, in at least 3 of 3 runs. With disjoint targets, the
      batch is `eligible: true`, and `g` in the TUI opens the grouped review
      with both branches.
- [x] Live: a plan request naming an explicit project path and a port still
      resolves that path, and the port still reaches a DevOps step's
      preview.
- [x] DevOps: `run-command`'s hint and the four template harnesses receive
      `step`, plus background only when there is a marker. Without a
      marker, they are byte-identical to today (including `specs/134`'s
      message). Unit-tested with a recording fake model.
- [x] Live: a plan "dockerize my bun app on port 4000 and create a CI
      workflow" still previews `port: 4000` for the dockerize step, and its
      preview changes only the Dockerfile.
- [x] Every harness call site in the six agents is listed in a test, as
      either split-aware (Coder, DevOps) or never receiving request text
      (the rest), so a future change to that fact is caught.
- [x] Live: a direct `edit-files` request (no plan) behaves as today.
- [x] `bun run typecheck` 0 errors; `bun test` no regressions.
- [x] Documentation and worklog are updated.

## Verification Plan

- Unit:
  - The split helper, including edge cases: no marker, a marker at the
    start, em dashes in both parts, two markers.
  - The child-text format.
  - Coder's extractors, and the harness message content with and without
    `context`, using a recording fake model as in `specs/134`.
- Live:
  - An isolated stack (`--only orchestrator,devops-agent,coder-agent`),
    with a real key, against the test fixture.
  - Run the mixed request 3 times, record each proposal's `files[]` and
    the batch eligibility, and open the grouped review in the TUI.
  - Then the path-and-port plan, and one direct `edit-files` request.
  - Reject every approval and confirm the fixture's hash baseline.

## Approval Requested

Approval authorizes the marker-based child-text format, the shared split
and background helpers, and every agent whose model reads the request
(Coder's three skills; DevOps's run-command and four template harnesses)
acting only on its step with the parent request as capped background. It
does not authorize an envelope change, dropping parent text, or changes to
agents whose models never see the request.
