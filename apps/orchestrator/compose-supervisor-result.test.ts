// specs/075-real-conversational-chat/spec.md §3 — a completed plan-task
// used to report only "Supervisor run completed after N dispatch(es).",
// discarding every child's real output. composeSupervisorResult()
// assembles the real per-step outcome instead. Pure and deterministic —
// no model, no dispatch — exercised directly against the exported
// `tasks` map, the same shared-module-state pattern this file's other
// tests already use.
import { afterEach, describe, expect, test } from "bun:test"
import { composeSupervisorResult, tasks, type OrchestratorTask } from "./index"

function planTask(planSteps: OrchestratorTask["planSteps"]): OrchestratorTask {
  return {
    id: "plan-1",
    text: "build and deploy",
    skill: "plan-task",
    status: "working",
    createdAt: new Date(),
    isPlan: true,
    planSteps,
    childTaskIds: (planSteps ?? []).flatMap((s) => (s.childTaskId ? [s.childTaskId] : [])),
  }
}

afterEach(() => {
  tasks.clear()
})

describe("composeSupervisorResult", () => {
  test("includes each dispatched step's skill, agent, status and real output", () => {
    tasks.set("child-1", {
      id: "child-1", text: "", skill: "git-status", assignedAgent: "devops-agent",
      status: "completed", result: "Branch: main\nStatus: clean", createdAt: new Date(),
    })
    const parent = planTask([
      { order: 1, skill: "git-status", description: "check git status", status: "completed", childTaskId: "child-1" },
    ])

    const result = composeSupervisorResult(parent, 1)

    expect(result).toContain("1. [git-status]")
    expect(result).toContain("devops-agent")
    expect(result).toContain("Branch: main")
    expect(result).toContain("Status: clean")
    expect(result).toContain("Supervisor run completed after 1 dispatch(es).")
  })

  test("a failed step's real error is included, not swallowed", () => {
    tasks.set("child-1", {
      id: "child-1", text: "", skill: "dockerize", assignedAgent: "devops-agent",
      status: "failed", error: "Rejected by user", createdAt: new Date(),
    })
    const parent = planTask([
      { order: 1, skill: "dockerize", description: "write a Dockerfile", status: "failed", childTaskId: "child-1" },
    ])

    const result = composeSupervisorResult(parent, 1)
    expect(result).toContain("failed: Rejected by user")
  })

  test("multiple steps preserve dispatch order", () => {
    tasks.set("child-1", { id: "child-1", text: "", skill: "analyze-project", assignedAgent: "devops-agent", status: "completed", result: "analysis text", createdAt: new Date() })
    tasks.set("child-2", { id: "child-2", text: "", skill: "git-status", assignedAgent: "devops-agent", status: "completed", result: "status text", createdAt: new Date() })
    const parent = planTask([
      { order: 1, skill: "analyze-project", description: "", status: "completed", childTaskId: "child-1" },
      { order: 2, skill: "git-status", description: "", status: "completed", childTaskId: "child-2" },
    ])

    const result = composeSupervisorResult(parent, 2)
    expect(result.indexOf("analysis text")).toBeLessThan(result.indexOf("status text"))
  })

  test("a step with no dispatched child yet is reported honestly, not silently dropped", () => {
    const parent = planTask([{ order: 1, skill: "git-status", description: "", status: "pending" }])
    const result = composeSupervisorResult(parent, 0)
    expect(result).toContain("not dispatched")
  })

  test("no plan steps at all still reports the trailing dispatch-count line", () => {
    const parent = planTask([])
    const result = composeSupervisorResult(parent, 0)
    expect(result).toBe("Supervisor run completed after 0 dispatch(es).")
  })

  // specs/102-orchestrator-readonly-project-inspection/spec.md — with no
  // projectContext supplied, behavior is unchanged (asserted above);
  // these two cover the new branch specifically.
  test("zero dispatches WITH projectContext surfaces the real inspection instead of the generic line", () => {
    const parent = planTask([])
    const result = composeSupervisorResult(parent, 0, "=== Target Project ===\nC:\\proj\nreal analysis content")
    expect(result).toContain("No agent dispatch was needed")
    expect(result).toContain("real analysis content")
    expect(result).not.toBe("Supervisor run completed after 0 dispatch(es).")
  })

  test("a NON-zero dispatch count ignores projectContext even when supplied — a real dispatch always speaks for itself", () => {
    tasks.set("child-1", {
      id: "child-1", text: "", skill: "git-status", assignedAgent: "devops-agent",
      status: "completed", result: "Branch: main", createdAt: new Date(),
    })
    const parent = planTask([
      { order: 1, skill: "git-status", description: "", status: "completed", childTaskId: "child-1" },
    ])
    const result = composeSupervisorResult(parent, 1, "=== Target Project ===\nshould not appear")
    expect(result).toBe("1. [git-status] devops-agent — Branch: main\n\nSupervisor run completed after 1 dispatch(es).")
    expect(result).not.toContain("should not appear")
  })

  test("bound by the existing 64 KiB TASK_RESULT_MAX_BYTES path, same as every other bounded result", () => {
    tasks.set("child-1", {
      id: "child-1", text: "", skill: "run-tests", assignedAgent: "testing-agent",
      status: "completed", result: "x".repeat(100_000), createdAt: new Date(),
    })
    const parent = planTask([
      { order: 1, skill: "run-tests", description: "", status: "completed", childTaskId: "child-1" },
    ])

    const result = composeSupervisorResult(parent, 1)
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(64 * 1024)
    expect(result).toContain("[Result truncated at 64 KiB]")
  })
})
