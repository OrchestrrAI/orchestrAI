---
id: 135-tui-80-column-header-and-titles
title: TUI Header Fits 80 Columns, and Centre Titles (Audit, Chat) Show at 80×24
area: tui
change_type: fix
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 069-tui-dashboard-parity-workspace
supersedes: []
superseded_by: []
related:
  - 047-tui-conversation-operations-navigation
  - 115-tui-navigation-redraw-and-answer-clarity
  - 130-tui-dashboard-parity
---

# Spec: TUI Header Fits 80 Columns, and Centre Titles (Audit, Chat) Show at 80×24

> Status: **APPROVED by Muhamad-Yussuf on 2026-09-25** ("ok go ahead in them all"), together with specs 133–136. **IMPLEMENTED and VERIFIED live** the same day — see `verification.md`.

## Purpose

80×24 is the TUI's supported minimum, and the TUI is the main demo
surface. Real-terminal captures during spec 130
(`specs/130-tui-dashboard-parity/verification.md`) showed two defects at
80 columns, both present before spec 130:

1. **Header line 1 doesn't fit.**
   - In the shell views it is clipped: `● live · 1/1` loses `agents`, and
     an extra blank row appears under the header.
   - In Details and the grouped review it wraps: `agents` drops onto its
     own row and pushes the project line down.
2. **The Audit title row is missing at 80×24.** "Audit (N) — t selected
   task · r reload" never appears; the box starts one row lower with a
   blank row where the title should be. A capture with spec 130 phase 4
   stashed shows the same, so it predates the phase 4 title changes.

## Verified Current State

- **Header line 1 is too long.** `renderHeader()`
  (`apps/tui/index.tsx:672`) renders "OrchestrAI" plus the four mode
  labels (about 55 characters with the active mode's brackets), followed
  by `statusText`.
  - `statusText` is padded to `STATUS_BUDGET = "        ● disconnected ·
    99/99 agents".length` (about 37) so that consecutive frames never
    disagree about where the line ends. That padding was a redraw fix, not
    decoration (see the comment at `:686-692`).
  - Total: about 92 characters on a 78-column line (80 minus root
    padding).
  - The header box has `overflow: "hidden"`, but OpenTUI wraps text inside
    it (the same wrap-not-clip behavior recorded in `specs/047`).
- **The height budget assumes a 2-line header.** `computeShellLayout()`
  and `computeShellChatScrollHeight()` (`apps/tui/tui-state.ts`) budget
  `SHELL_HEADER_ROWS = 3` (two header lines plus a gap). A wrapped header
  line takes rows the budget doesn't have.
- **Titles outside the box.** Audit (and Chat) put their title `<text>`
  *outside* the bordered scrollbox, as the first child of the centre
  column. Tasks and Agents put theirs *inside* their bordered box.
- **Observed at 80×24:**
  - Tasks and Agents show their titles.
  - Audit's title row is blank.
  - Chat at 80×24 was not captured with its title in view during spec 130,
    so whether Chat's title is also affected must be checked, not assumed.
- **Root cause of the missing title: not yet proven.** The leading
  hypothesis is that the extra header row (defect 1) plus a centre column
  whose explicit scrollbox height already fills the region squeezes out
  the first, naturally sized child: the title. This must be confirmed with
  the state-injection plus real-PTY technique before any fix is chosen.

## Proposed Behavior

1. **Header line 1 always fits its width.**
   - The status suffix is chosen by available width. At full width it is
     today's padded `● live · N/N agents`. When that doesn't fit, a
     compact form such as `● N/N` (or `● live` / `● down` plus the
     fraction) padded to *its own* fixed budget.
   - Each form keeps a fixed width across frames, preserving the redraw
     fix's rule that consecutive frames agree on where the line ends.
   - The choice is a pure function in `tui-state.ts` (e.g.
     `formatHeaderStatus(width, conn, online, total)`), unit-tested at 80,
     110 and 140 columns, returning a string no longer than the space
     left after the mode labels.
2. **The header is exactly two rows at every supported width**, so
   `SHELL_HEADER_ROWS` stays true.
3. **Centre titles show at 80×24.**
   - After the root cause is proven, the Audit title (and Chat's, if
     affected) renders on its own row at 80×24, 110×30 and 140×40.
   - The preferred fix reuses the existing height helpers: the scrollbox
     height already subtracts the title row, or the title moves inside the
     bordered box like Tasks and Agents.
   - No new, separately derived height formula (this file's rule after
     16+ overflow rounds).
4. Nothing else about the header changes: labels, colors, the project line
   and the approvals count stay as they are.

## Scope

- `apps/tui/index.tsx`: `renderHeader()`, and the Audit (and, if confirmed,
  Chat) centre title layout.
- `apps/tui/tui-state.ts`: the header-status helper and any height-helper
  adjustment.
- `apps/tui/tui-state.test.ts`.
- The worklog and this spec's `verification.md`.

## Safety and Compatibility Constraints

- TUI rendering only: no server, protocol, approval or key-binding change.
- Heights come only from `computeShellLayout()` /
  `computeShellChatScrollHeight()`.
- Every changed view is verified in a real PTY at 80×24, 110×30 and 140×40
  before and after. That includes switching between views, because this
  file's redraw history (`specs/115`, spec 130's view keys) shows layout
  changes can leave stale rows.
- The padded fixed-width header rule is kept, per form, so the
  `project:AC:\…` redraw artifact class does not return.

## Out of Scope / Non-Goals

- Supporting terminals below 80×24 (the "Terminal is too small" screen
  stays).
- Redesigning the header or mode labels.
- Any other 80-column issue not listed here; new findings are recorded,
  not folded in.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] The root cause of the missing Audit title is identified in a real PTY
      and recorded in `verification.md` before the fix is written.
- [x] Header line 1 never wraps or clips its own status at 80, 110 or 140
      columns; the header is exactly two rows in the shell views, Details,
      Help and the grouped review. Pure helper unit-tested.
- [x] The Audit title shows at 80×24, 110×30 and 140×40, filtered and
      unfiltered; Chat's title is checked at the same sizes (and fixed if
      affected).
- [x] No regression in Tasks, Agents, Details, Help or the grouped review
      at the three sizes, including after switching views (real-PTY
      captures).
- [x] `bun run typecheck` 0 errors; `bun test` no regressions.
- [x] Documentation and worklog are updated.

## Verification Plan

- Unit: the header-status helper at the three widths and for each
  connection state; the height helpers, if touched.
- Real PTY (node-pty + @xterm/headless, scratch-only):
  - A read-only isolated stack with persistence on, so Audit has rows.
  - Capture every view at 80×24, 110×30 and 140×40, before and after the
    change, including Chat → Tasks → Audit → Details → Esc sequences.
  - Record captures in `verification.md`.

## Approval Requested

Approval authorizes the width-aware header status, a proven fix for the
missing centre title (Audit, and Chat if affected), and the helper tests.
It does not authorize any other layout, key-binding or server change.
