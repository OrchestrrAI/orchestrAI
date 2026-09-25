# Plan: 119 — Coder verify loop, Code Review depth

> This plan cannot broaden `spec.md`. It sequences the approved scope only.

Two parts with very different risk. Part A (Code Review) adds no new capability
class and can land safely on its own. Part B (Coder execution) is
`specs/078`'s risk class 4 applied to an agent that has never executed
anything. They are phased so the safe half ships and is verified first, and so
the one genuine unknown is answered before any feature code exists.

## Phase 0 — Answer the repeated-`input-required` question (spike, no feature code)

The spec's named unknown: no task in this codebase has ever returned to
`input-required` after an approval was consumed. Before building a loop on that
assumption, prove it.

1. Trace `emitTaskState()`'s `emittedTerminal` guard, `waitForChildTask()`'s
   polling, `pendingActions`' one-entry-per-task shape, and
   `claimPendingAction()`'s single-consumption boundary against a task that
   goes `input-required` → approved → `input-required` again.
2. Build the smallest possible throwaway probe that drives exactly that
   transition through the real HTTP surface — not a unit test of the helpers.
3. Record the finding in `verification.md` **before** Phase 2 starts.

**Exit gate:** a written answer. If the shape is unsafe, adopt the stated
fallback — one task per iteration, sequenced by the caller — and record why,
rather than forcing it.

## Phase 1 — Part A: Code Review depth (independently shippable)

1. Import `packages/shared/project-analysis.ts` — never re-implement. Fail-open
   per that module's established behavior.
2. Bind `git_diff` to the harness (already in `requiredTools`, never bound).
3. Add the machine-readable findings block alongside the existing human text,
   reusing `ReviewDiffResultSchema` as-is.
4. Confirm by grep that no `NEEDS_APPROVAL`/`resumeTask`/`pendingActions` has
   appeared in this agent.

**Exit gate:** a real `review-diff` run informed by deep analysis, plus the
analysis-unavailable path degrading cleanly. This phase can be committed and
closed on its own.

## Phase 2 — Part B, step 1: the verification command, no loop yet

Land execution as a strictly linear, single-pass capability first — the loop is
what's novel, so prove the execution half without it.

1. `run_command`/`run_tests` into `requiredTools`, bound **only** to the
   approval path, never to the proposal harness.
2. `edit-and-verify` doing exactly: edit → approval → write → command proposal
   → approval → run → report. **No iteration.** Failure is reported honestly
   and the task ends.
3. Registration: `SKILL_TIER_REGISTRY`, `SUPERVISOR_ALLOWED_SKILLS`,
   `AGENT_CATALOG`, the Agent Card. Run `bun run typecheck` immediately after —
   `specs/082`'s missed `PORT_ROW_LABELS` touchpoint was found this way.
4. Assert structurally that the proposal harness binds zero write/execute
   tools.

**Exit gate:** a real edit + real approved command execution end to end, and
`edit-file`/`edit-files`' existing tests passing **unmodified**.

## Phase 3 — Part B, step 2: close the loop

1. Feed real stdout/stderr from a failed verification back into the harness.
2. Propose a follow-up fix; return to the approval step with a fresh
   `actionId`.
3. `MAX_VERIFY_ITERATIONS = 3` enforced in code as a named constant.
4. Re-run the drift recheck on every iteration, not just the first.
5. **B1 command-approval reuse.** Record the approved argv on the task itself —
   never in module-level or persisted state, so it cannot outlive the task or
   survive a restart. Comparison is exact array equality, no normalization.
   Write the adversarial tests (one-character difference, second task, restart)
   in the same commit as the mechanism, not after.

**Exit gate:** the decisive live scenario — a deliberately broken first edit,
caught by a real command, fixed by a real follow-up iteration.

## Phase 4 — Adversarial and bounds

Rejection mid-loop leaves nothing written; the bound terminates a
non-converging loop honestly; a stale approval is refused on iteration 2+.

## Phase 5 — Docs and closure

`CLAUDE.md` gains present-tense current-state sentences plus `See specs/119`
(per `specs/118`'s budget — narrative belongs in `verification.md`). Worklog
entry. Full gates.

## Rollback

Phases are commit boundaries. Part A is independent of Part B. Phase 2 is
useful on its own even if Phase 3 is abandoned — a single-pass verified edit is
a real improvement over today. Nothing before Phase 2 touches execution at all.
