---
id: 107-task-and-conversation-history
title: "Tasks and Chat Survive a Restart"
area: orchestrator
change_type: feature
status: implemented
verification: verified
created: 2026-09-22
updated: 2026-09-22
approved_by: Yusuf
approved_on: 2026-09-22
implemented_on: 2026-09-22
amends:
  - 044-conversational-ask-layer
  - 091-chat-explain-last-failure
  - 106-persistence-store-and-result-cache
related:
  - 043-llm-harness-security
  - 046-browser-conversation-operations-workspace
  - 056-devops-preflight-and-idempotent-writes
  - 075-real-conversational-chat
  - 108-durable-audit-trail
supersedes: []
superseded_by: []
---

# Spec: Tasks and Chat Survive a Restart

> Status: **IMPLEMENTED, VERIFIED, 2026-09-22.** Third of four specs from
> one approved plan (105/106/107/108). Depends on `specs/106`, which
> introduces the store and records the persistence reversal — this spec
> does not restate that rationale. Yusuf, 2026-09-21: *"a place to save
> the chat, the resualts so on."* See `verification.md` for the full
> record, including a real, previously-undiscovered bug found and fixed
> during this spec's own test-writing: `persistTaskTerminal()`'s first
> version stored `task.result` for every task, including a **failed**
> one — but `OrchestratorTask` only ever sets `result` on success; a
> failed task's real detail lives in `task.error`. This silently made
> `answerLastFailureFromState()`'s own store-fallback branch (the exact
> feature this spec's acceptance criteria name) return "(no further
> detail recorded)" for every failure once the in-memory task Map was
> empty — caught by a dedicated test, not by inspection, before this
> spec was ever called done.

## Purpose

Task results and chat conversations outlive the process that produced
them, so history is visible after a restart and the "why did it fail?"
feature (`specs/091`) has something to walk.

## Current behavior

- Orchestrator `tasks` Map (`apps/orchestrator/index.ts:129`) —
  **unbounded, no eviction**, and the single largest loss on restart:
  every task, result, status and plan child.
- Each agent's own `tasks` Map — unbounded, per process.
- `conversations` Map (`:335`) — bounded (`MAX_CONVERSATIONS = 50`,
  `MAX_TURNS_PER_CONVERSATION = 100`), oldest-first eviction. Restart the
  Orchestrator and every chat thread is gone.
- `answerLastFailureFromState()` (`specs/091`) walks the in-memory task
  store — after a restart it has nothing to find.

## Proposed behavior

### B4 — `tasks`

```sql
CREATE TABLE IF NOT EXISTS tasks (
  task_id          TEXT PRIMARY KEY,
  agent            TEXT, skill TEXT, status TEXT,
  params_json      TEXT,
  result           TEXT,             -- NULL when redacted
  result_truncated INTEGER,
  redacted         INTEGER NOT NULL DEFAULT 0,
  conversation_id  TEXT,
  created_at       INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS ix_tasks_conv    ON tasks(conversation_id, created_at);
```

Written by the Orchestrator on every task terminal transition; agents
write their own rows too, so a directly-dispatched task (A2A, TUI direct
mode) is recorded even when the Orchestrator never saw it. The in-memory
`tasks` Map stays as the live working set; the table is the record.
Stored `result` is the **bounded** text (`boundTaskResult`, 64 KiB).

**The one carve-out, landing with this table and never after.** Persist
every result in full **except `scan-secrets`**, whose row is written with
`result = NULL, redacted = 1`. The task record — when it ran, status,
timing — is kept; the finding text is not.

Why exactly one exception, stated so it is not mistaken for an oversight:
every other result is ordinary project content already present in the
repo, so storing it aggregates nothing new. `scan-secrets` output is by
definition an inventory of every secret with its file and line — a
different artifact. Two things sharpen that: the database is long-lived
while the working tree moves on (a rotated secret stays in history), and
`.gitignore` protects against git but not against OneDrive, a backup
tool, or zipping the folder to send to someone. The design review
proposed a full metadata-only allowlist; that was judged heavier than
this project needs and risks the history quietly understating its own
coverage. **One exception, not a policy framework.** Decided by Yusuf
with the risk stated.

### B5 — `conversations` and `turns`

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT, content TEXT, created_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_turns ON turns(conversation_id, seq);
```

The Orchestrator writes each turn as it is appended and loads recent
conversations on startup, so the chat rail and `priorTurnsFor()` see
history from before the restart. The in-memory bounds (50 / 100) stay as
the live working set; the store keeps a superset (below) as the archive.

### Retention (added to `106`'s Orchestrator-only sweep)

`tasks`: 30 days or 10,000 rows, whichever binds first.
`conversations`/`turns`: 200 conversations, 500 turns each, cascade.

## Scope

In scope: the two tables; Orchestrator and agent write paths; startup
load of recent conversations; `specs/091` reading from the store when
the in-memory map is empty; retention.

Out of scope: audit events (`108`); persisting `pendingActions` — an
approval surviving a restart is **safety-critical** (`specs/056`'s
fingerprint recheck exists precisely because a stale approval is
dangerous) and needs its own spec, not a table added here; any UI
change beyond history simply being present.

## Safety constraints

- Fail-open, as `106`: a missing store changes nothing; the in-memory
  maps remain the source of truth for the running process.
- The `scan-secrets` redaction is enforced **in the write path by skill
  id**, structurally, not by prompt or convention — a test asserts the
  row for a real `scan-secrets` result has `result IS NULL`.
- `params_json` for tasks stores only the parameters already shown in
  the approval preview — nothing a human did not already see.
- Every task result already passes through `boundTaskResult` before
  storage; the cap therefore holds at rest.

## Acceptance criteria

- [x] Restart the Orchestrator: previously completed tasks and their
      results are readable; conversations and turns reappear in the chat
      rail.
- [x] A `scan-secrets` task's stored row has `result IS NULL` and
      `redacted = 1`; every other skill's row has its full bounded text.
- [x] A task dispatched directly to an agent (never via the Orchestrator)
      is still recorded.
- [x] `specs/091`'s "why did it fail?" answers correctly after a restart.
- [x] Retention caps hold; the sweep runs only in the Orchestrator.
- [x] With `ORCHESTRAI_PERSIST=0`, every `044`/`046`/`091` test passes
      unmodified.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.

## Verification plan

- Unit: write paths, redaction by skill id, startup load, retention —
  all against `:memory:`.
- Live: run a real task and a real chat exchange, restart the
  Orchestrator, confirm both are visible; run a real `scan-secrets`,
  inspect the row directly with `bun:sqlite` and confirm `result` is
  `NULL`.

## Non-goals

- Audit events — `108`.
- Approval state persistence — its own future spec.
- Encryption at rest; any external storage.
