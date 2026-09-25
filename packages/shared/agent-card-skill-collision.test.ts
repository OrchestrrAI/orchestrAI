// specs/101-per-agent-tool-access-expansion/spec.md §C
//
// Guards the trap section C documents: if two online agents advertise
// the same skill id, normalizeAgentCapabilities() (agent-capabilities.ts)
// refuses the ENTIRE capability snapshot, and every request in the
// system silently falls back to "plan-task" — proven, not just asserted,
// against a synthetic collision below. This file is the CI-catchable
// half of the fix: it walks the six REAL Agent Cards and fails if a
// developer ever introduces a colliding skill id, before it can ever
// reach a running system. The visible half (a collapsed snapshot
// surfacing in the Orchestrator's own /healthz instead of only a
// console.log) is covered in apps/orchestrator/healthz-capabilities.test.ts.
import { describe, expect, test } from "bun:test"
import { normalizeAgentCapabilities, type AgentCapabilitySource } from "./agent-capabilities"
import { agentCard as devopsCard } from "../agents/devops/index"
import { agentCard as testingCard } from "../agents/testing/index"
import { agentCard as documentationCard } from "../agents/documentation/index"
import { agentCard as securityCard } from "../agents/security/index"
import { agentCard as codeReviewCard } from "../agents/code-review/index"
import { agentCard as coderCard } from "../agents/coder/index"

const REAL_CARDS = [devopsCard, testingCard, documentationCard, securityCard, codeReviewCard, coderCard]

function toSources(cards: { name: string; skills: { id: string }[] }[]): AgentCapabilitySource[] {
  return cards.map((c) => ({ agentName: c.name, online: true, skills: c.skills.map((s) => ({ id: s.id })) }))
}

describe("agent card skill-id collision guard (specs/101 §C)", () => {
  test("the six real Agent Cards declare no skill id under more than one agent", () => {
    const result = normalizeAgentCapabilities(toSources(REAL_CARDS))
    // A failure here means a real collision exists in the live registry
    // right now — print exactly which id(s), not just "ok: false".
    expect(result.ok, result.ok ? "" : (result as { ok: false; error: string }).error).toBe(true)
  })

  test("real card skill ids are each declared by exactly one owner", () => {
    const ownerBySkill = new Map<string, string>()
    for (const card of REAL_CARDS) {
      for (const skill of card.skills) {
        const existing = ownerBySkill.get(skill.id)
        expect(existing, `skill "${skill.id}" is declared by both "${existing}" and "${card.name}"`).toBeUndefined()
        ownerBySkill.set(skill.id, card.name)
      }
    }
  })

  test("a synthetic collision is refused — proves the guard actually catches the failure mode it exists for", () => {
    const colliding: AgentCapabilitySource[] = [
      { agentName: "agent-a", online: true, skills: [{ id: "shared-skill" }] },
      { agentName: "agent-b", online: true, skills: [{ id: "shared-skill" }] },
    ]
    const result = normalizeAgentCapabilities(colliding)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("owned by more than one agent")
      expect(result.error).toContain("shared-skill")
    }
  })

  test("the same skill id from the same agent name is not a collision (dedup, not ambiguity)", () => {
    const sameAgentTwice: AgentCapabilitySource[] = [
      { agentName: "agent-a", online: true, skills: [{ id: "some-skill" }] },
      { agentName: "agent-a", online: true, skills: [{ id: "some-skill" }] },
    ]
    const result = normalizeAgentCapabilities(sameAgentTwice)
    expect(result.ok).toBe(true)
  })
})
