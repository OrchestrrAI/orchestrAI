// specs/021-ag-ui-event-protocol/spec.md, migrated by
// specs/027-ag-ui-core-adoption/spec.md.
//
// AG-UI event shapes, sourced from the official `@ag-ui/core` package
// (pinned exact version — see package.json) rather than hand-defined.
// specs/021 originally hand-defined these on a minimal-new-dependency
// posture, claiming field names "deliberately match the real protocol so
// an official-SDK client can parse this stream unchanged." specs/027
// tested that claim by adopting the real runtime schemas and found it was
// false for two of the nine event types (see the two exceptions noted on
// `ToolCallResultEvent`/`RunFinishedEvent` below) — both are now conformed
// per that spec's Option A resolution, so the claim now holds for all nine.
//
// Only the subset OrchestrAI actually emits is defined here. The protocol
// has more event kinds; the ones below are the ones the task lifecycle maps
// onto.
//
// TEXT_MESSAGE_* joined that subset in
// specs/044-conversational-ask-layer/spec.md (which formally amends
// specs/027 for this). This file previously omitted them with a stated
// reason: "there is no LLM token stream or agent 'thinking' in this
// runtime to carry over them (CLAUDE.md: 'There are no LLM API calls in
// the current runtime'), so emitting them would be fabricating structure
// that doesn't exist." That reasoning was correct when written and its
// premise has since become false — specs/038 made the LangGraph
// supervisor the default plan-task planner, and specs/041/042/043 added
// three agent-side harnesses. Assistant turns in a conversation are real
// generated messages, so carrying them over the protocol's own message
// events is now describing what exists rather than inventing it.
//
// REASONING_*, STATE_DELTA and friends remain deliberately absent, for
// the original reason unchanged: this runtime exposes no intermediate
// model reasoning, only final answers. Adopting @ag-ui/core's full type
// surface still does not authorize emitting any event beyond these twelve.

import { z } from "zod"
import {
  CustomEventSchema,
  RunErrorEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema,
  StateSnapshotEventSchema,
  StepFinishedEventSchema,
  StepStartedEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageStartEventSchema,
  ToolCallResultEventSchema,
  ToolCallStartEventSchema,
} from "@ag-ui/core"

export type AgUiEventType =
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "STEP_STARTED"
  | "STEP_FINISHED"
  | "TOOL_CALL_START"
  | "TOOL_CALL_RESULT"
  | "TEXT_MESSAGE_START"
  | "TEXT_MESSAGE_CONTENT"
  | "TEXT_MESSAGE_END"
  | "STATE_SNAPSHOT"
  | "CUSTOM"

interface BaseAgUiEvent {
  type: AgUiEventType
  /** Milliseconds since epoch. Part of the protocol's BaseEvent shape. */
  timestamp: number
}

/** A task begins. `threadId`/`runId` both carry the Orchestrator task id —
 *  this runtime has no multi-run conversation threads, so they coincide. */
export interface RunStartedEvent extends BaseAgUiEvent {
  type: "RUN_STARTED"
  threadId: string
  runId: string
}

/** The official `RunFinishedOutcomeSchema` shape — a discriminated union on
 *  `type`, not the bare `"success" | "interrupt"` string specs/021
 *  originally emitted. This runtime has never actually constructed the
 *  `"interrupt"` variant (a task entering `input-required` emits a
 *  `CUSTOM orchestrai.approval-required` event instead and never reaches
 *  `runFinished()`), but the shape is modeled in full — including the
 *  official schema's required `interrupts` array — so it stays valid if
 *  that ever changes rather than silently drifting out of conformance. */
export type RunFinishedOutcome =
  | { type: "success" }
  | {
      type: "interrupt"
      interrupts: Array<{
        id: string
        reason: string
        message?: string
        toolCallId?: string
        responseSchema?: Record<string, unknown>
        expiresAt?: string
        metadata?: Record<string, unknown>
      }>
    }

