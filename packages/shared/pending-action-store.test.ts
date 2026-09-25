// specs/110-approval-state-survives-a-restart/spec.md B0
//
// Exercises the generic persist/claim/forget/restore helpers against a
// real store (a unique scratch ORCHESTRAI_PROJECT_PATH per test, mirroring
// store.test.ts's own isolation requirement) and confirms every function
// degrades to a safe no-op when persistence is disabled.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { __resetSharedStoreForTests } from "./store"
import {
  claimPendingAction,
  forgetPendingAction,
  persistPendingAction,
  restorePendingActions,
  PENDING_ACTION_TTL_MS,
} from "./pending-action-store"

let scratchDir: string
let originalProjectPath: string | undefined
let originalPersist: string | undefined

function useRealStore(): void {
  process.env.ORCHESTRAI_PROJECT_PATH = scratchDir
  delete process.env.ORCHESTRAI_PERSIST
  __resetSharedStoreForTests()
}

function useDisabledStore(): void {
  process.env.ORCHESTRAI_PERSIST = "0"
  __resetSharedStoreForTests()
}

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(os.tmpdir(), "orchestrai-pending-action-store-test-"))
  originalProjectPath = process.env.ORCHESTRAI_PROJECT_PATH
  originalPersist = process.env.ORCHESTRAI_PERSIST
})

afterEach(() => {
  if (originalProjectPath === undefined) delete process.env.ORCHESTRAI_PROJECT_PATH
  else process.env.ORCHESTRAI_PROJECT_PATH = originalProjectPath
  if (originalPersist === undefined) delete process.env.ORCHESTRAI_PERSIST
  else process.env.ORCHESTRAI_PERSIST = originalPersist
  __resetSharedStoreForTests()
  rmSync(scratchDir, { recursive: true, force: true })
})

describe("no store available — every function is a safe no-op", () => {
  test("persistPendingAction never throws with no store", () => {
    useDisabledStore()
    expect(() =>
      persistPendingAction({ agent: "devops-agent", taskId: "t-1", actionId: "a-1", kind: "write", skill: "dockerize", payload: { x: 1 } }),
    ).not.toThrow()
  })

  test("claimPendingAction returns true (nothing to claim, in-memory Map remains sole boundary)", () => {
    useDisabledStore()
    expect(claimPendingAction({ agent: "devops-agent", taskId: "t-1" })).toBe(true)
  })

  test("forgetPendingAction never throws with no store", () => {
    useDisabledStore()
    expect(() => forgetPendingAction({ agent: "devops-agent", taskId: "t-1" })).not.toThrow()
  })

  test("restorePendingActions returns an empty array with no store", () => {
    useDisabledStore()
    const restored = restorePendingActions({ agent: "devops-agent", validate: (raw) => raw })
    expect(restored).toEqual([])
  })
})

