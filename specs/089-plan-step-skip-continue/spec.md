---
id: 089-plan-step-skip-continue
title: "A Third Approval Outcome — Skip One Write-Capable Plan Step Without Ending the Whole Plan"
area: orchestrator
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-15
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-15
implemented_on: 2026-09-15
amends:
  - 028-orchestrator-langgraph-supervisor
  - 012-tui-interactive
  - 033-dashboard-approval-preview-card
  - 035-devops-dashboard-approval-preview-card
related:
  - 037-tui-approval-preview-card
  - 060-supervisor-parallel-read-only-dispatch
supersedes: []
superseded_by: []
---

# Spec: A Third Approval Outcome — Skip One Write-Capable Plan Step Without Ending the Whole Plan

> Status: **APPROVED 2026-09-15 by Yusuf — Option B (writes still allowed after a
> skip, each with its own normal approve/reject/skip prompt).** Raised directly by
> Yusuf while live-testing a real `plan-task` run, 2026-09-15: *"i think not to
> cansel the whole plan just skip this step"* — after `reject`ing one write step
> ended the entire plan (`specs/028`'s own designed "rejection is terminal"
> behavior), rather than letting the plan continue to whatever came next.
>
> **Option A vs B, decided 2026-09-15.** After a walkthrough, Yusuf's own concrete
> scenario made the choice clear: *"so if it asked me to dockerize and i skiped it
> may ask again for like the ci so i can accept or refuse what the issue here?"* —
> confirming Option B is what's actually wanted: skip one step, keep being asked
> about every other write normally, each with its own full preview and its own
> separate approve/reject/skip. The residual gap Option B accepts (nothing
> structurally stops a *different* skill from achieving something similar to what
> was skipped — only a skill-id-literal block plus a prompt instruction guard
> against it) is judged acceptable specifically **because every subsequent write
> still shows its own full content preview before approval** (`specs/040`) — the
> human reviewing that preview is the real safety net for this residual case, not
> a structural block.

## Purpose

Today, a `plan-task` run's approval gate has exactly two outcomes for a write-capable
step: **approve** (the write happens, the plan continues) or **reject** (the write
never happens, and — by `specs/028`'s own explicit design — the entire plan ends
right there; the supervisor is never consulted again for that run). There is no way
to say *"don't do this one specific thing, but let the rest of the plan keep going."*
A user who objects to exactly one proposed write currently has to choose between
accepting it or throwing away every step that would have come after it, even steps
that have nothing to do with the objection.

## Verified Current State

