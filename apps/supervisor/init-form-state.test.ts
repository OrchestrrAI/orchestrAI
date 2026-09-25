// specs/048-guided-init-experience/spec.md — Phase 1 exit gate.
//
// Pins the setup form's pure state before any rendering exists. The
// load-bearing test in this file is the last describe block: the form and
// the classic prompt wizard must serialize to byte-identical config for the
// same answers. That is what keeps three input surfaces (form, browser page
// in specs/049, classic wizard) honest about there being one config
// contract rather than three.
import { describe, expect, test } from "bun:test"
import { AGENT_LLM_HARNESSES, LLM_PROVIDERS, WIZARD_OWNED_KEYS, componentModelVar, formatConfigEnv, parseServiceSelection, providerKeyVar, type LlmProvider, type WizardConfig } from "./init-wizard"
import { LLM_COMPONENTS, type LlmComponent } from "../../packages/shared/llm-model-factory"
import {
  type InitFormState,
  MODEL_PICKER_WINDOW,
  agentLlmFieldsFor,
  availableProviders,
  canLeaveProvidersStep,
  canOpenRowPicker,
  canPickModelFromList,
  closeProvidersView,
  cycleProvider,
  cyclePickerProvider,
  cycleProviderOverrideAtCursor,
  cycleRowProvider,
  cycleSharedProvider,
  enterModelSelectMode,
  exitModelSelectMode,
  fieldScrollOffset,
  formStateToWizardConfig,
  initialFormState,
  keyForProvider,
  modelAtCursor,
  modelListForCursor,
  modelPickerWindow,
  modelsRows,
  moveAgentCursor,
  moveFocus,
  moveModelsCursor,
  moveModelPickerCursor,
  movePortsCursor,
  moveProvidersCursor,
  openProvidersView,
  pickModelFromList,
  portOverrideAtCursor,
  portsValidationErrors,
  providerAtProvidersCursor,
  registerProviderKey,
  resolvedHarnessLimit,
  resolvedPort,
  resolvedProviderAtCursor,
  selectedAgentsToOnly,
  serviceAtPortsCursor,
  setHarnessLimitOverride,
  setModelAtCursor,
  setModelFetchError,
  setModelFetchLoading,
  setModelFetchSuccess,
  setPortOverrideAtCursor,
  setProviderOverrideAtCursor,
  setText,
  SERVICE_PORT_ROWS,
  toggleAgentAtCursor,
  unregisterProviderKey,
  validate,
  visibleFields,
} from "./init-form-state"
import { DEFAULT_SERVICE_PORTS } from "../../packages/shared/service-ports"
import { DEFAULT_HARNESS_RECURSION_LIMIT, HARNESS_RECURSION_LIMIT_ENV_VAR } from "../../packages/shared/harness-limits"

const AGENTS = ["devops-agent", "testing-agent", "documentation-agent", "security-agent", "code-review-agent", "coder-agent"]

function state(overrides: Partial<InitFormState> = {}): InitFormState {
  return { ...initialFormState("C:\\proj", AGENTS), ...overrides }
}

const anyDirExists = () => true
const noDirExists = () => false

describe("visibleFields — specs/070/071/073/125 — Target → Agents → Models → Ports → Harness limit, nothing else", () => {
  test("the setup screen has exactly five focusable fields, regardless of the agent selection", () => {
    // specs/070 removed the per-agent LLM toggles and the setup-screen
    // Provider / API-key rows: agent selection IS the LLM decision, and
    // provider + key are owned by the Providers step (specs/068). specs/071
    // folded the per-component picker in as a "models" section — one
    // FormFieldId for the whole thing, not one per row. specs/073 adds
    // "ports" as a fourth, static field (not agent-selection-dependent —
    // every service's port is configurable regardless of whether it's
    // currently selected to start). specs/125 adds "harnessLimit" as a
    // fifth, also static field.
    expect(visibleFields(state())).toEqual(["targetPath", "agents", "models", "ports", "harnessLimit"])
    expect(visibleFields(state({ selectedAgents: ["testing-agent"] }))).toEqual(["targetPath", "agents", "models", "ports", "harnessLimit"])
    expect(visibleFields(state({ selectedAgents: [] }))).toEqual(["targetPath", "agents", "models", "ports", "harnessLimit"])
  })
})

describe("moveFocus — never lands on a hidden field", () => {
  test("wraps forward through the five setup fields", () => {
    let s = state({ focus: "models" })
    s = moveFocus(s, 1)
    expect(s.focus).toBe("ports")
    s = moveFocus(s, 1)
    expect(s.focus).toBe("harnessLimit")
    s = moveFocus(s, 1)
    expect(s.focus).toBe("targetPath") // wrapped
    s = moveFocus(s, 1)
    expect(s.focus).toBe("agents")
    s = moveFocus(s, 1)
    expect(s.focus).toBe("models")
  })

  test("wraps backward", () => {
    expect(moveFocus(state({ focus: "targetPath" }), -1).focus).toBe("harnessLimit")
  })

  test("a genuinely unknown focus value resolves to the first field rather than throwing", () => {
    const stranded = { ...state(), focus: "gone" } as unknown as InitFormState
    expect(moveFocus(stranded, 1).focus).toBe("targetPath")
  })
})

describe("agent selection", () => {
  test("the cursor moves within bounds and never goes negative or past the end", () => {
    let s = state({ agentCursor: 0 })
    expect(moveAgentCursor(s, -1).agentCursor).toBe(0)
    s = { ...s, agentCursor: AGENTS.length - 1 }
    expect(moveAgentCursor(s, 1).agentCursor).toBe(AGENTS.length - 1)
  })

  test("toggling removes and re-adds the agent under the cursor", () => {
    let s = state({ agentCursor: 0 }) // devops-agent, selected by default
    s = toggleAgentAtCursor(s)
    expect(s.selectedAgents).not.toContain("devops-agent")
    s = toggleAgentAtCursor(s)
    expect(s.selectedAgents).toContain("devops-agent")
  })

  test("selection order always follows display order, not the order ticked", () => {
    let s = state({ selectedAgents: [], agentCursor: 3 })
    s = toggleAgentAtCursor(s) // security-agent first
    for (let i = 0; i < 3; i++) s = moveAgentCursor(s, -1) // walk up to the top, one keypress at a time
    s = toggleAgentAtCursor(s) // then devops-agent
    expect(s.selectedAgents).toEqual(["devops-agent", "security-agent"])
  })

  test("specs/071 — deselecting an agent clamps a stranded modelsCursor back into range and closes any open picker", () => {
    // default state (specs/083 — coder now has its own harness too; specs/095
    // added the two always-on rows right after "shared"):
    // modelsRows = ["shared", "orchestrator", "conversation", "devops", "documentation", "security", "testing", "codeReview", "coder"];
    // agentCursor 0 = devops-agent (display order), modelsCursor set well
    // past the end of what remains once devops-agent is deselected.
    let s = state({ agentCursor: 0, modelsCursor: 99, modelPickerOpen: true })
    s = toggleAgentAtCursor(s) // deselect devops-agent
    const rows = modelsRows(s) // ["shared", "orchestrator", "conversation", "documentation", "security", "testing", "codeReview", "coder"]
    expect(rows).toEqual(["shared", "orchestrator", "conversation", "documentation", "security", "testing", "codeReview", "coder"])
    expect(s.modelsCursor).toBe(rows.length - 1) // clamped, not left pointing past the end
    expect(s.modelPickerOpen).toBe(false)
  })
})

describe("cycleProvider", () => {
  test("cycles forward and wraps", () => {
    let s = state({ llmProvider: "anthropic" })
    s = cycleProvider(s, 1)
    expect(s.llmProvider).toBe("openai")
    s = cycleProvider(s, 1)
    expect(s.llmProvider).toBe("gemini")
    s = cycleProvider(s, 1)
    expect(s.llmProvider).toBe("anthropic")
  })

  test("cycles backward and wraps", () => {
    expect(cycleProvider(state({ llmProvider: "anthropic" }), -1).llmProvider).toBe("gemini")
  })
})

