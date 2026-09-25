---
id: 122-remove-init-save-and-start
title: Remove the Same-Session "Save and Start" Path From orchestrai init
area: supervisor
change_type: fix
status: implemented
verification: partial
created: 2026-09-24
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-24
implemented_on: 2026-09-24
amends: [048-guided-init-experience]
supersedes: []
superseded_by: []
related: [062-guided-init-tui-as-child-process, 066-supervisor-log-suppression-during-tui]
---

# Spec: Remove the Same-Session "Save and Start" Path From orchestrai init

> Review gate: **APPROVED 2026-09-24 by Muhamad-Yussuf. IMPLEMENTED 2026-09-24 (commit 4c047ec). AMENDED 2026-09-25 by Muhamad-Yussuf: Ctrl+S removed entirely — see "Amendment" below.**

## Purpose

`orchestrai init`'s interactive form and its browser form both offer a
"save and start" action (`Ctrl+S` in the TUI form; the only action the
browser form has) that writes the config and then launches the full stack —
including auto-opening the workspace TUI — in the same process session. This
path has never been confirmed working on a real terminal despite two
dedicated fix attempts (`specs/062`, `specs/066`), and was just reproduced
failing live by Yusuf on the current published build. The failure is a full
terminal hang, not a cosmetic glitch: the parent process dies, backend
service child processes are orphaned, and the terminal window becomes
unresponsive until closed.

The `saved`-then-separately-run-`orchestrai` path is a distinct code path
(fresh process, no in-session renderer hand-off) that all three specs above
already verified clean, and is the workaround Yusuf is already using
successfully.

This checkpoint's purpose is narrow: stop offering the broken path at all,
so `orchestrai init` cannot produce a hung terminal. It does not attempt to
diagnose or repair the underlying crash.

## Verified Current State

Confirmed by reading the current code directly (not assumed):

- **TUI form** (`apps/supervisor/init-form.tsx`):
  - `InitFormResult["action"]` is `"save-and-start" | "save-only" | "cancel"`
    (line 112).
  - `useKeyboard()`'s global key handler: `Ctrl+S` → `onResolve("save-and-start", state)`
    (lines 316-318); `Ctrl+X` → `onResolve("save-only", state)` (lines 320-323).
  - Footer hints on both the setup screen and the Providers screen literally
    say `^S start · ^X save` (lines 587, 928).
  - `runInitFormAndWrite()` (lines 214-227): on `"save-only"`, writes the
    config, prints `Saved. Run "orchestrai" (no flags) from <path>...`, and
    returns `{ outcome: "saved", targetPath }`. On anything else that isn't
    `"cancel"` (i.e. `"save-and-start"`), it writes the config and returns
    `{ outcome: "started", targetPath }` with no message of its own.
- **Browser form** (`apps/supervisor/init-web.ts`): has **no** save-only
  option at all — its single submit path (lines 501-508) always writes the
  config and unconditionally resolves `{ outcome: "started", targetPath }`,
  printing `Saved. Starting the stack from <path>...`. Every browser-form
  run goes through the same broken hand-off; this is in scope too.
- **Classic wizard** (`apps/supervisor/init-wizard.ts`): `runInitWizardInner()`
  only ever returns `{ outcome: "saved" }` or `{ outcome: "cancelled" }`
  (confirmed: no `"started"` value is ever constructed there). It already
  prints `Saved. Run "orchestrai" (no flags) from ${targetPath} to use this
  configuration.` This surface is not broken and needs no change.
- **Dispatch** (`apps/supervisor/index.ts`, `dispatch()`, lines 894-993):
  the `init`/`i` subcommand branch calls whichever of the three surfaces
  above applies, then at line 955: `if (outcome.outcome === "started")` —
  `process.chdir(outcome.targetPath)`, `process.stdin.resume()`, `await main()`,
  in the same process. This is the exact branch that leads into `main()`'s
  `shouldOpenTui` path (`Bun.spawn()`ing the TUI as a child with
  `stdio: "inherit"`, per `specs/062`) and the log-suppression machinery
  (`specs/066`).
- **`InitOutcome` type** (`apps/supervisor/init-form-state.ts`, lines
  892-895): `{ outcome: "started"; targetPath: string } | { outcome: "saved"; targetPath: string } | { outcome: "cancelled" }`.
- **Live reproduction (2026-09-24, Yusuf, npm-installed `orchestrai` v0.1.20,
  Windows Terminal)**: `orchestrai init` → fill form → `Ctrl+S` → terminal
  becomes fully unresponsive (no keypress has any effect). Task Manager:
  the parent `orchestrai.exe` is visible briefly then disappears; several
  orphaned `bun`-named subprocesses (the backend agent services) keep
  running. `<project>/.orchestrai/supervisor.log` exists (proving `main()`
  reached the point where it creates the file and sets
  `childLogsSuppressed = true`, per `specs/066`) but is completely empty —
  the parent died at or immediately after spawning the TUI child, before
  any backend log line was ever appended. Confirmed working workaround:
  save only (classic wizard, or `Ctrl+X` in the form), then separately run
  `orchestrai` (no flags) from that directory — a fresh process launch that
  never does this hand-off.
