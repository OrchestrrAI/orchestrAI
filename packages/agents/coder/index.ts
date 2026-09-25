import { splitPlanStepText } from "../../shared/plan-step-text"
import { Hono } from "hono"
import { serve } from "bun"
import * as path from "path"
import { resolveTargetPath, stripPathPhrases } from "../../shared"
import { resolveServicePort } from "../../shared/service-ports"
import { parseTaskEnvelope, readJsonBody, validateSelectedSkillOwnership, type ValidatedTask } from "../../shared/task-envelope"
import { newActionId, validateActionId, computeContentFingerprint, type ApprovalPreview } from "../../shared/approval"
import { PATH_NOT_FOUND_PREFIX } from "../../shared/write-preflight"
import { OrchestraiMcpClient } from "../../shared/mcp-client"
import {
  buildChatModel,
  describeLlmModelConfig,
  isHarnessFlagSet,
  readLlmHarnessConfig,
  readLlmHarnessStartupState,
} from "./model-factory"
import { runEditFileHarness, runEditFilesHarness } from "./llm-harness"
import {
  MAX_VERIFY_ITERATIONS,
  VERIFY_COMMAND_TIMEOUT_MS,
  hasApprovedArgv,
  checkDrift,
  writeFiles,
  runVerificationAndAdvance,
  proposeVerificationCommand,
  type VerifyIterationRecord,
  type VerificationAdvanceResult,
} from "./verify-loop"
import { startTaskPersistenceSweep } from "../../shared/store"
import { flushAuditBufferForShutdown } from "../../shared/audit"
import { z } from "zod"
import { persistPendingAction, claimPendingAction, forgetPendingAction, restorePendingActions } from "../../shared/pending-action-store"

// ============================================================
// TYPES
// ============================================================
type TaskStatus = "submitted" | "working" | "completed" | "failed" | "input-required"

