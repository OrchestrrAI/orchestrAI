import { describe, expect, test } from "bun:test"
import { isAllowedMcpHost } from "./mcp-host-allowlist"

describe("isAllowedMcpHost", () => {
  test("localhost and 127.0.0.1 are always allowed, with no env value", () => {
    expect(isAllowedMcpHost("localhost", undefined)).toBe(true)
    expect(isAllowedMcpHost("127.0.0.1", undefined)).toBe(true)
    expect(isAllowedMcpHost("LOCALHOST", undefined)).toBe(true)
  })

  test("an arbitrary hostname is rejected by default (unchanged bare-metal behavior)", () => {
    expect(isAllowedMcpHost("mcp-http", undefined)).toBe(false)
    expect(isAllowedMcpHost("evil.example.com", undefined)).toBe(false)
    expect(isAllowedMcpHost("mcp-http", "")).toBe(false)
  })

  test("a hostname in ORCHESTRAI_MCP_ALLOWED_HOSTS is allowed", () => {
    expect(isAllowedMcpHost("mcp-http", "mcp-http")).toBe(true)
    expect(isAllowedMcpHost("mcp-http", "other-host,mcp-http, third-host")).toBe(true)
  })

  test("a hostname not in the list is still rejected even when the env var is set", () => {
    expect(isAllowedMcpHost("evil.example.com", "mcp-http")).toBe(false)
  })

  test("comparison is case-insensitive on both sides", () => {
    expect(isAllowedMcpHost("MCP-HTTP", "mcp-http")).toBe(true)
    expect(isAllowedMcpHost("mcp-http", "MCP-HTTP")).toBe(true)
  })
})
