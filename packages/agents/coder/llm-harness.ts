// specs/083-coder-agent/spec.md
//
// Coder Agent's own LLM harness — a real LangGraph tool-calling loop
// (the same shape DevOps's/Code Review's own llm-harness.ts already
// use), not a plain retry-only core: the model may call
// read_project_file for real context beyond the target file itself
// (e.g. a related file it imports) before producing its final
// structured edit proposal.
//
// The one genuinely new piece here is grounding: the proposed old_text
// must be a real, EXACTLY-ONCE-occurring substring of the target file's
// real, current content (packages/agents/coder/llm-harness.ts's own
// countOccurrences() below) — never a location that doesn't exist, and
// never one so generic it could mean more than one place in the file.
// Unlike specs/082's review-diff (which can salvage a grounded SUBSET of
// several independent comments), this skill proposes exactly one edit
// per task (specs/083's own v1 scope decision), so there is nothing to
// salvage on final exhaustion — an ungrounded proposal fails the whole
// task closed, the same "no deterministic fallback" precedent
// specs/081/082 already established.
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
import { PATH_NOT_FOUND_PREFIX } from "../../shared/write-preflight"

export interface McpToolCaller {
  callTool(toolName: string, args: Record<string, unknown>, taskId: string): Promise<string>
}

const MAX_RETRIES = 2

// specs/098-harness-recursion-limit-and-clean-failure/spec.md — every
// agent-level harness's own graph.invoke() previously had no explicit
// recursionLimit, silently relying on LangGraph's own internal default
// of 25 and leaking its raw internal error text (including a
// docs.langchain.com URL) straight to the end user on exhaustion. One
// local constant per harness file (matching this codebase's own
// independent-per-agent-copy convention), same value across all five
// affected harnesses — a real, grounded bound (narrow, single-skill
// exploration-then-propose loops, not the adaptive supervisor's own
// multi-step plan), not a placeholder.
// specs/125-configurable-harness-recursion-limit/spec.md — the bound is
// now configurable through one shared environment variable and its
// shipped default is raised from 20 to 40: this local constant resolves
// once at import time through resolveHarnessRecursionLimit()
// (ORCHESTRAI_HARNESS_RECURSION_LIMIT; unset/malformed degrades to the
// default, never throws, never disables the bound).
const HARNESS_RECURSION_LIMIT = resolveHarnessRecursionLimit()

