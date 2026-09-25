// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md
//
// HTTP-level, table-driven coverage across all four agents: explicit-skill
// precedence, ownership rejection before task storage, and unchanged legacy
// detection. Then the exact live regression and its inverse, against the
// real DevOps app — no mocked skill resolution, the actual POST handler and
// processTask() path. Test paths use POSIX-style "/tmp/..." throughout,
// deliberately avoiding Windows backslashes in string literals here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"

// specs/077-agent-enabled-means-llm-on-by-default/spec.md flipped every
// agent harness's own default to on — this file is about specs/030's
// skill-ownership/dispatch mechanics, not any agent's LLM harness, so it
// deliberately opts every harness-having agent out for the duration of
// this file. Without this, e.g. DevOps's dockerize would try (and, with
// no key configured, fail closed on) its own harness before ever
// reaching the deterministic approval preview this file's own
// assertions expect.
const HARNESS_VARS = [
  "ORCHESTRAI_DEVOPS_LLM_HARNESS",
  "ORCHESTRAI_DOCUMENTATION_LLM_HARNESS",
  "ORCHESTRAI_SECURITY_LLM_HARNESS",
  "ORCHESTRAI_TESTING_LLM_HARNESS",
]
const originalHarnessEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const key of HARNESS_VARS) {
    originalHarnessEnv[key] = process.env[key]
    process.env[key] = "0"
  }
})
afterAll(() => {
  for (const key of HARNESS_VARS) {
    if (originalHarnessEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalHarnessEnv[key]
  }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono's app
// type differs slightly per agent module (different route definitions);
// this file only ever calls the two methods used below.
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

// specs/040-approval-preview-content-diff/spec.md — DevOps's approval
// preview now does one real (dry_run) MCP tool call before reaching
// input-required, so the "working" -> "input-required" transition is no
// longer effectively synchronous with submit()'s own await chain. Polls
// briefly rather than assuming the state is already reached, mirroring
// apps/orchestrator/supervisor-wiring.test.ts's own waitForTaskStatus().
async function getTaskAfter(app: any, id: string, status: string, maxMs = 2000): Promise<{ status: number; json: any }> {
  const start = Date.now()
  let last = await getTask(app, id)
  while (Date.now() - start < maxMs) {
    if (last.json.status === status) return last
    await Bun.sleep(10)
    last = await getTask(app, id)
  }
  return last
}

// One entry per agent: its own exported `app`, one skill it legitimately
// owns, one skill owned only by a *different* agent (foreign), and legacy
// task text that already exercises that owned skill via the pre-existing
// text detector, so the "absent selectedSkill" case is a real behavior
// check, not just a shape check.
//
// specs/051-planning-retirement-and-required-key/spec.md — planning-agent
// removed: it is deleted entirely, and plan-task now belongs to the
// Orchestrator's own adaptive supervisor, not an HTTP agent with a
// selectedSkill precedence to test here.
const agentModules = [
  { name: "devops-agent", mod: () => import("./devops/index"), ownedSkill: "git-status", foreignSkill: "scan-secrets", legacyText: "check git status at /tmp/test-project" },
  { name: "testing-agent", mod: () => import("./testing/index"), ownedSkill: "run-tests", foreignSkill: "git-status", legacyText: "run tests at /tmp/test-project" },
  { name: "documentation-agent", mod: () => import("./documentation/index"), ownedSkill: "generate-readme", foreignSkill: "dockerize", legacyText: "generate a readme at /tmp/test-project" },
  { name: "security-agent", mod: () => import("./security/index"), ownedSkill: "scan-secrets", foreignSkill: "run-tests", legacyText: "scan for secrets at /tmp/test-project" },
]

describe.each(agentModules)("$name — specs/030 explicit skill precedence (table-driven)", ({ mod, ownedSkill, foreignSkill, legacyText }) => {
  test("accepts a valid owned selectedSkill", async () => {
    const { app } = await mod()
    const id = `t-${randomUUID()}`
    const { status, json } = await submit(app, {
      id,
      message: { role: "user", parts: [{ text: legacyText }] },
      selectedSkill: ownedSkill,
    })
    expect(status).toBe(200)
    expect(json.status).toBe("submitted")
  })

  test("rejects a foreign selectedSkill with 400, before any task storage", async () => {
    const { app } = await mod()
    const id = `t-${randomUUID()}`
    const { status } = await submit(app, {
      id,
      message: { role: "user", parts: [{ text: legacyText }] },
      selectedSkill: foreignSkill,
    })
    expect(status).toBe(400)

    // Never stored — GET must report not-found, not any status at all.
    const fetched = await getTask(app, id)
    expect(fetched.status).toBe(404)
  })

  test("rejects a malformed selectedSkill with 400, before any task storage", async () => {
    const { app } = await mod()
    const id = `t-${randomUUID()}`
    const { status } = await submit(app, {
      id,
      message: { role: "user", parts: [{ text: legacyText }] },
      selectedSkill: "Not A Valid Skill!!",
    })
    expect(status).toBe(400)
    expect((await getTask(app, id)).status).toBe(404)
  })

  test("legacy request with no selectedSkill is accepted exactly as before this checkpoint", async () => {
    const { app } = await mod()
    const id = `t-${randomUUID()}`
    const { status, json } = await submit(app, {
      id,
      message: { role: "user", parts: [{ text: legacyText }] },
    })
    expect(status).toBe(200)
    expect(json.status).toBe("submitted")
  })
})

describe("DevOps — exact live regression from 026/029 verification evidence (specs/030)", () => {
  test("explicit git-status stays git-status even when the description mentions Dockerfile, compose, and CI", async () => {
    const { app } = await import("./devops/index")
    const id = `t-${randomUUID()}`
    await submit(app, {
      id,
      message: {
        role: "user",
        parts: [{
          text: "git-status: Check status — note the project already has a Dockerfile, a docker-compose.yml, and a CI pipeline present — at /tmp/test-project",
        }],
      },
      selectedSkill: "git-status",
    })

    // Give the async (MCP-calling) branch a moment to run; it will fail in
    // this test environment (no live MCP server) but must never reach
    // input-required, which is structurally reachable only from the
    // NEEDS_APPROVAL branch — gated on `skill`, not on any word in the text.
    await Bun.sleep(50)
    const fetched = await getTask(app, id)
    expect(fetched.json.status).not.toBe("input-required")
    expect(fetched.json.approval).toBeUndefined()
  })

  test("explicit dockerize is still honored even when the description mentions only git status", async () => {
    // specs/138 — dockerize is model-authored now; with the DevOps LLM off
    // it fails closed with a named error. That error naming "dockerize"
    // (not a git-status result) is what proves the explicit selection won.
    process.env.ORCHESTRAI_DEVOPS_LLM_HARNESS = "0"
    const { app } = await import("./devops/index")
    const id = `t-${randomUUID()}`
    await submit(app, {
      id,
      message: {
        role: "user",
        parts: [{ text: "dockerize: current git status shows no pending changes — at /tmp/test-project" }],
      },
      selectedSkill: "dockerize",
    })

    try {
      const fetched = await getTaskAfter(app, id, "failed", 5_000)
      expect(fetched.json.status).toBe("failed")
      expect(fetched.json.error).toContain(`"dockerize"`)
      expect(fetched.json.error).toContain("specs/138")
    } finally {
      delete process.env.ORCHESTRAI_DEVOPS_LLM_HARNESS
    }
  })
})
