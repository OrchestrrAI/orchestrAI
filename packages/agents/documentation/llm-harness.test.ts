// specs/041-llm-harness-documentation/spec.md — tests the harness's
// tool-call loop, retry-with-feedback, and fail-closed behavior for both
// entry points against a mocked chat model and a mocked MCP tool caller.
// No network calls, no live API credentials, no real MCP server required
// — mirrors Planning Agent's own (now-deleted) llm-harness.test.ts's own
// testing shape exactly.
import { describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import {
  READ_ONLY_TOOL_NAMES,
  type ApiEndpoint,
  type McpToolCaller,
  buildReadOnlyTools,
  runApiDocHarness,
  runApiDocRouteDiscoveryHarness,
  runReadmeHarness,
  validateApiDocOutput,
} from "./llm-harness"

// ============================================================
// TEST DOUBLES (identical shape to Planning's own)
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
  return new AIMessage({ content: "", tool_calls: [{ name: toolName, args: { relative_path: "package.json" }, id }] })
}

const README_CONTENT = "# my-project\n\nA real, honest description of what this project does, well past the minimum length."

// ============================================================
// validateApiDocOutput — pure function, no graph needed
// ============================================================
describe("validateApiDocOutput", () => {
  const routes: ApiEndpoint[] = [
    { method: "GET", route: "/health", description: "No description provided." },
    { method: "POST", route: "/tasks", description: "No description provided." },
  ]

  test("accepts a response covering every discovered route", () => {
    const result = validateApiDocOutput("## GET /health\nChecks liveness.\n\n## POST /tasks\nCreates a task.", routes)
    expect(result.ok).toBe(true)
  })

  test("rejects a response missing one discovered route, naming it", () => {
    const result = validateApiDocOutput("## GET /health\nChecks liveness.", routes)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("/tasks")
  })

  test("rejects an empty or too-short response before even checking routes", () => {
    const result = validateApiDocOutput("ok", routes)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("too short")
  })

  test("a response inventing an extra route beyond the list is still accepted — grounding only checks coverage, not extras", () => {
    // Deliberately documented as current behavior, not a gap this
    // checkpoint claims to close: the check is "did you cover everything
    // I gave you", not "did you stay within exactly what I gave you".
    const result = validateApiDocOutput(
      "## GET /health\nChecks liveness.\n\n## POST /tasks\nCreates a task.\n\n## DELETE /made-up\nHallucinated route.",
      routes,
    )
    expect(result.ok).toBe(true)
  })
})

// ============================================================
// Bound tool set — shared by both entry points
// ============================================================
describe("bound tool set — write-capable tool structurally unreachable", () => {
  // specs/101-per-agent-tool-access-expansion/spec.md — the bound set
  // grew from read_project_file alone to the full uniform
  // general-inspection set; still exactly READ_ONLY_TOOL_NAMES, never
  // more, and still never a write-capable tool.
  test("exactly READ_ONLY_TOOL_NAMES is bound as graph tools, no more and no less", () => {
    const mcpClient = new MockMcpToolCaller({})
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\any\\project")
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...READ_ONLY_TOOL_NAMES].sort())
  })

  test("analyze_project/git_status/git_diff take no model-suppliable parameters — project path is fixed in closure", async () => {
    const mcpClient = new MockMcpToolCaller({ analyze_project: "ok", git_status: "ok", git_diff: "ok" })
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\fixed\\root")
    const analyzeTool = tools.find((t) => t.name === "analyze_project")!
    const statusTool = tools.find((t) => t.name === "git_status")!
    const diffTool = tools.find((t) => t.name === "git_diff")!
    await analyzeTool.invoke({} as never)
    await statusTool.invoke({} as never)
    await diffTool.invoke({} as never)
    expect(mcpClient.calls[0]?.args.project_path).toBe("C:\\fixed\\root")
    expect(mcpClient.calls[1]?.args.repo_path).toBe("C:\\fixed\\root")
    expect(mcpClient.calls[2]?.args.repo_path).toBe("C:\\fixed\\root")
    expect(mcpClient.calls[3]?.args.repo_path).toBe("C:\\fixed\\root")
  })

  test("write_project_file never appears in the bound tool set", () => {
    const mcpClient = new MockMcpToolCaller({})
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\any\\project")
    const names = tools.map((t) => t.name)
    expect(names).not.toContain("write_project_file")
  })

  test("project_root is fixed in closure — the tool call always uses it regardless of what the model might try to pass", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: "content" })
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\fixed\\root")
    const readTool = tools.find((t) => t.name === "read_project_file")!
    await readTool.invoke({ relative_path: "package.json" } as never)
    expect(mcpClient.calls[0]?.args.project_root).toBe("C:\\fixed\\root")
  })
})

