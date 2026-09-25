// specs/042-llm-harness-devops/spec.md
import { describe, expect, test } from "bun:test"
import {
  isAnalyzeSecretsPrecheckEnabled,
  isHarnessFlagSet,
  readLlmHarnessConfig,
  readLlmHarnessStartupState,
} from "./model-factory"

const FAKE_KEY = "devops-test-only-key"

describe("DevOps LLM model-factory wrapper", () => {
  // specs/077-agent-enabled-means-llm-on-by-default/spec.md flipped the
  // default: absent/anything-but-"0" is now ON, matching every other
  // opted-in-agent's own default-on behavior below.
  test("is on by default — no env var set at all", () => {
    const env = {
      ORCHESTRAI_LLM_PROVIDER: "gemini",
      ORCHESTRAI_LLM_MODEL: "gemini-test-model",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
    }

    expect(isHarnessFlagSet(env)).toBe(true)
    expect(readLlmHarnessConfig(env)).not.toBeNull()
  })

  test("explicit \"=0\" is a real, working opt-out — the shared provider parser stays unreachable", () => {
    const env = {
      ORCHESTRAI_DEVOPS_LLM_HARNESS: "0",
      ORCHESTRAI_LLM_PROVIDER: "gemini",
      ORCHESTRAI_LLM_MODEL: "gemini-test-model",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
    }

    expect(isHarnessFlagSet(env)).toBe(false)
    expect(readLlmHarnessConfig(env)).toBeNull()
  })

  test("neither Planning's nor Documentation's own harness flag turns DevOps's opt-out off", () => {
    const env = {
      ORCHESTRAI_DEVOPS_LLM_HARNESS: "0",
      ORCHESTRAI_LLM_HARNESS: "1",
      ORCHESTRAI_DOCUMENTATION_LLM_HARNESS: "1",
      ORCHESTRAI_LLM_PROVIDER: "gemini",
      ORCHESTRAI_LLM_MODEL: "gemini-test-model",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
    }
    expect(isHarnessFlagSet(env)).toBe(false)
    expect(readLlmHarnessConfig(env)).toBeNull()
  })

  test("delegates Gemini configuration after DevOps is explicitly opted in", () => {
    const env = {
      ORCHESTRAI_DEVOPS_LLM_HARNESS: "1",
      ORCHESTRAI_LLM_PROVIDER: "gemini",
      ORCHESTRAI_LLM_MODEL: "gemini-test-model",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
    }

    expect(isHarnessFlagSet(env)).toBe(true)
    expect(readLlmHarnessConfig(env)).toEqual({
      provider: "gemini",
      model: "gemini-test-model",
      apiKey: FAKE_KEY,
      sources: {
        provider: "ORCHESTRAI_LLM_PROVIDER",
        model: "ORCHESTRAI_LLM_MODEL",
        apiKey: "ORCHESTRAI_LLM_API_KEY",
      },
    })
  })

  test("resolves specs/039's per-component override for DevOps specifically", () => {
    const env = {
      ORCHESTRAI_DEVOPS_LLM_HARNESS: "1",
      ORCHESTRAI_LLM_PROVIDER: "anthropic",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
      ORCHESTRAI_DEVOPS_LLM_MODEL: "claude-haiku-4-5",
      // Deliberately present but must be ignored — this config call is
      // DevOps's own, never another component's namespace.
      ORCHESTRAI_DOCUMENTATION_LLM_MODEL: "claude-opus-5",
    }
    expect(readLlmHarnessConfig(env)?.model).toBe("claude-haiku-4-5")
  })

  test("missing Gemini model errors do not expose the API key", () => {
    let message = ""
    try {
      readLlmHarnessConfig({
        ORCHESTRAI_DEVOPS_LLM_HARNESS: "1",
        ORCHESTRAI_LLM_PROVIDER: "gemini",
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain("ORCHESTRAI_LLM_MODEL is required")
    expect(message).not.toContain(FAKE_KEY)
  })

  test("missing Gemini model startup warning is explicit and does not expose the API key", () => {
    const state = readLlmHarnessStartupState({
      ORCHESTRAI_DEVOPS_LLM_HARNESS: "1",
      ORCHESTRAI_LLM_PROVIDER: "gemini",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
    })

    expect(state.summary).toBe("enabled but invalid (see warning above)")
    expect(state.warning).toContain("ORCHESTRAI_LLM_MODEL is required")
    expect(state.warning).not.toContain(FAKE_KEY)
  })

  test("a valid configuration's startup summary names the resolved provider, model, and source — never the key", () => {
    const state = readLlmHarnessStartupState({
      ORCHESTRAI_DEVOPS_LLM_HARNESS: "1",
      ORCHESTRAI_LLM_PROVIDER: "anthropic",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
      ORCHESTRAI_DEVOPS_LLM_MODEL: "claude-haiku-4-5",
    })

    expect(state.summary).toContain("enabled")
    expect(state.summary).toContain("anthropic")
    expect(state.summary).toContain("claude-haiku-4-5")
    expect(state.summary).toContain("ORCHESTRAI_DEVOPS_LLM_MODEL")
    expect(state.summary).not.toContain(FAKE_KEY)
    expect(state.warning).toBeUndefined()
  })
})

// specs/094-analyze-project-security-precheck-opt-in/spec.md — a
// deliberately separate, independent flag from ORCHESTRAI_DEVOPS_LLM_HARNESS
// above: opt-in, defaults to OFF (the reverse convention from specs/077's
// own agent-harness flags, decided deliberately for this specific call).
describe("isAnalyzeSecretsPrecheckEnabled — opt-in, defaults to OFF", () => {
  test("is off by default — no env var set at all", () => {
    expect(isAnalyzeSecretsPrecheckEnabled({})).toBe(false)
  })

  test("explicit \"=1\" turns it on", () => {
    expect(isAnalyzeSecretsPrecheckEnabled({ ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK: "1" })).toBe(true)
  })

  test("any value other than the literal \"1\" stays off", () => {
    expect(isAnalyzeSecretsPrecheckEnabled({ ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK: "true" })).toBe(false)
    expect(isAnalyzeSecretsPrecheckEnabled({ ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK: "yes" })).toBe(false)
    expect(isAnalyzeSecretsPrecheckEnabled({ ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK: "0" })).toBe(false)
  })

  test("independent from the LLM harness flag — neither influences the other", () => {
    expect(isAnalyzeSecretsPrecheckEnabled({ ORCHESTRAI_DEVOPS_LLM_HARNESS: "0" })).toBe(false)
    expect(isHarnessFlagSet({ ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK: "1" })).toBe(true)
  })
})
