// specs/057-project-snapshot-and-cross-request-reuse/spec.md, storage
// migrated onto the durable store by
// specs/106-persistence-store-and-result-cache/spec.md B3 — same
// observable behaviors (TTL, git-fingerprint cross-check, explicit-
// refresh bypass, "no conversationId means no cache"), backed by a real
// SQLite file instead of the retired in-memory ProjectSnapshotCache.
//
// Exercises the real dispatchRootTask() cache integration through the
// real POST /ask and POST /tasks surfaces (app.request(), no port
// bound), with a mocked global fetch — no live agents, no live network.
// Mirrors ask-endpoint.test.ts's own established conventions exactly.
//
// Each test gets its own fresh temp directory as ORCHESTRAI_PROJECT_PATH
// (this file's suite runs in parallel with the rest of `bun test`, and a
// shared default path would cross-contaminate — the same test-isolation
// requirement store.test.ts already states) — the shared store singleton
// is reset in beforeEach/afterEach so getSharedStore() reopens fresh
// against that directory each time. TARGET below is a separate thing
// entirely: the string used as the cache key's own projectRoot (the
// resolved target inside task text), never opened as a real directory by
// store.ts, so it staying a fake, non-existent path is fine.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { app, conversations, registry, tasks, __setTestRouterModel, type RegisteredAgent } from "./index"
import { __resetSharedStoreForTests, getSharedStore } from "../../packages/shared/store"
import { KeywordRouterFake } from "./keyword-router-fake"

function agent(name: string, skillIds: string[], url = `http://localhost:0/${name}`): RegisteredAgent {
  return {
    card: { name, description: "", url, version: "1.0.0", skills: skillIds.map((id) => ({ id, name: id, description: "" })) },
    url,
    status: "online",
    lastSeen: new Date(),
  }
}

let capturedRequests: { url: string; body: Record<string, unknown> | null }[] = []
let originalFetch: typeof fetch
let originalProjectPath: string | undefined
let originalPersist: string | undefined
let scratchDir: string

const TARGET = "C:\\proj"

// git-status/analyze-project results keyed by which URL shape they're
// polled from — "/tasks/orch-" is a real skill dispatch's own poll
// (subscribeToAgentStream); "/tasks/a2a-" is callAgent()'s own poll (the
// cheap cross-check / fingerprint-capture calls this spec adds, always
// targeting agents.devops === http://localhost:3002 regardless of what's
// registered in the Orchestrator's own registry).
let skillResult = "clean tree"
let crossCheckResult = "GIT_FP_1"

beforeEach(() => {
  registry.clear()
  tasks.clear()
  conversations.clear()
  scratchDir = mkdtempSync(path.join(os.tmpdir(), "orchestrai-snapshot-cache-test-"))
  originalProjectPath = process.env.ORCHESTRAI_PROJECT_PATH
  originalPersist = process.env.ORCHESTRAI_PERSIST
  process.env.ORCHESTRAI_PROJECT_PATH = scratchDir
  delete process.env.ORCHESTRAI_PERSIST
  __resetSharedStoreForTests()
  // specs/065 — this suite dispatches "git status"/"analyze the
  // project"/"dockerize" and depends on each resolving to its own skill
  // (the cache is keyed by skill). Keyword matching used to guarantee
  // that; the fake router reproduces it, hermetically.
  __setTestRouterModel(new KeywordRouterFake())
  capturedRequests = []
  skillResult = "clean tree"
  crossCheckResult = "GIT_FP_1"
  originalFetch = globalThis.fetch
  // @ts-expect-error — test double, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    capturedRequests.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
    if (url.includes("/.well-known/agent.json")) {
      return new Response(JSON.stringify({ name: "unused", description: "", url: "", version: "1.0.0", skills: [] }), { status: 200 })
    }
    if (url.includes("/tasks/orch-")) {
      return new Response(JSON.stringify({ status: "completed", result: skillResult }), { status: 200 })
    }
    if (url.includes("/tasks/a2a-")) {
      return new Response(JSON.stringify({ status: "completed", result: crossCheckResult }), { status: 200 })
    }
    return new Response(JSON.stringify({ id: "orch-x", status: "submitted" }), { status: 200 })
  }
})

