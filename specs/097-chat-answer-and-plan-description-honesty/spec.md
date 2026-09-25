---
id: 097-chat-answer-and-plan-description-honesty
title: "Chat Answer De-Duplication, Plan-Step Description Honesty, and a Configurable Dispatch Limit"
area: orchestrator
change_type: fix
status: implemented
verification: verified
created: 2026-09-15
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-15
implemented_on: 2026-09-15
amends:
  - 044-conversational-ask-layer
  - 091-chat-explain-last-failure
  - 093-conversation-answer-context-blind
  - 030-authoritative-skill-dispatch-and-capability-catalog
  - 080-run-command-approved-execution
  - 028-orchestrator-langgraph-supervisor
related:
  - 040-approval-preview-content-diff
  - 042-llm-harness-devops
  - 073-configurable-service-ports
  - 089-plan-step-skip-continue
supersedes: []
superseded_by: []
---

# Spec: Chat Answer De-Duplication, Plan-Step Description Honesty, and a Configurable Dispatch Limit

> Status: **APPROVED 2026-09-15 by Yusuf.** Two real, distinct bugs Yusuf found
> live in the same session, 2026-09-15, both about text shown to the user
> not honestly representing what's actually happening. Bundled into one
> spec at Yusuf's own explicit request ("write the spec to fix both") —
> genuinely different areas of the codebase, kept together here per
> `CLAUDE.md`'s own guidance to keep newly-discovered in-scope work in one
> draft rather than manufacture a second checkpoint for two same-session
> findings that need no independent approval from each other.
>
> **A third item added the same review round**: while looking at a live
> run that hit `"Run terminated: maximum total dispatches reached"`
> (`DEFAULT_MAX_DISPATCHES = 10`, `specs/028`) after several deliberate
> `specs/089` skips consumed real budget, Yusuf asked to fold in making
> that bound configurable, with a higher default — confirmed via
> AskUserQuestion: **configurable via env var, default raised to 30**.

## Purpose

**Bug 1 — a synthesized chat answer can duplicate itself with zero added
information.** `specs/044`'s own design principle is that a synthesized
(AI-paraphrased) answer is always shown above the real, deterministic
`raw` material it was grounded in — "losing a nicer sentence must never
lose the substance." That's correct when `raw` carries real data (a task
result, a live agent/task list, a real recorded failure). It breaks down
when `raw` is itself just a **fixed, canned "nothing to report" sentence**
— duplicating it below its own AI paraphrase adds no substance, it just
shows the same message twice in a row. Live-caught: typing `"hello"`
produced the AI's own paraphrase of a greeting, immediately followed by
the exact same canned greeting text again.

**Bug 2 — a plan step's own description can actively mislead about what
its approval preview actually proposes.** A `plan-task` step carries a
free-text `description`, written by the adaptive supervisor (one LLM
decision) purely to explain its own reasoning for choosing that skill.
For a skill whose write-time *parameters* are decided by a second,
independent LLM harness at approval-preview time (most visibly
`run-command`, but in principle any DevOps write skill with its own
harness — `specs/042`), nothing keeps that description in sync with what
the harness actually proposes. Live-caught: a step described as *"List
the files in the workspace to understand the repository structure"*
proposed, once its own approval preview was shown, to run `["bun",
"test"]` — the entire test suite, a materially bigger action than the
description implies. The approval preview itself was accurate (the real
argv was shown, nothing hidden), but a human skimming the step's own
description first could reasonably under-estimate what they're about to
approve.

**Bug 3 — the adaptive supervisor's own dispatch bound is a fixed
constant, not configurable, and now provably too low for real use.**
`DEFAULT_MAX_DISPATCHES = 10` (`specs/028`) is a hardcoded literal in
`apps/orchestrator/supervisor-graph.ts`, with no environment-variable
override anywhere in the runtime — `runOrchestratorSupervisor()`, the
one real call site, never passes an override to `runSupervisor()`.
Live-caught the same session: a genuine *"make sure that repo is
production ready"* request, with `specs/089`'s own skip feature
correctly keeping the plan alive through three deliberate skips,
legitimately ran out of budget at exactly 10 real dispatch attempts and
terminated — not a bug in the skip mechanism or the bound-checking
logic itself (both worked exactly as designed), but a real, live
demonstration that 10 is too low a ceiling for a broad, multi-concern
request once a few steps get skipped or a request genuinely needs more
investigation than a narrow one does.

## Verified Current State

### Bug 1

- `apps/orchestrator/index.ts`'s `/ask` Tier-0 handler (the state-question
  branch, ~line 1721-1725) always does:
  ```ts
  const raw = buildStateAnswer(classification.stateIntent, priorTurns)
  const synthesized = await synthesizeAnswer(question.trim(), raw, priorTurns)
  const answer = synthesized ? `${synthesized}\n\n${raw}` : raw
  ```
  with **no check on whether `raw` carries real, non-canned content**.
