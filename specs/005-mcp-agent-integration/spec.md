---
id: 005-mcp-agent-integration
title: MCP Agent Integration and Direct A2A Checkpoint
area: agent-integration
change_type: feature
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
  - 011-remaining-agents-mcp
  - 006-runtime-stabilization
---

# Spec: MCP Agent Integration and Direct A2A Checkpoint

> Status: **IMPLEMENTED AND VERIFIED on 2026-08-08.**
>
> This document defines the hybrid target architecture and a deliberately
> limited two-day implementation checkpoint. Implementation must remain within
> the approved checkpoint scope and acceptance criteria below.

## Purpose

Evolve OrchestrAI from a prototype where operational agents execute all tools
directly into a hybrid agent runtime where:

- agents keep internal domain reasoning and deterministic decision logic;
- shared, reusable, privileged, or side-effecting capabilities may be exposed
  as MCP tools;
- agents communicate with other agents using A2A, never MCP;
- human approval is based on the action's effect, not merely which agent
  requested it;
- autonomous reads and A2A calls remain observable, attributable, and bounded.

This is **not** a requirement that every agent action or every helper function
must use MCP.

## Current Implementation

The current repository has:

- one standalone MCP server in `packages/mcp/index.ts` using
  `StdioServerTransport`;
- no MCP client initialization inside Planning, DevOps, Testing,
  Documentation, or Security;
- DevOps file generation through `fs/promises.writeFile()` and Git inspection
  through `Bun.spawn()`;
- Testing command execution through `Bun.spawn()`;
- Documentation and Security access through Node filesystem APIs;
- Orchestrator-to-agent task routing over the project's custom A2A-style HTTP
  contract;
- no backend agent-to-agent HTTP call; dashboard `fetch()` calls are
  browser-to-that-same-agent calls.

The standalone MCP server is currently an integration surface for external MCP
clients. It is not part of the A2A execution path.

## Verified SDK Transport Constraint

This question is resolved before implementation against the installed package,
not deferred to Day 1:

- `bun.lock:67` pins the resolved package to
  `@modelcontextprotocol/sdk@1.30.0`.
- In that installed version, `McpServer.connect()` delegates to its single
  underlying `Server` (`dist/esm/server/mcp.js:43-48`).
- The underlying protocol stores one `_transport` and throws when `connect()`
  is called while already connected: "Already connected to a transport ... use
  a separate Protocol instance per connection"
  (`dist/esm/shared/protocol.js:210-219`).
- The installed SDK's stateful Streamable HTTP example creates a new
  `McpServer` for each new transport/session
  (`dist/esm/examples/server/simpleStreamableHttp.js:19-30, 582-606`).

Therefore **one `McpServer` instance cannot safely serve stdio and HTTP at the
same time**. The checkpoint design is:

1. Extract a shared `createMcpServer()`/tool-registration factory.
2. Keep the existing stdio entrypoint in its own process and give it its own
   `McpServer` instance.
3. Add an HTTP entrypoint in a separate process, with its own server/transport
   lifecycle, using the same factory and tool definitions.
4. Never share a live `McpServer`, `Server`, or transport object between those
   entrypoints.

This is one **logical tool service** with two compatibility entrypoints, not one
in-memory server object and not duplicated tool implementations.

## Architectural Principles

### MCP and A2A solve different problems

```text
Agent -> internal function or MCP tool = capability execution
Agent -> another agent                = A2A communication
```

An MCP call must not be used to disguise agent delegation, and an A2A call
must not bypass tool approval policy.

### Hybrid tool ownership

Internal tools remain appropriate for:

- LLM reasoning;
- deterministic parsing and classification;
- domain-specific decision logic;
- transforming already-authorized data in memory;
- formatting results.

MCP tools are preferred for:

- shared capabilities used by multiple agents;
- filesystem access across a target project;
- Git and Docker operations;
- process execution;
- reusable privileged operations;
- operations needing a centralized validation and audit boundary.

## Target Architecture

