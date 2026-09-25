---
id: 073-configurable-service-ports
title: Configurable Service Ports (Env-Var Plumbing + Guided Init UI)
area: supervisor
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-11
updated: 2026-09-11
approved_by: Yusuf
approved_on: 2026-09-11
implemented_on: 2026-09-11
amends:
  - 016-orchestrai-supervisor
  - 048-guided-init-experience
  - 071-models-view-inline-provider-in-picker
related:
  - 039-per-component-llm-provider-config
  - 034-init-wizard-services-ux
supersedes: []
superseded_by: []
---

# Spec: Configurable Service Ports (Env-Var Plumbing + Guided Init UI)

> **Approved 2026-09-11 by Yusuf** ("can chose all of them" — confirming
> all 6 services, including mcp:http, get their own configurable port,
> not just the 4 visible agents). Written from Yusuf's live request,
> 2026-09-11: *"will need also to choose the ports of the agents the
> default as is but also need to have the ability to set the ports."*

## Purpose

CLAUDE.md's own "Known limitations and technical debt" section has
said, since early in this project, "Ports and agent URLs are
hardcoded." That's been true structurally, not just documentally: every
one of the 6 processes binds a literal port number, and the guided-init
forms have never had anything to configure. This spec makes each
service's own bind port an overridable, env-var-driven value —
defaulting to exactly today's numbers — and adds a Ports section to the
TUI guided-init form to set them, mirroring how `specs/071`'s Models
section already sits on the setup screen.

This is real plumbing, not a UI-only change: three independent layers
currently agree only because every port is the same hardcoded literal
everywhere it appears. Changing one without the others breaks discovery
silently (the Orchestrator would poll the wrong port, or the supervisor
would preflight/health-check the wrong one).

## Verified Current State

Read 2026-09-11:

- **Each service's own bind port is a hardcoded literal**, one per
  file: `apps/orchestrator/index.ts` (`const PORT = 3000`),
  `packages/agents/devops/index.ts` (`3002`),
  `packages/agents/testing/index.ts` (`3003`),
  `packages/agents/documentation/index.ts` (`3004`),
  `packages/agents/security/index.ts` (`3005`),
  `packages/mcp/http.ts` (`3006`). None read from `process.env`.
- **`packages/shared/agent-registry.ts`** already supports a
  **consumer-side** override for how the Orchestrator *reaches* each
  agent: `ORCHESTRAI_{DEVOPS,TESTING,DOCUMENTATION,SECURITY}_URL`,
  defaulting to `http://localhost:<today's port>`. This is one-way —
  it changes where the Orchestrator *looks*, never where the named
  agent itself *binds*. `apps/orchestrator/index.ts`'s own
  `KNOWN_AGENTS` already reads from this registry (a stale comment on
  the registry file claims otherwise; not true — confirmed by reading
  both files together).
- **`packages/shared/mcp-client.ts`** similarly supports
  `ORCHESTRAI_MCP_URL` (consumer-side, for DevOps/Testing/Documentation
  finding the MCP HTTP server) and `packages/mcp/http.ts` supports
  `ORCHESTRAI_MCP_BIND_HOST` (which *host* to bind, not which *port*).
  The MCP server's own **port** (3006) has no override at all.
- **`apps/supervisor/index.ts`** keeps its own, independent, hardcoded
  `ServiceDef[]` port table (`MCP_HTTP`, `AGENTS`, `ORCHESTRATOR`,
  module-top-level `const`s) — used for `isPortFree()` preflight,
  `waitForHealthy()` polling, and the startup summary's printed URLs.
  This table has no connection to the per-service literals above; they
  only agree today because both sides hardcode the same numbers.
- **Env-loading order matters**: `main()` reads
  `<target>/.orchestrai/config.env` (via `parseConfigEnv()`) and merges
  it into `process.env` — but only *after* module load, partway through
  `main()` itself, well after the current module-top-level `ServiceDef[]`
  consts would already have been evaluated if they read `process.env`
  the naive way. `spawnService()` then forwards `process.env` (by then
  already merged) to every child via `Bun.spawn(..., {env:
  process.env})` — so a child process **does** correctly inherit
  anything set before its own `spawnService()` call; the risk is
  entirely on the supervisor's own pre-spawn reads (preflight/health
  targets), which must be computed at the same "after env merge" point,
  not at module-evaluation time.
