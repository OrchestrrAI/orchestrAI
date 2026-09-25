// specs/047-tui-conversation-operations-navigation/spec.md — Phase 1.
// Pure, dependency-free state/logic helpers extracted from apps/tui/index.tsx
// so the risk-bearing pieces (row-budget math, key-ownership precedence,
// task filtering/merging, follow-latest semantics, approval double-press,
// and the new plan-child resolver) have deterministic tests BEFORE any
// layout change lands in Phase 2 — the plan's own exit gate for Phase 1.
//
// No @opentui/core, @opentui/react, or React import here, on purpose:
// everything in this file must be testable with `bun:test` alone, no
// renderer, no terminal. apps/tui/index.tsx imports these and is expected
// to behave byte-identically to before this file existed — this is a pure
// extraction, not a redesign. Every function below was cross-checked
// line-by-line against the real component logic it replaces.
//
// specs/099-tui-port-url-and-analyze-project-stack-awareness/spec.md —
// resolveOrchestratorUrl() below pulls in packages/shared/service-ports,
// the one import in this file — itself equally dependency-free (env
// vars only, no filesystem/renderer access), so the "testable with
// bun:test alone" property above still holds.
import { resolveServicePort } from "../../packages/shared/service-ports"

// ============================================================
// Shared task shape
// ============================================================

// Mirrors apps/tui/index.tsx's own TaskRow, plus `childTaskIds` — already
// present on the server's real task objects (apps/orchestrator/index.ts:72,
// "set on parent plan tasks") and already arriving on the exact GET /tasks
// response the TUI already polls (that poll casts the raw server JSON
// directly to `TaskRow[]`, so no mapping code needs to change for this
// field to start flowing through — only the type declaration was missing).
export interface TaskRowLike {
  id: string
  text: string
  assignedAgent?: string
  status: string
  isPlan?: boolean
  parentTaskId?: string
  direct?: boolean
  childTaskIds?: string[]
  // specs/136 — the conversation that dispatched it (GET /tasks), or null.
  conversationId?: string | null
}

// ============================================================
// Task merging/filtering pipeline
// ("filtering" + part of "tasks" in Phase 1's own test list)
// ============================================================

/** Verbatim extraction of index.tsx's own mergeTasksById — first list wins
 *  a given id, later lists only fill in ids not already seen. */
export function mergeTasksById<T extends { id: string }>(lists: T[][]): T[] {
  const seen = new Map<string, T>()
  for (const list of lists) {
    for (const t of list) {
      if (!seen.has(t.id)) seen.set(t.id, t)
    }
  }
  return Array.from(seen.values())
}

export interface DirectTaskLike {
  id: string
  agentName: string
  status: string
  text: string
}

/** The Orchestrator dispatches a task to its owning agent under a
 *  DIFFERENT id than its own (`orch-${taskId}`) — strip that prefix back
 *  off so the Orchestrator's own record and that agent's own remote list
 *  agree on one id, and mark it not-direct. Verbatim extraction. */
export function normalizeRemoteTasks(remoteAgentTasks: TaskRowLike[]): TaskRowLike[] {
  return remoteAgentTasks.map((t) =>
    t.id.startsWith("orch-") ? { ...t, id: t.id.slice("orch-".length), direct: false } : t,
  )
}

export interface VisibleTasksInput {
  tasks: TaskRowLike[]
  directTasks: DirectTaskLike[]
  remoteAgentTasks: TaskRowLike[]
  agentFilter: string | null
  dismissedIds: Set<string>
  hideDone: boolean
  // specs/130 phase 4 — the Tasks status-filter cycle; absent means "all".
  statusFilter?: TaskStatusFilter
}

/** specs/130 — the header's approvals count. Deliberately ignores every
 *  view filter (agent filter, `c` dismissals, `h` hide-done): a header
 *  reading 0 while something is waiting would hide it. Same precedence as
 *  the filtered merge, so one id is counted once. */
export function countWaitingApprovals(input: Pick<VisibleTasksInput, "tasks" | "directTasks" | "remoteAgentTasks">): number {
  const direct: TaskRowLike[] = input.directTasks.map((d) => ({ id: d.id, text: d.text, assignedAgent: d.agentName, status: d.status, direct: true }))
  const all = mergeTasksById([input.tasks, normalizeRemoteTasks(input.remoteAgentTasks), direct])
  return all.filter((t) => t.status === "input-required").length
}

export interface VisibleTasksResult {
  mergedTasks: TaskRowLike[]
  afterDismissed: TaskRowLike[]
  visibleTasks: TaskRowLike[]
}

/** Verbatim extraction of the merge/dismiss/hide-done pipeline that used to
 *  live as five separate inline `const`s in the component body. Same
 *  precedence: filtered → Orchestrator record wins, then that agent's own
 *  remote list, then this session's own direct submissions; unfiltered →
 *  this session's direct submissions, then every Orchestrator task. */
