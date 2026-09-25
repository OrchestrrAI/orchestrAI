import * as path from "path"

export const TARGET_PATH_REQUIRED_ERROR =
  "No target project configured. Provide an absolute path in the task or set ORCHESTRAI_PROJECT_PATH."

const OUTPUT_PATH_PATTERN = /(?:save to|write to)\s+(?:"[^"]+"|'[^']+'|\S+)/gi
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/

// specs/020-semantic-intent-fallback/spec.md — found live during that
// spec's own verification: a real task's full text always includes a
// target path ("... at C:\my-app"), and feeding that whole string to
// the semantic classifier measurably dilutes the mean-pooled embedding
// enough to drop a clear, correct match below threshold once the path
// clause is appended. A naive single-match strip was tried first and
// found — live, not theorized — to break on ordinary sentences
// containing an earlier, spurious "preposition + single word" match
// before the real path clause: "wrap this up in a container image at
// C:\..." matches "in a" first, and a non-global replace only removes
// that first hit, leaving the real path clause completely unstripped.
// Fixed by scanning every match globally and only acting on the one(s)
// whose captured value actually validates as an absolute path
// (WINDOWS_ABSOLUTE_PATH/leading-"/", the same check
// normalizeAbsolutePath() already uses) — ordinary prose like "in a
// container" is left alone because "a" fails that check.
//
// specs/087-target-path-resolver-first-match-bug/spec.md — the
// identical scan-and-validate approach was found live to be missing
// from extractExplicitTargetPath() below, the actual target-path
// RESOLVER every skill depends on (as opposed to stripPathPhrases()'s
// own text-cleaning use, which already had it) — it used a non-global
// match, took whatever came first, and gave up entirely if that one
// wasn't a real path, even when a genuine absolute path sat later in
// the exact same string. Both functions now share this one pattern.
// specs/140 — "for <path>" and "on <path>" name a target too ("prepare a
// release for C:\proj: …"). Every match is still validated as an absolute
// path, so "tests for login" or "on port 4000" never resolve.
const EXPLICIT_PATH_PATTERN_GLOBAL = /(?:^|\s)(?:at|in|to|from|for|on)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/gi

// specs/088-target-path-resolver-trailing-colon-bug/spec.md — found
// live: the Coder Agent's own "edit <file> at <path>: <instruction>"
// convention puts a colon immediately after the path clause with no
// intervening space, and this trailing-punctuation strip didn't cover
// ":" — the captured value kept the colon (e.g. "C:\real\path:"),
// which then genuinely doesn't exist on disk. Both trailing-strip
// copies in this file (here and stripPathPhrases()'s own) share this
// one character class so they can't silently diverge on what counts as
// trailing noise.
const TRAILING_PATH_PUNCTUATION = /[.,:;]+$/

function normalizeAbsolutePath(value: string, source: string): string {
  const candidate = value.trim().replace(TRAILING_PATH_PUNCTUATION, "")

  if (WINDOWS_ABSOLUTE_PATH.test(candidate)) {
    return path.win32.normalize(candidate)
  }

  if (candidate.startsWith("/")) {
    return path.posix.normalize(candidate)
  }

  throw new Error(`${source} must be an absolute path: ${candidate}`)
}

// See EXPLICIT_PATH_PATTERN_GLOBAL's own comment above for why this
// scans every match instead of stopping at the first.
export function extractExplicitTargetPath(taskText: string): string | null {
  // Output destinations belong to extractSavePath() and must never be mistaken
  // for the project/source path when a task says "save to" or "write to".
  const inputOnly = taskText.replace(OUTPUT_PATH_PATTERN, "")
  for (const match of inputOnly.matchAll(EXPLICIT_PATH_PATTERN_GLOBAL)) {
    const value = match[1] ?? match[2] ?? match[3]
    if (!value) continue
    try {
      return normalizeAbsolutePath(value, "Task path")
    } catch {
      // Plain English "at/in/to/from <word>" matches as readily as a
      // real path — e.g. "...how to do that...". Not a disqualifying
      // failure; keep scanning for a later match that does validate.
      continue
    }
  }
  return null
}

export function resolveTargetPath(
  taskText: string,
  options: { env?: Record<string, string | undefined> } = {},
): string {
  const explicitPath = extractExplicitTargetPath(taskText)
  if (explicitPath) return explicitPath

  const env = options.env ?? process.env
  const configuredPath = env.ORCHESTRAI_PROJECT_PATH?.trim()
  if (configuredPath) {
    const unquoted = configuredPath.replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2")
    return normalizeAbsolutePath(unquoted, "ORCHESTRAI_PROJECT_PATH")
  }

  throw new Error(TARGET_PATH_REQUIRED_ERROR)
}

export function stripPathPhrases(taskText: string): string {
  const withoutOutputPaths = taskText.replace(OUTPUT_PATH_PATTERN, "")
  const withoutRealPaths = withoutOutputPaths.replace(
    EXPLICIT_PATH_PATTERN_GLOBAL,
    (full, quoted1, quoted2, bare) => {
      const candidate = String(quoted1 ?? quoted2 ?? bare ?? "").trim().replace(TRAILING_PATH_PUNCTUATION, "")
      const looksLikePath = WINDOWS_ABSOLUTE_PATH.test(candidate) || candidate.startsWith("/")
      return looksLikePath ? "" : full
    },
  )
  return withoutRealPaths.replace(/\s+/g, " ").trim()
}

// ============================================================
// A2A TYPES
// ============================================================

export interface AgentSkill {
  id: string
  name: string
  description: string
  examples?: string[]
}

export interface AgentCard {
  name: string
  description: string
  url: string
  version: string
  skills: AgentSkill[]
}

export interface TaskMessage {
  role: "user" | "agent"
  parts: { text: string }[]
}

export type TaskStatus =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "input-required"

export interface Task {
  id: string
  message: TaskMessage
  skill?: string
}

export interface TaskResult {
  id: string
  status: TaskStatus
  result?: string
  error?: string
  requiresApproval?: boolean
  step?: string
}

// ============================================================
// ORCHESTRATOR TYPES
// ============================================================

export interface AgentRegistry {
  [agentName: string]: {
    card: AgentCard
    url: string
  }
}

// ============================================================
// MCP TYPES
// ============================================================

export interface McpToolResult {
  content: { type: "text"; text: string }[]
}
