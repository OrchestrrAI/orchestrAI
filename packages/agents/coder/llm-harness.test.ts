// specs/083-coder-agent/spec.md — tests the harness's tool-call loop,
// grounding validation (not-found/ambiguous/exactly-once), and
// retry-with-feedback/fail-closed behavior against a mocked chat model
// and a mocked MCP tool caller. No network calls, no live API
// credentials, no real MCP server required — mirrors specs/082's own
// llm-harness.test.ts shape exactly.
import { describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import {
  READ_ONLY_TOOL_NAMES,
  MAX_FILES_PER_EDIT,
  type EditFileHarnessResult,
  type EditProposal,
  type McpToolCaller,
  type MultiFileHarnessResult,
  buildReadOnlyTools,
  countOccurrences,
  runEditFileHarness,
  runEditFilesHarness,
  runVerifyCommandHarness,
} from "./llm-harness"
import { PATH_NOT_FOUND_PREFIX } from "../../shared/write-preflight"

// specs/098-harness-recursion-limit-and-clean-failure/spec.md — every
// pre-existing test here asserts on a genuine edit proposal, never a
// refusal; this narrows the new three-way EditFileHarnessResult back
// down for them, throwing clearly if a test's own real result isn't an
// edit (a real assertion failure, not a silent cast).
function asEdit(result: EditFileHarnessResult): EditProposal {
  if (!result) throw new Error("Expected an edit proposal, got null")
  if ("refused" in result) throw new Error(`Expected an edit proposal, got a refusal: ${result.reason}`)
  return result
}

// ============================================================
// TEST DOUBLES (identical shape to code-review's own)
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

function toolCallMessage(toolName: string, id: string, args: Record<string, unknown> = { relative_path: "src/bar.ts" }): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ name: toolName, args, id }] })
}

const FILE_CONTENT = [
  "export function foo(value: number): number {",
  "  if (value < 0) return 0",
  "  return value",
  "}",
].join("\n")

describe("countOccurrences", () => {
  test("0 when absent", () => expect(countOccurrences("abc", "xyz")).toBe(0))
  test("1 for a unique substring", () => expect(countOccurrences("abcabd", "cab")).toBe(1))
  test("counts non-overlapping occurrences", () => expect(countOccurrences("aaaa", "aa")).toBe(2))
  test("0 for an empty needle", () => expect(countOccurrences("abc", "")).toBe(0))
})

