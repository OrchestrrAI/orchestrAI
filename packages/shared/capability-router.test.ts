// specs/054-capability-driven-llm-routing/spec.md
import { describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { runCapabilityRouter, buildHumanPrompt, UNSUPPORTED_SKILL_ID, type CapabilityRouterProposal } from "./capability-router"
import type { CapabilityEntry } from "./task-envelope"

class ScriptedChatModel extends BaseChatModel {
  private index = 0
  constructor(private readonly responses: string[]) {
    super({})
  }
  _llmType(): string {
    return "scripted-fake-router-model"
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const content = this.responses[Math.min(this.index, this.responses.length - 1)]
    this.index += 1
    return { generations: [{ text: content, message: new AIMessage(content) }] }
  }
}

class ThrowingModel extends BaseChatModel {
  constructor() {
    super({})
  }
  _llmType(): string {
    return "throwing-fake-model"
  }
  async _generate(): Promise<ChatResult> {
    throw new Error("simulated network failure")
  }
}

const CAPABILITIES: CapabilityEntry[] = [
  { agentName: "devops-agent", skillId: "git-status" },
  { agentName: "devops-agent", skillId: "dockerize" },
  { agentName: "security-agent", skillId: "scan-secrets" },
]

function validProposal(overrides: Partial<CapabilityRouterProposal> = {}): string {
  return JSON.stringify({
    skillId: "git-status",
    target: null,
    confidence: 0.8,
    reason: "the request asks about repository state",
    kind: "read-only",
    ...overrides,
  })
}

describe("runCapabilityRouter", () => {
  test("a well-formed response naming a real skill validates on the first try", async () => {
    const model = new ScriptedChatModel([validProposal()])
    const result = await runCapabilityRouter({ model, text: "what's going on with my repo", capabilities: CAPABILITIES })
    expect(result?.skillId).toBe("git-status")
    expect(result?.kind).toBe("read-only")
  })

  test("the unsupported sentinel is a valid response, not an error", async () => {
    const model = new ScriptedChatModel([validProposal({ skillId: UNSUPPORTED_SKILL_ID, kind: "unsupported" })])
    const result = await runCapabilityRouter({ model, text: "what's the weather today", capabilities: CAPABILITIES })
    expect(result?.skillId).toBe(UNSUPPORTED_SKILL_ID)
  })

  test("malformed JSON triggers retry-with-feedback, then succeeds", async () => {
    const model = new ScriptedChatModel(["not json at all", validProposal()])
    const result = await runCapabilityRouter({ model, text: "check my git status", capabilities: CAPABILITIES })
    expect(result?.skillId).toBe("git-status")
  })

  test("a response missing a required field triggers retry-with-feedback", async () => {
    const model = new ScriptedChatModel([
      JSON.stringify({ skillId: "git-status" }), // missing confidence/reason/kind
      validProposal(),
    ])
    const result = await runCapabilityRouter({ model, text: "x", capabilities: CAPABILITIES })
    expect(result?.skillId).toBe("git-status")
  })

  test("exhausted retries fails closed to null, never a guess", async () => {
    const model = new ScriptedChatModel(["garbage", "still garbage", "more garbage", "even more garbage"])
    const result = await runCapabilityRouter({ model, text: "x", capabilities: CAPABILITIES, maxRetries: 2 })
    expect(result).toBeNull()
  })

  test("a model that throws (API error, timeout) fails closed to null immediately, no retry against a broken connection", async () => {
    const model = new ThrowingModel()
    const result = await runCapabilityRouter({ model, text: "x", capabilities: CAPABILITIES })
    expect(result).toBeNull()
  })

  test("a JSON response wrapped in a markdown code fence is still parsed", async () => {
    const model = new ScriptedChatModel(["```json\n" + validProposal() + "\n```"])
    const result = await runCapabilityRouter({ model, text: "x", capabilities: CAPABILITIES })
    expect(result?.skillId).toBe("git-status")
  })

  test("confidence outside [0,1] is rejected by the schema and triggers retry", async () => {
    const model = new ScriptedChatModel([validProposal({ confidence: 1.5 as unknown as number }), validProposal()])
    const result = await runCapabilityRouter({ model, text: "x", capabilities: CAPABILITIES })
    expect(result?.skillId).toBe("git-status")
    expect(result?.confidence).toBe(0.8)
  })

  // specs/075-real-conversational-chat/spec.md — two more closed kind
  // values, so a conversational endpoint can answer without dispatching.
  describe("the two specs/075 kind values", () => {
    test("'state-question' is a valid response, not an error", async () => {
      const model = new ScriptedChatModel([validProposal({ skillId: UNSUPPORTED_SKILL_ID, kind: "state-question" })])
      const result = await runCapabilityRouter({ model, text: "what agents do you have?", capabilities: CAPABILITIES })
      expect(result?.kind).toBe("state-question")
    })

    test("'conversation' is a valid response, not an error", async () => {
      const model = new ScriptedChatModel([validProposal({ skillId: UNSUPPORTED_SKILL_ID, kind: "conversation" })])
      const result = await runCapabilityRouter({ model, text: "hello", capabilities: CAPABILITIES })
      expect(result?.kind).toBe("conversation")
    })

    test("an invalid kind value is still rejected by the schema and triggers retry", async () => {
      const model = new ScriptedChatModel([
        validProposal({ kind: "totally-made-up" as unknown as CapabilityRouterProposal["kind"] }),
        validProposal({ kind: "conversation" }),
      ])
      const result = await runCapabilityRouter({ model, text: "x", capabilities: CAPABILITIES })
      expect(result?.kind).toBe("conversation")
    })
  })

  // specs/092-router-classification-conversation-context/spec.md
  describe("buildHumanPrompt — conversation context for the message to classify", () => {
    test("with no prior turns, the prompt is the bare message text, byte-identical to before this spec", () => {
      expect(buildHumanPrompt("yes it can")).toBe("yes it can")
    })

    test("an empty prior-turns array is treated the same as absent", () => {
      expect(buildHumanPrompt("yes it can", [])).toBe("yes it can")
    })

    test("with prior turns, they're prepended as prose context, and the current message is explicitly labeled", () => {
      const prompt = buildHumanPrompt("yes it can", [
        { role: "assistant", text: "That failed: MCP unavailable. Is the computer able to access the url?" },
      ])
      expect(prompt).toContain("Earlier in this conversation:")
      expect(prompt).toContain("assistant: That failed: MCP unavailable. Is the computer able to access the url?")
      expect(prompt).toContain("Message to classify: yes it can")
    })

    // specs/128 — the last dispatched request survives a history window
    // it has scrolled out of, but never appears without history.
    test("the last dispatched request is shown in full alongside prior turns only", () => {
      const turns = [{ role: "user" as const, text: "yes" }]
      const prompt = buildHumanPrompt("same thing for node", turns, "dockerize my bun app on port 4000")
      expect(prompt).toContain("Most recent request actually run in this conversation (full text): dockerize my bun app on port 4000")
      expect(prompt.indexOf("Most recent request")).toBeLessThan(prompt.indexOf("Message to classify"))
      expect(buildHumanPrompt("git status", undefined, "dockerize my bun app on port 4000")).toBe("git status")
      expect(buildHumanPrompt("yes", turns, "   ")).not.toContain("Most recent request")
    })
  })

  // specs/092-router-classification-conversation-context/spec.md — proves
  // the constructed prompt actually reaches the model, and that the
  // system prompt's own safety guard text is present, not just that
  // buildHumanPrompt() itself is correct in isolation.
  describe("runCapabilityRouter — conversation history actually reaches the model", () => {
    class CapturingModel extends BaseChatModel {
      lastMessages: BaseMessage[] = []
      constructor(private readonly response: string) {
        super({})
      }
      _llmType(): string {
        return "capturing-fake-router-model"
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        this.lastMessages = messages
        return { generations: [{ text: this.response, message: new AIMessage(this.response) }] }
      }
    }

    test("prior turns are included in the human message sent to the model", async () => {
      const model = new CapturingModel(validProposal({ skillId: UNSUPPORTED_SKILL_ID, kind: "state-question" }))
      await runCapabilityRouter({
        model,
        text: "yes it can",
        capabilities: CAPABILITIES,
        priorTurns: [{ role: "assistant", text: "Is the computer able to access the url?" }],
      })
      const humanMessage = model.lastMessages.find((m) => m._getType() === "human")
      const content = typeof humanMessage?.content === "string" ? humanMessage.content : ""
      expect(content).toContain("Is the computer able to access the url?")
      expect(content).toContain("Message to classify: yes it can")
    })

    test("the system prompt names the safety guard against history hijacking a new request", async () => {
      const model = new CapturingModel(validProposal())
      await runCapabilityRouter({ model, text: "git status", capabilities: CAPABILITIES })
      const systemMessage = model.lastMessages.find((m) => m._getType() === "system")
      const content = typeof systemMessage?.content === "string" ? systemMessage.content : ""
      expect(content).toContain("Always classify the LAST message")
    })

    // specs/128 — asked for only when there is history to resolve against,
    // so a history-free call's prompt is unchanged.
    test("resolvedRequest is requested only when prior turns are present", async () => {
      const withHistory = new CapturingModel(validProposal())
      await runCapabilityRouter({
        model: withHistory, text: "yes", capabilities: CAPABILITIES,
        priorTurns: [{ role: "user", text: "dockerize my app" }, { role: "assistant", text: "Want me to try again?" }],
      })
      const without = new CapturingModel(validProposal())
      await runCapabilityRouter({ model: without, text: "git status", capabilities: CAPABILITIES })
      const systemOf = (m: CapturingModel) => {
        const s = m.lastMessages.find((msg) => msg._getType() === "system")
        return typeof s?.content === "string" ? s.content : ""
      }
      expect(systemOf(withHistory)).toContain('"resolvedRequest"')
      expect(systemOf(without)).not.toContain("resolvedRequest")
    })

    test("a proposal carrying resolvedRequest validates, and one without it still does", async () => {
      const rewritten = await runCapabilityRouter({
        model: new ScriptedChatModel([validProposal({ skillId: "dockerize", kind: "state-changing", resolvedRequest: "dockerize my app" })]),
        text: "yes", capabilities: CAPABILITIES, priorTurns: [{ role: "user", text: "dockerize my app" }],
      })
      expect(rewritten?.resolvedRequest).toBe("dockerize my app")
      const plain = await runCapabilityRouter({ model: new ScriptedChatModel([validProposal()]), text: "git status", capabilities: CAPABILITIES })
      expect(plain?.skillId).toBe("git-status")
      expect(plain?.resolvedRequest).toBeUndefined()
    })

    // specs/096-router-multi-concern-request-detection/spec.md
    test("the system prompt names the multi-concern instruction", async () => {
      const model = new CapturingModel(validProposal())
      await runCapabilityRouter({ model, text: "git status", capabilities: CAPABILITIES })
      const systemMessage = model.lastMessages.find((m) => m._getType() === "system")
      const content = typeof systemMessage?.content === "string" ? systemMessage.content : ""
      expect(content).toContain("genuinely distinct concerns")
      expect(content).toContain("DIFFERENT skill")
    })
  })

  // specs/096-router-multi-concern-request-detection/spec.md — the router
  // itself still only ever names one skill or "unsupported"; these tests
  // confirm the caller-visible contract for both sides of the new
  // instruction, not the model's own real judgment (that needs a live
  // pass — see the spec's own Verification Plan).
  describe("multi-concern requests (specs/096)", () => {
    test("a scripted 'unsupported' response for a multi-concern request is accepted like any other unsupported proposal", async () => {
      const model = new ScriptedChatModel([validProposal({ skillId: UNSUPPORTED_SKILL_ID, kind: "unsupported" })])
      const result = await runCapabilityRouter({
        model,
        text: "the test coverage and the security also are ok here?",
        capabilities: CAPABILITIES,
      })
      expect(result?.kind).toBe("unsupported")
      expect(result?.skillId).toBe(UNSUPPORTED_SKILL_ID)
    })

    test("a single-concern request merely phrased with 'and' still resolves to one real skill — no regression", async () => {
      const model = new ScriptedChatModel([validProposal({ skillId: "git-status", kind: "read-only" })])
      const result = await runCapabilityRouter({
        model,
        text: "check the coverage and tell me the percentage",
        capabilities: CAPABILITIES,
      })
      expect(result?.kind).toBe("read-only")
      expect(result?.skillId).toBe("git-status")
    })
  })

  // specs/121-skill-description-grounded-routing/spec.md
  describe("skill descriptions reach the router's system prompt", () => {
    class CapturingModel extends BaseChatModel {
      lastMessages: BaseMessage[] = []
      constructor(private readonly response: string) {
        super({})
      }
      _llmType(): string {
        return "capturing-fake-router-model"
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        this.lastMessages = messages
        return { generations: [{ text: this.response, message: new AIMessage(this.response) }] }
      }
    }

    function systemPromptFrom(model: CapturingModel): string {
      const systemMessage = model.lastMessages.find((m) => m._getType() === "system")
      return typeof systemMessage?.content === "string" ? systemMessage.content : ""
    }

    test("a same-family pair's real descriptions both appear, so the model can tell them apart", async () => {
      const capabilities: CapabilityEntry[] = [
        { agentName: "coder-agent", skillId: "edit-file", description: "Propose a precise, grounded edit to an existing file." },
        { agentName: "coder-agent", skillId: "edit-files", description: "...decide which files need touching, including creating new files..." },
      ]
      const model = new CapturingModel(validProposal({ skillId: "edit-files", kind: "state-changing" }))
      await runCapabilityRouter({ model, text: "create a new file", capabilities })
      const content = systemPromptFrom(model)
      expect(content).toContain("edit-file: Propose a precise, grounded edit to an existing file.")
      expect(content).toContain("edit-files: ...decide which files need touching, including creating new files...")
    })

    test("a skill entry with no description renders as a bare id, not 'undefined' or an empty label", async () => {
      const capabilities: CapabilityEntry[] = [{ agentName: "orchestrator", skillId: "suggest-agents" }]
      const model = new CapturingModel(validProposal({ skillId: "suggest-agents", kind: "state-changing" }))
      await runCapabilityRouter({ model, text: "what agents do you have", capabilities })
      const content = systemPromptFrom(model)
      expect(content).toContain("suggest-agents")
      expect(content).not.toContain("undefined")
    })

    test("with no capabilities at all, the prompt says so explicitly rather than an empty list", async () => {
      const model = new CapturingModel(validProposal({ skillId: UNSUPPORTED_SKILL_ID, kind: "unsupported" }))
      await runCapabilityRouter({ model, text: "x", capabilities: [] })
      const content = systemPromptFrom(model)
      expect(content).toContain("none currently online")
    })
  })
})
