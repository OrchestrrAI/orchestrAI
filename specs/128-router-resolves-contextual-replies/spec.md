---
id: 128-router-resolves-contextual-replies
title: The Router Rewrites a Contextual Chat Reply into a Self-Contained Request
area: routing-planning
change_type: fix
status: implemented
verification: verified
created: 2026-09-24
updated: 2026-09-24
approved_by: Muhamad-Yussuf
approved_on: 2026-09-24
implemented_on: 2026-09-24
amends:
  - 092-router-classification-conversation-context
  - 075-real-conversational-chat
supersedes: []
superseded_by: []
related:
  - 044-conversational-ask-layer
  - 124-conversation-answer-llm-synthesis
---

# Spec: The Router Rewrites a Contextual Chat Reply into a Self-Contained Request

> Status history: **APPROVED by Muhamad-Yussuf on 2026-09-24** ("yes" to
> drafting and implementing the router-rewrite fix). IMPLEMENTED and
> VERIFIED live the same day.

## Purpose

Live-reproduced in the TUI chat: after an `edit-files` task failed, the
Orchestrator itself asked "Would you like to try running that again?"
and the user answered "yes". The router, which sees prior turns
(specs/092), correctly routed "yes" to `edit-files` — but the text sent
to the Coder agent was the literal word "yes", so it failed with "'yes'
is completely ambiguous".

## Verified Current State

- `POST /ask` passes `priorTurnsFor(conversation)` (the last 6 turns) to
  the router, so skill choice already uses context
  (`apps/orchestrator/index.ts`, `classifyRouterProposal`).
- `classifyAsk()` (`apps/orchestrator/ask-classifier.ts`) sets
  `dispatchText: trimmed` — the raw message — for every real dispatch,
  and `dispatchRootTask()` sends that text to the agent. Context is used
  for routing and thrown away for execution.
- The only exception is a closed follow-up pattern ("again", "run it
  again", "repeat", …) that replays the previous task's text. "yes",
  "go ahead" and "do the same for utils.ts" are not covered.

## Proposed Behavior

1. The router's output schema gains an optional `resolvedRequest`
   (string or null).
2. **Only when prior turns are present**, the router's system prompt asks
   for it: when the LAST message only makes sense with the earlier turns,
   rewrite it as one complete, self-contained request carrying every
   detail it refers to (instruction, file names, paths), using only what
   the shown turns contain; otherwise null. With no history the prompt is
   byte-identical to today, so `POST /tasks` is unaffected.
3. `classifyAsk()` dispatches `resolvedRequest` (trimmed, when non-empty)
   instead of the raw message on the real-dispatch branch. The user's
   own turn is still stored exactly as typed.
4. The existing closed follow-up replay stays, and still runs first.
5. Added during live verification (same scope): `/ask` also passes the
   full text of the conversation's most recently dispatched task
   (`lastRequest`) to the router, shown only alongside prior turns. The
   6-turn window can scroll the original request out — without this, a
   later "same thing but for a node app" was rewritten without the
   original's port. Because a rewritten request becomes that task's own
   text, the chain stays complete across several follow-ups.

## Safety and Compatibility Constraints

- Only the dispatched text changes. Skill validation against the live
  snapshot, `SKILL_TIER_REGISTRY`, and the approval gate are untouched —
  a rewritten request to a write-capable skill still reaches the same
  human approval, and the rewritten text is visible as the task's text.
- A missing, null or blank `resolvedRequest` behaves exactly as today.
- No deterministic phrase list is added (explicit user preference).

## Non-Goals

- Widening the 6-turn history window (item 5 covers the case that mattered).
- Rewriting on `POST /tasks` (no conversation there).
- Guaranteeing the model's rewrite — it is an LLM judgment.

## Acceptance Criteria

- [x] Explicit approval recorded before implementation.
- [x] Router schema accepts `resolvedRequest`; a proposal without it
  still validates.
- [x] The system prompt mentions `resolvedRequest` only when prior turns
  are present.
- [x] `classifyAsk()` dispatches a non-blank `resolvedRequest`, and falls
  back to the raw message when it is absent or blank.
- [x] `bun run typecheck` 0 errors; `bun test` no regressions.
- [x] Live: after a failed or offered task, replying "yes" dispatches the
  original request's full text, not "yes".
