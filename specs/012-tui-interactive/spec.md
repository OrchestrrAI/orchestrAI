---
id: 012-tui-interactive
title: Interactive TUI — Approve, Reject, and Submit from the Terminal
area: tui
change_type: enhancement
status: implemented
verification: partial
created: 2026-08-08
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-08
implemented_on: 2026-08-09
amends:
  - 010-tui-cli
supersedes: []
superseded_by: []
related:
  - 010-tui-cli
---

# Spec: Interactive TUI — Approve, Reject, and Submit from the Terminal

> Status: **APPROVED by Yusuf on 2026-08-08 ("ok implement") with the
> proposed defaults: double-press-confirm for approve/reject, `n` as the
> new-task hotkey. Implemented and polished across several rounds based on
> Yusuf's live-screenshot feedback; most recently extended on 2026-08-09 to
> add agent-pane interaction ("can i choese between the agants ?" → "the
> three of them"). Results recorded in Verification Results below.**

## Purpose

`apps/tui` (specs/010-tui-cli/spec.md) is a live, read-only viewer today —
agents pane, tasks pane, connection status, confirmed working in Yusuf's own
Windows terminal. This spec adds the three actions intentionally left out of
that checkpoint: **approve**, **reject**, and **submit a new task**, all from
the terminal, without opening a browser.

## Verified Current Behavior

- `apps/tui/index.tsx` currently contains **no non-`GET` `fetch()` call at
  all** — that was v1's structural safety proof (`specs/010-tui-cli/spec.md`'s
  own acceptance criteria verified this by code review, not just intent).
  This spec necessarily removes that specific guarantee; see Safety
  Reframing below for what replaces it.
- The Orchestrator's approve endpoint already does the actionId bookkeeping
  itself — confirmed by re-reading `apps/orchestrator/index.ts`'s
  `POST /tasks/:id/approve` handler: it reads `task.approval.actionId` from
  its own stored state and forwards that to the owning agent. **The caller
  does not need to supply an actionId at all.** The same is true for
  `POST /tasks/:id/reject`. This materially simplifies this spec: the TUI
  only ever needs to know a task's `id`, never its `actionId`.
- `OrchestraiMcpClient`/agent-level approval flows are unaffected by
  anything in this spec — the TUI talks to the Orchestrator exactly the way
  the browser dashboard already does, over the same existing endpoints, with
  the same existing server-side enforcement.
- OpenTUI (`@opentui/core`/`@opentui/react`, already a dependency) supports
  keyboard input (`KeyHandler`, `useAppContext()`) and a text-input component
  (`InputRenderable`, exposed as `<input>`) — confirmed present in the
  installed package's type declarations, not assumed.

## Safety Reframing

v1's safety property was "this file cannot possibly act, full stop." That
specific property is retired by this spec's own purpose. What replaces it:

- The TUI becomes **exactly as privileged as the browser dashboard** — a
  local client of the same already-approval-gated Orchestrator endpoints,
  with the same server-side `actionId` enforcement, the same duplicate/stale
  rejection rules, and no new server-side capability introduced anywhere.
  Nothing in this spec adds a new endpoint or loosens an existing one.
- The TUI only ever operates on tasks it already displays (via the same
  `GET /tasks` it already polls) — it cannot approve/reject a task it
  doesn't know about, and it cannot forge or guess an `actionId` because it
  never needs one (see above).
- Scope stays fixed to **Orchestrator-level tasks only**, matching v1 — no
  direct per-agent dashboard equivalents (DevOps/Testing/Documentation's own
  task lists) are added to the TUI's view or action surface in this spec.

## Proposed Design

### Row selection

- Arrow keys (`↑`/`↓`) move a highlighted selection through the tasks pane.
- Selection is visual only (a background/border highlight) until an action
  key is pressed — no action fires from navigation alone.

### Approve / Reject — double-press confirmation

