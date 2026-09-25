# Verification: Capability-Driven LLM Routing Tier

Date: 2026-09-06 (updated 2026-09-15)

Result: **verified**. Every Acceptance Criterion is met, test-proven against an injected model double, and — as of the 2026-09-15 live pass — confirmed against a real model.

## What changed

- `packages/shared/capability-router.ts` (new) — `runCapabilityRouter()`,
  a single structured-output completion with a plain bounded
  retry-with-feedback loop (mirroring `packages/agents/security/
  llm-harness.ts`'s exact shape — no LangGraph, since there is no tool
  to call). `CapabilityRouterProposalSchema` (Zod) validates
  `{skillId, target, confidence, reason, kind}`; the `UNSUPPORTED_SKILL_ID`
  sentinel is a valid, non-error response.
- `apps/orchestrator/index.ts`:
  - `detectSkill(text, deps?: {model?})` — the `deps` parameter is
    additive and optional (every pre-existing call site, single-argument,
    is unaffected); it exists solely so this spec's own tests can inject
    a fake model without a live network call.
  - After the semantic classifier (`classifyIntent()`) misses, a new
    `tryCapabilityRoute()` step runs before the `"plan-task"` default:
    builds the live `buildCapabilitySnapshot()` (returns immediately with
    no model call if there's nothing online to route to), resolves the
    Orchestrator's own already-existing `"orchestrator"` LLM component
    config (`readLlmModelConfig(process.env, "orchestrator")` — the same
    config the adaptive supervisor already uses; no new credential
    requirement), and only then calls `runCapabilityRouter()`. The
    returned proposal is validated against the exact same live snapshot
    the model was given — a skill not in it (offline, or hallucinated)
    never dispatches.

## Verified

- `bun run typecheck` — 0 errors.
- `bun test` — 758 pass, 0 fail, 1480 expectations across 51 files (up
  from 743/1460: 8 new `capability-router.test.ts` cases, 7 new
  `capability-router-detect-skill.test.ts` cases).
- **All 36 pre-existing `detect-skill.test.ts` tests pass unmodified** —
  direct proof the keyword and semantic-classifier tiers are
  byte-identical to before this spec. The router tier is structurally
  unreachable for any phrase those two tiers already resolve (it sits
  strictly after both `return` statements), and for the tests that do
  reach it (genuinely unmatched phrases), `buildCapabilitySnapshot()`
  correctly returns `null` against this test file's own empty registry
  — visible directly in the real "Capability snapshot unavailable" log
  line, confirming zero model-call attempts, not just an assumed
  no-op.
- **`packages/shared/capability-router.test.ts`** (8 tests, a scripted
  fake `BaseChatModel`, no live network): a well-formed proposal
  validates first try; the `unsupported` sentinel is accepted as a valid
  (non-error) response; malformed JSON and a schema-violating response
  each trigger retry-with-feedback then succeed; exhausted retries fail
  closed to `null`; a model that throws (API error/timeout) fails closed
  immediately with no retry; a markdown-code-fence-wrapped response is
  still parsed; an out-of-range `confidence` is rejected and retried.
- **`apps/orchestrator/capability-router-detect-skill.test.ts`** (7
  tests, real `registry.set()` + injected fake model, no live network):
  - Router **never consulted** when a keyword match already exists —
    `model.callCount === 0` for a keyword-matched phrase.
  - Router **reached** only for a phrase confirmed genuinely out-of-scope
    for both prior tiers (`"what is the weather in cairo today"` — the
    exact phrase `detect-skill.test.ts`'s own semantic-fallback suite
    already established misses both), and a valid proposal is used.
  - A proposal naming a real skill id (`dockerize`) that is **not** in
    this test's own live snapshot never dispatches — falls through to
    `plan-task`.
  - The `unsupported` sentinel falls through to `plan-task`.
  - An unparseable/exhausted-retry router response fails closed to
    `plan-task`, not a crash.
  - An empty registry (nothing online) means the router is **never even
    attempted** — `model.callCount === 0`, proving the "no online
    capability" short-circuit happens before any model construction.
  - A write-capable skill (`dockerize`) named by the router is returned
    exactly like any other skill id — `detectSkill()`'s return value is
    unmodified by which tier produced it, and the caller's existing
    approval-gate dispatch path is untouched by this spec (confirmed by
    code inspection: `dispatchRootTask()`'s handling of `detectSkill()`'s
    result has no branch on which tier resolved it).

## Closed live, 2026-09-15

**Note on the original scenario's own wording**: this item originally
asked for "a phrase that genuinely misses both existing tiers" (keyword
+ semantic classifier), since at the time this spec was drafted the
router was strictly the third, subordinate tier. `specs/065` (approved
and implemented later, 2026-09-10) deleted both of those tiers — the
router is now the *only* tier, so every phrase reaches it, not just ones
that miss two prior stages. This makes the original scenario framing
obsolete, but the underlying property it exists to confirm — a real
model genuinely reached, its proposal validated against the live
snapshot, dispatch proceeding correctly, and the adversarial
offline/unsupported-skill case failing closed — is exactly what was
closed live this session (see `specs/065`'s own `verification.md`,
"Update 2026-09-15" section, for the full transcript): `"dockerize my
app"` → real `dockerize`/`devops-agent` proposal, dispatched correctly;
`"scan for secrets"` → real `scan-secrets`/`security-agent` proposal,
dispatched correctly; a request naming a skill no agent offers
(`"translate this document into spanish"`) → correctly fell through to
`plan-task` rather than hallucinating or misrouting.

This closes the spec's own last open item with real evidence, not a
mock. `verification` moves from `partial` to `verified`.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/054-capability-driven-llm-routing/spec.md` (implemented,
**verified**, 2026-09-15) adds a third, strictly subordinate routing tier — an LLM
router — consulted only when both the keyword stage above and the local
semantic classifier miss. `packages/shared/capability-router.ts`'s
`runCapabilityRouter()` is a single structured-output completion with a
plain bounded retry-with-feedback loop (mirroring Security's own harness
shape — no LangGraph, since there's no tool to call). It receives the
current, live `buildCapabilitySnapshot()` output (never a separately
hardcoded ownership list) and the raw request text, and must return one
skill id already present in that snapshot, or the explicit
`"unsupported"` sentinel — never a free-form string. The Orchestrator
validates the proposal against that exact same live snapshot before ever
using it: a skill not currently online (or a hallucinated id never in
the list) falls through to the existing `"plan-task"` default, never a
best-effort dispatch. The router resolves the same `"orchestrator"`
per-component LLM config the adaptive supervisor already uses
(`specs/039`) — no new credential requirement; with no key configured,
this tier is simply unreachable, and `detectSkill()`'s behavior for
every phrase the keyword/classifier tiers already resolve is unchanged
(confirmed: all 36 pre-existing `detect-skill.test.ts` tests pass
unmodified). `detectSkill()` gained one additive, optional parameter
(`deps?: {model?}`) purely so its own tests can inject a fake model with
no live network call — every pre-existing single-argument call site is
unaffected. The approval gate is completely untouched: a router-named
write-capable skill is returned by `detectSkill()` exactly like any
other skill id, and reaches the identical `actionId`-bound flow.
**Closed live, 2026-09-15**: the router-as-only-tier reality `specs/065`
later introduced meant every phrase now reaches this router directly
(there are no keyword/classifier tiers left to miss first); real
dispatches for `"dockerize my app"` and `"scan for secrets"` each
produced a correct real proposal, and a request naming a skill no agent
offers (`"translate this document into spanish"`) correctly fell
through to `plan-task` rather than hallucinating one. See that spec's
own `verification.md` for the full record.

Unless the team changes scope, the next work should generally follow this order:

1. Keep documentation and handoff context accurate.
2. ~~Add reproducible type checking and broader repository tests/CI.~~ Done
   — see `specs/014-typecheck-ci/spec.md` (0 type errors, `bun run typecheck`
   real and passing).
3. ~~Convert the remaining agents (Testing, Documentation, Security) to MCP
   clients.~~ Done — see `specs/011-remaining-agents-mcp/spec.md` (Security
   deliberately stayed direct-fs by decision).
4. ~~Add Dockerization and a CI workflow.~~ Done — see
   `specs/009-dockerization/spec.md` (live-verified) and
   `.github/workflows/ci.yml`.
5. ~~Add a robust `orchestrai` supervisor.~~ Done — see
   `specs/016-orchestrai-supervisor/spec.md` (`bun run orchestrai`).
   ~~Compiled binary distribution.~~ Also done — see
   `specs/017-standalone-binary-distribution/spec.md` (`bun run build` →
   `dist/bin/orchestrai[.exe]`, one ~106 MB standalone executable). Wiring
   the TUI to sit on top of the supervisor's own process-status layer
   (rather than just being an Orchestrator HTTP client, as it is today)
   remains an explicitly deferred follow-up.
6. Continue improving routing/planning while preserving deterministic safety
   policy. ~~Remaining known gaps: Testing's direct Orchestrator routing,
   the `ci`-substring and `"set up"` keyword issues.~~ Done — see
   `specs/015-routing-planning-polish-2/spec.md`. ~~Add a local semantic
   fallback for keyword-unmatched requests.~~ Done — see
   `specs/020-semantic-intent-fallback/spec.md` (Model2Vec static embeddings,
   not an LLM, no network call). ~~Add LLM-based routing as a supplement
   to, not a replacement for, deterministic approval enforcement.~~ Done
   — see `specs/054-capability-driven-llm-routing/spec.md` (a third,
   strictly subordinate tier below keyword and the local classifier,
   validated against the live capability snapshot; the approval gate is
   completely untouched). `verification` stays `partial` pending a live
   real-provider pass.

See specs/065-llm-only-skill-routing/verification.md for the relocated narrative covering this checkpoint.

See specs/075-real-conversational-chat/verification.md for the relocated narrative covering this checkpoint.

See specs/055-provider-call-budgets-and-transient-error-handling/verification.md for the relocated narrative covering this checkpoint.

See specs/101-per-agent-tool-access-expansion/verification.md for the relocated narrative covering this checkpoint.

See specs/020-semantic-intent-fallback/verification.md for the relocated narrative covering this checkpoint.
