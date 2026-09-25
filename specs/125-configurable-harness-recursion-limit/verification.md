# Verification: Configurable Shared LLM Harness Tool-Call Recursion Limit

**Status: APPROVED by Yusuf on 2026-09-24 (including the TUI init-form
row, "ok go ahead also remember the tui"), IMPLEMENTED and VERIFIED the
same day** — including a real PTY-driven live check of the TUI form,
which found and fixed a genuine (pre-existing) scroll-visibility bug
along the way.

## What was live-observed

A Coder `edit-files` task ("create the .env.example file") failed with
`"The edit-files harness could not converge on a proposal within 20
tool-call rounds"` — the harness's exploration phase burned its entire
bounded budget against a large real project before ever emitting a final
proposal. The bound was a bare, unconfigurable `const
HARNESS_RECURSION_LIMIT = 20`, independently hardcoded in five files.

## What changed

- **New shared module** `packages/shared/harness-limits.ts`:
  `resolveHarnessRecursionLimit()`, mirroring the exact resolution shape
  `resolveServicePort()` (`specs/073`) and
  `resolveSupervisorMaxDispatches()` (`specs/097`) already established —
  `ORCHESTRAI_HARNESS_RECURSION_LIMIT` wins when set to a valid integer
  ≥ 1, else the default; never throws.
- **Default raised 20 → 40** (Yusuf, 2026-09-24), per
  `DEFAULT_HARNESS_RECURSION_LIMIT`.
- All five `packages/agents/*/llm-harness.ts` files now resolve their
  local `HARNESS_RECURSION_LIMIT` constant through this function at
  import time, replacing the hardcoded literal. Every existing
  `.invoke(..., { recursionLimit: HARNESS_RECURSION_LIMIT })` call site
  and every error-message template string is untouched (they already
  interpolate the constant).
