---
id: 079-phase-a-connect-orphaned-tools
title: "Phase A: Connect the Orphaned MCP Tools + Fix safeExec's Argv Handling"
area: devops-agent
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-12
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-12
implemented_on: 2026-09-12
amends:
  - 011-remaining-agents-mcp
  - 040-approval-preview-content-diff
  - 056-devops-preflight-and-idempotent-writes
related:
  - 078-capability-upgrade-roadmap
  - 073-configurable-service-ports
supersedes: []
superseded_by: []
---

# Spec: Phase A: Connect the Orphaned MCP Tools + Fix safeExec's Argv Handling

> Review gate: **DRAFT — NOT APPROVED. Do not implement until Yusuf
> approves it.**
>
> `specs/078-capability-upgrade-roadmap/spec.md` (approved 2026-09-12)
> names this as Phase A and requires its own spec before implementation.
> This is that spec. Scope, ordering, and the risk-class rule all come
> from `078`; this document is where they become concrete.

## Purpose

`packages/mcp/index.ts` already implements `docker_build`,
`docker_status`, `git_diff`, and `git_commit` — fully working, already
allowlisted, `shell:false`, timeout-bounded — but no agent has ever been
given access to them. DevOps can generate a Dockerfile nobody builds,
and there is no way to answer "what changed?" or commit a reviewed
change at all. This phase connects all four, adds the new fixed tools
`078` approved, adds multi-endpoint MCP support so locally-run
third-party servers become reachable, and fixes a real correctness bug
in `safeExec()` that Phase B (a later, separate spec) would otherwise
make user-facing.

## Verified Current State

