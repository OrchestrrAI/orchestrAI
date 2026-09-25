// specs/120-supervisor-parallel-write-dispatch/spec.md §4 — HTTP-level
// tests for the new POST /tasks/:parentId/approve-batch endpoint, driven
// through the real, unmodified Hono app via app.fetch() (the same
// technique skip-endpoint.test.ts already established for the single-task
// skip endpoint). A fake agent (mocked globalThis.fetch) reproduces the
// real per-agent /approve and /reject validateActionId() behavior so the
// full round trip is exercised, not just the Orchestrator's own half.
//
// The load-bearing property under test throughout: this endpoint never
// constructs a shared or collapsed actionId — every forwarded call carries
// exactly the branch's OWN actionId, and a mismatched pairing is refused.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app, registry, tasks, computeDisjointBatch, type OrchestratorTask, type RegisteredAgent } from "./index"

const PARENT_ID = "parent-plan-1"

function agent(name: string): RegisteredAgent {
  return {
    card: {
      name,
      description: "",
      url: `http://localhost:0/${name}`,
      version: "1.0.0",
      skills: [{ id: "dockerize", name: "dockerize", description: "" }, { id: "create-ci", name: "create-ci", description: "" }],
    },
    url: `http://localhost:0/${name}`,
    status: "online",
    lastSeen: new Date(),
  }
}

function writeChild(id: string, actionId: string, target: string, overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id,
    text: `dockerize: build — ${id}`,
    skill: "dockerize",
    status: "input-required",
    createdAt: new Date(),
    assignedAgent: "devops-agent",
    agentTaskId: `agent-task-${id}`,
    parentTaskId: PARENT_ID,
    approval: {
      actionId,
      kind: "file-write",
      summary: "Write a file",
      target,
      risks: [],
    },
    ...overrides,
  }
}

let originalFetch: typeof fetch
let forwardedCalls: { url: string; method: string; actionId: string }[]

beforeEach(() => {
  registry.clear()
  tasks.clear()
  forwardedCalls = []
  originalFetch = globalThis.fetch
  // Fake agent: mirrors the real agent's own /approve and /reject
  // handlers — validates the forwarded actionId against a fixed per-child
  // "real" actionId map, keyed by the agentTaskId path segment.
  // @ts-expect-error — test double, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (method === "POST" && (String(url).endsWith("/approve") || String(url).endsWith("/reject"))) {
      const body = JSON.parse(init!.body as string) as { actionId?: string }
      forwardedCalls.push({ url: String(url), method, actionId: body.actionId ?? "" })
      const [, , agentTaskId] = String(url).match(/\/tasks\/([^/]+)\/(approve|reject)$/)?.slice(0) ?? []
      const expectedActionId = REAL_ACTION_IDS[agentTaskId ?? ""]
      if (expectedActionId !== undefined && body.actionId !== expectedActionId) {
        return new Response(JSON.stringify({ error: "actionId does not match pending action" }), { status: 409 })
      }
      return new Response(JSON.stringify({ id: agentTaskId, status: String(url).endsWith("/approve") ? "working" : "failed" }), { status: 200 })
    }
    // syncTaskStatus()'s own GET poll — echo input-required unchanged.
    return new Response(JSON.stringify({ id: "x", status: "input-required" }), { status: 200 })
  }
})

// Populated per-test via REAL_ACTION_IDS assignment before use.
let REAL_ACTION_IDS: Record<string, string> = {}

afterEach(() => {
  globalThis.fetch = originalFetch
  registry.clear()
  tasks.clear()
  REAL_ACTION_IDS = {}
})

function setup(): void {
  registry.set("devops-agent", agent("devops-agent"))
  tasks.set(PARENT_ID, {
    id: PARENT_ID, text: "plan", skill: "plan-task", status: "working", createdAt: new Date(), isPlan: true,
  })
}

