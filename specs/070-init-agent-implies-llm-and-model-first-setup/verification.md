# Verification — 070 Guided Init: Agent Selection Implies LLM, Model-First Setup Screen

Status: **pending** — every pure-state property is unit-tested and the
full suite / typecheck / spec governance pass. The TUI form's setup
screen is a raw-mode-keyboard surface, and the implementing environment
has no raw-mode stdin (`orchestrai init` there only ever reaches the
classic prompt wizard, `useClassic = !process.stdin.isTTY`), so the
live render + the setup-screen model picker + the live Gemini fetch are
Yusuf's — the same gate every guided-init checkpoint here carries.

## What changed

### 1. Agent selection IS the LLM decision

- `apps/supervisor/init-form-state.ts`
  - `InitFormState.agentLlm` **removed**. `toggleAgentLlm` and
    `seedAgentLlm` removed. `FormFieldId` is now just
    `"targetPath" | "agents" | "llmModel"`.
  - `formStateToWizardConfig()` derives the harness lines:
    `agentLlm[field] = true` for every field in `agentLlmFieldsFor(state)`
    (the selected agents' harness fields, "all" when the selection is
    empty). A deselected agent's field is never in that list, so
    `formatConfigEnv()` writes **no line** for it — deliberately
    reversing `specs/050`'s "all-off writes `=0`".
  - `visibleFields()` is now static (`SETUP_FIELDS`).
- `apps/supervisor/init-form.tsx`
  - The `ToggleRow` component, its render block, and the
    `AGENT_LLM_HARNESSES.some(h => h.field === state.focus)` keyboard
    branch are removed. `ReviewLine` lists the selected harness agents
    (derived, no `agentLlm` read).
- `apps/supervisor/init-web.ts`
  - The "Per-agent LLM harness" card, its client-JS collection, and
    `parseSubmission`'s `agentLlm` handling are removed — item 1 applied
    consistently to the browser surface (a deletion of what `specs/050`
    added). The Provider / Model / API-key card there is untouched.

### 2. The setup screen's LLM block is model selection only

- The Provider `FieldRow` and API-key `FieldRow` are **removed** from
  the setup screen. `PROVIDER_FIELDS` is gone; `SETUP_FIELDS` ends at
  `"llmModel"`. The setup-screen `cycleProvider` / `onRequestApiKey`
  keyboard paths and the `onRequestApiKey` prop are removed (the
  Providers screen keeps its own `registerProviderKey` + masked reader).
- The Model row is now the `specs/068` picker:
  - The live-discovery `useEffect` gate changed from
    `state.view !== "models" || state.modelCursor < 1` to: fetch for
    `resolvedProviderAtCursor(state)` on the Models view (row ≥ 1) **or**
    for `state.llmProvider` when `state.view === "setup"`.
  - `initialFormState()` sets `modelCursor: 1` and `closeModelsView()`
    resets it to `1`, so the setup Model row = the shared-model row
    (Models-view row 1) and the `specs/068` picker helpers
    (`canPickModelFromList` / `enterModelSelectMode` /
    `moveModelPickerCursor` / `pickModelFromList`, all keyed on
    `modelCursor`) operate on `state.llmModel` directly.
  - Render: a `Model (<provider>)` `FieldRow` plus, when focused, either
    `<ModelPicker>` (picker open) or `setupModelHint()` (loading / error
    / "N models — Enter to pick" / "register the key on Providers (p)").
  - Free-text stays the fallback (backspace / printable still edit
    `llmModel`; Enter opens the picker only when a list exists).

### 3a. First registration becomes the primary (§3, follow-up fix)

