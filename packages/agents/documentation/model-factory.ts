// specs/041-llm-harness-documentation/spec.md — Documentation owns only
// its activation flag. Provider parsing and construction live at the
// shared boundary (packages/shared/llm-model-factory.ts) so this mirrors
// Planning Agent's own (now-deleted) model-factory.ts's shape exactly, one
// component ("documentation") shared by both generate-readme and
// document-api — one flag, not one per skill.
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
 *  from opt-in (`=== "1"`) to opt-out (`!== "0"`): starting Documentation
 *  at all now means its real harness is active unless explicitly
 *  disabled. True whenever the flag is absent, empty, or any value other
 *  than the literal string "0" — lets index.ts's startup path still
 *  distinguish "on by default, nothing to warn about if a key resolves"
 *  from "on (by default or explicitly) but misconfigured, warn
 *  explicitly" (specs/026's precedent: "not a silent fallback"). */
export function isHarnessFlagSet(env: Record<string, string | undefined> = process.env): boolean {
  return env.ORCHESTRAI_DOCUMENTATION_LLM_HARNESS !== "0"
}

/**
 * Documentation-specific wrapper: the shared parser is reached only after
 * this agent's opt-in flag has enabled the harness.
 */
export function readLlmHarnessConfig(env: Record<string, string | undefined> = process.env): LlmHarnessConfig | null {
  if (!isHarnessFlagSet(env)) return null
  return readLlmModelConfig(env, "documentation")
}

/** Build the bounded startup message without ever rendering a credential. */
export function readLlmHarnessStartupState(
  env: Record<string, string | undefined> = process.env,
): LlmHarnessStartupState {
  if (!isHarnessFlagSet(env)) return { summary: "disabled (explicit opt-out — ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=0)" }

  try {
    const config = readLlmHarnessConfig(env)
    if (config) return { summary: `enabled — ${describeLlmModelConfig(config)}` }
    return {
      summary: "enabled but unconfigured (see warning above)",
      warning:
        "ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — " +
        "generate-readme/document-api will fail closed until a valid provider API key is configured.",
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      summary: "enabled but invalid (see warning above)",
      warning:
        `invalid LLM harness configuration: ${message} ` +
        "generate-readme/document-api will fail closed until the configuration is corrected.",
    }
  }
}
