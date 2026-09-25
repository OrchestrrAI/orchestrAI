---
id: 017-standalone-binary-distribution
title: Standalone Binary Distribution — One Combined Executable
area: distribution
change_type: feature
status: implemented
verification: verified
created: 2026-08-09
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-09
implemented_on: 2026-08-09
amends: []
supersedes: []
superseded_by: []
related:
  - 019-cicd-recreate-and-binary-builds
  - 016-orchestrai-supervisor
  - 018-supervisor-project-path
---

# Spec: Standalone Binary Distribution — One Combined Executable

> Status: **APPROVED and IMPLEMENTED on 2026-08-09. A real, load-bearing
> bug was found and fixed during implementation (not just during the
> initial spike) — see Verification Results.**

## Purpose

Following the approved `specs/016-orchestrai-supervisor/spec.md`, Yusuf asked for the
originally-envisioned single-command, no-Bun-required UX from
`context/history.md`'s "Single Entry Point CLI" discussion:

```text
cd C:\Users\ahmed\my-app
orchestrai
```

An initial draft of this spec proposed compiling **8 separate binaries**
(one per service + the supervisor) via `bun build --compile`. A spike
proved that approach works functionally, but also surfaced a real cost:
**each compiled binary is ~98 MB** (Bun embeds its full runtime into every
one), so 8 separate binaries would total **~780 MB**. Yusuf flagged this as
a problem. This revision replaces that design with **one single combined
executable** containing every service, dispatched by a subcommand — the
~98 MB Bun-runtime cost is paid once, not eight times.

## Verified Current Behavior (spikes performed before writing this spec)

- `bun build --compile` works end-to-end on this machine: compiled
  `packages/agents/security/index.ts` alone, ran the resulting `.exe`
  directly (no `bun run`), confirmed a genuinely fresh process via
  `/healthz`, and confirmed full functionality with a real end-to-end
  secret scan (not just an HTTP shell). Also confirmed the ~98 MB size
  directly (`ls -la` on the output).
- Two mechanisms for detecting "am I running inside a compiled standalone
  executable" were tested directly, not assumed:
  - Bun's internal virtual path (`import.meta.path`/`Bun.main` resolve to
    something like `B:\~BUN\root\...` in compiled mode on Windows, vs. a
    real file path in dev mode) — **works, but undocumented/internal**,
    risks breaking on a future Bun version. **Rejected** for that reason.
  - `bun build --define KEY=VALUE` — a documented, stable, public Bun
    feature for exactly this kind of build-time flag — confirmed directly:
    a script referencing `typeof ORCHESTRAI_COMPILED !== "undefined"`
    correctly evaluates `false` in `bun run` (dev mode, no `--define`
    passed) and `true` when compiled with `--define
    ORCHESTRAI_COMPILED='"true"'`. **This is the mechanism used below.**
- Current per-service startup code, checked in every service file:
  `apps/orchestrator/index.ts` and `packages/agents/planning/index.ts`
  already guard their `serve()` call with `if (import.meta.main)`.
  `packages/agents/devops/index.ts`, `testing/index.ts`,
  `documentation/index.ts`, `security/index.ts`, and `packages/mcp/http.ts`
  currently call `serve()`/`Bun.serve()` **unconditionally at module top
  level** — importing any of these five today, for any reason, immediately
  starts an HTTP server on that service's hardcoded port. This must change
  for a combined binary to be able to `import()` a service module without
  every service starting at once.

## Proposed Behavior

### 1. Make every service's startup explicit and callable

For the five currently-unguarded files (DevOps, Testing, Documentation,
Security, MCP HTTP server), extract the server-starting code into an
exported `start()` function and guard direct execution exactly like
Orchestrator/Planning already do:

```ts
export function start() {
  // ...existing serve({ fetch: app.fetch, port: PORT }) and startup logs...
}

if (import.meta.main) {
  start()
}
```

This is a mechanical refactor with **no behavior change** for existing
`bun run <service>` usage — `import.meta.main` is `true` exactly when the
file is run directly, so today's dev-mode startup is untouched. It only
adds the ability for something else to `import` the module and call
`start()` explicitly without an automatic side effect on import.
Orchestrator and Planning already have the guard; they additionally need
an exported `start()` (currently the guarded block calls `serve()` inline,
not through a named function) for consistency with the dispatcher below.

