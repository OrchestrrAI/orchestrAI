// specs/031-interactive-init-wizard/spec.md
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import {
  AGENT_LLM_HARNESSES,
  computeGitignoreUpdate,
  configPaths,
  findGitRepoRoot,
  findStaleLlmVariables,
  formatConfigEnv,
  mergeConfigEnv,
  parseConfigEnv,
  parseServiceSelection,
  readExistingWizardConfig,
  writeWizardConfig,
  WIZARD_CONFIG_DIRNAME,
  WIZARD_OWNED_KEYS,
} from "./init-wizard"
import { LLM_COMPONENTS } from "../../packages/shared/llm-model-factory"

// specs/034-init-wizard-services-ux/spec.md: the wizard's own validNames
// list is exactly the real agents — mcp:http/orchestrator are never
// choosable input here. Four as of specs/051 (planning-agent is deleted).
const ALL = ["devops-agent", "testing-agent", "documentation-agent", "security-agent"]

describe("parseServiceSelection", () => {
  test("empty input means all services", () => {
    expect(parseServiceSelection("", ALL)).toEqual({ ok: true, names: [] })
  })
  test('"all" (any case) means all services', () => {
    expect(parseServiceSelection("all", ALL)).toEqual({ ok: true, names: [] })
    expect(parseServiceSelection("ALL", ALL)).toEqual({ ok: true, names: [] })
  })
  test("a valid comma list of names is accepted, trimmed", () => {
    expect(parseServiceSelection(" devops-agent , testing-agent ", ALL)).toEqual({
      ok: true,
      names: ["devops-agent", "testing-agent"],
    })
  })
  test("an unknown name is rejected with a clear error", () => {
    const result = parseServiceSelection("devops-agent,bogus-agent", ALL)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("bogus-agent")
  })
  test("a comma-separated list of displayed numbers resolves by position", () => {
    expect(parseServiceSelection("1,3", ALL)).toEqual({
      ok: true,
      names: ["devops-agent", "documentation-agent"],
    })
  })
  test("a single number is accepted", () => {
    expect(parseServiceSelection("4", ALL)).toEqual({ ok: true, names: ["security-agent"] })
  })
  test("an out-of-range number is rejected with a clear error, not a crash", () => {
    const result = parseServiceSelection("0,99", ALL)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("0")
      expect(result.error).toContain("99")
    }
  })
  test("garbage input is rejected with a clear error, not a crash", () => {
    const result = parseServiceSelection("nope,3.5,-1", ALL)
    expect(result.ok).toBe(false)
  })
  test("mcp:http and orchestrator are not valid tokens (never in validNames)", () => {
    const result = parseServiceSelection("mcp:http", ALL)
    expect(result.ok).toBe(false)
  })
})

