---
id: 065-llm-only-skill-routing
title: LLM-Only Skill Routing — Retire Keyword Matching and the Local Classifier
area: routing-planning
change_type: migration
status: implemented
verification: partial
created: 2026-09-09
updated: 2026-09-10
approved_by: Yusuf
approved_on: 2026-09-10
implemented_on: 2026-09-10
amends:
  - 020-semantic-intent-fallback
  - 054-capability-driven-llm-routing
  - 052-ci-plan-task-dispatch-smoke-test
related:
  - 030-authoritative-skill-dispatch-and-capability-catalog
  - 051-planning-retirement-and-required-key
  - 064-supervisor-startup-key-check-non-blocking
supersedes: []
superseded_by: []
---

# Spec: LLM-Only Skill Routing — Retire Keyword Matching and the Local Classifier

> Review gate: **APPROVED 2026-09-10 by Yusuf.** Written in response to
> Yusuf's own request, 2026-09-09: "I need to remove all deterministic
> from the project" —
> narrowed via two rounds of AskUserQuestion to: skill-routing
> determinism only (not the approval-gate's own read-only/write-capable
> safety classification, which stays untouched), driven by making the
> product feel like genuine AI reasoning rather than string matching,
> with **every** request — including meta-queries like "what agents do
> you have" — going through the LLM, and CI adapted with a real funded
> provider key rather than redesigned around dependency injection.

## Purpose

Today, `detectSkill()` (`apps/orchestrator/index.ts`) resolves a skill in
three tiers, in order: (1) ~15 hardcoded keyword/substring checks
(`dockerize`, `gitignore`, `secret`, `coverage`, `plan`/`build`/`deploy`,
etc.); (2) a local Model2Vec semantic classifier
(`specs/020-semantic-intent-fallback/spec.md`) consulted only when every
keyword branch misses; (3) the LLM capability router
(`specs/054-capability-driven-llm-routing/spec.md`), consulted only when
both of the above miss. For the overwhelming majority of realistic
requests, a request never reaches the LLM at all — it's decided by
string matching before the model is ever consulted, which is correct and
efficient but reads, to anyone watching a live demo, as "this isn't
really using AI to decide anything."

This spec retires tiers (1) and (2), making the LLM capability router
(3) the **only** way any natural-language request resolves to a skill.
The mechanism this promotes to sole authority already exists, is already
validated against the live agent registry before ever being trusted, and
already fails closed to `plan-task` on every non-happy path (no key, no
match, a hallucinated skill id) — this is a promotion of an existing,
tested component from third-tier fallback to first-and-only tier, not
new routing infrastructure.

## Verified Current State

Read from the current code, 2026-09-09:

- `detectSkill()`'s three-tier order (`apps/orchestrator/index.ts`
  ~lines 394–453): keyword `.includes()` checks first, `classifyIntent()`
  (specs/020) second, `tryCapabilityRoute()` (specs/054) third,
  defaulting to `"plan-task"` if all three miss.
- `tryCapabilityRoute()` already fails closed to `null` (→ the existing
  `"plan-task"` default) on **every** non-happy path — no online
  capability, no resolvable LLM config (including no key at all), an
  exhausted-retry/malformed model response, or a proposal naming a skill
  outside the live snapshot. This property is unconditional in the code
  today, not something this spec needs to add.