The browser dashboard's Approve/Reject are single clicks with no
confirmation step. A terminal hotkey is easier to fat-finger than a mouse
click aimed at a specific button, and reject in particular is irreversible
with no undo. Proposed: **press the hotkey twice within 1.5 seconds to
confirm**, matching a common terminal-UI pattern (e.g. "press `q` twice to
quit") rather than building a full modal dialog:

- `a` `a` (within 1.5s) on a selected `input-required` task → approve.
- `r` `r` (within 1.5s) on a selected `input-required` task → reject.
- A single press shows a one-line "press again to confirm" hint in the
  status line; the confirmation window resets if a different key is pressed
  or the selection changes.
- Both call the Orchestrator's existing endpoints with **no body required**
  (per the verified behavior above — the Orchestrator supplies its own
  stored `actionId`): `POST /tasks/:id/approve`, `POST /tasks/:id/reject`.
- Pressing the hotkey on a task that isn't `input-required` does nothing
  (no error, just a no-op — matches how the browser dashboard doesn't even
  render Approve/Reject buttons for non-pending tasks).

### Task submission

- A dedicated input mode, entered with a hotkey (proposed: `n` for "new
  task", or `/` — Yusuf's preference) that focuses an `<input>` box at the
  bottom of the screen, matching the existing agents/tasks panes visually.
- `Enter` submits via the same `POST /tasks {text}` the browser dashboard's
  "Send Task" box already uses; `Esc` cancels and blurs without submitting.
- While the input is focused, arrow keys and approve/reject hotkeys are
  suspended (text entry takes priority) — prevents e.g. typing "war" from
  accidentally triggering a stray reject confirmation.

### Status/feedback line

- A one-line toast-equivalent (no modal) showing the result of the last
  action ("Approved task-xyz", "Rejected task-xyz", "Submitted", or an error
  message) for ~2 seconds, mirroring the browser dashboard's toast pattern
  in spirit.

## In Scope

1. Keyboard row selection in the tasks pane.
2. Double-press-confirm approve/reject hotkeys, calling the Orchestrator's
   existing endpoints with no new client-side actionId handling.
3. A task-submission input mode calling the Orchestrator's existing
   `POST /tasks`.
4. A status/feedback line for the outcome of the last action.
5. Updated `specs/010-tui-cli/spec.md` cross-reference noting this supersedes
   its "approve/reject/submission" out-of-scope items specifically (nothing
   else in that spec changes).

## Out of Scope

- Direct per-agent (non-Orchestrator) task lists or actions.
- Plan-step visualization/drill-down (multi-step plan trees).
- Any new server-side endpoint, approval mechanism, or relaxation of
  existing `actionId`/duplicate-ID rules — this spec is a new client only.
- SSH-served or remote TUI sessions.
- Replacing the browser dashboards as the primary interface — this remains
  an equally-capable terminal alternative, not a replacement.
- Switching the tasks pane from polling to true SSE (tracked separately in
  `specs/010-tui-cli/spec.md`'s own follow-ups; unrelated to interactivity).

## Acceptance Criteria

- [x] Yusuf approves this spec ("ok implement"), with the proposed defaults:
      double-press-confirm, `n` for the input-mode hotkey.
- [x] Code implemented: arrow-key row selection, `a`/`r` double-press
      confirm (1.5s window) calling the Orchestrator's existing
      approve/reject endpoints with no client-supplied `actionId`, `n` to
      open a task-submission `<input>`, a status/feedback line.
- [ ] **Not live-tested this session — genuinely needs Yusuf's hands, not
      mine.** Everything keyboard-driven (arrow-key nav, the double-press
      confirm, focusing the input, typing into it) requires an actual
      interactive terminal session with real keypresses. This session's
      sandboxed shell has no TTY to send keystrokes into — the same
      structural limitation as `specs/010-tui-cli/spec.md`'s original Windows
      render check, now extended to interaction, not just rendering.
- [x] Confirmed via a piped, non-interactive render (bounded by `timeout`,
      no crash): the TUI starts, connects to a live Orchestrator, and
      correctly displays a real `input-required` task (`dockerize`) with
      the right status — proves the rendering/data path introduced no
      regression, but proves nothing about keyboard interaction itself.
- [x] `bun test` remains fully green — 104 pass, 0 fail (unaffected; this is
      new TUI-side code with no existing logic touched).
- [ ] Manual check from Yusuf needed: arrow-key selection visibly moves;
      single `a`/`r` shows the confirm hint and does nothing; second press
      within 1.5s actually approves/rejects; `n` opens the input box and
      typing + Enter submits a real task; Esc cancels cleanly; input mode
      correctly suspends the other hotkeys.

## Verification Results (2026-08-08)

- `bun test`: 104 pass, 0 fail, 168 expectations, 12 files — unchanged from
  before this checkpoint, as expected for TUI-only code.
- Bundle check (`bun build apps/tui/index.tsx --no-bundle`) transpiled
  cleanly.
- Live, piped render check against a real `bun run dev` stack with one
  genuine `input-required` `dockerize` task submitted: the TUI displayed it
  correctly with the right status color, no crash, clean exit.
- **Explicitly not verified**: any actual keyboard interaction. This is a
  real gap in this session's verification, not glossed over — flagged the
  same way the original Windows rendering check was flagged until Yusuf
  confirmed it directly.

## Extension (2026-08-09): Agent-pane interaction

Yusuf asked "can i choese between the agants ?" ("can I choose between the
agents?"). Clarified via three options, all three requested ("the three of
them"):

1. **Filter the Tasks pane by a selected agent.**
2. **See an agent's full details** (URL, full skill list, live status).
3. **Target a new task at a specific agent directly**, bypassing the
   Orchestrator's automatic keyword routing.

### Design implemented

- `Tab` toggles which pane (`agents`/`tasks`) has keyboard focus; the
  focused pane is highlighted (`▶` marker + heading color) and receives
  `↑`/`↓` navigation. This was necessary because arrow keys previously only
  ever moved the tasks-pane selection — a second navigable pane needed its
  own selection state (`selectedAgentIndex`) and a way to route key events
  to the right one.
- **Agent details**: `Enter` while the Agents pane is focused opens a detail
  box (name, status, full URL, full skill list) — reusing the exact data
  already in the polled `GET /agents` response, so unlike task details this
  needs no extra fetch. `Enter` or `Esc` closes it, matching the existing
  task-detail convention.
- **Filter by agent**: `f`, while the Agents pane is focused with an agent
  selected, toggles `agentFilter` to that agent's name (press again on the
  same agent to clear it). The Tasks pane heading and empty-state text
  reflect the active filter; the underlying task list still comes from the
  one existing `GET /tasks` poll — filtering is client-side only, no new
  endpoint or query parameter.
- **Direct-to-agent submission**: when `agentFilter` is active, `n` still
  opens the same input box, but the prompt text says "→ `<agent>` (direct,
  bypasses Orchestrator)", and submission goes straight to that agent's own
  `POST /` endpoint (the exact envelope shape — `{id, message: {role:
  "user", parts: [{text}]}}` — every agent already accepts, the same shape
  the Orchestrator itself sends downstream) instead of the Orchestrator's
  `POST /tasks`. The client-chosen id follows the browser dashboards' own
  existing convention (`` `tui-${Date.now()-based counter}` ``), not
  `crypto.randomUUID()` — consistent with CLAUDE.md's policy that the
  randomUUID requirement applies to *producer*-generated IDs, not
  client-chosen submission IDs.
  - **Known, deliberate limitation**: a directly-submitted task will not
    appear in the TUI's own Tasks pane, since that pane only ever polls the
    Orchestrator's `GET /tasks`, and a direct submission never touches the
    Orchestrator. Only a one-line status-bar confirmation (with the
    returned task id) is shown. Documented in-code and here rather than
    silently surprising a user who expects to see the row appear.
- `a`/`r` approve/reject hotkeys are now explicitly guarded to only fire
  when the Tasks pane is focused (`activePane === "tasks"`), so they can't
  accidentally fire while browsing/filtering the Agents pane.

### Safety re-check

- No new server-side endpoint or capability anywhere — the "direct-to-agent"
  path only ever calls an endpoint each agent already exposes for exactly
  this purpose (the same one its own browser dashboard's "Send Task" box
  uses). This is the same reasoning already accepted for the Orchestrator
  path: the TUI is exactly as privileged as clicking a dashboard button, no
  more.
- Filtering is purely a client-side array `.filter()` over data already
  fetched — no new query parameter, no new trust boundary.
- Approve/reject remain scoped exactly as before (Orchestrator-only,
  no-body, server-supplied `actionId`); the new pane-focus guard makes that
  narrower, never broader.

### Bug fixes from live feedback (2026-08-09, same day)

Yusuf tried the new agent features live and reported two real problems,
with a screenshot showing the Security Agent's own browser dashboard with
2 completed tasks that never appeared in the TUI at all:

1. **"new task is not working"** — root cause: a direct-to-agent submission
   genuinely worked (the task ran and completed — visible on that agent's
   own dashboard) but the TUI's Tasks pane only ever polls the
   Orchestrator's `GET /tasks`, which has no knowledge of a task that
   bypassed it. The task was not lost or broken; it was simply invisible
   from the TUI, which read as "not working." Fixed by having the TUI track
   its own direct submissions client-side (`directTasks` state) and poll
   each one's status straight from the owning agent's existing
   `GET /tasks/:id` (verified against a running `security-agent` to confirm
   the exact response shape: `{id, status, result?, error?}`, matching what
   the TUI already expected for Orchestrator tasks). Direct tasks now render
   in the same Tasks pane, filtered or not, marked with a `→` prefix
   (alongside the existing `📋`/`↳` plan/child markers), and can be opened
   for details or approved/rejected — approve/reject and detail-fetch now
   route to the *owning agent's* endpoint for a `direct` row instead of the
   Orchestrator's, since a direct task has no Orchestrator-side `actionId`
   at all.
2. **"if i made a filter in one agant how to get back"** — the `f`-toggle-
   same-agent-to-clear mechanic wasn't discoverable. Fixed by adding `Esc`
   as an explicit, always-available "clear the active filter" key (when no
   overlay is open), and by putting "(Esc to clear)" directly in the Tasks
   pane heading and the bottom status line whenever a filter is active, so
   the way back is visible without needing to remember it.

### Verification (2026-08-09)

- `bun build apps/tui/index.tsx --no-bundle --target=bun` transpiled cleanly
  with no errors.
- `bun test`: 104 pass, 0 fail, 168 expectations, 12 files — unchanged, as
  expected for TUI-only code.
- Started the full `bun run dev` stack, confirmed via `/healthz` and
  `/agents` that all 5 agents came online, submitted a real task
  (`git-status`, assigned to `devops-agent`) through the Orchestrator to
  produce live data, then ran `apps/tui/index.tsx` piped and bounded by
  `timeout` against that live stack. Raw ANSI output confirmed: the new
  "Tab to focus · Enter details · f filter tasks" Agents-pane hint text
  rendered, the Tasks pane picked up the live `devops-agent` task, no
  exception/crash in the output, clean bounded exit.
- **Explicitly not verified this round** (same structural gap as the base
  interactive-TUI checkpoint — this sandboxed shell has no TTY to send real
  keystrokes into): `Tab` actually switching focus, `Enter` opening/closing
  the agent-detail box, `f` actually toggling the filter and updating the
  Tasks pane live, and a direct-to-agent submission actually reaching the
  target agent (vs. the Orchestrator) when triggered by real keypresses.
  Needs Yusuf's manual confirmation in his own terminal, same as the base
  round.

### Verification of the bug fixes (2026-08-09, same day)

- `bun build apps/tui/index.tsx --no-bundle --target=bun` — transpiled
  cleanly after the `directTasks`/Esc-clear changes.
- `bun test`: 104 pass, 0 fail, 168 expectations, 12 files — unchanged.
- Started the full `bun run dev` stack; submitted a task directly to
  `security-agent` via `curl` using the exact envelope shape the TUI's
  direct-submit path sends, then polled `GET /tasks/:id` on that agent
  directly and confirmed the response shape (`{id, status, result}`) is
  exactly what the TUI's new `directTasks` polling code expects — this is
  the concrete piece that makes a direct task show up in the Tasks pane
  instead of only that agent's own dashboard.
- Ran the TUI piped/bounded by `timeout` against the live stack — no crash,
  clean bounded exit, "Tasks (all..." heading rendered correctly with the
  new code paths in place.
- **Still not verified with real keystrokes** (same sandboxed-shell
  limitation): actually pressing `n` while filtered and confirming the
  submitted task's row appears live in the TUI's own Tasks pane with the
  `→` marker, and pressing `Esc` to confirm the filter visibly clears. This
  needs Yusuf's hands, same as every other interactive claim in this file.

## Extension (2026-08-09, later same day): help overlay + known paste limitation

Yusuf asked for a discoverable in-app keyboard reference ("if i click ? i
can read the help navigation") and reported that pasting into the new-task
`<input>` doesn't work.

### Help overlay — implemented

- `?` toggles a help box (same open/close convention as task/agent detail:
  `?`, `Enter`, or `Esc` closes it) listing every hotkey: `Tab`, `↑`/`↓`,
  `Enter`, `a`/`r` (double-press), `f`, `Esc`, `n`, `?`, `Ctrl+C`.
- A permanent "(press ? for help)" hint sits next to the title, and the
  default status-line footer now leads with "? for help" so it's
  discoverable without reading this spec.
- Checked against both `key.name === "?"` and `key.sequence === "?"` since
  punctuation-key naming is less consistent across terminals/layouts than
  letter keys.

### Paste — investigated, not fixable from this repo

- Confirmed by reading `@opentui/core`'s `InputRenderable`/
  `TextareaRenderable` type declarations: paste is handled natively at the
  core level (`handlePaste(event: PasteEvent)`, wired to the terminal's
  bracketed-paste escape sequences) — there is no `onPaste` prop or other
  wiring `apps/tui/index.tsx` is missing. The app code cannot be the cause
  of a paste that reaches the input at all failing to insert text.
- Yusuf confirmed the exact combination that's supposed to work
  out-of-the-box (Ctrl+V, in Windows Terminal, which auto-enables bracketed
  paste) and it still doesn't insert text. Given the app-code wiring is
  confirmed correct and the "should just work" combination still fails,
  this is judged to be the same class of tracked, currently-unresolved
  Windows/Bun `stdin`-handling bug already documented in
  `specs/010-tui-cli/spec.md` (`anomalyco/opentui#152`), not a new bug
  introduced by this checkpoint's code.
- **Decision (Yusuf, 2026-08-09): document as a known limitation and move
  on**, rather than spend remaining time on alternate paste gestures or a
  custom stdin-level paste workaround. For any task text you'd want to
  paste rather than type, use the target agent's own browser dashboard's
  "Send Task" box instead — consistent with the project's existing framing
  that the TUI is an equally-capable terminal alternative alongside the
  dashboards, not a full replacement for every input method.
- Not investigated further per that decision: Shift+Insert/right-click
  alternate paste gestures, a manual raw-stdin bracketed-paste parser
  bypassing OpenTUI's own handling.

### Verification

- `bun build apps/tui/index.tsx --no-bundle --target=bun` — transpiled
  cleanly with the help-overlay state/handler added.
- `bun test`: 104 pass, 0 fail, 168 expectations, 12 files — unchanged.
- Piped, bounded (`timeout`) render against a live stack confirmed the new
  "(press ? for help)" title hint text renders; no crash.
- **Not verified with real keystrokes** (same recurring limitation):
  actually pressing `?` to open/close the help box. Needs Yusuf's manual
  confirmation, same as every other interactive claim in this file.
- Paste is a confirmed, documented limitation, not something pending
  further verification — no fix is expected from within this repo.

## Extension (2026-08-09, third round): agent tasks predating this TUI process

Yusuf's screenshot showed 7 tasks (including several `tui-*` ones from
earlier direct-submission testing) completed on the Security Agent's own
browser dashboard, while filtering to that same agent in the TUI showed
none at all ("even in the terminal there is no any tasks").

### Root cause

The previous round's fix (`directTasks` state) only ever tracks tasks *this
exact TUI process* itself submitted, in memory, since it started running.
It has no way to learn about a task that existed before that — from an
earlier TUI run, a `curl`, or that agent's own dashboard — because it never
actually asks the agent for its own task list; it only remembers what it
personally sent. The browser dashboard doesn't have this gap because it
reads that agent's `GET /tasks` directly every poll.

### Fix

- Added `remoteAgentTasks` state: whenever `agentFilter` is set, the poll
  effect now also calls `GET <filteredAgentUrl>/tasks` — the exact same
  endpoint that agent's own dashboard reads — each cycle, and stores the
  full list.
- Tasks pane row list is now `mergeTasksById([remoteAgentTasks,
  directTaskRows, <Orchestrator tasks for that agent>])` when filtered (or
  `[directTaskRows, tasks]` unfiltered) — a de-duplicating merge keyed by
  task id, so the same task reported by two sources renders once.
- Agent-side task list items only ever carry `{id, status, result?,
  error?, step?}` (confirmed by reading `packages/agents/security/index.ts`
  — no original request text is retained agent-side), so a remote-origin
  row's "text" column falls back to that task's `step` field, or a plain
  placeholder if even that is absent.
- `openDetail`/approve/reject's base-URL resolution for a `direct` row no
  longer depends solely on this session's own `directTasks` record — it
  also resolves via `agentUrlByName(row.assignedAgent)` against the already
  -polled agents list, so a task discovered only through the new remote
  fetch (not self-submitted) can still be opened/approved/rejected
  correctly.

### Verification (2026-08-09)

- `bun build apps/tui/index.tsx --no-bundle --target=bun` — clean.
- `bun test`: 104 pass, 0 fail, 168 expectations, 12 files — unchanged.
- Live reproduction of the exact reported scenario: started the full stack,
  `curl`-submitted a task directly to `security-agent` (`pre-existing-task-1`)
  — deliberately *before* the TUI itself was ever started, so it could not
  possibly be in any TUI process's own `directTasks` memory. Then, as a
  one-off verification step, temporarily hardcoded the TUI's initial
  `agentFilter` state to `"security-agent"` (reverted immediately after,
  confirmed via a clean re-transpile and `bun test` pass), and ran the TUI
  piped/bounded by `timeout` against the live stack. Raw output confirmed
  multiple `→ security-agent completed` rows appeared — including both the
  just-submitted pre-existing task and several leftover `tui-*` tasks from
  earlier testing rounds — proving the merge/remote-fetch logic actually
  surfaces tasks the TUI process never itself submitted, closing the exact
  gap in the screenshot.
- **Not verified with real keystrokes**: pressing `f` to filter and seeing
  this happen interactively (the hardcoded-default test above verifies the
  data path, not the keyboard trigger for it, which was already verified
  working in an earlier round). Needs Yusuf's manual confirmation.

## Extension (2026-08-09, fourth round): distinguish task origin in the row

Yusuf pointed out (correctly — confirmed by reading `packages/agents/devops/
index.ts` and `packages/shared/a2a-client.ts`) that some tasks appearing
under a filtered agent were not submitted to it directly at all: they were
triggered by *another agent's own* direct A2A call — specifically DevOps's
`analyze-project` skill, which makes its own direct, Orchestrator-bypassing
call into Security for a secrets pre-check (`specs/remaining-agents-mcp.
spec.md` decision + CLAUDE.md's "Important architectural truth" section
document this as existing, intentional behavior, not new). Every such row
was rendering with the same generic `→` "direct" marker as a task actually
submitted through the TUI itself, which is misleading — the two situations
have different origins and different meanings.

### Root cause

`t.direct` was a single boolean covering *any* row not sourced from the
Orchestrator's own task list, conflating three genuinely different origins:
this TUI's own direct submission, another agent's A2A child call, and that
agent's own browser dashboard's quick-task buttons. But the task ID itself
already reliably distinguishes all of them, since every producer uses a
fixed, distinct prefix: `orch-` (`apps/orchestrator/index.ts`), `a2a-`
(`packages/shared/a2a-client.ts`, used by any agent's own direct A2A call),
`tui-` (this TUI, introduced earlier this session), `task-` (every agent's
own dashboard JS).

### Fix

- Added `originMarker(id): string` — a pure function reading only the ID
  prefix, returning `⇄ ` for `a2a-`, `→ ` for `tui-`, `◆ ` for `task-`, and
  a blank marker otherwise (covers `orch-` and anything unrecognized).
- The Tasks pane's row-prefix logic now calls `originMarker(t.id)` for any
  `direct`-flagged row instead of hardcoding `→` for all of them.
- Added a one-line legend under the Tasks pane heading whenever a filter is
  active, and a fuller explanation in the `?` help overlay, so the
  distinction is discoverable without reading this spec.

### Verification (2026-08-09)

- `bun build apps/tui/index.tsx --no-bundle --target=bun` — clean.
- `bun test`: 104 pass, 0 fail, 168 expectations, 12 files — unchanged.
- Live verification against a real stack with genuine `a2a-*`-prefixed
  tasks already on `security-agent` (left over from DevOps's
  `analyze-project` secrets pre-check in earlier testing): using the same
  temporary-default-filter-then-revert technique as the previous round
  (reverted immediately after, re-confirmed via clean transpile + `bun
  test`), ran the TUI piped/bounded against that stack. Raw output
  confirmed a row rendered as `⇄ security-agent completed`, i.e. the new
  marker correctly distinguishes an agent-to-agent-triggered task from a
  plain direct submission.
- **Not verified with real keystrokes**: seeing this marker distinction
  live while filtering interactively (the data/render path is verified;
  the keyboard trigger for filtering was already verified in an earlier
  round). Needs Yusuf's manual confirmation.

## Extension (2026-08-09, fifth round): duplicate row for the same Orchestrator-routed task

Yusuf's screenshot showed Planning Agent's own dashboard reporting exactly
1 task, while the TUI filtered to `planning-agent` showed 2 — one with the
real request text, one with the generic "(direct submission — no text
stored by the agent)" placeholder from the previous round's fix.

### Root cause

Confirmed by reading `apps/orchestrator/index.ts`: the Orchestrator
dispatches a task to its owning agent under a **different id than its own
internal one** — `agentTaskId = \`orch-${taskId}\`` (lines 183, 346, 486,
504). The Orchestrator's own `GET /tasks` reports the bare `taskId`
(e.g. `task-09d2ed3f-...`); the agent's own `GET /tasks` reports the
prefixed `orch-task-09d2ed3f-...` it was actually dispatched under —
confirmed live, both ids captured side by side against a real submitted
task. The previous round's `mergeTasksById()` deduplicates strictly by
exact id match, so these two different strings for the same logical task
were never recognized as duplicates — the Orchestrator's version (real
text) and the remote-fetched version (placeholder text, since agents don't
retain original request text) both survived the merge.

### Fix

- Added `normalizedRemoteTasks`: any `remoteAgentTasks` row whose id starts
  with `orch-` has that prefix stripped back off before merging, recovering
  the Orchestrator's own id, and is marked `direct: false` — it's a normal
  Orchestrator-routed task, not a bypass, so it should also route through
  the Orchestrator for approve/reject/detail, not the agent directly.
- Flipped merge priority: `mergeTasksById([<Orchestrator tasks for this
  agent>, normalizedRemoteTasks, directTaskRows])` — the Orchestrator's
  richer record (real text) now wins the id collision, while the agent's
  own list still fills in anything the Orchestrator has no record of at all
  (genuine A2A/direct/dashboard-origin tasks, unaffected by this fix).

### Verification (2026-08-09)

- `bun build apps/tui/index.tsx --no-bundle --target=bun` — clean.
- `bun test`: 104 pass, 0 fail, 168 expectations, 12 files — unchanged.
- Live reproduction of the exact reported scenario: confirmed side by side
  via `curl` that the Orchestrator's `GET /tasks` and `planning-agent`'s own
  `GET /tasks` report the same logical task under `task-09d2ed3f-...` vs.
  `orch-task-09d2ed3f-...` respectively. Using the same temporary-default-
  filter-then-revert technique as prior rounds (reverted immediately,
  re-confirmed clean transpile + test pass), ran the TUI piped against the
  live stack filtered to `planning-agent`: the real request text
  ("anlyze my project") appeared exactly **once**, and zero rows showed the
  placeholder text — confirming the duplicate is gone.
- **Not verified with real keystrokes**: seeing one clean row live while
  filtering interactively (data path verified; keyboard trigger already
  verified in an earlier round). Needs Yusuf's manual confirmation.

## Extension (2026-08-10, sixth round): row overflow/garbling, task order, and dynamic-resize layout

Yusuf reported three issues from a live session screenshot showing task rows
with visibly overlapping/garbled text (e.g. `devops-agentnt`,
`generate-readme,-document-api`).

### Root causes (three separate, confirmed by reading the code — not
assumed)

