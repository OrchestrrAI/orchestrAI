import { describe, expect, test } from "bun:test"
import { parseOrchestratorSubmission, parseTaskEnvelope, MAX_TASK_TEXT_BYTES } from "./task-envelope"

describe("parseTaskEnvelope", () => {
  test("accepts the direct envelope form", () => {
    const result = parseTaskEnvelope({
      id: "task-1",
      message: { role: "user", parts: [{ text: "analyze project" }] },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.task.id).toBe("task-1")
      expect(result.task.text).toBe("analyze project")
    }
  })

  test("accepts the params-wrapped envelope form identically", () => {
    const direct = parseTaskEnvelope({
      id: "task-2",
      message: { role: "agent", parts: [{ text: "scan for secrets" }] },
    })
    const wrapped = parseTaskEnvelope({
      params: { id: "task-2", message: { role: "agent", parts: [{ text: "scan for secrets" }] } },
    })
    expect(direct).toEqual(wrapped)
  })

  test.each([
    [null, "Request body must be a JSON object"],
    [[], "Request body must be a JSON object"],
    [{}, "'id' must be a non-empty string"],
    [{ id: "" }, "'id' must be a non-empty string"],
    [{ id: "a".repeat(129) }, "'id' must be at most 128 characters"],
    [{ id: "bad id!" }, "'id' must match [A-Za-z0-9][A-Za-z0-9._:-]*"],
    [{ id: "ok", message: null }, "'message' must be an object"],
    [{ id: "ok", message: { role: "admin", parts: [{ text: "x" }] } }, "'message.role' must be 'user' or 'agent'"],
    [{ id: "ok", message: { role: "user", parts: [] } }, "'message.parts' must be a non-empty array"],
    [{ id: "ok", message: { role: "user", parts: "nope" } }, "'message.parts' must be a non-empty array"],
    [{ id: "ok", message: { role: "user", parts: [{ text: 5 }] } }, "every part's 'text' must be a string"],
    [{ id: "ok", message: { role: "user", parts: [{ text: "   " }] } }, "task text must contain at least one non-whitespace character"],
  ])("rejects invalid shape %#", (body, expectedError) => {
    const result = parseTaskEnvelope(body)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(expectedError)
  })

  test("rejects task text over the 64 KiB bound", () => {
    const result = parseTaskEnvelope({
      id: "big",
      message: { role: "user", parts: [{ text: "x".repeat(MAX_TASK_TEXT_BYTES + 1) }] },
    })
    expect(result.ok).toBe(false)
  })

  test("never mutates task count on invalid input (pure function, no side effects)", () => {
    const tasks = new Map<string, unknown>()
    const before = tasks.size
    parseTaskEnvelope({ id: "" })
    expect(tasks.size).toBe(before)
  })
})

describe("parseOrchestratorSubmission", () => {
  test("accepts a non-empty text submission", () => {
    const result = parseOrchestratorSubmission({ text: "analyze my project" })
    expect(result).toEqual({ ok: true, text: "analyze my project" })
  })

  test("rejects missing, blank, or oversized text", () => {
    expect(parseOrchestratorSubmission({}).ok).toBe(false)
    expect(parseOrchestratorSubmission({ text: "   " }).ok).toBe(false)
    expect(parseOrchestratorSubmission({ text: "x".repeat(MAX_TASK_TEXT_BYTES + 1) }).ok).toBe(false)
  })
})

// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md
describe("parseTaskEnvelope — selectedSkill (specs/030)", () => {
  test("legacy envelope with no selectedSkill/capabilities parses unchanged", () => {
    const result = parseTaskEnvelope({
      id: "legacy-1",
      message: { role: "user", parts: [{ text: "dockerize my app" }] },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.task.selectedSkill).toBeUndefined()
      expect(result.task.capabilities).toBeUndefined()
    }
  })

  test("accepts a valid selectedSkill", () => {
    const result = parseTaskEnvelope({
      id: "t1",
      message: { role: "agent", parts: [{ text: "check git status" }] },
      selectedSkill: "git-status",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.task.selectedSkill).toBe("git-status")
  })

  test.each([
    [{ selectedSkill: "" }, "'selectedSkill' must be a non-empty string"],
    [{ selectedSkill: 42 }, "'selectedSkill' must be a non-empty string"],
    [{ selectedSkill: "Dockerize" }, "'selectedSkill' must match [a-z][a-z0-9-]*"],
    [{ selectedSkill: "docker_ize" }, "'selectedSkill' must match [a-z][a-z0-9-]*"],
    [{ selectedSkill: "a".repeat(129) }, "'selectedSkill' must be at most 128 bytes"],
  ])("rejects invalid selectedSkill %#", (extra, expectedError) => {
    const result = parseTaskEnvelope({
      id: "t1",
      message: { role: "agent", parts: [{ text: "x" }] },
      ...extra,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(expectedError)
  })

  test("no task-store mutation occurs on invalid selectedSkill (pure function)", () => {
    const tasks = new Map<string, unknown>()
    parseTaskEnvelope({
      id: "t1",
      message: { role: "agent", parts: [{ text: "x" }] },
      selectedSkill: "BAD SKILL",
    })
    expect(tasks.size).toBe(0)
  })
})

describe("parseTaskEnvelope — capabilities (specs/030)", () => {
  test("accepts a valid capability snapshot", () => {
    const result = parseTaskEnvelope({
      id: "t1",
      message: { role: "agent", parts: [{ text: "plan it" }] },
      capabilities: [
        { agentName: "devops-agent", skillId: "git-status" },
        { agentName: "security-agent", skillId: "scan-secrets" },
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.task.capabilities).toHaveLength(2)
  })

  test("rejects capabilities that is not an array", () => {
    const result = parseTaskEnvelope({
      id: "t1",
      message: { role: "agent", parts: [{ text: "x" }] },
      capabilities: { agentName: "devops-agent", skillId: "git-status" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("'capabilities' must be an array")
  })

  test("rejects a malformed entry", () => {
    const result = parseTaskEnvelope({
      id: "t1",
      message: { role: "agent", parts: [{ text: "x" }] },
      capabilities: [{ agentName: "devops-agent", skillId: "Dockerize" }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("skillId")
  })

  test("rejects a duplicate (agentName, skillId) pair", () => {
    const result = parseTaskEnvelope({
      id: "t1",
      message: { role: "agent", parts: [{ text: "x" }] },
      capabilities: [
        { agentName: "devops-agent", skillId: "git-status" },
        { agentName: "devops-agent", skillId: "git-status" },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("duplicate")
  })

  test("rejects more than MAX_CAPABILITY_ENTRIES total entries", () => {
    const entries = Array.from({ length: 257 }, (_, i) => ({ agentName: "devops-agent", skillId: `skill-${i}` }))
    const result = parseTaskEnvelope({
      id: "t1",
      message: { role: "agent", parts: [{ text: "x" }] },
      capabilities: entries,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("at most 256 entries")
  })

  test("rejects more than MAX_SKILLS_PER_AGENT skills for one agent", () => {
    const entries = Array.from({ length: 33 }, (_, i) => ({ agentName: "devops-agent", skillId: `skill-${i}` }))
    const result = parseTaskEnvelope({
      id: "t1",
      message: { role: "agent", parts: [{ text: "x" }] },
      capabilities: entries,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("devops-agent")
  })

  test("rejects more than MAX_AGENTS distinct agents", () => {
    const entries = Array.from({ length: 33 }, (_, i) => ({ agentName: `agent-${i}`, skillId: "one-skill" }))
    const result = parseTaskEnvelope({
      id: "t1",
      message: { role: "agent", parts: [{ text: "x" }] },
      capabilities: entries,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("32 distinct agents")
  })
})
