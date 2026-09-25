# Verification: Approval State Survives an Agent Restart

Date: 2026-09-22

## Summary

B0–B6 implemented as specced. `packages/shared/store.ts` gained the
`pending_actions` table and its five methods (`upsertPendingAction`,
`claimPendingAction`, `deletePendingAction`, `listUnexpiredPendingActions`,
`pruneExpiredPendingActions`) — `CURRENT_USER_VERSION` bumped 3 → 4.
`packages/shared/pending-action-store.ts` is the new generic,
agent-agnostic helper layer (`persistPendingAction`/`claimPendingAction`/
`forgetPendingAction`/`restorePendingActions`) every agent calls, fail-open
throughout: with no store, every function degrades to a safe no-op and the
in-memory `Map` alone remains the sole boundary, byte-identical to before
this spec.

Wired into all four write-capable agents (DevOps, Testing, Documentation,
Coder), matching B1–B4 exactly:

- **DevOps** (`packages/agents/devops/index.ts`): persists at the two
  fingerprinted-write sites (`commit-changes`, and the real
  dockerize/create-ci/create-gitignore/create-compose write path) as
  `kind: "write"`, and at the `run-command` site as `kind: "command"`.
  The two no-fingerprint degrade paths and the EXECUTING skills
  (`build-image`/`verify-deployment`) are deliberately never persisted,
  exactly as scoped. `resumeTask()` calls `claimPendingAction()` before
  proceeding and `forgetPendingAction()` in a `finally` block covering
  every exit path. `restoreApprovalsOnStartup()` runs before the HTTP
  server binds, appending the "approved before a process restart..."
  risk line only for `kind: "command"` rows.
- **Testing** (`packages/agents/testing/index.ts`): `write-tests`
  persists as `kind: "write"`; both `run-tests` and the `run-command`
  fallback persist as `kind: "command"`. Same claim/forget/restore shape.
- **Documentation** (`packages/agents/documentation/index.ts`): both
  `generate-readme` and `document-api` persist as `kind: "write"`,
  unblocked by `specs/109`'s fingerprint addition. Same shape, wrapped in
  a `try/finally` around the existing drift-recheck block plus the write.
- **Coder** (`packages/agents/coder/index.ts`): `edit-file` persists as
  `kind: "write"` — the simplest of the four, no conditional fields.

`apps/orchestrator/index.ts`'s existing Orchestrator-only retention sweep
(`pruneResultCacheOnce()`) gained one more line, `store?.pruneExpiredPendingActions(Date.now())`,
alongside the existing `result_cache`/`tasks`/`conversations`/`audit_events`
pruning — no new interval.

## Automated verification

- `bun run typecheck` — 0 errors, run after every phase (Coder, DevOps,
  Testing, Documentation, retention-sweep wiring) and once more at the
  end.
- New tests: `packages/shared/pending-action-store.test.ts` (11 tests —
  the full no-store-no-op matrix, plus real-store persist/claim/forget/
  restore, the adversarial double-claim, the claimed-row-never-restored
  case, the corrupted-row-discarded case, and the per-kind TTL values)
  and 9 new `pending_actions`-specific tests inside `packages/shared/store.test.ts`
  (added in the prior session before this one; both were re-confirmed
  passing here).
- Full suite: **1327 pass, 2 skip (pre-existing, Docker-daemon-gated,
  unrelated), 0 fail** across 84 files — net +20 over `specs/109`'s own
  1307-test baseline (11 new `pending-action-store.test.ts` tests + 9
  `store.test.ts` `pending_actions` tests from the prior session).