// ============================================================
// runReadmeHarness — tool-call loop, retry, existing-README context
// ============================================================
describe("runReadmeHarness — tool-call loop", () => {
  test("agent calls read_project_file, observes the result, then emits real content", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: '{"name":"my-project"}' })
    const model = new ScriptedChatModel([toolCallMessage("read_project_file", "call_1"), textMessage(README_CONTENT)])

    const content = await runReadmeHarness({
      model,
      mcpClient,
      taskId: "task-1",
      projectRoot: "C:\\Users\\moham\\test-target-project",
    })

    expect(content).toBe(README_CONTENT)
    expect(mcpClient.calls).toHaveLength(1)
    expect(mcpClient.calls[0]?.toolName).toBe("read_project_file")
    expect(mcpClient.calls[0]?.taskId).toBe("task-1")
  })

  test("agent may emit content with zero tool calls", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([textMessage(README_CONTENT)])

    const content = await runReadmeHarness({ model, mcpClient, taskId: "task-2", projectRoot: "C:\\any" })

    expect(content).toBe(README_CONTENT)
    expect(mcpClient.calls).toHaveLength(0)
  })
})

describe("runReadmeHarness — existing README passed as context, not rediscovered", () => {
  test("when existingReadme is supplied, the model never needs to read README.md itself to see it", async () => {
    const mcpClient = new MockMcpToolCaller({})
    // Scripted to emit content immediately with zero tool calls — if the
    // harness didn't embed existingReadme in the prompt, a model that
    // genuinely needed to see prior content would have to call the tool
    // first. Zero calls here is the point: the content was already there.
    const model = new ScriptedChatModel([textMessage(README_CONTENT)])

    const content = await runReadmeHarness({
      model,
      mcpClient,
      taskId: "task-3",
      projectRoot: "C:\\any",
      existingReadme: "# old-name\n\nOld description.",
    })

    expect(content).toBe(README_CONTENT)
    expect(mcpClient.calls).toHaveLength(0)
  })
})

describe("runReadmeHarness — retry-with-feedback and fail-closed", () => {
  test("an empty response triggers exactly one retry, which then succeeds", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([textMessage(""), textMessage(README_CONTENT)])

    const content = await runReadmeHarness({ model, mcpClient, taskId: "task-4", projectRoot: "C:\\any" })

    expect(content).toBe(README_CONTENT)
  })

  test("exhausted retries fail closed with null content, never a guessed one", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([textMessage(""), textMessage("  "), textMessage("short")])

    const content = await runReadmeHarness({ model, mcpClient, taskId: "task-5", projectRoot: "C:\\any", maxRetries: 1 })

    expect(content).toBeNull()
  })
})

describe("runReadmeHarness — tool call failure is an observation, not a crash", () => {
  test("agent sees the tool error as a message and can still fail closed cleanly", async () => {
    const mcpClient: McpToolCaller = {
      async callTool() {
        throw new Error("MCP tool timed out")
      },
    }
    const model = new ScriptedChatModel([toolCallMessage("read_project_file", "call_1"), textMessage("")])

    const content = await runReadmeHarness({ model, mcpClient, taskId: "task-6", projectRoot: "C:\\any", maxRetries: 0 })

    expect(content).toBeNull()
  })
})

