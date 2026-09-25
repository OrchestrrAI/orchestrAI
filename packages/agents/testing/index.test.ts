// specs/080-run-command-approved-execution/spec.md §3 — the Testing
// Agent's own 4-state unsupported-runner fallback, tested at the real
// HTTP level (no mocked skill resolution), mirroring
// packages/agents/devops/index.test.ts's own convention. The explicit-
// command path and the "harness off"/"harness on but misconfigured"
// states are all synchronous or fail before any MCP call is even
// attempted, so they're fully testable here; the genuine LLM-proposal
// path (harness on, real key, real model) is exercised live per the
// spec's own Verification Plan, not here.
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { agentCard, app } from "./index"
import { MAX_SKILL_DESCRIPTION_BYTES } from "../../shared/task-envelope"

async function submit(body: Record<string, unknown>) {
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

async function getTask(id: string): Promise<{ status: number; json: any }> {
  const res = await app.request(`/tasks/${id}`)
  return { status: res.status, json: await res.json() }
}

async function getTaskAfter(id: string, statuses: string[], maxMs = 3000): Promise<{ status: number; json: any }> {
  const start = Date.now()
  let last = await getTask(id)
  while (Date.now() - start < maxMs) {
    if (statuses.includes(last.json.status)) return last
    await Bun.sleep(10)
    last = await getTask(id)
  }
  return last
}

function taskBody(id: string, text: string, selectedSkill?: string) {
  return {
    id,
    message: { role: "user", parts: [{ text }] },
    ...(selectedSkill ? { selectedSkill } : {}),
  }
}

// A project detectRunner() genuinely has no fixed profile for: no
// package.json, no pytest markers, no framework config — a bare go.mod
// is enough to make it real (not empty), while still resolving to
// { kind: "unsupported" } (packages/shared/test-runner.ts).
let unsupportedProjectDir: string

// specs/081-testing-write-tests-skill/spec.md — a real, minimal project
// detectRunner() classifies as { kind: "detected", runner: "bun" } (a
// bare package.json with a scripts.test string, no competing lockfile —
// packages/shared/test-runner.ts's own documented default), with a real
// source file to name explicitly.
let detectedProjectDir: string

// specs/111 (specs/104 item A2) — a real project detectRunner() classifies
// as { kind: "ambiguous", candidates: ["npm", "pnpm"] }: a package.json
// with a real scripts.test string (required to even enter the
// lockfile-candidate branch), plus two competing package-manager
// lockfiles present at once — no framework config, so this lands in the
// lockfile-ambiguity branch, not the framework-ambiguity one.
let ambiguousProjectDir: string

beforeAll(() => {
  unsupportedProjectDir = mkdtempSync(path.join(tmpdir(), "testing-unsupported-stack-"))
  writeFileSync(path.join(unsupportedProjectDir, "go.mod"), "module example.com/scratch\n\ngo 1.22\n")

  detectedProjectDir = mkdtempSync(path.join(tmpdir(), "testing-detected-bun-"))
  writeFileSync(path.join(detectedProjectDir, "package.json"), JSON.stringify({ name: "scratch", scripts: { test: "bun test" } }))
  writeFileSync(path.join(detectedProjectDir, "foo.ts"), "export function add(a: number, b: number): number {\n  return a + b\n}\n")

  ambiguousProjectDir = mkdtempSync(path.join(tmpdir(), "testing-ambiguous-runner-"))
  writeFileSync(path.join(ambiguousProjectDir, "package.json"), JSON.stringify({ name: "scratch", scripts: { test: "jest" } }))
  writeFileSync(path.join(ambiguousProjectDir, "package-lock.json"), "{}")
  writeFileSync(path.join(ambiguousProjectDir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n")
})

afterEach(() => {
  delete process.env.ORCHESTRAI_TESTING_LLM_HARNESS
  delete process.env.ORCHESTRAI_LLM_API_KEY
})

// specs/138 — with the fixed runner commands removed, the harness-off
// path no longer answers "no tests configured": it fails closed, named.
describe("specs/138 — run-tests with the Testing LLM off fails closed (was specs/080 state 1)", () => {
  test("no explicit command + harness off → a named failure, never a guess", async () => {
    // specs/077-agent-enabled-means-llm-on-by-default/spec.md flipped
    // Testing's own default to on — this test is specifically about the
    // harness-OFF branch, so it opts out explicitly.
    process.env.ORCHESTRAI_TESTING_LLM_HARNESS = "0"
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `run tests at ${unsupportedProjectDir}`, "run-tests"))
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("the fixed runner commands were removed in specs/138")
    expect(task.json.requiresApproval).toBeUndefined()
  })

  test("the same for a DETECTED runner — there is no fixed command to fall back to", async () => {
    process.env.ORCHESTRAI_TESTING_LLM_HARNESS = "0"
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `run tests at ${detectedProjectDir}`, "run-tests"))
    const task = await getTaskAfter(id, ["completed", "failed", "input-required"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("specs/138")
  })
})

describe("specs/080 — Testing's unsupported-runner fallback: state 2 (explicit command in task text)", () => {
  test("an explicit command reaches input-required with the exact argv, no harness needed", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `run command: go test ./... at ${unsupportedProjectDir}`, "run-tests"))
    const task = await getTaskAfter(id, ["input-required", "failed"])
    expect(task.json.status).toBe("input-required")
    expect(task.json.approval.argv).toEqual(["go", "test", "./..."])
    expect(task.json.approval.risks.join(" ")).toContain("given explicitly in the request")
  })
})

