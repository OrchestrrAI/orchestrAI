# Verification: Init — Provider Credentials Tab and Live Per-Agent Model Discovery

Implemented 2026-09-10. `status: implemented`, `verification: partial` —
the live-fetch-against-a-real-account criterion is open (needs Yusuf's
own credentials), and the browser form's own equivalent UI was
explicitly not attempted in this pass. See below.

## What changed

- **`apps/supervisor/model-discovery.ts`** (new) — `listAvailableModels()`,
  one plain-`fetch()` path per provider (Anthropic `GET /v1/models`,
  OpenAI `GET /v1/models` with a non-chat-model filter, Gemini `GET
  .../models` filtered to `generateContent`-capable entries), bounded
  8s timeout, every failure resolved to `{ok:false, error}` rather than
  thrown.
- **`apps/supervisor/init-wizard.ts`** — `componentProviderVar()`/
  `componentApiKeyVar()`; `WizardConfig` gained
  `providerOverrides`/`apiKeyOverrides`; `formatConfigEnv()` writes them;
  `WIZARD_OWNED_KEYS` extended so a cleared row genuinely removes its
  lines.
- **`apps/supervisor/init-form-state.ts`** — the pure state layer:
  `extraProviders`/`providersCursor`/`providerOverrides`/
  `discoveredModels`/`modelFetchStatus`/`modelFetchError` on
  `InitFormState`; the Providers screen's own functions
  (`openProvidersView`/`registerProviderKey`/`unregisterProviderKey`/
  etc.); the Models screen's provider picker
  (`setProviderOverrideAtCursor`/`cycleProviderOverrideAtCursor`/
  `resolvedProviderAtCursor`); `availableProviders()`/`keyForProvider()`;
  the fetch-lifecycle setters; `formStateToWizardConfig()` now derives
  `providerOverrides`/`apiKeyOverrides` rather than holding a separate
  key field (structurally can't disagree with what's actually
  assignable); `seedProviders()` reconstructs both from an existing
  config on a re-run.
- **`apps/supervisor/init-form.tsx`** — the Providers screen (`p` from
  setup), the Models screen extended with a per-row provider indicator,
  Ctrl+←/→ to cycle a row's own provider, and a live-fetch `useEffect`
  that fires when the cursor lands on a component row with no
  discovered models yet for its resolved provider — rendering
  "fetching…", a real model list, or an inline error via
  `discoveryHint()`, bounded to the current row only (not all five at
  once).

## Verification performed

- `bun run typecheck` — 0 errors, run after every meaningful step
  (module addition, wizard changes, form-state changes, rendering
  changes).
- `bun test` — **877 pass, 0 fail**, 1707 expect() calls across 57 files
  (pre-063 baseline: 839/0/1621/56 — the delta is exactly this spec's
  38 new tests). Every pre-existing test — including all of
  `init-wizard.test.ts`, `init-form-state.test.ts`,
  `init-web.test.ts` — passes unmodified, confirming this spec's
  additions didn't disturb the existing config contract.
- New `apps/supervisor/model-discovery.test.ts` (9 tests, mocked
  `fetch`): success shape per provider, the OpenAI non-chat filter, the
  Gemini `models/` prefix strip and `generateContent` filter, a non-200
  response, a thrown network error, a genuine bounded-timeout case (the
  mock never resolves; the wrapper's own `AbortController` is what ends
  it), malformed JSON, an empty key short-circuiting before any fetch
  call, and a check that a real key value never leaks into the returned
  result object.
- New/extended tests in `apps/supervisor/init-form-state.test.ts` (29
  new tests) covering: `availableProviders`/`keyForProvider`; the
  Providers screen's cursor/registration/unregistration (including that
  unregistering a provider reverts any component assigned to it, and
  never touches an unrelated component's own override); the Models
  screen's structural provider constraint; the fetch-lifecycle setters;
  `formStateToWizardConfig`'s derivation (including the adversarial
  sweep proving no component/provider combination can ever produce an
  override with an empty key); and seeding round-trips (a component's
  own on-disk provider+key pair reconstructs correctly, a half-set pair
  seeds nothing rather than guessing, a redundant shared-provider
  override doesn't duplicate into `extraProviders`).
- `bun run specs:catalog` / `specs:check` — pass, 65 specs.
- `bun run build` — binary rebuilt successfully (141.0 MB).

## What's not verified here

1. **Live model discovery against a real provider account.** The fetch
   mechanism is implemented and unit-tested against mocked responses
   for all three providers, but no real API call has been made. This is
   the same gap every prior LLM checkpoint in this codebase has needed
   Yusuf's own credentials to close, and can share a session with this
   session's separate, still-open "validate Claude/GPT for real" item.
2. **A real interactive-terminal pass.** The Providers screen and the
   Models screen's new provider picker/discovery hint have never been
   seen in a real terminal — same open item every guided-init checkpoint
   in this codebase carries (specs/048/050/059/062 all needed this).
3. **The browser form's own equivalent UI — explicitly not attempted,
   not silently dropped.** `apps/supervisor/init-web.ts`'s HTML/JS
   submits `modelOverrides: {}` unconditionally today and always has —
   checked directly, it never had a real per-component UI, only backend
   parsing support. This spec's own Scope section said the live-fetch
   call would happen server-side there; that work was not done in this
   pass. The underlying `WizardConfig`/`formatConfigEnv()`/
   `readLlmModelConfig()` layer every surface shares is fully correct
   and already covers whatever the browser form might submit — what's
   missing is purely the browser-side screens and the server route to
   call `listAvailableModels()` on the browser's behalf (the design this
   spec's own Scope section describes, specifically so the key never
   reaches browser JavaScript).

