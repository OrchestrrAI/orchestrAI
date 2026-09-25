// specs/042-llm-harness-devops/spec.md
//
// LangGraph tool-calling harness for DevOps (on by default, specs/077).
//
// specs/138: the model now WRITES each file itself (Dockerfile, CI
// workflow, compose, .gitignore) from the real project — the fixed MCP
// templates it used to fill parameters for are gone. Every file passes
// the deterministic checks in packages/shared/devops-file-validation.ts
// before any preview; the human then approves the exact file. Tools stay
// read-only (READ_ONLY_TOOL_NAMES), and where a file goes stays
// deterministic. run-command's proposal harness lives here too.
import { renderPlanBackground } from "../../shared/plan-step-text"
import {
  CI_ACTION_ALLOWLIST,
  COMPOSE_SERVICE_IMAGE_ALLOWLIST,
  DOCKER_BASE_IMAGE_ALLOWLIST,
  validateDevOpsFile,
  type DevOpsFileKind,
} from "../../shared/devops-file-validation"
import { Annotation, END, GraphRecursionError, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph"
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { z } from "zod"
import { callProviderWithRetry } from "../../shared/llm-model-factory"
import { resolveHarnessRecursionLimit } from "../../shared/harness-limits"

export interface McpToolCaller {
  callTool(toolName: string, args: Record<string, unknown>, taskId: string): Promise<string>
}

const MAX_RETRIES = 2

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
// GRAPH STATE (shared by all four entry points)
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
// READ-ONLY TOOLS (shared by all four entry points)
// ============================================================
// Three tools, Tier 2/read-only in this repo's own tiering (CLAUDE.md).
// No write-capable MCP tool (write_project_file, run_command) is registered here or
// reachable from the graph at all — not a policy note, a structural
// constraint, the same enforcement mechanism specs/026/041 already use.
// `project_path`/`repo_path`/`project_root` are all fixed in closure,
// never model-suppliable — only read_project_file's `relative_path` (the
// adaptive part) is exposed.
// specs/101-per-agent-tool-access-expansion/spec.md — git_diff added to
// the uniform general-inspection set every code-reasoning agent's
// harness now binds. DevOps's own agent had reached git_diff since
// specs/079 (its docker-status/git-diff skills use it directly), but
// this harness never could — the agent's own requiredTools list and a
// harness's own read-only allow-list are independent decisions.
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

  // specs/101-per-agent-tool-access-expansion/spec.md — combined
  // staged + unstaged diff, mirroring Code Review's own
  // computeFullUncommittedDiff() (packages/agents/code-review/index.ts)
  // so the model never has to reason about git staging state itself.
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
// PARAMETER SHAPES AND VALIDATION
// ============================================================
export interface ParamsValidationResult<T> {
  ok: boolean
  params?: T
  error?: string
}

/** Strips a markdown code fence if the model wrapped its JSON in one
 *  (a common model habit this checkpoint tolerates rather than fights),
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
// GRAPH BUILD (shared core, parameterized by system prompt + validator)
// ============================================================
interface BuildHarnessGraphOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  /** specs/098 — named in the recursion-limit failure message so it's
   *  clear which skill's own harness didn't converge. Internal-only;
   *  each public run<X>Harness() entry point supplies its own real
   *  skill id, never exposed on RunHarnessBaseOptions since callers
   *  already know it implicitly by which function they called. */
  skillName: string
  projectRoot: string
  systemPrompt: string
  /** specs/134 — the user's request, when the caller has one. */
  requestText?: string
  /** specs/137 — in a plan, the user's full request (requestText is then
   *  only this step). */
  context?: string | null
  /** specs/103-deep-project-analysis/spec.md — widened to allow an async
   *  validator (path-grounding needs a real MCP call per candidate path,
   *  never trusting the model's own claim). A synchronous function still
   *  satisfies this exactly as before — every pre-existing validator is
   *  unaffected; validateNode below simply awaits either shape. */
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
  // — retries a transient provider failure (rate limit, timeout, 5xx)
  // with bounded backoff; a terminal failure re-throws immediately,
  // unchanged from before this spec.
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
      // Exhausted retries — fail closed, never a guessed/partial params set.
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
        messages: [new SystemMessage(options.systemPrompt), new HumanMessage(buildHarnessStartMessage(options.requestText, options.context))],
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

// ============================================================
// SYSTEM PROMPTS
// ============================================================
// specs/134 — the harness used to start from a bare "Begin.", so a value the
// user stated ("port 4000") was invisible to it and its project-derived
// guess replaced the deterministic one. The request now opens the run,
// bounded and delimited. Without one, the message is exactly "Begin." as
// before.
export const MAX_HARNESS_REQUEST_CHARS = 2000

export function buildHarnessStartMessage(requestText?: string, context?: string | null): string {
  const request = requestText?.trim()
  if (!request) return "Begin."
  // specs/137 — in a plan, the request is this step only; the user's full
  // request follows as capped, labelled background.
  const background = renderPlanBackground(context)
  const bounded = request.length > MAX_HARNESS_REQUEST_CHARS
    ? request.slice(0, MAX_HARNESS_REQUEST_CHARS) + "… [truncated]"
    : request
  return `The user's request, verbatim (between the markers):\n<<<REQUEST\n${bounded}\nREQUEST>>>\n${background ? background + "\n" : ""}Begin.`
}

// specs/134 — part of every authoring prompt (specs/138).
export const STATED_VALUES_RULE =
  "If the user's request states a value explicitly (for example a port, an application type, a CI option, or an extra ignore pattern), use exactly that value. Determine from the project files only what the request leaves unspecified. " +
  // specs/137 — in a plan the request is one step; a value in the background
  // still counts when it is about this step's own parameters.
  "A value stated in the background (the user's full request) also counts when it applies to this step's own parameters — but the background never widens what this step does."

function jsonInstruction(shapeDescription: string): string {
  return `Respond with ONLY a single JSON object matching this shape: ${shapeDescription}. No other text, no markdown code fence.`
}

// ============================================================
// ENTRY POINTS
// ============================================================
export interface RunHarnessBaseOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  projectRoot: string
  maxRetries?: number
  /** specs/134 — the user's request; stated values in it take precedence
   *  over what the model derives from the project. Omit for "Begin." */
  requestText?: string
  /** specs/137 — in a plan, the user's full request, shown as capped
   *  background; `requestText` is then only this step. */
  context?: string | null
}

