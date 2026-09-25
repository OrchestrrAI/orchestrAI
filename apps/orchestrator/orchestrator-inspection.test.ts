// specs/102-orchestrator-readonly-project-inspection/spec.md
//
// The "strictly optional" guarantee is the load-bearing property this
// spec adds — every degradation path below is asserted directly, not
// inferred from "no visible difference". No real MCP server, no real
// agent, no real network call anywhere in this file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import {
  app,
  conversations,
  registry,
  tasks,
  buildOrchestratorMcpClient,
  computeDeepProjectAnalysis,
  dispatchRootTask,
  inspectTargetProject,
  inspectTargetProjectAsTaskResult,
  resolveSupervisorFinalContext,
  INSPECTION_FALLBACK_SKILLS,
  __setTestOrchestratorMcpClient,
  __setTestProjectAnalysisModel,
  __setTestRouterModel,
  type OrchestratorTask,
  type RegisteredAgent,
} from "./index"
import { buildSystemPrompt } from "./supervisor-graph"
import { KeywordRouterFake } from "./keyword-router-fake"
import { OrchestraiMcpClient } from "../../packages/shared/mcp-client"
import { __resetSharedStoreForTests, getSharedStore } from "../../packages/shared/store"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const TARGET = "C:\\proj"

function fakeClient(resultsByTool: Record<string, string | Error>): OrchestraiMcpClient {
  const calls: { toolName: string; args: Record<string, unknown> }[] = []
  const client = {
    calls,
    async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
      calls.push({ toolName, args })
      const result = resultsByTool[toolName]
      if (result === undefined) throw new Error(`no mock result for ${toolName}`)
      if (result instanceof Error) throw result
      return result
    },
  }
  return client as unknown as OrchestraiMcpClient
}

function agent(name: string, skillIds: string[], url = `http://localhost:0/${name}`): RegisteredAgent {
  return {
    card: { name, description: "", url, version: "1.0.0", skills: skillIds.map((id) => ({ id, name: id, description: "" })) },
    url,
    status: "online",
    lastSeen: new Date(),
  }
}

// TARGET is a fake, non-existent path used purely as a string constant —
// never a real directory. Forcing ORCHESTRAI_PERSIST=0 for this file's
// duration keeps store.ts's openStore() from treating it as real and
// writing a genuine SQLite database under it; this file is about the
// deep-analysis wiring, not store behavior (that's store.test.ts's and
// project-analysis.test.ts's job).
let originalEnv: string | undefined
let originalPersist: string | undefined
beforeEach(() => {
  originalEnv = process.env.ORCHESTRAI_PROJECT_PATH
  originalPersist = process.env.ORCHESTRAI_PERSIST
  process.env.ORCHESTRAI_PROJECT_PATH = TARGET
  process.env.ORCHESTRAI_PERSIST = "0"
  __resetSharedStoreForTests()
  registry.clear()
  tasks.clear()
  conversations.clear()
})
afterEach(() => {
  if (originalEnv === undefined) delete process.env.ORCHESTRAI_PROJECT_PATH
  else process.env.ORCHESTRAI_PROJECT_PATH = originalEnv
  if (originalPersist === undefined) delete process.env.ORCHESTRAI_PERSIST
  else process.env.ORCHESTRAI_PERSIST = originalPersist
  __resetSharedStoreForTests()
  __setTestOrchestratorMcpClient(null)
  __setTestRouterModel(null)
  __setTestProjectAnalysisModel(null)
  registry.clear()
  tasks.clear()
  conversations.clear()
})

// specs/105-orchestrator-fallback-deep-analysis/spec.md — a scripted
// model standing in for the shared analysis harness's own real provider
// call, injected via __setTestProjectAnalysisModel() the same way
// __setTestRouterModel() already does for the capability router.
class ScriptedAnalysisModel extends BaseChatModel {
  private index = 0
  constructor(private readonly responses: string[]) {
    super({})
  }
  _llmType(): string {
    return "scripted-fake-analysis-model"
  }
  bindTools(_tools: unknown): this {
    return this
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const text = this.responses[Math.min(this.index, this.responses.length - 1)]
    this.index += 1
    return { generations: [{ text, message: new AIMessage({ content: text }) }] }
  }
}

