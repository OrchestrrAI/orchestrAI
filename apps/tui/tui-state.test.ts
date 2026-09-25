// specs/047-tui-conversation-operations-navigation/spec.md — Phase 1.
// Pins the TUI's existing behavior (filtering, follow-latest, row
// budgeting, key ownership, approval double-press) via the pure helpers in
// ./tui-state.ts, BEFORE any layout change lands in Phase 2 — this file's
// own passing is that phase's exit gate. Also covers the new plan-child
// resolver (spec Revision (a)), mirroring the exact test shape
// apps/orchestrator/ask-endpoint.test.ts already uses for the browser's own
// findWaitingPlanChild().
import { describe, expect, test } from "bun:test"
import {
  CENTER_MIN_WIDTH,
  CONFIRM_WINDOW_MS,
  HARD_TASK_ROW_CAP,
  RAIL_FULL_WIDTH,
  RAIL_STRIP_WIDTH,
  RIGHT_RAIL_WIDTH,
  type TaskRowLike,
  adjacentConversationId,
  clampRailCursor,
  moveRailCursor,
  railCursorForActive,
  resolveChatTurnDisplay,
  computeShellChatScrollHeight,
  computeClampedAgentIndex,
  computeClampedTaskIndex,
  computeShellLayout,
  computeShellRegionHeight,
  computeTaskWindow,
  computeVisibleTasks,
  countWaitingApprovals,
  formatPlanStepRows,
  MAX_PLAN_STEP_DESCRIPTION_CHARS,
  buildBatchDecisions,
  computeBatchListWindow,
  countWaitingPlanChildren,
  formatBatchBranchLine,
  resolveBatchParentId,
  summarizeBatchDecisions,
  auditRowMatchesTask,
  auditTaskIdsFor,
  conversationStatusGlyph,
  formatBytes,
  formatClockTime,
  formatRelativeTime,
  formatTaskRowText,
  matchesTaskStatusFilter,
  nextTaskStatusFilter,
  shortTaskId,
  formatHeaderStatus,
  fitAuditRow,
  clipText,
  AUDIT_CALLER_MIN_WIDTH,
  HEADER_STATUS_COMPACT_BUDGET,
  HEADER_STATUS_FULL_BUDGET,
  chatTierLabel,
  findWaitingPlanChild,
  hasTerminalAnswerForTask,
  isChatAtBottom,
  mergeTasksById,
  nextIndexOnArrowDown,
  nextIndexOnArrowUp,
  normalizeRemoteTasks,
  resolveConfirmPress,
  resolveKeyOwner,
  resolveModeKey,
  resolveOrchestratorUrl,
  waitingTasksForConversation,
} from "./tui-state"
import { SERVICE_PORT_ENV_VARS } from "../../packages/shared/service-ports"

function task(overrides: Partial<TaskRowLike> & { id: string }): TaskRowLike {
  return { text: "", status: "completed", ...overrides }
}

describe("mergeTasksById", () => {
  test("the first list wins a given id; later lists only fill in new ids", () => {
    const a = [task({ id: "1", text: "from-a" })]
    const b = [task({ id: "1", text: "from-b" }), task({ id: "2", text: "from-b" })]
    const merged = mergeTasksById([a, b])
    expect(merged.map((t) => [t.id, t.text])).toEqual([["1", "from-a"], ["2", "from-b"]])
  })

  test("empty input yields empty output", () => {
    expect(mergeTasksById([])).toEqual([])
    expect(mergeTasksById([[], []])).toEqual([])
  })
})

describe("normalizeRemoteTasks", () => {
  test("strips the Orchestrator's own orch- dispatch prefix and marks it not-direct", () => {
    const [normalized] = normalizeRemoteTasks([task({ id: "orch-abc123", direct: true })])
    expect(normalized.id).toBe("abc123")
    expect(normalized.direct).toBe(false)
  })

  test("a task with no orch- prefix passes through unchanged", () => {
    const [normalized] = normalizeRemoteTasks([task({ id: "task-1", direct: true })])
    expect(normalized.id).toBe("task-1")
    expect(normalized.direct).toBe(true)
  })
})

// specs/130 — the header count must never read 0 while an approval waits.
describe("countWaitingApprovals", () => {
  const waitingOrch = { id: "t1", text: "dockerize", assignedAgent: "devops-agent", status: "input-required" }
  test("counts approvals no view filter can hide, each id once", () => {
    expect(countWaitingApprovals({
      tasks: [waitingOrch, { id: "t2", text: "x", assignedAgent: "testing-agent", status: "input-required" }, { id: "t3", text: "y", status: "completed" }],
      // the same task seen via its agent's own list must not double-count
      remoteAgentTasks: [{ ...waitingOrch, id: "orch-t1" }],
      directTasks: [{ id: "d1", agentName: "coder-agent", status: "input-required", text: "edit" }],
    })).toBe(3)
  })

  test("is unaffected by what the visible list filters out", () => {
    const input = { tasks: [waitingOrch], remoteAgentTasks: [], directTasks: [] }
    const { visibleTasks } = computeVisibleTasks({ ...input, agentFilter: "security-agent", dismissedIds: new Set(["t1"]), hideDone: true })
    expect(visibleTasks.length).toBe(0)
    expect(countWaitingApprovals(input)).toBe(1)
  })
})

