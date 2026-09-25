# Verification: Chat's "Why Did It Fail" Answer

## What changed

- `packages/shared/capability-router.ts`: `CapabilityRouterProposalSchema`'s
  `kind` enum gains `"failure-question"`; the system prompt teaches the
  router to recognize it. No new LLM call — this is the same single
  classification call already made for every request.
- `apps/orchestrator/ask-classifier.ts`: `StateIntent` gains `"failure"`;
  `classifyAsk()` maps the new kind to it.
- `apps/orchestrator/index.ts`: new `answerLastFailureFromState()` (walks
  `tasks` backward for the most recent `status === "failed"` task, returns
  its real `skill`/`assignedAgent`/`error` verbatim); `buildStateAnswer()`
  gains a `"failure"` branch calling it.
- `apps/orchestrator/keyword-router-fake.ts` (test seam): gained
  `FAILURE_QUESTION_PATTERNS`, checked *before* `STATE_QUESTION_PATTERNS`
  — load-bearing ordering, since a real phrase like "why did the last
  task fail" contains the substring "last task" and would otherwise
  misclassify as the generic state question.

## A real correction made during implementation

The spec's own draft assumed `buildStateAnswer()` would need the raw
question text threaded through from the `/ask` handler. Implementing it
showed this was unnecessary — the answer is always "the single most
recent failure," never disambiguated by the question's own wording (this
spec's own explicit Non-Goal). No signature change was needed; the spec
text was corrected to match the simpler, actual implementation.

## Unit-level

- `apps/orchestrator/ask-classifier.test.ts` — new case: `kind
  "failure-question"` classifies to `{tier: 0, stateIntent: "failure",
  reason: "state:failure"}`, zero dispatch.
- `apps/orchestrator/capability-router-detect-skill.test.ts` — new case
  confirming `POST /tasks`'s own routing is unaffected: `"failure-question"`
  falls through to `"plan-task"`, byte-identical to `"unsupported"`/
  `"conversation"` — proving `tryCapabilityRoute()`'s existing catch-all
  needed no code change, not just asserting it from reading the guard.
- `apps/orchestrator/ask-endpoint.test.ts` — new integration case: no
  failure yet → `"No recent task has failed."`; after a real dispatched
  task is marked failed with a specific error, a failure question returns
  that real error and the real skill/agent, and explicitly does **not**
  contain the generic roster+list's own `"most recent task"` heading.

`bun test`: **1087 pass, 0 fail** across 73 files (up from `090`'s 1084 —
3 new tests), confirmed stable across two consecutive full runs (one
single-run flake traced to a leftover port conflict from unrelated
manual live testing earlier in the session, not a real regression — the
immediate re-run was clean). `bun run typecheck` — 0 errors.

## Live re-verification

Restarted `orchestrator` (port 3000) with the fix — the user's own live
`orchestrai` process, restarted with their explicit go-ahead. Three real
checks against the live stack:

1. A real `write-tests` request with no reachable `testing-agent` failed
   with a genuine, specific error
   (`"Could not send task to agent: Unable to connect..."`). A follow-up
   `POST /ask {"question":"why did it fail last time?"}` returned:
   ```
   Most recent failure — write-tests (testing-agent):
   Could not send task to agent: Unable to connect. Is the computer able to access the url?
   ```
   `reason: "state:failure"` — the real fix, live-confirmed.
2. An ordinary `"what agents do you have?"` question, dispatched
   immediately after, returned the exact unchanged generic roster+
   recent-task-list answer (`reason: "state:question"`) — confirming the
   existing `"state"` path is untouched.
3. The identical `"why did it fail last time?"` text sent to `POST
   /tasks` (not `/ask`) correctly fell through to a real `plan-task`
   dispatch (`isPlan: true`), never short-circuiting — confirming
   `specs/091`'s own core safety claim live, not just by unit test. That
   plan reached a real `run-command` (`dir`) approval, which was rejected
   to close the check out cleanly without side effects.

## Acceptance criteria

- [x] `"why did it fail?"` / `"what went wrong?"`-shaped questions
      classify as `stateIntent: "failure"`.
- [x] The answer names the real most-recently-failed task's skill, agent,
      and actual error text.
- [x] No recent failure → `"No recent task has failed."`.
- [x] `POST /tasks`'s own routing is unaffected — unit-tested and
      live-confirmed.
- [x] Every pre-existing `"state-question"`/`"conversation"` test passes
      unmodified.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact scenario gets the actual failure reason
      back.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

- **Tier 0 — state.** Answerable from the Orchestrator's own live
  registry/task store (*"what agents do you have?"*). No dispatch, no
  network call. **`specs/091-chat-explain-last-failure/spec.md`
  (implemented, verified, 2026-09-15)** added a third state-question
  shape alongside capabilities/recent-tasks: *"why did it fail?"*/*"what
  went wrong?"* — live-caught, Yusuf hit this directly: two real
  follow-ups after a real plan failure both got the generic roster+list
  answer, never the actual error. One more closed `kind` value on the
  same single router call (`"failure-question"`, no new LLM call); a new
  `answerLastFailureFromState()` walks the task store backward for the
  most recent `status: "failed"` task and returns its real skill/agent/
  error verbatim. `POST /tasks`'s own routing needed zero code change —
  its existing catch-all already routes any unrecognized kind to
  `plan-task` — confirmed live, not just by unit test.

See specs/107-task-and-conversation-history/verification.md for the relocated narrative covering this checkpoint.
