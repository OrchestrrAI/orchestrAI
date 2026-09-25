---
id: 106-persistence-store-and-result-cache
title: "A Local SQLite Store, and No Redundant Expensive Work"
area: architecture
change_type: feature
status: implemented
verification: verified
created: 2026-09-22
updated: 2026-09-22
approved_by: Yusuf
approved_on: 2026-09-22
implemented_on: 2026-09-22
amends:
  - 057-project-snapshot-and-cross-request-reuse
  - 102-orchestrator-readonly-project-inspection
  - 105-orchestrator-fallback-deep-analysis
related:
  - 005-mcp-agent-integration
  - 006-runtime-stabilization
  - 066-supervisor-log-suppression-during-tui
  - 077-agent-enabled-means-llm-on-by-default
  - 084-security-external-vulnerability-data
  - 103-deep-project-analysis
  - 107-task-and-conversation-history
  - 108-durable-audit-trail
supersedes: []
superseded_by: []
---

# Spec: A Local SQLite Store, and No Redundant Expensive Work

> Status: **IMPLEMENTED, VERIFIED, 2026-09-22.** Second of four specs
> from one approved plan (105/106/107/108). Yusuf, 2026-09-21: *"i think
> it's the time to have a place to save the chat, the resualts so on"*
> and *"so i can use this analysize full feature even if the devops is
> off without having redandunt work."* This spec introduces the store
> and uses it for exactly one thing: never recomputing an expensive
> result any process already has. `specs/107`/`108` add history and
> audit on top. See `verification.md` for the full record, including a
> real, previously-undiscovered gap found and fixed while live-verifying
> this spec: `apps/supervisor/index.ts`'s `--only <names>` auto-include-
> mcp:http logic never accounted for the Orchestrator's own MCP
> dependency (specs/102) at all, since the Orchestrator is started via a
> separate `startOrchestrator` flag, never through the `toStart` array
> that logic inspects — `--only orchestrator` silently never started
> mcp:http, so the very feature this spec exists to make reachable
> without DevOps couldn't actually reach the MCP tools it needs. Fixed.

## A deliberate reversal, recorded once, here

Roughly ten prior specs explicitly list persistence as a **non-goal** —
`001`, `004`, `005`, `006`, `009`, `011`, `022`, `023`, `024`, `026`,
`028`. `CLAUDE.md` states it as a known limitation: *"No persistence; all
task state is in memory."* `specs/020` cites that line as a design
constraint. This is a boundary the project deliberately held, not a gap
nobody noticed.

**This spec crosses it, on purpose, for one reason:** `specs/103`'s deep
analysis is a real provider round trip — 10-40 seconds and real cost —
and today it is recomputed by every process, on every restart, with no
way for one process to reuse what another already paid for. The cost of
that redundancy now outweighs the simplicity the boundary bought.
`context/project.md` and `context/history.md` both name SQLite as a
long-envisioned target, so this is planned evolution — but it is still a
reversal, and `107`/`108` reference this section rather than restating it.

## Purpose

One local database file that every process can read and write, so an
expensive result is computed once and reused by any process, surviving
restarts. **Strictly optional**: if it cannot be opened, nothing changes.

## Current behavior

Eight independent processes (Orchestrator, six agents, MCP HTTP), each
with its own in-memory Maps. Nothing is shared; nothing survives restart.

The only real cache in the project is `projectSnapshotCache`
(`packages/shared/project-snapshot-cache.ts`, `specs/057`) — in-memory,
Orchestrator-only, **conversation-scoped**, 5-minute TTL, with a cheap
git-status fingerprint cross-check before serving an `analyze-project`
hit and an explicit-refresh bypass. Its conversation scoping is exactly
what prevents a result computed by DevOps from serving the Orchestrator
or a later run. An audit confirmed every other `cache` match in the
repo is incidental (git's `--cached`, `__pycache__` in a template, a
Redis mention in a prompt); `existsCache` in the grounding code dedups
within a single pass and stays.

No storage library exists anywhere in the repo. `bun:sqlite` is unused.

## Proposed behavior

### B0 — `packages/shared/store.ts`

