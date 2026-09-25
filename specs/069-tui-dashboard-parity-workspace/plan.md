# Plan — 069 TUI Dashboard-Parity Three-Panel Workspace

Multi-phase. Each phase is its own behavior checkpoint **and its own
live-verification gate**: a later phase does not begin until Yusuf has
confirmed the prior one renders clean in a real terminal at the sizes
below. `bun test` / `bun run typecheck` cannot see a rendered frame —
every layout regression in this file's 16-round history was invisible to
them and only showed up in a live PTY.

## Sizes every phase is gated against

- **80×24** — the hard minimum (`width < 80 || height < 24` already
  early-returns a "too small" screen).
- **A typical size** — ~120×32.
- **A deliberately zoomed-out terminal** — the decisive test `specs/012`
  round 13 used; a very wide, short viewport with a long task list.

## Layout model

Root `<box padding:1>` (no explicit width/height — the eleventh-round
regression). Inside it, unchanged: `renderHeader()` (2 text lines + a
blank spacer = 3 rows) then, new in Phase 1, a `flexDirection: "row"`
**shell** with up to three regions:

```
┌ header (3 rows, full width, unchanged) ────────────────────────────┐
├─────────┬───────────────────────────────────────────┬─────────────┤
│ left    │ center                                     │ right       │
│ rail    │  Chat | Tasks | Agents  (tab-switched)     │ status rail │
│ (convs) │                                            │ (agents +   │
│         │                                            │  recent)    │
└─────────┴───────────────────────────────────────────┴─────────────┘
  footer (1 row, full width, unchanged)
```

Every region is a column box with a **fixed computed-height**
`<scrollbox>` inside — never `flexGrow`/`flexShrink` on a scrollbox
(`specs/047` Phase 2), never an explicit size on the root
(`specs/012` round 11). Region widths are explicit on the *children*,
which is allowed and is exactly what `init-form.tsx`'s `FieldRow`
already does — a child Yoga-sizes against its correctly-filled parent,
not the raw terminal.

### Responsive collapse (pure function `computeShellLayout`)

| terminal width | left rail | right rail |
|---|---|---|
| `>= 110` | full (24 cols) | shown (28 cols) |
| `100..109` | full (24 cols) | hidden |
| `84..99` | strip (6 cols) | hidden |
| `< 84` | hidden | hidden |

At 80×24 this is **today's layout minus nothing** — left rail hidden,
right rail hidden, center = `width - 2`. That keeps the hard-minimum
case byte-close to the known-good current render; the rails only appear
once there is real width to give them. A 1-col gap sits between each
shown region. `centerWidth = width - 2 - leftW - (leftW ? 1 : 0) -
(rightW ? rightW + 1 : 0)`, floored at a usable minimum.

### Heights (pure function `computeShellRegionHeight`)

`height - ROOT_PADDING(2) - HEADER(3) - FOOTER(1) - GAP_ABOVE(1)` is the
shell's inner height. The center's Tasks list keeps using
`computeTaskWindow` (its `reservedRows` already accounts for exactly
this chrome). Each rail's own scrollbox height = shell inner height −
its border(2) − title(1).

## Phase 1 — the shell (this checkpoint)

**Scope:** geometry + moving existing content into regions. **No new
data, no new fetch, no behavior change, no keybinding change.**

- `apps/tui/tui-state.ts`: add pure `computeShellLayout({width,height})`
  → `{ leftRailWidth, rightRailWidth, centerWidth, leftRailMode:
  "full"|"strip"|"hidden", showRightRail }` and
  `computeShellRegionHeight({height})`. Unit-tested in
  `tui-state.test.ts` (breakpoints, gap math, center-width floor, the
  80×24 case equals "full width minus root padding").
- `apps/tui/index.tsx`:
  - A `<Shell>` wrapper component rendering the row container + the
    left rail + the center + the right rail from already-fetched state.
  - **Left rail — Conversations.** The existing `chatConversations`
    list, newest first, active one highlighted. Strip mode: just an
    index/active-dot column. Uses data already polled for Chat.
  - **Center.** The existing **Tasks** and **Agents** renders,
    unchanged in content, parameterized to `centerWidth` instead of
    `width` where they currently pass `width` to `bounded()` / column
    math. **Chat stays a full-screen view for Phase 1** — folding it
    into the centre Chat tab is Phase 2's entire job, so touching it
    here would be doing Phase 2 early. The header's `1 Chat` shortcut
    still switches to that full-screen view exactly as today.
  - **Right rail — status.** Agent ●/○ list (from `agents`) + a
    "Recent tasks" strip (the last N of `visibleTasks`). Read-only,
    no new state.
  - Overlays (**Help**, **Detail**, **new-task input**, **too-small**)
    stay as full-screen early returns for Phase 1 — Phase 4 folds
    Detail into the center Tasks tab and reconciles the rest.
  - `renderHeader()` and the footer stay full-width, outside the shell
    row.
