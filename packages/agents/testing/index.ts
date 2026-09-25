import { Hono } from "hono"
import { serve } from "bun"
import { existsSync } from "fs"
import * as path from "path"
import { resolveTargetPath, stripPathPhrases } from "../../shared"
import { resolveServicePort } from "../../shared/service-ports"
import { parseTaskEnvelope, readJsonBody, validateSelectedSkillOwnership, type ValidatedTask } from "../../shared/task-envelope"
import { newActionId, validateActionId, computeContentFingerprint, type ApprovalPreview } from "../../shared/approval"
import { classifyWritePreflight, PATH_NOT_FOUND_PREFIX } from "../../shared/write-preflight"
import { boundTaskResult, flushAuditBufferForShutdown } from "../../shared/audit"
import { OrchestraiMcpClient } from "../../shared/mcp-client"
import { detectRunner, parseCoveragePercent, parseTestCounts, type DetectionResult, type RunnerProfile } from "../../shared/test-runner"
import { splitPlanStepText } from "../../shared/plan-step-text"
import {
  buildChatModel,
  describeLlmModelConfig,
  isHarnessFlagSet,
  readLlmHarnessConfig,
  readLlmHarnessStartupState,
} from "./model-factory"
import { runTestCommandHarness, runWriteTestsHarness } from "./llm-harness"
import { startTaskPersistenceSweep } from "../../shared/store"
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
  name: "testing-agent",
  description: "Runs test suites and reports results before deployment. Executing a runner requires human approval.",
  url: `http://localhost:${resolveServicePort("testing")}`,
  version: "2.0.0",
  skills: [
    {
      id: "run-tests",
      name: "Run Tests",
      description: "Detect the project's test runner and, after human approval, run it and report pass/fail",
      examples: ["run tests for bun project at C:\\path\\to\\project"],
    },
    {
      id: "check-coverage",
      name: "Check Coverage",
      description: "Run tests with coverage reporting (approval required) if the runner supports it",
      examples: ["check test coverage at C:\\path\\to\\project"],
    },
    // specs/081-testing-write-tests-skill/spec.md (Phase C) — a genuinely
    // new skill, used only when explicitly asked for, never a side effect
    // of run-tests/check-coverage. Writing the test file and running it
    // are always two separate approvals — this skill never dispatches
    // run-tests/run_command itself.
    {
      id: "write-tests",
      name: "Write Tests",
      description: "Write a test file for ONE source file the request itself names (e.g. \"write tests for src/foo.ts\"). Not for a whole-project or unnamed-file request such as \"write tests for my project\" - that needs planning to pick files first. Writing needs approval; running is a separate approval.",
      examples: ["write tests for src/foo.ts at C:\\path\\to\\project"],
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

// specs/107-task-and-conversation-history/spec.md B4 — Testing's own
// TaskResult carries no skill/createdAt, so a small side map records
// both at the one place processTask() already computes them (its own
// selectedSkill-or-detectSkill() line), rather than threading two new
// fields through every existing tasks.set() call site in this file.
const taskMeta = new Map<string, { skill: string; createdAt: number }>()

const mcpClient = new OrchestraiMcpClient({
  callerName: "testing-agent",
  requiredTools: [
    // specs/138 — run_tests (the fixed-command tool) was removed.
    // specs/080-run-command-approved-execution/spec.md §3 — read_project_file
    // grounds the harness's own proposal in real project files; run_command
    // is the fallback execution primitive itself, shared with DevOps.
    "read_project_file",
    "run_command",
    // specs/081-testing-write-tests-skill/spec.md — write-tests's own
    // output tool, already exists on the shared MCP server and already
    // used by Documentation; this is only a new consumer of it.
    "write_project_file",
    // specs/101-per-agent-tool-access-expansion/spec.md — the uniform
    // general-inspection set every code-reasoning agent now gets:
    // read_project_file (above), analyze_project, git_status, git_diff.
    // Not currently consumed by any deterministic skill handler here
    // (detectRunner() stays manifest-driven, unchanged) — these three
    // exist so a future harness call site can bind them; a required
    // tool with no current caller is otherwise exactly the orphaned-tool
    // shape this same spec closes for DevOps, so this addition is
    // deliberately paired with real harness bindings (see
    // llm-harness.ts) rather than left declared-but-unused.
    "analyze_project",
    "git_status",
    "git_diff",
  ],
})

function detectSkill(text: string): string {
  const lower = text.toLowerCase()
  // specs/081-testing-write-tests-skill/spec.md — checked BEFORE the bare
  // "test" catch-all below, the same specificity-first ordering
  // specs/079/080 already established for their own new skills: a bare
  // "test" substring would otherwise swallow "write tests for X" into
  // run-tests.
  if (lower.includes("write test") || lower.includes("generate test") || lower.includes("create test") || lower.includes("add test")) return "write-tests"
  if (lower.includes("coverage")) return "check-coverage"
  if (lower.includes("test"))     return "run-tests"
  return "unknown"
}

// ============================================================
// TIER 1 COMMAND EXECUTION SAFETY
// ============================================================
// Fixed, non-extensible argv shapes only — task text can never supply an
// executable, shell syntax, extra flags, or a raw command string. See
// specs/006-runtime-stabilization/spec.md "Testing Execution Safety". Actual
// execution now happens inside the MCP run_tests tool
// (specs/011-remaining-agents-mcp/spec.md) using this exact same shared table —
// this agent only resolves the runner and builds the approval preview.
const FIXED_TIMEOUT_MS = 120_000

// specs/080-run-command-approved-execution/spec.md §4 — absorbs
// specs/076's own diagnosed bug: the MCP client's own default call
// timeout (TOOL_TIMEOUT_MS, 15s) fires long before either run_tests's or
// run_command's real server-side budget (FIXED_TEST_TIMEOUT_MS/
// RUN_COMMAND_TIMEOUT_MS, both 120s in packages/mcp/index.ts) is ever
// reachable. A small buffer over that server-side budget accounts for
// MCP round-trip overhead beyond the child process's own timeout.
const MCP_CALL_TIMEOUT_MS = FIXED_TIMEOUT_MS + 15_000

// specs/080-run-command-approved-execution/spec.md §3, amended by
// specs/138 — "run-tests" and "run-command" both execute a proposed argv
// via the shared run_command MCP tool (the fixed RUNNER_ARGV profiles and
// the run_tests tool are gone). Both route through the identical actionId-bound approval
// gate. specs/081-testing-write-tests-skill/spec.md adds "write-tests" —
// a genuinely different shape (file content, not a command), kept as a
// discriminated union rather than widening the existing fields to
// optional, so each branch stays fully typed with no `!`/undefined
// guards needed at the read sites below.
interface RunAction {
  actionId: string
  source: "run-tests" | "run-command"
  executable: string
  argv: string[]
  cwd: string
  timeoutMs: number
  withCoverage: boolean
}

interface WriteTestsAction {
  actionId: string
  source: "write-tests"
  projectRoot: string
  // The NEW test file's own path, relative to projectRoot — derived
  // deterministically by deriveTestFilePath(), never model-chosen.
  relativePath: string
  sourceRelativePath: string
  // specs/040/056 — computed once at preview time, reused verbatim at
  // write time; fingerprint re-verified immediately before the real
  // write in resumeTask(), the same drift guarantee DevOps's own writes
  // already have (deliberately adopted over Documentation's lighter
  // pattern — see specs/081's own "Verified Current State" for why).
  content: string
  previousContent?: string
  fingerprint: string
}

type PendingAction = RunAction | WriteTestsAction

const pendingActions = new Map<string, PendingAction>()

// specs/110-approval-state-survives-a-restart/spec.md B2/B5/B6 — validates
// a restored row's JSON.parse()'d payload against the exact runtime
// shape of each PendingAction variant.
const PersistedRunActionSchema = z.object({
  actionId: z.string(),
  source: z.union([z.literal("run-tests"), z.literal("run-command")]),
  executable: z.string(),
  argv: z.array(z.string()),
  cwd: z.string(),
  timeoutMs: z.number(),
  withCoverage: z.boolean(),
})
const PersistedWriteTestsActionSchema = z.object({
  actionId: z.string(),
  source: z.literal("write-tests"),
  projectRoot: z.string(),
  relativePath: z.string(),
  sourceRelativePath: z.string(),
  content: z.string(),
  previousContent: z.string().optional(),
  fingerprint: z.string(),
})
const PersistedTestingActionSchema = z.union([PersistedRunActionSchema, PersistedWriteTestsActionSchema])

function buildApprovalPreview(action: PendingAction): ApprovalPreview {
  if (action.source === "write-tests") {
    return {
      actionId: action.actionId,
      kind: "file-write",
      summary: `Write test file "${action.relativePath}" (tests ${action.sourceRelativePath})`,
      target: path.join(action.projectRoot, action.relativePath),
      overwrite: action.previousContent !== undefined,
      content: action.content,
      previousContent: action.previousContent,
      fingerprint: action.fingerprint,
      risks: [
        "AI-authored test code — no guarantee of correctness or coverage quality; review before relying on it.",
        "Creates or overwrites a file in the target project. Approving this write does NOT execute it — running the tests is always a separate, later approval.",
      ],
    }
  }

  const isRunCommand = action.source === "run-command"
  return {
    actionId: action.actionId,
    kind: "command",
    summary: `Run "${action.argv.join(" ")}"`,
    target: action.cwd,
    executable: action.executable,
    argv: action.argv,
    cwd: action.cwd,
    timeoutMs: action.timeoutMs,
    risks: isRunCommand
      ? [
          "This command was given explicitly in the request — review the exact argv.",
          "No sandbox or rollback — approved commands run with the current OS user's permissions and may mutate files, start child processes, or use the network.",
        ]
      : [
          // specs/138 — every test command is model-proposed now.
          "This test command was proposed by the model from the project (not a fixed, pre-reviewed profile) — review the exact argv before approving.",
          "No sandbox or rollback — approval does not make test code safe; tests run with the current OS user's permissions and may mutate files, start child processes, or use the network.",
        ],
  }
}

// specs/080-run-command-approved-execution/spec.md §3 — a plain, no-shell
// tokenizer, the same shape as DevOps's own tokenizeCommandText() (kept
// as an independent per-agent copy, matching this codebase's established
// precedent of not sharing harness/parsing internals across agents).
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

// Deliberately the same narrow trigger phrase DevOps's own run-command
// skill uses ("run command:"/"execute command:") so an explicit command
// is recognized consistently across both agents that can execute one.
// stripPathPhrases() first — same reasoning as DevOps's own
// extractRunCommandText() (specs/079's extractCommitMessage() live-caught
// this exact class of bug first): without it, a trailing "at <path>"
// clause becomes part of the command text itself.
function extractRunCommandText(text: string): string | null {
  const withoutPath = stripPathPhrases(text)
  const match = withoutPath.match(/(?:run|execute)\s+command\s*[:\-]?\s*(.+)$/i)
  const extracted = match?.[1]?.trim()
  return extracted && extracted.length > 0 ? extracted : null
}

// specs/138 — "run-tests" is now a MODEL-PROPOSED test command; "run-command"
// is a command the request gave explicitly. Both run via run_command.
function proposeRunCommandAction(taskId: string, projectPath: string, argv: string[], source: "run-tests" | "run-command" = "run-command", withCoverage = false): void {
  const action: PendingAction = {
    actionId: newActionId(),
    source,
    executable: argv[0]!,
    argv,
    cwd: projectPath,
    timeoutMs: FIXED_TIMEOUT_MS,
    withCoverage,
  }
  pendingActions.set(taskId, action)
  // specs/110-approval-state-survives-a-restart/spec.md B5 — command
  // approvals: no fingerprint exists to re-check on restore, so this is
  // the short, TTL-only "command" kind.
  persistPendingAction({ agent: "testing-agent", taskId, actionId: action.actionId, kind: "command", skill: action.source, payload: action })
  tasks.set(taskId, {
    id: taskId,
    status: "input-required",
    requiresApproval: true,
    step: `waiting for human approval — will run: ${argv.join(" ")}`,
    approval: buildApprovalPreview(action),
  })
}

// specs/138 — the Testing agent's fixed test-command profiles
// (RUNNER_ARGV) were removed; the model proposes every test command.
export const TESTING_TEMPLATES_REMOVED_MESSAGE =
  "needs the Testing LLM (ORCHESTRAI_TESTING_LLM_HARNESS on and a provider key) to propose the test command — the fixed runner commands were removed in specs/138"

function describeDetection(detection: DetectionResult): string {
  if (detection.kind === "detected") return `${detection.runner} (from the project's own manifest/lockfile)`
  if (detection.kind === "ambiguous") return `ambiguous — more than one runner is plausible: ${detection.candidates.join(" vs ")}`
  return "none of bun, npm, pnpm, yarn, jest, vitest or pytest was detected"
}

// specs/080 + specs/138 — how a run-tests/check-coverage command is chosen:
//   1. An explicit "run command: …" in the request always wins, parsed
//      deterministically with no model call (specs/080).
//   2. Otherwise the model proposes the command, told what detectRunner()
//      found (a hint, not an answer) and whether coverage is wanted.
//   3. With the Testing LLM off or no key: fail closed with a named error
//      — there is no fixed command to fall back to any more.
// Every command is individually approved before it runs (specs/080).
async function proposeTestCommand(taskId: string, text: string, projectPath: string, detection: DetectionResult, withCoverage: boolean): Promise<void> {
  const explicitText = extractRunCommandText(text)
  if (explicitText) {
    const argv = tokenizeCommandText(explicitText)
    if (argv.length === 0) {
      tasks.set(taskId, { id: taskId, status: "failed", error: `No command found after "run command:" in "${text}"` })
      return
    }
    proposeRunCommandAction(taskId, projectPath, argv, "run-command", withCoverage)
    return
  }

  if (!isHarnessFlagSet()) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `${withCoverage ? "check-coverage" : "run-tests"} ${TESTING_TEMPLATES_REMOVED_MESSAGE}` })
    return
  }
  const config = readLlmHarnessConfig()
  if (!config) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `${withCoverage ? "check-coverage" : "run-tests"} ${TESTING_TEMPLATES_REMOVED_MESSAGE} (ORCHESTRAI_LLM_API_KEY is missing)` })
    return
  }

  try {
    const model = await buildChatModel(config)
    console.log(`[testing-agent] llm harness (test command${withCoverage ? ", coverage" : ""}): ${describeLlmModelConfig(config)}`)
    // specs/137 — the step is the request; the full request is background.
    const { step, context } = splitPlanStepText(text)
    const params = await runTestCommandHarness({
      model, mcpClient, taskId, projectRoot: projectPath,
      detectedSignal: describeDetection(detection),
      withCoverage,
      requestText: step,
      context,
    })
    if (!params) {
      tasks.set(taskId, { id: taskId, status: "failed", error: "The model could not propose a valid test command for this project" })
      return
    }
    proposeRunCommandAction(taskId, projectPath, params.argv, "run-tests", withCoverage)
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `LLM harness run failed: ${errorMessage(err)}` })
  }
}

