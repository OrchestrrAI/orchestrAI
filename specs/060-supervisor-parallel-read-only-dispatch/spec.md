---
id: 060-supervisor-parallel-read-only-dispatch
title: Adaptive Supervisor — Parallel Dispatch, Read-Only Steps First
area: llm-harness
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-06
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-06
implemented_on: 2026-09-06
amends:
  - 028-orchestrator-langgraph-supervisor
supersedes: []
superseded_by: []
related:
  - 038-supervisor-default-and-planning-retirement
  - 051-planning-retirement-and-required-key
---

# Spec: Adaptive Supervisor — Parallel Dispatch, Read-Only Steps First

> Review gate: **APPROVED 2026-09-06 by Yusuf.** Drafted from
> `context/level-up-plan.html`'s "Real capability leverage" phase at
> Yusuf's request, continuing the roadmap's stated arrangement. Unlike
> specs 054/056/057/058/059 (already drafted from the specs/053 split),
> this is new: `specs/028-orchestrator-langgraph-supervisor/spec.md`'s
> own Out of Scope named "Parallel dispatch (LangGraph `Send`) —
> concurrent execution against a shared approval gate needs its own
> analysis," which this spec is that analysis, deliberately scoped to
> the one sub-case that sidesteps the hard problem entirely.

## Purpose

The adaptive supervisor (`specs/028`, the only `plan-task` planner as of
`specs/051`) dispatches exactly one skill at a time, always sequentially,
even when several of the model's own decisions are read-only and have no
dependency on each other's result. A plan opening with `analyze-project`
and `git-status` against the same target waits for the first to fully
complete — including a real MCP round trip and, for `analyze-project`, a
direct DevOps-to-Security A2A call — before the second is even
attempted. Real wall-clock cost, no safety benefit: read-only skills
(`SKILL_TIER_REGISTRY`, `apps/orchestrator/supervisor-graph.ts`) have no
approval gate, so nothing about running two of them at once introduces a
concurrent-approval question. This spec adds exactly that one case —
never a write-capable one — deliberately leaving `specs/028`'s own
harder deferred question (concurrent execution against the shared
approval gate) genuinely unaddressed, not quietly reopened.

## Verified Current State

Read directly from `apps/orchestrator/supervisor-graph.ts` on 2026-09-06.

