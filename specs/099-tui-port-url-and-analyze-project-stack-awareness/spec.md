---
id: 099-tui-port-url-and-analyze-project-stack-awareness
title: "TUI Follows ORCHESTRAI_ORCHESTRATOR_PORT, and analyze-project Becomes Stack-Aware"
area: orchestrator
change_type: fix
status: implemented
verification: partial
created: 2026-09-15
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-15
implemented_on: 2026-09-15
amends:
  - 073-configurable-service-ports
  - 085-multi-ecosystem-dependency-audit
related:
  - 012-tui-interactive
  - 016-orchestrai-supervisor
supersedes: []
superseded_by: []
---

# Spec: TUI Follows ORCHESTRAI_ORCHESTRATOR_PORT, and analyze-project Becomes Stack-Aware

> Status: **APPROVED 2026-09-15 by Yusuf.** Two real, distinct bugs Yusuf found
> live in the same session, 2026-09-15, both about a real signal (a
> configured port, a project's real detected language) being silently
> ignored by a component that should have honored it. Bundled into one
> spec at Yusuf's own request ("yes please" to fixing both together),
> matching this session's own precedent (`specs/097` bundled three
> same-session findings the same way).

## Purpose

**Bug 1 — the TUI never follows a custom orchestrator port.** Yusuf ran
`orchestrai` on a machine with every service moved to non-default ports
(`ORCHESTRAI_ORCHESTRATOR_PORT=5000`, etc.) — the real startup log
confirmed every service, including the Orchestrator, bound and started
correctly, and the Orchestrator's own discovery correctly found all 6
agents. But the auto-launched TUI showed **zero agents, all
disconnected** — a real, live-blocking bug, not a misconfiguration.

**Bug 2 — `analyze-project`'s own "DevOps Checks" report is not aware of
the target project's real language.** A real PHP project (using
`composer.json`, no Bun/Node tooling at all) produced a report showing a
red ❌ next to `hasBunLock` — a Bun-specific file that is completely
irrelevant to a PHP project, reading as "something's missing" when
nothing actually is. The same misleading signal would appear in reverse
for any non-npm project (Python, Go, Java) today.

## Verified Current State

### Bug 1

- `apps/tui/index.tsx`'s own connection URL, confirmed directly:
  ```ts
  const ORCHESTRATOR_URL = process.env.ORCHESTRAI_ORCHESTRATOR_URL ?? "http://localhost:3000"
  ```
  reads only the full-URL override variable, with a **hardcoded**
  fallback literal — no awareness of `ORCHESTRAI_ORCHESTRATOR_PORT` at
  all.
- `packages/shared/agent-registry.ts` (the Orchestrator's own agent
  discovery) already built its default URLs correctly for exactly this
  scenario, confirmed directly:
  ```ts
  devops: process.env.ORCHESTRAI_DEVOPS_URL ?? `http://localhost:${resolveServicePort("devops")}`,
  ```
  — every agent entry follows this exact `<full-URL override> ??
  http://localhost:<resolveServicePort(...)>` shape. `specs/073`
  (configurable service ports) updated this file and
  `packages/shared/mcp-client.ts` to this shape but never touched the
  TUI, confirmed directly — a genuine, previously-undiscovered gap in
  that spec's own scope, not something it claimed to cover.
- `resolveServicePort("orchestrator")` is already a valid, tested call
  (`"orchestrator"` is a real `ServicePortName` key,
  `packages/shared/service-ports.ts`, default `3000`) — the exact
  building block needed already exists and needs no new logic.
- **Live-reproduced, 2026-09-15**: a real `orchestrai` startup with
  every port customized (orchestrator on `5000`) started cleanly — the
  real startup log showed all 6 agents discovered correctly by the
  Orchestrator itself — but the auto-launched TUI showed zero
  agents/disconnected, because it was still polling `http://
  localhost:3000`, where nothing was listening.

### Bug 2

- `packages/mcp/index.ts`'s `analyze_project` tool, confirmed directly:
  ```ts
  const checks = {
    hasDockerfile: ..., hasDockerCompose: ..., hasGitignore: ...,
    hasEnvExample: ..., hasCI: ...,
    hasPackageJson: existsSync(path.join(project_path, "package.json")),
    hasBunLock:     existsSync(path.join(project_path, "bun.lock")),
    hasReadme: ...,
  }
  ```
  — a single, fixed checklist applied to **every** project regardless of
  its real detected language, with no ecosystem awareness at all. The
  first five and last checks are genuinely universal (any project can
  have a Dockerfile, `.gitignore`, CI, a README); `hasPackageJson`/
  `hasBunLock` are npm/Bun-specific and misleading for anything else —
  and even understate the real npm case, since `hasBunLock` alone
  misses a legitimate npm/yarn/pnpm project that never used Bun.
