// specs/042-llm-harness-devops/spec.md, reshaped by specs/138: the
// harness's tool-call loop, validation, retry-with-feedback and
// fail-closed behavior, against a mocked chat model and MCP tool caller.
// No network calls, no live credentials, no real MCP server.
import { describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { z } from "zod"
import {
  READ_ONLY_TOOL_NAMES,
  type McpToolCaller,
  buildReadOnlyTools,
  validateJsonParams,
  MAX_HARNESS_REQUEST_CHARS,
  STATED_VALUES_RULE,
  buildHarnessStartMessage,
  runRunCommandHarness,
  runAuthoringHarness,
  AuthoringRefusedError,
  AuthoringValidationError,
  AUTHORING_MAX_RETRIES,
} from "./llm-harness"
import type { DevOpsFileKind } from "../../shared/devops-file-validation"

// ============================================================
// TEST DOUBLES (identical shape to Planning's/Documentation's own)
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
  // specs/134 — every message list the model was invoked with.
  public received: BaseMessage[][] = []
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.received.push(messages)
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

// ============================================================
// validateJsonParams — pure function, no graph needed
// ============================================================
// ============================================================
// validateJsonParams — pure function, no graph needed
// ============================================================
const SampleSchema = z.object({ app_type: z.enum(["bun", "node"]), port: z.number().int().positive() })
describe("validateJsonParams", () => {
  test("accepts a well-formed JSON object matching the schema", () => {
    expect(validateJsonParams('{"app_type":"node","port":8080}', SampleSchema)).toEqual({ ok: true, params: { app_type: "node", port: 8080 } })
  })
  test("strips a markdown code fence", () => {
    expect(validateJsonParams('```json\n{"app_type":"bun","port":9000}\n```', SampleSchema).ok).toBe(true)
  })
  test("rejects invalid JSON and wrong shapes with a clear error", () => {
    expect(validateJsonParams("not json", SampleSchema).error).toContain("not valid JSON")
    expect(validateJsonParams('{"app_type":"rust","port":1}', SampleSchema).error).toContain("app_type")
    expect(validateJsonParams('{"app_type":"bun","port":-1}', SampleSchema).ok).toBe(false)
  })
})

// ============================================================
// READ-ONLY TOOL BINDING
// ============================================================
describe("bound tool set — write-capable tools structurally unreachable", () => {
  // specs/101-per-agent-tool-access-expansion/spec.md — git_diff added
  // (the agent itself has reached it since specs/079, but this harness
  // never could until now). Still exactly READ_ONLY_TOOL_NAMES.
  test("exactly analyze_project, git_status, git_diff, and read_project_file are ever bound", () => {
    const mcpClient = new MockMcpToolCaller({})
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\any\\project")
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...READ_ONLY_TOOL_NAMES].sort())
  })

  test("git_diff takes no model-suppliable parameters and returns the combined staged+unstaged diff", async () => {
    const mcpClient = new MockMcpToolCaller({ git_diff: "diff content" })
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\fixed\\root")
    const diffTool = tools.find((t) => t.name === "git_diff")!
    await diffTool.invoke({} as never)
    expect(mcpClient.calls[0]?.args).toEqual({ repo_path: "C:\\fixed\\root", staged: true })
    expect(mcpClient.calls[1]?.args).toEqual({ repo_path: "C:\\fixed\\root", staged: false })
  })

  test("no create_* or write_project_file tool ever appears in the bound tool set", () => {
    const mcpClient = new MockMcpToolCaller({})
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\any\\project")
    const names = tools.map((t) => t.name)
    const writeCapable = ["create_dockerfile", "create_github_action", "create_gitignore", "create_dockercompose", "write_project_file"]
    for (const w of writeCapable) expect(names).not.toContain(w)
  })

  test("project_root is fixed in closure for read_project_file, regardless of what the model might try to pass", async () => {
    const mcpClient = new MockMcpToolCaller({ read_project_file: "content" })
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\fixed\\root")
    const readTool = tools.find((t) => t.name === "read_project_file")!
    await readTool.invoke({ relative_path: "package.json" } as never)
    expect(mcpClient.calls[0]?.args.project_root).toBe("C:\\fixed\\root")
  })

  test("analyze_project and git_status take no model-suppliable parameters — project path is fixed in closure", async () => {
    const mcpClient = new MockMcpToolCaller({ analyze_project: "ok", git_status: "ok" })
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\fixed\\root")
    const analyzeTool = tools.find((t) => t.name === "analyze_project")!
    const gitTool = tools.find((t) => t.name === "git_status")!
    await analyzeTool.invoke({} as never)
    await gitTool.invoke({} as never)
    expect(mcpClient.calls[0]?.args.project_path).toBe("C:\\fixed\\root")
    expect(mcpClient.calls[1]?.args.repo_path).toBe("C:\\fixed\\root")
  })
})

