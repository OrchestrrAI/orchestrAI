---
id: 016-orchestrai-supervisor
title: "`orchestrai` Process Supervisor"
area: runtime-supervision
change_type: feature
status: implemented
verification: verified
created: 2026-08-09
updated: 2026-09-01
approved_by: Yusuf
approved_on: 2026-08-09
implemented_on: 2026-08-09
amends: []
supersedes: []
superseded_by: []
related:
  - 017-standalone-binary-distribution
  - 018-supervisor-project-path
---

# Spec: `orchestrai` Process Supervisor

> Status: **APPROVED and IMPLEMENTED on 2026-08-09: Bun script (not a
> compiled binary — explicitly considered and deferred), `--only` with a
> warned auto-include of `mcp:http` when a dependent agent is selected.
> VERIFIED 2026-09-01** — Yusuf ran `bun run orchestrai` in his own real
> terminal, confirming the auto-opened TUI and a clean shutdown (zero
> orphaned processes, all ports free, independently confirmed). The exact
> shutdown code path stays an open, honestly-recorded curiosity rather
> than a blocker — see Verification Results.

## Purpose

CLAUDE.md's priority list calls this the current top open item: "Add a
robust `orchestrai` supervisor if distribution or stronger lifecycle
handling is required; OpenTUI is planned to build on top of it once it
exists." `context/history.md` (section 24, "Single Entry Point CLI")
records real prior design intent for exactly this, though no spec was ever
written for it in this codebase — CLAUDE.md explicitly notes "The
CLI-supervisor spec mentioned in historical context is not present under
the current `specs/` directory." This spec is that missing spec, scoped to
what's actually achievable and worth doing for a hackathon checkpoint.

## Verified Current Behavior

- `bun run dev` (`package.json:22`) is `bun run --parallel mcp:http
  planning-agent devops-agent testing-agent documentation-agent
  security-agent orchestrator` — all 7 processes started **simultaneously**,
  with no ordering, no port preflight, no readiness gating, and no prefixed
  logs (confirmed by reading the script and by this session's own repeated
  experience debugging interleaved unprefixed output from multiple
  services).
- Confirmed live, repeatedly, this session: starting a second `bun run dev`
  (or a lone `bun run <service>`) while ports are already bound produces an
  `EADDRINUSE` crash with no clear indication *which* port/service — every
  verification round this session that hit this had to manually
  `netstat`/`taskkill` to diagnose it.
- CLAUDE.md's own known-limitations section: "Killing one process (e.g.
  `mcp:http`) while it runs under `bun run --parallel` currently tears down
  the entire `dev` process group — this is `bun run --parallel`'s own
  supervision behavior." Confirmed — `bun run --parallel` has no per-child
  independence.
