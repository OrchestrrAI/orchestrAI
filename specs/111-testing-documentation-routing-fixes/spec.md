---
id: 111-testing-documentation-routing-fixes
title: "Ambiguous-Runner Harness Resolution and Read-Only document-api Harness Reachability"
area: agents
change_type: fix
status: implemented
verification: verified
created: 2026-09-22
updated: 2026-09-22
approved_by: Yusuf
approved_on: 2026-09-22
implemented_on: 2026-09-22
amends:
  - 058-testing-agent-multi-ecosystem-runner-detection
  - 080-run-command-approved-execution
  - 041-llm-harness-documentation
  - 100-document-api-grounded-llm-route-discovery-fallback
related:
  - 081-testing-write-tests-skill
  - 104-deferred-work-register
supersedes: []
superseded_by: []
---

# Spec: Ambiguous-Runner Harness Resolution and Read-Only document-api Harness Reachability

> Status: **IMPLEMENTED, VERIFIED, 2026-09-22.** Two small, independent fixes from
> `specs/104`'s deferred-work register (items A2 and A9), bundled into one
> checkpoint since neither needs independent sign-off from the other —
> the same precedent `specs/097` already established for unrelated
> same-session findings. Scope was deliberately narrowed from `specs/104`'s
> own item list during grounding: `A1` (a fixed entry-file list with no
> grounded fallback) and `A7` (`dispatchPlanStep()`'s own no-agent
> handling) both turned out to need real new design work — a genuinely
> new LLM-harness flow for A1, and synthesizing a full child-task
> lifecycle inside `dispatchPlanStep()` for A7 — not the "quick fix" their
> one-line register entries implied. Confirmed with Yusuf via
> AskUserQuestion before drafting: this spec covers **only A2 and A9**;
> A1 and A7 stay open in `specs/104`, each a candidate for its own future
> spec.

## Current behavior (verified against the real code)

### A9 — `document-api`'s LLM harness is unreachable from a read-only request

`packages/agents/documentation/index.ts`'s `processTask()` routes
`document-api` through `computeApiDocOrHarness()` (the harness-aware
path, including `specs/100`'s own grounded route-discovery fallback for
non-JS/TS files) **only** when the task text also asks to save the
output (`isWriteApi = skill === "document-api" && extractSavePath(text)
!== null`, line 549; the write branch calls `computeApiDocOrHarness()`
around line 600 inside the `needsApproval` block). A bare read-only
request instead calls `skillDocumentApi(text, false, task.id)` (line
653), whose current body is:

```ts
async function skillDocumentApi(text: string, allowWrite: boolean, taskId: string): Promise<string> {
  const { doc, savePath } = await computeApiDoc(text, taskId)
  if (allowWrite && savePath) return writeApiDoc(savePath, doc, taskId)
  return doc
}
```

`computeApiDoc()` (unlike `computeApiDocOrHarness()`) never touches the
harness at all — it always calls the purely deterministic `buildApiDoc()`.
Confirmed via `grep`: `skillDocumentApi()` has exactly one call site in
the entire file (line 653), always with `allowWrite: false` — the
`allowWrite: true` branch has never had a live caller since `specs/040`
split the write path out to call `computeApiDocOrHarness()`/
`writeApiDoc()` directly instead.

**Consequence, confirmed live during `specs/100`'s own verification**:
the identical PHP file, asked about read-only, produces "No Hono route
registrations found"; asked with "save to", produces a real, grounded
analysis via the harness's route-discovery fallback. Same file, same
harness state, two different answers depending only on phrasing.

### A2 — ambiguous test-runner detection never attempts resolution

`detectRunner()` (`packages/shared/test-runner.ts`) returns `{kind:
"ambiguous"}` when two conflicting signals of the same kind are found
(two lockfiles, or two framework configs). `packages/agents/testing/
index.ts`'s `processTask()` has two call sites that branch on this:

- `write-tests` (line 458) fails closed on both `"unsupported"` and
  `"ambiguous"` — **deliberately**, per `specs/081`'s own stated
  reasoning ("teaching it to also guess a framework for an unknown
  stack is explicitly deferred," since that harness already has to
  guess test *content*; compounding a second guess — which framework —
  in the same step was a considered non-goal, not an oversight). **Not
  touched by this spec.**
