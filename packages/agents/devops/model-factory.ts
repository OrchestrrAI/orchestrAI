// specs/042-llm-harness-devops/spec.md — DevOps owns only its activation
// flag. Provider parsing and construction live at the shared boundary
// (packages/shared/llm-model-factory.ts), mirroring
// packages/agents/documentation/model-factory.ts's own shape exactly —
// one component ("devops") shared by all four write skills, one flag,
// not one per skill.
import {
  buildChatModel,
  describeLlmModelConfig,
  readLlmModelConfig,
  type LlmModelConfig,
  type LlmProvider,
} from "../../shared/llm-model-factory"

export { buildChatModel, describeLlmModelConfig }
export type { LlmProvider }
export type LlmHarnessConfig = LlmModelConfig

export interface LlmHarnessStartupState {
  summary: string
  warning?: string
}

/** specs/077-agent-enabled-means-llm-on-by-default/spec.md flipped this
 *  from opt-in (`=== "1"`) to opt-out (`!== "0"`): starting DevOps at
 *  all now means its real harness is active unless explicitly disabled.
 *  True whenever the flag is absent, empty, or any value other than the
 *  literal string "0" — lets index.ts's startup path still distinguish
 *  "on by default, nothing to warn about if a key resolves" from "on
 *  (by default or explicitly) but misconfigured, warn explicitly"
 *  (specs/026's precedent: "not a silent fallback"). */
export function isHarnessFlagSet(env: Record<string, string | undefined> = process.env): boolean {
  return env.ORCHESTRAI_DEVOPS_LLM_HARNESS !== "0"
}

/** specs/094-analyze-project-security-precheck-opt-in/spec.md — a
 *  separate, deliberately independent flag from isHarnessFlagSet() above
 *  (that one gates the LLM parameter-picking harness for the four write
 *  skills; this one gates analyze-project's own automatic A2A call to
 *  Security for a secrets pre-check). Opt-in, defaults to OFF — the
 *  reverse convention from specs/077's own agent-harness flags, decided
 *  deliberately: a plain analyze-project question has no obvious
 *  relationship to "audit this codebase for leaked secrets," and the
 *  real cost of running it unconditionally (specs/090's own measured
 *  ~30s) is a disproportionate tax on the common case. `=1` restores the
 *  original always-on combined report for anyone who wants it. */
export function isAnalyzeSecretsPrecheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK === "1"
}

/**
 * DevOps-specific wrapper: the shared parser is reached only after this
 * agent's opt-in flag has enabled the harness.
 */
export function readLlmHarnessConfig(env: Record<string, string | undefined> = process.env): LlmHarnessConfig | null {
  if (!isHarnessFlagSet(env)) return null
  return readLlmModelConfig(env, "devops")
}

/** Build the bounded startup message without ever rendering a credential. */
export function readLlmHarnessStartupState(
  env: Record<string, string | undefined> = process.env,
): LlmHarnessStartupState {
  if (!isHarnessFlagSet(env)) return { summary: "disabled (explicit opt-out — ORCHESTRAI_DEVOPS_LLM_HARNESS=0)" }

  try {
    const config = readLlmHarnessConfig(env)
    if (config) return { summary: `enabled — ${describeLlmModelConfig(config)}` }
    return {
      summary: "enabled but unconfigured (see warning above)",
      warning:
        "ORCHESTRAI_DEVOPS_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — " +
        "dockerize/create-ci/create-gitignore/create-compose will fail closed until a valid provider API key is configured.",
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      summary: "enabled but invalid (see warning above)",
      warning:
        `invalid LLM harness configuration: ${message} ` +
        "dockerize/create-ci/create-gitignore/create-compose will fail closed until the configuration is corrected.",
    }
  }
}
