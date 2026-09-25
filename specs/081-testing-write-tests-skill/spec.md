---
id: 081-testing-write-tests-skill
title: "Phase C: write-tests — Testing Agent Authors a Real Test File"
area: testing-agent
change_type: feature
status: implemented
verification: verified
created: 2026-09-12
updated: 2026-09-12
approved_by: Yusuf
approved_on: 2026-09-12
implemented_on: 2026-09-12
amends:
  - 080-run-command-approved-execution
related:
  - 078-capability-upgrade-roadmap
  - 041-llm-harness-documentation
  - 058-testing-agent-multi-ecosystem-runner-detection
  - 040-approval-preview-content-diff
  - 056-devops-preflight-and-idempotent-writes
  - 036-document-api-path-fallback
supersedes: []
superseded_by: []
---

# Spec: Phase C: write-tests — Testing Agent Authors a Real Test File

> Review gate: **APPROVED by Yusuf, 2026-09-12. Implemented and fully
> live-verified against a real Gemini deployment the same day** — every
> Acceptance Criterion below is checked, including both the `bun` and
> `pytest` paths, the drift-recheck refusal, and rejection-creates-
> nothing. See `verification.md` for the complete transcript.
>
> `specs/078-capability-upgrade-roadmap/spec.md` names this Phase C
> ("Testing writes tests"), promoted ahead of the Coder Agent by Yusuf's
> own decision 6 ("Model-authored tests — approved, promoted ahead of
> Coder Agent"). It is gated on Phase B (`specs/080`) reaching
> `verification: verified` per the roadmap's own ordering rule — closed
> 2026-09-12 via a live pass against a real Gemini deployment. This is
> the roadmap's own risk class 5 ("model-authored source code"), one
> step past `run_command`'s class 4 (a model-chosen *command*, still
> fixed by a human-reviewed argv) — the first time this codebase lets a
> model author real source code that becomes a real file on disk.
>
> Design answers already given directly by Yusuf, driving every design
> choice below: **(1)** a genuinely new skill, used only when explicitly
> asked for, not folded into `run-tests`. **(2)** the same
> `read_project_file`/`write_project_file` + content-diff approval
> pattern Documentation's `generate-readme` already established
> (`specs/040`/`specs/041`). **(3)** writing the test file and running it
> stay **two separate approvals** — a human can review what got written
> before ever approving its execution. **(4)** approval granularity is
> **one approval per file**, chosen via AskUserQuestion over "per test
> case" (no precedent, needs new UI) and "one approval covering a whole
> multi-file batch" (no existing multi-file diff precedent either) —
> matching every other write-capable skill in this codebase, which
> already approves one artifact at a time.

## Purpose

Testing Agent can run tests and, as of `specs/080`, propose a command
for a stack it has no fixed runner profile for — but it has never been
able to make a project's test coverage better on its own. A project
with zero tests stays at zero tests forever unless a human writes them.
`write-tests` closes that gap: given an explicit source file, Testing
authors a real, syntactically-correct test file for it, in the
project's own real test framework, subject to the exact same
human-approval gate every other write-capable skill in this codebase
already uses — and never executes what it writes without a second,
separate approval.

## Verified Current State

Read 2026-09-12:

- `packages/agents/testing/index.ts` has exactly two skills
  (`run-tests`, `check-coverage`), both execution-only — no skill
  writes anything to disk. `detectSkill()`'s only two triggers are
  `"coverage"` and a bare `"test"` substring, checked in that order —
  a bare `"test"` would swallow `"write tests for X"` today, exactly
  the ordering hazard `specs/079`/`specs/080` already had to fix for
  their own new skills.
- `packages/agents/testing/model-factory.ts` + `llm-harness.ts`
  (`specs/080`) gave Testing its first-ever LLM harness — but scoped
  narrowly to proposing a `run_command` argv (a JSON parameter object:
  `{argv, reason}`) for an unsupported-stack fallback. Its own doc
  comment states plainly: *"it is NOT specs/078's Phase C ('Testing
  writes tests') — no test authoring happens here, only deciding which
  real command to run."* This spec is exactly that deferred Phase C —
  the model's output here is real source-code **content**, not a JSON
  parameter shape, the first time any Testing harness output has been
  that.
- `packages/shared/test-runner.ts`'s `detectRunner()` (`specs/058`)
  already classifies a project's real ecosystem into one of 7
  `RunnerProfile`s (`bun`/`npm`/`pnpm`/`yarn`/`jest`/`vitest`/`pytest`)
  or `{kind: "ambiguous" | "unsupported"}` — the exact signal needed to
  pick correct test syntax and a correct test-file naming convention
  deterministically, already built, never previously consumed by
  anything but `run-tests`/`check-coverage`'s own execution path.