describe("computeVisibleTasks — filtering", () => {
  test("unfiltered: direct submissions first, then every Orchestrator task, deduped by id", () => {
    const { visibleTasks } = computeVisibleTasks({
      tasks: [task({ id: "orch-1" })],
      directTasks: [{ id: "tui-1", agentName: "devops-agent", status: "completed", text: "direct" }],
      remoteAgentTasks: [],
      agentFilter: null,
      dismissedIds: new Set(),
      hideDone: false,
    })
    expect(visibleTasks.map((t) => t.id)).toEqual(["tui-1", "orch-1"])
  })

  test("filtered: the Orchestrator's own record for that agent wins over the agent's own remote list", () => {
    const { visibleTasks } = computeVisibleTasks({
      tasks: [task({ id: "shared-1", assignedAgent: "devops-agent", text: "orchestrator-text" })],
      directTasks: [],
      remoteAgentTasks: [task({ id: "shared-1", text: "remote-placeholder-text" })],
      agentFilter: "devops-agent",
      dismissedIds: new Set(),
      hideDone: false,
    })
    expect(visibleTasks).toHaveLength(1)
    expect(visibleTasks[0].text).toBe("orchestrator-text")
  })

  test("filtered: a remote-only task (never seen by the Orchestrator) still appears", () => {
    const { visibleTasks } = computeVisibleTasks({
      tasks: [],
      directTasks: [],
      remoteAgentTasks: [task({ id: "remote-only" })],
      agentFilter: "devops-agent",
      dismissedIds: new Set(),
      hideDone: false,
    })
    expect(visibleTasks.map((t) => t.id)).toEqual(["remote-only"])
  })

  test("filtered: tasks assigned to a DIFFERENT agent are excluded", () => {
    const { visibleTasks } = computeVisibleTasks({
      tasks: [task({ id: "other-agent-task", assignedAgent: "testing-agent" })],
      directTasks: [],
      remoteAgentTasks: [],
      agentFilter: "devops-agent",
      dismissedIds: new Set(),
      hideDone: false,
    })
    expect(visibleTasks).toEqual([])
  })

  test("dismissedIds hides a task from view (a `c` clear) without removing it from mergedTasks", () => {
    const { mergedTasks, visibleTasks } = computeVisibleTasks({
      tasks: [task({ id: "1" }), task({ id: "2" })],
      directTasks: [],
      remoteAgentTasks: [],
      agentFilter: null,
      dismissedIds: new Set(["1"]),
      hideDone: false,
    })
    expect(mergedTasks.map((t) => t.id)).toEqual(["1", "2"])
    expect(visibleTasks.map((t) => t.id)).toEqual(["2"])
  })

  test("a task with a genuinely new id still shows even while others are dismissed", () => {
    const { visibleTasks } = computeVisibleTasks({
      tasks: [task({ id: "1" }), task({ id: "new" })],
      directTasks: [],
      remoteAgentTasks: [],
      agentFilter: null,
      dismissedIds: new Set(["1"]),
      hideDone: false,
    })
    expect(visibleTasks.map((t) => t.id)).toEqual(["new"])
  })

  test("hideDone filters out completed and failed, keeps everything else", () => {
    const { visibleTasks } = computeVisibleTasks({
      tasks: [
        task({ id: "1", status: "completed" }),
        task({ id: "2", status: "failed" }),
        task({ id: "3", status: "working" }),
        task({ id: "4", status: "input-required" }),
      ],
      directTasks: [],
      remoteAgentTasks: [],
      agentFilter: null,
      dismissedIds: new Set(),
      hideDone: true,
    })
    expect(visibleTasks.map((t) => t.id)).toEqual(["3", "4"])
  })
})

describe("computeClampedTaskIndex / computeClampedAgentIndex — selection clamping", () => {
  test("while following, always resolves to the newest (last) row regardless of selectedIndex", () => {
    expect(computeClampedTaskIndex({ followLatestTask: true, selectedIndex: 0, visibleTasksLength: 5 })).toBe(4)
  })

  test("not following: clamps selectedIndex to the visible range", () => {
    expect(computeClampedTaskIndex({ followLatestTask: false, selectedIndex: 99, visibleTasksLength: 5 })).toBe(4)
    expect(computeClampedTaskIndex({ followLatestTask: false, selectedIndex: 2, visibleTasksLength: 5 })).toBe(2)
  })

  test("an empty list clamps to 0, not -1", () => {
    expect(computeClampedTaskIndex({ followLatestTask: true, selectedIndex: 0, visibleTasksLength: 0 })).toBe(0)
    expect(computeClampedAgentIndex({ selectedAgentIndex: 3, agentsLength: 0 })).toBe(0)
  })
})

describe("nextIndexOnArrowUp / nextIndexOnArrowDown — follow-latest", () => {
  test("↑ while following detaches from the newest row and moves one older", () => {
    expect(nextIndexOnArrowUp({ followLatestTask: true, selectedIndex: 0, visibleTasksLength: 5 })).toBe(3)
  })

  test("↑ while not following moves relative to the current selectedIndex", () => {
    expect(nextIndexOnArrowUp({ followLatestTask: false, selectedIndex: 2, visibleTasksLength: 5 })).toBe(1)
  })

  test("↑ never goes below 0", () => {
    expect(nextIndexOnArrowUp({ followLatestTask: false, selectedIndex: 0, visibleTasksLength: 5 })).toBe(0)
  })

  test("↓ reaching the last row reports resumesFollow: true", () => {
    const { index, resumesFollow } = nextIndexOnArrowDown({ selectedIndex: 3, visibleTasksLength: 5 })
    expect(index).toBe(4)
    expect(resumesFollow).toBe(true)
  })

  test("↓ short of the last row reports resumesFollow: false", () => {
    const { index, resumesFollow } = nextIndexOnArrowDown({ selectedIndex: 0, visibleTasksLength: 5 })
    expect(index).toBe(1)
    expect(resumesFollow).toBe(false)
  })

  test("↓ never exceeds the last valid index", () => {
    const { index } = nextIndexOnArrowDown({ selectedIndex: 99, visibleTasksLength: 5 })
    expect(index).toBe(4)
  })
})

describe("computeTaskWindow — row budgeting (specs/012's own highest-risk arithmetic)", () => {
  const base = {
    showHelp: false,
    hasDetail: false,
    agentDetailSkillCount: null as number | null,
    inputMode: false,
    agentFilterActive: false,
    visibleTasksLength: 10,
    clampedTaskIndex: 9,
  }

  test("a generously-sized terminal renders every visible task", () => {
    const result = computeTaskWindow({ ...base, height: 60 })
    expect(result.taskWindowStart).toBe(0)
    expect(result.hiddenAbove).toBe(0)
    expect(result.hiddenBelow).toBe(0)
  })

  test("the hard cap holds even when a huge height would otherwise allow more", () => {
    const result = computeTaskWindow({ ...base, height: 10_000, visibleTasksLength: 200, clampedTaskIndex: 199 })
    expect(result.maxTaskRows).toBe(HARD_TASK_ROW_CAP)
  })

  test("maxTaskRows never drops below 2, even at an absurdly small height", () => {
    const result = computeTaskWindow({ ...base, height: 1 })
    expect(result.maxTaskRows).toBe(2)
  })

  test("the visible agent-filter legend consumes exactly one Tasks row", () => {
    const unfiltered = computeTaskWindow({ ...base, height: 30, agentFilterActive: false })
    const filtered = computeTaskWindow({ ...base, height: 30, agentFilterActive: true })
    expect(filtered.maxTaskRows).toBe(unfiltered.maxTaskRows - 1)
  })

  test("the selected row always stays inside the rendered window", () => {
    const result = computeTaskWindow({ ...base, height: 15, visibleTasksLength: 50, clampedTaskIndex: 0 })
    expect(result.taskWindowStart).toBeLessThanOrEqual(0)
    expect(0).toBeLessThan(result.taskWindowStart + result.maxTaskRows)
  })

  test("following the newest row keeps the window pinned to the tail", () => {
    const result = computeTaskWindow({ ...base, height: 15, visibleTasksLength: 50, clampedTaskIndex: 49 })
    expect(result.taskWindowStart + result.maxTaskRows).toBeGreaterThanOrEqual(50)
    expect(result.hiddenBelow).toBe(0)
  })
})

