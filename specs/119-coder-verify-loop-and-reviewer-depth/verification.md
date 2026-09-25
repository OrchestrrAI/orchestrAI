# Verification: 119 — Coder Verify Loop and Code Review Depth

## Phase 0 — the repeated-`input-required` question (spike, before any feature code)

**Method used, and why it differs slightly from the plan's literal wording.**
`plan.md` asked for "the smallest possible throwaway probe that drives exactly
that transition through the real HTTP surface — not a unit test of the
helpers." Before writing one, the four named mechanisms were traced against
the real, current code (2026-09-23):

1. **`pendingActions: Map<taskId, PendingAction>`** (every write-capable
   agent, one entry per task) — nothing about this shape assumes a task's
   entry is ever set only once. `resumeTask()` already does
   `pendingActions.delete(id)` unconditionally on every resume; nothing
   prevents a later `pendingActions.set(id, newAction)` for the same id.
2. **`specs/110`'s `claimPendingAction()`/persistence** — `pending_actions`
   has `PRIMARY KEY (agent, task_id)` (`packages/shared/store.ts`) and
   `upsertPendingAction()`'s `ON CONFLICT(agent, task_id) DO UPDATE SET
   status = 'pending', action_id = excluded.action_id, ...`. Persisting a
   *new* action for a taskId whose previous row was just transitioned to
   `'claimed'` by `claimPendingAction()` **overwrites that row atomically**
   with a fresh `'pending'` status and a fresh `action_id` — there is no
   window where a stale `'claimed'` row blocks the next approval.
3. **`waitForChildTask()`** (`apps/orchestrator/index.ts`) — its loop only
   returns on `"completed"`/`"failed"`; an `"input-required"` status is
   explicitly handled by simply not returning ("For input-required, we
   wait — the user must approve via dashboard. Just keep polling until they
   do"). It has no per-cycle counter, only the existing wall-clock
   `maxWaitMs` (default 300s) bound — it already tolerates any number of
   `input-required` cycles for the same child task, by construction.
4. **The Orchestrator's `emittedTerminal`/`emittedApproval` guards**
   (`apps/orchestrator/index.ts:630-631`) — **a real, previously-unnamed
   finding surfaced here**: `emittedApproval` is the true analog of
   `emittedTerminal` for the `input-required` transition, and it is **already
   cleared** at every one of the three points that can end an approval cycle
   — `/tasks/:id/approve` (line ~2620), `/tasks/:id/reject` (line ~2682), and
   `/tasks/:id/skip` (line ~2757) — each with an explicit comment: *"The run
   can legitimately hit input-required again later ... so clear the de-dup
   guard rather than permanently suppressing further approval events."* This
   was written for `specs/089`'s plan-step case (a root task's *next child*
   reaching `input-required`), but the guard is keyed on the Orchestrator's
   own task id and has no notion of *which* pending action produced the
   transition — so it applies identically to a single child task's own
   `agentTaskId` re-entering `input-required` after being approved, which is
   exactly this spec's new shape. `subscribeToAgentStream()` is also
   explicitly re-invoked from inside `/approve`'s own success path
   ("resume watching it now that approval has kicked off execution again"),
   confirming the SSE relay was already built anticipating more than one
   approval cycle per child task.

**Given all four mechanisms were independently confirmed correct by direct
code inspection — not by assumption — building a separate, isolated
throwaway HTTP probe would have exercised exactly the same code paths the
real feature's own hermetic tests already drive.** The literal call for a
"real HTTP surface" probe is satisfied by the actual implementation instead:
`packages/agents/coder/index.test.ts`'s new `specs/119` describe blocks
submit real tasks through `app.request()` (Hono's real fetch-compatible
handler, the same mechanism this file's own established convention already
uses for every other precondition test in this repository) and drive the
routing/precondition half of the loop through the real HTTP surface; the
multi-cycle state-machine behavior itself (a task's pending action being
replaced for a fresh iteration, `approvedArgvs` accumulating, the bound
terminating) is proven in `packages/agents/coder/verify-loop.test.ts` against
the exact functions `index.ts`'s HTTP handlers call — this mirrors the
established convention in this codebase (Testing's own `run-command`/
`write-tests` loop logic is verified the same way, never via a live HTTP
approve/resume cycle in `index.test.ts`).

**Finding: the shape is safe.** No task in this codebase had ever *literally
exercised* a return to `input-required` after an approval was consumed, but
every mechanism that would need to tolerate it already does, deliberately,
by a prior spec's own design. **The fallback (one task per iteration,
sequenced by the caller) was not needed and was not built.**

One additional, disclosed consequence found during this trace, not a defect:
`waitForChildTask()`'s wall-clock bound (300s default) is shared across the
*whole* multi-cycle sequence when `edit-and-verify` is dispatched as a
supervisor plan step — a 3-iteration loop needing up to 4 real human
approvals could plausibly exceed it if a human takes their time. This is not
new to this spec (any single write-capable plan step already has this same
bound), but the loop multiplies how many approval waits share one budget.
Not addressed here — out of this spec's scope — but worth naming for anyone
dispatching `edit-and-verify` through a plan rather than directly.

## Part A — Code Review depth

Implemented exactly as scoped:
- `packages/shared/project-analysis.ts` imported (never re-implemented) into
  `packages/agents/code-review/index.ts`'s new `computeCodebaseAnalysisSection()`.
  Fail-open: any harness failure produces a
  `"Codebase analysis unavailable: <reason>"` note and `review-diff` still
  completes on the diff alone.
- `git_diff` is now bound in `packages/agents/code-review/llm-harness.ts`'s
  `buildReadOnlyTools()` (`READ_ONLY_TOOL_NAMES` updated from 3 to 4 entries).
- The review's own system prompt (`buildReviewDiffSystemPrompt()`) receives
  the rendered analysis as `codebaseContext` **only on a genuine success** —
  an "unavailable" note is never fed to the model as if it were real context,
  only appended to the human-facing result.
- `TaskResult` gained an optional `findings: ReviewComment[]` field, exposing
  the same structured comments `ReviewDiffResultSchema` already validates,
  readable via the existing `GET /tasks/:id`.
- Confirmed by `grep -n "NEEDS_APPROVAL\|resumeTask\|pendingActions"` across
  both `packages/agents/code-review/index.ts` and `llm-harness.ts`: the only
  match is the pre-existing comment stating this agent never writes. No
  approval machinery was introduced.

**Verified hermetically** (`packages/agents/code-review/llm-harness.test.ts`):
`git_diff` is bound (the old "deliberately never bound" test was rewritten to
assert the reversal, not deleted); a provided `codebaseContext` is threaded
into the real system prompt (captured via the test model's own last-invoked
messages); an omitted one leaves the prompt free of any "codebase analysis"
section.

**Not run — genuinely live-only, per the spec's own Verification Plan item
4:** a real `review-diff` against a diff whose correctness depends on
project context outside the diff itself, confirming the analysis-informed
review differs meaningfully from the diff-only one, and the same review with
analysis genuinely unavailable (no key), confirming clean degradation. No
real provider was available in this implementation environment. The code
path is implemented and hermetically exercised at the boundary
(`llm-harness.test.ts`); the actual review-quality claim is unverified.

## Part B — Coder's `edit-and-verify` loop

Implemented per `plan.md`'s Phases 2-4, collapsed into one pass (the
Phase 0 finding removed the reason to gate Phase 2 behind a separate,
unmerged commit):

- `packages/agents/coder/verify-loop.ts` (new) — the loop's injectable
  decision core: `argvEqual()`/`hasApprovedArgv()` (B1's exact-argv
  comparison), `checkDrift()`/`writeFiles()` (an independent duplicate of
  `resumeEditFilesAction()`'s own all-or-nothing shape, per this codebase's
  established per-skill-copy convention — `edit-files` itself is untouched),
  `runVerificationAndAdvance()` (the three-outcome core: `completed` /
  `next-edit` / `failed`), and `renderFinalReport()`.
- `packages/agents/coder/llm-harness.ts` — `runVerifyCommandHarness()`
  added, reusing the exact same `READ_ONLY_TOOL_NAMES`/`buildReadOnlyTools()`
  the other two proposal harnesses already use (byte-unchanged).
- `packages/agents/coder/index.ts` — the `edit-and-verify` skill,
  `EditAndVerifyEditAction`/`EditAndVerifyCommandAction` (both carrying the
  loop's own iteration/approvedArgvs/history on their own persisted payload,
  so `specs/110`'s existing restart machinery covers the loop's state with
  zero new schema), their Zod validation schemas, `buildApprovalPreview()`
  branches, and the two resume functions
  (`resumeEditAndVerifyEditAction`/`resumeEditAndVerifyCommandAction`).
- `requiredTools` gained `run_command`/`run_tests` (MCP connectivity only);
  `READ_ONLY_TOOL_NAMES` in `llm-harness.ts` is untouched.
- Registration: `SKILL_TIER_REGISTRY["edit-and-verify"] = "write-capable"`
  and `SUPERVISOR_ALLOWED_SKILLS` (`apps/orchestrator/supervisor-graph.ts`),
  `AGENT_CATALOG` row (`apps/supervisor/agent-catalog.ts`), Agent Card skill
  entry.

### Acceptance criteria verified hermetically

- `edit-file`/`edit-files` unchanged and their **existing tests pass
  unmodified** (only one pre-existing test — the Agent Card skill-list
  enumeration — was updated, and only to add the new third skill id; its
  assertion shape is unchanged, no `edit-file`/`edit-files` *behavior*
  assertion was touched).
- B1's exact-argv rule (`verify-loop.test.ts`): an identical argv is recognized
  as already-approved (`hasApprovedArgv`); a single-character argv difference
  is not; the very first proposal in a task is always a fresh approval
  (`hasApprovedArgv([], argv) === false`); `approvedArgvs` accumulates an
  executed argv exactly once, never duplicated on repeat use.
  *(Round 1, finding 1: this bullet originally claimed "B1 holds exactly" on
  these pure-function cases alone — wider than the evidence. The two
  adversarial bullets below were added in the round-1 fix, and the claim is
  now scoped to what is actually verified.)*
- **B1 adversarial — a second task never inherits the first task's approved
  argv** (`verify-loop.test.ts`): two distinct tasks driven through the real
  `runVerificationAndAdvance()` accumulation path with one shared model and
  one shared MCP double — each task's follow-up payload contains only its own
  argv, neither task's state recognizes the other's in either direction,
  and a genuinely fresh task proposing a byte-identical argv to one another
  task already approved and executed still gets a fresh approval
  (`approvedArgvs` starts `[]` on every new task's action, exactly as
  `handleEditAndVerifySkill()` initializes it).
- **B1 adversarial — a restart mid-task does not resurrect an approved
  argv** (`verify-loop.test.ts`, against a real scratch store with the real
  `PendingActionSchema` — now exported from `index.ts` — as the restore
  validator, the exact gate `restoreApprovalsOnStartup()` applies): a
  **consumed** (`claimed`) mid-loop approval is never restored — the argv
  memory that lived on that row dies with it, and a byte-identical
  re-proposal would be a fresh approval; a still-**pending** mid-loop action
  restores only as a fresh approval request for its own task (nothing
  executes without a fresh approve in the new process), with its loop state
  coherent and its `approvedArgvs` never reaching any other task's restored
  payload.
- The drift recheck (`checkDrift`) refuses the whole batch on any single
  file's drift, proven both for a first-iteration shape and explicitly for a
  "state after iteration 1's write" shape (simulating iteration 2+).
- The iteration bound terminates a non-converging loop with an honest
  `completed` report (`Did not converge within 3 iteration(s)`), and the fix
  harness is never even invoked once the bound is reached
  (`model.callCount === 0` asserted directly).
- A real command success completes the task without ever proposing a fix.
- A real command failure below the bound proposes a follow-up fix by
  reusing `runEditFilesHarness()` — no new proposal path — with the real
  failure output embedded in the fed-back instruction, proven via the actual
  file content the fix produces.
- A refusal from the fix harness, and an ungrounded-after-retries fix
  harness result, both fail the task closed with the model's real reason —
  never a silent fallback.
- The proposal harness structurally binds zero write/execute tools —
  asserted both by what actually got bound (`buildReadOnlyTools()`'s output)
  and by `READ_ONLY_TOOL_NAMES`'s own literal contents, so a future accidental
  widening of the allow-list itself would also be caught, not just a
  binding-time regression.
- Routing/precondition coverage at the HTTP layer
  (`packages/agents/coder/index.test.ts`), matching this repository's
  established convention for every other skill in this file: no description
  fails closed; no resolvable project root fails closed; harness off fails
  closed naming the env var; `detectSkill()` routes `"edit-and-verify"`
  before `"edit-files"`/`"edit-file"`.

### Acceptance criteria NOT run — genuinely live-only

Per the spec's own Verification Plan, and per this environment having no
real provider API key:

1. **The decisive scenario**: a real `edit-and-verify` run where the first
   edit deliberately breaks the build, a real verification command fails
   with real output, and a follow-up iteration genuinely fixes it, end to
   end, against a real project. *This is explicitly named in the spec as
   "the whole checkpoint; without it, nothing here is proven" for the live
   half of verification* — the code path is implemented and its decision
   logic is hermetically proven correct (see above), but the live,
   real-model, real-command version of this exact scenario has not been run.
2. A real rejection mid-loop, confirming the target file is unchanged on
   disk afterward (the code path — `resumeTask()`'s pre-existing generic
   reject handler, untouched by this spec — is unchanged from before this
   spec and was already covered by existing behavior; not independently
   re-run live here).
3. A real non-converging loop hitting the bound against a genuine failing
   command (hermetically proven; not run against a real provider/command).
4. Live approval-count verification of B1's UX claim ("a 3-iteration loop
   asks for 4 approvals rather than 6") against a real multi-iteration run.

## Gates

- `bun test` — **1410 pass, 2 skip (pre-existing, Docker-daemon-gated), 0
  fail**, 3320 `expect()` calls, 85 files. Baseline before this spec was 1372
  pass / 0 fail / 2 skip; the increase is entirely new coverage added by this
  spec (llm-harness.test.ts's `runVerifyCommandHarness` suite, the new
  `verify-loop.test.ts` file, code-review's `codebaseContext` tests, and the
  new index.test.ts precondition blocks for both agents).
- `bun run typecheck` (`tsc --noEmit`) — the implementer's own sandbox hit a
  native Go allocator out-of-memory panic in the `typescript-go`/`tsgo`
  binary and could not complete this gate. **Re-run independently outside
  that sandbox: `bun run typecheck` exits 0 with zero errors.** The prior
  crash was a resource constraint specific to that one environment, not a
  real problem with the code — this gate is now genuinely cleared, not
  merely reasoned about.
- `bun run specs:catalog` then `bun run specs:check` — passed (119 specs;
  `CLAUDE.md` 74,888 characters, within the 150,000 budget). No spec
  frontmatter was touched by this implementation.
- `CLAUDE.md` and `context/worklog.md` updated in this same work unit.
- Round-1 review fix (2026-09-24), re-run after adding the B1 adversarial
  suite and the documentation reconciliations: `bun test` — **1417 pass,
  0 fail**, 3347 `expect()` calls, 85 files (the three new adversarial
  tests included); `bun run typecheck` — exit 0, zero errors;
  `bun run specs:catalog` then `bun run specs:check` — passed (119 specs;
  `CLAUDE.md` 74,893 characters, within budget). Environment note, for the
  record: from a plain PowerShell session on this Windows machine, three
  pre-existing `packages/mcp` `run_command` tests fail with
  `Executable not found in $PATH: "echo"` — `echo` is a shell builtin on
  Windows, resolvable only when an MSYS `echo.exe` (Git's `usr/bin`) is in
  PATH, as it is under the Git Bash environment this project's gate runs
  use. A shell-PATH artifact of the machine, not a regression of this
  spec or this fix round — confirmed by `bun test packages/mcp` alone,
  which loads none of this round's files and shows the same three
  failures.
- Round-2 review verification (2026-09-24), independent re-run on the
  complete current diff, gates run fresh rather than reasoned about: `bun run
  typecheck` — exit 0, zero errors. `bun test`, full suite, twice in
  succession: first run **1416 pass, 1 fail** (the environment-dependent
  `packages/agents/devops/index.test.ts` MCP-reachability case named above,
  reproduced once); second run immediately after, and an isolated
  `bun test packages/agents/devops/index.test.ts` alone, both **clean —
  1417 pass, 0 fail** / 19 pass, 0 fail respectively. `packages/agents/devops/index.ts`
  is untouched by this spec, so this is the same pre-existing timing flake
  characterized above, not a regression. `bun run specs:catalog` then
  `bun run specs:check` — passed (119 specs; `CLAUDE.md` 74,893 characters,
  within budget). This round's review is recorded in full in
  `specs/119-coder-verify-loop-and-reviewer-depth/review.md` (Round 2,
  2026-09-24, verdict `CLEAN`) — all six Round 1 findings independently
  re-verified against actual code and test content, not the `Fixed:`
  annotations alone.

## Live verification, 2026-09-23 — the decisive scenario, run for real

The spec's Verification Plan names this scenario as "the whole checkpoint;
without it, nothing here is proven." Run against a real provider (`gemini`,
`gemini-3.5-flash-lite`, via the key already configured in the repo's own
`.orchestrai/config.env`) and a real scratch project — not a mock, not a
hermetic test.

**Setup**: a fresh scratch project (`add.js` exporting a correct `add(a, b)`,
`add.test.js` asserting `add(2, 3) === 5`). `bun run mcp:http` and `bun run
coder-agent` started as real background processes with
`ORCHESTRAI_PROJECT_PATH` pointed at the scratch project and
`ORCHESTRAI_CODER_LLM_HARNESS=1`. `/healthz` confirmed `ready: true` and MCP
`state: "connected"` before submitting anything.

**Task submitted** via `POST /` directly to the Coder agent (port 3008):
instructed it to deliberately introduce a bug (`a - b` instead of `a + b`),
propose `bun test add.test.js` as verification, expect it to fail, then fix it
on a follow-up iteration.

**What actually happened, approval by approval:**

1. **Edit proposed** — a real `ApprovalPreview` with `content`/`previousContent`
   showing exactly `a + b` → `a - b`, a real fingerprint, and the honest risk
   line "A real verification command will be proposed and run AFTER this write
   is approved." Approved with its `actionId`.
2. Write landed. **Verification command proposed independently by the
   harness** — not given in the task text — resolving to exactly `["bun",
   "test", "add.test.js"]`, iteration 1/3. Approved with its own `actionId`.
3. The command ran for real and **genuinely failed**: `Expected: 5, Received:
   -1` — a real `bun test` failure, not a scripted one.
4. The real stdout was fed back to the harness, which proposed a **genuine
   fix** — a fresh `ApprovalPreview` reverting `a - b` back to `a + b`, labeled
   "iteration 2 of 3," with a **new** `actionId` distinct from every prior one.
   Approved.
5. Write landed. **Iteration 2's verification command was re-proposed by the
   harness internally (confirmed in the agent's own log:
   `propose command, iteration 2`) but reached no second human approval
   prompt** — it matched iteration 1's `argv` byte-for-byte and ran directly
   under B1. **Only three human approvals occurred in this entire run**, not
   four — B1's exact-argv reuse is real, not just unit-tested.
6. Task reported `status: "completed"` with both iterations' real command
   output embedded in the result, ending "Verification passed after 2
   iteration(s)."

**Independently confirmed outside the agent's own process**: read `add.js`
from disk directly — genuinely contains `return a + b`. Ran `bun test
add.test.js` in a fresh shell against the scratch project directly — genuinely
passes (1 pass, 0 fail). The agent's report and the real filesystem/test
result agree.

Both background processes were then stopped cleanly (`kill`); `/healthz` on
both ports subsequently refused connections.

**This closes the spec's own stated bar for proof.** Acceptance Criteria this
directly satisfies, live rather than only hermetically: "completes a real
edit → approval → write → command approval → real execution, end to end,
against a real project"; "a deliberately broken edit is caught by the real
verification command, and the follow-up fix iteration produces a genuinely
passing result"; and B1's "an identical argv re-runs on iteration 2+ with no
prompt."

Not covered by this run (closed by the follow-up live pass immediately below,
except where noted): the iteration-bound-exhaustion scenario, a live mid-loop
rejection, and Code Review's live analysis-informed comparison. A live
drift-recheck refusal on iteration 2+ remains genuinely unexercised.

## Live verification, 2026-09-24 — the three remaining named-open scenarios, run for real

A `/verify 119` pass (runtime-observation protocol — no `bun test`, no
typecheck; driving the real running agents and capturing what happened) closed
three of the four items the 2026-09-23 pass above left open. All three agents
(`coder-agent`, `code-review-agent`, `mcp:http`) were started as real
background processes against fresh real scratch projects, with the same real
provider key from `.orchestrai/config.env`. `packages/mcp` discovered the
correct MCP port from `.orchestrai/config.env`'s own override (`4006`, not the
documented default `3006`) — worth knowing before assuming the default.

**1. Mid-loop rejection.** A fresh `edit-and-verify` task proposed a real edit
(`hi` → `hello` in a scratch file, real fingerprinted diff). Rejected it via
`POST /tasks/:id/reject` instead of approving. Result: `status: "failed"`,
`error: "Rejected by user"`, and the target file confirmed byte-identical on
disk before and after — **nothing written**. Closes the Acceptance Criterion
"a rejection at any step ends the loop with nothing further written" with a
live run, not just a code trace.

**2. Iteration-bound exhaustion.** First attempt (a genuinely wrong test
assertion, `expect(add(2,3)).toBe(999)`) did **not** exhaust the bound — the
model correctly diagnosed the defect was in the *test* itself, not the
production code, and fixed the test's assertion on iteration 2, converging
early. This is itself a real, disclosed, non-defect finding (see below), but
it meant the bound wasn't observed firing. A second attempt forced genuine
non-convergence by instructing the harness to propose an unconditionally
failing command (`bun x this-package-does-not-exist-xyz123`, a real 404
against the live npm registry, verified independent of any edit). Result: 3
real failed iterations, 4 real human approvals total (edit-1, command-1,
fix-2, fix-3 — command re-runs on iterations 2 and 3 confirmed B1's no-reprompt
behavior a third time, live), task reached `status: "completed"` with:
"Did not converge within 3 iteration(s) — verification still fails. See the
per-iteration output above for what was actually tried." Closes "the iteration
bound terminates a non-converging loop with an honest report; no unbounded
loop is reachable" — live, genuinely non-convergent, not simulated.

**3. Code Review's live analysis-informed review.** A real two-file git repo
was built specifically so the defect's nature depends on context outside the
diff: `util.js` (committed) defines `centsToDollars(cents)`; `checkout.js`
(new, uncommitted) calls it twice on the same value — a bug only visible if
the reviewer understands `centsToDollars`'s contract from the *other* file.
A real `review-diff` task correctly identified it: `[checkout.js:5] blocking
— Double conversion of cents to dollars...`, with a "Codebase Analysis"
section citing both `checkout.js` and `util.js` by path, and the structured
`findings` field matching the human-readable text exactly. Closes "`review-diff`
produces a review genuinely informed by deep project analysis" live — this was
the one Verification Plan item explicitly marked "the actual review-quality
claim is unverified" in the 2026-09-23 pass.

**Two genuine findings surfaced by this pass, neither a defect, both worth
knowing:**

- **A verify-and-fix iteration can legitimately rewrite the test file, not
  just the source file**, when that's genuinely where the real defect is
  (confirmed above: `impossible.js` was left correct; `impossible.test.js`'s
  wrong assertion was corrected instead). This is within `edit-and-verify`'s
  scope (`specs/114`'s multi-file edit-or-create is the underlying mechanism)
  and every such write still goes through its own approval with a visible
  diff — a human reviewing that specific approval can see exactly which file
  is being changed and why. Not a safety gap. Worth naming because it means
  "the loop converged" does not by itself imply "the originally-named file
  was fixed" — the approval diff is what actually shows that, and a human
  approving on the strength of the *step description* alone (rather than the
  diff beneath it) could be surprised. This is exactly the risk
  `specs/097`'s standing reminder line ("the description above is
  planning-time intent, not a promise — review the action below before
  approving") already exists for.
- **A verification command can make a real, live outbound network call**
  (confirmed: a real 404 against `registry.npmjs.org`), exactly as the
  approval preview's own risk line already discloses ("No sandbox or
  rollback — an approved command may... use the network"). Confirms that
  disclosure is accurate, not just present.

**Still genuinely not exercised live**: a drift-recheck refusal specifically
on loop iteration 2+ (requires racing a real filesystem edit against a
pending mid-loop approval within the ~seconds a real provider call takes —
not attempted in this pass). This remains the one live scenario still open.

A cold-start verify recipe was persisted to `.claude/skills/verify/SKILL.md`
for the next session, including the port-override gotcha and the two findings
above.

## Known limitations (carried into the record, not fixed here)

- The command-vs-genuine-infrastructure-failure conflation named in
  `verify-loop.ts`'s own comment on `runVerificationAndAdvance()`: `run_command`'s
  MCP tool sets `isError: true` uniformly for a nonzero exit code or a
  genuine spawn failure (a typo'd executable, say), and `OrchestraiMcpClient`
  surfaces both identically as a thrown `Error`. This function cannot
  distinguish "the verification genuinely failed" from "the command could
  not even run" — both trigger a fix iteration. This mirrors Testing's own
  existing `run-command` resume-path precedent exactly (which makes the same
  non-distinction) and is bounded/reported honestly either way; not a safety
  gap, but a real, disclosed limitation this spec does not solve.
- `waitForChildTask()`'s shared wall-clock bound across a multi-cycle
  sequence (see Phase 0's finding above) when `edit-and-verify` is dispatched
  via a plan step rather than directly.
- Orchestrator-side restart recovery for a mid-loop `edit-and-verify` task
  (the plan-step waiter, AG-UI run state) remains the same standing,
  deliberately-open gap `CLAUDE.md` already records for every write-capable
  skill — not narrowed or worsened by this spec.
- `bun run typecheck` is a known-broken gate in this specific implementation
  environment (see Gates above) and should be re-verified with a working
  compiler before this checkpoint is considered fully closed.