interface TaskResult {
  id: string
  status: TaskStatus
  result?: string
  error?: string
  requiresApproval?: boolean
  step?: string
  approval?: ApprovalPreview
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ============================================================
// AGENT CARD
// ============================================================
// specs/048-guided-init-experience/spec.md: exported so the setup form's
// display-only agent-catalog test can assert against the real skill ids
// rather than a hand-copied guess. No behavior change — still only ever
// served live via GET /.well-known/agent.json for anything routing-related.
export const agentCard = {
  name: "coder-agent",
  description: "Proposes a precise, anchored edit to one real file, approved as a content diff before anything is written — v1 (single-file, single-hunk; see specs/083's own Future Upgrade Path)",
  url: `http://localhost:${resolveServicePort("coder")}`,
  version: "1.0.0",
  skills: [
    {
      id: "edit-file",
      name: "Edit File",
      // specs/133 — within MAX_SKILL_DESCRIPTION_BYTES (300); the router
      // reads this to tell edit-file from edit-files (specs/121).
      description: "Propose a precise, grounded edit to ONE existing file (an exact, uniquely-occurring span replaced with new content), shown as a content diff, human-approved before it's written. For two or more files, use edit-files instead.",
      examples: ["edit src/foo.ts: fix the off-by-one in the loop bound", "modify src/utils.ts to rename processData to transformData"],
    },
    {
      // specs/114-coder-multi-file-edit-and-create/spec.md — a second,
      // additive skill alongside the untouched edit-file above. No
      // explicit file list is required: the model explores the real
      // project itself (read_project_file/analyze_project/git_status/
      // git_diff) to decide which files need touching, including
      // creating new files. Bounded, human-approved, exactly like
      // edit-file.
      id: "edit-files",
      name: "Edit Files",
      description: "Propose a coherent, potentially multi-file change from a free-form instruction — the model explores the real project (read_project_file/analyze_project/git_status/git_diff) to decide which files need touching, including creating new files, and every edit is shown as a content diff and requires human approval before anything is written. Bounded to 6 files per proposal.",
      examples: ["edit-files at C:\\path: rename the Logger class to AppLogger everywhere it's used", "edit-files at C:\\path: extract the shared validation logic in src/routes into a new src/validation.ts module"],
    },
    {
      // specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part B — a
      // third, additive skill: the same multi-file proposal path as
      // edit-files, but followed by a real, human-approved verification
      // command; a real failure feeds back into a follow-up fix, bounded
      // at MAX_VERIFY_ITERATIONS. Every write keeps its own individual
      // approval; only a byte-identical command re-run within the same
      // task skips a redundant prompt (specs/119's own Resolved Decision
      // B1) — never a write.
      id: "edit-and-verify",
      name: "Edit and Verify",
      description: "Propose a coherent, potentially multi-file change, then propose and run a real verification command (e.g. the project's tests) — a genuine failure feeds back into a follow-up fix, bounded at 3 iterations. Every edit and the first run of any distinct command is individually human-approved; only a byte-identical command re-run within the same task skips a redundant prompt.",
      examples: ["edit-and-verify at C:\\path: fix the off-by-one bug in src/foo.ts and confirm the tests pass", "edit-and-verify at C:\\path: rename processData to transformData everywhere and verify the build still succeeds"],
    },
  ],
}

// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md —
// derived from the Agent Card above, never a separate hand-maintained
// list, so ownership can never drift from what this agent advertises.
const OWNED_SKILL_IDS = new Set(agentCard.skills.map((s) => s.id))

// ============================================================
// TASK STORE
// ============================================================
const tasks = new Map<string, TaskResult>()

// specs/107-task-and-conversation-history/spec.md B4 — Coder's own
// TaskResult carries no skill/createdAt, so a small side map records
// both at the one place processTask() already computes them (its own
// selectedSkill-or-detectSkill() line), rather than threading two new
// fields through every existing tasks.set() call site in this file.
const taskMeta = new Map<string, { skill: string; createdAt: number }>()

const mcpClient = new OrchestraiMcpClient({
  callerName: "coder-agent",
  // specs/101-per-agent-tool-access-expansion/spec.md — analyze_project/
  // git_status/git_diff added alongside the pre-existing read_project_file/
  // write_project_file: the uniform general-inspection set every
  // code-reasoning agent now gets, bound read-only in the harness (see
  // llm-harness.ts) so edit-file can see uncommitted work and real
  // project structure before proposing an anchored edit.
  // specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part B —
  // run_command/run_tests added alongside the pre-existing set, shared
  // with Testing/DevOps (specs/101 is explicit that skill-ownership
  // rules govern skill ids, never tool access). Bound ONLY to the
  // approval-gated execution path in resumeEditAndVerifyCommandAction()
  // (via verify-loop.ts's runVerificationAndAdvance()) — never to the
  // proposal harness, whose READ_ONLY_TOOL_NAMES allow-list in
  // llm-harness.ts is unchanged and stays structurally enforced.
  requiredTools: ["read_project_file", "write_project_file", "analyze_project", "git_status", "git_diff", "run_command"], // specs/138: run_tests removed
})

// specs/083-coder-agent/spec.md §1 — one skill only, so there is no
// ordering hazard to resolve against a sibling skill. Used only when a
// task arrives with no selectedSkill (e.g. a direct-to-agent submission
// bypassing the Orchestrator's own live LLM router, specs/065).
function detectSkill(text: string): string {
  const lower = text.toLowerCase()
  // specs/119 — checked BEFORE edit-files: "edit-and-verify" does not
  // contain the substring "edit-files", so order doesn't strictly
  // matter today, but checking the more specific trigger first is the
  // safer convention if either phrase is ever widened later.
  if (lower.includes("edit-and-verify")) return "edit-and-verify"
  // specs/114 — a narrow, best-effort heuristic is all this needs
  // (direct-to-agent dispatch only, bypassing the Orchestrator's own
  // live LLM router, specs/065): the skill id itself is the trigger,
  // matching every example in this skill's own Agent Card.
  if (lower.includes("edit-files")) return "edit-files"
  const hasTrigger = lower.includes("edit ") || lower.includes("modify ") || lower.includes("change ")
  const hasFileHint = /\.\w+/.test(text)
  if (hasTrigger && hasFileHint) return "edit-file"
  return "unknown"
}

// ============================================================
// edit-file
// ============================================================
// Deliberately narrow parsing, mirroring specs/081's write-tests own
// extractSourceFileToken() exactly — extractExplicitTargetPath()/
// resolveTargetPath() already own resolving the whole PROJECT root;
// this owns only the specific FILE named after one of the trigger
// words detectSkill() itself checks for. Requires a real extension (a
// dot) so ordinary prose isn't mistaken for a path.
function extractTargetFileToken(text: string): string | null {
  const match = text.match(/\b(?:edit|modify|change)\s+([^\s]+\.\w+)/i)
  return match?.[1] ?? null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// specs/083 §6 step 3 — there is no sensible default instruction for
// "edit this file" alone; the free-text description of what to change
// is whatever remains of the task text once the project-path clause
// (stripPathPhrases(), the same helper the semantic classifier and
// DevOps's own extractCommitMessage() already use for the identical
// reason) and the "edit/modify/change <file>" trigger phrase are both
// removed.
function extractInstruction(text: string, fileToken: string): string | null {
  const withoutPath = stripPathPhrases(text)
  const triggerPattern = new RegExp(`\\b(?:edit|modify|change)\\s+${escapeRegExp(fileToken)}\\b`, "i")
  const withoutTrigger = withoutPath.replace(triggerPattern, "").trim()
  const cleaned = withoutTrigger.replace(/^[:\-]\s*/, "").replace(/^to\s+/i, "").trim()
  return cleaned.length > 0 ? cleaned : null
}

// specs/083-coder-agent/spec.md — the single write-capable action this
// agent can ever produce. A discriminated union of one variant, kept
// for consistency with every other agent's own PendingAction shape
// (specs/080/081) rather than collapsing it — a second variant (e.g. a
// future create-file skill, named in this spec's own Future Upgrade
// Path) can then be added the same low-risk way those specs already
// demonstrate.
interface EditFileAction {
  actionId: string
  source: "edit-file"
  projectRoot: string
  relativePath: string
  instruction: string
  // specs/040/056 — computed once at preview time, reused verbatim at
  // write time; fingerprint re-verified immediately before the real
  // write in resumeTask(), the same drift guarantee every other
  // write-capable skill in this codebase already has.
  content: string
  previousContent: string
  fingerprint: string
}

// specs/114-coder-multi-file-edit-and-create/spec.md — the second
// variant this discriminated union was always designed for. One entry
// per grounded file, each carrying its own fingerprint (computed the
// same way EditFileAction's single fingerprint already is —
// computeContentFingerprint(previousContent), with the "absent"
// sentinel naturally covering a "create").
interface EditFilesFileEntry {
  path: string
  action: "edit" | "create"
  content: string
  previousContent?: string
  fingerprint: string
}

interface EditFilesAction {
  actionId: string
  source: "edit-files"
  projectRoot: string
  instruction: string
  files: EditFilesFileEntry[]
  // specs/114 — files the harness proposed but couldn't ground after
  // exhausting retries, salvaged out of the batch rather than failing
  // the whole task; surfaced in the approval preview's own risks and in
  // the completed result, never silently dropped.
  dropped: { path: string; reason: string }[]
}

// specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part B — two
// more variants for the edit-and-verify loop. Deliberately carries the
// WHOLE loop's own state (iteration, approvedArgvs, history) on each
// pending action's own persisted payload, rather than inventing a
// second, separate store keyed by taskId: specs/110's existing
// persistPendingAction()/restorePendingActions() machinery then covers
// the loop's state across a restart for free, with zero new schema.
interface EditAndVerifyEditAction {
  actionId: string
  source: "edit-and-verify-edit"
  projectRoot: string
  originalInstruction: string
  // 1 = the initial edit; 2+ = a follow-up fix after a failed verification.
  iteration: number
  // specs/119's own Resolved Decision B1 — every argv a human has
  // already approved IN THIS TASK. Never persisted anywhere but on this
  // task's own pending-action payload, so it cannot outlive the task or
  // cross into another one.
  approvedArgvs: string[][]
  history: VerifyIterationRecord[]
  files: EditFilesFileEntry[]
  dropped: { path: string; reason: string }[]
  // specs/139 D — in a plan, the user's full request (specs/137), carried
  // so every fix iteration keeps it as background. Absent on direct tasks
  // and on rows persisted before this field existed.
  planContext?: string
}

interface EditAndVerifyCommandAction {
  actionId: string
  source: "edit-and-verify-command"
  projectRoot: string
  originalInstruction: string
  iteration: number
  approvedArgvs: string[][]
  history: VerifyIterationRecord[]
  argv: string[]
  // Which files this iteration's already-written edit touched — carried
  // through so the final report can name them once the command finishes.
  filesWrittenThisIteration: string[]
  planContext?: string // specs/139 D
}

type PendingAction = EditFileAction | EditFilesAction | EditAndVerifyEditAction | EditAndVerifyCommandAction
const pendingActions = new Map<string, PendingAction>()

// specs/110-approval-state-survives-a-restart/spec.md B3/B6 — the exact
// runtime shape of EditFileAction, used to validate a restored row's
// JSON.parse()'d payload. A row that fails this is discarded, never
// partially trusted (see pending-action-store.ts's own restorePendingActions()).
const EditFileActionSchema = z.object({
  actionId: z.string(),
  source: z.literal("edit-file"),
  projectRoot: z.string(),
  relativePath: z.string(),
  instruction: z.string(),
  content: z.string(),
  previousContent: z.string(),
  fingerprint: z.string(),
})

const EditFilesActionSchema = z.object({
  actionId: z.string(),
  source: z.literal("edit-files"),
  projectRoot: z.string(),
  instruction: z.string(),
  files: z.array(z.object({
    path: z.string(),
    action: z.enum(["edit", "create"]),
    content: z.string(),
    previousContent: z.string().optional(),
    fingerprint: z.string(),
  })),
  dropped: z.array(z.object({ path: z.string(), reason: z.string() })),
})

// specs/119-coder-verify-loop-and-reviewer-depth/spec.md — the exact
// runtime shape of the two new PendingAction variants, validated the
// same strict, fail-closed way as every existing one (specs/110 B3/B6):
// a restored row that fails this is discarded, never partially trusted.
const VerifyIterationRecordSchema = z.object({
  iteration: z.number(),
  filesWritten: z.array(z.string()),
  commandArgv: z.array(z.string()),
  commandOutput: z.string(),
  commandSucceeded: z.boolean(),
})

const EditAndVerifyEditActionSchema = z.object({
  actionId: z.string(),
  source: z.literal("edit-and-verify-edit"),
  projectRoot: z.string(),
  originalInstruction: z.string(),
  iteration: z.number(),
  approvedArgvs: z.array(z.array(z.string())),
  history: z.array(VerifyIterationRecordSchema),
  files: z.array(z.object({
    path: z.string(),
    action: z.enum(["edit", "create"]),
    content: z.string(),
    previousContent: z.string().optional(),
    fingerprint: z.string(),
  })),
  dropped: z.array(z.object({ path: z.string(), reason: z.string() })),
  planContext: z.string().optional(), // specs/139 D — optional: pre-139 rows stay valid
})

const EditAndVerifyCommandActionSchema = z.object({
  actionId: z.string(),
  source: z.literal("edit-and-verify-command"),
  projectRoot: z.string(),
  originalInstruction: z.string(),
  iteration: z.number(),
  approvedArgvs: z.array(z.array(z.string())),
  history: z.array(VerifyIterationRecordSchema),
  argv: z.array(z.string()),
  filesWrittenThisIteration: z.array(z.string()),
  planContext: z.string().optional(), // specs/139 D
})

// specs/119 review round 1, finding 1 — exported (like agentCard above) so
// the B1 restart adversarial tests in verify-loop.test.ts validate restored
// payloads with the REAL schema: the exact strict, fail-closed gate
// restoreApprovalsOnStartup() itself applies, never a hand-copied guess at
// the shape that could drift from it.
export const PendingActionSchema = z.union([EditFileActionSchema, EditFilesActionSchema, EditAndVerifyEditActionSchema, EditAndVerifyCommandActionSchema])

function buildApprovalPreview(action: PendingAction): ApprovalPreview {
  if (action.source === "edit-and-verify-edit") {
    const editCount = action.files.filter((f) => f.action === "edit").length
    const createCount = action.files.filter((f) => f.action === "create").length
    const parts: string[] = []
    if (editCount > 0) parts.push(`${editCount} edit${editCount === 1 ? "" : "s"}`)
    if (createCount > 0) parts.push(`${createCount} new`)
    const isFix = action.iteration > 1
    const risks = [
      isFix
        ? `AI-proposed FIX (iteration ${action.iteration} of ${MAX_VERIFY_ITERATIONS}) after a failed verification — changes program behavior across several files. Review every file's diff carefully before approving.`
        : "AI-proposed multi-file code change — changes program behavior across several files, not just one. Review every file's diff carefully before approving.",
      "No sandbox or rollback beyond git itself — approving this writes directly to every listed file on disk.",
      "A real verification command will be proposed and run AFTER this write is approved — approving this edit does not yet run anything.",
    ]
    if (action.dropped.length > 0) {
      risks.push(
        `${action.dropped.length} originally-proposed file(s) were dropped after failing grounding and are NOT included in this write: ${action.dropped.map((d) => `${d.path} (${d.reason})`).join("; ")}`,
      )
    }
    return {
      actionId: action.actionId,
      kind: "file-write",
      summary: isFix
        ? `Edit-and-verify fix (iteration ${action.iteration}/${MAX_VERIFY_ITERATIONS}): ${action.originalInstruction}`
        : `Edit-and-verify: ${action.originalInstruction}`,
      target: `${action.files.length} file${action.files.length === 1 ? "" : "s"} (${parts.join(", ")})`,
      overwrite: true,
      files: action.files.map((f) => ({
        target: path.join(action.projectRoot, f.path),
        action: f.action,
        content: f.content,
        previousContent: f.previousContent,
        fingerprint: f.fingerprint,
      })),
      risks,
    }
  }

  if (action.source === "edit-and-verify-command") {
    const isReVerify = action.iteration > 1
    return {
      actionId: action.actionId,
      kind: "command",
      summary: `Run verification command (iteration ${action.iteration}/${MAX_VERIFY_ITERATIONS}): "${action.argv.join(" ")}"`,
      target: action.projectRoot,
      executable: action.argv[0],
      argv: action.argv,
      cwd: action.projectRoot,
      timeoutMs: VERIFY_COMMAND_TIMEOUT_MS,
      risks: [
        isReVerify
          ? "Re-verifying after a fix — this command was already approved and run at least once earlier in this task with a different (or the same) argv now genuinely differing, which is why this is a fresh approval."
          : "AI-proposed verification command — will run with the current OS user's permissions.",
        "No sandbox or rollback — an approved command may mutate files, start child processes, or use the network.",
        "A genuine failure will propose a follow-up fix and ask for approval again, bounded at " + MAX_VERIFY_ITERATIONS + " total edit iterations.",
      ],
    }
  }

  if (action.source === "edit-files") {
    const editCount = action.files.filter((f) => f.action === "edit").length
    const createCount = action.files.filter((f) => f.action === "create").length
    const parts: string[] = []
    if (editCount > 0) parts.push(`${editCount} edit${editCount === 1 ? "" : "s"}`)
    if (createCount > 0) parts.push(`${createCount} new`)
    const risks = [
      "AI-proposed multi-file code change — changes program behavior across several files, not just one. Review every file's diff carefully before approving.",
      "No sandbox or rollback beyond git itself — approving this writes directly to every listed file on disk.",
    ]
    if (action.dropped.length > 0) {
      risks.push(
        `${action.dropped.length} originally-proposed file(s) were dropped after failing grounding and are NOT included in this write: ${action.dropped.map((d) => `${d.path} (${d.reason})`).join("; ")}`,
      )
    }
    return {
      actionId: action.actionId,
      kind: "file-write",
      summary: `Multi-file edit: ${action.instruction}`,
      target: `${action.files.length} file${action.files.length === 1 ? "" : "s"} (${parts.join(", ")})`,
      overwrite: true,
      files: action.files.map((f) => ({
        target: path.join(action.projectRoot, f.path),
        action: f.action,
        content: f.content,
        previousContent: f.previousContent,
        fingerprint: f.fingerprint,
      })),
      risks,
    }
  }

  return {
    actionId: action.actionId,
    kind: "file-write",
    summary: `Edit "${action.relativePath}": ${action.instruction}`,
    target: path.join(action.projectRoot, action.relativePath),
    overwrite: true,
    content: action.content,
    previousContent: action.previousContent,
    fingerprint: action.fingerprint,
    risks: [
      "AI-proposed code edit — changes program behavior, not just documentation or test content. Review the diff carefully before approving.",
      "No sandbox or rollback beyond git itself — approving this writes directly to the file on disk.",
    ],
  }
}

async function handleEditFileSkill(taskId: string, text: string): Promise<void> {
  // specs/137 — in a plan, act on the step only; the full request is
  // background. The project root still resolves from the whole text.
  const { step, context } = splitPlanStepText(text)
  const fileToken = extractTargetFileToken(step)
  if (!fileToken) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: 'No file named — expected e.g. "edit src/foo.ts: <what to change>". edit-file never guesses which file to edit.',
    })
    return
  }

  const instruction = extractInstruction(step, fileToken)
  if (!instruction) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: 'No description of the requested change — expected e.g. "edit src/foo.ts: fix the off-by-one in the loop bound". edit-file never guesses what to change.',
    })
    return
  }

  let projectRoot: string
  try {
    projectRoot = resolveTargetPath(text)
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: errorMessage(err) })
    return
  }

  const targetAbs = path.isAbsolute(fileToken) ? fileToken : path.join(projectRoot, fileToken)
  const relativePath = path.relative(projectRoot, targetAbs)
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `Target file "${fileToken}" is outside the project root "${projectRoot}"` })
    return
  }

  if (!isHarnessFlagSet()) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "edit-file requires ORCHESTRAI_CODER_LLM_HARNESS=1 — there is no deterministic fallback for proposing a code edit.",
    })
    return
  }
  const config = readLlmHarnessConfig()
  if (!config) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "ORCHESTRAI_CODER_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — failing closed rather than guessing an edit.",
    })
    return
  }

  let fileContent: string
  try {
    fileContent = await mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path: relativePath }, taskId)
  } catch (err) {
    const message = errorMessage(err)
    if (message.startsWith(PATH_NOT_FOUND_PREFIX)) {
      tasks.set(taskId, { id: taskId, status: "failed", error: `Target file "${relativePath}" does not exist — edit-file requires an existing file to edit (see specs/083's own Future Upgrade Path for new-file creation).` })
      return
    }
    tasks.set(taskId, { id: taskId, status: "failed", error: `Cannot read target file "${relativePath}": ${message}` })
    return
  }

  let content: string
  try {
    const model = await buildChatModel(config)
    console.log(`[coder-agent] llm harness (edit-file): ${describeLlmModelConfig(config)}`)
    const result = await runEditFileHarness({
      model, mcpClient, taskId, projectRoot,
      relativePath, fileContent, instruction, context,
    })
    if (!result) {
      tasks.set(taskId, { id: taskId, status: "failed", error: "the model's response could not be validated after retries (grounding check failed)." })
      return
    }
    // specs/098-harness-recursion-limit-and-clean-failure/spec.md — a
    // real, structural refusal ("this can't be validly done in this
    // file's own syntax") is surfaced with the model's own real reason,
    // distinct from the generic grounding-failure message above.
    if ("refused" in result) {
      tasks.set(taskId, { id: taskId, status: "failed", error: `Cannot make this edit: ${result.reason}` })
      return
    }
    // old_text is guaranteed to occur exactly once in fileContent (the
    // harness's own grounding validator already confirmed this before
    // returning), so a plain first-occurrence String.replace() is exact
    // and unambiguous.
    content = fileContent.replace(result.old_text, result.new_text)
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `LLM harness run failed: ${errorMessage(err)}` })
    return
  }

  const fingerprint = computeContentFingerprint(fileContent)
  const action: EditFileAction = {
    actionId: newActionId(),
    source: "edit-file",
    projectRoot,
    relativePath,
    instruction,
    content,
    previousContent: fileContent,
    fingerprint,
  }
  pendingActions.set(taskId, action)
  // specs/110-approval-state-survives-a-restart/spec.md B3 — persisted
  // alongside the in-memory Map so an agent restart doesn't silently
  // strand this approval; fail-open (a no-op) when persistence is off.
  persistPendingAction({ agent: "coder-agent", taskId, actionId: action.actionId, kind: "write", skill: "edit-file", payload: action })
  tasks.set(taskId, {
    id: taskId, status: "input-required",
    requiresApproval: true,
    step: `waiting for human approval — will edit: ${relativePath}`,
    approval: buildApprovalPreview(action),
  })
}

