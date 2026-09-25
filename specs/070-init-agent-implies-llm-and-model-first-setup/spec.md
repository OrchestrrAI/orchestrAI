---
id: 070-init-agent-implies-llm-and-model-first-setup
title: Guided Init — Agent Selection Implies LLM, and a Model-First Setup Screen
area: supervisor
change_type: enhancement
status: implemented
verification: pending
created: 2026-09-10
updated: 2026-09-10
approved_by: Yusuf
approved_on: 2026-09-10
implemented_on: 2026-09-10
amends:
  - 050-init-per-agent-llm-toggles
  - 068-init-providers-first-flow-and-model-picker
  - 063-init-per-component-provider-and-key
related:
  - 048-guided-init-experience
  - 031-interactive-init-wizard
supersedes: []
superseded_by: []
---

# Spec: Guided Init — Agent Selection Implies LLM, and a Model-First Setup Screen

> Review gate: **APPROVED 2026-09-10 by Yusuf** ("ok go ahead").
>
> Written from Yusuf's live feedback after running `specs/068`,
> 2026-09-10 (with a screenshot of the setup screen):
> 1. *"the first screen worked"* — the Providers step (`specs/068`) is good.
> 2. *"the model screen [is] not user friendly and didn't retrieve the
>    models"* — the per-component Models view (`m`) is a detour, and on
>    the setup screen the model row never live-fetches at all, so with
>    Gemini selected you are stuck staring at a red "A model is required
>    for gemini" with no list to pick from.
> 3. *"don't choose if [to] make the other agent llm or not — if i chose
>    an agent that means it will be llm"* — the DevOps/Documentation/
>    Security LLM on/off toggle rows are unwanted; selecting the agent
>    should be the whole decision.
> 4. *"the bottom part is no need, i think we can replace it with the
>    model"* — the setup screen's Provider row and API-key row duplicate
>    what the Providers step now owns; that whole block should become
>    just model selection.

## Purpose

`specs/068` made Providers step 1 (register the providers you have +
their keys). That leaves the setup screen carrying three things it no
longer needs to:

- **Per-agent LLM toggles** (`specs/050`) — three extra rows asking a
  question Yusuf doesn't want asked.
- **A Provider cycle row** — provider is chosen on the Providers step now.
- **An API-key row** — key is registered on the Providers step now.

And it is *missing* the one thing that belongs there: a real, live
model picker for the chosen provider, so Gemini (which has no default
model) is actually completable without the `m` detour.

This spec collapses the setup screen to **target path → agents →
model**, and makes "is this agent an LLM agent?" identical to "is this
agent selected?".

## Verified Current State

Read 2026-09-10 (`apps/supervisor/init-form-state.ts`,
`apps/supervisor/init-form.tsx`):

- `InitFormState.agentLlm: Record<AgentLlmField, boolean>` is a
  user-toggled field. `toggleAgentLlm()` flips one gate;
  `AGENT_LLM_HARNESSES` (`init-wizard.ts`) maps agent → field → env var
  → label. `visibleFields()` = `[...BASE_FIELDS, ...agentLlmFieldsFor(state),
  ...PROVIDER_FIELDS]`; `formStateToWizardConfig()` writes
  `agentLlm[field] = state.agentLlm[field]` for every field in
  `agentLlmFieldsFor(state)` (the fields of the selected agents, or all
  agents when none are ticked). `init-form.tsx` renders a `ToggleRow`
  per visible harness field, and `space`/`return` on a focused one calls
  `toggleAgentLlm`.
- `PROVIDER_FIELDS = ["llmProvider", "llmModel", "llmApiKey"]`. The setup
  screen renders a `FieldRow` for each: Provider is a left/right cycle
  through `LLM_PROVIDERS`; Model is free-text (`state.llmModel`); API key
  is `Enter → onRequestApiKey` (the masked reader).
- The live-discovery `useEffect` is gated `state.view !== "models" ||
  state.modelCursor < 1` — it **only ever runs on the Models view**, so
  the setup screen's Model row is pure free-text with no list, ever.
- `keyForProvider(state, provider)` returns `state.llmApiKey` when
  `provider === state.llmProvider`, else `state.extraProviders[provider]
  ?? ""`. **Seam bug**: register a key for provider X on the Providers
  screen while `llmProvider` is still Y (so it lands in
  `extraProviders[X]`), then change the provider to X — `keyForProvider`
  now takes the `provider === llmProvider` branch and reads the *empty*
  `llmApiKey`, stranding the real key in `extraProviders[X]`. This is the
  most likely cause of "didn't retrieve the models": the discovery
  effect's `if (!key) return` fires.
- `validate()` still requires a non-empty `llmModel` when
  `llmProvider === "gemini"` (the red error in the screenshot).

## Proposed Behavior

### 1. Selecting an agent turns its LLM harness on — no separate toggle

