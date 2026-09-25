---
id: 101-per-agent-tool-access-expansion
title: "Expand Per-Agent Tool Access, and Write Down the Tool-vs-Skill Rule"
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
  - 079-phase-a-connect-orphaned-tools
  - 082-code-review-agent
  - 083-coder-agent
related:
  - 011-remaining-agents-mcp
  - 030-authoritative-skill-dispatch-and-capability-catalog
  - 042-llm-harness-devops
  - 054-capability-driven-llm-routing
  - 080-run-command-approved-execution
  - 085-multi-ecosystem-dependency-audit
  - 099-tui-port-url-and-analyze-project-stack-awareness
supersedes: []
superseded_by: []
---

# Spec: Expand Per-Agent Tool Access, and Write Down the Tool-vs-Skill Rule

> Status: **APPROVED and IMPLEMENTED 2026-09-20 by Yusuf.** Raised
> directly by Yusuf, 2026-09-20: *"now just i need to increse the tools
> each agant can use and if a skill or tool that can more than agant
> use."* Underneath it, a positioning point he made in the same
> session, worth recording verbatim because it explains *why* the
> imbalance matters: *"i didn't mension any marge i said the project
> should not be foucos only from the devops prospective, the intiat of
> it was as i'm a devops so that was the first direction but it should
> not."* Section A's own sharing policy was itself revised twice during
> review — from a case-by-case list to a uniform rule — after Yusuf
> pushed back directly: *"for a is it the only skills to be shared
> between other agent?"*, then *"can it be more tools to be shared? or
> what you think?"* See that section's own explanation of why the
> uniform rule replaced case-by-case justification.

## Purpose

The shared MCP factory (`packages/mcp/index.ts`) registers **17** tools.
DevOps can reach **15** of them. Every other agent can reach four or
fewer. That imbalance is the concrete, measurable shape of the
"everything is DevOps-shaped" problem — not a matter of framing.

This spec gives **every code-reasoning agent the same four
general-inspection tools**, resolves two tools DevOps declares but never
calls, and writes down the rule governing what may and may not be shared
between agents — a rule that is load-bearing, currently undocumented,
and whose violation fails silently and catastrophically.

**Every tool added by this spec is read-only.** No agent gains a new
write or execute capability, no new skill id is created, and the
approval gate is untouched.

## Verified current state

### Tool reach per agent

Read directly from each agent's own `requiredTools` declaration:

| Agent | Count | Tools |
|---|---|---|
| DevOps | 15 | `analyze_project`, `git_status`, `git_diff`, `git_commit`, `docker_status`, `docker_build`, `docker_run`, `create_dockerfile`, `create_github_action`, `create_dockercompose`, `create_gitignore`, `read_project_file`, `run_command`, `lint_ci_workflow`, `audit_dependencies_local` |
| Testing | 4 | `run_tests`, `read_project_file`, `write_project_file`, `run_command` |
| Documentation | 2 | `read_project_file`, `write_project_file` |
| Code Review | 2 | `git_diff`, `read_project_file` |
| Coder | 2 | `read_project_file`, `write_project_file` |
| Security | 0 | direct-`fs`, deliberately (`specs/011` decision (c)) |

Source lines: `packages/agents/devops/mcp-client.ts:5-40`,
`packages/agents/testing/index.ts:91-103`,
`packages/agents/documentation/index.ts:76`,
`packages/agents/code-review/index.ts:68`,
`packages/agents/coder/index.ts:71`.

### The 17 tools, classified

Section A's completeness has to be **checkable by reading**, not taken
on faith, so every tool the shared factory registers is accounted for in
exactly one of three groups:

**General inspection (4)** — answer "what is this codebase and what
state is it in?", and are therefore useful to *any* agent that reasons
about a project rather than to one domain:
`read_project_file`, `analyze_project`, `git_status`, `git_diff`.

**Specialised domain (3)** — read-only, but only meaningful to the
agent acting in that domain, so sharing them is noise rather than
capability: `docker_status` (container runtime state),
`lint_ci_workflow` (GitHub Actions YAML structure),
`audit_dependencies_local` (npm-only declared dependencies).