// ============================================================
// edit-files
// ============================================================
// specs/114-coder-multi-file-edit-and-create/spec.md — deliberately no
// per-file parsing here: the free-form instruction is whatever remains
// of the task text once the project-path clause and the "edit-files"
// trigger itself are removed. Which files need touching is the model's
// own job, decided from its own read-only tool calls inside the
// harness — never guessed here.
function extractMultiFileInstruction(text: string): string | null {
  const withoutPath = stripPathPhrases(text)
  const withoutTrigger = withoutPath.replace(/\bedit-files\b/i, "").trim()
  const cleaned = withoutTrigger.replace(/^[:\-]\s*/, "").trim()
  return cleaned.length > 0 ? cleaned : null
}

async function handleEditFilesSkill(taskId: string, text: string): Promise<void> {
  // specs/137 — the step is the instruction; the full request is background.
  const { step, context } = splitPlanStepText(text)
  const instruction = extractMultiFileInstruction(step)
  if (!instruction) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: 'No description of the requested change — expected e.g. "edit-files at C:\\path: <what to change>". edit-files never guesses what to change.',
    })
    return
  }

  let projectRoot: string
  try {
    projectRoot = resolveTargetPath(text)
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: errorMessage(err) })
    return
  }

  if (!isHarnessFlagSet()) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "edit-files requires ORCHESTRAI_CODER_LLM_HARNESS=1 — there is no deterministic fallback for proposing a multi-file code change.",
    })
    return
  }
  const config = readLlmHarnessConfig()
  if (!config) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "ORCHESTRAI_CODER_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — failing closed rather than guessing a multi-file edit.",
    })
    return
  }

  let result: Awaited<ReturnType<typeof runEditFilesHarness>>
  try {
    const model = await buildChatModel(config)
    console.log(`[coder-agent] llm harness (edit-files): ${describeLlmModelConfig(config)}`)
    result = await runEditFilesHarness({ model, mcpClient, taskId, projectRoot, instruction, context })
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `LLM harness run failed: ${errorMessage(err)}` })
    return
  }

  if (!result) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "the model's response could not be validated after retries — no file could be grounded (every proposed file failed its own grounding check).",
    })
    return
  }
  if ("refused" in result) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `Cannot make this change: ${result.reason}` })
    return
  }

  const fileEntries: EditFilesFileEntry[] = result.files.map((f) => ({
    path: f.path,
    action: f.action,
    content: f.content,
    previousContent: f.previousContent,
    fingerprint: computeContentFingerprint(f.previousContent),
  }))

  const action: EditFilesAction = {
    actionId: newActionId(),
    source: "edit-files",
    projectRoot,
    instruction,
    files: fileEntries,
    dropped: result.dropped,
  }
  pendingActions.set(taskId, action)
  // specs/110 B3 — the same persistence guarantee edit-file already has.
  persistPendingAction({ agent: "coder-agent", taskId, actionId: action.actionId, kind: "write", skill: "edit-files", payload: action })
  const editCount = fileEntries.filter((f) => f.action === "edit").length
  const createCount = fileEntries.filter((f) => f.action === "create").length
  tasks.set(taskId, {
    id: taskId, status: "input-required",
    requiresApproval: true,
    step: `waiting for human approval — will write ${fileEntries.length} file(s) (${editCount} edit, ${createCount} new)`,
    approval: buildApprovalPreview(action),
  })
}