## Out of scope, confirmed untouched

- The classic wizard deliberately still does not ask about
  provider/key overrides — matches `specs/050`'s own precedent for
  model overrides; anything already on disk survives via
  `mergeConfigEnv()`.
- `packages/shared/llm-model-factory.ts`'s resolution logic —
  unchanged; this spec is UI/config-writing only.
- The runtime's required-key startup check — unchanged.

## Update 2026-09-10 — live Gemini pass

Ran `listAvailableModels("gemini", <real key>)` against a real Gemini
account (key from `C:\Users\moham\test-target-project\.orchestrai\
config.env`, supplied by Yusuf): **40 models returned**, correctly
filtered to `generateContent`-capable entries and with the `models/`
prefix stripped. The one open live acceptance criterion is now met for
Gemini. Anthropic/OpenAI remain unverified live (no keys for those this
session); the in-terminal TUI pass is still open.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/063-init-per-component-provider-and-key/spec.md` (implemented,
**partial** verification; amends `050`) closes the gap `050` above
deliberately left open. Two screens, reachable from the TUI form's setup
screen (`p` for Providers, `m` for Models, unchanged): **Providers**
registers a key per provider — the first one registered is the existing
shared `ORCHESTRAI_LLM_PROVIDER`/`_API_KEY`, unchanged; any additional
provider registered stays in wizard-session memory only, available for
assignment, never itself written unless actually assigned to a
component. **Models** then constrains each component's own provider
picker to *only* providers that already have a registered key — not a
validation rule checked afterward, structurally impossible to produce
otherwise, since the picker's own option list is built from exactly
those — and once a row resolves to a provider, live-fetches that
provider's real, current model list using its registered key
(`apps/supervisor/model-discovery.ts`, plain `fetch()` per provider —
Anthropic's real, non-beta `GET /v1/models`, OpenAI's `GET /v1/models`
filtered to exclude embedding/whisper/dall-e/tts/moderation ids,
Gemini's own list filtered to `generateContent`-capable entries) instead
of asking for a free-text model name. This is the first outbound
network call this codebase's *setup* flow ever makes, scoped
deliberately narrowly: an 8-second bound, the key used only in that
one request's own auth header/query param, and any failure (bad key, no
network, timeout) falls back to typing a model in by hand with a visible
inline message — setup is never blocked. What's written to
`.orchestrai/config.env` is unchanged in shape: the existing shared
fields, plus `ORCHESTRAI_<COMPONENT>_LLM_PROVIDER`/`_MODEL`/`_API_KEY`
for any component actually assigned a non-default provider or model —
`readLlmModelConfig()` needed no change. 38 new tests (9 for the
model-discovery fetchers against mocked responses per provider, the rest
for the Providers/Models screens' pure state, including an adversarial
sweep proving no component/provider combination can ever produce an
override with an empty key); all pre-existing tests pass unmodified.
**Not verified**: a live fetch against a real provider account (the
mechanism is implemented and unit-tested, not yet called for real — the
same gap every prior LLM checkpoint here has needed Yusuf's own
credentials to close), a real-terminal pass for the two new screens, and
— an honest, explicitly-acknowledged scope gap, not silently dropped —
the browser form's own equivalent UI: `apps/supervisor/init-web.ts` has
never had a real per-component picker (its HTML/JS submits
`modelOverrides: {}` unconditionally, checked directly), and this spec's
own plan to add a server-side live-fetch route there was not carried
out in this pass.

*Later verification note:* the live model fetch was subsequently
confirmed against a real Gemini key (40 models returned) — see
`specs/063-init-per-component-provider-and-key/verification.md`; the
browser-form gap and the real-terminal pass for the two screens remain
open.

See specs/084-security-external-vulnerability-data/verification.md for the relocated narrative covering this checkpoint.

See specs/050-init-per-agent-llm-toggles/verification.md for the relocated narrative covering this checkpoint.