- **TUI guided-init form** (`apps/supervisor/init-form-state.ts`,
  `init-form.tsx`, `init-wizard.ts`) gained a fifth setup-screen field,
  `"harnessLimit"`, below Ports:
  - `resolvedHarnessLimit()` / `setHarnessLimitOverride()` mirror the
    Ports section's raw-string/validate/resolve contract exactly, minus
    the per-service list (one shared value).
  - `validate()` blocks saving on a non-empty value that isn't an
    integer ≥ 1.
  - `formStateToWizardConfig()` only carries the override across when it
    validly differs from the default (40) — matching Ports' own rule.
  - `WizardConfig.harnessRecursionLimit?: number`;
    `formatConfigEnv()` writes `ORCHESTRAI_HARNESS_RECURSION_LIMIT=<n>`
    only for a non-default value; added to `WIZARD_OWNED_KEYS` so
    clearing the row removes the line.
  - `initialFormState()` seeds the row from an existing `config.env`
    value via `seedHarnessLimitOverride()`.
  - Rendered as `HarnessLimitRow`, a genuine single text row (matching
    one Ports row's own one-line shape), placed after `PortsSection`
    with a blank spacer, inside the existing scrollable fields region —
    no change to the fixed chrome above/below it.
  - `fieldScrollOffset()`'s generic "1 row" fallback for a field
    following Ports was previously never exercised (Ports was the last
    field) and was wrong for Ports' own real height; fixed by adding a
    real `PORTS_SECTION_ROWS` constant (header + `SERVICE_PORT_ROWS.length`)
    to the offset calculation, so `harnessLimit` scrolls to the correct
    position and any future field appended after it would too.
  - The classic prompt wizard and `init --web` browser form ask nothing
    new — `harnessRecursionLimit` is optional on `WizardConfig` and
    simply stays `undefined` at those call sites.
- `CLAUDE.md` updated: the "Agent LLM harnesses" shared-structure bullet
  and the Guided init bullet list both document the new variable/row.

## Verification performed

- `bun run typecheck` — 0 errors.
- `bun test apps/supervisor packages/shared/harness-limits.test.ts` — 265
  pass, 0 fail (up from 244 before this session's new tests).
  - New `harness-limits.test.ts` (written by the prior session):
    full input matrix for `resolveHarnessRecursionLimit()`.
  - New tests in `init-form-state.test.ts`: `resolvedHarnessLimit()`
    (unedited/valid/invalid), `setHarnessLimitOverride()`,
    `validate()` blocking on an invalid override,
    `formStateToWizardConfig()`'s "only non-default carries across"
    rule, `formatConfigEnv()` writing/omitting the line, seeding
    round-trip via `initialFormState()`, and `fieldScrollOffset()`
    placing `harnessLimit` correctly after Ports' real (fixed) height.
  - New tests in `init-wizard.test.ts`: the drift guard
    (`WIZARD_OWNED_KEYS covers everything formatConfigEnv can emit`)
    extended to exercise `harnessRecursionLimit` maximally; direct
    `formatConfigEnv` tests for the absent/default/non-default cases.
  - Updated three existing tests whose expectations changed only
    because a fifth focusable field now exists
    (`visibleFields`/`moveFocus` wrap-around) — no other existing test
    needed a change.
- `bun run specs:catalog` then `specs:check` — clean, 124 spec
  directories, CLAUDE.md within budget (78,968 / 150,000 characters).

## Live PTY verification (real terminal, real process)

The initial commit (`c7362fb`) left the real-PTY render check open —
this repo's own established live-PTY technique (`node-pty` +
`@xterm/headless`, deliberately scratch-only, never a project
dependency — see `context/worklog.md`'s own prior uses) was set up
afterward, in the scratchpad, to close that gap.

**Setup**: `npm install node-pty @xterm/headless` in a scratch driver
directory (outside the repo); a scratch target project pre-seeded with
`.orchestrai/config.env` (`ORCHESTRAI_LLM_PROVIDER=anthropic` +
a dummy API key) so the form's Providers gate opens already satisfied;
a Node driver script spawning `cmd.exe /c bun run
apps\supervisor\index.ts init` inside a real 80×24 pty via `node-pty`,
feeding all output into an `@xterm/headless` `Terminal` to get real
line-wrapped screen buffer snapshots, and `shell.write()` to send real
keystrokes.

**Driven sequence**: boot → Esc (leave Providers, already gated open) →
4× Tab (targetPath → agents → models → ports → harnessLimit) → type `0`
(invalid) → backspace, type `64` (valid) → save → re-launch against the
saved config to check seeding → cancel.

**Confirmed working, first pass**:
- The Harness limit row renders in the correct position, directly below
  Ports, with `(default: 40)` shown when empty.
- Digits-only input accepted; backspace clears.
- Typed `64` displayed correctly, no layout corruption/overflow at
  80×24, no overlap with adjacent Ports rows or the fixed footer.
- Save (see below) wrote `ORCHESTRAI_HARNESS_RECURSION_LIMIT=64` to the
  real `config.env`, merged correctly alongside the other real lines
  (`ORCHESTRAI_ONLY`, the five `_LLM_HARNESS` lines).
- Re-launching `init` against that saved file seeded the row with `64`
  on open, confirmed by inspecting the fresh screen buffer.

**Two real findings from this pass, not fabricated**:

1. **`Ctrl+S` (`0x13`) never reached the app** — it is the XOFF
   flow-control byte, intercepted by the pty layer before the
   application's raw-mode keyboard handler ever sees it. `Ctrl+X`
   (`0x18`, ASCII CAN — the code already treats both identically, per
   `init-form.tsx`'s own aliasing comment) worked immediately. This is a
   pty-testing artifact, not an application bug, and pre-dates this
   spec entirely — noted here because it blocked the first save attempt
   and cost real debugging time; a future PTY-driven check of this form
   should use `Ctrl+X` directly.
2. **A genuine, pre-existing bug**: typing `0` into the Harness limit
   row computed a real validation error (confirmed correct by the unit
   tests), but the error text never appeared on screen. Inspecting the
   raw captured buffer (`cat -A`) confirmed the error line was simply
   absent, not merely mis-colored — the scrollbox's auto-scroll
   `useEffect` in `init-form.tsx` only re-ran on focus/agent-selection
   changes, never on a validation error appearing while focus stayed
   put, so the box's own real (Yoga-measured) content-height clamp cut
   off exactly the newly-grown error line. Confirmed pre-existing (the
   same effect shape, with the same dependency array, existed before
   this spec — Ports was simply never the very last field before now,
   so its own equivalent error line happened to always have empty
   scroll headroom beneath it).

**Fix applied** (same session, after checking with Yusuf): `focusHasError`
(`Boolean(validation.errors[state.focus])`) is now computed once per
render and used to request one extra row of scroll (`offset + 1`) when
the focused field currently has an error, added to the effect's
dependency array so it also fires on error appearance/clearing without
requiring a focus change. Re-ran the identical PTY sequence afterward:
the `Must be a whole number of 1 or more.` error line now renders
correctly directly below the `0` value, and clearing it back to `64`
correctly returns to the normal (no-error) view. `bun run typecheck`
(0 errors) and the full `bun test` suite (1488 pass, 2 skip, 0 fail —
your live dev stack was stopped for this run, confirmed via `netstat`,
since a real running stack on the default ports makes one unrelated
`packages/agents/devops/index.test.ts` test connect to it and complete
instead of failing as it assumes) both re-confirmed clean after the fix.

**Teardown**: every pty-spawned `bun`/`cmd` process was explicitly
killed at the end of each driver run; `tasklist` confirmed no lingering
processes afterward. No real agent stack was ever started by this check
(`init` only writes config, per `specs/122`) — the only real filesystem
effect was the scratch target project's own `config.env`, entirely
outside the repository.

## Known limitations / next step

None outstanding for this spec. The one gap noted in the original
implementation commit (no real-PTY check) is closed by the session
documented above, including a real bug found and fixed as a direct
result of actually driving the new row live rather than only unit
testing it.
- The pre-existing `analyze-project`/no-MCP-server test flake noted above
  is unrelated to this spec and was not investigated further here.
