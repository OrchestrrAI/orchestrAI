// specs/048-guided-init-experience/spec.md — Phase 2.
//
// Display-only skill ids for the setup form's agent list. NEVER consulted
// for routing, dispatch, or approval — that authority stays exactly where it
// already is (each agent's own `agentCard` in packages/agents/*/index.ts,
// discovered live via GET /.well-known/agent.json once a process is
// running).
//
// This file exists because of a real constraint, not a shortcut: at the
// point `orchestrai init` runs, no agent process exists yet, so there is no
// live Agent Card to read. Importing an agent's module directly just to
// read its static `skills` array would pull that agent's entire dependency
// graph (Hono app, MCP client, route handlers) into the supervisor/wizard
// bundle for a one-line display hint — and `agentCard` isn't even exported.
//
// So the ids below are a small, hand-copied, plain-data mirror of each
// agent's own agentCard.skills — checked against the real source on
// 2026-09-04, not guessed. If an agent's own skills change, this file goes
// stale silently; that staleness is display-only (a setup-form hint one
// version behind), never a safety issue, since nothing here ever executes.
// Same duplication class CLAUDE.md's own "Agent logic and MCP templates are
// duplicated" limitation already accepts, scoped to five short id lists.

export interface AgentCatalogEntry {
  name: string
  /** Skill ids only, in each agent's own advertised order — not full
   *  descriptions, to keep a setup-form row on one line. */
  skillIds: string[]
}

// specs/051-planning-retirement-and-required-key/spec.md — planning-agent
// removed: it is deleted entirely, and plan-task/suggest-agents now belong
// to the Orchestrator itself (never offered as an agent choice here).
export const AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    name: "devops-agent",
    // specs/079-phase-a-connect-orphaned-tools/spec.md added 5;
    // specs/080-run-command-approved-execution/spec.md added run-command.
    skillIds: [
      "dockerize", "create-compose", "create-ci", "create-gitignore", "analyze-project", "git-status",
      "build-image", "verify-deployment", "docker-status", "git-diff", "commit-changes", "run-command",
    ],
  },
  // specs/081-testing-write-tests-skill/spec.md added write-tests.
  { name: "testing-agent", skillIds: ["run-tests", "check-coverage", "write-tests"] },
  { name: "documentation-agent", skillIds: ["generate-readme", "document-api"] },
  { name: "security-agent", skillIds: ["scan-secrets", "check-gitignore-coverage", "audit-dependencies"] },
  // specs/082-code-review-agent/spec.md — the first genuinely new agent.
  { name: "code-review-agent", skillIds: ["review-diff"] },
  // specs/083-coder-agent/spec.md — the second genuinely new agent;
  // specs/114-coder-multi-file-edit-and-create/spec.md added edit-files;
  // specs/119-coder-verify-loop-and-reviewer-depth/spec.md added
  // edit-and-verify.
  { name: "coder-agent", skillIds: ["edit-file", "edit-files", "edit-and-verify"] },
]

export function skillHint(agentName: string): string {
  return AGENT_CATALOG.find((a) => a.name === agentName)?.skillIds.join(", ") ?? ""
}
