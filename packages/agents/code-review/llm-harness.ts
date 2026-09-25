// specs/082-code-review-agent/spec.md
//
// Code Review Agent's own LLM harness — a real LangGraph tool-calling
// loop (the same shape DevOps's own llm-harness.ts already uses), not
// Security's plain retry-only core: the model may call read_project_file
// for real context beyond the diff hunk before producing its final
// structured review. The validation retry loop is a SEPARATE, second
// bounded mechanism on top of the tool-call loop, exactly as it already
// is in every other LangGraph-based harness in this codebase.
//
// The one genuinely new piece here is grounding: every comment must cite
// a real file:line the diff actually shows (packages/agents/code-review/
// diff-grounding.ts). Unlike specs/043's CVE guard (which drops a single
// bad claim silently), an ungrounded comment first gets one real
// retry-with-feedback chance (naming the exact bad citation and the real
// valid ones) — only on final exhaustion is the ungrounded subset
// dropped and the grounded remainder kept, per specs/082's own confirmed
// design (Yusuf: "Drop only the bad comment(s), keep the rest").
import { Annotation, END, GraphRecursionError, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph"
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { z } from "zod"
import { callProviderWithRetry } from "../../shared/llm-model-factory"
import { resolveHarnessRecursionLimit } from "../../shared/harness-limits"
import { describeValidLocations, isGrounded, type ParsedDiff } from "./diff-grounding"

export interface McpToolCaller {
  callTool(toolName: string, args: Record<string, unknown>, taskId: string): Promise<string>
}

// specs/098-harness-recursion-limit-and-clean-failure/spec.md — see
// packages/agents/coder/llm-harness.ts's own identical comment for the
// full rationale: every agent-level harness's graph.invoke() previously
// had no explicit recursionLimit, silently relying on LangGraph's own
// internal default of 25 and leaking its raw internal error text
// straight to the end user on exhaustion.
// specs/125 — now resolves through the shared resolveHarnessRecursionLimit()
// (ORCHESTRAI_HARNESS_RECURSION_LIMIT, default 40, never throws).
const HARNESS_RECURSION_LIMIT = resolveHarnessRecursionLimit()

const MAX_RETRIES = 2

// ============================================================
// GRAPH STATE
// ============================================================
const HarnessState = Annotation.Root({
  ...MessagesAnnotation.spec,
  params: Annotation<ReviewDiffResult | null>({
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
// Structurally enforced — the same "throw at build time if anything not
// allow-listed is ever bound" pattern DevOps's own buildReadOnlyTools()
// already establishes. project_root is fixed in closure, never
// model-suppliable — only relative_path is exposed.
// specs/101-per-agent-tool-access-expansion/spec.md — analyze_project/
// git_status added to the uniform general-inspection set, so a review
// comment can reference how a file fits the project, not just the diff
// hunk.
//
// specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part A —
// git_diff is now bound too. It was deliberately left unbound at
// specs/082/101 time because the combined diff already reaches the
// model as prompt context; it is bound now so the model can pull a
// FILE'S FULLER change history (e.g. what changed in an earlier,
// already-committed revision touching the same file) when a hunk's
// intent is unclear from the one uncommitted diff alone — a genuinely
// different use than the redundant "give me the same diff again" case
// this tool was withheld to avoid.
export const READ_ONLY_TOOL_NAMES = ["read_project_file", "analyze_project", "git_status", "git_diff"] as const

export function buildReadOnlyTools(mcpClient: McpToolCaller, taskId: string, projectRoot: string) {
  const readProjectFile = tool(
    async ({ relative_path }: { relative_path: string }) => {
      return mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path }, taskId)
    },
    {
      name: "read_project_file",
      description:
        "Read a file's content, or list a directory's entries (pass \".\" for the project root), within the target project. relative_path is relative to the project root — never an absolute path. Use this to see a touched file's full real context beyond the diff hunk shown to you.",
      schema: z.object({
        relative_path: z.string().describe("Path relative to the project root, e.g. \"src/foo.ts\", or \".\" for the root listing"),
      }),
    },
  )

  const analyzeProject = tool(
    async () => mcpClient.callTool("analyze_project", { project_path: projectRoot }, taskId),
    {
      name: "analyze_project",
      description: "Analyze the target project's directory structure — useful to understand how a touched file fits the wider project before reviewing it.",
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
      description: "Get the combined staged and unstaged git diff for the target project again — useful only if you need to re-confirm something beyond the diff already given to you in the system prompt; prefer read_project_file for a touched file's fuller current content.",
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

// ============================================================
// PARAMETER SHAPE
// ============================================================
export const ReviewCommentSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(["blocking", "suggestion", "nit"]),
  comment: z.string().min(1),
})
export type ReviewComment = z.infer<typeof ReviewCommentSchema>

export const ReviewDiffResultSchema = z.object({
  comments: z.array(ReviewCommentSchema),
  summary: z.string().optional(),
})
export type ReviewDiffResult = z.infer<typeof ReviewDiffResultSchema> & {
  /** Set only when the grounding filter dropped one or more comments on
   *  final retry exhaustion — never present on a fully-grounded response. */
  omittedCount?: number
}

interface ParamsValidationResult<T> {
  ok: boolean
  params?: T
  error?: string
}

/** Same shape as every other harness's own validateJsonParams(): strips
 *  a markdown code fence, parses, validates against the schema. */
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

// ============================================================
// SYSTEM PROMPT
// ============================================================
// specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part A —
// codebaseContext is the rendered output of packages/shared/
// project-analysis.ts's own runProjectAnalysisHarness()/
// renderCodebaseAnalysis(), passed only when that deep analysis
// genuinely succeeded (never a "codebase analysis unavailable" note —
// that goes only in the human-facing result, never fed to the model as
// if it were real context). Optional so this prompt stays
// byte-identical to before when analysis is unavailable, matching that
// module's own fail-open convention.
function buildReviewDiffSystemPrompt(projectRoot: string, diffText: string, codebaseContext?: string): string {
  return [
    `You are the Code Review component of OrchestrAI, reviewing the real, current staged+unstaged git diff for the project at "${projectRoot}".`,
    ...(codebaseContext
      ? [
          `A deeper analysis of this codebase already produced the following — use it to understand context OUTSIDE the diff itself (e.g. the wider stack/structure) when it changes how you'd read a change; it is not itself something to comment on:`,
          `--- codebase analysis ---`,
          codebaseContext,
          `--- end of codebase analysis ---`,
        ]
      : []),
    `You may call read_project_file (e.g. to read a touched file's full real content, or a related file) as many or as few times as you need to understand real context beyond the diff hunks shown below — never guess without looking when context would change your answer.`,
    `You may comment ONLY on a location genuinely shown in the diff below — an added line or an unchanged context line, identified by its exact real file path and its exact real line number in the NEW version of the file as the diff itself shows it. Never invent a file or line not present in the diff. Never comment on a removed line. Never claim to know the code's actual runtime behavior beyond what the diff and any file you actually read show you.`,
    `--- diff ---`,
    diffText,
    `--- end of diff ---`,
    `Respond with ONLY a single JSON object matching this shape: { "comments": [{ "file": <string>, "line": <number>, "severity": "blocking" | "suggestion" | "nit", "comment": <string> }, ...], "summary"?: <short string> }. An empty "comments" array is a completely valid response if you find nothing worth flagging. No other text, no markdown code fence.`,
  ].join("\n")
}

// ============================================================
// ENTRY POINT
// ============================================================
export interface RunReviewDiffHarnessOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  projectRoot: string
  diffText: string
  parsed: ParsedDiff
  maxRetries?: number
  /** specs/119 Part A — see buildReviewDiffSystemPrompt()'s own comment. */
  codebaseContext?: string
}

export async function runReviewDiffHarness(options: RunReviewDiffHarnessOptions): Promise<ReviewDiffResult | null> {
  const { model, mcpClient, taskId, projectRoot, diffText, parsed, codebaseContext } = options
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
    const result = validateJsonParams(rawText, ReviewDiffResultSchema)

    if (!result.ok) {
      const attempts = state.attempts + 1
      if (attempts > maxRetries) return { params: null, attempts }
      return {
        attempts,
        messages: [new HumanMessage(`Your last response was invalid: ${result.error}\nRespond again with the corrected JSON object only.`)],
      }
    }

    const { comments, summary } = result.params!
    const grounded = comments.filter((c) => isGrounded(parsed, c.file, c.line))
    const ungrounded = comments.filter((c) => !isGrounded(parsed, c.file, c.line))

    if (ungrounded.length === 0) {
      return { params: { comments, summary } }
    }

    const attempts = state.attempts + 1
    if (attempts > maxRetries) {
      // Final exhaustion — salvage the grounded subset rather than
      // discarding a real, correct finding alongside a hallucinated
      // one. Fail closed (null) only when NOTHING survived grounding.
      if (grounded.length === 0) return { params: null, attempts }
      return { params: { comments: grounded, summary, omittedCount: ungrounded.length }, attempts }
    }

    const badList = ungrounded.map((c) => `${c.file}:${c.line}`).join(", ")
    return {
      attempts,
      messages: [new HumanMessage(
        `These location(s) you cited are NOT present in the real diff: ${badList}. ` +
        `The only real locations you may cite are: ${describeValidLocations(parsed)}. ` +
        `Respond again with the corrected JSON object, citing only real locations from the diff.`,
      )],
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
        messages: [new SystemMessage(buildReviewDiffSystemPrompt(projectRoot, diffText, codebaseContext)), new HumanMessage("Begin.")],
        params: null,
        attempts: 0,
      },
      { recursionLimit: HARNESS_RECURSION_LIMIT },
    )
    return (finalState.params as ReviewDiffResult | null) ?? null
  } catch (err) {
    if (err instanceof GraphRecursionError) {
      throw new Error(
        `The review-diff harness could not converge on a review within ${HARNESS_RECURSION_LIMIT} tool-call rounds — the diff may be too large or complex for this pass.`,
      )
    }
    throw err
  }
}
