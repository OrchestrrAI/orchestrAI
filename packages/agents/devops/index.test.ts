// specs/079-phase-a-connect-orphaned-tools/spec.md
//
// Real HTTP-level tests against the actual DevOps app — no mocked skill
// resolution, matching packages/agents/skill-ownership-http.test.ts's own
// convention. `mcpClient` is never started in this test process (no live
// mcp:http server), so any skill that genuinely needs a real MCP round
// trip (commit-changes, docker-status, git-diff) reaches a graceful
// "failed" here rather than a real result — that success path is this
// spec's own "live, real stack" verification item, not a unit test.
// build-image and verify-deployment need NO MCP call to reach
// input-required at all (their PendingAction is built synchronously,
// same shape prepareWriteAction() already used for the four original
// write skills), so those ARE fully testable here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { agentCard, app, defaultImageName, extractImageTag, renderCodebaseAnalysis } from "./index"
import { __resetSharedStoreForTests } from "../../shared/store"

// A test-only "/tmp/test-project" target path (never a real directory)
// flows into analyze-project's codebase-analysis section, which can
// consult the shared result store. Force ORCHESTRAI_PERSIST=0 for this
// file's duration so a developer's own real ORCHESTRAI_PROJECT_PATH
// (unrelated to this file's fake target paths) is never touched.
let originalPersist: string | undefined
beforeAll(() => {
  originalPersist = process.env.ORCHESTRAI_PERSIST
  process.env.ORCHESTRAI_PERSIST = "0"
  __resetSharedStoreForTests()
})
afterAll(() => {
  if (originalPersist === undefined) delete process.env.ORCHESTRAI_PERSIST
  else process.env.ORCHESTRAI_PERSIST = originalPersist
  __resetSharedStoreForTests()
})

async function submit(body: Record<string, unknown>) {
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

async function getTask(id: string): Promise<{ status: number; json: any }> {
  const res = await app.request(`/tasks/${id}`)
  return { status: res.status, json: await res.json() }
}

async function getTaskAfter(id: string, statuses: string[], maxMs = 3000): Promise<{ status: number; json: any }> {
  const start = Date.now()
  let last = await getTask(id)
  while (Date.now() - start < maxMs) {
    if (statuses.includes(last.json.status)) return last
    await Bun.sleep(10)
    last = await getTask(id)
  }
  return last
}

function taskBody(id: string, text: string, selectedSkill?: string) {
  return {
    id,
    message: { role: "user", parts: [{ text }] },
    ...(selectedSkill ? { selectedSkill } : {}),
  }
}

describe("specs/079 — Agent Card advertises the five new skills", () => {
  test("build-image, verify-deployment, docker-status, git-diff, commit-changes are all present", () => {
    const ids = agentCard.skills.map((s) => s.id)
    expect(ids).toContain("build-image")
    expect(ids).toContain("verify-deployment")
    expect(ids).toContain("docker-status")
    expect(ids).toContain("git-diff")
    expect(ids).toContain("commit-changes")
  })
})

describe("specs/079 — build-image (executing skill, no MCP call needed to reach approval)", () => {
  test("reaches input-required with a docker_build approval preview, no dry-run/preflight involved", async () => {
    const id = `t-${randomUUID()}`
    const { status } = await submit(taskBody(id, "build image at /tmp/test-project", "build-image"))
    expect(status).toBe(200)

    const task = await getTaskAfter(id, ["input-required", "failed"])
    expect(task.json.status).toBe("input-required")
    expect(task.json.approval.toolName).toBe("docker_build")
    expect(task.json.approval.target).toMatch(/:latest$/) // the derived image tag
    expect(task.json.approval.parameters.context_path).toBeDefined()
    expect(task.json.approval.risks.join(" ")).toContain("docker build")
  })

  test("an explicit image tag in the request text is used verbatim", async () => {
    const id = `t-${randomUUID()}`
    const { status } = await submit(taskBody(id, "build image tag: myapp:v2 at /tmp/test-project", "build-image"))
    expect(status).toBe(200)
    const task = await getTaskAfter(id, ["input-required", "failed"])
    expect(task.json.approval.parameters.image_tag).toBe("myapp:v2")
  })
})

describe("specs/079 — verify-deployment (executing skill, no MCP call needed to reach approval)", () => {
  test("reaches input-required with a docker_run approval preview", async () => {
    const id = `t-${randomUUID()}`
    const { status } = await submit(taskBody(id, "verify deployment at /tmp/test-project", "verify-deployment"))
    expect(status).toBe(200)
    const task = await getTaskAfter(id, ["input-required", "failed"])
    expect(task.json.status).toBe("input-required")
    expect(task.json.approval.toolName).toBe("docker_run")
    expect(task.json.approval.risks.join(" ")).toContain("container")
  })
})

describe("specs/079 — read-only skills route correctly (docker-status, git-diff)", () => {
  // No live MCP server in this test process, so these reach a graceful
  // "failed" (a real MCP connection error) rather than a real result —
  // the point of this test is that the skill routes to the right
  // handler and fails cleanly, never hangs or throws unhandled.
  test("docker-status is detected and dispatched, not left unimplemented", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "docker status", "docker-status"))
    // The MCP connection attempt itself takes ~3s to fail in this
    // no-live-server test environment; a generous poll window is needed
    // to observe the real terminal state rather than catching it
    // mid-"working".
    const task = await getTaskAfter(id, ["completed", "failed"], 8000)
    expect(task.json.status).not.toBe("submitted")
    expect(task.json.status).not.toBe("working")
    if (task.json.status === "completed") expect(task.json.result).not.toContain("not implemented yet")
  })

  test("git-diff is detected and dispatched, not left unimplemented", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "git diff at /tmp/test-project", "git-diff"))
    const task = await getTaskAfter(id, ["completed", "failed"], 8000)
    expect(task.json.status).not.toBe("submitted")
    expect(task.json.status).not.toBe("working")
    if (task.json.status === "completed") expect(task.json.result).not.toContain("not implemented yet")
  })
})

