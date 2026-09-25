// specs/054-capability-driven-llm-routing/spec.md, promoted to
// detectSkill()'s ONLY tier by
// specs/065-llm-only-skill-routing/spec.md.
//
// Exercises the capability router via detectSkill()'s optional
// `deps.model` injection seam — no live network call, no real LLM.
// registry.set() populates a real live capability snapshot the same way
// ask-endpoint.test.ts already does for its own tests.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { detectSkill, registry, type RegisteredAgent } from "./index"

function agent(name: string, skillIds: string[]): RegisteredAgent {
  return {
    card: {
      name,
      description: "",
      url: `http://localhost:0/${name}`,
      version: "1.0.0",
      skills: skillIds.map((id) => ({ id, name: id, description: "" })),
    },
    url: `http://localhost:0/${name}`,
    status: "online",
    lastSeen: new Date(),
  }
}

class ScriptedChatModel extends BaseChatModel {
  private calls = 0
  constructor(private readonly responses: string[]) {
    super({})
  }
  _llmType(): string {
    return "scripted-fake-router-detect-skill-model"
  }
  get callCount(): number {
    return this.calls
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1
    const content = this.responses[Math.min(this.calls - 1, this.responses.length - 1)]
    return { generations: [{ text: content, message: new AIMessage(content) }] }
  }
}

function proposal(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    skillId: "audit-dependencies",
    target: null,
    confidence: 0.75,
    reason: "unusual phrasing for a dependency check",
    kind: "read-only",
    ...overrides,
  })
}

// Confirmed genuinely out-of-scope for BOTH the keyword tier and the
// local semantic classifier — the exact phrase detect-skill.test.ts's
// own "semantic intent fallback" suite already uses for this same
// property ("out-of-scope input still falls through to plan-task").
const OBSCURE_PHRASE = "what is the weather in cairo today"

beforeEach(() => {
  registry.clear()
})

afterEach(() => {
  registry.clear()
})

