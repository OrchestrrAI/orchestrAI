// specs/082-code-review-agent/spec.md — tests the harness's tool-call
// loop, grounding validation, retry-with-feedback, and salvage/
// fail-closed behavior against a mocked chat model and a mocked MCP
// tool caller. No network calls, no live API credentials, no real MCP
// server required — mirrors DevOps's own llm-harness.test.ts shape
// exactly.
import { describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import {
  READ_ONLY_TOOL_NAMES,
  type McpToolCaller,
  buildReadOnlyTools,
  runReviewDiffHarness,
} from "./llm-harness"
import { parseUnifiedDiff } from "./diff-grounding"

// ============================================================
// TEST DOUBLES (identical shape to DevOps's/Documentation's own)
// ============================================================
class ScriptedChatModel extends BaseChatModel {
  public callCount = 0
  // specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part A — the
  // messages from the LAST invocation, so a test can inspect what the
  // real system prompt actually contained (e.g. whether codebaseContext
  // was threaded in) without exporting buildReviewDiffSystemPrompt()
  // itself.
  public lastMessages: BaseMessage[] = []
  private index = 0
  constructor(private readonly responses: AIMessage[]) {
    super({})
  }
  _llmType(): string {
    return "scripted-fake-chat-model"
  }
  bindTools(_tools: unknown): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.callCount += 1
    this.lastMessages = messages
    const message = this.responses[Math.min(this.index, this.responses.length - 1)]
    this.index += 1
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] }
  }
}

class MockMcpToolCaller implements McpToolCaller {
  public calls: { toolName: string; args: Record<string, unknown>; taskId: string }[] = []
  constructor(private readonly resultsByTool: Record<string, string>) {}
  async callTool(toolName: string, args: Record<string, unknown>, taskId: string): Promise<string> {
    this.calls.push({ toolName, args, taskId })
    return this.resultsByTool[toolName] ?? `no mock result for ${toolName}`
  }
}

function textMessage(text: string): AIMessage {
  return new AIMessage({ content: text })
}

function toolCallMessage(toolName: string, id: string, args: Record<string, unknown> = { relative_path: "src/foo.ts" }): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ name: toolName, args, id }] })
}

// A real, small diff — one real added/context location per file.
const REAL_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index abc123..def456 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,3 +10,4 @@ function foo() {",
  "   const x = 1",
  "-  return x",
  "+  const y = x + 1",
  "+  return y",
].join("\n")

describe("buildReadOnlyTools", () => {
  // specs/101-per-agent-tool-access-expansion/spec.md — analyze_project/
  // git_status added to the uniform general-inspection set.
  // specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part A —
  // git_diff joined them; see the dedicated test below for the real
  // reasoning behind that reversal.
  test("binds exactly READ_ONLY_TOOL_NAMES, no more and no less", () => {
    const mcpClient = new MockMcpToolCaller({})
    const tools = buildReadOnlyTools(mcpClient, "task-1", "C:\\any")
    expect(tools.map((t) => t.name)).toEqual([...READ_ONLY_TOOL_NAMES])
  })

  // specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part A —
  // git_diff is now bound (see llm-harness.ts's own updated comment on
  // READ_ONLY_TOOL_NAMES for why this reverses the specs/082/101
  // decision this test used to assert).
  test("git_diff is bound — a real change here is a real decision, not a silent drop", () => {
    const mcpClient = new MockMcpToolCaller({})
    const tools = buildReadOnlyTools(mcpClient, "task-1", "C:\\any")
    expect(tools.map((t) => t.name)).toContain("git_diff")
  })

  test("project_root is fixed in closure for every bound tool, regardless of what the model might try to pass", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: "content", analyze_project: "ok", git_status: "ok" })
    const tools = buildReadOnlyTools(mcpClient, "task-1", "C:\\fixed\\root")
    await tools.find((t) => t.name === "read_project_file")!.invoke({ relative_path: "src/foo.ts" } as never)
    await tools.find((t) => t.name === "analyze_project")!.invoke({} as never)
    await tools.find((t) => t.name === "git_status")!.invoke({} as never)
    expect(mcpClient.calls[0]?.args.project_root).toBe("C:\\fixed\\root")
    expect(mcpClient.calls[1]?.args.project_path).toBe("C:\\fixed\\root")
    expect(mcpClient.calls[2]?.args.repo_path).toBe("C:\\fixed\\root")
  })
})