// ============================================================
// GRAPH STATE
// ============================================================
const HarnessState = Annotation.Root({
  ...MessagesAnnotation.spec,
  // specs/098 — now holds an EditProposal, a Refusal, or null (the
  // latter two moved into the type union so a refusal is preserved
  // through the same terminal state slot rather than requiring a
  // separate field this graph would need to plumb through everywhere.
  params: Annotation<EditFileHarnessResult>({
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
// allow-listed is ever bound" pattern DevOps's/Code Review's own
// buildReadOnlyTools() already establishes. project_root is fixed in
// closure, never model-suppliable — only read_project_file's
// relative_path is exposed. No write-capable tool is ever bound here:
// the actual write happens only after human approval, in index.ts's
// own resumeTask(), via the existing write_project_file tool — this
// harness only ever proposes, it never writes.
// specs/101-per-agent-tool-access-expansion/spec.md — analyze_project/
// git_status/git_diff added to the uniform general-inspection set, so
// an edit proposal can be grounded in real project structure and see
// uncommitted work in the target file before proposing an anchored edit.
export const READ_ONLY_TOOL_NAMES = ["read_project_file", "analyze_project", "git_status", "git_diff"] as const

export function buildReadOnlyTools(mcpClient: McpToolCaller, taskId: string, projectRoot: string) {
  const readProjectFile = tool(
    async ({ relative_path }: { relative_path: string }) => {
      return mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path }, taskId)
    },
    {
      name: "read_project_file",
      description:
        "Read a file's content, or list a directory's entries (pass \".\" for the project root), within the target project. relative_path is relative to the project root — never an absolute path. Use this to see related context (e.g. an imported module) beyond the target file's own content already given to you.",
      schema: z.object({
        relative_path: z.string().describe("Path relative to the project root, e.g. \"src/foo.ts\", or \".\" for the root listing"),
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
      description: "Get the git status of the target project — branch, staged/unstaged/untracked files, recent log. Use this to check whether the file you are about to edit already has uncommitted changes.",
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

// ============================================================
// GROUNDING
// ============================================================
/** Counts non-overlapping occurrences of `needle` in `haystack` as an
 *  exact, contiguous substring — deliberately simple string search, no
 *  fuzzy/whitespace-normalized matching, so a match found here is a
 *  guarantee the same splice at write time targets exactly what the
 *  model actually saw. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  while (true) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    count++
    from = idx + needle.length
  }
  return count
}

// ============================================================
// PARAMETER SHAPE
// ============================================================
export const EditProposalSchema = z.object({
  old_text: z.string().min(1),
  // A pure deletion (replacing a span with nothing) is a valid edit —
  // new_text may legitimately be an empty string.
  new_text: z.string(),
})
export type EditProposal = z.infer<typeof EditProposalSchema>

// specs/098-harness-recursion-limit-and-clean-failure/spec.md — a real,
// structurally-recognized refusal shape the model may return instead of
// an edit, when the requested change cannot be validly expressed in the
// target file's own syntax (e.g. "add a comment" to a JSON file, which
// has no comment syntax at all). Live-caught: without this, the model
// had no way to say "this can't be done" except by continuing to call
// read_project_file indefinitely, exhausting the recursion budget.
// Detected structurally via Zod, the same mechanism every other harness
// parameter is already validated by — never by guessing at free-text
// shape.
export const RefusalSchema = z.object({
  refused: z.literal(true),
  reason: z.string().min(1),
})
export type Refusal = z.infer<typeof RefusalSchema>

const HarnessResponseSchema = z.union([EditProposalSchema, RefusalSchema])
type HarnessResponse = z.infer<typeof HarnessResponseSchema>

/** The real, three-way outcome runEditFileHarness() can return:
 *  a real edit proposal, an explicit refusal with the model's own real
 *  reason, or null (exhausted retries / recursion limit — no
 *  deterministic fallback, the same "no partial edit to salvage"
 *  precedent specs/083 already established). */
export type EditFileHarnessResult = EditProposal | Refusal | null

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
function buildEditFileSystemPrompt(relativePath: string, fileContent: string, instruction: string, context?: string | null): string {
  // specs/098-harness-recursion-limit-and-clean-failure/spec.md — the
  // real extension, named explicitly, so the model can reason about
  // whether the requested change is even valid syntax for this file
  // type (e.g. JSON has no comment syntax) instead of discovering that
  // only after exhausting its own exploration.
  const extIdx = relativePath.lastIndexOf(".")
  const extension = extIdx >= 0 ? relativePath.slice(extIdx) : "(no extension)"
  return [
    `You are the Coder component of OrchestrAI, proposing a single, precise edit to the real file "${relativePath}" (extension: ${extension}).`,
    `The requested change is: ${instruction}`,
    // specs/137 — in a plan, the user's full request as capped background.
    ...(context ? [renderPlanBackground(context)] : []),
    `You may call read_project_file (e.g. to read a related file it imports) as many or as few times as you need for real context beyond this file's own content — never guess without looking when context would change your answer.`,
    `--- current file content ---`,
    fileContent,
    `--- end of file content ---`,
    `Respond with ONLY a single JSON object matching ONE of these two shapes — never both, never neither:`,
    `1. An edit: { "old_text": <string>, "new_text": <string> }. "old_text" MUST be an exact, contiguous, character-for-character substring copied from the file content above — including exact whitespace and indentation — that occurs EXACTLY ONCE in the file. Choose the smallest span that uniquely and unambiguously identifies the location to change; if the minimal change site could match more than one place, include enough surrounding context to make it unique. "new_text" is what should replace it — it may be an empty string for a pure deletion.`,
    `2. A refusal: { "refused": true, "reason": <string> } — use this ONLY when the requested change cannot be validly expressed in this file's own syntax (for example, "${extension}" may not support comments, or the request asks for something structurally impossible in this format). Give the real, specific reason. Do NOT keep exploring or guessing at a workaround once you've genuinely determined the change is impossible — refuse immediately and explain why.`,
    `No other text, no markdown code fence, no explanation outside the JSON object itself.`,
  ].join("\n")
}

// ============================================================
// ENTRY POINT
// ============================================================
export interface RunEditFileHarnessOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  projectRoot: string
  relativePath: string
  fileContent: string
  instruction: string
  /** specs/137 — the user's full request when this is a plan step. */
  context?: string | null
  maxRetries?: number
}

export async function runEditFileHarness(options: RunEditFileHarnessOptions): Promise<EditFileHarnessResult> {
  const { model, mcpClient, taskId, projectRoot, relativePath, fileContent, instruction, context } = options
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
    const result = validateJsonParams(rawText, HarnessResponseSchema)

    if (!result.ok) {
      const attempts = state.attempts + 1
      if (attempts > maxRetries) return { params: null, attempts }
      return {
        attempts,
        messages: [new HumanMessage(`Your last response was invalid: ${result.error}\nRespond again with the corrected JSON object only.`)],
      }
    }

    // specs/098 — a refusal is accepted immediately, structurally
    // distinct from a normal validation failure: no retry, no further
    // exploration. No HumanMessage is pushed, so afterValidate()'s own
    // existing "last message is a retry prompt" check naturally routes
    // straight to END — no change needed there.
    if ("refused" in result.params! && result.params.refused === true) {
      return { params: result.params as Refusal }
    }

    const { old_text, new_text } = result.params as EditProposal
    const occurrences = countOccurrences(fileContent, old_text)

    if (occurrences === 1) {
      return { params: { old_text, new_text } }
    }

    const attempts = state.attempts + 1
    if (attempts > maxRetries) {
      // No partial edit exists here to salvage (unlike specs/082's
      // multi-comment review) — a single ungrounded proposal fails the
      // whole task closed.
      return { params: null, attempts }
    }

    const feedback = occurrences === 0
      ? `The text you proposed for "old_text" was NOT found verbatim in the file. Quote it exactly as it appears, including exact whitespace and indentation.`
      : `The text you proposed for "old_text" appears ${occurrences} times in the file — it is ambiguous which occurrence to replace. Include more surrounding context so it matches EXACTLY ONCE.`
    return {
      attempts,
      messages: [new HumanMessage(`${feedback}\nRespond again with the corrected JSON object.`)],
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
        messages: [new SystemMessage(buildEditFileSystemPrompt(relativePath, fileContent, instruction, context)), new HumanMessage("Begin.")],
        params: null,
        attempts: 0,
      },
      { recursionLimit: HARNESS_RECURSION_LIMIT },
    )
    return (finalState.params as EditFileHarnessResult) ?? null
  } catch (err) {
    // specs/098-harness-recursion-limit-and-clean-failure/spec.md —
    // LangGraph's own raw internal error (including a docs.langchain.com
    // troubleshooting URL) must never reach the end user verbatim.
    // Every other error type is re-thrown completely unchanged, reaching
    // the calling agent's own existing generic catch wrapper exactly as
    // before this spec.
    if (err instanceof GraphRecursionError) {
      throw new Error(
        `The edit-file harness could not converge on a proposal within ${HARNESS_RECURSION_LIMIT} tool-call rounds — try a narrower, more specific instruction naming exactly what should change.`,
      )
    }
    throw err
  }
}

// ============================================================
// MULTI-FILE (edit-files) — specs/114-coder-multi-file-edit-and-create/spec.md
//
// A second, sibling entry point sharing the exact same read-only tool
// set, recursion limit, and general retry-with-feedback shape as
// runEditFileHarness() above — no widening of READ_ONLY_TOOL_NAMES, no
// write-capable tool ever bound here either. The real new piece is
// per-file grounding plus salvage-on-exhaustion (specs/082's own "don't
// discard a real finding to punish a hallucinated one" precedent,
// applied here for the first time in Coder): unlike a single edit
// proposal, which either grounds or it doesn't, a multi-file proposal
// can have some files ground and others not — the largest fully-grounded
// subset SEEN ACROSS ANY ATTEMPT is what survives final retry
// exhaustion, never fewer than the best attempt actually achieved.
// ============================================================
export const MAX_FILES_PER_EDIT = 6

export const FileEditSchema = z.object({
  path: z.string().min(1),
  action: z.literal("edit"),
  old_text: z.string().min(1),
  new_text: z.string(),
})
export const FileCreateSchema = z.object({
  path: z.string().min(1),
  action: z.literal("create"),
  content: z.string(),
})
const FileChangeSchema = z.union([FileEditSchema, FileCreateSchema])
export type FileChangeProposal = z.infer<typeof FileChangeSchema>

export const MultiFileProposalSchema = z.object({
  files: z.array(FileChangeSchema).min(1).max(MAX_FILES_PER_EDIT),
})
export type MultiFileProposal = z.infer<typeof MultiFileProposalSchema>

/** One file entry that has passed real, per-file grounding — old_text
 *  confirmed exactly-once (edit) or the path confirmed absent (create),
 *  content already spliced/ready to write verbatim. */
export interface GroundedFileChange {
  path: string
  action: "edit" | "create"
  content: string
  previousContent?: string
}

/** The real, three-way outcome runEditFilesHarness() can return: a
 *  (possibly salvaged, see `dropped`) set of grounded files, an explicit
 *  refusal with the model's own real reason, or null (zero files
 *  grounded across every attempt / exhausted retries with nothing to
 *  salvage — no deterministic fallback, matching runEditFileHarness()'s
 *  own precedent). */
export type MultiFileHarnessResult =
  | { files: GroundedFileChange[]; dropped: { path: string; reason: string }[] }
  | Refusal
  | null

const MultiFileHarnessState = Annotation.Root({
  ...MessagesAnnotation.spec,
  params: Annotation<MultiFileHarnessResult>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  attempts: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
})
type MultiFileHarnessStateType = typeof MultiFileHarnessState.State

function isPlainObjectLocal(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessageLocal(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolves a model-proposed path against the project root and confirms
 *  it stays contained — the same `relativePath.startsWith("..")` check
 *  index.ts's own handleEditFileSkill() already uses for the single-file
 *  skill, applied per file here. Returns the normalized relative path,
 *  or null if the path escapes the project root. */
function resolveContainedRelativePath(projectRoot: string, rawPath: string): string | null {
  const abs = path.isAbsolute(rawPath) ? rawPath : path.join(projectRoot, rawPath)
  const rel = path.relative(projectRoot, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null
  return rel
}

function buildEditFilesSystemPrompt(instruction: string, maxFiles: number, context?: string | null): string {
  return [
    `You are the Coder component of OrchestrAI, proposing a coherent, potentially multi-file change to a real project on disk.`,
    `The requested change is: ${instruction}`,
    // specs/137 — in a plan, the user's full request as capped background.
    ...(context ? [renderPlanBackground(context)] : []),
    `You have NOT been given any file's content up front — use read_project_file (pass "." for the project root listing) and analyze_project/git_status/git_diff as needed to explore the real project and decide which real files need touching. Never guess at a file's path or content without looking.`,
    `Respond with ONLY a single JSON object matching ONE of these two shapes — never both, never neither:`,
    `1. A multi-file proposal: { "files": [ <entry>, ... ] }, at most ${maxFiles} entries. Each entry is one of:`,
    `   - An edit: { "path": <string, relative to the project root>, "action": "edit", "old_text": <string>, "new_text": <string> }. "old_text" MUST be an exact, contiguous, character-for-character substring copied from that specific file's real current content (read it first) — including exact whitespace and indentation — that occurs EXACTLY ONCE in that file. Choose the smallest span that uniquely identifies the location; widen it with surrounding context if it could otherwise match more than one place.`,
    `   - A new file: { "path": <string, relative to the project root>, "action": "create", "content": <string> } — the full content of a file that does NOT already exist. Never propose "create" for a path that already exists — propose "edit" for that instead.`,
    `2. A refusal: { "refused": true, "reason": <string> } — use this ONLY when the requested change cannot be validly made at all. Give the real, specific reason.`,
    `Every path must stay within the project root — never propose a path that escapes it (e.g. via "..").`,
    `No other text, no markdown code fence, no explanation outside the JSON object itself.`,
  ].join("\n")
}

async function validateMultiFileNode(
  state: MultiFileHarnessStateType,
  deps: { mcpClient: McpToolCaller; taskId: string; projectRoot: string; maxRetries: number },
  bestGroundedRef: { current: GroundedFileChange[] },
): Promise<Partial<MultiFileHarnessStateType>> {
  const { mcpClient, taskId, projectRoot, maxRetries } = deps
  const last = state.messages[state.messages.length - 1]
  const rawText = typeof last?.content === "string" ? last.content : String(last?.content ?? "")
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()

  const salvageOrNull = (): MultiFileHarnessResult =>
    bestGroundedRef.current.length > 0 ? { files: bestGroundedRef.current, dropped: [] } : null

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    const attempts = state.attempts + 1
    if (attempts > maxRetries) return { params: salvageOrNull(), attempts }
    return {
      attempts,
      messages: [new HumanMessage(`Your last response was not valid JSON: ${errorMessageLocal(err)}. Respond again with ONLY the JSON object.`)],
    }
  }

  const refusalCheck = RefusalSchema.safeParse(parsed)
  if (refusalCheck.success) return { params: refusalCheck.data }

  if (
    isPlainObjectLocal(parsed) &&
    Array.isArray((parsed as Record<string, unknown>).files) &&
    (parsed as { files: unknown[] }).files.length > MAX_FILES_PER_EDIT
  ) {
    const count = (parsed as { files: unknown[] }).files.length
    const attempts = state.attempts + 1
    if (attempts > maxRetries) return { params: salvageOrNull(), attempts }
    return {
      attempts,
      messages: [new HumanMessage(`You proposed ${count} files, but at most ${MAX_FILES_PER_EDIT} files are allowed per proposal. Narrow your scope to the ${MAX_FILES_PER_EDIT} most essential files and respond again.`)],
    }
  }

  const proposalCheck = MultiFileProposalSchema.safeParse(parsed)
  if (!proposalCheck.success) {
    const issues = proposalCheck.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    const attempts = state.attempts + 1
    if (attempts > maxRetries) return { params: salvageOrNull(), attempts }
    return {
      attempts,
      messages: [new HumanMessage(`Your last response does not match the required shape: ${issues}. Respond again with the corrected JSON object.`)],
    }
  }

  // Path containment — a plainly invalid request, not a correctable
  // mistake, so this fails the whole harness immediately rather than
  // retrying (specs/114's own explicit design decision).
  for (const file of proposalCheck.data.files) {
    if (resolveContainedRelativePath(projectRoot, file.path) === null) {
      throw new Error(`Proposed path "${file.path}" is outside the project root — refusing.`)
    }
  }

  // Per-file grounding, independently, in parallel — a real
  // read_project_file call per file, never trusted from the model's own
  // claim.
  const groundedNow: GroundedFileChange[] = []
  const ungrounded: { path: string; reason: string }[] = []

  await Promise.all(
    proposalCheck.data.files.map(async (file) => {
      const relativePath = resolveContainedRelativePath(projectRoot, file.path)!
      if (file.action === "edit") {
        let content: string
        try {
          content = await mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path: relativePath }, taskId)
        } catch (err) {
          const message = errorMessageLocal(err)
          ungrounded.push({
            path: relativePath,
            reason: message.startsWith(PATH_NOT_FOUND_PREFIX)
              ? `file does not exist — use action "create" instead`
              : `cannot read file: ${message}`,
          })
          return
        }
        const occurrences = countOccurrences(content, file.old_text)
        if (occurrences === 1) {
          groundedNow.push({ path: relativePath, action: "edit", content: content.replace(file.old_text, file.new_text), previousContent: content })
        } else {
          ungrounded.push({
            path: relativePath,
            reason: occurrences === 0
              ? `"old_text" was not found verbatim in this file — quote it exactly as it appears`
              : `"old_text" appears ${occurrences} times in this file — ambiguous; include more surrounding context so it matches exactly once`,
          })
        }
      } else {
        try {
          await mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path: relativePath }, taskId)
          // A successful read means the path already exists — "create" is invalid.
          ungrounded.push({ path: relativePath, reason: `this file already exists — use action "edit" instead of "create"` })
        } catch (err) {
          const message = errorMessageLocal(err)
          if (message.startsWith(PATH_NOT_FOUND_PREFIX)) {
            groundedNow.push({ path: relativePath, action: "create", content: file.content })
          } else {
            ungrounded.push({ path: relativePath, reason: `cannot verify this path is free to create: ${message}` })
          }
        }
      }
    }),
  )

  if (groundedNow.length > bestGroundedRef.current.length) {
    bestGroundedRef.current = groundedNow
  }

  if (ungrounded.length === 0) {
    return { params: { files: groundedNow, dropped: [] } }
  }

  const attempts = state.attempts + 1
  if (attempts > maxRetries) {
    return {
      params: bestGroundedRef.current.length > 0
        ? { files: bestGroundedRef.current, dropped: ungrounded }
        : null,
      attempts,
    }
  }

  const feedback = ungrounded.map((u) => `- ${u.path}: ${u.reason}`).join("\n")
  return {
    attempts,
    messages: [new HumanMessage(`Some proposed files could not be verified:\n${feedback}\nRespond again with the corrected full JSON object (files that already verified correctly may be repeated unchanged).`)],
  }
}

export interface RunEditFilesHarnessOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  projectRoot: string
  instruction: string
  /** specs/137 — the user's full request when this is a plan step. */
  context?: string | null
  maxRetries?: number
}

export async function runEditFilesHarness(options: RunEditFilesHarnessOptions): Promise<MultiFileHarnessResult> {
  const { model, mcpClient, taskId, projectRoot, instruction, context } = options
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const tools = buildReadOnlyTools(mcpClient, taskId, projectRoot)

  if (typeof model.bindTools !== "function") {
    throw new Error("Configured chat model does not support tool binding (bindTools)")
  }
  const modelWithTools = model.bindTools(tools)

  async function agentNode(state: MultiFileHarnessStateType) {
    const response = await callProviderWithRetry(() => modelWithTools.invoke(state.messages))
    return { messages: [response] }
  }

  const toolNode = new ToolNode(tools)
  const bestGroundedRef: { current: GroundedFileChange[] } = { current: [] }

  function afterValidate(state: MultiFileHarnessStateType): "agent" | typeof END {
    const last = state.messages[state.messages.length - 1]
    const isRetryPrompt = last instanceof HumanMessage
    if (isRetryPrompt && state.attempts <= maxRetries) return "agent"
    return END
  }

  const graph = new StateGraph(MultiFileHarnessState)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addNode("validate", (state: MultiFileHarnessStateType) =>
      validateMultiFileNode(state, { mcpClient, taskId, projectRoot, maxRetries }, bestGroundedRef))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition, { tools: "tools", [END]: "validate" })
    .addEdge("tools", "agent")
    .addConditionalEdges("validate", afterValidate, { agent: "agent", [END]: END })
    .compile()

  try {
    const finalState = await graph.invoke(
      {
        messages: [new SystemMessage(buildEditFilesSystemPrompt(instruction, MAX_FILES_PER_EDIT, context)), new HumanMessage("Begin.")],
        params: null,
        attempts: 0,
      },
      { recursionLimit: HARNESS_RECURSION_LIMIT },
    )
    return (finalState.params as MultiFileHarnessResult) ?? null
  } catch (err) {
    if (err instanceof GraphRecursionError) {
      throw new Error(
        `The edit-files harness could not converge on a proposal within ${HARNESS_RECURSION_LIMIT} tool-call rounds — try a narrower, more specific instruction naming exactly what should change.`,
      )
    }
    throw err
  }
}

