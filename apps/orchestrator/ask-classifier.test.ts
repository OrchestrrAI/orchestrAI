// specs/044-conversational-ask-layer/spec.md — Phase 1.
// Rewritten for specs/075-real-conversational-chat/spec.md: the two
// hardcoded pattern lists are gone, so Tier 0 is now exercised via a
// fake router-proposal classifier instead of pattern-matched phrasing.
// The classifier is pure and takes classifyRouterProposal() by
// injection, so every branch is exercised here without importing the
// Orchestrator module or calling a live model.
import { describe, expect, test } from "bun:test"
import { classifyAsk, isFollowUpRequest, tierForSkill, type ProposalClassifier } from "./ask-classifier"
import { SKILL_TIER_REGISTRY } from "./supervisor-graph"
import type { CapabilityRouterProposal } from "../../packages/shared/capability-router"

/** A classifier that returns whatever proposal it was told to, recording
 *  its calls — so a test can prove Tier 0 never consulted the router at
 *  all (the follow-up-reuse path) or exercises exactly one real call
 *  (everything else). */
function fakeClassifier(proposal: CapabilityRouterProposal | null): ProposalClassifier & { calls: string[] } {
  const calls: string[] = []
  const classify = (async (text: string) => {
    calls.push(text)
    return proposal
  }) as ProposalClassifier & { calls: string[] }
  classify.calls = calls
  return classify
}

function proposal(kind: CapabilityRouterProposal["kind"], skillId = "unsupported"): CapabilityRouterProposal {
  return { skillId, target: null, confidence: 0.9, reason: "test", kind }
}

describe("tierForSkill — reuses SKILL_TIER_REGISTRY, never its own table", () => {
  test("every read-only skill in the registry resolves to tier 2", () => {
    const readOnly = Object.entries(SKILL_TIER_REGISTRY)
      .filter(([, tier]) => tier === "read-only")
      .map(([skill]) => skill)

    expect(readOnly.length).toBeGreaterThan(0)
    for (const skill of readOnly) expect(tierForSkill(skill)).toBe(2)
  })

  test("every write-capable skill in the registry resolves to tier 1", () => {
    const writeCapable = Object.entries(SKILL_TIER_REGISTRY)
      .filter(([, tier]) => tier === "write-capable")
      .map(([skill]) => skill)

    expect(writeCapable.length).toBeGreaterThan(0)
    for (const skill of writeCapable) expect(tierForSkill(skill)).toBe(1)
  })

  test("an unregistered skill is tier 1, never tier 2 — the registry's own conservative default", () => {
    expect(tierForSkill("some-brand-new-skill")).toBe(1)
    // plan-task and suggest-agents are genuinely absent from the registry
    // today; both must fail closed rather than be assumed read-only.
    expect(SKILL_TIER_REGISTRY["plan-task"]).toBeUndefined()
    expect(tierForSkill("plan-task")).toBe(1)
    expect(SKILL_TIER_REGISTRY["suggest-agents"]).toBeUndefined()
    expect(tierForSkill("suggest-agents")).toBe(1)
  })
})

describe("tier 0 — the router's kind decides, no hardcoded pattern list any more", () => {
  test("kind 'state-question' is answered from state, zero dispatch", async () => {
    const classify = fakeClassifier(proposal("state-question"))
    const result = await classifyAsk("what agents do you have?", classify)

    expect(result.tier).toBe(0)
    expect(result.stateIntent).toBe("state")
    expect(result.reason).toBe("state:question")
    expect(result.skill).toBeUndefined()
    expect(classify.calls).toEqual(["what agents do you have?"])
  })

  // specs/091-chat-explain-last-failure/spec.md
  test("kind 'failure-question' is answered from state, zero dispatch", async () => {
    const classify = fakeClassifier(proposal("failure-question"))
    const result = await classifyAsk("why did it fail last time?", classify)

    expect(result.tier).toBe(0)
    expect(result.stateIntent).toBe("failure")
    expect(result.reason).toBe("state:failure")
    expect(result.skill).toBeUndefined()
    expect(classify.calls).toEqual(["why did it fail last time?"])
  })

  test("kind 'conversation' is answered directly, zero dispatch", async () => {
    const classify = fakeClassifier(proposal("conversation"))
    const result = await classifyAsk("hello", classify)

    expect(result.tier).toBe(0)
    expect(result.stateIntent).toBe("conversation")
    expect(result.reason).toBe("state:conversation")
    expect(result.skill).toBeUndefined()
  })

  test("a genuine, non-scripted plain retort classifies as conversation, not a work order", async () => {
    // The exact live-caught case from this spec's own drafting: "that is
    // what i say" must not become git-status + analyze-project.
    const classify = fakeClassifier(proposal("conversation"))
    const result = await classifyAsk("that is what i say", classify)
    expect(result.tier).toBe(0)
    expect(result.stateIntent).toBe("conversation")
  })

  test("a null proposal (router unavailable) never guesses or dispatches", async () => {
    const classify = fakeClassifier(null)
    const result = await classifyAsk("anything at all", classify)

    expect(result.tier).toBe(0)
    expect(result.stateIntent).toBe("unclear")
    expect(result.reason).toBe("router:unavailable")
    expect(result.skill).toBeUndefined()
  })
})

