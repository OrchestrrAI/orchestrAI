---
id: 136-orchestrator-task-and-agent-metadata
title: Orchestrator Exposes Each Task's Conversation, Tracks Agent Liveness, and Matches a Task's Agent-Side Audit Events
area: orchestrator
change_type: fix
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 108-durable-audit-trail
supersedes: []
superseded_by: []
related:
  - 113-live-audit-log-dashboard
  - 046-browser-conversation-operations-workspace
  - 065-llm-only-skill-routing
  - 130-tui-dashboard-parity
---

# Spec: Orchestrator Exposes Each Task's Conversation, Tracks Agent Liveness, and Matches a Task's Agent-Side Audit Events

> Status: **APPROVED by Muhamad-Yussuf on 2026-09-25** ("ok go ahead in them all"), together with specs 133–136. **IMPLEMENTED and VERIFIED live** the same day — see `verification.md`.

## Purpose

Spec 130 ruled out server changes. Its phase 4 therefore ended with three
gaps that only the Orchestrator can close
(`specs/130-tui-dashboard-parity/verification.md`, "Found, not fixed"):

1. **The TUI's `chat · ` marker is partial.** `GET /tasks` carries no
   conversation id, so the TUI can only mark tasks linked from threads it
   has loaded this session. A fresh TUI shows no markers.
2. **Agent liveness is not tracked after discovery.** Investigating the
   frozen `lastSeen` for this spec showed the larger problem: **an agent is
   never marked offline.**
   - A crashed agent keeps showing as online in both UIs.
   - It stays in the capability snapshot, so the router can still pick its
     skills and dispatch to a dead process.
3. **Audit filtering by task misses the agent's events.** Agents record a
   dispatched task's MCP calls under `orch-<id>`, while `GET /audit?task=`
   is exact-match. Filtering by the id a user sees in either UI therefore
   drops the agent-side events. The TUI works around this with two
   queries; the dashboard does not.

## Verified Current State

- **Conversation ids.** `taskConversations: Map<taskId, conversationId>`
  (`apps/orchestrator/index.ts:589`) is set when a chat dispatches a task
  (`:2213`), used by the dashboard's server-rendered table (`:3159`) and
  persisted with each task (`:720`).
  - `GET /tasks` returns `Array.from(tasks.values())` (`:2626`), and
    `OrchestratorTask` has no `conversationId` field, so no HTTP client
    can see it.
  - Plan children are not in the map; the dashboard marks roots only.
- **Agent liveness.** `discoverAgent()` sets `status: "online", lastSeen:
  new Date()` (`:738`).
  - `startDiscovery()`'s 10-second loop (`:4745`) re-discovers only agents
    that are missing or already `"offline"`.
  - **No code path ever sets `status = "offline"`**: a repo-wide search
    finds only the type and the loop's check.
  - `findAgentForSkill()` (`:936`) and `computeCapabilitySnapshot()`
    (`:955`) both filter on `status === "online"`. That filter is correct;
    it just never excludes anything.
  - `agentsUpdated()` (`:615`) emits `orchestrai.agents-update`.
  - Every agent serves `GET /healthz`. DevOps, Documentation, Testing,
    Code Review and Coder report `ready` (MCP) inside it; Security does
    not.
- **Audit ids.**
  - Agents run a dispatched task as `orch-<id>` (`:1020`, `:1245`, `:2256`,
    `:2397`), so their MCP audit events carry `orch-<id>`.
  - The supervisor's A2A events use `orch-<parentId>` (`:1398`).
  - `store.listAuditEvents({ taskId })` uses `WHERE task_id = ?`
    (`packages/shared/store.ts:342`).
  - Confirmed live: a `git_status` event for `task-4c4e…` is stored as
    `orch-task-4c4e…`.
  - The dashboard queries `/audit?task=<typed id>` (`:3855`).
  - The TUI queries both ids and merges them (`auditTaskIdsFor()`,
    spec 130).

## Proposed Behavior

### 1. `conversationId` on tasks
- `GET /tasks` and `GET /tasks/:id` add `conversationId: string | null`
  to each task, from `taskConversations` (null when unmapped). The field is
  additive; nothing else in the response changes.
- The TUI's `chat · ` marker uses this field. The session-local
  `chatTaskIds` set from spec 130 is removed, so every chat-dispatched
  task is marked from the first poll. Children stay unmarked, as in the
  dashboard.

### 2. Agent liveness
- The existing 10-second discovery loop also checks every agent currently
  `"online"` with `GET <url>/healthz`, under a short timeout (3 s).
- **Any HTTP 2xx within the timeout counts as reachable**, and sets
  `lastSeen = now` and resets that agent's failure count. `ready: false`
  (for example, MCP down) is still reachable. Liveness means "the process
  answers", not "every dependency is up", so a dependency hiccup never
  removes an agent's skills.
- **After 3 consecutive failed checks** (timeout, connection error or
  non-2xx), the agent is set to `"offline"`, a named `console.warn` is
  logged, and `agentsUpdated()` is emitted. Detection time is therefore
  about 30 s after a crash.
- **Recovery needs no new code:** the loop already re-discovers `"offline"`
  agents, which sets them online with a fresh `lastSeen` and card.
