# OrchestrAI

A local, terminal-oriented multi-agent orchestration prototype for the
software development lifecycle. An Orchestrator discovers four specialized
agents (DevOps, Testing, Documentation, Security), routes tasks
to them using deterministic keyword matching — falling back to a small
local semantic classifier (not an LLM, no network call) only when no
keyword matches — turns multi-step requests into an adaptively-dispatched
plan via its own LangGraph supervisor, and enforces human approval for
write-capable operations. Browser dashboards are the primary interface; an
interactive terminal UI (`apps/tui`) and a process supervisor (`bun run
orchestrai`, also shippable as one standalone binary) run alongside them.
The Orchestrator requires a configured LLM provider key to start at all
(`specs/051` — it is the only `plan-task` planner; see below).

<p align="center">
  <img src="https://img.shields.io/badge/maintained-yes-brightgreen" alt="Maintained">
  <a href="https://github.com/OrchestrrAI/orchestrAI/actions/workflows/ci.yml"><img src="https://github.com/OrchestrrAI/orchestrAI/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/orchestrai"><img src="https://img.shields.io/npm/v/orchestrai?logo=npm&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/orchestrai"><img src="https://img.shields.io/npm/l/orchestrai?label=license" alt="License"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Bun-1.x-000000?logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/TypeScript-7.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Hono-4.x-E36002?logo=hono&logoColor=white" alt="Hono">
  <img src="https://img.shields.io/badge/SQLite-bun%3Asqlite-003B57?logo=sqlite&logoColor=white" alt="SQLite">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/LangGraph-1.4-1C3C3C?logo=langchain&logoColor=white" alt="LangGraph">
  <img src="https://img.shields.io/badge/MCP%20SDK-1.30-6E56CF" alt="MCP SDK">
  <img src="https://img.shields.io/badge/AG--UI-0.0.58-0A7EA4" alt="AG-UI">
  <img src="https://img.shields.io/badge/OpenTUI-0.5-555555" alt="OpenTUI">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-1631%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/typecheck-0%20errors-brightgreen" alt="Typecheck">
  <img src="https://img.shields.io/badge/specs-142-8A2BE2" alt="Specs">
  <img src="https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" alt="Platforms">
</p>

See [CLAUDE.md](CLAUDE.md) for the full architecture, current source of
truth for implemented behavior, and the operating guide this project's
own coding agents follow.

Feature and architecture changes follow Spec-Driven Development. Read the
[spec governance guide and catalog](specs/README.md) before adding or changing
a specification; lifecycle status and verification confidence are tracked
separately and checked in CI. Each feature has an immutable numbered directory
containing mandatory `spec.md` and optional, non-empty `plan.md` and
`verification.md` artifacts when the work needs them.

## Project Structure

```
apps/               # Orchestrator, terminal UI, process supervisor
context/            # Handoff notes, history, dated worklog
models/             # Fetched by `bun run fetch-model`, gitignored — not in the repo
packages/
  agents/           # DevOps, Testing, Documentation, Security
  mcp/              # Shared MCP tools + stdio/HTTP entrypoints
  shared/           # Shared protocol types, MCP client, path resolution, intent classifier
scripts/            # bun run build's standalone-binary compiler, fetch-model
specs/              # Numbered SDD checkpoints + schema/templates/catalog
.github/workflows/  # CI (typecheck+test) and cross-platform binary builds
Dockerfile, docker-compose.yml
CLAUDE.md           # Operating guide and architecture — read this first
```

## Getting Started