// specs/069-tui-dashboard-parity-workspace/spec.md Phase 2 — Chat folded
// into the shell's centre tab superseded the old full-screen
// computeChatScrollHeight() (specs/047 Phase 2's own fix for the same
// class of flexGrow/header-corruption bug) with this shell-aware
// equivalent: same "compute a real reserved-rows budget" discipline,
// now reserving against the SHARED shell chrome (verified equal to
// computeTaskWindow's own reservedRows formula, see that function's own
// comment) instead of the old full-screen header/footer.
describe("computeShellChatScrollHeight — Chat's own row budget inside the shell", () => {
  test("a generously-sized terminal gives the scrollbox most of the height", () => {
    const result = computeShellChatScrollHeight({ height: 40, chatInputMode: false, hasNewUpdatesBanner: false })
    expect(result).toBeGreaterThan(28)
  })

  test("an open composer reserves more rows than the closed panel", () => {
    const closed = computeShellChatScrollHeight({ height: 24, chatInputMode: false, hasNewUpdatesBanner: false })
    const open = computeShellChatScrollHeight({ height: 24, chatInputMode: true, hasNewUpdatesBanner: false })
    expect(open).toBeLessThan(closed)
    expect(closed - open).toBe(6) // the composer's own border+padding+label+input rows
  })

  test("the new-updates banner reserves its own row", () => {
    const withoutBanner = computeShellChatScrollHeight({ height: 24, chatInputMode: false, hasNewUpdatesBanner: false })
    const withBanner = computeShellChatScrollHeight({ height: 24, chatInputMode: false, hasNewUpdatesBanner: true })
    expect(withBanner).toBe(withoutBanner - 1)
  })

  test("never returns less than the 3-row floor even at an absurdly small height", () => {
    const result = computeShellChatScrollHeight({ height: 1, chatInputMode: true, hasNewUpdatesBanner: true })
    expect(result).toBe(3)
  })

  test("matches computeTaskWindow's own reservedRows formula for the shared shell chrome", () => {
    // computeTaskWindow's reservedRows = 2 + 2 + 1 + TASKS_BOX_CHROME + 1 + 1;
    // the non-panel-specific sum (excluding TASKS_BOX_CHROME) is 7, and this
    // function's own SHELL_CHROME constant must equal that exactly, or the
    // two panels would disagree about how much vertical space the shared
    // shell (header/gaps/footer) actually consumes.
    const height = 30
    const chatReserved = height - computeShellChatScrollHeight({ height, chatInputMode: false, hasNewUpdatesBanner: false })
    const SHELL_CHROME_PLUS_TITLE_ROW = 7 + 1
    expect(chatReserved).toBe(SHELL_CHROME_PLUS_TITLE_ROW)
  })

  test("at 80x24 with the composer closed", () => {
    const result = computeShellChatScrollHeight({ height: 24, chatInputMode: false, hasNewUpdatesBanner: false })
    expect(result).toBe(16)
  })
})

describe("resolveModeKey — full-screen mode navigation", () => {
  test("1/2/3/4 select Chat, Tasks, Agents, and Audit directly", () => {
    expect(resolveModeKey({ name: "1" }, "agents")).toBe("chat")
    expect(resolveModeKey({ name: "2" }, "chat")).toBe("tasks")
    expect(resolveModeKey({ name: "3" }, "tasks")).toBe("agents")
    // specs/108-durable-audit-trail/spec.md B7 — the fourth mode.
    expect(resolveModeKey({ name: "4" }, "chat")).toBe("audit")
  })

  test("Tab cycles forward and wraps", () => {
    expect(resolveModeKey({ name: "tab" }, "chat")).toBe("tasks")
    expect(resolveModeKey({ name: "tab" }, "tasks")).toBe("agents")
    // specs/108 — Audit is now the fourth stop in the cycle before it
    // wraps back to Chat, a real behavior change from the pre-108
    // three-mode cycle (agents used to wrap directly to chat).
    expect(resolveModeKey({ name: "tab" }, "agents")).toBe("audit")
    expect(resolveModeKey({ name: "tab" }, "audit")).toBe("chat")
  })

  test("Shift+Tab cycles backward and wraps", () => {
    // specs/108 — chat now wraps backward to Audit (the new last mode),
    // not directly to Agents.
    expect(resolveModeKey({ name: "tab", shift: true }, "chat")).toBe("audit")
    expect(resolveModeKey({ name: "tab", shift: true }, "audit")).toBe("agents")
    expect(resolveModeKey({ name: "tab", shift: true }, "agents")).toBe("tasks")
  })

  test("unowned keys do not change mode", () => {
    expect(resolveModeKey({ name: "a" }, "tasks")).toBeNull()
  })
})

describe("Chat task presentation — approval means actual state, not potential", () => {
  test("a conservative Tier 1 plan is labeled planning, not approval-needed", () => {
    expect(chatTierLabel({ role: "assistant", tier: 1, skill: "plan-task" })).toBe("[planning] ")
  })

  test("other Tier 1 work is labeled write-capable without claiming it is waiting", () => {
    expect(chatTierLabel({ role: "assistant", tier: 1, skill: "dockerize" })).toBe("[write-capable] ")
  })

  test("read-only and state labels remain explicit", () => {
    expect(chatTierLabel({ role: "assistant", tier: 0 })).toBe("[from state] ")
    expect(chatTierLabel({ role: "assistant", tier: 2 })).toBe("[read-only] ")
  })

  test("only an assistant turn for the exact task clears its running state", () => {
    const turns = [
      { role: "user" as const, taskId: "task-1" },
      { role: "assistant" as const, taskId: "task-other" },
    ]
    expect(hasTerminalAnswerForTask(turns, "task-1")).toBe(false)
    expect(hasTerminalAnswerForTask([...turns, { role: "assistant", taskId: "task-1" }], "task-1")).toBe(true)
  })
})

describe("Chat thread navigation and scroll-follow state", () => {
  const conversations = [{ id: "conv-1" }, { id: "conv-2" }, { id: "conv-3" }]

  test("moves only to an existing adjacent conversation", () => {
    expect(adjacentConversationId(conversations, "conv-2", -1)).toBe("conv-1")
    expect(adjacentConversationId(conversations, "conv-2", 1)).toBe("conv-3")
    expect(adjacentConversationId(conversations, "conv-1", -1)).toBeNull()
    expect(adjacentConversationId(conversations, "conv-3", 1)).toBeNull()
  })

  test("an unknown/currently-evicted id starts at the requested edge", () => {
    expect(adjacentConversationId(conversations, "evicted", 1)).toBe("conv-1")
    expect(adjacentConversationId(conversations, "evicted", -1)).toBe("conv-3")
  })

  test("bottom detection uses content, viewport, and a small tolerance", () => {
    expect(isChatAtBottom(80, 100, 20)).toBe(true)
    expect(isChatAtBottom(79, 100, 20)).toBe(true)
    expect(isChatAtBottom(78, 100, 20)).toBe(false)
  })
})