describe("validate", () => {
  test("an existing directory with no provider needed is saveable", () => {
    expect(validate(state(), anyDirExists).canSave).toBe(true)
  })

  test("a non-existent target path blocks save and flags that field", () => {
    const v = validate(state(), noDirExists)
    expect(v.canSave).toBe(false)
    expect(v.errors.targetPath).toContain("existing directory")
  })

  test("an empty target path blocks save", () => {
    const v = validate(setText(state(), "targetPath", "   "), anyDirExists)
    expect(v.canSave).toBe(false)
    expect(v.errors.targetPath).toBeTruthy()
  })

  test("gemini without a model blocks save — matching the classic wizard's own rule", () => {
    const s = state({ llmProvider: "gemini", llmModel: "" })
    const v = validate(s, anyDirExists)
    expect(v.canSave).toBe(false)
    expect(v.errors.models).toContain("gemini")
  })

  test("gemini with a model is fine", () => {
    const s = state({ llmProvider: "gemini", llmModel: "gemini-2.5-pro" })
    expect(validate(s, anyDirExists).canSave).toBe(true)
  })

  test("anthropic without a model is fine — it has a provider default", () => {
    const s = state({ llmProvider: "anthropic", llmModel: "" })
    expect(validate(s, anyDirExists).canSave).toBe(true)
  })
})

describe("selectedAgentsToOnly — 'all' is written as all, not as a redundant list", () => {
  test("every agent selected maps to an empty only, exactly like answering \"all\"", () => {
    expect(selectedAgentsToOnly({ allAgents: AGENTS, selectedAgents: [...AGENTS] })).toEqual([])
  })

  test("specs/072 — no agent selected means NONE (orchestrator only), unlike parseServiceSelection's own blank-input-means-all", () => {
    expect(selectedAgentsToOnly({ allAgents: AGENTS, selectedAgents: [] })).toEqual(["orchestrator"])
  })

  test("a real subset is preserved in display order", () => {
    const only = selectedAgentsToOnly({ allAgents: AGENTS, selectedAgents: ["security-agent", "devops-agent"] })
    expect(only).toEqual(["devops-agent", "security-agent"])
  })
})

describe("specs/072 — agentLlmFieldsFor: no 'empty means all' fallback", () => {
  test("an empty selection yields no harness fields at all", () => {
    expect(agentLlmFieldsFor({ selectedAgents: [] })).toEqual([])
  })

  test("a fresh form's full explicit selection is unaffected — same output as before specs/072", () => {
    // specs/080/082/083 — testing-agent, code-review-agent, and
    // coder-agent all joined AGENT_LLM_HARNESSES since this test was
    // first written.
    expect(agentLlmFieldsFor({ selectedAgents: [...AGENTS] })).toEqual(["devopsLlm", "documentationLlm", "securityLlm", "testingLlm", "codeReviewLlm", "coderLlm"])
  })

  test("a real subset returns only that subset's harness fields", () => {
    expect(agentLlmFieldsFor({ selectedAgents: ["devops-agent"] })).toEqual(["devopsLlm"])
  })
})

describe("formStateToWizardConfig", () => {
  test("llmProvider is always written — specs/051, it is a required field now", () => {
    const config = formStateToWizardConfig(state())
    expect(config.llmProvider).toBe("anthropic")
  })

  test("an untouched model/key stay undefined, not empty strings", () => {
    const config = formStateToWizardConfig(state())
    expect(config.llmModel).toBeUndefined()
    expect(config.llmApiKey).toBeUndefined()
  })

  test("trims the target path and the model", () => {
    const s = state({ llmProvider: "gemini", llmModel: "  gemini-2.5-pro  ", targetPath: "  C:\\proj  " })
    const config = formStateToWizardConfig(s)
    expect(config.projectPath).toBe("C:\\proj")
    expect(config.llmModel).toBe("gemini-2.5-pro")
  })
})

describe("initialFormState — pre-fill matches the classic wizard's own behavior", () => {
  test("a fresh run selects every agent and defaults the rest", () => {
    const s = initialFormState("C:\\proj", AGENTS)
    expect(s.selectedAgents).toEqual(AGENTS)
    expect(s.llmProvider).toBe("anthropic")
    expect(s.focus).toBe("targetPath")
  })

  test("a saved subset pre-fills, and specs/034's implied services never show as agent choices", () => {
    const s = initialFormState("C:\\proj", AGENTS, {
      env: { ORCHESTRAI_ONLY: "devops-agent,orchestrator,mcp:http" },
    })
    expect(s.selectedAgents).toEqual(["devops-agent"])
  })

  test("a saved project path wins over the cwd default", () => {
    const s = initialFormState("C:\\cwd", AGENTS, { env: {}, projectPath: "C:\\saved" })
    expect(s.targetPath).toBe("C:\\saved")
  })

  test("an unrecognized saved provider falls back rather than being trusted", () => {
    const s = initialFormState("C:\\proj", AGENTS, { env: { ORCHESTRAI_LLM_PROVIDER: "not-a-provider" } })
    expect(s.llmProvider).toBe("anthropic")
  })

  test("stale ORCHESTRAI_LLM_HARNESS/ORCHESTRAI_ORCHESTRATOR_GRAPH values from a pre-051 config are simply ignored — specs/051, both retired", () => {
    const s = initialFormState("C:\\proj", AGENTS, {
      env: { ORCHESTRAI_LLM_HARNESS: "1", ORCHESTRAI_ORCHESTRATOR_GRAPH: "1" },
    })
    expect(s).not.toHaveProperty("llmHarness")
    expect(s).not.toHaveProperty("orchestratorSupervisor")
  })
})

describe("specs/071 — the Models section (folded into the setup screen, replacing the retired `m` view)", () => {
  test("modelsRows starts with 'shared', then the two always-on rows, then one row per selected agent that has an LLM harness", () => {
    // specs/080/082/083 — testing, code-review, and coder all have their
    // own harnesses now, so a full selection includes all three rows too.
    // specs/095 — orchestrator/conversation are always present, regardless
    // of selectedAgents, right after "shared".
    expect(modelsRows(state())).toEqual(["shared", "orchestrator", "conversation", "devops", "documentation", "security", "testing", "codeReview", "coder"])
  })

  test("a deselected agent has no row; testing-agent now has its own row since specs/080", () => {
    expect(modelsRows(state({ selectedAgents: ["testing-agent"] }))).toEqual(["shared", "orchestrator", "conversation", "testing"])
    expect(modelsRows(state({ selectedAgents: ["devops-agent"] }))).toEqual(["shared", "orchestrator", "conversation", "devops"])
  })

  test("specs/072 — an explicitly empty selection means NONE agent rows, but the two always-on rows still show (specs/095)", () => {
    expect(modelsRows(state({ selectedAgents: [] }))).toEqual(["shared", "orchestrator", "conversation"])
  })

  test("a hand-edited override round-trips even if the user never opens the section", () => {
    // Load-bearing, not a nicety: WIZARD_OWNED_KEYS owns the per-component
    // model vars now, so merge removes any the config does not express.
    // Seeding is the ONLY thing standing between a user's hand-edited
    // override and silent deletion on the next save. specs/095 — orchestrator
    // now HAS a real Models-section row too (it no longer needs to round-trip
    // purely through seeding), but seeding is still what carries an override
    // set before the form ever opens (e.g. by hand, or by a prior init run).
    const s = initialFormState("C:\\proj", AGENTS, {
      env: { ORCHESTRAI_DEVOPS_LLM_MODEL: "gemini-3.5-flash", ORCHESTRAI_ORCHESTRATOR_LLM_MODEL: "gemini-3.5-pro" },
    })
    expect(s.modelOverrides.devops).toBe("gemini-3.5-flash")
    const written = formatConfigEnv(formStateToWizardConfig(s))
    expect(written).toContain("ORCHESTRAI_DEVOPS_LLM_MODEL=gemini-3.5-flash")
    expect(written).toContain("ORCHESTRAI_ORCHESTRATOR_LLM_MODEL=gemini-3.5-pro")
  })

  test("a component with no override writes no line, so the shared model keeps applying", () => {
    const written = formatConfigEnv(formStateToWizardConfig(state({ llmModel: "shared-model" })))
    expect(written).toContain("ORCHESTRAI_LLM_MODEL=shared-model")
    for (const component of LLM_COMPONENTS) {
      expect(written).not.toContain(`ORCHESTRAI_${component.toUpperCase()}_LLM_MODEL=`)
    }
  })

  test("clearing a row back to empty removes the override entirely", () => {
    let s = initialFormState("C:\\proj", AGENTS, { env: { ORCHESTRAI_DEVOPS_LLM_MODEL: "gemini-3.5-flash" } })
    s = { ...s, modelsCursor: modelsRows(s).indexOf("devops") }
    expect(modelAtCursor(s)).toBe("gemini-3.5-flash")
    s = setModelAtCursor(s, "")
    expect(formatConfigEnv(formStateToWizardConfig(s))).not.toContain("ORCHESTRAI_DEVOPS_LLM_MODEL")
  })

  test("whitespace-only is treated as cleared, not as a model named ' '", () => {
    let s = state()
    s = { ...s, modelsCursor: modelsRows(s).indexOf("devops") }
    s = setModelAtCursor(s, "   ")
    expect(formatConfigEnv(formStateToWizardConfig(s))).not.toContain("_LLM_MODEL=   ")
  })

  test("row 0 edits the shared model, not a component override", () => {
    const s = setModelAtCursor(state({ modelsCursor: 0 }), "shared-only")
    expect(s.llmModel).toBe("shared-only")
    expect(Object.values(s.modelOverrides).every((v) => v === "")).toBe(true)
  })

  test("the cursor wraps across the shared row and every selected agent's row", () => {
    const count = modelsRows(state()).length
    let s = state({ modelsCursor: 0 })
    for (let i = 0; i < count; i++) s = moveModelsCursor(s, 1)
    expect(s.modelsCursor).toBe(0) // full cycle
    expect(moveModelsCursor(state({ modelsCursor: 0 }), -1).modelsCursor).toBe(count - 1)
  })

  test("the written variable matches exactly what resolveLlmVar looks for", () => {
    // init writes it, packages/shared/llm-model-factory.ts reads it — if the
    // two ever construct the name differently the override silently does
    // nothing, which is the worst possible failure here.
    expect(componentModelVar("orchestrator")).toBe("ORCHESTRAI_ORCHESTRATOR_LLM_MODEL")
    expect(componentModelVar("documentation")).toBe("ORCHESTRAI_DOCUMENTATION_LLM_MODEL")
  })
})