```
bun install
bun run mcp  # bun run packages/mcp/stdio.ts
bun run mcp:http  # bun run packages/mcp/http.ts
bun run devops-agent  # bun run packages/agents/devops/index.ts
bun run testing-agent  # bun run packages/agents/testing/index.ts
bun run documentation-agent  # bun run packages/agents/documentation/index.ts
bun run security-agent  # bun run packages/agents/security/index.ts
bun run orchestrator  # bun run apps/orchestrator/index.ts
bun run tui  # bun run apps/tui/index.tsx — interactive: approve/reject, submit tasks, filter by agent
bun run test  # bun test
bun run dev  # bun run --parallel mcp:http devops-agent testing-agent documentation-agent security-agent orchestrator
bun run dev:with-mcp  # bun run --parallel mcp:http devops-agent testing-agent documentation-agent security-agent orchestrator
bun run dev:with-all-mcp  # bun run --parallel mcp mcp:http devops-agent testing-agent documentation-agent security-agent orchestrator
bun run orchestrai  # bun run apps/supervisor/index.ts — see below
bun run fetch-model  # bun run scripts/fetch-model.ts — see below
bun run build  # bun run scripts/build-binary.ts — see below
bun run typecheck  # tsc --noEmit
bun run specs:catalog  # validate specs and regenerate Markdown/JSON catalogs
bun run specs:check  # read-only metadata/catalog validation used by CI
```

### `bun run orchestrai` — the supervisor

An alternative to `bun run dev` (which stays as the simple original
option) — a single-entry supervisor (`specs/016-orchestrai-supervisor/spec.md`)
that adds port preflight (refuses to start anything if a target port is
already in use, naming exactly which one), ordered startup (the MCP HTTP
server and all 4 agents first, gated on real `/healthz` readiness, then the
Orchestrator last), prefixed logs per service, a startup summary, and a
clean shutdown that doesn't orphan child processes. The Orchestrator
requires a resolvable LLM provider key to start — `bun run orchestrai`
refuses to start at all otherwise (`specs/051`), since it is the only
`plan-task` planner.

```
bun run orchestrai                                    # start everything
bun run orchestrai --only devops-agent                # just DevOps (+ mcp:http, auto-included with a note)
bun run orchestrai --only security-agent,testing-agent  # just these two
bun run orchestrai --help
```

Run `bun run orchestrai init` (or `i`) once per project for an interactive
setup wizard (`specs/031-interactive-init-wizard/spec.md`) — asks for the
target path, which agents to run, each selected agent's own optional LLM
harness (DevOps/Documentation/Security — `specs/050`), and a provider/
model/key, unconditionally (`specs/051` — the Orchestrator's own adaptive
supervisor always needs one, so this is no longer gated behind a toggle),
then writes `<target>/.orchestrai/` so a plain `orchestrai` afterward
needs no flags at all. An explicit flag or an already-set env var always
still overrides what was saved. The API key is saved in plaintext (a
deliberate call for a local demo tool, not an oversight); `.orchestrai/`
is auto-added to `.gitignore` when run inside a git repository.

### Live activity: the AG-UI event stream