- `specs/048` (`status: implemented`, `verification: partial`) already
  documents an earlier same-process double-`CliRenderer` crash found live
  and never confirmed fixed. `specs/062` (amends 048, `verification:
  partial`) mitigated it by spawning the TUI as a separate child process,
  explicitly noting the real fix was never confirmed live. `specs/066`
  (amends 016, 062, `verification: partial`) fixed a second, different bug
  in the same hand-off (raw backend logs corrupting the TUI screen) found
  live by Yusuf, again never confirmed live afterward. All three have sat
  at `verification: partial` since 2026-09-04/06/10 respectively; this
  checkpoint's live evidence is the first confirmation attempt any of them
  has had since, and it shows the hand-off still fails, differently from
  either previously-diagnosed cause (this time the *parent* process itself
  dies, not an in-process renderer conflict or a screen-corruption glitch).

## Proposed Behavior

Remove the "save and start" outcome from every guided-init surface. After
this checkpoint, `orchestrai init` (in any of its three forms — classic,
TUI, browser) can only ever **save** a config or be **cancelled**; it never
launches anything in the same process. The user is always told to run
`orchestrai` (no flags) as a separate, subsequent command — matching what
the classic wizard already does today and what specs/048/062/066 already
verified as the clean path.

Concretely:

1. **TUI form** (`init-form.tsx`): remove the `Ctrl+S` → `"save-and-start"`
   key binding. `Ctrl+X` becomes the form's only save action, and is
   **also** bound to `Ctrl+S` (both keys perform the identical save-only
   action) — recommended so a user's muscle memory or a stale on-screen
   hint pressing "S" for "save" still does something safe rather than
   nothing. Footer hints on both screens change from `^S start · ^X save`
   to `^S/^X save`. `InitFormResult["action"]` drops `"save-and-start"`,
   leaving `"save-only" | "cancel"` (or is renamed to plain `"save"` since
   there is no longer a second save variant to distinguish it from — an
   implementation decision, not a behavior change).
2. **Browser form** (`init-web.ts`): the submit handler always resolves
   `{ outcome: "saved", targetPath }` (never `"started"`), and its
   console message becomes the same `Saved. Run "orchestrai" (no flags)
   from <path> to use this configuration.` wording the classic wizard and
   the TUI form's save-only path already use, replacing the current
   `Saved. Starting the stack from <path>...` message (which would
   otherwise now be a lie).
3. **`InitOutcome` type** (`init-form-state.ts`): remove the `"started"`
   variant entirely, leaving `{ outcome: "saved"; targetPath: string } | { outcome: "cancelled" }`.
4. **Dispatch** (`index.ts`): remove the `if (outcome.outcome === "started")`
   branch and everything inside it (the `chdir`/`stdin.resume()`/`main()`
   call). With `"started"` removed from the type, this becomes a compile-time
   guarantee, not just a runtime one — nothing can construct an outcome that
   routes there.
5. No change to the classic wizard (`init-wizard.ts`) — already correct.

**Decided by Yusuf (2026-09-24): `Ctrl+S` is aliased to the same save action
as `Ctrl+X`** — both keys perform the identical save-only behavior; neither
launches anything. This is the behavior point 1 above already describes as
the default recommendation, now confirmed rather than open.

**Amendment (Muhamad-Yussuf, 2026-09-25): the `Ctrl+S` alias is removed.**
`Ctrl+X` is the only save key; `Ctrl+S` is unbound and does nothing (it
falls through harmlessly — every later handler requires no Ctrl or a
different key). Both footer hints read `^X save`. Save output, the
`validation.canSave` gate and `Ctrl+C` cancel are unchanged. The only file
touched is `apps/supervisor/init-form.tsx`.

## Scope

Files expected to change:

- `apps/supervisor/init-form.tsx` — key binding, footer hint text, `runInitFormAndWrite()`'s
  return value, `InitFormResult["action"]` usage.
- `apps/supervisor/init-form-state.ts` — `InitOutcome` type (remove `"started"`),
  and `InitFormResult["action"]` type if it also lives here (verify exact
  file at implementation time — confirmed above to be declared in
  `init-form.tsx` at line 112, but shared helpers may reference it from
  `init-form-state.ts` too).
- `apps/supervisor/init-web.ts` — submit handler's outcome and message.
- `apps/supervisor/index.ts` — `dispatch()`'s `init`/`i` branch, removing the
  `"started"` handling.

Explicitly **not** in scope:

- `apps/supervisor/init-wizard.ts` (classic wizard) — already correct,
  untouched.
- Diagnosing or fixing the actual crash in the same-session launch path.
  This checkpoint removes the feature; it does not repair it.