1. **Row text wrapping instead of truncating.** The existing per-row
   truncation math (`textWidth = width - fixedWidth - 4`) used a flat `-4`
   fudge factor that under-counted the real horizontal chrome consumed by
   nested box borders/padding: the outer app `<box padding:1>` (2 columns)
   plus the Tasks `<box border:true padding:1>` (2 + 2 = 4 columns) = 6
   columns total, not 4. On a narrower terminal, rows computed as
   "short enough" were in fact 2 columns too wide, wrapped inside OpenTUI's
   Yoga-based layout, and — since Yoga positions siblings from a
   single-line height computed before wrap — the wrapped second line
   rendered on top of the next task row's already-fixed position. This
   matches the reported symptom exactly.
2. **Newest-first ordering.** `setTasks(tasksData.tasks.slice(-30).reverse())`
   put the most recent task at the top and pushed every existing row down
   on each new arrival. Yusuf asked for ascending order (oldest at top,
   newest appended at the bottom) instead.
3. **No height-aware bounding.** The Tasks pane rendered every visible task
   unconditionally with no cap tied to the terminal's actual row count
   (`useTerminalDimensions()` was already only destructuring `width`, never
   `height`), so a terminal shorter than the full task list had no
   mechanism to clip or scroll — rows simply ran past the bottom of their
   own box.

