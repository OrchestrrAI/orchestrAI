---
id: 062-guided-init-tui-as-child-process
title: Guided Init — Spawn the Auto-Launched TUI as a Separate Process
area: supervisor
change_type: fix
status: implemented
verification: partial
created: 2026-09-06
updated: 2026-09-06
approved_by: Yusuf
approved_on: 2026-09-06
implemented_on: 2026-09-06
amends:
  - 048-guided-init-experience
supersedes: []
superseded_by: []
related:
  - 012-tui-interactive
  - 016-orchestrai-supervisor
  - 017-standalone-binary-distribution
  - 047-tui-conversation-operations-navigation
---

# Spec: Guided Init — Spawn the Auto-Launched TUI as a Separate Process

> Review gate: **APPROVED 2026-09-06 by Yusuf.** This amends
> `specs/048-guided-init-experience/spec.md`, whose own "Out of Scope" and
> "Approval Requested" sections explicitly excluded any change to `main()`'s
> startup sequence or TUI auto-open rule — that approval did not cover this
> spec; this one does, scoped exactly to what's stated in "Approval
> Requested" below.

## Purpose

Close spec 048's one open finding, recorded in its own verification.md:
`orchestrai init` → `^S` in a real terminal starts all six services, reports
every one healthy, then crashes the entire process (backend included) about a
second later while creating a second `CliRenderer`. Isolated to an
application-free repro containing none of this repo's own code — this is an
upstream `@opentui/react` limitation (creating, using, and destroying one
`CliRenderer`/React root, then creating a second one in the same process),
not a bug in OrchestrAI's own logic. Yusuf chose the workaround over waiting
on upstream or defaulting `^S` to headless: spawn the auto-launched TUI as
its own child process instead of importing and calling `start()` in-process.

## Verified Current State

Read directly from `apps/supervisor/index.ts` on 2026-09-06.

- `main()`'s `shouldOpenTui` block (near the end of `main()`) does exactly
  this today:
  ```ts
  if (shouldOpenTui) {
    console.log("[supervisor] Opening terminal viewer...")
    await (await import("../tui/index")).start()
  }
  await Promise.all(children.map((c) => c.proc.exited))
  ```
  `start()` calls `createCliRenderer()`/mounts the React root **in this same
  process** — the second renderer in a process that, via the guided-init form
  (spec 048), may have already created and destroyed one for the setup
  screen itself.
- Every other service this supervisor starts already runs as its own child
  process via `spawnService()`/`resolveSpawnCommand()`:
  ```ts
  function resolveSpawnCommand(def: ServiceDef): string[] {
    if (isCompiled) return [process.execPath, "service", def.name]
    return [process.execPath, "run", path.join(REPO_ROOT, def.scriptRelPath)]
  }
  function spawnService(def: ServiceDef): RunningChild {
    const proc = Bun.spawn(resolveSpawnCommand(def), {
      cwd: isCompiled ? undefined : REPO_ROOT,
      stdout: "pipe", stderr: "pipe", env: process.env,
    })
    ...
  }
  ```
  Backend services intentionally pipe their stdout/stderr for prefixed
  logging — that shape is wrong for the TUI, which needs the real terminal
  (raw keyboard input, full-screen rendering), not a prefixed log line.
- `dispatch()` already handles a bare `tui` subcommand identically in both
  modes: `await (await import("../tui/index")).start()`, so `orchestrai tui`
  (dev) / the compiled binary's `tui` subcommand is already the exact,
  already-shipped, already-verified entry point a separate process needs to
  invoke — no new command surface is being added.
- `apps/tui/index.tsx`'s own quit path is what currently ends `start()`'s
  renderer and returns control to `main()`'s `shouldOpenTui` block, which
  then falls through to `await Promise.all(children.map(...))` — the
  backend keeps running until the existing `SIGINT`/`SIGTERM` handlers'
  `shutdown()` runs. This spec does not change that end state, only how the
  viewer itself is launched.

## Proposed Behavior

Replace the direct in-process call with a spawned child that inherits the
real terminal, and wait for it to exit before falling through to the
existing "stay alive while children run" wait:

```ts
if (shouldOpenTui) {
  console.log("[supervisor] Opening terminal viewer... (Ctrl+C exits the viewer; press it again to stop the backend services)")
  const tuiCommand = isCompiled
    ? [process.execPath, "tui"]
    : [process.execPath, "run", path.join(REPO_ROOT, "apps/tui/index.tsx")]
  const tuiProc = Bun.spawn(tuiCommand, {
    cwd: isCompiled ? undefined : REPO_ROOT,
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
    env: process.env,
  })
  await tuiProc.exited
}
await Promise.all(children.map((c) => c.proc.exited))
```

