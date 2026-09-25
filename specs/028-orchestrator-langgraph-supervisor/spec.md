---
id: 028-orchestrator-langgraph-supervisor
title: Opt-In LangGraph Adaptive Supervisor for the Orchestrator
area: llm-harness
change_type: feature
status: implemented
verification: verified
created: 2026-08-16
updated: 2026-09-01
approved_by: Yusuf
approved_on: 2026-09-01
implemented_on: 2026-09-01
amends: []
supersedes: []
superseded_by: []
related:
  - 026-llm-harness-langgraph-planning
  - 027-ag-ui-core-adoption
  - 020-semantic-intent-fallback
  - 006-runtime-stabilization
  - 021-ag-ui-event-protocol
---

# Spec: Opt-In LangGraph Adaptive Supervisor for the Orchestrator

> Status history: **APPROVED by Yusuf on 2026-09-01. IMPLEMENTED the same
> day (all 5 plan.md phases). VERIFIED the same day** — Yusuf provided real
> Gemini credentials directly; all four of this spec's own Verification
> Plan scenarios (adaptive re-planning, the approval gate reached, a real
> rejection confirmed terminal, a bound terminating cleanly) confirmed live
> against a real model. See `verification.md` for full evidence, including
> the exact raw event captures. The `bun run demo:ag-ui` pass remains
> deferred (general AG-UI verification, not a `028`-specific property) but
> does not block `verified`.

## Purpose

Make orchestration **adaptive**. `specs/026-llm-harness-langgraph-planning/spec.md`
proved the LangGraph tool-calling pattern inside the Planning Agent, but its
harness reasons **once, up front**, then emits a static `N. [skill-id]` text
plan that the Orchestrator parses and walks. If a step fails, if a security
scan finds secrets, if `analyze_project` contradicts the plan — nothing can
re-decide.

This checkpoint moves the decision loop to the Orchestrator so it can choose
the next action from what previous steps **actually returned**: re-plan on
failure, branch conditionally, stop early when a result makes continuing
wrong.

This is the highest-risk checkpoint in the project to date. The Orchestrator
owns the approval gate and the entire task lifecycle. The controlling
principle throughout is therefore: **the graph decides what to ask for; it
never decides whether a human must approve it.**

## Dependencies and Sequencing

Both are hard preconditions, not preferences:

1. **`specs/026` at `verification: verified`** — ✅ **satisfied as of
   2026-08-20.** `026`'s entire justification was proving this pattern
   somewhere small *before* touching the component that owns the approval
   gate; that live real-API run is now complete, including the adversarial
   re-run through `030`'s dynamic capability catalog.

   `specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md`
   is the mechanism that closed this precondition — implemented and
   `verified`. `030` fixed a real live-discovered defect: the Orchestrator
   selected `git-status`, but the receiving agent re-read the step's
   LLM-authored description, saw "Dockerfile", and re-derived `dockerize`
   instead. If `028`'s own adaptive supervisor had been built before this
   fix landed, it would have inherited the identical bug at every dispatch
   point it introduces — this precondition exists precisely to prevent
   that.
2. **`specs/027-ag-ui-core-adoption/spec.md` implemented** — so this
   checkpoint builds on the official protocol types rather than performing
   a type-source migration and an orchestration-architecture change in the
   same reviewable unit.

## Verified Current State

### The approval gate does not require LangGraph `interrupt()`

Checked directly against the code, and it removes what was initially
assumed to be this checkpoint's hardest risk.

`apps/orchestrator/index.ts:575-589`'s `waitForChildTask()` polls a child
task until terminal state, and for `input-required` it **keeps polling until
a human approves via the existing HTTP endpoint** — its own comment says so.
`watchPlanAndDispatch()` (`apps/orchestrator/index.ts:506-573`) calls
`dispatchPlanStep()` then `await waitForChildTask(childId)` per step.

A LangGraph node can therefore call those **exact same existing functions**
and `await` them identically. No `interrupt()`, no checkpointer, no
persistence layer, and — critically — no second source of truth for task
state alongside the existing in-memory `tasks` Map.