Read 2026-09-12 (see `specs/078`'s own inventory for the full picture;
restated here only where this spec's own scope depends on the detail):

- `packages/mcp/index.ts`'s `docker_build`, `docker_status`, `git_diff`,
  `git_commit` tool handlers — implemented, registered on the shared MCP
  server, reachable today only via the stdio entrypoint (a real MCP
  client like Claude Desktop), never via the A2A runtime.
- `packages/agents/devops/mcp-client.ts`'s `REQUIRED_TOOLS`: `[
  "analyze_project", "git_status", "create_dockerfile",
  "create_github_action", "create_gitignore", "create_dockercompose",
  "read_project_file" ]` — none of the four orphaned tools present.
- `packages/mcp/index.ts`'s `safeExec(cmd: string, cwd?: string)`:
  checks `cmd` against `ALLOWED_PREFIXES` (a prefix match on the raw
  string), then does `cmd.trim().split(/\s+/)` to build the argv array
  passed to `execFileAsync(bin, args, {shell:false})`. `docker_build`'s
  own handler constructs its command as a single template string
  (`` `docker build -f ${dockerfile} -t ${image_tag} .` ``) and hands it
  to `safeExec`, so any of `dockerfile`/`image_tag`/`context_path`
  containing a space is split into the wrong argv tokens. Confirmed safe
  from injection (`execFile`, `shell:false` — no shell ever parses the
  string), confirmed wrong for a common real path shape.
- `packages/shared/mcp-client.ts`'s `OrchestraiMcpClient`: `private
  readonly url: URL` (singular) in its constructor; `waitUntilReady()`
  throws `"MCP server missing required tools"` if **any** entry in
  `requiredTools` is absent from the **one** connected server's tool
  list. No concept of a second endpoint exists anywhere in the class.
- `packages/shared/mcp-host-allowlist.ts`'s `isAllowedMcpHost()` and
  `packages/shared/mcp-client.ts`'s `validateMcpUrl()`: reject any URL
  whose protocol isn't `http:` or whose host isn't loopback. Confirmed
  this does not, by itself, block a *locally-run* third-party MCP server
  (e.g. the official filesystem server, or a local Docker/Postgres MCP
  server) — those bind loopback too; the actual blocker is the
  single-endpoint limit above.
- DevOps's own skill-detection (`prepareWriteAction`/keyword matching)
  and Agent Card (`agentCard.skills`) — the pattern every new skill in
  this spec follows.
- `specs/056`'s content-fingerprint recheck
  (`computeContentFingerprint()`) — the existing mechanism that already
  refuses a write whose target changed between preview and approval;
  this spec's `commit-changes` skill (§4) needs the equivalent guarantee
  for a **staged diff**, not a target file, so it is extended rather
  than duplicated.

## Proposed Behavior

### 1. DevOps `build-image` (wraps `docker_build`)

New skill, Tier 1 (write-capable — it executes `docker build`, with real
side effects: an image added to the local Docker daemon).
Parameters: `context_path`, `image_tag`, `dockerfile` (default
`"Dockerfile"`), mirroring the MCP tool's own schema exactly. Approval
preview shows the exact command that will run (not generated content —
this is DevOps's first *executing* skill, so `specs/040`'s
content/diff shape doesn't apply the same way; the preview's `target`
is the image tag, its `parameters` the resolved argv). On completion,
the task result is the real `docker build` output, bounded by the
existing `boundTaskResult()`/64 KiB path — a failed build is a
**completed task with a failure result**, not a task-level error,
matching how a real build failure is useful information, not a system
malfunction.

### 2. DevOps `docker-status` (wraps `docker_status`)

New skill, Tier 2 (read-only — `docker ps -a` + `docker images`, no
approval). Reports current containers/images verbatim.

### 3. DevOps `git-diff` (wraps `git_diff`)

New skill, Tier 2 (read-only). Parameters: `repo_path`, optional
`staged` (bool). Reports the real diff, bounded by the existing
64 KiB/`TASK_RESULT_MAX_BYTES` path (an oversized diff is truncated with
the existing explicit marker, never silently). This is the required
input for `specs/078`'s later Phase D (Code Review Agent).

### 4. DevOps `commit-changes` (wraps `git_commit`)

New skill, Tier 1. **The one write in this phase that alters history
rather than producing an inspectable file**, so its approval preview is
held to a higher bar than a normal generated-content write:

- The preview's `content` field is the **real staged diff** (computed at
  preview time via the same underlying `git diff --staged` the new
  `git-diff` skill exposes) plus the **exact commit message verbatim**
  — never a summary standing in for either.
- A content fingerprint of the staged diff is bound to the `actionId`,
  the same mechanism `specs/056` already uses for a target file's
  content. `resumeTask()` re-computes the staged diff's fingerprint
  immediately before running `git commit` and refuses (fails closed,
  requires a fresh preflight) if anything was staged, unstaged, or
  changed since the preview was generated — the exact drift guarantee
  `056` already gives every other write, extended to a staged-diff
  fingerprint instead of a file-content one.
- The underlying `git_commit` MCP tool stages everything (`git add -A`
  then commit). This skill keeps that behavior explicitly — a
  caller-specified file subset is deferred, not silently assumed, since
  it would need its own MCP tool parameter and is a real scope decision
  on its own.
- `git add`/`git commit` are already on `safeExec()`'s
  `ALLOWED_PREFIXES` — no new execution surface.

### 5. New fixed tools (approved in `specs/078` decision 1)

Three new MCP tools, same shape as every existing one (fixed allowlisted
command, no caller-supplied executable):

- **`docker_run`** — starts a built image (parameters: `image_tag`, a
  fixed `--rm` auto-remove policy, a bounded `timeout`, and a
  caller-supplied `port` mapping only — container lifecycle stays fixed
  policy, never model-chosen) and reports whether it actually started
  and stayed up for a short bounded observation window. DevOps's
  `verify-deployment` skill wraps it, Tier 1 (it runs a real container).
  This is what closes "can you deploy it?" all the way — generate,
  build, and now *prove it boots*.
- **`lint_ci_workflow`** — validates the GitHub Actions YAML DevOps's
  own `create-ci` already generates (schema/syntax validation only, not
  a live GitHub Actions run). Read-only, Tier 2.
- **`audit_dependencies_local`** — reports installed dependency versions
  from the project's own lockfile/manifest (no network call — this is
  explicitly **not** `specs/078` Phase F's external-CVE-data work,
  which needs its own network-access policy decision first). Read-only,
  Tier 2. Feeds Security's existing `audit-dependencies` with real
  installed-version data it doesn't have today, without crossing the
  network boundary Phase F still needs to decide on.

### 6. Multi-endpoint MCP support

`OrchestraiMcpClient` changes from a single `url` to a list of named
endpoints, each with its own required-tool subset, its own connection
lifecycle, and its own readiness/health state — `waitUntilReady()`
becomes "every endpoint whose tools this client actually needs is
ready," not "the one server has everything." `callTool(name, ...)`
resolves which connected endpoint owns `name` (each tool name must
belong to exactly one configured endpoint — an ambiguous/duplicate tool
name across endpoints is a configuration error, fail-closed, mirroring
`specs/030`'s "a skill owned by two agents" refusal). Every existing
call site (single-endpoint, pointed at `mcp:http`) is unaffected —
migrating to a list of one entry is byte-identical.

**The loopback/`http:`-only rule is untouched.** This is what makes a
locally-run third-party MCP server (filesystem, Docker, Playwright,
Postgres — anything binding loopback) usable as a second endpoint for
any agent, with zero change to the trust boundary `validateMcpUrl()`
already enforces.

### 7. Fix `safeExec()`'s argv handling

`safeExec()` (and every `server.tool()` handler that currently builds a
template-string command for it) changes to accept a real argv array
directly — `execFileAsync(bin, args, ...)` already wants exactly that
shape; the template-string-then-resplit step is removed entirely rather
than patched. `ALLOWED_PREFIXES` matching moves from a string-prefix
check to matching against `[bin, ...args.slice(0, N)]`, preserving the
exact same allowed set. Every existing tool (`git_status`, `git_diff`,
`docker_build`, etc.) is updated to build its own argv array instead of
a string; behavior is unchanged for every value that contained no space,
and correct for the first time for one that does.

## Scope

- `packages/mcp/index.ts`: `build-image`'s and `docker-status`'s
  underlying tools already exist (§1/§2 need no new MCP tool, only
  wiring); `docker_run`, `lint_ci_workflow`,
  `audit_dependencies_local` are new tools; `safeExec()`'s argv rewrite;
  every existing tool handler updated to build argv arrays.
- `packages/agents/devops/index.ts` /
  `packages/agents/devops/mcp-client.ts`: the five new skills
  (`build-image`, `docker-status`, `git-diff`, `commit-changes`,
  `verify-deployment`), their Agent Card entries, `REQUIRED_TOOLS`
  additions, approval-preview construction for the two Tier 1 skills.
- `packages/shared/approval.ts` / `packages/shared/write-preflight.ts`:
  extended (not duplicated) to support a staged-diff fingerprint for
  `commit-changes`, alongside the existing file-content fingerprint.
- `packages/shared/mcp-client.ts`: the multi-endpoint rewrite of
  `OrchestraiMcpClient`.
- `apps/orchestrator/supervisor-graph.ts`'s `SKILL_TIER_REGISTRY`: the
  five new skill ids classified (four Tier 1, `docker-status`/`git-diff`
  Tier 2).
- Tests: real fixture-based tests for each new tool/skill (mirroring
  `specs/058`'s own "real fixture, not a hand-typed stub" standard); the
  multi-endpoint client's own connection-lifecycle tests; the
  `safeExec()` argv-array regression tests (including a path containing
  a space, which must now work).
- **Out of scope / unchanged**: Phase B's `run_command` primitive (a
  separate, later spec per `078`); Phase B′'s ecosystem expansion;
  Security's own direct-`fs` architecture; any change to the approval
  gate's own mechanism beyond the staged-diff fingerprint extension;
  hosted/remote (non-loopback) MCP servers.

## Safety and Compatibility Constraints

- **The approval gate is untouched in mechanism**, only extended
  (staged-diff fingerprint alongside file-content fingerprint) for the
  one skill (`commit-changes`) whose write target isn't a single file.
- **No new execution primitive.** Every command in this phase is a
  fixed, hand-written argv array on the existing allowlist shape — this
  is explicitly `078`'s risk classes 1–2, not class 4 (that's Phase B,
  a separate spec, gated on this one being verified).
- **`docker_run`'s lifecycle is fixed policy, never model- or
  caller-chosen** beyond the port mapping — no arbitrary flags, no
  interactive mode, always auto-remove, always bounded.
- **The multi-endpoint client changes internal structure, not external
  behavior**, for every existing single-endpoint call site — proven by
  the existing DevOps/Testing/Documentation test suites passing
  unmodified.
- **`safeExec()`'s fix is a pure correctness fix** — the allowed command
  set is unchanged; only how arguments reach `execFile` changes (a real
  array instead of a re-split string).

## Out of Scope / Non-Goals

- `run_command` / any model-chosen command (`078` Phase B).
- Go/Rust/Maven/.NET runner profiles, coverage parsing for the 5 newer
  Testing runners, the compose YAML indentation bug (`078` Phase B′).
- Any external network call for dependency/CVE data (`078` Phase F).
- Hosted/remote (non-loopback) MCP servers.
- Caller-specified partial-file commits (`commit-changes` stages
  everything, explicitly, per §4).
- Any change to Testing, Documentation, or Security's own skill set.

## Acceptance Criteria

- [x] `build-image` builds a real image from a real generated Dockerfile
      live — **closed 2026-09-13** on a real Docker daemon. A real
      bug was found and fixed along the way: `docker_build`'s
      server-side exec timeout (`safeExec()`'s hardcoded 15s) and
      DevOps's own client-side call timeout were both far too short for
      a real image build (base-image pull + `bun install` routinely
      exceeds 15s) — the same client/server timeout-mismatch class
      `specs/076`/`080` already fixed for `run_tests`/`run_command`,
      just not yet applied to this call site. Fixed: `safeExec()`
      gained an optional `timeoutMs` parameter (default unchanged at
      15000, so every other call site is byte-identical), `docker_build`
      now passes a 180s budget, and DevOps's `resumeTask()` now passes
      a matching 195s client-side timeout for `docker_build` calls. A
      real image (`orchestrai-live-079:test`) was confirmed built and
      present via a real `docker images` check afterward. A deliberately
      broken Dockerfile producing a legible failed-build result remains
      unit-tested only (not re-verified live in this pass) — the real
      passing-build path was the scenario this criterion was actually
      blocked on.
- [x] `verify-deployment` confirms a real container actually starts and
      stays up, live — **closed 2026-09-13**: a real container
      (`orchestrai-verify-<timestamp>`) was started from the image
      above and confirmed `"✅ ... started and was still running after
      2000ms"` with a real `docker ps` status line (`Up 2 seconds
      (health: starting)`) in the task result.
- [x] `docker-status` reports real containers/images — live-verified
      (correctly reports the real "daemon unreachable" state in this
      sandbox, a genuine completed result, not a crash).
- [x] `git-diff` reports a real diff, bounded correctly when oversized
      (unit-tested for the bound; live-verified for real diff content).
- [x] `commit-changes`: a real staged diff + message is shown in the
      approval preview, a real commit is produced only after approval,
      and staging something new after preview generation but before
      approval refuses the commit and requires a fresh preflight — all
      three live-verified against a real git repo, including the real
      commit landing (`git log` confirmed) and the drift refusal firing.
- [x] `lint_ci_workflow` and `audit_dependencies_local` report real
      results against real fixtures.
- [x] **Correction, 2026-09-15**: reworded to state precisely what is
      and isn't true, rather than imply this criterion is still "in
      progress." `OrchestraiMultiMcpClient`'s multi-endpoint routing
      mechanism (construction-time tool-ownership conflict detection,
      per-endpoint call routing) is built and live-proven against two
      real, separate, locally-bound HTTP MCP test servers
      (`packages/shared/mcp-client-multi.test.ts`). **It has no real
      consumer**: no agent in this codebase (DevOps included) actually
      uses it — every agent still uses the single-endpoint
      `OrchestraiMcpClient`, confirmed by a direct `grep` finding zero
      non-test call sites. Connecting a genuine third-party MCP server
      (the official filesystem server, most community servers) is a
      **separate, deliberately deferred non-goal**, not an oversight:
      those servers speak stdio, this client speaks HTTP only, a real
      structural mismatch bridging would require its own, unscoped
      spec. The mechanism itself is kept — real, tested, zero runtime
      cost (unused code, not code on any live path) — rather than
      reverted, a decision made directly with Yusuf: deleting
      already-correct, already-paid-for infrastructure over a
      documentation-precision problem was judged the wrong trade.
- [x] `safeExec()` correctly executes a command whose argument contains
      a space — live-verified, and found a MORE serious pre-existing bug
      along the way: a multi-word commit message (not just a spaced
      path) never worked correctly through the old string-re-split path
      at all.
- [x] Every existing DevOps/Testing/Documentation test and live
      behavior is unchanged — 925 pass, 0 fail, including every
      pre-existing test unmodified.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Unit: each new skill/tool against real fixtures (a real Dockerfile, a
  real git repo with real staged changes, a real CI YAML file); the
  staged-diff fingerprint's drift-detection case; the multi-endpoint
  client's connection/readiness/tool-resolution logic; `safeExec()`'s
  argv-array behavior including the space-in-argument regression.
- Live, real stack: the full `build-image` → `verify-deployment`
  sequence on a real project; a real `commit-changes` approved and
  rejected-after-drift; a real second local MCP server (e.g. the
  official filesystem server) connected alongside `mcp:http` for one
  agent.

## Approval Requested

Approve to proceed. Implements `specs/078`'s Phase A, including its
Decision 7 (`git_commit` connected, not orphaned). Nothing is
implemented until approved.