**Write or execute (10)** — `git_commit`, `docker_build`, `docker_run`,
`create_dockerfile`, `create_github_action`, `create_dockercompose`,
`create_gitignore`, `run_tests`, `write_project_file`, `run_command`.
Sharing any of these grants an agent a **new approval-gated
capability**, which is a materially larger change than widening
read access and is out of scope here (see Non-Goals).

### Three findings this spec is built on

**Finding 1 — `edit-file` has no git access at all.** Coder's
`requiredTools` is `["read_project_file", "write_project_file"]`
(`packages/agents/coder/index.ts:71`) and its harness allow-list is
`["read_project_file"]` (`packages/agents/coder/llm-harness.ts:79`). So
the harness proposes an exact, uniquely-occurring anchored edit with no
way to know whether the file already carries uncommitted work. It can
therefore propose an edit that fights a change the human already made,
and nothing in the flow surfaces that — the approval preview shows a
diff against current content without any indication that the content is
itself mid-edit.

**Finding 2 — `review-diff` sees a diff and nothing else.** Code
Review's allow-list is `["read_project_file"]`
(`packages/agents/code-review/llm-harness.ts:66`) and its
`requiredTools` is `["git_diff", "read_project_file"]`. It can read a
touched file's full content — `specs/082` widened it that far after
Yusuf's own pushback (*"I will need the agent to review all"*) — but it
has no branch/dirty context and no structural view of the project, so a
comment cannot say how a file fits the system it lives in.

**Finding 3 — two DevOps tools are declared but never called.**
`lint_ci_workflow` and `audit_dependencies_local` are in
`REQUIRED_TOOLS` (`packages/agents/devops/mcp-client.ts:34-35`), which
means **DevOps refuses to connect to an MCP server lacking them** —
yet `grep` confirms neither is called anywhere in
`packages/agents/devops/index.ts`. `specs/079` described them as
"connected"; they are reachable but unused. A hard startup dependency
on a capability nothing exercises is the worst of both: it can block
startup and delivers nothing.

### The undocumented rule

**Tools are freely shareable.** This is established precedent, not
theory: `read_project_file` is used by five agents,
`write_project_file` by three, `git_diff` and `run_command` by two
each. `specs/080` states the principle directly, in the course of
correcting its own first draft: skill-ownership rules govern skill
*ids*, not tool *access*.

**Skill ids must have exactly one owner, and violating that fails
silently and system-wide.** If two online agents advertise the same
skill id, `normalizeAgentCapabilities()`
(`packages/shared/agent-capabilities.ts:101-106`) returns
`{ok: false}` for the **entire snapshot**, not just the ambiguous id.
`buildCapabilitySnapshot()` then returns `null`
(`apps/orchestrator/index.ts:546-549`), `classifyRouterProposal()`
returns early, and `detectSkill()` falls through to `"plan-task"` —
**for every request in the system**, including ones about entirely
unrelated skills. The only evidence is a single `console.log` at
`apps/orchestrator/index.ts:547`. The system keeps appearing to work,
in a degraded mode, indefinitely.

Three components currently give three different answers to the same
question, and this spec records that honestly rather than resolving it:

| Component | Behaviour on a duplicated skill id |
|---|---|
| `normalizeAgentCapabilities()` (`agent-capabilities.ts:101-106`) | Refuses — globally, killing the whole snapshot |
| `findAgentForSkill()` (`apps/orchestrator/index.ts:512-519`) | Silently first-match-wins, by registry insertion order |
| `validateSelectedSkillOwnership()` (`packages/shared/task-envelope.ts:259-268`) | Permits — it is a membership check, not an exclusivity one |

Nothing in `CLAUDE.md` or any prior spec states any of this.

## Proposed behavior

### A. One uniform inspection set for every code-reasoning agent

**The rule: every agent that reasons about a codebase gets all four
general-inspection tools** — `read_project_file`, `analyze_project`,
`git_status`, `git_diff`. Not a per-agent negotiation; one line that
can be checked.

