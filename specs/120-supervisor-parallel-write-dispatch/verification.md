# Verification: 120 — Parallel Write Dispatch with Grouped Approval Over Disjoint Targets

## Phase 0 — does organic multi-write fan-out actually happen? (decisive finding)

**Finding: yes, and reliably.** Run live, twice, against a real provider
(`gemini`/`gemini-3.5-flash-lite`, the key already configured in this repo's
`.orchestrai/config.env`) and a real DevOps agent, with only Phase 1's gate
change applied (`buildSystemPrompt()`'s widened invitation and `dispatchNode()`
admitting write-capable batches):

- **First attempt**: `POST /tasks` with `"Set up this repo for a clean
  open-source release: add a .gitignore for a bun project, and add a GitHub
  Actions CI workflow that runs bun test. These are independent — do both."`
  The model organically named both `create-gitignore` and `create-ci` in one
  turn on the **very first try** — no prompt tuning needed at all. Both
  children were created within 1ms of each other
  (`createdAt: "...08.493Z"`/`"...08.494Z"`), both reached `input-required`
  simultaneously with distinct `actionId`s and disjoint real output paths
  (`.gitignore` vs `.github/workflows/ci.yml`).
- **Second attempt** (fresh scratch project, after Phases 2–4 were also
  implemented): the same request again organically produced the same
  two-branch fan-out on the first try.
- **Third attempt** (a `create-compose` + `.dockerignore` request, used for
  the rejection/sibling-skip probe below): organic two-branch fan-out again,
  first try.

`specs/060`'s own read-only version of this needed prompt tuning across two
separate days before it fired even once. This spec's wider prompt — inviting
*any* independent skill, not just read-only ones, explicitly naming "no two of
them write the same file" as the independence bar — produced reliable organic
fan-out on the first attempt, three times running. **This resolves the spec's
single named highest-uncertainty item decisively positive**, and the rest of
this checkpoint proceeded on that basis.

## Phase 1 — widen the fan-out gate

`apps/orchestrator/supervisor-graph.ts`:
- `dispatchNode()`'s eligibility condition (~line 425) no longer checks
  `allReadOnly` — a turn fans out whenever every entry is `dispatch_skill`
  and there's more than one, any tier.
- `dispatchReadOnlyBatch()` renamed `dispatchBatch()`; classifies each branch
  by its own tier via `classifySkillTier()`.
- Per-branch reservation extended: `skippedSkillIds` refusal and
  `dispatchedWriteKeys` (in-batch duplicate-write) refusal, alongside the two
  pre-existing bound reservations — each with its own audit-log decision
  entry, matching `specs/060`'s established per-branch shape.
- The three newly-reachable outcomes get defined handling: `rejected` and
  `failed-ambiguous` terminal; `skipped` non-terminal, recorded in
  `skippedSkillIds`.
