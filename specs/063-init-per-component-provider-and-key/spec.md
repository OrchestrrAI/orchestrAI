---
id: 063-init-per-component-provider-and-key
title: Init — Provider Credentials Tab and Live Per-Agent Model Discovery
area: supervisor
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-09
updated: 2026-09-10
approved_by: Yusuf
approved_on: 2026-09-10
implemented_on: 2026-09-10
amends:
  - 050-init-per-agent-llm-toggles
related:
  - 039-per-component-llm-provider-config
  - 031-interactive-init-wizard
  - 048-guided-init-experience
  - 049-guided-init-web-setup
  - 045-supervisor-port-preflight-timeout
supersedes: []
superseded_by: []
---

# Spec: Init — Provider Credentials Tab and Live Per-Agent Model Discovery

> Review gate: **APPROVED 2026-09-10 by Yusuf.** This is a **rewrite**,
> not the original 063: this
> spec was approved once in its first form (a single Models view with a
> provider cycler and free-text model field per component), then Yusuf
> proposed a materially different UX before implementation began —
> two dedicated screens (register provider credentials first, then pick
> a live-discovered model per agent) — which CLAUDE.md's own rule treats
> as returning an approved spec to `draft` for re-approval, not a tweak
> to fold in silently. The underlying data actually written to
> `.orchestrai/config.env`, and the footgun this spec closes, are
> unchanged from the original version; what changed is the UX flow and
> one genuinely new capability (live model discovery).

## Purpose

Same starting problem as the original spec: every setup UI lets you pick
a different **model** per component but only one shared **provider and
key** for the whole config, even though the runtime
(`specs/039-per-component-llm-provider-config/spec.md`) already fully
supports a different provider and key per component — the gap is UI-only.

Yusuf's own follow-up proposal, 2026-09-10, verbatim intent: register
provider credentials first (one or more), then, per agent, choose a
provider and pick a model from what's **actually available to that
provider's key** — not a free-text field the user has to already know
the exact model string for. This is a real improvement over the
original design in two ways: (1) a credential is entered once and reused
across every component assigned to that provider, instead of re-typing
the same key per component; (2) the model list is **live and real**,
never a guess, which also happens to be a stronger live proof the key
works than the original spec's own "no live validation" stance
attempted.

## Verified Current State

Everything the original spec's "Verified Current State" section
established is unchanged and still true (re-read 2026-09-10, not
assumed carried over):

- `readLlmModelConfig(env, component)` already resolves provider,
  model, and API key independently per field, per component.
- `WizardConfig` has one shared `llmProvider`/`llmModel?`/`llmApiKey?`
  plus `modelOverrides: Partial<Record<LlmComponent, string>>` — no
  provider/key override field exists yet anywhere.
- No screen anywhere lets a user browse a provider's real available
  models — every model field today is free text.

Newly verified for this rewrite, 2026-09-10:

- **Anthropic has a real, non-beta Models API**: `client.models.list()`
  (auto-paginates) / `client.models.retrieve(id)`, each model object
  carrying `id`, `display_name`, `created_at`, and (since March 2026)
  `max_input_tokens`/`max_tokens`/`capabilities`. Confirmed directly
  from the Claude API skill bundled in this environment, not assumed —
  this was the one real open technical question before proposing this
  redesign: does Anthropic even expose a list-models call the way
  OpenAI (`GET /v1/models`, long-documented) and Gemini
  (`models.list`, long-documented) already do. It does.
- `LLM_PROVIDERS` (`apps/supervisor/init-wizard.ts`) is a **closed
  3-item set** — `anthropic`, `openai`, `gemini` — confirmed by direct
  read. A "register more providers" flow therefore has a natural,
  small bound: at most one credential per provider, never an
  open-ended list.
- No code anywhere in this codebase currently makes a network call
  *during setup*, before anything is started or persisted. Every prior
  live-provider call in this project happens at task-dispatch time,
  after the stack is already running. This spec's live model-listing
  call is the first exception, and is scoped carefully below because of
  that.

## Proposed Behavior

### 1. A new "Providers" screen — register credentials, not yet assign them

Reachable the same way the existing Models view is (a keybinding from
the setup screen, e.g. `p`, alongside the existing `m` for Models).

