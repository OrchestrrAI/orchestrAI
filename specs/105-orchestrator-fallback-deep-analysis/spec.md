---
id: 105-orchestrator-fallback-deep-analysis
title: "Shared Project Analysis — One Implementation, Reachable With DevOps Off"
area: orchestrator
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-21
updated: 2026-09-22
approved_by: Yusuf
approved_on: 2026-09-22
implemented_on: 2026-09-22
amends:
  - 102-orchestrator-readonly-project-inspection
  - 103-deep-project-analysis
related:
  - 038-supervisor-default-and-planning-retirement
  - 043-llm-harness-security
  - 054-capability-driven-llm-routing
  - 065-llm-only-skill-routing
  - 075-real-conversational-chat
  - 104-deferred-work-register
  - 106-persistence-store-and-result-cache
supersedes: []
superseded_by: []
---

# Spec: Shared Project Analysis — One Implementation, Reachable With DevOps Off

> Status: **DRAFT — awaiting review.** `specs/103` gave DevOps's
> `analyze-project` real, grounded code reading — but only inside
> DevOps's own process. Yusuf, 2026-09-21: *"i need now a solution so i
> can use this analysize full feature even if the devops is off without
> having redandunt work."* This is one of four specs from one approved
> plan (105/106/107/108); this one delivers "works with DevOps off, one
> implementation not two." `specs/106` delivers "no redundant work."
>
> **A first draft of this spec (2026-09-21) targeted the wrong code path
> and was rewritten before implementation, not after.** It hooked
> `inspectTargetProjectAsTaskResult()` — but tracing the real code showed
> a chat request with DevOps offline never reaches that function (see
> "Current behavior"). Recorded here rather than erased, the same way this
> codebase records every other design correction.

## Purpose

Make `specs/103`'s deep analysis (a) available when DevOps is not
running, and (b) exist as **one** implementation both DevOps and the
Orchestrator import — never two copies that drift.

## Current behavior

**What `specs/103` built** lives entirely in
`packages/agents/devops/llm-harness.ts` (`runProjectAnalysisHarness()`,
`ProjectAnalysisParamsSchema`, `groundObservations()`,
`verifyPathExists()`, `buildProjectAnalysisSystemPrompt()`) and
`packages/agents/devops/index.ts` (`renderCodebaseAnalysis()`,
`computeCodebaseAnalysisSection()`). With DevOps off, none of it runs.

**What actually happens to a chat request with DevOps off** — traced
through the real code, not assumed:

1. `detectSkill()` (`apps/orchestrator/index.ts:607`) is
   `tryCapabilityRoute(...) ?? "plan-task"`. The router can only propose
   a skill present in the **live** capability snapshot (`specs/065`).
   With DevOps offline, `analyze-project` is not in that snapshot, so
   the router **cannot name it** — the request falls to `plan-task`.
2. `runOrchestratorSupervisor()` computes a *shallow* `projectContext`
   at `:1284` via `inspectTargetProject()` and grounds the supervisor
   with it at `:1285`.
3. The supervisor — already grounded, and told by `specs/103`'s own
   nudge not to re-dispatch `analyze-project` — typically finishes with
   **zero dispatches**.
4. `composeSupervisorResult()` (`:1206`) hits its zero-dispatch branch
   (`:1221`) and prints the same shallow `projectContext` as the answer.

So the user sees the presence checklist. `inspectTargetProjectAsTaskResult()`
(`:320`) — the function the first draft targeted — is reached only when
something names `analyze-project` **explicitly** (a direct TUI skill
selection). It is a real path, but not the chat path.

## Proposed behavior

### A1 — one implementation, in `packages/shared/project-analysis.ts`

Move the analysis logic into a self-contained shared module: the Zod
schema, system prompt, path grounding, salvage-on-exhaustion, the
LangGraph tool-calling loop, and the deterministic renderer. Signature:
`(model, mcpClient, projectRoot, deterministicReport)` — every caller
supplies its own model and MCP client, so the module holds no
credentials and no global state.

**Precedent, not a new pattern:** `packages/shared/capability-router.ts`
already lives in `packages/shared` and makes real LLM calls
(`callProviderWithRetry(() => options.model.invoke(...))`). The
"per-agent independent copy" convention this codebase follows for
harnesses exists because agent harnesses are *agent-specific* (different
prompts, skills, tools). Here the logic is genuinely identical for both
callers, so sharing is correct.

**The one wrinkle:** `runProjectAnalysisHarness()` sits on DevOps's
harness core (`HarnessState`, `buildReadOnlyTools()`,
`buildHarnessGraph()`, `runHarness()`, `validateJsonParams()`, ~175
lines) which DevOps's four *write* skills also use. The shared module
carries its **own self-contained copy** of that core; DevOps's copy stays
untouched so its working write skills are not disturbed. Every agent
already has its own copy today, so this is not new duplication — it
makes `packages/shared` the canonical copy for others to migrate onto
later. Migrating them is **out of scope**.

`packages/agents/devops/index.ts` then imports from shared. **Zero
behavior change for DevOps** — proven by `specs/103`'s existing tests
passing unmodified.

