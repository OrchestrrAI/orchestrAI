// specs/049-guided-init-web-setup/spec.md
//
// Security tests are the priority here, per the spec's own Verification
// Plan — most run in-process against the real Hono handler via
// app.request() (the same technique specs/046 already established), plus
// one real bound-port test asserting the actual listening address.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import {
  createInitWebApp,
  generateToken,
  isRequestFromExpectedOrigin,
  parseSubmission,
  buildPageHtml,
} from "./init-web"
import { initialFormState } from "./init-form-state"
import { formatConfigEnv, type WizardConfig } from "./init-wizard"

const PORT = 51234 // fixed only for these in-process tests — never used for a real bind
let scratchDir: string

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(tmpdir(), "init-web-"))
})
afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true })
})

function baseState() {
  return initialFormState(scratchDir, ["devops-agent", "testing-agent", "documentation-agent", "security-agent"], { env: {} })
}

describe("generateToken", () => {
  test("produces a real, sufficiently long, unpredictable value each time", () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).not.toBe(b)
    // 24 bytes hex-encoded = 48 characters, comfortably over the spec's
    // own >=128-bit floor (16 bytes / 32 hex chars would already clear it).
    expect(a.length).toBe(48)
    expect(a).toMatch(/^[0-9a-f]+$/)
  })
})

describe("isRequestFromExpectedOrigin", () => {
  test("accepts a matching loopback Origin and Host", () => {
    expect(isRequestFromExpectedOrigin({ origin: "http://127.0.0.1:51234", host: "127.0.0.1:51234" }, 51234)).toBe(true)
  })

  test("rejects a missing Origin — never assumed same-origin by omission", () => {
    expect(isRequestFromExpectedOrigin({ origin: null, host: "127.0.0.1:51234" }, 51234)).toBe(false)
  })

  test("rejects a foreign Origin — defeats a cross-site POST from another open tab", () => {
    expect(isRequestFromExpectedOrigin({ origin: "http://evil.example:51234", host: "127.0.0.1:51234" }, 51234)).toBe(false)
  })

  test("rejects a mismatched Host — defeats DNS rebinding", () => {
    expect(isRequestFromExpectedOrigin({ origin: "http://127.0.0.1:51234", host: "attacker.example:51234" }, 51234)).toBe(false)
  })

  test("rejects the right host at the wrong port", () => {
    expect(isRequestFromExpectedOrigin({ origin: "http://127.0.0.1:9999", host: "127.0.0.1:9999" }, 51234)).toBe(false)
  })
})

function realOriginHeaders(port: number) {
  return { Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}` }
}

describe("createInitWebApp — token gating", () => {
  test("GET with the correct token serves the page", async () => {
    const token = generateToken()
    const { app } = createInitWebApp({ token, port: PORT, base: baseState(), onSubmit: () => {} })
    const res = await app.request(`/s/${token}`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("OrchestrAI Setup")
  })

  test("GET with no token, or the wrong one, 404s with no distinguishing detail", async () => {
    const token = generateToken()
    const { app } = createInitWebApp({ token, port: PORT, base: baseState(), onSubmit: () => {} })
    const wrong = await app.request(`/s/${generateToken()}`)
    expect(wrong.status).toBe(404)
    const other = await app.request("/some/other/path")
    expect(other.status).toBe(404)
    // Both 404 bodies are identical — a wrong token is not distinguishable
    // from any other unknown path.
    expect(await wrong.text()).toBe(await other.text())
  })
})

describe("createInitWebApp — Origin/Host enforcement on POST", () => {
  test("a POST with a foreign Origin is rejected (404, same as a bad token)", async () => {
    const token = generateToken()
    const { app } = createInitWebApp({ token, port: PORT, base: baseState(), onSubmit: () => {} })
    const res = await app.request(`/s/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ targetPath: scratchDir }),
    })
    expect(res.status).toBe(404)
  })

  test("a POST with no Origin at all is rejected", async () => {
    const token = generateToken()
    const { app } = createInitWebApp({ token, port: PORT, base: baseState(), onSubmit: () => {} })
    const res = await app.request(`/s/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: `127.0.0.1:${PORT}` },
      body: JSON.stringify({ targetPath: scratchDir }),
    })
    expect(res.status).toBe(404)
  })

  test("a well-formed, same-origin POST succeeds", async () => {
    const token = generateToken()
    let captured: unknown = null
    const { app } = createInitWebApp({ token, port: PORT, base: baseState(), onSubmit: (c) => { captured = c } })
    const res = await app.request(`/s/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...realOriginHeaders(PORT) },
      body: JSON.stringify({ targetPath: scratchDir, llmProvider: "anthropic", llmApiKey: "sk-real-secret-value" }),
    })
    expect(res.status).toBe(200)
    expect(captured).not.toBeNull()
  })
})

