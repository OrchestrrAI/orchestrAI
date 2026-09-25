// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md
//
// Proves the Orchestrator's own dispatch envelope carries an authoritative
// selectedSkill regardless of what a plan step's LLM-authored description
// text says — this is the exact regression from 026/029's live verification
// evidence (a git-status step's description mentioned "Dockerfile" and a
// receiving agent's own text-based detectSkill() flipped it to dockerize).
// fetch is mocked; no real agent process or network call is involved.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  buildCapabilitySnapshot,
  dispatchPlanStep,
  findAgentForSkill,
  registry,
  sendTaskToAgent,
  tasks,
  INSPECTION_FALLBACK_SKILLS,
  __setTestOrchestratorMcpClient,
  type OrchestratorTask,
  type PlanStep,
  type RegisteredAgent,
} from "./index"
import type { OrchestraiMcpClient } from "../../packages/shared/mcp-client"
import { buildPlanStepText, splitPlanStepText } from "../../packages/shared/plan-step-text"

function agent(name: string, skillIds: string[], status: "online" | "offline" = "online"): RegisteredAgent {
  return {
    card: {
      name,
      description: "",
      url: `http://localhost:0/${name}`,
      version: "1.0.0",
      skills: skillIds.map((id) => ({ id, name: id, description: "" })),
    },
    url: `http://localhost:0/${name}`,
    status,
    lastSeen: new Date(),
  }
}

let capturedBodies: Record<string, unknown>[] = []
let originalFetch: typeof fetch

beforeEach(() => {
  registry.clear()
  tasks.clear()
  capturedBodies = []
  originalFetch = globalThis.fetch
  // @ts-expect-error — test double, narrower than the real fetch signature
  globalThis.fetch = async (_url: string, init?: RequestInit) => {
    if (init?.body) capturedBodies.push(JSON.parse(init.body as string))
    return new Response(JSON.stringify({ id: "orch-x", status: "submitted" }), { status: 200 })
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  registry.clear()
  tasks.clear()
  __setTestOrchestratorMcpClient(null)
})

// specs/112-plan-step-no-agent-inspection-fallback/spec.md — mirrors
// orchestrator-inspection.test.ts's own fakeClient() helper exactly (kept
// as a local, independent copy per this codebase's established
// per-file-test-helper convention, not a shared import).
function fakeMcpClient(resultsByTool: Record<string, string | Error>): OrchestraiMcpClient {
  const client = {
    async callTool(toolName: string, _args: Record<string, unknown>): Promise<string> {
      const result = resultsByTool[toolName]
      if (result === undefined) throw new Error(`no mock result for ${toolName}`)
      if (result instanceof Error) throw result
      return result
    },
  }
  return client as unknown as OrchestraiMcpClient
}

async function waitFor(predicate: () => boolean, maxMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (predicate()) return
    await Bun.sleep(10)
  }
}

describe("sendTaskToAgent — envelope construction (specs/030)", () => {
  test("embeds selectedSkill when provided", async () => {
    const a = agent("devops-agent", ["git-status"])
    await sendTaskToAgent(a, "check status", "t1", { selectedSkill: "git-status" })
    expect(capturedBodies[0].selectedSkill).toBe("git-status")
  })

  test("omits selectedSkill entirely when absent — legacy-compatible envelope", async () => {
    const a = agent("devops-agent", ["git-status"])
    await sendTaskToAgent(a, "check status", "t1")
    expect("selectedSkill" in capturedBodies[0]).toBe(false)
  })

  test("embeds capabilities only when provided", async () => {
    const a = agent("some-agent", ["plan-task"])
    const capabilities = [{ agentName: "devops-agent", skillId: "git-status" }]
    await sendTaskToAgent(a, "plan it", "t1", { selectedSkill: "plan-task", capabilities })
    expect(capturedBodies[0].capabilities).toEqual(capabilities)
  })

  test("omits capabilities when undefined even if selectedSkill is present", async () => {
    const a = agent("devops-agent", ["git-status"])
    await sendTaskToAgent(a, "check status", "t1", { selectedSkill: "git-status" })
    expect("capabilities" in capturedBodies[0]).toBe(false)
  })
})