describe("specs/079 — commit-changes fails gracefully without a live MCP server", () => {
  test("reaches a real failed state, never hangs or throws unhandled", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "commit changes: fix the bug at /tmp/test-project", "commit-changes"))
    // computeFullUncommittedDiff() makes TWO sequential MCP calls before
    // this can resolve, so it needs an even wider window than the
    // single-call skills above.
    const task = await getTaskAfter(id, ["failed", "input-required", "completed"], 10000)
    expect(["failed", "input-required", "completed"]).toContain(task.json.status)
  })
})

describe("specs/079 — text-based detection (no explicit selectedSkill)", () => {
  test("\"build image\" text detects build-image", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "please build image for /tmp/test-project"))
    const task = await getTaskAfter(id, ["input-required", "failed"])
    expect(task.json.approval?.toolName ?? task.json.error).toBeDefined()
    if (task.json.status === "input-required") expect(task.json.approval.toolName).toBe("docker_build")
  })

  test("\"commit\" text detects commit-changes, not git-status (ordering regression)", async () => {
    // The real hazard this test pins: "commit" contains no "git" substring
    // itself, but a careless ordering could still let a later, broader
    // check shadow it. Confirms the actual detectSkill() ordering inside
    // this file routes it to commit-changes, not the generic git-status
    // catch-all.
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "commit changes with message fix the bug at /tmp/test-project"))
    const task = await getTaskAfter(id, ["failed", "input-required", "completed"])
    // Whatever the terminal state (no live MCP here), it must not have
    // been silently treated as "git-status" — a git-status result/error
    // would never mention "commit" at all, while ours always does via
    // the task's own step text.
    expect(JSON.stringify(task.json)).not.toContain("Skill \"git-status\"")
  })

  test("\"git diff\" text detects git-diff, not git-status", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "show git diff for /tmp/test-project"))
    const task = await getTaskAfter(id, ["failed", "completed"])
    expect(task.json.step ?? "").not.toContain("Skill detected: git-status")
  })
})

// specs/080-run-command-approved-execution/spec.md §2 — run-command is
// synchronous to reach a PendingAction (no MCP call at all) for the
// explicit-command path, since tokenizing is pure and no dry-run/preflight
// exists for this skill — so that path IS fully testable here, the same
// reasoning build-image/verify-deployment's own tests above already rely
// on. The LLM-proposal path (no explicit command, harness on) needs a real
// or injected model and is exercised live per the spec's own Verification
// Plan, not here.
describe("specs/080 — run-command", () => {
  test("Agent Card advertises run-command", () => {
    const ids = agentCard.skills.map((s) => s.id)
    expect(ids).toContain("run-command")
  })

  test("an explicit command reaches input-required with the exact argv shown, no MCP call needed", async () => {
    const id = `t-${randomUUID()}`
    const { status } = await submit(taskBody(id, "run command: go test ./... at /tmp/test-project", "run-command"))
    expect(status).toBe(200)
    const task = await getTaskAfter(id, ["input-required", "failed"])
    expect(task.json.status).toBe("input-required")
    expect(task.json.approval.toolName).toBe("run_command")
    expect(task.json.approval.parameters.argv).toEqual(["go", "test", "./..."])
    expect(task.json.approval.risks.join(" ")).toContain("current OS user")
  })

  test("a quoted argument in an explicit command survives as one token", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, 'run command: echo "hello world" at /tmp/test-project', "run-command"))
    const task = await getTaskAfter(id, ["input-required", "failed"])
    expect(task.json.approval.parameters.argv).toEqual(["echo", "hello world"])
  })

  test("no explicit command and the harness off fails closed with a named error, never a guess", async () => {
    // specs/077-agent-enabled-means-llm-on-by-default/spec.md flipped
    // DevOps's own default to on — this test is specifically about the
    // harness-OFF branch, so it opts out explicitly.
    const original = process.env.ORCHESTRAI_DEVOPS_LLM_HARNESS
    process.env.ORCHESTRAI_DEVOPS_LLM_HARNESS = "0"
    try {
      const id = `t-${randomUUID()}`
      await submit(taskBody(id, "do the right thing at /tmp/test-project", "run-command"))
      const task = await getTaskAfter(id, ["failed", "input-required"])
      expect(task.json.status).toBe("failed")
      expect(task.json.error).toContain("No explicit command given")
    } finally {
      if (original === undefined) delete process.env.ORCHESTRAI_DEVOPS_LLM_HARNESS
      else process.env.ORCHESTRAI_DEVOPS_LLM_HARNESS = original
    }
  })

  test("\"run command:\" text detects run-command via the text detector too", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "run command: echo hi at /tmp/test-project"))
    const task = await getTaskAfter(id, ["input-required", "failed"])
    if (task.json.status === "input-required") expect(task.json.approval.toolName).toBe("run_command")
  })
})

