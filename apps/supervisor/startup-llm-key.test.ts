// specs/051-planning-retirement-and-required-key/spec.md §2.
// Amended by specs/077-agent-enabled-means-llm-on-by-default/spec.md
// (DevOps/Documentation/Security/Testing flipped to default-on) and
// specs/086-code-review-coder-default-on/spec.md (Code Review/Coder
// joined them — specs/077 had deliberately left those two opt-in-only
// since they have no deterministic fallback at all; that consequence
// was confirmed directly with Yusuf before specs/086 flipped them
// too). Every agent in AGENT_LLM_HARNESSES is now default-on; there is
// no longer a genuinely opt-in-only agent to test as its own case.
//
// resolveAgentLlmKeyRequirements() is the wiring: given which services are
// actually starting and the environment, which agent LLM harnesses need a
// key checked. checkStartupLlmKeys() (packages/shared/llm-model-factory.ts)
// is the actual key-presence logic, already tested there directly — this
// file is specifically about the "which components does THIS run need to
// check" decision, not about credential resolution itself.
import { describe, expect, test } from "bun:test"
import { resolveAgentLlmKeyRequirements } from "./index"

describe("resolveAgentLlmKeyRequirements — every agent is default-on (specs/077, specs/086)", () => {
  test("no services starting: nothing to check", () => {
    expect(resolveAgentLlmKeyRequirements([], {})).toEqual([])
  })

  test("a service starting with no env var set at all: on by default, one requirement", () => {
    const result = resolveAgentLlmKeyRequirements(["devops-agent"], {})
    expect(result).toEqual([{ component: "devops", reason: "DevOps LLM is on" }])
  })

  test("a service starting with its harness explicitly disabled (=0): nothing to check", () => {
    expect(resolveAgentLlmKeyRequirements(["devops-agent"], { ORCHESTRAI_DEVOPS_LLM_HARNESS: "0" })).toEqual([])
  })

  test("a service starting with its harness explicitly on (=1): unaffected, one requirement", () => {
    const result = resolveAgentLlmKeyRequirements(["devops-agent"], { ORCHESTRAI_DEVOPS_LLM_HARNESS: "1" })
    expect(result).toEqual([{ component: "devops", reason: "DevOps LLM is on" }])
  })

  test("a harness-affecting var set for a service that is NOT starting: not required — it will never run", () => {
    const result = resolveAgentLlmKeyRequirements(["devops-agent"], { ORCHESTRAI_SECURITY_LLM_HARNESS: "0" })
    expect(result).toEqual([{ component: "devops", reason: "DevOps LLM is on" }])
  })

  test("multiple starting services, no env set at all: one requirement each, including Code Review/Coder (specs/086)", () => {
    const result = resolveAgentLlmKeyRequirements(
      ["devops-agent", "documentation-agent", "security-agent", "testing-agent", "code-review-agent", "coder-agent"],
      {},
    )
    expect(result.map((r) => r.component).sort()).toEqual([
      "codeReview", "coder", "devops", "documentation", "security", "testing",
    ])
  })

  test("only \"0\" is off — any other value stays on", () => {
    expect(resolveAgentLlmKeyRequirements(["devops-agent"], { ORCHESTRAI_DEVOPS_LLM_HARNESS: "true" })).toEqual([
      { component: "devops", reason: "DevOps LLM is on" },
    ])
    expect(resolveAgentLlmKeyRequirements(["devops-agent"], { ORCHESTRAI_DEVOPS_LLM_HARNESS: "" })).toEqual([
      { component: "devops", reason: "DevOps LLM is on" },
    ])
    expect(resolveAgentLlmKeyRequirements(["coder-agent"], { ORCHESTRAI_CODER_LLM_HARNESS: "true" })).toEqual([
      { component: "coder", reason: "Coder LLM is on" },
    ])
  })

  test("Code Review/Coder specifically: on by default, and =0 is a real opt-out (specs/086)", () => {
    expect(resolveAgentLlmKeyRequirements(["code-review-agent"], {}))
      .toEqual([{ component: "codeReview", reason: "Code Review LLM is on" }])
    expect(resolveAgentLlmKeyRequirements(["coder-agent"], {}))
      .toEqual([{ component: "coder", reason: "Coder LLM is on" }])
    expect(resolveAgentLlmKeyRequirements(["code-review-agent"], { ORCHESTRAI_CODE_REVIEW_LLM_HARNESS: "0" })).toEqual([])
    expect(resolveAgentLlmKeyRequirements(["coder-agent"], { ORCHESTRAI_CODER_LLM_HARNESS: "0" })).toEqual([])
    // Explicit =1 stays unaffected, matching every prior behavior.
    expect(resolveAgentLlmKeyRequirements(["code-review-agent"], { ORCHESTRAI_CODE_REVIEW_LLM_HARNESS: "1" }))
      .toEqual([{ component: "codeReview", reason: "Code Review LLM is on" }])
  })

  test("the Orchestrator is never included — that requirement is composed in separately at the call site, not here", () => {
    const result = resolveAgentLlmKeyRequirements(
      ["devops-agent", "documentation-agent", "security-agent", "orchestrator"],
      {},
    )
    expect(result.some((r) => r.component === "orchestrator")).toBe(false)
    expect(result).toHaveLength(3)
  })
})