export interface RunFinishedEvent extends BaseAgUiEvent {
  type: "RUN_FINISHED"
  threadId: string
  runId: string
  outcome: RunFinishedOutcome
}

export interface RunErrorEvent extends BaseAgUiEvent {
  type: "RUN_ERROR"
  threadId: string
  runId: string
  message: string
}

/** One dispatched plan step (Planning-produced multi-step runs only). */
export interface StepStartedEvent extends BaseAgUiEvent {
  type: "STEP_STARTED"
  runId: string
  stepName: string
}

export interface StepFinishedEvent extends BaseAgUiEvent {
  type: "STEP_FINISHED"
  runId: string
  stepName: string
  outcome?: "completed" | "failed"
}

/** An MCP tool call or direct A2A call beginning, sourced from
 *  emitAuditEvent()'s own `kind`/`caller`/`target`. */
export interface ToolCallStartEvent extends BaseAgUiEvent {
  type: "TOOL_CALL_START"
  runId: string
  toolCallId: string
  toolCallName: string
  /** Not protocol-standard; OrchestrAI carries who initiated the call so a
   *  client can distinguish an agent's own MCP call from a direct A2A hop
   *  into a peer without re-deriving it from the tool name. */
  caller?: string
}

export interface ToolCallResultEvent extends BaseAgUiEvent {
  type: "TOOL_CALL_RESULT"
  runId: string
  toolCallId: string
  /** Required by the official `ToolCallResultEventSchema` (specs/027's
   *  second found incompatibility — specs/021 omitted this entirely). This
   *  runtime has no distinct "message" concept to attach a tool result to
   *  (no TEXT_MESSAGE_* stream), so `mapAuditPushToAgUiEvent()` reuses the
   *  call's own `toolCallId` — deterministic, already unique per call, and
   *  avoids inventing new state purely to satisfy the schema. */
  messageId: string
  content: string
  outcome: "completed" | "failed" | "timeout"
  durationMs: number
}

/** Full current state for a client that just connected (or reconnected)
 *  mid-run and would otherwise have missed every prior event. */
export interface StateSnapshotEvent extends BaseAgUiEvent {
  type: "STATE_SNAPSHOT"
  snapshot: unknown
}

// ============================================================
// TEXT MESSAGES (specs/044-conversational-ask-layer/spec.md)
// ============================================================
// An assistant turn in a conversation. `messageId` correlates the
// start/content/end trio; `threadId` on the surrounding run events
// carries the CONVERSATION id, which is the first time in this runtime
// that threadId and runId genuinely differ (see specs/044).
//
// The protocol models content as a stream of deltas. This runtime emits
// the finished answer as one content event rather than token-by-token —
// honest for what it currently does, and forward-compatible: a client
// that concatenates deltas handles both without changing.

/** Begins an assistant message. */
export interface TextMessageStartEvent extends BaseAgUiEvent {
  type: "TEXT_MESSAGE_START"
  messageId: string
  role: "assistant"
}

/** One chunk of an assistant message's text. */
export interface TextMessageContentEvent extends BaseAgUiEvent {
  type: "TEXT_MESSAGE_CONTENT"
  messageId: string
  delta: string
}

/** Ends an assistant message. */
export interface TextMessageEndEvent extends BaseAgUiEvent {
  type: "TEXT_MESSAGE_END"
  messageId: string
}

/** AG-UI's documented extensibility escape hatch. Used here for
 *  approval-gate signalling, which the protocol has no native primitive
 *  for — see the spec's "Explicitly not solved by AG-UI" note. These are
 *  INFORMATIONAL ONLY: the real approval mechanism remains
 *  POST /tasks/:id/approve with its server-issued actionId. A client must
 *  never treat one of these as authorization for anything. */
export interface CustomEvent extends BaseAgUiEvent {
  type: "CUSTOM"
  name: "orchestrai.approval-required" | "orchestrai.approval-resolved" | "orchestrai.agents-update" | "orchestrai.audit-event"
  value: unknown
}

