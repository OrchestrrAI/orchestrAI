import { Hono } from "hono"
import { serve } from "bun"
import { resolveTargetPath } from "../../shared"
import { resolveServicePort } from "../../shared/service-ports"
import { parseTaskEnvelope, readJsonBody, validateSelectedSkillOwnership, type ValidatedTask } from "../../shared/task-envelope"
import { boundTaskResult, TASK_RESULT_MAX_BYTES, truncateUtf8, flushAuditBufferForShutdown } from "../../shared/audit"
import { OrchestraiMcpClient } from "../../shared/mcp-client"
import {
  buildChatModel,
  describeLlmModelConfig,
  isHarnessFlagSet,
  readLlmHarnessConfig,
  readLlmHarnessStartupState,
} from "./model-factory"
import { runReviewDiffHarness, type ReviewComment } from "./llm-harness"
import { parseUnifiedDiff } from "./diff-grounding"
import { startTaskPersistenceSweep } from "../../shared/store"
import { getCachedProjectAnalysis, renderCodebaseAnalysis, runProjectAnalysisHarness, setCachedProjectAnalysis } from "../../shared/project-analysis"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"

// ============================================================
// TYPES
// ============================================================
type TaskStatus = "submitted" | "working" | "completed" | "failed"

interface TaskResult {
  id: string
  status: TaskStatus
  result?: string
  error?: string
  step?: string
  // specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part A —
  // the same comments already in `result`'s rendered text, as a
  // machine-readable artifact alongside it, so a consumer other than a
  // human reader (GET /tasks/:id already returns this whole object as
  // JSON) never has to re-parse the prose. ReviewDiffResultSchema was
  // already exactly this shape (specs/082) — this exposes it, not a new
  // schema.
  findings?: ReviewComment[]
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
  name: "code-review-agent",
  description: "Reviews a project's uncommitted git diff for real issues, grounded strictly in the actual changed lines",
  url: `http://localhost:${resolveServicePort("codeReview")}`,
  version: "1.0.0",
  skills: [
    {
      id: "review-diff",
      name: "Review Diff",
      description: "Review staged and unstaged changes in a project for correctness issues, grounded in real file:line citations from the diff",
      examples: ["review the diff at C:\\path\\to\\project", "review my changes", "code review this project"],
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

// specs/107-task-and-conversation-history/spec.md B4 — Code Review's own
// TaskResult carries no skill/createdAt, so a small side map records
// both at the one place processTask() already computes them (its own
// selectedSkill-or-detectSkill() line), rather than threading two new
// fields through every existing tasks.set() call site in this file.
const taskMeta = new Map<string, { skill: string; createdAt: number }>()

const mcpClient = new OrchestraiMcpClient({
  callerName: "code-review-agent",
  // specs/101-per-agent-tool-access-expansion/spec.md — analyze_project/
  // git_status added alongside the pre-existing git_diff/read_project_file:
  // the uniform general-inspection set every code-reasoning agent now
  // gets. Only analyze_project/git_status are additionally bound as
  // harness tools (llm-harness.ts) — git_diff is deliberately NOT
  // re-bound there, since its combined diff already reaches the model
  // as prompt context, and re-binding it would just invite a redundant
  // call for something the model already has.
  requiredTools: ["git_diff", "read_project_file", "analyze_project", "git_status"],
})

// specs/082-code-review-agent/spec.md §1 — one skill only, so there is
// no ordering hazard to resolve against a sibling skill the way
// specs/079/080/081 each had to for their own new skills within an
// already-multi-skill agent. Used only when a task arrives with no
// selectedSkill (e.g. a direct-to-agent submission bypassing the
// Orchestrator's own live LLM router, specs/065).
function detectSkill(text: string): string {
  const lower = text.toLowerCase()
  if ((lower.includes("review") && (lower.includes("diff") || lower.includes("change") || lower.includes("code"))) || lower.includes("code review"))
    return "review-diff"
  return "unknown"
}

// ============================================================
// review-diff
// ============================================================
// specs/079-phase-a-connect-orphaned-tools/spec.md §4's own
// computeFullUncommittedDiff() shape, reused here as an independent
// local copy (that function is private to DevOps's own module) —
// staged + unstaged combined, the confirmed design choice for this
// spec (matches "everything not yet committed", the more literal
// reading of "review my changes" for an agent that never commits
// anything itself).
async function computeFullUncommittedDiff(base: string, taskId: string): Promise<string> {
  const [staged, unstaged] = await Promise.all([
    mcpClient.callTool("git_diff", { repo_path: base, staged: true }, taskId),
    mcpClient.callTool("git_diff", { repo_path: base, staged: false }, taskId),
  ])
  const parts: string[] = []
  if (staged && staged.trim() !== "No changes found.") parts.push(`=== Already staged ===\n${staged}`)
  if (unstaged && unstaged.trim() !== "No changes found.") parts.push(`=== Not yet staged ===\n${unstaged}`)
  return parts.join("\n\n")
}

function formatReviewResult(base: string, filesReviewed: number, comments: ReviewComment[], summary: string | undefined, omittedCount: number | undefined, truncated: boolean, codebaseAnalysisSection: string | null): string {
  const lines = [`=== Code Review ===`, `Path: ${base}`, `Files reviewed: ${filesReviewed}`, ``]
  if (comments.length === 0) {
    lines.push("No issues found.")
  } else {
    for (const c of comments) {
      lines.push(`[${c.file}:${c.line}] ${c.severity}`, `  ${c.comment}`, ``)
    }
  }
  if (summary) lines.push(`Summary: ${summary}`)
  if (omittedCount) lines.push(``, `(${omittedCount} comment(s) omitted for citing a location not present in the diff)`)
  if (truncated) lines.push(``, `[diff truncated at ${TASK_RESULT_MAX_BYTES} bytes]`)
  // specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part A —
  // appended after the review itself, mirroring DevOps's own
  // analyze-project precedent (specs/103/105) exactly.
  if (codebaseAnalysisSection) lines.push(``, codebaseAnalysisSection)
  return lines.join("\n")
}

// specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part A —
// additive, fail-open, reusing the ONE shared implementation
// (packages/shared/project-analysis.ts) DevOps's analyze-project and
// the Orchestrator already both import — never re-implemented here.
// review-diff already requires the harness to be on at all (no
// deterministic fallback for this skill), so this is attempted
// whenever review-diff proceeds — there is no separate flag to check.
// A harness failure of any kind appends an explicit unavailable note
// and the review still completes on the diff alone, exactly as that
// module's own established fail-open behavior guarantees.
async function computeCodebaseAnalysisSection(model: BaseChatModel, base: string, taskId: string): Promise<string | null> {
  const cached = await getCachedProjectAnalysis(base, mcpClient, taskId)
  if (cached) return renderCodebaseAnalysis(cached)

  try {
    const deterministicReport = await mcpClient.callTool("analyze_project", { project_path: base }, taskId)
    const result = await runProjectAnalysisHarness({ model, mcpClient, taskId, projectRoot: base, deterministicReport })
    if (!result) {
      return "=== Codebase Analysis ===\nCodebase analysis unavailable: no observation survived grounding against the real project."
    }
    // No cheap fresh git_status already in hand on this path — null
    // falls back to TTL-only validity, exactly as
    // setCachedProjectAnalysis() documents (matching DevOps's own
    // analyze-project call site precedent).
    setCachedProjectAnalysis(base, result, null, "code-review-agent")
    return renderCodebaseAnalysis(result)
  } catch (err) {
    return `=== Codebase Analysis ===\nCodebase analysis unavailable: ${errorMessage(err)}`
  }
}

async function handleReviewDiffSkill(taskId: string, text: string): Promise<void> {
  let base: string
  try {
    base = resolveTargetPath(text)
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: errorMessage(err) })
    return
  }
  // No local existsSync() check here, deliberately — this agent has no
  // filesystem access of its own (specs/082's own design: a pure MCP
  // client, no volume mount, matching DevOps's own no-mount pattern).
  // A local check here assumed the agent process shares a filesystem
  // with the target, which is only true bare-metal; found live and
  // fixed 2026-09-14 during docker-compose verification, where this
  // agent's own container genuinely has no /target mount but mcp-http's
  // does — the real existsSync() check that matters already lives
  // server-side in git_diff (packages/mcp/index.ts), the same pattern
  // DevOps's own equivalent skills already rely on with no local
  // pre-check of their own.

  let combinedDiff: string
  try {
    combinedDiff = await computeFullUncommittedDiff(base, taskId)
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: errorMessage(err) })
    return
  }

  // specs/082 §2 step 4 — a distinct, harmless empty-input case, not
  // "no deterministic fallback": there is genuinely nothing to review.
  // No LLM call, independent of the harness flag entirely.
  if (!combinedDiff) {
    tasks.set(taskId, { id: taskId, status: "completed", result: "Nothing to review — no staged or unstaged changes." })
    return
  }

  // specs/082 §3 — the diff handed to both the parser and the model is
  // truncated identically, so the grounding validator can never accept
  // a citation from content the model never actually saw.
  const bounded = boundTaskResult(combinedDiff)
  const diffText = bounded.text
  const truncated = bounded.truncated

  const parsed = parseUnifiedDiff(diffText)
  if (parsed.touchedFiles.length === 0) {
    // Defensive only — should be unreachable given the non-empty-diff
    // check above, but never proceed with an empty grounding set.
    tasks.set(taskId, { id: taskId, status: "failed", error: "Could not parse any touched files from the diff — refusing to review ungrounded." })
    return
  }

  if (!isHarnessFlagSet()) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "review-diff requires ORCHESTRAI_CODE_REVIEW_LLM_HARNESS=1 — there is no deterministic fallback for this skill (a code review has no meaningful non-LLM answer).",
    })
    return
  }
  const config = readLlmHarnessConfig()
  if (!config) {
    tasks.set(taskId, {
      id: taskId, status: "failed",
      error: "ORCHESTRAI_CODE_REVIEW_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing — failing closed rather than guessing a review.",
    })
    return
  }

  try {
    const model = await buildChatModel(config)
    console.log(`[code-review-agent] llm harness (review-diff): ${describeLlmModelConfig(config)}`)
    // specs/119 Part A — computed before the review itself so a genuine
    // success can be fed into the review's own system prompt as real
    // grounding context, not just appended afterward.
    const codebaseAnalysisSection = await computeCodebaseAnalysisSection(model, base, taskId)
    const codebaseContext = codebaseAnalysisSection?.startsWith("=== Codebase Analysis ===\nCodebase analysis unavailable")
      ? undefined
      : codebaseAnalysisSection ?? undefined
    const result = await runReviewDiffHarness({ model, mcpClient, taskId, projectRoot: base, diffText, parsed, codebaseContext })
    if (!result) {
      tasks.set(taskId, { id: taskId, status: "failed", error: "the model's response could not be validated after retries (grounding check failed)." })
      return
    }
    tasks.set(taskId, {
      id: taskId, status: "completed",
      result: formatReviewResult(base, parsed.touchedFiles.length, result.comments, result.summary, result.omittedCount, truncated, codebaseAnalysisSection),
      findings: result.comments,
    })
  } catch (err) {
    tasks.set(taskId, { id: taskId, status: "failed", error: `LLM harness run failed: ${errorMessage(err)}` })
  }
}

