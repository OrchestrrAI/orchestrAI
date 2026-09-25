import { randomUUID, createHash } from "node:crypto"

// ============================================================
// STRUCTURED INFORMED APPROVAL CONTRACT
// ============================================================
// See specs/006-runtime-stabilization/spec.md "Structured Informed Approval
// Contract". `actionId` is a stale-action/correlation guard, not a secret,
// authorization token, or proof of human identity.

export interface ApprovalPreview {
  actionId: string
  kind: "mcp-tool" | "file-write" | "command"
  summary: string
  target: string
  toolName?: string
  parameters?: Record<string, unknown>
  executable?: string
  argv?: string[]
  cwd?: string
  timeoutMs?: number
  overwrite?: boolean
  risks: string[]
  /** specs/040-approval-preview-content-diff/spec.md — the exact content
   *  that will be written if approved. Computed once at preview time and
   *  reused verbatim at write time, never recomputed — what a human
   *  approves must be exactly what gets written. Always the full,
   *  uncapped value; any size cap applied before rendering is a client-
   *  side display decision only (see packages/shared/line-diff.ts),
   *  never applied here. */
  content?: string
  /** The file's current content, present only when `overwrite` is true
   *  and a previous version genuinely exists — lets a client render a
   *  diff instead of two unrelated blocks. Absent for a fresh create. */
  previousContent?: string
  /** specs/056-devops-preflight-and-idempotent-writes/spec.md — a
   *  deterministic fingerprint of the target's content AT PREVIEW TIME
   *  (computeContentFingerprint() below), re-checked immediately before
   *  the real write happens. A mismatch means the target changed after
   *  approval but before execution — the write must be refused rather
   *  than silently overwrite content the human never actually reviewed.
   *  This closes the drift window specs/040 already closed between
   *  preview-computation and approval; this field extends the same
   *  guarantee to cover a change occurring AFTER approval too. */
  fingerprint?: string
  /** specs/114-coder-multi-file-edit-and-create/spec.md — an additive
   *  divergence for a multi-file proposal, mirroring how commit-changes
   *  (specs/079) already diverges from the single-file shape without
   *  needing its own `kind`. Used only by Coder's `edit-files` skill;
   *  every other write-capable skill leaves this `undefined` and keeps
   *  using the single-file `content`/`previousContent`/`fingerprint`
   *  fields above unchanged. `target` still carries a short
   *  human-readable summary (e.g. "3 files in src/ (2 edits, 1 new)")
   *  for a client that doesn't render this field. */
  files?: {
    target: string
    action: "edit" | "create"
    content?: string
    previousContent?: string
    fingerprint: string
  }[]
}

/** Creates a new random actionId for a freshly-prepared pending action. */
export function newActionId(): string {
  return randomUUID()
}

/** specs/056-devops-preflight-and-idempotent-writes/spec.md — a stable,
 *  content-only fingerprint (never the full content again — `content`/
 *  `previousContent` already carry that). `undefined` (target genuinely
 *  absent) gets its own distinct sentinel so a `create` is fingerprinted
 *  too, not skipped — a file appearing between preview and write is
 *  exactly the kind of drift this exists to catch. */
export function computeContentFingerprint(content: string | undefined): string {
  if (content === undefined) return "absent"
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

export type ApproveRejectValidation =
  | { ok: true }
  | { ok: false; status: 400 | 409; error: string }

/**
 * Validates an approve/reject request body against the immutable pending
 * action's actionId. Extra request fields never influence execution — only
 * the actionId is read.
 */
export function validateActionId(
  body: unknown,
  pendingActionId: string | undefined,
): ApproveRejectValidation {
  const actionId = isPlainObject(body) ? body.actionId : undefined
  if (typeof actionId !== "string" || actionId.length === 0) {
    return { ok: false, status: 400, error: "'actionId' must be a non-empty string" }
  }
  if (!pendingActionId) {
    return { ok: false, status: 409, error: "No pending action for this task" }
  }
  if (actionId !== pendingActionId) {
    return { ok: false, status: 409, error: "Stale or mismatched actionId" }
  }
  return { ok: true }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
