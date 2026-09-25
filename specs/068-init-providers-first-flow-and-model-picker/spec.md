---
id: 068-init-providers-first-flow-and-model-picker
title: Guided Init — Providers-First Flow and a Real Model Picker
area: supervisor
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-10
updated: 2026-09-10
approved_by: Yusuf
approved_on: 2026-09-10
implemented_on: 2026-09-10
amends:
  - 063-init-per-component-provider-and-key
related:
  - 048-guided-init-experience
  - 050-init-per-agent-llm-toggles
  - 031-interactive-init-wizard
supersedes: []
superseded_by: []
---

# Spec: Guided Init — Providers-First Flow and a Real Model Picker

> Review gate: **APPROVED 2026-09-10 by Yusuf.**
> Written from Yusuf's own feedback after live-testing `specs/063`,
> 2026-09-10: "the first screen should ask the user for the LLM
> providers he has and keys, then start with choosing agents", and
> separately, of the `specs/063` Models screen: "it got the models, but
> it's a bad experience as UI/UX" — the live-fetched model list renders
> as a single truncated hint line that runs off the right edge, with no
> way to arrow through and select an entry.

## Purpose

`specs/063` added a Providers screen (register credentials) and made
the Models screen's model rows live-fetch each provider's real
available models. Two things Yusuf found wrong once he ran it:

1. **Ordering.** The Providers screen is a `p`-key side view reachable
   from the setup screen. But you can't meaningfully assign a
   per-agent provider on the Models screen without first having
   registered it — so credential registration should be **step 1**, up
   front, before the agent selection, not an optional detour.
2. **The model list isn't a picker.** `specs/063`'s own verification.md
   flagged this as the deferred bit: the fetched models render via
   `discoveryHint()` as one green line, `bounded()` to the terminal
   width, so anything past ~120 chars is `…`-truncated and invisible.
   The footer still says "type to set". There is no arrow-selectable
   list.

## Verified Current State

Read 2026-09-10:

- `apps/supervisor/init-form-state.ts`: `view: "setup" | "models" |
  "providers"`. `initialFormState()` sets `view: "setup"` and
  `focus: "targetPath"`. There is no notion of "which step of a
  sequence am I on" — the classic wizard's own step order lives in
  `runInitWizardInner()`'s prompt sequence, the form's is implicit in
  `visibleFields()` + the `p`/`m` keybindings.
- `apps/supervisor/init-form.tsx`: `ProvidersView` renders one row per
  `LLM_PROVIDERS` entry; `ModelsView`'s `discoveryHint()` renders the
  fetched-model list as a single `<text>` line. `state.discoveredModels[
  provider]` already holds the full `{id}[]` — the data for a real
  picker is already there, only the rendering and a selection cursor
  are missing.
- The `p` keybinding (open Providers) and `m` (open Models) are
  guarded so they don't fire while a text field has focus.

## Proposed Behavior

### 1. Providers is step 1, always shown

- `initialFormState()` starts on `view: "providers"` (not `"setup"`),
  with a short one-line header framing it as "Step 1 — which LLM
  providers do you have?".