Yusuf, live on the Providers screen: *"why have this shared default
beside anthropic?"* — the "(shared default)" tag was pinned to
`state.llmProvider`, which just defaults to `"anthropic"` (a leftover
from `specs/063`'s setup-screen provider row, removed by `070`). Worse,
`registerProviderKey` still keyed off that stale default, so registering
only a Gemini key wrote `ORCHESTRAI_LLM_PROVIDER=anthropic` with **no
key at all**. `specs/070` §3 already specifies the fix ("the first
provider registered on the Providers screen" is the primary); the
implementation now does it:

- `registerProviderKey(state, key)`: when `state.llmApiKey` is empty, the
  focused provider becomes the primary (`llmProvider` + `llmApiKey`);
  once a primary key exists, further registrations land in
  `extraProviders`.
- `unregisterProviderKey(state)` on the primary: promotes the first
  registered extra (in `LLM_PROVIDERS` order) to primary; if none, clears
  the primary key and the Providers-step gate re-engages.
- `ProvidersView` label: `(default for agents)` shows **only** on the
  provider that is actually the primary AND registered AND when 2+
  providers have keys. Before anything is registered, all three rows just
  read `(not registered)` — no special anthropic. Live-smoked in a PTY.

### 3. `keyForProvider()` is loss-proof

`keyForProvider(state, provider)` now returns
`state.extraProviders[provider] ?? (provider === llmProvider ? llmApiKey : "")`
when the `provider === llmProvider && llmApiKey` fast path is empty — a
key registered into `extraProviders[X]` (while X was not yet primary)
is still found after X becomes primary.

### 4. No change to what's written

`.orchestrai/config.env` keeps the `specs/063`/`068` shape. The only
serialized difference from `specs/050` is item 1's "deselected agent →
no harness line" (was `=0`); absent already means off everywhere that
reads it.

## Tests (`apps/supervisor/init-form-state.test.ts`, rewritten sections)

- **specs/070 — visibleFields**: always `["targetPath", "agents",
  "llmModel"]`, any agent selection.
- **moveFocus**: wraps through the three setup fields; unknown focus →
  first field.
- **specs/070 — agent selection IS the LLM decision**: every selected
  harness agent → `=1`; deselected → no line (verified against
  `formatConfigEnv()` output); testing-agent contributes nothing;
  empty selection = "all" → all three `=1`; a pre-070 config's own
  `ORCHESTRAI_<AGENT>_LLM_HARNESS` values are not re-read.
- **one config contract**: `classicConfig` reconstruction updated to
  all-yes (`=true`); the "all selected" and "1,3" parity tests pass; the
  old "all-off writes `=0`" test replaced with "every agent selected
  writes every harness `=1`".
- **keyForProvider**: existing suite still green with the fallback; the
  Providers-screen registration tests unchanged.
- **fieldScrollOffset**: rewritten for the one-row middle section
  (`llmModel` at `2 + agentCount + 1`).
- `apps/supervisor/init-web.test.ts`: the config-contract parity test's
  `classicEquivalent.agentLlm` updated to `{ devopsLlm: true,
  securityLlm: true }` (derived-from-selection behavior).

## Suite

- `bun test` — 869 pass, 0 fail (was 880; net −11 from removing the
  `specs/050` per-agent-gate / `visibleFields` / `fieldScrollOffset`
  test blocks and adding the `specs/070` replacements).
- `bun run typecheck` — 0 errors (JSX included).
- `bun run specs:catalog` + `bun run specs:check` — pass, 69 specs.
- `bun run build` — **not re-run to completion**: `dist/bin/orchestrai.exe`
  was locked (EPERM) by a running stack. Bundle step succeeded (1350
  modules); needs a rebuild once the binary is free. Gitignored, so no
  commit impact.

## Live pass still owed (Yusuf's terminal)

1. `orchestrai init` in a real raw-mode terminal opens on Providers,
   register a real Gemini key, Tab/Esc to advance.
2. The setup screen shows **Target → Agents → Model** only — no toggles,
   no Provider row, no API-key row; the Agents rows note that a selected
   agent runs its LLM path.
3. Land on the Model row → the list populates from the live Gemini fetch
   (no more "didn't retrieve the models"); Enter opens the arrow-picker;
   pick one → the "A model is required for gemini" error clears; `^S`
   proceeds. A deliberately bad key → the row shows the error and still
   accepts a typed id.
4. Confirm the written `.orchestrai/config.env`:
   `ORCHESTRAI_<AGENT>_LLM_HARNESS=1` for each selected harness agent,
   no line for deselected ones, `ORCHESTRAI_LLM_MODEL` = the picked id.

## Disclosed mistake

While smoke-testing, `orchestrai init` was run twice from the repo root
with a non-TTY stdin; both times it fell to the classic wizard (correct)
and wrote a keyless `.orchestrai/config.env` into the **repo root**
(`process.cwd()`), not the `--project` dir. The files were freshly
created (no prior repo-root `.orchestrai/` — the real keyed config lives
at `C:\Users\moham\test-target-project\.orchestrai\config.env`, untouched)
and were deleted afterward. `.orchestrai/` is gitignored, so no commit
impact; recorded here per the repo's "disclose live-verification
mistakes" convention.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**Superseded for the TUI form + browser form by
`specs/070-init-agent-implies-llm-and-model-first-setup/spec.md`
(implemented, `verification: pending`; amends `050`/`068`/`063`),
2026-09-10.** Yusuf's call after running `068`: "if I chose an agent that
means it will be LLM" — the per-agent LLM on/off toggle rows are gone
from **both** the TUI form and the browser form. `InitFormState.agentLlm`
is deleted; `formStateToWizardConfig()` derives the harness lines from
the selection instead — every selected agent that has a harness writes
`ORCHESTRAI_<AGENT>_LLM_HARNESS=1`, a **deselected agent writes no line
at all** (deliberately reversing `050`'s "all-off writes `=0`"; absent
already means off everywhere it's read). `AGENT_LLM_HARNESSES` /
`AgentLlmField` stay — the serializer still needs the agent→var mapping.
**The classic prompt wizard is untouched** — it still asks y/n per
agent. Also from `070`: the TUI setup screen loses its **Provider** and
**API-key** rows entirely (`visibleFields()` → `["targetPath", "agents",
"llmModel"]`) — provider + key are registered on the `068` Providers
step now, and the setup screen's Model row became the `068` live picker
(the discovery `useEffect` also runs for `view: "setup"` against
`state.llmProvider`; `initialFormState()` pins `modelCursor: 1` so the
row IS the shared-model row and the picker helpers operate on
`llmModel`). `keyForProvider()` gained a loss-proof fallback
(`extraProviders[provider]` when the primary `llmApiKey` slot is empty)
so a key registered before its provider became primary is never
stranded. Written `config.env` shape is otherwise unchanged. The
browser form's own Provider/Model/API-key card is untouched — its
providers/models picker rework is still the deferred `063`/`068` gap.
Pure-state tested (`bun test` 869 pass, `typecheck` clean); the TUI
form's setup-screen render + the live Gemini fetch there need a real
raw-mode terminal — `verification: pending`.

See specs/077-agent-enabled-means-llm-on-by-default/verification.md for the relocated narrative covering this checkpoint.
