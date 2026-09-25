import { randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { boundTaskResult, emitAuditEvent, emitAuditStart, utf8ByteLength } from "./audit"
import { isAllowedMcpHost } from "./mcp-host-allowlist"
import { resolveServicePort } from "./service-ports"

// ============================================================
// SHARED MCP CLIENT
// ============================================================
// Generalizes what was previously packages/agents/devops/mcp-client.ts
// (DevOps-only: hardcoded client name, hardcoded required-tools set) so any
// agent can be a real MCP client with the same connection-lifecycle
// guarantees: bounded backoff, stale-session retry-once, ping-based
// readiness, and a stop-during-connect generation guard. See
// specs/011-remaining-agents-mcp/spec.md.

const CONNECT_TIMEOUT_MS = 2_000
const TASK_RECONNECT_WINDOW_MS = 3_000
const TOOL_TIMEOUT_MS = 15_000
// specs/143 — was 500 ms, which a busy machine (a real docker build) can
// exceed. Still well inside the Orchestrator's 3 s health-check timeout.
const PING_TIMEOUT_MS = 2_000
const SESSION_TERMINATE_TIMEOUT_MS = 1_000
const BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000]

export type McpConnectionState = "disconnected" | "connecting" | "retrying" | "connected" | "stopped"

export interface McpReadiness {
  state: McpConnectionState
  url: string
  lastError?: string
  discoveredTools: string[]
}

export interface McpClientOptions {
  /** Becomes the audit "caller" field and the SDK Client's declared name. */
  callerName: string
  /** Tools this agent requires; connection fails if the server is missing any. */
  requiredTools: string[]
  /** Defaults to ORCHESTRAI_MCP_URL, then the loopback checkpoint default. */
  url?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isStaleSessionError(error: unknown): boolean {
  if (error instanceof StreamableHTTPError && error.code === 404) return true
  return /unknown mcp session/i.test(errorMessage(error))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function validateMcpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl)
  if (url.protocol !== "http:") throw new Error("Checkpoint MCP URL must use http://")
  if (!isAllowedMcpHost(url.hostname)) {
    throw new Error(
      `MCP URL hostname "${url.hostname}" is not allowed — use localhost/127.0.0.1, ` +
      `or add it to ORCHESTRAI_MCP_ALLOWED_HOSTS (e.g. for a Docker Compose service name)`
    )
  }
  return url
}

export class OrchestraiMcpClient {
  private readonly url: URL
  private readonly callerName: string
  private readonly requiredTools: Set<string>
  private client?: Client
  private transport?: StreamableHTTPClientTransport
  private loop?: Promise<void>
  private shouldRun = false
  private state: McpConnectionState = "disconnected"
  private lastError?: string
  private discoveredTools: string[] = []
  // Bumped on every stop() so an in-flight connectOnce() from a previous
  // lifecycle can detect it should discard its result instead of publishing
  // a late client (stop-during-connect race).
  private generation = 0
  // specs/143 — tool calls currently running on this connection. A failed
  // health ping must never tear down a connection that is doing real work.
  private inFlight = 0

  constructor(options: McpClientOptions) {
    this.callerName = options.callerName
    this.requiredTools = new Set(options.requiredTools)
    // specs/073-configurable-service-ports/spec.md — ORCHESTRAI_MCP_URL
    // (an explicit full-URL override) still wins first; otherwise the
    // default is built from ORCHESTRAI_MCP_PORT so a custom mcp:http port
    // is actually discoverable, not just bindable.
    this.url = validateMcpUrl(
      options.url ?? process.env.ORCHESTRAI_MCP_URL ?? `http://127.0.0.1:${resolveServicePort("mcpHttp")}/mcp`,
    )
  }

  start(): void {
    if (this.shouldRun) return
    this.shouldRun = true
    this.ensureConnectionLoop()
  }

  async stop(): Promise<void> {
    this.shouldRun = false
    this.state = "stopped"
    this.generation += 1
    const client = this.client
    const transport = this.transport
    this.client = undefined
    this.transport = undefined
    this.discoveredTools = []
    if (transport) {
      await withTimeout(transport.terminateSession(), SESSION_TERMINATE_TIMEOUT_MS, "MCP session termination").catch(() => undefined)
    }
    if (client) await client.close().catch(() => undefined)
  }

