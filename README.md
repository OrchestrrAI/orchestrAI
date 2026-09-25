# OrchestrAI

A local, terminal-oriented multi-agent orchestration system for the software
development lifecycle. A central Orchestrator coordinates six specialized
agents (DevOps, Testing, Documentation, Security, Code Review, and Coder),
decides what to run with an LLM capability router and an adaptive LangGraph
supervisor, and keeps a human approval gate in front of every write or
command.

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

## Overview

The Orchestrator talks to its agents over two protocols:

- **A2A-style HTTP tasks**: a small, project-specific agent-to-agent task
  protocol between the Orchestrator and each agent (not the full official A2A
  specification).
- **MCP (Model Context Protocol)**: five agents use a shared MCP server for
  git, Docker, project analysis, file access, and approved command execution.

You work with it through a browser dashboard or an interactive OpenTUI
terminal client. Both support chat, task submission, approve/reject/skip,
filtering, an audit view, and live activity streamed as AG-UI events.

**Key characteristics**

- **LLM-routed, human-governed.** One capability-router call picks a skill.
  Multi-step requests go to a LangGraph supervisor that chooses one step at a
  time from what earlier steps actually returned. The model never sees or
  controls the approval gate.
- **Approval as a safety boundary.** Every write or command shows a preview
  with the exact content or command. The approval is bound to a random
  `actionId` and a content fingerprint, and the target is re-checked just
  before the write.
- **Fail-closed by default.** With no provider key, or a harness that fails,
  the task fails with a named error rather than silently falling back.
- **Local first.** Everything runs on your machine, and the MCP server
  accepts loopback connections only. The optional SQLite store is one local
  file under the target project's `.orchestrai/` folder, and OrchestrAI's own
  file tools cannot read that folder.
- **Spec-driven.** Every behavioral or architectural change goes through a
  numbered, reviewed spec before implementation (142 checkpoints so far).
- **One binary.** The whole runtime compiles to a single executable, also
  published on npm as `orchestrai`.

This is a hackathon-grade prototype. It prefers a reliable end-to-end demo and
clear safety boundaries over production infrastructure: there is no
authentication, authorization, or production sandbox.

## Technology stack

| Layer | Technology |
|---|---|
| Runtime and language | Bun 1.x, TypeScript 7 (`tsc --noEmit` type checking) |
| HTTP services | Hono 4 |
| LLM orchestration | LangGraph 1.4 and LangChain, with Anthropic, OpenAI, and Google providers |
| Agent protocol | Custom A2A-style HTTP task protocol |
| Tool protocol | MCP SDK 1.30 (Streamable HTTP for agents, stdio for external clients) |
| Validation | Zod |
| Live events | AG-UI (`@ag-ui/core` 0.0.58) over Server-Sent Events, runtime-validated |
| Persistence | SQLite via `bun:sqlite` (optional, fail-open, no extra dependency) |
| Terminal UI | OpenTUI 0.5 with React 19 |
| Browser UI | Server-rendered HTML with inline JavaScript, no build step |
| Distribution | `bun build --compile` binary, npm packages, Docker Compose |

## Architecture

```text
User (browser dashboard or OpenTUI terminal client)
        |
        | HTTP + SSE (AG-UI events)
        v
Orchestrator :3000  (capability router, LangGraph supervisor, approvals, chat)
        |
        | A2A-style HTTP tasks
        |
        +--> DevOps Agent         :3002
        +--> Testing Agent        :3003
        +--> Documentation Agent  :3004
        +--> Security Agent       :3005   (direct, read-only file access)
        +--> Code Review Agent    :3007
        +--> Coder Agent          :3008

DevOps, Testing, Documentation, Code Review, Coder
        |
        | MCP Streamable HTTP (loopback only)
        v
MCP HTTP Server :3006  (git, Docker, analysis, file and command tools)

DevOps Agent ---- optional direct A2A pre-check ----> Security Agent

External MCP clients ---- MCP over stdio ----> MCP stdio server (same tools)
```

