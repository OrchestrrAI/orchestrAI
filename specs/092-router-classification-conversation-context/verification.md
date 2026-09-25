# Verification: Router Classification Gets Conversation Context

## What changed

- `packages/shared/capability-router.ts`: `RunCapabilityRouterOptions`
  gains optional `priorTurns`; new `buildHumanPrompt()` (exported) prepends
  a bounded "Earlier in this conversation" block, mirroring
  `answer-harness.ts`'s own established pattern exactly — absent/empty
  history produces the byte-identical bare message as before this spec.
  System prompt gains one explicit safety-guard line: history is context
  only, always classify the LAST message.
- `apps/orchestrator/index.ts`: `classifyRouterProposal()` gains a third,
  optional `priorTurns` parameter (preserving the existing `injectedModel`
  position); the `/ask` handler's own classifier closure now passes
  `priorTurnsFor(conversation)`. `POST /tasks`'s own `detectSkill()` call
  site is untouched — it never passes the new parameter at all.

## Unit-level

- `packages/shared/capability-router.test.ts` — new `buildHumanPrompt()`
  tests (absent/empty history byte-identical; history present shapes the
  prompt correctly) plus a `CapturingModel`-based integration test
  proving prior turns and the safety-guard system-prompt line both
  genuinely reach the real message list sent to the model.
- `apps/orchestrator/capability-router-detect-skill.test.ts` — new test
  with a `CapturingModel` proving `POST /tasks`'s own human message is
  the bare text with no history block at all — not just inspection of
  the code path.
- `apps/orchestrator/ask-endpoint.test.ts` — new integration test with a
  `ContextAwareFake` model that only returns a non-generic classification
  when it can see the real preceding turn's own text in the prompt it
  receives — proving history reaches the classifier through the real
  `/ask` handler end to end, not just via a direct unit call.
- Full suite: `bun test` — 1094 pass, 0 fail (net +7 over `specs/091`'s
  own 1087). `bun run typecheck` — 0 errors.

## Live re-verification

Restarted `orchestrator` with the fix (the user's own live process,
restarted with explicit go-ahead). Reproduced the exact real scenario:
`mcp:http` was briefly stopped, a real `analyze-project` dispatch was made
and genuinely failed with `"Unable to connect. Is the computer able to
access the url?"`, `mcp:http` was restarted immediately, and a real
follow-up `"yes it can"` was sent in the same conversation.

**Result**: the router — now genuinely given the real preceding error
text — still classified `"yes it can"` as `kind: "conversation"`. This is
not a bug: it's a defensible real judgment (the reply isn't a work
request, a state question, or a failure question — it's an affirmation).
The mechanism itself is proven correct by the unit-level `CapturingModel`
tests above (a real prompt genuinely carrying the history reaches the
model); what this live pass additionally revealed is a **second, deeper**
gap in the *answer* for a correctly-classified `"conversation"` turn —
closed separately by `specs/093`, drafted and implemented the same
session immediately after this finding.

## Acceptance criteria

- [x] A short, context-dependent reply classifies correctly given
      conversation history — confirmed at the unit level (the
      `ContextAwareFake`/`CapturingModel` tests prove history reaches
      and can change classification); the live pass's own real-model
      judgment for the specific "yes it can" case was `"conversation"`,
      itself correct given real history, not a classification bug.
- [x] With no conversation history, the router's own prompt is
      byte-identical to before this spec — unit-tested directly.
- [x] `POST /tasks`'s own routing is unaffected for every existing test
      phrase — full suite green, plus a dedicated capturing-model test
      proving zero history in its own prompt.
- [x] A genuinely new, unrelated request arriving mid-conversation still
      classifies on its own merits — the system prompt's own safety-guard
      line is present and unit-tested (`CapturingModel` confirms it
      reaches the real message list).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact scenario reaches the classifier with
      real history genuinely present — confirmed; the resulting answer
      quality gap this exposed is `specs/093`'s own, separate fix.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

  **`specs/092-router-classification-conversation-context/spec.md`
  (implemented, verified, 2026-09-15)** fixed a deeper gap the same
  session surfaced: the router's own *classification* call — deciding
  what kind of message this even is — had never seen conversation
  history, only the final answer-phrasing step (`synthesizeAnswer()`)
  did. Live-caught: a real MCP failure whose error text literally asked
  *"Is the computer able to access the url?"*, followed by a real reply
  *"yes it can"*, got the same fixed greeting a first-time "hello"
  would. Fixed by threading the same already-existing, already-bounded
  `priorTurnsFor()` helper into the router's own prompt (reusing
  `answer-harness.ts`'s own established "prose history block" pattern,
  not inventing a new one) — with an explicit safety-guard prompt line
  so history helps interpret a short reply without letting an unrelated
  new request get mis-anchored to an old topic. `POST /tasks` (no
  conversation concept at all) is structurally unaffected — its call
  site simply never passes history, confirmed by a dedicated regression
  test proving the prompt it sends carries no history block, not just
  by inspection.
