# Verification: Suppress Raw Backend Logs Once the Auto-Launched TUI Owns the Terminal

Implemented 2026-09-10. `status: implemented`, `verification: partial` —
the one open item is the live real-terminal pass, which this sandbox
structurally cannot perform (no interactive TTY). See "What's not
verified here" below.

## How this bug was actually found

Not by inspection or a test — by Yusuf running `orchestrai.exe init` in
a real Windows Terminal on 2026-09-09/10 and screenshotting the result.
Two things that screenshot settled immediately, both of which had been
guessed wrong beforehand in this session:

1. **It was never a keyboard/input bug.** The initial report ("hangs,
   can't run anything, Enter and so on") pointed at input handling, and
   the first hypotheses chased stdin/raw-mode handoff between the init
   form and the spawned TUI. The screenshot showed a real, complete
   conversation — a question typed, a genuine multi-step dispatch
   (`analyze-project` → `git-status`), and a correct substantive answer.
   Input worked the whole time.
2. **It was never a stale/orphaned-process problem.** An early check
   found 8 `orchestrai.exe` processes and briefly treated that as the
   cause; reading the port bindings showed it was one coherent, healthy
   stack (supervisor + 6 services + TUI), and `GET /healthz` confirmed
   the backend responding normally.

The real cause was visible in the screenshot itself: raw `=== DevOps
Checks ===` output, audit JSON, and `Dispatched step 2 [git-status] →
devops-agent` bleeding through *underneath* the TUI's own rendered box.

## Root cause

Two independent writers, one terminal, no coordination:

- `spawnService()` pipes every service's stdout/stderr through
  `pipePrefixed()`, whose `write` callback was `(line) => console.log
  (line)` / `console.error(line)` — captured at spawn time, called for
  the entire life of the process. This is the "prefixed logs" feature
  from `specs/016`, correct and necessary for headless runs.
- `specs/062` spawns the TUI as a child with `stdout: "inherit"` — so
  the TUI's screen **is** this process's own stdout.

Nothing gated the first once the second took over. Every real MCP call,
dispatch, and audit event wrote raw text onto a screen the TUI's
raw-mode renderer was simultaneously repainting.

**Not a regression.** Confirmed directly rather than assumed: the binary
Yusuf ran was built 2026-09-07 and never rebuilt since, and already
contained `specs/062`'s change. Yusuf confirmed he had not run this
scenario before ("i didn't test it then"). The bug was latent from the
moment `specs/062` landed and only surfaced when someone finally
dispatched real work through the auto-launched TUI — which is precisely
the gap `specs/062`'s own `verification: partial` record had flagged as
open ("needs Yusuf's own real-terminal session").

## What changed

`apps/supervisor/index.ts` only:

- New module state: `childLogsSuppressed` (default `false`) and
  `supervisorLogPath` (default `null`).
- New `writeChildLog(line, isError)` — the single sink both
  `pipePrefixed()` call sites now use. Suppressed: appends to the log
  file. Not suppressed: the exact `console.log`/`console.error` calls
  that were there before.
- `main()`'s `shouldOpenTui` branch, immediately before spawning the TUI
  child: creates `<project>/.orchestrai/`, truncates a fresh
  `supervisor.log`, prints one line naming that path, then sets
  `childLogsSuppressed = true`. Engaged at exactly one point, with no
  window where a line could still reach the console after the TUI has
  the screen.
- `__setChildLogSuppressionForTests()` — test-only setter, never called
  by startup code.

Deliberate detail: if the log dir/file can't be created,
`supervisorLogPath` stays `null` and suppression never engages —
a corrupted-but-informative screen beats a clean-but-silent one. Covered
by its own test.

## Verification performed

- `bun run typecheck` — 0 errors.
- `bun test` — **839 pass, 0 fail**, 1621 expect() calls across 56 files
  (pre-066 baseline: 831/0/1613/55; the delta is exactly this spec's 8
  new tests). Every pre-existing test passes unmodified.
- New `apps/supervisor/child-log-suppression.test.ts` (8 tests, real
  scratch temp directories, `spyOn(console, ...)` per this repo's own
  existing convention): default-off routes stdout→`console.log` and
  stderr→`console.error` unchanged; suppression-on reaches neither;
  suppression-on writes the real file with correct content and correct
  append ordering across many calls; suppression-on with a null path
  falls back to console rather than discarding; an unwritable path never
  throws.
- `bun run specs:catalog` / `specs:check` — pass, 65 specs.
- `bun run build` — binary rebuilt successfully, 141.0 MB, so the fix is
  actually runnable by Yusuf rather than only present in source.

## What's not verified here

**The live real-terminal pass — the only thing that actually proves the
screen stays clean.** This sandbox has no interactive TTY, so
`shouldOpenTui` is `false` here by construction and the suppression path
cannot execute at all in this environment. What is proven: the gate
behaves correctly in isolation (8 tests), the flag is unreachable for
every non-TUI run (one call site, guarded by `shouldOpenTui`), and the
binary builds.

To close this to `verified`, Yusuf needs to repeat his own scenario with
the rebuilt binary: `dist\bin\orchestrai.exe init` → let the TUI
auto-launch → dispatch a real request ("is my application ok?") → confirm
the screen stays clean throughout, and that
`<project>\.orchestrai\supervisor.log` contains the lines that used to
corrupt it.

## Related record correction

`specs/062-guided-init-tui-as-child-process/spec.md`'s open verification
item ("needs Yusuf's own real-terminal session") is now **answered**:
that session happened, and it found this bug. `specs/062`'s own
mechanism (spawning the TUI as a separate process) is confirmed correct
and unchanged — it is what made this failure a visible rendering problem
rather than the same-process crash it was built to fix.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**Those prefixed logs stop going to the console the moment the
auto-launched TUI takes over the screen**
(`specs/066-supervisor-log-suppression-during-tui/spec.md`, implemented,
**partial** verification). The TUI is spawned with `stdout: "inherit"`
(`specs/062`), so its screen *is* the supervisor's own stdout — and
nothing previously stopped `spawnService()`'s own
`console.log`/`console.error` piping from writing raw lines onto that
exact screen for the rest of the run. Every real MCP call, dispatch, and
audit event corrupted the TUI's rendered box mid-use. Live-caught by
Yusuf on 2026-09-09/10, and worth stating precisely because two
plausible-sounding theories were checked and disproved first: it was
**not** a keyboard/input bug (his screenshot showed a real question, a
real two-step dispatch, and a correct answer — input worked throughout)
and **not** stale/orphaned processes (the 8 running `orchestrai.exe`
processes were one healthy stack, `/healthz` responding normally). It was
also **not a regression** — the binary in question predated the session
and already contained `specs/062`; the bug had been latent since that
spec landed and simply required someone to finally dispatch real work
through the auto-launched TUI, which is exactly what `specs/062`'s own
`verification: partial` note had flagged as never tested. Fixed by
routing both `pipePrefixed()` call sites through one `writeChildLog()`
sink that, once `main()`'s `shouldOpenTui` branch engages it immediately
before spawning the TUI child, appends to
`<project>/.orchestrai/supervisor.log` instead of the console —
redirection, not deletion, so nothing a `--headless` run would have shown
is lost. `--headless`, `bun run dev`, CI, and every non-TTY invocation are
byte-identical to before: the flag is set at exactly one place, guarded
by `shouldOpenTui` (`process.stdout.isTTY && !headless`), unreachable in
all of them. If the log file can't be created, suppression never engages
at all — a corrupted-but-informative screen beats a clean-but-silent one.
The live real-terminal confirmation is the one open item (this sandbox
has no TTY, so the suppression path structurally cannot run here); the
gate itself has 8 focused tests (`apps/supervisor/child-log-suppression.test.ts`).

See specs/108-durable-audit-trail/verification.md for the relocated narrative covering this checkpoint.
