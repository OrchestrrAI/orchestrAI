---
id: 074-fix-exit-backstop-argument-bug
title: Fix the Supervisor's exit Backstop — killAllChildrenSync Never Actually Ran
area: supervisor
change_type: fix
status: implemented
verification: verified
created: 2026-09-11
updated: 2026-09-11
approved_by: Yusuf
approved_on: 2026-09-11
implemented_on: 2026-09-11
amends:
  - 067-supervisor-kill-orphaned-children-on-exit
related:
  - 073-configurable-service-ports
supersedes: []
superseded_by: []
---

# Spec: Fix the Supervisor's exit Backstop — killAllChildrenSync Never Actually Ran

> **Approved 2026-09-11 by Yusuf** ("ok sure make it and apply"), after
> walking through the root cause. Found live while verifying
> `specs/073-configurable-service-ports/spec.md` (a forced `timeout`-kill
> of the supervisor threw this exact error) and confirmed unrelated to
> that spec by reproducing it identically with no port override set at
> all.

## Purpose

`specs/067-supervisor-kill-orphaned-children-on-exit/spec.md` added a
synchronous `process.on("exit")` backstop specifically so an uncaught
throw or a `kill -9` of the supervisor itself wouldn't leave devops-
agent/testing-agent/etc. running and holding ports open. Since the day
that spec landed, the backstop has thrown immediately on every single
invocation instead of killing anything — the safety net it was written
to provide has never actually worked.

## Verified Current State

`apps/supervisor/index.ts`:

```ts
export function killAllChildrenSync(list: readonly Pick<RunningChild, "proc">[] = children): void {
  for (const c of list) {
    try { c.proc.kill("SIGKILL") } catch { /* already exited */ }
  }
}
...
process.on("exit", killAllChildrenSync)
```

Node/Bun's `"exit"` event always invokes its listener with the process's
numeric exit code as the first argument — `listener(code)`. Passing
`killAllChildrenSync` directly as that listener means it is actually
called as `killAllChildrenSync(0)` (or whatever the real code is), never
with zero arguments. A parameter default (`list: ... = children`) only
applies when the caller passes `undefined` for that slot; a real number
like `0` overrides it. So `list` becomes the exit code — a plain
number — and `for (const c of list)` throws
`TypeError: number is not iterable` before ever reaching a single
`c.proc.kill()` call.

**Live-reproduced twice**, both via the same forced `timeout`-triggered
SIGTERM against a real running supervisor process, once with a custom
`ORCHESTRAI_SECURITY_PORT` set and once with no port override at all —
identical crash, identical line, identical message both times, confirming
this is unconditional (every exit hits it) and unrelated to
`specs/073`.

## Proposed Behavior

Wrap the listener so Node's exit-code argument never reaches
`killAllChildrenSync`'s own `list` parameter — as an exported, named
function (`runExitBackstop`) rather than an inline arrow, so the fix
itself is directly unit-testable by simulating Node's real call shape,
not just re-testing `killAllChildrenSync`'s already-correct
explicit-list behavior:

```ts
export function runExitBackstop(_exitCode?: number): void {
  killAllChildrenSync()
}
...
process.on("exit", runExitBackstop)
```

`killAllChildrenSync` itself is unchanged — its own default parameter
(`= children`) was always correct; the bug is entirely in how it was
registered as a listener, not in the function's own logic. Its exported
signature (used directly, with an explicit list, by
`apps/supervisor/kill-children.test.ts`) stays exactly as is.

## Scope

- `apps/supervisor/index.ts`: a new exported `runExitBackstop()`
  function, and the `process.on("exit", ...)` registration switched to
  it.
- `apps/supervisor/kill-children.test.ts`: a new `describe` block
  exercising `runExitBackstop` directly with Node's real call shape (an
  explicit numeric argument) — `killAllChildrenSync`'s own existing
  explicit-list tests are unchanged, since they never exercised this bug
  in the first place.

## Safety and Compatibility Constraints

- **No behavior change for the two paths that already worked.** The
  graceful `shutdown()` path (SIGINT/SIGTERM/SIGHUP) is completely
  unaffected — it calls `children` directly, never through this
  function. Any test or code path that calls `killAllChildrenSync(list)`
  with an explicit list is unaffected — only the zero-argument,
  `"exit"`-triggered call changes from "always crashes" to "does what it
  was always documented to do."
- **This is a pure bugfix restoring already-documented, already-approved
  intent** (`specs/067`'s own stated purpose) — not a new capability, not
  a behavior change beyond "the thing that was supposed to happen now
  happens."

## Out of Scope / Non-Goals

- Any other exit-handling path (SIGINT/SIGTERM/SIGHUP's own `shutdown()`
  is untouched).
- A Windows job object or any more robust process-group mechanism —
  `specs/067` already evaluated and declined that (no supported way to
  do it in Bun 1.3.14 without a native addon) and this spec doesn't
  revisit that decision.

## Acceptance Criteria

- [x] `process.on("exit", ...)` no longer passes Node's exit-code
      argument through to `killAllChildrenSync`'s `list` parameter.
- [x] A real forced-kill of the supervisor (the same `timeout`-triggered
      SIGTERM that reproduced the bug) no longer throws
      `TypeError: number is not iterable`.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan / Results

- **Unit test** (`kill-children.test.ts`, new `describe("runExitBackstop
  — specs/074")` block): calling `runExitBackstop(0)` and
  `runExitBackstop(1)` — Node's real call shape — no longer throws.
  `bun test`: 898 pass (net +1), 0 fail. `bun run typecheck`: 0 errors.
  `bun run specs:catalog`/`specs:check`: pass, 74 specs.
- **Live re-run of the exact repro**: `timeout 8 bun run
  apps/supervisor/index.ts --only security-agent --project
  <scratch-dir>` (the identical command that threw
  `TypeError: number is not iterable` before this fix) — completed with
  no crash, no stack trace, just the normal startup summary followed by
  a clean forced exit.
- **Confirmed the backstop now genuinely kills the child, not just that
  the supervisor no longer crashes**: after that run exited,
  `tasklist /FI "IMAGENAME eq bun.exe"` showed zero matching processes
  and `netstat -ano | grep ":3005"` showed nothing listening —
  security-agent was actually gone, not merely unreachable to a
  crashed supervisor.

## Approval Requested

**Approved 2026-09-11 by Yusuf.** Implemented and verified the same day.