describe("a real store — persist, claim, forget, restore", () => {
  test("a persisted action is returned by restorePendingActions with the exact payload", () => {
    useRealStore()
    persistPendingAction({ agent: "devops-agent", taskId: "t-1", actionId: "a-1", kind: "write", skill: "dockerize", payload: { fingerprint: "abc" } })

    const restored = restorePendingActions<{ fingerprint: string }>({
      agent: "devops-agent",
      validate: (raw) => (raw && typeof raw === "object" && "fingerprint" in raw ? (raw as { fingerprint: string }) : null),
    })
    expect(restored).toHaveLength(1)
    expect(restored[0]!.taskId).toBe("t-1")
    expect(restored[0]!.actionId).toBe("a-1")
    expect(restored[0]!.kind).toBe("write")
    expect(restored[0]!.skill).toBe("dockerize")
    expect(restored[0]!.payload).toEqual({ fingerprint: "abc" })
  })

  test("claimPendingAction transitions a pending row and returns true exactly once — the real single-consumption boundary", () => {
    useRealStore()
    persistPendingAction({ agent: "devops-agent", taskId: "t-1", actionId: "a-1", kind: "write", skill: "dockerize", payload: {} })

    expect(claimPendingAction({ agent: "devops-agent", taskId: "t-1" })).toBe(true)
    // The second, concurrent approve request must not also succeed.
    expect(claimPendingAction({ agent: "devops-agent", taskId: "t-1" })).toBe(false)
  })

  test("a claimed row is never restored — restorePendingActions only ever returns 'pending' rows", () => {
    useRealStore()
    persistPendingAction({ agent: "devops-agent", taskId: "t-1", actionId: "a-1", kind: "write", skill: "dockerize", payload: {} })
    claimPendingAction({ agent: "devops-agent", taskId: "t-1" })

    const restored = restorePendingActions({ agent: "devops-agent", validate: (raw) => raw })
    expect(restored).toEqual([])
  })

  test("forgetPendingAction removes the row — restorePendingActions no longer sees it", () => {
    useRealStore()
    persistPendingAction({ agent: "devops-agent", taskId: "t-1", actionId: "a-1", kind: "write", skill: "dockerize", payload: {} })
    forgetPendingAction({ agent: "devops-agent", taskId: "t-1" })

    const restored = restorePendingActions({ agent: "devops-agent", validate: (raw) => raw })
    expect(restored).toEqual([])
  })

  test("rows are scoped per agent — one agent's restore never sees another agent's row", () => {
    useRealStore()
    persistPendingAction({ agent: "devops-agent", taskId: "t-1", actionId: "a-1", kind: "write", skill: "dockerize", payload: {} })
    persistPendingAction({ agent: "coder-agent", taskId: "t-1", actionId: "a-2", kind: "write", skill: "edit-file", payload: {} })

    const devopsRestored = restorePendingActions({ agent: "devops-agent", validate: (raw) => raw })
    expect(devopsRestored).toHaveLength(1)
    expect(devopsRestored[0]!.skill).toBe("dockerize")

    const coderRestored = restorePendingActions({ agent: "coder-agent", validate: (raw) => raw })
    expect(coderRestored).toHaveLength(1)
    expect(coderRestored[0]!.skill).toBe("edit-file")
  })

  test("a row failing validate() is discarded — never partially trusted — and deleted so it can't linger", () => {
    useRealStore()
    persistPendingAction({ agent: "devops-agent", taskId: "t-1", actionId: "a-1", kind: "write", skill: "dockerize", payload: { fingerprint: "abc" } })

    // A validator that always rejects, simulating a corrupted/schema-mismatched row.
    const restored = restorePendingActions({ agent: "devops-agent", validate: () => null })
    expect(restored).toEqual([])

    // Confirmed genuinely deleted, not just filtered — a second restore
    // attempt with a permissive validator still finds nothing.
    const secondAttempt = restorePendingActions({ agent: "devops-agent", validate: (raw) => raw })
    expect(secondAttempt).toEqual([])
  })

  test("write kind uses the 24h TTL, command kind uses the 1h TTL", () => {
    useRealStore()
    const before = Date.now()
    persistPendingAction({ agent: "devops-agent", taskId: "t-write", actionId: "a-1", kind: "write", skill: "dockerize", payload: {} })
    persistPendingAction({ agent: "devops-agent", taskId: "t-command", actionId: "a-2", kind: "command", skill: "run-command", payload: {} })

    expect(PENDING_ACTION_TTL_MS.write).toBe(24 * 60 * 60 * 1000)
    expect(PENDING_ACTION_TTL_MS.command).toBe(60 * 60 * 1000)

    // Both rows are restorable now (neither TTL has remotely elapsed) —
    // the TTL values themselves are asserted directly above; this just
    // confirms both kinds actually persisted successfully.
    const restored = restorePendingActions({ agent: "devops-agent", validate: (raw) => raw })
    expect(restored.map((r) => r.taskId).sort()).toEqual(["t-command", "t-write"])
    expect(before).toBeLessThanOrEqual(Date.now())
  })
})
