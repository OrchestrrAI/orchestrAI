// specs/029-shared-llm-provider-gemini/spec.md — this is the shared,
// provider-neutral construction boundary. Feature activation remains owned
// by each caller; importing this module performs no provider import and no
// network request.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"

export type LlmProvider = "anthropic" | "openai" | "gemini"

/**
 * specs/039-per-component-llm-provider-config/spec.md — the closed set of
 * components that can actually use an LLM. Deliberately a fixed set, not
 * a free-form string: a component name is a compile-time fact, never
 * derived from environment input.
 *
 * specs/050-init-per-agent-llm-toggles/spec.md — expressed as an `as const`
 * array with the type derived from it (the same idiom LLM_PROVIDERS already
 * uses in apps/supervisor/init-wizard.ts), because `orchestrai init`'s
 * Models view has to enumerate these to render a row per component. It was
 * previously a bare type union with no runtime representation, so nothing
 * could list them without hand-copying. Same six names, same order, zero
 * behavior change — resolution is untouched.
 *
 * specs/051-planning-retirement-and-required-key/spec.md — "planning"
 * removed: Planning Agent is deleted entirely by that spec, so there is no
 * longer a component to resolve a config for.
 *
 * specs/080-run-command-approved-execution/spec.md — "testing" added:
 * Testing Agent's own first LLM harness, gained narrowly to propose a
 * real test command for a stack RUNNER_ARGV has no fixed entry for.
 *
 * specs/082-code-review-agent/spec.md — "codeReview" added: the first
 * genuinely new agent's own harness, required (no deterministic
 * fallback exists for reviewing a diff at all).
 *
 * specs/083-coder-agent/spec.md — "coder" added: the second genuinely
 * new agent's own harness, also required — no deterministic fallback
 * exists for proposing a code edit either.
 */
export const LLM_COMPONENTS = ["orchestrator", "documentation", "devops", "security", "conversation", "testing", "codeReview", "coder"] as const
export type LlmComponent = (typeof LLM_COMPONENTS)[number]

export interface LlmModelConfig {
  provider: LlmProvider
  model: string
  apiKey: string
  /** Which environment variable each field actually resolved from, so
   *  startup reporting can distinguish two components sharing one
   *  environment. Never carries a value — only a variable name. */
  sources?: {
    provider: string
    model: string | null
    apiKey: string
  }
}

const DEFAULT_MODEL: Partial<Record<LlmProvider, string>> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5",
}

const SUPPORTED_PROVIDERS: readonly LlmProvider[] = ["anthropic", "openai", "gemini"]

type LlmField = "PROVIDER" | "MODEL" | "API_KEY"

interface ResolvedVar {
  value: string | undefined
  /** The variable this value actually came from. Errors name this rather
   *  than a generic field, so a misconfiguration points at the variable
   *  genuinely responsible. */
  source: string
}

/**
 * specs/039 — two-tier resolution for one field. A component-specific
 * variable wins when set and non-empty; otherwise the shared variable is
 * used. Resolution is per field, so sharing a key while overriding only
 * the model is valid and expected.
 *
 * Note the structural safety property: this only ever reads the component
 * it was handed plus the shared names. There is no path by which one
 * component can resolve another component's namespace — falling back to
 * *shared* is designed, falling back to *another component* is impossible
 * by construction, not by convention.
 */
function resolveLlmVar(
  env: Record<string, string | undefined>,
  component: LlmComponent | undefined,
  field: LlmField,
): ResolvedVar {
  const shared = `ORCHESTRAI_LLM_${field}`
  if (component) {
    const specific = `ORCHESTRAI_${component.toUpperCase()}_LLM_${field}`
    const value = env[specific]?.trim()
    if (value) return { value, source: specific }
  }
  return { value: env[shared]?.trim(), source: shared }
}

/**
 * Parse the provider-neutral LLM variables after a caller has decided its
 * feature is active. Missing credentials return null so callers can fail
 * closed using their existing unconfigured path. Invalid provider/model
 * selections throw errors that name configuration fields, never values.
 *
 * `component` (specs/039) opts into per-component overrides. Omitted, this
 * behaves exactly as it did before that spec — the shared variables only.
 */
export function readLlmModelConfig(
  env: Record<string, string | undefined> = process.env,
  component?: LlmComponent,
): LlmModelConfig | null {
  const providerVar = resolveLlmVar(env, component, "PROVIDER")
  const rawProvider = (providerVar.value ?? "anthropic").toLowerCase()
  if (!SUPPORTED_PROVIDERS.includes(rawProvider as LlmProvider)) {
    throw new Error(
      `Unknown ${providerVar.source} "${rawProvider}" — expected "anthropic", "openai", or "gemini".`,
    )
  }
  const provider = rawProvider as LlmProvider

  const keyVar = resolveLlmVar(env, component, "API_KEY")
  if (!keyVar.value) return null

  const modelVar = resolveLlmVar(env, component, "MODEL")
  if (provider === "gemini" && !modelVar.value) {
    throw new Error(
      `${modelVar.source} is required when ${providerVar.source} is "gemini".`,
    )
  }

  return {
    provider,
    model: modelVar.value ?? DEFAULT_MODEL[provider]!,
    apiKey: keyVar.value,
    sources: {
      provider: providerVar.source,
      model: modelVar.value ? modelVar.source : null,
      apiKey: keyVar.source,
    },
  }
}

