// specs/040-approval-preview-content-diff/spec.md
//
// This module's mcpClient is a real, unmockable singleton — no dependency-
// injection seam exists here (see document-api-fallback.test.ts's own
// identical note). A real content-compute call, success or failure, costs
// packages/shared/mcp-client.ts's own TASK_RECONNECT_WINDOW_MS (~3s) per
// MCP round trip in this no-live-server test environment, and
// generate-readme's own computeReadmeContent() makes several such calls
// with each individually degrading rather than throwing (preserving the
// original pre-040 skillGenerateReadme()'s exact graceful-degradation
// shape) — too slow and too timing-dependent to be a good permanent
// bun test case. What's verified here is the fast, deterministic
// synchronous-failure path for each skill (no MCP call involved at all);
// real content-preview correctness (byte-identical write vs. preview,
// the approve-vs-write drift guarantee) is verified live — see this
// spec's Verification Results, the same split document-api-fallback.
// test.ts already established for its own success path.
import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function submit(app: any, body: Record<string, unknown>) {
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTask(app: any, id: string) {
  const res = await app.request(`/tasks/${id}`)
  return { status: res.status, json: await res.json() }
}

describe("generate-readme (specs/040)", () => {
  test("an invalid target path fails synchronously, before any content-compute attempt", async () => {
    const { app } = await import("./index")
    const id = `t-${randomUUID()}`
    // No absolute path in the text and no ORCHESTRAI_PROJECT_PATH set —
    // resolveTargetPath() throws before computeReadmeContent() is ever
    // reached, exactly as it did pre-040.
    const savedEnv = process.env.ORCHESTRAI_PROJECT_PATH
    delete process.env.ORCHESTRAI_PROJECT_PATH
    try {
      await submit(app, {
        id,
        message: { role: "user", parts: [{ text: "generate a readme" }] },
        selectedSkill: "generate-readme",
      })
      const fetched = await getTask(app, id)
      expect(fetched.json.status).toBe("failed")
      expect(fetched.json.approval).toBeUndefined()
    } finally {
      if (savedEnv !== undefined) process.env.ORCHESTRAI_PROJECT_PATH = savedEnv
    }
  })
})

describe("document-api write path (specs/040)", () => {
  test("a content-compute failure fails the task closed before requesting approval", async () => {
    const { app } = await import("./index")
    const id = `t-${randomUUID()}`
    await submit(app, {
      id,
      message: {
        role: "user",
        parts: [{ text: "document the api at /tmp/test-project/index.ts save to /tmp/test-project/API.md" }],
      },
      selectedSkill: "document-api",
    })

    // This one genuinely throws (computeApiDoc's readProjectPath call is
    // not individually caught the way generate-readme's reads are), so it
    // reaches "failed" within one ~3s MCP round trip — fast enough for
    // bun test's default per-test timeout.
    let fetched = await getTask(app, id)
    const start = Date.now()
    while (fetched.json.status === "working" && Date.now() - start < 4500) {
      await Bun.sleep(50)
      fetched = await getTask(app, id)
    }
    expect(fetched.json.status).toBe("failed")
    expect(fetched.json.approval).toBeUndefined()
  })
})
