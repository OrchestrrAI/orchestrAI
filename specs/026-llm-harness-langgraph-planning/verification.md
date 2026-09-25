# Verification: Opt-In LangGraph Tool-Calling Harness for the Planning Agent

## Status

`verified` as of 2026-08-20 — implementation, automated tests, typecheck,
spec governance, compiled-binary smoke tests, and all three real-provider
scenarios ran. The original live run found a downstream skill-dispatch
correctness blocker: a plan step named `git-status` was re-detected by
DevOps as `dockerize` because the LLM-authored description mentioned
`Dockerfile`. The approval gate prevented mutation and the action was
rejected. That blocker is now fixed and re-verified live — see below.

## Automated evidence

- `bun test`: 170 passed, 0 failed, 318 expectations across 19 files
  (includes 12 new tests in `packages/agents/planning/llm-harness.test.ts`).
- `bun run typecheck` (`tsc --noEmit`): exited 0.
- `bun run specs:check`: passed for 26 specs.
- The 8 pre-existing tests in `packages/agents/planning/skill-plan-task.test.ts`
  pass unmodified — zero behavioral diff to the keyword path.
- `llm-harness.test.ts` covers, against a scripted fake `BaseChatModel` and a
  mocked `McpToolCaller` (no network calls, no live credentials):
  - `validatePlanOutput()` accepting well-formed plans, `NO_PLAN`, every
    `KNOWN_SKILL_IDS` entry individually, and rejecting invented skill ids
    and malformed lines.
  - The full tool-call loop: agent decides to call `git_status`, the tool
    node executes it via the mock, the result is fed back, and the graph
    reaches a valid final plan — verified the mock was called exactly once
    with the correct tool name and task id.
  - A plan emitted with zero tool calls (the model isn't required to call
    any).
  - Retry-with-feedback: an invalid skill id triggers exactly one loop back
    to the agent node with the validation error, and a second valid
    response then succeeds.
  - Exhausted retries (`maxRetries: 1`, three consecutive invalid
    responses) resolve with `planText: null`, not a partial/guessed plan.
  - The bound tool set contains only `git_status` and `analyze_project`
    (`READ_ONLY_TOOL_NAMES`), and no write-capable MCP tool name
    (`dockerize`, `create_ci`, `create_gitignore`, `create_dockercompose`)
    ever appears in it — asserted directly against `buildReadOnlyTools()`'s
    real output, not inferred.
  - A tool call throwing (e.g. `resolveTargetPath()` rejecting a task with
    no absolute path, or a raw MCP error) does **not** crash the graph —
    found live while writing this test that LangGraph's `ToolNode` catches
    the error and turns it into a `ToolMessage` the agent sees on its next
    turn, not a graph-level exception. The original test assumption (a
    thrown tool error propagates and rejects the run) was wrong and was
    corrected after inspecting the actual resulting message list, not left
    in place. The harness still reaches a clean `planText: null` when the
    agent gives up after seeing the error.

## Live evidence (Windows)

### Compiled binary — flag unset (default)

Rebuilt `dist/bin/orchestrai.exe` with the new `@langchain/*` dependencies
present. Started `orchestrai.exe --only planning-agent`, confirmed
`/healthz`, then submitted the exact same task text as the pre-existing
"already-demoed 4-step count" test:

```text
POST http://localhost:3001/  {"text": "build and deploy my bun app"}
```

Result: identical output to the keyword path's known-good plan —
`analyze-project`, `dockerize`, `create-ci`, `run-tests`, in that order,
`Estimated tasks: 4`. Startup log printed `LLM harness: disabled (default)`.

### Compiled binary — flag set, no credentials

Started with `ORCHESTRAI_LLM_HARNESS=1` and no `ORCHESTRAI_LLM_API_KEY`.
Result: the startup warning fired as designed —

```text
[planning-agent] WARNING: ORCHESTRAI_LLM_HARNESS=1 is set but
ORCHESTRAI_LLM_API_KEY is missing — plan-task will fail closed (zero steps)
until a valid provider API key is configured.
```

— and the startup summary line read
`LLM harness: enabled but unconfigured (see warning above)`. Confirms this
is a loud, explicit warning, not a silent fallback to the keyword path.

### Binary size delta

| | Size |
|---|---|
| Before (`specs/025` state) | 143,981,568 bytes (137.32 MB) |
| After (`@langchain/core`, `@langchain/langgraph`, `@langchain/anthropic`, `@langchain/openai`) | 146,875,392 bytes (140.07 MB) |
| **Delta** | **+2,893,824 bytes (+2.76 MB)** |

Measured by rebuilding with `bun run build` and comparing exact byte counts
before and after — not estimated.