export function computeVisibleTasks(input: VisibleTasksInput): VisibleTasksResult {
  const directTaskRows: TaskRowLike[] = input.directTasks.map((d) => ({
    id: d.id,
    text: d.text,
    assignedAgent: d.agentName,
    status: d.status,
    direct: true,
  }))
  const normalized = normalizeRemoteTasks(input.remoteAgentTasks)
  const mergedTasks = input.agentFilter
    ? mergeTasksById([input.tasks.filter((t) => t.assignedAgent === input.agentFilter), normalized, directTaskRows])
    : mergeTasksById([directTaskRows, input.tasks])
  const afterDismissed = mergedTasks.filter((t) => !input.dismissedIds.has(t.id))
  const afterHideDone = input.hideDone
    ? afterDismissed.filter((t) => t.status !== "completed" && t.status !== "failed")
    : afterDismissed
  const statusFilter = input.statusFilter ?? "all"
  const visibleTasks = statusFilter === "all"
    ? afterHideDone
    : afterHideDone.filter((t) => matchesTaskStatusFilter(t.status, statusFilter))
  return { mergedTasks, afterDismissed, visibleTasks }
}

// ============================================================
// Selection clamping + follow-latest
// ("follow-latest" in Phase 1's own test list)
// ============================================================

/** Verbatim extraction: while following, always resolve to the newest row
 *  regardless of `selectedIndex`. */
export function computeClampedTaskIndex(input: {
  followLatestTask: boolean
  selectedIndex: number
  visibleTasksLength: number
}): number {
  return input.followLatestTask
    ? Math.max(0, input.visibleTasksLength - 1)
    : Math.min(input.selectedIndex, Math.max(0, input.visibleTasksLength - 1))
}

export function computeClampedAgentIndex(input: { selectedAgentIndex: number; agentsLength: number }): number {
  return Math.min(input.selectedAgentIndex, Math.max(0, input.agentsLength - 1))
}

/** Pressing ↑ is an explicit request to look at something older — detach
 *  from auto-follow and navigate from wherever the view currently sits
 *  (the newest row, if we were following). Verbatim extraction. */
export function nextIndexOnArrowUp(input: { followLatestTask: boolean; selectedIndex: number; visibleTasksLength: number }): number {
  return Math.max(0, (input.followLatestTask ? input.visibleTasksLength - 1 : input.selectedIndex) - 1)
}

/** Reaching (or already at) the last row re-engages auto-follow. Verbatim
 *  extraction, split into (nextIndex, resumesFollow) so the caller decides
 *  what to do with each rather than this function calling setState itself. */
export function nextIndexOnArrowDown(input: { selectedIndex: number; visibleTasksLength: number }): {
  index: number
  resumesFollow: boolean
} {
  const next = Math.min(Math.max(0, input.visibleTasksLength - 1), input.selectedIndex + 1)
  return { index: next, resumesFollow: next >= input.visibleTasksLength - 1 }
}

// ============================================================
// Row-budget / task-window math
// ("row budgeting" in Phase 1's own test list — the single highest-risk
// piece in this file: specs/012's second/thirteenth/fourteenth rounds all
// trace back to exactly this arithmetic being wrong.)
// ============================================================

// specs/012's own tuning value, unchanged: never render more than this many
// task rows no matter what `height` claims.
export const HARD_TASK_ROW_CAP = 20

export type TuiMode = "chat" | "tasks" | "agents" | "audit"

// ============================================================
// specs/069-tui-dashboard-parity-workspace/spec.md — Phase 1 shell geometry
// ("layout/region logic" in this spec's own Verification Plan). Pure so the
// breakpoint/width arithmetic has deterministic tests BEFORE any rendering
// change lands — the same discipline specs/047 Phase 1 used for
// computeTaskWindow, and for the same reason: every layout regression in
// apps/tui/index.tsx's 16-round history was invisible to `bun test` and
// only showed up in a live PTY.
// ============================================================

/** Columns consumed by the root <box padding:1> — left + right. */
export const SHELL_ROOT_PADDING = 2
/** renderHeader()'s two text lines + the blank spacer line after it. */
export const SHELL_HEADER_ROWS = 3
/** The single always-present footer/status line. */
export const SHELL_FOOTER_ROWS = 1
/** The blank spacer <text> between the header and the shell row. */
export const SHELL_GAP_ROWS = 1

/** Region widths, chosen so 80×24 stays byte-close to the current
 *  (known-good) full-width render: below 84 cols BOTH rails collapse away
 *  and the centre is simply `width - root padding`, exactly like today.
 *  The rails only appear once there is genuine width to spend on them. */
export const RAIL_FULL_WIDTH = 24
export const RAIL_STRIP_WIDTH = 6
export const RIGHT_RAIL_WIDTH = 28
/** The centre never shrinks below this — past it, drop the right rail. */
export const CENTER_MIN_WIDTH = 40

export type LeftRailMode = "full" | "strip" | "hidden"

export interface ShellLayoutInput {
  width: number
  height: number
}

export interface ShellLayout {
  leftRailMode: LeftRailMode
  leftRailWidth: number
  showRightRail: boolean
  rightRailWidth: number
  centerWidth: number
}

