/** @jsxImportSource @opentui/react */
// OrchestrAI — interactive terminal viewer (specs/010-tui-cli/spec.md +
// specs/012-tui-interactive/spec.md).
// specs/014-typecheck-ci/spec.md: the pragma above tells TypeScript to resolve
// JSX intrinsics (<box>, <text>, <scrollbox>, ...) against @opentui/react's
// own jsx-namespace.d.ts instead of plain react's, which has no idea what
// a <box> is. Scoped to this one file (the only file in the repo emitting
// JSX) rather than a global tsconfig.json change.
//
// Talks to the Orchestrator's existing HTTP endpoints only — the exact same
// ones the browser dashboard uses (POST /tasks, POST /tasks/:id/approve,
// POST /tasks/:id/reject) — PLUS, new in this pass, direct POST to an
// agent's own "/" task-submission endpoint when a task is explicitly
// targeted at one agent (bypassing Orchestrator routing on purpose, the
// same way a browser could hit an agent's own dashboard directly). No new
// server-side capability exists anywhere; this file is only ever a client
// of already-existing endpoints. Approve/reject never send a
// client-supplied actionId — the Orchestrator already stores and forwards
// its own, confirmed by re-reading apps/orchestrator/index.ts before
// writing this.
import { createCliRenderer, type ScrollBoxRenderable } from "@opentui/core"
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useState, type ReactNode } from "react"
import { useEffect, useRef } from "react"
import { reducePlanStepEvent, type PlanStepsByRun } from "../../packages/shared/tui-step-state"
import { skillFromStepName, progressPhraseForSkill, progressPhraseForTool } from "./chat-progress-phrases"
import type { ApprovalPreview } from "../../packages/shared/approval"
import { buildContentPreview, computeLineDiff } from "../../packages/shared/line-diff"
import {
  CONFIRM_WINDOW_MS,
  adjacentConversationId,
  clampRailCursor,
  moveRailCursor,
  railCursorForActive,
  resolveChatTurnDisplay,
  computeClampedAgentIndex,
  computeClampedTaskIndex,
  computeShellChatScrollHeight,
  computeShellLayout,
  computeShellRegionHeight,
  computeTaskWindow,
  computeVisibleTasks,
  countWaitingApprovals,
  formatPlanStepRows,
  type PlanStepLike,
  type BatchBranchLike,
  type BatchDecision,
  buildBatchDecisions,
  computeBatchListWindow,
  countWaitingPlanChildren,
  formatBatchBranchLine,
  resolveBatchParentId,
  summarizeBatchDecisions,
  auditRowMatchesTask,
  conversationStatusGlyph,
  formatBytes,
  formatClockTime,
  formatRelativeTime,
  formatTaskRowText,
  nextTaskStatusFilter,
  shortTaskId,
  formatHeaderStatus,
  fitAuditRow,
  type TaskStatusFilter,
  type PlanStepDisplayRow,
  chatTierLabel,
  hasTerminalAnswerForTask,
  isChatAtBottom,
  nextIndexOnArrowDown,
  nextIndexOnArrowUp,
  resolveConfirmPress,
  resolveKeyOwner,
  resolveModeKey,
  resolveOrchestratorUrl,
  type TuiMode,
  waitingTasksForConversation,
  findWaitingPlanChild,
} from "./tui-state"

// specs/099-tui-port-url-and-analyze-project-stack-awareness/spec.md —
// previously a hardcoded "http://localhost:3000" fallback, unaware of
// ORCHESTRAI_ORCHESTRATOR_PORT (specs/073). resolveOrchestratorUrl() is
// the pure, directly-testable extraction (tui-state.ts, no renderer
// dependency) of the same "<full-URL override> ??
// http://localhost:<resolveServicePort(...)>" shape
// packages/shared/agent-registry.ts already uses for every agent.
const ORCHESTRATOR_URL = resolveOrchestratorUrl(process.env)
const POLL_INTERVAL_MS = 1500
// CONFIRM_WINDOW_MS now lives in ./tui-state (imported above) so the pure
// resolveConfirmPress() helper and this component share one constant.
const STATUS_MESSAGE_MS = 2500

// specs/044-conversational-ask-layer — one turn in a conversation, as
// returned by GET /conversations/:id. The server's store is the only
// source of truth; this view never composes an answer of its own.
// specs/047-tui-conversation-operations-navigation/spec.md — Phase 1 adds
// `taskId`, already present on the server's real turn objects
// (apps/orchestrator/index.ts's ConversationTurn) and already arriving on
// the GET /conversations/:id response this file already polls; nothing
// reads it yet (Phase 4 wires the linked task card to it).
interface ChatTurn {
  id: string
  role: "user" | "assistant"
  text: string
  // specs/130 phase 4 — the server's ConversationTurn.timestamp (ms).
  timestamp?: number
  tier?: 0 | 1 | 2
  skill?: string
  taskId?: string
  // specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md — present
  // only when the server actually synthesized a paraphrase for a
  // "state"/"failure" answer; `text` always stays the full, unchanged
  // synthesized+raw value regardless. Never set for a "conversation"
  // intent turn, which has nothing separate to summarize.
  summary?: string
}

interface ConversationSummary {
  id: string
  createdAt?: string
  lastTurnAt?: string | null
  turnCount: number
  preview: string
  taskStatus?: string | null
}

interface AgentRow {
  name: string
  url: string
  status: "online" | "offline"
  skills: string[]
  // specs/130 phase 4 — GET /agents' lastSeen (an ISO string over JSON).
  lastSeen?: string
}

// specs/108-durable-audit-trail/spec.md B7 — shape matches the real
// GET /audit response (apps/orchestrator/index.ts), which itself mirrors
// packages/shared/store.ts's own AuditEventRow field-for-field.
interface AuditEventRow {
  id: number
  ts: number
  kind: string
  caller: string
  target: string
  taskId: string | null
  outcome: string
  durationMs: number
  resultBytes: number
  resultTruncated: number
}

// specs/115-tui-navigation-redraw-and-answer-clarity/spec.md — the same
// three-way MCP/A2A/EXEC distinction the dashboard's own KIND_LABEL map
// already gives `kind` (specs/113), applied here as a short colored
// prefix rather than a full badge column — this view's rows are already
// narrow. A kind outside this map (defensive — the real value is
// already constrained server-side) falls back to the raw string, never
// a blank cell.
const AUDIT_KIND_LABEL: Record<string, { text: string; fg: string }> = {
  "mcp-tool-call": { text: "MCP", fg: "#58a6ff" },
  "a2a-call": { text: "A2A", fg: "#3fb950" },
  "command-execution": { text: "EXEC", fg: "#d29922" },
}
function auditKindBadge(kind: string): { text: string; fg: string } {
  return AUDIT_KIND_LABEL[kind] ?? { text: kind, fg: "#6e7681" }
}

// Bounded the same way every other live-appended list in this file is —
// an idle-but-open Audit view can't accumulate unbounded DOM/state over
// a long session (matches specs/113's own AUDIT_ROW_LIMIT for the
// dashboard's live path).
const TUI_AUDIT_ROW_LIMIT = 200

// specs/130 phase 4 — how many of the Orchestrator's most recent tasks the
// Tasks pane keeps (was 30). The pane windows its rows, so this bounds
// memory and per-poll work, not the layout.
const TUI_TASK_FETCH_LIMIT = 100

// specs/130 phase 4 — the dashboard's empty-chat examples and quick tasks,
// shown as text only (1–4 already switch modes, so no number shortcuts).
const CHAT_EXAMPLE_PROMPTS = ["what agents are online?", "what is my git status?", "is there test coverage?"]
const CHAT_QUICK_TASKS = [
  "analyze my project",
  "git status",
  "dockerize bun app on port 3000",
  "create ci pipeline for bun",
  "create gitignore for bun",
  "what agents do I need to deploy my app?",
  "setup my project from scratch",
  "build and deploy my bun app",
]

// specs/047-tui-conversation-operations-navigation/spec.md — Phase 1 adds
// `childTaskIds`, mirroring ./tui-state's own TaskRowLike. Already present
// on the server's real task objects (apps/orchestrator/index.ts:72, "set on
// parent plan tasks") and already arriving on the exact GET /tasks response
// this file already polls (that poll casts the raw server JSON directly to
// `TaskRow[]`, so no mapping code changes for this field to start flowing
// through) — only the type declaration was missing. Nothing reads it yet
// (Phase 4 wires findWaitingPlanChild() into the linked task card).
interface TaskRow {
  id: string
  text: string
  skill?: string
  assignedAgent?: string
  status: string
  result?: string
  error?: string
  approval?: Partial<ApprovalPreview>
  isPlan?: boolean
  parentTaskId?: string
  direct?: boolean
  childTaskIds?: string[]
}

// specs/021-ag-ui-event-protocol/spec.md — live tool-call activity for one
// task, built from TOOL_CALL_START/TOOL_CALL_RESULT pairs on the
// Orchestrator's AG-UI event stream. This is the detail that previously
// only ever existed in an agent's own console output, invisible here.
interface ToolCallRow {
  id: string
  name: string
  caller?: string
  outcome?: "completed" | "failed" | "timeout"
  durationMs?: number
}

// A task submitted directly to an agent (bypassing the Orchestrator) never
// shows up in GET /tasks — that endpoint only ever lists Orchestrator-known
// tasks. The TUI tracks these itself, client-side, and polls each one's
// status straight from the owning agent so it can still show up in the
// Tasks pane and be inspected/approved from here, closing the exact gap
// Yusuf hit: the browser dashboard showed the task completing, the TUI
// didn't show it at all.
interface DirectTask {
  id: string
  agentName: string
  agentUrl: string
  text: string
  status: string
  result?: string
  error?: string
}

interface TaskDetail {
  id: string
  text?: string
  status: string
  result?: string
  error?: string
  // specs/037-tui-approval-preview-card/spec.md — the server-supplied
  // ApprovalPreview. `Partial` because the TUI must tolerate a missing
  // field rather than assume the full shape; rendering guards each one.
  approval?: Partial<ApprovalPreview>
  // specs/089-plan-step-skip-continue/spec.md — present exactly when this
  // is a plan step's own child task (mirrors OrchestratorTask.parentTaskId
  // verbatim); the Detail overlay's own hint text uses this to offer "s"
  // only where it can actually apply.
  parentTaskId?: string
  // specs/130 phase 2 — a plan's own steps, as GET /tasks/:id returns them.
  planSteps?: PlanStepLike[]
}

// specs/037-tui-approval-preview-card/spec.md — turn the server-supplied
// ApprovalPreview into labeled rows for the Detail overlay so `target` and
// `risks` are legible without reading raw JSON. Rendering only: every value
// comes straight off the object the TUI already fetched from
// GET /tasks/:id — nothing is reconstructed, re-derived, or reinterpreted
// (in particular, `target` is always the authoritative field, never rebuilt
// from `parameters`).
export interface ApprovalDisplayRow {
  label: string
  value: string
  tone: "target" | "normal" | "risk" | "muted" | "added" | "removed"
}

const APPROVAL_TONE_FG: Record<ApprovalDisplayRow["tone"], string> = {
  target: "#58a6ff",
  normal: "#d29922",
  risk: "#f85149",
  muted: "#6e7681",
  // specs/040-approval-preview-content-diff/spec.md
  added: "#3fb950",
  removed: "#f85149",
}

function formatApprovalValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  return JSON.stringify(value)
}

// specs/130 — the same plain-English kind labels the dashboard's card uses.
const APPROVAL_KIND_LABEL: Record<string, string> = {
  "mcp-tool": "MCP tool call",
  command: "Command",
  "file-write": "File write",
}

// specs/130 phase 2 — total diff rows shown across every file of a
// multi-file approval; the rest is reachable through v (raw JSON).
export const MAX_MULTI_FILE_DIFF_ROWS = 300

// specs/040 — buildContentPreview()'s decision (diff/plain/omitted/none)
// as Detail rows; shared by the single-file and per-file paths.
function contentPreviewRows(content: string | undefined, previousContent: string | undefined): ApprovalDisplayRow[] {
  const preview = buildContentPreview(content, previousContent)
  if (preview.kind === "diff") {
    return preview.lines.map((line) => ({
      label: line.type === "added" ? "+" : line.type === "removed" ? "-" : " ",
      value: line.text,
      tone: line.type === "added" ? "added" : line.type === "removed" ? "removed" : "normal",
    }))
  }
  if (preview.kind === "plain") {
    return preview.text.split("\n").map((line) => ({ label: " ", value: line, tone: "normal" }))
  }
  if (preview.kind === "omitted") {
    return [{
      label: "Content",
      value: `${preview.totalBytes.toLocaleString()} bytes — too large to preview inline, press v for raw JSON`,
      tone: "muted",
    }]
  }
  return []
}

export function formatApprovalRows(approval: Partial<ApprovalPreview>): ApprovalDisplayRow[] {
  const rows: ApprovalDisplayRow[] = []
  if (approval.target) rows.push({ label: "Target", value: approval.target, tone: "target" })
  const kindLabel = approval.kind ? (APPROVAL_KIND_LABEL[approval.kind] ?? approval.kind) : undefined
  const action = [kindLabel, approval.toolName ?? approval.executable].filter(Boolean).join(": ")
  if (action) rows.push({ label: "Action", value: action, tone: "normal" })
  // specs/130 — the exact argv that will run, as an array so a token with
  // spaces is unambiguous, and whether a write replaces an existing file.
  if (approval.argv && approval.argv.length > 0) rows.push({ label: "Argv", value: JSON.stringify(approval.argv), tone: "target" })
  if (approval.overwrite !== undefined) {
    rows.push({ label: "Overwrite", value: approval.overwrite ? "yes — replaces an existing file" : "no — creates a new file", tone: approval.overwrite ? "risk" : "normal" })
  }
  if (approval.summary) rows.push({ label: "Summary", value: approval.summary, tone: "normal" })
  if (approval.parameters && typeof approval.parameters === "object") {
    for (const [key, val] of Object.entries(approval.parameters)) {
      rows.push({ label: key, value: formatApprovalValue(val), tone: "normal" })
    }
  }
  // specs/114 + specs/130 phase 2 — a multi-file proposal (Coder's
  // edit-files skill) renders a NEW/EDIT header row per file followed by
  // that file's own diff rows. The rows live inside the Detail overlay's
  // fixed-height scrollbox (specs/037), so they scroll rather than grow the
  // layout; the total number of diff rows across all files is still hard
  // capped at MAX_MULTI_FILE_DIFF_ROWS, which is what keeps specs/114's
  // unbounded-content concern answered.
  if (approval.files && approval.files.length > 0) {
    let diffRowsUsed = 0
    let diffRowsHidden = 0
    for (const file of approval.files) {
      const lines = computeLineDiff(file.previousContent ?? "", file.content ?? "")
      const added = lines.filter((l) => l.type === "added").length
      const removed = lines.filter((l) => l.type === "removed").length
      const isCreate = file.action === "create"
      const label = isCreate ? "NEW" : "EDIT"
      const summary = isCreate ? `+${added} lines` : `+${added}/-${removed}`
      rows.push({ label, value: `${file.target} (${summary})`, tone: isCreate ? "added" : "normal" })
      for (const row of contentPreviewRows(file.content, file.previousContent)) {
        if (diffRowsUsed >= MAX_MULTI_FILE_DIFF_ROWS) {
          diffRowsHidden++
          continue
        }
        rows.push(row)
        diffRowsUsed++
      }
    }
    if (diffRowsHidden > 0) {
      rows.push({ label: " ", value: `… ${diffRowsHidden} more lines — v for raw`, tone: "muted" })
    }
  } else {
    // specs/040-approval-preview-content-diff/spec.md — buildContentPreview()
    // is the one shared decision point (diff/plain/omitted/none); this file
    // is real compiled TypeScript, so it imports the canonical
    // packages/shared/line-diff.ts directly rather than porting it (the two
    // browser dashboards can't do that — see this file's own header comment
    // on why they duplicate instead). Rendered as one row per line, inside
    // the existing fixed-height scrollbox (specs/037), so this adds no new
    // layout-budget constant — the box already scrolls.
    rows.push(...contentPreviewRows(approval.content, approval.previousContent))
  }
  for (const risk of approval.risks ?? []) {
    rows.push({ label: "Risk", value: risk, tone: "risk" })
  }
  if (approval.actionId) rows.push({ label: "actionId", value: approval.actionId, tone: "muted" })
  return rows
}

