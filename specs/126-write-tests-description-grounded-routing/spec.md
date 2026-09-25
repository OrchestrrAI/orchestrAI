---
id: 126-write-tests-description-grounded-routing
title: Route Whole-Project Test Requests to the Planner via write-tests' Own Description
area: routing-planning
change_type: fix
status: implemented
verification: verified
created: 2026-09-24
updated: 2026-09-24
approved_by: Muhamad-Yussuf
approved_on: 2026-09-24
implemented_on: 2026-09-24
amends:
  - 121-skill-description-grounded-routing
  - 081-testing-write-tests-skill
supersedes: []
superseded_by: []
related:
  - 065-llm-only-skill-routing
  - 028-orchestrator-langgraph-supervisor
---

# Spec: Route Whole-Project Test Requests to the Planner via write-tests' Own Description

> Status history: **APPROVED by Muhamad-Yussuf on 2026-09-24** ("start
> draft and implement it"), with an explicit scope decision: **no
> deterministic guard** — description wording only. IMPLEMENTED and
> VERIFIED live the same day — see `verification.md`.

## Purpose

Live-reproduced via the TUI against `C:\Users\moham\test-target-project`:
"can you create the test cases for that project ?" routed directly to the
Testing agent's `write-tests` skill, which failed with `No source file
named — expected e.g. "write tests for src/foo.ts". write-tests never
guesses which file needs tests.` (`packages/agents/testing/index.ts:430`).

That refusal is correct and stays (specs/081). The defect is upstream: a
whole-project request was routed to a skill that by design only handles
one explicitly named file. The router and the adaptive supervisor were
both told `write-tests` is for "an explicitly named source file", but
nothing said what to do when the request names none.

## Verified Current State

- The capability router sees each skill's own Agent Card description
  (specs/121, bounded to `MAX_SKILL_DESCRIPTION_BYTES = 300`). Testing's
  card (`packages/agents/testing/index.ts:77`) describes `write-tests` as
  "Author a real test file for an explicitly named source file, …".
- The router's prompt already says to answer `"unsupported"` when "the
  request names real work but no current skill fits it", and
  `"unsupported"` already falls through to `plan-task`.
- The supervisor's own `SKILL_DESCRIPTIONS["write-tests"]`
  (`apps/orchestrator/supervisor-graph.ts:150`) carries the same text.
- A plan step reaches the agent as
  `` `${step.skill}: ${step.description} — ${parentTask.text}` ``
  (`apps/orchestrator/index.ts:1235`), and the agent's
  `extractSourceFileToken()` takes the first `for <token>.<ext>` match.
  So a step description that itself says "write tests for src/x.ts"
  already works end to end today; nothing tells the supervisor to write
  one that way.

## Proposed Behavior

Description wording only — no new code path, no deterministic guard
(explicitly declined by Muhamad-Yussuf).

1. **Testing Agent Card** — `write-tests`' description states it is for
   one source file the request itself names, and that a whole-project or
   unnamed-file request is not this skill. The router then answers
   `"unsupported"` for such a request, which falls through to `plan-task`.
   Must stay within `MAX_SKILL_DESCRIPTION_BYTES` so it is never truncated.
2. **Supervisor `SKILL_DESCRIPTIONS["write-tests"]`** — the same
   distinction, plus the instruction that makes the plan work: for a
   whole-project request, choose real source files from the read-only
   inspection the supervisor already has (or `analyze-project`, never
   `run-command` just to list files), then dispatch one `write-tests` step
   per file whose `description` names that file (e.g. "write tests for
   src/foo.ts").

## Scope

- `packages/agents/testing/index.ts` — the `write-tests` Agent Card
  description.
- `apps/orchestrator/supervisor-graph.ts` — `SKILL_DESCRIPTIONS["write-tests"]`.
- Tests: the new card description fits the byte bound and survives
  normalization untruncated; the supervisor prompt carries the new
  guidance.

## Safety and Compatibility Constraints

- `write-tests` itself is unchanged: it still fails closed with no named
  file, the output path is still 100% deterministic, and writing and
  running remain two separate approvals (specs/081).
- The approval gate, `SKILL_TIER_REGISTRY`, and outcome classification
  are untouched. Routing to `plan-task` only changes who proposes steps;
  every write still reaches its own approval gate.
- An explicitly named request ("write tests for src/foo.ts") must still
  route to `write-tests` directly.

## Non-Goals

- A deterministic Orchestrator-side check for a named file (declined).
- Letting `write-tests` itself pick files.
- Changing `extractSourceFileToken()` or the child-task text format.

## Acceptance Criteria

- [x] Explicit approval recorded before implementation.
- [x] Testing's `write-tests` card description names the one-named-file
  scope and excludes whole-project requests, within
  `MAX_SKILL_DESCRIPTION_BYTES`.
- [x] `SKILL_DESCRIPTIONS["write-tests"]` tells the supervisor to pick real
  files first and to name the file in each step's description.
- [x] `bun run typecheck` 0 errors; `bun test` no regressions.
- [x] Live: "create the test cases for that project" against the fixture
  routes to `plan-task`, and the plan dispatches at least one
  `write-tests` step that reaches `input-required` with a real preview.
- [x] Live: "write tests for src/<file>.ts" still routes directly to
  `write-tests`.

## Verification Plan

- Unit tests as listed in Scope.
- Live, with a real provider key, against
  `C:\Users\moham\test-target-project`: both prompts above, recording the
  routed skill and the first `write-tests` step's child text. Because
  routing is an LLM judgment, the result is recorded as observed, not
  asserted as guaranteed.
