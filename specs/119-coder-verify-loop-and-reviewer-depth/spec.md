---
id: 119-coder-verify-loop-and-reviewer-depth
title: "Coder and Code Review as Iterating Agents: a Verify-and-Fix Loop, and Review With Real Project Depth"
area: coder-agent
change_type: feature
status: implemented
verification: verified
created: 2026-09-23
updated: 2026-09-25
approved_by: Yusuf
approved_on: 2026-09-23
implemented_on: 2026-09-24
amends:
  - 083-coder-agent
  - 082-code-review-agent
  - 101-per-agent-tool-access-expansion
  - 114-coder-multi-file-edit-and-create
  - 080-run-command-approved-execution
supersedes: []
superseded_by: []
related:
  - 078-capability-upgrade-roadmap
  - 104-deferred-work-register
  - 105-orchestrator-fallback-deep-analysis
  - 110-approval-state-survives-a-restart
---

# Spec: Coder and Code Review as Iterating Agents: a Verify-and-Fix Loop, and Review With Real Project Depth

> Review gate: **APPROVED 2026-09-23 by Yusuf.** Not yet implemented.

## Purpose

Raised directly: *"now i will need to upgrade the capabilty of the coder and
revewer agant to be real agants like what here in cluade open code so on."*

The gap this names is real and specific. Both agents today are **one-shot
proposers**. Coder reads, proposes one patch, a human approves, it is written —
and the task ends. Nothing ever checks that the result compiles, passes, or
even parses. Code Review reads a diff, emits comments, and stops; it cannot see
the project around the diff the way `specs/103`'s deep analysis can, and its
findings reach no one but a human reader.

What makes a tool like Claude Code or OpenCode feel like an *agent* rather than
a patch generator is the loop: act, observe the real result, correct, repeat.
This checkpoint gives both agents that loop — Coder gets to run a verification
command and fix what it broke; Code Review gets real project depth and a
structured finding output another agent can consume.

**Every write keeps its own `actionId`-bound human approval, without
exception.** Command execution is approved per distinct argv per task — one
narrow, deliberate amendment to `specs/080`, resolved with Yusuf and documented
in full under "Resolved Decision" below. This spec adds iteration, not
autonomy.

## Verified Current State

Read from the code on 2026-09-23, not assumed:

**Coder Agent (`packages/agents/coder/`, port 3008)**

- Declares five MCP tools (`index.ts:102`): `read_project_file`,
  `write_project_file`, `analyze_project`, `git_status`, `git_diff`. **No
  execution tool of any kind** — no `run_command`, no `run_tests`.
- The harness binds only the four read-only ones
  (`llm-harness.ts:85`, `READ_ONLY_TOOL_NAMES`), enforced structurally at
  graph-build time. `write_project_file` is never bound to the model; writes
  happen only from `resumeTask()` (`index.ts:530`) after approval.
- Two skills, both Tier 1: `edit-file` (one anchored single-hunk edit) and
  `edit-files` (≤ `MAX_FILES_PER_EDIT = 6`, edit-or-create).
- `HARNESS_RECURSION_LIMIT = 20` per harness run; `pendingActions` is a
  `Map<taskId, PendingAction>` — **exactly one pending action per task**.
- A task's lifecycle is strictly linear: `working` → `input-required` →
  (approve) → `completed`/`failed`. Nothing in this codebase has ever produced
  a task that returns to `input-required` *after* an approval was consumed.

**Code Review Agent (`packages/agents/code-review/`, port 3007)**

- Declares four read-only MCP tools (`index.ts:85`): `git_diff`,
  `read_project_file`, `analyze_project`, `git_status`.
- **Its harness binds only three** (`llm-harness.ts:74`) — `git_diff` is
  declared but never bound, because the combined diff is passed in as prompt
  context instead.
- `index.ts:224` states the safety story plainly: *"Read-only, no
  NEEDS_APPROVAL, no resumeTask — this agent never writes."* There is no
  approval machinery in the file at all.
- Output is `ReviewDiffResultSchema` — `{comments: [{file, line, severity:
  "blocking"|"suggestion"|"nit", comment}], summary?}` — already structured
  and already severity-tagged, rendered to text and returned. Nothing consumes
  it programmatically.
- Every comment is grounded against the diff post-image
  (`diff-grounding.ts`); ungrounded comments are dropped, and the task fails
  closed only when zero survive.

**The precedent for approved execution already exists.** Testing Agent declares
`run_command` (`packages/agents/testing/index.ts:108`) and reaches it through
the ordinary `actionId`-bound approval flow (`specs/080`). Sharing an MCP tool
across agents is established — `read_project_file` is used by five.
`specs/101` is explicit that skill-ownership rules govern skill *ids*, never
tool *access*.

