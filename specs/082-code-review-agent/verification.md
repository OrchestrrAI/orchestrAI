# Verification — specs/082-code-review-agent

Recorded 2026-09-12, same session as implementation.

## Unit / HTTP-level

- **`packages/agents/code-review/diff-grounding.test.ts`** — 12 tests,
  pure functions, no I/O: multi-file parsing, added/context/removed
  line classification, a deleted file, a renamed file with no content
  change, a binary-file diff, a `\ No newline at end of file` marker,
  path normalization (`a/`/`b/` stripping, backslash normalization),
  and `describeValidLocations()`.
- **`packages/agents/code-review/llm-harness.test.ts`** — 10 tests, a
  `ScriptedChatModel`/`MockMcpToolCaller` pairing (the same technique
  `packages/agents/devops/llm-harness.test.ts` already established), no
  live model or MCP server: a fully grounded response returned as-is;
  an empty `comments` array as a valid response; the model calling
  `read_project_file` for real context before responding; a
  `read_project_file` call for a since-deleted file surfacing the real
  MCP error text back to the model without crashing; an ungrounded
  citation triggering exactly one retry that then succeeds; a mixed
  grounded/ungrounded response, after exhausted retries, salvaging only
  the grounded comments with the correct `omittedCount`; a fully
  ungrounded response, after exhausted retries, failing closed (`null`);
  structurally invalid JSON triggering retry-with-feedback and
  recovering; and exhausted retries on persistently invalid JSON
  failing closed.

  **A real bug was found and fixed while writing these tests, not
  assumed away.** The first version of the "mixed grounded/ungrounded,
  salvage on exhaustion" test reused the *same* `AIMessage` object
  instance across all three scripted retry responses. LangGraph's own
  `MessagesAnnotation` reducer (`add_messages`) dedupes incoming
  messages by object identity/`.id` — replaying the identical object a
  second time was treated as a **replace** of the earlier turn in
  place, not a new turn appended after the retry-feedback message. This
  silently corrupted "the last message" the harness's own
  `validateNode` read on the second and third attempts (it read the
  *retry-feedback HumanMessage itself*, not the model's real second/
  third response), causing three real model calls to collapse into
  what looked like one validation attempt from the graph's perspective,
  and the whole thing failed closed instead of salvaging. Fixed by
  constructing a fresh `AIMessage` per scripted attempt in the test
  (even when the text content is identical) — this is a genuine lesson
  about `ScriptedChatModel`-style test doubles reused across this
  codebase's other harness tests, not a defect in `runReviewDiffHarness()`
  itself (confirmed: `packages/agents/devops/llm-harness.test.ts`'s own
  existing scripted responses across its repo never reuse one object
  instance for two different textual contents, so this pattern was
  never exercised there).
- **`packages/agents/code-review/index.test.ts`** — 8 tests, real HTTP
  requests against the real, unmodified app: Agent Card advertises
  exactly `review-diff`; no approve/reject route exists (404); skill
  detection for both trigger phrasings and for unrelated text (verified
  via which *outcome* each reaches — "not implemented yet" vs. a real
  target-path error — since, matching Testing's/DevOps's own
  established shape, `step` is not preserved into a terminal task
  record); no-target-path and nonexistent-path fail closed; a real,
  existing directory with no live MCP server reaches a genuine `failed`
  state gracefully (never hangs, never throws unhandled).

## Registration-point wiring

