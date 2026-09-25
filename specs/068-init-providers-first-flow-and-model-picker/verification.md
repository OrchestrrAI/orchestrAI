# Verification — 068 Guided Init: Providers-First Flow and a Real Model Picker

Status: **partial** — every pure-state property is covered by unit tests
and the full suite / typecheck / spec governance pass. The live
real-terminal pass (the reordered flow and the picker interaction at
80×24 and larger) is the one open item, matching every prior guided-init
checkpoint in this codebase (`specs/031`, `048`, `049`, `050`, `063`) —
it needs Yusuf's own terminal.

## What changed

### 1. Providers is step 1

- `apps/supervisor/init-form-state.ts`
  - `initialFormState()` now returns `view: "providers"` (was `"setup"`).
    The `p`-key detour from the setup screen still reaches the same view;
    only the starting point moved.
  - New `canLeaveProvidersStep(state)` — `true` iff the shared `llmApiKey`
    is set (non-whitespace) or any `extraProviders` entry has a
    non-whitespace value.
  - `closeProvidersView(state)` is now **gated**: it advances to
    `view: "setup"` only when `canLeaveProvidersStep()` holds, otherwise
    it returns state unchanged. Esc, Tab-past-the-last-row, and the
    `p`-detour's own Esc all route through this one function, so the gate
    lives in exactly one place.
- `apps/supervisor/init-form.tsx`
  - The Providers keyboard block: `Tab` on the last provider row (no
    shift) calls `closeProvidersView` (gated); Esc unchanged (also
    gated now via the function itself); Ctrl+C still cancels.
  - `ProvidersView` renders a "Step 1 — which LLM providers do you
    have?" subtitle, and, below the rows, either a green
    "Tab past the last row or press Esc to continue…" line
    (`canLeaveProvidersStep` true) or a red
    "Register at least one provider key before continuing." line.
    Footer reworded to "…Tab/Esc continue…".
- The browser form (`specs/049`) and classic wizard are untouched:
  `view` is a UI-only field neither `validate()` nor
  `formStateToWizardConfig()` reads, so `parseSubmission()`'s
  `{ ...base }` carrying `view: "providers"` changes nothing about the
  written config. `initialFormState()`'s new starting view only affects
  the TUI form surface, exactly as the spec's Scope says.

### 2. The Models screen's model row is a real picker

- `apps/supervisor/init-form-state.ts` — new pure functions:
  - `MODEL_PICKER_WINDOW = 5` — visible list window; longer lists page.
  - `modelListForCursor(state)` — the resolved provider's live-fetched
    list for rows 1..N, `[]` for row 0.
  - `canPickModelFromList(state)` — `modelListForCursor().length > 0`.
  - `enterModelSelectMode(state)` — opens the picker, sub-cursor on the
    row's current value if it's in the list, else 0; no-op with no list.
  - `exitModelSelectMode(state)` — closes, row value untouched.
  - `moveModelPickerCursor(state, dir)` — wraps within the list; inert
    while closed.
  - `pickModelFromList(state)` — writes the highlighted id through the
    **exact same `setModelAtCursor()`** a typed id goes through, then
    closes the picker.
  - `modelPickerWindow(total, cursor, windowSize)` — pure paging math,
    cursor kept centred and clamped at both ends.
  - `moveModelCursor()` / `openModelsView()` / `closeModelsView()` now
    also clear `modelPickerOpen` — the picker is a mode of the focused
    row, not a persistent panel.
  - `InitFormState` gained `modelPickerOpen: boolean` and
    `modelPickerCursor: number`.
- `apps/supervisor/init-form.tsx`
  - Models keyboard block: when `modelPickerOpen`, Up/Down move the
    sub-cursor, Enter picks, Esc exits to free-text, Tab exits and moves
    rows. When closed, Enter on a row that `canPickModelFromList()` opens
    the picker; on a row with no list it keeps the specs/063 behavior
    (confirm + next row).
  - The live-discovery `useEffect` gate loosened from
    `state.modelCursor < 2` to `< 1`, so row 1 (the shared model row)
    also fetches and gets a picker.
  - New `ModelPicker` component — renders the paged list as its own
    indented lines directly under the focused row, inside the Models
    view's existing fixed region (no wrapped/unbounded line — the
    specs/047 constraint). Each id is `bounded()` to the width; an
    `n–m of N` counter shows when the list is longer than the window.
  - `discoveryHint()` now takes the resolved provider directly (reused
    for row 1 too) and, once a real list exists, renders
    "N models available — Enter to pick from the list, or type one"
    instead of dumping every id into one truncated line (the exact
    "bad UX" Yusuf reported).
  - The paste handler no longer appends into the model field while the
    picker is open.

### 3. No change to what's written

`pickModelFromList()` calls `setModelAtCursor(state, id)` — the same
function free-text entry already used — so the serialized config is
byte-identical whether a model id was typed or list-picked. Proven by
test (see below).

## Tests (`apps/supervisor/init-form-state.test.ts`, +3 describe blocks)

- **specs/068 — Providers is step 1**
  - `initialFormState().view === "providers"`.
  - `canLeaveProvidersStep`: false with no key / whitespace-only key;
    true with a real shared key; true with an extra-provider key alone;
    false with an empty extra-provider entry.
  - `closeProvidersView` stays on `providers` while the gate is unmet,
    advances to `setup` once a credential exists.
