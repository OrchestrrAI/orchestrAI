import { Hono } from "hono"
import { splitPlanStepText } from "../../shared/plan-step-text"
import { serve } from "bun"
import * as path from "path"
import { resolveTargetPath, stripPathPhrases } from "../../shared"
import { resolveServicePort } from "../../shared/service-ports"
import { DevOpsMcpClient } from "./mcp-client"
import { callAgent } from "../../shared/a2a-client"
import { boundTaskResult, flushAuditBufferForShutdown } from "../../shared/audit"
import { parseTaskEnvelope, readJsonBody, validateSelectedSkillOwnership, type ValidatedTask } from "../../shared/task-envelope"
import { newActionId, validateActionId, computeContentFingerprint, type ApprovalPreview } from "../../shared/approval"
import { classifyWritePreflight, PATH_NOT_FOUND_PREFIX, type WritePreflight } from "../../shared/write-preflight"
import {
  buildChatModel,
  describeLlmModelConfig,
  isAnalyzeSecretsPrecheckEnabled,
  isHarnessFlagSet,
  readLlmHarnessConfig,
  readLlmHarnessStartupState,
} from "./model-factory"
import { AUTHORED_FILE_LABEL, runAuthoringHarness, runRunCommandHarness } from "./llm-harness"
import { referencedSecrets, type DevOpsFileKind } from "../../shared/devops-file-validation"
// specs/105-orchestrator-fallback-deep-analysis/spec.md — the deep
// analysis harness is now the ONE shared implementation the Orchestrator
// also imports, rather than a DevOps-only copy.
import { getCachedProjectAnalysis, renderCodebaseAnalysis, runProjectAnalysisHarness, setCachedProjectAnalysis } from "../../shared/project-analysis"
import { startTaskPersistenceSweep } from "../../shared/store"
import { z } from "zod"
import { persistPendingAction, claimPendingAction, forgetPendingAction, restorePendingActions } from "../../shared/pending-action-store"
// Re-exported so index.test.ts's existing import site (and any other
// consumer) keeps working — specs/103's own unit tests for this
// function moved to packages/shared/project-analysis.test.ts alongside
// its new home, but this agent's own test file still exercises it via
// its own local import path, matching every other agent's convention.
export { renderCodebaseAnalysis }

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
  warning?: string
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
  name: "devops-agent",
  description: "Handles Docker, CI/CD, git, and DevOps tasks for OrchestrAI",
  url: `http://localhost:${resolveServicePort("devops")}`,
  version: "1.0.0",
  skills: [
    { id: "dockerize",       name: "Create Dockerfile",   description: "Generate a production-ready Dockerfile" },
    { id: "create-compose",  name: "Create Docker Compose",description: "Generate a docker-compose.yml for a single-service setup" },
    { id: "create-ci",       name: "Create CI Pipeline",  description: "Generate GitHub Actions workflow" },
    { id: "create-gitignore",name: "Create .gitignore",   description: "Generate .gitignore file" },
    { id: "analyze-project", name: "Analyze Project",     description: "Analyze DevOps files and include a Security Agent secrets pre-check" },
    { id: "git-status",      name: "Git Status",          description: "Get git repository status" },
    // specs/079-phase-a-connect-orphaned-tools/spec.md — connects four
    // MCP tools that were already fully implemented but reachable by no
    // agent, plus two new read-only tools this spec adds.
    { id: "build-image",       name: "Build Docker Image",  description: "Build a Docker image from a generated Dockerfile and report the real build output" },
    { id: "verify-deployment", name: "Verify Deployment",   description: "Start a built image briefly and confirm it actually boots" },
    { id: "docker-status",     name: "Docker Status",       description: "Report current Docker containers and images" },
    { id: "git-diff",          name: "Git Diff",            description: "Show staged and/or unstaged changes" },
    { id: "commit-changes",    name: "Commit Changes",      description: "Create a git commit from the current staged and unstaged changes" },
    // specs/080-run-command-approved-execution/spec.md §2 — a general,
    // per-invocation-approved execution primitive: an explicit command in
    // the task text, or (ORCHESTRAI_DEVOPS_LLM_HARNESS=1) an LLM-proposed
    // one, both routed through the identical actionId-bound approval gate
    // every other write-capable skill already uses.
    { id: "run-command",       name: "Run Command",         description: "Run an explicit or LLM-proposed command in the target project, after human approval of the exact argv" },
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
const mcpClient = new DevOpsMcpClient()

// specs/107-task-and-conversation-history/spec.md B4 — DevOps's own
// TaskResult carries no skill/createdAt, so a small side map records
// both at the one place processTask() already computes them (its own
// selectedSkill-or-detectSkill() line), rather than threading two new
// fields through all 27 existing `tasks.set()` call sites in this file.
const taskMeta = new Map<string, { skill: string; createdAt: number }>()

type McpToolName =
  | "analyze_project"
  | "git_status"
  | "write_project_file"
  | "docker_build"
  | "docker_run"
  | "git_commit"
  | "run_command"

interface PendingAction {
  actionId: string
  skill: string
  toolName?: McpToolName
  args?: Record<string, unknown>
  targetPath: string
  // specs/056-devops-preflight-and-idempotent-writes/spec.md — computed
  // once at preflight/preview time and reused verbatim, never
  // recomputed, the same "compute once, reuse at write time" property
  // specs/040 already established for content/previousContent.
  content?: string
  previousContent?: string
  fingerprint?: string
  // Needed by resumeTask() to re-derive the same relative_path preflightWrite()
  // used, without re-parsing task text a second time.
  projectRoot?: string
  // specs/138 — the model's one-line description of the file it wrote.
  summary?: string
}

const pendingActions = new Map<string, PendingAction>()

// specs/110-approval-state-survives-a-restart/spec.md B1/B6 — validates a
// restored row's JSON.parse()'d payload. Scoped to exactly the fields a
// persisted action can have (a subset of PendingAction — only the
// fingerprinted-write and run-command shapes are ever persisted, see B0's
// own scope note), not the whole interface: an EXECUTING-skill or
// no-fingerprint-degrade action is never written to the store in the
// first place, so this schema never needs to accept one.
const PersistedDevOpsActionSchema = z.object({
  actionId: z.string(),
  skill: z.string(),
  toolName: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  targetPath: z.string(),
  content: z.string().optional(),
  previousContent: z.string().optional(),
  fingerprint: z.string().optional(),
  projectRoot: z.string().optional(),
  summary: z.string().optional(), // specs/138 — optional: pre-138 rows still parse
})

function extractPort(text: string): number {
  const match = text.match(/port\s*(\d+)/i)
  return match ? parseInt(match[1]) : 3000
}

// specs/079-phase-a-connect-orphaned-tools/spec.md §1/§5 — matches an
// explicit "tag: x" / "image: x" clause if present, otherwise derives
// the same `${appName}:latest` convention create-compose already uses,
// so build-image and create-compose name the same image by default with
// no coordination needed.
export function extractImageTag(text: string, base: string): string {
  const match = text.match(/(?:image[_ ]?tag|tag|image)\s*[:=]\s*([a-zA-Z0-9][a-zA-Z0-9_.\-/]*:[a-zA-Z0-9_.\-]+)/i)
  if (match) return match[1]!
  return `${defaultImageName(path.basename(base))}:latest`
}

/** specs/143 — Docker repository names must be lowercase and use only
 *  [a-z0-9._-]; the folder name ("MyApp", "My App!") often isn't. */
export function defaultImageName(folder: string): string {
  const name = folder.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "")
  return name || "app"
}

