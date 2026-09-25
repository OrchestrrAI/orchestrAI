---
id: 077-agent-enabled-means-llm-on-by-default
title: Selecting/Starting an Agent Enables Its LLM Harness by Default
area: agents
change_type: enhancement
status: implemented
verification: pending
created: 2026-09-12
updated: 2026-09-14
approved_by: Yusuf
approved_on: 2026-09-14
implemented_on: 2026-09-14
amends:
  - 039-per-component-llm-provider-config
  - 041-llm-harness-documentation
  - 042-llm-harness-devops
  - 043-llm-harness-security
  - 031-interactive-init-wizard
  - 080-run-command-approved-execution
related:
  - 070-init-agent-implies-llm-and-model-first-setup
  - 064-supervisor-startup-key-check-non-blocking
supersedes: []
superseded_by: []
---

# Spec: Selecting/Starting an Agent Enables Its LLM Harness by Default

> Review gate: **APPROVED 2026-09-14 by Yusuf.**
>
> **Correction, same day, found during implementation, not assumed
> away**: this spec's own "Verified Current State" claimed Testing
> Agent "has no `model-factory.ts`, no harness flag at all — genuinely
> out of scope." That was true when drafted but went stale the same
> day — `specs/080` (implemented 2026-09-12) gave Testing its own
> `packages/agents/testing/model-factory.ts` and
> `ORCHESTRAI_TESTING_LLM_HARNESS` flag, already listed in
> `AGENT_LLM_HARNESSES`. Confirmed directly with Yusuf before
> implementing: **Testing is now in scope too**, flipped the same way
> as the other three, for the same consistency reason this spec exists
> at all. Testing's harness is narrower in purpose than the other
> three's (it only proposes a `run_command` replacement when
> `detectRunner()` finds nothing supported, never general content/
> parameter generation) — this doesn't change what its harness *does*,
> only whether it's active by default, the same distinction this whole
> spec already draws for the other three.
>
> Yusuf's own words, 2026-09-12: *"enabling an agent should mean you
> will make it llm just that."* `specs/070` already made this true for
> the guided-init **form** (TUI + browser) — selecting an agent there
> writes its harness `=1`. This spec makes it true everywhere else too:
> the runtime default, and the classic prompt wizard.

## Purpose