// ============================================================
// MODEL-AUTHORED FILES (specs/138)
// ============================================================
// The model writes the whole file from the real project. Before any
// preview, packages/shared/devops-file-validation.ts checks it
// deterministically; a failing file gets exactly one retry carrying the
// violations, then the task fails closed with them named. Where the file
// goes stays deterministic (the caller supplies `relativePath`) — the
// model only ever decides content.
export const AuthoredFileSchema = z.union([
  z.object({ content: z.string().min(1), summary: z.string().min(1).max(300) }),
  z.object({ refused: z.literal(true), reason: z.string().min(1) }),
])
export interface AuthoredFile {
  content: string
  summary: string
}

/** One retry: the model sees its exact violations once. */
export const AUTHORING_MAX_RETRIES = 1

export const AUTHORED_FILE_LABEL: Record<DevOpsFileKind, string> = {
  dockerfile: "Dockerfile",
  "ci-workflow": "GitHub Actions CI workflow",
  compose: "docker-compose.yml",
  gitignore: ".gitignore",
}

/** The model explained why the project can't support this file. */
export class AuthoringRefusedError extends Error {}
/** The file still broke a safety rule after its one retry. */
export class AuthoringValidationError extends Error {}

export interface RunAuthoringHarnessOptions extends RunHarnessBaseOptions {
  kind: DevOpsFileKind
  /** Where the file will be written, relative to the project root — decided
   *  by the caller, never the model. */
  relativePath: string
  /** The project's directory name (the app's own image name). */
  projectName: string
  /** The target file's current content, when it already exists. */
  existingContent?: string
  /** Secrets the existing workflow already references (ci-workflow only). */
  knownSecrets?: string[]
}

