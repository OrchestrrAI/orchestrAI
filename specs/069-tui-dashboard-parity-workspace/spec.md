---
id: 069-tui-dashboard-parity-workspace
title: TUI — Dashboard-Parity Three-Panel Workspace
area: tui
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-10
updated: 2026-09-12
approved_by: Yusuf
approved_on: 2026-09-10
implemented_on: 2026-09-10
amends:
  - 012-tui-interactive
related:
  - 046-browser-conversation-operations-workspace
  - 044-conversational-ask-layer
  - 047-tui-conversation-operations-navigation
  - 021-ag-ui-event-protocol
supersedes: []
superseded_by: []
---

# Spec: TUI — Dashboard-Parity Three-Panel Workspace

> Review gate: **APPROVED 2026-09-10 by Yusuf.**
> Written from Yusuf sharing the browser dashboard's own design
> (`specs/046`) with "also the TUI should be like this", 2026-09-10:
> a left conversations rail, a center Chat / Tasks / Agents workspace,
> a right rail with agent status and recent tasks, and inline
> approval cards in the chat stream.
>
> **This is deliberately a `plan.md`-backed, multi-phase spec.** A
> full three-panel TUI redesign is the single largest and riskiest
> item in this codebase's own history: `apps/tui/index.tsx` took
> *sixteen* extension rounds under `specs/012` and a further phase set
> under `specs/047`, almost all of them fixing real
> terminal-row-overflow and cursor-wraparound bugs that only appeared
> in a live terminal. This spec does not attempt it in one pass.

## Purpose

The browser dashboard (`specs/046`) and the TUI have drifted far apart
in capability and shape. The dashboard is a Chat-default
Chat|Tasks|Agents workspace with selectable conversations, linked
task cards, inline structured approvals, and live agent status. The
TUI (`apps/tui/index.tsx`) is an Agents/Tasks two-box poller with a
separate full-screen chat view (`k`) and a Detail overlay — functional,
but visibly a different, older product.

Yusuf wants the TUI to reach parity: same information architecture,
same primary actions, in the terminal.

## Verified Current State

Read 2026-09-10 (`apps/tui/index.tsx`, `apps/tui/tui-state.ts`):

- The TUI is a **poller** (`GET /tasks` on an interval), not
  SSE-primary — `specs/012`'s own deliberate simplification. It *also*
  consumes `GET /events` as a secondary path (`specs/021`) for a
  zero-row `⚙` live-call badge.
- Layout is two stacked boxes (Agents, Tasks) plus early-return
  full-screen views for `?` (help), `k` (chat, `specs/046`'s TUI
  addition), and the Detail overlay. Every one of those is
  early-return specifically because stacking a third box blew the
  row budget in live testing.
- The chat view already renders a conversation, an input, and the
  `specs/037` approval preview rows — the pieces exist, they're just
  not composed as a persistent workspace.
- Hard constraints, all found live and documented in this file's own
  comments: no explicit root width/height; no `flexGrow`/`flexShrink`
  on a scrollbox; every long value bounded/truncated; a fixed computed
  height on any scrollable region. `specs/012`'s rounds 13–16 and
  `specs/047` Phase 2 are the record of what breaks when these are
  violated.

## Proposed Behavior (target shape, delivered in phases)

The end state mirrors `specs/046`'s panels, adapted to a terminal:

- **Left rail — Conversations.** The list of bounded `/ask`
  conversations (`specs/044`), selectable, newest first, with the
  active one highlighted. Collapsible to a narrow strip on a small
  terminal.
