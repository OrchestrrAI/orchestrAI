---
id: 130-tui-dashboard-parity
title: TUI Parity with the Orchestrator Dashboard
area: tui
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 069-tui-dashboard-parity-workspace
  - 114-coder-multi-file-edit-and-create
  - 120-supervisor-parallel-write-dispatch
supersedes: []
superseded_by: []
related:
  - 012-tui-interactive
  - 047-tui-conversation-operations-navigation
  - 097-chat-answer-and-plan-description-honesty
  - 115-tui-navigation-redraw-and-answer-clarity
---

# Spec: TUI Parity with the Orchestrator Dashboard

> Status: **APPROVED by Muhamad-Yussuf on 2026-09-25** ("ok approved go on"); all four
> phases **implemented** the same day. Prepared for the hackathon demo, where the TUI
> is the main stage.

## Purpose

The TUI is the interface the project is judged on, but a code audit of
the Orchestrator dashboard (`apps/orchestrator/index.ts`, "idx") against
the TUI (`apps/tui/index.tsx`, "tui") on 2026-09-25 found 16 features
the dashboard has and the TUI lacks or shows partially. Some block
demo-critical moments. The worst: a user who opens a waiting task's
details from Tasks sees the diff but cannot approve it there, and the
headline parallel-write scene (specs/120) can only be approved from the
browser.

Every server endpoint and data field this spec needs already exists.
This is a TUI-only change.

## Verified Current State (from the audit, with locations)

| # | Gap | Where |
|---|---|---|
| 1 | No grouped review of a parallel-write batch; chat says "Multiple approvals are waiting — press 2" | `tui:1436`; dashboard card `idx:3120-3152`, submit `idx:4405-4431` |
| 2 | Multi-file approvals: one summary line per file, then "Full diffs: see the dashboard" | `tui:256-277` |
| 3 | `a`/`r`/`s` are ignored in task details unless they were opened from Chat | `tui:1386` (`detailSource === "chat"`) |
| 4 | The chat task card is one line; `a`/`r` work only when exactly one approval waits | `tui:1433`, `tui:1794-1804` |
| 5 | The planning-intent reminder (specs/097) appears only in details | `tui:2045-2047` |
| 6 | Plan steps appear only if seen as live events this session; `TaskDetail` has no `planSteps` | `tui:199-214`, `tui:2030-2038` |
| 7 | Approval rows omit argv, the overwrite flag, and "MCP tool call" vs "Command" | `tui:248`; dashboard `idx:4533-4555` |
| 8 | The conversation rail shows preview text only (no status or time) | `tui:663-669` |
| 9 | Chat turns have no time or skill | `tui:1758-1763` |
| 11 | Tasks fetches only the last 30, and has no chat marker, parent id or status filter | `tui:767` |
| 12 | The header approvals count uses `visibleTasks`, so it can read 0 while an approval waits | `tui:537` |
| 13 | Agent details lack last-seen time and task count | `tui:1906-1915` |
| 14 | Audit has no task filter, and shows time only | `tui:1033-1036`, `tui:1986` |
| 15 | Empty chat shows no example prompts (the dashboard has 3, plus 8 quick tasks) | `tui:1731` |
| 16 | The SSE handler ignores `RUN_*` and waits for the 1.5s poll | TUI SSE handler |

Out of scope: registering an agent by URL (low demo value), and the
"full report" toggle on every turn (specs/116 made it last-turn-only on
purpose).

## Proposed Behavior (four phases, built in order; phase 4 is cut first)

### Phase 1 — approvals work everywhere they're shown (#3, #12, #7, #4, #5)
- The detail view accepts `a`/`r`/`s` (press twice) whatever it was
  opened from, with the confirm hint shown for every source. `s` still
  applies only to plan-step children (specs/089).
- The header's approvals count uses all tasks, not the filtered view.
- `formatApprovalRows()` adds the argv (when present), the overwrite flag,
  and a kind label ("MCP tool call" / "Command"). It stays a pure
  function.
- In Chat, when more than one approval waits, `a`/`r` no longer refuse:
  they open the details of the most recent waiting task in this thread.
  The status text says which, and how to reach the others (`2` for
  Tasks).
- The chat task card gets one bounded line with the specs/097
  planning-intent reminder, for plan-step children waiting on approval.

### Phase 2 — details show the whole plan and every file (#6, #2)
- `TaskDetail` gains `planSteps` (already returned by `GET /tasks/:id`),
  rendered as bounded rows: order, `[skill]`, description, status.
  Live-event steps stay as a fallback when `planSteps` is absent.
