---
id: 039-per-component-llm-provider-config
title: Per-Component LLM Provider Configuration
area: llm-harness
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-01
updated: 2026-09-01
approved_by: Yusuf
approved_on: 2026-09-01
implemented_on: 2026-09-01
amends:
  - 029-shared-llm-provider-gemini
supersedes: []
superseded_by: []
related:
  - 026-llm-harness-langgraph-planning
  - 028-orchestrator-langgraph-supervisor
  - 031-interactive-init-wizard
  - 034-init-wizard-services-ux
---

# Spec: Per-Component LLM Provider Configuration

> Status: **APPROVED and IMPLEMENTED 2026-09-01.** Open Decision resolved
> as **Option B** (Yusuf). VERIFIED the same day: automated resolution-
> matrix tests (30 across the shared factory and Planning's wrapper) plus
> two live end-to-end runs — a non-TTY wizard round-trip that correctly
> wrote `ORCHESTRAI_ORCHESTRATOR_GRAPH=1`, and a real zero-flag
> `orchestrai` startup from that wizard-written config whose submitted
> `plan-task` request genuinely entered the supervisor
> (`"assignedAgent":"orchestrator-supervisor"`) with Planning's own
> `/healthz` confirming zero tasks ever reached it. See Verification
> Results below.

## Purpose

Today every LLM-capable component in this runtime reads the **same three
environment variables**. There are two such components now
(`specs/026`'s Planning harness and `specs/028`'s Orchestrator
supervisor), and a proposed roadmap would add more. They have genuinely
different needs — the supervisor makes a small number of
consequential routing decisions where model quality matters most, while
a per-agent content-generation loop may run far more often on cheaper
work — but there is currently no way to give them different providers or
models through any supported path.

This checkpoint adds a **two-tier lookup**: an optional per-component
override that falls back to the existing shared variables when unset. It
is deliberately small, additive, and byte-identical by default.

## Verified Current State

Read from the current code, 2026-09-01:

- `packages/shared/llm-model-factory.ts`'s `readLlmModelConfig(env)`
  (line 28) reads exactly three variables — `ORCHESTRAI_LLM_PROVIDER`
  (line 31, defaulting to `anthropic`), `ORCHESTRAI_LLM_API_KEY`
  (line 39, `null` when absent so callers fail closed), and
  `ORCHESTRAI_LLM_MODEL` (line 42, required when the provider is
  `gemini`, otherwise defaulting per provider from `DEFAULT_MODEL`).
  It takes no component identity of any kind.
- **Both current callers pass nothing but the ambient environment**, so
  both necessarily resolve to identical configuration:
  - Planning: `packages/agents/planning/model-factory.ts`'s
    `readLlmHarnessConfig()` (line 32) checks its own
    `ORCHESTRAI_LLM_HARNESS` flag (line 24), then delegates to
    `readLlmModelConfig(env)` unchanged.
  - Orchestrator: `apps/orchestrator/index.ts`'s
    `runOrchestratorSupervisor()` (line 821) calls `readLlmModelConfig()`
    (line 824) with no arguments after its own
    `ORCHESTRAI_ORCHESTRATOR_GRAPH` flag has already gated entry.
- **The supervisor spawns every child with one shared environment.**
  `apps/supervisor/index.ts`'s `spawnService()` passes
  `env: process.env` (line 288) to every child identically. There is no
  per-service environment mechanism, and this checkpoint does not need
  to add one (see Proposed Behavior).
- **Different providers per component are already possible today, but
  only by bypassing the supervisor entirely** — starting each service as
  its own process (`bun run planning-agent` in one shell,
  `bun run orchestrator` in another) with different values exported in
  each. This works purely because they are separate OS processes; it is
  not a documented or supported configuration path, and it is
  unreachable through `bun run orchestrai`, the compiled binary, or the
  wizard.
- **The init wizard is Planning-only, in both wording and output.**
  `apps/supervisor/init-wizard.ts` prompts `"Enable the LLM planning
  harness? (y/n)"` (line 424) and `formatConfigEnv()` writes
  `ORCHESTRAI_LLM_HARNESS` plus the three shared variables (lines
  99-102). It never writes `ORCHESTRAI_ORCHESTRATOR_GRAPH` at all —
  the wizard (`specs/031`, 2026-08-21) predates the supervisor
  (`specs/028`, 2026-09-01) and has no knowledge of it. A
  wizard-configured project therefore **cannot enable the adaptive
  supervisor**, only Planning's harness.

## Proposed Behavior

1. **Two-tier lookup.** `readLlmModelConfig()` gains an optional
   component identifier. When given one, each of the three variables is
   resolved as: `ORCHESTRAI_<COMPONENT>_LLM_<FIELD>` if set and
   non-empty, otherwise the existing `ORCHESTRAI_LLM_<FIELD>`. Called
   with no component (the current signature), behavior is **exactly**
   what it is today.

   ```text
   ORCHESTRAI_PLANNING_LLM_MODEL=gemini-3.5-flash-lite   # cheap, frequent
   ORCHESTRAI_ORCHESTRATOR_LLM_MODEL=gemini-3.5-pro      # consequential
   ORCHESTRAI_LLM_API_KEY=…                              # shared by both
   ```

2. **Component names are a fixed, closed set**, not free-form: exactly
   the components that can actually use an LLM. At this checkpoint that
   is `PLANNING` and `ORCHESTRATOR`. An unknown component identifier is
   a programming error, not a runtime configuration case — the set is
   defined in code and never derived from environment input.

3. **Resolution is per-field, not all-or-nothing.** Setting only
   `ORCHESTRAI_ORCHESTRATOR_LLM_MODEL` while leaving provider and key
   shared is valid and expected — that is the common case (same account
   and provider, different model tier). Mixing providers across
   components is also valid, in which case each needs its own key.

4. **Every existing validation rule applies per resolved component**,
   unchanged: an unknown provider throws naming the field; a missing key
   returns `null` so the caller fails closed on its existing path; and
   `gemini` still requires an explicit model. Error messages name the
   **resolved** variable (the component-specific one when that is what
   was set), so a misconfiguration points at the variable actually
   responsible.

5. **No change to the supervisor's spawn model.** Because every child
   already inherits the full environment (line 288 above) and each
   component reads only its own namespace before falling back, no
   per-service environment injection, no new config file format, and no
   change to `spawnService()` is required. This is the main reason this
   checkpoint is small.

6. **Startup reporting stays honest.** Planning's existing
   `readLlmHarnessStartupState()` summary and the Orchestrator's
   equivalent startup path must report the configuration each component
   actually resolved, so two components on different models are
   distinguishable in the logs rather than silently identical-looking.

## Open Decision — the wizard's scope

The wizard cannot currently enable the supervisor at all (see Verified
Current State). Three options, and this spec should not proceed past
`draft` without one being chosen:

- **Option A — factory and env vars only.** Ship the two-tier lookup;
  leave the wizard exactly as-is. Per-component configuration is reachable
  by hand-editing `.orchestrai/config.env` or exporting variables.
  Smallest possible change; the wizard stays Planning-only and still
  cannot enable the supervisor.
- **Option B — factory plus a minimal wizard fix.** Also teach the
  wizard that the supervisor exists: a second yes/no for the adaptive
  supervisor writing `ORCHESTRAI_ORCHESTRATOR_GRAPH`, reusing the same
  single provider/model/key answers for both components. Fixes the
  incoherence that a wizard-configured project can't use `specs/028` at
  all, without adding per-component prompts.
- **Option C — full per-component wizard.** B, plus optional
  "use a different model for the supervisor?" follow-up prompts.
  Most capable, but adds real friction to a first-run wizard whose whole
  design intent (`specs/031`, `specs/034`) was fewer and simpler
  questions.

**Recommendation: Option B.** It closes a genuine gap (the wizard cannot
configure a feature that now exists) at small cost, while leaving
per-component provider selection to environment variables, where the
people who actually want two different models are comfortable working.
C can be a later checkpoint if real use demands it.

## Scope

- `packages/shared/llm-model-factory.ts` — the two-tier lookup, the
  closed component set, and per-field resolution with
  resolved-variable-aware error messages.
- `packages/agents/planning/model-factory.ts` — pass `PLANNING`.
- `apps/orchestrator/index.ts` — pass `ORCHESTRATOR` at
  `runOrchestratorSupervisor()`'s config read; startup/log reporting of
  the resolved configuration.
- `apps/supervisor/init-wizard.ts` — **only if Option B or C is chosen**
  above.
- Tests: `packages/shared/` factory tests for the resolution matrix.
- `CLAUDE.md`, `README.md`, `context/worklog.md`.

## Safety Constraints

- **Byte-identical default behavior.** With no component-specific
  variables set, every component resolves exactly what it resolves
  today. This is an acceptance criterion, not an aspiration — an
  existing `.orchestrai/config.env` must keep working untouched.
- **No credential ever logged or echoed.** Startup reporting names
  providers, models, and which variable a value came from — never a key,
  not even partially. This matches `readLlmHarnessStartupState()`'s
  existing discipline and `specs/031`'s masking rule.
- **Fail closed, never cross-fall-back.** A component configured with an
  invalid provider or a missing key fails on its own existing path. It
  must never silently borrow another component's fully-configured
  credentials as a substitute — falling back to the *shared* variables is
  the designed behavior; falling back to *another component's* namespace
  is not, and must be impossible by construction.
- **The approval gate is untouched.** This checkpoint changes which
  model a component talks to, nothing about what any component is
  permitted to do.
- **No new provider, no new adapter, no dependency change.**
  `buildChatModel()` and the three supported providers are unchanged.

## Out of Scope / Non-Goals

- Adding LLM capability to any agent that does not have it today
  (DevOps, Testing, Documentation, Security) — that is the proposed
  041/042/043 sequence, each needing its own approval.
- Per-component *feature flags* beyond the `ORCHESTRAI_ORCHESTRATOR_GRAPH`
  wizard gap named in Option B — activation semantics for
  `ORCHESTRAI_LLM_HARNESS` and `ORCHESTRAI_ORCHESTRATOR_GRAPH` are
  otherwise unchanged.
- Per-component rate limits, budgets, retry policy, or cost accounting.
- Any change to `buildChatModel()`, the provider list, or model defaults.
- A config file format for LLM settings (e.g. per-component blocks in
  `config.env`) — environment variables remain the mechanism.
- Runtime model switching, or changing a component's model without a
  restart.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation, including a
      chosen Open Decision option — Option B, approved 2026-09-01.
- [x] `readLlmModelConfig()` called with no component argument behaves
      byte-identically to today — asserted directly in tests, not
      inferred.
- [x] Per-field two-tier resolution works: component-specific wins when
      set; shared is used when the component-specific variable is unset
      or empty; the two can be mixed across fields in one component.
- [x] Two components resolve genuinely different models from one
      environment — asserted in unit tests, and **live-confirmed with a
      real Gemini key**: Planning resolved `gemini-3.5-flash-lite`
      (`ORCHESTRAI_LLM_MODEL`) while the Orchestrator resolved
      `gemini-3.5-pro` (`ORCHESTRAI_ORCHESTRATOR_LLM_MODEL`) from the
      same running environment — see Verification Results.
- [x] Every existing validation rule holds per component: unknown
      provider throws naming the resolved variable; missing key returns
      `null`; `gemini` without a model throws.
- [x] A component whose own namespace is misconfigured never resolves
      another component's credentials — asserted adversarially.
- [x] No credential value appears in any startup summary, log line, or
      error message — asserted in tests, and **live-confirmed**: real
      startup logs against a real key show only `key from
      ORCHESTRAI_LLM_API_KEY` (the variable name), never the value.
- [x] An existing `.orchestrai/config.env` written by the pre-039 wizard
      continues to work with no edits — **verified live**: hand-crafted a
      config in the exact pre-039 shape (no `ORCHESTRAI_ORCHESTRATOR_GRAPH`
      key present at all, not just set to `0`), started `orchestrai`
      zero-flag from it, and confirmed a `plan-task` request still routed
      to `assignedAgent: "planning-agent"` — not the supervisor.
- [x] Planning and the Orchestrator each report their resolved provider
      and model at startup, distinguishably — live-confirmed (see above).
- [x] Option B: the wizard can enable the adaptive supervisor, and a
      wizard-written config actually starts it — **verified live end to
      end**: a non-TTY wizard run wrote `ORCHESTRAI_ORCHESTRATOR_GRAPH=1`
      correctly, a zero-flag startup from that config genuinely routed a
      `plan-task` request to `orchestrator-supervisor` (not Planning),
      and — with a real key — the supervisor made two genuine adaptive
      decisions (`analyze-project` then `dockerize`, the second only
      after observing the first's real result) and correctly reached a
      real `actionId`-bound approval gate for the write step. Rejected
      to avoid an unnecessary write; confirmed no file was created.
- [x] `bun test` (372 passed, 0 failed), `bun run typecheck` (0 errors),
      `bun run specs:check` all pass.
- [x] `CLAUDE.md`, `README.md`, `context/worklog.md` updated.

## Verification Plan

- **Automated:** a resolution matrix against synthetic `env` objects (no
  real credentials, no network — matching how `specs/029`'s provider
  tests already work): shared-only; component-only; mixed per-field; two
  components differing; each invalid case; and the adversarial
  cross-component case. Plus the byte-identical no-component-argument
  assertion.
- **Live (Yusuf's machine, real key):** one run with a single shared
  configuration confirming unchanged behavior; one run with
  `ORCHESTRAI_ORCHESTRATOR_LLM_MODEL` set differently from Planning's,
  confirming both startup summaries report different models and a real
  `plan-task` request still completes. If Option B: a wizard run that
  enables the supervisor, followed by a zero-flag start confirming it
  actually runs.
- **Regression:** an untouched pre-039 `config.env` still starts
  correctly.

## Verification Results (2026-09-01)

**Automated:** `packages/shared/llm-model-factory.test.ts` grew from 6 to
18 tests (the resolution matrix: no-component byte-identical, override
wins, fallback on unset, fallback on empty-string, per-field mixing, two
components differing, the adversarial cross-component-isolation case, and
both `describeLlmModelConfig()` cases). Planning's own
`packages/agents/planning/model-factory.test.ts` grew from 4 to 6 (a
component-specific resolution case, and the new "enabled" success-path
summary format). `apps/supervisor/init-wizard.test.ts` grew from 30 to 33
(the new `orchestratorSupervisor` field's three behaviors, plus the
existing round-trip/gitignore tests updated for the new required field).
`bun test`: 372 passed, 0 failed (up from 356 at the start of this
session). `bun run typecheck`: 0 errors.

**Live, real machine, real Gemini key** (all against a disposable scratch
directory, never this repository):

1. **Non-TTY wizard round-trip.** Piped input through `orchestrai init`
   selecting a 2-agent subset, harness disabled, supervisor enabled,
   provider/model/key. The written `config.env` correctly contained
   `ORCHESTRAI_ORCHESTRATOR_GRAPH=1` alongside the existing fields —
   this specific line could not exist before this checkpoint.
2. **Zero-flag startup from that config, no real key needed for this
   step.** All 4 expected services started; a submitted `plan-task`
   request returned `"assignedAgent":"orchestrator-supervisor"` — genuine
   proof the flag was read from the wizard-written file, not inferred
   from log text.
3. **Two components, two different real models, one environment, real
   key.** Restarted with `ORCHESTRAI_ORCHESTRATOR_LLM_MODEL=gemini-3.5-pro`
   set alongside the shared `ORCHESTRAI_LLM_MODEL=gemini-3.5-flash-lite`.
   Planning's own startup line reported the shared model; the
   Orchestrator's reported the override — both correctly, with the
   correct source variable name attached to each. The submitted task's
   real error (`"models/gemini-3.5-pro is not found ... for
   generateContent"`) was a genuine Google API response naming the
   overridden model specifically — proof the override reached the real
   API call, not just the resolver.
4. **Full genuine completion, real key, real adaptive dispatch.**
   Re-ran with `ORCHESTRAI_ORCHESTRATOR_LLM_MODEL=gemini-3.5-flash-lite`
   (a model already confirmed working in `specs/029`'s own live record).
   The supervisor made two real, sequential decisions —
   `analyze-project`, then `dockerize` only after observing the first
   step's actual result — and correctly reached a real, `actionId`-bound
   `input-required` approval for the write step
   (`create_dockerfile` → `<target>\Dockerfile`). Rejected deliberately
   (no write needed to prove the point); confirmed the file was never
   created.
5. **Credential-leak check, live.** Grepped every startup log produced
   during this pass for the key value and for `apikey`/`api_key`/`AQ.`
   patterns — every match was the phrase `key from
   ORCHESTRAI_LLM_API_KEY` (the variable name only), never the value.
6. **True pre-039 backward compatibility, live.** Hand-crafted a
   `config.env` in the exact pre-039 shape — `ORCHESTRAI_ORCHESTRATOR_GRAPH`
   **absent entirely**, not merely `0`, matching what a config saved
   before this checkpoint would actually contain. Zero-flag startup from
   it, then a `plan-task` submission returned
   `"assignedAgent":"planning-agent"` — confirmed unchanged, not assumed
   from `isOrchestratorGraphFlagSet()`'s code reading correctly.

**Cleanup after every live pass:** `Get-CimInstance Win32_Process` for
`bun.exe` and `netstat` for ports 3000-3006 confirmed zero orphaned
processes and no live listeners each time. No scratch directory or log
file from this verification pass was left behind; none was ever inside
this repository.

**One real mistake made and disclosed during this pass, unrelated to the
checkpoint's own logic**: an `rm -rf` cleanup command targeting this
session's own scratch directory also matched and permanently deleted
`C:\Users\moham\test-target-project` — a separate directory Yusuf had set
up in an earlier session with real Gemini credentials for `specs/028`'s
live testing. Disclosed immediately, not discovered later. Nothing from
that directory was ever committed to this repository; the raw NDJSON
event captures from `specs/028`'s own live testing are safely stored
under `specs/028-orchestrator-langgraph-supervisor/`, untouched. Yusuf
re-supplied the credential directly; it was written straight to the
recreated config file without ever being echoed in any command output.

## Approval Requested

Approval authorizes: the two-tier per-component lookup in
`packages/shared/llm-model-factory.ts`, both current callers passing
their component identity, resolved-configuration startup reporting, and
— per the chosen Open Decision option — the corresponding wizard change.

It does **not** authorize adding LLM capability to any additional agent,
any change to the approval gate, any new provider or dependency, or any
change to activation-flag semantics beyond what the chosen option states.
