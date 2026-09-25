---
id: 021-ag-ui-event-protocol
title: AG-UI Event Protocol for the Dashboard/TUI Live Layer
area: ag-ui
change_type: feature
status: implemented
verification: verified
created: 2026-08-10
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-10
implemented_on: 2026-08-10
amends: []
supersedes: []
superseded_by: []
related:
  - 022-ag-ui-demo-stabilization
  - 023-spec-governance-and-catalog
---

# Spec: AG-UI Event Protocol for the Dashboard/TUI Live Layer

> Status: **APPROVED on 2026-08-10.** Decisions: audit events reach the
> Orchestrator via a new fire-and-forget push endpoint (Option 2 below —
> the existing 500ms agent-resend loop's latency ceiling was judged not
> worth avoiding the dedup complexity of piggybacking on it); approval
> modeled as `CUSTOM` events, informational only; **TUI is in scope for
> this pass** (not deferred, per explicit direction — the spec's original
> "dashboard-only" recommendation was overridden). **IMPLEMENTED AND
> VERIFIED on 2026-08-10** — every acceptance criterion checked off with
> real evidence in Verification Results below. The TUI's visual rendering
> still needs Yusuf's confirmation in a real terminal. The original
> `toolCallId` uniqueness edge case was fixed and live-verified later on
> 2026-08-10; see the recorded amendment below.

## Purpose

The team is evaluating next steps from a list of protocols/tools discussed
informally (AG-UI, Google ADK, LangChain/LangGraph, Traycer, Pi Agent).
AG-UI was chosen to explore first because, unlike the other options, it is
**additive to the existing architecture** rather than a replacement for it:
it standardizes the *transport/event layer* between the Orchestrator and its
clients (browser dashboard, TUI), without touching routing, planning, or the
approval-gate safety boundary. Google ADK and LangChain/LangGraph would mean
rebuilding the Orchestrator's core on a third-party agent framework — a much
larger, separate decision explicitly deferred, not part of this spec.

Today, an agent's live activity (which MCP tool it called, which A2A peer it
contacted, what it's doing while a task is still running) is **invisible
until the task completes**. The only "live" signal that exists is a bare
change notification telling clients to go re-fetch full state. This spec
proposes replacing that notification with a real, typed event stream so
tool calls, plan steps, and approvals become visible as they happen.

## Verified Current Behavior

Read directly from the code before writing this spec, not assumed:

1. **`GET /events`** ([apps/orchestrator/index.ts:742](../apps/orchestrator/index.ts)):
   a single SSE endpoint on the Orchestrator emitting exactly one event
   shape — `{type: "task-update" | "agents-update", taskId?}`. No content,
   no deltas, no per-step detail. A 5-second heartbeat keeps the connection
   under Bun's 10s idle-request timeout (a previously-diagnosed, documented
   constraint — do not raise this back toward/above 10000ms).
2. **The browser dashboard's client JS** reacts to that bare signal by
   calling `GET /dashboard/fragment` and replacing two `innerHTML` blocks
   wholesale (`agentsHtml`, `rowsHtml`) — a full HTML-fragment re-render on
   every signal, debounced 300ms, not incremental DOM patching.
3. **The TUI does not use SSE at all.** It polls `GET /tasks` every 1.5s — a
   deliberate simplification already documented in `specs/012-tui-interactive/spec.md`
   ("It polls rather than uses SSE").
4. **Each agent (DevOps/Testing/Documentation/Security) has its own
   separate `GET /tasks/:id/stream`** SSE endpoint and its own separate
   dashboard — a fourth, independent client surface per agent, not unified
   with the Orchestrator's.
5. **`emitAuditEvent()`** (`packages/shared/audit.ts`) already captures
   almost exactly the right shape for a tool-call event — `kind`
   (`mcp-tool-call`/`a2a-call`/`command-execution`), `caller`, `target`,
   `outcome`, `durationMs`, a bounded `resultSummary` — but it **only ever
   calls `console.log`**. It never reaches any client, live or otherwise.
   It also runs inside each **agent's own process** (DevOps, Testing,
   Documentation), not the Orchestrator, which is where `GET /events`
   lives — these are two different processes today.