- Two environmental issues hit and resolved during this pass, neither a
  code regression: (1) a Bun stack-overflow/illegal-instruction crash on
  the very first two full-suite attempts — resolved by simply retrying
  (a known, previously-documented class of sandbox flakiness in this
  codebase's own history, not reproducible a third time); (2) one
  genuine test failure (`devops/index.test.ts`'s "analyze-project —
  reaches a terminal state gracefully with no live MCP server") caused
  by a real, leftover `bun.exe` process from an earlier live-verification
  session still bound to port 3006 — confirmed via `netstat`, killed via
  `taskkill`, and the test passed cleanly on every subsequent run. Not
  caused by any code in this spec.

## Live verification (real processes, real files, no mocks)

A scratch MCP HTTP server (`packages/mcp/http.ts`, port 19206) and a
scratch DevOps agent (port 19202, `ORCHESTRAI_DEVOPS_LLM_HARNESS=0` —
the deterministic content-generation path exercises the identical
drift/persistence mechanics as the LLM path) were started against a real
scratch target project and a real, dedicated `ORCHESTRAI_PROJECT_PATH`
(so the store's own db location was isolated from any other session).

**Scenario 1 — a real fingerprinted write survives a hard kill.**

1. `POST /` with `"dockerize the bun project at ..."` → real
   `input-required` with a genuine `create_dockerfile` preview (real
   Dockerfile content, `fingerprint: "absent"` — a fresh create).
2. Read the real `.orchestrai/orchestrai.db` directly via `openStore()`
   (the same path-resolution code the real process uses) — confirmed
   exactly one `pending_actions` row, `status: "pending"`, the full real
   payload including the exact preview content.
3. Found the real bound PID via `netstat` (not the shell's own reported
   PID, which was a wrapper) and hard-killed it with `taskkill /F` — a
   genuine crash simulation, not a graceful shutdown.
4. Confirmed `GET /healthz` on that port now fails (the process is
   genuinely gone).
5. Restarted DevOps with the identical environment. Startup log printed
   `[devops-agent] restored 1 pending approval(s) after restart`.
6. `GET /tasks/:id` returned the task at `input-required` again, the
   exact same `actionId`, the exact same preview content, with the new
   `step` text `"restored after restart — waiting for human approval..."`.
7. `POST /tasks/:id/approve` with that same `actionId` → `completed`.
8. The real Dockerfile on disk was read directly and confirmed
   **byte-identical** to both the original and the restored preview's
   `content` field.
9. Re-read the store: the `pending_actions` row was gone — confirming
   `forgetPendingAction()` fired correctly after the real write.

**Scenario 2 — a restored command approval carries the risk line and
still executes correctly.**

1. `POST /` with `"run command: echo hello-restart-test at ..."` → real
   `input-required` with a `run_command` preview, two risk lines (the
   two ordinary ones every `run-command` preview already has).
2. Hard-killed and restarted DevOps identically to Scenario 1.
3. `GET /tasks/:id` on the restored task showed the **exact same two
   original risk lines plus a third**: *"This command was approved
   before a process restart. Its target may have changed since — no
   automatic recheck is possible for a command."* — confirming B5's own
   design decision live, not just by unit test.
4. Approved with the original `actionId` → `completed`, result
   `"hello-restart-test"` — the real command genuinely executed after
   surviving the restart.

Both scratch processes and their scratch directories were torn down
after verification; no state from this pass was left running or on
disk.

## What was not separately live-verified

- **Testing/Documentation/Coder's own restart survival** — wired
  identically to DevOps (same shared `pending-action-store.ts` calls,
  same `restoreApprovalsOnStartup()` shape, confirmed by direct code
  reading) and covered by the full test suite, but a live kill/restart/
  approve cycle was performed only for DevOps. The mechanism is
  agent-agnostic by construction (the same three shared functions), so
  DevOps's live pass is treated as proof of the mechanism; the other
  three agents' own per-skill logic (drift recheck, content computation)
  is unchanged by this spec and already independently live-verified by
  their own specs (`specs/081`, `specs/083`, `specs/109`).
- **TTL expiry itself** — the 1-hour command / 24-hour write values are
  real and unit-tested (`PENDING_ACTION_TTL_MS`, `listUnexpiredPendingActions`'s
  own expiry filter), but forcing a real hour-plus wait (or a clock
  override on a live process) was not performed. See the acceptance
  criteria correction above for the exact (defensible) shape this takes.
- **A genuine crash between `claimPendingAction()` succeeding and the
  write finishing** (the `'claimed'`-row-orphaned case) — proven at the
  store level (`pending-action-store.test.ts`), not forced against a
  real process (would require killing the process at a precise moment
  mid-write, not practically reproducible on demand).
- **Orchestrator-side observation of the restore** (confirming
  `pollAgent()`/`applyAgentUpdate()` genuinely stop 404ing once the
  agent restarts) — the spec's own "Current behavior" section traced
  this code path by reading it directly rather than asserting it
  untested; a real Orchestrator-in-the-loop pass was not performed this
  session, only the direct agent-level HTTP calls above. The underlying
  claim (an agent's `GET /tasks/:id` succeeding again is all
  `pollAgent()` needs) is unchanged code on the Orchestrator side.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/110-approval-state-survives-a-restart/spec.md` (implemented,
**verified**) closes the gap `specs/106`/`specs/107` both named
explicitly and deferred: before this spec, every write-capable agent's
`pendingActions: Map<string, PendingAction>` was pure in-memory state —
an agent restarting (crash, redeploy, `orchestrai` restart) while a task
sat at `input-required` silently lost the pending approval forever, while
the Orchestrator's own task record kept showing the full approval card
(real content, a real `actionId`) as a permanent, unresolvable ghost
(traced precisely: `pollAgent()` doesn't check `res.ok`, so the agent's
real 404 is silently absorbed and nothing about the stuck card ever
changes). **Deliberately scoped to an *agent* restarting, not the
Orchestrator** — a materially larger, separate problem (AG-UI run state,
plan-step waiters, the skip/reject distinction) explicitly left for a
future spec.

**`packages/shared/store.ts` gains a `pending_actions` table** (schema
version 3 → 4): `(agent, task_id, action_id, kind, skill, payload_json,
status, created_at, expires_at)`, primary-keyed on `(agent, task_id)`.
`kind` is `"write"` (24h TTL — a real content fingerprint exists to
re-check) or `"command"` (1h TTL, deliberately short — a `run-command`/
`run-tests` proposal has nothing file-shaped to re-verify, so the TTL
alone bounds how stale a restored, about-to-execute command can be).
Five new store methods, the load-bearing one being
`claimPendingAction()`: a single `UPDATE ... WHERE status = 'pending'`
transaction that becomes **the real single-consumption boundary once
persistence is enabled** — not `Map.delete()`, which only ever protected
against two concurrent requests within one process. A `'claimed'` row
(a crash between claiming and finishing the real write) is never
restored on the next startup, under any circumstance — deliberately
left ambiguous rather than guessed at (see the spec's own "Crash during
execution" section); it is simply swept away by the existing retention
job, with a `console.warn` naming the orphaned action. Retention itself
gained one more line in the Orchestrator's own existing sweep
(`pruneExpiredPendingActions()`, alongside `result_cache`/`tasks`/
`conversations`/`audit_events` — still one interval, not a new one).

**`packages/shared/pending-action-store.ts`** (new) is the generic,
agent-agnostic layer every one of the four write-capable agents calls —
`persistPendingAction()`/`claimPendingAction()`/`forgetPendingAction()`/
`restorePendingActions()` — deliberately fail-open throughout: with no
store (`ORCHESTRAI_PERSIST=0`, or no `ORCHESTRAI_PROJECT_PATH`), every
function degrades to a safe no-op and the in-memory `Map` alone remains
the sole boundary, byte-identical to before this spec. `payload_json`
holds each agent's own real, private `PendingAction` shape — DevOps's,
Testing's, Documentation's, Coder's — JSON-serialized verbatim; this
module knows nothing about any of their shapes, only `unknown`.

**Wired into DevOps, Testing, Documentation, and Coder identically**:
persist at the same point the in-memory `Map.set()` already happens,
atomic-claim before `resumeTask()` proceeds (a `finally` block —
DevOps/Documentation wrap the whole drift-recheck-plus-write body —
ensures the persisted row never outlives one attempt regardless of
outcome), forget on reject, and a new `restoreApprovalsOnStartup()`
called once in each agent's own `start()`, before the HTTP server
binds — reusing each agent's own existing `buildApprovalPreview()`
verbatim, never a second preview-construction path. A restored `kind:
"command"` action's preview gets one added risk line naming that no
drift recheck is possible for it; a restored `kind: "write"` action
needs no such addition, since its own existing fingerprint recheck in
`resumeTask()` already covers a restored action identically to a
same-process one. **Two DevOps paths are deliberately excluded, named
honestly rather than silently included**: the two no-fingerprint
degrade paths (an "unknown" skill, a failed dry-run) and the EXECUTING
skills (`build-image`/`verify-deployment`, real Docker operations with
no content fingerprint of any kind) — these remain exactly as fragile
as before this spec, a named follow-up, not assumed safe to persist
under this checkpoint's own time budget.

**Restore-time validation is a real Zod schema per agent** (matching
this codebase's own "validate strictly, fail closed" convention every
LLM harness already uses) — a row that fails to `JSON.parse()` or fails
validation is discarded exactly like an expired one, deleted, never
partially trusted. This is the concrete answer to this spec's own
sharpest safety finding: a lossy round-trip must never silently produce
an action that skips its own recheck.

**One acceptance criterion corrected from its own draft wording, not
silently softened**: TTL expiry is enforced by
`listUnexpiredPendingActions()` itself never returning an expired row to
the restore loop — so an approval that ages past its TTL before a
restart is simply gone after that restart (identical to today's
pre-`110` silent-loss shape), rather than restored and then explicitly
refused as "expired" on approve. This is the more defensible design (it
never shows a human a card for something already too stale to trust)
and matches the spec's own B0 wording ("never restored," not "restored
expired") — only the acceptance criterion's own phrasing was imprecise.

1327 tests pass (net +20 over `specs/109`'s own 1307 baseline — 11 new
`packages/shared/pending-action-store.test.ts` tests plus 9 new
`pending_actions`-specific tests in `packages/shared/store.test.ts`),
typecheck clean, `specs:check` passed for 109 specs.

**Live-verified against real processes, real files, no mocks**: a
scratch MCP HTTP server and a scratch DevOps agent, a real scratch
target project, a dedicated `ORCHESTRAI_PROJECT_PATH`. **Scenario 1**: a
real `dockerize` approval reached `input-required`; the real
`pending_actions` row was confirmed on disk via `openStore()` directly;
the real bound process was found via `netstat` (not the shell's own
reported PID, a wrapper) and hard-killed via `taskkill /F` — a genuine
crash simulation; DevOps restarted with identical config, printed
`restored 1 pending approval(s) after restart`, and `GET /tasks/:id`
returned the exact same `actionId` and preview content with a new
`"restored after restart"` step text; approving it produced a real
Dockerfile on disk **byte-identical** to both the original and restored
preview, and the store row was confirmed deleted afterward. **Scenario
2**: an identical kill/restart cycle on a real `run-command` approval
confirmed the restored preview carried the exact designed third risk
line (*"This command was approved before a process restart... no
automatic recheck is possible for a command."*) alongside the two
ordinary ones, and approving it still genuinely executed
(`echo hello-restart-test` → real captured output). **Not separately
live-verified**: Testing/Documentation/Coder's own restart survival
(wired identically, covered by the full suite, DevOps's live pass
treated as proof of the shared mechanism per this codebase's own
established precedent for identically-wired multi-agent checkpoints);
a real hour-plus TTL-expiry wait; a genuine crash precisely between
`claimPendingAction()` succeeding and the write finishing (the
`'claimed'`-row case, proven at the store level instead). See
`specs/110`'s own `verification.md` for the complete transcript.

- ~~No persistence; all task state is in memory.~~ The live `tasks`/
  `registry` Maps on each process remain the source of truth while a
  process is running (the Orchestrator's own AG-UI run state, plan-step
  waiters, and the skip/reject distinction are still in-memory-only —
  Orchestrator-side restart recovery remains a genuinely separate,
  still-open, deliberately out-of-scope problem, named explicitly in
  `specs/110`'s own Non-Goals). What changed:
  `specs/106-persistence-store-and-result-cache/spec.md` (implemented,
  verified) added a local, optional, fail-open SQLite store
  (`<ORCHESTRAI_PROJECT_PATH>/.orchestrai/orchestrai.db`, `bun:sqlite`,
  no network storage; `ORCHESTRAI_PERSIST=0` disables it entirely) as a
  cross-process, restart-surviving cache for expensive read-only results
  (`specs/103`'s own deep project analysis).
  `specs/107-task-and-conversation-history/spec.md` (implemented,
  verified) added durable `tasks` and `conversations`/`turns` tables on
  the same store, so completed/failed task results and chat history
  genuinely survive a restart. `specs/108-durable-audit-trail/spec.md`
  (implemented, partial verification) added a durable, queryable
  `audit_events` table plus a dashboard Audit tab and TUI Audit view.
  `specs/109-document-api-drift-recheck/spec.md` (implemented, verified)
  gave Documentation the same post-approval drift recheck every other
  write-capable agent already had. `specs/110-approval-state-survives-
  a-restart/spec.md` (implemented, verified) closed the one gap all of
  the above explicitly deferred: a write-capable **agent** (DevOps,
  Testing, Documentation, Coder) restarting while a task sits at
  `input-required` now survives — the pending approval is persisted,
  atomically claimed on approve (the real single-consumption boundary),
  and restored at the next startup with its own drift/TTL guarantees
  intact. Orchestrator-side restart recovery remains the one deliberately
  unaddressed half.

See specs/109-document-api-drift-recheck/verification.md for the relocated narrative covering this checkpoint.