- **The genuinely new mechanism**: a plain `Promise.all(dispatched.map(wait))`
  (specs/060's original shape) would block until *every* branch reaches a
  terminal state — meaning a rejected/timed-out/failed-ambiguous branch would
  leave every sibling's approval prompt dangling for a run that's already
  over. Replaced with a race-based incremental wait: branches are awaited via
  `Promise.race` as they individually resolve, and the instant any one
  produces a run-ending outcome, every still-in-flight sibling is skipped via
  a new optional `SupervisorDeps.skip()` method. Optional specifically so
  every pre-existing test double (`MockDeps`, `ConcurrencyProbeDeps` in
  `supervisor-graph.test.ts`) still satisfies the interface unmodified — a
  caller with no `skip()` implementation degrades to a safe no-op (the
  sibling's own in-flight `wait()` still resolves with its own real,
  independent outcome; nothing is ever fabricated).
- `buildSystemPrompt()` widened: the model may name several independent
  skills of any tier in one turn — "independent" defined explicitly as
  neither depending on another's result, and no two writing the same file.

**A real, disclosed conflict with the literal instruction "existing
supervisor-graph.test.ts passes unmodified"**: two pre-existing tests
("a batch mixing a read-only and a write-capable call processes only the
first entry" and its first-entry-write-capable sibling) asserted exactly the
OLD restricted gate this spec's whole purpose is to remove. `spec.md`'s own
Acceptance Criteria narrows the "unmodified" guarantee to single-`dispatch_
skill`-call and `finish`-call turns specifically — not mixed-tier batches —
so these two tests were updated to assert the new, approved behavior instead
of the one being deliberately overturned, with a comment explaining why. Nine
new tests were added for the write-capable-specific behavior: rejected/
failed-ambiguous ending the run inside a batch, skipped not ending it and
being unrepeatable, in-batch duplicate-write refusal, several write-capable
calls running genuinely concurrently (proven by overlapping `wait()` windows,
mirroring `060`'s own concurrency-probe technique), and — the one exercising
the new sibling-skip mechanism directly — a run-ending outcome in one branch
triggering `deps.skip()` on a still-in-flight sibling, with the sibling's own
subsequently-skipped outcome recorded honestly rather than assumed.

**Exit gate met**: 57/57 tests pass in `supervisor-graph.test.ts` (48
pre-existing minus the 2 rewritten, plus 9 new); several write-capable
children reach `input-required` simultaneously with distinct `actionId`s
(confirmed both hermetically and live, see Phase 0 above).

## Phase 2 — the disjointness gate

`apps/orchestrator/index.ts`:
- `resolvePreviewPaths(preview)` — a stored `ApprovalPreview`'s real output
  path(s): `preview.target`, or every `files[].target` for a `specs/114`
  multi-file preview. `path.resolve()` for the same canonicalization the
  write path already applies; never case-folded, never prefix-matched.
- `computeDisjointBatch(parentId)` — the disjointness gate itself. "The
  batch" is simply every currently-`input-required`, write-capable child of
  `parentId`. **No persisted batch id was needed**: under this codebase's own
  existing sequential-wait invariant (`waitForChildTask()` blocks a
  write-capable dispatch until it reaches a terminal state before the
  supervisor can even be consulted again, let alone dispatch a next step),
  more than one write-capable child of the same parent can only be
  simultaneously `input-required` if they were dispatched *concurrently* by
  `dispatchBatch()` — sequential dispatch structurally cannot produce that
  overlap. Fewer than two eligible branches, or any two sharing any output
  path, makes the whole batch ineligible.

**Exit gate met**: 6 hermetic tests (distinct paths eligible; identical paths
ineligible; a multi-file preview overlapping another branch's single target
ineligible; a multi-file preview with genuinely distinct paths eligible; a
read-only sibling never counted). Nothing consumes the eligibility decision in
this phase — confirmed byte-identical to Phase 1 in every case (no route
existed yet to act on it).

## Phase 3 — the grouped approval endpoint (the new trust boundary)

`POST /tasks/:parentId/approve-batch` and `GET /tasks/:parentId/pending-batch`
in `apps/orchestrator/index.ts`. Validation, fail-closed at every step:
unknown parent (404); malformed body (400); every decision entry needs a
non-empty `childTaskId`/`actionId` and a `decision` of exactly `"approve"` or
`"reject"` (400); no duplicate `childTaskId` in one request (400); every
listed child must belong to `:parentId` and be `input-required` right now
(409); every listed child's `actionId` must match its own currently-stored
one (409, catches both "wrong actionId" and "already resolved, submit
again"); the decision list must name every currently-eligible branch exactly
once — no partial list, no branch outside the eligible set (400 partial /
409 no eligible batch at all).

**The load-bearing property, asserted directly**: forwarding happens via
`Promise.all`, each decision hitting its owning agent's **existing,
unmodified** `/approve` or `/reject` with **that branch's own real
`actionId`** — no shared or collapsed `actionId` is ever constructed anywhere
in this endpoint. No agent file was touched by this spec at all.

**Exit gate met**: 19 hermetic HTTP-level tests in the new
`apps/orchestrator/approve-batch-endpoint.test.ts` (mirroring
`skip-endpoint.test.ts`'s established `app.fetch()` + mocked-`fetch` fake-agent
technique), covering: the happy path (disjoint targets, concurrent writes,
each with its own real `actionId` — confirmed via the fake agent's own
recorded forwarded `actionId`s); a mixed approve/reject group; the specific
adversarial cases the spec's own Verification Plan names — another parent's
child (409), a child listed twice (400), a valid `actionId` paired with the
*wrong* `childTaskId` (409), the same decision list submitted twice (200 then
409, no double-execution, forwarded-call count unchanged on the second
attempt); a partial decision list (400); an overlapping-target "batch" that
has no eligible group at all (409); and a dedicated test asserting the "no
shared actionId" property directly by checking two distinct `actionId`s were
used, never merged into one.

**Live, real, end to end** (see Phase 4 below — the two live scenarios prove
Phase 3 too, since the endpoint is what they exercise): a real grouped
approval wrote two real files (`.gitignore`, `.github/workflows/ci.yml`)
concurrently through two unmodified `devops-agent` `/approve` calls, and a
real individual rejection of one sibling triggered the real `deps.skip()`
path, turning the other sibling's real pending approval into `"Skipped by
user"` without any human ever touching it.

## Phase 4 — clients

### Dashboard — implemented, tested, live-verified

`apps/orchestrator/index.ts`: `renderGroupedBatchBanner()` — **strictly
additive**, never a modification of `renderTaskRows()`'s existing per-row
markup. One banner per parent task with a currently-eligible disjoint batch,
listing each branch's skill/agent/target/summary/risks with a per-branch
approve/reject checkbox (defaulting to approve) and one "Submit decisions"
button that posts the real decision list to `/tasks/:parentId/approve-batch`.
Wired into both `GET /dashboard` (full page) and `GET /dashboard/fragment`
(the existing live-refresh poll, gaining one additive `batchHtml` field — an
older cached client simply ignores it). Every existing per-row
Approve/Reject/Skip/Details control is completely untouched, so the
"fall back to individual approval" requirement is trivially met: nothing was
ever removed to fall back from.

**Hermetically tested** (4 new tests in `approve-batch-endpoint.test.ts`): the
banner renders with the real child ids and a "Submit decisions" button when
an eligible batch exists; renders no banner (checked via the CSS class, not a
naive substring match — the client-side `submitBatch()` JS itself contains
the literal string `data-batch-parent` as a selector fragment, which an
earlier, looser assertion false-negatived against before this was caught and
fixed) when targets overlap or only one write branch is pending; every
existing per-row control (`data-decision-task`) is still present alongside
the banner; `GET /dashboard/fragment` carries the new `batchHtml` field
alongside the two existing ones.

**Live-verified, real HTML from a real running Orchestrator**: `GET
/dashboard` against the live two-branch batch from Phase 0's first live
attempt genuinely rendered `data-batch-parent="task-...`, both
`data-batch-child="child-..."` entries, and exactly one "Submit decisions"
button — confirmed via `curl` + `grep` against the actual response, not
inferred from the source.

### TUI — deliberately deferred, not silently dropped

**Not implemented in this pass.** The directive's own framing authorized a
disclosed judgment call here, and this is it, stated plainly:
`apps/tui/index.tsx` carries this repository's own documented "16+ rounds of
terminal-overflow-bug history" and an explicit standing rule that any layout
change must be verified in a real PTY using a specific state-injection +
PTY-capture technique. This implementation pass ran as a headless fork with
Bash/Read/Edit/Write tools only — no real terminal emulator, no PTY, no way
to genuinely drive keyboard interaction and observe a live 80×24 render the
way that verification technique requires. Writing TUI code changes I cannot
verify against a file with that specific fragility history is a worse outcome
than deferring cleanly: an unverified layout change risks silently
reintroducing exactly the class of bug this file's own conventions exist to
prevent, for a feature (one-review-instead-of-N) that is convenience on top
of already-complete, already-safe backend behavior — every write-capable
batch still works correctly and safely from the TUI today via its existing
per-task individual approve/reject/skip keys (`a`×2/`r`×2/`s`×2), which this
spec does not touch or need to touch.

**What exists for a future pass to build on**: the exact same
`computeDisjointBatch()`/`POST /tasks/:parentId/approve-batch`/`GET
/tasks/:parentId/pending-batch` surface the dashboard already consumes is
available to the TUI with zero further backend work — a TUI-side pass is
purely a rendering + real-PTY-verification exercise, not a design or safety
question. `CLAUDE.md`'s TUI section now names this gap explicitly rather than
leaving it discoverable only by reading the diff.

## Gates

- `bun run typecheck` (`tsc --noEmit`) — exit 0, zero errors. (One
  environment note for whoever runs this next: the Go-based `tsgo` compiler
  genuinely OOM-crashed once in this same sandbox while six leftover
  background `bun` processes — DevOps/Orchestrator/MCP instances from this
  spec's own live verification runs — were still resident; killing them and
  re-running produced a clean pass immediately. Not a defect in this spec's
  code — confirmed by the immediate clean re-run under identical code with
  more free memory — but a real, disclosed resource-contention hazard in
  this sandbox worth knowing about before assuming a `typecheck` failure
  here is a real compile error.)
- `bun test`, full suite — **1447 pass, 0 fail** on a clean run (up from the
  1417 baseline recorded after `specs/119` landed: +23 in the new
  `apps/orchestrator/approve-batch-endpoint.test.ts`, +9 in the updated
  `supervisor-graph.test.ts` minus the 2 rewritten mixed-tier tests, net +30
  really — the exact arithmetic isn't load-bearing, the clean 0-fail result
  is). One transient failure was observed and reproduced exactly once more
  across several runs: `packages/agents/devops/index.ts`'s own
  MCP-reachability test flakes when a real MCP-capable process happens to be
  reachable at the default port in this shared sandbox — the same
  environment-dependent flake `specs/119`'s own review rounds already
  documented and characterized as unrelated to any code this checkpoint
  touches (`packages/agents/devops/index.ts` is untouched by this diff).
- `bun run specs:catalog` then `bun run specs:check` — passed (119 specs;
  `CLAUDE.md` 77,399 characters, well within the 150,000 budget). No spec
  frontmatter was touched by this implementation.
- `CLAUDE.md` and `context/worklog.md` updated in this same work unit.

## Live verification, 2026-09-24 — the decisive scenarios, run for real

Three real end-to-end runs, real provider (`gemini`/`gemini-3.5-flash-lite`),
real `mcp:http` + `devops-agent` + `orchestrator` processes, real scratch git
repositories, real HTTP calls (`curl`), real files checked on disk
independently of the agent's own reported result:

1. **The decisive scenario itself** (spec.md Verification Plan item 1): a
   real plan produced genuine organic multi-write fan-out (two
   `devops-agent` children, `.gitignore` and `.github/workflows/ci.yml`,
   `createdAt` within 1ms of each other), the real dashboard rendered one
   grouped review banner, and approving it via the real
   `POST /tasks/:parentId/approve-batch` endpoint wrote **both real files
   concurrently** — confirmed by reading their real contents off disk
   afterward, not by trusting the API response alone.
2. **A real rejection ending a batch, with sibling-skip firing live**
   (spec.md item 3's mixed-group case, approached from the reject side): a
   second real plan produced a second organic two-branch fan-out
   (`create-compose` + a write DevOps chose for ".dockerignore"). Rejecting
   one branch via the ordinary individual `/reject` endpoint caused the
   **other, untouched branch to transition from `input-required` to
   `"Skipped by user"` on its own**, with no human ever acting on it — the
   real, live proof that `dispatchBatch()`'s race-based wait loop and the
   new `SupervisorDeps.skip()` wiring genuinely works end to end, not just
   in the hermetic `SkipTrackingDeps` test. The parent plan task correctly
   ended `status: "failed"`, `error: "Rejected by user"`, and nothing new
   was written to the scratch project for that batch — confirmed by listing
   the directory afterward.
3. **The disjointness gate and grouped endpoint rendering**, confirmed live
   via `GET /tasks/:parentId/pending-batch` (`{"eligible":true, "branches":
   [...]}` with the real two children) and `GET /dashboard`'s real HTML
   output (`grep`-confirmed `data-batch-parent`/`data-batch-child`
   attributes with the real ids).
4. **A real, genuine gap found and fixed during this live pass**:
   `composeSupervisorResult()` was only ever called on `terminal === "done"`
   — a rejected/timeout/failed-ambiguous run left `task.result` unset,
   reporting only a single generic error string with no per-step breakdown,
   even though `composeSupervisorResult()` itself already reads each step's
   real child status/result/error completely generically (no terminal-
   reason-specific logic at all — reusing it needed no new code, just
   calling it on this path too). Fixed in `apps/orchestrator/index.ts`'s
   `runOrchestratorSupervisor()`. Live-confirmed with a fourth real run: a
   plan dispatching `create-gitignore` + `create-compose` (organic fan-out,
   fourth-for-four), rejecting the first, produced the parent task's real
   `result` field reading exactly `"1. [create-gitignore] devops-agent —
   failed: Rejected by user\n\n2. [create-compose] devops-agent — failed:
   Skipped by user\n\nSupervisor run completed after 2 dispatch(es)."` — the
   honest partial-effect report the spec's own Acceptance Criteria calls
   for. This was a pre-existing gap in the sequential single-dispatch path
   too, not introduced by this spec — but this spec's own requirement is
   what surfaced it, so it was fixed here rather than left for later. No
   dedicated hermetic unit test was added for this specific calling-site
   fix (no existing test harness in this repository drives a genuine
   multi-step `runOrchestratorSupervisor()` run through a scripted
   supervisor model end-to-end — `composeSupervisorResult()`'s own existing
   test coverage in `compose-supervisor-result.test.ts` already covers the
   function's generic per-step logic); the live run above is this fix's
   real evidence.

**Not exercised live in this pass** (spec.md Verification Plan items 2 and
4's overlapping-target and TUI halves): a live overlapping-target batch
degrading to individual approvals (hermetically proven instead, both at the
`computeDisjointBatch()` level and the dashboard-rendering level — the
mechanism is identical to the live-proven eligible case, just returning
`false`, so the incremental live risk is low but it is disclosed as
genuinely unexercised rather than assumed); and any TUI observation, for the
reasons stated in Phase 4 above.

## Known limitations (carried into the record, not fixed here)

- **TUI grouped-approval rendering does not exist yet** — the single largest
  gap this checkpoint leaves open, deliberately, per Phase 4's reasoning
  above. Every write-capable batch still works correctly from the TUI via
  its existing individual per-task controls; only the one-review convenience
  is dashboard-only for now.
- The disjointness gate covers branches writing the same *output* path. It
  does not, and by design cannot, detect a branch whose *content* was
  derived from a file another branch in the same batch rewrites — this is
  the spec's own named, accepted limit (the fingerprint recheck protects the
  target, not the inputs), not something this implementation weakened
  further.
- Orchestrator-side restart recovery for a mid-batch run remains the same
  standing, deliberately-open gap `CLAUDE.md` already records for every
  write-capable skill — not narrowed or worsened by this spec. A pending
  grouped batch's eligibility is recomputed fresh from live task state on
  every request (`computeDisjointBatch()` has no cache), so a restart simply
  loses in-flight `input-required` state exactly as it always has for any
  write-capable task — no new failure mode, but no new protection either.
- The two hermetically-only Verification Plan items named above (a live
  overlapping-target degrade, and anything TUI-side) remain genuinely
  unexercised live.
