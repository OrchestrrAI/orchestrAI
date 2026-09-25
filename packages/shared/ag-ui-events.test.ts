// specs/027-ag-ui-core-adoption/spec.md
//
// Compatibility matrix and negative-test evidence for adopting @ag-ui/core's
// real runtime schemas. Every event shape apps/orchestrator/index.ts
// actually constructs is validated here — a regression in either this
// runtime's own event construction or a future @ag-ui/core upgrade fails
// this suite, which is how "runtime validation, not just types" is proven
// rather than asserted.
import { describe, expect, test } from "bun:test"
import {
  validateAgUiEvent,
  type AgUiEvent,
  type CustomEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type RunErrorEvent,
  type StepStartedEvent,
  type StepFinishedEvent,
  type ToolCallStartEvent,
  type ToolCallResultEvent,
  type StateSnapshotEvent,
} from "./ag-ui-events"

const TS = 1_700_000_000_000

describe("compatibility matrix — all nine emitted event types validate", () => {
  const cases: Array<[string, AgUiEvent]> = [
    [
      "RUN_STARTED",
      { type: "RUN_STARTED", threadId: "task-1", runId: "task-1", timestamp: TS } satisfies RunStartedEvent,
    ],
    [
      "RUN_FINISHED",
      {
        type: "RUN_FINISHED",
        threadId: "task-1",
        runId: "task-1",
        outcome: { type: "success" },
        timestamp: TS,
      } satisfies RunFinishedEvent,
    ],
    [
      "RUN_ERROR",
      { type: "RUN_ERROR", threadId: "task-1", runId: "task-1", message: "boom", timestamp: TS } satisfies RunErrorEvent,
    ],
    [
      "STEP_STARTED",
      { type: "STEP_STARTED", runId: "task-1", stepName: "dockerize", timestamp: TS } satisfies StepStartedEvent,
    ],
    [
      "STEP_FINISHED",
      {
        type: "STEP_FINISHED",
        runId: "task-1",
        stepName: "dockerize",
        outcome: "completed",
        timestamp: TS,
      } satisfies StepFinishedEvent,
    ],
    [
      "TOOL_CALL_START",
      {
        type: "TOOL_CALL_START",
        runId: "task-1",
        toolCallId: "call-1",
        toolCallName: "git_status",
        caller: "devops-agent",
        timestamp: TS,
      } satisfies ToolCallStartEvent,
    ],
    [
      "TOOL_CALL_RESULT",
      {
        type: "TOOL_CALL_RESULT",
        runId: "task-1",
        toolCallId: "call-1",
        messageId: "call-1",
        content: "ok",
        outcome: "completed",
        durationMs: 12,
        timestamp: TS,
      } satisfies ToolCallResultEvent,
    ],
    [
      "STATE_SNAPSHOT",
      { type: "STATE_SNAPSHOT", snapshot: { tasks: [], agents: [] }, timestamp: TS } satisfies StateSnapshotEvent,
    ],
    [
      "CUSTOM (orchestrai.approval-required)",
      {
        type: "CUSTOM",
        name: "orchestrai.approval-required",
        value: { taskId: "task-1", agent: "devops-agent", skill: "dockerize", approval: null },
        timestamp: TS,
      } satisfies CustomEvent,
    ],
  ]

  for (const [label, event] of cases) {
    test(`${label} validates against its official/local schema`, () => {
      const result = validateAgUiEvent(event)
      expect(result).toEqual({ ok: true, errors: [] })
    })
  }

  test("CUSTOM (orchestrai.approval-resolved) validates", () => {
    const event: CustomEvent = {
      type: "CUSTOM",
      name: "orchestrai.approval-resolved",
      value: { taskId: "task-1", decision: "approved" },
      timestamp: TS,
    }
    expect(validateAgUiEvent(event)).toEqual({ ok: true, errors: [] })
  })

  test("CUSTOM (orchestrai.agents-update) validates", () => {
    const event: CustomEvent = {
      type: "CUSTOM",
      name: "orchestrai.agents-update",
      value: { count: 5 },
      timestamp: TS,
    }
    expect(validateAgUiEvent(event)).toEqual({ ok: true, errors: [] })
  })

  // specs/113-live-audit-log-dashboard/spec.md
  test("CUSTOM (orchestrai.audit-event) validates", () => {
    const event: CustomEvent = {
      type: "CUSTOM",
      name: "orchestrai.audit-event",
      value: {
        ts: TS,
        kind: "mcp-tool-call",
        caller: "devops-agent",
        target: "git_status",
        taskId: "orch-task-1",
        outcome: "completed",
        durationMs: 12,
        resultBytes: 42,
        resultTruncated: false,
        params: { retried: false, paramsHash: "abc123" },
      },
      timestamp: TS,
    }
    expect(validateAgUiEvent(event)).toEqual({ ok: true, errors: [] })
  })

  test("CUSTOM (orchestrai.audit-event) with a malformed value fails", () => {
    const event: CustomEvent = {
      type: "CUSTOM",
      name: "orchestrai.audit-event",
      // Missing every required field.
      value: {},
      timestamp: TS,
    }
    const result = validateAgUiEvent(event)
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test("RUN_FINISHED with an interrupt outcome (no live call site today, but modeled) validates", () => {
    const event: RunFinishedEvent = {
      type: "RUN_FINISHED",
      threadId: "task-1",
      runId: "task-1",
      outcome: { type: "interrupt", interrupts: [{ id: "int-1", reason: "approval-required" }] },
      timestamp: TS,
    }
    expect(validateAgUiEvent(event)).toEqual({ ok: true, errors: [] })
  })
})

describe("negative tests — validation actually rejects malformed events", () => {
  test("TOOL_CALL_RESULT missing the required messageId fails", () => {
    const malformed = {
      type: "TOOL_CALL_RESULT",
      runId: "task-1",
      toolCallId: "call-1",
      content: "ok",
      outcome: "completed",
      durationMs: 12,
      timestamp: TS,
      // messageId intentionally omitted
    } as unknown as AgUiEvent
    const result = validateAgUiEvent(malformed)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes("messageId"))).toBe(true)
  })

  test("RUN_FINISHED with the old bare-string outcome fails (specs/021's original shape)", () => {
    const malformed = {
      type: "RUN_FINISHED",
      threadId: "task-1",
      runId: "task-1",
      outcome: "success",
      timestamp: TS,
    } as unknown as AgUiEvent
    const result = validateAgUiEvent(malformed)
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test("RUN_STARTED with a wrong-type field (runId as number) fails", () => {
    const malformed = {
      type: "RUN_STARTED",
      threadId: "task-1",
      runId: 12345,
      timestamp: TS,
    } as unknown as AgUiEvent
    const result = validateAgUiEvent(malformed)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes("runId"))).toBe(true)
  })

  test("STEP_STARTED missing the required stepName fails", () => {
    const malformed = {
      type: "STEP_STARTED",
      runId: "task-1",
      timestamp: TS,
    } as unknown as AgUiEvent
    const result = validateAgUiEvent(malformed)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes("stepName"))).toBe(true)
  })

  test("CUSTOM approval-required with a missing skill field fails its local value schema", () => {
    const malformed = {
      type: "CUSTOM",
      name: "orchestrai.approval-required",
      value: { taskId: "task-1", agent: "devops-agent", approval: null },
      timestamp: TS,
    } as unknown as AgUiEvent
    const result = validateAgUiEvent(malformed)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.startsWith("value."))).toBe(true)
  })

  test("CUSTOM approval-resolved with an invalid decision value fails its local value schema", () => {
    const malformed = {
      type: "CUSTOM",
      name: "orchestrai.approval-resolved",
      value: { taskId: "task-1", decision: "maybe" },
      timestamp: TS,
    } as unknown as AgUiEvent
    const result = validateAgUiEvent(malformed)
    expect(result.ok).toBe(false)
  })

  test("CUSTOM agents-update with a non-numeric count fails its local value schema", () => {
    const malformed = {
      type: "CUSTOM",
      name: "orchestrai.agents-update",
      value: { count: "five" },
      timestamp: TS,
    } as unknown as AgUiEvent
    const result = validateAgUiEvent(malformed)
    expect(result.ok).toBe(false)
  })
})

