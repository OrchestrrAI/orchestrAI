---
id: 072-init-form-empty-selection-means-no-agents
title: Guided Init Forms — An Explicitly Empty Agent Selection Means No Agents, Not All
area: supervisor
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-11
updated: 2026-09-11
approved_by: Yusuf
approved_on: 2026-09-11
implemented_on: 2026-09-11
amends:
  - 034-init-wizard-services-ux
  - 048-guided-init-experience
  - 071-models-view-inline-provider-in-picker
related:
  - 049-guided-init-web-setup
supersedes: []
superseded_by: []
---

# Spec: Guided Init Forms — An Explicitly Empty Agent Selection Means No Agents, Not All

> Review gate: **APPROVED 2026-09-11 by Yusuf**, via a direct
> AskUserQuestion choice ("Yes — checkboxes only (Recommended)") after
> live feedback: *"but why? even i select non means non!"* — having just
> watched the Models section list every agent row with every checkbox
> unticked (a display bug fixed moments earlier the same day, see
> `specs/071`'s verification.md correction), Yusuf pushed back on the
> underlying convention itself, not just its rendering.

## Purpose

`specs/034`/`048` established: an **empty** agent selection means "all
agents" everywhere in this codebase — `selectedAgentsToOnly()` maps both
"every agent individually ticked" and "nothing ticked" to `only: []`
(unrestricted), matching the classic prompt wizard's own "blank answer
= all" convention and `apps/supervisor/index.ts`'s existing default
(`--only`/`ORCHESTRAI_ONLY` unset or empty → start everything).

That convention is right for the **classic wizard's text prompt**: a
blank Enter there is genuinely ambiguous (did the user want the
default, or not understand the question?), and defaulting to "all"
avoids an accidental zero-agent startup from someone who just hit
Enter.

It is **not** right for the **checkbox-based forms** (the TUI form,
`specs/048`; the browser form, `specs/049`). Both start with every box
ticked (`initialFormState()`'s default `selectedAgents: [...allAgents]`
— a full, explicit array, never empty). The *only* way either form's
`selectedAgents` ever becomes `[]` is a user individually unticking
every single box — a deliberate, unambiguous action with no "did they
mean it?" question. Treating that the same as "give me the default" is
wrong, and specs/071's own Models section made the mismatch visible for
the first time: the section correctly listed every agent's row (because
`agentLlmFieldsFor()` also treats empty-as-all), while the checkboxes
themselves sat unticked — the exact discrepancy Yusuf reported.

Also newly relevant: `apps/supervisor/index.ts` already supports a
genuine zero-work-agent startup — `--only orchestrator` is a documented
example (orchestrator + mcp:http only, no devops/testing/documentation/
security). There is a real, already-supported target state for "the
user wants zero agents" to resolve to; it just isn't reachable from
either guided-init form today.

## Verified Current State

Read 2026-09-11 (`apps/supervisor/init-form-state.ts`):

- `selectedAgentsToOnly(state)`: `if (chosen.length === 0 ||
  chosen.length === allAgents.length) return []` — both "all" and
  "none" map to the same empty-`only` output.
- `agentLlmFieldsFor(state)`: `const all = state.selectedAgents.length
  === 0; return AGENT_LLM_HARNESSES.filter((h) => all ||
  state.selectedAgents.includes(h.agent))` — the same "empty means
  all" fallback, independently implemented, feeding `modelsRows()`
  (`specs/071`, which Models-section rows exist),
  `formStateToWizardConfig()`'s `agentLlm` derivation (which
  `ORCHESTRAI_<AGENT>_LLM_HARNESS=1` lines get written), and
  `ReviewLine`'s "Agent LLM" summary.
- `apps/supervisor/init-form.tsx`'s `AgentsSection`, as of a same-day
  fix earlier today: renders every checkbox as ticked when
  `selectedAgents.length === 0`, to make the (then-correct) "empty
  means all" convention visually honest. This fix is **reverted** by
  this spec — once empty genuinely means "none", showing every box
  unticked *is* the honest rendering.
- `parseServiceSelection(input, validNames)` (classic wizard,
  `init-wizard.ts`): blank input or the literal word `"all"` → `{ ok:
  true, names: [] }`. **Unaffected by this spec** — Yusuf's own choice
  keeps the classic wizard's ambiguous-blank-input convention as is.