afterEach(() => {
  __setTestRouterModel(null)
  globalThis.fetch = originalFetch
  registry.clear()
  tasks.clear()
  conversations.clear()
  __resetSharedStoreForTests()
  if (originalProjectPath === undefined) delete process.env.ORCHESTRAI_PROJECT_PATH
  else process.env.ORCHESTRAI_PROJECT_PATH = originalProjectPath
  if (originalPersist === undefined) delete process.env.ORCHESTRAI_PERSIST
  else process.env.ORCHESTRAI_PERSIST = originalPersist
  rmSync(scratchDir, { recursive: true, force: true })
})

async function ask(question: string, conversationId?: string) {
  const res = await app.request("/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conversationId ? { question, conversationId } : { question }),
  })
  return { status: res.status, json: (await res.json()) as Record<string, any> }
}

async function submitTask(text: string) {
  const res = await app.request("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
  return { status: res.status, json: (await res.json()) as Record<string, any> }
}

function requestsTo(fragment: string) {
  return capturedRequests.filter((r) => r.url.includes(fragment))
}

async function wait(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

test("the store genuinely opened against this test's own scratch directory", () => {
  expect(existsSync(scratchDir)).toBe(true)
  expect(getSharedStore()).not.toBeNull()
})

describe("specs/057 — git-status cache reuse (TTL-only, no cheaper cross-check exists)", () => {
  test("a second git-status request in the same conversation, within TTL, reuses the cache with no repeated dispatch", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))

    const first = await ask(`what's my git status at ${TARGET}?`)
    await wait(1400) // let the population watcher's poll tick observe completion

    const dispatchCountAfterFirst = requestsTo("devops-agent").filter((r) => r.body?.selectedSkill === "git-status").length
    expect(dispatchCountAfterFirst).toBe(1)

    const second = await ask(`what's my git status at ${TARGET}?`, first.json.conversationId)

    expect(second.json.skill).toBe("git-status")
    expect(second.json.requiresApproval).toBe(false)
    const secondTask = tasks.get(second.json.taskId)
    // Served synchronously from cache — completed immediately, no wait needed.
    expect(secondTask?.status).toBe("completed")
    expect(secondTask?.result).toBe(skillResult)

    // The load-bearing assertion: the real agent dispatch was NOT repeated.
    const dispatchCountAfterSecond = requestsTo("devops-agent").filter((r) => r.body?.selectedSkill === "git-status").length
    expect(dispatchCountAfterSecond).toBe(1)
  })
})

describe("specs/057 — analyze-project cache reuse (cheap git-status cross-check)", () => {
  test("an unchanged cross-check serves the cache without a full re-run", async () => {
    registry.set("devops-agent", agent("devops-agent", ["analyze-project"]))
    skillResult = "=== DevOps MCP Analysis ===\nAll good."
    crossCheckResult = "GIT_FP_STABLE"

    const first = await ask(`analyze my project at ${TARGET}`)
    await wait(1400) // real dispatch completes, then the population watcher captures the fingerprint via callAgent

    const analyzeCountAfterFirst = requestsTo("devops-agent").filter((r) => r.body?.selectedSkill === "analyze-project").length
    expect(analyzeCountAfterFirst).toBe(1)

    const second = await ask(`analyze my project at ${TARGET}`, first.json.conversationId)
    await wait(800) // the cross-check itself is async

    const secondTask = tasks.get(second.json.taskId)
    expect(secondTask?.status).toBe("completed")
    expect(secondTask?.result).toBe(skillResult)

    // No second real analyze-project dispatch — only the cheap cross-check
    // calls hit the devops agent's own selectedSkill:"git-status" path via
    // callAgent(), which targets a fixed URL, not "devops-agent".
    const analyzeCountAfterSecond = requestsTo("devops-agent").filter((r) => r.body?.selectedSkill === "analyze-project").length
    expect(analyzeCountAfterSecond).toBe(1)
  })

  test("a changed cross-check forces a genuine fresh analyze-project dispatch", async () => {
    registry.set("devops-agent", agent("devops-agent", ["analyze-project"]))
    skillResult = "=== DevOps MCP Analysis ===\nFirst run."
    crossCheckResult = "GIT_FP_BEFORE"

    const first = await ask(`analyze my project at ${TARGET}`)
    await wait(1400)

    // Something changed on disk between requests — the next cross-check
    // observes a different git state.
    crossCheckResult = "GIT_FP_AFTER"
    skillResult = "=== DevOps MCP Analysis ===\nSecond run, fresh."

    const second = await ask(`analyze my project at ${TARGET}`, first.json.conversationId)
    await wait(1400) // cross-check, invalidation, and the fresh re-dispatch all complete

    const secondTask = tasks.get(second.json.taskId)
    expect(secondTask?.status).toBe("completed")
    expect(secondTask?.result).toBe("=== DevOps MCP Analysis ===\nSecond run, fresh.")

    const analyzeCount = requestsTo("devops-agent").filter((r) => r.body?.selectedSkill === "analyze-project").length
    expect(analyzeCount).toBe(2) // the original dispatch PLUS the invalidation-triggered fresh one
  })
})

