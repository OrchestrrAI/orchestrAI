---
id: 095-init-models-section-orchestrator-conversation-rows
title: "Guided Init's Models Section Gains orchestrator and conversation Rows"
area: supervisor
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-15
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-15
implemented_on: 2026-09-15
amends:
  - 071-models-view-inline-provider-in-picker
related:
  - 044-conversational-ask-layer
  - 063-init-per-component-provider-and-key
supersedes: []
superseded_by: []
---

# Spec: Guided Init's Models Section Gains orchestrator and conversation Rows

> Review gate: **APPROVED 2026-09-15 by Yusuf — both `orchestrator` and
> `conversation` rows (not just `conversation`).**
>
> Raised directly by Yusuf, 2026-09-15,
> immediately after a real, hours-long root-cause hunt: `ORCHESTRAI_
> CONVERSATION_LLM_MODEL` was hand-set to a text-to-speech-only model
> (`gemini-2.5-flash-preview-tts`), which structurally cannot answer a
> text request — every chat answer-synthesis call had been silently
> failing and falling back to raw deterministic dumps the entire session,
> with zero setup-time visibility into why, because `init` has never
> offered any way to see or set this value at all. His own words: *"let
> me the option to set it in the init."*

## Purpose

`specs/071` deliberately excluded `orchestrator` and `conversation` from
guided init's own Models section — both components fall back to the
shared model like any unset override, and Yusuf's own reasoning at the
time (*"why do I need a separate LLM for the chat?"*) treated overriding
either as a rare, hand-edit-only case. That reasoning is still sound for
the common path (leave both unset, both correctly track the shared
model, as confirmed directly from `readLlmModelConfig()`'s own per-field
fallback). What's changed is the discovered cost of the *uncommon* path:
a hand-edited override that happens to be wrong is now confirmed to be
**invisible** anywhere in setup — not shown, not validated, not
flagged — and silently breaks a real, user-facing capability (every
synthesized chat answer) with no error, no warning, just a permanent,
quiet fallback to raw output. Yusuf's own request settles this in favor
of visibility: every real LLM-consuming component should be reachable
from the same guided setup, none left as a silent-failure-only,
hand-edit-only fallback.

## Verified Current State

- `apps/supervisor/init-form-state.ts`'s `modelsRows()`:
  `["shared", ...agentLlmFieldsFor(state).map(...)]` — never includes
  `"orchestrator"` or `"conversation"`, confirmed directly, not assumed.