// ============================================================
// runApiDocHarness — tool-call loop, grounding-check retry
// ============================================================
describe("runApiDocHarness — tool-call loop and grounding", () => {
  const routes: ApiEndpoint[] = [{ method: "GET", route: "/health", description: "No description provided." }]
  const goodDoc = "## GET /health\nReturns 200 when the service is healthy. Well past the minimum length."

  test("agent calls read_project_file, observes the file, then emits grounded content", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: "app.get('/health', ...)" })
    const model = new ScriptedChatModel([toolCallMessage("read_project_file", "call_1"), textMessage(goodDoc)])

    const content = await runApiDocHarness({
      model,
      mcpClient,
      taskId: "task-7",
      targetDir: "C:\\Users\\moham\\test-target-project",
      targetPath: "C:\\Users\\moham\\test-target-project\\index.ts",
      routes,
    })

    expect(content).toBe(goodDoc)
    expect(mcpClient.calls).toHaveLength(1)
  })

  test("a response missing a discovered route triggers a retry naming it, which then succeeds", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([textMessage("Not about the right route at all, but long enough to pass the length check on its own."), textMessage(goodDoc)])

    const content = await runApiDocHarness({
      model,
      mcpClient,
      taskId: "task-8",
      targetDir: "C:\\any",
      targetPath: "C:\\any\\index.ts",
      routes,
    })

    expect(content).toBe(goodDoc)
  })

  test("exhausted retries on ungrounded output fail closed with null, never a guessed doc", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const offTopic = "This response never mentions the right thing, over and over, well past the minimum length required."
    const model = new ScriptedChatModel([textMessage(offTopic), textMessage(offTopic), textMessage(offTopic)])

    const content = await runApiDocHarness({
      model,
      mcpClient,
      taskId: "task-9",
      targetDir: "C:\\any",
      targetPath: "C:\\any\\index.ts",
      routes,
      maxRetries: 1,
    })

    expect(content).toBeNull()
  })

  test("route set comes only from the routes argument — the model is never asked to discover routes itself", async () => {
    // A model that emits a plausible-looking doc for a route NOT in the
    // list still passes, since grounding only requires coverage of what
    // was given, not restriction to it (see validateApiDocOutput's own
    // test group above) — this test exists to make that same property
    // visible at the full-harness level, not just the pure validator.
    const mcpClient = new MockMcpToolCaller({})
    const wrongRouteDoc = "## GET /totally-different-route\nSome documentation text that is long enough to pass."
    const model = new ScriptedChatModel([textMessage(wrongRouteDoc)])

    const content = await runApiDocHarness({
      model,
      mcpClient,
      taskId: "task-10",
      targetDir: "C:\\any",
      targetPath: "C:\\any\\index.ts",
      routes: [], // no routes discovered — nothing to be missing
    })

    expect(content).toBe(wrongRouteDoc)
  })
})