- **Center — Chat | Tasks | Agents**, tab-switched (matching the
  dashboard's own three views):
  - *Chat*: the active conversation's turns, inline task cards for a
    dispatched turn, inline `specs/037` approval rows with
    keyboard Approve/Reject, and the composer.
  - *Tasks*: the current task table (today's Tasks box content),
    filters, the Detail view folded in rather than a separate overlay.
  - *Agents*: agent list + details (today's Agents box content).
- **Right rail — status.** Agent online/offline (live, from the poll +
  `/events`), and a "Recent Tasks" strip. Hidden on a narrow terminal.
- **Live approvals** appear in the Chat stream as they arrive, not
  only in a Detail overlay.

Nothing about the **safety model** changes: approvals still require the
real `POST /tasks/:id/approve` with its server-issued `actionId`; the
TUI never treats an AG-UI `CUSTOM` approval event as authorization
(`specs/021`'s own rule); the poll stays the source of truth for task
membership/status.

## Phasing (the plan.md carries the detail)

- **Phase 1 — the shell.** Introduce the three-region layout
  (left rail / center / right rail) with responsive collapse, driven
  by `useTerminalDimensions()`, every region a fixed-computed-height
  scrollbox. No new data, no behavior change — the existing Agents and
  Tasks content just moves into the center's Agents/Tasks tabs and the
  right rail. Ship only when it renders clean at 80×24 through a
  zoomed-out terminal, live-confirmed by Yusuf.
- **Phase 2 — Chat as a first-class center tab.** Fold the `k`
  full-screen chat into the center Chat tab, with the conversations
  left rail wired to `specs/044`'s conversation list. Inline task
  cards for dispatched turns.
- **Phase 3 — inline approvals + right-rail status.** Approval rows
  render in the Chat stream on arrival; the right rail shows live
  agent status and recent tasks.
- **Phase 4 — polish + retire the old views.** Remove the standalone
  overlays that are now redundant; reconcile keybindings; a final
  full live matrix (small terminal, resize, heavy task load, an
  approval mid-stream).

Each phase is its own reviewable checkpoint of behavior and its own
live-verification gate. A later phase does not start until the prior
one is `verification: verified` by a real Yusuf terminal pass.

## Scope

- `apps/tui/index.tsx`, `apps/tui/tui-state.ts`, and possibly a small
  number of new `apps/tui/*` modules for the panels — kept as pure
  state + thin rendering, mirroring how `tui-state.ts` already
  isolates logic.
- No change to any Orchestrator endpoint, the AG-UI event schema, or
  the approval gate.
- No change to the browser dashboard.

## Safety and Compatibility Constraints

- **Every `specs/012`/`specs/047` layout constraint holds** — no
  explicit root size, no scrollbox flex, bounded values, fixed
  computed heights. Phase 1's own gate is "renders clean at the
  minimum through zoomed-out", nothing ships that regresses the
  terminal-overflow fixes those rounds earned.
- **The approval gate and its `actionId` flow are untouched.**
- **The poll remains the source of truth** for task list membership
  and status; `/events` stays a secondary, best-effort enhancement.
- **`orchestrai tui` and the supervisor's auto-launched viewer keep
  working throughout** — no phase leaves the TUI unlaunchable.

## Out of Scope / Non-Goals

- Replacing the poll with SSE-primary data flow — a separate, larger
  question `specs/012` already declined; this spec keeps the poll.
- Mouse support.
- Matching the dashboard pixel-for-pixel — this is information-
  architecture parity in a terminal, not a screenshot clone.
- The dashboard's own open items (`specs/046`'s real-browser checks).
- Any change to `specs/044`'s conversation model or `/ask` tiering.

## Acceptance Criteria (Phase 1 only; later phases add their own)

- [~] The three-region shell renders with no overflow, no header
      corruption, at 80×24, at a typical size, and at a deliberately
      zoomed-out terminal — confirmed live by Yusuf, the same two
      decisive tests `specs/012` round 13 used. **80×24 smoked in a
      real PTY (renders clean, both rails correctly collapsed — the
      centre equals the pre-069 full-width render). The wider sizes,
      where the rails actually appear, still need Yusuf's terminal —
      the implementing environment's PTY is fixed at 80×24.**
- [x] Today's Agents and Tasks content is fully present in the new
      center tabs / right rail — nothing lost. Chat stays a full-screen
      view for Phase 1 (folding it into the centre Chat tab is Phase
      2's whole job; see `plan.md`).
- [x] Every keybinding that worked before Phase 1 still works
      (approve/reject double-press, filters, `c`/`h`, navigation) —
      `resolveKeyOwner`/`resolveModeKey`/the confirm state machine and
      every mode's key handling are untouched.
- [x] `bun test` (880 pass), `bun run typecheck` (0 errors),
      `bun run specs:check` (68 specs) pass. Compiled binary builds.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

**Phase 2 does not start until Yusuf confirms the wide-terminal render
live** — the spec's own rule ("A later phase does not start until the
prior one is `verification: verified` by a real Yusuf terminal pass").

## Verification Plan

- Pure state tests for the new layout/region logic and any
  tab/rail-selection state in `tui-state.ts`.
- A live real-terminal pass per phase, by Yusuf, at multiple terminal
  sizes — the only verification this codebase's own history treats as
  real for TUI layout.
- `plan.md` records the per-phase design and the live results as they
  land.

## Approval Requested

**Approved 2026-09-10 by Yusuf.** Implementation proceeds (069 phase by phase).

