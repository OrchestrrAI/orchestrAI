// specs/098-harness-recursion-limit-and-clean-failure/spec.md — the
// first dedicated harness-level test file for Testing's own two graphs
// (run-command fallback, write-tests). No prior file existed for these
// (a real, pre-existing gap, not introduced by this spec) — this covers
// the recursion-limit + clean-message behavior this spec adds, mirroring
// the exact same test shape every other agent's own llm-harness.test.ts
// already uses. No network calls, no live API credentials, no real MCP
// server required.
import { describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import {
  buildReadOnlyTools,
  READ_ONLY_TOOL_NAMES,
  type McpToolCaller,
  runTestCommandHarness,
  runWriteTestsHarness,
  buildWriteTestsSystemPrompt,
  sourceImportSpecifier,
} from "./llm-harness"

// ============================================================
// TEST DOUBLES (identical shape to every other agent's own)
// ============================================================
class ScriptedChatModel extends BaseChatModel {
  public callCount = 0
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
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.callCount += 1
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

function toolCallMessage(toolName: string, id: string): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ name: toolName, args: { relative_path: "src/foo.ts" }, id }] })
}

// specs/101-per-agent-tool-access-expansion/spec.md — the uniform
// general-inspection set every code-reasoning agent's harness now
// binds (read_project_file/analyze_project/git_status/git_diff),
// mirroring the same shape every other agent's own harness test
// already asserts.
describe("bound tool set — write-capable tool structurally unreachable", () => {
  test("exactly READ_ONLY_TOOL_NAMES is bound as graph tools, no more and no less", () => {
    const mcpClient = new MockMcpToolCaller({})
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\any\\project")
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...READ_ONLY_TOOL_NAMES].sort())
  })

  test("write_project_file and run_command never appear in the bound tool set", () => {
    const mcpClient = new MockMcpToolCaller({})
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\any\\project")
    const names = tools.map((t) => t.name)
    expect(names).not.toContain("write_project_file")
    expect(names).not.toContain("run_command")
  })

  test("project_root is fixed in closure for every bound tool, regardless of what the model might try to pass", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: "content", analyze_project: "ok", git_status: "ok", git_diff: "ok" })
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\fixed\\root")
    await tools.find((t) => t.name === "read_project_file")!.invoke({ relative_path: "go.mod" } as never)
    await tools.find((t) => t.name === "analyze_project")!.invoke({} as never)
    await tools.find((t) => t.name === "git_status")!.invoke({} as never)
    await tools.find((t) => t.name === "git_diff")!.invoke({} as never)
    expect(mcpClient.calls[0]?.args.project_root).toBe("C:\\fixed\\root")
    expect(mcpClient.calls[1]?.args.project_path).toBe("C:\\fixed\\root")
    expect(mcpClient.calls[2]?.args.repo_path).toBe("C:\\fixed\\root")
    expect(mcpClient.calls[3]?.args.repo_path).toBe("C:\\fixed\\root")
    expect(mcpClient.calls[4]?.args.repo_path).toBe("C:\\fixed\\root")
  })
})

