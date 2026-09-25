// specs/027-ag-ui-core-adoption/spec.md — validation-failure policy.
//
// A schema disagreement must never take down the live stream a demo
// depends on: the event is logged (loud) then still delivered to every
// subscriber (open). This is exercised against the real emit()/
// subscribeToEvents() pair, not a reimplementation of the policy.
import { describe, expect, test } from "bun:test"
import { emit, subscribeToEvents } from "./index"
import type { AgUiEvent } from "../../packages/shared/ag-ui-events"

describe("AG-UI emit() validation-failure policy", () => {
  test("a malformed event is still delivered to subscribers, and the failure is logged", () => {
    const received: AgUiEvent[] = []
    const unsubscribe = subscribeToEvents((event) => received.push(event))

    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    }

    try {
      // The old specs/021 bare-string RUN_FINISHED.outcome shape — invalid
      // against the official RunFinishedEventSchema this runtime now
      // validates against.
      const malformed = {
        type: "RUN_FINISHED",
        threadId: "task-policy-1",
        runId: "task-policy-1",
        outcome: "success",
        timestamp: Date.now(),
      } as unknown as AgUiEvent

      emit(malformed)

      // Fail-open: the event still reached the subscriber unchanged.
      expect(received).toEqual([malformed])
      // Fail-loud: the failure was logged, naming the event type.
      expect(warnings.some((w) => w.includes("RUN_FINISHED"))).toBe(true)
    } finally {
      console.warn = originalWarn
      unsubscribe()
    }
  })

  test("a well-formed event validates cleanly and produces no warning", () => {
    const received: AgUiEvent[] = []
    const unsubscribe = subscribeToEvents((event) => received.push(event))

    const originalWarn = console.warn
    let warned = false
    console.warn = () => {
      warned = true
    }

    try {
      const valid: AgUiEvent = {
        type: "RUN_STARTED",
        threadId: "task-policy-2",
        runId: "task-policy-2",
        timestamp: Date.now(),
      }
      emit(valid)
      expect(received).toEqual([valid])
      expect(warned).toBe(false)
    } finally {
      console.warn = originalWarn
      unsubscribe()
    }
  })
})