- Checks for different agents run concurrently, so one slow agent does not
  delay the others. A check never overlaps the previous one for the same
  agent.
- **In-flight tasks are unaffected.** Marking an agent offline does not
  fail, cancel or re-route any existing task. Task polling and approval
  forwarding behave as today.
- Both UIs show the now-live `lastSeen`. The TUI's "(at discovery)"
  wording from spec 130 changes to a relative "last seen Ns ago".

### 3. Audit task filter matches a task's agent-side events
- `GET /audit?task=<id>` returns events whose `task_id` is `<id>` **or**
  `orch-<id>`. An id already starting with `orch-` matches only itself.
  `store.listAuditEvents()` takes the list of ids (`WHERE task_id IN
  (…)`), ordered and limited exactly as today.
- The dashboard's filter then works unchanged.
- The TUI's two-query workaround collapses to one query. Keeping two would
  now return duplicates.

## Scope

- `apps/orchestrator/index.ts`:
  - `GET /tasks`, `GET /tasks/:id`;
  - the discovery loop's health check and failure counting;
  - `GET /audit`.
- `packages/shared/store.ts`: `listAuditEvents()` accepts several task ids.
- `apps/tui/index.tsx` and `apps/tui/tui-state.ts`:
  - use `conversationId`, and remove `chatTaskIds`;
  - the relative `lastSeen` label;
  - a single audit query (`auditTaskIdsFor()` stays for the live-row
    match).
- Tests: orchestrator endpoint tests, `store.test.ts`, the liveness
  counter (as a pure, injectable-clock/injectable-fetch function), and the
  TUI helpers.
- `CLAUDE.md` (present-tense sentences: liveness, the audit id match, the
  task field), the worklog, and this spec's `verification.md`.

## Safety and Compatibility Constraints

- **Routing impact is intended and bounded.** An offline agent's skills
  leave the capability snapshot. Requests for them then fall through as
  they already do when an agent is absent: `plan-task`, or the
  Orchestrator's read-only inspection fallback (`specs/102`, `specs/112`).
  The threshold of 3 consecutive failures prevents a single slow response
  from flapping an agent offline.
- **Approval and execution are untouched.** Liveness never touches a
  pending approval, an `actionId`, a fingerprint or a running task.
- **Additive API only.** `conversationId` is a new field. `GET /audit`'s
  filter returns a superset of today's rows for a plain id and identical
  rows for an `orch-` id. No field is removed or renamed.
- **The audit whitelist is unchanged.** Rows still carry only whitelisted
  metadata (`specs/108`); nothing new is disclosed.
- **Loopback only.** Checks use the agent URLs already in the registry,
  with no new outbound destinations.

## Out of Scope / Non-Goals

- Marking an agent offline on `ready: false` (dependency health).
- Failing or re-routing in-flight tasks when their agent goes offline.
- Marking plan children with a conversation, or a conversation id in AG-UI
  events.
- Configurable thresholds or intervals (constants; can be revisited).
- Orchestrator-side restart recovery (a separate open problem).

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] `GET /tasks` and `GET /tasks/:id` include `conversationId` (a string
      for a chat-dispatched root task, `null` otherwise). Endpoint-tested.
- [x] The TUI marks chat-dispatched tasks from the first poll of a fresh
      session (real PTY), without loading any thread.
- [x] A reachable agent's `lastSeen` advances on each loop tick; a
      `ready: false` agent stays online. Unit-tested with injected fetch
      and clock.
- [x] An agent failing 3 consecutive checks becomes `"offline"`, emits
      `orchestrai.agents-update`, and leaves the capability snapshot; 1–2
      failures do not change its status. Unit-tested.
- [x] Live: killing a running agent process shows it offline in both UIs
      within about 30 s. Restarting it brings it back online with a fresh
      `lastSeen`. Its skills are unroutable while it is offline.
- [x] `GET /audit?task=<id>` returns both `<id>` and `orch-<id>` events;
      `?task=orch-<id>` returns only its own. Store- and endpoint-tested.
      Live: the dashboard filter shows a task's agent-side events.
- [x] The TUI audit filter issues one query and shows no duplicate rows.
- [x] `bun run typecheck` 0 errors; `bun test` no regressions.
- [x] Documentation and worklog are updated.

## Verification Plan

- Unit / endpoint:
  - `store.listAuditEvents` with several ids;
  - `GET /audit` id expansion;
  - `conversationId` on both task endpoints;
  - the liveness counter as a pure function: success resets, 3 failures
    flip to offline, `ready: false` counts as success, and checks for the
    same agent never overlap.
- Live, isolated stack with persistence on:
  - Submit a chat task, then open a fresh TUI and confirm the marker.
  - Kill `devops-agent` and time the offline flip in `/agents`, the
    dashboard and the TUI.
  - Confirm a DevOps request no longer dispatches to it, then restart it
    and confirm recovery.
  - Filter Audit by a task id in the dashboard and in the TUI.
  - Record everything in `verification.md`.

## Approval Requested

Approval authorizes the `conversationId` task field, health-check-based
agent liveness with a 3-failure offline threshold, and the `orch-` audit id
match, plus the matching TUI adjustments. It does not authorize failing or
re-routing in-flight tasks, dependency-based offline marking, or any
approval-path change.