describe("buildReadOnlyTools", () => {
  // specs/101-per-agent-tool-access-expansion/spec.md — the bound set
  // grew from read_project_file alone to the full uniform
  // general-inspection set (analyze_project/git_status/git_diff too),
  // so an edit proposal can see real project structure and uncommitted
  // work before it's made. Still exactly READ_ONLY_TOOL_NAMES.
  test("binds exactly READ_ONLY_TOOL_NAMES, no more and no less", () => {
    const mcpClient = new MockMcpToolCaller({})
    const tools = buildReadOnlyTools(mcpClient, "task-1", "C:\\any")
    expect(tools.map((t) => t.name)).toEqual([...READ_ONLY_TOOL_NAMES])
  })

  test("write_project_file never appears in the bound tool set", () => {
    const mcpClient = new MockMcpToolCaller({})
    const tools = buildReadOnlyTools(mcpClient, "task-1", "C:\\any")
    expect(tools.map((t) => t.name)).not.toContain("write_project_file")
  })

  // specs/119-coder-verify-loop-and-reviewer-depth/spec.md acceptance
  // criterion — "Coder's proposal harness still binds zero write/execute
  // tools — asserted structurally, not by inspection." run_command/
  // run_tests were added to this agent's requiredTools (MCP connectivity
  // only) for the approval-gated execution path in verify-loop.ts; this
  // proves neither ever reaches the proposal harness itself.
  test("run_command and run_tests never appear in the bound tool set, despite being added to requiredTools for the approval-gated execution path", () => {
    const mcpClient = new MockMcpToolCaller({})
    const tools = buildReadOnlyTools(mcpClient, "task-1", "C:\\any")
    const names = tools.map((t) => t.name)
    expect(names).not.toContain("run_command")
    expect(names).not.toContain("run_tests")
  })

  test("READ_ONLY_TOOL_NAMES itself contains no write/execute tool name — the allow-list's own contents, not just what got bound this run", () => {
    const writeOrExecuteNames = ["write_project_file", "run_command", "run_tests"]
    for (const name of writeOrExecuteNames) {
      expect(READ_ONLY_TOOL_NAMES as readonly string[]).not.toContain(name)
    }
  })

  test("project_root is fixed in closure for every bound tool, regardless of what the model might try to pass", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: "content", analyze_project: "ok", git_status: "ok", git_diff: "ok" })
    const tools = buildReadOnlyTools(mcpClient, "task-1", "C:\\fixed\\root")
    await tools.find((t) => t.name === "read_project_file")!.invoke({ relative_path: "src/foo.ts" } as never)
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

describe("runEditFileHarness", () => {
  test("a uniquely-grounded proposal is returned as-is", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage('{"old_text":"if (value < 0) return 0","new_text":"if (value < 0) throw new Error(\\"negative\\")"}'),
    ])

    const result = await runEditFileHarness({
      model, mcpClient, taskId: "t-1", projectRoot: "C:\\any",
      relativePath: "src/foo.ts", fileContent: FILE_CONTENT, instruction: "throw instead of returning 0",
    })

    const edit = asEdit(result)
    expect(edit.old_text).toBe("if (value < 0) return 0")
    expect(edit.new_text).toContain("throw new Error")
  })

  test("a pure deletion (empty new_text) is a valid response", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage('{"old_text":"  if (value < 0) return 0\\n","new_text":""}'),
    ])

    const result = await runEditFileHarness({
      model, mcpClient, taskId: "t-2", projectRoot: "C:\\any",
      relativePath: "src/foo.ts", fileContent: FILE_CONTENT, instruction: "remove the negative-value guard",
    })

    expect(asEdit(result).new_text).toBe("")
  })

  test("the model may call read_project_file for real related-file context before responding", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: "export const LIMIT = 100" })
    const model = new ScriptedChatModel([
      toolCallMessage("read_project_file", "call_1"),
      textMessage('{"old_text":"return value","new_text":"return Math.min(value, 100)"}'),
    ])

    const result = await runEditFileHarness({
      model, mcpClient, taskId: "t-3", projectRoot: "C:\\any",
      relativePath: "src/foo.ts", fileContent: FILE_CONTENT, instruction: "cap the return value",
    })

    expect(asEdit(result).old_text).toBe("return value")
    expect(mcpClient.calls).toHaveLength(1)
    expect(mcpClient.calls[0]!.toolName).toBe("read_project_file")
  })

  test("a not-found old_text triggers retry-with-feedback, which then succeeds", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      // First response quotes text that is not actually in the file.
      textMessage('{"old_text":"this text does not exist in the file","new_text":"anything"}'),
      // Second response, after retry-with-feedback, is grounded.
      textMessage('{"old_text":"return value","new_text":"return value * 2"}'),
    ])

    const result = await runEditFileHarness({
      model, mcpClient, taskId: "t-4", projectRoot: "C:\\any",
      relativePath: "src/foo.ts", fileContent: FILE_CONTENT, instruction: "double the return value",
    })

    expect(result).toEqual({ old_text: "return value", new_text: "return value * 2" })
    expect(model.callCount).toBe(2)
  })

  test("an ambiguous old_text (matches more than once) triggers a distinct retry-with-feedback, which then succeeds", async () => {
    const repeated = ["export function dup(): number {", "  return 1", "}", "", "export function dup2(): number {", "  return 1", "}"].join("\n")
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      // "return 1" occurs twice in `repeated` — genuinely ambiguous.
      textMessage('{"old_text":"return 1","new_text":"return 2"}'),
      // Second response gives a unique, longer span.
      textMessage('{"old_text":"function dup(): number {\\n  return 1","new_text":"function dup(): number {\\n  return 2"}'),
    ])

    const result = await runEditFileHarness({
      model, mcpClient, taskId: "t-5", projectRoot: "C:\\any",
      relativePath: "src/dup.ts", fileContent: repeated, instruction: "change dup's return value",
    })

    expect(asEdit(result).old_text).toContain("function dup(): number")
    expect(model.callCount).toBe(2)
  })

  test("a persistently not-found old_text fails closed (null) after exhausted retries — no partial edit to salvage", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const badText = '{"old_text":"never appears in the file","new_text":"anything"}'
    // A FRESH AIMessage per attempt (not the same object reused) —
    // LangGraph's own messages reducer dedupes by object identity/id,
    // so replaying the exact same message instance gets treated as a
    // replace of the earlier turn rather than a new turn appended after
    // the retry feedback, corrupting "the last message" on the 2nd/3rd
    // pass (specs/082's own verification.md documents this exact
    // pitfall in full).
    const model = new ScriptedChatModel([textMessage(badText), textMessage(badText), textMessage(badText)])

    const result = await runEditFileHarness({
      model, mcpClient, taskId: "t-6", projectRoot: "C:\\any",
      relativePath: "src/foo.ts", fileContent: FILE_CONTENT, instruction: "an impossible edit", maxRetries: 2,
    })

    expect(result).toBeNull()
  })

  test("a persistently ambiguous old_text fails closed (null) after exhausted retries", async () => {
    const repeated = "return 1\nreturn 1\nreturn 1"
    const mcpClient = new MockMcpToolCaller({})
    const ambiguousText = '{"old_text":"return 1","new_text":"return 2"}'
    const model = new ScriptedChatModel([textMessage(ambiguousText), textMessage(ambiguousText), textMessage(ambiguousText)])

    const result = await runEditFileHarness({
      model, mcpClient, taskId: "t-7", projectRoot: "C:\\any",
      relativePath: "src/rep.ts", fileContent: repeated, instruction: "change one of the returns", maxRetries: 2,
    })

    expect(result).toBeNull()
  })

  test("structurally invalid JSON triggers retry-with-feedback, then recovers", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage("not json at all"),
      textMessage('{"old_text":"return value","new_text":"return value"}'),
    ])

    const result = await runEditFileHarness({
      model, mcpClient, taskId: "t-8", projectRoot: "C:\\any",
      relativePath: "src/foo.ts", fileContent: FILE_CONTENT, instruction: "a no-op edit",
    })

    expect(result).toEqual({ old_text: "return value", new_text: "return value" })
  })

  test("exhausted retries on persistently invalid JSON fail closed with null", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage("not json"),
      textMessage("still not json"),
      textMessage("nope"),
    ])

    const result = await runEditFileHarness({
      model, mcpClient, taskId: "t-9", projectRoot: "C:\\any",
      relativePath: "src/foo.ts", fileContent: FILE_CONTENT, instruction: "anything", maxRetries: 1,
    })

    expect(result).toBeNull()
  })

  test("a missing old_text (empty string) is a schema-validation failure, not a grounding failure", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage('{"old_text":"","new_text":"anything"}'),
      textMessage('{"old_text":"return value","new_text":"return value"}'),
    ])

    const result = await runEditFileHarness({
      model, mcpClient, taskId: "t-10", projectRoot: "C:\\any",
      relativePath: "src/foo.ts", fileContent: FILE_CONTENT, instruction: "anything",
    })

    expect(result).toEqual({ old_text: "return value", new_text: "return value" })
  })

  // specs/098-harness-recursion-limit-and-clean-failure/spec.md
  describe("recursion limit produces a clean, named error — never LangGraph's raw internal text", () => {
    test("a model that never stops calling the tool is caught and produces the new clean message", async () => {
      const mcpClient = new MockMcpToolCaller({ read_project_file: "some content" })
      // A FRESH AIMessage per invocation, never the same object instance
      // replayed — LangGraph's own messages reducer dedupes by object
      // identity/id, so returning the identical instance forever would
      // be treated as a replace-in-place rather than genuine repeated
      // turns, and the loop would never actually reach the recursion
      // limit (this file's own earlier tests already document this
      // exact pitfall).
      let callIndex = 0
      class NeverConvergesModel extends ScriptedChatModel {
        async _generate(): Promise<ChatResult> {
          this.callCount += 1
          callIndex += 1
          const message = toolCallMessage("read_project_file", `call_${callIndex}`)
          return { generations: [{ text: "", message }] }
        }
      }
      const model = new NeverConvergesModel([])

      try {
        await runEditFileHarness({
          model, mcpClient, taskId: "t-11", projectRoot: "C:\\any",
          relativePath: "src/foo.ts", fileContent: FILE_CONTENT, instruction: "anything",
        })
        throw new Error("expected runEditFileHarness to throw")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        expect(message).toContain("could not converge on a proposal within 40 tool-call rounds")
        // Never LangGraph's own raw text or troubleshooting URL.
        expect(message).not.toContain("docs.langchain.com")
        expect(message).not.toContain("recursionLimit")
      }
    })

    test("a genuinely unrelated error is re-thrown completely unchanged — the catch is scoped to GraphRecursionError alone", async () => {
      const mcpClient = new MockMcpToolCaller({})
      class ThrowingModel extends ScriptedChatModel {
        async _generate(): Promise<ChatResult> {
          throw new Error("simulated provider failure")
        }
      }
      const model = new ThrowingModel([textMessage("unused")])

      await expect(
        runEditFileHarness({
          model, mcpClient, taskId: "t-13", projectRoot: "C:\\any",
          relativePath: "src/foo.ts", fileContent: FILE_CONTENT, instruction: "anything",
        }),
      ).rejects.toThrow("simulated provider failure")
    })
  })

  // specs/098-harness-recursion-limit-and-clean-failure/spec.md
  describe("the refusal shape — a real, structural way to say 'this can't be done'", () => {
    test("a refusal response ends the run immediately with the model's own real reason — zero further tool calls or retries", async () => {
      const mcpClient = new MockMcpToolCaller({})
      const model = new ScriptedChatModel([
        textMessage('{"refused":true,"reason":"JSON does not support comments"}'),
        // If the harness mistakenly treated this as invalid JSON and
        // retried, this second scripted response would be consumed —
        // asserting model.callCount below proves it never is.
        textMessage('{"old_text":"return value","new_text":"return value"}'),
      ])

      const result = await runEditFileHarness({
        model, mcpClient, taskId: "t-14", projectRoot: "C:\\any",
        relativePath: "package.json", fileContent: FILE_CONTENT, instruction: "adding some comments",
      })

      expect(result).toEqual({ refused: true, reason: "JSON does not support comments" })
      expect(model.callCount).toBe(1)
      expect(mcpClient.calls).toHaveLength(0)
    })

    test("a normal edit proposal is completely unaffected by the refusal shape existing", async () => {
      const mcpClient = new MockMcpToolCaller({})
      const model = new ScriptedChatModel([
        textMessage('{"old_text":"return value","new_text":"return value * 2"}'),
      ])

      const result = await runEditFileHarness({
        model, mcpClient, taskId: "t-15", projectRoot: "C:\\any",
        relativePath: "src/foo.ts", fileContent: FILE_CONTENT, instruction: "double the return value",
      })

      expect(result).toEqual({ old_text: "return value", new_text: "return value * 2" })
    })
  })
})