// ============================================================
// edit-and-verify — specs/119-coder-verify-loop-and-reviewer-depth/spec.md
// ============================================================
// specs/119 Part B step 1 — reuses runEditFilesHarness() verbatim for the
// initial edit (this function's own job) AND for every follow-up fix
// (verify-loop.ts's runVerificationAndAdvance(), a different instruction
// string, the identical function). No new proposal path exists anywhere
// in this skill.
function extractVerifyInstruction(text: string): string | null {
  const withoutPath = stripPathPhrases(text)
  const withoutTrigger = withoutPath.replace(/\bedit-and-verify\b/i, "").trim()
  const cleaned = withoutTrigger.replace(/^[:\-]\s*/, "").trim()
  return cleaned.length > 0 ? cleaned : null
}

async function handleEditAndVerifySkill(taskId: string, text: string): Promise<void> {
  // specs/137 — the step is the instruction; the full request is background.
  const { step, context } = splitPlanStepText(text)
  const instruction = extractVerifyInstruction(step)
  if (!instruction) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: 'No description of the requested change — expected e.g. "edit-and-verify at C:\\path: <what to change>". edit-and-verify never guesses what to change.',
    })
    return
  }

  let projectRoot: string
  try {
    projectRoot = resolveTargetPath(text)
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: errorMessage(err) })
    return
  }

  if (!isHarnessFlagSet()) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "edit-and-verify requires ORCHESTRAI_CODER_LLM_HARNESS=1 — there is no deterministic fallback for proposing a code edit or a verification command.",
    })
    return
  }
  const config = readLlmHarnessConfig()
  if (!config) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "ORCHESTRAI_CODER_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — failing closed rather than guessing a multi-file edit.",
    })
    return
  }

  let result: Awaited<ReturnType<typeof runEditFilesHarness>>
  try {
    const model = await buildChatModel(config)
    console.log(`[coder-agent] llm harness (edit-and-verify, iteration 1): ${describeLlmModelConfig(config)}`)
    result = await runEditFilesHarness({ model, mcpClient, taskId, projectRoot, instruction, context })
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `LLM harness run failed: ${errorMessage(err)}` })
    return
  }

  if (!result) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "the model's response could not be validated after retries — no file could be grounded (every proposed file failed its own grounding check).",
    })
    return
  }
  if ("refused" in result) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `Cannot make this change: ${result.reason}` })
    return
  }

  const fileEntries: EditFilesFileEntry[] = result.files.map((f) => ({
    path: f.path,
    action: f.action,
    content: f.content,
    previousContent: f.previousContent,
    fingerprint: computeContentFingerprint(f.previousContent),
  }))

  const action: EditAndVerifyEditAction = {
    actionId: newActionId(),
    source: "edit-and-verify-edit",
    projectRoot,
    originalInstruction: instruction,
    iteration: 1,
    approvedArgvs: [],
    history: [],
    files: fileEntries,
    dropped: result.dropped,
    ...(context ? { planContext: context } : {}),
  }
  pendingActions.set(taskId, action)
  persistPendingAction({ agent: "coder-agent", taskId, actionId: action.actionId, kind: "write", skill: "edit-and-verify", payload: action })
  const editCount = fileEntries.filter((f) => f.action === "edit").length
  const createCount = fileEntries.filter((f) => f.action === "create").length
  tasks.set(taskId, {
    id: taskId, status: "input-required",
    requiresApproval: true,
    step: `waiting for human approval — will write ${fileEntries.length} file(s) (${editCount} edit, ${createCount} new), then propose a verification command`,
    approval: buildApprovalPreview(action),
  })
}

