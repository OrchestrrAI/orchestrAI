---
id: 038-supervisor-default-and-planning-retirement
title: Adaptive Supervisor as Default Planner; Planning Retirement Deferred
area: llm-harness
change_type: migration
status: implemented
verification: verified
created: 2026-09-01
updated: 2026-09-02
approved_by: Yusuf
approved_on: 2026-09-02
implemented_on: 2026-09-02
amends:
  - 028-orchestrator-langgraph-supervisor
supersedes: []
superseded_by: []
related:
  - 020-semantic-intent-fallback
  - 026-llm-harness-langgraph-planning
  - 029-shared-llm-provider-gemini
  - 030-authoritative-skill-dispatch-and-capability-catalog
---

# Spec: Adaptive Supervisor as Default Planner; Planning Retirement Deferred

> Review gate: **APPROVED (Phase 1 / Option C only, 2026-09-02) and
> IMPLEMENTED the same day. VERIFIED the same day** — the supervisor
> now runs by default with a genuinely absent key falling back to
> Planning Agent's unchanged deterministic path, live-confirmed against
> the real compiled binary in three scenarios: default-on with a real
> key, no-key fallback, and the explicit opt-out. See Verification
> Results below. Yusuf: "will make the supervisor the default /
> confirmed", then "let do that all" once the B.6 Approval Requested
> inconsistency above was flagged and resolved. Phase 2 remains
> unauthorized.
>
> The precondition (`specs/028` verified) is **satisfied** (commit
> `6e3beca`).
>
> **This spec originally recorded Option B (immediate full retirement of
> the Planning Agent). That decision was revised to Option C on
> 2026-09-01** — ship Option A now (supervisor becomes the default
> planner; Planning is retained as the deterministic no-key fallback),
> and keep Option B's intent as a deferred, separately-approved later
> phase. See "Decision — revised" below for why. **Phase 1 is what this
> spec asks approval for; Phase 2 is explicitly not authorized here.**

## Purpose

Resolve the standing open question named verbatim in CLAUDE.md's "Current
recommended priority" ("whether the opt-in harness (026) / supervisor
(028) ever become the default path — a later decision after real use, not
authorized here") and in `specs/028`'s own Out of Scope ("making this the
default path — a later decision after real use, not authorized here").

The trigger question from Yusuf: *if the Orchestrator now plans, can the
Planning Agent be removed?* **Decision: eventually yes, but not in one
step — Option C.**

