---
id: 022-ag-ui-demo-stabilization
title: AG-UI Demo and TUI Stabilization
area: ag-ui
change_type: enhancement
status: implemented
verification: partial
created: 2026-08-16
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-16
implemented_on: 2026-08-16
amends:
  - 021-ag-ui-event-protocol
supersedes: []
superseded_by: []
related:
  - 021-ag-ui-event-protocol
  - 023-spec-governance-and-catalog
---

# Spec: AG-UI Demo and TUI Stabilization

> Status: **IMPLEMENTED ON 2026-08-16 — VERIFICATION PARTIAL.**
>
> Automated checks and both Windows live demo modes pass. Native Linux demo
> execution and Yusuf's real-terminal TUI visual check remain open; see
> `verification.md`.
>
> This spec follows the repository SDD gate. Creating this document does not
> authorize runtime, TUI, script, workflow, or documentation changes.

## Purpose

Close the remaining gaps between the implemented AG-UI live-event layer, its
demo tooling, the TUI presentation, and the repository documentation before
starting a larger framework or LLM-integration checkpoint.

The existing AG-UI implementation is working: the Orchestrator emits live
`RUN_*`, `STEP_*`, `TOOL_CALL_*`, `CUSTOM`, and state events; the dashboard
consumes them incrementally; and the TUI consumes tool-call events alongside
its existing polling path. This checkpoint is stabilization and completion,
not a replacement of that architecture.

## Verified Current Behavior

The following was re-verified against `main` at commit `9cea0ed`:

- `bun test`: 138 passed, 0 failed, 211 expectations.
- `bun run typecheck`: 0 errors.
- Ports 3000 through 3006 return healthy responses.
- DevOps, Testing, and Documentation report connected MCP clients.
- A live read-only `git-status` task emitted, in order,
  `STATE_SNAPSHOT`, `RUN_STARTED`, `TOOL_CALL_START`,
  `TOOL_CALL_RESULT`, and `RUN_FINISHED`.
- The live tool call used a caller-minted UUID shared by its START and RESULT.

The review also found the following gaps.

### 1. TUI writes diagnostic text directly to the rendered terminal

`apps/tui/index.tsx` currently calls `console.log()` when:

- connecting to the AG-UI stream;
- the stream connects or fails;
- a tool call starts or finishes; and
- any task with tool-call state renders.

The render-path log runs again on every React render. OpenTUI owns the terminal
screen and uses cursor-addressed differential rendering, so ordinary stdout
lines can corrupt the screen or create unbounded repeated output. The previous
implementation intentionally kept stream failures silent and retried because
polling remains the TUI's source of truth.

### 2. TUI consumes tool-call events but not plan-step events

`specs/021-ag-ui-event-protocol/spec.md` requires the TUI to surface live
tool-call **and step** activity. The current TUI stream consumer handles only
`TOOL_CALL_START` and `TOOL_CALL_RESULT`; it does not handle
`STEP_STARTED` or `STEP_FINISHED`.

The Orchestrator already emits step events correctly. This is a client-side
completion gap, not an Orchestrator protocol gap.

### 3. The checked-in demo runner is not portable or safe by default

`scripts/ag-ui-demo.sh`:

- requires Bash plus external commands such as `timeout`, `curl`, `grep`,
  `head`, `cut`, `sort`, and `uniq`;
- cannot be run from the project's normal native PowerShell environment
  without an additional Bash/WSL/Git-Bash dependency;
- hardcodes `C:/Users/moham/test-target-project`;
- writes to a fixed `/tmp` destination;
- includes an approved `create-gitignore` write without an explicit
  write-enabled mode or a target-safety preflight;
- uses fixed sleeps instead of waiting for explicit task states; and
- is not exposed through a root package script.

The script is useful as a historical/manual prototype, but it is not yet a
reproducible cross-platform demo command.

### 4. AG-UI mapping has live evidence but little focused automated coverage

The repository has strong routing, path, MCP-tool, approval, and ID tests, but
no focused automated regression test proving that audit START/RESULT payloads
map to correlated AG-UI events, including the caller-minted `callId` behavior.
The current proof is primarily live/manual.

### 5. AG-UI/TUI documentation still needs final reconciliation

Repository-wide lifecycle/status drift is owned and corrected by the approved
`spec-governance-and-catalog` checkpoint. This draft retains only documentation
that changes as a direct result of its future AG-UI/TUI implementation: the
cross-platform demo command, runbook, renderer behavior, and final visual/live
verification results.

