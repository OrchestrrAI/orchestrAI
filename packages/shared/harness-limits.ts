// ============================================================
// HARNESS TOOL-CALL RECURSION LIMIT RESOLUTION
// ============================================================
// specs/125-configurable-harness-recursion-limit/spec.md — every
// agent-level LLM harness's LangGraph `recursionLimit` bound, until this
// spec a bare `const HARNESS_RECURSION_LIMIT = 20` identically
// hardcoded in five separate `packages/agents/*/llm-harness.ts` files,
// now resolves through ONE shared environment variable applied
// uniformly to all of them (deliberately not a per-agent variable — the
// exploration-budget failure mode it addresses is not agent-specific).
// The shipped default is raised from 20 to 40 by this spec; setting
// ORCHESTRAI_HARNESS_RECURSION_LIMIT=20 restores the pre-125 behavior
// exactly.
//
// The resolution shape is the one packages/shared/service-ports.ts's
// resolveServicePort() (specs/073) and apps/orchestrator/
// supervisor-graph.ts's resolveSupervisorMaxDispatches() (specs/097)
// already established: the env var wins when set to a valid positive
// integer, otherwise the hardcoded default applies; never throws; a
// malformed value degrades silently to the default rather than
// disabling the bound. No upper clamp — an absurdly large value is
// accepted (the specs/097 precedent); this adds configurability, not a
// new safety ceiling.

export const HARNESS_RECURSION_LIMIT_ENV_VAR = "ORCHESTRAI_HARNESS_RECURSION_LIMIT"

export const DEFAULT_HARNESS_RECURSION_LIMIT = 40

/**
 * Resolves the shared LLM-harness tool-call recursion limit:
 * ORCHESTRAI_HARNESS_RECURSION_LIMIT when set to a valid integer >= 1,
 * otherwise the default (40). Never throws — an unset, empty, or
 * malformed value is treated identically to absent, so a harness
 * always has a real bound to feed LangGraph's `recursionLimit`.
 */
export function resolveHarnessRecursionLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HARNESS_RECURSION_LIMIT_ENV_VAR]
  if (raw === undefined || raw === "") return DEFAULT_HARNESS_RECURSION_LIMIT
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_HARNESS_RECURSION_LIMIT
  return parsed
}
