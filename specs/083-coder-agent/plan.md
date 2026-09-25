# Plan — 083 Coder Agent

Registration touchpoints, mirroring `specs/082`'s own list exactly —
`code-review-agent` is the direct precedent for every mechanical entry
below; only the last section (the harness/skill logic itself) is
genuinely new work.

## Registration touchpoints

| File | Change |
|---|---|
| `packages/shared/service-ports.ts` | `coder: "ORCHESTRAI_CODER_PORT"` in `SERVICE_PORT_ENV_VARS`; `coder: 3008` in `DEFAULT_SERVICE_PORTS` |
| `packages/shared/agent-registry.ts` | `coder: process.env.ORCHESTRAI_CODER_URL ?? \`http://localhost:${resolveServicePort("coder")}\`` |
| `apps/orchestrator/index.ts` | `agentRegistry.coder` added to `KNOWN_AGENTS` — the entire routing change, per `082`'s own confirmed precedent (`findAgentForSkill()`/`buildCapabilitySnapshot()` iterate the live registry generically) |
| `apps/supervisor/index.ts` | `"coder-agent"` added to `SERVICE_STARTERS`; a matching `ServiceDef` entry in `AGENTS` (`portKey: "coder"`, `dependsOnMcp: true`) |
| `apps/supervisor/agent-catalog.ts` | `{ name: "coder-agent", skillIds: ["edit-file"] }` + its own drift test updated |
| `apps/orchestrator/supervisor-graph.ts` | `"edit-file": "write-capable"` in `SKILL_TIER_REGISTRY`; `"edit-file"` in `SUPERVISOR_ALLOWED_SKILLS` |
| Root `package.json` | `"coder-agent": "bun run packages/agents/coder/index.ts"` script; added into `dev`/`dev:with-mcp`/`dev:with-all-mcp`'s `--parallel` strings |
| `docker-compose.yml` | New `coder-agent` service block, mirroring `code-review-agent`'s own shape exactly (MCP-client env, no volume mount, `depends_on: mcp-http: condition: service_healthy`, port `3008:3008`); `ORCHESTRAI_CODER_URL` added to `orchestrator`'s environment + matching `depends_on` |
| `packages/shared/llm-model-factory.ts` | `"coder"` added to `LLM_COMPONENTS` |
| `apps/supervisor/init-wizard.ts` | `{ agent: "coder-agent", component: "coder", field: "coderLlm", envVar: "ORCHESTRAI_CODER_LLM_HARNESS", label: "Coder LLM" }` in `AGENT_LLM_HARNESSES` |
| `apps/supervisor/init-form.tsx` | `coder: "coder-agent"` in `PORT_ROW_LABELS` — expect this (or an equivalent gap) to only surface via `tsc`'s own exhaustiveness check, the same way it did for `082`; treat that as the mechanism working as intended, not a surprise to route around. |
| `apps/supervisor/init-form-state.test.ts` | Pre-existing tests updated for a 6th agent joining shared tables (the `AGENTS` fixture array, `modelsRows()`, `agentLlmFieldsFor()`, `formStateToWizardConfig()` expectations) — the same class of update `082`'s own addition required. |

## New files

- `packages/agents/coder/index.ts` — the Hono app, Agent Card, skill
  detection (`detectSkill()` matching phrasing like `"edit"`, `"change"`,
  `"modify"` + a file-path/code-change hint — narrow, mirroring
  `code-review-agent`'s own `detectSkill()` shape), `handleEditFileSkill()`.
- `packages/agents/coder/model-factory.ts` — `isHarnessFlagSet()` reading
  `ORCHESTRAI_CODER_LLM_HARNESS`, fail-closed wording (matching
  `write-tests`/`review-diff`, not Security's fail-open).
- `packages/agents/coder/llm-harness.ts` — `runEditFileHarness()`,
  `EditProposalSchema`, the grounding validator, `buildReadOnlyTools()`
  binding only `read_project_file`.
- `packages/agents/coder/package.json` — mirrors `code-review-agent`'s
  own dependency set (`@modelcontextprotocol/sdk`, `hono`,
  `@langchain/core`, `@langchain/langgraph`, `zod`).
- `packages/agents/coder/llm-harness.test.ts` — grounding/retry/fail-
  closed unit coverage, `ScriptedChatModel`/`MockMcpToolCaller` pair
  mirroring `packages/agents/code-review/llm-harness.test.ts`. Watch
  directly for the `082` AIMessage-identity test-double pitfall
  (`specs/082`'s own verification.md documents it in full) — construct a
  fresh message object per scripted retry attempt, never reuse one.
- `packages/agents/coder/index.test.ts` — Agent Card, no-approval-routes-
  do-NOT-exist is **wrong here** (unlike `code-review-agent`, this skill
  IS write-capable and DOES need approve/reject routes) — mirror
  DevOps's/Testing's own approval-route test shape instead.

## Verification sequencing

1. Unit tests first (grounding validator, harness retry/fail-closed) —
   no live MCP/provider needed.
2. HTTP-level tests against the real, unmodified app (`app.fetch()`, no
   port bind) — fail-closed preconditions, approval-preview shape.
3. `bun run typecheck` as the structural backstop for registration
   completeness.
4. Live pass: real `mcp:http` + real `coder-agent` (harness on, real
   key) against a real scratch project — the full happy path, the not-
   found/ambiguous-anchor retries, the drift-refusal, and the router-
   naming scenario through the real Orchestrator with other agents
   isolated behind unreachable stub ports (the same isolation technique
   `082`'s own live pass used).
