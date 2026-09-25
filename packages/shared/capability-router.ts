// specs/054-capability-driven-llm-routing/spec.md
//
// A third, strictly subordinate routing tier: consulted only when both
// detectSkill()'s keyword stage and the local Model2Vec semantic
// classifier (specs/020) miss. Deliberately NOT a LangGraph StateGraph,
// the same reasoning packages/agents/security/llm-harness.ts already
// used for its own additive-commentary harness: there is no tool to call
// here, no "call a tool, observe, decide again" loop to build — this is
// a single structured-output completion with a plain bounded
// retry-with-feedback loop, built on the same shared, inert-until-called
// buildChatModel().
//
// The router NAMES a skill id; it never decides what that skill is
// allowed to do. Existing skill identifiers are the entire compatibility
// surface — the caller (apps/orchestrator/index.ts's detectSkill())
// validates the proposal against the live capability snapshot before
// ever using it, exactly like every other skill decision already is.
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { z } from "zod"
import type { CapabilityEntry } from "./task-envelope"
import { callProviderWithRetry } from "./llm-model-factory"

const MAX_RETRIES = 2

// The sentinel the router names when nothing in the live snapshot fits —
// never a free-form string the Orchestrator has to interpret, and never
// confused with a real skill id (no real skill id in this codebase is or
// will ever be named "unsupported").
export const UNSUPPORTED_SKILL_ID = "unsupported"

export const CapabilityRouterProposalSchema = z.object({
  skillId: z.string().min(1),
  target: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  // specs/075-real-conversational-chat/spec.md added "state-question"
  // and "conversation" — a request asking what OrchestrAI/its agents
  // can do or about recent task history, or one with no actionable
  // intent at all (a greeting, thanks, chit-chat), respectively.
  // detectSkill() (POST /tasks) maps both to the existing "plan-task"
  // fallback, byte-identical to how "unsupported" already does; only
  // /ask's classifyAsk() reads them to answer without dispatching.
  //
  // specs/091-chat-explain-last-failure/spec.md added "failure-question"
  // — asking why a recent task failed or what went wrong. Same
  // treatment as the other two Tier 0 kinds: detectSkill() falls
  // through to "plan-task" via the existing catch-all (kind !==
  // "read-only" && kind !== "state-changing"), no code change needed
  // there; only /ask's classifyAsk() reads it specifically.
  kind: z.enum(["read-only", "state-changing", "unsupported", "state-question", "conversation", "failure-question"]),
  // specs/128 — only asked for when prior turns are shown: the LAST
  // message rewritten as a self-contained request ("yes" → the original
  // instruction), so the agent receives what the user actually meant.
  resolvedRequest: z.string().nullable().optional(),
})
export type CapabilityRouterProposal = z.infer<typeof CapabilityRouterProposalSchema>

interface ValidationResult {
  ok: boolean
  value?: CapabilityRouterProposal
  error?: string
}

/** Mirrors packages/agents/security/llm-harness.ts's parseAndValidate() —
 *  strips a markdown code fence if the model wrapped its JSON in one,
 *  then parses and validates against the schema. */
function parseAndValidate(rawText: string): ValidationResult {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    return { ok: false, error: `Response is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Respond with ONLY a JSON object, no other text.` }
  }

  const result = CapabilityRouterProposalSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    return { ok: false, error: `Response does not match the required shape: ${issues}` }
  }
  return { ok: true, value: result.data }
}

export interface RunCapabilityRouterOptions {
  model: BaseChatModel
  text: string
  /** The current, live buildCapabilitySnapshot() output — never a
   *  separately hardcoded ownership list, so the router can never
   *  propose a skill that isn't genuinely online right now. Still
   *  excludes plan-task (normalizeAgentCapabilities()'s own
   *  EXCLUDED_SKILL_IDS) — a step naming plan-task would mean
   *  dispatching back to this same planner, out of scope entirely.
   *  specs/065-llm-only-skill-routing/spec.md un-excluded
   *  "suggest-agents" from that same list, so it can appear here too. */
  capabilities: CapabilityEntry[]
  maxRetries?: number
  // specs/092-router-classification-conversation-context/spec.md — bounded
  // prior conversation turns (the exact same shape and helper,
  // priorTurnsFor(), that answer-harness.ts's own synthesizeAnswer() call
  // already uses), oldest first. Absent or empty produces a byte-identical
  // prompt to before this spec — POST /tasks never passes this at all,
  // and a genuinely fresh /ask conversation has nothing to pass either.
  priorTurns?: { role: "user" | "assistant"; text: string }[]
  // specs/128 — the full text of the most recent task this conversation
  // actually dispatched, which can have scrolled out of priorTurns'
  // bounded window. Shown only alongside priorTurns.
  lastRequest?: string
}