Every registration point named in the spec's own Scope section was
applied and typechecked: `service-ports.ts`, `agent-registry.ts`,
`apps/orchestrator/index.ts`'s `KNOWN_AGENTS`, `apps/supervisor/
index.ts`'s `SERVICE_STARTERS`/`AGENTS`, `apps/supervisor/agent-
catalog.ts` (+ its drift test), `apps/orchestrator/supervisor-
graph.ts`'s `SKILL_TIER_REGISTRY`/`SUPERVISOR_ALLOWED_SKILLS`, root
`package.json`'s script + `--parallel` strings, `docker-compose.yml`,
`packages/shared/llm-model-factory.ts`'s `LLM_COMPONENTS`, and
`apps/supervisor/init-wizard.ts`'s `AGENT_LLM_HARNESSES`.

**One genuine 7th registration point was found only by `bun run
typecheck`, not anticipated when the spec was drafted**:
`apps/supervisor/init-form.tsx`'s `PORT_ROW_LABELS` is a
`Record<ServicePortName, string>` (`specs/073`'s guided-init Ports
section) — TypeScript's own exhaustiveness check refused to compile
until `codeReview` was added there too. This is exactly the kind of
gap a `Record<T, ...>` type is supposed to catch, and it did.

Six pre-existing tests across `apps/supervisor/init-form-state.test.ts`
needed updating for the new agent joining `AGENT_LLM_HARNESSES` and the
test file's own local `AGENTS` fixture array (the same class of update
`specs/080`'s own testing-agent addition required) — all six are
legitimate behavior changes (a 5th agent now genuinely appears in the
Models section and the "select all" harness-flag set), not test-only
patches.

## Live pass, 2026-09-12 (real Gemini deployment, real key)

Same real key/provider/model as `specs/080`/`081`'s own live passes
(`.orchestrai/config.env`, never echoed or logged). Stack: real
`mcp:http` (3006), real `code-review-agent` (3007,
`ORCHESTRAI_CODE_REVIEW_LLM_HARNESS=1`), and — for the router-naming
scenario — the real `orchestrator` (3000) with the other four agents'
own `ORCHESTRAI_<AGENT>_URL` variables pointed at unreachable stub
ports, isolating the new agent as the only one actually discoverable.

**Fixture**: a real git repository with a genuine baseline commit
(`math.ts` with `clamp()`/`average()`), then a real, deliberately
uncommitted change introducing **both** a planted bug and a planted
non-issue in the same diff:

```diff
 export function clamp(value: number, min: number, max: number): number {
-  if (value < min) return min
+  if (value < min) return max
   if (value > max) return max
   return value
 }
@@ ...
+export function sum(numbers: number[]): number {
+  return numbers.reduce((a, b) => a + b, 0)
+}
```

`clamp()`'s first branch was flipped to return `max` instead of `min` —
a genuine, unambiguous bug. `sum()` is a genuinely correct new
function.

**Scenario 1 — direct submission to the agent.** `POST /` with `"review
my changes at <scratch>"` and `selectedSkill: "review-diff"` completed
with:

```
=== Code Review ===
Path: C:\...\orchestrai-live-082-...
Files reviewed: 1

[math.ts:2] blocking
  This changes the clamp function to return `max` when the value is
  below `min`, which is incorrect. It should return `min` when the
  value is less than the minimum value.

Summary: Fixed a critical bug introduced in the clamp function where
it returns max instead of min when the value is below the minimum
threshold.
```

The exact real planted bug, cited at the exact real line (`math.ts:2`
is genuinely `if (value < min) return max`). The genuinely correct
`sum()` addition was never mentioned — no fabricated finding, and no
citation anywhere outside the real diff.

**Scenario 2 — the router names the skill with zero hardcoded routing
change.** With the real Orchestrator running and a real key configured
for its own LLM router, and every other agent pointed at an
unreachable stub port (isolating `code-review-agent` as the only
genuinely discoverable one), `GET /agents` confirmed exactly one agent
online:

```json
{"count":1,"agents":[{"name":"code-review-agent","url":"http://localhost:3007","status":"online","skills":["review-diff"],"lastSeen":"..."}]}
```

A natural-language `POST /tasks {"text": "review my changes at
<scratch>"}` — **no `selectedSkill` at all** — resolved to:

```json
{"id":"task-...","status":"assigned","assignedAgent":"code-review-agent","skill":"review-diff","isPlan":false}
```

purely from the live capability snapshot (the real Agent Card
discovered over HTTP), with the only code change anywhere in the
routing path being the single `KNOWN_AGENTS` line added earlier. The
dispatched task then completed end to end through the real Orchestrator
→ real agent → real MCP → real model round trip, producing the
identical real review result as Scenario 1.