// specs/119 — the identical post-outcome handling for BOTH call sites
// that can reach a runVerificationAndAdvance() result: the edit-side
// resume (a B1-matched argv skipping straight to execution) and the
// command-side resume (a freshly approved argv). Factored once so the
// three outcomes (completed / failed / next-edit) are handled exactly
// the same way regardless of which path reached them.
async function handleVerificationOutcome(
  id: string,
  projectRoot: string,
  originalInstruction: string,
  outcome: VerificationAdvanceResult,
  planContext?: string,
): Promise<void> {
  if (outcome.kind === "completed") {
    tasks.set(id, { id, status: "completed", result: outcome.result })
    forgetPendingAction({ agent: "coder-agent", taskId: id })
    return
  }
  if (outcome.kind === "failed") {
    tasks.set(id, { id, status: "failed", error: outcome.error })
    forgetPendingAction({ agent: "coder-agent", taskId: id })
    return
  }

  // next-edit — a fresh actionId for the follow-up fix, per specs/119
  // Part B step 6 ("the loop returns to step 2 ... with a fresh
  // actionId"). Persisting this OVERWRITES the just-claimed, now-stale
  // row for the same (agent, taskId) via upsertPendingAction()'s own
  // ON CONFLICT clause — no explicit forgetPendingAction() call belongs
  // here, since that would delete the row this line just wrote.
  const fileEntries: EditFilesFileEntry[] = outcome.files.map((f) => ({
    path: f.path,
    action: f.action,
    content: f.content,
    previousContent: f.previousContent,
    fingerprint: computeContentFingerprint(f.previousContent),
  }))
  const nextAction: EditAndVerifyEditAction = {
    actionId: newActionId(),
    source: "edit-and-verify-edit",
    projectRoot,
    originalInstruction,
    iteration: outcome.iteration,
    approvedArgvs: outcome.approvedArgvs,
    history: outcome.history,
    files: fileEntries,
    dropped: outcome.dropped,
    ...(planContext ? { planContext } : {}),
  }
  pendingActions.set(id, nextAction)
  persistPendingAction({ agent: "coder-agent", taskId: id, actionId: nextAction.actionId, kind: "write", skill: "edit-and-verify", payload: nextAction })
  tasks.set(id, {
    id, status: "input-required",
    requiresApproval: true,
    step: `waiting for human approval — fix attempt (iteration ${outcome.iteration} of ${MAX_VERIFY_ITERATIONS}) after a failed verification`,
    approval: buildApprovalPreview(nextAction),
  })
}

async function resumeEditAndVerifyEditAction(id: string, action: EditAndVerifyEditAction): Promise<void> {
  const drift = await checkDrift(mcpClient, id, action.projectRoot, action.files)
  if (!drift.ok) {
    tasks.set(id, {
      id, status: "failed",
      error: drift.readError
        ? `Target "${drift.driftedPath}" changed after approval — cannot re-verify: ${drift.readError}. Resubmit for a fresh preview.`
        : `Target "${drift.driftedPath}" changed after approval but before this write — refusing to write any file in this batch. Resubmit for a fresh preview.`,
    })
    forgetPendingAction({ agent: "coder-agent", taskId: id })
    return
  }

  const { written, failed } = await writeFiles(mcpClient, id, action.projectRoot, action.files)
  if (failed.length > 0) {
    tasks.set(id, {
      id, status: "failed",
      error: `Partial write: ${written.length} file(s) written successfully (${written.join(", ") || "none"}), ${failed.length} failed: ${failed.map((f) => `${f.path} (${f.error})`).join("; ")}`,
    })
    forgetPendingAction({ agent: "coder-agent", taskId: id })
    return
  }

  if (!isHarnessFlagSet()) {
    tasks.set(id, { id, status: "failed", error: "ORCHESTRAI_CODER_LLM_HARNESS was turned off mid-loop — cannot propose a verification command." })
    forgetPendingAction({ agent: "coder-agent", taskId: id })
    return
  }
  const config = readLlmHarnessConfig()
  if (!config) {
    tasks.set(id, { id, status: "failed", error: "ORCHESTRAI_CODER_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing mid-loop — failing closed rather than skipping verification." })
    forgetPendingAction({ agent: "coder-agent", taskId: id })
    return
  }

  try {
    const model = await buildChatModel(config)
    console.log(`[coder-agent] llm harness (edit-and-verify, propose command, iteration ${action.iteration}): ${describeLlmModelConfig(config)}`)
    const proposal = await proposeVerificationCommand({
      model, mcpClient, taskId: id, projectRoot: action.projectRoot,
      originalInstruction: action.originalInstruction, history: action.history,
    })
    if (!proposal) {
      tasks.set(id, { id, status: "failed", error: "the model failed to propose a verification command after retries." })
      forgetPendingAction({ agent: "coder-agent", taskId: id })
      return
    }

    // specs/119 Resolved Decision B1 — exact-argv-equality only. A match
    // runs directly with no fresh approval and no new pendingAction; any
    // difference (including the very first proposal, since approvedArgvs
    // starts empty) is a genuinely new approval.
    if (hasApprovedArgv(action.approvedArgvs, proposal.argv)) {
      const outcome = await runVerificationAndAdvance(mcpClient, model, {
        taskId: id, projectRoot: action.projectRoot, originalInstruction: action.originalInstruction,
        iteration: action.iteration, approvedArgvs: action.approvedArgvs, history: action.history,
        argv: proposal.argv, filesWrittenThisIteration: written, planContext: action.planContext,
      })
      await handleVerificationOutcome(id, action.projectRoot, action.originalInstruction, outcome, action.planContext)
      return
    }

    const commandAction: EditAndVerifyCommandAction = {
      actionId: newActionId(),
      source: "edit-and-verify-command",
      projectRoot: action.projectRoot,
      originalInstruction: action.originalInstruction,
      iteration: action.iteration,
      approvedArgvs: action.approvedArgvs,
      history: action.history,
      argv: proposal.argv,
      filesWrittenThisIteration: written,
      ...(action.planContext ? { planContext: action.planContext } : {}),
    }
    // Overwrites the just-claimed, now-stale row for this taskId — see
    // handleVerificationOutcome()'s own comment for why no explicit
    // forgetPendingAction() call belongs here.
    pendingActions.set(id, commandAction)
    persistPendingAction({ agent: "coder-agent", taskId: id, actionId: commandAction.actionId, kind: "command", skill: "edit-and-verify", payload: commandAction })
    tasks.set(id, {
      id, status: "input-required", requiresApproval: true,
      step: `waiting for human approval — will run verification command: ${proposal.argv.join(" ")}`,
      approval: buildApprovalPreview(commandAction),
    })
  } catch (err) {
    tasks.set(id, { id, status: "failed", error: `LLM harness run failed while proposing a verification command: ${errorMessage(err)}` })
    forgetPendingAction({ agent: "coder-agent", taskId: id })
  }
}

