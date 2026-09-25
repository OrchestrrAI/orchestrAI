# Verification — 071 Fold Per-Agent Model & Provider Selection Into the Setup Screen

Status: **pending** — every pure-state property is unit-tested and the
full suite / typecheck / spec governance pass. The base Models-section
layout is live-smoked clean at 80×24 in a real PTY. The interactive
picker (Enter → provider line → arrows → pick) needs a real raw-mode
terminal with two registered providers — the implementing environment
has no raw-mode stdin, so `orchestrai init` there only ever reaches the
classic wizard, the same gap every guided-init checkpoint here carries.

## What changed

### 1. The `m` Models view is retired

- `apps/supervisor/init-form-state.ts`: `InitFormState.view` is now
  `"setup" | "providers"` (was `"setup" | "models" | "providers"`).
  `openModelsView`, `closeModelsView`, `moveModelCursor`,
  `modelRowComponent`, `MODEL_ROW_COUNT` are all removed. `modelCursor`
  is replaced by `modelsCursor`.
- `apps/supervisor/init-form.tsx`: the `view === "models"` keyboard
  block and the `ModelsView` component are deleted; the `m` keybinding
  is gone.

### 2. The Models section lives on the setup screen

- `FormFieldId` is `"targetPath" | "agents" | "models"` — one focus
  target for the whole section (mirrors how `"agents"` is one focus
  target for the whole agent list).
- New `modelsRows(state)`: `["shared", ...]` then one `LlmComponent` per
  `agentLlmFieldsFor(state)` entry (i.e. one per selected agent with a
  harness) — **never** `orchestrator`/`conversation` (Yusuf: "why do I
  need a separate LLM for the chat?" — both keep falling back to the
  shared model, overridden only by hand-editing `config.env`).
- New `modelsCursor: number` (replacing `modelCursor`), mirroring
  `agentCursor`. `moveModelsCursor` wraps within `modelsRows().length`
  and closes any open picker. `toggleAgentAtCursor` now also clamps a
  stranded `modelsCursor` back into range (and closes the picker) when
  deselecting an agent shrinks the section out from under it.
- `setModelAtCursor`/`modelAtCursor`/`setProviderOverrideAtCursor`/
  `resolvedProviderAtCursor`/`cycleProviderOverrideAtCursor`/
  `modelListForCursor` are all re-pointed from the old
  `modelCursor`/`modelRowComponent` scheme to `modelsCursor` +
  `modelsRows()`/a new internal `rowComponentAtCursor()`.
- New `apps/supervisor/init-form.tsx` `ModelsSection` component renders
  the section (label, resolved provider tag, value or "(shared)"/"(pick
  from the list or type one)", live-fetch hint or picker under the
  highlighted row) — replacing the retired `ModelsView`'s row rendering,
  folded into the setup screen's existing scrollbox instead of a
  separate full-screen box.

### 3. The picker gains an inline provider line (§4)

- New `cyclePickerProvider(state, dir)`: cycles the row's provider
  override (`cycleProviderOverrideAtCursor`) and resets
  `modelPickerCursor` to 0 — but only when something actually changed
  (detected by reference equality on the no-op return), so pressing
  `←/→` on the shared row or with no extra provider registered never
  disturbs an unrelated sub-cursor position.
- New `canOpenRowPicker(state)`: true when a model list already exists
  for the row, **or** (component rows only) a second provider is
  registered — this is what lets `Enter` open the picker specifically to
  switch providers before that provider's own list has loaded.
  `enterModelSelectMode` now gates on this instead of "list non-empty"
  alone, so it can open with an empty list.
- `apps/supervisor/init-form.tsx`: while the picker is open, plain
  `←`/`→` call `cyclePickerProvider`; `Ctrl+←/→` still works with the
  picker closed (`cycleProviderOverrideAtCursor` directly), kept as a
  power-user shortcut. New `ProviderPickerLine` component renders
  `provider: ‹ x › ... also registered`, shown only on a component row
  with `availableProviders(s).length > 1`.

### 4. No change to what's written

`pickModelFromList()`/picker-set provider vs. `Ctrl+←/→` + typed both
go through the exact same `setModelAtCursor()`/
`setProviderOverrideAtCursor()`, so the written `config.env` is
byte-identical regardless of which path set them — proven by test.

## Tests (`apps/supervisor/init-form-state.test.ts`, extensively rewritten)

- **visibleFields/moveFocus**: `["targetPath", "agents", "models"]`;
  wraps through the three fields.
- **agent selection**: new test for the `toggleAgentAtCursor` clamp —
  deselecting an agent shrinks `modelsRows()` and clamps a stranded
  `modelsCursor` back into range, closing any open picker.
- **specs/071 — the Models section**: `modelsRows` shape for every
  selection (all/one/none); a hand-edited orchestrator override still
  round-trips purely through seeding (no UI row needed); clearing/
  whitespace/row-0-is-shared/cursor-wrap tests, all re-pointed to
  `modelsCursor`/`modelsRows`.
