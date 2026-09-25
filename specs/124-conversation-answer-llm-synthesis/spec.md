---
id: 124-conversation-answer-llm-synthesis
title: Conversation-Intent Answers Are LLM-Synthesized, Not Two Fixed Strings
area: conversational-ask-layer
change_type: fix
status: implemented
verification: verified
created: 2026-09-24
updated: 2026-09-24
approved_by: Yusuf
approved_on: 2026-09-24
implemented_on: 2026-09-24
amends:
  - 093-conversation-answer-context-blind
  - 116-chat-answer-voice-and-collapsed-raw-data
supersedes: []
superseded_by: []
related:
  - 039-per-component-llm-provider-config
  - 044-conversational-ask-layer
  - 055-provider-call-budgets-and-transient-error-handling
  - 075-real-conversational-chat
  - 091-chat-explain-last-failure
  - 097-chat-answer-and-plan-description-honesty
---

# Spec: Conversation-Intent Answers Are LLM-Synthesized, Not Two Fixed Strings

## Purpose

Live-observed in the TUI: once a conversation contains any prior turn and
any past task failure anywhere in its history, **every** subsequent
message the router classifies as `"conversation"` — "thanks", "thanks alot
ya man", and (separately observed) "fuck you" — gets answered with the
exact same fixed sentence, either naming that stale failure or (once no
failure exists) the literal string `"Got it — what would you like me to do
next?"`. The reply does not vary with what the user actually said. This
reads as broken: a plain "thanks" gets treated as though the user were
asking about a task failure from earlier in the conversation.

## Verified Current State

`buildConversationAnswer()` (`apps/orchestrator/index.ts:1817-1826`) is a
two-branch deterministic function with no access to the user's actual
message text:

