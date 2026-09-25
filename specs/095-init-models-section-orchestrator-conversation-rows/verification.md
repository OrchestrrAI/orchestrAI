# Verification: specs/095 — Guided Init's Models Section Gains orchestrator and conversation Rows

## What changed

- `apps/supervisor/init-form-state.ts`'s `modelsRows()` now returns
  `["shared", "orchestrator", "conversation", ...agentComponents]` —
  the two new rows are always present, immediately after `"shared"`,
  regardless of `selectedAgents` (including an empty selection).
- `apps/supervisor/init-form.tsx`'s `ModelsSection` doc comment updated
  to describe the new behavior (previously claimed the opposite).
- No other function changed — every downstream mechanism
  (`rowComponentAtCursor()`, `setModelAtCursor()`/`modelAtCursor()`,
  `resolvedProviderAtCursor()`, `cyclePickerProvider()`,
  `formStateToWizardConfig()`'s `modelOverrides` loop over all
  `LLM_COMPONENTS`) was already fully generic over any `LlmComponent`,
  confirmed by reading each directly before implementing.

## Acceptance criteria

- [x] `modelsRows()` includes `"orchestrator"` and `"conversation"`
      alongside `"shared"`, regardless of `selectedAgents` (including an
      empty selection). Confirmed by test: `modelsRows(state({selectedAgents: []}))`
      equals `["shared", "orchestrator", "conversation"]`; the full-selection
      case equals `["shared", "orchestrator", "conversation", "devops",
      "documentation", "security", "testing", "codeReview", "coder"]`.
- [x] Setting a model/provider override on either new row round-trips
      identically to an agent row — both rows go through the exact same
      `setModelAtCursor()`/`setProviderOverrideAtCursor()`/
      `cyclePickerProvider()` functions every agent row already uses; no
      row-type branch exists anywhere in those functions.
- [x] `formStateToWizardConfig()` writes the correct
      `ORCHESTRAI_ORCHESTRATOR_LLM_MODEL`/`ORCHESTRAI_CONVERSATION_LLM_MODEL`
      line only when actually set — it already iterates `LLM_COMPONENTS`
      (all 8) unconditionally, so both components were already wired;
      this spec only made them reachable as rows in the UI. A config with
      neither override set writes byte-identically to before this spec
      (no code path in `formatConfigEnv()`/`formStateToWizardConfig()`
      changed).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] Every pre-existing Models-section test passes unmodified in
      *intent* — several needed updating for the new row ordering
      (devops shifted from index 1 to index 3 under the default full
      selection), which is the expected, correct consequence of two new
      rows being inserted before it, not a regression. No test's
      assertion about *behavior* changed, only the index/row-count
      literals the new ordering shifted.

## Test results

- `bun test apps/supervisor/init-form-state.test.ts`: 123 pass, 0 fail,
  326 expect() calls.
- `bun test` (full suite): 1101 pass, 0 fail, 2635 expect() calls,
  across 73 files.
- `bun run typecheck`: clean, 0 errors.
- `bun run specs:catalog`: generated catalogs for 94 specs.
- `bun run specs:check`: passed for 94 specs.

## What changed in the test file

`apps/supervisor/init-form-state.test.ts` had numerous tests written
against the pre-095 row ordering, where index 1 was the first agent row
(`devops`). Under the new ordering (`shared=0, orchestrator=1,
conversation=2, devops=3, ...`), these were fixed:

- Expected-array literals in `modelsRows()`-assertion tests updated to
  include the two new rows.
- `modelsCursor: 1` → `modelsCursor: 3` at every call site using the
  full default agent selection (13 occurrences).
- `modelsRows(s)[1]` → `modelsRows(s)[3]`, `withList(1)` → `withList(3)`
  where an index into the rows array was used directly.
- The specs/072 "explicitly empty selection" test now expects
  `["shared", "orchestrator", "conversation"]` instead of `["shared"]`.
- The specs/071 "deselecting an agent clamps a stranded modelsCursor"
  test: the out-of-range cursor probe value was raised from `7` to `99`
  (the old value was calibrated to the smaller pre-095 row count and was
  no longer clearly past the new, larger range), and its expected rows
  array updated to include the two new rows.
- Stale inline comments referencing "row 1 = first agent row" corrected
  throughout to note the specs/095 shift.

None of these changes altered what property each test verifies — only
the literal index/array values the new row ordering shifted.

## Live verification

Not performed this session — no raw-mode stdin available in this
sandbox, the same standing gap every guided-init checkpoint in this
codebase carries (see specs/068/069/070/071/072/073's own verification
records). The mechanism itself (a single generic row list, every
downstream function already proven component-agnostic) leaves little
surface for a live pass to catch that unit tests wouldn't — the same
reasoning specs/071's own live-smoke note made — but a genuine
keystroke-driven pass (open the Models section, cycle to the
`orchestrator`/`conversation` rows, open the picker, assign a model)
remains the standing open item for whenever a real terminal is
available.

## Known limitations

- Browser form (`init-web.ts`) and classic wizard (`init-wizard.ts`)
  are unaffected by design — both out of scope per the spec's own
  Non-Goals.
- No startup-time validation of a configured model name (e.g. detecting
  a TTS-only model) — explicitly out of scope per the spec.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**Correction, 2026-09-15 — `orchestrator`/`conversation` rows added
back. `specs/095-init-models-section-orchestrator-conversation-rows/
spec.md` (implemented, `verification: partial`; amends `071`).**
Deliberately excluded above ("why do I need a separate LLM for the
chat?"), this reasoning held for the common path but left the uncommon
one (a hand-edited override that happens to be wrong) completely
invisible anywhere in setup — not shown, not validated, not flagged.
Found the hard way: `ORCHESTRAI_CONVERSATION_LLM_MODEL` was hand-set to
a text-to-speech-only model (`gemini-2.5-flash-preview-tts`), silently
failing every chat answer-synthesis call for an entire session with a
quiet fallback to raw output and zero setup-time visibility into why.
Yusuf's own words: *"let me the option to set it in the init."*
`modelsRows()` now returns `["shared", "orchestrator", "conversation",
...agentComponents]` — both new rows are always present, immediately
after `"shared"`, regardless of `selectedAgents` (including an empty
selection); unlike an agent row, neither depends on which work-agents
are selected, since `orchestrator` drives every `plan-task` and
`conversation` drives every `/ask` answer synthesis. No other function
needed to change — `rowComponentAtCursor()`, `setModelAtCursor()`/
`modelAtCursor()`, `resolvedProviderAtCursor()`, `cyclePickerProvider()`,
and `formStateToWizardConfig()`'s own `modelOverrides` loop (`for (const
component of LLM_COMPONENTS)`, all 8, unconditionally) were already
fully generic over any `LlmComponent` — confirmed by reading each
directly before implementing, not assumed. A config with neither
override set writes byte-identically to before this spec. 1101 tests
pass (net +18 over `073`'s own 897 baseline — mostly index-shift fixes
in `init-form-state.test.ts` for devops moving from row 1 to row 3, the
expected consequence of two new rows landing before it), typecheck
clean. **Not live-verified**: the same standing no-raw-mode-stdin gap
every guided-init checkpoint here carries — see `specs/095`'s own
`verification.md`.