// ============================================================
// runEditFilesHarness — specs/114-coder-multi-file-edit-and-create/spec.md
// ============================================================
/** A read_project_file mock that resolves per-path from a fixed map,
 *  throwing the real PATH_NOT_FOUND_PREFIX-shaped error for any path not
 *  in it — so a "create" proposal's own grounding (must NOT already
 *  exist) can be tested the same way index.ts's real MCP client
 *  behaves. */
class PathAwareMcpToolCaller implements McpToolCaller {
  public calls: { toolName: string; args: Record<string, unknown>; taskId: string }[] = []
  constructor(private filesByPath: Record<string, string>) {}
  async callTool(toolName: string, args: Record<string, unknown>, taskId: string): Promise<string> {
    this.calls.push({ toolName, args, taskId })
    if (toolName === "read_project_file") {
      const relativePath = String(args.relative_path).replace(/\\/g, "/")
      if (relativePath in this.filesByPath) return this.filesByPath[relativePath]!
      throw new Error(`${PATH_NOT_FOUND_PREFIX} "${relativePath}" does not exist`)
    }
    return "ok"
  }
}

// resolveContainedRelativePath() (llm-harness.ts) returns an OS-native
// path.relative() result — backslash-separated on Windows — so tests
// normalize to forward slashes before comparing against a literal.
function normSlashes(p: string): string {
  return p.replace(/\\/g, "/")
}

