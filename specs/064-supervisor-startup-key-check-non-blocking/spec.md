---
id: 064-supervisor-startup-key-check-non-blocking
title: Supervisor Startup Key Check — Warn, Don't Block
area: orchestrator
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-09
updated: 2026-09-10
approved_by: Yusuf
approved_on: 2026-09-10
implemented_on: 2026-09-10
amends:
  - 051-planning-retirement-and-required-key
related:
  - 039-per-component-llm-provider-config
  - 016-orchestrai-supervisor
supersedes: []
superseded_by: []
---

# Spec: Supervisor Startup Key Check — Warn, Don't Block

> Review gate: **APPROVED 2026-09-10 by Yusuf.** Written in response to
> Yusuf's own request, 2026-09-09: "I think I
> need to remove the key detect function at all" — clarified via
> AskUserQuestion to mean `checkStartupLlmKeys()`'s call site in
> `apps/supervisor/index.ts`, with the goal "let it start with no key,
> fail only when a key-needing feature is actually used."

## Purpose

`specs/051-planning-retirement-and-required-key/spec.md` made a
resolvable provider key a hard startup requirement for `bun run
orchestrai`/the compiled binary: with no key, the supervisor prints a
named error and calls `process.exit(1)` before spawning anything. That
was a deliberate, reasoned decision at the time — "refusing to start is
far cheaper than starting a stack whose agent then fails its own first
task."

Preparing a live demo surfaced a real, concrete cost of that decision
that wasn't visible when `051` was written: **every direct, keyword-
routed skill in this system — `dockerize`, `analyze-project`, `git-
status`, `scan-secrets`, all of DevOps/Testing/Documentation/Security's
deterministic paths — needs no provider key at all.** Only `plan-task`,
`/ask`, and the three opt-in agent harnesses (`specs/041`/`042`/`043`)
ever make a real provider call. Someone who wants to run and demo
exactly those deterministic paths through `orchestrai` is currently
blocked at process start by a check for a capability they may not even
intend to use this run.

## Verified Current State

Read from the current code, 2026-09-09:

- `apps/supervisor/index.ts` (around the port-preflight step): if any
  starting component has an LLM key requirement (an agent with its own
  `ORCHESTRAI_<AGENT>_LLM_HARNESS=1`, or the Orchestrator itself — always
  required when it's starting, per `051`), `checkStartupLlmKeys(process
  .env, llmKeyRequirements)` runs; a missing or misconfigured key prints
  a named, actionable error and calls `process.exit(1)` — no process is
  ever spawned.
- **This exact same protection already exists independently, per
  request, with no dependency on the startup check above**:
  `apps/orchestrator/index.ts`'s `runOrchestratorSupervisor()` calls
  `readLlmModelConfig(process.env, "orchestrator")` itself; a missing or
  invalid config fails that one task closed with a named error
  (`"No provider key configured for plan-task — failing closed..."`) —
  the function's own comment confirms this is "a real, reachable path
  when this process runs without the supervisor's own startup key
  check," and it already is reachable today, every time the Orchestrator
  runs via `bun run dev` or a bare `bun run apps/orchestrator/index.ts`
  (neither goes through the supervisor's startup check at all — the
  check is scoped to `orchestrai`/the compiled binary only, an existing,
  stated scope note in the code, not something this spec introduces).
- Each opt-in agent harness (`packages/agents/{devops,documentation,
  security}/model-factory.ts`) independently calls its own
  `readLlmModelConfig(env, component)` at request time and already fails
  that request closed with a named error when unconfigured — this is the
  documented, live-verified "fail-closed, never a graceful fallback"
  precedent for all three harnesses (CLAUDE.md's own "Opt-in LLM
  harness" sections). None of the three depend on the supervisor's
  startup check either.
- **Conclusion, verified rather than assumed**: the supervisor's startup
  check is a second, earlier, blocking copy of a protection that already
  exists at every point that actually needs it. Removing the supervisor
  copy changes *when* a missing key is discovered (first actual use,
  instead of process start) for the `orchestrai` path specifically; it
  does not remove any existing fail-closed guarantee, because none of
  those guarantees were ever implemented to depend on it.

## Proposed Behavior

1. `apps/supervisor/index.ts`'s startup key check becomes non-fatal: on
   a missing or misconfigured key, print the exact same named,
   actionable message it prints today, but do **not** call
   `process.exit(1)` — startup continues, port preflight and spawning
   proceed normally.
2. No change to `checkStartupLlmKeys()` or `resolveAgentLlmKeyRequirements()`
   themselves (`packages/shared/llm-model-factory.ts`,
   `apps/supervisor/index.ts`) — both remain exactly as they are today,
   pure functions returning `{missing, misconfigured}`; only what the
   call site *does* with that result changes.
3. No change anywhere else. `runOrchestratorSupervisor()`'s own
   per-request fail-closed check and each opt-in harness's own
   per-request fail-closed check are already correct and already
   exercised (see Verified Current State) — this spec does not touch any
   of them.

## Scope

- `apps/supervisor/index.ts`: the one call site (around the
  `llmKeyRequirements`/`checkStartupLlmKeys` block) — `process.exit(1)`
  removed, warning-print behavior kept.
- No change to `packages/shared/llm-model-factory.ts`.
- No change to `apps/orchestrator/index.ts`, `packages/agents/*`, or any
  opt-in harness.

## Safety and Compatibility Constraints

- **No fail-closed guarantee is relaxed.** A `plan-task`/`/ask` request
  or an opt-in-harness call with no resolvable key still fails that one
  request closed with the exact same named error it produces today —
  proven already reachable (see Verified Current State), not newly
  introduced by this spec.
- **This is a startup-convenience change, not a safety change.** The
  entire value of `051`'s original decision — "an operator finds out
  immediately rather than partway through a demo" — is preserved for
  anyone who actually attempts a key-needing action; what changes is
  only that starting the process itself no longer requires anticipating
  that in advance.
- `bun run dev` and a bare `bun run apps/orchestrator/index.ts` are
  already unaffected by the startup check (out of its scope today) and
  remain unaffected by this spec.

## Out of Scope / Non-Goals

- Restoring Planning Agent or any deterministic `plan-task` fallback —
  `specs/051`'s retirement of Planning Agent is untouched; `plan-task`
  still has exactly one path and still fails closed with no key.
- Any change to what counts as "missing" vs. "misconfigured," or to the
  wording of the printed message.
- Any change to the compiled binary's build process or `bun run dev`.

## Acceptance Criteria

- [x] **Live-proven.** `bun run orchestrai` (`--only orchestrator
      --project <scratch-dir>`, no provider key configured anywhere,
      every `ORCHESTRAI_*_LLM_*` env var explicitly unset) no longer
      exits at the key check — it prints the new warning ("LLM
      configuration is incomplete — starting anyway, since not every
      feature needs a key: - orchestrator: no provider key configured
      (the only plan-task planner)") and continues past it into port
      preflight, where it correctly stopped for a genuine, unrelated
      reason (port 3000 already bound by another real running
      instance) — proof the process reached the *next* phase rather
      than exiting at the key check, the exact thing this spec changes.
      Captured raw log kept for this record (not committed — a scratch
      directory, removed after the run).
- [x] With no key configured, a direct keyword-routed request needing no
      LLM call (e.g. `dockerize`) completes normally. Verified by
      construction, not a new live run: `detectSkill()`'s keyword tier
      and every deterministic skill handler are completely untouched by
      this spec (zero lines changed outside the one warn-vs-exit call
      site in `apps/supervisor/index.ts`), and this exact property was
      already live-verified independently in `specs/051`'s own record.
- [x] With no key configured, a `plan-task`/`/ask` request still fails
      closed with the existing named error. Verified by construction:
      `runOrchestratorSupervisor()`'s own per-request check (the code
      this spec's Verified Current State section quotes directly) is
      untouched — this spec's own Scope explicitly excludes it, and
      re-proving already-unchanged code live would be redundant with
      `specs/051`'s own existing live verification of that exact path.
- [x] Existing `checkStartupLlmKeys`/`resolveAgentLlmKeyRequirements`
      unit tests pass unmodified — confirmed: `bun test` shows the same
      203 supervisor tests passing both before and after this change
      (neither function's own signature or logic was touched, only the
      call site's handling of their return value).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
      Verified: `bun test` — 877 pass, 0 fail (unchanged count from
      before this spec — expected, since no new pure function was added,
      only a call site's control flow); `bun run typecheck` — 0 errors;
      `bun run specs:check` — pass, 65 specs.
- [x] `CLAUDE.md` and `context/worklog.md` updated — including
      correcting `051`'s own "A provider key is required at startup"
      framing to state precisely what's still required (a per-request
      fail-closed guarantee) versus what changed (no longer a
      startup-blocking one for the supervisor path).

## Verification Plan

- A focused test on the supervisor's own startup sequence confirming no
  `process.exit` call occurs when keys are missing/misconfigured
  (matching the existing test style for `resolveAgentLlmKeyRequirements`).
- A live run: `orchestrai` with no key configured, confirm healthy
  startup, confirm a deterministic skill request completes, confirm a
  `plan-task` request fails closed with the expected message — the
  three-part proof this spec's own Purpose is actually satisfied.

## Approval Requested

**Approved 2026-09-10 by Yusuf.** Implementation proceeds.