```text
Human / UI
    |
    v
Orchestrator
    |  discovery, top-level routing, task visibility, governance
    |
    +---------------- A2A ----------------+
    |                                     |
    v                                     v
Planning Agent                        Operational Agents
(internal only)              DevOps / Testing / Docs / Security
                                          |
                              internal domain reasoning
                                          |
                                     MCP clients
                                          |
                                          v
                               Shared logical MCP server
                                          |
                         filesystem / Git / Docker / process tools

Operational Agent <----------- direct A2A -----------> Operational Agent
```

The target is one **logical** MCP service/tool catalog, not a separate tool
implementation inside each agent. Each participating agent owns its own MCP
client/session. Transport compatibility may require multiple server instances
or processes created from the same tool-registration factory, as established in
the verified SDK constraint above.

## Human-in-the-loop vs Human-out-of-the-loop Policy

This policy applies across **all agents**, including future agents.

### Tier 1: Human approval required

The MCP tool call must not fire until the owning task reaches
`input-required` and a human approves it.

This tier includes:

- file creation, modification, overwrite, rename, or deletion;
- `git add`, `git commit`, push, reset, checkout that changes files, or similar
  repository state changes;
- `docker build`, container creation/start/stop/removal, image removal, or other
  Docker state changes;
- deployment, release, secret update, infrastructure mutation, or remote API
  mutation;
- arbitrary or general-purpose command execution;
- any irreversible or materially state-changing action.

Use the DevOps Agent's existing `input-required -> approve -> resumeTask`
state transition. Extend that pattern; do not introduce a second approval
mechanism for MCP.

Approval requirements:

1. Resolve and validate parameters before presenting approval when possible.
2. Display the tool name, target project/destination, and sanitized parameters.
3. Do not create the MCP request before approval.
4. On approval, perform exactly the displayed action; changed parameters need
   a new approval.
5. Rejection must leave the tool uncalled.

### Tier 2: Autonomous, no approval popup

Read-only actions run without human approval:

- `git_status`;
- `git_diff`;
- `docker_status`;
- `analyze_project`;
- safe project-file reads;
- dependency/configuration inspection;
- security scans that do not mutate the project.

They still require path validation, caller attribution, sanitized audit logs,
timeouts, and bounded result sizes.

### Tier 3: Agent-to-agent calls, no approval popup

An A2A request from one agent to another runs autonomously. Communication
itself is not a privileged side effect.

Example:

```text
DevOps Agent --A2A--> Security Agent: scan this target project
```

If the receiving agent subsequently wants to execute a Tier 1 action, that
action pauses for approval. The original A2A call does not grant approval and
cannot carry an implicit approval token.

### Mandatory audit and timeout policy

Every autonomous read and every A2A call must be logged. "No approval" never
means "no audit trail."

Minimum structured audit event:

```json
{
  "timestamp": "ISO-8601 UTC",
  "kind": "mcp-tool-call | a2a-call",
  "caller": "devops-agent",
  "target": "tool-name | security-agent",
  "taskId": "parent-or-agent-task-id",
  "params": "sanitized structured parameters",
  "outcome": "completed | failed | timeout",
  "durationMs": 123,
  "resultSummary": "metadata only; maximum 512 UTF-8 bytes",
  "resultBytes": 1234,
  "resultTruncated": false
}
```

Checkpoint logging may use structured JSON on stdout so it is visible in the
existing process logs. Persistent audit storage is target state, not required
for this checkpoint.

Rules:

- never log file contents, credentials, tokens, environment contents, or raw
  suspected secrets;
- for this checkpoint, do not copy `git_status`, `git_diff`, project-analysis,
  or Security scan output into `resultSummary`; record only outcome metadata,
  counts where safely available, byte length, and whether the result was
  truncated;
- `resultSummary` is limited to 512 UTF-8 bytes and must be truncated before
  the audit event is emitted;
- tool/A2A payloads returned to the owning task are limited to 64 KiB UTF-8;
  larger results must be truncated with an explicit marker rather than stored
  in full;
- record failures and timeouts as well as successes;
- MCP client calls and A2A HTTP requests must use explicit timeouts;
- timeout or audit failure must never silently turn into a Tier 1 action.

This metadata-only checkpoint policy prevents raw diffs from becoming audit-log
secret leaks. Content-aware secret redaction rules remain part of next week's
Security MCP/tooling spec and are not a reason to log raw content now.

## `run_tests` Classification Exception Requiring Review

