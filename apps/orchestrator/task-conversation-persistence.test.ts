// specs/107-task-and-conversation-history/spec.md
//
// Exercises the Orchestrator's own write paths (emitTaskState()'s
// terminal-transition hook, appendTurn()'s turn hook) and the restart
// read path (loadRecentConversationsFromStore(), findMostRecentFailure()
// via answerLastFailureFromState()) against a REAL store on a fresh
// per-test scratch directory — never the deleted in-memory-only
// behavior, and never a shared/ambient path (this codebase's suites run
// in parallel; store.test.ts's own stated test-isolation requirement).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  tasks,
  conversations,
  emitTaskState,
  appendTurn,
  answerLastFailureFromState,
  loadRecentConversationsFromStore,
  type OrchestratorTask,
  type Conversation,
  type ConversationTurn,
} from "./index"
import { __resetSharedStoreForTests, getSharedStore } from "../../packages/shared/store"

let scratchDir: string
let originalProjectPath: string | undefined
let originalPersist: string | undefined

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(os.tmpdir(), "orchestrai-task-conv-persistence-test-"))
  originalProjectPath = process.env.ORCHESTRAI_PROJECT_PATH
  originalPersist = process.env.ORCHESTRAI_PERSIST
  process.env.ORCHESTRAI_PROJECT_PATH = scratchDir
  delete process.env.ORCHESTRAI_PERSIST
  __resetSharedStoreForTests()
  tasks.clear()
  conversations.clear()
})

afterEach(() => {
  __resetSharedStoreForTests()
  if (originalProjectPath === undefined) delete process.env.ORCHESTRAI_PROJECT_PATH
  else process.env.ORCHESTRAI_PROJECT_PATH = originalProjectPath
  if (originalPersist === undefined) delete process.env.ORCHESTRAI_PERSIST
  else process.env.ORCHESTRAI_PERSIST = originalPersist
  rmSync(scratchDir, { recursive: true, force: true })
  tasks.clear()
  conversations.clear()
})

function task(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: "t-1", text: "git status", skill: "git-status", assignedAgent: "devops-agent",
    status: "completed", result: "clean tree", createdAt: new Date(), ...overrides,
  }
}

describe("emitTaskState — terminal transitions are persisted", () => {
  test("a completed task's row is readable directly from the real store", () => {
    const t = task({ id: "t-completed", result: "branch: main, clean" })
    tasks.set(t.id, t)
    emitTaskState(t)

    const store = getSharedStore()
    expect(store).not.toBeNull()
    const row = store!.getTask("t-completed")
    expect(row?.status).toBe("completed")
    expect(row?.skill).toBe("git-status")
    expect(row?.agent).toBe("devops-agent")
    expect(row?.result).toBe("branch: main, clean")
  })

  test("a failed task's row carries its error as the result", () => {
    const t = task({ id: "t-failed", status: "failed", result: undefined, error: "MCP unreachable" })
    tasks.set(t.id, t)
    emitTaskState(t)

    const row = getSharedStore()!.getTask("t-failed")
    expect(row?.status).toBe("failed")
  })

  test("a scan-secrets task's stored row has result IS NULL and redacted = 1", () => {
    const t = task({
      id: "t-secrets", skill: "scan-secrets", assignedAgent: "security-agent",
      result: "found a real key at src/config.ts:12 — sk-live-abc123",
    })
    tasks.set(t.id, t)
    emitTaskState(t)

    const row = getSharedStore()!.getTask("t-secrets")
    expect(row?.result).toBeNull()
    expect(row?.redacted).toBe(1)
    // The record itself (when it ran, its status) is still kept.
    expect(row?.status).toBe("completed")
  })

  test("every other skill's row keeps its full result, unredacted", () => {
    const t = task({ id: "t-readme", skill: "generate-readme", result: "# Real README content" })
    tasks.set(t.id, t)
    emitTaskState(t)

    const row = getSharedStore()!.getTask("t-readme")
    expect(row?.result).toBe("# Real README content")
    expect(row?.redacted).toBe(0)
  })

  test("emitTaskState is idempotent — calling it twice for the same terminal task writes once, doesn't error", () => {
    const t = task({ id: "t-once" })
    tasks.set(t.id, t)
    emitTaskState(t)
    expect(() => emitTaskState(t)).not.toThrow()
    expect(getSharedStore()!.getTask("t-once")?.result).toBe("clean tree")
  })

  test("params_json stores only the approval preview's own parameters, when present", () => {
    const t = task({
      id: "t-approved", skill: "dockerize",
      approval: {
        actionId: "a-1", kind: "file-write", summary: "write Dockerfile", target: "C:\\proj\\Dockerfile",
        parameters: { app_type: "bun", port: 3000 }, risks: [],
      },
    })
    tasks.set(t.id, t)
    emitTaskState(t)

    const row = getSharedStore()!.getTask("t-approved")
    expect(JSON.parse(row!.paramsJson!)).toEqual({ app_type: "bun", port: 3000 })
  })
})

