---
id: 047-tui-conversation-operations-navigation
title: TUI Conversation and Operations Navigation
area: tui
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-02
updated: 2026-09-06
approved_by: Yusuf
approved_on: 2026-09-03
implemented_on: 2026-09-05
amends:
  - 012-tui-interactive
  - 037-tui-approval-preview-card
  - 044-conversational-ask-layer
supersedes: []
superseded_by: []
related:
  - 021-ag-ui-event-protocol
  - 027-ag-ui-core-adoption
  - 040-approval-preview-content-diff
  - 046-browser-conversation-operations-workspace
---

# Spec: TUI Conversation and Operations Navigation

> Review gate: **APPROVED 2026-09-03 — implementation via Option C**: all five
> phases authorized, with a mandatory stop after Phase 2's exit gate for a real
> terminal check (resize/zoom, full task list, first-frame integrity) before
> Phase 3 begins. This is a terminal-only checkpoint. It does not authorize the
> browser work in spec 046. The two specs deliberately share concepts and state
> while retaining interaction patterns appropriate to each surface.
>
> **Approved Phase 2 amendment — 2026-09-03:** the implementation stop
> condition in `plan.md` found that no existing Orchestrator response exposes
> its authoritative target-project path. Yusuf approved adding an optional
> `projectPath` field to `GET /healthz`. This is an additive, backward-compatible
> response extension; the TUI renders `project unavailable` when connected to
> an older server that omits it. No new endpoint or second source of truth is
> introduced.
>
> **Approved approval-UX amendment — 2026-09-03:** real-terminal testing found
> that the first-generation Chat presentation confused a task that *might*
> eventually dispatch a write with one that was *currently waiting* for human
> approval, and retained that message after a no-step plan had completed. Yusuf
> approved deriving approval wording only from authoritative `input-required`
> task state and allowing the existing `a`/`r` two-press decision directly from
> Chat when the current conversation resolves to exactly one waiting task and
> its exact approval preview is visible. Zero or multiple waiting candidates
> cannot be decided from Chat and must be reviewed in Tasks. No approval
> endpoint, `actionId` binding, or confirmation strength changes.

## Purpose

Replace the TUI's hard-to-discover `k` chat shortcut and vertically stacked
Agents/Tasks operating screen with an explicit, terminal-native three-mode
workspace:

```text
[1 Chat]   [2 Tasks]   [3 Agents]
```

Each mode owns the full content viewport. Chat is for intent and follow-up,
Tasks is for execution/review/approval, and Agents is for capability/health.
Nothing becomes a third box. The design must improve discoverability without
reintroducing the terminal overflow, first-frame corruption, or accidental
approval problems recorded across specs 012 and 037.

### Sequencing with spec 044

Spec 044 is currently `implemented` / `verification: partial` for exactly one
reason: its first-generation `k` Chat view has not been visually exercised in a
real interactive terminal. If this spec is approved, do not spend a separate
cycle certifying that soon-to-be-replaced view. Spec 047's real-terminal matrix
is a strict superset of that open check. When 047 passes, update 044's record to
state that its original open TUI criterion was closed by the amended interface
and mark 044 `verification: verified`. Until then, 044 remains honestly partial.

## Verified Current State

- `apps/tui/index.tsx` normally renders Agents and Tasks as two stacked bordered
  boxes, with a conditional third Details/Agent/Input box below them.
- Spec 044 added Chat as an early-return full-screen view opened with `k`
  (“asK”) because the obvious single-letter shortcuts were already occupied.
  This preserves the row budget but makes the primary conversational surface
  invisible unless the user opens Help.
- Chat currently shows only the last 12 turns, flattens multi-line output to a
  300-character line, and has no scrollbox or conversation picker even though
  the server retains up to 100 turns and exposes up to 50 conversations.
- A Tier 1 question only prints that approval is needed. The user must escape
  Chat, find the task, select it, and then use the existing `a`/`r` two-press
  confirmation without a direct visual relationship to the originating turn.
- The current Tasks view has mature behavior that must survive: bounded newest-
  task following, manual pause/resume, agent filtering, origin markers, inline
  step/tool badges, detail scrollbox, approval preview, `v` raw JSON, `a`/`r`
  two-press confirmation, clear/undo, and hide-done.
- A previous attempt to assign explicit numeric root width/height from terminal
  dimensions corrupted the first render. The working root intentionally relies
  on Yoga's natural size; this checkpoint must not repeat that approach.