describe("formatConfigEnv / parseConfigEnv round-trip", () => {
  test("round-trips every field", () => {
    const config = {
      only: ["devops-agent", "testing-agent"],
      agentLlm: {},
      modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {},
      llmProvider: "gemini" as const,
      llmModel: "gemini-3.5-flash-lite",
      llmApiKey: "test-only-not-a-real-secret",
    }
    const formatted = formatConfigEnv(config)
    const parsed = parseConfigEnv(formatted)
    // specs/034: a non-empty selection always persists with "orchestrator"
    // appended, even though it was never offered as a choice.
    expect(parsed.ORCHESTRAI_ONLY).toBe("devops-agent,testing-agent,orchestrator")
    expect(parsed.ORCHESTRAI_LLM_PROVIDER).toBe("gemini")
    expect(parsed.ORCHESTRAI_LLM_MODEL).toBe("gemini-3.5-flash-lite")
    expect(parsed.ORCHESTRAI_LLM_API_KEY).toBe("test-only-not-a-real-secret")
  })

  // specs/051-planning-retirement-and-required-key/spec.md — llmProvider is
  // required now and always written; ORCHESTRAI_LLM_HARNESS/
  // ORCHESTRAI_ORCHESTRATOR_GRAPH are retired and never written at all.
  test("no model/key given: only the provider line is written, model/key omitted", () => {
    const formatted = formatConfigEnv({ only: [], agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {}, llmProvider: "anthropic" })
    const parsed = parseConfigEnv(formatted)
    expect(parsed.ORCHESTRAI_LLM_PROVIDER).toBe("anthropic")
    expect(parsed.ORCHESTRAI_LLM_MODEL).toBeUndefined()
    expect(parsed.ORCHESTRAI_LLM_API_KEY).toBeUndefined()
    expect(parsed.ORCHESTRAI_LLM_HARNESS).toBeUndefined()
    expect(parsed.ORCHESTRAI_ORCHESTRATOR_GRAPH).toBeUndefined()
  })

  test("empty only[] formats as an empty ORCHESTRAI_ONLY value (means 'all' on load)", () => {
    const formatted = formatConfigEnv({ only: [], agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {}, llmProvider: "anthropic" })
    expect(formatted).toContain("ORCHESTRAI_ONLY=\n")
  })

  test("orchestrator is never duplicated when already present in only[]", () => {
    const formatted = formatConfigEnv({ only: ["devops-agent", "orchestrator"], agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {}, llmProvider: "anthropic" })
    const parsed = parseConfigEnv(formatted)
    expect(parsed.ORCHESTRAI_ONLY).toBe("devops-agent,orchestrator")
  })

  test("a single-agent selection still gets orchestrator appended", () => {
    const formatted = formatConfigEnv({ only: ["security-agent"], agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {}, llmProvider: "anthropic" })
    const parsed = parseConfigEnv(formatted)
    expect(parsed.ORCHESTRAI_ONLY).toBe("security-agent,orchestrator")
  })

  // specs/125-configurable-harness-recursion-limit/spec.md — same rule as
  // ports: only a non-default value gets a line.
  test("harnessRecursionLimit absent or equal to the default writes no line", () => {
    const absent = formatConfigEnv({ only: [], agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {}, llmProvider: "anthropic" })
    expect(absent).not.toContain("ORCHESTRAI_HARNESS_RECURSION_LIMIT")

    const atDefault = formatConfigEnv({ only: [], agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {}, llmProvider: "anthropic", harnessRecursionLimit: 40 })
    expect(atDefault).not.toContain("ORCHESTRAI_HARNESS_RECURSION_LIMIT")
  })

  test("harnessRecursionLimit different from the default writes the line", () => {
    const formatted = formatConfigEnv({ only: [], agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {}, llmProvider: "anthropic", harnessRecursionLimit: 64 })
    const parsed = parseConfigEnv(formatted)
    expect(parsed.ORCHESTRAI_HARNESS_RECURSION_LIMIT).toBe("64")
  })

  test("parseConfigEnv ignores blank lines and comments", () => {
    const parsed = parseConfigEnv("# a comment\n\nKEY=value\n  \n#another\n")
    expect(parsed).toEqual({ KEY: "value" })
  })

  test("parseConfigEnv tolerates a value containing '='", () => {
    const parsed = parseConfigEnv("ORCHESTRAI_LLM_API_KEY=abc=def=123")
    expect(parsed.ORCHESTRAI_LLM_API_KEY).toBe("abc=def=123")
  })
})

describe("computeGitignoreUpdate", () => {
  test("appends the entry when the file doesn't exist yet", () => {
    const result = computeGitignoreUpdate(null, ".orchestrai")
    expect(result.needsAppend).toBe(true)
    expect(result.newContent).toBe(".orchestrai\n")
  })

  test("appends to existing content with a trailing newline first", () => {
    const result = computeGitignoreUpdate("node_modules", ".orchestrai")
    expect(result.needsAppend).toBe(true)
    expect(result.newContent).toBe("node_modules\n.orchestrai\n")
  })

  test("does not duplicate an already-covered entry", () => {
    const result = computeGitignoreUpdate("node_modules\n.orchestrai\n", ".orchestrai")
    expect(result.needsAppend).toBe(false)
    expect(result.newContent).toBe("node_modules\n.orchestrai\n")
  })

  test("recognizes a trailing-slash variant as already covered", () => {
    const result = computeGitignoreUpdate(".orchestrai/\n", ".orchestrai")
    expect(result.needsAppend).toBe(false)
  })

  test("recognizes a leading-slash variant as already covered", () => {
    const result = computeGitignoreUpdate("/.orchestrai\n", ".orchestrai")
    expect(result.needsAppend).toBe(false)
  })
})

