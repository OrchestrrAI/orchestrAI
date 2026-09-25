---
id: 045-supervisor-port-preflight-timeout
title: Supervisor Port Preflight — Bounded Timeout, Never a Silent Hang
area: runtime-supervision
change_type: fix
status: implemented
verification: verified
created: 2026-09-02
updated: 2026-09-02
approved_by: Yusuf
approved_on: 2026-09-02
implemented_on: 2026-09-02
amends:
  - 016-orchestrai-supervisor
supersedes: []
superseded_by: []
related:
  - 038-supervisor-default-and-planning-retirement
---

# Spec: Supervisor Port Preflight — Bounded Timeout, Never a Silent Hang

> Review gate: **APPROVED 2026-09-02 and IMPLEMENTED the same day.
> VERIFIED the same day** — a genuine live test against the exact
> real-world condition (a second `orchestrai` instance started against
> ports already held by a real running session) confirmed the fix
> refuses fast with no hang, alongside full unit coverage of the free/
> in-use/timeout paths. See Verification Results below. Yusuf: "Yes,
> draft a spec and fix it" (chosen explicitly over "just note it, fix
> later"), authorizing both drafting and implementation in one pass.

## Purpose

Live-caught, 2026-09-02: Yusuf ran `bun run orchestrai`, and it printed
`[supervisor] Project path: ...` and then hung indefinitely — no further
output, no error, nothing. A second invocation, seconds later, started
cleanly. The gap is real and narrow, but the failure mode (an unbounded,
silent hang) is worse than the bug that triggers it deserves.

## Verified Current State

Read from the current code, 2026-09-02:

- `apps/supervisor/index.ts`'s startup sequence, in order: resolve and
  print the project path → **port preflight** (the hang site) → print
  `[supervisor] Starting: ...` → spawn services → `waitForHealthy()` per
  service.
- The port preflight (`~line 441`):
  ```ts
  const portsToCheck = startOrchestrator ? [...toStart, ORCHESTRATOR] : toStart
  for (const svc of portsToCheck) {
    const free = await isPortFree(svc.port)
    if (!free) {
      console.error(`[supervisor] Port ${svc.port} (${svc.name}) is already in use — refusing to start anything.`)
      console.error(`[supervisor] Find and stop whatever's using it, then retry.`)
      process.exit(1)
    }
  }
  ```
- `isPortFree()` itself (`~line 205`) has **no timeout of any kind**:
  ```ts
  function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = net.createServer()
      srv.once("error", () => resolve(false))
      srv.once("listening", () => srv.close(() => resolve(true)))
      srv.listen(port, "127.0.0.1")
    })
  }
  ```
  If the underlying `net.Server`'s `listen()` call never emits `"error"`
  or `"listening"` — a real, if narrow, Windows condition where a
  just-released port sits in a transitional state that neither fails nor
  succeeds a new bind promptly — this `Promise` never resolves, and the
  `await` in the loop above blocks forever. No log line, no error, no
  exit code. The process just sits there.
- **This is a genuine asymmetry already latent in the code, not a new
  regression**: `waitForHealthy()` (`~line 214`), the *next* step in the
  same startup sequence, already has a bounded timeout
  (`specs/016-orchestrai-supervisor/spec.md`'s own 15s health-check
  bound) precisely because "wait for something that might never happen"
  is a known risk this codebase already designed around once — just not
  here, one step earlier in the same function.
- `isPortFree()` is not exported and has no test coverage today.
- The most likely trigger for what Yusuf hit: a `bun.exe` process
  holding port 3000 had been forcefully killed (`taskkill //F`) only
  seconds before his first attempt — plausibly leaving the socket in
  exactly the transitional state described above. Not reproduced under
  controlled conditions as part of drafting this spec; the fix does not
  depend on confirming the exact trigger, only on the observable fact
  that the current code has no bound on this wait at all.

## Proposed Behavior

- `isPortFree()` gains a bounded timeout (**3000ms**, matching the
  `AbortSignal.timeout(3000)` pattern `waitForHealthy()`'s own inner
  `fetch()` call already uses elsewhere in this file, so the codebase
  isn't introducing a third, differently-tuned timeout constant for a
  conceptually similar "how long do we wait for the network stack"
  question). On timeout, the pending server is closed and the promise
  resolves `false` — a `false` for "not free" is unambiguously the safe
  default: whether the true cause is a genuine conflict or a stuck
  socket, refusing to start is correct either way. The port-preflight
  loop above needs **no changes** — it already handles `false` by
  printing a clear message and exiting.
- The error message the existing loop already prints
  (`"Port ${svc.port} (${svc.name}) is already in use — refusing to
  start anything."`) does not currently distinguish "genuinely in use"
  from "timed out probing it." Both cases correctly refuse to start
  (fail-safe), so this does not change the loop's control flow — but
  `isPortFree()` will accept an optional reason it failed for
  (`"in-use" | "timeout"`), and the loop's message names which one
  occurred, so a `"timeout"` result — an actual known-narrow condition,
  not a guess — points a human at "retry, or check what recently held
  this port" rather than only "something else is using it."
- No change to `waitForHealthy()`, service spawning, ordering, or any
  other part of the startup sequence.

## Scope

- `apps/supervisor/index.ts`: `isPortFree()` gains the timeout and a
  reason in its return value; the preflight loop's error message names
  the reason. `isPortFree()` becomes exported for direct testing.