The general policy above classifies arbitrary command execution as Tier 1.
The requested target state classifies `run_tests` as autonomous because it is
verification-oriented and must not accept an arbitrary command.

This draft proposes the following **narrow Tier 2 exception**:

- `run_tests` may run without approval only when the server selects a command
  from a fixed allowlist and constructs a static argv array;
- the agent cannot supply executable text, shell syntax, extra flags, or a raw
  command string;
- the target project path is validated;
- execution is timeout-bounded, resource-bounded where practical, and audited;
- `shell` is false;
- if the project declares an unsupported/custom test command, the tool reports
  it as unsupported instead of executing it;
- the tool must document that tests can still create caches or fixtures and
  are not mathematically guaranteed to be side-effect-free.

Proposed initial allowed argv values:

```text
["bun", "test"]
["npm", "test"]
["python", "-m", "pytest"]
```

No implementation of `run_tests` is allowed in this checkpoint. Yusuf/team
lead must explicitly approve this exception in the next revision. If it is not
approved, `run_tests` moves to Tier 1.

## Target-state Agent and Tool Split

This section defines the destination for review. It is not the implementation
scope of the two-day checkpoint.

### Planning Agent

Internal:

- request decomposition;
- plan construction;
- agent/skill selection;
- interpretation of task results.

MCP:

- none required in the current target state.

### DevOps Agent

Internal:

- application-type and port detection;
- Dockerfile/CI content decisions;
- DevOps recommendations;
- interpreting Git/Docker results.

MCP:

- write Dockerfile: existing `create_dockerfile`;
- Docker build: existing `docker_build`;
- Git operations: existing `git_status`, `git_diff`, `git_commit`;
- CI, Compose, and `.gitignore` generation: existing generation tools;
- project analysis: existing `analyze_project`.

### Testing Agent

Internal:

- test-runner detection;
- result parsing and interpretation;
- pass/fail/coverage presentation.

MCP:

- execute a supported test runner: proposed new `run_tests` tool.

### Documentation Agent

Internal:

- documentation structure and content generation;
- API-route interpretation;
- formatting Markdown output.

MCP:

- read source/project files: proposed `read_project_file`;
- write approved documentation: proposed `write_project_file`.

### Security Agent

Internal:

- scanning rules;
- severity classification;
- interpreting findings and producing recommendations.

MCP:

- path-restricted project access through proposed `read_project_file` or a
  narrower read-only project traversal tool.

## New MCP Tool Security Contracts — Target State Only

These tools are specified now for architectural review but are explicitly not
implemented in the two-day checkpoint.

### `run_tests`

Classification: proposed Tier 2 exception, subject to explicit approval.

Requirements:

- must not accept `command`, `script`, `args`, or any free-text executable
  field from the agent;
- must select only a fixed pre-approved argv based on validated project
  metadata;
- must use `execFile()` or equivalent argument-array execution with
  `shell: false`;
- must reject unsupported test scripts rather than interpreting them;
- must validate the target path;
- must enforce a timeout and bounded output;
- must return test failure as a valid tool result, distinct from transport or
  execution-start failure;
- must emit the mandatory audit event without logging sensitive output.

### `read_project_file`

Classification: Tier 2 read-only.

Proposed input:

```json
{
  "project_root": "absolute configured project root",
  "relative_path": "path relative to project_root"
}
```

Requirements:

- reject an absolute `relative_path`;
- resolve/canonicalize both root and requested path;
- reject `..`, symlink, junction, case-normalization, or prefix-confusion
  escapes outside the canonical project root;
- reject directories when a file is required;
- restrict reads to a documented maximum size;
- reject binary/unsupported file types unless explicitly allowed;
- deny `.env`, `.env.*`, credentials, private keys, token files, cloud
  credentials, and common secret-bearing filenames by default;
- an allowlist exception must be explicit, narrow, auditable, and must never
  print the secret value to logs;
- log only metadata and a bounded result summary, never file contents.

### `write_project_file`

Classification: Tier 1 write.

Requirements:

- apply the same canonical root-containment protections as
  `read_project_file`;
- require human approval before the MCP call;
- display destination and overwrite status before approval;
- reject writes to sensitive configuration/credential paths unless a future
  spec explicitly permits them;