- `run-tests`/`check-coverage` (lines 577–599): the adjacent
  `"unsupported"` branch (line 583) calls `handleUnsupportedRunner(task.id,
  text, projectPath)` — the real 4-state fallback from `specs/080`
  (explicit command in the text wins outright; otherwise, when the
  harness is on, `runTestCommandHarness()` proposes a command grounded
  in real file reads via `read_project_file`; the harness on but
  misconfigured fails closed with a named error; the harness genuinely
  off produces the byte-identical pre-`080` "No tests configured — no
  package.json test script, pytest, or test files found." text). The
  `"ambiguous"` branch (line 587) right next to it just returns a
  static report — `"Ambiguous — more than one test runner is plausible:
  <candidates>. Resubmit naming which one to use."` — and never attempts
  anything, even when the harness is on and could plausibly resolve it
  from real file evidence the same way it already resolves the
  `"unsupported"` case.

## Proposed behavior

### Fix 1 (A9) — route the read-only path through the harness-aware function

Change `skillDocumentApi()`'s internal call from `computeApiDoc()` to
`computeApiDocOrHarness()`. Since `computeApiDocOrHarness()` returns a
bare `string` (not `computeApiDoc()`'s `{doc, savePath}` tuple), and
`savePath` is only ever needed inside the already-dead `allowWrite: true`
branch, resolve it there via the existing `extractSavePath(text)` helper
instead of destructuring it from the content-computation call:

```ts
async function skillDocumentApi(text: string, allowWrite: boolean, taskId: string): Promise<string> {
  const doc = await computeApiDocOrHarness(text, taskId)
  if (allowWrite) {
    const savePath = extractSavePath(text)
    if (savePath) return writeApiDoc(savePath, doc, taskId)
  }
  return doc
}
```

This is the entire fix — one function body, no new call site, no schema
change. `computeApiDocOrHarness()` already internally checks
`isHarnessFlagSet()` and falls back to the exact deterministic
`buildApiDoc()` output when the harness is off, so a read-only request
with the harness disabled is byte-identical to today's output; with the
harness on, it now gets the same real analysis (and `specs/100`'s
grounded route-discovery fallback) the write path already gets.

### Fix 2 (A2) — reuse `handleUnsupportedRunner()` for the ambiguous
### `run-tests`/`check-coverage` case, guarded against a misleading
### harness-off message

Naively routing the `"ambiguous"` branch through `handleUnsupportedRunner()`
unconditionally would be wrong: that function's own harness-off state
produces "No tests configured — no package.json test script, pytest, or
test files found." — false and misleading for an ambiguous project,
which plainly *does* have tests, just an unresolved choice of runner.
The fix only routes into the harness-resolution path when there is a
genuine chance of it helping — an explicit command already in the text,
or the harness genuinely on — and keeps today's honest ambiguity report
otherwise:

```ts
if (detection.kind === "ambiguous") {
  // specs/111 (specs/104 item A2) — reuse the adjacent "unsupported"
  // branch's own 4-state resolution mechanism (specs/080) instead of a
  // static resubmission request, but only when it can genuinely help:
  // an explicit command already names a runner, or the harness is on
  // and can look at the real files. Falling through unconditionally
  // would be wrong — handleUnsupportedRunner()'s own harness-off state
  // says "no tests configured," which is false for a project that
  // plainly has tests, just an unresolved choice of runner.
  if (extractRunCommandText(text) || isHarnessFlagSet()) {
    await handleUnsupportedRunner(task.id, text, projectPath)
    return
  }
  tasks.set(task.id, {
    id: task.id,
    status: "completed",
    result: [
      `=== Test Results ===`,
      `Project: ${projectPath}`,
      `Ambiguous — more than one test runner is plausible: ${detection.candidates.join(", ")}.`,
      `Resubmit naming which one to use.`,
    ].join("\n"),
  })
  return
}
```

The comment directly above this block (currently: "an ambiguous or
unsupported project completes with an honest report and never attempts
a runner at all") becomes false for the ambiguous+harness-on/explicit-
command case and is updated to describe the corrected behavior.

**`write-tests`'s own ambiguous branch is untouched** — this fix is
scoped to the `run-tests`/`check-coverage` call site only, per the
scope narrowing above.

**Explicitly not attempted**: `runTestCommandHarness()` is not told
which specific runners are in conflict — it independently explores the
real project via `read_project_file` and proposes whatever command it
judges correct, which may or may not be one of the originally-ambiguous
candidates. This is still strictly better than a blind resubmission
request (a real, grounded look beats none), but passing the candidate
list into the harness's own prompt as a disambiguation hint would touch
`packages/agents/testing/llm-harness.ts`'s prompt construction — a
larger change than this spec's own "smallest change" scope. Named here
as a real, deliberately deferred follow-up, not silently omitted.

## Scope

In scope: the two fixes above, their own focused tests, and closing
`specs/104`'s A2 (narrowed to the `run-tests`/`check-coverage` call site
only) and A9 items.

Out of scope: `specs/104`'s A1 (`document-api`'s fixed entry-candidate
list has no grounded fallback — needs a genuinely new LLM-harness flow),
A7 (`dispatchPlanStep()`'s own no-agent handling — needs a synthesized
child-task lifecycle to fit the supervisor's existing dispatch/wait/
outcome-classification contract), and `write-tests`'s own deliberate
ambiguous-runner non-goal (`specs/081`).

## Safety constraints

- Both fixes are strictly additive to existing, already-approved
  mechanisms (`computeApiDocOrHarness()`'s own fail-open/fail-closed
  shape from `specs/041`/`specs/100`; `handleUnsupportedRunner()`'s own
  4-state design and approval gate from `specs/080`) — neither
  introduces a new tool, a new approval path, or a new failure mode.
- The harness-off regression guarantee is load-bearing for both fixes:
  a request with the relevant harness disabled must produce
  byte-identical output to today, proven by test, not just by reading
  the code.
- `run-tests`/`check-coverage`'s existing approval gate (Tier 1 — a
  runner only ever executes after human approval) is completely
  unchanged; a harness-proposed command for a previously-ambiguous
  project reaches the identical `actionId`-bound approval flow every
  other `run-command`/`run-tests` proposal already uses.