describe("runReviewDiffHarness", () => {
  test("a fully grounded response is returned as-is, with no omittedCount", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const parsed = parseUnifiedDiff(REAL_DIFF)
    const model = new ScriptedChatModel([
      textMessage('{"comments":[{"file":"src/foo.ts","line":11,"severity":"suggestion","comment":"consider a comment here"}],"summary":"looks fine"}'),
    ])

    const result = await runReviewDiffHarness({ model, mcpClient, taskId: "t-1", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed })

    expect(result).not.toBeNull()
    expect(result!.comments).toHaveLength(1)
    expect(result!.comments[0]!.file).toBe("src/foo.ts")
    expect(result!.comments[0]!.line).toBe(11)
    expect(result!.omittedCount).toBeUndefined()
  })

  test("an empty comments array is a completely valid response", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const parsed = parseUnifiedDiff(REAL_DIFF)
    const model = new ScriptedChatModel([textMessage('{"comments":[]}')])

    const result = await runReviewDiffHarness({ model, mcpClient, taskId: "t-2", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed })

    expect(result).toEqual({ comments: [] })
  })

  test("the model may call read_project_file for real context before responding", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: "export function foo() { const x = 1; return x }" })
    const parsed = parseUnifiedDiff(REAL_DIFF)
    const model = new ScriptedChatModel([
      toolCallMessage("read_project_file", "call_1"),
      textMessage('{"comments":[{"file":"src/foo.ts","line":11,"severity":"nit","comment":"fine given the full file"}]}'),
    ])

    const result = await runReviewDiffHarness({ model, mcpClient, taskId: "t-3", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed })

    expect(result!.comments).toHaveLength(1)
    expect(mcpClient.calls).toHaveLength(1)
    expect(mcpClient.calls[0]!.toolName).toBe("read_project_file")
  })

  test("a read_project_file call for a file deleted since the diff was taken surfaces the real MCP error back to the model, not a crash", async () => {
    // packages/mcp/index.ts's own read_project_file returns plain error
    // text for a missing file rather than throwing — this mock
    // reproduces that exact shape so the ToolNode forwards it as a
    // normal tool result, and the model can still proceed.
    const mcpClient = new MockMcpToolCaller({ read_project_file: "Path not found: src/foo.ts" })
    const parsed = parseUnifiedDiff(REAL_DIFF)
    const model = new ScriptedChatModel([
      toolCallMessage("read_project_file", "call_1"),
      textMessage('{"comments":[{"file":"src/foo.ts","line":11,"severity":"nit","comment":"proceeding without full file context"}]}'),
    ])

    const result = await runReviewDiffHarness({ model, mcpClient, taskId: "t-4", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed })

    expect(result).not.toBeNull()
    expect(result!.comments).toHaveLength(1)
  })

  test("an ungrounded comment triggers one retry, which then succeeds", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const parsed = parseUnifiedDiff(REAL_DIFF)
    const model = new ScriptedChatModel([
      // First response cites a location entirely absent from the diff.
      textMessage('{"comments":[{"file":"src/other.ts","line":999,"severity":"blocking","comment":"hallucinated"}]}'),
      // Second response, after retry-with-feedback, is fully grounded.
      textMessage('{"comments":[{"file":"src/foo.ts","line":11,"severity":"suggestion","comment":"real finding"}]}'),
    ])

    const result = await runReviewDiffHarness({ model, mcpClient, taskId: "t-5", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed })

    expect(result!.comments).toEqual([{ file: "src/foo.ts", line: 11, severity: "suggestion", comment: "real finding" }])
    expect(result!.omittedCount).toBeUndefined()
    expect(model.callCount).toBe(2)
  })

  test("a mixed grounded/ungrounded response, after exhausted retries, salvages only the grounded comments", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const parsed = parseUnifiedDiff(REAL_DIFF)
    // Every attempt (initial + both retries) returns the identical mix —
    // the model never "fixes" it, forcing exhaustion. A FRESH AIMessage
    // per attempt (not the same object reused) — LangGraph's own
    // messages reducer dedupes by object identity/id, so replaying the
    // exact same message instance gets treated as a replace of the
    // earlier turn rather than a new turn appended after the retry
    // feedback, corrupting "the last message" on the 2nd/3rd pass.
    const mixedResponseText =
      '{"comments":[' +
        '{"file":"src/foo.ts","line":11,"severity":"suggestion","comment":"real finding"},' +
        '{"file":"src/nonexistent.ts","line":42,"severity":"blocking","comment":"hallucinated"}' +
      ']}'
    const model = new ScriptedChatModel([textMessage(mixedResponseText), textMessage(mixedResponseText), textMessage(mixedResponseText)])

    const result = await runReviewDiffHarness({ model, mcpClient, taskId: "t-6", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed, maxRetries: 2 })

    expect(result).not.toBeNull()
    expect(result!.comments).toEqual([{ file: "src/foo.ts", line: 11, severity: "suggestion", comment: "real finding" }])
    expect(result!.omittedCount).toBe(1)
  })

  test("a response where every comment is ungrounded fails closed (null) after exhausted retries", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const parsed = parseUnifiedDiff(REAL_DIFF)
    const allBadText = '{"comments":[{"file":"src/nonexistent.ts","line":1,"severity":"nit","comment":"totally fabricated"}]}'
    const model = new ScriptedChatModel([textMessage(allBadText), textMessage(allBadText), textMessage(allBadText)])

    const result = await runReviewDiffHarness({ model, mcpClient, taskId: "t-7", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed, maxRetries: 2 })

    expect(result).toBeNull()
  })

  test("structurally invalid JSON triggers retry-with-feedback, then recovers", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const parsed = parseUnifiedDiff(REAL_DIFF)
    const model = new ScriptedChatModel([
      textMessage("not json at all"),
      textMessage('{"comments":[]}'),
    ])

    const result = await runReviewDiffHarness({ model, mcpClient, taskId: "t-8", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed })

    expect(result).toEqual({ comments: [] })
  })

  test("exhausted retries on persistently invalid JSON fail closed with null", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const parsed = parseUnifiedDiff(REAL_DIFF)
    const model = new ScriptedChatModel([
      textMessage("not json"),
      textMessage("still not json"),
      textMessage("nope"),
    ])

    const result = await runReviewDiffHarness({ model, mcpClient, taskId: "t-9", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed, maxRetries: 1 })

    expect(result).toBeNull()
  })
})