/** The responsive-collapse table from plan.md, as one pure function.
 *  A 1-column gap sits between each SHOWN region. `width`/`height` are the
 *  raw `useTerminalDimensions()` values; callers below 80×24 never reach
 *  here (the "too small" screen early-returns first), but the math still
 *  degrades safely if they do. */
export function computeShellLayout(input: ShellLayoutInput): ShellLayout {
  const usable = Math.max(0, input.width - SHELL_ROOT_PADDING)

  let leftRailMode: LeftRailMode
  if (input.width >= 100) leftRailMode = "full"
  else if (input.width >= 84) leftRailMode = "strip"
  else leftRailMode = "hidden"

  const leftRailWidth = leftRailMode === "full" ? RAIL_FULL_WIDTH : leftRailMode === "strip" ? RAIL_STRIP_WIDTH : 0
  const leftCost = leftRailWidth > 0 ? leftRailWidth + 1 : 0 // +1 gap

  // Only offer the right rail once it AND a comfortable centre both fit.
  let showRightRail = input.width >= 110 && usable - leftCost - (RIGHT_RAIL_WIDTH + 1) >= CENTER_MIN_WIDTH
  let rightCost = showRightRail ? RIGHT_RAIL_WIDTH + 1 : 0

  let centerWidth = usable - leftCost - rightCost
  // Defensive: a pathological width could still leave the centre too thin
  // even after the guard above — drop the right rail, then clamp.
  if (centerWidth < CENTER_MIN_WIDTH && showRightRail) {
    showRightRail = false
    rightCost = 0
    centerWidth = usable - leftCost
  }
  centerWidth = Math.max(1, centerWidth)

  return {
    leftRailMode,
    leftRailWidth,
    showRightRail,
    rightRailWidth: showRightRail ? RIGHT_RAIL_WIDTH : 0,
    centerWidth,
  }
}

/** The vertical space the shell row itself gets: everything under the
 *  header and above the footer. Each region's own scrollbox then subtracts
 *  its border(2) + title(1). Floored so a very short terminal still yields
 *  a positive height rather than a negative one Yoga would treat oddly. */
export function computeShellRegionHeight(input: { height: number }): number {
  return Math.max(
    3,
    input.height - SHELL_ROOT_PADDING - SHELL_HEADER_ROWS - SHELL_GAP_ROWS - SHELL_FOOTER_ROWS,
  )
}

// ============================================================
// Chat task presentation
// ============================================================

export interface ChatTurnLike {
  role: "user" | "assistant"
  taskId?: string
  tier?: 0 | 1 | 2
  skill?: string
}

/** `/ask` classifies an unregistered skill conservatively as Tier 1, which
 * means "write-capable", not "currently waiting for approval". In particular,
 * plan-task can finish with no executable step. Keep that distinction visible
 * in Chat; actual approval wording is driven by input-required task state. */
export function chatTierLabel(turn: ChatTurnLike): string {
  if (turn.role !== "assistant" || turn.tier === undefined) return ""
  if (turn.tier === 0) return "[from state] "
  if (turn.tier === 2) return "[read-only] "
  if (turn.skill === "plan-task") return "[planning] "
  return "[write-capable] "
}

/** A dispatched ask has received its terminal conversation answer only when
 * an assistant turn links back to that exact task. The user turn carries the
 * same taskId immediately after dispatch and must not clear the indicator. */
export function hasTerminalAnswerForTask(turns: ChatTurnLike[], taskId: string): boolean {
  return turns.some((turn) => turn.role === "assistant" && turn.taskId === taskId)
}

// ============================================================
// specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md — the
// collapsed-by-default chat display. Extracted as pure logic (matching
// this file's own established style for exactly this reason — see
// resolveModeKey/adjacentConversationId above) so the decision of what
// to show is testable with zero terminal/React involvement.
// ============================================================

export interface ChatTurnDisplayInput {
  role: "user" | "assistant"
  text: string
  summary?: string
}

export interface ChatTurnDisplay {
  /** The text to actually render for this turn right now. */
  text: string
  /** Whether this turn has a real summary distinct from its own full
   *  text — i.e. whether there's genuinely more to reveal at all. */
  hasCollapsedContent: boolean
  /** Whether the full text (as opposed to the summary) is what's
   *  currently showing — always true when there's nothing to collapse. */
  showingFull: boolean
}

/** `isLastAssistantTurn` and `expanded` are the caller's own already-
 *  computed booleans — this function does no index/role comparison
 *  itself, so it stays trivially testable per-turn without needing a
 *  whole turns array. Every turn other than the expanded last one
 *  always shows its own summary when it has one — this file's own
 *  deliberate simplification (specs/116's own Non-Goals): only the
 *  most recent assistant turn is ever expandable in this pass. */
