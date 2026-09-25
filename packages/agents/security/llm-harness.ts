// specs/043-llm-harness-security/spec.md
//
// Opt-in LLM enrichment for Security's three read-only skills. Disabled by
// default (ORCHESTRAI_SECURITY_LLM_HARNESS unset) — see index.ts's branch
// into this module. Everything in here is strictly ADDITIVE commentary on
// findings the deterministic scan already produced (packages/agents/
// security/index.ts's skillScanSecrets/skillCheckGitignoreCoverage/
// skillAuditDependencies, all completely unmodified by this file): the
// output schemas below have no field that could mean "delete finding N" or
// "lower this finding's confidence" — only additive fields. The
// deterministic findings are always computed first and are never filtered,
// reordered, or suppressed by anything returned from here.
//
// Deliberately NOT a LangGraph StateGraph, unlike specs/026/041/042: those
// harnesses' use of LangGraph was specifically for the multi-turn
// "call a tool, observe, decide again" loop. Security gets no new tool
// access in this checkpoint (no evidence-backed need found — see the
// spec's "No new tool access" section), so there is nothing to loop
// against; this is a single structured-output completion per skill, with a
// plain bounded retry-with-feedback loop implemented directly, built on
// the same shared, inert-until-called buildChatModel().
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { z } from "zod"
import { callProviderWithRetry } from "../../shared/llm-model-factory"

const MAX_RETRIES = 2

// ============================================================
// OUTPUT SHAPES AND VALIDATION
// ============================================================
export const ScanSecretsEnrichmentSchema = z.object({
  perFinding: z.array(
    z.object({
      findingIndex: z.number().int().nonnegative(),
      likelyFalsePositive: z.boolean(),
      note: z.string().min(1),
    }),
  ),
  summary: z.string().optional(),
})
export type ScanSecretsEnrichment = z.infer<typeof ScanSecretsEnrichmentSchema>

export const GitignoreEnrichmentSchema = z.object({
  additionalSuggestions: z.array(
    z.object({
      pattern: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
})
export type GitignoreEnrichment = z.infer<typeof GitignoreEnrichmentSchema>

export const AuditDependenciesEnrichmentSchema = z.object({
  generalNotes: z.array(z.string().min(1)),
})
export type AuditDependenciesEnrichment = z.infer<typeof AuditDependenciesEnrichmentSchema>

export interface ValidationResult<T> {
  ok: boolean
  value?: T
  error?: string
}

/** Strips a markdown code fence if the model wrapped its JSON in one, then
 *  parses and validates against the given schema. Mirrors
 *  packages/agents/devops/llm-harness.ts's validateJsonParams(). */
function parseAndValidate<T>(rawText: string, schema: z.ZodType<T>): ValidationResult<T> {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    return { ok: false, error: `Response is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Respond with ONLY a JSON object, no other text.` }
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    return { ok: false, error: `Response does not match the required shape: ${issues}` }
  }
  return { ok: true, value: result.data }
}

// specs/043 — a specific CVE identifier or an explicit version-range
// comparison implies live vulnerability-database knowledge this harness
// does not have (no npm audit / OSV / CVE feed integration exists
// anywhere in this codebase). Checked structurally, not left to a prompt
// instruction alone — the same enforcement style READ_ONLY_TOOL_NAMES
// uses elsewhere in this repo.
const CVE_PATTERN = /CVE-\d{4}-\d+/i
// Matches a version-range comparison in either written order — "< 4.17.21"
// or "4.17.21 <" — since a model may phrase it either way.
const VERSION_RANGE_CLAIM_PATTERN = /(?:[<>]=?\s*v?\d+\.\d+\.\d+)|(?:v?\d+\.\d+\.\d+\s*[<>]=?)/

export function containsForbiddenVulnerabilityClaim(text: string): boolean {
  return CVE_PATTERN.test(text) || VERSION_RANGE_CLAIM_PATTERN.test(text)
}

function validateAuditDependenciesOutput(rawText: string): ValidationResult<AuditDependenciesEnrichment> {
  const parsed = parseAndValidate(rawText, AuditDependenciesEnrichmentSchema)
  if (!parsed.ok || !parsed.value) return parsed

  const offending = parsed.value.generalNotes.find(containsForbiddenVulnerabilityClaim)
  if (offending) {
    return {
      ok: false,
      error:
        `A note asserted a specific CVE identifier or version-range vulnerability claim ` +
        `("${offending}"), which you cannot verify — you have no live vulnerability database ` +
        `access. Respond again with only general, non-specific risk commentary (e.g. about ` +
        `unpinned versions or naming risk), never a specific CVE or version range.`,
    }
  }
  return parsed
}

// ============================================================
// RETRY-WITH-FEEDBACK CORE (shared by all three entry points)
// ============================================================
interface RunEnrichmentOptions<T> {
  model: BaseChatModel
  systemPrompt: string
  userPrompt: string
  validate: (rawText: string) => ValidationResult<T>
  maxRetries?: number
}

/** Fails closed to null on exhausted retries or any run failure — never a
 *  guessed or partial enrichment result. index.ts's caller distinguishes
 *  null from a thrown error, but treats both the same way: the report
 *  still completes with its deterministic findings intact, plus a visible
 *  "AI commentary unavailable" line — see the spec's "Fail-open-on-report,
 *  fail-closed-on-claim" section for why this differs from specs/026/041/
 *  042's "fail the whole task" precedent. */
async function runEnrichment<T>(options: RunEnrichmentOptions<T>): Promise<T | null> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const messages: BaseMessage[] = [new SystemMessage(options.systemPrompt), new HumanMessage(options.userPrompt)]

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let responseText: string
    try {
      // specs/055-provider-call-budgets-and-transient-error-handling/spec.md
      // — retries a transient provider failure (rate limit, timeout, 5xx)
      // with bounded backoff; a terminal failure re-throws immediately,
      // unchanged from before this spec, and still falls into the
      // existing fail-closed catch below.
      const response = await callProviderWithRetry(() => options.model.invoke(messages))
      responseText = typeof response.content === "string" ? response.content : String(response.content)
    } catch {
      return null // API error, timeout, etc. — fail closed, no retry against a broken connection.
    }

    const result = options.validate(responseText)
    if (result.ok) return result.value ?? null

    if (attempt >= maxRetries) return null // exhausted retries — fail closed.

    messages.push(new AIMessage(responseText))
    messages.push(new HumanMessage(`Your last response was invalid: ${result.error}\nRespond again with the corrected JSON object only.`))
  }

  return null
}