// specs/115-tui-navigation-redraw-and-answer-clarity/spec.md — the left
// rail's own ←/→ + Enter cursor, a second, independent path to any
// thread alongside the existing [/] stepping above.
describe("Rail cursor — ←/→ browsing, independent of the active thread", () => {
  test("clampRailCursor never goes negative or past the end", () => {
    expect(clampRailCursor(-5, 3)).toBe(0)
    expect(clampRailCursor(0, 3)).toBe(0)
    expect(clampRailCursor(2, 3)).toBe(2)
    expect(clampRailCursor(99, 3)).toBe(2)
  })

  test("clampRailCursor on an empty list is always 0", () => {
    expect(clampRailCursor(0, 0)).toBe(0)
    expect(clampRailCursor(5, 0)).toBe(0)
    expect(clampRailCursor(-5, 0)).toBe(0)
  })

  test("moveRailCursor stops at the edges — never wraps, unlike [/]'s own step-and-stop behavior it mirrors", () => {
    expect(moveRailCursor(1, 3, -1)).toBe(0)
    expect(moveRailCursor(0, 3, -1)).toBe(0) // already at the start
    expect(moveRailCursor(1, 3, 1)).toBe(2)
    expect(moveRailCursor(2, 3, 1)).toBe(2) // already at the end
  })

  test("railCursorForActive lands on the active thread's own position in the rail's display order", () => {
    const orderedIds = ["conv-3", "conv-2", "conv-1"] // newest-first, as renderLeftRail() displays them
    expect(railCursorForActive(orderedIds, "conv-3")).toBe(0)
    expect(railCursorForActive(orderedIds, "conv-1")).toBe(2)
  })

  test("railCursorForActive falls back to 0 for no active id or one not in the list", () => {
    const orderedIds = ["conv-3", "conv-2", "conv-1"]
    expect(railCursorForActive(orderedIds, null)).toBe(0)
    expect(railCursorForActive(orderedIds, "evicted")).toBe(0)
  })
})

describe("resolveKeyOwner — key ownership precedence", () => {
  const closed = { inputMode: false, chatInputMode: false, hasDetail: false, hasAgentDetail: false, showHelp: false }

  test("nothing open: global shortcuts own the key", () => {
    expect(resolveKeyOwner(closed)).toBe("global")
  })

  test("the new-task input, when open, owns the key over everything else", () => {
    expect(resolveKeyOwner({ ...closed, inputMode: true, showHelp: true, hasDetail: true })).toBe("input")
  })

  test("the chat composer owns the key over Chat's own view and everything below it", () => {
    expect(resolveKeyOwner({ ...closed, chatInputMode: true, showHelp: true })).toBe("chatInput")
  })

  test("Detail owns the key over AgentDetail and Help", () => {
    expect(resolveKeyOwner({ ...closed, hasDetail: true, hasAgentDetail: true, showHelp: true })).toBe("detail")
  })

  test("specs/130 — the grouped batch review owns the key under Detail, over AgentDetail and Help", () => {
    expect(resolveKeyOwner({ ...closed, hasBatchReview: true, hasAgentDetail: true, showHelp: true })).toBe("batchReview")
    expect(resolveKeyOwner({ ...closed, hasBatchReview: true, hasDetail: true })).toBe("detail")
    expect(resolveKeyOwner({ ...closed, hasBatchReview: true, chatInputMode: true })).toBe("chatInput")
  })

  test("AgentDetail owns the key over Help", () => {
    expect(resolveKeyOwner({ ...closed, hasAgentDetail: true, showHelp: true })).toBe("agentDetail")
  })

  test("Help owns the key when nothing higher-precedence is open", () => {
    expect(resolveKeyOwner({ ...closed, showHelp: true })).toBe("help")
  })
})

describe("resolveConfirmPress — approval double-press confirmation", () => {
  test("a first press on a task arms a pending confirmation, does not confirm", () => {
    const result = resolveConfirmPress(null, "a", "task-1", 1000)
    expect(result.action).toBe("arm")
    if (result.action === "arm") {
      expect(result.pending).toEqual({ key: "a", taskId: "task-1", expiresAt: 1000 + CONFIRM_WINDOW_MS })
    }
  })

  test("the same key, same task, within the window: confirms", () => {
    const pending = { key: "a" as const, taskId: "task-1", expiresAt: 1000 + CONFIRM_WINDOW_MS }
    expect(resolveConfirmPress(pending, "a", "task-1", 1000 + 500)).toEqual({ action: "confirm" })
  })

  test("the window elapsed: re-arms instead of confirming", () => {
    const pending = { key: "a" as const, taskId: "task-1", expiresAt: 1000 + CONFIRM_WINDOW_MS }
    const result = resolveConfirmPress(pending, "a", "task-1", 1000 + CONFIRM_WINDOW_MS + 1)
    expect(result.action).toBe("arm")
  })

  test("a different task selected on the second press: re-arms, never confirms the old task", () => {
    const pending = { key: "a" as const, taskId: "task-1", expiresAt: 1000 + CONFIRM_WINDOW_MS }
    const result = resolveConfirmPress(pending, "a", "task-2", 1000 + 100)
    expect(result.action).toBe("arm")
    if (result.action === "arm") expect(result.pending.taskId).toBe("task-2")
  })

  test("pressing the opposite key (a then r) re-arms as reject, never confirms approve", () => {
    const pending = { key: "a" as const, taskId: "task-1", expiresAt: 1000 + CONFIRM_WINDOW_MS }
    const result = resolveConfirmPress(pending, "r", "task-1", 1000 + 100)
    expect(result.action).toBe("arm")
    if (result.action === "arm") expect(result.pending.key).toBe("r")
  })

  // specs/089-plan-step-skip-continue/spec.md — "s" is a third key in the
  // exact same state machine, agnostic to what "s" means (the caller side
  // in index.tsx restricts when it's even offered).
  test("'s' behaves identically to 'a'/'r' — a first press arms, a second same-key/same-task press within the window confirms", () => {
    const first = resolveConfirmPress(null, "s", "task-1", 1000)
    expect(first.action).toBe("arm")
    if (first.action === "arm") expect(first.pending).toEqual({ key: "s", taskId: "task-1", expiresAt: 1000 + CONFIRM_WINDOW_MS })

    const pending = { key: "s" as const, taskId: "task-1", expiresAt: 1000 + CONFIRM_WINDOW_MS }
    expect(resolveConfirmPress(pending, "s", "task-1", 1000 + 500)).toEqual({ action: "confirm" })
  })

  test("pressing 's' after 'a' was armed re-arms as skip, never confirms approve", () => {
    const pending = { key: "a" as const, taskId: "task-1", expiresAt: 1000 + CONFIRM_WINDOW_MS }
    const result = resolveConfirmPress(pending, "s", "task-1", 1000 + 100)
    expect(result.action).toBe("arm")
    if (result.action === "arm") expect(result.pending.key).toBe("s")
  })
})

