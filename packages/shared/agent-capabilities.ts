// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md
//
// Turns live agent registry data into the bounded, prose-free capability
// snapshot the Orchestrator's adaptive supervisor prompts/validates
// against (originally built for Planning Agent's own LLM harness, before
// specs/051 deleted that agent). Deliberately
// decoupled from the Orchestrator's own AgentCard/RegisteredAgent shape —
// callers map their own registry into AgentCapabilitySource, so this module
// has no dependency on Orchestrator internals and no HTTP client of its own.
import {
  AGENT_NAME_PATTERN,
  MAX_AGENTS,
  MAX_CAPABILITY_ENTRIES,
  MAX_CAPABILITY_JSON_BYTES,
  MAX_SKILL_DESCRIPTION_BYTES,
  MAX_SKILLS_PER_AGENT,
  SKILL_ID_PATTERN,
  type CapabilityEntry,
} from "./task-envelope"

export type { CapabilityEntry }

/** plan-task is excluded so a capability catalog can never cause the
 *  supervisor to plan a step that dispatches back to itself — recursive
 *  plans are out of scope entirely, not merely undesirable. Originally
 *  about Planning Agent specifically (deleted by specs/051); the
 *  exclusion stays because it's the Orchestrator's own internally-
 *  handled skill, never a real agent's, regardless.
 *
 *  specs/065-llm-only-skill-routing/spec.md — "suggest-agents" was
 *  excluded here too until this spec, on the same original reasoning.
 *  Checked directly before removing it:
 *  `normalizeAgentCapabilities()` has exactly one real caller
 *  (`buildCapabilitySnapshot()` in `apps/orchestrator/index.ts`, itself
 *  called only from `detectSkill()`'s own capability-router tier) — this
 *  is not shared with the adaptive supervisor's own plan-step capability
 *  catalog, which is built entirely separately and never sees this
 *  exclusion list at all. So un-excluding "suggest-agents" only ever
 *  makes it nameable by the router (root-request skill selection,
 *  already special-cased before any agent dispatch in
 *  `dispatchRootTask()`), never reachable as a mid-plan step the
 *  supervisor's own dispatch mechanism wouldn't know how to execute —
 *  the exact recursion concern this exclusion originally guarded
 *  against. */
const EXCLUDED_SKILL_IDS = new Set(["plan-task"])

// specs/121-skill-description-grounded-routing/spec.md — `description` is
// each skill's own static Agent Card description (never request/plan-step
// prose), threaded through so the router prompt can distinguish
// same-family skill ids (e.g. edit-file vs edit-files) it previously saw
// as bare ids only.
export interface AgentCapabilitySource {
  agentName: string
  online: boolean
  skills: { id: string; description?: string }[]
}

export type NormalizeCapabilitiesResult =
  | { ok: true; capabilities: CapabilityEntry[] }
  | { ok: false; error: string }

const encoder = new TextEncoder()

// specs/121-skill-description-grounded-routing/spec.md — truncates on UTF-8
// byte length (never a reason to fail the snapshot closed), trimming down
// one character at a time so a multi-byte character is never split.
// Undefined/empty in, undefined out.
function truncateDescription(description: string | undefined): string | undefined {
  if (!description) return undefined
  const bytes = encoder.encode(description)
  if (bytes.byteLength <= MAX_SKILL_DESCRIPTION_BYTES) return description
  // "…" (U+2026) is 3 UTF-8 bytes — reserved up front so the final
  // truncated-plus-ellipsis string never itself exceeds the bound.
  const ellipsisBytes = encoder.encode("…").byteLength
  let text = description
  while (encoder.encode(text).byteLength + ellipsisBytes > MAX_SKILL_DESCRIPTION_BYTES && text.length > 0) {
    text = text.slice(0, -1)
  }
  return `${text}…`
}

/**
 * Normalizes a set of agent registry entries into a bounded, deterministic
 * capability snapshot. Never returns a hardcoded fallback on failure — every
 * failure path is an explicit `{ ok: false }`, which callers must treat as
 * "no usable catalog", not silently substitute for one.
 */
export function normalizeAgentCapabilities(sources: AgentCapabilitySource[]): NormalizeCapabilitiesResult {
  const online = sources.filter((s) => s.online)

  const agentNames = new Set(online.map((s) => s.agentName))
  if (agentNames.size > MAX_AGENTS) {
    return { ok: false, error: `capability source has more than ${MAX_AGENTS} distinct online agents` }
  }

  const ownerBySkill = new Map<string, string>()
  const ambiguousSkills = new Set<string>()
  const entriesByPair = new Map<string, CapabilityEntry>()

  for (const source of online) {
    if (!AGENT_NAME_PATTERN.test(source.agentName)) {
      return { ok: false, error: `invalid agent name: "${source.agentName}"` }
    }

    const skills = source.skills.filter((s) => !EXCLUDED_SKILL_IDS.has(s.id))
    if (skills.length > MAX_SKILLS_PER_AGENT) {
      return { ok: false, error: `agent "${source.agentName}" advertises more than ${MAX_SKILLS_PER_AGENT} skills` }
    }

    for (const skill of skills) {
      const skillId = skill.id
      if (!SKILL_ID_PATTERN.test(skillId)) {
        return { ok: false, error: `invalid skill id: "${skillId}"` }
      }

      const existingOwner = ownerBySkill.get(skillId)
      if (existingOwner && existingOwner !== source.agentName) {
        ambiguousSkills.add(skillId)
        continue
      }
      ownerBySkill.set(skillId, source.agentName)
      // specs/121 — truncated, never rejected: a too-long description is
      // never a reason to fail the whole snapshot closed.
      const description = truncateDescription(skill.description)
      entriesByPair.set(
        `${source.agentName} ${skillId}`,
        description !== undefined ? { agentName: source.agentName, skillId, description } : { agentName: source.agentName, skillId },
      )
    }
  }

  if (ambiguousSkills.size > 0) {
    return {
      ok: false,
      error: `skill id(s) owned by more than one agent, refusing to pick one arbitrarily: ${[...ambiguousSkills].sort().join(", ")}`,
    }
  }

  const capabilities = Array.from(entriesByPair.values()).sort((a, b) =>
    a.agentName === b.agentName ? a.skillId.localeCompare(b.skillId) : a.agentName.localeCompare(b.agentName),
  )

  if (capabilities.length === 0) {
    return { ok: false, error: "no usable operational capability is available" }
  }
  if (capabilities.length > MAX_CAPABILITY_ENTRIES) {
    return { ok: false, error: `capability snapshot has more than ${MAX_CAPABILITY_ENTRIES} total entries` }
  }

  const totalBytes = encoder.encode(JSON.stringify(capabilities)).byteLength
  if (totalBytes > MAX_CAPABILITY_JSON_BYTES) {
    return { ok: false, error: `capability snapshot exceeds ${MAX_CAPABILITY_JSON_BYTES} bytes serialized` }
  }

  return { ok: true, capabilities }
}
