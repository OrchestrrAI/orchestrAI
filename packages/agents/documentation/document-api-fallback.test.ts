// specs/036-document-api-path-fallback/spec.md
//
// This module's mcpClient is a real, unmockable singleton — there is no
// dependency-injection seam here, matching every other agent module in
// this repo. A real candidate read can cost up to
// packages/shared/mcp-client.ts's own TASK_RECONNECT_WINDOW_MS (3s)
// inside waitUntilReady() before it gives up (observed consistently, not
// a flake) — so the candidate-exhausted test below temporarily shrinks
// the exported DOCUMENT_API_ENTRY_CANDIDATES list to 2 entries instead of
// exercising all 8, keeping real network cost to ~6s instead of ~24s+ on
// every `bun test` run, while still exercising the exact same
// exhaustion/error-message logic (which doesn't depend on list length).
// The fallback's *success* path (finding a real entry file and detecting
// routes in it) is intentionally not covered here at all — see this
// checkpoint's own live verification against the real fixture project,
// recorded in specs/036's Acceptance Criteria and context/worklog.md,
// for that half. Test paths use POSIX-style "/tmp/..." throughout,
// matching this repo's existing test convention.
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { randomUUID } from "node:crypto"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see
// skill-ownership-http.test.ts's identical helper for why.
async function submit(app: any, body: Record<string, unknown>) {
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

async function getTask(app: any, id: string) {
  const res = await app.request(`/tasks/${id}`)
  return { status: res.status, json: await res.json() }
}

// processTask() runs fire-and-forget after submit() returns — poll instead
// of a fixed sleep, since a real candidate read can take several seconds.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitForTerminal(app: any, id: string, maxWaitMs = 15000) {
  const start = Date.now()
  let last = await getTask(app, id)
  while (Date.now() - start < maxWaitMs) {
    if (last.json.status === "failed" || last.json.status === "completed" || last.json.status === "input-required") {
      return last
    }
    await Bun.sleep(50)
    last = await getTask(app, id)
  }
  return last
}

const ENV_KEY = "ORCHESTRAI_PROJECT_PATH"
let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
})

describe("document-api — specs/036 path fallback", () => {
  test("an explicit path in the text still wins outright — no project-root resolution attempted", async () => {
    const { app } = await import("./index")
    const id = `t-${randomUUID()}`
    await submit(app, {
      id,
      message: { role: "user", parts: [{ text: "document the api at /tmp/test-project/index.ts" }] },
      selectedSkill: "document-api",
    })
    const { json } = await waitForTerminal(app, id)
    expect(json.status).toBe("failed")
    // Fails on the MCP read (no live server here), not on the old
    // unconditional "requires an explicit path" message — proves the
    // explicit path was accepted and used directly.
    expect(json.error).toContain("Path not found or unreadable")
    expect(json.error).toContain("/tmp/test-project/index.ts")
  }, 10000)

  test("no explicit path and no configured project root — unchanged failure message", async () => {
    const { app } = await import("./index")
    const id = `t-${randomUUID()}`
    await submit(app, {
      id,
      message: { role: "user", parts: [{ text: "document the api" }] },
      selectedSkill: "document-api",
    })
    const { json } = await waitForTerminal(app, id)
    expect(json.status).toBe("failed")
    expect(json.error).toBe("document-api requires an explicit absolute source-file path in the task")
  })

  test("no explicit path, a project root resolves, every candidate exhausted — clear fail-closed error naming the root and the checked list", async () => {
    const { app, DOCUMENT_API_ENTRY_CANDIDATES } = await import("./index")
    const originalCandidates = [...DOCUMENT_API_ENTRY_CANDIDATES]
    DOCUMENT_API_ENTRY_CANDIDATES.length = 0
    DOCUMENT_API_ENTRY_CANDIDATES.push("index.ts", "src/index.ts")
    try {
      process.env[ENV_KEY] = "/tmp/test-project"
      const id = `t-${randomUUID()}`
      await submit(app, {
        id,
        message: { role: "user", parts: [{ text: "document the api" }] },
        selectedSkill: "document-api",
      })
      const { json } = await waitForTerminal(app, id)
      expect(json.status).toBe("failed")
      expect(json.error).toContain("document-api requires an explicit absolute source-file path in the task")
      expect(json.error).toContain("/tmp/test-project")
      expect(json.error).toContain("index.ts")
      expect(json.error).toContain("src/index.ts")
    } finally {
      DOCUMENT_API_ENTRY_CANDIDATES.length = 0
      DOCUMENT_API_ENTRY_CANDIDATES.push(...originalCandidates)
    }
  }, 12000) // 2 shrunk candidates × up to mcp-client.ts's own 3000ms
  // TASK_RECONNECT_WINDOW_MS each, plus real margin.
})
