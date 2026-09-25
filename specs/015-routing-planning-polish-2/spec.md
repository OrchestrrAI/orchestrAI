---
id: 015-routing-planning-polish-2
title: "Routing/Planning Polish — Round 2 (Testing routing, ci-substring, \"set up\")"
area: routing-planning
change_type: fix
status: implemented
verification: verified
created: 2026-08-09
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-09
implemented_on: 2026-08-09
amends:
  - 008-routing-fixes
supersedes: []
superseded_by: []
related:
  - 008-routing-fixes
---

# Spec: Routing/Planning Polish — Round 2 (Testing routing, ci-substring, "set up")

> Status: **APPROVED ("Approve both") and IMPLEMENTED on 2026-08-09. See
> Verification Results below.**

## Purpose

CLAUDE.md's "Known limitations" section lists three specific, already-
identified gaps left over from `specs/008-routing-fixes/spec.md`. This spec closes
all three:

1. Testing is the one agent still unreachable through direct Orchestrator
   routing — only reachable via its own dashboard or a Planning-generated
   plan step.
2. A directory path containing the substring `ci` (e.g. `...\ci-demo\...`)
   misroutes to `create-ci` in both the Orchestrator's and DevOps's own
   `detectSkill()`.
3. `"set up"` (two words) doesn't match the one-word `"setup"` keyword used
   by Planning's and the Orchestrator's plan triggers.

## Verified Current Behavior

- **Testing routing**: `apps/orchestrator/index.ts`'s `detectSkill()`
  (lines 107-144) has branches for DevOps, Planning, Security, and
  Documentation skills, and zero for Testing's `run-tests`/`check-coverage`
  — confirmed by reading the full function. No keyword reaches Testing
  directly today.
