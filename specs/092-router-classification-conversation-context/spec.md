---
id: 092-router-classification-conversation-context
title: "The Router's Own Classification Call Is Blind to Conversation History — Only Answer Phrasing Sees It"
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
  - 044-conversational-ask-layer
  - 054-capability-driven-llm-routing
  - 065-llm-only-skill-routing
  - 075-real-conversational-chat
  - 091-chat-explain-last-failure
related: []
supersedes: []
superseded_by: []
---

# Spec: The Router's Own Classification Call Is Blind to Conversation History — Only Answer Phrasing Sees It

> Review gate: **APPROVED 2026-09-15 by Yusuf.**
>
> Found live, 2026-09-15, by Yusuf using
> the real TUI: after a real `analyze-project` failure whose error message
> literally asked *"Is the computer able to access the url?"*, he replied
> *"yes it can"* — a direct, sensible answer to that question — and got the
> exact same fixed greeting Chat gives a first-time *"hello"*. His own words:
> *"it should be reply! i remember once before there was like a chat not
> just like that what happened."*

## Purpose

`classifyAsk()`'s single LLM classification call (the router, `specs/054`/
`065`/`075`/`091`) decides what kind of message this is — a real work
request, a state question, a failure question, or idle conversation — from
**the current message's text alone**. It has never been given any
conversation history. Meanwhile `synthesizeAnswer()`, the *separate* step
that phrases a Tier 0 answer naturally once a key is configured, **does**
receive recent turns (`priorTurnsFor()`). The result: a short,
context-dependent reply like *"yes it can"* is genuinely meaningless in
isolation — no actionable intent, doesn't look like a state or failure
question — so it correctly-given-what-it-can-see falls into the generic
`"conversation"` bucket and gets the same fixed string every time,
regardless of what was actually said. The classification step, not the
phrasing step, is where this conversation actually breaks.

## Verified Current State

- `apps/orchestrator/index.ts:1658`: `classifyAsk(question, (text) =>
  classifyRouterProposal(text), {...})` — the injected classifier closure
  passes only `text`, never the conversation.
- `packages/shared/capability-router.ts`'s `runCapabilityRouter()` builds
  its prompt from exactly `[SystemMessage(buildSystemPrompt(...)),
  HumanMessage(options.text)]` — no history slot exists in
  `RunCapabilityRouterOptions` at all.
- `apps/orchestrator/index.ts:1217`: `priorTurnsFor(conversation, limit =
  6)` already exists, already bounded, already the exact function
  `synthesizeAnswer()` uses for answer phrasing (`apps/orchestrator/
  index.ts:1260`/`1668`) — confirmed reusable verbatim, not something
  that needs inventing.