- use deterministic content and size limits;
- use recoverable/atomic replacement where practical;
- audit sanitized metadata, never full generated content when it may contain
  secrets.

## Two-day Checkpoint Scope

Only the following implementation is proposed for this checkpoint.

### 1. MCP server HTTP transport

- Refactor tool registration into one shared server factory without changing
  the existing tool behavior.
- Add a real SDK Streamable HTTP MCP entrypoint in a separate process using its
  own `McpServer` instance from that factory.
- Proposed endpoint: `http://localhost:3006/mcp`.
- Proposed health endpoint: `http://localhost:3006/healthz`.
- Proposed client configuration: inherited `ORCHESTRAI_MCP_URL`, defaulting to
  the local endpoint above for the demo.
- Preserve the existing tool schemas and behavior for this checkpoint except
  for changes strictly required for transport, caller attribution, timeout,
  and audit logging.
- Preserve the existing stdio entrypoint in a separate process with a separate
  `McpServer` instance created by the same factory.
- Keep `bun run mcp` as the stdio compatibility command and add a distinct HTTP
  server command. The final script names must make the transport explicit.
- `dev:with-mcp` must start the HTTP service required by DevOps; if it also
  offers stdio compatibility, stdio must still be a separate child process.
- Never connect stdio and HTTP transports to the same `McpServer` instance.
- The HTTP service must fail clearly if its port is occupied.

Use the SDK's Streamable HTTP transport and follow its server-per-transport
lifecycle. The implementation must not invent a custom JSON endpoint and call
it MCP.

### 2. DevOps Agent as a real MCP client

- Create one MCP client/session owned by the DevOps Agent process.
- Connect it to the shared HTTP MCP server.
- Discover/load existing MCP tools instead of importing server internals.
- Map current DevOps skills to existing MCP tools:

| DevOps skill | Existing MCP tool | Approval |
|---|---|---|
| `analyze-project` | `analyze_project` | No |
| `git-status` | `git_status` | No |
| `dockerize` | `create_dockerfile` | Yes |
| `create-ci` | `create_github_action` | Yes |
| `create-gitignore` | `create_gitignore` | Yes |

- Preserve the existing DevOps approval state machine.
- For Tier 1 skills, call MCP only inside `resumeTask()` after approval.
- Remove/bypass the corresponding direct DevOps filesystem/process execution
  only after its MCP replacement passes acceptance tests.
- If MCP is unavailable, fail the task clearly; do not silently fall back to
  direct privileged execution.
- DevOps process startup must not fail permanently merely because MCP HTTP has
  not started yet. Connection uses bounded exponential backoff (proposed:
  250 ms, 500 ms, 1 s, 2 s, then 5 s maximum between attempts) and exposes MCP
  dependency state in DevOps health output.
- A task arriving while MCP is disconnected gets one bounded reconnect window;
  if connection is not restored, that task fails clearly and no direct-tool
  fallback runs.
- Shutdown must cancel pending retries and close the MCP client/transport.
- The existing `create-compose` mismatch is not repaired implicitly by this
  checkpoint; handle it only if separately approved.

### 3. One direct DevOps-to-Security A2A example

Use the existing A2A-style task contract, not MCP:

```text
POST http://localhost:3005/
GET  http://localhost:3005/tasks/:id
```

Checkpoint demonstration:

1. DevOps handles `analyze-project` through the MCP `analyze_project` tool.
2. DevOps directly submits a correlated `scan-secrets` task to Security Agent.
3. DevOps waits with a strict timeout and obtains the Security result.
4. DevOps returns a combined bounded result identifying both sources.
5. The Orchestrator does not forward the DevOps-to-Security HTTP call.

This behavior must not be a hidden side effect. In the same implementation
change, update the DevOps Agent Card description for `analyze-project` to state
that it includes a Security Agent secrets pre-check, and update any visible
skill/help text that describes the result. The combined result must label the
DevOps analysis and Security pre-check separately.

The A2A call is Tier 3 and needs no approval. Security's current scan remains
read-only. Both the outbound A2A call and the MCP read call must emit audit
events.

Proposed failure policy for the checkpoint:

- a Security timeout/unavailable response must be reported explicitly;
- it must not trigger a write or silently claim the scan passed;
- mark `analyze-project` completed-with-warning when the DevOps MCP analysis
  succeeds but Security times out or is unavailable; preserve the DevOps
  result, prominently identify the missing Security result, and never claim
  that the secrets scan passed.

## Explicitly Out of Scope for This Checkpoint

- Testing Agent MCP client integration.
- Documentation Agent MCP client integration.
- Security Agent MCP client integration.
- Implementing `run_tests`.
- Implementing `read_project_file`.
- Implementing `write_project_file`.
- Moving Security scanning filesystem access behind MCP.
- Moving Testing execution behind MCP.
- Moving Documentation read/write behavior behind MCP.
- Planning Agent MCP integration.
- Full official A2A SDK/spec migration.
- General agent-to-agent routing, arbitrary delegation, or multi-hop chains.
- Shared durable memory or a database.
- Persistent audit-log storage or an observability backend.
- Authentication, TLS, multi-user authorization, or remote MCP exposure.
- Cloud deployment.
- OpenTUI work.
- Refactoring unrelated templates, routing, or agent protocol types.

These items belong to next week's reviewed spec revision.

## Security and Reliability Requirements for the Checkpoint

- Bind the MCP HTTP server to loopback only by default.
- Never expose it on `0.0.0.0` without a future authentication/security spec.
- Validate all tool schemas server-side.
- Preserve `execFile()`/argument-array execution and `shell: false`.
- Do not add a generic shell/command MCP tool.
- Carry a sanitized caller identity such as `devops-agent` into audit events;
  this is attribution for the local demo, not strong authentication.
- Apply timeouts to MCP connection, MCP tool calls, A2A submission, and A2A
  result waiting.
- Bound tool/A2A result sizes before storing or returning them.
- Never include environment variables, tokens, or suspected secret values in
  logs or dashboard results.
- Approval cannot be inferred from an A2A caller or an MCP caller identity.

## Proposed Verification Plan

### Demo pre-flight

Before any judged/demo task:

1. Confirm ports `3000` through `3006` are owned by the expected services.
2. Confirm `http://localhost:3006/healthz` is green.
3. Confirm DevOps `/healthz` reports its MCP dependency connected/ready.
4. Confirm Security `/healthz` is green before demonstrating the combined
   `analyze-project` path.
5. Abort the write-action demo if MCP readiness is not green; never switch to
   direct execution as a workaround.

### Static verification

- Confirm DevOps imports and initializes an MCP client.
- Confirm the MCP server initializes the SDK HTTP transport.
- Confirm no custom fake-MCP JSON endpoint was substituted.
- Confirm DevOps direct `writeFile()` and Git `Bun.spawn()` paths are no longer
  used for the five mapped skills.
- Confirm Tier 1 MCP calls occur only in the approved resume path.
- Confirm Testing, Documentation, and Security MCP integration was not added.

### Runtime verification

1. Start MCP HTTP, Security, DevOps, and Orchestrator.
2. Verify MCP health and DevOps client readiness.
   - also start DevOps before MCP and verify it stays alive, retries, and
     becomes ready after MCP starts;
3. Run `analyze-project`:
   - no approval;
   - DevOps calls MCP `analyze_project`;
   - DevOps calls Security directly via A2A;
   - combined result returned;
   - both calls logged and timeout-bounded.
4. Run `git-status`:
   - no approval;
   - MCP tool used;
   - audit event emitted.
5. Run `dockerize` against a disposable project:
   - task reaches `input-required`;
   - no MCP write call and no file before approval;
   - approval displays the resolved target;
   - after approval, DevOps invokes `create_dockerfile` through MCP;
   - file appears only in the approved target.
6. Reject another write task:
   - no MCP call;
   - no file change.
7. Stop Security and repeat analysis:
   - timeout/unavailable state is explicit;
   - no false "scan passed" result;
   - no write occurs.
8. Stop MCP and submit a DevOps task:
   - clear failure;
   - no silent direct-execution fallback.
9. Inspect audit output from `git-status`, `analyze-project`, and A2A:
   - caller, sanitized params, timestamp, outcome, duration, and size metadata
     are present;
   - raw diff, file contents, scan findings, and suspected secrets are absent;
   - summaries and returned payloads obey their documented limits.

