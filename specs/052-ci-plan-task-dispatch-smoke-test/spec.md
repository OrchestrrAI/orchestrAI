---
id: 052-ci-plan-task-dispatch-smoke-test
title: CI Smoke Test — plan-task and suggest-agents Actually Dispatch
area: quality-gates
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-05
updated: 2026-09-05
approved_by: Yusuf
approved_on: 2026-09-05
implemented_on: 2026-09-05
amends: []
supersedes: []
superseded_by: []
related:
  - 014-typecheck-ci
  - 015-routing-planning-polish-2
  - 019-cicd-recreate-and-binary-builds
  - 051-planning-retirement-and-required-key
---

# Spec: CI Smoke Test — plan-task and suggest-agents Actually Dispatch

> Review gate: **APPROVED by Yusuf, 2026-09-05 — Option A.** A new step
> in `ci.yml`, on every push and PR. `build-binaries.yml` is untouched;
> its own `security-agent`-only smoke test stays exactly as it is today.

## Purpose

Live-caught, 2026-09-05, while implementing `specs/051-planning-
retirement-and-required-key/spec.md`: after Planning Agent's deletion
landed and `bun test` reported 717/717 passing, every real `plan-task`
request against the freshly rebuilt compiled binary failed immediately
with `"No agent found for skill: plan-task"`. The adaptive supervisor —
this project's headline feature — was completely unreachable. Nothing in
CI would have caught it; it was found only by manually starting the
compiled binary and sending a real request.

Root cause (see that spec's own `verification.md` for the full account):
`dispatchRootTask()` called `findAgentForSkill("plan-task")` before ever
checking `skill === "plan-task"`, so it depended on some agent
advertising that skill to succeed. Every test in
`supervisor-wiring.test.ts` masked this by manually registering a fake
`registry.set("planning-agent", agent("planning-agent", ["plan-task"]))`
before dispatching — which kept passing whether or not a real agent, or
Planning Agent's code, still existed. This is the same failure shape as
`specs/015-routing-planning-polish-2/spec.md`'s `ci`-substring bug: a
hand-built test fixture silently diverged from the real dependency it
was standing in for.

The gap this spec closes is structural, not this-one-bug-specific: **no
automated check anywhere starts a real multi-process stack and confirms
`plan-task` (or `suggest-agents`, its Phase-1 sibling with the identical
risk shape) actually reaches the Orchestrator's own dispatch, as opposed
to a mocked registry standing in for one.** `bun test` exercises
`dispatchRootTask()` only through fixtures it controls; the existing
binary smoke test in `.github/workflows/build-binaries.yml` starts a
real process but only checks `security-agent`'s `/healthz` — it never
submits a task, let alone a `plan-task` one.

## Verified Current State

Read from the current code and workflows, 2026-09-05:

- `.github/workflows/ci.yml` (every push/PR to `main`): `bun install
  --frozen-lockfile`, `bun run specs:check`, `bun run typecheck`,
  `bun test`. No process is ever started; every HTTP-shaped test in this
  repo goes through Hono's in-process `app.request()`, never a real
  bound port.
- `.github/workflows/build-binaries.yml` (push to `main`, `v*` tags,
  manual dispatch — **not** every PR): builds the compiled binary, then
  its "Smoke test the binary" step runs `"./$BIN" --only security-agent`
  and polls `http://localhost:3005/healthz`. Security Agent has no
  dependencies (no MCP, no other agent), which is exactly why it was
  chosen for a minimal smoke check — but it also means this step can
  never exercise dispatch, routing, or the adaptive supervisor at all.
- `apps/orchestrator/index.ts`'s `dispatchRootTask()` special-cases both
  `suggest-agents` and `plan-task` before ever calling
  `findAgentForSkill()` (fixed today, this same session) — both
  complete their *initial* HTTP response synchronously or
  near-synchronously:
  - `suggest-agents` is fully synchronous: `POST /tasks` returns
    `{"status":"completed","assignedAgent":"orchestrator", ...}` with no
    network call at all.
  - `plan-task` returns `{"status":"working","assignedAgent":
    "orchestrator-supervisor", "isPlan":true, ...}` **before** the
    supervisor's own async LLM call is awaited (`dispatchRootTask()`
    calls `runOrchestratorSupervisor(task).catch(...)` without
    `await`ing it, then returns immediately) — confirmed live against a
    running instance today.
  - Both of these response shapes are exactly what regressed on
    2026-09-05 and exactly what a fixture-backed unit test cannot tell
    apart from the real thing.