// specs/103-deep-project-analysis/spec.md
describe("renderCodebaseAnalysis — deterministic rendering, no MCP needed", () => {
  test("renders stack, structure, and every observation with its cited paths", () => {
    const text = renderCodebaseAnalysis({
      stack: "TypeScript / Bun",
      structure: "A monorepo with apps/ and packages/.",
      observations: [
        { text: "The Orchestrator owns the approval gate.", paths: ["apps/orchestrator/index.ts"] },
        { text: "Shared types live in one package.", paths: ["packages/shared/index.ts", "packages/shared/approval.ts"] },
      ],
    })
    expect(text).toContain("=== Codebase Analysis ===")
    expect(text).toContain("Stack: TypeScript / Bun")
    expect(text).toContain("Structure: A monorepo with apps/ and packages/.")
    expect(text).toContain("• The Orchestrator owns the approval gate. (apps/orchestrator/index.ts)")
    expect(text).toContain("• Shared types live in one package. (packages/shared/index.ts, packages/shared/approval.ts)")
  })

  test("states the count of distinct real paths, not the count of observations", () => {
    // Two observations, but they cite the SAME single path between them —
    // the count must reflect distinct paths, not observation count.
    const text = renderCodebaseAnalysis({
      stack: "x", structure: "y",
      observations: [
        { text: "First claim.", paths: ["shared/a.ts"] },
        { text: "Second claim.", paths: ["shared/a.ts"] },
      ],
    })
    expect(text).toContain("Based on 1 real, verified path reference(s)")
  })

  test("a zero-observation analysis still renders a valid, honest section", () => {
    const text = renderCodebaseAnalysis({ stack: "x", structure: "y", observations: [] })
    expect(text).toContain("Based on 0 real, verified path reference(s)")
  })
})

// specs/103-deep-project-analysis/spec.md — no live mcp:http server in
// this test process (see this file's own header comment), so
// analyze-project's own analyze_project call (its very first step)
// cannot succeed here — the harness-on/off gating and grounding
// behavior are covered directly against a scripted model instead, in
// llm-harness.test.ts. What's confirmed here is the fast, deterministic
// property: a request reaches a real HTTP response and a real terminal
// task state rather than hanging or crashing the process, with no live
// server present.
describe("analyze-project — reaches a terminal state gracefully with no live MCP server", () => {
  test("completes as failed, not hung or crashed, with an honest reason", async () => {
    const id = `t-${randomUUID()}`
    await submit(taskBody(id, "analyze project at /tmp/test-project", "analyze-project"))
    const task = await getTaskAfter(id, ["failed", "completed"], 5000)
    expect(task.json.status).toBe("failed")
  })
})

// specs/143 — the default image tag must be a valid (lowercase) Docker name.
describe("specs/143 — default image tag", () => {
  test("the folder name is lowercased and sanitized", () => {
    expect(defaultImageName("MyApp")).toBe("myapp")
    expect(defaultImageName("orchestrai-demo-real-i8HBOh")).toBe("orchestrai-demo-real-i8hboh")
    expect(defaultImageName("My App!")).toBe("my-app")
    expect(defaultImageName("___")).toBe("app")
  })
  test("the default tag uses it; an explicit image_tag is untouched", () => {
    expect(extractImageTag("build the image", "/work/MyApp")).toBe("myapp:latest")
    expect(extractImageTag("build image_tag: MyOrg/Thing:v1", "/work/MyApp")).toBe("MyOrg/Thing:v1")
  })
})
