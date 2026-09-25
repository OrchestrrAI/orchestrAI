---
id: 011-remaining-agents-mcp
title: Testing and Documentation Agents as MCP Clients
area: agent-integration
change_type: enhancement
status: implemented
verification: verified
created: 2026-08-08
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-08
implemented_on: 2026-08-08
amends:
  - 005-mcp-agent-integration
supersedes: []
superseded_by: []
related:
  - 002-documentation-agent
  - 005-mcp-agent-integration
  - 006-runtime-stabilization
  - 003-security-agent
  - 001-testing-agent
---

# Spec: Testing and Documentation Agents as MCP Clients

> Status history: **APPROVED by Yusuf on 2026-08-08 — Security Agent option (c):
> defer its MCP conversion entirely for this checkpoint; option (b) (a
> purpose-built `scan_project_secrets` tool) recorded as the natural next
> step if revisited later. IMPLEMENTED AND VERIFIED on 2026-08-08; see
> Verification Results below.**

## Purpose

DevOps is currently the only real MCP client; Testing, Documentation, and
Security still read/write files and spawn processes directly. This was
explicitly deferred, not abandoned, in the original MCP checkpoint. It is now
worth doing (unlike earlier this session, when we deliberately chose routing
fixes first): all three agents are reachable through the Orchestrator now,
so this conversion is finally visible, demoable work rather than invisible
internal refactoring.

## Verified Current Behavior

| Agent | Direct filesystem/process code | Evidence |
|---|---|---|
| Testing | `Bun.spawn(action.argv, ...)` inside `resumeTask()`, after Tier 1 approval | `packages/agents/testing/index.ts:235` |
| Documentation | `readFile`/`readdir`/`writeFile` (from `fs/promises`) throughout `skillGenerateReadme`/`skillDocumentApi` | `packages/agents/documentation/index.ts:4,84,96,157,172,232` |
| Security | `readFile`/`readdir` throughout `walkFiles`/`skillScanSecrets`/`skillCheckGitignoreCoverage`/`skillAuditDependencies` | `packages/agents/security/index.ts:4,70-104,166,228,266` |

DevOps's existing MCP client (`packages/agents/devops/mcp-client.ts`,
`class DevOpsMcpClient`) is DevOps-specific: hardcoded client name
(`"orchestrai-devops-agent"`), hardcoded required-tools set, lives only in
`packages/agents/devops/`. Three more agents becoming MCP clients must not
mean pasting this class three more times with the name changed.

`specs/005-mcp-agent-integration/spec.md`'s "Target-state Agent and Tool Split"
and "New MCP Tool Security Contracts" sections already drafted the shape of
`run_tests`, `read_project_file`, and `write_project_file` for exactly this
purpose — this spec finalizes and implements them, adjusted for one thing
that changed since that draft: **`run_tests` cannot be the autonomous Tier 2
exception that draft proposed.** `specs/006-runtime-stabilization/spec.md`
explicitly superseded that policy after live evidence showed fixed argv and
`shell: false` prevent shell-injection but not file mutation — Testing's
`run-tests`/`check-coverage` are Tier 1 today (approval required) and must
stay Tier 1 as an MCP tool too.

## Proposed Design

### 1. A shared MCP client factory, not four copies

Extract `DevOpsMcpClient`'s connection-lifecycle logic (bounded backoff,
stale-session retry-once, ping-based readiness, generation-token
stop/connect guard) into `packages/shared/mcp-client.ts`, parameterized by:

```ts
interface McpClientOptions {
  callerName: string       // e.g. "testing-agent" — becomes the audit "caller" and the SDK Client's declared name
  requiredTools: string[]  // per-agent tool allowlist, checked at connect time
}
```

Each agent (`devops`, `testing`, `documentation`, `security`) constructs its
own instance with its own name/tools; the connection-lifecycle code is
written once. `packages/agents/devops/mcp-client.ts` becomes a thin
re-export or is deleted in favor of the shared one — DevOps's existing
behavior must not change.

### 2. New MCP tools

#### `run_tests` — **Tier 1** (not the Tier 2 exception originally proposed)

```json
{
  "project_path": "absolute path",
  "with_coverage": false
}
```

- Selects only from the same fixed argv table Testing already uses
  internally (`bun test` / `bun test --coverage` / `python -m pytest` /
  `python -m pytest --cov`) — no `command`/`script`/`args` field accepted
  from the caller, ever.