**This work is already on the register.** `specs/104` item **A5** ("Coder
cannot verify its own edit") is recorded at **risk: high** and explicitly
marked as needing its own spec under `specs/078`'s ordering rule. Item **A11**'s
remainder — deep analysis reachable only from DevOps, with Code Review named
directly in Yusuf's original ask — is recorded at **low risk** since
`specs/105` moved the implementation into the shared
`packages/shared/project-analysis.ts` precisely so another caller is "one
import line plus a judgement call."

## Proposed Behavior

### Part A — Code Review gains real depth (no new risk class)

1. **Deep project analysis, on demand.** `review-diff` may ground its review in
   `packages/shared/project-analysis.ts`'s real analysis — the same one
   DevOps's `analyze-project` and the Orchestrator already share (`specs/105`),
   imported, never re-implemented. This closes `specs/104` A11's named
   remainder for this agent. It is **fail-open**, matching that module's own
   established behavior: analysis unavailable appends an explicit note and the
   review still completes on the diff alone.
2. **`git_diff` gets bound to the harness.** Already declared, never bound —
   so the model can pull a file's fuller change history when a hunk's intent
   is unclear, instead of reasoning from the one passed-in diff.
3. **Findings become a consumable artifact.** The existing
   `ReviewDiffResultSchema` is already structured and severity-tagged; the
   review's result gains a machine-readable findings block alongside the human
   text, so Part B can feed it to Coder without re-parsing prose.

Code Review **stays read-only, permanently**. No `NEEDS_APPROVAL`, no
`resumeTask()`, no pending actions, no write or execute tool — the absence of
that machinery *is* its safety story, exactly as `index.ts:224` says, and this
spec does not weaken it.

### Part B — Coder gains a bounded verify-and-fix loop (the new risk class)

A new skill, **`edit-and-verify`** (Tier 1), alongside the untouched
`edit-file` and `edit-files`:

1. Propose an edit (reusing `runEditFilesHarness()` verbatim — no new proposal
   path).
2. **Approval #1** — the human approves the edit. It is written.
3. Propose a **verification command** — an argv array, from the same
   deterministic-explicit-or-harness-proposed shape `specs/080` already
   established for `run-command`.
4. **Approval #2** — the human approves the command. It runs via the shared
   `run_command`/`run_tests` MCP tool. On later iterations this prompt is
   skipped **only** when the argv is byte-identical to one already approved in
   this same task (B1, below); any difference at all is a fresh approval.
5. On success → the task completes, reporting both the edit and the real
   command output.
6. On failure → the real stdout/stderr is fed back to the harness, which
   proposes a **follow-up fix**, and the loop returns to step 2 with a fresh
   `actionId`.
7. Bounded by `MAX_VERIFY_ITERATIONS` (**3**, see below) and by each iteration's
   own existing harness recursion limit. Exhausting the bound completes the
   task with an honest report of what was tried and what still fails — never a
   silent stop, never an unbounded loop.

Coder's `requiredTools` gains `run_command` and `run_tests` — shared with
Testing and DevOps, not new tools. They are bound **only** to the approval-gated
execution path, **never** to the proposal harness, whose
`READ_ONLY_TOOL_NAMES` allow-list stays byte-unchanged and structurally
enforced.

### The load-bearing technical unknown, named up front

**A task that re-enters `input-required` after consuming an approval is a shape
this system has never produced.** Every existing write-capable task is linear:
one pending action, one approval, one terminal transition. A verify loop needs
a task to become `input-required` two or more times.

This spec's single biggest implementation risk is therefore not the model
behavior — it is whether four existing mechanisms tolerate that shape:

- `pendingActions: Map<taskId, PendingAction>` — one entry per task; a loop
  must set a new entry after the previous was consumed.
- The Orchestrator's one-shot `emittedTerminal` guard
  (`apps/orchestrator/index.ts:630`, consumed by `emitTaskState()`) — it gates
  AG-UI's `RUN_FINISHED`/`RUN_ERROR` per task id and must not fire early or
  twice across repeated `input-required` transitions. (`specs/107`'s agent-side
  `startTaskPersistenceSweep()` is *not* a hazard here — it acts only on
  `completed`/`failed`, which a mid-loop task never is — but confirm that,
  don't assume it.)
- `waitForChildTask()` on the Orchestrator — polls through `input-required`, so
  it should tolerate several, but this is unproven.
- `specs/110`'s `claimPendingAction()` single-consumption boundary and restart
  restore — a restored mid-loop action must be coherent.

Phase 0 of `plan.md` exists to answer this **before** any feature code is
written. If the answer is that the shape is unsafe, the fallback is stated
there: each iteration becomes a separate task, sequenced by the caller, at real
cost to the "feels like one agent" goal.

## Scope

- `packages/agents/coder/` — new `edit-and-verify` skill, the loop driver, the
  verification-command proposal, `run_command`/`run_tests` in `requiredTools`.
- `packages/agents/code-review/` — shared deep analysis, `git_diff` bound to
  the harness, structured findings in the result.
- `apps/orchestrator/supervisor-graph.ts` — `SKILL_TIER_REGISTRY`
  (`edit-and-verify: "write-capable"`) and `SUPERVISOR_ALLOWED_SKILLS`.
- `apps/supervisor/agent-catalog.ts` — `AGENT_CATALOG` row for the new skill.
- Agent Card skills for Coder; `packages/shared/approval.ts` only if the loop
  genuinely needs a new preview field (avoid if it does not).
- Tests for both agents; `CLAUDE.md` and `context/worklog.md`.

## Safety and Compatibility Constraints

- **Every write requires its own `actionId`-bound human approval, always, with
  no exception anywhere in this spec.** A loop is exactly where that would be
  tempting to relax, and it is not relaxed.
- **Command execution is approved per distinct argv, per task** — the narrow,
  deliberate amendment to `specs/080` resolved below. A re-run is permitted
  only when it is byte-identical to an argv a human already approved **in this
  same task**; any difference, however small, is a fresh approval. No
  cross-task memory, no cross-session memory, no allow-list, no
  "trusted command" concept that outlives the task that created it.
- **The proposal harness never gains a write or execute tool.**
  `READ_ONLY_TOOL_NAMES` in `packages/agents/coder/llm-harness.ts` is unchanged
  and its build-time enforcement stays.
- **`edit-file` and `edit-files` are byte-unchanged.** Their existing tests
  must pass unmodified — the regression proof.
- **Code Review gains no write or execute capability**, and no approval
  machinery. Read-only permanently.
- Every write keeps `specs/056`/`114`'s content-fingerprint drift recheck
  immediately before executing, including on every loop iteration — a loop
  widens the window between preview and write, so this matters *more* here,
  not less.
- The loop is bounded by an explicit constant, never by model judgment.
- `run_command`'s existing denylist and cwd-containment stay defense-in-depth,
  not the safety mechanism; the approval gate remains the real boundary.
- A rejected step ends the loop cleanly, no further iterations.

## Out of Scope / Non-Goals

- **Any weakening of write approval.** Every write is individually approved,
  full stop.
- Any command-approval reuse wider than the resolved B1 scope below — no
  cross-task reuse, no cross-session reuse, no persisted allow-list, no
  fuzzy/"equivalent" argv matching.
- Code Review acting on its own findings, or gaining any write/execute path.
- Coder creating or deleting directories, moving/renaming files, or running
  network-reaching commands.
- Editing OrchestrAI's own source tree (`specs/083`'s standing v1 boundary).
- Multi-turn conversational memory across separate tasks.
- Lifting `MAX_FILES_PER_EDIT = 6`.
- Automatic Coder→Reviewer→Coder chaining with no human in the loop.
- Changing `run_command`'s denylist or the `execFile`/`shell:false` boundary.

## Resolved Decision — command approval is per distinct argv, per task (B1)

**Decided by Yusuf, 2026-09-23, from four presented options.** The verification
command is approved **once per distinct argv within one task**; subsequent
iterations re-run that byte-identical argv with no re-prompt. A 3-iteration
loop therefore asks for 4 approvals rather than 6, and **every one of the
saved prompts is a command re-run, never a write.**

```
iter 1   edit       -> APPROVE
         bun test   -> APPROVE          (fails)
iter 2   fix        -> APPROVE
         bun test   -> re-run, no prompt (fails)
iter 3   fix        -> APPROVE
         bun test   -> re-run, no prompt (passes)
```

**This is a real amendment to `specs/080`, stated plainly rather than framed as
a detail.** That spec recorded Yusuf's own condition as *"every single
invocation is approved individually — no auto-approve, no 'trusted command'
memory, no batch-approve, ever."* This checkpoint narrows that "ever" and
therefore lists `080` in its `amends`. Exactly what changes, and nothing more:

| | Before (`specs/080`) | After (this spec) |
|---|---|---|
| A write | individually approved | individually approved — **unchanged** |
| First run of an argv | approved | approved — **unchanged** |
| Re-run, identical argv, same task | approved again | **re-runs without prompting** |
| Re-run, any argv difference | approved again | approved again — **unchanged** |
| Any reuse across tasks/sessions | never | never — **unchanged** |

Why this specific scope is defensible, and the strongest argument against it:

- The re-executed argv is **byte-identical** to one a human read and approved
  minutes earlier in the same task. Nothing new is being authorized; the same
  authorized action repeats.
- Reuse is bounded twice over — by `MAX_VERIFY_ITERATIONS` and by the task's
  own lifetime. It cannot outlive either, and nothing is persisted.
- The comparison is exact-match on the argv array, never normalized, lowercased,
  or "equivalent" — a fuzzy match is how this kind of mechanism usually fails.
- **The honest counter-argument:** a command that is safe on iteration 1 is not
  logically guaranteed safe on iteration 3, because the *files it runs against
  have changed in between* — by edits this same loop made. `bun test` is
  harmless under that reasoning; a command with side effects beyond the
  workspace is less obviously so. The mitigation is that `run_command`'s
  existing denylist and cwd-containment still apply on every execution, and the
  iteration bound caps exposure — but this is a genuine narrowing of the
  guarantee, not a free win, and it is recorded as such.

Options B2 (memory expires after one silent re-run) and B3 (approve a whole
verification plan upfront, before any edit) were presented and not chosen; B3
in particular remains available as a later checkpoint if B1 proves too chatty
in real use.

## Iteration bound

`MAX_VERIFY_ITERATIONS = 3`. Yusuf declined to pick a value ("don't know the
best here"), so this keeps the spec's original proposal rather than inventing a
different one: enough for a fix-then-confirm cycle, short enough that a
confused model burns little provider budget before reporting honestly. It is a
single named constant, so changing it later is a one-line decision informed by
real use rather than a guess made now.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] Phase 0's finding on repeated `input-required` is recorded in
      `verification.md` before feature code is written.
- [x] `edit-file`/`edit-files` behavior is unchanged; their existing tests pass
      unmodified.
- [x] `edit-and-verify` completes a real edit → approval → write → command
      approval → real execution, end to end, against a real project.
- [x] A deliberately broken edit is caught by the real verification command,
      and the follow-up fix iteration produces a genuinely passing result.
- [x] The iteration bound terminates a non-converging loop with an honest
      report; no unbounded loop is reachable.
- [x] A rejection at any step ends the loop with nothing further written.
- [x] The drift recheck refuses a stale approval on a *later* loop iteration,
      not just the first.
- [x] **B1 holds exactly:** an identical argv re-runs on iteration 2+ with no
      prompt; a single-character change to the argv forces a fresh approval; no
      approval is ever reused across two different tasks or after a restart.
- [x] **No write is ever executed without its own approval**, on any iteration
      — asserted directly, since B1 is the one place this could regress.
- [x] Coder's proposal harness still binds zero write/execute tools —
      asserted structurally, not by inspection.
- [x] `review-diff` produces a review genuinely informed by deep project
      analysis, and degrades cleanly when it is unavailable.
- [x] Code Review still has no `NEEDS_APPROVAL`/`resumeTask`/pending actions —
      provable by grep.
- [x] `bun test`, `bun run typecheck`, and `bun run specs:check` pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

Hermetic (scripted fake model, no network): the iteration bound; rejection
ending the loop; drift refusal on iteration 2+; the structural assertion that
no write/execute tool is bound to the proposal harness; Code Review's
fail-open analysis path. **B1's boundary gets adversarial coverage
specifically** — identical argv reuses; argv differing by one character does
not; a second task never inherits the first task's approved argv; a restart
mid-task does not resurrect one.

Live, against a real provider and a real scratch project — the evidence that
actually matters:

1. A real `edit-and-verify` run where the first edit **deliberately breaks the
   build**, the real verification command fails with real output, and the
   follow-up iteration genuinely fixes it. This one scenario is the whole
   checkpoint; without it, nothing here is proven.
2. A real rejection mid-loop, with the target file confirmed unchanged on
   disk afterward.
3. A real non-converging loop hitting the bound and reporting honestly.
4. A real `review-diff` against a diff whose correctness depends on context
   *outside* the diff — the case that justifies Part A at all — plus the same
   review with analysis unavailable, confirming clean degradation.

## Approval Requested

Approval authorizes: giving Coder a new `edit-and-verify` skill that iterates
edit → approved write → approved verification command → fix, bounded at 3
iterations, with every write individually approved and command approval scoped
per distinct argv per task (B1); adding `run_command`/`run_tests` to Coder's
declared tools, bound only to the approval-gated path and never to a proposal
harness; and giving Code Review shared deep project analysis, a bound
`git_diff`, and structured findings, while remaining permanently read-only.

It also authorizes the narrow amendment to `specs/080` that B1 represents —
that spec's "no trusted-command memory, ever" becomes "no trusted-command
memory beyond a byte-identical argv within one live task."

Approval does **not** authorize: any command reuse wider than that exact scope
(no cross-task, no cross-session, no persistence, no fuzzy argv matching); any
write executing without its own approval; binding any write or execute tool to
a proposal harness; Code Review gaining any write, execute, or approval
machinery; Coder editing OrchestrAI's own source; or unbounded iteration.