// ============================================================
// specs/081-testing-write-tests-skill/spec.md — write-tests
// ============================================================

// Deliberately narrow: this is parsing, not a general path extractor —
// extractExplicitTargetPath()/resolveTargetPath() already own resolving
// the whole PROJECT root; this owns only the specific SOURCE FILE named
// after the same trigger words detectSkill() itself checks for.
// Requires a real extension (a dot) so ordinary prose after "for" isn't
// mistaken for a path.
function extractSourceFileToken(text: string): string | null {
  const match = text.match(/\bfor\s+([^\s]+\.\w+)/i)
  return match?.[1] ?? null
}

// specs/081 §4 — 100% deterministic given (source path, detected
// runner); the model never chooses where to write. JS/TS profiles use
// this repository's own "<name>.test.<ext>" convention; pytest uses the
// common "test_<name>.py" convention its own default discovery expects.
function deriveTestFilePath(sourceRelativePath: string, runner: RunnerProfile): string {
  const dir = path.dirname(sourceRelativePath)
  if (runner === "pytest") {
    const base = path.basename(sourceRelativePath, path.extname(sourceRelativePath))
    return path.join(dir, `test_${base}.py`)
  }
  const ext = path.extname(sourceRelativePath)
  const base = path.basename(sourceRelativePath, ext)
  return path.join(dir, `${base}.test${ext}`)
}

