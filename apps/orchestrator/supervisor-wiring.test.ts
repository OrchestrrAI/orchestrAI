// specs/028-orchestrator-langgraph-supervisor/spec.md — Phase 3 tests,
// updated for specs/038-supervisor-default-and-planning-retirement Phase 1
// (the supervisor became the DEFAULT plan-task planner) and then for
// specs/051-planning-retirement-and-required-key/spec.md (the supervisor
// is now the ONLY plan-task planner, unconditionally — Planning Agent is
// deleted, ORCHESTRAI_ORCHESTRATOR_GRAPH is inert, and a missing/invalid
// key fails the task closed with no fallback of any kind).
// These exercise the REAL app.post("/") handler (Hono's own in-process
// app.request(), no port bound) — unlike supervisor-graph.test.ts, this is
// specifically about the wiring/branch, not the graph's internal safety
// mechanisms (already covered there). fetch is mocked; no real agent
// process, no real LLM call, no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app, registry, tasks, __setTestRouterModel, type RegisteredAgent } from "./index"
import { KeywordRouterFake } from "./keyword-router-fake"

function agent(name: string, skillIds: string[]): RegisteredAgent {
  return {
    card: {
      name,
      description: "",
      url: `http://localhost:0/${name}`,
      version: "1.0.0",
      skills: skillIds.map((id) => ({ id, name: id, description: "" })),
    },
    url: `http://localhost:0/${name}`,
    status: "online",
    lastSeen: new Date(),
  }
}

let capturedRequests: { url: string; body: Record<string, unknown> | null }[] = []
let originalFetch: typeof fetch
let originalGraphFlag: string | undefined
let originalApiKey: string | undefined
let originalProvider: string | undefined

beforeEach(() => {
  registry.clear()
  tasks.clear()
  capturedRequests = []
  originalFetch = globalThis.fetch
  originalGraphFlag = process.env.ORCHESTRAI_ORCHESTRATOR_GRAPH
  originalApiKey = process.env.ORCHESTRAI_LLM_API_KEY
  originalProvider = process.env.ORCHESTRAI_LLM_PROVIDER
  delete process.env.ORCHESTRAI_ORCHESTRATOR_GRAPH
  delete process.env.ORCHESTRAI_LLM_API_KEY
  delete process.env.ORCHESTRAI_LLM_PROVIDER
  // specs/065 — this suite is about dispatch WIRING, not routing: it
  // relies on "git status" etc. resolving deterministically to their
  // own skill. The keyword tier that used to guarantee that is gone,
  // so inject a fake router that reproduces the old keyword decisions
  // — hermetic, no network call (the fake key some tests below set
  // would otherwise trigger a real, slow one).
  __setTestRouterModel(new KeywordRouterFake())

  // @ts-expect-error — test double, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    capturedRequests.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
    if (url.includes("/.well-known/agent.json")) {
      return new Response(JSON.stringify({ name: "unused", description: "", url: "", version: "1.0.0", skills: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ id: "orch-x", status: "submitted" }), { status: 200 })
  }
})

afterEach(() => {
  __setTestRouterModel(null)
  globalThis.fetch = originalFetch
  registry.clear()
  tasks.clear()
  if (originalGraphFlag === undefined) delete process.env.ORCHESTRAI_ORCHESTRATOR_GRAPH
  else process.env.ORCHESTRAI_ORCHESTRATOR_GRAPH = originalGraphFlag
  if (originalApiKey === undefined) delete process.env.ORCHESTRAI_LLM_API_KEY
  else process.env.ORCHESTRAI_LLM_API_KEY = originalApiKey
  if (originalProvider === undefined) delete process.env.ORCHESTRAI_LLM_PROVIDER
  else process.env.ORCHESTRAI_LLM_PROVIDER = originalProvider
})

async function waitForTaskStatus(taskId: string, notStatus: string, maxMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const t = tasks.get(taskId)
    if (t && t.status !== notStatus) return
    await Bun.sleep(10)
  }
}

describe("direct-routed requests never reach the graph, opted out or not", () => {
  test("a direct-routed request (git status) is sent to its agent normally, even with the supervisor enabled", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))
    process.env.ORCHESTRAI_ORCHESTRATOR_GRAPH = "1"
    process.env.ORCHESTRAI_LLM_API_KEY = "unused-should-never-be-read-for-this-request"

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "git status at C:\\some\\project" }),
    })
    const json = (await res.json()) as { id: string; assignedAgent: string }

    await waitForTaskStatus(json.id, "assigned")

    expect(json.assignedAgent).toBe("devops-agent")
    // The request genuinely went out over the network layer to devops-agent
    // — proof the graph branch was never entered, not just that the
    // response claimed so.
    const sentToDevops = capturedRequests.some((r) => r.url.includes("devops-agent") && r.body?.selectedSkill === "git-status")
    expect(sentToDevops).toBe(true)
  })
})