// specs/130 phase 2 — Detail plan-step rows, colored like the live ones.
const PLAN_STEP_STATUS_FG: Record<PlanStepDisplayRow["status"], string> = {
  pending: "#6e7681",
  dispatched: "#58a6ff",
  completed: "#3fb950",
  failed: "#f85149",
}
const PLAN_STEP_STATUS_GLYPH: Record<PlanStepDisplayRow["status"], string> = {
  pending: "·",
  dispatched: "⋯",
  completed: "✓",
  failed: "✗",
}

// specs/130 phase 3 — one pending-batch branch, with the full preview so
// Enter can show its diff through formatApprovalRows().
interface BatchBranch extends BatchBranchLike {
  approval?: Partial<ApprovalPreview>
}

interface BatchReviewState {
  parentId: string
  branches: BatchBranch[]
  decisions: Record<string, BatchDecision>
  selected: number
  diffOpen: boolean
  hint: string | null
}

// Rows the branch list and the branch diff get inside the overlay — the
// same fixed height the Detail view's scrollbox uses, which fits 80×24.
const BATCH_OVERLAY_ROWS = 12

type ConnState = "connecting" | "connected" | "disconnected"

// Client-side task ID for direct-to-agent submission, matching the exact
// convention every agent's own browser dashboard JS already uses
// (`let n = Date.now(); const id = 'task-' + (n++)`) — not the server-side
// crypto.randomUUID() policy, which is specifically about producer-generated
// IDs inside the Orchestrator/agents, not client-chosen submission IDs.
let clientTaskIdCounter = Date.now()

