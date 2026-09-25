---
id: 055-provider-call-budgets-and-transient-error-handling
title: Provider Call Budgets and Transient-vs-Terminal Error Handling
area: llm-harness
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-05
updated: 2026-09-14
approved_by: Yusuf
approved_on: 2026-09-08
implemented_on: 2026-09-08
amends:
  - 028-orchestrator-langgraph-supervisor
supersedes:
  - 053-production-readiness-foundation
superseded_by: []
related:
  - 026-llm-harness-langgraph-planning
  - 029-shared-llm-provider-gemini
  - 039-per-component-llm-provider-config
  - 051-planning-retirement-and-required-key
---

# Spec: Provider Call Budgets and Transient-vs-Terminal Error Handling

> Review gate: **APPROVED 2026-09-08 by Yusuf.** Split out of
> `specs/053-production-readiness-foundation/spec.md` §5 at Yusuf's
> request. Originally deprioritized (see history below); un-parked and
> approved after a scope review confirmed it's a small, well-bounded
> change — 4 real call sites, no new dependency, no touch to the
> approval gate or dispatch bounds.
>
> Historical note, preserved: this spec was originally recorded, not
> proposed for immediate approval, after Yusuf asked to deprioritize
> quota budgeting once he moved off the Gemini free tier. It sat parked
> until this approval.

## Scope amendment (2026-09-08, pre-implementation)

One real call site the original draft didn't know about: `runCapabilityRouter()`
in `packages/shared/capability-router.ts` (`specs/054`, drafted and
implemented *after* this spec) has its own raw `model.invoke()` call —
the exact same shape as the four call sites already named in Scope
below. Added here as a fifth call site to keep behavior consistent
across every real provider call in this codebase, not left as an
inconsistency discovered later. No other change to this spec's own
scope.

## Purpose

Live-caught, 2026-09-05: a real `dockerize` run under the adaptive
supervisor failed with a Gemini free-tier `429` (rate-limit exceeded,
`generativelanguage.googleapis.com/generate_content_free_tier_requests`,
limit 15/minute) partway through a multi-step plan that had already made
several real `read_project_file` calls. The task ended in the same
`{"status":"failed", "error": "..."}` shape a permanently invalid key
produces.

Checked directly: **there is no 429/rate-limit/`Retry-After`/backoff
handling anywhere in this codebase's LLM call path.** The only backoff
that exists (`packages/shared/mcp-client.ts`) is for MCP connection
lifecycle, unrelated. Every harness's own `maxRetries` (`specs/026`/
`041`/`042`) only retries when the **model's own output** was malformed
— an API-level error (network failure, 429, 5xx) goes straight to
`catch` and fails the task closed, identically to a genuinely invalid
key. That's correct for a misconfigured key; it is the wrong response to
a condition that resolves itself in under a minute.

`specs/051-planning-retirement-and-required-key/spec.md` made this
materially more consequential: before it, a missing/unusable key fell
back to Planning Agent's deterministic planner, so a `plan-task` failure
mode existed that never touched a live API at all. That fallback is
deleted. `plan-task` — the product's core feature — now has exactly one
path, with no distinction anywhere in that path between "this will never
work" and "this will work again in 60 seconds."

## Verified Current State

Read from the current code, 2026-09-05:

- `apps/orchestrator/supervisor-graph.ts`: `DEFAULT_MAX_DISPATCHES = 10`,
  `DEFAULT_MAX_ATTEMPTS_PER_SKILL = 2`, `DEFAULT_RECURSION_LIMIT = 50`.
  These bound **how many agent dispatches** one run performs — they say
  nothing about how many raw provider calls happen deciding each one, how
  long the run may take in wall-clock time, or what happens when a single
  provider call itself fails transiently.
- `runOrchestratorSupervisor()` (`apps/orchestrator/index.ts`): any error
  thrown while building/calling the model reaches one `catch`, which sets
  `task.status = "failed"` with the raw error message and returns. No
  branch distinguishes an auth error from a rate-limit error from a
  network timeout.
- Every per-agent harness (`packages/agents/{devops,documentation,
  security}/llm-harness.ts`) has the same shape: `maxRetries` governs
  retry-with-feedback for a malformed **model response**, never a failed
  **API call**.
- `readLlmModelConfig()`/`checkStartupLlmKeys()` (`specs/051`) verify a
  key is present and syntactically parseable at startup — they cannot
  and do not verify it has remaining quota, since that would require
  spending a real call before anything starts.

## Proposed Behavior

1. **Provider error classification.** A small, explicit taxonomy
   (`transient` — rate limit, timeout, connection reset, 5xx;
   `terminal` — auth failure, invalid model name, malformed request) is
   applied to every caught error from a real provider call, in the
   shared `packages/shared/llm-model-factory.ts` boundary every harness
   already goes through — one classification function, not one copy per
   harness.
2. **Bounded retry for transient failures only**, using the classic
   exponential-backoff-with-jitter shape, honoring a provider's own
   `Retry-After` header when present. A bounded maximum wait and a
   bounded maximum retry count — never unbounded, never a silent
   indefinite hang.
3. **Terminal failures fail exactly as they do today** — no behavior
   change for an invalid key or a genuine misconfiguration; this spec
   only changes what happens to the *other* category.
4. **Quota exhaustion is surfaced as an explicit, named provider state**
   in the task's own `error` field (distinguishable from "this key is
   simply wrong"), never silently reported as an empty/zero-step plan.
