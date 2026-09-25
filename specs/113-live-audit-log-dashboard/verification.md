# Verification: specs/113 — The Dashboard Audit Tab Goes Live, With a Legible Kind Badge

Status at time of writing: `status: implemented`, `verification: partial`.

## Unit tests

Three new/extended test files, all passing:

- `packages/shared/ag-ui-mapping.test.ts` — 4 new tests in a new
  `describe("audit push to live audit-event value mapping", ...)` block:
  a full valid mapping (asserting the exact `value` shape), a
  start-phase push producing `null`, a result-phase push with no
  `paramsWhitelisted` producing `null` (the additive-not-breaking
  acceptance criterion), and an invalid-payloads sweep (bad `kind`,
  bad `outcome`, negative `durationMs`, blank `caller`) all producing
  `null` and never throwing. All 8 tests in the file pass (4
  pre-existing `mapAuditPushToAgUiEvent()` tests + 4 new), confirming
  the pre-existing function's own behavior is byte-unmodified —
  the regression-check acceptance criterion for
  `TOOL_CALL_START`/`TOOL_CALL_RESULT`.
- `packages/shared/ag-ui-events.test.ts` — 2 new tests: a full valid
  `orchestrai.audit-event` CUSTOM event validates against its new zod
  schema; an empty `value: {}` fails with real validation errors. All
  26 tests in the file pass (24 pre-existing + 2 new).
- `packages/shared/audit.test.ts` — 1 new test in the existing
  `describe("emitAuditEvent — the batched store sink", ...)` block:
  mocks `globalThis.fetch`, calls the real `emitAuditEvent()`, and
  asserts the captured push body carries `paramsWhitelisted`
  (`{ retried: true, paramsHash: <string> }`), `resultBytes: 50`, and
  `resultTruncated: false` — and that the raw `repo_path` value
  (`"C:\\real\\path"`) never appears anywhere in the captured JSON,
  the real safety property on this second channel too. All 13 tests
  in the file pass (12 pre-existing + 1 new).

Full suite: `bun test` → **1340 pass, 2 skip, 1 fail** (3164
expectations, 84 files). The one failure
(`analyze-project — reaches a terminal state gracefully with no live
MCP server`) is a pre-existing, environment-caused failure from a real
`bun.exe` process bound to port 3006 (the user's own active development
stack, confirmed present via `tasklist` before this session's work
began) — unrelated to this spec, and consistent with the baseline
already recorded for prior specs closed in this same session. `bun run
typecheck` — 0 errors. `bun run specs:catalog` then `bun run
specs:check` — both pass, 113 specs cataloged.

## Live verification

A genuinely isolated three-process scratch stack was started to avoid
any interference with the user's own real running Orchestrator (the
same isolation discipline established during specs/112's own live pass
in this session, after an earlier attempt in this session's history
discovered the user's real agent stack instead of running isolated):

- `mcp:http` on port 19606 (`ORCHESTRAI_MCP_PORT=19606`)
- A scratch DevOps agent on port 19602, with
  `ORCHESTRAI_ORCHESTRATOR_URL=http://localhost:19600` set explicitly
  (see "Bugs found" below for why this matters)
- A scratch Orchestrator on port 19600, with every *other* agent's URL
  explicitly overridden to `http://localhost:1` (unreachable) —
  confirmed genuinely isolated via its own `GET /healthz` reporting
  `"agents":1`, seeing only the scratch DevOps agent

`GET /events` was subscribed via a backgrounded `curl -s -N`, then a
real `git-status` task was dispatched directly to the scratch DevOps
agent's own `POST /` endpoint (bypassing the Orchestrator's own
routing on purpose, to trigger a real audit push without depending on
`plan-task`/the LLM router — an isolated mechanism test, not an
end-to-end routing test).

**Result — the exact designed live SSE frame arrived**:

```json
{"type":"CUSTOM","name":"orchestrai.audit-event","value":{"ts":1790105117586,"kind":"mcp-tool-call","caller":"devops-agent","target":"git_status","taskId":"t-live-audit2-1790105117","outcome":"completed","durationMs":7,"resultBytes":86,"resultTruncated":false,"params":{"retried":false,"paramsHash":"15cd33c92dad2681"}},"timestamp":1790105117586}
```

Confirmed:

- `params` correctly shows only `retried`/`paramsHash` — never the raw
  `repo_path` that was in the real MCP call's actual arguments — the
  Safety Constraints section's own "no new data is disclosed"
  guarantee holds on this new channel, exactly as on the durable one.
- `GET /audit` on the same scratch Orchestrator returned the identical
  row from the durable store, confirming this spec's additive push
  never interfered with the existing `specs/108` write path.

All three scratch processes and their scratch directories were
cleaned up afterward.

## Bugs found and fixed during live verification

