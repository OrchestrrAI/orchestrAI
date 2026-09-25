---
id: 034-init-wizard-services-ux
title: Init Wizard Services Prompt — Numbered Selection, No Infrastructure Choices
area: supervisor
change_type: enhancement
status: implemented
verification: verified
created: 2026-08-21
updated: 2026-09-01
approved_by: Yusuf
approved_on: 2026-08-21
implemented_on: 2026-08-21
amends:
  - 031-interactive-init-wizard
supersedes: []
superseded_by: []
related:
  - 016-orchestrai-supervisor
  - 018-supervisor-project-path
  - 032-npm-package-distribution
---

# Spec: Init Wizard Services Prompt — Numbered Selection, No Infrastructure Choices

> Status history: **APPROVED (2026-08-21 by Yusuf), IMPLEMENTED the same
> day. VERIFIED 2026-09-01** — the one remaining acceptance criterion (a
> zero-flag `orchestrai` run against a wizard-written config genuinely
> starting the orchestrator) was blocked on port conflicts with a running
> session at original verification time; exercised live once ports were
> free, confirmed via `GET /healthz` on all four started services. See
> `verification.md`.

## Purpose

Two pieces of live feedback from `orchestrai init`'s "Services to run"
prompt, from a real user (via `npx orchestrai`, `specs/032`) working
through the wizard for the first time:

1. Typing an exact, case-sensitive, comma-separated list of service names
   is more friction than it needs to be for a first-run setup prompt.
