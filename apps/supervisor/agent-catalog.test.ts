// specs/048-guided-init-experience/spec.md — Phase 2.
//
// The setup form's agent-catalog is a hand-copied, display-only mirror of
// each agent's real agentCard.skills (see agent-catalog.ts's own header for
// why it has to be a copy rather than a live import). A hand-copy can go
// stale silently, so this test makes staleness loud instead: it imports
// each real agent module and asserts the catalog's skill ids match the
// agent's own advertised skill ids exactly, in the same order.
import { describe, expect, test } from "bun:test"
import { AGENT_CATALOG, skillHint } from "./agent-catalog"

describe("AGENT_CATALOG matches each agent's own real agentCard.skills", () => {
  test("devops-agent", async () => {
    const { agentCard } = await import("../../packages/agents/devops/index")
    const entry = AGENT_CATALOG.find((a) => a.name === "devops-agent")
    expect(entry?.skillIds).toEqual(agentCard.skills.map((s) => s.id))
  })

  test("testing-agent", async () => {
    const { agentCard } = await import("../../packages/agents/testing/index")
    const entry = AGENT_CATALOG.find((a) => a.name === "testing-agent")
    expect(entry?.skillIds).toEqual(agentCard.skills.map((s) => s.id))
  })

  test("documentation-agent", async () => {
    const { agentCard } = await import("../../packages/agents/documentation/index")
    const entry = AGENT_CATALOG.find((a) => a.name === "documentation-agent")
    expect(entry?.skillIds).toEqual(agentCard.skills.map((s) => s.id))
  })

  test("security-agent", async () => {
    const { agentCard } = await import("../../packages/agents/security/index")
    const entry = AGENT_CATALOG.find((a) => a.name === "security-agent")
    expect(entry?.skillIds).toEqual(agentCard.skills.map((s) => s.id))
  })

  test("code-review-agent", async () => {
    const { agentCard } = await import("../../packages/agents/code-review/index")
    const entry = AGENT_CATALOG.find((a) => a.name === "code-review-agent")
    expect(entry?.skillIds).toEqual(agentCard.skills.map((s) => s.id))
  })

  test("coder-agent", async () => {
    const { agentCard } = await import("../../packages/agents/coder/index")
    const entry = AGENT_CATALOG.find((a) => a.name === "coder-agent")
    expect(entry?.skillIds).toEqual(agentCard.skills.map((s) => s.id))
  })

  test("no agent is missing from the catalog and none is extra", () => {
    // specs/051-planning-retirement-and-required-key/spec.md —
    // planning-agent is deleted, never offered as a setup-form choice.
    // specs/082-code-review-agent/spec.md added code-review-agent;
    // specs/083-coder-agent/spec.md added coder-agent.
    expect(AGENT_CATALOG.map((a) => a.name).sort()).toEqual(
      ["devops-agent", "testing-agent", "documentation-agent", "security-agent", "code-review-agent", "coder-agent"].sort(),
    )
  })
})

describe("skillHint", () => {
  test("joins a known agent's skill ids", () => {
    expect(skillHint("devops-agent")).toBe(
      "dockerize, create-compose, create-ci, create-gitignore, analyze-project, git-status, build-image, verify-deployment, docker-status, git-diff, commit-changes, run-command",
    )
  })

  test("an unknown agent name returns an empty string, not a crash", () => {
    expect(skillHint("not-a-real-agent")).toBe("")
  })
})
