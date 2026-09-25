# Plan: Guided Init — TUI Setup Form and Launch Handoff

> Approved 2026-09-04. Implement in the phase order below; each phase's exit
> gate must pass before the next begins. Phases 1 and 4 are the ones that can
> silently break existing behavior, so both carry a byte-comparison check
> rather than a "looks right" check.

## Handoff Note

Written to be picked up by any agent, not only the one that drafted it. Read
`spec.md` first — in particular "Verified Current State", which records two
facts that decide the design and are expensive to rediscover:

1. **`@opentui/core@0.5.1` has no masked input.** Verified by reading
   `renderables/Input.d.ts` and `renderables/Textarea.d.ts`. Do not attempt a
   password field; see Phase 3.
2. **`main()` already re-reads `.orchestrai/config.env` from `cwd`.** That is
   why the launch handoff (Phase 4) needs no config plumbing.

specs/047's `plan.md` holds the reusable PTY verification harness recipe
(install command, driver script, the `@xterm/headless` screen-buffer variant,
the known-harmless ConPTY exit error). Reuse it; do not rebuild it.

## Phase 1 — Pure form state, no rendering

New file `apps/supervisor/init-form-state.ts`, mirroring how
`apps/tui/tui-state.ts` isolates logic from rendering. No OpenTUI, no React
import, testable with `bun:test` alone.

1. Define the field model: an ordered list of fields (target path, agents,
   harness toggle, supervisor toggle, provider, model, key) with the focus
   order the form navigates.
2. Pure reducers: `moveFocus(state, "next" | "prev")`, `toggleAgent(state, i)`,
   `cycleProvider(state, dir)`, `setText(state, field, value)`,
   `toggleBool(state, field)`.
3. Pure validation: `validate(state)` → per-field messages plus a single
   `canSave` boolean. Target path must exist and be a directory; a Gemini
   selection requires a model (matching the existing wizard's own rule).
4. `formStateToWizardConfig(state)` → the **existing** `WizardConfig` shape.
   This is the seam that guarantees one config contract.
5. Seed state from an existing config via the existing
   `readExistingWizardConfig`, so a re-run pre-fills exactly as today.

**Exit gate:** focused tests for every reducer, validation gating, and — the
load-bearing one — a test that feeds a known set of answers through
`formStateToWizardConfig` → `formatConfigEnv` and asserts the output is
**byte-identical** to what the classic wizard produces for the same answers.
That test is what keeps three input surfaces honest.

## Phase 2 — The form, rendered

New file `apps/supervisor/init-form.tsx` (`/** @jsxImportSource @opentui/react */`
pragma, as `apps/tui/index.tsx` has). Renders the Phase 1 state; holds no
business logic of its own.

1. Layout per spec §1: banner, target field, agent list, toggles, provider,
   model, key row, footer key hints.
2. **Inherit the layout constraints in spec §2 verbatim** — no explicit root
   width/height from `useTerminalDimensions()`, no `flexGrow`/`flexShrink` on
   any scrollbox (compute an explicit height instead), bound every long value
   with a truncating helper rather than letting it wrap.
3. Below 80×24, render only the minimum-size message with current and required
   dimensions.
4. Keys: Tab/↑↓ focus, Space toggle, ‹ › cycle, Enter edit/act, `^S`, `^X`,
   `Esc`. Route them through a small pure resolver so precedence is testable,
   the same way `resolveKeyOwner` works in `apps/tui/tui-state.ts`.

**Exit gate:** PTY harness run at 80×24 and 120×40 showing navigation, agent
toggling, validation blocking save, and the below-minimum state — captured
buffers recorded in `verification.md`.

## Phase 3 — The masked key handoff

The only novel mechanism in this spec. `promptMasked`/`promptLine` in
`init-wizard.ts` are **not modified**; they are imported and called.

1. On Enter over the key field: stop the OpenTUI renderer, restore normal
   terminal mode, run the existing masked reader, then re-create the renderer
   with the form state preserved (the state lives outside the renderer, so it
   survives).
2. Display the result only through the existing `maskKey()`.
3. Ctrl+C inside the masked prompt returns to the form with the key unset —
   it does not exit `init`, and it does not write anything.
4. **Fallback, pre-authorized by the spec:** if suspend/restore proves
   unreliable in a real terminal, collect the key after the form closes and
   immediately before the write, using the same reader with no renderer
   interaction. Choosing the fallback is an implementation decision, not a
   spec change — record which was used in `verification.md`.

**Exit gate:** a real terminal run (Yusuf's) confirming the key never appears
in cleartext on screen or in scrollback, that backspace/Ctrl+C behave, and that
the form comes back intact afterwards. The PTY harness can show the suspend and
restore frames but must not be treated as proof of the masking itself.

## Phase 4 — Routing and the launch handoff

1. Change `runInitWizard` to return
   `{ outcome: "started" | "saved" | "cancelled"; targetPath: string }`.
   Update its one call site.
2. `dispatch()` routing: `--classic` or non-TTY → today's prompt wizard,
   unchanged; otherwise → the form. `--web` is rejected here with a pointer to
   specs/049 until that lands.
3. On `^S`: write via the existing `writeWizardConfig`, then call the existing
   `main()` in the same process. Nothing else — no copied startup logic, no new
   env var.
4. On `^X`: write, print today's exact manual-run message, exit.
5. On `Esc`/`Ctrl+C`: write nothing, start nothing.

**Exit gate:** the 33 existing wizard tests pass unmodified; a non-TTY piped run
produces a config byte-identical to today's and starts nothing; a real `^S` run
brings up the stack with the chosen subset.

## Phase 5 — Verification and documentation

1. Full gates: `bun test`, `bun run typecheck`, `bun run specs:check`,
   `bun run build`, plus a compiled-binary `init` smoke.
2. PTY harness matrix from Phase 2 re-run against the final build.
3. Hand Yusuf the real-terminal checklist the harness cannot cover: the masked
   key moment, Ctrl+C at several fields, `^S` starting a working stack with no
   second command, resize/zoom, and one genuinely fresh
   `bunx orchestrai init` from an empty directory — the actual first-run path
   this spec exists for.
4. Record evidence in `verification.md`, keeping harness-proven and
   Yusuf-proven claims visibly separate. Update CLAUDE.md/README.md only for
   behavior actually confirmed.

**Exit gate:** no orphaned processes after a launched-then-quit run, and the
first-run path verified end to end from a fresh directory.

## Stop Conditions

Return for review if implementation would require: modifying the raw stdin
reader; rendering the key through OpenTUI; a new dependency; explicit root
sizing or a `flexGrow` scrollbox; changing what is asked or written; changing
`main()`'s startup sequence; or making the non-TTY path capable of launching a
stack.

If this plan's own guidance turns out stale against the real code (line numbers
and helper names may shift), re-verify the specific claim against the file
rather than following it blindly or silently reinterpreting the spec.
