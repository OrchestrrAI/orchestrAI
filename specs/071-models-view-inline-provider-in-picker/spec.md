---
id: 071-models-view-inline-provider-in-picker
title: Fold Per-Agent Model & Provider Selection Into the Setup Screen (Retire the Models View)
area: supervisor
change_type: enhancement
status: implemented
verification: pending
created: 2026-09-11
updated: 2026-09-11
approved_by: Yusuf
approved_on: 2026-09-11
implemented_on: 2026-09-11
amends:
  - 050-init-per-agent-llm-toggles
  - 063-init-per-component-provider-and-key
  - 068-init-providers-first-flow-and-model-picker
  - 070-init-agent-implies-llm-and-model-first-setup
related:
  - 048-guided-init-experience
supersedes: []
superseded_by: []
---

# Spec: Fold Per-Agent Model & Provider Selection Into the Setup Screen (Retire the Models View)

> Review gate: **APPROVED 2026-09-11 by Yusuf.**
>
> Written from Yusuf's live feedback, 2026-09-11:
> - *"in the model screen, to choose a different provider for a specific
>   agent I need to go up choosing it and then go down choosing the
>   model."*
> - *"no need for the model to be a separate page, [it] can be on the
>   same page where [I'm] choosing the agent."*
>
> Design decisions taken (Yusuf, 2026-09-11):
> - The per-agent model/provider choice sits in a **"Models" section
>   below the agent list** on the setup screen (not inline on each agent
>   row).
> - **Agents only** in that section: `shared / default` + one row per
>   selected LLM agent. The **Orchestrator** (plan-task planner) and
>   **Conversation** (`/ask` answers) get **no rows** — both fall back
>   to the shared model/provider (`resolveLlmVar()`), and the rare
>   power-user override stays a hand-edit of
>   `ORCHESTRAI_ORCHESTRATOR_LLM_*` / `ORCHESTRAI_CONVERSATION_LLM_*`.
>   (Earlier AskUserQuestion picked "two extra rows"; Yusuf then
>   reconsidered — "why do I need a separate LLM for the chat?" — and
>   asked for the recommendation, which is agents-only for simplicity.)

## Purpose

`specs/063`/`068` put per-component model + provider overrides behind
the `m` key as a separate full-screen **Models view**. Two things Yusuf
hit running it:

1. **It's a separate page nobody finds.** The per-agent model belongs
   next to where you pick agents, on one screen.
2. **Per-agent provider needs `Ctrl+←/→`** — undiscoverable, and
   Windows Terminal / conhost usually eat `Ctrl+Arrow` as word-jump
   before the app sees it. So he cycled the **shared** provider row
   instead, which changes it for every component — the wrong lever.

This spec removes the `m` view and folds its content into a **Models
section on the setup screen**, with provider selection done **inside
the per-row model picker** (plain `←/→`), so choosing "provider X's
model Y for agent Z" is one row, one `Enter`, arrows.

## Verified Current State

Read 2026-09-11 (`apps/supervisor/init-form.tsx`,
`apps/supervisor/init-form-state.ts`):

- `InitFormState.view: "setup" | "models" | "providers"`.
  `initialFormState()` opens on `"providers"` (`specs/068`);
  `modelCursor: 1` (`specs/070`, pins the setup Model row to the
  shared-model row).
- Setup screen (`view: "setup"`): `visibleFields()` →
  `["targetPath", "agents", "llmModel"]` (`specs/070`). The scrollbox
  holds `AgentsSection` + a spacer + one `Model (<provider>)` row that
  is the `specs/068` picker (`ModelPicker` / `setupModelHint`).
- Models view (`view: "models"`, `m` from setup, `Esc` back): rows
  `0` = shared provider cycle, `1` = shared model, `2..N` = one per
  `LLM_COMPONENTS` (`orchestrator`, `documentation`, `devops`,
  `security`, `conversation`). Component row keys: `Ctrl+←/→` →
  `cycleProviderOverrideAtCursor`; `Enter` → `enterModelSelectMode`
  when `canPickModelFromList`, else move; printable → `setModelAtCursor`.
  `ModelPicker` (open): `↑/↓`/`Enter`/`Esc`/`Tab`.
- `openModelsView`/`closeModelsView`/`moveModelCursor`/
  `modelRowComponent`/`MODEL_ROW_COUNT` and the `ModelsView` component
  exist only for that view.
- `availableProviders(state)` = `[llmProvider, ...extraProviders with a
  key]`. `cycleProviderOverrideAtCursor(state, dir)` steps a component
  row's override through `[null (shared), ...extras]`, wrapping.
- The live-discovery `useEffect` already fetches for `view: "setup"`
  against `state.llmProvider` (`specs/070`) and for `view: "models"`
  against `resolvedProviderAtCursor(state)`, re-running on
  `state.providerOverrides` change.
- `agentLlmFieldsFor(state)` = the `AgentLlmField`s of the selected
  agents (`devops`/`documentation`/`security` that have a harness);
  "all" when the selection is empty.

## Proposed Behavior

### 1. A "Models" section on the setup screen

Inside the setup screen's existing scrollbox, **below the Agents list**
(and its "orchestrator and mcp:http are always included" note), a
**Models** section:

```
Models  ↑↓ move · Enter pick provider + model · type to set
  ▸ shared / default        gemini-2.5-flash
    devops-agent            (shared)
    documentation-agent     (shared)
    security-agent          (shared)
```

Rows, in order:

1. **`shared / default`** — the existing shared model
   (`state.llmModel`, `ORCHESTRAI_LLM_MODEL`). Its resolved provider is
   the primary (`state.llmProvider`).
2. **One row per selected agent that has an LLM component** — labelled
   by the agent name (`devops-agent` → the `devops` component,
   `documentation-agent` → `documentation`, `security-agent` →
   `security`). A **deselected** agent has **no row** (matching
   `specs/070`: selected ⇒ LLM; deselected ⇒ nothing written). "All
   selected" (empty selection) shows all three agent rows.

**No `orchestrator` or `conversation` row.** Both LLM components keep
resolving to the shared model/provider via `resolveLlmVar()` exactly as
today; overriding them stays a hand-edit of
`ORCHESTRAI_ORCHESTRATOR_LLM_*` / `ORCHESTRAI_CONVERSATION_LLM_*` (rare,
power-user). The guided screen stays "pick your agents, optionally give
one its own model."

`(shared)` on a row means no override — `resolveLlmVar()` falls back to
the shared model, exactly as today; the row writes no
`ORCHESTRAI_<COMPONENT>_LLM_MODEL` line.

### 2. Navigation: a `models` focus with its own sub-cursor

- `FormFieldId` becomes `"targetPath" | "agents" | "models"` — `Tab`
  moves between the three; `visibleFields()` returns exactly those.
- New state `modelsCursor: number` — which Models-section row is
  highlighted, mirroring how `agentCursor` works for the Agents list.
  `Tab` into `models` lands on `modelsCursor`; `↑/↓` move it, bounded
  to the visible row count (which changes with the agent selection).
- A pure `modelsRows(state)` helper returns the ordered row list —
  `"shared"` first, then the `LlmComponent` for each selected agent
  that has one (`agentLlmFieldsFor(state)` mapped to its component;
  never `orchestrator`/`conversation`) — so the renderer, the cursor
  bounds, and the write path never disagree.

### 3. Per-row keys (picker closed)

On the highlighted Models row:

- **`Enter`** — opens the picker (see §4) when there's a choice: a
  model list exists for the row's resolved provider **or** (component
  rows only) `availableProviders(state).length > 1`. Otherwise `Enter`
  just moves to the next row.
