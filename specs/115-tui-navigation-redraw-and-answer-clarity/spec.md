---
id: 115-tui-navigation-redraw-and-answer-clarity
title: "TUI: Real Thread Selection, a Tab-Cycle Redraw Investigation, One Chat Answer Instead of Three, and a More Declarative Audit View"
area: tui
change_type: fix
status: implemented
verification: partial
created: 2026-09-23
updated: 2026-09-23
approved_by: Yusuf
approved_on: 2026-09-23
implemented_on: 2026-09-23
amends:
  - 012-tui-interactive
  - 044-conversational-ask-layer
  - 046-browser-conversation-operations-workspace
  - 047-tui-conversation-operations-navigation
  - 069-tui-dashboard-parity-workspace
  - 108-durable-audit-trail
  - 113-live-audit-log-dashboard
related:
  - 075-real-conversational-chat
  - 093-conversation-answer-context-blind
supersedes: []
superseded_by: []
---

# Spec: TUI: Real Thread Selection, a Tab-Cycle Redraw Investigation, One Chat Answer Instead of Three, and a More Declarative Audit View

> Status: **IMPLEMENTED, verification: partial** — see `verification.md`
> for the full record. Four issues Yusuf found live-driving
> the real TUI, bundled into one checkpoint since none needs independent
> sign-off from the others (the `specs/097` precedent for bundling
> unrelated fixes). Raised directly after two prior checkpoints
> (`specs/113`, `specs/114`) both shipped their TUI half deferred or
> unit-tested-only: *"no the main foucuse always is the tui"* — the TUI,
> not the browser dashboard, is the primary interface this project is
> judged on. That preference is recorded as a standing memory for future
> sessions in this repo and is why this spec treats every item below as
> real TUI work, not a "future phase."

## Current behavior (verified against the real code)

### 1. Conversation thread switching

`apps/tui/index.tsx`'s `renderLeftRail()` (line 565) renders the bounded
conversation list purely passively — a `<scrollbox>` with no keyboard
focus or selection state of its own. The **only** way to change the
active thread is the `[`/`]` keys (line 1347-1358), which step
**one thread at a time** through `adjacentConversationId()`
(`tui-state.ts:300`) — direction `-1` (`[`) moves toward index 0
(oldest), direction `1` (`]`) moves toward the newest. There is no way
to jump directly to a specific thread shown in the rail, and no visible
feedback in the rail itself that `[`/`]` are the way to move through it
(the footer hint `"[/] threads"` is the only pointer, easy to miss).

