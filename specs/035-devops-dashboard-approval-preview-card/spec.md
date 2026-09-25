---
id: 035-devops-dashboard-approval-preview-card
title: Extend the Approval-Preview Card to the DevOps Agent's Own Dashboard
area: dashboard
change_type: enhancement
status: implemented
verification: verified
created: 2026-08-22
updated: 2026-09-01
approved_by: Yusuf
approved_on: 2026-08-22
implemented_on: 2026-08-22
amends:
  - 033-dashboard-approval-preview-card
supersedes: []
superseded_by: []
related:
  - 006-runtime-stabilization
  - 030-authoritative-skill-dispatch-and-capability-catalog
---

# Spec: Extend the Approval-Preview Card to the DevOps Agent's Own Dashboard

## Purpose

`specs/033-dashboard-approval-preview-card/spec.md` replaced the
Orchestrator dashboard's (`:3000`) raw-JSON approval-preview modal with a
labeled, structured card. That spec's own Scope section only ever named
`apps/orchestrator/index.ts` — it did not cover any individual agent's own
dashboard. This checkpoint closes that specific gap for the DevOps agent's
dashboard (`:3002`), which is the one an operator or a judge is most likely
to open directly, since it is where DevOps's own write-capable skills
(`dockerize`, `create-ci`, `create-gitignore`, `create-compose`) actually
surface an `input-required` approval.

## How this was found

Found live, not hypothesized: during judge-script rehearsal
(`context/demo/judge-script.md`), a screenshot of DevOps's own approval
modal showed the exact undifferentiated `JSON.stringify(approval, null, 2)`
dump that spec 033 had already fixed on the Orchestrator's dashboard. Read
both dashboards' source directly to confirm: `apps/orchestrator/index.ts`'s
`view(id)` calls `renderApprovalCard()`; `packages/agents/devops/index.ts`'s
`viewApproval(id)` (line ~617, pre-change) set `#modal-body` to raw JSON
with no card path at all. Spec 033 never claimed otherwise — this is a
scope gap in that spec, not a regression of it.

## Verified Current State (pre-change)

- `packages/agents/devops/index.ts`'s `viewApproval(id)`: fetches the task,
  sets the modal title, and writes
  `JSON.stringify(d.approval, null, 2)` into `#modal-body` via
  `.textContent` — identical in kind to the Orchestrator's pre-033
  behavior.
- No `renderApprovalCard()`, no approval-card CSS classes, no raw-JSON
  toggle existed anywhere in `packages/agents/devops/index.ts`.
