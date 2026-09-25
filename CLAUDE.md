# CLAUDE.md

This file is the operating guide for Claude Code and other coding agents working in this repository. It holds **current state only** — present-tense architecture, conventions, gates, and commands — under a hard 150,000-character budget enforced by `bun run specs:check`. Per-spec historical narrative lives in each spec's `verification.md` (see "Where history lives" below).

## Project

OrchestrAI is a local, terminal-oriented multi-agent orchestration prototype for the software development lifecycle. The browser dashboards remain the primary, more complete interface; an interactive OpenTUI terminal client (`apps/tui`, `specs/012-tui-interactive/spec.md`) supports task submission, approval/rejection, filtering, chat, an audit view, and live activity alongside them.

The working prototype uses Bun, TypeScript, and Hono. An orchestrator discovers specialized agents, routes tasks through an LLM capability router, turns planning results into executable child tasks via an adaptive supervisor, and enforces human approval for selected write operations.

This is a hackathon project. Prefer a reliable end-to-end demo, clear safety boundaries, and small verifiable changes over production-scale infrastructure.

## Source-of-truth order

When sources disagree, use this order:

1. Current repository code: what is implemented now.
2. Current files under `specs/`: intended behavior and acceptance criteria;
   use `specs/README.md` for governed lifecycle/verification status.
3. This file: repository conventions and verified architecture.
4. `context/instructions.md` and `context/project.md`: working preferences and project vision.
5. `context/history.md`: historical discussion and decisions; it may be stale.
6. `README.md` and old prompts/chat exports: public or historical material that may lag behind the code.

Always distinguish between `implemented`, `specified`, `proposed`, and `historical`. If documentation and implementation disagree, state the disagreement rather than silently treating the older document as correct.

## Where history lives

One ownership rule, stated here, in `AGENTS.md`, and in the generated `specs/README.md`:

| File | Owns |
|---|---|
| `CLAUDE.md` | Current architecture, conventions, gates, commands. Present tense. Budget-capped. |
| `specs/<NNN>/spec.md` | The approved decision and its acceptance criteria. |
| `specs/<NNN>/verification.md` | That checkpoint's evidence **and its narrative record** — what was live-caught, what was tried, what a pass found. |
| `context/worklog.md` | Dated, per-work-unit handoff entries. Append-only. |
| `context/history.md` | Pre-spec-governance historical discussion. Frozen; not appended to. |

A checkpoint's narrative goes to its own `verification.md`, never to `CLAUDE.md`. `CLAUDE.md` gains at most a present-tense sentence plus a spec pointer. Checkpoint directories are never renumbered; `061` has never existed (a permitted gap).

## Current architecture

```text
User (browser dashboard or interactive OpenTUI client)
        |
        | HTTP
        v
Orchestrator :3000
        |
        | custom A2A-style HTTP task protocol
        |
        +--> DevOps Agent         :3002
        +--> Testing Agent        :3003
        +--> Documentation Agent  :3004
        +--> Security Agent       :3005
        +--> Code Review Agent    :3007
        +--> Coder Agent          :3008

DevOps Agent :3002, Testing Agent :3003, Documentation Agent :3004,
Code Review Agent :3007, Coder Agent :3008
        |
        | MCP Streamable HTTP (loopback only)
        v
MCP HTTP Server :3006
        |
        +--> Git, analysis, and file-generation tools

DevOps Agent -------- direct A2A --------> Security Agent :3005

Separate external compatibility surface:

Claude Desktop / Claude Code / another MCP client
        |
        | MCP over stdio
        v
MCP Server
        |
        +--> Git, Docker, analysis, and file-generation tools
```

Structural facts an agent must not break:

- DevOps, Testing, Documentation, Code Review, and Coder are real MCP clients sharing one connection-lifecycle implementation (`packages/shared/mcp-client.ts`, `OrchestraiMcpClient`) — five agents, one class, no per-agent copies. None falls back to direct filesystem/process execution when MCP is unavailable; the old fallback code does not exist. Security Agent remains direct-`fs`, deliberately (`specs/011-remaining-agents-mcp/spec.md` decision (c) — read-only, audited, MCP-independent; converting it costs performance for no capability or safety gain).
- The stdio and HTTP MCP entrypoints are separate processes/`McpServer` instances created from one shared tool factory; one SDK server instance must never be connected to both transports.
- `read_project_file`/`write_project_file` are the highest-risk surface in this codebase: generic, path-parameterized file access. Path containment is canonicalization-based and separately re-checked via `realpath()` to catch in-root symlinks pointing outside; sensitive filenames (`.env*`, key/credential patterns) are denied by default on read and write, and any path through OrchestrAI's own `.orchestrai/` state dir (config.env holds the provider key) is denied on read, write and list, hidden from listings, skipped by Security's scan and denylisted in `run_command` (`specs/129`; `packages/mcp/project-file-tools.test.ts` holds the adversarial coverage).
- Every producer-generated task/child ID uses `crypto.randomUUID()`, never wall-clock precision. Every agent rejects a duplicate task ID with HTTP 409 without mutating existing state.
- There are no LLM API calls anywhere in this runtime without a real provider key configured. Routing and task parsing are a single LLM capability-router call (`specs/065`); with no key, every natural-language request resolves to `plan-task`, which itself fails closed with a named error. The semantic-embedding classifier and keyword ladder that used to sit ahead of the router are deleted (`specs/020`, `specs/054` own that history).
- Per-component LLM configuration (`specs/039`): `packages/shared/llm-model-factory.ts` resolves `ORCHESTRAI_<COMPONENT>_LLM_<FIELD>` (per field: `_API_KEY`/`_PROVIDER`/`_MODEL`) ahead of the shared `ORCHESTRAI_LLM_<FIELD>`, for the closed set `LLM_COMPONENTS` = orchestrator, documentation, devops, security, testing, conversation. A component whose own namespace is misconfigured fails on its own path and never silently resolves a sibling's credentials — structural, asserted adversarially. Called with no component argument it is byte-identical to the pre-`039` behavior.
- Provider calls are wrapped by one shared retry core (`specs/055`): `classifyProviderError()` labels a caught error `transient` (429/5xx/timeout/connection-reset) or `terminal` (auth, bad model, malformed request; fail-closed default for anything unrecognized), and `callProviderWithRetry()` adds exponential backoff with jitter, honoring `Retry-After`, both retry count and max delay bounded. A terminal failure re-throws immediately; exhausted retries raise a distinguishable `ProviderRetriesExhaustedError`. Every real `.invoke()` call site uses it.
- `analyze-project` can make one direct DevOps-to-Security A2A secrets pre-check — **opt-in, off by default** (`specs/094`): set `ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK=1` to enable. When enabled it does not route through the Orchestrator; Security unavailability preserves successful DevOps analysis as `completed` with an explicit warning. Its client-side timeout is `45_000ms`, grounded in a real measured full scan round trip (`specs/090`).
- Ports are configurable per service: `ORCHESTRAI_<SERVICE>_PORT` (unset/malformed falls back to the literal default, never throws; `packages/shared/service-ports.ts`), with `ORCHESTRAI_<AGENT>_URL`/`ORCHESTRAI_MCP_URL` full-URL overrides still winning first (`specs/073`). Non-loopback MCP URLs are rejected except for the Docker-compose case (`ORCHESTRAI_MCP_ALLOWED_HOSTS`, `ORCHESTRAI_MCP_BIND_HOST`).

See specs/039, 055, 065, 073, 094, 011 for the history behind these rules.

## Repository layout

```text
apps/
  orchestrator/             # Orchestrator API and browser dashboard
  tui/                      # Interactive OpenTUI client (specs/012-tui-interactive/spec.md)
  supervisor/               # `bun run orchestrai` process supervisor + guided init
packages/
  agents/
    devops/                 # Docker, CI, git, and project-analysis skills
    testing/                # Test execution, coverage, and test-authoring skills
    documentation/          # README and API-documentation skills
    security/               # Read-only secret/config/dependency scans
    code-review/            # Read-only diff review
    coder/                  # Approval-gated source edits
  mcp/                      # Shared MCP tools plus separate stdio/HTTP entrypoints
  shared/                   # Shared protocol types, store, LLM factory, analysis
specs/                      # Numbered specification checkpoints + schema/templates/catalog
context/                    # Project handoff, history, and worklog
context/demo/               # Live-demo reference page and runbook (not runtime code)
```

Each service is an independent Bun/Hono process with its own task state (in-memory Maps as the live working set, a durable SQLite store as the record — see "Project analysis, persistence, and history"). Some interfaces are duplicated locally instead of imported from `packages/shared`; when changing protocol fields, inspect every service for local copies.

## Current services and skills

| Port | Service | Advertised skills |
|---|---|---|
| 3000 | Orchestrator | Discovery, routing, `plan-task` (adaptive supervisor, `specs/028`), `suggest-agents`, approvals, dashboard/SSE, conversational ask layer (`specs/044`) |
| 3002 | DevOps Agent | MCP-backed `dockerize`, `create-ci`, `create-gitignore`, `create-compose`, `analyze-project`, `git-status` plus `specs/079` additions: `build-image`, `verify-deployment` (approval-gated Docker execution), `docker-status`, `git-diff` (read-only), `commit-changes` (Tier 1, held to a higher bar), and `run-command` (`specs/080`) |
| 3003 | Testing Agent | `run-tests`, `check-coverage` (Tier 1 whenever a runner will execute), `write-tests` (`specs/081`, Tier 1 model-authored test files) |
| 3004 | Documentation Agent | `generate-readme`, `document-api` (both Tier 1 on save/write) |
| 3005 | Security Agent | `scan-secrets`, `check-gitignore-coverage`, `audit-dependencies` (read-only; multi-ecosystem per `specs/085`) |
| 3007 | Code Review Agent | `review-diff` (read-only, no approval gate; LLM harness default-on, fails closed with no key; grounded in shared deep project analysis and a bound `git_diff`, `specs/119`) |
| 3008 | Coder Agent | `edit-file` (Tier 1 anchored single-file edit), `edit-files` (Tier 1 bounded multi-file edit/create, `specs/114`), `edit-and-verify` (Tier 1 bounded edit-run-fix loop, `specs/119`); LLM harness default-on, fails closed with no key |