// specs/015-routing-planning-polish-2/spec.md: see apps/orchestrator/index.ts's
// own CI_WORD for why a bare .includes("ci") is wrong — it matches inside
// path segments like "...\ci-demo\..." too, not just a standalone word.
const CI_WORD = /(^|\s)ci(\s|$)/

function detectSkill(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes("dockerfile") || lower.includes("dockerize")) return "dockerize"
  // specs/079-phase-a-connect-orphaned-tools/spec.md — checked ahead of
  // the generic "git"/"docker" substrings below (git-status/dockerize's
  // own broad matches would otherwise shadow these more specific ones,
  // the same ordering hazard specs/015's own CI_WORD fix already had to
  // account for).
  if (lower.includes("verify") && (lower.includes("deploy") || lower.includes("boot"))) return "verify-deployment"
  if (lower.includes("build") && (lower.includes("image") || lower.includes("docker")))  return "build-image"
  if (lower.includes("docker") && (lower.includes("status") || lower.includes(" ps") || lower.includes("images"))) return "docker-status"
  // specs/080-run-command-approved-execution/spec.md §2 — deliberately
  // narrow triggers ("run command"/"execute command") rather than a bare
  // "run", so this never shadows any of the more specific skills above or
  // below it, and is never reachable by accident.
  if (lower.includes("run command") || lower.includes("execute command")) return "run-command"
  if (lower.includes("compose"))                                    return "create-compose"
  if (CI_WORD.test(lower) || lower.includes("pipeline") || lower.includes("github action")) return "create-ci"
  if (lower.includes("gitignore") || lower.includes("ignore"))     return "create-gitignore"
  if (lower.includes("analyze") || lower.includes("missing"))      return "analyze-project"
  if (lower.includes("commit"))                                     return "commit-changes"
  if (lower.includes("diff"))                                       return "git-diff"
  if (lower.includes("git"))                                        return "git-status"
  return "unknown"
}

// ============================================================
// FILE SKILLS (specs/138 — model-authored, validated before preview)
// ============================================================
// Where each file goes is fixed here, never chosen by the model.
const FILE_SKILLS: Record<string, { kind: DevOpsFileKind; relativePath: string }> = {
  dockerize: { kind: "dockerfile", relativePath: "Dockerfile" },
  "create-ci": { kind: "ci-workflow", relativePath: path.join(".github", "workflows", "ci.yml") },
  "create-gitignore": { kind: "gitignore", relativePath: ".gitignore" },
  "create-compose": { kind: "compose", relativePath: "docker-compose.yml" },
}

export const TEMPLATES_REMOVED_MESSAGE =
  "writes model-authored files and needs the DevOps LLM (ORCHESTRAI_DEVOPS_LLM_HARNESS on and a provider key) — the fixed file templates were removed in specs/138"

// specs/079-phase-a-connect-orphaned-tools/spec.md §1/§5 — build-image
// and verify-deployment are DevOps's first EXECUTING skills (they run a
// real docker build/run, not generate file content), so they
// deliberately do not go through prepareWriteActionOrHarness()'s
// content-generation/LLM-parameter path at all — that function's own
// harness enhancement is scoped to the four original file-writing
// skills only, unchanged by this spec. `targetPath` here is the image
// tag, not a file path — that's what the approval preview's `target`
// row shows for these two.
function prepareExecutingAction(skill: string, text: string): Omit<PendingAction, "actionId"> {
  const base = resolveTargetPath(text)
  const imageTag = extractImageTag(text, base)

  if (skill === "build-image") {
    return {
      skill,
      toolName: "docker_build",
      targetPath: imageTag,
      args: { context_path: base, image_tag: imageTag, dockerfile: "Dockerfile" },
    }
  }

  // verify-deployment
  return {
    skill,
    toolName: "docker_run",
    targetPath: imageTag,
    args: { image_tag: imageTag, port: extractPort(text) },
  }
}

// specs/080-run-command-approved-execution/spec.md §2 — a plain,
// no-shell tokenizer (quoted spans kept together, everything else split
// on whitespace) so an explicit command in task text becomes a real argv
// array without ever handing a string to a shell. This is parsing, not
// execution — run_command itself (packages/mcp/index.ts) still never
// sees anything but an already-split array.
function tokenizeCommandText(cmdText: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(cmdText)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? ""
    if (token.length > 0) tokens.push(token)
  }
  return tokens
}

// Matches the explicit trigger phrase already checked by detectSkill()
// above and captures everything after it as the literal command text.
// stripPathPhrases() first, same reasoning as extractCommitMessage()'s
// own use of it: an explicit target-path clause at the end of the task
// text (e.g. "run command: go test ./... at C:\path") must not become
// part of the command itself.
function extractRunCommandText(text: string): string | null {
  const withoutPath = stripPathPhrases(text)
  const match = withoutPath.match(/(?:run|execute)\s+command\s*[:\-]?\s*(.+)$/i)
  const extracted = match?.[1]?.trim()
  return extracted && extracted.length > 0 ? extracted : null
}

// specs/080-run-command-approved-execution/spec.md §2 — two paths to a
// real argv: an explicit command in the task text (parsed deterministically,
// no LLM involved), or, only when no explicit command is present AND the
// harness flag is on, an LLM-proposed one via runRunCommandHarness(). No
// silent fallback between the two — an explicit command always wins, and
// an absent one with the harness off fails closed with a named error
// (there is nothing else this skill could safely do).
async function prepareRunCommandAction(text: string, taskId: string): Promise<Omit<PendingAction, "actionId">> {
  const base = resolveTargetPath(text)
  const explicitText = extractRunCommandText(text)

  if (explicitText) {
    const argv = tokenizeCommandText(explicitText)
    if (argv.length === 0) throw new Error(`No command found after "run command:" in "${text}"`)
    return {
      skill: "run-command",
      toolName: "run_command",
      targetPath: `command in ${base}`,
      args: { argv, cwd: base, project_root: base },
    }
  }

  if (!isHarnessFlagSet()) {
    throw new Error(
      "No explicit command given (expected e.g. \"run command: go test ./...\") and " +
        "ORCHESTRAI_DEVOPS_LLM_HARNESS is not set — nothing to propose one, failing closed rather than guessing.",
    )
  }
  const config = readLlmHarnessConfig()
  if (!config) {
    throw new Error(
      "ORCHESTRAI_DEVOPS_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — " +
        "failing closed rather than guessing a command",
    )
  }
  const model = await buildChatModel(config)
  console.log(`[devops-agent] llm harness (run-command): ${describeLlmModelConfig(config)}`)
  // specs/137 — in a plan, the model is told the step; the full request is background.
  const { step, context } = splitPlanStepText(text)
  const params = await runRunCommandHarness({ model, mcpClient, taskId, projectRoot: base, hint: step, context })
  if (!params) throw new Error("LLM harness failed to propose a command")
  return {
    skill: "run-command",
    toolName: "run_command",
    targetPath: `command in ${base}`,
    args: { argv: params.argv, cwd: base, project_root: base },
  }
}