async function resumeEditAndVerifyCommandAction(id: string, action: EditAndVerifyCommandAction): Promise<void> {
  if (!isHarnessFlagSet()) {
    tasks.set(id, { id, status: "failed", error: "ORCHESTRAI_CODER_LLM_HARNESS was turned off mid-loop — cannot propose a follow-up fix if verification fails." })
    forgetPendingAction({ agent: "coder-agent", taskId: id })
    return
  }
  const config = readLlmHarnessConfig()
  if (!config) {
    tasks.set(id, { id, status: "failed", error: "ORCHESTRAI_CODER_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing mid-loop — failing closed." })
    forgetPendingAction({ agent: "coder-agent", taskId: id })
    return
  }

  try {
    const model = await buildChatModel(config)
    console.log(`[coder-agent] llm harness (edit-and-verify, run command, iteration ${action.iteration}): ${describeLlmModelConfig(config)}`)
    const outcome = await runVerificationAndAdvance(mcpClient, model, {
      taskId: id, projectRoot: action.projectRoot, originalInstruction: action.originalInstruction,
      iteration: action.iteration, approvedArgvs: action.approvedArgvs, history: action.history,
      argv: action.argv, filesWrittenThisIteration: action.filesWrittenThisIteration, planContext: action.planContext,
    })
    await handleVerificationOutcome(id, action.projectRoot, action.originalInstruction, outcome, action.planContext)
  } catch (err) {
    tasks.set(id, { id, status: "failed", error: errorMessage(err) })
    forgetPendingAction({ agent: "coder-agent", taskId: id })
  }
}

// ============================================================
// TASK PROCESSOR
// ============================================================
async function processTask(task: ValidatedTask): Promise<void> {
  const text = task.text
  // specs/030 — an authoritative selection wins outright; absent
  // selection falls back to the existing detector, unchanged.
  const skill = task.selectedSkill ?? detectSkill(text)
  taskMeta.set(task.id, { skill, createdAt: Date.now() })

  tasks.set(task.id, { id: task.id, status: "working", step: `Skill detected: ${skill}` })

  if (skill === "edit-file") {
    await handleEditFileSkill(task.id, text)
    return
  }
  if (skill === "edit-files") {
    await handleEditFilesSkill(task.id, text)
    return
  }
  if (skill === "edit-and-verify") {
    await handleEditAndVerifySkill(task.id, text)
    return
  }

  tasks.set(task.id, { id: task.id, status: "completed", result: `Skill "${skill}" not implemented yet` })
}

async function resumeTask(id: string): Promise<void> {
  const action = pendingActions.get(id)
  pendingActions.delete(id)
  // specs/110-approval-state-survives-a-restart/spec.md B0/B3 — the real
  // single-consumption boundary once persistence is enabled; a store
  // miss/no-store both return true (nothing to claim), preserving the
  // in-memory Map as the sole boundary exactly as before this spec.
  const claimed = claimPendingAction({ agent: "coder-agent", taskId: id })
  tasks.set(id, { id, status: "working", step: "approved — executing" })

  if (!action || !claimed) {
    forgetPendingAction({ agent: "coder-agent", taskId: id })
    tasks.set(id, { id, status: "failed", error: "Approved action parameters are missing" })
    return
  }

  // specs/114-coder-multi-file-edit-and-create/spec.md — a distinct
  // write path for the multi-file case, since it needs an all-or-
  // nothing preflight loop and best-effort per-file execution reporting
  // that don't fit the single-file shape below without complicating it.
  if (action.source === "edit-files") {
    await resumeEditFilesAction(id, action)
    return
  }

  // specs/119-coder-verify-loop-and-reviewer-depth/spec.md — the two
  // edit-and-verify pending-action kinds, each with their own resume
  // path; neither reuses resumeEditFilesAction() below, since both may
  // transition to a NEW pending action for the same taskId instead of
  // terminating (see handleVerificationOutcome()'s own comment).
  if (action.source === "edit-and-verify-edit") {
    await resumeEditAndVerifyEditAction(id, action)
    return
  }
  if (action.source === "edit-and-verify-command") {
    await resumeEditAndVerifyCommandAction(id, action)
    return
  }

  // specs/110-approval-state-survives-a-restart/spec.md B3 — once
  // claimed, the persisted row must never outlive this attempt,
  // regardless of outcome: success, drift refusal, or a thrown error
  // all end this action's lifecycle (a thrown error is an ordinary
  // failure here, not a crash-mid-write — see this spec's own "Crash
  // during execution" section for why an actual process crash is
  // handled differently, via the 'claimed' status never being restored).
  try {
    // specs/083 §6 step 8 — the fingerprint drift recheck, the same
    // guarantee specs/056/081 already give every other write-capable
    // skill: re-read the target immediately before writing and refuse
    // if it changed since the preview was shown. Unlike write-tests's
    // own equivalent check, a "Path not found" here is NEVER treated as
    // benign — edit-file's own preview always required a real, existing
    // file, so a target that's since disappeared is genuine drift, not
    // an expected create-case. Leaving currentContent undefined lets
    // computeContentFingerprint()'s own "absent" sentinel fall through
    // to the ordinary mismatch branch below with no special-casing.
    let currentContent: string | undefined
    try {
      currentContent = await mcpClient.callTool("read_project_file", { project_root: action.projectRoot, relative_path: action.relativePath }, id)
    } catch (err) {
      const message = errorMessage(err)
      if (!message.startsWith(PATH_NOT_FOUND_PREFIX)) {
        tasks.set(id, { id, status: "failed", error: `Target changed after approval — cannot re-verify: ${message}. Resubmit for a fresh preview.` })
        return
      }
    }
    const currentFingerprint = computeContentFingerprint(currentContent)
    if (currentFingerprint !== action.fingerprint) {
      tasks.set(id, {
        id, status: "failed",
        error: `Target "${action.relativePath}" changed after approval but before this write — refusing to overwrite unreviewed content. Resubmit for a fresh preview.`,
      })
      return
    }

    await mcpClient.callTool(
      "write_project_file",
      { project_root: action.projectRoot, relative_path: action.relativePath, content: action.content, overwrite: true },
      id,
    )
    tasks.set(id, {
      id, status: "completed",
      result: `Edited "${action.relativePath}": ${action.instruction}\n\n${action.content}`,
    })
  } catch (err) {
    tasks.set(id, { id, status: "failed", error: errorMessage(err) })
  } finally {
    forgetPendingAction({ agent: "coder-agent", taskId: id })
  }
}

// specs/114-coder-multi-file-edit-and-create/spec.md — the write path
// for edit-files. All-or-nothing preflight (every file's fingerprint
// re-verified BEFORE writing any file — refusing the entire batch on
// any single drift, the same "no partial write on drift" precedent
// edit-file already established, now extended to the whole batch), then
// best-effort execution (each write_project_file call is still one
// independent MCP tool call — no cross-file atomic transaction exists
// at that layer, a real, disclosed limitation this spec does not
// solve). A genuine mid-batch failure — as opposed to drift, which is
// always caught before any file is written — is reported per-file,
// honestly, rather than claiming a false all-or-nothing guarantee for
// that specific failure mode.
async function resumeEditFilesAction(id: string, action: EditFilesAction): Promise<void> {
  try {
    for (const file of action.files) {
      let currentContent: string | undefined
      try {
        currentContent = await mcpClient.callTool("read_project_file", { project_root: action.projectRoot, relative_path: file.path }, id)
      } catch (err) {
        const message = errorMessage(err)
        if (!message.startsWith(PATH_NOT_FOUND_PREFIX)) {
          tasks.set(id, { id, status: "failed", error: `Target "${file.path}" changed after approval — cannot re-verify: ${message}. Resubmit for a fresh preview.` })
          return
        }
      }
      const currentFingerprint = computeContentFingerprint(currentContent)
      if (currentFingerprint !== file.fingerprint) {
        tasks.set(id, {
          id, status: "failed",
          error: `Target "${file.path}" changed after approval but before this write — refusing to write any file in this batch. Resubmit for a fresh preview.`,
        })
        return
      }
    }

    const written: string[] = []
    const failed: { path: string; error: string }[] = []
    for (const file of action.files) {
      try {
        await mcpClient.callTool(
          "write_project_file",
          { project_root: action.projectRoot, relative_path: file.path, content: file.content, overwrite: true },
          id,
        )
        written.push(file.path)
      } catch (err) {
        failed.push({ path: file.path, error: errorMessage(err) })
      }
    }

    if (failed.length === 0) {
      const lines = [
        `Edited ${written.length} file(s): ${action.instruction}`,
        "",
        ...action.files.map((f) => `--- ${f.action === "create" ? "NEW" : "EDIT"} ${f.path} ---\n${f.content}`),
      ]
      if (action.dropped.length > 0) {
        lines.push(
          "",
          `Note: ${action.dropped.length} originally-proposed file(s) were dropped after failing grounding and were NOT written: ${action.dropped.map((d) => `${d.path} (${d.reason})`).join("; ")}`,
        )
      }
      tasks.set(id, { id, status: "completed", result: lines.join("\n") })
    } else {
      tasks.set(id, {
        id, status: "failed",
        error: `Partial write: ${written.length} file(s) written successfully (${written.join(", ") || "none"}), ${failed.length} failed: ${failed.map((f) => `${f.path} (${f.error})`).join("; ")}`,
      })
    }
  } catch (err) {
    tasks.set(id, { id, status: "failed", error: errorMessage(err) })
  } finally {
    forgetPendingAction({ agent: "coder-agent", taskId: id })
  }
}