- Add one credential at a time: cycle a provider from `LLM_PROVIDERS`
  (excluding any already registered — at most one credential per
  provider, per the closed 3-item set above), then enter its key via
  the exact existing masked-key handoff (`specs/048`'s suspend/raw-mode
  mechanism for the TUI form; the browser form's existing never-echoed
  submission path for its own case — no new secret-handling code path).
- **The first credential registered becomes the shared default** —
  written to the existing, unchanged `ORCHESTRAI_LLM_PROVIDER`/
  `_API_KEY` fields, exactly as today's single shared provider/key
  already work. Every credential registered after the first is held in
  **wizard-session memory only** (see Safety Constraints — this is
  deliberately not a new persistent multi-credential store) and becomes
  available, in the Models screen below, as a provider a component can
  be assigned to.
- Re-opening this screen on a re-run of `init` against an existing
  config pre-seeds every provider already found configured on disk —
  the shared one, and any component's own existing per-component
  override — so nothing already-configured needs re-entering. This
  matches `specs/050`'s own existing pre-fill guarantee for the Models
  view, extended to credentials.

### 2. The Models screen becomes provider-constrained and live

Per component (Orchestrator, DevOps, Documentation, Security,
Conversation):

- **Provider**: a picker constrained to *only* the providers actually
  registered on the Providers screen (plus `(shared default)`, meaning
  "whichever was registered first"). A component can never be pointed
  at a provider with no registered key — this isn't a validation rule
  checked after the fact, it's structurally impossible: the picker's
  own option list only ever contains providers that already have a key,
  by construction. This is a **stronger** version of the original
  spec's footgun-prevention constraint, not a different one.
