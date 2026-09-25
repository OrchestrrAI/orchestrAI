---
id: 009-dockerization
title: Dockerization of OrchestrAI's Own 7 Services
area: deployment
change_type: feature
status: implemented
verification: verified
created: 2026-08-08
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-08
implemented_on: 2026-08-08
amends: []
supersedes: []
superseded_by: []
related:
  - 011-remaining-agents-mcp
---

# Spec: Dockerization of OrchestrAI's Own 7 Services

> Status history: **APPROVED by Yusuf on 2026-08-08 ("go ahead for both"),
> IMPLEMENTED AND VERIFIED on 2026-08-08**, including the shared
> MCP-host-allowlist fix. See Verification Results below.

## Purpose

Package OrchestrAI's own runtime (Orchestrator + 5 agents + MCP HTTP server)
so `docker compose up` runs the complete demo on any machine with Docker,
without installing Bun, setting environment variables by hand, or knowing the
correct startup order. This directly addresses the delivery plan's named risk
("Docker build fails on judge's machine") and its MUST-HAVE tier item
("Dockerization — `docker compose up` works").

This is explicitly about containerizing **OrchestrAI itself**, not the
already-implemented `dockerize`/`create-compose` DevOps skills that generate
a Dockerfile/Compose file **for a target project someone asks it to
analyze**. Those are unrelated, unaffected features.

## Verified Current State

- No `Dockerfile` or `docker-compose.yml` exists for OrchestrAI's own
  services (confirmed: `git status` / repo listing).
- `package.json` at repo root defines 7 relevant scripts:
  `mcp:http`, `planning-agent`, `devops-agent`, `testing-agent`,
  `documentation-agent`, `security-agent`, `orchestrator` — each `bun run
  <script>` starting one process, one port.
