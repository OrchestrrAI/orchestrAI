// specs/031-interactive-init-wizard/spec.md
//
// `orchestrai init` — an interactive prompt flow that asks for the same
// choices `bun run orchestrai`/the compiled binary already accept as
// flags/env vars (target path, which services, LLM provider/key/model,
// harness on/off), then writes them to <target>/.orchestrai/ so every
// future launch from that directory needs no flags at all.
//
// This is a convenience layer on top of the existing resolution chain
// (specs/018), not a new configuration mechanism — every value here
// already has a real, working source today (a flag, an env var, or
// disabled). Pure parsing/formatting functions are exported separately
// from the interactive orchestration so they're directly unit-testable
// without a real TTY.

import * as path from "path"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs"
// specs/048-guided-init-experience/spec.md §4 — type-only, so this doesn't
// create a real runtime circular dependency (init-form-state.ts already
// imports value exports from this file); erased at compile time.
import type { InitOutcome } from "./init-form-state"
import { LLM_COMPONENTS, type LlmComponent } from "../../packages/shared/llm-model-factory"
import { normalizePastedText } from "../../packages/shared/paste-text"
import { SERVICE_PORT_ENV_VARS, DEFAULT_SERVICE_PORTS, type ServicePortName } from "../../packages/shared/service-ports"
import { HARNESS_RECURSION_LIMIT_ENV_VAR, DEFAULT_HARNESS_RECURSION_LIMIT } from "../../packages/shared/harness-limits"

export const WIZARD_CONFIG_DIRNAME = ".orchestrai"
export const WIZARD_CONFIG_ENV_FILENAME = "config.env"
export const WIZARD_PROJECT_FILENAME = "orchestrai.project.txt"

export const LLM_PROVIDERS = ["anthropic", "openai", "gemini"] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

/** specs/050-init-per-agent-llm-toggles/spec.md — the agents that have
 *  their own opt-in LLM harness, and the exact variable each one's own
 *  `model-factory.ts` reads. Verified against that source on 2026-09-04,
 *  not assumed:
 *    packages/agents/devops/model-factory.ts:29
 *    packages/agents/documentation/model-factory.ts:29
 *    packages/agents/security/model-factory.ts:29
 *
 *  One table, used by the serializer here, the form's pure state, and both
 *  UIs — so the agent name, the field id, and the written variable cannot
 *  drift apart across three files.
 *
 *  Deliberately excludes planning-agent (deleted entirely by
 *  specs/051-planning-retirement-and-required-key/spec.md — its own
 *  harness, ORCHESTRAI_LLM_HARNESS, is dead along with it).
 *  testing-agent joined this table with specs/080-run-command-approved-
 *  execution/spec.md §3 — its first-ever harness, narrowly scoped to
 *  proposing a command for a stack detectRunner() has no fixed profile
 *  for (not "writing tests"). */
// `component` added by specs/051-planning-retirement-and-required-key —
// its startup key check needs to call readLlmModelConfig(env, component)
// for exactly the agents whose harness is on. It was one string-derivation
// (`agent.replace(/-agent$/, "")`) already duplicated at one call site
// before this; an explicit typed field is what a safety check should read,
// not something inferred from a naming convention two other files also
// have to get right independently.
// specs/077-agent-enabled-means-llm-on-by-default/spec.md — `defaultOn`
// distinguishes agents whose harness is ON unless explicitly disabled
// (`=0`) from any agent that should stay genuinely opt-in (`=1`
// required). `resolveAgentLlmKeyRequirements()` below reads this field
// directly rather than re-deriving the distinction from the agent name.
// specs/086-code-review-coder-default-on/spec.md flipped Code Review/
// Coder's own rows to `true` too — `specs/077` had deliberately left
// them `false` (no deterministic fallback at all: every task fails
// without a key, not "falls back to a template"), and that consequence
// was confirmed directly with Yusuf before this later spec flipped
// them, not assumed away. Every row in this table is now `defaultOn:
// true` — kept as an explicit field, not simplified away, so a future
// agent with a genuine reason to stay opt-in has a real place to say so.
export const AGENT_LLM_HARNESSES = [
  { agent: "devops-agent", component: "devops", field: "devopsLlm", envVar: "ORCHESTRAI_DEVOPS_LLM_HARNESS", label: "DevOps LLM", defaultOn: true },
  { agent: "documentation-agent", component: "documentation", field: "documentationLlm", envVar: "ORCHESTRAI_DOCUMENTATION_LLM_HARNESS", label: "Documentation LLM", defaultOn: true },
  { agent: "security-agent", component: "security", field: "securityLlm", envVar: "ORCHESTRAI_SECURITY_LLM_HARNESS", label: "Security LLM", defaultOn: true },
  { agent: "testing-agent", component: "testing", field: "testingLlm", envVar: "ORCHESTRAI_TESTING_LLM_HARNESS", label: "Testing LLM", defaultOn: true },
  // specs/082-code-review-agent/spec.md — review-diff has no
  // deterministic fallback at all, unlike every prior agent harness;
  // this row is what makes it reachable from guided init.
  { agent: "code-review-agent", component: "codeReview", field: "codeReviewLlm", envVar: "ORCHESTRAI_CODE_REVIEW_LLM_HARNESS", label: "Code Review LLM", defaultOn: true },
  // specs/083-coder-agent/spec.md — edit-file has no deterministic
  // fallback either; same reasoning as the row above.
  { agent: "coder-agent", component: "coder", field: "coderLlm", envVar: "ORCHESTRAI_CODER_LLM_HARNESS", label: "Coder LLM", defaultOn: true },
] as const satisfies readonly { agent: string; component: LlmComponent; field: string; envVar: string; label: string; defaultOn: boolean }[]

/** The form-state/serializer key for one agent harness — derived from the
 *  table above so adding a row is the only edit needed. */
export type AgentLlmField = (typeof AGENT_LLM_HARNESSES)[number]["field"]

