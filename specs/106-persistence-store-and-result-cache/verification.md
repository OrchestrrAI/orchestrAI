# Verification: A Local SQLite Store, and No Redundant Expensive Work

Status: **verified**, 2026-09-22.

## Automated

- `bun test`: 1257 pass, 0 fail, 2 skip (the pre-existing Docker-daemon-
  gated tests, unrelated) across 80 files.
- `bun run typecheck`: 0 errors.
- `bun run specs:check`: passed for 107 specs.
- `packages/shared/store.test.ts` (24 tests): `openStore()` fail-open
  for every listed path (missing `ORCHESTRAI_PROJECT_PATH`,
  `ORCHESTRAI_PERSIST=0`, an unopenable path), migration idempotency,
  `result_cache` get/set/key-normalization/TTL/schema-version/kind-
  isolation, `tryAcquireLease()` stampede scenarios, `pruneResultCache()`
  retention, and a decisive cross-process-reuse test using two
  independent `Database` handles against the same real file.
- `packages/shared/project-analysis.test.ts`: 7 new tests for
  `getCachedProjectAnalysis()`/`setCachedProjectAnalysis()` — miss,
  real write/read round-trip, fingerprint-mismatch invalidation,
  null-fingerprint TTL-only validity, cross-check-failure degradation,
  `ORCHESTRAI_PERSIST=0` no-op, and cross-producer reuse (a result
  written under one `producer` string served to a caller passing a
  different one — the exact mechanism DevOps-writes/Orchestrator-reads
  depends on).
- `apps/orchestrator/project-snapshot-cache-integration.test.ts`:
  rewritten onto a real per-test SQLite file (fresh `mkdtempSync`
  scratch directory each test, `__resetSharedStoreForTests()` before
  and after) instead of the retired in-memory
  `ProjectSnapshotCache`. Every original specs/057 scenario passes
  unchanged (git-status TTL-only reuse, analyze-project's cheap
  cross-check reuse and invalidation, "no conversationId, no cache",
  write-capable skill unaffected, TTL expiry via a `ttlMs: -1` backdated
  row — the same technique `store.test.ts` itself uses — and explicit
  refresh bypass), plus one new test proving the deliberately changed
  behavior: a result cached under one conversation is now served to a
  **different** conversation for the same target (impossible under the
  old conversation-scoped cache).
- `apps/orchestrator/orchestrator-inspection.test.ts`: the four tests
  exercising real cache round-tripping (shallow/deep non-collision, own-
  cache reuse, cross-check invalidation, no-conversationId-no-cache) were
  moved into a nested `describe` block that temporarily re-enables
  persistence against its own real scratch directory (the outer file
  forces `ORCHESTRAI_PERSIST=0` for every other test — see the isolation
  fix below). All four pass using the real store's `setCachedResult()`/
  `getCachedResult()` directly in place of the deleted class's `set()`/
  `get()`.

## A real cross-test-contamination bug found and fixed before any of the
## above could be trusted

Before finishing B1's own wiring, `bun test apps/orchestrator/` showed 3
failures traced to a single root cause: `orchestrator-inspection.test.ts`'s
`beforeEach` sets `process.env.ORCHESTRAI_PROJECT_PATH = "C:\\proj"` — a
fake, never-real path used purely as a string constant since long before
this spec. Once `computeDeepProjectAnalysis()`/
`inspectTargetProjectAsTaskResult()` started calling
`getCachedProjectAnalysis()`/`setCachedProjectAnalysis()`, which read
`process.env.ORCHESTRAI_PROJECT_PATH` directly via the shared-store
singleton, this test file's own `beforeEach` caused `openStore()` to
genuinely `mkdirSync("C:\\proj\\.orchestrai", { recursive: true })` and
create a **real** SQLite database directly on the real `C:` drive root —
confirmed via `ls -la "C:/proj/.orchestrai"` showing real
`orchestrai.db`/`-shm`/`-wal` files with real timestamps. A later test's
`setCachedProjectAnalysis()` call then wrote a real cached entry a
different, unrelated test read back instead of its own freshly-scripted
model response — the direct cause of the 3 failures.

Fixed two ways, both load-bearing for every future test in this
codebase, not just this spec's own:

1. `packages/shared/store.ts`'s `__resetSharedStoreForTests()` never
   closed the previous handle before discarding it — fixed to
   `sharedStore?.close()` first, closing a real, separate `EBUSY` risk
   on Windows (a test's own `rmSync` of its scratch directory failing
   because a SQLite file handle inside it was still open).