- **printable / `Backspace`** — free-text edit of that row's model id
  (the `specs/068` fallback, unchanged): `setRowModel(state, value)`
  writes `state.llmModel` for the `shared` row, `modelOverrides[c]` for
  a component row.
- **`Ctrl+←/→`** — still cycles a **component** row's provider override
  (`cycleProviderOverrideAtCursor`), kept as a power-user shortcut. A
  no-op on the `shared` row and when `<2` providers are registered.

### 4. The picker gains an inline provider line

When the picker is open on a **component** row and
`availableProviders(state).length > 1`, it renders one line above the
model list:

```
    provider: ‹ gemini ›   openai · anthropic also registered
    ────────────────
  ▸ gemini-2.5-flash
    gemini-2.5-pro
    3–7 of 40
```

- **`←` / `→`** (plain — picker mode is not text-entry, so there's no
  in-string cursor to steal) cycles that component's provider override
  **and resets the model sub-cursor to 0**. The list below re-resolves
  to the newly selected provider, reusing the existing loading / error
  / list states.
- **`↑` / `↓`** move the model sub-cursor; **`Enter`** picks the
  highlighted model id; **`Esc`** leaves to free-text on that row,
  provider intact.
- The **`shared`** row's picker has **no** provider line — its provider
  is the primary, set on the Providers step. With exactly one provider
  registered, no component row shows the line either — the picker is
  visually identical to `specs/068`/`070`.