- `viewResult(id)` and `viewError(id)` are separate functions (unlike the
  Orchestrator's single state-branching `view(id)`), each independently
  setting `#modal-body`.

## Proposed / Implemented Behavior

1. Ported `renderApprovalCard()`, the client-side `escapeHtml()`, and the
   approval-card CSS classes (`.approval-card`, `.approval-row`,
   `.approval-label`, `.approval-target`, `.approval-action`,
   `.approval-params`, `.approval-risks`, `.approval-actionid`,
   `.approval-rawtoggle`) verbatim from `apps/orchestrator/index.ts` into
   `packages/agents/devops/index.ts`.
2. `viewApproval(id)` now renders the structured card by default (target,
   action, parameters, risks, de-emphasized `actionId`) with a "Show raw
   JSON" toggle that reveals the byte-identical
   `JSON.stringify(approval, null, 2)` — same behavior contract as 033.
3. Added `resetModalToPlainBody()`, called from `viewResult()` and
   `viewError()`, so a previously-rendered approval card and its raw-JSON
   toggle don't leak into a later Result/Error modal. This didn't apply to
   the Orchestrator's implementation because it uses one function branching
   on task state, not three independent `view*` functions.
4. No change to any HTTP endpoint, the `ApprovalPreview` shape, or the
   approve/reject request/response contract — identical safety constraint
   to spec 033.

## Safety Constraints

Identical to `specs/033`'s, restated for this surface:

- No new data is sent to or requested from the server; every field the
  card displays is already in the existing `GET /tasks/:id` response.
- The card renders exactly the `ApprovalPreview` object already returned —
  no client-side reconstruction or reinterpretation of `target` or any
  other field.
- The raw-JSON toggle is read-only. Approving remains exactly
  `POST /tasks/:id/approve` with the stored `actionId`.

## Scope

- `packages/agents/devops/index.ts` — `viewApproval()`, `viewResult()`,
  `viewError()`, the new `renderApprovalCard()`/`escapeHtml()`/
  `resetModalToPlainBody()` client-side functions, and the associated
  inline CSS in the dashboard's `<style>` block.
- `context/worklog.md` (already updated, same work session).

## Out of Scope / Non-Goals

- The TUI's Detail view — still the same deliberately separate follow-up
  named in spec 033, untouched by this checkpoint.
- Testing, Documentation, Planning, or Security agents' own dashboards.
  DevOps was the one found broken live and the one in active use for demo
  rehearsal; the same gap likely exists on Testing's and Documentation's
  dashboards (both have write-capable, approval-gated skills) but neither
  was inspected or changed in this pass — a natural next candidate, not
  assumed fixed by this checkpoint.
- Any change to `ApprovalPreview`'s shape, the approval gate's logic, or
  any HTTP contract.

## Process note

This was implemented directly on Yusuf's explicit live instruction ("fix
it in the devops") during active demo rehearsal, before this spec document
existed — a deliberate, acknowledged deviation from this repo's normal
spec-first sequencing (CLAUDE.md's Working Procedure step 8), made for
time-sensitivity, not by default. This document is the retroactive
governance record the process requires, matching the same pattern already
used for prior fast-tracked fixes this session. `approved_by`/
`approved_on` reflect that the instruction to implement was itself the
approval, given directly and explicitly by Yusuf in the same conversation.

## Acceptance Criteria

- [x] `viewApproval()` on the DevOps dashboard renders the structured card
      by default, with `target` as its own visually distinct line.
- [x] The raw-JSON toggle, when expanded, is byte-identical to the
      previous unconditional `JSON.stringify(approval, null, 2)` output.
- [x] No new field requested from or sent to the server beyond what
      `GET /tasks/:id` already returns.
- [x] `bun test` (307 passed, 0 failed) and `bun run typecheck` (0 errors)
      both pass unchanged.
- [x] Generated HTML verified in-process (exported Hono `app.fetch()`
      called directly against `/dashboard`, no port bind) to contain the
      new card markup and script functions.
- [x] **Live click-through in a real browser**, against a real
      `input-required` DevOps task: card renders correctly, raw-JSON
      toggle works, approve/reject still function unchanged. Confirmed
      directly by Yusuf ("35 is verified all is good") — closes the one
      item that had kept `verification: partial`.
- [x] `context/worklog.md` entry cross-referenced with this spec's ID.

## Verification Plan

- Automated: already run — full suite, typecheck (see Acceptance
  Criteria above).
- Manual, live (outstanding): open `http://localhost:3002/dashboard`
  against a real running stack, trigger a task that reaches
  `input-required` (e.g. the `dockerize` step from
  `context/demo/judge-script.md`'s Scene 2), click "Approval preview",
  confirm the card renders with `target` legible without expanding raw
  JSON, click "Show raw JSON" and confirm it matches
  `GET /tasks/:id`'s `approval` field exactly, then approve or reject and
  confirm the outcome is unchanged from pre-change behavior.

## Approval Requested

None — already granted verbally and implemented; this document exists to
give that decision a governed, catalogued record. Approval, as recorded,
covers only the DevOps dashboard's approval-preview rendering; it does not
extend to Testing's, Documentation's, Planning's, or Security's dashboards,
the TUI, or any change to `ApprovalPreview`'s shape or HTTP contracts.