function analysisResponse(observations: { text: string; paths: string[] }[]): string {
  return JSON.stringify({ stack: "TypeScript / Bun", structure: "A monorepo.", observations })
}

function planTask(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: "plan-1", text: "analyze this project", skill: "plan-task",
    status: "working", createdAt: new Date(), isPlan: true, planSteps: [], childTaskIds: [],
    ...overrides,
  }
}

// ============================================================
// buildOrchestratorMcpClient() — construction must never crash startup
// ============================================================
describe("buildOrchestratorMcpClient — construction never throws", () => {
  test("a malformed ORCHESTRAI_MCP_URL degrades to null, not a thrown error", () => {
    expect(() => {
      const client = buildOrchestratorMcpClient({ ORCHESTRAI_MCP_URL: "not a url at all" } as NodeJS.ProcessEnv)
      expect(client).toBeNull()
    }).not.toThrow()
  })

  test("a non-http:// ORCHESTRAI_MCP_URL degrades to null", () => {
    const client = buildOrchestratorMcpClient({ ORCHESTRAI_MCP_URL: "ftp://example.com/mcp" } as NodeJS.ProcessEnv)
    expect(client).toBeNull()
  })

  test("a non-allowlisted host degrades to null", () => {
    const client = buildOrchestratorMcpClient({ ORCHESTRAI_MCP_URL: "http://evil.example.com/mcp" } as NodeJS.ProcessEnv)
    expect(client).toBeNull()
  })

  test("ORCHESTRAI_ORCHESTRATOR_INSPECTION=0 opts out — returns null with a valid URL too", () => {
    const client = buildOrchestratorMcpClient({ ORCHESTRAI_ORCHESTRATOR_INSPECTION: "0" } as NodeJS.ProcessEnv)
    expect(client).toBeNull()
  })

  test("a valid configuration constructs a real client", () => {
    const client = buildOrchestratorMcpClient({} as NodeJS.ProcessEnv)
    expect(client).not.toBeNull()
  })
})

