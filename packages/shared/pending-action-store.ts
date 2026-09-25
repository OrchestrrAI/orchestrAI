// specs/110-approval-state-survives-a-restart/spec.md
//
// A thin, generic layer over store.ts's own pending_actions table
// (packages/shared/store.ts B0) — every agent-specific PendingAction
// shape and validation lives in each agent's own index.ts (this module
// knows nothing about them; `payload` is generic). Fail-open throughout,
// matching every other store.ts caller in this codebase: a missing/
// disabled store degrades every function here to a safe no-op, and
// every write-capable agent's own resumeTask() must keep working
// exactly as it did before this spec when persistence is unavailable —
// the in-memory Map remains the sole source of truth in that case.
import { getSharedStore } from "./store"

export type PendingActionKind = "write" | "command"

// specs/110's own B0 — deliberately different per kind. Write approvals
// have a real content fingerprint to re-check before executing,
// so 24h (matching specs/106's own project-analysis cache TTL
// precedent) is a reasonable window to survive a realistic redeploy.
// Command approvals have NO fingerprint — nothing re-verifies the
// target state before an approved argv runs — so this TTL is the ONLY
// guard bounding how stale an approval-to-execute can be, and is kept
// deliberately short.
export const PENDING_ACTION_TTL_MS: Record<PendingActionKind, number> = {
  write: 24 * 60 * 60 * 1000,
  command: 60 * 60 * 1000,
}

/** Called at the exact same moment the in-memory `pendingActions.set()`
 *  already happens, before the task is marked `input-required`. A store
 *  failure never blocks the approval flow — the in-memory Map is always
 *  populated regardless of whether this succeeds. */
export function persistPendingAction(params: {
  agent: string
  taskId: string
  actionId: string
  kind: PendingActionKind
  skill: string
  payload: unknown
}): void {
  const store = getSharedStore()
  if (!store) return
  try {
    const now = Date.now()
    store.upsertPendingAction({
      agent: params.agent,
      taskId: params.taskId,
      actionId: params.actionId,
      kind: params.kind,
      skill: params.skill,
      payloadJson: JSON.stringify(params.payload),
      createdAt: now,
      expiresAt: now + PENDING_ACTION_TTL_MS[params.kind],
    })
  } catch {
    // Fail-open — see the module-level comment above.
  }
}

/** The real single-consumption boundary once persistence is enabled.
 *  Returns `true` when it is safe to proceed: either the store is
 *  unavailable (nothing to claim — the in-memory Map alone already
 *  provides intra-process atomicity, exactly as it did before this
 *  spec, so this is deliberately permissive rather than blocking every
 *  approval on a store that was never asked to exist), or a genuinely
 *  `'pending'` row was found and atomically transitioned to `'claimed'`.
 *  Returns `false` only when the store IS available and the row was
 *  already claimed, already gone, or never existed — the caller must
 *  refuse to proceed in that case, never fall back to the in-memory
 *  Map alone once a store is in play. */
export function claimPendingAction(params: { agent: string; taskId: string }): boolean {
  const store = getSharedStore()
  if (!store) return true
  try {
    return store.claimPendingAction(params)
  } catch {
    // A store error here must never be the reason an ordinary approve
    // that would have worked before this spec now fails — fail-open.
    return true
  }
}

/** Called after a successful write, an ordinary (non-crash) failure, or
 *  a reject — every path that already calls `pendingActions.delete()`
 *  on the in-memory Map. */
export function forgetPendingAction(params: { agent: string; taskId: string }): void {
  const store = getSharedStore()
  if (!store) return
  try {
    store.deletePendingAction(params)
  } catch {
    // Fail-open.
  }
}

export interface RestoredPendingAction<T> {
  taskId: string
  actionId: string
  kind: string
  skill: string
  payload: T
}

/** Called once, at `start()`, before the HTTP server binds. `validate`
 *  is each agent's own strict, fail-closed parser (a Zod schema's own
 *  `.safeParse()`, typically) — a row that fails to parse as JSON, or
 *  fails validation, is discarded exactly like an expired one, never
 *  partially trusted. This is the concrete answer to this spec's own
 *  sharpest safety finding: a lossy round-trip must never silently
 *  produce an action that skips its own drift recheck. */
export function restorePendingActions<T>(params: {
  agent: string
  validate: (raw: unknown) => T | null
}): RestoredPendingAction<T>[] {
  const store = getSharedStore()
  if (!store) return []
  const restored: RestoredPendingAction<T>[] = []
  try {
    const rows = store.listUnexpiredPendingActions({ agent: params.agent, now: Date.now() })
    for (const row of rows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.payloadJson)
      } catch {
        console.warn(`[pending-actions] discarding unparseable restored action for ${params.agent}/${row.taskId}`)
        forgetPendingAction({ agent: params.agent, taskId: row.taskId })
        continue
      }
      const validated = params.validate(parsed)
      if (validated === null) {
        console.warn(`[pending-actions] discarding invalid restored action for ${params.agent}/${row.taskId}`)
        forgetPendingAction({ agent: params.agent, taskId: row.taskId })
        continue
      }
      restored.push({ taskId: row.taskId, actionId: row.actionId, kind: row.kind, skill: row.skill, payload: validated })
    }
  } catch {
    return []
  }
  return restored
}