- The conversation turn response already includes a task link server-side, but
  the TUI's local `ChatTurn` interface does not retain `taskId` today.

## Revisions Since Drafting — 2026-09-03

This spec was drafted on 2026-09-02, before spec 046 was implemented. Three
things learned since materially change it. All were re-confirmed against the
current code, not carried over from the browser work by assumption.

### (a) A plan's approval lives on a **child** task — the largest correction

Spec 046's **Amendment 1** was a real, live-found bug: a `plan-task`'s own root
task **never reaches `input-required`** — only the children it dispatches one at
a time do (specs/028/038). The browser's chat card watched only the root task's
own `.status`, so a genuine, correctly-gated approval was *invisible* in the
chat surface. The gate was never bypassed; it just could not be seen or reached
from where the user was looking.

**Section 4 below, as originally drafted, would reproduce that exact bug in the
TUI.** It says "when a linked task reaches `input-required`" — but since spec
038 made the adaptive supervisor the default `plan-task` planner, a substantive
chat request routinely produces a *plan*, whose linked task is the root. Verified
in the current code, not assumed:

- `apps/orchestrator/index.ts:72` — `childTaskIds?: string[] // set on parent
  plan tasks`, already served by the `GET /tasks` the TUI already polls.
- `apps/tui/index.tsx:52-60` — the local `TaskRow` interface retains `isPlan`
  and `parentTaskId` but **not** `childTaskIds`, so the TUI currently has no way
  to find the waiting child even though the data already arrives.

So this spec must carry the same fix, in terminal-native form: a linked turn
whose task `isPlan` resolves its **currently-waiting child** and surfaces *that
child's* approval attention card, with `2` opening Tasks on the **child's exact
ID**. This strengthens rather than weakens the existing "never infer 'latest
task'" constraint: the lookup selects the specific child whose status is
`input-required`, never "the newest child" or "the plan itself."

### (b) Real-terminal verification is now partly automatable

When this spec was drafted, every real-terminal check was necessarily Yusuf's to
run. As of 2026-09-03 a PTY harness (`node-pty`, scratch-only, never a project
dependency — the same "temporary automation tool" pattern used for the browser)
can spawn the real TUI attached to a genuine pseudo-terminal, send real
keystrokes, and capture what it actually renders. Demonstrated live on the
current TUI: boot render, `?` opening the real Help overlay, and `Tab` genuinely
moving the `▶` focus marker between panes.

This does **not** replace Yusuf's own terminal. It closes the *behavioral* half
(key routing/ownership, mode switching, exact linked-task selection, scroll
pause/resume, disconnect state, small-viewport fallback) with real evidence,
leaving the *visual* half — layout, spacing, wrapping fidelity, and the
row-overflow/first-frame corruption class that specs 012's sixteen rounds proved
needs human eyes — explicitly still his. Captured buffers lose some inter-cell
whitespace when ANSI positioning is stripped, so they are honest evidence of
behavior and weak evidence of appearance. The Verification Plan below is split
accordingly.

### (c) One browser lesson deliberately does **not** transfer

Spec 046's **Amendment 2** ended with adding `console.error` to a silently
swallowing `catch {}`. The TUI has six bare `catch {}` blocks, but that fix must
not be copied here: this process owns the rendered screen, so writing to the
console would corrupt the very display being debugged. Any TUI diagnostic
equivalent belongs in a visible status line or a log file, not stdout — and is
out of scope for this checkpoint either way. Recorded so a future reader does
not "fix" it by analogy.

## Research Basis — Principles, Not Product Copying

The following primary sources were reviewed on 2026-09-02:

- [Gemini CLI keyboard shortcuts](https://google-gemini.github.io/gemini-cli/docs/cli/keyboard-shortcuts.html)
  uses predictable Escape/cancel behavior, arrows for history/navigation, and
  reserves Tab for input completion. Principle adopted: global navigation must
  be mode-aware and must not steal keys while the composer is focused.
- [Claude Code's CLI reference](https://code.claude.com/docs/en/cli-usage)
  exposes explicit continue/resume session paths and distinct permission modes.
  Principle adopted: users need an obvious current-thread identity and a clear
  distinction between conversation and permission. Not copied: commands,
  permission modes, or Claude's screen layout.
- [OpenTUI ScrollBox documentation](https://opentui.com/docs/components/scrollbox/)
  already defines Arrow, Page Up/Down, Home, and End scrolling plus sticky-edge
  behavior. Principle adopted: use the framework's scroll model rather than a
  second custom slicing model for conversation history.
- [Traycer's public repository](https://github.com/traycerai/traycer) distinguishes
  an underlying agent/task session from the Chat or Terminal interface used to
  interact with it. Principle adopted: browser and terminal must reference the
  same conversation/task IDs. Not copied: Traycer's host, agents, boards, or UI.
- OrchestrAI's own specs 012 and 037 are the strongest local evidence: terminal
  row budgets, resize behavior, detail overlays, and double-key approval were
  learned through repeated live failures. Those constraints take priority over
  attractive external patterns.

## Product Interaction Model

### 1. Three full-screen modes, one consistent header

The top two rows are stable across normal modes:

```text
OrchestrAI   [1 Chat]   2 Tasks   3 Agents        ● live · 5 agents
project: C:\target\project                         approvals: 1
```

- Chat is the initial mode so the primary product action is discoverable.
- `1`, `2`, and `3` switch directly; `Tab` and `Shift+Tab` cycle modes only when
  no input or overlay owns focus.
- While a composer/input is focused, printable keys and Tab belong to that
  control. Global mode shortcuts do not fire. `Esc` first cancels the active
  input/overlay, never silently changes mode and never approves/rejects.
- `?` opens the existing full-screen Help view from any normal mode and returns
  to the previous mode when closed.
- The header uses brackets/text plus color for active/live/approval state; color
  alone never carries meaning.
- Do not set explicit root width/height from first-render terminal dimensions.

### 2. Chat mode — scrollable conversation, fixed composer

Chat owns one full-height content area split internally into:

```text
current thread + thread navigation
----------------------------------
scrollable transcript
----------------------------------
composer / status line
```

- Retain and render the server-bounded thread (up to 100 turns) inside an
  OpenTUI `scrollbox`; remove the 12-turn rendering slice.
- Normal scrolling uses Arrow, Page Up/Down, Home, and End. Sticky-bottom follow
  is active only while already at the bottom. Scrolling up pauses follow and
  shows `[new updates — End to follow]` when later turns arrive.
- Preserve line breaks and wrap safely within the viewport. Long raw task output
  remains in Task details; assistant summaries are not arbitrarily flattened
  into one 300-character line.
- `n` or Enter (when no interactive card/overlay is selected) opens the composer;
  Enter submits; Escape cancels; empty input does nothing. Multi-line editing,
  autocomplete, attachments, and shell mode are not introduced here.
- `c` starts a new thread only after a short visible confirmation if the current
  thread has turns. `[` and `]` move through the bounded server conversation
  list without losing or merging thread identity. The header shows a short
  thread ID and position such as `thread 3/8`.
- Unknown/evicted threads show a clear state and offer a new thread; they never
  fall through to a different conversation.

### 3. Linked task cards without turning Chat into a log viewer

Extend the local `ChatTurn` representation to retain `taskId`. A turn linked to
a task renders a compact, maximum-three-row card:

```text
✓ Testing Agent · check-coverage · completed
  4 tests · line coverage 100%
  [2] open in Tasks
```

- The card is sourced only from the real task/event state and updates in place.
- It shows agent, skill, text status, and one bounded current/final summary. It
  does not stream every audit line into the transcript.
- Switching from a linked card to Tasks selects that exact task. Returning to
  Chat restores the same thread and scroll position.
- If the task was evicted/unavailable, the card says so and retains its task ID;
  it does not point at the newest task instead.

### 4. Approval is visible and can be executed safely in Chat or Tasks

When a linked task reaches `input-required`, Chat renders a bounded attention
card with the exact existing preview's target, action, and first risks, plus:

```text
[2] review in Tasks — approval required
```

Pressing `2` from that state opens Tasks with the linked task selected and its
existing full Details approval preview visible. When the current conversation
resolves to **exactly one** waiting approval, pressing `a` or `r` in Chat opens
that exact task's approval preview in a replacement overlay; pressing the same
key a second time within spec 037's existing confirmation window sends the
decision. `Esc` cancels the preview and never decides. The preview must show the
exact target and action before the confirming press.

If the current conversation resolves to zero or more than one waiting approval,
Chat must not bind `a`/`r` to a task. With multiple candidates it explains the
ambiguity and directs the user to Tasks. This is an exact-ID rule, not a
"newest" or "most recent" fallback.

**A linked plan resolves to its waiting child** (see Revisions (a) above). When
the linked task `isPlan`, the attention card is sourced from the child whose
status is `input-required` — found by scanning that plan's own `childTaskIds`
for the exact waiting entry, never by taking the newest child or falling back to
the plan itself. The card names which step is waiting, and `2` opens Tasks on
**the child's** exact ID:

```text
⏸ plan · step 2 of 4 · dockerize — approval required
  target: C:\target\project\Dockerfile
  [2] review in Tasks
```

If a plan has no currently-waiting child, no attention card is shown — a plan
mid-execution is not an approval state. Requires retaining `childTaskIds` on the
TUI's local `TaskRow`; the field already arrives on the existing `GET /tasks`
poll, so this adds no endpoint, no protocol change, and no second source of
truth.

This remains terminal-native rather than copying the browser's pointer-friendly
buttons. It reuses the same exact `taskId`/`actionId`, preview content, and
two-press interaction already used in Tasks. Chat never approves a “latest”
implicit task and never binds `a`/`r` without one unambiguous waiting task and a
visible preview.

After approval or rejection, the Chat card updates to the decision/outcome and
remains part of the thread.

### 5. Tasks mode — the existing operational behavior, with more room

Tasks becomes its own full-screen list rather than sharing height with Agents:

- preserve newest-follow/pause, bounded 30 rows, origin markers, plan/tool
  badges, hide-done, clear/undo, and any active agent filter;
- preserve `n` as New Task in this mode only;
- preserve Arrow selection, Enter details, `a`/`r` ×2, and `v` raw approval;
- render Details as a full-screen overlay or a size-bounded region replacing the
  list, never a third stacked box;
- expose `Back to thread` for a task with a still-live conversation, restoring
  that Chat scroll position.

Opening Tasks from a Chat card must select by exact task ID even if sorting,
filters, or new events changed while the user was in Chat. If an active filter
would hide it, temporarily explain and clear/bypass that filter rather than
silently selecting a different row.

### 6. Agents mode — capability and filtering

Agents becomes its own full-screen list:

- preserve online/offline state, URL, advertised skills, agent details, and live
  discovery refresh;
- Arrow selects, Enter opens details, `f` filters Tasks to the selected agent and
  switches to Tasks with a visible filter banner;
- Agent Card strings are displayed as bounded plain text;
- this view never claims an advertised skill is permission or proof of identity.

### 7. Small terminals and failure states

- Define and test a minimum supported viewport (recommended acceptance target:
  80×24). Below it, render a single clear “terminal too small” view with current
  dimensions and required minimum; do not attempt a corrupted partial layout.
- At supported sizes, reduce secondary metadata before shortening safety-
  critical target/action/status text.
- Disconnected state remains visible in every mode. Existing data stays
  inspectable; write decisions are disabled until the Orchestrator is reachable.
- Loading, empty, failed, rejected, waiting approval, and reconnecting each have
  distinct text—not spinner/color-only states.

## Shared Cross-Surface Contract with Spec 046

Browser and TUI share:

- the labels `Chat`, `Tasks`, `Agents`;
- conversation and task IDs from the existing server stores;
- status/tier terminology and deterministic source;
- the exact approval preview and server endpoints;
- one model: Chat references work, Tasks explains and controls it.

They deliberately do **not** share layout code, approval gestures, responsive
rules, or shortcut mechanics. Visual similarity is secondary to correct native
interaction on each surface.

## Implementation Shape

- Keep the current OpenTUI/React stack and one `App`; no new dependency or TUI
  framework.
- Introduce an explicit mode state (`chat | tasks | agents`) and small pure
  reducers/helpers for key ownership, linked-task selection, and scroll-follow
  state so the behavior is testable without a real terminal. **Phase 1 of
  this (commit `2c8018f`) is done**: `apps/tui/tui-state.ts` +
  `apps/tui/tui-state.test.ts` hold the pure task-filtering, row-budget,
  key-ownership, confirm-press, and plan-child-resolver logic, all wired
  into `apps/tui/index.tsx` and verified byte-identical via a live PTY run.
  `plan.md`'s own Phase 1 section and its "PTY Verification Harness"
  section are the authoritative, reproducible record of what exists and how
  to verify further changes the same way — read those before writing
  Phase 2+ code, especially if picking this up in a different session.
- Reuse one existing task/agent/conversation/event cache. Mode switches do not
  create independent poll loops or event subscriptions.
- Use OpenTUI's scrollbox behavior for transcript/details. Do not make render
  hooks responsible for application state.
- Preserve the current `import.meta.main` guard and standalone-binary behavior.

## Safety and Compatibility Constraints

- **Approval wording follows actual state.** A tier or write-capable
  classification may say work *can* require approval; only an authoritative
  linked task/plan child whose status is `input-required` may say approval is
  required. Terminal completion clears pending presentation.
- **Chat approval is exact and unambiguous.** It reuses `a`/`r` ×2 and the real
  approval endpoint only when one current-conversation waiting task is resolved
  by exact ID and its preview is visible. Zero/multiple candidates cannot be
  decided from Chat.
- **Never infer “latest task.”** Cross-mode focus is by exact `taskId`.
- **Input owns keys.** Global navigation/approval shortcuts are unreachable while
  an input component is focused.
- **Escape never decides.** It cancels/closes only.
- **Target stays visible.** The project target is in the global header and the
  exact write target remains first in the approval detail.
- **No hidden overflow.** No third stacked box; bounded rows and explicit small-
  terminal fallback.
- **No color-only meaning.** All state has symbols/words.
- **Server contracts unchanged except for the approved additive health field.**
  `GET /healthz` may expose the Orchestrator's authoritative `projectPath` for
  the shared header. The TUI remains a client of existing endpoints and AG-UI
  events; it cannot create a second conversation/task truth.
- **No new dependency.** Any need for one returns the draft for review.

## Scope

- `apps/tui/index.tsx` mode/navigation, Chat scroll/thread selection, linked task
  cards, exact cross-mode selection, full-screen details, and small-screen state.
- Pure TUI helpers and focused tests for key ownership, navigation, scroll follow,
  linked task selection, filter conflict, and layout budgeting.
- Existing approval-row tests extended only where full-screen Tasks detail moves.
- Real interactive-terminal verification across Windows Terminal/PowerShell and
  at least one alternate terminal path available to Yusuf.
- Documentation/worklog updates after verified implementation.

## Out of Scope / Non-Goals

- Browser implementation; that is spec 046.
- Weakening the ×2 confirmation or permitting an implicit/latest-task Chat
  decision.
- Conversation/task persistence, synchronization, auth, or multiple users.
- Mouse-first interactions, images, Markdown rendering, syntax highlighting,
  attachments, autocomplete, multiline editor, or shell mode.
- Copying Claude Code, Gemini CLI, Codex, Traycer, or another application's
  command names/layout.
- Changing routing, execution, approval tiers, Agent Cards, MCP tools, AG-UI
  schema, or task protocol. This amendment corrects TUI presentation from real
  task state; it does not reclassify `plan-task` or redefine the `/ask` tier.
- Token-by-token provider streaming or hidden model reasoning.
- Retiring Planning Agent under spec 038 Phase 2.

## Acceptance Criteria

- [ ] Yusuf explicitly approves this spec before implementation.
- [ ] TUI starts in Chat and visibly exposes `[1 Chat] [2 Tasks] [3 Agents]`;
      no hidden `k` knowledge is required.
- [ ] `1`/`2`/`3` and Tab/Shift+Tab navigate only when no focused input/overlay
      owns the key; Help documents the exact precedence.
- [ ] Chat renders the current server-bounded transcript in a scrollbox, preserves
      line breaks, and no longer hard-slices to 12 or flattens to 300 characters.
- [ ] Arrow/Page/Home/End work; scroll-away pauses following; a visible new-
      update state returns to sticky bottom without losing position.
- [ ] A user can create, identify, and move among bounded in-memory threads with
      no context merge and clear handling of an evicted thread.
- [ ] Every linked turn retains exact `taskId` and renders one bounded live task
      card; opening Tasks selects precisely that task.
- [ ] `plan-task` or another write-capable classification is not presented as
      currently needing approval unless its linked task/plan child is actually
      `input-required`; terminal completion removes the running indicator.
- [ ] One exact linked pending write displays target/action/approval-needed in
      Chat and supports the existing `a`/`r` ×2 flow after showing its preview;
      `2` still opens the complete Tasks review with `v` raw JSON.
- [ ] Zero or multiple waiting approvals disable Chat decisions and explain how
      to continue in Tasks; no latest-task inference occurs.
- [ ] A linked **plan** whose dispatched child is `input-required` surfaces that
      child's approval in Chat (naming the waiting step) and `2` selects the
      **child's** exact task ID — never the plan's, never the newest child.
      A plan with no waiting child shows no approval card. This is the specific
      spec 046 Amendment 1 regression, verified here against a real dispatched
      plan rather than by analogy to the browser fix.
- [ ] Approval/rejection outcome updates the linked Chat card and does not mutate
      or hide the task's raw result/preview.
- [ ] Tasks preserves all current list, follow, filter, origin, badge, new-task,
      detail, clear/undo, hide-done, approval, and raw-view behavior.
- [ ] Agents preserves live status/details and can apply an exact visible filter
      to Tasks without selecting the wrong task.
- [ ] Details/input/help are replacement overlays or bounded regions, never a
      third stacked box; no explicit root dimensions recreate the known first-
      frame bug.
- [ ] At 80×24 and larger, full/empty/long states do not overflow or corrupt; a
      smaller viewport shows a clear minimum-size state.
- [ ] Disconnect disables write decisions while leaving cached information
      inspectable; reconnect restores live updates without duplicate listeners.
- [ ] Focused unit tests plus `bun test`, `bun run typecheck`,
      `bun run specs:check`, and `bun run build` pass.
- [ ] **PTY-harness verification** (automatable, mine to run) covers key
      ownership/routing, mode switching, exact linked-task and plan-child
      selection, scroll pause/resume, disconnect state, and the below-minimum
      viewport state, with captured buffers recorded as evidence.
- [ ] **Real-terminal verification by Yusuf** (not substitutable by the PTY
      harness) covers zoom/resizing, layout and wrapping under a full task list
      and long thread, first-frame integrity, and a controlled write reaching
      the full preview then rejected with an unchanged target fingerprint.
- [ ] After all TUI criteria pass, spec 044's sole remaining interactive-TUI
      gap is documented as closed by this amendment and 044 moves to
      `verification: verified`; it is not closed earlier by code inspection.

## Verification Plan

- **Pure key-state tests:** normal mode versus composer/help/detail/Chat approval
  preview; direct and cyclic navigation; Escape precedence; approval keys
  unreachable in input and safe for zero/one/multiple Chat candidates.
- **Pure selection tests:** linked task ID across sorting/new events/filters;
  missing task; return-to-thread restoration; exact agent filter; plan-child
  resolution (the one waiting child among completed/pending siblings, `null`
  for a non-plan and for a plan with no waiting child, and the child's — not
  the plan's — ID used for selection), mirroring the browser's own
  `findWaitingPlanChild` coverage in `apps/orchestrator/ask-endpoint.test.ts`.
- **Pure scroll/layout tests:** sticky bottom, pause/new-update/End resume, 100
  turns, wrapped multi-line content, 80×24 boundary, below-minimum state.
- **Regression tests:** existing origin markers, row budgeting, newest-follow,
  clear/undo, hide-done, approval rows/raw view, and direct-agent polling.
- **PTY harness (mine):** spawn the real TUI under a pseudo-terminal at fixed
  sizes (including exactly 80×24 and one below-minimum size), send real
  keystrokes, and capture rendered buffers as evidence — mode switching, key
  ownership while a composer is focused, `Esc` precedence, zero/one/multiple
  Chat approval behavior, exact plan-child selection against a genuinely
  dispatched plan, and scroll pause/resume. Honest limitation, stated up front:
  stripped-ANSI capture loses some inter-cell whitespace, so these prove
  behavior, not appearance.
- **Real terminal (Yusuf's, not substitutable):** Windows Terminal/PowerShell
  first; start/resize/zoom, layout under a full task list and long wrapped
  thread, first-frame integrity, disconnect/reconnect, and a controlled write
  reaching the full preview then rejected with an unchanged target fingerprint.
  This is where specs 012's row-overflow and first-frame-corruption failure
  class was found every previous time; the harness above does not retire it.
- **Repository gates:** full tests, typecheck, governance, build, compiled-binary
  interactive smoke, no orphaned processes, and `git diff --check`.

## Approval Requested

Approval authorizes only the TUI work above: three explicit full-screen modes,
Chat-default navigation, framework-native transcript scrolling, bounded thread
selection, linked task cards and exact Tasks focus, full-screen details, small-
terminal handling, tests, live verification, and documentation.

It does not authorize browser work, a weakened approval gesture, implicit/latest
task decisions, dependencies, persistence/auth, protocol/routing/tier changes,
Planning retirement, or copying another terminal product.