export function resolveChatTurnDisplay(
  turn: ChatTurnDisplayInput,
  isLastAssistantTurn: boolean,
  expanded: boolean,
): ChatTurnDisplay {
  const hasCollapsedContent = Boolean(turn.summary) && turn.summary !== turn.text
  const showingFull = !hasCollapsedContent || (isLastAssistantTurn && expanded)
  return {
    text: showingFull ? turn.text : turn.summary!,
    hasCollapsedContent,
    showingFull,
  }
}

export interface ConversationSummaryLike {
  id: string
  lastTurnAt?: string | null
  createdAt?: string
}

/** Navigate the server-bounded thread list without ever substituting an
 * unknown conversation. The API preserves insertion order; newest is last. */
export function adjacentConversationId(
  conversations: ConversationSummaryLike[],
  currentId: string | null,
  direction: -1 | 1,
): string | null {
  if (conversations.length === 0) return null
  const current = currentId ? conversations.findIndex((item) => item.id === currentId) : -1
  if (current < 0) return direction > 0 ? conversations[0].id : conversations[conversations.length - 1].id
  const next = current + direction
  return next >= 0 && next < conversations.length ? conversations[next].id : null
}

// ============================================================
// specs/115-tui-navigation-redraw-and-answer-clarity/spec.md — the left
// rail's own cursor. Independent of chatConversationId: the cursor can
// browse the list without switching the active thread, then Enter opens
// whatever it's currently on. Kept as pure, isolated math (matching this
// file's own established style, e.g. resolveModeKey/adjacentConversationId
// above) so it's testable with zero terminal/React involvement.
// ============================================================

/** Clamps a rail cursor into `[0, length-1]`, or 0 for an empty list —
 *  never negative, never past the end, regardless of how it got there
 *  (a shrinking conversation list, a cursor that was never set). */
export function clampRailCursor(cursor: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(cursor, length - 1))
}

/** Moves the cursor by one, clamped — never wraps, matching `[`/`]`'s own
 *  "already at the oldest/newest" stop-at-the-edge behavior rather than
 *  cycling around. */
export function moveRailCursor(cursor: number, length: number, delta: -1 | 1): number {
  return clampRailCursor(cursor + delta, length)
}

/** Where the cursor should land when the active thread changes (a fresh
 *  `[`/`]` press, a new thread just opened, the list just loaded) — on
 *  the active thread's own position in `orderedIds`, the exact array the
 *  rail renders from (newest-first), so the highlighted row always
 *  matches what's actually active. Falls back to 0 (not clamped
 *  elsewhere) when there's no active id or it isn't in the list. */
export function railCursorForActive(orderedIds: string[], activeId: string | null): number {
  if (!activeId) return 0
  const idx = orderedIds.indexOf(activeId)
  return idx >= 0 ? idx : 0
}

export function isChatAtBottom(scrollTop: number, scrollHeight: number, viewportHeight: number, tolerance = 1): boolean {
  return scrollHeight - (scrollTop + viewportHeight) <= tolerance
}

export interface TaskWindowInput {
  agentFilterActive: boolean
  height: number
  visibleTasksLength: number
  clampedTaskIndex: number
}

export interface TaskWindowResult {
  maxTaskRows: number
  taskWindowStart: number
  hiddenAbove: number
  hiddenBelow: number
}

/** Verbatim extraction of the reservedRows/maxTaskRows/taskWindowStart
 *  arithmetic. Every magic number here is copied exactly from the
 *  component's own comments explaining what it accounts for — see
 *  apps/tui/index.tsx's own reservedRows block for the full history of why
 *  each one exists. */
export function computeTaskWindow(input: TaskWindowInput): TaskWindowResult {
  const TASKS_BOX_CHROME = 4 + 1 + (input.agentFilterActive ? 1 : 0)
  // Phase 2: Tasks owns the viewport. Agents, Help, Detail, and the composer
  // are replacement screens/regions, never siblings consuming list rows.
  // Root padding (2) + shared header (2) + gap (1) + Tasks chrome/title +
  // gap (1) + footer (1).
  const reservedRows = 2 + 2 + 1 + TASKS_BOX_CHROME + 1 + 1
  const maxTaskRows = Math.max(2, Math.min(HARD_TASK_ROW_CAP, input.height - reservedRows))

  let taskWindowStart = Math.max(0, input.visibleTasksLength - maxTaskRows)
  if (input.clampedTaskIndex < taskWindowStart) taskWindowStart = input.clampedTaskIndex
  if (input.clampedTaskIndex > taskWindowStart + maxTaskRows - 1) taskWindowStart = input.clampedTaskIndex - maxTaskRows + 1
  taskWindowStart = Math.max(0, Math.min(taskWindowStart, Math.max(0, input.visibleTasksLength - maxTaskRows)))

  const renderedCount = Math.max(0, Math.min(maxTaskRows, input.visibleTasksLength - taskWindowStart))
  const hiddenAbove = taskWindowStart
  const hiddenBelow = Math.max(0, input.visibleTasksLength - (taskWindowStart + renderedCount))

  return { maxTaskRows, taskWindowStart, hiddenAbove, hiddenBelow }
}