- Same execution bounds already implemented in Testing Agent today: 120s
  timeout, 64 KiB bounded output, environment allowlist excluding
  `ORCHESTRAI_*` and other ambient variables, `execFile`-style argument-array
  execution with `shell: false`.
- Testing Agent's own approval flow is unchanged: it still resolves the
  runner, builds the `ApprovalPreview`, and reaches `input-required` exactly
  as it does today. The only thing that moves is what `resumeTask()` calls
  on approval — an MCP tool call instead of a direct `Bun.spawn()`.
- Returns a failing test suite as a valid tool result (not a tool error) —
  matches Testing's existing "a failing suite is still `completed`" rule.

#### `read_project_file` — Tier 2, read-only

```json
{
  "project_root": "absolute configured project root",
  "relative_path": "path relative to project_root"
}
```

- Rejects an absolute `relative_path`.
- Canonicalizes both root and requested path; rejects `..`, symlink, or
  prefix-confusion escapes outside the canonical root.
- Reads a directory's entries (name, type file/dir) when `relative_path`
  resolves to a directory, or file content when it resolves to a file — one
  tool covers both cases rather than requiring two separate calls for
  "is this a file or a directory" ambiguity that callers would otherwise
  have to resolve themselves first.
- Restricted to a documented maximum file size (proposed: 1 MiB — generous
  for source files, small enough to keep memory/audit bounds sane).
- Denies `.env`, `.env.*`, and common credential/key filenames
  (`*.pem`, `*.key`, `id_rsa*`, etc.) by default — returns a clear
  "denied: sensitive file" tool error, never the content.
- Logs only metadata (path, size, truncation) in the audit event, never file
  contents — matches the existing metadata-only audit policy.

#### `write_project_file` — Tier 1

```json
{
  "project_root": "absolute configured project root",
  "relative_path": "path relative to project_root",
  "content": "string",
  "overwrite": false
}
```

- Same canonical root-containment protections as `read_project_file`.
- Rejects writes to the same sensitive-filename patterns
  `read_project_file` denies reading, unless a future spec explicitly
  permits an exception.
- Requires approval before the MCP call — reuses the exact
  `ApprovalPreview`/`actionId` pattern already used by every other Tier 1
  action in this codebase; no new approval mechanism.
- `overwrite: false` (default) fails clearly if the target already exists,
  matching Documentation's existing "don't silently overwrite README.md"
  behavior; the caller must explicitly set `overwrite: true` after the
  approval preview has already disclosed that an overwrite will happen.

### 3. Review decision needed — Security Agent's conversion approach

Security's three skills all involve walking many files (`scan-secrets`
recursively scans the whole tree). Converting this to make one
`read_project_file`/directory-listing MCP call per file would work
architecturally, but adds one MCP round trip per file scanned — potentially
dozens of chatty calls for one scan, where today it's a single in-process
walk. Three options:

**(a) Chatty but architecturally consistent.** Security calls
`read_project_file` (list mode) recursively, then `read_project_file`
(content mode) per scannable file. Simple, fully consistent with the other
agents, but slower for large projects and generates one audit event per
file rather than one per scan.

**(b) One new purpose-built tool, `scan_project_secrets`.** The recursive
walk + pattern-matching logic moves server-side into MCP (still read-only,
still excludes `node_modules`/`.git`/`dist`/`build`, still redacts matched
values), and Security calls it once per scan. Matches the "or a narrower
read-only project traversal tool" alternative the original spec already
named. Faster, one audit event per scan, but is a 4th new MCP tool beyond
the three this spec was scoped around.

**(c) Defer Security's conversion entirely.** Security's three skills are
already Tier 2, already read-only, already working correctly and audited at
the agent level. Converting it doesn't unlock a new capability or fix a
known problem — it's conversion for architectural consistency alone. Leave
it as the one explicitly-documented exception, revisit only if there's a
concrete reason later.

This spec recommends **(c)** for this checkpoint, with **(b)** as the
natural next step if Security's conversion is wanted later — recommending
against (a) specifically because trading a fast, working, already-audited
in-process scan for a slower chatty equivalent has a real cost (scan
latency, audit-log volume) and no corresponding safety or capability
benefit. Yusuf's decision required either way.

### 4. Testing Agent → MCP client

