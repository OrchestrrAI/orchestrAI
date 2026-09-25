---
id: 112-plan-step-no-agent-inspection-fallback
title: "dispatchPlanStep() Gains the Same No-Agent Inspection Fallback dispatchRootTask() Already Has"
area: orchestrator
change_type: fix
status: implemented
verification: partial
created: 2026-09-22
updated: 2026-09-22
approved_by: Yusuf
approved_on: 2026-09-22
implemented_on: 2026-09-22
amends:
  - 102-orchestrator-readonly-project-inspection
  - 028-orchestrator-langgraph-supervisor
  - 075-real-conversational-chat
related:
  - 104-deferred-work-register
  - 060-supervisor-parallel-read-only-dispatch
supersedes: []
superseded_by: []
---

# Spec: dispatchPlanStep() Gains the Same No-Agent Inspection Fallback dispatchRootTask() Already Has

> Status: **IMPLEMENTED, 2026-09-22.** `specs/104` item A7, drafted
> after a full trace of the real call chain
> (`dispatchPlanStep()` → the adaptive supervisor's own `dispatch()`/
> `wait()` contract → `classifyDispatchOutcome()` → `composeSupervisorResult()`)
> confirmed the fix is smaller and lower-risk than that item's own short
> register entry implied: every downstream consumer is already generic
> over "any real child task," so the entire change is contained inside
> `dispatchPlanStep()`'s own `!agent` branch — nothing else needs to
> change.

## Current behavior (verified against the real code)

`specs/102` gave `dispatchRootTask()` (`apps/orchestrator/index.ts:2086`)
an inspection fallback: when no agent is online for a skill in
`INSPECTION_FALLBACK_SKILLS` (`analyze-project`, `git-status`, line
427), instead of failing outright it calls
`inspectTargetProjectAsTaskResult()` (line 429) and completes the task
with a real, LLM-grounded answer from the Orchestrator's own MCP
client.

`dispatchPlanStep()` (line 1156) — the function the adaptive supervisor
uses to dispatch each step of a `plan-task` run — is a genuinely
separate code path with **no such fallback**:

```ts
export async function dispatchPlanStep(
  step: PlanStep,
  parentTask: OrchestratorTask
): Promise<string | null> {
  const agent = findAgentForSkill(step.skill)
  if (!agent) {
    console.log(`No agent for skill: ${step.skill} — skipping`)
    step.status = "failed"
    return null
  }
  ...
```

**Concrete consequence, traced through the real downstream code, not
assumed**: `buildOrchestratorSupervisorDeps()`'s own `dispatch()`
wrapper (line 1307) appends the `PlanStep` to `parentTask.planSteps`
*before* calling `dispatchPlanStep()`, so a `null` return leaves that
step permanently `childTaskId`-less. `composeSupervisorResult()` (line
1447) — the function that composes the user-visible summary of a
completed `plan-task` run — has an explicit branch for exactly this
shape: `if (!child) { lines.push(...'not dispatched'); continue }`. So
today, a plan step the supervisor dispatches for a skill nobody
currently owns (e.g. `analyze-project` or `git-status` with DevOps
offline) silently reports "not dispatched" in the final summary, even
though the Orchestrator could answer it directly — the exact capability
`dispatchRootTask()` already has for a *direct* (non-plan) request to
the same skill.

## Proposed behavior

Mirror `dispatchRootTask()`'s own fallback inside `dispatchPlanStep()`'s
`!agent` branch, synthesizing a real child task rather than just
marking the step failed:

```ts
export async function dispatchPlanStep(
  step: PlanStep,
  parentTask: OrchestratorTask
): Promise<string | null> {
  const agent = findAgentForSkill(step.skill)
  if (!agent) {
    // specs/112 (specs/104 item A7) — dispatchRootTask()'s own no-agent
    // inspection fallback (specs/102), applied here too: for the narrow
    // set of skills the Orchestrator can genuinely answer itself,
    // synthesize a real child task instead of failing the step
    // outright. The returned id flows through the exact same machinery
    // a real agent-dispatched child already uses — buildOrchestrator-
    // SupervisorDeps()'s own dispatch() wrapper, waitForChildTask(),
    // classifyDispatchOutcome(), composeSupervisorResult() — none of
    // which need to change, since all four are already generic over
    // "any real child task," not specific to an agent-dispatched one.
    if (INSPECTION_FALLBACK_SKILLS.has(step.skill)) {
      const childTaskId = allocateId("child", (candidate) => tasks.has(candidate))
      const childTask: OrchestratorTask = {
        id: childTaskId,
        text: `${step.skill}: ${step.description} — ${parentTask.text}`,
        skill: step.skill,
        assignedAgent: "orchestrator",
        status: "working",
        createdAt: new Date(),
        parentTaskId: parentTask.id,
      }
      tasks.set(childTaskId, childTask)
      runStarted(childTaskId)
      emit({
        type: "STEP_STARTED",
        runId: parentTask.id,
        stepName: `${step.order}. ${step.skill}`,
        timestamp: now(),
      })
      step.childTaskId = childTaskId
      step.status = "dispatched"

      void inspectTargetProjectAsTaskResult(step.skill, childTask.text, `orch-${childTaskId}`).then((result) => {
        if (result !== null) {
          childTask.status = "completed"
          childTask.result = result
        } else {
          childTask.status = "failed"
          childTask.error = `No agent found for skill: ${step.skill}`
        }
        tasks.set(childTaskId, childTask)
        emitTaskState(childTask)
      })

      console.log(`Dispatched step ${step.order} [${step.skill}] → orchestrator (self-inspection, child: ${childTaskId})`)
      return childTaskId
    }

    console.log(`No agent for skill: ${step.skill} — skipping`)
    step.status = "failed"
    return null
  }
  ...
```

**Why nothing downstream needs to change, confirmed by direct read of
each function, not assumed**:

- `buildOrchestratorSupervisorDeps()`'s own `dispatch()` wrapper (line
  1307) already appends whatever id `dispatchPlanStep()` returns to
  `parentTask.childTaskIds` unconditionally — it has no branch on
  *how* that id was produced.
- `waitForChildTask()`'s polling loop reads `tasks.get(childTaskId)`
  directly from the same in-memory Map every task already lives in;
  its own `syncTaskStatus(child)` call is a safe no-op for the
  synthesized child (its very first line is `if (!task.agentTaskId ||
  !task.assignedAgent) return task` — the synthesized child never sets
  `agentTaskId`, since there is no real remote agent task to poll).
- `deps.wait()`'s own `STEP_FINISHED` emission and audit push already
  key off `child.status`, not off which code path produced the child —
  correctly fires once the async inspection call above resolves and
  `waitForChildTask()`'s next poll observes the terminal status.
- `classifyDispatchOutcome()` and `composeSupervisorResult()` both
  already read generically from `WaitResult`/`step.childTaskId` — no
  awareness of "agent-dispatched" vs. "self-answered" is threaded
  through either.
- `emitTaskState(childTask)` on completion/failure mirrors exactly what
  `applyAgentUpdate()` (the function a *real* agent-dispatched child's
  own status sync already calls, line 1058) already does uniformly for
  both outcomes — chosen over `dispatchRootTask()`'s own divergent
  failure-branch shape (which calls `runError()` directly and manually
  manages `emittedTerminal`) specifically because a plan-step child is
  always polled the same way a real agent-dispatched child is, and
  should resolve through the identical code path other child tasks
  already use.

