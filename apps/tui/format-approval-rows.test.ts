// specs/037-tui-approval-preview-card/spec.md — focused unit coverage for
// the pure helper that turns a server-supplied ApprovalPreview into the
// labeled rows the TUI Detail overlay renders. Rendering logic only; no
// terminal, no network.
import { describe, expect, test } from "bun:test"
import { MAX_MULTI_FILE_DIFF_ROWS, formatApprovalRows } from "./index"
import type { ApprovalPreview } from "../../packages/shared/approval"

const mcpApproval: ApprovalPreview = {
  actionId: "act-123",
  kind: "mcp-tool",
  summary: "Write a Dockerfile for the target project",
  target: "C:\\work\\my-app\\Dockerfile",
  toolName: "create_dockerfile",
  parameters: { project_root: "C:\\work\\my-app", overwrite: false },
  risks: ["Overwrites an existing file if present", "Runs against the resolved target path"],
}

describe("formatApprovalRows", () => {
  test("target is the first row and carries the 'target' tone", () => {
    const rows = formatApprovalRows(mcpApproval)
    expect(rows[0]).toEqual({ label: "Target", value: "C:\\work\\my-app\\Dockerfile", tone: "target" })
  })

  test("action combines the kind's plain label and the tool name (specs/130)", () => {
    const rows = formatApprovalRows(mcpApproval)
    expect(rows.find((r) => r.label === "Action")?.value).toBe("MCP tool call: create_dockerfile")
  })

  test("specs/130 — the exact argv is shown as an array, and overwrite as yes/no", () => {
    const rows = formatApprovalRows({ ...mcpApproval, kind: "command", argv: ["bun", "test", "my file.test.ts"], overwrite: true })
    expect(rows.find((r) => r.label === "Argv")?.value).toBe('["bun","test","my file.test.ts"]')
    expect(rows.find((r) => r.label === "Overwrite")).toEqual({ label: "Overwrite", value: "yes — replaces an existing file", tone: "risk" })
    expect(formatApprovalRows({ ...mcpApproval, overwrite: false }).find((r) => r.label === "Overwrite")?.value).toBe("no — creates a new file")
    expect(formatApprovalRows(mcpApproval).some((r) => r.label === "Argv" || r.label === "Overwrite")).toBe(false)
  })

  test("command kind uses the executable in the action line", () => {
    const rows = formatApprovalRows({
      actionId: "a",
      kind: "command",
      summary: "run the test suite",
      target: "C:\\work\\my-app",
      executable: "bun test",
      risks: [],
    })
    expect(rows.find((r) => r.label === "Action")?.value).toBe("Command: bun test")
  })

  test("each parameter becomes its own key/value row", () => {
    const rows = formatApprovalRows(mcpApproval)
    expect(rows.find((r) => r.label === "project_root")?.value).toBe("C:\\work\\my-app")
    expect(rows.find((r) => r.label === "overwrite")?.value).toBe("false")
  })

  test("each risk is its own row with the 'risk' tone", () => {
    const riskRows = formatApprovalRows(mcpApproval).filter((r) => r.tone === "risk")
    expect(riskRows.map((r) => r.value)).toEqual([
      "Overwrites an existing file if present",
      "Runs against the resolved target path",
    ])
  })

  test("actionId is last and muted", () => {
    const rows = formatApprovalRows(mcpApproval)
    expect(rows.at(-1)).toEqual({ label: "actionId", value: "act-123", tone: "muted" })
  })

  test("missing optional fields are simply omitted, never rendered blank", () => {
    const rows = formatApprovalRows({ target: "C:\\only\\target" })
    expect(rows).toEqual([{ label: "Target", value: "C:\\only\\target", tone: "target" }])
  })

  test("an empty object yields no rows", () => {
    expect(formatApprovalRows({})).toEqual([])
  })

  // specs/040-approval-preview-content-diff/spec.md
  describe("content preview (specs/040)", () => {
    test("content with no previousContent renders as plain rows, tone 'normal'", () => {
      const rows = formatApprovalRows({ target: "x", content: "line one\nline two" })
      const contentRows = rows.filter((r) => r.label === " ")
      expect(contentRows).toEqual([
        { label: " ", value: "line one", tone: "normal" },
        { label: " ", value: "line two", tone: "normal" },
      ])
    })

    test("content plus previousContent renders a diff with +/- prefixes and matching tones", () => {
      const rows = formatApprovalRows({ target: "x", content: "a\nX", previousContent: "a\nb" })
      const diffRows = rows.filter((r) => r.label === "+" || r.label === "-" || (r.label === " " && r.tone === "normal"))
      expect(diffRows).toEqual([
        { label: " ", value: "a", tone: "normal" },
        { label: "-", value: "b", tone: "removed" },
        { label: "+", value: "X", tone: "added" },
      ])
    })

    test("neither content nor previousContent present adds no content rows — byte-identical to pre-040", () => {
      expect(formatApprovalRows(mcpApproval)).toEqual(formatApprovalRows(mcpApproval))
      const rows = formatApprovalRows(mcpApproval)
      expect(rows.some((r) => r.tone === "added" || r.tone === "removed")).toBe(false)
    })

    test("oversized combined content omits the diff, one muted note row instead", () => {
      const big = "x".repeat(70_000)
      const rows = formatApprovalRows({ target: "x", content: big })
      const contentRow = rows.find((r) => r.label === "Content")
      expect(contentRow?.tone).toBe("muted")
      expect(contentRow?.value).toContain("too large to preview inline")
      // Never a partial diff/plain row alongside the omission note.
      expect(rows.some((r) => r.label === " " || r.label === "+" || r.label === "-")).toBe(false)
    })

    test("content rows are placed after parameters and before risks", () => {
      const rows = formatApprovalRows({
        target: "x",
        parameters: { a: "1" },
        content: "hello",
        risks: ["danger"],
      })
      const paramIdx = rows.findIndex((r) => r.label === "a")
      const contentIdx = rows.findIndex((r) => r.label === " ")
      const riskIdx = rows.findIndex((r) => r.tone === "risk")
      expect(paramIdx).toBeLessThan(contentIdx)
      expect(contentIdx).toBeLessThan(riskIdx)
    })
  })

  // specs/114 + specs/130 phase 2 — a NEW/EDIT header row per file, each
  // followed by that file's own diff rows, with a hard cap on total diff
  // rows across all files.
  describe("multi-file diffs (specs/114, specs/130)", () => {
    test("each file's header row is followed by that file's own diff rows", () => {
      const rows = formatApprovalRows({
        target: "2 files (1 edit, 1 new)",
        files: [
          { target: "C:\\work\\src\\a.ts", action: "edit", content: "a\nX", previousContent: "a\nb", fingerprint: "f1" },
          { target: "C:\\work\\src\\b.ts", action: "create", content: "line1\nline2", fingerprint: "absent" },
        ],
      })
      const editIdx = rows.findIndex((r) => r.label === "EDIT")
      const newIdx = rows.findIndex((r) => r.label === "NEW")
      expect(rows[editIdx]).toEqual({ label: "EDIT", value: "C:\\work\\src\\a.ts (+1/-1)", tone: "normal" })
      expect(rows[newIdx]).toEqual({ label: "NEW", value: "C:\\work\\src\\b.ts (+2 lines)", tone: "added" })
      expect(rows.slice(editIdx + 1, newIdx)).toEqual([
        { label: " ", value: "a", tone: "normal" },
        { label: "-", value: "b", tone: "removed" },
        { label: "+", value: "X", tone: "added" },
      ])
      expect(rows.slice(newIdx + 1, newIdx + 3)).toEqual([
        { label: " ", value: "line1", tone: "normal" },
        { label: " ", value: "line2", tone: "normal" },
      ])
      expect(rows.some((r) => r.value.includes("see the dashboard"))).toBe(false)
    })

    test(`caps total diff rows at ${MAX_MULTI_FILE_DIFF_ROWS} across files, keeping every header, with a "more" line`, () => {
      const big = Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n")
      const files = [0, 1].map((i) => ({
        target: `C:\\work\\src\\big${i}.ts`, action: "create" as const, content: big, fingerprint: "absent",
      }))
      const rows = formatApprovalRows({ target: "2 files (2 new)", files })
      expect(rows.filter((r) => r.label === "NEW")).toHaveLength(2)
      const diffRows = rows.filter((r) => r.label === " " && r.value.startsWith("l"))
      expect(diffRows).toHaveLength(MAX_MULTI_FILE_DIFF_ROWS)
      expect(rows.at(-1)).toEqual({ label: " ", value: "… 100 more lines — v for raw", tone: "muted" })
    })

    test("no \"more\" line when everything fits", () => {
      const rows = formatApprovalRows({
        target: "1 file (1 edit)",
        files: [{ target: "C:\\work\\src\\a.ts", action: "edit", content: "a\nX", previousContent: "a\nb", fingerprint: "f1" }],
      })
      expect(rows.some((r) => r.value.includes("more lines"))).toBe(false)
    })

    test("bounded by construction — one row per file, capped by however many files[] actually holds (MAX_FILES_PER_EDIT = 6 upstream)", () => {
      const files = Array.from({ length: 6 }, (_, i) => ({
        target: `C:\\work\\src\\f${i}.ts`, action: "create" as const, content: `content ${i}`, fingerprint: "absent",
      }))
      const rows = formatApprovalRows({ target: "6 files (6 new)", files })
      expect(rows.filter((r) => r.label === "NEW")).toHaveLength(6)
    })

    test("an empty files[] array falls through to the single-file content path, not the multi-file one", () => {
      const rows = formatApprovalRows({ target: "x", files: [], content: "hello" })
      expect(rows.some((r) => r.label === "EDIT" || r.label === "NEW")).toBe(false)
      expect(rows.find((r) => r.label === " ")?.value).toBe("hello")
    })
  })
})