// specs/047 Revision (a) — mirrors apps/orchestrator/ask-endpoint.test.ts's
// own findWaitingPlanChild coverage for the browser fix.
describe("findWaitingPlanChild — the spec 046 Amendment 1 regression, caught before implementation", () => {
  function byId(...tasks: TaskRowLike[]): Map<string, TaskRowLike> {
    return new Map(tasks.map((t) => [t.id, t]))
  }

  test("finds the one real input-required child, ignoring completed/pending siblings", () => {
    const plan = task({ id: "plan-1", isPlan: true, childTaskIds: ["child-1", "child-2", "child-3"] })
    const children = byId(
      task({ id: "child-1", status: "completed" }),
      task({ id: "child-2", status: "input-required" }),
      task({ id: "child-3", status: "pending" }),
    )
    expect(findWaitingPlanChild(plan, children)?.id).toBe("child-2")
  })

  test("returns null for a non-plan task", () => {
    const notAPlan = task({ id: "task-1", isPlan: false })
    expect(findWaitingPlanChild(notAPlan, byId())).toBeNull()
  })

  test("returns null for a plan with no childTaskIds yet", () => {
    const freshPlan = task({ id: "plan-1", isPlan: true })
    expect(findWaitingPlanChild(freshPlan, byId())).toBeNull()
  })

  test("returns null for a plan whose children are not (yet) input-required", () => {
    const plan = task({ id: "plan-1", isPlan: true, childTaskIds: ["child-1"] })
    const children = byId(task({ id: "child-1", status: "working" }))
    expect(findWaitingPlanChild(plan, children)).toBeNull()
  })

  test("the load-bearing property: never the newest child, never the plan itself — only the actually-waiting one", () => {
    const plan = task({ id: "plan-1", isPlan: true, childTaskIds: ["child-1", "child-2"] })
    const children = byId(
      task({ id: "child-1", status: "input-required" }),
      task({ id: "child-2", status: "completed" }), // newer, but not waiting
    )
    const found = findWaitingPlanChild(plan, children)
    expect(found?.id).toBe("child-1")
    expect(found?.id).not.toBe("plan-1")
    expect(found?.id).not.toBe("child-2")
  })
})

describe("waitingTasksForConversation — exact Chat approval binding", () => {
  test("deduplicates user/assistant links to one direct waiting task", () => {
    const waiting = task({ id: "task-1", status: "input-required" })
    const turns = [
      { role: "user" as const, taskId: "task-1" },
      { role: "assistant" as const, taskId: "task-1" },
    ]
    expect(waitingTasksForConversation(turns, new Map([[waiting.id, waiting]])).map((item) => item.id)).toEqual(["task-1"])
  })

  test("resolves a plan to its waiting child, never the plan root", () => {
    const plan = task({ id: "plan-1", isPlan: true, childTaskIds: ["child-1"] })
    const child = task({ id: "child-1", status: "input-required" })
    const result = waitingTasksForConversation(
      [{ role: "user", taskId: "plan-1" }],
      new Map([[plan.id, plan], [child.id, child]]),
    )
    expect(result.map((item) => item.id)).toEqual(["child-1"])
  })

  test("returns all exact candidates so multiple approvals can be refused as ambiguous", () => {
    const first = task({ id: "task-1", status: "input-required" })
    const second = task({ id: "task-2", status: "input-required" })
    const result = waitingTasksForConversation(
      [{ role: "user", taskId: first.id }, { role: "user", taskId: second.id }],
      new Map([[first.id, first], [second.id, second]]),
    )
    expect(result.map((item) => item.id)).toEqual(["task-1", "task-2"])
  })

  test("completed and working tasks do not become approval candidates", () => {
    const completed = task({ id: "task-1", status: "completed" })
    const working = task({ id: "task-2", status: "working" })
    expect(waitingTasksForConversation(
      [{ role: "user", taskId: completed.id }, { role: "user", taskId: working.id }],
      new Map([[completed.id, completed], [working.id, working]]),
    )).toEqual([])
  })
})

describe("computeShellLayout — specs/069 Phase 1 responsive shell geometry", () => {
  test("80×24 (the hard minimum): both rails collapse away, centre is full width minus root padding", () => {
    const l = computeShellLayout({ width: 80, height: 24 })
    expect(l.leftRailMode).toBe("hidden")
    expect(l.leftRailWidth).toBe(0)
    expect(l.showRightRail).toBe(false)
    expect(l.rightRailWidth).toBe(0)
    expect(l.centerWidth).toBe(80 - 2) // byte-close to today's full-width render
  })

  test("84..99: left rail is a narrow strip, right rail still hidden, one-col gap subtracted", () => {
    const l = computeShellLayout({ width: 90, height: 30 })
    expect(l.leftRailMode).toBe("strip")
    expect(l.leftRailWidth).toBe(RAIL_STRIP_WIDTH)
    expect(l.showRightRail).toBe(false)
    expect(l.centerWidth).toBe(90 - 2 - RAIL_STRIP_WIDTH - 1)
  })

  test("100..109: left rail full width, right rail still hidden", () => {
    const l = computeShellLayout({ width: 104, height: 30 })
    expect(l.leftRailMode).toBe("full")
    expect(l.leftRailWidth).toBe(RAIL_FULL_WIDTH)
    expect(l.showRightRail).toBe(false)
    expect(l.centerWidth).toBe(104 - 2 - RAIL_FULL_WIDTH - 1)
  })

  test(">=110: all three regions, both gaps subtracted", () => {
    const l = computeShellLayout({ width: 140, height: 40 })
    expect(l.leftRailMode).toBe("full")
    expect(l.showRightRail).toBe(true)
    expect(l.rightRailWidth).toBe(RIGHT_RAIL_WIDTH)
    expect(l.centerWidth).toBe(140 - 2 - RAIL_FULL_WIDTH - 1 - RIGHT_RAIL_WIDTH - 1)
  })

  test("the right rail is only offered when it AND a comfortable centre both fit", () => {
    // width 110 is the raw threshold, but the centre would fall below
    // CENTER_MIN_WIDTH once the right rail is taken — so it isn't.
    const tight = computeShellLayout({ width: 110, height: 30 })
    if (tight.showRightRail) {
      expect(tight.centerWidth).toBeGreaterThanOrEqual(CENTER_MIN_WIDTH)
    }
    // somewhere wide enough it definitely appears
    expect(computeShellLayout({ width: 160, height: 30 }).showRightRail).toBe(true)
  })

  test("centre width never goes below 1 and never below CENTER_MIN_WIDTH while the right rail is shown", () => {
    for (let w = 80; w <= 220; w += 1) {
      const l = computeShellLayout({ width: w, height: 30 })
      expect(l.centerWidth).toBeGreaterThanOrEqual(1)
      if (l.showRightRail) expect(l.centerWidth).toBeGreaterThanOrEqual(CENTER_MIN_WIDTH)
    }
  })

  test("the shown regions plus their gaps never exceed the usable width", () => {
    for (let w = 80; w <= 220; w += 3) {
      const l = computeShellLayout({ width: w, height: 30 })
      const leftCost = l.leftRailWidth > 0 ? l.leftRailWidth + 1 : 0
      const rightCost = l.showRightRail ? l.rightRailWidth + 1 : 0
      expect(leftCost + l.centerWidth + rightCost).toBeLessThanOrEqual(w - 2)
    }
  })
})

