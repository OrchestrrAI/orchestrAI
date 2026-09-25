// specs/101-per-agent-tool-access-expansion/spec.md §C
//
// Proves the visible half of the collision fix: buildCapabilitySnapshot()'s
// refusal used to be visible only via a single console.log while every
// request silently fell back to plan-task. It now surfaces on /healthz.
// The CI-catchable half (a test walking the six real Agent Cards) is
// packages/shared/agent-card-skill-collision.test.ts.
import { afterEach, describe, expect, test } from "bun:test"
import { app, registry } from "./index"

function fakeAgent(name: string, skillId: string) {
  registry.set(name, {
    card: {
      name,
      description: "test fixture",
      url: "http://localhost:1",
      version: "1.0.0",
      skills: [{ id: skillId, name: skillId, description: "test fixture" }],
    },
    url: "http://localhost:1",
    status: "online",
    lastSeen: new Date(),
  })
}

describe("/healthz capabilities field (specs/101 §C)", () => {
  afterEach(() => {
    registry.delete("fixture-agent-a")
    registry.delete("fixture-agent-b")
  })

  test("reports capabilities.ok: true when no collision exists", async () => {
    const res = await app.fetch(new Request("http://localhost/healthz"))
    const body = (await res.json()) as { capabilities: { ok: boolean } }
    expect(body.capabilities.ok).toBe(true)
  })

  test("reports capabilities.ok: false with the offending skill id named, on a real collision", async () => {
    fakeAgent("fixture-agent-a", "fixture-shared-skill")
    fakeAgent("fixture-agent-b", "fixture-shared-skill")

    const res = await app.fetch(new Request("http://localhost/healthz"))
    const body = (await res.json()) as { status: string; capabilities: { ok: boolean; error?: string } }

    expect(body.capabilities.ok).toBe(false)
    expect(body.capabilities.error).toContain("fixture-shared-skill")
    // The refusal behavior itself is unchanged — /healthz itself must
    // still report status: "ok" even while capabilities is collapsed;
    // a degraded router must never look like a dead Orchestrator.
    expect(body.status).toBe("ok")
  })
})