`bun:sqlite` — **zero new dependencies**, built into the runtime. One
**local** file at `<ORCHESTRAI_PROJECT_PATH>/.orchestrai/orchestrai.db`,
beside the `config.env` and `supervisor.log` already written there.
Every process inherits that env var, so all eight resolve the same file;
a process without it simply has no store. `ensureGitignored()`
(`apps/supervisor/init-wizard.ts`) already adds `.orchestrai` to
`.gitignore`. **No network storage, no external service, anywhere.**

**Strictly optional / fail-open — the load-bearing property.** `openStore()`
returns `null` on any failure, and every caller treats `null` as "behave
exactly as today". Mirrors `specs/102`'s optional MCP client and
`specs/066`'s "if the log file can't be created, suppression never
engages". **`ORCHESTRAI_PERSIST=0`** makes `openStore()` return `null`
unconditionally — the opt-out reuses the fail-open path at zero cost.
**On by default**, matching how every LLM harness already defaults on
(`specs/077`).

**Opening, in order:**
1. `mkdir -p` the directory (a non-Orchestrator agent may boot first) —
   or fail open.
2. `PRAGMA journal_mode = WAL`, then **verify the value returned**. If
   WAL was not adopted, close the handle and run memory-only rather than
   let eight writers share a file in a mode that cannot support them.
3. `busy_timeout = 5000`, `synchronous = NORMAL`,
   `auto_vacuum = INCREMENTAL` (**set at creation** — unchangeable later
   without a full VACUUM).
4. Idempotent, race-safe migration: `CREATE TABLE IF NOT EXISTS` +
   `PRAGMA user_version`, inside one `BEGIN IMMEDIATE` — all eight
   processes may migrate simultaneously at boot.
5. `0600` on POSIX.

**`bun:sqlite` is synchronous**: never hold a transaction or statement
iterator across an `await`; each write is one `db.transaction(...)()`
doing no I/O.

### B1 — a generic result cache

One table, keyed on a `kind` discriminator so it is not shaped around a
single consumer:

```sql
CREATE TABLE IF NOT EXISTS result_cache (
  cache_key       TEXT PRIMARY KEY,  -- sha256(kind, project_root, target_rel, input_hash, schema_ver)
  kind            TEXT NOT NULL,     -- "project-analysis" today
  project_root    TEXT NOT NULL,
  target_rel      TEXT NOT NULL,     -- normalised relative to project_root
  input_hash      TEXT NOT NULL,
  git_fingerprint TEXT,              -- NULL => TTL-only validity
  result          TEXT,              -- NULL while in flight
  lease_until     INTEGER,           -- stampede marker
  computed_at     INTEGER,
  expires_at      INTEGER NOT NULL,
  producer        TEXT NOT NULL,     -- diagnostics only, never in a lookup
  schema_ver      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_result_cache_expiry ON result_cache(expires_at);
```

**The key is where this ships or silently fails.** No conversation id
anywhere — conversation scoping is what blocks reuse today.
`target_rel` **must** be normalised relative to `project_root`, or
DevOps's absolute path and the Orchestrator's relative one produce two
keys for one project and the feature delivers none of its benefit.
`schema_ver` lets a prompt or model change invalidate every entry at
once. Validity on read: the stored git-status fingerprint is re-checked
(the `specs/057`/`102` pattern) with `expires_at` as backstop.

**Concurrent stampede.** In a six-agent fan-out, two processes starting
the same 40s analysis both miss. A caller about to compute first writes
a row with `result = NULL, lease_until = now + lease`; a second caller
seeing an unexpired lease waits for the result (bounded) instead of
recomputing. Without this the feature fixes restart redundancy but not
concurrent redundancy — the common case.

The obvious second `kind` already exists — OSV.dev lookups
(`packages/agents/security/osv-client.ts`, real network calls, 8s
timeouts, data changing daily at most, no secrets risk) — and becomes a
call site whenever wanted. Not wired here.

Wired into `specs/105`'s shared module: read path is store → compute →
store. `getCachedProjectAnalysis()` becomes real. Store the **bounded**
text (`boundTaskResult`), never the original, or the 64 KiB cap stops
applying at rest.

### B2 — retention, owned by one process

Pruning runs **only in the Orchestrator** — on startup and a 15-minute
`setInterval().unref()`. Other processes never prune, so there is one
owner and no contention. `result_cache`: delete expired, then cap at
2,000 rows by `computed_at`. (Caps for the `107`/`108` tables are set
there.) Not on every write (hot-path amplification); not on startup
alone (long-lived processes would never prune).