- `buildCapabilitySnapshot()` (~line 499) builds its entries **only**
  from registered agents' own advertised skills (`agent.card.skills`) —
  it does not include any of the Orchestrator's own meta-skills.
  `suggest-agents` is currently resolved entirely by keyword match
  (`"suggest"`/`"what agent"`) and served synchronously by
  `buildSuggestAgentsReply()`, never reaching the capability router or
  any agent dispatch. **The router cannot currently route to
  `suggest-agents` at all** — it isn't in the snapshot the router is
  given, and the router's own validation (`validSkillIds.has
  (proposal.skillId)`) would reject a proposal naming it even if the
  model guessed correctly.
- `.github/workflows/ci.yml`'s dispatch smoke test
  (`specs/052-ci-plan-task-dispatch-smoke-test/spec.md`) currently
  proves `plan-task` and `suggest-agents` both dispatch correctly using
  a **deliberately non-functional** `ORCHESTRAI_LLM_API_KEY`. This works
  today specifically because `suggest-agents` is keyword-matched (no LLM
  call happens for it at all) and `plan-task`'s own initial dispatch
  response returns before its real LLM call is even awaited. Neither
  property survives this spec's own change: `suggest-agents` would need
  a genuine, correct LLM routing decision to be assigned at all.
- `apps/orchestrator/detect-skill.test.ts` (10 test cases) and
  `apps/orchestrator/capability-router-detect-skill.test.ts` (7 test
  cases) — 17 tests total, counted directly, not assumed — cover the
  current three-tier precedence and would need rewriting, not just
  extending, once tiers (1) and (2) no longer exist to have precedence
  over.
- Each of DevOps/Testing/Documentation/Security's own internal
  `detectSkill()` (used only when a task arrives with no authoritative
  `selectedSkill` — i.e., a direct-to-agent submission bypassing the
  Orchestrator entirely, `specs/030`) is a **separate**, per-agent
  keyword detector, structurally independent of the Orchestrator's own
  `detectSkill()` this spec changes. Confirmed out of scope below.

## Proposed Behavior

1. **Delete `detectSkill()`'s keyword-matching tier and the
   `classifyIntent()` tier.** The function calls `tryCapabilityRoute()`
   directly (or an equivalent always-consulted routing call), falling
   through to the existing `"plan-task"` default on any failure —
   reusing, not replacing, `tryCapabilityRoute()`'s already-correct
   fail-closed behavior.
2. **Extend `buildCapabilitySnapshot()` to include the Orchestrator's own
   meta-skill(s)** — at minimum a synthetic `{agentName: "orchestrator",
   skillId: "suggest-agents"}` entry — so the router can name it and the
   existing "must be in the live snapshot" validation continues to hold
   for it exactly as it already does for every agent-owned skill. This
   is additive to the snapshot builder, not a relaxation of its
   validation.
3. **No special-cased key-free path for any phrase, including
   meta-queries** — per Yusuf's own explicit choice. With no resolvable
   key, every natural-language request (including "what agents do you
   have") falls through to `plan-task`, which already fails that
   request closed with its existing named error
   (`runOrchestratorSupervisor()`, unchanged by this spec). This is a
   real, deliberate behavior change from today (where `suggest-agents`
   needs no key at all) — stated plainly, not hidden.
4. **`ci.yml`'s dispatch smoke test gains a real, funded provider key**
   as a repository secret, replacing the current deliberately-fake
   `ORCHESTRAI_LLM_API_KEY`. The smoke test's own assertions (`suggest-
   agents` → `assignedAgent: "orchestrator"`; `plan-task` → `assigned
   Agent: "orchestrator-supervisor"`) stay the same shape, now proving a
   genuine LLM routing decision instead of a keyword match for the first
   one. Model choice: cheapest/fastest available for the chosen
   provider, deferred to implementation time — not a design decision
   this spec needs to lock in.
5. **`packages/agents/*/index.ts`'s own internal keyword `detectSkill()`
   functions are untouched.** They remain the deterministic fallback for
   a direct-to-agent submission that carries no `selectedSkill` — a
   separate, pre-existing, already-safe path this spec does not touch.

## Scope

- `apps/orchestrator/index.ts`: `detectSkill()`'s tier structure, and
  `buildCapabilitySnapshot()`'s meta-skill extension.
- `apps/orchestrator/detect-skill.test.ts` and `capability-router-
  detect-skill.test.ts`: rewritten to test the new single-tier behavior
  (fail-closed-to-plan-task on no key/no match/bad proposal; a correct
  proposal dispatches; the meta-skill snapshot entry is present and
  validated the same way as any agent skill).
- `.github/workflows/ci.yml`: real provider key as a secret, replacing
  the placeholder.
- No change to `packages/shared/capability-router.ts` itself (`specs/054`'s
  own router logic, already correct), `packages/shared/intent-
  classifier.ts` (specs/020's classifier code stays in the repo,
  simply no longer called from this one call site — not deleted
  outright, see Out of Scope), `SKILL_TIER_REGISTRY`/`classifySkillTier()`
  (the approval-gate safety classification — explicitly untouched, this
  is the property Yusuf confirmed should stay deterministic), or any
  per-agent internal `detectSkill()`.

## Safety and Compatibility Constraints

- **The approval gate is completely untouched.** A router-named
  write-capable skill reaches the exact same `actionId`-bound flow it
  does today — this spec only changes *how a skill gets named*, never
  what happens once one is.
- **Fail-closed, not fail-guessed, preserved exactly.** No key, no
  online capability, or a hallucinated proposal all still fall through
  to the existing `"plan-task"` default and its own existing fail-closed
  error — this spec adds no new failure mode, it removes two paths that
  used to pre-empt reaching the LLM at all.
- **The capability router's own live-snapshot validation is not
  weakened.** Adding the `suggest-agents` meta-entry is validated the
  identical way every agent skill already is; the router still cannot
  dispatch to anything outside what's actually, currently available.

## Out of Scope / Non-Goals

- `SKILL_TIER_REGISTRY`/`classifySkillTier()` — the deterministic
  read-only/write-capable safety classification the approval gate is
  built on. Confirmed explicitly by Yusuf to stay deterministic; this
  spec does not touch it.
- Any other deterministic classifier in the codebase — provider
  transient-vs-terminal error handling (`specs/055`), write no-op/
  create/update/blocked classification (`specs/056`), test-runner
  detection (`specs/058`). None of these decide *which skill runs*; all
  stay exactly as they are.
- DevOps's deterministic content templates (Dockerfile/CI/compose) —
  the LLM (when `specs/042`'s opt-in harness is on) still only chooses
  *parameters*, never authors template content directly.
- Each agent's own internal, per-agent `detectSkill()` fallback for
  direct-to-agent submissions bypassing the Orchestrator — a separate,
  already-deterministic, already-safe path not addressed here. A
  follow-up spec if Yusuf wants that removed too.
- Deleting `packages/shared/intent-classifier.ts`'s code outright, or
  `bun run fetch-model`/the embedded model asset pipeline — simply no
  longer called from `detectSkill()`. Leaving the code and model
  pipeline in place (rather than ripping them out) keeps this spec's own
  diff minimal and reversible; removing them outright is a separate,
  later cleanup if desired once this spec is confirmed working.

## Acceptance Criteria

- [x] `detectSkill()` is now `tryCapabilityRoute(...) ?? "plan-task"`,
      nothing else — the keyword ladder and the `classifyIntent()` call
      are deleted, along with the now-unused `CI_WORD` constant and
      `classifyIntent` import. Verified by inspection of the diff.
- [x] `"what agents do you have"` routes to `suggest-agents` via the
      router. **Live-verified against real Gemini, 2026-09-10**: a real
      `POST /tasks {"text":"what agents do you have available"}` against
      a headless stack (real key from
      `test-target-project/.orchestrai/config.env`) returned
      `{"assignedAgent":"orchestrator","skill":"suggest-agents",
      "status":"completed"}` — the exact synchronous shape `ci.yml`'s
      smoke test checks. A second request,
      `"show me the git status of this repo"`, routed to `git-status` →
      `devops-agent` in the same run: a real Gemini call correctly
      picking a specific skill with no keyword matching in the path.
      Router log clean (no "unavailable"/"unsupported"/error).
- [x] With no key configured, every request resolves to `plan-task` —
      verified by `detect-skill.test.ts`'s full-rewrite suite, which
      runs in exactly that state (no key in the test process's env) and
      asserts every representative phrase → `plan-task`, never throws.
      (And the inverse, above: with a real key, those same phrases route
      to specific skills — live-confirmed.)
- [x] A skill not currently online is never dispatched to, even if the
      model names it — `capability-router-detect-skill.test.ts`'s "a
      proposal naming a skill not present in the live snapshot never
      dispatches — falls through to plan-task" (a real skill id, just
      not registered in that test's own registry).
- [ ] **OPEN — needs a repository secret only Yusuf can add.** `ci.yml`'s
      dispatch smoke test now reads `ORCHESTRAI_LLM_API_KEY` from
      `${{ secrets.ORCHESTRAI_LLM_API_KEY }}`. Until that secret exists,
      the `suggest-agents` check fails — expected and correct, since
      that request now genuinely needs a working LLM call to route.
      GitHub → Settings → Secrets and variables → Actions.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
      Verified: `bun test` — **852 pass, 0 fail**, 1658 expect() calls
      across 57 files (down from the pre-065 count of 877, because the
      old keyword/classifier `test.each` cases in the two rewritten
      routing test files are gone — they tested a mechanism that no
      longer exists); run time back to ~25s after the fake-router seam
      landed (see Verification Results for the 51-minute regression that
      surfaced first). `bun run typecheck` — 0 errors. `bun run
      specs:check` — pass, 65 specs.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Rewritten unit tests for `detectSkill()`'s new single-tier shape,
  covering: a correct router proposal dispatching; no key falling
  through to `plan-task`'s existing error; a hallucinated/offline skill
  id falling through the same way; the `suggest-agents` meta-entry
  present in the snapshot and correctly routable.
- A live pass against a real, working provider key: representative
  phrases that used to be keyword-matched (`"dockerize my app"`,
  `"scan for secrets"`, `"what agents do you have"`) each confirmed to
  route correctly via a genuine LLM decision, not inspection of the
  code path alone.
- A live CI run on the actual GitHub Actions workflow, confirming the
  dispatch smoke test passes with the new real secret in place.

## Approval Requested

**Approved 2026-09-10 by Yusuf.** Implementation proceeds for the code
changes (`apps/orchestrator/index.ts` and its test files). The CI
adaptation's own acceptance criterion (a live-passing `ci.yml` run) stays
blocked until a real provider key is added as a repository secret — an
operational step only Yusuf can do (GitHub repository settings → Secrets
and variables → Actions) — and will be reported honestly as unverified
until that happens.