describe("specs/070 — agent selection IS the LLM decision (no per-agent toggle)", () => {
  test("every selected agent that has a harness writes ORCHESTRAI_<AGENT>_LLM_HARNESS=1", () => {
    const config = formStateToWizardConfig(state({ selectedAgents: [...AGENTS] }))
    // specs/080/082/083 — testing, code-review, and coder all joined.
    expect(config.agentLlm).toEqual({ devopsLlm: true, documentationLlm: true, securityLlm: true, testingLlm: true, codeReviewLlm: true, coderLlm: true })
  })

  test("a deselected agent contributes no harness line at all (not =0)", () => {
    const config = formStateToWizardConfig(state({ selectedAgents: ["devops-agent"] }))
    expect(config.agentLlm).toEqual({ devopsLlm: true })
    const written = formatConfigEnv(config)
    expect(written).toContain("ORCHESTRAI_DEVOPS_LLM_HARNESS=1")
    expect(written).not.toContain("ORCHESTRAI_DOCUMENTATION_LLM_HARNESS")
    expect(written).not.toContain("ORCHESTRAI_SECURITY_LLM_HARNESS")
  })

  test("testing-agent alone writes only its own harness line — specs/080", () => {
    const config = formStateToWizardConfig(state({ selectedAgents: ["testing-agent"] }))
    expect(config.agentLlm).toEqual({ testingLlm: true })
  })

  test("specs/072 — nothing selected means NONE, so no agent's harness line is written", () => {
    const config = formStateToWizardConfig(state({ selectedAgents: [] }))
    expect(config.agentLlm).toEqual({})
    expect(config.only).toEqual(["orchestrator"])
  })

  test("a pre-070 config's own harness lines are not re-read — re-running init makes every selected agent an LLM agent", () => {
    const s = initialFormState("C:\\proj", AGENTS, {
      env: { ORCHESTRAI_DEVOPS_LLM_HARNESS: "0", ORCHESTRAI_SECURITY_LLM_HARNESS: "1" },
    })
    // selection is "all" (no ORCHESTRAI_ONLY), so all six come out =1
    expect(formStateToWizardConfig(s).agentLlm).toEqual({ devopsLlm: true, documentationLlm: true, securityLlm: true, testingLlm: true, codeReviewLlm: true, coderLlm: true })
  })
})

// anyone has to discover it from a broken install.
describe("one config contract — the form and the classic wizard serialize identically", () => {
  /** What the classic wizard builds for the same answers, using its own
   *  exported parser rather than a hand-written expectation. */
  function classicConfig(answer: string, extras: Partial<WizardConfig> = {}): Omit<WizardConfig, "projectPath"> {
    const parsed = parseServiceSelection(answer, AGENTS)
    if (!parsed.ok) throw new Error(parsed.error)
    // specs/050 — reconstructed from the classic wizard's OWN parsed
    // selection, deliberately not by calling the form's agentLlmFieldsFor():
    // this file exists to catch the two surfaces disagreeing, which it
    // cannot do if both sides ask the same helper.
    const allAgents = parsed.names.length === 0
    // specs/070 — the form now writes `=1` for every selected agent that
    // has a harness (selecting the agent IS the decision). The classic
    // wizard still asks y/n; an all-yes classic run matches the form, so
    // that's what this reconstruction models.
    const agentLlm: WizardConfig["agentLlm"] = {}
    for (const { agent, field } of AGENT_LLM_HARNESSES) {
      if (allAgents || parsed.names.includes(agent)) agentLlm[field] = true
    }
    return {
      only: parsed.names,
      // specs/051 — llmProvider is required now; the classic wizard always
      // asks it unconditionally, matching the form.
      llmProvider: "anthropic",
      ...extras,
      agentLlm: extras.agentLlm ?? agentLlm,
      // specs/050 Non-Goals — the classic wizard never asks for these, so
      // its config always expresses none. A form config carrying overrides
      // is therefore legitimately NOT byte-equal to a wizard one; the
      // contract covers everything the wizard can express.
      modelOverrides: extras.modelOverrides ?? {},
      providerOverrides: extras.providerOverrides ?? {},
      apiKeyOverrides: extras.apiKeyOverrides ?? {},
      // specs/073 — same reasoning: the classic wizard never asks about
      // ports either.
      ports: extras.ports ?? {},
      // specs/132 — the classic wizard records its one key in the
      // registered-provider store too, exactly as runInitWizardInner does.
      providerKeys: extras.providerKeys ?? (extras.llmApiKey ? { [extras.llmProvider ?? "anthropic"]: extras.llmApiKey } : {}),
    }
  }

  test("\"all\" typed classically === every box ticked in the form", () => {
    const fromForm = formStateToWizardConfig(state({ selectedAgents: [...AGENTS] }))
    expect(formatConfigEnv(fromForm)).toBe(formatConfigEnv(classicConfig("all")))
  })

  test("\"1,3\" typed classically === those two boxes ticked in the form", () => {
    const fromForm = formStateToWizardConfig(state({ selectedAgents: ["devops-agent", "documentation-agent"] }))
    expect(formatConfigEnv(fromForm)).toBe(formatConfigEnv(classicConfig("1,3")))
  })

  test("a full LLM configuration serializes identically", () => {
    const fromForm = formStateToWizardConfig(
      state({
        selectedAgents: ["devops-agent"],
        llmProvider: "gemini",
        llmModel: "gemini-2.5-pro",
        llmApiKey: "AIzaSyExampleKeyValue",
      }),
    )
    const fromClassic = classicConfig("1", {
      llmProvider: "gemini",
      llmModel: "gemini-2.5-pro",
      llmApiKey: "AIzaSyExampleKeyValue",
    })
    expect(formatConfigEnv(fromForm)).toBe(formatConfigEnv(fromClassic))
  })

  test("specs/034's orchestrator rule still applies through the form's own path", () => {
    const fromForm = formStateToWizardConfig(state({ selectedAgents: ["devops-agent"] }))
    // A narrowed selection always gains `orchestrator` at write time, so a
    // form-written config can never produce a coordinator-less startup.
    expect(formatConfigEnv(fromForm)).toContain("ORCHESTRAI_ONLY=devops-agent,orchestrator")
  })

  test("specs/070 — a narrowed selection: selected harness agents write =1, the rest write nothing", () => {
    const fromForm = formStateToWizardConfig(state({ selectedAgents: ["devops-agent", "security-agent"] }))
    // classic all-yes for the same two agents matches
    const fromClassic = classicConfig("1,4", { llmProvider: "anthropic" })
    expect(formatConfigEnv(fromForm)).toBe(formatConfigEnv(fromClassic))
    const written = formatConfigEnv(fromForm)
    expect(written).toContain("ORCHESTRAI_DEVOPS_LLM_HARNESS=1")
    expect(written).toContain("ORCHESTRAI_SECURITY_LLM_HARNESS=1")
    expect(written).not.toContain("ORCHESTRAI_DOCUMENTATION_LLM_HARNESS")
  })

  test("specs/070 — every agent selected writes every harness =1 (was all-off =0 under specs/050)", () => {
    const written = formatConfigEnv(formStateToWizardConfig(state({ selectedAgents: [...AGENTS] })))
    expect(written).toContain("ORCHESTRAI_DEVOPS_LLM_HARNESS=1")
    expect(written).toContain("ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=1")
    expect(written).toContain("ORCHESTRAI_SECURITY_LLM_HARNESS=1")
  })

  test("specs/051 — a minimal config still always carries a provider line, no ORCHESTRAI_LLM_HARNESS/ORCHESTRATOR_GRAPH lines at all", () => {
    // The regression proof: neither retired flag is ever written again,
    // regardless of what the caller passes — there is no field left to
    // carry them on WizardConfig any more.
    const written = formatConfigEnv({ only: [], llmProvider: "anthropic", agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {} })
    expect(written).toBe("ORCHESTRAI_ONLY=\nORCHESTRAI_LLM_PROVIDER=anthropic\n")
  })
})

