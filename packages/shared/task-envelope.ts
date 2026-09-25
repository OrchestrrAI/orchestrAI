// ============================================================
// SHARED TASK-ENVELOPE CONTRACT
// ============================================================
// One small runtime parser/type guard used by all five agents (and, in a
// slightly different public shape, the Orchestrator). See
// specs/006-runtime-stabilization/spec.md "Shared Task-Envelope Contract".

export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
export const MAX_TASK_ID_LENGTH = 128
export const MAX_TASK_TEXT_BYTES = 64 * 1024

// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md —
// bounded, optional routing context. `selectedSkill`/`capabilities` are
// protocol data set only by the Orchestrator (or a caller that already
// knows the target skill), never parsed from message prose. Ceilings match
// the spec's stated maximums exactly; smaller is fine, larger requires
// re-review of the spec itself.
export const SKILL_ID_PATTERN = /^[a-z][a-z0-9-]*$/
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/
export const MAX_IDENTIFIER_BYTES = 128
export const MAX_AGENTS = 32
export const MAX_SKILLS_PER_AGENT = 32
export const MAX_CAPABILITY_ENTRIES = 256
export const MAX_CAPABILITY_JSON_BYTES = 32 * 1024
// specs/121-skill-description-grounded-routing/spec.md — a short,
// code-authored Agent Card description alongside each skill id, so a
// same-family pair (e.g. edit-file vs edit-files) is distinguishable to a
// routing model that previously saw bare ids only. The longest real Agent
// Card description today runs ~375 bytes; this bound truncates it, but the
// disambiguating clause every current description leads with sits well
// inside the first 300 bytes, and a producer (see agent-capabilities.ts's
// normalizeAgentCapabilities()) truncates an over-long description rather
// than failing the snapshot closed.
export const MAX_SKILL_DESCRIPTION_BYTES = 300

const encoder = new TextEncoder()

export interface ValidatedTaskMessage {
  role: "user" | "agent"
  parts: { text: string }[]
}

/** One agent's advertised capability: bare identifiers plus, as of
 *  specs/121, an optional short description — never Agent Card `examples`
 *  or `url`, and never anything but that skill's own static, code-authored
 *  description text (never request/plan-step prose). See the capability
 *  normalizer in agent-capabilities.ts for where these are produced. */
export interface CapabilityEntry {
  agentName: string
  skillId: string
  description?: string
}

export interface ValidatedTask {
  id: string
  message: ValidatedTaskMessage
  text: string
  /** Set only by a caller (the Orchestrator, or an A2A caller that already
   *  knows the target) that has already validated which skill this task is
   *  for. When present, the receiving agent must execute exactly this skill
   *  — never re-derive one from `text` — and must reject the task outright
   *  if this id is malformed or not one it owns. Absent means "no
   *  authoritative selection was made"; the agent falls back to its
   *  existing `detectSkill(text)` behavior, unchanged. */
  selectedSkill?: string
  /** Optional capability snapshot, present only on tasks routed to Planning
   *  so it can build its LLM prompt/validator from currently-online agents
   *  rather than a hardcoded list. Not used by any other agent. */
  capabilities?: CapabilityEntry[]
}

export type TaskEnvelopeResult =
  | { ok: true; task: ValidatedTask }
  | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validates a task envelope in either of the two currently supported forms:
 *   { id, message: { role, parts: [{ text }] } }
 *   { params: { id, message: { role, parts: [{ text }] } } }
 *
 * Returns a structural failure reason rather than throwing so callers can
 * return a controlled HTTP 400 without echoing raw/unparsed input and
 * without ever calling tasks.set() or starting background work.
 */
