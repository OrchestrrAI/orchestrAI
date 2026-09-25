// specs/080-run-command-approved-execution/spec.md §3
//
// Testing Agent's own LLM harness. Started narrow in specs/080 (proposing
// a real command for a stack detectRunner() (specs/058) has no fixed
// RUNNER_ARGV entry for) and gained a second, genuinely different job in
// specs/081-testing-write-tests-skill/spec.md (Phase C — "Testing writes
// tests"): runWriteTestsHarness() below authors real test-file source
// code, the first Testing/DevOps harness output that's raw content
// rather than a JSON parameter shape.
//
// Structurally mirrors packages/agents/devops/llm-harness.ts's own
// shared-core shape (LangGraph tool-calling loop, bounded
// retry-with-feedback validation) rather than importing it — this
// codebase's own precedent (specs/041/042/043 each built their own
// local harness module rather than sharing one) is followed here too.
// specs/101-per-agent-tool-access-expansion/spec.md gave every
// code-reasoning agent the same read-only inspection set
// (read_project_file/analyze_project/git_status/git_diff), so this
// harness's own tool set now matches DevOps's read-only set exactly.
import { renderPlanBackground } from "../../shared/plan-step-text"
import { Annotation, END, GraphRecursionError, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph"
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { z } from "zod"
import * as path from "path"
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
// straight to the end user on exhaustion. Applies to both of this
// file's own graphs (run-command fallback, write-tests).
// specs/125 — now resolves through the shared resolveHarnessRecursionLimit()
// (ORCHESTRAI_HARNESS_RECURSION_LIMIT, default 40, never throws).
const HARNESS_RECURSION_LIMIT = resolveHarnessRecursionLimit()

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

// Tier 2/read-only. project_root is fixed in closure, never
// model-suppliable — only read_project_file's relative_path is exposed,
// same discipline packages/agents/devops/llm-harness.ts's own
// buildReadOnlyTools() already established.
// specs/101-per-agent-tool-access-expansion/spec.md — analyze_project/
// git_status/git_diff added to the uniform general-inspection set.
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
        relative_path: z.string().describe("Path relative to the project root, e.g. \"go.mod\", \"Cargo.toml\", \".\" for the root listing"),
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
  for (const t of tools) {
    if (!(READ_ONLY_TOOL_NAMES as readonly string[]).includes(t.name)) {
      throw new Error(`Refusing to bind non-allow-listed tool "${t.name}" to the LLM harness`)
    }
  }
  return tools
}

export const RunTestCommandParamsSchema = z.object({
  argv: z.array(z.string()).min(1),
  reason: z.string().min(1),
})
export type RunTestCommandParams = z.infer<typeof RunTestCommandParamsSchema>

export interface ParamsValidationResult<T> {
  ok: boolean
  params?: T
  error?: string
}

/** Same shape as devops/llm-harness.ts's own validateJsonParams() —
 *  strips a markdown code fence, parses, validates against the schema. */
function validateJsonParams<T>(rawText: string, schema: z.ZodType<T>): ParamsValidationResult<T> {
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

// specs/138 — this harness now proposes EVERY test command (the fixed
// RUNNER_ARGV table was removed). detectRunner()'s result arrives as a
// hint, never as an answer: the model still reads the project.
function buildSystemPrompt(projectRoot: string, detectedSignal?: string, withCoverage?: boolean, context?: string | null): string {
  return [
    `You are the Testing component of OrchestrAI, proposing the exact command that runs this project's tests${withCoverage ? " WITH coverage reporting" : ""} for the project at "${projectRoot}".`,
    detectedSignal ? `Runner detection (a hint from the project's manifests/lockfiles, not an answer): ${detectedSignal}.` : "",
    `Call read_project_file (package.json scripts, pyproject.toml/pytest.ini, go.mod, Cargo.toml, pom.xml, a .csproj file, a Makefile) as many or as few times as you need to determine the REAL test command — never guess without looking. Prefer the project's own test script when it has one.`,
    withCoverage ? `The command must report coverage (e.g. bun test --coverage, pytest --cov, jest --coverage, vitest run --coverage, go test -cover ./...).` : "",
    // specs/137 — in a plan, the user's full request as capped background.
    renderPlanBackground(context),
    `Respond with the real argv for the test command as a plain array — e.g. ["go","test","./..."] — never a shell string, never shell operators (&&, |, ;, >), one real executable and its real arguments. This will be shown to a human for approval before it ever runs.`,
    `Respond with ONLY a single JSON object matching this shape: { "argv": [<string>, ...], "reason": <short string explaining why this command> }. No other text, no markdown code fence.`,
  ].filter(Boolean).join("\n")
}

/** specs/138 — the bounded user request as the run's first message. */
const MAX_TEST_REQUEST_CHARS = 2000
function buildTestStartMessage(requestText?: string): string {
  const request = requestText?.trim()
  if (!request) return "Begin."
  const bounded = request.length > MAX_TEST_REQUEST_CHARS ? request.slice(0, MAX_TEST_REQUEST_CHARS) + "… [truncated]" : request
  return `The user's request, verbatim (between the markers):\n<<<REQUEST\n${bounded}\nREQUEST>>>\nBegin.`
}

export interface RunTestCommandHarnessOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  projectRoot: string
  detectedSignal?: string
  /** specs/138 — check-coverage: the command must report coverage. */
  withCoverage?: boolean
  /** specs/138 — the user's request (in a plan, only this step). */
  requestText?: string
  /** specs/137 — in a plan, the user's full request as background. */
  context?: string | null
  maxRetries?: number
}