`inspectTargetProjectAsTaskResult()` is called with no `conversationId`
— confirmed `OrchestratorTask` carries no such field at all, so a
plan-step dispatch (which has no conversation concept today, unlike
`dispatchRootTask()`'s own optional parameter) simply never populates
or reads `specs/057`'s cross-request snapshot cache for this call,
consistent with `dispatchPlanStep()`'s own existing design, not a
regression.

## Scope

In scope: the `dispatchPlanStep()` change above, its own focused tests,
closing `specs/104` item A7.

Out of scope: any change to `dispatchRootTask()` (already correct,
untouched), `buildOrchestratorSupervisorDeps()`, `waitForChildTask()`,
`classifyDispatchOutcome()`, or `composeSupervisorResult()` — all four
confirmed to need zero changes by direct trace above. Widening
`INSPECTION_FALLBACK_SKILLS` beyond its current two members
(`analyze-project`, `git-status`) is not attempted here — this spec
reuses the existing set exactly as `specs/102` defined it.

## Safety constraints

- `INSPECTION_FALLBACK_SKILLS` is read-only by construction
  (`analyze-project`, `git-status` — Tier 2 in this codebase's own
  registry); this fix cannot cause a write-capable skill to bypass
  agent dispatch, since it only ever fires for skills already in that
  fixed, read-only set.
- The approval gate is completely untouched — a synthesized child task
  never carries an `approval` field and is never routed through
  `POST /tasks/:id/approve`.
- Fail-open, matching `dispatchRootTask()`'s own precedent exactly: if
  `inspectTargetProjectAsTaskResult()` itself returns `null` (no
  resolvable key, unresolvable path, or a genuine call failure — the
  same conditions that function already handles), the synthesized child
  fails with the identical `"No agent found for skill: <skill>"`
  message the step would have surfaced before this spec, just via a
  real (if failed) child task instead of a step with no child at all —
  `composeSupervisorResult()` now reports the real failure reason
  instead of the less specific "not dispatched."

## Acceptance criteria

- [x] A `plan-task` run whose supervisor dispatches `analyze-project` or
      `git-status` with no agent online for that skill synthesizes a
      real child task and completes it with a genuine, grounded
      inspection result, reported correctly by `composeSupervisorResult()`.
      Unit-tested end to end (synchronous dispatch + asynchronous
      resolution) — see Verification Results below for why a live pass
      of this specific scenario was not additionally performed.
- [x] The identical scenario for a skill *not* in
      `INSPECTION_FALLBACK_SKILLS` (e.g. `dockerize` with no agent
      online) is unchanged — the step still just fails, no fallback
      attempted. Confirmed by the pre-existing "stale/offline agent
      fails closed" regression test, updated to use `dockerize` instead
      of `git-status` (since `git-status` is no longer a case where
      that specific assertion holds); the pre-existing, unmodified
      `audit-dependencies` "removed from the registry" test already
      covered a second non-fallback skill and needed no change.
- [x] A synthesized child task's own `GET /tasks/:childId` reaches a
      genuine terminal AG-UI lifecycle (`RUN_STARTED` at dispatch,
      `RUN_FINISHED`/`RUN_ERROR` at resolution) — confirmed via
      `emitTaskState()`'s own existing behavior, not a new emission
      path. Verified structurally (the same `runStarted()`/
      `emitTaskState()` calls a real agent-dispatched child already
      goes through), not independently re-traced through the AG-UI
      wire format itself.
- [x] `inspectTargetProjectAsTaskResult()` itself failing (no key, etc.)
      produces a real, distinct failed child task and step outcome, not
      a silent hang or an unhandled rejection. Unit-tested with a
      real thrown error from the fake MCP client.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `specs/104-deferred-work-register/spec.md` updated: A7 marked
      closed, pointing at this spec's number.

## Verification plan

- Unit: `apps/orchestrator/supervisor-*.test.ts` (or a new focused
  file) exercising `dispatchPlanStep()` directly with a fake
  `parentTask`/`step` and no online agent for an inspection-fallback
  skill, asserting a real childTaskId is returned and
  `parentTask.planSteps`'s own entry carries it; and the unchanged
  "skill not in the fallback set" case still returns `null`.
- Live (proportional — read-only skills only, no approval-gated write
  path touched): a real scratch stack with the Orchestrator running
  alone (no DevOps), a real `plan-task` request whose supervisor
  attempts `analyze-project`, confirming the run's own final result
  contains a real grounded analysis rather than "not dispatched," and
  the synthesized child's own task record is independently fetchable.

## Non-goals

- Orchestrator-side restart recovery of an in-flight synthesized child
  (same standing gap `specs/110` already named for every other
  in-flight state).
- Widening `INSPECTION_FALLBACK_SKILLS` to any additional skill.
- Any change to `dispatchRootTask()`'s own, already-correct fallback.
