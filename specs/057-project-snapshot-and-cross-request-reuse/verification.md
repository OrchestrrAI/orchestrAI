# Verification: Project Snapshot and Safe Cross-Request Read Reuse

Date: 2026-09-06

Result: **verified**.

## What changed

- `packages/shared/project-snapshot-cache.ts` (new) — pure
  `ProjectSnapshotCache` (`Map<conversationId, Map<"skill::target",
  entry>>`) with bounded eviction (oldest-first, both per-conversation
  entry count and total conversation count), `isSnapshotExpired()`, and
  `EXPLICIT_REFRESH_PATTERN` for the text-based explicit-refresh cue.
  No network calls, no agent knowledge — a pure data structure.
- `apps/orchestrator/index.ts`'s `dispatchRootTask()` (shared by both
  `POST /tasks` and `/ask`, per specs/044's own precedent):
  - Conversation-scoped only — a bare `POST /tasks` (no `conversationId`)
    never reaches the new branch at all.
  - Read-only skills only (`classifySkillTier()`, imported from
    `supervisor-graph.ts`, the same authoritative classification
    specs/060's own fan-out gate already uses).
  - `git-status` (and any other read-only skill with no cheaper
    cross-check available): TTL alone is the gate — a fresh, unexpired
    cache entry is served synchronously, with no agent dispatch at all.
  - `analyze-project` (the expensive case — a direct DevOps-to-Security
    A2A pre-check runs inside it): a cache hit is cross-checked with one
    extra `git-status` dispatch via `callAgent()` before being served;
    a match serves the cache, a mismatch (or the cross-check itself
    failing) discards it and performs a genuine fresh `analyze-project`
    dispatch, repopulating the cache when that completes.
  - A genuine cache miss (or a skill with no `conversationId`) still
    populates the cache once the real dispatch completes, via a new
    `populateSnapshotCacheWhenTaskTerminates()` poll-based watcher
    (mirroring `appendAnswerWhenTaskTerminates()`'s own established
    pattern).
  - `EXPLICIT_REFRESH_PATTERN` bypasses the cache check entirely,
    treated as a genuine miss.

## Verified

- `bun run typecheck` — 0 errors.
- `bun test` — 780 pass, 0 fail, 1524 expectations across 53 files (up
  from 758/1480: 15 pure cache-module tests, 7 real-surface integration
  tests).
- **`packages/shared/project-snapshot-cache.test.ts`** (15 tests, no
  network, no agents): exact-key retrieval; conversation/skill/target
  isolation (no cross-contamination in any dimension); a miss returns
  `undefined`, never a guess; `invalidateConversation()` drops only that
  conversation's entries; bounded per-conversation entry eviction
  (oldest first, confirmed by index, not just count); bounded total
  conversation eviction (same); re-setting an existing key refreshes it
  without growing the count; `isSnapshotExpired()`'s TTL boundary
  (strictly-greater-than, both default and custom TTL); the explicit-
  refresh pattern matches common phrasing and not ordinary requests.
- **`apps/orchestrator/project-snapshot-cache-integration.test.ts`** (7
  tests, real `POST /ask`/`POST /tasks` via `app.request()`, mocked
  `fetch`, no live agents):
  - A second `git-status` request in the same conversation, within TTL,
    is served from cache — the real agent dispatch count for
    `selectedSkill: "git-status"` stayed at 1 across both requests, and
    the second task's status was `"completed"` **synchronously**,
    matching the cached result exactly.
  - A second `analyze-project` request with an unchanged cross-check
    reuses the cache — `analyze-project` dispatched exactly once; the
    real audit log shows the extra cheap `git-status` cross-check calls
    (visible as `a2a-call` entries against `devops-agent`, distinct from
    the main skill dispatch).
  - A second `analyze-project` request whose cross-check text differs
    forces a genuine fresh `analyze-project` dispatch — the count is 2
    (original plus the invalidation-triggered fresh one), and the
    second task's final result matches the fresh (not the stale
    cached) content.
  - A bare `POST /tasks` (no `conversationId`) dispatches `git-status`
    twice for two identical requests — the cache is never consulted.
  - A `dockerize` request (write-capable) still requires approval
    exactly as before — the cache-check branch is never entered for it.
  - A cache entry manually backdated past the TTL (`isSnapshotExpired`'s
    own pure logic already separately tested; this exercises the real
    integration's *use* of it) forces a genuine fresh dispatch —
    dispatch count 2.
  - Explicit-refresh wording (`"please refresh the git status at
    ..."`) bypasses a valid, unexpired cache entry — dispatch count 2.
- **One real bug found and fixed during this pass, not assumed away**:
  the cache-hit-pending task object (the `analyze-project` cross-check
  branch, which returns immediately in `"working"` status while the
  cross-check runs asynchronously) initially omitted `agentTaskId` —
  without it, `syncTaskStatus()`/`appendAnswerWhenTaskTerminates()`'s
  own polling (which both key off that field) could never observe a
  fresh-redispatch's real completion if the cross-check invalidated the
  cache. Fixed by setting `agentTaskId: \`orch-${taskId}\`` up front on
  that task, matching the normal-dispatch task shape exactly — caught by
  the "changed cross-check forces a fresh dispatch" integration test
  actually hanging at `"working"` rather than reaching `"completed"`,
  not by inspection.

## Out of scope, confirmed untouched

`git diff --stat` confirms the changed files are
`packages/shared/project-snapshot-cache.ts` (new),
`packages/shared/project-snapshot-cache.test.ts` (new),
`apps/orchestrator/index.ts`, and
`apps/orchestrator/project-snapshot-cache-integration.test.ts` (new) —
no change to `specs/056`'s own write-path fingerprint recheck, to
`apps/orchestrator/supervisor-graph.ts` (the adaptive supervisor's own
read-only dispatch remains explicitly unintegrated with this cache, per
the spec's own "Explicitly deferred" section), or to any write-capable
skill's own dispatch path.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/057-project-snapshot-and-cross-request-reuse/spec.md`
(implemented, **verified**) adds a bounded, conversation-scoped cache
for **read-only** inspection results only — a follow-up question in the
same `/ask` conversation no longer forces `git-status`/`analyze-project`
to redo an inspection nothing has invalidated.
`packages/shared/project-snapshot-cache.ts`'s `ProjectSnapshotCache` is
a pure data structure (bounded eviction, both per-conversation entry
count and total conversation count) keyed by `(conversationId, skill,
target)`, consulted only from `apps/orchestrator/index.ts`'s
`dispatchRootTask()` (shared by `POST /tasks` and `/ask` — a bare
`POST /tasks` with no `conversationId` never touches this cache at all)
and only for a skill `classifySkillTier()` (specs/060's own
classification) marks read-only. **The Orchestrator has no direct
filesystem access to a target project** — every inspection is a real
HTTP dispatch to an agent — so "detected filesystem change" is checked
via the cheapest already-available real signal, not a new filesystem
probe: `analyze-project` (the expensive case — it also runs a direct
DevOps-to-Security A2A pre-check) cross-checks a cache hit with one
extra, much cheaper `git-status` dispatch before serving it; `git-status`
itself (and any other read-only skill with no cheaper signal than
itself) trusts a 5-minute TTL alone — a deliberate, stated carve-out,
not an oversight. Explicit-refresh wording in the request text bypasses
the cache entirely. **A write action never trusts this cache, ever** —
`specs/056`'s own write-path preflight/fingerprint recheck is completely
unaffected and untouched by this spec's existence. Live-verified through
the real `POST /ask`/`POST /tasks` surfaces (mocked `fetch`, no live
agents): a second `git-status` request served synchronously from cache
with zero repeated dispatch; a second `analyze-project` request with an
unchanged cross-check reusing the cache; a *changed* cross-check forcing
a genuine fresh `analyze-project` dispatch; a bare `POST /tasks`
provably never touching the cache; TTL expiry and explicit-refresh both
forcing a fresh dispatch. **Explicitly deferred**: the adaptive
supervisor's own read-only dispatch (`specs/060`) is not integrated with
this cache — that module is deliberately Orchestrator-agnostic with no
conversation concept, and threading one through it would be a
materially larger, separate change.

See specs/056-devops-preflight-and-idempotent-writes/verification.md for the relocated narrative covering this checkpoint.

See specs/103-deep-project-analysis/verification.md for the relocated narrative covering this checkpoint.

See specs/106-persistence-store-and-result-cache/verification.md for the relocated narrative covering this checkpoint.

See specs/107-task-and-conversation-history/verification.md for the relocated narrative covering this checkpoint.

See specs/102-orchestrator-readonly-project-inspection/verification.md for the relocated narrative covering this checkpoint.