// Found the reason to test this the hard way: a live PTY run without it
// showed the scrollable region not following focus down to fields that had
// scrolled out of view. This pins the exact per-field offsets
// apps/supervisor/init-form.tsx's own render order produces, so a future
// reorder of the JSX has one obvious place (this + fieldScrollOffset itself)
// to update, and a test that fails instead of silently mis-scrolling.
describe("fieldScrollOffset — keeps the focused field visible in the scrollable region", () => {
  // specs/071 — the middle section below the agent list is now exactly one
  // row: the Models section (whatever it contains). targetPath and agents
  // both sit at the top (targetPath never inside the scrollable region).
  const fields = visibleFields(state())

  test("agents and targetPath are at the top", () => {
    expect(fieldScrollOffset("agents", 5, fields)).toBe(0)
    expect(fieldScrollOffset("targetPath", 5, fields)).toBe(0)
  })

  test("the Models row sits right after the agent section (header + N rows + note + one blank)", () => {
    expect(fieldScrollOffset("models", 5, fields)).toBe(2 + 5 + 1)
    expect(fieldScrollOffset("models", 4, fields)).toBe(2 + 4 + 1)
  })

  test("a field that is not currently in the list resolves to the top rather than a wrong row", () => {
    expect(fieldScrollOffset("agents", 5, ["targetPath"])).toBe(0)
  })
})

// ============================================================
// specs/063-init-per-component-provider-and-key/spec.md — the
// Providers screen and the Models section's provider picker + live
// model discovery.
// ============================================================

describe("availableProviders / keyForProvider — the shared default plus registered extras", () => {
  test("with nothing extra registered, only the shared provider is available", () => {
    const s = state({ llmProvider: "anthropic", llmApiKey: "shared-key" })
    expect(availableProviders(s)).toEqual(["anthropic"])
    expect(keyForProvider(s, "anthropic")).toBe("shared-key")
    expect(keyForProvider(s, "openai")).toBe("")
  })

  test("a registered extra provider becomes available, in LLM_PROVIDERS order", () => {
    const s = state({ llmProvider: "gemini", extraProviders: { anthropic: "extra-key" } })
    expect(availableProviders(s)).toEqual(["gemini", "anthropic"])
    expect(keyForProvider(s, "anthropic")).toBe("extra-key")
  })

  test("a provider with no registered key never appears, even if the field exists but is empty", () => {
    const s = state({ llmProvider: "anthropic", extraProviders: { openai: "" } })
    expect(availableProviders(s)).toEqual(["anthropic"])
  })
})

describe("Providers screen — cursor and registration", () => {
  test("opening/closing switches view without disturbing other state", () => {
    const s = openProvidersView(state({ llmApiKey: "k" }))
    expect(s.view).toBe("providers")
    expect(s.providersCursor).toBe(0)
    expect(closeProvidersView(s).view).toBe("setup")
    expect(closeProvidersView(s).llmApiKey).toBe("k")
  })

  test("cursor wraps across all LLM_PROVIDERS entries", () => {
    let s = openProvidersView(state())
    s = moveProvidersCursor(s, -1)
    expect(providerAtProvidersCursor(s)).toBe("gemini") // wrapped backward from anthropic (index 0)
  })

  test("specs/070 — the FIRST provider registered becomes the primary, whatever the fresh-form default was", () => {
    // fresh form: llmProvider defaults to "anthropic" but llmApiKey is "".
    let s = openProvidersView(state({ llmProvider: "anthropic" }))
    s = moveProvidersCursor(s, 1) // openai
    s = registerProviderKey(s, "openai-key")
    expect(s.llmProvider).toBe("openai") // promoted, not left on the default
    expect(s.llmApiKey).toBe("openai-key")
    expect(s.extraProviders.openai).toBeUndefined() // it's the primary, not an extra
  })

  test("specs/070 — a second registration, once a primary exists, lands in extraProviders", () => {
    let s = openProvidersView(state({ llmProvider: "anthropic", llmApiKey: "anthropic-key" }))
    s = moveProvidersCursor(s, 1) // openai
    s = registerProviderKey(s, "openai-key")
    expect(s.llmProvider).toBe("anthropic") // primary unchanged
    expect(s.llmApiKey).toBe("anthropic-key")
    expect(s.extraProviders.openai).toBe("openai-key")
    expect(availableProviders(s)).toEqual(["anthropic", "openai"])
  })

  test("re-registering the primary's own row replaces its key in place", () => {
    let s = openProvidersView(state({ llmProvider: "anthropic", llmApiKey: "old" })) // cursor on anthropic
    s = registerProviderKey(s, "new")
    expect(s.llmApiKey).toBe("new")
    expect(s.extraProviders.anthropic).toBeUndefined()
  })

  test("specs/070 — unregistering the primary promotes the first registered extra", () => {
    let s = openProvidersView(state({ llmProvider: "anthropic", llmApiKey: "a-key", extraProviders: { gemini: "g-key" } }))
    // cursor on anthropic (the primary)
    s = unregisterProviderKey(s)
    expect(s.llmProvider).toBe("gemini")
    expect(s.llmApiKey).toBe("g-key")
    expect(s.extraProviders.gemini).toBeUndefined()
  })

  test("specs/070 — unregistering the primary with no extras just clears its key", () => {
    const s0 = openProvidersView(state({ llmProvider: "anthropic", llmApiKey: "k" }))
    const s = unregisterProviderKey(s0)
    expect(s.llmApiKey).toBe("")
    expect(canLeaveProvidersStep(s)).toBe(false) // the step gate re-engages
  })

  test("unregistering an extra provider removes it AND reverts any component assigned to it", () => {
    let s = state({ llmProvider: "anthropic", extraProviders: { openai: "k2" }, providerOverrides: { devops: "openai" } })
    s = openProvidersView(s)
    s = moveProvidersCursor(s, 1) // openai
    s = unregisterProviderKey(s)
    expect(s.extraProviders.openai).toBeUndefined()
    expect(s.providerOverrides.devops).toBeUndefined() // reverted to (shared default), not left dangling
  })

  test("unregistering a provider never touches a DIFFERENT component's own override", () => {
    let s = state({
      llmProvider: "anthropic",
      extraProviders: { openai: "k2", gemini: "k3" },
      providerOverrides: { devops: "openai", security: "gemini" },
    })
    s = openProvidersView(s)
    s = moveProvidersCursor(s, 1) // openai
    s = unregisterProviderKey(s)
    expect(s.providerOverrides.security).toBe("gemini") // untouched
  })
})

describe("Models section — provider picker (structural footgun prevention)", () => {
  test("a component defaults to the shared provider when no override is set", () => {
    const s = { ...state({ llmProvider: "gemini" }), modelsCursor: 3 } // row 3 = first agent row (devops; specs/095 shifted this from row 1)
    expect(resolvedProviderAtCursor(s)).toBe("gemini")
  })

  test("assigning a registered provider to the focused row's component sticks", () => {
    let s = state({ llmProvider: "anthropic", extraProviders: { openai: "k2" } })
    s = { ...s, modelsCursor: 3 }
    const component = modelsRows(s)[3] as LlmComponent
    s = setProviderOverrideAtCursor(s, "openai")
    expect(s.providerOverrides[component]).toBe("openai")
    expect(resolvedProviderAtCursor(s)).toBe("openai")
  })

  test("clearing an override (null) reverts to the shared default", () => {
    let s = state({ llmProvider: "anthropic", providerOverrides: { devops: "gemini" }, extraProviders: { gemini: "k" } })
    s = { ...s, modelsCursor: 3 } // devops is modelsRows(s)[3] (first agent row; specs/095 shifted this from [1])
    s = setProviderOverrideAtCursor(s, null)
    expect(resolvedProviderAtCursor(s)).toBe("anthropic")
  })

  test("the shared row itself always resolves to the shared provider, never a per-component override", () => {
    const s = { ...state({ llmProvider: "openai", providerOverrides: { devops: "gemini" }, extraProviders: { gemini: "k" } }), modelsCursor: 0 }
    expect(resolvedProviderAtCursor(s)).toBe("openai")
  })

  test("it is structurally impossible to produce a provider override with an empty key, given only this module's own functions", () => {
    // Exercise every Models-section row (every real component now,
    // including orchestrator/conversation since specs/095 — the filter
    // below is already row-agnostic, so this sweep gained two more real
    // components automatically, no test-code change needed for that part)
    // against every available provider — the exact adversarial sweep this
    // spec's own footgun-prevention claim needs, not just one hand-picked
    // case.
    let s = state({ llmProvider: "anthropic", extraProviders: { openai: "k-openai", gemini: "k-gemini" } })
    const rows = modelsRows(s).filter((r): r is LlmComponent => r !== "shared")
    for (const component of rows) {
      for (const provider of availableProviders(s)) {
        s = { ...s, modelsCursor: modelsRows(s).indexOf(component) }
        s = setProviderOverrideAtCursor(s, provider)
      }
    }
    const config = formStateToWizardConfig(s)
    for (const component of Object.keys(config.providerOverrides) as (keyof typeof config.providerOverrides)[]) {
      expect(config.apiKeyOverrides[component]).toBeTruthy()
    }
  })
})