describe("detectSkill — capability router tier (specs/054), now the ONLY tier (specs/065)", () => {
  test("every request reaches the router now — even an obviously keyword-shaped phrase makes a real model call", async () => {
    // specs/065 retired the keyword tier entirely: there is no more
    // "already matched, never even asks the model" case. A phrase that
    // used to be caught by a keyword branch now still has to go through
    // the router — this is the deliberate, approved cost of that spec.
    registry.set("security-agent", agent("security-agent", ["audit-dependencies"]))
    const model = new ScriptedChatModel([proposal({ skillId: "audit-dependencies" })])
    const result = await detectSkill("run an audit on my dependencies please", { model })
    expect(result).toBe("audit-dependencies")
    expect(model.callCount).toBeGreaterThan(0)
  })

  test("a valid proposal against the live snapshot is used", async () => {
    registry.set("security-agent", agent("security-agent", ["audit-dependencies"]))
    const model = new ScriptedChatModel([proposal({ skillId: "audit-dependencies" })])
    const result = await detectSkill(OBSCURE_PHRASE, { model })
    expect(result).toBe("audit-dependencies")
    expect(model.callCount).toBeGreaterThan(0)
  })

  test("a proposal naming a skill not present in the live snapshot never dispatches — falls through to plan-task", async () => {
    registry.set("security-agent", agent("security-agent", ["audit-dependencies"]))
    // Proposes a skill that IS a real skill id elsewhere in this codebase
    // but is NOT currently online per this test's own registry — must
    // still be refused, not treated as "close enough."
    const model = new ScriptedChatModel([proposal({ skillId: "dockerize" })])
    const result = await detectSkill(OBSCURE_PHRASE, { model })
    expect(result).toBe("plan-task")
  })

  test("the unsupported sentinel falls through to plan-task", async () => {
    registry.set("security-agent", agent("security-agent", ["audit-dependencies"]))
    const model = new ScriptedChatModel([proposal({ skillId: "unsupported", kind: "unsupported" })])
    const result = await detectSkill(OBSCURE_PHRASE, { model })
    expect(result).toBe("plan-task")
  })

  test("an unparseable/malformed router response fails closed to plan-task, not a crash", async () => {
    registry.set("security-agent", agent("security-agent", ["audit-dependencies"]))
    const model = new ScriptedChatModel(["not json", "still not json", "nope"])
    const result = await detectSkill(OBSCURE_PHRASE, { model })
    expect(result).toBe("plan-task")
  })

  test("with an empty registry, the snapshot still carries the Orchestrator's own suggest-agents entry — the router IS attempted", async () => {
    // specs/065-llm-only-skill-routing/spec.md — buildCapabilitySnapshot()
    // now always includes a synthetic {orchestrator: [suggest-agents]}
    // entry, so an empty agent registry no longer means an empty/null
    // snapshot. A proposal naming a real skill NOT in that one-entry
    // snapshot still correctly falls through to plan-task.
    const model = new ScriptedChatModel([proposal({ skillId: "audit-dependencies" })])
    const result = await detectSkill(OBSCURE_PHRASE, { model })
    expect(result).toBe("plan-task") // audit-dependencies isn't online — no real agent registered
    expect(model.callCount).toBeGreaterThan(0) // but the router WAS attempted, unlike before this spec
  })

  test("with an empty registry, the router can still correctly propose suggest-agents", async () => {
    const model = new ScriptedChatModel([proposal({ skillId: "suggest-agents", kind: "read-only" })])
    const result = await detectSkill("what agents do you have available", { model })
    expect(result).toBe("suggest-agents")
  })

  test("a write-capable skill named by the router is returned exactly like any other skill id — the approval gate is unaffected by this tier", async () => {
    registry.set("devops-agent", agent("devops-agent", ["dockerize"]))
    const model = new ScriptedChatModel([proposal({ skillId: "dockerize", kind: "state-changing" })])
    const result = await detectSkill(OBSCURE_PHRASE, { model })
    // detectSkill() only ever returns a skill id string — the caller
    // (dispatchRootTask()) applies the exact same approval-gate dispatch
    // path regardless of which tier produced this id, unmodified by this
    // spec.
    expect(result).toBe("dockerize")
  })

  // specs/075-real-conversational-chat/spec.md — POST /tasks stays
  // byte-identical: the router's two new kind values never introduce a
  // new observable outcome here.
  describe("the two specs/075 kind values never change POST /tasks' own outcome", () => {
    test("'conversation' falls through to plan-task, byte-identical to 'unsupported'", async () => {
      registry.set("devops-agent", agent("devops-agent", ["dockerize"]))
      const model = new ScriptedChatModel([proposal({ skillId: "unsupported", kind: "conversation" })])
      const result = await detectSkill("hello", { model })
      expect(result).toBe("plan-task")
    })

    // specs/091-chat-explain-last-failure/spec.md — the new kind added by
    // that spec needs zero code change in tryCapabilityRoute() (its own
    // catch-all already routes anything but "read-only"/"state-changing"
    // to null), confirmed here rather than only by reading the guard.
    test("'failure-question' falls through to plan-task, byte-identical to 'unsupported'", async () => {
      registry.set("devops-agent", agent("devops-agent", ["dockerize"]))
      const model = new ScriptedChatModel([proposal({ skillId: "unsupported", kind: "failure-question" })])
      const result = await detectSkill("why did it fail last time?", { model })
      expect(result).toBe("plan-task")
    })

    test("'state-question' falls through to plan-task when suggest-agents isn't live (an empty registry has no synthetic entry to prefer — wait, it always does; this asserts the exception path itself, not its absence)", async () => {
      // buildCapabilitySnapshot() always carries the synthetic
      // orchestrator/suggest-agents entry (specs/065), so this exercises
      // the one deliberate exception specs/075 added: 'state-question'
      // prefers 'suggest-agents' over plan-task when it's genuinely live
      // — which it always is, by construction. The negative case (no
      // suggest-agents at all) isn't reachable in this runtime; recorded
      // here as a defensive branch, not a currently-observable one.
      const model = new ScriptedChatModel([proposal({ skillId: "unsupported", kind: "state-question" })])
      const result = await detectSkill("what agents do you have?", { model })
      expect(result).toBe("suggest-agents")
    })

    test("'state-question' preserves the pre-existing suggest-agents behavior for the exact live-caught overlap phrase", async () => {
      // specs/051's own suggest-agents-relocation.test.ts suite has
      // always resolved "what agents are there" to the suggest-agents
      // skill through POST /tasks — a real, independently pre-existing
      // behavior this spec must not silently break, even though the
      // same phrase is also a genuine state-question in intent.
      const model = new ScriptedChatModel([proposal({ skillId: "unsupported", kind: "state-question" })])
      const result = await detectSkill("what agents are there", { model })
      expect(result).toBe("suggest-agents")
    })
  })

  // specs/092-router-classification-conversation-context/spec.md —
  // POST /tasks never has a conversation to draw on; this proves the
  // prompt it actually sends carries no "Earlier in this conversation"
  // block, not just that behavior happens to be unaffected.
  describe("specs/092 — POST /tasks's own prompt never carries conversation history", () => {
    class CapturingModel extends BaseChatModel {
      lastMessages: BaseMessage[] = []
      constructor(private readonly response: string) {
        super({})
      }
      _llmType(): string {
        return "capturing-fake-router-detect-skill-model"
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        this.lastMessages = messages
        return { generations: [{ text: this.response, message: new AIMessage(this.response) }] }
      }
    }

    test("the human message sent is the bare text, with no history block", async () => {
      registry.set("devops-agent", agent("devops-agent", ["git-status"]))
      const model = new CapturingModel(proposal({ skillId: "git-status", kind: "read-only" }))
      await detectSkill("git status", { model })
      const humanMessage = model.lastMessages.find((m) => m._getType() === "human")
      const content = typeof humanMessage?.content === "string" ? humanMessage.content : ""
      expect(content).toBe("git status")
      expect(content).not.toContain("Earlier in this conversation")
    })
  })
})
