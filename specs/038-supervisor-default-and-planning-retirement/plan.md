# Implementation Plan: Supervisor as Default Planner (Phase 1 / Option C)

This plan implements `038-supervisor-default-and-planning-retirement/spec.md`'s
**Phase 1 (Option C)** scope only. It cannot broaden that spec.

**Correction, 2026-09-02**: this plan originally described "Option B" (full
Planning retirement, unconditional supervisor, `suggest-agents` relocation,
routing-reason transparency) as a three-phase sequence. The spec itself was
revised to Option C the same day it was drafted (see spec.md's "Decision —
revised" section) — this plan was never updated to match until now, caught
while implementing. Rewritten to describe the actually-approved Phase 1 scope:
the supervisor becomes the *default* planner with a deterministic no-key
fallback to the unchanged Planning Agent; nothing is deleted or relocated.
The old B.1–B.6 content (unconditional supervisor, `suggest-agents`
relocation, Planning deletion, routing-reason transparency) is **not**
authorized by the approved spec and is deferred to a future, separately
proposed and approved Phase 2 plan — see spec.md's own Phase 2 section for
what that would cover.

## Preconditions

- `specs/028` at `verification: verified` — **met** (commit `6e3beca`).
- Yusuf's explicit approval of the Option C / Phase 1 scope — **met**
  (2026-09-02: "will make the supervisor the default / confirmed", then
  "let do that all" once the spec's own B.6 Approval Requested
  inconsistency was flagged and resolved).
- A clean working tree at start.

## Scope (single phase — this checkpoint is small enough not to need its own multi-commit sequence)

Planning Agent, its package, `suggest-agents`, its registry entry, and the
`watchPlanAndDispatch()`/`parsePlanText()` machinery are **retained,
unchanged** — Phase 1 changes only *when* the supervisor is chosen over
Planning, never anything about Planning itself.

- `apps/orchestrator/index.ts`:
  - `isOrchestratorGraphFlagSet()` → `isOrchestratorGraphEnabled()`: inverts
    the flag's default. `ORCHESTRAI_ORCHESTRATOR_GRAPH === "0"` is now the
    explicit opt-out; unset or any other value keeps the supervisor enabled
    (the new default).
  - New `supervisorShouldFallBackToPlanning()`: returns `true` only when
    `readLlmModelConfig(env, "orchestrator")` cleanly returns `null` (a
    genuinely absent key) — never on a thrown error (an invalid
    provider/model is a real misconfiguration, not "nothing configured",
    and must keep failing closed via `runOrchestratorSupervisor()`'s own
    existing error path).
  - `POST /tasks`'s `skill === "plan-task"` branch condition becomes
    `isOrchestratorGraphEnabled() && !supervisorShouldFallBackToPlanning()`;
    when false, execution falls through unchanged to the existing sequential
    `sendTaskToAgent()` → `watchPlanAndDispatch()` path — the exact same code
    that ran when the flag was off before this spec.
  - `runOrchestratorSupervisor()`'s own `!config` branch becomes a defensive,
    normally-unreachable fail-closed guard (the call site already filters
    out the "no key" case before ever calling it) — kept, not deleted, per
    the "never a silent fallback" precedent, in case the two checks ever
    diverge.
  - New `describeSupervisorStartupState()` + a line in `start()`'s startup
    log — states which planner is active and why (enabled/default,
    misconfigured, no-key-fallback, or explicitly disabled), mirroring the
    shape every agent's own `readLlmHarnessStartupState()` already prints.
    Never renders a credential value.
- Tests: `apps/orchestrator/supervisor-wiring.test.ts` rewritten for the new
  semantics — flag genuinely unset + real key → supervisor runs by default;
  explicit `ORCHESTRAI_ORCHESTRATOR_GRAPH=0` with a valid key → still reaches
  Planning (proves a genuine opt-out, not a coincidental no-key fallback); no
  key configured (default-enabled) → falls back to Planning, same output as
  pre-038; invalid provider → still fails closed, never contacting Planning.
- Gate: `bun test`, `bun run typecheck`, `bun run specs:check` green.

## Explicitly deferred to a future Phase 2 (its own checkpoint, its own approval)

Everything from the original Option B draft: `detectSkill()` returning
`{ skill, reason }` and routing-reason transparency (B.6); relocating
`suggest-agents` into the Orchestrator (B.2); making the supervisor the
*only* planner with no fallback (B.1); deleting
`packages/agents/planning/**`, its registry entry, and its place in
`apps/supervisor/index.ts`/`package.json` (B.3); the five-agents-to-four
documentation sweep (B.4). None of this is touched here.

## Affected Paths

- `apps/orchestrator/index.ts`
- `apps/orchestrator/supervisor-wiring.test.ts`
- `CLAUDE.md`, `README.md`, `context/worklog.md`
- `specs/038-.../spec.md`, `plan.md`, `verification.md`

## Rollback / Recovery

A single commit; `ORCHESTRAI_ORCHESTRATOR_GRAPH=0` reaches the exact
pre-038 sequential behavior without any code change, so this is reversible
by environment variable as well as by `git revert`.

## Completion Checklist

- [ ] Phase 1 acceptance criteria in `spec.md` all pass.
- [ ] No out-of-scope behavior introduced (approval gate, supervisor graph
      internals, `detectSkill()`'s return shape, Planning Agent itself all
      untouched).
- [ ] `bun test` / `typecheck` / `specs:check` / `build` green.
- [ ] Live verification recorded; `verification` set honestly.
- [ ] Worklog entry written; handoff complete.
