---
id: 078-capability-upgrade-roadmap
title: System-Wide Capability Upgrade Roadmap
area: architecture
change_type: governance
status: approved
verification: pending
created: 2026-09-12
updated: 2026-09-12
approved_by: Yusuf
approved_on: 2026-09-12
implemented_on: null
amends: []
related:
  - 005-mcp-agent-integration
  - 011-remaining-agents-mcp
  - 058-testing-agent-multi-ecosystem-runner-detection
  - 075-real-conversational-chat
  - 077-agent-enabled-means-llm-on-by-default
supersedes: []
superseded_by: []
---

# Spec: System-Wide Capability Upgrade Roadmap

> Review gate: **DRAFT — NOT APPROVED.** This spec decides *ordering and
> principles*, not implementation. Each phase becomes its own numbered
> spec requiring its own approval before any code is written.
>
> Yusuf, 2026-09-12: *"first need to plan the upgrade capability plan
> first for all the system"*, then a round of decisions on the first
> draft (recorded under Decisions Taken below) that materially reshaped
> it — most importantly approving a general, per-call-approved execution
> primitive, and moving model-authored **tests** ahead of a general
> Coder Agent.

## Purpose

Capability has been added one agent at a time (`specs/005`, `011`,
`041`–`043`, `058`), each grounded in its own evidence — which worked,
but means nobody has ever looked at the whole surface at once and asked
what's missing, what's built-but-unreachable, and what order the next
additions should land in. This spec does that, and fixes the ordering
principle so later phases inherit proven ground instead of guessing.

It contains **no implementation**. Its output is a sequence of future
specs and the reasons for that sequence.

## Verified Current State

Full inventory read 2026-09-12 (every entry confirmed in source).

### The 13 MCP tools in the shared factory (`packages/mcp/index.ts`)

`analyze_project`, `git_status`, `git_diff`, `git_commit`,
`docker_status`, `docker_build`, `create_dockerfile`,
`create_github_action`, `create_dockercompose`, `create_gitignore`,
`read_project_file`, `write_project_file`, `run_tests`.

### Which agent can actually reach which tool

| Agent | Advertised skills | MCP tools it has |
|---|---|---|
| Orchestrator | `plan-task`, `suggest-agents`, `/ask` | none — dispatches only |
| DevOps | `dockerize`, `create-compose`, `create-ci`, `create-gitignore`, `analyze-project`, `git-status` | 7: `analyze_project`, `git_status`, the 4 `create_*`, `read_project_file` |
| Testing | `run-tests`, `check-coverage` | 1: `run_tests` |
| Documentation | `generate-readme`, `document-api` | 2: `read_project_file`, `write_project_file` |
| Security | `scan-secrets`, `check-gitignore-coverage`, `audit-dependencies` | 0 — direct `fs` by decision (`specs/011` (c)) |

### The seven structural findings this roadmap is built on

1. **4 of 13 tools are reachable by no agent at all** —
   `docker_build`, `docker_status`, `git_diff`, `git_commit`. Fully
   implemented, allowlisted, `shell:false`, timeout-bounded, and unused
   by the A2A runtime since they were written; only the external stdio
   surface (Claude Desktop/Code as an MCP client) can call them. The
   cheapest real capability in the system.
2. **No agent can verify its own output.** DevOps writes a Dockerfile
   nobody builds; `create-ci` emits a workflow nobody lints;
   Documentation writes docs nobody validates. Every write skill stops
   at "file written," never "proven to work."
3. **Nothing can act on a diff.** `git_diff` being unreachable means no
   agent can answer "what changed?", generate a changelog, or review a
   change — and a diff is the natural input for code review.
4. **Every executable command is a fixed, hardcoded prefix.**
   `safeExec()`'s `ALLOWED_PREFIXES` is a 17-entry allowlist; every
   skill's command is hand-written argv. This is why Testing can only
   ever support ecosystems someone has explicitly added, and why no
   agent can act on an unanticipated stack or request at all.
5. **Testing is the only agent with no LLM harness**, and has a hard
   ceiling: `specs/058` shipped 7 deterministic ecosystems and
   explicitly deferred Go, Rust, Maven/Gradle and .NET; it also shipped
   detection for 5 runners without coverage-percent parsing for any of
   them (its own stated gap).
6. **An agent can reach exactly one MCP server.**
   `OrchestraiMcpClient` holds a single `private readonly url: URL`, and
   *all* of an agent's `requiredTools` must exist on that one server or
   the connection fails. This — not the loopback rule — is what blocks
   using the existing third-party MCP ecosystem.
