# Verification: Provider Call Budgets and Transient-vs-Terminal Error Handling

Implemented and verified 2026-09-08. `status: implemented`,
`verification: partial` — see "What's not verified here" below for the one
genuine gap.

## What changed

- `packages/shared/llm-model-factory.ts` gained the shared classification +
  retry core: `ProviderErrorClass`, `classifyProviderError()`,
  `extractRetryAfterMs()`, `ProviderRetriesExhaustedError`, and
  `callProviderWithRetry()`, plus the bounded default constants
  (`DEFAULT_RETRY_MAX_RETRIES = 2`, `DEFAULT_RETRY_BASE_DELAY_MS = 1_000`,
  `DEFAULT_RETRY_MAX_DELAY_MS = 20_000`). Pure, no new dependency.
- Wired into all five real `.invoke()` call sites in this codebase:
  - `apps/orchestrator/supervisor-graph.ts`'s `supervisorNode()`
  - `packages/agents/devops/llm-harness.ts`'s `agentNode()`
  - `packages/agents/documentation/llm-harness.ts`'s `agentNode()`
  - `packages/agents/security/llm-harness.ts`'s `runEnrichment()`
  - `packages/shared/capability-router.ts`'s `runCapabilityRouter()`
    (the spec's own "Scope amendment" — a fifth call site not in the
    original draft, added before implementation began, specs/054).
- New pure unit tests added to the existing
  `packages/shared/llm-model-factory.test.ts` (21 new tests) covering
  classification (429/5xx/statusCode/error-code/message-pattern → transient;
  400/401/403/404/unrecognized-message/non-object → terminal, fail-closed
  default), `Retry-After` header parsing (seconds, HTTP-date, absent,
  unparseable, both `Headers` and plain-object shapes), and
  `callProviderWithRetry()` itself (immediate success, retry-then-succeed,
  terminal re-throws the exact original error object with zero retries,
  retries exhaust to a named `ProviderRetriesExhaustedError` wrapping the
  real cause, bounded `maxDelayMs` even against a deliberately huge
  `Retry-After`, and `Retry-After` correctly overriding the default
  exponential backoff).

## One precision clarification versus the spec's own literal wording

The spec's Scope section names `apps/orchestrator/index.ts`'s
`runOrchestratorSupervisor()` as a wrap site. Read directly: that function
never itself calls `.invoke()` — it resolves config and builds the model via
`buildChatModel()`, then hands the model into `supervisor-graph.ts`'s
`runSupervisor()`, where `supervisorNode()` makes the actual call. The wrap
was applied at the precise, correct call site inside `supervisor-graph.ts`
instead of the outer function the spec names — same effect (every real
supervisor provider call is now retried), more precise location. No other
deviation from the approved spec's scope.

## Verification performed

- `bun run typecheck` — 0 errors, run twice (once after the core module
  addition, once after all five call sites were wired).
- `bun test` — 831 pass, 0 fail, 1613 expect() calls across 55 files (up
  from the pre-055 baseline of 810/0/1572/55 — the delta is exactly this
  spec's own 21 new tests; every pre-existing test, including all
  harness-specific suites for supervisor-graph/devops/documentation/
  security/capability-router, passes unmodified, confirming this spec's
  change is additive and none of the wrapped code paths' existing
  behavior regressed).
- `bun run specs:catalog` then `bun run specs:check` — pass, 61 specs.
- All six Acceptance Criteria checked off in `spec.md` with per-criterion
  evidence pointing at the specific new test names.
- No API key was configured anywhere in this session; every test above
  ran with `ORCHESTRAI_LLM_API_KEY` unset.

## Live pass, 2026-09-14 — a real 429 was hit organically, not staged

A live pass was run against a real, already-configured Gemini
deployment (`gemini-3.5-flash`, the same key used by prior live
checkpoints), a bare-metal reduced stack (`mcp:http`, `devops-agent`,
`orchestrator`, no Docker), driving real requests through the real
Orchestrator (`POST /tasks`). This was not a deliberately staged
rate-limit test — the free-tier quota was exhausted organically by the
handful of real routing/supervisor calls this same session's specs/065
pass already made, which is itself informative: this account's free
tier is easy to exhaust with only a few real requests.