// specs/138 — the model writes the whole file from the real project; the
// harness only returns it once packages/shared/devops-file-validation.ts
// accepts it (one retry, then fail closed with the violations named).
// With the harness off or no key there is nothing to fall back to — the
// templates are gone — so the skill fails closed with a named error.
async function prepareAuthoredWrite(skill: string, text: string, taskId: string): Promise<Omit<PendingAction, "actionId"> & { summary: string }> {
  const spec = FILE_SKILLS[skill]
  if (!spec) throw new Error(`Skill "${skill}" is not a file skill`)
  if (!isHarnessFlagSet()) throw new Error(`"${skill}" ${TEMPLATES_REMOVED_MESSAGE}`)
  const config = readLlmHarnessConfig()
  if (!config) throw new Error(`"${skill}" ${TEMPLATES_REMOVED_MESSAGE} (ORCHESTRAI_LLM_API_KEY is missing)`)

  const base = resolveTargetPath(text)
  const targetPath = path.join(base, spec.relativePath)
  let existingContent: string | undefined
  try {
    existingContent = await mcpClient.callTool("read_project_file", { project_root: base, relative_path: spec.relativePath }, taskId)
  } catch {
    existingContent = undefined // absent (or unreadable — preflight reports that precisely)
  }

  const model = await buildChatModel(config)
  console.log(`[devops-agent] llm harness (${skill}, authoring): ${describeLlmModelConfig(config)}`)
  // specs/137 — the step is the request; the full request is background.
  const planText = splitPlanStepText(text)
  try {
    const authored = await runAuthoringHarness({
      model, mcpClient, taskId, projectRoot: base,
      kind: spec.kind,
      relativePath: spec.relativePath,
      projectName: path.basename(base),
      existingContent,
      knownSecrets: spec.kind === "ci-workflow" ? referencedSecrets(existingContent) : undefined,
      requestText: planText.step,
      context: planText.context,
    })
    return {
      skill,
      toolName: "write_project_file",
      targetPath,
      args: { project_root: base, relative_path: spec.relativePath },
      content: authored.content,
      summary: authored.summary,
    }
  } catch (err) {
    throw new Error(`LLM harness run failed for "${skill}": ${errorMessage(err)}`)
  }
}

// specs/056-devops-preflight-and-idempotent-writes/spec.md — fetches the
// target's real current content (the same content-fetch path specs/040
// already established: read_project_file, already a required MCP tool
// for this agent since specs/042) and delegates the actual classification
// to the pure, independently-tested classifyWritePreflight() in
// packages/shared/write-preflight.ts.
async function preflightWrite(base: string, targetPath: string, newContent: string, taskId: string): Promise<WritePreflight> {
  const relativePath = path.relative(base, targetPath)
  try {
    const content = await mcpClient.callTool("read_project_file", { project_root: base, relative_path: relativePath }, taskId)
    return classifyWritePreflight(newContent, { ok: true, content })
  } catch (err) {
    return classifyWritePreflight(newContent, { ok: false, message: errorMessage(err) })
  }
}

// specs/079-phase-a-connect-orphaned-tools/spec.md — risks and summary
// are skill-aware now: build-image/verify-deployment/commit-changes
// execute real commands rather than writing a generated file, so the
// original "creates or overwrites a file" risk text would be actively
// misleading for them.
const EXECUTING_SKILL_COPY: Partial<Record<string, { summary: string; risks: string[] }>> = {
  "build-image": {
    summary: "Run a real `docker build` from the generated Dockerfile",
    risks: [
      "Runs a real `docker build` — creates or overwrites a local Docker image.",
      "No sandbox — build steps execute with the current OS user's Docker permissions.",
    ],
  },
  "verify-deployment": {
    summary: "Start a real container briefly to verify it boots, then stop it",
    risks: [
      "Starts a real Docker container — the image's own entrypoint/CMD executes with normal container permissions.",
      "Automatically stopped after a short observation window; not a persistent deployment.",
    ],
  },
  "commit-changes": {
    summary: "Create a real git commit from the current staged and unstaged changes",
    risks: [
      "Creates a real git commit — alters repository history, not just a file on disk.",
      "Stages ALL current changes (`git add -A`) before committing — see the diff above for exactly what that includes.",
    ],
  },
  "run-command": {
    summary: "Execute a real command with the exact argv shown below",
    risks: [
      "Executes a real command with the current OS user's permissions — may write files, start processes, or use the network.",
      "No sandbox or rollback — review the exact argv and working directory carefully before approving.",
    ],
  },
}

function buildApprovalPreview(action: PendingAction): ApprovalPreview {
  const executingCopy = EXECUTING_SKILL_COPY[action.skill]
  return {
    actionId: action.actionId,
    kind: action.toolName === "write_project_file" ? "file-write" : action.toolName ? "mcp-tool" : "command",
    summary: executingCopy
      ? executingCopy.summary
      : action.toolName === "write_project_file"
        ? `Write the model-authored ${AUTHORED_FILE_LABEL[FILE_SKILLS[action.skill]?.kind ?? "dockerfile"]}${action.summary ? ` — ${action.summary}` : ""}`
        : action.toolName
          ? `Call MCP tool "${action.toolName}" to write ${action.skill}`
          : `Approve skill "${action.skill}" (not yet implemented)`,
    target: action.targetPath,
    toolName: action.toolName,
    parameters: action.args,
    overwrite: action.previousContent !== undefined,
    content: action.content,
    previousContent: action.previousContent,
    fingerprint: action.fingerprint,
    risks: executingCopy?.risks ?? [
      "Creates or overwrites a file in the target project.",
      ...(action.toolName === "write_project_file"
        ? ["Written by the model and passed OrchestrAI's automatic safety checks — review the exact content below; building or running it is a separate approval."]
        : []),
      "No sandbox or rollback — the file is written with the current OS user's permissions.",
    ],
  }
}

// specs/103's own renderCodebaseAnalysis() moved to
// packages/shared/project-analysis.ts (specs/105) — imported above.

// specs/103-deep-project-analysis/spec.md — additive, fail-open. The
// deterministic report is always complete and useful on its own
// (specs/043's own precedent for exactly this shape), so a harness
// failure of any kind appends an explicit unavailable note and never
// fails the task.
async function computeCodebaseAnalysisSection(deterministicReport: string, projectPath: string, taskId: string): Promise<string | null> {
  if (!isHarnessFlagSet()) return null

  // specs/106-persistence-store-and-result-cache/spec.md — a real local
  // database read, no LLM call, no provider cost. A result computed by
  // the Orchestrator's own fallback (specs/105), or by a prior DevOps
  // run even after a restart, is reused here for free.
  const cached = await getCachedProjectAnalysis(projectPath, mcpClient, taskId)
  if (cached) return renderCodebaseAnalysis(cached)

  const config = readLlmHarnessConfig()
  if (!config) {
    return "=== Codebase Analysis ===\nCodebase analysis unavailable: ORCHESTRAI_DEVOPS_LLM_HARNESS is set but ORCHESTRAI_LLM_API_KEY is missing."
  }

  try {
    const model = await buildChatModel(config)
    console.log(`[devops-agent] llm harness (analyze-project): ${describeLlmModelConfig(config)}`)
    const result = await runProjectAnalysisHarness({ model, mcpClient, taskId, projectRoot: projectPath, deterministicReport })
    if (!result) {
      return "=== Codebase Analysis ===\nCodebase analysis unavailable: no observation survived grounding against the real project."
    }
    // No cheap fresh git_status already in hand on this path (unlike
    // the Orchestrator's own fetchProjectInspection(), which fetches
    // one alongside the analysis) — null falls back to TTL-only
    // validity, exactly as setCachedProjectAnalysis() documents.
    setCachedProjectAnalysis(projectPath, result, null, "devops-agent")
    return renderCodebaseAnalysis(result)
  } catch (err) {
    return `=== Codebase Analysis ===\nCodebase analysis unavailable: ${errorMessage(err)}`
  }
}