describe("computeShellRegionHeight — specs/069 Phase 1", () => {
  test("subtracts root padding, header, gap and footer from the terminal height", () => {
    expect(computeShellRegionHeight({ height: 24 })).toBe(24 - 2 - 3 - 1 - 1)
    expect(computeShellRegionHeight({ height: 40 })).toBe(40 - 2 - 3 - 1 - 1)
  })

  test("floors at 3 on a pathologically short terminal", () => {
    expect(computeShellRegionHeight({ height: 5 })).toBe(3)
  })
})

// specs/099-tui-port-url-and-analyze-project-stack-awareness/spec.md
describe("resolveOrchestratorUrl", () => {
  test("with nothing set, resolves to the real default port, not a stray literal", () => {
    expect(resolveOrchestratorUrl({})).toBe("http://localhost:3000")
  })

  test("ORCHESTRAI_ORCHESTRATOR_PORT is honored when set — the exact bug this spec fixes", () => {
    expect(resolveOrchestratorUrl({ [SERVICE_PORT_ENV_VARS.orchestrator]: "5000" })).toBe("http://localhost:5000")
  })

  test("an explicit ORCHESTRAI_ORCHESTRATOR_URL always wins, even over a real port override", () => {
    expect(
      resolveOrchestratorUrl({
        ORCHESTRAI_ORCHESTRATOR_URL: "http://example.com:9999",
        [SERVICE_PORT_ENV_VARS.orchestrator]: "5000",
      }),
    ).toBe("http://example.com:9999")
  })
})

// specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md — the
// collapsed-by-default chat display, scoped to the most recent
// assistant turn only.
describe("resolveChatTurnDisplay — collapsed-by-default chat answers", () => {
  test("no summary at all: always shows the full text, nothing to collapse", () => {
    const turn = { role: "assistant" as const, text: "full answer" }
    expect(resolveChatTurnDisplay(turn, true, false)).toEqual({
      text: "full answer",
      hasCollapsedContent: false,
      showingFull: true,
    })
  })

  test("summary equal to text is treated as nothing to collapse (defensive — real callers never produce this)", () => {
    const turn = { role: "assistant" as const, text: "same", summary: "same" }
    expect(resolveChatTurnDisplay(turn, true, false)).toEqual({
      text: "same",
      hasCollapsedContent: false,
      showingFull: true,
    })
  })

  test("a real summary on the LAST turn, collapsed: shows the summary", () => {
    const turn = { role: "assistant" as const, text: "full report text", summary: "short answer" }
    expect(resolveChatTurnDisplay(turn, true, false)).toEqual({
      text: "short answer",
      hasCollapsedContent: true,
      showingFull: false,
    })
  })

  test("a real summary on the LAST turn, expanded: shows the full text", () => {
    const turn = { role: "assistant" as const, text: "full report text", summary: "short answer" }
    expect(resolveChatTurnDisplay(turn, true, true)).toEqual({
      text: "full report text",
      hasCollapsedContent: true,
      showingFull: true,
    })
  })

  test("a real summary on a NON-last turn always shows the summary, regardless of the expanded flag — only the last turn is ever expandable", () => {
    const turn = { role: "assistant" as const, text: "full report text", summary: "short answer" }
    expect(resolveChatTurnDisplay(turn, false, true)).toEqual({
      text: "short answer",
      hasCollapsedContent: true,
      showingFull: false,
    })
  })

  test("a user turn (never has a summary) always shows its own text", () => {
    const turn = { role: "user" as const, text: "what agents do you have?" }
    expect(resolveChatTurnDisplay(turn, false, false)).toEqual({
      text: "what agents do you have?",
      hasCollapsedContent: false,
      showingFull: true,
    })
  })
})

// specs/130 phase 2 — Details show the whole plan from GET /tasks/:id.
describe("formatPlanStepRows", () => {
  test("absent or empty steps produce no rows (the live STEP_* fallback applies)", () => {
    expect(formatPlanStepRows(undefined)).toEqual([])
    expect(formatPlanStepRows([])).toEqual([])
  })

  test("one row per step, in order, with skill, description and status (missing status reads pending)", () => {
    const rows = formatPlanStepRows([
      { order: 2, skill: "create-ci", description: "Add CI", status: "dispatched" },
      { order: 1, skill: "dockerize", description: "Write a Dockerfile", status: "completed" },
      { order: 3, skill: "generate-readme", description: "Docs" },
    ])
    expect(rows).toEqual([
      { key: "step-1", status: "completed", text: "1. [dockerize] Write a Dockerfile — completed" },
      { key: "step-2", status: "dispatched", text: "2. [create-ci] Add CI — dispatched" },
      { key: "step-3", status: "pending", text: "3. [generate-readme] Docs — pending" },
    ])
  })

  test("a long description is bounded", () => {
    const [row] = formatPlanStepRows([{ order: 1, skill: "x", description: "d".repeat(500), status: "failed" }])
    expect(row?.text).toContain("d".repeat(MAX_PLAN_STEP_DESCRIPTION_CHARS - 1) + "…")
    expect(row?.text).not.toContain("d".repeat(MAX_PLAN_STEP_DESCRIPTION_CHARS))
  })

  test("past the row cap, the last row says how many steps were left out", () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({ order: i + 1, skill: "s", description: `step ${i + 1}` }))
    const rows = formatPlanStepRows(steps, 5)
    expect(rows).toHaveLength(5)
    expect(rows[3]?.text).toBe("4. [s] step 4 — pending")
    expect(rows[4]?.text).toBe("… 8 more steps")
  })
})

