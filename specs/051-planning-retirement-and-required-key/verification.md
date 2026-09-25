# Verification: Planning Agent Retirement and a Required Provider Key

Result: **verified**. Every acceptance criterion has either a direct live
result against the real compiled binary or automated test coverage (most
have both); the one genuine gap identified mid-verification (a real bug,
not a documentation gap) was fixed and then live-confirmed before this
spec was marked verified.

Automated gates at completion: `bun run typecheck` 0 errors, `bun run
specs:check` clean for 51 specs, `bun test` **717/717** (0 fail, run
repeatedly across every phase, including with no
`ORCHESTRAI_LLM_API_KEY`/`ORCHESTRAI_LLM_PROVIDER` set at all — the
load-bearing regression proof that CI and the suite still work unfunded),
`bun run build` succeeded every time it was run (final size 141.0 MB).

## Phase 1 — Relocate `suggest-agents` (carried in from before this
verification pass)

Already implemented and committed ahead of this pass:
`buildSuggestAgentsReply()` in `apps/orchestrator/index.ts`, pinned
against a real captured baseline of the original Planning implementation
in `apps/orchestrator/suggest-agents-relocation.test.ts` (7+ cases,
including confirming the fictitious `code-review-agent` line is gone and
no `planning-agent`/`3001` mention ever appears). `POST /tasks`'s
hardcoded `status: "assigned"` was also fixed to read the task's real
status here, a real bug this relocation surfaced (suggest-agents is the
first skill in this codebase that can already be `"completed"` by the
time the response is built).

## Phase 2 — Startup key requirement (mechanism)

`checkStartupLlmKeys()` (`packages/shared/llm-model-factory.ts`) and
`resolveAgentLlmKeyRequirements()` (`apps/supervisor/index.ts`), wired
into `main()` right before port preflight. 8 + 7 focused tests
respectively. The Orchestrator's own requirement was deliberately
deferred to Phase 3 in `plan.md` (a genuine sequencing correction,
recorded there): it only becomes true once Phase 3 removes the
fallback that used to make Planning "the other planner."

## Phase 3 — Remove the fallback and the opt-out

`isOrchestratorGraphEnabled()`/`supervisorShouldFallBackToPlanning()`
deleted; `plan-task` reaches the adaptive supervisor unconditionally.
`parsePlanText()`/`watchPlanAndDispatch()` deleted as dead code — grep
confirmed zero remaining callers before deleting. The Orchestrator's own
key requirement (composed with the per-agent ones from Phase 2) added to
`main()` here, where it becomes genuinely true.
`apps/orchestrator/supervisor-wiring.test.ts` updated: the old "opt-out
reaches Planning" and "missing key falls back to Planning" tests replaced
with tests asserting the opposite (flag inert, missing key fails closed);
a real race condition in the first draft of the missing-key test (waiting
on `"working"`, which the fail-fast path never transitions through) was
caught and fixed before this phase was considered done.

## Phase 4 — Delete the agent, retire the toggles, and the stale-variable warning

This is where verification found and fixed real problems, not just
executed a checklist.