**Why a rule rather than case-by-case.** An earlier draft of this very
spec justified each addition individually, following `specs/042`'s
"only where a real need is shown" principle literally — and it **had
already failed once, here**. It gave Coder git tools but not
`analyze_project`, despite Yusuf having named Coder specifically when
he said analysis must not be DevOps-only. Case-by-case justification is
only as good as someone's ability to predict every need in advance, and
the cost of a wrong prediction is silent: the agent simply reasons with
less than it could, and nobody finds out until output quality is
questioned. For tools that can only ever **read**, that trade is
backwards — the downside of granting one that goes unused is a line in
an allow-list, while the downside of withholding one is invisible.

`specs/042`'s principle is not discarded; it is applied at the level of
the **group** rather than each pair. The evidence for the group is the
three findings above plus the general-inspection classification: these
four tools answer "what is this codebase and what state is it in?",
which is a question every one of these agents genuinely has.

#### `requiredTools` — what each agent process may call

| Agent | Already has | Gains |
|---|---|---|
| DevOps | all four | — |
| Testing | `read_project_file` | `analyze_project`, `git_status`, `git_diff` |
| Documentation | `read_project_file` | `analyze_project`, `git_status`, `git_diff` |
| Code Review | `read_project_file`, `git_diff` | `analyze_project`, `git_status` |
| Coder | `read_project_file` | `analyze_project`, `git_status`, `git_diff` |
| Security | — | none — see below |

Eleven additions, every one read-only.

**Security is the one deliberate exclusion.** `specs/011` decision (c)
and `specs/080`'s explicit reaffirmation both stand: Security has no MCP
client at all, stays direct-`fs`, and gains nothing here. It is excluded
by a standing architectural decision, not by this spec's reasoning.

**Testing's earlier decline is superseded, not reversed.** A previous
draft declined `analyze_project` for Testing because `detectRunner()`
(`specs/058`) is deterministic and manifest-driven, so analysis would
change no decision it makes. That reasoning was correct **under the
case-by-case rule** and remains factually true. Testing is included now
because the rule changed, not because the reasoning was wrong — worth
stating plainly so the record does not read as a quiet reversal.

#### Harness bindings — what the *model* may call on its own

`requiredTools` and the harness allow-list are **different decisions**,
and this spec treats them as such. `requiredTools` governs what the
agent *process* may call, including deterministic skill handlers that
never involve a model, and is additionally a hard startup dependency —
an entry the MCP server does not provide makes that agent fail to
connect. `READ_ONLY_TOOL_NAMES` / `buildReadOnlyTools()` governs what
the model may choose to call autonomously.

Bindings to add:

- **DevOps** `+git_diff`. Its harness allow-list is currently
  `["analyze_project", "git_status", "read_project_file"]`
  (`packages/agents/devops/llm-harness.ts:66`) — so despite the agent
  having reached `git_diff` since `specs/079`, its *harness* never
  could.
- **Testing, Documentation, Coder** `+analyze_project`, `+git_status`,
  `+git_diff` — each currently `["read_project_file"]`
  (`testing/llm-harness.ts:60`, `documentation/llm-harness.ts:82`,
  `coder/llm-harness.ts:79`).
- **Code Review** `+analyze_project`, `+git_status` — and
  **deliberately not `git_diff`**. Its harness is already *handed* the
  combined diff as prompt context
  (`packages/agents/code-review/index.ts:94-97`, bounded at
  `:159`), so binding a tool to re-fetch what it already holds would
  invite redundant calls. Stated explicitly here so the asymmetry reads
  as intentional rather than as an omission.

Every binding follows `packages/agents/devops/llm-harness.ts:68-110` as
reference implementation: the project root stays **closure-captured and
never model-suppliable**, no-argument tools take `schema: z.object({})`,
and the existing build-time allow-list loop
(`devops/llm-harness.ts:105-109`) is preserved verbatim so binding a
non-allow-listed tool still throws at graph-build time. `git_diff` is
bound as a single **no-argument** tool returning the combined staged +
unstaged diff, mirroring `computeFullUncommittedDiff()`, so no model
ever has to reason about git staging.

