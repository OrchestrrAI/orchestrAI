import type {
  AuditPushPayload,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "./ag-ui-events"

const AUDIT_KINDS = new Set<AuditPushPayload["kind"]>([
  "mcp-tool-call",
  "a2a-call",
  "command-execution",
])
const AUDIT_OUTCOMES = new Set<AuditPushPayload["outcome"]>([
  "completed",
  "failed",
  "timeout",
])

type MappedAuditEvent = ToolCallStartEvent | ToolCallResultEvent

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Maps an agent audit push onto the live AG-UI tool-call subset.
 *
 * This stays deliberately pure and tolerant: the audit endpoint is an
 * observability boundary, so malformed input is ignored rather than allowed
 * to throw into an agent's task path. A missing callId retains the 021 legacy
 * compatibility fallback; a present but invalid callId is rejected.
 */
export function mapAuditPushToAgUiEvent(
  input: unknown,
  timestamp = Date.now(),
): MappedAuditEvent | null {
  if (!input || typeof input !== "object") return null

  const payload = input as Partial<AuditPushPayload>
  if (payload.phase !== "start" && payload.phase !== "result") return null
  if (!nonBlank(payload.taskId) || !nonBlank(payload.target)) return null
  if (!nonBlank(payload.caller)) return null
  if (!payload.kind || !AUDIT_KINDS.has(payload.kind)) return null
  if (payload.callId !== undefined && !nonBlank(payload.callId)) return null

  const runId = payload.taskId.startsWith("orch-")
    ? payload.taskId.slice("orch-".length)
    : payload.taskId
  const toolCallId = payload.callId ?? `${payload.taskId}:${payload.kind}:${payload.target}`

  if (payload.phase === "start") {
    return {
      type: "TOOL_CALL_START",
      runId,
      toolCallId,
      toolCallName: payload.target,
      caller: payload.caller,
      timestamp,
    }
  }

  const outcome = payload.outcome ?? "completed"
  if (!AUDIT_OUTCOMES.has(outcome)) return null
  if (payload.resultSummary !== undefined && typeof payload.resultSummary !== "string") return null
  if (payload.durationMs !== undefined && (!Number.isFinite(payload.durationMs) || payload.durationMs < 0)) {
    return null
  }

  return {
    type: "TOOL_CALL_RESULT",
    runId,
    toolCallId,
    // See ToolCallResultEvent's own doc comment (ag-ui-events.ts):
    // reusing toolCallId as messageId — this runtime has no distinct
    // "message" concept for a tool result to attach to.
    messageId: toolCallId,
    content: payload.resultSummary ?? "",
    outcome,
    durationMs: Math.round(payload.durationMs ?? 0),
    timestamp,
  }
}

/** specs/113-live-audit-log-dashboard/spec.md — a sibling to
 *  mapAuditPushToAgUiEvent() above, producing the `value` payload for a
 *  new `orchestrai.audit-event` CUSTOM event instead of the TOOL_CALL_*
 *  mapping. Deliberately narrower: only ever fires for a "result" phase
 *  push that actually carries `paramsWhitelisted` (a "start" phase push,
 *  or an older caller that never sends the field, correctly produces
 *  null here — the existing TOOL_CALL_* event is unaffected either way,
 *  since this is called independently, not in place of the function
 *  above). Reuses the exact same validation this file already
 *  established for taskId/target/caller/kind/outcome/durationMs, so the
 *  two mapping functions can never disagree about what a well-formed
 *  push looks like. */
export function mapAuditPushToAuditEventValue(
  input: unknown,
  ts = Date.now(),
): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null

  const payload = input as Partial<AuditPushPayload>
  if (payload.phase !== "result") return null
  if (!payload.paramsWhitelisted || typeof payload.paramsWhitelisted !== "object") return null
  if (!nonBlank(payload.taskId) || !nonBlank(payload.target) || !nonBlank(payload.caller)) return null
  if (!payload.kind || !AUDIT_KINDS.has(payload.kind)) return null
  const outcome = payload.outcome ?? "completed"
  if (!AUDIT_OUTCOMES.has(outcome)) return null
  if (payload.durationMs !== undefined && (!Number.isFinite(payload.durationMs) || payload.durationMs < 0)) {
    return null
  }

  return {
    ts,
    kind: payload.kind,
    caller: payload.caller,
    target: payload.target,
    taskId: payload.taskId,
    outcome,
    durationMs: Math.round(payload.durationMs ?? 0),
    resultBytes: typeof payload.resultBytes === "number" ? payload.resultBytes : 0,
    resultTruncated: payload.resultTruncated === true,
    params: payload.paramsWhitelisted,
  }
}