// ============================================================
// HONO APP
// ============================================================
export const app = new Hono()

app.get("/.well-known/agent.json", (c) => c.json(agentCard))
app.get("/healthz", async (c) => {
  const ready = await mcpClient.pingReady()
  return c.json({ status: "ok", ready, agent: agentCard.name, tasks: tasks.size, dependencies: { mcp: mcpClient.readiness() } })
})

app.post("/", async (c) => {
  const bodyResult = await readJsonBody(c.req.raw)
  if (!bodyResult.ok) return c.json({ error: bodyResult.error }, 400)

  const parsed = parseTaskEnvelope(bodyResult.body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const { task } = parsed
  if (tasks.has(task.id)) return c.json({ error: `Task ID already exists: ${task.id}` }, 409)

  // specs/030 — reject an invalid/foreign explicit selection here, before
  // any storage or background work, and never fall back to text detection
  // for it. An absent selectedSkill always passes through unchanged.
  const ownership = validateSelectedSkillOwnership(task, OWNED_SKILL_IDS)
  if (!ownership.ok) return c.json({ error: ownership.error }, 400)

  tasks.set(task.id, { id: task.id, status: "submitted" })
  processTask(task).catch((err) => {
    tasks.set(task.id, { id: task.id, status: "failed", error: errorMessage(err) })
  })
  return c.json({ id: task.id, status: "submitted" })
})

app.get("/tasks", (c) => {
  return c.json({ count: tasks.size, tasks: Array.from(tasks.values()) })
})

app.get("/tasks/:id", (c) => {
  const task = tasks.get(c.req.param("id"))
  if (!task) return c.json({ error: "Task not found" }, 404)
  return c.json(task)
})

app.post("/tasks/:id/approve", async (c) => {
  const id = c.req.param("id")
  let body: unknown = {}
  try { body = await c.req.json() } catch { body = {} }

  const task = tasks.get(id)
  if (!task) return c.json({ error: "Task not found" }, 404)
  if (task.status !== "input-required") {
    return c.json({ error: `Cannot approve — task status is "${task.status}", expected "input-required"` }, 409)
  }

  const pending = pendingActions.get(id)
  const validation = validateActionId(body, pending?.actionId)
  if (!validation.ok) return c.json({ error: validation.error }, validation.status)

  resumeTask(id).catch((err) => {
    tasks.set(id, { id, status: "failed", error: errorMessage(err) })
  })
  return c.json({ id, status: "working" })
})

app.post("/tasks/:id/reject", async (c) => {
  const id = c.req.param("id")
  let body: unknown = {}
  try { body = await c.req.json() } catch { body = {} }

  const task = tasks.get(id)
  if (!task) return c.json({ error: "Task not found" }, 404)
  if (task.status !== "input-required") {
    return c.json({ error: `Cannot reject — task status is "${task.status}", expected "input-required"` }, 409)
  }

  const pending = pendingActions.get(id)
  const validation = validateActionId(body, pending?.actionId)
  if (!validation.ok) return c.json({ error: validation.error }, validation.status)

  pendingActions.delete(id)
  forgetPendingAction({ agent: "coder-agent", taskId: id })
  tasks.set(id, { id, status: "failed", error: "Rejected by user" })
  return c.json({ id, status: "failed" })
})

app.get("/tasks/:id/stream", (c) => {
  const id = c.req.param("id")
  return new Response(
    new ReadableStream({
      async start(controller) {
        const enc  = new TextEncoder()
        const send = (d: object) => controller.enqueue(enc.encode(`data: ${JSON.stringify(d)}\n\n`))
        for (let i = 0; i < 120; i++) {
          const t = tasks.get(id)
          if (!t) { send({ error: "not found" }); break }
          send(t)
          if (["completed", "failed", "input-required"].includes(t.status)) break
          await Bun.sleep(500)
        }
        controller.close()
      }
    }),
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
  )
})

// ============================================================
// DASHBOARD
// ============================================================
app.get("/dashboard", (c) => {
  const all = Array.from(tasks.values()).reverse()

  const statusColor: Record<string, string> = {
    submitted: "#9ca3af",
    working:   "#58a6ff",
    completed: "#3fb950",
    failed:    "#f85149",
    "input-required": "#d29922",
  }

  function escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
  }

  const rows = all.length === 0
    ? `<tr><td colspan="4" class="empty">No tasks yet — send one below</td></tr>`
    : all.map(t => `
        <tr>
          <td><code>${escapeHtml(t.id)}</code></td>
          <td><span class="badge" style="color:${statusColor[t.status] ?? "#fff"}">${t.status}</span></td>
          <td class="muted">${escapeHtml(t.step ?? "-")}</td>
          <td>
            ${t.status === "input-required" ? `
              <button class="btn green" onclick="approve('${t.id}','${t.approval?.actionId ?? ""}')">Approve</button>
              <button class="btn red"   onclick="reject('${t.id}','${t.approval?.actionId ?? ""}')">Reject</button>
            ` : t.status === "completed" ? `
              <button class="btn gray" onclick="viewResult('${t.id}')">View Result</button>
            ` : t.status === "failed" ? `
              <button class="btn gray" onclick="viewError('${t.id}')">View Error</button>
            ` : "-"}
          </td>
        </tr>
      `).join("")

  const completed = all.filter(t => t.status === "completed").length
  const failed    = all.filter(t => t.status === "failed").length
  const waiting    = all.filter(t => t.status === "input-required").length

  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>OrchestrAI — Coder Agent</title>
  <meta charset="utf-8">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:2rem;font-size:14px}
    h1{color:#58a6ff;font-size:18px;margin-bottom:4px}
    .sub{color:#8b949e;font-size:12px;margin-bottom:1.5rem}
    .stats{display:flex;gap:12px;margin-bottom:1.5rem;flex-wrap:wrap}
    .stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 20px;min-width:110px}
    .stat-n{font-size:24px;font-weight:bold;color:#c9d1d9}
    .stat-l{font-size:11px;color:#8b949e;margin-top:2px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.25rem;margin-bottom:1.25rem}
    .card-title{font-size:13px;color:#58a6ff;margin-bottom:1rem;font-weight:bold}
    .quick{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
    .qbtn{background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:5px 12px;border-radius:4px;cursor:pointer;font-size:12px;font-family:monospace}
    .qbtn:hover{background:#30363d}
    .input-row{display:flex;gap:8px}
    input{flex:1;padding:8px 12px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-family:monospace;font-size:13px}
    input:focus{outline:none;border-color:#58a6ff}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;padding:8px 12px;border-bottom:1px solid #30363d;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
    td{padding:10px 12px;border-bottom:1px solid #21262d;font-size:13px;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    .empty{text-align:center;color:#8b949e;padding:2rem!important}
    code{background:#0d1117;padding:2px 6px;border-radius:3px;font-size:12px;color:#79c0ff}
    .badge{font-size:12px;font-weight:bold}
    .muted{color:#8b949e;font-size:12px}
    .btn{padding:4px 12px;border-radius:4px;border:none;cursor:pointer;font-size:12px;font-family:monospace;margin-right:4px}
    .btn.gray {background:#21262d;color:#c9d1d9;border:1px solid #30363d}
    .btn.blue {background:#1f6feb;color:#fff}
    .btn.green{background:#238636;color:#fff}
    .btn.red  {background:#da3633;color:#fff}
    .toast{position:fixed;bottom:1.5rem;right:1.5rem;padding:10px 16px;border-radius:6px;font-size:13px;display:none;z-index:999}
    .overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:center;justify-content:center}
    .modal{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.5rem;max-width:680px;width:90%;max-height:80vh;overflow-y:auto}
    .modal h3{color:#58a6ff;margin-bottom:1rem;font-size:14px}
    .modal pre{background:#0d1117;padding:1rem;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;line-height:1.6}
  </style>
</head>
<body>
  <h1>OrchestrAI — Coder Agent</h1>
  <p class="sub">Port 3008 &nbsp;·&nbsp; Auto-refreshes every 3s &nbsp;·&nbsp; v1: single-file, single-hunk edits, human-approved</p>

  <div class="stats">
    <div class="stat"><div class="stat-n">${all.length}</div><div class="stat-l">Total</div></div>
    <div class="stat"><div class="stat-n" style="color:#d29922">${waiting}</div><div class="stat-l">Awaiting Approval</div></div>
    <div class="stat"><div class="stat-n" style="color:#3fb950">${completed}</div><div class="stat-l">Completed</div></div>
    <div class="stat"><div class="stat-n" style="color:#f85149">${failed}</div><div class="stat-l">Failed</div></div>
  </div>

  <div class="card">
    <div class="card-title">Send Task</div>
    <div class="input-row">
      <input id="inp" type="text" placeholder='edit src/foo.ts: fix the off-by-one in the loop bound'
        onkeydown="if(event.key==='Enter') send()" />
      <button class="btn blue" onclick="send()">Send</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Tasks</div>
    <table>
      <thead><tr><th>Task ID</th><th>Status</th><th>Step</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="toast" id="toast"></div>

  <div class="overlay" id="overlay" onclick="closeModal()">
    <div class="modal" onclick="event.stopPropagation()">
      <h3 id="modal-title">Result</h3>
      <pre id="modal-body"></pre>
      <button class="btn gray" style="margin-top:1rem" onclick="closeModal()">Close</button>
    </div>
  </div>

  <script>
    let n = Date.now()

    function toast(msg, color) {
      const t = document.getElementById('toast')
      t.textContent = msg
      t.style.background = color || '#238636'
      t.style.color = '#fff'
      t.style.display = 'block'
      setTimeout(() => t.style.display = 'none', 2500)
    }

    async function send(text) {
      const inp = document.getElementById('inp')
      const txt = text ?? inp.value.trim()
      if (!txt) return
      const id = 'task-' + (n++)
      await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, message: { role: 'user', parts: [{ text: txt }] } })
      })
      inp.value = ''
      toast('Submitted: ' + id)
      setTimeout(() => location.reload(), 1200)
    }

    async function approve(id, actionId) {
      const res = await fetch('/tasks/' + id + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId })
      })
      toast(res.ok ? 'Approved' : 'Approve failed', res.ok ? '#238636' : '#da3633')
      setTimeout(() => location.reload(), 800)
    }

    async function reject(id, actionId) {
      const res = await fetch('/tasks/' + id + '/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId })
      })
      toast(res.ok ? 'Rejected' : 'Reject failed', res.ok ? '#8b949e' : '#da3633')
      setTimeout(() => location.reload(), 800)
    }

    async function viewResult(id) {
      const r = await fetch('/tasks/' + id)
      const d = await r.json()
      document.getElementById('modal-title').textContent = 'Result — ' + id
      document.getElementById('modal-body').textContent = d.result || '(empty)'
      document.getElementById('overlay').style.display = 'flex'
    }

    async function viewError(id) {
      const r = await fetch('/tasks/' + id)
      const d = await r.json()
      document.getElementById('modal-title').textContent = 'Error — ' + id
      document.getElementById('modal-body').textContent = d.error || '(no error message)'
      document.getElementById('overlay').style.display = 'flex'
    }

    function closeModal() {
      document.getElementById('overlay').style.display = 'none'
    }

    setTimeout(() => location.reload(), 30000)
  </script>
</body>
</html>`)
})

// ============================================================
// START
// ============================================================
// Exported + guarded (specs/017-standalone-binary-distribution/spec.md) so a
// combined binary can import this module and start it on demand without
// it auto-starting merely by being imported.
const PORT = resolveServicePort("coder")

// specs/110-approval-state-survives-a-restart/spec.md B3/B6 — called once,
// before the HTTP server binds. A restored row repopulates both maps so
// the task reaches the client as an ordinary `input-required` approval —
// indistinguishable from one that never survived a restart, except for
// its `step` text and (for command approvals) an added risk line, neither
// of which applies to this single-skill, fingerprinted-write agent.
// specs/114 — validates against the union of both action shapes now,
// so a restored edit-files row is trusted exactly as strictly as a
// restored edit-file row always has been.
function restoreApprovalsOnStartup(): void {
  const restored = restorePendingActions<PendingAction>({
    agent: "coder-agent",
    validate: (raw) => {
      const parsed = PendingActionSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    },
  })
  for (const row of restored) {
    pendingActions.set(row.taskId, row.payload)
    // specs/119 — the two edit-and-verify kinds each get their own
    // restored-step wording, distinct from edit-files/edit-file's own,
    // naming the iteration so a human sees this isn't the first attempt.
    const stepText = row.payload.source === "edit-files"
      ? `restored after restart — waiting for human approval — will write ${row.payload.files.length} file(s)`
      : row.payload.source === "edit-and-verify-edit"
      ? `restored after restart — waiting for human approval — will write ${row.payload.files.length} file(s) (edit-and-verify, iteration ${row.payload.iteration})`
      : row.payload.source === "edit-and-verify-command"
      ? `restored after restart — waiting for human approval — will run verification command (iteration ${row.payload.iteration}): ${row.payload.argv.join(" ")}`
      : `restored after restart — waiting for human approval — will edit: ${row.payload.relativePath}`
    tasks.set(row.taskId, {
      id: row.taskId, status: "input-required",
      requiresApproval: true,
      step: stepText,
      approval: buildApprovalPreview(row.payload),
    })
  }
  if (restored.length > 0) console.log(`[coder-agent] restored ${restored.length} pending approval(s) after restart`)
}

export function start() {
  mcpClient.start()
  restoreApprovalsOnStartup()
  const agentHttpServer = serve({ fetch: app.fetch, port: PORT })

  // specs/107-task-and-conversation-history/spec.md B4 — so a task
  // dispatched directly to this agent (A2A, TUI direct mode — never
  // routed through the Orchestrator) is still recorded.
  const stopTaskSweep = startTaskPersistenceSweep("coder-agent", tasks, (id) => taskMeta.get(id) ?? null)

  let stopping = false
  async function shutdown(): Promise<void> {
    if (stopping) return
    stopping = true
    stopTaskSweep()
    flushAuditBufferForShutdown()
    await mcpClient.stop()
    agentHttpServer.stop(true)
  }

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
  const harnessStartup = readLlmHarnessStartupState()
  if (harnessStartup.warning) console.warn(`[coder-agent] WARNING: ${harnessStartup.warning}`)
  console.log(`
Coder Agent running
Dashboard → http://localhost:${PORT}/dashboard
Agent Card → http://localhost:${PORT}/.well-known/agent.json
LLM harness: ${harnessStartup.summary}
`)
}

if (import.meta.main) {
  start()
}
