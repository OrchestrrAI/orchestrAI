// specs/079-phase-a-connect-orphaned-tools/spec.md §6
//
// Real HTTP round trips against two genuinely separate, locally-bound MCP
// servers (never InMemoryTransport — this is specifically testing the
// multi-ENDPOINT case, where each endpoint is its own real process in
// production). Both servers here bind 127.0.0.1 on an OS-chosen ephemeral
// port, mirroring exactly what a locally-run third-party MCP server
// (the official filesystem server, a Docker/Postgres MCP server) looks
// like from this client's perspective — proving the loopback rule
// (untouched by this spec) doesn't block the case it was never meant to
// block. A genuine third-party server is this spec's own "live, real
// stack" verification item, not this unit test.
import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { OrchestraiMultiMcpClient } from "./mcp-client"

// Minimal test-only re-implementation of packages/mcp/http.ts's own
// session-handling shape, parameterized so more than one instance can
// run at once on different ephemeral ports — http.ts itself hardcodes
// one module-level HOST/PORT and isn't reusable for a two-server test.
function serveTestMcpServer(server: McpServer): { url: string; close: () => Promise<void> } {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()

  const httpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 })

      const sessionId = request.headers.get("mcp-session-id")
      if (sessionId) {
        const transport = sessions.get(sessionId)
        if (!transport) return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown MCP session" }, id: null }, { status: 404 })
        return transport.handleRequest(request)
      }

      if (request.method !== "POST") {
        return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing MCP session ID" }, id: null }, { status: 400 })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ jsonrpc: "2.0", error: { code: -32700, message: "Invalid JSON" }, id: null }, { status: 400 })
      }
      if (!isInitializeRequest(body)) {
        return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Expected an MCP initialize request" }, id: null }, { status: 400 })
      }

      let initializedSessionId: string | undefined
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => { initializedSessionId = id },
        onsessionclosed: (id) => { sessions.delete(id) },
      })
      await server.connect(transport)
      const response = await transport.handleRequest(request, { parsedBody: body })
      if (initializedSessionId) sessions.set(initializedSessionId, transport)
      return response
    },
  })

  return {
    url: `http://127.0.0.1:${httpServer.port}/mcp`,
    close: async () => {
      httpServer.stop(true)
    },
  }
}

function buildFakeServer(toolNames: string[]): McpServer {
  const server = new McpServer({ name: "orchestrai-multi-mcp-test", version: "1.0.0" })
  for (const name of toolNames) {
    server.tool(name, `Fake tool ${name}`, {}, async () => ({ content: [{ type: "text", text: `${name} result` }] }))
  }
  return server
}

describe("specs/079 — OrchestraiMultiMcpClient: real routing across two genuinely separate endpoints", () => {
  let closers: (() => Promise<void>)[] = []
  let client: OrchestraiMultiMcpClient | undefined

  afterEach(async () => {
    if (client) await client.stop()
    await Promise.all(closers.map((close) => close()))
    closers = []
    client = undefined
  })

  test("calls the right tool on the right endpoint, for both endpoints", async () => {
    const serverA = serveTestMcpServer(buildFakeServer(["tool_a"]))
    const serverB = serveTestMcpServer(buildFakeServer(["tool_b"]))
    closers = [serverA.close, serverB.close]

    client = new OrchestraiMultiMcpClient("test-agent", [
      { name: "endpoint-a", requiredTools: ["tool_a"], url: serverA.url },
      { name: "endpoint-b", requiredTools: ["tool_b"], url: serverB.url },
    ])
    client.start()

    const resultA = await client.callTool("tool_a", {}, "task-1")
    expect(resultA).toBe("tool_a result")
    const resultB = await client.callTool("tool_b", {}, "task-2")
    expect(resultB).toBe("tool_b result")
  })

  test("readiness() reports 'connected' only once every endpoint is, with per-endpoint detail", async () => {
    const serverA = serveTestMcpServer(buildFakeServer(["tool_a"]))
    const serverB = serveTestMcpServer(buildFakeServer(["tool_b"]))
    closers = [serverA.close, serverB.close]

    client = new OrchestraiMultiMcpClient("test-agent", [
      { name: "endpoint-a", requiredTools: ["tool_a"], url: serverA.url },
      { name: "endpoint-b", requiredTools: ["tool_b"], url: serverB.url },
    ])
    client.start()

    // Wait for both to connect rather than assuming immediacy.
    const deadline = Date.now() + 5000
    let readiness = client.readiness()
    while (readiness.state !== "connected" && Date.now() < deadline) {
      await Bun.sleep(20)
      readiness = client.readiness()
    }
    expect(readiness.state).toBe("connected")
    expect(readiness.endpoints.map((e) => e.name).sort()).toEqual(["endpoint-a", "endpoint-b"])
    expect(readiness.endpoints.every((e) => e.state === "connected")).toBe(true)
  })

  test("pingReady() is true only when every endpoint responds", async () => {
    const serverA = serveTestMcpServer(buildFakeServer(["tool_a"]))
    const serverB = serveTestMcpServer(buildFakeServer(["tool_b"]))
    closers = [serverA.close, serverB.close]

    client = new OrchestraiMultiMcpClient("test-agent", [
      { name: "endpoint-a", requiredTools: ["tool_a"], url: serverA.url },
      { name: "endpoint-b", requiredTools: ["tool_b"], url: serverB.url },
    ])
    client.start()
    await client.callTool("tool_a", {}, "task-warm-a") // force endpoint-a to be connected
    await client.callTool("tool_b", {}, "task-warm-b") // force endpoint-b to be connected

    expect(await client.pingReady()).toBe(true)
  })

  test("a tool name not declared by any endpoint fails closed with a clear error, no call attempted", async () => {
    const serverA = serveTestMcpServer(buildFakeServer(["tool_a"]))
    closers = [serverA.close]

    client = new OrchestraiMultiMcpClient("test-agent", [
      { name: "endpoint-a", requiredTools: ["tool_a"], url: serverA.url },
    ])
    client.start()

    await expect(client.callTool("nonexistent_tool", {}, "task-1")).rejects.toThrow(/No configured MCP endpoint declares tool "nonexistent_tool"/)
  })

  test("a tool declared by two endpoints fails closed AT CONSTRUCTION, mirroring specs/030's skill-ownership refusal", () => {
    expect(() => {
      new OrchestraiMultiMcpClient("test-agent", [
        { name: "endpoint-a", requiredTools: ["shared_tool"], url: "http://127.0.0.1:1/mcp" },
        { name: "endpoint-b", requiredTools: ["shared_tool"], url: "http://127.0.0.1:2/mcp" },
      ])
    }).toThrow(/declared by more than one MCP endpoint/)
  })

  test("a single-endpoint configuration behaves like the plain OrchestraiMcpClient (real round trip)", async () => {
    const server = serveTestMcpServer(buildFakeServer(["solo_tool"]))
    closers = [server.close]

    client = new OrchestraiMultiMcpClient("test-agent", [
      { name: "only", requiredTools: ["solo_tool"], url: server.url },
    ])
    client.start()
    expect(await client.callTool("solo_tool", {}, "task-1")).toBe("solo_tool result")
  })

  test("requires at least one endpoint", () => {
    expect(() => new OrchestraiMultiMcpClient("test-agent", [])).toThrow(/at least one endpoint/)
  })
})
