# Verification: specs/101 — Per-Agent Tool Access Expansion

## What changed

**A — uniform inspection set.** Every code-reasoning agent's
`requiredTools` now includes `read_project_file`, `analyze_project`,
`git_status`, `git_diff`. Harness allow-lists (`READ_ONLY_TOOL_NAMES` /
`buildReadOnlyTools()`) follow: DevOps, Testing, Documentation, Coder
bind all four; Code Review binds three, deliberately excluding
`git_diff` since its harness already receives the combined diff as
prompt context.

**B — the two orphaned DevOps tools, resolved oppositely.**
`lint_ci_workflow` is now wired into `create-ci`'s own post-write path
in `resumeTask()`. `audit_dependencies_local` is removed from DevOps's
`REQUIRED_TOOLS` (superseded by `specs/085`'s real multi-ecosystem
Security parsing) but stays registered on the MCP server.

**C — the tool-vs-skill rule.** Documented in `CLAUDE.md`. A new
`packages/shared/agent-card-skill-collision.test.ts` walks the six real
Agent Cards and fails on any collision. The Orchestrator's `/healthz`
gained a `capabilities: {ok, error?}` field
(`capabilitySnapshotStatus()` in `apps/orchestrator/index.ts`,
factored out of `buildCapabilitySnapshot()`'s own existing computation).

## Test results

- `bun test` (full suite): **1177 pass, 0 fail, 2 skip** (pre-existing
  Docker-daemon-gated tests, unrelated) — net **+13** over the pre-101
  baseline of 1164.
- `bun run typecheck`: 0 errors.
- `bun run specs:catalog` / `bun run specs:check`: pass, 100 specs.
- New/extended test coverage: `packages/shared/agent-card-skill-collision.test.ts`
  (4 tests), `apps/orchestrator/healthz-capabilities.test.ts` (2 tests),
  plus extended tool-set assertions in all five agents'
  `llm-harness.test.ts` files (closure-capture proofs for
  `analyze_project`/`git_status`/`git_diff`, and Code Review's dedicated
  "git_diff is deliberately never bound" test).

## Live verification

Started the full stack (`mcp:http` + all 5 non-Security agents, LLM
harnesses off — no credentials available in this session).

**Tool discoverability (section A)** — every agent's real `/healthz`
reported `mcp.state: "connected"` with all four inspection tools (plus
every other server-side tool) in `discoveredTools`:

```
devops-agent:        state: connected — analyze_project, git_status,
                      git_diff, read_project_file, + 13 more present
testing-agent:        state: connected — identical discoveredTools list
documentation-agent:  state: connected — identical discoveredTools list
code-review-agent:    state: connected — identical discoveredTools list
coder-agent:          state: connected — identical discoveredTools list
```

This is the real regression check for section A: a `requiredTools`
entry the MCP server doesn't provide would make that agent fail to
connect. None did.

**`lint_ci_workflow` wiring (section B)** — real scratch git project
(`package.json` + `math.js`, committed). Dispatched
`create-ci` directly to DevOps, approved the real `actionId`-bound
preview, and the completed task result was:

```
Workflow created at ...\.github\workflows\ci.yml

name: CI
...

=== CI Workflow Lint ===
No structural issues found — has 'on:' and 'jobs:' keys, no tabs.
```

Confirms both halves: the file was written, and the lint result is
folded into the same task result, exactly as designed.

**`audit_dependencies_local` removal (section B)** — confirmed in the
same `/healthz` output above: `audit_dependencies_local` is present in
the MCP server's `discoveredTools` (still registered) but is no longer
one of the tools DevOps required to connect (confirmed by reading
`packages/agents/devops/mcp-client.ts`'s `REQUIRED_TOOLS` directly —
it is absent).

**`git_diff` tool correctness** — made a real uncommitted edit to
`math.js` in the scratch repo (added an empty-array guard), then
dispatched `git-diff` directly to DevOps (which already had `git_diff`
wired before this spec). The real result:

```
diff --git a/math.js b/math.js
index 33e6a93..0ce2057 100644
--- a/math.js
+++ b/math.js
@@ -1,3 +1,4 @@
 export function average(nums) {
+  if (nums.length === 0) return 0
   return nums.reduce((a,b)=>a+b,0)/nums.length
 }
```

Confirms the MCP tool underlying every new `git_diff` binding correctly
captures real uncommitted work — the same signal Coder's, Testing's,
and Documentation's new bindings will surface to a model once a real
provider key is available.

**Collision guard** — both directions proven, live and by test: the
real six Agent Cards pass the collision test; a synthetic collision
correctly makes `/healthz` report `capabilities.ok: false` with the
offending skill id named (`apps/orchestrator/healthz-capabilities.test.ts`).

## Closed live, 2026-09-20 — real model usage, with an honest result

A real Gemini key became available (Yusuf: *"the real api key is here
in the conf in orch folder in this repo, and you can run a reall
terminal test without me"*). Three real requests were dispatched
against a real scratch project with a real uncommitted change, one per
harness with the new tools bound: **Coder** (`edit-file`), **Documentation**
(`generate-readme`), **Code Review** (`review-diff`).

**Honest result: the new tools were never called.** All three tasks
completed correctly using only the pre-existing `read_project_file` (and,
for Code Review, its own pre-existing deterministic `git_diff` fetch) —
`analyze_project`/`git_status`/the new harness-bound `git_diff` were
available in every case and never invoked. This is not a defect: each
task was narrow enough that `read_project_file`'s own real current-file
content already supplied everything needed, including the same
uncommitted-work signal `git_status` exists to provide. The tools'
*reachability* was already proven (per-agent `/healthz`, unit tests
against a scripted model); what these three real runs additionally
confirm is that a genuine model, given the choice, doesn't reach for
them when a narrower tool already suffices — real, useful information
about the marginal value of this widening in practice, recorded
honestly rather than as an unearned positive result. Code Review's
response was independently confirmed correct against a real,
accidentally-broken diff (a duplicate export and a truncated function,
both correctly flagged) — the model's judgment was sound even without
the new tools.

See `specs/102`'s own `verification.md` for the full transcript (same
live session) — that spec's Orchestrator-level inspection **was**
exercised for real, closing its own analogous open item.
- Following this codebase's own established convention
  (`packages/agents/devops/index.test.ts`'s own header comment: a
  genuine MCP round trip for a write skill is "this spec's own live,
  real stack verification item, not a unit test"), no automated test
  drives `create-ci`'s approve → write → lint sequence end to end; it
  is covered by the live transcript above instead.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/101-per-agent-tool-access-expansion/spec.md` (implemented) widened
tool access for four agents and wrote down a rule this codebase had
relied on since `specs/080` but never stated in one place. Raised
directly by Yusuf: *"now just i need to increse the tools each agant
can use and if a skill or tool that can more than agant use."*

**MCP tools are freely shareable across agents — this is established
precedent, not theory.** `read_project_file` is used by five agents,
`write_project_file` by three, `git_diff` and `run_command` by two each.
`specs/080`'s own correction of its first draft is the citation:
skill-ownership rules govern skill **ids**, not tool **access** —
nothing stops two agents sharing one tool.

**Skill ids are the opposite: exactly one owner, always.** If two online
agents ever advertise the same skill id, `normalizeAgentCapabilities()`
(`packages/shared/agent-capabilities.ts`) refuses the **entire**
capability snapshot — not just the ambiguous id.
`buildCapabilitySnapshot()` then returns `null`, the LLM router is never
called, and `detectSkill()` falls through to `"plan-task"` for **every
request in the system**, including ones about completely unrelated
skills. This used to be visible only as a single `console.log`; as of
`specs/101`, the Orchestrator's own `/healthz` reports it directly as
`capabilities: {ok, error?}`, mirroring how every agent already reports
`dependencies: {mcp: …}`. A new test
(`packages/shared/agent-card-skill-collision.test.ts`) walks the six
real Agent Cards and fails in CI if any skill id is ever declared by two
of them, before a collision can reach a running system.

**Namespacing skill ids (`devops.analyze-project`) was considered and
rejected.** It would make collision structurally impossible, which this
codebase generally prefers over conventional enforcement — but it would
leak agent identity into the router's capability decision. The router
is deliberately shown skill ids **only**, never agent names
(`packages/shared/capability-router.ts`'s prompt construction dedupes to
skill ids before the model ever sees them), so the model selects a
*capability* and the Orchestrator separately resolves *who* provides
it. Namespacing collapses that separation and invites prefix bias
toward whichever agent's ids happen to dominate the list. It would also
touch skill ids across all six Agent Cards, both of the adaptive
supervisor's own hardcoded tables (`SKILL_TIER_REGISTRY`,
`SUPERVISOR_ALLOWED_SKILLS`), every agent's text detector,
`selectedSkill` on every dispatch, and the router prompt — `specs/054`'s
own words call skill ids "the entire compatibility surface." The test
plus the `/healthz` signal give the same protection for a fraction of
the cost.

**Three components currently give three different answers to a
duplicated skill id, recorded honestly rather than silently implied to
agree**, reconciling them left as named follow-up work:

| Component | Behaviour on a duplicated skill id |
|---|---|
| `normalizeAgentCapabilities()` | Refuses — globally, killing the whole snapshot |
| `findAgentForSkill()` (`apps/orchestrator/index.ts`) | Silently first-match-wins, by registry insertion order |
| `validateSelectedSkillOwnership()` (`packages/shared/task-envelope.ts`) | Permits — a membership check, not an exclusivity one |

**The tool-widening itself: a uniform rule, not case-by-case
justification.** Of the 17 MCP tools, four are general inspection —
`read_project_file`, `analyze_project`, `git_status`, `git_diff` — and
every code-reasoning agent now gets all four:

| Agent | Tools |
|---|---|
| DevOps | all 17 it reached before, unchanged (already had all four inspection tools) |
| Testing | `+analyze_project`, `+git_status`, `+git_diff` |
| Documentation | `+analyze_project`, `+git_status`, `+git_diff` |
| Code Review | `+analyze_project`, `+git_status` (not `git_diff` — already receives the combined diff as prompt context) |
| Coder | `+analyze_project`, `+git_status`, `+git_diff` |
| Security | unchanged — direct-`fs`, zero MCP tools, `specs/011` decision (c) |

An earlier draft of `specs/101` itself justified each addition
individually, following `specs/042`'s "only where a real need is shown"
principle literally — and that approach had already failed once inside
the same draft: it gave Coder git tools but not `analyze_project`,
despite Yusuf having named Coder specifically when he said analysis
must not be DevOps-only. The rule now applies `specs/042`'s principle at
the level of the **group** (these four tools together answer "what is
this codebase and what state is it in?", a question every
code-reasoning agent genuinely has) rather than negotiating each pair,
because for tools that can only ever read, the cost of withholding one
that would have helped is invisible, while the cost of granting one
that goes unused is a line in an allow-list.

The three **specialised** read-only tools (`docker_status`,
`lint_ci_workflow`, `audit_dependencies_local`) stay DevOps-only — they
answer domain-specific questions, not general ones, and sharing them
would be noise rather than capability. All 10 write/execute tools stay
unshared; sharing one grants a new approval-gated capability, which
`specs/078`'s own ordering principle holds is a new risk class deserving
its own spec, not a line item here. The most concrete candidate named
and deliberately deferred: giving Coder `run_command`/`run_tests` so it
could verify its own proposed edit — genuinely attractive, explicitly
not attempted here.

**The same live session also closed `specs/101`'s own open item, with
an honest result.** Three real requests (Coder's `edit-file`,
Documentation's `generate-readme`, Code Review's `review-diff`) were
dispatched with the new tools bound and a real uncommitted change
present. All three completed correctly using only the pre-existing
`read_project_file` — `analyze_project`/`git_status`/the new
harness-bound `git_diff` were never called. Not a defect: each task was
narrow enough that `read_project_file`'s own real current-file content
already supplied everything needed. The tools' reachability was already
proven; what this confirms is that a genuine model doesn't reach for
them when a narrower tool already suffices — real information about
this widening's marginal value in practice, recorded honestly rather
than claimed as an unearned positive. (Incidentally, Code Review's real
response correctly flagged a duplicate export and a truncated function
in an accidentally-broken scratch diff — its own judgment was sound
either way.) See `specs/101`'s own `verification.md` for the full
transcript.

See specs/103-deep-project-analysis/verification.md for the relocated narrative covering this checkpoint.

See specs/114-coder-multi-file-edit-and-create/verification.md for the relocated narrative covering this checkpoint.

See specs/102-orchestrator-readonly-project-inspection/verification.md for the relocated narrative covering this checkpoint.