- From the Providers screen, a forward action (e.g. Enter on a "done /
  continue" affordance, or Tab past the last provider row) advances to
  `view: "setup"` — **only if at least one credential is registered**
  (the shared `llmApiKey`, or an entry in `extraProviders`); otherwise
  an inline "register at least one provider to continue" message, the
  same validation-at-the-right-moment pattern the rest of the form
  uses.
- The setup screen keeps a way back (`p` still opens Providers; Esc
  from Providers when it's step 1 goes to setup rather than cancelling,
  matching how Esc already behaves as "back" not "cancel" inside these
  sub-views).
- The classic wizard's own prompt order is untouched — it already asks
  provider/key before services; this only reorders the *form*.

### 2. The Models screen's model row becomes a real picker

- When a component row is focused and its resolved provider has a
  successful `discoveredModels` list, the row enters a **selection
  mode**: a bounded, scrollable list of the real model ids (rendered
  as its own lines below the row, inside the existing fixed-height
  region — never a wrapped line that breaks the row budget, the exact
  `specs/047` layout constraint), with a sub-cursor. Up/Down moves the
  sub-cursor through the list (paging when it's longer than the visible
  window); Enter picks the highlighted id and writes it as that row's
  model override; Esc leaves selection mode without changing anything.
- **Free-text stays as the fallback**, unchanged, for: a provider whose
  fetch failed or timed out (`discoveryHint()` already shows the error
  there), and for a user who wants to type a model id the list doesn't
  contain (a preview model, a fine-tune). A visible affordance toggles
  between "pick from list" and "type it in" for a row that has a list.
- The shared-model row (row 1) gets the same treatment for the shared
  provider.

### 3. No change to what's written

`.orchestrai/config.env`'s shape is exactly as `specs/063` left it —
this spec only changes how the form is navigated and how a model id is
chosen, never the serialized output. A config produced by picking
`gemini-2.5-flash` from the list is byte-identical to one produced by
typing it.

## Scope

- `apps/supervisor/init-form-state.ts`: a step/`view` starting at
  `"providers"`; a "can I leave the Providers step" check; a
  model-list sub-cursor and its pure move/select/cancel functions;
  a per-row "list vs free-text" mode flag.
- `apps/supervisor/init-form.tsx`: the Providers screen's "continue"
  affordance and its gate; the Models screen's selection-mode list
  rendering (bounded, paged, inside the existing fixed region) and its
  keyboard handling.
- The browser form (`specs/049`) and classic wizard: unaffected —
  neither has the form's view/step model, and the classic wizard
  already asks provider/key first. `initialFormState()`'s new starting
  view only applies to the TUI form surface.
- No change to `model-discovery.ts`, `init-wizard.ts`'s serializer, or
  anything `specs/063` didn't already touch for the write path.

## Safety and Compatibility Constraints

- **No new row-budget risk.** The model-selection list renders inside
  the Models view's existing fixed-height area, paged, never a wrapped
  or unbounded line — the same constraint `specs/047` Phase 2 and every
  `specs/012` round already enforce in this file.
- **Free-text entry is never removed** — it's the fallback for a failed
  fetch and for models not in the list, exactly as `specs/063` relies
  on it.
- **Byte-identical written config** for the same choices, list-picked
  or typed.
- The Providers-first gate blocks *advancing*, never *saving a
  partially-filled form in a broken state* — it's the same
  "can't proceed without X" the target-path check already is.

## Out of Scope / Non-Goals

- The browser form's own Providers/Models UI (still the `specs/063`
  acknowledged gap — a separate follow-up).
- Multi-key-per-provider, or any change to the closed 3-provider set.
- Showing model metadata (context window, pricing) in the picker —
  id/display only, same as `specs/063`.
- Any change to the classic prompt wizard's flow.

## Acceptance Criteria

- [ ] `orchestrai init` (TUI form) opens on the Providers screen, framed
      as step 1; it will not advance to agent selection until at least
      one provider+key is registered.
- [ ] From a component row on the Models screen whose provider fetched
      successfully, Up/Down moves a visible selection cursor through the
      real model list (paging when long), Enter picks one, and it's
      written as that component's model override — confirmed live in a
      real terminal.
- [ ] A row whose provider fetch failed still shows the error and
      accepts a typed model id — unchanged from `specs/063`.
- [ ] The model list never renders as a wrapped or off-screen line —
      confirmed at the 80×24 minimum.
- [ ] A config produced by list-picking is byte-identical to one
      produced by typing the same id — proven by test.
- [ ] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [ ] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Pure unit tests: the "can leave Providers step" gate; the model-list
  sub-cursor move/page/select/cancel; the list-vs-free-text mode flag;
  a list-pick vs typed round-trip producing identical `formatConfigEnv()`
  output.
- A live real-terminal pass for the reordered flow and the picker
  interaction at 80×24 and larger — the standard every guided-init
  checkpoint in this codebase carries.

## Approval Requested

**Approved 2026-09-10 by Yusuf.** Implementation proceeds (069 phase by phase).

