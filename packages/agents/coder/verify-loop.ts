// specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part B
//
// The edit-and-verify loop's own decision core, kept separate from
// index.ts's thin HTTP/pendingActions layer so it can be driven
// hermetically with an injected model + mcpClient — mirroring how every
// llm-harness.ts in this codebase already takes both as parameters
// rather than reading a module-level singleton. index.ts calls these
// functions with the real mcpClient/model at each resume point; nothing
// here talks to Hono, pendingActions, or the approval store directly.
//
// The one genuinely new risk this file's own logic must get right (see
// the spec's "Resolved Decision — B1"): a verification command may be
// re-run without a fresh human approval ONLY when its argv is
// byte-identical to one already approved earlier in this same task.
// argvEqual()/hasApprovedArgv() below are that comparison, exact-array
// equality only — never normalized, lowercased, or fuzzy-matched.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { computeContentFingerprint } from "../../shared/approval"
import { PATH_NOT_FOUND_PREFIX } from "../../shared/write-preflight"
import { runEditFilesHarness, runVerifyCommandHarness, type GroundedFileChange } from "./llm-harness"

export interface McpToolCaller {
  callTool(toolName: string, args: Record<string, unknown>, taskId: string, timeoutMs?: number): Promise<string>
}

// specs/119's own "Iteration bound" section — a single named constant,
// never model judgment, bounding both edit attempts and provider cost.
export const MAX_VERIFY_ITERATIONS = 3

// Mirrors packages/agents/testing/index.ts's own MCP_CALL_TIMEOUT_MS —
// the same run_command server-side budget (packages/mcp/index.ts's
// RUN_COMMAND_TIMEOUT_MS, 120s) plus a buffer for MCP round-trip
// overhead, kept as an independent per-agent copy per this codebase's
// convention rather than importing Testing's own constant.
export const VERIFY_COMMAND_TIMEOUT_MS = 135_000

// ============================================================
// B1 — exact-argv-equality comparison
// ============================================================
/** Exact, ordered array equality — never normalized, lowercased, or
 *  "equivalent"-matched. A single-character difference anywhere in the
 *  argv is a genuinely different command per specs/119's own Resolved
 *  Decision, and must force a fresh approval. */
export function argvEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, i) => token === b[i])
}

/** True only if `candidate` is byte-identical to an argv a human already
 *  approved earlier IN THIS SAME TASK (`approved` never crosses a task
 *  boundary — index.ts never persists it anywhere but on the task's own
 *  pending-action payload, so it cannot outlive the task or survive a
 *  restart into a different task). */
export function hasApprovedArgv(approved: readonly (readonly string[])[], candidate: readonly string[]): boolean {
  return approved.some((a) => argvEqual(a, candidate))
}

// ============================================================
// FIX INSTRUCTION — feeding a real failure back to the proposal harness
// ============================================================
/** Builds the instruction text handed to runEditFilesHarness() for a
 *  follow-up fix — the "no new proposal path" clause in specs/119 Part B
 *  step 1 is satisfied exactly by reusing that same harness for both the
 *  initial edit and every fix, differing only in instruction text. */
export function buildFixInstruction(originalInstruction: string, failedArgv: readonly string[], output: string): string {
  return [
    `The previous edit did not pass verification — fix it.`,
    ``,
    `Original instruction: ${originalInstruction}`,
    ``,
    `Verification command that failed: ${failedArgv.join(" ")}`,
    `Its real output:`,
    `--- output ---`,
    output,
    `--- end of output ---`,
  ].join("\n")
}

// ============================================================
// PER-FILE DRIFT RECHECK AND WRITE
// ============================================================
// A deliberate, independent duplicate of index.ts's own
// resumeEditFilesAction() drift-check-then-write shape (specs/114) —
// edit-files itself stays byte-unchanged; this is edit-and-verify's own
// copy, per this codebase's established per-skill-copy convention.
export interface VerifyFileEntry {
  path: string
  action: "edit" | "create"
  content: string
  previousContent?: string
  fingerprint: string
}

export interface DriftCheckResult {
  ok: boolean
  driftedPath?: string
  /** Set only when the drift check itself could not complete (a real
   *  MCP/read error distinct from PATH_NOT_FOUND) — index.ts surfaces
   *  this with a different message than an ordinary drift refusal. */
  readError?: string
}

