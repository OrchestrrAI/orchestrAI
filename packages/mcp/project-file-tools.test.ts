import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { createMcpServer } from "./index"

// Accepts the real, loosely-typed MCP SDK callTool() result (its own
// return type is an index-signature-plus-content shape TS can't narrow
// generically — see specs/014-typecheck-ci/spec.md) rather than the narrow
// nominal shape used before, which required a cast at every call site.
// Narrowed defensively here instead, once, in the one place that needs it.
function toolText(result: unknown): string {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return ""
  return content
    .filter((item): item is { type: string; text: string } =>
      typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text")
    .map((item) => item.text)
    .join("\n")
}

describe("read_project_file / write_project_file — path containment", () => {
  let root: string
  let client: Client
  let server: ReturnType<typeof createMcpServer>

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "orchestrai-mcp-fs-"))
    writeFileSync(path.join(root, "readme.txt"), "hello world")
    mkdirSync(path.join(root, "sub"))
    writeFileSync(path.join(root, "sub", "nested.txt"), "nested content")
    writeFileSync(path.join(root, ".env"), "SECRET=shouldneverbereturned")

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    server = createMcpServer()
    client = new Client({ name: "project-file-tools-test", version: "1.0.0" })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    await client.close().catch(() => undefined)
    await server.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  })

  test("reads an in-bounds file", async () => {
    const result = await client.callTool({
      name: "read_project_file",
      arguments: { project_root: root, relative_path: "readme.txt" },
    })
    expect(toolText(result)).toBe("hello world")
    expect(result.isError).toBeFalsy()
  })

  test("lists an in-bounds directory", async () => {
    const result = await client.callTool({
      name: "read_project_file",
      arguments: { project_root: root, relative_path: "sub" },
    })
    expect(toolText(result)).toContain("nested.txt")
  })

  test("rejects ../ traversal that escapes the root", async () => {
    const result = await client.callTool({
      name: "read_project_file",
      arguments: { project_root: root, relative_path: "../../../etc/passwd" },
    })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toContain("Denied")
  })

  test("rejects an absolute relative_path", async () => {
    const result = await client.callTool({
      name: "read_project_file",
      arguments: { project_root: root, relative_path: path.join(root, "readme.txt") },
    })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toContain("must not be an absolute path")
  })

  test("rejects a null byte in relative_path", async () => {
    const result = await client.callTool({
      name: "read_project_file",
      arguments: { project_root: root, relative_path: "readme.txt\0.jpg" },
    })
    expect(result.isError).toBe(true)
  })

  test("denies reading .env even though it's technically in-bounds", async () => {
    const result = await client.callTool({
      name: "read_project_file",
      arguments: { project_root: root, relative_path: ".env" },
    })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toContain("Denied")
    expect(toolText(result)).not.toContain("shouldneverbereturned")
  })

  // specs/123-safe-env-template-filename-exemption/spec.md
  describe("safe .env template filenames (specs/123)", () => {
    for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist", ".ENV.EXAMPLE"]) {
      test(`reads ${name}, an exempted safe template name`, async () => {
        writeFileSync(path.join(root, name), "PLACEHOLDER=1")
        const result = await client.callTool({
          name: "read_project_file",
          arguments: { project_root: root, relative_path: name },
        })
        expect(result.isError).toBeFalsy()
        expect(toolText(result)).toBe("PLACEHOLDER=1")
      })

      test(`writes ${name}, an exempted safe template name`, async () => {
        const result = await client.callTool({
          name: "write_project_file",
          arguments: { project_root: root, relative_path: name, content: "PLACEHOLDER=1" },
        })
        expect(result.isError).toBeFalsy()
      })
    }

    test("a decoy stacking a real suffix on the template name stays denied (.env.example.local)", async () => {
      const result = await client.callTool({
        name: "write_project_file",
        arguments: { project_root: root, relative_path: ".env.example.local", content: "SECRET=1" },
      })
      expect(result.isError).toBe(true)
      expect(toolText(result)).toContain("Denied")
    })

    test(".env.local, a real secrets variant, stays denied — the exemption is exact-name, not a loosened pattern", async () => {
      const result = await client.callTool({
        name: "write_project_file",
        arguments: { project_root: root, relative_path: ".env.local", content: "SECRET=1" },
      })
      expect(result.isError).toBe(true)
      expect(toolText(result)).toContain("Denied")
    })

    test(".env itself is completely unaffected by the exemption", async () => {
      const result = await client.callTool({
        name: "read_project_file",
        arguments: { project_root: root, relative_path: ".env" },
      })
      expect(result.isError).toBe(true)
      expect(toolText(result)).toContain("Denied")
    })
  })

  test("rejects a symlink inside the root that points outside it", async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "orchestrai-mcp-outside-"))
    writeFileSync(path.join(outsideDir, "secret.txt"), "outside content")
    const linkPath = path.join(root, "escape-link")
    try {
      symlinkSync(outsideDir, linkPath, "dir")
    } catch {
      // Symlink creation can require elevated privileges on Windows without
      // Developer Mode enabled — skip gracefully rather than fail the suite
      // on an environment limitation unrelated to the containment logic.
      rmSync(outsideDir, { recursive: true, force: true })
      return
    }

    const result = await client.callTool({
      name: "read_project_file",
      arguments: { project_root: root, relative_path: "escape-link/secret.txt" },
    })
    expect(result.isError).toBe(true)
    expect(toolText(result)).not.toContain("outside content")
    rmSync(outsideDir, { recursive: true, force: true })
  })

  test("writes a new in-bounds file", async () => {
    const result = await client.callTool({
      name: "write_project_file",
      arguments: { project_root: root, relative_path: "new-file.txt", content: "written content" },
    })
    expect(result.isError).toBeFalsy()

    const readBack = await client.callTool({
      name: "read_project_file",
      arguments: { project_root: root, relative_path: "new-file.txt" },
    })
    expect(toolText(readBack)).toBe("written content")
  })

  test("refuses to overwrite an existing file without overwrite: true", async () => {
    const result = await client.callTool({
      name: "write_project_file",
      arguments: { project_root: root, relative_path: "readme.txt", content: "clobbered" },
    })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toContain("Refusing to overwrite")

    const stillOriginal = await client.callTool({
      name: "read_project_file",
      arguments: { project_root: root, relative_path: "readme.txt" },
    })
    expect(toolText(stillOriginal)).toBe("hello world")
  })

  test("overwrites when overwrite: true is explicit", async () => {
    const result = await client.callTool({
      name: "write_project_file",
      arguments: { project_root: root, relative_path: "readme.txt", content: "updated", overwrite: true },
    })
    expect(result.isError).toBeFalsy()

    const readBack = await client.callTool({
      name: "read_project_file",
      arguments: { project_root: root, relative_path: "readme.txt" },
    })
    expect(toolText(readBack)).toBe("updated")
  })

  test("rejects writing outside the root via ../ traversal", async () => {
    const result = await client.callTool({
      name: "write_project_file",
      arguments: { project_root: root, relative_path: "../escape.txt", content: "malicious" },
    })
    expect(result.isError).toBe(true)
  })

  test("denies writing to a sensitive filename", async () => {
    const result = await client.callTool({
      name: "write_project_file",
      arguments: { project_root: root, relative_path: ".env", content: "OVERWRITTEN=1", overwrite: true },
    })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toContain("Denied")
  })

  // specs/129 — OrchestrAI's own state dir holds the provider API key in
  // config.env, which no basename rule catches. Live-caught being read by
  // the Coder harness; every spelling of a path into it must be denied.
  describe("OrchestrAI's own .orchestrai state directory (specs/129)", () => {
    const KEY = "ORCHESTRAI_LLM_API_KEY=sk-live-should-never-leak"

    beforeEach(() => {
      mkdirSync(path.join(root, ".orchestrai"))
      writeFileSync(path.join(root, ".orchestrai", "config.env"), KEY)
      writeFileSync(path.join(root, ".orchestrai", "supervisor.log"), "log line")
    })

    test.each([
      ".orchestrai/config.env",
      ".orchestrai\\config.env",
      ".ORCHESTRAI/config.env",
      "sub/../.orchestrai/config.env",
      "./.orchestrai/supervisor.log",
      ".orchestrai",
      ".orchestrai/",
    ])("read_project_file denies %p without returning its content", async (relative_path) => {
      const result = await client.callTool({ name: "read_project_file", arguments: { project_root: root, relative_path } })
      expect(result.isError).toBe(true)
      expect(toolText(result)).toContain("OrchestrAI's own state directory is denied")
      expect(toolText(result)).not.toContain("sk-live-should-never-leak")
      expect(toolText(result)).not.toContain("config.env")
    })

    test("write_project_file denies writing into it, even a new file", async () => {
      const result = await client.callTool({
        name: "write_project_file",
        arguments: { project_root: root, relative_path: ".orchestrai/new.txt", content: "x" },
      })
      expect(result.isError).toBe(true)
      expect(toolText(result)).toContain("OrchestrAI's own state directory is denied")
    })

    test("listing the project root never shows it", async () => {
      const result = await client.callTool({ name: "read_project_file", arguments: { project_root: root, relative_path: "." } })
      expect(result.isError).toBeFalsy()
      expect(toolText(result)).toContain("f readme.txt")
      expect(toolText(result)).not.toContain(".orchestrai")
    })

    test("analyze_project's file list never shows it", async () => {
      const result = await client.callTool({ name: "analyze_project", arguments: { project_path: root } })
      expect(toolText(result)).toContain("readme.txt")
      expect(toolText(result)).not.toContain(".orchestrai")
    })

    test("an in-root symlink pointing into it is denied", async () => {
      try {
        symlinkSync(path.join(root, ".orchestrai"), path.join(root, "innocent-link"), "dir")
      } catch {
        return // symlinks can need elevated privileges on Windows — same skip as the escape test above
      }
      for (const relative_path of ["innocent-link", "innocent-link/config.env"]) {
        const result = await client.callTool({ name: "read_project_file", arguments: { project_root: root, relative_path } })
        expect(result.isError).toBe(true)
        expect(toolText(result)).not.toContain("sk-live-should-never-leak")
      }
    })

    test("a lookalike name is not over-blocked", async () => {
      writeFileSync(path.join(root, ".orchestrai-notes.txt"), "fine")
      const result = await client.callTool({ name: "read_project_file", arguments: { project_root: root, relative_path: ".orchestrai-notes.txt" } })
      expect(result.isError).toBeFalsy()
      expect(toolText(result)).toBe("fine")
    })
  })
})

// specs/138 — the run_tests tool was removed (test commands are model-proposed
// and run via run_command, whose tests live in index.test.ts).