2. Both `orchestrator-inspection.test.ts` and
   `packages/agents/devops/index.test.ts` (a second file found to have
   the identical latent risk via its own fake `/tmp/test-project` target
   paths, checked defensively even though no failure had yet surfaced
   there) now force `ORCHESTRAI_PERSIST=0` plus
   `__resetSharedStoreForTests()` in `beforeEach`/`beforeAll` and
   `afterEach`/`afterAll`, so neither file can ever touch a real store
   regardless of what fake path its own tests happen to use.

The stray `C:\proj\.orchestrai\` directory (and its real database files)
was deleted from the actual filesystem before any further work continued
— confirmed clean via `ls "/c/" | grep -i "^proj$"` returning nothing.

## The decisive live test

Real Gemini key (`.orchestrai/config.env`, already present in this
repository from earlier session work — `gemini-3.5-flash-lite`), the
real compiled runtime (`bun run orchestrai`), no mocks.

**Setup**: `bun run orchestrai --only orchestrator`. Before the fix
described in the spec's own status banner, this silently never started
`mcp:http` — `GET /healthz` showed `mcp.state: "disconnected"`
permanently and the supervisor's own startup summary omitted it
entirely. After adding the missing `startOrchestrator`-aware check to
`apps/supervisor/index.ts`'s `--only` handling, the exact same command
printed `note: orchestrator requires the MCP HTTP server — also
starting mcp:http` and both services reported healthy in the startup
summary.

**Step 1 — real deep analysis with DevOps genuinely not running.**
`POST /tasks {"text": "what language and stack is this project using?"}`
→ routed to `plan-task` → the adaptive supervisor's own zero-dispatch
branch → `composeSupervisorResult()` surfaced a real
`=== Codebase Analysis ===` section reading `Stack: Bun / TypeScript /
Docker / LangChain / AG-UI / OpenTUI` — genuinely correct for this
repository, not a guess, with `agents: 0` the entire time (`GET
/agents` confirmed). Direct inspection of the real
`.orchestrai/orchestrai.db` afterward via `bun -e` showed exactly one
`result_cache` row: `kind: "project-analysis"`, `project_root:
"C:\\Users\\moham\\devops-mcp-server"`, `producer: "orchestrator"`,
`resultLen: 952`.

**Step 2 — a second request reuses the cache, no recompute.** The
identical request, resubmitted. Completed normally. The stored row's
own `computed_at` timestamp (`1790057258249`) was **byte-identical**
before and after this second request — proof, read directly from the
database rather than inferred from response timing, that no second LLM
call was made.

**Step 3 — the decisive check: survives a full process kill and
restart.** `taskkill /F /IM bun.exe` killed every process in the stack;
`bun run orchestrai --only orchestrator` started a genuinely fresh one
(new PIDs, empty in-memory `tasks`/`registry` maps). The identical
request a third time completed correctly with the same grounded stack
identification. The database row's `computed_at` was **still**
`1790057258249` — the exact same value as before the restart. This is
the spec's own named "decisive live test," satisfied by direct database
inspection rather than by inference.

Process cleanly torn down afterward (`taskkill /F /IM bun.exe`, ports
confirmed free via `netstat`). `.orchestrai/orchestrai.db` confirmed
`git check-ignore`d, so this real local data was never at risk of being
committed.

## Known gaps, stated honestly

- The DevOps-writes/Orchestrator-reads direction of cross-process reuse
  (as opposed to the Orchestrator-writes/Orchestrator-reads direction
  just verified live) is proven by the shared, identical code path
  (`getCachedProjectAnalysis()`/`setCachedProjectAnalysis()`, the exact
  same functions DevOps's own `computeCodebaseAnalysisSection()` calls)
  plus a direct cross-producer unit test, not a second live pass with
  DevOps actually running. The mechanism is not in doubt — both callers
  share one implementation — but a live DevOps-then-Orchestrator
  sequence was not independently re-run this session.
- The genuine concurrent-stampede scenario (two real processes racing to
  compute the same analysis at the same instant) is proven by
  `store.test.ts`'s own `tryAcquireLease()` tests using two real
  `Database` handles, not by two real orchestrator processes racing
  live — the same standard `specs/060`'s own parallel-dispatch
  verification already accepted for a comparable concurrency claim.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/106-persistence-store-and-result-cache/spec.md` (implemented,
**verified**) crosses a boundary roughly ten prior specs (`001`, `004`,
`005`, `006`, `009`, `011`, `022`, `023`, `024`, `026`, `028`)
explicitly held as a non-goal — "no persistence" — for one stated
reason: `specs/103`'s deep analysis is a real 10-40s, real-cost provider
round trip, and before this spec it was recomputed by every process, on
every restart, with no way for one process to reuse what another
already paid for. Yusuf: *"i think it's the time to have a place to
save the chat, the resualts so on"* and *"so i can use this analysize
full feature even if the devops is off without having redandunt work."*