// specs/069-tui-dashboard-parity-workspace/spec.md — Phase 2: Chat folded
// into the shell's centre column (specs/012 renderShell — Phase 1 built
// the shell, this is the first panel besides Tasks/Agents to use it). The
// shared shell chrome this reserves against is the SAME as
// computeTaskWindow's own reservedRows, verified against that function's
// literal formula rather than re-derived: root padding(2) + header(2) +
// gap-above-row(1) + gap-below-row(1) + footer(1) = 7 — computeTaskWindow's
// own `2 + 2 + 1 + TASKS_BOX_CHROME + 1 + 1`, minus its panel-specific
// TASKS_BOX_CHROME term. The shell's footer is now always exactly ONE row
// (matching Tasks/Agents' own footer, never Chat's old 6-row composer) —
// the composer instead lives INSIDE the centre panel's own budget when
// open, shrinking the scrollbox exactly the way the old, now-superseded
// computeChatScrollHeight() shrank against the full screen.
export interface ShellChatScrollHeightInput {
  height: number
  chatInputMode: boolean
  hasNewUpdatesBanner: boolean
}

export function computeShellChatScrollHeight(input: ShellChatScrollHeightInput): number {
  const SHELL_CHROME = 7 // root padding(2) + header(2) + gap above(1) + gap below(1) + footer(1)
  const TITLE_ROW = 1 // "Chat — ..." line, first child of the centre panel, mirroring Tasks/Agents
  const NEW_UPDATES_ROW = input.hasNewUpdatesBanner ? 1 : 0
  // Composer box: border(2) + padding(2) + label line(1) + input line(1) = 6.
  // Closed: the composer is absent entirely — its hint lives in the
  // shell's own static footer instead, not inside this panel.
  const COMPOSER_ROWS = input.chatInputMode ? 6 : 0
  const reserved = SHELL_CHROME + TITLE_ROW + NEW_UPDATES_ROW + COMPOSER_ROWS
  return Math.max(3, input.height - reserved)
}

// ============================================================
// Key ownership precedence
// ("inputs" + "Help" in Phase 1's own test list)
// ============================================================

export type KeyOwner = "input" | "chatInput" | "detail" | "batchReview" | "agentDetail" | "help" | "global"

export interface KeyOwnerState {
  inputMode: boolean
  chatInputMode: boolean
  hasDetail: boolean
  hasAgentDetail: boolean
  showHelp: boolean
  // specs/130 phase 3 — the grouped batch review overlay.
  hasBatchReview?: boolean
}

/** Overlay/input precedence. Chat is now a normal top-level mode, not a key
 * owner; its local keys run only after this function returns `global`. */
export function resolveKeyOwner(state: KeyOwnerState): KeyOwner {
  if (state.inputMode) return "input"
  if (state.chatInputMode) return "chatInput"
  if (state.hasDetail) return "detail"
  if (state.hasBatchReview) return "batchReview"
  if (state.hasAgentDetail) return "agentDetail"
  if (state.showHelp) return "help"
  return "global"
}

/** Resolves only top-level mode navigation. Call this exclusively after
 * resolveKeyOwner() returns `global`, so inputs and overlays retain every key. */
export function resolveModeKey(
  key: { name?: string; sequence?: string; shift?: boolean },
  currentMode: TuiMode,
): TuiMode | null {
  const value = key.name ?? key.sequence
  if (value === "1") return "chat"
  if (value === "2") return "tasks"
  if (value === "3") return "agents"
  if (value === "4") return "audit"
  if (value !== "tab") return null

  const modes: TuiMode[] = ["chat", "tasks", "agents", "audit"]
  const current = modes.indexOf(currentMode)
  const delta = key.shift ? -1 : 1
  return modes[(current + delta + modes.length) % modes.length]
}

// ============================================================
// Approval double-press confirmation
// ("approval confirmation" in Phase 1's own test list)
// ============================================================

export const CONFIRM_WINDOW_MS = 1500

// specs/089-plan-step-skip-continue/spec.md — "s" is a third double-press
// key, mirroring "a"/"r" exactly, but only ever armed for a plan step's
// own child task (see armDecision()'s own caller-side scoping in
// index.tsx) — this state machine itself is agnostic to that restriction,
// the same way it's agnostic to what "a"/"r" mean.
export interface PendingConfirm {
  key: "a" | "r" | "s"
  taskId: string
  expiresAt: number
}

export type ConfirmResolution = { action: "confirm" } | { action: "arm"; pending: PendingConfirm }

/** Verbatim extraction of the a/r/s double-press state machine: the second
 *  press of the SAME key, on the SAME task, within the window, confirms;
 *  anything else (different key, different task, or the window elapsed)
 *  (re)arms a fresh pending confirmation instead. */
export function resolveConfirmPress(
  pending: PendingConfirm | null,
  key: "a" | "r" | "s",
  taskId: string,
  now: number,
  windowMs: number = CONFIRM_WINDOW_MS,
): ConfirmResolution {
  if (pending && pending.key === key && pending.taskId === taskId && now < pending.expiresAt) {
    return { action: "confirm" }
  }
  return { action: "arm", pending: { key, taskId, expiresAt: now + windowMs } }
}

