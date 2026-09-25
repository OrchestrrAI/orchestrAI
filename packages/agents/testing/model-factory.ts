// specs/080-run-command-approved-execution/spec.md — Testing Agent's own
// first LLM harness, mirroring DevOps/Documentation/Security's own
// model-factory.ts shape exactly. Testing owns only its activation flag;
// provider parsing and construction live at the shared boundary
// (packages/shared/llm-model-factory.ts). Originally scoped only to
// letting run-tests/check-coverage propose a real command for a stack
// detectRunner() has no fixed RUNNER_ARGV entry for; as of
// specs/081-testing-write-tests-skill/spec.md (Phase C) the same flag
// also gates the write-tests skill's own test-authoring harness call —
// both fail closed identically on a missing/invalid key.
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
 *  from opt-in (`=== "1"`) to opt-out (`!== "0"`), added to that spec's
 *  own scope mid-implementation once it was found Testing already had a
 *  harness (this file, via specs/080) despite the spec's own drafting-
 *  time claim otherwise — starting Testing at all now means its harness
 *  is active unless explicitly disabled. True whenever the flag is
 *  absent, empty, or any value other than the literal string "0" — lets
 *  index.ts's startup path still distinguish "on by default, nothing to
 *  warn about if a key resolves" from "on (by default or explicitly)
 *  but misconfigured, warn explicitly" (specs/026's precedent: "not a
 *  silent fallback"). */
export function isHarnessFlagSet(env: Record<string, string | undefined> = process.env): boolean {
  return env.ORCHESTRAI_TESTING_LLM_HARNESS !== "0"
}

/**
 * Testing-specific wrapper: the shared parser is reached only after
 * this agent's opt-in flag has enabled the harness.
 */
export function readLlmHarnessConfig(env: Record<string, string | undefined> = process.env): LlmHarnessConfig | null {
  if (!isHarnessFlagSet(env)) return null
  return readLlmModelConfig(env, "testing")
}

/** Build the bounded startup message without ever rendering a credential. */
export function readLlmHarnessStartupState(
  env: Record<string, string | undefined> = process.env,
): LlmHarnessStartupState {
  if (!isHarnessFlagSet(env)) return { summary: "disabled (explicit opt-out — ORCHESTRAI_TESTING_LLM_HARNESS=0)" }

  try {
    const config = readLlmHarnessConfig(env)
    if (config) return { summary: `enabled — ${describeLlmModelConfig(config)}` }
    return {
      summary: "enabled but unconfigured (see warning above)",
      warning:
        "ORCHESTRAI_TESTING_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — " +
        "the run-command fallback for an unsupported stack, and the write-tests skill, will both fail closed until a valid provider API key is configured.",
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      summary: "enabled but invalid (see warning above)",
      warning:
        `invalid LLM harness configuration: ${message} ` +
        "the run-command fallback for an unsupported stack, and the write-tests skill, will both fail closed until the configuration is corrected.",
    }
  }
}