- The `ToggleRow`s for `devopsLlm` / `documentationLlm` / `securityLlm`
  are **removed from the setup screen**. `toggleAgentLlm` and the
  keyboard branch that calls it are removed. `AgentLlmField` /
  `AGENT_LLM_HARNESSES` stay (the serializer and env-var mapping still
  need them).
- `InitFormState.agentLlm` is **derived, not stored**: an agent that is
  selected (or every agent, when the selection is empty === "all") and
  has a harness writes `ORCHESTRAI_<AGENT>_LLM_HARNESS=1`; a deselected
  agent writes **no line** for its harness (not `=0`). `visibleFields()`
  drops `agentLlmFieldsFor(state)` from the middle — the focus ring
  becomes `targetPath → agents → model` only.
- `formStateToWizardConfig()` sets `agentLlm[field] = true` for every
  field in `agentLlmFieldsFor(state)` (that helper already returns
  exactly the selected agents' fields, "all" when none are ticked).
- The Agents list's own row rendering gains a small hint that a ticked
  agent with a harness runs its LLM path (e.g. an `LLM` tag on the
  row), so the implied behavior is visible.
- **`specs/050`'s "an all-off config writes each gate explicitly `=0`"
  is intentionally reversed** here: there is no "all-off" any more —
  selected means on, deselected means the line is simply absent, which
  `resolveLlmVar()` / each agent's own `=== "1"` gate already treats as
  off. The `specs/050` test that pins `=0` output is updated to pin the
  new "selected → `=1`, deselected → absent" behavior.

### 2. The setup screen's LLM block becomes model selection only

- `PROVIDER_FIELDS` on the setup screen becomes just `["llmModel"]`. The
  **Provider cycle row and the API-key row are removed** from the setup
  screen — both are owned by the Providers step (`specs/068`) now.
  `cycleProvider` on the setup screen and the setup-screen
  `onRequestApiKey` path are removed (the Providers screen keeps its own
  `registerProviderKey` / masked reader, unchanged).
- The remaining **Model row is a live picker**, not free-text-only:
  - The live-discovery `useEffect` is un-gated from `view === "models"`
    so it **also runs for the setup screen's Model row**, fetching the
    primary provider's real model list with the primary provider's
    registered key.
  - The row shows the `specs/068` `ModelPicker` (Enter to open, ↑/↓,
    Enter to pick, Esc to type) exactly as the Models view already does,
    bounded/paged, inside the setup screen's existing scrollable region.
  - Free-text stays the fallback for a failed/timed-out fetch and for a
    model id not in the list — unchanged from `specs/068`.
- `m` still opens the full **per-component Models view** for overrides
  (`specs/063`) — that view is unchanged by this spec except that it no
  longer needs its row-1 "shared" model to be the only place a model is
  picked.

### 3. The primary provider + key are whatever the Providers step registered

- After the Providers step, `state.llmProvider` / `state.llmApiKey` are
  the **primary** registered credential: the first provider registered
  on the Providers screen, or the one explicitly marked primary there.
  `registerProviderKey` for the primary provider writes `llmApiKey`
  directly; there is no path left on the setup screen that changes
  `llmProvider` out from under an already-registered key.
- **`keyForProvider()` is made loss-proof regardless**: when
  `provider === state.llmProvider` and `state.llmApiKey` is empty, it
  falls back to `state.extraProviders[provider] ?? ""` before giving up.
  A key registered for a provider is found no matter which slot holds
  it. (Defence in depth — the primary path above should already prevent
  the stranding.)

### 4. No change to what's written

`.orchestrai/config.env` keeps exactly the `specs/063`/`068` shape:
`ORCHESTRAI_LLM_PROVIDER` / `_MODEL` / `_API_KEY`, the per-component
`ORCHESTRAI_<COMPONENT>_LLM_*` overrides, and
`ORCHESTRAI_<AGENT>_LLM_HARNESS`. The only serialized difference from
`specs/050` is item 1's "deselected agent → no harness line" (was
`=0`). A config produced for the same target/agents/provider/key/model
is otherwise byte-identical.

## Scope

- `apps/supervisor/init-form-state.ts`: `agentLlm` becomes derived;
  `toggleAgentLlm` removed; `visibleFields()` / `PROVIDER_FIELDS` /
  `fieldScrollOffset()` adjusted for the shorter field list;
  `formStateToWizardConfig()` derives `agentLlm` from the selection;
  `keyForProvider()` fallback; `validate()` unchanged (gemini still
  needs a model — now satisfiable via the picker).
- `apps/supervisor/init-form.tsx`: remove the `ToggleRow` block and the
  Provider/API-key `FieldRow`s from the setup screen; render the Model
  row as the `ModelPicker`; un-gate the discovery `useEffect`; drop the
  setup-screen `cycleProvider` / `onRequestApiKey` key branches; add the
  Agents-list `LLM` hint.
