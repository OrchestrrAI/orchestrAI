// specs/044-conversational-ask-layer/spec.md — Phase 2.
// Grounding, retry-with-feedback and fail-open, against a scripted fake
// model. No network, no credentials. Mirrors packages/agents/security/
// llm-harness.test.ts's ScriptedChatModel shape.
import { describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { runAnswerHarness, ungroundedNumbers, validateAnswer } from "./answer-harness"

class ScriptedChatModel extends BaseChatModel {
  public callCount = 0
  public lastMessages: BaseMessage[] = []
  private index = 0
  constructor(private readonly responses: (AIMessage | Error)[]) {
    super({})
  }
  _llmType(): string {
    return "scripted-fake-chat-model"
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.callCount += 1
    this.lastMessages = messages
    const next = this.responses[Math.min(this.index, this.responses.length - 1)]
    this.index += 1
    if (next instanceof Error) throw next
    return { generations: [{ text: typeof next.content === "string" ? next.content : "", message: next }] }
  }
}

const answerMessage = (answer: string) => new AIMessage({ content: JSON.stringify({ answer }) })

const COVERAGE_SOURCE = `=== Test Results ===
Coverage: 82%
Passed: 12
Failed: 0`

describe("ungroundedNumbers — the bounded numeric guard", () => {
  test("accepts figures that appear in the source", () => {
    expect(ungroundedNumbers("82% coverage across 12 tests, 0 failing.", COVERAGE_SOURCE)).toEqual([])
  })

  test("flags a figure the source never reported", () => {
    expect(ungroundedNumbers("Coverage is 97%.", COVERAGE_SOURCE)).toEqual([97])
  })

  test("tolerates sensible rounding of a fractional source figure", () => {
    // A source reporting 86.36% may honestly be described as 86%.
    expect(ungroundedNumbers("About 86% covered.", "TOTAL 7 1 86.36%")).toEqual([])
  })

  test("accepts an answer with no figures at all", () => {
    expect(ungroundedNumbers("Yes, the suite is fully passing.", COVERAGE_SOURCE)).toEqual([])
  })

  test("is not fooled by a number that only appears inside a larger one", () => {
    // 999 does not appear in the source at all; 9 alone must not rescue it.
    expect(ungroundedNumbers("999 tests ran.", "Passed: 9")).toEqual([999])
  })
})

describe("validateAnswer", () => {
  test("accepts a well-formed grounded answer", () => {
    const result = validateAnswer('{"answer":"Yes — 82% coverage, 12 tests passing."}', COVERAGE_SOURCE)
    expect(result.ok).toBe(true)
    expect(result.answer).toContain("82%")
  })

  test("strips a markdown code fence a model may add", () => {
    const result = validateAnswer('```json\n{"answer":"12 tests passed."}\n```', COVERAGE_SOURCE)
    expect(result.ok).toBe(true)
  })

  test("rejects invalid JSON with actionable feedback", () => {
    const result = validateAnswer("Yes, 82% coverage.", COVERAGE_SOURCE)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not valid JSON")
  })

  test("rejects the wrong shape", () => {
    const result = validateAnswer('{"reply":"hello"}', COVERAGE_SOURCE)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("does not match the required shape")
  })

  test("rejects an ungrounded figure and names it in the feedback", () => {
    const result = validateAnswer('{"answer":"Coverage is 97%."}', COVERAGE_SOURCE)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("97")
    expect(result.error).toContain("does not appear in the material")
  })
})

describe("runAnswerHarness", () => {
  test("returns a grounded answer from a well-formed first response", async () => {
    const model = new ScriptedChatModel([answerMessage("Yes — 82% coverage, all 12 tests passing.")])
    const answer = await runAnswerHarness({ model, question: "is there test coverage?", source: COVERAGE_SOURCE })

    expect(answer).toBe("Yes — 82% coverage, all 12 tests passing.")
    expect(model.callCount).toBe(1)
  })

  test("retries a fabricated figure, then accepts the corrected answer", async () => {
    const model = new ScriptedChatModel([
      answerMessage("Coverage is 97%."),
      answerMessage("Coverage is 82%."),
    ])
    const answer = await runAnswerHarness({ model, question: "is there test coverage?", source: COVERAGE_SOURCE })

    expect(answer).toBe("Coverage is 82%.")
    expect(model.callCount).toBe(2)
  })

  test("fails OPEN — null, not an error — when every retry keeps fabricating", async () => {
    const model = new ScriptedChatModel([answerMessage("Coverage is 97%.")])
    const answer = await runAnswerHarness({
      model,
      question: "is there test coverage?",
      source: COVERAGE_SOURCE,
      maxRetries: 2,
    })

    // null means "use the deterministic material as-is" — the real answer
    // was never at risk, only its phrasing.
    expect(answer).toBeNull()
    expect(model.callCount).toBe(3)
  })

  test("fails open on a model/API error without retrying a broken connection", async () => {
    const model = new ScriptedChatModel([new Error("network unreachable")])
    const answer = await runAnswerHarness({ model, question: "anything?", source: COVERAGE_SOURCE })

    expect(answer).toBeNull()
    expect(model.callCount).toBe(1)
  })

  test("passes the real material and prior turns to the model, and nothing else", async () => {
    const model = new ScriptedChatModel([answerMessage("Yes.")])
    await runAnswerHarness({
      model,
      question: "and what about security?",
      source: COVERAGE_SOURCE,
      priorTurns: [
        { role: "user", text: "is there test coverage?" },
        { role: "assistant", text: "Yes — 82%." },
      ],
    })

    const prompt = model.lastMessages.map((m) => String(m.content)).join("\n")
    expect(prompt).toContain("and what about security?")
    expect(prompt).toContain("Coverage: 82%")
    expect(prompt).toContain("is there test coverage?")
  })
})