// ============================================================
// inspectTargetProject() — every failure path returns null, never throws
// ============================================================
describe("inspectTargetProject — strictly optional, every failure degrades to null", () => {
  test("no client constructed → null", async () => {
    __setTestOrchestratorMcpClient(null)
    const result = await inspectTargetProject("analyze this project", "t-1")
    expect(result).toBeNull()
  })

  test("unresolvable target path → null", async () => {
    delete process.env.ORCHESTRAI_PROJECT_PATH
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "x", git_status: "y" }))
    const result = await inspectTargetProject("analyze this project", "t-1")
    expect(result).toBeNull()
  })

  test("a callTool() failure → null, not a thrown error", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: new Error("MCP unreachable") }))
    let threw = false
    let result: string | null = null
    try {
      result = await inspectTargetProject("analyze this project", "t-1")
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).toBeNull()
  })

  test("success with no conversationId returns real content and never touches the cache", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "=== Project Analysis ===\nreal stuff", git_status: "branch: main" }))
    const result = await inspectTargetProject("analyze this project", "t-1")
    expect(result).toContain(TARGET)
    expect(result).toContain("real stuff")
    expect(result).toContain("branch: main")
  })

  // specs/103-deep-project-analysis/spec.md — reverses specs/102's
  // original design. The two used to deliberately share one cache
  // entry ("whichever happens first in a conversation grounds the other
  // for free"); that became wrong once DevOps's own analyze-project
  // skill became genuinely richer than this tool-only inspection would
  // ever be — sharing a key would let this shallow call silently
  // populate the cache with the shallow result and starve a later real
  // analyze-project request of the deep one. This test now asserts the
  // corrected behavior directly: they no longer collide.
  //
  // specs/106-persistence-store-and-result-cache/spec.md B3 — these four
  // tests exercise real cache round-tripping, which the outer file's own
  // ORCHESTRAI_PERSIST=0 (see the top-of-file comment) deliberately
  // disables for every other test here. This nested block re-enables
  // persistence against a real scratch directory used as BOTH the store's
  // own db location and (since "analyze this project" carries no explicit
  // path in its text) the resolved analysis target itself — never the
  // fake "C:\proj" TARGET constant, so this can never repeat the
  // real-filesystem-pollution bug that motivated disabling it everywhere
  // else in this file.
  describe("cache passthrough — real store", () => {
    let scratchDir: string
    let originalProjectPath: string | undefined
    let originalPersist: string | undefined
    beforeEach(() => {
      scratchDir = mkdtempSync(path.join(os.tmpdir(), "orchestrai-inspection-cache-test-"))
      originalProjectPath = process.env.ORCHESTRAI_PROJECT_PATH
      originalPersist = process.env.ORCHESTRAI_PERSIST
      process.env.ORCHESTRAI_PROJECT_PATH = scratchDir
      delete process.env.ORCHESTRAI_PERSIST
      __resetSharedStoreForTests()
    })
    afterEach(() => {
      __resetSharedStoreForTests()
      if (originalProjectPath === undefined) delete process.env.ORCHESTRAI_PROJECT_PATH
      else process.env.ORCHESTRAI_PROJECT_PATH = originalProjectPath
      if (originalPersist === undefined) delete process.env.ORCHESTRAI_PERSIST
      else process.env.ORCHESTRAI_PERSIST = originalPersist
      rmSync(scratchDir, { recursive: true, force: true })
    })

    test("a real dispatched analyze-project skill's cache entry is NOT reused by the supervisor's own inspection — no shallow/deep collision", async () => {
      const conversationId = "conv-shared"
      conversations.set(conversationId, { id: conversationId, turns: [], createdAt: new Date(), lastActivityAt: new Date() } as any)
      // Populate the cache exactly the way a real dispatched analyze-project
      // skill already does (index.ts's own populateSnapshotCacheWhenTaskTerminates) —
      // under the skill's own cache key, distinct from this inspection's own.
      const store = getSharedStore()
      expect(store).not.toBeNull()
      store!.setCachedResult({
        kind: "analyze-project", projectRoot: scratchDir, targetRel: ".", inputHash: "none", schemaVer: 1,
        result: "=== Project Analysis ===\nfrom a real dispatch, possibly deep",
        gitFingerprint: "branch: main, clean", ttlMs: 5 * 60 * 1000, producer: "devops-agent",
      })

      const client = fakeClient({
        analyze_project: "=== Project Analysis ===\nshallow inspection result",
        git_status: "branch: main, clean",
      })
      __setTestOrchestratorMcpClient(client)
      const result = await inspectTargetProject("analyze this project", "t-1", conversationId)

      // A genuine fresh fetch happened — the skill's own richer cache
      // entry was never read, so its content never leaked into this
      // inspection's own result.
      expect(result).toContain("shallow inspection result")
      expect(result).not.toContain("from a real dispatch")
      expect((client as any).calls.map((c: any) => c.toolName).sort()).toEqual(["analyze_project", "git_status"])
    })

    test("this inspection's own cache entry is reused on a second call — no second MCP call", async () => {
      const conversationId = "conv-own-cache"
      conversations.set(conversationId, { id: conversationId, turns: [], createdAt: new Date(), lastActivityAt: new Date() } as any)

      const client = fakeClient({
        analyze_project: "=== Project Analysis ===\nfirst real fetch",
        git_status: "branch: main, clean",
      })
      __setTestOrchestratorMcpClient(client)

      const first = await inspectTargetProject("analyze this project", "t-1", conversationId)
      expect(first).toContain("first real fetch")
      expect((client as any).calls).toHaveLength(2) // analyze_project + git_status

      const second = await inspectTargetProject("analyze this project", "t-2", conversationId)
      expect(second).toContain("first real fetch")
      // Only the cheap git_status cross-check ran the second time — never a
      // second, real analyze_project call, since the fingerprint matched.
      expect((client as any).calls).toHaveLength(3)
      expect((client as any).calls[2].toolName).toBe("git_status")
    })

    test("a cache hit whose cross-check no longer matches falls through to a genuine fresh fetch", async () => {
      const conversationId = "conv-stale"
      conversations.set(conversationId, { id: conversationId, turns: [], createdAt: new Date(), lastActivityAt: new Date() } as any)

      const client = fakeClient({
        analyze_project: "=== Project Analysis ===\nfirst real fetch",
        git_status: "branch: main, clean",
      })
      __setTestOrchestratorMcpClient(client)
      await inspectTargetProject("analyze this project", "t-1", conversationId) // populates this inspection's own cache entry

      const staleClient = fakeClient({
        analyze_project: "=== Project Analysis ===\ngenuinely fresh",
        git_status: "branch: main, DIRTY", // no longer matches the cached fingerprint
      })
      __setTestOrchestratorMcpClient(staleClient)
      const result = await inspectTargetProject("analyze this project", "t-2", conversationId)

      expect(result).toContain("genuinely fresh")
      expect(result).not.toContain("first real fetch")
    })

    test("no conversationId (bare POST /tasks shape) never touches the cache at all", async () => {
      __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "fresh", git_status: "clean" }))
      await inspectTargetProject("analyze this project", "t-1") // no conversationId

      // specs/057's own existing rule, preserved by specs/106 B3: nothing
      // is ever written for a conversation-less request. Checked directly
      // against the real store rather than inferring it from behavior.
      const store = getSharedStore()
      expect(store).not.toBeNull()
      const cached = store!.getCachedResult({
        kind: "analyze-project", projectRoot: scratchDir, targetRel: ".", inputHash: "none", schemaVer: 1,
      })
      expect(cached).toBeNull()
    })
  })
})