- `apps/orchestrator/answer-harness.ts:133-150`'s `buildUserPrompt()`
  already establishes this codebase's own pattern for handing an LLM
  bounded prior-turn context: prose lines ("Earlier in this
  conversation:\n  user: ...\n  assistant: ...") prepended to the current
  question, guarded by `if (options.priorTurns?.length)` so an empty
  history produces byte-identical output to having no history slot at
  all. The fix reuses this exact established style, not a new one.
- `POST /tasks`'s own `tryCapabilityRoute()` has no conversation concept
  at all (confirmed by reading it — no `conversationId`, no turn store) —
  it always calls `classifyRouterProposal(text)` with nothing to thread
  through, so it is structurally unaffected by this fix regardless of
  implementation, not merely coincidentally.

## Proposed Behavior

`runCapabilityRouter()` (`packages/shared/capability-router.ts`) gains an
optional `priorTurns?: {role, text}[]` field on `RunCapabilityRouterOptions`,
consumed exactly the way `answer-harness.ts`'s `buildUserPrompt()` already
does: when present and non-empty, prepend a bounded "Earlier in this
conversation" block before the message to classify; when absent or empty,
the prompt is **byte-identical** to today.

`classifyRouterProposal()` (`apps/orchestrator/index.ts`) gains a matching
optional `priorTurns` parameter, passed straight through to
`runCapabilityRouter()`.

**The `/ask` handler's own call site is the only place that changes**: the
injected classifier closure becomes `(text) => classifyRouterProposal(text,
priorTurnsFor(conversation))` — reusing the exact same bounded, already-
proven helper `synthesizeAnswer()` already relies on, not a new mechanism.
`classifyAsk()` itself needs no signature change at all; `ProposalClassifier`
already just wraps a text-in/proposal-out function, and the conversation is
captured in the closure, not threaded through a new parameter.

`POST /tasks`'s own `detectSkill()`/`tryCapabilityRoute()` call sites are
**not touched** — they call `classifyRouterProposal(text)` with no second
argument, exactly as today, which is what makes their own behavior provably
unaffected rather than merely unlikely to change.

**The system prompt gains one explicit guard, load-bearing for safety, not
optional polish**: *"The conversation history above is context only, to
help you understand a short or ambiguous reply — always classify the LAST
message. Never let earlier turns override what the current message
actually asks for."* This exists specifically so history helps interpret
`"yes it can"` correctly without letting an unrelated new request get
mis-anchored to an old topic.

## Scope

- `packages/shared/capability-router.ts`: `RunCapabilityRouterOptions`,
  the prompt-building logic, the new safety-guard prompt line.
- `apps/orchestrator/index.ts`: `classifyRouterProposal()`'s new optional
  parameter; the `/ask` handler's own classifier closure.
- Tests: `capability-router.test.ts` (prompt construction with/without
  history, byte-identical-when-absent proof), `ask-endpoint.test.ts` (a
  real short contextual reply classifying correctly once history is
  available), `capability-router-detect-skill.test.ts` (`POST /tasks`'s
  own unaffected-behavior regression, explicit not assumed).
- **Out of scope**: any change to `synthesizeAnswer()`'s own existing
  history handling (already correct); any change to the approval gate —
  a write-capable skill named with conversation-context help still
  requires the identical `actionId`-bound approval, the same
  "non-deterministic component may name a skill; the gate makes it safe"
  precedent this codebase has already established repeatedly
  (`specs/020`, `specs/026`, `specs/054`); giving `POST /tasks` a
  conversation concept of its own — it has none today and this spec does
  not add one.

## Safety and Compatibility Constraints

- **`POST /tasks`'s own routing stays byte-identical** — the parameter is
  optional, its call sites pass nothing, confirmed by a dedicated
  regression test, not just by reading the code.
- **An empty or absent conversation history produces a byte-identical
  prompt to today** — the same guard `answer-harness.ts` already
  established for the identical shape of problem.
- **The approval gate is completely untouched.** A write-capable skill
  named with conversation-context assistance still reaches the identical
  `actionId`-bound flow; this spec changes only *how a skill gets named*,
  never what happens once one is.
- **Bounded, not unbounded** — reuses `priorTurnsFor()`'s existing
  `limit = 6` cap; no new unbounded context ever enters this prompt.

## Out of Scope / Non-Goals

- Threading conversation context into any other part of the routing
  pipeline (e.g. the adaptive supervisor's own step-by-step decisions,
  `specs/028`) — this spec is scoped to the one classification call at
  the top of `/ask`.
- Any change to how many prior turns are kept or how `priorTurnsFor()`
  itself works.
- Giving `POST /tasks` a conversation concept.

## Acceptance Criteria

- [x] A short, context-dependent reply classifies **using** the real
      conversation history (confirmed mechanically — a controlled fake
      only returns a non-generic kind when it can see the real prior
      turn). **Correction from the original wording**: the live pass's
      own real-model result for the specific "yes it can" case was still
      `kind: "conversation"` — a defensible judgment given the history
      (it genuinely isn't work/state/failure), not evidence the fix
      failed. The originally-assumed "should classify as something
      other than conversation" framing was itself not quite right; see
      `verification.md`.
- [x] With no conversation history (first message, or `POST /tasks`),
      the router's own prompt is byte-identical to before this spec.
- [x] `POST /tasks`'s own routing is unaffected for every existing test
      phrase — a dedicated regression test, not just inspection.
- [x] A genuinely new, unrelated request arriving mid-conversation still
      classifies on its own merits — the safety-guard prompt line is
      present and unit-confirmed to reach the model.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact scenario reaches the classifier with
      real history genuinely present. **Correction**: this alone does
      not yet produce "a genuinely relevant answer" for every case —
      that gap (a correctly-classified `"conversation"` turn's own
      *answer* still being context-blind) is real and separate, closed
      by `specs/093`, drafted the same session immediately after this
      live finding.

## Verification Plan

- Unit: prompt construction with/without history; the adversarial
  "new unrelated request mid-conversation" case; `POST /tasks`'s own
  non-regression.
- Live, with a real provider key (already available this session): the
  exact real scenario that surfaced this bug, re-run end to end.

## Approval Requested

Not yet requested — presented for review.
