// specs/136-orchestrator-task-and-agent-metadata/spec.md — agent liveness:
// the tracker in isolation (injected probe and clock), the real HTTP probe
// against a local server, and the Orchestrator wiring (registry, the
// capability lookup, and the endpoints that expose the new fields).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  AGENT_OFFLINE_AFTER_FAILURES,
  AgentLivenessTracker,
  probeAgentHealth,
  type LivenessAgent,
} from "./agent-liveness"
import {
  app,
  auditTaskIdsForQuery,
  checkAgentLiveness,
  findAgentForSkill,
  registry,
  taskConversations,
  tasks,
  type OrchestratorTask,
  type RegisteredAgent,
} from "./index"

function agent(status: "online" | "offline" = "online"): LivenessAgent {
  return { url: "http://agent.test", status, lastSeen: new Date(0) }
}

describe("AgentLivenessTracker", () => {
  test("a reachable agent's lastSeen advances and its failure count resets", async () => {
    let reachable = false
    const tracker = new AgentLivenessTracker(async () => reachable, () => new Date(5000))
    const a = agent()
    expect(await tracker.check("a", a)).toBe("failed")
    expect(tracker.consecutiveFailures("a")).toBe(1)
    reachable = true
    expect(await tracker.check("a", a)).toBe("seen")
    expect(a.lastSeen.getTime()).toBe(5000)
    expect(tracker.consecutiveFailures("a")).toBe(0)
    expect(a.status).toBe("online")
  })

  test(`goes offline only after ${AGENT_OFFLINE_AFTER_FAILURES} consecutive failures`, async () => {
    const tracker = new AgentLivenessTracker(async () => false)
    const a = agent()
    expect(await tracker.check("a", a)).toBe("failed")
    expect(await tracker.check("a", a)).toBe("failed")
    expect(a.status).toBe("online")
    expect(await tracker.check("a", a)).toBe("went-offline")
    expect(a.status).toBe("offline")
    expect(tracker.consecutiveFailures("a")).toBe(0)
  })

  test("a probe that throws counts as a failure, never an exception", async () => {
    const tracker = new AgentLivenessTracker(async () => {
      throw new Error("boom")
    })
    expect(await tracker.check("a", agent())).toBe("failed")
  })

  test("an offline agent is skipped (re-discovery owns recovery)", async () => {
    let probed = 0
    const tracker = new AgentLivenessTracker(async () => (probed++, true))
    expect(await tracker.check("a", agent("offline"))).toBe("skipped")
    expect(probed).toBe(0)
  })

  test("checks for one agent never overlap", async () => {
    let release: (value: boolean) => void = () => {}
    const tracker = new AgentLivenessTracker(() => new Promise<boolean>((resolve) => (release = resolve)))
    const a = agent()
    const first = tracker.check("a", a)
    expect(await tracker.check("a", a)).toBe("skipped")
    release(true)
    expect(await first).toBe("seen")
  })
})

describe("probeAgentHealth (real HTTP)", () => {
  let server: ReturnType<typeof Bun.serve>
  let mode: "ready" | "not-ready" | "error" = "ready"
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        mode === "error"
          ? new Response("down", { status: 500 })
          : Response.json({ status: "ok", ready: mode === "ready" }),
    })
  })
  afterAll(() => server.stop(true))

  test("2xx is reachable — including ready:false (a dependency hiccup is not offline)", async () => {
    mode = "ready"
    expect(await probeAgentHealth(`http://localhost:${server.port}`)).toBe(true)
    mode = "not-ready"
    expect(await probeAgentHealth(`http://localhost:${server.port}`)).toBe(true)
  })

  test("a non-2xx answer or an unreachable port is not reachable", async () => {
    mode = "error"
    expect(await probeAgentHealth(`http://localhost:${server.port}`)).toBe(false)
    expect(await probeAgentHealth("http://127.0.0.1:1", 500)).toBe(false)
  })
})

describe("Orchestrator wiring", () => {
  const NAME = "liveness-test-agent"
  afterEach(() => {
    registry.delete(NAME)
    tasks.delete("task-conv-1")
    tasks.delete("task-plain-1")
    taskConversations.delete("task-conv-1")
  })

  test("an agent failing its checks leaves the capability lookup and /agents shows it offline", async () => {
    const entry: RegisteredAgent = {
      card: { name: NAME, description: "", url: "http://127.0.0.1:1", version: "1", skills: [{ id: "liveness-test-skill", name: "x", description: "x" }] },
      url: "http://127.0.0.1:1",
      status: "online",
      lastSeen: new Date(0),
    } as RegisteredAgent
    registry.set(NAME, entry)
    expect(findAgentForSkill("liveness-test-skill")?.card.name).toBe(NAME)

    const tracker = new AgentLivenessTracker(async (url) => url !== "http://127.0.0.1:1")
    for (let i = 0; i < AGENT_OFFLINE_AFTER_FAILURES; i++) await checkAgentLiveness(tracker)

    expect(registry.get(NAME)?.status).toBe("offline")
    expect(findAgentForSkill("liveness-test-skill")).toBeNull()
    const body = (await (await app.request("/agents")).json()) as { agents: { name: string; status: string }[] }
    expect(body.agents.find((a) => a.name === NAME)?.status).toBe("offline")
  })

  test("GET /tasks and GET /tasks/:id carry conversationId (null when not chat-dispatched)", async () => {
    const base = { text: "t", skill: "git-status", status: "completed", createdAt: new Date() } as OrchestratorTask
    tasks.set("task-conv-1", { ...base, id: "task-conv-1" })
    tasks.set("task-plain-1", { ...base, id: "task-plain-1" })
    taskConversations.set("task-conv-1", "conv-abc")

    const list = (await (await app.request("/tasks")).json()) as { tasks: { id: string; conversationId: string | null }[] }
    expect(list.tasks.find((t) => t.id === "task-conv-1")?.conversationId).toBe("conv-abc")
    expect(list.tasks.find((t) => t.id === "task-plain-1")?.conversationId).toBeNull()

    const one = (await (await app.request("/tasks/task-conv-1")).json()) as { conversationId: string | null }
    expect(one.conversationId).toBe("conv-abc")
  })

  test("audit ids for a task: its own id plus orch-<id>; an orch- id matches only itself", () => {
    expect(auditTaskIdsForQuery("task-1")).toEqual(["task-1", "orch-task-1"])
    expect(auditTaskIdsForQuery("orch-task-1")).toEqual(["orch-task-1"])
  })
})