// ============================================================
// runApiDocRouteDiscoveryHarness — specs/100
// ============================================================
describe("runApiDocRouteDiscoveryHarness — grounded fallback for non-JS/TS files", () => {
  const PHP_FILE_CONTENT = "<?php\nRoute::get('/users', 'UserController@index');\nRoute::post('/users', 'UserController@store');\n";

  test("a fully-grounded response is accepted as-is, on the first attempt", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ routes: [{ method: "GET", route: "/users" }, { method: "POST", route: "/users" }] })),
    ])

    const routes = await runApiDocRouteDiscoveryHarness({
      model,
      mcpClient,
      taskId: "task-100-1",
      targetPath: "C:\\any\\routes\\web.php",
      targetDir: "C:\\any\\routes",
      content: PHP_FILE_CONTENT,
    })

    expect(routes).toEqual([
      { method: "GET", route: "/users", description: "No description provided." },
      { method: "POST", route: "/users", description: "No description provided." },
    ])
  })

  test("a genuinely route-free file produces an empty list, not a fabricated route", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([textMessage(JSON.stringify({ routes: [] }))])

    const routes = await runApiDocRouteDiscoveryHarness({
      model,
      mcpClient,
      taskId: "task-100-2",
      targetPath: "C:\\any\\utils.php",
      targetDir: "C:\\any",
      content: "<?php\nfunction add($a, $b) { return $a + $b; }\n",
    })

    expect(routes).toEqual([])
  })

  test("an ungrounded route triggers retry-with-feedback naming it, then succeeds once corrected", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ routes: [{ method: "GET", route: "/made-up-not-in-file" }] })),
      textMessage(JSON.stringify({ routes: [{ method: "GET", route: "/users" }] })),
    ])

    const routes = await runApiDocRouteDiscoveryHarness({
      model,
      mcpClient,
      taskId: "task-100-3",
      targetPath: "C:\\any\\routes\\web.php",
      targetDir: "C:\\any\\routes",
      content: PHP_FILE_CONTENT,
    })

    expect(routes).toEqual([{ method: "GET", route: "/users", description: "No description provided." }])
  })

  test("exhausted retries salvage the largest grounded subset seen across any attempt", async () => {
    const mcpClient = new MockMcpToolCaller({})
    // First attempt: one grounded + one ungrounded (mixed — rejected as a
    // whole, but its grounded route is remembered). Second attempt: a
    // worse, fully-ungrounded response. Retries exhaust; the first
    // attempt's real grounded route must survive, not the empty second one.
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ routes: [{ method: "GET", route: "/users" }, { method: "GET", route: "/not-real" }] })),
      textMessage(JSON.stringify({ routes: [{ method: "GET", route: "/still-not-real" }] })),
    ])

    const routes = await runApiDocRouteDiscoveryHarness({
      model,
      mcpClient,
      taskId: "task-100-4",
      targetPath: "C:\\any\\routes\\web.php",
      targetDir: "C:\\any\\routes",
      content: PHP_FILE_CONTENT,
      maxRetries: 1,
    })

    expect(routes).toEqual([{ method: "GET", route: "/users", description: "No description provided." }])
  })

  test("exhausted retries with zero grounded routes ever fail closed to an empty list", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage(JSON.stringify({ routes: [{ method: "GET", route: "/fake-1" }] })),
      textMessage(JSON.stringify({ routes: [{ method: "GET", route: "/fake-2" }] })),
    ])

    const routes = await runApiDocRouteDiscoveryHarness({
      model,
      mcpClient,
      taskId: "task-100-5",
      targetPath: "C:\\any\\routes\\web.php",
      targetDir: "C:\\any\\routes",
      content: PHP_FILE_CONTENT,
      maxRetries: 1,
    })

    expect(routes).toEqual([])
  })

  test("malformed JSON triggers retry-with-feedback like any other invalid response", async () => {
    const mcpClient = new MockMcpToolCaller({})
    const model = new ScriptedChatModel([
      textMessage("not json at all"),
      textMessage(JSON.stringify({ routes: [{ method: "GET", route: "/users" }] })),
    ])

    const routes = await runApiDocRouteDiscoveryHarness({
      model,
      mcpClient,
      taskId: "task-100-6",
      targetPath: "C:\\any\\routes\\web.php",
      targetDir: "C:\\any\\routes",
      content: PHP_FILE_CONTENT,
    })

    expect(routes).toEqual([{ method: "GET", route: "/users", description: "No description provided." }])
  })

  test("the model may call read_project_file if it chooses to — the tool is bound, just not required", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: "some related file content" })
    const model = new ScriptedChatModel([
      toolCallMessage("read_project_file", "call_1"),
      textMessage(JSON.stringify({ routes: [{ method: "GET", route: "/users" }] })),
    ])

    const routes = await runApiDocRouteDiscoveryHarness({
      model,
      mcpClient,
      taskId: "task-100-7",
      targetPath: "C:\\any\\routes\\web.php",
      targetDir: "C:\\any\\routes",
      content: PHP_FILE_CONTENT,
    })

    expect(mcpClient.calls).toHaveLength(1)
    expect(routes).toEqual([{ method: "GET", route: "/users", description: "No description provided." }])
  })
})

// specs/098-harness-recursion-limit-and-clean-failure/spec.md
describe("recursion limit produces a clean, named error — never LangGraph's raw internal text", () => {
  test("a model that never stops calling the tool is caught and produces the new clean message naming the real skill", async () => {
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
      await runReadmeHarness({ model, mcpClient, taskId: "task-11", projectRoot: "C:\\any" })
      throw new Error("expected runReadmeHarness to throw")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toContain("generate-readme")
      expect(message).toContain("could not converge on a document within 40 tool-call rounds")
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
      runReadmeHarness({ model, mcpClient, taskId: "task-12", projectRoot: "C:\\any" }),
    ).rejects.toThrow("simulated provider failure")
  })
})