- `apps/supervisor/index.ts`'s `--only orchestrator` / `ORCHESTRAI_ONLY=
  orchestrator` already starts only the orchestrator (+ implied
  mcp:http) — confirmed via the documented `--help` example at that
  file's own usage text. No supervisor-side change needed.

## Proposed Behavior

### 1. `selectedAgentsToOnly()` — empty means none, not all

```ts
export function selectedAgentsToOnly(state): string[] {
  const chosen = state.allAgents.filter((n) => state.selectedAgents.includes(n))
  if (chosen.length === state.allAgents.length) return []       // all → unrestricted, unchanged
  if (chosen.length === 0) return ["orchestrator"]              // none → orchestrator only, changed
  return chosen                                                  // a real subset, unchanged
}
```

`formatConfigEnv()` needs no change: its existing "append `orchestrator`
to any non-empty `only` that doesn't already have it" rule already
leaves `["orchestrator"]` as `ORCHESTRAI_ONLY=orchestrator` untouched.

### 2. `agentLlmFieldsFor()` — drop the "empty means all" fallback

```ts
export function agentLlmFieldsFor(state): AgentLlmField[] {
  return AGENT_LLM_HARNESSES.filter((h) => state.selectedAgents.includes(h.agent)).map((h) => h.field)
}
```

A fresh form's default `selectedAgents` is already the full explicit
array (not empty), so this is safe: the only case whose output changes
is a deliberately-emptied selection, which now correctly yields no
harness fields. This single change automatically fixes `modelsRows()`
(specs/071 — an emptied selection now shows just the `"shared"` row,
no agent rows) and `formStateToWizardConfig()`'s `agentLlm` (now writes
no `ORCHESTRAI_<AGENT>_LLM_HARNESS` lines at all when nothing is
selected), since both already derive from this one function.

### 3. The Agents checkboxes revert to plainly showing what's ticked

`AgentsSection`'s same-day `allSelected` fallback is removed — a
checkbox reflects `state.selectedAgents.includes(agent.name)` directly,
same as before that fix. With this spec's change, that's now the
*correct* rendering: unticked boxes genuinely mean "this agent will not
start."

### 4. `ReviewLine`'s summary label

`count === 0` currently renders `"all"` (same bug source). It should
name the real outcome — e.g. `"none (orchestrator only)"` — so `^S`
never surprises the user about what's about to start.

### 5. The classic wizard and browser form

- **Classic wizard**: untouched, per Yusuf's own choice — blank input
  still means "all" there.
- **Browser form** (`specs/049`): automatically inherits this behavior
  — `init-web.ts` calls the exact same `formStateToWizardConfig()`/
  `validate()` from `init-form-state.ts`, never a second implementation.
  Its own checkbox rendering (`buildPageHtml`'s `agentRows`) already
  renders plain `.includes()` checks (never had the TUI form's same-day
  "all when empty" detour), so no separate fix is needed there.

## Scope

- `apps/supervisor/init-form-state.ts`: `selectedAgentsToOnly()`,
  `agentLlmFieldsFor()`.
- `apps/supervisor/init-form.tsx`: revert `AgentsSection`'s
  `allSelected` fallback; `ReviewLine`'s `count === 0` label.
- Tests: `apps/supervisor/init-form-state.test.ts` — every test that
  asserted "empty selection ⇒ all" needs to assert "empty selection ⇒
  none" instead (`selectedAgentsToOnly`, `agentLlmFieldsFor`/
  `formStateToWizardConfig`'s `agentLlm`, `modelsRows`).
- **Out of scope / unchanged**: `apps/supervisor/init-wizard.ts`'s
  `parseServiceSelection` and the classic wizard's own prompt flow;
  `apps/supervisor/index.ts` (the `--only orchestrator` behavior this
  relies on already exists); `apps/supervisor/init-web.ts` (inherits
  the fix with no code change of its own).

## Safety and Compatibility Constraints

- **No orphaned config**: `ORCHESTRAI_ONLY=orchestrator` is an
  already-supported, already-documented supervisor mode — this spec
  does not add new startup logic, only a new way for a form to reach an
  existing one.
- **The classic wizard's own byte-identical-output guarantee for "all"
  is untouched** — both surfaces still agree exactly when the form's
  selection is the full explicit array (unaffected by this change) or
  a real subset; they only diverge, by design, for the
  blank-text-input-vs-deliberately-emptied-checklist case this spec is
  about.
- **Reversible, inspectable**: a config written this way is
  indistinguishable from one hand-written or written via
  `--only orchestrator` directly — no new file format, no sentinel
  values beyond the agent name already in `AGENT_CATALOG`.

## Out of Scope / Non-Goals

- Any change to the classic wizard's own "blank = all" convention.
- Any change to `apps/supervisor/index.ts`'s `--only` parsing.
- A dedicated "none" vs "all" toggle/affordance — unticking every box
  already is the "none" gesture; no new UI element is added.

## Acceptance Criteria

- [x] Explicitly unticking every agent checkbox in the TUI form and
      saving writes `ORCHESTRAI_ONLY=orchestrator` (no devops/testing/
      documentation/security), not a blank `ORCHESTRAI_ONLY=` — proven
      by test (`selectedAgentsToOnly([]) === ["orchestrator"]`) and
      live-smoked in a real PTY.
- [x] With every agent unticked, no `ORCHESTRAI_<AGENT>_LLM_HARNESS`
      line is written for any of them, and the Models section shows
      only the `shared / default` row — proven by test
      (`agentLlmFieldsFor([]) === []`, `modelsRows([]) === ["shared"]`)
      and live-smoked.
- [x] The Agents checkboxes plainly show what's ticked — unticked means
      unticked, no "secretly all" fallback. Live-smoked: both unticked
      rows render `[ ]`.
- [x] The classic wizard's blank-input-means-all behavior is unchanged
      — the existing "one config contract" tests for the "all"/
      full-array cases pass unmodified (they never exercise an empty
      `selectedAgents`).
- [x] `bun test` (883 pass), `bun run typecheck` (0 errors),
      `bun run specs:check` (71 specs) pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Pure unit tests: `selectedAgentsToOnly([])` → `["orchestrator"]`;
  `selectedAgentsToOnly(allAgents)` → `[]` (unchanged);
  `agentLlmFieldsFor([])` → `[]`; `modelsRows` with an empty selection
  → `["shared"]` only; `formStateToWizardConfig` with an empty
  selection writes no agent harness lines and
  `ORCHESTRAI_ONLY=orchestrator`.
- A live real-terminal pass: untick every agent, confirm the Models
  section and the review line, save, and confirm the written
  `config.env` — the standard every guided-init checkpoint here
  carries.

## Approval Requested

**Approved 2026-09-11 by Yusuf**, via direct AskUserQuestion choice.
Implementation proceeds immediately.