### B3 — retire `projectSnapshotCache`

**One cache, not two.** Keeping a second in-memory cache with different
scoping and different invalidation beside a durable one is precisely how
the two diverge — this codebase was bitten by one rule living in three
places (`specs/015`'s `ci`-substring bug). `projectSnapshotCache`'s real
behaviours carry over unchanged: the 5-minute TTL, the git-fingerprint
cross-check, the explicit-refresh bypass (`EXPLICIT_REFRESH_PATTERN`).
`specs/103`'s separation of the shallow inspection from a real skill
result survives via `kind`. **One behaviour deliberately changes:**
conversation scoping is dropped — the fingerprint check, not the
conversation boundary, is what keeps a stale result from being served.
`packages/shared/project-snapshot-cache.ts` is deleted; its bounded
eviction is superseded by B2. `specs/057` is `verification: verified`,
so its tests are the regression guard.

## Size and performance

**Net effect is faster.** An indexed local SQLite lookup is
microseconds; the call it avoids is 10-40 seconds. Writes are
sub-millisecond, a handful per task, in a system doing a few requests a
minute. Startup adds a few ms for open + migration. This spec's table is
capped at 2,000 rows — a few MB.

## Scope

In scope: B0–B3 above; `specs/105`'s module wired to the store;
`ORCHESTRAI_PERSIST`.

Out of scope: tasks, conversations, audit (`107`/`108`); OSV caching
(call site later); any write-through of approval state (see `104`).

## Safety constraints

- **Fail-open is non-negotiable.** No service may fail to start, or a
  task fail, because the store is absent, read-only, locked, or corrupt.
  Deliberately verified by pointing the store at a read-only path.
- **No secrets by construction in this spec**: the only stored content is
  the analysis result — project structure described in prose, already
  present in the repo. The `scan-secrets` carve-out is `107`'s concern
  and lands with the `tasks` table, never after.
- **Test isolation**: suites run in parallel; every test uses `:memory:`
  or a unique temp path. A shared default path would cross-contaminate.
- A plain note in the spec and in `.orchestrai/` that the file holds
  project content and is gitignored but not encrypted.

## Acceptance criteria

- [x] `openStore()` returns `null` — and every service starts and behaves
      identically to today — for: missing `ORCHESTRAI_PROJECT_PATH`,
      `ORCHESTRAI_PERSIST=0`, a read-only path, a non-WAL filesystem.
- [x] Migration is idempotent under eight simultaneous opens.
- [x] A result computed by DevOps is served to the Orchestrator (and
      vice versa) with **no** recompute — proven with two separate
      processes, and again after restarting both. (Live-verified for the
      Orchestrator's own producer path — see Verification below; the
      DevOps-writes/Orchestrator-reads direction is unit-proven in
      `project-analysis.test.ts`'s cross-producer-reuse test, sharing the
      identical `getCachedProjectAnalysis()`/`setCachedProjectAnalysis()`
      code path DevOps itself calls.)
- [x] Absolute and relative spellings of the same target produce **one**
      key.
- [x] A changed git fingerprint forces a fresh compute; an expired
      `expires_at` forces a fresh compute; explicit-refresh wording
      bypasses the cache.
- [x] Two concurrent callers produce **one** compute (stampede marker).
- [x] Every `specs/057` test passes against the store with
      `projectSnapshotCache` deleted.
- [x] Pruning caps `result_cache` and runs only in the Orchestrator.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.

## Verification plan

- Unit, all against `:memory:` or temp paths: open/fail-open/kill
  switch; WAL verification; migration race; key normalisation;
  fingerprint/TTL/refresh; stampede; the ported `specs/057` suite.
- **The decisive live test**: DevOps not running, ask "analyze the
  project" in chat, get a real deep analysis (`specs/105`). Restart
  everything. Ask again. Confirm it is served from the database with
  **no** provider call — verified in the audit trail, not inferred.

## Non-goals

- Anything beyond the result cache — `107`/`108`.
- Encryption at rest.
- Any external database, cache service, or network storage — ever, in
  this codebase's stated constraints.