describe("configPaths", () => {
  test("builds paths under <target>/.orchestrai/", () => {
    const paths = configPaths("C:\\my-app")
    expect(paths.dir).toBe(path.join("C:\\my-app", WIZARD_CONFIG_DIRNAME))
    expect(paths.envPath).toBe(path.join("C:\\my-app", WIZARD_CONFIG_DIRNAME, "config.env"))
    expect(paths.projectPath).toBe(path.join("C:\\my-app", WIZARD_CONFIG_DIRNAME, "orchestrai.project.txt"))
  })
})

describe("filesystem round-trip (real temp directory)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "orchestrai-wizard-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("writeWizardConfig then readExistingWizardConfig round-trips every field", () => {
    writeWizardConfig(tmpDir, {
      projectPath: tmpDir,
      only: ["devops-agent"],
      agentLlm: {},
      modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {},
      llmProvider: "anthropic",
      llmModel: undefined,
      llmApiKey: "test-only-not-a-real-secret",
    })

    const read = readExistingWizardConfig(tmpDir)
    expect(read.projectPath).toBe(tmpDir)
    // specs/034: written config.env always includes "orchestrator" for a
    // non-empty subset, verified here via a real file read, not just the
    // pure formatConfigEnv unit test above.
    expect(read.env.ORCHESTRAI_ONLY).toBe("devops-agent,orchestrator")
    expect(read.env.ORCHESTRAI_LLM_PROVIDER).toBe("anthropic")
    expect(read.env.ORCHESTRAI_LLM_API_KEY).toBe("test-only-not-a-real-secret")
    // specs/051 — retired, never written by a current wizard run.
    expect(read.env.ORCHESTRAI_LLM_HARNESS).toBeUndefined()
    expect(read.env.ORCHESTRAI_ORCHESTRATOR_GRAPH).toBeUndefined()
  })

  test("readExistingWizardConfig on a directory with no prior config returns empty, not throwing", () => {
    const read = readExistingWizardConfig(tmpDir)
    expect(read.env).toEqual({})
    expect(read.projectPath).toBeUndefined()
  })

  test("writeWizardConfig auto-gitignores .orchestrai/ when the target is a git repo", () => {
    // Simulate a git repo: a bare .git directory is enough for findGitRepoRoot.
    const gitDir = path.join(tmpDir, ".git")
    require("fs").mkdirSync(gitDir)

    writeWizardConfig(tmpDir, { projectPath: tmpDir, only: [], agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {}, llmProvider: "anthropic" as const })

    const gitignorePath = path.join(tmpDir, ".gitignore")
    const content = require("fs").readFileSync(gitignorePath, "utf8")
    expect(content).toContain(".orchestrai")
  })

  test("writeWizardConfig appends to an existing .gitignore rather than overwriting it", () => {
    const gitDir = path.join(tmpDir, ".git")
    require("fs").mkdirSync(gitDir)
    require("fs").writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules\ndist/\n")

    writeWizardConfig(tmpDir, { projectPath: tmpDir, only: [], agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {}, llmProvider: "anthropic" as const })

    const content = require("fs").readFileSync(path.join(tmpDir, ".gitignore"), "utf8")
    expect(content).toBe("node_modules\ndist/\n.orchestrai\n")
  })

  test("writeWizardConfig does not touch .gitignore when the target isn't a git repo", () => {
    writeWizardConfig(tmpDir, { projectPath: tmpDir, only: [], agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {}, llmProvider: "anthropic" as const })
    expect(require("fs").existsSync(path.join(tmpDir, ".gitignore"))).toBe(false)
  })
})

describe("findGitRepoRoot", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "orchestrai-wizard-git-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("finds a .git directory at the exact starting directory", () => {
    require("fs").mkdirSync(path.join(tmpDir, ".git"))
    expect(findGitRepoRoot(tmpDir)).toBe(path.resolve(tmpDir))
  })

  test("finds a .git directory in a parent", () => {
    require("fs").mkdirSync(path.join(tmpDir, ".git"))
    const nested = path.join(tmpDir, "a", "b")
    require("fs").mkdirSync(nested, { recursive: true })
    expect(findGitRepoRoot(nested)).toBe(path.resolve(tmpDir))
  })

  test("returns null when no .git is found", () => {
    expect(findGitRepoRoot(tmpDir)).toBeNull()
  })
})