// specs/130 phase 3 — grouped review of a specs/120 parallel-write batch.
describe("grouped batch review helpers", () => {
  const branchA = { id: "child-a", skill: "create-ci", assignedAgent: "devops-agent", approval: { actionId: "act-a", target: "/p/.github/workflows/ci.yml" } }
  const branchB = { id: "child-b", skill: "edit-files", assignedAgent: "coder-agent", approval: { actionId: "act-b", target: "2 files", files: [{ target: "/p/a.ts" }, { target: "/p/b.ts" }] } }

  test("resolveBatchParentId: Chat uses the newest waiting plan step's parent", () => {
    const waiting = [
      { id: "direct-1", text: "", status: "input-required" },
      { id: "child-1", text: "", status: "input-required", parentTaskId: "plan-old" },
      { id: "child-2", text: "", status: "input-required", parentTaskId: "plan-new" },
      { id: "direct-2", text: "", status: "input-required" },
    ]
    expect(resolveBatchParentId({ mode: "chat", waitingInThread: waiting })).toBe("plan-new")
    expect(resolveBatchParentId({ mode: "chat", waitingInThread: [waiting[0]!] })).toBeNull()
  })

  test("resolveBatchParentId: Tasks uses the selected plan, or the selected step's plan", () => {
    const plan = { id: "plan-1", text: "", status: "working", isPlan: true }
    const step = { id: "child-1", text: "", status: "input-required", parentTaskId: "plan-1" }
    const direct = { id: "t-1", text: "", status: "input-required" }
    expect(resolveBatchParentId({ mode: "tasks", waitingInThread: [], selectedTask: plan })).toBe("plan-1")
    expect(resolveBatchParentId({ mode: "tasks", waitingInThread: [], selectedTask: step })).toBe("plan-1")
    expect(resolveBatchParentId({ mode: "tasks", waitingInThread: [], selectedTask: direct })).toBeNull()
    expect(resolveBatchParentId({ mode: "tasks", waitingInThread: [], selectedTask: null })).toBeNull()
    expect(resolveBatchParentId({ mode: "agents", waitingInThread: [], selectedTask: plan })).toBeNull()
  })

  test("countWaitingPlanChildren counts only that plan's input-required steps", () => {
    const tasks = [
      { id: "c1", text: "", status: "input-required", parentTaskId: "p" },
      { id: "c2", text: "", status: "input-required", parentTaskId: "p" },
      { id: "c3", text: "", status: "completed", parentTaskId: "p" },
      { id: "c4", text: "", status: "input-required", parentTaskId: "other" },
    ]
    expect(countWaitingPlanChildren("p", tasks)).toBe(2)
    expect(countWaitingPlanChildren("none", tasks)).toBe(0)
  })

  test("formatBatchBranchLine shows the decision, skill, agent, and every target", () => {
    expect(formatBatchBranchLine(branchA, "approve")).toBe("[✓ approve] create-ci · devops-agent · /p/.github/workflows/ci.yml")
    expect(formatBatchBranchLine(branchB, "reject")).toBe("[✗ reject ] edit-files · coder-agent · /p/a.ts, /p/b.ts")
    expect(formatBatchBranchLine({ id: "x" }, "approve")).toBe("[✓ approve] task · agent · no target")
  })

  test("buildBatchDecisions lists every branch once with its OWN actionId; unset means approve", () => {
    expect(buildBatchDecisions([branchA, branchB], { "child-b": "reject" })).toEqual([
      { childTaskId: "child-a", actionId: "act-a", decision: "approve" },
      { childTaskId: "child-b", actionId: "act-b", decision: "reject" },
    ])
  })

  test("buildBatchDecisions refuses (null) when any branch lacks an actionId", () => {
    expect(buildBatchDecisions([branchA, { id: "child-c", approval: { target: "/p/x" } }], {})).toBeNull()
  })

  test("summarizeBatchDecisions counts approve and reject", () => {
    expect(summarizeBatchDecisions([branchA, branchB], {})).toBe("2 approve · 0 reject")
    expect(summarizeBatchDecisions([branchA, branchB], { "child-a": "reject" })).toBe("1 approve · 1 reject")
  })

  test("computeBatchListWindow keeps the selection visible and never runs past the end", () => {
    expect(computeBatchListWindow(0, 3, 12)).toBe(0)
    expect(computeBatchListWindow(0, 20, 12)).toBe(0)
    expect(computeBatchListWindow(11, 20, 12)).toBe(0)
    expect(computeBatchListWindow(12, 20, 12)).toBe(1)
    expect(computeBatchListWindow(19, 20, 12)).toBe(8)
    expect(computeBatchListWindow(99, 20, 12)).toBe(8)
  })
})

// specs/130 phase 4 — information parity helpers.
describe("information parity helpers", () => {
  const now = Date.parse("2026-09-25T12:00:00Z")

  test("formatRelativeTime: now / minutes / hours / days, and blank for missing or bad input", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("now")
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m")
    expect(formatRelativeTime("2026-09-25T09:00:00Z", now)).toBe("3h")
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d")
    expect(formatRelativeTime(now + 60_000, now)).toBe("now") // clock skew never goes negative
    expect(formatRelativeTime(null, now)).toBe("")
    expect(formatRelativeTime(undefined, now)).toBe("")
    expect(formatRelativeTime("not a date", now)).toBe("")
  })

  test("formatClockTime: local HH:MM, blank when missing", () => {
    expect(formatClockTime(new Date(2026, 8, 25, 9, 5).getTime())).toBe("09:05")
    expect(formatClockTime(undefined)).toBe("")
  })

  test("conversationStatusGlyph maps each task status to one cell", () => {
    expect(conversationStatusGlyph("input-required")).toBe("⏸")
    expect(conversationStatusGlyph("working")).toBe("⋯")
    expect(conversationStatusGlyph("pending")).toBe("⋯")
    expect(conversationStatusGlyph("completed")).toBe("✓")
    expect(conversationStatusGlyph("failed")).toBe("✗")
    expect(conversationStatusGlyph(null)).toBe("·")
  })

  test("formatBytes", () => {
    expect(formatBytes(88)).toBe("88B")
    expect(formatBytes(1536)).toBe("1.5KB")
    expect(formatBytes(64 * 1024)).toBe("64.0KB")
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0MB")
    expect(formatBytes(-1)).toBe("0B")
  })

  test("audit task ids: a task's own id plus the orch- id its agent records under", () => {
    expect(auditTaskIdsFor("task-1")).toEqual(["task-1", "orch-task-1"])
    expect(auditTaskIdsFor("orch-task-1")).toEqual(["orch-task-1"])
    expect(auditRowMatchesTask("orch-child-9", "child-9")).toBe(true)
    expect(auditRowMatchesTask("child-9", "child-9")).toBe(true)
    expect(auditRowMatchesTask("child-10", "child-9")).toBe(false)
    expect(auditRowMatchesTask(null, "child-9")).toBe(false)
  })

  test("status filter cycles all → waiting → running → failed → completed → all", () => {
    expect(nextTaskStatusFilter("all")).toBe("waiting")
    expect(nextTaskStatusFilter("waiting")).toBe("running")
    expect(nextTaskStatusFilter("running")).toBe("failed")
    expect(nextTaskStatusFilter("failed")).toBe("completed")
    expect(nextTaskStatusFilter("completed")).toBe("all")
    expect(matchesTaskStatusFilter("input-required", "waiting")).toBe(true)
    expect(matchesTaskStatusFilter("assigned", "running")).toBe(true)
    expect(matchesTaskStatusFilter("completed", "running")).toBe(false)
    expect(matchesTaskStatusFilter("failed", "failed")).toBe(true)
    expect(matchesTaskStatusFilter("anything", "all")).toBe(true)
  })

  test("computeVisibleTasks applies the status filter after hide-done, and 'all' changes nothing", () => {
    const base = {
      tasks: [
        { id: "a", text: "a", status: "input-required" },
        { id: "b", text: "b", status: "working" },
        { id: "c", text: "c", status: "failed" },
      ],
      directTasks: [],
      remoteAgentTasks: [],
      agentFilter: null,
      dismissedIds: new Set<string>(),
      hideDone: false,
    }
    expect(computeVisibleTasks(base).visibleTasks.map((t) => t.id)).toEqual(["a", "b", "c"])
    expect(computeVisibleTasks({ ...base, statusFilter: "all" }).visibleTasks.map((t) => t.id)).toEqual(["a", "b", "c"])
    expect(computeVisibleTasks({ ...base, statusFilter: "waiting" }).visibleTasks.map((t) => t.id)).toEqual(["a"])
    expect(computeVisibleTasks({ ...base, statusFilter: "failed", hideDone: true }).visibleTasks).toEqual([])
  })

  test("formatTaskRowText: chat marker and child-of prefix, as the dashboard labels rows", () => {
    expect(formatTaskRowText({ id: "t", text: "dockerize", status: "working" }, false)).toBe("dockerize")
    expect(formatTaskRowText({ id: "t", text: "dockerize", status: "working" }, true)).toBe("chat · dockerize")
    expect(
      formatTaskRowText({ id: "child-1", text: "create-ci: x", status: "working", parentTaskId: "task-fa0f6522-ff99-4708" }, false),
    ).toBe("child of fa0f6522 · create-ci: x")
    expect(shortTaskId("task-fa0f6522-ff99")).toBe("fa0f6522")
    expect(shortTaskId("plain")).toBe("plain")
  })
})