**Request flow**

1. A request arrives at `POST /tasks` or, for chat, `POST /ask`.
2. One LLM capability-router call picks a skill from the live set of online
   agents. It can also return `plan-task` or say the request is unsupported.
3. A single-skill request goes straight to the agent that owns that skill.
   A `plan-task` request goes to the adaptive supervisor, which dispatches
   child tasks one decision at a time. Independent steps can run in parallel.
4. The receiving agent runs exactly the skill it was sent and uses MCP tools
   to do the work. A write or command pauses in `input-required` with a
   preview until a human approves, rejects, or skips it.
5. The Orchestrator streams run, step, tool-call, and approval events to the
   dashboard and TUI over `GET /events`.

**Agents and skills**

| Port | Service | Skills |
|---|---|---|
| 3000 | Orchestrator | Routing, `plan-task`, `suggest-agents`, approvals, chat (`/ask`), dashboard, AG-UI event stream |
| 3002 | DevOps | `dockerize`, `create-ci`, `create-gitignore`, `create-compose`, `analyze-project`, `git-status`, `git-diff`, `docker-status`, `build-image`, `verify-deployment`, `commit-changes`, `run-command` |
| 3003 | Testing | `run-tests`, `check-coverage`, `write-tests` |
| 3004 | Documentation | `generate-readme`, `document-api` |
| 3005 | Security | `scan-secrets`, `check-gitignore-coverage`, `audit-dependencies` (read-only) |
| 3006 | MCP HTTP server | 12 tools shared by the agents |
| 3007 | Code Review | `review-diff` (read-only) |
| 3008 | Coder | `edit-file`, `edit-files`, `edit-and-verify` |

Every port can be changed with `ORCHESTRAI_<SERVICE>_PORT`. Each agent also
serves `GET /.well-known/agent.json`, `GET /healthz`, task endpoints, and its
own dashboard.

## Codebase at a glance

Measured on 2026-09-25. Line counts are physical lines (as `wc -l` counts
them) and exclude dependencies and build output.

| Metric | Value |
|---|---:|
| Services | 8 (Orchestrator, 6 agents, MCP server) |
| MCP tools | 12 |
| Production TypeScript | ~35,000 lines in 79 files |
| Test TypeScript | ~22,000 lines in 94 files |
| Test cases / `expect` assertions | ~1,590 / ~3,200 |
| Latest full test run | 1,631 pass, 2 skipped (need a Docker daemon), 0 fail |
| Type errors (`tsc --noEmit`) | 0 |
| Spec checkpoints | 142 (137 implemented) |

Where the production code lives:

| Area | Approx. lines |
|---|---:|
| Six agents and their LLM harnesses (`packages/agents/`) | ~10,000 |
| Terminal UI and init forms (`apps/tui/`, `apps/supervisor/`) | ~6,000 |
| Orchestrator backend (`apps/orchestrator/`) | ~5,000 |
| Shared library: protocol, router, LLM factory, audit, MCP client (`packages/shared/`) | ~4,500 |
| Browser dashboards (HTML embedded in each service) | ~2,700 |
| Process supervisor and init CLI (`apps/supervisor/`) | ~2,600 |
| SQLite persistence (`store.ts`, `pending-action-store.ts`) | ~900 |
| MCP server and tools (`packages/mcp/`) | ~900 |

Tests are mostly unit tests of pure logic (routing validation, dispatch
outcomes, approval previews, diffs, fingerprints, parsers, TUI layout) plus
in-process integration tests (HTTP endpoints, real SQLite, temp projects, MCP
client and server). A dedicated adversarial set covers path traversal,
symlink escape, secret-file denial, duplicate task IDs, and stale approval
IDs. CI also starts a real two-service stack on every push, and the release
workflow smoke-tests the compiled binary on Windows, Linux, and macOS.

## Project structure