describe("specs/038 Phase 1 — the supervisor is the default plan-task planner", () => {
  test("flag genuinely unset, a real provider key configured — a plan-task request runs through the supervisor by default", async () => {
    // ORCHESTRAI_ORCHESTRATOR_GRAPH deliberately left unset by beforeEach —
    // this is the load-bearing case: no flag needs to be set at all any
    // more for the supervisor to run.
    process.env.ORCHESTRAI_LLM_API_KEY = "fake-key"

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "build and deploy my bun app" }),
    })
    const json = (await res.json()) as { id: string; assignedAgent: string }

    expect(json.assignedAgent).toBe("orchestrator-supervisor")
  })

  // specs/051-planning-retirement-and-required-key/spec.md Phase 4 — a
  // REAL bug, found live against the compiled binary, not by this suite:
  // every test in this file used to call `registry.set("planning-agent",
  // agent("planning-agent", ["plan-task"]))` before dispatching a
  // plan-task request — a leftover from when Planning Agent's own
  // registry entry was what let `findAgentForSkill("plan-task")` succeed
  // (the supervisor dispatch was reached THROUGH that lookup, not instead
  // of it). Once Planning was actually deleted (this same spec, Phase 4),
  // every real plan-task request failed with "No agent found for skill:
  // plan-task" before ever reaching the supervisor — invisible here
  // because this file kept manufacturing a fake agent to satisfy exactly
  // that lookup. Fixed in apps/orchestrator/index.ts by deciding
  // "plan-task" before `findAgentForSkill()` is ever called, mirroring
  // how "suggest-agents" is already handled. This test is the regression
  // guard: a totally empty registry, no fake agent of any kind.
  test("plan-task succeeds with a completely empty agent registry — the supervisor is not a registry-discovered agent", async () => {
    expect(registry.size).toBe(0)
    process.env.ORCHESTRAI_LLM_API_KEY = "fake-key"

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "build and deploy my bun app" }),
    })
    const json = (await res.json()) as { id: string; assignedAgent: string; status: string }

    expect(json.status).not.toBe("failed")
    expect(json.assignedAgent).toBe("orchestrator-supervisor")
  })

  // specs/051-planning-retirement-and-required-key/spec.md Phase 3 — this
  // used to prove ORCHESTRAI_ORCHESTRATOR_GRAPH=0 was a genuine opt-out
  // that reached Planning Agent even with a valid key. That opt-out no
  // longer exists (isOrchestratorGraphEnabled() was deleted along with
  // the fallback it gated) — plan-task always reaches the supervisor now,
  // and the variable itself does nothing. This proves exactly that,
  // rather than deleting the case outright: a real regression here would
  // be the flag silently starting to matter again.
  test("ORCHESTRAI_ORCHESTRATOR_GRAPH=0 is now inert — plan-task still reaches the supervisor", async () => {
    process.env.ORCHESTRAI_ORCHESTRATOR_GRAPH = "0"
    process.env.ORCHESTRAI_LLM_API_KEY = "fake-key"

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "build and deploy my bun app" }),
    })
    const json = (await res.json()) as { id: string; assignedAgent: string }

    expect(json.assignedAgent).toBe("orchestrator-supervisor")
  })
})

// specs/051-planning-retirement-and-required-key/spec.md Phase 3 — this
// describe block used to prove a genuinely absent key fell back to
// Planning Agent's deterministic path (specs/038 Phase 1's own, deliberate
// deviation from specs/028). That fallback is deleted along with the
// agent it routed to: a missing key now fails the task closed, the same
// "not a silent fallback" precedent every other LLM checkpoint in this
// codebase already established, and the one specs/038 explicitly opted
// out of for exactly this case. This is the moment that opt-out itself
// gets retired.
describe("specs/051 Phase 3 — a missing or invalid key fails plan-task closed", () => {
  test("no ORCHESTRAI_LLM_API_KEY at all — fails closed", async () => {
    // Deliberately nothing configured — the exact case that used to fall
    // back silently before this phase. Registry is empty too — see the
    // Phase 4 regression test above for why that specifically matters now.

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "build and deploy my bun app" }),
    })
    const json = (await res.json()) as { id: string; assignedAgent: string }

    expect(json.assignedAgent).toBe("orchestrator-supervisor")
    // The missing-key branch fails synchronously, before ever setting
    // "working" — so the real transition here is assigned -> failed
    // directly, not assigned -> working -> failed like the misconfigured
    // case just below. Waiting on "working" to differ would return
    // immediately without ever having waited (status starts as
    // "assigned", already not "working").
    await waitForTaskStatus(json.id, "assigned")

    const finalTask = tasks.get(json.id)
    expect(finalTask?.status).toBe("failed")
    expect(finalTask?.error).toContain("No provider key configured")
  })

  test("an invalid ORCHESTRAI_LLM_PROVIDER is a real misconfiguration, distinct from a missing key", async () => {
    process.env.ORCHESTRAI_LLM_API_KEY = "fake-key"
    process.env.ORCHESTRAI_LLM_PROVIDER = "not-a-real-provider"

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "build and deploy my bun app" }),
    })
    const json = (await res.json()) as { id: string }

    await waitForTaskStatus(json.id, "assigned")
    await waitForTaskStatus(json.id, "working")

    const finalTask = tasks.get(json.id)
    expect(finalTask?.status).toBe("failed")
    expect(finalTask?.error).toContain("misconfigured")
  })
})