async function skillAnalyzeProject(text: string, taskId: string): Promise<{ result: string; warning?: string }> {
  const projectPath = resolveTargetPath(text)
  const devopsResult = await mcpClient.callTool("analyze_project", { project_path: projectPath }, taskId)

  const baseReportLines = ["=== DevOps MCP Analysis ===", devopsResult]
  const analysisSection = await computeCodebaseAnalysisSection(devopsResult, projectPath, taskId)
  if (analysisSection) baseReportLines.push("", analysisSection)

  // specs/094-analyze-project-security-precheck-opt-in/spec.md — opt-in,
  // defaults to OFF. With no A2A call attempted at all, analyze-project
  // returns exactly the DevOps analysis half — clean and fast, not even
  // a "skipped" note, matching a plain stack question's own real scope.
  if (!isAnalyzeSecretsPrecheckEnabled()) {
    const combined = boundTaskResult(baseReportLines.join("\n"))
    return { result: combined.text }
  }

  try {
    // specs/030 — this call already knows exactly which skill it wants;
    // sending it means Security executes scan-secrets regardless of what
    // this description text happens to say, the same fix applied to
    // Orchestrator-dispatched plan steps.
    //
    // specs/090-devops-security-precheck-timeout-too-short/spec.md — this
    // budget was 5_000ms, calibrated when scan-secrets was always a fast,
    // purely deterministic scan. specs/077 made Security's own AI-commentary
    // harness default-on, so this call now makes a real LLM round-trip —
    // live-caught genuinely timing out at ~5.1s under normal conditions.
    // A first fix bumped this to 20_000ms; a real live-measured full
    // scan-secrets-with-commentary round trip against this repository
    // (172 files, 42 findings, real AI commentary over all of them) took
    // ~30s end to end, so 20s was itself still undersized — corrected to
    // 45_000ms to hold a real margin above the measured worst case, not
    // just clear it exactly. Still a real, finite bound, not unbounded
    // (specs/045/055's own "bounded, never hang" precedent).
    const securityResult = await callAgent("security", `scan for secrets at "${projectPath}"`, {
      timeoutMs: 45_000,
      callerName: "devops-agent",
      taskId,
      selectedSkill: "scan-secrets",
    })
    const combined = boundTaskResult([
        ...baseReportLines,
        "",
        "=== Security Agent Secrets Pre-check ===",
        securityResult,
      ].join("\n"))
    return { result: combined.text }
  } catch (error) {
    const warning = `Security pre-check unavailable: ${errorMessage(error)}`
    const combined = boundTaskResult([
        ...baseReportLines,
        "",
        "=== Security Agent Secrets Pre-check — WARNING ===",
        warning,
        "No claim is made that the secrets scan passed.",
      ].join("\n"))
    return { warning, result: combined.text }
  }
}

async function skillGitStatus(text: string, taskId: string): Promise<string> {
  return mcpClient.callTool("git_status", { repo_path: resolveTargetPath(text) }, taskId)
}

// specs/079-phase-a-connect-orphaned-tools/spec.md §2/§3 — read-only,
// Tier 2, same shape as skillGitStatus above: connects an already-built
// MCP tool with zero preparation logic needed.
async function skillDockerStatus(taskId: string): Promise<string> {
  return mcpClient.callTool("docker_status", {}, taskId)
}

async function skillGitDiff(text: string, taskId: string): Promise<string> {
  return mcpClient.callTool("git_diff", { repo_path: resolveTargetPath(text), staged: false }, taskId)
}

// specs/079-phase-a-connect-orphaned-tools/spec.md §4 — the ONE write in
// this phase that alters history rather than producing an inspectable
// file, so it's held to a higher approval-preview bar: shows the real
// combined staged+unstaged diff (not just already-staged) because the
// underlying git_commit tool always runs `git add -A` before
// committing — previewing only what's currently staged would
// understate what's actually about to be captured. Both halves are
// fetched fresh, re-fetched identically at resume time, and bound to
// the approval via a content fingerprint of the combined text — the
// same computeContentFingerprint() mechanism specs/056 already uses for
// a single file's content, applied here to a diff instead.
async function computeFullUncommittedDiff(base: string, taskId: string): Promise<string> {
  const [staged, unstaged] = await Promise.all([
    mcpClient.callTool("git_diff", { repo_path: base, staged: true }, taskId),
    mcpClient.callTool("git_diff", { repo_path: base, staged: false }, taskId),
  ])
  const parts: string[] = []
  if (staged && staged.trim() !== "No changes found.") parts.push(`=== Already staged ===\n${staged}`)
  if (unstaged && unstaged.trim() !== "No changes found.") parts.push(`=== Not yet staged (will be staged by "git add -A") ===\n${unstaged}`)
  return parts.join("\n\n")
}

// Deliberately simple, deterministic extraction (matching extractAppType/
// extractPort's own style) — the LLM harness is scoped to the four
// original write skills' parameters only (specs/042) and is not extended
// to commit messages by this spec. stripPathPhrases() (already used by
// the shared target-path resolver) removes a trailing "at <path>" clause
// FIRST — live-caught while grounding this spec: without it, "commit
// changes: fix bug at C:\..." produced a message with the path clause
// stapled onto the end, exactly the dilution stripPathPhrases() already
// exists to prevent elsewhere (packages/shared/index.ts's own doc
// comment on it, written for the semantic classifier, applies here
// verbatim).
function extractCommitMessage(text: string): string {
  const withoutPath = stripPathPhrases(text)
  const match = withoutPath.match(/commit(?:\s+(?:the\s+)?changes)?\s*(?:with\s+message|message)?\s*[:\-]?\s*["']?([^"']+?)["']?$/i)
  const extracted = match?.[1]?.trim()
  return extracted && extracted.length > 0 && extracted.toLowerCase() !== "changes" ? extracted : "Committed via OrchestrAI"
}

// specs/080-run-command-approved-execution/spec.md §2 — async like
// handleCommitChangesSkill above (the LLM-proposal path needs an await),
// so it's handled as its own branch in processTask() rather than forced
// through prepareExecutingAction()'s synchronous shape.
async function handleRunCommandSkill(text: string, taskId: string): Promise<void> {
  try {
    const prepared = await prepareRunCommandAction(text, taskId)
    const action: PendingAction = { ...prepared, actionId: newActionId() }
    pendingActions.set(taskId, action)
    // specs/110-approval-state-survives-a-restart/spec.md B5 — command
    // approvals get the short, TTL-only "command" kind: no fingerprint
    // exists to re-check on restore, so staleness is bounded purely by
    // time (see restoreApprovalsOnStartup()'s own added risk line).
    persistPendingAction({ agent: "devops-agent", taskId, actionId: action.actionId, kind: "command", skill: action.skill, payload: action })
    tasks.set(taskId, {
      id: taskId, status: "input-required",
      requiresApproval: true,
      step: `waiting for human approval — will run: ${(action.args?.argv as string[] | undefined)?.join(" ") ?? "?"}`,
      approval: buildApprovalPreview(action),
    })
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: errorMessage(err) })
  }
}

