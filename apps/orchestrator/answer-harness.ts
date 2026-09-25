// specs/044-conversational-ask-layer/spec.md — Phase 2.
//
// Turns material the deterministic path ALREADY produced into a
// natural-language answer to the question that was actually asked. It
// never runs a scan, never picks a skill, never sees an actionId, and
// never decides whether approval is required — all of that is settled
// before this module is reached (ask-classifier.ts + SKILL_TIER_REGISTRY).
//
// Structurally mirrors packages/agents/security/llm-harness.ts, including
// its two deliberate departures from specs/026's graph-based harnesses:
// no LangGraph (there is no tool-calling loop here — one completion, one
// answer), and FAIL OPEN rather than fail closed, because the raw
// deterministic result is already a complete, correct answer on its own.
// Losing the prettier phrasing must never lose the substance.
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { z } from "zod"

const MAX_RETRIES = 2

export const AnswerSchema = z.object({
  answer: z.string().min(1),
})
export type Answer = z.infer<typeof AnswerSchema>

export interface AnswerValidationResult {
  ok: boolean
  answer?: string
  error?: string
}

// ============================================================
// GROUNDING — a bounded numeric check, and nothing more
// ============================================================
// This catches the specific, plausible failure this layer introduces: a
// confident sentence stating a figure the tool never reported ("87%
// coverage" when the run said 82%). It is NOT a general hallucination
// detector and must not be described as one.
//
// The property that actually carries the safety weight is elsewhere and
// is structural: the underlying task's own `result` is never modified or
// hidden by anything here, so the real output is always still there to
// read. This check is a second line, not the line.

const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/g

function numericValues(text: string): number[] {
  return (text.match(NUMBER_PATTERN) ?? []).map(Number).filter(Number.isFinite)
}

/** Every number the source supports, plus each one's rounded form — so an
 *  answer saying "86%" for a source reporting "86.36%" is accepted as
 *  grounded rather than rejected for sensible rounding. */
function groundedValues(source: string): Set<number> {
  const grounded = new Set<number>()
  for (const value of numericValues(source)) {
    grounded.add(value)
    grounded.add(Math.round(value))
  }
  return grounded
}

/** Numbers the answer asserts that the source material does not support. */
export function ungroundedNumbers(answer: string, source: string): number[] {
  const grounded = groundedValues(source)
  return numericValues(answer).filter((value) => !grounded.has(value) && !grounded.has(Math.round(value)))
}

/** Strips a markdown code fence a model may have wrapped its JSON in,
 *  then parses, validates the shape, and applies the grounding check. */
export function validateAnswer(rawText: string, source: string): AnswerValidationResult {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    return {
      ok: false,
      error: `Response is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Respond with ONLY a JSON object, no other text.`,
    }
  }

  const result = AnswerSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    return { ok: false, error: `Response does not match the required shape: ${issues}` }
  }

  const ungrounded = ungroundedNumbers(result.data.answer, source)
  if (ungrounded.length > 0) {
    return {
      ok: false,
      error:
        `Your answer stated ${ungrounded.join(", ")}, which does not appear in the material you were given. ` +
        `Only state figures that are actually present in it. Rewrite the answer using the real numbers, or omit numbers entirely.`,
    }
  }

  return { ok: true, answer: result.data.answer }
}

// ============================================================
// ENTRY POINT
// ============================================================
export interface RunAnswerHarnessOptions {
  model: BaseChatModel
  /** The user's question, verbatim. */
  question: string
  /** The real material to ground in — an agent's actual result text, or
   *  state rendered by the deterministic Tier 0 builders. Never raw
   *  project files the model went and fetched itself; this layer does no
   *  fetching at all. */
  source: string
  /** Earlier turns, oldest first, for pronoun/reference context. */
  priorTurns?: { role: "user" | "assistant"; text: string }[]
  maxRetries?: number
}

function buildSystemPrompt(): string {
  return [
    "You are the conversational layer of OrchestrAI, a multi-agent DevOps assistant.",
    "You are given a user's question and the REAL output that OrchestrAI's own deterministic tooling already produced for it.",
    "Answer the question directly and briefly, in plain language, using only that material.",
    "If the question is a yes/no question, lead with the answer.",
    "Never state a number that does not appear in the material. Never invent a file, tool, result, or recommendation that is not supported by it.",
    "If the material does not actually answer the question, say so plainly rather than guessing.",
    "Do not restate the raw output verbatim — the user can already see it. Summarise what it means for their question.",
    'Respond with ONLY a JSON object of the shape: { "answer": "<your answer>" }. No other text, no markdown code fence.',
  ].join("\n")
}

function buildUserPrompt(options: RunAnswerHarnessOptions): string {
  const parts: string[] = []

  if (options.priorTurns?.length) {
    parts.push("Earlier in this conversation:")
    for (const turn of options.priorTurns) {
      parts.push(`  ${turn.role}: ${turn.text}`)
    }
    parts.push("")
  }

  parts.push(`Question: ${options.question}`)
  parts.push("")
  parts.push("Material produced for this question:")
  parts.push(options.source)

  return parts.join("\n")
}

/**
 * Returns the synthesized answer, or null to mean "use the raw material
 * as-is". Null is the normal, safe outcome for every failure mode — an
 * API error, an unparseable response, or an answer that kept asserting
 * ungrounded figures after its retries. The caller falls back to the
 * deterministic text, which was always the real answer anyway.
 */
export async function runAnswerHarness(options: RunAnswerHarnessOptions): Promise<string | null> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const messages: BaseMessage[] = [
    new SystemMessage(buildSystemPrompt()),
    new HumanMessage(buildUserPrompt(options)),
  ]

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let responseText: string
    try {
      const response = await options.model.invoke(messages)
      responseText = typeof response.content === "string" ? response.content : String(response.content)
    } catch {
      return null // API error/timeout — no retry against a broken connection.
    }

    const result = validateAnswer(responseText, options.source)
    if (result.ok) return result.answer ?? null
    if (attempt >= maxRetries) return null

    messages.push(new HumanMessage(`${result.error}\nRespond again with the corrected JSON object only.`))
  }

  return null
}