Three surfaces can enable DevOps/Documentation/Security today, and only
one of them (`specs/070`'s guided-init form) already treats "selected"
and "LLM-driven" as the same decision. The classic wizard still asks a
separate y/n per agent (`specs/031`/`050`), and — the part that matters
regardless of which wizard was used — every agent's own runtime default
is **off**: `packages/agents/<agent>/model-factory.ts` requires an
explicit `ORCHESTRAI_<AGENT>_LLM_HARNESS=1`. Anyone starting an agent
directly (`bun run devops-agent`, `bun run dev`, a hand-written
`config.env`, `orchestrai --only devops-agent` with no wizard run at
all) gets the deterministic, template-only path with no signal that a
richer one exists, let alone that it's one flag away.

## Verified Current State

Read 2026-09-12:

- `packages/agents/devops/model-factory.ts`,
  `packages/agents/documentation/model-factory.ts`,
  `packages/agents/security/model-factory.ts`: each has one line,
  `return env.ORCHESTRAI_<AGENT>_LLM_HARNESS === "1"` — opt-in,
  default **off**.
- `apps/supervisor/index.ts`'s `resolveAgentLlmKeyRequirements()`
  (specs/051 §2) only flags an agent's key requirement at startup when
  `env[h.envVar] === "1"` — matching today's opt-in default exactly;
  this must move in lockstep with the flag above or the startup warning
  would silently stop firing for the agents that now need it by default.
- `apps/supervisor/init-wizard.ts`'s `runInitWizardInner()`: for every
  selected agent with a harness, asks `"Enable ${label}? (y/n)"`
  individually and writes whatever the human answers
  (`agentLlm[field] = answer === "y"`).
- `apps/supervisor/init-form-state.ts`'s `formStateToWizardConfig()`
  (specs/070, TUI + browser forms only): already writes `agentLlm[field]
  = true` for every selected agent with a harness, unconditionally — no
  toggle exists there any more. This is the one surface already matching
  what this spec asks for everywhere.
- `packages/agents/testing/`: has no `model-factory.ts`, no harness flag
  at all — genuinely out of scope here, unaffected either way (that's
  `specs/078`, a separate, unrelated ask).
- Every one of `041`/`042`/`043`'s own live-verified byte-identical-when-
  disabled claims assumed **absent = off**; this spec flips which state
  is the silent default, not the mechanism itself.

## Proposed Behavior

### 1. The runtime default flips: on unless explicitly disabled

Each of the three `model-factory.ts` files changes from

```ts
return env.ORCHESTRAI_<AGENT>_LLM_HARNESS === "1"
```

to

```ts
return env.ORCHESTRAI_<AGENT>_LLM_HARNESS !== "0"
```

Absent, empty, or any value other than the literal string `"0"` now
means **on**. This is the one line that makes "the agent is running" and
"its harness is active" the same fact by construction — no
supervisor-level coordination needed, since an agent whose process never
starts was never going to read this variable at all either way. An
explicit `=0` remains a real, working, deliberate opt-out for someone
who wants the deterministic template path back (e.g. cost-conscious, or
no key available yet).

### 2. The supervisor's startup key check moves with it

`resolveAgentLlmKeyRequirements()`'s condition changes from
`env[h.envVar] === "1"` to `env[h.envVar] !== "0"`, matching §1 exactly
— so the existing non-blocking startup warning (`specs/064`) still
correctly names a missing/misconfigured key for an agent whose harness
is now on by default, instead of silently missing it because the old
condition no longer matched the new default.

### 3. The classic wizard stops asking, matching the form

`runInitWizardInner()`'s per-agent `"Enable ${label}? (y/n)"` loop is
removed. Every selected agent with a harness gets `agentLlm[field] =
true`, unconditionally — the exact same rule `formStateToWizardConfig()`
(`specs/070`) already applies. All three surfaces (classic wizard, TUI
form, browser form) now agree for the first time: **selecting the agent
is the only decision; there is no separate LLM toggle anywhere.**

### 4. What this changes for someone who does nothing differently

A fresh `orchestrai init` run (any surface), or a bare `ORCHESTRAI_ONLY=
devops-agent` with no per-agent flag set at all, now genuinely activates
DevOps's real content-generation harness the first time `dockerize` (or
any of its four write skills) runs — not the deterministic template.
This needs a real, working provider key wherever any of these three
agents is selected, same as the Orchestrator's own adaptive supervisor
already unconditionally requires one (`specs/051`). The non-blocking
startup warning (§2) names this immediately; the actual call still fails
closed with a named error if the key doesn't resolve, exactly as
`041`/`042`/`043` already specify for the opt-in case — no new failure
mode, just a more common trigger for an existing one.

## Scope

- `packages/agents/devops/model-factory.ts`,
  `packages/agents/documentation/model-factory.ts`,
  `packages/agents/security/model-factory.ts`: the default flip.
- `apps/supervisor/index.ts`: `resolveAgentLlmKeyRequirements()`'s
  matching condition.
- `apps/supervisor/init-wizard.ts`: remove the classic wizard's
  per-agent y/n harness question; write `true` unconditionally for every
  selected harness-capable agent.
- Tests: each agent's `model-factory.test.ts` (default-on, explicit `=0`
  opt-out, `=1` still works), `resolveAgentLlmKeyRequirements()`'s own
  test (flips with the new default), `init-wizard.test.ts` (the y/n
  question is gone; a selected agent always gets `=1` written).
- **Out of scope / unchanged**: `specs/070`'s own form behavior (already
  correct, this just brings the other surfaces in line with it); the
  Orchestrator's own adaptive-supervisor requirement (`specs/051`,
  already unconditional); any change to what a harness actually does
  once active — only whether it's active by default.