describe("cycleProviderOverrideAtCursor", () => {
  test("with no extra provider registered, cycling is a no-op", () => {
    const s = { ...state({ llmProvider: "anthropic" }), modelsCursor: 3 }
    expect(cycleProviderOverrideAtCursor(s, 1)).toEqual(s)
  })

  test("cycles [shared, extra1, extra2, ...] forward and wraps back to shared", () => {
    let s = { ...state({ llmProvider: "anthropic", extraProviders: { openai: "k1", gemini: "k2" } }), modelsCursor: 3 }
    expect(resolvedProviderAtCursor(s)).toBe("anthropic") // starts at shared
    s = cycleProviderOverrideAtCursor(s, 1)
    expect(resolvedProviderAtCursor(s)).toBe("openai")
    s = cycleProviderOverrideAtCursor(s, 1)
    expect(resolvedProviderAtCursor(s)).toBe("gemini")
    s = cycleProviderOverrideAtCursor(s, 1)
    expect(resolvedProviderAtCursor(s)).toBe("anthropic") // wrapped back to shared
  })

  test("cycling backward from shared wraps to the last extra", () => {
    let s = { ...state({ llmProvider: "anthropic", extraProviders: { openai: "k1" } }), modelsCursor: 3 }
    s = cycleProviderOverrideAtCursor(s, -1)
    expect(resolvedProviderAtCursor(s)).toBe("openai")
  })

  test("is a no-op on the shared row (row 0) — it has no override of its own", () => {
    const s0 = { ...state({ extraProviders: { openai: "k1" } }), modelsCursor: 0 }
    expect(cycleProviderOverrideAtCursor(s0, 1)).toEqual(s0)
  })
})

describe("cyclePickerProvider — specs/071 §4, the picker's own inline provider line", () => {
  test("cycles the row's provider and resets the model sub-cursor to the top", () => {
    let s = { ...state({ llmProvider: "anthropic", extraProviders: { openai: "k1" } }), modelsCursor: 3, modelPickerOpen: true, modelPickerCursor: 3 }
    s = cyclePickerProvider(s, 1)
    expect(resolvedProviderAtCursor(s)).toBe("openai")
    expect(s.modelPickerCursor).toBe(0)
  })

  test("a no-op (shared row, or nothing to cycle) never disturbs modelPickerCursor", () => {
    const shared = { ...state({ extraProviders: { openai: "k1" } }), modelsCursor: 0, modelPickerOpen: true, modelPickerCursor: 2 }
    expect(cyclePickerProvider(shared, 1)).toEqual(shared)

    const noExtras = { ...state({ llmProvider: "anthropic" }), modelsCursor: 3, modelPickerOpen: true, modelPickerCursor: 2 }
    expect(cyclePickerProvider(noExtras, 1)).toEqual(noExtras)
  })
})

describe("canOpenRowPicker — specs/071 §3, Enter opens the picker when there's a real choice", () => {
  test("true when a model list already exists for the row", () => {
    let s = state({ llmProvider: "gemini", llmApiKey: "k", modelsCursor: 0 })
    s = setModelFetchSuccess(s, "gemini", [{ id: "gemini-2.5-flash" }])
    expect(canOpenRowPicker(s)).toBe(true)
  })

  test("true on a component row with a second provider registered, even with no list yet", () => {
    const s = state({ llmProvider: "anthropic", llmApiKey: "k", extraProviders: { openai: "k2" }, modelsCursor: 3 })
    expect(canPickModelFromList(s)).toBe(false)
    expect(canOpenRowPicker(s)).toBe(true)
  })

  test("false on the shared row with no list and only one provider registered", () => {
    const s = state({ llmProvider: "anthropic", llmApiKey: "k", modelsCursor: 0 })
    expect(canOpenRowPicker(s)).toBe(false)
  })

  test("false on a component row with no list and only one provider registered", () => {
    const s = state({ llmProvider: "anthropic", llmApiKey: "k", modelsCursor: 3 })
    expect(canOpenRowPicker(s)).toBe(false)
  })
})

describe("live model-fetch lifecycle setters — pure, no real network call", () => {
  test("loading clears any previous error for that provider", () => {
    let s = setModelFetchError(state(), "openai", "boom")
    s = setModelFetchLoading(s, "openai")
    expect(s.modelFetchStatus.openai).toBe("loading")
    expect(s.modelFetchError.openai).toBeUndefined()
  })

  test("success stores the models and clears loading/error", () => {
    let s = setModelFetchLoading(state(), "anthropic")
    s = setModelFetchSuccess(s, "anthropic", [{ id: "claude-opus-5" }])
    expect(s.discoveredModels.anthropic).toEqual([{ id: "claude-opus-5" }])
    expect(s.modelFetchStatus.anthropic).toBe("idle")
  })

  test("error records the message and status without touching other providers' state", () => {
    let s = setModelFetchSuccess(state(), "gemini", [{ id: "gemini-3.5-flash-lite" }])
    s = setModelFetchError(s, "openai", "invalid key")
    expect(s.modelFetchStatus.openai).toBe("error")
    expect(s.modelFetchError.openai).toBe("invalid key")
    expect(s.discoveredModels.gemini).toEqual([{ id: "gemini-3.5-flash-lite" }]) // untouched
  })
})

describe("formStateToWizardConfig — provider/key overrides are derived, never independently settable", () => {
  test("a component with no provider override writes neither line", () => {
    const config = formStateToWizardConfig(state({ llmProvider: "anthropic", llmApiKey: "shared" }))
    expect(config.providerOverrides).toEqual({})
    expect(config.apiKeyOverrides).toEqual({})
  })

  test("a component assigned to the shared provider itself still resolves its key correctly", () => {
    const s = state({ llmProvider: "anthropic", llmApiKey: "shared-key", providerOverrides: { devops: "anthropic" } })
    const config = formStateToWizardConfig(s)
    expect(config.providerOverrides.devops).toBe("anthropic")
    expect(config.apiKeyOverrides.devops).toBe("shared-key")
  })

  test("a component assigned to a registered extra provider resolves THAT provider's own key", () => {
    const s = state({ llmProvider: "anthropic", llmApiKey: "shared-key", extraProviders: { gemini: "gemini-key" }, providerOverrides: { security: "gemini" } })
    const config = formStateToWizardConfig(s)
    expect(config.providerOverrides.security).toBe("gemini")
    expect(config.apiKeyOverrides.security).toBe("gemini-key")
  })
})

