---
id: 033-dashboard-approval-preview-card
title: Structured Dashboard Approval-Preview Card
area: dashboard
change_type: enhancement
status: implemented
verification: verified
created: 2026-08-21
updated: 2026-08-21
approved_by: Yusuf
approved_on: 2026-08-21
implemented_on: 2026-08-21
amends: []
supersedes: []
superseded_by: []
related:
  - 006-runtime-stabilization
  - 030-authoritative-skill-dispatch-and-capability-catalog
---

# Spec: Structured Dashboard Approval-Preview Card

> Review gate: **DRAFT — NOT APPROVED, NOT IMPLEMENTED.**
>
> Per CLAUDE.md's Working procedure (step 8): writing this document does
> not authorize any runtime, dependency, config, or workflow change.

## Purpose

Replace the Orchestrator dashboard's approval-preview modal — currently a
single `JSON.stringify(approval, null, 2)` dump — with a labeled,
visually-structured card that puts `target`, `toolName`, and `risks` where
a human approving a write action will actually notice them, without
changing anything about what the approval gate itself enforces.

This is a **rendering-only change**. The `ApprovalPreview` data shape
(`packages/shared/approval.ts`), the `actionId` binding, and the
approve/reject request/response contracts are all unchanged.

## Verified Current State

- `apps/orchestrator/index.ts`'s dashboard `view(id)` function (inline
  `<script>` in the server-rendered HTML, around line 1357): when a task's
  `status === 'input-required'`, the modal body is set to
  `JSON.stringify(data.approval, null, 2)` and written into
  `#modal-body` via `.textContent` — an undifferentiated JSON blob, every
  field the same size and weight.
- `ApprovalPreview` (`packages/shared/approval.ts`) has a fixed, known
  shape: `actionId`, `kind`, `summary`, `target`, `toolName?`,
  `parameters?`, `executable?`, `argv?`, `cwd?`, `timeoutMs?`,
  `overwrite?`, `risks`. Every field a card needs to label already exists
  on the object the dashboard already receives — this checkpoint adds no
  new field to the wire contract.
- `apps/tui/index.tsx` (line ~980, per the codebase's own prior note in
  `specs/029`'s verification record) renders the identical `approval`
  object the same undifferentiated way, in its own Detail view. **This
  spec covers the browser dashboard only** — see Out of Scope.
- This exact gap was flagged, not invented, during `specs/030`'s live
  Gemini verification: a real operational incident (an approval-gated
  write pointed at the wrong target directory, caught only via
  `git status`, not via anything the approval screen visually surfaced)
  was traced to `target` being "present in the data the whole time, just
  not visually distinguished from the rest of the JSON detail in either
  client" (`specs/030-authoritative-skill-dispatch-and-capability-catalog/
  verification.md`). That verification record explicitly named this as
  "a candidate for its own small, separately-approved checkpoint" — this
  spec is that checkpoint, for the dashboard half of it.

## Proposed Behavior

1. `view(id)`'s `input-required` branch renders a structured card instead
   of a JSON dump, with:
   - **Target path** — its own prominent line, monospace, visually
     distinct from every other field (this is the field the specs/030
     incident showed matters most).
   - **Action** — `kind` + `toolName`/`executable` combined into one
     human-readable line (e.g. "MCP tool call: `create_dockerfile`").
   - **Parameters** — still shown, but as a labeled key/value list, not
     raw nested JSON.
   - **Risks** — each entry in `risks` as its own visually flagged line
     (not buried at the bottom of a JSON array).
   - **`actionId`** — shown, but visually de-emphasized (small, muted) —
     it's a correlation guard a human never needs to read closely, and
     over-emphasizing it would misleadingly suggest it's something a human
     is meant to inspect or copy.
2. A collapsed "raw JSON" toggle preserves the exact current behavior
   (the full `JSON.stringify(approval, null, 2)`) for anyone who wants it
   — this is additive, not a removal of the existing detail.
3. No change to the approve/reject buttons, their request bodies, or any
   HTTP endpoint.

## Safety Constraints

- **This must not become a second source of truth for `target` or any
  other field.** The card renders exactly the `ApprovalPreview` object the
  Orchestrator already returns — it introduces no client-side
  interpretation, guessing, or reformatting of `target` (e.g. no
  reconstructing a path from `parameters` if `target` itself is present;
  always prefer the authoritative field).
- **No new data is sent to the client.** Every field the card displays is
  already present in the existing `GET /tasks/:id` response; this
  checkpoint changes rendering only.
- **Approving remains exactly `POST /tasks/:id/approve` with the stored
  `actionId`** — unchanged, and the card's "raw JSON" toggle is read-only
  (it must not become an editable field that could be misread as
  overridable input, which would violate the existing "extra request
  fields never influence execution" contract in
  `packages/shared/approval.ts`).

## Scope

- `apps/orchestrator/index.ts` — the `view(id)` function and its
  associated inline CSS in the dashboard's `<style>` block.
- `CLAUDE.md`, `README.md` (if the dashboard is described anywhere there
  in enough detail to need updating), `context/worklog.md`.

## Out of Scope / Non-Goals

- **The TUI's Detail view.** `apps/tui/index.tsx` has the identical
  underlying gap, but it is a different rendering surface (OpenTUI/React
  terminal layout, not HTML/CSS) with its own layout-overflow history
  (`specs/012`'s sixth-through-sixteenth rounds). Fixing it is a natural
  follow-up but deliberately a separate checkpoint so this one stays small
  and reviewable, and so a TUI layout regression (this project's most
  historically fragile surface) can't block a low-risk dashboard fix.
- Any change to `ApprovalPreview`'s shape, the approval gate's logic, or
  any HTTP contract.
- A general dashboard redesign — this touches only the approval-preview
  modal.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] The structured card renders `target` as its own visually distinct
      line for every write-capable skill this repo currently has
      (`dockerize`, `create-ci`, `create-gitignore`, `create-compose`,
      `generate-readme`, `run-tests`/`check-coverage`) — verified against
      real `input-required` tasks for each, not just one.
- [x] The raw-JSON toggle, when expanded, is byte-identical to today's
      `JSON.stringify(approval, null, 2)` output.
- [x] Approve and reject still work unchanged — verified end to end
      (approve executes the exact previewed action; reject executes
      nothing), matching the existing behavior this spec must not alter.
- [x] No new field is requested from or sent to the server beyond what
      `GET /tasks/:id` already returns.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` all pass.
- [x] Visual check in a real browser: no layout overflow, no console
      errors. The dashboard has no light/dark theme support to begin
      with (a single fixed dark palette, hardcoded hex colors, no
      `prefers-color-scheme`) — confirmed, not assumed, so that half of
      the original criterion doesn't apply.
- [ ] `CLAUDE.md`, `README.md`, `context/worklog.md` updated after the
      above pass.

## Verification Plan

- Automated: full suite, typecheck, spec governance (this is a rendering
  change with no new automated test surface of its own beyond confirming
  nothing else broke, unless the implementation introduces testable pure
  functions for the card's data transformation, in which case those get
  unit tests).
- Manual, live: submit one `input-required` task per write-capable skill
  against a real running stack, screenshot each, confirm `target` is
  legible without reading the raw JSON.
- Manual: approve one, reject one, confirm outcomes are unchanged from
  pre-change behavior.

## Approval Requested

Approval authorizes restructuring the dashboard's approval-preview modal
rendering only. It does not authorize any change to `ApprovalPreview`'s
shape, the TUI, or any HTTP contract.
