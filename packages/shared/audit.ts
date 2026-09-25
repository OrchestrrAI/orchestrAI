import { createHash } from "node:crypto"
import { getSharedStore, type AuditEventInsert } from "./store"
import { resolveServicePort } from "./service-ports"

const AUDIT_SUMMARY_MAX_BYTES = 512
export const TASK_RESULT_MAX_BYTES = 64 * 1024

const encoder = new TextEncoder()

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value

  let result = ""
  let bytes = 0
  for (const character of value) {
    const characterBytes = utf8ByteLength(character)
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

export function boundTaskResult(value: string): {
  text: string
  originalBytes: number
  truncated: boolean
} {
  const originalBytes = utf8ByteLength(value)
  if (originalBytes <= TASK_RESULT_MAX_BYTES) {
    return { text: value, originalBytes, truncated: false }
  }

  const marker = "\n[Result truncated at 64 KiB]"
  const contentLimit = TASK_RESULT_MAX_BYTES - utf8ByteLength(marker)
  return {
    text: truncateUtf8(value, contentLimit) + marker,
    originalBytes,
    truncated: true,
  }
}

type AuditOutcome = "completed" | "failed" | "timeout"

export interface AuditEventInput {
  kind: "mcp-tool-call" | "a2a-call" | "command-execution"
  caller: string
  target: string
  taskId: string
  params: Record<string, unknown>
  outcome: AuditOutcome
  durationMs: number
  resultBytes: number
  resultTruncated: boolean
  /** specs/021-ag-ui-event-protocol/spec.md — the id minted by the caller for
   *  this specific call (see emitAuditStart's own doc comment for why it's
   *  minted at the source rather than derived on the Orchestrator). Must
   *  match the `callId` passed to the emitAuditStart() call this pairs
   *  with, or the Orchestrator can't correlate the two pushes. */
  callId?: string
}

// specs/021-ag-ui-event-protocol/spec.md — audit events are produced inside
// each AGENT's process, but the SSE stream clients subscribe to lives on
// the Orchestrator. These push helpers bridge that gap.
//
// Deliberately fire-and-forget: a push failure is swallowed entirely and
// never propagates to the caller. A task must never fail, block, or slow
// down because the Orchestrator happened to be unreachable — audit/
// observability is best-effort here, never load-bearing for correctness.
// (Same reason `void` + `.catch(() => {})` rather than `await`: the
// calling tool path must not wait on this at all.)
//
// Correction, specs/108-durable-audit-trail/spec.md: this comment used to
// call console.log "the durable record" — it is stdout, reaching disk
// only incidentally when the supervisor happens to be redirecting it
// (specs/066), into a file truncated fresh on every run. The real durable
// record, as of specs/108, is the batched third sink below
// (bufferAuditEvent()/flushAuditBuffer()) writing to the shared SQLite
// store — itself fail-open and best-effort in the same spirit (a lost
// buffer on a hard crash is accepted, per that spec's own safety
// constraints), but the one sink that actually survives a restart.
const AUDIT_PUSH_TIMEOUT_MS = 2000

// specs/141 — the full-URL override wins, else the configured Orchestrator
// port (specs/073). Resolved per push: a hardcoded :3000 sent a custom-port
// stack's events to whatever else was listening there.
export function resolveAuditPushUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.ORCHESTRAI_ORCHESTRATOR_URL ?? `http://localhost:${resolveServicePort("orchestrator", env)}`
  return `${base.replace(/\/$/, "")}/internal/audit-event`
}

function pushToOrchestrator(body: Record<string, unknown>): void {
  void fetch(resolveAuditPushUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AUDIT_PUSH_TIMEOUT_MS),
  }).catch(() => {
    // Intentionally silent — see the comment above. Logging here would be
    // noise on every call when running an agent standalone without the
    // Orchestrator (a supported workflow: `bun run devops-agent` alone).
  })
}

/** Announces a tool/A2A call that is ABOUT to run, so a client can show it
 *  in flight rather than only once it has already finished. Has no
 *  console.log counterpart by design — the existing audit log records
 *  completed calls with their outcome, and duplicating a "starting" line
 *  into it would change existing log output this spec promises not to
 *  touch.
 *
 *  `callId` is minted by the CALLER (mcp-client.ts/a2a-client.ts), not
 *  derived here or on the Orchestrator, and must be reused unchanged in the
 *  matching emitAuditEvent() call once the call finishes. Found live during
 *  this spec's own review: deriving an id from `${taskId}:${kind}:${target}`
 *  works for pairing START/RESULT, but collides if the SAME task calls the
 *  SAME tool twice — a second call's START would silently overwrite the
 *  first's still-in-flight line on a client instead of appearing as its own
 *  entry. Minting a real unique id per call (crypto.randomUUID(), same
 *  convention CLAUDE.md already establishes for producer-generated ids)
 *  removes the collision entirely, with no pairing heuristic on the
 *  Orchestrator side to get wrong if a push is ever dropped (pushes are
 *  explicitly allowed to fail — see pushToOrchestrator above). */
export function emitAuditStart(input: {
  kind: AuditEventInput["kind"]
  caller: string
  target: string
  taskId: string
  callId: string
}): void {
  pushToOrchestrator({
    phase: "start",
    kind: input.kind,
    caller: input.caller,
    target: input.target,
    taskId: input.taskId,
    callId: input.callId,
    outcome: "completed",
    durationMs: 0,
    resultSummary: "",
  })
}