### 2. One dispatcher entry, compiled to one binary

`apps/supervisor/index.ts` (already the `bun run orchestrai` entry) gains
subcommand dispatch, checked before its existing supervisor logic:

```ts
const SERVICE_STARTERS: Record<string, () => Promise<void> | void> = {
  "planning-agent": async () => (await import("../../packages/agents/planning/index")).start(),
  "devops-agent": async () => (await import("../../packages/agents/devops/index")).start(),
  "testing-agent": async () => (await import("../../packages/agents/testing/index")).start(),
  "documentation-agent": async () => (await import("../../packages/agents/documentation/index")).start(),
  "security-agent": async () => (await import("../../packages/agents/security/index")).start(),
  "mcp:http": async () => (await import("../../packages/mcp/http")).start(),
  "orchestrator": async () => (await import("../orchestrator/index")).start(),
}

if (process.argv[2] === "service" && process.argv[3]) {
  const starter = SERVICE_STARTERS[process.argv[3]]
  if (!starter) { console.error(`Unknown service: ${process.argv[3]}`); process.exit(1) }
  await starter()
} else if (process.argv[2] === "tui") {
  await (await import("../tui/index")).start()
} else {
  await main() // existing supervisor logic — port preflight, ordered startup, etc.
}
```

`bun build --compile` bundles everything statically reachable — every
`SERVICE_STARTERS` entry ends up embedded in the one output binary — but
only the branch actually selected at runtime executes, so running
`orchestrai service devops-agent` starts only DevOps, not all seven.

### 3. Supervisor self-spawns instead of shelling to `bun run`, only when compiled

```ts
declare const ORCHESTRAI_COMPILED: string | undefined
const isCompiled = typeof ORCHESTRAI_COMPILED !== "undefined"

function resolveSpawnCommand(def: ServiceDef): string[] {
  if (isCompiled) return [process.execPath, "service", def.name]
  return [process.execPath, "run", path.join(REPO_ROOT, def.scriptRelPath)]
}
```

- **Dev mode** (`bun run apps/supervisor/index.ts`, no `--define` passed):
  `isCompiled` is `false`, so this is **byte-for-byte the same spawn
  behavior `specs/016-orchestrai-supervisor/spec.md` already shipped and verified** —
  zero regression risk to the already-working path.
- **Compiled mode**: the supervisor re-invokes **itself** (`process.execPath`
  now points at the one compiled binary) with `service <name>`, which hits
  the dispatcher above and starts exactly that one service, in a separate
  OS process (still real process isolation — a crash in one service still
  can't take down another, same as today).

### 4. TUI folded into the same binary

`orchestrai tui` runs `apps/tui/index.tsx`'s logic (needs the same
`export function start()` / `if (import.meta.main)` treatment). This means
**one single file** covers the entire product: all 5 agents, the MCP HTTP
server, the Orchestrator, the supervisor, and the TUI.

### 5. Build script

`scripts/build-binary.ts` (new; singular now, not `build-binaries.ts`):

```
bun build --compile --define ORCHESTRAI_COMPILED='"true"' --target=bun-<host-platform>-<host-arch> apps/supervisor/index.ts --outfile dist/bin/orchestrai[.exe]
```

One `bun build` invocation, one output file. Prints the resulting size and
the exact command to run it.

### End-to-end UX

```bash
bun run build              # once, on a machine with Bun + this source
# copy dist/bin/orchestrai[.exe] anywhere, alone — nothing else needed
./orchestrai                        # starts everything (self-spawns 7 children)
./orchestrai service security-agent # just one service, for debugging
./orchestrai tui                    # the terminal viewer
./orchestrai --help
```

One file, roughly **~100-150 MB** (one Bun runtime + all application code
combined — small relative to the runtime itself), not ~780 MB.

## Safety Constraints

- No new runtime capability, endpoint, or trust boundary — compiling
  changes *how* the code is packaged and started, not what it does.
  Verified by the spike: identical `/healthz` shape, identical scan output
  between `bun run` and compiled execution.