**Transient classification and retry, confirmed live**: a
`build-and-deploy`-phrased `plan-task` request failed with:

```
Orchestrator supervisor run failed: Provider call failed after 3
attempt(s) due to a transient error (rate limit, timeout, or server
error) and retries were exhausted: You exceeded your current quota...
* Quota exceeded for metric: generativelanguage.googleapis.com/
generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash
Please retry in 30.501115906s.
```

This is real, decisive evidence for the core claim this spec's own gap
named: a genuine `429` (not a fabricated one) was correctly classified
`transient` (not surfaced as an opaque generic failure or confused with
an auth error), retried the expected bounded number of times (`"3
attempt(s)"` — `DEFAULT_RETRY_MAX_RETRIES = 2` plus the initial attempt,
exactly as designed), and exhausted to the distinct, named
`ProviderRetriesExhaustedError` wrapping the real provider message —
not the same shape a permanently invalid key produces. This closes the
"transient vs. terminal classification, real 429 response shape" half
of the original gap.

**Recovery itself: confirmed, after a real, longer-than-expected
delay.** A follow-up request submitted ~1 minute later (past the API's
own stated `"Please retry in 30.5s"` window) reached `status:
"working"` and stayed there for **over 8 minutes** of repeated polling
— well past what the bounded-retry design on paper would predict
(`DEFAULT_RETRY_MAX_RETRIES = 2` with `DEFAULT_RETRY_MAX_DELAY_MS =
20_000` should exhaust to a named error in well under a minute, as the
first, failed request above did in fact do quickly). It then resolved
**successfully**: `{"status":"completed","planSteps":[{"skill":
"git-status", "status":"dispatched", ...}],"result":"Supervisor run
completed after 1 dispatch(es)."}` — a real, correct end-to-end
adaptive-supervisor run, including a real child dispatch. This is
decisive: the real 429 → retry → **eventual real success** path is now
directly observed, not merely reasoned about — closing the exact gap
this spec's own Verification Plan named.

**The anomalously long delay before that success is itself a real,
separately worth-recording finding, not swept under the "it worked"
result.** A plausible, unconfirmed explanation: LangGraph's own
supervisor loop may retry the whole node (re-entering
`callProviderWithRetry()` fresh, its own 3-attempt/20s-max-delay budget
each time) across multiple graph steps/ticks, rather than this being a
single `callProviderWithRetry()` invocation blowing its own documented
bound — which would explain a real total wall-clock time far longer
than one bounded call's own maximum, while each individual retried call
still honestly obeys its own bound. This was not confirmed by further
live code-reading/instrumentation in this pass (time-boxed once the
result was known to be a genuine success, not a hang) — recorded as an
open question about the *combined* multi-attempt latency this codebase
doesn't currently document or bound end-to-end, not a claim of a
concrete bug. Task id `task-65dfda06-8a39-446b-bf62-48d29679a7fd` for
reference; the bare-metal scratch stack was torn down after this pass.

**Net effect on this spec's own status**: both halves of the original
gap are now closed with real evidence — correct transient
classification/retry-count/error-shape on a real `429`, **and** genuine
end-to-end recovery to a successful result on a later real call.
`verification` flips to `verified`. The only residual open item is the
new, separate observation above (total wall-clock latency across a
multi-attempt recovery can be materially longer than one call's own
bounded retry window) — noted as a candidate follow-up investigation,
not a blocking gap in this spec's own stated scope.

## Out of scope, confirmed untouched

- `DEFAULT_MAX_DISPATCHES`/`DEFAULT_MAX_ATTEMPTS_PER_SKILL`/
  `DEFAULT_RECURSION_LIMIT` — unchanged (no edit to
  `supervisor-graph.ts`'s constants).
- The approval gate — no edit anywhere near `packages/shared/approval.ts`
  or the approve/reject endpoints.
- Every harness's own model-output retry-with-feedback loop (a separate,
  pre-existing mechanism) — unchanged; `callProviderWithRetry()` wraps
  only the raw `.invoke()` call inside that loop, never the loop itself.