## Checkpoint Acceptance Criteria

- [x] Yusuf approved the spec after the team-lead review was incorporated.
- [x] The `run_tests` Tier 2 exception was approved for the future spec; it was not implemented in this checkpoint.
- [x] Security failure policy is completed-with-warning.
- [x] One shared logical MCP server exposes a real SDK HTTP MCP transport on loopback.
- [x] Stdio and HTTP use separate `McpServer` instances/process entrypoints created from one shared tool-registration factory.
- [x] DevOps owns a real MCP client/session and uses existing tools through MCP.
- [x] DevOps retries a late MCP dependency with bounded backoff and exposes readiness.
- [x] Read-only mapped DevOps calls run without approval and are audited.
- [x] Write mapped DevOps calls cannot reach MCP before human approval.
- [x] Rejection produces no MCP write call and no filesystem change.
- [x] DevOps performs one direct correlated A2A call to Security without Orchestrator forwarding.
- [x] A2A and autonomous MCP reads are logged with caller, sanitized params, timestamp, outcome, and duration.
- [x] MCP and A2A calls have explicit timeouts and bounded results.
- [x] MCP unavailable behavior fails closed with no direct privileged fallback.
- [x] Security unavailable behavior matches the approved failure policy.
- [x] `analyze-project` Agent Card/help text discloses the Security pre-check.
- [x] Demo pre-flight checks MCP and dependent-agent readiness.
- [x] Audit logs contain metadata only, with 512-byte summaries and 64-KiB task-result bounds.
- [x] Existing path-containment and approval behavior does not regress.
- [x] Testing, Documentation, and Security MCP integrations remain out of checkpoint scope.
- [x] Existing tests pass and focused MCP/A2A tests are added.
- [x] `README.md`, `CLAUDE.md`, and `context/worklog.md` were updated after implementation verification.

## Approved Review Resolutions

Yusuf approved implementation on 2026-08-08 with these resolutions:

1. Approve the narrow autonomous `run_tests` Tier 2 exception exactly as
   constrained above; it remains out of this checkpoint.
2. Use completed-with-warning when Security is unavailable after successful
   DevOps analysis.
3. Use loopback port `3006` and `ORCHESTRAI_MCP_URL`.
4. Keep stdio compatibility. The technical uncertainty is now resolved: stdio
   and HTTP run as separate processes/`McpServer` instances created from one
   shared tool-registration factory.
5. Attach the A2A example to `analyze-project` only with the required Agent Card
   and help-text disclosure.

No later target-state item is implied by this approval; the explicit out-of-scope
section remains binding.

## Implementation Result

Implemented files and boundaries:

- `packages/mcp/index.ts` is the shared `createMcpServer()` tool factory.
- `packages/mcp/stdio.ts` preserves stdio in its own process/server instance.
- `packages/mcp/http.ts` exposes loopback Streamable HTTP and `/healthz` on
  port `3006`, using one server instance per client session.
- DevOps owns the HTTP MCP client, discovers required tools, retries with
  bounded backoff, reports readiness, and fails closed.
- DevOps stores the displayed write-tool arguments before approval and invokes
  MCP only from the approved resume path.
- `analyze-project` directly submits and polls a correlated Security child task,
  combines labeled results, and completes with warning if Security is down.
- Structured audit events contain metadata only; result payloads are bounded.
- Testing, Documentation, Security MCP integration and all proposed new tools
  remain unimplemented as required by the scope.

Verification completed:

- `bun test`: 19 passed, 0 failed across target-path, result-bound, MCP factory,
  and direct-A2A tests.
- Bun bundle checks passed for MCP HTTP, MCP stdio, and DevOps entrypoints.
- A real stdio client connected and discovered all 10 existing tools.
- Live HTTP tests passed for late MCP startup/reconnection, read-only MCP calls,
  direct Security A2A, approved Dockerfile/CI/`.gitignore` writes, rejection with
  no write, Security-down warning behavior, and MCP-down fail-closed behavior.
- Final `bun run dev` pre-flight returned healthy responses on ports `3000`
  through `3006`; DevOps reported MCP `connected` and `ready: true`.
