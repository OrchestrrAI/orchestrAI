## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

  **Correction, 2026-09-11 (`specs/074-fix-exit-backstop-argument-bug/
  spec.md`, implemented, verified):** that synchronous backstop had
  never actually worked, on any exit, since the day it was written.
  `process.on("exit", killAllChildrenSync)` passed the function directly
  as the listener — but Node/Bun always invokes an `"exit"` listener
  with the process's real numeric exit code (`listener(code)`), which
  landed in `killAllChildrenSync`'s own `list` parameter and silently
  overrode its `= children` default, since a default only applies to a
  genuinely `undefined` argument, not a real `0`. `list` became a plain
  number, and `for (const c of list)` threw `TypeError: number is not
  iterable` before ever reaching a single `c.proc.kill()` call — found
  live while verifying `specs/073` (a forced `timeout`-kill of the
  supervisor threw this exact error) and confirmed unconditional, not
  specific to that spec, by reproducing it identically with no port
  override set at all. Fixed by registering a new, exported
  `runExitBackstop()` wrapper instead — its own parameter absorbs and
  discards whatever Node passes, so `killAllChildrenSync()` is always
  actually called with zero arguments. Live-reconfirmed with the
  identical repro command: no crash, and — the decisive check —
  `tasklist`/`netstat` afterward showed the orphaned security-agent
  process and its port both genuinely gone, not just that the supervisor
  stopped crashing.
