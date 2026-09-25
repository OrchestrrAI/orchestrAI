// specs/136-orchestrator-task-and-agent-metadata/spec.md — agent liveness.
//
// Before this spec no code path ever set an agent "offline": discovery set
// it online once, and a crashed agent stayed online — in both UIs and in
// the capability snapshot the router picks skills from. This tracker is
// the health check the discovery loop now runs for every online agent.
//
// "Reachable" means GET /healthz answered 2xx within the timeout —
// `ready: false` (e.g. its MCP connection is down) still counts, so a
// dependency hiccup never removes an agent's skills. Only
// AGENT_OFFLINE_AFTER_FAILURES consecutive failures mark it offline, so one
// slow response can't flap it. Recovery is the discovery loop's existing
// re-discovery of offline agents. Pure apart from the injected probe and
// clock, so it is unit-testable without a network.

export const AGENT_OFFLINE_AFTER_FAILURES = 3
export const AGENT_HEALTH_TIMEOUT_MS = 3000

export interface LivenessAgent {
  url: string
  status: "online" | "offline"
  lastSeen: Date
}

/** Resolves true when the agent answered; never throws. */
export type HealthProbe = (url: string) => Promise<boolean>

export type LivenessResult = "seen" | "failed" | "went-offline" | "skipped"

export async function probeAgentHealth(url: string, timeoutMs: number = AGENT_HEALTH_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

export class AgentLivenessTracker {
  private readonly failures = new Map<string, number>()
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly probe: HealthProbe = probeAgentHealth,
    private readonly now: () => Date = () => new Date(),
    private readonly threshold: number = AGENT_OFFLINE_AFTER_FAILURES,
  ) {}

  /** Checks one agent and mutates its `lastSeen`/`status` in place.
   *  Skips an agent that is not online, or whose previous check is still
   *  running (checks for one agent never overlap). */
  async check(name: string, agent: LivenessAgent): Promise<LivenessResult> {
    if (agent.status !== "online" || this.inFlight.has(name)) return "skipped"
    this.inFlight.add(name)
    try {
      let reachable = false
      try {
        reachable = await this.probe(agent.url)
      } catch {
        reachable = false
      }
      if (reachable) {
        agent.lastSeen = this.now()
        this.failures.set(name, 0)
        return "seen"
      }
      const count = (this.failures.get(name) ?? 0) + 1
      if (count >= this.threshold) {
        agent.status = "offline"
        this.failures.delete(name)
        return "went-offline"
      }
      this.failures.set(name, count)
      return "failed"
    } finally {
      this.inFlight.delete(name)
    }
  }

  consecutiveFailures(name: string): number {
    return this.failures.get(name) ?? 0
  }
}