// ============================================================
// Plan-child approval resolution
// specs/047's own Revision (a) — the spec 046 Amendment 1 regression,
// caught here by inspection before implementation rather than live by
// Yusuf a second time. Mirrors apps/orchestrator/index.ts's own
// findWaitingPlanChild() (the browser's fix) exactly: a plan's OWN
// task.status never becomes input-required — only the child it dispatches
// one at a time does.
// ============================================================

/** Finds the one child, among a plan's own childTaskIds, that is currently
 *  input-required — never the newest child, never the plan itself. Returns
 *  null for a non-plan task, a plan with no childTaskIds yet, or a plan
 *  whose current child(ren) are not (or not yet) input-required. */
export function findWaitingPlanChild(
  task: TaskRowLike,
  taskById: ReadonlyMap<string, TaskRowLike>,
): TaskRowLike | null {
  if (!task.isPlan || !task.childTaskIds?.length) return null
  for (const childId of task.childTaskIds) {
    const child = taskById.get(childId)
    if (child && child.status === "input-required") return child
  }
  return null
}

/** Resolve every currently-waiting task linked to one conversation. User and
 * assistant turns may both carry the same root taskId, so roots and resolved
 * children are deduplicated. A plan contributes only its actual waiting child. */
export function waitingTasksForConversation(
  turns: ChatTurnLike[],
  taskById: ReadonlyMap<string, TaskRowLike>,
): TaskRowLike[] {
  const waiting = new Map<string, TaskRowLike>()
  const visitedRoots = new Set<string>()
  for (const turn of turns) {
    if (!turn.taskId || visitedRoots.has(turn.taskId)) continue
    visitedRoots.add(turn.taskId)
    const root = taskById.get(turn.taskId)
    if (!root) continue
    const candidate = root.isPlan ? findWaitingPlanChild(root, taskById) : root.status === "input-required" ? root : null
    if (candidate) waiting.set(candidate.id, candidate)
  }
  return [...waiting.values()]
}

// ============================================================
// Plan steps in Details (specs/130 phase 2)
// ============================================================
/** Mirrors the Orchestrator's PlanStep (apps/orchestrator/index.ts) —
 *  duplicated locally, per this repo's per-service-copy convention. */
export interface PlanStepLike {
  order: number
  skill: string
  description: string
  status?: "pending" | "dispatched" | "completed" | "failed"
}

export interface PlanStepDisplayRow {
  key: string
  status: "pending" | "dispatched" | "completed" | "failed"
  text: string
}

export const MAX_DETAIL_PLAN_STEP_ROWS = 50
export const MAX_PLAN_STEP_DESCRIPTION_CHARS = 120

/** One bounded row per server-reported plan step, in order. Unlike the
 *  live STEP_* rows, this comes from GET /tasks/:id, so a plan started
 *  before the TUI opened still shows its whole plan. Past the row cap, the
 *  last row says how many were left out. */
export function formatPlanStepRows(steps: readonly PlanStepLike[] | undefined, maxRows = MAX_DETAIL_PLAN_STEP_ROWS): PlanStepDisplayRow[] {
  if (!steps || steps.length === 0) return []
  const ordered = [...steps].sort((a, b) => a.order - b.order)
  const shown = ordered.length > maxRows ? ordered.slice(0, maxRows - 1) : ordered
  const rows: PlanStepDisplayRow[] = shown.map((step) => {
    const status = step.status ?? "pending"
    const description = step.description.length > MAX_PLAN_STEP_DESCRIPTION_CHARS
      ? step.description.slice(0, MAX_PLAN_STEP_DESCRIPTION_CHARS - 1) + "…"
      : step.description
    return { key: `step-${step.order}`, status, text: `${step.order}. [${step.skill}] ${description} — ${status}` }
  })
  if (shown.length < ordered.length) {
    rows.push({ key: "step-more", status: "pending", text: `… ${ordered.length - shown.length} more steps` })
  }
  return rows
}

// ============================================================
// Grouped review of a parallel-write batch (specs/130 phase 3)
// ============================================================
/** One branch as GET /tasks/:parentId/pending-batch returns it (specs/120). */
export interface BatchBranchLike {
  id: string
  skill?: string
  assignedAgent?: string
  approval?: { actionId?: string; target?: string; files?: { target: string }[] }
}

export type BatchDecision = "approve" | "reject"

export interface BatchDecisionEntry {
  childTaskId: string
  actionId: string
  decision: BatchDecision
}

/** Which plan `g` reviews. Chat: the parent of the newest waiting plan step
 *  in this thread. Tasks: the selected plan, or the selected step's plan. */
export function resolveBatchParentId(input: {
  mode: TuiMode
  waitingInThread: readonly TaskRowLike[]
  selectedTask?: TaskRowLike | null
}): string | null {
  if (input.mode === "chat") {
    for (let i = input.waitingInThread.length - 1; i >= 0; i--) {
      const parentId = input.waitingInThread[i]?.parentTaskId
      if (parentId) return parentId
    }
    return null
  }
  if (input.mode === "tasks" && input.selectedTask) {
    if (input.selectedTask.isPlan) return input.selectedTask.id
    return input.selectedTask.parentTaskId ?? null
  }
  return null
}