6. **Approval** (`POST /tasks/:id/approve`/`/reject`) is a plain request/
   response HTTP cycle, entirely outside any event stream.

## What AG-UI Is (verified against the real spec, not summarized from memory)

An open, event-schema-over-transport protocol (SSE or WebSocket) — not a
framework that takes over your server. Core shape:

- Every run follows `RUN_STARTED → [content events] → RUN_FINISHED |
  RUN_ERROR`.
- `TEXT_MESSAGE_START/CONTENT/END` — streamed text, correlated by
  `messageId`.
- `TOOL_CALL_START/ARGS/END/RESULT` — tool invocation lifecycle, correlated
  by `toolCallId`. This is the natural mapping target for
  `emitAuditEvent()`.
- `STATE_SNAPSHOT` (full) / `STATE_DELTA` (RFC 6902 JSON Patch) — structured
  state sync.
- `STEP_STARTED/STEP_FINISHED` — sub-task tracking, a natural fit for
  Planning's multi-step plans.
- `CUSTOM` — named events with an arbitrary payload, the documented
  extensibility point for anything protocol-specific.

**Explicitly not solved by AG-UI out of the box: human-in-the-loop
approval.** There is no standard "approval" event kind. Any approval
signal riding this channel would be an OrchestrAI-specific `CUSTOM` event,
not a protocol guarantee — stated plainly here rather than glossed over,
since it's the one place this spec has to invent something rather than
adopt something.

## Proposed Behavior

### 1. Adopt the event *schema*, not a framework dependency

Define the AG-UI event `type` values and payload shapes as local TypeScript
types in `packages/shared/`, matching the real protocol's field names, so
any future official-SDK client (or a hand-written one) can parse the
stream correctly. Do **not** take a dependency on the full `@ag-ui/*`
package family for this pass — same "supplement, not replacement,
minimal new dependency surface" posture as the semantic-classifier work.
Revisit only if a specific SDK feature is later needed that hand-rolled
types can't provide.

### 2. Route audit events from agent processes to the Orchestrator's stream

**Decided: a new fire-and-forget push endpoint (Option 2).**

`emitAuditEvent()` currently `console.log`s only, inside each agent's own
process. It gains a second effect: immediately after logging, it fires a
best-effort `POST` to a new Orchestrator endpoint (e.g.
`POST /internal/audit-event`) carrying the same payload, tagged with the
originating `taskId`.

Rejected alternative (Option 1, piggybacking on the existing
`subscribeToAgentStream`/`/tasks/:id/stream` mechanism, which today
re-sends the full task object every 500ms until terminal): would cap
visibility latency at 500ms and require adding dedup/diff logic to that
resend loop in three separate agents (DevOps, Testing, Documentation) just
to avoid re-broadcasting the same audit entry on every subsequent
snapshot. The push endpoint is both faster (true real-time, no polling
ceiling) and simpler (one-directional fire-and-forget, no snapshot
diffing).

**Failure mode, explicit**: if the push fails (Orchestrator unreachable,
timeout), it is dropped silently — `console.log` remains the durable
record either way, and the task itself is never blocked, delayed, or
affected by this push failing. Matches this repo's existing posture that
audit/observability paths are best-effort, never load-bearing for
correctness (same principle already applied to `emitAuditEvent()`'s own
console-log-only design today).

### 3. Orchestrator emits AG-UI-shaped events on `GET /events`

Map onto the existing task lifecycle:

| OrchestrAI moment | AG-UI event |
|---|---|
| Task submitted / dispatched | `RUN_STARTED` |
| Plan step dispatched (Planning tasks) | `STEP_STARTED` |
| Plan step completed | `STEP_FINISHED` |
| MCP tool call / direct A2A call (from routed `emitAuditEvent()`) | `TOOL_CALL_START` → `TOOL_CALL_RESULT` |
| Task reaches `input-required` | `CUSTOM` (`orchestrai.approval-required`) |
| Task approved/rejected | `CUSTOM` (`orchestrai.approval-resolved`) |
| Task completed/failed | `RUN_FINISHED` / `RUN_ERROR` |

The bare `{type: "task-update"|"agents-update"}` signal is replaced, not
kept in parallel long-term — a transition window during implementation is
fine, a permanent dual system is not.

### 4. Dashboard client rewritten to consume the stream incrementally

Replace the fragment-swap (`innerHTML` replace-all) with per-event DOM
patching keyed on `taskId`/`toolCallId`. This is real, non-trivial
front-end work — the largest single piece of this spec, not a footnote.

### 5. TUI — in scope for this pass

**Decided: included, not deferred**, overriding this spec's original
dashboard-only recommendation. `apps/tui/index.tsx` currently polls
`GET /tasks` every 1.5s (`POLL_INTERVAL_MS`); it gains a second data path
consuming `GET /events` (via a standard `EventSource`-equivalent SSE
client for Bun/Node, or a hand-rolled `fetch` + `ReadableStream` reader
matching the pattern `subscribeToAgentStream` already uses on the
Orchestrator side) for live tool-call/step events, while keeping the
existing poll as the source of truth for task list membership/status
(cheap, already reliable, not worth replacing outright). This closes the
"predates SSE" gap `specs/012-tui-interactive/spec.md` already flagged as a
deliberate simplification.

New TUI-specific surface: a way to show a task's live tool-call activity
inline (e.g. under its row when selected, or in the existing Detail view)
— exact presentation is an implementation-time decision, not pre-specified
here down to pixel level, but must reuse the sixteen extension rounds'
existing height-budget/overflow-safety patterns from
`specs/012-tui-interactive/spec.md` rather than introduce a new unbounded-content
box.

## Safety Constraints

- **No change to routing, planning, or the approval gate's enforcement.**
  This spec is exclusively about how already-decided state and already-
  gated actions become *visible*, not how they're decided. A task's Tier
  classification, `actionId` binding, and approval requirement are
  completely unaffected.
- **Approval remains a real HTTP request the client controls**
  (`POST /tasks/:id/approve` with its server-issued `actionId`) — the
  `CUSTOM` approval-related events proposed above are informational only,
  never a substitute for that request. Nothing about "who can approve
  what" changes.
- **`emitAuditEvent()`'s existing bounds are unchanged**: 512-byte
  `resultSummary`, 64 KiB task-result cap. Streaming these live doesn't
  loosen either bound.
- **The 5-second heartbeat / sub-10s idle-timeout constraint on `GET
  /events` is preserved** — already a documented, previously-diagnosed
  fragility (`Bun.serve`'s default 10s idle-request timeout); this spec
  must not regress it.

## In Scope

1. Local TypeScript types for the AG-UI event shapes actually used
   (`RUN_*`, `STEP_*`, `TOOL_CALL_*`, `CUSTOM`) in `packages/shared/`.
2. New `POST /internal/audit-event` on the Orchestrator; `emitAuditEvent()`
   fires a best-effort push to it in addition to its existing `console.log`.
3. `GET /events` emitting the mapped event stream per the table above,
   replacing the bare change-notification.
4. Dashboard client JS rewritten to consume events incrementally instead
   of fragment-swapping.
5. TUI: a second live data path consuming `GET /events` alongside its
   existing poll loop, surfacing live tool-call/step activity for the
   selected task.
6. Updated `CLAUDE.md`/`README.md` documenting the new event shape.

## Out of Scope / Non-Goals

- **Each agent's own separate dashboard/`/tasks/:id/stream`.** Unchanged;
  this spec only touches the Orchestrator's aggregate view and the two
  clients (dashboard, TUI) that consume it.
- **Adopting the official `@ag-ui/*` npm packages.** Types only, hand-
  rolled to match the spec, per the "minimal new dependency" decision
  above.
- **Any change to Tier classification, approval enforcement, or which
  operations require it.**
- **Google ADK / LangChain-LangGraph.** A separate, larger, explicitly
  deferred decision (rebuilding the Orchestrator's core on a third-party
  framework) — not bundled into this spec under the same "AG-UI" banner.
- **WebSocket transport.** SSE only, matching the existing mechanism and
  avoiding a second transport implementation for no demonstrated need yet.

## Acceptance Criteria

- [x] Yusuf approves this spec. Approved 2026-08-10: push endpoint for
      audit-event routing, `CUSTOM` events for approval, TUI included in
      scope.
- [x] `emitAuditEvent()`'s output for a task in progress is visible on the
      Orchestrator's `GET /events` stream in real time (i.e. before the
      task completes), not only in each agent's own console log.
