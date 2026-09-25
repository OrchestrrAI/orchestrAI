---
id: 051-planning-retirement-and-required-key
title: Planning Agent Retirement and a Required Provider Key
area: orchestrator
change_type: migration
status: implemented
verification: verified
created: 2026-09-05
updated: 2026-09-05
approved_by: Yusuf
approved_on: 2026-09-05
implemented_on: 2026-09-05
amends:
  - 038-supervisor-default-and-planning-retirement
  - 028-orchestrator-langgraph-supervisor
supersedes: []
superseded_by: []
related:
  - 026-llm-harness-langgraph-planning
  - 028-orchestrator-langgraph-supervisor
  - 030-authoritative-skill-dispatch-and-capability-catalog
  - 039-per-component-llm-provider-config
  - 050-init-per-agent-llm-toggles
---

# Spec: Planning Agent Retirement and a Required Provider Key

> Review gate: **APPROVED by Yusuf, 2026-09-05.** Implementation follows
> `plan.md`'s phases; each phase's exit gate must pass before the next.

## Purpose

`specs/038` Phase 1 made the Orchestrator's adaptive supervisor the default
`plan-task` planner but deliberately kept the Planning Agent alive as a
deterministic fallback, and explicitly deferred its deletion to a Phase 2
that was never authorized. This checkpoint is that Phase 2, plus the
decision that makes it safe to do: **a provider key becomes a startup
requirement rather than an optional enhancement.**

The two are one change, not two. Planning exists today almost entirely to
be the thing that happens when no key is configured. Once a key is
guaranteed, the fallback has no job, and keeping it means maintaining a
second planner that real runs never reach.

## Verified Current State

Measured on 2026-09-05, not assumed:

1. **Planning is 9 files, ~1,700 lines** (`packages/agents/planning/`),
   including its own MCP client, LangGraph harness (`specs/026`), and
   capability discovery (`specs/030`).

2. **It is referenced from exactly five places outside its own package:**
   - `packages/shared/agent-registry.ts:10` — the fixed URL list
   - `apps/orchestrator/index.ts:2938` — `KNOWN_AGENTS` discovery
   - `apps/supervisor/index.ts:66` — `SERVICE_STARTERS`
   - `apps/supervisor/index.ts:90` — the `AGENTS` port table
   - `apps/supervisor/agent-catalog.ts:32` — the form's display catalog

3. **`suggest-agents` is ~30 lines of pure keyword matching**
   (`packages/agents/planning/index.ts:277`), with no MCP, no LLM, and no
   state. It currently advertises a `code-review-agent — (coming soon)`
   that does not exist in this codebase. Relocating it is a copy, not a
   port.

4. **The fallback is one predicate.**
   `supervisorShouldFallBackToPlanning()`
   (`apps/orchestrator/index.ts:781`) is literally
   `readLlmModelConfig(env, "orchestrator") === null`. The same call is
   what a startup key requirement would be built on — the mechanism
   already exists and is already correct about the two-tier per-component
   resolution.

5. **CI supplies no key.** `.github/workflows/ci.yml` references no
   secrets, and all 733 tests currently pass with zero LLM configuration.
   14 of 50 test files touch Planning or the deterministic planner path.
   This is the single biggest constraint on how far this checkpoint can
   go, and is why the agent harnesses stay opt-in (§3).

6. **`ORCHESTRAI_ORCHESTRATOR_GRAPH=0` routes `plan-task` to Planning.**
   With Planning deleted this opt-out has nowhere to route to.

## Proposed Behavior

### 1. The Planning Agent is deleted

`packages/agents/planning/` is removed entirely, along with its entry in
all five registries above, its port (3001 is freed), its dashboard, its
Agent Card, and its tests. The stack becomes **four agents**, not five.

`suggest-agents` moves into the Orchestrator as a directly-served skill,
keeping its current deterministic keyword behavior byte-for-byte — with
one correction, since it is being touched anyway: the `code-review-agent
(coming soon)` line is removed, because recommending an agent that does
not exist is a bug, not a feature.

`plan-task` remains a real skill id that `detectSkill()` can return. It
simply always reaches the supervisor now, never a dispatched child.

### 2. A provider key is required at startup

`apps/supervisor/index.ts`'s `main()` refuses to start when the
components that *will* make calls have no resolvable key, printing a
named, actionable error that points at `orchestrai init`. The check is
precise rather than blanket:

- The **Orchestrator** is always checked — it is now the only planner.
- Each **agent whose own harness flag is on** is checked, using that
  agent's own component name, so `specs/039`'s per-component resolution
  is honoured exactly as it is at runtime.
- An agent whose harness is off is not checked, because it will not make
  a call.

**What "required" can honestly mean.** A key can only be checked for
presence and for the provider/model config parsing. Nothing can verify a
key actually *works* without spending a call, so a wrong or expired key
still fails at first use. The startup message says this plainly rather
than implying a guarantee the design cannot deliver.

### 3. Agent harnesses stay opt-in

DevOps, Documentation and Security keep their own
`ORCHESTRAI_<AGENT>_LLM_HARNESS` toggles, exactly as `specs/050` just
exposed them. This is the deliberate boundary of this checkpoint:
requiring a key removes the *confusing* case (a stack that silently does
nothing LLM-shaped), while keeping the *useful* choice (where cost and
latency are spent). It is also what keeps the test suite and CI working
without a key, per Verified Current State (5).

### 4. Dead configuration is removed, and says so