describe("dispatchPlanStep — exact live regression (specs/030)", () => {
  test("a git-status step whose description mentions Dockerfile still transmits selectedSkill: git-status", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status", "dockerize"]))
    const parentTask: OrchestratorTask = {
      id: "parent-1", text: "set up my repo", skill: "plan-task",
      status: "assigned", createdAt: new Date(), isPlan: true,
    }
    const step: PlanStep = {
      order: 1,
      skill: "git-status",
      // The exact shape of the live failure: the model's own description
      // mentions an observed Dockerfile while the step itself is git-status.
      description: "Check git status — note the project already has a Dockerfile present",
    }

    await dispatchPlanStep(step, parentTask)

    expect(capturedBodies).toHaveLength(1)
    expect(capturedBodies[0].selectedSkill).toBe("git-status")
    expect(capturedBodies[0].selectedSkill).not.toBe("dockerize")
  })

  test("a dockerize step whose description mentions only read-only words still transmits selectedSkill: dockerize", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status", "dockerize"]))
    const parentTask: OrchestratorTask = {
      id: "parent-2", text: "prepare for production", skill: "plan-task",
      status: "assigned", createdAt: new Date(), isPlan: true,
    }
    const step: PlanStep = {
      order: 1,
      skill: "dockerize",
      description: "Build the image — git status is currently clean",
    }

    await dispatchPlanStep(step, parentTask)

    expect(capturedBodies[0].selectedSkill).toBe("dockerize")
  })

  test("stale/offline agent, non-fallback skill, fails closed — no send occurs at all", async () => {
    // dockerize deliberately, not git-status — specs/112 gave
    // dispatchPlanStep() a real inspection fallback for the narrow
    // INSPECTION_FALLBACK_SKILLS set (analyze-project, git-status), so
    // this test's own original "fails closed" claim needs a skill
    // outside that set to still hold unchanged. See the dedicated
    // specs/112 describe block below for the new fallback behavior.
    registry.set("devops-agent", agent("devops-agent", ["dockerize"], "offline"))
    const parentTask: OrchestratorTask = {
      id: "parent-3", text: "dockerize my app", skill: "plan-task",
      status: "assigned", createdAt: new Date(), isPlan: true,
    }
    const step: PlanStep = { order: 1, skill: "dockerize", description: "Build the image" }

    const childId = await dispatchPlanStep(step, parentTask)

    expect(childId).toBeNull()
    expect(capturedBodies).toHaveLength(0)
  })

  test("a skill removed from the registry between plan text and dispatch fails closed, never reroutes", async () => {
    // No agent registered for "audit-dependencies" at all — simulates the
    // owning agent having gone offline/unregistered the skill since the
    // plan was authored.
    const parentTask: OrchestratorTask = {
      id: "parent-4", text: "audit deps", skill: "plan-task",
      status: "assigned", createdAt: new Date(), isPlan: true,
    }
    const step: PlanStep = { order: 1, skill: "audit-dependencies", description: "Audit dependencies" }

    const childId = await dispatchPlanStep(step, parentTask)

    expect(childId).toBeNull()
    expect(capturedBodies).toHaveLength(0)
  })
})

// specs/137 — the child text is the step, then the marked parent request.
describe("dispatchPlanStep — child text carries the step and the marked request (specs/137)", () => {
  test("the dispatched text splits back into exactly the step and the parent request", async () => {
    registry.set("devops-agent", agent("devops-agent", ["create-gitignore"]))
    const parentTask: OrchestratorTask = {
      id: "parent-137", text: "edit two files — and also create a .gitignore", skill: "plan-task",
      status: "assigned", createdAt: new Date(), isPlan: true,
    }
    await dispatchPlanStep({ order: 1, skill: "create-gitignore", description: "Generate .gitignore for bun" }, parentTask)
    const message = capturedBodies[0]!.message as { parts: { text: string }[] }
    const text = message.parts[0]!.text
    expect(text).toBe(buildPlanStepText("create-gitignore", "Generate .gitignore for bun", parentTask.text))
    expect(splitPlanStepText(text)).toEqual({ step: "create-gitignore: Generate .gitignore for bun", context: parentTask.text })
  })
})

