---
id: 102-orchestrator-readonly-project-inspection
title: "Orchestrator Gains a Read-Only, Strictly Optional Project Inspection Capability"
area: architecture
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-20
updated: 2026-09-20
approved_by: Yusuf
approved_on: 2026-09-20
implemented_on: 2026-09-20
amends:
  - 011-remaining-agents-mcp
  - 044-conversational-ask-layer
  - 057-project-snapshot-and-cross-request-reuse
  - 065-llm-only-skill-routing
  - 072-init-form-empty-selection-means-no-agents
  - 075-real-conversational-chat
  - 087-target-path-resolver-first-match-bug
supersedes: []
superseded_by: []
related:
  - 028-orchestrator-langgraph-supervisor
  - 077-agent-enabled-means-llm-on-by-default
  - 082-code-review-agent
  - 088-target-path-resolver-trailing-colon-bug
  - 101-per-agent-tool-access-expansion
---

# Spec: Orchestrator Gains a Read-Only, Strictly Optional Project Inspection Capability

> Status: **DRAFT — awaiting review.** `specs/101` deliberately split
> this out as its own follow-up: *"Designed with Yusuf in this same
> session and split out at his direction, since it is the only part
> that gives a component something it has never had."* Motivated by
> Yusuf directly: *"if i don't run the agant that can run the
> analisize for example the orch will not have the ablitiy to know
> about the project."* When asked which of two shapes he meant (a
> full read-only MCP client vs. an on-demand-only fallback), his own
> words scoped it precisely: *"what if all the analisize tools that
> the orch can reach when it is needed? just that."* A first draft of
> this spec inspected fresh on every single `plan-task` run, with no
> caching at all — Yusuf caught it directly: *"but that will analyze
> the project with each plan? why while if it done it once already?"*
> Revised: the supervisor's own inspection now reuses `specs/057`'s
> existing conversation-scoped cache rather than a fresh call every
> time, closing that spec's own explicitly-recorded deferred item (its
> own text: *"the adaptive supervisor's own read-only dispatch is not
> integrated with this cache"*) instead of repeating the gap.
>
> **IMPLEMENTED 2026-09-20. A second real finding, made during
> implementation, not assumed from drafting: the acceptance criterion
> below naming `dispatchRootTask()`'s no-agent branch as the primary
> fix for the motivating scenario was checked directly against the real
> router and found inaccurate.** `specs/065`'s own LLM router validates
> every proposal against the live capability snapshot before using it —
> with zero agents online, it can never legitimately name
> `analyze-project`/`git-status` at all, so it always falls through to
> `"plan-task"` before `dispatchRootTask()`'s no-agent branch is ever
> reached through natural-language routing. The real path for the
> `--only orchestrator` scenario is the adaptive supervisor's own
> **zero-dispatch result**: `composeSupervisorResult()` gains an
> additional case (extending `specs/075`'s own precedent for the
> identical class of gap in conversational chat) so a supervisor run
> that correctly needed zero dispatches — because its own grounding
> block already answered the question — surfaces that real content
> instead of the generic `"completed after 0 dispatch(es)"` line.
> `dispatchRootTask()`'s own fallback is kept, tested, and exported —
> genuinely correct defense-in-depth for a real (if narrower) case —
> but this correction is recorded here rather than let stand as
> originally assumed. See the amended sections below and
> `verification.md` for the full record.
>
> **Closed live, 2026-09-20**, once a real provider key became
> available (Yusuf: *"the real api key is here in the conf in orch
> folder in this repo, and you can run a reall terminal test without
> me"*). The exact corrected mechanism above was confirmed against a
> real `orchestrai --only orchestrator` process (genuinely zero agents,
> a real Gemini key, a real scratch project): the router fell through
> to `plan-task`, the supervisor's own attempted dispatch failed with
> no agent online, and the task's real final result was the Orchestrator's
> own live `analyze_project`/`git_status` content — the exact scenario
> that motivated this spec, now proven end to end rather than only
> unit-tested. See the Acceptance Criteria and `verification.md` for
> the full transcript. `verification` stays `partial` — the shutdown
> path's own clean-SIGINT behavior remains unconfirmed, a Windows-
> sandbox limitation unrelated to this finding.

## Purpose

The Orchestrator today has **zero MCP client** — confirmed by grep, the
only `mcp`-matching lines in `apps/orchestrator/index.ts` are comments.
It is a pure coordinator: it learns anything about a target project only
by dispatching a task to an agent and waiting for the result.

Two real costs follow from that, one rare and one constant:

- **Rare but real**: `--only orchestrator` is a supported supervisor
  mode (`apps/supervisor/index.ts:225`, reachable from the guided-init
  form since `specs/072-init-form-empty-selection-means-no-agents`). In
  that configuration there is no agent to dispatch `analyze-project` or
  any other skill to at all, so a project question fails outright —
  `dispatchRootTask()`'s own `findAgentForSkill(skill)` check
  (`apps/orchestrator/index.ts:1665-1680`) returns nothing and the task
  ends `failed`, `error: "No agent found for skill: <skill>"`.
- **Constant, paid on every run**: the adaptive supervisor picks its
  **first** skill knowing nothing about the project it is planning for.
  `buildSystemPrompt(taskText)`
  (`apps/orchestrator/supervisor-graph.ts:311-328`) receives only the
  raw request text — no structure, no stack, no git state. It has to
  spend a real dispatch just to find out what it's looking at before it
  can plan intelligently.

A third, unanticipated benefit came out of drafting this spec:
`dispatch_skill`'s own `target` parameter is
`z.string().describe("Absolute path to the target project.")`
(`supervisor-graph.ts:298`) — **the model invents this path today**,
with no grounding in what the Orchestrator itself already knows via
`resolveTargetPath()`. Two real, live-caught bugs already exist in this
exact area — `specs/087` (first-match path extraction failing on a
plan step's own free-text description) and `specs/088` (a trailing
colon corrupting a resolved path) — both downstream consequences of the
model having to reconstruct a path from prose. Grounding the prompt in
the real, already-resolved path attacks the same bug class at its
source, not just its symptoms.

## Current behavior

- The Orchestrator has no `OrchestraiMcpClient`, no `mcp` field in
  `/healthz`, no `shutdown()`, and no SIGINT/SIGTERM handler at all —
  `start()` (`index.ts:3511-3521`) calls `startDiscovery()` then
  `serve()` and returns; the server handle is never retained.
- `dispatchRootTask()`'s no-agent branch
  (`index.ts:1665-1680`) is unconditional: no online agent for a skill
  always fails the task, with no fallback of any kind.
- `runOrchestratorSupervisor()` (`index.ts:1031`) builds a model,
  resolves `SupervisorDeps` via `buildOrchestratorSupervisorDeps()`
  (`index.ts:877`), and calls `runSupervisor(task.text, { model, deps,
  maxDispatches })` with no project context of any kind.
- `resolveTargetPath()` (`packages/shared/index.ts`) is already used by
  the Orchestrator today, but only for the conversation-scoped
  read-only cache key, via the throw-swallowing
  `tryResolveTargetPathForCache(text)` (`index.ts:1430-1436`) — never
  for anything the supervisor or `/ask` actually sees.
- **`specs/057`'s `projectSnapshotCache`** (`index.ts:134`) already
  exists for exactly this class of problem — a bounded,
  conversation-scoped, 5-minute-TTL cache keyed by
  `(conversationId, skill, target)`, currently populated and consulted
  only by `dispatchRootTask()`'s own regular skill-dispatch path
  (`index.ts:1533`, `:1618`). `specs/057`'s own record states directly
  that the adaptive supervisor was never integrated with it, precisely
  because that module is deliberately Orchestrator-agnostic with no
  conversation concept — a real, still-open gap this spec closes for
  the one call site (`runOrchestratorSupervisor()`) that *does* run
  inside the Orchestrator and already has access to the cache.
  Conversation-less requests (`POST /tasks` with no conversation) never
  touch this cache at all — `specs/057`'s own deliberate scope
  boundary, unchanged here.

## Proposed behavior

### 1. An optional, lazily-connected client

A module-scope `OrchestraiMcpClient | null` in `apps/orchestrator/index.ts`,
bound to the same four general-inspection tools `specs/101` just gave
every code-reasoning agent: `analyze_project`, `read_project_file`,
`git_status`, `git_diff`.

**Construction is wrapped in a `try/catch`.** This is the one real
hazard: `validateMcpUrl()` (`packages/shared/mcp-client.ts:66-76`)
throws synchronously for a malformed, non-`http:`, or non-allowlisted
`ORCHESTRAI_MCP_URL`, and every existing agent constructs its client at
module scope — meaning a bad URL is today a hard module-load crash for
that agent. A coordinator must never refuse to start because an
*optional* enhancement is misconfigured, so a construction failure logs
a named warning and leaves the client `null` — never a startup crash.

**Never `start()`ed eagerly.** `OrchestraiMcpClient` already supports
exactly this lazy shape: construction does no I/O and never blocks
(`mcp-client.ts:94-104`); if `start()` is never called, the first real
`callTool()` self-starts it via `waitUntilReady()`
(`mcp-client.ts:219-227`), which is itself bounded —
`TASK_RECONNECT_WINDOW_MS` (3s) — and throws rather than hanging. A
missing required tool never reaches the caller either: it fails inside
`connectOnce()`, is caught by the reconnect loop, and the client simply
stays in `"retrying"` (`mcp-client.ts:189-192`).

Opt-out: `ORCHESTRAI_ORCHESTRATOR_INSPECTION=0`, following the `!== "0"`
convention `specs/077` established for every agent-level harness flag —
absent, empty, or anything but `"0"` means on.

### 2. One function that can never throw

```ts
async function inspectTargetProject(taskText: string): Promise<string | null>
```

The single place the "strictly optional" guarantee lives, so every
caller can simply check for `null` rather than each re-implementing
degradation:

1. Resolve the path with the existing `tryResolveTargetPathForCache()`
   shape — any resolution failure degrades to `null`, never throws.
2. No client available (construction failed or the opt-out is set) →
   `null`.
3. Call `analyze_project` and `git_status` against the resolved path;
   any failure (unreachable server, missing tools, timeout) → `null`.
4. Otherwise return a **bounded**, formatted block naming the real
   resolved path plus a summarized form of both results — bounded
   because this goes into a prompt on every plan run, and
   `analyze_project`'s own output includes a full directory listing
   that must not be pasted in unbounded.

Every branch returns `null` on failure; nothing here ever throws to a
caller. Directly unit-tested, not just implied by the individual pieces
each being safe.

### 3. Supervisor grounding — cache-first, not a fresh call every run

**A first draft of this section called `inspectTargetProject()`
unconditionally on every `plan-task` run — Yusuf caught this directly
during review: *"but that will analyze the project with each plan? why
while if it done it once already?"*** Corrected: `inspectTargetProject()`
now consults `specs/057`'s existing `projectSnapshotCache` before
calling any tool, and the analysis below reflects the corrected design,
not the first draft.

`runOrchestratorSupervisor()` first resolves the task's own
`conversationId` (via the existing `taskConversations` map,
`index.ts:1550` — `undefined` for a bare `POST /tasks`) and the real
target path via `tryResolveTargetPathForCache(task.text)`. When both
resolve:

1. **Cache hit** — `projectSnapshotCache.get(conversationId,
   "analyze-project", target)` returns a live (non-TTL-expired) entry →
   use it, no MCP call at all.
2. **Cache miss** — call `analyze_project` + `git_status`, format the
   result, and **populate the cache** with
   `projectSnapshotCache.set(conversationId, "analyze-project", target,
   {...})` — the identical shape `dispatchRootTask()`'s own regular
   dispatch path already writes (`index.ts:1533`). This is the real
   point, not just avoiding a repeat call: a real dispatched
   `analyze-project` skill and the supervisor's own pre-planning
   inspection now **share one cache entry**. Whichever happens first in
   a conversation grounds the other for free — a user asking "what
   stack is this?" then "build and deploy it" gets the second request's
   planning grounded with zero extra cost.
3. **No `conversationId` (bare `POST /tasks`)** — skip the cache
   entirely and call the tools fresh, exactly matching `specs/057`'s
   own existing rule that a conversation-less request never touches
   this cache. A deliberate, named boundary carried over from that
   spec, not silently reintroduced: the cost here is one fast local
   pair of calls, not a full agent dispatch, and `specs/057` already
   accepted an equivalent cost elsewhere (its own git-status TTL-only
   path).

`runSupervisor()`'s options and `buildSystemPrompt()` each gain an
optional `projectContext?: string` parameter. With no context supplied
(inspection returned `null`, at any of the steps above), `buildSystemPrompt(taskText)`'s
output is **byte-identical** to today — a regression test asserts this
directly, not just "no visible difference."

`runOrchestratorSupervisor()` awaits the cache-first
`inspectTargetProject(task.text, conversationId)` before calling
`runSupervisor()`, and passes the result through when non-null. This
function is already fire-and-forget at its only call site
(`dispatchRootTask()`'s `plan-task` branch), so the added latency (a
cache hit is effectively free; a miss costs one bounded local MCP round
trip) extends how long a plan run takes to *start dispatching*, never
the synchronous `POST /tasks` HTTP response.

### 4. A real fallback where dispatch has no agent to reach

`dispatchRootTask()`'s existing no-agent branch
(`index.ts:1665-1680`) gains one precondition check before it fails:
if the unreachable skill is one the Orchestrator's own inspection can
answer (`analyze-project`, `git-status` — the read-only skills this
capability structurally covers), try `inspectTargetProject()` first and
complete the task from that instead of failing. Any other skill, or
inspection also returning `null`, falls through to the existing failure
unchanged.

This sits inside `dispatchRootTask()` specifically because `specs/044`
deliberately extracted it out of `POST /tasks` so `/ask` and
`POST /tasks` share one dispatch path rather than two independently
maintained copies — so both entry points gain the fallback from one
change, and `specs/057`'s conversation-scoped snapshot cache (which
`dispatchRootTask()` already consults earlier in the same function) is
completely unaffected: this fallback is reached only *after* that cache
has already had its chance and a real agent lookup has already failed.