- `apps/supervisor/init-form-state.ts`/`init-form.tsx` (the guided-init
  TUI form) have no notion of ports today at all.

## Proposed Behavior

### 1. Each service reads its own port from an env var

One new env var per service, `ORCHESTRAI_<SERVICE>_PORT`, read where
each `const PORT = <literal>` is declared today, falling back to the
exact existing literal when unset:

| Service | Var | Default |
|---|---|---|
| Orchestrator | `ORCHESTRAI_ORCHESTRATOR_PORT` | 3000 |
| DevOps Agent | `ORCHESTRAI_DEVOPS_PORT` | 3002 |
| Testing Agent | `ORCHESTRAI_TESTING_PORT` | 3003 |
| Documentation Agent | `ORCHESTRAI_DOCUMENTATION_PORT` | 3004 |
| Security Agent | `ORCHESTRAI_SECURITY_PORT` | 3005 |
| MCP HTTP | `ORCHESTRAI_MCP_PORT` | 3006 |

An unset or non-numeric value falls back to the default (never crashes
the service). This mirrors the existing `ORCHESTRAI_MCP_BIND_HOST`
precedent (an env var read once at module scope, defaulted, no
validation ceremony) rather than inventing a new pattern.

### 2. `agent-registry.ts` / MCP client construct URLs from the port var

`packages/shared/agent-registry.ts`: each agent's URL becomes
`process.env.ORCHESTRAI_<AGENT>_URL ?? \`http://localhost:${process.env.ORCHESTRAI_<AGENT>_PORT ?? "<default>"}\``
— the existing full-URL override still wins when set (e.g. pointing at
a different host); the new port var is consulted only as the
next-priority fallback, never silently overridden by it.

`packages/shared/mcp-client.ts`'s own `ORCHESTRAI_MCP_URL` default
(`http://127.0.0.1:3006/mcp`) is similarly rebuilt from
`ORCHESTRAI_MCP_PORT` when `_URL` itself isn't set.

This is what makes a custom port **discoverable**, not just bindable:
without this, a service could listen on a new port while every other
process still looked for it on the old one.

### 3. The supervisor resolves ports after env merge, not at module load

`apps/supervisor/index.ts`'s `MCP_HTTP`/`AGENTS`/`ORCHESTRATOR`
`ServiceDef[]` port fields move from module-top-level literals to a
`resolveServicePorts()` step called from `main()` **after** the
`.orchestrai/config.env` merge (the exact ordering risk named in
Verified Current State) — reading the same six env vars with the same
defaults as §1, so the supervisor's preflight, health-check, and
startup-summary URLs always agree with what each child will actually
bind. `--only`/`--project`/every other existing flag and behavior is
unaffected; this only changes *when* six numbers are read, not the
overall control flow.

### 4. A Ports section on the guided-init setup screen

Mirroring `specs/071`'s Models section (same screen, same pattern —
`Tab` reaches it, `↑/↓` moves a row cursor, `Enter`/typing edits),
a new section lists all 6 services with their resolved port (default,
or whatever's already saved) and lets the user type a replacement.
Pure local validation only (no network probe during setup — the
supervisor's own existing `isPortFree()` preflight, `specs/045`, is
still what catches a genuine live conflict at start time):

- A value must parse as an integer in the valid TCP range (1–65535).
- Two rows may not share the same port — a real, visible error, not a
  silent last-write-wins.
- An empty row means "use the default" (same convention `modelOverrides`
  already uses) — never a placeholder value that looks like a real
  port.

### 5. Written config

`WizardConfig` gains an optional `ports: Partial<Record<ServiceName,
number>>`; `formatConfigEnv()` writes `ORCHESTRAI_<SERVICE>_PORT=<n>`
only for a service whose port differs from the default — an unedited
row writes nothing, exactly like every other optional field in this
file.

## Scope

- `apps/orchestrator/index.ts`, `packages/agents/{devops,testing,
  documentation,security}/index.ts`, `packages/mcp/http.ts`: the six
  `PORT` constants gain their env-var read + fallback.
- `packages/shared/agent-registry.ts`, `packages/shared/mcp-client.ts`:
  URL construction consults the new port vars as described in §2.
- `apps/supervisor/index.ts`: `resolveServicePorts()` (or equivalent)
  called from `main()` after the config-env merge; `isPortFree()`/
  `waitForHealthy()`/the startup summary all read the resolved values.
- `apps/supervisor/init-form-state.ts`: new pure state for the Ports
  section (a row list, a cursor, validation, `formStateToWizardConfig()`
  wiring) — mirroring the Models section's own shape.
- `apps/supervisor/init-form.tsx`: the Ports section's rendering +
  keyboard handling, inside the same setup-screen scrollbox.
- `apps/supervisor/init-wizard.ts`: `WizardConfig`/`formatConfigEnv()`/
  `WIZARD_OWNED_KEYS` gain the six port fields.
- **Out of scope / deferred**: the classic prompt wizard (keeps asking
  nothing about ports, same as it asks nothing about per-component
  models today); the browser form's own port-editing UI (inherits the
  written-config plumbing through the same shared
  `formStateToWizardConfig()`, same standing "TUI first" gap
  `specs/063`/`068` already established for models); `docker-compose.yml`
  port mappings; live port-availability checking inside the init form
  itself (stays the supervisor's own preflight's job); any change to
  `--only`'s own flag semantics.