  readiness(): McpReadiness {
    return {
      state: this.state,
      url: this.url.toString(),
      lastError: this.lastError,
      discoveredTools: [...this.discoveredTools],
    }
  }

  /**
   * Bounded liveness probe for /healthz, rather than trusting a cached client
   * object. Ping failure invalidates only the captured client and starts
   * reconnect; it never waits through the full task reconnect window.
   *
   * specs/143 — except while a tool call is in flight: closing the client
   * then killed that call ("MCP error -32000: Connection closed") even though
   * the server finished the work (a real docker build did). With calls in
   * flight a failed ping only reports not-ready; the calls themselves still
   * detect a genuinely dead connection.
   */
  async pingReady(timeoutMs = PING_TIMEOUT_MS): Promise<boolean> {
    const client = this.client
    if (!client || this.state !== "connected") return false
    try {
      await withTimeout(client.ping(), timeoutMs, "MCP ping")
      return true
    } catch (error) {
      if (this.inFlight > 0) {
        console.warn(`[${this.callerName}] MCP ping failed (${errorMessage(error)}) with ${this.inFlight} call(s) in flight — keeping the connection`)
        return false
      }
      console.warn(`[${this.callerName}] MCP ping failed (${errorMessage(error)}) — reconnecting`)
      this.markDisconnected(client, error)
      return false
    }
  }

  private ensureConnectionLoop(): void {
    if (!this.shouldRun || this.client || this.loop) return
    this.loop = this.connectionLoop().finally(() => {
      this.loop = undefined
      if (this.shouldRun && !this.client) this.ensureConnectionLoop()
    })
  }

  private async connectionLoop(): Promise<void> {
    let attempt = 0
    while (this.shouldRun && !this.client) {
      this.state = attempt === 0 ? "connecting" : "retrying"
      try {
        await this.connectOnce()
        if (this.client) {
          this.state = "connected"
          this.lastError = undefined
        }
        return
      } catch (error) {
        this.state = "retrying"
        this.lastError = errorMessage(error)
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
        attempt += 1
        await Bun.sleep(delay)
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const myGeneration = this.generation
    const client = new Client({ name: `orchestrai-${this.callerName}`, version: "1.0.0" })
    const transport = new StreamableHTTPClientTransport(this.url)

    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "MCP connection")
      const listing = await client.listTools({}, { timeout: CONNECT_TIMEOUT_MS })
      const discovered = listing.tools.map((tool) => tool.name).sort()
      const missing = Array.from(this.requiredTools).filter((tool) => !discovered.includes(tool))
      if (missing.length > 0) throw new Error(`MCP server missing required tools: ${missing.join(", ")}`)

      // Stop-during-connect guard: if stop() ran while we were connecting,
      // discard this client instead of resurrecting state.
      if (!this.shouldRun || myGeneration !== this.generation) {
        await client.close().catch(() => undefined)
        return
      }

      client.onclose = () => {
        if (this.client !== client) return
        this.client = undefined
        this.transport = undefined
        this.discoveredTools = []
        this.state = this.shouldRun ? "retrying" : "stopped"
        this.ensureConnectionLoop()
      }

      this.client = client
      this.transport = transport
      this.discoveredTools = discovered
    } catch (error) {
      await client.close().catch(() => undefined)
      throw error
    }
  }