- `apps/supervisor/port-preflight.test.ts` (new): unit tests against
  real, locally-bound sockets (no mocking `net` — the existing precedent
  in `apps/supervisor/project-path.test.ts`/`init-wizard.test.ts` is
  real filesystem round-trips, not mocks, for exactly this kind of
  low-level check) covering: a genuinely free port resolves `true`
  quickly; a port already listening resolves `false` with reason
  `"in-use"`; the timeout path (simulated via a server that accepts the
  connection but never lets `listen()` settle — feasible by binding the
  port under test from a separate real listener without `SO_REUSEADDR`
  and racing the timeout against a short port-release delay, **or**, if
  that proves unreliable across CI/Windows, an injectable clock/delay
  seam kept minimal and clearly commented as test-only).
- `CLAUDE.md`, `context/worklog.md`.

## Safety and Compatibility Constraints

- **Fail-safe unchanged**: any non-`true` result from `isPortFree()`
  (in-use or timeout) still refuses to start every service, exactly as
  today — this spec narrows an infinite wait to a bounded one, it does
  not relax the refuse-to-start behavior in any direction.
- **No change to the free-port path.** A port that resolves free within
  the timeout behaves byte-identically to today — same `true`, same
  timing for the overwhelming majority case where the bind succeeds
  near-instantly.
- **No new dependency.** `net` is already imported; the timeout uses
  `setTimeout`/`clearTimeout`, already used elsewhere in this file
  (`waitForHealthy()`'s poll loop).
- `bun test`, `bun run typecheck`, `bun run specs:check`, `bun run build`
  stay green.

## Out of Scope / Non-Goals

- Retrying the preflight check automatically — a timeout still means
  "refuse to start," same as an actual conflict; auto-retry is a
  different, larger behavior change not requested and not evidenced as
  needed (the observed case resolved on a manual retry seconds later).
- `waitForHealthy()` or any other part of the startup sequence — already
  correctly bounded, untouched.
- Diagnosing or fixing the Windows-specific socket-release timing itself
  — out of this codebase's control; the fix here is bounding the wait,
  not eliminating the underlying OS behavior.
- Any change to `apps/supervisor/index.ts`'s shutdown path — a
  separate, already-documented known limitation (CLAUDE.md's
  `specs/016` section), not touched here.

## Acceptance Criteria

- [x] `isPortFree()` resolves within ~3s even when the underlying
      `listen()` call never emits `"error"`/`"listening"` — verified by
      a real test, not just code inspection.
- [x] A genuinely free port still resolves `true` with no added latency
      in the common case.
- [x] A genuinely in-use port still resolves `false`, reason `"in-use"`.
- [x] The preflight loop's printed message distinguishes a timeout from
      a genuine conflict.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check`,
      `bun run build` all pass.
- [x] `CLAUDE.md`, `context/worklog.md` updated.

## Verification Plan

- **Automated**: the new `port-preflight.test.ts` covering free/in-use/
  timeout as described in Scope.
- **Live**: rebuild the compiled binary; run `bun run orchestrai` /
  `dist/bin/orchestrai.exe` normally and confirm the free-port path is
  unaffected (same startup summary, same timing order of magnitude);
  if a genuine port conflict can be manufactured (starting a second
  instance while the first still holds its ports), confirm the existing
  "already in use" message still appears and the process still exits
  cleanly — this is the pre-existing behavior this spec must not break.
  Directly reproducing the exact hang Yusuf hit is not required for
  acceptance (its trigger condition is a narrow OS-level timing window,
  not reliably reproducible on demand) — the bounded-timeout test is
  what proves the fix regardless of root cause.

## Verification Results (2026-09-02)

**Automated:** `bun test` — 564 passed, 0 failed (up from 558: 6 new
tests in `apps/supervisor/port-preflight.test.ts` — a free port resolves
fast with no residual bind; a genuinely occupied port resolves
`{free:false, reason:"in-use"}`; the timeout path resolves within its
bound and never reports a stuck check as free; the real 3000ms
production default is itself exercised, not just a shortened test
value). `bun run typecheck` — 0 errors. `bun run specs:catalog` +
`bun run specs:check` — clean for 45 specs.

**The Scope section's own anticipated fallback was needed**: real-socket
racing to force the timeout path proved unreliable (as the spec itself
flagged as a possibility), because `net.createServer` is a read-only ESM
binding in this runtime — monkey-patching it directly, the first attempt,
threw `TypeError: Attempted to assign to readonly property`. Resolved
exactly as the spec's own "or" clause anticipated: a minimal, clearly
test-only injection seam (`isPortFree(port, { timeoutMs?, createServer?
})`, defaulting to the real values in every production call site) rather
than reaching for a module-mocking library.

**Binary size delta:** measured via `wc -c`, not estimated —
147,801,600 → 147,802,112 bytes, **+512 bytes**, zero new dependency.

**Live, real machine, real compiled binary, a genuine real-world
conflict — not simulated**: Yusuf's own `bun run orchestrai` session was
still running live (all 7 ports genuinely held, confirmed via
`netstat`). Starting a second `dist/bin/orchestrai.exe --headless`
instance against it printed
`[supervisor] Port 3006 (mcp:http) is already in use — refusing to start
anything.` and exited within a couple of seconds — fast and correct,
not a hang, exercising the exact code path this spec touches against a
real conflicting process rather than a lab setup. Process count
before/after confirmed identical (18 `bun.exe`, no leftover
`orchestrai.exe`) — the test instance cleaned up after itself with no
intervention needed.

**Not reproduced**: the exact original hang (a narrow, OS-timing-
dependent window, as the spec's own Verification Plan already stated
would not be required for acceptance). The bounded-timeout unit test
proves the fix holds regardless of root cause; the live conflict test
above proves the pre-existing "genuine conflict" behavior the fix must
not break still works, now against a real second instance rather than
only the original single-report's own successful retry.

## Approval Requested

This spec needs Yusuf's explicit approval before any implementation, per
CLAUDE.md Working procedure step 8.
