// specs/056-devops-preflight-and-idempotent-writes/spec.md
//
// Pure classification logic, deliberately separated from the MCP-calling
// wrapper that fetches the target's real current content — the same
// "pure deterministic adapter, unit-tested separately from the live call"
// shape apps/orchestrator/supervisor-graph.ts's classifyDispatchOutcome()
// already established in this codebase. This is what lets the four
// classification outcomes get real, fast bun test coverage without a
// live MCP server: the read outcome is passed in as data, not fetched
// here.

export type WritePreflightKind = "create" | "no-op" | "update" | "blocked"

export interface WritePreflight {
  kind: WritePreflightKind
  previousContent?: string
  reason?: string
}

/** The MCP read_project_file tool's own distinguishing error text for a
 *  genuinely absent target — see packages/mcp/index.ts's own
 *  `Path not found: ${relative_path}`. Any other failure (a "Denied: ..."
 *  containment/sensitive-filename refusal, or any other tool error) means
 *  the target cannot be safely read at all, never guessed past. */
export const PATH_NOT_FOUND_PREFIX = "Path not found:"

export type ReadOutcome =
  | { ok: true; content: string }
  | { ok: false; message: string }

/** Classifies a write operation from the target's real read outcome and
 *  what would actually be written — never a guess, and never a second,
 *  independently-maintained "does this file exist" check (existence and
 *  readability are two different questions, distinguished by the read
 *  outcome's own error text). */
export function classifyWritePreflight(newContent: string, read: ReadOutcome): WritePreflight {
  if (read.ok) {
    return { kind: read.content === newContent ? "no-op" : "update", previousContent: read.content }
  }
  if (read.message.startsWith(PATH_NOT_FOUND_PREFIX)) return { kind: "create" }
  return { kind: "blocked", reason: read.message }
}
