// specs/106-persistence-store-and-result-cache/spec.md
//
// A local, optional, fail-open SQLite store — the first persistence
// layer in this codebase's history, crossing a boundary roughly ten
// prior specs (001/004/005/006/009/011/022/023/024/026/028) explicitly
// held as a non-goal. Crossed here for one reason, stated plainly: an
// expensive, real-cost LLM analysis (specs/103, 10-40s per computation)
// was being recomputed by every process and every restart, with no way
// for one process to reuse what another already paid for.
//
// One LOCAL file only — <ORCHESTRAI_PROJECT_PATH>/.orchestrai/orchestrai.db,
// beside the config.env and supervisor.log already written there. No
// network storage, no external service, anywhere in this design.
//
// Strictly optional / fail-open is the load-bearing property: every
// failure path here returns null (or false), never throws past this
// module's own boundary — every caller treats a null store, or a failed
// operation, as "behave exactly as if persistence didn't exist".
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, chmodSync } from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"

const DB_FILENAME = "orchestrai.db"
const CONFIG_DIRNAME = ".orchestrai"

// specs/077's own !== "0" convention: absent, empty, or anything but the
// literal string "0" means on. ORCHESTRAI_PERSIST=0 makes openStore()
// return null unconditionally — the opt-out reuses the exact fail-open
// path every caller already has to handle, at zero extra cost.
function isPersistEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ORCHESTRAI_PERSIST !== "0"
}

function resolveDbPath(env: NodeJS.ProcessEnv): string | null {
  const projectPath = env.ORCHESTRAI_PROJECT_PATH?.trim()
  if (!projectPath) return null
  return path.join(projectPath, CONFIG_DIRNAME, DB_FILENAME)
}

// bun:sqlite is synchronous — every write here is a single
// db.transaction(...)() doing no I/O, never spanning an await, per this
// module's own safety constraint.
export class OrchestraiStore {
  constructor(private readonly db: Database) {}

  // ============================================================
  // result_cache — specs/106 B1, a generic cache keyed on `kind` so it
  // is never shaped around a single consumer. project-analysis is the
  // first kind; OSV.dev lookups (packages/agents/security/osv-client.ts)
  // are the named, deliberately-not-wired-here second candidate.
  // ============================================================

  /** The key is where this either ships its benefit or silently loses
   *  it. No conversation id anywhere in it — conversation-scoping is
   *  exactly what blocked cross-process reuse before this spec.
   *  targetRel/projectRoot are expected to already be the SAME resolved
   *  absolute path string every caller already produces via the one
   *  shared resolveTargetPath() (packages/shared/index.ts) — DevOps and
   *  the Orchestrator both call it today, so no extra relative-path math
   *  is needed here; this function only guards against residual
   *  casing/trailing-separator drift on Windows. */
  private cacheKey(kind: string, projectRoot: string, targetRel: string, inputHash: string, schemaVer: number): string {
    const normalizedRoot = normalizePathForKey(projectRoot)
    const normalizedTarget = normalizePathForKey(targetRel)
    return createHash("sha256").update(`${kind}\0${normalizedRoot}\0${normalizedTarget}\0${inputHash}\0${schemaVer}`).digest("hex")
  }

  /** Returns a cached, still-valid result, or null on any miss —
   *  expired, never computed, still in flight, or a fingerprint check
   *  the caller performs afterward (this function only enforces the TTL;
   *  a git-fingerprint cross-check, when the caller has a cheaper way to
   *  get one, is the caller's own job — see project-analysis.ts's
   *  getCachedProjectAnalysis(), the specs/057/102 pattern). */
  getCachedResult(params: { kind: string; projectRoot: string; targetRel: string; inputHash: string; schemaVer: number }): CachedResultRow | null {
    const key = this.cacheKey(params.kind, params.projectRoot, params.targetRel, params.inputHash, params.schemaVer)
    const row = this.db.query(
      "SELECT result, git_fingerprint AS gitFingerprint, computed_at AS computedAt, expires_at AS expiresAt FROM result_cache WHERE cache_key = ? AND result IS NOT NULL",
    ).get(key) as { result: string; gitFingerprint: string | null; computedAt: number; expiresAt: number } | null
    if (!row) return null
    if (row.expiresAt < Date.now()) return null
    return row
  }

