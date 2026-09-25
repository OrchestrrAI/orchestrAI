---
id: 067-supervisor-kill-orphaned-children-on-exit
title: Supervisor — Kill Child Services on Any Parent Exit, Including Window Close
area: runtime-supervision
change_type: fix
status: implemented
verification: partial
created: 2026-09-10
updated: 2026-09-10
approved_by: Yusuf
approved_on: 2026-09-10
implemented_on: 2026-09-10
amends:
  - 016-orchestrai-supervisor
related:
  - 045-supervisor-port-preflight-timeout
  - 062-guided-init-tui-as-child-process
supersedes: []
superseded_by: []
---

# Spec: Supervisor — Kill Child Services on Any Parent Exit, Including Window Close

> Review gate: **APPROVED 2026-09-10 by Yusuf.**
> Written from a real bug Yusuf hit 2026-09-10: after closing every
> terminal, `orchestrai.exe` still refused to start — "Port 3006 already
> in use" — because a previous run's six spawned services were still
> alive, orphaned, holding their ports. `taskkill /F /IM orchestrai.exe`
> was needed to recover.

## Purpose

`apps/supervisor/index.ts` spawns each service as its own child process
(`Bun.spawn`, `resolveSpawnCommand()`), tracked in `children[]`, and
tears them down in `shutdown()` — but `shutdown()` only runs from the
`SIGINT` / `SIGTERM` handlers. Closing a console window on Windows
sends neither: the OS raises `CTRL_CLOSE_EVENT`, the supervisor process
dies, and its children — not job-grouped to it — keep running with no
parent, holding ports 3000/3002–3006 until manually killed.

CLAUDE.md already half-records this: `specs/016`'s "no orphaned
processes after shutdown" is marked verified *by outcome* (a manual
Ctrl+C test plus `netstat`), with an explicit standing caveat that "the
exact shutdown code path was never confirmed." Ctrl+C mostly works;
**window close, a crash, or `kill -9` of the supervisor all leak the
whole stack.**

## Verified Current State

Read 2026-09-10:

- `spawnService()` (`apps/supervisor/index.ts` ~line 412): `Bun.spawn`
  with piped stdout/stderr, no `detached` option, no job-object
  grouping. Each child is an independent OS process.
- `shutdown()` (~line 425): iterates `children[]`, `proc.kill("SIGINT")`,
  then `proc.kill("SIGKILL")` after `SHUTDOWN_GRACE_MS`.
- Handlers (~lines 698–702): only `process.on("SIGINT", ...)` and
  `process.on("SIGTERM", ...)`. No `SIGHUP`, no `process.on("exit")`,
  no `beforeExit`, no Windows `CTRL_CLOSE_EVENT` handling.
- The auto-launched TUI (`specs/062`, ~line 748) is spawned separately,
  `stdio: "inherit"`, deliberately not in `children[]` — it's a
  foreground process the user quits directly. This spec does not change
  that; it's about the background services only.

## Proposed Behavior

1. **A synchronous last-resort child sweep on `process.on("exit")`.**
   Node/Bun's `exit` event fires for (almost) every way the event loop
   ends — a normal return, an uncaught exception, `process.exit()`, and
   after a signal handler runs. Its handler must be synchronous, so it
   can only do `for (const c of children) { try { c.proc.kill("SIGKILL")
   } catch {} }` — no grace period, no await. That's acceptable as the
   backstop: by the time `exit` fires the supervisor is already going
   away, and a hard kill of a leaf HTTP service loses nothing that
   matters (in-memory task state is already gone with the supervisor).
2. **Handle `SIGHUP`** the same way `SIGINT`/`SIGTERM` are handled —
   `shutdown().then(() => process.exit(0))`. On Windows, a console
   close is surfaced to a Node/Bun process as `SIGHUP` in common
   terminal hosts (Windows Terminal, conhost); catching it lets the
   graceful `shutdown()` run before the process dies, rather than
   relying only on the synchronous `exit` backstop.
