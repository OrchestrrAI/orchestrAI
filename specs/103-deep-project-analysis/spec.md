---
id: 103-deep-project-analysis
title: "analyze-project Gains Real, Grounded Codebase Analysis"
area: devops-agent
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-20
updated: 2026-09-21
approved_by: Yusuf
approved_on: 2026-09-20
implemented_on: 2026-09-20
amends:
  - 042-llm-harness-devops
  - 057-project-snapshot-and-cross-request-reuse
  - 099-tui-port-url-and-analyze-project-stack-awareness
  - 102-orchestrator-readonly-project-inspection
related:
  - 043-llm-harness-security
  - 077-agent-enabled-means-llm-on-by-default
  - 082-code-review-agent
  - 094-analyze-project-security-precheck-opt-in
  - 100-document-api-grounded-llm-route-discovery-fallback
  - 101-per-agent-tool-access-expansion
supersedes: []
superseded_by: []
---

# Spec: analyze-project Gains Real, Grounded Codebase Analysis

> Status: **DRAFT — awaiting review.** This closes the oldest unaddressed
> request in this project. Yusuf, at the start of the 2026-09-20 session:
> *"the defention of the analization doesn't means to get the git and the
> list of files, it should be more and more deep into the code base like
> code desigen battern language many other."* That request was scoped down
> at the time into tool-**access** work (`specs/101`) and Orchestrator-level
> **reach** (`specs/102`) — neither of which touched what `analyze_project`
> actually computes. Re-raised live the same day after a real dispatch:
> *"can you analyze my repo check what is on it and if there is any area of
> improvemnt"* routed correctly to `analyze-project`, completed
> successfully, and returned a presence checklist that says nothing about
> the actual code. Yusuf, on being shown that 101/102 had not in fact
> addressed it: *"but what we did in 101 102 didn't we do that?"* — they
> did not, and this spec says so plainly rather than treating the earlier
> work as having covered it.

## Purpose

`analyze-project` is the only skill in this system whose name and
description promise analysis, and the only DevOps skill that performs no
model reasoning at all. Its entire output is derived from file
**existence**, never file **content**.

## Current behavior

Verified directly against the live code, not from documentation:

**`packages/mcp/index.ts:737-798`** — the `analyze_project` MCP tool,
described as *"Analyze a project directory structure and suggest DevOps
improvements"*, returns exactly:

- Six boolean presence checks (`hasDockerfile`, `hasDockerCompose`,
  `hasGitignore`, `hasEnvExample`, `hasCI`, `hasReadme`) — `existsSync`
  only, never opened.
- Whether `.git/` exists.
- `buildEcosystemManifestLines()` (`specs/099`) — the real ecosystem's
  manifest/lockfile, still a presence check.
- A flat one-level directory listing — names only, no content, not
  recursive.
- A **fixed one-to-one suggestion mapping**: each false boolean maps to a
  canned string (`!hasDockerfile` → `"Missing Dockerfile — use
  create_dockerfile tool"`, and so on). Six possible suggestions exist in
  total, and every one of them is about a missing DevOps file.

**`packages/agents/devops/index.ts:527-585`** — `skillAnalyzeProject()`
makes exactly one `analyze_project` tool call, optionally appends a
Security secrets pre-check (`specs/094`, off by default), and returns.
**It never calls DevOps's LLM harness.** DevOps has a full, default-on
harness (`specs/042`, `specs/077`) used by its four write skills to decide
parameters; `analyze-project` is the one skill that never reaches it.

Consequence, stated plainly: a request to analyze a codebase cannot
currently surface anything about the codebase. It cannot name the
framework in use, describe how the code is organised, or identify a
single improvement that is not "you are missing one of these six files."
This is not a defect in the implementation — the tool does exactly what
it was written to do — it is a gap between what the skill is named and
what it does.

## Two constraints found while grounding this spec

Both were verified against real code before any design was chosen, and
both materially shaped it.

### 1. The MCP tool must stay fast and deterministic — it is load-bearing elsewhere