### Fix

- **`packages/agents/planning/index.ts`-style local-only fix, contained to
  `apps/tui/index.tsx`:**
- Added a named `HORIZONTAL_CHROME = 6` constant (replacing the old flat
  `-4`) documented against the real box structure above.
- Removed `.reverse()`; `directTasks` now appends (`[...cur, new]`) instead
  of prepending, keeping both task sources in the same oldest-to-newest
  order.
- Added a height-aware scrolling window: `reservedRows` approximates every
  non-task-row line (header block, Agents box chrome + a capped row
  estimate, spacers, Tasks box chrome/header, footer); `maxTaskRows =
  height - reservedRows`; the render window tracks `clampedTaskIndex` so
  the current selection is always kept in view, defaulting to showing the
  most recent (tail) tasks. `↑ N more` / `↓ N more` hints appear in the
  Tasks header when rows are scrolled out of view above/below.
- Added `overflow: "hidden"` to both the Agents and Tasks boxes as a
  defensive backstop — since the reserved-row estimate is an approximation
  (not a full Yoga layout readback), this guarantees the worst case for any
  misestimate is a clipped row, never an overlapping/garbled one.

### Verification (2026-08-10)

- `bunx tsc --noEmit`: 0 errors.
- `bun test`: 136 pass, 0 fail, 206 expectations, 14 files — unaffected
  (this file has no test coverage of its own, same as prior rounds).