  private async waitUntilReady(timeoutMs = TASK_RECONNECT_WINDOW_MS): Promise<Client> {
    this.start()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.client && this.state === "connected") return this.client
      await Bun.sleep(50)
    }
    throw new Error(`MCP unavailable after ${timeoutMs}ms${this.lastError ? `: ${this.lastError}` : ""}`)
  }

  private markDisconnected(client: Client, error: unknown): void {
    if (this.client !== client) return
    this.lastError = errorMessage(error)
    this.client = undefined
    this.transport = undefined
    this.discoveredTools = []
    this.state = this.shouldRun ? "retrying" : "stopped"
    void client.close().catch(() => undefined)
    this.ensureConnectionLoop()
  }

  // specs/080-run-command-approved-execution/spec.md §4 — absorbs
  // specs/076's own diagnosed bug: this was previously hardcoded to
  // TOOL_TIMEOUT_MS (15s) for every tool uniformly, which is far too
  // short for a real external process (run_tests already needs up to
  // FIXED_TEST_TIMEOUT_MS=120s server-side; run_command needs the same
  // shape). Optional and defaulting to the exact original value, so
  // every pre-existing call site (analyze_project, create_dockerfile,
  // etc.) is byte-identical.
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    taskId: string,
    timeoutMs: number = TOOL_TIMEOUT_MS,
  ): Promise<string> {
    const started = performance.now()
    let outcome: "completed" | "failed" | "timeout" = "failed"
    let resultBytes = 0
    let resultTruncated = false
    let staleSessionRetried = false

    // specs/021-ag-ui-event-protocol/spec.md — announce the call before it runs
    // so clients render it in flight; the matching result is pushed from the
    // finally block below. Fire-and-forget, never awaited. callId is minted
    // here (the producer) and reused unchanged below, rather than derived
    // from taskId/kind/target on the Orchestrator — see emitAuditStart()'s
    // doc comment for why (a task calling the same tool twice would
    // otherwise collide).
    const callId = randomUUID()
    emitAuditStart({ kind: "mcp-tool-call", caller: this.callerName, target: toolName, taskId, callId })

    const attempt = async (): Promise<string> => {
      const client = await this.waitUntilReady()
      let result
      try {
        result = await client.callTool(
          {
            name: toolName,
            arguments: args,
            _meta: { caller: this.callerName, taskId },
          },
          undefined,
          { timeout: timeoutMs },
        )
      } catch (error) {
        // A 404/-32001 "Unknown MCP session" is generated before tool
        // dispatch, so it is always safe to reconnect and retry the
        // identical call exactly once. Never perform a second retry for the
        // same logical call, and never retry ambiguous transport failures
        // (timeout, connection reset) where the write may already have begun.
        if (isStaleSessionError(error) && !staleSessionRetried) {
          staleSessionRetried = true
          this.markDisconnected(client, error)
          return attempt()
        }
        if (/closed|connect|fetch|transport|network/i.test(errorMessage(error))) {
          this.markDisconnected(client, error)
        }
        if (/timed out|timeout/i.test(errorMessage(error))) outcome = "timeout"
        throw error
      }

      // See specs/014-typecheck-ci/spec.md — the SDK's callTool() result type
      // isn't narrowable generically; cast to the shape actually returned.
      const content = result.content as { type: string; text: string }[]
      const text = content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n")

      if (result.isError) throw new Error(text || `MCP tool ${toolName} failed`)

      const bounded = boundTaskResult(text)
      resultBytes = bounded.originalBytes
      resultTruncated = bounded.truncated
      outcome = "completed"
      return bounded.text
    }

    this.inFlight += 1
    try {
      return await attempt()
    } catch (error) {
      if (resultBytes === 0) resultBytes = utf8ByteLength(errorMessage(error))
      throw error
    } finally {
      this.inFlight -= 1
      emitAuditEvent({
        kind: "mcp-tool-call",
        caller: this.callerName,
        target: toolName,
        taskId,
        callId,
        params: { ...args, retried: staleSessionRetried },
        outcome,
        durationMs: performance.now() - started,
        resultBytes,
        resultTruncated,
      })
    }
  }
}

// ============================================================
// MULTI-ENDPOINT ROUTING (specs/079-phase-a-connect-orphaned-tools/spec.md §6)
// ============================================================
// An agent could previously reach exactly ONE MCP server — every one of
// its requiredTools had to exist there, or the connection failed
// outright. This is purely additive: OrchestraiMcpClient itself is
// completely unchanged above, so every existing single-endpoint call
// site (DevOps/Testing/Documentation, all still constructing it
// directly) is byte-identical. OrchestraiMultiMcpClient is a caller-side
// router over N independent OrchestraiMcpClient instances — one per
// endpoint — so a locally-run third-party MCP server (the official
// filesystem server, a Docker/Postgres MCP server — anything binding
// loopback) can sit alongside `mcp:http` as a second endpoint with ZERO
// change to the loopback/http:-only rule every endpoint still goes
// through individually via validateMcpUrl() inside its own
// OrchestraiMcpClient.

