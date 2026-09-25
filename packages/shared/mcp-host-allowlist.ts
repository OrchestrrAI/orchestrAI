// ============================================================
// MCP LOOPBACK HOST ALLOWLIST
// ============================================================
// Both the DevOps MCP client and the MCP HTTP server independently enforce a
// loopback-only host check (see specs/005-mcp-agent-integration/spec.md Decision
// 5 and specs/009-dockerization/spec.md). This shared helper is the single place
// that decides which hostnames are allowed, so both sides stay in sync.
//
// Default behavior (no ORCHESTRAI_MCP_ALLOWED_HOSTS set) is unchanged from
// the original checkpoint: only "localhost" and "127.0.0.1" are allowed.
// ORCHESTRAI_MCP_ALLOWED_HOSTS adds specific additional hostnames — intended
// only for the Docker Compose network case (e.g. "mcp-http"), set in the
// checked-in docker-compose.yml, never as a general escape hatch.

export function isAllowedMcpHost(
  hostname: string,
  envValue: string | undefined = process.env.ORCHESTRAI_MCP_ALLOWED_HOSTS,
): boolean {
  const lower = hostname.toLowerCase()
  if (lower === "localhost" || lower === "127.0.0.1") return true

  const extra = (envValue ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)

  return extra.includes(lower)
}
