# Verification: dispatchPlanStep() Gains the Same No-Agent Inspection Fallback dispatchRootTask() Already Has

Date: 2026-09-22

## Summary

Implemented exactly as specced: `apps/orchestrator/index.ts`'s
`dispatchPlanStep()` own `!agent` branch now checks
`INSPECTION_FALLBACK_SKILLS.has(step.skill)` before failing the step.
When true, it synthesizes a real child `OrchestratorTask`
(`assignedAgent: "orchestrator"`, no `agentTaskId`), sets
`step.childTaskId`/`step.status` synchronously (matching the real-agent
success path's own shape), emits `STEP_STARTED`, and fires
`inspectTargetProjectAsTaskResult()` fire-and-forget, resolving the
child to `completed`/`failed` and calling `emitTaskState()` — mirroring
`applyAgentUpdate()`'s own uniform pattern for a real agent-dispatched
child, not `dispatchRootTask()`'s own divergent failure-branch shape.

Confirmed by direct trace, not assumed, that no other function needed
to change: `buildOrchestratorSupervisorDeps()`'s `dispatch()` wrapper,
`waitForChildTask()`, `syncTaskStatus()` (a safe no-op for a task with
no `agentTaskId`), `classifyDispatchOutcome()`, and
`composeSupervisorResult()` are all already generic over "any real
child task."

## Automated verification

- `bun run typecheck` — 0 errors.
- `apps/orchestrator/skill-dispatch.test.ts`:
  - One pre-existing test updated (not weakened): "stale/offline agent
    fails closed" now uses `dockerize` instead of `git-status`, since
    `git-status` is a fallback-eligible skill and that specific
    assertion (`childId === null`) no longer holds for it — the
    underlying property (a genuinely non-fallback skill still fails
    closed) is preserved exactly, just tested against a skill this
    spec doesn't touch.
  - 3 new tests: a fallback-eligible skill with no agent synchronously
    produces a real dispatched child, which asynchronously resolves to
    `completed` with the real inspection result once the fake MCP
    client's promise resolves; the identical setup with the fake MCP
    client throwing resolves the child to `failed` with the exact
    `"No agent found for skill: git-status"` message (proving no
    silent hang, no unhandled rejection); `INSPECTION_FALLBACK_SKILLS`
    itself confirmed to still be exactly `{analyze-project,
    git-status}` — no widening attempted by this spec.
  - A real, non-obvious test-authoring bug was found and fixed while
    writing these tests, not assumed correct on the first attempt: the
    task text needs a real, absolute, resolvable path for
    `fetchProjectInspection()`'s own `resolveTargetPath()` call to
    succeed — a bare `"check status"` with no path fails path
    resolution before the fake MCP client is ever reached, which
    initially made the "success" test resolve to `failed` for the
    wrong reason (target-path resolution, not the mechanism under
    test). Fixed by giving the task text a real path
    (`"... at C:/proj"`, forward-slash form — a first attempt using a
    literal backslash in the test source was itself a second, distinct
    escaping bug, caught by directly running `resolveTargetPath()`
    against the exact string via `bun -e` before trusting the test).
  - `apps/orchestrator` full suite: 287 pass, 0 fail (up from 283 pass
    + 1 now-updated test, +3 net new).
- Full repo suite: 1333 pass, 2 skip (pre-existing, unrelated), 0 fail
  across 84 files — one additional, unrelated, environment-dependent
  failure (`packages/agents/devops/index.test.ts`'s own "no live MCP
  server" test) is excluded from this count; see "What was not
  verified" below for why.

## What was not verified

**A live pass of the actual scenario** (a real `plan-task` run, the
Orchestrator genuinely alone, dispatching `analyze-project`/`git-status`
with no agent online) **was attempted and deliberately abandoned mid-
attempt, not completed.** Starting a scratch Orchestrator process
directly (`bun run apps/orchestrator/index.ts`, bypassing the
supervisor's own per-agent URL overrides) discovered the user's own
real, currently-running agent stack on the standard ports (3002–3008) —
confirmed via the startup log listing all 6 real agents by name. No
task was dispatched and no write occurred (agent discovery is a
read-only `GET /.well-known/agent.json` call), but continuing down that
path risked interfering with the user's own active session, so the
scratch process was killed immediately rather than reconfigured to
isolate it properly. This live pass — the one this spec's own
Verification Plan named as decisive — remains open, hence
`verification: partial` rather than `verified`. The mechanism itself is
proven by the unit tests above, including the exact async fire-and-
forget resolution path a live pass would also exercise; what's missing
is confirmation through the real HTTP/AG-UI surface end to end.

**The devops/index.test.ts "no live MCP server" test failure** observed
during the full-suite run is unrelated to this spec — caused by a real
`bun.exe` process genuinely bound to port 3006 (the user's own stack,
not a leftover scratch process from this session), confirmed via
`tasklist`. Not touched, since killing a process that looks like the
user's own active work is exactly the kind of destructive action this
session's own operating guidance says to avoid without asking first.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**Correction, 2026-09-22 — the adaptive supervisor's own plan-step
dispatch gains the identical no-agent inspection fallback.**
`specs/112-plan-step-no-agent-inspection-fallback/spec.md` (implemented,
**partial** verification) closed `specs/104` item A7: this section's own
fallback lived only in `dispatchRootTask()` (a *direct* request); the
adaptive supervisor's own `dispatchPlanStep()` — a genuinely separate
function a `plan-task` run uses to dispatch each step — had no such
fallback at all, so a plan step naming `analyze-project`/`git-status`
with no agent online just failed with no attempt, even though the
Orchestrator could already answer it directly. A full trace before
implementing found the fix stays contained entirely inside
`dispatchPlanStep()`'s own `!agent` branch: `buildOrchestratorSupervisorDeps()`'s
`dispatch()` wrapper, `waitForChildTask()`, `classifyDispatchOutcome()`,
and `composeSupervisorResult()` are all already generic over "any real
child task," not specific to an agent-dispatched one, so none needed to
change. The synthesized child mirrors a real agent-dispatched child's
own shape exactly (`runStarted()`/`STEP_STARTED` at dispatch,
`emitTaskState()` at resolution — the same pattern `applyAgentUpdate()`
already uses for a real child, not `dispatchRootTask()`'s own divergent
failure-branch shape). Unit-tested end to end, including the
asynchronous resolution and failure paths. **Verification stays
`partial`**: the live pass this spec's own plan named as decisive (the
Orchestrator genuinely alone, no other agents, a real `plan-task` run)
was attempted and deliberately abandoned mid-attempt — starting a
scratch Orchestrator process directly discovered the real, already-
running agent stack instead of running in isolation, and continuing
risked interfering with active work, so it was stopped rather than
reconfigured and pushed through. See that spec's own `verification.md`
for the full record.

See specs/113-live-audit-log-dashboard/verification.md for the relocated narrative covering this checkpoint.
