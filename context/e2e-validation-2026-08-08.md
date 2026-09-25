# OrchestrAI comprehensive E2E validation — 2026-08-08

Status: **REPORT ONLY — no runtime implementation was changed in this validation pass.**

## Executive result

The implemented checkpoint has a working happy path:

- all seven services started together on ports `3000`–`3006`;
- DevOps discovered all 10 MCP tools and used MCP for the five mapped skills;
- direct DevOps-to-Security A2A worked;
- write actions paused for approval and rejection caused no write;
- stdio and HTTP MCP ran at the same time as separate server processes using the shared factory;
- metadata-only audit events did not expose the fixture secret; and
- the final automated suite passed: **19 passed, 0 failed, 34 expectations**.

The application is **not yet reliable enough for an unattended demo**. Five issues should be treated as checkpoint blockers: malformed task envelopes can crash the entire `bun run dev` stack, MCP silent-restart recovery is broken while readiness remains green, Orchestrator IDs collide under concurrency, duplicate agent task IDs can replace an action behind a stale approval, and `run_tests` can mutate the project despite being classified as approval-free/read-only.

## Environment and cleanup

- Runtime: Bun `1.3.14`, Windows, SDK `@modelcontextprotocol/sdk@1.30.0`.
- All write tests used a disposable project under `.tmp-e2e`; no write test targeted the real repository.
- The disposable project and logs were removed after evidence was collected.
- All test processes were stopped and ports `3000`–`3006` were confirmed released.
- `.claude/` and other user-owned untracked content were not changed.

## Blockers

### B1 — Invalid `message.parts` crashes every service in the full stack

Severity: **critical**

Reproduction:

1. Start `bun run dev`.
2. POST a task containing an `id` and `message`, but no `message.parts`, to DevOps.
3. The route accepts it as `submitted`.
4. `task.message.parts.map(...)` throws outside the task-level `try/catch`.
5. DevOps exits with code 1; `bun run --parallel` sends `SIGINT` to the other six services.

Evidence: `packages/agents/devops/index.ts:179-180` and `packages/agents/devops/index.ts:260-265`. The same shallow envelope-validation pattern exists in the other agents. Malformed JSON also returns HTTP `500` rather than a controlled `400`.

Required fix: validate the complete task schema before storing or dispatching it, await/catch `processTask()`, and add HTTP regression tests proving malformed input cannot terminate a service.

### B2 — MCP silent restart leaves DevOps permanently stale while `/healthz` stays ready

Severity: **critical**

Observed sequence:

1. DevOps was connected to MCP with one session.
2. MCP was stopped and restarted before another tool call.
3. New MCP reported zero sessions; DevOps still reported `ready: true`, `state: connected`.
4. Two consecutive analysis tasks failed with `Unknown MCP session`.
5. DevOps continued reporting `ready: true`, and MCP still had zero sessions.

The recoverable-error matcher does not recognize the server's `Unknown MCP session` response. Evidence: `packages/agents/devops/mcp-client.ts:193` and `packages/mcp/http.ts:31`.

Contrast: startup retry and a hard outage both worked. Starting DevOps before MCP reached connected automatically, and a network failure while MCP was truly down changed DevOps to `retrying`; after MCP returned it reconnected and the next MCP+A2A task completed.

Required fix: treat unknown/expired session responses as reconnectable, invalidate readiness immediately on tool transport failure, reconnect once, and retry the safe call within its existing bound. Add a real restart integration test.

### B3 — Orchestrator task IDs collide under concurrency

Severity: **critical**

Test: 100 concurrent safe `suggest agents` submissions.

- Submitted: `100`
- Unique IDs: `32`
- Duplicate groups: `27`
- Maximum requests sharing one ID: `6`

Cause: `task-${Date.now()}` at `apps/orchestrator/index.ts:439`. Collisions overwrite entries in the task map and can mix status/approval ownership.

Required fix: use `crypto.randomUUID()` or an equivalent collision-resistant ID, reject duplicate external IDs, and add a concurrent submission test.

### B4 — Reusing a DevOps task ID replaces the pending approved action

Severity: **critical**

Test:

1. Submit `create-gitignore` with ID `duplicate-approval-id`; capture its approval screen.
2. Submit `dockerize` for a different directory with the same ID.
3. Both submissions are accepted and the pending action is overwritten.
4. Approving the original ID creates the replacement Dockerfile with the replacement port.

Observed: the first `.gitignore` remained absent; the replacement Dockerfile was created with `EXPOSE 9876`.

Evidence: task and pending-action maps are overwritten at `packages/agents/devops/index.ts:188-189` and `packages/agents/devops/index.ts:264`.

Required fix: reject duplicate active and terminal task IDs, bind approval to an immutable action digest/version, and make approve/reject valid only for `input-required`.

### B5 — `run_tests` is not actually read-only

Severity: **critical policy mismatch**

A disposable Bun test intentionally executed `Bun.write("mutation.txt", ...)`. The Testing Agent:

- requested no approval;
- completed the task successfully; and
- created `mutation.txt` in the target project.

Fixed argv and `shell: false` prevent command-string injection, but they do not make untrusted project test code non-mutating. Evidence: `packages/agents/testing/index.ts:90-111` and the approval-free classification at `packages/agents/testing/index.ts:171-172`.

Required review decision: either classify test execution as an approval-required command action, or run it autonomously only inside a disposable/read-only sandbox with explicit filesystem, process, network, time, and resource boundaries. The current spec statement that `run_tests` does not mutate state is disproved by the live test.

## High-priority findings

### H1 — Orchestrator hides informed-approval details

Direct DevOps exposed `Tool`, resolved target, and exact immutable arguments. The Orchestrator task and dashboard exposed none of those details before approving the same CI write. The approval still executed correctly, but it was not informed approval.

Evidence: DevOps sets the details at `packages/agents/devops/index.ts:189-200`; Orchestrator copies only the status at `apps/orchestrator/index.ts:186-187`; its dashboard renders only buttons at `apps/orchestrator/index.ts:612-614`.

### H2 — Reject can create or corrupt terminal tasks

- Rejecting an unknown DevOps ID returned `200` and manufactured a retrievable failed task.
- Rejecting a completed DevOps task returned `200`, changed it to failed, and erased its result.
- Rejecting a completed Orchestrator task returned `200` and changed it to failed.

Reject must require an existing `input-required` task and should be idempotent only for the same already-rejected action.

### H3 — MCP HTTP write tools can be called directly without approval or audit

A separate local SDK client connected to MCP HTTP and called `create_gitignore` directly. The file was created without an agent approval gate, and no agent audit event contained the direct call. The test explicitly terminated its MCP session afterward.

This may be accepted for the two-day loopback-only checkpoint, but it means approval/audit are agent-layer conventions, not properties of the privileged MCP boundary. Any local process able to reach port `3006` can bypass them. Record this as an accepted demo risk or add server-side authorization/capability enforcement.

### H4 — MCP sessions survive abrupt client termination

After terminating the sole DevOps process, MCP still reported one session. Starting one new DevOps process raised the count to two although only one client was alive. There is no TTL/reaper for orphaned sessions.

### H5 — Orchestrator registry never marks an agent offline

After Security's port was confirmed closed, `/agents` continued reporting `security-agent: online`. An orchestrated analysis correctly completed with a Security warning, but discovery state remained stale.

### H6 — Direct intent routing misses four capabilities

The following direct Orchestrator requests all went to Planning as `plan-task`, rather than the expected agent/skill:

| Intent | Expected | Actual |
|---|---|---|
| `run tests` | Testing | Planning |
| `document API` | Documentation | Planning |
| `scan secrets` | Security | Planning |
| `create compose` | DevOps | Planning |

Planning may later generate some child skills, but Documentation/Security intent can be lost and this is not direct routing.

### H7 — Parent plan status is not aggregate execution status

A four-step production plan showed parent `completed` while its Docker child was `input-required`. After rejecting that child, its plan step became failed but the parent remained `completed`.

## Other reproducible gaps