export type AgUiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | ToolCallStartEvent
  | ToolCallResultEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | StateSnapshotEvent
  | CustomEvent

/** Serializes one event as a single SSE frame. The protocol puts the type
 *  in BOTH the SSE `event:` line and the JSON `type` field; clients using
 *  EventSource's typed listeners need the former, clients reading raw
 *  frames (the TUI) use the latter. */
export function toSseFrame(event: AgUiEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/** The audit payload an agent pushes to the Orchestrator
 *  (POST /internal/audit-event). Deliberately mirrors AuditEventInput's own
 *  fields rather than the AG-UI shape — the Orchestrator does the mapping
 *  to TOOL_CALL_* centrally, so agents stay unaware of AG-UI entirely. */
export interface AuditPushPayload {
  kind: "mcp-tool-call" | "a2a-call" | "command-execution"
  caller: string
  target: string
  /** The AGENT-side task id (e.g. `orch-task-<uuid>`). The Orchestrator
   *  strips its own `orch-` prefix to recover the run id it broadcasts
   *  under — see apps/orchestrator/index.ts's agentTaskId convention. */
  taskId: string
  outcome: "completed" | "failed" | "timeout"
  durationMs: number
  resultSummary: string
  phase: "start" | "result"
  /** Minted by the calling agent (crypto.randomUUID()) and reused unchanged
   *  across a call's START and RESULT push — see emitAuditStart()'s own doc
   *  comment in packages/shared/audit.ts for why this replaced deriving
   *  `${taskId}:${kind}:${target}` on the Orchestrator (that collided for a
   *  task calling the same tool twice). Optional so an older/incompatible
   *  push is still handled — see POST /internal/audit-event's own fallback. */
  callId?: string
  /** specs/113-live-audit-log-dashboard/spec.md — the exact same
   *  whitelistAuditParams() output already written to the durable
   *  audit_events table (packages/shared/audit.ts), carried on the
   *  "result" phase push too so the live SSE stream can broadcast a
   *  genuine orchestrai.audit-event CUSTOM event alongside the existing
   *  TOOL_CALL_RESULT mapping. Optional and additive: a "start" phase
   *  push, or an older caller that doesn't send it, produces only the
   *  existing TOOL_CALL_* events, exactly as before this spec. */
  paramsWhitelisted?: Record<string, unknown>
  /** specs/113 — carried alongside paramsWhitelisted for the identical
   *  reason: already computed in emitAuditEvent(), reused here rather
   *  than lost, so a live audit row can render the same "resultBytes=N
   *  (truncated)" summary a historical row already shows. */
  resultBytes?: number
  resultTruncated?: boolean
}

// ============================================================
// RUNTIME VALIDATION — specs/027-ag-ui-core-adoption/spec.md
// ============================================================
// Adopting @ag-ui/core for its TypeScript types alone would leave the
// principal safety benefit on the table (a payload can drift from the
// schema and TypeScript will never notice, since these interfaces are
// hand-written to match it, not derived from it). Every event the
// Orchestrator emits is run through the corresponding official runtime
// schema before being written to the SSE stream — see emit() in
// apps/orchestrator/index.ts.

/** One schema per standard (non-CUSTOM) event type this runtime emits. */
const STANDARD_EVENT_SCHEMAS: Record<Exclude<AgUiEventType, "CUSTOM">, z.ZodTypeAny> = {
  RUN_STARTED: RunStartedEventSchema,
  RUN_FINISHED: RunFinishedEventSchema,
  RUN_ERROR: RunErrorEventSchema,
  STEP_STARTED: StepStartedEventSchema,
  STEP_FINISHED: StepFinishedEventSchema,
  TOOL_CALL_START: ToolCallStartEventSchema,
  TOOL_CALL_RESULT: ToolCallResultEventSchema,
  TEXT_MESSAGE_START: TextMessageStartEventSchema,
  TEXT_MESSAGE_CONTENT: TextMessageContentEventSchema,
  TEXT_MESSAGE_END: TextMessageEndEventSchema,
  STATE_SNAPSHOT: StateSnapshotEventSchema,
}

/** OrchestrAI-defined schemas for each CUSTOM event's `value` payload.
 *  `CustomEventSchema.value` is `z.any()` in the official package (it has
 *  to be — CUSTOM's payload is application-defined), so official
 *  conformance alone would let any `value` shape through unnoticed. These
 *  close that gap for OrchestrAI's own three extension names specifically,
 *  matching the exact shapes apps/orchestrator/index.ts constructs. */
const APPROVAL_REQUIRED_VALUE_SCHEMA = z.object({
  taskId: z.string(),
  agent: z.string().optional(),
  skill: z.string(),
  approval: z.unknown().nullable(),
})

const APPROVAL_RESOLVED_VALUE_SCHEMA = z.object({
  taskId: z.string(),
  // specs/089-plan-step-skip-continue/spec.md added "skipped" — a third,
  // distinct approval outcome for a plan step's own child task.
  decision: z.enum(["approved", "rejected", "skipped"]),
})

const AGENTS_UPDATE_VALUE_SCHEMA = z.object({
  count: z.number(),
})

// specs/113-live-audit-log-dashboard/spec.md — the live-broadcast shape
// of one durable audit_events row, minus the ts/id columns a client
// doesn't need in real time (the row itself carries `ts`). Kept
// deliberately narrow — booleans/numbers/strings only in `params`,
// matching whitelistAuditParams()'s own real output shape exactly.
const AUDIT_EVENT_VALUE_SCHEMA = z.object({
  ts: z.number(),
  kind: z.enum(["mcp-tool-call", "a2a-call", "command-execution"]),
  caller: z.string(),
  target: z.string(),
  taskId: z.string(),
  outcome: z.enum(["completed", "failed", "timeout"]),
  durationMs: z.number(),
  resultBytes: z.number(),
  resultTruncated: z.boolean(),
  params: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
})

const CUSTOM_VALUE_SCHEMAS: Record<CustomEvent["name"], z.ZodTypeAny> = {
  "orchestrai.approval-required": APPROVAL_REQUIRED_VALUE_SCHEMA,
  "orchestrai.approval-resolved": APPROVAL_RESOLVED_VALUE_SCHEMA,
  "orchestrai.agents-update": AGENTS_UPDATE_VALUE_SCHEMA,
  "orchestrai.audit-event": AUDIT_EVENT_VALUE_SCHEMA,
}

export interface AgUiValidationResult {
  ok: boolean
  /** Human-readable "field path: issue" entries. Empty when ok. */
  errors: string[]
}

/**
 * Validates one constructed event against its official `@ag-ui/core`
 * runtime schema (and, for CUSTOM events, OrchestrAI's own local schema for
 * that extension's `value`). Never throws — a validation failure is a
 * programming error in OrchestrAI to report, not a runtime condition to
 * propagate. Callers decide what to do with a failing result: the
 * Orchestrator's `emit()` logs and still broadcasts (a schema disagreement
 * must never take down the live stream a demo depends on); dedicated tests
 * assert `ok` directly so a regression fails the suite instead of only
 * being logged at runtime.
 */
export function validateAgUiEvent(event: AgUiEvent): AgUiValidationResult {
  const schema = event.type === "CUSTOM" ? CustomEventSchema : STANDARD_EVENT_SCHEMAS[event.type]
  const parsed = schema.safeParse(event)
  const errors: string[] = []
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`)
    }
  }

  if (event.type === "CUSTOM") {
    const valueSchema = CUSTOM_VALUE_SCHEMAS[event.name]
    const valueParsed = valueSchema.safeParse(event.value)
    if (!valueParsed.success) {
      for (const issue of valueParsed.error.issues) {
        errors.push(`value.${issue.path.join(".") || "(root)"}: ${issue.message}`)
      }
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors }
}