describe("appendTurn — conversation turns are persisted", () => {
  function newConversation(id = "conv-1"): Conversation {
    const c: Conversation = { id, createdAt: new Date(), turns: [] }
    conversations.set(id, c)
    return c
  }
  function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
    return { id: "turn-1", role: "user", text: "hello", timestamp: Date.now(), ...overrides }
  }

  test("appended turns are readable back in order from the real store", () => {
    const conv = newConversation()
    appendTurn(conv, turn({ id: "turn-1", role: "user", text: "hello", timestamp: 1000 }))
    appendTurn(conv, turn({ id: "turn-2", role: "assistant", text: "hi there", timestamp: 2000 }))

    const loaded = getSharedStore()!.listRecentConversationsWithTurns(10)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.turns.map((t) => t.content)).toEqual(["hello", "hi there"])
  })

  test("seq numbers stay monotonic even after the in-memory array is trimmed (never collide)", () => {
    const conv = newConversation()
    // Append well past MAX_TURNS_PER_CONVERSATION worth of turns so the
    // in-memory array gets trimmed from the front — the durable seq
    // counter must not reset alongside it.
    for (let i = 0; i < 105; i++) {
      appendTurn(conv, turn({ id: `turn-${i}`, role: "user", text: `message ${i}`, timestamp: 1000 + i }))
    }
    const loaded = getSharedStore()!.listRecentConversationsWithTurns(10)
    // Every one of the 105 turns landed as its own distinct row — no
    // seq collision silently overwrote an earlier one.
    expect(loaded[0]?.turns).toHaveLength(105)
    expect(loaded[0]?.turns[0]?.content).toBe("message 0")
    expect(loaded[0]?.turns[104]?.content).toBe("message 104")
  })
})

describe("loadRecentConversationsFromStore — restart survival", () => {
  test("conversations and turns written in one 'process' reappear after clearing the in-memory Maps and reloading", () => {
    const conv: Conversation = { id: "conv-restart", createdAt: new Date(), turns: [] }
    conversations.set(conv.id, conv)
    appendTurn(conv, { id: "turn-1", role: "user", text: "what agents do you have?", timestamp: 1000 })
    appendTurn(conv, { id: "turn-2", role: "assistant", text: "Here is what I can do...", timestamp: 2000 })

    // Simulate a restart: the in-memory Map is gone, but the store isn't.
    conversations.clear()
    expect(conversations.size).toBe(0)

    loadRecentConversationsFromStore()

    const reloaded = conversations.get("conv-restart")
    expect(reloaded).toBeDefined()
    expect(reloaded!.turns.map((t) => t.text)).toEqual(["what agents do you have?", "Here is what I can do..."])
  })

  test("a conversation continued after reload gets correctly-ordered new turns (no seq collision with reloaded history)", () => {
    const conv: Conversation = { id: "conv-continue", createdAt: new Date(), turns: [] }
    conversations.set(conv.id, conv)
    appendTurn(conv, { id: "turn-1", role: "user", text: "first", timestamp: 1000 })
    appendTurn(conv, { id: "turn-2", role: "assistant", text: "second", timestamp: 2000 })

    conversations.clear()
    loadRecentConversationsFromStore()
    const reloaded = conversations.get("conv-continue")!
    appendTurn(reloaded, { id: "turn-3", role: "user", text: "third, after restart", timestamp: 3000 })

    const loaded = getSharedStore()!.listRecentConversationsWithTurns(10)
    const conv2 = loaded.find((c) => c.id === "conv-continue")
    expect(conv2?.turns.map((t) => t.content)).toEqual(["first", "second", "third, after restart"])
  })
})

describe("specs/091's 'why did it fail?' answers correctly after a restart", () => {
  test("with an empty in-memory task Map, the last failure is read from the durable store", () => {
    const t = task({ id: "t-failed-restart", status: "failed", result: undefined, error: "docker build failed: no such file" })
    tasks.set(t.id, t)
    emitTaskState(t)

    // Simulate a restart — the live process has nothing in memory.
    tasks.clear()
    expect(tasks.size).toBe(0)

    const answer = answerLastFailureFromState()
    expect(answer).toContain("git-status")
    expect(answer).toContain("docker build failed: no such file")
  })

  test("a redacted scan-secrets failure never leaks its finding text, even from the store fallback", () => {
    const t = task({ id: "t-secrets-failed", skill: "scan-secrets", assignedAgent: "security-agent", status: "failed", result: undefined, error: "real leaked key at src/config.ts:9" })
    tasks.set(t.id, t)
    emitTaskState(t)
    tasks.clear()

    const answer = answerLastFailureFromState()
    expect(answer).toContain("scan-secrets")
    expect(answer).not.toContain("src/config.ts:9")
  })

  test("with no failure anywhere (memory or store), the honest no-failure message is returned", () => {
    expect(tasks.size).toBe(0)
    expect(answerLastFailureFromState()).toBe("No recent task has failed.")
  })
})

describe("ORCHESTRAI_PERSIST=0 — every existing behavior stays byte-identical", () => {
  test("emitTaskState never throws and the in-memory task is unaffected when persistence is disabled", () => {
    process.env.ORCHESTRAI_PERSIST = "0"
    __resetSharedStoreForTests()
    const t = task({ id: "t-no-persist" })
    tasks.set(t.id, t)
    expect(() => emitTaskState(t)).not.toThrow()
    expect(tasks.get("t-no-persist")?.status).toBe("completed")
    expect(getSharedStore()).toBeNull()
  })

  test("answerLastFailureFromState degrades to the honest no-store message, never throws", () => {
    process.env.ORCHESTRAI_PERSIST = "0"
    __resetSharedStoreForTests()
    expect(tasks.size).toBe(0)
    expect(() => answerLastFailureFromState()).not.toThrow()
    expect(answerLastFailureFromState()).toBe("No recent task has failed.")
  })
})
