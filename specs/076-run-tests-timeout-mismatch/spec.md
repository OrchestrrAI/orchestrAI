---
id: 076-run-tests-timeout-mismatch
title: run-tests Always Times Out on a Real Project — Client Timeout Shorter Than the Runner's Own Budget
area: mcp
change_type: fix
status: archived
verification: not-applicable
created: 2026-09-12
updated: 2026-09-12
approved_by: null
approved_on: null
implemented_on: null
amends:
  - 011-remaining-agents-mcp
related:
  - 006-runtime-stabilization
  - 080-run-command-approved-execution
supersedes: []
superseded_by:
  - 080-run-command-approved-execution
---

# Spec: run-tests Always Times Out on a Real Project — Client Timeout Shorter Than the Runner's Own Budget

> Review gate: **DRAFT — NOT APPROVED, and superseded.** This diagnosis
> is absorbed into `specs/080-run-command-approved-execution/spec.md`
> §4 rather than implemented as a standalone fix — `080` needed the
> identical `OrchestraiMcpClient.callTool()` per-call-timeout mechanism
> for its own `run_command` tool anyway, so the fix landed there. See
> that spec's own Acceptance Criteria and verification.md for what was
> actually implemented and verified.
>
> Found live, 2026-09-12: Yusuf asked chat to check test coverage on this
> repo; the Testing Agent's `run_tests` MCP call failed with
> `MCP error -32001: Request timed out` after exactly 15011ms — this
> repo's own real suite (899 tests) takes 26-40+ seconds, so it never had
> a chance to finish.

## Purpose

Two independently-set timeout budgets exist for the same operation, and
they disagree by 8x. `run-tests`/`check-coverage` cannot ever succeed
against a project whose test suite takes longer than 15 seconds — which
is most real projects, including this one.

## Verified Current State

Read 2026-09-12:

- `packages/shared/mcp-client.ts`: `const TOOL_TIMEOUT_MS = 15_000`,
  passed as the SDK request timeout on **every** `client.callTool()`
  call from `OrchestraiMcpClient.callTool()` — one constant, no
  per-tool override, used identically by DevOps/Testing/Documentation.
- `packages/mcp/index.ts`'s `run_tests` tool: imports and uses
  `FIXED_TEST_TIMEOUT_MS` (`packages/shared/test-runner.ts`,
  `120_000` — 2 minutes) as **its own** server-side execution budget
  before it gives up and returns `"Test runner timed out after
  120000ms"`.
- Consequence, confirmed live: the MCP SDK's client-side request timeout
  (15s) always fires first, aborting the whole call with
  `-32001: Request timed out` (a generic SDK timeout code, unrelated to
  this codebase's own reused `-32001` for "Unknown MCP session" in
  `packages/mcp/http.ts` — same number, two unrelated meanings, purely
  coincidental) — the server-side 120-second budget is never actually
  reachable in practice for any test run past ~15 seconds.
- Every other MCP tool in this codebase (`analyze_project`, `git_status`,
  `read_project_file`, `create_dockerfile`, etc.) is a fast, in-memory or
  single-file-I/O operation — 15 seconds is generous for all of them.
  `run_tests` is the **only** tool whose legitimate work (spawning and
  waiting on a real test process) can and regularly does take longer.

## Proposed Behavior

`OrchestraiMcpClient.callTool()` gains an optional per-call timeout
override, defaulting to the existing `TOOL_TIMEOUT_MS` (15s) for every
existing call site — byte-identical behavior for every tool except the
one this spec is about. The Testing Agent's own call to `run_tests`
passes a timeout matching the runner's own real budget plus a fixed
margin for network/serialization overhead:

```ts
const RUN_TESTS_CLIENT_TIMEOUT_MS = FIXED_TEST_TIMEOUT_MS + 5_000 // 125s
```

No change to `FIXED_TEST_TIMEOUT_MS` itself, no change to any other
tool's timeout, no change to the approval gate (Testing's Tier 1
classification is unaffected — this only changes how long the client
waits for an answer, not what happens once it has one).

## Scope

- `packages/shared/mcp-client.ts`: `callTool()`'s new optional timeout
  parameter.
- `packages/agents/testing/index.ts` (and/or `packages/agents/testing/
  mcp-client.ts` if the call site lives there): pass the longer timeout
  specifically for `run_tests`.
- Tests: a focused test proving `run_tests`'s call site requests the
  longer timeout while every other tool/agent's call site is unaffected
  (still receives the default).
- **Out of scope**: `FIXED_TEST_TIMEOUT_MS` itself; any other MCP tool's
  timeout; the stale-session reconnect-once logic (`isStaleSessionError`,
  unrelated — this is a plain request timeout, not a stale session); any
  change to how `check-coverage`/`run-tests` are classified or approved.

## Safety and Compatibility Constraints

- **Every tool but `run_tests` is byte-identical** — the new parameter is
  optional and defaults to today's exact `TOOL_TIMEOUT_MS`.
- **No new unbounded wait.** The new timeout is still a fixed, finite
  number (125s) — never `Infinity`, never user-configurable, matching
  this codebase's existing "bounded, never hang" precedent
  (`specs/045`'s port-preflight timeout, the adaptive supervisor's own
  dispatch bounds).
- **The approval gate and Tier 1 classification are untouched** — this
  only affects how long the client waits for the *result* of a call
  that was already going to happen exactly as before.

## Out of Scope / Non-Goals

- Raising `FIXED_TEST_TIMEOUT_MS` itself (2 minutes already comfortably
  covers this repo's own ~40s suite; not the problem here).
- A configurable/environment-variable-driven timeout for `run_tests` —
  a fixed, generous constant is the same shape every other timeout in
  this codebase uses.
- Any other MCP tool's own timeout behavior.

## Acceptance Criteria

- [ ] `run-tests`/`check-coverage` against this repo's own real test
      suite (a genuine ~30-40 second run) completes successfully instead
      of timing out at 15 seconds — verified live, not just by unit test.
- [ ] Every other MCP tool call (DevOps/Documentation, and Testing's own
      non-`run_tests` calls if any) still uses the original 15s timeout,
      unchanged — proven by test.
- [ ] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [ ] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Unit: `callTool()`'s new optional-timeout parameter defaults correctly
  when omitted; the `run_tests` call site is proven (by a test double
  inspecting what timeout was actually requested) to pass the longer
  value.
- Live: a real `run-tests`/`check-coverage` request against this
  repository's own real suite through the real Testing Agent + real
  mcp:http, confirming it now completes rather than timing out at 15s —
  the exact scenario Yusuf hit.

## Approval Requested

Approve to proceed. Amends `specs/011` (the shared MCP client
DevOps/Testing/Documentation all use). Nothing is implemented until
approved.