`specs/102` gave the Orchestrator its own MCP client and calls
`analyze_project` + `git_status` to ground the adaptive supervisor's
first decision (`fetchProjectInspection()`,
`apps/orchestrator/index.ts`). That design rests explicitly on these
being *"fast local calls with no LLM involved."*

Precisely how often that runs, verified rather than assumed — the
distinction matters for this spec's own reasoning:

- **With a `conversationId`** (a `/ask` chat turn): cache-first. On a hit
  it makes one cheap `git_status` call as a drift cross-check and, if the
  fingerprint matches, reuses the cached analysis — `analyze_project` is
  not called at all.
- **Without one** (a bare `POST /tasks`, which is the TUI's ordinary
  submit path): both cache read and cache write are gated on
  `conversationId`, so neither happens — both tools genuinely run fresh
  on every such plan. This is `specs/057`'s own deliberate rule (no
  conversation scope means no safe invalidation key), and it is
  acceptable today only because both calls are local filesystem
  operations costing milliseconds.

That second case is the load-bearing one here: "fresh on every plain task
submission" is harmless for an `existsSync`-and-`readdir` tool and would
become a real per-plan cost the moment the same call involved a provider
round-trip.

Therefore this spec **must not** put model reasoning inside the
`analyze_project` MCP tool. Doing so would put a provider round-trip on
the critical path of every plan, and would make the Orchestrator's own
grounding depend on an LLM to describe a project to an LLM.

**The depth goes in DevOps's `analyze-project` skill, not in the tool.**
The tool stays byte-identical. This is also why no new MCP tool is
needed: DevOps's harness already binds `read_project_file`,
`analyze_project`, `git_status`, and `git_diff` (`specs/101`), which is
precisely the tool set required to read and reason about a real
codebase — the first genuine consumer of that widening, which
`specs/101`'s own verification record honestly noted no real model had
yet chosen to use.

### 2. `specs/102`'s deliberate cache-sharing becomes wrong once the skill is deeper

