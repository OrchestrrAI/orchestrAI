---
id: 006-runtime-stabilization
title: Demo Runtime Stabilization and Approval Integrity
area: runtime-reliability
change_type: fix
status: implemented
verification: verified
created: 2026-08-08
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-08
implemented_on: 2026-08-08
amends: []
supersedes: []
superseded_by: []
related:
  - 005-mcp-agent-integration
  - 007-parsing-and-sse-reliability-fixes
  - 011-remaining-agents-mcp
---

# Spec: Demo Runtime Stabilization and Approval Integrity

> Status: **APPROVED by Yusuf on 2026-08-08 (all six recommended decisions as
> written, plus Addition 1 and Addition 2 below). IMPLEMENTED on 2026-08-08;
> verification results are recorded at the end of this document. Per Yusuf's
> instruction, `README.md`, `CLAUDE.md`, and `context/worklog.md` are held
> unchanged until the verification results below are explicitly confirmed.**

## Approved Additions (incorporated before implementation, 2026-08-08)

### Addition 1 — A2A client refactor (included in this checkpoint)

`packages/agents/devops/security-a2a.ts` hardcoded the Security Agent URL and
duplicated submit/poll/timeout/audit logic that would not scale to future
agent-to-agent connections. Refactored as part of this checkpoint:

- `packages/shared/agent-registry.ts` — a single `agents` map of agent name to
  base URL (each overridable via `ORCHESTRAI_<NAME>_URL`), and an `AgentName`
  type.
- `packages/shared/a2a-client.ts` — one exported `callAgent(target, taskText,
  opts)` function generalizing the former DevOps-only submit/poll/timeout/audit
  pattern so any agent can call any other agent over the existing custom
  A2A-style HTTP task contract. Outgoing calls are validated with the same
  shared task-envelope contract as inbound calls, and child A2A task IDs use
  `crypto.randomUUID()` (never wall-clock precision), consistent with the ID
  policy below.
- DevOps now imports `callAgent` from `packages/shared/a2a-client` and calls
  `callAgent("security", ...)` instead of `requestSecurityPrecheck()`.
- `packages/agents/devops/security-a2a.ts` and its test were deleted; the
  A2A-client behavior is covered by `packages/shared/a2a-client.test.ts`.
