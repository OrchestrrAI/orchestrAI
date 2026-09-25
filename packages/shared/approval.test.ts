import { describe, expect, test } from "bun:test"
import { newActionId, validateActionId, computeContentFingerprint } from "./approval"

describe("newActionId", () => {
  test("returns a unique random UUID each time", () => {
    const a = newActionId()
    const b = newActionId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe("validateActionId", () => {
  test("accepts a matching actionId", () => {
    const pending = "action-1"
    expect(validateActionId({ actionId: pending }, pending)).toEqual({ ok: true })
  })

  test("rejects a missing or non-string actionId with 400", () => {
    expect(validateActionId({}, "action-1")).toEqual({ ok: false, status: 400, error: expect.any(String) })
    expect(validateActionId({ actionId: 5 }, "action-1")).toEqual({ ok: false, status: 400, error: expect.any(String) })
    expect(validateActionId(null, "action-1")).toEqual({ ok: false, status: 400, error: expect.any(String) })
  })

  test("rejects when there is no pending action at all", () => {
    expect(validateActionId({ actionId: "anything" }, undefined)).toEqual({ ok: false, status: 409, error: expect.any(String) })
  })

  test("rejects a stale or mismatched actionId with 409", () => {
    expect(validateActionId({ actionId: "wrong" }, "action-1")).toEqual({ ok: false, status: 409, error: expect.any(String) })
  })

  test("extra request fields never influence the result", () => {
    const pending = "action-1"
    expect(validateActionId({ actionId: pending, toolName: "malicious", args: { evil: true } }, pending)).toEqual({ ok: true })
  })
})

describe("computeContentFingerprint — specs/056-devops-preflight-and-idempotent-writes", () => {
  test("identical content always fingerprints identically", () => {
    const content = "FROM oven/bun:1\nWORKDIR /app\n"
    expect(computeContentFingerprint(content)).toBe(computeContentFingerprint(content))
  })

  test("a single differing byte produces a different fingerprint — drift detection must not tolerate near-matches", () => {
    expect(computeContentFingerprint("a")).not.toBe(computeContentFingerprint("b"))
  })

  test("undefined (target absent) gets its own distinct sentinel, never confused with an empty string", () => {
    const absent = computeContentFingerprint(undefined)
    const empty = computeContentFingerprint("")
    expect(absent).toBe("absent")
    expect(absent).not.toBe(empty)
  })
})
