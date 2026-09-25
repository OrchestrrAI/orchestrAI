# Verification — specs/075-real-conversational-chat

Implemented and recorded 2026-09-14, same session as approval.

## What changed, per Proposed Behavior section

1. **One LLM classification decides skill-or-no-skill-at-all.**
   `packages/shared/capability-router.ts`'s `CapabilityRouterProposalSchema.kind`
   gained `"state-question"`/`"conversation"`, and `buildSystemPrompt()`
   explains both explicitly (always paired with `skillId:
   "unsupported"` for these two, per the prompt's own instruction).
   `apps/orchestrator/index.ts` gained `classifyRouterProposal()` — the
   single shared extraction point that calls the router and validates a
   real skill proposal against the live capability snapshot (only for
   `"read-only"`/`"state-changing"` kinds — the other three never reach
   a dispatch, so there is nothing to validate). `tryCapabilityRoute()`
   (used by `detectSkill()`, i.e. `POST /tasks`) is now a thin wrapper:
   it calls `classifyRouterProposal()` and returns `null` (→ the
   existing `"plan-task"` fallback) unless `kind` is `"read-only"`/
   `"state-changing"` — **byte-identical observable behavior for
   `POST /tasks`**, confirmed by every pre-existing `detect-skill`-
   adjacent test passing unmodified.

2. **`ask-classifier.ts` rewritten**: `CAPABILITY_PATTERNS`/
   `RECENT_TASK_PATTERNS` and the string-matching Tier 0 branch are
   deleted. `classifyAsk()` now takes a `ProposalClassifier` (returns
   the real `CapabilityRouterProposal | null`, not a bare skill
   string) and branches on `kind`:
   - `null` (router unreachable/misconfigured/exhausted retries) →
     `tier: 0, stateIntent: "unclear"` — a deterministic "couldn't
     tell what you meant" answer, never a guess, never a dispatch.
   - `"state-question"` → `tier: 0, stateIntent: "state"`.
   - `"conversation"` → `tier: 0, stateIntent: "conversation"`.
   - `"unsupported"` → still tries `plan-task` (Tier 1) — genuine work
     the router couldn't map to one specific skill is still worth the
     adaptive supervisor's own attempt, the exact same behavior
     `POST /tasks` already has for this kind. This was a deliberate
     design decision made while implementing, not assumed from the
     spec's own prose: the spec's Safety Constraints sentence about a
     deterministic "couldn't tell" answer was read as covering router
     *failure* (a null proposal), not a *successful* "no single skill
     fits" classification, which is genuinely different information.
   - `"read-only"`/`"state-changing"` → real dispatch, tier decided by
     `SKILL_TIER_REGISTRY` exactly as before.
   Follow-up reuse (`isFollowUpRequest()`) is untouched, checked first,
   unchanged.

3. **`buildStateAnswer()`** (`apps/orchestrator/index.ts`) rewritten for
   the three new `stateIntent` values: `"state"` joins
   `answerCapabilitiesFromState()` and `answerRecentTasksFromState()`
   (the router's own `"state-question"` kind no longer distinguishes
   the two the way the deleted pattern lists did); `"conversation"` is
   a short, deterministic greeting-shaped sentence (chat must never be
   blank and must never require a provider to say hello back);
   `"unclear"` is the router-failure case. `synthesizeAnswer()`
   (unchanged) still phrases any of the three more naturally when a key
   is configured, exactly as every other Tier 0 answer already worked.

4. **A completed plan-task's result carries real findings.**
   `composeSupervisorResult()` (new, `apps/orchestrator/index.ts`)
   replaces the old `"Supervisor run completed after N dispatch(es)."`-
   only result: it walks `task.planSteps` in dispatch order, looks up
   each step's real child task, and reports `[order]. [skill] agent —
   outcome` (the child's real `result`/`error` text, or its raw status
   for an undispatched step), with the dispatch-count line kept as a
   trailing summary. Bound by the existing `boundTaskResult()`/
   `TASK_RESULT_MAX_BYTES` (64 KiB) path — the same explicit truncation
   marker every other bounded result already uses. No model involved;
   deterministic assembly of data the parent task already owns the ids
   of.

5. **Live progress narration.** `apps/tui/chat-progress-phrases.ts`
   (new) — a plain phrase-table lookup (`SKILL_PROGRESS_PHRASES`, one
   entry per skill in `SKILL_TIER_REGISTRY`, falling back to
   `"running ${skill}…"` for an unlisted skill), plus
   `skillFromStepName()` (strips the `"N. "` ordinal prefix
   `STEP_STARTED`'s own `stepName` field carries) and
   `progressPhraseForTool()` (narrates `TOOL_CALL_START`'s own
   `toolCallName` directly, already specific and human-legible). Wired
   into `apps/tui/index.tsx`'s existing SSE handler: a `STEP_STARTED`
   event whose `runId` matches the chat turn's own pending task id
   updates `chatPending` via the phrase table; a `TOOL_CALL_START` event
   for the same run narrates the specific tool. Never invents a result
   ahead of the real `STEP_FINISHED`/`TOOL_CALL_RESULT` event — only
   `STEP_STARTED`/`TOOL_CALL_START` (in-progress) events are read for
   this purpose, matching the spec's own stated Safety Constraint.

## A real, previously-undiscovered test regression found and fixed
## while implementing, not assumed away

`apps/orchestrator/ask-endpoint.test.ts`'s existing `beforeEach` already
injects `KeywordRouterFake` (`specs/065`'s own test seam) so its Tier 0/
1/2 tests stay hermetic. That fake reproduced only the pre-075 keyword
ladder as router proposals (`kind: "read-only"`/`"unsupported"`) — it
had no concept of the two new kinds at all. Once the deleted pattern
lists stopped short-circuiting before the router was ever consulted,
every one of that file's own Tier 0 tests (`"what agents do you have?"`,
`"what can you do?"`, `"what was the last task"`) started reaching the
fake, which classified them as ordinary skill proposals instead of
`state-question`/`conversation` — 7 real test failures, not a flake.
Fixed by extending `keyword-router-fake.ts` with the exact same two
pattern lists this spec deleted from `ask-classifier.ts` (reproducing
old, deterministic test expectations, not inventing new routing logic),
recognized before the real keyword ladder and returning the appropriate
new `kind`. All 43 tests in `ask-endpoint.test.ts` pass after this fix,
confirmed by two independent full-suite runs (1051 pass, 0 fail each
time) — an earlier single run showed 4 unrelated flaky failures
(`git_diff`/`read_project_file` MCP-timeout tests, root-caused to
leftover bare-metal processes from this same session's earlier live LLM
pass still bound to ports 3000/3002/3006; confirmed gone and the suite
stable across two subsequent clean runs once those were killed).

## Unit-level

- `apps/orchestrator/ask-classifier.test.ts` — fully rewritten (see
  above): `kind`-driven Tier 0 branches (`state-question`,
  `conversation`, the exact live-caught `"that is what i say"` plain-
  retort case, and a null-proposal `"unclear"` case), Tier 1/2 driven by
  `kind`/`skillId` instead of a bare string, `"unsupported"` still
  trying `plan-task`, and the full follow-up-reuse suite carried over
  unmodified in spirit (same assertions, adapted to the new injection
  shape).
- `apps/orchestrator/ask-endpoint.test.ts` — all 43 pre-existing tests
  pass unmodified in their own assertions once the fake router was
  extended (only `keyword-router-fake.ts` changed, not this test file).
- `bun run typecheck` — 0 errors.
- Full suite — 1051 pass, 0 fail, 2514 `expect()` calls, confirmed
  stable across two consecutive runs.

## What was not live-verified against a real model

No live provider credentials were available at the point this
implementation finished in this session (this session's own earlier
Gemini free-tier quota was exhausted during the specs/055/060/065 live
pass earlier the same day — see those specs' own `verification.md`
files). The spec's own Verification Plan calls for a live pass
confirming: `hello`/`"are you working fine?"`/`"that is what i say"`
each answered with zero dispatch against a real router; a real
multi-step `plan-task` whose chat view shows the step narration
changing in real time; and a live regression pass confirming a genuine
work request ("dockerize this project") still routes/dispatches/gates
identically to before. None of these were performed live in this
session — recorded honestly as the open item, not assumed proven by the
unit tests and the hermetic fake-router coverage alone, real as that
coverage is. `verification` stays `pending` for this reason; flip to
`partial` once a live pass confirms at least the core zero-dispatch
scenarios, and `verified` once the full Verification Plan is covered
live, including a real-terminal look at the TUI's own live progress
narration (this sandbox has no TTY, so that specific piece structurally
cannot be confirmed here regardless of provider credentials — the same
standard every TUI checkpoint in this codebase carries).

## Live pass, 2026-09-15 (same session, after a billing/quota issue was resolved)

A real Gemini deployment (`gemini-3.5-flash`) became available again this
session once Yusuf resolved a billing problem that had been blocking
provider calls. Using that, the three core zero-dispatch scenarios named
in the spec's own Verification Plan were re-run against a real, running
bare-metal stack via direct `POST /ask` requests:

- `"hello"` — classified `conversation` by the real router, answered
  directly with zero task/dispatch created.
- `"so now are you working fine?"` (the exact original live-reported bug
  phrase) — classified `state-question`/`conversation`, answered
  directly, not dispatched as a five-skill project analysis the way it
  was before this spec.
- A plain-retort-shaped phrase (the same class as `"that is what i
  say"`, already covered hermetically in `ask-classifier.test.ts`) — also
  correctly classified as conversational, not dispatched.

This confirms the router-side classification fix genuinely works against
a live model, not just the hermetic `KeywordRouterFake` seam — the real
Gemini deployment reliably distinguishes small talk/state questions from
work requests using the two new `kind` values this spec added.

**Not covered by this pass**: a completed multi-step `plan-task`'s own
composed result (real skill/agent/status/output per step) was not
directly observed to completion in this session — a live plan dispatched
during this same window surfaced an unrelated, more urgent bug
(`specs/087`'s target-path resolver first-match failure) and the session
pivoted to fixing and verifying that instead of returning to check the
composed-result feature specifically. The TUI's own live progress
narration (`chatPending` updating from real `STEP_STARTED`/
`TOOL_CALL_START` events) remains unconfirmed in a real terminal for the
same reason every TUI checkpoint in this codebase carries that gap: this
sandbox has no TTY, so it cannot be confirmed here regardless of
provider credentials.

`verification` moves from `pending` to `partial`: the core, most
important zero-dispatch scenarios (the ones that were actually visibly
broken and drove this spec) are now live-proven, not just unit-tested.
The two remaining items (composed-result content, live TUI narration)
are what would close this to `verified`.

## Out of scope, confirmed untouched

- `POST /tasks`'s own routing default — confirmed byte-identical via
  `tryCapabilityRoute()`'s own thin-wrapper design and the full
  pre-existing test suite passing unmodified.
- The approval gate — no edit anywhere near `packages/shared/approval.ts`
  or the approve/reject endpoints; a conversational/state answer
  dispatches nothing by construction, so it cannot reach the gate.
- `isFollowUpRequest()`'s own closed pattern set — untouched.
- `synthesizeAnswer()` and its grounding check — untouched.
- The TUI's chat *layout* (`specs/069`) — this spec touched only the
  `chatPending` narration content, not the shell/scrollbox geometry.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/075-real-conversational-chat/spec.md` (implemented, **partial**
verification, 2026-09-14; amends `044`/`054`/`065`) fixes three real,
directly live-caught gaps in Chat: typing `hello` triggered a real
five-skill project-wide analysis; *"so now are you working fine?"*
dispatched `"Supervisor run completed after 2 dispatch(es)."` instead of
answering; and a completed plan's own result only ever reported a
dispatch count, discarding every child's real output — starving
`synthesizeAnswer()` of anything to summarize. Yusuf's own words after
seeing it live: *"the chating should be real one it's very suck now."*

**No new hardcoded pattern list — the fix reuses the router that
already exists.** `packages/shared/capability-router.ts`'s
`CapabilityRouterProposalSchema.kind` gains two more closed values,
`"state-question"` and `"conversation"`, alongside the existing
`"read-only"`/`"state-changing"`/`"unsupported"` — the same LLM call
`specs/054`/`065` already made for every request, now also deciding
"does this even name work" instead of a second, narrower deterministic
layer bolted in front of it. `apps/orchestrator/ask-classifier.ts`'s
two hardcoded Tier 0 pattern lists (`CAPABILITY_PATTERNS`/
`RECENT_TASK_PATTERNS`) are **deleted** — `classifyAsk()` now reads the
router's own `kind` directly. `detectSkill()` (`POST /tasks`) is
**unaffected in observable behavior**: `classifyRouterProposal()` (new,
the shared extraction point both `detectSkill()` and `/ask` now use)
maps `"state-question"`/`"conversation"` to the same `"plan-task"`
fallback `"unsupported"` already produced — proven byte-identical by
every pre-existing routing test passing unmodified.

**A completed `plan-task` now reports what actually happened.**
`composeSupervisorResult()` (new) walks `task.planSteps` in dispatch
order and composes each step's real skill/agent/outcome from its real
child task — deterministic assembly of data the parent already owns
the ids of, no model involved, bound by the existing
`boundTaskResult()`/`TASK_RESULT_MAX_BYTES` (64 KiB) path. This is what
gives `synthesizeAnswer()` real material for the first time.

**Live progress, not a static "thinking…".** `apps/tui/
chat-progress-phrases.ts` (new) is a plain phrase-table lookup — one
entry per skill in `SKILL_TIER_REGISTRY`, falling back to `"running
${skill}…"` for an unlisted skill — deliberately not a further LLM call
(a live ticker has to update the instant a `STEP_STARTED`/
`TOOL_CALL_START` SSE event arrives; a paraphrase would lag the real
work and cost money per step for very little gain over an already-
small, human-legible skill-id vocabulary). Wired into the TUI's
existing SSE handler: `chatPending` now updates from real events
correlated to the pending chat turn's own task id, never inventing a
result ahead of the real `STEP_FINISHED`/`TOOL_CALL_RESULT` event.

**A real test regression found and fixed while implementing, not
assumed away**: `ask-endpoint.test.ts`'s existing `KeywordRouterFake`
seam (`specs/065`'s own test double) had no concept of the two new
`kind` values — once the deleted pattern lists stopped short-circuiting
before the router was ever consulted, every one of that file's own
Tier 0 tests started reaching the fake and being misclassified as
ordinary skill proposals. Fixed by extending `keyword-router-fake.ts`
with the exact same two pattern lists this spec deleted from
`ask-classifier.ts` (reproducing old, deterministic test expectations,
not new routing logic). 1051 tests pass (0 fail, confirmed stable
across two consecutive full-suite runs — an earlier single run showed 4
unrelated flaky failures traced to leftover bare-metal processes from
this same session's own earlier live LLM pass still bound to ports
3000/3002/3006), typecheck clean.

**Closed live, 2026-09-15 (same session, once a billing/quota issue was
resolved)**: the core zero-dispatch scenarios were re-run against a real
Gemini deployment — `"hello"`, the exact original `"so now are you
working fine?"` bug phrase, and a plain-retort-shaped phrase all
correctly classified as conversational/state and answered directly with
zero dispatch, closing the specific, visibly-broken behavior this spec
was written to fix. A genuine work request routing/dispatching/reaching
the approval gate was also confirmed indirectly the same day via
`specs/060`'s and `specs/087`'s own live dispatches. **Still open**: a
completed multi-step `plan-task`'s own composed result (each step's
real skill/agent/status/output) was not directly observed to completion
this session — a live plan surfaced the unrelated `specs/087` bug and
the session pivoted to fixing that instead; and the TUI's own live
progress narration remains unconfirmed in a real terminal (no TTY in
this sandbox, the same standing gap every TUI checkpoint here carries).
`verification` moves from `pending` to `partial`; see `specs/075`'s own
`verification.md` for the complete record.

See specs/077-agent-enabled-means-llm-on-by-default/verification.md for the relocated narrative covering this checkpoint.

See specs/102-orchestrator-readonly-project-inspection/verification.md for the relocated narrative covering this checkpoint.