- Ran `bun run apps/tui/index.tsx` against the live stack and captured its
  raw output stream. **This did not serve as real visual verification** —
  piping OpenTUI's cursor-addressed ANSI diff output through a
  non-interactive capture re-exhibits the same kind of overlapping text
  Yusuf reported, but that is an artifact of dumping raw escape sequences
  outside a real terminal emulator (which correctly interprets cursor
  repositioning), not evidence the fix does or doesn't work. Confirmed the
  process starts cleanly with no thrown errors and control-flow-level
  correctness of the width/order/window math by inspection, matching the
  same honest caveat prior rounds of this exact spec already use for
  keyboard-driven interaction.
- **Not verified: real visual confirmation in an actual terminal, including
  resizing it smaller/larger while tasks are populated.** This needs
  Yusuf's manual confirmation — run `bun run tui` (or `orchestrai tui`) in a
  real terminal window, populate a few tasks, and confirm rows truncate
  cleanly instead of wrapping, new tasks append at the bottom, and resizing
  the window narrower/shorter clips/scrolls instead of garbling.

## Extension (2026-08-10, seventh round): overlay panels not reserved in the height budget

Yusuf reported the garbling persisted after the sixth round's fix, then
pinpointed exactly when: **when there are many tasks (terminal already
full) or when opening the Help overlay.** Real screenshots (not a piped
capture — see the sixth round's honest caveat about that) confirmed genuine
corruption, both in the header lines and deep in the Tasks list.

### Root cause

The sixth round's `reservedRows` budget reserved exactly **1 row** for
"whatever renders below the Tasks box" — correct for the plain footer
status line, badly wrong for every overlay panel that can appear in that
same slot:

- Help overlay: title + blank + 11 keybinding lines + blank + "Row
  markers:" + 4 marker lines = **19 rows**, not 1.
- Detail overlay: title line + its own fixed `height: 12` scrollbox = 13
  rows, not 1.
- Agent-detail overlay: title + status + url + "Skills:" + one line per
  skill = 4 + skills.length rows, not 1.
- New-task input overlay: label line + input line = 2 rows, not 1.

With many tasks already filling the terminal (even after the sixth round's
Tasks-pane windowing, which only bounds the *Tasks box itself*, not the
total page), opening Help added ~19 more rows the budget had no idea about,
pushing total content past the real terminal height. OpenTUI's
cursor-addressed differential redraw then corrupts when asked to paint past
what actually exists — exactly the reported symptom, and exactly why both
of Yusuf's triggers ("many tasks" and "the help tools") independently
reproduce it: either one alone can push total content over the edge once
the other is already close.

Also found and fixed in the same pass: the agent-detail row estimate was
off by one (`3 + skills.length` when the real JSX renders 4 fixed lines
before the per-skill ones), and the Agents-box budget was using an
arbitrary cap of 6 rather than the real (always small, always known)
`agents.length` — harmless today at 5 known agents, but wrong in principle.

### Fix

- Replaced the flat `+ 1` footer assumption with `overlayRows`, computed
  per the actual overlay currently active (`showHelp` / `detail` /
  `agentDetail` / `inputMode` / plain footer), each counted directly
  against its own JSX rather than guessed.
- Fixed the Agents-box budget to use `agents.length` directly instead of a
  6-row cap.
- Added `overflow: "hidden"` to all four overlay boxes (Help, Detail,
  Agent-detail, Input), matching the same defensive backstop already
  applied to the Agents/Tasks boxes in the sixth round — belt-and-suspenders
  in case a future edit to any overlay's content silently drifts from its
  hardcoded row estimate.

### Verification (2026-08-10)

- `bunx tsc --noEmit`: 0 errors.
- `bun test`: 136 pass, 0 fail, 206 expectations, 14 files — unaffected.
- Row-count estimates re-counted directly against the current JSX for all
  four overlays (not re-derived from memory) — see the exact per-overlay
  counts above.
- **Not yet re-verified live in a real terminal** — same honest caveat as
  the sixth round: this needs Yusuf to reproduce the exact two triggers
  (many tasks + opening Help) against the fixed build and confirm the
  corruption is gone.

## Extension (2026-08-10, eighth round): clear local tasks + hide completed/failed

Yusuf asked for a "clear" option. Clarified via two chosen options (of three
offered): (1) clear this session's own locally-tracked direct-submission
tasks, and (2) hide completed/failed tasks from the Tasks pane entirely —
the latter directly addresses the "many tasks fill the terminal" trigger
from the sixth/seventh rounds.

### Added

- **`c`** — clears `directTasks` (this TUI's own client-side tracking of
  tasks submitted directly to an agent, bypassing the Orchestrator).
  Client-side only: never calls any endpoint, never affects the
  Orchestrator's or any agent's real task history — those tasks remain
  fully visible from that agent's own dashboard/`GET /tasks` regardless.
  Shows a status message with the count cleared (or "No local tasks to
  clear").
- **`h`** — toggles a `hideDone` view filter that excludes `completed`/
  `failed` tasks from `visibleTasks` entirely (not just visually dimmed —
  removed from the rendered list, the selection index, and the height-
  window calculations from the sixth/seventh rounds). Purely a client-side
  filter over already-fetched data; toggling back off restores them
  instantly. The Tasks header shows `[hiding done]` and an `h show/hide
  done` hint; the empty-state message distinguishes "genuinely no tasks"
  from "tasks exist but are all hidden by this toggle".
- Both documented in the Help overlay; `overlayRows`'s Help-panel row
  estimate (from the seventh round) updated from 19 to 21 lines to match
  the two new keybinding lines added there, keeping that round's height
  budget accurate.

### Verification (2026-08-10)

- `bunx tsc --noEmit`: 0 errors.
- `bun test`: 136 pass, 0 fail, 206 expectations, 14 files — unaffected.
- Re-counted the Help overlay's exact line count against its current JSX
  after adding the two new lines (13 keybinding lines now, not 11) to keep
  the seventh round's overlay-height-budget fix accurate rather than
  letting it silently drift.
- **Not yet verified live in a real terminal** — same standing caveat as
  the sixth/seventh rounds.

## Extension (2026-08-10, ninth round): `c` didn't clear anything visible

Yusuf confirmed the eighth round's build loaded correctly (header showed the
new `c clear local · h hide done` hints, rows no longer overlapped), then
reported `c` "is not working". Clarified: pressing it showed "No local
tasks to clear" — technically correct per the eighth round's scope
(`directTasks` only), but every row actually on screen was a normal
Orchestrator-routed task, not a direct submission, so nothing ever appeared
to happen. This is a scope mismatch from what "clear" was expected to mean,
not a broken key.

### Fix

Widened `c` from "clear `directTasks` only" to "clear the whole Tasks pane
view":

- Added a `dismissedIds: Set<string>` client-side state. Pressing `c` adds
  every task id currently in `visibleTasks` to this set; `mergedTasks` is
  filtered against it (`afterDismissed`) before the existing `hideDone`
  filter from the eighth round is applied.
- Nothing is deleted anywhere — no Orchestrator or agent endpoint is called.
  The same tasks remain fully visible via `curl`/that agent's own
  dashboard; this is a view-only local filter, exactly like `hideDone`
  already was.
- A task whose id was never in `dismissedIds` (a new submission from this
  point on, or the rare case of an id reused) still appears normally — `c`
  only suppresses ids already seen at the moment it was pressed, not a
  standing ban.
- Updated the Tasks header hint from `c clear local` to `c clear view`, and
  added a `[N cleared]` indicator alongside the existing `[hiding done]`
  one.
- Split the empty-state message into three distinct cases instead of two:
  genuinely no tasks, cleared via `c` ("new tasks will still appear here"),
  or hidden via `h` ("press h to show completed/failed") — so the two
  different reasons for an empty pane are never conflated.
- Updated the Help overlay's `c` line to describe the new scope.

### Verification (2026-08-10)

- `bunx tsc --noEmit`: 0 errors.
- `bun test`: 136 pass, 0 fail, 206 expectations, 14 files — unaffected.
- **Not yet verified live** — needs Yusuf to confirm `c` now actually empties
  the visible list (with the correct empty-state message) and that a
  subsequently-submitted new task still appears afterward.

## Extension (2026-08-10, tenth round): undo for `c`

Yusuf asked for a way to revert the ninth round's clear. Clarified: an undo,
not a request to remove the feature.

### Fix

`c` is now a toggle instead of a one-way action:

- If `dismissedIds` is non-empty, pressing `c` clears the set entirely
  (`setDismissedIds(new Set())`), restoring every previously-cleared task
  immediately — a status message reports the count restored.
- If `dismissedIds` is empty, `c` behaves exactly as the ninth round
  described (adds every currently-visible id to the dismiss set).
- The Tasks header hint switches between `c clear view` and `c undo clear`
  depending on which action the next press will take. The empty-state
  message (shown when the view is fully cleared) now says "press c to undo,
  or wait for new tasks" instead of only mentioning new tasks. The Help
  overlay's `c` line updated to describe the toggle.

Nothing about the underlying mechanism changed — still purely a client-side
`Set<string>` filter, still no server-side call of any kind either
direction.

### Verification (2026-08-10)

- `bunx tsc --noEmit`: 0 errors.
- `bun test`: 136 pass, 0 fail, 206 expectations, 14 files — unaffected.
- **Not yet verified live** — needs Yusuf to confirm pressing `c` twice in a
  row restores the exact same rows that were cleared.

## Extension (2026-08-10, eleventh round): root box had no height clamp

Yusuf reported the top two lines (title + connection status) garbling
together, plus collision with the Agents box header — this time at the very
top, not inside the Tasks pane. Pinpointed the trigger precisely: "only
when the terminal is full" / "only when getting a third box down" — i.e.
whenever a third stacked box (an overlay) appears below Agents+Tasks.

### Root cause

Every *inner* box (Agents, Tasks, and all four overlays) already had
`overflow: "hidden"` from the sixth/seventh rounds, but the **outermost
root box** — the one wrapping the title lines, Agents box, Tasks box, and
whichever overlay/footer renders last — never had an explicit height or its
own overflow clipping:

```tsx
<box style={{ flexDirection: "column", padding: 1 }}>
```

The sixth/seventh rounds' `reservedRows`/`overlayRows` budget is an
estimate, not a live Yoga layout readback (documented as such in both prior
rounds). Whenever that estimate is even slightly tight — which a third
stacked box makes measurably more likely, since it adds real, variable-size
content the estimate has to predict correctly — total column height can
exceed the terminal's actual row count. With nothing at the root level to
clip it, Yoga lays out a column taller than the real viewport, and
OpenTUI's cursor-addressed differential redraw corrupts starting from the
**top** rows rather than clipping the bottom — exactly matching "title and
status line garbled" instead of "task rows garbled" like the sixth round's
symptom.

### Fix

Gave the root box an explicit `width`/`height` (from
`useTerminalDimensions()`, already in scope) and its own
`overflow: "hidden"`:

```tsx
<box style={{ flexDirection: "column", padding: 1, width, height, overflow: "hidden" }}>
```

This is a hard backstop underneath the sixth/seventh rounds' row-budget
estimates, not a replacement for them — the budget still exists to *avoid*
overflowing in the first place (so the user sees informative `↑ N more`/
`↓ N more` hints rather than silently missing content), but if it's ever
imperfect for any reason (a third box, a wider terminal, a future overlay
edit that changes its own line count), the worst case is now some content
silently clipped at the very bottom, never corrupted rendering at the top.

### Verification (2026-08-10)

- `bunx tsc --noEmit`: 0 errors.
- `bun test`: 136 pass, 0 fail, 206 expectations, 14 files — unaffected.
- **Not yet verified live** — needs Yusuf to reproduce the exact trigger
  (fill the terminal, then open a third box — Help, Detail, or Agent-detail)
  against this fix and confirm the top-line corruption is gone.

## Extension (2026-08-10, twelfth round): eleventh round's fix was itself the bug — reverted

Yusuf reported "still the same" after the eleventh round, then sent a
screenshot proving the corruption occurred with **only Agents+Tasks on
screen — no third/overlay box at all**. That single fact rules out the
eleventh round's "third box exceeds the height budget" theory entirely: the
corruption clearly isn't tied to a third box, since none was present.

### Real root cause

The eleventh round's own fix was the regression. It gave the root box an
explicit numeric `width`/`height` sourced from `useTerminalDimensions()`.
That hook's React state initializes as `{width: renderer.width, height:
renderer.height}` **at mount**, before its resize-observer subscription
(`useOnResize`) has fired even once. If `renderer.width`/`renderer.height`
are `0` or otherwise not yet settled on that very first render, the root
box lays out at a wrong (possibly 0×0) size for exactly one frame. When the
resize observer fires a moment later with the real dimensions, OpenTUI's
diff-based redraw apparently doesn't recover cleanly from that jump — it
corrupts precisely the first row of every box, which is exactly the
"title+status merged, Agents header merged with its first row" pattern
across every report so far, including the very first one in the sixth
round (meaning this specific presentation may never have been the
row-truncation/height-budget issue at all — see Non-goals note below).

This is a mount-time race, not a content-height-overflow issue — which is
also why it reproduces "immediately", as Yusuf confirmed, rather than after
scrolling or resizing.

### Fix

Reverted the eleventh round's root-box change entirely: no explicit
`width`/`height`/`overflow` on the root box, letting Yoga size it naturally
exactly as it did before that round. The inner Agents/Tasks/overlay boxes
keep their `overflow: "hidden"` from the sixth/seventh rounds — that part
was never implicated and stays as a legitimate backstop for actual
content-height overflow (many tasks, a tall overlay), a genuinely different
scenario from this mount-time race.

### Open question this raises

It's now unclear how much of the corruption reported across the sixth
through eleventh rounds was this same mount-time race the whole time,
independent of (and possibly unaffected by) the row-truncation/
height-budget fixes in those rounds. Those fixes may well be correct and
necessary for their own scenarios (long single rows, genuinely tall
overlay content) — but this round's finding means the *specific* symptom
in every screenshot so far (adjacent-row text merging, always starting at
a box's first row) has a real alternative explanation that has nothing to
do with total content height.

### Verification (2026-08-10)

- `bunx tsc --noEmit`: 0 errors.
- `bun test`: 136 pass, 0 fail, 206 expectations, 14 files — unaffected.
- **Not yet verified live.** Needs Yusuf to confirm whether the corruption
  is gone now that the eleventh round's regression is reverted — this is
  the first real signal on whether the mount-time-race theory is complete,
  partial, or wrong.

## Extension (2026-08-10, thirteenth round): hard cap on task rows — the actual fix, confirmed by two independent live tests

Yusuf ran two decisive tests that finally isolated the real cause after
twelve rounds of partial/incorrect theories:

1. **Clearing the task list (`c`) fixed the corruption entirely.**
2. **Zooming the terminal out (more rows available) also fixed it**,
   independently confirming the same root cause from a different angle.

Yusuf also described the exact visual mechanism precisely: "the two [header]
lines are constant in the background and the other [content] is getting on
top of them when the terminal is full" — a textbook cursor-position
wraparound. Once total drawn rows exceed the terminal's real height,
absolute-positioned writes for the overflow rows land back near the top
instead of being clipped or scrolled, overwriting the fixed header instead
of appearing below it.

### Why the sixth/seventh rounds' `height`-based windowing didn't prevent this

`maxTaskRows = height - reservedRows` was meant to already solve exactly
this. Both of Yusuf's tests prove it wasn't actually engaging as intended —
whether from an unreliable `height` value in this specific
terminal/Bun/Windows combination, an estimate that was still too generous,
or something else entirely was not conclusively isolated (and, per the
twelfth round, at least one entire prior "fix" attempt in this investigation
turned out to be a red herring rather than progress). Rather than keep
chasing the exact mechanism with more guesses, this round adds a fix that
does not depend on `height` being correct at all.

### Fix

```ts
const HARD_TASK_ROW_CAP = 10
const maxTaskRows = Math.max(2, Math.min(HARD_TASK_ROW_CAP, height - reservedRows))
```

An unconditional ceiling of 10 visible task rows, regardless of what
`height - reservedRows` computes to. The existing lower bound (never fewer
than 2) and the existing `height`-based tightening (for genuinely small
terminals, still use the smaller number) are both preserved — this only
changes the *upper* bound, closing the exact gap both of Yusuf's tests
exposed.

### Verification (2026-08-10)

- `bunx tsc --noEmit`: 0 errors.
- `bun test`: 136 pass, 0 fail, 206 expectations, 14 files — unaffected.
- **Not yet verified live against this specific fix** — Yusuf's two tests
  (clear / zoom-out) confirmed the *diagnosis*, run against the built-in
  workaround of reducing content, not yet against this hard-cap code
  change. Needs a fresh restart and a real many-tasks scenario to confirm
  the cap itself prevents the corruption without requiring either
  workaround.

## Extension (2026-08-10, fourteenth round): raised the task row cap

Yusuf asked for a bigger Tasks box. Raised `HARD_TASK_ROW_CAP` from 10 to
20 — still safe against the thirteenth round's overflow finding, since
`maxTaskRows = Math.max(2, Math.min(HARD_TASK_ROW_CAP, height -
reservedRows))` only raises the *ceiling*; a smaller terminal still falls
back to whatever `height - reservedRows` allows, unchanged.

### Verification (2026-08-10)

- `bunx tsc --noEmit`: 0 errors.
- `bun test`: 136 pass, 0 fail, 206 expectations, 14 files — unaffected.
- **Not yet verified live.**

## Extension (2026-08-10, fifteenth round): Help is now a separate full-screen view

Yusuf asked for the Help overlay to be "a separate view or something"
instead of stacking as a third box below Agents+Tasks.

### Change

`showHelp` now triggers an early return of a standalone screen (title +
Help box only) before the main Agents/Tasks layout renders at all, instead
of being one branch of the ternary chain stacked below both boxes. This
isn't purely cosmetic: it removes Help entirely from the overflow-risk
equation the thirteenth/fourteenth rounds were addressing — when Help is
showing, it is the *only* thing rendered, so there is no "Agents + Tasks +
Help" combined height to exceed the terminal at all. `overlayRows`'s
`showHelp` branch is now structurally dead code (harmless — computed every
render regardless of which branch the final `return` takes, per how React
function components work) but left in place rather than deleted, documented
as such, in case Help is ever folded back into the stacked layout.

All existing keyboard behavior (Esc/Enter/`?` closes Help) is unaffected —
that logic lives in `useKeyboard`, not the render branch.

### Verification (2026-08-10)

- `bunx tsc --noEmit`: 0 errors.
- `bun test`: 136 pass, 0 fail, 206 expectations, 14 files — unaffected.
- **Not yet verified live.**

## Extension (2026-08-10, sixteenth round): auto-follow the newest task

Yusuf asked for the Tasks pane to scroll down to a new task automatically
when the list is full, like a chat/log view.

### Change

Added `followLatestTask` (default `true`). While it's `true`,
`clampedTaskIndex` always resolves to `visibleTasks.length - 1` (the newest
row) regardless of `selectedIndex` — this is what makes the sixth round's
scrolling window (`taskWindowStart`, which tracks `clampedTaskIndex`)
follow new arrivals automatically, with no effect keyed on list length
needed (deliberately avoided — that would also fire on `hideDone`/
`agentFilter`/`dismissedIds` changes, none of which are "a new task
arrived").

- **↑** detaches from auto-follow (an explicit request to look at something
  older) and starts navigating from the currently-followed (newest) row.
- **↓** re-engages auto-follow once it reaches the last row — "scroll back
  to the bottom" and "resume following" are the same gesture.
- Clearing (`c`), toggling hide-done (`h`), clearing an agent filter
  (`Esc`), and setting/toggling an agent filter (`f`) all re-engage
  auto-follow too — each is a context change where "show me what's there
  now" is the right default, consistent with the eighth round's own
  reasoning for those same keys.
- Added a `[paused — ↓ to resume]` header indicator so the state is visible,
  matching the existing `[hiding done]`/`[N cleared]` indicators. Documented
  in the Help view.

### Verification (2026-08-10)

- `bunx tsc --noEmit`: 0 errors.
- `bun test`: 138 pass, 0 fail, 211 expectations, 14 files — unaffected.
- **Not yet verified live.**

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/012-tui-interactive/spec.md, with hotkey [n/`/`] for input mode.
```

or list specific changes needed. No implementation is authorized by
discussion of this draft alone.
