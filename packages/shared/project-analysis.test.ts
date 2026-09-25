// specs/105-orchestrator-fallback-deep-analysis/spec.md — moved verbatim
// from packages/agents/devops/llm-harness.test.ts (specs/103's own
// tests) alongside the implementation, since this is now the ONE shared
// module both DevOps and the Orchestrator import. No network calls, no
// live API credentials, no real MCP server required.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { mkdtempSync, rmSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  READ_ONLY_TOOL_NAMES,
  type McpToolCaller,
  buildReadOnlyTools,
  getCachedProjectAnalysis,
  runProjectAnalysisHarness,
  setCachedProjectAnalysis,
} from "./project-analysis"
import { __resetSharedStoreForTests } from "./store"

// ============================================================
// TEST DOUBLES
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

function textMessage(text: string): AIMessage {
  return new AIMessage({ content: text })
}

function toolCallMessage(toolName: string, id: string): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ name: toolName, args: { relative_path: "package.json" }, id }] })
}

// Path grounding needs per-argument branching a flat mock doesn't
// support — a dedicated mock whose read_project_file result depends on
// the real relative_path requested, mirroring exactly what
// verifyPathExists() does against a real MCP server: success for a real
// path, a thrown error for anything else.
class PathAwareMcpToolCaller implements McpToolCaller {
  public calls: { toolName: string; args: Record<string, unknown> }[] = []
  constructor(private readonly realPaths: Set<string>) {}
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    this.calls.push({ toolName, args })
    if (toolName === "read_project_file") {
      const relativePath = args.relative_path as string
      if (this.realPaths.has(relativePath)) return `content of ${relativePath}`
      throw new Error(`Path not found: ${relativePath}`)
    }
    return `no mock result for ${toolName}`
  }
}

function analysisJson(observations: { text: string; paths: string[] }[], stack = "TypeScript / Bun", structure = "A monorepo with apps/ and packages/."): string {
  return JSON.stringify({ stack, structure, observations })
}

// ============================================================
// bound tool set
// ============================================================
describe("bound tool set — write-capable tool structurally unreachable", () => {
  test("exactly READ_ONLY_TOOL_NAMES is bound as graph tools, no more and no less", () => {
    const mcpClient = new PathAwareMcpToolCaller(new Set())
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\any\\project")
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...READ_ONLY_TOOL_NAMES].sort())
  })

  test("write_project_file never appears in the bound tool set", () => {
    const mcpClient = new PathAwareMcpToolCaller(new Set())
    const tools = buildReadOnlyTools(mcpClient, "task-x", "C:\\any\\project")
    const names = tools.map((t) => t.name)
    expect(names).not.toContain("write_project_file")
  })
})