- `apps/supervisor/index.ts`'s startup key requirement
  (`specs/051`) only checks that a provider key is **present and
  well-formed enough to parse** — never that it works. Confirmed live
  today: `ORCHESTRAI_LLM_API_KEY=ci-smoke-test-not-a-real-key
  ORCHESTRAI_LLM_PROVIDER=anthropic` passes startup cleanly and the
  orchestrator's own log reports `plan-task planner: provider anthropic
  ... plan-task runs through the adaptive supervisor`. Because the
  *initial* `POST /tasks` response for `plan-task` returns before the
  real LLM call is awaited (previous bullet), a check against that
  initial response needs no real, working, billable credential at all —
  a syntactically valid dummy key is sufficient to prove the dispatch
  path itself is intact.
- `devops-agent` requires `mcp:http` to be healthy first (existing,
  unchanged behavior — `apps/supervisor/index.ts`'s `needsMcp` /
  `mcpAlreadySelected` auto-include). A minimal real stack for this
  check is therefore `mcp:http` (auto-included) + `devops-agent` (so
  `findAgentForSkill()` has at least one real registered agent, and so
  `suggest-agents`'s reply can plausibly name one) + `orchestrator`.

## Proposed Behavior

Add one new automated check, run via `bun run` (no `bun run build`, no
model fetch — this is not a binary smoke test, it targets the same
regression class the compiled-binary one does but at a fraction of the
cost) against a real, started `apps/supervisor/index.ts --only
devops-agent,orchestrator --headless` process:

1. Start the stack with `ORCHESTRAI_LLM_API_KEY`/`ORCHESTRAI_LLM_PROVIDER`
   set to syntactically valid, deliberately non-functional values (never
   a real credential — this check must never depend on, or spend, a real
   provider quota). Poll `GET /healthz` until `agents` reports the
   expected count, bounded (matching the existing binary smoke test's
   own 30×1s poll pattern).
2. `POST /tasks {"text":"what agents do you have"}` (a `suggest-agents`-
   shaped request). Assert the response contains
   `"assignedAgent":"orchestrator"` and `"status":"completed"`.
3. `POST /tasks {"text":"build and deploy my bun app"}` (a `plan-task`-
   shaped request, the exact phrase this codebase's own routing/planning
   tests already use as a stable trigger). Assert the response contains
   `"assignedAgent":"orchestrator-supervisor"` and does **not** contain
   `"status":"failed"`. This is a deliberately narrow assertion: it
   proves the dispatch path is intact (the regression this spec exists
   to catch), not that the adaptive supervisor's own decision-making
   works, which would require a real, billable provider call and is
   explicitly out of scope (see below).
4. Shut the stack down cleanly; fail the job (not just the step) if
   either assertion fails, so a plan-task regression blocks the same way
   a type error or a failing test already does.

## Decision — where this runs (resolved: Option A)

Yusuf chose **Option A**: a new step in `ci.yml`, on every push and PR.
This is the only place that runs *before* a regression reaches `main` —
which is the entire point; today's bug was found only after several
commits had already landed there.

`build-binaries.yml` is explicitly **not** touched by this spec — its
existing "Smoke test the binary" step keeps checking only
`security-agent`'s `/healthz`, exactly as it does today. The dev-mode-
vs-compiled-binary gap this leaves (this codebase has hit real
`import.meta.dir`-shaped differences between the two before — see
`specs/017`'s own verification history) is a known, accepted trade-off
of this decision, not an oversight — a future spec can extend that
workflow separately if that gap ever actually matters in practice.

## Scope

- `.github/workflows/ci.yml`: new step starting a real
  `devops-agent,orchestrator` stack via `bun run apps/supervisor/
  index.ts`, submitting the two requests above, asserting their shape,
  then shutting the stack down. Runs after `bun test` (so a plain unit
  failure is reported first, without a process-management step's own
  noise on top of it).
- `.github/workflows/build-binaries.yml`: **untouched** — see Decision
  above.
- No production code changes. No change to `apps/orchestrator/index.ts`,
  `apps/supervisor/index.ts`, or any runtime behavior — this spec is
  test/CI infrastructure only.

## Safety and Compatibility Constraints

- **Never a real provider credential, never a real API call.** The key
  used is deliberately non-functional; the assertions only ever inspect
  the *synchronous* portion of the response, which this codebase's own
  design (confirmed above) never blocks on a real LLM call for. If a
  future change makes the initial `POST /tasks` response for `plan-task`
  depend on the LLM call completing, this check's own assumption breaks
  loudly (the request would then hang or time out against a fake
  endpoint) rather than silently — which is itself useful signal, not a
  design flaw to route around in advance.
- **No write-capable skill is ever dispatched.** Both check requests are
  read-only/synchronous by construction (`suggest-agents` has no
  approval gate at all; the `plan-task` check only inspects the
  *initial* dispatch response, never lets the supervisor actually reach
  a real step). No approval gate, no file write, no target project
  needed.
- **Bounded, like every existing poll in these workflows.** No new
  unbounded wait is introduced — matches the existing 30×1s pattern.
- **Process cleanup is mandatory.** The step must stop the stack (and
  confirm the port is free) whether the assertions pass or fail, so a
  failing run doesn't leave an orphaned process for the next job on a
  reused runner (GitHub-hosted runners are ephemeral per-job, so this is
  belt-and-suspenders, not load-bearing — but cheap and matches this
  repo's own established discipline around process cleanup elsewhere).

## Out of Scope / Non-Goals

- **Confirming the adaptive supervisor's actual decision-making** (that
  a real Gemini/Anthropic call produces a sensible multi-step plan) —
  that requires a real, billable credential and is exactly what this
  repo's own established practice reserves for a human running a live
  pass with real credentials (see every `specs/026`/`028`/`038`/`051`
  live-verification record). This spec only proves the request *reaches*
  the supervisor, never that the supervisor decides well.
- **A CI-provided test API key of any kind** — not requested, not
  needed (previous bullet), and would introduce real cost/quota
  consumption into every PR run, which Yusuf has already asked to be
  kept out of scope in this same session.
- Changing what `ci.yml` builds, tests, or publishes otherwise, and any
  change to `build-binaries.yml` at all — this spec adds one narrow
  check to `ci.yml`, nothing else.
- Retrying a failed dispatch, or any runtime resilience change — a
  separate, already-discussed-and-deferred idea (distinguishing
  transient provider errors from terminal ones), not part of this spec.
- Testing every skill's dispatch path exhaustively — `plan-task` and
  `suggest-agents` are the two skills that bypass `findAgentForSkill()`
  entirely (per `specs/051` Phase 1/4) and are therefore the only ones
  structurally capable of this exact failure class; every other skill
  already goes through the same `findAgentForSkill()` call a real
  registered agent normally satisfies, and already has direct coverage
  in `packages/agents/skill-ownership-http.test.ts`'s table-driven suite.

## Acceptance Criteria

- [x] Yusuf has answered the Decision above — Option A.
- [x] A real `plan-task` request against a `bun run`-started stack
      returns `assignedAgent: "orchestrator-supervisor"` and a non-
      `failed` initial status — verified locally and confirmed in a
      real CI run (see Verification Results).
- [x] A real `suggest-agents` request against the same stack returns
      `assignedAgent: "orchestrator"` and `status: "completed"`.
- [x] Deliberately reintroducing today's exact bug (disabling the
      `plan-task` branch so dispatch falls through to
      `findAgentForSkill()`) makes the new check fail, and only the new
      check — confirmed live, see Verification Results.
- [x] No real provider credential appears anywhere in workflow files or
      logs.
- [x] The step cleans up its own process; a subsequent step/job is
      unaffected.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` unaffected
      (this spec adds a workflow step, not runtime code).