- `apps/orchestrator/supervisor-graph.ts`'s `classifyDispatchOutcome()` maps a
  dispatch's real outcome to one of exactly five `DispatchOutcome` values:
  `completed`, `rejected`, `failed-safe`, `failed-ambiguous`, `timeout`. Only
  `completed` and `failed-safe` (a **read-only** skill's failure) let the graph loop
  continue to another supervisor decision; `rejected`, `failed-ambiguous`, and
  `timeout` are all terminal — the run ends.
- `rejected` is detected from `rejectedByOrchestrator` (`apps/orchestrator/index.ts`),
  a `Set<string>` populated only at `POST /tasks/:id/reject`'s own success point —
  never inferred from task status or error text, which a rejection and a genuine
  failure currently produce identically.
- **The specific adversarial case `specs/028`'s own tests check**: a rejected
  `dockerize` must never be followed by `create-compose` attempting the same
  effect. This is exactly the risk a naive "skip and keep going" would reopen if a
  skipped write is treated by the supervisor as "try something else, then" rather
  than "this one thing is off-limits."
- `POST /tasks/:id/approve` and `POST /tasks/:id/reject` both require the matching,
  server-issued `actionId` bound to immutable pending parameters (`specs/006`) — a
  missing one is HTTP 400, a stale/mismatched one is HTTP 409.
- The TUI's own `a`×2/`r`×2 double-press-confirm pattern (`specs/012`) and both
  browser dashboards' approval cards (`specs/033`/`035`/`037`) currently expose only
  these two actions.

## The Core Design Question (resolved — Option B)

**How much of the "don't silently re-achieve a rejected effect a different way"
guarantee does `skip` need to keep?** Two real options were weighed, not a false
binary — the tradeoff, and Yusuf's own resolution:

- **Option A — skip ends future *writes*, not the whole plan.** Once a step is
  skipped, the supervisor may still be re-consulted, but only read-only skills
  are permitted for the remainder of the run — any further write-capable
  proposal is refused, ending the run there. Preserves almost all of
  `specs/028`'s "no write can substitute for the skipped one" guarantee
  structurally, but means the plan can never ask about any *other* write again
  either, even a completely unrelated one (e.g. `create-ci` after skipping
  `dockerize`).
- **Option B (chosen) — skip lets the supervisor keep proposing writes too.**
  Closer to what "skip" colloquially means, and what Yusuf's own concrete
  scenario confirmed he wants: skip `dockerize`, still get asked about `create-ci`
  normally, with its own full preview and its own separate approve/reject/skip.
  The residual risk Option B accepts — nothing structurally stops a *different*
  skill from achieving something similar to what was skipped, only (1) a
  structural block on re-proposing the **literal same skill id** in this run (an
  explicit `skippedSkillIds: Set<string>` the graph refuses to dispatch again —
  enforced in code) and (2) a fed-back observation telling the model plainly the
  step was skipped and should not be worked around — is judged acceptable
  **because every subsequent write, regardless of which skill, still shows its
  own full content preview before approval** (`specs/040`'s diff rendering,
  completely unchanged). The human reviewing that preview — not a structural
  block on the skill graph — is what actually catches a disguised
  similar-effect write under Option B; every write is still fully inspectable
  and individually gated, never silently approved.

This spec implements **Option B**.

## Proposed Behavior (Option B)

- **New endpoint**: `POST /tasks/:id/skip`, mirroring `reject`'s own exact
  validation shape — a matching `actionId` required (400 if missing, 409 if
  stale/mismatched), no write executes, immutable pending parameters untouched.
  Only meaningful for a **plan step's own child task** — a direct (non-plan) task
  has no "next step" to continue to, so `skip` on one is refused with a named
  error telling the caller to use `reject` instead.
- **`skippedByOrchestrator`**, a new `Set<string>` mirroring `rejectedByOrchestrator`
  exactly, populated only at this endpoint's own success point.
- **New `DispatchOutcome` value: `"skipped"`.** `classifyDispatchOutcome()` checks
  `skippedByOrchestrator` before the existing `rejectedByOrchestrator` check
  (both produce the identical `{status:"failed", error:"..."}` shape from the
  agent's own perspective, exactly like `rejected` already does — the
  Orchestrator's own record is still what disambiguates, never task status/error
  text).
- **The graph loop continues on `"skipped"`**, exactly like `"failed-safe"` does
  today — a `HumanMessage` observation is appended (`"Step N (<skill>) was
  explicitly skipped by the user — do not attempt this exact step or a
  workaround that achieves the same effect."`) and the supervisor is
  re-consulted normally, free to propose **any** further step, read-only or
  write-capable, exactly like it would after a `completed`/`failed-safe` step
  today.
- **The Option B guarantee, enforced in code (not merely prompted for)**: the
  literal skipped skill id itself may never be re-proposed in the same run —
  a `skippedSkillIds` list, accumulated in the graph's own state (mirroring
  how `dispatchedWriteKeys` is already tracked), that `dispatchNode()`'s own
  validation checks before ever dispatching. A proposal naming an
  already-skipped skill is refused **the same way an already-dispatched write
  is already refused today** (the existing `duplicate-write-refused` shape,
  non-terminal): `deps.dispatch()` is never called, a `HumanMessage` observation
  tells the model plainly to choose something else, and the supervisor is
  re-consulted normally — the run is not ended by this refusal alone. Every
  *other* skill — write-capable or read-only — dispatches exactly as it does
  today, each reaching its own normal approval gate when write-capable, with
  its own full content preview (`specs/040`) shown before any human decision.
- **UI**: a third keybinding in the TUI's approval flow (`s`×2, mirroring `a`×2/
  `r`×2's existing double-press-confirm convention exactly) and a third button
  on the Orchestrator dashboard's own approval cards, visible **only** when the
  pending approval belongs to a plan step (never a direct task's own approval,
  matching the endpoint's own scope restriction above). See the Scope
  section's own correction for why DevOps's dashboard is out of scope.

## Scope

- `apps/orchestrator/index.ts`: new `POST /tasks/:id/skip` route,
  `skippedByOrchestrator` set.
- `apps/orchestrator/supervisor-graph.ts`: `DispatchOutcome` gains `"skipped"`;
  `classifyDispatchOutcome()`'s own check ordering; a new per-run
  `skippedSkillIds: Set<string>` that `dispatchNode()`'s own validation checks
  before dispatching, refusing only the literal skipped skill id(s).
- `apps/tui/index.tsx` (+ `apps/tui/format-approval-rows.ts` if the row rendering
  needs a third action hint): the `s`×2 keybinding, scoped to plan-step approvals
  only.
- `apps/orchestrator/index.ts`'s inline dashboard script (both the Tasks
  table row and the chat-linked/modal approval cards) — a third button,
  scoped to a plan step's own child task exactly like the endpoint itself.
  **Scope correction, found during implementation, not assumed away**:
  `apps/agents/devops/index.ts`'s own dashboard has no `parentTaskId`
  concept at all — an agent receives a task via A2A with no visibility
  into whether the Orchestrator considers it a plan step's own child or a
  direct submission, and its approve/reject buttons submit directly to
  the agent's own task-id space (`http://localhost:3002/tasks/:id/reject`),
  never the Orchestrator's. There is no architecturally correct way to
  wire a Skip button there — "continue the plan" is a concept that exists
  only at the Orchestrator, which is the only place that has the full
  parent/child relationship visibility. DevOps's own dashboard is
  therefore genuinely out of scope for this spec, not merely deferred.
