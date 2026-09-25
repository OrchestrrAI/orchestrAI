---
id: 037-tui-approval-preview-card
title: Structured Approval-Preview in the TUI Detail View
area: tui
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-01
updated: 2026-09-01
approved_by: Yusuf
approved_on: 2026-09-01
implemented_on: 2026-09-01
amends:
  - 033-dashboard-approval-preview-card
supersedes: []
superseded_by: []
related:
  - 006-runtime-stabilization
  - 012-tui-interactive
  - 030-authoritative-skill-dispatch-and-capability-catalog
  - 035-devops-dashboard-approval-preview-card
---

# Spec: Structured Approval-Preview in the TUI Detail View

> Status: **APPROVED, IMPLEMENTED, and VERIFIED** (Yusuf, 2026-09-01) —
> automated checks pass, and Yusuf confirmed the live in-terminal layout
> and approve/reject checks directly ("37 verified").

## Purpose

`specs/033-dashboard-approval-preview-card/spec.md` replaced the browser
dashboards' raw `JSON.stringify(approval, null, 2)` approval dump with a
labeled, structured card that puts `target` and `risks` where a human
approving a write action will actually notice them.
`specs/035-devops-dashboard-approval-preview-card/spec.md` extended the
same card to the DevOps agent's own dashboard. Both specs explicitly named
the TUI's Detail view as carrying the **identical underlying gap** and
deliberately left it out of scope as a separate follow-up. This checkpoint
is that follow-up: bring the same target-first, labeled presentation to
`apps/tui/index.tsx`'s Detail overlay.

This is a **rendering-only change** confined to one JSX expression and its
supporting types/helpers. The `ApprovalPreview` data shape
(`packages/shared/approval.ts`), the `actionId` binding, the approve/reject
key bindings (`a` ×2 / `r` ×2), and every HTTP request the TUI makes are
all unchanged.

## Verified Current State

- `apps/tui/index.tsx` line 980, inside the Detail overlay's fixed-height
  `<scrollbox style={{ height: 12 }}>`:
  `{detail.approval ? <text style={{ fg: "#d29922" }}>{JSON.stringify(detail.approval, null, 2)}</text> : null}`
  — one amber `<text>` node holding the whole pretty-printed JSON object,
  every field the same weight, `target` visually indistinguishable from
  `actionId` or any `parameters` key.
- `TaskDetail.approval` is typed `approval?: Record<string, unknown>`
  (line 84) — loose; the TUI does not currently import or reference the
  real `ApprovalPreview` interface from `packages/shared/approval.ts`.
- The Detail overlay reserves a **fixed** layout budget regardless of
  content: `overlayRows = OVERLAY_CHROME + 1 + 12` (line 292), and the
  scrollbox itself is a hard `height: 12` with `scrollY={true}`. Content
  added inside the scrollbox scrolls; it does **not** change the reserved
  row budget or the outer box height. This is the property that makes a
  content-only change here safe against the terminal-row-overflow class of
  bug documented across `specs/012`'s sixth-through-sixteenth rounds.
- `ApprovalPreview` (`packages/shared/approval.ts`) shape, confirmed by
  reading the file: `actionId`, `kind` (`"mcp-tool" | "file-write" |
  "command"`), `summary`, `target`, `toolName?`, `parameters?`,
  `executable?`, `argv?`, `cwd?`, `timeoutMs?`, `overwrite?`, `risks`
  (`string[]`). Every field a card needs already arrives on the object the
  TUI already fetches from `GET /tasks/:id` — this checkpoint adds nothing
  to the wire contract.
- This exact gap was flagged, not invented, during `specs/030`'s live
  Gemini verification: an approval-gated write pointed at the wrong target
  directory, caught only via `git status`, was traced to `target` being
  "present in the data the whole time, just not visually distinguished
  from the rest of the JSON detail in either client"
  (`specs/030.../verification.md`). `specs/033` fixed the browser half;
  the TUI half is still open.

## Proposed Behavior