// ============================================================
// VERIFICATION COMMAND PROPOSAL — specs/119-coder-verify-loop-and-
// reviewer-depth/spec.md Part B
//
// A third, sibling entry point to this file's two edit-proposal
// harnesses above, sharing the exact same read-only tool set
// (READ_ONLY_TOOL_NAMES, unchanged) and general retry-with-feedback
// shape. This harness never writes and never executes anything itself —
// it only proposes an argv, the same "deterministic-explicit-or-
// harness-proposed shape" specs/080 already established for run-command.
// The actual execution happens only after human approval, via the
// shared run_command MCP tool, in index.ts's own resume path.
//
// Called once per loop iteration (specs/119 Part B step 3), so it can
// genuinely reconsider the command after a fix — in the common case it
// re-proposes the identical argv, which index.ts's own B1 comparison
// (exact array equality) then recognizes as already-approved and skips
// the redundant prompt; a real divergence always forces a fresh one.
// ============================================================
export const VerifyCommandProposalSchema = z.object({
  argv: z.array(z.string()).min(1),
  reason: z.string().min(1),
})
export type VerifyCommandProposal = z.infer<typeof VerifyCommandProposalSchema>

function buildVerifyCommandSystemPrompt(
  instruction: string,
  priorFailure?: { argv: string[]; output: string },
): string {
  const lines = [
    `You are the Coder component of OrchestrAI. An edit was just made (or is about to be made) to satisfy: "${instruction}".`,
    `Propose a real command that will VERIFY this change is correct — for example, running the project's own test suite, a type-checker, or a build. You may call read_project_file (e.g. to check package.json's own scripts, or a Makefile) and analyze_project/git_status/git_diff as needed to determine the real, correct command for this specific project — never guess without looking.`,
  ]
  if (priorFailure) {
    lines.push(
      `A previous iteration already ran "${priorFailure.argv.join(" ")}" and it failed with this real output:`,
      `--- prior output ---`,
      priorFailure.output,
      `--- end of prior output ---`,
      `An edit was just made to address that failure. Propose the command to re-verify — reuse the exact same command if it is still the right one, or propose a different one only if the fix genuinely requires a different verification step.`,
    )
  }
  lines.push(
    `Respond with the real argv as a plain array — e.g. ["bun", "test"] — never a shell string, never shell operators (&&, |, ;, >), one real executable and its real arguments. This will be shown to a human for approval before it ever runs.`,
    `Respond with ONLY a single JSON object matching this shape: { "argv": [<string>, ...], "reason": <short string explaining why this command verifies the change> }. No other text, no markdown code fence.`,
  )
  return lines.join("\n")
}