/** specs/050 — the per-component model variable, built the same way
 *  packages/shared/llm-model-factory.ts's own resolveLlmVar() builds it
 *  (`ORCHESTRAI_${COMPONENT}_LLM_${FIELD}`). Written here, read there;
 *  keeping the construction identical is what makes what init writes and
 *  what each component looks for the same string. */
export function componentModelVar(component: LlmComponent): string {
  return `ORCHESTRAI_${component.toUpperCase()}_LLM_MODEL`
}

// specs/063-init-per-component-provider-and-key/spec.md — the matching
// PROVIDER/API_KEY variables, built identically to componentModelVar()
// above and to resolveLlmVar()'s own construction.
export function componentProviderVar(component: LlmComponent): string {
  return `ORCHESTRAI_${component.toUpperCase()}_LLM_PROVIDER`
}
export function componentApiKeyVar(component: LlmComponent): string {
  return `ORCHESTRAI_${component.toUpperCase()}_LLM_API_KEY`
}

// specs/132-init-multi-provider-keys/spec.md — every registered provider's
// key, kept whether or not any row uses it, so re-running init still
// knows about it. Read by init only; the runtime model factory keeps
// resolving component-override-then-shared (specs/039), unchanged.
export function providerKeyVar(provider: LlmProvider): string {
  return `ORCHESTRAI_${provider.toUpperCase()}_API_KEY`
}

export function providerKeysFromEnv(env: Record<string, string>): Partial<Record<LlmProvider, string>> {
  const keys: Partial<Record<LlmProvider, string>> = {}
  for (const provider of LLM_PROVIDERS) {
    const key = env[providerKeyVar(provider)]?.trim()
    if (key) keys[provider] = key
  }
  return keys
}

export interface WizardConfig {
  projectPath: string
  /** Empty array means "all services" — matches --only unset. */
  only: string[]
  /** specs/050 — per-agent harness gates. A key is present only when that
   *  agent is in the effective service selection: present writes `1`/`0`
   *  (matching how a boolean flag is always written when relevant, so a
   *  re-run's pre-fill is never ambiguous), absent writes no line at all
   *  rather than persisting a gate for a process that will not start. */
  agentLlm: Partial<Record<AgentLlmField, boolean>>
  /** specs/050 — per-component model overrides, the form's Models view.
   *  A component present with a non-empty value writes
   *  ORCHESTRAI_<COMPONENT>_LLM_MODEL; absent or empty writes no line, so
   *  the shared ORCHESTRAI_LLM_MODEL keeps applying — matching
   *  resolveLlmVar()'s own per-field fallback rather than materialising six
   *  copies of the same value. The classic wizard always passes `{}`: it
   *  deliberately does not ask (see this spec's Non-Goals), and anything
   *  already in the file is preserved by mergeConfigEnv(). */
  modelOverrides: Partial<Record<LlmComponent, string>>
  /** specs/063-init-per-component-provider-and-key/spec.md — per-component
   *  provider/key overrides, the Providers/Models screens. Always change
   *  together: a component present in one is present in the other, never
   *  just one alone — this is what makes "provider set, no key" (the
   *  footgun specs/050 named) structurally unreachable rather than merely
   *  validated against. Absent (the default, matching modelOverrides'
   *  own shape) writes no line, so the shared ORCHESTRAI_LLM_PROVIDER/
   *  _API_KEY keep applying. */
  providerOverrides: Partial<Record<LlmComponent, LlmProvider>>
  apiKeyOverrides: Partial<Record<LlmComponent, string>>
  /** specs/051-planning-retirement-and-required-key/spec.md — provider is
   *  no longer optional. This used to be `LlmProvider | undefined`, asked
   *  only when some now-deleted toggle was on; a provider/key is asked
   *  unconditionally now, since the Orchestrator this config always
   *  implies starting requires one to start at all. */
  llmProvider: LlmProvider
  llmModel?: string
  llmApiKey?: string
  /** specs/073-configurable-service-ports/spec.md — a service present here
   *  with a value different from its own default writes
   *  ORCHESTRAI_<SERVICE>_PORT; absent (the default state — matching
   *  modelOverrides'/providerOverrides' own shape) writes no line, so that
   *  service keeps binding its original hardcoded port. The classic wizard
   *  always passes `{}`: it deliberately does not ask (see this spec's
   *  Non-Goals), and anything already in the file is preserved by
   *  mergeConfigEnv(). */
  ports: Partial<Record<ServicePortName, number>>
  /** specs/125-configurable-harness-recursion-limit/spec.md — the shared
   *  ORCHESTRAI_HARNESS_RECURSION_LIMIT override, the TUI form's
   *  harness-limit row. Present with a value different from the default
   *  (40) writes the line; absent/undefined (the default state, matching
   *  `ports`' own shape) writes no line. The classic wizard and the
   *  browser form always pass `undefined` — neither asks. */
  harnessRecursionLimit?: number
  /** specs/132 — every registered provider's key, written as
   *  ORCHESTRAI_<PROVIDER>_API_KEY. Absent or empty writes no line. */
  providerKeys?: Partial<Record<LlmProvider, string>>
}

// ============================================================
// PURE FUNCTIONS — no I/O, directly unit-testable
// ============================================================

export type ServiceSelectionResult = { ok: true; names: string[] } | { ok: false; error: string }

/** specs/034-init-wizard-services-ux/spec.md: `validNames` here is always
 *  the 5 real agents, never `mcp:http`/`orchestrator` — those are implied,
 *  not choosable (see runInitWizardInner and formatConfigEnv below).
 *
 *  Empty input or "all" (case-insensitive) means every agent — an empty
 *  array, matching --only unset in apps/supervisor/index.ts. Otherwise
 *  each comma-separated token is resolved either as a 1-based position in
 *  `validNames` (the numbers shown in the prompt) or as an exact agent
 *  name; an out-of-range number or unknown name re-prompts with a clear
 *  error rather than crashing. */
