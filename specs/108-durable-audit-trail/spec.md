---
id: 108-durable-audit-trail
title: "A Durable, Queryable Audit Trail"
area: architecture
change_type: feature
status: implemented
verification: partial
created: 2026-09-22
updated: 2026-09-22
approved_by: Yusuf
approved_on: 2026-09-22
implemented_on: 2026-09-22
amends:
  - 005-mcp-agent-integration
  - 021-ag-ui-event-protocol
  - 106-persistence-store-and-result-cache
related:
  - 022-ag-ui-demo-stabilization
  - 080-run-command-approved-execution
  - 107-task-and-conversation-history
supersedes: []
superseded_by: []
---

# Spec: A Durable, Queryable Audit Trail

> Status: **DRAFT — awaiting review.** Fourth and last of four specs from
> one approved plan (105/106/107/108). Depends on `specs/106`. Sequenced
> last on purpose: it is the highest-volume, lowest-value-per-row, and
> highest-leak-risk table, and can be dropped or deferred without
> affecting the other three.
>
> **Revised, 2026-09-22, before implementation began.** The original
> draft's only read surface was a bare `GET /audit?task=…` JSON
> endpoint — no dashboard or TUI view. Yusuf, after being told plainly
> that meant no way to actually *see* the trail without curl/a script:
> *"do both"* — a dashboard Audit tab and a TUI Audit view. B7 below is
> the addition; B6 (the table, the sinks, the whitelist, the endpoint)
> is unchanged from the original draft. This is a material scope
> change to an already-approved spec, so it returns here to `draft` for
> re-approval before any implementation begins, per this repo's own
> working procedure. Re-approved the same day: *"ok approved"*.
>
> **Implemented, 2026-09-22, verification: partial.** B6 and the
> dashboard's own Audit tab are fully live-verified against a real
> running stack, including a genuine process kill-and-restart proving
> the trail survives. The TUI's own Audit view got a real, decisive
> live smoke pass — Yusuf pointed out this sandbox's own Bash tool
> genuinely allocates a real PTY for stdout, the same technique
> `specs/069`-`073` already used (temporarily forcing the initial mode
> in source, capturing a real render, reverting). That capture showed
> the Audit view's real idle → loading → result lifecycle rendering
> cleanly at 80×24 with no overflow across all three states, and caught
> a second real bug beyond the header label: a failed fetch rendered
> the exact same "No audit events recorded" text a genuine empty
> success shows, silently misleading about what actually happened —
> fixed to a distinct, honest message. **What remains genuinely
> unconfirmed, precisely**: this technique forces the *initial* render
> of a given mode; it does not exercise genuine keyboard-driven
> navigation *into* that mode (pressing `4`/Tab) or the `r` reload key
> actually being received and processed by OpenTUI's own input
> handling — piping a keystroke into stdin was tried and confirmed
> *not* to work (no real PTY on the stdin side). That gap — real
> interactive keystrokes reaching this view — is what keeps
> `verification` at `partial`, not the view's own rendering correctness,
> which is now genuinely demonstrated. See `verification.md` for the
> complete record.

## Purpose

Every MCP tool call and A2A call gets a durable, queryable record — the
trail this system has always *emitted* but never *kept*.

## Current behavior

`packages/shared/audit.ts` has two sinks, neither durable:

- `emitAuditEvent()` does `console.log(JSON.stringify({ audit: event }))`.
  **The file's own comments call this "the durable record". It is
  stdout.** It reaches disk only incidentally, when the supervisor is
  redirecting child output into `.orchestrai/supervisor.log`
  (`specs/066`) — a file truncated fresh on every run.
- `pushToOrchestrator()` fire-and-forgets an HTTP POST to
  `/internal/audit-event`, which the Orchestrator turns into live SSE
  (`specs/021`) and does not store.

`specs/005` called persistent audit storage "target state, not
required"; `specs/022` excluded "durable event/audit storage or event
replay after process restart". Both are now superseded by `106`'s
recorded reversal.

## Proposed behavior

### B6 — `audit_events`