- `packages/agents/security/dependency-manifests.ts`'s own
  `detectEcosystem()` (`specs/085`) already does exactly the detection
  this needs — `npm`/`PyPI`/`Go`/`Packagist`/`Maven`, in a fixed,
  already-tested order, real manifest files, no execution — but it
  lives under `packages/agents/security/`, an agent-specific namespace.
  `packages/mcp` is a foundational, agent-agnostic layer multiple agents
  depend on (DevOps, Code Review, Coder as MCP clients, plus the
  external stdio/HTTP surface) — importing an agent-specific module
  into it would invert the codebase's own layering, confirmed by
  reading `packages/mcp/index.ts`'s own existing imports (nothing in it
  currently imports from `packages/agents/*`).
- `packages/shared/test-runner.ts`'s own `detectRunner()` (`specs/058`)
  already checks for `bun.lock`/`bun.lockb`/`package-lock.json`/
  `pnpm-lock.yaml`/`yarn.lock` for an unrelated purpose (picking a test
  *command*) — not reused here directly (different return shape/
  purpose, and the check needed is a much smaller, single boolean); the
  same four-lockfile-name list is checked directly, matching the "small,
  pure check, not worth a shared abstraction" bar this codebase already
  draws elsewhere (e.g. `resolveServicePort()` is shared because it's
  genuinely reused as one *decision*; a 4-line `existsSync` OR is not).
- **Live-reproduced, 2026-09-15**: a real PHP project's own
  `analyze-project` report showed `❌ hasBunLock` alongside `✅
  hasPackageJson` (a project can plausibly have both a `composer.json`
  for PHP and a `package.json` for frontend tooling) — confirmed via a
  real dispatched task's own result text.

## Proposed Behavior

### Fix 1 — the TUI follows the same URL-resolution shape every other component already uses