export function parseServiceSelection(input: string, validNames: string[]): ServiceSelectionResult {
  const trimmed = input.trim()
  if (!trimmed || trimmed.toLowerCase() === "all") return { ok: true, names: [] }
  const tokens = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const names: string[] = []
  const invalid: string[] = []
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const index = Number.parseInt(token, 10)
      if (index >= 1 && index <= validNames.length) {
        names.push(validNames[index - 1]!)
        continue
      }
    } else if (validNames.includes(token)) {
      names.push(token)
      continue
    }
    invalid.push(token)
  }
  if (invalid.length > 0) {
    const choices = validNames.map((n, i) => `${i + 1}) ${n}`).join(", ")
    return { ok: false, error: `Unknown service number/name(s): ${invalid.join(", ")}. Valid: ${choices}` }
  }
  return { ok: true, names }
}

/** KEY=value lines. Deterministic key order so a re-written file diffs
 *  cleanly. Includes the API key when present — this checkpoint's
 *  resolved decision (spec 031) is to persist it for this demo-scale
 *  tool, not to withhold it.
 *
 *  specs/034-init-wizard-services-ux/spec.md: a non-empty `only` always
 *  gets "orchestrator" appended before writing, regardless of which agent
 *  subset was chosen — the wizard never lets a config it wrote produce a
 *  coordinator-less startup. An empty `only` (meaning "all services") is
 *  left as-is: apps/supervisor/index.ts already starts the orchestrator
 *  by default whenever --only/ORCHESTRAI_ONLY is unset/empty, so nothing
 *  needs to be added there. `orchestrator` is never duplicated if it's
 *  already present (e.g. a config saved by a pre-034 wizard, or a value
 *  a human hand-edited). */
export function formatConfigEnv(config: Omit<WizardConfig, "projectPath">): string {
  const lines: string[] = []
  const only = config.only.length > 0 && !config.only.includes("orchestrator") ? [...config.only, "orchestrator"] : config.only
  lines.push(`ORCHESTRAI_ONLY=${only.join(",")}`)
  // specs/050 — one line per selected agent whose harness is on.
  for (const { field, envVar } of AGENT_LLM_HARNESSES) {
    const value = config.agentLlm[field]
    if (value !== undefined) lines.push(`${envVar}=${value ? "1" : "0"}`)
  }
  // specs/051-planning-retirement-and-required-key/spec.md — always
  // written now: `llmProvider` is a required field (not `?:`) precisely
  // because every wizard-produced config needs one, unconditionally.
  lines.push(`ORCHESTRAI_LLM_PROVIDER=${config.llmProvider}`)
  if (config.llmModel) lines.push(`ORCHESTRAI_LLM_MODEL=${config.llmModel}`)
  if (config.llmApiKey) lines.push(`ORCHESTRAI_LLM_API_KEY=${config.llmApiKey}`)
  // specs/050 — refinements of the shared model above, so written after it.
  // Only non-empty values: an omitted line is what makes the shared value
  // keep applying, exactly as resolveLlmVar() resolves it.
  for (const component of LLM_COMPONENTS) {
    const model = config.modelOverrides[component]?.trim()
    if (model) lines.push(`${componentModelVar(component)}=${model}`)
  }
  // specs/063 — provider/key overrides, written after the model overrides.
  // Always together: providerOverrides/apiKeyOverrides are kept in sync by
  // every writer in init-form-state.ts (assigning or clearing one always
  // assigns or clears the other), so a present provider with no matching
  // key here would indicate a bug upstream, not a state this function
  // needs to defend against on its own.
  for (const component of LLM_COMPONENTS) {
    const provider = config.providerOverrides[component]
    const apiKey = config.apiKeyOverrides[component]?.trim()
    if (provider) lines.push(`${componentProviderVar(component)}=${provider}`)
    if (apiKey) lines.push(`${componentApiKeyVar(component)}=${apiKey}`)
  }
  // specs/132 — the registered-provider key store, in LLM_PROVIDERS order.
  for (const provider of LLM_PROVIDERS) {
    const key = config.providerKeys?.[provider]?.trim()
    if (key) lines.push(`${providerKeyVar(provider)}=${key}`)
  }
  // specs/073-configurable-service-ports/spec.md — only a service actually
  // overridden away from its own default gets a line; an untouched port
  // never appears, so a saved config that never touched Ports is
  // byte-identical to one from before this spec existed.
  for (const key of Object.keys(SERVICE_PORT_ENV_VARS) as ServicePortName[]) {
    const port = config.ports[key]
    if (port !== undefined && port !== DEFAULT_SERVICE_PORTS[key]) {
      lines.push(`${SERVICE_PORT_ENV_VARS[key]}=${port}`)
    }
  }
  // specs/125-configurable-harness-recursion-limit/spec.md — same rule as
  // ports just above: only a value different from the default gets a
  // line, so a config that never touched this field is byte-identical to
  // one written before this spec existed.
  if (config.harnessRecursionLimit !== undefined && config.harnessRecursionLimit !== DEFAULT_HARNESS_RECURSION_LIMIT) {
    lines.push(`${HARNESS_RECURSION_LIMIT_ENV_VAR}=${config.harnessRecursionLimit}`)
  }
  return lines.join("\n") + "\n"
}

/** specs/050 — every key `formatConfigEnv()` above can emit, and nothing
 *  else. This is what `mergeConfigEnv()` is allowed to replace or remove;
 *  anything outside it is someone else's line and is preserved verbatim.
 *  The per-agent vars come straight from AGENT_LLM_HARNESSES so that half
 *  cannot drift; `init-wizard.test.ts` asserts the hand-listed half stays
 *  in step with what formatConfigEnv actually writes. */
