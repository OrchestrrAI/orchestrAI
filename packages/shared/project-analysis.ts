// specs/105-orchestrator-fallback-deep-analysis/spec.md
//
// The ONE implementation of specs/103's grounded, deep project analysis
// — moved here from packages/agents/devops/llm-harness.ts so DevOps and
// the Orchestrator both import it rather than maintaining two copies
// that could drift. Precedent for a packages/shared module making real
// LLM calls: packages/shared/capability-router.ts already does exactly
// this. The "per-agent independent harness copy" convention the rest of
// this codebase follows exists because each agent's own harness is
// genuinely agent-specific (different prompts, skills, tools); this
// logic is identical for every caller, so sharing it here is correct,
// not an exception to that convention.
//
// Carries its OWN self-contained copy of the generic LangGraph
// tool-calling core (HarnessState/buildReadOnlyTools/buildHarnessGraph/
// runHarness/validateJsonParams) rather than importing DevOps's —
// DevOps's own copy is still used by its four write-skill harnesses
// (dockerize/create-ci/create-gitignore/create-compose/run-command) and
// must stay untouched so those working skills are not disturbed. Every
// agent in this codebase already has its own independent copy of this
// same core; this makes packages/shared the canonical one for others to
// migrate onto later — migrating them is explicitly out of scope here.
import { Annotation, END, GraphRecursionError, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph"
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { z } from "zod"
import { callProviderWithRetry } from "./llm-model-factory"
import { getSharedStore } from "./store"

export interface McpToolCaller {
  callTool(toolName: string, args: Record<string, unknown>, taskId: string): Promise<string>
}

const MAX_RETRIES = 2

// specs/098-harness-recursion-limit-and-clean-failure/spec.md's own
// rationale applies identically here: every agent-level harness's
// graph.invoke() needs an explicit bound rather than silently relying on
// LangGraph's internal default of 25 and leaking its raw error text.
const HARNESS_RECURSION_LIMIT = 20

// ============================================================
// GRAPH STATE
// ============================================================
const HarnessState = Annotation.Root({
  ...MessagesAnnotation.spec,
  params: Annotation<Record<string, unknown> | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  attempts: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
})

type HarnessStateType = typeof HarnessState.State

// ============================================================
// READ-ONLY TOOLS
// ============================================================
// Tier 2/read-only in this repo's own tiering (CLAUDE.md). No
// write-capable MCP tool is registered here or reachable from the graph
// at all — not a policy note, a structural constraint, the same
// enforcement mechanism every other harness in this codebase uses.
// project_root is fixed in closure, never model-suppliable — only
// read_project_file's relative_path (the adaptive part) is exposed.
export const READ_ONLY_TOOL_NAMES = ["analyze_project", "git_status", "git_diff", "read_project_file"] as const

export function buildReadOnlyTools(mcpClient: McpToolCaller, taskId: string, projectRoot: string) {
  const analyzeProject = tool(
    async () => mcpClient.callTool("analyze_project", { project_path: projectRoot }, taskId),
    {
      name: "analyze_project",
      description: "Analyze the target project's directory structure and report missing DevOps files (Dockerfile, CI, .gitignore, etc).",
      schema: z.object({}),
    },
  )

  const gitStatus = tool(
    async () => mcpClient.callTool("git_status", { repo_path: projectRoot }, taskId),
    {
      name: "git_status",
      description: "Get the git status of the target project — branch, staged/unstaged/untracked files, recent log.",
      schema: z.object({}),
    },
  )

  const gitDiff = tool(
    async () => {
      const [staged, unstaged] = await Promise.all([
        mcpClient.callTool("git_diff", { repo_path: projectRoot, staged: true }, taskId),
        mcpClient.callTool("git_diff", { repo_path: projectRoot, staged: false }, taskId),
      ])
      return [staged, unstaged].filter(Boolean).join("\n")
    },
    {
      name: "git_diff",
      description: "Get the combined staged and unstaged git diff for the target project — what has changed but not yet been committed.",
      schema: z.object({}),
    },
  )

  const readProjectFile = tool(
    async ({ relative_path }: { relative_path: string }) => {
      return mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path }, taskId)
    },
    {
      name: "read_project_file",
      description:
        "Read a file's content, or list a directory's entries (pass \".\" for the project root), within the target project. relative_path is relative to the project root — never an absolute path.",
      schema: z.object({
        relative_path: z.string().describe("Path relative to the project root, e.g. \"package.json\", \"requirements.txt\", or \".\" for the root listing"),
      }),
    },
  )

  const tools = [analyzeProject, gitStatus, gitDiff, readProjectFile]
  // Belt-and-suspenders: fails loudly at build time if this function is
  // ever edited to bind something not on the allow-list above.
  for (const t of tools) {
    if (!(READ_ONLY_TOOL_NAMES as readonly string[]).includes(t.name)) {
      throw new Error(`Refusing to bind non-allow-listed tool "${t.name}" to the LLM harness`)
    }
  }
  return tools
}