- `supervisorNode()` calls `model.bindTools(tools, { tool_choice:
  "required" })` and returns whatever `AIMessage` the model produces,
  unmodified. `dispatchNode()` then reads only `last.tool_calls?.[0]` —
  **the first tool call**, unconditionally. A **real, previously
  unnoticed consequence** found while grounding this spec: nothing
  currently prevents the underlying provider from returning more than
  one `tool_calls` entry in a single response (parallel tool calling is
  a real, commonly-available feature of the chat-completion APIs this
  codebase's `buildChatModel()` already wraps) — if that ever happened
  today, every entry after the first would be **silently dropped**, not
  rejected or logged. This has not been observed live (the system prompt
  never invites more than one), but it is a latent gap this spec's own
  design must not leave open-ended in the opposite direction either (see
  Safety Constraints).
- `buildSystemPrompt()`'s own wording — `"Decide the single next skill to
  dispatch, or call finish when nothing more is needed."` — actively
  discourages a multi-call response even where the provider would
  otherwise allow one. Read-only fan-out cannot happen today regardless
  of provider capability, by prompt design, not by a structural gate.
- `classifySkillTier()` is fail-closed: an unregistered skill defaults to
  `write-capable`. `classifyDispatchOutcome()` can only ever produce
  `failed-safe` for a `read-only`-tier skill — `failed-ambiguous` is
  structurally unreachable for one (`apps/orchestrator/supervisor-graph.ts`
  lines 111–118). A read-only skill's own failure is therefore always
  safe to observe and continue from, individually or as part of a batch.
- `dispatchNode()`'s bound checks (`state.dispatchCount >=
  bounds.maxDispatches`, per-skill `attemptsSoFar >=
  bounds.maxAttemptsPerSkill`) both run **before** any dispatch, once per
  node invocation, for the single tool call being processed. Nothing
  about the bound-check shape assumes exactly one dispatch per node visit
  — it is already parametrized per skill/dispatch, not per invocation —
  but nothing today calls it more than once per node visit either.
- `deps.dispatch()`/`deps.wait()` are plain injected `async` functions
  with no shared mutable state between calls (each produces its own
  `childTaskId` via `crypto.randomUUID()`, per this repo's own
  ID-collision-avoidance convention) — nothing in their own contract
  assumes serialized invocation.

## Proposed Behavior

### 1. The system prompt may name more than one read-only step at once

`buildSystemPrompt()` gains an explicit instruction: when multiple
**read-only** steps are independently useful right now (neither depends
on what the other returns), the model may call `dispatch_skill` more
than once in the same turn. It is still told to decide one write-capable
step at a time, and still told it will see every real outcome before
deciding again.

### 2. `dispatchNode()` fans out only when every call in the turn qualifies

Read every `tool_calls` entry on the last `AIMessage`, not just index
`0`. The batch is eligible for concurrent dispatch **only when it passes
all of**:

- every entry's `name` is `dispatch_skill` (a `finish` call, or any
  unrecognized tool name, falls back to today's single-call handling
  entirely — never partially fanned out);
- every entry's `skill` classifies as `read-only` via
  `classifySkillTier()` — fail-closed, exactly as today: an
  unregistered skill is `write-capable` and disqualifies the whole
  batch from fan-out;
- there is more than one entry (a single `dispatch_skill` call is
  handled exactly as today — this spec changes nothing about the
  already-existing single-dispatch path, byte for byte).

Any batch that fails one of these conditions processes **only
`tool_calls[0]`**, identical to current behavior — this is the
structural fix for the silent-drop gap found above: a disqualified extra
tool call is never silently executed AND never silently dropped without
comment — the decision audit entry for that turn now always records
`toolCallCount` so a batch that included ignored calls is visible in the
log, not invisible.

### 3. Bounds are checked and consumed per branch, before any dispatch fires

The remaining budget (`bounds.maxDispatches - state.dispatchCount`) and
each skill's remaining per-skill attempts are computed **before** any
network call in the batch. Branches are dispatched in the model's own
listed order up to whatever remaining budget allows; any branch beyond
the remaining dispatch budget, or whose skill has already exhausted its
own attempt budget, is **not dispatched at all** — it is dropped with
its own `"decision"` audit entry (`reason:
"max-dispatches-reached"`/`"max-skill-attempts-reached"`, exactly the
existing reasons, now emitted per-branch instead of only for the whole
turn) and reported back to the model in the same observation message
so it knows that branch never ran. This is the literal meaning of the
roadmap's own "the two runaway bounds must count per branch" — a
five-branch batch against a budget of two dispatches left never becomes
a two-dispatch bound violation for the *next* turn; it dispatches
exactly two and reports the other three as not attempted.

### 4. Concurrent execution, one shared timeout policy

Every branch that clears bound-checking dispatches via `deps.dispatch()`
and awaits `deps.wait()` **concurrently** (`Promise.all()`), each
independently classified via the existing, unmodified
`classifyDispatchOutcome()`. Because every branch is read-only, the only
reachable per-branch outcomes are `completed`, `failed-safe`
(structurally, per Verified Current State above), or `timeout` —
`rejected` and `failed-ambiguous` are unreachable for a read-only tier
and need no batch-level handling.

- **Any branch timing out makes the whole turn terminal** (`terminal:
  "timeout"`), the same "a timeout is already ambiguous enough to stop
  the run" policy the single-dispatch path already applies — not
  relaxed just because other branches in the same batch may have
  completed successfully. Every branch's own outcome (including the
  successful ones) is still recorded in the audit log before the run
  ends, so a partial-success-then-timeout batch is fully visible, not
  hidden behind the terminal state.
- Otherwise, one `HumanMessage` observation is appended **per branch**
  (preserving today's one-message-per-skill granularity the model
  already reasons from), and the loop continues to the supervisor node
  exactly as today.

### 5. Everything else about the graph is unchanged

`buildDecisionTools()`, `classifySkillTier()`,
`classifyDispatchOutcome()`, the graph's own node/edge wiring, the
`recursionLimit` safety net, and duplicate-write prevention
(write-capable only, untouched — this spec adds no new write-capable
code path at all) are all unmodified.

## Scope

- `apps/orchestrator/supervisor-graph.ts`: `buildSystemPrompt()`,
  `dispatchNode()`, and the `SupervisorAuditEntry` shape (adds
  `toolCallCount`/per-branch entries — additive, no field removed).
- No change to `apps/orchestrator/index.ts`'s
  `buildOrchestratorSupervisorDeps()` — `deps.dispatch()`/`deps.wait()`
  are called the same way, just concurrently instead of one at a time;
  their own implementations are untouched.

## Safety and Compatibility Constraints

- **Never fans out a write-capable skill, under any condition** — the
  single disqualifying check (any entry classifying as `write-capable`)
  is fail-closed the same way `classifySkillTier()` already is: an
  unregistered skill disqualifies the whole batch, never silently
  passes through.
- **The approval gate is untouched** — nothing in this spec creates,
  observes, or influences an `actionId`; read-only skills have none to
  begin with.
- **No silent drop of an extra tool call** — the exact gap found in
  Verified Current State is closed structurally: a disqualified batch
  processes only `tool_calls[0]`, and the audit log always records how
  many calls the turn actually contained, whether or not they were all
  acted on.
- **Bounds are never exceeded** — `dispatchCount` after a batch never
  exceeds `maxDispatches`; a skill's attempt count after a batch never
  exceeds `maxAttemptsPerSkill`. Both checked and consumed per branch
  before that branch's own dispatch, not estimated for the batch as a
  whole.
- **The single-dispatch path is byte-identical** — a turn with exactly
  one `dispatch_skill` call (every turn produced by today's system
  prompt, and every turn from a provider that never emits parallel tool
  calls) behaves exactly as before this spec; this is fan-out
  *capability*, not a rewrite of the existing sequential path.
- No change to `DEFAULT_MAX_DISPATCHES`, `DEFAULT_MAX_ATTEMPTS_PER_SKILL`,
  or `DEFAULT_RECURSION_LIMIT`'s own values.

## Out of Scope / Non-Goals

- Concurrent execution of write-capable skills, or of any skill against
  a shared approval gate — `specs/028`'s own deferred hard problem,
  still deferred, not attempted here.
- LangGraph's `Send` API — this stays `Promise.all()` inside the
  existing `dispatchNode`, the same reasoning `specs/028` already used
  for choosing not to adopt more of LangGraph's machinery than the one
  multi-turn loop needed.
- Any change to which skills are classified read-only vs write-capable.
- Any change to Planning-retirement, per-component LLM config, or the
  conversational ask layer.
- Retrying a timed-out branch automatically — a batch timeout still ends
  the run, matching today's single-dispatch timeout policy exactly.

## Acceptance Criteria

- [x] A turn with a single `dispatch_skill` call behaves identically to
      today — same dispatch, same bound-check timing, same audit shape
      plus the additive `toolCallCount` field.
- [x] A turn with two-or-more `dispatch_skill` calls, all read-only,
      dispatches all of them concurrently (proven by asserting the
      injected `dispatch`/`wait` mocks were invoked before either had
      resolved, not just that both were eventually called).
- [x] A turn mixing a read-only and a write-capable `dispatch_skill`
      call processes only the first entry and ignores the rest — proven
      by asserting the write-capable skill's mock `dispatch()` was never
      called when it was not the first entry.
- [x] A batch that would exceed the remaining dispatch budget dispatches
      only as many branches as fit and records the rest as
      `max-dispatches-reached` per branch, not for the whole turn.
- [x] A batch where one branch times out and others complete ends the
      run with `terminal: "timeout"`, with every branch's own outcome
      still present in `auditLog`.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Pure/mocked tests against `supervisor-graph.ts`'s existing injected
  `SupervisorDeps` seam (no live model, no live agents — the same
  approach `supervisor-graph.test.ts` already uses for every scenario
  above except the model actually choosing to emit multiple tool calls).
- A live pass with a real provider: a real request shaped to plausibly
  produce two independent read-only steps (e.g. "analyze this project
  and show me its git status"), confirmed either to genuinely fan out
  (if the provider emits parallel tool calls) or to behave exactly as
  today (if it does not) — both are correct outcomes; this spec adds
  capability, it does not require a provider to use it.

## Approval Requested

Approval authorizes only: read-only-only parallel dispatch inside the
existing `dispatchNode`/`buildSystemPrompt()`, the additive audit-entry
field, and the bound-accounting/timeout-policy changes described above.
It does not authorize write-capable concurrency, any LangGraph `Send`
adoption, or any change outside `apps/orchestrator/supervisor-graph.ts`.
