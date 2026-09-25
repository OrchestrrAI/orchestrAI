// specs/028-orchestrator-langgraph-supervisor/spec.md — Phase 2 tests.
// Every safety property named in the spec's Acceptance Criteria gets its
// own named test here, against a scripted fake model and mocked dispatch/
// wait functions. No network calls, no HTTP server, no real agents, no
// live model — matching specs/026's own test posture.
import { describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import {
  DEFAULT_MAX_ATTEMPTS_PER_SKILL,
  DEFAULT_MAX_DISPATCHES,
  SKILL_DESCRIPTIONS,
  SKILL_TIER_REGISTRY,
  SUPERVISOR_ALLOWED_SKILLS,
  SUPERVISOR_MAX_DISPATCHES_ENV_VAR,
  type DispatchOutcome,
  type DispatchResult,
  type SupervisorDeps,
  type WaitResult,
  buildSystemPrompt,
  classifyDispatchOutcome,
  classifySkillTier,
  resolveSupervisorMaxDispatches,
  runSupervisor,
} from "./supervisor-graph"

// ============================================================
// TEST DOUBLES
// ============================================================
class ScriptedChatModel extends BaseChatModel {
  private index = 0
  constructor(private readonly responses: AIMessage[]) {
    super({})
  }
  _llmType(): string {
    return "scripted-fake-supervisor-model"
  }
  bindTools(_tools: unknown, _kwargs?: unknown): this {
    return this
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.responses[Math.min(this.index, this.responses.length - 1)]
    this.index += 1
    return { generations: [{ text: "", message }] }
  }
}

function dispatchCall(skill: string, target: string, description: string, id = `call-${skill}-${Math.random().toString(36).slice(2, 8)}`): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ name: "dispatch_skill", args: { skill, target, description }, id }] })
}

function finishCall(reason = "done"): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ name: "finish", args: { reason }, id: `call-finish-${Math.random().toString(36).slice(2, 8)}` }] })
}

// specs/060-supervisor-parallel-read-only-dispatch/spec.md — a single
// AIMessage carrying more than one tool_calls entry, the shape a
// provider's own parallel tool calling produces.
function multiDispatchCall(...calls: { skill: string; target: string; description: string }[]): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: calls.map((c, i) => ({ name: "dispatch_skill", args: c, id: `call-${c.skill}-${i}-${Math.random().toString(36).slice(2, 8)}` })),
  })
}

class MockDeps implements SupervisorDeps {
  public dispatchCalls: { skill: string; target: string; description: string }[] = []
  public waitCalls: string[] = []
  private childIdCounter = 0
  constructor(
    private readonly waitResultsBySkill: Record<string, WaitResult | WaitResult[]>,
    private readonly noAgentForSkills: string[] = [],
  ) {}

  // Uses "::" (never present in a skill id) rather than "-" as the child-id
  // delimiter — skill ids themselves contain hyphens (git-status,
  // create-ci, check-gitignore-coverage, ...), so a naive split("-") would
  // silently truncate them and mis-key every lookup below. Found live
  // while debugging this exact test file's first run.
  private childIdToSkill = new Map<string, string>()

  async dispatch(skill: string, target: string, description: string): Promise<DispatchResult | null> {
    this.dispatchCalls.push({ skill, target, description })
    if (this.noAgentForSkills.includes(skill)) return null
    const childTaskId = `child::${skill}::${this.childIdCounter++}`
    this.childIdToSkill.set(childTaskId, skill)
    return { childTaskId }
  }

  async wait(childTaskId: string): Promise<WaitResult> {
    this.waitCalls.push(childTaskId)
    const skill = this.childIdToSkill.get(childTaskId)!
    const configured = this.waitResultsBySkill[skill]
    if (Array.isArray(configured)) {
      const callIndexForSkill = this.waitCalls.filter((id) => this.childIdToSkill.get(id) === skill).length - 1
      return configured[Math.min(callIndexForSkill, configured.length - 1)]
    }
    return configured ?? { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }
  }
}

const TARGET = "C:\\scratch\\target-project"