7. **Non-loopback and non-`http:` MCP URLs are structurally rejected**
   (`validateMcpUrl()`), deliberately. Confirmed this does **not** block
   locally-run third-party MCP servers (they bind loopback); it only
   blocks *hosted* remote ones, which operate on their own service's
   data and cannot touch a local repository anyway.

### Known gaps already named in CLAUDE.md

"No Coder/Software Development Agent or Code Review Agent exists" —
carried forward as phases below rather than restated as discoveries.

## Decisions Taken (2026-09-12, Yusuf)

Recorded here because they reshaped the phase order, and later phases
depend on them:

1. **More tools of our own — approved.** Concretely: verify a built
   image actually *boots*, lint the CI workflow we emit, dependency
   install/audit.
2. **A general `run_command` primitive — approved, *with* a
   per-invocation human approval gate.** Yusuf: *"thats a great thing
   but with the gate."* This is the single largest capability unlock in
   the roadmap and its own new risk class (see Ordering Principle).
3. **Third-party MCP servers — scoped to locally-run ones only.** Yusuf
   asked whether another MCP would even help apply things to a local
   repo; investigating that produced finding 7. Multi-endpoint support
   (finding 6) is therefore in scope; relaxing the loopback/`http:`
   rule is **not** — hosted remote servers are deferred with no loss of
   local capability.
4. **External/internet A2A agents — deferred as an explicit open
   decision**, not rejected.
5. **"Can the LLM decide the stack and what to run?" — yes, and it is
   the same item as decision 2.** Yusuf: *"we can say it's same phase a
   2."* Confirmed: a model constrained to a fixed argv table can never
   produce `go test` if `go test` isn't in the table; the general
   approved-execution primitive is what actually delivers any-stack
   capability. This supersedes the 2026-09-12 earlier conclusion that
   LLM-chosen commands were categorically out of scope.
6. **Model-authored tests — approved, and promoted ahead of a general
   Coder Agent.** A test file is the safest possible target for
   model-written code (a bad test fails loudly and harmlessly; bad
   source fails quietly), it has a built-in verification loop (write,
   then actually run them), and it reuses `specs/040`/`041`'s existing
   approval-with-content-diff precedent exactly.
7. **`git_commit` — connect it, not orphaned.** Reversing the first
   draft's own recommendation to leave it deliberately unreachable.
   Folded into Phase A as `commit-changes`: Tier 1, approval-gated, and
   — because a commit is the one write in this system that alters
   history rather than producing an inspectable file — the approval
   preview must show the real, already-staged diff and the exact commit
   message before it runs, never a summary. `git add`/`git commit` are
   already on `safeExec()`'s allowlist; no new execution surface, only a
   new skill wrapping an existing one.

## Ordering Principle

Phases are ordered by **risk-adjusted value**, and every phase must
inherit proven ground from the one before it. This is not new: `041`→
`042`→`043` deliberately went lowest-stakes-first, and `028` waited for
`026` to reach `verification: verified` before betting the
approval-gate-owning component on the same pattern. Made explicit:

> **A phase that adds a new *risk class* does not begin until the phase
> proving the mechanism it depends on is `verification: verified`.**

Risk classes in ascending order:

1. **Read-only, existing tool** — no new surface.
2. **Executing a fixed, pre-vetted command** — real side effects, but
   the command is hand-written and allowlisted.
3. **Writing model-authored content into a file** — already precedented
   (`041`), already approval-gated with a content diff (`040`).
4. **Executing a model-chosen command under per-call human approval** —
   new: the human, not an allowlist, becomes the boundary.
5. **Writing model-authored *source code*** — new: changes program
   behavior, reviewable only as a diff.
6. **Reaching an external network service per-task** — new: introduces
   offline/rate-limit/trust semantics the runtime has never had.

## Phases

Per-phase scope and exit gates in `plan.md`. Summary:

- **Track 0 (parallel, drafted, not capability work)** — `075` (chat
  actually answers), `076` (`run-tests` timeout mismatch), `077` (agent
  enabled ⇒ LLM on). Neither blocks nor is blocked by the phases below.
- **Phase A — connect and extend what exists** (classes 1–2). Wire the
  orphaned `docker_build`/`docker_status`/`git_diff`/`git_commit` into
  real skills (decision 7 folds `git_commit` in here, not deferred); add
  the approved new fixed tools (verify-boot, CI lint, dependency audit);
  add multi-endpoint MCP support so locally-run third-party servers
  become usable, loopback rule untouched.