export function parseTaskEnvelope(body: unknown): TaskEnvelopeResult {
  if (!isPlainObject(body)) return { ok: false, error: "Request body must be a JSON object" }

  let candidate: unknown = body
  if ("params" in body) {
    candidate = body.params
    if (!isPlainObject(candidate)) return { ok: false, error: "'params' must be an object" }
  }

  const task = candidate as Record<string, unknown>

  const id = task.id
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, error: "'id' must be a non-empty string" }
  }
  if (id.length > MAX_TASK_ID_LENGTH) {
    return { ok: false, error: `'id' must be at most ${MAX_TASK_ID_LENGTH} characters` }
  }
  if (!TASK_ID_PATTERN.test(id)) {
    return { ok: false, error: "'id' must match [A-Za-z0-9][A-Za-z0-9._:-]*" }
  }

  const message = task.message
  if (!isPlainObject(message)) return { ok: false, error: "'message' must be an object" }

  const role = message.role
  if (role !== "user" && role !== "agent") {
    return { ok: false, error: "'message.role' must be 'user' or 'agent'" }
  }

  const rawParts = message.parts
  if (!Array.isArray(rawParts) || rawParts.length === 0) {
    return { ok: false, error: "'message.parts' must be a non-empty array" }
  }

  const parts: { text: string }[] = []
  for (const part of rawParts) {
    if (!isPlainObject(part)) return { ok: false, error: "every 'message.parts' entry must be an object" }
    if (typeof part.text !== "string") return { ok: false, error: "every part's 'text' must be a string" }
    parts.push({ text: part.text })
  }

  const text = parts.map((p) => p.text).join(" ")
  if (text.trim().length === 0) {
    return { ok: false, error: "task text must contain at least one non-whitespace character" }
  }

  const byteLength = encoder.encode(text).byteLength
  if (byteLength > MAX_TASK_TEXT_BYTES) {
    return { ok: false, error: `task text must be at most ${MAX_TASK_TEXT_BYTES} bytes (UTF-8)` }
  }

  // specs/030 — both fields are optional and absent on every legacy
  // envelope; only validate them when present, and never mutate/store
  // anything before validation completes (this function still only
  // returns a result — callers decide what to do with it).
  let selectedSkill: string | undefined
  if ("selectedSkill" in task) {
    const raw = task.selectedSkill
    if (typeof raw !== "string" || raw.length === 0) {
      return { ok: false, error: "'selectedSkill' must be a non-empty string" }
    }
    if (encoder.encode(raw).byteLength > MAX_IDENTIFIER_BYTES) {
      return { ok: false, error: `'selectedSkill' must be at most ${MAX_IDENTIFIER_BYTES} bytes` }
    }
    if (!SKILL_ID_PATTERN.test(raw)) {
      return { ok: false, error: "'selectedSkill' must match [a-z][a-z0-9-]*" }
    }
    selectedSkill = raw
  }

  let capabilities: CapabilityEntry[] | undefined
  if ("capabilities" in task) {
    const rawCapabilities = task.capabilities
    if (!Array.isArray(rawCapabilities)) {
      return { ok: false, error: "'capabilities' must be an array" }
    }
    if (rawCapabilities.length > MAX_CAPABILITY_ENTRIES) {
      return { ok: false, error: `'capabilities' must have at most ${MAX_CAPABILITY_ENTRIES} entries` }
    }

    const entries: CapabilityEntry[] = []
    const seenPairs = new Set<string>()
    const skillsPerAgent = new Map<string, number>()
    const seenAgents = new Set<string>()

    for (const raw of rawCapabilities) {
      if (!isPlainObject(raw)) return { ok: false, error: "every 'capabilities' entry must be an object" }
      const agentName = raw.agentName
      const skillId = raw.skillId
      if (typeof agentName !== "string" || agentName.length === 0) {
        return { ok: false, error: "every capability entry's 'agentName' must be a non-empty string" }
      }
      if (typeof skillId !== "string" || skillId.length === 0) {
        return { ok: false, error: "every capability entry's 'skillId' must be a non-empty string" }
      }
      if (encoder.encode(agentName).byteLength > MAX_IDENTIFIER_BYTES || encoder.encode(skillId).byteLength > MAX_IDENTIFIER_BYTES) {
        return { ok: false, error: `capability identifiers must be at most ${MAX_IDENTIFIER_BYTES} bytes` }
      }
      if (!AGENT_NAME_PATTERN.test(agentName)) {
        return { ok: false, error: "every capability entry's 'agentName' must match [a-z][a-z0-9-]*" }
      }
      if (!SKILL_ID_PATTERN.test(skillId)) {
        return { ok: false, error: "every capability entry's 'skillId' must match [a-z][a-z0-9-]*" }
      }

      let description: string | undefined
      if ("description" in raw) {
        const rawDescription = raw.description
        if (typeof rawDescription !== "string" || rawDescription.length === 0) {
          return { ok: false, error: "every capability entry's 'description', if present, must be a non-empty string" }
        }
        if (encoder.encode(rawDescription).byteLength > MAX_SKILL_DESCRIPTION_BYTES) {
          return { ok: false, error: `capability 'description' must be at most ${MAX_SKILL_DESCRIPTION_BYTES} bytes` }
        }
        description = rawDescription
      }

      const pairKey = `${agentName} ${skillId}`
      if (seenPairs.has(pairKey)) {
        return { ok: false, error: `duplicate capability entry: ${agentName}/${skillId}` }
      }
      seenPairs.add(pairKey)

      seenAgents.add(agentName)
      if (seenAgents.size > MAX_AGENTS) {
        return { ok: false, error: `'capabilities' must not reference more than ${MAX_AGENTS} distinct agents` }
      }

      const perAgentCount = (skillsPerAgent.get(agentName) ?? 0) + 1
      skillsPerAgent.set(agentName, perAgentCount)
      if (perAgentCount > MAX_SKILLS_PER_AGENT) {
        return { ok: false, error: `'${agentName}' must not advertise more than ${MAX_SKILLS_PER_AGENT} skills` }
      }

      entries.push(description !== undefined ? { agentName, skillId, description } : { agentName, skillId })
    }

    const totalBytes = encoder.encode(JSON.stringify(entries)).byteLength
    if (totalBytes > MAX_CAPABILITY_JSON_BYTES) {
      return { ok: false, error: `'capabilities' must serialize to at most ${MAX_CAPABILITY_JSON_BYTES} bytes` }
    }

    capabilities = entries
  }

  return {
    ok: true,
    task: {
      id,
      message: { role, parts },
      text,
      ...(selectedSkill !== undefined ? { selectedSkill } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
    },
  }
}

