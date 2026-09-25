// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md
import { describe, expect, test } from "bun:test"
import { normalizeAgentCapabilities, type AgentCapabilitySource } from "./agent-capabilities"

function source(agentName: string, online: boolean, skillIds: string[]): AgentCapabilitySource {
  return { agentName, online, skills: skillIds.map((id) => ({ id })) }
}

describe("normalizeAgentCapabilities", () => {
  test("emits only bare {agentName, skillId} entries from online agents", () => {
    const result = normalizeAgentCapabilities([
      source("devops-agent", true, ["dockerize", "git-status"]),
      source("security-agent", true, ["scan-secrets"]),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.capabilities).toEqual([
        { agentName: "devops-agent", skillId: "dockerize" },
        { agentName: "devops-agent", skillId: "git-status" },
        { agentName: "security-agent", skillId: "scan-secrets" },
      ])
    }
  })

  test("excludes offline agents entirely", () => {
    const result = normalizeAgentCapabilities([
      source("devops-agent", true, ["git-status"]),
      source("testing-agent", false, ["run-tests"]),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.capabilities.some((c) => c.agentName === "testing-agent")).toBe(false)
    }
  })

  test("excludes plan-task to prevent recursive plans; specs/065 un-excluded suggest-agents", () => {
    // specs/051 — plan-task is the Orchestrator's own internally-handled
    // skill, excluded by id regardless of which agent advertises it, so
    // a capability catalog can never make the supervisor plan a step
    // that dispatches back to itself. specs/065-llm-only-skill-routing/
    // spec.md un-excluded "suggest-agents": with the keyword tier gone,
    // the capability router is the only thing that can name it, and it
    // needs to see it in the snapshot to do so. suggest-agents is still
    // special-cased before any agent dispatch, so exposing it here can't
    // cause a recursive plan.
    const result = normalizeAgentCapabilities([
      source("some-agent", true, ["plan-task", "suggest-agents"]),
      source("devops-agent", true, ["git-status"]),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      // plan-task filtered out, suggest-agents kept.
      expect(result.capabilities).toEqual([
        { agentName: "devops-agent", skillId: "git-status" },
        { agentName: "some-agent", skillId: "suggest-agents" },
      ])
    }
  })

  test("sorts deterministically regardless of input order", () => {
    const a = normalizeAgentCapabilities([
      source("testing-agent", true, ["run-tests"]),
      source("devops-agent", true, ["git-status"]),
    ])
    const b = normalizeAgentCapabilities([
      source("devops-agent", true, ["git-status"]),
      source("testing-agent", true, ["run-tests"]),
    ])
    expect(a).toEqual(b)
  })

  test("rejects an ambiguous skill id owned by more than one agent, does not pick one arbitrarily", () => {
    const result = normalizeAgentCapabilities([
      source("devops-agent", true, ["git-status"]),
      source("testing-agent", true, ["git-status"]),
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("git-status")
  })

  test("returns an explicit empty-state error, never a hardcoded fallback catalog", () => {
    const result = normalizeAgentCapabilities([source("some-agent", true, ["plan-task"])])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("no usable operational capability is available")
  })

  test("empty source list produces the same explicit empty-state error", () => {
    const result = normalizeAgentCapabilities([])
    expect(result.ok).toBe(false)
  })

  test("rejects a malformed skill id rather than silently dropping it", () => {
    const result = normalizeAgentCapabilities([source("devops-agent", true, ["Bad_Skill"])])
    expect(result.ok).toBe(false)
  })

  test("rejects more than MAX_AGENTS distinct online agents", () => {
    const sources = Array.from({ length: 33 }, (_, i) => source(`agent-${i}`, true, ["one-skill"]))
    const result = normalizeAgentCapabilities(sources)
    expect(result.ok).toBe(false)
  })

  test("newly advertised skill appears without any code change (adding a source is enough)", () => {
    const before = normalizeAgentCapabilities([source("devops-agent", true, ["git-status"])])
    const after = normalizeAgentCapabilities([source("devops-agent", true, ["git-status", "dockerize"])])
    expect(before.ok && before.capabilities.length).toBe(1)
    expect(after.ok && after.capabilities.length).toBe(2)
  })

  test("removed/stale skill disappears without any code change", () => {
    const before = normalizeAgentCapabilities([source("devops-agent", true, ["git-status", "dockerize"])])
    const after = normalizeAgentCapabilities([source("devops-agent", true, ["git-status"])])
    expect(before.ok && before.capabilities.length).toBe(2)
    expect(after.ok && after.capabilities.length).toBe(1)
  })

  // specs/121-skill-description-grounded-routing/spec.md
  describe("skill descriptions", () => {
    test("a skill's own description passes through verbatim", () => {
      const result = normalizeAgentCapabilities([
        { agentName: "coder-agent", online: true, skills: [{ id: "edit-file", description: "an existing file only" }] },
      ])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.capabilities).toEqual([{ agentName: "coder-agent", skillId: "edit-file", description: "an existing file only" }])
      }
    })

    test("a missing description produces an entry with no description field, not undefined", () => {
      const result = normalizeAgentCapabilities([source("devops-agent", true, ["git-status"])])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.capabilities).toEqual([{ agentName: "devops-agent", skillId: "git-status" }])
        expect("description" in result.capabilities[0]!).toBe(false)
      }
    })

    test("an over-long description is truncated, not a reason to fail the snapshot closed", () => {
      const longDescription = "x".repeat(500)
      const result = normalizeAgentCapabilities([
        { agentName: "coder-agent", online: true, skills: [{ id: "edit-file", description: longDescription }] },
      ])
      expect(result.ok).toBe(true)
      if (result.ok) {
        const description = result.capabilities[0]?.description ?? ""
        expect(description.length).toBeLessThan(longDescription.length)
        expect(description.endsWith("…")).toBe(true)
        expect(new TextEncoder().encode(description).byteLength).toBeLessThanOrEqual(300)
      }
    })
  })
})