export function emitAuditEvent(input: AuditEventInput): void {
  const summary = [
    input.outcome,
    `resultBytes=${input.resultBytes}`,
    `resultTruncated=${input.resultTruncated}`,
  ].join("; ")

  const event = {
    timestamp: new Date().toISOString(),
    kind: input.kind,
    caller: input.caller,
    target: input.target,
    taskId: input.taskId,
    params: input.params,
    outcome: input.outcome,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    resultSummary: truncateUtf8(summary, AUDIT_SUMMARY_MAX_BYTES),
    resultBytes: input.resultBytes,
    resultTruncated: input.resultTruncated,
  }

  console.log(JSON.stringify({ audit: event }))

  // specs/113-live-audit-log-dashboard/spec.md — computed once, reused
  // for both the durable buffer write below (unchanged) and the live
  // SSE push (new) — never computed twice, and never anything beyond
  // what whitelistAuditParams() already discloses for the durable
  // store.
  const paramsWhitelisted = whitelistAuditParams(input.params)

  pushToOrchestrator({
    phase: "result",
    kind: event.kind,
    caller: event.caller,
    target: event.target,
    taskId: event.taskId,
    callId: input.callId,
    outcome: event.outcome,
    durationMs: event.durationMs,
    resultSummary: event.resultSummary,
    paramsWhitelisted,
    resultBytes: event.resultBytes,
    resultTruncated: event.resultTruncated,
  })

  bufferAuditEvent({
    ts: Date.now(),
    kind: event.kind,
    caller: event.caller,
    target: event.target,
    taskId: event.taskId,
    callId: input.callId ?? null,
    outcome: event.outcome,
    durationMs: event.durationMs,
    resultBytes: event.resultBytes,
    resultTruncated: event.resultTruncated,
    paramsJson: JSON.stringify(paramsWhitelisted),
  })
}

// ============================================================
// specs/108-durable-audit-trail/spec.md B6 — the third sink, batched.
// Neither of the two sinks above changes: console.log stays (what the
// supervisor's own log redirection and every existing test observe),
// the Orchestrator push stays (it feeds live SSE). This is purely
// additive.
// ============================================================

/** The real params object can carry real file paths (`repo_path`,
 *  `relative_path`), a real command line (`run_command`'s own `argv`),
 *  or real file content (`write_project_file`'s own `content`) —
 *  exactly the leak vector `107`'s own `scan-secrets` carve-out already
 *  named for a different table. Kept structurally narrow rather than a
 *  per-tool allowlist: only scalar (boolean/number) fields survive —
 *  every string, array, and nested object is dropped unconditionally,
 *  which is what actually matters (a path, an argv array, and file
 *  content are never booleans or numbers). A short stable hash of the
 *  full params is kept so two calls with identical (but undisclosed)
 *  params can still be correlated without ever storing what they were. */
export function whitelistAuditParams(params: Record<string, unknown>): Record<string, unknown> {
  const whitelisted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "boolean" || typeof value === "number") {
      whitelisted[key] = value
    }
  }
  whitelisted.paramsHash = createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16)
  return whitelisted
}

const AUDIT_FLUSH_INTERVAL_MS = 2000
const AUDIT_FLUSH_SIZE_THRESHOLD = 20

let auditBuffer: AuditEventInsert[] = []
let auditFlushTimer: ReturnType<typeof setInterval> | null = null

function ensureAuditFlushTimerStarted(): void {
  if (auditFlushTimer) return
  auditFlushTimer = setInterval(flushAuditBuffer, AUDIT_FLUSH_INTERVAL_MS)
  auditFlushTimer.unref()
}

/** Never spans an `await` — this codebase's own store.ts safety
 *  constraint for every transaction, and this spec's own explicit one
 *  for batching specifically. A store write failure is accepted and the
 *  buffer dropped rather than retried — audit is a record, not a
 *  control, and the console.log line for every one of these events
 *  already exists regardless. */
function flushAuditBuffer(): void {
  if (auditBuffer.length === 0) return
  const toFlush = auditBuffer
  auditBuffer = []
  const store = getSharedStore()
  if (!store) return
  try {
    store.insertAuditEvents(toFlush)
  } catch {
    // Fail-open — see the doc comment above.
  }
}

function bufferAuditEvent(event: AuditEventInsert): void {
  ensureAuditFlushTimerStarted()
  auditBuffer.push(event)
  if (auditBuffer.length >= AUDIT_FLUSH_SIZE_THRESHOLD) flushAuditBuffer()
}

/** Called from each process's own shutdown() — best-effort, matching
 *  this spec's own "a lost buffer on a hard crash is accepted" stance;
 *  this only catches the clean-shutdown case. */
export function flushAuditBufferForShutdown(): void {
  flushAuditBuffer()
}

/** Test-only seam, mirroring __resetSharedStoreForTests()'s own
 *  established shape — auditBuffer is module-level state shared across
 *  every test in a file, so a test that buffers an event against one
 *  scratch store must not leak it into a later test using a different
 *  one. Discards the buffer without attempting a write (unlike
 *  flushAuditBufferForShutdown(), which tries to persist it). */
export function __resetAuditBufferForTests(): void {
  auditBuffer = []
  if (auditFlushTimer) {
    clearInterval(auditFlushTimer)
    auditFlushTimer = null
  }
}