// ============================================================
// specs/138 — model-authored files: validated before any preview
// ============================================================
// A tool caller that answers read_project_file only for real paths, so the
// Dockerfile COPY-source grounding check sees a realistic project.
class ProjectMcp implements McpToolCaller {
  constructor(private readonly files: Record<string, string>) {}
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (toolName === "read_project_file") {
      const rel = String(args.relative_path).replace(/\\/g, "/")
      if (rel in this.files) return this.files[rel]!
      throw new Error(`Path not found: ${rel}`)
    }
    return "ok"
  }
}
const BUN_PROJECT = { "package.json": '{"name":"app","scripts":{"test":"bun test"}}', "bun.lock": "", src: "d index.ts", "src/index.ts": "export {}" }
const GOOD_DOCKERFILE = `FROM oven/bun:1-slim\nWORKDIR /app\nCOPY package.json bun.lock ./\nRUN bun install --frozen-lockfile\nCOPY src ./src\nEXPOSE 4000\nCMD ["bun","run","src/index.ts"]\n`
const authored = (content: string, summary = "Bun app image") => textMessage(JSON.stringify({ content, summary }))
const baseOptions = (model: ScriptedChatModel, mcpClient: McpToolCaller) => ({
  model, mcpClient, taskId: "t", projectRoot: "/p", kind: "dockerfile" as const, relativePath: "Dockerfile", projectName: "app",
})