const VerifyCommandState = Annotation.Root({
  ...MessagesAnnotation.spec,
  params: Annotation<VerifyCommandProposal | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  attempts: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
})
type VerifyCommandStateType = typeof VerifyCommandState.State

export interface RunVerifyCommandHarnessOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  projectRoot: string
  instruction: string
  /** Set only from iteration 2 onward — the previous iteration's own
   *  real verification failure, so the model can decide whether the
   *  same command is still right rather than guessing blind. */
  priorFailure?: { argv: string[]; output: string }
  maxRetries?: number
}

export async function runVerifyCommandHarness(options: RunVerifyCommandHarnessOptions): Promise<VerifyCommandProposal | null> {
  const { model, mcpClient, taskId, projectRoot, instruction, priorFailure } = options
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const tools = buildReadOnlyTools(mcpClient, taskId, projectRoot)

  if (typeof model.bindTools !== "function") {
    throw new Error("Configured chat model does not support tool binding (bindTools)")
  }
  const modelWithTools = model.bindTools(tools)

  async function agentNode(state: VerifyCommandStateType) {
    const response = await callProviderWithRetry(() => modelWithTools.invoke(state.messages))
    return { messages: [response] }
  }

  const toolNode = new ToolNode(tools)

  function validateNode(state: VerifyCommandStateType) {
    const last = state.messages[state.messages.length - 1]
    const rawText = typeof last?.content === "string" ? last.content : String(last?.content ?? "")
    const result = validateJsonParams(rawText, VerifyCommandProposalSchema)
    if (result.ok) return { params: result.params ?? null }

    const attempts = state.attempts + 1
    if (attempts > maxRetries) return { params: null, attempts }
    return {
      attempts,
      messages: [new HumanMessage(`Your last response was invalid: ${result.error}\nRespond again with the corrected JSON object only.`)],
    }
  }

  function afterValidate(state: VerifyCommandStateType): "agent" | typeof END {
    const last = state.messages[state.messages.length - 1]
    const isRetryPrompt = last instanceof HumanMessage
    if (isRetryPrompt && state.attempts <= maxRetries) return "agent"
    return END
  }

  const graph = new StateGraph(VerifyCommandState)
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
        messages: [new SystemMessage(buildVerifyCommandSystemPrompt(instruction, priorFailure)), new HumanMessage("Begin.")],
        params: null,
        attempts: 0,
      },
      { recursionLimit: HARNESS_RECURSION_LIMIT },
    )
    return (finalState.params as VerifyCommandProposal | null) ?? null
  } catch (err) {
    if (err instanceof GraphRecursionError) {
      throw new Error(
        `The verify-command harness could not converge on a proposal within ${HARNESS_RECURSION_LIMIT} tool-call rounds.`,
      )
    }
    throw err
  }
}
