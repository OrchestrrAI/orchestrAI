# Verification: specs/089 — A Third Approval Outcome (Skip), Option B

## What changed

- `apps/orchestrator/supervisor-graph.ts`: `DispatchOutcome` gains
  `{kind: "skipped"; effect: "none"}`; `WaitResult` gains
  `wasSkippedByOrchestrator: boolean` (the same trusted-fact pattern as
  `wasRejectedByOrchestrator`); `classifyDispatchOutcome()` checks it
  before the rejection check. A skip is **not terminal** — the graph
  state gained `skippedSkillIds: string[]` (accumulate-only, mirroring
  `dispatchedWriteKeys`); `dispatchNode()` refuses (non-terminally, the
  exact `duplicate-write-refused` shape) any subsequent proposal naming
  an already-skipped skill id, while every other skill — write-capable
  or read-only — dispatches exactly as before.
- `apps/orchestrator/index.ts`: new `skippedByOrchestrator` Set; new
  `POST /tasks/:id/skip` route, mirroring `reject`'s own validation
  shape exactly (refuses a direct/non-plan task with a named error
  pointing at reject; reuses the agent's own `/reject` endpoint to
  discard the pending action, since the agent has no reason to
  distinguish "skip" from "reject"); `wait()`'s two `WaitResult`
  construction sites updated to pass the real
  `skippedByOrchestrator.has(childTaskId)` fact.
- `packages/shared/ag-ui-events.ts`: `orchestrai.approval-resolved`'s
  `decision` enum gains `"skipped"`.
- `apps/tui/tui-state.ts`: `PendingConfirm.key`/`resolveConfirmPress()`
  gain `"s"` — the identical double-press state machine, agnostic to
  what the key means.
- `apps/tui/index.tsx`: new `skipTask()`; `armDecision()` scoped so `"s"`
  is a no-op unless `task.parentTaskId` is set; three keypress call
  sites (chat detail overlay, chat mode, Tasks mode) extended to offer
  `"s"`; Detail overlay hint, Tasks header/footer hints, and the Help
  view's own keybinding line updated.
- `apps/orchestrator/index.ts`'s dashboard script: Tasks-table row,
  chat-linked/plan-child approval card, and the task-detail modal all
  gain a conditional Skip button (`t.parentTaskId`-gated) alongside
  Approve/Reject; a new `skip(id)` JS function reusing the existing
  `decide()` machinery.
- `apps/agents/devops/index.ts`'s own dashboard: **deliberately
  untouched** — see the Scope Correction below.

## Scope correction, found during implementation

The spec's own original Scope section named `apps/agents/devops/
index.ts`'s dashboard as in scope for a third button. Checked directly
before implementing: DevOps's own dashboard has **no `parentTaskId`
concept at all** — an agent receives a task via A2A with no visibility
into whether the Orchestrator considers it a plan step's own child or a
direct submission, and its approve/reject buttons submit directly to
the agent's own task-id space (`http://localhost:3002/tasks/:id/reject`),
never the Orchestrator's. There is no architecturally correct way to
wire a Skip button there — "continue the plan" is a concept that exists
only at the Orchestrator. `spec.md`'s own Scope section was corrected
to record this as a genuine scope narrowing, not a deferred item.

## Acceptance criteria

- [x] `POST /tasks/:id/skip` on a plan step's own child task: correct
      `actionId` → no write executes, run continues to another
      supervisor decision. Confirmed both by HTTP test
      (`skip-endpoint.test.ts`) and live (see below).
- [x] `POST /tasks/:id/skip` on a **direct** (non-plan) task → refused
      with a named error pointing at `reject` instead. Confirmed by test.