- [x] `CLAUDE.md` (Verification status / Commands sections) and
      `context/worklog.md` updated.

## Verification Plan

- **Local dry run** of the exact shell sequence the workflow step will
  use, against a real `bun run apps/supervisor/index.ts` process on the
  development machine, before committing the workflow change.
- **The regression-reintroduction check** named in Acceptance Criteria —
  the actual proof this catches what it claims to, run once during
  implementation and recorded, not re-run on every PR.
- **A real CI run** (push to a branch, or `workflow_dispatch`) showing
  the new step passing on a clean `main`, with its own runtime measured
  (to confirm the ~10-15s cost estimate above was realistic, not
  guessed).

## Verification Results (2026-09-05)

**Local dry run, success path.** Ran the exact shell sequence
`.github/workflows/ci.yml`'s new step now contains, against a real
`bun run apps/supervisor/index.ts --only devops-agent,orchestrator
--headless` process with `ORCHESTRAI_LLM_API_KEY=ci-smoke-test-not-a-
real-key`: healthy within a few seconds; `suggest-agents` returned
`{"status":"completed","assignedAgent":"orchestrator", ...}`;
`plan-task` returned `{"status":"working","assignedAgent":
"orchestrator-supervisor","isPlan":true, ...}`. Both assertions passed;
process shut down cleanly, confirmed via `tasklist`/`netstat` — no
orphan, no held port.