- Every service exposes `GET /healthz`; the MCP HTTP server's is
  `GET /healthz` on `:3006` returning `{"status":"ok", ...}`; each agent's is
  `{"status":"ok", ...}` (DevOps's additionally reports `ready`/MCP state).
- Ports are hardcoded per-service (`PORT = 3000` in Orchestrator, `3002` in
  DevOps, etc.) — not currently overridable by environment variable except
  `ORCHESTRAI_MCP_URL` and the five `ORCHESTRAI_<AGENT>_URL` overrides added
  by `packages/shared/agent-registry.ts`.
- `bun run dev` starts all 7 via `bun run --parallel` with no readiness
  sequencing; killing any one process currently tears down the whole group —
  a known, documented limitation of `--parallel` itself, not something this
  spec needs to fix (Docker Compose's own health-check-gated `depends_on`
  solves the equivalent problem inside containers, independently).
- `bunx tsc --noEmit` cannot currently run reliably (TypeScript is not a
  declared dev dependency) — CLAUDE.md already documents this as blocking
  reproducible type checking.

## Proposed Design

### One shared image, seven containers

Use a **single Dockerfile** producing one image containing the full built
workspace (`bun install --frozen-lockfile`, source copied in), rather than
seven separate Dockerfiles. Each of the 7 `docker-compose.yml` services runs
the **same image** with a different `command:` (`bun run mcp:http`, `bun run
orchestrator`, etc.). This avoids duplicating install/build steps seven times
and matches the project's existing single-workspace structure — the
alternative (one Dockerfile per service) would multiply image-build time and
maintenance for no benefit, since every service shares the same
`node_modules`/lockfile.

Illustrative multi-stage shape (final content subject to review):

```dockerfile
FROM oven/bun:1-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY packages/*/package.json packages/*/
COPY packages/agents/*/package.json packages/agents/*/
COPY apps/*/package.json apps/*/
RUN bun install --frozen-lockfile

FROM base AS runner
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN addgroup --system app && adduser --system --ingroup app app
USER app
# No CMD here — docker-compose.yml supplies the entrypoint per service.
```

### `docker-compose.yml`

- One service block per existing `bun run <script>` command, all
  `build: .`, each with its real port exposed and its own `command:`.
- `healthcheck:` on every service using its existing `/healthz` endpoint
  (needs a way to make an HTTP request from inside a minimal image — the
  `oven/bun` base doesn't include `curl` by default; propose using a tiny
  inline Bun script, e.g. `CMD ["bun", "-e", "fetch('http://localhost:PORT/healthz').then(r=>process.exit(r.ok?0:1))"]`,
  rather than adding `curl`/`wget` as an extra installed package).
- `depends_on: { condition: service_healthy }` chains: `mcp-http` has no
  dependency; `devops-agent` depends on `mcp-http` being healthy;
  `orchestrator` depends on all five agents being healthy. This gives
  Compose-native startup ordering for free — a side benefit relevant to the
  earlier startup-ordering discussion, without needing a custom supervisor.
- Environment: pass through `ORCHESTRAI_PROJECT_PATH` and the
  `ORCHESTRAI_*_URL` overrides from the host via `environment:` /
  `env_file:` (never bake a real value into the image); inside the Compose
  network, `ORCHESTRAI_MCP_URL` needs to point at the MCP service's Compose
  name (`http://mcp-http:3006/mcp`) instead of `localhost`, since each
  service is a separate container with its own network namespace.

### The loopback-only validation blocker — confirmed as TWO checks, not one

Re-verified directly against source (not assumed): there are **two
independent** loopback-only checks that both reject a Compose service-name
hostname like `mcp-http`, and both must be addressed together or DevOps's
MCP calls fail even after the URL itself is corrected:

1. **Client side** — `packages/agents/devops/mcp-client.ts:52-58`:
   ```ts
   function validateMcpUrl(rawUrl: string): URL {
     const url = new URL(rawUrl)
     if (url.protocol !== "http:") throw new Error(...)
     if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
       throw new Error("Checkpoint MCP URL must use localhost or 127.0.0.1")
     }
     return url
   }
   ```
   Rejects `ORCHESTRAI_MCP_URL=http://mcp-http:3006/mcp` before DevOps ever
   attempts to connect.
2. **Server side** — `packages/mcp/http.ts:20-23`:
   ```ts
   function isAllowedRequestHost(request: Request): boolean {
     const hostname = new URL(request.url).hostname.toLowerCase()
     return hostname === "localhost" || hostname === "127.0.0.1"
   }
   ```
   Even if #1 is fixed, the MCP server itself returns `403 Forbidden host`
   for any inbound request whose URL hostname isn't `localhost`/`127.0.0.1`
   — which is exactly what an incoming request addressed to
   `http://mcp-http:3006/mcp` looks like from the server's own perspective.

**Proposed fix — a small, explicit, environment-driven allowlist on both
sides, not a loosened default:**

```ts
// shared helper, e.g. packages/shared/mcp-host-allowlist.ts
export function isAllowedMcpHost(hostname: string, envValue = process.env.ORCHESTRAI_MCP_ALLOWED_HOSTS): boolean {
  const lower = hostname.toLowerCase()
  if (lower === "localhost" || lower === "127.0.0.1") return true
  const extra = (envValue ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean)
  return extra.includes(lower)
}
```

- `validateMcpUrl()` and `isAllowedRequestHost()` both call this shared
  helper instead of their own hardcoded `===` checks.
- **Default behavior (no `ORCHESTRAI_MCP_ALLOWED_HOSTS` set) is byte-for-byte
  unchanged** — bare-metal `bun run dev` stays loopback-only exactly as
  today; this is additive, not a relaxation of the default.
- The **only** place that ever sets `ORCHESTRAI_MCP_ALLOWED_HOSTS=mcp-http`
  is the checked-in, reviewed `docker-compose.yml` — set on both the
  `mcp-http` service (for its own server-side check) and the `devops-agent`
  service (for its client-side check). This isn't a runtime value an
  untrusted party can inject independently of controlling the container
  definition itself, which they'd already need to compromise the whole
  deployment to do anyway.
- Rejected alternative: `network_mode: "host"` (would make `localhost` mean
  the same thing across both containers with zero code changes) — not
  proposed because Docker Desktop's host networking mode is Linux-only in
  practice; it does not behave the same way on Windows/Mac Docker Desktop,
  which is a real portability risk for a judge's machine.
- No named volumes for application state (all task state is in-memory by
  design; nothing to persist).

### `.dockerignore`

Exclude `node_modules/` (reinstalled in-image), `.git/`, `context/`,
`specs/`, any `.tmp-*`/scratch project directories, and this repo's own
generated artifacts from earlier testing (`Dockerfile`, `.github/` at the
repo root — those are stray outputs from testing the `dockerize` skill
against this repo itself, not part of the source tree; confirm they're
removed before this ships, not merely ignored).

### CI (GitHub Actions)

Three workflows, or three jobs in one workflow:

1. **Test** — `bun install --frozen-lockfile` then `bun test`, on every
   push/PR.
2. **Type check** — blocked until TypeScript is added as a declared
   dev dependency (`bun add -d typescript`) and a `tsconfig.json` exists;
   this spec proposes adding both as a prerequisite step, not deferring
   Dockerization until some separate initiative does it.
3. **Docker build** — `docker build .` (or `docker compose build`) to verify
   the image builds; explicitly does **not** push to any registry — that's
   out of scope.

All actions pinned to a specific commit SHA or exact version tag (not a
floating major-version tag), least-privilege `permissions:` block, no
secrets required for any of these three jobs.

## Safety Constraints

- Never bake `ORCHESTRAI_PROJECT_PATH`, credentials, or any real path from a
  developer's machine into the image — the Dockerfile must be
  machine-independent, matching the existing "no hardcoded user paths" rule.
- The container image is for demo/judging reproducibility, not a production
  deployment artifact — document this explicitly in the README, matching the
  existing "not production-grade" framing used elsewhere in this repo's docs.
- No new inbound network exposure beyond the existing 7 ports; Compose
  should bind to loopback unless there's a specific reason to expose beyond
  it for the demo.

## In Scope

1. One shared multi-stage `Dockerfile` for all 7 services.
2. `docker-compose.yml` wiring all 7 services with health checks and
   dependency ordering.
3. `.dockerignore`.
4. The shared `isAllowedMcpHost()` helper and updating both
   `validateMcpUrl()` (client) and `isAllowedRequestHost()` (server) to use
   it, plus the `ORCHESTRAI_MCP_ALLOWED_HOSTS` env var wired into
   `docker-compose.yml` for exactly the two services that need it.
5. Adding TypeScript as a declared dev dependency + minimal `tsconfig.json`
   so type checking becomes reproducible (a prerequisite for the CI type-check
   job, not a separate initiative).
6. Three CI jobs: test, type check, Docker build-only.
7. README documentation of the `docker compose up` flow as an alternative to
   `bun run dev`.

## Out of Scope

- Publishing/pushing the built image to any registry.
- Production deployment, TLS, reverse proxying, or cloud hosting.
- Persistent storage / database integration.
- Fixing `bun run --parallel`'s cascading-kill behavior for the non-Docker
  `bun run dev` path — Compose's own health-check-gated startup solves the
  equivalent problem only inside containers; the bare-metal `bun run dev`
  path is unaffected and remains a separate, already-documented limitation.
- A general `orchestrai` CLI supervisor for the non-Docker path.
- Full monorepo TypeScript strictness/linting beyond what's needed to make
  `tsc --noEmit` runnable at all.

## Acceptance Criteria

- [x] Yusuf approves this spec ("go ahead for both"), including the
      shared-allowlist approach for both the client-side (`mcp-client.ts`)
      and server-side (`http.ts`) loopback-only checks.
- [x] Bare-metal `bun run dev` (no `ORCHESTRAI_MCP_ALLOWED_HOSTS` set)
      rejects a non-loopback MCP URL exactly as it does today — proven by
      `packages/shared/mcp-host-allowlist.test.ts`.
- [x] `docker compose build` succeeds from a clean clone with no manual setup
      beyond having Docker installed. Live-verified: all 7 images built.
- [x] `docker compose up` brings up all 7 services in a working state,
      verified by hitting each of the 7 `/healthz` endpoints from the host —
      all returned `"status":"ok"`.
- [x] DevOps's container reports MCP `state: "connected"` once `mcp-http`'s
      container is healthy, without needing a fixed sleep/wait — confirmed
      via Compose's own `depends_on: condition: service_healthy` chain
      (mcp-http → devops-agent → remaining agents → orchestrator, in that
      order, observed live in `docker compose up` output).
- [x] A representative live scenario completes successfully against the
      Dockerized stack: ran both `git status` and `analyze my project`
      (which also exercises the direct DevOps→Security A2A call) against
      `ORCHESTRAI_PROJECT_PATH=/app` — both completed correctly across 3
      separate containers (orchestrator, devops-agent, mcp-http/security-agent).
- [x] `bun add -d typescript` + a minimal `tsconfig.json` make
      `bunx tsc --noEmit` runnable — confirmed; 9 pre-existing type errors
      surfaced, none fixed here (matches "need not be zero-error yet").
- [x] Three CI jobs (test, type check, Docker build) added in
      `.github/workflows/ci.yml`. Action pins verified against GitHub's API
      directly (not memorized) — one pin (`docker/setup-buildx-action`) was
      initially wrong from memory and corrected before use.
- [x] No secrets, credentials, or developer-specific paths are baked into
      the image; `.dockerignore` excludes `node_modules/`, `.git/`,
      `context/`, `specs/`, and stray root-level dogfooding artifacts.
- [x] README documents both `bun run dev` and `docker compose up` as valid
      startup paths, with the Docker path clearly marked as the
      reproducible/judge-facing option.

## Verification Results (2026-08-08)

- `bun test`: **81 pass, 0 fail, 131 expectations, 10 files** (up from
  76/120/9 — 5 new cases for `mcp-host-allowlist.test.ts`).
- Two additional real blockers found and fixed during live verification, not
  in the original draft:
  1. **Orchestrator's `KNOWN_AGENTS` was hardcoded to `localhost`** — inside
     Compose, the orchestrator container's "localhost" never reaches a
     sibling container. Migrated it to consume
     `packages/shared/agent-registry.ts` (already env-override-capable),
     resolving the pre-existing `// TODO: migrate to
     packages/shared/agent-registry.ts` comment that was already sitting in
     the code from an earlier checkpoint.
  2. **The MCP HTTP server's socket bind address (`127.0.0.1`) was hardcoded**
     — even after fixing the Host-header allowlist, a socket bound only to
     127.0.0.1 inside a container is unreachable from any other container,
     including via the published port. Added `ORCHESTRAI_MCP_BIND_HOST`
     (default unchanged at `127.0.0.1`; Compose sets `0.0.0.0` only for
     `mcp-http`).
  3. A Dockerfile bug: `oven/bun:1-slim` is Debian-based and has no
     `addgroup`/`adduser` (Alpine/busybox-only commands) — fixed to
     `groupadd`/`useradd`.
  4. A second Dockerfile bug: Bun nests `@modelcontextprotocol/sdk`'s
     install under `packages/mcp/node_modules/`, not just the root — only
     copying root `node_modules/` into the runner stage silently dropped it.
     Fixed by copying the whole deps-stage output.
- Live end-to-end: `docker compose up -d` brought up all 7 containers in the
  correct dependency order (observed: mcp-http → devops-agent → {planning,
  testing, documentation, security}-agent → orchestrator); all 7
  `/healthz` endpoints returned `ok` from the host; `git status` and
  `analyze my project` (the MCP + direct-A2A combined case) both completed
  correctly against `/app` inside the containers, with the secrets pre-check
  correctly finding and redacting a test-fixture pattern.
- `docker compose down` cleaned up containers and the network fully.
- A bare-metal `bun run dev` stack occupying the same ports had to be
  stopped to run this verification and was not restarted afterward — flagged
  to the user.

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/009-dockerization/spec.md, with [decision on MCP-URL validation for
the Compose network case].
```

or list specific changes needed. No implementation is authorized by
discussion of this draft alone.