// specs/051-planning-retirement-and-required-key/spec.md — ORCHESTRAI_LLM_
// HARNESS and ORCHESTRAI_ORCHESTRATOR_GRAPH deliberately do NOT appear
// here any more (they did before this spec). Both are dead — neither is
// written or read by anything now — and the spec's own design is for a
// stale value to be *preserved untouched* (so main()'s stale-variable
// warning has something to warn about) rather than silently stripped by
// the next `init` save the way an owned-but-unwritten key would be. Same
// reasoning applies to ORCHESTRAI_PLANNING_LLM_* — it leaves this list
// automatically, since "planning" no longer appears in LLM_COMPONENTS.
export const WIZARD_OWNED_KEYS: readonly string[] = [
  "ORCHESTRAI_ONLY",
  ...AGENT_LLM_HARNESSES.map((h) => h.envVar),
  "ORCHESTRAI_LLM_PROVIDER",
  "ORCHESTRAI_LLM_MODEL",
  "ORCHESTRAI_LLM_API_KEY",
  // specs/050 — the form's Models view owns these now, so a row cleared
  // back to "(shared)" genuinely removes its line instead of leaving a
  // stale override behind. Safe only because initialFormState() seeds the
  // view from the file first: a user who never opens the Models view still
  // round-trips whatever they hand-edited, which init-form-state.test.ts
  // pins directly.
  ...LLM_COMPONENTS.map((c) => componentModelVar(c)),
  // specs/063-init-per-component-provider-and-key/spec.md — same
  // reasoning as the model-override keys just above: owned so a row
  // cleared back to "(shared)" genuinely removes its lines rather than
  // leaving a stale override behind.
  ...LLM_COMPONENTS.map((c) => componentProviderVar(c)),
  ...LLM_COMPONENTS.map((c) => componentApiKeyVar(c)),
  // specs/132 — owned so unregistering a provider genuinely removes its
  // key line. Every writer carries forward the keys it doesn't manage.
  ...LLM_PROVIDERS.map((p) => providerKeyVar(p)),
  // specs/073-configurable-service-ports/spec.md — same reasoning: owned so
  // a Ports row cleared back to "(default)" genuinely removes its line
  // rather than leaving a stale override behind.
  ...Object.values(SERVICE_PORT_ENV_VARS),
  // specs/125-configurable-harness-recursion-limit/spec.md — same
  // reasoning: owned so the harness-limit row cleared back to
  // "(default)" genuinely removes its line rather than leaving a stale
  // override behind.
  HARNESS_RECURSION_LIMIT_ENV_VAR,
]

/** specs/051-planning-retirement-and-required-key/spec.md §4 — a variable
 *  that used to configure real behavior and now configures nothing at all.
 *  These deliberately left WIZARD_OWNED_KEYS above (see its own comment):
 *  a stale value is preserved untouched across an `init` re-save rather
 *  than silently stripped, specifically so there is something left here to
 *  warn about — the spec's own Safety Constraint is "no silent behavior
 *  change on an old config," not "no leftover line." */
export interface StaleVariableWarning {
  variable: string
  note: string
}

const PLANNING_LLM_PREFIX = "ORCHESTRAI_PLANNING_LLM_"

/** Pure — takes whatever env the caller already has (process.env after a
 *  wizard config has been merged in, in `apps/supervisor/index.ts`'s own
 *  case) rather than reading anything itself, so it's directly testable
 *  and agnostic to where the value actually came from (a hand-edited file,
 *  a stale `.orchestrai/config.env`, or the shell). */
export function findStaleLlmVariables(env: Record<string, string | undefined>): StaleVariableWarning[] {
  const found: StaleVariableWarning[] = []
  if (env.ORCHESTRAI_LLM_HARNESS !== undefined) {
    found.push({
      variable: "ORCHESTRAI_LLM_HARNESS",
      note: "Planning Agent's own harness toggle — Planning Agent is deleted, so this does nothing.",
    })
  }
  if (env.ORCHESTRAI_ORCHESTRATOR_GRAPH !== undefined) {
    found.push({
      variable: "ORCHESTRAI_ORCHESTRATOR_GRAPH",
      note: "the adaptive supervisor's opt-out — it is now the only plan-task planner, so there is nothing left to opt out of.",
    })
  }
  // Object.keys() rather than a fixed list: any per-field suffix
  // (_PROVIDER/_MODEL/_API_KEY, and whatever else the shared factory might
  // ever add) is covered without this needing to know the field names.
  for (const key of Object.keys(env)) {
    if (env[key] !== undefined && key.startsWith(PLANNING_LLM_PREFIX)) {
      found.push({
        variable: key,
        note: "\"planning\" is no longer a valid LLM component — Planning Agent is deleted.",
      })
    }
  }
  return found
}

function lineKey(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  const idx = trimmed.indexOf("=")
  return idx === -1 ? null : trimmed.slice(0, idx).trim() || null
}

/** specs/050 — merges freshly formatted config over an existing file
 *  instead of replacing it.
 *
 *  The bug this fixes, found while grounding that spec and pre-existing
 *  since specs/031: `writeWizardConfig()` wrote `formatConfigEnv()`'s
 *  output directly, and that function builds the file from a fixed list of
 *  lines. Every hand-added line — a per-component override like
 *  ORCHESTRAI_DEVOPS_LLM_MODEL, a comment, an unrelated variable — was
 *  silently deleted the next time `init` was run and confirmed. Harmless
 *  while the file only ever held wizard-owned keys; a real trap now that
 *  per-component configuration is something we tell people to use.
 *
 *  Owned keys are replaced in place (keeping their original position, so a
 *  re-run diffs cleanly) or dropped when no longer written; unknown keys,
 *  comments and blank lines survive exactly as they were; newly written
 *  owned keys are appended in `formatConfigEnv()` order. A duplicate owned
 *  key in the existing file collapses to one, at the first position.
 *
 *  With no existing file this returns `next` unchanged — so the first-run
 *  path is provably identical to before this spec. */
