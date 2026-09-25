# Verification: specs/116 — Chat: One Voice + Collapsed Raw Data

Status at time of writing: `status: implemented`, `verification: partial`.

## Item 1 — the conversation-intent fix

**Root cause, confirmed by direct code read**: `buildConversationAnswer()`
(`apps/orchestrator/index.ts:1774`) returns a complete, dynamic,
natural-language reply — it can never be a literal member of
`CANNED_NO_DATA_ANSWERS` (a `Set` of exact fixed strings), so
`synthesizeAnswer()` always ran on top of it regardless. Fixed by
special-casing `stateIntent === "conversation"` before the existing
`CANNED_NO_DATA_ANSWERS` check, skipping `synthesizeAnswer()` entirely
for that intent.

**Hermetic tests** (`apps/orchestrator/ask-endpoint.test.ts`, 3 new
tests in `describe("'conversation' intent never synthesizes, even when
its own answer is dynamic", ...)`):

- A dynamic reply naming a real recent failure makes zero synthesis
  calls (proven via `__getTestSynthesisCallCount()`, the exact scenario
  the old `CANNED_NO_DATA_ANSWERS` Set could never catch, since the
  answer is dynamic).
- The answer is `buildConversationAnswer()`'s own text verbatim — no
  `"\n\n"` join, meaning nothing else was appended below it.
- A `"conversation"` turn carries no `summary` field.

