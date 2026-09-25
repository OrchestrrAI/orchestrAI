import { randomUUID } from "node:crypto"
import { agents, type AgentName } from "./agent-registry"
import { boundTaskResult, emitAuditEvent, emitAuditStart, utf8ByteLength } from "./audit"
import { parseTaskEnvelope } from "./task-envelope"

// ============================================================
// SHARED A2A CLIENT
// ============================================================
// Generalizes the submit/poll/timeout/audit pattern (see
// specs/005-mcp-agent-integration/spec.md Tier 3) so ANY agent can call ANY
// other agent through the existing custom A2A-style HTTP task contract.
// This is A2A, never MCP: see CLAUDE.md's "MCP and A2A solve different
// problems" boundary.

const DEFAULT_POLL_INTERVAL_MS = 100

export interface CallAgentOptions {
  timeoutMs: number
  pollIntervalMs?: number
  fetchImpl?: typeof fetch
  role?: "user" | "agent"
  callerName: string
  /** The calling agent's own task ID, for audit parent/child correlation. */
  taskId: string
  /** Overrides the caller's default base URL resolution (used by tests). */
  baseUrl?: string
  /** specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md —
   *  set when the caller already knows exactly which skill it wants (e.g.
   *  DevOps asking Security for scan-secrets specifically, not just "some
   *  security thing"). The receiving agent validates this against its own
   *  Agent Card and executes it exactly; it is never proof of caller
   *  identity and never bypasses approval. Omit for legacy behavior — the
   *  target agent's own text-based detector runs as before. */
  selectedSkill?: string
}

export interface TaskResult {
  id: string
  status: "submitted" | "working" | "completed" | "failed" | "input-required"
  result?: string
  error?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Submits `taskText` to the named agent, polls until it reaches a terminal
 * state, and returns its bounded result. Uses the shared task-envelope
 * contract for the outgoing call and crypto.randomUUID() for the child A2A
 * task ID (never wall-clock precision), per the runtime-stabilization ID
 * policy. Emits one metadata-only audit event per call, success or failure.
 */
export async function callAgent(
  target: AgentName,
  taskText: string,
  opts: CallAgentOptions,
): Promise<string> {
  const started = performance.now()
  const baseUrl = opts.baseUrl ?? agents[target]
  const fetchImpl = opts.fetchImpl ?? fetch
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const childTaskId = `a2a-${randomUUID()}`
  const role = opts.role ?? "agent"

  const envelope = {
    id: childTaskId,
    message: { role, parts: [{ text: taskText }] },
    ...(opts.selectedSkill !== undefined ? { selectedSkill: opts.selectedSkill } : {}),
  }
  const validated = parseTaskEnvelope(envelope)
  if (!validated.ok) {
    // Should be unreachable for a well-formed caller, but never send an
    // envelope that would fail the receiving agent's own validation.
    throw new Error(`Refusing to send invalid outgoing A2A envelope: ${validated.error}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("A2A call timeout")), opts.timeoutMs)
  let outcome: "completed" | "failed" | "timeout" = "failed"
  let resultBytes = 0
  let resultTruncated = false

  // specs/021-ag-ui-event-protocol/spec.md — see the matching call in
  // mcp-client.ts. Announces the call in flight; the result is pushed from
  // the finally block below. Fire-and-forget, never awaited. Reuses
  // childTaskId as callId rather than minting a second id — it's already a
  // fresh randomUUID() per call, exactly the uniqueness callId needs (see
  // emitAuditStart()'s doc comment for why a per-call id matters at all).
  emitAuditStart({
    kind: "a2a-call",
    caller: opts.callerName,
    target: `${target}-agent`,
    taskId: opts.taskId,
    callId: childTaskId,
  })

  try {
    const submit = await fetchImpl(`${baseUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(envelope),
    })
    if (!submit.ok) throw new Error(`A2A submission to ${target} failed with HTTP ${submit.status}`)

    while (true) {
      await Bun.sleep(pollIntervalMs)
      const response = await fetchImpl(`${baseUrl}/tasks/${encodeURIComponent(childTaskId)}`, {
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`A2A polling ${target} failed with HTTP ${response.status}`)

      const task = (await response.json()) as TaskResult
      if (task.status === "completed") {
        const bounded = boundTaskResult(task.result ?? `${target} completed without a result.`)
        outcome = "completed"
        resultBytes = bounded.originalBytes
        resultTruncated = bounded.truncated
        return bounded.text
      }
      if (task.status === "failed") throw new Error(task.error ?? `${target} task failed`)
      // "submitted" / "working" / "input-required" — keep polling. A2A calls
      // in this checkpoint target read-only skills, so input-required is not
      // expected in practice, but we do not hang forever: the outer timeout
      // still bounds total wait time.
    }
  } catch (error) {
    const message = errorMessage(error)
    outcome = controller.signal.aborted || /timeout/i.test(message) ? "timeout" : "failed"
    resultBytes = utf8ByteLength(message)
    throw error
  } finally {
    clearTimeout(timer)
    emitAuditEvent({
      kind: "a2a-call",
      caller: opts.callerName,
      target: `${target}-agent`,
      taskId: opts.taskId,
      callId: childTaskId,
      params: { childTaskId, target, textBytes: utf8ByteLength(taskText) },
      outcome,
      durationMs: performance.now() - started,
      resultBytes,
      resultTruncated,
    })
  }
}
