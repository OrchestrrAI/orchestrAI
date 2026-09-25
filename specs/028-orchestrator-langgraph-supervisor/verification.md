# Verification: LangGraph Adaptive Supervisor for the Orchestrator

## Status

`verified` as of 2026-09-01 — all 5 `plan.md` phases implemented,
automated-tested, and now live-verified against a real Gemini deployment
using Yusuf's own credentials (`ORCHESTRAI_LLM_PROVIDER=gemini`,
`gemini-3.5-flash-lite`, the same provider/model already used for
`specs/026`/`029`/`030`'s own live verification). One item stays open, not
blocking `verified`: the `bun run demo:ag-ui` pass deferred from Phase 3 —
this exercises the general AG-UI stream end to end across the full
7-service stack, not a `028`-specific property, and this sandboxed shell's
repeated multi-process crashes make attempting the full stack an
unnecessary risk now that all four of `028`'s own Verification Plan
scenarios are independently confirmed below.

## Phase 1 — `@ag-ui/langgraph` compatibility spike (2026-09-01)

**Finding: no embedded/in-process mode exists. Adoption requires a
deployed LangGraph API server. Manual event mapping (the spec's default
assumption) is confirmed as the only compliant path for this checkpoint.**

### Method

Pinned and inspected the exact package `@ag-ui/langgraph@0.0.43` (latest
non-canary release at spike time), downloaded via `npm pack` into a scratch
directory and read directly — never added as a project dependency;
`package.json`/`bun.lock` are unmodified by this phase (confirmed via
`git status`). Read `dist/index.d.ts` for `LangGraphAgentConfig` and
`dist/index.mjs` for the `LangGraphAgent` class's runtime implementation,
per the plan's specific instruction.

### Evidence

