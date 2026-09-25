// specs/063-init-per-component-provider-and-key/spec.md
//
// Mocked fetch throughout — matching llm-model-factory.test.ts's own
// existing convention for network-adjacent code in this codebase. No
// real credential, no real network call.
import { describe, expect, test } from "bun:test"
import { describeHttpError, listAvailableModels } from "./model-discovery"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("listAvailableModels — anthropic", () => {
  test("returns the real model list on success, no filtering applied", async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/models")
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test")
      return jsonResponse(200, { data: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }] })
    }) as unknown as typeof fetch

    const result = await listAvailableModels("anthropic", "sk-ant-test", { fetchImpl })
    expect(result).toEqual({ ok: true, models: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }] })
  })

  test("a non-200 response is reported, not thrown", async () => {
    const fetchImpl = (async () => jsonResponse(401, { error: "invalid key" })) as unknown as typeof fetch
    const result = await listAvailableModels("anthropic", "bad-key", { fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("401")
  })
})

describe("listAvailableModels — openai", () => {
  test("filters out non-chat models (embeddings, whisper, dall-e, tts, moderation)", async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test")
      return jsonResponse(200, {
        data: [
          { id: "gpt-5" },
          { id: "text-embedding-3-large" },
          { id: "whisper-1" },
          { id: "dall-e-3" },
          { id: "tts-1" },
          { id: "omni-moderation-latest" },
          { id: "gpt-5-mini" },
        ],
      })
    }) as unknown as typeof fetch

    const result = await listAvailableModels("openai", "sk-test", { fetchImpl })
    expect(result).toEqual({ ok: true, models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] })
  })
})

describe("listAvailableModels — gemini", () => {
  test("strips the models/ prefix and filters to generateContent-capable entries", async () => {
    const fetchImpl = (async (url: string | URL) => {
      expect(String(url)).toContain("key=sk-gem-test")
      return jsonResponse(200, {
        models: [
          { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
        ],
      })
    }) as unknown as typeof fetch

    const result = await listAvailableModels("gemini", "sk-gem-test", { fetchImpl })
    expect(result).toEqual({ ok: true, models: [{ id: "gemini-3.5-flash-lite" }] })
  })

  test("a real key value never appears anywhere but the request URL/header itself", async () => {
    const secret = "sk-gem-never-leak-this"
    let sawSecretInUrl = false
    const fetchImpl = (async (url: string | URL) => {
      sawSecretInUrl = String(url).includes(secret)
      return jsonResponse(200, { models: [] })
    }) as unknown as typeof fetch
    await listAvailableModels("gemini", secret, { fetchImpl })
    expect(sawSecretInUrl).toBe(true) // it must reach the request itself...
    // ...but the result object returned to the caller carries no trace of it.
    const result = await listAvailableModels("gemini", secret, { fetchImpl })
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})

describe("listAvailableModels — cross-provider behavior", () => {
  test("an empty API key fails immediately without ever calling fetch", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return jsonResponse(200, { data: [] })
    }) as unknown as typeof fetch
    const result = await listAvailableModels("anthropic", "   ", { fetchImpl })
    expect(result).toEqual({ ok: false, error: "no API key provided" })
    expect(called).toBe(false)
  })

  test("a network error (connection refused, DNS failure) is reported, not thrown", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    const result = await listAvailableModels("openai", "sk-test", { fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("fetch failed")
  })

  test("a request that never resolves is bounded by the timeout, not left hanging forever", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      })
    }) as unknown as typeof fetch
    const result = await listAvailableModels("anthropic", "sk-test", { fetchImpl, timeoutMs: 20 })
    expect(result).toEqual({ ok: false, error: "timed out" })
  })

  test("malformed JSON is reported, not thrown", async () => {
    const fetchImpl = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch
    const result = await listAvailableModels("anthropic", "sk-test", { fetchImpl })
    expect(result.ok).toBe(false)
  })
})

// specs/132 — a failing list shows the provider's own reason, never the key.
describe("specs/132 — describeHttpError", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

  test("appends the provider's error.message", async () => {
    const res = json(400, { type: "error", error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace" } })
    expect(await describeHttpError("Anthropic", res, "sk-ant-secret")).toBe("Anthropic API returned 400 — This API key is not scoped to a workspace")
  })

  test("redacts the key if the provider echoes it", async () => {
    const text = await describeHttpError("OpenAI", json(401, { error: { message: "bad key sk-secret-123 supplied" } }), "sk-secret-123")
    expect(text).not.toContain("sk-secret-123")
    expect(text).toContain("<key>")
  })

  test("a provider's own partly masked echo of the key is redacted too (OpenAI's format)", async () => {
    const res = json(401, { error: { message: "Incorrect API key provided: sk-proj-ab*******wxyz. You can find your API key at …" } })
    const text = await describeHttpError("OpenAI", res, "sk-proj-abSECRETwxyz")
    expect(text).not.toContain("sk-proj-ab")
    expect(text).not.toContain("wxyz")
    expect(text).toContain("Incorrect API key provided: <key>.")
  })

  test("a non-JSON body falls back to the status alone", async () => {
    expect(await describeHttpError("Gemini", new Response("<html>oops</html>", { status: 502 }), "k")).toBe("Gemini API returned 502")
  })

  test("a very long message is truncated", async () => {
    const text = await describeHttpError("OpenAI", json(400, { error: { message: "x".repeat(1000) } }), "k")
    expect(text.length).toBeLessThan(260)
    expect(text.endsWith("…")).toBe(true)
  })

  test("listAvailableModels surfaces the reason end to end", async () => {
    const fetchImpl = (async () => json(400, { error: { message: "workspace required" } })) as unknown as typeof fetch
    const result = await listAvailableModels("anthropic", "sk-ant-x", { fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("Anthropic API returned 400 — workspace required")
  })
})