```text
function buildConversationAnswer(priorTurns): string {
  if (priorTurns.length === 0) return CONVERSATION_GREETING
  const failed = findMostRecentFailure()
  if (failed) return `Got it. The most recent thing that didn't work was ${failed.skill}...`
  return "Got it — what would you like me to do next?"
}
```

It takes `priorTurns` only to check `.length`, never their content, and
never receives the question that triggered this turn at all. `/ask`'s
Tier-0 handling (`apps/orchestrator/index.ts:2463-2488`) then **explicitly
skips** `synthesizeAnswer()` for `stateIntent === "conversation"`
(`specs/116`, `isConversationIntent` guard at line 2481), so this fixed
string is shown completely verbatim — no LLM ever sees or varies it, even
when a provider key is configured. `specs/116` disabled synthesis for this
branch deliberately, after live-observing an earlier version stack a
synthesized sentence *in front of* this same raw sentence, producing two
independently-phrased answers to one message ("there is 2 person
responding me"). That earlier bug was in the *stacking* (raw + synthesized
concatenated), not in the idea of synthesis itself — but the fix applied
at the time was to remove synthesis entirely rather than to stop stacking,
leaving conversational replies permanently content-blind.

## Proposed Behavior

Give `"conversation"`-intent turns a real synthesized answer, shown
**alone** (never concatenated with the raw fixed string, which is what
actually caused the specs/116 regression) — grounded in the same real
state (`findMostRecentFailure()`) the fixed string already used, so the
model can mention that failure when it's actually relevant to what the
user said and stay silent about it otherwise (e.g. a plain "thanks").

1. **`buildConversationAnswer()` stops being the final answer.** It is
   renamed in purpose (not necessarily in name) to build *grounding
   material* only: the same two facts it already computes (first-contact
   vs. not; the real most-recent-failure record if any) rendered as plain
   state text, exactly as today — this part is unchanged, still fully
   deterministic and still the fallback.
2. **A new call to the existing `runAnswerHarness()`** (`answer-harness.ts`,
   unchanged) runs for every `"conversation"`-intent turn, using the
   `"conversation"` LLM component (`readLlmModelConfig(process.env,
   "conversation")` — already the exact mechanism `synthesizeAnswer()`
   uses today, so `ORCHESTRAI_CONVERSATION_LLM_MODEL` /
   `ORCHESTRAI_CONVERSATION_LLM_PROVIDER` / `ORCHESTRAI_CONVERSATION_LLM_API_KEY`
   already let a cheap/small model be assigned to this path specifically,
   independent of every other component, with zero new config surface).
   `question` is the user's real message; `source` is the grounding
   material from step 1; `priorTurns` is `priorTurnsFor(conversation)`,
   already computed at this call site.
3. **Fail-open, exactly like every other synthesis call in this repo**: no
   key configured, a provider error, or the harness exhausting its
   grounding retries all return `null` from `synthesizeAnswer()` today —
   in that case the conversation branch falls back to today's exact two
   fixed strings, byte-identical, so chat is never blank and never
   *requires* a provider to say hello back (specs/075's own stated
   constraint, unchanged).
4. **No stacking.** Unlike the `"state"`/`"failure"` Tier-0 branches (which
   intentionally show `synthesized + raw` so the collapsible raw detail
   stays available — `specs/116`), a successful conversation synthesis
   **replaces** the fixed string outright; there is no separate "raw data"
   worth keeping alongside a reply to "thanks". `ConversationTurn.summary`
   is therefore never set for this branch (nothing to collapse), matching
   today's behavior.

## Scope

- `apps/orchestrator/index.ts` — `buildConversationAnswer()` (repurposed
  to grounding-text-only), the `isConversationIntent` skip at the Tier-0
  `/ask` handling site (~line 2481), and the `synthesized` /
  `answer` composition immediately after it.
- No change to `answer-harness.ts`, `synthesizeAnswer()`,
  `readLlmModelConfig()`, or the `"conversation"` `LlmComponent` entry —
  all reused verbatim.
- No change to `buildStateAnswer()`'s `"state"`/`"failure"` branches, to
  `CANNED_NO_DATA_ANSWERS`, or to any dispatch/approval/routing path.

## Safety and Compatibility Constraints

- **Grounding is unchanged**: the LLM still only ever sees material this
  repo's own deterministic state functions produced
  (`findMostRecentFailure()`'s real record, or the first-contact fact) —
  never a fresh fetch, never write-capable tool access, never anything
  the model could use to imply an action was taken. `runAnswerHarness()`'s
  existing bounded numeric-grounding check (`ungroundedNumbers()`)
  applies unchanged.
- **Fail-open is the load-bearing property**: any synthesis failure must
  fall back to today's exact fixed strings — a "thanks" must never go
  unanswered or error out because a cheap model's key is misconfigured.
- No new environment variable is introduced; the existing per-component
  `ORCHESTRAI_CONVERSATION_LLM_*` triad already covers "use a cheaper
  model for this path only."
- This spec does not touch classification (`classifyAsk`,
  `capability-router.ts`) — whether a message is correctly recognized as
  `"conversation"` vs. `"failure"` vs. `"state"` is an existing, separate
  concern (router judgment, out of scope here).
- Does not change the approval gate, `SKILL_TIER_REGISTRY`, or any
  write-capable path — `"conversation"` never dispatches a task today and
  continues not to.

## Out of Scope / Non-Goals

- Re-tuning or re-prompting the capability router's classification logic.
- Changing `synthesizeAnswer()`'s behavior for `"state"`/`"failure"`
  Tier-0 answers or for dispatched-task answers — those keep the existing
  synthesized+raw stacking, which is correct for them (real data worth
  keeping collapsible) and is not the bug this spec addresses.
- Adding streaming, memory, or any state beyond what `priorTurnsFor()`
  already bounds and provides.
- Introducing a new LLM component or config variable.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] A `"conversation"`-intent turn with a real provider key configured
      produces a reply that varies with the actual message text (unit
      test: two different conversational inputs against the same prior
      state produce two different harness prompts/questions — assert on
      what's passed to the harness, not on live model output).
- [x] A `"conversation"`-intent turn with no key configured (or a
      misconfigured one) still returns exactly today's fixed sentence —
      byte-identical fallback, asserted by test.
- [x] The final answer for this branch is never
      `${synthesized}\n\n${raw}` — synthesis replaces the fixed string
      outright, never stacks with it.
- [x] `ConversationTurn.summary` stays unset for this branch (nothing new
      to collapse), matching current behavior.
- [x] Existing `specs/093`/`specs/116` tests covering the fixed-string
      fallback content still pass (fallback content is preserved).
- [x] `bun test` and `bun run typecheck` pass.
- [x] `context/worklog.md` gets a dated entry.

## Verification Plan

- Unit: extend `apps/orchestrator/ask-endpoint.test.ts` — mock the
  `"conversation"` component's model, assert the harness is invoked with
  the real user message as `question` and the deterministic grounding
  text as `source`; assert the fallback path on harness failure/no-key
  matches today's exact strings.
- Unit: assert no `${synthesized}\n\n${raw}` concatenation occurs for this
  branch (distinguishing from the `"state"`/`"failure"` branches, which
  keep it).
- Live (optional, recorded as observed evidence per CLAUDE.md's stance on
  model-judgment features): with a real cheap-model key configured via
  `ORCHESTRAI_CONVERSATION_LLM_MODEL`, replay the exact sequence from the
  bug report ("hello" → "thanks" → an insult) through the TUI and confirm
  each reply is contextually distinct rather than the same nag repeated.

## Approval Requested

Approval authorizes: repurposing `buildConversationAnswer()` to produce
grounding text only (its existing two computed facts, unchanged), adding
one `runAnswerHarness()` call for `"conversation"`-intent turns using the
existing `"conversation"` LLM component and existing fail-open pattern,
and removing the `isConversationIntent` synthesis skip in favor of a
non-stacking replacement composition. It does not authorize any change to
routing/classification, to the `"state"`/`"failure"` branches' existing
stacking behavior, to the approval gate, or to any new configuration
surface.
