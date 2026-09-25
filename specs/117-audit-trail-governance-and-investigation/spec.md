---
id: 117-audit-trail-governance-and-investigation
title: "Audit Trail: Record Human Decisions, and Make the Log Investigable"
area: orchestrator
change_type: enhancement
status: draft
verification: pending
created: 2026-09-23
updated: 2026-09-23
approved_by: null
approved_on: null
implemented_on: null
amends:
  - 108-durable-audit-trail
  - 113-live-audit-log-dashboard
  - 115-tui-navigation-redraw-and-answer-clarity
supersedes: []
superseded_by: []
related:
  - 089-plan-step-skip-continue
  - 006-runtime-stabilization
---

# Spec: Audit Trail: Record Human Decisions, and Make the Log Investigable

> Status: **DRAFT — awaiting Yusuf's approval. No code written.**
> Raised directly: *"how could we enhance more the audit tab? like in
> best practice?"* This spec answers that against the real code, not a
> generic checklist. Every gap below was confirmed by reading the
> current implementation, cited inline.

## Current behavior (verified against code, 2026-09-23)

**What is recorded.** `packages/shared/audit.ts:49` — `kind` is a closed
set of exactly three machine-call types: `mcp-tool-call`, `a2a-call`,
`command-execution`. Columns (`packages/shared/store.ts:573`): `ts`,
`kind`, `caller`, `target`, `task_id`, `call_id`, `outcome`,
`duration_ms`, `result_bytes`, `result_truncated`, `params_json`
(whitelisted, `specs/108`). Indexed on `ts` and `task_id` only.

**What is NOT recorded — the headline gap.** The Orchestrator's
`POST /tasks/:id/approve`, `/reject`, and `/skip` (`specs/006`/`089`)
emit **nothing** into this trail — `apps/orchestrator/index.ts`'s only
`emitAuditEvent` call sites are the supervisor's own `a2a-call`
dispatches (~line 1387-1400). So the single most governance-relevant
event in this system — a human authorizing (or refusing) a write — is
absent from its own audit log. Today you can see that `write_project_file`
ran; you cannot see that anyone approved it, which `actionId` it was,
or that a different one was rejected a minute earlier.

**How it can be read.** `GET /audit?task=<id>` (`index.ts:1656`) —
one optional filter (task id), a fixed `AUDIT_QUERY_LIMIT = 200`, newest
first, no pagination: event 201 is unreachable from any UI. The
dashboard tab (`specs/108`/`113`) offers that one filter plus live
prepend; the TUI view (`specs/115`) has no filter at all.

## Proposed behavior

Ranked by value, cheapest-to-highest-risk. Each item is independently
shippable; the approval-decision recording (A) is the one that matters
most.

### A. Record human approval decisions (the governance gap)

- `kind` gains one new closed value: **`approval-decision`**.
- `approve` / `reject` / `skip` handlers on the **Orchestrator** emit one
  event each, at their own existing success point (the same point
  `rejectedByOrchestrator`/`skippedByOrchestrator` are already
  populated — never before the agent confirmed): `caller: "human"`,
  `target: <skill>`, `task_id`, `call_id: <actionId>`,
  `outcome: "approved" | "rejected" | "skipped"`.
- A refused attempt (HTTP 400 missing `actionId` / 409 stale) is
  recorded too, `outcome: "refused"` — a stale-approval attempt is
  exactly what an auditor wants to see.
- **Params stay whitelisted by the same unmodified rule** (`specs/108`):
  no approval content, no file text, no command argv. `actionId` is an
  opaque random id already shown in the UI, not a secret.
- Scope: Orchestrator endpoints only. An agent's own direct
  `/approve` (bypassing the Orchestrator) is out of scope for this spec
  — noted as a known gap, not silently covered.

### B. Server-side filters on `GET /audit`

Additive query params, all optional, all combinable, each a bound
parameter (never string-interpolated SQL):
`kind`, `outcome`, `caller`, `since` / `until` (epoch ms), plus the
existing `task`. One new index, `ix_audit_kind_ts(kind, ts)`, added via
the existing `CREATE INDEX IF NOT EXISTS` migration path (schema
version bump; no data rewrite). A request with no params returns
exactly today's response — byte-identical.

### C. Pagination instead of a silent 200-row wall

`GET /audit` gains `before=<id>` (keyset, by the existing
`AUTOINCREMENT` id — stable under concurrent inserts, unlike offset),
and the response gains `nextBefore` when more rows exist. Dashboard
gets a "Load older" button; TUI gets `o` to load older.

