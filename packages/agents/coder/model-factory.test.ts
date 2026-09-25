// specs/083-coder-agent/spec.md, flipped to default-on by
// specs/086-code-review-coder-default-on/spec.md.
import { describe, expect, test } from "bun:test"
import { isHarnessFlagSet, readLlmHarnessConfig } from "./model-factory"

const FAKE_KEY = "coder-test-only-key"

describe("Coder LLM model-factory wrapper", () => {
  test("is on by default — no env var set at all", () => {
    const env = {
      ORCHESTRAI_LLM_PROVIDER: "gemini",
      ORCHESTRAI_LLM_MODEL: "gemini-test-model",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
    }
    expect(isHarnessFlagSet(env)).toBe(true)
    expect(readLlmHarnessConfig(env)).not.toBeNull()
  })

  test("explicit \"=0\" is a real, working opt-out", () => {
    const env = {
      ORCHESTRAI_CODER_LLM_HARNESS: "0",
      ORCHESTRAI_LLM_PROVIDER: "gemini",
      ORCHESTRAI_LLM_MODEL: "gemini-test-model",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
    }
    expect(isHarnessFlagSet(env)).toBe(false)
    expect(readLlmHarnessConfig(env)).toBeNull()
  })

  test("explicit \"=1\" is unaffected", () => {
    const env = {
      ORCHESTRAI_CODER_LLM_HARNESS: "1",
      ORCHESTRAI_LLM_PROVIDER: "gemini",
      ORCHESTRAI_LLM_MODEL: "gemini-test-model",
      ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
    }
    expect(isHarnessFlagSet(env)).toBe(true)
    expect(readLlmHarnessConfig(env)?.provider).toBe("gemini")
  })
})
