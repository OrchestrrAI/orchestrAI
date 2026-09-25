---
id: 132-init-multi-provider-keys
title: Guided Init Keeps Every Registered Provider Key and Lets Any Row, Including the Default, Use Any of Them
area: supervisor
change_type: fix
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 063-init-per-component-provider-and-key
  - 070-init-agent-implies-llm-and-model-first-setup
  - 071-models-view-inline-provider-in-picker
supersedes: []
superseded_by: []
related:
  - 068-init-providers-first-flow-and-model-picker
  - 039-per-component-llm-provider-config
---

# Spec: Guided Init Keeps Every Registered Provider Key and Lets Any Row, Including the Default, Use Any of Them

> Status: **APPROVED by Muhamad-Yussuf on 2026-09-25** ("ok approved go on"). IMPLEMENTED and VERIFIED in a real terminal the same day.

## Purpose

Reported live by Muhamad-Yussuf: with three provider keys (Anthropic,
OpenAI, Gemini), `orchestrai init` only ever offered one provider's
models, and only one key ended up in the saved config.
(`C:\Users\moham\devops-mcp-server\.orchestrai\config.env` holds a single
`ORCHESTRAI_LLM_*` triple.) The goal is to register several providers
and choose between them freely.

## Verified Current State

1. **Unused keys are dropped on save.** `formStateToWizardConfig()`
   (`apps/supervisor/init-form-state.ts` ~782–787) writes a non-primary
   provider's key only as a component override
   (`ORCHESTRAI_<COMPONENT>_LLM_API_KEY`), and only when some component
   row is switched to that provider. A registered but unused provider
   writes nothing, and on reopen the form can't recover it.
2. **The default row is locked to the first registered provider.**
   `registerProviderKey()` makes the first registration the primary.
   `cycleProviderOverrideAtCursor()` is a documented no-op on the
   "shared / default" row, so that row's model picker only ever lists
   the primary provider's models. Switching a provider works only on a
   component row (←/→), and no hint on screen says so.
3. **Model-list errors hide the cause.** `apps/supervisor/model-discovery.ts`
   reports only `"<Provider> API returned <status>"`. For the reported
   Anthropic key, the provider's real message was: *"This API key is not
   scoped to a workspace, so this request must include the
   anthropic-workspace-id header…"*. The same key fails a real
   `/v1/messages` call too, so it can't work at runtime either. That is
   a key problem, but the form made it undiagnosable.

## Proposed Behavior

1. **Every registered key is saved and restored.**
   - Each registered provider's key is written as
     `ORCHESTRAI_<PROVIDER>_API_KEY` (`ANTHROPIC`, `OPENAI`, `GEMINI`),
     whether or not a row uses it. These become `WIZARD_OWNED_KEYS`.
   - On reopen they seed the Providers screen again.
   - The primary triple `ORCHESTRAI_LLM_PROVIDER/_MODEL/_API_KEY` and the
     per-component override lines are written exactly as today, so
     runtime resolution (specs/039) is unchanged.
2. **The default row can switch provider.**
   - On "shared / default", ←/→ cycles the primary provider among the
     registered ones. Keys never move between providers; only which one
     is primary changes.
   - The row's model is cleared when its provider changes (a Gemini model
     id is meaningless for OpenAI), and that provider's model list
     loads.
3. **Provider is visible and discoverable.**
   - Every Models row shows the provider it resolves to, e.g.
     `openai · gpt-5` or `(shared → gemini)`.
   - When two or more providers are registered, the section hint reads
     "←/→ switch provider".
4. **Real errors.** Model-discovery failures append the provider's own
   error message (truncated, and never containing the key), e.g.
   `Anthropic API returned 400 — This API key is not scoped to a
   workspace…`.

## Safety and Compatibility Constraints

- Keys stay in the same gitignored plaintext file as today (the existing
  CLAUDE.md "Guided init" decision). No key is ever printed or echoed.
- The specs/039 rule is unchanged: a component uses only its own
  override or the shared credentials. The new per-provider variables are
  read by init only, not by the runtime model factory.
- A config written before this spec still loads and saves correctly: the
  primary and override lines are unchanged. The first save adds the
  per-provider lines for any provider it can recover.

## Non-Goals

- Supporting Anthropic keys that aren't scoped to a workspace (the
  `anthropic-workspace-id` header). The fix for the reported key is to
  create a key inside a workspace in the Anthropic Console.
- The browser form and the classic wizard (the browser form's missing
  per-component picker is already a named gap).

## Acceptance Criteria

- [x] Explicit approval recorded before implementation.
- [x] Registering three providers and saving writes all three
  `ORCHESTRAI_<PROVIDER>_API_KEY` lines; reopening shows all three
  registered.
- [x] ←/→ on "shared / default" switches the primary among registered
  providers, clears the model, and loads the new provider's list.
- [x] Every Models row shows its resolved provider; the ←/→ hint appears
  only with 2+ providers.
- [x] A failing model list shows the provider's message, never the key.
- [x] Pure-state unit tests for each rule above; `bun run typecheck` 0
  errors; `bun test` no regressions.
- [x] Real terminal: Gemini + OpenAI registered, OpenAI chosen as the
  default and Gemini on one agent, saved, and reopened.
