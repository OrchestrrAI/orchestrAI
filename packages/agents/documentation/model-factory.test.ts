// specs/041-llm-harness-documentation/spec.md
import { describe, expect, test } from "bun:test"
import {
  isHarnessFlagSet,
  readLlmHarnessConfig,
  readLlmHarnessStartupState,
} from "./model-factory"

const FAKE_KEY = "documentation-test-only-key"

describe("Documentation LLM model-factory wrapper", () => {
  // specs/077-agent-enabled-means-llm-on-by-default/spec.md flipped the
  // default: absent/anything-but-"0" is now ON.
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
      ORCHESTRAI_DOCUMENTATION_LLM_HARNESS: "0",
      ORCHESTRAI_LLM_PROVIDER: "gemini",
      ORCHESTRAI_LLM_MODEL: "gemini-test-model",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
    }

    expect(isHarnessFlagSet(env)).toBe(false)
    expect(readLlmHarnessConfig(env)).toBeNull()
  })

  test("Planning's own harness flag does not turn Documentation's opt-out off", () => {
    const env = {
      ORCHESTRAI_DOCUMENTATION_LLM_HARNESS: "0",
      ORCHESTRAI_LLM_HARNESS: "1",
      ORCHESTRAI_LLM_PROVIDER: "gemini",
      ORCHESTRAI_LLM_MODEL: "gemini-test-model",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
    }
    expect(isHarnessFlagSet(env)).toBe(false)
    expect(readLlmHarnessConfig(env)).toBeNull()
  })

  test("delegates Gemini configuration after Documentation is explicitly opted in", () => {
    const env = {
      ORCHESTRAI_DOCUMENTATION_LLM_HARNESS: "1",
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

  test("resolves specs/039's per-component override for Documentation specifically", () => {
    const env = {
      ORCHESTRAI_DOCUMENTATION_LLM_HARNESS: "1",
      ORCHESTRAI_LLM_PROVIDER: "anthropic",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
      ORCHESTRAI_DOCUMENTATION_LLM_MODEL: "claude-haiku-4-5",
      // Deliberately present but must be ignored — this config call is
      // Documentation's own, never another component's namespace.
      ORCHESTRAI_PLANNING_LLM_MODEL: "claude-opus-5",
    }
    expect(readLlmHarnessConfig(env)?.model).toBe("claude-haiku-4-5")
  })

  test("missing Gemini model errors do not expose the API key", () => {
    let message = ""
    try {
      readLlmHarnessConfig({
        ORCHESTRAI_DOCUMENTATION_LLM_HARNESS: "1",
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
      ORCHESTRAI_DOCUMENTATION_LLM_HARNESS: "1",
      ORCHESTRAI_LLM_PROVIDER: "gemini",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
    })

    expect(state.summary).toBe("enabled but invalid (see warning above)")
    expect(state.warning).toContain("ORCHESTRAI_LLM_MODEL is required")
    expect(state.warning).not.toContain(FAKE_KEY)
  })

  test("a valid configuration's startup summary names the resolved provider, model, and source — never the key", () => {
    const state = readLlmHarnessStartupState({
      ORCHESTRAI_DOCUMENTATION_LLM_HARNESS: "1",
      ORCHESTRAI_LLM_PROVIDER: "anthropic",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
      ORCHESTRAI_DOCUMENTATION_LLM_MODEL: "claude-haiku-4-5",
    })

    expect(state.summary).toContain("enabled")
    expect(state.summary).toContain("anthropic")
    expect(state.summary).toContain("claude-haiku-4-5")
    expect(state.summary).toContain("ORCHESTRAI_DOCUMENTATION_LLM_MODEL")
    expect(state.summary).not.toContain(FAKE_KEY)
    expect(state.warning).toBeUndefined()
  })
})