- Documentation Agent (`specs/041`) is this codebase's only existing
  precedent for LLM-authored **file content** (not just parameters):
  `generate-readme`/`document-api`, using `read_project_file`/
  `write_project_file`, `specs/040`'s content-diff approval preview
  (`content`/`previousContent` on `ApprovalPreview`), one approval per
  write.
- **A real, previously undocumented asymmetry found while grounding
  this spec**: DevOps's four write skills (`specs/056`) re-verify a
  content fingerprint immediately before the real write in
  `resumeTask()`, refusing to write if the target drifted after
  approval. Documentation's own write path (`generate-readme`/
  `document-api`) **never adopted this** — confirmed directly: no
  `computeContentFingerprint`/`classifyWritePreflight` call exists
  anywhere in `packages/agents/documentation/index.ts`. `specs/056`'s
  own scope statement ("Applies uniformly to all four DevOps write
  skills") confirms this was a deliberate scope boundary at the time,
  not an oversight later found and left unfixed. This spec has to pick
  one of the two existing patterns for `write-tests`'s own approval —
  see Proposed Behavior §7 for the choice and why.

## Proposed Behavior

### 1. A new skill: `write-tests`

Added to Testing's Agent Card. `detectSkill()` gains a narrow trigger —
`lower.includes("write test") || lower.includes("generate test") ||
lower.includes("create test") || lower.includes("add test")` — checked
**before** the existing bare `"test"` check, the same specificity-first
ordering `specs/079`'s `commit-changes`/`git-diff` and `specs/080`'s
`run-command` already established ahead of their own agents' broader
catch-alls.

### 2. An explicit source file path is required — no guessing

Unlike `document-api`'s conventional-entry-file fallback
(`specs/036`, appropriate there because "document the project's own
API surface" has a small, ordered list of plausible entry points),
**deciding which untested file most needs a new test is a materially
higher-stakes guess** with no comparable small candidate set. The task
text must name an explicit source file (absolute path, or a path
relative to the resolved project root). Absent one, the task fails
closed with a named error listing what was expected — never a guess.

### 3. A **detected** test runner is required for the target project

`detectRunner()` is called against the resolved project root before
anything else. Only `{kind: "detected"}` proceeds — both the test
syntax the harness must write in and the deterministic file-naming
convention (§4) depend on knowing the real ecosystem.
`{kind: "ambiguous"}`/`{kind: "unsupported"}` fails closed with a clear
error naming the real reason (mirroring `run-tests`'s own existing
ambiguous/unsupported messages). Teaching the harness to *also* pick a
framework for an undetected stack is explicitly out of scope (§
Out of Scope) — compounding "guess the framework" and "author the
tests" in one step is a materially bigger bet than authoring tests for
an already-known ecosystem.

### 4. The test file's path is derived deterministically — never model-chosen

Mirrors `specs/042`'s own precedent (the model decides *content*, a
fixed target path is computed independently): given the detected
`RunnerProfile`,

- `bun`/`npm`/`pnpm`/`yarn`/`jest`/`vitest` → `<name>.test.<ext>` beside
  the source file (`<ext>` matches the source file's own extension —
  this repository's own convention, e.g. `foo.ts` → `foo.test.ts`).
- `pytest` → `test_<name>.py` beside the source file (the common Python
  convention `pytest`'s own default discovery rule already expects).

No model-suppliable path exists anywhere in this flow.

### 5. Content is model-authored via a new harness entry point

`runWriteTestsHarness()` (new function, `packages/agents/testing/
llm-harness.ts`) reads the real source file via the already-bound
`read_project_file` tool, is told the detected `RunnerProfile` by name
so it writes syntactically correct test code for that exact framework
(e.g. `bun:test`'s `import { test, expect } from "bun:test"` vs
`pytest`'s `def test_...():` / `assert ...`), and returns **raw test
file content** — not a JSON parameter object like every other Testing/
DevOps harness output to date. Markdown-fence stripping (the same
`.replace(/^\`\`\`.../...)` normalization `validateJsonParams()` already
does) applies to the raw text before it's treated as file content, in
case the model wraps its answer in a code fence.

### 6. A grounding check, not full semantic validation

The generated content must contain at least one real, exported/
top-level identifier from the source file (a plain substring check
against names extracted from the source — the same shallow, deliberate
non-semantic check `document-api`'s own per-route grounding check
already uses, `specs/041`). A response referencing nothing from the
real source file is rejected and reprompted with feedback (bounded
retry, matching every existing harness's own retry ceiling); exhausted
retries fail the task closed.

### 7. Approval: one file, one preview, **plus** DevOps's stronger drift recheck

One approval per file (Yusuf's own chosen granularity), reusing
`specs/040`'s exact `content`/`previousContent` diff shape on
`ApprovalPreview` — byte-identical rendering to every existing
write-capable dashboard/TUI card, no new UI.

**Deliberately adopts DevOps's stronger pattern (`specs/056`), not
Documentation's lighter one** (see Verified Current State's own finding
above): a content fingerprint (`computeContentFingerprint()`, the exact
function `specs/056`/`specs/079` already use) is computed at preview
time and re-verified in `resumeTask()` immediately before the real
`write_project_file` call, refusing the write and requiring a fresh
preflight if the target changed after approval. Justification for the
stronger choice here specifically: a test file, once approved, is very
likely to be `run_command`-approved and executed shortly after — the
same "confirm nothing changed since a human last looked at this"
guarantee DevOps's own executing/committing writes already get is
judged worth the small extra complexity for source code destined to
run, even though Documentation's own lighter pattern remains acceptable
for prose.

### 8. Writing and running are always two separate approvals

`write-tests` calls `write_project_file` and nothing else — it never
dispatches `run-tests`/`check-coverage`/`run_command` on the file it
just wrote, automatically or otherwise. A human reviews the written
test file's content (via this skill's own approval), and only a
**separate**, later request (`"run the tests in foo.test.ts"`, routed
through the existing `run-tests` skill exactly as it already handles
any other test file) triggers execution, hitting `run-tests`'s own
already-existing approval gate a second time. This is Yusuf's own
explicit condition, not an implementation convenience — a single
approval must never be able to both introduce new code and execute it.

### 9. New required tool

`packages/agents/testing/index.ts`'s `requiredTools` gains
`write_project_file` (already exists on the shared MCP server, already
used by Documentation — no new MCP-server-side tool is added by this
spec at all, only a new consumer of an existing one).

### 10. Gated by the same harness flag `specs/080` already introduced

`ORCHESTRAI_TESTING_LLM_HARNESS=1` now gates two narrowly-scoped
Testing capabilities: the `run-tests` unsupported-stack fallback
(`specs/080`) and `write-tests` (this spec) — both fail closed
identically on a missing/invalid key, matching every prior harness
checkpoint's precedent. `packages/agents/testing/model-factory.ts`'s own
doc comment, which currently states the harness "is not Testing
'writing tests' (specs/078's own Phase C ... a separate, later
decision)," is corrected by this spec once approved — that statement
was accurate when written and is now historical.

## Scope

In scope: the `write-tests` skill end to end (detection, explicit-path
requirement, runner-detection requirement, deterministic path
derivation, the new harness entry point, grounding check, approval
preview with fingerprint-bound drift recheck, the write itself).
Updating `packages/agents/testing/model-factory.ts`'s own doc comment.
Agent Card / `SKILL_TIER_REGISTRY` / `SUPERVISOR_ALLOWED_SKILLS` /
`AGENT_CATALOG` (`apps/supervisor/agent-catalog.ts`) registration,
matching every prior new-skill checkpoint's own rollout shape.

Out of scope (see below): auto-running generated tests; batch/
multi-file generation; picking a framework for an undetected stack;
modifying an existing test file's content (only ever a brand-new file,
or a full overwrite of one that already exists at the derived path,
going through the exact same preflight/approval as any other write —
"intelligently merge into existing tests" is a materially harder,
separate problem).

## Safety and Compatibility Constraints

- `write-tests` never calls `run_tests`/`run_command`, directly or
  indirectly, under any circumstance — enforced by construction (the
  function that handles this skill has no code path that reaches
  either tool), not by a prompt instruction.
- The written file's path is 100% deterministic given `(source path,
  detected RunnerProfile)` — no model-suppliable path exists anywhere
  in this flow, the same structural guarantee `specs/042`'s four DevOps
  write skills already hold for their own output paths.
- Fail-closed everywhere a precondition is missing: no explicit source
  path, an ambiguous/unsupported runner, the harness flag off, the
  harness misconfigured (no key), or an exhausted grounding-check
  retry — every one of these produces a named, specific error, never a
  guess, a partial write, or a silent fallback to some other behavior.
- The approval preview's `risks` field states plainly that this is
  AI-authored test code with no guarantee of correctness or coverage
  quality, and that it does not execute merely by being approved.

## Out of Scope / Non-Goals

- Automatically running a test file this skill just wrote.
- Generating tests for more than one source file per skill invocation.
- Choosing/inferring a test framework for a project `detectRunner()`
  can't already classify.
- Modifying or intelligently merging into an already-existing,
  hand-written test file's content (a full-file overwrite is possible,
  subject to the identical approval/diff/fingerprint flow as a create —
  merging is a separate, harder problem for a later spec if ever
  needed).
- Any change to `detectRunner()`, `RUNNER_ARGV`, or Testing's existing
  `run-tests`/`check-coverage` skills' own behavior.
- Any change to DevOps's, Documentation's, or Security's own skills,
  tools, or harnesses.

## Acceptance Criteria

- [x] `write-tests` is detected from natural task text (`"write tests
      for src/foo.ts"`) and via an explicit `selectedSkill`, without
      shadowing or being shadowed by `run-tests`/`check-coverage` —
      confirmed via a real HTTP request against the real, unmodified app
      (`packages/agents/testing/index.test.ts`).
- [x] No explicit source path in the task text fails closed with a
      named error — no guess is ever attempted.
- [x] An ambiguous or unsupported `detectRunner()` result for the
      target project fails closed with a clear, specific error.
- [x] For a real `bun` project, a real test file is generated at the
      correct deterministic path (`<name>.test.ts` beside the source),
      contains real, syntactically valid `bun:test` code, and
      references real identifiers from the source file — **live-verified
      2026-09-12** against a real Gemini deployment (`gemini-3.5-flash`):
      given a real `math.ts` (`clamp`/`isEven`), the model produced
      `math.test.ts` with 5 real `describe`/`test` cases genuinely
      exercising both functions, including boundary cases (`clamp`'s
      below/above/within-range) not merely restated from the source.
- [x] For a real `pytest` project, the same holds with the correct
      path (`test_<name>.py`) and syntax — **live-verified 2026-09-12**
      against a real Gemini deployment: a real scratch project
      (`requirements.txt`, a genuinely untested `strings.py` with
      `reverse_words`/`is_palindrome`) correctly derived `test_strings.py`
      and produced real, syntactically correct `pytest` code (plain
      `def test_...():` functions using `assert`, no `bun:test`-style
      imports/framework mismatch). Approved, written byte-identical to
      the preview, and — via a genuinely separate, second `run-tests`
      approval — a real `python -m pytest` process ran it: **2 passed, 0
      failed**, confirming the tests are not just syntactically plausible
      but actually correct against the real source.
- [x] The approval preview shows the real generated content as a diff/
      create preview (`specs/040`'s existing rendering, no new UI) —
      confirmed live: the `input-required` response's `approval.content`
      field contained the exact generated file, `overwrite: false` for
      the fresh-create case.
- [x] A target that changed after approval but before the write is
      refused with a named drift error, requiring a fresh preflight —
      the same guarantee `specs/056` already gives DevOps's writes.
      **Live-verified 2026-09-12**: after a real write-tests preview was
      shown, the target `util.test.ts` was manually overwritten with
      unrelated content before approving; approving it was refused with
      `"Target \"util.test.ts\" changed after approval but before this
      write — refusing to overwrite unreviewed content."`, and the file
      on disk was confirmed to still hold the manual mutation, not
      further corrupted or silently overwritten.
- [x] Approving the write creates the file with byte-identical content
      to what the preview showed; rejecting it creates nothing — **both
      live-verified**: `math.test.ts`/`test_strings.py` on disk both
      matched their own `approval.content` byte for byte after approval;
      a separate `nums.test.ts` preview, rejected instead, confirmed
      `{"status":"failed","error":"Rejected by user"}` with the target
      directory's filesystem containing no such file afterward.
- [x] No `run-tests`/`check-coverage`/`run_command` dispatch of any kind
      occurs as a side effect of approving a `write-tests` action —
      **live-verified**: after approving the write, the task's `result`
      field explicitly stated execution had not happened, and a genuinely
      separate, second `run-tests` request was required (and itself
      reached its own independent `input-required` approval) before the
      written file's tests actually ran.
- [x] With the harness off, `write-tests` fails closed with a named
      error (no deterministic fallback exists for this skill — unlike
      `run-tests`'s own unsupported-stack fallback, there's no sensible
      non-LLM path to "author correct test code").
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass, and
      the full pre-existing suite is unaffected — 949 pass, 0 fail
      (net +7 over `specs/080`'s own 942), typecheck clean.

## Verification Plan

- Unit: skill detection ordering (no shadowing either direction), the
  explicit-path/runner-detection preconditions, deterministic path
  derivation for at least `bun` and `pytest`, the grounding check
  (a forced ungrounded response rejected and retried, matching
  `specs/043`'s own CVE-guard test technique), the fingerprint drift
  recheck, and the harness-off fail-closed path — all via an injected
  fake model, no live provider call needed for these.
- Live, with a real provider key: a real small project with a real
  untested function, `write-tests` genuinely authors a correct test
  file for it, approved, and — as a **separate**, later request —
  `run-tests` genuinely executes that exact file and reports real
  pass/fail. A live rejection pass confirming nothing is written.

## Approval Requested

Approve to proceed with Phase C as scoped above. This closes the
roadmap's own risk-class-5 gap for Testing specifically; Phases D
(Code Review Agent) and E (Coder Agent) remain separately gated,
not addressed here.