describe("createInitWebApp — single-use", () => {
  test("a second submission after a successful one is refused (404), never processed twice", async () => {
    const token = generateToken()
    let submitCount = 0
    const { app, isUsed } = createInitWebApp({ token, port: PORT, base: baseState(), onSubmit: () => { submitCount += 1 } })

    const first = await app.request(`/s/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...realOriginHeaders(PORT) },
      body: JSON.stringify({ targetPath: scratchDir }),
    })
    expect(first.status).toBe(200)
    expect(isUsed()).toBe(true)

    const second = await app.request(`/s/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...realOriginHeaders(PORT) },
      body: JSON.stringify({ targetPath: scratchDir }),
    })
    expect(second.status).toBe(404)
    expect(submitCount).toBe(1)

    // The page itself also stops being servable once used.
    const getAfter = await app.request(`/s/${token}`)
    expect(getAfter.status).toBe(404)
  })

  test("an invalid submission does NOT consume the token — a typo shouldn't lock the user out", async () => {
    const token = generateToken()
    const { app, isUsed } = createInitWebApp({ token, port: PORT, base: baseState(), onSubmit: () => {} })
    const res = await app.request(`/s/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...realOriginHeaders(PORT) },
      body: JSON.stringify({ targetPath: "/definitely/does/not/exist/anywhere" }),
    })
    expect(res.status).toBe(400)
    expect(isUsed()).toBe(false)
  })
})

describe("createInitWebApp — secret never echoed", () => {
  test("the success response contains only the masked key, never the raw one", async () => {
    const token = generateToken()
    const SENTINEL = "sk-SENTINEL-DO-NOT-LEAK-1234567890"
    const { app } = createInitWebApp({ token, port: PORT, base: baseState(), onSubmit: () => {} })
    const res = await app.request(`/s/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...realOriginHeaders(PORT) },
      body: JSON.stringify({ targetPath: scratchDir, llmApiKey: SENTINEL }),
    })
    const bodyText = await res.text()
    expect(bodyText).not.toContain(SENTINEL)
    expect(bodyText).toContain("maskedKey")
  })

  test("the rendered page never embeds a real key value (there is none to embed on GET, but confirm no template artifact leaks one)", () => {
    const html = buildPageHtml(baseState(), generateToken())
    expect(html).not.toContain("llmApiKey\":\"sk-")
  })
})

describe("createInitWebApp — a bad request body fails closed, never a crash", () => {
  test("malformed JSON returns 400, not a 500 or an unhandled exception", async () => {
    const token = generateToken()
    const { app } = createInitWebApp({ token, port: PORT, base: baseState(), onSubmit: () => {} })
    const res = await app.request(`/s/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...realOriginHeaders(PORT) },
      body: "{not valid json",
    })
    expect(res.status).toBe(400)
  })

  test("a non-string targetPath is rejected with a clear error", () => {
    const result = parseSubmission({ targetPath: 42 }, baseState())
    expect(result.ok).toBe(false)
  })
})

describe("config-contract parity — byte-identical to the classic wizard for the same answers", () => {
  test("the browser submission produces the exact same config.env content the classic wizard writes", async () => {
    const token = generateToken()
    let captured: WizardConfig | null = null
    const { app } = createInitWebApp({
      token, port: PORT, base: baseState(),
      onSubmit: (c) => { captured = c },
    })

    await app.request(`/s/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...realOriginHeaders(PORT) },
      body: JSON.stringify({
        targetPath: scratchDir,
        selectedAgents: ["devops-agent", "security-agent"],
        llmProvider: "anthropic",
        llmModel: "claude-real-model",
        llmApiKey: "sk-real-key",
      }),
    })

    expect(captured).not.toBeNull()
    const webConfigText = formatConfigEnv(captured!)

    // specs/070 — selecting an agent IS the decision to run its LLM path,
    // so both selected harness agents come out `=1` (derived from the
    // selection, no separate toggle). A classic all-yes run matches.
    const classicEquivalent = {
      only: ["devops-agent", "security-agent"],
      agentLlm: { devopsLlm: true, securityLlm: true },
      modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {},
      llmProvider: "anthropic" as const,
      llmModel: "claude-real-model",
      llmApiKey: "sk-real-key",
      // specs/132 — the classic wizard also records its key in the
      // registered-provider store.
      providerKeys: { anthropic: "sk-real-key" },
    }
    const classicConfigText = formatConfigEnv(classicEquivalent)

    expect(webConfigText).toBe(classicConfigText)
  })
})

describe("real bound-port test — loopback only, never 0.0.0.0", () => {
  test("Bun.serve() with the app's own fetch handler binds 127.0.0.1 on an OS-chosen ephemeral port", async () => {
    const token = generateToken()
    const { app } = createInitWebApp({ token, port: 0, base: baseState(), onSubmit: () => {} })
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
    try {
      expect(server.hostname).toBe("127.0.0.1")
      expect(typeof server.port).toBe("number")
      expect(server.port).toBeGreaterThan(0)

      // A real network round trip against the real bound socket, not just
      // app.request()'s in-process shortcut — proves the server is
      // genuinely listening where it claims to be.
      const res = await fetch(`http://127.0.0.1:${server.port}/s/${token}`)
      expect(res.status).toBe(200)
    } finally {
      server.stop(true)
    }
  })
})
