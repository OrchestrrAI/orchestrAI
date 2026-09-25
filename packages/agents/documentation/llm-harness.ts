// specs/041-llm-harness-documentation/spec.md
//
// Opt-in LangGraph tool-calling harness for Documentation's two write
// skills. Disabled by default (ORCHESTRAI_DOCUMENTATION_LLM_HARNESS
// unset) — see index.ts's branch into this module. Everything in here is
// additive: computeReadmeContent()/computeApiDoc() are completely
// unaffected when this module is never invoked.
//
// Structurally mirrors Planning Agent's own (now-deleted) llm-harness.ts
// (specs/026) — same LangGraph tool-calling loop shape (decide -> call a
// tool -> observe -> decide again -> validate -> retry-with-feedback on
// invalid output -> fail closed on exhausted retries or any other
// error). One graph core, two entry points (runReadmeHarness/
// runApiDocHarness) sharing the same read-only tool and the same
// structurally-enforced allow-list, since both skills only ever need
// exploratory reads, never a write.
import { Annotation, END, GraphRecursionError, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph"
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { z } from "zod"
import { callProviderWithRetry } from "../../shared/llm-model-factory"
import { resolveHarnessRecursionLimit } from "../../shared/harness-limits"

// Structural, not the concrete class — mirrors Planning's own McpToolCaller
// exactly, so a test can pass a plain mock with no real MCP connection
// lifecycle at all.
export interface McpToolCaller {
  callTool(toolName: string, args: Record<string, unknown>, taskId: string): Promise<string>
}

/** Structurally equivalent to index.ts's own private ApiEndpoint — kept
 *  as a local, independent type rather than imported, since index.ts
 *  imports *this* module (a shared import the other way would be
 *  circular). TypeScript's structural typing makes this safe: any object
 *  with this shape satisfies both. */
export interface ApiEndpoint {
  method: string
  route: string
  description: string
}

const MAX_RETRIES = 2
const MIN_CONTENT_LENGTH = 20

// specs/098-harness-recursion-limit-and-clean-failure/spec.md — see
// packages/agents/coder/llm-harness.ts's own identical comment for the
// full rationale: every agent-level harness's graph.invoke() previously
// had no explicit recursionLimit, silently relying on LangGraph's own
// internal default of 25 and leaking its raw internal error text
// straight to the end user on exhaustion.
// specs/125 — now resolves through the shared resolveHarnessRecursionLimit()
// (ORCHESTRAI_HARNESS_RECURSION_LIMIT, default 40, never throws).
const HARNESS_RECURSION_LIMIT = resolveHarnessRecursionLimit()

// ============================================================
// GRAPH STATE (shared by both entry points)
// ============================================================
const HarnessState = Annotation.Root({
  ...MessagesAnnotation.spec,
  content: Annotation<string | null>({
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
// READ-ONLY TOOLS (shared by both entry points)
// ============================================================
// Tier 2/read-only in this repo's own tiering (CLAUDE.md). No
// write-capable MCP tool (write_project_file) is registered here or
// reachable from either graph at all — not a policy note, a structural
// constraint. See specs/026's own precedent, the same shape reused
// here. `project_root` is fixed in closure, never a model-suppliable
// parameter — only `relative_path` (the actually adaptive part) is
// exposed to the model, so it can explore within the target project but
// never redirect the read elsewhere.
// specs/101-per-agent-tool-access-expansion/spec.md — analyze_project/
// git_status/git_diff added to the uniform general-inspection set every
// code-reasoning agent's harness now binds, so generate-readme/
// document-api can ground content in real project structure and state.
export const READ_ONLY_TOOL_NAMES = ["read_project_file", "analyze_project", "git_status", "git_diff"] as const

export function buildReadOnlyTools(mcpClient: McpToolCaller, taskId: string, projectRoot: string) {
  const readProjectFile = tool(
    async ({ relative_path }: { relative_path: string }) => {
      return mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path }, taskId)
    },
    {
      name: "read_project_file",
      description:
        "Read a file's content, or list a directory's entries (pass \".\" for the project root), within the target project. relative_path is relative to the project root — never an absolute path.",
      schema: z.object({
        relative_path: z.string().describe("Path relative to the project root, e.g. \"package.json\", \"src\", or \".\" for the root listing"),
      }),
    },
  )

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

  const tools = [readProjectFile, analyzeProject, gitStatus, gitDiff]
  // Belt-and-suspenders: fails loudly at build time if this function is
  // ever edited to bind something not on the allow-list above, rather
  // than relying solely on a test to catch it later.
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
export interface ContentValidationResult {
  ok: boolean
  content?: string
  error?: string
}

/** Shared by both entry points: catches only the degenerate case (empty,
 *  whitespace-only, or absurdly short) — this checkpoint deliberately does
 *  not validate markdown structure or factual accuracy; the human
 *  approval step is the real quality gate (see spec's Out of Scope). */
function validateNonTrivial(rawText: string): ContentValidationResult {
  const trimmed = rawText.trim()
  if (trimmed.length < MIN_CONTENT_LENGTH) {
    return { ok: false, error: `Response is empty or too short (${trimmed.length} chars) to be real documentation. Respond with the full content, not a placeholder.` }
  }
  return { ok: true, content: trimmed }
}

/** document-api only: on top of the non-trivial check above, confirms the
 *  response actually covers every route scanApiRoutes() already found —
 *  a simple presence check on each route's path string, not semantic
 *  understanding. This is NOT a "did the model find the right routes"
 *  check (it's never asked to find routes at all, only to write about
 *  ones it's handed) — it only catches a response that drifts off-topic
 *  or drops a route entirely. */
export function validateApiDocOutput(rawText: string, routes: ApiEndpoint[]): ContentValidationResult {
  const base = validateNonTrivial(rawText)
  if (!base.ok) return base

  const missing = routes.filter((r) => !base.content!.includes(r.route))
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Your response is missing coverage of these routes: ${missing.map((r) => `${r.method} ${r.route}`).join(", ")}. Every route in the list must be documented — do not omit any.`,
    }
  }
  return base
}

// ============================================================
// SYSTEM PROMPTS
// ============================================================
function buildReadmeSystemPrompt(projectRoot: string, existingReadme: string | undefined): string {
  const existingBlock = existingReadme
    ? [
        ``,
        `An existing README.md is already present. Preserve or build on sections that are still accurate — especially anything that reads as manually written rather than auto-generated boilerplate. Update what's stale, fill in what's missing. This should be a thoughtful revision, not a wholesale unrelated rewrite. Existing content:`,
        `---`,
        existingReadme,
        `---`,
      ].join("\n")
    : ""

  return [
    `You are the documentation component of OrchestrAI. Write a real, useful README.md for the project at "${projectRoot}".`,
    `You may call read_project_file to inspect the real project (package.json, source files, directory listings) as many or as few times as you need before writing.`,
    existingBlock,
    ``,
    `Respond with ONLY the final README.md content in markdown — no preamble, no commentary, no code fences wrapping the whole thing.`,
  ].join("\n")
}

function buildApiDocSystemPrompt(targetPath: string, routes: ApiEndpoint[]): string {
  const routeList = routes
    .map((r) => `- ${r.method} ${r.route}${r.description !== "No description provided." ? ` — ${r.description}` : ""}`)
    .join("\n")

  return [
    `You are the documentation component of OrchestrAI. Write API reference documentation for the file at "${targetPath}".`,
    `The following routes were already found in this file by a separate, deterministic scan — this is the complete and authoritative list. Do not add routes beyond this list, and do not omit any of them:`,
    routeList,
    ``,
    `You may call read_project_file to read this file (and any other file you think is relevant — imports, related modules) as many or as few times as you need before writing.`,
    `Respond with ONLY the final API reference markdown — no preamble, no commentary, no code fences wrapping the whole thing.`,
  ].join("\n")
}

// ============================================================
// GRAPH BUILD (shared core, parameterized by system prompt + validator)
// ============================================================
interface BuildHarnessGraphOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  projectRoot: string
  systemPrompt: string
  validate: (rawText: string) => ContentValidationResult
  maxRetries?: number
  /** specs/098 — named in the recursion-limit failure message. */
  skillName: string
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
  // — retries a transient provider failure (rate limit, timeout, 5xx)
  // with bounded backoff; a terminal failure re-throws immediately,
  // unchanged from before this spec.
  async function agentNode(state: HarnessStateType) {
    const response = await callProviderWithRetry(() => modelWithTools.invoke(state.messages))
    return { messages: [response] }
  }

  const toolNode = new ToolNode(tools)

  function validateNode(state: HarnessStateType) {
    const last = state.messages[state.messages.length - 1]
    const rawText = typeof last?.content === "string" ? last.content : String(last?.content ?? "")
    const result = validate(rawText)

    if (result.ok) {
      return { content: result.content ?? null }
    }

    const attempts = state.attempts + 1
    if (attempts > maxRetries) {
      // Exhausted retries — fail closed, never a guessed/partial doc.
      return { content: null, attempts }
    }

    return {
      attempts,
      messages: [new HumanMessage(`Your last response was invalid: ${result.error}\nRespond again with the corrected content.`)],
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

async function runHarness(options: BuildHarnessGraphOptions): Promise<string | null> {
  const graph = buildHarnessGraph(options)
  try {
    const finalState = await graph.invoke(
      {
        messages: [new SystemMessage(options.systemPrompt), new HumanMessage("Begin.")],
        content: null,
        attempts: 0,
      },
      { recursionLimit: HARNESS_RECURSION_LIMIT },
    )
    return finalState.content ?? null
  } catch (err) {
    if (err instanceof GraphRecursionError) {
      throw new Error(
        `The ${options.skillName} harness could not converge on a document within ${HARNESS_RECURSION_LIMIT} tool-call rounds.`,
      )
    }
    throw err
  }
}

// ============================================================
// ENTRY POINTS
// ============================================================
export interface RunReadmeHarnessOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  projectRoot: string
  /** specs/041 — the exact previousContent value specs/040 already
   *  fetches for the diff preview, reused here rather than refetched.
   *  Undefined when no prior README exists. */
  existingReadme?: string
  maxRetries?: number
}

/** Returns the same string shape computeReadmeContent() already returns
 *  — either real markdown content or null. Never throws for a
 *  validation/model failure; the caller treats null as fail-closed (see
 *  index.ts). */
export async function runReadmeHarness(options: RunReadmeHarnessOptions): Promise<string | null> {
  return runHarness({
    model: options.model,
    mcpClient: options.mcpClient,
    taskId: options.taskId,
    projectRoot: options.projectRoot,
    skillName: "generate-readme",
    systemPrompt: buildReadmeSystemPrompt(options.projectRoot, options.existingReadme),
    validate: validateNonTrivial,
    maxRetries: options.maxRetries,
  })
}

// ============================================================
// specs/100-document-api-grounded-llm-route-discovery-fallback/spec.md
// ============================================================
// Only ever reached when scanApiRoutes() found zero routes AND the
// harness is already confirmed configured — see index.ts's
// computeApiDocOrHarness(). Deliberately NOT a redesign of route
// discovery: scanApiRoutes() stays the first and only path for the
// common JS/TS/Express/Hono case, unchanged. This exists only for the
// syntax that regex was never built to recognize (PHP, Python, etc.).
export interface DiscoveredRoute {
  method: string
  route: string
}

const DiscoveredRoutesSchema = z.object({
  routes: z.array(
    z.object({
      method: z.string().min(1),
      route: z.string().min(1),
    }),
  ),
})

/** Same markdown-fence-tolerant JSON parse DevOps's own
 *  validateJsonParams() uses (packages/agents/devops/llm-harness.ts) —
 *  kept as an independent copy here rather than a shared import, matching
 *  this codebase's established per-agent-independent-copy convention. */
function parseDiscoveredRoutesResponse(rawText: string): { ok: true; routes: DiscoveredRoute[] } | { ok: false; error: string } {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    return { ok: false, error: `Response is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Respond with ONLY a JSON object, no other text.` }
  }

  const result = DiscoveredRoutesSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    return { ok: false, error: `Response does not match the required shape: ${issues}` }
  }
  return { ok: true, routes: result.data.routes }
}

function buildRouteDiscoverySystemPrompt(targetPath: string, content: string): string {
  return [
    `You are the documentation component of OrchestrAI. A deterministic scan found zero JavaScript/TypeScript Express/Hono-style route registrations (app.get/post/put/delete) in the file at "${targetPath}" — but it may still contain real route registrations written in a different language or framework (e.g. PHP Laravel's Route::get('/x', ...), Slim's $app->get('/x', ...), Python Flask's @app.route("/x"), FastAPI's @app.get("/x"), or any other web framework's own routing syntax).`,
    `Here is the real, complete file content:`,
    `---`,
    content,
    `---`,
    `Identify every real route registration you can find in this file, in whatever language/framework it is actually written in. Every route path you report MUST occur verbatim, as an exact literal substring, somewhere in the file content shown above — never a normalized, inferred, or guessed path. If the file genuinely has no route registrations at all, report an empty list.`,
    `You may also call read_project_file (e.g. to check an imported or related file) if that genuinely helps, but the file content shown above is usually already everything you need — no need to re-read this same file.`,
    `Respond with ONLY a single JSON object matching this shape: { "routes": [{ "method": <string, e.g. "GET">, "route": <string, must appear verbatim in the file content above> }, ...] }. No other text, no markdown code fence.`,
  ].join("\n")
}

export interface RunApiDocRouteDiscoveryHarnessOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  targetPath: string
  /** Same targetDir/projectRoot split runApiDocHarness() already uses. */
  targetDir: string
  /** The already-read real file content (from resolveAndScanApiTarget()'s
   *  own existing read) — handed directly to the model so no extra
   *  read_project_file round trip is needed for the common case. */
  content: string
  maxRetries?: number
}

/** Returns a grounded ApiEndpoint[] — always, never throws, never null.
 *  Every returned route's `route` string is a literal substring of the
 *  real file content. An ungrounded proposal triggers retry-with-feedback
 *  (validate()'s closure over bestGrounded below); on exhausted retries,
 *  the largest fully-grounded subset seen across any attempt is salvaged
 *  (specs/082's own "don't discard a real finding to punish one
 *  hallucinated one" precedent) — with zero grounded routes ever
 *  produced, this degrades to an empty array, which flows into the exact
 *  same "no routes found" shape scanApiRoutes() itself already produces
 *  for a genuinely route-free file. */
export async function runApiDocRouteDiscoveryHarness(options: RunApiDocRouteDiscoveryHarnessOptions): Promise<ApiEndpoint[]> {
  let bestGrounded: DiscoveredRoute[] = []

  function validate(rawText: string): ContentValidationResult {
    const parsed = parseDiscoveredRoutesResponse(rawText)
    if (!parsed.ok) return { ok: false, error: parsed.error }

    const grounded = parsed.routes.filter((r) => options.content.includes(r.route))
    const ungrounded = parsed.routes.filter((r) => !options.content.includes(r.route))
    if (grounded.length > bestGrounded.length) bestGrounded = grounded

    if (ungrounded.length > 0) {
      return {
        ok: false,
        error: `These proposed routes do not appear verbatim in the file content: ${ungrounded.map((r) => `${r.method} ${r.route}`).join(", ")}. Only include a route whose exact path string is present in the file text shown to you. Respond again with the corrected JSON.`,
      }
    }

    return { ok: true, content: JSON.stringify(grounded) }
  }

  const finalJson = await runHarness({
    model: options.model,
    mcpClient: options.mcpClient,
    taskId: options.taskId,
    projectRoot: options.targetDir,
    skillName: "document-api-route-discovery",
    systemPrompt: buildRouteDiscoverySystemPrompt(options.targetPath, options.content),
    validate,
    maxRetries: options.maxRetries,
  })

  const finalRoutes: DiscoveredRoute[] = finalJson ? (JSON.parse(finalJson) as DiscoveredRoute[]) : bestGrounded

  return finalRoutes.map((r) => ({
    method: r.method.toUpperCase(),
    route: r.route,
    description: "No description provided.",
  }))
}

export interface RunApiDocHarnessOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  /** The already-resolved target file's own directory — read_project_file
   *  calls are rooted here, matching computeApiDoc()'s existing
   *  targetDir/targetName split. */
  targetDir: string
  targetPath: string
  /** specs/041 — scanApiRoutes()'s own, unchanged output. The sole source
   *  of which routes exist; the model only ever writes about these. */
  routes: ApiEndpoint[]
  maxRetries?: number
}

export async function runApiDocHarness(options: RunApiDocHarnessOptions): Promise<string | null> {
  return runHarness({
    model: options.model,
    mcpClient: options.mcpClient,
    taskId: options.taskId,
    projectRoot: options.targetDir,
    skillName: "document-api",
    systemPrompt: buildApiDocSystemPrompt(options.targetPath, options.routes),
    validate: (rawText) => validateApiDocOutput(rawText, options.routes),
    maxRetries: options.maxRetries,
  })
}