// specs/044-conversational-ask-layer/spec.md — the three message events
// this runtime began emitting for conversational assistant turns, which
// specs/027 had deliberately omitted while no LLM output stream existed.
// Same standard as the nine above: validated against @ag-ui/core's real
// runtime schemas, not merely typed against them.
describe("TEXT_MESSAGE_* — specs/044's addition to the emitted subset", () => {
  test("TEXT_MESSAGE_START validates", () => {
    const event: AgUiEvent = {
      type: "TEXT_MESSAGE_START",
      messageId: "turn-1",
      role: "assistant",
      timestamp: TS,
    }
    expect(validateAgUiEvent(event)).toEqual({ ok: true, errors: [] })
  })

  test("TEXT_MESSAGE_CONTENT validates", () => {
    const event: AgUiEvent = {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "turn-1",
      delta: "82% coverage, 12 tests passing.",
      timestamp: TS,
    }
    expect(validateAgUiEvent(event)).toEqual({ ok: true, errors: [] })
  })

  test("TEXT_MESSAGE_END validates", () => {
    const event: AgUiEvent = {
      type: "TEXT_MESSAGE_END",
      messageId: "turn-1",
      timestamp: TS,
    }
    expect(validateAgUiEvent(event)).toEqual({ ok: true, errors: [] })
  })

  test("a START missing its messageId fails, as the real schema requires", () => {
    const malformed = { type: "TEXT_MESSAGE_START", role: "assistant", timestamp: TS } as unknown as AgUiEvent
    expect(validateAgUiEvent(malformed).ok).toBe(false)
  })

  test("a CONTENT event with a non-string delta fails", () => {
    const malformed = {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "turn-1",
      delta: 82,
      timestamp: TS,
    } as unknown as AgUiEvent
    expect(validateAgUiEvent(malformed).ok).toBe(false)
  })
})
