# Verification: Tasks and Chat Survive a Restart

Status: **verified**, 2026-09-22.

## Automated

- `bun test`: 1286 pass, 0 fail, 2 skip (pre-existing Docker-daemon-gated
  tests, unrelated) across 81 files.
- `bun run typecheck`: 0 errors.
- `bun run specs:check`: passed for 107 specs.
- `packages/shared/store.test.ts`: 38 tests total (up from 24 pre-107),
  14 new — `upsertTask`/`getTask`/`listRecentTasks` round-trips, the
  scan-secrets redaction enforced structurally inside `upsertTask()`
  itself (proven by passing an unredacted result and asserting the
  stored row has `result IS NULL` regardless), every other skill's
  result stored in full, `pruneTasks`'s age and row-count caps,
  `upsertConversation`/`appendTurnRow`/`listRecentConversationsWithTurns`
  ordering, a genuine `ON DELETE CASCADE` proof (a second, independent
  `Database` handle reads the real file directly after eviction and
  confirms the orphaned turn row is actually gone, not just unreturned
  by a query), re-appending the same `(conversationId, seq)` updating in
  place, and `pruneConversations`'s both caps.
- `apps/orchestrator/task-conversation-persistence.test.ts` (new, 15
  tests): `emitTaskState()`'s terminal-transition write (completed,
  failed, idempotent double-call, `params_json` sourced only from the
  approval preview's own parameters), the scan-secrets redaction
  end-to-end through the real Orchestrator code path (not just the
  store's own unit test), `appendTurn()`'s write including a dedicated
  test proving the `turnSeq` counter never collides with an earlier part
  of the same conversation after the in-memory array is trimmed past
  `MAX_TURNS_PER_CONVERSATION`, `loadRecentConversationsFromStore()`
  restoring a conversation into a cleared in-memory Map (the literal
  restart simulation) and correctly continuing it afterward with no seq
  collision against the reloaded history, `answerLastFailureFromState()`
  reading from the store once the in-memory task Map is empty
  (specs/091's own named acceptance criterion), confirming a redacted
  failure's finding text never leaks even through the fallback path, and
  `ORCHESTRAI_PERSIST=0` leaving every one of these functions
  byte-identical to their pre-107 behavior.

## A real bug found and fixed while writing this spec's own tests

`persistTaskTerminal()`'s first version wrote `result: task.result ?? null`
unconditionally. `OrchestratorTask.result` is only ever set on a
**successful** completion — a failed task's real detail lives in
`task.error`, a fact `findMostRecentFailure()`'s own in-memory branch
already knew (`inMemory.error ?? inMemory.result`) but the store-write
path did not mirror. A dedicated test
(`"with an empty in-memory task Map, the last failure is read from the
durable store"`) caught this immediately: the answer correctly named the
failing skill but the detail text came back as the generic
`"(no further detail recorded)"` instead of the real error, because the
stored row's own `result` column was `NULL` for every failed task.
Fixed by writing `task.error ?? task.result ?? null` instead, matching
the read side exactly. This directly protects the spec's own named
acceptance criterion ("specs/091's 'why did it fail?' answers correctly
after a restart") — without this fix, that criterion would have silently
failed the moment a real restart actually happened, since the bug is
invisible unless the in-memory task Map is genuinely empty.

## Agent-side persistence (the "direct dispatch" acceptance criterion)

Rather than rewrite each of the six agents' own dozens of scattered
`tasks.set(...)` call sites (119 across the six files, confirmed by
`grep -c`), a shared, low-risk polling sweep
(`packages/shared/store.ts`'s `startTaskPersistenceSweep()`) watches each
agent's own existing in-memory task Map — the same Map every one of
those call sites already writes to — and persists a task exactly once,
the first time it observes a terminal status. This mirrors this
codebase's own established `populateSnapshotCacheWhenTaskTerminates()`
polling precedent (`specs/057`) for the identical reason: far cheaper
and lower-risk than rewiring every mutation site, with no change to any
existing behavior since the sweep never touches the Map, only reads it.

Wired into all six agents (DevOps as the reference implementation,
Testing/Documentation/Security/Code Review/Coder following identically):
a small `taskMeta` side-map records the skill id and creation timestamp
at the one place each agent's own `processTask()` already computes the
skill (`task.selectedSkill ?? detectSkill(text)`), since none of the six
agents' own `TaskResult`-shaped types carry those fields directly. The
sweep's own `stop()` is wired into each agent's existing `shutdown()`;
Security has no existing shutdown handling in this codebase (confirmed
by reading the file, not assumed), so its sweep runs for the process's
lifetime like every other module-level `setInterval` there, already
`unref()`'d.

## The decisive live test

Real Gemini key (`.orchestrai/config.env`, already present from earlier
session work — `gemini-3.5-flash-lite` for the Orchestrator/supervisor,
`gemini-3.1-flash-lite` for DevOps, `gemini-3.6-flash` for Security), the
real compiled runtime (`bun run orchestrai`), no mocks.

**Setup**: `bun run orchestrai --only devops-agent,security-agent,orchestrator`.
All four services (mcp:http auto-included) reported healthy.

**Step 1 — a real conversation, two turns.** `POST /ask
{"question": "what is my git status?"}` → real `git-status` dispatch,
completed. A follow-up in the same conversation
(`"thanks, what else can you do?"`) → a real Tier 0 state answer. Direct
inspection of `.orchestrai/orchestrai.db` via `bun -e` (a real
`bun:sqlite` `Database` opened read-only) confirmed the conversation row
and all four turns, in the correct `seq` order, with real content —
including the assistant's own real synthesized answer text.

**Step 2 — a real `scan-secrets` task, the redaction proven directly.**
`POST /tasks {"text": "scan for secrets"}` → a real security-agent
dispatch, completed with a real 182-file scan result (visible in the
live task's own `GET /tasks/:id` response, confirming the **live,
in-memory** result is never redacted — only the durable store copy is).
Direct database inspection: `{task_id: "orch-task-...", skill:
"scan-secrets", status: "completed", result: null, redacted: 1}` — the
literal acceptance criterion, confirmed against the real database, not
inferred. The identical `git-status` task's own row: `redacted: 0`, full
1370-byte result — proving the redaction is genuinely skill-specific,
not a blanket effect.

**Step 3 — both write paths, confirmed independently.** The database
held **two** rows for the same real `git-status` dispatch: one written
by the Orchestrator (`task-9f46572a...`, carrying the real
`conversation_id`) and one written independently by DevOps's own sweep
(`orch-task-9f46572a...`, `conversation_id: null` — agents don't track
conversation ids). Both exist; neither depends on the other. Same
pattern confirmed for the `scan-secrets` task and Security's own sweep.

**Step 4 — the decisive check: a full process kill and restart.**
`taskkill /F /IM bun.exe` killed every process; `bun run orchestrai
--only orchestrator` started a genuinely fresh one. Its own startup log
printed `[orchestrator] loaded 1 conversation(s) from the store` —
confirmed, not assumed, that `loadRecentConversationsFromStore()` ran
and found real data. The **decisive HTTP-level proof**: `POST /ask
{"question": "hi again", "conversationId": "conv-2c148712-..."}` —
reusing the exact conversation id from *before* the restart —
succeeded (a genuine Tier 0 answer), rather than the `404 Conversation
not found` a lost conversation would have produced. This is the
spec's own named acceptance criterion, satisfied by a real HTTP request
against a genuinely restarted process, not inferred from the database
alone.

Process cleanly torn down afterward (`taskkill /F /IM bun.exe`, ports
confirmed free via `netstat`). `.orchestrai/orchestrai.db` confirmed
`git check-ignore`d throughout, so none of this real project content or
conversation history was ever at risk of being committed.

## Known gaps, stated honestly

- `specs/091`'s own store-fallback path was proven via a direct unit
  test (`findMostRecentFailure()`) rather than a live restart-then-ask-
  "why did it fail" HTTP round trip — the live pass above proves
  conversation restart-survival and the scan-secrets redaction with real
  HTTP requests, but did not additionally stage a real failure and then
  restart specifically to ask about it. The unit test covers the exact
  same code path `/ask`'s own `"failure-question"` intent calls.
- The agent-side sweep's own timing (a 5-second poll interval) is not
  independently live-verified — the live pass above relied on the
  Orchestrator's own direct write path (`emitTaskState()`), which is
  synchronous and immediate; the sweep's own eventual-consistency
  behavior is covered by its use in the same live pass's row-count
  observations (both `git-status` rows and both `scan-secrets` rows were
  present when queried, well after the 5-second window), not by a
  dedicated timing assertion.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/107-task-and-conversation-history/spec.md` (implemented,
**verified**) adds two tables onto `specs/106`'s own store — `tasks` and
`conversations`/`turns` — so task results and chat history outlive the
process that produced them, closing the gap `specs/091`'s "why did it
fail?" feature had after any restart (nothing left to walk).

**`tasks`, written on every genuinely terminal transition.**
`apps/orchestrator/index.ts`'s `emitTaskState()` already gates
completed/failed handling behind a one-shot `emittedTerminal` Set (so
AG-UI's own `RUN_FINISHED`/`RUN_ERROR` never double-fire); `persistTaskTerminal()`
hooks that exact same point, so this never double-writes either. The
in-memory `tasks` Map on each process stays the live working set; this
table is the durable record. `params_json` stores only what the human
already saw in the approval preview (`task.approval?.parameters`) — never
the full task object.

**The `scan-secrets` carve-out lands here, structurally, not by
convention** — `OrchestraiStore.upsertTask()` itself checks `skill ===
"scan-secrets"` and forces `result = NULL, redacted = 1` regardless of
what the caller passes; the task record (when it ran, its status,
timing) is kept, only the finding text is withheld. Every other skill's
result is stored in full, already bounded by `boundTaskResult()` before
it ever reaches this method.

**`conversations`/`turns`, written from `appendTurn()`** — the one and
only place a turn is ever added (confirmed by a repo-wide grep; no
direct `.turns.push()` call site exists anywhere else), so this is a
single, unmissable hook. A `turnSeq` counter lives on the in-memory
`Conversation` object itself, deliberately independent of
`conversation.turns.length` — that array gets trimmed from the front
once a conversation passes `MAX_TURNS_PER_CONVERSATION`, and reusing its
length as the seq counter would have silently collided seq numbers with
an earlier part of the same conversation the moment trimming kicked in.
`loadRecentConversationsFromStore()` runs once at `start()`, restoring
the most recently active conversations (and their real turns, in order)
into the in-memory Map before the HTTP server even binds its port — so a
continued conversation after a restart picks its `turnSeq` counter back
up correctly too, never colliding with reloaded history.

**A real bug found and fixed while writing this checkpoint's own
tests, not assumed away.** The first version of `persistTaskTerminal()`
wrote `task.result ?? null` unconditionally — but `OrchestratorTask.result`
is only ever set on success; a failed task's real detail lives in
`task.error`, a fact `findMostRecentFailure()`'s own in-memory branch
already knew (`inMemory.error ?? inMemory.result`) but the write path
didn't mirror. This silently broke the exact acceptance criterion this
spec exists to satisfy: a dedicated test proved a restart-then-"why did
it fail" round trip named the right skill but returned "(no further
detail recorded)" instead of the real error, because the stored row's
`result` column was `NULL` for every failed task. Fixed by writing
`task.error ?? task.result ?? null`, matching the read side exactly —
caught by a test before this spec was ever called done, not found live.

**`findMostRecentFailure()`** is a new shared helper both
`answerLastFailureFromState()` (`specs/091`) and `buildConversationAnswer()`
(`specs/093`) now call — checking the in-memory `tasks` Map first (always
more current when the live process has it), falling back to the store
only when memory has nothing, never the reverse. A redacted `scan-secrets`
failure's own fallback answer states plainly that no detail was
persisted for that skill, rather than fabricating one.

**Agent-side persistence — "a task dispatched directly to an agent is
still recorded" — without rewriting 119 scattered call sites.** Each of
the six agents' own `TaskResult`-shaped type mutates its local `tasks`
Map from many places (27 in DevOps alone, up to 35 in Testing);
rewriting every one of those to add a persistence call was judged too
much risk for too little gain. Instead, `packages/shared/store.ts`'s new
`startTaskPersistenceSweep()` polls the SAME Map every one of those call
sites already writes to, and persists a task exactly once, the first
time it observes a terminal status — mirroring this codebase's own
established `populateSnapshotCacheWhenTaskTerminates()` polling
precedent (`specs/057`) for the identical reason: far cheaper and lower-
risk than rewiring every mutation site, with zero change to any existing
call site's own behavior. Wired into all six agents identically (DevOps
as the reference implementation): a small `taskMeta` side-map records
the skill id and creation timestamp at the one place each agent's own
`processTask()` already computes the skill
(`task.selectedSkill ?? detectSkill(text)`), since none of the six
agents' own task types carry those fields directly. Security has no
existing `shutdown()`/SIGINT handling in this codebase (confirmed by
reading the file, not assumed) — its sweep simply runs for the
process's lifetime like every other module-level `setInterval` there,
already `unref()`'d; the other five wire the sweep's own `stop()` into
their existing `shutdown()`.

**Retention added to `specs/106`'s own Orchestrator-only sweep, not a
second interval**: `tasks` — 30 days or 10,000 rows, whichever binds
first; `conversations`/`turns` — 200 conversations, 500 turns each,
cascade (requires `PRAGMA foreign_keys = ON`, which SQLite does not
enable by default — set per-connection, every open, in `store.ts`).

**The decisive live test, against a real Gemini deployment and the real
compiled runtime, no mocks**: `bun run orchestrai --only devops-agent,
security-agent,orchestrator`. A real two-turn conversation (`git-status`
then a Tier 0 follow-up) — the real `.orchestrai/orchestrai.db` showed
the conversation and all four turns in correct order. A real
`scan-secrets` dispatch — the live, in-memory task result showed the
full real scan (182 files); the stored row showed exactly
`{result: null, redacted: 1}`, while the same run's `git-status` row
showed its full 1370-byte result unredacted — the literal acceptance
criterion, confirmed against the real database. Both the Orchestrator's
own write and DevOps's/Security's own independent sweep-written rows
were present for the same real dispatches, proving the two paths work
independently, neither depending on the other. The entire process stack
was then killed (`taskkill /F /IM bun.exe`) and only the Orchestrator
restarted fresh — its own startup log read `loaded 1 conversation(s)
from the store`, and the decisive HTTP-level proof: `POST /ask` reusing
the exact pre-restart `conversationId` succeeded with a real answer,
rather than the `404 Conversation not found` a lost conversation would
have produced.

1286 tests pass (0 fail, 2 skip, unrelated), typecheck clean,
`specs:check` passed for 107 specs. See `specs/107`'s own
`verification.md` for the complete transcript, including two
honestly-stated gaps: the store-fallback path for "why did it fail?" was
proven by a direct unit test rather than a live restart-then-ask round
trip, and the agent-side sweep's own 5-second poll timing was not
independently timing-tested (its row presence was confirmed well after
that window in the live pass, not raced against it).

See specs/110-approval-state-survives-a-restart/verification.md for the relocated narrative covering this checkpoint.