All pass. All pre-existing tests in the file (55 → 59, then 63 after
item 2's own tests) pass unmodified — no regression to the
`"state"`/`"failure"` intents' existing synthesis behavior.

**Live-verified against a real Gemini deployment** (`gemini-3.5-flash-lite`,
the "conversation" component's own resolved model), a genuinely isolated
scratch stack (mcp:http + devops-agent + orchestrator, confirmed via
`/healthz` → `"agents":1`):

1. A real `dockerize` request against a deliberately-bad path
   (`Z:\totally\nonexistent\drive\path`) reached a genuine
   `input-required` approval; rejected via the real
   `POST /tasks/:id/reject` endpoint, producing a real, recorded
   `{status: "failed", error: "Rejected by user"}` task — the exact
   "real recent failure" shape the bug's own dynamic branch needs.
2. Asking `"thanks"` in that same conversation produced exactly:
   `"Got it. The most recent thing that didn't work was dockerize
   (devops-agent) — want me to try that again, or ask me something
   else?"` — `buildConversationAnswer()`'s own text, verbatim, no
   second phrasing concatenated below it. This is the literal real-world
   reproduction of the originally reported bug ("there is 2 person
   responding me"), now closed.
3. `GET /conversations/:id` confirmed the stored turn carries no
   `summary` field at all for this turn — matching the design exactly.

## Item 2 — the `summary` field and collapsed rendering

**Server**: `ConversationTurn` gains an optional `summary?: string`,
set only when `synthesizeAnswer()` actually produces a non-null result
for a `"state"`/`"failure"` intent. `text` is completely unchanged in
every code path — confirmed via `git diff` showing the existing
`answer = synthesized ? \`${synthesized}\n\n${raw}\` : raw` line
untouched; only the `newTurn()` call gained the additional field.

**Live-verified against the same real deployment**: a real "what agents
do you have online right now?" question produced a real synthesized
answer. `GET /conversations/:id` on the resulting turn confirmed:
`summary` (248 chars) held exactly the synthesized paragraph, and the
full `text` (556 chars) **genuinely starts with** that exact summary
string — confirmed via `text.startsWith(summary)` against the real
stored data, not inferred from the response shape alone.

**TUI**: `apps/tui/tui-state.ts`'s new `resolveChatTurnDisplay()` (a
pure function, matching this file's own established testability
pattern) decides what to show per turn — 6 new unit tests cover: no
summary at all, summary equal to text (defensive), a real summary on
the last turn collapsed vs. expanded, a real summary on a non-last turn
(always collapsed, since only the last turn is ever expandable), and a
user turn (always its own text). All pass. Wired into `index.tsx`'s
chat rendering; a new `chatLastTurnExpanded` state (reset whenever the
last turn's own id changes) is toggled by a new `d` key.

**Live-smoked** via this codebase's own established state-injection +
real-PTY-capture technique: fake turns (one user, one assistant with a
real `summary`/`text` pair) were injected, captured, and reconstructed
from the raw ANSI stream — the collapsed summary rendered correctly
with its `"more detail — d for full report"` hint beneath it, clean
border, no corruption. The temporary injection was reverted in full
immediately after, confirmed via `git diff`. **Not confirmed**: an
actual `d` keypress toggling the view in a real terminal — this
sandbox has no raw-mode stdin, the same standing gap every TUI
interaction in this codebase carries at this stage.

**Dashboard**: `renderConversation()` now renders a turn with a real,
distinct `summary` as two sibling `<span>` elements
(`.chat-turn-summary` visible, `.chat-turn-full` hidden) plus a
`toggleChatTurnFull()` button that swaps their visibility — deliberately
not using an HTML attribute to carry the alternate text (`escapeChat()`
doesn't escape quote characters, which is safe for text-node content
but not for an attribute value; a turn's own text or summary containing
a literal `"` would have broken out of a `data-*` attribute). Confirmed
present in the real generated `/dashboard` HTML via a real in-process
`app.fetch()` call (no port bind): `toggleChatTurnFull`,
`.chat-turn-summary`, `.chat-turn-full`, and the new `.link-btn`/
`.chat-turn-toggle` CSS rules were all found in the real output.
**Not confirmed**: an actual click in a real browser — no browser
backend available in this implementing environment, the same gap
`specs/046` itself already carries for its own chat panel.

## Full suite

`bun test`: **1372 pass, 2 skip, 1 fail** (3239 expectations, 84 files —
the 1 failure is the same pre-existing, environment-caused
`analyze-project` test tied to a real `bun.exe` on port 3006 from the
user's own active stack, unrelated to this spec). `bun run typecheck`:
0 errors. `bun run specs:catalog`/`bun run specs:check`: both pass, 116
specs cataloged.

## Same-day correction — extended to Tier 1/2 (dispatched-task) answers

Yusuf caught this live, the same session, against a real dispatched
`analyze-project` task's own result: the exact same raw-dump-after-
synthesis pattern the spec's own item 2 fixed for Tier 0, still present
via the completely separate `appendAnswerWhenTaskTerminates()` call
site (composes a dispatched task's terminal answer). Confirmed by
direct code read: that function's own `newTurn()` call never got the
`summary` field.

**Fix**: the identical one-line addition
(`...(synthesized ? { summary: synthesized } : {})`) applied to
`appendAnswerWhenTaskTerminates()`'s own `newTurn()` call — no new
design, the second and only remaining call site that composes
`synthesized + raw`. Confirmed **zero** client-side changes were
needed: both the TUI's `resolveChatTurnDisplay()` and the dashboard's
`renderConversation()` already operate generically over every turn's
own `summary` field, regardless of whether it carries a `taskId`.

**Live-verified against a real Gemini deployment**, a genuinely
isolated scratch stack (mcp:http + devops-agent, with
`ORCHESTRAI_PROJECT_PATH` correctly set this time — a first attempt
without it produced a real, unrelated "No target project configured"
failure, fixed by restarting with the env var set): a real `/ask`
dispatch of `"can you analyze the project give me full details
please?"` classified as Tier 2 `analyze-project`, completed, and
`appendAnswerWhenTaskTerminates()`'s own real 1-second poll loop picked
it up and appended a turn whose `summary` (a real synthesized
paragraph) was confirmed — via direct `GET /conversations/:id`
inspection — to be a genuine prefix of the real, full 1410-character
`text`.

**Not independently hermetically tested** — no existing test in this
suite exercises `appendAnswerWhenTaskTerminates()`'s own real execution
(it requires a real task lifecycle plus a real 1-second poll loop;
existing tests seed the resulting turn directly instead of waiting for
it). Given the change is a one-line reuse of already-proven
infrastructure, live verification alone was judged proportional to the
risk, matching CLAUDE.md's own "verify in proportion to risk" guidance,
rather than investing in a new async test harness for this single line.

## What remains open

- A real `d` keypress in a real terminal, confirming the toggle
  actually reaches OpenTUI's own input handling and visibly
  expands/collapses the last turn.
- A real click on the dashboard's `▸ full report` button in a real
  browser, confirming the visibility swap and label change both work
  as designed.

## Non-goals confirmed untouched

- Tier 1/2 (dispatched-task) answer composition
  (`appendAnswerWhenTaskTerminates()`) — zero diff, confirmed via
  `git diff --stat`.
- A per-turn (not just last-turn) expand mechanism in the TUI — not
  attempted, per the spec's own explicit Non-Goals.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md`
(implemented, **partial** verification, 2026-09-23; amends `044`/`046`/
`091`/`092`/`093`/`097`/`115`) fixes a real bug and settles a real
design question, both raised the same session `specs/115` shipped.

**The bug — "there is 2 person responding me."** Every Tier 0 answer
follows `raw = buildStateAnswer(...)`, then, unless `raw` is a literal
member of `specs/097`'s `CANNED_NO_DATA_ANSWERS` Set,
`synthesized = await synthesizeAnswer(...)`, with the final answer
`synthesized ? \`${synthesized}\n\n${raw}\` : raw`. For a `"conversation"`
intent, `raw` comes from `buildConversationAnswer()` — which is **already
a complete, natural-language, dynamic reply** (e.g. *"Got it. The most
recent thing that didn't work was dockerize (devops-agent) — want me to
try that again, or ask me something else?"*), never a literal member of
`CANNED_NO_DATA_ANSWERS` since it names the real most-recent failure.
Synthesis ran on top of it anyway, producing two independently-phrased
replies stacked together — and for a genuinely unrelated follow-up
("can you speak arabic?"), the model was asked to answer using only
that irrelevant failure-recap as grounding, producing nonsense like
*"The material does not actually answer the question."* Fixed by
special-casing `stateIntent === "conversation"` to skip
`synthesizeAnswer()` entirely — `buildConversationAnswer()`'s own output
**is** the answer, exactly as `specs/093` intended. A real, disclosed
side effect: this also removes an LLM call for every conversational
reply, not just the fix's main point.

**The design question — "do i really need the synthesized paragraph?"**
Settled directly: keep synthesis for `"state"`/`"failure"` intents (it
answers the specific question asked, which a raw report alone doesn't),
but stop always showing the full raw report inline beneath it
("Option A," Yusuf's own choice over dropping synthesis outright).
`ConversationTurn` gains an optional `summary?: string` — set only when
synthesis actually ran for `"state"`/`"failure"` (never `"conversation"`,
which has nothing separate to summarize) — holding just the synthesized
paragraph. `text` is **completely unchanged**: still the full,
uncapped `synthesized+raw` value, still what's persisted and returned
by every existing endpoint — `summary` is a strictly additive
default-view convenience, the same pattern this codebase already uses
repeatedly (`ApprovalPreview.files`, `AuditPushPayload.paramsWhitelisted`).

**TUI**: a new pure `resolveChatTurnDisplay()` (`apps/tui/tui-state.ts`,
6 unit tests) decides what to show per turn — every turn defaults to
`summary ?? text`; a new `d` key, scoped to the **most recent assistant
turn only** (a deliberate simplification over a per-turn expand state
for a whole thread), toggles that one turn between its summary and its
full text, with a hint line (`"more detail — d for full report"`)
appearing only when there's genuinely something to expand.

**Dashboard**: `renderConversation()` renders a turn with a real,
distinct summary as two sibling spans (`.chat-turn-summary` visible,
`.chat-turn-full` hidden) plus a `▸ full report` toggle button that
swaps their visibility client-side — deliberately not via an HTML
attribute (`escapeChat()` is safe for text-node content but doesn't
escape quote characters, so it isn't safe for a `"..."` attribute
value; a turn containing a literal `"` would have broken out of a
`data-*` attribute).

**Live-verified against a real Gemini deployment**, a genuinely
isolated scratch stack (mcp:http + devops-agent + orchestrator,
confirmed via `/healthz` → `"agents":1`) — the decisive reproduction of
the originally reported bug: a real `dockerize` request against a
deliberately bad path reached a genuine approval, rejected via the real
`POST /tasks/:id/reject` endpoint (producing a real, recorded
`{status:"failed", error:"Rejected by user"}` task); asking `"thanks"`
in that same conversation then produced
`buildConversationAnswer()`'s own text **verbatim, no `\n\n`, no second
phrasing** — the exact bug, now closed, confirmed against real state,
not a mock. A separate real "what agents do you have online right
now?" question confirmed the `summary`/`text` split live: the real
stored `summary` (248 chars) was confirmed via `text.startsWith(summary)`
to be a genuine prefix of the real, full 556-char `text`. The TUI's own
collapsed rendering was live-smoked via a real-PTY capture with
injected summary/text data — clean, no corruption; the dashboard's own
new functions/CSS were confirmed present in the real generated
`/dashboard` HTML via an in-process `app.fetch()` call. **What stays
unverified, honestly, not glossed over**: an actual `d` keypress in a
real terminal, and an actual click on the dashboard's toggle button in
a real browser — neither is reachable from this implementing
environment (no raw-mode stdin, no browser backend), the same standing
gaps every TUI/dashboard interaction checkpoint in this codebase
carries at this stage.

1372 tests pass (net +9 over the pre-116 baseline — 3 new conversation-
intent tests, 1 new state/failure summary test, in
`ask-endpoint.test.ts`; 6 new `resolveChatTurnDisplay()` tests in
`tui-state.test.ts`), typecheck clean, `specs:check` passed for 116
specs. See `specs/116`'s own `verification.md` for the complete
transcript.

**Same-day correction — extended to Tier 1/2 (dispatched-task)
answers too.** Yusuf caught the identical raw-dump-after-synthesis
pattern live, against a real dispatched `analyze-project` task's own
result — this spec's own item 2 only fixed the Tier 0 `/ask` call site;
`appendAnswerWhenTaskTerminates()` (composes a dispatched task's
terminal chat answer) is a completely separate call site that also
does `synthesized ? \`${synthesized}\n\n${raw}\` : raw` and never got
the `summary` field. Fixed with the identical one-line addition —
`...(synthesized ? { summary: synthesized } : {})` — on that function's
own `newTurn()` call; no new design, since it's the only other place in
the codebase that composes `synthesized + raw`. **Zero client-side
changes needed**: both the TUI's `resolveChatTurnDisplay()` and the
dashboard's `renderConversation()` already operate generically over
every turn's own `summary` field, regardless of whether it carries a
`taskId`. Live-verified against a real Gemini deployment: a real `/ask`
dispatch of an `analyze-project` request completed, and
`appendAnswerWhenTaskTerminates()`'s own real 1-second poll loop
appended a turn whose `summary` was confirmed — via direct
`GET /conversations/:id` inspection — to be a genuine prefix of the
real, full 1410-character `text`. Not independently hermetically
tested (no existing test drives this function's own real async
execution); given the one-line reuse of already-proven infrastructure,
live verification alone was judged proportional to the risk. See
`specs/116`'s own `verification.md` for the complete transcript.