- **Every downstream mechanism a Models row needs is already fully
  generic over any `LlmComponent`**, confirmed by reading each one
  directly, not assumed: `rowComponentAtCursor()`, `setModelAtCursor()`/
  `modelAtCursor()`, `resolvedProviderAtCursor()`,
  `cyclePickerProvider()`/`cycleProviderOverrideAtCursor()`, and
  `formStateToWizardConfig()`'s own `modelOverrides` loop (`for (const
  component of LLM_COMPONENTS)`, all 8, unconditionally) — none of them
  special-case "agent components only." The only place `orchestrator`/
  `conversation` are actually excluded is `modelsRows()`'s own row list
  and `ModelsSection`'s `labelFor()` fallback (which already renders a
  readable label — the raw component name — for a component absent from
  `AGENT_LLM_HARNESSES`, confirmed by reading it directly).
- The browser form (`init-web.ts`) has never had a real per-component
  picker of any kind (`modelOverrides: {}` submitted unconditionally) —
  a separate, pre-existing, already-documented gap (`specs/063`'s own
  record), not something this spec touches.
- The classic wizard (`init-wizard.ts`) deliberately never asks for *any*
  per-component model override, agent or otherwise — `specs/050`'s own
  explicit Non-Goal, confirmed directly in the prompt flow's own code
  comment. Also out of scope here; that boundary is unrelated to this
  spec's own concern and stays exactly as-is.
- **Live-reproduced, 2026-09-15**: `ORCHESTRAI_CONVERSATION_LLM_MODEL=
  gemini-2.5-flash-preview-tts` in a real `.orchestrai/config.env`,
  confirmed directly against the real Gemini API to reject every text
  request (`400 INVALID_ARGUMENT`, "accepts the following combination of
  response modalities: AUDIO"). Every real chat answer in the session
  fell back to the raw deterministic dump as a result, confirmed by
  inspecting real conversation turns via `GET /conversations/:id` — not
  one synthesized sentence present anywhere.

## Proposed Behavior

`modelsRows()` gains two more fixed rows, `"orchestrator"` and
`"conversation"`, always present regardless of `selectedAgents` (unlike
the per-agent rows, these two components are always potentially relevant
— `orchestrator` drives every `plan-task`, `conversation` drives every
`/ask` answer synthesis, neither depends on which work-agents happen to
be selected). Placement: immediately after `"shared"`, before the
per-agent rows — these are the two "always-on" components, not tied to
an agent selection.

No other function changes — every mechanism the new rows need already
works, confirmed above; this is a single-function change plus its own
test coverage and `ModelsSection`'s doc-comment correction.

## Scope

- `apps/supervisor/init-form-state.ts`: `modelsRows()`'s own row list;
  its doc comment (currently states the opposite of the new behavior).
- `apps/supervisor/init-form.tsx`: `ModelsSection`'s own doc comment
  (same correction); no functional change expected, confirmed by the
  "already fully generic" findings above — verified, not assumed, once
  implemented.
- Tests: `init-form-state.test.ts` — `modelsRows()` includes both new
  rows regardless of `selectedAgents` (including the empty-selection
  case); setting/reading a model or provider override on either new row
  works identically to an agent row; `formStateToWizardConfig()` writes
  `ORCHESTRAI_ORCHESTRATOR_LLM_MODEL`/`ORCHESTRAI_CONVERSATION_LLM_MODEL`
  when either is set, writes neither when both are empty (byte-identical
  to today for the common, untouched case).
- **Out of scope**: the browser form's own separate, pre-existing gap
  (no per-component picker of any kind); the classic wizard's own
  deliberate `specs/050` Non-Goal (no per-component prompts at all,
  agent or otherwise) — neither touched by this spec.

## Safety and Compatibility Constraints

- **Strictly additive** — every existing Models-section behavior for
  `"shared"` and the per-agent rows is unchanged; this adds two more
  rows, using mechanisms already proven generic, not new ones.
- **No change to runtime resolution** — `readLlmModelConfig()`'s own
  per-field fallback (`specs/039`) is completely untouched; this only
  makes an already-supported override reachable from guided setup.
- **A config with neither override set writes byte-identically to
  today** — confirmed by a dedicated test, not just inspection.

## Out of Scope / Non-Goals

- The browser form's own missing per-component picker — a separate,
  already-documented gap, not attempted here.
- Any change to the classic wizard's own prompt flow.
- Any startup-time validation of a configured model name (e.g. detecting
  a TTS-only model and warning) — a real, separately-valuable idea, but
  a materially different mechanism (startup-time checking vs. setup-time
  visibility) from what this spec adds; not attempted here.

## Acceptance Criteria

- [x] `modelsRows()` includes `"orchestrator"` and `"conversation"`
      alongside `"shared"`, regardless of `selectedAgents` (including an
      empty selection).
- [x] Setting a model/provider override on either new row round-trips
      identically to an agent row (readable back, written correctly).
- [x] `formStateToWizardConfig()` writes the correct
      `ORCHESTRAI_ORCHESTRATOR_LLM_MODEL`/`ORCHESTRAI_CONVERSATION_LLM_
      MODEL` line only when actually set; a config with neither set is
      byte-identical to before this spec.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] Every pre-existing Models-section test passes (updated for the new
      row ordering where devops shifted from index 1 to index 3 — the
      expected consequence of two new rows being inserted before it, not
      a regression; see verification.md for the full list of updated
      call sites).

## Verification Plan

- Unit: the criteria above, plus the existing full `init-form-state.test.ts`
  suite passing unmodified.
- A live, real-terminal keystroke-driven pass remains the standing open
  item every guided-init checkpoint in this codebase carries (no raw-mode
  stdin in this sandbox) — not a new gap this spec introduces.

## Approval Requested

Not yet requested — presented for review.