// ============================================================
// TASK PROCESSOR
// ============================================================
// Read-only, no NEEDS_APPROVAL, no resumeTask — this agent never writes
// to disk, so no task ever reaches input-required.
async function processTask(task: ValidatedTask): Promise<void> {
  const text = task.text
  // specs/030 — an authoritative selection wins outright; absent
  // selection falls back to the existing detector, unchanged.
  const skill = task.selectedSkill ?? detectSkill(text)
  taskMeta.set(task.id, { skill, createdAt: Date.now() })

  tasks.set(task.id, { id: task.id, status: "working", step: `Skill detected: ${skill}` })

  if (skill !== "review-diff") {
    tasks.set(task.id, { id: task.id, status: "completed", result: `Skill "${skill}" not implemented yet` })
    return
  }

  await handleReviewDiffSkill(task.id, text)
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
          if (["completed", "failed"].includes(t.status)) break
          await Bun.sleep(500)
        }
        controller.close()
      }
    }),
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
  )
})

// ============================================================
// DASHBOARD — no Approve/Reject anywhere; every task either
// completes or fails on its own, no human-in-the-loop gate exists.
// ============================================================
app.get("/dashboard", (c) => {
  const all = Array.from(tasks.values()).reverse()

  const statusColor: Record<string, string> = {
    submitted: "#9ca3af",
    working:   "#58a6ff",
    completed: "#3fb950",
    failed:    "#f85149",
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
            ${t.status === "completed" ? `
              <button class="btn gray" onclick="viewResult('${t.id}')">View Result</button>
            ` : t.status === "failed" ? `
              <button class="btn gray" onclick="viewError('${t.id}')">View Error</button>
            ` : "-"}
          </td>
        </tr>
      `).join("")

  const completed = all.filter(t => t.status === "completed").length
  const failed    = all.filter(t => t.status === "failed").length

  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>OrchestrAI — Code Review Agent</title>
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
    .toast{position:fixed;bottom:1.5rem;right:1.5rem;padding:10px 16px;border-radius:6px;font-size:13px;display:none;z-index:999}
    .overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:center;justify-content:center}
    .modal{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.5rem;max-width:680px;width:90%;max-height:80vh;overflow-y:auto}
    .modal h3{color:#58a6ff;margin-bottom:1rem;font-size:14px}
    .modal pre{background:#0d1117;padding:1rem;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;line-height:1.6}
  </style>
</head>
<body>
  <h1>OrchestrAI — Code Review Agent</h1>
  <p class="sub">Port 3007 &nbsp;·&nbsp; Auto-refreshes every 3s &nbsp;·&nbsp; Read-only, no approval gate</p>

  <div class="stats">
    <div class="stat"><div class="stat-n">${all.length}</div><div class="stat-l">Total</div></div>
    <div class="stat"><div class="stat-n" style="color:#3fb950">${completed}</div><div class="stat-l">Completed</div></div>
    <div class="stat"><div class="stat-n" style="color:#f85149">${failed}</div><div class="stat-l">Failed</div></div>
  </div>

  <div class="card">
    <div class="card-title">Send Task</div>
    <div class="quick">
      <button class="qbtn" onclick="q('review my changes')">Review Diff</button>
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
const PORT = resolveServicePort("codeReview")

export function start() {
  mcpClient.start()
  const agentHttpServer = serve({ fetch: app.fetch, port: PORT })

  // specs/107-task-and-conversation-history/spec.md B4 — so a task
  // dispatched directly to this agent (A2A, TUI direct mode — never
  // routed through the Orchestrator) is still recorded.
  const stopTaskSweep = startTaskPersistenceSweep("code-review-agent", tasks, (id) => taskMeta.get(id) ?? null)

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
  if (harnessStartup.warning) console.warn(`[code-review-agent] WARNING: ${harnessStartup.warning}`)
  console.log(`
Code Review Agent running
Dashboard → http://localhost:${PORT}/dashboard
Agent Card → http://localhost:${PORT}/.well-known/agent.json
LLM harness: ${harnessStartup.summary}
`)
}

if (import.meta.main) {
  start()
}
