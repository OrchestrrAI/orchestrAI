# Verification — 079 Phase A: Connect the Orphaned MCP Tools

Status: **partial** — every mechanism is live-verified against real
processes, including (as of 2026-09-13) the two Docker-dependent tools
(`docker_build`/`docker_run`) against a real Docker daemon. `verification`
stays `partial` for one remaining, unrelated reason: a genuinely
third-party HTTP-speaking MCP server as a second `OrchestraiMultiMcpClient`
endpoint was never connected (see "What's still owed" below) — the most
common community MCP server checked live speaks stdio, a structural
mismatch this spec's own scope doesn't cover.

## What changed

### 1. `safeExec()`'s argv fix (§7)

`packages/mcp/index.ts`: takes a real argv array now, never a command
string re-split on whitespace. **Found a real, already-live bug while
fixing this, not just the space-in-path case the spec named**: the old
`git commit -m "${message}"` template wrapped the message in shell-style
quotes that the SAME whitespace re-split then tore apart — a multi-word
commit message (the normal case) never actually worked correctly
through this path before this fix. Live-proven in
`packages/mcp/index.test.ts`: a real git repo, a real multi-word commit
message, confirmed byte-identical in `git log` afterward.

### 2–4. The four orphaned tools connected (§1–4)

`build-image` (`docker_build`), `docker-status` (`docker_status`),
`git-diff` (`git_diff`), `commit-changes` (`git_commit`) — all real
DevOps skills now, added to `agentCard.skills`, `REQUIRED_TOOLS`,
`SKILL_TIER_REGISTRY`, `SUPERVISOR_ALLOWED_SKILLS`, and
`apps/supervisor/agent-catalog.ts` (the guided-init form's own skill
list, kept in sync — its own test caught the drift immediately).

`commit-changes` got the extra design work its own higher bar demands:
the approval preview shows the **combined staged + unstaged diff**
(not just already-staged), since the underlying `git_commit` tool always
runs `git add -A` before committing — previewing only what's currently
staged would understate what's actually about to be captured. Bound by
a content fingerprint of that combined diff
(`computeContentFingerprint()`, the exact same function `specs/056`
already uses for a single file, applied here to a diff instead), with
its own dedicated drift-check branch in `resumeTask()` (the generic
single-file check doesn't apply — `commit-changes`'s own `targetPath` is
`"commit in <repo>"`, not a real file path).

**A real extraction bug found and fixed during live verification, not
assumed away**: `extractCommitMessage()`'s first version left a trailing
`"at <path>"` clause stapled onto the commit message. Fixed by running
it through `stripPathPhrases()` first — the exact same helper this
codebase's semantic classifier already uses for the identical reason,
reused rather than reinvented.

### 5. New tools (§5)

`docker_run` (fixed `--rm`/bounded-observation lifecycle, never
caller-chosen flags beyond image tag + port), `lint_ci_workflow`
(dependency-free structural check — `on:`/`jobs:` keys, no tabs — never
a full schema validator), `audit_dependencies_local` (declared
`package.json` versions, explicitly no network call — Phase F's own
separate decision). `verify-deployment` wraps `docker_run` the same way
`build-image` wraps `docker_build`.

### 6. Multi-endpoint MCP support (§6)

