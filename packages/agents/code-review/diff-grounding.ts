// specs/082-code-review-agent/spec.md §3
//
// Pure, no I/O — parses a real unified diff into the set of file:line
// locations a review comment is allowed to cite, and checks a proposed
// citation against it. This is the structural half of the grounding
// guarantee: the LLM harness's own validator calls isGrounded() to
// reject (and retry-with-feedback, then salvage-filter) any comment
// citing a location this parser doesn't recognize as real.
//
// Deliberately narrow, matching this codebase's own "shallow, not a
// real parser" precedent (specs/043's containsForbiddenVulnerabilityClaim
// is a regex, not a CVE database): this only tracks which lines exist in
// the diff's own post-image, not full git semantics.

export interface ParsedDiff {
  /** Normalized file path -> the set of new-file line numbers a review
   *  comment may legitimately cite (added or context lines only — a
   *  removed line is never valid, per specs/082's own confirmed scope
   *  cut). */
  validLines: Map<string, Set<number>>
  /** Every file path the diff actually touches, in order of first
   *  appearance — used for prompt-building and the "files reviewed"
   *  count, independent of whether any hunk contributed valid lines
   *  (a pure rename or a binary-file diff touches a file with zero
   *  valid lines). */
  touchedFiles: string[]
}

const DIFF_GIT_HEADER = /^diff --git /
const NEW_FILE_HEADER = /^\+\+\+ (?:b\/(.+)|\/dev\/null)\s*$/
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const BINARY_MARKER = /^Binary files /

/** Strips a leading "a/"/"b/" (git's own default prefixes) and
 *  normalizes backslashes to forward slashes — a diff's own paths are
 *  always forward-slash, even on Windows, but a model's citation might
 *  plausibly use the OS-native separator. */
function normalizePath(rawPath: string): string {
  return rawPath.replace(/^[ab]\//, "").replace(/\\/g, "/")
}

export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const validLines = new Map<string, Set<number>>()
  const touchedFiles: string[] = []

  // Split into one chunk per file, keeping the "diff --git" line as
  // the chunk's own first line so per-file state never leaks across a
  // boundary.
  const lines = diffText.split("\n")
  let currentFile: string | null = null
  let currentLineSet: Set<number> | null = null
  let newLineNum = 0
  let inHunk = false

  for (const line of lines) {
    if (DIFF_GIT_HEADER.test(line)) {
      // A new file chunk begins — reset per-file state. The file's own
      // path is confirmed by the "+++ b/<path>" line just below this
      // one, not parsed from "diff --git" itself (which can disagree
      // with the sanitized +++/--- lines for a rename).
      currentFile = null
      currentLineSet = null
      inHunk = false
      continue
    }

    if (BINARY_MARKER.test(line)) {
      // "Binary files a/... and b/... differ" — no hunks follow, no
      // valid lines. The file is still touched (worth naming in a
      // "files reviewed" count) but contributes nothing citable.
      inHunk = false
      continue
    }

    const newFileMatch = line.match(NEW_FILE_HEADER)
    if (newFileMatch) {
      inHunk = false
      if (newFileMatch[1] === undefined) {
        // "+++ /dev/null" — a deleted file. No valid lines; still
        // record it as touched so a "files reviewed" count and prompt
        // context can mention it was deleted, without pretending
        // anything in it is citable.
        currentFile = null
        currentLineSet = null
        continue
      }
      const path = normalizePath(newFileMatch[1])
      currentFile = path
      if (!touchedFiles.includes(path)) touchedFiles.push(path)
      currentLineSet = validLines.get(path) ?? new Set<number>()
      validLines.set(path, currentLineSet)
      continue
    }

    const hunkMatch = line.match(HUNK_HEADER)
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1]!, 10)
      inHunk = true
      continue
    }

    if (!inHunk || currentFile === null || currentLineSet === null) continue

    // "\ No newline at end of file" — a marker line, not a diff content
    // line. Never increments the counter, never valid.
    if (line.startsWith("\\")) continue

    if (line.startsWith("+")) {
      currentLineSet.add(newLineNum)
      newLineNum++
    } else if (line.startsWith("-")) {
      // A removed line — never valid, never increments the new-file
      // counter (it doesn't exist in the new file at all).
    } else {
      // A context line (starts with a space, or is empty inside a
      // hunk body) — present in both old and new, and a legitimate
      // citation target.
      currentLineSet.add(newLineNum)
      newLineNum++
    }
  }

  return { validLines, touchedFiles }
}

export function isGrounded(parsed: ParsedDiff, file: string, line: number): boolean {
  const normalized = normalizePath(file)
  const lines = parsed.validLines.get(normalized)
  return lines !== undefined && lines.has(line)
}

/** A capped, human-readable list of real "file:line" pairs — used to
 *  tell a model exactly what it may cite when its previous response
 *  named something that wasn't, without dumping an unbounded list into
 *  the retry prompt. */
export function describeValidLocations(parsed: ParsedDiff, cap = 30): string {
  const pairs: string[] = []
  for (const [file, lineSet] of parsed.validLines) {
    for (const line of lineSet) {
      pairs.push(`${file}:${line}`)
      if (pairs.length >= cap) return pairs.join(", ")
    }
  }
  return pairs.join(", ")
}