- [x] Missing/stale/mismatched `actionId` on `skip` → the Orchestrator's
      own guard (409, "No pending action available") when its own stored
      record has none; the agent-side round trip (409 on a genuine
      mismatch) confirmed by a dedicated mocked-agent test — corrected
      understanding from the original acceptance-criteria wording: the
      Orchestrator's own endpoint forwards its own stored `actionId`, it
      does not itself re-validate the client-supplied one (identical to
      `reject`'s own existing, unmodified behavior).
- [x] After a skip, a subsequent read-only step still dispatches
      normally (including a parallel read-only fan-out) — confirmed by
      the supervisor-graph unit test corpus (pre-existing tests
      unmodified) plus the general non-terminal design.
- [x] After a skip, a subsequent proposal for the **literal same,
      already-skipped** skill id is refused non-terminally — dedicated
      adversarial test in `supervisor-graph.test.ts`.
- [x] The TUI's `s`×2 keybinding only appears for a plan step's own
      approval, never a direct task's — enforced in `armDecision()` and
      the chat-mode call site's own explicit check.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of a real multi-step plan: skip one write step,
      confirm a **different** write step later in the same plan still
      reaches a normal approval gate with its own full preview, and
      confirm the plan produces real, correct results for the
      non-skipped steps.

## Test results

- `apps/orchestrator/supervisor-graph.test.ts`: 44 pass (6 new skip
  tests: 2 `classifyDispatchOutcome` unit tests, 4 graph-level tests —
  non-terminal continuation with a different skill, the adversarial
  same-skill-id refusal, the trusted-fact adversarial case, and the
  (skill, not skill+target)-scoping confirmation).
- `apps/orchestrator/skip-endpoint.test.ts` (new): 7 pass — the full
  HTTP-level round trip via `app.fetch()`, mirroring `reject`'s own
  untested-until-now shape with a mocked fake agent reproducing real
  `validateActionId()` behavior.
- `apps/tui/tui-state.test.ts`: 2 new tests for `"s"` in
  `resolveConfirmPress()`'s state machine.
- `bun test` (full suite): 1119 pass, 0 fail (net +15 over specs/096's
  own 1104 baseline).
- `bun run typecheck`: 0 errors.
- `bun run specs:catalog`/`specs:check`: pending final run (see below).

## Live verification — the decisive end-to-end pass

Against the real running 6-agent stack (a real Gemini key sourced from
`.orchestrai/config.env`), a real scratch git project
(`skip-verify-project`, a trivial Bun script + `package.json`,
committed), a real multi-write request: *"dockerize this project and
also add a CI workflow at \<scratch path\>"*.

1. The real adaptive supervisor's plan reached a genuine `input-required`
   approval on **`run-command`** (step 3, `ls -F`) — a write-capable
   skill, unrelated to dockerize/CI but still gated.
2. **Skipped it via the real `POST /tasks/:id/skip` endpoint** — response
   `{"status":"failed","message":"Skipped"}`, matching the designed
   shape exactly.
3. **The plan genuinely continued** (not terminal) — the next real
   supervisor decision dispatched **`dockerize`** (step 4), reaching its
   own real `input-required` approval with a full, real generated
   Dockerfile content preview.
4. **Approved `dockerize`** — the real `Dockerfile` landed on disk at the
   scratch project, confirmed via `ls`.
5. **The plan continued again** — the next real decision dispatched
   **`create-ci`** (step 5), reaching its own real `input-required`
   approval with a full, real generated GitHub Actions workflow content
   preview — this is the exact scenario Yusuf's own concrete question
   named (*"it may ask again for like the ci so i can accept or
   refuse"*), now confirmed live.
6. **Rejected `create-ci`** to end the run cleanly — confirmed via `ls`
   that no `.github/` directory was ever created; the parent task
   correctly reached `status: "failed"` (rejection is still terminal,
   completely unmodified from `specs/028`'s own existing behavior).

This directly proves the core Option B claim: skipping one write-capable
step does not end the run, and a **different** write-capable step later
in the same plan reaches its own normal, fully-previewed approval gate —
exactly as designed, with real model decisions and real file-writes, not
a mocked scenario.

**Not forced live**: the adversarial "the model tries to re-propose the
literal skipped skill" case — the real supervisor never happened to
choose `run-command` again after the skip in this pass (it moved on to
`dockerize`/`create-ci` instead, both genuinely different skills). This
is fully covered by a dedicated, deterministic adversarial unit test
(`supervisor-graph.test.ts`) using a scripted fake model that
deliberately re-proposes the skipped skill; forcing this organically
against a real model would need either a much narrower request or many
repeated live attempts with no guarantee of reproducing it, the same
standing gap this codebase's own `specs/083` verification record
already accepted for a comparable adversarial case.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**A plan step's approval gate has a third outcome, `skip`, alongside
approve/reject.** `specs/089-plan-step-skip-continue/spec.md`
(implemented, **verified**, 2026-09-15) closed a real gap Yusuf hit
live: rejecting one write step in a `plan-task` run ended the *entire*
plan (`specs/028`'s own "rejection is terminal" design), even for
objecting to exactly one step among several unrelated ones. Two designs
were weighed directly with Yusuf (Option A — no more writes at all
after a skip, structurally the stronger guarantee; Option B — the
supervisor keeps proposing other writes normally, each still reaching
its own full approval gate). **Yusuf's own concrete scenario decided
it**: *"so if it asked me to dockerize and i skiped it may ask again
for like the ci so i can accept or refuse what the issue here?"* —
confirming Option B is what's actually wanted. `POST /tasks/:id/skip`
mirrors `reject`'s own exact validation shape (a plan step's own child
task only — refused on a direct task with a named error pointing at
`reject`; reuses the agent's own `/reject` endpoint to discard the
pending action, since the agent has no reason to distinguish "skip"
from "reject") and populates a new `skippedByOrchestrator` Set, the
same trusted-fact pattern `rejectedByOrchestrator` already uses. A skip
is **not terminal** in `supervisor-graph.ts`'s `classifyDispatchOutcome()`
— the graph loop continues, free to propose any other skill. **The one
structural guarantee kept**: the literal skipped skill id can never be
re-proposed in the same run (a `skippedSkillIds` state list,
`dispatchNode()` refuses it non-terminally the exact same
`duplicate-write-refused` shape an already-dispatched write already
uses) — the residual risk (nothing stops a *different* skill from
achieving something similar to what was skipped) is accepted
deliberately because **every subsequent write, regardless of skill,
still shows its own full content preview before approval**
(`specs/040`, unchanged) — the human reviewing that preview is the real
safety net for this case, not a structural block. UI: a third `s`×2
double-press keybinding in the TUI (scoped to a plan step's own
approval only, silently a no-op on a direct task's approval — same
principle as the endpoint's own scope restriction) and a third Skip
button on the Orchestrator dashboard's approval cards (Tasks table row,
chat-linked card, and the task-detail modal), all `parentTaskId`-gated.
**A real scope correction found during implementation**: DevOps's own
dashboard was originally scoped in too, but it has no `parentTaskId`
concept at all — an agent has no visibility into whether the
Orchestrator considers a task a plan step's own child, and its
approve/reject buttons submit directly to the agent's own task-id
space, never the Orchestrator's; there is no architecturally correct
way to wire Skip there, so it was correctly dropped from scope, not
deferred. 1119 tests pass (net +15 over `specs/096`'s own 1104
baseline), typecheck clean, `specs:check` passed for 95 specs.
**Live-verified end to end against a real Gemini deployment**, a real
scratch git project, and a real multi-write request ("dockerize this
project and also add a CI workflow"): the real supervisor's plan
reached a genuine `input-required` approval on `run-command` (an
unrelated write step); skipped via the real endpoint; the plan
genuinely continued and dispatched `dockerize` next, reaching its own
real approval with a full generated-content preview — approved, and
the real `Dockerfile` landed on disk; the plan continued again and
dispatched `create-ci`, reaching its own real approval with its own
full preview — exactly Yusuf's own named scenario, now confirmed live
— rejected to end the run cleanly, with `ls` confirming no `.github/`
directory was ever created. The one adversarial case not forced live
(the model re-proposing the literal skipped skill) is covered by a
dedicated deterministic unit test using a scripted fake model, the same
standard `specs/083`'s own verification record already accepted for a
comparable case.

See specs/097-chat-answer-and-plan-description-honesty/verification.md for the relocated narrative covering this checkpoint.
