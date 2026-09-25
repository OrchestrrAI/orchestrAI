// specs/083-coder-agent/spec.md — HTTP-level tests against the real,
// unmodified app, mirroring packages/agents/code-review/index.test.ts's
// own convention. Unlike code-review-agent, this agent checks its own
// LLM harness flag BEFORE ever calling MCP (a deliberate ordering
// choice — there is nothing useful to read or compute without a
// harness in the first place), so every well-formed task in this test
// process fails closed on that precondition deterministically, with
// zero live MCP server needed at all — the genuine grounding/retry/
// harness scenarios are exercised hermetically in
// packages/agents/coder/llm-harness.test.ts instead.
//
// specs/086-code-review-coder-default-on/spec.md flipped this agent's
// own default to on, so this file now explicitly sets
// ORCHESTRAI_CODER_LLM_HARNESS=0 for its own duration — the file's own
// design (every well-formed task fails closed on the harness
// precondition, no live MCP server needed) is unchanged, it just needs
// the explicit opt-out now instead of relying on the old default.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { agentCard, app } from "./index"
import { MAX_SKILL_DESCRIPTION_BYTES } from "../../shared/task-envelope"

let originalHarnessEnv: string | undefined
beforeAll(() => {
  originalHarnessEnv = process.env.ORCHESTRAI_CODER_LLM_HARNESS
  process.env.ORCHESTRAI_CODER_LLM_HARNESS = "0"
})
afterAll(() => {
  if (originalHarnessEnv === undefined) delete process.env.ORCHESTRAI_CODER_LLM_HARNESS
  else process.env.ORCHESTRAI_CODER_LLM_HARNESS = originalHarnessEnv
})

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

describe("specs/083 — Agent Card", () => {
  // specs/114-coder-multi-file-edit-and-create/spec.md added a second,
  // additive skill; specs/119-coder-verify-loop-and-reviewer-depth/spec.md
  // added a third (edit-and-verify) — this asserts all three, in order,
  // rather than an exclusive list, so a real future addition is expected
  // to touch this assertion rather than being treated as a regression.
  // specs/133 — the router reads this (specs/121); it must fit the 300-byte
  // cap untruncated and still say edit-file is for one file only.
  test("edit-file's card description is one-file-only and fits the description cap", () => {
    const description = agentCard.skills.find((s) => s.id === "edit-file")!.description
    expect(description).toContain("ONE existing file")
    expect(description).toContain("use edit-files instead")
    expect(new TextEncoder().encode(description).byteLength).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_BYTES)
  })

  test("advertises edit-file, edit-files, and edit-and-verify, no other skill", () => {
    expect(agentCard.skills.map((s) => s.id)).toEqual(["edit-file", "edit-files", "edit-and-verify"])
  })

  test("approval routes genuinely exist — unlike code-review-agent, this is a write-capable skill", async () => {
    // A JSON {error:"Task not found"} 404 proves the ROUTE matched (it's
    // this app's own real handler responding), distinct from Hono's
    // unmatched-route 404 a nonexistent path would produce.
    const res = await app.request("/tasks/does-not-exist/approve", { method: "POST" })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("Task not found")
  })

  test("reject route also genuinely exists", async () => {
    const res = await app.request("/tasks/does-not-exist/reject", { method: "POST" })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("Task not found")
  })
})

describe("specs/083 — detectSkill", () => {
  // Neither agent test file in this codebase preserves `step` into a
  // terminal status (every agent's own failure path replaces the whole
  // task record) — so detection is confirmed here via which OUTCOME
  // each phrase reaches, not by reading `step` after the task finished.
  test('"edit src/foo.ts: fix the bug" is routed to edit-file — fails on the missing project root, not "unknown"', async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit src/foo.ts: fix the bug"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).not.toContain("not implemented yet")
  })

  test('"modify src/foo.ts to rename the function" is also routed to edit-file', async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "modify src/foo.ts to rename the function"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).not.toContain("not implemented yet")
  })

  test('a trigger word with no file extension does NOT match — detectSkill requires a real file hint', async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit this project to be better"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("completed")
    expect(task.json.result).toContain("not implemented yet")
  })

  test("unrelated text does not falsely match edit-file", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "hello there, how are you"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("completed")
    expect(task.json.result).toContain("not implemented yet")
  })
})