```text
apps/
  orchestrator/        # Orchestrator API, routing, LangGraph supervisor, dashboard
  tui/                 # Interactive OpenTUI terminal client
  supervisor/          # `bun run orchestrai` process supervisor and guided init
packages/
  agents/
    devops/            # Docker, CI, git, project analysis, approved commands
    testing/           # Test runs, coverage, test authoring
    documentation/     # README and API documentation
    security/          # Read-only secret, config, and dependency scans
    code-review/       # Read-only diff review
    coder/             # Approval-gated source edits and edit-verify loop
  mcp/                 # Shared MCP tools with separate stdio and HTTP entrypoints
  shared/              # Protocol types, router, LLM factory, store, audit, AG-UI
scripts/               # Binary build, spec catalog, demo rehearsal and preflight
specs/                 # Numbered spec checkpoints, schema, and generated catalog
context/               # Project notes, dated worklog, demo app and runbook
npm-package/           # Thin `orchestrai` npm launcher
.github/workflows/     # CI (typecheck, tests, live smoke) and binary builds
Dockerfile, docker-compose.yml
```

## Getting started

You need [Bun](https://bun.sh) 1.x and an API key for an LLM provider
(Anthropic, OpenAI, or Google). Routing, planning, and every file-writing
skill need a key. Without one, requests fail with a named error.

**Run without cloning** (downloads the prebuilt binary for your platform):

```text
bunx orchestrai --project /path/to/your/project
npx orchestrai --project /path/to/your/project
```

**Run from source:**

```text
bun install
bun run orchestrai init      # guided setup: provider keys, agents, models, ports
bun run orchestrai           # start MCP, agents, and the Orchestrator, then open the TUI
```

Then open the dashboard at <http://localhost:3000/dashboard>, or use the
terminal UI that `bun run orchestrai` opens. `init` saves its settings to
`<project>/.orchestrai/config.env`, stores the API key there in plaintext, and
adds `.orchestrai/` to `.gitignore`.

**Common commands**

| Command | What it does |
|---|---|
| `bun run orchestrai` | Supervisor: port checks, ordered startup, prefixed logs, clean shutdown |
| `bun run orchestrai --only <service,...>` | Start only some services |
| `bun run dev` | Start MCP HTTP, all six agents, and the Orchestrator in parallel (no supervision) |
| `bun run tui` | Terminal client on its own |
| `bun run <service>` | One service: `orchestrator`, `devops-agent`, `testing-agent`, `documentation-agent`, `security-agent`, `code-review-agent`, `coder-agent`, `mcp:http`, or `mcp` (stdio) |
| `bun test` | Full test suite |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run specs:catalog` / `bun run specs:check` | Regenerate / validate the spec catalog |
| `bun run build` | Compile everything into `dist/bin/orchestrai` (run `bun run fetch-model` first) |
| `bun run demo:preflight` / `bun run demo:ag-ui` | Demo readiness report / scripted AG-UI rehearsal |

## Development workflow

Feature and architecture changes follow Spec-Driven Development. Read the
[spec governance guide and catalog](specs/README.md) before adding or changing
a specification. Each change gets an immutable numbered directory under
`specs/` with a mandatory `spec.md` and, when needed, `plan.md` and
`verification.md`. Lifecycle status and verification confidence are tracked
separately and checked in CI. `AGENTS.md` holds the rules coding agents
follow in this repo, and `context/worklog.md` is the dated handoff log.

Before merging, run `bun test`, `bun run typecheck`, and `bun run specs:check`.

## Feature notes

The sections below were written as each feature landed. Some describe earlier
behavior (for example four agents, keyword routing, or opt-in harnesses). The
[spec catalog](specs/README.md) is the authoritative record of what is
implemented now.

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
supervisor below, unconditionally. See `specs/051` for the full historical
record and what replaced it.

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
bounds stop a runaway run. See `specs/028`'s `verification.md` for the
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