// ============================================================
// runProjectAnalysisHarness — grounded codebase analysis
// ============================================================
describe("runProjectAnalysisHarness — grounded codebase analysis", () => {
  test("a fully-grounded response is accepted on the first attempt", async () => {
    const mcpClient = new PathAwareMcpToolCaller(new Set(["apps/orchestrator/index.ts", "packages/shared"]))
    const model = new ScriptedChatModel([
      textMessage(
        analysisJson([
          { text: "The Orchestrator owns routing and the approval gate.", paths: ["apps/orchestrator/index.ts"] },
          { text: "Cross-cutting types live in one shared package.", paths: ["packages/shared"] },
        ]),
      ),
    ])

    const result = await runProjectAnalysisHarness({
      model,
      mcpClient,
      taskId: "task-100",
      projectRoot: "C:\\any",
      deterministicReport: "=== Project Analysis ===\n...",
    })

    expect(result).not.toBeNull()
    expect(result!.stack).toBe("TypeScript / Bun")
    expect(result!.observations).toHaveLength(2)
  })

  test("zero observations is a valid, if thin, analysis — not an error", async () => {
    const mcpClient = new PathAwareMcpToolCaller(new Set())
    const model = new ScriptedChatModel([textMessage(analysisJson([]))])

    const result = await runProjectAnalysisHarness({
      model, mcpClient, taskId: "task-101", projectRoot: "C:\\any", deterministicReport: "...",
    })

    expect(result).toEqual({ stack: "TypeScript / Bun", structure: "A monorepo with apps/ and packages/.", observations: [] })
  })

  test("an ungrounded path triggers retry-with-feedback naming it, then succeeds once corrected", async () => {
    const mcpClient = new PathAwareMcpToolCaller(new Set(["real/file.ts"]))
    const model = new ScriptedChatModel([
      textMessage(analysisJson([{ text: "A claim about a file that does not exist.", paths: ["made/up/file.ts"] }])),
      textMessage(analysisJson([{ text: "A corrected, real claim.", paths: ["real/file.ts"] }])),
    ])

    const result = await runProjectAnalysisHarness({
      model, mcpClient, taskId: "task-102", projectRoot: "C:\\any", deterministicReport: "...",
    })

    expect(result!.observations).toEqual([{ text: "A corrected, real claim.", paths: ["real/file.ts"] }])
  })

  test("exhausted retries salvage the largest grounded subset seen across any attempt", async () => {
    const mcpClient = new PathAwareMcpToolCaller(new Set(["real/a.ts"]))
    // Attempt 1: one grounded + one ungrounded observation — rejected as a
    // whole (the ungrounded one fails it), but the grounded one must be
    // remembered. Attempt 2: a strictly worse, fully-ungrounded response.
    // The FIRST attempt's real grounded observation must survive, not be
    // erased by the worse second attempt.
    const model = new ScriptedChatModel([
      textMessage(
        analysisJson([
          { text: "Real, grounded.", paths: ["real/a.ts"] },
          { text: "Not real.", paths: ["fake/b.ts"] },
        ]),
      ),
      textMessage(analysisJson([{ text: "Still not real.", paths: ["fake/c.ts"] }])),
    ])

    const result = await runProjectAnalysisHarness({
      model, mcpClient, taskId: "task-103", projectRoot: "C:\\any", deterministicReport: "...", maxRetries: 1,
    })

    expect(result!.observations).toEqual([{ text: "Real, grounded.", paths: ["real/a.ts"] }])
  })

  test("exhausted retries with zero grounded observations ever fails closed to null", async () => {
    const mcpClient = new PathAwareMcpToolCaller(new Set())
    const model = new ScriptedChatModel([
      textMessage(analysisJson([{ text: "Fake 1.", paths: ["fake/1.ts"] }])),
      textMessage(analysisJson([{ text: "Fake 2.", paths: ["fake/2.ts"] }])),
    ])

    const result = await runProjectAnalysisHarness({
      model, mcpClient, taskId: "task-104", projectRoot: "C:\\any", deterministicReport: "...", maxRetries: 1,
    })

    expect(result).toBeNull()
  })

  test("malformed JSON triggers retry-with-feedback like any other invalid response", async () => {
    const mcpClient = new PathAwareMcpToolCaller(new Set(["real/a.ts"]))
    const model = new ScriptedChatModel([
      textMessage("not json at all"),
      textMessage(analysisJson([{ text: "Real, grounded.", paths: ["real/a.ts"] }])),
    ])

    const result = await runProjectAnalysisHarness({
      model, mcpClient, taskId: "task-105", projectRoot: "C:\\any", deterministicReport: "...",
    })

    expect(result!.observations).toEqual([{ text: "Real, grounded.", paths: ["real/a.ts"] }])
  })

  test("a path cited by more than one observation is verified once, not once per citation", async () => {
    const mcpClient = new PathAwareMcpToolCaller(new Set(["shared/path.ts"]))
    const model = new ScriptedChatModel([
      textMessage(
        analysisJson([
          { text: "First claim about the shared file.", paths: ["shared/path.ts"] },
          { text: "Second claim about the same file.", paths: ["shared/path.ts"] },
        ]),
      ),
    ])

    const result = await runProjectAnalysisHarness({
      model, mcpClient, taskId: "task-106", projectRoot: "C:\\any", deterministicReport: "...",
    })

    expect(result!.observations).toHaveLength(2)
    const readCalls = mcpClient.calls.filter((c) => c.toolName === "read_project_file")
    expect(readCalls).toHaveLength(1)
  })

  test("the deterministic report is embedded verbatim in the system prompt before any tool call", async () => {
    const capturedMessages: BaseMessage[] = []
    class CapturingModel extends ScriptedChatModel {
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        capturedMessages.push(...messages)
        return super._generate(messages)
      }
    }
    const mcpClient = new PathAwareMcpToolCaller(new Set(["real/a.ts"]))
    const model = new CapturingModel([textMessage(analysisJson([{ text: "Real, grounded.", paths: ["real/a.ts"] }]))])

    const deterministicReport = "=== Project Analysis ===\nUNIQUE-SENTINEL-MARKER-xyz789\n=== Files & Folders ===\nsrc/"
    await runProjectAnalysisHarness({
      model, mcpClient, taskId: "task-108", projectRoot: "C:\\any", deterministicReport,
    })

    const systemMessage = capturedMessages.find((m) => m._getType() === "system")
    const systemText = typeof systemMessage?.content === "string" ? systemMessage.content : ""
    expect(systemText).toContain("UNIQUE-SENTINEL-MARKER-xyz789")
    expect(systemText).toContain(deterministicReport)
  })

  test("the model may call read_project_file to explore beyond the pre-fed context — the tool is bound, just not required", async () => {
    const mcpClient = new PathAwareMcpToolCaller(new Set(["real/a.ts"]))
    const model = new ScriptedChatModel([
      toolCallMessage("read_project_file", "call_1"),
      textMessage(analysisJson([{ text: "Real, grounded.", paths: ["real/a.ts"] }])),
    ])

    const result = await runProjectAnalysisHarness({
      model, mcpClient, taskId: "task-107", projectRoot: "C:\\any", deterministicReport: "...",
    })

    expect(result!.observations).toEqual([{ text: "Real, grounded.", paths: ["real/a.ts"] }])
  })
})