/** All-or-nothing: every file's real current fingerprint is re-verified
 *  BEFORE any file in the batch is written — a single drifted file
 *  refuses the entire batch, the same "no partial write on drift"
 *  guarantee specs/056/114 already established. */
export async function checkDrift(
  mcpClient: McpToolCaller,
  taskId: string,
  projectRoot: string,
  files: readonly VerifyFileEntry[],
): Promise<DriftCheckResult> {
  for (const file of files) {
    let currentContent: string | undefined
    try {
      currentContent = await mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path: file.path }, taskId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!message.startsWith(PATH_NOT_FOUND_PREFIX)) {
        return { ok: false, driftedPath: file.path, readError: message }
      }
    }
    const currentFingerprint = computeContentFingerprint(currentContent)
    if (currentFingerprint !== file.fingerprint) {
      return { ok: false, driftedPath: file.path }
    }
  }
  return { ok: true }
}

export interface WriteFilesResult {
  written: string[]
  failed: { path: string; error: string }[]
}

/** Best-effort per-file execution, exactly mirroring index.ts's own
 *  resumeEditFilesAction() — no cross-file atomic transaction exists at
 *  the write_project_file layer, a real, disclosed limitation that spec
 *  does not solve and this one doesn't either. Call only after
 *  checkDrift() has already returned ok:true for the whole batch. */
