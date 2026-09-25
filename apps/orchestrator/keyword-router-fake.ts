// specs/065-llm-only-skill-routing/spec.md — test support, not runtime.
//
// specs/065 removed keyword matching from detectSkill() entirely, so
// every text-dispatch path now depends on a real LLM router call. That
// broke a wide set of pre-existing tests that dispatch text through the
// real POST /tasks / /ask handlers and assert a SPECIFIC skill was
// chosen — tests about dispatch wiring, the approval gate, snapshot
// caching, etc., which were never meant to be about routing at all and
// used keyword matching only because it happened to be deterministic
// and free.
//
// This fake `BaseChatModel` reproduces the exact keyword decisions
// detectSkill() used to make, wrapped as a capability-router proposal.
// A test injects it via `__setTestRouterModel()` (apps/orchestrator/
// index.ts) so those tests keep asserting the same skills, hermetically,
// with no network call — without every one of them being individually
// rewritten. The router's own real proposal/validation/fail-closed
// behavior is covered separately with scripted fakes in
// capability-router-detect-skill.test.ts.

import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"

const CI_WORD = /(^|\s)ci(\s|$)/

// specs/075-real-conversational-chat/spec.md — the two deleted Tier 0
// pattern lists from apps/orchestrator/ask-classifier.ts, reproduced here
// verbatim so this fake keeps classifying the exact same fixed set of
// phrases the pre-075 hardcoded lists once matched directly, now as the
// router's own "state-question" kind instead of a Tier 0 short-circuit
// bypassing the router entirely. A handful of short greeting/small-talk
// phrases are recognized as "conversation" for the same reason — this
// fake's whole job is reproducing deterministic, pre-existing test
// expectations, never inventing new routing behavior of its own.
const STATE_QUESTION_PATTERNS = [
  "what can you do",
  "what are your capabilities",
  "your capabilities",
  "what agent",
  "which agent",
  "list agent",
  "what skills",
  "which skills",
  "who are you",
  "last task",
  "recent task",
  "previous task",
  "last result",
  "what have you run",
  "what did you run",
]

const CONVERSATION_PATTERNS = [
  "hello",
  "hi there",
  "thanks",
  "thank you",
  "that is what i say",
  "are you working fine",
]

// specs/091-chat-explain-last-failure/spec.md — checked BEFORE
// STATE_QUESTION_PATTERNS above: "last task"/"recent task" are
// substrings of a real phrase like "why did the last task fail",
// which must classify as the new "failure-question" kind, not the
// generic "state-question" one — ordering here is load-bearing.
const FAILURE_QUESTION_PATTERNS = [
  "why did it fail",
  "why it fail",
  "why failed",
  "why fail",
  "what went wrong",
  "what failed",
  "check why fail",
]

function matchesAny(lower: string, patterns: string[]): boolean {
  return patterns.some((p) => lower.includes(p))
}

/** The verbatim keyword ladder detectSkill() carried before specs/065,
 *  returning the skill id it would have picked, or null for "no keyword
 *  matched" (which the old code passed to the classifier, then the
 *  router, then defaulted to plan-task). */
export function keywordSkill(text: string): string | null {
  const lower = text.toLowerCase()
  if (lower.includes("dockerfile") || lower.includes("dockerize")) return "dockerize"
  if (lower.includes("compose")) return "create-compose"
  if (lower.includes("gitignore") && lower.includes("coverage")) return "check-gitignore-coverage"
  if (lower.includes("gitignore")) return "create-gitignore"
  if (lower.includes("analyze") || lower.includes("missing")) return "analyze-project"
  if (lower.includes("git status") || lower.includes("git stat")) return "git-status"
  if (lower.includes("suggest") || lower.includes("what agent")) return "suggest-agents"
  if (
    lower.includes("plan") ||
    lower.includes("build") ||
    lower.includes("deploy") ||
    lower.includes("setup") ||
    lower.includes("set up") ||
    lower.includes("prepare") ||
    lower.includes("production")
  )
    return "plan-task"
  if (lower.includes("secret")) return "scan-secrets"
  if (lower.includes("audit")) return "audit-dependencies"
  if (lower.includes("api") && (lower.includes("document") || lower.includes("doc"))) return "document-api"
  if (lower.includes("readme") || lower.includes("documentation") || lower.includes("docs")) return "generate-readme"
  if (lower.includes("coverage")) return "check-coverage"
  if (lower.includes("run test") || lower.includes("run the test") || lower.includes("test suite")) return "run-tests"
  if (CI_WORD.test(lower) || lower.includes("pipeline") || lower.includes("github action")) return "create-ci"
  return null
}

export class KeywordRouterFake extends BaseChatModel {
  private calls = 0
  constructor() {
    super({})
  }
  _llmType(): string {
    return "keyword-router-fake"
  }
  get callCount(): number {
    return this.calls
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1
    // The router's own prompt puts the request text in the last
    // (human) message; contentToString handles both string and
    // structured content.
    const last = messages[messages.length - 1]
    const rawContent = typeof last?.content === "string" ? last.content : String(last?.content ?? "")
    // specs/092-router-classification-conversation-context/spec.md —
    // when prior turns are present, buildHumanPrompt() prepends them as
    // an "Earlier in this conversation" block before the real message
    // (labeled "Message to classify: "). Real, previously-unnoticed bug
    // found live while testing specs/093: this fake used to keyword-match
    // against that ENTIRE combined text, so a word like "hello" sitting
    // in an embedded PRIOR turn (not the actual current message) could
    // spuriously trigger CONVERSATION_PATTERNS. Strip the label so this
    // fake — like the real router is instructed to — only ever classifies
    // the current message, using history for context alone.
    const messageMarker = "Message to classify: "
    const markerIndex = rawContent.lastIndexOf(messageMarker)
    const text = markerIndex >= 0 ? rawContent.slice(markerIndex + messageMarker.length) : rawContent
    const lower = text.toLowerCase()

    let proposal: string
    if (matchesAny(lower, FAILURE_QUESTION_PATTERNS)) {
      proposal = JSON.stringify({
        skillId: "unsupported",
        target: null,
        confidence: 0.9,
        reason: "keyword-router-fake (test support, specs/091)",
        kind: "failure-question",
      })
    } else if (matchesAny(lower, STATE_QUESTION_PATTERNS)) {
      proposal = JSON.stringify({
        skillId: "unsupported",
        target: null,
        confidence: 0.9,
        reason: "keyword-router-fake (test support, specs/075)",
        kind: "state-question",
      })
    } else if (matchesAny(lower, CONVERSATION_PATTERNS)) {
      proposal = JSON.stringify({
        skillId: "unsupported",
        target: null,
        confidence: 0.9,
        reason: "keyword-router-fake (test support, specs/075)",
        kind: "conversation",
      })
    } else {
      const skill = keywordSkill(text)
      proposal = JSON.stringify({
        skillId: skill ?? "unsupported",
        target: null,
        confidence: skill ? 0.9 : 0.1,
        reason: "keyword-router-fake (test support, specs/065)",
        kind: skill ? "read-only" : "unsupported",
      })
    }
    return { generations: [{ text: proposal, message: new AIMessage(proposal) }] }
  }
}