All scratch artifacts (the temp git repo, `body-*.json`,
`scratch-submit-*.js`) and all three background processes (`mcp:http`,
`code-review-agent`, `orchestrator`) were removed after the pass;
`git status` is clean.

## What remains open (why `verification: partial`)

- A real `docker compose up` pass exercising the new service block —
  no Docker daemon was available in the implementing session, the same
  gap `specs/079`'s own `build-image`/`verify-deployment` criteria left
  open. The block's shape was reviewed by eye against `devops-agent`'s
  own already-working block, not executed.

Every other property named in this spec's own Acceptance Criteria,
including both of the roadmap's own named exit-gate scenarios (a real
planted issue caught, a real planted non-issue not invented) and the
router-naming confirmation, is verified live above.

## Docker Desktop live pass, 2026-09-14 — substantial progress, real
## bugs found and fixed, pass itself not completed

Once Docker Desktop became reachable on Yusuf's machine, a real
`docker compose build` + `up` pass was attempted directly (not a lab
setup). It surfaced **three genuine, previously-latent bugs** — none
specific to `code-review-agent` alone, all found only because this was
the first time any real git-based skill was actually dispatched
*through the compose network*, not just past a `/healthz` check:

1. **`Dockerfile`'s two-stage build silently dropped
   `@modelcontextprotocol/sdk`.** The `deps` stage only copied the root
   `package.json`/`bun.lock` before `bun install`, then the `runner`
   stage copied forward only the ROOT `node_modules`. On the current
   Bun version, `@modelcontextprotocol/sdk` (declared only in
   `packages/mcp`, `packages/agents/code-review`, `packages/agents/
   devops`, and `packages/shared` — never the root `package.json`)
   installs into each *requiring workspace's own* nested
   `node_modules` via a symlink into a shared `.bun` store, not hoisted
   to root. The old `deps` stage never propagated those nested
   symlinks forward, and `.dockerignore`'s `**/node_modules` rule
   stripped them from the subsequent `COPY . .` too — so `mcp:http`
   crashed on startup with `Cannot find module '.../
   webStandardStreamableHttp.js'`. Fixed by installing in the SAME
   stage as the final image, after the full workspace (every member's
   own `package.json`) is already copied in — confirmed via a direct
   `readlink -f`/module-resolution check inside the built image, then
   a real `bun run packages/mcp/http.ts` boot.
2. **`docker-compose.yml`'s `testing-agent`/`documentation-agent`
   blocks never set `ORCHESTRAI_MCP_URL`.** Both silently defaulted to
   `http://127.0.0.1:3006/mcp` inside their own containers — nothing
   listens there — and sat permanently in `mcp.state: "retrying"`.
   `/healthz` still returned `{status:"ok"}` throughout (only
   `dependencies.mcp.state` showed the problem), which is exactly why
   no prior "all healthy" pass ever caught this. Fixed by adding the
   same `ORCHESTRAI_MCP_URL`/`ORCHESTRAI_MCP_ALLOWED_HOSTS` pair
   `devops-agent`/`code-review-agent` already had; both agents
   confirmed `mcp.state: "connected"` afterward.