describe("tiers 1 and 2 — decided by the registry, not by phrasing", () => {
  test("kind 'read-only' yields tier 2 and needs no approval", async () => {
    const result = await classifyAsk("what's my git status?", fakeClassifier(proposal("read-only", "git-status")))
    expect(result.tier).toBe(2)
    expect(result.skill).toBe("git-status")
    expect(result.reason).toBe("skill:git-status:read-only")
  })

  test("kind 'state-changing' yields tier 1", async () => {
    const result = await classifyAsk("is there test coverage?", fakeClassifier(proposal("state-changing", "check-coverage")))
    expect(result.tier).toBe(1)
    expect(result.skill).toBe("check-coverage")
    expect(result.reason).toBe("skill:check-coverage:write-capable")
  })

  test("kind 'unsupported' still tries plan-task — genuine work the router just couldn't map to one skill", async () => {
    const result = await classifyAsk("deploy this to a platform nothing here supports", fakeClassifier(proposal("unsupported")))
    expect(result.tier).toBe(1)
    expect(result.skill).toBe("plan-task")
    expect(result.reason).toBe("skill:plan-task:write-capable")
  })

  test("the question's phrasing never changes the tier — only the proposal's kind/skill does", async () => {
    const asQuestion = await classifyAsk("is there test coverage?", fakeClassifier(proposal("state-changing", "check-coverage")))
    const asCommand  = await classifyAsk("run the coverage tests", fakeClassifier(proposal("state-changing", "check-coverage")))
    expect(asQuestion.tier).toBe(asCommand.tier)
    expect(asQuestion.tier).toBe(1)
  })

  test("the raw question is what gets dispatched", async () => {
    const result = await classifyAsk("  git status at C:\\proj  ", fakeClassifier(proposal("read-only", "git-status")))
    expect(result.dispatchText).toBe("git status at C:\\proj")
  })
})

// specs/128 — a contextual reply dispatches the router's self-contained
// rewrite, never the bare word; absent or blank falls back to the message.
describe("contextual replies — the router's resolvedRequest is what gets dispatched", () => {
  const original = "edit src/server.ts at C:\\proj: add input validation to /users/:id"

  test("'yes' dispatches the rewritten request, still gated as write-capable", async () => {
    const result = await classifyAsk("yes", fakeClassifier({ ...proposal("state-changing", "edit-files"), resolvedRequest: `  ${original}  ` }))
    expect(result.skill).toBe("edit-files")
    expect(result.tier).toBe(1)
    expect(result.dispatchText).toBe(original)
  })

  test.each([null, undefined, "   "])("a %p resolvedRequest falls back to the raw message", async (resolvedRequest) => {
    const result = await classifyAsk("git status", fakeClassifier({ ...proposal("read-only", "git-status"), resolvedRequest }))
    expect(result.dispatchText).toBe("git status")
  })

  test("a Tier 0 answer ignores resolvedRequest entirely — nothing is dispatched", async () => {
    const result = await classifyAsk("thanks", fakeClassifier({ ...proposal("conversation"), resolvedRequest: original }))
    expect(result.tier).toBe(0)
    expect(result.dispatchText).toBeUndefined()
  })
})

describe("follow-ups — narrow and explicit by design", () => {
  test.each(["again", "run it again", "do that again", "repeat", "same again", "Run it again."])(
    "recognises %s as a follow-up",
    (text) => {
      expect(isFollowUpRequest(text)).toBe(true)
    },
  )

  test.each([
    "run the tests again for the payments module",
    "again and again we see failures",
    "scan for secrets",
  ])("does not treat %s as a bare follow-up", (text) => {
    expect(isFollowUpRequest(text)).toBe(false)
  })

  test("a follow-up reuses the previous skill and replays the original text", async () => {
    const classify = fakeClassifier(proposal("conversation"))
    const result = await classifyAsk("run it again", classify, {
      previousSkill: "git-status",
      previousText: "git status at C:\\proj",
    })

    expect(result.skill).toBe("git-status")
    expect(result.tier).toBe(2)
    expect(result.reason).toBe("followup:reuse:git-status")
    // Replaying the original text is what preserves the target path.
    expect(result.dispatchText).toBe("git status at C:\\proj")
    // Routing was never consulted — the previous turn decided it.
    expect(classify.calls).toEqual([])
  })

  test("a follow-up with no prior context falls through to normal classification", async () => {
    const classify = fakeClassifier(proposal("state-changing", "dockerize"))
    const result = await classifyAsk("run it again", classify)

    expect(result.reason).toBe("skill:dockerize:write-capable")
    expect(classify.calls).toEqual(["run it again"])
  })

  test("a follow-up to a write-capable skill stays tier 1 — reuse never downgrades the gate", async () => {
    const result = await classifyAsk("again", fakeClassifier(proposal("conversation")), {
      previousSkill: "dockerize",
      previousText: "dockerize my app",
    })
    expect(result.skill).toBe("dockerize")
    expect(result.tier).toBe(1)
  })
})
