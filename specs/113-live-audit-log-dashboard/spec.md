---
id: 113-live-audit-log-dashboard
title: "The Dashboard Audit Tab Goes Live, With a Legible Kind Badge (Phase 1: Dashboard Only)"
area: dashboard
change_type: feature
status: implemented
verification: partial
created: 2026-09-22
updated: 2026-09-22
approved_by: Yusuf
approved_on: 2026-09-22
implemented_on: 2026-09-22
amends:
  - 108-durable-audit-trail
  - 021-ag-ui-event-protocol
  - 027-ag-ui-core-adoption
  - 046-browser-conversation-operations-workspace
related:
  - 108-durable-audit-trail
supersedes: []
superseded_by: []
---

# Spec: The Dashboard Audit Tab Goes Live, With a Legible Kind Badge (Phase 1: Dashboard Only)

> Status: **IMPLEMENTED, verification: partial** — see
> `verification.md` for the full record. Requested directly by Yusuf for
> demo value ("it's important the audit log, will need it to be sse or
> something live as it will be usful when i represent in the demo").
> `specs/108`'s own dashboard Audit tab was built poll-on-demand
> deliberately — this spec revisits that decision now that live-demo
> value outweighs the complexity it was built to avoid.
>
> **A second, related gap folded in the same session**: "here in the
> tui will need to get and to know that is a2a that is mcp that is just
> tool call or something, may be that is agui protocol" — checked
> directly, `kind` (`"mcp-tool-call"` | `"a2a-call"` |
> `"command-execution"`) is already a real column in the dashboard's
> Audit tab, but rendered as plain escaped text, not visually
> distinguished the way `outcome`/status already is everywhere else in
> this codebase's own dashboards (a colored badge, `statusColor`-style).
> Folded into this same spec rather than a separate one, since it's the
> identical view/mechanism this spec is already touching.
>
> **Scoped to the dashboard only.** The TUI's own Audit view (where the
> "here in the tui" half of the request points) is explicitly deferred
> to its own future phase — this file's `apps/tui/index.tsx` carries
> 16+ rounds of real terminal-overflow-bug history
> (`specs/012`/`047`/`069`), and every prior spec touching it required
> its own live-terminal verification gate before shipping; bundling
> that risk into this spec would slow down the one half that actually
> matters for the demo (a browser dashboard, which is safe to iterate
> on directly). The kind-badge requirement is recorded as a hard
> requirement for that future TUI phase too — see Non-Goals.

## Current behavior (verified against the real code)

Every audit event already reaches the Orchestrator's process **twice**,
through two genuinely separate paths that have never been connected:

1. **The live path** (`specs/021`): `packages/shared/audit.ts`'s
   `emitAuditStart()`/`emitAuditEvent()` fire a best-effort
   `POST /internal/audit-event` (`pushToOrchestrator()`, line 89) for
   every MCP/A2A call, from every agent's own process. The Orchestrator's
   handler (`apps/orchestrator/index.ts:2816`) runs the pushed payload
   through `mapAuditPushToAgUiEvent()` (`packages/shared/ag-ui-mapping.ts:32`)
   and broadcasts the result as `TOOL_CALL_START`/`TOOL_CALL_RESULT` on
   the existing `GET /events` SSE stream every dashboard/TUI client
   already subscribes to. **This payload does not carry `params` at
   all** — `pushToOrchestrator()`'s own "result" phase body (lines
   164–174) sends only `kind`/`caller`/`target`/`taskId`/`callId`/
   `outcome`/`durationMs`/`resultSummary`.
2. **The durable path** (`specs/108`): the same `emitAuditEvent()` call
   also calls `bufferAuditEvent()` (line 176), which computes
   `whitelistAuditParams(input.params)` (line 187) and, on a 2s/20-event
   batch flush, writes a full row — including the whitelisted params and
   `paramsHash` — directly into the local `audit_events` SQLite table.
   This is the row shape `GET /audit` (and the dashboard's Audit tab)
   returns.

**The gap**: the dashboard's Audit tab (`apps/orchestrator/index.ts`,
`panel-audit` / `loadAuditEvents()`, line 3379) only ever calls
`GET /audit` — on tab-open and on an explicit "Load"/filter click. It
has no live update path at all, even though the exact row it wants is
computed on every single call already (`whitelistAuditParams()`) — that
computed value simply never leaves the buffering function today. The
dashboard's shared `EventSource('/events')` connection (line 3492)
already has one generic `'CUSTOM'` listener (line 3503) that every
`orchestrai.*` extension event currently funnels through, calling
`scheduleRefresh()` unconditionally with no branch on the event's own
`name` field.

## Proposed behavior

### 1. Carry the already-computed whitelisted params on the live push too

`packages/shared/audit.ts`'s `emitAuditEvent()`: compute
`whitelistAuditParams(input.params)` **once**, reuse it for both the
existing `bufferAuditEvent()` call (unchanged) and a new field on the
"result" phase push body, `paramsWhitelisted`. `emitAuditStart()`'s own
push is untouched — a start event has no params to disclose (it's
already `params: {}` implicitly, matching what `bufferAuditEvent()`
never even sees for a start).