describe("specs/080 — Testing's unsupported-runner fallback: state 4 (harness on, misconfigured)", () => {
  test("fails the task closed with a named error, never a silent fallback to state 1", async () => {
    process.env.ORCHESTRAI_TESTING_LLM_HARNESS = "1"
    // Deliberately no ORCHESTRAI_LLM_API_KEY set.
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `run tests at ${unsupportedProjectDir}`, "run-tests"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("ORCHESTRAI_TESTING_LLM_HARNESS")
    expect(task.json.error).not.toContain("No tests configured")
  })
})

// specs/111-testing-documentation-routing-fixes/spec.md (specs/104 item
// A2) — run-tests/check-coverage's own ambiguous-runner branch now
// attempts resolution the same way the adjacent "unsupported" branch
// already does, but only when it can genuinely help (an explicit command
// in the text, or the harness on) — never when the harness is off with
// no explicit command, where the old static ambiguity report is the
// honest answer and stays byte-identical. The genuine harness-proposal
// path (a real model resolving the ambiguity from real file reads) is
// exercised live per the spec's own Verification Plan, not here — same
// standing precedent this file's own header comment already states for
// the "unsupported" case.
describe("specs/111 — run-tests/check-coverage ambiguous-runner resolution", () => {
  test("harness off, no explicit command — fails closed, named (specs/138; was the static ambiguity report)", async () => {
    process.env.ORCHESTRAI_TESTING_LLM_HARNESS = "0"
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `run tests at ${ambiguousProjectDir}`, "run-tests"))
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("specs/138")
    expect(task.json.requiresApproval).toBeUndefined()
  })

  test("an explicit command resolves it outright, even with the harness off", async () => {
    process.env.ORCHESTRAI_TESTING_LLM_HARNESS = "0"
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `run command: npx jest at ${ambiguousProjectDir}`, "run-tests"))
    const task = await getTaskAfter(id, ["input-required", "failed"])
    expect(task.json.status).toBe("input-required")
    expect(task.json.approval.argv).toEqual(["npx", "jest"])
  })

  test("harness on but misconfigured — fails closed distinctly from the static ambiguity report, never a silent fallback to it", async () => {
    process.env.ORCHESTRAI_TESTING_LLM_HARNESS = "1"
    // Deliberately no ORCHESTRAI_LLM_API_KEY set.
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `run tests at ${ambiguousProjectDir}`, "run-tests"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("ORCHESTRAI_TESTING_LLM_HARNESS")
    expect(task.json.error).not.toContain("Ambiguous")
  })

  test("write-tests's own ambiguous-runner handling is untouched by this fix — still fails closed with the original message", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `write tests for foo.ts at ${ambiguousProjectDir}`, "write-tests"))
    const task = await getTaskAfter(id, ["failed", "input-required"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("Ambiguous")
    expect(task.json.error).toContain("Resubmit naming which one to use")
  })
})

// specs/081-testing-write-tests-skill/spec.md — write-tests's own
// synchronous preconditions (explicit source path, a detected runner,
// the harness flag/config) all fail before any model call is ever
// attempted, so they're fully testable here without a live provider —
// the genuine harness-authored-content path is exercised live per the
// spec's own Verification Plan, not here.
describe("specs/081 — write-tests", () => {
  test("Agent Card advertises write-tests", () => {
    const ids = agentCard.skills.map((s) => s.id)
    expect(ids).toContain("write-tests")
  })

  // specs/126 — the router only sees this description, so it must fit the
  // capability snapshot's byte bound untruncated and say what is out of scope.
  test("write-tests' description scopes it to one named file, untruncated by the router's bound", () => {
    const description = agentCard.skills.find((s) => s.id === "write-tests")?.description ?? ""
    expect(new TextEncoder().encode(description).byteLength).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_BYTES)
    expect(description).toContain("ONE source file")
    expect(description).toContain("Not for a whole-project")
  })

  test("\"write tests for X\" detects write-tests, not run-tests (ordering regression)", async () => {
    // The real hazard this test pins: detectSkill()'s own bare "test"
    // catch-all would otherwise swallow this into run-tests, exactly the
    // ordering hazard specs/079/080 already had to fix for their own
    // new skills.
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `write tests for foo.ts at ${unsupportedProjectDir}`))
    const task = await getTaskAfter(id, ["failed", "input-required", "completed"])
    expect(task.json.step ?? "").not.toContain("Skill detected: run-tests")
  })

  test("no explicit source file fails closed — never a guess", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `write tests at ${detectedProjectDir}`, "write-tests"))
    const task = await getTaskAfter(id, ["failed", "input-required"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("No source file named")
  })

  test("an unsupported-runner project fails closed naming why", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `write tests for main.go at ${unsupportedProjectDir}`, "write-tests"))
    const task = await getTaskAfter(id, ["failed", "input-required"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("No known test-runner profile detected")
  })

  test("a source file outside the project root is refused", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `write tests for ../../etc/passwd.ts at ${detectedProjectDir}`, "write-tests"))
    const task = await getTaskAfter(id, ["failed", "input-required"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("outside the project root")
  })

  test("harness off fails closed — there is no deterministic fallback for authoring test code", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `write tests for foo.ts at ${detectedProjectDir}`, "write-tests"))
    const task = await getTaskAfter(id, ["failed", "input-required"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("ORCHESTRAI_TESTING_LLM_HARNESS=1")
  })

  test("harness on but misconfigured (no key) fails closed distinctly from harness-off", async () => {
    process.env.ORCHESTRAI_TESTING_LLM_HARNESS = "1"
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, `write tests for foo.ts at ${detectedProjectDir}`, "write-tests"))
    const task = await getTaskAfter(id, ["failed", "input-required"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("ORCHESTRAI_LLM_API_KEY is missing")
  })
})