// specs/056's own preflightWrite() shape, reused here for the new test
// file's own target (not the source file, which is only ever read).
async function preflightTestFile(projectRoot: string, relativePath: string, newContent: string, taskId: string) {
  try {
    const content = await mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path: relativePath }, taskId)
    return classifyWritePreflight(newContent, { ok: true, content })
  } catch (err) {
    return classifyWritePreflight(newContent, { ok: false, message: errorMessage(err) })
  }
}

async function handleWriteTestsSkill(taskId: string, text: string): Promise<void> {
  const sourceToken = extractSourceFileToken(text)
  if (!sourceToken) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: 'No source file named — expected e.g. "write tests for src/foo.ts". write-tests never guesses which file needs tests.',
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

  const sourceAbs = path.isAbsolute(sourceToken) ? sourceToken : path.join(projectRoot, sourceToken)
  const sourceRelativePath = path.relative(projectRoot, sourceAbs)
  if (sourceRelativePath.startsWith("..") || path.isAbsolute(sourceRelativePath)) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `Source file "${sourceToken}" is outside the project root "${projectRoot}"` })
    return
  }

  const detection = await detectRunner(projectRoot)
  if (detection.kind === "unsupported") {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: `No known test-runner profile detected for "${projectRoot}" — write-tests needs a real, known framework to write syntactically correct tests in.`,
    })
    return
  }
  if (detection.kind === "ambiguous") {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: `Ambiguous — more than one test runner is plausible for "${projectRoot}": ${detection.candidates.join(", ")}. Resubmit naming which one to use.`,
    })
    return
  }
  const runner: RunnerProfile = detection.runner

  if (!isHarnessFlagSet()) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "write-tests requires ORCHESTRAI_TESTING_LLM_HARNESS=1 — there is no deterministic fallback for authoring test code.",
    })
    return
  }
  const config = readLlmHarnessConfig()
  if (!config) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "ORCHESTRAI_TESTING_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — failing closed rather than guessing test content.",
    })
    return
  }

  let sourceContent: string
  try {
    sourceContent = await mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path: sourceRelativePath }, taskId)
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `Cannot read source file "${sourceRelativePath}": ${errorMessage(err)}` })
    return
  }

  const testRelativePath = deriveTestFilePath(sourceRelativePath, runner)

  let content: string
  try {
    const model = await buildChatModel(config)
    console.log(`[testing-agent] llm harness (write-tests): ${describeLlmModelConfig(config)}`)
    const result = await runWriteTestsHarness({
      model, mcpClient, taskId, projectRoot,
      sourceRelativePath, sourceContent, runnerLabel: runner, testRelativePath,
    })
    if (!result) throw new Error("LLM harness failed to produce grounded test content")
    content = result
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `LLM harness run failed: ${errorMessage(err)}` })
    return
  }

  const preflight = await preflightTestFile(projectRoot, testRelativePath, content, taskId)
  if (preflight.kind === "blocked") {
    tasks.set(taskId, { id: taskId, status: "failed", error: `Cannot safely check "${testRelativePath}" before writing: ${preflight.reason}` })
    return
  }
  if (preflight.kind === "no-op") {
    tasks.set(taskId, {
      id: taskId, status: "completed",
      result: `Already up to date — "${testRelativePath}" already matches what would be written. No write performed.`,
    })
    return
  }

  const fingerprint = computeContentFingerprint(preflight.previousContent)
  const action: WriteTestsAction = {
    actionId: newActionId(),
    source: "write-tests",
    projectRoot,
    relativePath: testRelativePath,
    sourceRelativePath,
    content,
    previousContent: preflight.previousContent,
    fingerprint,
  }
  pendingActions.set(taskId, action)
  // specs/110-approval-state-survives-a-restart/spec.md B2 — a
  // fingerprinted write, the same restart-safe treatment DevOps's own
  // write skills and Coder's edit-file already get.
  persistPendingAction({ agent: "testing-agent", taskId, actionId: action.actionId, kind: "write", skill: "write-tests", payload: action })
  tasks.set(taskId, {
    id: taskId, status: "input-required",
    requiresApproval: true,
    step: `waiting for human approval — will write: ${testRelativePath}`,
    approval: buildApprovalPreview(action),
  })
}