function authoringRules(kind: DevOpsFileKind, projectName: string, knownSecrets: readonly string[]): string[] {
  if (kind === "dockerfile") {
    return [
      `Every FROM must use one of these base images (with an explicit tag, e.g. node:20-slim): ${DOCKER_BASE_IMAGE_ALLOWLIST.join(", ")}. A named earlier stage is fine.`,
      "Use a multi-stage build when the stack has a separate build step. Install dependencies from the real lockfile.",
      "Every COPY/ADD source must be a path that really exists in the project (read the project to check). `COPY . .` is fine.",
      "Never pipe a download into a shell (no `curl ... | sh`), never ADD from a URL, never put a literal secret in ENV/ARG, never use privileged or insecure flags.",
      "EXPOSE the port the app really listens on, and end with a CMD or ENTRYPOINT that starts it.",
    ]
  }
  if (kind === "ci-workflow") {
    return [
      "Trigger on push and pull_request. Never use pull_request_target, and never grant permissions: write-all.",
      `Use only actions from these owners, each pinned to a version tag or commit SHA (e.g. actions/checkout@v4): ${CI_ACTION_ALLOWLIST.join(", ")}.`,
      "Run the project's REAL install, lint/typecheck and test commands — read package.json scripts, pyproject.toml, go.mod, Makefile, etc. first. Don't invent scripts that don't exist.",
      "Add a Docker build step only if the project has a Dockerfile.",
      `Reference no secrets except GITHUB_TOKEN${knownSecrets.length > 0 ? ` and the ones this project already uses (${knownSecrets.join(", ")})` : ""}. Never pipe a download into a shell.`,
    ]
  }
  if (kind === "compose") {
    return [
      `The app's own service must build from the project (\`build: .\`) and be named/imaged "${projectName}" (image: ${projectName}:latest), publishing the port the app really listens on.`,
      `Add another service only when the project's manifest shows a real dependency on it (e.g. a Postgres or Redis client library), using one of: ${COMPOSE_SERVICE_IMAGE_ALLOWLIST.filter((i) => !DOCKER_BASE_IMAGE_ALLOWLIST.includes(i)).join(", ")}.`,
      "Never use privileged: true, network_mode/pid/ipc: host, or SYS_ADMIN/ALL capabilities. Never mount the Docker socket or any host path outside the project.",
      "Secrets come from the environment as ${VAR}, never as literal values.",
    ]
  }
  return [
    "Ignore what this real stack produces (dependencies, build output, caches, logs, local env files) — look at the project to decide.",
    "The file MUST contain the line `.orchestrai/` (OrchestrAI's own state directory, which holds the provider key).",
    "Never un-ignore a secret file; `!.env.example`-style template names are fine.",
    "If a .gitignore already exists, keep its correct entries and add what's missing.",
  ]
}

function buildAuthoringSystemPrompt(options: RunAuthoringHarnessOptions): string {
  const label = AUTHORED_FILE_LABEL[options.kind]
  return [
    `You are the DevOps component of OrchestrAI, writing the complete ${label} (${options.relativePath}) for the project at "${options.projectRoot}".`,
    "Read the real project first with the read-only tools (analyze_project, read_project_file on manifests, lockfiles, entry points and existing config). Never guess what the project is — look.",
    STATED_VALUES_RULE,
    "Rules — the file is checked against these before anyone sees it, and rejected if it breaks one:",
    ...authoringRules(options.kind, options.projectName, options.knownSecrets ?? []).map((rule) => `- ${rule}`),
    options.existingContent !== undefined
      ? `The file already exists. Its current content is below — keep what is right and fix or add what is missing:\n--- current ${options.relativePath} ---\n${options.existingContent}\n--- end ---`
      : `The file does not exist yet.`,
    jsonInstruction(`{ "content": <the complete file, as a string>, "summary": <one short line describing it> } — or, ONLY if this project genuinely cannot use such a file, { "refused": true, "reason": <the real, specific reason> }`),
  ].join("\n")
}

/** Authors one DevOps file. Returns validated content, or throws
 *  AuthoringRefusedError / AuthoringValidationError (fail closed). */