export async function writeFiles(
  mcpClient: McpToolCaller,
  taskId: string,
  projectRoot: string,
  files: readonly VerifyFileEntry[],
): Promise<WriteFilesResult> {
  const written: string[] = []
  const failed: { path: string; error: string }[] = []
  for (const file of files) {
    try {
      await mcpClient.callTool(
        "write_project_file",
        { project_root: projectRoot, relative_path: file.path, content: file.content, overwrite: true },
        taskId,
      )
      written.push(file.path)
    } catch (err) {
      failed.push({ path: file.path, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { written, failed }
}

// ============================================================
// PER-ITERATION RECORD AND FINAL REPORT
// ============================================================
export interface VerifyIterationRecord {
  iteration: number
  filesWritten: string[]
  commandArgv: string[]
  commandOutput: string
  commandSucceeded: boolean
}

/** Deterministic rendering — the model never writes this final text
 *  directly, only the individual pieces (edits, the real command
 *  output) that go into it. */
export function renderFinalReport(originalInstruction: string, history: readonly VerifyIterationRecord[], converged: boolean): string {
  const lines = [`=== Edit-and-Verify ===`, `Instruction: ${originalInstruction}`, ``]
  for (const rec of history) {
    lines.push(`--- Iteration ${rec.iteration} ---`)
    lines.push(`Files written: ${rec.filesWritten.join(", ") || "(none)"}`)
    lines.push(`Verification command: ${rec.commandArgv.join(" ")}`)
    lines.push(`Result: ${rec.commandSucceeded ? "PASSED" : "FAILED"}`)
    lines.push(rec.commandOutput || "(no output)")
    lines.push(``)
  }
  lines.push(
    converged
      ? `Verification passed after ${history.length} iteration(s).`
      : `Did not converge within ${MAX_VERIFY_ITERATIONS} iteration(s) — verification still fails. See the per-iteration output above for what was actually tried.`,
  )
  return lines.join("\n")
}

// ============================================================
// THE LOOP-ADVANCE CORE
// ============================================================
export interface VerificationContext {
  taskId: string
  projectRoot: string
  originalInstruction: string
  iteration: number
  approvedArgvs: string[][]
  history: VerifyIterationRecord[]
  argv: string[]
  filesWrittenThisIteration: string[]
  /** specs/139 D — the plan background (specs/137), when this task is a
   *  plan step; every fix proposal gets it as `context`. */
  planContext?: string
}

export type VerificationAdvanceResult =
  | { kind: "completed"; result: string }
  | {
      kind: "next-edit"
      files: GroundedFileChange[]
      dropped: { path: string; reason: string }[]
      iteration: number
      approvedArgvs: string[][]
      history: VerifyIterationRecord[]
    }
  | { kind: "failed"; error: string }

/** Runs the (already-approved-or-B1-reused) verification command and
 *  decides what happens next: a real success completes the task; a real
 *  failure either exhausts the bound (completes with an honest report,
 *  per specs/119's own Proposed Behavior step 7 — never a silent stop,
 *  never a "failed" task for a bounded, reported non-convergence) or
 *  proposes a follow-up fix by reusing runEditFilesHarness() verbatim
 *  with an augmented instruction (specs/119 Part B step 1's own "no new
 *  proposal path" clause).
 *
 *  run_command's own isError:true (a nonzero exit OR a genuine spawn
 *  failure — the MCP tool does not distinguish, and neither did
 *  Testing's own precedent in packages/agents/testing/index.ts's
 *  "run-command" resume branch) surfaces here as a thrown Error whose
 *  message is the real stdout+stderr text. This function treats every
 *  such throw uniformly as "verification failed" — a real, disclosed
 *  limitation: a command that cannot even be invoked is indistinguishable
 *  from one that ran and failed, and both trigger an otherwise-unneeded
 *  fix iteration. Bounded and honestly reported either way, never unsafe. */
export async function runVerificationAndAdvance(
  mcpClient: McpToolCaller,
  model: BaseChatModel,
  ctx: VerificationContext,
): Promise<VerificationAdvanceResult> {
  const approvedArgvs = hasApprovedArgv(ctx.approvedArgvs, ctx.argv) ? ctx.approvedArgvs : [...ctx.approvedArgvs, ctx.argv]

  let output: string
  let succeeded: boolean
  try {
    output = await mcpClient.callTool(
      "run_command",
      { argv: ctx.argv, cwd: ctx.projectRoot, project_root: ctx.projectRoot },
      ctx.taskId,
      VERIFY_COMMAND_TIMEOUT_MS,
    )
    succeeded = true
  } catch (err) {
    output = err instanceof Error ? err.message : String(err)
    succeeded = false
  }

  const record: VerifyIterationRecord = {
    iteration: ctx.iteration,
    filesWritten: ctx.filesWrittenThisIteration,
    commandArgv: ctx.argv,
    commandOutput: output,
    commandSucceeded: succeeded,
  }
  const newHistory = [...ctx.history, record]

  if (succeeded) {
    return { kind: "completed", result: renderFinalReport(ctx.originalInstruction, newHistory, true) }
  }

  if (ctx.iteration >= MAX_VERIFY_ITERATIONS) {
    return { kind: "completed", result: renderFinalReport(ctx.originalInstruction, newHistory, false) }
  }

  const fixInstruction = buildFixInstruction(ctx.originalInstruction, ctx.argv, output)
  let fixResult: Awaited<ReturnType<typeof runEditFilesHarness>>
  try {
    fixResult = await runEditFilesHarness({ model, mcpClient, taskId: ctx.taskId, projectRoot: ctx.projectRoot, instruction: fixInstruction, context: ctx.planContext })
  } catch (err) {
    return { kind: "failed", error: `LLM harness run failed while proposing a fix: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (!fixResult) {
    return { kind: "failed", error: "the model's response could not be validated after retries — no fix could be grounded for the failing verification." }
  }
  if ("refused" in fixResult) {
    return { kind: "failed", error: `Cannot fix the verification failure: ${fixResult.reason}` }
  }

  return {
    kind: "next-edit",
    files: fixResult.files,
    dropped: fixResult.dropped,
    iteration: ctx.iteration + 1,
    approvedArgvs,
    history: newHistory,
  }
}

// ============================================================
// VERIFICATION COMMAND PROPOSAL — thin wrapper over the harness so
// index.ts's own call sites read declaratively (iteration 1 has no
// prior failure; iteration 2+ always does, taken from the last history
// entry).
// ============================================================
export interface ProposeVerificationCommandOptions {
  model: BaseChatModel
  mcpClient: McpToolCaller
  taskId: string
  projectRoot: string
  originalInstruction: string
  history: readonly VerifyIterationRecord[]
}

export async function proposeVerificationCommand(options: ProposeVerificationCommandOptions) {
  const { model, mcpClient, taskId, projectRoot, originalInstruction, history } = options
  const last = history[history.length - 1]
  const priorFailure = last ? { argv: last.commandArgv, output: last.commandOutput } : undefined
  return runVerifyCommandHarness({ model, mcpClient, taskId, projectRoot, instruction: originalInstruction, priorFailure })
}