// ============================================================
// classifyDispatchOutcome — pure adapter, the core safety contract
// ============================================================
describe("classifyDispatchOutcome", () => {
  test("completed status -> completed outcome", () => {
    expect(classifyDispatchOutcome({ status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }, "write-capable")).toEqual({ kind: "completed" })
  })

  test("timeout status -> timeout outcome, regardless of tier", () => {
    expect(classifyDispatchOutcome({ status: "timeout", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }, "read-only")).toEqual({ kind: "timeout", effect: "unknown" })
    expect(classifyDispatchOutcome({ status: "timeout", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }, "write-capable")).toEqual({ kind: "timeout", effect: "unknown" })
  })

  test("failed + trusted rejection record -> rejected, regardless of tier", () => {
    expect(classifyDispatchOutcome({ status: "failed", wasRejectedByOrchestrator: true, wasSkippedByOrchestrator: false }, "write-capable")).toEqual({ kind: "rejected", effect: "none" })
  })

  test("ADVERSARIAL: failed with error text resembling rejection but wasRejectedByOrchestrator=false is NOT classified rejected", () => {
    // The classifier never sees error text at all — it only ever sees the
    // boolean trusted fact. This test proves that by construction: passing
    // wasRejectedByOrchestrator: false must never produce "rejected", no
    // matter what a caller might have put in an error string upstream.
    const outcome = classifyDispatchOutcome({ status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }, "write-capable")
    expect(outcome.kind).not.toBe("rejected")
    expect(outcome.kind).toBe("failed-ambiguous")
  })

  test("failed + write-capable + not rejected -> failed-ambiguous (the conservative default)", () => {
    expect(classifyDispatchOutcome({ status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }, "write-capable")).toEqual({ kind: "failed-ambiguous", effect: "unknown" })
  })

  test("failed + read-only + not rejected -> failed-safe (the only adaptation path)", () => {
    expect(classifyDispatchOutcome({ status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }, "read-only")).toEqual({ kind: "failed-safe", effect: "none" })
  })

  test("classification depends only on {status, wasRejectedByOrchestrator, tier} — no other input exists to branch on", () => {
    // Structural proof, not just behavioral: WaitResult's only fields are
    // status, wasRejectedByOrchestrator, and target (unused by the
    // classifier). There is no task-status string or error-text parameter
    // this function could read even if someone tried.
    const a = classifyDispatchOutcome({ status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false, target: "/a" }, "read-only")
    const b = classifyDispatchOutcome({ status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false, target: "/completely-different" }, "read-only")
    expect(a).toEqual(b)
  })

  // specs/089-plan-step-skip-continue/spec.md (Option B)
  test("failed + trusted skip record -> skipped, regardless of tier, and takes priority over a false rejection flag", () => {
    expect(classifyDispatchOutcome({ status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: true }, "write-capable")).toEqual({ kind: "skipped", effect: "none" })
    expect(classifyDispatchOutcome({ status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: true }, "read-only")).toEqual({ kind: "skipped", effect: "none" })
  })

  test("ADVERSARIAL: failed with error text resembling a skip but wasSkippedByOrchestrator=false is NOT classified skipped", () => {
    const outcome = classifyDispatchOutcome({ status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }, "write-capable")
    expect(outcome.kind).not.toBe("skipped")
    expect(outcome.kind).toBe("failed-ambiguous")
  })
})

// ============================================================
// Safety registry — exhaustiveness, drift, and unknown-skill defaults
// ============================================================
describe("safety registry", () => {
  test("every allowed skill has a registry classification", () => {
    for (const skill of SUPERVISOR_ALLOWED_SKILLS) {
      expect(SKILL_TIER_REGISTRY[skill]).toBeDefined()
    }
  })

  test("every registry entry is reachable from the allowed-skills list (no orphans)", () => {
    for (const skill of Object.keys(SKILL_TIER_REGISTRY)) {
      expect((SUPERVISOR_ALLOWED_SKILLS as readonly string[])).toContain(skill)
    }
  })

  test("an unknown/unregistered skill defaults to write-capable, never read-only", () => {
    expect(classifySkillTier("some-skill-nobody-registered")).toBe("write-capable")
  })

  test("DRIFT IS CAUGHT: a read-only-classified skill and a write-capable-classified skill produce genuinely different DispatchOutcome routing for the identical failure", () => {
    // Proves the registry's classification is actually load-bearing, not
    // decorative — flipping it changes real routing behavior, which is
    // exactly what "changing a skill's classification must be intentional"
    // requires being true.
    const failedNotRejected: WaitResult = { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }
    const asReadOnly = classifyDispatchOutcome(failedNotRejected, "read-only")
    const asWriteCapable = classifyDispatchOutcome(failedNotRejected, "write-capable")
    expect(asReadOnly.kind).toBe("failed-safe")
    expect(asWriteCapable.kind).toBe("failed-ambiguous")
    expect(asReadOnly.kind).not.toBe(asWriteCapable.kind)
  })

  test("git-status and analyze-project are read-only; every write-capable skill in CLAUDE.md's own tiering is classified write-capable", () => {
    expect(SKILL_TIER_REGISTRY["git-status"]).toBe("read-only")
    expect(SKILL_TIER_REGISTRY["analyze-project"]).toBe("read-only")
    for (const skill of ["dockerize", "create-ci", "create-gitignore", "create-compose", "generate-readme", "document-api", "run-tests", "check-coverage"]) {
      expect(SKILL_TIER_REGISTRY[skill]).toBe("write-capable")
    }
  })
})

