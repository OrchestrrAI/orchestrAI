// specs/028-orchestrator-langgraph-supervisor/spec.md — Phase 4 regression
// test. Proves the real audit-event correlation bug found and fixed during
// Phase 4: buildOrchestratorSupervisorDeps() must push audit events with
// taskId `orch-${parentTask.id}` (the PARENT run), not the child task's own
// id — otherwise mapAuditPushToAgUiEvent()'s "orch-" prefix stripping (see
// packages/shared/ag-ui-mapping.ts) recovers the wrong runId, and the
// resulting TOOL_CALL_START/RESULT events don't correlate with this same
// run's RUN_STARTED/STEP_*/RUN_FINISHED events at all.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  buildOrchestratorSupervisorDeps,
  registry,
  tasks,
  type OrchestratorTask,
  type RegisteredAgent,
} from "./index"

function agent(name: string, skillIds: string[]): RegisteredAgent {
  return {
    card: {
      name,
      description: "",
      url: `http://localhost:0/${name}`,
      version: "1.0.0",
      skills: skillIds.map((id) => ({ id, name: id, description: "" })),
    },
    url: `http://localhost:0/${name}`,
    status: "online",
    lastSeen: new Date(),
  }
}

let capturedRequests: { url: string; body: Record<string, unknown> | null }[] = []
let originalFetch: typeof fetch

beforeEach(() => {
  registry.clear()
  tasks.clear()
  capturedRequests = []
  originalFetch = globalThis.fetch
  // @ts-expect-error — test double, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    capturedRequests.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
    return new Response(JSON.stringify({ id: "orch-x", status: "submitted" }), { status: 200 })
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  registry.clear()
  tasks.clear()
})

describe("buildOrchestratorSupervisorDeps — audit-event runId correlation", () => {
  test("dispatch() pushes the audit start event with taskId = orch-<PARENT id>, not the child's own id", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))
    const parentTask: OrchestratorTask = {
      id: "parent-abc123",
      text: "some plan task",
      skill: "plan-task",
      status: "working",
      createdAt: new Date(),
      isPlan: true,
    }
    tasks.set(parentTask.id, parentTask)

    const deps = buildOrchestratorSupervisorDeps(parentTask)
    const result = await deps.dispatch("git-status", "C:\\some\\project", "check status")

    expect(result).not.toBeNull()

    const auditPush = capturedRequests.find((r) => r.url.includes("/internal/audit-event"))
    expect(auditPush).toBeDefined()
    expect(auditPush!.body?.phase).toBe("start")
    // THE regression this test exists for: taskId must be the PARENT's id,
    // orch-prefixed — never the child's own id (which is what an earlier,
    // buggy version of this code passed).
    expect(auditPush!.body?.taskId).toBe(`orch-${parentTask.id}`)
    expect(auditPush!.body?.taskId).not.toBe(result!.childTaskId)
    // callId is what correlates this start push with its matching result
    // push — it must be the real per-call child task id, not derived text.
    expect(auditPush!.body?.callId).toBe(result!.childTaskId)
  })

  test("the pushed taskId, when run through the real mapping function, recovers the PARENT's id as runId", async () => {
    // Not mocked here — imports and calls the real production mapping
    // function directly, proving the fix end to end rather than trusting
    // that "orch-" + parentTask.id looks right by inspection alone.
    const { mapAuditPushToAgUiEvent } = await import("../../packages/shared/ag-ui-mapping")

    registry.set("devops-agent", agent("devops-agent", ["git-status"]))
    const parentTask: OrchestratorTask = {
      id: "parent-xyz789",
      text: "some plan task",
      skill: "plan-task",
      status: "working",
      createdAt: new Date(),
      isPlan: true,
    }
    tasks.set(parentTask.id, parentTask)

    const deps = buildOrchestratorSupervisorDeps(parentTask)
    await deps.dispatch("git-status", "C:\\some\\project", "check status")

    const auditPush = capturedRequests.find((r) => r.url.includes("/internal/audit-event"))
    const event = mapAuditPushToAgUiEvent(auditPush!.body)

    expect(event).not.toBeNull()
    expect(event!.runId).toBe(parentTask.id)
  })
})