- `buildStateAnswer()` (via `buildConversationAnswer()` and
  `answerLastFailureFromState()`) can return one of **three fixed,
  content-free constants**, confirmed by reading each directly:
  - `CONVERSATION_GREETING` = `"Hi — I'm OrchestrAI's orchestrator. Ask
    what I can do, or tell me what you'd like done."` — returned by
    `buildConversationAnswer()` when `priorTurns.length === 0`.
  - `"Got it — what would you like me to do next?"` — returned by
    `buildConversationAnswer()` when there *are* prior turns but no
    recent task has failed.
  - `"No recent task has failed."` — returned by
    `answerLastFailureFromState()` (the `"failure"` intent) when no
    task has actually failed.
  - (A fourth, `buildStateAnswer()`'s own default-case fallback —
    `"I couldn't tell what you meant..."` — appears structurally
    unreachable given the current `AnswerTier`/`stateIntent` type, but
    shares the same shape and is included in the fix for completeness,
    not assumed dead without a test proving it.)
- The `"state"` intent's own branch (`answerCapabilitiesFromState()` +
  `answerRecentTasksFromState()`) is **not** affected — it always
  reflects live, real state (the actual current agent/task lists, even
  when those lists happen to be empty, which is itself real information,
  not a canned filler).
- The second synthesis call site (~line 1305-1309, for a dispatched
  task's terminal result) is **not** affected either — `raw` there comes
  from `answerTextForTerminalTask()`, always either a real task result or
  a real recorded error, never one of the canned constants above.

### Bug 2

- `apps/orchestrator/index.ts`'s plan-step dispatch
  (`dispatchPlanStep()`) sends the child agent a task text of
  `"<skill>: <step.description> — <original request text>"` —
  `step.description` is authored once, by the adaptive supervisor, at
  the moment it decides to dispatch this step, before the receiving
  agent has done anything.
- `packages/agents/devops/index.ts`'s `prepareRunCommandAction()`
  (`specs/080`), when no explicit command is present in the task text
  and the harness is on, calls `runRunCommandHarness({..., hint: text})`
  — a **second, independent** LLM decision that genuinely explores the
  real project (`read_project_file`/`analyze_project`/`git_status`) and
  proposes the real `argv` based on what it finds, using the *full* task
  text (including the original user request) as context — not
  constrained to agree with the step's own free-text description in any
  way.
- **Live-reproduced, 2026-09-15**: a plan step described as *"List the
  files in the workspace to understand the repository structure"*
  reached a real approval preview proposing `argv: ["bun", "test"]` —
  confirmed by inspecting the real task JSON. The skill itself
  (`run-command`) was correctly, authoritatively dispatched
  (`specs/030`'s guarantee is intact — no re-derivation of skill
  identity occurred); only the *description text shown above the
  approval preview* was materially misleading about the actual action.
- The same disconnect is structurally possible for any DevOps write
  skill with its own opt-in-by-default harness (`dockerize`,
  `create-ci`, `create-gitignore`, `create-compose` — `specs/042`,
  `specs/077`) — the harness decides real parameters (`app_type`,
  `port`, `include_docker`, `services`) independently of the step's own
  description, though `run-command` is the clearest case since its
  entire action (not just a parameter) is harness-decided.
- The approval preview itself (`ApprovalPreview.summary`/`argv`/
  `content`, `specs/040`) is **always** the accurate, reviewable source
  of truth — this is not a safety gap, only a legibility one: nothing
  currently tells a human that the description above the preview may
  not match it.

### Bug 3

- `apps/orchestrator/supervisor-graph.ts`: `export const
  DEFAULT_MAX_DISPATCHES = 10`, a plain literal, read only by
  `buildSupervisorGraph()`'s own default parameter
  (`options.maxDispatches ?? DEFAULT_MAX_DISPATCHES`).
- `apps/orchestrator/index.ts`'s `runOrchestratorSupervisor()` — the
  **only** real call site of `runSupervisor()` — calls it as
  `runSupervisor(task.text, { model, deps })`, never supplying
  `maxDispatches`. Confirmed directly, not assumed: there is no
  environment-variable read anywhere in either file for this value.
- `packages/shared/service-ports.ts` (`specs/073`) is the established
  precedent for this exact shape of config: one env var per setting, an
  explicit default table, parsing that silently falls back to the
  default on anything unset or non-numeric — never throws, never blocks
  startup.
- **Live-reproduced, 2026-09-15**: a real `plan-task` run
  (*"can you make sure that repo is production ready?"*), after three
  real `specs/089` skips, reached exactly 10 real dispatch attempts and
  terminated with `"Run terminated: maximum total dispatches reached"`
  — confirmed via the real task JSON's own `planSteps`/`error` fields.

## Proposed Behavior

### Fix 1 — skip synthesis (and the duplicate) for content-free raw answers

A new, small, explicit set of "canned, no-data" raw strings
(`CANNED_NO_DATA_ANSWERS`, containing the four constants named above,
by exact string match — deliberately a closed, explicit set, not a
heuristic) is checked before calling `synthesizeAnswer()` in the Tier-0
`/ask` handler: when `raw` is a member, the answer is `raw` itself,
**no synthesis call is made at all** (not just "made but discarded") —
saving a real provider call for a case where its only possible outcome
is a near-duplicate paraphrase. When `raw` is not a member (the `"state"`
intent's own real-data branches), behavior is **completely unchanged**
— synthesis still runs, and the raw block still gets appended below it,
exactly as `specs/044` designed.

### Fix 2 — an explicit reminder wherever a plan step's own approval preview is shown

Rather than attempting to detect whether a specific description
"matches" a specific proposed action (a brittle, semantic-similarity
problem with no reliable general solution), every surface that renders
a plan step's own `description` directly above its `approval` block
gains one short, fixed, always-present line making the relationship
explicit: the description reflects the supervisor's own *planning-time*
reasoning for choosing this skill, and is not a promise of the exact
action — the approval preview below it is what to actually review. This
is a single, reusable, honestly-worded addition, not per-skill logic,
so it needs no maintenance as new harnesses are added and applies
uniformly whether or not a given step's description happens to already
match its own preview closely.

### Fix 3 — a configurable dispatch limit, default raised to 30

A new `ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES` environment variable,
resolved by a new, small, pure function
(`resolveSupervisorMaxDispatches(env)`, mirroring
`resolveServicePort()`'s own established shape exactly — unset or a
non-positive-integer value silently falls back to the default, never
throws): the parsed value is passed as `maxDispatches` into
`runSupervisor()`'s options from `runOrchestratorSupervisor()`, the one
real call site. `DEFAULT_MAX_DISPATCHES` itself is raised from `10` to
`30`, per Yusuf's own explicit choice, confirmed via AskUserQuestion.
`DEFAULT_MAX_ATTEMPTS_PER_SKILL` and `DEFAULT_RECURSION_LIMIT` are
**untouched** — this spec's own scope is the dispatch bound alone, the
one Bug 3's live reproduction actually hit; the recursion limit already
sits generously above even the new default (`50` vs. `30`, unchanged
from `specs/028`'s own original reasoning: "generous relative to
`DEFAULT_MAX_DISPATCHES`, the dispatch-count bound is the real limit"),
and the per-skill attempt bound is a distinct, unrelated safety property
(retry budget per skill, not total plan length).

## Scope

- `apps/orchestrator/index.ts`: `CANNED_NO_DATA_ANSWERS` (or equivalent);
  the Tier-0 `/ask` handler's own synthesis-call guard.
- `apps/tui/index.tsx`: the Detail overlay's plan-step approval
  rendering gains the fixed reminder line, shown only when the detail
  task has both a `description`-bearing parent step context and an
  `approval` block (i.e., exactly the case this spec is about — never
  shown for a task with no approval, unchanged).
- `apps/orchestrator/index.ts`'s dashboard script: the same reminder,
  wherever a plan-child's approval card renders alongside its own step
  description (the Tasks table row's own text cell already shows the
  step description; the inline chat-linked card's own
  `renderApprovalBlock()`/note text).
- `apps/orchestrator/supervisor-graph.ts`: new
  `resolveSupervisorMaxDispatches(env)`; `DEFAULT_MAX_DISPATCHES` raised
  `10` → `30`.
- `apps/orchestrator/index.ts`'s `runOrchestratorSupervisor()`: passes
  the resolved value into `runSupervisor()`'s options.
- Tests: `ask-endpoint.test.ts` (or the appropriate existing suite) —
  each of the four canned strings produces a byte-identical
  `raw`-only answer with **zero** `synthesizeAnswer()`/model-invocation
  calls (a spy/counter, not just an output-equality check); the
  `"state"` intent's own real-data branches remain unchanged (existing
  tests continue to pass unmodified). A focused test/inspection
  confirming the new reminder line renders in the TUI's Detail overlay
  and the dashboard's approval card only when a real `approval` block is
  present alongside a step description. `supervisor-graph.test.ts` gains
  coverage for `resolveSupervisorMaxDispatches()` (unset → 30, a real
  override value respected, a non-numeric/non-positive value falling
  back to 30 rather than throwing) mirroring `resolveServicePort()`'s
  own existing test shape.

## Safety and Compatibility Constraints

- **Strictly additive for Fix 1** — the `"state"` intent (real
  capabilities/task data) and the second synthesis call site (real task
  results) are completely untouched; only the three-plus-one canned,
  content-free strings change behavior, and only by removing a
  redundant duplicate, never by removing real information.
- **No change to the approval gate for Fix 2** — this is a rendering-only
  addition; `ApprovalPreview`'s own fields, the `actionId` binding, and
  every approve/reject/skip mechanic are untouched. The reminder text
  never claims a mismatch exists (which would require the brittle
  detection this spec deliberately avoids) — it states the general,
  always-true relationship between planning-time description and
  approval-time preview.
- **No new provider call for Fix 2**, and **fewer** provider calls for
  Fix 1 (skipping synthesis for the canned cases) — a strict cost
  reduction, not an addition.
- **Fix 3 raises a ceiling, never removes one** — `resolveSupervisorMaxDispatches()`
  always falls back to a real, positive default (30, never unbounded);
  a misconfigured/malformed env var degrades to that default rather than
  disabling the bound entirely, the same fail-safe shape
  `resolveServicePort()` already established. Every other safety
  property `specs/028` built (rejection-is-terminal, the per-skill
  attempt bound, the recursion-limit backstop, the read-only-only
  parallel fan-out gate) is completely untouched — this spec changes
  only how many total dispatches are allowed before the run must stop,
  never what's allowed to happen within that budget.

## Out of Scope / Non-Goals

- Any attempt to detect or flag a *specific* description/preview
  mismatch (e.g., comparing description text against the real argv) —
  a semantic-similarity problem with no reliable general solution;
  the fixed reminder line is the deliberately chosen, simpler
  alternative.
- Rewriting or regenerating a plan step's own `description` once its
  real approval preview is known — a materially larger change (would
  need the supervisor or the dispatching agent to communicate back to
  the Orchestrator's own plan-step record) not attempted here.
- Any change to `DEFAULT_MAX_ATTEMPTS_PER_SKILL` or
  `DEFAULT_RECURSION_LIMIT` — Fix 3's own scope is the total-dispatch
  bound alone, the one Bug 3's live reproduction actually hit.
- Exposing `ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES` in the guided-init
  forms (TUI/browser/classic wizard) — a real, plausible follow-up, but
  a separate, later decision; this spec only makes the runtime honor the
  variable when hand-set, matching how several other `ORCHESTRAI_*`
  variables in this codebase (e.g. the per-component `_LLM_MODEL`
  overrides before `specs/095`) existed and worked correctly before any
  guided-init surface exposed them.
- Any change to `specs/089`'s own skip mechanism, `specs/040`'s
  approval-preview content rendering, or `specs/042`'s DevOps harnesses
  themselves.

## Acceptance Criteria

- [x] Each of the four canned strings, asked for directly (a fresh
      `"hello"`, a mid-conversation follow-up with no recent failure, a
      failure-question with no recent failure, and — if reachable — the
      default fallback) produces the raw string alone as the answer,
      with **zero** synthesis/model calls made (confirmed via a spy, not
      just output equality).
- [x] A `"state"` intent question (real agent/task data) is
      byte-identical to before this spec — synthesis still runs, the raw
      block still appends below it.
- [x] A dispatched-task terminal answer (the second call site) is
      byte-identical to before this spec.
- [x] The TUI's Detail overlay shows the new reminder line exactly when
      viewing a plan step's own approval (description + approval both
      present), never otherwise.
- [x] The dashboard's plan-step approval cards show the same reminder,
      same scoping.
- [x] With `ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES` unset, a real
      `plan-task` run's own budget is 30, not 10 — confirmed by the
      bound-check firing only after 30 real dispatch attempts, not 10.
- [x] With `ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES` set to a specific
      value, that value is honored exactly.
- [x] With `ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES` set to something
      malformed (non-numeric, zero, negative), the run falls back to 30
      rather than crashing or disabling the bound.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] Every pre-existing test in the affected files passes unmodified.

## Verification Plan

- Unit: every acceptance criterion above.
- Live: re-ask `"hello"` against a real Gemini deployment and confirm
  the duplicate is gone; re-dispatch a real `run-command` (or any
  DevOps-harness-backed) plan step and confirm the reminder line
  appears in both the TUI Detail overlay and the dashboard alongside
  the real approval preview; re-run a real broad, multi-concern request
  with the raised default and confirm it can now genuinely exceed 10
  real dispatches without hitting the old ceiling.

## Approval Requested

Not yet requested — presented for review.