async function handleCommitChangesSkill(text: string, taskId: string): Promise<void> {
  const base = resolveTargetPath(text)
  const message = extractCommitMessage(text)
  try {
    const combinedDiff = await computeFullUncommittedDiff(base, taskId)
    if (!combinedDiff) {
      tasks.set(taskId, { id: taskId, status: "completed", result: "Nothing to commit — no staged or unstaged changes." })
      return
    }
    const fingerprint = computeContentFingerprint(combinedDiff)
    const action: PendingAction = {
      actionId: newActionId(),
      skill: "commit-changes",
      toolName: "git_commit",
      targetPath: `commit in ${base}`,
      args: { repo_path: base, message },
      content: combinedDiff,
      fingerprint,
      projectRoot: base,
    }
    pendingActions.set(taskId, action)
    // specs/110-approval-state-survives-a-restart/spec.md B1 — a
    // fingerprinted write (of a diff, not a file, but the same
    // drift-recheck shape resumeTask() already gives it).
    persistPendingAction({ agent: "devops-agent", taskId, actionId: action.actionId, kind: "write", skill: action.skill, payload: action })
    tasks.set(taskId, {
      id: taskId, status: "input-required",
      requiresApproval: true,
      step: `waiting for human approval — commit message: "${message}"`,
      approval: buildApprovalPreview(action),
    })
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: errorMessage(err) })
  }
}

// ============================================================
// TASK PROCESSOR
// ============================================================
const NEEDS_APPROVAL = new Set(["dockerize", "create-ci", "create-gitignore", "create-compose"])
// specs/079-phase-a-connect-orphaned-tools/spec.md §1 — DevOps's first
// EXECUTING skills: run a real command via prepareExecutingAction()
// rather than generating file content, so they skip
// computeWriteContent()/preflightWrite() entirely (neither docker_build
// nor docker_run supports a dry_run preview the way the four
// content-generating tools do).
const EXECUTING_SKILLS = new Set(["build-image", "verify-deployment"])

async function processTask(task: ValidatedTask): Promise<void> {
  const text  = task.text
  // specs/030 — an authoritative selection wins outright; the description
  // text can no longer flip a git-status step into dockerize (the exact
  // live failure this checkpoint fixes). Absent selection falls back to
  // the existing detector, unchanged.
  const skill = task.selectedSkill ?? detectSkill(text)
  taskMeta.set(task.id, { skill, createdAt: Date.now() })

  tasks.set(task.id, { id: task.id, status: "working", step: `Skill detected: ${skill}` })

  // specs/079-phase-a-connect-orphaned-tools/spec.md §4 — commit-changes
  // needs an async MCP call (the real diff) before a PendingAction can
  // even be built, so it's handled entirely separately rather than
  // forced through prepareWriteAction()'s synchronous shape.
  if (skill === "commit-changes") {
    await handleCommitChangesSkill(text, task.id)
    return
  }

  // specs/080-run-command-approved-execution/spec.md §2 — same reasoning
  // as commit-changes above: needs an async step (tokenizing is sync, but
  // the LLM-proposal path is not) before a PendingAction can even be
  // built.
  if (skill === "run-command") {
    await handleRunCommandSkill(text, task.id)
    return
  }

  // specs/079-phase-a-connect-orphaned-tools/spec.md §1/§5 — executing
  // skills: build the PendingAction directly (prepareExecutingAction()
  // is synchronous, like prepareWriteAction()), skip content/preflight
  // computation entirely, go straight to input-required.
  if (EXECUTING_SKILLS.has(skill)) {
    try {
      const prepared = prepareExecutingAction(skill, text)
      const action: PendingAction = { ...prepared, actionId: newActionId() }
      pendingActions.set(task.id, action)
      tasks.set(task.id, {
        id: task.id, status: "input-required",
        requiresApproval: true,
        step: `waiting for human approval — target: ${action.targetPath}`,
        approval: buildApprovalPreview(action),
      })
    } catch (err) {
      tasks.set(task.id, { id: task.id, status: "failed", error: errorMessage(err) })
    }
    return
  }

  if (NEEDS_APPROVAL.has(skill)) {
    try {
      const prepared = await prepareAuthoredWrite(skill, text, task.id)
      const base = resolveTargetPath(text)
      const content = prepared.content!
      const preflight = await preflightWrite(base, prepared.targetPath, content, task.id)

      if (preflight.kind === "blocked") {
        tasks.set(task.id, {
          id: task.id, status: "failed",
          error: `Cannot safely check "${prepared.targetPath}" before writing: ${preflight.reason}`,
        })
        return
      }
      if (preflight.kind === "no-op") {
        // The exact defect this spec exists to fix: an identical re-run
        // never reaches a write-capable MCP tool call at all.
        tasks.set(task.id, {
          id: task.id, status: "completed",
          result: `Already up to date — "${prepared.targetPath}" already matches what would be written. No write performed.`,
        })
        return
      }

      const fingerprint = computeContentFingerprint(preflight.previousContent)
      const action: PendingAction = {
        ...prepared, actionId: newActionId(),
        content, previousContent: preflight.previousContent, fingerprint,
        projectRoot: base,
      }
      pendingActions.set(task.id, action)
      // specs/110-approval-state-survives-a-restart/spec.md B1 — the
      // fingerprinted-write path (dockerize/create-ci/create-gitignore/
      // create-compose). specs/138 removed the two no-fingerprint degrade
      // paths (unknown skill, failed dry-run): every file write here now
      // carries content and a fingerprint.
      persistPendingAction({ agent: "devops-agent", taskId: task.id, actionId: action.actionId, kind: "write", skill: action.skill, payload: action })
      tasks.set(task.id, {
        id: task.id, status: "input-required",
        requiresApproval: true,
        step: `waiting for human approval — target: ${action.targetPath}`,
        approval: buildApprovalPreview(action),
      })
    } catch (err) {
      tasks.set(task.id, { id: task.id, status: "failed", error: errorMessage(err) })
    }
    return
  }

  try {
    let result = ""
    if (skill === "analyze-project") {
      const analysis = await skillAnalyzeProject(text, task.id)
      tasks.set(task.id, {
        id: task.id,
        status: "completed",
        result: analysis.result,
        warning: analysis.warning,
        step: analysis.warning ? "completed with warning" : "completed",
      })
      return
    }
    else if (skill === "git-status") result = await skillGitStatus(text, task.id)
    else if (skill === "docker-status") result = await skillDockerStatus(task.id)
    else if (skill === "git-diff") result = await skillGitDiff(text, task.id)
    else result = `Skill "${skill}" not implemented yet`
    tasks.set(task.id, { id: task.id, status: "completed", result })
  } catch (err) {
    tasks.set(task.id, { id: task.id, status: "failed", error: errorMessage(err) })
  }
}