- **Models section — provider picker**: re-pointed structural
  footgun-prevention tests (assigning/clearing an override, the shared
  row always resolving to the primary), including the adversarial sweep
  — now explicitly scoped to `modelsRows().filter(r => r !== "shared")`
  since `orchestrator`/`conversation` have no row to reach them through
  any more.
- **cycleProviderOverrideAtCursor**: re-pointed; the old "no-op on row
  0/1" collapses to "no-op on the shared row" since there's no more
  separate provider-cycle row.
- **cyclePickerProvider** (new): cycles + resets the sub-cursor; a
  genuine no-op (shared row, or nothing to cycle) never touches
  `modelPickerCursor`.
- **canOpenRowPicker** (new): true with an existing list; true on a
  component row with a second provider registered even with no list yet;
  false on the shared row or a component row with only one provider and
  no list.
- **specs/068/071 — the Models section's model picker**: re-pointed
  `withList()` helper (row 0 = shared by default); the byte-identical
  list-pick-vs-typed round-trip now covers the shared row (index 0) and
  an agent row (index 1); a new test for opening with an empty list when
  a second provider is registered.
- **modelPickerWindow paging math**: unchanged, still passing.

## Suite

- `bun test` — 880 pass, 0 fail (net unchanged from pre-071's 880 —
  removed the old Models-view-specific tests, added the specs/071
  replacements).
- `bun run typecheck` — 0 errors.
- `bun run specs:catalog` + `bun run specs:check` — pass, 70 specs.
- `bun run build` — succeeds, 110.1 MB.

## Live smoke (real PTY, 80×24)

Forced `initialFormState()`'s `view` to `"setup"` and `focus` to
`"models"` temporarily (reverted immediately after, confirmed via
`git diff` back to the committed state) and ran the real
`runInitForm()` under this environment's PTY (fixed at 80×24, no
raw-mode stdin — confirmed a real rendered frame, not a guess):

```
▸ Models  ↑↓ move · Enter pick provider + model
▸ shared / default      (pick from the list or type one)█
    register anthropic's key on the Providers screen (p) to load its models
  devops-agent          (shared)
  documentation-agent   (shared)
  security-agent        (shared)
```

Clean — header, Agents list, blank, Models section (4 rows: shared +
the 3 default-selected LLM agents), the "register the key" hint on the
focused shared row, footer all rendered with no overflow, no wrapped
line, no corruption. This confirms the base layout at the 80×24 minimum;
it does not exercise the picker itself (needs a real registered key to
fetch a list, and a second provider to see the inline provider line —
neither reachable without live network + a second real key in this
session).

## Correction, same day — the Agents checkboxes didn't reflect "empty = all"

Yusuf, live: *"works fine but when [I] deselect all it appears instead
of not"* — with every agent checkbox unticked, the Models section still
listed all three agent rows. That's not a Models bug: an empty
`selectedAgents` has always meant **"all"** at write time
(`selectedAgentsToOnly()`, matching the classic wizard's own "all"
answer and a blank `ORCHESTRAI_ONLY=`), and the Models section
(`modelsRows()` → `agentLlmFieldsFor()`) and the footer's "agents: all"
already reflected that correctly. Only the **checkboxes** were wrong —
`AgentsSection` rendered `selected = state.selectedAgents.includes(...)`,
which is false for everyone when the array is empty, showing `[ ]` for
all four even though every one of them will actually run.

Fixed in `apps/supervisor/init-form.tsx`'s `AgentsSection`:
`selected = allSelected || state.selectedAgents.includes(agent.name)`
where `allSelected = state.selectedAgents.length === 0`. A rendering-only
correction — no change to `selectedAgents`, `modelsRows()`,
`agentLlmFieldsFor()`, or anything written to `config.env`; no new spec
(this is CLAUDE.md's "documentation/rendering correction to match
already-implemented, already-approved behavior" carve-out, not a new
decision). The browser form (`init-web.ts`) has the same underlying
display gap but was left alone — its checkboxes are server-rendered once
per page load and a live "all agents re-check themselves" behavior needs
client-side JS, a larger change than this fix; it's folded into the
standing, already-documented `063`/`068`/`070` browser-form UX gap.

Live-smoked in the same real PTY (same temporary-`view`-plus-a-forced-
`selectedAgents: []` technique as above, reverted immediately after,
confirmed via `git diff`): with nothing selected, every Agents row now
renders `[x]` (green), matching the footer's "agents: all" and the
Models section's three agent rows.

`bun run typecheck` clean, `bun test` 222/222 in `apps/supervisor/`
after the fix (no test changes needed — this is pure JSX rendering,
consistent with every other layout finding in this file being verified
live rather than by unit test).

