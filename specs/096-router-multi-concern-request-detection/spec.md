---
id: 096-router-multi-concern-request-detection
title: "Router Recognizes Multi-Concern Requests and Routes Them to plan-task"
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
  - 065-llm-only-skill-routing
related:
  - 054-capability-driven-llm-routing
  - 028-orchestrator-langgraph-supervisor
  - 075-real-conversational-chat
supersedes: []
superseded_by: []
---

# Spec: Router Recognizes Multi-Concern Requests and Routes Them to plan-task

> Review gate: **APPROVED 2026-09-15 by Yusuf.**
>
> Raised directly by Yusuf, 2026-09-15, mid-implementation of
> `specs/095`: *"the prompets seems to be a large task but the router
> assienegd it to spesfec agent with only one task."* A real request —
> *"the test covarage and the security also are ok here?"* — names two
> genuinely distinct concerns (test coverage, security) but was
> dispatched to exactly one skill (`check-coverage`), silently never
> checking security at all.

## Purpose

`packages/shared/capability-router.ts`'s `runCapabilityRouter()` is a
single structured-output completion whose entire job, per its own system
prompt, is *"name which single skill this request most likely wants"*.
That's the correct design for a genuinely single-concern request
(`"run the tests"`, `"scan for secrets"`) — it's cheap, fast, and
skips the adaptive supervisor's real per-step dispatch/approval
machinery entirely when nothing about the request needs it. It silently
breaks down for a request that names two or more concerns each needing
a different skill: the router still returns exactly one `skillId`
(whichever one it judges "most likely"), and the other concern is never
even attempted — not flagged as skipped, not mentioned in the result,
simply absent. The user has no way to tell "only one thing was checked"
from "everything was checked and it's all fine."

This codebase already has the correct mechanism for a multi-concern
request: `plan-task`'s adaptive supervisor
(`specs/028-orchestrator-langgraph-supervisor/spec.md`) decides one
skill at a time from what previous steps actually returned, and
`specs/060-supervisor-parallel-read-only-dispatch/spec.md` even lets it
dispatch several independent read-only steps concurrently in one
decision — exactly the shape `"test coverage AND security"` needs. The
gap isn't a missing capability; it's that the router never recognizes
this shape of request and hands it to that capability. Every existing
multi-step trigger (`"plan"`, `"build"`, `"deploy"`, `"setup"`,
`"production"`) is a project-scale-work keyword list this router
doesn't use at all — it names a skill directly from the live
capability snapshot, with no equivalent signal for "this needs more
than one skill."

## Verified Current State

- `packages/shared/capability-router.ts`'s `buildSystemPrompt()`
  (confirmed by reading it directly) instructs the model to pick
  **exactly one** skill id, or the `"unsupported"` sentinel when "the
  request names real work but no current skill fits it." There is no
  instruction anywhere covering a request that names real work
  spanning **more than one** skill.
- `CapabilityRouterProposalSchema.kind` is a closed enum:
  `"read-only" | "state-changing" | "unsupported" | "state-question" |
  "conversation" | "failure-question"`. None of these mean "this needs
  more than one skill" — the closest, `"unsupported"`, means "no
  current skill fits at all," a different condition.
- `apps/orchestrator/index.ts`'s `detectSkill()` is exactly
  `tryCapabilityRoute(...) ?? "plan-task"` — any proposal whose `kind`
  is not `"read-only"`/`"state-changing"` (via `tryCapabilityRoute()`'s
  own `kind !== "read-only" && kind !== "state-changing"` check, plus
  the `"state-question"` branch above it) already falls through to
  `"plan-task"` with **zero code change needed** — the exact same
  mechanism every prior `kind` addition (`state-question`,
  `conversation`, `failure-question`) has relied on.
- **Live-reproduced, 2026-09-15**: `POST /tasks {"text": "the test
  coverage and the security also are ok here?"}` against the real
  Orchestrator (DevOps/Testing/Security all online) resolved to
  `assignedAgent: "testing-agent"`, `skill: "check-coverage"` — Security
  was never contacted, confirmed via `GET /tasks` showing no task ever
  reached `security-agent`.