```sql
CREATE TABLE IF NOT EXISTS audit_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  kind             TEXT, caller TEXT, target TEXT,
  task_id          TEXT, call_id TEXT,
  outcome          TEXT, duration_ms INTEGER,
  result_bytes     INTEGER, result_truncated INTEGER,
  params_json      TEXT               -- whitelisted keys only, see below
);
CREATE INDEX IF NOT EXISTS ix_audit_ts   ON audit_events(ts);
CREATE INDEX IF NOT EXISTS ix_audit_task ON audit_events(task_id);
```

A third sink is added to `emitAuditEvent()` beside the existing two —
never replacing them: `console.log` stays (it is what the supervisor's
log redirection and every existing test observe), the Orchestrator push
stays (it feeds live SSE). The comment calling `console.log` "the durable
record" is corrected.

**Batched writes.** This is the one high-volume table — a row per call,
not per task. Each process buffers events and flushes in one
transaction on a short interval or at a size threshold, and on shutdown.
A lost buffer on a hard crash is accepted: the console line already
exists, and audit is a record, not a control.

**`params_json` stores a whitelist, never the raw object.** This is the
same carve-out as `107`'s `scan-secrets` decision, applied to the other
leak vector: a `scan-secrets` call's params carry real file paths, and a
`run_command` event carries the full command line. Stored keys are an
explicit per-`kind` allowlist of non-sensitive fields (tool/target name,
sizes, flags, a stable hash of the full params) — anything not listed is
dropped.

A read endpoint on the Orchestrator (`GET /audit?task=…`) exposes the
trail to the dashboard and TUI. Read-only.

### Retention (added to `106`'s sweep)

7 days or 50,000 rows, whichever binds first.

### B7 — dashboard and TUI audit views

Two read-only views onto `GET /audit`, added at Yusuf's own explicit
request once the bare-endpoint plan was stated plainly (*"do both"*).
Neither writes anything — both are pure consumers of the endpoint B6
already defines; this section changes no server-side behavior.

**Dashboard — a new Audit tab.** Follows the existing Chat | Tasks |
Agents workspace's own established pattern (`specs/046`): one more tab,
rendered from the exact same inline-`<script>`-template-string
convention the other three already use (no bundler, no new dependency —
`specs/033`'s/`specs/035`'s own precedent for why this codebase's
dashboards can't share rendering code with the TUI's own TypeScript).
Shows the most recent events (server-side limit, newest first) as a
table — timestamp, kind, caller, target, outcome, duration,
`result_bytes` — plus a task-id filter input that re-queries
`GET /audit?task=…`, mirroring the Tasks tab's own existing filter UX.
`params_json` (already whitelisted server-side, per B6) renders as a
compact inline summary, never a raw dump users might mistake for the
full params. Verified the same way `specs/033`'s/`specs/040`'s own
dashboard work already was: `app.fetch()` in-process, confirming the
generated `/dashboard` HTML contains the new tab and its rendering
function, without needing a bound port — a live-browser click-through
remains the one open item every dashboard checkpoint in this codebase
already carries honestly, not a new gap this spec introduces.