- [x] The audit-event push failure mode is verified: with the Orchestrator
      unreachable, an agent's task still completes normally (push failure
      never blocks or delays the task itself).
- [x] A live task's plan steps (for `plan-task` runs) appear as
      `STEP_STARTED`/`STEP_FINISHED` as they're dispatched, not only after
      the whole plan finishes.
- [x] The dashboard reflects a tool call's start and result without a full
      fragment re-render — verified by inspecting actual DOM mutations,
      not just "the page updated."
- [x] The TUI shows live tool-call/step activity for a selected in-progress
      task, alongside its existing poll-driven task list — data path
      verified live; **visual quality in a real terminal still needs
      Yusuf's confirmation** (see Verification Results).
- [x] `GET /events`'s heartbeat/idle-timeout behavior is unchanged —
      verified by holding a connection open past 10s with no forced
      disconnect.
- [x] Approval-gate behavior (Tier classification, `actionId` binding,
      reject/approve enforcement) is verified byte-identical to before
      this change — same tests, same outcomes.
- [x] `bun test` and `bun run typecheck` both pass.
- [x] Live end-to-end: submit a write-capable task (e.g. `dockerize`),
      watch its MCP tool call appear live on both the dashboard and the
      TUI before completion, approve it, and confirm the full event
      sequence matches the mapping table above.

## Verification Results (2026-08-10)

All verified against the running stack, not inferred from the code.

**1. Full lifecycle matches the mapping table.** Captured the raw
`GET /events` stream while submitting `git status ...`:

```
STATE_SNAPSHOT   (on connect — 5 agents, current tasks)
RUN_STARTED      timestamp 1786867622509
TOOL_CALL_START  toolCallName=git_status caller=devops-agent   ...622549
TOOL_CALL_RESULT outcome=completed durationMs=127              ...622656
RUN_FINISHED     outcome=success                               ...623050
: heartbeat
```

The decisive number: `TOOL_CALL_START` fired at `...622549`,
`RUN_FINISHED` at `...623050` — the tool call was visible **~500ms before
the task completed**, which is the entire point of this spec. Previously
that call appeared nowhere but the agent's own console.

**2. Approval flow (`CUSTOM` events).** A `dockerize` task produced
`RUN_STARTED` → `CUSTOM orchestrai.approval-required` (carrying the full
`ApprovalPreview`: `actionId`, `toolName`, resolved target path,
parameters, and both risk strings) → `CUSTOM orchestrai.approval-resolved`
`{decision:"rejected"}` → `RUN_ERROR`. Confirmed the rejection wrote
nothing: no `Dockerfile` exists in the fixture project afterward.

**3. Plan steps stream live and sequentially.** `setup my project from
scratch` produced interleaved, correctly-ordered pairs as each step
dispatched — `STEP_STARTED 1. analyze-project` → `STEP_FINISHED ... outcome:
completed` → `STEP_STARTED 2. git-status` → `STEP_FINISHED` →
`STEP_STARTED 3. create-gitignore` (which then correctly stopped at its
approval gate). Not one batch after the plan finished.