// specs/050-init-per-agent-llm-toggles/spec.md §2. The bug these pin:
// writeWizardConfig() used to write formatConfigEnv()'s output directly,
// which builds the file from a fixed line list — so every hand-added line
// was silently deleted on the next confirmed `init` run.
describe("mergeConfigEnv — a re-run never destroys lines the wizard does not own", () => {
  // specs/051-planning-retirement-and-required-key/spec.md — this whole
  // block used to exercise ORCHESTRAI_LLM_HARNESS/ORCHESTRAI_ORCHESTRATOR_
  // GRAPH as its "owned, changing" example keys. Both left WIZARD_OWNED_KEYS
  // in that spec (deliberately preserved-not-stripped, not owned any more —
  // see the comment above WIZARD_OWNED_KEYS itself), so they no longer
  // demonstrate owned-key behavior at all. ORCHESTRAI_LLM_PROVIDER — always
  // written, unconditionally, since that same spec — replaces it here.
  const next = "ORCHESTRAI_ONLY=\nORCHESTRAI_LLM_PROVIDER=anthropic\n"

  test("no existing file returns the new content unchanged (first-run path is untouched)", () => {
    expect(mergeConfigEnv(null, next)).toBe(next)
  })

  test("a hand-added variable the wizard does not own survives — the case that motivated this", () => {
    // specs/050 Phase 3a note: per-component model vars used to be the
    // example here, and no longer are — the Models view owns them now, so
    // merge removes them when the config expresses none (which is exactly
    // how clearing a row back to "(shared)" works). What preserves a
    // hand-edited override is initialFormState() seeding it back, pinned in
    // init-form-state.test.ts's own round-trip test rather than here.
    const existing =
      "ORCHESTRAI_ONLY=\n" +
      "ORCHESTRAI_LLM_PROVIDER=openai\n" +
      "ORCHESTRAI_PLANNING_LLM_API_KEY=hand-written-not-a-real-secret\n"
    const merged = mergeConfigEnv(existing, next)
    expect(merged).toContain("ORCHESTRAI_PLANNING_LLM_API_KEY=hand-written-not-a-real-secret")
    expect(parseConfigEnv(merged).ORCHESTRAI_LLM_PROVIDER).toBe("anthropic") // owned key updated
  })

  test("an owned per-component model is removed when the config expresses none", () => {
    // The other half of the same rule: the Models view owning these is what
    // lets a cleared row genuinely delete its line instead of leaving a
    // stale override behind forever.
    const existing = `ORCHESTRAI_ONLY=\nORCHESTRAI_LLM_PROVIDER=openai\nORCHESTRAI_DEVOPS_LLM_MODEL=stale\n`
    expect(parseConfigEnv(mergeConfigEnv(existing, next)).ORCHESTRAI_DEVOPS_LLM_MODEL).toBeUndefined()
  })

  test("comments and blank lines survive verbatim", () => {
    const existing = "# my notes\n\nORCHESTRAI_ONLY=\nORCHESTRAI_LLM_PROVIDER=openai\n"
    const merged = mergeConfigEnv(existing, next)
    expect(merged).toContain("# my notes")
    expect(merged.split("\n")[0]).toBe("# my notes")
  })

  test("an unrelated variable survives", () => {
    const existing = "SOMETHING_ELSE=keep-me\nORCHESTRAI_ONLY=\nORCHESTRAI_LLM_PROVIDER=openai\n"
    expect(parseConfigEnv(mergeConfigEnv(existing, next)).SOMETHING_ELSE).toBe("keep-me")
  })

  test("owned keys keep their original position rather than being reordered", () => {
    const existing = "ORCHESTRAI_LLM_PROVIDER=openai\nUNKNOWN=x\nORCHESTRAI_ONLY=\n"
    const lines = mergeConfigEnv(existing, next).trim().split("\n")
    expect(lines).toEqual(["ORCHESTRAI_LLM_PROVIDER=anthropic", "UNKNOWN=x", "ORCHESTRAI_ONLY="])
  })

  test("an owned key that is no longer written is removed, not left stale", () => {
    // A per-agent gate key disappears once that agent is no longer part of
    // the config's own selection; a stale key left behind would keep
    // configuring a harness for a process the file no longer even mentions.
    const existing = "ORCHESTRAI_ONLY=\nORCHESTRAI_LLM_PROVIDER=openai\nORCHESTRAI_DEVOPS_LLM_HARNESS=1\n"
    expect(parseConfigEnv(mergeConfigEnv(existing, next)).ORCHESTRAI_DEVOPS_LLM_HARNESS).toBeUndefined()
  })

  test("appended keys follow the existing content directly, with no stray blank between", () => {
    // Found in a live run: the existing file's own trailing newline was
    // being kept as a blank line, then the new keys appended after it.
    const existing = "UNKNOWN=x\n"
    const lines = mergeConfigEnv(existing, next).split("\n")
    expect(lines[0]).toBe("UNKNOWN=x")
    expect(lines[1]).toBe("ORCHESTRAI_ONLY=")
  })

  test("newly written owned keys are appended when the old file had none", () => {
    const existing = "# just a comment\n"
    const merged = mergeConfigEnv(existing, next)
    expect(merged.split("\n")[0]).toBe("# just a comment")
    expect(parseConfigEnv(merged).ORCHESTRAI_LLM_PROVIDER).toBe("anthropic")
  })

  test("a duplicated owned key collapses to one, at its first position", () => {
    const existing = "ORCHESTRAI_LLM_PROVIDER=openai\nUNKNOWN=x\nORCHESTRAI_LLM_PROVIDER=openai\nORCHESTRAI_ONLY=\n"
    const lines = mergeConfigEnv(existing, next).trim().split("\n")
    expect(lines.filter((l) => l.startsWith("ORCHESTRAI_LLM_PROVIDER="))).toEqual(["ORCHESTRAI_LLM_PROVIDER=anthropic"])
    expect(lines[0]).toBe("ORCHESTRAI_LLM_PROVIDER=anthropic")
  })

  test("repeated merges are stable — no accumulating blank lines", () => {
    const once = mergeConfigEnv(next, next)
    expect(mergeConfigEnv(once, next)).toBe(once)
  })

  test("WIZARD_OWNED_KEYS covers everything formatConfigEnv can emit", () => {
    // The drift guard: if a new key is added to formatConfigEnv and not to
    // the owned list, merge would preserve a stale copy of it forever.
    const maximal = formatConfigEnv({
      only: ["devops-agent"],
      agentLlm: Object.fromEntries(AGENT_LLM_HARNESSES.map((h) => [h.field, true])),
      modelOverrides: Object.fromEntries(LLM_COMPONENTS.map((c) => [c, "m"])),
      // specs/063 — exercised maximally too, so this drift guard actually
      // proves WIZARD_OWNED_KEYS covers the provider/key override lines,
      // not just the model-override ones.
      providerOverrides: Object.fromEntries(LLM_COMPONENTS.map((c) => [c, "openai"])),
      apiKeyOverrides: Object.fromEntries(LLM_COMPONENTS.map((c) => [c, "k"])),
      llmProvider: "gemini",
      llmModel: "m",
      llmApiKey: "k",
      // specs/073 — exercised maximally too, so this drift guard also
      // proves WIZARD_OWNED_KEYS covers every port line.
      ports: { orchestrator: 4000, devops: 4002, testing: 4003, documentation: 4004, security: 4005, mcpHttp: 4006 },
      // specs/125 — exercised too, so this drift guard also proves
      // WIZARD_OWNED_KEYS covers the harness-limit line.
      harnessRecursionLimit: 64,
    })
    const emitted = maximal.trim().split("\n").map((l) => l.slice(0, l.indexOf("=")))
    for (const key of emitted) expect(WIZARD_OWNED_KEYS).toContain(key)
  })
})