## Safety and Compatibility Constraints

- **Byte-identical default behavior.** With no port env vars set and no
  Ports-section edits, every service binds exactly the port it does
  today — proven by test and by running the existing suite unmodified.
- **No orphaned discovery.** A custom port is only useful if every
  consumer agrees on it; §2/§3 are what make that true, not just §1's
  binding change alone.
- **The supervisor's own port-preflight (`specs/045`) is untouched** —
  still a live, timeout-bounded `isPortFree()` check before spawning
  anything, now just checking the *resolved* port instead of a literal.
- **No new row-budget risk** in the TUI form — the Ports section reuses
  the exact scrollbox/`fieldScrollOffset()` mechanism `specs/071`
  already proved safe for the Models section.

## Out of Scope / Non-Goals

- Docker Compose / CI port configuration.
- The browser form's own Ports UI (separate follow-up, same shape as
  the standing Models-UI gap there).
- Changing the classic wizard's prompt flow.
- Runtime port reassignment after a service has already started.
- Exposing services on non-loopback interfaces (unrelated to this
  spec — `ORCHESTRAI_MCP_BIND_HOST` already exists for that, untouched).

## Acceptance Criteria

- [x] With no port env vars set, every one of the 6 services binds its
      exact current default port — unchanged behavior, proven by test.
- [x] Setting `ORCHESTRAI_DEVOPS_PORT=9002` (say) makes DevOps bind
      9002 **and** makes the Orchestrator's own discovery find it there
      — a real, live, two-process check (not just unit tests).
- [x] Running `orchestrai` (the supervisor) with a custom port set
      preflights, health-checks, and prints its startup summary against
      the resolved port, not the old literal — live-verified.
- [x] The TUI form's Ports section lists all 6 services, shows the
      resolved default when unedited, accepts a typed override, and
      rejects an out-of-range value or a duplicate across two rows with
      a visible error, never a silent overwrite.
- [x] A config saved with all ports left at default writes no
      `ORCHESTRAI_<SERVICE>_PORT` lines at all.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `CLAUDE.md` (including its own "hardcoded ports" limitation note)
      and `context/worklog.md` updated.

## Verification Plan

- Pure unit tests: the Ports section's row validation (range, dupes,
  empty-means-default); `formatConfigEnv()`'s new fields.
- **A genuine live process pass, doable directly (no interactive
  terminal needed, unlike the TUI-rendering checkpoints in this
  codebase's history)**: start DevOps with `ORCHESTRAI_DEVOPS_PORT` set
  to a non-default value, curl its own `/healthz` on the new port,
  then start the Orchestrator with the matching
  `ORCHESTRAI_DEVOPS_URL`/`_PORT` env and confirm `GET /agents` shows
  it online — proving discovery genuinely follows the custom port, not
  just that the process starts.
- A supervisor-level pass: `orchestrai --only devops-agent` with a
  custom port set, confirming the preflight/health-check/startup
  summary all agree with the new port.
- A live real-terminal pass for the Ports section's own rendering and
  keyboard interaction at 80×24 — the standard every guided-init
  checkpoint here carries; the process-level checks above do not
  require it and can be done in this session.

## Approval Requested

Approve to proceed. Amends `specs/016` (the supervisor's own port
handling), `specs/048` (the guided-init form), and `specs/071` (the
setup screen's shape, which gains one more section). Nothing is
implemented until then.
