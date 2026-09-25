---
id: 139-close-remaining-follow-ups
title: Close the Remaining Follow-ups From Specs 130–137
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
  - 130-tui-dashboard-parity
  - 137-plan-step-acts-only-on-its-own-step
supersedes: []
superseded_by: []
related:
  - 110-approval-state-survives-a-restart
  - 119-coder-verify-loop-and-reviewer-depth
  - 135-tui-80-column-header-and-titles
  - 136-orchestrator-task-and-agent-metadata
---

# Spec: Close the Remaining Follow-ups From Specs 130–137

> Status: **APPROVED by Muhamad-Yussuf on 2026-09-25** ("ok approved"). **IMPLEMENTED and VERIFIED** the same day — see `verification.md` (D is unit-verified, as the spec allows).

## Purpose

After specs 130–137, three small items remain open. They are recorded in
those specs' `verification.md` files:

- **B.** Two spec 130 phase 4 items were never observed live:
  - the Tasks row text `child of <id> · …`;
  - the immediate refresh on `RUN_FINISHED`/`RUN_ERROR`.

  Spec 130 is therefore still `verification: partial`.
- **C.** At 80 columns, a long Audit row wraps onto a second line inside
  the Audit scrollbox (`specs/135` verification, "Noted, not changed").
- **D.** `edit-and-verify`'s *fix* iterations get only the step
  instruction, without the plan background (`specs/137` verification,
  "Limits"), because the background was not persisted with the pending
  action.

(Item A, model-authored files, is `specs/138`. The two model-judgment
behaviors, specs 133/134, are accepted by design and not reopened here.)

## Verified Current State

- **B.**
  - `formatTaskRowText()` (`apps/tui/tui-state.ts`) prefixes
    `child of <shortTaskId(parent)> · ` for a plan step, and is
    unit-tested.
  - The SSE handler in `apps/tui/index.tsx` calls `pollNowRef.current?.()`
    and `chatRefreshNowRef.current?.()` on `RUN_FINISHED`/`RUN_ERROR`.
  - Neither was captured in a real terminal. The live runs in 133–137
    either had no plan in the Tasks view, or weren't timed.
- **C.** The Audit row (`apps/tui/index.tsx`, Audit view) is several
  coloured `<span>`s:
  - status glyph, time, kind badge, caller, arrow;
  - the target, bounded to `centerWidth - 58`;
  - `outcome · duration · bytes`, and ` trunc`.

  Only the target is bounded, so a long caller (`orchestrator-supervisor`)
  or a long time string pushes the row past the box width. Observed at
  80×24: `✓ 9:03:51 AM A2A orchestrator-supervisor → git-status ·
  completed ·` wraps its `1020ms · 0B`.
- **D.**
  - The persisted `EditAndVerifyEditActionSchema` and
    `EditAndVerifyCommandActionSchema` (`packages/agents/coder/index.ts:328`,
    `:346`) carry `originalInstruction`, but no plan background.
  - `verify-loop.ts:281` calls
    `runEditFilesHarness({ …, instruction: fixInstruction })` without
    `context`.
  - `z.object` accepts rows without an optional field, so adding one keeps
    rows persisted before this change valid.

## Proposed Behavior

### B. Observe both remaining spec 130 items live, fixing only if they fail
- **`child of`:** a real plan with two steps in the TUI Tasks view, at
  140×40 and 80×24. Each child row reads `↳ … child of <8-char id> · <step
  text>`, and the truncation still fits the row.
- **Early refresh:** measure it rather than assume it.
  - Subscribe to `GET /events` alongside the TUI, and capture the TUI
    screen every 100 ms while a read-only task finishes.
  - Record the delay from the `RUN_FINISHED` event to the row showing
    `completed`, over at least 3 runs.
  - Pass if every delay is below the 1.5 s poll interval (so the refresh,
    not the next poll, updated the row).
  - If it fails, fix the SSE path within this spec.
- On success, spec 130's `verification` moves to `verified`.

### C. One Audit row is always one line
- The row keeps its colours. Every variable-length part (caller, target)
  is bounded by a pure helper `fitAuditRow()` (`apps/tui/tui-state.ts`):
  - it takes the fixed parts' real lengths (time string, badge, outcome,
    duration, bytes, trunc);
  - it gives the caller and the target the remaining width (the target
    first, and the caller down to a minimum of 6);
  - the whole row never exceeds `centerWidth - 4` (border + padding).
- Unit-tested at 80, 110 and 140 columns with the longest real values.

### D. `edit-and-verify` fix iterations keep the plan background
- Both `EditAndVerify…ActionSchema`s gain an optional
  `planContext: z.string().optional()`.
  - It is set from `splitPlanStepText(text).context` when the task starts.
  - It is carried through each iteration's pending action.
  - It is passed as `context` to every fix-iteration `runEditFilesHarness()`
    call.
- A row persisted before this change (no `planContext`) restores and
  behaves exactly as today.

## Scope

- **B:** no code unless the measurement fails. A scratch PTY driver plus an
  `/events` listener (never committed). Then `specs/130` frontmatter,
  checkboxes and `verification.md`.
- **C:** `apps/tui/tui-state.ts` (`fitAuditRow`) + tests;
  `apps/tui/index.tsx` Audit row.
- **D:** `packages/agents/coder/index.ts` (schemas, the start of
  `edit-and-verify`), `packages/agents/coder/verify-loop.ts`, and tests
  (`verify-loop.test.ts`, including a restore of a pre-change row).
- `CLAUDE.md` only if a present-tense fact changes; the worklog; this
  spec's `verification.md`.

## Safety and Compatibility Constraints

- No approval, fingerprint, tier or protocol change.
- **D** is additive to a persisted schema (`specs/110`). Old rows stay valid;
  new rows carry one extra optional string. The fail-closed Zod restore
  gate is unchanged.
- **C** changes rendering only, with heights untouched. The Audit scrollbox
  keeps its height from `computeShellChatScrollHeight()`.

## Out of Scope / Non-Goals

- Anything in `specs/138`.
- Deterministic guards for the specs 133/134 model-judgment behaviors.
- Other Audit or TUI redesign.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] B: `child of <id>` seen live at 140×40 and 80×24, fitting the row.
- [x] B: the early-refresh delay is measured over at least 3 runs, each
      below 1.5 s. Spec 130 is then `verification: verified`.
- [x] C: `fitAuditRow()` keeps every row within `centerWidth - 4` at 80, 110
      and 140 columns (unit-tested). Live at 80×24, no Audit row wraps.
- [x] D: fix iterations receive `context` (unit test with a recording
      model). A pre-change persisted row restores and runs without it
      (restore test). Live, an `edit-and-verify` plan step whose first
      verification fails gets the background in its fix proposal (if a
      failing verification can be arranged on a scratch copy; otherwise
      recorded as unit-verified only).
- [x] `bun run typecheck` 0 errors; `bun test` no regressions.
- [x] Documentation and worklog are updated.

## Verification Plan

As in Proposed Behavior:
- the real-PTY captures and `/events` timing for B;
- unit tests plus an 80×24 capture for C;
- unit and restore tests for D, plus a live run on a scratch copy of the
  fixture if a failing verification can be arranged.

Reject every approval that isn't on the scratch copy, and confirm the
fixture's hash baseline.

## Approval Requested

Approval authorizes:
- the live measurements for B, and an SSE-path fix only if they fail;
- `fitAuditRow()` and its use in the Audit row (C);
- the optional `planContext` on the two edit-and-verify pending-action
  schemas, and its use in fix iterations (D).

Nothing else.
