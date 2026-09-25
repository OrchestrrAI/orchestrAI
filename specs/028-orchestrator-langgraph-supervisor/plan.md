# Implementation Plan: LangGraph Adaptive Supervisor for the Orchestrator

This plan implements `028-orchestrator-langgraph-supervisor/spec.md`. It
cannot broaden that spec.

## Preconditions

- `specs/028` explicitly approved by Yusuf (`status: approved`).
- **`specs/026` at `verification: verified`** — live real-API run complete.
- **`specs/027-ag-ui-core-adoption` implemented** — the official AG-UI types
  are already in place, so no protocol-source migration happens inside this
  checkpoint.
- Repository green at HEAD: `bun test`, `bun run typecheck`,
  `bun run specs:check`.

## Phases

Ordered so every safety mechanism is built and tested **before** anything is
wired into the running Orchestrator, and so each phase leaves the repository
green and committable.

### Phase 1 — `@ag-ui/langgraph` compatibility spike (time-boxed, no code)

Done first because its outcome affects Phase 4's event-mapping work, and
because it is the cheapest way to invalidate an assumption early.

1. Pin an exact `@ag-ui/langgraph` version; read its package source —
   specifically `LangGraphAgentConfig` and the runtime path that calls
   `client.runs.stream(...)`.
2. Determine whether an embedded, in-process compiled graph can be used with
   **no LangGraph API server**.
3. Record the finding in `verification.md` **either way**, including the
   version inspected.

The spike may only *remove* work (by enabling adapter use in a later
checkpoint). It may not add scope to this one. Manual event mapping remains
the planning assumption regardless of outcome.

### Phase 2 — Supervisor graph in isolation, with all safety mechanisms

Nothing is wired into the running Orchestrator in this phase; the module is
dead code until Phase 3. Every safety property is implemented and tested
here, not retrofitted after wiring.

1. `apps/orchestrator/supervisor-graph.ts`: `supervisor` and `dispatch`
   nodes, depending on **narrow injected function types** for
   dispatch/wait rather than importing `apps/orchestrator/index.ts`
   directly — mirroring `026`'s `McpToolCaller` interface, so tests need no
   HTTP server, no real agents, and no live model.
2. Implement the `DispatchOutcome` effect-certainty contract **first** — it
   is the type every other safety property branches on, so building it
   after the graph would mean retrofitting safety onto existing control
   flow. Specifically: classification computed in the `dispatch` node from
   Orchestrator-side facts plus a static skill-tier table, defaulting to
   `failed-ambiguous`, never derived from task status or error text.
3. Implement, each with its own named test:
   - terminal rejection, structurally enforced (state flag routes to `END`;
     `supervisor` unreachable afterward), including the "alternative skill
     achieving the same effect" case;
   - the adversarial rejection case: `failed` + `"Rejected by user"` error
     text **not** forwarded through the Orchestrator must classify
     `failed-ambiguous`, not `rejected`;
   - a generic `failed` from a write-capable skill does **not** permit
     adaptation;
   - `failed-safe` (read-only failure) is the only adaptation path;
   - duplicate `(write-skill, target)` prevention;
   - each `DispatchOutcome` kind's distinct routing;
   - both bounds (global dispatch limit, per-skill retry limit) plus an
     explicit `recursionLimit`;
   - audit emission for every decision and every dispatch.
4. Prove adaptivity: a `failed-safe` step leads to a *different* next
   action — and that a `failed-ambiguous` step does not.

### Phase 3 — Wire in, flag-gated

1. Add the `ORCHESTRAI_ORCHESTRATOR_GRAPH` branch for `plan-task`-shaped
   requests only. `detectSkill()` untouched.
2. `planSteps` append-as-decided; confirm dashboard and TUI still render —
   the one genuine rendering-assumption change.
3. Re-run everything with the flag **unset**, confirming byte-identical
   default behavior including `bun run demo:ag-ui`.
4. Add the test proving a direct-routed request never reaches the graph even
   with the flag set.

### Phase 4 — Event mapping

Map supervisor node transitions onto AG-UI events using `027`'s
`@ag-ui/core` types (manual mapping, per the spec's default assumption).
Wire format for existing event types must not change.

### Phase 5 — Live verification and documentation

1. Live real-API run: adaptive re-planning after a real failure; a
   write-capable step stopping at the approval gate; **a real human
   rejection confirmed terminal**; a bound terminating a run cleanly.
   Capture raw NDJSON for each.
2. `bun run build`; record size delta against `026`'s measured 140.07 MB.
3. `CLAUDE.md`, `README.md`, `context/worklog.md`, and `verification.md` —
   only after the above pass.

## Affected Paths

- `apps/orchestrator/supervisor-graph.ts` (new)
- `apps/orchestrator/supervisor-graph.test.ts` (new)
- `apps/orchestrator/index.ts` (flag branch, `planSteps` handling)
- `CLAUDE.md`, `README.md`, `context/worklog.md`
- `specs/028-orchestrator-langgraph-supervisor/verification.md` (new)

## Rollback / Recovery

Each phase is a separate commit; `git revert` of any one leaves a coherent
repository.

- Phases 2 and 4 are inert with `ORCHESTRAI_ORCHESTRATOR_GRAPH` unset, so
  the fastest safe rollback is unsetting the flag, not reverting code.
- No migration, no persisted state, and no protocol change for existing
  events means there is nothing to un-migrate — a deliberate consequence of
  the spec's no-checkpointer decision.

## Known Risks to Watch During Implementation

1. **The no-`interrupt()` assertion.** The spec asserts, from reading
   `waitForChildTask()`, that no checkpointer is needed. If Phase 2 or 3
   finds that false, that is a **material scope change**: stop, return
   `028` to `draft`, re-present. Do not introduce a checkpointer
   mid-implementation to make the approach work.
2. **Safety properties enforced by prompt instead of by structure.** Every
   safety requirement must be enforced in code — graph state, edges, or the
   `dispatch` node — never by instructing the model. A prompt-enforced
   safety property is not enforced. If any is found to be prompt-only
   during review, treat it as unimplemented.
3. **Any branch on raw task status is a defect.** `failed` is produced
   identically by a human rejection, a half-completed write, and a
   validation error that never executed
   (`packages/agents/devops/index.ts:280-291`, `:379`). If implementation
   finds itself reading `task.status` or matching error text to decide
   whether adaptation is allowed, stop — that is the exact bug the
   `DispatchOutcome` contract exists to prevent.
4. **Classification drifting toward permissive.** If a case is found where
   `failed-ambiguous` feels too strict and the temptation is to default it
   to `failed-safe`, that is a material scope change: it requires either an
   agent-side no-mutation guarantee (out of scope here) or re-approval.
   Never loosen the default to make a run complete.

## Completion Checklist

- [ ] Every acceptance criterion in `spec.md` mapped to work/evidence.
- [ ] Each of the six safety requirements has its own named passing test.
- [ ] No out-of-scope behavior introduced — especially no
      `@ag-ui/langgraph` adoption, no external service, no persistence, no
      change to the approval gate or `detectSkill()`.
- [ ] Default-path byte-identical behavior demonstrated, not assumed.
- [ ] Spike finding recorded regardless of outcome.
- [ ] Verification and worklog handoff complete.