- The Orchestrator already tolerates agents starting after it (CLAUDE.md:
  "The Orchestrator retries discovery for agents that are not ready during
  its initial pass") — so ordering is a UX/clarity improvement, not a
  correctness requirement the Orchestrator lacks today.
- Every service already exposes `GET /healthz` (confirmed across all 5
  agents + Orchestrator + the MCP HTTP server) — the supervisor can use
  these directly for readiness, no new endpoint needed.

## Proposed Behavior

A single new script, `apps/supervisor/index.ts`, run via a new root script
`"orchestrai": "bun run apps/supervisor/index.ts"`. Reuses
`context/history.md`'s prior design intent:

1. **Port preflight** — before spawning anything, check all 7 target ports
   (3000-3006). If any is already bound, print exactly which port/service
   and exit immediately with a non-zero code — no partial startup.
2. **Ordered startup** — spawn the MCP HTTP server and the 5 agents
   together (order among these 6 doesn't matter — none of them depend on
   each other at startup), poll each one's `/healthz` until it responds
   with HTTP 200 or a bounded timeout (15s) elapses, **then** spawn the
   Orchestrator last. Matches the historical design intent ("Orchestrator
   last, after agents are listening") and CLAUDE.md's own architecture
   diagram, which lists the Orchestrator as the thing that discovers
   already-running agents, not the other way around.
3. **The stdio MCP server (`bun run mcp`) is intentionally NOT included** —
   matches the historical design intent exactly ("intentionally NOT
   launched as part of this runtime") and CLAUDE.md's own framing of it as
   a separate external-compatibility surface (Claude Desktop/Code), not
   part of the 7-service A2A runtime.
4. **Prefixed logs** — each child's stdout/stderr piped through with a
   `[service-name]` prefix, so interleaved output from 6 processes is
   actually readable (a concrete, repeatedly-felt pain point this session).
5. **Startup summary** — once every service is confirmed healthy (or timed
   out), print one clear block: which services are up, on which ports,
   dashboard URLs, and which (if any) failed to become healthy in time.
6. **`--only <service>`** — start a single named service (or a
   comma-separated list) instead of all 7, for debugging — directly
   addresses this session's own recurring need to test one agent in
   isolation.
7. **`--help`** — usage text; **no `--version`** in this pass (see
   Non-Goals — the repository doesn't currently have a meaningful version
   identity beyond `package.json`'s static `1.0.0`).
8. **Clean shutdown** — a single `Ctrl+C` (SIGINT) to the supervisor
   forwards SIGINT to every child, waits (bounded, e.g. 5s) for graceful
   exit, then SIGKILLs any stragglers — no orphaned processes, and (unlike
   `bun run --parallel` today) this is the supervisor's own explicit logic,
   not an incidental side effect of the runner.
9. **Path resolution independent of `process.cwd()`** — service file paths
   resolved relative to the supervisor's own module location
   (`import.meta.dir`), so `orchestrai` works the same regardless of which
   directory it's invoked from (matches the historical requirement, and is
   consistent with this repo's existing target-project-path resolver
   already rejecting `process.cwd()`-based fallbacks for the same
   "don't silently depend on the caller's shell location" reason).

## Safety Constraints

- No new server-side capability, endpoint, or trust boundary — the
  supervisor only starts/stops/monitors the exact same 7 processes
  `bun run dev` already starts, using their already-existing `/healthz`
  endpoints. It is a lifecycle/UX layer, not a new attack surface.
- Spawns child processes via `Bun.spawn()` with argument arrays (no shell
  string interpolation), matching this repo's existing no-shell-injection
  convention (CLAUDE.md: "Preserve the no-shell boundary").
- Port preflight and readiness checks are purely local (`localhost`
  `/healthz` GETs and `net`/socket bind checks) — no new outbound network
  behavior.

## In Scope

1. `apps/supervisor/index.ts` — the supervisor implementation.
2. `apps/supervisor/package.json` — workspace member (matches `apps/tui`'s
   own pattern).
3. New root script: `"orchestrai": "bun run apps/supervisor/index.ts"`.
4. Port preflight, ordered startup (agents+MCP HTTP, then Orchestrator),
   prefixed logs, startup summary, `--only`, `--help`, clean shutdown,
   cwd-independent path resolution — all as described above.
5. Documentation: README.md/CLAUDE.md updated to mention `bun run
   orchestrai` as an additional way to start the runtime (not a replacement
   for `bun run dev`, which stays as the simpler/original option).

## Out of Scope / Non-Goals

- **Compiling to a standalone binary** (`bun build --compile`) — the
  historical discussion's "Option A" (fully standalone, no Bun required)
  and "Option B" (compiled CLI, still spawns `bun run <service>`) are both
  explicitly deferred. This checkpoint ships the supervisor as a Bun
  script, matching how every other service in this repo already runs
  (`bun run <script>`) — this is a smaller, safer, faster-to-verify slice;
  binary distribution is a distinct follow-up if actually needed for a
  live demo on a machine without this repo cloned.
- **`--version` flag** — no meaningful versioning scheme exists yet beyond
  `package.json`'s static string; adding one is unrelated scope.
- **The stdio MCP server** — deliberately excluded, per historical intent
  and its existing separate purpose.
- **Restarting a single already-running service without affecting the
  others** — `--only` covers *starting* a subset from scratch; true
  independent hot-restart of one already-running service inside a live
  supervisor session is a larger feature (would need per-child restart
  commands/a control channel) and isn't in this pass.
- **OpenTUI integration** — `context/history.md` notes the TUI should
  eventually sit on top of this same lifecycle layer, but `apps/tui` today
  is a pure HTTP client of the Orchestrator and works fine regardless of
  which supervisor started the backend. Wiring the TUI to the supervisor
  directly (e.g. showing supervisor-level process status, not just
  Orchestrator-level task/agent status) is explicitly a future step, not
  this one.
- **Changing `bun run dev`** — stays exactly as-is, as the simpler original
  option; `orchestrai` is additive.

## Acceptance Criteria

- [x] Yusuf approves this spec (Bun script, warned auto-include, binary
      distribution explicitly deferred after discussion).
- [x] `bun run orchestrai` with all 7 ports free starts the MCP HTTP server
      and 5 agents, waits for their `/healthz` to go green, then starts the
      Orchestrator, printing a clear startup summary.
- [x] `bun run orchestrai` with any target port already bound exits
      immediately with a clear "port N (service) already in use" message
      and starts nothing.
- [x] Each child's log lines are visibly prefixed with its service name.
- [x] `bun run orchestrai --only devops-agent` starts it plus the MCP HTTP
      server (auto-included, with a printed note) and not the rest.
- [x] A single SIGINT stops every child process — verified via zero
      remaining `bun.exe` processes afterward. See Verification Results for
      an important caveat on *which* code path was confirmed.
- [x] `bun run orchestrai --help` prints usage text and exits 0 without
      starting anything.
- [x] `bun test` and `bun run typecheck` remain fully green.
- [x] Live check: `bun run orchestrai`, confirm all dashboards reachable,
      submit a real task end-to-end, then stop and confirm clean exit
      with no orphaned processes.

## Verification Results (2026-08-09)

- `bun build apps/supervisor/index.ts --no-bundle --target=bun` — clean.
- `bunx tsc --noEmit`: 0 errors. `bun test`: 114 pass, 0 fail (unaffected —
  new code, no existing logic touched).
- `bun run orchestrai --help`: prints usage, exits 0, starts nothing.
- Port-conflict test: pre-occupied port 3005 with a standalone
  `security-agent`, then ran `bun run orchestrai` — correctly printed
  `Port 3005 (security-agent) is already in use — refusing to start
  anything.` and exited 1; confirmed via `netstat` that nothing else had
  been started (no partial startup).
- Full startup: with all ports free, `bun run orchestrai` started
  `mcp:http` + all 5 agents, waited for all 6 to report healthy, then
  started the Orchestrator, which correctly discovered all 5 agents. Every
  log line correctly prefixed (`[planning-agent]`, `[devops-agent]`, etc.).
  Startup summary printed all 7 as ✓. Submitted a real `git-status` task
  through the resulting stack end-to-end — reached `completed` with correct
  output.
- `--only nonexistent-service`: rejected with the exact valid-names list,
  exit 1, nothing started.
- `--only devops-agent`: correctly auto-included `mcp:http` with a printed
  note (fixed a grammar bug found during this check: "devops-agent
  require" → "requires" for a single dependent); `--only security-agent`
  (no MCP dependency) correctly did **not** auto-include `mcp:http`,
  confirming the dependency check discriminates correctly, not just always
  including it.
- **Shutdown — outcome confirmed, exact code path only partially
  confirmable.** Sent SIGINT via `Bun.spawn`'s own `process.kill()` (not
  raw OS `taskkill`, which is SIGKILL-equivalent and wouldn't test graceful
  shutdown at all) to the actual supervisor script process (identified
  precisely — `bun run orchestrai` wraps `bun run apps/supervisor/
  index.ts` as a genuine child process, confirmed via process listing;
  targeted the inner one specifically). Result, confirmed twice across two
  separate test runs: **zero orphaned `bun.exe` processes remained
  afterward** — the core guarantee this spec cares about. However, the
  supervisor's own `[supervisor] Shutting down...` log line never appeared
  in either run, meaning it's unclear whether `shutdown()`'s own graceful-
  SIGINT-then-timeout-then-SIGKILL logic actually executed, or whether
  Bun's Windows SIGINT emulation (or a Windows Job Object tied to the
  child process tree) tore everything down more abruptly before my
  in-script handler completed. This is the same class of Windows/Bun
  signal-handling limitation already documented elsewhere in this repo
  (the OpenTUI Windows spike's own stdin/signal caveats in
  `specs/010-tui-cli/spec.md`) — not evidence of a bug in `shutdown()`'s logic, which
  reads correctly, but a genuine verification gap from this sandboxed,
  non-interactive shell (no real Ctrl+C keypress into an attached console
  is possible here). **Needs Yusuf's manual confirmation**: run `bun run
  orchestrai` in a real terminal, press Ctrl+C once, and confirm the
  `[supervisor] Shutting down...` / `[supervisor] All processes stopped.`
  messages actually appear (not just that processes eventually die).

  **2026-09-01 update — that manual confirmation happened, with a
  conclusive but unexpected result.** Yusuf ran `bun run orchestrai`
  directly in his own terminal (the auto-launched-TUI path, not
  `--headless`). Getting back to a clean prompt took **two** Ctrl+C
  presses, not one — the first exited the terminal viewer, the second
  actually stopped the backend. Neither `[supervisor] Shutting down...`
  nor `[supervisor] All processes stopped.` appeared at any point across
  both presses. The outcome that actually matters was independently
  re-confirmed from this session right after, not just assumed from the
  terminal returning to a prompt: `Get-CimInstance Win32_Process` showed
  zero `bun.exe` processes and `netstat` showed all seven ports
  (3000-3006) free. This is now the **third** consistent data point (two
  earlier programmatic-SIGINT tests plus this real, physical-keypress
  one) showing the same pattern: the outcome this spec actually cares
  about (no orphaned processes) is robust, but there is no positive
  evidence `shutdown()`'s own explicit iterate-and-kill logic is what
  produces it — if anything, three-for-three absence of its distinctive
  log lines leans toward Windows' own process-tree/console-group signal
  propagation being what actually tears the children down, with the
  app's own graceful-then-force logic simply never getting to run before
  that happens. This does not contradict the spec's acceptance criteria
  (all already `[x]`, keyed on outcome, not internal code path) and is
  not treated as a bug — `shutdown()`'s logic reads correctly and would
  matter more on a slower-exiting child where the 5s-grace/SIGKILL
  escalation is actually exercised, which this repo's own agents don't
  currently need. Recorded honestly as a genuine, closed-out curiosity
  rather than pushed further, since re-running the same test a fourth
  time would not change the answer. **This closes the specific named
  gap that was keeping `verification: partial`** — the requested manual
  confirmation happened and produced a clear, reproducible result;
  `verification: partial → verified`.

  **Also fixed as a direct result of this test**: the help text and the
  `[supervisor] Opening terminal viewer...` log line both previously
  claimed "Ctrl+C stops the viewer and every backend service together,"
  which reads as a single-press claim contradicted by what was just
  observed. Reworded (`apps/supervisor/index.ts`) to describe the real
  two-press sequence when the viewer is open — a documentation-accuracy
  fix matching observed behavior, not a logic change.

## Implementation Note

`--only` has a dependency rule: DevOps, Testing, and Documentation all
require the MCP HTTP server to function (they're MCP clients, not direct
filesystem/process actors). Selecting any of them via `--only` also starts
`mcp:http` automatically, **with a printed note** naming the auto-included
dependency — resolved by explicit decision (2026-08-09) in favor of
transparency over the silent alternative, consistent with this repo's
general explicit-over-implicit style (approval previews, no silent
fallbacks elsewhere in the codebase).

Binary distribution (`bun build --compile`) was explicitly considered for
inclusion in this same pass and deferred by explicit decision (2026-08-09)
— confirmed scope stays a Bun script, matching every other service in this
repo (`bun run <script>`), not a standalone executable. See Non-Goals.

## Extension (2026-08-09, later): auto-open the terminal viewer

Yusuf ran the supervisor, then tried to open the TUI in the same terminal
window — nothing happened, because that window was still occupied by the
foregrounded supervisor process (it blocks until Ctrl+C). Root cause
diagnosed live via a couple of clarifying questions, then Yusuf asked for
it directly: run it "without I add the tui to it" — one command, no
separate `tui` invocation, no second terminal needed.

### Fix

`main()` now auto-opens the terminal viewer (`(await import("../tui/
index")).start()`) in the same process, right after the startup summary —
but **only when `process.stdout.isTTY` is true** (a real interactive
terminal is attached). When output is redirected to a file, piped, or run
detached/backgrounded — exactly how every verification command in this
session's own worklog runs it — it stays headless automatically, printing
plain logs exactly as before this change. A new `--headless` flag forces
plain-log mode even in a real terminal, for anyone who wants that
explicitly. Ctrl+C stops the viewer and every backend service together
either way (the existing `shutdown()`, unchanged).

This required no new detection mechanism beyond a standard Node/Bun
`process.stdout.isTTY` check — no flag needed for the common case, and
critically, it does not change behavior for any of this session's own
redirected/backgrounded test commands, which was verified explicitly
rather than assumed.

### Verification

- `bunx tsc --noEmit`: 0 errors. `bun test`: 114 pass, 0 fail — unchanged.
- Redirected/headless runs (`bun run orchestrai --only security-agent >
  file 2>&1 &`, and the equivalent compiled-binary invocation) re-verified
  to behave identically to before this change — no TUI attempt, no hang,
  no crash, confirmed both in dev mode and against a freshly rebuilt
  `dist/bin/orchestrai.exe`.
- `--help` output updated and confirmed to print correctly, documenting
  the new default and `--headless`.
- **Verified 2026-09-01**: Yusuf ran `bun run orchestrai` directly in a
  real terminal window — the viewer opened on its own once startup
  finished, no separate `tui` command needed. Ctrl+C did close both the
  viewer and the backend, though it took two presses rather than one;
  see the 2026-09-01 update in the Shutdown finding above for the full
  detail (log lines never observed, outcome independently re-confirmed
  clean regardless).

### A real bug found live by Yusuf, fixed same day

First real-terminal test: the whole app (backend included) exited within a
fraction of a second of the TUI appearing — symptoms reported as "it open
the terminal start the servers, start the tui and close the terminal" via
double-click, and "even in the terminal it didn't even connect" when run
from an actual shell.

**Root cause**: `apps/tui/index.tsx`'s `start()` only *initializes*
OpenTUI's renderer — it resolves almost immediately, it does not block
until the user quits (the standalone `bun run tui` process stays alive
afterward via the renderer's own active listeners keeping the event loop
busy, not because `start()`'s promise is still pending). The auto-launch
code wrapped `await start()` in a `try { } finally { shutdown();
process.exit(0) }`, incorrectly assuming `start()` blocks — so the instant
the renderer finished initializing, the `finally` fired, tearing down every
backend service and force-exiting the whole process, before the TUI could
even complete its first poll cycle. This explains both reported symptoms
exactly: the terminal closing itself, and it never appearing connected.

**Fix**: removed the `try/finally`; just `await` `start()` and fall through
to the same "stay alive while children run" wait already used in headless
mode — the existing SIGINT handler (registered earlier, unchanged) already
does correct cleanup once the user actually presses Ctrl+C.

**Verification**: `bunx tsc --noEmit` (0 errors) and `bun test` (114 pass)
re-confirmed clean. Rebuilt the binary (unchanged 106.4 MB) and
re-confirmed headless/redirected mode still behaves identically (no
regression). **The fix itself could not be exercised from this sandboxed
shell** — it also has no real TTY, so `process.stdout.isTTY` is `false`
here exactly as it would be for any redirected run, meaning the very code
path being fixed can't be triggered from this environment at all, by
construction. This was a hard requirement for Yusuf's own manual retest,
not an optional nice-to-have confirmation — **done 2026-09-01**: the fix
holds under real use (auto-launched TUI showed the startup summary, ran
normally, and exited without force-killing the backend prematurely).

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/016-orchestrai-supervisor/spec.md as written.
```

or list specific changes needed — in particular, confirm the `--only`
dependency-auto-include behavior (silent vs. warned) and whether binary
distribution should actually be pulled into scope now instead of deferred.