export function mergeConfigEnv(existingContent: string | null, next: string): string {
  if (existingContent === null) return next

  const owned = new Set(WIZARD_OWNED_KEYS)
  const nextByKey = new Map<string, string>()
  for (const line of next.split(/\r?\n/)) {
    const key = lineKey(line)
    if (key) nextByKey.set(key, line.trim())
  }

  const emitted = new Set<string>()
  const merged: string[] = []
  for (const rawLine of existingContent.split(/\r?\n/)) {
    const key = lineKey(rawLine)
    if (key === null || !owned.has(key)) {
      merged.push(rawLine)
      continue
    }
    if (emitted.has(key)) continue // a duplicate of a key already written
    const replacement = nextByKey.get(key)
    if (replacement === undefined) continue // owned but no longer written
    merged.push(replacement)
    emitted.add(key)
  }

  // The existing file's own trailing newline shows up as a final empty
  // element. Drop trailing blanks BEFORE appending, not after: leaving them
  // in strands a blank line between the old content and the new keys, which
  // a live run made obvious. Repeated runs still cannot accumulate blanks.
  const trimTrailingBlanks = () => {
    while (merged.length > 0 && merged[merged.length - 1]!.trim() === "") merged.pop()
  }
  trimTrailingBlanks()

  // Anything newly written that the old file had no line for, in the same
  // order formatConfigEnv emits it.
  for (const [key, line] of nextByKey) {
    if (!emitted.has(key)) merged.push(line)
  }

  trimTrailingBlanks()
  return merged.join("\n") + "\n"
}

/** Tolerant KEY=value parser — blank lines and #-comments ignored, no
 *  quoting/escaping support (values here are always simple tokens: a
 *  comma list, "0"/"1", a provider name, a model name, or an API key —
 *  none of which legitimately contain a newline). */
export function parseConfigEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const idx = line.indexOf("=")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (!key) continue
    result[key] = line.slice(idx + 1).trim()
  }
  return result
}

/** Walks upward from startDir looking for a `.git` directory. Returns the
 *  repo root, or null if none is found before the filesystem root. */
export function findGitRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir)
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Pure: given a .gitignore's current content (or null if it doesn't
 *  exist yet) and the entry to ensure is covered, returns whether an
 *  append is needed and what the resulting content would be. Recognizes
 *  the entry already being covered as `entry`, `entry/`, or `/entry` on
 *  its own line, so re-running the wizard never duplicates the line. */
export function computeGitignoreUpdate(
  existingContent: string | null,
  entry: string,
): { needsAppend: boolean; newContent: string } {
  const content = existingContent ?? ""
  const lines = content.split(/\r?\n/).map((l) => l.trim())
  const covered = lines.some((l) => l === entry || l === `${entry}/` || l === `/${entry}`)
  if (covered) return { needsAppend: false, newContent: content }
  const base = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content
  return { needsAppend: true, newContent: `${base}${entry}\n` }
}

/** Ensures <dir>/.orchestrai/ is covered by the nearest .gitignore, if
 *  `dir` (or an ancestor) is a git repository. No-op otherwise — this
 *  wizard never initializes a git repo itself, and never overwrites an
 *  unrelated .gitignore beyond appending one line. */
export function ensureGitignored(targetDir: string): void {
  const repoRoot = findGitRepoRoot(targetDir)
  if (!repoRoot) return
  const gitignorePath = path.join(repoRoot, ".gitignore")
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : null
  const { needsAppend, newContent } = computeGitignoreUpdate(existing, WIZARD_CONFIG_DIRNAME)
  if (needsAppend) writeFileSync(gitignorePath, newContent, "utf8")
}

export function configPaths(targetDir: string): { dir: string; envPath: string; projectPath: string } {
  const dir = path.join(targetDir, WIZARD_CONFIG_DIRNAME)
  return { dir, envPath: path.join(dir, WIZARD_CONFIG_ENV_FILENAME), projectPath: path.join(dir, WIZARD_PROJECT_FILENAME) }
}

/** Reads an existing wizard-written config at `targetDir`, if any —
 *  used to pre-fill the wizard's prompts on a re-run. Never throws;
 *  an unreadable/partial config is treated as absent. */
export function readExistingWizardConfig(targetDir: string): { env: Record<string, string>; projectPath?: string } {
  const { envPath, projectPath } = configPaths(targetDir)
  let env: Record<string, string> = {}
  let existingProjectPath: string | undefined
  try {
    if (existsSync(envPath)) env = parseConfigEnv(readFileSync(envPath, "utf8"))
  } catch {
    env = {}
  }
  try {
    if (existsSync(projectPath)) existingProjectPath = readFileSync(projectPath, "utf8").trim() || undefined
  } catch {
    existingProjectPath = undefined
  }
  return { env, projectPath: existingProjectPath }
}

/** Writes both config files together, creating the directory if needed.
 *  Not atomic across the two files at the OS level, but both writes are
 *  synchronous and adjacent — the realistic partial-write window is a
 *  process crash between two fs.writeFileSync calls, which this
 *  demo-scale tool accepts rather than engineering a temp-file+rename
 *  swap for. */