## Live pass still owed (Yusuf's terminal)

1. Register two real provider keys on the Providers step (e.g. Gemini +
   OpenAI).
2. Tab to Models, land on an agent row, press Enter — the picker opens
   with the `provider: ‹ x › ... also registered` line on top.
3. Plain `←`/`→` cycles that row's provider; the model list re-resolves
   (loading → real list); `↑`/`↓` move the sub-cursor; `Enter` picks.
4. Confirm the written `config.env`:
   `ORCHESTRAI_<COMPONENT>_LLM_PROVIDER`/`_MODEL`/`_API_KEY` for the
   picked row, nothing for the rows left `(shared)`.
5. Re-confirm at a typical size (~120×32) and a zoomed-out terminal with
   an open picker — the standard live-verification gate every
   guided-init checkpoint here carries.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**The standalone Models view (`m`) is retired by
`specs/071-models-view-inline-provider-in-picker/spec.md` (implemented,
`verification: pending`; amends `050`/`063`/`068`/`070`), 2026-09-11.**
Two things Yusuf hit live: *"to choose a different provider for a
specific agent I need to go up choosing it and then go down choosing
the model"* (the per-component provider override needed `Ctrl+←/→` —
undiscoverable, and Windows Terminal usually eats `Ctrl+Arrow` as
word-jump) and *"no need for the model to be a separate page, [it] can
be on the same page where [I'm] choosing the agent."* `view: "models"`,
`openModelsView`/`closeModelsView`/`moveModelCursor`/`modelRowComponent`/
`MODEL_ROW_COUNT`, the `m` keybinding, and the `ModelsView` component
are all deleted; `InitFormState.view` is now just `"setup" |
"providers"`. In their place, a **Models section** lives inside the
setup screen's own scrollbox, right below the Agents list: `shared /
default` plus one row per selected agent that has an LLM harness —
**deliberately no `orchestrator`/`conversation` row** (Yusuf, after an
AskUserQuestion first picked "two extra rows": *"why do I need a
separate LLM for the chat?"* — both keep falling back to the shared
model; overriding them stays a hand-edit of
`ORCHESTRAI_ORCHESTRATOR_LLM_*`/`ORCHESTRAI_CONVERSATION_LLM_*`). One
new `FormFieldId` (`"models"`, replacing `"llmModel"`) for the whole
section, `Tab`-reachable like `"agents"`; a new `modelsCursor` (mirroring
`agentCursor`) picks the row, via a new pure `modelsRows(state)` —
`["shared", ...agentLlmFieldsFor(state) mapped to components]` — so the
screen and the write path can't disagree about which rows exist.
Deselecting an agent now clamps a stranded `modelsCursor` back into
range and closes any open picker (a real gap this checkpoint's own
`toggleAgentAtCursor` change closes, not present before since the old
Models view's row count never varied with the selection).

**The picker itself gains an inline provider line (§4)**: opening it
(`Enter`, still gated by a new `canOpenRowPicker()` — a real list *or*,
on a component row, a second registered provider to switch to even
before its own list has loaded) shows `provider: ‹ x › ... also
registered` on top when `availableProviders(s).length > 1`; plain
`←`/`→` (picker mode is never text entry, so there's no in-string
cursor to steal) cycles that row's provider via a new
`cyclePickerProvider()`, which also resets the model sub-cursor to 0 —
detected via reference-equality on `cycleProviderOverrideAtCursor()`'s
own no-op contract, so pressing arrows on the shared row or with only
one provider registered never disturbs an unrelated cursor position.
`Ctrl+←/→` still cycles the override with the picker closed, kept as a
power-user shortcut alongside the new plain-arrow path. **What's
written is unchanged** — the picker and `Ctrl+←/→` both call the exact
same `setProviderOverrideAtCursor()`/`setModelAtCursor()`, so the
written `config.env` is byte-identical either way (proven by test).
Extensively rewritten `init-form-state.test.ts` (net unchanged test
count — the old Models-view-specific tests replaced by the specs/071
equivalents plus new coverage for the clamp, `cyclePickerProvider`, and
`canOpenRowPicker`); `bun test` 880 pass, typecheck clean. **Live-smoked
in a real PTY at 80×24** (temporarily forcing `initialFormState()` onto
the setup screen, reverted immediately after): the Models section (4
rows — shared + the 3 default-selected LLM agents) rendered clean, no
corruption. **Not verified**: the picker's own interactive pass (a real
`Enter` → provider line → arrow-cycle → pick, with two real registered
provider keys) — the implementing environment has no raw-mode stdin to
drive it; needs Yusuf's terminal, the same standard every guided-init
checkpoint here carries.

See specs/072-init-form-empty-selection-means-no-agents/verification.md for the relocated narrative covering this checkpoint.

See specs/073-configurable-service-ports/verification.md for the relocated narrative covering this checkpoint.
