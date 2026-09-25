---
id: 026-llm-harness-langgraph-planning
title: Opt-In LangGraph Tool-Calling Harness for the Planning Agent
area: llm-harness
change_type: feature
status: implemented
verification: verified
created: 2026-08-16
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-16
implemented_on: 2026-08-16
amends: []
supersedes: []
superseded_by: []
related:
  - 020-semantic-intent-fallback
  - 021-ag-ui-event-protocol
  - 006-runtime-stabilization
  - 011-remaining-agents-mcp
---

# Spec: Opt-In LangGraph Tool-Calling Harness for the Planning Agent

> Status history: **APPROVED by Yusuf on 2026-08-16, IMPLEMENTED the same
> day, and VERIFIED on 2026-08-20** — see
> `specs/026-llm-harness-langgraph-planning/verification.md` for full
> evidence, and `specs/030-authoritative-skill-dispatch-and-capability-catalog/verification.md`
> for the live Gemini run (through the dynamic capability catalog that
> spec introduced) that closed this checkpoint's remaining item.

## Purpose

Introduce a real LLM-driven decision loop ("harness") into OrchestrAI for
the first time, scoped to the single narrowest seam that can prove the
pattern without touching the rest of the running system: the Planning
Agent's `plan-task` skill. Today `plan-task` produces a plan by matching
keywords against a fixed list of conditional steps
(`packages/agents/planning/index.ts`), with no ability to look at the
actual target project before deciding. This checkpoint replaces that with an
opt-in LangGraph graph that can genuinely reason: decide, call a real
read-only MCP tool, observe the result, decide again, until it is ready to
emit a plan — while producing output in the exact same text contract the
Orchestrator already parses. Nothing downstream of Planning changes: the
same `parsePlanText()` regex, the same sequential dispatch, and — most
importantly — the same deterministic approval gate for every write-capable
skill a plan step names.

LangGraph is used here for exactly one reason, not as a default framework
choice: this checkpoint needs a genuine multi-turn tool-calling loop (decide
→ call tool → observe → decide again, an unknown number of times), and
LangGraph is what turns that from a hand-rolled loop with manually threaded
state into a declarative graph with retry-with-feedback built in. Nothing in
this checkpoint uses LangGraph's persistence/checkpointing or interrupt/
resume features — see Out of Scope.

## Verified Current State

