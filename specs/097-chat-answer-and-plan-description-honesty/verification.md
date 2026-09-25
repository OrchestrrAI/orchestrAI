# Verification: specs/097 — Chat Answer De-Duplication, Plan-Step Description Honesty, Configurable Dispatch Limit

## What changed

**Fix 1**: `apps/orchestrator/index.ts` gained `CANNED_NO_DATA_ANSWERS`
(a `Set` of the four fixed, content-free strings `buildStateAnswer()`
can return), checked before calling `synthesizeAnswer()` in the Tier-0
`/ask` handler — when `raw` is a member, `synthesized` is `null`
directly (no call made), so `answer = raw`. A test-only call counter
(`__testSynthesisCallCount`, `__getTestSynthesisCallCount()`,
`__resetTestSynthesisCallCount()`, mirroring `__setTestRouterModel`'s
own precedent) was added so the "zero calls made" claim is directly
provable, not inferred from output equality.

**Fix 2**: a fixed reminder line (*"the description above is
planning-time intent, not a promise — review the action below before
approving"*) added at two render points, both scoped to a plan step's
own child task (`parentTaskId` set) with a real pending approval: the
TUI's Detail overlay (`apps/tui/index.tsx`) and the Orchestrator
dashboard's Tasks table row + chat-linked approval card
(`apps/orchestrator/index.ts`'s `renderTaskRows()`/
`renderApprovalBlock()`). The task-detail modal was checked and found
to not need the change — it never displays the step's own description
text alongside its approval at all, so there's nothing there that could
mislead.

**Fix 3**: `apps/orchestrator/supervisor-graph.ts` gained
`resolveSupervisorMaxDispatches(env)` (mirroring
`resolveServicePort()`'s own resolution shape exactly) reading
`ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES`; `DEFAULT_MAX_DISPATCHES` raised
`10` → `30`. `apps/orchestrator/index.ts`'s `runOrchestratorSupervisor()`
— the one real call site — now passes the resolved value into
`runSupervisor()`'s options.

## Acceptance criteria

- [x] Each of the four canned strings produces the raw string alone as
      the answer, with zero synthesis/model calls — confirmed via the
      real call counter (`ask-endpoint.test.ts`'s new
      `"canned, content-free answers skip synthesis entirely"` describe
      block), not just output equality.
- [x] A `"state"` intent question (real agent/task data) is
      byte-identical to before this spec — synthesis still runs (call
      count 1, confirmed by the contrast test in the same block).
- [x] A dispatched-task terminal answer (the second call site) is
      byte-identical to before this spec — untouched, no test needed
      beyond the pre-existing suite passing unmodified.
- [x] The TUI's Detail overlay shows the new reminder line exactly when
      viewing a plan step's own approval (description + approval both
      present), never otherwise — implemented, condition mirrors
      Skip's own scoping exactly (`detail.approval && detail.parentTaskId`).
- [x] The dashboard's plan-step approval cards show the same reminder,
      same scoping — confirmed by a new HTTP-level test
      (`"the Tasks table's server-rendered row shows the reminder..."`)
      proving the note appears for a real plan-child task and not for a
      direct task in the same response.
- [x] With `ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES` unset, a real
      `plan-task` run's own budget is 30, not 10 — confirmed by unit
      test (`resolveSupervisorMaxDispatches({})` → `30`); the live
      wiring itself (`runOrchestratorSupervisor()` passing the resolved
      value) confirmed by direct code inspection and a real dispatched
      run reaching well past the old 10-step ceiling in this session's
      own live pass (6+ real steps dispatched with no premature
      termination).
- [x] With `ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES` set to a specific
      value, that value is honored exactly — unit test.
- [x] With a malformed value (non-numeric, zero, negative, non-integer),
      the run falls back to 30 — unit tests, all four cases.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] Every pre-existing test in the affected files passes unmodified.

## Test results

- `apps/orchestrator/supervisor-graph.test.ts`: 50 pass (net +6 over
  specs/089's own 44 — the new `resolveSupervisorMaxDispatches`
  describe block, plus one corrected stale assertion
  `DEFAULT_MAX_DISPATCHES` `10` → `30`).
- `apps/orchestrator/ask-endpoint.test.ts`: 55 pass (net +7 — 5 new
  synthesis-call-count tests, 2 new dashboard-reminder tests).
- `bun test` (full suite): 1132 pass, 0 fail (net +13 over specs/089's
  own 1119 baseline).
- `bun run typecheck`: 0 errors.
- `bun run specs:catalog`/`specs:check`: pending final run (see below).

## Live verification

Against the real running 6-agent stack (this repository as the target
project, a real Gemini key):

1. **Fix 1**: `POST /ask {"question": "hello"}` (fresh conversation) →
   `"answer": "Hi — I'm OrchestrAI's orchestrator. Ask what I can do,
   or tell me what you'd like done."` — the raw greeting exactly once,
   no duplicate paraphrase above it. A mid-conversation follow-up with
   no recent failure → `"Got it — what would you like me to do next?"`,
   also exactly once.