function asFiles(result: MultiFileHarnessResult): { files: { path: string; action: "edit" | "create"; content: string; previousContent?: string }[]; dropped: { path: string; reason: string }[] } {
  if (!result) throw new Error("Expected a grounded multi-file result, got null")
  if ("refused" in result) throw new Error(`Expected a grounded multi-file result, got a refusal: ${result.reason}`)
  return {
    files: result.files.map((f) => ({ ...f, path: normSlashes(f.path) })),
    dropped: result.dropped.map((d) => ({ ...d, path: normSlashes(d.path) })),
  }
}

describe("runEditFilesHarness", () => {
  test("a fully-grounded multi-file proposal (one edit, one create) is returned as-is", async () => {
    const mcpClient = new PathAwareMcpToolCaller({ "src/a.ts": "export const a = 1" })
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({
        files: [
          { path: "src/a.ts", action: "edit", old_text: "export const a = 1", new_text: "export const a = 2" },
          { path: "src/b.ts", action: "create", content: "export const b = 2" },
        ],
      })),
    ])

    const result = await runEditFilesHarness({ model, mcpClient, taskId: "t-mf-1", projectRoot: "C:\\any", instruction: "add b, bump a" })

    const { files, dropped } = asFiles(result)
    expect(dropped).toEqual([])
    expect(files).toHaveLength(2)
    const a = files.find((f) => f.path === "src/a.ts")!
    expect(a.action).toBe("edit")
    expect(a.content).toBe("export const a = 2")
    expect(a.previousContent).toBe("export const a = 1")
    const b = files.find((f) => f.path === "src/b.ts")!
    expect(b.action).toBe("create")
    expect(b.content).toBe("export const b = 2")
    expect(b.previousContent).toBeUndefined()
  })

  test("each file is grounded independently — one ambiguous file triggers retry-with-feedback naming it specifically, the other file's already-correct entry is unaffected", async () => {
    const mcpClient = new PathAwareMcpToolCaller({
      "src/a.ts": "export const a = 1",
      "src/dup.ts": "return 1\nreturn 1",
    })
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({
        files: [
          { path: "src/a.ts", action: "edit", old_text: "export const a = 1", new_text: "export const a = 2" },
          { path: "src/dup.ts", action: "edit", old_text: "return 1", new_text: "return 2" }, // ambiguous — occurs twice
        ],
      })),
      textMessage(JSON.stringify({
        files: [
          { path: "src/a.ts", action: "edit", old_text: "export const a = 1", new_text: "export const a = 2" },
          { path: "src/dup.ts", action: "edit", old_text: "return 1\nreturn 1", new_text: "return 2\nreturn 1" },
        ],
      })),
    ])

    const result = await runEditFilesHarness({ model, mcpClient, taskId: "t-mf-2", projectRoot: "C:\\any", instruction: "fix a and dup" })

    const { files, dropped } = asFiles(result)
    expect(dropped).toEqual([])
    expect(files).toHaveLength(2)
    expect(model.callCount).toBe(2)
  })

  test("a proposal naming more files than MAX_FILES_PER_EDIT is rejected with feedback naming the real count and the bound, not silently truncated", async () => {
    const mcpClient = new PathAwareMcpToolCaller({ "src/a.ts": "content" })
    const tooMany = Array.from({ length: MAX_FILES_PER_EDIT + 2 }, (_, i) => ({
      path: `src/f${i}.ts`, action: "create" as const, content: `content ${i}`,
    }))
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ files: tooMany })),
      textMessage(JSON.stringify({ files: [{ path: "src/a.ts", action: "edit", old_text: "content", new_text: "content 2" }] })),
    ])

    const result = await runEditFilesHarness({ model, mcpClient, taskId: "t-mf-3", projectRoot: "C:\\any", instruction: "too many files" })

    expect(asFiles(result).files).toHaveLength(1)
    expect(model.callCount).toBe(2)
  })

  test("on final retry exhaustion with a mixed grounded/ungrounded result, the largest grounded subset seen across any attempt is salvaged — never fewer than the best attempt achieved", async () => {
    const mcpClient = new PathAwareMcpToolCaller({ "src/a.ts": "export const a = 1" })
    // Attempt 1: a.ts grounds, b.ts does not exist and is proposed as "edit" (wrong action).
    // Attempt 2 (final, maxRetries=1): b.ts STILL wrong — a.ts remains the only grounded file.
    const badB = { path: "src/b.ts", action: "edit" as const, old_text: "anything", new_text: "anything2" }
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ files: [
        { path: "src/a.ts", action: "edit", old_text: "export const a = 1", new_text: "export const a = 2" },
        badB,
      ] })),
      textMessage(JSON.stringify({ files: [
        { path: "src/a.ts", action: "edit", old_text: "export const a = 1", new_text: "export const a = 2" },
        badB,
      ] })),
    ])

    const result = await runEditFilesHarness({ model, mcpClient, taskId: "t-mf-4", projectRoot: "C:\\any", instruction: "edit a and b", maxRetries: 1 })

    const { files, dropped } = asFiles(result)
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe("src/a.ts")
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.path).toBe("src/b.ts")
  })

  test("zero grounded files across every attempt fails closed with null — nothing to salvage", async () => {
    const mcpClient = new PathAwareMcpToolCaller({})
    const badProposal = JSON.stringify({ files: [{ path: "src/missing.ts", action: "edit", old_text: "anything", new_text: "anything2" }] })
    const model = new ScriptedChatModel([textMessage(badProposal), textMessage(badProposal)])

    const result = await runEditFilesHarness({ model, mcpClient, taskId: "t-mf-5", projectRoot: "C:\\any", instruction: "edit a nonexistent file", maxRetries: 1 })

    expect(result).toBeNull()
  })

  test("a path escaping the project root fails the harness immediately — no retry, a plainly invalid request", async () => {
    const mcpClient = new PathAwareMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ files: [{ path: "../outside.ts", action: "create", content: "evil" }] })),
      // If this were consumed, it would mean a retry happened — asserting callCount below proves it wasn't.
      textMessage(JSON.stringify({ files: [{ path: "src/ok.ts", action: "create", content: "fine" }] })),
    ])

    await expect(
      runEditFilesHarness({ model, mcpClient, taskId: "t-mf-6", projectRoot: "C:\\any", instruction: "escape the root" }),
    ).rejects.toThrow(/outside the project root/)
    expect(model.callCount).toBe(1)
  })

  test("a refusal response ends the run immediately with the model's own real reason — zero grounding calls", async () => {
    const mcpClient = new PathAwareMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ refused: true, reason: "this request names no real change to make" })),
    ])

    const result = await runEditFilesHarness({ model, mcpClient, taskId: "t-mf-7", projectRoot: "C:\\any", instruction: "do nothing in particular" })

    expect(result).toEqual({ refused: true, reason: "this request names no real change to make" })
    expect(mcpClient.calls).toHaveLength(0)
  })

  test("proposing 'create' for a path that already exists is ungrounded — 'edit' should have been used instead", async () => {
    const mcpClient = new PathAwareMcpToolCaller({ "src/a.ts": "export const a = 1" })
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ files: [{ path: "src/a.ts", action: "create", content: "export const a = 99" }] })),
      textMessage(JSON.stringify({ files: [{ path: "src/a.ts", action: "edit", old_text: "export const a = 1", new_text: "export const a = 99" }] })),
    ])

    const result = await runEditFilesHarness({ model, mcpClient, taskId: "t-mf-8", projectRoot: "C:\\any", instruction: "fix a.ts" })

    expect(asFiles(result).files[0]!.action).toBe("edit")
    expect(model.callCount).toBe(2)
  })

  test("proposing 'edit' for a path that does not exist is ungrounded — 'create' should have been used instead", async () => {
    const mcpClient = new PathAwareMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ files: [{ path: "src/new.ts", action: "edit", old_text: "anything", new_text: "anything2" }] })),
      textMessage(JSON.stringify({ files: [{ path: "src/new.ts", action: "create", content: "export const x = 1" }] })),
    ])

    const result = await runEditFilesHarness({ model, mcpClient, taskId: "t-mf-9", projectRoot: "C:\\any", instruction: "add a new file" })

    expect(asFiles(result).files[0]!.action).toBe("create")
    expect(model.callCount).toBe(2)
  })
})

// specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part B — the
// verification-command proposal harness, same test-double shapes as
// every other harness suite above.
describe("specs/119 — runVerifyCommandHarness", () => {
  test("proposes a real argv from a plain text response", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ argv: ["bun", "test"], reason: "the project's own test suite" })),
    ])

    const result = await runVerifyCommandHarness({ model, mcpClient, taskId: "t-vc-1", projectRoot: "C:\\any", instruction: "fix the bug" })

    expect(result).toEqual({ argv: ["bun", "test"], reason: "the project's own test suite" })
  })

  test("retries on an invalid response, then succeeds", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage("not json at all"),
      textMessage(JSON.stringify({ argv: ["npm", "run", "typecheck"], reason: "confirm types still check" })),
    ])

    const result = await runVerifyCommandHarness({ model, mcpClient, taskId: "t-vc-2", projectRoot: "C:\\any", instruction: "fix a type error" })

    expect(result).toEqual({ argv: ["npm", "run", "typecheck"], reason: "confirm types still check" })
    expect(model.callCount).toBe(2)
  })

  test("exhausting every retry with no valid response returns null — no deterministic fallback", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([textMessage("nope"), textMessage("still nope"), textMessage("nope again")])

    const result = await runVerifyCommandHarness({ model, mcpClient, taskId: "t-vc-3", projectRoot: "C:\\any", instruction: "fix it", maxRetries: 1 })

    expect(result).toBeNull()
  })

  test("an empty argv array fails validation and is never accepted", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ argv: [], reason: "empty" })),
      textMessage(JSON.stringify({ argv: ["bun", "test"], reason: "corrected" })),
    ])

    const result = await runVerifyCommandHarness({ model, mcpClient, taskId: "t-vc-4", projectRoot: "C:\\any", instruction: "fix it" })

    expect(result).toEqual({ argv: ["bun", "test"], reason: "corrected" })
    expect(model.callCount).toBe(2)
  })

  test("a prior failure is embedded in the system prompt via a tool call the model can inspect (git_status), never silently dropped", async () => {
    // The system prompt itself isn't directly asserted here (this suite's
    // own convention, matching every other harness test in this file) —
    // instead this proves the harness accepts and threads priorFailure
    // through without throwing, and still returns a real proposal.
    const mcpClient = new MockMcpToolCaller({ git_status: "clean" })
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ argv: ["bun", "test"], reason: "re-verify after the fix" })),
    ])

    const result = await runVerifyCommandHarness({
      model, mcpClient, taskId: "t-vc-5", projectRoot: "C:\\any", instruction: "fix the bug",
      priorFailure: { argv: ["bun", "test"], output: "1 test failed: expected 2, got 3" },
    })

    expect(result).toEqual({ argv: ["bun", "test"], reason: "re-verify after the fix" })
  })

  test("the model may call read-only tools (e.g. read_project_file) before proposing", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: '{"scripts":{"test":"bun test"}}' })
    const model = new ScriptedChatModel([
      toolCallMessage("read_project_file", "call-1", { relative_path: "package.json" }),
      textMessage(JSON.stringify({ argv: ["bun", "test"], reason: "package.json names this as the test script" })),
    ])

    const result = await runVerifyCommandHarness({ model, mcpClient, taskId: "t-vc-6", projectRoot: "C:\\any", instruction: "fix the bug" })

    expect(result).toEqual({ argv: ["bun", "test"], reason: "package.json names this as the test script" })
    expect(mcpClient.calls.some((c) => c.toolName === "read_project_file")).toBe(true)
  })
})
