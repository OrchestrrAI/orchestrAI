---
id: 054-capability-driven-llm-routing
title: Capability-Driven LLM Routing Tier, Validated Against Live Agent Cards
area: routing-planning
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-05
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-06
implemented_on: 2026-09-06
amends:
  - 020-semantic-intent-fallback
supersedes:
  - 053-production-readiness-foundation
superseded_by: []
related:
  - 030-authoritative-skill-dispatch-and-capability-catalog
  - 028-orchestrator-langgraph-supervisor
  - 051-planning-retirement-and-required-key
---

# Spec: Capability-Driven LLM Routing Tier, Validated Against Live Agent Cards

> Review gate: **APPROVED 2026-09-06 by Yusuf.** Split out of
> `specs/053-production-readiness-foundation/spec.md` §1 at Yusuf's
> request, narrowed to routing alone. Item 5 of that draft (provider call
> budgets) is a separate spec (`specs/055-provider-call-budgets-and-
> transient-error-handling`) — this one does not include it.

## Purpose

`detectSkill()`'s resolution order today is keyword matching, then (on a
miss) a local Model2Vec semantic classifier, then a `plan-task` default
(`specs/020-semantic-intent-fallback/spec.md`). Neither step is an LLM
call. Genuinely ambiguous or unusually-phrased requests that miss both
still fall through to `plan-task`, which is now the Orchestrator's own
adaptive supervisor, unconditionally (`specs/051`) — itself an LLM call,
just a more expensive and less targeted one than a request that actually
named a specific single-skill intent.

This spec adds one more tier, below both existing ones, that can
recognize a specific single-skill intent an LLM would catch but a
keyword/nearest-neighbor match cannot — without ever becoming the
authority on what a skill is allowed to do. CLAUDE.md's own "Current
recommended priority" section already names this as the next open item:
*"LLM-based routing as a supplement to, not a replacement for,
deterministic approval enforcement."*

## Verified Current State

Read from the current code, 2026-09-05:

- `detectSkill()` (`apps/orchestrator/index.ts`) is keyword-first, then
  `classifyIntent()` (`packages/shared/intent-classifier.ts`, Model2Vec
  static embeddings — no network call, no inference engine, not an LLM),
  then a hardcoded `"plan-task"` default. Both of the first two stages
  are deterministic/local; neither makes a provider call.
- `buildCapabilitySnapshot()` (`apps/orchestrator/index.ts`) already
  turns the live agent registry into a bounded `CapabilityEntry[]`
  (`{agentName, skillId}` pairs from online agents only, with
  `plan-task`/`suggest-agents` excluded — `packages/shared/
  agent-capabilities.ts`'s `normalizeAgentCapabilities()`). This is the
  exact same snapshot the adaptive supervisor already validates its own
  step choices against (`specs/030-authoritative-skill-dispatch-and-
  capability-catalog/spec.md`) — an LLM router for direct requests would
  reuse this unchanged, not invent a second capability source.
- `findAgentForSkill(skillId)` is the sole authority for "is this a real,
  online, dispatchable skill" today; a router's output would need to
  pass through it exactly like every other skill decision does.
- The approval gate (`packages/shared/approval.ts`, the `actionId` flow)
  is structurally outside all of `detectSkill()`, the semantic
  classifier, and the adaptive supervisor already — none of them can
  supply, observe, or influence an `actionId`. This is the property this
  spec must preserve unchanged, the same way `specs/020`'s own classifier
  already established the precedent that a non-deterministic component
  may *name* a write-capable skill without weakening the gate.

## Proposed Behavior

An LLM router is consulted **only** when both `detectSkill()`'s keyword
stage and the local semantic classifier miss or report a confidence
below both of their own existing thresholds — it is a third, strictly
subordinate tier, never a first-line decision.

The router receives:

- the current, live `buildCapabilitySnapshot()` output — never a
  separately hardcoded ownership list, so it can never propose a skill
  that isn't genuinely online right now;
- the raw request text.

It must return one structured object containing at minimum:

- the proposed capability identifier (a skill id already present in the
  snapshot, or an explicit "unsupported" value — never a free-form
  string the Orchestrator has to interpret);
- a target project path, if one is present in the text;
- confidence and a short human-readable reason;
- whether the request is read-only, state-changing, or unsupported.

Before dispatch, the Orchestrator validates that proposal against
`findAgentForSkill()` and the same skill-tier policy the adaptive
supervisor already uses (`SKILL_TIER_REGISTRY`) — a proposal naming a
skill that isn't currently online, or that the schema can't parse,
produces a clarification/unsupported response, never a best-effort
dispatch. Existing skill identifiers remain the compatibility surface
throughout; this spec adds a new *source* of a skill id, not a new skill
id format.

## Scope

- `apps/orchestrator/index.ts`: a new router-consultation step inside
  `detectSkill()`'s existing fallback chain, strictly after the semantic
  classifier and strictly before the `"plan-task"` default.
- `packages/shared/`: the router's own request/response schema (Zod, matching
  every other LLM-harness output-validation precedent in this codebase).