#### The cost, stated honestly

More bound tools means more surface for a harness to explore, and
therefore more opportunity to wander before converging. That cost is
real but bounded: `HARNESS_RECURSION_LIMIT` caps each harness at 20
tool-call rounds and `specs/098` made exhaustion fail cleanly with a
named error rather than leaking LangGraph's internals. If a harness is
observed wandering after this change, the limit makes it visible rather
than silent.

### B. Resolve the two orphaned DevOps tools — differently from each other

The plan for this spec left the resolution open ("wire or remove").
Reading both tools' real implementations resolves them **in opposite
directions**, for evidence-based reasons:

**`lint_ci_workflow` — wire it.** It is a genuine, non-duplicative
check: a dependency-free structural validation (`on:`/`jobs:` present,
no tab indentation) that nothing else in the system performs. It is
wired into `create-ci`'s own post-write path, so a workflow this
project just generated is immediately structurally validated and the
result included in the task result. Read-only, no new skill id, no
approval-gate change.

**`audit_dependencies_local` — remove it from `REQUIRED_TOOLS`.** Its
own justification has been superseded. `specs/079`'s in-code rationale
(`packages/mcp/index.ts:408-412`) reads: *"This only reports what's
actually declared, which today's audit-dependencies skill (Security
Agent) doesn't have real installed-version data to work from at all."*
`specs/085` then gave Security real manifest parsing across **five**
ecosystems (npm, PyPI, Go, Packagist, Maven) plus lockfile widening —
strictly a superset of what this tool does for one. Worse, the tool is
`package.json`-only (`packages/mcp/index.ts:424-427`), so wiring it
into `analyze-project`'s report would reintroduce precisely the
npm-centric noise `specs/099` just removed from that same report.

