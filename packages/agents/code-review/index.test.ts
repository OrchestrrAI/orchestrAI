// specs/082-code-review-agent/spec.md — HTTP-level tests against the
// real, unmodified app, mirroring packages/agents/testing/index.test.ts's
// own convention. No live mcp:http server runs in this test process, so
// any skill that needs a real git_diff round trip (everything past the
// target-path/existence check) reaches a graceful "failed" here rather
// than a real result — the genuine diff-fetch/harness/grounding
// scenarios are exercised live per the spec's own Verification Plan
// (packages/agents/code-review/llm-harness.test.ts already covers the
// harness's own grounding/salvage/retry logic hermetically, with no
// live MCP server needed for that).
import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { agentCard, app } from "./index"

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

describe("specs/082 — Agent Card", () => {
  test("advertises review-diff, no other skill", () => {
    expect(agentCard.skills.map((s) => s.id)).toEqual(["review-diff"])
  })

  test("no approval-related endpoints exist — a genuinely read-only agent", async () => {
    // The route simply doesn't exist — Hono 404s it, unlike Testing/
    // DevOps's real /tasks/:id/approve routes.
    const res = await app.request("/tasks/anything/approve", { method: "POST" })
    expect(res.status).toBe(404)
  })
})

describe("specs/082 — detectSkill", () => {
  // Neither agent test file preserves `step` into a terminal status
  // (every agent's own failure path replaces the whole task record, the
  // same established shape testing/devops's own index.ts already use) —
  // so detection is confirmed here via which OUTCOME each phrase
  // reaches, not by reading `step` after the task has already finished.
  test("\"review my changes\" (no path) is routed to review-diff — fails on the missing target, not \"unknown\"", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "review my changes"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).not.toContain("not implemented yet")
  })

  test("\"code review this project\" (no path) is also routed to review-diff", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "code review this project"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).not.toContain("not implemented yet")
  })

  test("unrelated text does not falsely match review-diff", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "hello there, how are you"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("completed")
    expect(task.json.result).toContain("not implemented yet")
  })
})

describe("specs/082 — fail-closed preconditions (no MCP call needed)", () => {
  test("no target path fails closed with a named error", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "review this", "review-diff"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.status).toBe("failed")
    expect(task.json.error).toBeDefined()
  })
})

// Live-caught 2026-09-14, docker-compose verification: this agent has no
// filesystem access of its own (specs/082's own design — a pure MCP
// client, no volume mount, matching DevOps's own no-mount pattern), so a
// local existsSync() precondition check here was wrong — it checked a
// path in the *agent's own* container, not the target's, and would have
// always failed in exactly the deployment shape (compose) this agent
// exists to run in. Fixed by removing the local check; the real
// existence check already lives server-side in git_diff
// (packages/mcp/index.ts), which genuinely has filesystem access to the
// target. A nonexistent path now reaches a real MCP round trip and,
// with no live MCP server in this test process, fails gracefully the
// same way the "real, existing path" case below does.
describe("specs/082 — a nonexistent path (real existence check now lives server-side, in git_diff)", () => {
  test("reaches a real failed state via the MCP round trip, never hangs or throws unhandled", async () => {
    const id = `t-${randomUUID()}`
    const fakePath = path.join(tmpdir(), "orchestrai-code-review-does-not-exist-" + randomUUID())
    await submit(taskBody(id, `review my changes at ${fakePath}`, "review-diff"))
    const task = await getTaskAfter(id, ["failed", "completed"], 8000)
    expect(task.json.status).toBe("failed")
  })
})

describe("specs/082 — a real, existing path without a live MCP server fails gracefully", () => {
  test("reaches a real failed state, never hangs or throws unhandled", async () => {
    const id = `t-${randomUUID()}`
    const realDir = mkdtempSync(path.join(tmpdir(), "code-review-real-dir-"))
    await submit(taskBody(id, `review my changes at ${realDir}`, "review-diff"))
    // The MCP connection attempt itself takes ~3s to fail in this
    // no-live-server test environment — a generous poll window is
    // needed to observe the real terminal state.
    const task = await getTaskAfter(id, ["failed", "completed"], 8000)
    expect(task.json.status).toBe("failed")
  })
})