export async function runTestCommandHarness(options: RunTestCommandHarnessOptions): Promise<RunTestCommandParams | null> {
  const { model, mcpClient, taskId, projectRoot, detectedSignal, withCoverage, requestText, context } = options
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const tools = buildReadOnlyTools(mcpClient, taskId, projectRoot)

  if (typeof model.bindTools !== "function") {
    throw new Error("Configured chat model does not support tool binding (bindTools)")
  }
  const modelWithTools = model.bindTools(tools)

  async function agentNode(state: HarnessStateType) {
    const response = await callProviderWithRetry(() => modelWithTools.invoke(state.messages))
    return { messages: [response] }
  }

  const toolNode = new ToolNode(tools)

  function validateNode(state: HarnessStateType) {
    const last = state.messages[state.messages.length - 1]
    const rawText = typeof last?.content === "string" ? last.content : String(last?.content ?? "")
    const result = validateJsonParams(rawText, RunTestCommandParamsSchema)
    if (result.ok) return { params: result.params ?? null }

    const attempts = state.attempts + 1
    if (attempts > maxRetries) return { params: null, attempts }
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

  const graph = new StateGraph(HarnessState)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addNode("validate", validateNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition, { tools: "tools", [END]: "validate" })
    .addEdge("tools", "agent")
    .addConditionalEdges("validate", afterValidate, { agent: "agent", [END]: END })
    .compile()

  try {
    const finalState = await graph.invoke(
      {
        messages: [new SystemMessage(buildSystemPrompt(projectRoot, detectedSignal, withCoverage, context)), new HumanMessage(buildTestStartMessage(requestText))],
        params: null,
        attempts: 0,
      },
      { recursionLimit: HARNESS_RECURSION_LIMIT },
    )
    return (finalState.params as RunTestCommandParams | null) ?? null
  } catch (err) {
    if (err instanceof GraphRecursionError) {
      throw new Error(
        `The test-command harness could not converge on a proposal within ${HARNESS_RECURSION_LIMIT} tool-call rounds.`,
      )
    }
    throw err
  }
}

// ============================================================
// specs/081-testing-write-tests-skill/spec.md — write-tests
// ============================================================
// A deliberately different output shape from every harness above (and
// every DevOps harness): raw test-file source code, not a JSON parameter
// object. The target path is still never model-suppliable — the caller
// derives it deterministically from (source path, detected runner)
// before this function is ever invoked; this function only decides
// content.

/** Strips a single leading/trailing markdown code fence if the model
 *  wrapped its answer in one — a common model habit, tolerated the same
 *  way validateJsonParams() tolerates it for JSON responses, but no JSON
 *  parsing happens here at all: the fenced content itself IS the file. */
function stripCodeFence(rawText: string): string {
  return rawText
    .trim()
    .replace(/^```[a-zA-Z0-9]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim()
}

// A deliberately shallow heuristic, never a real parser: pulls out
// top-level-looking declaration names across the two language families
// detectRunner()'s 7 profiles actually cover (JS/TS's bun/npm/pnpm/yarn/
// jest/vitest, and Python's pytest). This exists only to catch a
// response that references NOTHING from the real source file — the same
// shallow, deliberately non-semantic bar document-api's own per-route
// grounding check (specs/041) already sets, not a claim of full
// correctness.
function extractGroundingIdentifiers(sourceContent: string): string[] {
  const patterns = [
    /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|class|interface|type)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\s)function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\s)class\s+([A-Za-z_$][\w$]*)/g,
    /def\s+([A-Za-z_][\w]*)/g,
  ]
  const names = new Set<string>()
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(sourceContent)) !== null) {
      if (match[1]) names.add(match[1])
    }
  }
  return Array.from(names)
}

// specs/127 — the import a JS/TS test file should use for its source,
// relative to where the caller will write the test. Null for pytest,
// whose imports are module-based rather than relative file paths.
export function sourceImportSpecifier(testRelativePath: string, sourceRelativePath: string, runnerLabel: string): string | null {
  if (runnerLabel === "pytest") return null
  const toPosix = (p: string) => p.replace(/\\/g, "/")
  const fromDir = path.posix.dirname(toPosix(testRelativePath))
  let specifier = path.posix.relative(fromDir, toPosix(sourceRelativePath)).replace(/\.(ts|tsx|mts|cts)$/, "")
  if (!specifier.startsWith(".")) specifier = `./${specifier}`
  return specifier
}

export function buildWriteTestsSystemPrompt(
  projectRoot: string,
  sourceRelativePath: string,
  sourceContent: string,
  runnerLabel: string,
  testRelativePath: string,
): string {
  const specifier = sourceImportSpecifier(testRelativePath, sourceRelativePath, runnerLabel)
  return [
    `You are the Testing component of OrchestrAI, writing a real, syntactically correct test file for the project at "${projectRoot}".`,
    `The project's real test framework is "${runnerLabel}" — write test code that genuinely works with that framework's own real syntax and imports (e.g. bun:test's "import { test, expect } from 'bun:test'", or pytest's plain "def test_...():" functions using "assert").`,
    `The real source file "${sourceRelativePath}" is given below in full. Write tests that exercise its real, actual exported/top-level functionality — never invent functions, classes, or exports that are not really there.`,
    specifier
      ? `This test file will be written to "${testRelativePath}". Write every relative import from that file's own location — import the source file as "${specifier}".`
      : `This test file will be written to "${testRelativePath}".`,
    `You may call read_project_file again (e.g. to check a sibling file's own test conventions) as many or as few times as you need.`,
    `--- ${sourceRelativePath} ---`,
    sourceContent,
    `--- end of ${sourceRelativePath} ---`,
    `Respond with ONLY the raw test file's content — no explanation, no markdown code fence, no JSON wrapper. Just the real file contents, ready to write to disk verbatim.`,
  ].join("\n")
}

export interface RunWriteTestsHarnessOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  projectRoot: string
  sourceRelativePath: string
  sourceContent: string
  /** Human-readable framework name shown to the model (e.g. "bun",
   *  "pytest") — not a RunnerProfile import, to keep this module
   *  independent of packages/shared/test-runner.ts's own types; the
   *  caller (index.ts) already has the real RunnerProfile and just
   *  passes its string form. */
  runnerLabel: string
  /** Where the caller will write the test (deterministic, specs/081 §4) —
   *  told to the model so its imports are relative to the right place. */
  testRelativePath: string
  maxRetries?: number
}