3. **`code-review-agent`'s own `handleReviewDiffSkill()` did a local
   `existsSync(base)` precondition check** against its own container's
   filesystem before ever calling MCP — but this agent deliberately has
   no volume mount (specs/082's own design, mirroring DevOps's no-mount
   pattern: it's a pure MCP client). That check always failed in
   exactly the deployment shape (compose) this agent exists to run in.
   `packages/agents/devops/index.ts` has no equivalent local check for
   its own MCP-backed skills — confirmed by grep — so this was a
   genuine, code-review-agent-specific gap, not a repeated pattern.
   Fixed by removing the check entirely; the real existence check
   already lives server-side in `git_diff`
   (`packages/mcp/index.ts:238-242`), which genuinely has the mount.
   `packages/agents/code-review/index.test.ts` updated to match (a
   nonexistent path now reaches a real MCP round trip instead of a
   local short-circuit); full suite re-confirmed green (980 pass, 2
   skip, 0 fail, typecheck clean) before this fix was applied to the
   image.

With fixes 1–3 applied and rebuilt, all 7 services reported genuinely
healthy with real `mcp.state: "connected"` (not just HTTP 200), the
Orchestrator's `/agents` showed all 5 real agents online including
`code-review-agent`, and a natural-language `review-diff` dispatch
through the real Orchestrator correctly named `code-review-agent`
purely from the live capability snapshot inside the compose network —
confirming the routing/discovery wiring this pass set out to prove.

**A fourth real gap was found and NOT fixed in this pass**: the base
image (`oven/bun:1-slim`) has neither `git` nor `curl` installed at
all. `git_status`/`git_diff`/`git_commit` (shelled out to via
`safeExec()`) have never actually worked through a real compose-network
call before this session — every skill needing them would fail with
`Executable not found in $PATH: "git"`, formatted as ordinary tool
output text (not a thrown error), which is why `review-diff`'s own
attempt reached "Could not parse any touched files from the diff" —
a real MCP round trip, genuinely reaching `mcp-http`, just with no
`git` binary to actually run. (The Dockerfile's own `HEALTHCHECK` line
also depends on `curl`, which is equally absent — masked by
`docker-compose.yml` overriding every service's healthcheck with a
`bun -e fetch(...)` test that never needed it.) A `RUN apt-get install
-y git curl` line was added to the `Dockerfile` to close this, but the
resulting full image rebuild did not complete: the host's `C:` drive
filled to 0 bytes free during this session's several diagnostic
rebuilds, which in turn crashed Docker Desktop's own engine
(`npipe:////./pipe/dockerDesktopLinuxEngine` became unreachable). Disk
space was subsequently freed (34GB confirmed available), but Docker
Desktop itself did not come back up again in this session — **the git/
curl fix and the actual `docker compose up` pass with a genuine
`review-diff` result are not yet confirmed live.**

**Net effect on this spec's own status**: still `verification:
partial`, for a different, more precise reason than before this pass —
not "never attempted" but "attempted, made real progress, found and
fixed 3 of 4 discovered bugs, blocked on the 4th by host infrastructure
(disk space → Docker Desktop crash) outside this session's control."
The `Dockerfile`/`docker-compose.yml`/`code-review-agent` fixes
(items 1–3) are committed regardless of the incomplete compose pass —
they are correct, live-reasoned fixes independently confirmed via
non-Docker evidence (direct image inspection, a real module-resolution
check, `bun test`/`typecheck`), not speculative. Item 4 (git/curl) and
the full end-to-end `docker compose up` + real `review-diff` result
remain the concrete next step whenever Docker Desktop is next
reachable — no code change beyond the already-added `apt-get install`
line is anticipated to be needed.

## Docker Desktop live pass, 2026-09-14 (same day, later) — item 4 closed

Disk was freed for real this time (deleting an unused WSL distro
recovered ~29 GB, from 4.5 GB free to 33.6 GB free — see
`context/worklog.md`'s same-day disk-recovery entry), Docker Desktop
was fully restarted (`taskkill` every Docker process, `wsl --shutdown`,
relaunch) and came back up cleanly (`docker version` → `29.7.2`, no
`500` error). A full `docker compose build` completed successfully for
all 8 images (7 agents/services + `mcp-http`, `coder-agent` included)
with the `apt-get install git curl` fix from the prior pass already in
the `Dockerfile` — confirmed via `docker exec devops-mcp-server-devops-
agent-1 sh -c "git --version && curl --version"`: `git version 2.47.3`,
`curl 8.14.1`, both genuinely present for the first time in this
codebase's Docker image.

`docker compose up -d` brought up all 8 containers; every service
confirmed via real `/healthz` (not container-level health checks
alone): `mcp.state: "connected"` for `devops-agent`, `testing-agent`,
`documentation-agent`, `code-review-agent`, and `coder-agent`, the
Orchestrator showing `agents: 6`, and `mcp-http` reporting `sessions: 5`
— every one of specs `082`/`083`'s new registration points confirmed
live and correctly wired inside the real compose network, not just unit
tests.

**The decisive check — item 4 itself.** A real scratch git repo was
created at `/tmp/gittest` inside the `mcp-http` container (`git init`,
a real commit, then a real uncommitted change to the same file). Two
real skills were then dispatched directly to `devops-agent`
(`http://localhost:3002/`) with an authoritative `selectedSkill`,
mirroring how `082`'s own earlier live passes isolated a single agent
when the Orchestrator's own LLM-only router (`specs/065`) had no
functional provider key available in this pass (a deliberate,
non-functional sentinel key was used only to satisfy `docker-
compose.yml`'s required-variable interpolation, matching `ci.yml`'s own
precedent of a non-functional key for a non-LLM check):

- **`git-status`** → `"Branch: master\n\nStatus:\nM f.txt\n\nLast 5
  commits:\n27665c0 init"` — correct, real branch/dirty-file/commit-log
  output.
- **`git-diff`** → a real, correct unified diff (`diff --git a/f.txt
  b/f.txt ... +world`) for the same uncommitted change.

Both completed with `status: "completed"` on the first real attempt —
`git`/`curl` genuinely work through the full compose network path
(agent container → MCP HTTP container → shelled-out `git` binary) for
the first time in this codebase's history. This is the exact gap item
4 above left open; it is now closed.

**Not exercised in this pass** (the LLM-gated skills, deliberately —
no real provider credentials were available in this session):
`review-diff` (Code Review) and `edit-file` (Coder) both fail closed
with no key configured, by design (`specs/082`/`083`'s own stated
fail-closed precedent) — their own real-model live passes were already
completed against a non-Docker stack in each spec's own original
verification and are not re-attempted here; this pass's own scope was
specifically the compose-networking/git-binary gap, not a second full
LLM pass.

**Status**: with items 1–4 all now confirmed live, there is no
remaining known gap in `specs/082`'s own Docker-compose acceptance
criteria. Full `bun test`/`typecheck` were not re-run in this pass (no
code changed since the last green run); the `Dockerfile`/`docker-
compose.yml` state is exactly what was already committed. Container
stack left running for continued use.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/082-code-review-agent/spec.md` (implemented, **verified**,
2026-09-12, Docker-compose gap closed 2026-09-14) is Phase D — the
roadmap's own deliberate
choice for "the first genuinely new agent, chosen because it writes
nothing and so needs no approval gate at all — the cheapest way to
prove new-agent integration end to end." A 5th agent, **`code-review-
agent`, port 3007** (3001, Planning Agent's own retired port, stays
retired per `specs/051`'s own convention — never reused). One skill,
**`review-diff`**: fetches the real staged+unstaged combined git diff
(the same shape DevOps's own `commit-changes` preview already uses),
reviews it via a real LangGraph tool-calling harness, and returns
grounded review comments as plain text. **No approval gate anywhere,
structurally** — no `resumeTask()`, no pending-actions map, no approve/
reject routes exist in this agent's code at all, mirroring Security's
own absence of them exactly.

**Design reversed once, on direct pushback, before implementation
began.** The first draft scoped the harness to diff-hunks-only (no
`read_project_file`, no LangGraph tool loop — mirroring Security's own
plain retry-only core, since with no tool to call the tool-loop
machinery would have no job). Yusuf's own framing after seeing that
draft — *"I will need the agent to review all"* — meant a hunk in
isolation, with no visibility into the rest of the file, was too
narrow a design. After a direct pros/cons comparison (real context and
fewer false positives/negatives vs. real token cost and a new
deleted-file failure mode), the final design adds `read_project_file`
back and uses a genuine LangGraph tool-calling loop — the same shape
DevOps's own harness (`specs/042`) already uses — so the model can read
a touched file's full real content before finalizing its review.

**The grounding constraint, inherited from `specs/043`'s CVE guard**:
every comment must cite a real file and a real line **genuinely present
in the diff's own post-image** (an added or context line — a removed
line is out of scope for this version, confirmed via AskUserQuestion).
`packages/agents/code-review/diff-grounding.ts`'s `parseUnifiedDiff()`
walks the real `@@ -a,b +c,d @@` hunk headers into a
`Map<file, Set<lineNumber>>`, and the harness's own validator
(`isGrounded()`) checks every returned comment against it — structurally,
not by prompt wording alone, the same enforcement style
`containsForbiddenVulnerabilityClaim()` already establishes.

**A self-review of the first draft (Yusuf: *"any recomendation"*)
surfaced a real design flaw before implementation, not after**: the
original validator discarded the *entire* review the moment any single
comment failed grounding after exhausted retries — throwing away a
real, correct finding alongside one hallucinated one. Revised to match
Security's own CVE-guard precedent more closely: retry the whole
response first (unchanged), but on final exhaustion, **salvage only
the grounded comments** and note how many were dropped; the task fails
closed only when **zero** comments survive grounding — genuinely
nothing trustworthy to report.

**Fail-closed, not Security's fail-open**: unlike Security's opt-in
commentary (a harness failure just omits a section; the deterministic
scan is always the real content), there is **no deterministic baseline
here at all** — reviewing a diff without an LLM produces nothing — so
`ORCHESTRAI_CODE_REVIEW_LLM_HARNESS` off, or on-but-misconfigured, both
fail every task closed with a named error, the same precedent
`specs/081`'s `write-tests` already established for the identical
reason.

**Proving the new-agent integration path was genuinely cheap, not just
claimed to be**: the entire routing change is one line —
`agentRegistry.codeReview` added to `apps/orchestrator/index.ts`'s
`KNOWN_AGENTS` — since `findAgentForSkill()`/`buildCapabilitySnapshot()`
already iterate the live registry generically with no per-agent branch
anywhere in the routing path, confirmed by reading the file before
relying on it. Every other registration point (service port, agent
registry URL, the supervisor's `SERVICE_STARTERS`/`AGENTS`, the guided-
init `AGENT_CATALOG`, `SKILL_TIER_REGISTRY`/`SUPERVISOR_ALLOWED_SKILLS`,
root `package.json` scripts, `docker-compose.yml`, `LLM_COMPONENTS`,
`AGENT_LLM_HARNESSES`) is a small, mechanical mirror of an existing
agent's own entry. **One genuine 7th registration point was found only
by `bun run typecheck`, not anticipated at spec-drafting time**:
`apps/supervisor/init-form.tsx`'s `PORT_ROW_LABELS` is a
`Record<ServicePortName, string>` (`specs/073`'s guided-init Ports
section) — TypeScript's own exhaustiveness check refused to compile
until `codeReview` was added there too, exactly the kind of gap a
`Record<T, ...>` type exists to catch.

**A real, non-obvious test-authoring bug was found and fixed while
writing this checkpoint's own harness tests, not a defect in the
harness itself**: the first version of the "salvage on exhaustion"
test reused the *same* `AIMessage` object instance across three
scripted retry responses. LangGraph's own message reducer dedupes
incoming messages by object identity/`.id` — replaying the identical
object was treated as a **replace** of the earlier turn in place, not
a new turn appended after the retry-feedback message, silently
corrupting which message the harness read as "the model's latest
response" on retries 2 and 3. Fixed by constructing a fresh `AIMessage`
per scripted attempt in the test, even when the text content is
identical — a real lesson about this test-double pattern, confirmed
not present in DevOps's own existing harness tests (which never happen
to reuse one object instance for two different textual responses).

**Live-verified against a real Gemini deployment, both of the
roadmap's own named exit-gate scenarios**: a real git repository with
`clamp()`'s comparison branches deliberately swapped (a genuine,
planted bug: `if (value < min) return max`) alongside a genuinely
correct new `sum()` function added in the same diff. The real review's
only comment correctly cited the exact real bug at `math.ts:2` and
never mentioned the correct addition — a real planted issue caught, a
real planted non-issue not invented. **The router-naming confirmation
was also live-verified through the real Orchestrator**: with every
other agent pointed at an unreachable stub port to isolate this one, a
natural-language `POST /tasks {"text": "review my changes..."}` with
no `selectedSkill` resolved to `{"assignedAgent":"code-review-agent",
"skill":"review-diff"}` purely from the live capability snapshot, and
the dispatched task completed end to end with the same real result.

980 tests pass (0 fail; net +18 over `specs/081`'s own 949 — six
pre-existing tests across `init-form-state.test.ts` needed updating for
the 5th agent joining shared tables, all legitimate behavior changes,
not test-only patches), typecheck clean, `specs:check` passed for 81
specs.

**A real `docker compose up` pass was attempted live on 2026-09-14 and
made substantial progress without fully completing.** It found and
fixed 3 genuine, previously-latent bugs, none specific to Code Review
alone — all only surfaced because this was the first time any real
git-based skill was ever dispatched *through the compose network*,
past a bare `/healthz` check: (1) `Dockerfile`'s two-stage build
silently dropped `@modelcontextprotocol/sdk` — Bun installs it into
each *requiring workspace's own* nested `node_modules` on the current
Bun version (never hoisted to root, since no root `package.json`
declares it), and the old `deps` stage only ever copied the root
`node_modules` forward; fixed by installing in the same stage as the
final image, after the full workspace is already copied in. (2)
`docker-compose.yml`'s `testing-agent`/`documentation-agent` blocks
never set `ORCHESTRAI_MCP_URL` — both silently sat in `mcp.state:
"retrying"` forever while `/healthz` still reported `{status:"ok"}`;
fixed by adding the same env pair `devops-agent`/`code-review-agent`
already had. (3) `code-review-agent`'s own `handleReviewDiffSkill()`
did a local `existsSync(base)` check against its own container's
filesystem before any MCP call — but it deliberately has no volume
mount (a pure MCP client, mirroring DevOps's no-mount pattern), so this
always failed in exactly the deployment shape it exists to run in;
DevOps has no equivalent check for its own MCP-backed skills. Fixed by
removing it — the real check already lives server-side in `git_diff`.
With all three fixed, every service reported genuinely `mcp.state:
"connected"` (not just HTTP 200), and a natural-language `review-diff`
dispatch through the real compose-networked Orchestrator correctly
named `code-review-agent` purely from the live capability snapshot,
confirming the routing/discovery wiring this item cares about. **A 4th
bug was found**: the base image (`oven/bun:1-slim`) had neither `git`
nor `curl` installed at all — `git_status`/`git_diff`/`git_commit` had
never actually worked through a real compose-network call before this
session. An `apt-get install git curl` line was added to the
`Dockerfile`; the host's disk then filled to 0 bytes free during this
session's several diagnostic rebuilds, crashing Docker Desktop's own
engine before the fix could be rebuilt and confirmed that day.

**Closed later the same day, 2026-09-14, once real disk space was
recovered** (deleting an unused WSL distro freed ~29 GB — see
`context/worklog.md`) and Docker Desktop was cleanly restarted: a full
rebuild confirmed `git`/`curl` genuinely present in the running
container (`git version 2.47.3`, `curl 8.14.1`), and real `git-status`/
`git-diff` dispatches through the full compose network (DevOps agent →
`mcp-http` → shelled-out `git`) both completed correctly against a real
scratch repo — a real branch/dirty-file/commit-log report and a real
unified diff. Every one of `specs/082`'s own registration points
(`mcp.state: "connected"` for all five MCP-backed agents, `agents: 6`
on the Orchestrator) confirmed live in the same pass. `specs/082` is
now `verification: verified`. See `specs/082`'s own `verification.md`'s
"Docker Desktop live pass, 2026-09-14 (same day, later)" section for
the complete transcript.

See specs/100-document-api-grounded-llm-route-discovery-fallback/verification.md for the relocated narrative covering this checkpoint.

See specs/103-deep-project-analysis/verification.md for the relocated narrative covering this checkpoint.

See specs/114-coder-multi-file-edit-and-create/verification.md for the relocated narrative covering this checkpoint.

See specs/083-coder-agent/verification.md for the relocated narrative covering this checkpoint.