export interface McpEndpointOptions {
  /** A short label for this endpoint — used in error messages and
   *  readiness reporting, and namespaced into the SDK client's own
   *  declared name so two endpoints' connections are distinguishable in
   *  any server-side logging. */
  name: string
  requiredTools: string[]
  url?: string
}

export interface MultiMcpReadiness {
  state: McpConnectionState
  endpoints: (McpReadiness & { name: string })[]
}

export class OrchestraiMultiMcpClient {
  private readonly endpoints: { name: string; client: OrchestraiMcpClient; requiredTools: Set<string> }[]

  constructor(callerName: string, endpoints: McpEndpointOptions[]) {
    if (endpoints.length === 0) {
      throw new Error("OrchestraiMultiMcpClient requires at least one endpoint")
    }
    // Fail closed at CONSTRUCTION time, not at first callTool() — an
    // ambiguous configuration should never even start connecting.
    // Mirrors specs/030's "a skill owned by two agents" refusal: a tool
    // name must belong to exactly one endpoint, never resolved
    // arbitrarily.
    const owningEndpoint = new Map<string, string>()
    for (const endpoint of endpoints) {
      for (const tool of endpoint.requiredTools) {
        const existingOwner = owningEndpoint.get(tool)
        if (existingOwner && existingOwner !== endpoint.name) {
          throw new Error(
            `Tool "${tool}" is declared by more than one MCP endpoint ("${existingOwner}" and "${endpoint.name}") — ` +
              "each tool must belong to exactly one configured endpoint.",
          )
        }
        owningEndpoint.set(tool, endpoint.name)
      }
    }
    this.endpoints = endpoints.map((endpoint) => ({
      name: endpoint.name,
      client: new OrchestraiMcpClient({
        callerName: `${callerName}-${endpoint.name}`,
        requiredTools: endpoint.requiredTools,
        url: endpoint.url,
      }),
      requiredTools: new Set(endpoint.requiredTools),
    }))
  }

  start(): void {
    for (const { client } of this.endpoints) client.start()
  }

  async stop(): Promise<void> {
    await Promise.all(this.endpoints.map(({ client }) => client.stop()))
  }

  /** Overall state: "connected" only once every configured endpoint is;
   *  the per-endpoint detail is always available for a richer /healthz
   *  report than a single collapsed state could give. */
  readiness(): MultiMcpReadiness {
    const endpointReadiness = this.endpoints.map(({ name, client }) => ({ name, ...client.readiness() }))
    const allConnected = endpointReadiness.every((r) => r.state === "connected")
    const allStopped = endpointReadiness.every((r) => r.state === "stopped")
    const anyConnecting = endpointReadiness.some((r) => r.state === "connecting" || r.state === "retrying")
    const state: McpConnectionState = allConnected ? "connected" : allStopped ? "stopped" : anyConnecting ? "retrying" : "disconnected"
    return { state, endpoints: endpointReadiness }
  }

  async pingReady(): Promise<boolean> {
    const results = await Promise.all(this.endpoints.map(({ client }) => client.pingReady()))
    return results.every(Boolean)
  }

  private resolveEndpointFor(toolName: string): OrchestraiMcpClient {
    const owner = this.endpoints.find(({ requiredTools }) => requiredTools.has(toolName))
    if (!owner) {
      throw new Error(
        `No configured MCP endpoint declares tool "${toolName}" — endpoints: ${this.endpoints.map((e) => e.name).join(", ") || "(none)"}`,
      )
    }
    return owner.client
  }

  async callTool(toolName: string, args: Record<string, unknown>, taskId: string, timeoutMs?: number): Promise<string> {
    return this.resolveEndpointFor(toolName).callTool(toolName, args, taskId, timeoutMs)
  }
}