The module also exports `getCachedProjectAnalysis(projectRoot)` — a
read-only lookup returning a stored, still-fresh analysis or nothing.
Until `specs/106` lands it returns nothing; once it does, any agent can
reuse a result with one call. Wiring Coder/Code Review/Documentation to
actually call it stays out of scope (`specs/104` A11).

### A2 — the Orchestrator's two call sites

1. **The chat path.** In `runOrchestratorSupervisor()`, when
   `result.dispatchCount === 0`, compute the **deep** analysis via the
   shared module (using the Orchestrator's own `orchestratorMcpClient`
   from `specs/102` and its own `"orchestrator"` LLM component) and pass
   it to `composeSupervisorResult()` in place of the shallow text.
2. **The explicit-skill path.** `inspectTargetProjectAsTaskResult()`'s
   `analyze-project` branch appends the deep analysis after the shallow
   text — what the first draft correctly identified, now secondary.

**Why the zero-dispatch branch is the right place to spend a call:**
reaching it means the supervisor did no work at all, and the inspection
*is* the answer being returned. One call to make that answer real is
proportionate. Once `specs/106` lands it is cached, so only the first
such request in a project ever pays.

**Untouched, deliberately:** `fetchProjectInspection()` and the grounding
at `:1285` stay shallow and LLM-free — that call runs on **every**
`plan-task` and `specs/103`'s constraint 1 forbids putting a provider
round trip on it. Both new call sites are separate from it.

**Key-gated, not flag-gated** (`specs/038` precedent): no resolvable
`"orchestrator"` key → deep layer skipped, shallow output returned
byte-identically. **Fail-open** throughout, matching `specs/103`.

## Scope

In scope: the shared module; DevOps importing it; the two Orchestrator
call sites; `getCachedProjectAnalysis()` as a stub until `specs/106`.

Out of scope: any change to `fetchProjectInspection()`; migrating other
agents' harness cores onto the shared copy; wiring Coder/Code Review/
Documentation to consume the analysis; any storage (that is `specs/106`).

## Safety constraints

- Read-only throughout — the Orchestrator's MCP client is bound to
  exactly the four read-only inspection tools; no write tool is added.
- No approval gate change — the zero-dispatch branch and the explicit-
  skill fallback produce no approval-gated action today and still won't.
- The shallow report is never edited — the deep section is appended,
  mirroring `specs/103`'s "the deterministic report is never modified".
- Path grounding is identical in substance to `specs/103`: every cited
  path re-verified by a real `read_project_file` call.
- Bounded by the same recursion-limit/retry-budget precedent as every
  harness here.

## Acceptance criteria

- [x] `packages/shared/project-analysis.ts` exists; DevOps imports from
      it; every `specs/103` test passes unmodified (zero behavior
      change) — moved verbatim to `packages/shared/project-analysis.test.ts`
      alongside the implementation.
- [x] With DevOps offline and a resolvable Orchestrator key, a chat
      request for a project analysis returns a real, grounded deep
      analysis via the zero-dispatch branch. **Adapted from the literal
      wording**: `runOrchestratorSupervisor()`'s own decision model has
      no test-injection seam of its own (a pre-existing gap, not
      introduced here), so the zero-dispatch → deep-analysis upgrade was
      extracted into `resolveSupervisorFinalContext()` and tested
      directly with a given `dispatchCount`, via a real injected model
      (`__setTestProjectAnalysisModel()`). The true end-to-end path is
      covered by the live test below instead. **Live-verified.**
- [x] With DevOps offline and **no** key, output is byte-identical to
      pre-105. **Live-verified**: with no key at all, `plan-task` fails
      closed exactly as it always did — this spec's new code is gated
      behind the same key resolution and is never reached.
- [x] With DevOps **online**, the request routes to DevOps exactly as
      before and neither Orchestrator call site fires. Proven
      structurally rather than by a new test: `dispatchRootTask()`'s own
      agent-routing logic (`findAgentForSkill()`) is completely
      untouched by this spec — confirmed by `git diff` showing no edit
      to it — so the fallback branch this spec extends is unreachable
      whenever an agent is registered, exactly as before.
- [x] `fetchProjectInspection()` makes no provider call — confirmed
      directly: `git diff` shows zero edits to that function's body.
- [x] The explicit-skill fallback also returns the deep analysis —
      unit-tested directly. **Not independently live-tested**: confirmed
      that `POST /tasks` structurally cannot name `analyze-project`
      explicitly with no agent online (the same `specs/102`-documented
      "router can never legitimately produce this skill when offline"
      limitation) — matches that spec's own precedent for this identical
      fallback mechanism, not a new gap.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.

## Verification plan

- Unit: the shared module's grounding/salvage/fail-open (the `specs/103`
  tests move with it); the zero-dispatch hook; the explicit-skill hook;
  the online-DevOps no-fire case; `fetchProjectInspection()` unchanged.
- Live, DevOps genuinely not started: "analyze the project" in chat
  returns a real deep analysis. Live, DevOps running: the fallback never
  fires.

## Non-goals

- Storage or cross-process reuse — `specs/106`.
- A deep-analysis capability *invoked* by Coder/Code Review/Documentation
  — `specs/104` A11.
- New analysis categories (design patterns etc.) — separate decision,
  applies equally to both callers once made.
