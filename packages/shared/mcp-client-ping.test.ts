// specs/143 — a failed health ping must never kill a tool call in flight.
// Found live: a real docker build died with "MCP error -32000: Connection
// closed" while the server finished the build, because DevOps's /healthz
// ping (then 500 ms) timed out under load and closed the client.
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { OrchestraiMcpClient } from "./mcp-client"

// Same test-only server harness as mcp-client-multi.test.ts: a re-implementation of packages/mcp/http.ts's own
// session-handling shape, parameterized so more than one instance can
// run at once on different ephemeral ports — http.ts itself hardcodes
// one module-level HOST/PORT and isn't reusable for a two-server test.
function serveTestMcpServer(makeServer: () => McpServer): { url: string; close: () => Promise<void> } {
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
      await makeServer().connect(transport)
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

function slowServer(ms: number): McpServer {
  const server = new McpServer({ name: "orchestrai-ping-test", version: "1.0.0" })
  server.tool("slow", "Sleeps, then answers", {}, async () => {
    await Bun.sleep(ms)
    return { content: [{ type: "text", text: "slow done" }] }
  })
  return server
}

describe("specs/143 — health pings and in-flight calls", () => {
  let client: OrchestraiMcpClient | undefined
  let close: (() => Promise<void>) | undefined
  let warn: ReturnType<typeof spyOn> | undefined

  afterEach(async () => {
    await client?.stop()
    await close?.()
    warn?.mockRestore()
    client = undefined
    close = undefined
  })

  async function connected(ms: number): Promise<OrchestraiMcpClient> {
    const served = serveTestMcpServer(() => slowServer(ms))
    close = served.close
    client = new OrchestraiMcpClient({ callerName: "ping-test", requiredTools: ["slow"], url: served.url })
    client.start()
    await client.callTool("slow", {}, "warm-up", 10_000)
    return client
  }

  // Make the next ping fail for certain. A tiny timeout is a race: on a fast
  // Linux CI runner a loopback ping answers in under 1 ms, so it passed.
  function failNextPing(mcp: OrchestraiMcpClient): void {
    const sdk = (mcp as unknown as { client: { ping: () => Promise<unknown> } }).client
    sdk.ping = () => Promise.reject(new Error("MCP ping timed out (forced by test)"))
  }

  test("a failed ping during a call keeps the connection, and the call completes", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {})
    const mcp = await connected(1_500)
    const call = mcp.callTool("slow", {}, "in-flight", 10_000)
    await Bun.sleep(200)
    failNextPing(mcp)
    expect(await mcp.pingReady()).toBeFalse()
    expect(mcp.readiness().state).toBe("connected")
    expect(await call).toBe("slow done")
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0])).join(" | ")).toContain("keeping the connection")
  }, 20_000)

  test("a failed ping with nothing in flight still reconnects, and says so", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {})
    const mcp = await connected(10)
    failNextPing(mcp)
    expect(await mcp.pingReady()).toBeFalse()
    expect(mcp.readiness().state).not.toBe("connected")
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0])).join(" | ")).toContain("reconnecting")
    // It comes back on its own.
    expect(await mcp.callTool("slow", {}, "after-reconnect", 10_000)).toBe("slow done")
  }, 20_000)

  test("a normal ping during a call succeeds", async () => {
    const mcp = await connected(1_000)
    const call = mcp.callTool("slow", {}, "in-flight", 10_000)
    await Bun.sleep(100)
    expect(await mcp.pingReady()).toBeTrue()
    expect(await call).toBe("slow done")
  }, 20_000)
})