1. **`selectedSkill` is not a client-settable override on `POST /tasks`.**
   The first live-verification attempt dispatched via
   `POST /tasks {"text": "...", "selectedSkill": "git-status"}`,
   expecting a direct `git-status` dispatch. The response showed
   `"assignedAgent":"orchestrator-supervisor","skill":"plan-task"`
   instead — `POST /tasks` does not accept a client-supplied
   `selectedSkill` override the way an internal plan-step dispatch
   does; this is a real, pre-existing API-contract detail, not a
   defect introduced by this spec. Worked around by dispatching
   directly to the scratch DevOps agent's own `POST /` endpoint
   instead, which is the architecturally correct way to isolate this
   kind of mechanism test from routing behavior.
2. **The scratch DevOps agent's `ORCHESTRAI_ORCHESTRATOR_URL` must be
   set explicitly, or its audit push silently targets the wrong
   process.** The first attempt with this variable unset produced a
   real, successfully completed task (confirmed via the agent's own
   console log showing the audit JSON line) but zero
   `orchestrai.audit-event` frames on the scratch Orchestrator's
   stream — `pushToOrchestrator()`'s own default target is
   `http://localhost:3000`, which silently pushed toward the user's
   own real Orchestrator (if running) instead of the isolated scratch
   instance on port 19600. Not a defect in this spec's own code —
   `pushToOrchestrator()`'s default has always worked this way — but a
   real methodology gap in the first live-verification attempt,
   corrected by restarting the scratch DevOps agent with the URL set
   explicitly.

## What remains unverified (why `verification: partial`, not `verified`)