Port 3001 (Planning Agent's retired port) stays retired — never reused (`specs/051`).

Every agent exposes `GET /.well-known/agent.json` (discovery), `POST /` (A2A-style task), `GET /tasks` and `GET /tasks/:id`, `GET /tasks/:id/stream` (SSE), `GET /healthz`, and `GET /dashboard`. Write-capable agents additionally expose approval/rejection endpoints.

## Task and plan flow

The protocol is a small project-specific A2A approximation, not the full official A2A specification. Current flow:

1. The Orchestrator discovers agents from a hardcoded `KNOWN_AGENTS` list against the live registry. On the same 10-second tick it health-checks every online agent (`GET /healthz`, 3 s timeout; any 2xx counts, including `ready: false`), refreshing `lastSeen`; 3 consecutive failures mark it `offline` (dropping its skills from routing until re-discovery brings it back). In-flight tasks are untouched (`specs/136`, `apps/orchestrator/agent-liveness.ts`). `GET /tasks` and `GET /tasks/:id` carry each task's `conversationId` (null when not chat-dispatched).
2. Skill resolution is **one LLM capability-router call and nothing else** (`specs/065`): `detectSkill()` is `tryCapabilityRoute(...) ?? "plan-task"`. The router (`packages/shared/capability-router.ts`, `runCapabilityRouter()`) receives the live `buildCapabilitySnapshot()` output and the raw request text, and must return a skill id present in that snapshot or the explicit `"unsupported"` sentinel — never a free-form string. The Orchestrator validates every proposal against that same live snapshot before using it: an offline or hallucinated skill falls through to `plan-task`, never a best-effort dispatch. A request naming genuinely distinct concerns needing different skills returns `"unsupported"` and falls through to the supervisor (`specs/096`). Deliberate consequences: every request costs a real provider call; with no key everything routes to `plan-task`, which fails closed with its own named error; a skill with no online agent is unnameable; the router is a real model judgment and can resolve identical text differently across runs. The approval gate's own `SKILL_TIER_REGISTRY` classification is completely untouched by routing. A synthetic `{orchestrator: [suggest-agents]}` capability entry lets the router still name that meta-skill, which the Orchestrator itself serves directly and synchronously (`buildSuggestAgentsReply()`; `specs/051`). Each `CapabilityEntry` also carries the skill's own short, code-authored Agent Card description (bounded, truncated if over-long, never message/plan-step prose) so a same-family pair like `edit-file`/`edit-files` is distinguishable instead of bare ids alone; the adaptive supervisor's own `Valid skills:` prompt line carries the identical per-skill descriptions via its own static `SKILL_DESCRIPTIONS` map (`specs/121`). `edit-file`'s descriptions limit it to one file named as `edit <path>: …` and send any multi-file change to one `edit-files` step (`specs/133`).
3. A `plan-task` request routes through the Orchestrator's adaptive supervisor — the only planner (see next section). There is no text-plan-parsing step; Planning Agent is deleted (`specs/051`). A plan step's child text is `buildPlanStepText()` — the step, a fixed `PLAN_CONTEXT_MARKER`, then the user's full request; every agent whose model reads the request (Coder's three skills; DevOps's `run-command` and four template harnesses) instructs it with the step only and shows the full request as capped background (`splitPlanStepText()`/`renderPlanBackground()`, `packages/shared/plan-step-text.ts`), while deterministic readers (project path, port) still see the whole text (`specs/137`).
4. The Orchestrator finds an online agent advertising each skill and dispatches plan steps sequentially as child tasks, sending the already-decided skill as an authoritative `selectedSkill` on the task envelope (`specs/030`): the receiving agent executes exactly that skill and never re-derives one from free text. A root task carries the same field from `detectSkill()`'s own result; an absent `selectedSkill` preserves legacy text-detector behavior.
5. It waits for completion, failure, or human approval before proceeding, and streams AG-UI-shaped events to the dashboard and TUI over `GET /events` SSE (`specs/021`).

With no agent online for a requested inspection skill, both the direct path (`dispatchRootTask()`) and the supervisor's plan-step dispatch fall back to the Orchestrator's own read-only project inspection rather than failing blind (`specs/102`, `specs/112` — see that section below).

See specs/020, 030, 054, 065, 096 for the routing history (the deleted keyword/semantic tiers, the authoritative-dispatch fix, the router's design and live records).

## Adaptive supervisor (Orchestrator) — the only plan-task planner

A `plan-task`-shaped request routes through a LangGraph supervisor loop (`apps/orchestrator/supervisor-graph.ts`, `specs/028`) that decides one skill at a time from what previous steps **actually returned**, **unconditionally** — no flag routes it anywhere else (`specs/038`, `specs/051`). `detectSkill()` is untouched by it; the branch is only evaluated after routing has already decided `plan-task`.

- **A provider key is required, checked at startup, non-blocking.** `apps/supervisor/index.ts` checks, right before port preflight, whether the Orchestrator (and each agent whose own harness is on) will start with no resolvable key (`checkStartupLlmKeys()`, `resolveAgentLlmKeyRequirements()`). A missing key prints a named, actionable `console.warn` and startup **continues** (`specs/064`); only presence and provider/model parsing are checked — a wrong or expired key still fails at first real use, and a genuine misconfiguration (invalid `ORCHESTRAI_LLM_PROVIDER`) is reported distinctly from a missing key. The real fail-closed guarantee lives in the per-request path: `runOrchestratorSupervisor()`'s own check fails a `plan-task`/`/ask` request closed with a named error the moment one is attempted with no resolvable key.
- Configure via the shared `ORCHESTRAI_LLM_API_KEY`, `ORCHESTRAI_LLM_PROVIDER`, and `ORCHESTRAI_LLM_MODEL` variables, with `ORCHESTRAI_ORCHESTRATOR_LLM_*` per-component overrides (`specs/039`). `ORCHESTRAI_ORCHESTRATOR_GRAPH` (the old opt-out) and `ORCHESTRAI_LLM_HARNESS` (Planning's old flag) are both dead; a config still carrying either gets a named startup warning (`findStaleLlmVariables()`) and starts normally.
- **The approval gate is entirely outside the graph, structurally.** No code path lets the model supply, observe, or influence an `actionId`. Two properties are enforced in code, not by prompting:
  - **Rejection is terminal.** A human rejection ends the run; the supervisor is never re-consulted; a rejected `dockerize` cannot be followed by `create-compose` attempting the same effect. Detected from the Orchestrator's own record of having forwarded a rejection (`rejectedByOrchestrator`), never from task status or error text.
  - **Adaptation requires proven effect-certainty.** Every dispatch resolves to a structured `DispatchOutcome` — `completed`, `rejected`, `failed-safe`, `failed-ambiguous`, or `timeout` — computed by the deterministic `classifyDispatchOutcome()` from raw status plus the rejection fact plus `SKILL_TIER_REGISTRY` (an **unregistered skill defaults to write-capable, never read-only**). Only `failed-safe` (a read-only skill's failure) permits trying something different next; a write-capable skill's unexplained `failed` is `failed-ambiguous`, terminal, and surfaces a reconciliation request. The model never sees or influences this classification.
- **A plan step's approval gate has a third outcome, `skip`** (`specs/089`): `POST /tasks/:id/skip` mirrors `reject`'s validation shape (a plan step's own child task only — refused on a direct task with a named error pointing at `reject`; it reuses the agent's own `/reject` to discard the pending action). A skip is **not terminal** — the graph continues, free to propose other skills, each still reaching its own full approval gate. The one structural guarantee kept: the literal skipped skill id can never be re-proposed in the same run (`skippedSkillIds`). UI: `s`×2 in the TUI (plan-step approvals only) and a Skip button on the Orchestrator dashboard's approval cards, all `parentTaskId`-gated. DevOps's own dashboard has no Skip — an agent has no `parentTaskId` concept; correctly out of scope.
- **Bounds**: a global dispatch limit and a per-skill attempt limit (both state-tracked) plus an explicit LangGraph `recursionLimit` as a redundant net end a runaway run with `RUN_ERROR`. The global limit is configurable — `ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES`, default **30** (unset/malformed falls back to the default, never throws, never disables the bound; `specs/097`).
- **Parallel dispatch, any tier** (`specs/060`, widened by `specs/120`): a supervisor turn may name several `dispatch_skill` calls in one decision — write-capable skills included since `specs/120` — and the whole batch fans out via `Promise.all()`/a per-branch wait race as soon as **every** entry is `dispatch_skill`; a `finish` call or unrecognized tool name anywhere disqualifies the whole batch back to single-call handling, fail-closed. Bounds, the skipped-skill refusal, and the duplicate-write refusal are all reserved per branch before any network call. Inside a batch, `rejected`/`failed-ambiguous`/`timeout` end the whole run exactly as the single-dispatch path already does; `skipped` does not. The moment any branch produces a run-ending outcome, every still-`input-required` sibling in that batch is skipped via the existing skip path (`SupervisorDeps.skip()`, optional so every pre-`120` test double still satisfies the interface) — no orphaned approval prompt survives a dead run, live-confirmed.
- **Grouped approval over disjoint writes** (`specs/120`): once every write-capable branch of a concurrent batch reaches `input-required`, `computeDisjointBatch()` (`apps/orchestrator/index.ts`) checks whether their real resolved output paths (`ApprovalPreview.target`, or every `files[].target` for a `specs/114` multi-file preview) are pairwise distinct — exact canonical-path equality only, never prefix/fuzzy/case-insensitive. Distinct paths make the batch **eligible**: the Orchestrator dashboard renders one grouped review card and the TUI one grouped review overlay (`g`, `specs/130`) (both additive — every branch's existing individual Approve/Reject/Skip row stays exactly as it was), and `POST /tasks/:parentId/approve-batch` accepts one explicit per-branch decision list, forwarding each decision concurrently to its own agent's **unmodified** `/approve`/`/reject` with that branch's own `actionId` — never a shared or collapsed one. Any two branches sharing a path make the batch **ineligible**: no grouped review, every branch still gets its own individual approval, nothing discarded. `GET /tasks/:parentId/pending-batch` is the read-only companion a client polls to learn eligibility without submitting anything. Live-confirmed: organic multi-write fan-out fired on the very first live attempt (no prompt tuning needed, unlike `060`'s own first attempt), and a real grouped approval wrote two real files concurrently through unmodified agents.
- The supervisor is grounded per-run by the Orchestrator's own shallow project inspection (see its section below); with zero dispatches, the deep-analysis upgrade composes the inspection content into the answer (`specs/105`).

See specs/028, 038, 060, 064, 089, 097, 120 for the design and verification history of each property.

## Agent LLM harnesses

All six agent-level harnesses are **opt-out by default** (`specs/077`, `specs/086`): `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS`, `ORCHESTRAI_DEVOPS_LLM_HARNESS`, `ORCHESTRAI_SECURITY_LLM_HARNESS`, `ORCHESTRAI_TESTING_LLM_HARNESS`, `ORCHESTRAI_CODE_REVIEW_LLM_HARNESS`, and `ORCHESTRAI_CODER_LLM_HARNESS` each mean on unless explicitly `=0` (absent/empty/anything but the literal `"0"`). Selecting an agent in guided init is the only decision — every surface writes `=1` for selected agents. Consequence, stated plainly: no file-writing or test-running skill has a deterministic fallback (`specs/138` removed every template) — DevOps's four file skills, `generate-readme`, `document-api`, Testing's `run-tests`/`check-coverage` (absent an explicit `run command:`), Code Review, and Coder all fail closed with a named error when their harness is off or no key resolves (the process still starts; `specs/064`). Security's commentary and DevOps's read-only skills still degrade to their deterministic paths via `=0`.

Common structure, per agent (deliberately independent copies unless noted):

- One LangGraph tool-calling loop per skill with a structurally-enforced read-only tool allow-list (`READ_ONLY_TOOL_NAMES`; `buildReadOnlyTools()` throws at graph-build time if ever widened) — a write-capable MCP tool is never bound to any harness. Every harness resolves its own `HARNESS_RECURSION_LIMIT` through the shared `resolveHarnessRecursionLimit()` (`packages/shared/harness-limits.ts`, `specs/125`): `ORCHESTRAI_HARNESS_RECURSION_LIMIT` when set to a valid integer ≥ 1, else the shipped default of **40** (raised from 20 by that spec) — one variable applied uniformly across DevOps, Documentation, Testing, Code Review, and Coder, never per-agent. Each harness catches `GraphRecursionError` as a real class, re-throwing a clean, named OrchestrAI error whose message already interpolates the resolved limit (`specs/098`).
- Model output is validated against a Zod schema; invalid output triggers one bounded retry-with-feedback; exhausted retries fail closed (except where noted as fail-open).
- Grounding is enforced in code, not by prompt wording: `document-api` per-route substring checks and the grounded zero-route LLM fallback (`specs/100`, only when `scanApiRoutes()` finds zero routes, every proposed path a literal substring of the real file); DevOps parameter objects; `write-tests` identifier-substring grounding (`specs/081`); Code Review's `isGrounded()` against the real diff post-image (`specs/082`); Coder's exactly-once `old_text` anchor check (`specs/083`); deep analysis's per-observation `read_project_file` re-verification (`specs/103`). Where multiple findings are produced, the largest fully-grounded subset is salvaged on retry exhaustion (`specs/082` precedent), failing closed only when zero survive.
- Per-agent fail modes: DevOps, Documentation, Testing, Code Review, and Coder **fail closed** once the harness is active (a misconfigured key or run failure fails the task with a named error, never a silent fallback to the deterministic path) — with one carve-out inside that set: DevOps's `analyze-project` deep-analysis layer (`specs/103`) **fails open**, as does Security's commentary layer. In both fail-open layers, the deterministic scan/report always runs and is always the task's core content; a harness failure appends an explicit `"…unavailable: <reason>"` note and the task still completes — there is no wrong write to prevent, and the deterministic report is already complete and correct.
- **DevOps** (`specs/042`, `specs/138`): the LLM authors the full content of the Dockerfile, CI workflow, compose file, and `.gitignore` (`runAuthoringHarness()`), written through `write_project_file` to a fixed per-skill relative path (`FILE_SKILLS`) — never a model-chosen path. The content is validated *after* authoring and before the preview by `packages/shared/devops-file-validation.ts`: allow-listed base/service images and CI actions, COPY sources that really exist, parseable YAML, no undeclared secrets, no host-root or docker-socket mounts, `.orchestrai/` present in `.gitignore`; a violation gets one retry with the violations as feedback, then fails closed. The authoring harness receives the user's request (bounded) and is told a value the request states explicitly (e.g. a port) wins over one derived from the project (`specs/134`). `read_project_file` was added to DevOps's tool set for this (real file content, not just presence checks).
- **Documentation** (`specs/041`, `specs/138`): the harness is the only author — the old deterministic README/API-doc templates are deleted, so harness off or no key fails closed with a named error. `generate-readme` explores from the project root with `read_project_file` only; `document-api` is *given* the deterministically discovered route list (`scanApiRoutes()` — unchanged, always runs first) and writes better documentation for those routes. The existing README's real content is harness context (preserve/build on, don't blindly rewrite). Read-only `document-api` reaches the harness too (`specs/111`) — same file, same harness state, one answer regardless of phrasing. An explicit path is still required for a non-JS/TS project (`DOCUMENT_API_ENTRY_CANDIDATES`, `specs/036`).
- **Security** (`specs/043`): strictly additive commentary on findings the deterministic scan already produced — never runs its own scan, never decides what counts as a finding, never removes/downgrades/reorders one (enforced by the output schema's shape). No new tool access: zero MCP tools, zero write capability, deliberately not a LangGraph graph (no tool to call). A CVE-hallucination guard rejects any note matching a CVE-identifier pattern or explicit version-range comparison. **External vulnerability data is a separate, genuinely opt-in capability** (`specs/084`): `ORCHESTRAI_SECURITY_EXTERNAL_DATA=1` reaches the real OSV.dev service only when an `audit-dependencies` task actually runs — never in the background, never on a schedule — and the returned advisory text is computed deterministically and appended *before* the commentary wrap, so no LLM ever paraphrases it (any paraphrase risks getting a detail wrong in a way a direct pass-through cannot). A lookup failure fails open with an explicit `"Vulnerability data unavailable: <reason>"` note. Manifest coverage is npm (with `package-lock.json` lockfile widening), Python (`requirements.txt`/`pyproject.toml`), Go (`go.mod`), PHP (`composer.json`/`composer.lock`), and Java (`pom.xml`; no standard lockfile — direct dependencies only, a permanent-for-now gap) per `specs/085`; detail fetches are capped at 3 per package.
- **Testing** (`specs/080`, `specs/081`, `specs/138`): the harness has two jobs — proposing the test command for every `run-tests`/`check-coverage` (given the `detectRunner()` signal, the coverage flag, and the request; an explicit `run command:` in the text wins and needs no model call), and authoring test-file content for `write-tests`. Harness off or no key with no explicit command fails closed naming `specs/138`. `write-tests`: an explicit source file must be named (fails closed otherwise) — a whole-project request is steered to `plan-task` by the skill's own description, and the supervisor names one file per `write-tests` step (`specs/126`); a *detected* runner is required; the output path is 100% deterministic from `(source path, runner)`; writing the file and running it are always two separate approvals, structurally (no code path from the write skill to `run_command`).
- **Code Review** (`specs/082`) and **Coder** (`specs/083`, `specs/114`): see their sections; Coder additionally has a structurally-recognized refusal shape (`EditProposalSchema` discriminated union with `{refused: true, reason}`) so a structurally impossible instruction (e.g. comments in JSON) is refused with a real reason instead of looping — a refusal can never reach the approval gate. **Code Review's `review-diff` additionally grounds itself in the shared deep project analysis** (`specs/103`/`105`, `specs/119`): `packages/shared/project-analysis.ts` is imported, never re-implemented, fail-open exactly as DevOps's own use of it — analysis unavailable appends an explicit note and the review still completes on the diff alone. `git_diff` is now bound to this harness too (`specs/119`, reversing the specs/082/101 decision to leave it unbound), and the task's own `TaskResult` carries a machine-readable `findings` field alongside the human text.
- **Coder's `edit-and-verify`** (`specs/119`): a bounded verify-and-fix loop reusing `runEditFilesHarness()` verbatim for every edit proposal, including every follow-up fix (a different instruction string embedding the real command failure output, never a new proposal path). `run_command` is in Coder's `requiredTools` for MCP connectivity, bound **only** to the approval-gated execution path (`packages/agents/coder/verify-loop.ts`) — never to the proposal harness, whose `READ_ONLY_TOOL_NAMES` stays byte-unchanged and structurally enforced. The loop's own state (iteration, every argv already approved in this task, per-iteration history) is carried on each pending action's own persisted payload, so `specs/110`'s existing restart machinery covers it with no new schema. `MAX_VERIFY_ITERATIONS = 3`; exhausting it completes the task with an honest report, never a silent stop or an unbounded loop.
- `run-command` (`specs/080`) is shared by DevOps, Testing, and (via `edit-and-verify`) Coder: an explicit command in the task text (parsed by a no-shell tokenizer) always wins and needs no model call; otherwise the harness proposes one. **Every single invocation is approved individually — no auto-approve, no trusted-command memory, no batch-approve, ever** (Yusuf's non-negotiable condition) — narrowed once, deliberately, by `specs/119`'s own B1: within one live `edit-and-verify` task, a byte-identical re-run of an argv a human already approved earlier in that same task skips a redundant prompt; any difference at all, or any reuse across tasks or after a restart, is a fresh approval. The MCP tool's own denylist (`checkRunCommandDenylist()`) and cwd containment are defense-in-depth, not the safety mechanism; the `actionId`-bound approval is.

See specs/041, 042, 043, 077, 080, 081, 082, 083, 086, 098, 100, 111, 119 for each harness's full history.

## Write-path safety: previews, preflight, drift rechecks, restart survival

- **Approval previews show content, not just intent** (`specs/040`): `ApprovalPreview` (`packages/shared/approval.ts`) carries optional `content` (the exact text that will be written) and `previousContent` (present only when overwriting), always full and uncapped server-side — any size limit is a client rendering decision. **The load-bearing property, enforced by construction**: content is computed once at preview time and reused verbatim at write time, never recomputed. Rendering is a dependency-free line diff (`packages/shared/line-diff.ts`); oversized content (over the `TASK_RESULT_MAX_BYTES` 64 KiB precedent, checked against the pair) **omits the block entirely with an explicit note, never a truncated partial diff**.
- **Preflight classifies before previewing** (`specs/056`): `classifyWritePreflight()` (pure, `packages/shared/write-preflight.ts`, fed the real target content via `read_project_file`) classifies `create`/`no-op`/`update`/`blocked`. An exact `no-op` never reaches a write-capable MCP call — the task completes with an explicit "already up to date" result. `blocked` (unreadable target — permission, containment, or sensitive-filename denial) fails closed with the real reason. Applies to all four DevOps write skills.
- **The approval is bound to a content fingerprint, re-verified immediately before the real write** (`specs/056`, extended by `specs/109` to Documentation, `specs/081` to `write-tests`, `specs/083`/`specs/114` to Coder, `specs/079` to `commit-changes`): `computeContentFingerprint()` (SHA-256, with a distinct `"absent"` sentinel so a create is fingerprinted too) is stored with the pending action and re-checked in `resumeTask()` — a target that changed after approval fails the write closed and requires a fresh preflight. `commit-changes` is fingerprinted on the **combined staged + unstaged diff** (the underlying `git_commit` always runs `git add -A`) and held to a higher bar than every other DevOps write because it alters git history rather than producing an inspectable file.
- **A pending approval survives an agent restart** (`specs/110`): a `pending_actions` table (schema v4) persists each write-capable agent's pending action — `kind: "write"` (24h TTL; a real fingerprint exists to re-check) or `kind: "command"` (1h TTL, deliberately short — nothing file-shaped to re-verify). `claimPendingAction()` is a single `UPDATE ... WHERE status = 'pending'` transaction — the real single-consumption boundary once persistence is enabled. A `'claimed'` row (crash between claiming and finishing) is never restored, swept away with a `console.warn`. Restore-time validation is a real Zod schema per agent; a row that fails to parse or validate is discarded, never partially trusted. Fail-open throughout: with no store, the in-memory Map alone remains the boundary, byte-identical to before. Two DevOps paths are deliberately excluded and remain as fragile as before: the two no-fingerprint degrade paths (unknown skill, failed dry-run) and the EXECUTING skills `build-image`/`verify-deployment` (real Docker operations, no content fingerprint of any kind). A restored `command` action's preview carries one added risk line naming that no drift recheck is possible for it. **Orchestrator-side** restart recovery (AG-UI run state, plan-step waiters, the skip/reject distinction) remains a named, deliberately open gap.
- **Coder's multi-file writes are all-or-nothing preflight, best-effort execution** (`specs/114`): `edit-files` re-verifies every file's fingerprint before writing **any** file (a single file's drift refuses the entire batch); a genuine mid-batch filesystem failure is reported per-file honestly — no cross-file atomic transaction exists at the `write_project_file` level. Bounded to `MAX_FILES_PER_EDIT = 6` by the Zod schema itself. `ApprovalPreview.files[]` (one `{target, action, content?, previousContent?, fingerprint}` per file) renders as one labeled diff block per file in both dashboards and, in the TUI Details view, a header row per file followed by its diff rows, with total diff rows capped at 300 (`specs/130`).

See specs/040, 056, 079, 081, 083, 109, 110, 114 for the history of each guarantee.

## Human approval and safety

Approval is a governance boundary, not a UI decoration.

Current approval-required operations include:

- DevOps: `dockerize`, `create-ci`, `create-gitignore`, `create-compose`, `run-command`, `commit-changes`, and the execution skills `build-image`/`verify-deployment`.
- Documentation: `generate-readme`, plus `document-api` when explicitly asked to save/write output.
- Testing: `run-tests` and `check-coverage` whenever a supported runner is detected — Tier 1 as of `specs/006`. A no-runner result may still complete autonomously because no process executes. `write-tests` (one approval per file).
- Coder: `edit-file`, `edit-files`, and `edit-and-verify` (`specs/119`) — the last of these iterates edit → approved write → approved verification command → fix, bounded at `MAX_VERIFY_ITERATIONS = 3`, with every write individually approved and command approval scoped to a byte-identical argv already approved earlier in the same task (a narrow, deliberate amendment to `specs/080`'s "no trusted-command memory, ever").

Current read-only operations include project analysis, Git status/diff, security scans, code review, and API documentation returned as text.

For DevOps, Documentation, Testing, and Coder, mapped write/command actions are executed only from `resumeTask()` after a structured `ApprovalPreview` (`packages/shared/approval.ts`) has been stored with a random `actionId` bound to immutable pending parameters. Approve/reject requests must supply the matching `actionId`; a missing one is HTTP 400, a stale/mismatched one is HTTP 409, and neither can execute or alter stored parameters. Read-only MCP calls and direct A2A calls need no popup but must be timeout-bounded and emit metadata-only audit events. Audit summaries are capped at 512 UTF-8 bytes and task-visible MCP/A2A results at 64 KiB.

DevOps's MCP client treats a 404/`-32001 Unknown MCP session` response as a definitive, reconnectable stale session: it reconnects and retries the identical call exactly once. Ambiguous failures (timeout, connection reset) are never auto-retried. `/healthz` reports a bounded live ping result, not a cached client object.

When adding a write-capable skill:

1. Add it to the owning agent's approval policy.
2. Execute it only after approval/resumption.
3. Ensure the Orchestrator can forward approval safely.
4. Update its Agent Card, routing/planning behavior, docs, and verification.

Treat all agent-controlled paths, arguments, generated content, and command input as untrusted. Prefer structured schemas, argument arrays, explicit validation, timeouts, least privilege, and filesystem scope checks. Never introduce arbitrary LLM-generated shell execution.

The Testing Agent uses `Bun.spawn()` with argument arrays. The MCP server uses `execFile()` with `shell: false` behind `safeExec()`. The executing tools (`docker_build`, `docker_run`, `git_commit`) use `execOrFail()` instead, so a failed build, a container that didn't stay up, or a failed commit returns `isError` with the output and `[exit code N]` and the task fails, never `completed` (`specs/143`); the default image tag is the project folder name lowercased (`defaultImageName()`). An agent's `/healthz` MCP ping (2 s) never tears down a connection with tool calls in flight; a failed ping then only reports not-ready, since tearing it down used to kill a running docker build. Preserve the no-shell boundary, but do not assume prefix matching alone provides production-grade sandboxing.

Runner detection (`specs/058`): `detectRunner()` returns a `DetectionResult` — `detected` | `ambiguous` | `unsupported` — from real manifest/lockfile/config inspection (framework signals checked ahead of package-manager lockfiles; ambiguity is reserved for two conflicting signals of the same kind and reports the real candidates). Detection only informs the model now: `run-tests`/`check-coverage` get their argv from an explicit `run command:` in the text or from the Testing harness (`runTestCommandHarness()`, `specs/138` — `RUNNER_ARGV` and the MCP `run_tests` tool are deleted), and every argv runs through `run_command` behind the same `shell:false` boundary and per-invocation approval. `run_command` returns a non-zero exit's full stdout+stderr plus `[exit code N]`, so a failing suite is a *completed* run reporting its counts, not a failed task; `parseTestCounts()`/`parseCoveragePercent()` recognize bun/jest/vitest/pytest/go/dotnet/surefire output and say "not recognized" otherwise.

Use Node filesystem APIs rather than Unix-only `ls`, `cat`, or similar commands in runtime code. Windows is the active development platform.

A plan step's free-text `description` is planning-time intent written by the supervisor's own LLM turn; for skills whose write-time parameters are decided by a second, independent harness at preview time (`run-command` most visibly), the two are not synchronized. A fixed reminder line ("the description above is planning-time intent, not a promise — review the action below before approving") renders wherever a step's description sits directly above its approval preview — the TUI's Detail overlay and the Orchestrator dashboard's Tasks-table row and chat-linked card, both scoped to `parentTaskId`-bearing tasks (`specs/097`).

See specs/006, 040, 058, 089, 097, 110, 111 for the history behind these gates.

## Tool sharing and skill ownership (`specs/101`)

Two rules, both current and enforced:

- **MCP tools are freely shareable across agents.** `read_project_file` is used by five agents, `write_project_file` by three, `git_diff` and `run_command` by two each. Skill-ownership rules govern skill **ids**, not tool **access** — nothing stops two agents sharing one tool.
- **Skill ids are the opposite: exactly one owner, always.** If two online agents ever advertise the same skill id, `normalizeAgentCapabilities()` (`packages/shared/agent-capabilities.ts`) refuses the **entire** capability snapshot — not just the ambiguous id. `buildCapabilitySnapshot()` returns `null`, the LLM router is never called, and `detectSkill()` falls through to `plan-task` for every request. The Orchestrator's `/healthz` reports this directly as `capabilities: {ok, error?}`, and `packages/shared/agent-card-skill-collision.test.ts` walks the six real Agent Cards in CI.

Namespacing skill ids was considered and rejected: the router is deliberately shown skill ids only, never agent names, so the model selects a capability and the Orchestrator separately resolves who provides it. Three components currently answer a duplicated skill id differently — `normalizeAgentCapabilities()` refuses globally; `findAgentForSkill()` silently first-match-wins by registry order; `validateSelectedSkillOwnership()` permits (a membership check, not an exclusivity one) — reconciling them is named follow-up work.

Of the 12 MCP tools (`specs/138` deleted the four `create_*` templates and `run_tests`), four are general inspection — `read_project_file`, `analyze_project`, `git_status`, `git_diff` — and every code-reasoning agent gets all four (Code Review excepted from `git_diff`: it already receives the combined diff as prompt context). The specialised read-only tools (`docker_status`, `lint_ci_workflow`) stay DevOps-only; `lint_ci_workflow` is wired into `create-ci`'s post-write path; `audit_dependencies_local` was removed from DevOps's `REQUIRED_TOOLS` (superseded by `specs/085`'s real multi-ecosystem parsing) but stays registered on the MCP server for the external stdio surface. The write/execute tools stay unshared beyond their current owners — sharing one grants a new approval-gated capability, a new risk class deserving its own spec. Coder's `run_command` access for `edit-and-verify` (`specs/119`) is the one approval-gated exception.

`OrchestraiMultiMcpClient` (`packages/shared/mcp-client.ts`) supports multi-endpoint MCP but has **zero real consumers** — connecting a genuine third-party server is a deliberately deferred non-goal (most community servers speak stdio, not Streamable HTTP; bridging stdio is separate, unscoped work).

See specs/101 for the widening's design and live history.

## Project analysis, persistence, and history

- **Deep project analysis** (`specs/103`): DevOps's `analyze-project` skill (and, via one shared implementation, the Orchestrator — `specs/105`) runs a real code-reading LLM harness — `packages/shared/project-analysis.ts` is the ONE implementation both import (schema, grounding, `runProjectAnalysisHarness()`, `renderCodebaseAnalysis()`), never two copies that could drift. Output is structured and validated (`{stack, structure, observations: [{text, paths}]}`); every cited path is re-verified by an actual `read_project_file` call inside the validator; the largest fully-grounded subset is salvaged on retry exhaustion; zero grounded observations omits the section with an explicit note. **Fail-open**: a harness failure appends `"Codebase analysis unavailable: <reason>"` and the task still completes. The MCP `analyze_project` tool itself stays shallow and byte-identical (it grounds every `plan-task` run and must stay fast and LLM-free); the Orchestrator's inspection writes to a distinct `ORCHESTRATOR_INSPECTION_CACHE_SKILL` cache key so a shallow result can never starve a later deep one.
- **The local SQLite store** (`specs/106`): `packages/shared/store.ts`, `bun:sqlite`, zero new dependencies, one **local** file at `<ORCHESTRAI_PROJECT_PATH>/.orchestrai/orchestrai.db` (mode `0600` on POSIX) — no network storage, no external service. **Strictly optional / fail-open is the load-bearing property**: `openStore()` returns `null` on any failure (missing `ORCHESTRAI_PROJECT_PATH`, `ORCHESTRAI_PERSIST=0`, a read-only path, a filesystem where `PRAGMA journal_mode = WAL` doesn't genuinely take), and every caller treats `null` as "behave exactly as if persistence didn't exist." `ORCHESTRAI_PERSIST=0` is a real, permanent opt-out. `busy_timeout=5000`, `synchronous=NORMAL`, `auto_vacuum=INCREMENTAL`, `PRAGMA foreign_keys = ON` per connection; migrations via `CREATE TABLE IF NOT EXISTS` + `PRAGMA user_version` inside one `BEGIN IMMEDIATE`. Every write is one synchronous `db.transaction(...)()` doing no I/O, never spanning an `await`. Retention is owned by exactly one process — the Orchestrator, on startup and a 15-minute `unref()`'d interval: `result_cache` expired rows and stale leases, capped at 2,000 rows by `computed_at`; `tasks` 30 days or 10,000 rows; `conversations` 200 with 500 turns each (cascade); `audit_events` 7 days or 50,000 rows; expired `pending_actions` swept alongside.
- **Tables**: one generic `result_cache` keyed `sha256(kind, project_root, target_rel, input_hash, schema_ver)` — no conversation id anywhere, so a result one process computes is usable by another and survives restarts; `tryAcquireLease()` is the concurrent-stampede guard; validity on read re-checks a stored git-status fingerprint with a 5-minute TTL as a backstop; `dispatchRootTask()` still gates every cache read/write on `conversationId` being present, and explicit-refresh wording bypasses the cache. `tasks` (written on every genuinely terminal transition; `params_json` stores only what the human already saw in the approval preview) and `conversations`/`turns` (written from `appendTurn()`, the one and only place a turn is added; a `turnSeq` counter on the in-memory `Conversation`, deliberately independent of the trimmed `turns` array; `loadRecentConversationsFromStore()` restores history at `start()` before the port binds). `scan-secrets` results are redacted **structurally** — `upsertTask()` itself forces `result = NULL, redacted = 1` for that skill; the task record is kept, only the finding text is withheld. `findMostRecentFailure()` (shared by `specs/091`'s "why did it fail?" and `specs/093`'s conversation answers) checks in-memory first, falls back to the store only when memory has nothing. Agent-side persistence (`specs/107`) uses `startTaskPersistenceSweep()` polling each agent's existing task Map — persisting a task exactly once on first terminal observation — rather than rewiring every mutation call site.
- **The durable audit trail** (`specs/108`, `specs/113`): `emitAuditEvent()` (`packages/shared/audit.ts`) has three sinks — console.log, the Orchestrator's SSE push (best-effort, never-awaited, failures swallowed entirely), and the batched durable write (2-second interval, 20-event threshold, or clean shutdown; a lost buffer on a hard crash is accepted). **`whitelistAuditParams()` is the real safety mechanism**: every string, array, and nested object is dropped unconditionally — only booleans and numbers survive — plus a stable SHA-256 hash of the full undisclosed params so identical calls can still be correlated. `GET /audit?task=…` on the Orchestrator is the read surface (fail-open). The dashboard's Audit tab polls on demand **and** prepends live rows from a fourth `orchestrai.audit-event` CUSTOM SSE event (carrying `paramsWhitelisted`/`resultBytes`/`resultTruncated`), with a `kind` badge (MCP/blue, A2A/green, EXEC/amber); the TUI's Audit view (mode `4`) renders live rows the same way, capped at 200, reload-only for history, with `t` filtering to the task selected in Tasks (`specs/130`).

See specs/057, 103, 105, 106, 107, 108, 113 for the history (including the retired in-memory `ProjectSnapshotCache`).

## Orchestrator read-only project inspection (`specs/102`)

The Orchestrator has its own MCP client — the first component besides agents — bound to the same four general-inspection tools (`analyze_project`, `read_project_file`, `git_status`, `git_diff`). **Read-only, strictly optional, never a skill**: construction is wrapped in `try/catch` (unlike an agent's module-scope hard crash, never acceptable for the coordinator), never `start()`ed eagerly, never advertised as a skill (no second skill owner). Opt out with `ORCHESTRAI_ORCHESTRATOR_INSPECTION=0`. `/healthz` gained an `mcp` field using `readiness()` (pure, synchronous — never `pingReady()`, which performs real I/O), and the Orchestrator gained a minimal SIGINT/SIGTERM shutdown (one `callTool()` against an unreachable server otherwise leaves a perpetual 5-second reconnect loop).

The inspection grounds every `plan-task` run (consulting the cache first; a bare `POST /tasks` with no `conversationId` never touches it), and the supervisor's system prompt notes it is already grounded. When no agent can serve a requested inspection skill, both `dispatchRootTask()` and the supervisor's `dispatchPlanStep()` synthesize the inspection content as the answer/child instead of failing blind (`specs/105`, `specs/112`). `bun run orchestrai --only orchestrator` auto-starts `mcp:http` for it.

See specs/102, 105, 112 for the history.

## Conversational ask layer and chat

`POST /ask { question, conversationId? }` (`specs/044`) classifies every question into one of three tiers, **deterministically — the model has no input into this decision**: the classification is made by the same single capability-router call (`specs/075`), whose `kind` values include `"state-question"`, `"failure-question"` (`specs/091`), and `"conversation"`, alongside `"read-only"`/`"state-changing"`/`"unsupported"`.

- **Tier 0 — state.** Answerable from the Orchestrator's own live registry/task store ("what agents do you have?", "why did it fail?" — `answerLastFailureFromState()` walks the task store backward for the most recent `status: "failed"` task and returns its real skill/agent/error verbatim). No dispatch, no network call. `POST /tasks`'s catch-all already routes any unrecognized kind to `plan-task` — zero routing code change.
- **Tier 2 — read-only.** A skill `SKILL_TIER_REGISTRY` classifies read-only runs with no approval.
- **Tier 1 — write-capable.** Runs through the **existing, completely unchanged** approval gate, framed conversationally ("To answer that I need to run `pytest --cov`. Approve?") instead of a modal out of nowhere.

The router's classification call sees bounded conversation history (`priorTurnsFor()`, `specs/092`) with an explicit safety-guard prompt line so a short reply is interpreted in context without an unrelated new request being mis-anchored to an old topic; with that history it also returns `resolvedRequest`, a self-contained rewrite of a contextual reply ("yes" → the original instruction), grounded in the last dispatched task's full text, and that rewrite is what gets dispatched (`specs/128`); `POST /tasks` (no conversation concept) never passes history — asserted by a dedicated regression test. A correctly classified `"conversation"` turn is grounded by `buildConversationAnswer()` (`specs/093`, repurposed by `specs/124` into grounding text only): a first-contact fact, or the real most-recent failure (same real state `091` reads, never invented).

Answer synthesis is **key-gated, not flag-gated** (the endpoint is the opt-in), via the shared factory with a `"conversation"` component. The assistant turn is synthesized **only from material the deterministic path already produced**, never a fresh fetch; a bounded numeric grounding check rejects an answer asserting a figure absent from its source material, retrying then **failing open** — losing a nicer sentence must never lose the substance. For `"state"`/`"failure"` Tier 0 answers the underlying task's `result` is never modified, only added alongside (synthesized+raw stacked); synthesis is skipped entirely for their canned no-data answers (`CANNED_NO_DATA_ANSWERS`, `specs/097` — real cost savings, not just UX). `"conversation"` turns are different (`specs/124`, amending `specs/116`): synthesis always runs (its raw grounding text is dynamic, never a canned member of that set) and, when it succeeds, **replaces** the grounding text outright rather than stacking with it — the specs/116 regression ("2 person responding me") came from stacking two independently-phrased answers, not from synthesizing at all, and there is no separate raw detail worth keeping collapsible for a reply to "thanks". With no key configured or on synthesis failure, the branch falls back to `buildConversationAnswer()`'s fixed text verbatim, byte-identical to pre-`124` behavior.

`ConversationTurn` carries an optional `summary` — set only when synthesis actually ran, holding just the synthesized paragraph; `text` stays the full, uncapped synthesized+raw value that every endpoint persists and returns (`specs/116`). The TUI shows `summary ?? text` per turn with `d` toggling the most recent assistant turn between summary and full text; the dashboard renders both as sibling spans with a `▸ full report` toggle (client-side visibility swap, deliberately not a `data-*` attribute — `escapeChat()` doesn't escape quotes). A dispatched task's terminal chat answer carries `summary` too. For a single dispatched question the chat view shows **one** answer, not three: the orchestrator's turn (synthesis + collapsible raw) plus a live status card only while the task is genuinely still `input-required` (`specs/115`).

A completed `plan-task` reports what actually happened (`composeSupervisorResult()`, `specs/075`): each step's real skill/agent/outcome composed deterministically from the child tasks the parent owns the ids of — this is what gives synthesis real material. TUI chat shows live progress phrases per skill (`chat-progress-phrases.ts`, a plain phrase table, deliberately not another LLM call). `parseCoveragePercent()` surfaces the coverage percentage `check-coverage` buries in raw output.

The dashboard is a Chat-default **Chat | Tasks | Agents | Audit** workspace (`specs/046`, `specs/113`): bounded conversations selectable, a chat-dispatched task linked to its originating turn, structured approval/diff cards, `data-task-id`-keyed in-place row patching (no full-`innerHTML` refetch flicker), one shared SSE connection. Approval cards for a plan's children surface the waiting child's approval, keyed to the child's id, never the parent's.

See specs/044, 046, 075, 091, 092, 093, 097, 115, 116, 124 for the history.

## Live event protocol (AG-UI)

`GET /events` on the Orchestrator emits **AG-UI-shaped events** (`specs/021`), with the event schema sourced from the official pinned `@ag-ui/core` package rather than hand-defined (`specs/027`). Every emitted event is **runtime-validated** against `@ag-ui/core`'s own zod schemas (`validateAgUiEvent()` in `packages/shared/ag-ui-events.ts`, called from `emit()` before the SSE stream) — not type-only adoption. A validation failure (a programming error in OrchestrAI, not a runtime condition) is logged with the event type and field path and the event is **still delivered** — a schema disagreement must never take down the live stream a demo depends on.

Twelve event types are defined/emitted — the subset this runtime can honestly produce: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_STARTED`, `STEP_FINISHED`, `TOOL_CALL_START`, `TOOL_CALL_RESULT` (correlated by `toolCallId`), `TEXT_MESSAGE_START`/`_CONTENT`/`_END` (real conversational assistant turns, `specs/044`), `STATE_SNAPSHOT` (sent on connect so a client joining mid-run isn't blank), and `CUSTOM`. `REASONING_*` remains deliberately absent: no intermediate model reasoning is exposed, only final answers. Adopting `@ag-ui/core`'s full type surface does not authorize emitting anything beyond these twelve. The four `orchestrai.*` CUSTOM payloads (`approval-required`, `approval-resolved`, `agents-update`, `audit-event`) have their own local zod schemas — official `CustomEventSchema.value` is necessarily `z.any()`, so official conformance alone would not catch a malformed extension payload.

Lifecycle mapping: task submitted → `RUN_STARTED`; plan step dispatched/finished → `STEP_STARTED`/`STEP_FINISHED`; MCP tool call or direct A2A call → `TOOL_CALL_START`/`TOOL_CALL_RESULT`; `input-required` and approve/reject → `CUSTOM` (`orchestrai.approval-required`/`-resolved`); terminal → `RUN_FINISHED`/`RUN_ERROR`.

The load-bearing piece is `POST /internal/audit-event`: audit events are produced inside each **agent's** process, but the SSE stream lives on the **Orchestrator**, so `emitAuditEvent()`/`emitAuditStart()` fire a **best-effort, never-awaited** push there. A push failure is swallowed entirely — a task must never fail, block, or slow down because the Orchestrator was unreachable. Agents stay completely unaware of AG-UI; all protocol mapping lives in the Orchestrator.

**The approval `CUSTOM` events are informational only.** AG-UI has no native human-in-the-loop primitive, so these are an OrchestrAI extension — a client must never treat one as authorization. Approving still requires the real `POST /tasks/:id/approve` with its server-issued `actionId`.

Both clients consume the stream: the dashboard patches rows/tool-call lines in place, and the TUI consumes it as a second data path alongside its poll (the source of truth for task list membership/status), surfacing live calls as a zero-row inline `⚙` badge — deliberately zero extra rows so it cannot reintroduce terminal-overflow bugs.

See specs/021, 027, 044, 113 for the protocol's history.

## TUI (terminal client)

`apps/tui` is the interactive OpenTUI client — the primary interface this project is judged on. Current shape:

- A shell layout (`specs/069`): a left conversations rail (full at ≥100 cols, a 6-col strip at ≥84, hidden below), a centre Chat|Tasks|Agents|Audit workspace, a right agent-status rail (≥110 cols). At the 80×24 minimum both rails collapse away and the centre is byte-close to the full-width render — the rails only appear once there is real width to spend. All four centre boxes and both rails use one explicit `shellRegionHeight` (naturally-sized boxes left leftover rows from a taller previous frame — `specs/115`).
- Four top-level modes cycled with `Tab` (Chat, Tasks, Agents, Audit `4`). Chat renders through the shell (`specs/069` Phase 2); the composer's rows live inside the centre panel's own budget so the footer stays exactly one row always.
- Real thread selection (`specs/115`): a `railCursor` moved by `Left`/`Right` with `Enter` opening the highlighted thread (`[`/`]` kept as direct jumps), synced on `chatConversationId` alone — never on the conversation-list array reference, which changes every poll tick.
- Keyboard-driven approvals: `a`×2 approve, `r`×2 reject, `s`×2 skip (plan-step approvals only), with full-screen help (`?`), filters, task view-clear with undo (`c`), completed/failed hide toggle (`h`), auto-follow of the newest task. Mouse tracking is on — plain click-drag doesn't select terminal text; hold `Shift` while selecting (the Help view says so).
- Real terminal paste support (`specs/059`): native `<input>` components handle paste internally; `apps/supervisor/init-form.tsx`'s hand-rolled fields use `usePaste()` with `normalizePastedText()` (line-ending normalization, C0-control stripping, bounded max length that **rejects** rather than truncates); the masked API-key reader recognizes bracketed-paste markers in its own raw-stdin stream, including a paste split across `data` events.
- The Audit view (`specs/108`, `specs/113`, `specs/115`): live rows appended from the `orchestrai.audit-event` CUSTOM event (gated on the view having been opened this session, capped at 200) with the MCP/A2A/EXEC kind colors matching the dashboard; reload-only history; result bytes and truncation per row; `t` filters to the task selected in Tasks, (`specs/130`); `GET /audit?task=<id>` itself matches both the id and the `orch-<id>` its agent records under (`specs/136`). Agents push live audit events to `ORCHESTRAI_ORCHESTRATOR_URL`, else `localhost:<ORCHESTRAI_ORCHESTRATOR_PORT>` (`specs/141`).
- Information parity (`specs/130`): Tasks keeps the last 100 tasks, labels rows `chat · ` (from each task's `conversationId`, `specs/136`) and `child of <id> · `, and `t` cycles a status filter; chat turns show skill and time; rail rows show a status glyph and relative time; Agent details show last-seen time and task count; an empty chat lists the dashboard's example prompts; `RUN_FINISHED`/`RUN_ERROR` trigger an immediate refresh.
- `apps/tui/index.tsx` carries 16+ rounds of terminal-overflow-bug history (`specs/012`/`047`/`069`): treat any layout change as high-risk, verify in a real PTY, reuse the existing height-budget helpers (`computeShellLayout()`, `computeShellChatScrollHeight()`) rather than deriving new ones, and prefer the state-injection + real-PTY-capture technique over guessing.
- The header's first line never wraps: `formatHeaderStatus()` (`apps/tui/tui-state.ts`) sizes the status suffix to the width the mode labels leave (full `● live · N/N agents`, or compact `● live N/N` at 80 columns), each form fixed-width. A wrapped header once cost the Audit and Chat titles their row at 80×24 (`specs/135`).
- The TUI resolves the Orchestrator URL via `resolveOrchestratorUrl()` (`apps/tui/tui-state.ts`) — `ORCHESTRAI_ORCHESTRATOR_URL` wins, else `http://localhost:` + the resolved `ORCHESTRAI_ORCHESTRATOR_PORT` (`specs/099`) — never a hardcoded `localhost:3000`.
- **Grouped review** (`specs/130`): `g` — from Chat, or on a plan or one of its steps in Tasks — fetches `GET /tasks/:parentId/pending-batch`; an ineligible batch gets a status message and opens nothing. When eligible, a full-screen overlay lists one line per branch; `a`/`r` set that branch's decision (default approve), Enter shows its diff, `y`×2 submits one `POST /tasks/:parentId/approve-batch` carrying each branch's own `actionId`, and Esc closes without submitting. The keys belong to the `batchReview` owner in `resolveKeyOwner()`.

See specs/012, 047, 059, 069, 115, 120, 130 for the TUI's history.

## Commands

Run commands from the repository root. This is a Bun workspace; use `bun.lock`, not npm/yarn lockfiles.

```text
bun install
bun run mcp
bun run mcp:http
bun run orchestrator
bun run devops-agent
bun run testing-agent
bun run documentation-agent
bun run security-agent
bun run code-review-agent
bun run coder-agent
bun run tui
bun test
bun run typecheck
bun run specs:catalog   # regenerate specs/README.md + specs/catalog.json
bun run specs:check     # validate specs + CLAUDE.md size budget
```

`bun run dev` starts the MCP HTTP service, all six agents, and the Orchestrator in parallel — convenient development startup, **not** a process supervisor: no port preflight, no readiness sequencing, no prefixed logs, and killing one process tears down the entire group (test MCP kill/restart scenarios against isolated `bun run mcp:http` / `bun run devops-agent` processes instead). The Orchestrator retries discovery for agents that are not ready during its initial pass; DevOps independently retries its MCP connection with bounded backoff and reports MCP state in `/healthz`. `bun run dev:with-mcp` is the explicit demo command; `bun run dev:with-all-mcp` additionally starts the stdio compatibility process. `bun run mcp` means stdio; `bun run mcp:http` means loopback Streamable HTTP on port 3006.

`bun run orchestrai` (`apps/supervisor/index.ts`, `specs/016`) is the alternative that adds all of that — port preflight (bounded, `specs/045`), ordered startup (agents + MCP HTTP first, gated on real `/healthz`, Orchestrator last), prefixed logs, a startup summary, `--only <service[,service...]>` for subsets, and a shutdown that kills orphaned children on every exit path (SIGINT/SIGTERM, `SIGHUP`/`SIGBREAK` for a Windows console close, and a synchronous `process.on("exit")` backstop — `specs/067`, `specs/074`). The stdio MCP server is deliberately excluded from it. When the auto-launched TUI takes over the screen, those prefixed logs are redirected (not deleted) to `<project>/.orchestrai/supervisor.log` (`specs/066`); `--headless`, CI, and every non-TTY invocation are byte-identical to before, and if the log file can't be created suppression never engages.

`bun run build` (`scripts/build-binary.ts`, `specs/017`) compiles the entire runtime — all six agents, the MCP HTTP server, the Orchestrator, the supervisor, and the TUI — into **one** standalone `dist/bin/orchestrai[.exe]` (~137 MB) via `bun build --compile`. `bun run fetch-model` (`scripts/fetch-model.ts`, `specs/020`) downloads and SHA-256-verifies `minishlab/potion-base-8M` into a gitignored `models/` directory; it is optional for every command **except `bun run build`**, which fails outright without it (the model is embedded at build time). `apps/supervisor/index.ts` is the single compiled entry point: no arguments runs the supervisor and self-spawns children as `orchestrai service <name>`; `orchestrai tui` runs the terminal viewer; `orchestrai init` (or `i`) runs guided setup; `orchestrai init --web` serves the browser form on an ephemeral loopback port (`specs/049`). Every service exports a `start()` guarded by `if (import.meta.main)` — import-and-call-on-demand works; `bun run <service-script>` is unaffected.

`bun run demo:preflight` (`scripts/demo-preflight.ts`, `specs/131`) is a read-only readiness report run from the demo folder — config, one live key call (`--skip-key` to skip), ports and stray processes, terminal size, `--baseline <ref>` for the fixture, opt-ins, and with `--live` a running stack's `/healthz`, capabilities, `STATE_SNAPSHOT` and the `.orchestrai/` read denial; it never prints a key and exits non-zero on any FAIL. `bun run demo:ag-ui` is the scripted AG-UI rehearsal (`specs/142`): it targets a fresh, git-initialized temp copy of the committed demo app `context/demo/demo-app/` (or `--project`); the default `core` group is the original six scenarios (expecting the Security A2A event only when `ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK=1`), `--groups all` adds chat, parallel-write and safety previews (every approval rejected or skipped, target fingerprint unchanged), and `--allow-writes` adds `real` — one approved `/ask` conversation (analyze → parallel read-only checks → write tests → run → fix → review → three ship files approved together via `approve-batch` → build → commit → recap) on its own temp copy. `bunfig.toml` keeps the demo app's deliberately failing test out of OrchestrAI's own `bun test`.

Dashboards: <http://localhost:3000/dashboard> (Orchestrator), and `:3002`/`:3003`/`:3004`/`:3005`/`:3007`/`:3008` for the agents. MCP pre-flight: <http://localhost:3006/healthz> must report `status: "ok"`, and DevOps <http://localhost:3002/healthz> must report `ready: true` and MCP `state: "connected"` before a demo.

See specs/016, 017, 020, 045, 049, 066, 067, 074 for the history of the supervisor, binary, and init surfaces.

## Target project resolution

DevOps, Testing, Documentation, and Security share the resolver exported by `packages/shared/index.ts`. Resolution order:

```text
1. Explicit absolute path in task text
2. ORCHESTRAI_PROJECT_PATH inherited environment variable
3. Clear validation error
```

There is intentionally no `process.cwd()` fallback **at this shared-resolver level** — a direct `bun run devops-agent` invocation is unaffected by anything below. Relative paths are rejected; paths containing spaces must be quoted. The MCP server sits outside this behavior (its tool schemas take explicit path parameters). The Orchestrator does not manually load `.env`; all services use inherited environment variables. **Never load a target project's `.env` as OrchestrAI configuration.**

Extraction of an explicit path tries **every** `at/in/to/from` match in the text and returns the first that validates as an absolute path (`specs/087`), and trailing punctuation including `:` is stripped (`specs/088` — the Coder convention `"edit <file> at <path>: <instruction>"` puts a colon directly after the path).

Documentation's `document-api` is a partial exception: it documents one specific source file's API surface. An explicit path always wins; absent one, `specs/036` resolves a project root via the shared resolver, then tries a short fixed candidate list of conventional entry-file locations (`index.ts`, `src/index.ts`, `app.ts`, `src/app.ts`, `server.ts`, `src/server.ts`, `main.ts`, `src/main.ts`) — the first that exists and contains a detected route registration wins. Not a recursive or wildcard search; exhausting the list fails closed with an error naming the root and every candidate.

One layer above the shared resolver, `apps/supervisor/index.ts` (`specs/018`) decides what to inject as `ORCHESTRAI_PROJECT_PATH` into its children — never changing the shared resolver, only the inherited value: (1) `--project <path>`, (2) an already-set `ORCHESTRAI_PROJECT_PATH` (never overridden), (3) an `orchestrai.project.txt` next to the binary (compiled mode only), (4) `process.cwd()`. Printed at startup, never a silent guess.

**Guided init** (`specs/031` and its amendments — see specs/034, 050, 063, 068, 070, 071, 072, 095 for the history) writes a per-project, cwd-keyed `<target>/.orchestrai/config.env` + `orchestrai.project.txt` (ranked above the next-to-binary file; works identically in dev and compiled mode; an explicit flag or env var always wins). Current form state:

- The TUI form opens on the **Providers** screen (register keys before choosing agents); advancing to agent selection is gated on at least one credential.
- Agent selection lists only the real agents, numbered, comma-separated numbers accepted; `orchestrator` and `mcp:http` are implied, and `orchestrator` is always appended to the persisted `ORCHESTRAI_ONLY` — a wizard-written config can never produce a coordinator-less startup. An **empty** checkbox selection means **zero agents** (`ORCHESTRAI_ONLY=orchestrator`, the already-supported orchestrator-only mode) — not "all" (`specs/072`); the classic wizard's blank-input-means-all convention is unchanged.
- Selecting an agent that has a harness writes `ORCHESTRAI_<AGENT>_LLM_HARNESS=1`; a deselected agent writes no line at all.
- A **Models section** on the setup screen (inline, not a separate view — `specs/071`) shows `shared` plus `orchestrator` and `conversation` rows (always present, `specs/095`) plus one row per selected LLM agent; the picker shows a provider line when more than one provider is registered and live-fetches each provider's real current model list (`specs/063`; plain `←`/`→` cycles the provider, `Ctrl+←/→` remains the power-user shortcut; free-text entry is never removed). Per-component **provider and API key** are assignable (`specs/063`): the Models picker only offers providers that already have a registered key — structurally impossible to produce an override with an empty key. The browser form's equivalent per-component picker remains a known gap.
- A **Ports section** (`specs/073`): all 6 services, digits-only, empty = default, validation for out-of-range and duplicate ports; `formatConfigEnv()` writes `ORCHESTRAI_<SERVICE>_PORT` only when it differs from the default.
- A **Harness limit row** below Ports (`specs/125`): one shared value for `ORCHESTRAI_HARNESS_RECURSION_LIMIT` (digits-only, empty = default of 40), validated and written the same way a Ports row is; the classic wizard and browser form don't ask.
- Hand-editing is safe: `writeWizardConfig()` merges — `WIZARD_OWNED_KEYS` lines are replaced in place or removed when no longer written; comments, blank lines, and unknown variables survive verbatim.
- The API key is deliberately persisted to this plaintext file (a considered decision for this demo-scale tool, with `.orchestrai/` auto-added to `.gitignore` as the one mitigation).
- `init --web` (`specs/049`): ephemeral loopback port, one self-contained page (no CDN/build/framework/outbound request), a real 192-bit random token in the URL (every request must carry it; wrong/missing 404s indistinguishably), `Host` + `Origin` must both match this run's own loopback address (defeats DNS-rebinding and cross-site POST), the token is single-use (flipped synchronously before any `await`), the server has a bounded lifetime, and the raw key is never echoed — only `maskKey()`'s fixed-length output. This is the only inbound HTTP surface in this repo that accepts a secret from a browser.

## Verification status

- `bun test` — the full suite (see `context/worklog.md` for the latest recorded run; the pre-`118` baseline was 1372 pass / 0 fail / 2 skip, the two skips being pre-existing Docker-daemon-gated tests). Model-gated semantic-classifier cases skip cleanly when `bun run fetch-model` hasn't been run.
- `bun run typecheck` (`tsc --noEmit`) — real, reproducible, currently 0 errors (TypeScript and `@types/react`/`@types/bun` are declared devDependencies; `apps/tui/index.tsx` carries its own `/** @jsxImportSource @opentui/react */` pragma).
- `bun run specs:catalog` then `bun run specs:check` — the governance gate: spec frontmatter, relationships, catalog freshness, and the `CLAUDE.md` ≤ 150,000-character budget (one exported constant, `CLAUDE_MD_MAX_CHARACTERS` in `scripts/spec-catalog.ts`).
- CI: `.github/workflows/ci.yml` (install/typecheck/test on every push and PR to `main`) — its final step starts a real `devops-agent`+`orchestrator` stack and submits two real requests (`suggest-agents`, `plan-task`) asserting the synchronous half of each response, never a real provider call (`specs/052`); the `ORCHESTRAI_LLM_API_KEY` it sets is deliberately non-functional. `.github/workflows/build-binaries.yml` builds and smoke-tests the standalone binary natively on Windows, Linux, and macOS runners and publishes all four npm packages on `v*` tags (`specs/017`, `specs/019`, `specs/032` — the packages are live; the repo is private, so GitHub Releases are collaborator-only, not a public channel).
- There is no broader lint configuration.
- The Testing Agent is a runtime feature that runs tests in a target project; it is not a test suite for OrchestrAI itself.

For changes, perform verification proportional to the risk:

- Documentation-only: inspect the diff and validate referenced files/commands against the repository.
- Routing/state logic: add or run focused tests where possible, then exercise affected HTTP endpoints.
- Runtime integration: start the relevant services, check `/healthz`, submit representative tasks, and verify approval and SSE behavior.
- File/process tools: verify both successful behavior and rejection of unsafe/invalid inputs.

Record exact verification and failures in `context/worklog.md`.

## Known limitations and technical debt

- Some dashboard text (in-app HTML, not this file or README.md) may still be stale in minor spots.
- `bun run dev` has no lifecycle guarantees; `bun run orchestrai` and the compiled binary provide preflight, readiness sequencing, prefixed logs, and clean shutdown.
- The live `tasks`/`registry` Maps on each process remain the source of truth while a process runs. The durable store (`specs/106`–`specs/110`) covers expensive read-only results, task results, chat history, the audit trail, and **agent-side** pending approvals across a restart — but the Orchestrator's own AG-UI run state, plan-step waiters, and the skip/reject distinction are still in-memory-only; Orchestrator-side restart recovery remains a genuinely separate, deliberately open problem.
- Direct routing (`detectSkill()`) test coverage lags behind the implemented agents; routing itself is now a single LLM call (`specs/065`).
- Agent logic is duplicated (deliberate per-agent-copy convention; `packages/shared/project-analysis.ts` is the one shared exception).
- Security performs direct read/process operations rather than going through MCP — a deliberate decision (`specs/011` decision (c)), not a gap.
- `audit-dependencies` covers npm, Python, Go, PHP, and Java (`specs/085`); Rust (`Cargo.toml`), .NET (NuGet), and Ruby (`Gemfile`) remain one-at-a-time follow-ups. Maven has no standard lockfile concept, so it stays direct-POM-dependencies-only (a real, permanent-for-now gap).
- A direct deep-analysis report from any agent other than DevOps remains deferred (`specs/104` A11's remainder); Coder self-verification (A5) shipped as `edit-and-verify` (`specs/119`).
- No production-grade sandbox, authentication, or authorization exists.
- Dependency versions are inconsistent; some workspace packages use `"latest"`.
- `docker compose up` is a valid alternative to `bun run dev` for the full 7-service stack; `ORCHESTRAI_MCP_ALLOWED_HOSTS` and `ORCHESTRAI_MCP_BIND_HOST` exist solely for that container-networking case.
- `OrchestraiMultiMcpClient` has zero real consumers (deliberate non-goal, `specs/079`).
- The guided-init **browser** form still lacks a real per-component provider/model picker (`specs/063`'s acknowledged gap).
- Deferred work is tracked in `specs/104-deferred-work-register/spec.md`.

## Working procedure

OrchestrAI uses Spec-Driven Development (SDD). Before changing runtime behavior, architecture, build/release behavior, CI/CD, infrastructure, protocols, public APIs, or security policy:

1. Read this file.
2. Inspect the relevant current implementation.
3. Allocate the next immutable three-digit sequence and create or update `specs/<NNN-kebab-case-id>/spec.md`.
4. Add metadata matching `specs/schema/spec.schema.json`, including one stable primary `area`, one `change_type`, and any one-way `amends` links; use `specs/README.md` for lifecycle transitions and catalog guidance.
5. Include current behavior, proposed behavior, scope, safety constraints, acceptance criteria, verification, and explicit non-goals.
6. Run `bun run specs:catalog`, then `bun run specs:check`.
7. Present the spec to Yusuf for review.
8. Do **not** implement until Yusuf explicitly approves the spec. This is a hard stop, not a suggestion: after writing `spec.md`/`plan.md`, stop — do not run `Bash`, `Edit`, `Write`, or any other tool against runtime, config, or workflow files in the same turn or session, even if the change seems small or obviously correct. Wait for an explicit approval message before touching anything outside `specs/`. This applies to every coding agent working in this repo (Claude, Codex, or otherwise) — a spec's own draft banner is not itself authorization to implement it.
9. After approval, implement the smallest change that satisfies the approved spec.
10. Verify each acceptance criterion and report pass/fail; keep lifecycle `status` separate from `verification` confidence.

Numbered specification/checkpoint directory names are stable creation IDs, not priorities. Never renumber them. One engineering `area` may contain multiple checkpoints. Keep newly discovered in-scope work inside the same draft; create a later checkpoint only when an implemented decision needs independent approval, migration, risk control, or verification. Use one-way `amends` for partial extensions and reciprocal `supersedes`/`superseded_by` only for whole-spec replacement. Only `spec.md` is mandatory; add `plan.md` for substantial multi-phase/risky work and `verification.md` for substantial evidence, never as empty symmetry files. A plan cannot broaden an approved spec. Frontmatter is the lifecycle source of truth; prose and acceptance checkboxes are evidence. A material change to an approved spec returns it to `draft` and requires re-approval. **`specs/README.md` and `specs/catalog.json` are generated in full by `scripts/spec-catalog.ts` — never edit either by hand; change the script and regenerate.**

**Where history goes** (the rule from "Where history lives", restated): a checkpoint's narrative — what was live-caught, what was tried, what a verification pass found — is recorded in that checkpoint's `verification.md`, never appended to `CLAUDE.md`. `CLAUDE.md` gains at most a present-tense sentence plus a spec pointer, and stays under the 150,000-character budget that `bun run specs:check` enforces; if a change would push it over, relocate existing narrative into the owning spec's `verification.md` first.

Documentation corrections that only make docs match already-implemented code may be made without a new spec, but they must still be verified and logged. If a documentation edit introduces a new requirement or architectural decision, it needs a reviewed spec first.

Do not invent files, APIs, environment variables, commands, ports, or architecture without verifying them or proposing them in the spec.

After every repository change:

1. Verify the change in proportion to its risk.
2. Update affected user/developer documentation in the same work unit.
3. Append a dated entry to `context/worklog.md` containing:
   - objective;
   - files changed;
   - behavior/decision;
   - verification performed and results;
   - known limitations or next step.
4. Keep the entry useful as a Claude/Codex handoff; do not paste noisy terminal output.

Do not claim a task is complete if required verification could not run. State whether it is implemented but unverified, partially verified, or blocked.

## Current recommended priority

Unless the team changes scope, the next work should generally follow this order:

1. Keep documentation and handoff context accurate (this file present-tense, `specs/` authoritative, `context/worklog.md` current).
2. Continue improving routing/planning while preserving deterministic safety policy — the approval gate, tier registry, and fail-closed defaults are never traded for capability.
3. Work the deferred items in `specs/104-deferred-work-register/spec.md` in its own priority order (A6 skill-id reconciliation, A11's remainder, and the browser-form picker gap are the named near-term candidates).

The historical done-item roll-call (type checking, MCP conversion, Dockerization, supervisor, binary distribution, routing gaps, semantic fallback, LLM routing) is recorded in specs/014, 011, 009, 016, 017, 015, 020, 054 and superseded specs — `specs/README.md` is the authoritative status catalog.
