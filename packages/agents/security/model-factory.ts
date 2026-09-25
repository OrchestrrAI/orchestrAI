// specs/043-llm-harness-security/spec.md — Security owns only its
// activation flag. Provider parsing and construction live at the shared
// boundary (packages/shared/llm-model-factory.ts), mirroring
// packages/agents/devops/model-factory.ts's own shape exactly — one
// component ("security") shared by all three read-only skills' enrichment
// layer, one flag, not one per skill.
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
 *  from opt-in (`=== "1"`) to opt-out (`!== "0"`): starting Security at
 *  all now means its real commentary harness is active unless explicitly
 *  disabled. True whenever the flag is absent, empty, or any value other
 *  than the literal string "0" — lets index.ts's startup path still
 *  distinguish "on by default, nothing to warn about if a key resolves"
 *  from "on (by default or explicitly) but misconfigured, warn
 *  explicitly" (specs/026's precedent: "not a silent fallback"). This
 *  flag is completely independent of isExternalDataFlagSet() below
 *  (specs/084) — that one stays genuinely opt-in, untouched by this
 *  spec: real network access is a different risk class than LLM
 *  commentary, deliberately not defaulted on. */
export function isHarnessFlagSet(env: Record<string, string | undefined> = process.env): boolean {
  return env.ORCHESTRAI_SECURITY_LLM_HARNESS !== "0"
}

/** specs/084-security-external-vulnerability-data/spec.md — a second,
 *  INDEPENDENT opt-in flag: real external vulnerability data (OSV.dev),
 *  not LLM commentary. Either, both, or neither of this and
 *  isHarnessFlagSet() may be on; no shared state between them. */
export function isExternalDataFlagSet(env: Record<string, string | undefined> = process.env): boolean {
  return env.ORCHESTRAI_SECURITY_EXTERNAL_DATA === "1"
}

/**
 * Security-specific wrapper: the shared parser is reached only after this
 * agent's opt-in flag has enabled the harness.
 */
export function readLlmHarnessConfig(env: Record<string, string | undefined> = process.env): LlmHarnessConfig | null {
  if (!isHarnessFlagSet(env)) return null
  return readLlmModelConfig(env, "security")
}

/** Build the bounded startup message without ever rendering a credential.
 *  Deliberately worded to describe *commentary*, not a task-fail risk —
 *  unlike DevOps/Documentation, a misconfiguration here never fails a
 *  task; it only means the "AI commentary unavailable" line will appear
 *  in each report instead of enrichment (see spec's Fail-open-on-report,
 *  fail-closed-on-claim section). */
export function readLlmHarnessStartupState(
  env: Record<string, string | undefined> = process.env,
): LlmHarnessStartupState {
  if (!isHarnessFlagSet(env)) return { summary: "disabled (explicit opt-out — ORCHESTRAI_SECURITY_LLM_HARNESS=0)" }

  try {
    const config = readLlmHarnessConfig(env)
    if (config) return { summary: `enabled — ${describeLlmModelConfig(config)}` }
    return {
      summary: "enabled but unconfigured (see warning above)",
      warning:
        "ORCHESTRAI_SECURITY_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — " +
        "scan-secrets/check-gitignore-coverage/audit-dependencies will still complete with their " +
        "deterministic findings, but each report's AI commentary section will read " +
        '"AI commentary unavailable" until a valid provider API key is configured.',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      summary: "enabled but invalid (see warning above)",
      warning:
        `invalid LLM harness configuration: ${message} ` +
        "scan-secrets/check-gitignore-coverage/audit-dependencies will still complete with their " +
        'deterministic findings, but each report\'s AI commentary section will read "AI commentary ' +
        'unavailable" until the configuration is corrected.',
    }
  }
}