- **The dashboard's own client-side JS was never exercised in a real
  browser.** `prependLiveAuditRow()`'s guard logic (the
  `dataset.loaded !== 'true'` early-return for a never-opened panel,
  the task-id filter suppression, the row-count cap) and the
  `renderKindBadge()`/`KIND_LABEL` rendering were verified by direct
  code reading and by the unit tests covering the data layer that
  feeds them, but no real browser tab was opened against a real
  running dashboard to watch a live row actually append, a filter
  actually suppress a mismatched row, or all three kind badges
  actually render with their distinct colors. This is the same class
  of gap several prior dashboard-facing specs in this codebase (046,
  108's own dashboard half) have carried at their own initial
  `verification: partial`/`pending` state — a real-browser pass
  remains open, consistent with that precedent.
- Only `kind: "mcp-tool-call"` was exercised by a real live event (the
  only kind a `git_status` MCP call produces). `a2a-call` and
  `command-execution` are covered by `KIND_LABEL`'s own completeness
  (all three real enum values present, unit-schema-validated) but
  neither was independently triggered live.
- A long-running-session check that the live row count stays bounded
  (the acceptance criterion's own capped-DOM-nodes concern) was not
  performed — the live pass dispatched exactly one event, not enough
  to exercise the cap.

## Non-goals confirmed untouched

- `GET /audit`'s own REST shape and the durable `audit_events` table
  schema: zero diff, confirmed by `git diff --stat` showing no changes
  to `packages/shared/store.ts`.
- The TUI's own Audit view: zero diff to `apps/tui/index.tsx` from
  this spec's own work (its pre-existing plain-text `kind` rendering
  is explicitly recorded as a requirement for its own future phase,
  not touched here).

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/113-live-audit-log-dashboard/spec.md` (implemented, **partial**
verification, 2026-09-22; amends `108`/`021`/`027`/`046`) closes the gap
`specs/108`'s own dashboard Audit tab deliberately left open —
poll-on-demand only, no live update path — now that live-demo value
outweighs the complexity that decision existed to avoid. Yusuf, directly,
for the hackathon's final-stage demo: *"it's important the audit log,
will need it to be sse or something live."* A second, related gap was
folded into the same spec from the same message: *"here in the tui will
need to get and to know that is a2a that is mcp that is just tool call
or something"* — `kind` (`mcp-tool-call`/`a2a-call`/`command-execution`)
was already a real column in the Audit tab, just rendered as unstyled
plain text, not visually distinguished the way `outcome`/status already
is everywhere else in this codebase's dashboards.

**Every audit event already reached the Orchestrator's process twice,
through two paths that had never been connected**: the live push
(`specs/021`'s `POST /internal/audit-event` → `TOOL_CALL_START`/
`TOOL_CALL_RESULT` on the existing `GET /events` SSE stream) never
carried `params` at all, while the durable batched write
(`specs/108`'s `bufferAuditEvent()`) computes
`whitelistAuditParams(input.params)` and writes the full row — but only
the SQLite table ever sees that computed value. Fixed by computing
`whitelistAuditParams()` **once** in `emitAuditEvent()` and reusing it
for both the unchanged durable write and a new field on the live push,
`paramsWhitelisted` (plus `resultBytes`/`resultTruncated`, added
alongside it so a live row can render the identical "resultBytes=N
(truncated)" summary a historical row already shows). A new
`orchestrai.audit-event` CUSTOM event (a fourth alongside
`approval-required`/`approval-resolved`/`agents-update`), with its own
local zod schema, carries the full row. `POST /internal/audit-event`'s
handler gains one purely additive branch — the pre-existing
`mapAuditPushToAgUiEvent()` → `emit()` lines are byte-unmodified, with
the new `mapAuditPushToAuditEventValue()` → `emit()` call appended
strictly after them — so a payload with no `paramsWhitelisted` (an
older caller, or a "start" phase push) produces only the existing
`TOOL_CALL_*` event, exactly as before this spec.

The dashboard's single `'CUSTOM'` `EventSource` listener now branches on
the event's own `name`: `orchestrai.audit-event` calls a new
`prependLiveAuditRow()`, every other CUSTOM name keeps calling
`scheduleRefresh()` unchanged. `prependLiveAuditRow()` does nothing if
the Audit panel was never opened this session (no wasted DOM work for a
panel nobody is looking at — the row is still in the durable store,
reachable via the next real `GET /audit` fetch), skips a row that
doesn't match an active task-id filter, and otherwise prepends a row
capped at the same row limit the initial fetch already bounds itself
to. `loadAuditEvents()`'s own per-row template and the new live path
were unified into one shared `renderAuditRow()` function, which also
gained the `kind` badge (`KIND_LABEL`-mapped: MCP/blue,
A2A/green, EXEC/amber) — the same `statusColor`-map pattern this
codebase's dashboards already use for `outcome` elsewhere, replacing the
previous unstyled plain-text `kind` cell. `GET /audit`'s own REST shape
and the durable `audit_events` table are completely untouched.

**Scoped to the dashboard only, deliberately.** The TUI's own Audit
view (`specs/108`'s own reduced v1 scope, still plain-text `kind`) is
explicitly deferred to its own future phase — `apps/tui/index.tsx`
carries 16+ rounds of real terminal-overflow-bug history
(`specs/012`/`047`/`069`), and bundling that risk into this spec would
have slowed down the one half that actually matters for the demo (a
browser dashboard, safe to iterate on directly). The kind-badge fix is
recorded as a **hard requirement** for that future TUI phase too, not
silently dropped.

**Two real, previously-unknown issues found and worked around while
live-verifying, not assumed away.** (1) `POST /tasks` does not accept a
client-supplied `selectedSkill` override the way an internal plan-step
dispatch does — a first live attempt sending
`{"text": "...", "selectedSkill": "git-status"}` still routed to
`plan-task`; worked around by dispatching directly to a scratch DevOps
agent's own `POST /` endpoint instead, the architecturally correct way
to isolate this kind of mechanism test from routing behavior. (2) a
scratch agent's audit push silently targets `http://localhost:3000` by
default (`pushToOrchestrator()`'s own existing default) unless
`ORCHESTRAI_ORCHESTRATOR_URL` is set explicitly — a first attempt with
it unset produced a real, successfully completed task but zero live
frames on the isolated scratch Orchestrator's own stream, because the
push was silently targeting the user's own real Orchestrator (if
running) instead. Neither is a defect in this spec's own code; both are
real methodology footguns worth remembering for the next isolated
live-verification pass in this codebase.

**Live-verified**, against a genuinely isolated three-process scratch
stack (mirroring `specs/112`'s own isolation discipline — every other
agent's URL explicitly pointed at an unreachable address so the scratch
Orchestrator's `/healthz` confirmed `"agents":1`, seeing only the
scratch DevOps agent): a real `git-status` call produced the exact
designed live frame,
`{"type":"CUSTOM","name":"orchestrai.audit-event","value":{...,"params":
{"retried":false,"paramsHash":"15cd33c92dad2681"}},...}` — confirming
`params` correctly carries only the whitelisted keys, never the real
`repo_path` argument, on this new channel exactly as on the durable
one; the same scratch Orchestrator's own `GET /audit` independently
returned the identical row, confirming the new push never interfered
with `specs/108`'s existing write path. **What stays unverified,
honestly, not glossed over**: the dashboard's own client-side JS
(`prependLiveAuditRow()`'s guard logic, the task-id filter suppression,
the row-count cap, all three kind badges' actual rendered colors) was
never exercised in a real browser tab — confirmed by direct code
reading and by the unit tests covering the data layer that feeds it,
the same `verification: partial` gap several prior dashboard-facing
specs in this codebase have carried at this stage. 1340 tests pass (net
+7 over the pre-113 baseline — 4 new `ag-ui-mapping.test.ts` tests, 2
new `ag-ui-events.test.ts` tests, 1 new `audit.test.ts` test; the one
suite failure is the same pre-existing, environment-caused
`analyze-project` test tied to a real `bun.exe` on port 3006 from the
user's own active stack, unrelated to this spec), typecheck clean,
`specs:check` passed for 113 specs. See `specs/113`'s own
`verification.md` for the complete transcript.

See specs/115-tui-navigation-redraw-and-answer-clarity/verification.md for the relocated narrative covering this checkpoint.