function jsonInstruction(shapeDescription: string): string {
  return `Respond with ONLY a single JSON object matching this shape: ${shapeDescription}. No other text, no markdown code fence.`
}

// ============================================================
// ENTRY POINT — scan-secrets
// ============================================================
export interface ScanSecretsEnrichmentFinding {
  index: number
  file: string
  line: number
  confidence: string
  label: string
  maskedValue: string
}

export interface RunScanSecretsEnrichmentOptions {
  model: BaseChatModel
  findings: ScanSecretsEnrichmentFinding[]
  maxRetries?: number
}

export async function runScanSecretsEnrichment(options: RunScanSecretsEnrichmentOptions): Promise<ScanSecretsEnrichment | null> {
  const systemPrompt = [
    `You are the Security component of OrchestrAI, reviewing a deterministic secret scan's findings.`,
    `You do NOT run your own scan and you cannot add, remove, or change the confidence of any finding — you only add commentary alongside findings that were already found.`,
    `The deterministic scan already skips a small fixed set of obvious placeholders. Your job is to spot values that are ALSO clearly placeholders/examples/test-fixture values by their shape or file location, even though that fixed list didn't happen to cover them (e.g. "CHANGE_ME_IN_PRODUCTION", "REPLACE_WITH_YOUR_KEY", values inside a __tests__/fixtures path or a README code sample) — and separately flag anything that looks like it could be a genuine, real credential needing urgent attention.`,
    `Only every value you're given is already masked (e.g. "abcd...wxyz") — you never see a real unmasked secret.`,
    jsonInstruction(`{ "perFinding": [{ "findingIndex": <number>, "likelyFalsePositive": <boolean>, "note": <string> }, ...], "summary"?: <string> }`),
    `Include exactly one perFinding entry for every finding index you were given, in any order.`,
  ].join("\n")

  const userPrompt = [
    `Findings (0-indexed):`,
    ...options.findings.map((f) => `[${f.index}] ${f.file}:${f.line} — ${f.confidence} — ${f.label} — value: ${f.maskedValue}`),
  ].join("\n")

  return runEnrichment<ScanSecretsEnrichment>({
    model: options.model,
    systemPrompt,
    userPrompt,
    validate: (rawText) => parseAndValidate(rawText, ScanSecretsEnrichmentSchema),
    maxRetries: options.maxRetries,
  })
}

