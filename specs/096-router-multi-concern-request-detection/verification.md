# Verification: specs/096 — Router Recognizes Multi-Concern Requests

## What changed

- `packages/shared/capability-router.ts`'s `buildSystemPrompt()` gained
  one instruction: a request naming two or more genuinely distinct
  concerns needing different skills gets `kind: "unsupported"` instead
  of the router picking whichever one concern it judges "most likely."
  Worked example included in the prompt itself, naming the exact
  live-reproduced scenario. No schema change, no new `kind` value — the
  existing `"unsupported"` sentinel already falls through to
  `"plan-task"` via `detectSkill()`'s unchanged catch-all.
- `packages/shared/capability-router.test.ts` gained: a prompt-content
  assertion (the new instruction text is present in the system prompt
  sent to the model), a scripted multi-concern → `"unsupported"`
  acceptance test, and a single-concern-phrased-with-"and" regression
  test proving the existing case is unaffected.

## Acceptance criteria

- [x] The live-reproduced scenario (*"the test coverage and the
      security also are ok here?"*) resolves to `plan-task`, not a
      single direct skill — confirmed via a real dispatch against the
      real running Orchestrator: `{"assignedAgent":"orchestrator-
      supervisor","skill":"plan-task","isPlan":true}`.
- [x] The resulting `plan-task` run genuinely checks both concerns —
      confirmed: the real plan steps were `analyze-project` →
      `scan-secrets` → `audit-dependencies` → `git-status` →
      `check-coverage`. Both `scan-secrets` and `audit-dependencies`
      (security) and `check-coverage` (testing) are present in the same
      run — not merely routed to `plan-task` in name only.
- [x] A single-concern request phrased with "and" still resolves
      directly to one skill — proven by the new regression test
      (`capability-router.test.ts`).
- [x] Every pre-existing `capability-router.test.ts` test passes
      unmodified — 19 pass (was 16 before this spec's own 3 new tests),
      0 fail.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass —
      1104 pass / 0 fail full suite, typecheck 0 errors, specs:check
      passed for 95 specs.

## Live verification

Performed against the real running 6-agent stack (this repository
itself as the target project — the Orchestrator's own live
`projectPath`), with a real Gemini deployment (the key already present
in `.orchestrai/config.env`), not mocked:

1. Restarted the Orchestrator process to load the updated
   `capability-router.ts` (the only process that imports it).
2. Dispatched `POST /tasks {"text": "the test coverage and the security
   also are ok here?"}` — the exact phrasing from the original report.
3. Real response: `{"assignedAgent":"orchestrator-supervisor",
   "skill":"plan-task","isPlan":true}` — correctly escalated, not a
   single direct skill dispatch (the pre-fix behavior was
   `testing-agent`/`check-coverage` only, confirmed in the spec's own
   Verified Current State section from the same-session reproduction).
4. Polled the task; the real adaptive supervisor produced a 5-step plan:
   `analyze-project`, `scan-secrets`, `audit-dependencies`,
   `git-status`, `check-coverage` — genuinely covering both the testing
   and security concerns the original request named, plus reasonable
   supporting context steps the supervisor chose on its own.
5. `check-coverage` (Tier 1, approval-required) reached
   `input-required` with a real `actionId`-bound preview (`bun test
   --coverage` against this repo); approved directly (a safe, read-only
   test run — no file writes). The child completed successfully
   afterward.
6. All 4 non-approval-gated steps (`analyze-project`, `scan-secrets`,
   `audit-dependencies`, `git-status`) completed on their own; the
   5th (`check-coverage`) completed once approved.

**Non-determinism, disclosed honestly, not smoothed over**: this fix is
a prompt instruction, not a hard code rule — both the router's own
classification and the adaptive supervisor's own step-by-step choices
are real model judgments, and can vary run to run (the same
non-determinism `specs/065`'s own verification record already
documented for this router). What's deterministic is the fallback
wiring: any `kind` other than `read-only`/`state-changing` already
routes to `plan-task` with zero conditional code, unchanged from before
this spec.

## Known limitations

- The exact set/order of plan steps the supervisor chooses is not
  guaranteed to be identical across runs — this run's shape
  (`analyze-project`/`scan-secrets`/`audit-dependencies`/`git-status`/
  `check-coverage`) is one correct outcome, not the only possible one.
- The parent task's own final `status` field lagged behind its last
  child completing by at least one supervisor tick in this pass (still
  `"working"` immediately after the last child reached `"completed"`)
  — not a regression from this spec (unrelated to routing), not
  investigated further here.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**A real gap in the router's own single-skill design, found and fixed,
`specs/096-router-multi-concern-request-detection/spec.md` (implemented,
verified, 2026-09-15).** The router's job, per its own system prompt, is
"name which single skill this request most likely wants" — correct for
a genuinely single-concern request, but silently wrong for one naming
two or more distinct concerns needing different skills: the router
still picked exactly one (whichever it judged "most likely") and the
other concern was never even attempted, with no signal to the user that
anything was skipped. Live-caught by Yusuf: *"the prompets seems to be
a large task but the router assienegd it to spesfec agent with only one
task"* — a real request, *"the test covarage and the security also are
ok here?"*, dispatched to `testing-agent`/`check-coverage` only,
Security never contacted, confirmed via `GET /tasks`. Fixed with one
more prompt instruction, no schema/code change: a request naming
genuinely distinct concerns needing different skills gets
`kind: "unsupported"` (the existing sentinel, not a new value) instead
of the router picking one — already falls through to `plan-task`'s
adaptive supervisor via `detectSkill()`'s unchanged catch-all, which
already handles a multi-step request correctly (`specs/028`/`specs/060`).
A worked example is embedded directly in the prompt, and a regression
test confirms a single-concern request merely phrased with "and" still
resolves to one skill, avoiding an over-broad escalation. **Live-verified
against the real running stack** (this repository as the target project,
a real Gemini key): the exact reported phrasing now resolves to
`plan-task`, and the real adaptive supervisor's resulting 5-step plan
(`analyze-project`, `scan-secrets`, `audit-dependencies`, `git-status`,
`check-coverage`) genuinely covers both the testing and security
concerns in one run — `check-coverage`'s own Tier 1 approval gate was
exercised and approved for real, completing successfully. **Disclosed
honestly, not smoothed over**: this is a prompt-level fix, not a hard
code rule — both the router's classification and the supervisor's own
step choices are real model judgments and can vary run to run, the same
non-determinism this router's own `specs/065` verification record
already documented.

See specs/089-plan-step-skip-continue/verification.md for the relocated narrative covering this checkpoint.
