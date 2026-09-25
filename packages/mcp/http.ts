import { randomUUID } from "node:crypto"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { createMcpServer } from "./index"
import { isAllowedMcpHost } from "../shared/mcp-host-allowlist"
import { resolveServicePort } from "../shared/service-ports"

// Bind address is a separate defense-in-depth layer from isAllowedMcpHost's
// application-level Host-header check above: 127.0.0.1 by default means the
// socket itself refuses any connection that didn't originate on the same
// machine, regardless of what Host header it presents. Docker Compose sets
// ORCHESTRAI_MCP_BIND_HOST=0.0.0.0 (only inside its own network) so other
// containers can reach this service at all — bare-metal `bun run dev` never
// sets this and keeps the original 127.0.0.1-only bind.
const HOST = process.env.ORCHESTRAI_MCP_BIND_HOST ?? "127.0.0.1"
// specs/073-configurable-service-ports/spec.md — ORCHESTRAI_MCP_PORT,
// falling back to the original 3006 literal.
const PORT = resolveServicePort("mcpHttp")

type Session = {
  server: ReturnType<typeof createMcpServer>
  transport: WebStandardStreamableHTTPServerTransport
}

const sessions = new Map<string, Session>()

function jsonError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status })
}

function isAllowedRequestHost(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase()
  return isAllowedMcpHost(hostname)
}

async function handleMcpRequest(request: Request): Promise<Response> {
  if (!isAllowedRequestHost(request)) {
    return jsonError(403, -32000, "Forbidden host")
  }

  const sessionId = request.headers.get("mcp-session-id")
  if (sessionId) {
    const session = sessions.get(sessionId)
    if (!session) return jsonError(404, -32001, "Unknown MCP session")
    return session.transport.handleRequest(request)
  }

  if (request.method !== "POST") {
    return jsonError(400, -32000, "Missing MCP session ID")
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError(400, -32700, "Invalid JSON")
  }

  if (!isInitializeRequest(body)) {
    return jsonError(400, -32000, "Expected an MCP initialize request")
  }

  let initializedSessionId: string | undefined
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      initializedSessionId = id
    },
    onsessionclosed: (id) => {
      sessions.delete(id)
    },
  })
  const mcpServer = createMcpServer()

  transport.onclose = () => {
    if (initializedSessionId) sessions.delete(initializedSessionId)
  }

  await mcpServer.connect(transport)
  const response = await transport.handleRequest(request, { parsedBody: body })

  if (initializedSessionId) {
    sessions.set(initializedSessionId, { server: mcpServer, transport })
  }

  return response
}

// Exported + guarded (specs/017-standalone-binary-distribution/spec.md) so a
// combined binary can import this module and start it on demand without it
// auto-starting merely by being imported. `bun run packages/mcp/http.ts`
// is unaffected — import.meta.main is still true for that exact
// invocation, same as before this change.
export function start() {
  const httpServer = Bun.serve({
    hostname: HOST,
    port: PORT,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/healthz" && request.method === "GET") {
        return Response.json({ status: "ok", service: "orchestrai-mcp-http", sessions: sessions.size })
      }
      if (url.pathname === "/mcp") return handleMcpRequest(request)
      return new Response("Not found", { status: 404 })
    },
  })

  let stopping = false
  async function shutdown(): Promise<void> {
    if (stopping) return
    stopping = true
    await Promise.allSettled(Array.from(sessions.values(), ({ server }) => server.close()))
    sessions.clear()
    httpServer.stop(true)
  }

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())

  console.log(`OrchestrAI MCP HTTP Server listening at http://${HOST}:${PORT}/mcp`)
  console.log(`Health check: http://${HOST}:${PORT}/healthz`)
}

if (import.meta.main) {
  start()
}