### 5. Retire the Models view

`view: "models"`, the `m` keybinding, `openModelsView` /
`closeModelsView` / `moveModelCursor` / `modelRowComponent` /
`MODEL_ROW_COUNT`, and the `ModelsView` component are **removed**.
`InitFormState.view` becomes `"setup" | "providers"`. `modelCursor` is
removed (replaced by `modelsCursor`). `p` still opens the Providers
step from the setup screen.

The `specs/068` picker primitives that stay — `enterModelSelectMode`,
`exitModelSelectMode`, `moveModelPickerCursor`, `pickModelFromList`,
`canPickModelFromList`, `modelPickerWindow`, `MODEL_PICKER_WINDOW`,
`ModelPicker`, `modelListForCursor` — are re-pointed from `modelCursor`
to `modelsCursor` + `modelsRows()`.

### 6. No change to what's written

`.orchestrai/config.env` is byte-identical for the same end state. The
`shared` row → `ORCHESTRAI_LLM_MODEL`; a component row with an override
→ `ORCHESTRAI_<COMPONENT>_LLM_MODEL` (+ `_LLM_PROVIDER` / `_LLM_API_KEY`
when its provider differs from the primary, via the existing
`formStateToWizardConfig()` derivation from `state.providerOverrides` +
`keyForProvider()`). A `(shared)` row writes nothing. Setting a
provider via the picker's `←/→` vs `Ctrl+←/→` produces identical
output — same function.

## Scope

- `apps/supervisor/init-form-state.ts`: `FormFieldId` → 3 values;
  `view` → 2 values; `modelCursor` → `modelsCursor`; remove
  `openModelsView`/`closeModelsView`/`moveModelCursor`/`modelRowComponent`/
  `MODEL_ROW_COUNT`; add `modelsRows(state)`, `moveModelsCursor`,
  `rowModelValue`/`setRowModel`, `cyclePickerProvider` (=
  `cycleProviderOverrideAtCursor` then `modelPickerCursor: 0`),
  `canOpenRowPicker`; re-point the retained `specs/068` helpers;
  `initialFormState()` → `modelsCursor: 0` (no `modelCursor`);
  `fieldScrollOffset()` extended for the Models section.
- `apps/supervisor/init-form.tsx`: delete the `view === "models"`
  keyboard block and the `ModelsView` component; render the Models
  section inside the setup scrollbox; `focus === "models"` keyboard
  handling (§3); the picker's provider line + `←/→` handling (§4);
  remove the `m` keybinding; subtitle/footer hint text reworded;
  `setupModelHint` generalised to "the current Models-row's resolved
  provider".
- Tests: `apps/supervisor/init-form-state.test.ts` — `modelsRows` for
  every agent-selection shape; `moveModelsCursor` bounds; a
  picker-`←/→` vs `Ctrl+←/→` round-trip producing identical
  `formatConfigEnv()`; `fieldScrollOffset` for the new section;
  removal of the `view: "models"` tests.
- **Out of scope / unchanged**: the Providers step (`specs/068`, still
  step 1, `p` still opens it); `apps/supervisor/init-web.ts` (browser
  form — still the standing `063`/`068` gap); the classic prompt
  wizard; `model-discovery.ts`; the closed 3-provider set; per-component
  model metadata in the picker.