describe("recursion limit produces a clean, named error — never LangGraph's raw internal text", () => {
  describe("runTestCommandHarness (every test command, specs/138)", () => {
    test("a model that never stops calling the tool is caught and produces the new clean message", async () => {
      const mcpClient = new MockMcpToolCaller({ read_project_file: "some content" })
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
        await runTestCommandHarness({ model, mcpClient, taskId: "task-1", projectRoot: "C:\\any" })
        throw new Error("expected runTestCommandHarness to throw")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        expect(message).toContain("test-command")
        expect(message).toContain("could not converge on a proposal within 40 tool-call rounds")
        expect(message).not.toContain("docs.langchain.com")
        expect(message).not.toContain("recursionLimit")
      }
    })

    test("a genuinely unrelated error is re-thrown completely unchanged", async () => {
      const mcpClient = new MockMcpToolCaller({})
      class ThrowingModel extends ScriptedChatModel {
        async _generate(): Promise<ChatResult> {
          throw new Error("simulated provider failure")
        }
      }
      const model = new ThrowingModel([textMessage("unused")])

      await expect(
        runTestCommandHarness({ model, mcpClient, taskId: "task-2", projectRoot: "C:\\any" }),
      ).rejects.toThrow("simulated provider failure")
    })

    test("a well-formed response still resolves correctly (baseline, not a regression)", async () => {
      const mcpClient = new MockMcpToolCaller({})
      const model = new ScriptedChatModel([textMessage('{"argv":["go","test","./..."],"reason":"go.mod found"}')])

      const result = await runTestCommandHarness({ model, mcpClient, taskId: "task-3", projectRoot: "C:\\any" })

      expect(result).toEqual({ argv: ["go", "test", "./..."], reason: "go.mod found" })
    })
  })

  describe("runWriteTestsHarness", () => {
    test("a model that never stops calling the tool is caught and produces the new clean message", async () => {
      const mcpClient = new MockMcpToolCaller({ read_project_file: "some content" })
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
        await runWriteTestsHarness({
          model, mcpClient, taskId: "task-4", projectRoot: "C:\\any",
          sourceRelativePath: "src/foo.ts", sourceContent: "export function foo() {}", runnerLabel: "bun", testRelativePath: "src/foo.test.ts",
        })
        throw new Error("expected runWriteTestsHarness to throw")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        expect(message).toContain("write-tests")
        expect(message).toContain("could not converge on a test file within 40 tool-call rounds")
        expect(message).not.toContain("docs.langchain.com")
        expect(message).not.toContain("recursionLimit")
      }
    })

    test("a genuinely unrelated error is re-thrown completely unchanged", async () => {
      const mcpClient = new MockMcpToolCaller({})
      class ThrowingModel extends ScriptedChatModel {
        async _generate(): Promise<ChatResult> {
          throw new Error("simulated provider failure")
        }
      }
      const model = new ThrowingModel([textMessage("unused")])

      await expect(
        runWriteTestsHarness({
          model, mcpClient, taskId: "task-5", projectRoot: "C:\\any",
          sourceRelativePath: "src/foo.ts", sourceContent: "export function foo() {}", runnerLabel: "bun", testRelativePath: "src/foo.test.ts",
        }),
      ).rejects.toThrow("simulated provider failure")
    })

    test("a well-formed response still resolves correctly (baseline, not a regression)", async () => {
      const mcpClient = new MockMcpToolCaller({})
      const testContent = "import { test, expect } from \"bun:test\"\ntest(\"foo works\", () => { expect(foo()).toBeUndefined() })"
      const model = new ScriptedChatModel([textMessage(testContent)])

      const result = await runWriteTestsHarness({
        model, mcpClient, taskId: "task-6", projectRoot: "C:\\any",
        sourceRelativePath: "src/foo.ts", sourceContent: "export function foo() {}", runnerLabel: "bun", testRelativePath: "src/foo.test.ts",
      })

      expect(result).toBe(testContent)
    })
  })
})

// specs/127 — the model is told where its test file goes and which import
// to use, instead of inferring the relative path itself.
describe("write-tests test-file location", () => {
  test("a sibling test imports its source as ./name, TS extension dropped", () => {
    expect(sourceImportSpecifier("src/server.test.ts", "src/server.ts", "bun")).toBe("./server")
  })

  test("Windows backslash paths produce a forward-slash specifier", () => {
    expect(sourceImportSpecifier("src\\lib\\util.test.ts", "src\\lib\\util.ts", "vitest")).toBe("./util")
  })

  test("a test in another directory gets a real relative path", () => {
    expect(sourceImportSpecifier("test/util.test.ts", "src/lib/util.ts", "jest")).toBe("../src/lib/util")
  })

  test("a .js source keeps its extension (ESM needs it)", () => {
    expect(sourceImportSpecifier("lib/a.test.js", "lib/a.js", "npm")).toBe("./a.js")
  })

  test("pytest gets no specifier — Python imports are module-based", () => {
    expect(sourceImportSpecifier("pkg/test_mod.py", "pkg/mod.py", "pytest")).toBeNull()
  })

  test("the system prompt names the test file's path and the import to use", () => {
    const prompt = buildWriteTestsSystemPrompt("C:\\proj", "src/server.ts", "export default app", "bun", "src/server.test.ts")
    expect(prompt).toContain('This test file will be written to "src/server.test.ts"')
    expect(prompt).toContain('import the source file as "./server"')
  })

  test("a pytest prompt still names the test file's path, with no JS import line", () => {
    const prompt = buildWriteTestsSystemPrompt("C:\\proj", "pkg/mod.py", "def f(): pass", "pytest", "pkg/test_mod.py")
    expect(prompt).toContain('This test file will be written to "pkg/test_mod.py"')
    expect(prompt).not.toContain("import the source file as")
  })
})
