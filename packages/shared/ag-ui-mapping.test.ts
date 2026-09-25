import { describe, expect, test } from "bun:test"
import { mapAuditPushToAgUiEvent, mapAuditPushToAuditEventValue } from "./ag-ui-mapping"

const base = {
  kind: "mcp-tool-call",
  caller: "devops-agent",
  target: "git_status",
  taskId: "orch-task-123",
} as const

describe("audit push to AG-UI mapping", () => {
  test("maps start and result onto one caller-minted toolCallId", () => {
    const start = mapAuditPushToAgUiEvent({ ...base, phase: "start", callId: "call-1" }, 100)
    const result = mapAuditPushToAgUiEvent({
      ...base,
      phase: "result",
      callId: "call-1",
      outcome: "completed",
      durationMs: 12.6,
      resultSummary: "ok",
    }, 200)

    expect(start).toEqual({
      type: "TOOL_CALL_START",
      runId: "task-123",
      toolCallId: "call-1",
      toolCallName: "git_status",
      caller: "devops-agent",
      timestamp: 100,
    })
    expect(result).toMatchObject({
      type: "TOOL_CALL_RESULT",
      runId: "task-123",
      toolCallId: "call-1",
      content: "ok",
      outcome: "completed",
      durationMs: 13,
      timestamp: 200,
    })
  })

  test("keeps repeated calls distinct when callers provide distinct ids", () => {
    const first = mapAuditPushToAgUiEvent({ ...base, phase: "start", callId: "call-A" })
    const second = mapAuditPushToAgUiEvent({ ...base, phase: "start", callId: "call-B" })
    expect(first?.toolCallId).toBe("call-A")
    expect(second?.toolCallId).toBe("call-B")
  })

  test("retains the documented legacy fallback when callId is absent", () => {
    const event = mapAuditPushToAgUiEvent({ ...base, phase: "start" })
    expect(event?.toolCallId).toBe("orch-task-123:mcp-tool-call:git_status")
  })

  test("invalid payloads produce no event and never throw", () => {
    const invalid = [
      null,
      {},
      { ...base, phase: "unknown" },
      { ...base, phase: "start", caller: "" },
      { ...base, phase: "start", kind: "unknown" },
      { ...base, phase: "result", outcome: "maybe" },
      { ...base, phase: "result", durationMs: -1 },
      { ...base, phase: "start", callId: 42 },
    ]

    for (const payload of invalid) {
      expect(() => mapAuditPushToAgUiEvent(payload)).not.toThrow()
      expect(mapAuditPushToAgUiEvent(payload)).toBeNull()
    }
  })
})

// specs/113-live-audit-log-dashboard/spec.md
describe("audit push to live audit-event value mapping", () => {
  test("a well-formed result-phase push with paramsWhitelisted produces a full value", () => {
    const value = mapAuditPushToAuditEventValue({
      ...base,
      phase: "result",
      outcome: "completed",
      durationMs: 12.6,
      resultBytes: 42,
      resultTruncated: false,
      paramsWhitelisted: { retried: false, paramsHash: "abc123" },
    }, 200)

    expect(value).toEqual({
      ts: 200,
      kind: "mcp-tool-call",
      caller: "devops-agent",
      target: "git_status",
      taskId: "orch-task-123",
      outcome: "completed",
      durationMs: 13,
      resultBytes: 42,
      resultTruncated: false,
      params: { retried: false, paramsHash: "abc123" },
    })
  })

  test("a start-phase push produces null — this event only ever fires on 'result'", () => {
    const value = mapAuditPushToAuditEventValue({ ...base, phase: "start", paramsWhitelisted: {} })
    expect(value).toBeNull()
  })

  test("a result-phase push with no paramsWhitelisted (an older caller) produces null, not a broken partial value", () => {
    const value = mapAuditPushToAuditEventValue({ ...base, phase: "result", outcome: "completed" })
    expect(value).toBeNull()
  })

  test("invalid payloads produce null and never throw", () => {
    const invalid = [
      null,
      {},
      { ...base, phase: "result", paramsWhitelisted: {}, kind: "unknown" },
      { ...base, phase: "result", paramsWhitelisted: {}, outcome: "maybe" },
      { ...base, phase: "result", paramsWhitelisted: {}, durationMs: -1 },
      { ...base, phase: "result", paramsWhitelisted: {}, caller: "" },
    ]
    for (const payload of invalid) {
      expect(() => mapAuditPushToAuditEventValue(payload)).not.toThrow()
      expect(mapAuditPushToAuditEventValue(payload)).toBeNull()
    }
  })
})
