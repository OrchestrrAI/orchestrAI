---
id: 029-shared-llm-provider-gemini
title: Shared LLM Provider Factory and Gemini Support
area: llm-harness
change_type: enhancement
status: implemented
verification: verified
created: 2026-08-16
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-16
implemented_on: 2026-08-16
amends:
  - 026-llm-harness-langgraph-planning
supersedes: []
superseded_by: []
related:
  - 028-orchestrator-langgraph-supervisor
---

# Spec: Shared LLM Provider Factory and Gemini Support

> Review gate: **IMPLEMENTED AND VERIFIED on 2026-08-20.**
>
> Yusuf approved this checkpoint on 2026-08-16. The scoped implementation
> and automated verification were complete immediately; the remaining live
> provider run — through `specs/030`'s dynamic capability catalog — closed
> it out on 2026-08-20. No exposed credential was used or logged at any
> point.

## Purpose

Extract the existing Anthropic/OpenAI model construction from the Planning
Agent into one shared OrchestrAI LLM-provider factory, then add Google Gemini
as its third provider. Planning consumes that shared factory immediately;
`specs/028-orchestrator-langgraph-supervisor/spec.md` can reuse it later
without creating a second provider/configuration implementation.

This removes the current live-verification blocker for a user who has a
Google AI Studio API key but no Anthropic or OpenAI API key, while preserving
026's existing LangGraph tool-calling loop, MCP tool boundary, output
validation, and fail-closed behavior. Shared infrastructure does **not** mean
shared activation: this checkpoint enables the LLM path only in Planning.
DevOps, Testing, Documentation, Security, and the Orchestrator gain no new
runtime LLM call path from this checkpoint.

The shared factory uses LangChain's current Google adapter,
`@langchain/google` and its `ChatGoogle` model, because the existing harness
is built against LangChain's `BaseChatModel`/`bindTools()` contract. It does
not replace LangGraph with Google's direct SDK and does not build a custom
provider adapter.

## Verified Current State

- `packages/agents/planning/model-factory.ts` accepts only `anthropic` and
  `openai`. Any other `ORCHESTRAI_LLM_PROVIDER` value throws before a model
  is constructed.
- Provider selection, environment parsing, and concrete model construction
  currently live together in Planning's `model-factory.ts`, even though the
  provider concern is not inherently Planning-specific. 028 would otherwise
  need to import an agent-owned module or duplicate it.
- The factory returns LangChain's generic `BaseChatModel`; the graph in
  `packages/agents/planning/llm-harness.ts` calls `bindTools()` and `invoke()`
  without knowing the concrete provider. Provider selection is already
  isolated to `model-factory.ts`.
- The graph binds exactly two standard LangChain tools, `git_status` and
  `analyze_project`, backed by read-only MCP calls. No provider-native tools
  or write-capable MCP tools are reachable from the graph.
- `ORCHESTRAI_LLM_API_KEY` is the existing provider-neutral credential
  input. `ORCHESTRAI_LLM_MODEL` is optional today because Anthropic and
  OpenAI have defaults in `DEFAULT_MODEL`.
- 026 is implemented with `verification: partial`. Automated tests,
  typecheck, compiled-binary checks, and default-path compatibility passed;
  its required live provider/API verification is still open.
- LangChain's current JavaScript documentation identifies `ChatGoogle` in
  `@langchain/google` as the Google AI/Vertex AI chat integration and shows
  support for standard LangChain tool calling through `bindTools()`:
  <https://docs.langchain.com/oss/javascript/integrations/chat/google>.
- The older `@langchain/google-genai` integration is documented as pending
  deprecation in favor of the current `ChatGoogle` integration. It must not
  be introduced by this checkpoint:
  <https://docs.langchain.com/oss/javascript/integrations/chat/google_generative_ai>.
- Google's official direct JavaScript SDK is `@google/genai`, which Google
  recommends for applications calling Gemini directly:
  <https://ai.google.dev/gemini-api/docs/libraries>. It does not by itself
  implement the LangChain `BaseChatModel` contract used by 026, so adopting
  it directly here would require a custom translation layer for messages,
  tool calls, results, and retries.

## Proposed Behavior

1. Create `packages/shared/llm-model-factory.ts` as the single provider
   boundary. It owns `LlmProvider` (`anthropic | openai | gemini`), the
   provider-neutral model configuration, strict environment parsing, and
   concrete model construction returning `BaseChatModel`.
2. Keep feature activation outside the shared factory. Planning continues to
   own `ORCHESTRAI_LLM_HARNESS`; its local configuration wrapper checks that
   flag and delegates provider parsing/construction to the shared factory.
   The shared module must never initiate a model call merely because it is
   imported.
3. Move the existing Anthropic/OpenAI construction behavior into the shared
   factory without changing provider defaults, public environment variable
   names, or fail-closed behavior.