describe("seeding — a re-run of init reconstructs registered providers and overrides from disk", () => {
  test("a component's own PROVIDER+API_KEY pair, different from the shared one, seeds an extra provider and an override", () => {
    const s = initialFormState("C:\\proj", AGENTS, {
      env: {
        ORCHESTRAI_LLM_PROVIDER: "anthropic",
        ORCHESTRAI_LLM_API_KEY: "shared-key",
        ORCHESTRAI_DEVOPS_LLM_PROVIDER: "openai",
        ORCHESTRAI_DEVOPS_LLM_API_KEY: "devops-key",
      },
    })
    expect(s.providerOverrides.devops).toBe("openai")
    expect(s.extraProviders.openai).toBe("devops-key")
    expect(availableProviders(s)).toContain("openai")
  })

  test("a component whose override provider matches the shared one does NOT register a redundant extra", () => {
    const s = initialFormState("C:\\proj", AGENTS, {
      env: {
        ORCHESTRAI_LLM_PROVIDER: "anthropic",
        ORCHESTRAI_LLM_API_KEY: "shared-key",
        ORCHESTRAI_SECURITY_LLM_PROVIDER: "anthropic",
        ORCHESTRAI_SECURITY_LLM_API_KEY: "shared-key",
      },
    })
    expect(s.providerOverrides.security).toBe("anthropic")
    expect(s.extraProviders.anthropic).toBeUndefined() // never duplicated — it's already the shared one
  })

  test("a hand-edited half-pair (provider set, no key, or vice versa) seeds nothing rather than guessing", () => {
    const s = initialFormState("C:\\proj", AGENTS, {
      env: { ORCHESTRAI_LLM_PROVIDER: "anthropic", ORCHESTRAI_LLM_API_KEY: "k", ORCHESTRAI_DEVOPS_LLM_PROVIDER: "openai" },
    })
    expect(s.providerOverrides.devops).toBeUndefined()
    expect(s.extraProviders.openai).toBeUndefined()
  })

  test("round-trip: seeded overrides write back out to the exact same config", () => {
    const env = {
      ORCHESTRAI_LLM_PROVIDER: "anthropic",
      ORCHESTRAI_LLM_API_KEY: "shared-key",
      ORCHESTRAI_DEVOPS_LLM_PROVIDER: "openai",
      ORCHESTRAI_DEVOPS_LLM_API_KEY: "devops-key",
    }
    const s = initialFormState("C:\\proj", AGENTS, { env })
    const written = formatConfigEnv(formStateToWizardConfig(s))
    expect(written).toContain("ORCHESTRAI_DEVOPS_LLM_PROVIDER=openai")
    expect(written).toContain("ORCHESTRAI_DEVOPS_LLM_API_KEY=devops-key")
  })
})

// ============================================================
// specs/068-init-providers-first-flow-and-model-picker/spec.md
// ============================================================

describe("specs/068 — Providers is step 1", () => {
  test("initialFormState opens on the Providers screen, not setup", () => {
    expect(initialFormState("C:\\proj", AGENTS).view).toBe("providers")
  })

  test("canLeaveProvidersStep: false with no credential, true once the shared key is set", () => {
    expect(canLeaveProvidersStep(state({ llmApiKey: "" }))).toBe(false)
    expect(canLeaveProvidersStep(state({ llmApiKey: "  " }))).toBe(false) // whitespace is not a key
    expect(canLeaveProvidersStep(state({ llmApiKey: "sk-real" }))).toBe(true)
  })

  test("an extra provider's key alone also satisfies the gate", () => {
    expect(canLeaveProvidersStep(state({ llmApiKey: "", extraProviders: { openai: "k" } }))).toBe(true)
    expect(canLeaveProvidersStep(state({ llmApiKey: "", extraProviders: { openai: "" } }))).toBe(false)
  })

  test("closeProvidersView will not advance while the gate is unmet, and does once it is", () => {
    const blocked = openProvidersView(state({ llmApiKey: "" }))
    expect(closeProvidersView(blocked).view).toBe("providers") // stayed put

    const ready = openProvidersView(state({ llmApiKey: "sk-real" }))
    expect(closeProvidersView(ready).view).toBe("setup")
  })
})

describe("specs/068/071 — the Models section's model picker", () => {
  const models = [
    { id: "gemini-2.5-flash-lite" },
    { id: "gemini-2.5-flash" },
    { id: "gemini-2.5-pro" },
    { id: "gemini-3.0-flash" },
  ]

  /** A state focused on the given Models-section row (0 = "shared" by
   *  default), with `gemini` already live-fetched. */
  function withList(row = 0) {
    const s = state({ llmProvider: "gemini", llmApiKey: "k", modelsCursor: row })
    return setModelFetchSuccess(s, "gemini", models)
  }

  test("modelListForCursor resolves through whichever row is cursored — the shared row included", () => {
    expect(modelListForCursor(withList(0))).toEqual(models) // shared row
    expect(modelListForCursor(withList(1))).toEqual(models) // orchestrator row (specs/095), same (shared) provider
  })

  test("canPickModelFromList is false until a real list exists for the row", () => {
    const noList = state({ llmProvider: "gemini", llmApiKey: "k", modelsCursor: 0 })
    expect(canPickModelFromList(noList)).toBe(false)
    expect(canPickModelFromList(withList(0))).toBe(true)
  })

  test("enterModelSelectMode is a no-op with no list and only one provider, and starts the sub-cursor on the current value once a list exists", () => {
    const noList = state({ llmProvider: "gemini", llmApiKey: "k", modelsCursor: 0 })
    expect(enterModelSelectMode(noList).modelPickerOpen).toBe(false)

    const fresh = enterModelSelectMode(withList(0))
    expect(fresh.modelPickerOpen).toBe(true)
    expect(fresh.modelPickerCursor).toBe(0) // no value yet → top

    const onPro = enterModelSelectMode({ ...withList(0), llmModel: "gemini-2.5-pro" })
    expect(onPro.modelPickerCursor).toBe(2) // lands on what's already chosen
  })

  test("specs/071 — enterModelSelectMode opens even with an EMPTY list, when a second provider is registered (to switch onto it)", () => {
    const s = state({ llmProvider: "anthropic", llmApiKey: "k", extraProviders: { openai: "k2" }, modelsCursor: 3 })
    expect(canPickModelFromList(s)).toBe(false)
    const opened = enterModelSelectMode(s)
    expect(opened.modelPickerOpen).toBe(true)
    expect(opened.modelPickerCursor).toBe(0)
  })

  test("moveModelPickerCursor wraps within the list, and is inert while the picker is closed", () => {
    let s = enterModelSelectMode(withList(0))
    s = moveModelPickerCursor(s, -1)
    expect(s.modelPickerCursor).toBe(models.length - 1) // wrapped back
    s = moveModelPickerCursor(s, 1)
    expect(s.modelPickerCursor).toBe(0)
    expect(moveModelPickerCursor(withList(0), 1).modelPickerCursor).toBe(0) // closed → no move
  })

  test("pickModelFromList writes the highlighted id and closes the picker", () => {
    let s = enterModelSelectMode(withList(0))
    s = moveModelPickerCursor(s, 1) // gemini-2.5-flash
    s = pickModelFromList(s)
    expect(s.llmModel).toBe("gemini-2.5-flash")
    expect(s.modelPickerOpen).toBe(false)
  })

  test("moving the row cursor closes an open picker", () => {
    const open = enterModelSelectMode(withList(0))
    expect(open.modelPickerOpen).toBe(true)
    expect(moveModelsCursor(open, 1).modelPickerOpen).toBe(false)
  })

  test("a list-picked model id produces a byte-identical config to typing the same id", () => {
    // shared row (index 0)
    let picked = enterModelSelectMode(withList(0))
    picked = moveModelPickerCursor(picked, 1)
    picked = moveModelPickerCursor(picked, 1)
    picked = pickModelFromList(picked)
    const typed = setModelAtCursor(state({ llmProvider: "gemini", llmApiKey: "k", modelsCursor: 0 }), "gemini-2.5-pro")
    expect(formatConfigEnv(formStateToWizardConfig(picked))).toBe(formatConfigEnv(formStateToWizardConfig(typed)))

    // an agent row (index 3 — "devops", the first selected agent; specs/095
    // shifted this from index 1 by inserting the orchestrator/conversation rows)
    let pickedC = enterModelSelectMode(withList(3))
    pickedC = moveModelPickerCursor(pickedC, 1)
    pickedC = moveModelPickerCursor(pickedC, 1)
    pickedC = moveModelPickerCursor(pickedC, 1)
    pickedC = pickModelFromList(pickedC)
    const typedC = setModelAtCursor(state({ llmProvider: "gemini", llmApiKey: "k", modelsCursor: 3 }), "gemini-3.0-flash")
    expect(formatConfigEnv(formStateToWizardConfig(pickedC))).toBe(formatConfigEnv(formStateToWizardConfig(typedC)))
  })

  test("a row whose fetch errored has no list — free-text stays the only path", () => {
    let s = state({ llmProvider: "gemini", llmApiKey: "k", modelsCursor: 0 })
    s = setModelFetchError(s, "gemini", "invalid key")
    expect(canPickModelFromList(s)).toBe(false)
    expect(enterModelSelectMode(s).modelPickerOpen).toBe(false) // only one provider registered — nothing to switch to either
    // typing still works, exactly as specs/063 left it
    expect(setModelAtCursor(s, "gemini-typed").llmModel).toBe("gemini-typed")
  })

  test("exitModelSelectMode leaves the row value untouched", () => {
    let s = enterModelSelectMode({ ...withList(0), llmModel: "keep-me" })
    s = moveModelPickerCursor(s, 1)
    s = moveModelPickerCursor(s, 1)
    s = exitModelSelectMode(s)
    expect(s.modelPickerOpen).toBe(false)
    expect(s.llmModel).toBe("keep-me") // moving the sub-cursor never wrote anything
  })
})