**4a — the init form/wizard.** Discovered during implementation, not in
the spec's literal Scope wording: `ORCHESTRAI_LLM_HARNESS` (Planning's
toggle, literally named in Scope) and `ORCHESTRAI_ORCHESTRATOR_GRAPH`
(the supervisor's own opt-out, not literally named) both became equally
meaningless once Phase 3 deleted `isOrchestratorGraphEnabled()` — neither
had anywhere left to route to. Removed both, reasoning directly from the
spec's own §4 text ("with no fallback target, an opt-out is
meaningless"). `WizardConfig.llmProvider` became a required field; the
provider/model/key questions are now asked unconditionally in both
surfaces, since a wizard-written config always implies the Orchestrator
starting (`specs/034`) and the Orchestrator now always needs a key.
`init-form-state.test.ts`/`init-wizard.test.ts` were rewritten
accordingly — three pre-existing `mergeConfigEnv` tests were found to be
asserting owned-key-update/collapse behavior against
`ORCHESTRAI_LLM_HARNESS` specifically, which had just left
`WIZARD_OWNED_KEYS`; confirmed they actually failed against the old
fixtures (not just reasoned about) before switching the example key to
`ORCHESTRAI_LLM_PROVIDER`.

**4b — delete the package.** `packages/agents/planning/` removed in
full. Grep-confirmed zero remaining functional imports before deleting.
Registry/config cleanup across `agent-registry.ts`,
`apps/orchestrator/index.ts`'s `KNOWN_AGENTS`,
`apps/supervisor/index.ts`'s `SERVICE_STARTERS`/`AGENTS` (port 3001
freed, not reassigned), `agent-catalog.ts` (+ test),
`skill-ownership-http.test.ts`, `LLM_COMPONENTS`, `package.json`,
`docker-compose.yml` (orchestrator service now requires
`ORCHESTRAI_LLM_API_KEY` via Compose's own `:?` syntax), and `bun.lock`
(regenerated, 1 package removed).

**4c — the stale-variable warning.** `findStaleLlmVariables()`
(`apps/supervisor/init-wizard.ts`) flags `ORCHESTRAI_LLM_HARNESS`,
`ORCHESTRAI_ORCHESTRATOR_GRAPH`, and any `ORCHESTRAI_PLANNING_LLM_*`
variable, wired into `main()` right after the wizard config is merged
into `process.env`. 7 focused tests.

**The real bug, found by smoke-testing the actual compiled binary, not
by `bun test`:** every `plan-task` request failed immediately with "No
agent found for skill: plan-task" — it never reached the supervisor at
all. Root cause: `dispatchRootTask()` called `findAgentForSkill("plan-
task")` before ever checking `skill === "plan-task"`, and used that
lookup's result (`agent.card.name`) to build the task object before
deciding whether to route to the supervisor. This only ever "worked"
because Planning Agent's own registry entry advertised `plan-task`,
satisfying that lookup as a side effect — the supervisor dispatch was
reached *through* the lookup succeeding, not instead of it. Delete
Planning, and nothing advertises `plan-task` any more, so the lookup
always failed before the supervisor branch was ever reached.

The test suite never caught this because every test in
`supervisor-wiring.test.ts` called `registry.set("planning-agent",
agent("planning-agent", ["plan-task"]))` before dispatching a plan-task
request — a fixture that kept manufacturing exactly the registry entry
needed to pass the lookup, independent of whether Planning Agent code
itself still existed. This is the same class of failure as `specs/015`'s
`ci`-substring bug: a hand-built test fixture silently diverging from a
real dependency being removed.

**Fix:** `dispatchRootTask()` now decides `plan-task` before
`findAgentForSkill()` is ever called, mirroring how `suggest-agents` was
already special-cased in Phase 1 — neither is a registry-discovered
agent. The task is constructed directly with `assignedAgent:
"orchestrator-supervisor"` and dispatched into
`runOrchestratorSupervisor()` exactly as before. The old plan-task branch
after `findAgentForSkill()` was deleted as unreachable, along with the
`isPlan: skill === "plan-task"` ternary that could no longer be true
there (kept as explicit `isPlan: false` rather than omitted, to keep
`POST /tasks`'s JSON response byte-identical for every non-plan-task
submission — an omitted field silently drops from JSON where an explicit
`false` does not; caught by a real test failure, not inspection).
`supervisor-wiring.test.ts`'s four `registry.set("planning-agent", ...)`
fixtures were removed and a new regression test added: "plan-task
succeeds with a completely empty agent registry."

**A second, smaller correctness pass** followed once this was found:
every remaining literal `packages/agents/planning/...` path reference in
comments (8 across `apps/orchestrator/index.ts`,
`suggest-agents-relocation.test.ts`, and three Documentation-agent files)
was reworded to name "Planning Agent's own (now-deleted) ..." instead of
the dead path, to satisfy the spec's own Acceptance Criteria wording
literally ("no source file outside specs/ and context/ references it").
A further pass renamed five-agent test fixtures that still used
`"planning-agent"` as an arbitrary example name
(`init-wizard.test.ts`/`init-form-state.test.ts`'s agent lists, three
`skill-dispatch.test.ts`/`agent-capabilities.test.ts` fixtures unrelated
to the real package) to the real 4-agent list or a generic
`"some-agent"` name; deliberately left unchanged were
`suggest-agents-relocation.test.ts`'s own literal strings, which are
negative assertions proving the name does *not* appear in output —
removing them would defeat the test.

## Live verification — real compiled binary, this repository's own
real Gemini-configured `.orchestrai/config.env`

All of the following were run against `dist/bin/orchestrai.exe` (141.0
MB), not `bun run`, with `netstat`/`tasklist` confirming no orphaned
process or bound port after each:

1. **Stale-variable warnings never block startup.** `--only
   security-agent` with `ORCHESTRAI_LLM_HARNESS`/
   `ORCHESTRAI_ORCHESTRATOR_GRAPH`/`ORCHESTRAI_PLANNING_LLM_API_KEY` all
   set: all three warnings printed, then the service started and reached
   a real dashboard.
2. **Missing key refuses to start.** `--only orchestrator` with
   `ORCHESTRAI_LLM_API_KEY`/`ORCHESTRAI_ORCHESTRATOR_LLM_API_KEY` forced
   empty: warnings printed, then "Refusing to start — LLM configuration
   is incomplete: - orchestrator: no provider key configured (the only
   plan-task planner)" and nothing started.
3. **A per-agent harness with no resolvable key for that component
   refuses, naming it** (the one acceptance-criterion case not yet
   covered by a live run, closed in this same pass):
   `ORCHESTRAI_DEVOPS_LLM_HARNESS=1` with both the shared and
   DevOps-specific keys forced empty, while the Orchestrator itself was
   given its own real key via `ORCHESTRAI_ORCHESTRATOR_LLM_API_KEY`:
   "Refusing to start — LLM configuration is incomplete: - devops: no
   provider key configured (DevOps LLM is on)" — proving the two checks
   compose independently, not just that either one alone works.
4. **A real key succeeds and reports the resolved planner.** `--only
   orchestrator` with the real key restored: warnings printed, then
   startup completed and the orchestrator's own log line read "plan-task
   planner: provider gemini (ORCHESTRAI_LLM_PROVIDER), model
   gemini-3.5-flash-lite (ORCHESTRAI_LLM_MODEL), key from
   ORCHESTRAI_LLM_API_KEY — plan-task runs through the adaptive
   supervisor."
5. **A full six-service startup** (`--headless`, no `--only`): all four
   agents plus `mcp:http` plus the orchestrator started; the
   orchestrator's own discovery log named exactly four agents
   (devops/testing/documentation/security) — no port 3001, no
   "planning-agent" anywhere.
6. **`GET /healthz` reported `"agents": 4`** against the running stack —
   the direct numeric confirmation, not just log text.
7. **The plan-task dispatch bug, before and after the fix.** Before:
   `POST /tasks {"text":"build and deploy my bun app"}` →
   `{"status":"failed","error":"No agent found for skill: plan-task"}`.
   After the fix and rebuild: the same request → `status: "working"`,
   `assignedAgent: "orchestrator-supervisor"`, `isPlan: true`; polling the
   task showed a genuine two-step adaptive dispatch decided by the real
   Gemini model (`analyze-project`, then `dockerize` — the second decided
   only after observing the first step's real result), reaching a real
   `actionId`-bound approval preview with the exact interpolated
   Dockerfile content for `create_dockerfile`. Rejected via the
   Orchestrator's own `POST /tasks/:id/reject` for a clean terminal
   rejection; `git status`/`git diff --stat` on the target `Dockerfile`
   confirmed byte-identical before and after — no write occurred despite
   the plan reaching a real, genuine approval gate.
8. **`suggest-agents` still works end to end**, unaffected by the
   plan-task fix: `POST /tasks {"text":"what agents do you have"}` →
   synchronous `status: "completed"`, `assignedAgent: "orchestrator"`.

## Deviations from the literal plan, stated rather than hidden

- **Scope expanded beyond the spec's own literal wording, twice, both
  reasoned from the spec's own stated logic rather than invented:**
  removing `ORCHESTRAI_ORCHESTRATOR_GRAPH`'s toggle alongside the
  literally-named `ORCHESTRAI_LLM_HARNESS` one (Phase 4a), and making the
  provider/model/key questions unconditional rather than conditional on
  some remaining toggle (also Phase 4a, since no such toggle survived).
- **A real bug outside the plan's own checklist was found and fixed**
  (the plan-task dispatch-order bug) — not anticipated by any phase's
  exit gate, found only because live smoke-testing the actual compiled
  binary was treated as mandatory rather than assumed to be implied by a
  green `bun test` run.
- **The Acceptance Criteria's literal "no source file ... references it"
  line drove a second cleanup pass** beyond what Phase 4's own numbered
  steps described, covering comment-level path references and
  test-fixture agent names that had no functional coupling but were
  still, literally, references.

## What is intentionally not claimed

- Key *validity* is never checked, by design (`plan.md`'s own "What
  'required' can honestly mean" framing) — only presence and
  provider/model parsing. A wrong or expired key still fails at first
  real use, and the startup message says this plainly.
- macOS/Linux binaries were not rebuilt or smoke-tested in this pass —
  this repository's own build/verification history has always been
  Windows-native for local work, with cross-platform binaries produced
  and verified by CI (`.github/workflows/build-binaries.yml`) separately.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**Retired in full by `specs/051-planning-retirement-and-required-key/
spec.md`** (implemented, 2026-09-05): Planning Agent is **deleted** —
`packages/agents/planning/` no longer exists in this repository. Its two
skills moved to the Orchestrator: `suggest-agents` is now served directly
and synchronously by the Orchestrator itself (`buildSuggestAgentsReply()`
in `apps/orchestrator/index.ts`), and `plan-task` has exactly one path —
the Orchestrator's own adaptive supervisor, described in "Adaptive
supervisor (Orchestrator)" below — with no flag, no toggle, and no
fallback to anything else. `ORCHESTRAI_LLM_HARNESS` (Planning's own
harness flag) and `ORCHESTRAI_ORCHESTRATOR_GRAPH` (the supervisor's old
opt-out) are both dead; a config still carrying either gets a named
startup warning (`findStaleLlmVariables()` in `apps/supervisor/
init-wizard.ts`) and starts normally regardless. `LLM_COMPONENTS`
(`packages/shared/llm-model-factory.ts`) no longer includes `"planning"`.
Port 3001 is freed, not reassigned. The Orchestrator itself now requires
a resolvable provider key to even start (see "A provider key is required
at startup" under "Adaptive supervisor" below) — the reasoning that used
to be "a genuinely absent key falls back to Planning" no longer applies,
because there is nothing left to fall back to.

The rest of this section is preserved as **historical record**, not
current architecture: it documents specs `026`/`029` (Planning's own
harness, now deleted along with the agent) and the real bugs/fixes those
checkpoints drove — including `specs/030`'s authoritative-skill-dispatch
fix and `specs/033`/`035`/`037`'s approval-preview-card work, all of
which **remain current and unaffected** by Planning's retirement (they
apply to DevOps/Documentation's dashboards and the TUI generally, not to
Planning specifically). Read `specs/026`, `specs/029`, and
`specs/051-planning-retirement-and-required-key/spec.md` directly for the
authoritative detail rather than treating anything below as describing
present-day behavior.

See specs/038-supervisor-default-and-planning-retirement/verification.md for the relocated narrative covering this checkpoint.

See specs/039-per-component-llm-provider-config/verification.md for the relocated narrative covering this checkpoint.

See specs/082-code-review-agent/verification.md for the relocated narrative covering this checkpoint.

See specs/055-provider-call-budgets-and-transient-error-handling/verification.md for the relocated narrative covering this checkpoint.

See specs/034-init-wizard-services-ux/verification.md for the relocated narrative covering this checkpoint.

See specs/050-init-per-agent-llm-toggles/verification.md for the relocated narrative covering this checkpoint.