/**
 * One-line, credential-free description of what a component resolved —
 * for startup logs. Names variables and values for provider/model only;
 * the key is reported as present/absent and by source name, never echoed.
 */
export function describeLlmModelConfig(config: LlmModelConfig): string {
  const model = config.sources?.model
    ? `${config.model} (${config.sources.model})`
    : `${config.model} (provider default)`
  const provider = config.sources?.provider
    ? `${config.provider} (${config.sources.provider})`
    : config.provider
  const key = config.sources?.apiKey ? `key from ${config.sources.apiKey}` : "key set"
  return `provider ${provider}, model ${model}, ${key}`
}

/**
 * specs/051-planning-retirement-and-required-key/spec.md §2 — the startup
 * key requirement. A pure resolver: given the components that WILL make a
 * call this run and env, says which have no resolvable key and which have
 * a genuine configuration error. Deciding *which* components need checking
 * (the Orchestrator when it's starting, each agent whose own harness is on)
 * is the caller's job — that's supervisor-specific "what is this run
 * actually starting" logic, not something this provider-neutral module
 * should know about.
 *
 * Built on the exact same `readLlmModelConfig()` a component's own runtime
 * path already calls, so this check and reality cannot disagree about what
 * "configured" means — the two were already the same call for the one
 * caller this pattern is copied from
 * (`supervisorShouldFallBackToPlanning()` in `apps/orchestrator/index.ts`,
 * removed by this same spec's Phase 3 once it has this replacement).
 *
 * `missing` (no credential at all) and `misconfigured` (a real error —
 * `readLlmModelConfig()` throws for an invalid provider or a
 * gemini-without-a-model) are reported separately: they need different
 * messages. "No key configured" points at `orchestrai init`; a
 * misconfiguration needs to name the actual broken field, which the
 * "please set a key" message would not tell you.
 */
export interface StartupKeyRequirement {
  component: LlmComponent
  /** Why this component is being checked, for the refusal message —
   *  e.g. "the only plan-task planner" or "DevOps LLM harness is on". */
  reason: string
}

export interface StartupKeyCheckResult {
  missing: StartupKeyRequirement[]
  misconfigured: (StartupKeyRequirement & { error: string })[]
}