/** How many of a plan's steps are waiting on approval right now — enough to
 *  offer `g`. Whether they form an eligible batch (disjoint targets) is
 *  decided only by the server. */
export function countWaitingPlanChildren(parentId: string, tasks: readonly TaskRowLike[]): number {
  return tasks.filter((task) => task.parentTaskId === parentId && task.status === "input-required").length
}

export function batchBranchTargets(branch: BatchBranchLike): string[] {
  const files = branch.approval?.files
  if (files && files.length > 0) return files.map((file) => file.target)
  return branch.approval?.target ? [branch.approval.target] : []
}

export function formatBatchBranchLine(branch: BatchBranchLike, decision: BatchDecision): string {
  const marker = decision === "approve" ? "[✓ approve]" : "[✗ reject ]"
  const targets = batchBranchTargets(branch)
  return `${marker} ${branch.skill ?? "task"} · ${branch.assignedAgent ?? "agent"} · ${targets.length > 0 ? targets.join(", ") : "no target"}`
}

/** The approve-batch request body: every branch exactly once, each with its
 *  OWN actionId (the server rejects anything else). An unset decision is
 *  approve. Returns null if any branch lacks an actionId — never submitted. */
export function buildBatchDecisions(
  branches: readonly BatchBranchLike[],
  decisions: Readonly<Record<string, BatchDecision>>,
): BatchDecisionEntry[] | null {
  const entries: BatchDecisionEntry[] = []
  for (const branch of branches) {
    const actionId = branch.approval?.actionId
    if (!actionId) return null
    entries.push({ childTaskId: branch.id, actionId, decision: decisions[branch.id] ?? "approve" })
  }
  return entries
}

export function summarizeBatchDecisions(
  branches: readonly BatchBranchLike[],
  decisions: Readonly<Record<string, BatchDecision>>,
): string {
  const rejected = branches.filter((branch) => decisions[branch.id] === "reject").length
  return `${branches.length - rejected} approve · ${rejected} reject`
}

/** First visible row of the branch list, keeping `selected` in view. */
export function computeBatchListWindow(selected: number, total: number, maxRows: number): number {
  if (total <= maxRows || maxRows < 1) return 0
  const clamped = Math.min(Math.max(0, selected), total - 1)
  return Math.min(Math.max(0, clamped - maxRows + 1), total - maxRows)
}