- There are no LLM API calls anywhere in this runtime today (confirmed via
  `rg` across `packages/` and `apps/` for any HTTP call to a model provider
  — none exist outside this spec's own proposal).
- `packages/agents/planning/index.ts`'s `detectSkill()` (local, keyword-only,
  distinct from the Orchestrator's own function of the same name) routes
  `plan-task` vs `suggest-agents`. `plan-task`'s implementation
  (`packages/agents/planning/index.ts:130-172`) builds `conditionalSteps`
  from a fixed set of `lower.includes(...)` checks, always prepends
  `1. [analyze-project] ...`, and returns a formatted string ending in lines
  matching `N. [skill-id] Description`. It has no access to the actual
  target project's real state — its decisions are text-pattern-only.
- The Orchestrator's `parsePlanText()` (`apps/orchestrator/index.ts:265-283`)
  regex-matches exactly that shape
  (`/^\s*(\d+)\.\s*\[([^\]]+)\]\s*(.+)$/`) to build `PlanStep[]`, then
  dispatches each step sequentially as a child task
  (`apps/orchestrator/index.ts:522` and following). This function has no
  awareness of how the text was produced.
- Every write-capable skill a plan step could name (`dockerize`, `create-ci`,
  `create-gitignore`, `create-compose`, `generate-readme`,
  `run-tests`/`check-coverage`) already requires approval through the
  existing `actionId`-bound flow (`packages/shared/approval.ts`,
  `specs/006-runtime-stabilization/spec.md`) regardless of which agent or
  logic dispatched the child task. This mechanism is keyed on skill, not on
  caller identity or reasoning method.
- `specs/020-semantic-intent-fallback/spec.md`'s Model2Vec classifier
  already establishes the precedent that a non-deterministic component may
  select a write-capable skill, with the approval gate — not skill
  restriction — as the actual safety boundary. This checkpoint follows the
  same principle.
- The Planning Agent is **not** currently an MCP client and has no MCP tool
  access. DevOps, Testing, and Documentation are, via one shared,
  reusable connection-lifecycle class: `packages/shared/mcp-client.ts`'s
  `OrchestraiMcpClient` (`specs/011-remaining-agents-mcp/spec.md`). Its
  `callTool(toolName, args, taskId)` method already emits the
  `emitAuditStart()`/`emitAuditEvent()` pair that feeds the live AG-UI
  `TOOL_CALL_START`/`TOOL_CALL_RESULT` stream — this happens inside the
  shared client itself, independent of which agent instantiates it.
- The MCP server (`packages/mcp/`) exposes both read-only tools (e.g.
  `git_status`, `analyze_project`) and write-capable ones (e.g.
  `dockerize`, `create_ci`). Nothing today restricts which tools a given
  MCP client may call — tiering (Tier 1 approval-required vs Tier 2
  read-only) is currently enforced at the *agent* layer (DevOps's own
  skill-to-approval mapping), not inside the MCP server or the shared
  client.
- No `langchain`/`langgraph`/`@langchain/*`/`@ag-ui/*` package is currently
  a dependency anywhere in `package.json` or any workspace package.

## Proposed Behavior

1. Add `@langchain/core` and `@langchain/langgraph` as dependencies, plus
   one lightweight provider adapter package selected at implementation time
   based on whichever provider Yusuf has credentials for first. The graph is
   built against LangChain's generic `BaseChatModel` interface; the concrete
   provider is a runtime config value (`ORCHESTRAI_LLM_PROVIDER` /
   `ORCHESTRAI_LLM_MODEL`), never a hardcoded import chosen by this spec.
2. Give the Planning Agent its own `OrchestraiMcpClient` instance — the same
   shared class DevOps/Testing/Documentation already use, with
   `callerName: "planning-agent"`. No new connection-lifecycle code; this is
   reuse, not a new implementation.
3. Implement a LangGraph `StateGraph` in a new module,
   `packages/agents/planning/llm-harness.ts`, with state
   `{ taskText, toolResults[], planText, validationError, attempts }` and
   this node structure:
   - **`agent` node** — calls the bound chat model with the task text, the
     accumulated tool results so far, and the fixed list of known skill ids
     (mirrored from `extractAgents()`'s own allow-list, never invented). The
     model decides to either call one more tool or emit a final plan.
   - **`tool` node** — executes exactly one read-only MCP tool call via the
     Planning Agent's own `OrchestraiMcpClient.callTool()`, appends the
     result to state, and loops back to the `agent` node.
   - **`validate` node** — when the model emits a final plan, checks it
     against the exact same shape `parsePlanText()` expects and confirms
     every named skill id is on the allow-list. On pass, the graph ends with
     the validated plan text. On failure, if `attempts < maxRetries`, loops
     back to the `agent` node with the specific validation error appended
     so the model can self-correct; once retries are exhausted, the graph
     ends with `planText: null`.
4. **Only read-only MCP tools are bound as graph tools in this checkpoint**
   — specifically `git_status` and `analyze_project`. No write-capable tool
   (`dockerize`, `create_ci`, `create_gitignore`, `create_compose`, etc.) is
   registered with the graph at all; the model has no way to call one, not
   even behind a confirmation step. This sidesteps the harder
   approval-gate-inside-a-graph design question entirely for this
   checkpoint — see Out of Scope.
5. Any failure — model API error/timeout, a tool call failing, or
   exhausted validation retries — results in `planText: null`, which
   `plan-task` treats as zero steps, matching the existing "nothing matched"
   no-op behavior (`packages/agents/planning/index.ts:140-153`) that
   `watchPlanAndDispatch()` already handles cleanly. The harness never
   returns a best-effort guess.
6. Gate the entire harness behind an explicit opt-in environment variable,
   `ORCHESTRAI_LLM_HARNESS=1`. When unset (the default, including every
   existing CI job and every previously-verified demo path), `plan-task`
   behaves byte-identically to today. Missing provider credentials with the
   flag set is a startup-time warning, not a silent fallback.
7. No change to `apps/orchestrator/index.ts`, `parsePlanText()`,
   `watchPlanAndDispatch()`, the approval gate, or the AG-UI event schema in
   this checkpoint. Planning's own tool calls flow through the existing
   audit-push → Orchestrator-mapping → `TOOL_CALL_START`/`TOOL_CALL_RESULT`
   pipeline unchanged, the same way DevOps's calls do today.

## Scope

- `packages/agents/planning/index.ts` — instantiate the Planning Agent's own
  `OrchestraiMcpClient`; branch `plan-task` to the harness when enabled,
  keyword path otherwise unchanged.
- `packages/agents/planning/llm-harness.ts` (new) — the LangGraph
  `StateGraph`, its three nodes, the model binding, and the output
  validator.
- `packages/agents/planning/*.test.ts` — new tests for the graph's tool-call
  loop, retry-with-feedback behavior, and fail-closed behavior (mocking both
  the model call and the MCP tool call; no real API calls or live MCP server
  required in the test suite).
- `package.json` / `bun.lock` — new LangChain/LangGraph dependencies.
- `CLAUDE.md` — document the new opt-in env vars, the harness's tool access
  boundary, and Planning's new MCP-client status once implemented.
- `context/worklog.md` — dated entry per the standard working procedure.

## Safety and Compatibility Constraints

- **The approval gate is untouched and remains fully deterministic.** A plan
  step naming a write-capable skill still requires the same `actionId`-bound
  `POST /tasks/:id/approve` flow regardless of whether a human, the keyword
  matcher, or this harness produced it.
- **The harness itself cannot call a write-capable tool, structurally, not
  just by policy.** Only `git_status` and `analyze_project` are registered
  as graph tools; there is no code path from the `agent`/`tool` nodes to any
  Tier 1 MCP tool. This is enforced by what's bound to the graph, not by an
  instruction to the model.
- **Fail closed, never fail open.** Any harness error (API failure, timeout,
  tool call failure, invalid/unparseable model output, an invented skill id
  not on the allow-list, exhausted retries) results in zero plan steps, not
  a guessed or partial plan.
- **No secrets in the runtime's own config surface.** Per CLAUDE.md, the
  target project's `.env` is never read as OrchestrAI configuration; the
  harness's own API key must come from OrchestrAI's own inherited
  environment, never from a target project's files.
- **Default behavior does not change.** With the flag unset, every existing
  test, CI job, and previously-verified demo scenario
  (`scripts/ag-ui-demo.ts`, `context/demo/runbook.md`) continues to pass
  unmodified.
- **No network calls in the automated test suite.** Harness tests mock both
  the model call and the MCP tool call; `bun test` must not require live
  API credentials or a running MCP server to pass in CI.
- **Bounded retries.** `maxRetries` is a small, hardcoded or config-bounded
  number (e.g. 2-3) — the graph cannot loop indefinitely on a
  never-validating model response.
- **Binary size / build impact must be measured, not assumed.** `bun run
  build`'s compiled-binary size (currently ~137 MB with the Model2Vec
  weights embedded) will grow with LangChain/LangGraph as dependencies; the
  actual delta must be reported in verification, not estimated.

## Out of Scope / Non-Goals

- **Write-capable tool access from inside the graph, and the
  approval-gate-inside-a-graph design question that would require.** This
  is deliberately deferred to its own future checkpoint, where it can get
  focused design attention (specifically: how a mid-graph decision to call
  a write-capable tool gets intercepted and forced through the existing
  approval flow before executing, not assumed safe by extension of this
  one).
- **Adopting `@ag-ui/core`/`@ag-ui/langgraph`.** This checkpoint is the
  first point where doing so would be honest (a real LLM token stream now
  exists), but bundling it in here would both break the current
  "agents stay unaware of AG-UI" architecture boundary and add events with
  no UI surface ready to render them (neither the dashboard nor the TUI
  render live token-level text today). Deferred to its own future
  checkpoint, once there's a rendering consumer for it.
- Replacing or deprecating the Model2Vec semantic classifier
  (`specs/020-semantic-intent-fallback/spec.md`) or the Orchestrator's own
  keyword routing. Both remain the default, unconditional path.
- Any other agent (DevOps, Testing, Documentation, Security) gaining LLM
  capability. This checkpoint is Planning-only.
- Making the LLM harness the default path. A future checkpoint may propose
  that once this one is verified in real use; this spec explicitly does not
  authorize it.
- Calling another agent's packaged skill via A2A from inside the graph
  (e.g. asking Security to run its full `scan-secrets` flow). The graph
  only calls raw, read-only MCP tools directly in this checkpoint.
- Replacing the Orchestrator's own routing/dispatch with a LangGraph graph.
  This checkpoint's graph lives entirely inside the Planning Agent process
  and produces the same plain-text output the Orchestrator already
  consumes; the Orchestrator itself is not restructured.

## Acceptance Criteria

- [ ] Explicit approval is recorded before implementation (this spec moves
      to `status: approved` with `approved_by`/`approved_on` set).
- [ ] With `ORCHESTRAI_LLM_HARNESS` unset, `bun test` and
      `bun run typecheck` pass with zero behavioral diff to `plan-task`'s
      existing output for every case already covered by
      `packages/agents/planning/skill-plan-task.test.ts`.
- [ ] With the flag set and a mocked model + mocked MCP tool response, a
      test proves the full loop: `agent` node decides to call a tool,
      `tool` node executes it via the mocked `OrchestraiMcpClient`, the
      result is fed back, and the graph eventually reaches `validate` and
      produces output `parsePlanText()` parses identically to today's
      keyword-driven output.
- [ ] A test proves the retry-with-feedback path: a first mocked model
      response that fails validation (invalid skill id) causes exactly one
      loop back to `agent` with the error included, and a second, valid
      mocked response then succeeds.
- [ ] A test proves exhausted retries and a tool-call failure both result in
      `planText: null` / zero plan steps, not a partial or guessed plan.
- [ ] A test or static check proves no write-capable MCP tool is reachable
      from the graph's tool set (e.g. asserting the bound tool list contains
      only `git_status` and `analyze_project`).
