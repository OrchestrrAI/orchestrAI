// ============================================================
// SHARED AGENT REGISTRY
// ============================================================
// Single source of truth for known agent base URLs, used by the shared
// a2a-client and the Orchestrator's own KNOWN_AGENTS list.
//
// specs/051-planning-retirement-and-required-key/spec.md — "planning"
// removed: Planning Agent is deleted entirely.
//
// specs/073-configurable-service-ports/spec.md — each URL now falls back
// through two layers before the original hardcoded literal: an explicit
// full-URL override (ORCHESTRAI_<AGENT>_URL, unchanged, for pointing at a
// different host entirely) wins first; otherwise the URL is built from
// that agent's own configurable bind port (ORCHESTRAI_<AGENT>_PORT, see
// packages/shared/service-ports.ts) so a custom port is actually
// discoverable, not just bindable.

import { resolveServicePort } from "./service-ports"

export const agents = {
  devops:        process.env.ORCHESTRAI_DEVOPS_URL         ?? `http://localhost:${resolveServicePort("devops")}`,
  testing:       process.env.ORCHESTRAI_TESTING_URL        ?? `http://localhost:${resolveServicePort("testing")}`,
  documentation: process.env.ORCHESTRAI_DOCUMENTATION_URL  ?? `http://localhost:${resolveServicePort("documentation")}`,
  security:      process.env.ORCHESTRAI_SECURITY_URL       ?? `http://localhost:${resolveServicePort("security")}`,
  // specs/082-code-review-agent/spec.md — the first genuinely new agent
  // added since this registry existed.
  codeReview:    process.env.ORCHESTRAI_CODE_REVIEW_URL    ?? `http://localhost:${resolveServicePort("codeReview")}`,
  // specs/083-coder-agent/spec.md — the second genuinely new agent.
  coder:         process.env.ORCHESTRAI_CODER_URL          ?? `http://localhost:${resolveServicePort("coder")}`,
} as const

export type AgentName = keyof typeof agents