| Scenario | Actual result |
|---|---|
| Git command fails (`fatal: dubious ownership`) | DevOps task still reports `completed` and embeds the fatal error as normal result text. `safeExec()` converts command failures to strings. |
| Missing absolute project path | Analysis reports `completed with warning` rather than failed, even though neither MCP analysis nor Security scan succeeded. |
| Path directory contains `ci` | `git status at ...\\ci-demo` is misrouted to `create_github_action` and asks for approval. |
| Uppercase runtime | `dockerize Node app` is parsed as Bun because runtime extraction is case-sensitive. |
| Natural language before path | `create CI to deploy app at "C:\\..."` captures `deploy` as the path and fails before reaching the valid absolute path. |
| Documentation output path with spaces | `save to "...\\api docs.md"` is treated as read-only; no approval is requested and no file is written. |
| Secret stored in `.txt` | Security scan ignores it; the same fake token in `.ts` is detected and redacted. |
| `create-compose` | Requests approval, then returns `completed: approved but not implemented`; no file is created and the skill is absent from the Agent Card. |
| Failing test suite | Testing task is `completed` with `Failed: 1`. This may be intentional task-execution semantics, but callers must inspect result content. |
| MCP `/healthz` hostile Host header | Health remains public on loopback. The actual `/mcp` initialize request correctly returns `403`, so MCP Host validation passed. |

## Passed scenarios

### Automated and transport

- `bun test`: 19 passed, 0 failed, 34 expectations.
- Bun bundle/transpile checks passed for HTTP MCP, stdio MCP, and DevOps.
- A real stdio SDK client listed all 10 tools and called `analyze_project` while HTTP MCP and DevOps remained live. HTTP session count was unchanged, confirming the intended separate-process/shared-factory coexistence.
- MCP invalid JSON, non-initialize request without a session, missing session, and fake session returned controlled `400`/`404` errors.
- Hostile Host on the actual `/mcp` request returned `403`.

### Full application and A2A

- Ports `3000`–`3006` returned healthy during the full-stack baseline.
- All five Agent Cards were discovered; dashboards returned `200`; Orchestrator and task SSE emitted events.
- Planning and agent suggestions completed.
- DevOps analysis used MCP and direct Security A2A without Orchestrator involvement.
- Security unavailable produced `completed with warning` without claiming the scan passed; Security recovery restored a normal combined result.
- Startup order retry and hard-outage recovery passed.

### Approval and file integrity

- Dockerfile, CI, `.gitignore`, README, and API-documentation scenarios were checked before and after approval/rejection.
- No target file existed before approval.
- Rejection produced no write.
- Supplying malicious replacement arguments in an approval POST did not alter the parameters captured before approval.
- README overwrite warning appeared; rejection preserved the original SHA-256 hash.

### Paths, tests, and security

- Environment-default target resolution worked.
- Quoted absolute Windows paths containing spaces worked.
- Relative paths failed with an actionable absolute-path error.
- Passing Bun tests, coverage, and no-runner cases completed as expected.
- The `.ts` fake secret was detected and returned only as `sk-1...stuv (redacted)`.
- Gitignore coverage and dependency pinning checks completed.

### Audit

Across the collected live logs before cleanup:

- MCP tool audit events: `28`
- A2A audit events: `14`
- failed audit events: `6`
- raw fixture-secret matches: `0`
- every audit event had caller and duration metadata
- direct-MCP bypass audit matches: `0` (the boundary gap described in H3)

## Recommended fix order

### Must have before the demo

1. Complete task-envelope validation and crash containment for every agent.
2. Replace `Date.now()` IDs and reject duplicate agent task IDs.
3. Fix unknown-session reconnect and make readiness truthful.
4. Forward exact approval details through the Orchestrator.
5. Resolve the `run_tests` approval/sandbox policy using the live mutation evidence.
6. Restrict reject/approve transitions to the correct state.

### Should have before judging

1. Add direct routing for Testing, Documentation, Security, and either implement or remove Compose.
2. Add agent heartbeat/offline status and MCP orphan-session cleanup.
3. Make parent plan status reflect child execution.
4. Treat subprocess failures and missing targets as task failures.
5. Fix path/keyword parsing and documentation output paths with spaces.

### Explicitly accept or defer

- loopback MCP without server-side auth/approval/audit;
- Security extension coverage beyond its current allowlist;
- failing-test-suite task semantics;
- durable audit/session/task storage.

Any runtime fixes resulting from this report must start with an updated reviewed spec, following the repository's SDD gate.