// specs/098-harness-recursion-limit-and-clean-failure/spec.md
describe("recursion limit produces a clean, named error — never LangGraph's raw internal text", () => {
  test("a model that never stops calling the tool is caught and produces the new clean message", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: "some content" })
    const parsed = parseUnifiedDiff(REAL_DIFF)
    let callIndex = 0
    class NeverConvergesModel extends ScriptedChatModel {
      async _generate(): Promise<ChatResult> {
        this.callCount += 1
        callIndex += 1
        return { generations: [{ text: "", message: toolCallMessage("read_project_file", `call_${callIndex}`) }] }
      }
    }
    const model = new NeverConvergesModel([])

    try {
      await runReviewDiffHarness({ model, mcpClient, taskId: "t-10", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed })
      throw new Error("expected runReviewDiffHarness to throw")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toContain("review-diff")
      expect(message).toContain("could not converge on a review within 40 tool-call rounds")
      expect(message).not.toContain("docs.langchain.com")
      expect(message).not.toContain("recursionLimit")
    }
  })

  test("a genuinely unrelated error is re-thrown completely unchanged", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const parsed = parseUnifiedDiff(REAL_DIFF)
    class ThrowingModel extends ScriptedChatModel {
      async _generate(): Promise<ChatResult> {
        throw new Error("simulated provider failure")
      }
    }
    const model = new ThrowingModel([textMessage("unused")])

    await expect(
      runReviewDiffHarness({ model, mcpClient, taskId: "t-11", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed }),
    ).rejects.toThrow("simulated provider failure")
  })
})

// specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part A —
// codebaseContext threading into the review's own system prompt.
describe("specs/119 — runReviewDiffHarness codebaseContext", () => {
  test("a provided codebaseContext is threaded into the real system prompt", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const parsed = parseUnifiedDiff(REAL_DIFF)
    const model = new ScriptedChatModel([textMessage(JSON.stringify({ comments: [] }))])

    await runReviewDiffHarness({
      model, mcpClient, taskId: "t-ctx-1", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed,
      codebaseContext: "Stack: TypeScript/Hono. Structure: monorepo with packages/agents/*.",
    })

    const systemMessage = model.lastMessages.find((m) => m._getType() === "system")
    const content = typeof systemMessage?.content === "string" ? systemMessage.content : ""
    expect(content).toContain("Stack: TypeScript/Hono")
    expect(content).toContain("packages/agents/*")
  })

  test("an omitted codebaseContext leaves the system prompt byte-identical to before — no stray section", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const parsed = parseUnifiedDiff(REAL_DIFF)
    const model = new ScriptedChatModel([textMessage(JSON.stringify({ comments: [] }))])

    await runReviewDiffHarness({ model, mcpClient, taskId: "t-ctx-2", projectRoot: "C:\\any", diffText: REAL_DIFF, parsed })

    const systemMessage = model.lastMessages.find((m) => m._getType() === "system")
    const content = typeof systemMessage?.content === "string" ? systemMessage.content : ""
    expect(content).not.toContain("codebase analysis")
  })
})