// ============================================================
// TASK PROCESSOR
// ============================================================
// run-tests / check-coverage are Tier 1 whenever a process will actually
// execute: a no-runner result may still complete autonomously because no
// command runs. See specs/006-runtime-stabilization/spec.md Decision 1.
async function processTask(task: ValidatedTask): Promise<void> {
  const text  = task.text
  // specs/030 — an authoritative selection wins outright; absent selection
  // falls back to the existing detector, unchanged.
  const skill = task.selectedSkill ?? detectSkill(text)
  taskMeta.set(task.id, { skill, createdAt: Date.now() })

  tasks.set(task.id, { id: task.id, status: "working", step: `Skill detected: ${skill}` })

  // specs/081-testing-write-tests-skill/spec.md — a genuinely separate
  // flow (file content, not a runner dispatch), handled entirely on its
  // own before the run-tests/check-coverage-only branch below.
  if (skill === "write-tests") {
    await handleWriteTestsSkill(task.id, text)
    return
  }

  if (skill !== "run-tests" && skill !== "check-coverage") {
    tasks.set(task.id, { id: task.id, status: "completed", result: `Skill "${skill}" not implemented yet` })
    return
  }

  try {
    const projectPath = resolveTargetPath(text)
    if (!existsSync(projectPath)) throw new Error(`Path not found: ${projectPath}`)

    // specs/138 — detection is a hint for the model's proposal, never a
    // fixed command any more (specs/058's detectRunner() itself unchanged).
    const detection = await detectRunner(projectPath)
    await proposeTestCommand(task.id, text, projectPath, detection, skill === "check-coverage")
  } catch (err) {
    tasks.set(task.id, { id: task.id, status: "failed", error: errorMessage(err) })
  }
}