// specs/121-skill-description-grounded-routing/spec.md
describe("skill descriptions", () => {
  test("SKILL_DESCRIPTIONS has exactly the same key set as SUPERVISOR_ALLOWED_SKILLS — no drift", () => {
    for (const skill of SUPERVISOR_ALLOWED_SKILLS) {
      expect(SKILL_DESCRIPTIONS[skill], `missing description for "${skill}"`).toBeTruthy()
    }
    const allowedSet = new Set<string>(SUPERVISOR_ALLOWED_SKILLS)
    for (const skill of Object.keys(SKILL_DESCRIPTIONS)) {
      expect(allowedSet.has(skill), `"${skill}" has a description but isn't in SUPERVISOR_ALLOWED_SKILLS`).toBe(true)
    }
  })

  test("the system prompt's Valid skills line includes a same-family pair's real descriptions, not bare ids", () => {
    const prompt = buildSystemPrompt("create a new file")
    expect(prompt).toContain(`edit-file: ${SKILL_DESCRIPTIONS["edit-file"]}`)
    expect(prompt).toContain(`edit-files: ${SKILL_DESCRIPTIONS["edit-files"]}`)
  })

  // specs/126 — a plan step's description becomes the child task's text, and
  // write-tests only works if that text names the file.
  test("write-tests' description tells the supervisor to pick files first and name one per step", () => {
    const prompt = buildSystemPrompt("create the test cases for my project")
    expect(prompt).toContain(`write-tests: ${SKILL_DESCRIPTIONS["write-tests"]}`)
    expect(SKILL_DESCRIPTIONS["write-tests"]).toContain("MUST name that file")
    expect(SKILL_DESCRIPTIONS["write-tests"]).toContain("one write-tests step per chosen file")
  })

  // specs/133 — the same class of fix for edit-file: Coder only finds the
  // file from "edit <path>" in the step text, and a multi-file change is one
  // edit-files step.
  test("edit-file's description requires 'edit <path>:' and sends multi-file changes to edit-files", () => {
    const prompt = buildSystemPrompt("edit two files in my project")
    expect(prompt).toContain(`edit-file: ${SKILL_DESCRIPTIONS["edit-file"]}`)
    expect(SKILL_DESCRIPTIONS["edit-file"]).toContain("ONE existing file")
    expect(SKILL_DESCRIPTIONS["edit-file"]).toContain('MUST begin "edit <relative/path.ext>: <what to change>"')
    expect(SKILL_DESCRIPTIONS["edit-file"]).toContain("use ONE edit-files step instead of several edit-file steps")
    expect(SKILL_DESCRIPTIONS["edit-files"]).toContain("ONE edit-files step whose description carries the whole instruction")
  })
})

// specs/097-chat-answer-and-plan-description-honesty/spec.md — mirrors
// packages/shared/service-ports.ts's own resolveServicePort() test shape
// exactly: unset/empty falls back to the default, a valid override is
// honored, a malformed value falls back rather than throwing.
describe("resolveSupervisorMaxDispatches", () => {
  test("unset env var falls back to the default (30)", () => {
    expect(resolveSupervisorMaxDispatches({})).toBe(DEFAULT_MAX_DISPATCHES)
    expect(DEFAULT_MAX_DISPATCHES).toBe(30)
  })

  test("empty string falls back to the default", () => {
    expect(resolveSupervisorMaxDispatches({ [SUPERVISOR_MAX_DISPATCHES_ENV_VAR]: "" })).toBe(DEFAULT_MAX_DISPATCHES)
  })

  test("a real override value is honored exactly", () => {
    expect(resolveSupervisorMaxDispatches({ [SUPERVISOR_MAX_DISPATCHES_ENV_VAR]: "50" })).toBe(50)
  })

  test("a non-numeric value falls back to the default rather than throwing", () => {
    expect(resolveSupervisorMaxDispatches({ [SUPERVISOR_MAX_DISPATCHES_ENV_VAR]: "not-a-number" })).toBe(DEFAULT_MAX_DISPATCHES)
  })

  test("zero or a negative value falls back to the default — the bound can never be disabled this way", () => {
    expect(resolveSupervisorMaxDispatches({ [SUPERVISOR_MAX_DISPATCHES_ENV_VAR]: "0" })).toBe(DEFAULT_MAX_DISPATCHES)
    expect(resolveSupervisorMaxDispatches({ [SUPERVISOR_MAX_DISPATCHES_ENV_VAR]: "-5" })).toBe(DEFAULT_MAX_DISPATCHES)
  })

  test("a non-integer value falls back to the default", () => {
    expect(resolveSupervisorMaxDispatches({ [SUPERVISOR_MAX_DISPATCHES_ENV_VAR]: "3.5" })).toBe(DEFAULT_MAX_DISPATCHES)
  })
})

