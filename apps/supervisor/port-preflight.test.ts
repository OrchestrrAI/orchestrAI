// specs/045-supervisor-port-preflight-timeout/spec.md
//
// Real, locally-bound sockets throughout — no mocking `net` — matching
// this package's own existing precedent (init-wizard.test.ts and
// project-path.test.ts use real filesystem round-trips for exactly this
// kind of low-level check, not mocks).
import { afterEach, describe, expect, test } from "bun:test"
import * as net from "net"
import { isPortFree } from "./index"

// A high, unlikely-to-collide range for these tests specifically.
let nextPort = 41100
function freshPort(): number {
  return nextPort++
}

let openServers: net.Server[] = []
afterEach(() => {
  for (const srv of openServers) srv.close()
  openServers = []
})

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once("error", reject)
    srv.once("listening", () => resolve(srv))
    srv.listen(port, "127.0.0.1")
  })
}

describe("isPortFree — the common case", () => {
  test("a genuinely free port resolves { free: true } quickly", async () => {
    const port = freshPort()
    const start = Date.now()
    const result = await isPortFree(port)
    const elapsed = Date.now() - start

    expect(result).toEqual({ free: true })
    // Well under the 3000ms timeout — this is the fast path, not the
    // bound being exercised.
    expect(elapsed).toBeLessThan(1000)
  })

  test("checking a free port doesn't leave it bound afterward", async () => {
    const port = freshPort()
    await isPortFree(port)
    // If isPortFree() left its own probe socket open, this second bind
    // would fail — proving the probe's close() actually completes on
    // the success path.
    const srv = await listenOn(port)
    openServers.push(srv)
    expect(srv.listening).toBe(true)
  })
})

describe("isPortFree — a genuine conflict", () => {
  test("a port already listening resolves { free: false, reason: \"in-use\" }", async () => {
    const port = freshPort()
    const srv = await listenOn(port)
    openServers.push(srv)

    const result = await isPortFree(port)
    expect(result).toEqual({ free: false, reason: "in-use" })
  })
})

// A stand-in for the real (narrow, Windows-timing-dependent) stuck-socket
// condition this spec exists for: a server double whose `listen()`
// deliberately never emits "error" or "listening". Proves the timeout
// bound holds, independent of reproducing the exact real-world trigger.
function stuckServer(): net.Server {
  const srv = new net.Server()
  srv.listen = () => srv
  return srv
}

describe("isPortFree — the timeout this spec adds", () => {
  test("resolves within the bound even if listen() never settles", async () => {
    const port = freshPort()
    const start = Date.now()
    const result = await isPortFree(port, { timeoutMs: 200, createServer: stuckServer })
    const elapsed = Date.now() - start

    expect(result).toEqual({ free: false, reason: "timeout" })
    // Genuinely bounded to the injected timeout — not "eventually".
    expect(elapsed).toBeGreaterThanOrEqual(190)
    expect(elapsed).toBeLessThan(1000)
  })

  test("a timed-out check still safely refuses — never resolves free on a stuck socket", async () => {
    const port = freshPort()
    const result = await isPortFree(port, { timeoutMs: 200, createServer: stuckServer })
    // The load-bearing safety property: whatever the cause, a stuck
    // check must never be reported as "free" — that would let the
    // preflight loop start a service on a port it never actually
    // confirmed was available.
    expect(result.free).toBe(false)
  })

  test("the real default timeout is 3000ms — the production call site's actual bound", async () => {
    const port = freshPort()
    const start = Date.now()
    // No timeoutMs override — exercises PORT_CHECK_TIMEOUT_MS itself.
    const result = await isPortFree(port, { createServer: stuckServer })
    const elapsed = Date.now() - start

    expect(result).toEqual({ free: false, reason: "timeout" })
    expect(elapsed).toBeGreaterThanOrEqual(2900)
    expect(elapsed).toBeLessThan(4000)
  }, 6000)
})
