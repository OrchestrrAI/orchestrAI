# Verification: Supervisor — Kill Child Services on Any Parent Exit

Implemented 2026-09-10. `status: implemented`, `verification: partial` —
the portable backstop is unit-tested and typecheck-clean; the two live
scenarios (window close, supervisor kill -9) need a real terminal, and
the Windows job-object option was checked and not taken.

## What changed

`apps/supervisor/index.ts` only:
- `killAllChildrenSync(list = children)` — a synchronous sweep that
  `proc.kill("SIGKILL")`s every tracked child, each wrapped so an
  already-exited child never throws or blocks the rest. Exported for
  its test.
- `process.on("exit", killAllChildrenSync)` — the last-resort backstop
  for every exit path a signal handler doesn't catch (uncaught throw,
  `kill -9` of the supervisor, a console close the host didn't map to a
  signal).
- `process.on("SIGHUP", ...)` and `process.on("SIGBREAK", ...)` — both
  run the same graceful `shutdown().then(exit)` as SIGINT/SIGTERM. On
  Windows, a console-window close is delivered to a Node/Bun process as
  SIGHUP by Windows Terminal / conhost; Ctrl+Break is SIGBREAK.

## The job-object option (point 3) — checked, not taken

`Bun.spawn` (Bun 1.3.14) exposes no supported way to assign a spawned
child to a Windows job object without a native addon, and this spec's
own Scope explicitly rules out adding one. So point 3 is dropped;
points 1–2 (SIGHUP/SIGBREAK graceful + the synchronous `exit` backstop)
are the mitigation. Honest limitation: an instant, un-catchable kill of
the supervisor (a true `TerminateProcess` with no window-message
delivery) can still, in principle, leave children for the fraction of a
turn before nothing sweeps them — but every *ordinary* way a user ends
the process (close the window, Ctrl+C, Ctrl+Break, Task Manager "End
task", a crash) now runs one of the handlers.

## Verification performed

- New `apps/supervisor/kill-children.test.ts` (3 tests): every child in
  the list gets `kill("SIGKILL")`; a child whose `kill()` throws doesn't
  stop the sweep or propagate; an empty list is a no-op.
- `bun run typecheck` — 0 errors.
- `bun test` — 855 pass, 0 fail (852 + this spec's 3).
- `bun run specs:catalog`/`specs:check` — 68 specs.
- Binary rebuilt.

## What's not verified here

The two live scenarios — start `orchestrai.exe`, **close the terminal
window**, then confirm via `netstat`/`tasklist` that no service ports
are still `LISTENING` and no `orchestrai.exe` remains; and the same
after a `kill -9` of just the supervisor. This sandbox has no
interactive console session to close, so these need Yusuf's own
terminal — the same standard every prior supervisor checkpoint carries.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

  **Correction, 2026-09-10 (`specs/067-supervisor-kill-orphaned-children-
  on-exit/spec.md`, implemented, partial verification):** "zero orphaned
  processes" held only for Ctrl+C. Yusuf hit the gap directly —
  `orchestrai.exe` refused to start ("Port 3006 already in use") because
  a previous run's six services were still alive after he'd **closed the
  terminal window**, which raises `CTRL_CLOSE_EVENT`, not SIGINT/SIGTERM,
  so `shutdown()` never ran. Fixed: `apps/supervisor/index.ts` now also
  handles `SIGHUP`/`SIGBREAK` (a Windows console close is delivered as
  SIGHUP by Windows Terminal / conhost) with the same graceful
  `shutdown()`, plus a synchronous `process.on("exit")` backstop
  (`killAllChildrenSync()`) that hard-kills every tracked child for the
  paths a signal handler can't catch (uncaught throw, `kill -9` of the
  supervisor). A Windows job object — the fully robust answer — was
  checked and not taken: Bun 1.3.14's `spawn` has no supported way to
  assign a child to one without a native addon. The window-close and
  supervisor-kill scenarios themselves still need Yusuf's own terminal
  to confirm; the synchronous sweep has unit coverage
  (`apps/supervisor/kill-children.test.ts`).
