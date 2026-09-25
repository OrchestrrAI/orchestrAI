# Verification — 136 Orchestrator task and agent metadata

## What changed (2026-09-25)
- **`conversationId` on tasks.** `withConversationId()`
  (`apps/orchestrator/index.ts`) adds `conversationId: string | null` to
  every task in `GET /tasks` and to `GET /tasks/:id`, from
  `taskConversations` (now exported for tests). Additive; no other field
  changes.
- **Agent liveness.** A new module, `apps/orchestrator/agent-liveness.ts`:
  - `AgentLivenessTracker` with an injected probe and clock, and
    `probeAgentHealth()` (`GET /healthz`, 3 s timeout, any 2xx means
    reachable).
  - `checkAgentLiveness()` runs on the existing 10-second discovery tick,
    concurrently per agent, and never overlaps a check for the same agent.
  - A reachable agent's `lastSeen` is refreshed; `ready: false` still
    counts as reachable.
  - `AGENT_OFFLINE_AFTER_FAILURES` (3) consecutive failures set
    `"offline"`, log a named warning and emit `orchestrai.agents-update`.
  - Recovery is the loop's existing re-discovery. In-flight tasks are not
    touched.
- **Audit id match.** `GET /audit?task=<id>` queries
  `auditTaskIdsForQuery(id)`, i.e. `[id, "orch-<id>"]`; an `orch-` id
  matches only itself. `store.listAuditEvents()` takes `taskIds`
  (`WHERE task_id IN (…)`), with the one-id `taskId` form kept.
- **TUI** (`apps/tui`):
  - `TaskRowLike.conversationId`; the `chat · ` marker uses it, and spec
    130's session-local `chatTaskIds` set is removed.
  - The Audit filter is one query.
  - Agent details show a relative "Last seen: just now / 5m ago" instead
    of spec 130's "(at discovery)".

## Automated
- `apps/orchestrator/agent-liveness.test.ts` (new):
  - The tracker: success resets the count; failures 1–2 stay online and
    the 3rd goes offline; a throwing probe counts as a failure; offline
    agents are skipped; checks never overlap.
  - `probeAgentHealth` against a real local server: 2xx with
    `ready: false` is reachable; a 500 or an unreachable port is not.
  - Wiring: an agent failing 3 checks via `checkAgentLiveness()` becomes
    offline in the registry and in `GET /agents`, and
    `findAgentForSkill()` no longer returns it.
  - `conversationId` on both task endpoints, including `null` for an
    unmapped task.
  - `auditTaskIdsForQuery`.
- `packages/shared/store.test.ts`: `listAuditEvents({ taskIds })` matches
  any of the ids, newest first, and an empty list means no filter.
- `bun run typecheck` 0 errors; full `bun test` in the commit below.

## Live check
The services ran as separate processes (so one could be killed alone), on
ports 5000/5002/5006, with persistence on, against
`C:\Users\moham\test-target-project`.

| Step | Result |
|---|---|
| `GET /agents` twice, 12 s apart | `lastSeen` 06:01:54 → 06:02:04. It now advances on each tick |
| `POST /ask` "what is my git status?" | `GET /tasks` shows that task with `conversationId: conv-fc0a1243…` |
| `GET /audit?task=task-71c5…` (the plain id, as either UI or a user would type it) | Returns the agent's `orch-task-71c5… mcp-tool-call devops-agent → git_status`. Before this spec, that query returned nothing |
| Fresh TUI, Tasks, no thread opened | `chat · what is my git status?` on the first poll |
| TUI Agent details | `Last seen: just now · Tasks: 1` |
| Kill `devops-agent` (down at 09:03:13) | `GET /agents` shows it `offline` about 24 s later; the log says `agent devops-agent marked offline after 3 consecutive failed health checks` |
| While offline: `POST /tasks` "what is my git status?" | Not dispatched to the dead agent. It fell to `plan-task`, and the Orchestrator's own read-only inspection answered (the specs/112 fallback) with the real branch and status |
| TUI while offline | Header `0/1 agents`; the Agents list and status rail show `○ devops-agent` |
| Restart `devops-agent` | Back `online` with a fresh `lastSeen` about 7 s later ("Late discovery: http://localhost:5002"), through the existing re-discovery loop |

No write was requested in this run. The fixture's SHA-256 snapshot matched
afterwards.

## Notes
- The dashboard's Audit filter needed no change: it calls the same
  `GET /audit?task=` endpoint, which now expands the id.
- The dashboard's "last seen" line (`a.lastSeen.toLocaleString()`) is now
  a live time rather than the discovery time.
