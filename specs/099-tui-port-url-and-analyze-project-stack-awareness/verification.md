# Verification: specs/099 — TUI Port URL and analyze-project Stack Awareness

## What changed

**Fix 1**: `apps/tui/tui-state.ts` gained a new, pure, directly-testable
`resolveOrchestratorUrl(env)` — the same `<full-URL override> ??
http://localhost:${resolveServicePort(...)}` shape
`packages/shared/agent-registry.ts` already uses for every agent.
`apps/tui/index.tsx`'s `ORCHESTRATOR_URL` now calls it instead of a
hardcoded `"http://localhost:3000"` fallback.

**Fix 2**: `detectEcosystem()`/`Ecosystem`/`EcosystemDetection`/
`MANIFEST_FILES_CHECKED` moved verbatim from
`packages/agents/security/dependency-manifests.ts` to a new
`packages/shared/detect-ecosystem.ts`; the original file re-exports all
four unchanged, so every existing Security import site is
byte-identical. `packages/mcp/index.ts`'s `analyze_project` tool gained
`buildEcosystemManifestLines()`, replacing the fixed
`hasPackageJson`/`hasBunLock` pair with a real, ecosystem-appropriate
manifest/lockfile pair (npm's own lockfile check broadened to any of
`bun.lock`/`bun.lockb`/`package-lock.json`/`pnpm-lock.yaml`/
`yarn.lock`, not just Bun's own).

## Acceptance criteria

- [x] `ORCHESTRATOR_URL`, with no `ORCHESTRAI_ORCHESTRATOR_URL` set,
      resolves to `http://localhost:${resolveServicePort("orchestrator")}`
      — a real custom `ORCHESTRAI_ORCHESTRATOR_PORT` is honored.
- [x] An explicit `ORCHESTRAI_ORCHESTRATOR_URL` still wins over any port
      variable, unchanged.
- [x] `detectEcosystem()`/`Ecosystem` moved to
      `packages/shared/detect-ecosystem.ts`; every pre-existing Security
      test importing them from `dependency-manifests.ts` passes
      unmodified (all 72 Security tests pass).
- [x] `analyze_project` against a real PHP project (real `composer.json`
      + `composer.lock`) reports composer-labeled checks, never
      `hasBunLock` — confirmed both by unit test and a real live
      dispatch.
- [x] `analyze_project` against a real npm project using only
      `package-lock.json` (no `bun.lock`) correctly reports its
      lockfile as present.
- [x] `analyze_project` against a project with none of the six known
      manifest files reports an explicit "no recognized manifest found"
      line.
- [x] Every universal check is byte-identical to before this spec, for
      every ecosystem case.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] Every pre-existing test in the affected files passes unmodified.

## Test results

- `packages/shared/service-ports.test.ts` (**new** — `resolveServicePort()`
  had no dedicated test file at all before this spec, a real,
  previously-undiscovered gap, not introduced here): 6 pass.
- `apps/tui/tui-state.test.ts`: net +3 (`resolveOrchestratorUrl()`'s own
  default/override/explicit-URL-wins cases).
- `packages/agents/security/`: 72 pass, all pre-existing, unmodified —
  confirms the `dependency-manifests.ts` re-export is byte-identical.
- `packages/mcp/index.test.ts`: net +7 (PHP, npm-broadened-lockfile,
  no-ecosystem, Go, PyPI, Maven, universal-checks-unchanged).
- `bun test` (full suite): 1164 pass, 0 fail (net +16 over specs/098's
  own 1148 baseline).
- `bun run typecheck`: 0 errors.
- `bun run specs:catalog`/`specs:check`: pass, 98 specs.

## Live verification

**Fix 2**: restarted `mcp:http` (the real running service; connected
agents auto-reconnected — confirmed `devops-agent`'s own `/healthz`
showing `mcp.state: "connected"` again within seconds). Created a real
scratch PHP project (`composer.json` + `composer.lock` + a Dockerfile)
and dispatched a real `analyze-project` request through the real
Orchestrator. Result:
```
✅ hasDockerfile
❌ hasDockerCompose
❌ hasGitignore
❌ hasEnvExample
❌ hasCI
❌ hasReadme
✅ hasManifest (composer.json)
✅ hasLockfile (composer.lock)
```
— exactly the fix: no `hasBunLock`, no `hasPackageJson`, a real,
correctly-labeled composer.json/composer.lock pair.