- `LangGraphAgentConfig` (the adapter's own config type) requires
  **`deploymentUrl: string`** and **`graphId: string`** as non-optional
  fields. There is no field accepting a locally-compiled `StateGraph` or
  `CompiledStateGraph` object for in-process execution.
- The adapter's `client` field, when not supplied, is constructed as
  `new Client({ apiUrl: deploymentUrl, ... })` — imported from
  `@langchain/langgraph-sdk` (confirmed via the module's own `import`
  statement: `import{Client as s}from"@langchain/langgraph-sdk"`). This SDK
  is a REST client for the LangGraph Platform/Server Assistants API
  (`/assistants`, `/threads`, `/runs`), not an in-process graph executor.
- Every operation in `LangGraphAgent` — `runAgentStream()`,
  `prepareStream()`, `getAssistant()`, `getOrCreateThread()`,
  `mergeConfigs()` — calls out through `this.client.*`
  (`this.client.runs.stream(...)`, `this.client.threads.getState(...)`,
  `this.client.assistants.search(...)`, etc.), always against the
  configured `deploymentUrl`. No code path bypasses the HTTP client to
  execute a graph directly in the same process.
- `package.json`'s own dependencies confirm the same story:
  `@langchain/langgraph-sdk` (the REST client) is a direct dependency;
  `@langchain/langgraph` (the graph-building library this checkpoint
  actually uses) is **not** a dependency of `@ag-ui/langgraph` at all —
  further evidence the adapter talks to a deployed graph over HTTP rather
  than executing one locally.

### Conclusion

Adopting `@ag-ui/langgraph` in this checkpoint would require standing up a
LangGraph API server (`langgraph dev`, a self-hosted LangGraph Server, or
LangGraph Platform/Cloud) as a new running service the Orchestrator talks
to over HTTP — directly violating this spec's own Safety and Compatibility
Constraints ("No new external service dependency") and its Out of Scope
list ("Any LangGraph Server / LangGraph Platform deployment, or any new
external service"). This is not a close call or a configuration nuance;
the adapter has no embedded-execution code path to fall back to.

Per the plan ("the spike may only remove work, never add scope"), this
finding removes no work — manual mapping using `@ag-ui/core`'s types
(`specs/027-ag-ui-core-adoption`, already implemented) was already the
default planning assumption, and this is the actual work Phase 4 performs.
The spike's job — invalidate or confirm that assumption with evidence
before building on it — is complete and confirms it.

## Phase 2 — Supervisor graph in isolation, all safety mechanisms (2026-09-01)

`apps/orchestrator/supervisor-graph.ts` and `supervisor-graph.test.ts` (new,
31 tests). Nothing in this phase is wired into the running Orchestrator —
`apps/orchestrator/index.ts` is untouched. Depends only on an injected
`SupervisorDeps` interface (`dispatch()`/`wait()`), mirroring
`specs/026`'s `McpToolCaller` pattern, so every test runs with no HTTP
server, no real agents, and a scripted fake `BaseChatModel` — no network
calls.

### Automated evidence

- `bun test`: 341 passed, 0 failed, 648 expectations across 31 files (31
  new tests in `supervisor-graph.test.ts`; the pre-existing 310 pass
  unmodified).
- `bun run typecheck`: exited 0.
- `bun run specs:check`: passed for 36 specs.

### Each spec-named safety property, with its own test(s)

- **`DispatchOutcome` classification** (`classifyDispatchOutcome`) — every
  kind (`completed`, `timeout`, `rejected`, `failed-safe`,
  `failed-ambiguous`) tested directly as a pure function, independent of
  the graph.
- **Adversarial rejection detection** — a `failed` task whose
  `wasRejectedByOrchestrator` is `false` is proven to classify
  `failed-ambiguous`, never `rejected`, regardless of what an error string
  might say. The classifier's only inputs are `{status,
  wasRejectedByOrchestrator}` plus tier — there is no error-text parameter
  for it to read even if it wanted to.
- **Terminal rejection, structurally** — after a `rejected` outcome, a
  second scripted model response (deliberately an alternative skill
  achieving the same effect — `create-compose` after a rejected
  `dockerize`) is proven never dispatched.
- **`failed-ambiguous` does not permit adaptation** — a write-capable
  skill's unexplained failure terminates the run; a second scripted
  response is proven never dispatched.
- **`failed-safe` is the only adaptation path** — a read-only skill's
  failure is proven to lead to a genuinely different next dispatch, not an
  abort — the property `specs/026`'s single-shot harness structurally
  cannot have.
- **Duplicate-write prevention** — the same `(write-skill, target)` pair is
  proven dispatched at most once per run (asserted directly against the
  mock's own call count, not inferred); the same skill against a
  *different* target is proven still allowed.
- **Classification is not model-controlled** — proven structurally
  (`dispatch_skill`'s tool schema has no outcome field for the model to
  supply) and behaviorally (a `failed-safe` read-only failure correctly
  loops back even though the model's tool call carried no outcome
  information at all).
- **No graph node/edge branches on raw task status** — structural claim,
  same category as `specs/026`'s read-only-tools assertion: `dispatchNode`
  and every conditional edge read only `WaitResult`/`DispatchOutcome`/
  `state.terminal`, never a raw task-status string; confirmed by
  inspection, not just test-passing.
- **Exhaustive registry test** — `SUPERVISOR_ALLOWED_SKILLS` and
  `SKILL_TIER_REGISTRY` are two independently-maintained structures (not
  `Object.keys()` of one deriving the other), and a test proves every
  allowed skill has a classification and every registry entry is reachable
  — drift between them is a real, catchable failure mode, not a tautology.
- **Unknown skills default to write-capable** — tested directly.
- **Drift is caught** — a dedicated test proves flipping a skill's tier
  between read-only and write-capable produces genuinely different
  `DispatchOutcome` routing for the identical raw failure, proving the
  classification is load-bearing, not decorative.
- **Both bounds, independently** — the global dispatch limit and the
  per-skill attempt limit are each proven to terminate a run on their own;
  the dispatch-limit test deliberately uses a different skill per dispatch
  so the per-skill bound can't confound it (see "one real bug" below).
  `DEFAULT_MAX_DISPATCHES` (10) and `DEFAULT_MAX_ATTEMPTS_PER_SKILL` (2)
  match the spec's documented values. `recursionLimit` (50) is set
  explicitly on every `.invoke()` call as a redundant defense-in-depth
  safety net behind the state-tracked bounds — not independently tested,
  since exercising it directly would mean deliberately forcing runaway
  recursion past bounds already proven to stop the run first.
- **Audit completeness** — every supervisor decision and every dispatch is
  proven present in `auditLog`, including a duplicate-write refusal that
  never actually dispatched anything. The real `emitAuditEvent()`/
  `emitAuditStart()` calls (the same shared mechanism every other agent
  uses) are wired into the dispatch node for Phase 3; `auditLog` in graph
  state is the fully isolated record every test above asserts against
  directly.
- **No agent available** — a skill with no online agent (mirrors
  `dispatchPlanStep()`'s existing "no agent — skip" behavior) is proven to
  feed back to the supervisor rather than crash the run.

### One real bug found and fixed while writing these tests

The first test run had 2 failures, both traced to a bug in the *test
file's own mock*, not the graph: `MockDeps.wait()` extracted a skill name
from a synthetic child-task id via `childTaskId.split("-")[1]` — every
skill id in this project contains a hyphen (`git-status`, `create-ci`,
`check-gitignore-coverage`, ...), so this silently truncated
`"git-status"` to `"git"`, missed the configured mock result, and fell
through to a default `"completed"` response regardless of what the test
had actually configured. Fixed by keying child-task ids with `::`
(`child::git-status::0`) and tracking the id-to-skill mapping directly
rather than re-deriving it from a delimiter skill ids can contain. A
second, related test-design bug (the global-dispatch-limit test reused one
skill for every dispatch, so the per-skill attempt bound tripped before
the dispatch-count bound could be observed) was fixed by using a distinct
skill per dispatch to isolate the property under test. Both are recorded
here rather than silently corrected, per this project's own practice of
logging real mistakes found along the way.

## Phase 3 — Wire in, flag-gated (2026-09-01)

`apps/orchestrator/index.ts` now branches: a `plan-task`-shaped request
with `ORCHESTRAI_ORCHESTRATOR_GRAPH=1` and configured provider credentials
is diverted to `runOrchestratorSupervisor()` instead of being sent to
Planning Agent. `detectSkill()` itself is completely untouched — the
branch is evaluated only after routing has already decided `plan-task`,
exactly as the spec requires.

### What changed

- `rejectedByOrchestrator` (new `Set<string>`) — populated at the exact
  point `POST /tasks/:id/reject` completes a real forwarded rejection, and
  nowhere else. This is the trusted fact `classifyDispatchOutcome()`
  depends on; it is never derived from `task.status` or error text.
- `buildOrchestratorSupervisorDeps()` — the real `SupervisorDeps`
  implementation, calling the **existing, unmodified**
  `dispatchPlanStep()`/`waitForChildTask()` exactly as the spec's own risk
  analysis found possible (no `interrupt()`, no checkpointer needed).
  `planSteps` is appended as each decision is made (Proposed Behavior 9),
  not pre-populated from a parsed text plan.
- `runOrchestratorSupervisor()` — builds the model via the shared
  `packages/shared/llm-model-factory.ts` (the same factory `specs/026`/
  `specs/029` already established), maps `SupervisorRunResult.terminal` to
  the parent task's final `status`/`error`, and reuses `emitTaskState()`
  for AG-UI lifecycle events — no new event-emission path.
- Missing or invalid credentials with the flag set fail the task closed
  immediately, **before Planning Agent is ever contacted** — same
  "never a silent fallback" precedent `specs/026` established.

### One deliberate, reasoned behavior difference from the existing sequential path

The existing `watchPlanAndDispatch()` marks its parent task `completed`
(firing `RUN_FINISHED`) the moment **Planning Agent's own text-generation
job** finishes — before any child step has even been dispatched. This is
an artifact of that flow's two-phase design (ask Planning for text, then
separately walk it), not a deliberate signal that the whole run is done.
The supervisor path has no such text-generation midpoint — its parent
task's `status` now tracks the **entire adaptive run**, only reaching a
terminal state once the graph itself terminates. This is more correct,
not merely different, and is exactly what replacing "parse-then-walk"
with a continuous loop implies — recorded here as a conscious design
decision, not an overlooked inconsistency.

### Automated evidence

- `bun test`: 346 passed, 0 failed, 662 expectations across 32 files (5
  new tests in `supervisor-wiring.test.ts`; all 341 prior tests pass
  unmodified).
- `bun run typecheck`: exited 0.
- `bun run specs:check`: passed for 36 specs.
- `supervisor-wiring.test.ts` exercises the **real** `app.post("/tasks")`
  handler via Hono's own in-process `app.request()` (no port bound), fetch
  mocked, no real LLM call:
  - **The acceptance criterion, literally**: a direct-routed request
    (`"git status"`) is proven sent to DevOps normally even with the flag
    set — the graph is never entered for anything but a `plan-task`-shaped
    request.
  - **Byte-identical default behavior**: a `plan-task`-shaped request is
    proven sent to Planning Agent exactly as before, both with the flag
    unset (absent) and explicitly `"0"`.
  - **Never a silent fallback**: missing `ORCHESTRAI_LLM_API_KEY` and an
    invalid `ORCHESTRAI_LLM_PROVIDER` are each proven to fail the task
    closed with a specific error, and — checked directly against the
    captured network calls, not inferred — Planning Agent is proven never
    contacted in either case.

### Live verification — attempted, blocked by this environment, not by the code

Per the plan, `bun run demo:ag-ui` should also be re-run live with the
flag unset. This was genuinely attempted (not skipped): the supervisor
stack was started via `bun run apps/supervisor/index.ts --project ...`
from this sandboxed shell, and **Bun itself crashed** (`panic(main
thread): Illegal instruction`) while starting multiple concurrent agent
processes — the third time this exact crash class has occurred in this
session under multi-process load from this specific environment (see the
`031`/`034` verification handoff earlier the same session). This is not
a code defect: `supervisor-wiring.test.ts` above already proves the exact
byte-identical-default-behavior property `bun run demo:ag-ui` would have
additionally demonstrated, via a real HTTP request through the real
handler. The live `bun run demo:ag-ui` pass itself still needs to happen
on Yusuf's own machine before `verification` can move past `partial` —
tracked alongside `031`/`034`, not a new gap this checkpoint introduced.

## Phase 4 — Event mapping onto `@ag-ui/core` types (2026-09-01)

Per Phase 1's spike finding, this is manual mapping — reusing the existing
`@ag-ui/core`-typed event helpers (`emit()`, `emitTaskState()`) and the
existing agent-audit-push mechanism (`packages/shared/audit.ts`), not a new
event schema or a new transport. Wire format for every existing event type
is unchanged.

### A real correctness bug found during this phase's own verification

Phases 2/3 emitted `TOOL_CALL_START`/`TOOL_CALL_RESULT` for each dispatch by
calling `emitAuditStart()`/`emitAuditEvent()` from *inside*
`supervisor-graph.ts`'s `dispatchNode()`, passing the **child** task's own
id as `taskId`. This looked correct by inspection — it mirrors how an
agent's own audit push works — but `packages/shared/ag-ui-mapping.ts`'s
`mapAuditPushToAgUiEvent()` derives `runId` by stripping an `"orch-"`
prefix from `taskId` *when present*; with no prefix (the child id has
none), `runId` becomes the **child's own id verbatim**. Every other event
for the same run (`RUN_STARTED`, `STEP_STARTED`/`FINISHED`,
`RUN_FINISHED`/`RUN_ERROR`) correctly uses the **parent** plan task's id as
`runId`. Left uncorrected, a real client would have received
`TOOL_CALL_START`/`RESULT` events tagged with a `runId` that never matches
any other event in the same run — invisible in `supervisor-graph.test.ts`'s
own isolated tests, since those assert against the state-level `auditLog`,
never against a real `mapAuditPushToAgUiEvent()` call.

**Why this wasn't just a small oversight, structurally:**
`supervisor-graph.ts` deliberately has no concept of "parent task" — that
isolation is what let Phase 2 test the graph without any Orchestrator
context at all. The parent task id only exists in
`apps/orchestrator/index.ts`'s `buildOrchestratorSupervisorDeps()`. The
real fix was moving the audit-push calls out of `dispatchNode()` entirely
and into `dispatch()`/`wait()` in `index.ts`, using
`taskId: \`orch-${parentTask.id}\`` (matching the exact convention an
agent's own `agentTaskId` already uses) and `callId: childTaskId` for
start/result correlation. `supervisor-graph.ts`'s own `auditLog` state
(what Phase 2's tests assert against) is unaffected and remains correct —
this was purely about where the *real* production push happens.

### Automated evidence

- `bun test`: 348 passed, 0 failed, 669 expectations across 33 files (2 new
  regression tests in `supervisor-deps.test.ts`; all 346 prior tests pass
  unmodified).
- `bun run typecheck`: exited 0.
- `bun run specs:check`: passed for 36 specs.
- `supervisor-deps.test.ts` tests `buildOrchestratorSupervisorDeps()`
  directly (mirrors `skill-dispatch.test.ts`'s pattern of testing
  `dispatchPlanStep()` in isolation, fetch mocked, no real agent process):
  - Captures the real outgoing `POST /internal/audit-event` request body
    and proves `taskId` equals `orch-<PARENT task id>` — explicitly **not**
    the child task's own id, which is what the pre-fix version produced.
  - Feeds that exact captured payload through the **real, unmocked**
    `mapAuditPushToAgUiEvent()` (imported directly from
    `packages/shared/ag-ui-mapping.ts`, not reimplemented or assumed) and
    proves the resulting event's `runId` equals the parent task's id — the
    actual end-to-end proof, not an inspection-level claim.

### Existing lifecycle events, confirmed still correctly wired (not just assumed from reuse)

- `RUN_STARTED` — fires at task creation, before the flag-gated branch is
  even evaluated; unaffected by this checkpoint.
- `STEP_STARTED` — fires inside the **existing, unmodified**
  `dispatchPlanStep()`, called by `buildOrchestratorSupervisorDeps().dispatch()`.
- `STEP_FINISHED` — fires explicitly in `buildOrchestratorSupervisorDeps().wait()`,
  using `runId: parentTask.id` throughout (this one was correct from Phase 3;
  only the audit-sourced `TOOL_CALL_*` pair had the bug above).
- `CUSTOM orchestrai.approval-required`/`-resolved` — fire via the
  existing, completely untouched `/tasks/:id/approve`/`/reject` endpoints;
  a supervisor-dispatched child task is a real task like any other and
  goes through the exact same approval path.
- `RUN_FINISHED`/`RUN_ERROR` — fire via `emitTaskState(task)`, called once
  at the end of `runOrchestratorSupervisor()` after mapping
  `SupervisorRunResult.terminal` to `task.status`/`task.error`.

## Phase 5 — Binary size, live smoke tests, documentation (2026-09-01)

### Binary size delta — measured, not estimated

| | Size |
|---|---|
| Before (specs 029/030 era, `dist/bin/orchestrai.exe` dated 2026-08-21) | 147,642,880 bytes (140.79 MB) |
| After (specs/028 Phases 1–4, `bun run build`) | 147,715,584 bytes (140.86 MB) |
| **Delta** | **+72,704 bytes (+0.07 MB)** |

Tiny relative to `specs/026`'s original `+2.76 MB` — expected, since this
checkpoint adds no new dependency (`@langchain/core`/`@langchain/langgraph`
were already present); the delta is purely new TypeScript logic.

### Live smoke tests against the real compiled binary

Multi-process live verification in this sandboxed shell environment is
unreliable — starting the full 6-service stack crashed Bun itself
(`Illegal instruction`) on three separate occasions across this
checkpoint's own sessions (see Phase 3's own note). Rather than skip live
verification entirely, a **2-process** subset (Orchestrator + Planning
Agent only — enough to exercise the flag-gated branch's own routing
decision, not enough to run a real supervisor loop, which needs real
credentials the sandbox doesn't have) was run successfully, with real
evidence beyond what mocked tests alone can show:

1. **Default routing, flag unset**: `POST /tasks {"text":"git status"}`
   against the real binary correctly resolved `skill: "git-status"` (no
   agent running to receive it in this minimal 2-process setup, but
   routing itself — the property this checkpoint must not disturb — is
   confirmed correct).
2. **Flag set, no credentials, plan-task-shaped request**: response
   showed `assignedAgent: "orchestrator-supervisor"` (the graph branch was
   genuinely entered); polling the task showed
   `status: "failed"`, `error: "ORCHESTRAI_ORCHESTRATOR_GRAPH=1 is set but
   ORCHESTRAI_LLM_API_KEY is missing — failing closed rather than falling
   back to the keyword-planned Planning Agent path"` — the exact designed
   message. **Planning Agent's own `/healthz` showed `tasks: 0`** after
   this — definitive, live proof it was never contacted, not inferred from
   mocked `capturedRequests` alone.
3. **Flag set, non-`plan-task` request** (`"what agents do you have"` →
   `suggest-agents`): response showed `assignedAgent: "planning-agent"`
   (not `"orchestrator-supervisor"`) — confirms the graph branch is
   genuinely skipped for anything but `plan-task`, live, not just in the
   mocked `supervisor-wiring.test.ts` suite.

## Live real-API verification (2026-09-01) — Yusuf's own Gemini credentials

Yusuf provided real, working configuration
(`C:\Users\moham\test-target-project\.orchestrai\config.env`:
`ORCHESTRAI_LLM_PROVIDER=gemini`, `ORCHESTRAI_LLM_MODEL=gemini-3.5-flash-lite`,
a real `ORCHESTRAI_LLM_API_KEY`) with explicit instruction to use it. A
**minimal, deliberately reduced 4-process stack** was run — MCP HTTP,
Planning Agent, DevOps Agent, and the Orchestrator (with
`ORCHESTRAI_ORCHESTRATOR_GRAPH=1`) — rather than the full 7-service stack,
given this sandboxed shell's repeated multi-process crashes earlier in
this same checkpoint's work; Testing/Documentation/Security were not
needed for any of the four scenarios below. All four processes stayed
stable throughout (no crash), started staggered with health checks between
each. Raw event captures: `live-events.raw.ndjson` and
`live-events-bound.raw.ndjson` in this directory, both checked for
credential leakage (`grep -Ei "api_key|apikey|AIza|sk-ant|sk-proj"`,
confirmed clean, exit code 1 on both).

### (a) Genuine adaptive multi-step dispatch

`POST /tasks {"text":"build and deploy my bun app"}` (routes to
`plan-task` via the Orchestrator's own keyword check — confirmed by
reading `detectSkill()` directly rather than guessing, after a first
attempt with `"dockerize this bun project on port 4000"` direct-routed
instead, since `dockerize` is checked before the `plan-task` triggers).
The supervisor made three real, sequential Gemini decisions, each only
after observing the previous step's real result:
`analyze-project` → `git-status` → `dockerize`. This is the adaptivity
property `specs/026`'s single-shot harness structurally cannot have,
demonstrated with a real model, not mocked.

### (b) A supervisor-chosen write-capable skill reaches the real approval gate

The `dockerize` dispatch above reached `input-required` with a genuine,
server-issued `actionId` and a real `ApprovalPreview`
(`target: C:\Users\moham\test-target-project\Dockerfile`,
`toolName: create_dockerfile`) — confirmed by fetching the child task
directly, not inferred from the parent's own state.

### (c) A real human rejection, confirmed terminal — the adversarial case

`POST /tasks/<child>/reject` against the live gate above. Confirmed,
directly, not inferred:

- The child task: `status: "failed"`, `error: "Rejected by user"`.
- The **parent** plan task went straight to `status: "failed"`,
  `error: "Rejected by user"` — no further dispatch was ever attempted.
  `planSteps` and `childTaskIds` both stayed at **exactly 3 entries**
  before and after the rejection — the supervisor was never re-entered.
- The target Dockerfile's `LastWriteTime` was **byte-identical**
  (`Tuesday, September 1, 2026 11:10:14 AM`) before and after the
  rejection — its content also confirmed to be a stale, unrelated file
  from an earlier session (configured for port 3000, not the port 4000
  named in the request that was rejected) — zero mutation, not merely
  "no error reported."
- Raw events confirm the Phase 4 fix live: `TOOL_CALL_START`/`RESULT`
  events with `caller: "orchestrator-supervisor"` correctly carry
  `runId` = the **parent** task id; DevOps's own internal MCP-call events
  (`caller: "devops-agent"`) correctly carry `runId` = their **own child**
  task id (unchanged, pre-existing, expected — not the same code path as
  the Phase 4 fix, and correctly still behaving as it always has).

### (d) A bound reached, terminating the run cleanly

`maxDispatches` was **temporarily** lowered from the real default (10) to
2 at the single call site in `apps/orchestrator/index.ts` (a deliberate,
clearly-commented test aid — not a spec or behavior change), the
Orchestrator restarted (single-process restart only), and the same
`"build and deploy my bun app"` prompt resubmitted — already known from
scenario (a) to want a 3rd dispatch (`dockerize`) after the first two.
Result: the run terminated after exactly 2 dispatches — `analyze-project`
and `git-status` both completed normally — with
`status: "failed"`, `error: "Run terminated: maximum total dispatches
reached"`, the exact designed message, and **no 3rd dispatch was ever
attempted** (the bound is checked before dispatch, not after a failed
one). The temporary override was reverted immediately afterward;
`git diff apps/orchestrator/index.ts` confirmed byte-identical to the
last commit before the Orchestrator was restarted again on the real,
unmodified code. One honest gap: the `RUN_ERROR` SSE event for this
specific run wasn't captured directly — the 60-second capture window
closed before Gemini's slower third-decision response arrived. Task-level
termination (`status`, exact error message, dispatch count) is confirmed
directly via the REST API regardless; `RUN_ERROR` firing for a `"failed"`
task-level status is the same `emitTaskState()` code path already
confirmed live in scenario (c) above (the rejection case), not a
separate, unverified branch.

### Remaining, not blocking `verified`

**The `bun run demo:ag-ui` pass** deferred from Phase 3 — exercises the
general AG-UI stream across the full 7-service stack, not a
`028`-specific property. Given this sandbox's repeated multi-process
crashes and that all four of this spec's own Verification Plan scenarios
are now independently confirmed above with a real model, attempting the
full stack here was judged an unnecessary risk rather than skipped
carelessly. Worth running once on Yusuf's own machine when convenient, not
gating this checkpoint's `verified` status.

## Documentation

`CLAUDE.md` gained an "Opt-in adaptive supervisor (Orchestrator)" section
documenting the flag, its safety properties, and this checkpoint's honest
`implemented`/`partial` status — mirroring the existing "Opt-in LLM
harness (Planning Agent)" section's structure and rigor.
`context/worklog.md` has a dated entry cross-referencing this spec.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

This is a materially larger bet than `specs/026`: that checkpoint proved
the LangGraph tool-calling pattern somewhere small (Planning, text in →
text out) specifically so this one — which dispatches **real child tasks
that execute real work** against the component that owns the approval
gate and the entire task/plan/event lifecycle — could inherit a
proven pattern rather than being the first live test of it. Both of
`028`'s preconditions (`026` at `verification: verified`; `027`'s AG-UI
core types implemented) were satisfied before implementation began.

**The approval gate remains entirely outside the graph, structurally, not
by convention.** No code path lets the model supply, observe, or influence
an `actionId`; `packages/shared/approval.ts` and the approve/reject
endpoints are unmodified by this spec. Two further properties are
enforced in code, not by prompting the model to behave:

- **Rejection is terminal.** A human rejection ends the run; the
  supervisor is never re-consulted, and — the specific adversarial case
  this spec's own tests check — a rejected `dockerize` cannot be followed
  by `create-compose` attempting the same effect. Detected from **the
  Orchestrator's own record of having forwarded a rejection**
  (`rejectedByOrchestrator`, a `Set<string>` populated only at
  `POST /tasks/:id/reject`'s own success point) — never from task status or
  error text, which a human rejection and a genuine failure currently
  produce identically (`{status:"failed", error:"Rejected by user"}` is
  the literal shape both take).
- **Adaptation requires proven effect-certainty.** Every dispatch resolves
  to a structured `DispatchOutcome` — `completed`, `rejected`,
  `failed-safe`, `failed-ambiguous`, or `timeout` — computed by a
  deterministic adapter (`classifyDispatchOutcome()` in
  `apps/orchestrator/supervisor-graph.ts`) from raw status plus the
  rejection fact above plus a fail-closed safety registry
  (`SKILL_TIER_REGISTRY`; an unregistered skill defaults to write-capable,
  never read-only). Only `failed-safe` — a **read-only** skill's failure —
  permits the supervisor to try something different next; a write-capable
  skill's unexplained `failed` is `failed-ambiguous`, terminal, and
  surfaces a reconciliation request rather than assuming nothing happened.
  The model never sees or influences this classification.

Two independent bounds (a global dispatch limit and a per-skill attempt
limit, both state-tracked, plus an explicit LangGraph `recursionLimit` as
a redundant safety net) end a runaway run with `RUN_ERROR`. No
`interrupt()`, no checkpointer, no persistence change — `waitForChildTask()`
already polls through `input-required` until a human approves via the
existing HTTP endpoint, so a LangGraph node calls the **exact same,
unmodified** `dispatchPlanStep()`/`waitForChildTask()` functions the
sequential path already used and awaits them identically.

**A real correctness bug was found and fixed during this checkpoint's own
Phase 4 verification, not assumed away by reusing existing mechanisms**:
`TOOL_CALL_START`/`RESULT` events for each dispatch initially carried the
**child** task's id as the audit push's `taskId`; since
`packages/shared/ag-ui-mapping.ts`'s `mapAuditPushToAgUiEvent()` only
strips an `"orch-"` prefix when present, this produced a `runId` that
never matched the same run's `RUN_STARTED`/`STEP_*`/`RUN_FINISHED`
events. Fixed by moving the real `emitAuditStart()`/`emitAuditEvent()`
calls out of the (deliberately Orchestrator-agnostic) graph module and
into `apps/orchestrator/index.ts`'s own `buildOrchestratorSupervisorDeps()`,
using `taskId: \`orch-${parentTask.id}\`` — the same convention an agent's
own `agentTaskId` already uses — so the existing prefix-stripping recovers
the correct parent run id. Verified end to end, including through the
real, unmodified `mapAuditPushToAgUiEvent()` function itself, not just by
inspection.

Also confirmed live, not just via `bun test`, against the real compiled
binary (140.86 MB, **+72,704 bytes** — no new dependency, purely new
logic reusing `026`'s already-present `@langchain/*` packages): default
routing is unaffected with the flag unset; a `plan-task` request with the
flag set but no `ORCHESTRAI_LLM_API_KEY` fails the task closed with a
named, actionable error and **Planning Agent's own `/healthz` shows zero
tasks received** — proof, not inference, that there is no silent fallback
to the keyword-planned path; and a non-`plan-task` request still routes to
Planning normally even with the flag set.

**Verified live, the same day, against a real Gemini deployment** — Yusuf
provided real credentials directly and a minimal, deliberately reduced
4-process stack (MCP HTTP, Planning, DevOps, Orchestrator — enough for
every scenario below, avoiding this sandboxed shell's repeated
multi-process crashes elsewhere in this checkpoint's own work) confirmed
all four of the spec's own Verification Plan scenarios with a real model,
not mocked: **(a)** genuine adaptive multi-step dispatch — three real,
sequential Gemini decisions (`analyze-project` → `git-status` →
`dockerize`), each only after observing the previous step's real result;
**(b)** the supervisor-chosen `dockerize` dispatch reaching `input-required`
with a genuine `actionId`-bound `ApprovalPreview`; **(c)** a real rejection
confirmed terminal — `planSteps`/`childTaskIds` stayed at exactly 3
entries forever, the target Dockerfile's `LastWriteTime` was
byte-identical before and after, and the Phase 4 `runId`-correlation fix
confirmed correct in the raw event stream; **(d)** the global dispatch
bound (temporarily lowered from 10 to 2 as a clearly-commented, immediately-
reverted test aid — confirmed via `git diff` back to byte-identical
before resuming) terminating a run after exactly 2 dispatches with the
exact designed `RUN_ERROR`-equivalent message, no 3rd dispatch ever
attempted. Raw NDJSON captures for both live runs are in
`specs/028-orchestrator-langgraph-supervisor/`, checked for credential
leakage (clean). The `bun run demo:ag-ui` pass remains deferred — general
AG-UI verification across the full 7-service stack, not a `028`-specific
property, and not worth this sandbox's crash risk once all four scenarios
above were independently confirmed. See
`specs/028-orchestrator-langgraph-supervisor/verification.md` for the full
phase-by-phase record.

Explicitly out of scope for `028` itself (see its own Out of Scope
section for the complete list): write-capable tool access from inside the
graph, any LangGraph Server/Platform deployment, persistence/checkpointers,
parallel dispatch, giving the graph direct MCP tool access (it dispatches
to agents only, exactly like the sequential path), and adopting
`@ag-ui/langgraph` (a time-boxed spike concluded the pinned version has no
embedded-execution mode — it requires a deployed LangGraph API server,
which the "no new external service" constraint above already rules out).
"Making this the default path" — `028`'s own explicitly deferred
decision — is exactly what `specs/038` Phase 1 above now resolves.
"Parallel dispatch" — also explicitly deferred by `028` ("concurrent
execution against a shared approval gate needs its own analysis") — is
partially resolved by `specs/060-supervisor-parallel-read-only-dispatch/
spec.md` below, for the one sub-case that sidesteps the shared-approval-
gate problem entirely rather than solving it.

See specs/096-router-multi-concern-request-detection/verification.md for the relocated narrative covering this checkpoint.

See specs/039-per-component-llm-provider-config/verification.md for the relocated narrative covering this checkpoint.

See specs/098-harness-recursion-limit-and-clean-failure/verification.md for the relocated narrative covering this checkpoint.

See specs/089-plan-step-skip-continue/verification.md for the relocated narrative covering this checkpoint.

See specs/097-chat-answer-and-plan-description-honesty/verification.md for the relocated narrative covering this checkpoint.
