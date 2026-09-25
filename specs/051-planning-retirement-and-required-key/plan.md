# Plan: Planning Agent Retirement and a Required Provider Key

> Depends on `spec.md` in this directory being **approved** first. This plan
> cannot broaden it.

## Why the ordering matters

Deleting a service and adding a startup refusal are both easy to get
half-right in a way tests still pass. The sequencing below is chosen so
that at the end of every phase the repo is in a runnable, testable state —
never "planning is half-deleted and nothing starts".

The `suggest-agents` move happens **before** the deletion for exactly that
reason: relocate and prove it works while the original is still there to
compare against, then delete.

## Phase 1 — Relocate `suggest-agents`, with Planning still alive

1. Capture the current output for a set of inputs (empty, "test",
   "security", "readme", a combination) from the running Planning agent —
   real captured strings, committed as the comparison baseline.
2. Implement it in the Orchestrator as a directly-served skill, dropping
   only the `code-review-agent (coming soon)` line.
3. Tests assert the new output equals the captured baseline minus that
   line, per input.

**Exit gate:** both implementations exist and agree; the Orchestrator can
serve `suggest-agents` without dispatching to Planning.

## Phase 2 — The startup key requirement, mechanism and agent harnesses only

**A sequencing correction found while implementing, not in the original
plan:** the spec's §2 says "the Orchestrator is always checked — it is
now the only planner." That is only true **after** Phase 3 removes the
deterministic fallback; enforcing it here, one phase early, would make the
code assert something the rest of the codebase does not yet agree with
(the fallback is still live and still reachable from `bun run
dev`/`bun run orchestrator` during this phase). So the orchestrator's own
requirement moves to Phase 3, bundled with removing the thing that makes
it true. Phase 2 ships the reusable mechanism and enforces it for what is
unconditionally correct right now: **an agent's own harness needs a key
the moment that harness is on, regardless of anything about Planning.**

1. `checkStartupLlmKeys()` (`packages/shared/llm-model-factory.ts`): a
   pure resolver — given env and a list of `{component, reason}`, returns
   which have no resolvable key (`missing`) and which have a real
   configuration error (`misconfigured`, since `readLlmModelConfig()`
   throws rather than returning null for those). Built on that exact
   function, so the check and reality cannot disagree about what
   "configured" means.
2. `main()` calls it, before any port preflight or spawn, with one
   requirement per agent in `toStart` whose own harness env var is on.
   Refuses with a named, actionable error naming each component and its
   reason, pointing at `orchestrai init`.
3. The message states plainly that presence is all that can be checked —
   a wrong key still fails at first use.
4. **Explicitly not yet enforced here:** the Orchestrator's own
   requirement — that lands in Phase 3.

**Exit gate:** an agent harness on with no resolvable key refuses to
start, naming that component; a stack with every harness off starts with
no key at all, since nothing yet requires one; the misconfigured/missing
split is correct for an agent harness case.

**Stop condition:** if honouring per-component resolution turns out to
need anything beyond `readLlmModelConfig`, stop — that would mean the
runtime and the check disagree about what "configured" means, which is
worse than no check.

## Phase 3 — Remove the fallback and the opt-out; the Orchestrator's own key requirement

1. Delete `supervisorShouldFallBackToPlanning()` and its branch.
2. Delete the `ORCHESTRAI_ORCHESTRATOR_GRAPH` opt-out and the
   `isOrchestratorGraphEnabled()` gate.
3. Rewrite the startup planner report: it no longer has three states to
   distinguish, only the resolved provider/model/key sources.
4. **This is the phase where the deferred half of Phase 2 lands**: add
   `{component: "orchestrator", reason: "the only plan-task planner"}` to
   `main()`'s requirement list whenever `startOrchestrator` is true — now
   correct, because this phase is what makes it true.

**Exit gate:** `plan-task` always reaches the supervisor; no code path
remains that can dispatch to a Planning agent; a stack starting the
Orchestrator with no key anywhere refuses, naming it.

## Phase 4 — Delete the agent

1. Remove `packages/agents/planning/` and all five external references.
2. Free port 3001 — remove, do not reassign.
3. Drop `"planning"` from `LLM_COMPONENTS`; remove the Planning harness
   toggle from the wizard and the form; remove
   `ORCHESTRAI_LLM_HARNESS` from `formatConfigEnv`/`WIZARD_OWNED_KEYS`.
4. Stale-variable warnings for the three now-dead variables.

**Exit gate:** no source file outside `specs/`/`context/` names
`planning-agent`; a real stack starts four agents; `netstat` shows 3001
unbound; an old-format config warns and still starts.

**Stop condition:** if removing the Planning harness toggle turns out to
disturb `specs/050`'s row budget or field ordering in a way the existing
layout tests do not catch, stop and re-verify with a PTY capture before
continuing — that form has produced five live-caught layout bugs already.

## Phase 5 — Verification and documentation

1. Full gates, run **with no API key present** — the load-bearing proof
   that the suite still works unfunded.
2. Live, compiled binary: four-agent startup, 3001 unbound, the three
   refusal cases, an old-config warning run, and a real `plan-task`
   through the supervisor.
3. With Yusuf's real key: one genuine adaptive multi-step run, confirming
   `specs/028`'s dispatch behavior did not regress when its fallback
   sibling was removed.
4. `CLAUDE.md` (extensive — the "no LLM calls by default" framing, the
   agent table, ports, the Planning sections), `README.md`,
   `docker-compose`, `context/worklog.md`, `verification.md`.

**Exit gate:** the documentation no longer describes a five-agent stack
or a deterministic planner, and every claim in it matches a verification
result.

## Stop Conditions (whole plan)

Return for review if implementation would require: making an agent
harness mandatory; changing `detectSkill()`, the semantic classifier, or
any routing decision; touching the approval gate, tiering, or
write-capability rules; reassigning port 3001; adding a dependency; or
weakening any of `specs/028`'s supervisor safety properties (terminal
rejection, effect-certainty, the two runaway bounds).

If a phase's exit gate cannot be met, stop at that phase — the repo is
runnable at every boundary by design, so stopping is always safe.