Yusuf's own report: *"i cant switch to another one old one so one"* and,
after this was described back to him as a UX limitation, *"it doesn't
work even so need your help"* — stating plainly that in his own use,
this isn't just cumbersome, it doesn't function. Traced through the
code, `[`/`]`'s own handler sits correctly inside `if (mode === "chat")
{ ... }`, after `resolveModeKey()` returns `null` for those keys (they
are neither a mode digit nor Tab), so nothing else should structurally
intercept them — but this cannot be confirmed without a real keypress
in a real terminal, the standing limitation this file's own comments
already document repeatedly for this exact class of problem.

### 2. Tab-cycle border/overlay corruption

Cycling through modes with Tab (`resolveModeKey()`, `tui-state.ts:415`,
Chat→Tasks→Agents→Audit→Chat) and returning to a previously-visited
mode shows border/content corruption — Yusuf: *"when i click tab and
take a round when i came back the old over appear like in the screan
somethings in the boarder getting wrong."* `resolveModeKey()` itself is
pure and shows no obvious state leak. A same-session automated
reproduction attempt (see Verification below) drove two full
Chat→Tasks→Agents→Audit→Chat cycles via a temporary, source-level
`setMode()` sequence (not real keypresses — this sandbox cannot drive
raw-mode stdin) against the real live 6/6-agent stack, reconstructed the
final terminal frame from the captured raw ANSI stream, and found it
completely clean — no stray border characters, no leftover content. This
neither confirms nor refutes the bug: the automated test bypassed the
real Tab-keypress handling path entirely (it called `setMode()`
directly, never exercising OpenTUI's own keyboard-event dispatch), and
several of this codebase's prior TUI bugs (documented across
`specs/012`/`047`/`069`) were only ever reproducible in a real terminal
emulator, never in a captured/replayed stream.

### 3. Three sections for one chat answer

For a single dispatched question, `apps/tui/index.tsx`'s chat rendering
(lines 1582-1608) currently shows, for one turn:

1. The orchestrator's own turn text (`turn.text`) — which, per
   `specs/044`'s own design, is **already**
   `${synthesized answer}\n\n${raw deterministic result}` concatenated
   into one string server-side ("never lose real data beneath a nicer
   paraphrase").
2. A separate boxed task card directly below it
   (`isLastLink && displayedTask` block, line 1591-1607) showing
   `displayedTask.result ?? displayedTask.error ?? displayedTask.text` —
   the **same raw result a third time**, independently rendered,
   `bounded()`-truncated to fit the box width.

Yusuf: *"when asking something there is three seccion, 1 orch answer 2
the agent work 3 ai answer, will need to handel that."* Confirmed by
direct code read, not a misreading — this is genuine content
duplication, not three meaningfully different pieces of information.

### 4. The Audit view should be more declarative

`specs/108`'s own TUI Audit view (mode `4`, `apps/tui/index.tsx`) is a
reduced v1: poll-on-demand (not live), `kind` rendered as plain text
(not the colored MCP/A2A/EXEC badge the dashboard's own Audit tab got in
`specs/113`), and — per `specs/108`'s own reduced-scope note — no
task-id filter, reload-only. Yusuf: *"the log audit like what i said
should be more and more declertive"* — this is the deferred TUI half of
`specs/113` that this spec's own drafting question ("draft a spec for
the TUI Audit view going live?") was originally aimed at, before the
other three issues were raised in the same message.

## Proposed behavior

### 1. Real, direct thread selection in the left rail

`renderLeftRail()` gains a real cursor: a new `railCursor` state
(index into the `chatConversations` array, independent of
`chatConversationId` — the cursor can browse without switching). Reuses
the exact interaction model the Tasks/Agents panes already establish
(`↑/↓ select · Enter details`) rather than inventing a new one:

- `Left`/`Right` arrows (chosen because `Up`/`Down` are already claimed
  by transcript scrolling in Chat mode, line 1326-1345) move the rail
  cursor by one, clamped to the list bounds — never switches the active
  conversation by itself.
- `Enter` while the rail cursor differs from the active conversation
  opens that conversation (calls the existing `openConversation()`)
  rather than opening the composer; `Enter`/`n` continue to open the
  composer exactly as today when the rail cursor already matches the
  active conversation (the common case — no regression to the existing,
  working "type a message" flow).
- The rail's own rendering gains a second visual marker distinguishing
  "cursor is here" from "this is the active thread" (today only `▶`
  for active exists) — e.g. a highlighted background on the cursor row,
  independent of the `▶`/orange-text active marker.
- `[`/`]` are kept, unchanged, as a direct-jump/legacy shortcut — this
  spec adds a second, discoverable path, it does not remove the first.
- The footer hint text is updated to name the new keys (`←/→ browse ·
  Enter open`) alongside the existing `[/] threads`.

This directly answers "it doesn't work ... need your help" with a
mechanism that does not depend on whatever is or isn't wrong with
`[`/`]` specifically — a second, independent, more discoverable path to
the same result.

### 2. Tab-cycle redraw — investigation continues into this spec's own live-verification pass

No code fix is proposed sight-unseen for a rendering bug that could not
be reproduced from this environment. `apps/tui/index.tsx`'s own render
tree is inspected once more, specifically for any place a mode's own
JSX omits a `key`/stable structure Between renders (a common cause of a
terminal-diffing library reusing the wrong node), but this spec's real
plan for this item is a live-terminal pass (see Verification) with
Yusuf actually pressing Tab through a full cycle and this session then
being handed the concrete symptom (a screenshot, or which border
character/row is wrong) to fix against — rather than guessing at a fix
for a bug nobody has been able to see the mechanism of yet.

### 3. One chat answer, not three

The boxed task-status card (line 1591-1607) is narrowed to **status and
action only** — it keeps showing the live status line (`⏸`/`✓`/`✗`/`⋯`,
agent, skill, status) and, for a still-`input-required` task, the
target/action preview line (both genuinely new information the turn's
own text doesn't carry). It **stops** rendering
`displayedTask.result ?? displayedTask.error ?? displayedTask.text` for
a terminal (`completed`/`failed`) task — that content is already
present in the turn's own `turn.text` immediately above it. This is a
rendering-only change: no server-side data changes, `turn.text` keeps
carrying the full synthesized+raw combination exactly as `specs/044`
designed it (still never losing data beneath a paraphrase) — this spec
only removes the redundant *third* copy, not either of the two genuinely
different things (the synthesized answer, and the live task-status
card while a task is still in flight).

### 4. The TUI Audit view goes live, with the same kind badge the dashboard got

Closes `specs/113`'s own deferred TUI half, applying the identical
mechanism that spec already built server-side:

- The TUI's existing SSE consumer (`apps/tui/index.tsx`'s `/events`
  reader, already used for live tool-call activity per `specs/021`)
  gains a branch for the `orchestrai.audit-event` CUSTOM event
  `specs/113` added, appending a live row to the Audit view's own state
  exactly the way the dashboard's `prependLiveAuditRow()` does — capped
  at a bounded row count, matching this file's own established
  discipline for every live list it renders.
- `kind` renders with the same three-way color distinction the
  dashboard's `KIND_LABEL` map uses (MCP/blue, A2A/green, EXEC/amber) —
  a short colored label prefix on each row, not a new column (this
  view's rows are already narrow; a full table layout is out of scope).
- "More declarative" beyond live+badged is scoped narrowly to avoid
  guessing at an open-ended request: each row also shows the target
  (tool/skill name) and caller inline, already present in the data but
  currently only shown via the raw dump — laid out as
  `<badge> <caller> → <target> · <outcome> · <duration>`, the same shape
  of information density this file's own Tasks-pane rows already use.
- Still reload-only for historical fetch on first entry (unchanged from
  `specs/108`); a task-id filter remains explicitly out of scope here
  too, per `specs/108`'s own original reduced-v1 reasoning (needs a new
  input-mode this pass doesn't add).

## Scope

In scope: left-rail cursor navigation + Enter-to-open (item 1); a
genuine live-terminal investigation pass for the Tab-cycle redraw,
fixed once its real mechanism is seen (item 2); removing the redundant
third copy of a chat answer's raw result from the task-status card
(item 3); the TUI Audit view's live SSE update + kind badge + denser
row layout (item 4).

Out of scope, explicitly: any change to how `turn.text` itself is
composed server-side (`specs/044`'s synthesis-plus-raw design is
untouched); a task-id filter for the TUI Audit view; any change to the
dashboard (already live per `specs/113`); rewriting `[`/`]` navigation
or removing it.

## Safety constraints

- **No change to any approval/dispatch mechanism.** All four items are
  rendering/navigation changes in a read-only client — no write path,
  approval gate, or task dispatch logic is touched anywhere in this
  spec.
- **The chat answer narrowing (item 3) must never remove information
  while a task is still in flight.** The task-status card keeps showing
  live status/target/action for a non-terminal task — only a
  **terminal** task's now-redundant result/error copy is dropped, and
  only because `turn.text` already carries it in full.
- **The Audit view's live append (item 4) reuses `specs/113`'s own
  already-redacted `paramsWhitelisted` payload** — no new data is
  disclosed on this surface that the dashboard's own live channel
  doesn't already carry.

## Acceptance criteria

- [x] `Left`/`Right` moves a visible rail cursor without switching the
      active thread; `Enter` on a cursor-highlighted, non-active thread
      switches to it and loads its real turns. Implemented
      (`clampRailCursor`/`moveRailCursor`/`railCursorForActive`,
      unit-tested) and code-reviewed; the rail itself only renders at
      ≥84 columns (`specs/069`'s own breakpoint), which this sandbox's
      default 80×24 PTY cannot reach — not independently confirmed
      rendering correctly at real width, same standing gap every
      wide-terminal TUI feature in this codebase carries at this stage.
      **A real, live-caught bug was found and fixed the same day**: the
      cursor-sync effect depended on `chatConversations` (a new array
      reference on every poll tick), snapping the cursor back to the
      active thread within about a second of the user moving it —
      Yusuf: *"while chosing from the threads it get me up again to the
      first one imediatly."* Fixed by depending on `chatConversationId`
      alone.
- [x] `[`/`]` continue to work exactly as before this spec — no
      regression to the existing shortcut. Unchanged code path, confirmed
      by direct diff review — this spec adds a second path, it does not
      touch the first.
- [x] A live Yusuf terminal pass through a full Tab cycle (`Tab` × 4,
      landing back on the starting mode) either reproduces the reported
      corruption with a concrete symptom this session can fix against,
      or confirms it no longer reproduces — either outcome closes this
      item, a silently-unconfirmed "probably fine" does not. **Closed
      with a real, concrete lead from Yusuf's own live pass**: *"i think
      the box in task and agant dimesion or something is deffernt from
      the chat and logs one."* Confirmed by direct code read: the
      Tasks and Agents panes' own outer boxes had NO explicit height at
      all (natural content-based sizing), while Chat/Audit's own
      scrollbox and both rails all use an explicit
      `shellRegionHeight`/`computeShellChatScrollHeight()` — exactly the
      "leftover rows from a taller previous frame never get cleared"
      bug class this file's own history (`specs/047`/`069`) already
      documents. Fixed by pinning both Tasks' and Agents' own boxes to
      the identical `shellRegionHeight` the rails already use.
      Live-confirmed via a real-PTY capture: the Tasks box (with zero
      real tasks) now extends its border to the full region height,
      matching Chat/Audit, rather than shrinking to fit its own sparse
      content as it did before this fix.
- [x] A completed/failed task's own chat turn shows the task-status card
      exactly once, with no duplicated result/error text between the
      turn's own text and the card. Implemented — the redundant
      `displayedTask.result ?? displayedTask.error ?? displayedTask.text`
      line is removed for a terminal task; not independently
      live-rendered (needs a real dispatched-and-completed chat task in
      a real terminal), but the change is a small, low-risk JSX removal
      confirmed correct by direct code review.
- [x] A still-`input-required` task's chat turn keeps showing its live
      status/target/action in the card (no regression to the
      in-flight case). Confirmed unchanged by direct diff review — only
      the terminal-status branch was touched.
- [x] The TUI Audit view shows a real live row within one event cycle of
      a real MCP/A2A call completing, with no manual reload, while the
      view is open — matching `specs/113`'s own dashboard acceptance
      criterion. Implemented, reusing the exact `orchestrai.audit-event`
      CUSTOM event `specs/113` already proved live end to end; the SSE
      wiring itself was not re-verified live in this pass (the
      mechanism is identical to what `specs/113` already confirmed
      reaches this same TUI process's `/events` consumer for tool-call
      activity) — see verification.md for what was and wasn't
      independently re-confirmed.
- [x] Each of the three real `kind` values renders with its own
      distinct color in the TUI Audit view, matching the dashboard's own
      `KIND_LABEL` mapping. Live-verified: a real-PTY capture with all
      three `kind` values injected rendered MCP/A2A/EXEC each in its own
      distinct color, correctly laid out, no overflow.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.

## Verification plan

- Unit: pure-state coverage for the new rail-cursor navigation
  (`tui-state.ts`, mirroring this file's own established
  `resolveModeKey`/`adjacentConversationId` test style), the narrowed
  chat-turn rendering logic, and the Audit view's live-append state
  update.
- Live, decisive: a real Yusuf terminal pass covering all four items —
  thread switching via the new rail cursor, a full Tab cycle
  specifically to observe item 2's own real symptom, a real completed
  chat answer showing exactly one copy of its result, and a real live
  audit row appearing during an active session.

## Non-goals

- A task-id filter for the TUI Audit view.
- Any redesign of `specs/044`'s own server-side answer-synthesis
  content or format.
- Mouse-driven rail selection (keyboard-only, matching every other
  interaction in this file).