## Live Gemini evidence — 2026-08-16

Yusuf explicitly authorized sending read-only structure, filenames,
repository status, and Git metadata from the external test fixture to Gemini.
The run used `gemini-3.5-flash-lite`; no credential was captured.

1. **Real Planning-owned MCP calls:** run
   `task-a05e71ca-59c2-4d35-b8b0-2bc2f8dfd545` emitted correlated
   `TOOL_CALL_START`/`TOOL_CALL_RESULT` pairs for both `analyze_project` and
   `git_status`, caller `planning-agent`. The final plan incorporated concrete
   observations from those results: branch `main`, modified/untracked state,
   observed DevOps artifacts, and the recent fixture commit. This proves the
   results influenced the response rather than merely being called.
2. **Out-of-scope fail-closed:** run
   `task-23277d76-1567-46af-8cf5-fdd2a05beefd` completed with the existing
   no-actionable-steps result, zero children, and zero tool events.
3. **Controlled write gate:** run
   `task-3cc38491-6292-4b04-af2c-916ce7cb919e` produced one `dockerize`
   child. It stopped at `input-required`; the target Dockerfile remained at
   SHA-256 `4AB398580762D314DEB6F07F5C696BE2393396E64EC87E837917A06FB877CD45`
   with the same timestamp before the decision. Rejection produced
   `orchestrai.approval-resolved` with `decision: rejected`, and the hash and
   timestamp remained unchanged afterward.

Selected raw events with payloads bounded and the target root sanitized are
preserved in `../029-shared-llm-provider-gemini/live-events.sanitized.ndjson`.

## Verification blocker found live

The read-only plan's first executable step was `git-status`, but its natural-
language description repeated observed filenames including `Dockerfile`.
The Orchestrator correctly stored `skill: git-status`; DevOps then ignored
that already-selected skill and re-ran its own keyword detector over the
combined child text. Because `dockerfile` has higher precedence there, DevOps
created an approval preview for `create_dockerfile`/`dockerize` instead.

The action remained safe—`input-required`, unchanged target, rejected—but it
was not correct.

### Resolved — 2026-08-20

`specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md`
makes dispatched skill identity authoritative: the Orchestrator sends the
skill it already decided on with every dispatch, and every agent executes
exactly that skill rather than re-deriving one from description text. Its
own live Gemini re-run
(`specs/030-authoritative-skill-dispatch-and-capability-catalog/verification.md`)
repeated a plan with the same adversarial shape — a step whose description
could plausibly redirect it — through this checkpoint's own harness, and
confirmed every downstream child executed the exact skill the plan named.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/026-llm-harness-langgraph-planning/spec.md` (implemented), extended
by `specs/029-shared-llm-provider-gemini/spec.md` (implemented). This is
the first place in the runtime an LLM API call can happen — the statement
above ("no LLM API calls in the current runtime") is no longer true only
when this is explicitly enabled; it is false by default everywhere else in
the system and stays false in every other agent. Set
`ORCHESTRAI_LLM_HARNESS=1` plus `ORCHESTRAI_LLM_API_KEY` (and optionally
`ORCHESTRAI_LLM_PROVIDER` — `anthropic` (default), `openai`, or `gemini` —
and `ORCHESTRAI_LLM_MODEL`) to route Planning's `plan-task` skill through a
LangGraph tool-calling loop instead of the deterministic keyword logic in
`keywordPlanTask()`. With the flag unset (the default), `plan-task` is
byte-identical to before this spec — live-verified via the compiled binary,
not just `bun test`.

Provider parsing and concrete construction now live in the shared,
inert-until-called `packages/shared/llm-model-factory.ts`; Planning's local
`model-factory.ts` owns only `ORCHESTRAI_LLM_HARNESS` and delegates after
the flag is enabled. Gemini uses the exactly pinned `@langchain/google@0.2.2`
Node adapter (`ChatGoogle`) through the same LangChain `BaseChatModel` /
`bindTools()` boundary as Anthropic and OpenAI. Gemini deliberately has no
moving default model: `ORCHESTRAI_LLM_MODEL` is required when it is selected.
Missing or invalid configuration emits an explicit warning and produces zero
executable plan steps; it never falls back to another provider or the keyword
planner. The shared factory does not activate the Orchestrator or any other
agent, and importing it makes no provider call.

Architecture, deliberately scoped narrow: the graph (`packages/agents/
planning/llm-harness.ts`) can decide, call one of exactly two **read-only**
MCP tools (`git_status`, `analyze_project` — Tier 2 in this repo's own
tiering) via Planning's own `OrchestraiMcpClient` instance
(`packages/agents/planning/mcp-client.ts`, same shared class DevOps/Testing/
Documentation already use), observe the result, and decide again, before
emitting a final plan. No write-capable MCP tool is registered with the
graph at all — not a policy note, a structural constraint checked at graph-
build time (`buildReadOnlyTools()` throws if ever edited to bind anything
outside `READ_ONLY_TOOL_NAMES`) and asserted directly in
`llm-harness.test.ts`. The high-level skill vocabulary the model may name
in a plan is no longer a hardcoded list either
(`specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md`,
implemented): it comes from an invocation-scoped `capabilities` snapshot —
either the Orchestrator's own live-registry snapshot for a routed
`plan-task`, or, for a direct request to Planning with no snapshot
supplied, this agent's own bounded discovery
(`packages/agents/planning/capability-discovery.ts`) restricted to exactly
the five fixed URLs in `packages/shared/agent-registry.ts`, never a
configurable endpoint. `READ_ONLY_TOOL_NAMES` itself is untouched by this —
no Agent Card or capability snapshot can ever expand MCP tool access; the
two allow-lists are deliberately independent. The model output must
validate against the exact same `N. [skill-id] Description` shape
`apps/orchestrator/index.ts`'s
`parsePlanText()` already expects; an invalid response gets one round of
retry-with-feedback (bounded, `maxRetries`), and exhausted retries or any
other failure (API error, timeout, tool failure) fails closed to zero plan
steps — same "no actionable steps" shape the keyword path already produces
for unmatched input, never a guessed or partial plan. LangGraph is used for
exactly one reason here: the multi-turn tool-call loop and its built-in
retry-with-feedback branching — nothing in this module uses LangGraph's
persistence/checkpointing or interrupt/resume features.

**The approval gate is completely untouched.** A plan step naming a
write-capable skill (`dockerize`, `create-ci`, etc.) still requires the
same `actionId`-bound `POST /tasks/:id/approve` flow regardless of whether
a human, the keyword matcher, the semantic classifier, or this harness
produced it — this checkpoint follows the same precedent
`specs/020-semantic-intent-fallback/spec.md` already established (a
non-deterministic component may *name* a write-capable skill; the approval
gate, not skill restriction, is what makes that safe). `apps/orchestrator/
index.ts`, `parsePlanText()`, plan-step dispatch, and the AG-UI event schema
are all unchanged by this spec.

Explicitly deferred, not attempted here: write-capable tool access from
inside the graph (and the harder approval-gate-inside-a-graph design
question that would require its own checkpoint), replacing the Orchestrator
itself with a LangGraph supervisor coordinating all five agents (a
materially larger, riskier bet — the Orchestrator, not Planning, is where
the approval gate and the entire task/plan/event lifecycle actually live;
this checkpoint deliberately proves the pattern somewhere smaller first),
and adopting the official `@ag-ui/core`/`@ag-ui/langgraph` packages (this is
the first point doing so would be honest — a real LLM token stream now
exists — but neither the dashboard nor the TUI render live token-level text
today, so there's no consumer for it yet).

Verified after the 029 extension: `bun test` (181 pass, including 12
harness-specific tests
covering the tool-call loop, retry-with-feedback, and fail-closed behavior
plus 11 provider/wrapper tests against fake credentials — no network calls,
no live credentials required), `bun run typecheck` (0 errors), and the compiled
binary itself — rebuilt, smoke-tested with the flag both unset and set
with invalid Gemini configuration (the latter produces a startup warning and
a zero-step task result, never a silent fallback), and confirmed during 026
to produce the exact same 4-step plan text for
`"build and deploy my bun app"` as the pre-existing keyword path. Binary
size delta for 026's original `@langchain/*` dependencies was **+2.76 MB**;
029's pinned Google adapter adds **582,656 bytes (about 0.56 MiB)**, from
146,875,392 to 147,458,048 bytes — measured, not estimated. A live Gemini run
on 2026-08-16 passed the provider, Planning-owned MCP tool-call, zero-step,
and write-approval/rejection scenarios, but exposed a downstream correctness
blocker: DevOps re-detected an already-selected `git-status` plan child as
`dockerize` because its LLM-authored description mentioned `Dockerfile`.
The approval gate prevented mutation and the child was rejected.

See specs/051-planning-retirement-and-required-key/verification.md for the relocated narrative covering this checkpoint.

See specs/028-orchestrator-langgraph-supervisor/verification.md for the relocated narrative covering this checkpoint.

See specs/041-llm-harness-documentation/verification.md for the relocated narrative covering this checkpoint.

See specs/042-llm-harness-devops/verification.md for the relocated narrative covering this checkpoint.