`specs/021-ag-ui-event-protocol/spec.md`. The Orchestrator's `GET /events` SSE
channel emits [AG-UI](https://docs.ag-ui.com)-shaped events, so both the
browser dashboard and the terminal UI show what an agent is doing **while
it works** rather than only once a task finishes:

- `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` — a task's lifecycle
- `STEP_STARTED` / `STEP_FINISHED` — each dispatched plan step
- `TOOL_CALL_START` / `TOOL_CALL_RESULT` — every MCP tool call and direct
  agent-to-agent call, with its caller, outcome, and duration
- `CUSTOM` — approval-required/resolved signals (informational only;
  approving still requires the real `POST /tasks/:id/approve`)
- `STATE_SNAPSHOT` — sent on connect, so a client joining mid-run isn't blank

The event schema is sourced from the official `@ag-ui/core` package
(`specs/027-ag-ui-core-adoption/spec.md`, pinned exact version), and every
emitted event is runtime-validated against its real schema before reaching
the SSE stream — not just typed against it. Agents push their audit events
to the Orchestrator best-effort and never block on it — an agent run
standalone with no Orchestrator works exactly as before.

Run the cross-platform, non-mutating AG-UI proof from a second terminal after
the stack is healthy:

```text
bun run demo:ag-ui -- --project C:\absolute\path\to\a\test-project
```

The Bun runner works natively on Windows and Linux, checks the Orchestrator,
all four agents, and MCP before starting, captures the raw event stream under
the OS temporary directory, and verifies MCP, direct A2A, rejected approval,
plan-step, semantic-route, and caller-minted correlation scenarios. Its
default mode never approves a write and verifies that the target's working
tree fingerprint did not change. `--allow-writes` adds one approved
`.gitignore` fixture write, refuses this repository (or a directory inside
it), names the exact external target prominently, and leaves cleanup to the
human operator.

### Planning Agent — retired

Earlier versions of OrchestrAI routed `plan-task` through a separate
Planning Agent (`:3001`), first deterministically and later through its
own opt-in LangGraph harness (`specs/026`/`029`/`030`). `specs/051-
planning-retirement-and-required-key/spec.md` (implemented, 2026-09-05)
deleted that agent entirely: `suggest-agents` is now served directly by
the Orchestrator, and `plan-task` has exactly one path — the adaptive
supervisor below, unconditionally. See `CLAUDE.md`'s "Planning Agent
(retired)" section for the full historical record and what replaced it.

### Adaptive supervisor — the Orchestrator's only `plan-task` planner

`specs/028-orchestrator-langgraph-supervisor/spec.md` (implemented,
**verified** — every automated safety test plus a live run against a real
Gemini deployment, covering adaptive re-planning, the approval gate, a
real rejection confirmed terminal, and a bound terminating cleanly, all
with real evidence in that spec's own `verification.md`) built the
mechanism. As of `specs/051-planning-retirement-and-required-key/spec.md`
it is the Orchestrator's **only** `plan-task` planner and a **required**
component, not an opt-in one: `bun run orchestrai` refuses to start at
all (named error, points at `orchestrai init`) unless a provider key
resolves for the Orchestrator, and for any agent whose own harness flag
is on. `plan-task` requests route through a LangGraph loop that decides
**one skill at a time from what previous steps actually returned** —
there is no flag to route it anywhere else, and no fallback left to fall
back to. `detectSkill()` is untouched — a direct-routed request never
reaches this path either way. The startup log always states the resolved
provider/model and why.

The approval gate is outside the graph structurally: the model can't
supply, see, or influence an `actionId`. A human rejection is terminal —
the supervisor is never re-consulted, detected from the Orchestrator's own
record of forwarding it, never from status or error text (a rejection and
a genuine failure currently look identical by status alone). Adaptation is
only ever permitted after a **read-only** skill's failure — a write-capable
skill's unexplained failure ends the run and asks a human to check the
target's real state, rather than guessing nothing happened. Two independent
bounds stop a runaway run. See `CLAUDE.md`'s own section on this for the
full detail, including a real event-correlation bug found and fixed during
its own verification.

### Per-component LLM provider configuration

`specs/039-per-component-llm-provider-config/spec.md` (implemented,
**verified**). Every LLM-capable component used to share the exact same
provider/model/key. Set `ORCHESTRAI_<COMPONENT>_LLM_PROVIDER` / `_MODEL`
/ `_API_KEY` (component is `ORCHESTRATOR`, `DOCUMENTATION`, `DEVOPS`,
`SECURITY`, or `CONVERSATION` — `"planning"` was removed from this set by
`specs/051` along with Planning Agent itself) to override just that
component — any field left unset falls back to the shared
`ORCHESTRAI_LLM_*` variables, so sharing a key while pointing the
supervisor at a stronger model (say) is one line. Omitting component-
specific variables entirely is byte-identical to before this spec —
live-verified with a config in the exact pre-039 shape.

### Opt-in LLM harness — Documentation's generate-readme and document-api

`specs/041-llm-harness-documentation/spec.md` (implemented, **verified**).
Set `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=1` (one flag gating both write
skills together) alongside the same shared LLM variables above. Mirrors
Planning's own harness pattern — one read-only tool (`read_project_file`),
no write-capable tool ever bound, fail-closed (never a silent fallback to
either deterministic path) once the flag is active.

The two skills get genuinely different designs, not the same change
twice: `generate-readme` explores the project freely since it has nothing
reliable to ground on; `document-api` is *given* the already-
deterministically-discovered route list (`scanApiRoutes()`, unchanged —
route discovery itself never becomes the model's job) and asked to write
better documentation for those specific routes, with a grounding check
confirming every discovered route is actually covered. When a prior
README exists, its content is passed directly as context (reusing
`specs/040`'s own already-fetched value, no extra tool call) with
instructions to preserve what's still accurate rather than rewrite
blindly — live-proven with a planted marker sentence that survived
byte-for-byte into the generated output alongside genuinely new content.
Binary size delta: +28,160 bytes, zero new dependency.

### Opt-in LLM harness — DevOps's smarter parameters, same templates

`specs/042-llm-harness-devops/spec.md` (implemented, **verified**). Set
`ORCHESTRAI_DEVOPS_LLM_HARNESS=1` (one flag gating all four write
skills). Deliberately narrower than Documentation's harness: the model
decides *parameters* fed into DevOps's existing, unmodified Dockerfile/
CI/gitignore/compose templates — it never authors file content itself,
since these files are actually executed (`docker build`, a real CI
pipeline), not just read.

Fixes three real, evidence-confirmed gaps: `app_type` used to be guessed
from the task text's own wording (defaulting to `bun` when nothing was
named, wrong for any unnamed-language project); `create-ci`'s
`include_docker` was hardcoded `false` regardless of whether a Dockerfile
actually existed; `create-compose` always produced exactly one hardcoded
service, never detecting a real database dependency. One new tool added
— `read_project_file` (DevOps previously only had structural checks via
`analyze_project`) — justified by these gaps needing real file content.
Live-verified with a directly contrasted before/after: a real Python
project with no language named in the request got `app_type: "python"`
with the flag on, and the exact old (wrong) `app_type: "bun"` with it
off, against the same real compiled binary. Binary size delta: +14,336
bytes, zero new dependency.

### Opt-in LLM harness — Security's additive commentary, never a filter

`specs/043-llm-harness-security/spec.md` (implemented, **verified**). Set
`ORCHESTRAI_SECURITY_LLM_HARNESS=1` (one flag gating all three read-only
skills' commentary layer). The most different of the three harnesses:
Security has no write skills and no approval gate at all, so the LLM's
role is **strictly additive commentary on findings the deterministic
scan already produced** — it never runs its own scan and can never
remove, downgrade, or reorder a finding, enforced by the shape of its
output schema, not just a prompt. No new tool access was added (every
enhancement runs entirely on data the scan already computed), so this
harness skips LangGraph too — a single structured-output completion per
skill with a bounded retry-with-feedback loop.

Closes three real gaps: `scan-secrets`'s hardcoded placeholder list
misses values like `"CHANGE_ME_IN_PRODUCTION"`; `check-gitignore-
coverage` checks a fixed universal pattern list with no awareness of
what a specific project actually contains (e.g. a real
`terraform.tfstate` file); `audit-dependencies` only flags a version
string that's exactly `"*"` or `"latest"`. Because this agent has no
live vulnerability-database access, its dependency commentary is
structurally forbidden from asserting a specific CVE or version-range
claim — the validator rejects and retries any that appear, not just a
prompt instruction. A harness failure never fails the task (the
deterministic findings are already safe on their own): it appends an
explicit `"AI commentary unavailable: <reason>"` line instead — a
deliberate, live-proven departure from the other two harnesses' "fail
the whole task" precedent. Live-verified against a real Gemini
deployment with all three gaps deliberately reproduced in a scratch
project; the flag-unset output confirmed byte-identical to before this
spec. Binary size delta: +13,824 bytes, zero new dependency.

### Conversational ask layer — questions, not just tasks

`specs/044-conversational-ask-layer/spec.md` (implemented, **partial** —
the TUI chat view needs a real-terminal test, the one gap left; every
server-side and deterministic property is live-confirmed). A new
question-shaped entry point, `POST /ask { question, conversationId? }`,
alongside the existing task-shaped `POST /tasks` — which stays completely
unchanged, proven by the existing suite passing untouched.

Every question resolves to one of three tiers, **deterministically**:
answerable from live state with no dispatch at all (*"what agents do you
have?"*); a read-only skill, dispatched with no approval; or a
write-capable skill, which still stops at the exact same approval gate
as today — asking *"is there test coverage?"* still needs your OK to run
`pytest --cov`, just framed as a sentence in the thread instead of a
modal from nowhere.

With a key configured (key-gated like `038`'s supervisor, not
flag-gated), a natural-language answer is synthesized **only** from
material the deterministic path already produced, with a bounded
grounding check rejecting any figure the source doesn't support and
**failing open** to the raw result rather than the whole task — the raw
result was always a complete, safe answer on its own. Live-verified with
a real Gemini deployment on the exact question that started this
checkpoint: *"is there test coverage?"* → approved → *"Yes, there is
test coverage, and it is at 100% for lines across all files, with all 4
tests passing"* — correctly reading the line-coverage figure over the
funcs figure sitting right beside it, full raw report still present
underneath. Also fixed on its own, no LLM required: `check-coverage`
now actually surfaces its coverage percentage, extracted from real
captured runner output (Bun and pytest), rather than leaving it buried
in the raw dump.

The browser dashboard is now a Chat-first workspace with three connected
views: **Chat**, **Tasks**, and **Agents** (`specs/046`, implemented with
partial verification). Chat lists the existing bounded in-memory threads and
shows the real linked task/approval in context; Tasks retains the complete
advanced submission, evidence, filtering, details, and approval surface;
Agents retains capability and registration controls. Hash links preserve view
and selected IDs, and the page still uses one shared `/events` connection. The
responsive/keyboard/browser-history matrix remains explicitly pending because
no browser backend was available in the implementation session.

The TUI remains the separate full-screen chat view (`k`) from spec 044; its
planned Chat/Tasks/Agents navigation belongs to unapproved spec 047 and was not
changed by the browser checkpoint.

### `bun run fetch-model` — optional local semantic routing fallback

`specs/020-semantic-intent-fallback/spec.md`. The Orchestrator's `detectSkill()`
is keyword matching first, always — a small local classifier only runs
when no keyword branch matches at all, e.g. `"can you check if my tests
still pass"` (no `"test"`/`"coverage"` keyword to match, but still clearly
a testing request). It uses `minishlab/potion-base-8M` (Model2Vec static
embeddings: tokenize → look up one vector per token → mean-pool → cosine
similarity — no inference engine, no network call, not an LLM) to route
requests keyword matching can't reach, falling back to `plan-task` exactly
as before when confidence is too low.

```
bun run fetch-model                    # downloads + checksum-verifies the ~30 MB model into models/
```

Optional for everything except `bun run build`:

- Skip it and `bun install`/`bun test`/`bun run typecheck`/every
  `bun run <service>` all still work — `detectSkill()` degrades to
  keyword-only routing, byte-identical to before this feature existed.
- `models/` is gitignored; the weights are never committed.
- **`bun run build` is the one exception — run this first, or the build
  fails outright.** `bun build --compile` needs the model files to exist
  on disk to embed them; it doesn't degrade gracefully like everything
  else does. `.github/workflows/build-binaries.yml` runs this step before
  `bun run build` for exactly this reason.

### `bun run build` — one standalone executable, no Bun required to run it

`specs/017-standalone-binary-distribution/spec.md`. Compiles the entire
runtime — all 4 agents, the MCP HTTP server, the Orchestrator, the
supervisor, and the TUI — into **one** ~137 MB executable via `bun build
--compile`, including the semantic classifier above. **Requires `bun run
fetch-model` to have been run first** — see above; the build fails
outright without it. Once built, the target machine needs neither Bun nor
this source tree.

```
bun run fetch-model                    # required first — see above
bun run build                          # once, on a machine with Bun + this source
./dist/bin/orchestrai                  # starts everything (orchestrai.exe on Windows)
./dist/bin/orchestrai service security-agent   # just one service
./dist/bin/orchestrai tui              # the terminal viewer
./dist/bin/orchestrai --help
```

Host-platform-only in this pass (no cross-compilation matrix yet).

### How the compiled binary finds your project

`specs/018-supervisor-project-path/spec.md`. The supervisor resolves
`ORCHESTRAI_PROJECT_PATH` for its children in this order (first match
wins, printed at startup either way):

1. `--project <path>` on the command line
2. an already-set `ORCHESTRAI_PROJECT_PATH` environment variable
3. an `orchestrai.project.txt` file sitting next to the `.exe` (one line,
   an absolute path) — compiled mode only
4. the directory you ran it from

```
.\dist\bin\orchestrai.exe --project "C:\path\to\your-project"
```

A per-task explicit path in the task text always still works regardless
of any of this.

### Getting a binary without building it yourself

`.github/workflows/build-binaries.yml` builds Windows, Linux, and macOS
(Apple Silicon, unsigned) binaries natively (one per platform's own
GitHub Actions runner, not cross-compiled) on every push to `main`,
smoke-tests each one, and publishes them to a rolling **`latest` GitHub
Release** — a stable, permanent link, not a workflow-run artifact that
expires. Grab them from the repo's **Releases** page instead of running
`bun run build` locally. Note: this repository is currently private, so
that Release page needs repository access — it is not a public download
link. A cross-compiled Linux build from a Windows machine is also
possible (`bun install --os=linux --cpu=x64` first, then `bun build
--compile --target=bun-linux-x64 ...`) but produces a larger binary
(~134 MB vs. ~106 MB) and can't be verified on the machine that built it
— CI's native-per-platform approach is the reliable path.

### `bunx orchestrai` / `npx orchestrai` — no clone, no download step

`specs/032-npm-package-distribution/spec.md`: the same binaries are also
published as npm packages, independent of the GitHub Release above (and
independent of this repo's visibility — see that spec for why the
GitHub-Releases-download design it started with had to be reworked).

```
bunx orchestrai --project /path/to/your/project
npx orchestrai --project /path/to/your/project
```

npm installs exactly one small binary-only package matching your
platform (`orchestrai-windows-x64`/`orchestrai-linux-x64`/
`orchestrai-darwin-arm64`) as an optional dependency of the thin
`orchestrai` package you actually run — no custom download or checksum
code, npm's own registry verifies package integrity as part of a normal
install. **All four packages are published and live, consistently
cross-pinned at `0.1.4`** (the Windows package was renamed from its
original `orchestrai-win32-x64` after npm's spam-detection filter
rejected that name on three separate live attempts; see `specs/032`'s
verification.md for the full trail, including a genuine automated-CI
failure/fix pair found while getting the `publish-npm` GitHub Actions
job to run for real for the first time). Windows installs are
real-machine verified end to end (`npm install orchestrai` in a fresh
directory correctly resolved the platform package and ran the real
binary); Linux/macOS installs are not yet verified from an external
machine, only published.

## Running with Docker

The full 6-service stack (`specs/009-dockerization/spec.md`, live-verified
end to end when it was originally a 7-service stack; Planning Agent's
container was removed by `specs/051`):

```
docker compose up
```

`ORCHESTRAI_HOST_TARGET_PATH` (set before running) bind-mounts the target
project into the containers that actually touch files.
`ORCHESTRAI_LLM_API_KEY` must also be set on the host — the orchestrator
container's own adaptive supervisor requires a resolvable key to start at
all (`specs/051`); Compose refuses to start it otherwise. A single service
can still be built/run in isolation from the shared `Dockerfile` if
needed:

```
docker build -t orchestrai .
docker run -p 3000:3000 orchestrai
```

## CI/CD

This project runs its pipeline via GitHub Actions — see `.github/workflows/`.