**TUI — a new Audit view.** One more full-screen view alongside the
existing Chat (`k`)/Help (`?`)/Detail-overlay pattern
(`apps/tui/index.tsx`), reachable by a keybinding chosen at
implementation time by inspecting the file's real current keymap first
(not guessed here, to avoid a real collision) — this file's own
documented history (16+ rounds under `specs/012`, more under `specs/047`/
`specs/069`) is exactly why: a bound taken twice, or a naive extra row,
has repeatedly corrupted this renderer's fixed-cell layout in ways only
a real terminal surfaces. Shows the same event list as the dashboard's
own table, in a scrollbox sized against the shell's existing
`reservedRows` budget (`specs/069`'s own established shape), with the
identical task-id filter behavior. Per this codebase's own standing,
honestly-repeated limitation, this view's real-terminal rendering
**cannot be verified from this implementation environment** (no raw-mode
stdin) — it will ship with `verification: partial` for this reason
alone, the same as every other TUI checkpoint here, and needs a live
pass in Yusuf's own terminal before it can move to `verified`.

## Scope

In scope: the table, the batched third sink, the whitelist, the read
endpoint, retention (B6); a dashboard Audit tab and a TUI Audit view,
both read-only consumers of that same endpoint (B7).

Out of scope: event *replay* into a live SSE client joining mid-run
(`specs/022`'s original framing — a different feature); any change to
the AG-UI mapping; approval events carrying any content beyond what they
carry today; live-updating either new view over SSE (both are
poll-on-demand/poll-on-filter-change, matching the Tasks tab's own
existing refresh behavior — a live-streaming audit view is a materially
different, larger feature not attempted here).

## Safety constraints

- Fail-open, as `106`; a store failure never affects a call's outcome.
- The existing sinks are untouched, so every test that reads audit
  output from stdout keeps passing.
- `params_json` whitelist enforced in code, per `kind`, with a test that
  a `run_command` event's stored params contain **no** `argv` and a
  `scan-secrets` event's contain **no** path.
- Batching never spans an `await` inside the transaction.

## Acceptance criteria

- [x] Every MCP/A2A call produces a row; `GET /audit?task=<id>` returns
      the correlated events after a restart.
- [x] A `run_command` row's `params_json` contains no command line; a
      `scan-secrets` row's contains no file path. (Live-proven for
      `run_command` directly; `scan-secrets` is never an MCP call at all
      — Security is direct-fs — so its own `a2a-call` params were
      already the safe `{childTaskId, target, textBytes}` shape before
      this spec, unit-tested via the general whitelist function instead.)
- [x] Console and Orchestrator-push sinks are byte-identical to before;
      every existing audit test passes unmodified.
- [x] Batching: N events → far fewer transactions, measured (a
      dedicated test proves the size threshold auto-flushes before an
      explicit call).
- [x] Retention caps hold.
- [x] The dashboard's generated `/dashboard` HTML contains a real Audit
      tab that renders real `GET /audit` data, confirmed in-process via
      `app.fetch()`, including the task-id filter re-querying correctly.
- [x] The TUI gains a real Audit view reachable by its own keybinding
      (unit-tested pure mode-cycling). A real PTY capture — this
      sandbox's own Bash tool genuinely allocates one — forced the view
      open via the `specs/069`-`073` state-injection technique and
      confirmed its real idle → loading → result lifecycle renders
      cleanly at 80×24 across all three states, catching and fixing two
      real bugs: the new header label's own column bounds, and a failed
      fetch silently rendering the same text a genuine empty success
      shows. **Scope reduction, stated honestly, not silently dropped**:
      the TUI view's v1 has no task-id filter (the dashboard's own
      text-entry filter needs a new input-mode this pass didn't add to
      this already-fragile file) — reload-only for now. **What remains
      unconfirmed, precisely**: genuine keyboard-driven navigation into
      this view (pressing `4`/Tab) and the `r` key actually reaching
      OpenTUI's own input handling — the state-injection technique
      forces a mode's *initial* render, it does not exercise real
      keypresses; piping one into stdin was tried and confirmed not to
      work. This is the one item keeping this spec's own `verification`
      at `partial`.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.

## Verification plan

- Unit: sink, whitelist per `kind`, batching, retention — `:memory:`;
  the dashboard's Audit tab HTML/rendering function present in the
  generated output; the TUI's own pure Audit-view state/layout helpers.
- Live: run a real task, restart the Orchestrator, query its audit
  trail; run a real `run-command`, inspect the row and confirm no argv;
  a real browser click-through of the dashboard's Audit tab; a real
  terminal pass of the TUI's Audit view (Yusuf's own machine, matching
  every other TUI checkpoint's standing verification gap).

## Non-goals

- Event replay to SSE clients; live-updating either new view over SSE.
- Storing approval preview content or task results here — those are
  `107`'s tables.
- Any write/mutation capability on either new view — both are strictly
  read-only, matching the endpoint they consume.