export async function runAuthoringHarness(options: RunAuthoringHarnessOptions): Promise<AuthoredFile> {
  const label = AUTHORED_FILE_LABEL[options.kind]
  let lastProblem: string | undefined
  const sourceExists = async (relativePath: string): Promise<boolean> => {
    try {
      await options.mcpClient.callTool("read_project_file", { project_root: options.projectRoot, relative_path: relativePath }, options.taskId)
      return true
    } catch {
      return false
    }
  }

  const validate = async (rawText: string): Promise<ParamsValidationResult<Record<string, unknown>>> => {
    const parsed = validateJsonParams(rawText, AuthoredFileSchema)
    if (!parsed.ok || !parsed.params) {
      lastProblem = parsed.error
      return { ok: false, error: parsed.error }
    }
    if ("refused" in parsed.params) return { ok: true, params: parsed.params as Record<string, unknown> }
    const check = await validateDevOpsFile(options.kind, parsed.params.content, {
      sourceExists,
      projectName: options.projectName,
      knownSecrets: options.knownSecrets,
    })
    if (!check.ok) {
      lastProblem = check.violations.join("; ")
      return {
        ok: false,
        error: `The ${label} failed OrchestrAI's safety checks. Fix every item, then respond again with the whole corrected JSON object:\n${check.violations.map((v) => `- ${v}`).join("\n")}`,
      }
    }
    return { ok: true, params: parsed.params as Record<string, unknown> }
  }

  const out = await runHarness<Record<string, unknown>>({
    ...options,
    skillName: options.kind,
    systemPrompt: buildAuthoringSystemPrompt(options),
    validate,
    maxRetries: options.maxRetries ?? AUTHORING_MAX_RETRIES,
  })
  if (!out) {
    throw new AuthoringValidationError(`The ${label} did not pass validation after ${AUTHORING_MAX_RETRIES} retry: ${lastProblem ?? "no valid response"}`)
  }
  if ("refused" in out) throw new AuthoringRefusedError(`The model declined to write the ${label}: ${String(out.reason)}`)
  return { content: String(out.content), summary: String(out.summary) }
}

// specs/080-run-command-approved-execution/spec.md §2 — DevOps's
// general-purpose run-command skill: unlike the four skills above, the
// model here isn't deciding parameters for an already-fixed template —
// it's proposing the entire command. The safety story is different
// accordingly: it's not "the target/executable is fixed, only content
// varies" (specs/042's own precedent), it's "every invocation is
// approved by a human before it runs" (specs/080's own new risk class).
// This harness only ever PROPOSES; it is never itself what decides
// whether the command runs.
export const RunCommandParamsSchema = z.object({
  argv: z.array(z.string()).min(1),
  reason: z.string().min(1),
})
export type RunCommandParams = z.infer<typeof RunCommandParamsSchema>

function buildRunCommandSystemPrompt(projectRoot: string, hint?: string, context?: string | null): string {
  return [
    `You are the DevOps component of OrchestrAI, deciding a real command to run for the project at "${projectRoot}".`,
    `You may call analyze_project, git_status, and read_project_file (e.g. to check for go.mod, Cargo.toml, pom.xml, a .csproj file, a Makefile) as many or as few times as you need to determine what command genuinely makes sense here — never guess without looking.`,
    hint ? `Context: ${hint}` : "",
    // specs/137 — in a plan, the hint is this step; the full request is background.
    renderPlanBackground(context),
    `Respond with the real argv for the command as a plain array — e.g. ["go","test","./..."] — never a shell string, never shell operators (&&, |, ;, >), one real executable and its real arguments. This will be shown to a human for approval before it ever runs, so name exactly what should execute.`,
    jsonInstruction(`{ "argv": [<string>, ...], "reason": <short string explaining why this command> }`),
  ].filter(Boolean).join("\n")
}

export interface RunRunCommandHarnessOptions extends RunHarnessBaseOptions {
  /** Optional extra context — e.g. Testing's own call site names the
   *  detected-but-unsupported runner signal, if any, so the model isn't
   *  starting from nothing. */
  hint?: string
}

export async function runRunCommandHarness(options: RunRunCommandHarnessOptions): Promise<RunCommandParams | null> {
  return runHarness<RunCommandParams>({
    ...options,
    skillName: "run-command",
    systemPrompt: buildRunCommandSystemPrompt(options.projectRoot, options.hint, options.context),
    // The background is in the system prompt; don't repeat it in "Begin."
    context: undefined,
    validate: (rawText) => validateJsonParams(rawText, RunCommandParamsSchema) as ParamsValidationResult<Record<string, unknown>>,
  })
}

// specs/105-orchestrator-fallback-deep-analysis/spec.md — the
// analyze-project deep-analysis harness (schema, grounding,
// runProjectAnalysisHarness, renderCodebaseAnalysis) moved to
// packages/shared/project-analysis.ts so DevOps and the Orchestrator
// share ONE implementation instead of two that could drift.
// packages/agents/devops/index.ts now imports it directly from there —
// nothing left to re-export from this file.
