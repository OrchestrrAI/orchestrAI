---
id: 125-configurable-harness-recursion-limit
title: Configurable Shared LLM Harness Tool-Call Recursion Limit
area: agent-llm-harnesses
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-24
updated: 2026-09-24
approved_by: Yusuf
approved_on: 2026-09-24
implemented_on: 2026-09-24
amends:
  - 083-coder-agent
  - 098-harness-recursion-limit-and-clean-failure
supersedes: []
superseded_by: []
related:
  - 042-llm-harness-devops
  - 041-llm-harness-documentation
  - 073-configurable-service-ports
  - 080-run-command-approved-execution
  - 081-testing-write-tests-skill
  - 082-code-review-agent
  - 097-chat-answer-and-plan-description-honesty
  - 114-coder-multi-file-edit-and-create
---

# Spec: Configurable Shared LLM Harness Tool-Call Recursion Limit

## Purpose

Live-observed in the TUI: a Coder `edit-files` task ("create the
.env.example file") failed with `"The edit-files harness could not
converge on a proposal within 20 tool-call rounds — try a narrower, more
specific instruction naming exactly what should change."` — the harness's
own exploration phase (`read_project_file`, `analyze_project`,
`git_status`, `git_diff`) consumed its entire bounded budget against a
large real project before the model ever emitted a final structured
proposal. The bound itself (`HARNESS_RECURSION_LIMIT = 20`) is a bare
`const`, identically hardcoded in five separate files with no way to
raise it for a larger project or lower it for a tighter budget, short of
editing source and restarting. This spec raises the shipped default
from 20 to **40** (Yusuf, 2026-09-24) and makes that one number
configurable via a single shared environment variable, applied
uniformly to every agent's harness — deliberately not a
per-component/per-agent set of variables (a narrower option was
considered and rejected; see Proposed Behavior).

## Verified Current State

Five files each independently declare the identical unconfigurable
constant and pass it to LangGraph's `recursionLimit` option at their own
`.invoke()` call site(s):

- `packages/agents/coder/llm-harness.ts:47` — used at three call sites
  (`:353` `edit-file`, `:667` `edit-files`, `:810` `edit-and-verify`'s
  verify-command sub-harness, `specs/119`).
- `packages/agents/code-review/llm-harness.ts:38` — `review-diff`,
  one call site (`:314`).
- `packages/agents/devops/llm-harness.ts:36` — shared across DevOps's
  parameter-deciding harnesses, one call site (`:301`).
- `packages/agents/documentation/llm-harness.ts:52` — shared across
  `generate-readme`/`document-api`, one call site (`:312`).
- `packages/agents/testing/llm-harness.ts:41` — shared across
  `run-command` proposal and `write-tests`, two call sites (`:225`,
  `:393`).

Each site catches `GraphRecursionError` (`specs/098`) and re-throws a
named, honest error quoting the literal `20` via template-string
interpolation of the local constant — never a hardcoded `20` in the
message text itself, so the message already self-updates from whatever
the constant resolves to.

Two existing precedents already establish the exact resolution shape this
spec reuses, both already documented in `CLAUDE.md`:
`packages/shared/service-ports.ts`'s `resolveServicePort()` (`specs/073`)
and `apps/orchestrator/supervisor-graph.ts`'s
`resolveSupervisorMaxDispatches()` (`specs/097`) — both: env var wins when
set to a valid positive integer, otherwise a hardcoded default applies;
never throws; a malformed value degrades silently to the default rather
than disabling the bound.

## Proposed Behavior

One new shared resolver, one new environment variable, applied
identically to all five files — **not** a per-agent/per-component set of
five variables. This was a deliberate choice between two options
presented to Yusuf, who chose the shared form: the failure mode this
spec addresses (a large project's exploration phase burning the budget)
is not agent-specific — every harness explores the same real project the
same way — so a single dial is simpler to reason about and set once,
at some cost in granularity versus the alternative of tuning each agent
independently.

1. **New shared module or addition to an existing one**
   (`packages/shared/service-ports.ts` is DevOps/ports-flavored, so this
   likely lives in a new small file, e.g.
   `packages/shared/harness-limits.ts`, decided during implementation —
   scope is intentionally left to the smallest coherent location, not
   forced into an unrelated existing file):
   ```ts
   export const HARNESS_RECURSION_LIMIT_ENV_VAR = "ORCHESTRAI_HARNESS_RECURSION_LIMIT"
   export const DEFAULT_HARNESS_RECURSION_LIMIT = 40

   export function resolveHarnessRecursionLimit(env: NodeJS.ProcessEnv = process.env): number {
     const raw = env[HARNESS_RECURSION_LIMIT_ENV_VAR]
     if (raw === undefined || raw === "") return DEFAULT_HARNESS_RECURSION_LIMIT
     const parsed = Number(raw)
     if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_HARNESS_RECURSION_LIMIT
     return parsed
   }
   ```
2. **Each of the five files** replaces its own
   `const HARNESS_RECURSION_LIMIT = 20` with
   `const HARNESS_RECURSION_LIMIT = resolveHarnessRecursionLimit()`
   (module-level, resolved once at import time — identical timing to
   today's constant, and matching `resolveServicePort()`'s own
   already-established "read `process.env` once, not per-call" pattern).
   Every existing `.invoke(..., { recursionLimit: HARNESS_RECURSION_LIMIT })`
   call site and every existing error-message template string is
   otherwise untouched — they already interpolate the constant, so a
   raised/lowered value is reflected automatically.
3. **No per-agent override.** A future spec could add per-component
   granularity (mirroring `ORCHESTRAI_<COMPONENT>_LLM_*`, `specs/039`) if
   the shared dial proves too coarse in practice — explicitly deferred,
   not designed in now.
4. **Never removes or weakens the bound itself.** An absurdly large
   configured value (e.g. `999999`) is still accepted (matching
   `resolveSupervisorMaxDispatches()`'s own "no upper clamp" precedent) —
   this spec adds configurability, not a new safety ceiling; the
   `GraphRecursionError` catch and fail-closed/fail-open behavior per
   agent (`specs/098`) stay completely unchanged.
5. **The TUI guided-init form surfaces it** (Yusuf, 2026-09-24: "remember
   the tui"). The setup screen gains one editable row for the harness
   recursion limit, built the same way the Ports section (`specs/073`) is:
   - **Placement:** a new section (or single row) below Ports on the setup
     screen, reached by the same focus cycling (`FormFieldId` /
     `SETUP_FIELDS` in `apps/supervisor/init-form-state.ts`). Empty shows
     `(default: 40)`.
   - **Input:** digits only, same as a Ports row. Empty means "use the
     default".
   - **Validation:** a non-empty value that is not an integer ≥ 1 is a
     named validation error shown on the form and blocks saving, the same
     way an out-of-range port does. The runtime resolver still never
     throws; form validation only stops the wizard from writing a value
     the resolver would silently ignore.
   - **Writing:** `formatConfigEnv()` (`apps/supervisor/init-wizard.ts`)
     writes `ORCHESTRAI_HARNESS_RECURSION_LIMIT=<n>` only when a valid
     value differs from `DEFAULT_HARNESS_RECURSION_LIMIT`. An untouched or
     default value writes no line, so a config that never touched this row
     is byte-identical to one written before this spec.
   - **Ownership and seeding:** `ORCHESTRAI_HARNESS_RECURSION_LIMIT` is
     added to `WIZARD_OWNED_KEYS`, so clearing the row back to default
     removes its line. The row is seeded from an existing `config.env`
     value on open, same as Ports, so a hand-edited value survives a
     re-save even if the user never touches the row.
   - **Layout:** the new row must fit the setup screen's existing
     height-budget/scroll-offset helpers (the ones that already account
     for Models and Ports rows), verified at the 80×24 minimum in a real
     PTY. `init-form.tsx` has overflow history, so this is a real check,
     not optional.
   - The classic wizard (`init-wizard.ts`'s prompt flow) and the browser
     form (`init --web`) do **not** ask, matching how Ports was scoped. Any
     value already in the file is preserved by `mergeConfigEnv()`.

## Scope

- New file (or addition to an existing shared module) exporting
  `resolveHarnessRecursionLimit()`, `HARNESS_RECURSION_LIMIT_ENV_VAR`,
  `DEFAULT_HARNESS_RECURSION_LIMIT`.
- `packages/agents/coder/llm-harness.ts`,
  `packages/agents/code-review/llm-harness.ts`,
  `packages/agents/devops/llm-harness.ts`,
  `packages/agents/documentation/llm-harness.ts`,
  `packages/agents/testing/llm-harness.ts` — swap the constant's literal
  assignment for the resolver call; no other line touched.
- `apps/supervisor/init-form-state.ts` — state, focus, validation,
  config building, and seeding for the new row (Proposed Behavior 5).
- `apps/supervisor/init-form.tsx` — rendering and key handling for the
  new row.
- `apps/supervisor/init-wizard.ts` — `WizardConfig` field,
  `formatConfigEnv()` line, `WIZARD_OWNED_KEYS` entry. The classic wizard
  passes the "unset" value and never prompts.
- `apps/supervisor/init-web.ts` — only whatever minimal change is needed
  so its `WizardConfig` still type-checks (passing the "unset" value). No
  new browser form field.
- The matching tests: `init-form-state.test.ts`, `init-wizard.test.ts`.
- `CLAUDE.md` — document the new env var alongside the harness-common
  bullet that already names `HARNESS_RECURSION_LIMIT = 20`, and in the
  Guided init bullet list.

## Safety and Compatibility Constraints

- **Default behavior intentionally changes**: with the variable unset,
  every harness now resolves to `40` instead of `20`. Consequence, stated
  plainly: a harness that would have failed at round 20 can now spend up
  to twice as many model calls (and provider cost) before failing or
  converging. Setting `ORCHESTRAI_HARNESS_RECURSION_LIMIT=20` restores the
  pre-`125` behavior exactly.
- Never throws, never disables the bound — a malformed or absent value
  always degrades to the default, exactly like `resolveServicePort()`/
  `resolveSupervisorMaxDispatches()`.
- Does not touch `GraphRecursionError` handling, fail-open/fail-closed
  behavior, tool allow-lists, grounding, or any approval-gate logic —
  purely the numeric bound fed into LangGraph's own `recursionLimit`.
- Does not add a new LLM component or touch `LLM_COMPONENTS`
  (`specs/039`) — this is a graph-iteration bound, not a model/provider
  selection.
- The TUI guided-init form writes this value only through the same
  merge path every other wizard-owned key uses (`writeWizardConfig()` /
  `mergeConfigEnv()`). Comments, blank lines, and unknown variables in
  `config.env` survive untouched, as today.

## Out of Scope / Non-Goals

- Per-agent/per-component override variables (explicitly deferred, see
  Proposed Behavior item 3).
- Any change to why a harness fails to converge (prompt tuning, smarter
  exploration budgeting, a separate "exploration vs. proposal" budget
  split) — this spec only makes the existing single number configurable,
  it does not make convergence more likely at the same limit.
- Adding this variable to the classic prompt wizard or the `init --web`
  browser form (the TUI form is in scope; see Proposed Behavior 5).

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] `resolveHarnessRecursionLimit()` exists, is unit-tested for: unset →
      default; valid positive integer → that value; `0`, negative,
      non-numeric, and empty-string → default (never throws).
- [x] All five `llm-harness.ts` files resolve their constant through this
      function; a grep for `HARNESS_RECURSION_LIMIT = 20` (the old literal
      form) across `packages/agents/*/llm-harness.ts` returns zero matches.
- [x] With the env var unset, every harness resolves to `40`. The six
      existing recursion-limit tests that assert the literal message text
      `"within 20 tool-call rounds"` (code-review, coder, devops,
      documentation, and two in testing `llm-harness.test.ts`) are
      updated to `"within 40 tool-call rounds"` — the only test changes
      this spec expects; the tests' own `GraphRecursionError` → named-error
      logic is otherwise unchanged.
- [x] With the env var set to a custom value in a test's own `env`
      argument, `resolveHarnessRecursionLimit(customEnv)` reflects it
      (unit-level; a full live re-run of the recursion-limit integration
      tests with a real raised value is not required, since the value is
      only read once at module import in the real runtime — the resolver
      function itself is the correctly-scoped unit under test).
- [x] The TUI guided-init setup screen shows an editable harness
      recursion-limit row, showing `(default: 40)` when empty.
- [x] Form validation rejects a non-empty value that is not an integer
      ≥ 1, with a named error that blocks saving (unit-tested in
      `init-form-state.test.ts`).
- [x] `formatConfigEnv()` writes `ORCHESTRAI_HARNESS_RECURSION_LIMIT=<n>`
      only for a valid non-default value. Empty or default writes no line
      (unit-tested in `init-wizard.test.ts`).
- [x] `ORCHESTRAI_HARNESS_RECURSION_LIMIT` is in `WIZARD_OWNED_KEYS`;
      clearing the row removes the line on re-save, and an existing
      file value seeds the row on open (unit-tested).
- [x] The setup screen renders without overflow at 80×24 with the new
      row, checked in a real PTY (`node-pty` + `@xterm/headless`,
      scratch-only per this repo's own established technique). A real
      bug was found and fixed during this check — see verification.md.
- [x] `CLAUDE.md` documents `ORCHESTRAI_HARNESS_RECURSION_LIMIT` in the
      "Agent LLM harnesses" section's shared-structure bullet and in the
      Guided init bullet list.
- [x] `bun test` and `bun run typecheck` pass.
- [x] `context/worklog.md` gets a dated entry.

## Verification Plan

- Unit: a new `harness-limits.test.ts` covering
  `resolveHarnessRecursionLimit()`'s full input matrix (unset, empty,
  valid, `0`, negative, non-numeric, float).
- Unit: existing per-agent harness tests that already assert the
  `GraphRecursionError` → named-error message (search each
  `llm-harness.test.ts` for `"could not converge"`) re-run with only
  their expected number changed `20` → `40`, proving the new default is
  what every harness actually resolves to.
- Unit: `init-form-state.test.ts` — the new row's validation, config
  building, and seeding from an existing file value.
- Unit: `init-wizard.test.ts` — `formatConfigEnv()` writes/omits the line
  correctly, and the `WIZARD_OWNED_KEYS` round trip (clear → line removed).
- Real PTY: open `bun run orchestrai init` at 80×24 and a wider terminal,
  focus the new row, enter a value, save, and confirm the resulting
  `config.env` line. Record in `verification.md`.
- Manual/live (optional): re-run the exact live-failed task ("create the
  .env.example file" via `edit-files`) with
  `ORCHESTRAI_HARNESS_RECURSION_LIMIT` raised (e.g. `40`) against the same
  real project, and record whether it converges — evidence, not a gate
  (model behavior varies run to run per CLAUDE.md's standing note on
  model-judgment features).

## Approval Requested

Approval authorizes: adding one new shared resolver function/module for
a single environment variable (`ORCHESTRAI_HARNESS_RECURSION_LIMIT`)
governing all five agents' LLM harness tool-call recursion limits
uniformly, raising the shipped default from `20` to `40`, and updating
each of the five `llm-harness.ts` files' constant declaration to use it,
and adding one editable row for it to the TUI guided-init setup screen
(with validation, config writing, wizard key ownership, and seeding). It
does not authorize per-agent override variables, adding the field to the
classic wizard or the browser form, any change to convergence/prompting
behavior, or any change to `GraphRecursionError` handling, grounding, or
approval-gate logic.

**Approved by Yusuf on 2026-09-24**, including the TUI init-form row
("ok go ahead also remember the tui").
