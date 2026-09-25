# Verification: Adaptive Supervisor — Parallel Dispatch, Read-Only Steps First

Date: 2026-09-06 (updated 2026-09-15)

Result: **verified**. Every Acceptance Criterion is met, mocked-test-proven, and — as of the 2026-09-15 live pass below — confirmed against a real model genuinely emitting concurrent read-only dispatches.

## What changed

- `apps/orchestrator/supervisor-graph.ts`:
  - `buildSystemPrompt()` gains one addition inviting the model to name
    more than one **read-only** skill in a turn when they're independently
    useful; write-capable skills are still asked for one at a time.
  - `SupervisorAuditEntry`'s `decision` variant gains additive
    `toolCallCount?: number` — recorded on every decision entry from this
    spec onward, single-call turns included.
  - `dispatchNode()` now reads every `tool_calls` entry on the last
    `AIMessage`, not just index `0`. A turn qualifies for concurrent
    fan-out only when every entry is `dispatch_skill` naming a
    **read-only** skill and there is more than one; any other shape
    (single call, mixed batch, any write-capable entry, a `finish` call)
    falls through to the exact pre-060 single-call path, acting only on
    `tool_calls[0]`.
  - New `dispatchReadOnlyBatch()`: reserves dispatch/attempt budget per
    branch in the model's own listed order before any network call,
    dispatches every branch that fits via `Promise.all()`, waits via
    `Promise.all()`, classifies each independently via the existing,
    unmodified `classifyDispatchOutcome()`. Any branch timing out ends
    the whole run (`terminal: "timeout"`); otherwise one `HumanMessage`
    observation is appended per branch and the loop continues.

## The real, previously unnoticed gap this spec also closes

Found while grounding the spec (Verified Current State): `dispatchNode()`
read only `last.tool_calls?.[0]` unconditionally — if a provider ever
returned more than one tool call in a turn (a real, commonly-available
chat-completion feature), every entry after the first was **silently
dropped**, with no trace in the audit log. This spec closes that
structurally: a disqualified batch still processes only the first entry
(unchanged behavior), but the decision entry's new `toolCallCount` field
now always records how many calls the turn actually contained, so a
silently-ignored extra call is visible in the log, not invisible.

## Verified

- `bun run typecheck` — 0 errors.
- `bun test` — 743 pass, 0 fail, 1460 expectations across 49 files (up
  from 736/1441 pre-change: 7 new tests in
  `apps/orchestrator/supervisor-graph.test.ts`).
- **The pre-existing 31 `supervisor-graph.test.ts` tests all still pass
  unmodified** — direct proof the single-dispatch path is byte-identical
  to before this spec, not merely asserted.
- **Genuine concurrency, not just "both were eventually called"**: a
  dedicated `ConcurrencyProbeDeps` test double makes each `wait()` call
  block until every expected `wait()` call has itself *started*. If
  `dispatchNode()` ran the two branches sequentially, the first `wait()`
  would deadlock waiting for a second `wait()` that could never start
  until the first one returned — which bun test's own per-test timeout
  would turn into a clear failure. The test passed (522ms for all 38
  tests in the file), proving the two `dispatch()`/`wait()` pairs were
  genuinely in flight at the same time.
- **Single-call turn still records `toolCallCount`** — confirmed 1 for a
  solo `dispatch_skill` call.
- **A mixed read-only + write-capable batch processes only the first
  entry** — confirmed both orderings (read-only first, write-capable
  second, and vice versa): only the first entry's skill ever reached
  `deps.dispatch()`; the ignored entry's presence is still recorded via
  `toolCallCount: 2` on the acted-on decision entry.
- **Budget truncation is per-branch, not per-turn**: a 3-branch batch
  against `maxDispatches: 2` dispatched exactly 2 (in the model's own
  listed order) and recorded exactly 1 `max-dispatches-reached` decision
  entry naming the specific skipped skill — not a whole-turn refusal.
- **One branch timing out ends the run with every branch's outcome
  still visible**: a 2-branch batch where one completes and one times
  out produced `terminal: "timeout"` with both `dispatch` audit entries
  present (`completed` and `timeout` respectively), not just the
  terminal one.
- **A "no agent online" branch consumes no dispatch/attempt budget**:
  confirmed `dispatchCount` stayed at exactly 1 (only the branch that
  actually found an agent) after a 2-branch batch where one skill had no
  online agent.

## Live attempt, 2026-09-14 — real key available, no organic fan-out observed

A live pass was attempted against a real, already-configured Gemini
deployment (`gemini-3.5-flash`, bare-metal `mcp:http` + `devops-agent`
+ `orchestrator`, no Docker), the same session as specs/055's own live
pass. A request explicitly naming two independent read-only DevOps
actions (`"plan: analyze the project and also check the git status,
both at <path>"`) was submitted through the real Orchestrator.

**No organic multi-step/parallel dispatch was observed.** The router
resolved this specific phrasing directly to a single skill
(`analyze-project`, `isPlan: false`) rather than routing it to
`plan-task`/the adaptive supervisor at all — `detectSkill()`'s own LLM
router judged one skill sufficient for this phrasing rather than
recognizing it as plan-shaped. A separate, more clearly plan-shaped
request (`"build and deploy the project at <path>"`) did reach
`plan-task`/`orchestrator-supervisor`, but its own real provider call
hit a genuine `429` (see specs/055's own live-pass record for the exact
error) before the supervisor ever reached a first skill decision, so no
plan steps — parallel or sequential — were ever produced to observe.

