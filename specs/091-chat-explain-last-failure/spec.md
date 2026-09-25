---
id: 091-chat-explain-last-failure
title: "Chat's State-Question Answer Never Surfaces a Specific Task's Real Failure Reason"
area: orchestrator
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-15
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-15
implemented_on: 2026-09-15
amends:
  - 075-real-conversational-chat
  - 044-conversational-ask-layer
related:
  - 054-capability-driven-llm-routing
  - 065-llm-only-skill-routing
supersedes: []
superseded_by: []
---

# Spec: Chat's State-Question Answer Never Surfaces a Specific Task's Real Failure Reason

> Review gate: **APPROVED 2026-09-15 by Yusuf.**
>
> Found live, 2026-09-15, by Yusuf while
> using the real TUI: a `plan-task` run failed with a real, specific error. Two
> direct follow-ups — *"why failed last time?"* and *"check why fail?"* — both
> got the **exact same generic answer** (agent roster + a 5-item recent-task
> list), never the task's own actual error text, even though the real reason
> was right there in the task store the whole time.

## Purpose

`buildStateAnswer()` (`apps/orchestrator/index.ts`) has exactly two informative
branches for a Tier 0 state question: `"state"` (agent roster + recent-task
list) and `"conversation"` (a fixed greeting). Asking *why* something failed
is genuinely a state question — the answer is sitting in the Orchestrator's
own task store, no dispatch needed — but there is no branch that reads a
specific task's own `error`/`result` field. The router correctly classifies
the request as `state-question` (Tier 0, no dispatch — the right call), but
the deterministic answer builder has nothing more specific to say than the
same roster-and-list summary it gives for *every* state question, regardless
of what was actually asked. A user who just watched something fail and asks
about it directly gets an answer that doesn't even acknowledge the failure
happened.

## Verified Current State

