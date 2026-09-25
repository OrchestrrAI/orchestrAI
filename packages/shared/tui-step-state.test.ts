import { describe, expect, test } from "bun:test"
import { reducePlanStepEvent, type PlanStepsByRun } from "./tui-step-state"

describe("bounded TUI plan-step state", () => {
  test("pairs STEP_STARTED and STEP_FINISHED by run and stable step name", () => {
    let state: PlanStepsByRun = {}
    state = reducePlanStepEvent(state, {
      type: "STEP_STARTED",
      runId: "run-1",
      stepName: "Analyze project",
      timestamp: 10,
    })
    expect(state["run-1"]["Analyze project"].outcome).toBe("running")

    state = reducePlanStepEvent(state, {
      type: "STEP_FINISHED",
      runId: "run-1",
      stepName: "Analyze project",
      outcome: "completed",
      timestamp: 20,
    })
    expect(state["run-1"]["Analyze project"]).toEqual({
      key: "Analyze project",
      name: "Analyze project",
      outcome: "completed",
      timestamp: 20,
    })
  })

  test("retains only the newest bounded step history per run", () => {
    let state: PlanStepsByRun = {}
    for (let index = 1; index <= 4; index += 1) {
      state = reducePlanStepEvent(state, {
        type: "STEP_STARTED",
        runId: "run-1",
        stepName: `Step ${index}`,
        timestamp: index,
      }, 3)
    }

    expect(Object.keys(state["run-1"])).toEqual(["Step 2", "Step 3", "Step 4"])
  })

  test("ignores invalid or unrelated events", () => {
    const state: PlanStepsByRun = {}
    expect(reducePlanStepEvent(state, { type: "TOOL_CALL_START" })).toBe(state)
    expect(reducePlanStepEvent(state, { type: "STEP_STARTED", runId: "", stepName: "x" })).toBe(state)
  })
})