- Multi-file approvals render a header row per file (NEW/EDIT, target),
  followed by that file's diff rows via `buildContentPreview()`. A hard
  cap on total diff rows (300) ends with "… N more lines — v for raw". The
  cap is what keeps specs/114's unbounded-content concern answered. The
  "see the dashboard" line is removed.

### Phase 3 — grouped review of a parallel-write batch (#1)
- `g`, from Chat or from a plan's row in Tasks, fetches
  `GET /tasks/:parentId/pending-batch`. When it isn't eligible, a status
  message says why, and nothing opens.
- When eligible, a full-screen overlay opens:
  - One bounded line per branch: decision marker, skill, agent, targets.
  - Keys: `↑/↓` select, `a`/`r` set that branch's decision (default
    approve), `Enter` shows that branch's diff (reusing the phase-2
    renderer), `y` twice submits all decisions in one
    `POST /tasks/:parentId/approve-batch`, `Esc` closes without
    submitting.
- The chat hint names the new key: "Grouped batch waiting — press g to
  review".
- A new `batchReview` owner in `resolveKeyOwner()` (`apps/tui/tui-state.ts`).
- Each decision still carries its branch's own `actionId`. The server
  forwards each to that agent's unmodified `/approve` or `/reject`
  (specs/120), so the gate is unchanged.

### Phase 4 — information parity (#14, #11, #9, #8, #13, #15, #16)
- Audit: a key filters the view to the selected task (`GET /audit?task=`),
  and rows show result bytes and truncation.
- Tasks: a higher fetch bound, a `chat` marker and "child of …" on rows,
  and a status-filter cycle key.
- Chat turns: time and skill in the header line.
- Conversation rail: a status glyph and relative time.
- Agent details: last-seen time and task count.
- Empty chat: the demo's example prompts (display only; no new number
  keys, because `1`–`4` switch modes).
- SSE: refresh immediately on `RUN_FINISHED` / `RUN_ERROR`.

## Safety and Compatibility Constraints

- No server change. Approvals keep the `actionId` binding, press-twice
  confirmation, and `s` for plan steps only.
- Layout: every new list is bounded, and heights come only from
  `computeShellLayout()` / `computeShellChatScrollHeight()` (16+ rounds of
  overflow history). No new free-growing rows in the chat card.
- New pure logic lives in `apps/tui/tui-state.ts` or the formatter so it
  is unit-testable.
- New keys must not collide with existing bindings (checked against the
  help text).
- The help overlay (`?`) lists every new key.

## Acceptance Criteria

- [x] Explicit approval recorded before implementation.
- [x] Phase 1: approve and reject from details opened from Tasks; the
  count is correct with a filter active; argv, overwrite and kind are
  shown; `a` with several waiting opens one; the reminder is on the card.
  Verified in a real terminal on 2026-09-25 (see `verification.md`),
  which also found and fixed a pre-existing redraw bug (below).
- [x] Phase 2: `planSteps` shown for a plan started before the TUI
  opened; a multi-file proposal shows every file's diff; the cap and
  "more" line work; `format-approval-rows.test.ts` updated. Verified in a
  real terminal on 2026-09-25 at 140×40 and 80×24 (see
  `verification.md`), which also fixed phase 1's two-cell `📋` finding.
- [x] Phase 3: `g` opens the grouped review for an eligible batch;
  per-branch decisions submit in one request; an ineligible batch gets a
  message and no overlay. Verified in a real terminal on 2026-09-25
  against a live specs/120 batch (`create-ci` approved, `create-gitignore`
  rejected, in one request); see `verification.md`.
- [x] Phase 4: each item visible in the TUI. Seen live on 2026-09-25,
  except the `child of …` row text (unit-tested; no plan ran in that
  session) and the immediate refresh on `RUN_FINISHED`/`RUN_ERROR`
  (implemented, not separately timed). The `chat · ` marker covers only
  tasks linked from threads this TUI session has loaded: `GET /tasks`
  carries no conversation id, and this spec rules out a server change.
- [x] Unit tests at 80×24, 110×30 and 140×40 for every new layout; `bun
  run typecheck` 0 errors; `bun test` no regressions. The new logic is
  pure helpers with unit tests; the new layouts (grouped review, Help,
  Details, Audit) were checked in a real terminal at those sizes.
  `bun test` 1563 pass / 2 skip / 0 fail.
- [x] Real-terminal (PTY) check of each phase; phase 3 against a live
  specs/120 batch (approve one branch, reject the other).
- [x] A parity walk: every row in the table above now present, except
  the two named out-of-scope items (see `verification.md`, "Parity
  walk").