**The regression-reintroduction check — the actual proof this catches
what it exists to catch.** Temporarily changed
`apps/orchestrator/index.ts`'s `if (skill === "plan-task")` to
`if (false && skill === "plan-task")`, reran the identical script: the
real response was `{"status":"failed","error":"No agent found for
skill: plan-task"}` — the exact literal error message from the real
2026-09-05 incident — and both new assertions correctly flagged it.
Reverted immediately after; `git diff --stat apps/orchestrator/
index.ts` showed no diff, confirming a byte-identical revert, not
just "looks the same." No process or port left behind afterward.

**No production code was changed by this spec.** Only
`.github/workflows/ci.yml` plus this spec's own files.

**`bun run typecheck`**: 0 errors, both before and after the dry runs
(the regression check touched runtime code temporarily but it was
reverted before this was checked). `bun run specs:check`: passed for 52
specs (with this spec included).

**A real CI run**, `main`, run `33969986187`: `test` job passed in 38s
total. The new step's own log (`gh run view --job=... --log`) shows the
exact real output — `Orchestrator is healthy.`, then
`{"status":"completed","assignedAgent":"orchestrator", ...}` for
suggest-agents and `{"status":"working","assignedAgent":
"orchestrator-supervisor", ...}` for plan-task, `Both dispatch checks
passed.` — from healthz-poll start to pass, **about 1 second** on the
real runner (13:49:34.586 → 13:49:35.679), well under the ~10-15s
estimate in this spec's own Proposed Behavior section (a Linux-native
`bun run` process on a GitHub-hosted runner boots faster than that
estimate assumed). Closes the one item this spec's Verification Plan
could not check before pushing.

## Approval Requested

Approved by Yusuf, 2026-09-05 — Option A. Implemented and locally
verified the same day; see Verification Results above.