async function resumeTask(id: string): Promise<void> {
  const action = pendingActions.get(id)
  pendingActions.delete(id)
  // specs/110-approval-state-survives-a-restart/spec.md B0/B2/B5 — the
  // real single-consumption boundary once persistence is enabled; a
  // store miss/no-store both return true (nothing to claim), preserving
  // the in-memory Map as the sole boundary exactly as before this spec.
  const claimed = claimPendingAction({ agent: "testing-agent", taskId: id })
  tasks.set(id, { id, status: "working", step: "approved — executing" })

  if (!action || !claimed) {
    forgetPendingAction({ agent: "testing-agent", taskId: id })
    tasks.set(id, { id, status: "failed", error: "Approved action parameters are missing" })
    return
  }

  try {
    // specs/081-testing-write-tests-skill/spec.md §7 — the fingerprint
    // drift recheck, the same guarantee specs/056 already gives DevOps's
    // writes: re-read the target immediately before writing and refuse
    // if it changed since the preview was shown. "Path not found" here
    // means the target went from absent (a create) to still-absent —
    // expected, not drift; anything else is genuine drift.
    if (action.source === "write-tests") {
      let currentContent: string | undefined
      try {
        currentContent = await mcpClient.callTool("read_project_file", { project_root: action.projectRoot, relative_path: action.relativePath }, id)
      } catch (err) {
        const message = errorMessage(err)
        if (!message.startsWith(PATH_NOT_FOUND_PREFIX)) {
          tasks.set(id, { id, status: "failed", error: `Target changed after approval — cannot re-verify: ${message}. Resubmit for a fresh preflight.` })
          return
        }
      }
      const currentFingerprint = computeContentFingerprint(currentContent)
      if (currentFingerprint !== action.fingerprint) {
        tasks.set(id, {
          id, status: "failed",
          error: `Target "${action.relativePath}" changed after approval but before this write — refusing to overwrite unreviewed content. Resubmit for a fresh preflight.`,
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
        result: `Test file written: ${action.relativePath} (tests ${action.sourceRelativePath})\n\nApproving this write did NOT run it — dispatch run-tests separately to execute it.\n\n${action.content}`,
      })
      return
    }

    // specs/138 — every command (model-proposed "run-tests" or explicit
    // "run-command") executes via run_command: argv only, no shell, the
    // sanitized environment, timeout and output cap, cwd containment.
    // A test command that RAN and exited non-zero (failing tests) is a
    // completed run that reports its failures — run_command returns its
    // full output plus "[exit code N]" (specs/138). Only a refusal, a
    // missing executable or a timeout means the tests could not run.
    let rawOutput: string
    let exitedNonZero = false
    try {
      rawOutput = await mcpClient.callTool(
        "run_command",
        { argv: action.argv, cwd: action.cwd, project_root: action.cwd },
        id,
        MCP_CALL_TIMEOUT_MS,
      )
    } catch (err) {
      const message = errorMessage(err)
      if (!/\[exit code \d+\]\s*$/.test(message)) throw err
      rawOutput = message
      exitedNonZero = true
    }
    const bounded = boundTaskResult(rawOutput)

    // A failing test suite is still a completed task — only a crashed
    // runner/unavailable MCP produces a "failed" task (callTool() throws).
    // Counts and coverage are best-effort: an unrecognized format reads as
    // "not recognized", never as a guessed number (specs/138).
    const counts = parseTestCounts(rawOutput)
    const coverage = action.withCoverage ? parseCoveragePercent(rawOutput) : null
    tasks.set(id, {
      id,
      status: "completed",
      result: [
        `=== Test Results ===`,
        `Project: ${action.cwd}`,
        `Command: ${action.argv.join(" ")}`,
        ...(exitedNonZero ? [`Exit: non-zero — the run failed (see the output below)`] : []),
        ``,
        ...(action.withCoverage ? [coverage !== null ? `Coverage: ${coverage}%` : `Coverage: not recognized in the output`] : []),
        ...(counts ? [`Passed: ${counts.passed}`, `Failed: ${counts.failed}`] : [`Counts: not recognized in the output — see the raw output below`]),
        ``,
        bounded.text || "(no output)",
      ].join("\n"),
    })
  } catch (err) {
    tasks.set(id, { id, status: "failed", error: `Test runner failed: ${errorMessage(err)}` })
  } finally {
    // specs/110-approval-state-survives-a-restart/spec.md — once claimed,
    // the persisted row must never outlive this attempt, regardless of
    // outcome.
    forgetPendingAction({ agent: "testing-agent", taskId: id })
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
  forgetPendingAction({ agent: "testing-agent", taskId: id })
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
  <title>OrchestrAI — Testing Agent</title>
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
    .toast{position:fixed;bottom:1.5rem;right:1.5rem;padding:10px 16px;border-radius:6px;font-size:13px;display:none;z-index:999}
    .overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:center;justify-content:center}
    .modal{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.5rem;max-width:680px;width:90%;max-height:80vh;overflow-y:auto}
    .modal h3{color:#58a6ff;margin-bottom:1rem;font-size:14px}
    .modal pre{background:#0d1117;padding:1rem;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;line-height:1.6}
  </style>
</head>
<body>
  <h1>OrchestrAI — Testing Agent</h1>
  <p class="sub">Port 3003 &nbsp;·&nbsp; Auto-refreshes every 3s &nbsp;·&nbsp; Running tests now requires approval</p>

  <div class="stats">
    <div class="stat"><div class="stat-n">${all.length}</div><div class="stat-l">Total</div></div>
    <div class="stat"><div class="stat-n" style="color:#3fb950">${completed}</div><div class="stat-l">Completed</div></div>
    <div class="stat"><div class="stat-n" style="color:#d29922">${pending}</div><div class="stat-l">Pending Approval</div></div>
    <div class="stat"><div class="stat-n" style="color:#f85149">${failed}</div><div class="stat-l">Failed</div></div>
  </div>

  <div class="card">
    <div class="card-title">Send Task</div>
    <div class="quick">
      <button class="qbtn" onclick="q('run tests for my project')">Run Tests</button>
      <button class="qbtn" onclick="q('check test coverage')">Check Coverage</button>
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

    async function viewApproval(id) {
      const r = await fetch('/tasks/' + id)
      const d = await r.json()
      document.getElementById('modal-title').textContent = 'Approval preview — ' + id
      document.getElementById('modal-body').textContent = JSON.stringify(d.approval, null, 2)
      document.getElementById('overlay').style.display = 'flex'
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
// packages/agents/testing/index.ts` is unaffected — import.meta.main is
// still true for that exact invocation, same as before this change.
const PORT = resolveServicePort("testing")

// specs/110-approval-state-survives-a-restart/spec.md B2/B5/B6 — called
// once, before the HTTP server binds. A restored "command" (run-tests/
// run-command) action gets an added risk line naming that no drift
// recheck is possible; a restored "write" (write-tests) action needs no
// such addition — its existing fingerprint recheck in resumeTask()
// already covers it identically to a same-process approval.
function restoreApprovalsOnStartup(): void {
  const restored = restorePendingActions<PendingAction>({
    agent: "testing-agent",
    validate: (raw) => {
      const parsed = PersistedTestingActionSchema.safeParse(raw)
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
    const stepTarget = row.payload.source === "write-tests" ? row.payload.relativePath : row.payload.argv.join(" ")
    tasks.set(row.taskId, {
      id: row.taskId, status: "input-required",
      requiresApproval: true,
      step: `restored after restart — waiting for human approval — ${row.payload.source === "write-tests" ? "will write" : "will run"}: ${stepTarget}`,
      approval: preview,
    })
  }
  if (restored.length > 0) console.log(`[testing-agent] restored ${restored.length} pending approval(s) after restart`)
}

export function start() {
  mcpClient.start()
  restoreApprovalsOnStartup()
  const agentHttpServer = serve({ fetch: app.fetch, port: PORT })

  // specs/107-task-and-conversation-history/spec.md B4 — so a task
  // dispatched directly to this agent (A2A, TUI direct mode — never
  // routed through the Orchestrator) is still recorded.
  const stopTaskSweep = startTaskPersistenceSweep("testing-agent", tasks, (id) => taskMeta.get(id) ?? null)

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
  if (harnessStartup.warning) console.warn(`[testing-agent] WARNING: ${harnessStartup.warning}`)
  console.log(`
Testing Agent running
Dashboard → http://localhost:${PORT}/dashboard
Agent Card → http://localhost:${PORT}/.well-known/agent.json
LLM harness (run-command fallback + write-tests): ${harnessStartup.summary}
`)
}

if (import.meta.main) {
  start()
}