`packages/shared/ag-ui-events.ts`'s `AuditPushPayload` interface gains
one optional field: `paramsWhitelisted?: Record<string, unknown>`.

### 2. A new CUSTOM event carries the full audit row live

New `orchestrai.audit-event` CUSTOM event name (fourth alongside
`approval-required`/`approval-resolved`/`agents-update`), with its own
local zod value schema (`AUDIT_EVENT_VALUE_SCHEMA`, mirroring
`AGENTS_UPDATE_VALUE_SCHEMA`'s own shape exactly) validating:

```ts
{
  ts: number
  kind: "mcp-tool-call" | "a2a-call" | "command-execution"
  caller: string
  target: string
  taskId: string
  outcome: "completed" | "failed" | "timeout"
  durationMs: number
  params: Record<string, unknown>  // already whitelisted — booleans/numbers + paramsHash only
}
```

`POST /internal/audit-event`'s handler (`apps/orchestrator/index.ts:2816`)
gains one additional, purely additive branch: when
`payload.phase === "result"` and `payload.paramsWhitelisted` is present,
**also** call `emit()` with this new CUSTOM event, in addition to the
existing `mapAuditPushToAgUiEvent()` → `TOOL_CALL_RESULT` emission
(unchanged — both fire from the same push, serving two different
consumers: the tool-call-activity badge/Detail-view mechanism `specs/021`
already built, and this new audit-row mechanism). A payload with no
`paramsWhitelisted` (an older client, or a "start" phase) emits only the
existing event, exactly as today — this is why the field is optional,
not a breaking change to the push contract.

### 3. The dashboard listens and appends live rows

The existing single `'CUSTOM'` `EventSource` listener
(`apps/orchestrator/index.ts:3503`) branches on the parsed event's own
`name`: `orchestrai.audit-event` calls a new `prependLiveAuditRow(value)`
function; every other CUSTOM name keeps calling `scheduleRefresh()`
exactly as today — a strictly additive branch, not a rewrite of the
existing dispatch.

`prependLiveAuditRow()`:
- If the Audit panel has never been opened this session
  (`document.getElementById('auditRows').dataset.loaded !== 'true'`,
  the exact flag `loadAuditEvents()` already sets), do nothing — no
  wasted DOM work for a panel nobody is looking at, and the next real
  `loadAuditEvents()` call will fetch the row from the durable store
  like any other historical row once the tab is opened.
- If a task-id filter is currently active (`auditTaskFilter`'s value is
  non-empty) and the live event's `taskId` doesn't match it, skip —
  the live view must never contradict what the user explicitly filtered
  for.
- Otherwise, render the identical row markup `loadAuditEvents()` already
  produces per row (extracted into one shared row-rendering function
  used by both the initial fetch and this live path, so the two can
  never visually drift) and prepend it to `#auditRows`, capped at the
  same row count the initial fetch already bounds itself to, so an
  idle-but-open Audit tab can't accumulate unbounded DOM nodes over a
  long demo session.

### 4. A legible `kind` badge, not plain text

`loadAuditEvents()`'s current row template (`apps/orchestrator/index.ts:3404`)
already renders `kind` as its own column — `<td>${escapeHtml(e.kind)}</td>` —
but as unstyled text, indistinguishable at a glance from `caller`/`target`
in the columns beside it. The shared row-rendering function this spec
already extracts (item 3 above) replaces that one cell with a small,
color-coded badge, the same `statusColor`-map pattern this codebase's
own dashboards already use for `outcome`/task status elsewhere:

```js
const KIND_LABEL = {
  'mcp-tool-call':     { text: 'MCP',  color: '#58a6ff' },  // blue — a tool call via the MCP server
  'a2a-call':          { text: 'A2A',  color: '#3fb950' },  // green — a direct agent-to-agent call
  'command-execution': { text: 'EXEC', color: '#d29922' },  // amber — a real command/process ran
}
```

A `kind` value outside this map (defensive — the schema already
constrains it, but a stale client caching an older bundle should never
render a blank cell) falls back to the existing plain-text rendering
unchanged, never a broken or empty cell. This is a pure rendering
change — no new data, no new field; `kind` is already present on every
row from both the historical `GET /audit` fetch and the new live path.

## Scope

In scope: the two-field payload extension (`audit.ts`,
`ag-ui-events.ts`), the new CUSTOM event and its schema, the additive
`POST /internal/audit-event` branch, the dashboard's live-append
listener, the shared row-rendering function, and that function's own
color-coded `kind` badge (replacing the current plain-text cell).

Out of scope, explicitly: the TUI's own Audit view (a genuinely separate
future phase, gated on its own live-terminal pass, per this file's
established risk discipline); any change to `GET /audit`'s own REST
shape or the durable `audit_events` table (both untouched — this spec
adds a live *notification* channel, it does not change what's stored or
how history is queried); any change to `TOOL_CALL_START`/`TOOL_CALL_RESULT`'s
own existing mapping or the tool-call-activity badge/Detail-view
mechanism that already consumes them (both untouched, confirmed by this
spec's own additive-branch design).

## Safety constraints

- **No new data is disclosed.** The new CUSTOM event's `params` field is
  the exact same `whitelistAuditParams()` output already written to the
  durable store and already returned by `GET /audit` — this spec moves
  an existing, already-redacted value onto a second channel, it does
  not compute or expose anything new. Raw params never leave the
  agent's own process on either channel, unchanged.
- **Best-effort, matching every other audit mechanism in this
  codebase.** A dropped push, a validation failure on the new CUSTOM
  event, or a disconnected SSE client all degrade to exactly today's
  behavior (the row is still in the durable store, still reachable via
  a manual `GET /audit`/tab reload) — never a task failure, never a
  blocked call path.
- **The durable record is unaffected.** `bufferAuditEvent()`,
  `flushAuditBuffer()`, and the `audit_events` table schema are
  completely untouched by this spec.

## Acceptance criteria

- [x] A real MCP/A2A call's audit event appears in the dashboard's Audit
      tab within ~1 event cycle of it completing, with no manual reload
      — while the tab is open and no conflicting filter is active.
      Live-verified: a real `git-status` call dispatched directly to a
      scratch DevOps agent produced a real
      `{"type":"CUSTOM","name":"orchestrai.audit-event",...}` frame on a
      genuinely isolated Orchestrator's `GET /events` stream. The
      dashboard-side DOM append (`prependLiveAuditRow()`) was not
      exercised in a real browser — see verification.md.
- [x] The identical event, with the Audit tab closed (never opened this
      session), causes no DOM work; opening the tab afterward still
      shows the event via the normal `GET /audit` fetch (the durable
      write is unaffected either way). Confirmed by code inspection
      (the `dataset.loaded !== 'true'` guard) and indirectly by the
      live pass's own `GET /audit` row — not exercised in a real
      browser DOM.
- [x] An active task-id filter that doesn't match a live event's own
      `taskId` correctly suppresses that live row — the filtered view
      never silently gains an entry that contradicts what was asked for.
      Confirmed by code inspection only (`prependLiveAuditRow()`'s own
      filter check) — not live-browser-tested.
- [x] `TOOL_CALL_START`/`TOOL_CALL_RESULT`'s own existing behavior (the
      live tool-call badge, the Detail view) is unchanged — regression
      check. Confirmed structurally: `POST /internal/audit-event`'s
      original two lines (`mapAuditPushToAgUiEvent()` → `emit()`) are
      byte-unmodified, with the new branch appended strictly after
      them, and all 4 pre-existing `mapAuditPushToAgUiEvent()` tests in
      `ag-ui-mapping.test.ts` still pass unmodified.
