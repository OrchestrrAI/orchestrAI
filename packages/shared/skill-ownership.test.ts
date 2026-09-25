// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md
import { describe, expect, test } from "bun:test"
import { validateSelectedSkillOwnership } from "./task-envelope"
import type { ValidatedTask } from "./task-envelope"

function task(selectedSkill?: string): ValidatedTask {
  return {
    id: "t1",
    message: { role: "user", parts: [{ text: "x" }] },
    text: "x",
    ...(selectedSkill !== undefined ? { selectedSkill } : {}),
  }
}

describe("validateSelectedSkillOwnership", () => {
  test("passes when selectedSkill is absent — legacy behavior preserved", () => {
    const result = validateSelectedSkillOwnership(task(), new Set(["git-status"]))
    expect(result.ok).toBe(true)
  })

  test("passes when selectedSkill is owned by this agent", () => {
    const result = validateSelectedSkillOwnership(task("git-status"), new Set(["git-status", "dockerize"]))
    expect(result.ok).toBe(true)
  })

  test("rejects when selectedSkill is not owned by this agent", () => {
    const result = validateSelectedSkillOwnership(task("scan-secrets"), new Set(["git-status", "dockerize"]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("scan-secrets")
  })

  test("rejects a skill that simply doesn't exist anywhere", () => {
    const result = validateSelectedSkillOwnership(task("teleport-app"), new Set(["git-status"]))
    expect(result.ok).toBe(false)
  })
})