// ============================================================
// getCachedProjectAnalysis / setCachedProjectAnalysis — specs/106
// ============================================================
class GroundingMcpClient implements McpToolCaller {
  constructor(private readonly gitStatus: string, private readonly shouldFail = false) {}
  async callTool(toolName: string): Promise<string> {
    if (toolName === "git_status") {
      if (this.shouldFail) throw new Error("git_status failed")
      return this.gitStatus
    }
    return "no mock result"
  }
}

const SAMPLE_RESULT = { stack: "TypeScript / Bun", structure: "A monorepo.", observations: [{ text: "A finding.", paths: ["src/index.ts"] }] }

describe("getCachedProjectAnalysis / setCachedProjectAnalysis — specs/106 store wiring", () => {
  let scratchDir: string
  let originalProjectPath: string | undefined
  let originalPersist: string | undefined

  beforeEach(() => {
    scratchDir = mkdtempSync(path.join(os.tmpdir(), "orchestrai-project-analysis-test-"))
    originalProjectPath = process.env.ORCHESTRAI_PROJECT_PATH
    originalPersist = process.env.ORCHESTRAI_PERSIST
    process.env.ORCHESTRAI_PROJECT_PATH = scratchDir
    delete process.env.ORCHESTRAI_PERSIST
    __resetSharedStoreForTests()
  })
  afterEach(() => {
    if (originalProjectPath === undefined) delete process.env.ORCHESTRAI_PROJECT_PATH
    else process.env.ORCHESTRAI_PROJECT_PATH = originalProjectPath
    if (originalPersist === undefined) delete process.env.ORCHESTRAI_PERSIST
    else process.env.ORCHESTRAI_PERSIST = originalPersist
    __resetSharedStoreForTests()
    rmSync(scratchDir, { recursive: true, force: true })
  })

  test("a miss (nothing ever written) returns null", async () => {
    const mcpClient = new GroundingMcpClient("branch: main")
    const result = await getCachedProjectAnalysis("C:\\proj", mcpClient, "t-1")
    expect(result).toBeNull()
  })

  test("a real write is readable back through getCachedProjectAnalysis, matching gitFingerprint", async () => {
    setCachedProjectAnalysis("C:\\proj", SAMPLE_RESULT, "branch: main, clean", "devops-agent")
    const mcpClient = new GroundingMcpClient("branch: main, clean") // fresh git_status matches the stored fingerprint
    const result = await getCachedProjectAnalysis("C:\\proj", mcpClient, "t-1")
    expect(result).toEqual(SAMPLE_RESULT)
  })

  test("a changed git fingerprint invalidates the cached entry — real drift is never served stale", async () => {
    setCachedProjectAnalysis("C:\\proj", SAMPLE_RESULT, "branch: main, clean", "devops-agent")
    const mcpClient = new GroundingMcpClient("branch: main, DIRTY") // no longer matches
    const result = await getCachedProjectAnalysis("C:\\proj", mcpClient, "t-1")
    expect(result).toBeNull()
  })

  test("a null gitFingerprint at write time means TTL-only validity — served without any cross-check call", async () => {
    setCachedProjectAnalysis("C:\\proj", SAMPLE_RESULT, null, "devops-agent")
    const mcpClient = new GroundingMcpClient("branch: main") // never actually consulted
    const result = await getCachedProjectAnalysis("C:\\proj", mcpClient, "t-1")
    expect(result).toEqual(SAMPLE_RESULT)
  })

  test("a fingerprint cross-check call failing degrades to a miss, not a thrown error", async () => {
    setCachedProjectAnalysis("C:\\proj", SAMPLE_RESULT, "branch: main", "devops-agent")
    const mcpClient = new GroundingMcpClient("branch: main", true)
    const result = await getCachedProjectAnalysis("C:\\proj", mcpClient, "t-1")
    expect(result).toBeNull()
  })

  test("ORCHESTRAI_PERSIST=0 makes both functions no-ops — write then read still misses", async () => {
    process.env.ORCHESTRAI_PERSIST = "0"
    __resetSharedStoreForTests()
    setCachedProjectAnalysis("C:\\proj", SAMPLE_RESULT, null, "devops-agent")
    const mcpClient = new GroundingMcpClient("branch: main")
    const result = await getCachedProjectAnalysis("C:\\proj", mcpClient, "t-1")
    expect(result).toBeNull()
  })

  // specs/106's own decisive claim: DevOps computes it, the Orchestrator
  // (or any other caller) reuses it — no LLM call, no recompute. Both
  // "producers" in this test share the SAME store (same
  // ORCHESTRAI_PROJECT_PATH), which is the entire mechanism.
  test("a result written under one producer name is served to a caller checking under a different one", async () => {
    setCachedProjectAnalysis("C:\\proj", SAMPLE_RESULT, "branch: main", "devops-agent")
    const mcpClient = new GroundingMcpClient("branch: main")
    const result = await getCachedProjectAnalysis("C:\\proj", mcpClient, "t-from-orchestrator")
    expect(result).toEqual(SAMPLE_RESULT)
  })
})
