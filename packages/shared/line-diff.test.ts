// specs/040-approval-preview-content-diff/spec.md
import { describe, expect, test } from "bun:test"
import { buildContentPreview, CONTENT_PREVIEW_MAX_BYTES, computeLineDiff } from "./line-diff"

describe("computeLineDiff", () => {
  test("identical inputs produce an all-unchanged diff", () => {
    const diff = computeLineDiff("a\nb\nc", "a\nb\nc")
    expect(diff).toEqual([
      { type: "unchanged", text: "a" },
      { type: "unchanged", text: "b" },
      { type: "unchanged", text: "c" },
    ])
  })

  test("empty before yields an all-added diff", () => {
    const diff = computeLineDiff("", "a\nb")
    expect(diff).toEqual([
      { type: "added", text: "a" },
      { type: "added", text: "b" },
    ])
  })

  test("empty after yields an all-removed diff", () => {
    const diff = computeLineDiff("a\nb", "")
    expect(diff).toEqual([
      { type: "removed", text: "a" },
      { type: "removed", text: "b" },
    ])
  })

  test("both empty yields an empty diff", () => {
    expect(computeLineDiff("", "")).toEqual([])
  })

  test("a single line changed in the middle diffs only that line", () => {
    const diff = computeLineDiff("a\nb\nc", "a\nX\nc")
    expect(diff).toEqual([
      { type: "unchanged", text: "a" },
      { type: "removed", text: "b" },
      { type: "added", text: "X" },
      { type: "unchanged", text: "c" },
    ])
  })

  test("a line appended at the end diffs as a pure addition", () => {
    const diff = computeLineDiff("a\nb", "a\nb\nc")
    expect(diff).toEqual([
      { type: "unchanged", text: "a" },
      { type: "unchanged", text: "b" },
      { type: "added", text: "c" },
    ])
  })

  test("a line removed from the start diffs as a pure removal", () => {
    const diff = computeLineDiff("a\nb\nc", "b\nc")
    expect(diff).toEqual([
      { type: "removed", text: "a" },
      { type: "unchanged", text: "b" },
      { type: "unchanged", text: "c" },
    ])
  })

  test("completely different content diffs as all-removed then all-added", () => {
    const diff = computeLineDiff("x\ny", "p\nq")
    // Any LCS-correct ordering is acceptable here since there's no common
    // subsequence at all; assert the multiset of operations, not exact order.
    expect(diff.filter((d) => d.type === "removed").map((d) => d.text)).toEqual(["x", "y"])
    expect(diff.filter((d) => d.type === "added").map((d) => d.text)).toEqual(["p", "q"])
  })
})

describe("buildContentPreview", () => {
  test("neither field present returns 'none' — the byte-identical fallback", () => {
    expect(buildContentPreview(undefined, undefined)).toEqual({ kind: "none" })
  })

  test("content only (a create, not an overwrite) returns 'plain'", () => {
    expect(buildContentPreview("hello", undefined)).toEqual({ kind: "plain", text: "hello" })
  })

  test("content plus previousContent (an overwrite) returns 'diff'", () => {
    const result = buildContentPreview("a\nX", "a\nb")
    expect(result.kind).toBe("diff")
    if (result.kind === "diff") {
      expect(result.lines).toEqual([
        { type: "unchanged", text: "a" },
        { type: "removed", text: "b" },
        { type: "added", text: "X" },
      ])
    }
  })

  test("previousContent present but content absent (deletion case) still diffs against empty", () => {
    const result = buildContentPreview(undefined, "a\nb")
    expect(result.kind).toBe("diff")
    if (result.kind === "diff") {
      expect(result.lines).toEqual([
        { type: "removed", text: "a" },
        { type: "removed", text: "b" },
      ])
    }
  })

  // specs/040 Decision B — oversized content is omitted, never truncated.
  describe("oversized content (Decision B)", () => {
    test("combined size at or under the cap still renders", () => {
      const content = "x".repeat(CONTENT_PREVIEW_MAX_BYTES / 2)
      const result = buildContentPreview(content, undefined)
      expect(result.kind).toBe("plain")
    })

    test("combined size over the cap is omitted, not truncated", () => {
      const content = "x".repeat(CONTENT_PREVIEW_MAX_BYTES)
      const previousContent = "y".repeat(100)
      const result = buildContentPreview(content, previousContent)
      expect(result.kind).toBe("omitted")
      if (result.kind === "omitted") {
        expect(result.totalBytes).toBeGreaterThan(CONTENT_PREVIEW_MAX_BYTES)
      }
    })

    test("the cap is checked against the combined pair, not each field independently", () => {
      // Each field alone is under the cap; together they exceed it.
      const half = "x".repeat(Math.floor(CONTENT_PREVIEW_MAX_BYTES * 0.6))
      const result = buildContentPreview(half, half)
      expect(result.kind).toBe("omitted")
    })

    test("an omitted result never contains a partial diff or partial text", () => {
      const content = "x".repeat(CONTENT_PREVIEW_MAX_BYTES + 1)
      const result = buildContentPreview(content, undefined)
      expect(result).not.toHaveProperty("lines")
      expect(result).not.toHaveProperty("text")
    })
  })
})