- **`stdio: "inherit"` on all three streams**, not `"pipe"` — this is the
  one load-bearing difference from `spawnService()`. The TUI needs the real
  keyboard/screen, not a piped/prefixed log line; every other service
  needs the opposite. No prefixed-logging wrapper (`pipePrefixed()`) applies
  to this child.
- **`env: process.env`** — identical to `spawnService()`, so the TUI child
  sees the exact same resolved `ORCHESTRAI_*` variables `main()` already
  computed for its own backend children (nothing new to compute or pass).
- **Not added to the `children` array.** `children` drives `shutdown()`'s
  own `SIGINT`-then-grace-then-`SIGKILL` sweep of backend services; the TUI
  child is a foreground, terminal-owning process the user already controls
  directly (its own Ctrl+C), not a background service to be swept. Two
  separate variables track it (`let tuiProc`), used only to await its exit.
- **No change to `shouldOpenTui`'s own gating** (`process.stdout.isTTY &&
  !headless`) — unaffected by this spec.
- **No change to `dispatch()`'s existing `tui` subcommand** — this reuses
  it as-is via the identical resolved command a self-spawned backend
  service already uses, just for a different target.

## Safety Constraints

- No change to any backend service's spawn shape, `shutdown()`, port
  preflight, or health gating — this touches only the `shouldOpenTui`
  branch inside `main()`.
- No change to `apps/tui/index.tsx` itself, its own quit/keyboard handling,
  or the specs/047 workspace.
- No change to spec 048's own form, masked-key handoff, or written config
  contract — this fixes only what happens *after* `^S` writes the config
  and calls `main()`.
- If the spawned TUI process fails to start at all (e.g. the resolved
  script path is wrong), the failure must be visible (a normal Bun spawn
  error surfaces to the console) rather than silently swallowed — matching
  today's behavior where a crash was at least visible, just later and more
  destructively.

## Out of Scope

- Any change to what services start, in what order, or how they're health-
  gated.
- Any change to the classic (non-TTY) `init` wizard path.
- Fixing the underlying `@opentui/react` double-renderer limitation itself
  — this works around it structurally (a fresh process always has zero
  prior renderers) rather than resolving it upstream.
- A `--only tui`-style flag or any other new CLI surface — `orchestrai tui`
  already exists and is reused unchanged.

## Acceptance Criteria

- [ ] Yusuf explicitly approves this spec before implementation.
- [ ] `orchestrai init` → `^S` in a real terminal starts all selected
      services, then opens the workspace TUI in the same window with no
      crash — confirmed by Yusuf directly (the one class of check this
      repo's own PTY harness cannot substitute for, per specs/047/048's own
      precedent).
- [ ] Quitting the TUI (its existing keyboard quit) returns control cleanly;
      a second Ctrl+C (or the TUI's own quit) still stops the backend via
      the existing `shutdown()` path, matching today's documented two-step
      behavior — no orphaned processes, confirmed via `Get-CimInstance`/
      `netstat` the same way specs/016/045 already established.
- [ ] `orchestrai` (no `init`, plain zero-flag startup with `shouldOpenTui`
      true) is unaffected in dev mode and in the compiled binary — same
      auto-launch behavior as before, just via a spawned process instead of
      an in-process call.
- [ ] `--headless` and non-TTY startups are byte-identical to before (they
      never enter the `shouldOpenTui` branch at all).
- [ ] `bun test`, `bun run typecheck`, `bun run specs:check` pass; the
      compiled binary is rebuilt and the same real-terminal check above is
      re-run against it, not just dev mode.

## Verification Plan

- **PTY harness**: confirm the spawned command resolves correctly in dev
  mode (drive `bun run orchestrai`/`orchestrai init` under `node-pty`,
  assert a real child process appears and the parent's own log line prints
  before the child's TUI frame). The harness cannot itself prove the crash
  is gone — real terminal-rendering nesting is exactly what it cannot
  faithfully reproduce (specs/048's own honest caveat) — so this is
  necessary but not sufficient evidence.
- **Real terminal (Yusuf's, not substitutable)**: the actual repro from
  spec 048's finding — `orchestrai init` → fill the form → `^S` → confirm
  the stack starts, the TUI opens, and nothing crashes. Then confirm the
  existing two-step quit (viewer, then backend) still works exactly as
  documented today.
- **No-orphan check**: after a launched-then-quit run, confirm every port
  is free and no child process remains, the same check specs/016/045 used.

## Approval Requested

Approval authorizes only: spawning the auto-launched TUI as a separate
child process (inherited stdio, reusing the existing `orchestrai tui`
entry point) in place of the current in-process `start()` call inside
`main()`'s `shouldOpenTui` branch. It does not authorize any other change
to `main()`, to `apps/tui/index.tsx`, or to spec 048's own form/config
contract.