- **Phase B — the general approved-execution primitive** (class 4).
  `run_command`: the model proposes a real command for any stack, every
  single invocation goes through the existing `actionId`-bound approval
  gate, argv-array only, `shell:false`, bounded. Unlocks any-stack
  testing and open-ended capability in one change. Gated on Phase A,
  which proves the execute-then-approve path on fixed commands first.
- **Phase C — Testing writes tests** (class 3, plus class 4 for unknown
  stacks once B lands). Generates test files under the existing
  approval-with-diff flow, then actually runs them and reports real
  results — the generate→verify loop closing inside one agent. Also
  fixes finding 5 (Testing gains its first harness).
- **Phase D — Code Review Agent** (class 1 + LLM, read-only). The first
  genuinely new agent, chosen because it **writes nothing** and so needs
  no approval gate at all — the cheapest way to prove new-agent
  integration end to end. Consumes Phase A's `git-diff`.
- **Phase E — Coder Agent** (class 5). Write-capable source edits.
  Gated on C *and* D verified — both are strictly smaller versions of
  the same risk (model-authored files; reviewing a diff).
- **Phase F — Security depth / external data** (class 6). Requires a
  standing policy decision on per-task network access first; that
  absence is precisely why `specs/043` structurally forbids CVE claims.
- **Phase B′ (deterministic, any time after A)** — Testing's Go/Rust/
  Maven/.NET profiles and the 5 missing coverage parsers. Complementary
  to Phase B, not replaced by it: a lockfile-derived answer stays
  instant, free and certain, so known ecosystems should keep using it
  and `run_command` covers what the table can't.

## Safety and Compatibility Constraints

- **The approval gate is never weakened by any phase.** Every new
  write-capable or executing skill goes through the existing
  `actionId`-bound flow; a skill absent from `SKILL_TIER_REGISTRY`
  already defaults to write-capable/approval-required, fail-closed, and
  no phase changes that default.
- **Phase B replaces an allowlist with a human, and never with
  nothing.** `run_command` is only acceptable because *every* call is
  approved; it must never gain an auto-approve path, a "trusted
  commands" bypass, or a batch-approve-all. Argv array, `shell:false`,
  bounded timeout and output, fully audit-logged — all unchanged
  boundaries from today's fixed-command execution.
- **`safeExec()`'s whitespace re-splitting is fixed before anything
  user-controllable reaches it** (Phase A) — it currently re-splits its
  own command string, so a path containing a space becomes the wrong
  argv. Safe today (no shell ⇒ no injection) but wrong, and Phase B
  would make it user-facing.
- **No new MCP server of our own.** Tools are added to the existing
  shared factory; the stdio and HTTP entrypoints stay as they are.
  Third-party servers are *additional endpoints*, not a replacement.
- **The loopback/`http:`-only MCP rule is untouched** by this roadmap.
- **Each phase is independently shippable and revertible.**

## Out of Scope / Non-Goals

- **Hosted/remote MCP servers** (non-loopback, `https:`) — deferred per
  decision 3, with no loss of local capability.
- **External/internet A2A agents** — deferred per decision 4.
- Implementation of anything here. Each phase is its own spec.
- Replacing deterministic capability where the deterministic answer is
  already ground truth (lockfile-based runner detection stays; see
  Phase B′).
- Any change to the Orchestrator's routing, the approval gate itself, or
  the AG-UI event schema.

## Acceptance Criteria

This spec is satisfied when the roadmap is agreed, not when code ships:

- [x] The inventory and seven findings are confirmed accurate.
- [x] The phase ordering and the six risk classes are approved.
- [x] `git_commit` is connected (Phase A, `commit-changes`), not left
      orphaned — Yusuf's own correction, 2026-09-12.
- [x] `bun run specs:check` passes and `plan.md` reflects the agreed
      phases.

## Verification Plan

No runtime change, so no runtime verification. Its verification is that
each phase, when specced, matches the ordering rule here, and that
`plan.md`'s live-results log records each phase's real exit gate as it
closes — the same mechanism `specs/069`'s own `plan.md` already uses.

## Approval Requested

Approve the roadmap and its ordering, or name the phase you want first
regardless of order — the risk-class rule exists to make that tradeoff
explicit, not to prevent you from overriding it deliberately.