**A constraint that must be honoured for the `/ask` path specifically**:
`answer-harness.ts` validates every number in a synthesized answer
against its own `source` parameter, and that module's own docstring
states `source` is "never raw project files the model went and fetched
itself." Inspection text reaching an `/ask` answer must therefore be
folded into `source` before synthesis, not bypassed around it — a
grounded answer quoting inspection data must actually be able to cite
it, or the harness will reject it and silently fall back to the raw
result (a fail-open the mechanism already does correctly today — the
new content just needs to be visible to it).

### 5. `/healthz`, shutdown, and compose

- `/healthz` gains an `mcp: …` field, using `readiness()` — a pure,
  synchronous snapshot, deliberately not `pingReady()`, which performs
  real I/O and would make every `/healthz` call block on the
  Orchestrator's own optional dependency. Reports a distinct state
  when construction failed (no client at all) versus connecting/
  retrying/connected.
- **The Orchestrator gains a minimal shutdown.** It has none today — no
  SIGINT/SIGTERM handler, the `serve()` handle isn't even retained.
  This now matters concretely: one `callTool()` against an unreachable
  MCP server leaves a perpetual 5-second-interval reconnect loop
  running for the rest of the process's life
  (`mcp-client.ts`'s `connectionLoop()`, uncapped attempts). Mirrors
  `packages/agents/documentation/index.ts:926-948`'s existing shape —
  `mcpClient.stop()` then `agentHttpServer.stop(true)`. Named plainly:
  this closes a pre-existing gap the Orchestrator has always had, as a
  direct consequence of this spec being the first thing to give it
  anything worth stopping.
- **`docker-compose.yml`**: the `orchestrator` service currently sets
  neither `ORCHESTRAI_MCP_URL` nor `ORCHESTRAI_MCP_ALLOWED_HOSTS`. Both
  are added, matching `devops-agent`'s existing block exactly. No
  volume mount is needed — every MCP client forwards path strings as
  call arguments; `mcp-http` alone holds the target-project mount. This
  is precisely the omission `specs/082`'s own compose pass found the
  hard way for two other agents (`testing-agent`/`documentation-agent`
  silently sitting in `mcp.state: "retrying"` forever while `/healthz`
  still reported `{status: "ok"}`) — added here from the start rather
  than rediscovered.

## Safety constraints

- **Read-only, structurally.** Exactly the four general-inspection
  tools `specs/101` already established as this codebase's uniform
  set — no write, execute, docker, or git-commit tool is ever bound.
- **Not a skill.** Never advertised in an Agent Card (the Orchestrator
  has none of its own), never enters `buildCapabilitySnapshot()`, never
  reachable via `selectedSkill`. `SKILL_TIER_REGISTRY` and
  `SUPERVISOR_ALLOWED_SKILLS` are untouched — no skill id gains a
  second owner, so `specs/101`'s own collision guard is structurally
  unaffected by this spec's existence.
- **Strictly optional, provably.** A dedicated test suite exercises
  every degradation path directly: no client, an unresolvable path, a
  throwing `callTool()`, and a malformed `ORCHESTRAI_MCP_URL` at
  construction time. Every one must leave the Orchestrator's own
  observable behavior identical to before this spec.
- **The approval gate is completely untouched.** No `actionId` flow, no
  write path, nothing this capability does is ever approval-gated,
  because nothing it does writes.
- **No second harness.** `inspectTargetProject()`'s output is raw,
  deterministic text assembled from real tool results — never passed
  through an LLM of its own. The existing supervisor LLM call and the
  existing `/ask` answer-synthesis LLM call are the only model calls
  involved, unchanged in kind.

## Acceptance criteria

- [x] `inspectTargetProject()` returns `null` (never throws) for: no
      client constructed, an unresolvable target path, and a
      `callTool()` failure. Unit-tested directly for all three.
- [x] A malformed `ORCHESTRAI_MCP_URL` does not crash Orchestrator
      module load or `start()` — construction failure degrades to a
      logged warning and a `null` client. `buildOrchestratorMcpClient()`
      extracted specifically so this is provable without re-importing
      the module; unit-tested for malformed/non-http/non-allowlisted
      URLs and the `=0` opt-out, all four.
- [x] `buildSystemPrompt(taskText)` with no `projectContext` argument
      produces byte-identical output to before this spec. Unit-tested,
      and with `projectContext` supplied, the real resolved path
      appears in the prompt — the direct fix for `dispatch_skill`'s own
      `target` being model-invented. **Live-verified 2026-09-20**: a
      real zero-agent `plan-task` run's own plan step correctly named
      `package.json` — a fact only present in the real grounding block
      (`analyze_project`'s own `hasManifest (package.json)` line), never
      in the raw request text — confirming the model genuinely read and
      acted on the injected grounding.
- [x] A real dispatched `analyze-project`'s cache entry and the
      supervisor's own inspection share one cache entry — proven by a
      call-count assertion (only the cheap `git_status` cross-check
      runs on a hit, never a second `analyze_project` call), not
      output equality alone. Unit-tested.
- [x] A cache hit whose cross-check no longer matches falls through to
      a genuine fresh fetch. Unit-tested.
- [x] A request with **no `conversationId`** never touches
      `projectSnapshotCache` — matching `specs/057`'s own existing
      rule, unchanged. Unit-tested.
- [x] **Corrected during implementation** (see the status banner
      above): the motivating scenario is fixed via
      `composeSupervisorResult()`'s new zero-dispatch case, not
      `dispatchRootTask()`'s no-agent branch as originally assumed —
      unit-tested directly (real inspection content replaces the
      generic line when `dispatchCount === 0`; a non-zero dispatch
      count ignores `projectContext` entirely). **Live-verified
      2026-09-20**, closing this spec's single most important open
      item: a real `orchestrai --only orchestrator` process (genuinely
      zero agents, confirmed via `/agents` → `count: 0`), a real Gemini
      key, a real scratch git project. `POST /tasks {"text": "what
      language and stack is this project using?"}` routed to
      `plan-task` (the router correctly found no online agent to name
      directly), the supervisor tried `run-command` and it failed with
      no agent (`dispatchCount` stayed `0`), and the task's real,
      final result was:
      `"No agent dispatch was needed — answered directly from the
      Orchestrator's own project inspection:"` followed by the real
      `analyze_project` report (real file listing, real
      `hasManifest (package.json)`) and real `git_status` output (real
      branch, real uncommitted file, real commit log) — exactly the
      scenario this spec exists to fix, confirmed end to end with a
      real model and real zero-agent process, not simulated.
- [x] `dispatchRootTask()`'s own no-agent fallback (kept as genuine
      defense-in-depth, not the primary mechanism) is exported and
      tested directly with an explicit skill: completes with a real
      answer when inspection succeeds, degrades to the exact pre-102
      failure when it doesn't, is a no-op for any skill outside
      `analyze-project`/`git-status`, and never engages when a real
      agent is actually online for the skill.
- [x] `/healthz` reports an `mcp` field distinguishing "no client
      constructed" (`{state: "disabled"}`) from
      "connecting"/"retrying"/"connected"/"disconnected". Live-confirmed
      against a real running Orchestrator.
- [x] The Orchestrator gains a shutdown path (none existed before this
      spec) that stops its MCP client on SIGINT/SIGTERM. **Not
      live-verified as a clean interactive shutdown**: this sandbox's
      only means of stopping the process (Windows `Stop-Process`) does
      not deliver a real SIGINT the way an interactive terminal's
      Ctrl+C does — the same standing limitation `specs/016`/`067`/`074`
      already documented. The process was confirmed to exit (not hang)
      either way.
- [x] `docker-compose.yml`'s `orchestrator` service sets
      `ORCHESTRAI_MCP_URL`/`ORCHESTRAI_MCP_ALLOWED_HOSTS` matching
      `devops-agent`'s existing block.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass, with
      every pre-existing test passing unmodified (1201 pass, 0 fail,
      net +24 over the pre-102 baseline of 1177).

## Non-goals

- **Any write-capable tool on the Orchestrator, ever.** This spec's own
  safety story depends entirely on the capability being read-only;
  widening it later is explicitly a different, higher-risk spec, not
  an extension of this one.
- **A second LLM harness on the Orchestrator.** Inspection output is
  raw, deterministic text — never model-authored commentary of its own.
- **Replacing `/ask`'s existing dispatch-first behavior.** Direct
  inspection is a fallback only, reached exclusively where dispatch
  already has no agent to reach; a working dispatch is always preferred,
  unchanged.
- **Reconciling `specs/101`'s own recorded three-way skill-ownership
  disagreement.** Unrelated to this spec; still open, still deferred.
- **Any change to `SKILL_TIER_REGISTRY`, `SUPERVISOR_ALLOWED_SKILLS`, or
  any Agent Card.**
- **Caching for conversation-less requests.** A bare `POST /tasks`
  (no `conversationId`) never touches `projectSnapshotCache`, exactly
  as `specs/057` already established — considered directly and
  declined, not overlooked. A second, conversation-less caching
  mechanism would be new scope, not an extension of the existing one.
- **Any change to `specs/057`'s own TTL, eviction bounds, or its
  git-status cross-check for a dispatched `analyze-project` hit.** This
  spec adds one more writer/reader of the existing cache; the cache's
  own semantics are untouched.
- **`dispatchPlanStep()`'s own separate no-agent handling.** A real,
  named gap found during implementation: when the supervisor *does*
  choose to dispatch a plan step naming `analyze-project`/`git-status`
  and no agent owns it, `dispatchPlanStep()`
  (`apps/orchestrator/index.ts`) has its own independent no-agent
  branch — `console.log`, `step.status = "failed"`, return `null` — a
  different code path from `dispatchRootTask()`'s, and this spec does
  not touch it. The supervisor's own pre-run grounding and
  `composeSupervisorResult()`'s zero-dispatch surfacing (both in this
  spec) cover the case where the supervisor recognizes from its
  grounding that no dispatch is needed at all; they do not help if it
  dispatches anyway and that specific step fails. Extending inspection
  to that branch too would be a reasonable, small follow-up, deliberately
  not attempted here to keep this spec's own scope to what was approved.

## Verification plan

- Unit: every `inspectTargetProject()` degradation path listed in
  Acceptance Criteria, asserted directly; the byte-identical
  no-context prompt regression test; the no-agent fallback firing only
  when genuinely no agent owns the skill and staying inert otherwise;
  the cache-hit/cache-miss/no-conversation behavior above, each proven
  by a real call-count assertion on the mocked MCP client (mirroring
  `specs/097`'s own `__getTestSynthesisCallCount()` precedent for
  proving "zero calls made," not inferring it from output equality).
- `bun run typecheck`, `bun run specs:catalog`/`specs:check`.
- Live, the decisive pair naming the exact scenario that motivated this
  spec: (1) Orchestrator + `mcp:http` only, zero agents online — a
  project question that today fails outright returns a real answer;
  (2) the identical request with MCP itself stopped — degrades cleanly
  to today's exact failure, no crash, no hang.
- Live: a real multi-agent `plan-task` run, confirming the grounding
  block reaches the real prompt and the first dispatched step's target
  path matches the real resolved path rather than a model guess.
