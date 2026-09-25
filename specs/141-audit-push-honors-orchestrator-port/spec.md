---
id: 141-audit-push-honors-orchestrator-port
title: Agents Send Live Audit Events to the Configured Orchestrator Port
area: ag-ui
change_type: fix
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 073-configurable-service-ports
supersedes: []
superseded_by: []
related:
  - 021-ag-ui-event-protocol
  - 108-durable-audit-trail
  - 131-demo-preflight-and-ag-ui-demo-refresh
---

# Spec: Agents Send Live Audit Events to the Configured Orchestrator Port

> Approved and implemented 2026-09-25.

## Purpose

Found while verifying specs/131: with the Orchestrator on a custom port
(`ORCHESTRAI_ORCHESTRATOR_PORT=5000`) and no full URL override, the
dashboard's and TUI's live tool-call rows stay empty. Every agent's audit
push goes to `http://localhost:3000` instead. If another OrchestrAI stack
is running there, it receives this stack's audit events: the wrong
dashboard shows them, and they're written to that project's audit trail.

## Verified Current State

- `packages/shared/audit.ts:86`:
  `const ORCHESTRATOR_URL = process.env.ORCHESTRAI_ORCHESTRATOR_URL ?? "http://localhost:3000"`.
  It's the only target of the best-effort `POST /internal/audit-event`
  push.
- specs/073 made every other client resolve `ORCHESTRAI_<SERVICE>_PORT`
  via `resolveServicePort()` (`packages/shared/service-ports.ts`), with the
  full-URL override still winning first. The TUI does the same
  (`resolveOrchestratorUrl()`, specs/099). This push was missed.
- Live evidence (specs/131 verification): stack on 5000–5008, no URL
  override. The git-status task completed, the agent logged its MCP audit
  line, and the Orchestrator's `/events` carried only `RUN_STARTED` /
  `RUN_FINISHED`, with no `TOOL_CALL_*`.

## Proposed Behavior

- Resolve the push target the same way the TUI does:
  `ORCHESTRAI_ORCHESTRATOR_URL` if set, else
  `http://localhost:${resolveServicePort("orchestrator")}`.
- Resolve it per push, not once at module load, so a test or embedding
  that sets the env after import sees the right value. It's cheap: one env
  read.
- Nothing else changes: still best-effort and never awaited, and a failure
  is still swallowed.
- Search the rest of the runtime (`apps/`, `packages/`) for any other
  hardcoded `localhost:3000` / `:3006` fallback that ignores the port
  variables, and fix those in this spec too if found (listed in
  verification).

## Scope

`packages/shared/audit.ts` (plus any other occurrence found by the search),
and tests.

## Safety and Compatibility Constraints

- Default ports and an explicit `ORCHESTRAI_ORCHESTRATOR_URL` behave
  exactly as today.
- The push target stays loopback unless the user sets the URL override.

## Out of Scope / Non-Goals

- Authenticating `/internal/audit-event`.
- Changing what an audit event contains.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] Unit: with only `ORCHESTRAI_ORCHESTRATOR_PORT=5000`, the push goes to
      `http://localhost:5000/internal/audit-event`; with the URL set, the
      URL wins; with neither, `http://localhost:3000`.
- [x] Live: `bun run demo:ag-ui` passes against a stack on 5000–5008
      **without** setting `ORCHESTRAI_ORCHESTRATOR_URL`.
- [x] The runtime search is recorded; typecheck 0; `bun test` no
      regressions; `CLAUDE.md` and worklog updated.

## Verification Record

- `resolveAuditPushUrl()` (`packages/shared/audit.ts`): URL override, else
  `localhost:<ORCHESTRAI_ORCHESTRATOR_PORT>`, resolved per push. 3 unit tests.
- Runtime search for hardcoded ports found six more: each agent's Agent Card
  `url` was a literal `localhost:30xx`. These were informational only (the
  Orchestrator routes by the URL it discovered the agent at) but wrong on
  custom ports; they now use `resolveServicePort()`. DevOps→Security A2A already
  used the shared registry. `scripts/ag-ui-demo.ts` defaults had the same bug
  and now follow the port variables.
- Live: stack on 5000–5008 with **no** `ORCHESTRAI_ORCHESTRATOR_URL` /
  `ORCHESTRAI_MCP_URL`; DevOps's card reports `localhost:5002`;
  `demo:ag-ui` passed 6/6 (141 events, Security A2A included). Fixture
  hashes unchanged.