// ============================================================
// VALIDATION
// ============================================================
export interface ParamsValidationResult<T> {
  ok: boolean
  params?: T
  error?: string
}

/** Strips a markdown code fence if the model wrapped its JSON in one,
 *  then parses and validates against the given schema. */
export function validateJsonParams<T>(rawText: string, schema: z.ZodType<T>): ParamsValidationResult<T> {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    return { ok: false, error: `Response is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Respond with ONLY a JSON object, no other text.` }
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    return { ok: false, error: `Response does not match the required shape: ${issues}` }
  }
  return { ok: true, params: result.data }
}

// ============================================================
// GRAPH BUILD
// ============================================================
interface BuildHarnessGraphOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  skillName: string
  projectRoot: string
  systemPrompt: string
  validate: (rawText: string) => ParamsValidationResult<Record<string, unknown>> | Promise<ParamsValidationResult<Record<string, unknown>>>
  maxRetries?: number
}

function buildHarnessGraph(options: BuildHarnessGraphOptions) {
  const { model, mcpClient, taskId, projectRoot, systemPrompt, validate } = options
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const tools = buildReadOnlyTools(mcpClient, taskId, projectRoot)

  if (typeof model.bindTools !== "function") {
    throw new Error("Configured chat model does not support tool binding (bindTools)")
  }
  const modelWithTools = model.bindTools(tools)

  // specs/055-provider-call-budgets-and-transient-error-handling/spec.md
  async function agentNode(state: HarnessStateType) {
    const response = await callProviderWithRetry(() => modelWithTools.invoke(state.messages))
    return { messages: [response] }
  }

  const toolNode = new ToolNode(tools)

  async function validateNode(state: HarnessStateType) {
    const last = state.messages[state.messages.length - 1]
    const rawText = typeof last?.content === "string" ? last.content : String(last?.content ?? "")
    const result = await validate(rawText)

    if (result.ok) {
      return { params: result.params ?? null }
    }

    const attempts = state.attempts + 1
    if (attempts > maxRetries) {
      return { params: null, attempts }
    }

    return {
      attempts,
      messages: [new HumanMessage(`Your last response was invalid: ${result.error}\nRespond again with the corrected JSON object only.`)],
    }
  }

  function afterValidate(state: HarnessStateType): "agent" | typeof END {
    const last = state.messages[state.messages.length - 1]
    const isRetryPrompt = last instanceof HumanMessage
    if (isRetryPrompt && state.attempts <= maxRetries) return "agent"
    return END
  }

  return new StateGraph(HarnessState)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addNode("validate", validateNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition, { tools: "tools", [END]: "validate" })
    .addEdge("tools", "agent")
    .addConditionalEdges("validate", afterValidate, { agent: "agent", [END]: END })
    .compile()
}

async function runHarness<T>(options: BuildHarnessGraphOptions): Promise<T | null> {
  const graph = buildHarnessGraph(options)
  try {
    const finalState = await graph.invoke(
      {
        messages: [new SystemMessage(options.systemPrompt), new HumanMessage("Begin.")],
        params: null,
        attempts: 0,
      },
      { recursionLimit: HARNESS_RECURSION_LIMIT },
    )
    return (finalState.params as T | null) ?? null
  } catch (err) {
    if (err instanceof GraphRecursionError) {
      throw new Error(
        `The ${options.skillName} harness could not converge on a proposal within ${HARNESS_RECURSION_LIMIT} tool-call rounds.`,
      )
    }
    throw err
  }
}