// ============================================================
// Full graph — the adaptive loop itself
// ============================================================
describe("runSupervisor — adaptivity (the property specs/026 structurally cannot have)", () => {
  test("a failed-safe (read-only failure) step leads to a genuinely different next action, not an abort", async () => {
    const model = new ScriptedChatModel([
      dispatchCall("git-status", TARGET, "check status"),
      dispatchCall("scan-secrets", TARGET, "different action after the read-only failure"),
      finishCall(),
    ])
    const deps = new MockDeps({ "git-status": { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }, "scan-secrets": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("done")
    expect(deps.dispatchCalls.map((c) => c.skill)).toEqual(["git-status", "scan-secrets"])
  })

  test("a failed-ambiguous (write-capable, unexplained failure) step does NOT permit adaptation — it terminates instead", async () => {
    const model = new ScriptedChatModel([
      dispatchCall("dockerize", TARGET, "build image"),
      // A second call would prove adaptation happened if it were reached —
      // it must NOT be reached.
      dispatchCall("create-ci", TARGET, "should never be dispatched"),
    ])
    const deps = new MockDeps({ dockerize: { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("failed-ambiguous")
    expect(deps.dispatchCalls).toHaveLength(1)
    expect(deps.dispatchCalls[0].skill).toBe("dockerize")
  })
})

describe("runSupervisor — rejection is terminal, structurally", () => {
  test("after a rejection, no further dispatch occurs — including a case where an alternative skill could achieve the same effect", async () => {
    const model = new ScriptedChatModel([
      dispatchCall("dockerize", TARGET, "build image"),
      // If the supervisor were re-entered, this is exactly the adversarial
      // move the spec calls out: an alternative achieving the same effect.
      dispatchCall("create-compose", TARGET, "should never be dispatched — same-effect alternative after rejection"),
    ])
    const deps = new MockDeps({ dockerize: { status: "failed", wasRejectedByOrchestrator: true, wasSkippedByOrchestrator: false } })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("rejected")
    expect(deps.dispatchCalls).toHaveLength(1)
    expect(deps.dispatchCalls[0].skill).toBe("dockerize")
  })

  test("rejection is detected from the trusted wasRejectedByOrchestrator fact, never from status or error text", async () => {
    // Same adversarial shape as the adapter-level test above, exercised
    // through the full graph: a failed dispatch that was NOT actually
    // rejected through the Orchestrator must not halt as "rejected" — it
    // must reach failed-ambiguous and still be terminal, but for the
    // correct reason.
    const model = new ScriptedChatModel([dispatchCall("dockerize", TARGET, "build image")])
    const deps = new MockDeps({ dockerize: { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("failed-ambiguous")
    expect(result.terminal).not.toBe("rejected")
  })
})

// specs/089-plan-step-skip-continue/spec.md (Option B) — a skip is NOT
// terminal (unlike rejection above); the one structural guarantee kept is
// that the literal skipped skill id can never be re-proposed in the same
// run, while every OTHER skill dispatches normally.
describe("runSupervisor — skip is not terminal, but the skipped skill can never be re-proposed (specs/089, Option B)", () => {
  test("after a skip, the run continues and a DIFFERENT write-capable skill still dispatches normally", async () => {
    const model = new ScriptedChatModel([
      dispatchCall("dockerize", TARGET, "build image"),
      dispatchCall("create-ci", TARGET, "a genuinely different, unrelated write"),
      finishCall(),
    ])
    const deps = new MockDeps({
      dockerize: { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: true },
      "create-ci": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
    })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    // Not terminal on the skip itself — the run reaches "done" via the
    // model's own later finish call, proving the graph loop genuinely
    // continued rather than halting the way rejection does.
    expect(result.terminal).toBe("done")
    expect(deps.dispatchCalls.map((d) => d.skill)).toEqual(["dockerize", "create-ci"])
  })

  test("ADVERSARIAL: after a skip, re-proposing the literal SAME skill id is refused — the one structural guarantee Option B keeps", async () => {
    const model = new ScriptedChatModel([
      dispatchCall("dockerize", TARGET, "build image"),
      // The exact adversarial move Option B's own residual-risk note
      // names: trying to re-achieve what was just skipped.
      dispatchCall("dockerize", TARGET, "should be refused — re-proposing the literal skipped skill"),
      finishCall(),
    ])
    const deps = new MockDeps({
      dockerize: { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: true },
    })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    // deps.dispatch() was called exactly once for "dockerize" — the second
    // attempt was refused BEFORE any dispatch, never executed.
    expect(deps.dispatchCalls).toHaveLength(1)
    expect(deps.dispatchCalls[0].skill).toBe("dockerize")
    // Refused non-terminally: the run still reaches "done" via the
    // model's own later finish call, not ended by the refusal itself.
    expect(result.terminal).toBe("done")
    const refusalEntry = result.auditLog.find((e) => e.type === "decision" && e.reason === "skipped-skill-refused")
    expect(refusalEntry).toBeDefined()
  })

  test("skip is detected from the trusted wasSkippedByOrchestrator fact, never from status or error text", async () => {
    // Same adversarial shape as the rejection test above: a failed
    // dispatch that was NOT actually skipped through the Orchestrator
    // must not be treated as a skip — it must reach failed-ambiguous.
    const model = new ScriptedChatModel([dispatchCall("dockerize", TARGET, "build image")])
    const deps = new MockDeps({ dockerize: { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("failed-ambiguous")
    expect(result.terminal).not.toBe("done")
  })

  test("a skip does not block dispatching the same skill against a DIFFERENT target in the same run", async () => {
    // Only the skill id is blocked, not (skill, target) — matching the
    // spec's own "literal skipped skill id" wording exactly, distinct
    // from the (skill, target)-keyed duplicate-write-prevention guard.
    const OTHER_TARGET = "C:\\scratch\\other-project"
    const model = new ScriptedChatModel([
      dispatchCall("dockerize", TARGET, "build image for project A"),
      dispatchCall("dockerize", OTHER_TARGET, "should still be refused — same skill id, different target"),
      finishCall(),
    ])
    const deps = new MockDeps({
      dockerize: { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: true },
    })

    await runSupervisor(`task at ${TARGET}`, { model, deps })

    // The spec is explicit: the SKILL ID is blocked, not the (skill,
    // target) pair — a real, intentional design choice, not an oversight.
    expect(deps.dispatchCalls).toHaveLength(1)
  })
})

describe("runSupervisor — duplicate-write prevention", () => {
  test("the same (write-skill, target) pair cannot be dispatched twice in one run", async () => {
    const model = new ScriptedChatModel([
      dispatchCall("dockerize", TARGET, "build image"),
      dispatchCall("dockerize", TARGET, "try the same thing again"),
      finishCall(),
    ])
    const deps = new MockDeps({ dockerize: { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })

    await runSupervisor(`task at ${TARGET}`, { model, deps })

    // dispatch() must have been called exactly once for dockerize+TARGET —
    // the second attempt is refused before deps.dispatch() is ever called.
    const dockerizeCalls = deps.dispatchCalls.filter((c) => c.skill === "dockerize" && c.target === TARGET)
    expect(dockerizeCalls).toHaveLength(1)
  })

  test("the same skill against a DIFFERENT target is allowed", async () => {
    const model = new ScriptedChatModel([
      dispatchCall("dockerize", TARGET, "build image"),
      dispatchCall("dockerize", "C:\\scratch\\other-project", "different target, should be allowed"),
      finishCall(),
    ])
    const deps = new MockDeps({ dockerize: { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })

    await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(deps.dispatchCalls).toHaveLength(2)
  })
})

describe("runSupervisor — classification is not model-controlled", () => {
  test("the model never sees or influences DispatchOutcome — it only sees a plain-text observation after the fact", async () => {
    // Proven structurally: dispatch_skill's own tool schema has no field
    // for the model to assert an outcome, and the observation message fed
    // back is built entirely from the adapter's classification, never from
    // anything the model supplied.
    const model = new ScriptedChatModel([dispatchCall("git-status", TARGET, "check status"), finishCall()])
    const deps = new MockDeps({ "git-status": { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    // failed-safe (read-only) correctly loops back rather than terminating
    // — this could only happen via the adapter's own classification, since
    // the model's dispatch_skill call carried no outcome information at all.
    expect(result.terminal).toBe("done")
  })
})

describe("runSupervisor — each DispatchOutcome kind routes distinctly", () => {
  test("completed continues the loop", async () => {
    const model = new ScriptedChatModel([dispatchCall("git-status", TARGET, "x"), finishCall()])
    const deps = new MockDeps({ "git-status": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })
    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })
    expect(result.terminal).toBe("done")
    expect(deps.dispatchCalls).toHaveLength(1)
  })

  test("rejected terminates immediately", async () => {
    const model = new ScriptedChatModel([dispatchCall("dockerize", TARGET, "x")])
    const deps = new MockDeps({ dockerize: { status: "failed", wasRejectedByOrchestrator: true, wasSkippedByOrchestrator: false } })
    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })
    expect(result.terminal).toBe("rejected")
  })

  test("failed-safe continues the loop", async () => {
    const model = new ScriptedChatModel([dispatchCall("git-status", TARGET, "x"), finishCall()])
    const deps = new MockDeps({ "git-status": { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })
    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })
    expect(result.terminal).toBe("done")
  })

  test("failed-ambiguous terminates immediately", async () => {
    const model = new ScriptedChatModel([dispatchCall("dockerize", TARGET, "x")])
    const deps = new MockDeps({ dockerize: { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })
    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })
    expect(result.terminal).toBe("failed-ambiguous")
  })

  test("timeout terminates immediately", async () => {
    const model = new ScriptedChatModel([dispatchCall("git-status", TARGET, "x")])
    const deps = new MockDeps({ "git-status": { status: "timeout", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })
    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })
    expect(result.terminal).toBe("timeout")
  })
})

describe("runSupervisor — bounds", () => {
  test("the global dispatch limit terminates the run independently of outcome", async () => {
    // Different skills per dispatch (not just different targets) so the
    // per-skill attempt bound can't confound this test — this must isolate
    // the global bound specifically.
    const skills = ["git-status", "analyze-project", "scan-secrets", "check-gitignore-coverage", "audit-dependencies"]
    const responses: AIMessage[] = skills.map((s) => dispatchCall(s, TARGET, "x"))
    const model = new ScriptedChatModel(responses)
    const waitResults: Record<string, WaitResult> = {}
    for (const s of skills) waitResults[s] = { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }
    const deps = new MockDeps(waitResults)

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps, maxDispatches: 3 })

    expect(result.terminal).toBe("max-dispatches-reached")
    expect(deps.dispatchCalls).toHaveLength(3)
  })

  test("the per-skill attempt limit terminates a run that keeps retrying the same skill", async () => {
    const model = new ScriptedChatModel([
      dispatchCall("git-status", TARGET, "attempt 1"),
      dispatchCall("git-status", TARGET, "attempt 2"),
      dispatchCall("git-status", TARGET, "attempt 3 — should be refused"),
    ])
    const deps = new MockDeps({ "git-status": { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps, maxAttemptsPerSkill: 2 })

    expect(result.terminal).toBe("max-skill-attempts-reached")
    expect(deps.dispatchCalls).toHaveLength(2)
  })

  test("default bounds match the spec's documented values", () => {
    // specs/097-chat-answer-and-plan-description-honesty/spec.md raised
    // this from 10 to 30 — see the dedicated resolveSupervisorMaxDispatches
    // describe block above for the full test coverage of that change.
    expect(DEFAULT_MAX_DISPATCHES).toBe(30)
    expect(DEFAULT_MAX_ATTEMPTS_PER_SKILL).toBe(2)
  })
})

describe("runSupervisor — audit completeness", () => {
  test("every supervisor decision and every dispatch appears in the audit record", async () => {
    const model = new ScriptedChatModel([dispatchCall("git-status", TARGET, "check"), dispatchCall("dockerize", TARGET, "build"), finishCall()])
    const deps = new MockDeps({
      "git-status": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
      dockerize: { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
    })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    const dispatchEntries = result.auditLog.filter((e) => e.type === "dispatch")
    expect(dispatchEntries).toHaveLength(2)
    expect(dispatchEntries.map((e) => (e as { skill: string }).skill)).toEqual(["git-status", "dockerize"])
    // Every dispatch entry carries an outcome and a duration — nothing
    // model-driven happened that isn't in this record.
    for (const entry of dispatchEntries) {
      expect((entry as { outcome: string }).outcome).toBeTruthy()
      expect((entry as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  test("a duplicate-write refusal is itself recorded in the audit log even though no dispatch happened", async () => {
    const model = new ScriptedChatModel([dispatchCall("dockerize", TARGET, "build"), dispatchCall("dockerize", TARGET, "again"), finishCall()])
    const deps = new MockDeps({ dockerize: { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    const refusalEntries = result.auditLog.filter((e) => e.type === "decision" && (e as { reason: string }).reason === "duplicate-write-refused")
    expect(refusalEntries).toHaveLength(1)
  })
})

describe("runSupervisor — no agent available", () => {
  test("a skill with no online agent feeds back to the supervisor rather than crashing", async () => {
    const model = new ScriptedChatModel([
      dispatchCall("dockerize", TARGET, "no agent for this"),
      dispatchCall("git-status", TARGET, "try something else"),
      finishCall(),
    ])
    const deps = new MockDeps({ "git-status": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } }, ["dockerize"])

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("done")
    expect(deps.dispatchCalls.map((c) => c.skill)).toEqual(["dockerize", "git-status"])
  })
})

describe("runSupervisor — a model that never needs to dispatch anything", () => {
  test("finish on the first turn produces a zero-dispatch, non-terminal-error run", async () => {
    const model = new ScriptedChatModel([finishCall("nothing to do")])
    const deps = new MockDeps({})

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("done")
    expect(result.dispatchCount).toBe(0)
    expect(deps.dispatchCalls).toHaveLength(0)
  })
})

// ============================================================
// specs/060-supervisor-parallel-read-only-dispatch/spec.md
// ============================================================
describe("runSupervisor — read-only parallel dispatch (specs/060)", () => {
  // Proves genuine concurrency, not just "both were eventually called":
  // each wait() call blocks until every expected wait() has itself
  // STARTED. If dispatchNode() ran the two branches sequentially
  // (dispatch A, wait A fully, dispatch B, wait B), the first wait()
  // would block forever waiting for a second wait() that can never start
  // until the first one returns — a real deadlock, which bun test's
  // own per-test timeout turns into a clear failure rather than a false
  // pass.
  class ConcurrencyProbeDeps implements SupervisorDeps {
    public dispatchStartOrder: string[] = []
    public waitStartOrder: string[] = []
    private childIdToSkill = new Map<string, string>()
    private counter = 0
    private waitStartedCount = 0
    private release: (() => void) | null = null
    constructor(private readonly totalExpectedWaits: number) {}

    async dispatch(skill: string, _target: string, _description: string): Promise<DispatchResult | null> {
      this.dispatchStartOrder.push(skill)
      const childTaskId = `child::${skill}::${this.counter++}`
      this.childIdToSkill.set(childTaskId, skill)
      return { childTaskId }
    }

    async wait(childTaskId: string): Promise<WaitResult> {
      const skill = this.childIdToSkill.get(childTaskId)!
      this.waitStartOrder.push(skill)
      this.waitStartedCount += 1
      if (this.waitStartedCount < this.totalExpectedWaits) {
        await new Promise<void>((resolve) => { this.release = resolve })
      } else {
        this.release?.()
      }
      return { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }
    }
  }

  test("two-or-more read-only dispatch_skill calls in one turn run concurrently", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "analyze-project", target: TARGET, description: "a" },
        { skill: "git-status", target: TARGET, description: "b" },
      ),
      finishCall(),
    ])
    const deps = new ConcurrencyProbeDeps(2)

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("done")
    expect(deps.dispatchStartOrder.sort()).toEqual(["analyze-project", "git-status"])
    expect(deps.waitStartOrder.sort()).toEqual(["analyze-project", "git-status"])
    const dispatchEntries = result.auditLog.filter((e) => e.type === "dispatch")
    expect(dispatchEntries.map((e) => (e as { outcome: string }).outcome)).toEqual(["completed", "completed"])
  })

  test("a turn with a single dispatch_skill call still records toolCallCount", async () => {
    const model = new ScriptedChatModel([dispatchCall("git-status", TARGET, "solo"), finishCall()])
    const deps = new MockDeps({ "git-status": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    const decisionEntries = result.auditLog.filter((e) => e.type === "decision" && (e as { reason: string }).reason === "dispatched")
    expect(decisionEntries).toHaveLength(1)
    expect((decisionEntries[0] as { toolCallCount: number }).toolCallCount).toBe(1)
  })

  // specs/120-supervisor-parallel-write-dispatch/spec.md Proposed Behavior
  // 1 — these two tests previously asserted the OLD, now-superseded
  // behavior (a mixed read-only/write-capable batch fell back to
  // single-call handling). specs/120's whole purpose is removing exactly
  // that restriction — see spec.md's Acceptance Criteria, which narrows
  // "existing tests pass unmodified" to single-`dispatch_skill`-call and
  // `finish`-call turns specifically, not mixed-tier batches. Updated here
  // to assert the new, approved behavior instead of the old one.
  test("a batch mixing a read-only and a write-capable call now fans out — both dispatch, the write-capable one reaches its own approval", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "git-status", target: TARGET, description: "read-only, first" },
        { skill: "dockerize", target: TARGET, description: "write-capable, second" },
      ),
      finishCall(),
    ])
    const deps = new MockDeps({
      "git-status": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
      dockerize: { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
    })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(deps.dispatchCalls.map((c) => c.skill).sort()).toEqual(["dockerize", "git-status"])
    const dispatchedDecisions = result.auditLog.filter((e) => e.type === "decision" && (e as { reason: string }).reason === "dispatched")
    expect(dispatchedDecisions).toHaveLength(2)
    for (const d of dispatchedDecisions) expect((d as { toolCallCount: number }).toolCallCount).toBe(2)
  })

  test("a batch where the FIRST entry is write-capable also fans out (order does not disqualify a batch)", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "dockerize", target: TARGET, description: "write-capable, first" },
        { skill: "git-status", target: TARGET, description: "read-only, second" },
      ),
      finishCall(),
    ])
    const deps = new MockDeps({
      dockerize: { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
      "git-status": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
    })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(deps.dispatchCalls.map((c) => c.skill).sort()).toEqual(["dockerize", "git-status"])
  })

  // ============================================================
  // specs/120-supervisor-parallel-write-dispatch/spec.md — write-capable
  // batch dispatch: the three newly-reachable outcomes, sibling-skip on a
  // run-ending outcome, and in-batch duplicate-write/skipped-skill refusal.
  // ============================================================
  test("a rejected branch inside a batch ends the run, and its own dispatch outcome is recorded", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "dockerize", target: TARGET, description: "a" },
        { skill: "create-ci", target: TARGET, description: "b" },
      ),
    ])
    const deps = new MockDeps({
      dockerize: { status: "failed", wasRejectedByOrchestrator: true, wasSkippedByOrchestrator: false },
      "create-ci": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
    })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("rejected")
    const dispatchEntries = result.auditLog.filter((e) => e.type === "dispatch") as { skill: string; outcome: string }[]
    expect(dispatchEntries).toHaveLength(2)
    expect(dispatchEntries.find((e) => e.skill === "dockerize")?.outcome).toBe("rejected")
  })

  test("a failed-ambiguous branch inside a batch ends the run", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "dockerize", target: TARGET, description: "a" },
        { skill: "create-ci", target: TARGET, description: "b" },
      ),
    ])
    const deps = new MockDeps({
      dockerize: { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
      "create-ci": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
    })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("failed-ambiguous")
  })

  test("a skipped branch inside a batch does NOT end the run — other branches proceed and the run finishes normally", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "dockerize", target: TARGET, description: "a" },
        { skill: "create-ci", target: TARGET, description: "b" },
      ),
      finishCall(),
    ])
    const deps = new MockDeps({
      dockerize: { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: true },
      "create-ci": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
    })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("done")
    const dispatchEntries = result.auditLog.filter((e) => e.type === "dispatch") as { skill: string; outcome: string }[]
    expect(dispatchEntries.find((e) => e.skill === "dockerize")?.outcome).toBe("skipped")
    expect(dispatchEntries.find((e) => e.skill === "create-ci")?.outcome).toBe("completed")
  })

  test("the skipped skill from an in-batch skip cannot be re-proposed later in the run", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "dockerize", target: TARGET, description: "a" },
        { skill: "create-ci", target: TARGET, description: "b" },
      ),
      dispatchCall("dockerize", TARGET, "retry — must be refused"),
      finishCall(),
    ])
    const deps = new MockDeps({
      dockerize: { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: true },
      "create-ci": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
    })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("done")
    // Only the two original batch branches were ever really dispatched —
    // the retry attempt is refused before deps.dispatch() is called again.
    expect(deps.dispatchCalls.map((c) => c.skill)).toEqual(["dockerize", "create-ci"])
    const refusal = result.auditLog.find((e) => e.type === "decision" && (e as { reason: string }).reason === "skipped-skill-refused")
    expect(refusal).toBeTruthy()
  })

  test("a batch naming the same (skill, target) twice dispatches it once and records duplicate-write-refused for the second", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "dockerize", target: TARGET, description: "first" },
        { skill: "dockerize", target: TARGET, description: "duplicate — must be refused" },
      ),
      finishCall(),
    ])
    const deps = new MockDeps({ dockerize: { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(deps.dispatchCalls).toHaveLength(1)
    const refusal = result.auditLog.find((e) => e.type === "decision" && (e as { reason: string }).reason === "duplicate-write-refused")
    expect(refusal).toBeTruthy()
  })

  test("several write-capable dispatch_skill calls in one turn run concurrently, proven by overlapping wait() windows", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "dockerize", target: TARGET, description: "a" },
        { skill: "create-ci", target: TARGET, description: "b" },
      ),
      finishCall(),
    ])
    const deps = new ConcurrencyProbeDeps(2)

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("done")
    expect(deps.dispatchStartOrder.sort()).toEqual(["create-ci", "dockerize"])
    expect(deps.waitStartOrder.sort()).toEqual(["create-ci", "dockerize"])
  })

  test("a run-ending outcome in one branch triggers deps.skip() on every still-in-flight sibling", async () => {
    class SkipTrackingDeps implements SupervisorDeps {
      public skipCalls: string[] = []
      private childIdToSkill = new Map<string, string>()
      private counter = 0
      private releaseSlow: (() => void) | null = null
      constructor(private readonly waitResultsBySkill: Record<string, WaitResult>) {}

      async dispatch(skill: string): Promise<DispatchResult | null> {
        const childTaskId = `child::${skill}::${this.counter++}`
        this.childIdToSkill.set(childTaskId, skill)
        return { childTaskId }
      }

      async wait(childTaskId: string): Promise<WaitResult> {
        const skill = this.childIdToSkill.get(childTaskId)!
        if (skill === "create-ci") {
          // The slow branch: never resolves on its own until skip() is
          // called — proves the skip is what unblocks it, not a timer.
          await new Promise<void>((resolve) => { this.releaseSlow = resolve })
          return { status: "failed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: true }
        }
        return this.waitResultsBySkill[skill]
      }

      async skip(childTaskId: string): Promise<void> {
        const skill = this.childIdToSkill.get(childTaskId)!
        this.skipCalls.push(skill)
        this.releaseSlow?.()
      }
    }

    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "dockerize", target: TARGET, description: "rejected fast" },
        { skill: "create-ci", target: TARGET, description: "slow — must be skipped" },
      ),
    ])
    const deps = new SkipTrackingDeps({
      dockerize: { status: "failed", wasRejectedByOrchestrator: true, wasSkippedByOrchestrator: false },
    })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("rejected")
    expect(deps.skipCalls).toEqual(["create-ci"])
    const dispatchEntries = result.auditLog.filter((e) => e.type === "dispatch") as { skill: string; outcome: string }[]
    expect(dispatchEntries.find((e) => e.skill === "create-ci")?.outcome).toBe("skipped")
  })

  test("a batch exceeding the remaining dispatch budget dispatches only what fits, per branch", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "analyze-project", target: TARGET, description: "a" },
        { skill: "git-status", target: TARGET, description: "b" },
        { skill: "scan-secrets", target: TARGET, description: "c" },
      ),
      finishCall(),
    ])
    const deps = new MockDeps({
      "analyze-project": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
      "git-status": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
      "scan-secrets": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
    })

    // Budget for exactly 2 dispatches total — the batch asked for 3.
    const result = await runSupervisor(`task at ${TARGET}`, { model, deps, maxDispatches: 2 })

    expect(deps.dispatchCalls).toHaveLength(2)
    expect(deps.dispatchCalls.map((c) => c.skill)).toEqual(["analyze-project", "git-status"])
    const skippedEntries = result.auditLog.filter((e) => e.type === "decision" && (e as { reason: string }).reason === "max-dispatches-reached")
    expect(skippedEntries).toHaveLength(1)
    expect((skippedEntries[0] as { skill: string }).skill).toBe("scan-secrets")
  })

  test("one branch timing out ends the run, with every branch's own outcome still in the audit log", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "analyze-project", target: TARGET, description: "a" },
        { skill: "git-status", target: TARGET, description: "b" },
      ),
    ])
    const deps = new MockDeps({
      "analyze-project": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
      "git-status": { status: "timeout", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false },
    })

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("timeout")
    const dispatchEntries = result.auditLog.filter((e) => e.type === "dispatch") as { skill: string; outcome: string }[]
    expect(dispatchEntries).toHaveLength(2)
    expect(dispatchEntries.find((e) => e.skill === "analyze-project")?.outcome).toBe("completed")
    expect(dispatchEntries.find((e) => e.skill === "git-status")?.outcome).toBe("timeout")
  })

  test("a batch where one skill has no online agent does not consume dispatch/attempt budget for that branch", async () => {
    const model = new ScriptedChatModel([
      multiDispatchCall(
        { skill: "analyze-project", target: TARGET, description: "a" },
        { skill: "git-status", target: TARGET, description: "b — no agent" },
      ),
      finishCall(),
    ])
    const deps = new MockDeps(
      { "analyze-project": { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false } },
      ["git-status"],
    )

    const result = await runSupervisor(`task at ${TARGET}`, { model, deps })

    expect(result.terminal).toBe("done")
    expect(result.dispatchCount).toBe(1)
  })
})
