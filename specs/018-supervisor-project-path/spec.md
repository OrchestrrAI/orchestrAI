---
id: 018-supervisor-project-path
title: Convenient Project-Path Configuration for the Supervisor/Binary
area: runtime-supervision
change_type: enhancement
status: implemented
verification: verified
created: 2026-08-09
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-09
implemented_on: 2026-08-09
amends:
  - 016-orchestrai-supervisor
  - 017-standalone-binary-distribution
supersedes: []
superseded_by: []
related:
  - 004-configurable-project-paths
  - 016-orchestrai-supervisor
  - 017-standalone-binary-distribution
---

# Spec: Convenient Project-Path Configuration for the Supervisor/Binary

> Status: **APPROVED ("Approved as written") and IMPLEMENTED on 2026-08-09.
> See Verification Results below.**

## Purpose

Yusuf asked: "if i run the exe file how it will know the path" — i.e. the
target project the agents should analyze/modify. Today, setting
`ORCHESTRAI_PROJECT_PATH` requires either a terminal environment variable
(easy for `bun run dev`, awkward for a double-clicked `.exe`) or typing a
full absolute path into every task. This spec adds three more convenient
sources, layered on top of — not replacing — the existing policy.

## Verified Current Behavior

- `packages/shared/index.ts`'s `resolveTargetPath()` (used directly by
  DevOps, Testing, Documentation, Security) resolution order is: (1) an
  explicit absolute path in the task text, (2) `ORCHESTRAI_PROJECT_PATH`
  from that agent's own process environment, (3) a clear validation error.
  **No `process.cwd()` fallback exists here, by explicit, documented
  design** (CLAUDE.md: "There is intentionally no `process.cwd()` target
  fallback... Relative paths are rejected"). This spec does **not** touch
  this file or that policy — an individual `bun run devops-agent`
  invocation's behavior stays exactly as-is.
- Each agent reads `ORCHESTRAI_PROJECT_PATH` from **its own** process
  environment — confirmed via `packages/shared/index.ts:52`
  (`env.ORCHESTRAI_PROJECT_PATH`). The supervisor already spawns every
  child via `Bun.spawn(cmd, { env: process.env, ... })`
  (`apps/supervisor/index.ts`) — children inherit whatever's in the
  supervisor's own environment at spawn time.
- This means the supervisor can add new convenience sources **entirely on
  its own side**, by computing an effective path and setting it into the
  `env` object it hands to each child before spawning — zero changes
  needed to the shared resolver or any individual agent file, and zero
  change to what happens if someone runs an agent script directly without
  going through the supervisor at all.

## Proposed Behavior

New resolution order, used **only by the supervisor** (`apps/supervisor/
index.ts`) to decide what `ORCHESTRAI_PROJECT_PATH` to inject into its
children's environment, checked in this order — first match wins:

1. **`--project <path>`** command-line flag on the supervisor itself
   (works identically in `bun run orchestrai --project "C:\my-app"` and
   `orchestrai.exe --project "C:\my-app"`).
2. **`ORCHESTRAI_PROJECT_PATH` already set** in the inherited environment
   — respected as-is, unchanged (so anyone already setting it keeps
   working exactly as today; the supervisor never overrides an explicit
   env var the user already set).
3. **A config file next to the running binary** — `orchestrai.project.txt`
   containing a single line, the absolute path. Only checked in compiled
   mode (`isCompiled`) — in dev mode there's no meaningful "next to the
   binary" location (that would be inside `node_modules/.bin` or similar),
   so this source is skipped there, falling through to the next one.
4. **`process.cwd()`** — wherever the supervisor was actually invoked
   from. This directly matches the originally-envisioned UX in
   `context/history.md`'s "Single Entry Point CLI" discussion (`cd
   C:\Users\ahmed\my-app && orchestrai`) — cwd here is a deliberate signal
   (the user chose to run this specific command from this specific
   folder), unlike the ambiguous-nested-dev-script case the existing
   resolver's "no cwd fallback" policy was written to avoid.
5. **Nothing resolved**: inject nothing. Each agent falls through to its
   own existing, unchanged behavior — a per-task explicit path still
   works, and a task with no path still gets the same clear validation
   error as today. This preserves the existing safety property (never
   silently guesses at the wrong directory without *some* affirmative
   signal from one of the four sources above).

The supervisor prints which source won and the resolved path at startup
(e.g. `[supervisor] Project path: C:\my-app (source: --project)`), so it's
never a silent, hard-to-debug guess.

## Safety Constraints

- No change to `packages/shared/index.ts` or any agent's own
  `resolveTargetPath()` call — the existing, documented "no cwd fallback,
  no relative paths" policy for direct agent invocation is completely
  unchanged. This spec only changes what the *supervisor* pre-populates
  into `ORCHESTRAI_PROJECT_PATH` before spawning children — a layer
  entirely above that policy, not a modification of it.
- An explicitly-already-set `ORCHESTRAI_PROJECT_PATH` is never
  overridden — highest respect for something the user already configured
  themselves stays intact (checked before the config file or cwd).
- The resolved path is validated the same way `resolveTargetPath()`
  already validates any path (absolute, exists-as-directory checks happen
  downstream in each agent exactly as today) — this spec doesn't add new
  path-validation logic, it only decides what string gets offered as the
  env var.
- Printed at startup, never silent — a wrong resolution is immediately
  visible and correctable (re-run with `--project`, or fix the config
  file, or `cd` elsewhere).

## In Scope

1. `apps/supervisor/index.ts`: new `--project <path>` flag in
   `parseArgs()`; a `resolveProjectPath()` function implementing the
   4-source chain above; inject the result into the `env` passed to
   `spawnService()`'s `Bun.spawn()` call (only when non-empty, so an
   already-set env var — source 2 — needs no actual injection, it's
   already there).
2. Startup log line reporting the resolved path and its source.
3. `README.md`/`CLAUDE.md`: document `--project`, the config file, and the
   cwd fallback as supervisor-level conveniences, explicitly distinguished
   from the unchanged per-agent resolver policy.
4. A small unit test (or a few) for `resolveProjectPath()`'s priority
   ordering, mirroring the style of existing target-path resolver tests.

## Out of Scope / Non-Goals

- **No change to the underlying `resolveTargetPath()` policy** — direct
  `bun run <agent>` invocation, or any invocation that bypasses the
  supervisor entirely, is unaffected.
- **No interactive prompt** (e.g., asking "which project?" on first run) —
  stays fully non-interactive/scriptable.
- **No persistence of a chosen path back into a config file automatically**
  — the config file is read, never auto-written; a user who wants one
  creates it themselves.
- **No multi-project / project-switching UI** — one resolved path per
  supervisor invocation, exactly matching today's single-target-per-run
  model everywhere else in the codebase.

## Acceptance Criteria

- [x] Yusuf approves this spec ("Approved as written").
- [x] `orchestrai --project "C:\some\path"` (dev mode and compiled) starts
      every child with that path available as `ORCHESTRAI_PROJECT_PATH`,
      confirmed via a live task that needs it (e.g. `git status`).
- [x] An already-set `ORCHESTRAI_PROJECT_PATH` in the environment is never
      overridden by `--project` being absent, the config file, or cwd
      (verified via unit tests covering the full priority order).
- [x] Compiled binary: a `orchestrai.project.txt` next to the `.exe`,
      containing an absolute path, is picked up with no flag/env var set.
- [x] Compiled binary: with none of the above set, running it from inside
      a real project directory resolves to that directory via cwd.
- [x] Dev mode: the config-file source is correctly skipped (no meaningful
      "next to the binary" location); cwd fallback still applies.
- [x] Startup log clearly states the resolved path and which source won.
- [x] `bun test` and `bun run typecheck` remain fully green.

## Verification Results (2026-08-09)

- Implemented `resolveProjectPath()` as a pure function in
  `apps/supervisor/index.ts` (no I/O itself — takes already-read values),
  making it directly unit-testable: `apps/supervisor/project-path.test.ts`,
  7 new tests covering the full priority order, blank-value handling
  (whitespace-only values correctly treated as absent), and trimming.
- `bunx tsc --noEmit`: 0 errors. `bun test`: **121 pass** (114 → 121, the 7
  new tests), 0 fail, 190 expectations, 13 files.
- Live verification against a real running stack, each source tested in
  isolation:
  - `--project "C:\...\devops-mcp-server"`: logged `(source: --project)`;
    a `git-status` task with no explicit path in its text completed
    correctly using that value.
  - No flag/env set, run from the repo root: logged
    `(source: current directory)`, correctly resolved to the repo root.
  - Compiled binary, `orchestrai.project.txt` placed next to the `.exe`,
    run from **inside `dist/bin`** (a different, wrong directory if cwd
    had been used instead): logged `(source: orchestrai.project.txt)`,
    correctly resolved to the real repo root, not `dist/bin` — a clean,
    incidental proof that the config file genuinely outranks cwd, not just
    that both happened to agree.
- `bun run build`: rebuilt cleanly, unchanged 106.4 MB.
- `--help` text updated and confirmed to document `--project` and the
  resolution order correctly.

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/018-supervisor-project-path/spec.md as written.
```

or list specific changes needed — in particular the config filename and
whether all three new sources (flag, config file, cwd) should ship
together or only some of them.