function jsonInstruction(shapeDescription: string): string {
  return `Respond with ONLY a single JSON object matching this shape: ${shapeDescription}. No other text, no markdown code fence.`
}

// ============================================================
// PROJECT ANALYSIS — specs/103's own schema/grounding, unchanged
// ============================================================
const ObservationSchema = z.object({
  text: z.string().min(1),
  // min(1) — an observation citing zero paths has nothing for the
  // grounding check to verify, so it's rejected as invalid shape before
  // grounding is even attempted, not silently accepted as ungrounded.
  paths: z.array(z.string()).min(1),
})
export const ProjectAnalysisParamsSchema = z.object({
  stack: z.string().min(1),
  structure: z.string().min(1),
  observations: z.array(ObservationSchema),
})
export type ProjectAnalysisObservation = z.infer<typeof ObservationSchema>
export type ProjectAnalysisParams = z.infer<typeof ProjectAnalysisParamsSchema>

/** The real grounding check: re-verifies a cited path by actually
 *  attempting to read it through the same MCP tool the harness itself
 *  used to explore — never trusting that the model read it, or that it
 *  merely looks plausible. Works uniformly for a file or a directory
 *  path, since read_project_file already supports both. A denied read
 *  (e.g. a sensitive filename) is treated as ungrounded, same as a
 *  genuinely missing path. */
async function verifyPathExists(mcpClient: McpToolCaller, taskId: string, projectRoot: string, relativePath: string): Promise<boolean> {
  try {
    await mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path: relativePath }, taskId)
    return true
  } catch {
    return false
  }
}

interface GroundingResult {
  grounded: ProjectAnalysisObservation[]
  ungroundedPaths: string[]
}

async function groundObservations(
  observations: ProjectAnalysisObservation[],
  mcpClient: McpToolCaller,
  taskId: string,
  projectRoot: string,
): Promise<GroundingResult> {
  const grounded: ProjectAnalysisObservation[] = []
  const ungroundedPaths: string[] = []
  // De-duplicates a path cited by more than one observation to one real
  // check, not one per citation.
  const existsCache = new Map<string, boolean>()

  for (const observation of observations) {
    const badPaths: string[] = []
    for (const p of observation.paths) {
      if (!existsCache.has(p)) {
        existsCache.set(p, await verifyPathExists(mcpClient, taskId, projectRoot, p))
      }
      if (!existsCache.get(p)) badPaths.push(p)
    }
    if (badPaths.length === 0) grounded.push(observation)
    else ungroundedPaths.push(...badPaths)
  }

  return { grounded, ungroundedPaths }
}

// Strengthened after live verification (specs/103) showed the original,
// purely permissive wording let a real model stop after listing
// package.json/.git/src/ and never open an actual source file, reporting
// "Node.js (JavaScript)" for a project genuinely using TypeScript/Hono.
// Grounding held (nothing fabricated) — a depth/quality gap, not a
// safety one, fixed as prompt wording only.
function buildProjectAnalysisSystemPrompt(projectRoot: string, deterministicReport: string): string {
  return [
    `You are the DevOps component of OrchestrAI, producing a real analysis of the codebase at "${projectRoot}" — an actual look at the real code, not a restatement of a presence checklist.`,
    `A deterministic scan of this project already produced the following — treat it as given context, do not spend a tool call re-deriving any of it:`,
    `---`,
    deterministicReport,
    `---`,
    `Listing a directory, or seeing a dependency named in a manifest, is NOT the same as reading the code. A manifest entry is a hint, not confirmation — before naming the real stack/framework, open and read the actual content of at least a few real source files (not just directory listings) so your claim is based on code you actually read, not a guess from file names.`,
    `Call read_project_file (and analyze_project/git_status/git_diff if genuinely useful) as many times as it takes to back every claim with real, read source content — do not stop at a directory listing when a source file is right there to read. Prefer a small number of concrete, evidence-backed observations over a long list of generic advice.`,
    `Every observation you report MUST cite at least one real path (a file or directory) that you have actually read, or that appears in the directory listing above. Do not cite a path you have not verified is real — an unverifiable citation will be rejected and you will be asked to correct it.`,
    jsonInstruction(`{ "stack": <string>, "structure": <string>, "observations": [{ "text": <string>, "paths": [<string>, ...] }, ...] }`),
  ].join("\n")
}

export interface RunProjectAnalysisHarnessOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  projectRoot: string
  /** The already-computed deterministic analyze_project tool output —
   *  handed over verbatim as prompt context so the harness never spends
   *  a tool-call round rediscovering the directory listing/manifest
   *  presence it already contains. */
  deterministicReport: string
  maxRetries?: number
}

/** Returns a grounded ProjectAnalysisParams, or null if nothing survived
 *  grounding across every attempt. Never throws for a validation/
 *  grounding failure — the caller treats null as fail-open, appending an
 *  "unavailable" note rather than failing the task, since a caller
 *  always has a complete, useful deterministic report on its own. */
export async function runProjectAnalysisHarness(options: RunProjectAnalysisHarnessOptions): Promise<ProjectAnalysisParams | null> {
  // Salvage-on-exhaustion (specs/082's own "don't discard a real finding
  // to punish one hallucinated one" precedent): every attempt's grounded
  // subset is compared against the best one seen so far, kept in this
  // closure regardless of whether that attempt as a whole passed or
  // failed — so a later, worse attempt can never erase an earlier
  // attempt's real, grounded evidence.
  let bestGrounded: ProjectAnalysisObservation[] = []
  let bestStack = ""
  let bestStructure = ""

  async function validate(rawText: string): Promise<ParamsValidationResult<Record<string, unknown>>> {
    const parsed = validateJsonParams(rawText, ProjectAnalysisParamsSchema)
    if (!parsed.ok || !parsed.params) return parsed as ParamsValidationResult<Record<string, unknown>>

    const { grounded, ungroundedPaths } = await groundObservations(parsed.params.observations, options.mcpClient, options.taskId, options.projectRoot)
    if (grounded.length > bestGrounded.length) {
      bestGrounded = grounded
      bestStack = parsed.params.stack
      bestStructure = parsed.params.structure
    }

    if (ungroundedPaths.length > 0) {
      return {
        ok: false,
        error: `These cited paths do not exist in the real project: ${ungroundedPaths.join(", ")}. Only cite a path you have actually read or that appears in the directory listing. Respond again with the corrected JSON.`,
      }
    }

    return { ok: true, params: parsed.params as unknown as Record<string, unknown> }
  }

  const result = await runHarness<ProjectAnalysisParams>({
    model: options.model,
    mcpClient: options.mcpClient,
    taskId: options.taskId,
    projectRoot: options.projectRoot,
    skillName: "analyze-project",
    systemPrompt: buildProjectAnalysisSystemPrompt(options.projectRoot, options.deterministicReport),
    validate,
    maxRetries: options.maxRetries,
  })

  if (result) return result
  if (bestGrounded.length === 0) return null
  return { stack: bestStack, structure: bestStructure, observations: bestGrounded }
}

/** Deterministic rendering of the validated, grounded structure. The
 *  model never writes the final report text directly — this is the only
 *  place that shapes it. */
export function renderCodebaseAnalysis(result: ProjectAnalysisParams): string {
  const distinctPaths = new Set(result.observations.flatMap((o) => o.paths)).size
  return [
    "=== Codebase Analysis ===",
    `Stack: ${result.stack}`,
    `Structure: ${result.structure}`,
    "Observations:",
    ...result.observations.map((o) => `• ${o.text} (${o.paths.join(", ")})`),
    `Based on ${distinctPaths} real, verified path reference(s) within this project.`,
  ].join("\n")
}

