---
id: 090-devops-security-precheck-timeout-too-short
title: "DevOps's Own Security Secrets Pre-check Times Out Now That Security's AI Commentary Is Default-On"
area: agents
change_type: fix
status: implemented
verification: verified
created: 2026-09-15
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-15
implemented_on: 2026-09-15
amends:
  - 077-agent-enabled-means-llm-on-by-default
  - 043-llm-harness-security
related:
  - 076-run-tests-timeout-mismatch
  - 080-run-command-approved-execution
  - 055-provider-call-budgets-and-transient-error-handling
supersedes: []
superseded_by: []
---

# Spec: DevOps's Own Security Secrets Pre-check Times Out Now That Security's AI Commentary Is Default-On

> Review gate: **APPROVED 2026-09-15 by Yusuf.**
>
> Found live, 2026-09-15, running a real `analyze-project` request against a real
> stack. The response completed successfully (fail-open, as designed) but carried:
> `"Security pre-check unavailable: A2A call timeout"`. Traced directly, not
> assumed — this is the same "a default flip made a downstream call slower, and a
> hardcoded client-side timeout calibrated for the old, faster behavior was never
> revisited" bug class this codebase has already hit and fixed twice before
> (`specs/076`, `specs/080`'s own `docker_build` timeout).

## Purpose

`skillAnalyzeProject()` (`packages/agents/devops/index.ts`) makes one direct,
Orchestrator-bypassing A2A call to Security for a quick secrets pre-check,
bounded by a hardcoded `timeoutMs: 5_000`. This was calibrated back when
`scan-secrets` was always a fast, purely deterministic file scan. Since
`specs/077-agent-enabled-means-llm-on-by-default/spec.md` (2026-09-14) flipped
`ORCHESTRAI_SECURITY_LLM_HARNESS` to default-on, **every** `scan-secrets` call —
this internal pre-check included — now makes a real LLM round-trip for AI
commentary (`specs/043`) before returning. `specs/077` never revisited this
specific 5-second client-side budget, and a normal real provider round-trip can
now exceed it under completely healthy conditions — not a rare edge case, an
expected outcome of the new default.

## Verified Current State

- **Reproduced live**, not theorized: a real `analyze-project` dispatch against
  this repository, real stack, real Gemini key. `security-agent`'s own
  `/healthz` reported healthy throughout. The pre-check call
  (`packages/agents/devops/index.ts:535-540`) took `5105ms` and hit its own
  `timeoutMs: 5_000` bound by 105ms — the exact boundary-crossing shape this
  bug predicts, not a wild outlier.
- `packages/agents/security/model-factory.ts:37`: `isHarnessFlagSet()` is
  `env.ORCHESTRAI_SECURITY_LLM_HARNESS !== "0"` — default-on, confirmed
  directly (`specs/077`).
- `packages/agents/security/index.ts:246-290`: `skillScanSecrets()`
  unconditionally wraps its deterministic result in `withAiCommentary()` — there
  is no existing signal from a caller (internal A2A or otherwise) to skip
  commentary for a specific call. The pre-check's own caller
  (`callAgent("security", ..., { selectedSkill: "scan-secrets" })`) forces the
  correct **skill** (`specs/030`'s own authoritative-dispatch guarantee) but has
  no way to also say "and skip the commentary layer."
- **This is fail-open, not fail-closed, by design** (`specs/043`'s own
  precedent) — the pre-check's own timeout already degrades gracefully to an
  honest warning, never blocking `analyze-project`'s own real, useful result.
  The bug is a **reliability/UX regression** (a healthy system now flakily
  reports "pre-check unavailable" under normal conditions), not a safety gap.

## Proposed Behavior

**Bump the client-side timeout, the same minimal fix shape `specs/076`/`080`
already used for the identical bug class.** `timeoutMs: 5_000` →
`timeoutMs: 45_000` in `skillAnalyzeProject()`'s own `callAgent()` call.

**Correction, same day, found while live-verifying the first draft of this
fix**: an initial attempt at `20_000` was itself still undersized — a real,
directly-timed `scan-secrets` call against this repository (172 files, 42
real findings, real AI commentary generated over every one of them) took
**~30 seconds** end to end, not comfortably under 20s as originally assumed.
`45_000` was chosen to hold a real margin above that measured worst case
(not just clear it exactly), grounded in an actual measurement rather than
an estimate — the same "verify, don't assume" discipline this session's
other timeout fixes (`specs/076`/`080`) were held to. A pathological worst
case (multiple stacked provider-retry attempts, `specs/055`'s own bounded
backoff, nested inside `specs/043`'s own schema-validation retry-with-
feedback) could still in principle exceed even 45s; that remains an
accepted, already-fail-open outcome — this fix closes the measured common
case with real margin, not every theoretical one, matching the "best-effort,
never a hard dependency" nature of this pre-check by design.

No protocol change, no new parameter, no change to `withAiCommentary()` or
`scan-secrets`'s own behavior for any other caller — this is a single number
in one file.

## Scope

- `packages/agents/devops/index.ts`: the one `timeoutMs` value in
  `skillAnalyzeProject()`'s own `callAgent()` call.
- Tests: a focused test confirming the new bound (existing DevOps A2A tests
  likely already assert the old value directly — update to match, and add a
  case proving a real call in the 5-45s window now succeeds instead of timing
  out).
- **Out of scope**: any change to `scan-secrets`'s own AI-commentary layer,
  `withAiCommentary()`, or Security's default-on state (`specs/077`) — this
  spec does not reconsider that decision, only brings a downstream timeout in
  line with its now-real consequence. A future "let a caller opt a specific
  A2A call out of commentary entirely" enhancement was considered and
  rejected here as unnecessary scope for what is fundamentally a one-line
  timeout fix — named as a possible follow-up, not attempted.

## Safety and Compatibility Constraints

- **Strictly additive**: only widens how long the pre-check will wait before
  giving up; the fail-open warning path, its exact wording, and every other
  behavior are unchanged.
- **Still bounded** — 45s is a real, finite budget, not `Infinity`; the
  "bounded, never hang" precedent (`specs/045`, `specs/055`) is preserved.

## Out of Scope / Non-Goals

- Reconsidering `specs/077`'s own default-on decision.
- A caller-level "skip AI commentary" signal for `scan-secrets` — a real,
  architecturally cleaner alternative that was considered and set aside as
  unnecessary scope for this fix; if the timeout bump alone doesn't hold up
  under further live use, this is the natural next escalation.
- Any change to `specs/055`'s own retry/backoff bounds.

## Acceptance Criteria

- [x] `skillAnalyzeProject()`'s own pre-check timeout is `45_000`, not `5_000`.
- [x] Existing DevOps A2A tests pass (none asserted the old value directly).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact scenario that surfaced this — a real
      `analyze-project` dispatch against this repository with Security's
      harness on — completes with a genuine secrets pre-check result, not
      the "A2A call timeout" warning, under normal conditions.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

See `verification.md` for the full transcript, including the real
correction made mid-verification (`20_000` proved undersized; `45_000`
is grounded in an actual measurement).

## Verification Plan

- Unit: the updated timeout value asserted directly; a mocked ~10-15s-latency
  security response confirmed to now succeed (previously would have timed
  out at the old 5s bound).
- Live, with a real provider key (already available this session): the exact
  `analyze-project` request that surfaced this, re-run against the real
  stack, confirming a genuine (not fail-open) pre-check result.

## Approval Requested

Approve to proceed. A small, surgical, low-risk fix — the same minimal shape
(`specs/076`/`080`) this codebase has already used twice for the identical
class of bug.
