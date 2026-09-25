// specs/089-plan-step-skip-continue/spec.md (Option B) — HTTP-level tests
// for the new POST /tasks/:id/skip endpoint, driven through the real,
// unmodified Hono app via app.fetch() (no port bind — the same technique
// specs/033/035 already established), never a separate reimplementation.
//
// Mirrors reject's own exact validation shape (there is no dedicated
// HTTP-level test file for reject either — this establishes the pattern
// for both): the Orchestrator's own endpoint checks that a pending
// approval.actionId exists on ITS OWN stored task record (409 if not);
// the actual client-supplied actionId is forwarded to, and validated by,
// the AGENT's own /reject endpoint (reused verbatim for skip — the agent
// has no reason to know or care whether this is a "skip" or a "reject").
// A fake agent (mocked globalThis.fetch, mirroring supervisor-deps.
// test.ts's own established technique) reproduces that agent-side
// validateActionId() behavior so the full round trip is exercised, not
// just the Orchestrator's own half.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app, registry, tasks, type OrchestratorTask, type RegisteredAgent } from "./index"

const AGENT_ACTION_ID = "action-real-123"

function agent(name: string): RegisteredAgent {
  return {
    card: {
      name,
      description: "",
      url: `http://localhost:0/${name}`,
      version: "1.0.0",
      skills: [{ id: "dockerize", name: "dockerize", description: "" }],
    },
    url: `http://localhost:0/${name}`,
    status: "online",
    lastSeen: new Date(),
  }
}

function inputRequiredTask(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: "child-abc123",
    text: "dockerize: build the image",
    skill: "dockerize",
    status: "input-required",
    createdAt: new Date(),
    assignedAgent: "devops-agent",
    agentTaskId: "agent-task-1",
    parentTaskId: "parent-xyz789", // a plan step's own child task
    approval: {
      actionId: AGENT_ACTION_ID,
      kind: "file-write",
      summary: "Write Dockerfile",
      target: "C:\\scratch\\target-project",
      risks: [],
    },
    ...overrides,
  }
}

let originalFetch: typeof fetch
let forwardedActionId: string | undefined

beforeEach(() => {
  registry.clear()
  tasks.clear()
  forwardedActionId = undefined
  originalFetch = globalThis.fetch
  // Fake agent: mirrors the real DevOps/Testing/etc. agent's own
  // /tasks/:id/reject handler exactly — validates the forwarded actionId
  // and returns 200/409 the same way validateActionId() does. GET
  // requests (syncTaskStatus()'s own poll) get a generic input-required
  // echo so that call is a no-op for these tests.
  // @ts-expect-error — test double, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/reject") && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { actionId?: string }
      forwardedActionId = body.actionId
      if (body.actionId !== AGENT_ACTION_ID) {
        return new Response(JSON.stringify({ error: "actionId does not match pending action" }), { status: 409 })
      }
      return new Response(JSON.stringify({ id: "agent-task-1", status: "failed" }), { status: 200 })
    }
    // syncTaskStatus()'s own GET poll — echo back input-required unchanged.
    return new Response(JSON.stringify({ id: "agent-task-1", status: "input-required" }), { status: 200 })
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  registry.clear()
  tasks.clear()
})

describe("POST /tasks/:id/skip", () => {
  test("a plan step's own child task with a real pending approval: no write executes, task ends failed with a distinct 'Skipped' message", async () => {
    registry.set("devops-agent", agent("devops-agent"))
    const task = inputRequiredTask()
    tasks.set(task.id, task)

    const res = await app.fetch(new Request(`http://localhost/tasks/${task.id}/skip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: AGENT_ACTION_ID }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.status).toBe("failed")
    expect(body.message).toBe("Skipped")

    const updated = tasks.get(task.id)!
    expect(updated.status).toBe("failed")
    expect(updated.error).toBe("Skipped by user")
    expect(updated.approval).toBeUndefined()

    // The Orchestrator forwards its OWN stored actionId to the agent's
    // /reject endpoint — the agent's own validateActionId() is what
    // actually matches it against the pending action.
    expect(forwardedActionId).toBe(AGENT_ACTION_ID)
  })

  test("on a DIRECT (non-plan) task — no parentTaskId — skip is refused with a named error pointing at reject", async () => {
    const task = inputRequiredTask({ id: "direct-task-1", parentTaskId: undefined })
    tasks.set(task.id, task)

    const res = await app.fetch(new Request(`http://localhost/tasks/${task.id}/skip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: AGENT_ACTION_ID }),
    }))

    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toContain("reject")

    // Nothing was mutated — the task is left exactly as it was.
    const untouched = tasks.get(task.id)!
    expect(untouched.status).toBe("input-required")
    expect(untouched.approval).toBeDefined()
  })

  test("task not found -> 404", async () => {
    const res = await app.fetch(new Request("http://localhost/tasks/does-not-exist/skip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: "x" }),
    }))
    expect(res.status).toBe(404)
  })

  test("task not in input-required status -> 409, identical shape to reject's own", async () => {
    const task = inputRequiredTask({ id: "child-already-completed", status: "completed", approval: undefined })
    tasks.set(task.id, task)

    const res = await app.fetch(new Request(`http://localhost/tasks/${task.id}/skip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: AGENT_ACTION_ID }),
    }))

    expect(res.status).toBe(409)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toContain("completed")
  })

  test("no pending approval on the task -> 409, identical shape to reject's own", async () => {
    const task = inputRequiredTask({ id: "child-no-approval", approval: undefined })
    tasks.set(task.id, task)

    const res = await app.fetch(new Request(`http://localhost/tasks/${task.id}/skip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: AGENT_ACTION_ID }),
    }))

    expect(res.status).toBe(409)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toContain("No pending action")
  })

  test("the agent refuses a mismatched actionId -> the skip is refused end to end, task left untouched", async () => {
    registry.set("devops-agent", agent("devops-agent"))
    // task.approval.actionId on the Orchestrator's own record is what
    // gets forwarded — this simulates a stale record by directly setting
    // a value the fake agent above will reject.
    const task = inputRequiredTask({ approval: { ...inputRequiredTask().approval!, actionId: "stale-id-orchestrator-thinks-is-current" } })
    tasks.set(task.id, task)

    const res = await app.fetch(new Request(`http://localhost/tasks/${task.id}/skip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: "stale-id-orchestrator-thinks-is-current" }),
    }))

    expect(res.status).toBe(409)
    // The task must be left exactly as it was — no partial mutation.
    const untouched = tasks.get(task.id)!
    expect(untouched.status).toBe("input-required")
    expect(untouched.approval).toBeDefined()
  })

  test("reject's own existing behavior is completely unaffected by skip's existence", async () => {
    registry.set("devops-agent", agent("devops-agent"))
    const task = inputRequiredTask({ id: "child-for-reject" })
    tasks.set(task.id, task)

    const res = await app.fetch(new Request(`http://localhost/tasks/${task.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: AGENT_ACTION_ID }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.message).toBe("Rejected")
    const updated = tasks.get(task.id)!
    expect(updated.error).toBe("Rejected by user")
  })
})
