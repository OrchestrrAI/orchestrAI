import { describe, expect, test } from "bun:test"
import { allocateId, newTaskId } from "./ids"

describe("newTaskId", () => {
  test("uses crypto.randomUUID rather than wall-clock precision", () => {
    const a = newTaskId("task")
    const b = newTaskId("task")
    expect(a).not.toBe(b)
    expect(a).toMatch(/^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe("allocateId", () => {
  test("returns a unique ID when nothing collides", () => {
    const exists = new Set<string>()
    const id = allocateId("task", (candidate) => exists.has(candidate))
    expect(id.startsWith("task-")).toBe(true)
  })

  test("retries on an injected/test UUID collision instead of overwriting", () => {
    let calls = 0
    const collidingId = "task-forced-collision"
    const exists = (candidate: string) => {
      calls += 1
      // Force the first attempt to collide, then accept the next one.
      return calls === 1 ? true : false
    }
    const id = allocateId("task", exists)
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(id).not.toBe(collidingId)
  })

  test("throws after exhausting max attempts on persistent collision", () => {
    expect(() => allocateId("task", () => true, 3)).toThrow()
  })

  test("100 concurrent allocations against a shared store all stay unique", () => {
    const store = new Set<string>()
    const ids = Array.from({ length: 100 }, () => {
      const id = allocateId("task", (candidate) => store.has(candidate))
      store.add(id)
      return id
    })
    expect(new Set(ids).size).toBe(100)
  })
})