// ============================================================
// buildSystemPrompt() — byte-identical with no context, direct fix for the
// model-invented `target` bug class otherwise
// ============================================================
describe("buildSystemPrompt — additive only", () => {
  test("with no projectContext, output is byte-identical to before this spec", () => {
    const withoutArg = buildSystemPrompt("build and deploy my app")
    const withUndefined = buildSystemPrompt("build and deploy my app", undefined)
    expect(withUndefined).toBe(withoutArg)
    expect(withoutArg).not.toContain("Here is what the Orchestrator already knows")
  })

  test("with projectContext, the real resolved path is stated in the prompt", () => {
    const prompt = buildSystemPrompt("build and deploy my app", `=== Target Project (real, resolved path — use this, never a guess) ===\n${TARGET}`)
    expect(prompt).toContain(TARGET)
    expect(prompt).toContain("Here is what the Orchestrator already knows")
  })

  // specs/103-deep-project-analysis/spec.md — the supervisor prompt nudge
  test("with projectContext, the analyze-project redundant-dispatch nudge is present", () => {
    const prompt = buildSystemPrompt("build and deploy my app", `=== Target Project (real, resolved path — use this, never a guess) ===\n${TARGET}`)
    expect(prompt).toContain("do not dispatch analyze-project again purely to re-orient")
  })

  test("with no projectContext, the nudge is absent — nothing to be grounded by", () => {
    const prompt = buildSystemPrompt("build and deploy my app")
    expect(prompt).not.toContain("do not dispatch analyze-project again")
  })
})