## Safety and Compatibility Constraints

- **Row-budget.** The Models section lives inside the setup screen's
  existing `<scrollbox>` (which already scrolls and follows focus via
  `fieldScrollOffset`); it adds no unbudgeted height. The picker and
  its one-line provider row render inside that same fixed region,
  bounded/paged exactly as `specs/068`/`070` established — no wrapped
  or off-screen line. The 80×24 minimum is a live-verification gate.
- **Byte-identical written config** for the same provider+model end
  state, however it was set.
- **Plain `←/→`** is claimed only while `state.modelPickerOpen` on a
  component row; the closed free-text row keeps `←/→` free for future
  in-string cursor editing, as `specs/063` intended. `Ctrl+←/→` still
  works.
- **`specs/070`'s model is preserved** — selected agent ⇒ its LLM path
  runs ⇒ it gets a Models row; deselected ⇒ no row, no line.

## Out of Scope / Non-Goals

- Any provider/model selection on the browser form.
- Inline-on-the-agent-row model editing (Yusuf chose the section
  layout).
- Multi-key-per-provider or changing the 3-provider set.
- A separate "advanced" Models view — it's fully retired.

## Acceptance Criteria

- [x] The setup screen shows **Target → Agents → Models** (a section:
      `shared / default`, then one row per selected LLM agent — no
      `orchestrator`/`conversation` rows). No `m` key, no separate view.
      **Live-smoked in a real PTY at 80×24** (see verification.md) —
      header, Agents list, and a 4-row Models section (shared + 3
      selected agents) rendered clean, no corruption.
- [x] `Tab` reaches the Models section; `↑/↓` move a visible cursor
      through its rows (`moveModelsCursor`, bounded to `modelsRows()`);
      a deselected agent has no row — proven by test
      (`modelsRows`/`toggleAgentAtCursor` clamp tests).
- [~] `Enter` on a component row with ≥2 providers registered opens a
      picker whose top line shows that row's provider; plain `←/→`
      cycles it and the model list re-resolves; `↑/↓`/`Enter` pick a
      model. **Mechanism in place and pure-state tested
      (`canOpenRowPicker`, `cyclePickerProvider`); the picker's own
      render with the provider line + a live 2-provider registration
      needs Yusuf's terminal** — the implementing environment has no
      raw-mode stdin to drive `Enter`/arrows interactively.
- [x] Switching provider inside the picker resets the model sub-cursor
      to the top — `cyclePickerProvider` test.
- [x] With one provider registered, the picker has no provider line and
      behaves exactly as `specs/068`/`070` — `ModelsSection`'s render
      guard (`availableProviders(s).length > 1`) plus the `canOpenRowPicker`
      "false with one provider" tests.
- [x] A component assigned `provider`+`model` via the picker writes the
      same `config.env` as one assigned via `Ctrl+←/→` + typing —
      proven by test (both paths call the same `setProviderOverrideAtCursor`
      / `setModelAtCursor`).
- [~] No wrapped / off-screen line at 80×24 with the Models section and
      an open picker. **The section itself is live-confirmed clean at
      80×24; the open-picker case (needs a real fetched list) is
      pending the same live pass as above.**
- [x] `bun test` (880 pass), `bun run typecheck` (0 errors),
      `bun run specs:check` (70 specs) pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Pure unit tests as listed under Scope.
- A live real-terminal pass at 80×24 and larger with **two** registered
  providers: Tab to Models, open a component row's picker, switch its
  provider with `←/→`, pick a model, confirm the written
  `config.env` (`ORCHESTRAI_<COMPONENT>_LLM_PROVIDER` / `_MODEL` /
  `_API_KEY` for the non-primary one, nothing for `(shared)` rows).

## Approval Requested

Approve to proceed. Amends `specs/050` (the setup screen's shape),
`specs/063` (how the per-component provider override is chosen),
`specs/068` (the model picker's contents + the Models view is retired),
and `specs/070` (the setup screen's field list). Nothing is implemented
until then.