- [x] A payload with no `paramsWhitelisted` (simulating an older
      caller) produces the existing `TOOL_CALL_RESULT` event only, no
      new CUSTOM event — proving the extension is genuinely additive,
      not a breaking change to the push contract. Unit-tested directly
      (`mapAuditPushToAuditEventValue()` returns `null` for a
      result-phase payload with no `paramsWhitelisted`, and for a
      start-phase payload).
- [x] Each of the three real `kind` values (`mcp-tool-call`, `a2a-call`,
      `command-execution`) renders as its own distinct, colored badge
      in both the historical (`GET /audit`-fetched) and live-appended
      rows — confirming the shared row-rendering function is genuinely
      shared, not two copies that could drift. The shared function
      (`renderAuditRow()`/`renderKindBadge()`) is used by both paths by
      construction; only `mcp-tool-call` was exercised against a real
      live event — `a2a-call`/`command-execution` are covered by the
      `KIND_LABEL` map's own completeness (all three real `kind` enum
      values present) but not independently live-triggered.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.

## Verification plan

- Unit: `packages/shared/ag-ui-mapping.test.ts`/`ag-ui-events.test.ts`
  (or new focused tests) covering the new schema's validation and the
  `paramsWhitelisted`-present-vs-absent branching.
- Live: a real dispatched task producing a real MCP/A2A call, dashboard
  Audit tab open, confirming a live row appears with no reload; the
  identical scenario with a non-matching task-id filter active,
  confirming suppression; a long-running session check that the row
  count stays bounded rather than growing unboundedly.

## Non-goals

- The TUI's own Audit view going live, or gaining the same `kind`
  badge — a separate future phase, **but that phase must include the
  identical legibility fix this spec gives the dashboard** (the TUI's
  own Audit view already renders `kind` as plain text too, per
  `specs/108`'s own reduced v1 scope — the same "MCP/A2A/EXEC" clarity
  problem exists there today, just not fixed here alongside the
  dashboard for the risk reasons stated above).
- Any change to what's stored durably, or to `GET /audit`'s own query
  shape.
- Live-streaming anything beyond audit events (e.g., a live search/
  filter-as-you-type on the historical view) — out of scope, not
  requested.