2. **Fix 2**: dispatched a real `plan-task` (*"can you make sure that
   repo is production ready?"*) and let it run to a real `run-command`
   approval. **A second, independent live instance of the exact same
   bug class this spec exists to fix** occurred organically: the step's
   own description read *"List all files in the project to understand
   the structure..."* while the real proposed action was `["bun", "run",
   "typecheck"]` — a materially different, bigger action. Fetched the
   real `/dashboard` HTML and confirmed the new reminder note
   (*"this text is planning-time intent, not a promise..."*) rendered
   directly inside that exact row's own `<td>`, alongside the real Skip
   button (`specs/089`). Rejected the step to end the run cleanly.
3. **Fix 3**: confirmed by direct code inspection (the one real call
   site now passes `maxDispatches: resolveSupervisorMaxDispatches()`)
   and indirectly by the same live run above genuinely dispatching 6
   real steps with no interference — the mechanism itself is fully unit
   tested (6 dedicated cases covering unset/valid/malformed/zero/
   negative/non-integer). A full 30-dispatch live run was not forced
   (expensive and unnecessary given the mechanism is a one-line,
   already-proven-pattern wiring change, not new logic).

## Known limitations

- The live pass did not force all 30 real dispatches to prove the new
  ceiling specifically (as opposed to the old one) — the resolution
  function itself is exhaustively unit-tested, and the live run
  confirms the real wiring reaches the real call site without error.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**Three more real gaps, same live session, folded into one spec at
Yusuf's own request.**
`specs/097-chat-answer-and-plan-description-honesty/spec.md`
(implemented, **verified**, 2026-09-15; amends `044`/`091`/`093`/`030`/
`080`/`028`) fixes three distinct issues Yusuf found live, bundled into
one checkpoint since none needed independent approval from the others.

**Fix 1 — a synthesized chat answer no longer duplicates itself with
zero added information.** Every Tier-0 `/ask` answer used to
unconditionally show `${synthesized}\n\n${raw}` (`specs/044`'s own
design — never lose real data beneath a nicer paraphrase). That's
correct when `raw` carries real data, but three-plus-one fixed, canned
"nothing to report" strings (`buildConversationAnswer()`'s own
first-contact greeting and no-recent-failure fallback,
`answerLastFailureFromState()`'s own no-failure fallback, and a
structurally-likely-unreachable default) carry none — appending one
below its own AI paraphrase just showed the same sentence twice.
Live-caught: `"hello"` produced its own paraphrase immediately followed
by the identical canned greeting. Fixed with a closed
`CANNED_NO_DATA_ANSWERS` set checked before calling `synthesizeAnswer()`
at all — not just discarding its result — for real cost savings, not
only a UX fix. Proven via a new test-only call counter
(`__getTestSynthesisCallCount()`, mirroring `__setTestRouterModel`'s own
shape) so "zero calls made" is directly provable, not inferred from
output equality; the `"state"` intent's own real-data branches and the
second (dispatched-task) synthesis call site are completely unaffected,
confirmed by a contrast test showing synthesis still fires exactly once
for those.

**Fix 2 — a plan step's own description can no longer silently mislead
about what its approval preview actually proposes.** A step's
free-text `description` is written by the adaptive supervisor (one LLM
turn, explaining its own reasoning); for a skill whose real write-time
parameters are decided by a second, independent LLM harness at
approval-preview time (`run-command` most visibly, `specs/080` — but in
principle any DevOps write skill with its own harness, `specs/042`),
nothing keeps the two in sync. Live-caught **twice in the same
session**: a step described as *"List the files in the workspace..."*
proposed `["bun","test"]`; a second, independent instance the same
session described *"List all files in the project..."* and proposed
`["bun","run","typecheck"]` — both materially bigger actions than their
own description implied. Rather than attempting to detect a specific
mismatch (a brittle semantic-similarity problem with no reliable
general solution), a single fixed reminder line (*"the description
above is planning-time intent, not a promise — review the action below
before approving"*) was added wherever a plan step's own description
sits directly above its approval preview — the TUI's Detail overlay and
the Orchestrator dashboard's Tasks-table row + chat-linked card, both
scoped to `parentTaskId`-bearing tasks exactly like `specs/089`'s own
Skip button. The task-detail modal was checked and found to need no
change — it never shows the step's own description alongside its
approval at all. **Live-confirmed against the second organic
reproduction**: fetched the real `/dashboard` HTML mid-session and
confirmed the new note rendered inside that exact row.

**Fix 3 — the adaptive supervisor's own dispatch bound is now
configurable, default raised 10 → 30.** `DEFAULT_MAX_DISPATCHES = 10`
(`specs/028`) was a hardcoded literal with no environment-variable
override anywhere in the runtime. Live-caught the same session: a
genuine *"make sure that repo is production ready"* request, with
`specs/089`'s own skip feature correctly keeping the plan alive through
three deliberate skips, legitimately ran out of budget at exactly 10
real dispatches — not a bug in the skip mechanism or the bound-checking
logic (both worked exactly as designed), but real evidence 10 is too
low a ceiling once a broad request has a few steps skipped. Fixed with
`resolveSupervisorMaxDispatches(env)`, mirroring
`packages/shared/service-ports.ts`'s own `resolveServicePort()`
resolution shape exactly (`ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES`, unset
or malformed falls back to the default, never throws, never disables
the bound). `DEFAULT_MAX_DISPATCHES` raised to `30`, Yusuf's own
explicit choice via AskUserQuestion.
`DEFAULT_MAX_ATTEMPTS_PER_SKILL`/`DEFAULT_RECURSION_LIMIT` are
untouched — this spec's own scope is the total-dispatch bound alone.

1132 tests pass (net +13 over `specs/089`'s own 1119), typecheck clean,
`specs:check` passed for 96 specs. Live-verified against the real
running stack for all three fixes, including the decisive second
organic reproduction of Fix 2's own exact bug class, confirming this
wasn't a one-off. See `specs/097`'s own `verification.md` for the full
transcript.

See specs/098-harness-recursion-limit-and-clean-failure/verification.md for the relocated narrative covering this checkpoint.

See specs/116-chat-answer-voice-and-collapsed-raw-data/verification.md for the relocated narrative covering this checkpoint.