- **Out of scope**: Option A (skip that ends all future writes for the run) —
  considered, not chosen; any change to direct (non-plan) task approval, which
  keeps exactly its current two-outcome shape; any change to `reject`'s own
  existing terminal behavior, which stays byte-identical.

## Safety and Compatibility Constraints

- **`reject`'s own existing behavior is completely unchanged** — this adds a
  third, distinct outcome; it does not touch how `rejected` is classified,
  detected, or handled.
- **A skip can never be indistinguishable from a rejection or a real failure** —
  the same `rejectedByOrchestrator`-style Set-based, endpoint-success-point-only
  detection is reused verbatim for the new outcome.
- **The literal skipped skill id may never be re-proposed in the same run** —
  the one structural guarantee Option B keeps; refused non-terminally, the
  same `duplicate-write-refused` shape an already-dispatched write already
  uses; must have its own dedicated adversarial test (skip `dockerize`,
  confirm the model can never dispatch `dockerize` again in that run — while
  `create-ci`/other skills still dispatch normally) before this is considered
  implemented, not merely asserted.
- **Every write-capable step, including one proposed after a skip, still shows
  its own full content preview before approval** — `specs/040`'s diff
  rendering is completely unchanged by this spec; this is the load-bearing
  human safety net for the residual risk Option B knowingly accepts (a
  different skill achieving something similar to what was skipped), stated
  honestly, not glossed over.
- **`actionId` binding, 400/409 shape**: identical to `reject`'s own, no new
  validation pattern invented.

## Out of Scope / Non-Goals

- Option A (skip that ends all future writes for the run) — considered,
  Yusuf's own explicit choice was Option B instead.
- Any "undo a skip" or re-offering the skipped step later in the same run.
- Skip for a direct (non-plan) task's own approval — reject already covers
  that case completely; there is no "next step" for skip to preserve there.
- Any change to the global dispatch/per-skill-attempt bounds (`specs/028`) —
  a skip consumes no budget of its own, the same way a rejection consumes none
  today.
- Any semantic "don't do anything similar to what was skipped" enforcement
  beyond the literal skill-id block and the fed-back prompt observation — a
  materially harder, open-ended problem (detecting "similar effect" across
  structurally different skills) not attempted here; the human review of each
  subsequent write's own content preview is the accepted mitigation.

## Acceptance Criteria

- [x] `POST /tasks/:id/skip` on a plan step's own child task: correct `actionId`
      → no write executes, run continues to another supervisor decision.
- [x] `POST /tasks/:id/skip` on a **direct** (non-plan) task → refused with a
      named error pointing at `reject` instead.
- [x] Missing/stale/mismatched `actionId` on `skip` → 400/409, identical shape
      to `reject`'s own.
- [x] After a skip, a subsequent read-only step still dispatches normally
      (including a parallel read-only fan-out).
- [x] After a skip, a subsequent write-capable proposal for a **different**
      skill still dispatches and reaches a normal approval gate — the core
      Option B behavior.
- [x] After a skip, a subsequent proposal for the **literal same, already-
      skipped** skill id is refused non-terminally (the run keeps going, the
      supervisor is asked to choose something else) — the one structural
      guarantee this spec keeps, dedicated adversarial test required
      (mirroring `specs/028`'s own `dockerize`-then-`create-compose` rejection
      test, adapted for skip).
- [x] The TUI's `s`×2 keybinding only appears for a plan step's own approval,
      never a direct task's.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of a real multi-step plan: skip one write step, confirm a
      different write step later in the same plan still reaches a normal
      approval gate with its own full preview, and confirm the literal skipped
      skill can never be re-proposed.

## Verification Plan

- Unit: every acceptance criterion above, plus the adversarial
  same-skill-id-blocked case and a case proving a *different* write-capable
  skill still dispatches normally after a skip.
- Live, with a real provider key: a real multi-step plan against a real scratch
  project, skipping one real write step mid-plan, confirming a different write
  step later reaches a real approval gate with its own preview, and confirming
  the skipped skill is never re-proposed.

## Approval Requested

**APPROVED 2026-09-15 by Yusuf — Option B.**