`specs/102` deliberately shares one `projectSnapshotCache` entry between
the Orchestrator's own inspection and a real dispatched `analyze-project`
skill result — both write key `(conversationId, "analyze-project",
target)` (`apps/orchestrator/index.ts`, the `fetchProjectInspection()`
write and `dispatchRootTask()`'s own write). Its stated rationale:
*"whichever happens first in a conversation grounds the other for free."*

That was correct **while both produced identical shallow tool output**.
It becomes actively wrong the moment the skill's output is richer: since
the Orchestrator's inspection runs on every `plan-task`, it would
routinely populate the shared entry first with the **shallow** tool text,
and a later real `analyze-project` request in the same conversation would
be served that shallow result instead of running the deep analysis — a
silent downgrade with no signal to the user.

This spec therefore **amends `specs/102`'s own approved decision**: the
Orchestrator's internal inspection gets its own distinct cache key, so
the two stop colliding. `specs/057`'s skill-level caching is otherwise
untouched. Recorded as a genuine reversal with its reason, not a silent
adjustment.

## Proposed behavior

**The deterministic report always runs first and is always present,
unchanged.** `specs/043`'s exact precedent: the deterministic scan is the
task's core content regardless of harness state, and the model layer is
strictly additive commentary on top of it.

When DevOps's harness is active (default-on, `=0` to disable), a new
`runProjectAnalysisHarness()` explores the real project via the
already-bound read-only tools and appends one additional section:

```text
=== Codebase Analysis ===
Stack: <real language/framework, from real manifest dependencies>
Structure: <how the code is actually organised>
Observations:
• <observation> (<real/file/path>)
• <observation> (<real/dir/>)
Based on N file reads within this project.
```

Every line in that section is additive. Nothing in the deterministic
report above it is ever edited, removed, reordered, or reinterpreted —
enforced by the shape of what the harness returns (a block of text
appended after the base report), never by prompt instruction alone, the
same structural approach `specs/043` uses for Security's commentary.

The trailing "Based on N file reads" line is not decorative: this
harness reads a bounded sample of files, never the whole project, so the
report must never read as if it implies full coverage.

### Decision 1 — the prompt is pre-fed the same facts the deterministic scan already computed, nothing more

The system prompt for this harness includes the real, already-computed
flat directory listing and real manifest content (`package.json`,
`requirements.txt`, etc. — whichever `buildEcosystemManifestLines()`
already resolved) verbatim, before the model makes a single tool call.
Confirmed directly: `analyze_project`'s own `readdir()` call
(`packages/mcp/index.ts:760`) is single-level, non-recursive — this is a
flat list of top-level names, not a tree, and not file content.

**This is the entire codebase-exposure surface at prompt-build time — no
source file content is ever included until the model explicitly reads
one, one file at a time, via the same bound `read_project_file` tool
every harness in this codebase already uses.** Pre-feeding removes only
the redundant first 2-3 tool rounds a cold start would otherwise spend
re-deriving facts the deterministic scan already has; it does not change
what the model is allowed to read, how much of it, or under what bound.

This mirrors two existing precedents directly: `document-api`'s harness
is *given* the already-discovered route list rather than rediscovering
it, and `specs/100`'s route-discovery fallback hands over file content
already in hand rather than re-reading it.

### Decision 2 — structured, validated output, not free-form prose

The harness returns JSON validated against a schema — reusing
`packages/agents/devops/llm-harness.ts`'s existing `validateJsonParams()`
machinery, the same pattern `specs/042`'s four write skills already use:

```ts
{
  stack: string,
  structure: string,
  observations: [{ text: string, paths: string[] }],
}
```

Each observation carries its cited paths as a real structured field, not
text to be regex-scraped afterward — path grounding (below) checks
`observations[i].paths` directly against the real directory listing and
the real reads the harness performed. The `=== Codebase Analysis ===`
block shown above is rendered from this structure deterministically
after validation and grounding both pass — the model never writes the
final report text directly.

### Decision 3 — always deep when the harness is on; no shallow-dispatch mechanism yet

Checked directly, not assumed: the adaptive supervisor's plan-step
dispatch (`dispatchPlanStep()`) never consults `specs/057`'s
conversation-scoped cache at all — that integration was explicitly
deferred by `specs/057` itself and remains deferred. So every plan
containing an `analyze-project` step pays this harness's real cost
(a provider round trip, up to `HARNESS_RECURSION_LIMIT` tool rounds)
freshly, every time, with the harness on.

A hard guarantee against this (an `analysisDepth` field on the shared
task envelope, letting the Orchestrator force a plan-step dispatch
shallow) was considered and deliberately **not** adopted here: it touches
a type every one of the six agents parses, for a cost problem with no
live evidence yet of how often it actually occurs — `specs/102` already
grounds the supervisor's very first decision with `analyze_project`'s own
output before planning starts, so a step dispatching `analyze-project`
purely to orient itself may already be rare.

Instead: `buildSystemPrompt()` (`apps/orchestrator/supervisor-graph.ts`)
gains one added line telling the supervisor it is already grounded in
the project's structure and should not dispatch `analyze-project` again
solely to re-orient — only when a fresh or updated analysis is
specifically what the request calls for. This is a prompt instruction,
not a structural guarantee — the model can still choose to dispatch it
regardless, and if it does, the cost is paid exactly as described above.
If live use shows this happening often enough to matter, the envelope
field becomes a well-evidenced follow-up (recorded as its own item in
`specs/104`) rather than speculative work done now.

### Decision 4 (raised by Yusuf, real scope, deferred) — this is DevOps-only, other agents cannot produce this report

This spec deepens exactly one skill: DevOps's own `analyze-project`.
`specs/101`'s skill-ownership rule (one skill id, one owner, or the
entire router snapshot refuses) means this exact skill cannot be
duplicated onto Code Review, Coder, or the Orchestrator.

What already exists, and is not new: Code Review, Coder, Testing, and
Documentation's own harnesses already have `analyze_project`/
`read_project_file` bound (`specs/101`) — each can already reach for
project-wide context while doing *its own* job (reviewing a diff, editing
a file, writing tests), just never as a dedicated "produce a report"
capability. The Orchestrator's own inspection (`specs/102`) deliberately
stays shallow — deepening it would reintroduce exactly the "must stay
fast, grounds every plan" problem constraint 1 above exists to avoid.