describe("specs/068 — modelPickerWindow paging math", () => {
  test("a list that fits shows the whole thing", () => {
    expect(modelPickerWindow(3, 0, MODEL_PICKER_WINDOW)).toEqual({ start: 0, end: 3 })
    expect(modelPickerWindow(MODEL_PICKER_WINDOW, 4, MODEL_PICKER_WINDOW)).toEqual({ start: 0, end: MODEL_PICKER_WINDOW })
  })

  test("a longer list keeps the cursor centred, clamped at both ends", () => {
    const total = 20
    // near the top: clamped to start 0
    expect(modelPickerWindow(total, 0, 5)).toEqual({ start: 0, end: 5 })
    expect(modelPickerWindow(total, 1, 5)).toEqual({ start: 0, end: 5 })
    // middle: centred (cursor - floor(5/2))
    expect(modelPickerWindow(total, 10, 5)).toEqual({ start: 8, end: 13 })
    // near the end: clamped so the window never runs past the list
    expect(modelPickerWindow(total, 19, 5)).toEqual({ start: 15, end: 20 })
  })

  test("the window always contains the cursor", () => {
    const total = 40
    for (let c = 0; c < total; c++) {
      const { start, end } = modelPickerWindow(total, c, MODEL_PICKER_WINDOW)
      expect(c).toBeGreaterThanOrEqual(start)
      expect(c).toBeLessThan(end)
    }
  })
})

describe("specs/073 — the Ports section", () => {
  test("all 6 services are rows, regardless of agent selection", () => {
    expect(SERVICE_PORT_ROWS).toEqual(["orchestrator", "devops", "testing", "documentation", "security", "mcpHttp"])
  })

  test("movePortsCursor wraps in both directions", () => {
    let s = state({ portsCursor: SERVICE_PORT_ROWS.length - 1 })
    s = movePortsCursor(s, 1)
    expect(s.portsCursor).toBe(0)
    s = movePortsCursor(s, -1)
    expect(s.portsCursor).toBe(SERVICE_PORT_ROWS.length - 1)
  })

  test("serviceAtPortsCursor / portOverrideAtCursor follow the cursor", () => {
    const s = state({ portsCursor: 1, portOverrides: { devops: "9002" } })
    expect(serviceAtPortsCursor(s)).toBe("devops")
    expect(portOverrideAtCursor(s)).toBe("9002")
  })

  test("setPortOverrideAtCursor sets and clears (empty string removes the override)", () => {
    let s = state({ portsCursor: 1 }) // devops
    s = setPortOverrideAtCursor(s, "9002")
    expect(s.portOverrides.devops).toBe("9002")
    s = setPortOverrideAtCursor(s, "")
    expect(s.portOverrides.devops).toBeUndefined()
  })

  test("resolvedPort: no override -> default; valid override -> parsed; invalid -> null", () => {
    expect(resolvedPort(state(), "devops")).toBe(DEFAULT_SERVICE_PORTS.devops)
    expect(resolvedPort(state({ portOverrides: { devops: "9002" } }), "devops")).toBe(9002)
    expect(resolvedPort(state({ portOverrides: { devops: "0" } }), "devops")).toBeNull()
    expect(resolvedPort(state({ portOverrides: { devops: "70000" } }), "devops")).toBeNull()
    expect(resolvedPort(state({ portOverrides: { devops: "abc" } }), "devops")).toBeNull()
  })

  test("portsValidationErrors: clean when every row is default or a distinct valid override", () => {
    expect(portsValidationErrors(state())).toEqual([])
    expect(portsValidationErrors(state({ portOverrides: { devops: "9002" } }))).toEqual([])
  })

  test("portsValidationErrors: flags an out-of-range override", () => {
    const errors = portsValidationErrors(state({ portOverrides: { devops: "0" } }))
    expect(errors.some((e) => e.includes("devops"))).toBe(true)
  })

  test("portsValidationErrors: flags two services resolving to the same port", () => {
    const errors = portsValidationErrors(state({ portOverrides: { devops: "3003" } })) // collides with testing's default
    expect(errors.some((e) => e.includes("3003"))).toBe(true)
  })

  test("validate() surfaces a Ports problem under errors.ports and blocks saving", () => {
    const v = validate(state({ portOverrides: { devops: "0" } }), () => true)
    expect(v.errors.ports).toBeDefined()
    expect(v.canSave).toBe(false)
  })

  test("formStateToWizardConfig: an unedited form writes no ports at all", () => {
    const config = formStateToWizardConfig(state())
    expect(config.ports).toEqual({})
  })

  test("formStateToWizardConfig: only a validly-parsed, non-default override is carried across", () => {
    const config = formStateToWizardConfig(
      state({ portOverrides: { devops: "9002", testing: String(DEFAULT_SERVICE_PORTS.testing), security: "0" } }),
    )
    // devops genuinely differs from its default -> written.
    expect(config.ports.devops).toBe(9002)
    // testing's override equals its own default -> indistinguishable from unedited, not written.
    expect(config.ports.testing).toBeUndefined()
    // security's override is invalid -> never written (validate() would have blocked saving this state anyway).
    expect(config.ports.security).toBeUndefined()
  })

  test("formatConfigEnv writes ORCHESTRAI_<SERVICE>_PORT only for an overridden service", () => {
    const config = formStateToWizardConfig(state({ portOverrides: { devops: "9002" } }))
    const written = formatConfigEnv(config)
    expect(written).toContain("ORCHESTRAI_DEVOPS_PORT=9002")
    expect(written).not.toContain("ORCHESTRAI_ORCHESTRATOR_PORT")
    expect(written).not.toContain("ORCHESTRAI_MCP_PORT")
  })

  test("seeding: a saved port override round-trips through initialFormState", () => {
    const seeded = initialFormState("C:\\proj", AGENTS, { env: { ORCHESTRAI_DEVOPS_PORT: "9002" } })
    expect(seeded.portOverrides.devops).toBe("9002")
    expect(resolvedPort(seeded, "devops")).toBe(9002)
  })

  test("fieldScrollOffset places ports after the Models section's own real row count", () => {
    const fields = visibleFields(state())
    const modelsRowCount = 3 // e.g. header + shared + 1 selected LLM agent
    const modelsOffset = fieldScrollOffset("models", 5, fields, modelsRowCount)
    const portsOffset = fieldScrollOffset("ports", 5, fields, modelsRowCount)
    expect(portsOffset).toBe(modelsOffset + modelsRowCount + 1) // +1 blank spacer row
  })
})