- Orchestrator's `KNOWN_AGENTS` list carries a `// TODO: migrate to
  packages/shared/agent-registry.ts` comment; migrating it is not part of this
  checkpoint.

### Addition 2 — Caller attribution clarification

For this checkpoint, `caller` in every audit event is a hardcoded constant set
by each agent when logging its own outgoing calls (`"devops-agent"` for
DevOps's MCP/A2A calls, `"testing-agent"` for Testing's command-execution
calls), since DevOps and Testing are currently the only agents that produce
audit events. Multi-client attribution via the MCP SDK's `clientInfo.name` at
connect time is deferred to a future spec when additional agents become MCP
clients.

## Purpose

Stabilize the current OrchestrAI demo runtime after the adversarial E2E pass
documented in `context/e2e-validation-2026-08-08.md`.

This checkpoint addresses the five demonstrated blockers and the approval-state
defects that are inseparable from them:

1. malformed task envelopes can terminate an agent and the full parallel stack;
2. a restarted MCP server leaves DevOps using a stale session while health stays green;
3. Orchestrator task IDs collide under concurrency;
4. duplicate agent task IDs can replace the action behind an earlier approval;
5. project tests can mutate state despite the current approval-free classification;
6. Orchestrator does not show the exact action before forwarding approval; and
7. reject endpoints can create unknown tasks or corrupt terminal tasks.

The goal is a small, testable demo-stabilization checkpoint. It is not a general
rewrite of A2A, MCP, routing, persistence, sandboxing, or process supervision.

## Relationship to Existing Specifications

`specs/005-mcp-agent-integration/spec.md` remains the historical, implemented record
of the previous MCP/A2A checkpoint. It must not be rewritten as if its original
acceptance tests never passed.

This draft is a new specification because the failures cross the shared task
protocol, all agents, Orchestrator identity/state, Testing execution policy, and
MCP client lifecycle.

If this draft is approved, it supersedes only the earlier future-policy decision
that allowed `run_tests` as an autonomous Tier 2 exception. Live evidence showed
that fixed argv and `shell: false` prevent shell-string injection but do not stop
test code from writing files, starting processes, reading inherited credentials,
or accessing the network.

After implementation, the completed MCP spec should receive a short historical
note pointing to this approved superseding policy; its checked checkpoint record
must otherwise remain intact.

## Verified Current Behavior

| Area | Current behavior | Evidence |
|---|---|---|
| Task envelopes | Agents validate only `id` and `message`; `message.parts.map()` can throw outside containment. | `packages/agents/devops/index.ts:179-180,260-265`; same route pattern in all five agents. |
| JSON errors | Agent `c.req.json()` failures produce HTTP 500. | Live E2E report B1. |
| Orchestrator IDs | Parent IDs use `task-${Date.now()}`; 100 concurrent requests produced only 32 unique IDs. | `apps/orchestrator/index.ts:439`; E2E report B3. |
| Agent IDs | A repeated ID overwrites task and pending-action maps. | `packages/agents/devops/index.ts:188-189,264`; E2E report B4. |
| Approval preview | DevOps stores exact tool/target/args, but Orchestrator copies only `input-required`. | `packages/agents/devops/index.ts:189-197`; `apps/orchestrator/index.ts:176-188`. |
| Reject | DevOps/Documentation can manufacture a rejected task; Orchestrator can reject terminal tasks. | `packages/agents/devops/index.ts:288-292`; `packages/agents/documentation/index.ts:344-347`; `apps/orchestrator/index.ts:556-577`. |
| MCP recovery | `Unknown MCP session` is not considered reconnectable; readiness reflects a cached client object. | `packages/agents/devops/mcp-client.ts:83-89,193`; `packages/mcp/http.ts:28-32`. |
| MCP shutdown | Closing DevOps does not explicitly DELETE its HTTP session, and an in-flight connection can outlive `stop()`. | `packages/agents/devops/mcp-client.ts:74-80,119-145`. |
| Test execution | Testing invokes fixed `Bun.spawn()` autonomously and spreads the complete parent environment. | `packages/agents/testing/index.ts:98-154,160-175,187-193`; E2E report B5. |

## Proposed Review Decisions

Approval of this spec means approval of the recommended decisions below unless
Yusuf explicitly changes one before implementation.

### Decision 1 — Test execution policy

**Recommended: `run-tests` and `check-coverage` become Tier 1 whenever a process
will execute.**

- Target/runner detection may remain autonomous.
- A no-runner result may complete autonomously because no command executes.
- If a supported runner exists, the task must enter `input-required` before
  `Bun.spawn()`.
- The preview must warn that approved test code runs with the current OS user's
  permissions and may mutate files, start child processes, or use the network.

A future autonomous policy requires a separately reviewed isolation design. A
credible Windows-compatible filesystem/process/network sandbox is outside this
checkpoint.

### Decision 2 — Approval binding

**Recommended: use a structured approval preview plus an opaque random
`actionId`, bound to immutable server-side pending parameters.**

Task ID alone is not an approval token. Direct dashboards and Orchestrator must
send the matching `actionId`; missing, stale, or mismatched IDs cannot execute.

A cryptographic digest is not required in this checkpoint. Duplicate task-ID
rejection, a random action ID, immutable pending parameters, and exact preview
propagation provide the required binding without introducing canonical-JSON
cryptography. A digest can be added later if approvals cross an untrusted or
remote boundary.

### Decision 3 — Duplicate policy

**Recommended: reject every already-known agent task ID with HTTP 409, whether
the existing task is active or terminal.**

Task IDs remain reserved for the lifetime of the in-memory process. Replays do
not overwrite or restart tasks.

### Decision 4 — MCP retry safety

**Recommended: retry exactly once only after a definitive stale-session rejection.**

`404 / -32001 Unknown MCP session` is generated before tool dispatch, so the
same call may safely reconnect and retry once. A timeout or generic network
failure has an ambiguous execution outcome; write calls must never be replayed
automatically in that case.

### Decision 5 — Direct MCP bypass

**Recommended: explicitly accept it as a loopback-only demo risk in this
checkpoint.**

Server-side MCP authorization, capability grants, approval enforcement, and
audit for arbitrary local clients require a separate boundary-hardening spec.
This checkpoint must not claim that MCP itself enforces approval.

### Decision 6 — Checkpoint boundary

**Recommended: implement B1-B5 plus informed approval and strict approve/reject
transitions now; defer unrelated H3-H7 and parsing/tool gaps.**

## In Scope

1. Shared task-envelope parsing and complete request validation for all five agents.
2. Controlled malformed-JSON handling for all five agents and Orchestrator.
3. Containment of unexpected background task-processor rejections.
4. Collision-resistant Orchestrator parent and child task IDs.
5. Duplicate task-ID rejection in every agent.
6. Strict approve/reject transition validation in DevOps, Documentation,
   Testing, and Orchestrator.
7. One structured informed-approval contract used end to end.
8. Tier 1 approval for Testing process execution.
9. Fixed test argv, bounded execution/output, sanitized environment, and audit metadata.
10. MCP stale-session detection, truthful readiness, bounded reconnect, safe retry,
    stop-during-connect handling, and graceful session termination.
11. Reproducible automated and live regression coverage for the demonstrated exploits.
12. Updates to the affected Agent Cards, dashboards, README, CLAUDE, completed
    MCP-spec cross-reference, and worklog after implementation verification.

## Out of Scope

- MCP server-side authentication, capabilities, approval, or direct-client audit.
- TTL/reaping for sessions left by crashed or forcibly killed MCP clients.
- A container, VM, Windows Job Object, filesystem, or network sandbox for tests.
- Guaranteed cleanup of all descendant processes or rollback of files created by approved tests.
- New MCP clients or tools for Testing, Documentation, or Security.
- Agent heartbeat/offline registry state.
- Direct routing coverage for Testing, Documentation, Security, or Compose.
- Parent-plan aggregate execution status.
- Compose implementation or Agent Card repair.
- Keyword/path parsing repairs, including `ci` in a directory name, case-sensitive
  runtimes, natural-language prepositions, and Documentation output paths with spaces.
- Git/process failure-semantics redesign.
- Security scanner extension coverage.
- Persistence, authentication, official A2A migration, supervisor/CLI, OpenTUI,
  deployment, or durable audit storage.

These deferred items should become separate orchestration-correctness and
MCP-boundary-hardening specifications after the demo blockers are stable.

## Shared Task-Envelope Contract

Create one small shared runtime parser/type guard; do not add a new validation
dependency solely for this checkpoint.

Agents must continue accepting both currently supported forms:

```json
{
  "id": "task-id",
  "message": {
    "role": "user",
    "parts": [{ "text": "analyze project" }]
  }
}
```

```json
{
  "params": {
    "id": "task-id",
    "message": {
      "role": "agent",
      "parts": [{ "text": "scan for secrets" }]
    }
  }
}
```

Validation requirements:

- the envelope, optional `params`, task, message, and every part are plain objects;
- `id` is a non-empty string, maximum 128 characters, matching
  `[A-Za-z0-9][A-Za-z0-9._:-]*` so it cannot inject a URL path segment;
- `message.role` is exactly `user` or `agent`;
- `message.parts` is a non-empty array;
- every `part.text` is a string;
- the joined text contains at least one non-whitespace character;
- total UTF-8 task text is at most 64 KiB;
- invalid input is rejected before `tasks.set()` or any background work;
- malformed JSON and invalid shape return HTTP 400 without echoing raw input;
- a rejected request must not reserve an ID or change task count.

Orchestrator's public submission remains `{ "text": "..." }`. It must apply
the same non-empty and 64-KiB text bounds and return HTTP 400 for malformed JSON
or invalid shape.

Accepted asynchronous tasks must be launched with explicit rejection
containment. Any unexpected `processTask()` rejection must transition the
already-accepted task to `failed`; it must not remain `submitted`, become an
unhandled rejection, or terminate the process.

## Collision-Resistant Identity

- Use Node `crypto.randomUUID()`, which is already used in the repository.
- Parent Orchestrator IDs use a stable readable prefix plus UUID.
- Planned child IDs use a separate readable prefix plus UUID; step order remains
  task metadata, not an identity source.
- Direct Security A2A child IDs use their own readable UUID rather than embedding
  an arbitrarily long parent ID; parent/child correlation remains explicit audit/task metadata.
- Allocation must check the map and retry if an injected/test UUID collides.
- `agentTaskId = orch-${taskId}` may remain deterministic after the unique task
  ID has been allocated.
- No producer-generated ID may depend only on wall-clock precision.
- Dashboards, URL construction, audit events, A2A correlation, and parent/child
  relationships must support the longer IDs.

Every agent must check `tasks.has(id)` before storing a submitted task. An
already-known ID returns HTTP 409 and cannot alter task status, result, approval
preview, pending action, or filesystem state.

Orchestrator must check downstream `response.ok`. An agent's 400/409 response
must become a clear failed Orchestrator task rather than remaining assigned or
starting an SSE watcher for a task the agent rejected.

## Structured Informed Approval Contract

Approval data must stop overloading the terminal `result` field.

Proposed shared public shape:

```ts
interface ApprovalPreview {
  actionId: string
  kind: "mcp-tool" | "file-write" | "command"
  summary: string
  target: string
  toolName?: string
  parameters?: Record<string, unknown>
  executable?: string
  argv?: string[]
  cwd?: string
  timeoutMs?: number
  overwrite?: boolean
  risks: string[]
}
```

Agent `TaskResult` and `OrchestratorTask` must both expose:

```ts
approval?: ApprovalPreview
```

`GET /tasks/:id` and task SSE frames carry this field. While a task is
`input-required`, approval information is present only in `approval`; `result`
is absent and remains reserved for terminal task output.

Rules:

- `actionId` is a new random UUID created with the immutable pending action;
- `actionId` is a stale-action/correlation guard, not a secret, authorization
  token, or proof of human identity;
- the preview contains sanitized values only and never secrets, environment
  values, generated file contents, or raw source/test output;
- the owning agent stores exact executable/tool arguments, cwd/target, timeout,
  and output destinations in a private pending-action record;
- no client-supplied approval field may replace stored parameters;
- the public preview and private pending action share the same `actionId`;
- `result` is reserved for completed task output;
- Orchestrator copies the full preview on `input-required`, displays it, and
  forwards only the matching action ID;
- direct agent dashboards display the same preview fields;
- an approval preview may remain on terminal history, but no pending action may;
- approval details are HTML-escaped in every dashboard.

HTML escaping in this checkpoint applies to the new approval fields and touched
approval renderers. It does not authorize a general dashboard/XSS rewrite.

Approve request:

```http
POST /tasks/:id/approve
Content-Type: application/json