4. Add `gemini` to the accepted provider values.
5. Add an exactly pinned `@langchain/google` dependency. Import
   `ChatGoogle` dynamically from its Node-compatible entrypoint only when
   `ORCHESTRAI_LLM_PROVIDER=gemini`; machines using the default deterministic
   path or another provider do not evaluate the adapter module at runtime.
6. Construct `ChatGoogle` with the existing provider-neutral
   `ORCHESTRAI_LLM_API_KEY`, passed explicitly as `apiKey`. Do not copy it to
   `GOOGLE_API_KEY`, `GEMINI_API_KEY`, a file, a log, an event, or global
   process configuration.
7. Require `ORCHESTRAI_LLM_MODEL` when `ORCHESTRAI_LLM_PROVIDER=gemini`.
   This checkpoint does not guess or silently track a moving Google model
   alias. Missing Gemini model configuration must produce a clear startup
   warning/error and fail closed to zero plan steps, never fall back to
   Anthropic, OpenAI, or the keyword planner.
8. Return every adapter through the same `BaseChatModel` boundary. Planning
   uses it now; 028 may import it only after 028 is separately approved and
   implemented. No operational agent is wired to it in this checkpoint. The
   graph, prompt, skill allow-list, retry rules, MCP client, and final plan
   validator remain unchanged.
9. Use only standard LangChain tool calling for the existing two read-only
   MCP-backed tools. Do not bind Gemini specialty tools such as Google
   Search, URL Context, or Code Execution.
10. Preserve existing behavior for `anthropic`, `openai`, an unset harness
   flag, missing credentials, and unknown provider values.
11. After implementation, use a replacement, non-exposed Google AI Studio
   API key to perform 026's remaining live verification. If all required
   scenarios pass, record sanitized evidence and move 026 from
   `verification: partial` to `verification: verified`.

## Scope

- `packages/shared/llm-model-factory.ts` (new) — shared provider types,
  provider-neutral configuration parsing, and dynamic Anthropic/OpenAI/
  Gemini construction.
- `packages/shared/llm-model-factory.test.ts` (new) — shared configuration
  and provider-construction tests without network calls or real credentials.
- `packages/agents/planning/model-factory.ts` — retain Planning's harness
  activation check as a thin wrapper and delegate provider concerns to the
  shared factory; no change to which Planning skills use the harness.
- `package.json`, `packages/agents/planning/package.json`, and `bun.lock` —
  relocate provider dependency ownership as required by the shared module
  and add an exactly pinned `@langchain/google` dependency.
- `packages/shared/package.json` — declare the provider dependencies owned by
  the new shared module. Planning retains only dependencies it imports
  directly after the move.
- `specs/026-llm-harness-langgraph-planning/verification.md` and 026's
  verification metadata — only after the live Gemini evidence passes.
- `CLAUDE.md`, `README.md`, and `context/worklog.md` — document implemented
  Gemini configuration and verified behavior only after implementation and
  proportional verification.

## Safety and Compatibility Constraints

- **No credential from chat, source control, target-project files, logs, or
  screenshots may be used.** Live verification requires a newly issued,
  non-exposed Google AI Studio API key entered only in the user's terminal.
  Any credential previously exposed outside approved secret handling must
  be revoked before verification.
- **No secret persistence.** The API key remains process-local and must not
  appear in exceptions, startup summaries, audit events, AG-UI events,
  verification evidence, or generated documentation. Tests must use an
  obvious fake value and assert it is not rendered by configuration errors.
- **No provider fallback.** Gemini configuration or API failure returns the
  existing fail-closed zero-step outcome. It never silently selects another
  provider or the deterministic keyword planner while the harness flag is
  enabled.
- **The graph's privilege boundary is unchanged.** Only `git_status` and
  `analyze_project` remain bound; no Google-native tool and no write-capable
  MCP tool is added.
- **The approval boundary is unchanged.** A write-capable skill appearing
  in the final validated plan still goes through the existing deterministic,
  `actionId`-bound agent approval flow before execution.
- **No network calls in automated tests.** Provider configuration and model
  construction tests must not invoke Gemini. The only real API call belongs
  to the explicitly manual live verification.
- **Unknown/unsupported provider values still fail explicitly.** Extending
  the allow-list with `gemini` must not make provider validation permissive.
- **Bun compatibility is proven, not assumed.** Typecheck, unit tests, and
  the compiled binary must succeed with the pinned adapter present. Record
  the exact binary-size delta.
- **Shared does not mean implicitly active.** Importing the shared factory
  performs no network request and enables no agent. Each caller requires its
  own separately approved feature flag and runtime wiring. In this
  checkpoint, Planning is the only caller.
- **One implementation, not a new duplicate.** Planning must delegate to the
  shared provider factory; leaving a second concrete provider switch inside
  Planning fails this checkpoint.