- `apps/orchestrator/index.ts:1117-1125`: `buildStateAnswer(intent)` — the
  `"state"` branch unconditionally returns
  `[answerCapabilitiesFromState(), "", answerRecentTasksFromState()].join(...)`,
  regardless of the actual question text. The raw question string is
  available at the call site (`POST /ask`'s own handler, `apps/orchestrator/
  index.ts:1642-1645`) but is never passed into `buildStateAnswer()` today —
  only the coarse `intent` is.
- **Live-reproduced**: a real `plan-task` failed with
  `"A dispatched step failed with an unknown effect on the target
  project — its real state must be checked manually before proceeding
  (reconciliation required)"`. The real failed child step's own error
  (checked directly via the agent's own `/tasks/:id`) was a genuine,
  specific, actionable message — e.g. a malformed command Docker itself
  rejected. Two direct follow-up questions asking why it failed both
  received the generic roster+list answer instead, confirmed by direct
  inspection of the real chat transcript.
- `packages/shared/capability-router.ts:44`: `CapabilityRouterProposalSchema`'s
  `kind` enum is `["read-only", "state-changing", "unsupported",
  "state-question", "conversation"]` — a closed set, the single LLM
  classification call this codebase already makes for every request.
- `apps/orchestrator/index.ts:483-493` (`tryCapabilityRoute()`, used by
  `POST /tasks`'s `detectSkill()`): already treats **any** `kind` other than
  `"read-only"`/`"state-changing"` as non-actionable and falls through to
  `null` (→ `"plan-task"`). A new `kind` value requires **zero code change**
  here — confirmed by reading the exact guard clause, not assumed.

## Proposed Behavior

**Add one more router `kind`, not a new hardcoded keyword-pattern layer.**
This is the deliberate, consistent choice: `specs/075` itself recently
*deleted* two hardcoded Tier-0 pattern lists (`CAPABILITY_PATTERNS`/
`RECENT_TASK_PATTERNS`) in favor of a single real LLM classification,
specifically because pattern lists are brittle. Reintroducing a new
hardcoded "does this look like a why-did-it-fail question" pattern here
would directly contradict that just-made decision. Since the same one
router call already happens for every request regardless, teaching it to
also recognize this one more genuinely distinct intent costs no additional
LLM call.

- `CapabilityRouterProposalSchema.kind` gains `"failure-question"`,
  alongside the existing five. `buildSystemPrompt()` explains it plainly:
  *"If the request is asking why a recent task failed or what went wrong,
  respond with kind `failure-question`."*
- `ask-classifier.ts`'s `StateIntent` type gains `"failure"`; `classifyAsk()`
  maps `kind === "failure-question"` to `{tier: 0, stateIntent: "failure"}`,
  the same shape `"state-question"`/`"conversation"` already use.
- `buildStateAnswer()` gains a `"failure"` branch. **Correction from the
  original draft, found while implementing**: no raw question text needs
  threading through after all — the answer is always "the single most
  recent failure," never disambiguated by anything in the question's own
  wording (matching `answerRecentTasksFromState()`'s own "most recent"
  framing, and this spec's own explicit Non-Goal of not supporting "why
  did step X fail" naming one step among several). A new pure function,
  `answerLastFailureFromState()`, walks `tasks` backward (the same
  direction `answerRecentTasksFromState()` already does) for the most
  recent task whose `status === "failed"`, and returns its real `skill`,
  `assignedAgent`, and `error` (or `result` if `error` is absent but
  status is failed) directly — no paraphrasing, no LLM needed for the raw
  answer (though `synthesizeAnswer()` still phrases it more naturally
  afterward when a key is configured, exactly like every other Tier 0
  answer, since it's grounded in this same real text). No recent failure
  at all → an honest `"No recent task has failed."`, never a guess.
- **`POST /tasks`'s own routing stays byte-identical** — confirmed above,
  `tryCapabilityRoute()`'s existing catch-all already routes this new kind
  the same way `"conversation"`/`"state-question"` already are, no code
  change needed there, only a regression test proving it.

## Scope

- `packages/shared/capability-router.ts`: the `kind` enum, system prompt.
- `apps/orchestrator/ask-classifier.ts`: `StateIntent`, `classifyAsk()`'s
  own mapping.
- `apps/orchestrator/index.ts`: `buildStateAnswer()`'s new `"failure"`
  branch and its new `answerLastFailureFromState()` helper; threading the
  raw question text into `buildStateAnswer()`.
- `apps/orchestrator/keyword-router-fake.ts` (test seam, `specs/065`): no
  change needed — it only reproduces the old keyword-tier decisions for
  dispatch-wiring tests, which this spec doesn't touch.
- **Out of scope**: any change to how a *dispatched* task's own failure is
  reported (the existing inline task-card error display, unchanged); any
  change to `tryCapabilityRoute()`'s own routing logic (confirmed
  unnecessary above); explaining a failure from more than one task back
  (only "the most recent failure," matching `answerRecentTasksFromState()`'s
  own "most recent" framing).

## Safety and Compatibility Constraints

- **Strictly additive** — every existing `state-question`/`conversation`
  classification and answer stays byte-identical; this adds a sixth kind,
  it doesn't touch the other five.
- **No new dispatch, no new write** — this is a Tier 0 answer, same as
  today; it reads already-stored task state, never triggers anything.
- **`POST /tasks`'s own observable behavior is unaffected** — the new kind
  falls through to the existing `"plan-task"` default exactly like
  `"conversation"` already does; a dedicated regression test required, not
  just asserted from reading the code.

## Out of Scope / Non-Goals

- A general "explain any specific task's status" query language (e.g. "why
  did the docker-status step fail" naming one step among several) — this
  spec covers only "the most recent failure," the exact case that was
  asked for live.
- Any change to the deterministic scan-secrets/task-result content itself.
- Any change to `synthesizeAnswer()`'s own grounding check.

## Acceptance Criteria

- [x] `"why did it fail?"` / `"what went wrong?"`-shaped questions classify
      as `stateIntent: "failure"`, not the generic `"state"`.
- [x] The answer names the real most-recently-failed task's skill, agent,
      and actual error text — not the generic roster+list.
- [x] No recent failure exists → `"No recent task has failed."`, not a
      guess or an error.
- [x] `POST /tasks`'s own routing for every phrase is unaffected — a
      dedicated regression test asserting the new kind falls through to
      `"plan-task"` the same way `"conversation"` already does.
- [x] Every pre-existing `"state-question"`/`"conversation"` test passes
      unmodified.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact scenario that surfaced this — a real
      failed plan-task, followed by a real "why did it fail" question —
      gets the actual failure reason back.

See `verification.md` for the full transcript.

## Verification Plan

- Unit: the new `kind`/`StateIntent`/`buildStateAnswer()` branch, the
  `POST /tasks` non-regression case, and `answerLastFailureFromState()`'s
  own no-recent-failure fallback.
- Live, with a real provider key (already available this session): the
  exact real scenario that surfaced this bug, re-run end to end.

## Approval Requested

Not yet requested — presented for review.