// ============================================================
// Information parity (specs/130 phase 4)
// ============================================================
/** "now", "5m", "3h", "2d" — or "" when the time is missing or unparseable. */
export function formatRelativeTime(at: string | number | null | undefined, now: number): string {
  if (at === null || at === undefined || at === "") return ""
  const ms = typeof at === "number" ? at : Date.parse(at)
  if (!Number.isFinite(ms)) return ""
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Local HH:MM for a chat turn's header, or "" when missing. */
export function formatClockTime(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return ""
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/** The conversation rail's one-cell status glyph, from the server's
 *  representative task status for that thread (GET /conversations). */
export function conversationStatusGlyph(status: string | null | undefined): string {
  if (status === "input-required") return "⏸"
  if (status === "working" || status === "assigned" || status === "pending") return "⋯"
  if (status === "completed") return "✓"
  if (status === "failed") return "✗"
  return "·"
}

/** "512B", "1.5KB", "2.0MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0B"
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Audit events for one Orchestrator task are recorded under its own id (the
 *  Orchestrator's A2A calls) and under `orch-<id>` (the agent's MCP calls,
 *  since agents run it as `orch-<id>`). GET /audit?task= is exact-match. */
export function auditTaskIdsFor(taskId: string): string[] {
  return taskId.startsWith("orch-") ? [taskId] : [taskId, `orch-${taskId}`]
}

export function auditRowMatchesTask(rowTaskId: string | null, taskId: string): boolean {
  return rowTaskId !== null && auditTaskIdsFor(taskId).includes(rowTaskId)
}

export type TaskStatusFilter = "all" | "waiting" | "running" | "failed" | "completed"

const TASK_STATUS_FILTER_ORDER: TaskStatusFilter[] = ["all", "waiting", "running", "failed", "completed"]

export function nextTaskStatusFilter(current: TaskStatusFilter): TaskStatusFilter {
  return TASK_STATUS_FILTER_ORDER[(TASK_STATUS_FILTER_ORDER.indexOf(current) + 1) % TASK_STATUS_FILTER_ORDER.length]!
}

export function matchesTaskStatusFilter(status: string, filter: TaskStatusFilter): boolean {
  if (filter === "all") return true
  if (filter === "waiting") return status === "input-required"
  if (filter === "running") return status === "working" || status === "assigned" || status === "pending"
  return status === filter
}

/** The Tasks row's text column: a `chat · ` marker for a task this session
 *  saw linked from a chat thread, and `child of <id>` for a plan step, the
 *  way the dashboard's table labels them. */
export function formatTaskRowText(task: TaskRowLike, fromChat: boolean): string {
  const chat = fromChat ? "chat · " : ""
  const parent = task.parentTaskId ? `child of ${shortTaskId(task.parentTaskId)} · ` : ""
  return `${chat}${parent}${task.text}`
}

/** `task-fa0f6522-ff99-…` → `fa0f6522`: the first 8 characters after the
 *  id's prefix, enough to tell tasks apart on screen. */
export function shortTaskId(id: string): string {
  const dash = id.indexOf("-")
  return (dash >= 0 ? id.slice(dash + 1) : id).slice(0, 8)
}

// ============================================================
// Header status that always fits (specs/135)
// ============================================================
export type HeaderConnState = "connecting" | "connected" | "disconnected"

/** The full form, padded to its longest variant so consecutive frames
 *  agree on where the line ends (the specs/115 redraw rule). */
export const HEADER_STATUS_FULL_BUDGET = "        ● disconnected · 99/99 agents".length
/** The compact form, padded the same way to its own longest variant. */
export const HEADER_STATUS_COMPACT_BUDGET = "  ● down 99/99".length

/** The status suffix of header line 1, chosen so the line never wraps:
 *  wrapping added a third header row and pushed the Audit and Chat titles
 *  off screen at 80×24 (proven in a real PTY; see specs/135).
 *  `available` is the width left after the mode labels. Every form is
 *  padded to a fixed width, so frames never disagree about the line's end;
 *  the result never exceeds `available`. */
export function formatHeaderStatus(input: {
  available: number
  conn: HeaderConnState
  online: number
  total: number
}): string {
  const fraction = `${input.online}/${input.total}`
  const available = Math.max(0, input.available)
  const fullWord = input.conn === "connecting" ? "connecting" : input.conn === "connected" ? "● live" : "● disconnected"
  if (available >= HEADER_STATUS_FULL_BUDGET) {
    return `        ${fullWord} · ${fraction} agents`.padEnd(HEADER_STATUS_FULL_BUDGET)
  }
  const compactWord = input.conn === "connecting" ? "○ wait" : input.conn === "connected" ? "● live" : "● down"
  const compact = `  ${compactWord} ${fraction}`.padEnd(HEADER_STATUS_COMPACT_BUDGET)
  return compact.length <= available ? compact : compact.slice(0, available)
}

// ============================================================
// One Audit row, one line (specs/139 C)
// ============================================================
/** Truncates to `width` cells with a trailing ellipsis; "" for width ≤ 0. */
export function clipText(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text
  if (width === 1) return "…"
  return text.slice(0, width - 1) + "…"
}

export const AUDIT_CALLER_MIN_WIDTH = 6

/** Fits an Audit row into `available` cells. The row is: glyph, " ",
 *  time, " ", badge, " ", caller, " → ", target, tail. The target gets the
 *  space first; the caller shrinks to AUDIT_CALLER_MIN_WIDTH before it
 *  does. When even that doesn't fit (a narrow centre between both rails),
 *  the tail switches to `compactTail` (the outcome word dropped — the ✓/✗
 *  glyph already shows it), and is clipped only as a last resort. The
 *  returned row never exceeds `available`. */
export function fitAuditRow(input: {
  available: number
  time: string
  badge: string
  caller: string
  target: string
  tail: string
  compactTail?: string
}): { caller: string; target: string; tail: string } {
  const base = 1 + 1 + input.time.length + 1 + input.badge.length + 1 + 3
  let tail = input.tail
  if (input.compactTail !== undefined && input.available - base - tail.length < 2 * AUDIT_CALLER_MIN_WIDTH) {
    tail = input.compactTail
  }
  if (input.available - base - tail.length < 0) tail = clipText(tail, Math.max(0, input.available - base))
  const remaining = Math.max(0, input.available - base - tail.length)
  const callerWidth = Math.min(input.caller.length, Math.max(AUDIT_CALLER_MIN_WIDTH, remaining - input.target.length), remaining)
  const targetWidth = Math.max(0, remaining - callerWidth)
  return { caller: clipText(input.caller, callerWidth), target: clipText(input.target, targetWidth), tail }
}

// ============================================================
// Orchestrator connection URL
// specs/099-tui-port-url-and-analyze-project-stack-awareness/spec.md
// ============================================================
/** Previously a hardcoded "http://localhost:3000" fallback in
 *  index.tsx, unaware of ORCHESTRAI_ORCHESTRATOR_PORT (specs/073) — the
 *  same "<full-URL override> ??
 *  http://localhost:<resolveServicePort(...)>" shape
 *  packages/shared/agent-registry.ts already uses for every agent. An
 *  explicit ORCHESTRAI_ORCHESTRATOR_URL still always wins, unchanged. */
export function resolveOrchestratorUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORCHESTRAI_ORCHESTRATOR_URL ?? `http://localhost:${resolveServicePort("orchestrator", env)}`
}