- **`ci`-substring bug**: `apps/orchestrator/index.ts:141` —
  `lower.includes("ci") || lower.includes("pipeline")`. `.includes("ci")`
  matches *any* occurrence of the two characters "c" then "i" adjacent
  anywhere in the string — including inside path segments like `ci-demo`,
  or even inside unrelated words. The exact same bug exists independently
  in `packages/agents/devops/index.ts:89` (DevOps's own `detectSkill()`)
  and `packages/agents/planning/index.ts:100` (Planning's own plan-step
  generator) — confirmed by reading all three.
- **`"set up"` gap**: `apps/orchestrator/index.ts:128` and
  `packages/agents/planning/index.ts:104` both check
  `lower.includes("setup")` only — the one-word form. A request phrased
  with a space, `"set up my project"`, does not match either, even though
  `packages/agents/planning/index.ts:37`'s own example preset button text
  ("setup my project from scratch") deliberately uses the one-word form
  that already works — the two-word phrasing is the actual gap, not a
  hypothetical one, since it's an extremely natural way to phrase the same
  request.

## Proposed Behavior

### 1. Testing routing

Add explicit Testing keywords to `apps/orchestrator/index.ts`'s
`detectSkill()`, positioned **after** the existing Planning `plan-task`
trigger check (same reasoning already established for Documentation/
Security in `specs/008-routing-fixes/spec.md`: a sentence combining a plan-trigger
word with testing wording, e.g. the already-demoed "build and deploy my bun
app" family, must keep reaching Planning first, not short-circuit):

```ts
// Testing Agent skills — checked after the Planning plan-task trigger for
// the same reason Documentation/Security are (specs/008-routing-fixes/spec.md):
// a sentence combining a plan trigger with testing wording must still
// produce the full plan, not short-circuit to one direct skill.
if (lower.includes("coverage"))                                   return "check-coverage"
if (lower.includes("run test") || lower.includes("run the test") ||
    lower.includes("test suite"))                                 return "run-tests"
```

Deliberately **not** matching a bare `"test"` substring — too broad (would
collide with words like "latest", "greatest", "attest", "protest", and with
Documentation/general text mentioning "testing" in passing). The proposed
triggers require an explicit action phrase ("run test(s)", "test suite") or
the already-unambiguous "coverage", mirroring how narrowly-scoped
Documentation/Security's own triggers were designed in the prior round.

### 2. `ci`-substring fix

Replace the bare substring check with a word-boundary-aware regex in all
three locations (Orchestrator, DevOps, Planning), so "ci" only matches when
it appears as its own space-delimited word, not embedded in a path segment
or another word:

```ts
const CI_WORD = /(^|\s)ci(\s|$)/
// ...
if (CI_WORD.test(lower) || lower.includes("pipeline") || lower.includes("github action")) return "create-ci"
```

This still matches `"set up ci"`, `"create a ci pipeline"`, `"ci"` alone,
etc. (space-delimited), but no longer matches `...\ci-demo\...` (path
separator/hyphen-delimited, not space-delimited) or words like
"specific"/"decision" (never did, `.includes` never matched those either,
unaffected). A hyphenated phrase like `"ci-cd pipeline"` still routes
correctly via the existing `"pipeline"` keyword, unaffected by this change.

### 3. `"set up"` fix

Add the two-word form alongside the existing one-word form, in both
`apps/orchestrator/index.ts:128` and `packages/agents/planning/index.ts:104`:

```ts
lower.includes("setup") || lower.includes("set up")
```

## Safety Constraints

- No change to approval policy, Tier classification, or any write-path
  execution logic — this spec is routing/keyword-matching only, exactly
  like `specs/008-routing-fixes/spec.md` before it. Testing's own Tier 1
  approval-required-whenever-a-runner-is-detected behavior
  (`resumeTask()`) is unchanged and applies identically regardless of how
  the task reached Testing (direct route, Planning-generated step, or its
  own dashboard) — the Orchestrator's dispatch path is skill-agnostic.
- The `ci`-substring fix only narrows matches (removes false positives) —
  it cannot newly misroute anything that wasn't already ambiguous, since
  every case it stops matching was already a bug, not an intended trigger.
- The `"set up"` fix only adds a trigger, does not remove or narrow the
  existing `"setup"` one-word trigger, so no currently-correct routing
  changes.

## In Scope

1. `apps/orchestrator/index.ts`: Testing keywords, `ci` word-boundary fix,
   `"set up"` addition.
2. `packages/agents/devops/index.ts`: `ci` word-boundary fix (its own
   independent `detectSkill()`).
3. `packages/agents/planning/index.ts`: `ci` word-boundary fix, `"set up"`
   addition (its own independent plan-step generator).
4. Regression tests in `apps/orchestrator/detect-skill.test.ts` (existing
   file, per CLAUDE.md) covering: a path containing `ci-demo` no longer
   misrouting; `"set up my project"` reaching `plan-task`; `"run tests on my
   project"` and `"check test coverage"` reaching Testing directly;
   existing demoed sentences (e.g. "build and deploy my bun app") still
   producing the same step count as before (no regression).

## Out of Scope / Non-Goals

- LLM-based routing (team decision, tracked separately, not a substitute
  for deterministic keyword matching per CLAUDE.md).
- Any other known-gap not explicitly listed above.
- Changing Testing's own internal `detectSkill()` (`packages/agents/
  testing/index.ts`) — that agent already correctly maps `run-tests`/
  `check-coverage` once a task reaches it; this spec is only about getting
  tasks there in the first place.
- Broadening Security's or Documentation's own trigger sets further (their
  `specs/008-routing-fixes/spec.md`-era narrow-by-design scoping stays as-is; only
  Security's *skill-detection* was broadened separately today, unrelated to
  this spec's Orchestrator-level routing scope).

## Acceptance Criteria

- [x] Yusuf approves this spec ("Approve both").
- [x] All three fixes implemented in the three files listed.
- [x] New/updated regression tests pass for: `ci-demo` path no longer
      misrouting, `"set up my project"` reaching `plan-task`, "run tests on
      my project" and "check test coverage" reaching Testing directly.
- [x] Existing regression tests for previously-fixed routing (Documentation,
      Security, `create-compose`, the Planning-trigger-checked-first
      ordering) still pass unchanged — no regression.
- [x] `bun test` remains fully green.
- [x] Live check: submit "run tests on my project" to the Orchestrator and
      confirm it's assigned directly to `testing-agent`, not routed through
      a Planning-generated plan step.

## Verification Results (2026-08-09)

- One test-design correction found while writing the new regression tests:
  `"set up ci for this repo"` does **not** reach `create-ci` — it correctly
  reaches `plan-task` instead, because `"set up"` is *also* a Planning
  trigger, and Planning's triggers are deliberately checked first (same
  ordering guarantee already established for Documentation/Security in
  `specs/008-routing-fixes/spec.md`). The spec's own example was wrong, not the code;
  fixed the test to assert the actually-correct behavior and added a
  separate test confirming it.
- `bun test`: 114 pass (up from 104 — 10 new regression tests), 0 fail, 183
  expectations, 12 files.
- `bunx tsc --noEmit`: 0 errors (unaffected by these changes).
- `bun test packages/agents/planning`: 6 pass, 0 fail — Planning's own
  plan-step-generation tests unaffected by the `CI_WORD`/`"set up"` changes
  there.
- Live verification against a real running stack:
  - `"run tests on my project"` → `{assignedAgent: "testing-agent", skill:
    "run-tests", isPlan: false}` — direct single-step dispatch, not a
    Planning-generated plan.
  - `"set up my project"` → `{assignedAgent: "planning-agent", skill:
    "plan-task", isPlan: true}` — the two-word form now reaches Planning
    exactly like the one-word `"setup"` already did.
  - `"analyze the project at C:/work/ci-demo/repo"` → `{assignedAgent:
    "devops-agent", skill: "analyze-project", isPlan: false}` — correctly
    did **not** misroute to `create-ci` despite the path containing
    `ci-demo`.

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/015-routing-planning-polish-2/spec.md as written.
```

or list specific keyword/wording changes needed.