## Safety and Compatibility Constraints

- **No approval-gate change of any kind.** A harness-on agent's write
  skills still go through the exact same `actionId`-bound approval flow;
  this spec only changes whether the LLM decides *parameters*
  (DevOps)/*content* (Documentation)/*commentary* (Security) — never
  whether human approval is required.
- **Explicit `=0` is a real, working, permanent opt-out** — never removed
  or deprecated by this spec. A cost-conscious or key-less setup can
  still get the deterministic path for any specific agent.
- **Fail-closed on first real use, not fail-blocking at startup** —
  unchanged from `specs/064`'s own correction: a missing key is named
  loudly and non-fatally at startup, and fails the specific call closed
  with a named error the moment one is actually attempted. No agent
  process refuses to start over this.
- **Byte-identical behavior for `=1`.** Anyone who already explicitly
  set `ORCHESTRAI_<AGENT>_LLM_HARNESS=1` sees no change at all.

## Out of Scope / Non-Goals

- Testing Agent gaining a harness of any kind (separate ask, tracked as
  its own spec).
- Any change to the Orchestrator's own `plan-task` requirement.
- Removing the `ORCHESTRAI_<AGENT>_LLM_HARNESS` variable itself — `=0`
  remains a first-class, documented value, not a deprecated escape
  hatch.
- Any change to per-component provider/model/key resolution
  (`specs/039`/`063`) — this only changes the on/off default, never how
  a component resolves its provider once active.

## Acceptance Criteria

- [ ] Starting DevOps/Documentation/Security with no
      `ORCHESTRAI_<AGENT>_LLM_HARNESS` set at all now runs the real
      harness (given a valid key), not the deterministic template.
      **Unit-verified only** (`isHarnessFlagSet()` correctly returns
      `true` with the var absent) — not yet confirmed live against a
      real provider call producing genuinely richer output; see
      `verification.md`.
- [x] `ORCHESTRAI_<AGENT>_LLM_HARNESS=0` still produces the exact
      byte-identical deterministic output `041`/`042`/`043` originally
      verified for "disabled." Confirmed at the unit level for all four
      agents (`isHarnessFlagSet()` returns `false`,
      `readLlmHarnessConfig()` returns `null`, identical to the old
      `=== "1"` gate's own "unset" behavior).
- [x] `ORCHESTRAI_<AGENT>_LLM_HARNESS=1` is unaffected — same behavior
      as always. Every pre-existing `=1` test passes unmodified.
- [x] The supervisor's non-blocking startup key check fires for an
      agent whose harness is on by the new default, not just an
      explicit `=1`.
- [x] The classic wizard no longer asks a per-agent y/n harness
      question; a saved config selecting an agent always carries its
      harness `=1`, matching the TUI/browser forms exactly. Confirmed
      by direct code inspection (the prompt loop is deleted, replaced
      with an unconditional write) — the interactive real-terminal pass
      itself was not performed, the same standard every classic-wizard
      change in this codebase carries.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `CLAUDE.md` (all four agent harness sections, now opt-*out*) and
      `context/worklog.md` updated.

## Verification Plan

- Unit: each agent's `model-factory.test.ts` covering all three states
  (unset, `=0`, `=1`); `resolveAgentLlmKeyRequirements()`'s updated
  condition; the classic wizard's removed question and its unconditional
  write.
- Live, with a real provider key: start DevOps with no harness variable
  set at all and confirm a real `dockerize` call genuinely uses the LLM
  path (real app-type detection from file content, matching `042`'s own
  original live-verification scenario) rather than the old deterministic
  guess — the decisive proof this is really on by default, not just
  unit-tested.
- Live: the same scenario with `=0` set, confirming the exact original
  deterministic output returns.

## Approval Requested

Approve to proceed. Amends `specs/039`/`041`/`042`/`043` (each agent's
own harness default) and `specs/031` (the classic wizard's own
question). Nothing is implemented until then.