## Proposed Behavior

### 1. Keep the TUI terminal output renderer-safe

- Remove ordinary `console.log()` calls from the TUI's AG-UI connection,
  event-handling, and React render paths.
- Stream failure remains non-fatal: abort/retry with the existing bounded
  two-second backoff while task polling continues.
- Do not add a second logging system or write a log file in this checkpoint.
- If future TUI diagnostics are needed, they require an explicit debug-output
  design that does not share the renderer's stdout stream.

### 2. Surface live plan steps in the existing bounded TUI surfaces

The TUI will track step state per run, correlated by `runId` and a stable step
key derived from the emitted step payload.

- `STEP_STARTED` creates/updates a running step entry.
- `STEP_FINISHED` marks the matching entry completed or failed.
- The selected task's Detail view lists its known steps and outcomes alongside
  the existing tool-call list.
- The normal Tasks row uses only a compact, width-bounded indicator for an
  active step. It must not add an unbounded row or another stacked panel.
- Existing `HARD_TASK_ROW_CAP`, truncation, scrolling, clear/hide filters, and
  auto-follow behavior remain unchanged.
- The existing polling path remains the source of truth for task membership and
  terminal status. AG-UI remains the live-activity path.

### 3. Replace the Bash demo with a cross-platform Bun runner

Add `scripts/ag-ui-demo.ts` and a root command:

```text
bun run demo:ag-ui -- --project <absolute-path>
```

The runner must:

- use Bun/standard TypeScript APIs and `fetch`; no shell command construction
  and no dependency on Bash, PowerShell, curl, grep, or timeout;
- accept the Orchestrator URL through `--orchestrator` or the existing
  `ORCHESTRAI_ORCHESTRATOR_URL`, defaulting to `http://localhost:3000`;
- resolve the target from `--project`, then `ORCHESTRAI_PROJECT_PATH`, and
  otherwise fail clearly; never contain a user-specific hardcoded path;
- require an absolute, existing directory;
- refuse any write-enabled scenario when the target resolves to the OrchestrAI
  repository itself;
- perform health preflight for the Orchestrator and required agents/MCP before
  submitting scenarios;
- consume and parse `GET /events` directly with an `AbortController` and a
  fixed overall timeout;
- wait for explicit task states/events rather than relying on fixed sleeps;
- write an optional raw capture under the OS temporary directory using a
  unique filename, and always print its exact path;
- cleanly abort its SSE reader and timers on success, failure, or Ctrl+C; and
- return a non-zero exit code if required expected events or correlations are
  missing.

#### Default mode: non-mutating

The default demo must not approve any state-changing action.

It may demonstrate:

1. `git-status`: MCP tool START/RESULT and run lifecycle.
2. `analyze-project`: MCP call plus direct DevOps-to-Security A2A call.
3. a write-capable task that reaches approval, followed by **rejection**;
   verify `CUSTOM` approval events and terminal `RUN_ERROR` without writing.
4. a multi-step plan, rejecting any write step that reaches approval.
5. a semantic-fallback read-only route.
6. two synthetic audit START events with the same run/tool but distinct
   caller-provided `callId` values, solely to demonstrate collision-free event
   correlation. These events are observability-only and execute no tool.

#### Optional write mode

Approved-write demonstration is disabled unless the caller supplies an
explicit `--allow-writes` flag.

With `--allow-writes`:

- the target must still differ from the OrchestrAI repository;
- the runner must print a prominent warning naming the exact target;
- it may approve one deterministic fixture write;
- it must record whether the target file existed before the demo;
- it must not delete, overwrite, reset, or clean the target automatically;
- cleanup remains a documented human step unless a future disposable-fixture
  contract explicitly authorizes automatic cleanup.

### 4. Add focused AG-UI regression tests

Extract only the smallest pure mapping/state logic needed for tests; do not
turn the Orchestrator into a new framework.

Automated coverage must prove:

1. an audit `start` payload maps to `TOOL_CALL_START`;
2. its matching terminal payload maps to `TOOL_CALL_RESULT` with the same
   `toolCallId`;
3. two calls for the same task/kind/target but different caller-minted
   `callId` values remain distinct;
4. a legacy payload without `callId` follows the documented compatibility
   fallback;
5. invalid audit payloads produce no AG-UI event and cannot throw;
6. TUI step-state reduction pairs START/FINISHED and bounds retained history;
7. existing approval, routing, and task tests remain unchanged and green.