## Out of Scope / Non-Goals

- Replacing LangGraph or its `ToolNode` loop with the direct Google
  `@google/genai` SDK.
- Adding `@langchain/google-genai`, the legacy Google
  `@google/generative-ai` SDK, or direct application imports from
  `@google/genai`.
- Building or maintaining a custom `BaseChatModel` adapter.
- Vertex AI, service-account credentials, Application Default Credentials,
  OAuth tokens, Vertex AI Express Mode, or Google Cloud project setup. This
  checkpoint supports Google AI Studio/Gemini Developer API key auth only.
- Google Search, URL Context, Code Execution, grounding, multimodal input,
  image/audio/video generation, or any other Gemini-native tool/capability.
- Changing the Planning graph, its prompt, retry count, plan format, skill
  allow-list, MCP tools, or approval behavior.
- Changing the Orchestrator, adopting AG-UI packages, or implementing
  `specs/027` or `specs/028`.
- Activating an LLM in the Orchestrator, DevOps, Testing, Documentation, or
  Security. 028 may reuse the shared factory only after its own approval.
- Making the LLM harness the default path or adding Gemini to any agent
  other than Planning.
- Committing or documenting any real credential value.

## Acceptance Criteria

- [x] Yusuf explicitly approves this spec before implementation.
- [x] Planning's concrete Anthropic/OpenAI provider switch is replaced by
      delegation to one shared provider factory; no duplicate concrete
      provider-construction path remains.
- [x] Importing the shared provider module alone makes no network call and
      does not activate any LLM path.
- [x] `ORCHESTRAI_LLM_PROVIDER=gemini` is accepted only when the harness is
      enabled, a non-empty API key exists, and an explicit Gemini model is
      configured.
- [x] With Gemini selected, the provider factory dynamically constructs a
      `ChatGoogle` instance compatible with the harness's `BaseChatModel`
      and `bindTools()` contract without making a network call during
      construction.
- [x] Focused tests cover Gemini success configuration, missing model,
      missing credential, unknown provider, and unchanged Anthropic/OpenAI
      configuration behavior using fake credentials only.
- [x] A focused test proves configuration errors and startup messages do
      not contain the fake API key.
- [x] Existing harness tests still prove only `git_status` and
      `analyze_project` are bound, invalid plans fail closed, and write
      skills remain reachable only as validated plan text handled by the
      downstream approval gate.
- [x] `bun test`, `bun run typecheck`, and `bun run specs:check` pass with no
      live credential and no network access.
- [x] `bun run build` succeeds and the binary-size delta from adding the
      pinned Google adapter is recorded.
- [ ] A manual live run with a replacement Google AI Studio API key proves
      all remaining 026 scenarios: a real read-only MCP tool call influences
      a valid plan; an out-of-scope request yields zero executable steps;
      and a plan containing a write-capable skill stops at the real
      `actionId`-bound approval gate with no write before approval.
- [ ] Raw event/audit evidence from the live run is captured in sanitized
      form with no credential or target-project secret content.
- [ ] After the live scenarios pass, 026's verification evidence is updated
      and its metadata becomes `verification: verified`.
- [x] `CLAUDE.md`, `README.md`, and `context/worklog.md` describe only the
      implemented and actually verified behavior.

## Verification Plan

- **Automated configuration tests:** exercise the shared provider parser for
  Gemini and existing providers using injected fake environment objects;
  verify Planning's wrapper still owns the harness activation flag; exercise
  provider construction without calling `invoke()`; assert secret
  non-disclosure and exact failure behavior.
- **Existing regression suite:** run `bun test`, `bun run typecheck`, and
  `bun run specs:check` with no LLM variables set. No test may depend on a
  live model or MCP server.
- **Build verification:** run `bun run build`, smoke-test the Planning Agent
  with the harness flag unset and with Gemini selected but intentionally
  unconfigured, and record the binary-size delta.
- **Manual live verification:** start MCP HTTP, Planning, the operational
  agents, and the Orchestrator with Gemini selected and a replacement key
  set only in the terminal. Execute the three scenarios in Acceptance
  Criteria, preserve bounded/sanitized AG-UI and audit evidence, and verify
  the write scenario does not execute before the user makes an explicit
  approval decision.

## Approval Requested

Approval authorizes extracting Planning's concrete provider construction to
one shared, inert-until-called LLM provider factory; adding the exactly pinned
`@langchain/google` adapter and `gemini` provider there; making Planning
delegate to the shared factory; adding focused provider/configuration tests;
documenting the implemented configuration; and using Gemini to complete
026's already-required live verification.

Approval does not authorize using any exposed credential, adopting Google's
direct SDK, changing the LangGraph workflow or its tool boundary, adding
Gemini-native tools, activating the factory in another agent or the
Orchestrator, implementing 027/028, or making any LLM path the default.
