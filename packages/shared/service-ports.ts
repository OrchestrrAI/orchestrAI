// ============================================================
// SERVICE PORT RESOLUTION
// ============================================================
// specs/073-configurable-service-ports/spec.md — every service's own bind
// port, and every consumer's default URL for reaching it, now resolve
// through one ORCHESTRAI_<SERVICE>_PORT env var per service, falling back
// to that service's pre-existing hardcoded literal. This is the single
// source of truth for both the default port table and the parsing rule
// (an unset or non-numeric value silently falls back to the default —
// never throws, never blocks a service from starting).

export const SERVICE_PORT_ENV_VARS = {
  orchestrator: "ORCHESTRAI_ORCHESTRATOR_PORT",
  devops: "ORCHESTRAI_DEVOPS_PORT",
  testing: "ORCHESTRAI_TESTING_PORT",
  documentation: "ORCHESTRAI_DOCUMENTATION_PORT",
  security: "ORCHESTRAI_SECURITY_PORT",
  mcpHttp: "ORCHESTRAI_MCP_PORT",
  // specs/082-code-review-agent/spec.md — the first genuinely new agent
  // added since this table existed; 3001 (Planning Agent's own retired
  // port, specs/051) is deliberately never reused, so this is 3007.
  codeReview: "ORCHESTRAI_CODE_REVIEW_PORT",
  // specs/083-coder-agent/spec.md — the second genuinely new agent.
  coder: "ORCHESTRAI_CODER_PORT",
} as const

export type ServicePortName = keyof typeof SERVICE_PORT_ENV_VARS

export const DEFAULT_SERVICE_PORTS: Record<ServicePortName, number> = {
  orchestrator: 3000,
  devops: 3002,
  testing: 3003,
  documentation: 3004,
  security: 3005,
  mcpHttp: 3006,
  codeReview: 3007,
  coder: 3008,
}

/**
 * Resolves one service's bind port: ORCHESTRAI_<SERVICE>_PORT when set and a
 * valid TCP port number (1-65535), otherwise the service's own default.
 * Never throws — an unset or malformed value is treated identically to
 * absent, so a service always has a port to bind.
 */
export function resolveServicePort(service: ServicePortName, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SERVICE_PORT_ENV_VARS[service]]
  if (raw === undefined || raw === "") return DEFAULT_SERVICE_PORTS[service]
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return DEFAULT_SERVICE_PORTS[service]
  return parsed
}
