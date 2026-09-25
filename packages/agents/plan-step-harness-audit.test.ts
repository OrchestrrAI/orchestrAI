// specs/137-plan-step-acts-only-on-its-own-step/spec.md — an audit of every
// LLM harness call site in the six agents. A harness whose model receives
// the user's request text (as an instruction, a hint, or requestText) must
// also receive the plan background separately (`context`), so that in a
// plan it acts only on its own step. Every other harness must not receive
// the request text at all. If an agent later starts passing the request to
// a model, this test fails until that call site is made split-aware.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const AGENTS = ["coder", "devops", "documentation", "testing", "code-review", "security"] as const

function harnessCalls(agent: string): string[] {
  const source = readFileSync(join(import.meta.dir, agent, "index.ts"), "utf8")
  // Each `run…Harness({ … })` call, up to its closing `})`.
  return [...source.matchAll(/run\w*Harness\(\{[\s\S]*?\}\)/g)].map((match) => match[0])
}

// Fields through which request text reaches a model.
const REQUEST_FIELDS = /\b(instruction|hint|requestText)\b/

describe("specs/137 — harness call sites and the plan background", () => {
  test("every agent file was scanned and harness calls were found where expected", () => {
    const total = AGENTS.reduce((count, agent) => count + harnessCalls(agent).length, 0)
    expect(total).toBeGreaterThan(8)
    expect(harnessCalls("coder").length).toBeGreaterThan(0)
    expect(harnessCalls("devops").length).toBeGreaterThan(0)
  })

  test("a call that passes request text to a model also passes the plan background", () => {
    for (const agent of AGENTS) {
      for (const call of harnessCalls(agent)) {
        if (!REQUEST_FIELDS.test(call)) continue
        // verify-loop's fix instructions and the verify-command proposal
        // are built from the persisted step instruction (see this spec's
        // verification.md); they live in verify-loop.ts, not index.ts.
        expect({ agent, call, hasContext: /\bcontext\b/.test(call) }).toEqual({ agent, call, hasContext: true })
      }
    }
  })

  test("agents whose models never see the request pass it to no harness", () => {
    // specs/138: Testing now proposes every test command from the request,
    // so it joined the split-aware group above.
    for (const agent of ["documentation", "code-review", "security"] as const) {
      for (const call of harnessCalls(agent)) {
        expect({ agent, call, request: REQUEST_FIELDS.test(call) || /\btext\b/.test(call) }).toEqual({ agent, call, request: false })
      }
    }
  })
})