The tool itself **stays registered on the MCP server** — it costs
nothing there and the external stdio surface is a real consumer path
(`CLAUDE.md`'s "Separate external compatibility surface"). Only
DevOps's hard startup dependency on it is removed, which is the actual
defect.

### C. Write down the rule, and make its trap visible

**Documented in `CLAUDE.md`** (new subsection under "Human approval and
safety" or "Current services and skills"): tools are shareable across
agents with precedent cited; skill ids must have exactly one owner;
the three-way disagreement above stated plainly, with reconciling it
named as follow-up work rather than silently implied to be consistent.

**Namespacing was considered and rejected.** Renaming skill ids to
carry their owner (`devops.analyze-project`) would make collision
structurally impossible, and that is genuinely attractive given this
codebase's repeated preference for structural over conventional
enforcement. It is rejected for two reasons. First, it would leak agent
identity into the router's capability decision: the router is
deliberately shown skill ids **only**, never agent names
(`packages/shared/capability-router.ts:105` dedupes to skill ids
before building the prompt), so that the model selects a *capability*
and the Orchestrator separately resolves *who* provides it. Namespacing
collapses that separation and invites prefix bias. Second, skill ids
are — in `specs/054`'s own words — "the entire compatibility surface";
renaming them touches all six Agent Cards, both hardcoded supervisor
tables, every agent's text detector, `selectedSkill` on every dispatch,
the router prompt, `chat-progress-phrases.ts`, the demo script's
assertions, and the runbook.

The real defect is not that collisions are *possible* but that they are
**silent and catastrophic**. Two cheap guards address that directly:

1. **A test over the real Agent Cards** that fails if any skill id is
   declared by two agents. This catches the realistic case — a
   developer introducing a colliding id — in CI, before it can ever
   run. It is the only one of the two that *prevents* rather than
   reports.
2. **A visible runtime signal.** The refusal behaviour itself is
   correct and stays exactly as it is; only its visibility changes. The
   Orchestrator's `/healthz` (`apps/orchestrator/index.ts:1077-1082`,
   currently `{status, agents, tasks, projectPath}`) gains a
   `capabilities: {ok, error?}` field, mirroring how every agent
   already reports `dependencies: {mcp: …}`. A collapsed snapshot
   becomes observable instead of being inferable only from a log line.

## Safety constraints

- **Every tool added is read-only (Tier 2).** No agent gains a write,
  execute, docker, or git-commit capability from this spec.
- **The approval gate is untouched.** No `actionId` flow, no
  `resumeTask()`, no pending-action shape changes anywhere.
- **Code Review's zero-write property is preserved.** It gains only
  read-only tools; it still has no `resumeTask()`, no pending-actions
  map, and no approve/reject routes — the structural property
  `specs/082` established.
- **No new skill id is created**, so no agent's ownership changes and
  the capability snapshot is unaffected by section A.
- **The harness allow-list enforcement is preserved verbatim.** Each
  touched `buildReadOnlyTools()` keeps its build-time throw, and each
  new binding keeps the project root closure-captured so the model can
  never redirect a read outside the resolved target.
- **Removing `audit_dependencies_local` from `REQUIRED_TOOLS` removes a
  startup dependency, not a capability** — the tool remains registered
  and callable on the MCP server.

## Acceptance criteria

- [x] Every one of DevOps, Testing, Documentation, Code Review and Coder
      has all four inspection tools (`read_project_file`,
      `analyze_project`, `git_status`, `git_diff`) in its
      `requiredTools`. Live-confirmed: every agent's real `/healthz`
      lists all four (and every other server-side tool) in
      `discoveredTools`.
- [x] Harness allow-lists match the uniform set: DevOps, Testing,
      Documentation and Coder can each bind all four; Code Review binds
      three, with `git_diff` **deliberately** excluded because its
      harness already receives the diff as context. Unit-tested per
      agent, including a dedicated test proving `git_diff` is absent
      from Code Review's own bound set.
- [x] The underlying `git_diff` MCP tool correctly captures real
      uncommitted work — live-confirmed via a real scratch git repo
      with a genuinely uncommitted change. **Not live-verified**: a
      real harness dispatch observing it through a live model call —
      no provider credentials were available in this session (the same
      standing gap most prior LLM-harness checkpoints in this codebase
      record); the binding itself is unit-tested against a scripted
      model instead.
- [x] Security's tool access is unchanged (still zero, direct-`fs`), and
      the spec records that this follows `specs/011` (c), not this
      spec's own reasoning.
- [x] The three specialised tools (`docker_status`, `lint_ci_workflow`,
      `audit_dependencies_local`) are reachable by DevOps only.
- [x] No write or execute tool is shared with any additional agent.
- [x] `lint_ci_workflow` is called from `create-ci`'s post-write path
      and its result appears in the task result. Live-confirmed: a
      real `create-ci` dispatch against a scratch project, approved,
      produced a task result ending in
      `"=== CI Workflow Lint ===\nNo structural issues found — has
      'on:' and 'jobs:' keys, no tabs."`
- [x] `audit_dependencies_local` is no longer in DevOps's
      `REQUIRED_TOOLS`, and remains registered on the MCP server —
      confirmed both by reading `mcp-client.ts` and live, in the same
      `/healthz` `discoveredTools` list above (present on the server,
      absent from DevOps's own required set).
- [x] Every touched `buildReadOnlyTools()` still throws at graph-build
      time when handed a non-allow-listed tool — the existing check is
      preserved verbatim in every file; no test needed changing to
      keep asserting it.
- [x] A test fails when two Agent Cards declare the same skill id, and
      passes against the six real cards.
- [x] The Orchestrator's `/healthz` reports `capabilities.ok: false`
      with the offending skill id named when the snapshot is collapsed.
- [x] `CLAUDE.md` documents the tool-vs-skill rule, the three-way
      disagreement, and why namespacing was rejected.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass, with
      every pre-existing test passing unmodified (1177 pass, 0 fail,
      net +13 over the pre-101 baseline of 1164).

## Non-goals

- **Orchestrator inspection capability — deferred to its own spec.**
  Designed with Yusuf in this same session and split out at his
  direction, since it is the only part that gives a component something
  it has never had. The agreed shape, recorded here so it is not lost:
  a read-only MCP client on the Orchestrator bound to
  `analyze_project`/`read_project_file`/`git_status`; **not** an
  advertised skill (so no skill id gains a second owner and the router
  is untouched); structurally read-only with the same build-time
  allow-list throw; **strictly optional**, so the Orchestrator never
  degrades if MCP is unreachable and still learns about projects by
  dispatching exactly as today; and raw context injection into the
  supervisor's existing planning prompt and `/ask`'s existing answer
  path rather than a second harness. Motivated by two real costs: with
  `--only orchestrator` (`apps/supervisor/index.ts:225`) the
  Orchestrator can learn nothing about a project at all, and even with
  every agent healthy the supervisor picks its **first** skill blind on
  every run.
- **Sharing any write or execute tool.** All 10 stay with their current
  owners. The most interesting candidate was named and deliberately
  deferred: giving **Coder `run_command` or `run_tests`** so it could
  verify its own proposed edit compiles or passes. That is attractive,
  but it is a **new risk class** for an agent that today can only
  propose content — and `specs/078`'s ordering principle is explicit
  that a phase adding a new risk class gets its own spec rather than
  riding along with a lower-risk one. `specs/081`'s structural
  separation of "write the test file" from "run it" (two skills, two
  approvals, no code path between them) is the precedent that would
  govern such a spec. `git_commit` is excluded for a related reason:
  `specs/079` deliberately holds it to a *higher* approval bar than any
  other write, previewing the combined staged + unstaged diff.
- **Sharing the three specialised read-only tools.** `docker_status`,
  `lint_ci_workflow` and `audit_dependencies_local` stay with DevOps.
  `lint_ci_workflow` for Code Review was considered directly — a
  workflow file in a diff is a real case — and declined: that harness
  already holds the full diff and can read the file, so a structural
  check (`on:`/`jobs:`/tabs) is assessable from content it already has,
  and a binding would buy certainty on a narrow case at the cost of
  another tool in the prompt.
- **Reconciling the three-way ownership disagreement.** Documented
  here, fixed later.
- **Renaming or namespacing skill ids.** Considered and rejected above.
- **Deepening `analyze-project` itself.** The LLM-first whole-codebase
  analysis design (languages, architecture, design patterns, quality
  signals) was worked through with Yusuf this session and is
  deliberately out of scope; it needs its own spec.
- **Extracting a shared harness core.** All six harnesses are near-
  identical copies; that is a real finding but a separate refactor.
- **Any change to any agent's *skill* set.** Every agent advertises
  exactly the skills it does today. This spec changes only which tools
  those skills may reach — no skill id is added, removed, or
  re-owned, so the capability snapshot and the router are untouched.

## Verification plan

- Unit: each agent's `requiredTools` asserted against what this spec
  claims; each touched harness's allow-list throw re-asserted; the new
  duplicate-skill-id test proven in both directions (fails on a
  synthetic collision, passes on the six real cards).
- `bun run typecheck`, `bun run specs:catalog`, `bun run specs:check`.
- Live: start the full stack and confirm **every agent** reports
  `mcp.state: "connected"` on its `/healthz`. This is the real
  regression check for section A specifically — a `requiredTools` entry
  the MCP server does not actually provide makes that agent fail to
  connect, which is exactly the failure mode `specs/082`'s own compose
  pass found the hard way.
- Live: a real `edit-file` dispatch against a scratch repo with
  deliberately uncommitted changes in the target file, confirming the
  harness can observe them.
- Live: a real `review-diff` dispatch, confirming the widened tool set
  does not break the existing flow.
- Live: a real `create-ci` dispatch, confirming the workflow is written
  and then structurally linted in the same task result.
- Live: a deliberately collided pair of Agent Cards makes `/healthz`
  report `capabilities.ok: false` naming the offending id, instead of
  the system degrading with no visible signal.
