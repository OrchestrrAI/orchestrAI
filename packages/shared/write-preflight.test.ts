import { describe, expect, test } from "bun:test"
import { classifyWritePreflight } from "./write-preflight"

describe("classifyWritePreflight", () => {
  test("create — target genuinely absent (Path not found:)", () => {
    const result = classifyWritePreflight("FROM oven/bun\n", { ok: false, message: "Path not found: Dockerfile" })
    expect(result).toEqual({ kind: "create" })
  })

  test("no-op — target exists and content already matches exactly", () => {
    const content = "FROM oven/bun\nWORKDIR /app\n"
    const result = classifyWritePreflight(content, { ok: true, content })
    expect(result.kind).toBe("no-op")
    expect(result.previousContent).toBe(content)
  })

  test("update — target exists and differs", () => {
    const result = classifyWritePreflight("FROM oven/bun:1.2\n", { ok: true, content: "FROM oven/bun:1.1\n" })
    expect(result.kind).toBe("update")
    expect(result.previousContent).toBe("FROM oven/bun:1.1\n")
  })

  test("blocked — a Denied (containment/sensitive-filename) refusal", () => {
    const result = classifyWritePreflight("...", { ok: false, message: "Denied: path escapes project root" })
    expect(result.kind).toBe("blocked")
    expect(result.reason).toBe("Denied: path escapes project root")
  })

  test("blocked — any other read failure, never guessed past as create", () => {
    const result = classifyWritePreflight("...", { ok: false, message: "MCP tool read_project_file failed" })
    expect(result.kind).toBe("blocked")
    expect(result.reason).toBe("MCP tool read_project_file failed")
  })

  test("no-op is exact-match only — a single differing byte is update, not no-op", () => {
    const result = classifyWritePreflight("FROM oven/bun:1.2\n", { ok: true, content: "FROM oven/bun:1.2 \n" })
    expect(result.kind).toBe("update")
  })
})
