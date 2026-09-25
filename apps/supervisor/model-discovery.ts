// specs/063-init-per-component-provider-and-key/spec.md §4
//
// Live "what models does this key actually have access to" discovery for
// the Providers/Models screens — this codebase's first outbound network
// call made DURING setup, before anything is started or persisted.
// Deliberately plain fetch() per provider, not the LangChain wrapper
// classes buildChatModel() uses elsewhere — those exist to make chat
// completions, not list models, and pulling three chat-model SDKs into
// the setup wizard's own dependency graph for one GET request each would
// be disproportionate (this codebase's own established "dependency-free
// when reasonable" precedent, e.g. specs/040's line-diff, specs/055's
// backoff).
//
// Bounded (never unbounded — the same precedent specs/045's port-
// preflight timeout already established), and every failure mode
// (bad key, no network, provider outage, malformed response) resolves to
// the same { ok: false, error } shape rather than throwing — the caller
// (init-form-state.ts) falls back to free-text model entry on any of
// them, never blocks or crashes setup. The key is used only in the one
// request's own auth header/query param; never logged, never echoed,
// matching every existing masked-key discipline in this codebase.

import type { LlmProvider } from "./init-wizard"

export interface DiscoveredModel {
  id: string
}

export type ModelDiscoveryResult = { ok: true; models: DiscoveredModel[] } | { ok: false; error: string }

export interface ModelDiscoveryOptions {
  /** Injectable for tests only — real callers never pass this. */
  fetchImpl?: typeof fetch
  /** Bounded, never unbounded. 8s default per this spec's own stated bound. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 8_000

// OpenAI's /v1/models mixes chat models in with embedding, audio,
// moderation, and image-generation models — an explicit, documented
// best-effort filter against OpenAI's *current* naming, not a promise
// it survives every future category OpenAI might add (specs/063's own
// stated Non-Goal).
const OPENAI_NON_CHAT_PREFIXES = ["text-embedding-", "whisper-", "dall-e-", "tts-", "omni-moderation-", "text-moderation-", "babbage-", "davinci-"]

async function fetchWithTimeout(url: string, init: RequestInit, fetchImpl: typeof fetch, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "timed out"
    return err.message
  }
  return String(err)
}

// specs/132 — "returned 400" alone hid real causes (a live Anthropic key
// that wasn't workspace-scoped). All three providers put a human message
// at `error.message`; it's appended, redacted of the key, and bounded.
const MAX_PROVIDER_ERROR_CHARS = 180

export async function describeHttpError(providerName: string, res: Response, apiKey: string): Promise<string> {
  const base = `${providerName} API returned ${res.status}`
  let message = ""
  try {
    const body = (await res.json()) as { error?: { message?: unknown } | unknown }
    const inner = (body as { error?: { message?: unknown } })?.error
    if (inner && typeof inner === "object" && typeof (inner as { message?: unknown }).message === "string") {
      message = (inner as { message: string }).message
    }
  } catch {
    // not JSON — the status alone is all we can say
  }
  if (apiKey) message = message.split(apiKey).join("<key>")
  // OpenAI echoes a partly masked key ("sk-proj-abc****wxyz"), which still
  // reveals its ends — any token with a run of asterisks is redacted too.
  message = message.replace(/\S*\*{3,}[^\s.,;:!?)]*/g, "<key>")
  message = message.replace(/\s+/g, " ").trim()
  if (!message) return base
  if (message.length > MAX_PROVIDER_ERROR_CHARS) message = `${message.slice(0, MAX_PROVIDER_ERROR_CHARS - 1)}…`
  return `${base} — ${message}`
}

async function listAnthropicModels(apiKey: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<ModelDiscoveryResult> {
  try {
    const res = await fetchWithTimeout(
      "https://api.anthropic.com/v1/models",
      { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
      fetchImpl,
      timeoutMs,
    )
    if (!res.ok) return { ok: false, error: await describeHttpError("Anthropic", res, apiKey) }
    const body = (await res.json()) as { data?: { id?: string }[] }
    const models = (body.data ?? []).filter((m): m is { id: string } => typeof m.id === "string").map((m) => ({ id: m.id }))
    return { ok: true, models }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

async function listOpenAiModels(apiKey: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<ModelDiscoveryResult> {
  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } }, fetchImpl, timeoutMs)
    if (!res.ok) return { ok: false, error: await describeHttpError("OpenAI", res, apiKey) }
    const body = (await res.json()) as { data?: { id?: string }[] }
    const models = (body.data ?? [])
      .filter((m): m is { id: string } => typeof m.id === "string")
      .filter((m) => !OPENAI_NON_CHAT_PREFIXES.some((prefix) => m.id.startsWith(prefix)))
      .map((m) => ({ id: m.id }))
    return { ok: true, models }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

async function listGeminiModels(apiKey: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<ModelDiscoveryResult> {
  try {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      {},
      fetchImpl,
      timeoutMs,
    )
    if (!res.ok) return { ok: false, error: await describeHttpError("Gemini", res, apiKey) }
    const body = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] }
    const models = (body.models ?? [])
      .filter((m) => typeof m.name === "string" && (m.supportedGenerationMethods ?? []).includes("generateContent"))
      // Gemini's own id comes back as "models/gemini-3.5-flash-lite" —
      // strip the "models/" prefix to match the bare id shape
      // ORCHESTRAI_LLM_MODEL/componentModelVar() already expect
      // everywhere else in this codebase.
      .map((m) => ({ id: (m.name as string).replace(/^models\//, "") }))
    return { ok: true, models }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

/** Lists the models actually available to `apiKey` on `provider`. Never
 *  throws — every failure (bad key, no network, timeout, malformed
 *  response) resolves to `{ ok: false, error }`, matching this spec's
 *  own "never block setup" constraint. */
export async function listAvailableModels(provider: LlmProvider, apiKey: string, options: ModelDiscoveryOptions = {}): Promise<ModelDiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!apiKey.trim()) return { ok: false, error: "no API key provided" }

  switch (provider) {
    case "anthropic":
      return listAnthropicModels(apiKey, fetchImpl, timeoutMs)
    case "openai":
      return listOpenAiModels(apiKey, fetchImpl, timeoutMs)
    case "gemini":
      return listGeminiModels(apiKey, fetchImpl, timeoutMs)
  }
}
