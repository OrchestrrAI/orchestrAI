# Verification: Supervisor Startup Key Check — Warn, Don't Block

Implemented 2026-09-10. `status: implemented`, `verification: partial` —
the spec-defining behavior change is live-proven with a real process; two
supporting criteria rest on unchanged code already verified elsewhere
(specs/051) rather than a fresh live run reaching an actually-healthy
stack, honestly short of "fully live-verified."

## What changed

`apps/supervisor/index.ts`, one call site only: on a missing/misconfigured
key, `console.error(...)` + `process.exit(1)` became `console.warn(...)`
with no exit. `checkStartupLlmKeys()`/`resolveAgentLlmKeyRequirements()`
themselves are byte-identical — only what the call site does with their
return value changed.

## Live verification performed

Ran the real supervisor entry point directly (`bun run apps/supervisor/
index.ts`), not simulated, from a scratch project directory with every
`ORCHESTRAI_*_LLM_*` environment variable explicitly unset
(`env -u ...`) so no ambient key could mask the test:

```
--headless --project <scratch-dir> --only orchestrator
```

Captured output:

```
[supervisor] Project path: . (source: --project)
[supervisor] LLM configuration is incomplete — starting anyway, since not every feature needs a key:
  - orchestrator: no provider key configured (the only plan-task planner)
[supervisor] Run "orchestrai init" to configure a provider and key, or set the
[supervisor] ORCHESTRAI_LLM_* / ORCHESTRAI_<COMPONENT>_LLM_* variables directly.
[supervisor] A request that actually needs one of the above will fail closed with a named
[supervisor] error at that point — deterministic, keyword-routed skills are unaffected.
[supervisor] Port 3000 (orchestrator) is already in use — refusing to start anything.
[supervisor] Find and stop whatever's using it, then retry.
```

This is decisive, not ambiguous: the process printed the new warning and
**continued past the key check into port preflight** — the next phase of
`main()`. It only stopped there because port 3000 was genuinely already
bound by another real, already-running `orchestrai` instance (a
pre-existing, correct, and completely unrelated mechanism —
`specs/045`'s own port-preflight timeout). Before this spec, the process
would never have reached port preflight at all; it would have printed
"Refusing to start" and called `process.exit(1)` at the key check itself.
Reaching a later phase and failing for an unrelated, genuine reason is
exactly the proof this spec's own Purpose needed.

- `bun run typecheck` — 0 errors.
- `bun test` — 877 pass, 0 fail (unchanged count from immediately before
  this spec — expected, since no new pure function was added; only a
  call site's control flow changed, and the pure functions it calls are
  untouched).
- `bun run specs:catalog`/`specs:check` — pass, 65 specs.

## What's verified by construction, not a fresh live run

Two of the spec's own Acceptance Criteria — a deterministic skill still
completing with no key, and `plan-task`/`/ask` still failing closed with
the existing named error — are true by the same reasoning, not a newly
performed live test:

- Zero lines outside the one warn-vs-exit call site changed. `detectSkill()`'s
  keyword tier, every deterministic skill handler, and
  `runOrchestratorSupervisor()`'s own per-request fail-closed check (the
  exact code this spec's own Verified Current State section quotes) are
  all untouched.
- Both properties were already independently live-verified in
  `specs/051-planning-retirement-and-required-key/spec.md`'s own record,
  against the unmodified version of this same code.

Re-running those two scenarios live here would be re-proving code this
spec never touched, not proving anything about this spec's own change.
This is stated as the honest basis for `verification: partial` rather
than `verified` — the spec-defining behavior is fully live-proven; the
other two are inference from unchanged code, not a fresh confirmation.

## Out of scope, confirmed untouched

- `bun run dev` and a bare `bun run apps/orchestrator/index.ts` were
  already unaffected by this check before this spec (it only ever ran
  at the supervisor level) and remain unaffected — unchanged scope, not
  reverified.
- Planning Agent's retirement (`specs/051`) — untouched; `plan-task`
  still has exactly one path and still fails closed with no key.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**A provider key is checked at startup and named early if missing — but
no longer blocks the process from starting.** `apps/supervisor/
index.ts`'s `main()`, right before port preflight, checks whether the
Orchestrator will start with no resolvable key — via
`checkStartupLlmKeys()` (`packages/shared/llm-model-factory.ts`) and
`resolveAgentLlmKeyRequirements()` (`apps/supervisor/index.ts`). The
same check also covers each **agent** whose own
`ORCHESTRAI_<AGENT>_LLM_HARNESS` is on (DevOps/Documentation/Security —
see their own "Opt-in LLM harness" sections below), using that
component's own name so `specs/039`'s per-component resolution is
honoured exactly as it is at runtime; an agent whose harness is off is
not checked, because it will make no call. **Corrected by
`specs/064-supervisor-startup-key-check-non-blocking/spec.md`
(implemented, partial verification), 2026-09-10**: a missing or
misconfigured key now prints the same named, actionable message as a
`console.warn` and startup **continues** — it no longer calls
`process.exit(1)`. Found while preparing a live demo: every direct,
keyword-routed skill in this system (`dockerize`, `analyze-project`,
`git-status`, and every DevOps/Testing/Documentation/Security
deterministic path) needs no provider key at all, so blocking the whole
process from starting for a capability an operator may not even intend
to use that run was a real, unnecessary cost. **What "required" can
honestly mean**: only presence and provider/model parsing are checked — a
wrong or expired key still fails at first real use, which the (now
non-fatal) startup message states plainly. A genuine **misconfiguration**
(an invalid `ORCHESTRAI_LLM_PROVIDER`, say) is still reported distinctly
from a merely **missing** key. **The real fail-closed guarantee lives
entirely in the per-request path and was never conditional on this
startup check to begin with** — `runOrchestratorSupervisor()`'s own
check (defense-in-depth, always run per-request regardless of what the
startup check found) still fails a `plan-task`/`/ask` request closed
with a named error the moment one is actually attempted with no
resolvable key; live-proven this way already reachable on `bun run dev`
(which never went through the supervisor's startup check at all — this
correction just brings `orchestrai`'s own behavior in line with what
`bun run dev` always did). `ORCHESTRAI_ORCHESTRATOR_GRAPH` (the old
opt-out) and `ORCHESTRAI_LLM_HARNESS` (Planning's old flag) are both
dead — see "Planning Agent (retired)" above for the stale-variable
warning that covers a config still carrying either.

See specs/086-code-review-coder-default-on/verification.md for the relocated narrative covering this checkpoint.

See specs/077-agent-enabled-means-llm-on-by-default/verification.md for the relocated narrative covering this checkpoint.