  /** Writes a completed result, replacing any in-flight lease row for
   *  the same key. */
  setCachedResult(params: {
    kind: string; projectRoot: string; targetRel: string; inputHash: string; schemaVer: number
    result: string; gitFingerprint: string | null; ttlMs: number; producer: string
  }): void {
    const key = this.cacheKey(params.kind, params.projectRoot, params.targetRel, params.inputHash, params.schemaVer)
    const now = Date.now()
    const write = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO result_cache (cache_key, kind, project_root, target_rel, input_hash, git_fingerprint, result, lease_until, computed_at, expires_at, producer, schema_ver)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           result = excluded.result, git_fingerprint = excluded.git_fingerprint, lease_until = NULL,
           computed_at = excluded.computed_at, expires_at = excluded.expires_at, producer = excluded.producer`,
        [key, params.kind, params.projectRoot, params.targetRel, params.inputHash, params.gitFingerprint, params.result, now, now + params.ttlMs, params.producer, params.schemaVer],
      )
    })
    write()
  }

  /** Concurrent-stampede guard (specs/106's own named risk): a caller
   *  about to compute an expensive result first tries to acquire a
   *  lease. Returns true if this caller now owns computing it (no
   *  existing valid result, no other unexpired lease); false if another
   *  process already owns it — the caller should then either poll
   *  waitForLease() or simply proceed to compute anyway (never blocking
   *  forever; a lease is advisory, not a lock other processes cannot
   *  override once it expires). */
  tryAcquireLease(params: { kind: string; projectRoot: string; targetRel: string; inputHash: string; schemaVer: number; leaseMs: number }): boolean {
    const key = this.cacheKey(params.kind, params.projectRoot, params.targetRel, params.inputHash, params.schemaVer)
    const now = Date.now()
    let acquired = false
    const attempt = this.db.transaction(() => {
      const existing = this.db.query(
        "SELECT result, lease_until AS leaseUntil, expires_at AS expiresAt FROM result_cache WHERE cache_key = ?",
      ).get(key) as { result: string | null; leaseUntil: number | null; expiresAt: number } | null

      if (existing) {
        const hasValidResult = existing.result !== null && existing.expiresAt >= now
        const hasActiveLease = existing.leaseUntil !== null && existing.leaseUntil >= now
        if (hasValidResult || hasActiveLease) return
      }

      this.db.run(
        `INSERT INTO result_cache (cache_key, kind, project_root, target_rel, input_hash, git_fingerprint, result, lease_until, computed_at, expires_at, producer, schema_ver)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, 'lease', ?)
         ON CONFLICT(cache_key) DO UPDATE SET result = NULL, lease_until = excluded.lease_until, expires_at = excluded.expires_at`,
        [key, params.kind, params.projectRoot, params.targetRel, params.inputHash, now + params.leaseMs, now + params.leaseMs, params.schemaVer],
      )
      acquired = true
    })
    attempt()
    return acquired
  }

  /** Best-effort read of an in-flight or just-completed lease, for a
   *  caller that lost tryAcquireLease() and wants to wait briefly rather
   *  than immediately recompute. Never blocks internally — a single
   *  point-in-time check; polling (if a caller wants it) is the
   *  caller's own loop with its own bounded budget, mirroring the
   *  "bounded, never hang" precedent every timeout in this codebase
   *  already follows. */
  peekResult(params: { kind: string; projectRoot: string; targetRel: string; inputHash: string; schemaVer: number }): CachedResultRow | null {
    return this.getCachedResult(params)
  }

  // ============================================================
  // Retention — specs/106 B2, called only by the Orchestrator (one
  // owner, no cross-process contention).
  // ============================================================
  pruneResultCache(maxRows: number): void {
    const now = Date.now()
    const prune = this.db.transaction(() => {
      this.db.run("DELETE FROM result_cache WHERE expires_at < ? AND result IS NOT NULL", [now])
      // Stale leases (a process that acquired one and crashed before
      // finishing) — never held onto past their own lease_until.
      this.db.run("DELETE FROM result_cache WHERE result IS NULL AND lease_until < ?", [now])
      this.db.run(
        `DELETE FROM result_cache WHERE cache_key IN (
           SELECT cache_key FROM result_cache WHERE result IS NOT NULL
           ORDER BY computed_at DESC LIMIT -1 OFFSET ?
         )`,
        [maxRows],
      )
    })
    prune()
  }

  // ============================================================
  // tasks — specs/107 B4. Written on every task's terminal transition
  // (completed/failed). The in-memory `tasks` Map on each process stays
  // the live working set; this table is the durable record.
  //
  // The scan-secrets redaction is enforced HERE, structurally, by skill
  // id — never left to a caller's own discipline. Every other skill's
  // result is stored in full (already bounded by boundTaskResult()
  // before it ever reaches this method).
  // ============================================================
  upsertTask(params: {
    taskId: string; agent: string | null; skill: string; status: string
    paramsJson: string | null; result: string | null; resultTruncated: boolean
    conversationId: string | null; createdAt: number; updatedAt: number
  }): void {
    const redacted = params.skill === "scan-secrets"
    const result = redacted ? null : params.result
    this.db.run(
      `INSERT INTO tasks (task_id, agent, skill, status, params_json, result, result_truncated, redacted, conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         agent = excluded.agent, skill = excluded.skill, status = excluded.status,
         params_json = excluded.params_json, result = excluded.result,
         result_truncated = excluded.result_truncated, redacted = excluded.redacted,
         conversation_id = excluded.conversation_id, updated_at = excluded.updated_at`,
      [
        params.taskId, params.agent, params.skill, params.status, params.paramsJson,
        result, params.resultTruncated ? 1 : 0, redacted ? 1 : 0,
        params.conversationId, params.createdAt, params.updatedAt,
      ],
    )
  }

  getTask(taskId: string): TaskRow | null {
    const row = this.db.query(
      `SELECT task_id AS taskId, agent, skill, status, params_json AS paramsJson, result,
              result_truncated AS resultTruncated, redacted, conversation_id AS conversationId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM tasks WHERE task_id = ?`,
    ).get(taskId) as TaskRow | null
    return row
  }

  /** Most recent terminal tasks, newest first — specs/091's own
   *  "why did it fail?" reads this after a restart, when the in-memory
   *  task Map is empty. */
  listRecentTasks(limit: number, status?: string): TaskRow[] {
    const query = status
      ? this.db.query(
          `SELECT task_id AS taskId, agent, skill, status, params_json AS paramsJson, result,
                  result_truncated AS resultTruncated, redacted, conversation_id AS conversationId,
                  created_at AS createdAt, updated_at AS updatedAt
           FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
        )
      : this.db.query(
          `SELECT task_id AS taskId, agent, skill, status, params_json AS paramsJson, result,
                  result_truncated AS resultTruncated, redacted, conversation_id AS conversationId,
                  created_at AS createdAt, updated_at AS updatedAt
           FROM tasks ORDER BY created_at DESC LIMIT ?`,
        )
    const rows = status ? query.all(status, limit) : query.all(limit)
    return rows as TaskRow[]
  }

  // ============================================================
  // conversations / turns — specs/107 B5.
  // ============================================================
  upsertConversation(params: { id: string; title: string | null; createdAt: number; updatedAt: number }): void {
    this.db.run(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      [params.id, params.title, params.createdAt, params.updatedAt],
    )
  }

  appendTurnRow(params: { conversationId: string; seq: number; role: string; content: string; createdAt: number }): void {
    this.db.run(
      `INSERT INTO turns (conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, seq) DO UPDATE SET role = excluded.role, content = excluded.content`,
      [params.conversationId, params.seq, params.role, params.content, params.createdAt],
    )
  }

  /** Most recently active conversations, each with its turns in order —
   *  what the Orchestrator loads at startup so the chat rail and
   *  priorTurnsFor() see history from before a restart. */
  listRecentConversationsWithTurns(limit: number): ConversationWithTurnsRow[] {
    const conversationRows = this.db.query(
      `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
       FROM conversations ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as { id: string; title: string | null; createdAt: number; updatedAt: number }[]
    return conversationRows.map((conv) => {
      const turns = this.db.query(
        `SELECT seq, role, content, created_at AS createdAt FROM turns WHERE conversation_id = ? ORDER BY seq ASC`,
      ).all(conv.id) as { seq: number; role: string; content: string; createdAt: number }[]
      return { ...conv, turns }
    })
  }

  // ============================================================
  // Retention — specs/107, added to specs/106 B2's own
  // Orchestrator-only sweep.
  // ============================================================
  pruneTasks(maxAgeMs: number, maxRows: number): void {
    const cutoff = Date.now() - maxAgeMs
    const prune = this.db.transaction(() => {
      this.db.run("DELETE FROM tasks WHERE created_at < ?", [cutoff])
      this.db.run(
        `DELETE FROM tasks WHERE task_id IN (
           SELECT task_id FROM tasks ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )`,
        [maxRows],
      )
    })
    prune()
  }

  pruneConversations(maxConversations: number, maxTurnsPerConversation: number): void {
    const prune = this.db.transaction(() => {
      // Cascade (ON DELETE CASCADE on turns.conversation_id) removes the
      // dropped conversations' own turns for free.
      this.db.run(
        `DELETE FROM conversations WHERE id IN (
           SELECT id FROM conversations ORDER BY updated_at DESC LIMIT -1 OFFSET ?
         )`,
        [maxConversations],
      )
      // Per-conversation turn cap — oldest trimmed first, independent of
      // the conversation-count cap above.
      this.db.run(
        `DELETE FROM turns WHERE id IN (
           SELECT t.id FROM turns t
           WHERE (
             SELECT COUNT(*) FROM turns t2
             WHERE t2.conversation_id = t.conversation_id AND t2.seq >= t.seq
           ) > ?
         )`,
        [maxTurnsPerConversation],
      )
    })
    prune()
  }

  // ============================================================
  // audit_events — specs/108-durable-audit-trail/spec.md B6. The one
  // genuinely high-volume table (a row per MCP/A2A call, not per task),
  // so writes arrive here already batched by the caller
  // (packages/shared/audit.ts) — insertAuditEvents() takes an array and
  // writes it in one transaction, never one row at a time.
  // ============================================================
  insertAuditEvents(events: AuditEventInsert[]): void {
    if (events.length === 0) return
    const insert = this.db.transaction((rows: AuditEventInsert[]) => {
      for (const e of rows) {
        this.db.run(
          `INSERT INTO audit_events (ts, kind, caller, target, task_id, call_id, outcome, duration_ms, result_bytes, result_truncated, params_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [e.ts, e.kind, e.caller, e.target, e.taskId, e.callId, e.outcome, e.durationMs, e.resultBytes, e.resultTruncated ? 1 : 0, e.paramsJson],
        )
      }
    })
    insert(events)
  }

  /** Newest first. `taskId` narrows to one task's own correlated events
   *  (both a parent-task-id and an agent's own local task id may appear
   *  as `taskId` depending on which process wrote the row — callers
   *  pass whichever id they have). */
  /** specs/136 — `taskIds` matches any of several ids (a task's own id and
   *  the `orch-<id>` its agent records under); `taskId` is the one-id form. */
  listAuditEvents(params: { taskId?: string; taskIds?: string[]; limit: number }): AuditEventRow[] {
    const ids = params.taskIds ?? (params.taskId ? [params.taskId] : [])
    const columns = `SELECT id, ts, kind, caller, target, task_id AS taskId, call_id AS callId, outcome,
                  duration_ms AS durationMs, result_bytes AS resultBytes, result_truncated AS resultTruncated,
                  params_json AS paramsJson
           FROM audit_events`
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(", ")
      const query = this.db.query(`${columns} WHERE task_id IN (${placeholders}) ORDER BY ts DESC LIMIT ?`)
      return query.all(...ids, params.limit) as AuditEventRow[]
    }
    return this.db.query(`${columns} ORDER BY ts DESC LIMIT ?`).all(params.limit) as AuditEventRow[]
  }

  pruneAuditEvents(maxAgeMs: number, maxRows: number): void {
    const cutoff = Date.now() - maxAgeMs
    const prune = this.db.transaction(() => {
      this.db.run("DELETE FROM audit_events WHERE ts < ?", [cutoff])
      this.db.run(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events ORDER BY ts DESC LIMIT -1 OFFSET ?
         )`,
        [maxRows],
      )
    })
    prune()
  }

  // ============================================================
  // pending_actions — specs/110-approval-state-survives-a-restart/spec.md
  // B0. The atomic claim (claimPendingAction) — not Map.delete() — is
  // the real single-consumption boundary once this table is in use: two
  // concurrent approve requests against the same restored action can
  // never both succeed. `payload_json` holds each agent's own real,
  // private PendingAction shape, JSON-serialized verbatim — never a
  // shared cross-agent schema; only the agent that wrote a row ever
  // reads it back, keyed by its own `agent` name.
  // ============================================================
  upsertPendingAction(params: {
    agent: string; taskId: string; actionId: string; kind: string; skill: string
    payloadJson: string; createdAt: number; expiresAt: number
  }): void {
    this.db.run(
      `INSERT INTO pending_actions (agent, task_id, action_id, kind, skill, payload_json, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(agent, task_id) DO UPDATE SET
         action_id = excluded.action_id, kind = excluded.kind, skill = excluded.skill,
         payload_json = excluded.payload_json, status = 'pending',
         created_at = excluded.created_at, expires_at = excluded.expires_at`,
      [params.agent, params.taskId, params.actionId, params.kind, params.skill, params.payloadJson, params.createdAt, params.expiresAt],
    )
  }

  /** The real single-consumption boundary. Returns true only if this
   *  call transitioned a genuinely `'pending'` row to `'claimed'` —
   *  false if the row was already claimed, already gone, or never
   *  existed. A caller that gets `false` must not proceed: it never
   *  reads a payload it hasn't itself claimed. */
  claimPendingAction(params: { agent: string; taskId: string }): boolean {
    let claimed = false
    const attempt = this.db.transaction(() => {
      const result = this.db.run(
        `UPDATE pending_actions SET status = 'claimed' WHERE agent = ? AND task_id = ? AND status = 'pending'`,
        [params.agent, params.taskId],
      )
      claimed = result.changes > 0
    })
    attempt()
    return claimed
  }

  /** Called after a successful write, an ordinary (non-crash) failure,
   *  or a reject — every path that today calls the in-memory
   *  `pendingActions.delete()`. */
  deletePendingAction(params: { agent: string; taskId: string }): void {
    this.db.run(`DELETE FROM pending_actions WHERE agent = ? AND task_id = ?`, [params.agent, params.taskId])
  }

  /** For startup restore only. A `'claimed'` row — a crash between
   *  claiming and finishing — is never returned here, regardless of its
   *  own expiry; see this spec's own "Crash during execution" section
   *  for why re-resuming one is never safe. */
  listUnexpiredPendingActions(params: { agent: string; now: number }): PendingActionRow[] {
    const rows = this.db.query(
      `SELECT agent, task_id AS taskId, action_id AS actionId, kind, skill, payload_json AS payloadJson,
              status, created_at AS createdAt, expires_at AS expiresAt
       FROM pending_actions WHERE agent = ? AND status = 'pending' AND expires_at > ?`,
    ).all(params.agent, params.now)
    return rows as PendingActionRow[]
  }

  /** Deletes expired `'pending'` rows and every `'claimed'` row
   *  regardless of expiry (an unresolved claim always means an
   *  ambiguous, possibly-crashed execution — never re-tried, never left
   *  around indefinitely either). Wired into the Orchestrator's own
   *  existing retention sweep, not a new interval. */
  pruneExpiredPendingActions(now: number): void {
    const prune = this.db.transaction(() => {
      this.db.run(`DELETE FROM pending_actions WHERE status = 'pending' AND expires_at < ?`, [now])
      this.db.run(`DELETE FROM pending_actions WHERE status = 'claimed'`)
    })
    prune()
  }

  /** Direct escape hatch for callers (currently none) that need a raw
   *  query this class doesn't wrap — deliberately narrow surface for
   *  everything else. */
  close(): void {
    this.db.close()
  }
}

export interface PendingActionRow {
  agent: string
  taskId: string
  actionId: string
  kind: string
  skill: string
  payloadJson: string
  status: string
  createdAt: number
  expiresAt: number
}

export interface AuditEventInsert {
  ts: number
  kind: string
  caller: string
  target: string
  taskId: string | null
  callId: string | null
  outcome: string
  durationMs: number
  resultBytes: number
  resultTruncated: boolean
  paramsJson: string | null
}

export interface AuditEventRow {
  id: number
  ts: number
  kind: string
  caller: string
  target: string
  taskId: string | null
  callId: string | null
  outcome: string
  durationMs: number
  resultBytes: number
  resultTruncated: number
  paramsJson: string | null
}

export interface TaskRow {
  taskId: string
  agent: string | null
  skill: string
  status: string
  paramsJson: string | null
  result: string | null
  resultTruncated: number
  redacted: number
  conversationId: string | null
  createdAt: number
  updatedAt: number
}

export interface ConversationWithTurnsRow {
  id: string
  title: string | null
  createdAt: number
  updatedAt: number
  turns: { seq: number; role: string; content: string; createdAt: number }[]
}

export interface CachedResultRow {
  result: string
  gitFingerprint: string | null
  computedAt: number
  expiresAt: number
}

function normalizePathForKey(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "")
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS result_cache (
     cache_key       TEXT PRIMARY KEY,
     kind            TEXT NOT NULL,
     project_root    TEXT NOT NULL,
     target_rel      TEXT NOT NULL,
     input_hash      TEXT NOT NULL,
     git_fingerprint TEXT,
     result          TEXT,
     lease_until     INTEGER,
     computed_at     INTEGER,
     expires_at      INTEGER NOT NULL,
     producer        TEXT NOT NULL,
     schema_ver      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_result_cache_expiry ON result_cache(expires_at)`,
  // specs/107-task-and-conversation-history/spec.md B4/B5.
  `CREATE TABLE IF NOT EXISTS tasks (
     task_id          TEXT PRIMARY KEY,
     agent            TEXT, skill TEXT, status TEXT,
     params_json      TEXT,
     result           TEXT,
     result_truncated INTEGER,
     redacted         INTEGER NOT NULL DEFAULT 0,
     conversation_id  TEXT,
     created_at       INTEGER, updated_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS ix_tasks_created ON tasks(created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_tasks_conv ON tasks(conversation_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS turns (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     seq             INTEGER NOT NULL,
     role            TEXT, content TEXT, created_at INTEGER
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_turns ON turns(conversation_id, seq)`,
  // specs/108-durable-audit-trail/spec.md B6.
  `CREATE TABLE IF NOT EXISTS audit_events (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     ts               INTEGER NOT NULL,
     kind             TEXT, caller TEXT, target TEXT,
     task_id          TEXT, call_id TEXT,
     outcome          TEXT, duration_ms INTEGER,
     result_bytes     INTEGER, result_truncated INTEGER,
     params_json      TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_events(ts)`,
  `CREATE INDEX IF NOT EXISTS ix_audit_task ON audit_events(task_id)`,
  // specs/110-approval-state-survives-a-restart/spec.md B0.
  `CREATE TABLE IF NOT EXISTS pending_actions (
     agent        TEXT NOT NULL,
     task_id      TEXT NOT NULL,
     action_id    TEXT NOT NULL,
     kind         TEXT NOT NULL,
     skill        TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     status       TEXT NOT NULL DEFAULT 'pending',
     created_at   INTEGER NOT NULL,
     expires_at   INTEGER NOT NULL,
     PRIMARY KEY (agent, task_id)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_actions_action_id ON pending_actions(action_id)`,
  `CREATE INDEX IF NOT EXISTS ix_pending_actions_expiry ON pending_actions(expires_at)`,
]

const CURRENT_USER_VERSION = 4

/** Idempotent, race-safe: every one of this codebase's eight processes
 *  may run this simultaneously at boot. CREATE TABLE IF NOT EXISTS is
 *  already idempotent on its own; the BEGIN IMMEDIATE wrapper additionally
 *  serializes concurrent first-opens against each other rather than
 *  relying on that alone. */
function migrate(db: Database): void {
  const run = db.transaction(() => {
    for (const statement of SCHEMA_STATEMENTS) db.run(statement)
    db.run(`PRAGMA user_version = ${CURRENT_USER_VERSION}`)
  })
  run.immediate()
}

export interface OpenStoreOptions {
  /** Test-only override — bypasses ORCHESTRAI_PROJECT_PATH resolution
   *  entirely. Pass ":memory:" or a unique temp file path; per this
   *  spec's own test-isolation requirement, never a shared default path
   *  (this codebase's suites run in parallel). */
  dbPathOverride?: string
}

/** The single entry point. Returns null — never throws — for:
 *  ORCHESTRAI_PERSIST=0, no ORCHESTRAI_PROJECT_PATH configured, a
 *  directory that cannot be created, a database that cannot be opened,
 *  WAL mode not adopted (a real risk on a OneDrive/Dropbox-synced local
 *  folder or certain filesystem mounts — eight processes sharing a file
 *  in a mode that cannot support them is worse than no store at all), or
 *  migration failing. Every failure is logged once, at warn level, never
 *  silently swallowed — but never thrown past this function either. */
export function openStore(env: NodeJS.ProcessEnv = process.env, options: OpenStoreOptions = {}): OrchestraiStore | null {
  if (!isPersistEnabled(env)) return null

  const dbPath = options.dbPathOverride ?? resolveDbPath(env)
  if (!dbPath) return null

  const isRealFile = dbPath !== ":memory:"
  if (isRealFile) {
    try {
      const dir = path.dirname(dbPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    } catch (err) {
      console.warn(`[store] disabled — could not create directory for ${dbPath}: ${errorMessage(err)}`)
      return null
    }
  }

  let db: Database
  try {
    db = new Database(dbPath, { create: true })
  } catch (err) {
    console.warn(`[store] disabled — could not open ${dbPath}: ${errorMessage(err)}`)
    return null
  }

  try {
    // WAL is meaningless (and not really "adopted" in any checkable
    // sense) for an in-memory database — it's never shared across
    // processes in the first place, so this check is skipped for
    // ":memory:" specifically, real files always go through it.
    if (isRealFile) {
      const walResult = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | null
      const adopted = walResult?.journal_mode?.toLowerCase() === "wal"
      if (!adopted) {
        console.warn(`[store] disabled — WAL mode was not adopted for ${dbPath} (got "${walResult?.journal_mode}") — likely a synced folder or unsupported filesystem; running with a store here risks corruption across this codebase's multiple processes`)
        db.close()
        return null
      }
    }

    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA synchronous = NORMAL")
    // Required for `turns`'s own ON DELETE CASCADE (specs/107) to
    // actually fire — SQLite ignores foreign-key actions by default.
    // Must be set per-connection, every open, not just at creation.
    db.run("PRAGMA foreign_keys = ON")
    // auto_vacuum must be set before any table is created — harmless to
    // set again on a re-open of an already-migrated database (SQLite
    // silently ignores it once pages exist), but must be attempted here,
    // first, for a genuinely fresh database file.
    db.run("PRAGMA auto_vacuum = INCREMENTAL")

    migrate(db)

    if (isRealFile) {
      try {
        chmodSync(dbPath, 0o600)
      } catch {
        // Best-effort — Windows ACL semantics don't map cleanly onto
        // chmod; never a reason to disable the store over it.
      }
    }
  } catch (err) {
    console.warn(`[store] disabled — setup failed for ${dbPath}: ${errorMessage(err)}`)
    try { db.close() } catch { /* already broken, nothing more to do */ }
    return null
  }

  return new OrchestraiStore(db)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ============================================================
// Per-process singleton — every module in this process (DevOps's own
// skill, the Orchestrator's fallback, specs/107/108's own future call
// sites) shares ONE open handle rather than re-opening the file (and
// re-running the WAL check) on every call. Each of this codebase's
// eight processes gets its own separate instance of this module-level
// variable — there is no cross-process sharing at the JS level, only at
// the SQLite file level, which is the entire point.
// ============================================================
let sharedStore: OrchestraiStore | null | undefined // undefined = not yet attempted

export function getSharedStore(env: NodeJS.ProcessEnv = process.env): OrchestraiStore | null {
  if (sharedStore === undefined) {
    sharedStore = openStore(env)
  }
  return sharedStore
}

/** Test-only seam, mirroring __setTestOrchestratorMcpClient()'s own
 *  established shape — forces the next getSharedStore() call to
 *  re-attempt opening rather than reusing a handle (or a cached
 *  failure) left over from a previous test. Closes the current handle
 *  first (if one is open) so a real on-disk file isn't left locked —
 *  on Windows, an open SQLite handle blocks even rm -rf on its own
 *  scratch directory. */
export function __resetSharedStoreForTests(): void {
  try {
    sharedStore?.close()
  } catch {
    // Already broken/closed — nothing more to do.
  }
  sharedStore = undefined
}

// ============================================================
// Agent-side task persistence sweep — specs/107-task-and-conversation-
// history/spec.md B4's own "a directly-dispatched task is still
// recorded" requirement, for an agent whose own in-memory task Map has
// no single terminal-transition hook the way the Orchestrator's own
// emitTaskState() does (each agent mutates its task Map from many
// scattered call sites). Rather than touch every one of those call
// sites, this polls the SAME Map every one of them already writes to,
// and persists a task exactly once, the moment it first observes a
// terminal status — mirroring this codebase's own established
// populateSnapshotCacheWhenTaskTerminates() polling precedent
// (specs/057) for the identical reason: cheaper and far lower-risk
// than rewiring every mutation site.
// ============================================================
export interface SweepableTask {
  id: string
  status: string
  result?: string
}

/** Starts a periodic sweep over `tasks`, persisting any task that has
 *  reached a terminal status ("completed"/"failed") for the first time.
 *  `meta(taskId)` supplies the skill and creation time this generic Map
 *  shape doesn't itself carry — return null to skip a task whose meta
 *  isn't (yet) recorded, rather than persisting a guess. Returns a
 *  stop() function; the caller's own shutdown() should call it so the
 *  interval doesn't keep the process alive after signal handling.
 *  Fail-open throughout: a missing/disabled store makes every sweep a
 *  no-op, exactly like every other caller in this module. */
export function startTaskPersistenceSweep(
  agentName: string,
  tasks: Map<string, SweepableTask>,
  meta: (taskId: string) => { skill: string; createdAt: number } | null,
  intervalMs = 5000,
): () => void {
  const persisted = new Set<string>()
  function sweepOnce(): void {
    const store = getSharedStore()
    if (!store) return
    for (const task of tasks.values()) {
      if (task.status !== "completed" && task.status !== "failed") continue
      if (persisted.has(task.id)) continue
      const info = meta(task.id)
      if (!info) continue
      persisted.add(task.id)
      try {
        store.upsertTask({
          taskId: task.id, agent: agentName, skill: info.skill, status: task.status,
          paramsJson: null, result: task.result ?? null, resultTruncated: false,
          conversationId: null, createdAt: info.createdAt, updatedAt: Date.now(),
        })
      } catch {
        // Fail-open — a persistence failure must never affect the live
        // task, which has already completed successfully in memory.
      }
    }
  }
  sweepOnce()
  const timer = setInterval(sweepOnce, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