// ============================================================
// inspectTargetProjectAsTaskResult() — the no-agent fallback's own result shape
// ============================================================
describe("inspectTargetProjectAsTaskResult — dispatchRootTask()'s no-agent fallback", () => {
  test("a skill outside the fallback set always returns null", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "x", git_status: "y" }))
    const result = await inspectTargetProjectAsTaskResult("dockerize", "at C:\\proj", "t-1")
    expect(result).toBeNull()
  })

  test("analyze-project returns only the analyze_project result, not the combined prompt block", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "=== Project Analysis ===\nreal", git_status: "branch: main" }))
    const result = await inspectTargetProjectAsTaskResult("analyze-project", "analyze at C:\\proj", "t-1")
    expect(result).toContain("real")
    expect(result).not.toContain("=== Git Status ===")
  })

  test("git-status returns only the git_status result", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "x", git_status: "branch: main, clean" }))
    const result = await inspectTargetProjectAsTaskResult("git-status", "git status at C:\\proj", "t-1")
    expect(result).toBe("branch: main, clean")
  })

  test("both fallback skill ids are the exact set the spec names", () => {
    expect(INSPECTION_FALLBACK_SKILLS.has("analyze-project")).toBe(true)
    expect(INSPECTION_FALLBACK_SKILLS.has("git-status")).toBe(true)
    expect(INSPECTION_FALLBACK_SKILLS.size).toBe(2)
  })

  // specs/105-orchestrator-fallback-deep-analysis/spec.md
  test("analyze-project appends a real deep analysis after the shallow text when the harness succeeds", async () => {
    __setTestOrchestratorMcpClient(fakeClient({
      analyze_project: "=== Project Analysis ===\nshallow",
      git_status: "branch: main",
      read_project_file: "content",
    }))
    __setTestProjectAnalysisModel(new ScriptedAnalysisModel([
      analysisResponse([{ text: "Real finding.", paths: ["src/index.ts"] }]),
    ]))
    // Grounding is exercised for real here (a real path, verified via
    // the fakeClient's own read_project_file result) — depth of that
    // mechanism itself is project-analysis.test.ts's own job; this test
    // is about the append wiring.
    const result = await inspectTargetProjectAsTaskResult("analyze-project", "analyze at C:\\proj", "t-1")
    expect(result).toContain("shallow")
    expect(result).toContain("=== Codebase Analysis ===")
    expect(result).toContain("Real finding.")
  })

  test("analyze-project degrades to shallow-only when no deep-analysis key is configured", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "=== Project Analysis ===\nshallow only", git_status: "branch: main" }))
    // No __setTestProjectAnalysisModel() — computeDeepProjectAnalysis()
    // falls through to the real config path, which has no key in this
    // test environment, so it returns null.
    const result = await inspectTargetProjectAsTaskResult("analyze-project", "analyze at C:\\proj", "t-1")
    expect(result).toBe("=== Project Analysis ===\nshallow only")
    expect(result).not.toContain("=== Codebase Analysis ===")
  })

  test("git-status never attempts the deep-analysis path at all", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "x", git_status: "branch: main, clean" }))
    __setTestProjectAnalysisModel(new ScriptedAnalysisModel([analysisResponse([])]))
    const result = await inspectTargetProjectAsTaskResult("git-status", "git status at C:\\proj", "t-1")
    expect(result).toBe("branch: main, clean")
  })
})