**Phase 1 (this spec's approval request):** the adaptive supervisor
(`specs/028`, `verification: verified`) becomes the **default**
`plan-task` planner, and the Planning Agent is **retained** as the
deterministic no-key fallback. Reversible by environment variable, no
deletions.

**Phase 2 (deferred, explicitly not authorized here):** full retirement —
deleting the Planning Agent and relocating `suggest-agents` into the
Orchestrator. Re-evaluated with real evidence after Phase 1 has run, and
after the proposed per-agent LLM work (`specs/041`-`043`, if approved)
has established whether "LLM when configured, deterministic fallback
otherwise" is the pattern the whole system settles on.

## Verified Current State

Read from the current code, 2026-09-01:

- **The supervisor is opt-in today, but proven.**
  `apps/orchestrator/index.ts` (~line 953): the graph path is entered only
  when `skill === "plan-task" && isOrchestratorGraphFlagSet()`, and
  `isOrchestratorGraphFlagSet()` is `env.ORCHESTRAI_ORCHESTRATOR_GRAPH ===
  "1"` — unset by default. `specs/028` is `status: implemented`,
  **`verification: verified`** (closed in commit `6e3beca`): the live
  adaptive-replan, terminal-rejection, and bound-termination runs are all
  done with real Gemini credentials (see the Precondition section for the
  detail). Only `bun run demo:ag-ui` — a general full-stack AG-UI check,
  not a 028-specific property — was deliberately deferred.
- **The default path still runs entirely through the Planning Agent.**
  With the flag unset, `POST /tasks` for a `plan-task`-shaped request
  calls `sendTaskToAgent(agent, …)` where `agent` advertises `plan-task`
  (Planning, `:3001`), then `watchPlanAndDispatch()` polls Planning to
  `completed`, `parsePlanText()`s its result, and dispatches the steps
  sequentially. This is unchanged production behavior.
- **`plan-task` with the flag set but no `ORCHESTRAI_LLM_API_KEY` fails
  the task closed** (`apps/orchestrator/index.ts` ~line 834) with a named
  error — deliberately, "never a silent fallback to the keyword-planned
  Planning Agent path". There is today no path that runs the supervisor
  *and* degrades to a deterministic planner.
- **Planning is the sole implementer of `suggest-agents`.**
  `packages/agents/planning/index.ts` (id at line 52, handler at line
  327); `packages/shared/agent-capabilities.ts` line 23 hardcodes
  `EXCLUDED_SKILL_IDS = new Set(["plan-task", "suggest-agents"])`;
  `detectSkill()` has a `suggest-agents` branch in both the Orchestrator
  (line 268) and Planning itself (line 76). Nothing else answers it.
- **Planning is structurally one of five fixed agents.**
  `packages/shared/agent-registry.ts` (`agents.planning`),
  `apps/orchestrator/index.ts` `KNOWN_AGENTS` (line ~1720),
  `apps/supervisor/index.ts` `SERVICE_STARTERS` (line 66) and `SERVICES`
  (line 90, port 3001), the `bun run planning-agent` script, the TUI's
  Agents pane, `/.well-known/agent.json` discovery, and the "five
  agents" / "5 agents" language throughout `CLAUDE.md` and `README.md`.
- **"No LLM API calls by default" is a load-bearing architectural
  claim** (CLAUDE.md, "Current architecture"). Planning's
  `keywordPlanTask()` is the only planning path that honours it; the
  supervisor and `026`'s harness both require a real provider key.
- **`026`'s Planning-side harness is independent of the supervisor.**
  `ORCHESTRAI_LLM_HARNESS=1` changes Planning's own `plan-task` skill;
  `ORCHESTRAI_ORCHESTRATOR_GRAPH=1` changes whether the Orchestrator asks
  Planning at all. A direct submission to `:3001` (the TUI's
  direct-to-agent feature, or a raw POST) always uses Planning's own
  skill logic regardless of the Orchestrator flag.
- **The supervisor graph does not depend on Planning.**
  `apps/orchestrator/supervisor-graph.ts` dispatches to skill-advertising
  agents via injected deps; it never calls `:3001`. Retiring Planning
  would not break the graph itself — only the default path, discovery,
  and `suggest-agents`.

## Precondition — SATISFIED

**`specs/028` reached `verification: verified` in commit `6e3beca`**
("docs(028): close to verified — live real-API run, real Gemini
credentials"). The live run, with real Gemini credentials, independently
confirmed all four load-bearing properties this spec depends on:

- **Adaptive multi-step dispatch** — three real sequential Gemini
  decisions (`analyze-project` → `git-status` → `dockerize`), each made
  only after observing the previous step's actual result, not a static
  plan.
- **Approval gate reached correctly** — the supervisor-chosen `dockerize`
  dispatch stopped at `input-required` with a genuine `actionId`-bound
  preview.
- **Rejection is terminal** — after a real rejection the run stayed at
  exactly 3 steps permanently (no further dispatch), the target
  `Dockerfile`'s mtime was byte-identical before/after, and the Phase 4
  `runId` correlation fix held in the real event stream.
- **Dispatch bound terminates cleanly** — with the bound temporarily
  lowered to 2 (commented, immediately reverted, confirmed byte-identical
  via `git diff`), the run stopped after exactly 2 dispatches with the
  designed error and no 3rd attempt.

Raw NDJSON captures from both sessions are saved under
`specs/028-orchestrator-langgraph-supervisor/` (checked clean of
credential leakage). Only `bun run demo:ag-ui` was deliberately deferred —
a general full-stack AG-UI protocol check, not a 028-specific property.

Nothing further is required here on the 028 side.

## Decision — revised to Option C, 2026-09-01

**Originally recorded as Option B** (immediate full retirement). Revised
the same day to **Option C** — "A now, B later incrementally" — after
three arguments surfaced that had not been weighed when B was chosen:

1. **B deletes the reference implementation the rest of the roadmap
   needs.** B.3 below deletes `packages/agents/planning/**` in full,
   including `llm-harness.ts` and `llm-harness.test.ts`. That is the only
   working example in this codebase of a bounded LLM tool-calling loop
   with a structurally-enforced read-only allow-list
   (`buildReadOnlyTools()` throws if anything outside
   `READ_ONLY_TOOL_NAMES` is ever bound), plus the tests proving that
   constraint holds. The proposed `specs/041`-`043` sequence would copy
   that exact pattern to three or four more agents. Deleting the template
   immediately before replicating it is poor sequencing regardless of
   Planning's own merits.
2. **B makes `plan-task` the one component that hard-fails.** If the
   per-agent LLM work lands, every other agent would follow "LLM when a
   key is configured, deterministic behavior when it isn't." Under B,
   `plan-task` alone fails closed with no fallback — a permanent
   exception needing permanent explanation.
3. **B trades away the demo-reliability guarantee** that CLAUDE.md's own
   framing ("a hackathon project… prefer a reliable end-to-end demo")
   treats as a priority, and does so irreversibly (rollback is `git
   revert`, not a flag).

**Option A alone was also not chosen** — it would leave the "can Planning
be retired?" question permanently open. C keeps B's *intent* (retirement
is still the expected end state) while sequencing it behind evidence.

### Phase 1 — approved scope of this spec (Option A)

- `apps/orchestrator/index.ts`: `skill === "plan-task"` routes to
  `runOrchestratorSupervisor(task)` **by default** — the behavior today
  gated behind `ORCHESTRAI_ORCHESTRATOR_GRAPH=1` becomes the default.
- **The flag inverts rather than disappears**: an explicit opt-*out*
  remains so the previous behavior is reachable without a code change.
- **No provider key ⇒ fall back to the Planning Agent's existing
  deterministic `keywordPlanTask()` path**, not a hard failure. This is
  the substantive difference from B, and it preserves the "no LLM API
  calls by default" claim: with no key configured, nothing changes at
  all.
- Planning Agent, its package, `suggest-agents`, the registry entry, and
  the two-phase `watchPlanAndDispatch()`/`parsePlanText()` machinery are
  all **retained and unchanged** — they are the fallback path.
- Startup reporting states which planner is active and why (key present
  vs. absent), so the selected path is never a silent guess.

### Phase 2 — deferred, NOT authorized by this spec

Everything in B.1-B.5 below is retained as the researched detail for the
eventual retirement, to be re-proposed as its own checkpoint once Phase 1
has real mileage. **Approving this spec does not approve any of it.**
Its preconditions for re-proposal: Phase 1 running in practice, and a
decision on whether the wider system settles on "LLM with deterministic
fallback" (which would argue for keeping Planning) or "LLM required"
(which would argue for removing it).

### B.1 — The supervisor becomes the only planner *(Phase 2, deferred)*

- `apps/orchestrator/index.ts`: the `skill === "plan-task"` branch calls
  `runOrchestratorSupervisor(task)` **unconditionally**. The
  `ORCHESTRAI_ORCHESTRATOR_GRAPH` flag and `isOrchestratorGraphFlagSet()`
  are removed (a `plan-task` request has nowhere else to go).
- **No provider key ⇒ the task fails closed** with the same named,
  actionable error `028` already emits at
  `apps/orchestrator/index.ts` (~line 834). There is no deterministic
  fallback planner any more. This is an **explicit, documented reversal**
  of the "no LLM API calls anywhere in this runtime by default"
  architectural claim — for `plan-task` specifically. Direct-routed
  single-skill requests, routing (`detectSkill()`), and the semantic
  classifier (`specs/020`) remain fully deterministic and key-free.
- The now-dead two-phase machinery is removed:
  `watchPlanAndDispatch()`, `parsePlanText()`, and the plan-text poll
  loop. (`parsePlanText()` is used only by `watchPlanAndDispatch()`; the
  supervisor decides one step at a time and never parses a text plan.
  Implementation must confirm no other caller before deletion.)

### B.2 — `suggest-agents` moves into the Orchestrator

- `skillSuggestAgents()` (`packages/agents/planning/index.ts` ~line 327)
  is deterministic keyword logic over agent capabilities and needs no
  separate process. It is ported into `apps/orchestrator/index.ts` as a
  local handler: when `detectSkill()` returns `suggest-agents`, the
  Orchestrator answers it directly from its own live `registry` instead
  of routing to `:3001`.
- The shared helpers it relies on (`packages/shared/agent-capabilities.ts`,
  including `EXCLUDED_SKILL_IDS`) stay where they are.
- `detectSkill()`'s `suggest-agents` branch (Orchestrator line ~268) is
  unchanged; only its downstream handling changes.

### B.3 — Planning is removed from the topology

- `packages/shared/agent-registry.ts` — drop the `planning` entry and its
  place in `AgentName`.
- `apps/orchestrator/index.ts` — drop `agentRegistry.planning` from
  `KNOWN_AGENTS` (~line 1720).
- `apps/supervisor/index.ts` — drop `planning-agent` from
  `SERVICE_STARTERS` (line 66) and `SERVICES` (line 90, port 3001), and
  from the ordered `/healthz` startup gate.
- `package.json` — remove the `planning-agent` script; remove
  `planning-agent` from the `dev` / `dev:with-mcp` / `dev:with-all-mcp`
  parallel script lists.
- `packages/agents/planning/**` — deleted in full: `index.ts`,
  `llm-harness.ts`, the local `model-factory.ts`, `mcp-client.ts`,
  `capability-discovery.ts`, and their tests
  (`skill-plan-task.test.ts`, `llm-harness.test.ts`, any others). The
  shared `packages/shared/llm-model-factory.ts` (from `specs/029`) is
  **kept** — the supervisor uses it.
- The TUI (`apps/tui/index.tsx`) renders whatever `/agents` returns, so no
  hardcoded "5" is expected there; implementation confirms this and fixes
  any discovery/count assertion it does make.

### B.4 — Documentation and spec reconciliation

- `CLAUDE.md`: rewrite the "Current architecture" diagram and the "no LLM
  API calls … by default" paragraph (now carved out for `plan-task`); the
  "Current services and skills" table (5 → 4 agents, drop the Planning
  row and `:3001`); the whole "Opt-in LLM harness (Planning Agent)"
  section (now historical — the supervisor supersedes it); the
  "Opt-in adaptive supervisor" section (no longer opt-in); the task/plan
  flow description ("Parses Planning Agent lines formatted as …" no longer
  applies); "Current recommended priority"; and every "five agents" /
  "5 agents" mention.
- `README.md`: the same agent-count, architecture, and command changes.
- `specs/026`, `specs/029`, `specs/030`: add a short historical note to
  each where it describes "Planning's own `plan-task` skill", pointing at
  this checkpoint. Their frontmatter status is not changed (they remain
  `implemented` history); only prose gains the pointer.
- `context/worklog.md`: dated entry per the standard format.

### B.5 — Shared behavior kept from `specs/028`

- The approval gate, `actionId` binding, and approve/reject endpoints are
  **untouched**. Rejection stays terminal; the effect-certainty
  classifier (`classifyDispatchOutcome()`, `SKILL_TIER_REGISTRY`) is
  unchanged.
- The change is **release-noted, never silent**: the supervisor startup
  summary states that `plan-task` now runs through the supervisor and
  requires a provider key, and the worklog records it.
- Rollback is by reverting the release — there is no in-place downgrade,
  stated plainly here and in the worklog.

### B.6 — Routing-decision transparency (misdetection visibility)

Motivation: retiring the deterministic planner raises the cost of a
`detectSkill()` misroute. The approval gate remains the safety boundary
for every write, but a human should be able to see *what* a request routed
to and *why*, at submit time, without waiting for the approval preview.
This adds visibility only — **it does not change any routing decision**.

- `apps/orchestrator/detect-skill.ts`: `detectSkill()` returns
  `{ skill, reason }` instead of a bare `string`, where `reason` is a
  short tag:
  - `keyword:<matched-token>` — e.g. `keyword:dockerfile`
  - `classifier:score=<n>,margin=<n>` — the `specs/020` semantic fallback
    decided
  - `default:plan-task` — nothing matched
  The matching logic itself is byte-identical; only the return shape and
  an accumulated `reason` are new. (`detectSkill()`'s Planning-side
  duplicate is being deleted in B.3, so this is a one-site change now
  rather than two later.)
- `apps/orchestrator/index.ts`: store `routingReason` on the
  `OrchestratorTask` and include it in `GET /tasks/:id` and `GET /tasks`.
  No new AG-UI event and no change to an existing event payload — the
  `@ag-ui/core` runtime schema validation (`specs/027`) is left alone; the
  field rides only on the task object the dashboard/TUI already fetch.
- Dashboard (`apps/orchestrator/index.ts` inline HTML): show
  `routingReason` in the task detail modal, next to status.
- TUI (`apps/tui/index.tsx`): one line in the Detail overlay, under
  `Status:` — e.g. `Routed: dockerize (keyword:dockerfile)`.
- Absent a `routingReason` (any task created before this change, or a
  direct-to-agent TUI submission that never ran `detectSkill()`), both
  clients simply omit the line.

## Scope

**Note, 2026-09-02**: like `plan.md` and the Verification Plan above,
the file list below was written for the original Option B scope and
was never split by phase. It remains accurate as **Phase 2** reference
material (nothing here is implemented by this approval). Phase 1's
actual, implemented file list is: `apps/orchestrator/index.ts`
(`isOrchestratorGraphEnabled()`, `supervisorShouldFallBackToPlanning()`,
`describeSupervisorStartupState()`, the updated `POST /tasks` branch
condition, the startup log line — Planning, `detectSkill()`, and every
other file below **untouched**); `apps/orchestrator/
supervisor-wiring.test.ts` (rewritten for the new default/fallback/
opt-out semantics); `apps/supervisor/init-wizard.ts` (one line — the
"Enable the adaptive supervisor" prompt's own suggested default,
found live-inconsistent with the new system default, not originally
anticipated by this section — see Verification Results); `CLAUDE.md`,
`README.md`, `context/worklog.md`; this spec's own `spec.md`/`plan.md`.

Files changed for the deferred **Phase 2** (detail in B.1–B.6 above):

- `apps/orchestrator/index.ts` — unconditional supervisor branch; remove
  the flag helper, `watchPlanAndDispatch()`, `parsePlanText()`, the plan
  poll loop; add the local `suggest-agents` handler; drop
  `agentRegistry.planning` from `KNOWN_AGENTS`; store/expose
  `routingReason` on the task; task-detail modal shows it; startup/release
  logging.
- `apps/orchestrator/detect-skill.ts` — `detectSkill()` returns
  `{ skill, reason }`; matching logic unchanged (B.6).
- `apps/orchestrator/detect-skill.test.ts` — updated for the new return
  shape; cases asserting the `reason` tag per branch.
- `packages/shared/agent-registry.ts` — remove `planning`.
- `apps/supervisor/index.ts` — remove `planning-agent` from
  `SERVICE_STARTERS`, `SERVICES`, and the startup `/healthz` gate.
- `package.json` — remove the `planning-agent` script and its place in the
  `dev*` parallel lists.
- `packages/agents/planning/**` — deleted in full, including its tests.
- `apps/tui/index.tsx` — the Detail-overlay `Routed:` line (B.6); plus a
  hardcoded agent-count/discovery assertion fix only if one exists (to be
  confirmed).
- Test files across `apps/orchestrator/` and `packages/` asserting a
  five-agent set — updated to four; new tests for the relocated
  `suggest-agents` and the key-present/key-absent supervisor branch.
- `CLAUDE.md`, `README.md`, `context/worklog.md`, and short historical
  pointers in `specs/026`/`029`/`030`.

## Safety and Compatibility Constraints

- **Precondition met** (`028` verified, commit `6e3beca`) — approval is no
  longer blocked on it, only on Yusuf's explicit sign-off of this B-scoped
  spec.
- **No-key behavior is fail-closed and named** — never a hang, never a
  partial plan, never a silent fallback (there is no fallback).
- **Approval gate unchanged.**
- **`bun test` and `bun run typecheck` stay green.** Tests that assert a
  five-agent registry/discovery set are **updated to four**, not skipped
  or deleted wholesale; Planning's own unit tests are removed with the
  package they cover; new tests cover the relocated `suggest-agents`
  handler and the unconditional supervisor branch (key present vs absent).
- **`bun run dev`, `bun run orchestrai`, and the compiled binary start
  cleanly** with four agents; nothing attempts to spawn, `/healthz`-gate,
  or discover `:3001`.
- **`bun run build`** still succeeds (Planning removed from the compiled
  entry set; `models/` requirement unchanged).

## Out of Scope / Non-Goals

- Any change to the approval gate, `actionId`, or approve/reject flow.
- Write-capable MCP tool access from inside the graph (still deferred, per
  `028`).
- Parallel dispatch, LangGraph persistence/checkpointing, adopting
  `@ag-ui/langgraph` — all still out, per `028`.
- Removing `020`'s semantic classifier, or changing which skill
  `detectSkill()` picks for any input. B.6 extends its **return shape** to
  expose the reason; the matching logic and every routing outcome are
  byte-identical.
- Any new AG-UI event or any change to an existing event payload for
  `routingReason` — it rides only on the task object (B.6).
- A "confirm this routing?" gate before dispatch — the approval gate
  already covers every write; B.6 is visibility, not a second gate.
- Removing the shared `llm-model-factory.ts` — the supervisor uses it; it
  stays.
- Changing the supervisor graph's own logic, tool access, bounds, or the
  `DispatchOutcome` contract — all unchanged from `028`.
- A stub Planning Agent kept "just in case" — B deletes the package; a
  future re-introduction would be its own checkpoint.

## Acceptance Criteria

- [ ] `specs/028` is `verification: verified` (precondition) — **already
      met**: closed in commit `6e3beca`. Box left unchecked only because
      governance forbids a `draft` spec ticking criteria; it flips on
      approval.
- [ ] Explicit approval of this **Phase 1 (Option C)** scope is recorded
      before implementation.

### Phase 1 — this spec's scope

- [x] `apps/orchestrator/index.ts` routes `plan-task` to
      `runOrchestratorSupervisor()` **by default**, with an explicit
      opt-out flag preserving the previous behavior without a code change.
- [x] With a provider key configured, a `plan-task`-shaped request runs
      through the supervisor — verified live (adaptive steps visible in
      the dashboard/TUI).
- [x] **With no provider key, `plan-task` falls back to the Planning
      Agent's deterministic `keywordPlanTask()` path** — same plan output
      as before this checkpoint, no error, no hang — verified live. With
      no key configured, behavior is byte-identical to today.
- [x] Startup reporting states which planner is active and why (key
      present vs. absent) — never a silent selection.
- [x] Planning Agent, `suggest-agents`, the registry entry, and the
      `watchPlanAndDispatch()`/`parsePlanText()` machinery are all
      **retained and unchanged** — confirmed by diff, since they are the
      fallback path.
- [x] Approve and reject on a supervisor-dispatched plan step behave
      exactly as before (`028`'s properties re-confirmed).

### Phase 2 — deferred, NOT part of this approval

The retirement-specific criteria below are retained for the eventual
follow-up checkpoint and are **not** in scope here: deleting
`packages/agents/planning/**`; relocating `suggest-agents` into the
Orchestrator; removing `:3001` from `apps/supervisor/index.ts`,
`KNOWN_AGENTS`, `packages/shared/agent-registry.ts`, and `package.json`;
removing `watchPlanAndDispatch()`/`parsePlanText()`; and updating every
five-agent assertion to four.
- [ ] `detectSkill()` returns `{ skill, reason }`; every pre-existing
      routing outcome is unchanged (test suite proves skill selection is
      byte-identical); `reason` carries the right tag for a keyword hit, a
      classifier decision, and the `plan-task` default.
- [ ] `routingReason` appears in `GET /tasks/:id`, the dashboard task
      modal, and the TUI Detail overlay for a routed task; it is omitted
      cleanly when absent. No AG-UI event payload changed.
- [ ] `bun test`, `bun run typecheck`, `bun run specs:check`, and
      `bun run build` all pass.
- [ ] `bun run dev`, `bun run orchestrai`, and the compiled binary start
      cleanly with four agents; the supervisor startup summary states that
      `plan-task` now runs through the supervisor and requires a key.
- [ ] `CLAUDE.md`, `README.md`, `context/worklog.md`, and the historical
      pointers in `specs/026`/`029`/`030` are reconciled — agent count,
      architecture diagram, the "no LLM by default" carve-out for
      `plan-task`, and the removed plan-text flow.

## Verification Plan

- **Automated:** full `bun test` + `bun run typecheck` + `bun run
  specs:check` + `bun run build`. New tests: the relocated `suggest-agents`
  handler (unit, against a fake registry); the unconditional supervisor
  branch with a key present (deps built, dispatch attempted) and absent
  (fail-closed error, no dispatch). Updated tests: every registry/
  discovery assertion 5 → 4. Removed tests: `skill-plan-task.test.ts`,
  `llm-harness.test.ts`, and any other file solely covering
  `packages/agents/planning/`.
- **Manual, live (Yusuf's machine, real provider key):**
  1. `bun run orchestrai` (key set) → startup summary lists four agents,
     no `:3001`, no discovery error; the summary states the `plan-task`
     planner and key requirement.
  2. A `plan-task`-shaped request → supervisor runs; dashboard/TUI shows
     adaptive multi-step dispatch; a write step reaches `input-required`.
  3. Approve that step → executes; separately, reject one on a fresh run →
     run stays terminal, nothing written (`028` re-confirmed).
  4. Restart with **no** key, same request → task fails closed with the
     named error; nothing hangs.
  5. A `suggest-agents` request → correct list; confirm via logs no call
     left the Orchestrator for `:3001`.
  6. Open a routed task in the dashboard modal and the TUI Detail overlay
     → the `Routed: <skill> (<reason>)` line is present and correct;
     deliberately submit a phrasing known to be borderline and confirm the
     reason tag makes the routing legible.
  7. The compiled binary repeats 1, 2, and 4.
  8. `bun run demo:ag-ui` (deferred from `028`) — run it here.
- Record exact results and any deviation in
  `context/worklog.md` and this spec's checkboxes; keep `verification`
  honest (`partial` until the live items are done on Yusuf's machine).

**Note on this list, found while executing it**: like `plan.md`, this
Verification Plan was written for the original Option B scope and never
updated after the same-day revision to Option C. Items 5 (`suggest-agents`
relocation) and 6 (the `Routed:` reason line) test B.2/B.6, both Phase 2 —
not applicable here. Item 8 (`bun run demo:ag-ui`) is a general full-stack
AG-UI check, not a Phase-1-specific property, and was already noted as
deliberately deferred by `specs/028` itself for the same reason. Items 1–4
and 7 are the ones that actually apply to Phase 1's approved scope; see
Verification Results below for what was run instead, adapted to the real
scope.

## Verification Results (2026-09-02)

**Automated:** `bun test` — 480 passed, 0 failed (unchanged count:
`apps/orchestrator/supervisor-wiring.test.ts` was rewritten in place —
old tests asserting the pre-038 "flag set + no key ⇒ fail closed"
behavior replaced with tests asserting the new default-on/fallback
behavior; net same test count). `bun run typecheck` — 0 errors.
`bun run specs:catalog` + `bun run specs:check` — clean for 43 specs.

**A real, stale-plan-document bug found and fixed before implementation,
not assumed away**: `plan.md` still described the original Option B
three-phase plan (unconditional supervisor, `suggest-agents` relocation,
Planning deletion) — it was never updated when the spec itself was
revised to Option C the same day it was drafted. Implementing against it
as-is would have been implementing an unapproved scope. Rewritten to
describe Phase 1's actual approved scope before any code was touched.

**Binary size delta:** measured via `wc -c`, not estimated — 147,771,904
→ 147,772,928 bytes, **+1,024 bytes** — pure logic change, zero new
dependency, as expected (no new library, just a routing condition, a
fallback check, and a startup-log line).

**Live, real machine, real Gemini key, the real compiled binary**, a
reduced 4-process stack (`mcp:http`, `planning-agent`, `devops-agent`,
`orchestrator`) against the scratch `test-target-project`:

1. **Default-on, real key present, flag genuinely unset** — the startup
   log correctly read `plan-task planner: enabled (default) — provider
   gemini (ORCHESTRAI_LLM_PROVIDER), model gemini-3.5-flash-lite
   (ORCHESTRAI_LLM_MODEL), key from ORCHESTRAI_LLM_API_KEY — plan-task
   runs through the adaptive supervisor`. Submitting "build and deploy
   my bun app" returned `assignedAgent: "orchestrator-supervisor"` and
   produced a genuine two-step adaptive dispatch (`analyze-project` →
   `dockerize`, the second decided only after observing the first's real
   result), reaching a real `actionId`-bound approval on `dockerize`.
   Planning Agent's own `/healthz` task count stayed at `0` throughout —
   proof, not inference, that it was never contacted. Rejected the write
   to avoid an unneeded file; confirmed no Dockerfile was created.
2. **No provider key, supervisor enabled (default)** — the startup log
   correctly read `plan-task planner: enabled (default) but no provider
   key configured — plan-task falls back to the deterministic Planning
   Agent path, same output as before specs/038`. The identical request
   returned `assignedAgent: "planning-agent"` and produced the exact
   same 4-step deterministic plan (`analyze-project` → `dockerize` →
   `create-ci` → `run-tests`) this exact phrasing has produced since
   `specs/026`'s own verification — confirming byte-identical fallback
   output, not just "didn't crash." Reached the real approval gate on
   `dockerize` (rejected via the Orchestrator's own reject endpoint this
   time — see the note below); no file written.
3. **Explicit opt-out (`ORCHESTRAI_ORCHESTRATOR_GRAPH=0`) with a real key
   present** — the startup log correctly read `plan-task planner:
   disabled (ORCHESTRAI_ORCHESTRATOR_GRAPH=0) — plan-task always uses
   the deterministic Planning Agent path`. The identical request still
   returned `assignedAgent: "planning-agent"` despite a genuinely valid
   key being configured — proof this is a real opt-out, not a
   coincidental no-key fallback landing on the same agent. Reached
   approval on `dockerize`; rejected, no file written.

**A verification-methodology mistake, caught and corrected mid-session**:
scenario 1's rejection was first sent directly to DevOps's own `/tasks/
:id/reject` endpoint (bypassing the Orchestrator), which produced
`failed-ambiguous` ("reconciliation required") rather than a clean
terminal rejection — because `specs/028`'s own `rejectedByOrchestrator`
tracking only populates at the Orchestrator's *own* `POST /tasks/:id/
reject` endpoint, exactly as that spec's adversarial design intends
(never assume a write's effect from an untracked path). This is
correct, unchanged `028` behavior, not a `038` regression — confirmed by
rejecting scenarios 2 and 3 through the Orchestrator's own endpoint
instead, both producing a clean `{"status":"failed","message":
"Rejected"}`.

Cleanup confirmed after every scenario: `taskkill`/`tasklist`/`netstat`
showed zero orphaned `orchestrai.exe` processes and no service ports
listening; every saved log grepped clean of the real key value
(`grep -lE "AQ\.|AIza|api_key=[A-Za-z0-9]"`, exit code 1) before
deletion.

**Not exercised**: item 8 (`bun run demo:ag-ui`) — deliberately, per the
note above; a general full-stack property, not specific to this
checkpoint, already deferred once by `specs/028` for the same reason.

**A second real, live-caught issue, outside this spec's own listed
Scope but directly caused by it**: `apps/supervisor/init-wizard.ts`'s
"Enable the adaptive supervisor for plan-task?" prompt computed its own
suggested default answer as `existing.env.ORCHESTRAI_ORCHESTRATOR_GRAPH
=== "1" ? "y" : "n"` — collapsing "no existing config at all" and "an
existing config that explicitly opted out" into the same suggested "n"
answer. That was correct only while "unset" meant "off" system-wide; it
no longer does. A first-time user accepting the wizard's own suggested
default would have had the wizard *write* an explicit
`ORCHESTRAI_ORCHESTRATOR_GRAPH=0`, opting them out of what would
otherwise have been the new default-on behavior with no wizard at all —
the wizard's own suggestion would have silently disagreed with the
system's real default. Fixed to `=== "0" ? "n" : "y"` (unset or `"1"`
both now suggest `"y"`; only an explicit prior `"0"` still suggests
`"n"`, preserving a returning user's earlier explicit choice on
re-run). Live-verified: a genuinely fresh scratch directory, piped
non-interactive input accepting every default, produced a prompt
reading `Enable the adaptive supervisor for plan-task? (y/n) [y]:` and
a written config containing `ORCHESTRAI_ORCHESTRATOR_GRAPH=1` —
confirmed against the real compiled binary, not just read from source.

## Approval Requested

**Option C is recorded (2026-09-01, revised from B the same day). This
spec now needs Yusuf's explicit approval of its Phase 1 scope before any
implementation** — per CLAUDE.md Working procedure step 8, choosing the
option is not itself authorization.

Approval authorizes **Phase 1 only**: making the adaptive supervisor the
**default** `plan-task` planner with an explicit opt-out flag; **falling
back to the Planning Agent's existing deterministic planner when no
provider key is configured**; startup reporting of which planner is
active and why; and the corresponding documentation updates.

**Correction (2026-09-02, caught before implementation began):** this
paragraph previously also listed B.6 (`detectSkill()`'s `{skill, reason}`
return shape and surfacing `routingReason` in both clients) as authorized
here. That directly contradicted the Acceptance Criteria section, which
has always placed B.6's checkboxes under "Phase 2 — deferred, NOT part of
this approval" — the same placement the Phase 2 section header and the
B.1–B.5 "retained… for the eventual follow-up checkpoint" framing both
already gave it. Three of four places in this document agreed B.6 is
Phase 2; this was the one drafting leftover. Resolved in favor of the
majority, consistent reading: **B.6 is Phase 2, not authorized by this
approval.**

It does **not** authorize: deleting the Planning Agent or any part of
`packages/agents/planning/**`, relocating `suggest-agents`, removing
`watchPlanAndDispatch()`/`parsePlanText()`, removing `:3001` from the
registry/supervisor/scripts, any change to the approval gate, the
supervisor graph's own logic or tool access, which skill `detectSkill()`
picks for any input, B.6's routing-reason transparency work, or anything
in Out of Scope. Phase 2 (full retirement, and B.6) requires its own
later checkpoint and its own approval. See `plan.md` for the phased
sequence.