export async function runWriteTestsHarness(options: RunWriteTestsHarnessOptions): Promise<string | null> {
  const { model, mcpClient, taskId, projectRoot, sourceRelativePath, sourceContent, runnerLabel, testRelativePath } = options
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const tools = buildReadOnlyTools(mcpClient, taskId, projectRoot)
  const groundingNames = extractGroundingIdentifiers(sourceContent)

  if (typeof model.bindTools !== "function") {
    throw new Error("Configured chat model does not support tool binding (bindTools)")
  }
  const modelWithTools = model.bindTools(tools)

  async function agentNode(state: HarnessStateType) {
    const response = await callProviderWithRetry(() => modelWithTools.invoke(state.messages))
    return { messages: [response] }
  }

  const toolNode = new ToolNode(tools)

  function validateNode(state: HarnessStateType) {
    const last = state.messages[state.messages.length - 1]
    const rawText = typeof last?.content === "string" ? last.content : String(last?.content ?? "")
    const content = stripCodeFence(rawText)

    if (content.length === 0) {
      const attempts = state.attempts + 1
      if (attempts > maxRetries) return { params: null, attempts }
      return {
        attempts,
        messages: [new HumanMessage("Your last response was empty. Respond again with the real test file content only, no other text.")],
      }
    }

    // Grounding check — skipped (not failed) when the source itself has
    // no declaration shape this shallow extractor recognizes at all,
    // since the check couldn't meaningfully pass in that case either way.
    if (groundingNames.length > 0 && !groundingNames.some((name) => content.includes(name))) {
      const attempts = state.attempts + 1
      if (attempts > maxRetries) return { params: null, attempts }
      return {
        attempts,
        messages: [new HumanMessage(
          `Your last response didn't reference any real identifier from ${sourceRelativePath} (expected one of: ${groundingNames.slice(0, 10).join(", ")}). Respond again with tests that actually exercise this file's real content.`,
        )],
      }
    }

    return { params: { content } }
  }

  function afterValidate(state: HarnessStateType): "agent" | typeof END {
    const last = state.messages[state.messages.length - 1]
    const isRetryPrompt = last instanceof HumanMessage
    if (isRetryPrompt && state.attempts <= maxRetries) return "agent"
    return END
  }

  const graph = new StateGraph(HarnessState)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addNode("validate", validateNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition, { tools: "tools", [END]: "validate" })
    .addEdge("tools", "agent")
    .addConditionalEdges("validate", afterValidate, { agent: "agent", [END]: END })
    .compile()

  try {
    const finalState = await graph.invoke(
      {
        messages: [new SystemMessage(buildWriteTestsSystemPrompt(projectRoot, sourceRelativePath, sourceContent, runnerLabel, testRelativePath)), new HumanMessage("Begin.")],
        params: null,
        attempts: 0,
      },
      { recursionLimit: HARNESS_RECURSION_LIMIT },
    )
    const result = finalState.params as { content: string } | null
    return result?.content ?? null
  } catch (err) {
    if (err instanceof GraphRecursionError) {
      throw new Error(
        `The write-tests harness could not converge on a test file within ${HARNESS_RECURSION_LIMIT} tool-call rounds.`,
      )
    }
    throw err
  }
}