// ============================================================
// computeDeepProjectAnalysis() — fail-open on every degradation path
// ============================================================
describe("computeDeepProjectAnalysis — fail-open, never throws", () => {
  test("no client → null", async () => {
    __setTestOrchestratorMcpClient(null)
    const result = await computeDeepProjectAnalysis("analyze this project", "t-1")
    expect(result).toBeNull()
  })

  test("unresolvable target path → null", async () => {
    delete process.env.ORCHESTRAI_PROJECT_PATH
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "x", git_status: "y" }))
    const result = await computeDeepProjectAnalysis("analyze this project", "t-1")
    expect(result).toBeNull()
  })

  test("the underlying tool call failing → null, not a thrown error", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: new Error("boom"), git_status: "y" }))
    const result = await computeDeepProjectAnalysis("analyze this project", "t-1")
    expect(result).toBeNull()
  })

  test("no resolvable orchestrator key → null (key-gated, matching specs/038)", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "x", git_status: "y" }))
    // No __setTestProjectAnalysisModel() and no real key in this test
    // environment — falls through to readLlmModelConfig() returning
    // nothing resolvable.
    const result = await computeDeepProjectAnalysis("analyze this project", "t-1")
    expect(result).toBeNull()
  })

  test("a real grounded response renders the full Codebase Analysis section", async () => {
    __setTestOrchestratorMcpClient(fakeClient({
      analyze_project: "=== Project Analysis ===\n...",
      git_status: "branch: main",
      read_project_file: "content",
    }))
    __setTestProjectAnalysisModel(new ScriptedAnalysisModel([
      analysisResponse([{ text: "A real, grounded observation.", paths: ["src/index.ts"] }]),
    ]))
    const result = await computeDeepProjectAnalysis("analyze this project", "t-1")
    expect(result).toContain("=== Codebase Analysis ===")
    expect(result).toContain("Stack: TypeScript / Bun")
    expect(result).toContain("A real, grounded observation.")
  })

  test("the harness producing nothing grounded → null", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "x", git_status: "y" }))
    __setTestProjectAnalysisModel(new ScriptedAnalysisModel([
      analysisResponse([{ text: "Cites a path nothing can verify.", paths: ["made/up.ts"] }]),
    ]))
    const result = await computeDeepProjectAnalysis("analyze this project", "t-1")
    expect(result).toBeNull()
  })
})

// ============================================================
// resolveSupervisorFinalContext() — the zero-dispatch → deep-analysis
// upgrade, tested directly with a given dispatchCount rather than
// driving the full LangGraph supervisor decision loop (which has no
// test-model seam of its own) to actually produce one — see this
// spec's own verification.md for why, and the live-verification pass
// that covers the true end-to-end path this stands in for.
// ============================================================
describe("resolveSupervisorFinalContext — the specs/105 zero-dispatch upgrade", () => {
  test("a non-zero dispatch count returns projectContext untouched — no deep-analysis call attempted at all", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "x", git_status: "y" }))
    __setTestProjectAnalysisModel(new ScriptedAnalysisModel([analysisResponse([{ text: "should never be reached", paths: [] }])]))
    const task = planTask()
    const result = await resolveSupervisorFinalContext(task, 3, "shallow context")
    expect(result).toBe("shallow context")
  })

  test("zero dispatches with a successful deep analysis appends it to the existing shallow context", async () => {
    __setTestOrchestratorMcpClient(fakeClient({
      analyze_project: "=== Project Analysis ===\n...",
      git_status: "branch: main",
      read_project_file: "content",
    }))
    __setTestProjectAnalysisModel(new ScriptedAnalysisModel([
      analysisResponse([{ text: "Real, grounded observation.", paths: ["src/index.ts"] }]),
    ]))
    const task = planTask()
    const result = await resolveSupervisorFinalContext(task, 0, "shallow context")
    expect(result).toContain("shallow context")
    expect(result).toContain("=== Codebase Analysis ===")
    expect(result).toContain("Real, grounded observation.")
  })

  test("zero dispatches with no deep analysis available falls back to the original shallow context — byte-identical to pre-105", async () => {
    __setTestOrchestratorMcpClient(null) // no client — computeDeepProjectAnalysis() degrades to null
    const task = planTask()
    const result = await resolveSupervisorFinalContext(task, 0, "shallow context")
    expect(result).toBe("shallow context")
  })

  test("zero dispatches with no prior projectContext at all still surfaces the deep analysis on its own", async () => {
    __setTestOrchestratorMcpClient(fakeClient({
      analyze_project: "=== Project Analysis ===\n...",
      git_status: "branch: main",
      read_project_file: "content",
    }))
    __setTestProjectAnalysisModel(new ScriptedAnalysisModel([
      analysisResponse([{ text: "Real, grounded observation.", paths: ["src/index.ts"] }]),
    ]))
    const task = planTask()
    const result = await resolveSupervisorFinalContext(task, 0, undefined)
    expect(result).toContain("=== Codebase Analysis ===")
  })
})