1. Replace the single JSON `<text>` node at line 980 with a small stack of
   labeled `<text>` rows rendered from the `approval` object, all still
   inside the existing `height: 12` scrollbox:
   - **Target** — its own row, high-contrast (e.g. `fg: "#58a6ff"` label +
     bright value), rendered first. This is the field the `specs/030`
     incident showed matters most.
   - **Action** — `kind` combined with `toolName` / `executable` into one
     readable row (e.g. `mcp-tool: create_dockerfile`,
     `command: bun test`).
   - **Summary** — the existing `summary` string, one row.
   - **Parameters** — each own-enumerable key of `parameters` as its own
     `key: value` row (values stringified compactly; objects/arrays via
     `JSON.stringify` with no indent), not a nested pretty-printed block.
   - **Risks** — each entry of `risks` as its own amber/red-flagged row,
     prefixed with a marker (e.g. `! `), not a JSON array literal.
   - **actionId** — kept, on the last row, visually de-emphasised
     (`fg: "#6e7681"`), because it is a correlation guard a human never
     needs to read closely.
2. A `raw` boolean toggle in the Detail overlay's own keyboard handler
   (currently lines ~633-639, which handle only scroll + close) flips the
   approval block between the structured rows and the **byte-identical**
   current `JSON.stringify(detail.approval, null, 2)` output. Default is
   the structured view. The toggle key and its hint text are added to the
   Detail overlay header line and the `?` help view. Proposed key: `v`
   ("view raw" / toggle) — final key subject to Yusuf's preference; it
   must not collide with the overlay's existing `↑`/`↓`/`PgUp`/`PgDn`/
   `Enter`/`Esc`.
3. `TaskDetail.approval` is retyped from `Record<string, unknown>` to
   `Partial<ApprovalPreview>` (imported from `packages/shared/approval.ts`;
   `Partial` because the value is server-supplied and the TUI should
   tolerate a missing field rather than assume the full shape). Rendering
   guards every optional field.
4. No change to the `a`/`r` approve/reject handlers, the requests they
   send, the polling loop, the AG-UI event consumption, or any layout
   budget constant.

## Scope

- `apps/tui/index.tsx` — the `TaskDetail` interface (line ~84), a new
  `import type { ApprovalPreview }` line, the Detail overlay's keyboard
  handler (add the `raw` toggle), the Detail overlay header hint text, the
  approval-rendering JSX at line ~980 (the one substantive change), the
  `?` help view's key list, and a small pure helper (e.g.
  `formatApprovalRows(approval): {label, value, tone}[]`) if it keeps the
  JSX readable.
- `context/worklog.md` (dated entry, this work unit).
- `CLAUDE.md` — the two sentences in the "Live event protocol (AG-UI)" /
  "Human approval and safety" areas that currently say the TUI shows "the
  undifferentiated JSON dump" become accurate to describe the card; the
  `specs/033`/`035` "TUI's identical gap is a deliberately separate,
  still-open follow-up" note is updated to point at this (now closed)
  checkpoint.
- `README.md` — only if it describes the TUI approval view in comparable
  detail (to be checked during implementation; likely no change).

## Safety and Compatibility Constraints

- **Rendering only. No new source of truth for `target` or any field.**
  The rows render exactly the `ApprovalPreview` object the Orchestrator (or
  a directly-targeted agent) already returns. No client-side
  reconstruction — e.g. never rebuild a path from `parameters` when
  `target` is present; always show the authoritative `target` field.
- **No new data requested from or sent to any server.** Every rendered
  field is already in the `GET /tasks/:id` response the TUI already
  fetches in `openDetail()`.
- **The approval gate is untouched.** Approving still requires the
  existing `a` ×2 flow, which POSTs to the Orchestrator's
  `/tasks/:id/approve` (or the agent's own endpoint for a directly-
  targeted task) with the server-issued `actionId` the TUI already
  forwards. The raw-JSON toggle is display state only — no editable field,
  nothing that could be misread as overridable input (preserving the
  "extra request fields never influence execution" contract in
  `packages/shared/approval.ts`).
- **No layout-budget regression.** The change stays inside the existing
  `height: 12` scrollbox; `overlayRows`, `reservedRows`,
  `HARD_TASK_ROW_CAP`, and every other `specs/012` overflow-guard
  constant are not touched. Acceptance requires a live check at a small
  terminal size, because layout is this project's most historically
  fragile surface.
- **Type-only import.** `import type { ApprovalPreview }` — no runtime
  import from `packages/shared` added to the TUI bundle.

## Out of Scope / Non-Goals

- Any change to `ApprovalPreview`'s shape, the approval gate's logic, the
  `actionId` contract, or any HTTP endpoint.
- The approve/reject **interaction** (keys, double-press confirm, status
  messages) — unchanged; this is about what the Detail view *shows*, not
  how approval is *performed*.