`apps/tui/index.tsx`'s `ORCHESTRATOR_URL` becomes:
```ts
const ORCHESTRATOR_URL = process.env.ORCHESTRAI_ORCHESTRATOR_URL ?? `http://localhost:${resolveServicePort("orchestrator")}`
```
— the identical shape `agent-registry.ts` already uses for every agent,
imported from the same `packages/shared/service-ports.ts`. An explicit
`ORCHESTRAI_ORCHESTRATOR_URL` still always wins (unchanged); the only
change is what the *fallback* resolves to when that's unset — from a
hardcoded `3000` literal to the real configured port.

### Fix 2 — `analyze-project` detects the real ecosystem and reports ecosystem-appropriate checks

`detectEcosystem()`/`type Ecosystem` (currently defined in
`packages/agents/security/dependency-manifests.ts`) move to a new,
small, pure `packages/shared/detect-ecosystem.ts` — genuinely
foundational, dependency-free (`existsSync`/`path.join` only), and now
used by two independent consumers (Security's own audit-dependencies,
and this fix). `dependency-manifests.ts` re-exports both from the new
location, so every existing import (`packages/agents/security/
index.ts`, `dependency-manifests.test.ts`) is **byte-identical**, no
call site changes anywhere in Security.

`analyze_project` calls the shared `detectEcosystem()` once and
replaces the fixed `hasPackageJson`/`hasBunLock` pair with one
ecosystem-appropriate manifest/lockfile pair, the real filename named
directly in the printed line (not just inferred from a generic key
name):

- **npm**: manifest = `package.json`; lockfile = **any** of
  `bun.lock`/`bun.lockb`/`package-lock.json`/`pnpm-lock.yaml`/
  `yarn.lock` (broadened from today's Bun-only check — a real,
  additional fix for the npm case itself, not just other ecosystems).
- **PyPI**: manifest = whichever of `requirements.txt`/`pyproject.toml`
  `detectEcosystem()` actually found; no lockfile check (Python has no
  universal lockfile concept — `specs/085`'s own documented finding,
  not a new claim).
- **Go**: manifest = `go.mod`; lockfile = `go.sum`.
- **Packagist**: manifest = `composer.json`; lockfile = `composer.lock`.
- **Maven**: manifest = `pom.xml`; no lockfile check (`specs/085`'s own
  documented finding — Maven has no standard lockfile concept at all).
- **No ecosystem detected** (none of the six known manifest files
  present): a single explicit line stating no recognized dependency
  manifest was found — never silently omitted, so the report's own
  shape (an entry always present) stays consistent regardless of
  outcome.

Every universal check (`hasDockerfile`, `hasDockerCompose`,
`hasGitignore`, `hasEnvExample`, `hasCI`, `hasReadme`) is **completely
unchanged** — this only replaces the two npm-specific entries with a
real, ecosystem-aware pair.

## Scope

- `apps/tui/index.tsx`: `ORCHESTRATOR_URL`'s own fallback, plus a new
  import from `../../packages/shared/service-ports`.
- `packages/shared/detect-ecosystem.ts` (new): `Ecosystem` type,
  `detectEcosystem()`, moved verbatim from
  `packages/agents/security/dependency-manifests.ts`.
- `packages/agents/security/dependency-manifests.ts`: re-exports both
  from the new shared location; no other change.
- `packages/mcp/index.ts`: `analyze_project`'s own `checks` construction
  gains ecosystem detection and the new manifest/lockfile pair.
- Tests: a focused test proving `ORCHESTRATOR_URL`'s own resolution
  order (explicit URL wins; unset falls back to the real configured
  port, not a hardcoded literal) — via the same technique this
  codebase's own `service-ports.test.ts` already uses for the
  equivalent per-agent case. `analyze_project`'s own existing test
  coverage (`packages/mcp/index.test.ts`) gains cases for each of the
  five detected ecosystems plus the no-ecosystem-detected case,
  confirming the correct manifest/lockfile pair (or absence) appears;
  every pre-existing universal-check assertion stays unmodified.
  `dependency-manifests.test.ts`'s own existing `detectEcosystem` tests
  pass unmodified against the re-exported function.

## Safety and Compatibility Constraints

- **Fix 1 is a pure connection-target change** — no new capability, no
  change to what the TUI can do once connected; an explicit
  `ORCHESTRAI_ORCHESTRATOR_URL` still always wins, unchanged.
- **Fix 2 is read-only, unchanged in kind** — `analyze_project` was
  already a read-only inspection tool; this only changes which files it
  checks for and how the result is labeled, never adding a write or a
  new external call.
- **No change to `detectEcosystem()`'s own behavior** — moved verbatim,
  not rewritten; `specs/085`'s own fixed detection order (npm first,
  then PyPI, Go, Packagist, Maven; first manifest found wins) is
  completely unchanged.
- **The broadened npm lockfile check can only ever turn a previous ❌
  into a ✅** — it strictly widens what counts as "a lockfile is
  present" (four more filenames, `bun.lock` still included), never
  narrows it; a project that previously passed this check still passes.

## Out of Scope / Non-Goals

- Detecting more than one ecosystem in a genuinely polyglot project
  (e.g. real npm frontend + real PHP backend in one repo) — matches
  `specs/085`'s own existing Non-Goal (first manifest found wins,
  fixed detection order); not revisited here.
- Adding Rust/.NET/Ruby ecosystem detection — `detectEcosystem()`
  itself is moved, not extended; matches this codebase's own "one
  ecosystem at a time" precedent (`specs/085`'s own follow-up note).
- Any change to `resolveServicePort()`/`service-ports.ts` itself, or to
  any other TUI connection behavior (SSE, task polling, approve/reject)
  beyond the one `ORCHESTRATOR_URL` constant.
- Exposing per-service port configuration to the classic prompt wizard
  or any other surface — `specs/073` already covers where ports are
  configured; this spec only fixes one consumer that failed to honor an
  already-existing configuration.

## Acceptance Criteria

- [x] `apps/tui/index.tsx`'s `ORCHESTRATOR_URL`, with no
      `ORCHESTRAI_ORCHESTRATOR_URL` set, resolves to
      `http://localhost:${resolveServicePort("orchestrator")}` — a real
      custom `ORCHESTRAI_ORCHESTRATOR_PORT` is honored, not the
      hardcoded `3000` literal.
- [x] An explicit `ORCHESTRAI_ORCHESTRATOR_URL` still wins over any port
      variable, unchanged.
- [x] `detectEcosystem()`/`Ecosystem` move to `packages/shared/
      detect-ecosystem.ts`; every pre-existing test importing them from
      `dependency-manifests.ts` passes unmodified.
- [x] `analyze_project` against a real PHP project (a real
      `composer.json`, optionally a real `composer.lock`) reports
      `composer.json`/`composer.lock`-labeled checks, never
      `hasBunLock`.
- [x] `analyze_project` against a real npm project using only
      `package-lock.json` (no `bun.lock` at all) correctly reports its
      lockfile as present — the broadened npm case.
- [x] `analyze_project` against a project with none of the six known
      manifest files reports an explicit "no recognized manifest found"
      line, never a silently missing entry.
- [x] Every universal check (`hasDockerfile`,`hasDockerCompose`,
      `hasGitignore`,`hasEnvExample`,`hasCI`,`hasReadme`) is
      byte-identical to before this spec, for every ecosystem case.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] Every pre-existing test in the affected files passes unmodified.

## Verification Plan

- Unit: every acceptance criterion above.
- Live: re-run `orchestrai` with a custom `ORCHESTRAI_ORCHESTRATOR_PORT`
  and confirm the auto-launched TUI connects and shows real agents, not
  zero/disconnected; re-run `analyze-project` against the real live PHP
  project that surfaced Bug 2 and confirm the report no longer shows
  `hasBunLock`.

## Approval Requested

Not yet requested — presented for review.