function statusColor(status: string): string {
  switch (status) {
    case "online":
    case "completed":
      return "#3fb950"
    case "input-required":
      return "#d29922"
    case "failed":
    case "offline":
      return "#f85149"
    case "working":
    case "assigned":
      return "#58a6ff"
    default:
      return "#9ca3af"
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Every agent-side task ID already encodes its true origin — no guessing
// needed: `orch-` is the Orchestrator's own deterministic prefix for a
// dispatched task (apps/orchestrator/index.ts), `a2a-` is another agent's
// own direct A2A child call (packages/shared/a2a-client.ts — e.g. DevOps's
// analyze-project secrets pre-check into Security, entirely bypassing the
// Orchestrator), `tui-` is this TUI's own direct-to-agent submission, and
// `task-` is that agent's own browser dashboard's quick-task convention.
// This distinguishes them in the Tasks pane row itself instead of only in
// the raw ID visible in the Details view — Yusuf's exact ask after seeing
// a DevOps-triggered secrets pre-check rendered identically to a plain
// direct submission.
function originMarker(id: string): string {
  if (id.startsWith("a2a-")) return "⇄ " // triggered by another agent's own direct A2A call
  if (id.startsWith("tui-")) return "→ " // submitted directly via this TUI
  if (id.startsWith("task-")) return "◆ " // that agent's own dashboard
  return "  "
}

function App() {
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [conn, setConn] = useState<ConnState>("connecting")
  const [mode, setMode] = useState<TuiMode>("chat")
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  // Auto-follows the newest task as new ones arrive, like a chat/log view —
  // Yusuf's ask. Stays true until the user explicitly presses ↑ to look at
  // something older, and re-engages once they navigate back down to the
  // last row (or clear/toggle the view, which resets to "show me what's
  // there now"). Deliberately not an effect keyed on list length: that
  // would also fire on a hideDone/agentFilter/dismiss toggle, none of which
  // are "a new task arrived" — this is a plain intent flag instead, updated
  // only by explicit navigation, so it can't misfire on those.
  const [followLatestTask, setFollowLatestTask] = useState(true)
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0)
  const [agentFilter, setAgentFilter] = useState<string | null>(null)
  // specs/115-tui-navigation-redraw-and-answer-clarity/spec.md — closes
  // specs/108's own deferred "not live" scope decision, applying the
  // exact mechanism specs/113 already proved server-side for the
  // dashboard: reload still loads the historical page (unchanged), but a
  // real orchestrai.audit-event CUSTOM event (specs/113) now appends a
  // live row too, once this view has been opened at least once this
  // session — matching the dashboard's own "no wasted work for a panel
  // nobody has looked at" rule.
  const [auditEvents, setAuditEvents] = useState<AuditEventRow[]>([])
  // specs/130 phase 4 — Audit filtered to one task (`t`), and the Tasks
  // status-filter cycle (`t` there).
  const [auditTaskFilter, setAuditTaskFilter] = useState<string | null>(null)
  const auditTaskFilterRef = useRef<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>("all")
  const [taskCountsByAgent, setTaskCountsByAgent] = useState<Record<string, number>>({})
  // The task poll, callable from the SSE handler on RUN_FINISHED/RUN_ERROR.
  const pollNowRef = useRef<(() => void) | null>(null)
  const chatRefreshNowRef = useRef<(() => void) | null>(null)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditLoadedOnce, setAuditLoadedOnce] = useState(false)
  const auditLoadedOnceRef = useRef(false)
  // Live-smoked (specs/108's own real-PTY capture): a failed fetch used
  // to fall through to the exact same "No audit events recorded" text a
  // genuine empty-but-successful query shows — misleading, since the
  // real error was only visible in the separate status line. Tracked
  // distinctly so the content area itself is honest about which
  // happened.
  const [auditLoadFailed, setAuditLoadFailed] = useState(false)
  const [inputMode, setInputMode] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [confirmHint, setConfirmHint] = useState<string | null>(null)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  // specs/037 — `v` in the Detail overlay flips the approval block between
  // the structured rows and the byte-identical raw JSON dump. Reset
  // whenever a Detail view opens or closes.
  const [rawApproval, setRawApproval] = useState(false)
  const [detailSource, setDetailSource] = useState<"chat" | "tasks" | null>(null)
  const [agentDetail, setAgentDetail] = useState<AgentRow | null>(null)
  const [directTasks, setDirectTasks] = useState<DirectTask[]>([])
  // The filtered agent's own full task list, fetched straight from its
  // GET /tasks — the same endpoint its own browser dashboard reads. This is
  // what makes tasks that predate this TUI process (an earlier TUI run,
  // curl, that agent's own dashboard) visible here too, not just tasks this
  // exact session happened to submit itself (see directTasks below, which
  // only ever knows about the latter).
  const [remoteAgentTasks, setRemoteAgentTasks] = useState<TaskRow[]>([])
  const [showHelp, setShowHelp] = useState(false)
  // specs/047 Phase 2: Chat, Tasks, and Agents are peer full-screen modes.
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([])
  const [chatConversationId, setChatConversationId] = useState<string | null>(null)
  const [chatInputMode, setChatInputMode] = useState(false)
  const [chatInputValue, setChatInputValue] = useState("")
  const [chatPending, setChatPending] = useState<string | null>(null)
  // specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md —
  // scoped to the MOST RECENT assistant turn only (a deliberate
  // simplification over a per-turn expand state for every turn in a
  // long thread, per that spec's own Non-Goals): `d` toggles between a
  // turn's `summary` (the default, collapsed view) and its full `text`.
  // Reset to false by the effect below whenever the last turn's own id
  // changes, so a newly-arrived answer always starts collapsed.
  const [chatLastTurnExpanded, setChatLastTurnExpanded] = useState(false)
  const [chatConversations, setChatConversations] = useState<ConversationSummary[]>([])
  // specs/115-tui-navigation-redraw-and-answer-clarity/spec.md — an index
  // into the rail's own newest-first display order (renderLeftRail()'s
  // `ordered`), independent of chatConversationId so the cursor can
  // browse without switching. Kept in sync with the active thread by the
  // effect below whenever it changes out from under the cursor ([/],
  // openConversation(), or the list itself loading/changing).
  const [railCursor, setRailCursor] = useState(0)
  const [chatFollow, setChatFollow] = useState(true)
  const [chatNewUpdates, setChatNewUpdates] = useState(false)
  const [chatEvicted, setChatEvicted] = useState(false)
  const [chatThreadHint, setChatThreadHint] = useState<string | null>(null)
  const chatPendingTaskIdRef = useRef<string | null>(null)
  const chatFollowRef = useRef(true)
  const chatTurnCountRef = useRef(0)
  const chatScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const newThreadConfirmUntilRef = useRef(0)
  const [requestedTaskFocusId, setRequestedTaskFocusId] = useState<string | null>(null)
  // `h` toggles hiding completed/failed tasks from the Tasks pane entirely
  // — directly addresses the "too many tasks fill the terminal" trigger
  // from the sixth/seventh TUI extension rounds.
  const [hideDone, setHideDone] = useState(false)
  // `c` — clears the Tasks pane view. Found live (eighth round, second
  // pass): clearing only `directTasks` did nothing visible whenever every
  // shown row was a normal Orchestrator-routed task (the common case), which
  // read as "c doesn't work" even though it worked exactly as first scoped.
  // There is no delete endpoint on the Orchestrator or any agent — nothing
  // is ever deleted server-side — so this is a client-side dismiss set:
  // every task id visible at the moment `c` is pressed is remembered here
  // and filtered out of `visibleTasks` from then on. A task with a
  // never-before-seen id (a new submission, or the same logical task
  // reappearing under a different id) still shows up normally — this only
  // ever suppresses ids already seen at clear-time, not a permanent ban.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  // taskId -> toolCallId -> row. Kept separate from `tasks` so a poll
  // refresh (which replaces the whole task list) never wipes live tool-call
  // history, and so an unbounded stream of calls can't grow a task row.
  const [toolCalls, setToolCalls] = useState<Record<string, Record<string, ToolCallRow>>>({})
  const [planSteps, setPlanSteps] = useState<PlanStepsByRun>({})
  // specs/130 phase 3 — the grouped review of a specs/120 parallel-write
  // batch. Branches come straight from GET /tasks/:parentId/pending-batch;
  // each keeps its own actionId all the way to approve-batch.
  const [batchReview, setBatchReview] = useState<BatchReviewState | null>(null)
  const batchConfirmUntilRef = useRef(0)
  const pendingConfirmRef = useRef<{ key: "a" | "r" | "s"; taskId: string; expiresAt: number } | null>(null)
  const directTasksRef = useRef<DirectTask[]>([])
  const agentFilterRef = useRef<string | null>(null)
  const { width, height } = useTerminalDimensions()

  useEffect(() => {
    directTasksRef.current = directTasks
  }, [directTasks])
  useEffect(() => {
    agentFilterRef.current = agentFilter
  }, [agentFilter])
  useEffect(() => {
    chatFollowRef.current = chatFollow
  }, [chatFollow])
  useEffect(() => {
    auditLoadedOnceRef.current = auditLoadedOnce
  }, [auditLoadedOnce])

  function agentUrlByName(name: string | undefined): string | undefined {
    return agents.find((a) => a.name === name)?.url
  }

  // specs/047-tui-conversation-operations-navigation/spec.md — Phase 1: the
  // merge/filter pipeline, selection clamping, and row-budget arithmetic
  // that used to live inline here now come from ./tui-state's pure,
  // independently tested helpers (apps/tui/tui-state.test.ts) — same
  // behavior, verified byte-identical against the original inline logic
  // before this extraction, not redesigned.
  const { mergedTasks, afterDismissed, visibleTasks } = computeVisibleTasks({
    tasks,
    directTasks,
    remoteAgentTasks,
    agentFilter,
    dismissedIds,
    hideDone,
    statusFilter,
  })
  const taskById = new Map<string, TaskRow>(tasks.map((task) => [task.id, task]))
  const conversationWaitingTasks = waitingTasksForConversation(chatTurns, taskById) as TaskRow[]
  const clampedTaskIndex = computeClampedTaskIndex({ followLatestTask, selectedIndex, visibleTasksLength: visibleTasks.length })
  const clampedAgentIndex = computeClampedAgentIndex({ selectedAgentIndex, agentsLength: agents.length })

  const { maxTaskRows, taskWindowStart, hiddenAbove, hiddenBelow } = computeTaskWindow({
    agentFilterActive: agentFilter !== null,
    height,
    visibleTasksLength: visibleTasks.length,
    clampedTaskIndex,
  })
  const renderedTasks = visibleTasks.slice(taskWindowStart, taskWindowStart + maxTaskRows)

  useEffect(() => {
    if (!requestedTaskFocusId) return
    const index = visibleTasks.findIndex((task) => task.id === requestedTaskFocusId)
    if (index < 0) return
    setFollowLatestTask(false)
    setSelectedIndex(index)
    setRequestedTaskFocusId(null)
  }, [requestedTaskFocusId, visibleTasks])

  // Horizontal chrome consumed by borders/padding around every task row:
  // the outer app <box padding:1> (2 cols) + the Tasks <box border+padding>
  // (2 + 2 = 4 cols) = 6 total. Found live: the previous "-4" fudge factor
  // under-counted this by 2 columns, letting long rows wrap onto the next
  // line instead of truncating — the exact garbled-overlap bug reported.
  const HORIZONTAL_CHROME = 6
  const onlineAgentCount = agents.filter((agent) => agent.status === "online").length
  // specs/130 — every known task, not the filtered/cleared/hidden view.
  const approvalCount = countWaitingApprovals({ tasks, directTasks, remoteAgentTasks })

  function renderHeader() {
    const label = (candidate: TuiMode, shortcut: string, title: string) =>
      mode === candidate ? `[${shortcut} ${title}]` : `${shortcut} ${title}`
    // specs/047 Phase 2 correction, found the same way the scrollbox/footer
    // overflow bugs were: a real narrow-terminal (60x20) PTY pass. Neither
    // header line is bounded to the terminal width — on a narrow terminal
    // the project-path line in particular can exceed it — and without
    // `overflow: "hidden"` here, OpenTUI wraps the excess onto the row
    // below instead of clipping it, which is the header row itself,
    // corrupting it. This is the exact backstop this file's own Tasks/
    // Agents boxes already use for the same reason (see their own
    // `overflow: "hidden"`); the project path itself is also bounded so a
    // very long path degrades to a clipped-but-legible tail rather than
    // relying on the box clip alone.
    // Same redraw-artifact class as the project-path line below (Yusuf
    // live-caught it there first): this suffix's own text length varies
    // frame-to-frame ("connecting" vs "● live" vs "● disconnected", plus
    // the agent-count digits), and a shorter new frame doesn't reliably
    // clear cells a longer previous frame left behind. Padded to the
    // fixed width of its own longest real variant so consecutive frames
    // never disagree about where this line ends.
    // specs/135 — the status is sized to the width the labels leave (root
    // padding is 1 column each side), so this line never wraps. A wrap
    // added a third header row and pushed the Audit/Chat titles off screen
    // at 80×24. formatHeaderStatus() keeps each form fixed-width.
    const labelsText = `OrchestrAI   ${label("chat", "1", "Chat")}   ${label("tasks", "2", "Tasks")}   ${label("agents", "3", "Agents")}   ${label("audit", "4", "Audit")}`
    const statusText = formatHeaderStatus({
      available: width - 2 - labelsText.length,
      conn,
      online: onlineAgentCount,
      total: agents.length,
    })
    return (
      <box style={{ flexDirection: "column", overflow: "hidden" }}>
        <text style={{ fg: "#58a6ff" }}>
          {labelsText}
          <span style={{ fg: statusColor(conn === "connected" ? "online" : "offline") }}>{statusText}</span>
        </text>
        <text style={{ fg: "#9ca3af" }}>
          {
            // Yusuf live-caught a real redraw artifact here: stray leftover
            // characters interleaved into this exact line ("project:AC:\...
            // -servers approvals:v0"). Root cause: this line's own width
            // budget for the project path shifted between renders — it was
            // computed from `` `approvals: ${approvalCount}`.length ``, a
            // value that changes digit count as approvalCount changes
            // (0 → 1 → 10...), and separately the path itself changes length
            // exactly once when it resolves from "project unavailable" to
            // the real value. Either change shifts where later text starts
            // on screen between two frames; this renderer's diffing doesn't
            // reliably clear a cell whose new content is shorter than what
            // was there before (the same "overflow doesn't clip cleanly"
            // class of bug this file has hit before), so stray characters
            // from the previous, differently-laid-out frame can survive.
            // Fixed the same way every other unstable-width case in this
            // file was fixed: reserve a FIXED budget for the part that can
            // change digit count, and pad the whole line to always be
            // EXACTLY the same total length regardless of content, so two
            // consecutive renders never disagree about where anything sits.
            (() => {
              const maxWidth = Math.max(10, width - 2)
              const APPROVALS_BUDGET = 14 // "approvals: " + up to 3 digits, fixed regardless of the real count
              const approvalsText = `approvals: ${approvalCount}`.padEnd(APPROVALS_BUDGET)
              const pathWidth = Math.max(10, maxWidth - APPROVALS_BUDGET - 3 - "project: ".length)
              const line = `project: ${bounded(projectPath ?? "project unavailable", pathWidth).padEnd(pathWidth)}   ${approvalsText}`
              return line.slice(0, maxWidth)
            })()
          }
        </text>
      </box>
    )
  }

  function bounded(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
  }

  // specs/069-tui-dashboard-parity-workspace/spec.md — Phase 1: the
  // three-region shell (left conversations rail / centre / right status
  // rail). Geometry is the pure computeShellLayout()/computeShellRegionHeight()
  // from ./tui-state (breakpoints + gap math unit-tested there); this file
  // only turns that geometry into boxes. Chrome above/below the shell row is
  // unchanged — renderHeader() and the footer stay full width — so the
  // vertical budget computeTaskWindow() already reserves still holds exactly
  // (root padding 2 + header 3 + gap 1 above; gap 1 + footer 1 + padding 1
  // below == the reservedRows constant, verified against that function's
  // own arithmetic). At the 80x24 minimum BOTH rails collapse away and the
  // centre is `width - 2`, i.e. byte-identical to the pre-069 full-width
  // render — the rails only appear once there is real width to spend.
  const shell = computeShellLayout({ width, height })
  const shellRegionHeight = computeShellRegionHeight({ height })

  function renderLeftRail(): ReactNode {
    if (shell.leftRailMode === "hidden") return null
    const strip = shell.leftRailMode === "strip"
    const listHeight = Math.max(1, shellRegionHeight - 3) // border(2) + title(1)
    const ordered = [...chatConversations].reverse() // newest first
    return (
      <box
        style={{
          width: shell.leftRailWidth,
          height: shellRegionHeight,
          marginRight: 1,
          border: true,
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <text style={{ fg: "#58a6ff" }}>{strip ? "Cnv" : bounded(`Conversations (${chatConversations.length})`, shell.leftRailWidth - 2)}</text>
        <scrollbox scrollY={true} style={{ height: listHeight }} contentOptions={{ flexDirection: "column" }}>
          {ordered.length === 0 ? (
            <text style={{ fg: "#6e7681" }}>{strip ? "–" : "(none yet)"}</text>
          ) : (
            ordered.map((conversation, index) => {
              const active = conversation.id === chatConversationId
              // specs/115-tui-navigation-redraw-and-answer-clarity/spec.md
              // — a second, independent cursor (←/→ + Enter) alongside the
              // existing `[`/`]` shortcut, distinguished from `active`'s
              // own marker: the cursor can browse without switching, so
              // it needs its own visible state. Only meaningful while
              // actually in Chat mode — this rail renders in every mode
              // via the shared shell, but ←/→ only navigate it there.
              const cursored = mode === "chat" && index === railCursor
              if (strip) {
                return (
                  <text key={conversation.id} style={{ fg: active ? "#d29922" : cursored ? "#58a6ff" : "#6e7681" }}>
                    {active ? "▶" : cursored ? "›" : "·"}
                    {index + 1}
                  </text>
                )
              }
              // specs/130 phase 4 — a status glyph and a relative time, e.g.
              // "▶ ⏸ 5m Prepare this…", all inside the rail's width.
              const when = formatRelativeTime(conversation.lastTurnAt ?? conversation.createdAt, Date.now())
              const glyph = conversationStatusGlyph(conversation.taskStatus)
              const meta = `${glyph} ${when ? when + " " : ""}`
              return (
                <text key={conversation.id} style={{ bg: cursored ? "#30363d" : active ? "#21262d" : undefined }}>
                  {active ? "▶ " : cursored ? "› " : "  "}
                  <span style={{ fg: conversation.taskStatus === "input-required" ? "#d29922" : conversation.taskStatus === "failed" ? "#f85149" : "#6e7681" }}>{meta}</span>
                  <span style={{ fg: active ? "#d29922" : cursored ? "#58a6ff" : "#9ca3af" }}>
                    {bounded(conversation.preview || conversation.id, Math.max(3, shell.leftRailWidth - 4 - meta.length))}
                  </span>
                </text>
              )
            })
          )}
        </scrollbox>
      </box>
    )
  }

  function renderRightRail(): ReactNode {
    if (!shell.showRightRail) return null
    const listHeight = Math.max(1, shellRegionHeight - 3) // border(2) + title(1)
    const recent = visibleTasks.slice(-8).reverse()
    return (
      <box
        style={{
          width: shell.rightRailWidth,
          height: shellRegionHeight,
          marginLeft: 1,
          border: true,
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <text style={{ fg: "#58a6ff" }}>Status · {onlineAgentCount}/{agents.length} online</text>
        <scrollbox scrollY={true} style={{ height: listHeight }} contentOptions={{ flexDirection: "column" }}>
          {agents.length === 0 ? (
            <text style={{ fg: "#6e7681" }}>(no agents)</text>
          ) : (
            agents.map((agent) => (
              <text key={agent.name}>
                <span style={{ fg: statusColor(agent.status) }}>{agent.status === "online" ? "●" : "○"}</span>
                {" " + bounded(agent.name, Math.max(3, shell.rightRailWidth - 5))}
              </text>
            ))
          )}
          <text style={{ fg: "#6e7681" }}>{"─".repeat(Math.max(3, shell.rightRailWidth - 4))}</text>
          <text style={{ fg: "#8b949e" }}>recent tasks</text>
          {recent.length === 0 ? (
            <text style={{ fg: "#6e7681" }}>(none yet)</text>
          ) : (
            recent.map((task) => (
              <text key={task.id}>
                <span style={{ fg: statusColor(task.status) }}>
                  {task.status === "completed" ? "✓" : task.status === "failed" ? "✗" : task.status === "input-required" ? "⏸" : "⋯"}
                </span>
                {" " + bounded(task.text || task.id, Math.max(3, shell.rightRailWidth - 5))}
              </text>
            ))
          )}
        </scrollbox>
      </box>
    )
  }

  /** Wraps a centre-panel node in the shell: full-width header, then the
   *  left rail + fixed-width centre + right rail row, then a full-width
   *  footer. `renderHeader()` and `footer` deliberately sit OUTSIDE the
   *  row so they keep the full terminal width, unchanged from pre-069. */
  function renderShell(center: ReactNode, footer: ReactNode): ReactNode {
    // specs/130 — every top-level view (this shell per mode, Details, Help,
    // the input box, too-small) has its own root `key`. They share an
    // identical root box, so without keys React reused the Details view's
    // bordered+padded child as the shell's panel row and the renderer kept
    // the stale padding/border: the header collapsed onto one row
    // ("project:AC:\…  4 Audit") and panels shifted a cell. Live-reproduced
    // in a real pty; this is the bug in Yusuf's own earlier screenshot.
    return (
      <box key={`view-shell-${mode}`} style={{ flexDirection: "column", padding: 1 }}>
        {renderHeader()}
        <text> </text>
        <box style={{ flexDirection: "row" }}>
          {renderLeftRail()}
          <box style={{ width: shell.centerWidth, flexDirection: "column", overflow: "hidden" }}>{center}</box>
          {renderRightRail()}
        </box>
        <text> </text>
        {footer}
      </box>
    )
  }

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const [agentsRes, tasksRes, healthRes] = await Promise.all([
          fetch(`${ORCHESTRATOR_URL}/agents`, { signal: AbortSignal.timeout(3000) }),
          fetch(`${ORCHESTRATOR_URL}/tasks`, { signal: AbortSignal.timeout(3000) }),
          fetch(`${ORCHESTRATOR_URL}/healthz`, { signal: AbortSignal.timeout(3000) }),
        ])
        if (!agentsRes.ok || !tasksRes.ok || !healthRes.ok) throw new Error("non-2xx response")

        const agentsData = (await agentsRes.json()) as { agents: AgentRow[] }
        const tasksData = (await tasksRes.json()) as { tasks: TaskRow[] }
        const healthData = (await healthRes.json()) as { projectPath?: string }

        if (cancelled) return
        setAgents(agentsData.agents)
        // Oldest-first (ascending) so newly-arriving tasks append at the
        // bottom of the pane instead of pushing everything down from the
        // top — Yusuf's ask: "the next task will be below". Keeps only the
        // most recent TUI_TASK_FETCH_LIMIT (specs/130 raised it from 30; the
        // Tasks pane already windows its rows), without reversing their
        // relative order afterward.
        setTasks(tasksData.tasks.slice(-TUI_TASK_FETCH_LIMIT))
        // specs/130 phase 4 — per-agent counts over every Orchestrator task,
        // not just the kept window, for Agent details.
        const counts: Record<string, number> = {}
        for (const task of tasksData.tasks) {
          if (task.assignedAgent) counts[task.assignedAgent] = (counts[task.assignedAgent] ?? 0) + 1
        }
        setTaskCountsByAgent(counts)
        setProjectPath(healthData.projectPath ?? null)
        setConn("connected")

        // Filtered to one agent: pull its own full task list directly, the
        // same endpoint its own browser dashboard reads, so tasks that
        // existed before this TUI process started (an earlier TUI run,
        // curl, that agent's own dashboard) show up here too.
        const filterName = agentFilterRef.current
        if (filterName) {
          const filteredAgent = agentsData.agents.find((a) => a.name === filterName)
          if (filteredAgent) {
            try {
              const remoteRes = await fetch(`${filteredAgent.url}/tasks`, { signal: AbortSignal.timeout(3000) })
              if (remoteRes.ok) {
                const remoteData = (await remoteRes.json()) as {
                  tasks: Array<{ id: string; status: string; step?: string; result?: string; error?: string }>
                }
                if (!cancelled) {
                  setRemoteAgentTasks(
                    remoteData.tasks.map((t) => ({
                      id: t.id,
                      text: t.step ?? "(direct submission — no text stored by the agent)",
                      assignedAgent: filterName,
                      status: t.status,
                      direct: true,
                    })),
                  )
                }
              }
            } catch {
              // Best-effort — leave whatever remoteAgentTasks already has
              // rather than blanking a working view over one flaky poll.
            }
          }
        } else if (!cancelled) {
          setRemoteAgentTasks([])
        }
      } catch {
        if (!cancelled) setConn("disconnected")
      }

      // Refresh status for direct-to-agent submissions the Orchestrator
      // doesn't know about — pulled straight from each owning agent's own
      // GET /tasks/:id, same endpoint its own dashboard polls.
      const pending = directTasksRef.current.filter((d) => d.status !== "completed" && d.status !== "failed")
      if (pending.length > 0) {
        const updates = await Promise.all(
          pending.map(async (d) => {
            try {
              const res = await fetch(`${d.agentUrl}/tasks/${d.id}`, { signal: AbortSignal.timeout(3000) })
              if (!res.ok) return null
              const data = (await res.json()) as { status?: string; result?: string; error?: string }
              if (!data.status) return null
              return { id: d.id, status: data.status, result: data.result, error: data.error }
            } catch {
              return null
            }
          }),
        )
        if (!cancelled && updates.some((u) => u)) {
          setDirectTasks((cur) =>
            cur.map((d) => {
              const u = updates.find((x) => x && x.id === d.id)
              return u ? { ...d, status: u.status, result: u.result, error: u.error } : d
            }),
          )
        }
      }
    }

    poll()
    pollNowRef.current = () => void poll()
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      pollNowRef.current = null
      clearInterval(interval)
    }
  }, [])

  // specs/044 — a Tier 1/2 answer is appended only once its dispatched
  // task terminates, which can be well after the ask returned. Polling
  // the conversation keeps the thread live without adding a second
  // source of truth: it re-reads the server's own store, same as the
  // dashboard panel. Runs only while the view is actually open.
  useEffect(() => {
    if (mode !== "chat") return
    // No conversation selected yet: still need the bounded list so `[`/`]`
    // can navigate to an existing server-side thread on a cold start. Fetch
    // once immediately (not just on the next interval tick) so entering
    // Chat mode doesn't leave `[`/`]` inert for a full poll cycle.
    if (!chatConversationId) {
      void refreshConversationList()
      const interval = setInterval(() => void refreshConversationList(), POLL_INTERVAL_MS)
      return () => clearInterval(interval)
    }
    const id = chatConversationId
    void refreshChat(id)
    chatRefreshNowRef.current = () => void refreshChat(id)
    const interval = setInterval(() => {
      void refreshChat(id)
    }, POLL_INTERVAL_MS)
    return () => {
      chatRefreshNowRef.current = null
      clearInterval(interval)
    }
  }, [mode, chatConversationId])


  // specs/115-tui-navigation-redraw-and-answer-clarity/spec.md — keeps the
  // rail cursor pointed at the active thread whenever the ACTIVE THREAD
  // ITSELF changes ([/] jump, a fresh openConversation()), so ←/→ always
  // starts browsing from "where I actually am" rather than a stale
  // position.
  //
  // Deliberately depends on chatConversationId ONLY, not
  // chatConversations — a real, live-caught bug in this effect's first
  // version: chatConversations is a NEW array reference every single
  // conversation-list poll tick (refreshConversationList() runs on
  // POLL_INTERVAL_MS, unconditionally, whether the content actually
  // changed or not), and having it in the dependency array meant this
  // effect re-ran on every poll — snapping the cursor back to the
  // active thread within about a second of the user moving it with
  // ←/→. Yusuf: "while chosing from the threads it get me up again to
  // the first one imediatly." Reading chatConversations via closure
  // (not as a dependency) is intentional: the effect still uses its
  // current value when it DOES run (on a real chatConversationId
  // change), it just no longer re-runs merely because the list
  // refreshed.
  useEffect(() => {
    const orderedIds = [...chatConversations].reverse().map((c) => c.id)
    setRailCursor(railCursorForActive(orderedIds, chatConversationId))
  }, [chatConversationId])

  // specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md — a newly
  // arrived answer always starts collapsed (summary shown, not the full
  // text) — deliberately keyed on the LAST turn's own id (not chatTurns
  // as a whole, which would also fire on the same polling-refresh churn
  // specs/115's rail-cursor bug was just caused by).
  useEffect(() => {
    setChatLastTurnExpanded(false)
  }, [chatTurns[chatTurns.length - 1]?.id])

  // specs/021-ag-ui-event-protocol/spec.md — a SECOND data path, alongside the
  // poll above (not a replacement for it, per that spec: the poll stays the
  // source of truth for task list membership/status, which it already does
  // reliably and cheaply). This one consumes the Orchestrator's AG-UI event
  // stream purely for live tool-call activity, which polling cannot surface
  // because it's not part of any task's own persisted state.
  //
  // Hand-rolled fetch + ReadableStream rather than EventSource: matches the
  // pattern apps/orchestrator/index.ts's subscribeToAgentStream already
  // uses, and avoids depending on an EventSource implementation being
  // present in the Bun/compiled-binary runtime.
  useEffect(() => {
    let cancelled = false
    let controller: AbortController | null = null

    async function consume() {
      while (!cancelled) {
        controller = new AbortController()
        try {
          const res = await fetch(`${ORCHESTRATOR_URL}/events`, {
            headers: { Accept: "text/event-stream" },
            signal: controller.signal,
          })
          if (!res.ok || !res.body) throw new Error("no stream")

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          while (!cancelled) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            const frames = buffer.split("\n\n")
            buffer = frames.pop() ?? ""
            for (const frame of frames) {
              const dataLine = frame.split("\n").find((l) => l.startsWith("data:"))
              if (!dataLine) continue // heartbeat or comment frame
              let ev: any
              try { ev = JSON.parse(dataLine.slice(5).trim()) } catch { continue }

              // specs/130 phase 4 — a run ended: refresh now instead of
              // waiting up to one poll interval. The poll stays the source
              // of truth; this only moves it earlier.
              if (ev.type === "RUN_FINISHED" || ev.type === "RUN_ERROR") {
                pollNowRef.current?.()
                chatRefreshNowRef.current?.()
              }
              if (ev.type === "TOOL_CALL_START") {
                setToolCalls((cur) => ({
                  ...cur,
                  [ev.runId]: {
                    ...(cur[ev.runId] ?? {}),
                    [ev.toolCallId]: { id: ev.toolCallId, name: ev.toolCallName, caller: ev.caller },
                  },
                }))
                // specs/075-real-conversational-chat/spec.md §4 — narrate
                // the specific tool in flight for the run this chat turn
                // is waiting on. Never invents a result — only narrates
                // "in progress", the same STEP_STARTED/TOOL_CALL_START-only
                // rule this spec's own Safety Constraints require.
                if (chatPendingTaskIdRef.current && ev.runId === chatPendingTaskIdRef.current) {
                  setChatPending(progressPhraseForTool(ev.toolCallName))
                }
              } else if (ev.type === "TOOL_CALL_RESULT") {
                setToolCalls((cur) => {
                  const forTask = cur[ev.runId] ?? {}
                  const existing = forTask[ev.toolCallId] ?? { id: ev.toolCallId, name: ev.toolCallId }
                  return {
                    ...cur,
                    [ev.runId]: {
                      ...forTask,
                      [ev.toolCallId]: { ...existing, outcome: ev.outcome, durationMs: ev.durationMs },
                    },
                  }
                })
              } else if (ev.type === "STEP_STARTED" || ev.type === "STEP_FINISHED") {
                setPlanSteps((cur) => reducePlanStepEvent(cur, ev))
                // specs/075-real-conversational-chat/spec.md §4 — the
                // supervisor decided its next step; narrate which skill,
                // via the deterministic phrase table (never a further LLM
                // call — see that module's own comment for the tradeoff).
                if (ev.type === "STEP_STARTED" && chatPendingTaskIdRef.current && ev.runId === chatPendingTaskIdRef.current) {
                  setChatPending(progressPhraseForSkill(skillFromStepName(ev.stepName ?? "")))
                }
              } else if (ev.type === "CUSTOM" && ev.name === "orchestrai.audit-event" && auditLoadedOnceRef.current) {
                // specs/115-tui-navigation-redraw-and-answer-clarity/spec.md
                // — the exact CUSTOM event specs/113 added for the
                // dashboard's own live Audit tab; gated on
                // auditLoadedOnceRef so a session that never opened Audit
                // mode does zero extra state work for it. `v` is already
                // the exact whitelisted shape GET /audit's own rows use
                // (specs/108's whitelistAuditParams()) — no new data
                // disclosed on this channel that the dashboard's own live
                // channel doesn't already carry.
                const v = ev.value ?? {}
                setAuditEvents((cur) => {
                  const row: AuditEventRow = {
                    id: -(Date.now() * 1000 + cur.length), // synthetic — real DB ids are always positive
                    ts: typeof v.ts === "number" ? v.ts : Date.now(),
                    kind: typeof v.kind === "string" ? v.kind : "mcp-tool-call",
                    caller: typeof v.caller === "string" ? v.caller : "",
                    target: typeof v.target === "string" ? v.target : "",
                    taskId: typeof v.taskId === "string" ? v.taskId : null,
                    outcome: typeof v.outcome === "string" ? v.outcome : "completed",
                    durationMs: typeof v.durationMs === "number" ? v.durationMs : 0,
                    resultBytes: typeof v.resultBytes === "number" ? v.resultBytes : 0,
                    resultTruncated: v.resultTruncated === true ? 1 : 0,
                  }
                  return [row, ...cur].slice(0, TUI_AUDIT_ROW_LIMIT)
                })
              }
            }
          }
        } catch {
          // AG-UI is live activity only. Polling remains the source of truth,
          // so a stream failure is silent and reconnects below.
        }
        if (!cancelled) await new Promise((r) => setTimeout(r, 2000))
      }
    }

    consume()
    return () => {
      cancelled = true
      controller?.abort()
    }
  }, [])

  function showStatus(msg: string) {
    setStatusMessage(msg)
    setTimeout(() => setStatusMessage((current) => (current === msg ? null : current)), STATUS_MESSAGE_MS)
  }

  // specs/108-durable-audit-trail/spec.md B7 — mirrors the dashboard's own
  // loadAuditEvents(), reading the identical GET /audit endpoint. No
  // task-id filter in this v1 TUI view (the dashboard's own filter input
  // needs a text-entry mode this pass deliberately doesn't add here) —
  // shows the most recent events, reload only.
  async function loadAuditEvents(taskFilter: string | null = auditTaskFilterRef.current) {
    setAuditLoading(true)
    setAuditLoadFailed(false)
    try {
      // specs/136 — the server's ?task= now also matches the `orch-<id>`
      // form its agent records under, so one query covers the task.
      const urls = taskFilter
        ? [`${ORCHESTRATOR_URL}/audit?task=${encodeURIComponent(taskFilter)}`]
        : [`${ORCHESTRATOR_URL}/audit`]
      const responses = await Promise.all(urls.map(async (url) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
        return ((await res.json()) as { events?: AuditEventRow[] }).events ?? []
      }))
      setAuditEvents(responses.flat().sort((a, b) => b.ts - a.ts).slice(0, TUI_AUDIT_ROW_LIMIT))
    } catch (err) {
      setAuditLoadFailed(true)
      showStatus(`Error loading audit trail: ${errorMessage(err)}`)
    } finally {
      setAuditLoading(false)
      setAuditLoadedOnce(true)
    }
  }

  // Deliberately keyed only on `mode` — auditLoadedOnce/auditLoading are
  // read, not depended on, so this fires exactly once per session the
  // first time Audit mode is opened, never re-triggered by its own state
  // updates finishing mid-load.
  useEffect(() => {
    if (mode === "audit" && !auditLoadedOnce && !auditLoading) void loadAuditEvents()
  }, [mode])

  // A direct-to-agent task's approve/reject must hit that agent's own
  // endpoint (it has no Orchestrator-side actionId at all); an
  // Orchestrator-routed task keeps using the Orchestrator's, which holds
  // and forwards the actionId itself.
  async function approveTask(id: string, baseUrl: string = ORCHESTRATOR_URL) {
    try {
      const res = await fetch(`${baseUrl}/tasks/${id}/approve`, { method: "POST" })
      const data = (await res.json()) as { error?: string }
      showStatus(data.error ? `Error: ${data.error}` : `Approved ${id}`)
    } catch (err) {
      showStatus(`Error: ${errorMessage(err)}`)
    }
  }

  async function rejectTask(id: string, baseUrl: string = ORCHESTRATOR_URL) {
    try {
      const res = await fetch(`${baseUrl}/tasks/${id}/reject`, { method: "POST" })
      const data = (await res.json()) as { error?: string }
      showStatus(data.error ? `Error: ${data.error}` : `Rejected ${id}`)
    } catch (err) {
      showStatus(`Error: ${errorMessage(err)}`)
    }
  }

  // specs/089-plan-step-skip-continue/spec.md (Option B) — only ever
  // reachable for a plan step's own child task, scoped at the call sites
  // below (armDecision()'s own key-offer logic), never for a direct task —
  // there is no Orchestrator-side skip concept for one. Mirrors
  // approveTask()/rejectTask() exactly; no baseUrl override needed since a
  // skip is never offered for a direct task in the first place.
  async function skipTask(id: string) {
    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/tasks/${id}/skip`, { method: "POST" })
      const data = (await res.json()) as { error?: string }
      showStatus(data.error ? `Error: ${data.error}` : `Skipped ${id}`)
    } catch (err) {
      showStatus(`Error: ${errorMessage(err)}`)
    }
  }

  // specs/130 phase 3 — `g`. Eligibility is the server's decision
  // (computeDisjointBatch, specs/120): when it says no, say why and open
  // nothing; every step can still be decided on its own with a/r/s.
  async function openBatchReview(parentId: string) {
    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/tasks/${parentId}/pending-batch`, { signal: AbortSignal.timeout(3000) })
      const data = (await res.json()) as { eligible?: boolean; branches?: BatchBranch[]; error?: string }
      if (!res.ok) {
        showStatus(`Error: ${data.error ?? `HTTP ${res.status}`}`)
        return
      }
      if (!data.eligible || !Array.isArray(data.branches) || data.branches.length < 2) {
        const waiting = countWaitingPlanChildren(parentId, tasks)
        showStatus(
          waiting < 2
            ? "No grouped batch: fewer than two write steps of this plan are waiting — use a/r on each"
            : "No grouped batch: these steps write to the same file — decide each one with a/r",
        )
        return
      }
      batchConfirmUntilRef.current = 0
      setBatchReview({ parentId, branches: data.branches, decisions: {}, selected: 0, diffOpen: false, hint: null })
    } catch (err) {
      showStatus(`Error: ${errorMessage(err)}`)
    }
  }

  async function submitBatchReview(review: BatchReviewState) {
    const decisions = buildBatchDecisions(review.branches, review.decisions)
    setBatchReview(null)
    if (!decisions) {
      showStatus("Error: a branch has no actionId — nothing was submitted; press g to reload")
      return
    }
    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/tasks/${review.parentId}/approve-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json()) as { error?: string; results?: { childTaskId: string; ok: boolean; error?: unknown }[] }
      if (!res.ok || !data.results) {
        showStatus(`Error: ${data.error ?? `HTTP ${res.status}`} — nothing was submitted`)
        return
      }
      const failed = data.results.filter((result) => !result.ok)
      showStatus(
        failed.length === 0
          ? `Batch submitted: ${summarizeBatchDecisions(review.branches, review.decisions)}`
          : `Batch submitted with ${failed.length} failure(s): ${failed.map((result) => `${result.childTaskId}: ${typeof result.error === "string" ? result.error : JSON.stringify(result.error)}`).join("; ")}`,
      )
    } catch (err) {
      showStatus(`Error: ${errorMessage(err)}`)
    }
  }

  async function openDetail(row: TaskRow, source: "chat" | "tasks" = "tasks"): Promise<boolean> {
    const baseUrl = row.direct
      ? (directTasks.find((d) => d.id === row.id)?.agentUrl ?? agentUrlByName(row.assignedAgent))
      : undefined
    if (row.direct && !baseUrl) {
      showStatus(`Error: lost track of ${row.id}'s agent`)
      return false
    }
    try {
      const res = await fetch(`${baseUrl ?? ORCHESTRATOR_URL}/tasks/${row.id}`, { signal: AbortSignal.timeout(3000) })
      const data = (await res.json()) as TaskDetail
      if (data.error && !res.ok) {
        showStatus(`Error: ${data.error}`)
        return false
      }
      setRawApproval(false)
      setDetailSource(source)
      setDetail({ ...data, id: row.id, text: data.text ?? row.text })
      return true
    } catch (err) {
      showStatus(`Error: ${errorMessage(err)}`)
      return false
    }
  }

  // specs/089-plan-step-skip-continue/spec.md (Option B) — "s" is only
  // ever meaningful for a plan step's own child task (task.parentTaskId
  // set); the Orchestrator's own POST /tasks/:id/skip refuses it for a
  // direct task with a named error, but this is caught here too so the
  // keybinding simply does nothing for a direct task rather than round-
  // tripping to get refused — the same "don't offer what can't apply"
  // principle the endpoint's own scope restriction already states.
  function armDecision(key: "a" | "r" | "s", task: TaskRow) {
    if (key === "s" && !task.parentTaskId) return
    const resolution = resolveConfirmPress(pendingConfirmRef.current, key, task.id, Date.now())
    if (resolution.action === "confirm") {
      pendingConfirmRef.current = null
      setConfirmHint(null)
      const baseUrl = task.direct
        ? (directTasks.find((item) => item.id === task.id)?.agentUrl ?? agentUrlByName(task.assignedAgent))
        : undefined
      if (key === "a") void approveTask(task.id, baseUrl)
      else if (key === "r") void rejectTask(task.id, baseUrl)
      else void skipTask(task.id)
      // specs/130 — close details after a decision from any source; they'd
      // otherwise keep showing a preview that's no longer waiting.
      if (detailSource !== null) {
        setDetail(null)
        setDetailSource(null)
      }
      return
    }
    pendingConfirmRef.current = resolution.pending
    const label = key === "a" ? "approve" : key === "r" ? "reject" : "skip"
    setConfirmHint(`Press ${key} again to ${label} ${task.id}`)
    setTimeout(() => {
      if (pendingConfirmRef.current && pendingConfirmRef.current.expiresAt <= Date.now()) {
        pendingConfirmRef.current = null
        setConfirmHint(null)
      }
    }, CONFIRM_WINDOW_MS + 50)
  }

  // ============================================================
  // specs/044-conversational-ask-layer — the chat surface
  // ============================================================
  // specs/047 Phase 3 correction, found the same way the layout bugs were —
  // a real PTY pass, this time exercising `[`/`]` navigation from a fresh
  // session that had never dispatched its own question. The bounded
  // conversation list previously only ever got fetched as a side effect of
  // refreshChat(), which itself only ever ran once a conversationId was
  // already known — a cold start had an empty chatConversations, so `[`/`]`
  // did nothing even though real server-side conversations existed. This
  // directly contradicted section 2's own "[ and ] move through the bounded
  // server conversation list" — not a hypothetical, a real reproducible gap.
  // Extracted so the list can be fetched independently of having a
  // conversation already selected.
  async function refreshConversationList() {
    try {
      const listRes = await fetch(`${ORCHESTRATOR_URL}/conversations`)
      if (listRes.ok) {
        const list = (await listRes.json()) as { conversations?: ConversationSummary[] }
        setChatConversations(list.conversations ?? [])
      }
    } catch {
      // Transient — the next poll picks it up.
    }
  }

  // Always re-reads GET /conversations/:id rather than appending locally:
  // the server's store is authoritative, so the thread can't drift from
  // what was actually recorded (same rule the dashboard panel follows).
  async function refreshChat(conversationId: string) {
    try {
      const [res] = await Promise.all([
        fetch(`${ORCHESTRATOR_URL}/conversations/${conversationId}`),
        refreshConversationList(),
      ])
      if (!res.ok) {
        if (res.status === 404) setChatEvicted(true)
        return
      }
      const conv = (await res.json()) as { turns?: ChatTurn[] }
      const turns = conv.turns ?? []
      if (turns.length > chatTurnCountRef.current && !chatFollowRef.current) setChatNewUpdates(true)
      chatTurnCountRef.current = turns.length
      setChatEvicted(false)
      setChatTurns(turns)
      const pendingTaskId = chatPendingTaskIdRef.current
      if (pendingTaskId && hasTerminalAnswerForTask(turns, pendingTaskId)) {
        chatPendingTaskIdRef.current = null
        setChatPending(null)
      }
    } catch {
      // Transient — the poll below or the next submit will pick it up.
    }
  }

  function openConversation(conversationId: string) {
    chatPendingTaskIdRef.current = null
    chatTurnCountRef.current = 0
    setChatPending(null)
    setChatTurns([])
    setChatConversationId(conversationId)
    setChatEvicted(false)
    setChatFollow(true)
    setChatNewUpdates(false)
    setChatThreadHint(null)
    void refreshChat(conversationId)
  }

  async function submitAsk(question: string) {
    if (!question.trim()) return
    chatPendingTaskIdRef.current = null
    setChatPending("thinking…")

    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          chatConversationId ? { question, conversationId: chatConversationId } : { question },
        ),
      })
      const data = (await res.json()) as {
        error?: string
        conversationId?: string
        taskId?: string
        skill?: string
        requiresApproval?: boolean
      }

      if (data.error) {
        chatPendingTaskIdRef.current = null
        setChatPending(null)
        showStatus(`Error: ${data.error}`)
        return
      }

      if (data.conversationId) {
        setChatConversationId(data.conversationId)
        setChatEvicted(false)
        await refreshChat(data.conversationId)
      }

      // Tier 1 means write-capable/potentially gated, not that an approval is
      // currently waiting. Phase 4 renders approval only from authoritative
      // input-required task state.
      chatPendingTaskIdRef.current = data.taskId ?? null
      setChatPending(
        data.taskId
          ? `running ${data.skill}…`
          : null,
      )
    } catch (err) {
      chatPendingTaskIdRef.current = null
      setChatPending(null)
      showStatus(`Error: ${errorMessage(err)}`)
    }
  }

  async function submitTask(text: string) {
    if (!text.trim()) return

    const targetAgent = agentFilter ? agents.find((a) => a.name === agentFilter) : undefined

    // Direct-to-agent submission bypasses the Orchestrator entirely — the
    // task is sent straight to that agent's own "/" endpoint, exactly like
    // hitting its browser dashboard's "Send Task" box would. It never
    // touches the Orchestrator's GET /tasks, so it's tracked locally in
    // `directTasks` and polled straight from the agent, so it still shows
    // up in this pane instead of only ever being visible in that agent's
    // own browser dashboard.
    if (targetAgent) {
      const id = `tui-${clientTaskIdCounter++}`
      try {
        const res = await fetch(`${targetAgent.url}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, message: { role: "user", parts: [{ text }] } }),
        })
        const data = (await res.json()) as { error?: string; status?: string }
        if (data.error) {
          showStatus(`Error: ${data.error}`)
          return
        }
        // Appended, not prepended — keeps this list in the same
        // oldest-to-newest order as the main task list above, so a mixed
        // (direct + Orchestrator-routed) view stays chronologically
        // consistent top-to-bottom.
        setDirectTasks((cur) => [
          ...cur,
          { id, agentName: targetAgent.name, agentUrl: targetAgent.url, text, status: data.status ?? "submitted" },
        ])
        showStatus(`Submitted ${id} → ${targetAgent.name} directly`)
      } catch (err) {
        showStatus(`Error: ${errorMessage(err)}`)
      }
      return
    }

    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      const data = (await res.json()) as { error?: string; assignedAgent?: string }
      showStatus(data.error ? `Error: ${data.error}` : `Submitted → ${data.assignedAgent ?? "?"}`)
    } catch (err) {
      showStatus(`Error: ${errorMessage(err)}`)
    }
  }

  // Global hotkeys — specs/012-tui-interactive/spec.md, extended with agent
  // pane selection/filter/targeting. Suspended while an overlay (input,
  // task detail, agent detail) is open, in that priority order.
  useKeyboard((key) => {
    // specs/047-tui-conversation-operations-navigation/spec.md — Phase 1:
    // overlay/input precedence (input > chatInput > detail > agentDetail >
    // help > global) now comes from ./tui-state's own
    // resolveKeyOwner(), independently tested against exactly this order
    // (apps/tui/tui-state.test.ts). Each branch below still does the same
    // work it always did — only the "which one owns this keypress" decision
    // moved into one shared, tested function, ahead of Phase 2 inserting
    // 1/2/3 mode shortcuts into this same precedence list.
    const keyOwner = resolveKeyOwner({
      inputMode,
      chatInputMode,
      hasDetail: detail !== null,
      hasAgentDetail: agentDetail !== null,
      showHelp,
      hasBatchReview: batchReview !== null,
    })

    if (keyOwner === "input") {
      if (key.name === "escape") {
        setInputMode(false)
        setInputValue("")
      }
      return
    }

    // specs/044 — chat input captures typing exactly the way the new-task
    // box above does; only Esc is intercepted to cancel.
    if (keyOwner === "chatInput") {
      if (key.name === "escape") {
        setChatInputMode(false)
        setChatInputValue("")
      }
      return
    }

    if (keyOwner === "detail") {
      // Up/down (and the scrollbox's own PageUp/PageDown/Home/End) are left
      // to fall through to the focused <scrollbox> below for scrolling long
      // content — only intercept the keys handled here.
      if (key.name === "escape" || key.name === "return") {
        setRawApproval(false)
        setDetail(null)
        setDetailSource(null)
        pendingConfirmRef.current = null
        setConfirmHint(null)
        return
      }
      // specs/037 — toggle the approval block between labeled rows and raw
      // JSON. No-op unless this task actually carries an approval preview.
      if (key.name === "v" && detail?.approval) setRawApproval((r) => !r)
      // specs/130 — works wherever the details were opened from (Tasks,
      // Chat, or `2` from Chat), and finds direct-to-agent tasks too.
      if (detail?.status === "input-required" && (key.name === "a" || key.name === "r" || key.name === "s")) {
        const row = mergedTasks.find((task) => task.id === detail.id) ?? tasks.find((task) => task.id === detail.id)
        if (row) armDecision(key.name, row)
      }
      return
    }

    // specs/130 phase 3 — the grouped batch review. ↑/↓ select (or scroll
    // an open diff), a/r set the selected branch's decision, Enter shows or
    // hides its diff, y twice submits every decision in one approve-batch
    // request, Esc closes the diff and then the review, submitting nothing.
    if (keyOwner === "batchReview" && batchReview) {
      if (key.name === "escape") {
        if (batchReview.diffOpen) setBatchReview({ ...batchReview, diffOpen: false })
        else {
          setBatchReview(null)
          showStatus("Grouped review closed — nothing submitted")
        }
        return
      }
      if (key.name === "return") {
        setBatchReview({ ...batchReview, diffOpen: !batchReview.diffOpen })
        return
      }
      if (batchReview.diffOpen) return // ↑/↓/PgUp/PgDn scroll the diff
      if (key.name === "up" || key.name === "down") {
        const delta = key.name === "up" ? -1 : 1
        const selected = Math.min(Math.max(0, batchReview.selected + delta), batchReview.branches.length - 1)
        setBatchReview({ ...batchReview, selected })
        return
      }
      if (key.name === "a" || key.name === "r") {
        const branch = batchReview.branches[batchReview.selected]
        if (!branch) return
        batchConfirmUntilRef.current = 0
        setBatchReview({
          ...batchReview,
          decisions: { ...batchReview.decisions, [branch.id]: key.name === "a" ? "approve" : "reject" },
          hint: null,
        })
        return
      }
      if (key.name === "y") {
        const now = Date.now()
        if (now >= batchConfirmUntilRef.current) {
          batchConfirmUntilRef.current = now + CONFIRM_WINDOW_MS
          setBatchReview({ ...batchReview, hint: `Press y again to submit: ${summarizeBatchDecisions(batchReview.branches, batchReview.decisions)}` })
          setTimeout(() => {
            if (batchConfirmUntilRef.current <= Date.now()) {
              setBatchReview((current) => (current ? { ...current, hint: null } : current))
            }
          }, CONFIRM_WINDOW_MS + 50)
          return
        }
        batchConfirmUntilRef.current = 0
        void submitBatchReview(batchReview)
      }
      return
    }

    if (keyOwner === "agentDetail") {
      if (key.name === "escape" || key.name === "return") setAgentDetail(null)
      return
    }

    if (keyOwner === "help") {
      if (key.name === "escape" || key.name === "return" || key.sequence === "?") setShowHelp(false)
      return
    }

    const nextMode = resolveModeKey(key, mode)
    if (nextMode) {
      if (mode === "chat" && nextMode === "tasks" && conversationWaitingTasks.length === 1) {
        const target = conversationWaitingTasks[0]
        setAgentFilter(null)
        setDismissedIds((current) => {
          const next = new Set(current)
          next.delete(target.id)
          return next
        })
        setRequestedTaskFocusId(target.id)
        void openDetail(target, "tasks")
      }
      setMode(nextMode)
      return
    }

    // Help is available from every normal mode. It must be resolved before
    // Chat's mode-local key handling consumes otherwise-unhandled keys.
    if (key.name === "?" || key.sequence === "?") {
      setShowHelp(true)
      return
    }

    // specs/130 phase 3 — `g` opens the grouped review for the plan in view.
    if (key.name === "g" && (mode === "chat" || mode === "tasks")) {
      if (conn !== "connected") {
        showStatus("Grouped review unavailable while disconnected")
        return
      }
      const parentId = resolveBatchParentId({
        mode,
        waitingInThread: conversationWaitingTasks,
        selectedTask: mode === "tasks" ? visibleTasks[clampedTaskIndex] : null,
      })
      if (!parentId) {
        showStatus(mode === "chat" ? "No plan step is waiting in this thread" : "Select a plan or one of its steps first")
        return
      }
      void openBatchReview(parentId)
      return
    }

    if (mode === "chat") {
      if (key.name === "a" || key.name === "r" || key.name === "s") {
        if (conn !== "connected") {
          showStatus("Approval unavailable while disconnected")
          return
        }
        if (conversationWaitingTasks.length === 0) {
          showStatus("No approval is waiting in this thread")
          return
        }
        // specs/130 — with several waiting, open the newest one's details
        // rather than refusing. Nothing is armed: which task this is must be
        // visible before a decision, and details take a/r/s from any source.
        if (conversationWaitingTasks.length > 1) {
          const newest = conversationWaitingTasks[conversationWaitingTasks.length - 1]!
          void openDetail(newest, "chat")
          showStatus(`${conversationWaitingTasks.length} approvals waiting — showing the newest; 2 lists them all, g reviews a plan's batch`)
          return
        }
        const target = conversationWaitingTasks[0]
        // specs/089 — "s" only applies to a plan step's own child task;
        // matches armDecision()'s own scoping exactly, checked here too so
        // the status message names the actual reason instead of silently
        // doing nothing.
        if (key.name === "s" && !target.parentTaskId) {
          showStatus("Skip only applies to a plan step's own approval — use r to reject instead")
          return
        }
        void openDetail(target, "chat").then((opened) => {
          if (opened) armDecision(key.name as "a" | "r" | "s", target)
        })
        return
      }
      if (key.name === "up" || key.name === "pageup" || key.name === "home") {
        setChatFollow(false)
        return
      }
      if (key.name === "end") {
        setChatFollow(true)
        setChatNewUpdates(false)
        const scroll = chatScrollRef.current
        if (scroll) scroll.scrollTo(scroll.scrollHeight)
        return
      }
      if (key.name === "down" || key.name === "pagedown") {
        setTimeout(() => {
          const scroll = chatScrollRef.current
          if (scroll && isChatAtBottom(scroll.scrollTop, scroll.scrollHeight, scroll.height)) {
            setChatFollow(true)
            setChatNewUpdates(false)
          }
        }, 0)
        return
      }
      if (key.name === "[" || key.sequence === "[") {
        const previous = adjacentConversationId(chatConversations, chatConversationId, -1)
        if (previous) openConversation(previous)
        else showStatus("Already at the oldest available thread")
        return
      }
      if (key.name === "]" || key.sequence === "]") {
        const next = adjacentConversationId(chatConversations, chatConversationId, 1)
        if (next) openConversation(next)
        else showStatus("Already at the newest available thread")
        return
      }
      // specs/115-tui-navigation-redraw-and-answer-clarity/spec.md — a
      // second, independent way to reach any thread directly: ←/→ move a
      // visible cursor through the rail without switching anything (so
      // browsing past several threads costs one press each, not one
      // "open" per step the way [/] does), then Enter opens whatever the
      // cursor is currently on. Up/Down/PageUp/PageDown/Home/End above
      // are already claimed for scrolling the transcript, so ←/→ is the
      // one direction left unclaimed in this mode.
      if (key.name === "left") {
        const orderedLength = chatConversations.length
        setRailCursor((cursor) => moveRailCursor(cursor, orderedLength, -1))
        return
      }
      if (key.name === "right") {
        const orderedLength = chatConversations.length
        setRailCursor((cursor) => moveRailCursor(cursor, orderedLength, 1))
        return
      }
      if (key.name === "return") {
        const ordered = [...chatConversations].reverse()
        const cursorTarget = ordered[clampRailCursor(railCursor, ordered.length)]
        if (cursorTarget && cursorTarget.id !== chatConversationId) {
          openConversation(cursorTarget.id)
          return
        }
        setChatInputMode(true)
        return
      }
      if (key.name === "n") {
        setChatInputMode(true)
        return
      }
      // specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md —
      // toggles the most recent assistant turn between its collapsed
      // `summary` and its full `text`. A no-op when the last turn has
      // nothing to expand (no summary, or summary === text) — pressing
      // it never breaks anything, it just has nothing to show.
      if (key.name === "d") {
        setChatLastTurnExpanded((expanded) => !expanded)
        return
      }
      // A fresh thread — the previous conversation is untouched on the
      // server, this only stops carrying it as context. A populated thread
      // needs a visible repeated press so an accidental `c` does not discard
      // the user's current navigation position.
      if (key.name === "c") {
        const now = Date.now()
        if (chatTurns.length > 0 && now >= newThreadConfirmUntilRef.current) {
          newThreadConfirmUntilRef.current = now + CONFIRM_WINDOW_MS
          setChatThreadHint("Press c again to start a new thread")
          setTimeout(() => {
            if (newThreadConfirmUntilRef.current <= Date.now()) setChatThreadHint(null)
          }, CONFIRM_WINDOW_MS + 50)
          return
        }
        newThreadConfirmUntilRef.current = 0
        setChatConversationId(null)
        setChatTurns([])
        chatPendingTaskIdRef.current = null
        chatTurnCountRef.current = 0
        setChatPending(null)
        setChatEvicted(false)
        setChatFollow(true)
        setChatNewUpdates(false)
        setChatThreadHint(null)
      }
      return
    }

    // "how do I get back" — Esc clears an active agent filter whenever no
    // overlay is open, as a more discoverable alternative to pressing `f`
    // on the same agent again (which still also works).
    if (key.name === "escape" && agentFilter) {
      setAgentFilter(null)
      setFollowLatestTask(true)
      return
    }

    if (key.name === "up") {
      if (mode === "agents") {
        setSelectedAgentIndex((i) => Math.max(0, i - 1))
      } else {
        // Pressing ↑ is an explicit request to look at something older —
        // detach from auto-follow and start navigating from wherever the
        // view currently sits (the newest row, if we were following).
        setFollowLatestTask(false)
        setSelectedIndex(nextIndexOnArrowUp({ followLatestTask, selectedIndex, visibleTasksLength: visibleTasks.length }))
      }
      return
    }
    if (key.name === "down") {
      if (mode === "agents") {
        setSelectedAgentIndex((i) => Math.min(Math.max(0, agents.length - 1), i + 1))
      } else {
        const { index: next, resumesFollow } = nextIndexOnArrowDown({ selectedIndex, visibleTasksLength: visibleTasks.length })
        setSelectedIndex(next)
        // Reaching (or already at) the last row re-engages auto-follow —
        // "scroll back to the bottom" and "resume following" are the same
        // gesture here, matching ordinary chat/log UI behavior.
        if (resumesFollow) setFollowLatestTask(true)
      }
      return
    }
    if (key.name === "n") {
      if (mode !== "tasks") return
      setInputMode(true)
      return
    }
    if (key.name === "c") {
      if (mode !== "tasks") return
      // Toggle: clears the whole Tasks pane view on first press, undoes it
      // (restores everything) on a second press — Yusuf's ask, so a `c`
      // isn't a one-way trip if pressed by mistake or too early. Nothing is
      // ever deleted anywhere either way: no Orchestrator or agent endpoint
      // is called, so the same tasks remain fully visible via curl/that
      // agent's own dashboard throughout. A task with a genuinely new id (a
      // new submission after clearing) still appears normally regardless of
      // dismissedIds' current state.
      if (dismissedIds.size > 0) {
        const count = dismissedIds.size
        setDismissedIds(new Set())
        setFollowLatestTask(true)
        showStatus(`Restored ${count} task${count === 1 ? "" : "s"}`)
        return
      }
      const count = visibleTasks.length
      if (count > 0) {
        setDismissedIds((cur) => {
          const next = new Set(cur)
          for (const t of visibleTasks) next.add(t.id)
          return next
        })
      }
      setFollowLatestTask(true)
      showStatus(count > 0 ? `Cleared ${count} task${count === 1 ? "" : "s"} from view — press c again to undo` : "Nothing to clear")
      return
    }
    if (key.name === "h") {
      if (mode !== "tasks") return
      setHideDone((v) => !v)
      setFollowLatestTask(true)
      return
    }
    if (key.name === "return") {
      if (mode === "agents") {
        const a = agents[clampedAgentIndex]
        if (a) setAgentDetail(a)
      } else {
        const t = visibleTasks[clampedTaskIndex]
        if (t) void openDetail(t)
      }
      return
    }
    if (key.name === "f" && mode === "agents") {
      const a = agents[clampedAgentIndex]
      if (a) {
        setAgentFilter((current) => (current === a.name ? null : a.name))
        setFollowLatestTask(true)
        setMode("tasks")
      }
      return
    }
    if (key.name === "r" && mode === "audit") {
      void loadAuditEvents()
      return
    }
    // specs/130 phase 4 — Audit: show only the task selected in Tasks (the
    // same row `2` then Enter would open), or everything again.
    if (key.name === "t" && mode === "audit") {
      const next = auditTaskFilterRef.current ? null : (visibleTasks[clampedTaskIndex]?.id ?? null)
      if (!auditTaskFilterRef.current && !next) {
        showStatus("Select a task in Tasks (2) first, then press t here")
        return
      }
      auditTaskFilterRef.current = next
      setAuditTaskFilter(next)
      void loadAuditEvents(next)
      return
    }
    // specs/130 phase 4 — Tasks: all → waiting → running → failed → completed.
    if (key.name === "t" && mode === "tasks") {
      const next = nextTaskStatusFilter(statusFilter)
      setStatusFilter(next)
      setFollowLatestTask(true)
      showStatus(next === "all" ? "Showing all statuses" : `Showing ${next} tasks only — t to cycle`)
      return
    }

    if (mode !== "tasks") return
    if (key.name !== "a" && key.name !== "r" && key.name !== "s") return

    const selected = visibleTasks[clampedTaskIndex]
    if (!selected || selected.status !== "input-required") return

    armDecision(key.name, selected)
  })

  // Help is now a separate full-screen view rather than a third box
  // stacked below Agents+Tasks (Yusuf's ask). This isn't just cosmetic: it
  // removes Help entirely from the overflow-risk equation the thirteenth/
  // fourteenth rounds were fighting — when Help is showing, it's the ONLY
  // thing rendered, so there's no "Agents + Tasks + Help" combined height
  // to overflow the terminal at all. `overlayRows`'s own showHelp branch
  // (still computed below for the reservedRows arithmetic) is now
  // structurally unreachable — the whole Agents/Tasks layout early-returns
  // before it's used whenever showHelp is true — but left in place rather
  // than deleted, since removing it would require re-deriving it if Help
  // is ever folded back into the stacked layout.
  // specs/044-conversational-ask-layer — the chat view, deliberately
  // built on the SAME early-return structure Help uses rather than as a
  // third stacked box. That choice is load-bearing, not stylistic: while
  // this is showing it is the only thing rendered, so it adds nothing to
  // the Agents+Tasks combined height the thirteenth/fourteenth rounds
  if (width < 80 || height < 24) {
    return (
      <box key="view-too-small" style={{ padding: 1, flexDirection: "column" }}>
        <text style={{ fg: "#f85149" }}>Terminal is too small</text>
        <text>Minimum required: 80×24</text>
        <text>Current size: {width}×{height}</text>
        <text>Please resize or zoom out.</text>
      </box>
    )
  }

  // specs/130 phase 3 — the grouped batch review, a full-screen view like
  // Details (its own root key, so React never reuses another view's tree).
  // Fixed height: title + one keys/hint row + BATCH_OVERLAY_ROWS rows.
  if (batchReview) {
    const lineWidth = Math.max(10, width - 6)
    const selectedBranch = batchReview.branches[batchReview.selected]
    const windowStart = computeBatchListWindow(batchReview.selected, batchReview.branches.length, BATCH_OVERLAY_ROWS)
    const visibleBranches = batchReview.branches.slice(windowStart, windowStart + BATCH_OVERLAY_ROWS)
    return (
      <box key="view-batch" style={{ flexDirection: "column", padding: 1 }}>
        {renderHeader()}
        <text> </text>
        <box style={{ border: true, padding: 1, flexDirection: "column", overflow: "hidden" }}>
          <text style={{ fg: "#58a6ff" }}>
            {bounded(`Grouped review — ${batchReview.branches.length} parallel writes · ${summarizeBatchDecisions(batchReview.branches, batchReview.decisions)}`, lineWidth)}
          </text>
          {batchReview.diffOpen && selectedBranch ? (
            <text style={{ fg: "#8b949e" }}>
              {bounded(`${selectedBranch.skill ?? "task"} · ${selectedBranch.assignedAgent ?? "agent"} — ↑/↓/PgUp/PgDn scroll · Enter or Esc back to the list`, lineWidth)}
            </text>
          ) : (
            <text style={{ fg: batchReview.hint ? "#d29922" : "#8b949e" }}>
              {bounded(batchReview.hint ?? "↑/↓ select · a approve · r reject · Enter diff · y×2 submit all · Esc close", lineWidth)}
            </text>
          )}
          {batchReview.diffOpen && selectedBranch ? (
            <scrollbox focused={true} style={{ height: BATCH_OVERLAY_ROWS }} scrollY={true}>
              {formatApprovalRows(selectedBranch.approval ?? {}).map((row, index) => (
                <text key={`batch-approval-${index}`}>
                  <span style={{ fg: "#8b949e" }}>{row.label + ": "}</span>
                  <span style={{ fg: APPROVAL_TONE_FG[row.tone] }}>{row.value}</span>
                </text>
              ))}
            </scrollbox>
          ) : (
            <box style={{ flexDirection: "column", height: BATCH_OVERLAY_ROWS, overflow: "hidden" }}>
              {visibleBranches.map((branch, offset) => {
                const index = windowStart + offset
                const decision = batchReview.decisions[branch.id] ?? "approve"
                return (
                  <text key={branch.id} style={{ fg: decision === "approve" ? "#3fb950" : "#f85149" }}>
                    {bounded(`${index === batchReview.selected ? "▶ " : "  "}${formatBatchBranchLine(branch, decision)}`, lineWidth)}
                  </text>
                )
              })}
            </box>
          )}
        </box>
      </box>
    )
  }

  if (mode === "chat" && !showHelp && !detail) {
    // specs/069-tui-dashboard-parity-workspace/spec.md — Phase 2: Chat is
    // now the shell's centre tab, exactly like Tasks/Agents (renderShell),
    // with the left rail's own conversation list — already driven by the
    // same chatConversationId this view reads — visible for the first
    // time instead of being hidden behind a full-screen view. Content and
    // every keybinding are unchanged; only the wrapper, and where the
    // composer/hint live, are restructured to fit the shell's fixed,
    // single-row footer convention (see computeShellChatScrollHeight's own
    // comment for why the composer moved INSIDE the centre panel's own
    // budget instead of growing the footer).
    const tierColor = (turn: ChatTurn): string => {
      if (turn.tier === 0) return "#3fb950"
      if (turn.tier === 2) return "#58a6ff"
      return "#d29922"
    }
    const threadIndex = chatConversationId
      ? chatConversations.findIndex((conversation) => conversation.id === chatConversationId)
      : -1
    const threadPosition = threadIndex >= 0 ? `${threadIndex + 1}/${chatConversations.length}` : `0/${chatConversations.length}`

    const chatCenter = (
      <box style={{ flexDirection: "column", overflow: "hidden" }}>
        <text style={{ fg: "#58a6ff" }}>
          {bounded(`Chat — thread ${threadPosition} · ←/→ browse · n new`, Math.max(10, shell.centerWidth - 2))}
        </text>
        <scrollbox
          ref={chatScrollRef}
          focused={!chatInputMode}
          scrollY={true}
          stickyScroll={chatFollow}
          stickyStart="bottom"
          contentOptions={{ flexDirection: "column" }}
          style={{ border: true, padding: 1, height: computeShellChatScrollHeight({ height, chatInputMode, hasNewUpdatesBanner: chatNewUpdates }) }}
        >
          {chatEvicted ? (
            <box style={{ flexDirection: "column" }}>
              <text style={{ fg: "#da3633" }}>This conversation is no longer available.</text>
              <text style={{ fg: "#9ca3af" }}>Press c to start a new thread, or [ / ] to choose an available one.</text>
            </box>
          ) : chatTurns.length === 0 ? (
            // specs/130 phase 4 — the dashboard's examples and quick tasks,
            // as text to type (display only). Inside the chat scrollbox, so
            // a short terminal scrolls instead of overflowing.
            <box style={{ flexDirection: "column" }}>
              <text style={{ fg: "#9ca3af" }}>Ask a question or request work — press n or Enter to type. For example:</text>
              {CHAT_EXAMPLE_PROMPTS.map((prompt) => (
                <text key={prompt} style={{ fg: "#58a6ff" }}>{bounded(`  “${prompt}”`, Math.max(10, shell.centerWidth - 6))}</text>
              ))}
              <text style={{ fg: "#9ca3af" }}>Quick tasks:</text>
              {CHAT_QUICK_TASKS.map((prompt) => (
                <text key={prompt} style={{ fg: "#6e7681" }}>{bounded(`  “${prompt}”`, Math.max(10, shell.centerWidth - 6))}</text>
              ))}
            </box>
          ) : (
            chatTurns.map((turn, index) => {
              const linkedRoot = turn.taskId ? taskById.get(turn.taskId) : undefined
              const isLastLink = Boolean(turn.taskId) && !chatTurns.slice(index + 1).some((later) => later.taskId === turn.taskId)
              // findWaitingPlanChild() internally guards `!task.isPlan`, so
              // calling it unconditionally on linkedRoot is safe — a direct
              // (non-plan) task falls through to displayedTask = linkedRoot
              // below exactly as before. specs/046 Amendment 1's own
              // load-bearing property: a plan's card must show its real
              // waiting CHILD, never the plan root itself.
              const waitingChild = linkedRoot ? findWaitingPlanChild(linkedRoot, taskById) as TaskRow | null : null
              const displayedTask = waitingChild ?? linkedRoot

              // specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md
              // — collapsed by default: a turn with a real `summary`
              // (only ever set for a synthesized "state"/"failure"
              // answer, never "conversation") shows just that unless
              // it's the LAST assistant turn and has been expanded via
              // `d`. `text` itself is never mutated — this is a display
              // choice only, the full value is always what's stored.
              const isLastAssistantTurn = turn.role === "assistant" && index === chatTurns.length - 1
              const chatDisplay = resolveChatTurnDisplay(turn, isLastAssistantTurn, chatLastTurnExpanded)

              return (
                <box key={turn.id} style={{ flexDirection: "column", marginBottom: 1 }}>
                  <text>
                    <span style={{ fg: turn.role === "user" ? "#c9d1d9" : tierColor(turn) }}>
                      {turn.role === "user" ? "you" : "orch"}
                    </span>
                    <span style={{ fg: "#8b949e" }}> {chatTierLabel(turn)}</span>
                    {/* specs/130 phase 4 — skill and time, as the dashboard shows them */}
                    <span style={{ fg: "#6e7681" }}>
                      {[turn.skill, formatClockTime(turn.timestamp)].filter(Boolean).join(" · ")}
                    </span>
                  </text>
                  <text>{chatDisplay.text}</text>
                  {isLastAssistantTurn && chatDisplay.hasCollapsedContent ? (
                    <text style={{ fg: "#6e7681" }}>{chatDisplay.showingFull ? "d to collapse" : "more detail — d for full report"}</text>
                  ) : null}
                  {isLastLink && displayedTask ? (
                    // This card's box previously had no `overflow: "hidden"`
                    // and its status/target lines were unbounded — the same
                    // gap this file's header/rail rows already learned not
                    // to leave (see renderHeader() above): a long agent/
                    // skill/target string wraps onto the row below instead
                    // of clipping, corrupting the card. specs/130: bounded to
                    // centerWidth - 8 — the centre panel's own border(2) +
                    // padding(2), plus this card's border(2) + paddingX(2).
                    // The old - 4 counted only the card, so long lines wrapped.
                    <box style={{ flexDirection: "column", border: true, paddingX: 1, overflow: "hidden" }}>
                      <text style={{ fg: displayedTask.status === "input-required" ? "#d29922" : statusColor(displayedTask.status) }}>
                        {bounded(
                          `${displayedTask.status === "input-required" ? "⏸" : displayedTask.status === "completed" ? "✓" : displayedTask.status === "failed" ? "✗" : "⋯"} ${displayedTask.assignedAgent ?? "orchestrator"} · ${displayedTask.skill ?? turn.skill ?? "task"} · ${displayedTask.status}${displayedTask.status === "input-required" ? " — approval required" : ""}`,
                          Math.max(10, shell.centerWidth - 8),
                        )}
                      </text>
                      {/* specs/115-tui-navigation-redraw-and-answer-clarity/spec.md
                          — a still-`input-required` task shows its live
                          target/action (genuinely new information, not
                          in turn.text yet). A TERMINAL task (completed/
                          failed) used to also show its own result/error
                          here — the exact same content turn.text already
                          carries in full (specs/044's own synthesized-
                          plus-raw design), making this the redundant
                          THIRD copy Yusuf reported. Dropped: nothing is
                          lost, turn.text above still has it. */}
                      {displayedTask.status === "input-required" ? (
                        <text>
                          {bounded(
                            `target: ${displayedTask.approval?.target ?? "see full preview"} · action: ${displayedTask.approval?.summary ?? displayedTask.approval?.toolName ?? displayedTask.skill ?? "write"}`,
                            Math.max(10, shell.centerWidth - 8),
                          )}
                        </text>
                      ) : null}
                      {/* specs/130 — the specs/097 reminder, on the card too
                          (not only in details), for a plan step waiting on
                          approval. One bounded line. */}
                      {displayedTask.status === "input-required" && displayedTask.parentTaskId ? (
                        <text style={{ fg: "#6e7681" }}>
                          {bounded("the step description is planning-time intent, not a promise — review the action before approving", Math.max(10, shell.centerWidth - 8))}
                        </text>
                      ) : null}
                      <text style={{ fg: "#58a6ff" }}>
                        {bounded(
                          displayedTask.status !== "input-required"
                            ? "[2] open Tasks"
                            : displayedTask.parentTaskId && countWaitingPlanChildren(displayedTask.parentTaskId, tasks) >= 2
                              // specs/130 phase 3 — several steps of one plan wait at once
                              ? "Grouped batch waiting — press g to review · [a] one at a time · [2] Tasks"
                              : "[a] review & decide · [2] open Tasks",
                          Math.max(10, shell.centerWidth - 8),
                        )}
                      </text>
                    </box>
                  ) : null}
                </box>
              )
            })
          )}
          {chatPending ? <text style={{ fg: "#d29922" }}>… {chatPending}</text> : null}
        </scrollbox>
        {chatNewUpdates ? <text style={{ fg: "#d29922" }}>[new updates — End to follow]</text> : null}
        {chatInputMode ? (
          // specs/069 Phase 2 correction, live-caught by Yusuf: without an
          // EXPLICIT height here, this box's natural size (border(2)+
          // padding(2)+label(1)+input(1)=6) is what computeShellChatScrollHeight()
          // already assumed when shrinking the scrollbox above by exactly
          // that amount — but relying on natural sizing inside a container
          // whose OWN height is itself computed/budget-constrained hit the
          // exact overflow class specs/047 Phase 2 already found:
          // `overflow:"hidden"` alone does not reliably clip excess here, it
          // overwrites — the label and input rows rendered on the SAME
          // terminal row instead of two separate ones. An explicit height
          // matching the budget's own assumption removes the ambiguity
          // entirely, the same "compute a real number, never let sizing be
          // implicit" discipline this file uses everywhere else.
          <box style={{ border: true, padding: 1, flexDirection: "column", overflow: "hidden", height: 6 }}>
            <text style={{ fg: "#d29922" }}>Ask — Enter to send, Esc to cancel:</text>
            <input
              focused={chatInputMode}
              value={chatInputValue}
              onChange={setChatInputValue}
              // Same @opentui/react onSubmit type-declaration artifact the
              // new-task box documents below — the runtime always calls
              // this with the plain string value.
              onSubmit={
                ((value: string) => {
                  submitAsk(value)
                  setChatInputMode(false)
                  setChatInputValue("")
                }) as any
              }
            />
          </box>
        ) : null}
      </box>
    )

    // specs/069 Phase 2 — the shell's footer is always exactly one row
    // (matching Tasks/Agents), so this hint is now shown unconditionally,
    // including while the composer is open above it — a strict addition
    // over the old full-screen behavior, which hid it entirely then.
    const chatFooter = (
      <text style={{ fg: "#9ca3af" }}>
        {bounded(
          statusMessage ?? chatThreadHint ?? `${chatConversationId ? `thread ${threadPosition} · ${chatConversationId}` : "no thread yet"} · ←/→ browse · Enter open/type · c new · 1/2/3/4 modes`,
          Math.max(10, width - 2),
        )}
      </text>
    )

    return renderShell(chatCenter, chatFooter)
  }

  if (showHelp) {
    return (
      <box key="view-help" style={{ flexDirection: "column", padding: 1 }}>
        <text style={{ fg: "#58a6ff" }}>OrchestrAI — Terminal Viewer <span style={{ fg: "#9ca3af" }}>(press ? for help)</span></text>
        <text> </text>
        <box style={{ border: true, padding: 1, flexDirection: "column", overflow: "hidden" }}>
          {/* specs/130 — no blank spacer here: its row went to the `g` line.
              At 80×24 this box holds exactly 16 rows of ~74 characters;
              a longer line wraps and the overflow overwrites other rows. */}
          <text style={{ fg: "#58a6ff" }}>Help — keyboard reference (? , Enter, or Esc to close)</text>
          <text><span style={{ fg: "#d29922" }}>1/2/3/4</span>    Chat / Tasks / Agents / Audit</text>
          <text><span style={{ fg: "#d29922" }}>Tab / S-Tab</span> next / previous mode (outside inputs and overlays)</text>
          <text><span style={{ fg: "#d29922" }}>↑ / ↓</span>      select; Tasks pauses/resumes newest-row following</text>
          <text><span style={{ fg: "#d29922" }}>Enter</span>      open details; in Chat, open the cursor's thread or the composer</text>
          <text><span style={{ fg: "#d29922" }}>a / r / s (x2)</span> approve/reject/skip (s: plan steps); also in Details</text>
          <text><span style={{ fg: "#d29922" }}>g</span>          grouped review of a plan's parallel writes (Chat or Tasks)</text>
          <text><span style={{ fg: "#d29922" }}>v · d</span>      raw approval preview (Task details) · full Chat answer</text>
          <text><span style={{ fg: "#d29922" }}>f · t</span>      Agent → Tasks filter · t: Tasks status / Audit by task</text>
          <text><span style={{ fg: "#d29922" }}>[ / ] · ← / →</span> jump / browse Chat threads</text>
          <text><span style={{ fg: "#d29922" }}>c / h</span>      new Chat thread · clear/undo Tasks · hide/show finished</text>
          <text><span style={{ fg: "#d29922" }}>n</span>          new Task; in Chat, open the composer</text>
          <text><span style={{ fg: "#d29922" }}>Esc</span>        cancel input, close overlay, or clear active filter</text>
          <text><span style={{ fg: "#d29922" }}>? / Ctrl+C</span> help / exit</text>
          {/* Replaces the old blank separator line — same row count, real
              info instead. Mouse tracking is on (needed for scroll/click),
              which is what stops a plain click-drag from doing native
              terminal text selection in most terminal emulators. */}
          <text style={{ fg: "#6e7681" }}>Copy: hold Shift while selecting — mouse tracking is on</text>
          <text>Rows: ≡ plan · ↳ child · → TUI direct · ⇄ A2A · ◆ agent dashboard</text>
        </box>
      </box>
    )
  }

  if (mode === "agents") {
    // specs/069 Phase 1 — the Agents content now sits in the shell's centre
    // column (fixed `shell.centerWidth`) with the conversations rail on the
    // left and the status rail on the right. Content itself is unchanged;
    // the only edit is the skills column bounding to `shell.centerWidth`
    // (which already excludes root padding) instead of raw `width`.
    // specs/115-tui-navigation-redraw-and-answer-clarity/spec.md — same
    // fix as tasksCenter above, same reason: previously no explicit
    // height on either Agents box variant.
    const agentsCenter = agentDetail ? (
      <box style={{ border: true, padding: 1, flexDirection: "column", overflow: "hidden", height: shellRegionHeight }}>
        <text style={{ fg: "#58a6ff" }}>Agent — {agentDetail.name} (Enter or Esc to close)</text>
        <text>Status: <span style={{ fg: statusColor(agentDetail.status) }}>{agentDetail.status}</span></text>
        <text>URL: {agentDetail.url}</text>
        {/* specs/130 phase 4 — one row: live last-seen (from the current
            poll, not the snapshot taken when details opened) and how many
            Orchestrator tasks it has been assigned. */}
        <text style={{ fg: "#9ca3af" }}>
          {bounded(
            (() => {
              // specs/136 — the Orchestrator's health check refreshes
              // lastSeen on every 10-second tick, so it is live.
              const live = agents.find((agent) => agent.name === agentDetail.name) ?? agentDetail
              const relative = formatRelativeTime(live.lastSeen, Date.now())
              const seen = relative === "" ? "unknown" : relative === "now" ? "just now" : `${relative} ago`
              return `Last seen: ${seen} · Tasks: ${taskCountsByAgent[agentDetail.name] ?? 0}`
            })(),
            Math.max(10, shell.centerWidth - 4),
          )}
        </text>
        <text>Skills:</text>
        {agentDetail.skills.map((skill) => (
          <text key={skill} style={{ fg: "#9ca3af" }}>  · {skill}</text>
        ))}
      </box>
    ) : (
      <box style={{ border: true, padding: 1, flexDirection: "column", overflow: "hidden", height: shellRegionHeight }}>
        <text style={{ fg: "#58a6ff" }}>Agents ({agents.length}) — ↑/↓ select · Enter details · f filter Tasks</text>
        {agents.length === 0 ? (
          <text style={{ fg: "#9ca3af" }}>(none discovered yet)</text>
        ) : (
          agents.map((agent, index) => (
            <text key={agent.name} style={{ bg: index === clampedAgentIndex ? "#21262d" : undefined }}>
              {index === clampedAgentIndex ? "▶ " : "  "}
              <span style={{ fg: statusColor(agent.status) }}>{agent.status === "online" ? "●" : "○"}</span>
              {" " + agent.name.padEnd(20)}
              <span style={{ fg: agentFilter === agent.name ? "#d29922" : "#9ca3af" }}>
                {agentFilter === agent.name ? "[filtered] " : ""}
                {bounded(agent.skills.join(", "), Math.max(12, shell.centerWidth - 30))}
              </span>
            </text>
          ))
        )}
      </box>
    )
    const agentsFooter = (
      <text style={{ fg: "#9ca3af" }}>
        {bounded(statusMessage ?? "? help · Tab modes · ↑/↓ select · Enter details · f filter Tasks", Math.max(10, width - 2))}
      </text>
    )
    return renderShell(agentsCenter, agentsFooter)
  }

  if (mode === "audit") {
    // specs/108-durable-audit-trail/spec.md B7 — mirrors the Agents mode's
    // own render shape immediately above (bordered box + title line +
    // list), through the same renderShell() every other top-level mode
    // uses. The scrollbox reuses computeShellChatScrollHeight() verbatim
    // (chatInputMode/hasNewUpdatesBanner both false) rather than a new,
    // separately-derived height formula — this file's own established
    // "reuse a proven arithmetic path, don't re-derive one" discipline
    // for exactly this class of bug (terminal-row-overflow, 16+ rounds of
    // history under specs/012/047/069).
    // specs/130 phase 4 — live SSE rows arrive unfiltered; keep only the
    // filtered task's while `t` is on.
    const shownAuditEvents = auditTaskFilter
      ? auditEvents.filter((event) => auditRowMatchesTask(event.taskId, auditTaskFilter))
      : auditEvents
    const auditCenter = (
      <box style={{ flexDirection: "column", overflow: "hidden" }}>
        <text style={{ fg: "#58a6ff" }}>
          {bounded(
            `Audit (${shownAuditEvents.length})${auditTaskFilter ? ` — task ${shortTaskId(auditTaskFilter)} · t all` : " — t selected task"} · r reload`,
            Math.max(10, shell.centerWidth - 2),
          )}
        </text>
        <scrollbox
          focused={true}
          scrollY={true}
          contentOptions={{ flexDirection: "column" }}
          style={{ border: true, padding: 1, height: computeShellChatScrollHeight({ height, chatInputMode: false, hasNewUpdatesBanner: false }) }}
        >
          {auditLoading ? (
            <text style={{ fg: "#9ca3af" }}>Loading…</text>
          ) : !auditLoadedOnce ? (
            <text style={{ fg: "#9ca3af" }}>Not loaded yet — press r to load.</text>
          ) : auditLoadFailed ? (
            <text style={{ fg: "#da3633" }}>Could not load — see status line below. Press r to retry.</text>
          ) : shownAuditEvents.length === 0 ? (
            <text style={{ fg: "#9ca3af" }}>{auditTaskFilter ? `No audit events recorded for ${auditTaskFilter}.` : "No audit events recorded."}</text>
          ) : (
            shownAuditEvents.map((event) => {
              const badge = auditKindBadge(event.kind)
              // specs/115-tui-navigation-redraw-and-answer-clarity/spec.md
              // — "more declarative": kind badge + caller → target on one
              // line, matching this file's own Tasks-pane row density,
              // instead of burying caller/target relationship in a
              // trailing, easy-to-miss suffix.
              // specs/139 C — the whole row fits one line: fitAuditRow()
              // gives caller and target what the fixed parts leave. The
              // scrollbox's border, padding and scrollbar cost 5 columns.
              const time = new Date(event.ts).toLocaleTimeString()
              const trunc = event.resultTruncated ? " trunc" : ""
              const tail = ` · ${event.outcome} · ${event.durationMs}ms · ${formatBytes(event.resultBytes)}${trunc}`
              const compactTail = ` · ${event.durationMs}ms · ${formatBytes(event.resultBytes)}${trunc}`
              const fitted = fitAuditRow({ available: shell.centerWidth - 5, time, badge: badge.text, caller: event.caller, target: event.target, tail, compactTail })
              const tailMain = fitted.tail.endsWith(" trunc") ? fitted.tail.slice(0, -" trunc".length) : fitted.tail
              return (
                <text key={event.id}>
                  <span style={{ fg: event.outcome === "completed" ? "#3fb950" : "#f85149" }}>
                    {event.outcome === "completed" ? "✓" : "✗"}
                  </span>
                  {" " + time}
                  <span style={{ fg: badge.fg }}>{" " + badge.text}</span>
                  <span style={{ fg: "#9ca3af" }}>{" " + fitted.caller}</span>
                  <span style={{ fg: "#6e7681" }}>{" → "}</span>
                  <span style={{ fg: "#d29922" }}>{fitted.target}</span>
                  <span style={{ fg: "#6e7681" }}>{tailMain}</span>
                  {fitted.tail.endsWith(" trunc") ? <span style={{ fg: "#d29922" }}>{" trunc"}</span> : null}
                </text>
              )
            })
          )}
        </scrollbox>
      </box>
    )
    const auditFooter = (
      <text style={{ fg: "#9ca3af" }}>
        {bounded(statusMessage ?? "? help · Tab modes · r reload", Math.max(10, width - 2))}
      </text>
    )
    return renderShell(auditCenter, auditFooter)
  }

  // Details and the composer replace the Tasks list rather than stacking
  // below it. This is what keeps the 80x24 layout bounded with a full list.
  if (detail) {
    const detailPlanRows = formatPlanStepRows(detail.planSteps)
    return (
      <box key="view-detail" style={{ flexDirection: "column", padding: 1 }}>
        {renderHeader()}
        <text> </text>
        <box style={{ border: true, padding: 1, flexDirection: "column", overflow: "hidden" }}>
          <text style={{ fg: "#58a6ff" }}>Details — {detail.id} (↑/↓/PgUp/PgDn scroll{detail.approval ? ", v raw JSON" : ""}{detail.status === "input-required" ? `, a/r${detail.parentTaskId ? "/s" : ""} confirm` : ""}, Enter or Esc to close)</text>
          <scrollbox focused={true} style={{ height: 12 }} scrollY={true}>
            <text>Status: <span style={{ fg: statusColor(detail.status) }}>{detail.status}</span></text>
            {detail.text ? <text>Text: {detail.text}</text> : null}
            {Object.values(toolCalls[detail.id] ?? {}).length > 0 ? <text style={{ fg: "#8b949e" }}> </text> : null}
            {Object.values(toolCalls[detail.id] ?? {}).map((call) => (
              <text key={call.id}>
                <span style={{ fg: call.outcome === undefined ? "#58a6ff" : call.outcome === "completed" ? "#3fb950" : "#f85149" }}>
                  {call.outcome === undefined ? "⋯" : call.outcome === "completed" ? "✓" : "✗"}
                </span>
                {call.caller ? <span style={{ fg: "#6e7681" }}>{" " + call.caller + " →"}</span> : null}
                <span style={{ fg: "#d29922" }}>{" " + call.name}</span>
                {call.durationMs !== undefined ? <span style={{ fg: "#6e7681" }}>{` · ${call.durationMs}ms`}</span> : null}
              </text>
            ))}
            {/* specs/130 phase 2 — the plan as GET /tasks/:id reports it,
                so a plan started before the TUI opened shows every step.
                The live STEP_* rows below are only the fallback. */}
            {detailPlanRows.length > 0 ? <text style={{ fg: "#8b949e" }}>Plan steps:</text> : null}
            {detailPlanRows.map((step) => (
              <text key={step.key}>
                <span style={{ fg: PLAN_STEP_STATUS_FG[step.status] }}>{PLAN_STEP_STATUS_GLYPH[step.status]}</span>
                <span style={{ fg: "#d29922" }}>{" " + step.text}</span>
              </text>
            ))}
            {detailPlanRows.length === 0 && Object.values(planSteps[detail.id] ?? {}).length > 0 ? <text style={{ fg: "#8b949e" }}>Plan steps:</text> : null}
            {(detailPlanRows.length > 0 ? [] : Object.values(planSteps[detail.id] ?? {})).map((step) => (
              <text key={step.key}>
                <span style={{ fg: step.outcome === "running" ? "#58a6ff" : step.outcome === "completed" ? "#3fb950" : "#f85149" }}>
                  {step.outcome === "running" ? "⋯" : step.outcome === "completed" ? "✓" : "✗"}
                </span>
                <span style={{ fg: "#d29922" }}>{" " + step.name}</span>
              </text>
            ))}
            {/* specs/097-chat-answer-and-plan-description-honesty/spec.md
                — a plan step's own description above is the supervisor's
                planning-time reasoning, not a promise of the exact action;
                the approval preview below is what to actually review.
                Only shown for a plan step's own child task (parentTaskId
                set) that actually has an approval to review. */}
            {detail.approval && detail.parentTaskId
              ? <text style={{ fg: "#6e7681" }}>Note: the Text above is planning-time intent, not a promise — review the action below before approving.</text>
              : null}
            {detail.approval && !rawApproval ? <text style={{ fg: "#8b949e" }}>Approval preview — press v for raw JSON</text> : null}
            {detail.approval && !rawApproval
              ? formatApprovalRows(detail.approval).map((row, index) => (
                  <text key={`approval-${index}`}>
                    <span style={{ fg: "#8b949e" }}>{row.label + ": "}</span>
                    <span style={{ fg: APPROVAL_TONE_FG[row.tone] }}>{row.value}</span>
                  </text>
                ))
              : null}
            {detail.approval && rawApproval ? <text style={{ fg: "#d29922" }}>{JSON.stringify(detail.approval, null, 2)}</text> : null}
            {detail.result ? <text style={{ fg: "#3fb950" }}>{detail.result}</text> : null}
            {detail.error ? <text style={{ fg: "#f85149" }}>{detail.error}</text> : null}
          </scrollbox>
          {confirmHint ? <text style={{ fg: "#d29922" }}>{confirmHint}</text> : null}
        </box>
      </box>
    )
  }

  if (inputMode) {
    return (
      <box key="view-input" style={{ flexDirection: "column", padding: 1 }}>
        {renderHeader()}
        <text> </text>
        <box style={{ border: true, padding: 1, flexDirection: "column", overflow: "hidden" }}>
          <text style={{ fg: "#d29922" }}>
            New task → {agentFilter ? `${agentFilter} (direct)` : "Orchestrator"} · Enter submit · Esc cancel
          </text>
          <input
            focused={true}
            value={inputValue}
            onChange={setInputValue}
            onSubmit={
              ((value: string) => {
                submitTask(value)
                setInputMode(false)
                setInputValue("")
              }) as any
            }
          />
        </box>
      </box>
    )
  }

  // specs/069-tui-dashboard-parity-workspace/spec.md — Phase 1: the Tasks
  // list is the shell's centre column now, flanked by the conversations
  // rail and the status rail. The list content, the row-budget math
  // (computeTaskWindow — its reservedRows still matches the unchanged
  // header/footer chrome exactly), and every keybinding are untouched; the
  // one edit is the per-row text bound, from raw `width - HORIZONTAL_CHROME`
  // to `shell.centerWidth - 4` (border 2 + padding 2 — `shell.centerWidth`
  // already excludes the root padding, so at the 80x24 minimum the two
  // expressions are equal, `width - 6 == (width - 2) - 4`).
  // specs/115-tui-navigation-redraw-and-answer-clarity/spec.md — Yusuf's
  // own real diagnostic lead for the Tab-cycle redraw bug: "the box in
  // task and agent dimension or something is different from the chat
  // and logs one." Confirmed by direct code read — this box (and
  // Agents' own, below) previously had NO explicit height at all,
  // sizing itself naturally to its content, while Chat/Audit's own
  // scrollbox and both rails all use an EXPLICIT height
  // (shellRegionHeight/computeShellChatScrollHeight). Cycling from a
  // taller explicit box to a shorter naturally-sized one is exactly the
  // "leftover rows from a taller previous frame never get cleared"
  // class of bug this file has hit repeatedly (specs/047/069's own
  // documented lesson: relying on natural sizing inside a
  // budget-constrained container). Pinned to the exact same
  // shellRegionHeight the rails already use, closing the asymmetry.
  const tasksCenter = (
    <box style={{ border: true, padding: 1, flexDirection: "column", overflow: "hidden", height: shellRegionHeight }}>
        <text style={{ fg: "#58a6ff" }}>
          Tasks{agentFilter ? ` — filtered: ${agentFilter}` : ` — all, last ${TUI_TASK_FETCH_LIMIT}`} · Enter details · a/r/s×2 decide
          {statusFilter !== "all" ? <span style={{ fg: "#d29922" }}> [status: {statusFilter} — t]</span> : null}
          {hideDone ? <span style={{ fg: "#d29922" }}> [hiding done]</span> : null}
          {dismissedIds.size > 0 ? <span style={{ fg: "#d29922" }}> [{dismissedIds.size} cleared]</span> : null}
          {!followLatestTask ? <span style={{ fg: "#d29922" }}> [paused — ↓ to resume]</span> : null}
          {hiddenAbove > 0 ? ` · ↑ ${hiddenAbove} more` : ""}
          {hiddenBelow > 0 ? ` · ↓ ${hiddenBelow} more` : ""}
        </text>
        {agentFilter ? (
          <text style={{ fg: "#8b949e" }}>
            ≡ plan · ↳ child · → TUI direct · ⇄ agent-to-agent · ◆ agent dashboard
          </text>
        ) : null}
        {visibleTasks.length === 0 ? (
          <text style={{ fg: "#9ca3af" }}>
            {afterDismissed.length === 0 && mergedTasks.length > 0
              ? "(view cleared — press c to undo, or wait for new tasks)"
              : afterDismissed.length > 0
                ? "(all remaining tasks hidden — press h to show completed/failed)"
                : agentFilter
                  ? `(no tasks for ${agentFilter} yet)`
                  : "(no tasks yet)"}
          </text>
        ) : (
          renderedTasks.map((t, i) => {
            // specs/130 — every marker must be one terminal cell wide; the old
            // 📋 was two, which shifted the row and left junk in the next view.
            const prefix = t.isPlan ? "≡ " : t.parentTaskId ? "↳ " : t.direct ? originMarker(t.id) : "  "
            const AGENT_COL = 14
            const STATUS_COL = 15 // "input-required" is the longest status string, 15 chars
            const fixedWidth = 2 + prefix.length + AGENT_COL + STATUS_COL
            // HORIZONTAL_CHROME (see above) replaces the old flat "-4" fudge
            // factor, which under-counted the outer box's own padding and
            // let long rows wrap instead of truncate.
            // specs/021-ag-ui-event-protocol/spec.md — live tool-call activity,
            // rendered as a compact inline badge rather than extra rows.
            // Deliberate: extra rows would have to be fed into the
            // reservedRows/maxTaskRows budget that the sixth-through-
            // thirteenth extension rounds fought real overflow bugs to get
            // right. An inline badge is width-bounded (already truncated
            // below) and costs zero rows, so it cannot reintroduce that
            // class of bug. The full per-call list lives in the Detail view,
            // which is already a fixed-height scrollbox.
            const calls = Object.values(toolCalls[t.id] ?? {})
            const running = calls.filter((c) => c.outcome === undefined).length
            const steps = Object.values(planSteps[t.id] ?? {})
            const activeSteps = steps.filter((step) => step.outcome === "running")
            const toolBadge = calls.length === 0 ? "" : running > 0 ? ` ⚙${running}` : ` ⚙${calls.length}`
            const stepBadge = activeSteps.length > 0 ? ` ▸${activeSteps.length}` : ""
            const badge = `${stepBadge}${toolBadge}`
            const badgeColor = activeSteps.length > 0 || running > 0 ? "#58a6ff" : "#6e7681"

            const textWidth = Math.max(6, shell.centerWidth - fixedWidth - 4 - badge.length)
            // specs/130 phase 4 — `chat · ` and `child of <id> · `, as the
            // dashboard's table labels them; specs/136 — the chat marker
            // comes from the server's conversationId on every task.
            const rowText = formatTaskRowText(t, Boolean(t.conversationId))
            const truncated = rowText.length > textWidth
            const shownText = truncated ? rowText.slice(0, Math.max(0, textWidth - 1)) + "…" : rowText
            const realIndex = taskWindowStart + i
            const isSelected = realIndex === clampedTaskIndex
            return (
              <text key={t.id} style={{ bg: isSelected ? "#21262d" : undefined }}>
                {isSelected ? "▶ " : "  "}
                {prefix}
                {(t.assignedAgent ?? "-").slice(0, AGENT_COL - 1).padEnd(AGENT_COL)}
                <span style={{ fg: statusColor(t.status) }}>{t.status.padEnd(STATUS_COL)}</span>
                <span style={{ fg: "#9ca3af" }}>{shownText}</span>
                {badge ? <span style={{ fg: badgeColor }}>{badge}</span> : null}
              </text>
            )
          })
        )}
    </box>
  )

  const tasksFooter = (
    <text style={{ fg: confirmHint ? "#d29922" : "#9ca3af" }}>
      {bounded(
        confirmHint ??
          statusMessage ??
          (agentFilter
            ? `Filtered to ${agentFilter} — Esc to clear · ? help`
            : "? help · Tab modes · ↑/↓ select · Enter details · a/r/s×2 decide · n new"),
        Math.max(10, width - 2),
      )}
    </text>
  )

  return renderShell(tasksCenter, tasksFooter)
}

// Exported + guarded (specs/017-standalone-binary-distribution/spec.md) so a
// combined binary can import this module and start it on demand without it
// auto-starting merely by being imported. `bun run apps/tui/index.tsx` is
// unaffected — import.meta.main is still true for that exact invocation,
// same as before this change.
export async function start(): Promise<void> {
  const renderer = await createCliRenderer()
  createRoot(renderer).render(<App />)
}

if (import.meta.main) {
  await start()
}