3. **A Windows job object grouping the children to the supervisor, if
   Bun exposes one cleanly** — the actual robust fix: a job created
   with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, every spawned child
   assigned to it, so the OS itself tears the children down the instant
   the supervisor's handle to the job closes, regardless of *how* the
   supervisor died (crash, `kill -9`, window close, power). **Gated on
   a real check during implementation**: if `Bun.spawn` has no
   supported way to assign a child to a job object on Windows without a
   native addon, this point is dropped and points 1–2 stand alone as
   the best available mitigation — stated plainly in verification,
   never worked around with an unvetted native dependency.
4. **No change to the happy path.** `SIGINT` (Ctrl+C) still runs the
   full graceful `shutdown()` with its grace period exactly as today —
   points 1–2 only add coverage for the paths that currently leak.

## Scope

- `apps/supervisor/index.ts` only: the new `exit` handler, the `SIGHUP`
  handler, and (conditionally) job-object setup in `spawnService()` /
  `main()`.
- No change to `shutdown()`'s own graceful logic, to `spawnService()`'s
  spawn options beyond a possible job assignment, or to the TUI
  auto-launch path.
- No new npm dependency. If the job-object approach needs a native
  addon, it is out of scope (point 3's own gate).

## Safety and Compatibility Constraints

- **The graceful Ctrl+C path is unchanged** — same `shutdown()`, same
  grace period, same two-press behavior with the TUI open
  (`specs/016`'s own documented quirk).
- **The `exit` handler must not throw or block** — every `kill()` is
  wrapped, a child that already exited is a no-op.
- **`bun run dev` is unaffected** — it does not use this file's
  supervisor path at all (`bun run --parallel`, its own process group
  behavior).
- No behavior change on Linux/macOS beyond the `exit`/`SIGHUP`
  belt-and-braces, which are harmless there (SIGINT/SIGTERM already
  covered the common cases).

## Out of Scope / Non-Goals

- The auto-launched TUI's own lifecycle (`specs/062`) — a foreground
  process the user quits directly, already correct.
- `bun run dev`'s process supervision.
- A cross-platform process-group abstraction — this fix is Windows-
  console-close-shaped, with the `exit` handler as the portable
  backstop.
- Recovering or persisting in-memory task state across the leaked
  processes (that's a separate persistence concern, no spec yet).

## Acceptance Criteria

- [ ] Start `orchestrai.exe` (real stack), then **close the terminal
      window** (not Ctrl+C). Afterward, `netstat -ano | findstr :300`
      shows none of 3000/3002–3006 still `LISTENING`, and
      `tasklist /FI "IMAGENAME eq orchestrai.exe"` shows no leftover
      processes — proven live, in a real terminal.
- [ ] `kill -9` (or Task Manager "End task") of the *supervisor*
      process alone still results in the children being gone within a
      few seconds (job object) or immediately on the next event-loop
      turn (`exit` backstop) — whichever the implementation lands on,
      stated honestly.
- [x] Ctrl+C still runs the full graceful `shutdown()` — the startup
      summary's own shutdown lines behave exactly as documented in
      `specs/016`, no regression.
- [x] `bun test` (855 pass, 0 fail), `bun run typecheck` (0 errors), `bun run specs:check` (68 specs) pass.
- [x] `CLAUDE.md` (the `specs/016` "no orphaned processes" claim and its
      standing caveat) and `context/worklog.md` updated.

## Verification Plan

- A focused test that the `exit` handler calls `kill` on each tracked
  child (fake child objects, assert `kill` invoked) — the portable part
  is unit-testable.
- A live real-terminal pass for the window-close and supervisor-kill
  scenarios — the only way this class of bug is actually confirmed
  fixed, matching every prior supervisor/TUI checkpoint's own standard.
- If the job-object path is taken: a note on exactly which Bun API was
  used and whether it required anything beyond the standard SDK.

## Approval Requested

**Approved 2026-09-10 by Yusuf.** Implementation proceeds (069 phase by phase).

