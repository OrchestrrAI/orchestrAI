// specs/082-code-review-agent/spec.md — Code Review Agent's own LLM
// harness config. Unlike DevOps/Documentation/Security's harnesses,
// this one is not an enhancement layered on a deterministic baseline —
// there is no non-LLM way to "review a diff" at all, so this harness
// fails closed (matching specs/081's write-tests precedent), never
// Security's fail-open "commentary unavailable" framing.
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

/** specs/086-code-review-coder-default-on/spec.md flipped this from
 *  opt-in (`=== "1"`) to opt-out (`!== "0"`), extending
 *  specs/077-agent-enabled-means-llm-on-by-default/spec.md's own
 *  mechanism to the two agents it had deliberately excluded — starting
 *  Code Review at all now means its harness is active unless
 *  explicitly disabled. Since review-diff has no deterministic
 *  fallback at all, this means every task fails closed with no key
 *  configured — a real, direct consequence confirmed with Yusuf before
 *  drafting this spec, not assumed. The process itself still never
 *  refuses to start over this (specs/064's own non-blocking-startup
 *  precedent); only the specific task fails, the moment one is
 *  actually attempted. */
export function isHarnessFlagSet(env: Record<string, string | undefined> = process.env): boolean {
  return env.ORCHESTRAI_CODE_REVIEW_LLM_HARNESS !== "0"
}

/**
 * Code-Review-specific wrapper: the shared parser is reached only after
 * this agent's opt-in flag has enabled the harness.
 */
export function readLlmHarnessConfig(env: Record<string, string | undefined> = process.env): LlmHarnessConfig | null {
  if (!isHarnessFlagSet(env)) return null
  return readLlmModelConfig(env, "codeReview")
}

/** Build the bounded startup message without ever rendering a credential.
 *  There is no deterministic fallback for review-diff — a misconfigured
 *  harness fails every task closed, not just an "AI commentary
 *  unavailable" line, so the wording below says so plainly. */
export function readLlmHarnessStartupState(
  env: Record<string, string | undefined> = process.env,
): LlmHarnessStartupState {
  if (!isHarnessFlagSet(env)) return { summary: "disabled (explicit opt-out — ORCHESTRAI_CODE_REVIEW_LLM_HARNESS=0) — review-diff will fail closed until re-enabled" }

  try {
    const config = readLlmHarnessConfig(env)
    if (config) return { summary: `enabled — ${describeLlmModelConfig(config)}` }
    return {
      summary: "enabled but unconfigured (see warning above)",
      warning:
        "ORCHESTRAI_CODE_REVIEW_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — " +
        "review-diff has no deterministic fallback and will fail every task closed until a valid provider API key is configured.",
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      summary: "enabled but invalid (see warning above)",
      warning:
        `invalid LLM harness configuration: ${message} ` +
        "review-diff has no deterministic fallback and will fail every task closed until the configuration is corrected.",
    }
  }
}