## Acceptance criteria

- [x] A read-only `document-api` request against a project with no
      JS/TS entry file, harness on, produces a real grounded analysis
      instead of "No Hono route registrations found." **Live-verified**
      — see Verification Results below.
- [x] The identical request with the harness off reproduces today's
      exact deterministic output — a byte-identical regression check.
      **Live-verified.**
- [x] An ambiguous-runner project (two lockfiles), harness off, produces
      the exact unchanged "Ambiguous... resubmit naming which one to
      use" text — a byte-identical regression check. Unit-tested
      (`packages/agents/testing/index.test.ts`).
- [x] The identical project with the harness on routes into
      `handleUnsupportedRunner()`'s harness-proposal path, reaching a
      real `run-command`-style approval preview grounded in real file
      reads, not the static ambiguity report. **Live-verified** — a
      real model correctly resolved a real npm/pnpm ambiguity to
      `["npm", "test"]`.
- [x] An ambiguous-runner project with an explicit command in the task
      text (e.g. `"run command: npx jest"`) resolves via the explicit-
      command path even with the harness off. Unit-tested.
- [x] `write-tests`'s own ambiguous-runner behavior is unchanged
      (regression check — this spec does not touch it). Unit-tested.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `specs/104-deferred-work-register/spec.md` updated: A2 marked
      closed (noting the narrowed scope — `write-tests`'s own half
      stays open, unaddressed by design) and A9 marked closed, both
      pointing at this spec's number.

## Verification plan

- Unit: new focused tests in `packages/agents/documentation/*.test.ts`
  and `packages/agents/testing/*.test.ts` covering both the harness-on
  and harness-off paths for each fix, using this codebase's own
  established fake-model injection seams where a real provider call
  would otherwise be needed.
- Live (proportional — both fixes are read-only or reach an existing,
  unchanged approval gate, no new write path): a real scratch PHP
  project with no JS/TS entry file, `document-api` asked read-only,
  harness on. A real scratch project with two lockfiles, `run-tests`
  dispatched, harness on, confirming a real grounded proposal reaches
  the approval gate instead of an immediate ambiguity report.

## Non-goals

- `specs/104`'s A1 (grounded entry-file fallback) and A7
  (`dispatchPlanStep()`'s own no-agent handling) — each needs its own
  design pass and its own spec.
- Reversing `specs/081`'s own deliberate `write-tests` ambiguous-runner
  non-goal.
- Passing the ambiguous-runner candidate list into
  `runTestCommandHarness()`'s own prompt as a disambiguation hint.
- Any change to the approval gate, `SKILL_TIER_REGISTRY`, or either
  harness's own fail-open/fail-closed classification.
