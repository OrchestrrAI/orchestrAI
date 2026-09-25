---
id: 116-chat-answer-voice-and-collapsed-raw-data
title: "Chat: One Voice for Conversational Answers, and the Raw Report Collapses Behind the Synthesis"
area: orchestrator
change_type: fix
status: implemented
verification: partial
created: 2026-09-23
updated: 2026-09-23
approved_by: Yusuf
approved_on: 2026-09-23
implemented_on: 2026-09-23
amends:
  - 044-conversational-ask-layer
  - 046-browser-conversation-operations-workspace
  - 091-chat-explain-last-failure
  - 092-router-classification-conversation-context
  - 093-conversation-answer-context-blind
  - 097-chat-answer-and-plan-description-honesty
  - 115-tui-navigation-redraw-and-answer-clarity
related: []
supersedes: []
superseded_by: []
---

# Spec: Chat: One Voice for Conversational Answers, and the Raw Report Collapses Behind the Synthesis

> Status: **IMPLEMENTED, verification: partial** — see `verification.md`
> for the full record. Two issues Yusuf found live-driving
> the TUI chat the same session `specs/115` shipped, bundled into one
> checkpoint since the second directly depends on the first's own
> `summary`/`text` split. The first ("two people responding") is a
> confirmed bug with a clear root cause; the second ("do i really need
> the synthesized paragraph?") is a design change, settled directly
> through back-and-forth before drafting: keep synthesis (it answers the
> specific question asked, which the raw report alone doesn't), but stop
> always showing the full raw report inline underneath it — Yusuf's own
> "Option A."

## Current behavior (verified against the real code)

Every Tier 0 `/ask` answer (`apps/orchestrator/index.ts`, `POST /ask`,
around line 2414) follows the same shape: `raw = buildStateAnswer(...)`,
then, unless `raw` is a literal member of the closed
`CANNED_NO_DATA_ANSWERS` set, `synthesized = await synthesizeAnswer(...)`,
and the stored/returned answer is `synthesized ? \`${synthesized}\n\n
${raw}\` : raw`.

`buildStateAnswer()` (line 1785) dispatches on `stateIntent`:

- `"state"` → `answerCapabilitiesFromState() + answerRecentTasksFromState()`
  — genuinely raw, dry facts (a roster, a task list) that a synthesized
  paraphrase legitimately adds value to.
- `"failure"` → `answerLastFailureFromState()` — a structured "Most
  recent failure — skill (agent):\n\<detail\>" report; also
  report-shaped, not conversational.
- `"conversation"` → `buildConversationAnswer()` (line 1774) — **this
  one is different**: it already returns a complete, natural-language,
  context-aware reply (e.g. *"Got it. The most recent thing that didn't
  work was dockerize (devops-agent) — want me to try that again, or ask
  me something else?"*), the entire point of `specs/093`'s own design.

**The bug**: `buildConversationAnswer()`'s dynamic output can never be a
member of `CANNED_NO_DATA_ANSWERS` (a `Set` of exact fixed strings —
`buildConversationAnswer()`'s own text varies with the real most-recent
failure), so `synthesizeAnswer()` always runs on top of it anyway. Since
the "raw" material here is already a complete answer, not raw data,
`synthesizeAnswer()` ends up doing the same job twice — the result is
two different phrasings of the same reply concatenated together, which
reads as two different people answering. It gets worse for a genuinely
unrelated follow-up: `synthesizeAnswer()` is asked to answer the user's
real question grounded *only* in `buildConversationAnswer()`'s own
unrelated failure-recap text, producing an answer like *"The material
does not actually answer the question"* — true, and useless, because
the function was never given anything relevant to answer from.

Live-caught, verbatim from the real TUI: after *"thanks"*, the reply was
*"You're welcome! Would you like me to try the edit-file action again
with the coder-agent, or is there something else I can help you
with?"* immediately followed by *"Got it. The most recent thing that
didn't work was edit-file (coder-agent) — want me to try that again, or
ask me something else?"* — the same fact, in two different voices,
stacked.

**The "do I need the raw dump" question**: for `"state"`/`"failure"`
intents (where synthesis is legitimate), the current design always
shows the full raw report inline beneath the synthesis — e.g. a
synthesized paragraph about the project's stack, immediately followed
by the entire `=== DevOps MCP Analysis ===`/`=== Codebase Analysis ===`
block. Settled directly: keep the synthesis (it answers what was asked,
where the raw report requires reading the whole thing), but stop always
rendering the full raw block inline — collapse it behind a pointer,
never delete it (the data stays fully available, just not forced onto
the screen every time).

## Proposed behavior

### 1. The conversation-intent fix — no more blind synthesis over an already-complete answer

In `POST /ask`'s Tier 0 branch, special-case `stateIntent === "conversation"`
**before** the existing `CANNED_NO_DATA_ANSWERS` check: `synthesizeAnswer()`
is never called for this intent at all — `buildConversationAnswer()`'s
own output **is** the answer, verbatim, exactly as `specs/093` intended.
This closes both symptoms at once: no more two-voices duplication, and
no more asking the model to answer a real question using irrelevant
grounding material. `"state"`/`"failure"` intents are completely
unaffected — they keep the existing synthesize-then-append-raw
behavior, just with new collapsed-by-default rendering (item 2).

### 2. `ConversationTurn` gains an optional `summary` field

`text` is **completely unchanged** — still the full, uncapped
`${synthesized}\n\n${raw}` (or bare `raw`) value, still what's
persisted, still what `GET /conversations/:id` returns, still what
every existing consumer/test already expects. A new optional field,
`summary?: string`, is set **only** when synthesis actually ran for a
`"state"`/`"failure"` intent (never for `"conversation"`, which has
nothing to summarize separately from item 1's own fix) — holding just
the synthesized paragraph, the part meant to be the default, readable
answer.

This is the same additive-field pattern this codebase already uses
repeatedly for exactly this reason (`ApprovalPreview.files`,
`AuditPushPayload.paramsWhitelisted`, etc.) — every existing consumer
that only ever read `text` keeps working unchanged; a client that wants
the collapsed view reads `summary ?? text`.

### 3. TUI: collapsed by default, one key to see the full report

`apps/tui/index.tsx`'s chat rendering shows `turn.summary ?? turn.text`
as the default turn content — for `"conversation"`-intent turns (no
`summary`) this is byte-identical to today; for `"state"`/`"failure"`
turns, only the synthesized paragraph shows by default.

A new key, scoped to the **most recent assistant turn only** (avoiding
the complexity of a per-turn expand state for every turn in a long
thread): pressing it toggles that one turn between its `summary` and
its full `text`. When a turn has a `summary` distinct from its `text`,
a short hint appears beneath it (e.g. `"more detail — press d to
expand"`); the hint is absent when there's nothing to expand (no
`summary`, or `summary === text`).

### 4. Dashboard: the same collapse, with a real inline toggle

`apps/orchestrator/index.ts`'s `renderConversation()` renders
`turn.summary || turn.text` by default, plus a small `"▸ full report"`
toggle link when `turn.summary` is present and differs from `turn.text`
— a plain client-side `dataset`-keyed show/hide (matching this file's
own established toggle pattern for the raw-JSON view elsewhere), no
server round trip.

## Scope

In scope: the conversation-intent synthesis skip (item 1);
`ConversationTurn.summary` (item 2); the TUI's collapsed-by-default
rendering + last-turn expand key (item 3); the dashboard's own collapsed
rendering + inline toggle (item 4).

Out of scope, explicitly: any change to what's persisted/returned via
`text` (always the full value, unchanged); a per-turn expand mechanism
for every turn in the TUI (scoped to the most recent turn only, a
deliberate simplification); any change to `"conversation"`'s own
`buildConversationAnswer()` logic itself (only whether synthesis runs on
top of it); any change to Tier 1/2 answers (real dispatched work,
unaffected by this spec).

## Safety constraints

- **No data is ever lost or hidden permanently.** `text` remains the
  complete, uncapped value on every turn, in the store, in the API
  response, and in `GET /conversations/:id` — `summary` is a strictly
  additive convenience for the default view, never a replacement.
- **The conversation-intent fix removes an LLM call for that intent's
  own answers** (a genuine, real cost reduction, confirmed by direct
  code read: `synthesizeAnswer()` is skipped entirely, not just its
  result discarded) — a deliberate, disclosed side effect of item 1, not
  the point of the fix but a real one.
- **No change to the approval gate, dispatch logic, or any Tier 1/2
  path.** This spec touches only Tier 0 answer composition and its
  rendering.

## Acceptance criteria

- [x] A `"conversation"`-intent reply (e.g. "thanks", "can you speak
      arabic?") shows exactly one voice — `buildConversationAnswer()`'s
      own text, never a second synthesized paraphrase stacked on top.
      **Live-verified against a real Gemini deployment**, the exact
      reported scenario: a genuine rejected `dockerize` approval (a real
      recorded failure), then "thanks" — the real answer was
      `buildConversationAnswer()`'s own text verbatim, no `\n\n`, no
      second phrasing.
- [x] `__getTestSynthesisCallCount()` proves zero synthesis calls for a
      `"conversation"`-intent turn, the same directly-provable style
      `specs/097`'s own `CANNED_NO_DATA_ANSWERS` test already
      established. 3 new hermetic tests confirm this for the dynamic
      (real-failure-naming) case specifically, the exact scenario the
      old `CANNED_NO_DATA_ANSWERS` Set could never catch.
- [x] A `"state"`/`"failure"` turn's own `text` field is byte-identical
      to before this spec (still the full synthesized+raw value) — no
      regression to any existing consumer or test reading `text`. All
      pre-existing `specs/097` tests (which assert on `text`/`answer`
      directly) pass unmodified.
- [x] A `"state"`/`"failure"` turn with synthesis carries a `summary`
      field containing just the synthesized paragraph; a
      `"conversation"` turn carries no `summary` field at all.
      Live-verified against the real deployment: a real "what agents do
      you have online right now?" question produced a `summary` field
      whose value the real `text` field genuinely starts with (556
      chars full vs. 248 chars summary) — confirmed via direct
      `GET /conversations/:id` inspection, not inferred.
- [x] The TUI's default chat rendering shows only the summary for a
      `"state"`/`"failure"` turn with one; the last assistant turn's own
      expand key reveals the full `text`, then collapses back.
      Implemented (`resolveChatTurnDisplay()`, unit-tested 6 ways) and
      live-smoked via a real-PTY capture with injected summary/text
      data — the collapsed view and its hint line render correctly,
      clean border, no corruption. **Not confirmed**: an actual `d`
      keypress toggling it in a real terminal — this sandbox has no
      raw-mode stdin, the same standing gap every TUI interaction in
      this codebase carries.
- [x] The dashboard's chat panel shows the same collapsed default, with
      a working inline toggle to reveal the full report per turn.
      Implemented and confirmed present in the real generated
      `/dashboard` HTML (`toggleChatTurnFull`, `.chat-turn-summary`,
      `.chat-turn-full`, `.link-btn` CSS all confirmed via a real
      in-process `app.fetch()` call). **Not confirmed**: an actual
      click in a real browser — no browser backend available in this
      pass, the same gap `specs/046` itself already carries.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.

## Verification plan

- Unit: the conversation-intent skip (zero synthesis calls, via the
  existing test-only counter), the `summary`/`text` split for
  `"state"`/`"failure"`, TUI pure-state coverage for the last-turn
  expand toggle.
- Live: the exact real scenario that surfaced this ("thanks" after a
  failure, then an unrelated question) against a real Gemini
  deployment, confirming one voice, not two; a real "state"/"failure"
  answer confirming the collapsed default and the expand key/toggle
  both work in a real terminal and a real browser.

## Non-goals

- A per-turn (not just last-turn) expand mechanism in the TUI.
- Removing synthesis for `"state"`/`"failure"` intents (considered and
  declined — Yusuf's own call: the synthesized answer earns its keep by
  answering the specific question asked, unlike the raw report alone).

## Correction, same day — extended to Tier 1/2 (dispatched-task) answers too

The spec as originally implemented explicitly excluded Tier 1/2
(real dispatched work) answer composition — `appendAnswerWhenTaskTerminates()`
kept composing `synthesized + raw` with no `summary` field, unlike the
Tier 0 `/ask` path this spec fixed. Yusuf caught this live, the same
session, against a real dispatched `analyze-project` task: the exact
same "still getting that" raw-dump-after-synthesis pattern, just via a
different call site. Confirmed by direct code read — `appendAnswerWhenTaskTerminates()`
composes its own turn the identical way the Tier 0 branch used to.

**No new design was needed** — this is the second, and only remaining,
call site that composes `synthesized + raw`; the fix is the identical
one line (`...(synthesized ? { summary: synthesized } : {}) `) applied
to its own `newTurn()` call. Both the TUI's `resolveChatTurnDisplay()`
and the dashboard's `renderConversation()` already operate generically
over every turn's own `summary` field, regardless of whether the turn
carries a `taskId` — so this needed **zero** additional client-side
code, only the one server-side line.

Live-verified against a real Gemini deployment, a genuinely isolated
scratch stack: a real `/ask` dispatch of `analyze-project` (Tier 2, no
approval needed) completed, and `appendAnswerWhenTaskTerminates()`'s own
1-second poll loop picked it up and appended a turn whose `summary`
(a real synthesized paragraph) was confirmed a genuine prefix of the
real, full `text` (1410 chars) via direct `GET /conversations/:id`
inspection — the exact mechanism already proven for Tier 0, now also
proven for Tier 1/2.

Not independently hermetically tested — no existing test in this suite
exercises `appendAnswerWhenTaskTerminates()`'s own real execution (it
requires a real task lifecycle plus a real 1-second poll loop; existing
tests seed the resulting turn directly instead). Given the change is a
one-line, low-risk reuse of fully-proven infrastructure (the exact same
field, already unit-tested and live-verified for the sibling call
site), live verification alone was judged proportional — per CLAUDE.md's
own "verify in proportion to risk" rule — rather than investing in a
new async test harness for this single line.
