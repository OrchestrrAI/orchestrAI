import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { boundTaskResult, emitAuditEvent, flushAuditBufferForShutdown, resolveAuditPushUrl, TASK_RESULT_MAX_BYTES, truncateUtf8, utf8ByteLength, whitelistAuditParams, __resetAuditBufferForTests } from "./audit"

describe("specs/141 — audit push target", () => {
  test("follows ORCHESTRAI_ORCHESTRATOR_PORT when no URL is set", () => {
    expect(resolveAuditPushUrl({ ORCHESTRAI_ORCHESTRATOR_PORT: "5000" })).toBe("http://localhost:5000/internal/audit-event")
  })
  test("an explicit URL wins over the port", () => {
    expect(resolveAuditPushUrl({ ORCHESTRAI_ORCHESTRATOR_URL: "http://127.0.0.1:7000/", ORCHESTRAI_ORCHESTRATOR_PORT: "5000" }))
      .toBe("http://127.0.0.1:7000/internal/audit-event")
  })
  test("defaults to 3000 with neither set", () => {
    expect(resolveAuditPushUrl({})).toBe("http://localhost:3000/internal/audit-event")
  })
})
import { __resetSharedStoreForTests, getSharedStore } from "./store"

describe("DevOps audit/result bounds", () => {
  test("truncateUtf8 respects byte limits without splitting a character", () => {
    expect(truncateUtf8("ab😀cd", 5)).toBe("ab")
    expect(truncateUtf8("ab😀cd", 6)).toBe("ab😀")
  })

  test("boundTaskResult leaves small results unchanged", () => {
    const result = boundTaskResult("safe result")
    expect(result).toEqual({ text: "safe result", originalBytes: 11, truncated: false })
  })

  test("boundTaskResult caps large results and marks truncation", () => {
    const result = boundTaskResult("x".repeat(TASK_RESULT_MAX_BYTES + 100))
    expect(result.truncated).toBe(true)
    expect(result.originalBytes).toBe(TASK_RESULT_MAX_BYTES + 100)
    expect(result.text.endsWith("[Result truncated at 64 KiB]")).toBe(true)
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(TASK_RESULT_MAX_BYTES)
  })
})

// ============================================================
// specs/108-durable-audit-trail/spec.md — the params whitelist. This is
// the real safety mechanism (the acceptance criterion this spec names
// directly): a run_command event's stored params must contain no argv,
// a call with a real file path must contain no path — checked here
// against the actual function, not by inspection.
// ============================================================
describe("whitelistAuditParams — the real safety mechanism", () => {
  test("a run_command-shaped argv array is dropped entirely", () => {
    const result = whitelistAuditParams({ argv: ["rm", "-rf", "/some/real/path"], retried: false })
    expect(result.argv).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("rm")
    expect(JSON.stringify(result)).not.toContain("/some/real/path")
  })

  test("real file paths (strings) are dropped, booleans/numbers survive", () => {
    const result = whitelistAuditParams({
      repo_path: "C:\\Users\\real\\project", relative_path: "src/secret-config.ts",
      staged: true, port: 3000,
    })
    expect(result.repo_path).toBeUndefined()
    expect(result.relative_path).toBeUndefined()
    expect(result.staged).toBe(true)
    expect(result.port).toBe(3000)
  })

  test("real file content (a string value) is dropped", () => {
    const result = whitelistAuditParams({ content: "const SECRET_KEY = 'sk-live-real-key-12345'", dry_run: true })
    expect(result.content).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("SECRET_KEY")
    expect(result.dry_run).toBe(true)
  })

  test("nested objects and arrays of any shape are dropped, not partially included", () => {
    const result = whitelistAuditParams({ parameters: { app_type: "bun", port: 3000 }, tags: ["a", "b"], count: 2 })
    expect(result.parameters).toBeUndefined()
    expect(result.tags).toBeUndefined()
    expect(result.count).toBe(2)
  })

  test("a stable hash of the full params is always included, for correlation without disclosure", () => {
    const a = whitelistAuditParams({ argv: ["git", "status"] })
    const b = whitelistAuditParams({ argv: ["git", "status"] })
    const c = whitelistAuditParams({ argv: ["git", "diff"] })
    expect(a.paramsHash).toBe(b.paramsHash) // identical (undisclosed) params correlate
    expect(a.paramsHash).not.toBe(c.paramsHash) // different params don't collide
    expect(typeof a.paramsHash).toBe("string")
  })

  test("an empty params object still produces a valid, hash-only result", () => {
    const result = whitelistAuditParams({})
    expect(Object.keys(result)).toEqual(["paramsHash"])
  })
})