export function writeWizardConfig(targetDir: string, config: WizardConfig): void {
  const { dir, envPath, projectPath } = configPaths(targetDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(projectPath, `${config.projectPath}\n`, "utf8")
  // specs/050 — merge over whatever is already there rather than replacing
  // it, so hand-added lines (per-component overrides, comments, unrelated
  // vars) survive a re-run. An unreadable existing file is treated as
  // absent, matching readExistingWizardConfig()'s own tolerance: better to
  // write a correct config than to refuse because of a damaged one.
  let existingEnv: string | null = null
  try {
    if (existsSync(envPath)) existingEnv = readFileSync(envPath, "utf8")
  } catch {
    existingEnv = null
  }
  writeFileSync(envPath, mergeConfigEnv(existingEnv, formatConfigEnv(config)), "utf8")
  ensureGitignored(targetDir)
}

// ============================================================
// INTERACTIVE I/O
// ============================================================

/** A single raw-mode line reader used for every real-terminal prompt,
 *  masked or not. Falls back to a hand-rolled buffered-line reader (see
 *  below) when stdin isn't a real TTY — a masked prompt can't suppress
 *  echo without a terminal to control anyway, and piped/redirected input
 *  has no terminal at all. Ctrl+C rejects with WizardCancelledError so
 *  the caller can abort the whole wizard, writing nothing — matching the
 *  spec's "Ctrl+C at any point writes nothing" requirement.
 *
 *  Control characters below are matched by char code, not literal source
 *  bytes — Ctrl+C (0x03) and DEL (0x7F) don't reliably survive every
 *  text-editing/transfer pipeline as raw bytes embedded in source, so
 *  code points are the robust choice regardless of how this file itself
 *  was authored. */
export class WizardCancelledError extends Error {
  constructor() {
    super("Setup cancelled — nothing was written.")
    this.name = "WizardCancelledError"
  }
}

const CTRL_C_CODE = 3
const DEL_CODE = 127
const BACKSPACE_CODE = 8

// Non-TTY fallback (piped input, CI, a scripted test run). Deliberately
// NOT node:readline/promises here — live testing found its `question()`
// hangs after the first call against Bun's piped stdin (the second
// question never resolves even though the remaining input is sitting
// right there in the pipe; reproduced with a 3-line minimal repro outside
// this codebase entirely, so it's a real runtime/module interaction, not
// a bug in this file's own logic). A hand-rolled buffered-line queue on
// top of stdin's own raw `data` events sidesteps it completely and is
// simple enough not to need a library for.
let nonTtyLineBuffer = ""
let nonTtyEnded = false
const nonTtyWaiters: Array<(line: string | null) => void> = []
let nonTtyListenerAttached = false

function ensureNonTtyListener(): void {
  if (nonTtyListenerAttached) return
  nonTtyListenerAttached = true
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    nonTtyLineBuffer += chunk
    flushNonTtyWaiters()
  })
  process.stdin.on("end", () => {
    nonTtyEnded = true
    flushNonTtyWaiters()
  })
  process.stdin.resume()
}

function flushNonTtyWaiters(): void {
  while (nonTtyWaiters.length > 0) {
    const newlineIndex = nonTtyLineBuffer.indexOf("\n")
    if (newlineIndex === -1) {
      if (!nonTtyEnded) return
      // Stream ended without a trailing newline — hand back whatever's
      // left once, then null for every waiter after that (no more input
      // will ever arrive).
      const waiter = nonTtyWaiters.shift()!
      const rest = nonTtyLineBuffer
      nonTtyLineBuffer = ""
      waiter(rest.length > 0 ? rest.replace(/\r$/, "") : null)
      continue
    }
    const line = nonTtyLineBuffer.slice(0, newlineIndex).replace(/\r$/, "")
    nonTtyLineBuffer = nonTtyLineBuffer.slice(newlineIndex + 1)
    const waiter = nonTtyWaiters.shift()!
    waiter(line)
  }
}

function readNonTtyLine(): Promise<string | null> {
  ensureNonTtyListener()
  return new Promise((resolve) => {
    nonTtyWaiters.push(resolve)
    flushNonTtyWaiters()
  })
}

// specs/048-guided-init-experience/spec.md — exported so the setup form's
// Phase 3 masked-key handoff can call this EXACT, already-live-verified
// reader rather than reimplementing masking. No change to this function
// itself — see that spec's own Safety Constraints ("the raw stdin reader is
// not modified").
// specs/059-tui-bracketed-paste-support/spec.md Phase 2 — the raw
// bracketed-paste protocol markers, confirmed present as
// bracketedPasteStart/bracketedPasteEnd constants in @opentui/core's own
// ansi.d.ts. This reader runs during renderer.suspend() with no live
// React tree mounted, so @opentui/react's usePaste() (this spec's own
// Phase 1 finding, used everywhere else) cannot reach it — this is the
// one surface that genuinely needs raw-stdin interception instead.
const BRACKETED_PASTE_START = "\x1b[200~"
const BRACKETED_PASTE_END = "\x1b[201~"
const MAX_PASTED_LINE_CHARS = 10_000

export function promptLine(query: string, options: { masked?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(query)
    const stdin = process.stdin
    if (!stdin.isTTY) {
      // No masking is possible without a real terminal to control echo
      // on — the value is simply visible in whatever piped the input.
      readNonTtyLine().then((line) => {
        process.stdout.write("\n")
        resolve(line ?? "")
      })
      return
    }

    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    let value = ""
    // Non-null while accumulating bytes between a genuine
    // BRACKETED_PASTE_START and its matching END marker — which can, for
    // a large paste, arrive split across more than one "data" event, so
    // this must persist across onData() calls, not just within one.
    let pasteBuffer: string | null = null
    let done = false

    function cleanup() {
      stdin.removeListener("data", onData)
      stdin.setRawMode(Boolean(wasRaw))
      stdin.pause()
    }

    // The exact pre-059 per-character loop, unchanged, extracted so it
    // can run both on ordinary (non-paste) input and on whatever prefix
    // of a chunk precedes a paste-start marker within the same chunk.
    function processPlainChars(str: string) {
      for (const char of str) {
        if (done) return
        const code = char.charCodeAt(0)
        if (code === CTRL_C_CODE) {
          done = true
          cleanup()
          process.stdout.write("\n")
          reject(new WizardCancelledError())
          return
        }
        if (char === "\r" || char === "\n") {
          done = true
          cleanup()
          process.stdout.write("\n")
          resolve(value)
          return
        }
        if (code === DEL_CODE || code === BACKSPACE_CODE) {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write("\b \b")
          }
          continue
        }
        value += char
        process.stdout.write(options.masked ? "*" : char)
      }
    }

    // Inserts one real pasted payload as a single atomic operation — the
    // same normalizePastedText() pure helper every other in-scope field
    // uses, single-line (a masked key is a single-line field), bounded,
    // never a silent truncation. A rejected (oversized) paste surfaces a
    // real, visible line rather than being silently dropped or partially
    // inserted.
    function insertPastedText(raw: string) {
      const normalized = normalizePastedText(raw, { singleLine: true, maxLength: MAX_PASTED_LINE_CHARS })
      if (!normalized.ok) {
        done = true
        cleanup()
        process.stdout.write("\n")
        reject(new Error(normalized.error))
        return
      }
      value += normalized.text
      process.stdout.write(options.masked ? "*".repeat(normalized.text.length) : normalized.text)
    }

    function onData(chunk: string) {
      let rest = chunk
      while (rest.length > 0 && !done) {
        if (pasteBuffer !== null) {
          const endIdx = rest.indexOf(BRACKETED_PASTE_END)
          if (endIdx === -1) {
            pasteBuffer += rest
            // Bound the ACCUMULATING buffer too, independent of the
            // final normalized length — a malformed/never-ending paste
            // stream must not grow this process's memory unboundedly
            // while waiting for an end marker that may never arrive.
            if (pasteBuffer.length > MAX_PASTED_LINE_CHARS * 2) {
              done = true
              cleanup()
              process.stdout.write("\n")
              reject(new Error(`Pasted content exceeds the maximum of ${MAX_PASTED_LINE_CHARS} characters — rejected, not truncated.`))
              return
            }
            rest = ""
            break
          }
          const pasted = pasteBuffer + rest.slice(0, endIdx)
          rest = rest.slice(endIdx + BRACKETED_PASTE_END.length)
          pasteBuffer = null
          insertPastedText(pasted)
          continue
        }

        const startIdx = rest.indexOf(BRACKETED_PASTE_START)
        if (startIdx === -1) {
          processPlainChars(rest)
          rest = ""
          break
        }
        processPlainChars(rest.slice(0, startIdx))
        if (done) return
        rest = rest.slice(startIdx + BRACKETED_PASTE_START.length)
        pasteBuffer = ""
      }
    }

    stdin.on("data", onData)
  })
}