// specs/135 — header line 1 must never wrap: a wrap added a third header row
// and pushed the Audit/Chat titles off screen at 80×24.
describe("formatHeaderStatus", () => {
  // "OrchestrAI   [1 Chat]   2 Tasks   3 Agents   4 Audit" — one label is
  // always bracketed, so the labels are always this long.
  const LABELS = "OrchestrAI   [1 Chat]   2 Tasks   3 Agents   4 Audit".length
  const availableAt = (width: number) => width - 2 - LABELS
  const states = ["connecting", "connected", "disconnected"] as const

  test.each([80, 110, 140])("at %i columns the status fits the space the labels leave, for every state", (width) => {
    for (const conn of states) {
      for (const [online, total] of [[0, 0], [6, 6], [99, 99]]) {
        const status = formatHeaderStatus({ available: availableAt(width), conn, online: online!, total: total! })
        expect(LABELS + status.length).toBeLessThanOrEqual(width - 2)
      }
    }
  })

  test("80 columns uses the compact form; 110 and 140 keep today's full form", () => {
    expect(formatHeaderStatus({ available: availableAt(80), conn: "connected", online: 2, total: 2 }).trim()).toBe("● live 2/2")
    expect(formatHeaderStatus({ available: availableAt(110), conn: "connected", online: 2, total: 2 }).trim()).toBe("● live · 2/2 agents")
    expect(formatHeaderStatus({ available: availableAt(140), conn: "disconnected", online: 0, total: 1 }).trim()).toBe("● disconnected · 0/1 agents")
  })

  test("each form is fixed-width across states and counts (the redraw rule)", () => {
    for (const conn of states) {
      expect(formatHeaderStatus({ available: availableAt(80), conn, online: 1, total: 9 })).toHaveLength(HEADER_STATUS_COMPACT_BUDGET)
      expect(formatHeaderStatus({ available: availableAt(140), conn, online: 1, total: 9 })).toHaveLength(HEADER_STATUS_FULL_BUDGET)
    }
  })

  test("never longer than the space available, even when that is tiny", () => {
    expect(formatHeaderStatus({ available: 5, conn: "connected", online: 1, total: 1 })).toHaveLength(5)
    expect(formatHeaderStatus({ available: -3, conn: "connected", online: 1, total: 1 })).toBe("")
  })
})

// specs/139 C — an Audit row is always one line.
describe("fitAuditRow", () => {
  const rowLength = (input: Parameters<typeof fitAuditRow>[0]) => {
    const { caller, target, tail } = fitAuditRow(input)
    return 1 + 1 + input.time.length + 1 + input.badge.length + 1 + caller.length + 3 + target.length + tail.length
  }
  const longest = {
    time: "12:59:59 PM",
    badge: "EXEC",
    caller: "orchestrator-supervisor",
    target: "read_project_file:packages/agents/documentation/some/deeply/nested/path.ts",
    tail: " · completed · 120000ms · 64.0KB trunc",
    compactTail: " · 120000ms · 64.0KB trunc",
  }

  test.each([[80, 24], [110, 30], [140, 40]])("at %ix%i the longest real row fits the Audit box", (width, height) => {
    const { centerWidth } = computeShellLayout({ width, height })
    const available = centerWidth - 5
    expect(rowLength({ available, ...longest })).toBeLessThanOrEqual(available)
  })

  test("the observed 80-column wrap (A2A orchestrator-supervisor → git-status … 1020ms · 0B) now fits", () => {
    const { centerWidth } = computeShellLayout({ width: 80, height: 24 })
    const input = { available: centerWidth - 5, time: "9:03:51 AM", badge: "A2A", caller: "orchestrator-supervisor", target: "git-status", tail: " · completed · 1020ms · 0B" }
    expect(rowLength(input)).toBeLessThanOrEqual(input.available)
    expect(fitAuditRow(input).target).toBe("git-status")
  })

  test("nothing is clipped when everything fits; the target keeps space before the caller shrinks", () => {
    expect(fitAuditRow({ available: 200, ...longest })).toEqual({ caller: longest.caller, target: longest.target, tail: longest.tail })
    const tight = fitAuditRow({ available: 70, ...longest })
    expect(tight.caller.length).toBeGreaterThanOrEqual(AUDIT_CALLER_MIN_WIDTH)
    expect(tight.target.endsWith("…")).toBe(true)
  })

  test("clipText", () => {
    expect(clipText("abcdef", 10)).toBe("abcdef")
    expect(clipText("abcdef", 4)).toBe("abc…")
    expect(clipText("abcdef", 1)).toBe("…")
    expect(clipText("abcdef", 0)).toBe("")
  })
})

describe("fitAuditRow — tail fallback", () => {
  test("a narrow centre drops the outcome word first, and clips only as a last resort", () => {
    const base = { time: "12:59:59 PM", badge: "EXEC", caller: "orchestrator-supervisor", target: "git_status", tail: " · completed · 120000ms · 64.0KB trunc", compactTail: " · 120000ms · 64.0KB trunc" }
    expect(fitAuditRow({ available: 60, ...base }).tail).toBe(base.compactTail)
    const tiny = fitAuditRow({ available: 30, ...base })
    expect(tiny.tail.length).toBeLessThanOrEqual(30 - (1 + 1 + 11 + 1 + 4 + 1 + 3))
  })
})