describe("runAuthoringHarness (specs/138)", () => {
  test("a valid file is returned as-is, with its summary", async () => {
    const model = new ScriptedChatModel([authored(GOOD_DOCKERFILE)])
    const out = await runAuthoringHarness(baseOptions(model, new ProjectMcp(BUN_PROJECT)))
    expect(out).toEqual({ content: GOOD_DOCKERFILE, summary: "Bun app image" })
    expect(model.callCount).toBe(1)
  })

  test("an invalid first file gets exactly one retry carrying the violations, and a fixed file then passes", async () => {
    const bad = GOOD_DOCKERFILE.replace("oven/bun:1-slim", "evil/miner:latest")
    const model = new ScriptedChatModel([authored(bad), authored(GOOD_DOCKERFILE)])
    const out = await runAuthoringHarness(baseOptions(model, new ProjectMcp(BUN_PROJECT)))
    expect(out.content).toBe(GOOD_DOCKERFILE)
    expect(model.callCount).toBe(2)
    const retryPrompt = model.received[1]!.at(-1)!
    expect(String(retryPrompt.content)).toContain("failed OrchestrAI's safety checks")
    expect(String(retryPrompt.content)).toContain(`FROM "evil/miner:latest" is not an allow-listed base image`)
  })

  test("still invalid after the one retry → fails closed, naming the violations; no third attempt", async () => {
    const bad = GOOD_DOCKERFILE.replace("COPY src ./src", "COPY server.js ./")
    const model = new ScriptedChatModel([authored(bad), authored(bad), authored(GOOD_DOCKERFILE)])
    let error: unknown
    try {
      await runAuthoringHarness(baseOptions(model, new ProjectMcp(BUN_PROJECT)))
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(AuthoringValidationError)
    expect(String((error as Error).message)).toContain(`COPY source "server.js" does not exist in the project`)
    expect(model.callCount).toBe(2)
    expect(AUTHORING_MAX_RETRIES).toBe(1)
  })

  test("a refusal reaches no preview — it throws with the model's reason", async () => {
    const model = new ScriptedChatModel([textMessage(JSON.stringify({ refused: true, reason: "this is a static site with no server to containerize" }))])
    await expect(runAuthoringHarness(baseOptions(model, new ProjectMcp(BUN_PROJECT)))).rejects.toThrow(AuthoringRefusedError)
  })

  test("each file kind is checked by its own validator", async () => {
    const cases: [DevOpsFileKind, string, string][] = [
      ["ci-workflow", `on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: someone/thing@v1\n`, "not allow-listed"],
      ["compose", `services:\n  app:\n    build: .\n    privileged: true\n`, "is privileged"],
      ["gitignore", `node_modules/\n`, ".orchestrai/"],
    ]
    for (const [kind, content, expected] of cases) {
      const model = new ScriptedChatModel([authored(content), authored(content)])
      const run = runAuthoringHarness({ ...baseOptions(model, new ProjectMcp(BUN_PROJECT)), kind, relativePath: "x" })
      await expect(run).rejects.toThrow(expected)
    }
  })

  test("the prompt carries the rules, the stated-values rule, the existing file and the request", async () => {
    const model = new ScriptedChatModel([authored(GOOD_DOCKERFILE)])
    await runAuthoringHarness({
      ...baseOptions(model, new ProjectMcp(BUN_PROJECT)),
      existingContent: "FROM node:18\n",
      requestText: "dockerize my bun app on port 4000",
      context: "dockerize my bun app on port 4000 and create CI",
    })
    const system = String(model.received[0]![0]!.content)
    expect(system).toContain("oven/bun")
    expect(system).toContain(STATED_VALUES_RULE)
    expect(system).toContain("--- current Dockerfile ---\nFROM node:18")
    const first = String(model.received[0]![1]!.content)
    expect(first).toContain("dockerize my bun app on port 4000")
    expect(first).toContain("<<<BACKGROUND")
  })
})

describe("tool call failure is an observation, not a crash", () => {
  test("the agent sees the tool error as a message and still fails closed cleanly", async () => {
    const mcpClient: McpToolCaller = {
      async callTool() {
        throw new Error("MCP tool timed out")
      },
    }
    const model = new ScriptedChatModel([toolCallMessage("read_project_file", "call_1"), textMessage("")])
    await expect(runAuthoringHarness({ ...baseOptions(model, mcpClient), maxRetries: 0 })).rejects.toThrow(AuthoringValidationError)
  })
})

// specs/098-harness-recursion-limit-and-clean-failure/spec.md
describe("recursion limit produces a clean, named error — never LangGraph's raw internal text", () => {
  test("a model that never stops calling the tool produces the clean message naming the file kind", async () => {
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
      await runAuthoringHarness(baseOptions(model, mcpClient))
      throw new Error("expected runAuthoringHarness to throw")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toContain("dockerfile")
      expect(message).toContain("could not converge on a proposal within 40 tool-call rounds")
      expect(message).not.toContain("docs.langchain.com")
    }
  })

  test("a genuinely unrelated error is re-thrown completely unchanged", async () => {
    class ThrowingModel extends ScriptedChatModel {
      async _generate(): Promise<ChatResult> {
        throw new Error("simulated provider failure")
      }
    }
    await expect(runAuthoringHarness(baseOptions(new ThrowingModel([textMessage("unused")]), new MockMcpToolCaller({})))).rejects.toThrow("simulated provider failure")
  })
})

// specs/134 + specs/137 — the request and the plan background
describe("start message (specs/134, specs/137)", () => {
  test("no request is exactly 'Begin.'; a request is delimited and bounded; background only with a request", () => {
    expect(buildHarnessStartMessage(undefined)).toBe("Begin.")
    expect(buildHarnessStartMessage("   ")).toBe("Begin.")
    const message = buildHarnessStartMessage("dockerize on port 4000", "dockerize on port 4000 and add CI")
    expect(message).toContain("<<<REQUEST\ndockerize on port 4000\nREQUEST>>>")
    expect(message).toContain("<<<BACKGROUND")
    expect(message.endsWith("Begin.")).toBe(true)
    expect(buildHarnessStartMessage("dockerize", null)).toBe(buildHarnessStartMessage("dockerize"))
    const long = buildHarnessStartMessage("x".repeat(MAX_HARNESS_REQUEST_CHARS + 500))
    expect(long).toContain("x".repeat(MAX_HARNESS_REQUEST_CHARS) + "… [truncated]")
  })

  test("run-command's hint is the step, with the background in the system prompt only once", async () => {
    const model = new ScriptedChatModel([textMessage('{"argv":["bun","test"],"reason":"tests"}')])
    await runRunCommandHarness({ model, mcpClient: new MockMcpToolCaller({}), taskId: "t", projectRoot: "/p", hint: "run-command: run the tests", context: "run the tests and also dockerize" })
    const system = String(model.received[0]![0]!.content)
    expect(system).toContain("Context: run-command: run the tests")
    expect(system).toContain("<<<BACKGROUND")
    expect(String(model.received[0]![1]!.content)).toBe("Begin.")
  })
})