New `OrchestraiMultiMcpClient` in `packages/shared/mcp-client.ts` — a
caller-side router over N independent `OrchestraiMcpClient` instances.
**`OrchestraiMcpClient` itself is completely untouched** — every
existing single-endpoint call site (DevOps/Testing/Documentation) is
byte-identical, proven by the full suite passing unmodified. A tool
name ambiguously declared by two endpoints fails closed at
**construction** time (mirrors `specs/030`'s skill-ownership refusal);
a tool nobody declares fails closed at call time with a clear error.
The loopback/`http:`-only rule is completely untouched — each endpoint
still validates independently through the same `validateMcpUrl()` every
`OrchestraiMcpClient` already enforces.

**Not wired into DevOps in this pass** — see Verification Plan below
for why.

## Tests

- `packages/mcp/index.test.ts`: 16 new tests — the shared server
  advertises every new/connected tool; the real multi-word-commit-
  message regression (git repo, real `git log` check); a file-with-a-
  space-in-its-name commit; a real `git_diff` against a real staged
  change; `lint_ci_workflow` (clean, missing key, tabs); 
  `audit_dependencies_local` (real deps, no package.json); `docker_status`/
  `docker_build`+`docker_run` skip-guarded on a live Docker daemon
  (`test.skipIf`, mirroring this codebase's own
  `test.skipIf(!modelAvailable)` pattern for the semantic-fallback
  model).
- `packages/agents/devops/index.test.ts` (new file): Agent Card has all
  5 new skill ids; `build-image`/`verify-deployment` reach
  `input-required` with a correct approval preview using **no** MCP call
  at all (their PendingAction is built synchronously); `docker-status`/
  `git-diff`/`commit-changes` route correctly and fail gracefully
  without a live MCP server (this sandbox's own `bun test` never starts
  one); detection-ordering regressions (`"commit"` routes to
  `commit-changes` not `git-status`; `"git diff"` routes to `git-diff`
  not `git-status`).
- `packages/shared/mcp-client-multi.test.ts` (new file): 7 tests against
  **two genuinely separate, real, locally-bound HTTP MCP servers**
  (never `InMemoryTransport` — this is specifically testing the
  multi-endpoint case) — real tool routing to the correct endpoint,
  aggregated readiness/ping, ambiguous-tool-name construction failure,
  unknown-tool call failure, single-endpoint equivalence.
- `apps/supervisor/agent-catalog.test.ts` / `.ts`: updated to the real
  11-skill DevOps list (was 6) — caught by the existing drift test
  immediately, exactly as designed.

## Suite

- `bun test` — 925 pass, 2 skip (the two Docker-daemon-dependent tests,
  correctly skipped in this sandbox), 0 fail, at the time this spec was
  implemented. **Updated 2026-09-13** (after the `docker_build` timeout
  fix, on a real Docker daemon): 980 pass, 2 skip (specs/080's own
  unrelated skips), 0 fail across 982 tests.
- `bun run typecheck` — 0 errors.

## Live verification (real processes, not mocks)

A real `mcp:http` + real `devops-agent` stack, both on non-default
ports:

**`git-diff`** — a real scratch git repo with a real unstaged change;
task completed with the exact real `git diff` output (`+world` line
included).

**`docker-status`** — task completed with the real (honest) "Docker
daemon unreachable" message from this sandbox's own environment — not a
crash, not a stall; exactly the failure-is-still-a-completed-result
shape the spec calls for.

**`commit-changes` — the full flow, three scenarios**:
1. **Preview**: real combined staged+unstaged diff shown (`hello` file
   staged, `world`/`extra line` unstaged), extracted message clean
   (`"add the extra line too"`, no path clause).
2. **Drift refusal**: mutated the working tree after the preview, then
   approved the now-stale `actionId` — refused with the exact designed
   error, no commit created.
3. **Happy path**: fresh preview, approved unmodified — a **real git
   commit landed** (`edd2d3c add the extra line too`), `git log`
   confirmed it, containing exactly what the preview showed.

**`build-image`/`verify-deployment` — closed live, 2026-09-13, against a
real Docker daemon on Yusuf's own machine (Docker Desktop).**

A real `dockerize` + `build-image` sequence against a real scratch Bun
project. **A real, previously-undiscovered bug was hit on the first
attempt, not assumed away**: the build failed with `"MCP error -32001:
Request timed out"` — a real `docker build` (pulling `oven/bun:1-slim`
and running `bun install`) genuinely exceeded two independent, too-short
timeouts that this spec's own scope never adjusted: `packages/mcp/
index.ts`'s `safeExec()` hardcoded every command (git status/diff/commit,
docker status/build) to a 15000ms `execFileAsync` timeout, and DevOps's
own `resumeTask()` had no client-side override for `docker_build` the way
`specs/080` already added one for `run_command` — it fell through to the
shared 15s `TOOL_TIMEOUT_MS`. The same client/server timeout-mismatch
class `specs/076`/`080` already fixed for `run_tests`/`run_command`, just
not yet applied to this call site.

Fixed both sides: `safeExec()` gained an optional `timeoutMs` parameter
(default unchanged at 15000, so every other call site — git status/diff/
commit — stays byte-identical), `docker_build` now passes an explicit
180-second budget, and DevOps's `resumeTask()` now passes a matching
195-second client-side timeout specifically for `docker_build` calls.
After restarting `mcp:http`/`devops-agent`, the retried build succeeded
(reusing cached layers from the failed first attempt) — a real image,
confirmed present via a real `docker images` check afterward.

`verify-deployment` then started a real container from that image and
confirmed it was still running after a 2-second observation window, with
a real `docker ps` status line in the task result:

```
✅ ... started and was still running after 2000ms
```

(`orchestrai-verify-<timestamp>`, status `Up 2 seconds (health:
starting)`).

**Not re-verified live in this same pass**: a deliberately broken
Dockerfile producing a legible failed-build result — this remains
covered only by the existing unit tests; the real, previously-blocked
scenario was the passing-build path, and that's what this pass closed.

## What's still owed

1. ~~`docker_build`/`docker_run`/`build-image`/`verify-deployment`
   against a real Docker daemon~~ — **closed above, 2026-09-13.**
2. **A genuinely third-party MCP server as a second endpoint** — checked
   live during this pass: `npx @modelcontextprotocol/server-filesystem`
   (the most common community MCP server) speaks **stdio**, not
   Streamable HTTP, and `OrchestraiMcpClient`/`OrchestraiMultiMcpClient`
   have only ever supported HTTP. This is a real, structural mismatch,
   not a gap in the implementation — most community MCP servers ship
   stdio-first for Claude Desktop. `mcp-client-multi.test.ts`'s own two
   real, independent, locally-bound HTTP servers are the closest
   equivalent this spec could genuinely prove without adding a
   stdio-to-HTTP bridge, which is new scope beyond what was approved.
   Recorded here rather than silently narrowed: connecting a real
   HTTP-speaking third-party server (several exist) is the literal
   remaining item if that exact acceptance criterion still matters, or
   this finding itself may be worth its own follow-up decision about
   whether stdio bridging belongs in a later phase.
3. A live PTY pass isn't applicable here (Phase A has no TUI
   component) — not an open item.

## Correction, 2026-09-15 — item 2 closed as a deliberate non-goal, spec flips to verified

Discussed directly with Yusuf. Two real facts, checked before deciding,
not assumed: (a) `OrchestraiMultiMcpClient` has **zero real consumers**
in this codebase — `grep -rln "OrchestraiMultiMcpClient" --include=
"*.ts"` outside test files returns only `packages/shared/mcp-client.ts`
itself; every agent (DevOps included) still uses the single-endpoint
`OrchestraiMcpClient`. (b) The class is small and self-contained (75
lines) with a real, passing test file (188 lines,
`mcp-client-multi.test.ts`) proving the routing/ownership-conflict
mechanism against two genuine, independent HTTP MCP servers.

**Decision**: keep the code, formally close the open acceptance
criterion as a deliberate non-goal rather than an incomplete item.
Reasoning: this was explicitly commissioned, approved work (not
speculative), costs nothing at runtime (unused, not on any live
dispatch path), and reverting it would discard real, correct,
already-verified infrastructure over what is actually a documentation-
precision problem (the spec implied "connect a real third-party
server" was imminent, when it structurally requires a stdio bridge —
separate, unscoped work). A stricter reading of this codebase's own
"increase capability only where a real need is shown" principle
(`specs/042`) would argue against building this ahead of a real
consumer at all — noted honestly as a real tension, not resolved by
pretending the principle doesn't apply, but outweighed here by the
sunk-cost-reversal cost of deleting genuinely correct work.

`specs/079` flips from `verification: partial` to `verified` — every
one of its own acceptance criteria is now either fully met or formally,
honestly closed as an out-of-scope non-goal. No code changed in this
correction; `bun test`/`bun run typecheck` were not re-run (nothing
touched outside `specs/`).

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/079-phase-a-connect-orphaned-tools/spec.md` (implemented,
**verified**, 2026-09-12; the multi-endpoint/third-party MCP item
closed as a deliberate non-goal 2026-09-15 — see the correction note
after this section) is Phase A. DevOps gains five real skills:
**`build-image`** (wraps `docker_build`, closes the generate→verify
loop — DevOps could write a Dockerfile nobody ever built before this)
and **`verify-deployment`** (wraps a new `docker_run` tool — fixed
`--rm`/bounded-observation lifecycle, never a caller-chosen flag beyond
image tag + port — confirms the built image actually *boots*, the
literal answer to "can you deploy it?"); **`docker-status`** and
**`git-diff`** (read-only, Tier 2); and **`commit-changes`** (wraps
`git_commit`) — connected per Yusuf's own correction to the roadmap's
first draft ("get in the decision the orphan"), not left orphaned as
originally proposed. Two more new read-only tools:
**`lint_ci_workflow`** (a dependency-free structural check — `on:`/
`jobs:` keys, no tabs — never a full YAML schema validator, matching
`specs/040`'s own "no new parsing dependency" precedent) and
**`audit_dependencies_local`** (declared `package.json` versions, no
network call — real CVE data needs Phase F's own separate network-
access policy decision, deliberately not made here).

**`commit-changes` is held to a higher approval bar than every other
DevOps write**, because it alters git history rather than producing an
inspectable file: its preview shows the **combined staged + unstaged
diff** (not just what's currently staged), since the underlying
`git_commit` tool always runs `git add -A` before committing —
previewing only the already-staged half would understate what's about
to be captured. Bound by a content fingerprint of that combined diff
(`computeContentFingerprint()`, the exact function `specs/056` already
uses for a single file's content, applied here to a diff instead), with
its own dedicated drift-check branch in `resumeTask()` — live-verified
against a real scratch git repo, all three scenarios: the preview
matching the real state, a stale-approval refusal after mutating the
working tree between preview and approval, and a genuine commit landing
(`git log` confirmed) on the happy path.

**Two real, previously-unknown bugs found and fixed while implementing
this, not assumed away.** (1) `packages/mcp/index.ts`'s `safeExec()`
built commands as template strings and re-split them on whitespace —
safe from shell injection (`execFile`, `shell:false`) but wrong for any
argument containing a space. The spec anticipated the Windows-path case;
live verification found a **more serious**, already-live instance:
`git commit -m "${message}"` wrapped the message in shell-style quotes
that the SAME whitespace split then tore apart, so a normal multi-word
commit message never actually worked correctly through this path at
all. Fixed by taking a real argv array throughout, never a string to
re-parse. (2) `extractCommitMessage()`'s first version left a trailing
`"at <path>"` clause stapled onto the extracted commit message — fixed
by running it through `stripPathPhrases()` first, the same helper this
codebase's semantic classifier already uses for the identical reason.

**Multi-endpoint MCP support** (`OrchestraiMultiMcpClient`, new in
`packages/shared/mcp-client.ts`) lets an agent reach more than one MCP
server — previously `OrchestraiMcpClient` held exactly one URL and
required *every* one of an agent's tools to live there.
`OrchestraiMcpClient` itself is **completely untouched**, so every
existing single-endpoint call site (DevOps/Testing/Documentation) is
byte-identical (proven by the full suite passing unmodified); the new
class is a caller-side router over N independent instances, one per
endpoint, failing closed at **construction** time if two endpoints
declare the same tool (mirroring `specs/030`'s skill-ownership
refusal) and at call time if no endpoint declares a requested tool. The
loopback/`http:`-only rule is completely untouched. Live-proven against
two genuinely separate, real, locally-bound HTTP MCP servers (never
`InMemoryTransport`) in `packages/shared/mcp-client-multi.test.ts` — not
yet wired into DevOps itself. **A real finding worth recording**: the
official filesystem MCP server (checked live via
`npx @modelcontextprotocol/server-filesystem`) and most community MCP
servers speak **stdio**, not Streamable HTTP — a genuine structural
mismatch with this codebase's HTTP-only client, not a gap in this
spec's own implementation. Bridging stdio is new scope, not attempted
here.

**Correction, 2026-09-15 — formally closed as a deliberate non-goal,
not reverted.** `OrchestraiMultiMcpClient` has **zero real consumers**
in this codebase — confirmed by `grep`, every agent (DevOps included)
still uses the single-endpoint `OrchestraiMcpClient`. Discussed
directly with Yusuf: rather than revert the class (real, commissioned,
tested, zero runtime cost since it's unused/not on any live path), it
stays — connecting a genuine third-party server is recorded as a
deliberately deferred non-goal (stdio-bridging is separate, unscoped
work), not an incomplete item. A stricter reading of this codebase's
own "increase capability only where a real need is shown" principle
(`specs/042`) would argue against having built this ahead of a real
consumer at all — named honestly as a real tension, not resolved by
pretending it doesn't apply, but outweighed by the cost of discarding
already-correct work over what is really a documentation-precision
problem. `specs/079` flips to `verification: verified` — every
acceptance criterion is now either met or formally, honestly closed.

925 tests pass (0 fail, 2 Docker-daemon-dependent tests correctly
skipped via a `test.skipIf` guard, the same pattern this codebase's
semantic-fallback model tests already use), typecheck clean.

**Closed live, 2026-09-13, on a real Docker daemon (Yusuf's own
machine)**: `build-image`/`verify-deployment` against a real scratch Bun
project. **A real, previously-undiscovered bug was found and fixed along
the way**: the first attempt timed out with `"MCP error -32001: Request
timed out"` — a real `docker build` (base-image pull + `bun install`)
genuinely exceeds both `packages/mcp/index.ts`'s `safeExec()` (hardcoded
15000ms `execFileAsync` timeout for every command) and DevOps's own
`resumeTask()` client-side call timeout, which had no override for
`docker_build` the way `specs/080` already added one for `run_command`.
The same client/server timeout-mismatch class `specs/076`/`080` already
fixed for `run_tests`/`run_command`, just not yet applied to this call
site. Fixed: `safeExec()` gained an optional `timeoutMs` parameter
(default unchanged, so every other call site is byte-identical),
`docker_build` now passes a 180s budget, and DevOps now passes a matching
195s client-side timeout for `docker_build`. A real image was confirmed
built (`docker images`) and a real container confirmed started and still
running after a 2-second observation window (`docker ps` status `Up 2
seconds (health: starting)`) in the task result. `bun test` afterward:
980 pass, 2 skip (specs/080's own unrelated skips), 0 fail across 982.
**Not re-verified live in this pass**: a deliberately broken Dockerfile
producing a legible failed-build result — remains unit-tested only. See
that spec's own `verification.md` for the complete live-process record,
including the real git-diff/docker-status/commit-changes transcripts and
this docker-timeout-fix trail.

See specs/080-run-command-approved-execution/verification.md for the relocated narrative covering this checkpoint.

See specs/114-coder-multi-file-edit-and-create/verification.md for the relocated narrative covering this checkpoint.