// ============================================================
// dispatchRootTask() — the no-agent fallback, exercised directly
// ============================================================
// A real finding from implementing this spec, not assumed away: natural-
// language routing can NEVER actually produce "analyze-project"/
// "git-status" here when zero agents are online, because the LLM router
// validates every proposal against the live capability snapshot before
// using it (CLAUDE.md: "the LLM router is now the only routing tier") —
// with no agent advertising the skill, the router always falls through
// to "plan-task" instead, never reaching this branch at all. So this
// fallback's real-world reach is defense-in-depth (a race between
// snapshot-build and dispatch), not the primary "--only orchestrator"
// fix — that is composeSupervisorResult()'s own zero-dispatch surfacing
// (see compose-supervisor-result.test.ts), fed by this same inspection
// capability. Exercised directly here with an explicit skill, exactly
// as the spec itself describes the mechanism operating, rather than via
// a router path that cannot actually reach it.
describe("dispatchRootTask() — no-agent fallback, exercised directly", () => {
  test("with inspection available, an explicit skill that would otherwise fail 'No agent found for skill' completes with a real answer instead", async () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "=== Project Analysis ===\nreal analysis", git_status: "branch: main" }))

    const dispatched = dispatchRootTask("analyze at C:\\proj", "analyze-project")
    expect(dispatched.ok).toBe(true)
    if (!dispatched.ok) return

    const start = Date.now()
    let task = tasks.get(dispatched.task.id)!
    while (Date.now() - start < 3000) {
      task = tasks.get(dispatched.task.id)!
      if (task.status !== "working" && task.status !== "assigned") break
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(task.status).toBe("completed")
    expect(task.result).toContain("real analysis")
  })

  test("with inspection unavailable (no client), the identical request degrades to the exact pre-102 failure", async () => {
    __setTestOrchestratorMcpClient(null)

    const dispatched = dispatchRootTask("analyze at C:\\proj", "analyze-project")
    expect(dispatched.ok).toBe(true)
    if (!dispatched.ok) return

    const start = Date.now()
    let task = tasks.get(dispatched.task.id)!
    while (Date.now() - start < 3000) {
      task = tasks.get(dispatched.task.id)!
      if (task.status !== "working" && task.status !== "assigned") break
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(task.status).toBe("failed")
    expect(task.error).toContain("No agent found for skill")
  })

  test("a skill outside the fallback set (e.g. dockerize) fails exactly as before — no change for write-capable skills", () => {
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: "x", git_status: "y" }))
    const dispatched = dispatchRootTask("dockerize at C:\\proj", "dockerize")
    expect(dispatched.ok).toBe(false)
    if (dispatched.ok) return
    expect(dispatched.error).toContain("No agent found for skill")
  })

  test("with a real agent online for the skill, the fallback never engages — dispatch is always preferred", async () => {
    registry.set("devops-agent", agent("devops-agent", ["analyze-project"]))
    __setTestRouterModel(new KeywordRouterFake())
    // A client that would throw if ever called — proves it never is.
    __setTestOrchestratorMcpClient(fakeClient({ analyze_project: new Error("should never be called"), git_status: new Error("should never be called") }))

    const originalFetch = globalThis.fetch
    // @ts-expect-error — test double, narrower than the real fetch signature
    globalThis.fetch = async (url: string) => {
      if (url.includes("/.well-known/agent.json")) {
        return new Response(JSON.stringify({ name: "unused", description: "", url: "", version: "1.0.0", skills: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: "orch-x", status: "submitted" }), { status: 200 })
    }

    try {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "analyze this project" }),
      })
      const submitted = (await res.json()) as { id: string }
      const t = await app.request(`/tasks/${submitted.id}`)
      const task = (await t.json()) as any
      // Dispatched to the real agent — never our fake client.
      expect(task.assignedAgent).toBe("devops-agent")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