describe("computeDisjointBatch", () => {
  test("fewer than two pending write-capable children -> ineligible", () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "C:\\proj\\Dockerfile"))
    expect(computeDisjointBatch(PARENT_ID)).toEqual({ eligible: false })
  })

  test("two pending write-capable children with distinct targets -> eligible", () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "C:\\proj\\Dockerfile"))
    tasks.set("c2", writeChild("c2", "a2", "C:\\proj\\.github\\workflows\\ci.yml"))
    const batch = computeDisjointBatch(PARENT_ID)
    expect(batch.eligible).toBe(true)
    if (batch.eligible) expect(batch.branches.map((b) => b.id).sort()).toEqual(["c1", "c2"])
  })

  test("two pending write-capable children sharing a target -> ineligible", () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "C:\\proj\\.gitignore"))
    tasks.set("c2", writeChild("c2", "a2", "C:\\proj\\.gitignore"))
    expect(computeDisjointBatch(PARENT_ID)).toEqual({ eligible: false })
  })

  test("a specs/114 multi-file preview overlapping another branch's single target -> ineligible", () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "3 files", {
      approval: {
        actionId: "a1", kind: "file-write", summary: "multi", target: "3 files", risks: [],
        files: [
          { target: "C:\\proj\\a.ts", action: "edit", fingerprint: "x" },
          { target: "C:\\proj\\b.ts", action: "edit", fingerprint: "y" },
        ],
      },
    }))
    tasks.set("c2", writeChild("c2", "a2", "C:\\proj\\b.ts")) // overlaps c1's second file
    expect(computeDisjointBatch(PARENT_ID)).toEqual({ eligible: false })
  })

  test("a specs/114 multi-file preview with genuinely distinct paths from a sibling -> eligible", () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "2 files", {
      approval: {
        actionId: "a1", kind: "file-write", summary: "multi", target: "2 files", risks: [],
        files: [
          { target: "C:\\proj\\a.ts", action: "edit", fingerprint: "x" },
          { target: "C:\\proj\\b.ts", action: "edit", fingerprint: "y" },
        ],
      },
    }))
    tasks.set("c2", writeChild("c2", "a2", "C:\\proj\\c.ts"))
    const batch = computeDisjointBatch(PARENT_ID)
    expect(batch.eligible).toBe(true)
  })

  test("a read-only sibling is never counted toward the batch", () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "C:\\proj\\Dockerfile"))
    tasks.set("c2", { ...writeChild("c2", "a2", "n/a"), skill: "git-status" })
    expect(computeDisjointBatch(PARENT_ID)).toEqual({ eligible: false })
  })
})

