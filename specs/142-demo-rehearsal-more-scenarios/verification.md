# specs/142 — verification

## Result

Implemented and verified on 2026-09-25, against a live isolated stack
(ports 5000–5008, no URL overrides; specs/141).

## Automated

- `scripts/ag-ui-demo.test.ts`, 13 tests:
  - `--groups` parsing: default `core`, `all` with and without
    `--allow-writes`, order and de-duplication, `real` needing the flag,
    unknown names;
  - the per-group timeout and an explicit override;
  - the copy exclusion rule;
  - the demo app's deliberate gaps;
  - **root `bun test` never runs the demo app's failing test**. Confirmed
    both ways: without `bunfig.toml` the probe failed, and with it the
    probe was skipped.
- typecheck 0; `bun test` 1656 pass / 0 fail.

## Live

- **Default (`core`), no `--project`:** passed 6/6 on a fresh copy of the
  demo app.
- **`--groups chat`:** passed 5/5.
  - `suggest-agents` answered the agents question.
  - The failure question was answered from state ("create-ci … rejected by
    the user").
  - `review-diff`, `audit-dependencies` and `document-api` each completed
    (the last as text, without asking for approval).
- **`--groups parallel`:** Dockerfile and CI waited together on different
  paths, `pending-batch` was eligible, and both were rejected via
  `approve-batch`.
- **`--groups safety`:**
  - the Coder edit preview was rejected and the file hash is unchanged;
  - the plan completed after 2 skipped steps;
  - `evil/miner:latest` was previewed as `oven/bun:1-slim`, then rejected.
- **`--groups all`** in one run: 15/15 passed (456 events), and the
  fingerprint is unchanged.
- **`--groups real --allow-writes`:** 9/9 passed on a temp copy through one
  `/ask` conversation:
  - analysis;
  - `src/inventory.test.ts` written;
  - `bun test` run, with the deliberate failure reported;
  - `edit-and-verify` fixed it in 1 iteration;
  - review;
  - Dockerfile, CI and compose written and re-validated;
  - a real image built (`#1 DONE`) and the container ✅ stayed running;
  - a real local commit;
  - a recap.
  The test image was removed afterwards.

## Deviations from the spec text (decided during verification)

- Chat 1–2: the spec said "no task dispatched". Routing is an LLM judgment,
  and it answered the agents question with the Orchestrator's own
  read-only `suggest-agents` task. The demo now accepts either a direct
  answer or a read-only task, and checks the outcome instead (the answer
  names the DevOps agent). `suggest-agents` has no tier-registry entry
  because it's the Orchestrator's own meta-skill (specs/051).
- Chat 5: `document-api` is registered write-capable because it *can*
  save. Returned as text, it must finish without asking for approval,
  which is exactly what the demo checks.
- Temp copies are named in lowercase (see below).

## Found during live verification

- **Runtime, not fixed here → specs/143 (draft):** the first real run's
  build failed (`invalid tag … must be lowercase`): the default image tag
  is the folder name unchanged. Worse, `build-image` and
  `verify-deployment` both ended `completed` even though Docker failed,
  because `safeExec()` returns failures as normal output. So the plan
  reported success and the chat recap claimed the image was built and
  verified. Until specs/143 lands, the demo:
  - names its copies in lowercase;
  - reads step 7's result text and fails on a Docker error.
- **Runtime, cosmetic:** `suggest-agents` lists the default ports
  (`:3002`, …) even when agents run on custom ports. Not fixed; noted for
  a later spec.

## Addendum (2026-09-25): parallel steps in the real story

At Yusuf's request ("if it's just change in the demo do it without spec"),
made as a script-only change with no new spec. The real story now has 10
steps and rehearses the two parallel moments shown on stage:
- **Step 2, parallel reads:** "in parallel, scan … for secrets, audit its
  dependencies, and check its .gitignore coverage". It passes only if at
  least 2 steps ran at once. That's measured from the AG-UI stream by
  `maxConcurrentSteps()` (a STEP_STARTED arriving before a STEP_FINISHED).
  Any approval request fails the step.
- **Step 7, parallel writes with the grouped review:** Dockerfile, CI and
  compose "in parallel". The demo waits until no write step is still
  preparing its preview (up to 90 s), then approves every branch in one
  `approve-batch` call, the same call as the TUI's `g` → `y y`. If the
  batch isn't eligible, it approves one by one and says so.

Live: the first run grouped only 2 files, because the Dockerfile's
preview was still being written when the demo checked after a fixed 3 s.
That led to the wait-until-settled change, which is also the stage advice:
press `g` once every file shows as waiting. The final run passed 10/10:
- 3 read-only checks ran at the same time;
- all 3 files were approved in one grouped review;
- the Docker step was skipped because the daemon was down (the build
  itself was verified in the specs/143 runs).

Unit: `maxConcurrentSteps()` covers overlap, strictly sequential steps,
and other plans' events.
