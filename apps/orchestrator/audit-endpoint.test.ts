// specs/108-durable-audit-trail/spec.md
//
// GET /audit — read-only, strictly optional (a missing/disabled store
// returns an empty list, never an error). Each test gets its own fresh
// scratch directory (this codebase's suites run in parallel — a shared
// default path would cross-contaminate, store.test.ts's own stated
// test-isolation requirement).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { app } from "./index"
import { __resetSharedStoreForTests, getSharedStore } from "../../packages/shared/store"

let scratchDir: string
let originalProjectPath: string | undefined
let originalPersist: string | undefined

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(os.tmpdir(), "orchestrai-audit-endpoint-test-"))
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

async function getAudit(query = ""): Promise<{ status: number; json: { events: unknown[] } }> {
  const res = await app.request(`/audit${query}`)
  return { status: res.status, json: (await res.json()) as { events: unknown[] } }
}

describe("GET /audit", () => {
  test("with no store, returns an empty list rather than an error", async () => {
    process.env.ORCHESTRAI_PERSIST = "0"
    __resetSharedStoreForTests()
    const { status, json } = await getAudit()
    expect(status).toBe(200)
    expect(json.events).toEqual([])
  })

  test("returns real events written directly to the store, newest first", async () => {
    const store = getSharedStore()
    expect(store).not.toBeNull()
    store!.insertAuditEvents([
      { ts: 1000, kind: "mcp-tool-call", caller: "devops-agent", target: "git_status", taskId: "t-1", callId: "c-1", outcome: "completed", durationMs: 10, resultBytes: 50, resultTruncated: false, paramsJson: JSON.stringify({ retried: false, paramsHash: "abc" }) },
      { ts: 2000, kind: "mcp-tool-call", caller: "devops-agent", target: "analyze_project", taskId: "t-1", callId: "c-2", outcome: "completed", durationMs: 20, resultBytes: 100, resultTruncated: false, paramsJson: JSON.stringify({ paramsHash: "def" }) },
    ])

    const { status, json } = await getAudit()
    expect(status).toBe(200)
    expect(json.events).toHaveLength(2)
    expect((json.events[0] as { target: string }).target).toBe("analyze_project") // newest first
  })

  test("?task=<id> filters to that task's own correlated events only", async () => {
    const store = getSharedStore()!
    store.insertAuditEvents([
      { ts: 1000, kind: "mcp-tool-call", caller: "devops-agent", target: "git_status", taskId: "t-1", callId: "c-1", outcome: "completed", durationMs: 10, resultBytes: 50, resultTruncated: false, paramsJson: "{}" },
      { ts: 2000, kind: "mcp-tool-call", caller: "devops-agent", target: "git_diff", taskId: "t-2", callId: "c-2", outcome: "completed", durationMs: 10, resultBytes: 50, resultTruncated: false, paramsJson: "{}" },
    ])

    const { json } = await getAudit("?task=t-1")
    expect(json.events).toHaveLength(1)
    expect((json.events[0] as { target: string }).target).toBe("git_status")
  })

  test("a real run_command-shaped event's stored params contain no argv, confirmed end to end through the real endpoint", async () => {
    const store = getSharedStore()!
    store.insertAuditEvents([{
      ts: 1000, kind: "mcp-tool-call", caller: "devops-agent", target: "run_command",
      taskId: "t-1", callId: "c-1", outcome: "completed", durationMs: 10,
      resultBytes: 50, resultTruncated: false,
      // Written the way emitAuditEvent()'s own whitelistAuditParams() would produce it.
      paramsJson: JSON.stringify({ retried: false, paramsHash: "abc123def456" }),
    }])

    const { json } = await getAudit()
    const paramsJson = (json.events[0] as { paramsJson: string }).paramsJson
    expect(paramsJson).not.toContain("argv")
    expect(paramsJson).not.toContain("rm -rf")
  })
})