export function checkStartupLlmKeys(
  env: Record<string, string | undefined>,
  requirements: StartupKeyRequirement[],
): StartupKeyCheckResult {
  const missing: StartupKeyRequirement[] = []
  const misconfigured: (StartupKeyRequirement & { error: string })[] = []
  for (const requirement of requirements) {
    try {
      if (readLlmModelConfig(env, requirement.component) === null) missing.push(requirement)
    } catch (err) {
      misconfigured.push({ ...requirement, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { missing, misconfigured }
}

// ============================================================
// specs/055-provider-call-budgets-and-transient-error-handling/spec.md
// ============================================================
// Live-caught, 2026-09-05: a real dockerize run under the adaptive
// supervisor failed with a Gemini free-tier 429 partway through a
// multi-step plan, in the exact same {"status":"failed", error} shape a
// permanently invalid key produces — no way to tell "wrong key" from
// "try again in a minute." One classification function, one bounded-
// retry wrapper, used from every real provider-call site in this
// codebase, rather than one copy per caller.

export type ProviderErrorClass = "transient" | "terminal"

/** The minimal shape this module actually reads off a caught error —
 *  deliberately loose, since the real error objects @langchain/anthropic/
 *  openai/google's own HTTP clients throw are not typed as part of this
 *  codebase's own contract with them. */
interface ClassifiableError {
  status?: unknown
  statusCode?: unknown
  code?: unknown
  message?: unknown
  headers?: unknown
}

// 429 (rate limit) and 5xx (server-side) are the classic "this resolves
// itself" shapes across all three providers' own HTTP APIs. 400/401/403/
//404 (bad request, auth, forbidden, not-found-model) are terminal — no
// amount of waiting fixes a malformed request or a bad key.
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504])
const TRANSIENT_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"])
const TRANSIENT_MESSAGE_PATTERN = /rate.?limit|too many requests|\b429\b|\b5\d\d\b|timed?\s*out|connection reset|overloaded|service unavailable|temporarily unavailable/i

function toClassifiable(err: unknown): ClassifiableError | null {
  return err && typeof err === "object" ? (err as ClassifiableError) : null
}

/**
 * Classifies a caught error from a real provider call as `transient`
 * (worth retrying — rate limit, timeout, connection reset, 5xx) or
 * `terminal` (auth failure, invalid model, malformed request — retrying
 * changes nothing). Never throws; an unrecognized shape defaults to
 * `terminal`, the same fail-closed-by-default precedent
 * `classifySkillTier()` (specs/028/060) already established for an
 * unregistered skill.
 */
export function classifyProviderError(err: unknown): ProviderErrorClass {
  const e = toClassifiable(err)
  if (!e) return "terminal"

  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined
  if (status !== undefined) return TRANSIENT_STATUS_CODES.has(status) ? "transient" : "terminal"

  if (typeof e.code === "string" && TRANSIENT_ERROR_CODES.has(e.code)) return "transient"

  if (typeof e.message === "string" && TRANSIENT_MESSAGE_PATTERN.test(e.message)) return "transient"

  return "terminal"
}

/** Honors a provider's own `Retry-After` header when present (seconds, or
 *  an HTTP-date) — `null` when absent or unparseable, letting the caller
 *  fall back to its own exponential backoff instead. */
export function extractRetryAfterMs(err: unknown): number | null {
  const e = toClassifiable(err)
  if (!e || !e.headers) return null

  let raw: unknown
  const headers = e.headers as { get?: (name: string) => string | null } | Record<string, unknown>
  if (typeof (headers as { get?: unknown }).get === "function") {
    raw = (headers as { get: (name: string) => string | null }).get("retry-after")
  } else {
    raw = (headers as Record<string, unknown>)["retry-after"] ?? (headers as Record<string, unknown>)["Retry-After"]
  }
  if (typeof raw !== "string" || !raw) return null

  const asSeconds = Number(raw)
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000)

  const asDate = Date.parse(raw)
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now())

  return null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Raised only after a transient error's retries are exhausted — a
 *  distinguishable, named provider state from a genuine auth failure
 *  (which throws its own original error, unmodified), per this spec's
 *  own explicit Acceptance Criterion. */
export class ProviderRetriesExhaustedError extends Error {
  constructor(attempts: number, public readonly cause: unknown) {
    super(`Provider call failed after ${attempts} attempt(s) due to a transient error (rate limit, timeout, or server error) and retries were exhausted: ${errorMessage(cause)}`)
    this.name = "ProviderRetriesExhaustedError"
  }
}

export interface CallProviderWithRetryOptions {
  /** Retries beyond the first attempt — 2 means up to 3 total attempts.
   *  Bounded; never unbounded. */
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Injectable for tests only — real callers never pass these. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export const DEFAULT_RETRY_MAX_RETRIES = 2
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000
export const DEFAULT_RETRY_MAX_DELAY_MS = 20_000

/**
 * Wraps a single real provider call with classification + bounded
 * exponential backoff (with jitter), retrying only `transient` failures.
 * A `terminal` failure re-throws immediately, byte-identical to calling
 * `fn()` directly — zero added latency, zero retry attempts, matching
 * this spec's own explicit constraint that terminal-error behavior is
 * unchanged. Never an unbounded wait or an unbounded retry count: both
 * `maxRetries` and `maxDelayMs` cap this deterministically, the same
 * "bounded, never hang" precedent `specs/045`'s port-preflight timeout
 * and the adaptive supervisor's own dispatch/attempt bounds
 * (`specs/028`) already established.
 */
export async function callProviderWithRetry<T>(fn: () => Promise<T>, options: CallProviderWithRetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_RETRY_MAX_RETRIES
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random

  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (err) {
      const classification = classifyProviderError(err)
      if (classification === "terminal") throw err
      if (attempt >= maxRetries) throw new ProviderRetriesExhaustedError(attempt + 1, err)

      const retryAfterMs = extractRetryAfterMs(err)
      const backoff = retryAfterMs ?? baseDelayMs * 2 ** attempt
      const bounded = Math.min(maxDelayMs, backoff)
      // 50%-100% of the bounded backoff — jitter avoids every failed
      // caller retrying in lockstep, never zero-wait, never unbounded.
      const withJitter = bounded * (0.5 + random() * 0.5)
      await sleep(Math.min(maxDelayMs, withJitter))
      attempt += 1
    }
  }
}

/**
 * Construct, but do not invoke, the selected provider adapter. Dynamic
 * imports keep unused adapters unevaluated and preserve the inert import
 * behavior required by Spec 029.
 */
export async function buildChatModel(config: LlmModelConfig): Promise<BaseChatModel> {
  if (config.provider === "anthropic") {
    const { ChatAnthropic } = await import("@langchain/anthropic")
    return new ChatAnthropic({ model: config.model, apiKey: config.apiKey }) as unknown as BaseChatModel
  }

  if (config.provider === "openai") {
    const { ChatOpenAI } = await import("@langchain/openai")
    return new ChatOpenAI({ model: config.model, apiKey: config.apiKey }) as unknown as BaseChatModel
  }

  const { ChatGoogle } = await import("@langchain/google/node")
  return new ChatGoogle({ model: config.model, apiKey: config.apiKey }) as unknown as BaseChatModel
}
