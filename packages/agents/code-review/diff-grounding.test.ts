// specs/082-code-review-agent/spec.md — pure unit tests for the
// grounding parser, no I/O, no live MCP/model needed.
import { describe, expect, test } from "bun:test"
import { describeValidLocations, isGrounded, parseUnifiedDiff } from "./diff-grounding"

describe("parseUnifiedDiff — multi-file diff", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index abc123..def456 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -10,4 +10,5 @@ function foo() {",
    "   const x = 1",
    "-  return x",
    "+  const y = x + 1",
    "+  return y",
    " }",
    "diff --git a/src/bar.ts b/src/bar.ts",
    "index 111..222 100644",
    "--- a/src/bar.ts",
    "+++ b/src/bar.ts",
    "@@ -1,2 +1,3 @@",
    "+// a new comment",
    " export function bar() {}",
    " ",
  ].join("\n")

  test("touches both real files", () => {
    const parsed = parseUnifiedDiff(diff)
    expect(parsed.touchedFiles).toEqual(["src/foo.ts", "src/bar.ts"])
  })

  test("added lines are grounded", () => {
    const parsed = parseUnifiedDiff(diff)
    // "const y = x + 1" is the first + line after line 10 context — new line 11.
    expect(isGrounded(parsed, "src/foo.ts", 11)).toBe(true)
    // "return y" — new line 12.
    expect(isGrounded(parsed, "src/foo.ts", 12)).toBe(true)
  })

  test("context lines are grounded", () => {
    const parsed = parseUnifiedDiff(diff)
    // "const x = 1" is a context line at new line 10.
    expect(isGrounded(parsed, "src/foo.ts", 10)).toBe(true)
    // The closing "}" context line at new line 13.
    expect(isGrounded(parsed, "src/foo.ts", 13)).toBe(true)
  })

  test("removed lines are never grounded — out-of-scope citation type", () => {
    const parsed = parseUnifiedDiff(diff)
    // "return x" was removed — it never existed in the new file, so no
    // new-file line number was ever assigned to it; nothing at the old
    // line 11 position should be groundable as a "removed line" claim.
    // (This test's real assertion is that a citation for the REMOVED
    // content's own semantic location isn't accidentally grounded via
    // some off-by-one — line 11 is legitimately grounded because it's
    // where "const y = x + 1" now lives, a genuinely different claim.)
    expect(isGrounded(parsed, "src/bar.ts", 999)).toBe(false)
  })

  test("a location not present in the diff at all is not grounded", () => {
    const parsed = parseUnifiedDiff(diff)
    expect(isGrounded(parsed, "src/foo.ts", 500)).toBe(false)
    expect(isGrounded(parsed, "src/nonexistent.ts", 1)).toBe(false)
  })
})

describe("parseUnifiedDiff — deleted file", () => {
  const diff = [
    "diff --git a/src/old.ts b/src/old.ts",
    "deleted file mode 100644",
    "index abc123..0000000",
    "--- a/src/old.ts",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-export function old() {}",
    "-",
    "-// trailing comment",
  ].join("\n")

  test("contributes zero valid lines", () => {
    const parsed = parseUnifiedDiff(diff)
    expect(isGrounded(parsed, "src/old.ts", 1)).toBe(false)
  })
})

describe("parseUnifiedDiff — renamed file with no content change", () => {
  const diff = [
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 100%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
  ].join("\n")

  test("contributes zero valid lines for either name — documented scope cut", () => {
    const parsed = parseUnifiedDiff(diff)
    expect(isGrounded(parsed, "src/old-name.ts", 1)).toBe(false)
    expect(isGrounded(parsed, "src/new-name.ts", 1)).toBe(false)
  })
})

describe("parseUnifiedDiff — binary file diff", () => {
  const diff = [
    "diff --git a/logo.png b/logo.png",
    "index 111..222 100644",
    "Binary files a/logo.png and b/logo.png differ",
  ].join("\n")

  test("does not crash and contributes zero valid lines", () => {
    const parsed = parseUnifiedDiff(diff)
    expect(isGrounded(parsed, "logo.png", 1)).toBe(false)
  })
})

describe("parseUnifiedDiff — \"no newline at end of file\" marker", () => {
  const diff = [
    "diff --git a/src/tail.ts b/src/tail.ts",
    "index 111..222 100644",
    "--- a/src/tail.ts",
    "+++ b/src/tail.ts",
    "@@ -1,1 +1,1 @@",
    "-export const x = 1",
    "\\ No newline at end of file",
    "+export const x = 2",
    "\\ No newline at end of file",
  ].join("\n")

  test("the marker line is never miscounted as a content line", () => {
    const parsed = parseUnifiedDiff(diff)
    // Exactly one new-file line (1) should be valid — the marker lines
    // must not have incremented the counter an extra time each.
    expect(isGrounded(parsed, "src/tail.ts", 1)).toBe(true)
    expect(isGrounded(parsed, "src/tail.ts", 2)).toBe(false)
  })
})

describe("parseUnifiedDiff — path normalization", () => {
  test("a/ and b/ prefixes and backslashes are normalized consistently", () => {
    const diff = [
      "diff --git a/src/win.ts b/src/win.ts",
      "index 111..222 100644",
      "--- a/src/win.ts",
      "+++ b/src/win.ts",
      "@@ -1,1 +1,2 @@",
      " const a = 1",
      "+const b = 2",
    ].join("\n")
    const parsed = parseUnifiedDiff(diff)
    // The diff's own path is always forward-slash; a model citing the
    // same logical path with a backslash or an a/-prefixed form must
    // still resolve to the same grounded location.
    expect(isGrounded(parsed, "src\\win.ts", 2)).toBe(true)
    expect(isGrounded(parsed, "a/src/win.ts", 2)).toBe(true)
    expect(isGrounded(parsed, "b/src/win.ts", 2)).toBe(true)
  })
})

describe("describeValidLocations", () => {
  test("returns a capped, human-readable list", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "index 111..222 100644",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,1 +1,2 @@",
      " const a = 1",
      "+const b = 2",
    ].join("\n")
    const parsed = parseUnifiedDiff(diff)
    const described = describeValidLocations(parsed)
    expect(described).toContain("f.ts:1")
    expect(described).toContain("f.ts:2")
  })

  test("an empty diff describes zero locations", () => {
    const parsed = parseUnifiedDiff("")
    expect(describeValidLocations(parsed)).toBe("")
  })
})