### 5. Reconcile documentation without rewriting history

- Add the new cross-platform demo command and its safe/default behavior to the
  README and demo runbook.
- Append a concise final implementation/verification entry to
  `context/worklog.md` after implementation, without rewriting earlier entries.

## Safety Constraints

- No change to routing, semantic classification, MCP/A2A ownership, approval
  tiers, actionId enforcement, or task-state transitions.
- No write-capable MCP tool may fire in the default demo mode.
- No generic command-execution input or shell string is introduced.
- The synthetic audit-correlation scenario must not call an MCP tool or agent.
- Event payload/result bounds and the five-second SSE heartbeat remain
  unchanged.
- The TUI must remain usable if the AG-UI stream is unavailable; polling is
  still the fallback/source of truth.
- Historical specs are annotated, not rewritten as though their original
  decisions never existed.

## In Scope

1. `apps/tui/index.tsx`: remove renderer-unsafe logs and add bounded step-state
   consumption/presentation.
2. A small shared/pure AG-UI mapping or state helper only if required for
   focused tests.
3. `scripts/ag-ui-demo.ts` and root `demo:ag-ui` package script.
4. Removal of `scripts/ag-ui-demo.sh` after the Bun runner covers its useful
   scenarios.
5. Focused AG-UI/TUI state tests.
6. Targeted AG-UI/TUI command and runbook corrections in `README.md`,
   `context/demo/runbook.md`, and `context/worklog.md`.

## Out of Scope / Non-Goals

- Official `@ag-ui/*` SDK adoption.
- Google ADK, LangChain, LangGraph, Traycer, or Pi Agent integration.
- LLM-based routing or replacing Model2Vec.
- WebSocket transport.
- Changing individual agents' own dashboard SSE endpoints.
- Authentication/authorization for the local prototype's HTTP surfaces.
- Durable event/audit storage or event replay after process restart.
- Replacing task polling in the TUI entirely.
- Redesigning the TUI layout or reopening unrelated historical TUI polish.
- Restoring a Docker-build CI job; that workflow difference needs its own
  explicit CI decision if the team still requires it.
- Automatically resetting or cleaning a user-selected target repository.

## Acceptance Criteria

- [x] Yusuf explicitly approves this spec before implementation.
- [x] TUI contains no ordinary stdout/stderr logging in its render or AG-UI
      stream-consumption paths.
- [x] TUI displays live tool calls and live plan-step state in bounded existing
      surfaces without adding unbounded rows/panels.
- [ ] `bun run demo:ag-ui -- --project <absolute-path>` runs natively on
      Windows and Linux with no shell-tool dependency. (Windows verified;
      native Linux execution remains open.)
- [x] Default demo mode performs no approved write and leaves the target
      unchanged.
- [x] Write mode requires `--allow-writes`, rejects the OrchestrAI repository
      as its target, and clearly names the external target before approval.
- [x] Demo runner validates health, waits on explicit states/events, enforces a
      total timeout, and exits non-zero on missing required evidence.
- [x] Focused tests cover audit-to-AG-UI correlation, distinct caller-minted
      IDs, legacy fallback, invalid payloads, and bounded TUI step state.
- [x] `bun test` passes with at least the existing 138 tests and zero failures.
- [x] `bun run typecheck` exits 0.
- [x] Live default demo produces the expected MCP, A2A, approval-rejection,
      plan-step, semantic-route, and correlation evidence.
- [ ] TUI is visually checked in Yusuf's real terminal with a live multi-step
      plan; no log garbling occurs and step/tool details are readable.
- [x] Affected AG-UI/TUI command and runbook documentation matches the final
      implementation while preserving historical decisions.
- [x] `context/worklog.md` records implementation files, decisions,
      verification, and remaining limitations.

## Review Decisions Required

Approval resolved these three decisions as proposed:

1. **Plan-step presentation:** compact active-step indicator plus full step
   list in Detail view.
2. **Write demo:** retain the opt-in `--allow-writes` mode.
3. **Legacy Bash script:** delete `scripts/ag-ui-demo.sh` after the Bun
   replacement passes verification.

Recommended approval wording:

```text
Approved specs/022-ag-ui-demo-stabilization/spec.md with:
1. compact step indicator + Detail list;
2. opt-in --allow-writes mode;
3. delete the legacy Bash script after verification.
```