// specs/048-guided-init-experience/spec.md — exported so the setup form
// displays the key exactly as the classic wizard does: a fixed-length mask,
// never a partial reveal (see this function's own comment below).
export function maskKey(): string {
  return "•".repeat(8) // •••••••• — fixed length, never a partial reveal
}

/** Runs the full interactive prompt sequence and, on confirmation, writes
 *  the config. Never throws WizardCancelledError past its own boundary —
 *  callers just see the process exit cleanly, matching every other
 *  Ctrl+C path in this codebase's CLI tools.
 *
 *  specs/048-guided-init-experience/spec.md §4: now returns an InitOutcome
 *  instead of void, so dispatch() can tell "wrote a config" apart from
 *  "cancelled" — the classic wizard itself never launches anything, so it
 *  only ever produces "saved" or "cancelled", never "started". */
export async function runInitWizard(targetDirDefault: string, allServiceNames: string[]): Promise<InitOutcome> {
  try {
    return await runInitWizardInner(targetDirDefault, allServiceNames)
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      console.log(err.message)
      return { outcome: "cancelled" }
    }
    throw err
  } finally {
    if (nonTtyListenerAttached) process.stdin.pause()
  }
}

async function runInitWizardInner(targetDirDefault: string, allServiceNames: string[]): Promise<InitOutcome> {
  console.log("OrchestrAI setup wizard — Ctrl+C at any point exits without changing anything.\n")

  // Pre-fill from whatever's already saved for the eventual target — but
  // we don't know the target until the first question is answered, so
  // pre-fill using targetDirDefault (almost always cwd, which is where a
  // re-run would look) and re-read once the real target is confirmed if
  // it differs.
  let existing = readExistingWizardConfig(targetDirDefault)

  const defaultPath = existing.projectPath || targetDirDefault
  let targetPath = ""
  for (;;) {
    const answer = (await promptLine(`Target project path [${defaultPath}]: `)).trim() || defaultPath
    const resolved = path.resolve(answer)
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      targetPath = resolved
      break
    }
    console.log(`"${resolved}" is not an existing directory. Try again.`)
  }
  if (targetPath !== path.resolve(targetDirDefault)) {
    existing = readExistingWizardConfig(targetPath)
  }

  // specs/034-init-wizard-services-ux/spec.md: `allServiceNames` is now
  // exactly the 5 real agents — mcp:http/orchestrator are never shown or
  // choosable here (see formatConfigEnv for how orchestrator still ends
  // up persisted). A pre-034 (or hand-edited) saved ORCHESTRAI_ONLY may
  // contain "orchestrator"/"mcp:http" — strip them from the pre-filled
  // default so a re-run never displays them as if they were a prior
  // agent choice.
  const existingOnlyNames = (existing.env.ORCHESTRAI_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "orchestrator" && s !== "mcp:http")
  const defaultOnlyDisplay = existingOnlyNames.length > 0 ? existingOnlyNames.join(",") : "all"

  console.log("\nServices to run:")
  for (const [i, name] of allServiceNames.entries()) console.log(`  ${i + 1}) ${name}`)
  let only: string[] = []
  for (;;) {
    const answer =
      (await promptLine(`Select by number (comma-separated), by name, or "all" [${defaultOnlyDisplay}]: `)).trim() ||
      defaultOnlyDisplay
    const parsed = parseServiceSelection(answer, allServiceNames)
    if (parsed.ok) {
      only = parsed.names
      break
    }
    console.log(parsed.error)
  }

  // specs/051-planning-retirement-and-required-key/spec.md — this used to
  // be two independent yes/no questions here: "Enable the LLM planning
  // harness?" (Planning Agent's own opt-in) and "Enable the adaptive
  // supervisor for plan-task?" (specs/039 Open Decision Option B, added
  // when the supervisor was still opt-in). Neither has an "off" state left
  // to ask about: Planning is deleted, and the supervisor is now the only
  // plan-task path, unconditionally, whenever the Orchestrator starts at
  // all — which a wizard-written config always implies (specs/034: a
  // non-empty selection always gets "orchestrator" appended, and an empty
  // one already means "all services" including it). So a provider/key is
  // no longer conditional on anything asked in this function — it is
  // asked unconditionally below, because the config this wizard produces
  // will always need one the moment `orchestrai` (no flags) runs it.
  //
  // specs/077-agent-enabled-means-llm-on-by-default/spec.md — the
  // per-agent y/n question specs/050 added here is gone; selecting an
  // agent IS the decision now, the exact same rule
  // formStateToWizardConfig() (specs/070, apps/supervisor/
  // init-form-state.ts) already applies to the TUI/browser forms. Every
  // selected agent with a harness writes `=1` unconditionally — never
  // asked, never a separate toggle. Any harness at all needs a
  // provider/key, so this still feeds the provider block below the same
  // way it always did.
  const agentLlm: WizardConfig["agentLlm"] = {}
  const allAgentsSelected = only.length === 0
  for (const { agent, field } of AGENT_LLM_HARNESSES) {
    if (!allAgentsSelected && !only.includes(agent)) continue
    agentLlm[field] = true
  }

  // specs/051 — unconditional, not gated behind any toggle: the config
  // this wizard writes always implies the Orchestrator starting (see the
  // comment above this section), and the Orchestrator now always needs a
  // resolvable key to start at all. Skipping this because no agent
  // harness happened to be on would produce a config that "orchestrai"
  // (no flags) immediately refuses to start.
  console.log("\nA provider key is required — the Orchestrator needs one to start (it is the only plan-task planner).")
  let llmProvider: LlmProvider
  let llmModel: string | undefined
  let llmApiKey: string | undefined

  const defaultProvider = (existing.env.ORCHESTRAI_LLM_PROVIDER as LlmProvider) || "gemini"
  for (;;) {
    const answer = ((await promptLine(`LLM provider (${LLM_PROVIDERS.join("/")}) [${defaultProvider}]: `)).trim() || defaultProvider).toLowerCase()
    if ((LLM_PROVIDERS as readonly string[]).includes(answer)) {
      llmProvider = answer as LlmProvider
      break
    }
    console.log(`Must be one of: ${LLM_PROVIDERS.join(", ")}`)
  }

  const modelRequired = llmProvider === "gemini"
  // Gemini has no moving default at the harness level (deliberate — see
  // packages/shared/llm-model-factory.ts) — an explicit model is always
  // required there. This is a wizard-level convenience only: pre-filling
  // a suggested value the user still explicitly accepts (by pressing
  // Enter) or overrides, not a silent runtime default.
  const defaultModel = existing.env.ORCHESTRAI_LLM_MODEL || (llmProvider === "gemini" ? "gemini-3.5-flash-lite" : "")
  for (;;) {
    const suffix = modelRequired ? " (required for gemini)" : " (optional — provider default if blank)"
    const answer =
      (await promptLine(`Model${suffix}${defaultModel ? ` [${defaultModel}]` : ""}: `)).trim() || defaultModel
    if (!answer && modelRequired) {
      console.log("A model is required for gemini.")
      continue
    }
    llmModel = answer || undefined
    break
  }

  const hasExistingKey = Boolean(existing.env.ORCHESTRAI_LLM_API_KEY)
  const keySuffix = hasExistingKey ? ` [${maskKey()}, Enter to keep]` : ""
  const keyAnswer = await promptLine(`API key${keySuffix}: `, { masked: true })
  llmApiKey = keyAnswer.trim() || existing.env.ORCHESTRAI_LLM_API_KEY || undefined

  const config: WizardConfig = {
    projectPath: targetPath,
    only,
    agentLlm,
    // specs/050 Non-Goals: the classic wizard deliberately does not ask for
    // per-component models. Anything already in the file survives via
    // mergeConfigEnv(), which is what makes hand-editing them safe.
    modelOverrides: {},
    // specs/063 — same reasoning: the classic wizard deliberately does not
    // ask for per-component provider/key overrides either. The TUI form
    // and browser form (which reuse formStateToWizardConfig()) are where
    // this capability actually lives.
    providerOverrides: {},
    apiKeyOverrides: {},
    llmProvider,
    llmModel,
    llmApiKey,
    // specs/073-configurable-service-ports/spec.md Non-Goals: the classic
    // wizard deliberately does not ask about ports either. Anything
    // already in the file survives via mergeConfigEnv().
    ports: {},
    // specs/132 — the classic wizard only asks for one provider, so it
    // carries forward every other registered key (they're owned lines, and
    // dropping them here would delete them), updating its own.
    providerKeys: { ...providerKeysFromEnv(existing.env), ...(llmApiKey ? { [llmProvider]: llmApiKey } : {}) },
  }

  console.log("\n=== Confirm ===")
  console.log(`Target path:          ${config.projectPath}`)
  console.log(`Services:             ${config.only.length ? config.only.join(", ") : "all"}`)
  for (const { field, label } of AGENT_LLM_HARNESSES) {
    const value = config.agentLlm[field]
    if (value !== undefined) console.log(`${`${label}:`.padEnd(22)}${value ? "enabled" : "disabled"}`)
  }
  // specs/051 — always shown now: the provider/key questions above are no
  // longer conditional on anything, so there is always a real answer here.
  console.log(`  Provider:      ${config.llmProvider}`)
  console.log(`  Model:         ${config.llmModel || "(provider default)"}`)
  console.log(`  API key:       ${config.llmApiKey ? maskKey() : "(none)"}`)
  const { envPath } = configPaths(targetPath)
  console.log(`\nThis will be saved in plaintext in: ${envPath}`)

  const confirm = ((await promptLine("Write this configuration? (y/n) [y]: ")).trim() || "y").toLowerCase()
  if (confirm !== "y" && confirm !== "yes") {
    console.log("Cancelled — nothing was written.")
    return { outcome: "cancelled" }
  }

  writeWizardConfig(targetPath, config)
  console.log(`\nSaved. Run "orchestrai" (no flags) from ${targetPath} to use this configuration.`)
  return { outcome: "saved", targetPath }
}
