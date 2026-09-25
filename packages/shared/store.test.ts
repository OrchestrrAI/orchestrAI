// specs/106-persistence-store-and-result-cache/spec.md
//
// Every test uses a unique temp file path or ":memory:" — this
// codebase's suites run in parallel, and a shared default path would
// cross-contaminate (this spec's own stated test-isolation requirement).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { Database } from "bun:sqlite"
import { openStore, type OrchestraiStore, type TaskRow, type ConversationWithTurnsRow, type AuditEventInsert } from "./store"

function pendingAction(overrides: Partial<{
  agent: string; taskId: string; actionId: string; kind: string; skill: string
  payloadJson: string; createdAt: number; expiresAt: number
}> = {}) {
  const now = Date.now()
  return {
    agent: "devops-agent", taskId: "t-1", actionId: "action-1", kind: "write", skill: "dockerize",
    payloadJson: JSON.stringify({ fingerprint: "abc" }), createdAt: now, expiresAt: now + 60_000,
    ...overrides,
  }
}

let scratchDir: string
beforeEach(() => {
  scratchDir = mkdtempSync(path.join(os.tmpdir(), "orchestrai-store-test-"))
})
afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true })
})

function realDbPath(): string {
  return path.join(scratchDir, "orchestrai.db")
}

// ============================================================
// openStore() — fail-open on every degradation path
// ============================================================
describe("openStore — fail-open, never throws", () => {
  test("ORCHESTRAI_PERSIST=0 disables the store unconditionally, even with a valid path", () => {
    const store = openStore({ ORCHESTRAI_PERSIST: "0", ORCHESTRAI_PROJECT_PATH: scratchDir } as NodeJS.ProcessEnv)
    expect(store).toBeNull()
  })

  test("no ORCHESTRAI_PROJECT_PATH configured → null", () => {
    const store = openStore({} as NodeJS.ProcessEnv)
    expect(store).toBeNull()
  })

  test("a real ORCHESTRAI_PROJECT_PATH opens a real store and creates the .orchestrai directory", () => {
    const store = openStore({ ORCHESTRAI_PROJECT_PATH: scratchDir } as NodeJS.ProcessEnv)
    expect(store).not.toBeNull()
    expect(existsSync(path.join(scratchDir, ".orchestrai", "orchestrai.db"))).toBe(true)
    store?.close()
  })

  test("a genuinely unopenable path degrades to null rather than throwing", () => {
    // A database path "inside" an existing regular file: creating its
    // folder fails on every OS (ENOTDIR/EEXIST). The previous null-byte
    // Windows path was just an odd relative filename on Linux, which
    // SQLite truncated at the NUL and opened fine — so CI failed.
    const dir = mkdtempSync(path.join(os.tmpdir(), "orchestrai-store-unopenable-"))
    try {
      const notADirectory = path.join(dir, "a-file")
      writeFileSync(notADirectory, "not a directory")
      expect(() => {
        const store = openStore({}, { dbPathOverride: path.join(notADirectory, "sub", "orchestrai.db") })
        expect(store).toBeNull()
      }).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(":memory: opens without requiring ORCHESTRAI_PROJECT_PATH at all — the test-only override", () => {
    const store = openStore({}, { dbPathOverride: ":memory:" })
    expect(store).not.toBeNull()
    store?.close()
  })

  test("migration is idempotent — opening the same real file twice in a row never throws", () => {
    const dbPath = realDbPath()
    const first = openStore({}, { dbPathOverride: dbPath })
    expect(first).not.toBeNull()
    first?.close()
    const second = openStore({}, { dbPathOverride: dbPath })
    expect(second).not.toBeNull()
    second?.close()
  })
})

// ============================================================
// result_cache — get/set, key normalization, TTL
// ============================================================
describe("result_cache — get/set and key normalization", () => {
  let store: OrchestraiStore
  beforeEach(() => {
    store = openStore({}, { dbPathOverride: ":memory:" })!
  })
  afterEach(() => store.close())

  test("a miss returns null", () => {
    const result = store.getCachedResult({ kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1 })
    expect(result).toBeNull()
  })

  test("a set is immediately readable by the same key", () => {
    store.setCachedResult({
      kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1,
      result: "the real result text", gitFingerprint: "fp-1", ttlMs: 60_000, producer: "devops-agent",
    })
    const result = store.getCachedResult({ kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1 })
    expect(result?.result).toBe("the real result text")
    expect(result?.gitFingerprint).toBe("fp-1")
  })

  // specs/106's own "the key is where this ships or silently fails" —
  // this is the decisive test for that property: a result computed by
  // one caller (e.g. DevOps, an absolute path) must be found by another
  // (e.g. the Orchestrator, the same real path resolved identically) as
  // long as both resolved to the SAME real path string — proven here by
  // confirming trivial casing/trailing-slash drift doesn't create a
  // second, missed key.
  // Windows paths are case-insensitive, so C:\Proj\ and c:\proj are one
  // folder there; on Linux/macOS they're two different folders.
  test.if(process.platform === "win32")("a trailing slash or path-casing difference on the same real path still hits (Windows normalization)", () => {
    store.setCachedResult({
      kind: "project-analysis", projectRoot: "C:\\Proj\\", targetRel: ".", inputHash: "h1", schemaVer: 1,
      result: "computed by one caller", gitFingerprint: null, ttlMs: 60_000, producer: "devops-agent",
    })
    const result = store.getCachedResult({ kind: "project-analysis", projectRoot: "c:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1 })
    expect(result?.result).toBe("computed by one caller")
  })

  test("a different kind never collides with another kind for the same project", () => {
    store.setCachedResult({
      kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1,
      result: "analysis result", gitFingerprint: null, ttlMs: 60_000, producer: "devops-agent",
    })
    const osvResult = store.getCachedResult({ kind: "osv-lookup", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1 })
    expect(osvResult).toBeNull()
  })

  test("a different schemaVer never serves a stale entry from an old prompt/model version", () => {
    store.setCachedResult({
      kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1,
      result: "old schema result", gitFingerprint: null, ttlMs: 60_000, producer: "devops-agent",
    })
    const result = store.getCachedResult({ kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 2 })
    expect(result).toBeNull()
  })

  test("an expired entry (ttlMs already elapsed) is treated as a miss", () => {
    store.setCachedResult({
      kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1,
      result: "should be expired", gitFingerprint: null, ttlMs: -1, producer: "devops-agent",
    })
    const result = store.getCachedResult({ kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1 })
    expect(result).toBeNull()
  })

  test("setCachedResult overwrites a previous entry for the same key rather than erroring", () => {
    store.setCachedResult({
      kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1,
      result: "first version", gitFingerprint: "fp-a", ttlMs: 60_000, producer: "devops-agent",
    })
    store.setCachedResult({
      kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1,
      result: "second version", gitFingerprint: "fp-b", ttlMs: 60_000, producer: "orchestrator",
    })
    const result = store.getCachedResult({ kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1 })
    expect(result?.result).toBe("second version")
    expect(result?.gitFingerprint).toBe("fp-b")
  })
})

// ============================================================
// Concurrent stampede — tryAcquireLease()
// ============================================================
describe("tryAcquireLease — the concurrent-stampede guard", () => {
  let store: OrchestraiStore
  beforeEach(() => {
    store = openStore({}, { dbPathOverride: ":memory:" })!
  })
  afterEach(() => store.close())

  const key = { kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1 }

  test("the first caller acquires the lease", () => {
    const acquired = store.tryAcquireLease({ ...key, leaseMs: 60_000 })
    expect(acquired).toBe(true)
  })

  test("a second caller while the lease is still active does NOT acquire it — this is the stampede fix", () => {
    store.tryAcquireLease({ ...key, leaseMs: 60_000 })
    const secondAcquired = store.tryAcquireLease({ ...key, leaseMs: 60_000 })
    expect(secondAcquired).toBe(false)
  })

  test("a caller CAN acquire once the previous lease has expired", () => {
    store.tryAcquireLease({ ...key, leaseMs: -1 }) // already expired
    const acquired = store.tryAcquireLease({ ...key, leaseMs: 60_000 })
    expect(acquired).toBe(true)
  })

  test("a caller cannot acquire a lease when a valid result already exists — no point recomputing", () => {
    store.setCachedResult({ ...key, result: "already computed", gitFingerprint: null, ttlMs: 60_000, producer: "devops-agent" })
    const acquired = store.tryAcquireLease({ ...key, leaseMs: 60_000 })
    expect(acquired).toBe(false)
  })

  test("a caller CAN acquire once a prior valid result has expired", () => {
    store.setCachedResult({ ...key, result: "stale", gitFingerprint: null, ttlMs: -1, producer: "devops-agent" })
    const acquired = store.tryAcquireLease({ ...key, leaseMs: 60_000 })
    expect(acquired).toBe(true)
  })

  test("acquiring a lease then setCachedResult() clears the lease and serves the real result", () => {
    store.tryAcquireLease({ ...key, leaseMs: 60_000 })
    store.setCachedResult({ ...key, result: "real result", gitFingerprint: null, ttlMs: 60_000, producer: "devops-agent" })
    const result = store.getCachedResult(key)
    expect(result?.result).toBe("real result")
    // The lease no longer blocks a hypothetical future re-acquisition
    // attempt after this result itself expires.
  })
})

// ============================================================
// pruneResultCache — retention
// ============================================================
describe("pruneResultCache — retention", () => {
  let store: OrchestraiStore
  beforeEach(() => {
    store = openStore({}, { dbPathOverride: ":memory:" })!
  })
  afterEach(() => store.close())

  test("removes expired completed entries", () => {
    store.setCachedResult({
      kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1,
      result: "expired", gitFingerprint: null, ttlMs: -1, producer: "devops-agent",
    })
    store.pruneResultCache(2000)
    const result = store.getCachedResult({ kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1 })
    expect(result).toBeNull()
  })

  test("removes a stale lease past its own lease_until without ever having produced a result", () => {
    store.tryAcquireLease({ kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1, leaseMs: -1 })
    store.pruneResultCache(2000)
    // The stale lease being gone is proven indirectly: a fresh
    // tryAcquireLease() for the identical key must succeed again, which
    // it would not if the old (expired) lease row still existed and
    // were somehow still treated as active.
    const acquired = store.tryAcquireLease({ kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1, leaseMs: 60_000 })
    expect(acquired).toBe(true)
  })

  test("caps completed entries at maxRows, keeping the most recently computed", () => {
    for (let i = 0; i < 5; i++) {
      store.setCachedResult({
        kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: `h${i}`, schemaVer: 1,
        result: `result ${i}`, gitFingerprint: null, ttlMs: 60_000, producer: "devops-agent",
      })
    }
    store.pruneResultCache(2)
    let survivingCount = 0
    for (let i = 0; i < 5; i++) {
      if (store.getCachedResult({ kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: `h${i}`, schemaVer: 1 })) survivingCount++
    }
    expect(survivingCount).toBe(2)
  })

  test("a valid, non-expired entry is untouched", () => {
    store.setCachedResult({
      kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1,
      result: "still valid", gitFingerprint: null, ttlMs: 60_000, producer: "devops-agent",
    })
    store.pruneResultCache(2000)
    const result = store.getCachedResult({ kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1 })
    expect(result?.result).toBe("still valid")
  })
})

// ============================================================
// Cross-process reuse — the actual claim this spec exists to prove
// ============================================================
describe("cross-\"process\" reuse — two independent store handles on the same real file", () => {
  test("a result written by one store handle is read by a second, independently-opened handle on the same file", () => {
    const dbPath = realDbPath()
    const writer = openStore({}, { dbPathOverride: dbPath })!
    writer.setCachedResult({
      kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1,
      result: "written by the first handle", gitFingerprint: "fp-1", ttlMs: 60_000, producer: "devops-agent",
    })
    writer.close()

    // A genuinely separate Database instance on the same real file —
    // the closest thing to "a different process" this test can express
    // without actually spawning one.
    const reader = openStore({}, { dbPathOverride: dbPath })!
    const result = reader.getCachedResult({ kind: "project-analysis", projectRoot: "C:\\proj", targetRel: ".", inputHash: "h1", schemaVer: 1 })
    expect(result?.result).toBe("written by the first handle")
    reader.close()
  })
})

// ============================================================
// specs/107-task-and-conversation-history/spec.md — tasks
// ============================================================
describe("tasks — upsert/read, redaction, listing", () => {
  let store: OrchestraiStore
  beforeEach(() => {
    store = openStore({}, { dbPathOverride: ":memory:" })!
  })
  afterEach(() => store.close())

  test("a written task is readable back with every field intact", () => {
    store.upsertTask({
      taskId: "t-1", agent: "devops-agent", skill: "git-status", status: "completed",
      paramsJson: JSON.stringify({ repo_path: "C:\\proj" }), result: "clean tree",
      resultTruncated: false, conversationId: "conv-1", createdAt: 1000, updatedAt: 1000,
    })
    const row = store.getTask("t-1") as TaskRow
    expect(row.taskId).toBe("t-1")
    expect(row.agent).toBe("devops-agent")
    expect(row.skill).toBe("git-status")
    expect(row.status).toBe("completed")
    expect(row.result).toBe("clean tree")
    expect(row.redacted).toBe(0)
    expect(row.conversationId).toBe("conv-1")
  })

  test("re-upserting the same task id updates in place, not a second row", () => {
    store.upsertTask({
      taskId: "t-1", agent: "devops-agent", skill: "git-status", status: "working",
      paramsJson: null, result: null, resultTruncated: false, conversationId: null,
      createdAt: 1000, updatedAt: 1000,
    })
    store.upsertTask({
      taskId: "t-1", agent: "devops-agent", skill: "git-status", status: "completed",
      paramsJson: null, result: "done", resultTruncated: false, conversationId: null,
      createdAt: 1000, updatedAt: 2000,
    })
    expect(store.getTask("t-1")?.status).toBe("completed")
    expect(store.listRecentTasks(10)).toHaveLength(1)
  })

  test("a scan-secrets task is stored with result = NULL and redacted = 1, structurally, regardless of what the caller passes", () => {
    store.upsertTask({
      taskId: "t-secrets", agent: "security-agent", skill: "scan-secrets", status: "completed",
      paramsJson: null,
      result: "found a real leaked key at src/config.ts:12 — sk-live-abc123",
      resultTruncated: false, conversationId: null, createdAt: 1000, updatedAt: 1000,
    })
    const row = store.getTask("t-secrets") as TaskRow
    expect(row.result).toBeNull()
    expect(row.redacted).toBe(1)
    // The record itself (when it ran, its status) is still kept.
    expect(row.status).toBe("completed")
    expect(row.skill).toBe("scan-secrets")
  })

  test("every other skill's result is stored in full, unredacted", () => {
    store.upsertTask({
      taskId: "t-other", agent: "documentation-agent", skill: "generate-readme", status: "completed",
      paramsJson: null, result: "# My Project\n\nfull content here",
      resultTruncated: false, conversationId: null, createdAt: 1000, updatedAt: 1000,
    })
    const row = store.getTask("t-other") as TaskRow
    expect(row.result).toBe("# My Project\n\nfull content here")
    expect(row.redacted).toBe(0)
  })

  test("listRecentTasks returns newest first, optionally filtered by status", () => {
    store.upsertTask({ taskId: "t-1", agent: null, skill: "git-status", status: "completed", paramsJson: null, result: "a", resultTruncated: false, conversationId: null, createdAt: 1000, updatedAt: 1000 })
    store.upsertTask({ taskId: "t-2", agent: null, skill: "git-status", status: "failed", paramsJson: null, result: null, resultTruncated: false, conversationId: null, createdAt: 2000, updatedAt: 2000 })
    store.upsertTask({ taskId: "t-3", agent: null, skill: "git-status", status: "completed", paramsJson: null, result: "c", resultTruncated: false, conversationId: null, createdAt: 3000, updatedAt: 3000 })
    const all = store.listRecentTasks(10)
    expect(all.map((t) => t.taskId)).toEqual(["t-3", "t-2", "t-1"])
    const failedOnly = store.listRecentTasks(10, "failed")
    expect(failedOnly.map((t) => t.taskId)).toEqual(["t-2"])
  })

  test("a task recorded with no Orchestrator involvement (direct agent dispatch) is still readable", () => {
    // Simulates an agent writing its own row directly — no conversationId,
    // no Orchestrator-assigned agent field beyond the agent's own name.
    store.upsertTask({
      taskId: "t-direct", agent: "devops-agent", skill: "dockerize", status: "completed",
      paramsJson: JSON.stringify({ app_type: "bun" }), result: "Dockerfile written",
      resultTruncated: false, conversationId: null, createdAt: 1000, updatedAt: 1000,
    })
    const row = store.getTask("t-direct")
    expect(row?.taskId).toBe("t-direct")
    expect(row?.conversationId).toBeNull()
  })
})

describe("pruneTasks — retention", () => {
  let store: OrchestraiStore
  beforeEach(() => {
    store = openStore({}, { dbPathOverride: ":memory:" })!
  })
  afterEach(() => store.close())

  test("a task older than the max age is deleted", () => {
    const now = Date.now()
    store.upsertTask({ taskId: "old", agent: null, skill: "git-status", status: "completed", paramsJson: null, result: "x", resultTruncated: false, conversationId: null, createdAt: now - 40 * 24 * 60 * 60 * 1000, updatedAt: now })
    store.upsertTask({ taskId: "new", agent: null, skill: "git-status", status: "completed", paramsJson: null, result: "y", resultTruncated: false, conversationId: null, createdAt: now, updatedAt: now })
    store.pruneTasks(30 * 24 * 60 * 60 * 1000, 10_000)
    expect(store.getTask("old")).toBeNull()
    expect(store.getTask("new")).not.toBeNull()
  })

  test("the row count cap keeps only the newest N", () => {
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      store.upsertTask({ taskId: `t-${i}`, agent: null, skill: "git-status", status: "completed", paramsJson: null, result: `r${i}`, resultTruncated: false, conversationId: null, createdAt: now + i, updatedAt: now + i })
    }
    store.pruneTasks(365 * 24 * 60 * 60 * 1000, 3)
    const remaining = store.listRecentTasks(20)
    expect(remaining).toHaveLength(3)
    expect(remaining.map((t) => t.taskId)).toEqual(["t-9", "t-8", "t-7"])
  })
})

// ============================================================
// specs/107-task-and-conversation-history/spec.md — conversations/turns
// ============================================================
describe("conversations and turns — write, cascade, ordering", () => {
  let store: OrchestraiStore
  beforeEach(() => {
    store = openStore({}, { dbPathOverride: ":memory:" })!
  })
  afterEach(() => store.close())

  test("a conversation with several turns loads back in seq order", () => {
    store.upsertConversation({ id: "conv-1", title: null, createdAt: 1000, updatedAt: 3000 })
    store.appendTurnRow({ conversationId: "conv-1", seq: 0, role: "user", content: "hello", createdAt: 1000 })
    store.appendTurnRow({ conversationId: "conv-1", seq: 1, role: "assistant", content: "hi there", createdAt: 2000 })
    store.appendTurnRow({ conversationId: "conv-1", seq: 2, role: "user", content: "how are you", createdAt: 3000 })

    const loaded = store.listRecentConversationsWithTurns(10)
    expect(loaded).toHaveLength(1)
    const conv = loaded[0] as ConversationWithTurnsRow
    expect(conv.id).toBe("conv-1")
    expect(conv.turns.map((t) => t.content)).toEqual(["hello", "hi there", "how are you"])
  })

  test("listRecentConversationsWithTurns returns newest-active first", () => {
    store.upsertConversation({ id: "conv-old", title: null, createdAt: 1000, updatedAt: 1000 })
    store.upsertConversation({ id: "conv-new", title: null, createdAt: 2000, updatedAt: 5000 })
    const loaded = store.listRecentConversationsWithTurns(10)
    expect(loaded.map((c) => c.id)).toEqual(["conv-new", "conv-old"])
  })

  test("deleting a conversation cascades to its own turns (ON DELETE CASCADE, foreign_keys=ON)", () => {
    const dbPath = realDbPath()
    const s = openStore({}, { dbPathOverride: dbPath })!
    s.upsertConversation({ id: "conv-1", title: null, createdAt: 1000, updatedAt: 1000 })
    s.appendTurnRow({ conversationId: "conv-1", seq: 0, role: "user", content: "hello", createdAt: 1000 })
    s.upsertConversation({ id: "conv-2", title: null, createdAt: 500, updatedAt: 500 })
    s.appendTurnRow({ conversationId: "conv-2", seq: 0, role: "user", content: "this turn should be cascade-deleted", createdAt: 500 })
    // pruneConversations with maxConversations=1 drops the older conv-2,
    // keeping conv-1 — its own turn must survive, conv-2's must not orphan.
    s.pruneConversations(1, 500)
    const remaining = s.listRecentConversationsWithTurns(10)
    expect(remaining.map((c) => c.id)).toEqual(["conv-1"])
    expect(remaining[0]?.turns).toHaveLength(1)
    s.close()

    // Verify the CASCADE genuinely fired — not just that no query happens
    // to surface the orphan — by inspecting the real file directly.
    const raw = new Database(dbPath, { readonly: true })
    const conversationCount = (raw.query("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n
    const turnCount = (raw.query("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n
    expect(conversationCount).toBe(1)
    expect(turnCount).toBe(1) // conv-2's own turn is genuinely gone, not orphaned
    raw.close()
  })

  test("re-appending the same (conversationId, seq) updates in place, never duplicates", () => {
    store.upsertConversation({ id: "conv-1", title: null, createdAt: 1000, updatedAt: 1000 })
    store.appendTurnRow({ conversationId: "conv-1", seq: 0, role: "user", content: "first draft", createdAt: 1000 })
    store.appendTurnRow({ conversationId: "conv-1", seq: 0, role: "user", content: "corrected", createdAt: 1001 })
    const loaded = store.listRecentConversationsWithTurns(10)
    expect(loaded[0]?.turns).toHaveLength(1)
    expect(loaded[0]?.turns[0]?.content).toBe("corrected")
  })
})

describe("pruneConversations — retention", () => {
  let store: OrchestraiStore
  beforeEach(() => {
    store = openStore({}, { dbPathOverride: ":memory:" })!
  })
  afterEach(() => store.close())

  test("the conversation-count cap keeps only the most recently active N", () => {
    for (let i = 0; i < 5; i++) {
      store.upsertConversation({ id: `conv-${i}`, title: null, createdAt: i, updatedAt: i })
    }
    store.pruneConversations(2, 500)
    const remaining = store.listRecentConversationsWithTurns(10)
    expect(remaining.map((c) => c.id)).toEqual(["conv-4", "conv-3"])
  })

  test("the per-conversation turn cap trims the oldest turns, keeping the most recent", () => {
    store.upsertConversation({ id: "conv-1", title: null, createdAt: 1000, updatedAt: 1000 })
    for (let i = 0; i < 10; i++) {
      store.appendTurnRow({ conversationId: "conv-1", seq: i, role: "user", content: `turn ${i}`, createdAt: i })
    }
    store.pruneConversations(200, 3)
    const loaded = store.listRecentConversationsWithTurns(10)
    expect(loaded[0]?.turns.map((t) => t.content)).toEqual(["turn 7", "turn 8", "turn 9"])
  })
})

// ============================================================
// specs/108-durable-audit-trail/spec.md — audit_events
// ============================================================
function auditEvent(overrides: Partial<AuditEventInsert> = {}): AuditEventInsert {
  return {
    ts: Date.now(), kind: "mcp-tool-call", caller: "devops-agent", target: "git_status",
    taskId: "t-1", callId: "call-1", outcome: "completed", durationMs: 42,
    resultBytes: 128, resultTruncated: false, paramsJson: JSON.stringify({ retried: false }),
    ...overrides,
  }
}

describe("audit_events — batched insert, listing, pruning", () => {
  let store: OrchestraiStore
  beforeEach(() => {
    store = openStore({}, { dbPathOverride: ":memory:" })!
  })
  afterEach(() => store.close())

  test("insertAuditEvents writes a real batch in one transaction, readable back", () => {
    store.insertAuditEvents([
      auditEvent({ taskId: "t-1", target: "git_status" }),
      auditEvent({ taskId: "t-1", target: "analyze_project" }),
      auditEvent({ taskId: "t-2", target: "read_project_file" }),
    ])
    const all = store.listAuditEvents({ limit: 10 })
    expect(all).toHaveLength(3)
  })

  test("insertAuditEvents with an empty array is a safe no-op", () => {
    expect(() => store.insertAuditEvents([])).not.toThrow()
    expect(store.listAuditEvents({ limit: 10 })).toHaveLength(0)
  })

  test("listAuditEvents filters by taskId and returns newest first", () => {
    store.insertAuditEvents([
      auditEvent({ taskId: "t-1", target: "git_status", ts: 1000 }),
      auditEvent({ taskId: "t-2", target: "analyze_project", ts: 2000 }),
      auditEvent({ taskId: "t-1", target: "read_project_file", ts: 3000 }),
    ])
    const forT1 = store.listAuditEvents({ taskId: "t-1", limit: 10 })
    expect(forT1.map((e) => e.target)).toEqual(["read_project_file", "git_status"])
  })

  // specs/136 — a task's own id plus the orch-<id> its agent records under.
  test("listAuditEvents with taskIds matches any of them, newest first, and nothing else", () => {
    store.insertAuditEvents([
      auditEvent({ taskId: "task-9", target: "a2a", ts: 1000 }),
      auditEvent({ taskId: "orch-task-9", target: "git_status", ts: 2000 }),
      auditEvent({ taskId: "task-10", target: "other", ts: 3000 }),
    ])
    const rows = store.listAuditEvents({ taskIds: ["task-9", "orch-task-9"], limit: 10 })
    expect(rows.map((e) => e.target)).toEqual(["git_status", "a2a"])
    expect(store.listAuditEvents({ taskIds: ["orch-task-9"], limit: 10 }).map((e) => e.target)).toEqual(["git_status"])
    expect(store.listAuditEvents({ taskIds: [], limit: 10 })).toHaveLength(3)
  })

  test("a row's params_json round-trips exactly what was written", () => {
    store.insertAuditEvents([auditEvent({ paramsJson: JSON.stringify({ retried: true, paramsHash: "abc123" }) })])
    const row = store.listAuditEvents({ limit: 1 })[0]
    expect(JSON.parse(row!.paramsJson!)).toEqual({ retried: true, paramsHash: "abc123" })
  })
})

describe("pruneAuditEvents — retention", () => {
  let store: OrchestraiStore
  beforeEach(() => {
    store = openStore({}, { dbPathOverride: ":memory:" })!
  })
  afterEach(() => store.close())

  test("an event older than the max age is deleted", () => {
    const now = Date.now()
    store.insertAuditEvents([
      auditEvent({ callId: "old", ts: now - 8 * 24 * 60 * 60 * 1000 }),
      auditEvent({ callId: "new", ts: now }),
    ])
    store.pruneAuditEvents(7 * 24 * 60 * 60 * 1000, 50_000)
    const remaining = store.listAuditEvents({ limit: 10 })
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.callId).toBe("new")
  })

  test("the row count cap keeps only the newest N", () => {
    const now = Date.now()
    const events: AuditEventInsert[] = []
    for (let i = 0; i < 10; i++) events.push(auditEvent({ callId: `c-${i}`, ts: now + i }))
    store.insertAuditEvents(events)
    store.pruneAuditEvents(365 * 24 * 60 * 60 * 1000, 3)
    const remaining = store.listAuditEvents({ limit: 20 })
    expect(remaining).toHaveLength(3)
    expect(remaining.map((e) => e.callId)).toEqual(["c-9", "c-8", "c-7"])
  })
})

// ============================================================
// specs/110-approval-state-survives-a-restart/spec.md — pending_actions
// ============================================================
describe("pending_actions — upsert, atomic claim, restore, prune", () => {
  let store: OrchestraiStore
  beforeEach(() => {
    store = openStore({}, { dbPathOverride: ":memory:" })!
  })
  afterEach(() => store.close())

  test("an upserted action is returned by listUnexpiredPendingActions", () => {
    store.upsertPendingAction(pendingAction())
    const rows = store.listUnexpiredPendingActions({ agent: "devops-agent", now: Date.now() })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.taskId).toBe("t-1")
    expect(rows[0]?.actionId).toBe("action-1")
    expect(rows[0]?.status).toBe("pending")
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({ fingerprint: "abc" })
  })

  test("re-upserting the same (agent, taskId) replaces the row, not a second one", () => {
    store.upsertPendingAction(pendingAction({ actionId: "action-1" }))
    store.upsertPendingAction(pendingAction({ actionId: "action-2" }))
    const rows = store.listUnexpiredPendingActions({ agent: "devops-agent", now: Date.now() })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actionId).toBe("action-2")
  })

  test("rows are scoped per agent — one agent never sees another's", () => {
    store.upsertPendingAction(pendingAction({ agent: "devops-agent", taskId: "t-1", actionId: "action-1" }))
    store.upsertPendingAction(pendingAction({ agent: "testing-agent", taskId: "t-1", actionId: "action-2" }))
    expect(store.listUnexpiredPendingActions({ agent: "devops-agent", now: Date.now() })).toHaveLength(1)
    expect(store.listUnexpiredPendingActions({ agent: "testing-agent", now: Date.now() })).toHaveLength(1)
    expect(store.listUnexpiredPendingActions({ agent: "coder-agent", now: Date.now() })).toHaveLength(0)
  })

  test("claimPendingAction transitions a pending row and returns true exactly once", () => {
    store.upsertPendingAction(pendingAction())
    expect(store.claimPendingAction({ agent: "devops-agent", taskId: "t-1" })).toBe(true)
    // The real single-consumption boundary: a second claim on the same
    // row fails — this is what makes two concurrent approve requests
    // against the same action impossible to both succeed.
    expect(store.claimPendingAction({ agent: "devops-agent", taskId: "t-1" })).toBe(false)
  })

  test("a claimed row is never returned by listUnexpiredPendingActions, regardless of expiry", () => {
    store.upsertPendingAction(pendingAction())
    store.claimPendingAction({ agent: "devops-agent", taskId: "t-1" })
    // Simulates a crash between claim and completion — the row is stuck
    // at 'claimed' forever unless pruned. It must never be treated as a
    // valid restorable action.
    const rows = store.listUnexpiredPendingActions({ agent: "devops-agent", now: Date.now() })
    expect(rows).toHaveLength(0)
  })

  test("claimPendingAction on an already-deleted row returns false", () => {
    expect(store.claimPendingAction({ agent: "devops-agent", taskId: "t-nonexistent" })).toBe(false)
  })

  test("deletePendingAction removes the row (the ordinary completion/reject path)", () => {
    store.upsertPendingAction(pendingAction())
    store.deletePendingAction({ agent: "devops-agent", taskId: "t-1" })
    expect(store.listUnexpiredPendingActions({ agent: "devops-agent", now: Date.now() })).toHaveLength(0)
  })

  test("an expired pending row is not returned as unexpired", () => {
    const now = Date.now()
    store.upsertPendingAction(pendingAction({ createdAt: now - 120_000, expiresAt: now - 60_000 }))
    expect(store.listUnexpiredPendingActions({ agent: "devops-agent", now })).toHaveLength(0)
  })

  test("pruneExpiredPendingActions deletes expired pending rows and ALL claimed rows", () => {
    const now = Date.now()
    store.upsertPendingAction(pendingAction({ taskId: "t-expired", actionId: "action-expired", createdAt: now - 120_000, expiresAt: now - 60_000 }))
    store.upsertPendingAction(pendingAction({ taskId: "t-fresh", actionId: "action-fresh", expiresAt: now + 60_000 }))
    store.upsertPendingAction(pendingAction({ taskId: "t-claimed", actionId: "action-claimed", expiresAt: now + 60_000 }))
    store.claimPendingAction({ agent: "devops-agent", taskId: "t-claimed" })

    store.pruneExpiredPendingActions(now)

    const rows = store.listUnexpiredPendingActions({ agent: "devops-agent", now })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.taskId).toBe("t-fresh")
  })
})