- No change to `findAgentForSkill()`, `buildCapabilitySnapshot()`,
  `packages/shared/approval.ts`, or the adaptive supervisor's own graph.

## Safety and Compatibility Constraints

- **The approval gate is untouched, structurally, not by convention** —
  identical wording and identical guarantee to every prior LLM
  checkpoint in this codebase (`specs/020`/`026`/`028`/`041`–`043`). A
  router-named write-capable skill needs the exact same human approval a
  keyword-matched one does.
- **Fail-closed on an unparseable or unsupported router response** —
  falls through to the existing `"plan-task"` default, never a guess and
  never a crash. This is a widening of the existing fallback chain, not
  a new failure mode.
- **Never a required credential.** With no provider key configured, this
  tier is simply never reached in a way that matters — `detectSkill()`'s
  behavior for every phrase that already resolves via keyword or the
  local classifier is unchanged, and only a genuine miss on both would
  even attempt to reach a router that (per `specs/051`) already can't run
  without a key anyway.
- No change to `SKILL_TIER_REGISTRY`, `classifyDispatchOutcome()`, or any
  of `specs/028`'s adaptive-supervisor safety properties (rejection is
  terminal, effect-certainty required for adaptation, the two runaway
  bounds).

## Out of Scope / Non-Goals

- Provider call budgets, retry-on-transient-error, or quota surfacing —
  `specs/055-provider-call-budgets-and-transient-error-handling`.
- Project snapshots/fingerprinting for read reuse across requests —
  `specs/057-project-snapshot-and-cross-request-reuse`.
- Any change to how the adaptive supervisor itself decides plan-task
  steps once `plan-task` is reached — untouched.
- Replacing or deprecating the keyword/semantic-classifier tiers — both
  stay first, unchanged, and continue to resolve the overwhelming
  majority of requests with zero LLM involvement.

## Acceptance Criteria

- [x] The router is never consulted when a keyword or classifier match
      already exists — confirmed by a test asserting zero router calls
      for every phrase the existing `detect-skill.test.ts` suite already
      covers.
- [x] A router proposal naming a skill not present in the live
      capability snapshot never dispatches — falls through to the
      existing default.
- [x] A write-capable skill named by the router still reaches the
      identical `actionId`-bound approval flow.
- [x] An unparseable/malformed router response fails closed to the
      existing `"plan-task"` default, not a crash or a guess.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass with no
      API key configured (the router tier is simply unreachable, not
      broken).
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Pure tests for the router's own schema validation and the
  Orchestrator's post-proposal check against `findAgentForSkill()`/the
  tier registry.
- A live pass with a real provider key: a phrase that genuinely misses
  both existing tiers, confirming the router is reached, its proposal
  validated, and dispatch proceeds correctly — plus the adversarial
  case (a proposal naming an offline/unknown skill) confirmed to fail
  closed.
- Full regression suite with no key configured, proving every
  already-tested phrase's routing is unaffected.

## Approval Requested

Not yet requested. This spec needs Yusuf's review and explicit approval
before any implementation, per CLAUDE.md Working procedure step 8.
