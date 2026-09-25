// specs/137-plan-step-acts-only-on-its-own-step/spec.md — Coder's harnesses
// are instructed with the step only; in a plan, the user's full request is
// a separate, capped, labelled background block. Without it, the prompt is
// exactly what it was before this spec.
import { describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { runEditFileHarness, runEditFilesHarness, type McpToolCaller } from "./llm-harness"

class RecordingRefusalModel extends BaseChatModel {
  public received: BaseMessage[][] = []
  constructor() {
    super({})
  }
  _llmType(): string {
    return "recording-refusal-model"
  }
  bindTools(_tools: unknown): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.received.push(messages)
    // A refusal ends the run after one call — all this test needs is the prompt.
    const message = new AIMessage({ content: '{"refused": true, "reason": "test"}' })
    return { generations: [{ text: String(message.content), message }] }
  }
}

const mcp: McpToolCaller = { callTool: async () => "" }
const systemOf = (model: RecordingRefusalModel) => {
  const content = model.received[0]?.[0]?.content
  return typeof content === "string" ? content : ""
}

const STEP = "Add // config module at the top of src/config.ts and // server entry at the top of src/server.ts"
const PARENT = "add those comments to src/config.ts and src/server.ts, and also create a .gitignore for bun"

describe("specs/137 — Coder's prompt: the step is the instruction, the plan is background", () => {
  test("edit-files with context: the instruction is the step and the full request is fenced as background", async () => {
    const model = new RecordingRefusalModel()
    await runEditFilesHarness({ model, mcpClient: mcp, taskId: "t", projectRoot: "/p", instruction: STEP, context: PARENT })
    const system = systemOf(model)
    expect(system).toContain(`The requested change is: ${STEP}`)
    expect(system).not.toContain(`The requested change is: ${PARENT}`)
    expect(system).toContain("<<<BACKGROUND")
    expect(system).toContain(PARENT)
    expect(system).toContain("do only the step you were given")
  })

  test("edit-files without context: no background block at all (unchanged prompt)", async () => {
    const model = new RecordingRefusalModel()
    await runEditFilesHarness({ model, mcpClient: mcp, taskId: "t", projectRoot: "/p", instruction: STEP })
    expect(systemOf(model)).not.toContain("BACKGROUND")
  })

  test("edit-file gets the same background when given context, and none without", async () => {
    const withContext = new RecordingRefusalModel()
    await runEditFileHarness({ model: withContext, mcpClient: mcp, taskId: "t", projectRoot: "/p", relativePath: "src/config.ts", fileContent: "", instruction: "add a comment", context: PARENT })
    expect(systemOf(withContext)).toContain("<<<BACKGROUND")

    const without = new RecordingRefusalModel()
    await runEditFileHarness({ model: without, mcpClient: mcp, taskId: "t", projectRoot: "/p", relativePath: "src/config.ts", fileContent: "", instruction: "add a comment" })
    expect(systemOf(without)).not.toContain("BACKGROUND")
    // An empty file's content line is still present (no line was dropped).
    expect(systemOf(without)).toContain("--- current file content ---\n\n--- end of file content ---")
  })
})