- Every existing keybinding path (`resolveKeyOwner` / `resolveModeKey`
  / approve-reject double-press / filters / `c` / `h` / follow-latest)
  is untouched.

**Exit gate:** Yusuf confirms a clean render (no overflow, no header
corruption, no cursor wraparound) at 80×24, ~120×32, and a zoomed-out
terminal with a long task list — the same two decisive tests
`specs/012` round 13 used. Until then this phase is
`verification: pending` and Phase 2 does not start.

## Phase 2 — Chat as a first-class center tab

Fold the `k` full-screen chat into the center Chat tab; wire the left
rail's conversation selection to `specs/044`'s list (it already drives
`chatConversationId`). Inline task cards for a dispatched turn. Its own
live gate.

## Phase 3 — inline approvals + right-rail status

Approval rows (`formatApprovalRows`, already built) render in the Chat
stream on arrival, with keyboard approve/reject in place; the right
rail gains live agent status transitions and a richer recent-tasks
strip. Its own live gate.

## Phase 4 — polish + retire the old views

Remove the now-redundant standalone Detail / Help overlays (or reduce
them to a centered popover inside the shell), reconcile keybindings,
and run a final full live matrix (small terminal, resize, heavy task
load, an approval mid-stream).

## Non-goals (from the spec, restated so no phase drifts)

SSE-primary data flow; mouse support; pixel parity with the browser;
any Orchestrator endpoint / AG-UI schema / approval-gate change; any
change to `specs/044`'s conversation model.

## Live results log

- **Phase 1 — implemented 2026-09-10; VERIFIED 2026-09-10 by Yusuf**
  ("phase 1 verified"). Geometry helpers + shell rendering landed;
  `bun test` / `bun run typecheck` / `bun run specs:check` green; the
  compiled binary builds; 80×24 smoked clean in the implementing env's
  PTY; Yusuf confirmed the wide / zoomed-out render live. **Phase 2 is
  unblocked.**
- **Phase 2 — implemented 2026-09-12; `verification: pending`.** Chat now
  renders through the same `renderShell()` Phase 1 built for Tasks/
  Agents, via new `computeShellChatScrollHeight()` (replacing the
  retired full-screen `computeChatScrollHeight()`, removed entirely —
  same "compute a real reserved-rows budget" discipline, reserving
  against the shared shell chrome instead of the full screen). The
  composer moved INSIDE the centre panel's own budget (shrinking the
  scrollbox by its own 6 rows when open) specifically so the shell's
  footer stays exactly one row always, matching Tasks/Agents' own
  invariant — growing the footer instead would have made the rails'
  fixed `shellRegionHeight` disagree with the real available space
  whenever the composer opened, reintroducing the exact overflow-bug
  class this file's history is full of. The left rail's conversation
  selection needed no new wiring at all: it already read the same
  `chatConversationId`/`chatConversations` state this view uses, and Chat
  simply never showed it before (it was full-screen). Content and every
  keybinding are unchanged. 6 rewritten tests in `tui-state.test.ts` for
  the new height function (including one asserting it reserves exactly
  the same shared shell chrome `computeTaskWindow` already does), `bun
  test` 899 pass, typecheck clean. Live-smoked in a real 80×24 PTY (the
  same state-injection technique the guided-init specs use): the new
  "Chat — thread N/M" title row rendered at the same starting row
  Tasks/Agents' own titles do, the footer and scrollbox both rendered
  within bounds, no overflow — and, as designed, both rails stay hidden
  at 80 columns (below the 84-col threshold), so this pass could not
  confirm the rails actually appearing alongside Chat. **Inline task
  cards for a dispatched turn were already present** (from `specs/046`)
  and needed no change for this phase. **Not verified**: the wider sizes
  (~120×32, and a zoomed-out terminal) where the rails actually show next
  to Chat — this environment's PTY is fixed at 80×24, so that is Yusuf's,
  the same standard every phase here carries. **Phase 3 does not start
  until he confirms it.**