### D. Failures surface first

- A **"failures only"** toggle (dashboard checkbox, TUI `f`) mapping to
  `outcome` ∈ {error, timeout, rejected, refused} via filter B.
- A one-line **summary strip** above the table for the current filter:
  total, failures, approvals/rejections, p95 duration — computed from
  the rows already fetched, no new endpoint.

### E. Trace view: one task's calls as a timeline

Clicking/selecting a task id (dashboard) or pressing `Enter` on a row
(TUI) re-queries `?task=<id>` and renders that task's events in
chronological order with relative offsets (`+0.0s`, `+1.2s`) — the
answer to "what exactly happened in this run, in order, including who
approved it." Uses filter B only; no new data.

### F. Export (dashboard only)

"Export JSON" downloads exactly the currently filtered rows as they
came from `GET /audit` — client-side `Blob`, no new endpoint, no extra
data exposure beyond what the tab already displays.

## Explicitly considered and deferred

- **Tamper-evidence (hash chain across rows).** Real best practice for
  audit logs, but this is a local, single-user SQLite file the same
  user can delete outright — a hash chain proves little here. Deferred
  until there's a multi-user or shared-store deployment where it would
  actually mean something.
- **Full-text search over params.** Params are deliberately stripped to
  booleans/numbers + a hash (`specs/108`); there's nothing to search,
  by design.
- **Agent-side direct-approve recording** (see A's scope note).
- **Retention changes** — `specs/108`'s 7 days / 50,000 rows is
  unchanged.

## Safety constraints

- Approval-decision events are **informational**, exactly like
  `specs/021`'s approval CUSTOM events: nothing ever reads the audit
  trail to *authorize* anything. The approval gate is untouched.
- Emitted strictly **after** the existing success point, so an event
  can never claim an approval that didn't happen.
- `whitelistAuditParams()` unchanged; no new column carries free text.
- Every new query param is validated (enum for `kind`/`outcome`,
  integer for `since`/`until`/`before`); invalid → HTTP 400, never
  passed through.
- The live SSE path (`orchestrai.audit-event`, `specs/113`) carries the
  new kind automatically; its zod schema's `kind` enum is extended in
  the same change so validation doesn't reject it.

## Acceptance criteria

- [ ] Approving, rejecting, and skipping via the Orchestrator each
      write exactly one `approval-decision` row with the right
      `outcome`, `task_id`, and `call_id = actionId`; a stale/missing
      `actionId` writes one `refused` row; none contain approval
      content.
- [ ] That row also arrives live on `/events` and renders with its own
      distinct badge (dashboard + TUI) — a fourth color alongside
      MCP/A2A/EXEC.
- [ ] `GET /audit` with each new filter returns only matching rows;
      with no params, output is byte-identical to today; invalid values
      → 400.
- [ ] Keyset pagination reaches row 201+ and never duplicates or skips
      a row under concurrent inserts.
- [ ] Failures-only toggle and summary strip work in both clients.
- [ ] Trace view shows one task's events chronologically, including its
      approval decision.
- [ ] Dashboard export downloads exactly the displayed rows.
- [ ] `bun test`, `bun run typecheck`, `specs:check` clean; TUI
      rendering smoke-checked at 80×24 via the established real-PTY
      technique, reusing `computeShellChatScrollHeight()` verbatim (no
      new height math — `specs/115`'s box-height lesson).

## Verification plan

- Unit: store query builder per filter + combinations; keyset
  pagination with interleaved inserts; approve/reject/skip/refused
  emission via the existing test seams; zod schema accepts the new kind.
- Live, isolated scratch stack (the `specs/113` isolation discipline,
  including `ORCHESTRAI_ORCHESTRATOR_URL` set explicitly): a real
  `dockerize` approval → approve, a second → reject, a stale `actionId`
  → refused; confirm four rows via `GET /audit?kind=approval-decision`
  and the live frames on `/events`.
- TUI: real-PTY capture of the new badge, `f` filter state, and trace
  view via state injection, reverted and `git diff`-confirmed.
- Known standing gap, stated up front: real keypress/click interaction
  (TUI `f`/`o`/`Enter`, dashboard buttons) needs Yusuf's terminal and
  browser, as with every prior TUI/dashboard checkpoint.

## Non-goals

- No change to what the approval gate enforces, or how.
- No new persistence table; `audit_events` only gains a kind value and
  an index.
- No change to `specs/108` retention or `whitelistAuditParams()`.
- No tamper-evidence, no search, no agent-side approval recording (see
  "deferred" above).