describe("specs/083 — fail-closed preconditions (no MCP call needed)", () => {
  test("no file named fails closed with a named error", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "please make a change", "edit-file"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("No file named")
  })

  test("no description of the requested change fails closed with a distinct named error", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit src/foo.ts", "edit-file"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("No description of the requested change")
  })

  test("no resolvable project root fails closed with a distinct error, past both earlier checks", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit src/foo.ts: fix the off-by-one bug", "edit-file"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).not.toContain("No file named")
    expect(task.json.error).not.toContain("No description of the requested change")
  })

  test("harness flag off fails closed with a named error mentioning ORCHESTRAI_CODER_LLM_HARNESS, past a resolvable project root", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit src/foo.ts: fix the off-by-one bug at C:\\some\\real\\project", "edit-file"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("ORCHESTRAI_CODER_LLM_HARNESS")
  })
})

// specs/114-coder-multi-file-edit-and-create/spec.md — same style as
// edit-file's own fail-closed precondition coverage above: this file's
// own harness-off convention (see the file's own top comment) means
// every well-formed edit-files task also fails closed on a
// deterministic precondition, with zero live MCP server needed.
describe("specs/114 — detectSkill routes edit-files", () => {
  test('"edit-files at ...: rename Logger" is routed to edit-files, not edit-file or unknown', async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit-files at C:\\some\\real\\project: rename the Logger class to AppLogger everywhere"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    // Routed and reached the harness-flag precondition (edit-files' own
    // distinct failure), never "unknown"/"not implemented yet" and never
    // edit-file's own "No file named" error.
    expect(task.json.status).toBe("failed")
    expect(task.json.error).not.toContain("not implemented yet")
    expect(task.json.error).not.toContain("No file named")
    expect(task.json.error).toContain("ORCHESTRAI_CODER_LLM_HARNESS")
  })
})

describe("specs/114 — edit-files fail-closed preconditions (no MCP call needed)", () => {
  test("no description of the requested change fails closed with a distinct named error", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit-files", "edit-files"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("No description of the requested change")
  })

  test("no resolvable project root fails closed with a distinct error, past the description check", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit-files: rename Logger to AppLogger everywhere", "edit-files"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).not.toContain("No description of the requested change")
  })

  test("harness flag off fails closed with a named error mentioning ORCHESTRAI_CODER_LLM_HARNESS, past a resolvable project root", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit-files at C:\\some\\real\\project: rename Logger to AppLogger everywhere", "edit-files"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("ORCHESTRAI_CODER_LLM_HARNESS")
  })
})

// specs/119-coder-verify-loop-and-reviewer-depth/spec.md — same style as
// edit-files' own fail-closed precondition coverage above: this file's
// own harness-off convention means every well-formed edit-and-verify
// task also fails closed on a deterministic precondition, with zero
// live MCP server or model needed. The genuine loop/B1/bound scenarios
// are exercised hermetically in verify-loop.test.ts instead.
describe("specs/119 — detectSkill routes edit-and-verify", () => {
  test('"edit-and-verify at ...: fix the bug" is routed to edit-and-verify, not edit-files/edit-file/unknown', async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit-and-verify at C:\\some\\real\\project: fix the off-by-one bug and confirm the tests pass"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).not.toContain("not implemented yet")
    expect(task.json.error).not.toContain("No file named")
    expect(task.json.error).toContain("ORCHESTRAI_CODER_LLM_HARNESS")
  })
})

describe("specs/119 — edit-and-verify fail-closed preconditions (no MCP call needed)", () => {
  test("no description of the requested change fails closed with a distinct named error", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit-and-verify", "edit-and-verify"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("No description of the requested change")
  })

  test("no resolvable project root fails closed with a distinct error, past the description check", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit-and-verify: fix the bug and confirm the tests pass", "edit-and-verify"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).not.toContain("No description of the requested change")
  })

  test("harness flag off fails closed with a named error mentioning ORCHESTRAI_CODER_LLM_HARNESS, past a resolvable project root", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "edit-and-verify at C:\\some\\real\\project: fix the bug and confirm the tests pass", "edit-and-verify"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toContain("ORCHESTRAI_CODER_LLM_HARNESS")
  })
})