async function resumeTask(id: string): Promise<void> {
  const action = pendingActions.get(id)
  pendingActions.delete(id)
  // specs/110-approval-state-survives-a-restart/spec.md B0/B1/B5 — the
  // real single-consumption boundary once persistence is enabled; a
  // store miss/no-store both return true (nothing to claim), preserving
  // the in-memory Map as the sole boundary exactly as before this spec.
  // A safe no-op for EXECUTING/no-fingerprint actions too — those were
  // never persisted in the first place, so the store simply has no row
  // to claim and this returns true.
  const claimed = claimPendingAction({ agent: "devops-agent", taskId: id })
  if (!claimed) {
    tasks.set(id, { id, status: "failed", error: "This approval was already consumed (or has expired) — resubmit for a fresh preview." })
    return
  }
  tasks.set(id, { id, status: "working", step: "approved — executing" })
  try {
    // specs/056-devops-preflight-and-idempotent-writes/spec.md — the
    // fingerprint re-check. `fingerprint`/`projectRoot` are only ever set
    // on an action that actually went through preflightWrite() above (a
    // real create/update write); an action with no fingerprint (the
    // dry-run-failed degrade path, or an "unknown" skill with no
    // toolName/args) skips straight to the pre-056 execution path,
    // unchanged. A mismatch means the target changed after approval but
    // before this moment — refuse the write and require a fresh
    // preflight rather than overwrite content the human never reviewed.
    // specs/079-phase-a-connect-orphaned-tools/spec.md §4 — commit-changes
    // has its own drift check: re-fetches the SAME combined staged+
    // unstaged diff computeFullUncommittedDiff() computed at preview
    // time and compares fingerprints, rather than the generic
    // single-file read_project_file check below (its own targetPath
    // isn't a real file — "commit in <path>" — so that check would
    // simply fail to resolve a path at all).
    if (action?.skill === "commit-changes" && action.fingerprint !== undefined && action.projectRoot !== undefined) {
      const currentDiff = await computeFullUncommittedDiff(action.projectRoot, id)
      const currentFingerprint = computeContentFingerprint(currentDiff)
      if (currentFingerprint !== action.fingerprint) {
        tasks.set(id, {
          id, status: "failed",
          error: `Staged/unstaged changes in "${action.projectRoot}" changed after approval but before this commit — refusing to commit unreviewed content. Resubmit for a fresh preflight.`,
        })
        return
      }
    } else if (action?.fingerprint !== undefined && action.projectRoot !== undefined) {
      const relativePath = path.relative(action.projectRoot, action.targetPath)
      let currentContent: string | undefined
      try {
        currentContent = await mcpClient.callTool(
          "read_project_file",
          { project_root: action.projectRoot, relative_path: relativePath },
          id,
        )
      } catch (err) {
        const message = errorMessage(err)
        // "Path not found" here means the target went from absent (a
        // create) to still-absent — expected, not drift; anything else
        // (the target disappeared after existing, or became unreadable)
        // is genuine drift and fails the same as a content mismatch.
        if (!message.startsWith(PATH_NOT_FOUND_PREFIX)) {
          tasks.set(id, { id, status: "failed", error: `Target changed after approval — cannot re-verify: ${message}. Resubmit for a fresh preflight.` })
          return
        }
      }
      const currentFingerprint = computeContentFingerprint(currentContent)
      if (currentFingerprint !== action.fingerprint) {
        tasks.set(id, {
          id, status: "failed",
          error: `Target "${action.targetPath}" changed after approval but before this write — refusing to overwrite unreviewed content. Resubmit for a fresh preflight.`,
        })
        return
      }
    }

    // specs/080-run-command-approved-execution/spec.md §4 — run_command's
    // own server-side budget (packages/mcp/index.ts's RUN_COMMAND_TIMEOUT_MS)
    // is 120s; the client's own default (TOOL_TIMEOUT_MS, 15s) would abort
    // long before that budget is ever reached — exactly the class of bug
    // specs/076 diagnosed for run_tests. A small buffer over the server's
    // own budget accounts for MCP round-trip overhead beyond the child
    // process's own timeout. docker_build genuinely needs the same
    // treatment — live-caught while closing out specs/079's own
    // build-image acceptance criterion: a real image build (base-image
    // pull + a real dependency install) routinely exceeds the client's
    // old 15s default, matching packages/mcp/index.ts's own
    // DOCKER_BUILD_TIMEOUT_MS (180s) server-side budget.
    const callTimeoutMs =
      action?.toolName === "run_command" ? 135_000 :
      action?.toolName === "docker_build" ? 195_000 :
      undefined
    // specs/138 — a model-authored file is written with exactly the content
    // the human approved (computed once at preview, specs/040), and may
    // replace an existing file only when preflight saw one.
    const callArgs = action?.toolName === "write_project_file"
      ? { ...action.args, content: action.content ?? "", overwrite: action.previousContent !== undefined }
      : action?.args
    let result = action?.toolName && callArgs
      ? await mcpClient.callTool(action.toolName, callArgs, id, callTimeoutMs)
      : `Skill "${action?.skill}" approved but not implemented`

    // specs/101-per-agent-tool-access-expansion/spec.md §B — lint_ci_workflow
    // was declared in REQUIRED_TOOLS since specs/079 but never actually
    // called from any skill. Wired here: a workflow this project just
    // wrote is immediately structurally validated (has 'on:'/'jobs:', no
    // tabs) and the result folded into the same task result. Best-effort —
    // a lint failure never fails the write itself, which already
    // succeeded; it only adds visible information about what was written.
    if (action?.skill === "create-ci" && action.targetPath) {
      try {
        const lintResult = await mcpClient.callTool("lint_ci_workflow", { workflow_path: action.targetPath }, id)
        result = [result, "", "=== CI Workflow Lint ===", lintResult].join("\n")
      } catch (err) {
        result = [result, "", `=== CI Workflow Lint === \nunavailable: ${errorMessage(err)}`].join("\n")
      }
    }

    tasks.set(id, { id, status: "completed", result })
  } catch (err) {
    tasks.set(id, { id, status: "failed", error: errorMessage(err) })
  } finally {
    // specs/110-approval-state-survives-a-restart/spec.md — once claimed,
    // the persisted row must never outlive this attempt, regardless of
    // outcome. A safe no-op for an action that was never persisted.
    forgetPendingAction({ agent: "devops-agent", taskId: id })
  }
}

// ============================================================
// HONO APP
// ============================================================
export const app = new Hono()

