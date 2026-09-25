import { Hono } from "hono"
import { serve } from "bun"
import * as path from "path"
import { extractExplicitTargetPath, resolveTargetPath } from "../../shared"
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
import { runApiDocHarness, runApiDocRouteDiscoveryHarness, runReadmeHarness } from "./llm-harness"
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
  name: "documentation-agent",
  description: "Generates and updates project documentation",
  url: `http://localhost:${resolveServicePort("documentation")}`,
  version: "1.0.0",
  skills: [
    {
      id: "generate-readme",
      name: "Generate README",
      description: "Create a README.md from project structure and package.json",
      examples: ["generate a README for the project at C:\\path\\to\\project"],
    },
    {
      id: "document-api",
      name: "Document API Endpoints",
      description: "Scan a Hono/Express file for routes and generate an API reference doc",
      examples: ["document the API at C:\\path\\to\\project\\index.ts"],
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

// specs/107-task-and-conversation-history/spec.md B4 — Documentation's own
// TaskResult carries no skill/createdAt, so a small side map records
// both at the one place processTask() already computes them (its own
// selectedSkill-or-detectSkill() line), rather than threading two new
// fields through every existing tasks.set() call site in this file.
const taskMeta = new Map<string, { skill: string; createdAt: number }>()

const mcpClient = new OrchestraiMcpClient({
  callerName: "documentation-agent",
  // specs/101-per-agent-tool-access-expansion/spec.md — analyze_project/
  // git_status/git_diff added alongside the pre-existing read_project_file/
  // write_project_file: the uniform general-inspection set every
  // code-reasoning agent now gets, bound read-only in both harnesses
  // (see llm-harness.ts) so generate-readme/document-api can ground
  // content in real project structure, not just package.json.
  requiredTools: ["read_project_file", "write_project_file", "analyze_project", "git_status", "git_diff"],
})

async function readProjectPath(root: string, relativePath: string, taskId: string): Promise<string> {
  return mcpClient.callTool("read_project_file", { project_root: root, relative_path: relativePath }, taskId)
}

async function pathExists(root: string, relativePath: string, taskId: string): Promise<boolean> {
  try {
    await readProjectPath(root, relativePath, taskId)
    return true
  } catch {
    return false
  }
}

// Distinct from extractPath — looks specifically for an output destination,
// e.g. "... document the API at X.ts save to Y.md"
function extractSavePath(text: string): string | null {
  const match = text.match(/(?:save to|write to)\s+([A-Za-z]:\\[^\s]+|\/[^\s]+)/i)
  return match?.[1] ?? null
}

function detectSkill(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes("api"))                                            return "document-api"
  if (lower.includes("readme") || lower.includes("documentation") || lower.includes("docs")) return "generate-readme"
  return "unknown"
}

// ============================================================
// SKILL — GENERATE README
// ============================================================
// All filesystem access now goes through MCP's read_project_file /
// write_project_file (specs/011-remaining-agents-mcp/spec.md) — this agent's
// own process never touches the target project's disk directly, matching
// DevOps's existing pattern and required for Docker Compose, where the
// target project is only mounted into mcp-http's container.
// specs/040-approval-preview-content-diff/spec.md — content is computed
// once at approval-preview time (computeReadmeContentOrHarness(), below)
// and reused verbatim at write time. specs/138 removed the deterministic
// README template that used to be the harness-off path: the README is
// always model-written now.
async function writeReadmeFile(projectPath: string, readme: string, taskId: string): Promise<string> {
  await mcpClient.callTool(
    "write_project_file",
    { project_root: projectPath, relative_path: "README.md", content: readme, overwrite: true },
    taskId,
  )
  return `README.md created at ${path.join(projectPath, "README.md")}\n\n${readme}`
}

// ============================================================
// SKILL — DOCUMENT API
// ============================================================
interface ApiEndpoint {
  method: string
  route: string
  description: string
}

async function scanApiRoutes(content: string): Promise<ApiEndpoint[]> {
  const lines   = content.split("\n")
  const endpoints: ApiEndpoint[] = []

  // Regex scan, not a full TS parser — matches app.get(/post(/put(/delete( followed by a route string
  const routeRegex = /app\.(get|post|put|delete)\(\s*["'`]([^"'`]+)["'`]/i

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(routeRegex)
    if (!match) continue

    const method = match[1].toUpperCase()
    const route  = match[2]

    // Comment on the line immediately above, if present
    const prevLine     = lines[i - 1]?.trim() ?? ""
    const commentMatch = prevLine.match(/^\/\/\s*(.+)$/)
    const description  = commentMatch ? commentMatch[1].trim() : "No description provided."

    endpoints.push({ method, route, description })
  }

  return endpoints
}

// specs/036-document-api-path-fallback/spec.md — when the task text names
// no explicit source-file path, resolve a project root the normal way
// (resolveTargetPath(), same as every other skill) and try a short, fixed
// list of conventional entry-file locations against it. The first
// candidate that both exists and contains at least one detected route
// registration (scanApiRoutes()) wins. Deliberately not a recursive or
// wildcard search — an explicit path in the text still always wins, and
// exhausting the list still fails closed with a specific error naming
// what was checked, never a guess or an empty doc.
// Exported so document-api-fallback.test.ts can shrink it for the
// candidate-exhausted test case — that test needs the real mcpClient
// singleton (no dependency-injection seam in this module), and each real
// candidate read costs a genuine multi-second MCP reconnect-window wait
// when no server is reachable, so exercising the full 8-entry list on
// every `bun test` run would be a real, permanent cost to pay for one
// edge case. The production candidate list itself is unaffected — this
// export exists for that one test, not for external callers.
export const DOCUMENT_API_ENTRY_CANDIDATES = [
  "index.ts", "src/index.ts",
  "app.ts", "src/app.ts",
  "server.ts", "src/server.ts",
  "main.ts", "src/main.ts",
]

async function resolveDocumentApiTarget(text: string, taskId: string): Promise<string> {
  const explicitPath = extractExplicitTargetPath(text)
  if (explicitPath) return explicitPath

  let projectRoot: string
  try {
    projectRoot = resolveTargetPath(text)
  } catch {
    throw new Error("document-api requires an explicit absolute source-file path in the task")
  }

  for (const candidate of DOCUMENT_API_ENTRY_CANDIDATES) {
    if (!(await pathExists(projectRoot, candidate, taskId))) continue
    const content = await readProjectPath(projectRoot, candidate, taskId)
    if ((await scanApiRoutes(content)).length > 0) {
      return path.join(projectRoot, candidate)
    }
  }

  throw new Error(
    `document-api requires an explicit absolute source-file path in the task ` +
      `(no path given, and none of the conventional entry files under ${projectRoot} — ` +
      `${DOCUMENT_API_ENTRY_CANDIDATES.join(", ")} — contained a detected route registration)`,
  )
}

// specs/041-llm-harness-documentation/spec.md — split out from
// computeApiDoc() below so the LLM harness call site can get the target
// path and the deterministically-discovered routes without duplicating
// the resolution/scan logic. Route *discovery* stays exactly this
// function's job either way — the harness only ever documents what this
// returns, never rediscovers routes itself.
async function resolveAndScanApiTarget(
  text: string,
  taskId: string,
): Promise<{ targetPath: string; targetDir: string; targetName: string; endpoints: ApiEndpoint[]; content: string }> {
  const targetPath = await resolveDocumentApiTarget(text, taskId)

  const targetDir  = path.dirname(targetPath)
  const targetName = path.basename(targetPath)

  let content: string
  try {
    content = await readProjectPath(targetDir, targetName, taskId)
  } catch (err) {
    throw new Error(`Path not found or unreadable: ${targetPath} (${errorMessage(err)})`)
  }
  // Note: this agent no longer stat()s the path itself (all filesystem
  // access goes through MCP), so passing a directory here no longer produces
  // the old explicit "expected a file, not a directory" error — it now
  // returns "No Hono route registrations found" instead, since a directory
  // listing naturally contains no app.get()/post()/etc. matches. Harmless,
  // but a real (documented) behavior change from the direct-fs version.

  const endpoints = await scanApiRoutes(content)
  // specs/100 — content is returned alongside endpoints so
  // computeApiDocOrHarness() can hand the grounded LLM route-discovery
  // fallback the file's already-read text with no extra read_project_file
  // round trip.
  return { targetPath, targetDir, targetName, endpoints, content }
}

async function writeApiDoc(savePath: string, doc: string, taskId: string): Promise<string> {
  const saveDir  = path.dirname(savePath)
  const saveName = path.basename(savePath)
  await mcpClient.callTool(
    "write_project_file",
    { project_root: saveDir, relative_path: saveName, content: doc, overwrite: true },
    taskId,
  )
  return `API doc written to ${savePath}\n\n${doc}`
}

// allowWrite is only ever true from resumeTask's pre-040 call shape; the
// 040-era write path (below, in the approval branch) calls
// computeApiDocOrHarness()/writeApiDoc() directly instead so content can
// be previewed before approval. This wrapper is kept for the read-only
// (never-approval, never-write) call site in processTask.
//
// specs/111 (specs/104 item A9) — this used to call the purely
// deterministic computeApiDoc(), so a bare read-only request could never
// reach the LLM harness (including specs/100's own grounded
// route-discovery fallback) even when it was on — only a "save to"
// request did, via the write path's own computeApiDocOrHarness() call.
// specs/138: there is no deterministic API-doc template any more — with
// the harness off this fails closed, the same as every other path here.
async function skillDocumentApi(text: string, allowWrite: boolean, taskId: string): Promise<string> {
  const doc = await computeApiDocOrHarness(text, taskId)
  if (allowWrite) {
    const savePath = extractSavePath(text)
    if (savePath) return writeApiDoc(savePath, doc, taskId)
  }
  return doc
}

// ============================================================
// specs/041-llm-harness-documentation/spec.md — opt-in LLM harness
// ============================================================
// Mirrors Planning Agent's own (now-deleted) dispatch shape exactly:
// isHarnessFlagSet() gates entry to the harness branch at all; inside
// that branch, a null config unambiguously means "flag on but
// misconfigured" (the flag-unset case never reaches here), so it fails
// the task closed rather than silently falling back to the deterministic
// path below — the same "not a silent fallback" precedent specs/026/028
// already established, deliberately not relaxed here.

// specs/138 — the Documentation agent's two fixed templates (README and
// API doc) were removed; its output is always model-written.
export const DOCUMENTATION_TEMPLATES_REMOVED_MESSAGE =
  "needs the Documentation LLM (ORCHESTRAI_DOCUMENTATION_LLM_HARNESS on and a provider key) — the fixed README/API-doc templates were removed in specs/138"

async function computeReadmeContentOrHarness(
  projectPath: string,
  existingReadme: string | undefined,
  taskId: string,
): Promise<string> {
  if (!isHarnessFlagSet()) throw new Error(`generate-readme ${DOCUMENTATION_TEMPLATES_REMOVED_MESSAGE}`)

  const config = readLlmHarnessConfig()
  if (!config) {
    throw new Error(
      "ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — " +
        "failing closed (the README template was removed in specs/138)",
    )
  }

  const model = await buildChatModel(config)
  console.log(`[documentation-agent] llm harness (generate-readme): ${describeLlmModelConfig(config)}`)
  const content = await runReadmeHarness({ model, mcpClient, taskId, projectRoot: projectPath, existingReadme })
  if (content === null) {
    throw new Error(
      "LLM harness failed to produce README content (see logs for the underlying error) — " +
        "failing closed (there is no template fallback — specs/138)",
    )
  }
  return content
}

async function computeApiDocOrHarness(text: string, taskId: string): Promise<string> {
  const { targetPath, targetDir, endpoints, content: fileContent } = await resolveAndScanApiTarget(text, taskId)

  if (!isHarnessFlagSet()) throw new Error(`document-api ${DOCUMENTATION_TEMPLATES_REMOVED_MESSAGE}`)

  const config = readLlmHarnessConfig()
  if (!config) {
    throw new Error(
      "ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — " +
        "failing closed (the API-doc template was removed in specs/138)",
    )
  }

  const model = await buildChatModel(config)

  // specs/100-document-api-grounded-llm-route-discovery-fallback/spec.md
  // — scanApiRoutes()'s fixed JS/TS/Express/Hono regex is unchanged and
  // still runs first, unconditionally. Only when it finds zero routes,
  // and only here (harness already confirmed configured), a grounded LLM
  // discovery pass gets a chance to find routes scanApiRoutes() was never
  // built to recognize (PHP, Python, etc.) — every proposed route must be
  // a literal substring of the real file content, or it's rejected.
  let routes = endpoints
  if (routes.length === 0) {
    console.log(`[documentation-agent] llm harness (document-api route discovery): ${describeLlmModelConfig(config)}`)
    routes = await runApiDocRouteDiscoveryHarness({ model, mcpClient, taskId, targetPath, targetDir, content: fileContent })
  }

  console.log(`[documentation-agent] llm harness (document-api): ${describeLlmModelConfig(config)}`)
  const content = await runApiDocHarness({ model, mcpClient, taskId, targetDir, targetPath, routes })
  if (content === null) {
    throw new Error(
      "LLM harness failed to produce API documentation (see logs for the underlying error) — " +
        "failing closed (there is no template fallback — specs/138)",
    )
  }
  return content
}

// ============================================================
// TASK PROCESSOR
// ============================================================
// generate-readme always writes — same tier as DevOps Agent's write skills.
// document-api only needs approval when the task text also asks to save the
// output to a file ("save to" / "write to"); otherwise it's read-only.
const NEEDS_APPROVAL = new Set(["generate-readme"])

interface PendingAction {
  actionId: string
  skill: string
  text: string
  target: string
  overwrite: boolean
  // specs/040-approval-preview-content-diff/spec.md — computed once here,
  // at preview time, and reused verbatim by resumeTask() below. Never
  // recomputed at write time — this is what closes the approve-vs-write
  // drift gap named in that spec (a source file could otherwise change in
  // the window between preview and approval).
  content?: string
  previousContent?: string
  // specs/109-document-api-drift-recheck/spec.md — closes specs/104's own
  // A8: every other write-capable agent already re-verifies this
  // immediately before the real write (specs/056); Documentation never
  // adopted it. Computed over previousContent (the target's own state at
  // preview time), never over the content being written — the same
  // convention DevOps/Testing/Coder already use.
  fingerprint: string
}

const pendingActions = new Map<string, PendingAction>()

// specs/110-approval-state-survives-a-restart/spec.md B4/B6 — validates a
// restored row's JSON.parse()'d payload. Reachable only now that
// specs/109 made `fingerprint` a required field on every PendingAction
// this agent produces — a restored action with no fingerprint would
// skip the drift recheck resumeTask() already performs for both skills.
const PersistedDocumentationActionSchema = z.object({
  actionId: z.string(),
  skill: z.string(),
  text: z.string(),
  target: z.string(),
  overwrite: z.boolean(),
  content: z.string().optional(),
  previousContent: z.string().optional(),
  fingerprint: z.string(),
})

function buildApprovalPreview(action: PendingAction): ApprovalPreview {
  return {
    actionId: action.actionId,
    kind: "file-write",
    summary: `Write ${action.skill === "generate-readme" ? "README.md" : "API documentation"}`,
    target: action.target,
    overwrite: action.overwrite,
    content: action.content,
    previousContent: action.previousContent,
    fingerprint: action.fingerprint,
    risks: [
      "Creates or overwrites a file in the target project.",
      "No sandbox or rollback — the file is written with the current OS user's permissions.",
    ],
  }
}

async function processTask(task: ValidatedTask): Promise<void> {
  const text  = task.text
  // specs/030 — an authoritative selection wins outright; absent selection
  // falls back to the existing detector, unchanged.
  const skill = task.selectedSkill ?? detectSkill(text)
  taskMeta.set(task.id, { skill, createdAt: Date.now() })

  tasks.set(task.id, { id: task.id, status: "working", step: `Skill detected: ${skill}` })

  const isWriteApi   = skill === "document-api" && extractSavePath(text) !== null
  const needsApproval = NEEDS_APPROVAL.has(skill) || isWriteApi

  if (needsApproval) {
    let target = text
    let overwrite = false
    let note: string | null = null
    let content: string | undefined
    let previousContent: string | undefined

    if (skill === "generate-readme") {
      try {
        target = resolveTargetPath(text)
      } catch (err) {
        tasks.set(task.id, { id: task.id, status: "failed", error: errorMessage(err) })
        return
      }

      // specs/041 — reordered from computing content first: an existing
      // README, if any, is fetched *before* content computation so it can
      // be handed to the LLM harness as context. The deterministic path
      // doesn't need it early, but fetching it once here (rather than
      // twice, once early and once late) keeps this simple.
      if (await pathExists(target, "README.md", task.id)) {
        overwrite = true
        note = "README.md already exists — approving will overwrite it"
        try {
          previousContent = await readProjectPath(target, "README.md", task.id)
        } catch {
          // Existence and readability are two different checks — an
          // unreadable-but-existing file just means no previousContent to
          // diff against, not a failed preview.
          previousContent = undefined
        }
      }

      try {
        content = await computeReadmeContentOrHarness(target, previousContent, task.id)
      } catch (err) {
        tasks.set(task.id, { id: task.id, status: "failed", error: errorMessage(err) })
        return
      }
    } else {
      target = extractSavePath(text) ?? text
      // specs/040 — computing here (rather than only at resumeTask, as
      // before this spec) means a target-resolution failure now surfaces
      // before requesting approval, not after — consistent with
      // generate-readme's own resolveTargetPath check just above, and
      // arguably a genuine improvement: no point asking for approval on
      // something that was always going to fail once approved.
      try {
        content = await computeApiDocOrHarness(text, task.id)
      } catch (err) {
        tasks.set(task.id, { id: task.id, status: "failed", error: errorMessage(err) })
        return
      }

      // specs/109-document-api-drift-recheck/spec.md — a real gap found
      // while implementing that spec, not previously tracked: this branch
      // never fetched the target's own existing content, so `overwrite`
      // stayed permanently `false` and `previousContent` permanently
      // `undefined` even when genuinely overwriting a real file — every
      // document-api preview looked like a fresh create. Needed for the
      // new fingerprint to mean anything (fingerprinting an always-
      // `undefined` previousContent would make every real overwrite look
      // like drift the moment resumeTask() re-reads a target that
      // actually exists). Mirrors generate-readme's own existence check
      // just above, split via dirname/basename since target here is a
      // full file path, not a directory root with a fixed filename.
      const saveDir  = path.dirname(target)
      const saveName = path.basename(target)
      if (await pathExists(saveDir, saveName, task.id)) {
        overwrite = true
        note = "target file already exists — approving will overwrite it"
        try {
          previousContent = await readProjectPath(saveDir, saveName, task.id)
        } catch {
          previousContent = undefined
        }
      }
    }

    const fingerprint = computeContentFingerprint(previousContent)
    const action: PendingAction = { actionId: newActionId(), skill, text, target, overwrite, content, previousContent, fingerprint }
    pendingActions.set(task.id, action)
    // specs/110-approval-state-survives-a-restart/spec.md B4 — a
    // fingerprinted write, the same restart-safe treatment DevOps/
    // Testing/Coder's own write skills already get.
    persistPendingAction({ agent: "documentation-agent", taskId: task.id, actionId: action.actionId, kind: "write", skill: action.skill, payload: action })
    const approval = buildApprovalPreview(action)
    let step = `waiting for human approval — target: ${target}`
    if (note) step += ` — ${note}`

    tasks.set(task.id, {
      id: task.id, status: "input-required",
      requiresApproval: true,
      step,
      approval,
    })
    return
  }

  try {
    let result = ""
    if (skill === "document-api") result = await skillDocumentApi(text, false, task.id)
    else result = `Skill "${skill}" not implemented yet`
    tasks.set(task.id, { id: task.id, status: "completed", result })
  } catch (err) {
    tasks.set(task.id, { id: task.id, status: "failed", error: errorMessage(err) })
  }
}

async function resumeTask(id: string): Promise<void> {
  const action = pendingActions.get(id)
  pendingActions.delete(id)
  // specs/110-approval-state-survives-a-restart/spec.md B0/B4 — the real
  // single-consumption boundary once persistence is enabled; a store
  // miss/no-store both return true (nothing to claim), preserving the
  // in-memory Map as the sole boundary exactly as before this spec.
  const claimed = claimPendingAction({ agent: "documentation-agent", taskId: id })
  tasks.set(id, { id, status: "working", step: "approved — executing" })

  if (!action || !claimed) {
    forgetPendingAction({ agent: "documentation-agent", taskId: id })
    tasks.set(id, { id, status: "failed", error: "Approved action parameters are missing" })
    return
  }

  // specs/110-approval-state-survives-a-restart/spec.md — once claimed,
  // the persisted row must never outlive this attempt, regardless of
  // outcome (drift refusal, write success, or a thrown error).
  try {

  // specs/109-document-api-drift-recheck/spec.md — re-verifies the
  // target is still byte-identical to what it was at preview time,
  // immediately before the real write, mirroring DevOps's own
  // resumeTask() recheck (packages/agents/devops/index.ts) exactly:
  // re-read the real target, compare its fingerprint, fail closed on
  // any mismatch or unexpected read error. generate-readme's target is
  // a project root with a fixed "README.md" relative path;
  // document-api's target is a full save path, split via
  // dirname/basename.
  {
    const root = action.skill === "generate-readme" ? action.target : path.dirname(action.target)
    const relativePath = action.skill === "generate-readme" ? "README.md" : path.basename(action.target)
    let currentContent: string | undefined
    try {
      currentContent = await readProjectPath(root, relativePath, id)
    } catch (err) {
      const message = errorMessage(err)
      // "Path not found" here means the target went from absent (a
      // create) to still-absent — expected, not drift; anything else is
      // genuine drift and fails the same as a content mismatch.
      if (!message.startsWith(PATH_NOT_FOUND_PREFIX)) {
        tasks.set(id, { id, status: "failed", error: `Target changed after approval — cannot re-verify: ${message}. Resubmit for a fresh preflight.` })
        return
      }
    }
    const currentFingerprint = computeContentFingerprint(currentContent)
    if (currentFingerprint !== action.fingerprint) {
      tasks.set(id, {
        id, status: "failed",
        error: `Target "${action.target}" changed after approval but before this write — refusing to overwrite unreviewed content. Resubmit for a fresh preflight.`,
      })
      return
    }
  }

  try {
    let result = ""
    // specs/040 — writes the content already computed and shown at
    // preview time, never recomputes it. `content` is only ever absent
    // here if computing it failed at preview time, in which case
    // processTask() above already failed the task before approval was
    // ever requested — this branch exists as a defensive fallback, not an
    // expected path.
    if (action.skill === "generate-readme" && action.content !== undefined) {
      result = await writeReadmeFile(action.target, action.content, id)
    } else if (action.skill === "document-api" && action.content !== undefined) {
      result = await writeApiDoc(action.target, action.content, id)
    } else {
      result = `Skill "${action.skill}" approved but its content was not computed at preview time`
    }
    tasks.set(id, { id, status: "completed", result })
  } catch (err) {
    tasks.set(id, { id, status: "failed", error: errorMessage(err) })
  }
  } finally {
    forgetPendingAction({ agent: "documentation-agent", taskId: id })
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
  forgetPendingAction({ agent: "documentation-agent", taskId: id })
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
    submitted:        "#9ca3af",
    working:          "#58a6ff",
    completed:        "#3fb950",
    failed:           "#f85149",
    "input-required": "#d29922",
  }

  const rows = all.length === 0
    ? `<tr><td colspan="4" class="empty">No tasks yet — send one below</td></tr>`
    : all.map(t => `
        <tr>
          <td><code>${t.id}</code></td>
          <td><span class="badge" style="color:${statusColor[t.status] ?? "#fff"}">${t.status}</span></td>
          <td class="muted">${t.step ?? "-"}</td>
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
  const pending   = all.filter(t => t.status === "input-required").length
  const failed    = all.filter(t => t.status === "failed").length

  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>OrchestrAI — Documentation Agent</title>
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
    .btn.green{background:#238636;color:#fff}
    .btn.red  {background:#da3633;color:#fff}
    .btn.gray {background:#21262d;color:#c9d1d9;border:1px solid #30363d}
    .btn.blue {background:#1f6feb;color:#fff}
    .btn.green:hover{background:#2ea043}
    .btn.red:hover  {background:#f85149}
    .toast{position:fixed;bottom:1.5rem;right:1.5rem;padding:10px 16px;border-radius:6px;font-size:13px;display:none;z-index:999}
    .overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:center;justify-content:center}
    .modal{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.5rem;max-width:680px;width:90%;max-height:80vh;overflow-y:auto}
    .modal h3{color:#58a6ff;margin-bottom:1rem;font-size:14px}
    .modal pre{background:#0d1117;padding:1rem;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;line-height:1.6}
  </style>
</head>
<body>
  <h1>OrchestrAI — Documentation Agent</h1>
  <p class="sub">Port 3004 &nbsp;·&nbsp; Auto-refreshes every 3s</p>

  <div class="stats">
    <div class="stat"><div class="stat-n">${all.length}</div><div class="stat-l">Total</div></div>
    <div class="stat"><div class="stat-n" style="color:#3fb950">${completed}</div><div class="stat-l">Completed</div></div>
    <div class="stat"><div class="stat-n" style="color:#d29922">${pending}</div><div class="stat-l">Pending Approval</div></div>
    <div class="stat"><div class="stat-n" style="color:#f85149">${failed}</div><div class="stat-l">Failed</div></div>
  </div>

  <div class="card">
    <div class="card-title">Send Task</div>
    <div class="quick">
      <button class="qbtn" onclick="q('generate a README for my project')">Generate README</button>
      <button class="qbtn" onclick="q('document the API at &quot;C:\\\\path with spaces\\\\index.ts&quot;')">Document API</button>
    </div>
    <div class="input-row">
      <input id="inp" type="text" placeholder="or type a custom task and press Enter..."
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

    function q(text) { send(text) }

    async function approve(id, actionId) {
      const res = await fetch('/tasks/' + id + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId }),
      })
      const data = await res.json()
      if (data.error) { toast(data.error, '#da3633'); return }
      toast('Approved!')
      setTimeout(() => location.reload(), 800)
    }

    async function reject(id, actionId) {
      const res = await fetch('/tasks/' + id + '/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId }),
      })
      const data = await res.json()
      if (data.error) { toast(data.error, '#da3633'); return }
      toast('Rejected', '#da3633')
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
// it auto-starting merely by being imported. `bun run
// packages/agents/documentation/index.ts` is unaffected — import.meta.main
// is still true for that exact invocation, same as before this change.
const PORT = resolveServicePort("documentation")

// specs/110-approval-state-survives-a-restart/spec.md B4/B6 — called
// once, before the HTTP server binds. Both skills produce a "write" kind
// action (generate-readme/document-api both have a required fingerprint
// since specs/109), so a restored preview needs no added risk line the
// way a restored command approval does — resumeTask()'s own drift
// recheck already covers it identically to a same-process approval.
function restoreApprovalsOnStartup(): void {
  const restored = restorePendingActions<PendingAction>({
    agent: "documentation-agent",
    validate: (raw) => {
      const parsed = PersistedDocumentationActionSchema.safeParse(raw)
      return parsed.success ? (parsed.data as PendingAction) : null
    },
  })
  for (const row of restored) {
    pendingActions.set(row.taskId, row.payload)
    tasks.set(row.taskId, {
      id: row.taskId, status: "input-required",
      requiresApproval: true,
      step: `restored after restart — waiting for human approval — target: ${row.payload.target}`,
      approval: buildApprovalPreview(row.payload),
    })
  }
  if (restored.length > 0) console.log(`[documentation-agent] restored ${restored.length} pending approval(s) after restart`)
}

export function start() {
  mcpClient.start()
  restoreApprovalsOnStartup()
  const agentHttpServer = serve({ fetch: app.fetch, port: PORT })

  // specs/107-task-and-conversation-history/spec.md B4 — so a task
  // dispatched directly to this agent (A2A, TUI direct mode — never
  // routed through the Orchestrator) is still recorded.
  const stopTaskSweep = startTaskPersistenceSweep("documentation-agent", tasks, (id) => taskMeta.get(id) ?? null)

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
  if (harnessStartup.warning) console.warn(`[documentation-agent] WARNING: ${harnessStartup.warning}`)
  console.log(`
Documentation Agent running
Dashboard → http://localhost:${PORT}/dashboard
Agent Card → http://localhost:${PORT}/.well-known/agent.json
LLM harness: ${harnessStartup.summary}
`)
}

if (import.meta.main) {
  start()
}