// ============================================================
// specs/106-persistence-store-and-result-cache/spec.md — cross-process,
// cross-restart reuse. This is what actually eliminates the redundant
// work: a result computed by DevOps is found here by the Orchestrator
// (or a later DevOps run, even after a restart), and vice versa.
// ============================================================
const PROJECT_ANALYSIS_CACHE_KIND = "project-analysis"
// Bumped whenever the prompt/schema changes in a way that should
// invalidate every previously-cached entry at once (specs/106's own
// schema_ver design) — e.g. the specs/103 prompt-strengthening fix
// would have warranted a bump had this cache existed at the time.
const PROJECT_ANALYSIS_SCHEMA_VER = 1
// A generous backstop — the real invalidation signal on every read is
// the git-status fingerprint re-check below (the specs/057/102
// pattern), not this TTL. A cached analysis with an unchanged
// fingerprint stays valid regardless of age; this only bounds the case
// where no fingerprint was recorded at write time.
const PROJECT_ANALYSIS_CACHE_TTL_MS = 24 * 60 * 60 * 1000
// analyze-project has no sub-target narrower than the whole project —
// unlike a hypothetical future `kind` (e.g. a per-package OSV lookup),
// there's nothing here for target_rel to distinguish, so it's a fixed
// constant rather than a caller-supplied value.
const WHOLE_PROJECT_TARGET = "."
const NO_EXTRA_INPUT = "none"

/** Read-only lookup for a stored, still-fresh analysis result — a real
 *  local database read, no LLM call, no provider cost. Returns null on
 *  any miss: no store (persistence disabled/unavailable), never
 *  computed, expired with no fingerprint to save it, or a fingerprint
 *  that no longer matches the project's real current git state (real
 *  drift since the cache was populated — never served stale). The
 *  fingerprint re-check needs a real MCP call, which is why this
 *  function — unlike a plain cache read — takes an McpToolCaller. */
export async function getCachedProjectAnalysis(
  projectRoot: string,
  mcpClient: McpToolCaller,
  taskId: string,
): Promise<ProjectAnalysisParams | null> {
  const store = getSharedStore()
  if (!store) return null

  const cached = store.getCachedResult({
    kind: PROJECT_ANALYSIS_CACHE_KIND,
    projectRoot,
    targetRel: WHOLE_PROJECT_TARGET,
    inputHash: NO_EXTRA_INPUT,
    schemaVer: PROJECT_ANALYSIS_SCHEMA_VER,
  })
  if (!cached) return null

  if (cached.gitFingerprint) {
    try {
      const freshGitStatus = await mcpClient.callTool("git_status", { repo_path: projectRoot }, taskId)
      if (freshGitStatus !== cached.gitFingerprint) return null
    } catch {
      // Cross-check call itself failed — treat exactly like a cache
      // miss, the same handling fetchProjectInspection() already uses
      // for the identical situation.
      return null
    }
  }

  try {
    return ProjectAnalysisParamsSchema.parse(JSON.parse(cached.result))
  } catch {
    // A row that somehow doesn't parse back to the current schema —
    // treat as a miss, never throw past this function's own boundary.
    return null
  }
}

/** Writes a freshly-computed result to the shared store for later
 *  reuse. A no-op (never throws) when no store is available. gitFingerprint
 *  is optional — a caller with no cheap way to obtain one (e.g. DevOps's
 *  own skill, which doesn't otherwise fetch git_status for this skill)
 *  may pass null, falling back to TTL-only validity; a caller that
 *  already has one on hand (the Orchestrator's own fetchProjectInspection(),
 *  which fetches it alongside the analysis) should pass the real value
 *  for tighter invalidation. */
export function setCachedProjectAnalysis(
  projectRoot: string,
  result: ProjectAnalysisParams,
  gitFingerprint: string | null,
  producer: string,
): void {
  const store = getSharedStore()
  if (!store) return
  store.setCachedResult({
    kind: PROJECT_ANALYSIS_CACHE_KIND,
    projectRoot,
    targetRel: WHOLE_PROJECT_TARGET,
    inputHash: NO_EXTRA_INPUT,
    schemaVer: PROJECT_ANALYSIS_SCHEMA_VER,
    result: JSON.stringify(result),
    gitFingerprint,
    ttlMs: PROJECT_ANALYSIS_CACHE_TTL_MS,
    producer,
  })
}