// specs/125-configurable-harness-recursion-limit/spec.md — the harness-limit
// field: one shared value (ORCHESTRAI_HARNESS_RECURSION_LIMIT) applied to
// all five agent LLM harnesses' tool-call bound. Mirrors the Ports section's
// own test shape one-for-one — same raw-string/validate/resolve/write/seed
// contract, minus the per-service list.
describe("harness-limit field — specs/125", () => {
  test("resolvedHarnessLimit: unedited resolves to the default", () => {
    expect(resolvedHarnessLimit(state())).toBe(DEFAULT_HARNESS_RECURSION_LIMIT)
  })

  test("resolvedHarnessLimit: a valid override is honored exactly", () => {
    expect(resolvedHarnessLimit(state({ harnessLimitOverride: "64" }))).toBe(64)
    expect(resolvedHarnessLimit(state({ harnessLimitOverride: "20" }))).toBe(20)
  })

  test("resolvedHarnessLimit: zero, negative, non-integer, or non-numeric is invalid (null) — never silently the default", () => {
    expect(resolvedHarnessLimit(state({ harnessLimitOverride: "0" }))).toBeNull()
    expect(resolvedHarnessLimit(state({ harnessLimitOverride: "-5" }))).toBeNull()
    expect(resolvedHarnessLimit(state({ harnessLimitOverride: "3.5" }))).toBeNull()
    expect(resolvedHarnessLimit(state({ harnessLimitOverride: "abc" }))).toBeNull()
  })

  test("setHarnessLimitOverride: sets and clears the raw override", () => {
    let s = state()
    s = setHarnessLimitOverride(s, "64")
    expect(s.harnessLimitOverride).toBe("64")
    s = setHarnessLimitOverride(s, "")
    expect(s.harnessLimitOverride).toBe("")
    expect(resolvedHarnessLimit(s)).toBe(DEFAULT_HARNESS_RECURSION_LIMIT)
  })

  test("validate() surfaces an invalid override under errors.harnessLimit and blocks saving", () => {
    const v = validate(state({ harnessLimitOverride: "0" }), () => true)
    expect(v.errors.harnessLimit).toBeDefined()
    expect(v.canSave).toBe(false)
  })

  test("validate() does not flag an unedited or valid override", () => {
    expect(validate(state(), () => true).errors.harnessLimit).toBeUndefined()
    expect(validate(state({ harnessLimitOverride: "64" }), () => true).errors.harnessLimit).toBeUndefined()
  })

  test("formStateToWizardConfig: an unedited form writes no override at all", () => {
    const config = formStateToWizardConfig(state())
    expect(config.harnessRecursionLimit).toBeUndefined()
  })

  test("formStateToWizardConfig: only a validly-parsed, non-default override is carried across", () => {
    // Genuinely differs from the default -> written.
    expect(formStateToWizardConfig(state({ harnessLimitOverride: "64" })).harnessRecursionLimit).toBe(64)
    // Equals the default -> indistinguishable from unedited, not written.
    expect(formStateToWizardConfig(state({ harnessLimitOverride: String(DEFAULT_HARNESS_RECURSION_LIMIT) })).harnessRecursionLimit).toBeUndefined()
    // Invalid -> never written (validate() would have blocked saving this state anyway).
    expect(formStateToWizardConfig(state({ harnessLimitOverride: "0" })).harnessRecursionLimit).toBeUndefined()
  })

  test("formatConfigEnv writes ORCHESTRAI_HARNESS_RECURSION_LIMIT only for a non-default override", () => {
    const withOverride = formatConfigEnv(formStateToWizardConfig(state({ harnessLimitOverride: "64" })))
    expect(withOverride).toContain(`${HARNESS_RECURSION_LIMIT_ENV_VAR}=64`)

    const unedited = formatConfigEnv(formStateToWizardConfig(state()))
    expect(unedited).not.toContain(HARNESS_RECURSION_LIMIT_ENV_VAR)
  })

  test("seeding: a saved override round-trips through initialFormState", () => {
    const seeded = initialFormState("C:\\proj", AGENTS, { env: { [HARNESS_RECURSION_LIMIT_ENV_VAR]: "64" } })
    expect(seeded.harnessLimitOverride).toBe("64")
    expect(resolvedHarnessLimit(seeded)).toBe(64)
  })

  test("fieldScrollOffset places harnessLimit after the Ports section's own real (fixed) row count", () => {
    const fields = visibleFields(state())
    const modelsRowCount = 3
    const portsOffset = fieldScrollOffset("ports", 5, fields, modelsRowCount)
    const harnessLimitOffset = fieldScrollOffset("harnessLimit", 5, fields, modelsRowCount)
    // Ports' own real height: header(1) + SERVICE_PORT_ROWS.length rows, plus one blank spacer row.
    expect(harnessLimitOffset).toBe(portsOffset + 1 + SERVICE_PORT_ROWS.length + 1)
  })
})

// specs/132-init-multi-provider-keys — every registered key survives a
// save/reopen, and any Models row (including the default) can switch
// between registered providers.
describe("specs/132 — multiple registered providers", () => {
  function register(s: InitFormState, provider: LlmProvider, key: string): InitFormState {
    return registerProviderKey({ ...s, providersCursor: LLM_PROVIDERS.indexOf(provider) }, key)
  }
  function parseEnv(text: string): Record<string, string> {
    const env: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const i = line.indexOf("=")
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
    }
    return env
  }
  const threeProviders = () =>
    register(register(register(state({ llmApiKey: "" }), "gemini", "gem-key"), "openai", "oai-key"), "anthropic", "ant-key")

  test("keys no row uses are still written, one ORCHESTRAI_<PROVIDER>_API_KEY each", () => {
    const text = formatConfigEnv(formStateToWizardConfig(threeProviders()))
    expect(text).toContain("ORCHESTRAI_LLM_PROVIDER=gemini")
    expect(text).toContain("ORCHESTRAI_LLM_API_KEY=gem-key")
    expect(text).toContain(`${providerKeyVar("gemini")}=gem-key`)
    expect(text).toContain(`${providerKeyVar("openai")}=oai-key`)
    expect(text).toContain(`${providerKeyVar("anthropic")}=ant-key`)
  })

  test("reopening restores every registered provider with its own key", () => {
    const text = formatConfigEnv(formStateToWizardConfig(threeProviders()))
    const reopened = initialFormState("C:\\proj", AGENTS, { env: parseEnv(text) })
    expect([...availableProviders(reopened)].sort()).toEqual(["anthropic", "gemini", "openai"])
    expect(reopened.llmProvider).toBe("gemini")
    expect(keyForProvider(reopened, "gemini")).toBe("gem-key")
    expect(keyForProvider(reopened, "openai")).toBe("oai-key")
    expect(keyForProvider(reopened, "anthropic")).toBe("ant-key")
  })

  test("the per-provider variables are owned, so unregistering a provider removes its line", () => {
    for (const p of LLM_PROVIDERS) expect(WIZARD_OWNED_KEYS).toContain(providerKeyVar(p))
    const without = unregisterProviderKey({ ...threeProviders(), providersCursor: LLM_PROVIDERS.indexOf("openai") })
    expect(formatConfigEnv(formStateToWizardConfig(without))).not.toContain(providerKeyVar("openai"))
  })

  test("←/→ on the default row switches the default provider; keys never move between providers", () => {
    const s = { ...threeProviders(), llmModel: "gemini-3.8-flash" }
    const next = cycleSharedProvider(s, 1)
    // LLM_PROVIDERS order is anthropic, openai, gemini, so +1 from gemini wraps to anthropic.
    expect(next.llmProvider).toBe("anthropic")
    expect(next.llmApiKey).toBe("ant-key")
    expect(next.llmModel).toBe("")
    expect(keyForProvider(next, "gemini")).toBe("gem-key")
    expect(keyForProvider(next, "openai")).toBe("oai-key")
    expect(keyForProvider(next, "anthropic")).toBe("ant-key")
    expect([...availableProviders(next)].sort()).toEqual(["anthropic", "gemini", "openai"])
    expect(cycleSharedProvider(next, -1).llmProvider).toBe("gemini")
  })

  test("a row that set its own model while following the default stays on the old provider", () => {
    const base = threeProviders()
    const s = { ...base, modelOverrides: { ...base.modelOverrides, orchestrator: "gemini-3.5-pro" } }
    const next = cycleSharedProvider(s, 1)
    expect(next.providerOverrides.orchestrator).toBe("gemini")
    expect(next.providerOverrides.conversation).toBeUndefined()
    const text = formatConfigEnv(formStateToWizardConfig(next))
    expect(text).toContain("ORCHESTRAI_ORCHESTRATOR_LLM_PROVIDER=gemini")
    expect(text).toContain("ORCHESTRAI_ORCHESTRATOR_LLM_API_KEY=gem-key")
  })

  test("with a single provider there is nothing to switch — the same state is returned", () => {
    const one = register(state({ llmApiKey: "" }), "openai", "oai-key")
    expect(cycleSharedProvider(one, 1)).toBe(one)
  })

  test("cycleRowProvider switches the default on the shared row and an override on a component row", () => {
    const s = threeProviders()
    expect(cycleRowProvider({ ...s, modelsCursor: 0 }, 1).llmProvider).not.toBe("gemini")
    const onComponent = cycleRowProvider({ ...s, modelsCursor: 1 }, 1)
    expect(onComponent.llmProvider).toBe("gemini")
    expect(Object.values(onComponent.providerOverrides).length).toBe(1)
  })

  test("the default row can open the picker to switch provider even before a model list loads", () => {
    expect(canOpenRowPicker({ ...threeProviders(), modelsCursor: 0 })).toBe(true)
    const one = register(state({ llmApiKey: "" }), "openai", "oai-key")
    expect(canOpenRowPicker({ ...one, modelsCursor: 0 })).toBe(false)
  })

  test("a config from before this spec (no per-provider lines) still loads its override providers, and gains the lines on save", () => {
    const reopened = initialFormState("C:\\proj", AGENTS, {
      env: {
        ORCHESTRAI_LLM_PROVIDER: "gemini", ORCHESTRAI_LLM_API_KEY: "gem-key",
        ORCHESTRAI_CODER_LLM_PROVIDER: "openai", ORCHESTRAI_CODER_LLM_API_KEY: "oai-key",
      },
    })
    expect([...availableProviders(reopened)].sort()).toEqual(["gemini", "openai"])
    expect(formatConfigEnv(formStateToWizardConfig(reopened))).toContain(`${providerKeyVar("openai")}=oai-key`)
  })
})