**Fix 1**: not live-verified — driving the TUI itself requires a real
interactive terminal with raw-mode stdin, which this sandbox does not
have (the same standing gap every TUI checkpoint in this codebase
carries, e.g. `specs/012`/`specs/069`/`specs/073`). The underlying
resolution logic (`resolveOrchestratorUrl()`) is exhaustively unit
tested instead, including the exact scenario that caused the original
bug (`ORCHESTRAI_ORCHESTRATOR_PORT` set, no `ORCHESTRAI_ORCHESTRATOR_URL`).

## Known limitations

- Fix 1's live behavior in a real terminal (confirming the
  auto-launched TUI actually connects when a custom port is set) is the
  one open item — needs a real interactive terminal pass, the same
  standard every guided-init/TUI checkpoint here carries.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/099-tui-port-url-and-analyze-project-stack-awareness/spec.md`
(implemented, **partial** verification, 2026-09-15) fixes two real,
live-caught bugs. **Bug 1**: Yusuf started a stack with a custom
`ORCHESTRAI_ORCHESTRATOR_PORT` and the TUI showed every agent
disconnected — `apps/tui/index.tsx`'s `ORCHESTRATOR_URL` was hardcoded
to `http://localhost:3000`, unaware `specs/073` had made the port
configurable at all. Fixed with a new `resolveOrchestratorUrl(env)` in
`apps/tui/tui-state.ts`, mirroring `packages/shared/agent-registry.ts`'s
own established `<full-URL override> ??
http://localhost:${resolveServicePort(...)}` shape exactly — a real,
previously-undiscovered gap in `specs/073`'s own scope, not something
that spec claimed to cover. **Bug 2**: a PHP project's `analyze-project`
report showed `hasBunLock`/`hasPackageJson` — meaningless for a
non-npm stack. `detectEcosystem()`/`Ecosystem`/`EcosystemDetection`/
`MANIFEST_FILES_CHECKED` moved verbatim from
`packages/agents/security/dependency-manifests.ts` (agent-specific) to
a new `packages/shared/detect-ecosystem.ts` (foundational, since
`packages/mcp` must never depend on an agent-specific package — the
original file re-exports all four unchanged, so every existing Security
import site stays byte-identical). `packages/mcp/index.ts`'s
`analyze_project` gained `buildEcosystemManifestLines()`, replacing the
fixed npm-only pair with a real, ecosystem-appropriate manifest/
lockfile pair — the real filename named directly (`✅ hasManifest
(composer.json)`), npm's own lockfile check broadened from Bun-only to
any of `bun.lock`/`bun.lockb`/`package-lock.json`/`pnpm-lock.yaml`/
`yarn.lock`, PyPI/Maven report manifest-only (no universal lockfile
concept, per `specs/085`'s own documented finding), and no ecosystem
detected produces an explicit "no recognized dependency manifest found"
line, never a silent omission.

Also closed along the way: `packages/shared/service-ports.ts`'s own
`resolveServicePort()` had zero dedicated test coverage before this
spec — a real, previously-undiscovered gap, closed with a new
`service-ports.test.ts` (6 tests), not introduced by this spec.

1164 tests pass (0 fail; net +16 over `specs/098`'s own 1148 baseline),
typecheck clean, `specs:check` passed for 98 specs.

**Live-verified (Fix 2 only)**: restarted `mcp:http` (confirmed
`devops-agent`'s own `/healthz` reconnected within seconds), created a
real scratch PHP project (`composer.json` + `composer.lock` + a
Dockerfile), and dispatched a real `analyze-project` request through
the real Orchestrator — the report correctly showed `✅ hasManifest
(composer.json)` / `✅ hasLockfile (composer.lock)`, never
`hasBunLock`/`hasPackageJson`. **Fix 1 not live-verified**: driving the
TUI itself needs a real interactive terminal with raw-mode stdin, which
this sandbox does not have — the same standing gap every TUI checkpoint
here carries. The underlying `resolveOrchestratorUrl()` logic is
exhaustively unit-tested instead, including the exact scenario that
caused the original bug. See `specs/099`'s own `verification.md` for
the complete transcript.

See specs/100-document-api-grounded-llm-route-discovery-fallback/verification.md for the relocated narrative covering this checkpoint.