**`packages/shared/store.ts`** — `bun:sqlite`, zero new dependencies.
One **local** file at `<ORCHESTRAI_PROJECT_PATH>/.orchestrai/orchestrai.db`,
beside the `config.env`/`supervisor.log` already written there — no
network storage, no external service, anywhere in this design.
**Strictly optional / fail-open is the load-bearing property**:
`openStore()` returns `null` on any failure (missing
`ORCHESTRAI_PROJECT_PATH`, `ORCHESTRAI_PERSIST=0`, a read-only path, a
filesystem where `PRAGMA journal_mode = WAL` doesn't genuinely take —
checked against the actual returned value, not assumed, since a
synced-folder mount can silently fall back to a mode eight concurrent
writers can't safely share), and every caller treats `null` as "behave
exactly as if persistence didn't exist." `ORCHESTRAI_PERSIST=0` is a
real, permanent opt-out reusing that exact path at zero extra cost;
absent, it's on by default, matching how every LLM harness already
defaults on (`specs/077`). `busy_timeout=5000`,
`synchronous=NORMAL`, `auto_vacuum=INCREMENTAL` (set at creation —
unchangeable later without a full `VACUUM`), migration via
`CREATE TABLE IF NOT EXISTS` + `PRAGMA user_version` inside one
`BEGIN IMMEDIATE`, safe under eight simultaneous opens. `0600` on
POSIX. `bun:sqlite` is synchronous — every write is one
`db.transaction(...)()` doing no I/O, never spanning an `await`.

**One generic `result_cache` table**, keyed on a `kind` discriminator so
it is never shaped around a single consumer — `"project-analysis"`
today; the OSV.dev vulnerability lookups already in
`packages/agents/security/osv-client.ts` are the named, deliberately
not-yet-wired second candidate. **The cache key is where this either
ships its benefit or silently loses it**: `sha256(kind, project_root,
target_rel, input_hash, schema_ver)` — no conversation id anywhere,
since conversation-scoping is exactly what blocked cross-process reuse
before this spec. Validity on read: a stored git-status fingerprint is
re-checked (the `specs/057`/`102` pattern already established) with
`expires_at` as a TTL backstop. `tryAcquireLease()` is the concurrent-
stampede guard — a caller about to compute an expensive result first
writes a lease row (`result = NULL, lease_until = now + leaseMs`); a
second caller seeing an unexpired lease can wait or proceed without
duplicating the same in-flight work; without this, the spec would fix
restart redundancy but not the more common concurrent redundancy (a
six-agent fan-out hitting the same target at once).
`packages/shared/project-analysis.ts`'s own `getCachedProjectAnalysis()`/
`setCachedProjectAnalysis()` (stubbed `null` by `specs/105`) are now
real, wired onto this table — DevOps's `computeCodebaseAnalysisSection()`
and the Orchestrator's `computeDeepProjectAnalysis()` share the
identical read-compute-write path, so a result either one computes is
usable by the other.

**Retention, owned by exactly one process** — the Orchestrator, on
startup and a 15-minute `setInterval().unref()`; every other process
never prunes, so there is one owner and no cross-process contention.
`result_cache`: delete expired rows, then delete stale (expired) leases,
then cap at 2,000 rows by `computed_at`. A missing/unopenable store
degrades this to a silent no-op, the same fail-open guarantee as
everything else in this module.

**`packages/shared/project-snapshot-cache.ts` (`specs/057`'s original
in-memory, conversation-scoped cache) is retired and deleted**, not kept
alongside the durable store — "one cache, not two" is a deliberate
choice, not an oversight: this codebase has already been bitten once by
one rule living in three places (`specs/015`'s `ci`-substring bug).
Every real behavior specs/057 established carries over unchanged onto
the store: the 5-minute TTL, the cheap git-status cross-check before
serving an `analyze-project` hit, the explicit-refresh bypass
(`EXPLICIT_REFRESH_PATTERN`, now a local const in
`apps/orchestrator/index.ts` rather than an import from the deleted
module). **One behavior deliberately changes**: the store's own cache
key carries no conversation id, so an entry now survives a restart and
is visible across conversations and processes — the entire point of
retiring the second, differently-scoped cache. `dispatchRootTask()`
still gates every cache read/write on `conversationId` being present at
all — a bare `POST /tasks` never consults or populates the cache,
unchanged from `specs/057`'s own original rule — but that gate is a
product-behavior choice (a stateless one-off dispatch doesn't
participate in caching), not a scoping mechanism, so it survived this
migration untouched.

**A real cross-test-contamination bug found and fixed before this
spec's own tests could be trusted.** `apps/orchestrator/
orchestrator-inspection.test.ts`'s `beforeEach` sets
`process.env.ORCHESTRAI_PROJECT_PATH` to a fake, never-real string
constant (`"C:\\proj"`) that long predates this spec. Once the deep-
analysis call sites started reading that same env var to resolve the
store's own db location, this test file's `beforeEach` caused
`openStore()` to genuinely `mkdirSync` and create a **real** SQLite
database directly on the real `C:` drive root — confirmed via `ls -la
"C:/proj/.orchestrai"` showing real `orchestrai.db`/`-shm`/`-wal` files.
A later test's own cache write then leaked into an unrelated test's
assertions, producing 3 real failures. Fixed two ways: (1)
`__resetSharedStoreForTests()` (`packages/shared/store.ts`) didn't close
the previous handle before discarding it — a separate, real `EBUSY` risk
on Windows when a test's own scratch-directory cleanup runs while a
SQLite file handle inside it is still open; fixed to `close()` first.
(2) Both this file and `packages/agents/devops/index.test.ts` (a second
file with the identical latent risk via its own fake `/tmp/test-project`
paths, found defensively before it ever actually failed) now force
`ORCHESTRAI_PERSIST=0` plus `__resetSharedStoreForTests()` around every
test, so neither can ever touch a real store regardless of what fake
path its own fixtures use. The stray real files were deleted from the
actual filesystem before any further work continued.

**A second real gap, found while live-verifying this spec, not assumed
away**: `apps/supervisor/index.ts`'s `--only <names>` handling
auto-starts `mcp:http` when a selected *agent* (`dependsOnMcp: true`)
needs it — but the Orchestrator itself (`specs/102`'s own MCP client,
default-on) is started through a completely separate
`startOrchestrator` flag, never through the `toStart` array that
auto-include check inspects, so it was never considered at all.
`--only orchestrator` — a mode this file's own prior text already
described as delivering "orchestrator + mcp:http only" — silently never
started `mcp:http`, so the Orchestrator's own MCP client stayed
permanently `disconnected` and the very feature this spec exists to
make reachable without DevOps couldn't actually reach the MCP tools it
needs. Fixed: the auto-include check now also asks whether the
Orchestrator itself will start and wants MCP
(`process.env.ORCHESTRAI_ORCHESTRATOR_INSPECTION !== "0"`, the same
opt-out `buildOrchestratorMcpClient()` itself already honors) —
confirmed live: `--only orchestrator` now prints `note: orchestrator
requires the MCP HTTP server — also starting mcp:http` and both
services report healthy.

**The decisive live test, against a real Gemini deployment and the real
compiled runtime, no mocks**: `bun run orchestrai --only orchestrator`
(DevOps genuinely not running, confirmed via `GET /agents` →
`count: 0`). `POST /tasks {"text": "what language and stack is this
project using?"}` produced a real, correctly-grounded `=== Codebase
Analysis ===` section (`Stack: Bun / TypeScript / Docker / LangChain /
AG-UI / OpenTUI` — genuinely correct for this repository); the real
`.orchestrai/orchestrai.db` showed exactly one `result_cache` row,
`producer: "orchestrator"`. The identical request resubmitted completed
normally with the stored row's own `computed_at` timestamp
**byte-identical** before and after — read directly from the database,
not inferred from response timing, proving no second LLM call was made.
The entire process stack was then killed
(`taskkill /F /IM bun.exe`) and restarted fresh — genuinely new PIDs,
empty in-memory task/registry maps. The identical request a third time
completed correctly with the same grounded identification, and the
database row's `computed_at` was **still** the exact same value as
before the restart — the spec's own named "decisive live test,"
satisfied by direct database inspection rather than by inference.

1257 tests pass (0 fail, 2 skip — the pre-existing Docker-daemon-gated
tests, unrelated), typecheck clean, `specs:check` passed for 107 specs.
See `specs/106`'s own `verification.md` for the complete transcript,
including the two known, honestly-stated gaps: the DevOps-writes/
Orchestrator-reads reuse direction is proven by the shared code path
plus a direct cross-producer unit test rather than a second live pass
with DevOps actually running, and the genuine concurrent-stampede
scenario is proven with two real `Database` handles in `store.test.ts`
rather than two real racing processes.

See specs/107-task-and-conversation-history/verification.md for the relocated narrative covering this checkpoint.

See specs/108-durable-audit-trail/verification.md for the relocated narrative covering this checkpoint.

See specs/110-approval-state-survives-a-restart/verification.md for the relocated narrative covering this checkpoint.