2. `mcp:http` and `orchestrator` showing up as choosable items is
   misleading — neither is really an independent choice a first-time user
   should have to reason about. `mcp:http` is already silently
   auto-included today whenever a selected agent needs it
   (`apps/supervisor/index.ts`'s `needsMcp` check); listing it as
   something to pick or skip just invites a wrong guess. `orchestrator` is
   the thing that makes the other agents actually reachable as a
   coordinated system — a first-time user leaving it out by not knowing
   to type it is very likely an accident, not an intentional choice.

## Verified Current State

- `apps/supervisor/init-wizard.ts`'s `parseServiceSelection(input,
  validNames)`: empty input or the literal string `"all"`
  (case-insensitive) means every service (stored as `[]`, matching
  `--only` unset); otherwise splits on commas, trims, and rejects any name
  not in `validNames` with a re-prompt, not a crash.
- The prompt's `validNames` list is `ALL_NAMES`
  (`apps/supervisor/index.ts`), which is all 7 real service names —
  `mcp:http`, the 5 agents, and `orchestrator` — with no distinction made
  between "an agent you'd actually choose" and "always-implied
  infrastructure."
- `apps/supervisor/index.ts`'s dispatch already auto-includes `mcp:http`
  when a selected service's `dependsOnMcp` is true and it wasn't
  explicitly selected — printed as a note, never silent
  (`needsMcp`/`mcpAlreadySelected` around line 424). This existing
  behavior is not being changed by this checkpoint, only surfaced
  correctly in the wizard's prompt.
- `orchestrator` has no equivalent auto-include: `startOrchestrator =
  requested.has(ORCHESTRATOR.name)` — a `--only`/`ORCHESTRAI_ONLY`
  selection that omits `"orchestrator"` runs the agents named with **no**
  coordinator, by design, for the documented direct-agent-testing
  workflow (`bun run orchestrai --only devops-agent`, etc.).
- `WizardConfig.only: string[]` is persisted verbatim as
  `ORCHESTRAI_ONLY=<comma-separated names>` in `<target>/.orchestrai/
  config.env`, consumed by `apps/supervisor/index.ts` exactly like an
  equivalent `--only` flag would be (`specs/031`'s existing resolution
  chain) — this checkpoint does not add a new config source.
- `parseServiceSelection` is directly unit-tested today
  (`apps/supervisor/init-wizard.test.ts`) against plain comma-separated
  names; no numbered-input form exists.

## Proposed Behavior

1. The "Services to run" prompt lists only the 5 real agents, numbered:

   ```
   Services to run:
     1) planning-agent
     2) devops-agent
     3) testing-agent
     4) documentation-agent
     5) security-agent
   Select by number (comma-separated), by name, or "all" [all]:
   ```

   `mcp:http` and `orchestrator` never appear in this list and are never
   valid tokens to type here.

2. `parseServiceSelection` (or a successor function with an equivalent
   pure, unit-testable shape) accepts, unchanged from today: blank input
   or `"all"` → every agent; a comma-separated list of exact agent names.
   **Added** by this checkpoint: a comma-separated list of the displayed
   numbers (e.g. `2,4`) resolves to the same agent names by position.
   Mixing numbers and names in the same input is not required to work;
   an input that is neither a valid number list nor a valid name list
   re-prompts with the existing clear-error pattern, not a crash.

3. Whatever agent subset is chosen (or `"all"`), the wizard **always**
   includes `"orchestrator"` in the `ORCHESTRAI_ONLY` value it writes to
   `config.env` — invisibly, the same way `mcp:http`'s inclusion is
   already invisible to the user today. A zero-flag `orchestrai` run
   driven by a wizard-written config therefore always starts the
   orchestrator, with no way to produce a coordinator-less setup through
   the wizard.

4. `mcp:http`'s existing auto-include behavior
   (`needsMcp`/`mcpAlreadySelected`) is untouched — it already does the
   right thing; this checkpoint only stops the wizard from asking about
   it in the first place.

5. Re-running `init` against a config file written by a version of the
   wizard that predates this checkpoint (one whose saved `ORCHESTRAI_ONLY`
   may lack `"orchestrator"`, or may include it explicitly from a
   pre-034 save) pre-fills sensibly: the displayed default for the
   prompt is the saved agent subset with `orchestrator`/`mcp:http`
   filtered out of what's shown, never surfaced as if they were a user
   choice, and never causes a parse error or crash.

## Safety Constraints

- **No change to `--only`'s flag semantics or `orchestrai service
  <name>`.** Both continue to accept `orchestrator` being omitted,
  exactly as today — this checkpoint's always-on behavior is scoped
  strictly to the wizard's own generated config, not to the underlying
  resolution/dispatch logic every other entry point shares. The
  direct-agent-testing workflow this existing behavior supports remains
  fully reachable outside the wizard.
- **No change to `mcp:http`'s auto-include logic itself** — only to what
  the wizard's prompt displays and validates.
- **No change to which services exist, `SERVICE_STARTERS`, or
  `ALL_NAMES`** — this is a prompt-presentation and config-generation
  change only.
- Never a silent behavior change a re-run can't recover from: a config
  written before this checkpoint must remain loadable and re-editable by
  a wizard run after it.

## Out of Scope / Non-Goals

- Any change to `bun run orchestrai --only ...`'s existing flag parsing
  or validation (`apps/supervisor/index.ts`'s `parseArgs()`).
- Making `mcp:http` or `orchestrator` selectable again under some
  advanced/expert mode — if a future need for that surfaces, it is a
  separate checkpoint, not implied here.
- Any change to the LLM harness prompts, target-path prompt, or
  confirmation-screen flow this spec doesn't explicitly mention.
- A checkbox-style/arrow-key interactive multi-select widget — this
  stays a linear text-input prompt like the rest of the wizard
  (`specs/031`'s own resolved Open Decision: plain Node/Bun builtins,
  no new interactive-terminal dependency); numbers are typed and
  comma-separated, not toggled with arrow keys.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] The "Services to run" prompt displays only the 5 agents, numbered;
      `mcp:http` and `orchestrator` never appear as choosable items.
- [x] Comma-separated numbers (e.g. `2,4`), the existing name-based input,
      and blank/`"all"` all resolve correctly; an invalid number (out of
      range) or unknown name re-prompts with a clear error, not a crash.
- [x] The persisted `ORCHESTRAI_ONLY` value always includes `orchestrator`
      regardless of which agent subset was chosen — verified by reading
      the written `config.env` after a run that selected a subset, not
      just "all".
- [x] A zero-flag `orchestrai` run against a wizard-written config starts
      the orchestrator — **exercised live 2026-09-01** (see
      verification.md): a scratch config matching exactly what the fixed
      wizard writes (`orchestrator` explicitly appended to a chosen
      subset) started all four expected services, orchestrator included,
      confirmed via `GET /healthz` on each, not log text alone.
- [x] Re-running `init` against a config saved by the pre-034 wizard
      (one without `orchestrator` in its `ORCHESTRAI_ONLY`) pre-fills
      without error and does not display `orchestrator`/`mcp:http` as if
      they were prior choices.
- [x] `--only` flag behavior and `orchestrai service <name>` are verified
      unchanged — a direct `--only devops-agent` run still starts with no
      orchestrator, exactly as before this checkpoint. (Unchanged by
      inspection: this checkpoint's only edit to `index.ts` is the
      wizard's own call site; `parseArgs()`/`effectiveOnly` resolution is
      untouched.)
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` all pass.
- [x] `CLAUDE.md`, `README.md`, `context/worklog.md` updated.

## Verification Plan

- Automated: extend `apps/supervisor/init-wizard.test.ts`'s existing
  `parseServiceSelection` coverage with numbered-input cases (valid,
  out-of-range, mixed garbage) and a case asserting `orchestrator` is
  always present in whatever gets persisted.
- Manual: run `orchestrai init` interactively in a real terminal,
  selecting a subset by number; confirm the resulting `config.env` and a
  real zero-flag startup both reflect the intended agents plus the
  orchestrator. Re-run `init` against a config manually edited to mimic a
  pre-034 save (no `orchestrator` in `ORCHESTRAI_ONLY`) and confirm no
  crash and a sensible pre-filled default.
- Regression: confirm `--only <agent>` (no wizard involved) still starts
  with no orchestrator, unchanged.

## Approval Requested

Approval authorizes: changing the init wizard's "Services to run" prompt
display and input parsing (numbered selection added, `mcp:http`/
`orchestrator` removed as choosable items), and always including
`orchestrator` in what the wizard persists to `ORCHESTRAI_ONLY`. It does
not authorize any change to `--only`'s flag semantics, `orchestrai
service <name>`, `mcp:http`'s auto-include logic, or any other prompt in
the wizard's flow.