// specs/121-skill-description-grounded-routing/spec.md — one line per
// distinct skill id, `<skillId>: <description>` when a description is
// present (bare `<skillId>` otherwise — e.g. the synthetic
// orchestrator/suggest-agents entry), sorted the same deterministic way
// bare ids were sorted before this spec. Two entries can share a skill id
// only via a data race the caller's own normalizeAgentCapabilities()
// already refuses upstream; the first description encountered wins here,
// which never happens in practice.
function renderSkillLines(capabilities: CapabilityEntry[]): string[] {
  const descriptionById = new Map<string, string | undefined>()
  for (const c of capabilities) {
    if (!descriptionById.has(c.skillId)) descriptionById.set(c.skillId, c.description)
  }
  return Array.from(descriptionById.keys())
    .sort()
    .map((id) => {
      const description = descriptionById.get(id)
      return description ? `${id}: ${description}` : id
    })
}

export function buildSystemPrompt(capabilities: CapabilityEntry[], hasPriorTurns = false): string {
  const skillLines = renderSkillLines(capabilities)
  const lines = [
    // specs/065-llm-only-skill-routing/spec.md — this used to say
    // "consulted only after keyword matching and a local semantic
    // classifier both found no confident match"; both tiers were
    // retired, and this is now the only routing mechanism there is.
    `You are the routing tier for OrchestrAI's Orchestrator — the only mechanism that decides which skill a request maps to.`,
    `Your ONLY job is to name which single skill this request most likely wants, from the exact list below — you never decide what that skill is allowed to do, and you never invent a skill id not in this list.`,
    // specs/121 — each line is "<skillId>: <description>" (or a bare id
    // with no description); read the description carefully when two ids
    // look similar (e.g. a singular vs plural pair) — it is the only
    // thing that distinguishes what each one can actually do.
    `Currently online skills:\n${skillLines.length > 0 ? skillLines.map((l) => `  - ${l}`).join("\n") : "  (none currently online)"}`,
    `If none of them genuinely fit this request, respond with skillId "${UNSUPPORTED_SKILL_ID}" — never guess a plausible-sounding skill id that isn't in the list.`,
    // specs/075-real-conversational-chat/spec.md — two more closed kind
    // values, so a conversational Ask endpoint can answer without ever
    // dispatching a project-wide plan-task for a greeting or a status
    // question. For both, skillId must still be set to the unsupported
    // sentinel (no real skill applies) — kind is what a caller actually
    // branches on for these two cases.
    `If the request is asking what OrchestrAI or its agents can do, or about recent task history, respond with kind "state-question" and skillId "${UNSUPPORTED_SKILL_ID}".`,
    `If the request is specifically asking why a recent task failed or what went wrong, respond with kind "failure-question" and skillId "${UNSUPPORTED_SKILL_ID}".`,
    `If the request is a greeting, thanks, small talk, or otherwise has no actionable intent at all, respond with kind "conversation" and skillId "${UNSUPPORTED_SKILL_ID}".`,
    `Otherwise, pick a real skill id from the list (kind "read-only" or "state-changing"), or "${UNSUPPORTED_SKILL_ID}" with kind "unsupported" if the request names real work but no current skill fits it.`,
    // specs/096-router-multi-concern-request-detection/spec.md — the
    // router's job is to name ONE skill; a request that genuinely needs
    // more than one (not just phrased with "and") has no single correct
    // answer here and must not be forced into picking whichever concern
    // seems "most likely." Deliberately reuses the existing
    // "unsupported" sentinel/kind rather than a new kind value — it
    // already means "no single skill directly answers this" and already
    // falls through to plan-task's adaptive supervisor, which decides
    // each step from what the previous one actually returned and can
    // dispatch several independent read-only steps in one turn.
    `If the request names two or more genuinely distinct concerns that would each need a DIFFERENT skill to address (for example, asking about both test coverage and security issues in the same message), respond with kind "unsupported" and skillId "${UNSUPPORTED_SKILL_ID}" — do not pick just one of them. Example: "is there test coverage and are there any security issues?" needs both check-coverage and a security skill, so respond unsupported rather than choosing only one. This is different from a request that merely uses the word "and" while describing ONE concern (e.g. "check the coverage and tell me the percentage" is one concern, phrased with "and" — pick the one real skill normally).`,
    // specs/092-router-classification-conversation-context/spec.md — the
    // load-bearing safety guard: history helps interpret a short/
    // ambiguous reply, but must never make a genuinely new, unrelated
    // request get misread as a continuation of an old topic.
    `If earlier conversation turns are shown below, use them only as context to understand what the LAST message refers to (e.g. a short reply answering a question just asked). Always classify the LAST message itself — never let earlier turns override what it actually, currently asks for.`,
    `Respond with ONLY a single JSON object matching this shape: { "skillId": <one of the listed skill ids, or "${UNSUPPORTED_SKILL_ID}">, "target": <absolute path string if one is present in the request, or null>, "confidence": <number 0 to 1>, "reason": <short string>, "kind": <"read-only" | "state-changing" | "unsupported" | "state-question" | "conversation" | "failure-question"> }. No other text, no markdown code fence.`,
  ]
  // specs/128 — only with history, so a history-free call (POST /tasks)
  // keeps its prompt byte-identical. The routed skill receives this text
  // instead of the raw message, so a bare "yes" carries the instruction
  // it agrees to.
  if (hasPriorTurns) {
    lines.push(
      `Also include "resolvedRequest" in that JSON object. If the LAST message only makes sense together with the earlier turns (for example "yes", "go ahead", "try again", or "do the same for utils.ts"), set it to ONE complete, self-contained request that someone who never saw this conversation could act on. Start from the earlier request's own words (the "most recent request actually run", when shown, is its exact full text), keep every detail of it (app type, file names, paths, options) unchanged, and change only what the LAST message explicitly changes — e.g. "dockerize my bun app on port 4000" followed by "do the same but on port 5050" becomes "dockerize my bun app on port 5050". Never paraphrase, and never invent anything the turns shown don't contain. If the LAST message is already self-contained, or kind is "state-question", "failure-question", or "conversation", set it to null.`,
    )
  }
  return lines.join("\n")
}

