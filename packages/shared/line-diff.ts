// specs/040-approval-preview-content-diff/spec.md — a small, dependency-free
// line-based diff (Decision A: no new package across the 3 rendering
// surfaces this feeds). Classic LCS via dynamic programming — simple to
// verify, not the fastest algorithm available, but every caller only ever
// invokes it on content already known to be under the size cap below
// (checked before computing, never after), so the O(m*n) cost stays bounded
// in practice.
//
// This module is the canonical implementation, directly imported by
// apps/tui/index.tsx (a real compiled TypeScript file). The two browser
// dashboards (apps/orchestrator/index.ts, packages/agents/devops/index.ts)
// render their approval cards from inline <script> template strings with no
// bundler linking them to this file — the exact same constraint
// specs/033/035 already hit for renderApprovalCard()/escapeHtml(), which
// they solved by porting the function verbatim rather than importing it.
// This module's algorithm is ported the same way for those two surfaces;
// see the matching comment at each inline copy.

// specs/040 Decision B: reuses this file's own TASK_RESULT_MAX_BYTES
// (64 KiB) and utf8ByteLength() rather than defining a second copy of
// either.
import { TASK_RESULT_MAX_BYTES, utf8ByteLength } from "./audit"

export type DiffLineType = "added" | "removed" | "unchanged"

export interface DiffLine {
  type: DiffLineType
  text: string
}

/** Computes a line-level diff between `before` and `after` via the
 *  standard LCS (longest common subsequence) construction: build the LCS
 *  length table, then walk it back to front to emit unchanged/removed/
 *  added lines in order. Empty input on either side is handled naturally
 *  (an empty `before` yields an all-"added" diff, and vice versa). */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = before.length > 0 ? before.split("\n") : []
  const b = after.length > 0 ? after.split("\n") : []
  const m = a.length
  const n = b.length

  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ type: "unchanged", text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      result.push({ type: "removed", text: a[i]! })
      i++
    } else {
      result.push({ type: "added", text: b[j]! })
      j++
    }
  }
  while (i < m) {
    result.push({ type: "removed", text: a[i]! })
    i++
  }
  while (j < n) {
    result.push({ type: "added", text: b[j]! })
    j++
  }
  return result
}

/** specs/040 Decision B: reuses `packages/shared/audit.ts`'s own
 *  `TASK_RESULT_MAX_BYTES` (64 KiB), checked against the *combined*
 *  content/previousContent pair, before a diff is ever attempted — never
 *  after a partial one is computed. */
export const CONTENT_PREVIEW_MAX_BYTES = TASK_RESULT_MAX_BYTES

export type ContentPreviewResult =
  | { kind: "diff"; lines: DiffLine[] }
  | { kind: "plain"; text: string }
  | { kind: "omitted"; totalBytes: number }
  | { kind: "none" }

/** The one decision point every rendering surface calls before drawing
 *  anything: given optional content/previousContent, decide whether to
 *  show a diff, plain new content, an explicit "too large" note, or
 *  nothing (today's unchanged rendering for every kind this spec doesn't
 *  touch). Deliberately returns a decision, not markup — each surface
 *  renders it in its own idiom (HTML card, TUI rows). */
export function buildContentPreview(content: string | undefined, previousContent: string | undefined): ContentPreviewResult {
  if (content === undefined && previousContent === undefined) return { kind: "none" }
  const total = utf8ByteLength(content ?? "") + utf8ByteLength(previousContent ?? "")
  if (total > CONTENT_PREVIEW_MAX_BYTES) return { kind: "omitted", totalBytes: total }
  if (previousContent !== undefined) return { kind: "diff", lines: computeLineDiff(previousContent, content ?? "") }
  return { kind: "plain", text: content ?? "" }
}