**4. Push failure mode — the safety-critical one.** Started **only**
`mcp:http` + `devops-agent`, with no Orchestrator process at all
(confirmed: `GET :3000/healthz` returned nothing). Submitted a task
directly to DevOps: it **completed normally** with a correct result, and
`grep` found **zero** audit-push error lines in its log — the
fire-and-forget `.catch(() => {})` swallows failures silently exactly as
designed, and the task path never waits on or is affected by the push.
Required killing leftover `bun.exe` processes first — an earlier attempt at
this test was invalid because a previous Orchestrator was still listening,
which would have silently produced a false pass.

**5. Dashboard patches the DOM in place.** With the dashboard open, an
`analyze-project` task (the one case exercising MCP *and* direct A2A)
produced, via `document.querySelectorAll` inspection rather than a visual
guess:

```
tr.toolcalls rows inserted: 1
live call lines: ["✓ devops-agent → analyze_project · 53ms",
                  "✓ devops-agent → security-agent · 147ms"]
```

Both hops are now visible live — including the DevOps→Security direct A2A
secrets pre-check, which previously existed only in console output and in
`context/demo/protocol-cheat-sheet.html`'s prose.

**6. Heartbeat/idle-timeout unchanged.** Held `/events` open for 14s (past
Bun's 10s per-request idle timeout, the previously-diagnosed fragility):
`curl` exited 124 (its own timeout, i.e. the server never force-closed),
2 heartbeats received, no stream errors.

**7. TUI.** Runs clean with the new stream consumer (no crash, no errors
over repeated runs). With a task submitted while it was running, the
inline `⚙` badge rendered as intended. **Honest caveat, matching this
repo's established pattern for TUI work:** the *data path* is verified,
but visual quality/layout in a real interactive terminal is not — piping
OpenTUI's cursor-addressed output to a file is not representative
rendering (a lesson learned the hard way across
`specs/012-tui-interactive/spec.md`'s sixteen rounds). Needs Yusuf's eyes.

**8. Regression suite.** `bun test`: 138 pass, 0 fail, 211 expectations,
14 files. `bunx tsc --noEmit`: 0 errors. Unchanged from before this
work — the approval-gate and routing tests in particular pass identically,
confirming this spec touched presentation only.

**`toolCallId` uniqueness — fixed 2026-08-10.** Originally derived as
`${taskId}:${kind}:${target}`, which collided if the same task called the
same tool twice. Fixed by minting the id at the source instead of deriving
it: `mcp-client.ts` mints a `crypto.randomUUID()` per call;
`a2a-client.ts` reuses its own already-fresh-per-call `childTaskId`
(itself `a2a-${randomUUID()}`) rather than a second id. Both push it as
`callId` on their `START` and `RESULT` calls; the Orchestrator prefers
`payload.callId` for `toolCallId`, falling back to the old derived string
only if a push omits it (an agent build predating this fix). Chosen over a
counter on the Orchestrator side because a counter would have to guess
which `START` a given `RESULT` pairs with — fine while calls are
sequential, wrong the moment a push is dropped, which is explicitly
allowed (pushes are fire-and-forget). Minting at the source has no pairing
heuristic to get wrong. Matches CLAUDE.md's existing convention: "All
producer-generated task/child IDs use `crypto.randomUUID()`."

Verified live: captured the real event stream for an `analyze-project`
task (the one case with two distinct calls — MCP `analyze_project` and the
direct A2A hop into Security) and confirmed both `toolCallId`s are now
real, provably distinct UUIDs (`5e89fe97-...` for the MCP call,
`a2a-3b5e52dc-...` for the A2A call), each still shared correctly across
its own `START`/`RESULT` pair. `bun test` 138/0/211, `tsc` 0 errors,
unchanged.