- `plan-task`'s adaptive supervisor already handles this shape
  correctly once reached: `specs/060`'s own live-verified evidence
  (`CLAUDE.md`'s "Adaptive supervisor" section) shows a single
  supervisor turn naming three independent read-only steps at once,
  dispatched concurrently.

## Proposed Behavior

Add one instruction to `buildSystemPrompt()`: when a request names two
or more genuinely distinct concerns that would need different skills to
address (e.g. "is there test coverage **and** are there security
issues"), the router responds with `kind: "unsupported"` (the existing
sentinel meaning "no single skill directly answers this," not a new
`kind` value) rather than picking whichever one concern it judges more
likely. This routes the request to the existing `"plan-task"` fallback
— the same path `detectSkill()` already takes for `"unsupported"` today
— with **zero code change** to `detectSkill()`, `tryCapabilityRoute()`,
or the schema itself.

No new `kind` value, no new field, no change to the JSON response
shape. The fix is entirely prompt-level: teach the router to recognize
this one additional case of "no single skill fits" it wasn't previously
told to check for.

A single-concern request that merely uses conjunction words in its own
description (e.g. "check the coverage report **and** tell me the
percentage" — one concern, phrased with "and") must still resolve to
the one correct skill directly — the new instruction must name the
distinguishing signal precisely (distinct **skills** needed, not the
mere presence of "and"/multiple sentences) to avoid a regression where
every request touching more than one topic gets needlessly escalated to
the slower, more expensive `plan-task` path.

## Scope

- `packages/shared/capability-router.ts`: `buildSystemPrompt()`'s own
  instruction list gains one more line; a worked example naming the
  exact live-reproduced scenario above, so the instruction is concrete
  rather than abstract.
- Tests: `capability-router.test.ts` — a multi-concern request (via an
  injected fake model asserting the prompt text contains the new
  instruction, plus a scripted `"unsupported"` response) resolves to
  `null` from `runCapabilityRouter()`'s own caller-visible contract,
  unchanged in shape; a single-concern request phrased with "and" still
  resolves to a real skill id via the existing test fixtures, proving
  no regression.
- **Out of scope**: any change to the adaptive supervisor itself
  (`specs/028`/`specs/060`) — it already handles a multi-step request
  correctly once it's dispatched there; this spec's entire job is
  getting a multi-concern request routed to it in the first place.
  Any change to `classifyAsk()`'s own separate Tier 0/1/2 logic —
  unaffected, since it already reads the router's `kind` the same
  generic way.

## Safety and Compatibility Constraints

- **Strictly additive** — every existing single-skill routing decision
  this router already makes correctly is unaffected; this narrows
  `"unsupported"`'s trigger condition to one more case, it doesn't
  change what happens once that `kind` is returned.
- **No change to the approval gate** — a multi-concern request now
  reaching `plan-task` goes through the exact same, completely
  unmodified adaptive-supervisor dispatch/approval machinery every
  other `plan-task` request already does.
- **A genuine regression risk, named explicitly, not hidden**: an
  over-broad instruction could make the router escalate single-concern
  requests to `plan-task` more often than it should, trading routing
  cheapness for caution. The worked example and precise wording (see
  Proposed Behavior) exist specifically to bound this; the acceptance
  criteria require a regression test proving existing single-skill
  cases are unaffected.

## Out of Scope / Non-Goals

- Making the router itself capable of naming multiple skills in one
  response (e.g. an array of `skillId`s) — a materially larger schema/
  caller change, and `plan-task`'s adaptive supervisor already solves
  this problem properly (deciding each step from what the previous one
  actually returned, not guessing a fixed list upfront). Escalating to
  the existing mechanism is simpler and reuses proven infrastructure.
- Any change to how `plan-task` itself decides or dispatches steps.
- Any change to `SKILL_TIER_REGISTRY` or the approval gate.

## Acceptance Criteria

- [x] The live-reproduced scenario (*"the test coverage and the
      security also are ok here?"*) resolves to `plan-task`, not a
      single direct skill, confirmed via a real dispatch reaching the
      adaptive supervisor.
- [x] The resulting `plan-task` run genuinely checks both concerns (a
      `check-coverage`/`run-tests` step and a Security step both appear
      in the run's own plan steps) — not merely routed to `plan-task`
      in name without doing the second thing either.
- [x] A single-concern request phrased with "and" (e.g. "check the
      coverage and tell me the percentage") still resolves directly to
      one skill, unchanged — a regression test proves this.
- [x] Every pre-existing `capability-router.test.ts` test passes
      unmodified.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.

## Verification Plan

- Unit: the new prompt-content assertion, the multi-concern →
  `"unsupported"` scripted-response test, and the "and"-phrased
  single-concern regression test.
- Live: a real dispatch of the exact live-reproduced scenario against a
  real Gemini deployment, confirming both `plan-task` routing and that
  the resulting plan genuinely dispatches both a testing and a security
  step — the decisive evidence this spec's whole purpose rests on.

## Approval Requested

Not yet requested — presented for review.