- `ORCHESTRAI_LLM_HARNESS` (Planning's own gate) stops being written or
  read. The setup form's "LLM planning harness" toggle disappears.
- `ORCHESTRAI_ORCHESTRATOR_GRAPH` stops being read — with no fallback
  target, an opt-out is meaningless.
- `LLM_COMPONENTS` drops `"planning"`, so
  `ORCHESTRAI_PLANNING_LLM_*` no longer resolves anywhere.

A config still containing any of these gets **one explicit warning naming
the variable and that it no longer does anything** — and then starts
normally. A stale flag from a previous version must never brick a
startup. `specs/050`'s `mergeConfigEnv()` removes the wizard-owned ones
on the next `init` automatically, since they leave `WIZARD_OWNED_KEYS`.

## Scope

- Delete `packages/agents/planning/` and its five external references.
- `apps/orchestrator/index.ts`: serve `suggest-agents` directly; delete
  `supervisorShouldFallBackToPlanning()` and the fallback branch; delete
  the `ORCHESTRAI_ORCHESTRATOR_GRAPH` opt-out; update `KNOWN_AGENTS` and
  the startup planner report.
- `apps/supervisor/index.ts`: the startup key requirement; remove
  Planning from `AGENTS`/`SERVICE_STARTERS`.
- `packages/shared/llm-model-factory.ts`: drop `"planning"` from
  `LLM_COMPONENTS`.
- `apps/supervisor/init-wizard.ts` / `init-form-state.ts` /
  `init-form.tsx`: remove the Planning harness question/toggle; stale-var
  warnings.
- `packages/shared/agent-registry.ts`, `agent-catalog.ts`, Docker
  compose, README, CLAUDE.md, dashboards, CI smoke steps — every place
  that names five agents or port 3001.

## Safety and Compatibility Constraints

- **The approval gate is untouched.** No change to
  `packages/shared/approval.ts`, to any `actionId` flow, or to which
  skills are write-capable. Deleting a planner does not change what
  requires human approval.
- **Routing stays deterministic.** `detectSkill()`'s keyword matching and
  the local Model2Vec semantic fallback (`specs/020`) are not LLM calls
  and are explicitly not in scope. "Always runs with a key" is about
  planning and agent harnesses, not about how a request is classified.
- **`specs/028`'s supervisor safety properties are preserved verbatim**:
  rejection is terminal, adaptation requires proven effect-certainty, and
  both runaway bounds stay exactly as they are.
- **No silent behavior change on an old config.** Every removed variable
  produces a named warning, never a silent ignore and never a crash.
- **Port 3001 is freed, not reassigned.** Nothing moves onto it in this
  checkpoint.

## Out of Scope / Non-Goals

- Making agent harnesses non-optional (that was the rejected Option 1;
  it requires mocked models or a funded CI key first).
- Any change to `detectSkill()`, the semantic classifier, or routing.
- Any change to the approval gate, tiering, or write-capability rules.
- Per-component provider/key configuration in `init` — that is the
  follow-up checkpoint this one unblocks.
- Adding a Code Review agent, despite `suggest-agents` currently naming
  one.
- Reassigning port 3001 or renumbering any other service.

## Acceptance Criteria

- [ ] Explicit approval is recorded before implementation.
- [ ] `packages/agents/planning/` no longer exists; no source file
      outside `specs/` and `context/` references it.
- [ ] A real stack starts with **four** agents; nothing binds 3001.
- [ ] `suggest-agents` served by the Orchestrator returns the same text
      as today for the same input, minus the `code-review-agent` line —
      asserted against a captured before/after, not by eye.
- [ ] Startup with no key anywhere refuses with a named error naming
      `orchestrai init`, and starts nothing.
- [ ] Startup with a shared key but an agent harness on and no key
      resolvable for that component refuses, naming that component.
- [ ] Startup with harnesses off and a shared key present succeeds.
- [ ] A config containing `ORCHESTRAI_LLM_HARNESS`,
      `ORCHESTRAI_ORCHESTRATOR_GRAPH`, or `ORCHESTRAI_PLANNING_LLM_MODEL`
      warns once per variable and still starts.
- [ ] A live `plan-task` request reaches the supervisor and completes a
      real multi-step dispatch, with no Planning agent in existence.
- [ ] `bun test`, `bun run typecheck`, `bun run specs:check`,
      `bun run build` pass — with **no** API key present, proving the
      suite still runs unfunded.
- [ ] `CLAUDE.md`, `README.md`, `docker-compose`, and
      `context/worklog.md` updated.

## Verification Plan

**Automated.** The relocated `suggest-agents` gets the deterministic
tests Planning's copy had. New tests for the startup key requirement:
none configured, shared only, per-component satisfying an enabled agent,
and an enabled agent with nothing resolvable. Stale-variable warnings
asserted on the exact strings.

**The load-bearing regression check:** the full suite must pass with no
LLM configuration at all — that is what proves §3's boundary held and CI
still works.

**Live, against the compiled binary.** A four-agent stack starting
clean; `netstat` confirming 3001 unbound; a real `plan-task` request
completing through the supervisor; the three refusal cases each printing
their named error and starting nothing; an old-format config producing
warnings and still starting.

**Live with a real provider key** (Yusuf's, as with every prior LLM
checkpoint here): one genuine adaptive multi-step run end to end,
confirming nothing about `specs/028`'s dispatch behavior regressed when
its fallback sibling was removed.

## Approval Requested

Approval authorizes: deleting the Planning Agent and relocating
`suggest-agents` into the Orchestrator; removing the `plan-task`
deterministic fallback and the `ORCHESTRAI_ORCHESTRATOR_GRAPH` opt-out;
making a resolvable provider key a startup requirement for the
Orchestrator and for any agent whose harness is enabled; and warning on
the variables that become dead.

It does **not** authorize: making agent harnesses mandatory, any change
to routing/`detectSkill()`, any change to the approval gate, per-component
provider/key UI, or reassigning port 3001.
