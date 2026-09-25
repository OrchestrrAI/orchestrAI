# Verification — 135 TUI header fits 80 columns; centre titles show at 80×24

## Root cause (proven before the fix)
Real PTY (node-pty + @xterm/headless, scratch-only) at 80×24, before the
change:
- Header line 1 was the mode labels (52 columns) plus a status suffix
  padded to 37, so 89 characters on a 78-column line.
- It wrapped:
  - the project line read `project:tproject unavailable` (a stray `t`
    from the wrapped text);
  - a blank row appeared under the header;
  - **both** titles that sit outside their box went missing: Audit's
    ("Audit (N) — t selected task · r reload") and Chat's ("Chat — thread
    0/5 · …"). Chat was also affected, which the spec had asked to check.
- **Controlled experiment:** with only `statusText` temporarily replaced
  by a 4-character string, and nothing else changed, both titles came back
  at 80×24, and the project line was clean. The experiment edit was then
  reverted (`git diff` empty).
- **Conclusion:** the wrapped header line consumed the row the height
  budget (`SHELL_HEADER_ROWS = 3`) gave the first centre row. No
  height-helper change is needed; the header only has to stop wrapping.

## What changed (2026-09-25)
- `apps/tui/tui-state.ts`: `formatHeaderStatus({ available, conn, online,
  total })` returns a status suffix that never exceeds the width the labels
  leave:
  - the full form (`● live · N/N agents`, padded to
    `HEADER_STATUS_FULL_BUDGET`) when it fits;
  - otherwise the compact form (`● live N/N`, `● down N/N` or `○ wait N/N`,
    padded to `HEADER_STATUS_COMPACT_BUDGET`);
  - truncated only if even that doesn't fit.
  - Each form is fixed-width, preserving the specs/115 redraw rule.
- `apps/tui/index.tsx`: `renderHeader()` measures its own labels text and
  asks `formatHeaderStatus()` for a suffix that fits `width - 2 - labels`.
- No height helper, key binding or server change.

## Automated
- `apps/tui/tui-state.test.ts`:
  - At 80, 110 and 140 columns, labels plus status fit for every
    connection state and for 0/0, 6/6 and 99/99 agents.
  - 80 uses the compact form; 110 and 140 keep today's full form.
  - Each form is fixed-width across states.
  - The result is never longer than the space available (including tiny
    or negative widths).
- `bun run typecheck` 0 errors; full `bun test` in the commit below.

## Real-terminal check (after)
A read-only isolated stack (`--only orchestrator,devops-agent`, persistence
on, so Audit has 149 rows). Each size was driven through Chat → Tasks →
Details → Esc → Agents → Audit → Help → Esc → Chat.

| Size | Header | Titles and views |
|---|---|---|
| 80×24 | Two rows: `… 4 Audit  ● live 1/1`, then a clean `project: C:\Users\moham\test-target-project … approvals: 0` | `Chat — thread 0/5 · ←/→ browse · n new` and `Audit (149) — t selected task · r reload` both shown; Tasks, Agents, Details and Help intact; returning to Chat is clean |
| 110×30 | Full form `● live · 1/1 agents`, two rows | Every title shown |
| 140×40 | Full form, two rows | Every title shown |
| 80×24, grouped review (a live specs/120 batch) | Two rows (it used to wrap `agents` onto a third) | "Grouped review — 2 parallel writes" and both branches shown |

Both grouped-review branches were rejected. The fixture's SHA-256 snapshot
matched afterwards.

## Noted, not changed
At 80 columns a long Audit row (e.g. `A2A orchestrator-supervisor →
git-status · completed · 1020ms · 0B`) wraps onto a second line inside
the Audit scrollbox. The scrollbox absorbs it and nothing overflows the
layout. Bounding each Audit row to one line is a separate cosmetic change,
outside this spec.
