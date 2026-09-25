# Verification: Contextual "conversation" Answers

## What changed

- `apps/orchestrator/index.ts`: new `buildConversationAnswer(priorTurns)`
  — with no prior turns, returns the exact original fixed greeting; with
  prior turns and a real recent failure, names it (real skill/agent, from
  the same `tasks` walk `answerLastFailureFromState()` already uses);
  with prior turns but no recent failure, a shorter but still
  context-aware invitation. `buildStateAnswer()`'s `"conversation"`
  branch now calls it; the one call site threads `priorTurnsFor(conversation)`
  through (computed once, reused for both this and `synthesizeAnswer()`).

## A real bug found and fixed while writing this spec's own tests, not in production code

`apps/orchestrator/keyword-router-fake.ts` (test-only) used to keyword-match
against the **entire** prompt text sent to the model, including any
embedded "Earlier in this conversation" history block `specs/092` added.
A prior turn containing the word `"hello"` (itself a real
`CONVERSATION_PATTERNS` entry) then spuriously matched even when the
*current* message was something completely different (`"git status at
C:\proj"`), silently misclassifying it. Fixed by extracting only the text
after the `"Message to classify: "` marker before matching — the same
scoping the real router's own system prompt already instructs a real
model to do. Confirmed this is a test-infrastructure bug only, not a
production one: the real router prompt already carries the explicit
safety-guard line (`specs/092`) telling a real model to classify only the
last message; only this hand-rolled fake lacked the equivalent narrowing.

## Unit-level

- `apps/orchestrator/ask-endpoint.test.ts` — three new tests: first-contact
  greeting stays byte-identical; mid-conversation after a real failure
  names it (and never invents facts not present in real state); mid-
  conversation with no failure gets a shorter context-aware answer, still
  not the generic greeting.
- Full suite: `bun test` — 1101 pass, 0 fail across 73 files (net +7 over
  `specs/092`'s own 1094). `bun run typecheck` — 0 errors.

## Live re-verification

Restarted `orchestrator` with the fix. Real three-turn conversation:

1. `"hello"` (fresh conversation) → the exact original fixed greeting,
   byte-identical.
2. `"write tests for my application"` (same conversation) → a real
   `write-tests` dispatch, genuinely failed with `"No source file
   named..."`.
3. `"hello"` again (same conversation) →
   ```
   Got it. The most recent thing that didn't work was write-tests
   (testing-agent) — want me to try that again, or ask me something else?
   ```

Decisive: a real, contextual, grounded reply — not the canned greeting —
closing the exact complaint that started this spec.

## Acceptance criteria

- [x] A first-contact greeting with no prior turns is byte-identical.
- [x] The exact real scenario produces a demonstrably non-generic,
      real-state-grounded answer.
- [x] No new ungrounded factual claim is possible — the answer only ever
      names the real skill/agent already on a real failed task, never
      invents anything (confirmed by a dedicated test asserting the
      answer does NOT contain an unrelated injected error string).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact scenario gets a genuinely relevant reply.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

  **`specs/093-conversation-answer-context-blind/spec.md`
  (implemented, verified, 2026-09-15)** closed the other half of the
  same real complaint: `092` fixed classification blindness, but a
  *correctly* classified `"conversation"` turn (a real reply genuinely
  isn't a work/state/failure question) still produced the exact same
  hardcoded greeting string, because the raw material `synthesizeAnswer()`
  was given to phrase never varied with what was actually said. A new
  `buildConversationAnswer()`: a first-contact greeting (no prior turns)
  stays byte-identical; mid-conversation, it names the real most recent
  failure (same real state `091`'s own answer reads, never invented) and
  offers to retry, or a shorter context-aware invitation if there's no
  recent failure. Live-confirmed with the exact real three-turn scenario
  that surfaced it: `"hello"` → real greeting; a real `write-tests`
  failure; `"hello"` again → *"Got it. The most recent thing that didn't
  work was write-tests (testing-agent) — want me to try that again, or
  ask me something else?"* — genuinely responsive, not canned. **A real
  test-infrastructure bug found and fixed along the way**: the test-only
  `KeywordRouterFake` (`specs/065`) used to keyword-match against the
  *entire* prompt including `092`'s own embedded history block, so a
  word like `"hello"` sitting in a *prior* turn could spuriously trigger
  a match against the *current*, unrelated message — fixed by scoping
  the fake to only the text after the `"Message to classify: "` marker,
  the same narrowing the real router's own system prompt already
  instructs a real model to do; confirmed this was a test-double-only

See specs/107-task-and-conversation-history/verification.md for the relocated narrative covering this checkpoint.

See specs/116-chat-answer-voice-and-collapsed-raw-data/verification.md for the relocated narrative covering this checkpoint.