describe("specs/057 — no conversationId, no cache", () => {
  test("a bare POST /tasks (no conversationId) never consults or populates the cache", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))

    await submitTask(`git status at ${TARGET}`)
    await wait(1400)
    await submitTask(`git status at ${TARGET}`)
    await wait(800)

    // Both went through a real dispatch — no cache hit possible with no
    // conversationId at all.
    const dispatchCount = requestsTo("devops-agent").filter((r) => r.body?.selectedSkill === "git-status").length
    expect(dispatchCount).toBe(2)
  })
})

describe("specs/057 — write-capable skill unaffected", () => {
  test("a dockerize request still requires approval, cache-populated or not", async () => {
    registry.set("devops-agent", agent("devops-agent", ["dockerize"]))
    const { json } = await ask(`dockerize my app at ${TARGET}`)
    expect(json.tier).toBe(1)
    expect(json.skill).toBe("dockerize")
    expect(json.requiresApproval).toBe(true)
  })
})

describe("specs/057 — TTL expiry", () => {
  test("an expired cache entry forces a fresh inspection even with no detected change", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))
    const { json: first } = await ask(`git status at ${TARGET}`)
    await wait(1400)

    // Manually expire the store's own entry rather than waiting 5 real
    // minutes — a negative ttlMs makes expires_at land in the past
    // immediately, the same technique store.test.ts's own TTL tests use
    // directly against OrchestraiStore. This exercises the real
    // integration's use of that expiry, not the arithmetic itself again.
    const store = getSharedStore()
    expect(store).not.toBeNull()
    store!.setCachedResult({
      kind: "git-status", projectRoot: TARGET, targetRel: ".", inputHash: "none", schemaVer: 1,
      result: skillResult, gitFingerprint: crossCheckResult, ttlMs: -1, producer: "orchestrator",
    })

    await ask(`git status at ${TARGET}`, first.conversationId)
    await wait(800)

    const dispatchCount = requestsTo("devops-agent").filter((r) => r.body?.selectedSkill === "git-status").length
    expect(dispatchCount).toBe(2) // the original plus the TTL-forced fresh one
  })
})

describe("specs/057 — explicit refresh", () => {
  test("refresh wording in the request text bypasses a valid, unexpired cache entry", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))
    const { json: first } = await ask(`git status at ${TARGET}`)
    await wait(1400)

    await ask(`please refresh the git status at ${TARGET}`, first.conversationId)
    await wait(800)

    const dispatchCount = requestsTo("devops-agent").filter((r) => r.body?.selectedSkill === "git-status").length
    expect(dispatchCount).toBe(2)
  })
})

describe("specs/106 B3 — conversation scoping dropped, cross-conversation reuse", () => {
  test("a result cached under one conversation is served to a second, different conversation for the same target", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))

    const first = await ask(`what's my git status at ${TARGET}?`)
    await wait(1400)
    expect(first.json.conversationId).toBeTruthy()

    // A genuinely different conversation — never seen this target before,
    // under the OLD conversation-scoped cache this would always miss.
    const second = await ask(`what's my git status at ${TARGET}?`)
    expect(second.json.conversationId).not.toBe(first.json.conversationId)

    const secondTask = tasks.get(second.json.taskId)
    expect(secondTask?.status).toBe("completed")
    expect(secondTask?.result).toBe(skillResult)

    const dispatchCount = requestsTo("devops-agent").filter((r) => r.body?.selectedSkill === "git-status").length
    expect(dispatchCount).toBe(1) // the second conversation's request was served from the shared, durable cache
  })
})