// ============================================================
// specs/108 — the batched third sink. Real store, real scratch
// directory (this codebase's own suites run in parallel — a shared
// default path would cross-contaminate, the same standing requirement
// every store.ts test file already states).
// ============================================================
describe("emitAuditEvent — the batched store sink", () => {
  let scratchDir: string
  let originalProjectPath: string | undefined
  let originalPersist: string | undefined
  let originalOrchestratorUrl: string | undefined

  beforeEach(() => {
    scratchDir = mkdtempSync(path.join(os.tmpdir(), "orchestrai-audit-test-"))
    originalProjectPath = process.env.ORCHESTRAI_PROJECT_PATH
    originalPersist = process.env.ORCHESTRAI_PERSIST
    originalOrchestratorUrl = process.env.ORCHESTRAI_ORCHESTRATOR_URL
    process.env.ORCHESTRAI_PROJECT_PATH = scratchDir
    delete process.env.ORCHESTRAI_PERSIST
    // pushToOrchestrator() fire-and-forgets a real fetch to this URL —
    // point it at a definitely-unbound loopback port so it fails fast
    // and silently, rather than genuinely reaching a real dev stack.
    process.env.ORCHESTRAI_ORCHESTRATOR_URL = "http://127.0.0.1:1"
    __resetAuditBufferForTests()
    __resetSharedStoreForTests()
  })
  afterEach(() => {
    __resetAuditBufferForTests()
    __resetSharedStoreForTests()
    if (originalProjectPath === undefined) delete process.env.ORCHESTRAI_PROJECT_PATH
    else process.env.ORCHESTRAI_PROJECT_PATH = originalProjectPath
    if (originalPersist === undefined) delete process.env.ORCHESTRAI_PERSIST
    else process.env.ORCHESTRAI_PERSIST = originalPersist
    if (originalOrchestratorUrl === undefined) delete process.env.ORCHESTRAI_ORCHESTRATOR_URL
    else process.env.ORCHESTRAI_ORCHESTRATOR_URL = originalOrchestratorUrl
    rmSync(scratchDir, { recursive: true, force: true })
  })

  // specs/113-live-audit-log-dashboard/spec.md — the real push body now
  // carries paramsWhitelisted/resultBytes/resultTruncated alongside the
  // pre-existing fields, computed once and reused for both this push
  // and the durable buffer write (asserted separately, above/below).
  test("the live push body carries the already-computed whitelisted params and result bounds", async () => {
    let capturedBody: Record<string, unknown> | null = null
    const originalFetch = globalThis.fetch
    // @ts-expect-error — test double, narrower than the real fetch signature
    globalThis.fetch = async (_url: string, init?: RequestInit) => {
      if (init?.body) capturedBody = JSON.parse(init.body as string)
      return new Response(null, { status: 204 })
    }
    try {
      emitAuditEvent({
        kind: "mcp-tool-call", caller: "devops-agent", target: "git_status", taskId: "t-push",
        params: { repo_path: "C:\\real\\path", retried: true }, outcome: "completed",
        durationMs: 10, resultBytes: 50, resultTruncated: false, callId: "call-push",
      })
      // pushToOrchestrator() is fire-and-forget — give its microtask a
      // real turn to run before asserting on the captured body.
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(capturedBody).not.toBeNull()
    expect(capturedBody!.resultBytes).toBe(50)
    expect(capturedBody!.resultTruncated).toBe(false)
    expect(capturedBody!.paramsWhitelisted).toEqual({ retried: true, paramsHash: expect.any(String) })
    // The real safety property, on this second channel too — never the
    // raw path.
    expect(JSON.stringify(capturedBody)).not.toContain("real\\path")
  })

  test("an emitted event is buffered, then flushed on shutdown, readable from the real store", () => {
    emitAuditEvent({
      kind: "mcp-tool-call", caller: "devops-agent", target: "git_status", taskId: "t-1",
      params: { repo_path: "C:\\real\\path", retried: false }, outcome: "completed",
      durationMs: 10, resultBytes: 50, resultTruncated: false, callId: "call-1",
    })
    flushAuditBufferForShutdown()

    const store = getSharedStore()
    expect(store).not.toBeNull()
    const rows = store!.listAuditEvents({ limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.target).toBe("git_status")
    expect(rows[0]?.outcome).toBe("completed")
    // The real safety property, checked end to end through the real
    // emitAuditEvent() call, not just the whitelist function directly.
    expect(rows[0]?.paramsJson).not.toContain("real\\path")
  })

  test("the size threshold flushes automatically, before an explicit shutdown call", () => {
    for (let i = 0; i < 25; i++) {
      emitAuditEvent({
        kind: "mcp-tool-call", caller: "devops-agent", target: "git_status", taskId: `t-${i}`,
        params: { retried: false }, outcome: "completed", durationMs: 1,
        resultBytes: 10, resultTruncated: false, callId: `call-${i}`,
      })
    }
    // 25 events with a size threshold of 20 means at least one automatic
    // flush already happened — confirmed directly against the real
    // store without calling flushAuditBufferForShutdown() at all.
    const store = getSharedStore()
    const rows = store!.listAuditEvents({ limit: 30 })
    expect(rows.length).toBeGreaterThanOrEqual(20)
    flushAuditBufferForShutdown() // drain the remainder so the next test starts clean
  })

  test("with ORCHESTRAI_PERSIST=0, emitAuditEvent never throws and buffers nothing durably", () => {
    process.env.ORCHESTRAI_PERSIST = "0"
    __resetSharedStoreForTests()
    expect(() => {
      emitAuditEvent({
        kind: "mcp-tool-call", caller: "devops-agent", target: "git_status", taskId: "t-1",
        params: { retried: false }, outcome: "completed", durationMs: 1,
        resultBytes: 10, resultTruncated: false, callId: "call-1",
      })
    }).not.toThrow()
    expect(() => flushAuditBufferForShutdown()).not.toThrow()
    expect(getSharedStore()).toBeNull()
  })
})