/**
 * Validates the Orchestrator's public { text } submission shape, applying
 * the same non-empty / 64-KiB bounds as the agent envelope contract.
 */
export function parseOrchestratorSubmission(body: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: "Request body must be a JSON object" }
  const text = body.text
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, error: "'text' must be a non-empty string" }
  }
  const byteLength = encoder.encode(text).byteLength
  if (byteLength > MAX_TASK_TEXT_BYTES) {
    return { ok: false, error: `'text' must be at most ${MAX_TASK_TEXT_BYTES} bytes (UTF-8)` }
  }
  return { ok: true, text }
}

/** Parses a request body as JSON, returning a controlled failure instead of throwing. */
export async function readJsonBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, body: await req.json() }
  } catch {
    return { ok: false, error: "Malformed JSON body" }
  }
}

// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md —
// the one shared check all five agents run identically, right after
// parseTaskEnvelope() succeeds and strictly before tasks.set()/processTask()
// begin. `ownedSkillIds` must come from the agent's own exposed Agent Card
// (agentCard.skills.map(s => s.id)) — never a separate hand-maintained
// allow-list, so ownership can never drift from what the card advertises.
//
// A valid selectedSkill is not validated further here — the caller's own
// processTask() uses it directly (`task.selectedSkill ?? detectSkill(text)`).
// An absent selectedSkill always passes: legacy callers with no routing
// context keep working exactly as before this checkpoint.
export function validateSelectedSkillOwnership(
  task: ValidatedTask,
  ownedSkillIds: ReadonlySet<string>,
): { ok: true } | { ok: false; error: string } {
  if (task.selectedSkill === undefined) return { ok: true }
  if (!ownedSkillIds.has(task.selectedSkill)) {
    return { ok: false, error: `This agent does not own skill "${task.selectedSkill}"` }
  }
  return { ok: true }
}