- The `export function start()` refactor is mechanical and preserves
  existing `if (import.meta.main)` semantics exactly — `bun run
  packages/agents/devops/index.ts` (or any other individual service)
  continues to work completely unchanged; this is purely additive.
- `resolveSpawnCommand()`'s dev-mode branch is untouched from the already-
  verified `specs/016-orchestrai-supervisor/spec.md` behavior — the new compiled-mode
  branch only activates when `ORCHESTRAI_COMPILED` was actually set by the
  build script, never accidentally in a normal `bun run` invocation.
- Each spawned service (whether via `bun run <script>` or `orchestrai
  service <name>`) remains a genuinely separate OS process — combining
  into one binary changes packaging, not process isolation. A crash in one
  service still cannot take down another.
- `.gitignore` gets `dist/` added — the compiled binary is build output,
  never committed.

## In Scope

1. `packages/agents/devops/index.ts`, `testing/index.ts`,
   `documentation/index.ts`, `security/index.ts`, `packages/mcp/http.ts` —
   extract `start()`, add the `if (import.meta.main)` guard.
2. `apps/orchestrator/index.ts`, `packages/agents/planning/index.ts` —
   extract their already-guarded inline logic into an equivalent named
   `start()` for dispatcher consistency (no behavior change).
3. `apps/tui/index.tsx` — same `start()`/guard treatment.
4. `apps/supervisor/index.ts` — subcommand dispatch (`service <name>`,
   `tui`), `resolveSpawnCommand()`'s compiled/dev branch.
5. `scripts/build-binary.ts` — the build script.
6. `package.json`: new `"build"` script.
7. `.gitignore`: exclude `dist/`.
8. `README.md`/`CLAUDE.md`: document `bun run build` and the resulting
   single `dist/bin/orchestrai[.exe]`.
9. Verification: build the one binary, run it standalone, confirm all 7
   services come up healthy, a real task completes end-to-end, `orchestrai
   service <name>` works for at least one service in isolation, `orchestrai
   tui` connects correctly, and dev-mode (`bun run orchestrai`, `bun run
   <any-service>`) is provably unaffected.

## Out of Scope / Non-Goals

- **Cross-compilation matrix** — host platform only this pass, same as the
  prior draft; `--target` is confirmed available for later extension.
- **Installer, PATH registration, code signing, Windows icon/metadata.**
- **Compiling the stdio MCP server** — stays excluded, consistent with
  `specs/016-orchestrai-supervisor/spec.md`.
- **CI-produced release artifacts** — local `bun run build` only; not
  wired into `.github/workflows/ci.yml` (left alone per prior instruction).
- **Further shrinking below Bun's inherent ~98-150 MB runtime floor** — not
  achievable from this repo's code; this spec's whole purpose is avoiding
  *multiplying* that floor, not eliminating it.

## Acceptance Criteria

- [x] Yusuf approves this spec.
- [x] `bun run build` produces exactly one working executable at
      `dist/bin/orchestrai[.exe]`.
- [x] Running it with no arguments starts all 6 non-Orchestrator services
      (self-spawned as `orchestrai service <name>` child processes) gated
      on real health, then the Orchestrator last — same ordering guarantee
      as the existing supervisor.
- [x] `orchestrai service <name>` runs exactly that one service.
- [x] `orchestrai tui` runs the terminal viewer.
- [x] A real task submitted through the compiled stack completes
      end-to-end with correct output.
- [x] `bun run orchestrai` and `bun run <any-service>` (dev mode) are
      **provably unaffected** — confirmed by running them after this
      change and comparing against pre-change behavior.
- [x] Clean shutdown of the compiled binary leaves no orphaned processes.
- [x] `bun test` and `bun run typecheck` remain fully green.
- [x] `.gitignore` updated; `dist/` never committed (was already excluded).
- [x] The resulting binary's size is reported and is meaningfully smaller
      than the ~780 MB the original 8-binary design would have produced.

## Verification Results (2026-08-09)

### A real bug found and fixed during implementation

The refactor (extracting `start()`, adding `import.meta.main` guards across
5 files, wiring the dispatcher) went cleanly — `bun test` (114 pass) and
`bunx tsc --noEmit` (0 errors) stayed green throughout, and dev-mode
(`bun run orchestrai`, `bun run <any-service>`) was confirmed unaffected at
each step. But the **first actual run of the compiled binary standalone**
failed immediately:

```
[supervisor] Fatal error: ...
ENOENT: no such file or directory, uv_spawn 'C:\Users\moham\devops-mcp-server\dist\bin\orchestrai.exe'
```

— on a path that plainly existed (it was the binary that was already
running). Root-caused through a systematic series of isolated spikes
rather than guessing:

1. Confirmed a *small* compiled binary can spawn a copy of itself fine
   (rules out "compiled binaries can't self-spawn" as a category).
2. Confirmed a binary padded to the *same size* (~98 MB) as the real one
   still self-spawns fine (rules out size).
3. Confirmed two independently-launched instances of the real binary
   coexist fine (rules out "two instances of this binary can't run at
   once").
4. Compared every `Bun.spawn()` option between a working spike and the
   real code — found the one real difference: the real supervisor computes
   `REPO_ROOT` via `path.join(import.meta.dir, "..", "..")` and passes it
   as `cwd`. Spiked `import.meta.dir` directly inside a compiled binary:
   it resolves to Bun's **internal virtual path** for the embedded bundle
   (`B:\~BUN\root` on Windows), not a real directory. `path.join(that,
   "..", "..")` produces `B:\` — confirmed via `existsSync` to not exist on
   the real filesystem. Passing a nonexistent `cwd` to `Bun.spawn()` broke
   the spawn entirely, surfacing as a misleading ENOENT on the *target
   executable* rather than a clearer "bad working directory" error.

**Fix**: `cwd` is now conditional — `isCompiled ? undefined : REPO_ROOT`.
In compiled mode there's no script path to resolve relative to anyway (the
dispatcher uses dynamic `import()` of bundled modules, not real file
paths), so omitting `cwd` lets `Bun.spawn()` inherit the parent's actual,
real working directory instead. Dev mode is completely unaffected — it
still receives the correct, real `REPO_ROOT`.

This is recorded in detail because it's exactly the kind of bug that would
have been invisible without a "does this actually work" verification step
— every unit test, typecheck, and dev-mode check passed throughout; only
running the real compiled artifact caught it.

### Full verification

- `bun run build`: produces `dist/bin/orchestrai.exe`, **106.4 MB** (vs.
  the ~780 MB the original 8-separate-binary design would have produced —
  confirmed as the direct improvement this redesign targeted).
- `./dist/bin/orchestrai.exe` (no args): started `mcp:http` + 5 agents,
  each correctly self-spawned as `orchestrai.exe service <name>`
  (confirmed via `Get-CimInstance Win32_Process` listing all 8 processes —
  1 supervisor + 7 children, each with the right argument), gated on real
  health, then the Orchestrator last, which correctly discovered all 5
  agents.
- Submitted a real `git-status` task through the compiled stack —
  completed with correct output.
- `orchestrai.exe service security-agent` in isolation: ran a real secret
  scan end-to-end, identical output to dev mode.
- `orchestrai.exe --help`: prints usage, exits 0.
- `orchestrai.exe tui`: connected to the running compiled stack and
  rendered correctly (confirmed via captured output containing "OrchestrAI
  — Terminal Viewer").
- Shutdown: sent SIGINT via `Bun`'s own `process.kill()` to the top-level
  compiled supervisor process — confirmed **zero** `orchestrai.exe`
  processes remained afterward (all 8), and all 7 ports released. Same
  caveat as `specs/016-orchestrai-supervisor/spec.md`: the graceful shutdown log line
  wasn't captured in this non-interactive test, so the *exact* code path
  (graceful vs. OS-level teardown) isn't fully distinguishable from this
  sandboxed shell — the *outcome* (no orphans) is solid.
- `bun run orchestrai` and `bun run security-agent` (dev mode): re-verified
  working identically after the `cwd` fix, both before and after the fix
  was applied.
- `bun test`: 114 pass, 0 fail throughout. `bunx tsc --noEmit`: 0 errors
  throughout.
- `.gitignore` already excluded `dist` — no change needed.

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/017-standalone-binary-distribution/spec.md as written.
```

or list specific changes needed.