// specs/092-router-classification-conversation-context/spec.md — mirrors
// answer-harness.ts's own buildUserPrompt() exactly: a bounded prose
// "Earlier in this conversation" block prepended to the message, guarded
// so absent/empty history produces the byte-identical bare message this
// function already returned before this spec.
export function buildHumanPrompt(text: string, priorTurns?: RunCapabilityRouterOptions["priorTurns"], lastRequest?: string): string {
  if (!priorTurns?.length) return text
  const parts: string[] = ["Earlier in this conversation:"]
  for (const turn of priorTurns) parts.push(`  ${turn.role}: ${turn.text}`)
  parts.push("")
  if (lastRequest?.trim()) {
    parts.push(`Most recent request actually run in this conversation (full text): ${lastRequest.trim()}`)
    parts.push("")
  }
  parts.push(`Message to classify: ${text}`)
  return parts.join("\n")
}

/** Fails closed to null on exhausted retries or any run failure — never a
 *  guessed or partial proposal. The caller (detectSkill()) treats null
 *  identically to an "unsupported" proposal: fall through to the
 *  existing plan-task default. */
export async function runCapabilityRouter(options: RunCapabilityRouterOptions): Promise<CapabilityRouterProposal | null> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const messages: BaseMessage[] = [
    new SystemMessage(buildSystemPrompt(options.capabilities, Boolean(options.priorTurns?.length))),
    new HumanMessage(buildHumanPrompt(options.text, options.priorTurns, options.lastRequest)),
  ]

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

    const result = parseAndValidate(responseText)
    if (result.ok) return result.value ?? null

    if (attempt >= maxRetries) return null // exhausted retries — fail closed.

    messages.push(new AIMessage(responseText))
    messages.push(new HumanMessage(`Your last response was invalid: ${result.error}\nRespond again with the corrected JSON object only.`))
  }

  return null
}
