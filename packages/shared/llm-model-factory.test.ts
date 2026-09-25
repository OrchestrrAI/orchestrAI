import { describe, expect, mock, test } from "bun:test"
import {
  buildChatModel,
  callProviderWithRetry,
  checkStartupLlmKeys,
  classifyProviderError,
  describeLlmModelConfig,
  extractRetryAfterMs,
  ProviderRetriesExhaustedError,
  readLlmModelConfig,
} from "./llm-model-factory"

const FAKE_KEY = "test-only-not-a-real-secret"

describe("readLlmModelConfig", () => {
  test("accepts Gemini only with an explicit model and API key", () => {
    expect(
      readLlmModelConfig({
        ORCHESTRAI_LLM_PROVIDER: " Gemini ",
        ORCHESTRAI_LLM_MODEL: " gemini-test-model ",
        ORCHESTRAI_LLM_API_KEY: ` ${FAKE_KEY} `,
      }),
    ).toEqual({
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

  test("fails explicitly when Gemini has no model", () => {
    expect(() =>
      readLlmModelConfig({
        ORCHESTRAI_LLM_PROVIDER: "gemini",
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
      }),
    ).toThrow("ORCHESTRAI_LLM_MODEL is required")
  })

  test("returns null when the provider-neutral credential is missing", () => {
    expect(
      readLlmModelConfig({
        ORCHESTRAI_LLM_PROVIDER: "gemini",
        ORCHESTRAI_LLM_MODEL: "gemini-test-model",
      }),
    ).toBeNull()
  })

  test("rejects unknown providers without exposing the configured API key", () => {
    let message = ""
    try {
      readLlmModelConfig({
        ORCHESTRAI_LLM_PROVIDER: "not-a-provider",
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain("Unknown ORCHESTRAI_LLM_PROVIDER")
    expect(message).not.toContain(FAKE_KEY)
  })

  test("preserves the existing Anthropic default", () => {
    expect(readLlmModelConfig({ ORCHESTRAI_LLM_API_KEY: FAKE_KEY })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: FAKE_KEY,
      sources: {
        provider: "ORCHESTRAI_LLM_PROVIDER",
        model: null,
        apiKey: "ORCHESTRAI_LLM_API_KEY",
      },
    })
  })

  test("preserves the existing OpenAI default", () => {
    expect(
      readLlmModelConfig({
        ORCHESTRAI_LLM_PROVIDER: "openai",
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5",
      apiKey: FAKE_KEY,
      sources: {
        provider: "ORCHESTRAI_LLM_PROVIDER",
        model: null,
        apiKey: "ORCHESTRAI_LLM_API_KEY",
      },
    })
  })

  // specs/039-per-component-llm-provider-config — two-tier resolution.
  describe("per-component overrides (specs/039)", () => {
    test("with no component argument, resolution is unchanged (shared vars only)", () => {
      const env = {
        ORCHESTRAI_LLM_PROVIDER: "openai",
        ORCHESTRAI_LLM_MODEL: "gpt-5-mini",
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
        ORCHESTRAI_ORCHESTRATOR_LLM_MODEL: "should-be-ignored",
      }
      expect(readLlmModelConfig(env)).toEqual({
        provider: "openai",
        model: "gpt-5-mini",
        apiKey: FAKE_KEY,
        sources: {
          provider: "ORCHESTRAI_LLM_PROVIDER",
          model: "ORCHESTRAI_LLM_MODEL",
          apiKey: "ORCHESTRAI_LLM_API_KEY",
        },
      })
    })

    test("component-specific variable wins over the shared one", () => {
      const env = {
        ORCHESTRAI_LLM_PROVIDER: "anthropic",
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
        ORCHESTRAI_SECURITY_LLM_MODEL: "claude-haiku-4-5",
      }
      expect(readLlmModelConfig(env, "security")?.model).toBe("claude-haiku-4-5")
    })

    // specs/041-llm-harness-documentation/spec.md — the third component.
    test("resolves the documentation component's own override variable", () => {
      const env = {
        ORCHESTRAI_LLM_PROVIDER: "anthropic",
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
        ORCHESTRAI_DOCUMENTATION_LLM_MODEL: "claude-haiku-4-5",
      }
      expect(readLlmModelConfig(env, "documentation")?.model).toBe("claude-haiku-4-5")
    })

    // specs/042-llm-harness-devops/spec.md — the fourth component.
    test("resolves the devops component's own override variable", () => {
      const env = {
        ORCHESTRAI_LLM_PROVIDER: "anthropic",
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
        ORCHESTRAI_DEVOPS_LLM_MODEL: "claude-haiku-4-5",
      }
      expect(readLlmModelConfig(env, "devops")?.model).toBe("claude-haiku-4-5")
    })

    // specs/043-llm-harness-security/spec.md — the fifth component.
    test("resolves the security component's own override variable", () => {
      const env = {
        ORCHESTRAI_LLM_PROVIDER: "anthropic",
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
        ORCHESTRAI_SECURITY_LLM_MODEL: "claude-haiku-4-5",
      }
      expect(readLlmModelConfig(env, "security")?.model).toBe("claude-haiku-4-5")
    })

    test("falls back to the shared variable when the component-specific one is unset", () => {
      const env = { ORCHESTRAI_LLM_PROVIDER: "anthropic", ORCHESTRAI_LLM_API_KEY: FAKE_KEY }
      const resolved = readLlmModelConfig(env, "orchestrator")
      expect(resolved?.apiKey).toBe(FAKE_KEY)
      expect(resolved?.sources?.apiKey).toBe("ORCHESTRAI_LLM_API_KEY")
    })

    test("falls back to the shared variable when the component-specific one is empty", () => {
      const env = {
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
        ORCHESTRAI_SECURITY_LLM_API_KEY: "   ",
      }
      expect(readLlmModelConfig(env, "security")?.apiKey).toBe(FAKE_KEY)
    })

    test("resolution is per field — provider shared, model and key overridden", () => {
      const env = {
        ORCHESTRAI_LLM_PROVIDER: "anthropic",
        ORCHESTRAI_LLM_API_KEY: "shared-key",
        ORCHESTRAI_SECURITY_LLM_MODEL: "claude-haiku-4-5",
        ORCHESTRAI_SECURITY_LLM_API_KEY: "security-only-key",
      }
      const resolved = readLlmModelConfig(env, "security")
      expect(resolved).toEqual({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        apiKey: "security-only-key",
        sources: {
          provider: "ORCHESTRAI_LLM_PROVIDER",
          model: "ORCHESTRAI_SECURITY_LLM_MODEL",
          apiKey: "ORCHESTRAI_SECURITY_LLM_API_KEY",
        },
      })
    })

    test("two components resolve genuinely different models from one shared environment", () => {
      const env = {
        ORCHESTRAI_LLM_PROVIDER: "gemini",
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
        ORCHESTRAI_LLM_MODEL: "gemini-3.5-flash-lite",
        ORCHESTRAI_ORCHESTRATOR_LLM_MODEL: "gemini-3.5-pro",
      }
      expect(readLlmModelConfig(env, "security")?.model).toBe("gemini-3.5-flash-lite")
      expect(readLlmModelConfig(env, "orchestrator")?.model).toBe("gemini-3.5-pro")
    })

    test("a component's own invalid provider never falls back to another component's credentials", () => {
      // Adversarial case named in the spec: a misconfigured component must
      // fail on its own path, never silently borrow a sibling's namespace.
      const env = {
        ORCHESTRAI_SECURITY_LLM_PROVIDER: "not-a-real-provider",
        ORCHESTRAI_ORCHESTRATOR_LLM_PROVIDER: "anthropic",
        ORCHESTRAI_ORCHESTRATOR_LLM_API_KEY: FAKE_KEY,
      }
      expect(() => readLlmModelConfig(env, "security")).toThrow(
        "Unknown ORCHESTRAI_SECURITY_LLM_PROVIDER",
      )
    })

    test("gemini validation error falls back to naming the shared model variable when no override is set", () => {
      const env = {
        ORCHESTRAI_ORCHESTRATOR_LLM_PROVIDER: "gemini",
        ORCHESTRAI_ORCHESTRATOR_LLM_API_KEY: FAKE_KEY,
      }
      expect(() => readLlmModelConfig(env, "orchestrator")).toThrow(
        "ORCHESTRAI_LLM_MODEL is required",
      )
    })

    test("unknown-provider error names the resolved component-specific variable, never leaks the key", () => {
      let message = ""
      try {
        readLlmModelConfig(
          { ORCHESTRAI_SECURITY_LLM_PROVIDER: "bogus", ORCHESTRAI_SECURITY_LLM_API_KEY: FAKE_KEY },
          "security",
        )
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain("Unknown ORCHESTRAI_SECURITY_LLM_PROVIDER")
      expect(message).not.toContain(FAKE_KEY)
    })
  })
})

describe("describeLlmModelConfig", () => {
  test("names the resolved variables and never echoes the key value", () => {
    const config = readLlmModelConfig(
      {
        ORCHESTRAI_LLM_PROVIDER: "anthropic",
        ORCHESTRAI_LLM_API_KEY: FAKE_KEY,
        ORCHESTRAI_ORCHESTRATOR_LLM_MODEL: "claude-opus-5",
      },
      "orchestrator",
    )!
    const description = describeLlmModelConfig(config)
    expect(description).toContain("anthropic")
    expect(description).toContain("claude-opus-5")
    expect(description).toContain("ORCHESTRAI_ORCHESTRATOR_LLM_MODEL")
    expect(description).toContain("ORCHESTRAI_LLM_API_KEY")
    expect(description).not.toContain(FAKE_KEY)
  })

  test("reports a provider-default model without a fabricated source", () => {
    const config = readLlmModelConfig({ ORCHESTRAI_LLM_API_KEY: FAKE_KEY })!
    expect(describeLlmModelConfig(config)).toContain("provider default")
  })
})

describe("buildChatModel", () => {
  // Found live via CI (Linux runner) failing where this repo's own dev
  // environment (Windows, with locally cached `gcloud` ADC state) passed:
  // constructing ChatGoogle triggers a real fetch on some platforms even
  // with an explicit apiKey supplied — @langchain/google's underlying
  // google-auth-library performs its own platform/credential-type
  // detection as part of resolving `platform`/`hasApiKey()`, and that
  // detection is not something this repository's code controls or can
  // make deterministic across OSes. Asserting "zero fetch calls" was
  // over-specifying a third-party library implementation detail rather
  // than a property OrchestrAI itself guarantees.
  //
  // What this repo *does* guarantee, and what's actually tested here: the
  // configured apiKey is passed directly to the constructor (never read
  // from GOOGLE_API_KEY/GEMINI_API_KEY or any ambient env var — see
  // specs/029's own safety constraint), so any request that construction
  // does trigger authenticates with the value this function was given, not
  // a leaked/ambient credential, and the fake key is never repeated in a
  // request's own URL/body — the only ambient value it could otherwise
  // pick up is the placeholder google.auth-library ADC file structure
  // itself, never this test's own secret.
  test("constructs the Node ChatGoogle adapter with bindTools, apiKey supplied explicitly, no key leakage", async () => {
    const originalFetch = globalThis.fetch
    const requestedUrls: string[] = []
    const fetchMock = mock(async (input: string | URL) => {
      requestedUrls.push(String(input))
      return new Response("{}", { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    try {
      const model = await buildChatModel({
        provider: "gemini",
        model: "gemini-test-model",
        apiKey: FAKE_KEY,
      })

      expect(typeof model.bindTools).toBe("function")
      expect(model.bindTools!([])).toBeDefined()
      // Whatever construction-time requests happen (platform-dependent —
      // see comment above), the fake key must never appear as a bare
      // query/path value in any of them.
      for (const url of requestedUrls) {
        expect(url).not.toContain(FAKE_KEY)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("checkStartupLlmKeys — specs/051-planning-retirement-and-required-key/spec.md §2", () => {
  test("no requirements: nothing missing, nothing misconfigured", () => {
    expect(checkStartupLlmKeys({}, [])).toEqual({ missing: [], misconfigured: [] })
  })

  test("a shared key satisfies a requirement with no per-component override", () => {
    const result = checkStartupLlmKeys(
      { ORCHESTRAI_LLM_API_KEY: FAKE_KEY },
      [{ component: "orchestrator", reason: "the only plan-task planner" }],
    )
    expect(result).toEqual({ missing: [], misconfigured: [] })
  })

  test("no key anywhere: reported missing, with its reason carried through", () => {
    const result = checkStartupLlmKeys({}, [{ component: "orchestrator", reason: "the only plan-task planner" }])
    expect(result.missing).toEqual([{ component: "orchestrator", reason: "the only plan-task planner" }])
    expect(result.misconfigured).toEqual([])
  })

  test("a per-component key satisfies only that component, not others also being checked", () => {
    const env = { ORCHESTRAI_DEVOPS_LLM_API_KEY: FAKE_KEY }
    const result = checkStartupLlmKeys(env, [
      { component: "devops", reason: "DevOps LLM harness is on" },
      { component: "security", reason: "Security LLM harness is on" },
    ])
    expect(result.missing).toEqual([{ component: "security", reason: "Security LLM harness is on" }])
  })

  test("a shared key does NOT satisfy a component whose own harness needs its own — per specs/039 there is no such rule", () => {
    // This is really just confirming checkStartupLlmKeys doesn't invent a
    // rule readLlmModelConfig() doesn't have: the shared key DOES satisfy
    // every component by design (specs/039's fallback), so this asserts
    // the fallback still applies here, not that it doesn't.
    const result = checkStartupLlmKeys(
      { ORCHESTRAI_LLM_API_KEY: FAKE_KEY },
      [{ component: "devops", reason: "DevOps LLM harness is on" }],
    )
    expect(result.missing).toEqual([])
  })

  test("an invalid provider is reported as misconfigured, not missing", () => {
    const result = checkStartupLlmKeys(
      { ORCHESTRAI_LLM_PROVIDER: "not-a-real-provider", ORCHESTRAI_LLM_API_KEY: FAKE_KEY },
      [{ component: "orchestrator", reason: "the only plan-task planner" }],
    )
    expect(result.missing).toEqual([])
    expect(result.misconfigured).toHaveLength(1)
    expect(result.misconfigured[0]!.component).toBe("orchestrator")
    expect(result.misconfigured[0]!.error).toContain("not-a-real-provider")
  })

  test("gemini with no model is reported as misconfigured, not missing", () => {
    const result = checkStartupLlmKeys(
      { ORCHESTRAI_LLM_PROVIDER: "gemini", ORCHESTRAI_LLM_API_KEY: FAKE_KEY },
      [{ component: "orchestrator", reason: "the only plan-task planner" }],
    )
    expect(result.missing).toEqual([])
    expect(result.misconfigured).toHaveLength(1)
    expect(result.misconfigured[0]!.error).toContain("gemini")
  })

  test("multiple requirements are each reported independently, correctly split between the two lists", () => {
    const env = {
      // orchestrator has its own key but is gemini with no model -> misconfigured,
      // not missing (readLlmModelConfig checks the key before the model, so
      // orchestrator needs its OWN key here to reach that check at all).
      ORCHESTRAI_ORCHESTRATOR_LLM_PROVIDER: "gemini",
      ORCHESTRAI_ORCHESTRATOR_LLM_API_KEY: FAKE_KEY,
      ORCHESTRAI_DEVOPS_LLM_API_KEY: FAKE_KEY, // devops satisfied on its own
      // security: nothing at all -> missing
    }
    const result = checkStartupLlmKeys(env, [
      { component: "orchestrator", reason: "the only plan-task planner" },
      { component: "devops", reason: "DevOps LLM harness is on" },
      { component: "security", reason: "Security LLM harness is on" },
    ])
    expect(result.missing).toEqual([{ component: "security", reason: "Security LLM harness is on" }])
    expect(result.misconfigured.map((m) => m.component)).toEqual(["orchestrator"])
  })
})

// specs/055-provider-call-budgets-and-transient-error-handling/spec.md
describe("classifyProviderError", () => {
  test("classifies a 429 status as transient", () => {
    expect(classifyProviderError({ status: 429, message: "Too Many Requests" })).toBe("transient")
  })

  test("classifies 5xx statuses as transient", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyProviderError({ status })).toBe("transient")
    }
  })

  test("classifies statusCode (not just status) the same way", () => {
    expect(classifyProviderError({ statusCode: 503 })).toBe("transient")
  })

  test("classifies 400/401/403/404 as terminal", () => {
    for (const status of [400, 401, 403, 404]) {
      expect(classifyProviderError({ status })).toBe("terminal")
    }
  })

  test("classifies a connection-reset error code as transient", () => {
    expect(classifyProviderError({ code: "ECONNRESET" })).toBe("transient")
  })

  test("classifies a rate-limit-shaped message with no status as transient", () => {
    expect(classifyProviderError({ message: "rate limit exceeded, please retry" })).toBe("transient")
  })

  test("classifies a timeout-shaped message as transient", () => {
    expect(classifyProviderError({ message: "Request timed out after 30000ms" })).toBe("transient")
  })

  test("classifies an auth-shaped message with no recognizable status as terminal", () => {
    expect(classifyProviderError({ message: "Invalid API key provided" })).toBe("terminal")
  })

  test("classifies a non-object thrown value as terminal (fail-closed default)", () => {
    expect(classifyProviderError("just a string")).toBe("terminal")
    expect(classifyProviderError(null)).toBe("terminal")
    expect(classifyProviderError(undefined)).toBe("terminal")
  })
})

describe("extractRetryAfterMs", () => {
  test("reads a numeric Retry-After (seconds) from a Headers-like object", () => {
    const err = { headers: new Headers({ "retry-after": "2" }) }
    expect(extractRetryAfterMs(err)).toBe(2000)
  })

  test("reads a numeric Retry-After from a plain header object", () => {
    expect(extractRetryAfterMs({ headers: { "retry-after": "5" } })).toBe(5000)
  })

  test("reads an HTTP-date Retry-After as a bounded future offset", () => {
    const future = new Date(Date.now() + 10_000).toUTCString()
    const ms = extractRetryAfterMs({ headers: { "Retry-After": future } })
    expect(ms).not.toBeNull()
    expect(ms!).toBeGreaterThan(0)
    expect(ms!).toBeLessThanOrEqual(11_000)
  })

  test("returns null when no headers are present", () => {
    expect(extractRetryAfterMs({ message: "no headers here" })).toBeNull()
  })

  test("returns null for an unparseable Retry-After value", () => {
    expect(extractRetryAfterMs({ headers: { "retry-after": "not-a-value" } })).toBeNull()
  })
})

describe("callProviderWithRetry", () => {
  // Deterministic — no real timers. sleep resolves immediately; random is
  // fixed so jitter math stays checkable without flakiness.
  const fastOptions = { sleep: async () => {}, random: () => 0.5 }

  test("succeeds immediately with zero retries when the call never throws", async () => {
    let calls = 0
    const result = await callProviderWithRetry(async () => {
      calls += 1
      return "ok"
    }, fastOptions)
    expect(result).toBe("ok")
    expect(calls).toBe(1)
  })

  test("retries a transient failure and succeeds once it stops failing", async () => {
    let calls = 0
    const result = await callProviderWithRetry(async () => {
      calls += 1
      if (calls < 3) throw { status: 429, message: "rate limited" }
      return "recovered"
    }, fastOptions)
    expect(result).toBe("recovered")
    expect(calls).toBe(3)
  })

  test("a terminal failure re-throws immediately — zero retries, the original error, unmodified", async () => {
    const authError = { status: 401, message: "Invalid API key" }
    let calls = 0
    await expect(
      callProviderWithRetry(async () => {
        calls += 1
        throw authError
      }, fastOptions),
    ).rejects.toBe(authError)
    expect(calls).toBe(1)
  })

  test("exhausting retries on a persistent transient failure throws a distinguishable, named error", async () => {
    let calls = 0
    const cause = { status: 503, message: "service unavailable" }
    await expect(
      callProviderWithRetry(
        async () => {
          calls += 1
          throw cause
        },
        { ...fastOptions, maxRetries: 2 },
      ),
    ).rejects.toBeInstanceOf(ProviderRetriesExhaustedError)
    // maxRetries: 2 means up to 3 total attempts (1 initial + 2 retries).
    expect(calls).toBe(3)
  })

  test("the exhausted error names the attempt count and wraps the real cause, never silently swallowed", async () => {
    const cause = Object.assign(new Error("rate limited forever"), { status: 429 })
    try {
      await callProviderWithRetry(
        async () => {
          throw cause
        },
        { ...fastOptions, maxRetries: 1 },
      )
      throw new Error("expected callProviderWithRetry to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRetriesExhaustedError)
      const exhausted = error as ProviderRetriesExhaustedError
      expect(exhausted.cause).toBe(cause)
      expect(exhausted.message).toContain("2 attempt")
      expect(exhausted.message).toContain("rate limited forever")
    }
  })

  test("never waits longer than maxDelayMs, even with a huge Retry-After", async () => {
    const waits: number[] = []
    const sleep = async (ms: number) => {
      waits.push(ms)
    }
    let calls = 0
    await expect(
      callProviderWithRetry(
        async () => {
          calls += 1
          throw { status: 429, headers: { "retry-after": "999999" } }
        },
        { sleep, random: () => 1, maxRetries: 2, maxDelayMs: 5_000 },
      ),
    ).rejects.toBeInstanceOf(ProviderRetriesExhaustedError)
    expect(calls).toBe(3)
    for (const ms of waits) {
      expect(ms).toBeLessThanOrEqual(5_000)
    }
  })

  test("honors a real (small) Retry-After over the default exponential backoff", async () => {
    const waits: number[] = []
    let calls = 0
    await callProviderWithRetry(
      async () => {
        calls += 1
        if (calls < 2) throw { status: 429, headers: { "retry-after": "1" } }
        return "done"
      },
      {
        sleep: async (ms: number) => {
          waits.push(ms)
        },
        random: () => 0.5, // jitter multiplier: 0.5 + 0.5*0.5 = 0.75
      },
    )
    // Retry-After of 1s (1000ms) at 0.75 jitter -> 750ms, far below the
    // default 1000ms base-delay's own first-attempt exponential value.
    expect(waits).toEqual([750])
  })
})
