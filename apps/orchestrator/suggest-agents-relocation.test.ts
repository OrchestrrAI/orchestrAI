// specs/051-planning-retirement-and-required-key/spec.md Phase 1.
//
// suggest-agents moves from the Planning Agent to a directly-served
// Orchestrator skill, ahead of Planning's own deletion in this spec's
// later phases. This pins the relocated output against a REAL captured
// baseline of the original (now-deleted) Planning Agent's own
// skillSuggestAgents() (captured 2026-09-05, before any change in this
// spec touched it) — not a hand-written guess at what it produced.
//
// The two intentional differences from that baseline, both named in the
// spec: the fictitious "code-review-agent (coming soon)" recommendation is
// dropped, and the "Currently online" list no longer names a planning-agent
// process that will not exist once this spec's Phase 4 deletes it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app, tasks, __setTestRouterModel } from "./index"
import { KeywordRouterFake } from "./keyword-router-fake"

// Real output, captured directly from the original (now-deleted) Planning
// Agent's own skillSuggestAgents() before this spec touched anything —
// see the spec's own Phase 1 verification record for how.
const BASELINE_ONLINE_LIST = [
  "  - devops-agent        (:3002) — Docker, CI/CD, and git",
  "  - testing-agent       (:3003) — Test execution and coverage",
  "  - documentation-agent (:3004) — README and API documentation",
  "  - security-agent      (:3005) — Read-only project security checks",
].join("\n")

function expectedReply(text: string, recommended: string[]): string {
  return [
    `=== Agent Suggestions for: "${text}" ===`,
    "",
    "Recommended agents:",
    ...recommended.map((s) => `  - ${s}`),
    "",
    "Currently online:",
    BASELINE_ONLINE_LIST,
  ].join("\n")
}

beforeEach(() => {
  tasks.clear()
  // specs/065 — "what agents are there" must still resolve to
  // suggest-agents (relocated to the Orchestrator, decided before any
  // agent dispatch). The keyword tier that guaranteed that is gone; the
  // fake router reproduces its decision hermetically.
  __setTestRouterModel(new KeywordRouterFake())
})

afterEach(() => {
  __setTestRouterModel(null)
})

async function suggestAgentsReply(text: string): Promise<{ id: string; result: string; assignedAgent: string }> {
  const res = await app.request("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
  const json = (await res.json()) as { id: string }
  // Completes synchronously — no agent, no network — so it is already
  // terminal by the time the response comes back.
  const task = tasks.get(json.id)!
  return { id: json.id, result: task.result!, assignedAgent: task.assignedAgent! }
}

describe("suggest-agents — relocated to the Orchestrator, matches the real captured baseline", () => {
  test("empty input: devops only, exactly the baseline minus nothing", async () => {
    const { result } = await suggestAgentsReply("what agents are there")
    expect(result).toBe(expectedReply("what agents are there", ["devops-agent — infrastructure, Docker, CI/CD, git"]))
  })

  test("\"test\" adds testing-agent, exactly as the baseline did", async () => {
    const { result } = await suggestAgentsReply("suggest agents for test")
    expect(result).toBe(
      expectedReply("suggest agents for test", [
        "devops-agent — infrastructure, Docker, CI/CD, git",
        "testing-agent — test execution and coverage reporting",
      ]),
    )
  })

  test("\"security\" adds security-agent, exactly as the baseline did", async () => {
    const { result } = await suggestAgentsReply("suggest agent for security")
    expect(result).toBe(
      expectedReply("suggest agent for security", [
        "devops-agent — infrastructure, Docker, CI/CD, git",
        "security-agent — secret, gitignore, and dependency checks",
      ]),
    )
  })

  test("\"readme\"/\"api\" add documentation-agent, exactly as the baseline did", async () => {
    const { result } = await suggestAgentsReply("suggest agent for document my api")
    expect(result).toBe(
      expectedReply("suggest agent for document my api", [
        "devops-agent — infrastructure, Docker, CI/CD, git",
        "documentation-agent — README and API documentation",
      ]),
    )
  })

  test("\"review\"/\"code\" alone: the baseline's code-review-agent line is gone, not replaced", async () => {
    // Baseline captured output for this exact input had a THIRD
    // recommendation line here ("code-review-agent — (coming soon)").
    // Deliberately absent now — that agent has never existed.
    const { result } = await suggestAgentsReply("suggest agent to review my code")
    expect(result).toBe(expectedReply("suggest agent to review my code", ["devops-agent — infrastructure, Docker, CI/CD, git"]))
    expect(result).not.toContain("code-review-agent")
  })

  test("a combined request: baseline order preserved, minus the code-review line", async () => {
    // Baseline for this exact input was devops, testing, code-review,
    // security, in that order. The middle one is gone; the other three
    // keep their exact relative order.
    const { result } = await suggestAgentsReply("suggest agent: test and review the security")
    expect(result).toBe(
      expectedReply("suggest agent: test and review the security", [
        "devops-agent — infrastructure, Docker, CI/CD, git",
        "testing-agent — test execution and coverage reporting",
        "security-agent — secret, gitignore, and dependency checks",
      ]),
    )
  })

  test("never names a planning-agent process, unlike the baseline", async () => {
    const { result } = await suggestAgentsReply("what agents are there")
    expect(result).not.toContain("planning-agent")
    expect(result).not.toContain(":3001")
  })

  test("is a real, immediately-completed task — no agent, no dispatch", async () => {
    const { assignedAgent, id } = await suggestAgentsReply("what agents are there")
    expect(assignedAgent).toBe("orchestrator")
    expect(tasks.get(id)!.status).toBe("completed")
  })

  test("the POST /tasks response itself reports the real status, not a hardcoded 'assigned'", async () => {
    // Found while implementing this relocation: every skill before this one
    // was still genuinely "assigned" at response-construction time, so the
    // hardcoded literal happened to be true. suggest-agents is the first
    // that can already be terminal by then.
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "what agents are there" }),
    })
    const json = (await res.json()) as { status: string }
    expect(json.status).toBe("completed")
  })
})