- Deleting the now-unreachable code in `main()`'s `shouldOpenTui` branch
  that spawns the TUI as a child process (`specs/062`) or the log
  suppression machinery (`specs/066`). Both remain reachable via every
  other route into `main()` (`bun run orchestrai`, the compiled binary run
  directly, `orchestrai init` save-then-separately-run) — this checkpoint
  only removes the one broken *hand-off into* `main()` from within the
  same init process, not `main()`'s own TUI-launch behavior, which is used
  correctly by every non-init invocation. `specs/062`/`066`'s own
  `verification: partial` status is unaffected by this checkpoint and
  should not be conflated with it.

## Safety and Compatibility Constraints

- This is a pure feature removal from an interactive setup flow; it has no
  effect on the running Orchestrator/agents/protocol, no approval-gate
  implications, and no data migration.
- No config file format changes — `writeWizardConfig()`/`formatConfigEnv()`
  are untouched.
- A config saved by either the TUI form or the browser form after this
  change must remain byte-identical (for the same answers) to one saved
  before this change — the write path itself is not being touched, only
  what happens after the write.
- Every existing "save" test (form state → `WizardConfig` → written file)
  must keep passing unmodified; only the outcome routing and the removed
  key binding are new.

## Out of Scope / Non-Goals

- Fixing the underlying crash so same-session launch could someday be
  reintroduced safely. If desired, that would be a separate, later
  checkpoint with its own real-terminal verification plan — this one does
  not attempt it and does not block it.
- Any change to `main()`'s own `shouldOpenTui` behavior for non-init
  invocations (`bun run orchestrai`, the compiled binary run directly, or
  the classic wizard's own printed follow-up command) — all of those stay
  exactly as they are today.
- Cleaning up `specs/062`/`066`'s now-narrower-but-still-live code (the
  child-process TUI spawn, log suppression) — still needed and correct for
  every other route into `main()`.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] `Ctrl+S` no longer produces a `"save-and-start"`/`"started"` outcome
  anywhere in the TUI form; it performs the identical save action as
  `Ctrl+X` (decided 2026-09-24). Superseded by the 2026-09-25 amendment:
  `Ctrl+S` is now unbound.
- [x] Amendment 2026-09-25: only `Ctrl+X` saves; neither footer hint
  mentions `^S`; typecheck 0 errors and `bun test` 1505 pass / 0 fail.
- [x] The TUI form's footer hints on both the setup screen and the
  Providers screen no longer say "start".
- [x] The browser form's submit path always resolves `"saved"`, never
  `"started"`, and prints the "Run `orchestrai` (no flags)..." message
  instead of "Starting the stack...".
- [x] `InitOutcome`'s `"started"` variant is removed from the type, and
  `dispatch()`'s corresponding branch (the `chdir`/`stdin.resume()`/`main()`
  call) is deleted — verified by `bun run typecheck` reporting 0 errors
  (a lingering reference to the removed variant would be a compile error).
- [x] The classic wizard (`init-wizard.ts`) is unchanged — a diff confirms
  zero lines touched in that file.
- [x] `bun test` passes with no regressions in existing init/form-state
  tests.
- [x] Documentation and worklog are updated (any doc mentioning the
  Ctrl+S "save and start" behavior — check `CLAUDE.md`'s init section
  first, which currently does not name this specific behavior, and
  `context/worklog.md`).

## Verification Plan

- `bun run typecheck` — 0 errors, and specifically confirms no remaining
  reference to `InitOutcome`'s `"started"` variant or `"save-and-start"`
  action anywhere in the codebase (`grep -rn` for both strings as a
  supplementary check, since a type removal alone doesn't prove every
  string literal was cleaned up).
- `bun test` — full suite passes, no regressions.
- **Live terminal check (Windows Terminal, the exact environment the bug
  was found in)**: run the npm-installed or freshly built `orchestrai
  init`, confirm `Ctrl+S` (whatever the approved open decision makes it do)
  never launches anything and never hangs the terminal — either because it
  performs the same safe save as `Ctrl+X`, or because it is inert. Then
  confirm the printed "Run `orchestrai` (no flags)..." message is accurate
  by actually running that command from the saved directory and seeing the
  stack start normally (this last step exercises the *already-verified*
  clean path, not new code, but confirms the removal didn't strand the
  user with no way to start at all).
- `bun run specs:catalog` / `specs:check` — pass.

## Approval Requested

Approval authorizes: removing the same-session "save and start"/`"started"`
outcome from the TUI form, the browser form, and `dispatch()`'s handling of
it, per the "Proposed Behavior" section above, with `Ctrl+S` aliased to the
same save action as `Ctrl+X` (decided 2026-09-24).

Approval does **not** authorize: any change to the classic wizard, to
`main()`'s own TUI-launch behavior for non-init invocations, or any attempt
to diagnose/fix the underlying crash this checkpoint is working around by
removing the feature rather than repairing it.