describe("dispatchPlanStep — no-agent inspection fallback (specs/112)", () => {
  test("a fallback-eligible skill with no online agent synthesizes a real child task, dispatched immediately", async () => {
    // fetchProjectInspection() (called internally regardless of which
    // single skill was requested) needs both tool results present to
    // succeed at all — matching orchestrator-inspection.test.ts's own
    // fakeClient() examples.
    __setTestOrchestratorMcpClient(fakeMcpClient({ analyze_project: "x", git_status: "branch: main, clean" }))
    const parentTask: OrchestratorTask = {
      id: "parent-5", text: "check status at C:/proj", skill: "plan-task",
      status: "assigned", createdAt: new Date(), isPlan: true,
      planSteps: [], childTaskIds: [],
    }
    const step: PlanStep = { order: 1, skill: "git-status", description: "Check status" }

    const childId = await dispatchPlanStep(step, parentTask)
    if (!childId) throw new Error("expected a real childId, got null")

    // Synchronous effects — no send to any agent, but a real child exists.
    expect(capturedBodies).toHaveLength(0)
    expect(step.childTaskId).toBe(childId)
    expect(step.status).toBe("dispatched")
    const child = tasks.get(childId)
    expect(child?.assignedAgent).toBe("orchestrator")
    expect(child?.status).toBe("working")

    // Asynchronous resolution — the fire-and-forget inspection call.
    await waitFor(() => tasks.get(childId)?.status !== "working")
    const resolved = tasks.get(childId)
    expect(resolved?.status).toBe("completed")
    expect(resolved?.result).toBe("branch: main, clean")
  })

  test("a fallback-eligible skill whose inspection call itself fails resolves the child as failed, not a silent hang", async () => {
    __setTestOrchestratorMcpClient(fakeMcpClient({ analyze_project: "x", git_status: new Error("MCP unreachable") }))
    const parentTask: OrchestratorTask = {
      id: "parent-6", text: "check status at C:/proj", skill: "plan-task",
      status: "assigned", createdAt: new Date(), isPlan: true,
      planSteps: [], childTaskIds: [],
    }
    const step: PlanStep = { order: 1, skill: "git-status", description: "Check status" }

    const childId = await dispatchPlanStep(step, parentTask)
    if (!childId) throw new Error("expected a real childId, got null")

    await waitFor(() => tasks.get(childId)?.status !== "working")
    const resolved = tasks.get(childId)
    expect(resolved?.status).toBe("failed")
    expect(resolved?.error).toBe("No agent found for skill: git-status")
  })

  test("both fallback skill ids are exactly the set specs/102 already defined — no widening in this spec", () => {
    expect(INSPECTION_FALLBACK_SKILLS.has("analyze-project")).toBe(true)
    expect(INSPECTION_FALLBACK_SKILLS.has("git-status")).toBe(true)
    expect(INSPECTION_FALLBACK_SKILLS.size).toBe(2)
  })
})

describe("findAgentForSkill (specs/030 baseline, unchanged behavior)", () => {
  test("only matches online agents", () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"], "offline"))
    expect(findAgentForSkill("git-status")).toBeNull()
  })
})

describe("buildCapabilitySnapshot — live registry mapping (specs/030)", () => {
  // specs/051 — plan-task is the Orchestrator's own internally-handled
  // skill; normalizeAgentCapabilities() still excludes it by skill id
  // defensively. specs/065-llm-only-skill-routing/spec.md un-excluded
  // "suggest-agents" AND made buildCapabilitySnapshot() always append a
  // synthetic {agentName:"orchestrator", skillId:"suggest-agents"}
  // entry so the router (now the only routing tier) can name it.
  test("excludes offline agents and plan-task; always carries the Orchestrator's own suggest-agents entry", () => {
    registry.set("some-agent", agent("some-agent", ["plan-task", "audit-dependencies"]))
    registry.set("devops-agent", agent("devops-agent", ["git-status", "dockerize"]))
    registry.set("testing-agent", agent("testing-agent", ["run-tests"], "offline"))

    const snapshot = buildCapabilitySnapshot()

    expect(snapshot).not.toBeNull()
    const agentNames = (snapshot ?? []).map((c) => c.agentName)
    expect(agentNames).not.toContain("testing-agent") // offline
    const pairs = (snapshot ?? []).map((c) => `${c.agentName}:${c.skillId}`)
    expect(pairs).not.toContain("some-agent:plan-task") // still excluded by id
    expect(pairs).toContain("devops-agent:git-status")
    expect(pairs).toContain("devops-agent:dockerize")
    expect(pairs).toContain("some-agent:audit-dependencies")
    expect(pairs).toContain("orchestrator:suggest-agents") // specs/065 — always present
  })

  test("returns null (not a fallback catalog) when ownership is ambiguous", () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))
    registry.set("rogue-agent", agent("rogue-agent", ["git-status"]))

    expect(buildCapabilitySnapshot()).toBeNull()
  })

  test("with only excluded/empty agent skills, the snapshot still carries the Orchestrator's own suggest-agents entry — no longer null", () => {
    // specs/065 — buildCapabilitySnapshot() always appends the
    // orchestrator's own entry, so an agent advertising only excluded
    // skills no longer produces a null snapshot the way it did before.
    registry.set("some-agent", agent("some-agent", ["plan-task"]))
    // specs/121 — the synthetic entry now carries a short description too.
    const snapshot = buildCapabilitySnapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot?.[0]?.agentName).toBe("orchestrator")
    expect(snapshot?.[0]?.skillId).toBe("suggest-agents")
  })
})