5. **A per-run time/call ceiling remains** even across retries — this
   spec adds patience for a single transient failure, not an unbounded
   number of attempts across a whole run. It composes with, and does not
   replace, `DEFAULT_MAX_DISPATCHES`/`DEFAULT_RECURSION_LIMIT` above.

## Scope

- `packages/shared/llm-model-factory.ts`: error classification and the
  bounded-retry wrapper, called from every existing provider-call site
  (the adaptive supervisor and all three per-agent harnesses) rather
  than duplicated per caller.
- `apps/orchestrator/index.ts`'s `runOrchestratorSupervisor()`: adopt the
  shared wrapper; no other change to its control flow.
- `packages/agents/{devops,documentation,security}/llm-harness.ts`:
  adopt the same shared wrapper for their own real provider calls.
- `packages/shared/capability-router.ts`'s `runCapabilityRouter()`
  (specs/054): adopt the same shared wrapper — see this spec's own
  "Scope amendment" above.
- No change to `DEFAULT_MAX_DISPATCHES`/`DEFAULT_MAX_ATTEMPTS_PER_SKILL`/
  `DEFAULT_RECURSION_LIMIT`, the approval gate, or any harness's own
  model-output retry-with-feedback logic (a separate, already-correct
  mechanism this spec does not touch).

## Safety and Compatibility Constraints

- **A model failure must never trigger a direct-execution bypass.**
  Retrying a transient provider error is not a fallback to a
  deterministic path (none exists post-`specs/051`) and never skips the
  approval gate.
- **No unbounded wait or unbounded retry count**, matching this
  codebase's own established pattern (`specs/045`'s bounded port-preflight
  timeout, the adaptive supervisor's own dispatch/attempt bounds).
- **No new dependency.** Backoff-with-jitter is a small, self-contained
  algorithm; no external retry library is warranted for this scope.
- Terminal-error behavior is byte-identical to today — this is
  additive, not a relaxation of the existing fail-closed precedent for
  genuine misconfiguration.

## Out of Scope / Non-Goals

- A CI-provided test API key, or spending real quota in automated tests
  — `specs/052-ci-plan-task-dispatch-smoke-test/spec.md` already
  established the precedent of testing dispatch shape without a real
  credential; this spec's own tests use a deterministic fake provider
  double, the same approach every prior harness's own retry-with-feedback
  tests already use.
- Per-user/per-organization quota accounting, billing, or budget
  dashboards — genuinely out of scope for this prototype, not merely
  deferred.
- Changing `DEFAULT_MAX_DISPATCHES`/the recursion limit, or any of
  `specs/028`'s adaptive-supervisor safety properties.
- The capability-routing tier (`specs/054`) — a related but independent
  concern; this spec applies uniformly to whatever LLM call path exists,
  regardless of how a request got routed to it.

## Acceptance Criteria

- [x] A simulated transient failure (fake provider double returning a
      429-shaped error) is retried with bounded backoff and eventually
      succeeds or exhausts its bound — never hangs. Verified:
      `llm-model-factory.test.ts`'s `callProviderWithRetry` suite —
      "retries a transient failure and succeeds", "exhausting retries on
      a persistent transient failure throws...", and "never waits longer
      than maxDelayMs" (a huge `Retry-After` still bounded).
- [x] A simulated terminal failure (invalid key) fails immediately,
      identically to today — zero added latency, zero retry attempts.
      Verified: "a terminal failure re-throws immediately — zero
      retries, the original error, unmodified" (asserts `calls === 1`
      and the exact same error object, via `.rejects.toBe(authError)`).
- [x] Quota exhaustion produces a distinguishable, named error string
      from a genuine auth failure. Verified: `ProviderRetriesExhaustedError`
      (a distinct, named class/error-name) vs. a terminal failure
      re-throwing its original, unmodified error — "the exhausted error
      names the attempt count and wraps the real cause" confirms the
      message and `.cause` are both present and readable.
- [x] No test in the suite spends a real provider call or requires a
      real credential. Verified: every `callProviderWithRetry` test
      injects a fake `fn`/`sleep`/`random`; no network call, no real key,
      confirmed by inspection of the added test file.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass with
      no API key configured. Verified: `bun run typecheck` — 0 errors;
      `bun test` — 831 pass, 0 fail, 1613 expect() calls across 55 files
      (up from the pre-055 baseline of 810/0/1572/55 — the 21 new tests
      are exactly this spec's own classifier/retry coverage); both run
      with no `ORCHESTRAI_LLM_API_KEY` set in this sandbox.
      `bun run specs:check` — pass (61 specs).
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Pure tests against a deterministic fake provider double for both
  classification branches and the bounded-retry wrapper itself
  (including the retry-count/time-bound edge, so it's proven bounded,
  not just "usually fast").
- A live pass with a real provider key deliberately rate-limited (a
  tight, temporary quota setting or a burst of concurrent requests) to
  confirm real 429 recovery end to end — recorded as a genuine live
  result, not inferred from the unit tests alone, matching this
  codebase's own established live-verification standard for LLM
  checkpoints.

## Approval Requested

Not yet requested, and not being requested urgently — see the note under
Review gate above. This spec needs Yusuf's review and explicit approval
before any implementation, per CLAUDE.md Working procedure step 8,
whenever it becomes a priority.