{"actionId":"<uuid>"}
```

Reject request:

```http
POST /tasks/:id/reject
Content-Type: application/json

{"actionId":"<uuid>"}
```

Extra request fields must never influence execution. A missing/non-string
`actionId` returns HTTP 400. A stale or mismatched action ID returns HTTP 409.

This is an intentional breaking change to the prototype approval endpoints.
All repository dashboards and Orchestrator forwarding must be updated in the
same work unit; no compatibility mode may silently approve without an action ID.

## Strict Task-State Transitions

Permitted flows:

```text
submitted -> working -> completed
submitted -> working -> failed
submitted -> working -> input-required -> working -> completed
submitted -> working -> input-required -> working -> failed
submitted -> working -> input-required -> failed (human rejection)
```

HTTP behavior:

| Condition | Response | State effect |
|---|---|---|
| Unknown task on approve/reject | 404 | None |
| Duplicate task submission | 409 | None |
| Missing/malformed action ID | 400 | None |
| Wrong action ID | 409 | None |
| Approve/reject outside `input-required` | 409 | None |
| First valid approval | 200 `working` | Atomically consumes pending action, then executes once. |
| First valid rejection | 200 `failed` | Consumes pending action; no execution. |
| Repeated approval/rejection | 409 | Terminal/current state and result remain unchanged. |

Before awaiting any tool or subprocess, valid approval must atomically:

1. verify task status, action ID, and pending action;
2. remove/consume the pending action;
3. transition the task to `working`; and
4. execute only the previously stored action.

Unknown rejection must never create or reserve a task. Terminal results and
errors are immutable under later approve/reject requests.

This contract applies to existing DevOps and Documentation write approvals and
the new Testing command approval. Planning and Security remain non-writing and
need no approval endpoint.

## Testing Execution Safety

Runner detection and fixed command construction remain internal Testing logic.
No new MCP tool is introduced here.

Allowed process shapes remain fixed and cannot be extended by task text:

```text
bun ["test"]
bun ["test", "--coverage"]
python ["-m", "pytest"]
python ["-m", "pytest", "--cov"]
```

Requirements:

- do not execute `package.json` command strings, user-provided executable text,
  shell syntax, extra flags, or arbitrary arguments;
- use argument-array execution with no shell;
- resolve and validate the target before approval;
- if no supported runner is detected, complete autonomously with
  `No tests configured` and create no approval;
- if a process will run, create an immutable command pending action and enter
  `input-required` before `Bun.spawn()`;
- preview exact normalized cwd, executable, argv, fixed timeout, and risks;
- use a fixed 120-second execution timeout for this checkpoint;
- on timeout, terminate the owned process best-effort, mark the task failed, and
  emit timeout audit metadata;
- bound combined stdout/stderr to 64 KiB UTF-8 with an explicit truncation marker;
- pass a minimal cross-platform environment allowlist required for executable
  lookup and temporary/user directories; do not spread all `process.env`;
- explicitly exclude `ORCHESTRAI_*` and secret/token/password/credential values;
- emit metadata-only command audit information: timestamp, caller, task/action
  IDs, executable, argv, cwd, outcome, duration, byte count, and truncation;
- never log environment values or raw test output in the audit event;
- a started runner that reports failing tests remains a completed action result
  with nonzero failure counts;
- runner startup failure or timeout is task `failed`.

Approval does not make test code safe. The preview must state that there is no
sandbox or rollback and that approved tests can still change project/user state.

## MCP Client Lifecycle and Recovery

Use the installed SDK's typed APIs rather than relying only on error-message regex:

- `StreamableHTTPError.code` identifies HTTP transport status;
- `Client.ping()` supports bounded liveness probing; and
- `StreamableHTTPClientTransport.terminateSession()` explicitly sends session DELETE.

### Stale-session handling

When a call receives `StreamableHTTPError` code 404 containing the server's
`Unknown MCP session` response:

1. immediately mark the captured client disconnected/unready;
2. discard that client/transport using captured-client identity guards;
3. reconnect within the existing bounded task window;
4. rediscover and revalidate required tools;
5. retry the identical tool name and structured arguments once; and
6. never perform a second retry for the same logical call.

This retry is allowed for read and write tools because the server rejects the
unknown session before dispatch. The retry reason/attempt count must remain
visible in metadata-only audit/debug output.

### Ambiguous transport failure

For timeout, connection reset, or generic network failure after dispatch may
have begun:

- invalidate the captured client and start background reconnect;
- fail the current task clearly;
- do not automatically replay a write;
- do not claim the write did or did not happen when the outcome is unknowable;
- require a fresh task and fresh approval before a human chooses to retry a write.

### Truthful readiness

DevOps `/healthz` must use a short bounded MCP ping rather than only checking
whether a client object exists.

- a successful recent/on-demand ping may report `ready: true`;
- ping failure invalidates only the same captured client, starts reconnect, and
  returns `ready: false`;
- an older overlapping ping/call cannot tear down a newer replacement client;
- health probing must not wait through the full task reconnect window.

### Stop and graceful cleanup

- an in-flight `connectOnce()` must check a lifecycle generation/token and
  `shouldRun` before publishing its client;
- `stop()` prevents a late connection from resurrecting state;
- when a live HTTP transport exists, `stop()` attempts bounded
  `terminateSession()` before local client close;
- graceful restart must return MCP session count to baseline;
- cleanup left by process crash/forced kill remains the explicitly deferred TTL problem.

## Required Automated Verification

The regression suite must be checked in and runnable through the root
`bun test`. Manual-only evidence is not sufficient for the demonstrated blockers.

### Parser and crash containment

- valid direct and `params` task envelopes parse identically;
- null, arrays, missing objects, invalid IDs/roles/parts/text, blank text, and
  oversized text return controlled validation failures;
- malformed JSON and malformed `message.parts` return HTTP 400 for all agents;
- invalid requests do not change task count;
- every affected health endpoint remains responsive after negative requests;
- a forced post-accept processor rejection becomes task `failed` without an
  unhandled rejection or process exit.

### IDs and state

- an injected UUID collision retries rather than overwriting;
- 100 concurrent Orchestrator submissions produce 100 unique task IDs,
  agent-task IDs, and records;
- concurrent planned children remain unique and reference the correct parent;
- duplicate agent submissions have exactly one winner and one HTTP 409;
- duplicates against working, pending, completed, failed, or rejected tasks
  leave the first task byte-for-byte unchanged;
- unknown reject returns 404 and does not reserve the ID;
- approve/reject wrong-state, missing action, stale action, and double-action
  cases return the specified 400/409 without execution or state corruption.

### Informed approval

- direct agent and Orchestrator task JSON show the same approval preview and action ID;
- both dashboards visibly show action, target, sanitized parameters, and risks;
- malicious extra approval fields cannot change the stored tool, command, args,
  cwd, output path, port, runtime, or content;
- a stale Orchestrator page cannot approve a replacement or lost action;
- a valid approval executes exactly once;
- rejection executes nothing and preserves existing files/results.

### Testing

- a mutating test fixture reaches `input-required` and creates no marker before approval;
- valid approval runs once and may create the marker only afterward;
- rejection creates no marker and starts no process;
- a no-runner project completes autonomously;
- coverage uses only the fixed approved argv;
- command-injection text cannot change executable or argv;
- a seeded secret environment variable is unavailable to the test and absent from logs;
- timeout terminates the owned runner best-effort, returns failed, and emits timeout metadata;
- large output is bounded and marked; audit contains no raw output;
- failing tests after approval remain a completed action with failure counts.

### MCP lifecycle

- connect, call, stop/restart MCP on the same URL, and verify readiness turns
  false then reconnects without restarting DevOps;
- the first post-restart logical tool call succeeds after exactly one definitive
  stale-session reconnect/retry;
- two repeated user tasks are not required for recovery;
- generic timeout/network failure on a write is never replayed automatically;
- MCP tool `isError` application results do not cause reconnect churn;
- an old ping/call cannot invalidate a newly connected client;
- stop during connection cannot publish a late client;
- graceful stop sends session termination and does not increase session count.

### Regression and live E2E

- all existing 19 tests remain green;
- full `bun run dev` health/discovery remains green;
- representative MCP analysis, direct Security A2A, approved DevOps write,
  rejected write, Documentation approval, and SSE paths remain green;
- the full stack survives the complete invalid-input matrix;
- disposable fixtures are used for every write/mutating-test scenario and are cleaned up.

## Checkpoint Acceptance Criteria

- [x] Yusuf explicitly approved this spec and its six review decisions (plus Additions 1–2).
- [x] All five agents share complete task-envelope validation (`packages/shared/task-envelope.ts`).
- [x] Malformed input cannot create a task, produce HTTP 500, or terminate a process — verified live (malformed `message.parts` returns 400, full stack stays up).
- [x] Every accepted background processor failure is contained as task `failed` (`processTask(...).catch(...)` at every agent's `POST /` route).
- [x] Orchestrator parent/child IDs are collision-resistant (`crypto.randomUUID()` via `packages/shared/ids.ts`).
- [x] Every agent rejects duplicate IDs without mutation — verified live (duplicate DevOps task ID returns 409).
- [x] Approve/reject follow the strict state and HTTP contract — verified live (wrong actionId 409, missing actionId 400, double-reject 409, unknown task 404).
- [x] Structured action previews are identical through direct and Orchestrator paths (`ApprovalPreview` copied verbatim in `applyAgentUpdate`; Orchestrator dashboard renders it).
- [x] Missing/stale/mismatched action IDs cannot execute — verified live.
- [x] Testing commands require approval and never spawn before it — verified live (`run-tests` reaches `input-required`; a mutating fixture created no marker until approved).
- [x] Testing uses fixed argv, timeout, bounded output, sanitized environment, and metadata audit (`RUNNER_ARGV`, `FIXED_TIMEOUT_MS`, `OUTPUT_MAX_BYTES`, `ENV_ALLOWLIST_KEYS`, `command-execution` audit kind).
- [x] MCP stale sessions make readiness false, reconnect, and recover in one logical call (`isStaleSessionError`/retry-once in `mcp-client.ts`; ping-based `/healthz` verified live after a real MCP kill/restart).
- [x] Ambiguous failed writes are not automatically replayed (only 404/-32001 stale-session errors retry once; timeout/network errors are not retried).
- [x] Stop/connect races and graceful HTTP session cleanup are covered (`generation` token guard + bounded `terminateSession()` in `stop()`; unit-tested indirectly via the existing MCP factory tests, live-tested via kill/restart).
- [x] Required automated regression tests are checked in and pass (`bun test`: 49 pass, 0 fail, 86 expectations, 7 files).
- [x] Existing MCP/A2A/approval happy paths do not regress — verified live (`analyze-project` combined DevOps+Security result, `dockerize` approve→write, `git-status`, `run-tests` approve/reject, post-reconnect tool call all passed).
- [ ] Documentation and worklog accurately describe the final verified behavior — intentionally deferred: Yusuf asked that `README.md`/`CLAUDE.md`/`context/worklog.md` be updated only after he confirms the verification results below.

## Implementation Order After Approval

1. Add shared request parsing, collision-resistant ID allocation, approval types,
   and focused pure tests.
2. Apply validation/duplicate rejection to all agents and Orchestrator; contain
   background processor failures.
3. Enforce strict approval transitions and propagate structured previews through
   DevOps, Documentation, Orchestrator, and dashboards.
4. Add Testing approval, execution bounds, environment policy, and audit using
   the approved shared contract.
5. Implement and test MCP lifecycle/readiness recovery independently.
6. Run the complete automated and adversarial live matrix.
7. Update affected documentation and append exact verified results to the worklog.

Steps 2 and 5 may be implemented in parallel only after the shared contracts in
step 1 are fixed and this spec is approved.

## Rollback and Failure Policy

- Keep changes separated by the implementation order above so a lifecycle fix
  can be reverted without reverting request validation.
- Never restore approval-free test execution as a quick rollback; disable the
  action or require direct approval instead.
- If MCP recovery cannot prove safe write retry semantics, retain fail-closed
  behavior and mark the relevant acceptance criterion unverified.
- Do not mark this checkpoint complete while any blocker reproduction still passes.

## Review Request

Before implementation, Yusuf should explicitly answer either:

```text
Approved specs/006-runtime-stabilization/spec.md with all six recommended decisions.
```

or list the decision numbers to change. No runtime implementation is authorized
by discussion of the E2E report alone.