A genuinely separate, reachable-from-multiple-agents deep-analysis
capability is real, additional scope this spec does not attempt —
recorded as its own item in `specs/104-deferred-work-register` rather
than folded in here silently.

### Grounding: every observation must cite a real path

`specs/100` could ground a claimed route by literal substring against the
real file text. An architectural observation has no equivalent literal to
match. The honest analogue — and the same bar `specs/082`'s code review
already sets, where a comment must cite a real file and a real line
present in the diff — is **path grounding**:

- Every observation must cite at least one path (file or directory).
- Every cited path must genuinely exist — verified against the real
  directory listing and the real reads the harness performed, never
  against the model's own claim.
- An observation citing a path that does not exist triggers bounded
  retry-with-feedback naming the specific bad path.
- On exhausted retries, **salvage only the grounded observations**
  (`specs/082`'s own "don't discard a real finding to punish one
  hallucinated one" precedent) and note how many were dropped.
- If **zero** observations survive grounding, the section is omitted with
  an explicit note. The deterministic report is unaffected.

This does not make an observation *correct* — a real file can be cited
alongside a wrong claim about it. It makes an observation *checkable*:
the reader is always pointed at real code they can open and judge. That
limit is stated here rather than overclaimed.

### Fail-open, not fail-closed

`specs/043`'s precedent, and for its exact reason: a complete, correct,
useful deterministic report already exists. A harness failure (missing
key, provider error, exhausted retries, recursion limit) appends
`"Codebase analysis unavailable: <reason>"` and the task still
**completes** with the full deterministic report intact. Losing the added
section must never lose the checklist.

This is deliberately *not* `specs/082`/`specs/100`'s fail-closed shape,
because those have no deterministic baseline to preserve — `review-diff`
and route discovery produce nothing without a model. This one does.

## Scope

In scope:

- A new `runProjectAnalysisHarness()` in
  `packages/agents/devops/llm-harness.ts`, reusing the existing
  `buildHarnessGraph()`/`runHarness()` core, the existing bound read-only
  tool set, and `specs/098`'s existing `HARNESS_RECURSION_LIMIT` bound —
  no new graph machinery, no new bounds invented.
- Path-grounding validation and salvage-on-exhaustion inside that
  harness's own validator.
- Wiring it into `skillAnalyzeProject()`
  (`packages/agents/devops/index.ts`) as an additive section after the
  existing deterministic result.
- Giving the Orchestrator's own internal inspection a distinct
  `projectSnapshotCache` key (amending `specs/102`).

Out of scope — explicitly unchanged:

- `analyze_project`'s MCP tool implementation (`packages/mcp/index.ts`) —
  byte-identical, for the reason in constraint 1.
- The Security secrets pre-check (`specs/094`) and its opt-in flag.
- Every other DevOps skill, every other agent.
- `SKILL_TIER_REGISTRY` — `analyze-project` stays Tier 2 read-only; this
  skill writes nothing and gains no approval gate.
- Any new MCP tool or new tool binding.

## Safety constraints

- **Read-only throughout.** No write-capable tool is bound or reachable;
  the existing structurally-enforced allow-list
  (`READ_ONLY_TOOL_NAMES`/`buildReadOnlyTools()`) is unchanged and still
  throws at graph-build time if ever edited to bind a write tool.
- **No approval gate change.** This skill executes nothing and writes
  nothing. Its risk is a wrong sentence in a report a human reads — the
  same stakes `specs/041` assessed for Documentation, the lowest in this
  codebase.
- **The deterministic report is never modified.** Structural, not
  prompted: the harness returns an appended block; no code path lets its
  output edit the base text.
- **No fabricated paths.** Path grounding is enforced in code against the
  real listing, not by prompt wording.
- **Bounded.** Exploration is bounded by the existing
  `HARNESS_RECURSION_LIMIT` (20) and `specs/055`'s existing provider
  retry budget. No new unbounded loop is introduced.

## Acceptance criteria

- [x] With the harness disabled (`ORCHESTRAI_DEVOPS_LLM_HARNESS=0`),
      `analyze-project`'s output is **byte-identical** to before this
      spec, confirmed against a real project, not only by unit test.
      **Live-verified.**
- [x] With the harness active, a real request against a real project
      returns the full deterministic report **plus** a `Codebase
      Analysis` section that correctly names the real stack/framework and
      describes the real structure. **Live-verified** — see
      verification.md for an honest account of what the real model
      actually explored.
- [x] Every observation in that section cites a path that genuinely
      exists in the real project.
- [x] A forced ungrounded observation (citing a nonexistent path)
      triggers retry-with-feedback naming that path; exhausted retries
      salvage the grounded observations; zero grounded observations omits
      the section with an explicit note, deterministic report intact.
- [x] A harness failure (no key configured) completes the task with the
      full deterministic report plus an explicit
      `"Codebase analysis unavailable"` note — never a failed task.
      **Live-verified** with a genuinely broken model config.
- [x] The rendered section names how many files were actually read,
      never implying whole-project coverage.
- [x] The harness's own system prompt contains the real, already-computed
      directory listing and manifest content before the first tool call
      — confirmed by inspecting the constructed prompt in a test, not
      just by the model's resulting behavior.
- [x] The model's raw output is validated JSON
      (`{stack, structure, observations: [{text, paths}]}`); a malformed
      or wrong-shaped response triggers the same retry-with-feedback every
      other DevOps harness skill already uses.
- [x] `buildSystemPrompt()`'s added grounding line is present only when
      project context is available, and existing supervisor-prompt tests
      confirm it stays byte-identical with none (`specs/102`'s own
      additive-only guarantee, unbroken).
- [x] `analyze_project`'s MCP tool is confirmed unchanged
      (`git diff` on `packages/mcp/index.ts` shows no edit to it), and the
      Orchestrator's own `plan-task` grounding still completes with no
      added provider call.
- [x] The Orchestrator's internal inspection and a real dispatched
      `analyze-project` no longer share a cache entry — proven by a test
      that runs inspection first and confirms a subsequent real
      `analyze-project` dispatch is not served the shallow cached text.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass. Every
      pre-existing test passes unmodified **except** two in
      `apps/orchestrator/orchestrator-inspection.test.ts` that asserted
      `specs/102`'s original cache-sharing behavior — updated to assert
      the corrected, intentional reversal (constraint 2), not left
      broken or silently deleted; a new test was added confirming the
      inspection's own cache entry is still reused correctly on its own,
      unaffected by the key change.

## Verification plan

- Unit: the new harness's grounding validator (grounded acceptance,
  ungrounded rejection with the bad path named, salvage on exhaustion,
  zero-grounded omission), the fail-open path, and the cache-key
  separation.
- Live, against a real provider key and a real project: the harness-on
  case on a genuinely non-trivial codebase (this repository itself is a
  fair target), the harness-off byte-identical regression, and a
  confirmation that a `plan-task` run's own Orchestrator grounding made
  no additional provider call.

## Non-goals

- **Not a static analyser or linter.** No AST parsing, no new dependency,
  no rule engine. Observations are model-authored and path-grounded, not
  mechanically derived — the spec does not claim otherwise.
- **Not a security scan.** Security owns `scan-secrets` and dependency
  auditing (`specs/084`/`085`); this must not duplicate or contradict it.
- **Not a test-coverage report.** Testing owns that.
- **Not a code-review.** Code Review owns `review-diff`; this analyses a
  project at rest, not a change.
- **Not a new skill or agent.** Adding a second analysis-shaped skill id
  would create real routing ambiguity for the LLM router, which sees skill
  ids only — two near-synonymous ids is exactly the condition that makes
  its single-skill choice unreliable.
- **Not a change to what the MCP tool returns**, for the load-bearing
  reason in constraint 1.