app.get("/.well-known/agent.json", (c) => c.json(agentCard))
app.get("/healthz", async (c) => {
  const ready = await mcpClient.pingReady()
  const mcp = mcpClient.readiness()
  return c.json({
    status: "ok",
    ready,
    agent: agentCard.name,
    tasks: tasks.size,
    dependencies: { mcp },
  })
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

  // Nothing async happens between this point and resumeTask()'s synchronous
  // prefix (which consumes pendingActions and transitions status), so a
  // concurrent duplicate approve/reject cannot interleave here.
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
  forgetPendingAction({ agent: "devops-agent", taskId: id })
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
          if (["completed","failed","input-required"].includes(t.status)) break
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
    submitted:      "#9ca3af",
    working:        "#58a6ff",
    completed:      "#3fb950",
    failed:         "#f85149",
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
              <button class="btn gray"  onclick="viewApproval('${t.id}')">Details</button>
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
  <title>OrchestrAI — DevOps Agent</title>
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
    .approval-card{margin-bottom:1rem}
    .approval-row{margin-bottom:12px}
    .approval-label{color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
    .approval-target{background:#0d1117;border:1px solid #d29922;border-radius:4px;padding:8px 10px;font-family:monospace;font-size:13px;color:#e3b341;word-break:break-all}
    .approval-action{font-family:monospace;font-size:13px;color:#c9d1d9}
    .approval-params{background:#0d1117;border-radius:4px;padding:8px 10px;font-family:monospace;font-size:12px}
    .approval-params div{padding:2px 0;color:#c9d1d9}
    .approval-params span{color:#8b949e}
    .approval-risks{list-style:none;margin:0;padding:0}
    .approval-risks li{background:#3a1a1a;color:#f85149;border-radius:4px;padding:6px 10px;font-size:12px;margin-bottom:4px}
    .approval-actionid{color:#6e7681;font-size:11px;font-family:monospace}
    .approval-rawtoggle{background:none;border:none;color:#58a6ff;font-size:11px;cursor:pointer;padding:0;margin-top:8px;text-decoration:underline;font-family:monospace}
    /* specs/040-approval-preview-content-diff/spec.md */
    .approval-content-box{background:#0d1117;border-radius:4px;padding:8px 10px;font-family:monospace;font-size:12px;max-height:320px;overflow:auto;white-space:pre;color:#c9d1d9}
    .approval-diff-line{white-space:pre}
    .approval-diff-added{background:#1a3a1a;color:#3fb950}
    .approval-diff-removed{background:#3a1a1a;color:#f85149}
    .approval-omitted{background:#2d2410;border:1px solid #d29922;border-radius:4px;padding:8px 10px;font-size:12px;color:#e3b341}
  </style>
</head>
<body>
  <h1>OrchestrAI — DevOps Agent</h1>
  <p class="sub">Port 3002 &nbsp;·&nbsp; Auto-refreshes every 3s</p>

  <div class="stats">
    <div class="stat"><div class="stat-n">${all.length}</div><div class="stat-l">Total</div></div>
    <div class="stat"><div class="stat-n" style="color:#3fb950">${completed}</div><div class="stat-l">Completed</div></div>
    <div class="stat"><div class="stat-n" style="color:#d29922">${pending}</div><div class="stat-l">Pending Approval</div></div>
    <div class="stat"><div class="stat-n" style="color:#f85149">${failed}</div><div class="stat-l">Failed</div></div>
  </div>

  <div class="card">
    <div class="card-title">Send Task</div>
    <div class="quick">
      <button class="qbtn" onclick="q('analyze my project')">Analyze Project</button>
      <button class="qbtn" onclick="q('git status')">Git Status</button>
      <button class="qbtn" onclick="q('dockerize bun app on port 3000')">Create Dockerfile</button>
      <button class="qbtn" onclick="q('create ci pipeline for bun')">Create CI Pipeline</button>
      <button class="qbtn" onclick="q('create gitignore for bun')">Create .gitignore</button>
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
      <div id="modal-approval" class="approval-card" style="display:none"></div>
      <pre id="modal-body"></pre>
      <button id="modal-raw-toggle" class="approval-rawtoggle" style="display:none" onclick="toggleRawJson()">Show raw JSON</button>
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
      const res  = await fetch('/tasks/' + id + '/approve', {
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
      const res  = await fetch('/tasks/' + id + '/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId }),
      })
      const data = await res.json()
      if (data.error) { toast(data.error, '#da3633'); return }
      toast('Rejected', '#da3633')
      setTimeout(() => location.reload(), 800)
    }

    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]))
    }

    // specs/040-approval-preview-content-diff/spec.md — ported verbatim
    // from apps/orchestrator/index.ts, same reasoning as this file's own
    // renderApprovalCard()/escapeHtml() (specs/035): a browser <script>
    // template string with no bundler linking it to
    // packages/shared/line-diff.ts, the canonical implementation.
    function computeLineDiff(before, after) {
      const a = before.length > 0 ? before.split('\\n') : []
      const b = after.length > 0 ? after.split('\\n') : []
      const m = a.length, n = b.length
      const lcs = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
        }
      }
      const result = []
      let i = 0, j = 0
      while (i < m && j < n) {
        if (a[i] === b[j]) { result.push({ type: 'unchanged', text: a[i] }); i++; j++ }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { result.push({ type: 'removed', text: a[i] }); i++ }
        else { result.push({ type: 'added', text: b[j] }); j++ }
      }
      while (i < m) { result.push({ type: 'removed', text: a[i] }); i++ }
      while (j < n) { result.push({ type: 'added', text: b[j] }); j++ }
      return result
    }

    const CONTENT_PREVIEW_MAX_BYTES = 65536

    function contentPreviewHtml(approval) {
      const content = approval.content
      const previousContent = approval.previousContent
      if (content === undefined && previousContent === undefined) return ''

      const totalBytes = new TextEncoder().encode(content ?? '').length + new TextEncoder().encode(previousContent ?? '').length
      if (totalBytes > CONTENT_PREVIEW_MAX_BYTES) {
        return \`<div class="approval-row"><div class="approval-label">Content</div><div class="approval-omitted">Content is \${totalBytes.toLocaleString()} bytes — too large to preview inline. See "Show raw JSON" for the full value.</div></div>\`
      }

      if (previousContent !== undefined) {
        const diffHtml = computeLineDiff(previousContent, content ?? '').map((d) => {
          const cls = d.type === 'added' ? ' approval-diff-added' : d.type === 'removed' ? ' approval-diff-removed' : ''
          const prefix = d.type === 'added' ? '+ ' : d.type === 'removed' ? '- ' : '  '
          return \`<div class="approval-diff-line\${cls}">\${escapeHtml(prefix + d.text)}</div>\`
        }).join('')
        return \`<div class="approval-row"><div class="approval-label">Content diff</div><div class="approval-content-box">\${diffHtml}</div></div>\`
      }

      return \`<div class="approval-row"><div class="approval-label">Content</div><div class="approval-content-box">\${escapeHtml(content)}</div></div>\`
    }

    // specs/114-coder-multi-file-edit-and-create/spec.md — ported
    // per-instance alongside apps/orchestrator/index.ts's own copy
    // (specs/035's existing precedent). DevOps never actually sets
    // approval.files itself — this is purely defensive consistency so
    // the two dashboards' shared renderApprovalCard() never silently
    // diverge in what shape they can render.
    function multiFileContentHtml(files) {
      return files.map((f) => {
        const isCreate = f.action === 'create'
        const badge = \`<span class="badge" style="color:\${isCreate ? '#3fb950' : '#d29922'}">\${isCreate ? 'NEW' : 'EDIT'}</span>\`
        const label = \`\${badge} \${escapeHtml(f.target)}\`
        const totalBytes = new TextEncoder().encode(f.content ?? '').length + new TextEncoder().encode(f.previousContent ?? '').length
        if (totalBytes > CONTENT_PREVIEW_MAX_BYTES) {
          return \`<div class="approval-row"><div class="approval-label">\${label}</div><div class="approval-omitted">Content is \${totalBytes.toLocaleString()} bytes — too large to preview inline. See "Show raw JSON" for the full value.</div></div>\`
        }
        if (f.previousContent !== undefined) {
          const diffHtml = computeLineDiff(f.previousContent, f.content ?? '').map((d) => {
            const cls = d.type === 'added' ? ' approval-diff-added' : d.type === 'removed' ? ' approval-diff-removed' : ''
            const prefix = d.type === 'added' ? '+ ' : d.type === 'removed' ? '- ' : '  '
            return \`<div class="approval-diff-line\${cls}">\${escapeHtml(prefix + d.text)}</div>\`
          }).join('')
          return \`<div class="approval-row"><div class="approval-label">\${label}</div><div class="approval-content-box">\${diffHtml}</div></div>\`
        }
        return \`<div class="approval-row"><div class="approval-label">\${label}</div><div class="approval-content-box">\${escapeHtml(f.content ?? '')}</div></div>\`
      }).join('')
    }

    function renderApprovalCard(approval) {
      const actionLine = approval.toolName
        ? \`MCP tool call: <code>\${escapeHtml(approval.toolName)}</code>\`
        : approval.executable
        ? \`Command: <code>\${escapeHtml(approval.executable)}\${approval.argv ? ' ' + approval.argv.map(escapeHtml).join(' ') : ''}</code>\`
        : escapeHtml(approval.kind || 'action')

      const paramsHtml = approval.parameters && Object.keys(approval.parameters).length
        ? \`<div class="approval-row"><div class="approval-label">Parameters</div><div class="approval-params">\${
            Object.entries(approval.parameters).map(([k, v]) =>
              \`<div><span>\${escapeHtml(k)}:</span> \${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v)}</div>\`
            ).join('')
          }</div></div>\`
        : ''

      const risksHtml = approval.risks && approval.risks.length
        ? \`<div class="approval-row"><div class="approval-label">Risks</div><ul class="approval-risks">\${
            approval.risks.map(r => \`<li>\${escapeHtml(r)}</li>\`).join('')
          }</ul></div>\`
        : ''

      const overwriteLine = approval.overwrite !== undefined
        ? \`<div class="approval-row"><div class="approval-label">Overwrite</div><div class="approval-action">\${approval.overwrite}</div></div>\`
        : ''

      return \`
        <div class="approval-row">
          <div class="approval-label">Target</div>
          <div class="approval-target">\${escapeHtml(approval.target)}</div>
        </div>
        <div class="approval-row">
          <div class="approval-label">Action</div>
          <div class="approval-action">\${actionLine}</div>
        </div>
        \${paramsHtml}
        \${approval.files && approval.files.length ? multiFileContentHtml(approval.files) : contentPreviewHtml(approval)}
        \${overwriteLine}
        \${risksHtml}
        <div class="approval-actionid">actionId: \${escapeHtml(approval.actionId)}</div>
      \`
    }

    let rawJsonVisible = false

    function toggleRawJson() {
      rawJsonVisible = !rawJsonVisible
      document.getElementById('modal-body').style.display = rawJsonVisible ? 'block' : 'none'
      document.getElementById('modal-raw-toggle').textContent = rawJsonVisible ? 'Hide raw JSON' : 'Show raw JSON'
    }

    async function viewApproval(id) {
      const r = await fetch('/tasks/' + id)
      const d = await r.json()
      const approvalEl = document.getElementById('modal-approval')
      const rawToggle  = document.getElementById('modal-raw-toggle')
      const bodyEl     = document.getElementById('modal-body')
      rawJsonVisible = false

      document.getElementById('modal-title').textContent = 'Approval preview — ' + id
      bodyEl.textContent = JSON.stringify(d.approval, null, 2)
      if (d.approval) {
        approvalEl.innerHTML = renderApprovalCard(d.approval)
        approvalEl.style.display = 'block'
        rawToggle.style.display = 'inline'
        rawToggle.textContent = 'Show raw JSON'
        bodyEl.style.display = 'none'
      } else {
        approvalEl.style.display = 'none'
        approvalEl.innerHTML = ''
        rawToggle.style.display = 'none'
        bodyEl.style.display = 'block'
      }
      document.getElementById('overlay').style.display = 'flex'
    }

    function resetModalToPlainBody() {
      document.getElementById('modal-approval').style.display = 'none'
      document.getElementById('modal-approval').innerHTML = ''
      document.getElementById('modal-raw-toggle').style.display = 'none'
      document.getElementById('modal-body').style.display = 'block'
    }

    async function viewResult(id) {
      const r = await fetch('/tasks/' + id)
      const d = await r.json()
      resetModalToPlainBody()
      document.getElementById('modal-title').textContent = 'Result — ' + id
      document.getElementById('modal-body').textContent = d.result || '(empty)'
      document.getElementById('overlay').style.display = 'flex'
    }

    async function viewError(id) {
      const r = await fetch('/tasks/' + id)
      const d = await r.json()
      resetModalToPlainBody()
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
// packages/agents/devops/index.ts` is unaffected — import.meta.main is
// still true for that exact invocation, same as before this change.
const PORT = resolveServicePort("devops")

// specs/110-approval-state-survives-a-restart/spec.md B1/B5/B6 — called
// once, before the HTTP server binds. A restored "command" action gets
// an added risk line naming that no drift recheck is possible for it
// (see the module's own B5 note); a restored "write" action needs no
// such addition — its existing fingerprint recheck in resumeTask()
// already covers it identically to a same-process approval.
function restoreApprovalsOnStartup(): void {
  const restored = restorePendingActions<PendingAction>({
    agent: "devops-agent",
    validate: (raw) => {
      const parsed = PersistedDevOpsActionSchema.safeParse(raw)
      return parsed.success ? (parsed.data as PendingAction) : null
    },
  })
  for (const row of restored) {
    pendingActions.set(row.taskId, row.payload)
    const preview = buildApprovalPreview(row.payload)
    if (row.kind === "command") {
      preview.risks = [
        ...(preview.risks ?? []),
        "This command was approved before a process restart. Its target may have changed since — no automatic recheck is possible for a command.",
      ]
    }
    tasks.set(row.taskId, {
      id: row.taskId, status: "input-required",
      requiresApproval: true,
      step: `restored after restart — waiting for human approval — target: ${row.payload.targetPath}`,
      approval: preview,
    })
  }
  if (restored.length > 0) console.log(`[devops-agent] restored ${restored.length} pending approval(s) after restart`)
}

export function start() {
  mcpClient.start()
  restoreApprovalsOnStartup()
  const agentHttpServer = serve({ fetch: app.fetch, port: PORT })

  // specs/107-task-and-conversation-history/spec.md B4 — so a task
  // dispatched directly to this agent (A2A, TUI direct mode — never
  // routed through the Orchestrator) is still recorded.
  const stopTaskSweep = startTaskPersistenceSweep("devops-agent", tasks, (id) => taskMeta.get(id) ?? null)

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
  if (harnessStartup.warning) console.warn(`[devops-agent] WARNING: ${harnessStartup.warning}`)
  console.log(`
DevOps A2A Agent running
Dashboard → http://localhost:${PORT}/dashboard
Agent Card → http://localhost:${PORT}/.well-known/agent.json
LLM harness: ${harnessStartup.summary}
`)
}

if (import.meta.main) {
  start()
}