- [ ] A live, real-API smoke test (manual, not in CI) demonstrates one real
      end-to-end plan produced by the harness against a real target
      project, including at least one genuine tool call whose result
      visibly influenced the final plan. Raw event capture required as
      evidence, not a description.
- [ ] `bun run build`'s binary size delta from the new dependencies is
      measured and recorded.
- [ ] `CLAUDE.md` and `context/worklog.md` are updated to reflect
      implemented behavior only after the above pass.

## Verification Plan

- Automated: `bun test`, `bun run typecheck`, `bun run specs:check` — all
  must pass with the flag unset (default CI posture unchanged) and with a
  mocked-model, mocked-MCP-client test suite exercising the flag-on path,
  including the tool-call loop and retry-with-feedback behavior.
- Manual: one live run against a real target project with
  `ORCHESTRAI_LLM_HARNESS=1` and real provider credentials, covering (a) a
  request where the harness calls `git_status`/`analyze_project` and the
  result visibly changes the resulting plan versus not calling it, (b) a
  request that should produce zero steps (proving fail-closed on genuinely
  out-of-scope input, not just on API failure), and (c) a plan step naming
  a write-capable skill, confirmed to stop at the approval gate exactly
  like a keyword-driven plan would.
- `bun run build` before/after binary size comparison, recorded in this
  checkpoint's `verification.md` once implementation begins.

## Approval Requested

Approval of this spec authorizes: adding the LangChain/LangGraph
dependencies, giving the Planning Agent its own `OrchestraiMcpClient`
instance, implementing `packages/agents/planning/llm-harness.ts` as
described (including its tool-calling loop against `git_status` and
`analyze_project` only), and wiring the opt-in flag into
`packages/agents/planning/index.ts` — nothing else. It does not authorize:
any write-capable tool access from inside the graph, changing any other
agent, the Orchestrator, the approval gate, the AG-UI event schema, adopting
`@ag-ui/core`/`@ag-ui/langgraph`, or making the harness the default path.
Each of those remains a separate future decision, explicitly listed above as
a non-goal of this checkpoint.