// ============================================================
// ENTRY POINT — check-gitignore-coverage
// ============================================================
export interface RunGitignoreEnrichmentOptions {
  model: BaseChatModel
  coveredPatterns: string[]
  missingPatterns: string[]
  directoryListing: string[]
  maxRetries?: number
}

export async function runGitignoreEnrichment(options: RunGitignoreEnrichmentOptions): Promise<GitignoreEnrichment | null> {
  const systemPrompt = [
    `You are the Security component of OrchestrAI, reviewing a deterministic .gitignore coverage check.`,
    `The deterministic check only checks a small fixed list of universal patterns (.env, node_modules/, *.key, *.pem, dist/, build/, etc) — it does not look at what's actually in this specific project beyond that.`,
    `You are given a real (shallow) directory listing of the project. Suggest ADDITIONAL patterns worth gitignoring ONLY if you see genuine evidence for them in that listing (e.g. a real "terraform.tfstate" file, a real ".aws/credentials" file, a real "secrets/" directory) — never invent a suggestion with no file evidence.`,
    `You cannot mark a required pattern as covered when it was found missing, and you cannot change any deterministic finding — you only add new suggestions beyond what was already checked.`,
    jsonInstruction(`{ "additionalSuggestions": [{ "pattern": <string>, "reason": <string> }, ...] }`),
    `Return an empty array if you see no genuine evidence for any additional pattern.`,
  ].join("\n")

  const userPrompt = [
    `Already covered: ${options.coveredPatterns.join(", ") || "(none)"}`,
    `Already missing (deterministic — do not re-suggest these, they're already reported): ${options.missingPatterns.join(", ") || "(none)"}`,
    `Project directory listing (shallow):`,
    ...options.directoryListing,
  ].join("\n")

  return runEnrichment<GitignoreEnrichment>({
    model: options.model,
    systemPrompt,
    userPrompt,
    validate: (rawText) => parseAndValidate(rawText, GitignoreEnrichmentSchema),
    maxRetries: options.maxRetries,
  })
}

// ============================================================
// ENTRY POINT — audit-dependencies
// ============================================================
export interface RunAuditDependenciesEnrichmentOptions {
  model: BaseChatModel
  unpinned: { name: string; version: string }[]
  allDependencies: Record<string, string>
  maxRetries?: number
}

export async function runAuditDependenciesEnrichment(options: RunAuditDependenciesEnrichmentOptions): Promise<AuditDependenciesEnrichment | null> {
  const systemPrompt = [
    `You are the Security component of OrchestrAI, reviewing a deterministic dependency audit.`,
    `The deterministic check only flags a version string that is exactly "*" or "latest" — nothing else.`,
    `You have NO live vulnerability database access (no CVE feed, no npm audit, no OSV) — you must NEVER assert a specific CVE identifier or a specific version-range vulnerability claim. Any such claim is unverifiable and forbidden.`,
    `You may add general, non-specific risk commentary — e.g. that an unpinned dependency can silently pull in unreviewed future changes, or that a package name looks like a plausible typosquat of a well-known package you recognize by name alone.`,
    jsonInstruction(`{ "generalNotes": [<string>, ...] }`),
    `Return an empty array if you have nothing genuinely useful to add.`,
  ].join("\n")

  const userPrompt = [
    `Unpinned (deterministic finding, already reported): ${options.unpinned.map((d) => `${d.name}@${d.version}`).join(", ") || "(none)"}`,
    `All dependencies: ${Object.entries(options.allDependencies).map(([n, v]) => `${n}@${v}`).join(", ") || "(none)"}`,
  ].join("\n")

  return runEnrichment<AuditDependenciesEnrichment>({
    model: options.model,
    systemPrompt,
    userPrompt,
    validate: validateAuditDependenciesOutput,
    maxRetries: options.maxRetries,
  })
}