Process restart still loses an in-flight run, but that is already true today
(CLAUDE.md: "No persistence; all task state is in memory"), so it is not a
regression introduced here.

### `@ag-ui/langgraph` compatibility is unresolved, not disproven

Evidence **against** in-process use, from the published TypeScript
implementation:

- `LangGraphAgentConfig` requires a `deploymentUrl` or a preconstructed
  LangGraph API client, and the runtime calls `client.runs.stream(...)` —
  it does not accept a compiled in-process graph directly
  ([`integrations/langgraph/typescript/src/agent.ts`](https://github.com/ag-ui-protocol/ag-ui/blob/main/integrations/langgraph/typescript/src/agent.ts)).
- The package depends on `@langchain/langgraph-sdk`, whose own npm
  description is "Client library for interacting with the LangGraph API".

Evidence **for** local graph support, from official sources:

- The integration README advertises local graph support
  ([integration README](https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations/langgraph/typescript)).
- An official issue was closed stating direct local graphs are supported
  ([issue #444](https://github.com/ag-ui-protocol/ag-ui/issues/444)).

These are contradictory, and the currently exported implementation still
appears API-client-based. Therefore:

> **`@ag-ui/langgraph` is not adopted because the exact pinned TypeScript
> release has not demonstrated compatibility with OrchestrAI's embedded
> graph. Adoption requires a package-source compatibility spike proving that
> no LangGraph API server is required.**

This is a statement about a pinned version's demonstrated behavior, not a
permanent architectural verdict. See Proposed Behavior 10.

### `failed` carries no information about whether the action took effect

An earlier draft of this spec asserted that "an explicit `failed` status
means the action did not take effect." **That is false**, verified against
the code, and it invalidated two of this spec's own safety claims.

- `resumeTask()` — the **post-approval write execution path** —
  wraps `mcpClient.callTool()` in a single `try/catch` and collapses *any*
  thrown error into `status: "failed"`
  (`packages/agents/devops/index.ts:280-291`). A `dockerize` that failed
  partway through writing a Dockerfile is reported identically to one that
  never started. An MCP `isError` response also becomes an ordinary thrown
  failure.
- The shared MCP client already documents this ambiguity explicitly:
  *"never retry ambiguous transport failures (timeout, connection reset)
  **where the write may already have begun**"*
  (`packages/shared/mcp-client.ts:267-273`). The runtime knows writes can be
  ambiguous; the earlier draft ignored it.
- **Human rejection uses the same generic status**:
  `tasks.set(id, { id, status: "failed", error: "Rejected by user" })`
  (`packages/agents/devops/index.ts:379`). Rejection is therefore
  indistinguishable from genuine failure by status, and distinguishable
  only by matching error text — which is exactly the fragile classification
  this spec must not depend on.

The second point above is the more serious one: it means the earlier
draft's "rejection is terminal, structurally enforced" mechanism was
**unimplementable as written**, because the graph had no reliable way to
know a rejection had occurred. A supervisor classifying by status would
have seen a human rejection as an ordinary failure and adapted around it —
precisely the behavior that must never happen.

**What makes the fix possible:** the Orchestrator forwards rejections
itself (`apps/orchestrator/index.ts:770`, `POST /tasks/:id/reject`). It
therefore *knows*, at forward time, that a specific child task was rejected
by a human — an Orchestrator-side fact requiring no inference from the
child's status or error text, and no agent-protocol change.

### Current Orchestrator responsibilities

- `detectSkill()` — keyword matching first, then the Model2Vec semantic
  fallback (`specs/020`), defaulting to `plan-task`.
- `parsePlanText()` (`apps/orchestrator/index.ts:265-283`) — regex-parses
  `N. [skill-id] Description` into `PlanStep[]`.
- `watchPlanAndDispatch()` — sequential dispatch; stops the plan on a failed
  step.
- `actionId`-bound approval forwarding (`specs/006-runtime-stabilization/spec.md`).
- AG-UI emission at known imperative lifecycle points.

## Proposed Behavior

### 1. Opt-in; deterministic-first stays unchanged

New flag `ORCHESTRAI_ORCHESTRATOR_GRAPH=1`. Unset (the default, including
every CI job and demo path), the Orchestrator is byte-identical to today.

`detectSkill()`'s keyword and semantic-classifier fast paths are
**unchanged and still run first**. `"git status"` continues to route
instantly, offline, at zero cost, never reaching the graph. Only requests
that resolve to `plan-task` today reach the supervisor, preserving the
project's established keyword → classifier → LLM ordering.

### 2. The supervisor graph replaces parse-then-walk only

New module `apps/orchestrator/supervisor-graph.ts`: a LangGraph
`StateGraph` with a `supervisor` node (LLM chooses the single next skill, or
done) and a `dispatch` node calling the **existing, unmodified**
`dispatchPlanStep()` + `await waitForChildTask()`, appending each real
outcome to state before returning to `supervisor`.

```
        ┌──────────────┐
   ┌───▶│  supervisor  │──── done / terminal ───▶ END
   │    │ (LLM chooses │
   │    │  next skill) │
   │    └──────┬───────┘
   │           │ dispatch <skill>
   │           ▼
   │    ┌──────────────┐  dispatchPlanStep() + waitForChildTask()
   └────│   dispatch   │  ── EXISTING functions, unchanged ──┐
        └──────────────┘                                      │
                                                              ▼
                                    write-capable skill? → approval gate
                                    (deterministic, actionId-bound,
                                     outside the graph, outside model control)
```

### 3. Rejection is terminal — the graph must never route around it

A human rejection **ends the run**. The supervisor is not consulted again,
does not see rejection as an obstacle to plan around, and must not dispatch
an alternative skill achieving the same effect (e.g. rejected `dockerize`
must not be followed by `create-compose`).

Enforced structurally, not by prompt: a `rejected` dispatch outcome sets a
terminal flag in graph state that routes directly to `END`. The
`supervisor` node is not reachable after a rejection. Rejection emits
`RUN_FINISHED` with an explicit rejected outcome (not `RUN_ERROR` — a human
exercising the gate correctly is not a system error).

Critically, `rejected` is derived from **the Orchestrator's own record of
forwarding the rejection**, not from the child task's status — which is a
generic `failed` indistinguishable from a real failure. See Proposed
Behavior 5; an earlier draft of this spec specified this mechanism without
a reliable way to detect rejection at all.

### 4. No duplicate write actions against the same target in one run

Graph state tracks every `(skill, resolved-target-path)` pair dispatched for
write-capable skills. A pair already dispatched in the current run cannot be
dispatched again, regardless of outcome. Enforced in the `dispatch` node
before execution, not left to the model.

### 5. Explicit effect-certainty contract

Because `failed` carries no information about whether an action took effect
(see Verified Current State), the supervisor must never branch on raw task
status. Every dispatch resolves to a structured outcome carrying an
explicit **effect certainty**:

```ts
type DispatchOutcome =
  | { kind: "completed" }
  | { kind: "rejected";         effect: "none" }
  | { kind: "failed-safe";      effect: "none" }
  | { kind: "failed-ambiguous"; effect: "unknown" }
  | { kind: "timeout";          effect: "unknown" }
```

**Where status may and may not be read.** The rule is a layering rule, not
a ban:

> **Graph nodes and edges must never branch directly on raw task status.**
> A single deterministic **adapter** may inspect raw status *plus* trusted
> Orchestrator-side facts *plus* the safety registry to produce a
> `DispatchOutcome`. Graph routing then uses only `DispatchOutcome`.
>
> **A raw `failed` status alone must always produce `failed-ambiguous`**,
> except when trusted facts positively prove another outcome.

The adapter is the one place raw status is legible, and it is deterministic,
model-free, and unit-testable in isolation.

| Outcome | Produced by the adapter from |
|---|---|
| `completed` | Raw status `completed`. |
| `rejected` | **The Orchestrator's own record** that it forwarded a rejection for this child task (`apps/orchestrator/index.ts:770`) — a trusted fact. Never from the child's `failed` status or a `"Rejected by user"` error string; an agent could produce that text for another reason. |
| `timeout` | `waitForChildTask()` exhausted its bound without a terminal state — a trusted Orchestrator-side fact. |
| `failed-safe` | Raw `failed` **plus** positive proof no mutation can have occurred: the skill is registered read-only, or a registered write-capable skill failed validation/preconditions *before execution began*, or the tool explicitly guarantees no mutation. |
| `failed-ambiguous` | **Raw `failed` with no such proof — the default.** |

**Fail-closed by construction:** absent a trusted fact proving otherwise,
`failed` is `failed-ambiguous`. The default is never `failed-safe`.

**Routing:**

| Outcome | Supervisor behavior |
|---|---|
| `completed` | Continue; supervisor chooses the next action. |
| `rejected` | **Terminal.** Run ends. Supervisor never re-consulted. (See 3.) |
| `timeout` | **Terminal.** Never retried — mirrors the existing MCP-client rule in CLAUDE.md: "Ambiguous failures (timeout, connection reset) are never auto-retried." |
| `failed-ambiguous` | **Terminal, and the run surfaces a reconciliation request** — the target's real state is unknown and a human must check it. The supervisor must not attempt cleanup, retry, or compensation. |
| `failed-safe` | **The only case permitting adaptation**, subject to the per-skill retry limit in 7. |

**The model never chooses or influences the classification.** It is computed
in the `dispatch` node from Orchestrator-side facts plus a static
skill-tier table, and handed to the `supervisor` node as an already-decided
value. A prompt instructing the model to classify would not satisfy this
requirement.

Agents opting in to an explicit "no mutation occurred" signal — which would
let more failures be positively classified `failed-safe` — is a possible
later enhancement and is **out of scope here**. This checkpoint requires
only the conservative default above, so no agent-protocol change is needed.

### 6. A fail-closed safety registry

The adapter's classification depends on knowing which skills are
write-capable. A hand-maintained tier table **will drift** from actual agent
behavior — a skill gains a write path and the table silently keeps calling
it read-only, which downgrades a real `failed-ambiguous` to `failed-safe`
and permits adaptation after a possible mutation. That is the worst
available failure mode, so the registry must fail closed:

- **One authoritative safety registry** where practical, rather than a
  per-consumer copy. Where a single source is genuinely impractical, the
  duplication must itself be test-enforced (below).
- **Every skill the supervisor is allowed to dispatch must have an explicit
  classification** in the registry.
- **Unknown skills default to write-capable / ambiguous**, never read-only.
  An unregistered skill is treated as the most dangerous case, not skipped.
- **An exhaustive test compares the supervisor's allowlist against the
  registry**, failing if any allowed skill lacks a classification or any
  registry entry is unreachable. This is the test that catches drift.
- **Changing a skill from read-only to write-capable must fail tests until
  its classification is updated.** Adding a write path to an existing skill
  cannot silently inherit a stale read-only classification.

### 7. Two independent bounds

- **Hard dispatch limit** per run (e.g. 10 total dispatches), enforced in
  graph state independently of LangGraph's own `recursionLimit`, which is
  also set explicitly rather than left at default.
- **Per-skill retry limit** (e.g. 1 retry, 2 attempts total) so the
  supervisor cannot repeatedly retry the same failing skill within the
  global budget.

Reaching either bound ends the run and emits `RUN_ERROR`.

This is a materially larger risk than `026`, which produced only *text*.
This supervisor **dispatches real child tasks that execute real work**, so
an unbounded loop is repeated real execution, not a wasted API call.

### 8. Audit every decision and every dispatch

Every `supervisor` decision (the skill chosen, and the bounded reason) and
every `dispatch` (skill, target, outcome, duration) emits an audit event
through the existing `packages/shared/audit.ts` mechanism, subject to the
existing 512-byte summary cap. There must be no model-driven action in a run
that is absent from the audit record.

### 9. `planSteps` becomes append-as-decided

A dynamic supervisor does not know its steps in advance. Each `dispatch`
appends its step before executing. `STEP_STARTED`/`STEP_FINISHED` already
stream incrementally (`specs/021`), so the live event contract is unchanged;
only the "all steps known at plan time" rendering assumption changes.

### 10. `@ag-ui/langgraph` evaluated, not assumed

A time-boxed compatibility spike against the **exact pinned version**,
reading the package source, to determine whether an embedded in-process
graph can be used without a LangGraph API server. If it can, adoption may be
proposed as a follow-up checkpoint with that evidence recorded. If it cannot,
this checkpoint maps the supervisor's node transitions onto AG-UI events
manually using `@ag-ui/core`'s types from `specs/027`. **Manual mapping is
the default assumption** for planning purposes; the spike may only remove
work, never add scope.

## Scope

- `apps/orchestrator/supervisor-graph.ts` (new) and its test file.
- `apps/orchestrator/index.ts` — flag-gated branch; `planSteps`
  append-as-decided. No change to `detectSkill()`, the approval endpoints,
  `dispatchPlanStep()`, or `waitForChildTask()`.
- `CLAUDE.md`, `README.md`, `context/worklog.md`.

## Safety and Compatibility Constraints

- **The deterministic approval gate remains entirely outside model
  control.** The model cannot bypass it, pre-approve, supply or observe an
  `actionId`, or influence whether a skill requires approval. Approval is
  keyed on skill, deterministically, outside the graph. No change to
  `packages/shared/approval.ts` or the approve/reject endpoints.
- **Rejection is terminal and structurally enforced** (Proposed Behavior 3),
  derived from the Orchestrator's own forwarded-rejection record — never
  from task status or error text.
- **No duplicate write action against the same target in one run**
  (Proposed Behavior 4).
- **Adaptation requires proven effect-certainty** (Proposed Behavior 5).
  The supervisor may only adapt after `failed-safe`. Raw task status is
  never a branch condition, because `failed` is produced identically by a
  human rejection, a half-completed write, and a validation error that
  never executed. Classification defaults to `failed-ambiguous` and is
  computed outside the model.
- **Timeouts and ambiguous failures are terminal and never auto-retried**;
  `failed-ambiguous` additionally surfaces a reconciliation request rather
  than attempting cleanup or compensation.
- **Two independent bounds, both enforced** (Proposed Behavior 7).
- **Complete audit coverage of model-driven decisions** (Proposed Behavior 8).
- **No `interrupt()`, no checkpointer, no persistence change.** If
  implementation finds this unachievable, that is a material scope change:
  return this spec to `draft` and re-present it. Do not introduce a
  checkpointer mid-implementation.
- **Default behavior unchanged.** Flag unset: every existing test, CI job,
  and verified demo path passes unmodified with byte-identical output.
- **No new external service dependency**, and no network calls in the
  automated test suite.
- Binary size delta measured, not estimated.

## Out of Scope / Non-Goals

- Adopting `@ag-ui/langgraph` (evaluation only — Proposed Behavior 10).
- Any LangGraph Server / LangGraph Platform deployment, or any new external
  service.
- Persistence, checkpointers, or durable run state.
- Replacing or weakening `detectSkill()`'s keyword or classifier fast paths.
- Making the supervisor the default path — a later decision after real use.
- Retiring `specs/026`'s Planning-Agent harness. Whether the supervisor
  makes it redundant is an open question for a later checkpoint.
- Parallel dispatch (LangGraph `Send`) — concurrent execution against a
  shared approval gate needs its own analysis.
- Giving the graph direct MCP tool access. It dispatches to agents only.
- Token-level streaming to the dashboard/TUI — no client renders it today.

## Acceptance Criteria

- [ ] Explicit approval is recorded before implementation.
- [ ] `specs/026` is `verification: verified` and `specs/027` is
      implemented before work begins.
- [ ] With the flag unset, `bun test`, `bun run typecheck`,
      `bun run specs:check` pass and `bun run demo:ag-ui` produces the same
      scenario results as today.
- [ ] A test proves a direct-routed request (e.g. `"git status"`) never
      reaches the graph even with the flag set.
- [ ] With the flag set and a mocked model + mocked dispatch, a test proves
      the loop: decide → dispatch → observe real outcome → decide again →
      end.
- [ ] A test proves adaptivity `026` structurally cannot do: a dispatched
      step **failing** causes a different next action rather than aborting.
- [ ] **A test proves rejection is terminal**: after a rejection, no further
      dispatch occurs and the supervisor node is not re-entered — including
      a case where an alternative skill could have achieved the same effect
      (rejected `dockerize` must not be followed by `create-compose`).
- [ ] **A test proves rejection is detected from the Orchestrator's own
      forwarded-rejection record, not from status or error text.** Adversarial
      case required: a child task that is `failed` with the error string
      `"Rejected by user"` but was **not** rejected through the Orchestrator
      must classify as `failed-ambiguous`, not `rejected`.
- [ ] **A test proves a generic `failed` from a write-capable skill does not
      permit adaptation** — it classifies `failed-ambiguous`, terminates the
      run, and surfaces a reconciliation request.
- [ ] **A test proves `failed-safe` is the only adaptation path**: a
      read-only skill failing permits the supervisor to choose a different
      next action, while the write-capable case above does not.
- [ ] **A test proves classification is not model-controlled**: the
      `DispatchOutcome` handed to the supervisor is computed by the
      deterministic adapter from raw status plus trusted Orchestrator facts
      plus the safety registry, and no model output can alter it.
- [ ] **A test proves no graph node or edge branches on raw task status** —
      only the adapter reads it, and graph routing consumes only
      `DispatchOutcome`.
- [ ] **An exhaustive registry test** compares the supervisor's dispatch
      allowlist against the safety registry, failing if any allowed skill
      lacks a classification or any registry entry is unreachable.
- [ ] **A test proves unknown skills default to write-capable/ambiguous**,
      never read-only.
- [ ] **A test proves drift is caught**: flipping a skill's registry entry
      from read-only to write-capable (or adding a write path without
      updating its classification) fails the suite rather than silently
      inheriting the stale classification.
- [ ] **A test proves duplicate-write prevention**: the same
      `(write-skill, target)` pair cannot be dispatched twice in one run.
- [ ] **A test covers each `DispatchOutcome` kind separately** — `completed`,
      `rejected`, `failed-safe`, `failed-ambiguous`, `timeout` — asserting
      the distinct routing defined for each.
- [ ] **A test proves each bound independently** terminates a run and emits
      `RUN_ERROR`.
- [ ] **A test proves audit completeness**: every supervisor decision and
      dispatch in a run appears in the audit record.
- [ ] A test proves a supervisor-chosen write-capable skill still produces
      `input-required` and still requires the `actionId`-bound approval,
      exercised through the real approval path.
- [ ] The `@ag-ui/langgraph` compatibility spike is completed against the
      exact pinned version, with its finding recorded in `verification.md`
      either way.
- [ ] A live real-API run demonstrates adaptive re-planning end to end, plus
      a real rejection confirmed terminal, with raw event captures as
      evidence.
- [ ] `bun run build` binary size delta measured and recorded.
- [ ] `CLAUDE.md`, `README.md`, `context/worklog.md` updated after the above.

## Verification Plan

- Automated: full suite, typecheck, spec governance, with the flag both
  unset and set (mocked model, mocked dispatch). The safety criteria above
  are each a named test, not a general assertion of correctness.
- Manual/live: one real-API run covering (a) adaptive re-planning after a
  genuine step failure, (b) a write-capable step stopping at the approval
  gate, (c) a **real human rejection confirmed terminal**, (d) a bound
  reached and terminating cleanly. Raw NDJSON captures as evidence.
- Spike finding for `@ag-ui/langgraph` recorded regardless of outcome.
- `bun run build` before/after size comparison.

## Approval Requested

Approval authorizes implementing `apps/orchestrator/supervisor-graph.ts`,
flag-gating the Orchestrator's `plan-task` path into it, changing
`planSteps` to append-as-decided, and running a time-boxed
`@ag-ui/langgraph` compatibility spike.

It does not authorize: adopting `@ag-ui/langgraph`, any external service or
LangGraph Server, persistence/checkpointers, weakening or relocating the
approval gate, changing `detectSkill()`'s fast paths, parallel dispatch,
giving the graph direct MCP tool access, or making the graph the default
path.