- A broader TUI redesign, new panes, or restyling anything outside the
  approval block of the Detail overlay.
- Colour-theme / light-mode support for the TUI (it has a single fixed
  palette; out of scope exactly as it was for `specs/033`).
- Wiring the TUI onto the supervisor's process-status layer (a separate,
  already-noted deferred follow-up — unrelated to this).
- Testing/Documentation/Planning/Security agents' own **browser**
  dashboards (the `specs/035` non-goal about other agents' dashboards is
  unaffected by this spec).

## Acceptance Criteria

- [x] Explicit approval from Yusuf is recorded before any implementation
      (2026-09-01, this conversation).
- [x] For an `input-required` task, the Detail overlay shows `target` as
      its own labeled, high-contrast (`#58a6ff`) row.
      `formatApprovalRows()` covers both an `mcp-tool` `kind` (action line
      `mcp-tool: <toolName>`) and a `command` `kind` (action line
      `command: <executable>`) — unit-tested in
      `apps/tui/format-approval-rows.test.ts`. Live per-skill screenshots
      still pending Yusuf's terminal.
- [x] `risks` entries each render as their own `risk`-tone (`#f85149`)
      row; `parameters` render as labeled `key: value` rows — unit-tested.
- [x] The raw-view toggle (`v`) renders exactly
      `JSON.stringify(detail.approval, null, 2)` — the identical
      expression the pre-change code used unconditionally, now behind the
      toggle.
- [x] `a` ×2 approve and `r` ×2 reject behave exactly as before —
      approve executes the previewed action, reject executes nothing.
      **Code unchanged** (the `a`/`r` handlers and their requests were not
      touched); confirmed live by Yusuf directly ("37 verified").
- [x] No new field is requested from or sent to any server — the render
      reads only `detail.approval`, already fetched by `openDetail()` from
      the existing `GET /tasks/:id`; no new fetch added.
- [x] Live layout check: Detail overlay opened with a full task list at a
      deliberately small / zoomed-out terminal shows no row corruption.
      Confirmed live by Yusuf directly ("37 verified"), consistent with
      the structural argument already made: the change stays inside the
      existing `height: 12` scrollbox and touches no
      `overlayRows`/`reservedRows`/`HARD_TASK_ROW_CAP` constant.
- [x] `bun test` (356 pass, 0 fail — +8 new), `bun run typecheck` (0
      errors), `bun run specs:check` (37 specs) all pass.
- [x] `CLAUDE.md` updated (the specs/033 paragraph now describes the TUI
      card); `README.md` needs no change (no TUI-approval detail there);
      `context/worklog.md` entry added.

## Verification Plan

- **Automated:** full `bun test` suite + `bun run typecheck` +
  `bun run specs:check` — a rendering change with no new automated surface
  of its own beyond confirming nothing else broke, plus a focused unit
  test for the pure `formatApprovalRows()` helper if one is introduced
  (fixture `ApprovalPreview` objects → expected label/value/tone rows,
  including missing-optional-field cases).
- **Manual, live:** start the stack (`bun run orchestrai` or `bun run
  dev`), open the TUI, submit tasks that reach `input-required` for a
  DevOps write skill and for `run-tests`, open each in Detail, confirm the
  structured rows and `target` legibility, toggle raw and diff it against
  the `approval` field from `curl http://localhost:3000/tasks/<id>`.
- **Manual, live:** approve one task, reject another, confirm outcomes
  match pre-change behavior.
- **Manual, live:** repeat the Detail-open with ~30 tasks listed and the
  terminal zoomed out one step, watching for the `specs/012` overflow
  symptom.
- Record exact results in `context/worklog.md` and this spec's Acceptance
  Criteria checkboxes; move `verification` to `verified` only if the live
  layout check is done in a real interactive terminal (otherwise
  `partial`, matching how `specs/012`/`035` handled the same limitation).

## Approval Requested

Approval authorizes restructuring the approval block of the TUI's Detail
overlay (`apps/tui/index.tsx`) into labeled rows with a raw-JSON toggle,
retyping `TaskDetail.approval` to `Partial<ApprovalPreview>`, and the
corresponding help-text and documentation updates. It does **not**
authorize any change to `ApprovalPreview`'s shape, the approval gate, the
approve/reject interaction, any HTTP contract, any layout-budget constant,
or any other agent dashboard.