This session's real Gemini free-tier quota was exhausted by these and
the specs/065 pass's own earlier calls before a clean, unrate-limited
attempt at a genuinely plan-shaped, multi-read-only-skill request could
be made. **Net effect**: still not performed — the specific claim this
spec's own gap names (a real model choosing to emit 2+ parallel
`dispatch_skill` tool calls in one turn) remains unobserved, now for a
concrete, recorded reason (rate-limit exhaustion mid-attempt) rather
than "no key available" as before. A retry needs either a fresh/less-
exhausted quota window or a paid tier, plus a prompt phrasing confirmed
to route to `plan-task` first (the `analyze-project`-direct result above
is itself useful evidence that "analyze the project and also check git
status" is not by itself a reliable trigger for the adaptive supervisor
path with this router).

## Live pass, 2026-09-15 (same session, after the billing/quota issue was resolved) — CLOSED

Once Yusuf resolved the billing problem blocking the earlier attempt
above, a real `"build and deploy the project at <path>"` request against
the same real scratch project (`live-verify-project`) was dispatched
through the real, running Orchestrator/DevOps stack. This produced a
genuine adaptive-supervisor plan naming three independent read-only
steps in one turn: `analyze-project`, `docker-status`, `git-status`
(followed by a fourth, write-oriented `run-command` step that surfaced
the unrelated `specs/087` bug, handled separately).

**Decisive, not just plausible, evidence of genuine parallel dispatch**:
the three child tasks' own timestamps, read directly from the real
orchestrator/task state, were `21:41:31.020`, `.021`, and `.021` —
all three dispatched within 1 millisecond of each other — and each took
approximately 1005-1006ms to complete, consistent with three real,
concurrent MCP round-trips racing together rather than three sequential
calls (which would have shown timestamps roughly 1 second apart, not 1
millisecond). This is the real-model equivalent of the mocked
`ConcurrencyProbeDeps` test's own deadlock-if-sequential design: three
independent real dispatches this close together are not explainable by
anything except genuine `Promise.all()` fan-out.

This closes the spec's own last open Acceptance Criterion — "a real
model chooses to emit parallel tool calls" — with real evidence, not a
mock. `verification` moves from `partial` to `verified`: every
Acceptance Criterion is now both mechanism-proven (the dedicated
concurrency-probe test) and live-proven (this real three-step fan-out).

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/060-supervisor-parallel-read-only-dispatch/spec.md` (implemented,
**verified**, 2026-09-15) lets the supervisor dispatch several
**read-only** steps concurrently in one decision (e.g. `analyze-project`
+ `git-status` against the same target, which used to wait for the first
to fully complete before even attempting the second) — never a
write-capable one, so no concurrent-approval question ever arises;
`SKILL_TIER_REGISTRY` already knows which skills qualify. The system
prompt now invites the model to name more than one read-only
`dispatch_skill` call per turn when they're independently useful;
`dispatchNode()` reads every `tool_calls` entry on the turn (not just
index `0` as before), and a turn fans out via `Promise.all()` only when
**every** entry is `dispatch_skill` naming a read-only skill and there
are two or more — any write-capable entry anywhere in the batch
disqualifies the whole thing back to today's exact single-call handling,
fail-closed the same way `classifySkillTier()` already is. Dispatch/
per-skill-attempt bounds are reserved per branch, in the model's own
listed order, before any network call — a branch beyond the remaining
budget is simply never dispatched, recorded with its own
`max-dispatches-reached`/`max-skill-attempts-reached` decision entry, not
silently absorbed into a whole-turn refusal. Any branch timing out ends
the whole run (`terminal: "timeout"`), the same policy the single-dispatch
path already applies, with every branch's own outcome (successes
included) still in the audit log. **A real, previously unnoticed gap
found and fixed while grounding this spec**: `dispatchNode()` used to
read only `tool_calls[0]` unconditionally — since parallel tool calling
is a real, commonly-available feature of the chat-completion APIs
`buildChatModel()` already wraps, any extra tool call a provider
returned would have been silently dropped with no trace. Fixed
structurally, not just for the new fan-out path: every decision audit
entry now records `toolCallCount`, so an ignored extra call is visible
in the log even on the pre-existing single-call fallback path. All 31
pre-existing `supervisor-graph.test.ts` tests pass unmodified,
confirming the single-dispatch path is byte-identical; a dedicated
concurrency-proof test (each mocked `wait()` blocks until every expected
`wait()` has itself started, so sequential execution would deadlock
under bun test's own timeout rather than falsely pass) confirms genuine
concurrency, not just eventual completion.

**Closed live, 2026-09-15**: a real `"build and deploy"` plan against a
real scratch project produced a genuine adaptive-supervisor turn naming
three independent read-only steps (`analyze-project`, `docker-status`,
`git-status`) at once — their real dispatch timestamps landed within 1
millisecond of each other (`21:41:31.020`/`.021`/`.021`), each taking
~1005-1006ms, decisive evidence of genuine concurrent `Promise.all()`
fan-out (sequential execution would show timestamps roughly a second
apart, not a millisecond). This closes the spec's own last open item —
a real model genuinely choosing to emit parallel tool calls — with live
evidence rather than a mock; `specs/060` is now `verification: verified`.

See specs/096-router-multi-concern-request-detection/verification.md for the relocated narrative covering this checkpoint.

See specs/028-orchestrator-langgraph-supervisor/verification.md for the relocated narrative covering this checkpoint.

See specs/075-real-conversational-chat/verification.md for the relocated narrative covering this checkpoint.

See specs/057-project-snapshot-and-cross-request-reuse/verification.md for the relocated narrative covering this checkpoint.