describe("writeWizardConfig — preserves unknown keys on a real re-run", () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "orchestrai-merge-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("a hand-edited override is still there after a second write", () => {
    const base = { projectPath: tmpDir, only: [], agentLlm: {}, modelOverrides: {}, providerOverrides: {}, apiKeyOverrides: {}, ports: {}, llmProvider: "anthropic" as const }
    writeWizardConfig(tmpDir, base)
    const { envPath } = configPaths(tmpDir)
    const fs = require("fs")
    fs.appendFileSync(envPath, "SOME_OTHER_TOOL_VAR=keep-me\n# hand-written note\n")

    writeWizardConfig(tmpDir, { ...base, llmProvider: "gemini" })

    const after = fs.readFileSync(envPath, "utf8")
    expect(after).toContain("SOME_OTHER_TOOL_VAR=keep-me")
    expect(after).toContain("# hand-written note")
    expect(parseConfigEnv(after).ORCHESTRAI_LLM_PROVIDER).toBe("gemini")
  })
})

// specs/051-planning-retirement-and-required-key/spec.md §4 — "a config
// still containing any of these gets one explicit warning naming the
// variable and that it no longer does anything — and then starts
// normally." This is the naming half; apps/supervisor/index.ts's own
// main() is what actually prints the warnings and continues starting.
describe("findStaleLlmVariables — specs/051 §4", () => {
  test("a clean config with none of the retired variables warns about nothing", () => {
    expect(findStaleLlmVariables({ ORCHESTRAI_LLM_PROVIDER: "anthropic", ORCHESTRAI_LLM_API_KEY: "k" })).toEqual([])
  })

  test("ORCHESTRAI_LLM_HARNESS present (any value, including \"0\") is flagged", () => {
    const found = findStaleLlmVariables({ ORCHESTRAI_LLM_HARNESS: "0" })
    expect(found).toHaveLength(1)
    expect(found[0]!.variable).toBe("ORCHESTRAI_LLM_HARNESS")
    expect(found[0]!.note).toContain("Planning Agent")
  })

  test("ORCHESTRAI_ORCHESTRATOR_GRAPH present is flagged", () => {
    const found = findStaleLlmVariables({ ORCHESTRAI_ORCHESTRATOR_GRAPH: "1" })
    expect(found).toHaveLength(1)
    expect(found[0]!.variable).toBe("ORCHESTRAI_ORCHESTRATOR_GRAPH")
    expect(found[0]!.note).toContain("only plan-task planner")
  })

  test("any ORCHESTRAI_PLANNING_LLM_* variable is flagged, not just a fixed field list", () => {
    const found = findStaleLlmVariables({
      ORCHESTRAI_PLANNING_LLM_PROVIDER: "anthropic",
      ORCHESTRAI_PLANNING_LLM_API_KEY: "k",
      ORCHESTRAI_PLANNING_LLM_MODEL: "m",
    })
    expect(found.map((f) => f.variable).sort()).toEqual([
      "ORCHESTRAI_PLANNING_LLM_API_KEY",
      "ORCHESTRAI_PLANNING_LLM_MODEL",
      "ORCHESTRAI_PLANNING_LLM_PROVIDER",
    ])
  })

  test("a variable that merely contains \"planning\" elsewhere in its name is not flagged", () => {
    // The prefix match is anchored — SOME_OTHER_PLANNING_TOOL_VAR is a
    // different tool's variable, not one of ours.
    expect(findStaleLlmVariables({ SOME_OTHER_PLANNING_TOOL_VAR: "x" })).toEqual([])
  })

  test("all three kinds at once are each reported independently", () => {
    const found = findStaleLlmVariables({
      ORCHESTRAI_LLM_HARNESS: "1",
      ORCHESTRAI_ORCHESTRATOR_GRAPH: "0",
      ORCHESTRAI_PLANNING_LLM_API_KEY: "k",
    })
    expect(found).toHaveLength(3)
  })

  test("an undefined value (present as a key but unset) is not flagged", () => {
    // Matches how a real process.env can carry a key with an undefined
    // value; not meaningfully "set" from this function's own point of view.
    expect(findStaleLlmVariables({ ORCHESTRAI_LLM_HARNESS: undefined })).toEqual([])
  })
})