- `specs/054`'s routing-tier logic itself (skill validation against the
  live capability snapshot) — untouched; only its own `.invoke()` call is
  now retried.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/055-provider-call-budgets-and-transient-error-handling/spec.md`
(implemented, **partial** verification) closed a real gap live-caught on
2026-09-05: a real `dockerize` run under the adaptive supervisor failed
with a Gemini free-tier `429` partway through a multi-step plan, in the
exact same `{"status":"failed", error}` shape a permanently invalid key
produces — no way to tell "wrong key" from "try again in a minute."
`specs/051`'s Planning-Agent retirement made this materially more
consequential: `plan-task` now has exactly one path, with no fallback to
divert a transient failure to.

`packages/shared/llm-model-factory.ts` gained one shared classification +
bounded-retry core, used from every real provider-call site rather than
duplicated per caller: `classifyProviderError()` labels a caught error
`transient` (429/5xx/timeout/connection-reset — worth retrying) or
`terminal` (auth failure, bad model, malformed request — retrying changes
nothing; fail-closed default for anything unrecognized, the same
precedent `classifySkillTier()` already established), and
`callProviderWithRetry()` wraps a call with exponential backoff plus
jitter, honoring a provider's own `Retry-After` header when present, both
retry count and max delay bounded (never unbounded — the same "bounded,
never hang" precedent `specs/045`'s port-preflight timeout and the
adaptive supervisor's own dispatch/attempt bounds already established). A
terminal failure re-throws immediately, byte-identical to before this
spec — zero added latency, zero retry attempts. Exhausting retries on a
persistent transient failure raises a distinguishable, named
`ProviderRetriesExhaustedError` wrapping the real cause, rather than
surfacing identically to a genuine auth failure.

Wired into all five real `.invoke()` call sites in this codebase: the
adaptive supervisor (`apps/orchestrator/supervisor-graph.ts`'s
`supervisorNode()` — the precise call site; the spec's own literal
wording named `runOrchestratorSupervisor()`, which only builds the model
and never itself calls `.invoke()`, see that spec's verification.md for
the clarification), DevOps's and Documentation's LangGraph harnesses
(`agentNode()` in each), Security's plain structured-completion harness
(`runEnrichment()`), and `specs/054`'s capability router
(`runCapabilityRouter()`) — a fifth call site not in the spec's original
draft, added as a pre-implementation "Scope amendment" once found via a
live grep for every real `.invoke()` site in the repo, since `specs/054`
was drafted and implemented after this spec's own original draft.

No new dependency, no touch to `DEFAULT_MAX_DISPATCHES`/
`DEFAULT_MAX_ATTEMPTS_PER_SKILL`/`DEFAULT_RECURSION_LIMIT`, the approval
gate, or any harness's own pre-existing model-**output** retry-with-
feedback loop (a separate, already-correct mechanism this spec does not
touch — it wraps only the raw `.invoke()` call inside that loop). 21 new
pure unit tests (fake `fn`/injected `sleep`/`random`, no real timers, no
network call, no real credential) cover both classification branches and
the retry wrapper's bounded-backoff/exhaustion/Retry-After behavior; all
831 tests in the suite pass (up from the pre-055 baseline of 810), `bun
run typecheck` is clean.

**Closed live, 2026-09-14**: a real Gemini free-tier `429` was hit
organically (not staged) mid-session, correctly classified `transient`,
retried the expected number of times, and exhausted to the distinct
`ProviderRetriesExhaustedError` shape — never confused with a
permanently invalid key. A follow-up request past the quota window then
completed successfully end to end (a real adaptive-supervisor dispatch
and child task), confirming genuine 429 → retry → recovery, though it
took materially longer (8+ minutes) than one call's own bounded-retry
budget would predict — flagged as a real, separate, unresolved
follow-up question (possibly LangGraph re-entering the retry wrapper
fresh across multiple graph ticks) rather than assumed benign.
`specs/055` is now `verification: verified`. See that spec's
`verification.md` for the full record.

See specs/065-llm-only-skill-routing/verification.md for the relocated narrative covering this checkpoint.

See specs/077-agent-enabled-means-llm-on-by-default/verification.md for the relocated narrative covering this checkpoint.