describe("POST /tasks/:parentId/approve-batch", () => {
  test("disjoint targets: approving the group writes every branch concurrently, each with its own actionId", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "real-a1", "C:\\proj\\Dockerfile"))
    tasks.set("c2", writeChild("c2", "real-a2", "C:\\proj\\.github\\workflows\\ci.yml"))
    REAL_ACTION_IDS = { "agent-task-c1": "real-a1", "agent-task-c2": "real-a2" }

    const res = await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/approve-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [
        { childTaskId: "c1", actionId: "real-a1", decision: "approve" },
        { childTaskId: "c2", actionId: "real-a2", decision: "approve" },
      ] }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json() as { results: { childTaskId: string; ok: boolean }[] }
    expect(body.results.every((r) => r.ok)).toBe(true)
    expect(tasks.get("c1")!.status).toBe("working")
    expect(tasks.get("c2")!.status).toBe("working")
    // Each forwarded call carried its OWN real actionId — never a shared one.
    expect(forwardedCalls.find((c) => c.url.includes("agent-task-c1"))?.actionId).toBe("real-a1")
    expect(forwardedCalls.find((c) => c.url.includes("agent-task-c2"))?.actionId).toBe("real-a2")
  })

  test("a mixed group — approve one, reject one — executes exactly that, and the rejected one is discarded", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "real-a1", "C:\\proj\\Dockerfile"))
    tasks.set("c2", writeChild("c2", "real-a2", "C:\\proj\\.github\\workflows\\ci.yml"))
    REAL_ACTION_IDS = { "agent-task-c1": "real-a1", "agent-task-c2": "real-a2" }

    const res = await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/approve-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [
        { childTaskId: "c1", actionId: "real-a1", decision: "approve" },
        { childTaskId: "c2", actionId: "real-a2", decision: "reject" },
      ] }),
    }))

    expect(res.status).toBe(200)
    expect(tasks.get("c1")!.status).toBe("working")
    expect(tasks.get("c2")!.status).toBe("failed")
    expect(tasks.get("c2")!.error).toBe("Rejected by user")
  })

  test("unknown parent -> 404", async () => {
    const res = await app.fetch(new Request("http://localhost/tasks/does-not-exist/approve-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [] }),
    }))
    expect(res.status).toBe(404)
  })

  test("a child belonging to a DIFFERENT parent -> 409, and nothing is mutated", async () => {
    setup()
    tasks.set("other-parent", { id: "other-parent", text: "x", skill: "plan-task", status: "working", createdAt: new Date(), isPlan: true })
    tasks.set("c1", writeChild("c1", "real-a1", "C:\\proj\\Dockerfile", { parentTaskId: "other-parent" }))
    tasks.set("c2", writeChild("c2", "real-a2", "C:\\proj\\.github\\workflows\\ci.yml"))
    REAL_ACTION_IDS = { "agent-task-c1": "real-a1", "agent-task-c2": "real-a2" }

    const res = await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/approve-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [
        { childTaskId: "c1", actionId: "real-a1", decision: "approve" },
        { childTaskId: "c2", actionId: "real-a2", decision: "approve" },
      ] }),
    }))

    expect(res.status).toBe(409)
    expect(tasks.get("c1")!.status).toBe("input-required")
    expect(tasks.get("c2")!.status).toBe("input-required")
  })

  test("a child listed twice -> 400, nothing mutated", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "real-a1", "C:\\proj\\Dockerfile"))
    tasks.set("c2", writeChild("c2", "real-a2", "C:\\proj\\.github\\workflows\\ci.yml"))
    REAL_ACTION_IDS = { "agent-task-c1": "real-a1", "agent-task-c2": "real-a2" }

    const res = await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/approve-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [
        { childTaskId: "c1", actionId: "real-a1", decision: "approve" },
        { childTaskId: "c1", actionId: "real-a1", decision: "approve" },
      ] }),
    }))

    expect(res.status).toBe(400)
    expect(tasks.get("c1")!.status).toBe("input-required")
  })

  test("a valid actionId paired with the WRONG childTaskId -> 409, nothing mutated", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "real-a1", "C:\\proj\\Dockerfile"))
    tasks.set("c2", writeChild("c2", "real-a2", "C:\\proj\\.github\\workflows\\ci.yml"))
    REAL_ACTION_IDS = { "agent-task-c1": "real-a1", "agent-task-c2": "real-a2" }

    const res = await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/approve-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // c1's real actionId is "real-a1", not c2's "real-a2".
      body: JSON.stringify({ decisions: [
        { childTaskId: "c1", actionId: "real-a2", decision: "approve" },
        { childTaskId: "c2", actionId: "real-a2", decision: "approve" },
      ] }),
    }))

    expect(res.status).toBe(409)
    expect(tasks.get("c1")!.status).toBe("input-required")
    expect(tasks.get("c2")!.status).toBe("input-required")
  })

  test("a partial decision list — omitting an eligible branch — is refused with 400, nothing mutated", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "real-a1", "C:\\proj\\Dockerfile"))
    tasks.set("c2", writeChild("c2", "real-a2", "C:\\proj\\.github\\workflows\\ci.yml"))
    REAL_ACTION_IDS = { "agent-task-c1": "real-a1", "agent-task-c2": "real-a2" }

    const res = await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/approve-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [{ childTaskId: "c1", actionId: "real-a1", decision: "approve" }] }),
    }))

    expect(res.status).toBe(400)
    expect(tasks.get("c1")!.status).toBe("input-required")
    expect(tasks.get("c2")!.status).toBe("input-required")
  })

  test("overlapping targets — no eligible batch exists at all — refused with 409 even for a complete-looking list", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "real-a1", "C:\\proj\\.gitignore"))
    tasks.set("c2", writeChild("c2", "real-a2", "C:\\proj\\.gitignore"))
    REAL_ACTION_IDS = { "agent-task-c1": "real-a1", "agent-task-c2": "real-a2" }

    const res = await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/approve-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [
        { childTaskId: "c1", actionId: "real-a1", decision: "approve" },
        { childTaskId: "c2", actionId: "real-a2", decision: "approve" },
      ] }),
    }))

    expect(res.status).toBe(409)
    expect(tasks.get("c1")!.status).toBe("input-required")
    expect(tasks.get("c2")!.status).toBe("input-required")
  })

  test("the SAME decision list submitted twice: the second finds no pending action and is refused, no double-execution", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "real-a1", "C:\\proj\\Dockerfile"))
    tasks.set("c2", writeChild("c2", "real-a2", "C:\\proj\\.github\\workflows\\ci.yml"))
    REAL_ACTION_IDS = { "agent-task-c1": "real-a1", "agent-task-c2": "real-a2" }

    const requestBody = JSON.stringify({ decisions: [
      { childTaskId: "c1", actionId: "real-a1", decision: "approve" },
      { childTaskId: "c2", actionId: "real-a2", decision: "approve" },
    ] })

    const first = await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/approve-batch`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody,
    }))
    expect(first.status).toBe(200)

    const approveCallsAfterFirst = forwardedCalls.length
    const second = await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/approve-batch`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody,
    }))

    expect(second.status).toBe(409) // no longer input-required
    // No new forwarded /approve or /reject calls happened on the second submission.
    expect(forwardedCalls.length).toBe(approveCallsAfterFirst)
  })

  test("no shared or collapsed actionId is ever constructed — each forwarded call's actionId is exactly its own branch's", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "unique-1", "C:\\proj\\Dockerfile"))
    tasks.set("c2", writeChild("c2", "unique-2", "C:\\proj\\.github\\workflows\\ci.yml"))
    REAL_ACTION_IDS = { "agent-task-c1": "unique-1", "agent-task-c2": "unique-2" }

    await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/approve-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [
        { childTaskId: "c1", actionId: "unique-1", decision: "approve" },
        { childTaskId: "c2", actionId: "unique-2", decision: "approve" },
      ] }),
    }))

    const actionIdsUsed = forwardedCalls.map((c) => c.actionId)
    expect(new Set(actionIdsUsed).size).toBe(2) // two distinct actionIds, never merged into one
    expect(actionIdsUsed.sort()).toEqual(["unique-1", "unique-2"])
  })
})

