---
id: 093-conversation-answer-context-blind
title: "The 'conversation' Tier 0 Answer Is a Fixed String, Blind to What Was Actually Said"
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
  - 092-router-classification-conversation-context
related: []
supersedes: []
superseded_by: []
---

# Spec: The 'conversation' Tier 0 Answer Is a Fixed String, Blind to What Was Actually Said

> Review gate: **APPROVED 2026-09-15 by Yusuf.**
>
> Found live, 2026-09-15, immediately
> after live-verifying `specs/092`'s own fix. `specs/092` correctly taught
> the router's *classification* to use conversation history — confirmed
> live: a real Gemini call, given the real preceding error ("Is the
> computer able to access the url?"), still classified a real follow-up
> ("yes it can") as `kind: "conversation"`, a genuinely defensible
> judgment (it isn't a work request, a state question, or a failure
> question). But the *answer* that classification produces is
> `buildStateAnswer()`'s hardcoded `"Hi — I'm OrchestrAI's orchestrator..."`
> string — unconditionally, regardless of what was actually said. Yusuf's
> own words on seeing this: *"it should be reply! i remember once before
> there was like a chat not just like that what happened."*

## Purpose

`specs/092` fixed classification blindness. This spec closes the deeper,
remaining half of the same real complaint: even a **correctly classified**
`"conversation"` turn produces an answer with zero connection to the actual
conversation. `synthesizeAnswer()` is technically invoked afterward (every
Tier 0 answer goes through it when a key is configured), but it can only
*phrase* the raw material it's given — and for `"conversation"`, that raw
material is always the identical fixed greeting, containing no information
about what was actually said. There is nothing for synthesis to work with,
so even a real, capable model produces something indistinguishable from
the raw string.

## Verified Current State

- `apps/orchestrator/index.ts`'s `buildStateAnswer()`: the `"conversation"`
  branch is `return "Hi — I'm OrchestrAI's orchestrator. Ask what I can do,
  or tell me what you'd like done."` — an unconditional literal, no
  parameters, no access to the question text or prior turns.
- `synthesizeAnswer(question, raw, priorTurns)` is called with this fixed
  string as `raw` for every `"conversation"` turn. `packages/agents/
  answer-harness.ts`'s own system prompt instructs it to "Answer the
  question directly and briefly... using only that material" and "Never
  invent... anything not supported by it" — correct, necessary grounding
  discipline for a factual answer, but it means synthesis has structurally
  nothing substantive to draw on for a `"conversation"` turn, since `raw`
  carries no real content.
- **Live-reproduced, 2026-09-15**: the exact real scenario — a real MCP
  connection failure whose error text literally asked *"Is the computer
  able to access the url?"*, followed by a real reply *"yes it can"* —
  produced the identical canned greeting, confirmed via direct
  inspection of the real `/ask` response (`reason: "state:conversation"`,
  `answer` byte-identical to the fixed string).

## Proposed Behavior

**`priorTurns` becomes real source material for a `"conversation"` reply,
not just phrasing polish.** Two coordinated changes:

1. `buildStateAnswer()`'s `"conversation"` branch is given the question
   text and recent prior turns (both already available at its call site —
   `priorTurnsFor(conversation)` is already computed there for
   `synthesizeAnswer()`'s own sake). When no prior turns exist (a genuine
   first-message greeting), the raw answer stays exactly today's fixed
   string — the common first-contact case is unaffected. When prior turns
   exist, the raw answer becomes something that names what's actually
   happening rather than a generic hello — e.g. surfacing the most recent
   real event (an error, a completed task) alongside an invitation to
   continue, deterministically assembled from real state (reusing
   `answerLastFailureFromState()`/task data already available), never
   invented.
2. `synthesizeAnswer()`'s own grounding constraint is **not loosened for
   factual claims** — it must still never assert a number or fact absent
   from its source material, unchanged from `specs/044`'s own design. What
   changes is only that `"conversation"` now has real material (from
   change 1) to draw a genuine acknowledgment from, rather than nothing.

**Decided during implementation**: a new `buildConversationAnswer()` reuses
the exact same `tasks` walk `answerLastFailureFromState()` already uses
(not that function directly, since its own wording — "Most recent
failure — ..." — is written for a direct "why did it fail" question, not
a conversational acknowledgment) — when a real recent failure exists, name
it and offer to retry; otherwise, a shorter, still-context-aware
invitation. Nothing here is invented beyond what the task store already
holds.

## Scope

- `apps/orchestrator/index.ts`: `buildStateAnswer()`'s `"conversation"`
  branch; its call site (already has `priorTurnsFor(conversation)`
  computed, just needs to pass it through).
- **Out of scope**: `synthesizeAnswer()`'s own grounding/retry mechanism —
  unchanged; `"state"`/`"failure"` branches — already correctly grounded
  in real material, untouched; the router's own classification
  (`specs/092`) — already fixed, untouched here.

## Safety and Compatibility Constraints

- **A genuine first-contact greeting (no prior turns) stays byte-identical**
  to today's fixed string — this spec only changes behavior when there is
  real conversation history to draw from.
- **No new factual claim risk** — whatever the raw `"conversation"` answer
  names must come from real, already-computed state (task store, recent
  turns), never invented, and `synthesizeAnswer()`'s own existing grounding
  check continues to apply unchanged on top of it.

## Out of Scope / Non-Goals

- Any change to `specs/091`'s `"failure"` branch or `specs/075`'s `"state"`
  branch — both already correctly grounded.
- Any change to the router's own classification logic — `specs/092`
  already fixed that half.

## Acceptance Criteria

- [x] A first-contact greeting with no prior turns is byte-identical to
      today's fixed string.
- [x] The exact real scenario that surfaced this — a real error asking a
      literal question, followed by a real contextual reply — produces an
      answer that is demonstrably not the generic greeting and reflects
      real, actual state.
- [x] No new ungrounded factual claim is possible — a dedicated test
      proves the raw answer only ever names real, already-computed state.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact scenario gets a genuinely relevant reply.

See `verification.md` for the full transcript, including a real test-
infrastructure bug (`KeywordRouterFake`) found and fixed along the way.

## Verification Plan

- Unit: first-contact case unchanged; the real scenario's shape produces
  a real-state-grounded answer; the grounding/no-invention guarantee.
- Live, with a real provider key: the exact real scenario re-run.

## Approval Requested

Not yet requested — presented for review, with one explicit open design
question (the exact shape of the new raw "conversation" answer) that
needs a decision before implementation.
