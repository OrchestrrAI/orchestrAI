---
id: 110-approval-state-survives-a-restart
title: "Approval State Survives an Agent Restart"
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
  - 040-approval-preview-content-diff
  - 056-devops-preflight-and-idempotent-writes
  - 080-run-command-approved-execution
  - 081-testing-write-tests-skill
  - 083-coder-agent
  - 106-persistence-store-and-result-cache
  - 107-task-and-conversation-history
related:
  - 021-ag-ui-event-protocol
  - 104-deferred-work-register
  - 108-durable-audit-trail
  - 109-document-api-drift-recheck
supersedes: []
superseded_by: []
---

# Spec: Approval State Survives an Agent Restart

> Status: **IMPLEMENTED, VERIFIED, 2026-09-22.** `specs/106` and `specs/107` both
> named this explicitly as a deliberately-deferred, safety-critical gap
> ("an approval surviving a restart is safety-critical — `specs/056`'s
> fingerprint recheck exists precisely because a stale approval is
> dangerous") and pointed here. Grounded by a direct investigation of
> every agent's real `pendingActions` code before drafting — see
> "Current behavior" below, all file:line references read from the
> actual files, not assumed. Depends on `specs/109` for Documentation's
> own inclusion (it has no fingerprint to recheck today).

## Purpose

Today, if an **agent** process restarts (crash, deploy, `orchestrai`
restart) while a task sits at `input-required`, the pending approval is
gone from memory forever — but the Orchestrator's own task record is
untouched and keeps showing the full approval card (real file content,
a real diff, a real `actionId`) as if it were still live. Approving it
now 404s silently; the card is a permanent ghost with no way to resolve
it. This spec makes that specific case — an agent restarting — a
genuine, safe recovery instead of a silent, permanent loss.

**Deliberately not attempted here**: recovering from the *Orchestrator*
restarting (a materially larger problem — AG-UI run state, plan-step
waiters, the skip/reject distinction, and `taskConversations` are all
in-memory Orchestrator concerns with no analogue on the agent side; see
"Non-goals"). If only the agent restarts (the common case — an agent
crashing or being redeployed independently is more likely than the
whole stack going down together), this spec closes the gap completely.
If *both* restart, the pending action still survives on the agent's own
side and remains directly approvable against that agent's own
API/dashboard, even though the Orchestrator's own UI can't reach it
until a separate future spec addresses that half.

## Current behavior (verified against the real code)

Every write-capable agent keeps its own `pendingActions: Map<string,
PendingAction>`, keyed by the agent-local task id, holding a private,
per-agent-shaped payload — never persisted, never reconstructed:

| Agent | File | Map declared | `PendingAction` shape | Populated | Consumed (`resumeTask`) |
|---|---|---|---|---|---|
| DevOps | `packages/agents/devops/index.ts` | :143 | :125–141 (`toolName?`, `args?`, `targetPath`, `content?`, `previousContent?`, `fingerprint?`, `projectRoot?`) | :710 (run-command), :742 (commit-changes), :803 (build-image/verify-deployment), :825/:843 (degrade paths), :878 (dockerize/create-ci/create-gitignore/create-compose) | :914–1015 |
| Testing | `packages/agents/testing/index.ts` | :200 | :170–198, a discriminated union (`RunAction` — no fingerprint; `WriteTestsAction` — fingerprint required) | :282 (run-command/run-tests), :502 (write-tests) | :594–730 |
| Documentation | `packages/agents/documentation/index.ts` | :495 | :480–493 (no `fingerprint` at all — closed by `specs/109`) | :581 | :605–634 |
| Coder | `packages/agents/coder/index.ts` | :158 | :142–155 (`fingerprint` required) | :281 | :310–362 |
| Security, Code Review | — | — | — | — | Confirmed no write skills exist — `security/index.ts:626`, `code-review/index.ts:225` both say so directly in-comment. No approve/reject routes on either. |

`resumeTask()` is the single consumption point everywhere, and every
one does the identical `get()` then **immediate `delete()`** before any
validation (e.g. `devops:915–916`) — this is what makes double-approve
impossible today (explicit comment at `devops:1083–1085`). Nothing
about this state is written to `specs/106`'s store:
`startTaskPersistenceSweep()` (`packages/shared/store.ts:667–699`)
explicitly skips any task not `"completed"`/`"failed"` (line 678), and
`emitTaskState()`'s Orchestrator-side hook
(`apps/orchestrator/index.ts:646–679`) only calls `persistTaskTerminal()`
from the completed/failed branch (670) — the `input-required` branch
(647–665) only emits the AG-UI event and returns.

**Traced precisely**: with the agent restarted, the Orchestrator's own
`pollAgent()` (`apps/orchestrator/index.ts:1026–1031`) does not check
`res.ok`, so the agent's real `404 {"error":"Task not found"}` is parsed
as a task view with `status: undefined`; `applyAgentUpdate()`
(1036–1060) falls through its `else` branch and mutates nothing. The
Orchestrator's task stays at `input-required` forever, `syncTaskStatus()`
(1067) only short-circuits on `"failed"`, so it is re-polled on every
dashboard refresh indefinitely. `POST /tasks/:id/approve` passes every
Orchestrator-side guard (2491/2497/2504/2508), forwards to the agent,
gets the same 404, and surfaces it as a generic `400 {"error":"Agent
rejected approval"}` — with no AG-UI event, no state change, and the
card still fully rendered.

## Proposed behavior

### B0 — store schema and the atomic claim primitive

```sql
CREATE TABLE IF NOT EXISTS pending_actions (
  agent        TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  action_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,    -- 'write' | 'command'
  skill        TEXT NOT NULL,
  payload_json TEXT NOT NULL,    -- the agent's own real PendingAction, JSON-serialized verbatim
  status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'claimed'
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (agent, task_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_actions_action_id ON pending_actions(action_id);
CREATE INDEX IF NOT EXISTS ix_pending_actions_expiry ON pending_actions(expires_at);
```

`OrchestraiStore` gains, mirroring `tryAcquireLease()`'s own already-
proven transactional shape (`store.ts`'s `result_cache` stampede guard):

- `upsertPendingAction({agent, taskId, actionId, kind, skill, payloadJson, createdAt, expiresAt})` —
  written at the exact same moment the in-memory `pendingActions.set()`
  already happens, before the task is marked `input-required`.
- `claimPendingAction({agent, taskId})` — one transaction:
  `UPDATE pending_actions SET status = 'claimed' WHERE agent = ? AND
  task_id = ? AND status = 'pending'`, returns whether a row was
  actually updated. This — not the in-memory `Map.delete()` — becomes
  the real single-consumption boundary; two concurrent approve requests
  (or a request racing a restart) can never both proceed.
- `deletePendingAction({agent, taskId})` — called after a successful
  write, a normal (non-crash) failure, or a reject, matching exactly
  when `pendingActions.delete()` fires today.
- `listUnexpiredPendingActions({agent, now})` — `status = 'pending' AND
  expires_at > now`, for startup restore. **A `'claimed'` row is never
  restored, under any circumstance** — see "Crash during execution"
  below.
- `pruneExpiredPendingActions(now)` — deletes expired `'pending'` rows
  and **all** `'claimed'` rows regardless of expiry (a claimed-but-
  never-confirmed row always means an ambiguous, possibly-crashed
  execution). Wired into the Orchestrator's own existing retention
  sweep (`specs/106`'s "one owner" principle — the table is shared, but
  only the Orchestrator prunes it, exactly like `result_cache`/`tasks`/
  `conversations`/`audit_events` already do), not a new interval.

**TTL, deliberately different per `kind`** — this is the mechanism
substituting for the missing drift-check on command approvals (see B5):

- `kind: "write"` — 24 hours (matching `specs/106`'s own
  `project-analysis` cache TTL precedent: long enough to survive a
  realistic redeploy window, short enough that a month-old approval
  card never lingers).
- `kind: "command"` — 1 hour. Command approvals have no fingerprint —
  nothing re-verifies the target state before an approved `argv` runs —
  so the *only* thing bounding how stale an approval-to-execute can be
  is this TTL. Kept deliberately short.

### B1 — DevOps: fingerprinted writes

`dockerize`/`create-ci`/`create-gitignore`/`create-compose` (:878) and
`commit-changes` (:742) — both already compute a real `fingerprint` at
preview time. `upsertPendingAction()` called alongside the existing
`pendingActions.set()`; `resumeTask()`'s existing `get()`+`delete()`
prefix (:915–916) becomes `claimPendingAction()` first (refusing to
proceed if the claim fails — the row was already claimed or the action
never existed/expired), the in-memory `Map.get()` for the actual payload
kept as today (restore populates it, see B6), and `deletePendingAction()`
called wherever `pendingActions.delete()` already implicitly happens via
the map (success or ordinary failure).

**The two no-fingerprint degrade paths (:825 unknown/unimplemented
skill, :843 failed dry-run) and the EXECUTING skills (:803,
`build-image`/`verify-deployment` — real MCP calls with no content
fingerprint of any kind) are explicitly OUT of scope for this spec.**
Named honestly rather than silently included: there is no existing
safety mechanism for these today (not even the TTL-only precedent B5
establishes for genuine commands — those are real Docker build/run
operations, a different risk shape again), and inventing one under this
spec's own time pressure would be exactly the kind of naive addition
§(d) of the grounding investigation warns against. These stay exactly
as fragile as they are today: not persisted, not restorable, still lost
on a restart. A follow-up spec, not this one.

### B2 — Testing: `write-tests`

Same shape as B1, for the one Testing action that already has a
required fingerprint (`WriteTestsAction`, :180–196). `RunAction` (the
`run-tests`/`run-command` proposal, no fingerprint) is covered
separately under B5, not here.

### B3 — Coder: `edit-file`

Same shape as B1 — Coder's `EditFileAction` already requires
`fingerprint`/`previousContent`/`content` unconditionally (:142–155),
so this is the most direct of the four ports; no conditional-field
handling needed the way DevOps's mixed fingerprinted/unfingerprinted
skills require.

### B4 — Documentation: `generate-readme` / `document-api`

Depends on `specs/109` landing first — otherwise there is no
`fingerprint` field to persist or recheck, and this spec's own fail-
closed principle (B0) would mean Documentation's restored actions could
never be safely resumed at all.

### B5 — Command-execution approvals (`run-command`, `run-tests`) —
### `kind: "command"`, TTL-only, a strictly weaker guarantee

DevOps's `run-command` (:710) and Testing's `run-command`/`run-tests`
(:282) have **no fingerprint concept** — there is nothing file-shaped to
re-verify before running an approved `argv`. Persisting these is
explicitly what Yusuf asked to include, with the tradeoff stated
plainly rather than glossed over: **restoring one of these after a
restart means re-running a human-approved command against whatever the
working tree happens to be when it's approved, with no check that
anything about the target project is still what it was when the human
looked at it.** The only guard is the 1-hour TTL from B0 — deliberately
short precisely because it is the *only* guard.

The approval preview for a restored command action must say this
explicitly, not just behave this way silently: `buildApprovalPreview()`
for a `kind: "command"` restored action appends a risk line — *"This
command was approved before a process restart. Its target may have
changed since — no automatic recheck is possible for a command."* —
appended only when the action is a genuine post-restore restore (a
fresh, same-process approval never shows it), so a human approving a
restored command approval sees the caveat, not just an ordinary-looking
card.

### B6 — Restore at startup

Each write-capable agent's own `start()` calls a new shared helper
(`packages/shared/store.ts`, mirroring `startTaskPersistenceSweep()`'s
own shape) once, before the HTTP server binds:

1. `listUnexpiredPendingActions({agent: "<agent-name>", now: Date.now()})`.
2. For each row: `JSON.parse(payload_json)`, validated against that
   agent's own Zod schema for its `PendingAction` shape (one schema per
   agent, matching this codebase's own established "validate strictly,
   fail closed" convention already used throughout every LLM harness).
   **A row that fails to parse or fails validation is treated exactly
   like an expired one — skipped and deleted, never partially trusted.**
   This is the concrete answer to the grounding investigation's
   sharpest finding: a lossy round-trip must never silently produce an
   action that skips its own recheck.
3. A validated row repopulates the in-memory `pendingActions.set(taskId,
   action)` and `tasks.set(taskId, {status: "input-required",
   requiresApproval: true, approval: buildApprovalPreview(action),
   step: "restored after restart — awaiting human approval"})` —
   reusing each agent's own existing `buildApprovalPreview()` verbatim,
   never a second, separately-maintained preview-construction path.

Once this runs, the Orchestrator's next poll of that same task id
(`GET /tasks/:id` on the agent) succeeds normally — the exact same code
path as if the agent had never restarted at all. No Orchestrator-side
change is needed for this to work: `pollAgent()`/`applyAgentUpdate()`
are already correct once the agent stops 404ing.

### Crash during execution — the ambiguous case, resolved by construction

If the process dies between a successful `claimPendingAction()` and the
real write actually completing, the row is left in `'claimed'` status.
On the next startup, `listUnexpiredPendingActions()` never returns a
`'claimed'` row (B0) — it is silently dropped by
`pruneExpiredPendingActions()` at the next sweep, logged with a
`console.warn` naming the orphaned `taskId`/`actionId` pair. **This is a
deliberate, disclosed gap, not an oversight**: whether the write
actually happened is genuinely unknown at that point, and re-executing
it risks a double-write while refusing to ever mention it again risks
confusing a human who remembers approving something. The `console.warn`
is the minimum honest signal; a durable, queryable record of this
specific case is exactly what `specs/108`'s own audit trail is for —
naming that connection here as a real, deliberately-deferred follow-up
(an `audit_events` row for "approval outcome unknown after crash" is
not attempted in this spec).

## Scope

In scope: B0–B6 above; the four agents' own `resumeTask()`/`processTask()`
wiring for their fingerprinted write skills; command-execution approvals
for DevOps/Testing with the TTL-only guarantee; startup restore; the
Orchestrator's own retention sweep gains one more table.

Out of scope (see each section above for why): DevOps's two no-
fingerprint degrade paths and its EXECUTING skills (build-image/
verify-deployment); Orchestrator-side restart recovery (Trace B/C from
the grounding investigation) — a materially larger, separate problem
touching AG-UI run state, plan-step waiters, and the skip/reject
distinction; a durable approval-decision audit event kind (a real,
valuable, cheap addition the grounding investigation surfaced, but not
part of what was scoped here — a candidate follow-up, named in
`specs/104`).

## Safety constraints

- **Fail-closed on any lossy or ambiguous restore, unconditionally.**
  A row that fails to parse, fails validation, or is found `'claimed'`
  is never resumed — it is discarded, never silently executed with a
  skipped recheck.
- **`actionId` is preserved exactly across a restore, never re-minted.**
  A client/TUI holding the original id from before the restart must
  still be able to use it.
- **No new redaction beyond what this store already discloses.**
  `payload_json` contains real file content (`content`/`previousContent`)
  in full plaintext, the same "gitignored, not encrypted" risk
  `specs/106` already names for the rest of this database — stated here
  again, not assumed forgotten.
- **The atomic claim, not `Map.delete()`, is the real single-consumption
  boundary** once this spec lands — verified adversarially (two
  concurrent approve requests against a real restored action; exactly
  one succeeds).
- Fail-open for the *sweep* (a missing/unopenable store behaves exactly
  as before this spec — no persistence, no restore, no different from
  today) — the one place this spec's own posture matches `specs/106`'s
  general fail-open stance, because failing to restore is the safe
  direction (see the grounding investigation's own finding #7).

## Acceptance criteria

- [x] A real `dockerize` (or `create-ci`/`create-gitignore`/`create-compose`)
      approval survives a real DevOps process kill and restart — the
      Orchestrator's own poll succeeds again with no 404, and approving
      it produces the exact file the original preview showed.
      **Live-verified, 2026-09-22** — see Verification Results below.
- [x] The identical mechanism for `commit-changes`, `write-tests`,
      `edit-file`, and (`specs/109` having landed first) `generate-readme`/
      `document-api` — all four wired identically (persist on preview,
      atomic-claim + drift recheck in `resumeTask()`, restore at
      startup); confirmed by the full suite's per-agent tests, not
      individually live-tested beyond DevOps (see Verification Results
      for which scenarios were live-run vs. unit-proven).
- [x] A restored `run-command`/`run-tests` approval carries the explicit
      "no automatic recheck is possible" risk line — **live-verified**.
      **Corrected from the draft's literal wording**: TTL expiry is
      enforced at `listUnexpiredPendingActions()` (an expired row is
      never returned to the restore loop at all, not restored-then-
      rejected) — so an approval that ages past its TTL *before* a
      restart is simply gone after that restart, identical to today's
      pre-spec/110 silent-loss behavior, rather than restored and then
      refused with a distinct "expired" message on approve. This is the
      more defensible shape (it never shows a human a card for
      something already too stale to trust) and matches B0's own
      written design ("never restored," not "restored expired") — the
      acceptance criterion's "explicit expiry message" framing was
      imprecise, not the implementation. Confirmed by
      `store.test.ts`'s "an expired pending row is not returned as
      unexpired" test, not forced live (would need a real 1-hour wait
      or a clock hack).
- [x] Two concurrent approve requests against a restored action: exactly
      one succeeds — confirmed adversarially both at the store layer
      (`pending-action-store.test.ts`'s "claimPendingAction transitions
      a pending row and returns true exactly once") and live (the
      second `claimPendingAction()` call in the same process returns
      `false`, `resumeTask()` refuses to proceed).
- [x] A deliberately corrupted/unparseable persisted row is skipped at
      startup, never partially trusted or executed without its recheck —
      confirmed by `pending-action-store.test.ts`'s "a row failing
      validate() is discarded... and deleted so it can't linger" test.
- [x] A row left `'claimed'` by a simulated crash is never restored on
      the next startup — confirmed by `pending-action-store.test.ts`'s
      "a claimed row is never restored" test and `store.test.ts`'s own
      B0-level coverage.
- [x] `ORCHESTRAI_PERSIST=0` reproduces exactly today's behavior — no
      persistence, no restore, the original silent-loss-on-restart gap
      unchanged (a supported, documented mode, not a regression) —
      confirmed by `pending-action-store.test.ts`'s "no store available"
      describe block (every function is a safe no-op with the store
      disabled).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.

## Verification plan

- Unit: the store's own `pending_actions` methods (`:memory:`), the
  atomic claim race, TTL expiry, startup restore including the
  corrupted-row and claimed-row skip cases — all four agents.
- Live: a real DevOps write approval, a real process kill mid-`input-
  required`, a real restart, a real approve completing correctly. A
  real `run-command` approval aged past its own 1-hour TTL (or a
  temporarily shortened TTL for the test) refused with an explicit
  expiry message.

## Non-goals

- Orchestrator-side restart recovery.
- A durable audit event for the approval decision itself.
- Any change to `validateActionId()`'s own semantics, `computeContentFingerprint()`,
  or any existing agent's write logic beyond wiring in the claim/restore
  calls named above.
- Restoring DevOps's no-fingerprint degrade paths or EXECUTING skills.