- Add the shared MCP client (caller name `"testing-agent"`, required tool
  `run_tests`).
- `resumeTask()`'s `Bun.spawn()` call is replaced by an MCP `run_tests` call
  with the previously-approved `{ project_path, with_coverage }`.
- If MCP is unavailable, fail the task clearly — no fallback to the old
  direct `Bun.spawn()` path (matches DevOps's existing "never fall back to
  direct privileged execution" rule).
- Startup must not fail permanently merely because MCP hasn't started yet
  (same bounded-backoff pattern DevOps already uses).

### 5. Documentation Agent → MCP client

- Add the shared MCP client (caller name `"documentation-agent"`, required
  tools `read_project_file`, `write_project_file`).
- `skillGenerateReadme()`: replace `readFile`/`readdir` with
  `read_project_file` calls (list mode for the directory tree, content mode
  for `package.json`); replace the final `writeFile` with `write_project_file`
  inside `resumeTask()`, after approval.
- `skillDocumentApi()`: replace `readFile` with `read_project_file`
  (content mode); the optional save-to-file path replaces `writeFile` with
  `write_project_file` inside `resumeTask()`, after approval, exactly when
  the existing "save to"/"write to" detection already requires it.
- Same MCP-unavailable fail-closed behavior as Testing/DevOps.

## Safety Constraints

- `write_project_file` and `run_tests` remain Tier 1 — approval is
  unconditional, not skill-dependent, and cannot be inferred from an A2A or
  MCP caller identity (unchanged existing rule, restated because it applies
  directly to two brand-new tools).
- `read_project_file`/`write_project_file`'s path-containment logic is the
  single highest-risk piece of new code in this checkpoint (a path-traversal
  bug here would be worse than anything shipped so far, since it's a new
  generic file-access primitive rather than a narrow single-purpose one like
  `create_dockerfile`). It must be implemented with canonicalization +
  containment checks proven by adversarial tests (`../` sequences, absolute
  paths disguised as relative, symlink escapes, Windows short-path/`~`
  tricks, null-byte injection) before this checkpoint is considered
  acceptance-complete — not merely "looks right."
- Sensitive-filename denial (`.env*`, key/credential file patterns) applies
  to both read and write, by default, with no per-call override in this
  checkpoint.
- `run_tests`'s fixed-argv table must be the literal same table Testing
  already uses internally — not re-derived or loosened during the MCP move.
- Never log file contents in any new tool's audit event — metadata only,
  same as every existing tool.

## In Scope

1. `packages/shared/mcp-client.ts` — the shared, parameterized MCP client
   factory, replacing `packages/agents/devops/mcp-client.ts`'s DevOps-only
   version without changing DevOps's observed behavior.
2. Three new MCP tools: `run_tests`, `read_project_file`,
   `write_project_file`, added to `packages/mcp/index.ts`'s shared tool
   factory.
3. Testing Agent converted to use `run_tests` via MCP, Tier 1 approval flow
   unchanged from the outside.
4. Documentation Agent converted to use `read_project_file`/
   `write_project_file` via MCP, Tier 1 approval flow for writes unchanged
   from the outside.
5. Adversarial path-containment tests for `read_project_file`/
   `write_project_file` before this checkpoint is considered complete.
6. Regression tests proving DevOps's existing MCP behavior is unaffected by
   the shared-client extraction.

## Out of Scope

- **Security Agent's MCP conversion — decided (c), deferred entirely.** It
  keeps its current direct, in-process `fs` reads for `scan-secrets`,
  `check-gitignore-coverage`, and `audit-dependencies`. It is already Tier 2,
  already read-only, already audited, and already independent of MCP being
  up (a real resilience property this checkpoint does not want to give up
  for architectural symmetry alone). If revisited later, option (b) — one
  purpose-built `scan_project_secrets` MCP tool doing the recursive walk
  server-side — is the recommended approach; option (a) (per-file
  `read_project_file` calls) is not recommended at any point, since it has
  all of (b)'s costs plus a real performance/resilience regression.
- LLM-based routing (separate, team-decision spec).
- Any change to the approval/actionId contract itself — reused as-is.
- A general-purpose arbitrary-command MCP tool — `run_tests` remains
  fixed-argv-only, never a free-text command field.
- Persistent storage, durable audit, or a database.
- CLI packaging / global-install distribution (a separate, later
  conversation item, not part of this checkpoint).
- Increasing the 1 MiB read-file size limit, or adding a streaming/chunked
  read mode, unless a concrete need surfaces during implementation.

## Acceptance Criteria

- [x] Yusuf approves this spec, including the Security Agent decision — (c),
      deferred, with (b) recorded as the future path.
- [x] `packages/shared/mcp-client.ts` exists; DevOps uses it (as a thin
      `DevOpsMcpClient` subclass) with zero observable behavior change —
      live-verified `/healthz` still reports `connected` with all expected
      tools discovered.
- [x] `run_tests`, `read_project_file`, `write_project_file` are registered
      in the shared MCP tool factory and covered by
      `packages/mcp/project-file-tools.test.ts`.
- [x] Adversarial path-containment tests cover `../` traversal, absolute
      path injection, a null byte, and a symlink escape (skips gracefully if
      the test environment can't create symlinks, e.g. Windows without
      Developer Mode) — all rejected.
- [x] `read_project_file`/`write_project_file` refuse `.env` and other
      sensitive filename patterns by default, verified by test — including
      confirming the denial response never contains the file's real content.
- [x] Testing Agent's `run-tests` reaches `input-required` exactly as
      before, and on approval executes via the MCP `run_tests` tool instead
      of a direct `Bun.spawn()` — live-verified with a real passing suite
      (`bun test`, 1 pass).
- [x] Documentation Agent's `generate-readme`/`document-api` reach
      `input-required` exactly as before (when a write is involved) and
      produce output matching the prior direct-fs implementation —
      live-verified against a disposable project, including the "README.md
      already exists" overwrite-warning case (both the "doesn't exist yet,
      `overwrite:false`" and "exists, `overwrite:true`, note shown" paths).
- [x] `bun test` remains fully green — 104 pass, 0 fail, 168 expectations,
      12 files (up from 90/144/11 immediately after adding the 3 new tools,
      up from 81/131/10 before this checkpoint).
- [x] MCP-unavailable behavior fails closed for both agents — structurally
      guaranteed (neither `resumeTask()` in Testing nor
      `skillGenerateReadme()`/`skillDocumentApi()` in Documentation contains
      any direct `fs`/`Bun.spawn()` fallback code path anymore; there is
      nothing left to fall back to), not separately live-tested this pass —
      the DevOps kill/restart MCP scenario from the runtime-stabilization
      checkpoint already covers the identical client code this reuses.
- [x] Live full-stack verification: `bun run dev`, all 7 `/healthz` green
      with DevOps/Testing/Documentation all reporting `ready:true` and
      `mcp.state:"connected"`; representative Testing (`run-tests`) and
      Documentation (`generate-readme`, `document-api`) scenarios passed
      end to end.

## Verification Results (2026-08-08)

- Found and fixed one build-breaking gap during implementation, not caught
  in the draft: `packages/shared/package.json` had no declared dependencies
  at all. Moving DevOps's MCP client logic into `packages/shared/` without
  adding `@modelcontextprotocol/sdk` there broke module resolution for
  every agent importing it (`Cannot find module
  '@modelcontextprotocol/sdk/client/index.js'`) — fixed by declaring it in
  `packages/shared/package.json` and re-running `bun install`.
- `bun test`: 104 pass, 0 fail, 168 expectations, 12 files.
- Live, with a disposable scratch project: `run-tests` executed a real
  passing suite via MCP; `generate-readme` correctly detected
  file/directory/CI-workflow presence entirely through `read_project_file`
  calls and produced byte-identical README content to the prior direct-fs
  version; `document-api` correctly read a file and extracted its one route
  (with comment) via MCP, with no approval required (read-only); the
  "README.md already exists" note and `overwrite:true` correctly appeared
  on a second `generate-readme` request.
- One documented, accepted behavior change: `document-api` no longer
  produces the specific "expected a file, not a directory" error when given
  a directory (this agent no longer `stat()`s paths itself) — it now
  returns "No Hono route registrations found" instead, since a directory
  listing naturally contains no route matches. Harmless, but real; noted in
  code rather than silently changed.
- Full stack (`bun run dev`) and the disposable scratch project were
  cleaned up after verification.

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/011-remaining-agents-mcp/spec.md, with Security Agent option [a/b/c].
```

or list specific changes needed. No implementation is authorized by
discussion of this draft alone.