- **Model**: once a row has a resolved provider (its own override, or
  the shared default), the model field becomes a **live-fetched
  selectable list**, not free text. The wizard calls that provider's
  real list-models endpoint using its registered key, bounded by an
  8-second timeout (matching the existing precedent set by
  `specs/045`'s own bounded-check reasoning — never an unbounded wait),
  and presents the real returned model ids as options (same left/right
  or up/down selection interaction already used elsewhere in this
  form). Selecting `(provider default)` still means "write no model
  override," unchanged from today.
- **On a failed or timed-out fetch** (invalid key rejected by the
  provider, no network reachability, provider outage): the row falls
  back to the existing free-text model field, with a visible inline
  message naming what happened — setup is never blocked, and the key
  itself is never included in that message or logged anywhere.

### 3. What's actually written to disk is unchanged in shape

`.orchestrai/config.env`'s own schema is untouched: the shared
`ORCHESTRAI_LLM_PROVIDER`/`_MODEL`/`_API_KEY` fields (first-registered
credential), plus per-component `ORCHESTRAI_<COMPONENT>_LLM_PROVIDER`/
`_MODEL`/`_API_KEY` for any component assigned a non-default provider or
model. This is exactly the original spec's own persisted shape —
`readLlmModelConfig()` needs no change, `WIZARD_OWNED_KEYS` gains the
identical two new per-component variables the original spec already
specified.

### 4. Model-list fetching — provider-specific, no new SDK dependency

One small internal HTTP helper per provider, plain `fetch()` with the
bounded timeout above — not the LangChain wrapper classes
`buildChatModel()` already uses elsewhere (those are for making chat
completions, not listing models, and pulling them into the setup
wizard's own dependency graph for a single GET request would be
disproportionate):

- **Anthropic**: `GET https://api.anthropic.com/v1/models`,
  `x-api-key`/`anthropic-version` headers — response is already
  chat-model-only, no filtering needed.
- **OpenAI**: `GET https://api.openai.com/v1/models`,
  `Authorization: Bearer` — response mixes chat, embedding,
  moderation, audio, and image models; needs a documented, narrow
  id-prefix filter (e.g. excluding `text-embedding-`, `whisper-`,
  `dall-e-`, `tts-`, `omni-moderation-`) to show only genuinely
  chat-capable entries — an explicit implementation detail, not a
  promise of perfect curation, since OpenAI may add new categories
  later.
- **Gemini**: `GET https://generativelanguage.googleapis.com/v1beta/
  models?key=<key>` — filtered to entries whose
  `supportedGenerationMethods` includes `generateContent`.

## Scope

- `apps/supervisor/init-wizard.ts`: `WizardConfig` gains
  `providerOverrides`/`apiKeyOverrides` exactly as the original spec
  specified; `WIZARD_OWNED_KEYS` extended identically;
  `formatConfigEnv()`/`mergeConfigEnv()` write/preserve the two new
  per-component variables.
- A new module (e.g. `apps/supervisor/model-discovery.ts`) housing the
  three provider-specific list-models fetchers and their shared
  bounded-timeout/error-handling shape — kept separate and pure/testable
  (injectable `fetch`, matching this codebase's own existing precedent
  for testing network-adjacent code, e.g. `port-preflight.test.ts`'s
  real-socket approach and `llm-model-factory.test.ts`'s mocked-fetch
  approach).
- `apps/supervisor/init-form-state.ts`: new pure state for the
  Providers screen (registered-credential list, cursor/focus) and the
  Models screen's constrained provider picker + fetched-model-list
  state.
- `apps/supervisor/init-form.tsx`: two screens' worth of new rendering
  — the Providers screen, and the Models screen's provider picker plus
  live model list (with a loading indicator while a fetch is in
  flight, and the inline fallback message on failure).
- The classic wizard and the browser form inherit this the same way the
  original spec described — shared pure functions, no second
  implementation. The browser form's own live-fetch call happens
  server-side (`apps/supervisor/init-web.ts`'s own request handler), not
  client-side in the browser, so the provider key is never sent to or
  handled by the browser JavaScript at all — it stays server-side the
  same way it already does for the rest of that surface.
- No change to `packages/shared/llm-model-factory.ts` or the runtime's
  required-key startup check — identical to the original spec's own
  Scope statement on this point.

## Safety and Compatibility Constraints

- **The registered-credential list is wizard-session-only, not a new
  persistent store.** No new file, no new section of `config.env`, no
  new secret-at-rest beyond what a component actually gets assigned
  (which already writes to the existing, already-accepted plaintext
  `config.env`, per `specs/031`'s decision). A provider typed in but
  never assigned to any component is simply not written anywhere when
  the wizard exits — the same "nothing is persisted until you actually
  use it" property the original spec already had for per-component
  overrides.
- **At most one credential per provider** — `LLM_PROVIDERS`'s own
  closed 3-item set is the bound; this is not an arbitrary-length
  credential pool.
- **The live model-listing call is this codebase's first outbound
  network call made *during setup*, before anything is started or
  persisted — scoped deliberately narrowly**: bounded timeout (8s,
  never unbounded), the key is used only in that one request's own
  auth header/query param (never logged, never echoed, matching every
  existing masked-key discipline in this codebase), and a failure of
  any kind falls back to manual free-text entry rather than ever
  blocking or crashing setup.
- **Footgun prevention is structural, not a validation rule.** A
  component's provider picker can only ever offer providers that
  already have a registered key — there is no code path that can
  produce "provider set, no key," which is a strictly stronger
  guarantee than the original spec's own validate()-time check.
- **Byte-identical for the simplest case** — one provider registered,
  no per-component overrides assigned — produces the exact same
  `ORCHESTRAI_LLM_PROVIDER`/`_MODEL`/`_API_KEY`-only shape as today.

## Out of Scope / Non-Goals

- Persisting the full registered-credential list across separate
  `init` runs beyond what's already inferable from `config.env`'s own
  existing fields — a credential typed in but never assigned to any
  component during one run is not remembered the next time `init`
  opens; only what's actually on disk (shared + real per-component
  overrides) pre-seeds a later run.
- Any further health/validation check beyond the list-models call
  itself succeeding — a successful fetch is real, live proof the key
  authenticates, which the original spec explicitly didn't attempt;
  this spec doesn't add a *separate* "test this key" action beyond
  that already-happening side effect.
- Perfect model-list curation guarantees — the per-provider filtering
  heuristics above are a documented best effort against each
  provider's *current* API shape, not a promise that survives every
  future model category a provider might add.
- Displaying model metadata (context window, pricing, capabilities)
  beyond the id/display name needed to pick one — Anthropic's API
  returns more; this spec doesn't surface it.
- Any change to how many components exist or what `specs/039` resolves
  at runtime — identical to the original spec's own Non-Goals.

## Acceptance Criteria

- [x] Registering a first provider+key writes it to the existing
      shared `ORCHESTRAI_LLM_PROVIDER`/`_API_KEY` fields, byte-identical
      to today's single-provider case. Verified: `registerProviderKey()`
      writes `llmApiKey` directly when the cursor is on the shared
      provider's own row; "registering the shared provider's own row
      updates llmApiKey directly, not extraProviders" (test).
- [x] Registering a second provider+key does not write anything by
      itself. Verified: `formStateToWizardConfig` tests — "a component
      with no provider override writes neither line," and
      `extraProviders` is confirmed session-only state, never itself
      serialized by `formatConfigEnv()`.
- [x] A component's provider picker only ever lists providers with a
      registered key — proven structurally. Verified: "it is
      structurally impossible to produce a provider override with an
      empty key" sweeps every component against every
      `availableProviders()` entry and asserts every resulting
      `apiKeyOverrides` value is truthy — an adversarial, not
      hand-picked, proof.
- [x] **Live-verified against a real Gemini account, 2026-09-10.**
      `listAvailableModels("gemini", <real key>)` returned **40 real
      models**, correctly filtered to `generateContent`-capable entries
      (no embedding models) with the `models/` prefix stripped
      (`gemini-3.5-flash-lite`, not `models/gemini-3.5-flash-lite`).
      Anthropic/OpenAI still unverified live (no keys for those this
      session); the in-TUI effect that fires on landing on a component
      row is proven by unit test + code, not yet watched in a real
      terminal.
- [x] A deliberately invalid key, or a fetch forced to time out, falls
      back to free-text entry — verified at the `model-discovery.ts`
      layer (every failure resolves to `{ok:false, error}`, never
      throws — 5 tests including a genuine bounded-timeout case) and at
      the form layer (`discoveryHint()` renders the error inline; typing
      in the model field is never gated on a successful fetch — it was
      never disabled to begin with).
- [x] Assigning a component to a registered provider and a model writes
      both `ORCHESTRAI_<COMPONENT>_LLM_PROVIDER`/`_MODEL`, and a
      subsequent `readLlmModelConfig(env, component)` resolves that
      exact pair. Verified: the seeding round-trip test writes then
      re-derives via `initialFormState()` and confirms both lines
      appear in `formatConfigEnv()`'s output.
- [x] A config written entirely at defaults is byte-identical to
      today's output for the same answers. Verified: no test above ever
      produces a `providerOverrides`/`apiKeyOverrides` line without an
      explicit assignment; the classic wizard's own config literal
      passes empty objects for both, unchanged in spirit from the
      original spec's own `modelOverrides: {}` precedent.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
      Verified: `bun test` — 877 pass, 0 fail, 1707 expect() calls
      across 57 files (up from the pre-063 baseline of 839/0/1621/56 —
      the delta is this spec's own 38 new tests: 9 in
      `model-discovery.test.ts`, the rest added to
      `init-form-state.test.ts`); `bun run typecheck` — 0 errors;
      `bun run specs:check` — pass, 65 specs. `bun run build` also
      succeeded (141.0 MB) so the fix is runnable, not just present in
      source.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

**Honest scope gap, not silently absorbed**: this spec's own Scope
section said the browser form's live-fetch call would happen
server-side in `apps/supervisor/init-web.ts`'s own request handler.
That was **not implemented** in this pass — `init-web.ts`'s HTML/JS
already submits `modelOverrides: {}` unconditionally today (checked
directly: it has never had a real per-component UI, only backend
parsing support for it), and this spec did not change that. The
per-component provider/key work landed in full for the TUI form and
the underlying `WizardConfig`/`formatConfigEnv()` layer every surface
shares; the browser form's own Providers/Models screens remain a
follow-up, not a silently-dropped requirement.

## Verification Plan

- Pure unit tests for the three provider-specific fetchers (mocked
  `fetch`, matching `llm-model-factory.test.ts`'s own existing
  convention) — success shape, the per-provider filter, timeout,
  and error/non-200 handling — no real credential, no real network
  call.
- Pure unit tests for the new Providers/Models screen state (credential
  registration, the structural provider-picker constraint, clear/
  reassign behavior).
- `formatConfigEnv()`/`mergeConfigEnv()` round-trip tests identical in
  spirit to the original spec's own plan.
- A live pass with real credentials for at least one provider
  (ideally all three, matching this session's separate "validate
  Claude/GPT for real" open item — this spec's own live-fetch
  acceptance criterion and that broader validation effort can share
  one live session) — confirming a genuine model list renders and a
  genuine invalid key falls back cleanly.
- A real interactive-terminal pass (TUI form) and a real browser pass,
  the same open items every prior guided-init checkpoint in this
  codebase has carried — left to Yusuf's own machine.

## Approval Requested

**Approved 2026-09-10 by Yusuf.** Implementation proceeds.
