// specs/044-conversational-ask-layer/spec.md — Phase 1.
// Amended by specs/075-real-conversational-chat/spec.md: the two
// hardcoded Tier 0 pattern lists (CAPABILITY_PATTERNS/RECENT_TASK_PATTERNS)
// are deleted. Tier 0 is now decided by the same LLM classification that
// already names a skill for real work (packages/shared/capability-router.ts,
// specs/054/065) — its closed `kind` enum gained "state-question" and
// "conversation" for exactly this. One call, one source of truth for
// "does this even name work" and "which work", instead of a narrower
// pattern list layered in front of the real router.
//
// This module deliberately does NOT own any read-only/write-capable
// knowledge of its own. SKILL_TIER_REGISTRY (apps/orchestrator/
// supervisor-graph.ts, specs/028) is the single source of truth, already
// fail-closed by its own documented rule ("a skill that can ever write
// must never be registered read-only"). A skill absent from it — today
// `plan-task` and `suggest-agents` — resolves to Tier 1, the same
// conservative default the supervisor's own classifier already applies.
// Duplicating the tier table here to "fix" that would create exactly the
// kind of drift this repo has already been bitten by (the three
// independent copies of the `ci`-substring bug, specs/015).
//
// The classifier is injected rather than imported: index.ts imports this
// module, so importing it back would be a genuine circular import. The
// injection also lets the tests exercise every branch without pulling in
// the whole Orchestrator module or a live model — the same reasoning
// specs/028 used for SupervisorDeps.
import { SKILL_TIER_REGISTRY } from "./supervisor-graph"
import type { CapabilityRouterProposal } from "../../packages/shared/capability-router"

/** Injected classifier — always the Orchestrator's own
 *  `classifyRouterProposal()`, unchanged. Returns null on any router
 *  failure (no online capability, no resolvable key, exhausted retries,
 *  malformed response) — classifyAsk() treats that as "couldn't tell",
 *  never a guess and never a silent plan-task dispatch. */
export type ProposalClassifier = (text: string) => Promise<CapabilityRouterProposal | null>

/** 0 = answerable from the Orchestrator's own live state, no dispatch.
 *  2 = a read-only skill must run; no approval.
 *  1 = a write-capable skill must run; the existing approval gate applies. */
export type AnswerTier = 0 | 1 | 2

/** The closed set of Tier 0 outcomes — no dispatch, no skill involved.
 *  "state" covers both capability and recent-task questions (the router's
 *  own `kind: "state-question"` no longer distinguishes the two — see
 *  buildStateAnswer() in index.ts, which answers with both). "conversation"
 *  is a greeting/thanks/chit-chat with no actionable intent. "failure" is
 *  specs/091's own addition — asking why a recent task failed or what went
 *  wrong; answered from the real most-recently-failed task's own error,
 *  not the generic roster+list "state" answer. "unclear" is the
 *  router-failure/couldn't-classify case — never a guess, never a
 *  dispatch. */
export type StateIntent = "state" | "conversation" | "failure" | "unclear"

export interface AskClassification {
  tier: AnswerTier
  /** Present for tiers 1 and 2 — the skill that must run. */
  skill?: string
  /** Present for tier 0 only. */
  stateIntent?: StateIntent
  /** Short machine-readable tag naming why this tier was chosen, for
   *  debugging and for the clients to surface. Never free-form prose. */
  reason: string
  /** Tiers 1 and 2: the text actually dispatched. Differs from the raw
   *  question when a follow-up reused an earlier turn's request, or the
   *  router rewrote a contextual reply (specs/128). */
  dispatchText?: string
}

export interface AskContext {
  /** The most recent skill this conversation dispatched, if any. */
  previousSkill?: string
  /** The text that produced `previousSkill`, replayed verbatim on reuse
   *  so the target path and every other clause survive the follow-up. */
  previousText?: string
}

// ============================================================
// FOLLOW-UPS
// ============================================================
// Resolved with an explicit, closed pattern set rather than anything
// inferential — a deterministic layer should not guess what "it" refers
// to. Richer reference resolution remains future work (specs/075 Non-
// Goals, carried over from specs/044 Phase 1).
const FOLLOW_UP_PATTERN = /^(?:run (?:it|that) again|do (?:it|that) again|again|repeat(?: that)?|same(?: again)?)[.!?]*$/i

export function isFollowUpRequest(question: string): boolean {
  return FOLLOW_UP_PATTERN.test(question.trim())
}

/** Resolve a skill to its tier using SKILL_TIER_REGISTRY alone. An
 *  unregistered skill is Tier 1 — never Tier 2 — matching the registry's
 *  own conservative-default rule. */
export function tierForSkill(skill: string): AnswerTier {
  return SKILL_TIER_REGISTRY[skill] === "read-only" ? 2 : 1
}

/**
 * Classify one question. `classify()` is the Orchestrator's own
 * `classifyRouterProposal()`, reused unchanged — the exact same live
 * capability snapshot and validation a real `POST /tasks` dispatch uses
 * (specs/054's own validate-before-trust rule). A genuine work request
 * still routes, dispatches, and gates identically to before this spec
 * (specs/075 Safety Constraints).
 */
export async function classifyAsk(
  question: string,
  classify: ProposalClassifier,
  context: AskContext = {},
): Promise<AskClassification> {
  const trimmed = question.trim()

  // 1. Follow-up reuse, before anything else — "again" carries no
  //    classifiable content of its own and would otherwise reach the
  //    router with nothing to go on.
  if (isFollowUpRequest(trimmed) && context.previousSkill) {
    return {
      tier: tierForSkill(context.previousSkill),
      skill: context.previousSkill,
      reason: `followup:reuse:${context.previousSkill}`,
      dispatchText: context.previousText ?? trimmed,
    }
  }

  // 2. One LLM classification decides everything else (specs/075) — no
  //    hardcoded pattern list any more.
  const proposal = await classify(trimmed)

  if (!proposal) {
    // Router unreachable, misconfigured, or exhausted retries — never
    // guess, never silently dispatch a project-wide plan-task. A
    // deterministic "couldn't tell" answer instead.
    return { tier: 0, stateIntent: "unclear", reason: "router:unavailable" }
  }

  if (proposal.kind === "state-question") {
    return { tier: 0, stateIntent: "state", reason: "state:question" }
  }
  if (proposal.kind === "failure-question") {
    return { tier: 0, stateIntent: "failure", reason: "state:failure" }
  }
  if (proposal.kind === "conversation") {
    return { tier: 0, stateIntent: "conversation", reason: "state:conversation" }
  }

  // "unsupported" | "read-only" | "state-changing" — real dispatch path,
  // byte-identical to before this spec. "unsupported" still means "no
  // single skill fits" and is still worth trying through plan-task's own
  // adaptive multi-step planning — exactly what POST /tasks already does
  // for the identical proposal, never downgraded to a guess here.
  const skill = proposal.kind === "unsupported" ? "plan-task" : proposal.skillId
  const tier = tierForSkill(skill)
  // specs/128 — the router saw the conversation; when it rewrote a
  // contextual reply ("yes") into a self-contained request, the agent
  // gets that rewrite instead of the bare word.
  const resolved = proposal.resolvedRequest?.trim()
  return {
    tier,
    skill,
    reason: `skill:${skill}:${tier === 2 ? "read-only" : "write-capable"}`,
    dispatchText: resolved || trimmed,
  }
}