describe("GET /tasks/:parentId/pending-batch", () => {
  test("reports eligible with the real branches when a disjoint batch exists", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "C:\\proj\\Dockerfile"))
    tasks.set("c2", writeChild("c2", "a2", "C:\\proj\\.github\\workflows\\ci.yml"))

    const res = await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/pending-batch`))
    expect(res.status).toBe(200)
    const body = await res.json() as { eligible: boolean; branches: { id: string }[] }
    expect(body.eligible).toBe(true)
    expect(body.branches.map((b) => b.id).sort()).toEqual(["c1", "c2"])
  })

  test("reports ineligible when targets overlap", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "C:\\proj\\.gitignore"))
    tasks.set("c2", writeChild("c2", "a2", "C:\\proj\\.gitignore"))

    const res = await app.fetch(new Request(`http://localhost/tasks/${PARENT_ID}/pending-batch`))
    const body = await res.json() as { eligible: boolean }
    expect(body.eligible).toBe(false)
  })

  test("unknown parent -> 404", async () => {
    const res = await app.fetch(new Request("http://localhost/tasks/does-not-exist/pending-batch"))
    expect(res.status).toBe(404)
  })
})

describe("dashboard rendering — grouped batch banner (specs/120 §7)", () => {
  test("GET /dashboard renders a batch banner when an eligible disjoint batch exists", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "C:\proj\Dockerfile"))
    tasks.set("c2", writeChild("c2", "a2", "C:\proj\.github\workflows\ci.yml"))

    const res = await app.fetch(new Request("http://localhost/dashboard"))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-batch-parent="parent-plan-1"')
    expect(html).toContain('data-batch-child="c1"')
    expect(html).toContain('data-batch-child="c2"')
    expect(html).toContain("Submit decisions")
    // Every existing per-row control is still present and unmodified —
    // the banner is additive, never a replacement.
    expect(html).toContain('data-decision-task="c1"')
    expect(html).toContain('data-decision-task="c2"')
  })

  test("GET /dashboard renders NO batch banner when targets overlap (falls back cleanly)", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "C:\proj\.gitignore"))
    tasks.set("c2", writeChild("c2", "a2", "C:\proj\.gitignore"))

    const res = await app.fetch(new Request("http://localhost/dashboard"))
    const html = await res.text()
    expect(html).not.toContain("batch-banner")
    // Individual controls are still there.
    expect(html).toContain('data-decision-task="c1"')
    expect(html).toContain('data-decision-task="c2"')
  })

  test("GET /dashboard renders no banner with a single pending write task (falls back to individual)", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "C:\proj\Dockerfile"))

    const res = await app.fetch(new Request("http://localhost/dashboard"))
    const html = await res.text()
    expect(html).not.toContain("batch-banner")
  })

  test("GET /dashboard/fragment includes batchHtml alongside the existing fields", async () => {
    setup()
    tasks.set("c1", writeChild("c1", "a1", "C:\proj\Dockerfile"))
    tasks.set("c2", writeChild("c2", "a2", "C:\proj\.github\workflows\ci.yml"))

    const res = await app.fetch(new Request("http://localhost/dashboard/fragment"))
    const body = await res.json() as { agentsHtml: string; rowsHtml: string; batchHtml: string }
    expect(typeof body.agentsHtml).toBe("string")
    expect(typeof body.rowsHtml).toBe("string")
    expect(body.batchHtml).toContain('data-batch-parent="parent-plan-1"')
  })
})