- Tests: `apps/supervisor/init-form-state.test.ts` — update the
  `specs/050` gate tests for "selected → =1, deselected → absent",
  update `visibleFields`/`fieldScrollOffset` expectations, add a
  `keyForProvider` no-loss test, add a "setup-screen model row fetches"
  behavioural note (pure-state portion only).
- `apps/supervisor/init-web.ts`: item 1 applied consistently — the
  "Per-agent LLM harness" checkbox section, its client-JS collection,
  and `parseSubmission`'s `agentLlm` handling are **removed** (a
  deletion of what `specs/050` added to this surface; `agentLlm` is
  derived from the selection by the shared `formStateToWizardConfig()`).
  The browser form's Provider / Model / API-key card is **untouched** —
  the providers/models UI rework there is still the deferred
  `specs/063`/`068` follow-up.
- **Out of scope / unchanged**: the browser form's providers/models UI
  (the `specs/063`/`068` gap), `apps/supervisor/init-wizard.ts`'s
  classic prompt sequence (still asks y/n per agent),
  `model-discovery.ts`, `AGENT_LLM_HARNESSES` / `AgentLlmField` (kept —
  the serializer still needs the agent→var mapping), the closed
  3-provider set, model metadata in the picker.

## Safety and Compatibility Constraints

- **The classic prompt wizard and `--web` are untouched.** Only the TUI
  form surface changes.
- **Byte-identical written config** for equivalent answers, except the
  single intentional change in item 1 (deselected agent → no harness
  line instead of `=0`), which is safe: absent already means off
  everywhere that reads it.
- **No new row-budget risk.** The setup screen gets *shorter* (three
  toggle rows + two field rows removed, one picker added); the picker
  renders inside the existing scrollable region, bounded/paged, exactly
  as `specs/068` established.
- **Free-text model entry is never removed** — still the fallback for a
  failed fetch or an id not in the list.
- **No credential is ever lost** — `keyForProvider()`'s fallback
  guarantees a registered key is found regardless of which slot holds it.

## Out of Scope / Non-Goals

- The browser form's equivalent simplification (separate follow-up, same
  standing `specs/063`/`068` gap).
- Any change to the classic wizard's flow or prompts.
- Multi-key-per-provider or changing the closed 3-provider set.
- Re-designing the per-component Models view (`m`) beyond what item 2
  already implies.
- Removing `AGENT_LLM_HARNESSES` / `AgentLlmField` — the serializer
  still needs the agent→var mapping.

## Acceptance Criteria

- [x] The setup screen shows exactly **Target project → Agents →
      Model** — no LLM on/off toggles, no Provider row, no API-key row.
      `visibleFields()` → `["targetPath", "agents", "llmModel"]`, proven
      by test. **Live-render pending** (needs a raw-mode terminal).
- [x] Ticking an agent that has a harness writes
      `ORCHESTRAI_<AGENT>_LLM_HARNESS=1`; unticking it writes no harness
      line for that agent — proven by test.
- [~] The setup-screen Model row live-fetches the primary provider's
      real model list (using the key registered on the Providers step)
      and offers the `specs/068` arrow-picker; a failed fetch still
      accepts a typed id. **Wired (the discovery `useEffect` now also
      runs for `view: "setup"` against `state.llmProvider`; the row
      renders `ModelPicker` / `setupModelHint`); the live real-terminal
      + real-Gemini pass is Yusuf's — the implementing env has no
      raw-mode stdin, so `orchestrai init` there only reaches the
      classic wizard.**
- [~] With Gemini selected, picking a model from the list clears the
      "A model is required for gemini" error and lets `^S`/`^X` proceed
      — mechanism in place (`pickModelFromList` → `setModelAtCursor` →
      `llmModel`, which `validate()` checks); live pending.
- [x] A key registered on the Providers step is always found by
      `keyForProvider()` regardless of provider ordering — the fallback
      is in and covered by a dedicated no-loss test.
- [x] `bun test` (869 pass), `bun run typecheck` (0 errors),
      `bun run specs:check` (69 specs) pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Pure unit tests: the derived-`agentLlm` serialization (selected → =1,
  deselected → absent, "all" when empty); the shortened
  `visibleFields()` / `fieldScrollOffset()`; `keyForProvider()` no-loss;
  a list-pick vs typed round-trip still byte-identical.
- A live real-terminal pass with a real Gemini key: register it on the
  Providers step, advance, land on the setup Model row, watch the list
  populate, pick one, confirm the written `config.env`.

## Approval Requested

Approve this spec to proceed. It amends `specs/050` (removes the
toggles), `specs/068` (moves the picker onto the setup screen), and
`specs/063` (the `keyForProvider` no-loss fix). Nothing is implemented
until then.
