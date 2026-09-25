FROM oven/bun:1-slim AS base
LABEL app="devops-mcp-server"
WORKDIR /app

# specs/082-code-review-agent/verification.md — live-caught 2026-09-14,
# the same docker-compose pass as the bun-install fix below: the base
# image has neither `git` (needed by packages/mcp/index.ts's git_status/
# git_diff/git_commit tools, shelled out to via safeExec()) nor `curl`
# (needed by this file's own HEALTHCHECK below — docker-compose.yml
# overrides every service's healthcheck with a `bun -e fetch(...)` test
# that never needed curl, which is exactly why this was never caught by
# any `docker compose up` pass before now; a bare `docker run` with no
# compose override would have shown this container permanently
# unhealthy). Neither gap was hit by any prior spec's own live-Docker
# pass because none of them actually dispatched a real git-based DevOps/
# Code-Review skill *through the compose network* until this one did.
RUN apt-get update && apt-get install -y --no-install-recommends git curl \
  && rm -rf /var/lib/apt/lists/*

# specs/082-code-review-agent/verification.md — live-caught 2026-09-14
# while closing the docker-compose live-verification gap. The previous
# two-stage design (COPY only root package.json/bun.lock into a `deps`
# stage, `bun install`, then COPY --from=deps just /app/node_modules into
# the final stage) silently dropped every dependency Bun installs into a
# WORKSPACE MEMBER's own node_modules rather than hoisting to the root.
# @modelcontextprotocol/sdk (declared only in packages/mcp, packages/
# agents/code-review, packages/agents/devops, and packages/shared — never
# in the root package.json) is exactly such a case on the current Bun
# version: `bun install` resolves it into a shared `/app/node_modules/
# .bun/...` store and symlinks it from each *requiring workspace's own*
# node_modules (e.g. packages/mcp/node_modules/@modelcontextprotocol),
# never from the root one. The old deps stage only ever copied the root
# node_modules forward, and `.dockerignore`'s `**/node_modules` rule then
# stripped every nested one from the subsequent `COPY . .` — so the final
# image never contained the symlink at all, and `mcp:http` crashed on
# startup with "Cannot find module '.../webStandardStreamableHttp.js'".
# Fixed by installing in the SAME stage/layer as the final image, after
# the full source (including every workspace's own package.json) is
# already present — Bun's own install output (both hoisted-to-root and
# per-workspace-nested symlinks) then lands directly in the image with
# nothing to lose in a cross-stage copy. This trades the old deps-layer
# build-cache optimization for correctness; not worth reintroducing here
# without first proving the two-stage split can preserve every nested
# symlink, which the live-verification pass above did not attempt.
COPY . .
RUN bun install --frozen-lockfile --production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3000/healthz || exit 1
USER bun
CMD ["bun", "run", "index.ts"]