- **specs/068 — the Models screen's model picker**
  - `modelListForCursor` returns `[]` on row 0, the resolved provider's
    list on rows 1 and 2.
  - `canPickModelFromList` false until a list exists.
  - `enterModelSelectMode` no-op with no list; sub-cursor starts at 0 with
    no value, at the current value's index when one is set.
  - `moveModelPickerCursor` wraps; inert while closed.
  - `pickModelFromList` writes the highlighted id and closes.
  - `moveModelCursor` closes an open picker.
  - **byte-identical config**: list-picking `gemini-2.5-pro` (shared row)
    and `gemini-3.0-flash` (a component override row) each produce the
    exact same `formatConfigEnv()` output as `setModelAtCursor()` with
    the same id.
  - an errored fetch leaves `canPickModelFromList` false and
    `enterModelSelectMode` a no-op — free-text still works.
  - `exitModelSelectMode` leaves the row value untouched.
- **specs/068 — modelPickerWindow paging math**
  - a list that fits shows the whole thing;
  - a longer list keeps the cursor centred, clamped at both ends;
  - a sweep over every cursor position confirms the window always
    contains the cursor.

## Suite

- `bun test` — 871 pass, 0 fail (was 871 before; +21 new specs/068 cases
  net of none removed — the pre-existing `closeProvidersView` test at
  line ~587 still passes because its state carries `llmApiKey: "k"`).
- `bun run typecheck` — 0 errors.
- `bun run specs:catalog` + `bun run specs:check` — pass, 68 specs.

## Acceptance criteria

- [x] `orchestrai init` (TUI form) opens on the Providers screen, framed
      as step 1; will not advance to agent selection until at least one
      provider+key is registered — **pure-state proven; live pass
      pending.**
- [x] From a component row whose provider fetched successfully, Up/Down
      moves a visible selection cursor through the real model list
      (paging when long), Enter picks one, written as that component's
      model override — **pure-state + paging math proven; live terminal
      pass pending.**
- [x] A row whose provider fetch failed still shows the error and accepts
      a typed model id — unchanged from `specs/063` (test:
      "a row whose fetch errored has no list").
- [ ] The model list never renders as a wrapped or off-screen line at
      80×24 — **needs the live terminal pass** (mechanism: rendered as
      its own indented lines in the existing fixed region, each id
      `bounded()`, window capped at 5 + a counter line).
- [x] A config produced by list-picking is byte-identical to one
      produced by typing the same id — **proven by test.**
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Known limitations / next step

- The live real-terminal pass (reordered flow + picker at 80×24 and
  larger) is the open item — `verification: partial` reflects exactly
  that, consistent with every prior guided-init checkpoint.
- The browser form's own Providers/Models UI is still the `specs/063`
  acknowledged gap and explicitly out of scope here.
- `specs/069` (the TUI dashboard-parity redesign) remains queued and
  approved; it is best done as its own focused, phase-by-phase session.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/068-init-providers-first-flow-and-model-picker/spec.md`
(implemented, **partial** verification; amends `063`) acts on two things
Yusuf found running `063` live. **(1) Ordering.** The TUI form
(`initialFormState()` in `apps/supervisor/init-form-state.ts`) now opens
on the **Providers** screen as step 1, not the setup screen — you
register the keys you have before choosing agents. Advancing to agent
selection is gated: `canLeaveProvidersStep(state)` requires at least one
credential (the shared `llmApiKey`, or any `extraProviders` entry), and
`closeProvidersView()` — the single function Esc, Tab-past-the-last-row,
and the `p`-detour's Esc all route through — is a no-op until it holds,
with `ProvidersView` showing a red "register at least one" line
meanwhile. The `p`-key detour from setup still reaches the same view;
only the starting point moved. The **browser form and classic wizard
are unaffected** — `view` is a UI-only field neither `validate()` nor
`formStateToWizardConfig()` reads, and the classic wizard already asks
provider/key before services. **(2) The Models screen's model row is a
real picker.** When the focused row's resolved provider has a
successful `discoveredModels` list, Enter opens an arrow-selectable,
paged list (`ModelPicker` in `apps/supervisor/init-form.tsx`, window of
`MODEL_PICKER_WINDOW = 5` + an `n–m of N` counter, rendered as its own
indented lines inside the Models view's existing fixed region — no
wrapped or off-screen line, the `specs/047` constraint); Up/Down move a
sub-cursor, Enter picks, Esc drops back to free-text. Row 1 (the shared
model row) gets this too — the live-discovery `useEffect` gate loosened
from `modelCursor < 2` to `< 1`. **Free-text entry is never removed** —
it stays the fallback for a failed/timed-out fetch and for an id the
list doesn't contain, and `discoveryHint()` now advertises the picker
("N models available — Enter to pick from the list, or type one")
instead of dumping every id into one truncated line (the "bad UX" Yusuf
reported). **What's written is unchanged**: `pickModelFromList()` calls
the exact same `setModelAtCursor()` a typed id goes through, so a
list-picked config is byte-identical to a typed one (proven by test).
`InitFormState` gained `modelPickerOpen`/`modelPickerCursor`; +21 new
pure-state tests (the Providers-first gate, the picker
enter/move/pick/exit lifecycle, the byte-identical round-trip, and the
`modelPickerWindow()` paging math), all 871 suite tests pass, typecheck
clean. **Not verified**: the live real-terminal pass for the reordered
flow and the picker at 80×24 and larger — the one open item, the same
standard every guided-init checkpoint here carries.
