

import { AGENT_OFFLINE_AFTER_FAILURES, AgentLivenessTracker } from "./agent-liveness"
import { buildPlanStepText } from "../../packages/shared/plan-step-text"
import { Hono } from "hono"
import { serve } from "bun"
import { resolve as resolvePath } from "node:path"
import { allocateId } from "../../packages/shared/ids"
import { parseOrchestratorSubmission, type CapabilityEntry } from "../../packages/shared/task-envelope"
import { normalizeAgentCapabilities, type AgentCapabilitySource } from "../../packages/shared/agent-capabilities"
import type { ApprovalPreview } from "../../packages/shared/approval"
import { agents as agentRegistry } from "../../packages/shared/agent-registry"
import { resolveServicePort } from "../../packages/shared/service-ports"
import { resolveTargetPath } from "../../packages/shared"
import { callAgent } from "../../packages/shared/a2a-client"
import {
  toSseFrame,
  validateAgUiEvent,
  type AgUiEvent,
  type RunFinishedOutcome,
} from "../../packages/shared/ag-ui-events"
import { mapAuditPushToAgUiEvent, mapAuditPushToAuditEventValue } from "../../packages/shared/ag-ui-mapping"
import { emitAuditEvent, emitAuditStart, boundTaskResult, truncateUtf8, flushAuditBufferForShutdown } from "../../packages/shared/audit"
import { OrchestraiMcpClient } from "../../packages/shared/mcp-client"
import { buildChatModel, describeLlmModelConfig, readLlmModelConfig } from "../../packages/shared/llm-model-factory"
import { runCapabilityRouter, UNSUPPORTED_SKILL_ID, type CapabilityRouterProposal } from "../../packages/shared/capability-router"
// specs/105-orchestrator-fallback-deep-analysis/spec.md — the same
// shared implementation DevOps's own analyze-project skill now imports
// (packages/agents/devops/index.ts), so the Orchestrator's own fallback
// paths never carry a second, independently-drifting copy.
import { getCachedProjectAnalysis, runProjectAnalysisHarness, renderCodebaseAnalysis, setCachedProjectAnalysis } from "../../packages/shared/project-analysis"
import { getSharedStore, type CachedResultRow } from "../../packages/shared/store"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import {
  runSupervisor,
  classifySkillTier,
  resolveSupervisorMaxDispatches,
  type DispatchResult,
  type SupervisorDeps,
  type WaitResult,
} from "./supervisor-graph"
import { classifyAsk, type AnswerTier, type AskClassification } from "./ask-classifier"
import { runAnswerHarness } from "./answer-harness"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ============================================================
// TYPES
// ============================================================
export interface AgentSkill {
  id: string
  name: string
  description: string
}

export interface AgentCard {
  name: string
  description: string
  url: string
  version: string
  skills: AgentSkill[]
}

export interface RegisteredAgent {
  card: AgentCard
  url: string
  status: "online" | "offline"
  lastSeen: Date
}

export interface OrchestratorTask {
  id: string
  text: string
  skill: string
  assignedAgent?: string
  agentTaskId?: string
  status: "pending" | "assigned" | "working" | "input-required" | "completed" | "failed"
  result?: string
  error?: string
  approval?: ApprovalPreview
  createdAt: Date

  // Plan execution — parent/child relationships
  isPlan?: boolean              // true if this is a parent plan task
  parentTaskId?: string         // set on child tasks
  childTaskIds?: string[]       // set on parent plan tasks
  planSteps?: PlanStep[]        // parsed steps from plan
}

export interface PlanStep {
  order: number
  skill: string
  description: string
  childTaskId?: string          // set once dispatched
  status?: "pending" | "dispatched" | "completed" | "failed"
}

// ============================================================
// CONVERSATIONS (specs/044-conversational-ask-layer/spec.md — Phase 1)
// ============================================================
// The first multi-turn state this runtime has ever had. The same
// in-memory Map every other live store here starts as — but as of
// specs/107-task-and-conversation-history/spec.md B5, every turn is
// also durably persisted (fail-open, ORCHESTRAI_PERSIST=0 to disable),
// so a restart no longer loses history: see loadRecentConversationsFromStore()
// below, called once at startup.
export interface ConversationTurn {
  id: string
  role: "user" | "assistant"
  text: string
  timestamp: number
  /** How the question was classified. Present on the originating user turn
   *  once it dispatches work and on the eventual assistant result turn. */
  tier?: AnswerTier
  skill?: string
  reason?: string
  /** Set when this turn originated from, or answers, a real dispatched task,
   *  so the chat is a view onto the existing task/approval machinery rather
   *  than a parallel one. */
  taskId?: string
  /** specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md — set only
   *  when synthesizeAnswer() actually ran for a "state"/"failure" Tier 0
   *  answer (never for "conversation", which has nothing to summarize
   *  separately from its own already-complete reply — see that spec's
   *  own item 1). Holds just the synthesized paragraph; `text` stays the
   *  full, unchanged synthesized+raw value regardless — this field is a
   *  strictly additive default-view convenience, never a replacement. */
  summary?: string
}

export interface Conversation {
  id: string
  createdAt: Date
  turns: ConversationTurn[]
  /** specs/107 B5 — the next seq value to write for this conversation's
   *  own turns row. Deliberately independent of turns.length: the
   *  in-memory array is trimmed to MAX_TURNS_PER_CONVERSATION
   *  (evictOldestConversationsIfNeeded's own sibling, appendTurn()'s
   *  splice), which would silently collide seq numbers with an earlier
   *  part of the same conversation if length were reused as the counter. */
  turnSeq?: number
}

// ============================================================
// STORE
// ============================================================
export const registry = new Map<string, RegisteredAgent>()
export const tasks    = new Map<string, OrchestratorTask>()

// specs/106-persistence-store-and-result-cache/spec.md B3 — retires
// specs/057's own in-memory, conversation-scoped ProjectSnapshotCache in
// favor of the durable, cross-process store's result_cache table.
// Behaviors carried over unchanged: the 5-minute TTL, the git-fingerprint
// cross-check before serving an analyze-project hit, and the
// explicit-refresh bypass. One behavior deliberately changes: the store's
// key has no conversation id in it, so an entry survives a restart and is
// visible across conversations/processes — the entire point of retiring
// the second, differently-scoped cache (this codebase has already been
// bitten once by one rule living in three places, specs/015's
// `ci`-substring bug). dispatchRootTask() below still gates every read
// and write on `conversationId` being present at all — a bare POST
// /tasks never consults or populates the cache, unchanged from
// specs/057's own original rule; that gate is a product-behavior choice
// (a stateless one-off dispatch doesn't participate in caching), not a
// scoping mechanism, so it survives this migration untouched.
const RESULT_CACHE_SCHEMA_VER = 1
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000
const RESULT_CACHE_INPUT_HASH = "none"
const RESULT_CACHE_TARGET_REL = "."
// A request whose raw text contains one of these words skips the cache
// check entirely, treated as a genuine miss — "a user can explicitly
// request a refresh."
const EXPLICIT_REFRESH_PATTERN = /\b(refresh|recheck|re-check|latest|again)\b/i

// ============================================================
// ORCHESTRATOR'S OWN PROJECT INSPECTION (read-only, strictly optional)
// ============================================================
// specs/102-orchestrator-readonly-project-inspection/spec.md — the
// Orchestrator's own MCP client, bound to the same four
// general-inspection tools specs/101 gave every code-reasoning agent.
// Never advertised as a skill: it never enters buildCapabilitySnapshot(),
// never appears in any Agent Card, so no skill id gains a second owner
// and specs/101's own collision guard is unaffected by this existing.
//
// Opt-out via ORCHESTRAI_ORCHESTRATOR_INSPECTION=0, the same !== "0"
// convention specs/077 established for every agent-level harness flag —
// absent, empty, or anything but "0" means on.
function isOrchestratorInspectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORCHESTRAI_ORCHESTRATOR_INSPECTION !== "0"
}

// Construction is wrapped in try/catch, unlike every existing agent's
// own module-scope client construction. validateMcpUrl()
// (packages/shared/mcp-client.ts) throws synchronously for a malformed/
// non-http:/non-allowlisted ORCHESTRAI_MCP_URL, and every agent treats
// that as an acceptable hard module-load crash — correct for a required
// agent, never acceptable for the component that coordinates everything.
// A construction failure here degrades to "no client" with a named
// warning, never a startup crash. Never start()ed eagerly either — the
// client's own existing lazy-connect design (construction does no I/O;
// the first real callTool() self-starts it, bounded by its own
// TASK_RECONNECT_WINDOW_MS) is exactly the "strictly optional" shape
// this capability needs, already built, not reinvented here.
//
// Extracted into its own function (rather than inline module-scope
// logic only) so a test can directly prove "a malformed
// ORCHESTRAI_MCP_URL degrades to null, never throws" without needing to
// re-import this whole module under a different environment.
export function buildOrchestratorMcpClient(env: NodeJS.ProcessEnv = process.env): OrchestraiMcpClient | null {
  if (!isOrchestratorInspectionEnabled(env)) return null
  try {
    return new OrchestraiMcpClient({
      callerName: "orchestrator",
      requiredTools: ["analyze_project", "read_project_file", "git_status", "git_diff"],
      url: env.ORCHESTRAI_MCP_URL,
    })
  } catch (err) {
    console.warn(`[orchestrator] project inspection disabled — MCP client construction failed: ${errorMessage(err)}`)
    return null
  }
}

export let orchestratorMcpClient: OrchestraiMcpClient | null = buildOrchestratorMcpClient()

// Test-only seam, mirroring __setTestRouterModel()'s own established
// shape elsewhere in this file — an ES module's exported `let` cannot
// be reassigned from outside it, so degradation tests (no client / a
// fake client whose callTool() throws) need this to inject a fixture
// without a real network dependency or module-cache gymnastics.
export function __setTestOrchestratorMcpClient(client: OrchestraiMcpClient | null): void {
  orchestratorMcpClient = client
}

interface RawProjectInspection {
  target: string
  analysis: string
  gitStatus: string
}

// specs/102 — the single place the "strictly optional" guarantee lives,
// and the single place both real callers (the supervisor's own pre-run
// grounding, and dispatchRootTask()'s no-agent fallback) get their data
// from — so there is exactly one cache-consulting/populating code path,
// not two that could drift. Every failure path returns null, never
// throws. auditTaskId is passed by the caller (rather than derived
// here) so a supervisor-run inspection can be correlated to its own
// plan's real run via the established "orch-<taskId>" convention
// buildOrchestratorSupervisorDeps() already uses elsewhere.
//
// Cache-first, not a fresh call every time — specs/106's durable
// result_cache, migrated off specs/057's own original in-memory cache.
//
// specs/103-deep-project-analysis/spec.md — amends specs/102's own
// original decision to share one cache entry with a real dispatched
// analyze-project skill result (identical key shape,
// "whichever happens first in a conversation grounds the other for
// free"). That was correct only while both produced identical shallow
// tool output; specs/103 makes DevOps's own analyze-project skill
// genuinely richer than this tool-only call, so sharing a key would let
// this shallow inspection silently pre-populate the cache with the
// SHALLOW result and starve a later real analyze-project request of the
// deep one. Fixed with a distinct cache key
// (ORCHESTRATOR_INSPECTION_CACHE_SKILL) — this inspection and a real
// dispatched analyze-project no longer collide.
const ORCHESTRATOR_INSPECTION_CACHE_SKILL = "orchestrator-analyze-project-inspection"

// A first draft of this spec called the tools unconditionally on every
// run; Yusuf caught it directly in review ("but that will analyze the
// project with each plan? why while if it done it once already?") — see
// specs/102's own spec.md for the corrected design this implements. A
// bare POST /tasks (no conversationId) never touches the cache at all,
// matching specs/057's own existing rule exactly.
async function fetchProjectInspection(
  taskText: string,
  auditTaskId: string,
  conversationId?: string,
): Promise<RawProjectInspection | null> {
  if (!orchestratorMcpClient) return null
  const target = tryResolveTargetPathForCache(taskText)
  if (!target) return null

  if (conversationId) {
    const cached = getSharedStore()?.getCachedResult({
      kind: ORCHESTRATOR_INSPECTION_CACHE_SKILL, projectRoot: target, targetRel: RESULT_CACHE_TARGET_REL,
      inputHash: RESULT_CACHE_INPUT_HASH, schemaVer: RESULT_CACHE_SCHEMA_VER,
    })
    if (cached) {
      try {
        const freshGitStatus = await orchestratorMcpClient.callTool("git_status", { repo_path: target }, auditTaskId)
        if (freshGitStatus === cached.gitFingerprint) {
          return { target, analysis: cached.result, gitStatus: freshGitStatus }
        }
        // Cross-check mismatch — real drift since the cache was
        // populated. Fall through to a genuine fresh fetch below, the
        // same handling resolveAnalyzeProjectFromCacheOrRedispatch()
        // already applies for a real dispatched analyze-project.
      } catch {
        // Cross-check call itself failed — treat exactly like a cache
        // miss rather than surfacing an error for what is, from the
        // caller's perspective, only ever an optional enhancement.
      }
    }
  }

  try {
    const [analysis, gitStatus] = await Promise.all([
      orchestratorMcpClient.callTool("analyze_project", { project_path: target }, auditTaskId),
      orchestratorMcpClient.callTool("git_status", { repo_path: target }, auditTaskId),
    ])
    if (conversationId) {
      getSharedStore()?.setCachedResult({
        kind: ORCHESTRATOR_INSPECTION_CACHE_SKILL, projectRoot: target, targetRel: RESULT_CACHE_TARGET_REL,
        inputHash: RESULT_CACHE_INPUT_HASH, schemaVer: RESULT_CACHE_SCHEMA_VER,
        result: analysis, gitFingerprint: gitStatus, ttlMs: RESULT_CACHE_TTL_MS, producer: "orchestrator",
      })
    }
    return { target, analysis, gitStatus }
  } catch {
    return null
  }
}

// specs/105-orchestrator-fallback-deep-analysis/spec.md — the second of
// this spec's two call sites for the shared analysis module (the first
// is DevOps's own skill, unchanged). Deliberately separate from
// fetchProjectInspection() above: that function must stay fast and
// LLM-free forever (specs/103's constraint 1 — it grounds every single
// plan-task run), so this function reuses its CACHED raw result rather
// than adding a provider call to that path. Callers decide when it is
// worth the cost (the zero-dispatch case in runOrchestratorSupervisor(),
// and the explicit-skill fallback below) — this function itself has no
// opinion on when it's appropriate to call.
//
// Key-gated, not flag-gated (specs/038's own precedent for exactly this
// shape): no resolvable "orchestrator" key silently returns null, same
// as every other failure here. Fail-open throughout, matching specs/103
// — every caller treats null as "fall back to the shallow text",
// never as an error.

// Test-only seam, mirroring __setTestRouterModel()'s own established
// shape — lets a test prove the zero-dispatch → deep-analysis wiring
// without a real provider key, the same reasoning that seam already
// established for the capability router.
let __testProjectAnalysisModel: BaseChatModel | null = null
export function __setTestProjectAnalysisModel(model: BaseChatModel | null): void {
  __testProjectAnalysisModel = model
}

export async function computeDeepProjectAnalysis(taskText: string, auditTaskId: string, conversationId?: string): Promise<string | null> {
  if (!orchestratorMcpClient) return null
  const raw = await fetchProjectInspection(taskText, auditTaskId, conversationId)
  if (!raw) return null

  // specs/106-persistence-store-and-result-cache/spec.md — a real local
  // database read, no LLM call, no provider cost. A result computed by
  // DevOps's own skill (specs/103/105), or by a prior Orchestrator run
  // even after a restart, is reused here for free.
  const cached = await getCachedProjectAnalysis(raw.target, orchestratorMcpClient, auditTaskId)
  if (cached) return renderCodebaseAnalysis(cached)

  let model: BaseChatModel
  if (__testProjectAnalysisModel) {
    model = __testProjectAnalysisModel
  } else {
    let config: ReturnType<typeof readLlmModelConfig>
    try {
      config = readLlmModelConfig(process.env, "orchestrator")
    } catch {
      return null
    }
    if (!config) return null
    try {
      model = await buildChatModel(config)
    } catch {
      return null
    }
  }

  try {
    const result = await runProjectAnalysisHarness({
      model,
      mcpClient: orchestratorMcpClient,
      taskId: auditTaskId,
      projectRoot: raw.target,
      deterministicReport: raw.analysis,
    })
    if (!result) return null
    // A real fresh git_status is already in hand here (raw.gitStatus,
    // fetched alongside the analysis by fetchProjectInspection() above)
    // — unlike DevOps's own write site, which has no cheap fingerprint
    // and passes null, this one gets the tighter, fingerprint-checked
    // validity.
    setCachedProjectAnalysis(raw.target, result, raw.gitStatus, "orchestrator")
    return renderCodebaseAnalysis(result)
  } catch {
    return null
  }
}

// A system-prompt grounding block, not a task result — TASK_RESULT_MAX_BYTES
// (64 KiB) is the wrong scale for something injected into every plan-task
// prompt. Small enough to stay a cheap addition to the prompt, large
// enough to carry a real analyze-project summary plus a git-status line.
const PROJECT_CONTEXT_MAX_BYTES = 4096

// specs/102 — used only for supervisor prompt grounding. The no-agent
// task-result fallback below deliberately does NOT use this: a real
// completed task's result gets the normal 64 KiB boundTaskResult()
// bound and the single skill-appropriate raw tool output, not this
// compact, combined, prompt-sized block.
export async function inspectTargetProject(
  taskText: string,
  auditTaskId: string,
  conversationId?: string,
): Promise<string | null> {
  const raw = await fetchProjectInspection(taskText, auditTaskId, conversationId)
  if (!raw) return null
  const block = [
    `=== Target Project (real, resolved path — use this, never a guess) ===`,
    raw.target,
    ``,
    raw.analysis,
    ``,
    `=== Git Status ===`,
    raw.gitStatus,
  ].join("\n")
  return truncateUtf8(block, PROJECT_CONTEXT_MAX_BYTES)
}

// specs/102 — dispatchRootTask()'s own no-agent fallback: when the
// unreachable skill is one direct inspection can genuinely answer,
// complete the task from that instead of failing outright. Returns the
// SINGLE skill-appropriate raw result (never the combined prompt-context
// block above), bound the same way every other read-only task result
// in this codebase already is.
export const INSPECTION_FALLBACK_SKILLS = new Set(["analyze-project", "git-status"])

export async function inspectTargetProjectAsTaskResult(
  skill: string,
  taskText: string,
  auditTaskId: string,
  conversationId?: string,
): Promise<string | null> {
  if (!INSPECTION_FALLBACK_SKILLS.has(skill)) return null
  const raw = await fetchProjectInspection(taskText, auditTaskId, conversationId)
  if (!raw) return null
  if (skill === "analyze-project") {
    // specs/105 — appended after the shallow text, never replacing it;
    // a harness failure/no key returns null and this degrades to the
    // exact pre-105 shallow-only result.
    const deep = await computeDeepProjectAnalysis(taskText, auditTaskId, conversationId)
    return boundTaskResult(deep ? `${raw.analysis}\n\n${deep}` : raw.analysis).text
  }
  return boundTaskResult(raw.gitStatus).text
}

// specs/044 — bounded, per that spec's approved Open Question 2: a
// long-running process must not accumulate conversations without limit.
// Oldest-first eviction, same insertion-order guarantee Map already gives.
export const conversations = new Map<string, Conversation>()
export const MAX_CONVERSATIONS = 50
export const MAX_TURNS_PER_CONVERSATION = 100

function evictOldestConversationsIfNeeded(): void {
  while (conversations.size > MAX_CONVERSATIONS) {
    const oldest = conversations.keys().next()
    if (oldest.done) return
    conversations.delete(oldest.value)
  }
}

export function appendTurn(conversation: Conversation, turn: ConversationTurn): void {
  conversation.turns.push(turn)
  // Trim from the front so the most recent context always survives.
  if (conversation.turns.length > MAX_TURNS_PER_CONVERSATION) {
    conversation.turns.splice(0, conversation.turns.length - MAX_TURNS_PER_CONVERSATION)
  }
  persistConversationTurn(conversation, turn)
}

// specs/107-task-and-conversation-history/spec.md B5 — the single write
// hook, since appendTurn() is the only place a turn is ever added
// (confirmed via a repo-wide grep — no direct `.turns.push()` elsewhere).
// Fail-open: a missing/disabled store means this is a no-op, exactly
// like every other store.ts caller in this codebase.
function persistConversationTurn(conversation: Conversation, turn: ConversationTurn): void {
  const store = getSharedStore()
  if (!store) return
  const seq = conversation.turnSeq ?? 0
  conversation.turnSeq = seq + 1
  try {
    store.upsertConversation({
      id: conversation.id, title: null,
      createdAt: conversation.createdAt.getTime(), updatedAt: turn.timestamp,
    })
    store.appendTurnRow({
      conversationId: conversation.id, seq, role: turn.role, content: turn.text, createdAt: turn.timestamp,
    })
  } catch (err) {
    console.warn(`[orchestrator] conversation persistence failed for ${conversation.id}: ${errorMessage(err)}`)
  }
}

// specs/107 B5 — loaded once at startup so the chat rail and
// priorTurnsFor() see history from before a restart. A missing/disabled
// store means this simply loads nothing, matching every other fail-open
// path in this file.
export function loadRecentConversationsFromStore(): void {
  const store = getSharedStore()
  if (!store) return
  try {
    const rows = store.listRecentConversationsWithTurns(MAX_CONVERSATIONS)
    // Oldest-active first, so the Map's own insertion-order eviction
    // (evictOldestConversationsIfNeeded) treats the most recently active
    // conversation as newest, matching what a live process would have
    // produced had it never restarted.
    for (const row of [...rows].reverse()) {
      const conversation: Conversation = {
        id: row.id,
        createdAt: new Date(row.createdAt),
        turns: row.turns.map((t) => ({
          id: allocateId("turn", () => false),
          role: t.role as "user" | "assistant",
          text: t.content,
          timestamp: t.createdAt,
        })),
        turnSeq: row.turns.length > 0 ? (row.turns[row.turns.length - 1]!.seq + 1) : 0,
      }
      conversations.set(conversation.id, conversation)
    }
    if (rows.length > 0) console.log(`[orchestrator] loaded ${rows.length} conversation(s) from the store`)
  } catch (err) {
    console.warn(`[orchestrator] failed to load conversations from the store: ${errorMessage(err)}`)
  }
}

// ============================================================
// LIVE EVENTS — AG-UI-shaped events pushed to subscribed clients
// (browser dashboard, TUI) over SSE. See
// specs/021-ag-ui-event-protocol/spec.md for the full lifecycle mapping.
//
// The previous bare `{type: "task-update"|"agents-update"}` change-signal
// is gone: clients no longer refetch everything on every ping, they apply
// the typed event they receive. `agents-update` survives only as a CUSTOM
// event, since agent discovery has no AG-UI-native representation.
// ============================================================
type ChangeListener = (event: AgUiEvent) => void
const changeListeners = new Set<ChangeListener>()

/** Test-only: subscribes a listener to the live event stream the same way
 *  GET /events does internally, without standing up a real SSE connection.
 *  Returns an unsubscribe function. Matches this file's existing pattern of
 *  exporting otherwise-internal functions for direct testing (see
 *  findAgentForSkill, buildCapabilitySnapshot, etc., specs/030). */
export function subscribeToEvents(listener: ChangeListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

/** specs/027-ag-ui-core-adoption/spec.md's validation-failure policy: a
 *  failure is a programming error in OrchestrAI to report, not a runtime
 *  condition to tolerate silently or propagate. Logged loudly (so it's
 *  never silently swallowed), then emitted anyway — a schema disagreement
 *  must never take down the live stream a demo depends on. Regressions are
 *  caught by dedicated tests asserting `validateAgUiEvent()` directly
 *  against every event shape this module constructs, not by this runtime
 *  path throwing. */
export function emit(event: AgUiEvent) {
  const validation = validateAgUiEvent(event)
  if (!validation.ok) {
    console.warn(`AG-UI event failed schema validation: ${event.type} — ${validation.errors.join("; ")}`)
  }
  for (const listener of changeListeners) listener(event)
}

function now(): number {
  return Date.now()
}

// specs/044 — until this checkpoint, a task's own id was both threadId
// and runId, because there were no conversation threads for them to
// differ across. A task dispatched from POST /ask now belongs to a
// conversation, so threadId carries THAT id and runId stays the task's —
// which is what the protocol's two fields mean.
//
// Populated only for ask-dispatched tasks. Absent (every POST /tasks
// submission, every plan child) resolves to the task id exactly as
// before, so no existing event changes shape.
export const taskConversations = new Map<string, string>()

// specs/136 — the task endpoints expose which conversation dispatched a
// task (null when none), so every client can mark chat-originated tasks
// without loading threads. Additive: every other field is unchanged.
export function withConversationId(task: OrchestratorTask): OrchestratorTask & { conversationId: string | null } {
  return { ...task, conversationId: taskConversations.get(task.id) ?? null }
}

// specs/136 — a task's audit events are recorded under its own id (the
// Orchestrator's A2A calls) and under `orch-<id>` (the agent runs it under
// that id). An id already starting with `orch-` matches only itself.
export function auditTaskIdsForQuery(taskId: string): string[] {
  return taskId.startsWith("orch-") ? [taskId] : [taskId, `orch-${taskId}`]
}

function threadIdFor(taskId: string): string {
  return taskConversations.get(taskId) ?? taskId
}

function runStarted(taskId: string) {
  emit({ type: "RUN_STARTED", threadId: threadIdFor(taskId), runId: taskId, timestamp: now() })
}

/** `outcome` defaults to the official schema's `{type:"success"}` shape
 *  (specs/027-ag-ui-core-adoption/spec.md — the bare string this runtime
 *  emitted before did not validate against `RunFinishedEventSchema`). This
 *  runtime only ever calls this with the default: a task entering
 *  `input-required` emits a `CUSTOM orchestrai.approval-required` event
 *  and never reaches `runFinished()`, so the `"interrupt"` branch below has
 *  no live call site today — kept correct rather than removed so a future
 *  caller doesn't have to re-derive the official shape from scratch. */
function runFinished(taskId: string, outcome: RunFinishedOutcome = { type: "success" }) {
  emit({ type: "RUN_FINISHED", threadId: threadIdFor(taskId), runId: taskId, outcome, timestamp: now() })
}

function runError(taskId: string, message: string) {
  emit({ type: "RUN_ERROR", threadId: threadIdFor(taskId), runId: taskId, message, timestamp: now() })
}

function agentsUpdated() {
  emit({
    type: "CUSTOM",
    name: "orchestrai.agents-update",
    value: { count: registry.size },
    timestamp: now(),
  })
}

/** Emits the AG-UI event(s) implied by a task's CURRENT status. Called
 *  wherever the old code called broadcastChange({type:"task-update"}) —
 *  status is the single source of truth for which event that means, so
 *  callers don't each have to decide. Terminal/approval transitions are
 *  de-duplicated per task: applyAgentUpdate and the SSE stream watcher can
 *  both observe the same transition, and a run must not report finishing
 *  twice. */
const emittedTerminal = new Set<string>()
const emittedApproval = new Set<string>()

// specs/028-orchestrator-langgraph-supervisor/spec.md — a TRUSTED,
// Orchestrator-side record that a specific child task's rejection was
// genuinely forwarded through POST /tasks/:id/reject, populated exactly at
// that endpoint's own success point below. This is what the supervisor
// graph's classification adapter reads (via the injected `wait()` in this
// file) to distinguish a real rejection from an ordinary `failed` status —
// never from task.status or matching error text, which a human rejection
// and a genuine failure currently produce identically.
const rejectedByOrchestrator = new Set<string>()

// specs/089-plan-step-skip-continue/spec.md — the same TRUSTED,
// Orchestrator-side record pattern as rejectedByOrchestrator above, but for
// a skip: populated exactly at POST /tasks/:id/skip's own success point
// below. A skip is a genuinely distinct, non-terminal outcome — see
// supervisor-graph.ts's DispatchOutcome/classifyDispatchOutcome.
const skippedByOrchestrator = new Set<string>()

// Exported so specs/107's own persistence tests can drive a terminal
// transition directly, the same reasoning __setTestRouterModel() and
// friends already established for test-only visibility into otherwise-
// internal machinery.
export function emitTaskState(task: OrchestratorTask) {
  if (task.status === "input-required") {
    if (emittedApproval.has(task.id)) return
    emittedApproval.add(task.id)
    emit({
      type: "CUSTOM",
      name: "orchestrai.approval-required",
      value: {
        taskId: task.id,
        agent: task.assignedAgent,
        skill: task.skill,
        // INFORMATIONAL ONLY — approving still requires the real
        // POST /tasks/:id/approve request. See the spec's Safety
        // Constraints; a client must never treat this as authorization.
        approval: task.approval ?? null,
      },
      timestamp: now(),
    })
    return
  }

  if (task.status === "completed" || task.status === "failed") {
    if (emittedTerminal.has(task.id)) return
    emittedTerminal.add(task.id)
    persistTaskTerminal(task)
    if (task.status === "failed") runError(task.id, task.error ?? "Task failed")
    else runFinished(task.id)
    return
  }

  // "assigned"/"working" — no distinct AG-UI event; RUN_STARTED already
  // covered the transition into flight, and tool-call/step events carry
  // the interesting detail from here.
}

// specs/107-task-and-conversation-history/spec.md B4 — written once per
// task, at exactly the same "genuinely terminal, first time" point
// emittedTerminal already gates AG-UI's own RUN_FINISHED/RUN_ERROR, so
// this never double-writes. The scan-secrets redaction lives inside
// OrchestraiStore.upsertTask() itself, structurally, not here — this
// function passes the real result through unconditionally and trusts
// the store to redact by skill id.
function persistTaskTerminal(task: OrchestratorTask): void {
  const store = getSharedStore()
  if (!store) return
  try {
    store.upsertTask({
      taskId: task.id,
      agent: task.assignedAgent ?? null,
      skill: task.skill,
      status: task.status,
      // Only what the human already saw in the approval preview, per
      // this spec's own safety constraint — never the full task object.
      paramsJson: task.approval?.parameters ? JSON.stringify(task.approval.parameters) : null,
      // The schema has no separate error column — a failed task's real
      // detail lives in task.error, never task.result (which is only
      // ever set on success). Mirrors findMostRecentFailure()'s own
      // in-memory branch (`inMemory.error ?? inMemory.result`) exactly,
      // so the store fallback answers identically to the live process.
      result: task.error ?? task.result ?? null,
      // Not separately tracked on OrchestratorTask today — every result
      // reaching this point has already passed through boundTaskResult()
      // at its own call site, so the cap already holds at rest regardless
      // of this flag's value; it's diagnostic metadata, not a safety gate.
      resultTruncated: false,
      conversationId: taskConversations.get(task.id) ?? null,
      createdAt: task.createdAt.getTime(),
      updatedAt: now(),
    })
  } catch (err) {
    console.warn(`[orchestrator] task persistence failed for ${task.id}: ${errorMessage(err)}`)
  }
}

// ============================================================
// AGENT DISCOVERY
// ============================================================
async function discoverAgent(url: string): Promise<boolean> {
  try {
    const res  = await fetch(`${url}/.well-known/agent.json`, {
      signal: AbortSignal.timeout(3000)
    })
    const card = await res.json() as AgentCard
    registry.set(card.name, { card, url, status: "online", lastSeen: new Date() })
    console.log(`Discovered: ${card.name} — skills: ${card.skills.map(s => s.id).join(", ")}`)
    agentsUpdated()
    return true
  } catch {
    console.log(`Could not reach: ${url}`)
    return false
  }
}

// ============================================================
// SKILL MATCHER
// ============================================================
/** specs/051-planning-retirement-and-required-key/spec.md Phase 1 —
 *  relocated from Planning Agent's own (now-deleted) `skillSuggestAgents()`
 *  ahead of that whole package's deletion.
 *  Deterministic keyword matching, no MCP, no LLM — moved verbatim except
 *  for two corrections, both against a real captured baseline of the
 *  original output (not by eye):
 *    1. Dropped the "code-review-agent — (coming soon)" recommendation.
 *       That agent has never existed in this codebase; recommending it
 *       was a bug in the original, not a feature worth preserving.
 *    2. Dropped the "planning-agent (:3001) — (this agent)" line from
 *       "Currently online". Keeping it would have named a service that,
 *       once this spec's later phases delete that package, no longer
 *       exists — actively misleading rather than merely stale.
 *  Everything else, including the exact wording and punctuation of every
 *  other line, is unchanged from the original. */
function buildSuggestAgentsReply(text: string): string {
  const lower = text.toLowerCase()
  const suggestions: string[] = []

  suggestions.push("devops-agent — infrastructure, Docker, CI/CD, git")

  if (lower.includes("test")) {
    suggestions.push("testing-agent — test execution and coverage reporting")
  }
  if (lower.includes("security")) {
    suggestions.push("security-agent — secret, gitignore, and dependency checks")
  }
  if (lower.includes("document") || lower.includes("readme") || lower.includes("api")) {
    suggestions.push("documentation-agent — README and API documentation")
  }

  return [
    `=== Agent Suggestions for: "${text}" ===`,
    "",
    "Recommended agents:",
    ...suggestions.map(s => `  - ${s}`),
    "",
    "Currently online:",
    "  - devops-agent        (:3002) — Docker, CI/CD, and git",
    "  - testing-agent       (:3003) — Test execution and coverage",
    "  - documentation-agent (:3004) — README and API documentation",
    "  - security-agent      (:3005) — Read-only project security checks",
  ].join("\n")
}

// specs/054-capability-driven-llm-routing/spec.md — resolves the same
// "orchestrator" component's config the adaptive supervisor already
// uses (specs/039's per-component pattern), never a new key requirement:
// with no key configured, readLlmModelConfig()/buildChatModel() fail and
// this returns null, meaning the router tier is simply never reached —
// detectSkill()'s behavior for every already-tested phrase is unchanged.
async function tryBuildOrchestratorRouterModel(): Promise<BaseChatModel | null> {
  try {
    const config = readLlmModelConfig(process.env, "orchestrator")
    if (!config) return null // no key configured — the router tier is simply unreachable, not broken.
    return await buildChatModel(config)
  } catch {
    return null
  }
}

// specs/065-llm-only-skill-routing/spec.md — retires the keyword-
// matching and local-classifier tiers that used to sit ahead of the LLM
// capability router (specs/054), promoting it from "third tier, only
// consulted when both of the above miss" to the only way a skill gets
// named. This is a deliberate, approved bet, not an oversight — see
// that spec's own Purpose/Safety sections for the full reasoning and
// its real costs (every request now needs a working provider key; the
// approval gate's own safety classification, SKILL_TIER_REGISTRY, is
// completely untouched — this only changes how a skill gets NAMED,
// never what happens once one is).
//
// tryCapabilityRoute() already fails closed to `null` (→ the "plan-task"
// default below) on every non-happy path — no key, no online capability,
// an exhausted-retry/malformed response, or a proposal naming a skill
// outside the live snapshot — so this function inherits that same
// fail-closed behavior unconditionally now, rather than only as a
// last-resort fallback. With no key at all, EVERY request (including
// "what agents do you have") now resolves to plan-task, which itself
// fails that request closed with its own existing named error — a
// deliberate behavior change from before this spec, stated plainly in
// the spec's own Proposed Behavior, not hidden.
export async function detectSkill(text: string, deps: { model?: BaseChatModel } = {}): Promise<string> {
  return (await tryCapabilityRoute(text, deps.model ?? __testRouterModel ?? undefined)) ?? "plan-task"
}

// specs/065-llm-only-skill-routing/spec.md — test-only seam. With the
// keyword/classifier tiers gone, every text-dispatch path (POST /tasks,
// /ask via classifyAsk) depends on a real router call. A test that
// exercises DISPATCH wiring rather than routing itself injects a fake
// model here — see apps/orchestrator/keyword-router-fake.ts — so its
// existing skill assertions keep passing hermetically, with no network
// call. Never set in the real runtime: nothing calls this outside a
// test's own beforeEach/afterEach, and it defaults to null.
let __testRouterModel: BaseChatModel | null = null
export function __setTestRouterModel(model: BaseChatModel | null): void {
  __testRouterModel = model
}

// specs/054-capability-driven-llm-routing/spec.md — the one function that
// actually calls the router and validates its proposal against the live
// capability snapshot. specs/075-real-conversational-chat/spec.md made
// this the shared extraction point both detectSkill() (below) and /ask's
// classifyAsk() (ask-classifier.ts) now use, so the two endpoints can
// never re-diverge on what the router said the way specs/065's original
// `?? "plan-task"` fallback once risked. Fails closed to null on every
// non-happy path: no online capability to route to, no resolvable LLM
// config, or an exhausted-retry/malformed router response — never a
// guess, never a crash. Live-snapshot skill validation only applies to
// the two kinds that actually name a dispatchable skill
// ("read-only"/"state-changing") — "unsupported"/"state-question"/
// "conversation" never reach a dispatch at all, so there is nothing to
// validate for them.
export async function classifyRouterProposal(
  text: string,
  injectedModel?: BaseChatModel,
  // specs/092-router-classification-conversation-context/spec.md — only
  // the /ask handler's own call site ever passes this (via
  // priorTurnsFor(conversation)); POST /tasks's own detectSkill() call
  // site passes nothing, so its prompt stays byte-identical to before
  // this spec.
  priorTurns?: { role: "user" | "assistant"; text: string }[],
  // specs/128 — /ask only: the last dispatched task's full text.
  lastRequest?: string,
): Promise<CapabilityRouterProposal | null> {
  const capabilities = buildCapabilitySnapshot()
  if (!capabilities || capabilities.length === 0) return null

  const model = injectedModel ?? __testRouterModel ?? (await tryBuildOrchestratorRouterModel())
  if (!model) return null

  const proposal = await runCapabilityRouter({ model, text, capabilities, priorTurns, lastRequest })
  if (!proposal) return null

  if (proposal.kind === "read-only" || proposal.kind === "state-changing") {
    if (proposal.skillId === UNSUPPORTED_SKILL_ID) return null
    // Validated against the exact same live snapshot the model was
    // given — a proposal naming a skill not currently online (or a
    // hallucinated id never in the list at all) never dispatches.
    const validSkillIds = new Set(capabilities.map((c) => c.skillId))
    if (!validSkillIds.has(proposal.skillId)) return null
  }

  return proposal
}

// specs/054-capability-driven-llm-routing/spec.md — kept separate from
// detectSkill() so it can be unit-tested (and its own failure modes
// reasoned about) independently of the keyword/classifier tiers above
// it. specs/075 amendment: POST /tasks' observable behavior is
// unaffected by the router's two new kind values — "conversation" always
// maps to the existing "plan-task" fallback here, byte-identical to how
// "unsupported" already did (only /ask's own classifyAsk() treats it
// differently).
//
// "state-question" gets one deliberate exception, found live while
// implementing this spec, not assumed away: "what agents are there"/
// "what agents do you have" is genuinely ambiguous between two
// independently pre-existing, load-bearing behaviors — POST /tasks has
// always resolved this exact phrasing to the real "suggest-agents" skill
// (specs/051, buildCapabilitySnapshot()'s own synthetic orchestrator
// entry), while /ask has always answered it as a Tier 0 state question
// (specs/044's own now-deleted CAPABILITY_PATTERNS). The two endpoints
// never consulted each other before this spec unified their
// classification into one router call, so this overlap was invisible
// until specs/075's own pre-existing regression suite
// (suggest-agents-relocation.test.ts) caught it. Resolved by preferring
// "suggest-agents" here specifically when it's genuinely live — the
// literal, most conservative reading of "unaffected in observable
// behavior" — while /ask's own classifyAsk() is untouched by this and
// keeps treating the identical "state-question" kind as Tier 0,
// preserving both endpoints' own independently-established behavior for
// the same text rather than letting one silently win.
async function tryCapabilityRoute(text: string, injectedModel?: BaseChatModel): Promise<string | null> {
  const proposal = await classifyRouterProposal(text, injectedModel)
  if (!proposal) return null
  if (proposal.kind === "state-question") {
    const capabilities = buildCapabilitySnapshot()
    const hasSuggestAgents = capabilities?.some((c) => c.skillId === "suggest-agents") ?? false
    return hasSuggestAgents ? "suggest-agents" : null
  }
  if (proposal.kind !== "read-only" && proposal.kind !== "state-changing") return null
  return proposal.skillId
}

export function findAgentForSkill(skillId: string): RegisteredAgent | null {
  for (const agent of registry.values()) {
    if (agent.status === "online") {
      if (agent.card.skills.some(s => s.id === skillId)) return agent
    }
  }
  return null
}

// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md —
// Builds Planning's capability snapshot from the current live registry.
// Returns null (not an empty array) on any normalization failure — ambiguous
// ownership, an invalid id, or no usable capability at all — so the caller
// can fail closed to zero plan steps rather than send a partial/wrong
// catalog. Built fresh on every plan-task dispatch, never cached, so it
// always reflects who is online right now.
// specs/101-per-agent-tool-access-expansion/spec.md §C — factored out so
// /healthz (capabilitySnapshotStatus() below) can report the identical
// computation's real ok/error state without a second, divergent copy of
// the sources-building logic.
function computeCapabilitySnapshot(): ReturnType<typeof normalizeAgentCapabilities> {
  // specs/121-skill-description-grounded-routing/spec.md — each skill's
  // own static Agent Card description now passes through too, so the
  // router prompt can distinguish same-family skill ids (e.g. edit-file
  // vs edit-files) it previously saw as bare ids only.
  const sources: AgentCapabilitySource[] = Array.from(registry.values()).map((agent) => ({
    agentName: agent.card.name,
    online: agent.status === "online",
    skills: agent.card.skills.map((s) => ({ id: s.id, description: s.description })),
  }))
  // specs/065-llm-only-skill-routing/spec.md — the Orchestrator's own
  // meta-skill, not owned by any registered agent. Always "online": it's
  // this same process. Without this, the capability router could never
  // legitimately name "suggest-agents" — its own validation
  // (validSkillIds.has(proposal.skillId), just below) would reject any
  // proposal naming it, since it never appeared in the snapshot the
  // model was given. Dispatch itself doesn't need this entry (suggest-
  // agents is special-cased before any registry lookup — see
  // dispatchRootTask()'s own comment); this exists purely so the router
  // has something valid to name.
  sources.push({
    agentName: "orchestrator",
    online: true,
    skills: [{ id: "suggest-agents", description: "List which agents are currently online and what skills they advertise." }],
  })
  return normalizeAgentCapabilities(sources)
}

export function buildCapabilitySnapshot(): CapabilityEntry[] | null {
  const result = computeCapabilitySnapshot()
  if (!result.ok) {
    console.log(`Capability snapshot unavailable: ${result.error}`)
    return null
  }
  return result.capabilities
}

// specs/101-per-agent-tool-access-expansion/spec.md §C — buildCapability
// Snapshot()'s own refusal was previously visible only via that one
// console.log, while every request in the system silently degrades to
// plan-task. The refusal behavior itself is untouched; this only makes
// it observable. Exported for /healthz below and for direct testing.
export function capabilitySnapshotStatus(): { ok: true } | { ok: false; error: string } {
  const result = computeCapabilitySnapshot()
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

// ============================================================
// SEND TASK TO AGENT
// ============================================================
// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md —
// selectedSkill is the Orchestrator's own already-validated decision
// (detectSkill()'s result for a root task, or step.skill for a plan child).
// Sending it makes skill identity authoritative across dispatch instead of
// leaving the receiving agent to re-derive it from `text`, which is what let
// an LLM-authored description mentioning "Dockerfile" flip a git-status
// step into dockerize (see 026/029 verification evidence). capabilities is
// sent only when the receiving skill is plan-task, per spec section 2.
export async function sendTaskToAgent(
  agent: RegisteredAgent,
  text: string,
  taskId: string,
  options: { selectedSkill?: string; capabilities?: CapabilityEntry[] } = {},
): Promise<string> {
  const agentTaskId = `orch-${taskId}`
  const res = await fetch(`${agent.url}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: agentTaskId,
      message: { role: "user", parts: [{ text }] },
      ...(options.selectedSkill !== undefined ? { selectedSkill: options.selectedSkill } : {}),
      ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    })
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string }
    throw new Error(`Agent rejected task submission (HTTP ${res.status}): ${detail.error ?? "unknown error"}`)
  }
  return agentTaskId
}

interface AgentTaskView {
  status?: string
  result?: string
  error?: string
  approval?: ApprovalPreview
}

async function pollAgent(agentUrl: string, agentTaskId: string): Promise<AgentTaskView> {
  const res = await fetch(`${agentUrl}/tasks/${agentTaskId}`, {
    signal: AbortSignal.timeout(5000)
  })
  return res.json() as Promise<AgentTaskView>
}

// ============================================================
// AGENT STATUS MAPPING — shared by on-demand sync and live streaming
// ============================================================
function applyAgentUpdate(
  task: OrchestratorTask,
  agentTask: AgentTaskView
): boolean {
  if (agentTask.status === "completed") {
    task.status = "completed"
    task.result = agentTask.result ?? task.result  // always copy result from agent
    task.approval = undefined  // no pending action may remain on a terminal task
  } else if (agentTask.status === "failed") {
    task.status = "failed"
    task.error  = agentTask.error ?? task.error
    task.approval = undefined
  } else if (agentTask.status === "input-required") {
    task.status = "input-required"
    task.approval = agentTask.approval ?? task.approval  // informed-approval preview, forwarded verbatim
  } else if (agentTask.status === "working") {
    task.status = "working"
  } else {
    return false  // no meaningful change (e.g. "submitted")
  }

  tasks.set(task.id, task)
  emitTaskState(task)
  return true
}

// ============================================================
// TASK STATUS SYNC — pull latest state from the owning agent (on demand)
// ============================================================
async function syncTaskStatus(task: OrchestratorTask): Promise<OrchestratorTask> {
  if (!task.agentTaskId || !task.assignedAgent) return task
  if (task.status === "failed") return task  // already terminal

  const agent = registry.get(task.assignedAgent)
  if (!agent) return task

  try {
    const agentTask = await pollAgent(agent.url, task.agentTaskId)
    applyAgentUpdate(task, agentTask)
  } catch {
    // Agent unreachable — keep last known state rather than failing the task
  }

  return task
}

// ============================================================
// LIVE STREAM — consume the agent's own SSE stream for a task so
// status changes flow to the Orchestrator the moment they happen,
// instead of waiting for the next on-demand poll.
// ============================================================
async function subscribeToAgentStream(task: OrchestratorTask): Promise<void> {
  if (!task.agentTaskId || !task.assignedAgent) return
  if (task.status === "completed" || task.status === "failed") return

  const agent = registry.get(task.assignedAgent)
  if (!agent) return

  const controller = new AbortController()
  const safetyCap  = setTimeout(() => controller.abort(), 5 * 60 * 1000)  // 5 min safety cap

  try {
    const res = await fetch(`${agent.url}/tasks/${task.agentTaskId}/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) return

    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""

      for (const frame of frames) {
        const dataLine = frame.split("\n").find(l => l.startsWith("data:"))
        if (!dataLine) continue

        let payload: { status?: string; result?: string; error?: string }
        try {
          payload = JSON.parse(dataLine.slice(5).trim())
        } catch {
          continue
        }

        applyAgentUpdate(task, payload)
        // applyAgentUpdate() mutates task.status in place; TypeScript's
        // control-flow narrowing doesn't account for a property being
        // mutated through a function call, so it keeps treating task.status
        // as narrowed from the early-return guard above this loop (a known
        // TS limitation, not a real behavior gap — confirmed by reading
        // applyAgentUpdate() itself, which does assign task.status =
        // "completed"/"failed" directly). Re-binding through an explicitly
        // full-union-typed local gives TS a fresh, honest starting point
        // for this comparison instead of suppressing the check.
        const currentStatus = task.status as OrchestratorTask["status"]
        if (currentStatus === "completed" || currentStatus === "failed") {
          reader.cancel().catch(() => {})
          return
        }
      }
    }
  } catch {
    // Stream unreachable, aborted, or agent closed early (e.g. at input-required) —
    // on-demand syncTaskStatus() calls remain the fallback for correctness.
  } finally {
    clearTimeout(safetyCap)
  }
}

// ============================================================
// PLAN EXECUTION — dispatch each parsed step as its own child task
// ============================================================
export async function dispatchPlanStep(
  step: PlanStep,
  parentTask: OrchestratorTask
): Promise<string | null> {
  const agent = findAgentForSkill(step.skill)
  if (!agent) {
    // specs/112-plan-step-no-agent-inspection-fallback/spec.md (specs/104
    // item A7) — dispatchRootTask()'s own no-agent inspection fallback
    // (specs/102), applied here too: for the narrow set of skills the
    // Orchestrator can genuinely answer itself, synthesize a real child
    // task instead of failing the step outright. The returned id flows
    // through the exact same machinery a real agent-dispatched child
    // already uses — buildOrchestratorSupervisorDeps()'s own dispatch()
    // wrapper, waitForChildTask(), classifyDispatchOutcome(),
    // composeSupervisorResult() — none of which need to change, since
    // all four are already generic over "any real child task," not
    // specific to an agent-dispatched one.
    if (INSPECTION_FALLBACK_SKILLS.has(step.skill)) {
      const fallbackChildId = allocateId("child", (candidate) => tasks.has(candidate))
      const fallbackText = buildPlanStepText(step.skill, step.description, parentTask.text)
      const fallbackChild: OrchestratorTask = {
        id: fallbackChildId,
        text: fallbackText,
        skill: step.skill,
        assignedAgent: "orchestrator",
        status: "working",
        createdAt: new Date(),
        parentTaskId: parentTask.id,
      }
      tasks.set(fallbackChildId, fallbackChild)
      runStarted(fallbackChildId)
      emit({
        type: "STEP_STARTED",
        runId: parentTask.id,
        stepName: `${step.order}. ${step.skill}`,
        timestamp: now(),
      })
      step.childTaskId = fallbackChildId
      step.status = "dispatched"

      void inspectTargetProjectAsTaskResult(step.skill, fallbackText, `orch-${fallbackChildId}`).then((result) => {
        if (result !== null) {
          fallbackChild.status = "completed"
          fallbackChild.result = result
        } else {
          fallbackChild.status = "failed"
          fallbackChild.error = `No agent found for skill: ${step.skill}`
        }
        tasks.set(fallbackChildId, fallbackChild)
        emitTaskState(fallbackChild)
      })

      console.log(`Dispatched step ${step.order} [${step.skill}] → orchestrator (self-inspection, child: ${fallbackChildId})`)
      return fallbackChildId
    }

    console.log(`No agent for skill: ${step.skill} — skipping`)
    step.status = "failed"
    return null
  }

  // Build task text for the agent — the step, then the parent request as
  // marked background (specs/137: agents instruct their models with the
  // step only; deterministic readers still see the whole text).
  const stepText = buildPlanStepText(step.skill, step.description, parentTask.text)

  const childTaskId = allocateId("child", (candidate) => tasks.has(candidate))
  const childTask: OrchestratorTask = {
    id: childTaskId,
    text: stepText,
    skill: step.skill,
    assignedAgent: agent.card.name,
    agentTaskId: `orch-${childTaskId}`,  // deterministic — set up front so approve never races
    status: "assigned",
    createdAt: new Date(),
    parentTaskId: parentTask.id,
  }
  tasks.set(childTaskId, childTask)
  // A dispatched plan step is both a run of its own (it's a real task with
  // its own id, agent, and lifecycle) and a step of its parent's run.
  runStarted(childTaskId)
  emit({
    type: "STEP_STARTED",
    runId: parentTask.id,
    stepName: `${step.order}. ${step.skill}`,
    timestamp: now(),
  })

  try {
    // specs/030 — step.skill is what selected `agent` two lines above via
    // findAgentForSkill(step.skill), immediately before this send with no
    // intervening await; that immediacy is what makes this already a live
    // revalidation, not a stale earlier lookup. Sending it means DevOps
    // (or any agent) executes exactly this skill regardless of what the
    // plan-authored description text happens to mention.
    await sendTaskToAgent(agent, stepText, childTaskId, { selectedSkill: step.skill })
  } catch (err: any) {
    childTask.status = "failed"
    childTask.error  = `Could not send step to agent: ${err.message}`
    tasks.set(childTaskId, childTask)
    emitTaskState(childTask)
    emit({
      type: "STEP_FINISHED",
      runId: parentTask.id,
      stepName: `${step.order}. ${step.skill}`,
      outcome: "failed",
      timestamp: now(),
    })
    step.status = "failed"
    return childTaskId
  }

  // Live-stream this child's status from the agent instead of waiting for a poll
  subscribeToAgentStream(childTask).catch(() => {})

  step.childTaskId = childTaskId
  step.status = "dispatched"

  console.log(`Dispatched step ${step.order} [${step.skill}] → ${agent.card.name} (child: ${childTaskId})`)
  return childTaskId
}

async function waitForChildTask(childTaskId: string, maxWaitMs = 300_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    await Bun.sleep(1000)
    const child = tasks.get(childTaskId)
    if (!child) return
    await syncTaskStatus(child)

    // Stop waiting on terminal states
    if (child.status === "completed" || child.status === "failed") return

    // For input-required, we wait — the user must approve via dashboard
    // Just keep polling until they do
  }
}

// ============================================================
// LANGGRAPH ADAPTIVE SUPERVISOR (specs/028-orchestrator-langgraph-supervisor;
// default since specs/038 Phase 1; the ONLY plan-task path since
// specs/051-planning-retirement-and-required-key/spec.md Phase 3)
// ============================================================
// specs/051 Phase 3 — this used to be conditional on two things, both
// removed here: an ORCHESTRAI_ORCHESTRATOR_GRAPH=0 opt-out (isOrchestrator
// GraphEnabled()) and a genuinely-absent-key fallback to the Planning Agent
// (supervisorShouldFallBackToPlanning()). Neither has anywhere left to go:
// the opt-out routed to Planning's own sequential path, and the fallback
// WAS that same routing decision for the "no key" case specifically — both
// depended on Planning existing, which by this spec's Phase 4 it no longer
// does. `apps/supervisor/index.ts`'s own startup check (this spec's §2/§3)
// now refuses to even START a supervisor-managed Orchestrator without a
// resolvable key, so runOrchestratorSupervisor() below is the only
// plan-task path there is — its own `!config` branch (a few functions
// down) stops being "should be unreachable" defensive code and becomes the
// real, intended behavior for the one case that check cannot reach: this
// file run directly (`bun run orchestrator`, `bun run dev`), outside the
// supervisor's own management, with no key configured.
//
// detectSkill()'s keyword/classifier fast paths above are completely
// unaffected by any of this — this only ever intercepts what already
// resolved to plan-task.

/** specs/051 Phase 3 acceptance criterion — startup reporting states the
 *  resolved provider/model/key sources, or names the one way this can
 *  still be keyless (running this file directly, without the supervisor's
 *  own startup check). Never renders a credential value. */
function describeSupervisorStartupState(env: Record<string, string | undefined> = process.env): string {
  let config: ReturnType<typeof readLlmModelConfig>
  try {
    config = readLlmModelConfig(env, "orchestrator")
  } catch (err) {
    return `misconfigured — ${errorMessage(err)} — plan-task will fail closed until corrected`
  }
  if (!config) {
    return "no provider key configured — plan-task will fail closed for every request (run via \"orchestrai\", which requires a key before starting anything, to avoid this)"
  }
  return `${describeLlmModelConfig(config)} — plan-task runs through the adaptive supervisor`
}

/** Builds the injected SupervisorDeps against the EXISTING, UNMODIFIED
 *  dispatchPlanStep()/waitForChildTask() functions — per the spec, this
 *  checkpoint calls those exact functions and awaits them identically. The
 *  only new logic here is translating their existing side-effecting shape
 *  into the structured WaitResult the classification adapter needs, and
 *  emitting STEP_FINISHED for parity with the existing sequential path. */
export function buildOrchestratorSupervisorDeps(parentTask: OrchestratorTask): SupervisorDeps {
  // specs/028 Phase 4 — TOOL_CALL_START/RESULT for each dispatch, via the
  // SAME POST /internal/audit-event mechanism every agent's own MCP/A2A
  // calls already use (packages/shared/audit.ts), fired directly here since
  // the supervisor graph runs inside this same process. Deliberately NOT
  // done inside supervisor-graph.ts's own dispatchNode(): that module has
  // no concept of "parent task" by design (mirrors specs/026's injected-
  // deps isolation), and mapAuditPushToAgUiEvent() derives its AG-UI runId
  // by stripping an "orch-" prefix from taskId — using the CHILD task's raw
  // id there (as an earlier version of this function did) would have
  // produced a runId equal to the child, not the parent plan run, breaking
  // correlation with this same run's RUN_STARTED/STEP_*/RUN_FINISHED
  // events. Found and fixed during Phase 4's own verification, not assumed
  // correct from Phase 2/3's reuse of dispatchPlanStep()/waitForChildTask().
  const dispatchStartedAt = new Map<string, number>()

  return {
    async dispatch(skill: string, target: string, description: string): Promise<DispatchResult | null> {
      const order = (parentTask.planSteps?.length ?? 0) + 1
      const step: PlanStep = { order, skill, description, status: "pending" }
      // append-as-decided (Proposed Behavior 9) — the dashboard/TUI already
      // stream planSteps incrementally via STEP_STARTED/STEP_FINISHED; this
      // is the one genuine change to the "all steps known up front"
      // rendering assumption those existing renderers made.
      parentTask.planSteps = [...(parentTask.planSteps ?? []), step]
      tasks.set(parentTask.id, parentTask)

      const childId = await dispatchPlanStep(step, parentTask)
      if (!childId) return null

      parentTask.childTaskIds = [...(parentTask.childTaskIds ?? []), childId]
      tasks.set(parentTask.id, parentTask)

      dispatchStartedAt.set(childId, performance.now())
      // taskId carries the PARENT's id (orch-prefixed, matching the same
      // convention an agent's own agentTaskId already uses) so this run's
      // TOOL_CALL_* events share runId with its RUN_STARTED/STEP_*/
      // RUN_FINISHED — childId becomes callId, correlating this call's own
      // start/result pair, same role a minted per-call UUID plays elsewhere.
      emitAuditStart({ kind: "a2a-call", caller: "orchestrator-supervisor", target: skill, taskId: `orch-${parentTask.id}`, callId: childId })

      return { childTaskId: childId }
    },

    async wait(childTaskId: string): Promise<WaitResult> {
      await waitForChildTask(childTaskId)
      const child = tasks.get(childTaskId)
      const step = parentTask.planSteps?.find((s) => s.childTaskId === childTaskId)
      const stepName = step ? `${step.order}. ${step.skill}` : childTaskId
      const durationMs = Math.max(0, performance.now() - (dispatchStartedAt.get(childTaskId) ?? performance.now()))

      const pushResult = (outcome: "completed" | "failed" | "timeout") => {
        emitAuditEvent({
          kind: "a2a-call",
          caller: "orchestrator-supervisor",
          target: step?.skill ?? "unknown",
          taskId: `orch-${parentTask.id}`,
          callId: childTaskId,
          params: {},
          outcome,
          durationMs,
          resultBytes: 0,
          resultTruncated: false,
        })
      }

      if (child?.status === "completed") {
        emit({ type: "STEP_FINISHED", runId: parentTask.id, stepName, outcome: "completed", timestamp: now() })
        pushResult("completed")
        return { status: "completed", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }
      }
      if (child?.status === "failed") {
        emit({ type: "STEP_FINISHED", runId: parentTask.id, stepName, outcome: "failed", timestamp: now() })
        pushResult("failed")
        // The ONLY trusted source for "was this a real rejection/skip" —
        // never task.status or error text (specs/028's own adversarial
        // finding, extended to skip by specs/089).
        return {
          status: "failed",
          wasRejectedByOrchestrator: rejectedByOrchestrator.has(childTaskId),
          wasSkippedByOrchestrator: skippedByOrchestrator.has(childTaskId),
        }
      }
      // Still "input-required" (or otherwise non-terminal) once
      // waitForChildTask()'s own bound elapsed — mirrors how the existing
      // sequential path already treats this as "no longer usefully in
      // flight" (see its own STEP_FINISHED comment above).
      emit({ type: "STEP_FINISHED", runId: parentTask.id, stepName, timestamp: now() })
      pushResult("timeout")
      return { status: "timeout", wasRejectedByOrchestrator: false, wasSkippedByOrchestrator: false }
    },

    // specs/120-supervisor-parallel-write-dispatch/spec.md — called by
    // dispatchBatch() when a sibling in the same concurrent batch produced
    // a run-ending outcome, so this still-pending child's own approval
    // prompt is withdrawn rather than left orphaned for a run that is
    // already over. See performInternalSkip()'s own doc for why this is a
    // separate function from the existing POST /tasks/:id/skip handler.
    async skip(childTaskId: string): Promise<void> {
      await performInternalSkip(childTaskId)
    },
  }
}

function supervisorTerminalToTaskFailure(terminal: string): string {
  switch (terminal) {
    case "rejected":
      return "Rejected by user"
    case "timeout":
      return "A dispatched step timed out waiting for a terminal state"
    case "failed-ambiguous":
      // Proposed Behavior 5's routing table: failed-ambiguous "surfaces a
      // reconciliation request" — the target's real state is unknown and a
      // human must check it, never assumed safe.
      return "A dispatched step failed with an unknown effect on the target project — its real state must be checked manually before proceeding (reconciliation required)"
    case "max-dispatches-reached":
      return "Run terminated: maximum total dispatches reached"
    case "max-skill-attempts-reached":
      return "Run terminated: maximum attempts for one skill reached"
    default:
      return `Run terminated: ${terminal}`
  }
}

// specs/075-real-conversational-chat/spec.md §3 — a completed plan-task
// used to report only `"Supervisor run completed after N dispatch(es)."`,
// discarding every child's real output at the parent; /ask's own
// synthesizeAnswer() was starved of anything to summarize. Deterministic
// assembly of data the parent already owns the ids of (task.planSteps,
// task.childTaskIds) — no model involved, no new fetch. Bound by the
// existing boundTaskResult()/TASK_RESULT_MAX_BYTES (64 KiB) path, same
// explicit truncation marker every other bounded result already uses.
// specs/102-orchestrator-readonly-project-inspection/spec.md — projectContext
// is optional and purely additive: with none supplied, this function's
// output is unchanged from before this spec. When the supervisor made
// zero real dispatches, grounding the PROMPT alone (runOrchestratorSupervisor()'s
// own inspectTargetProject() call) is not enough on its own — without this,
// a supervisor that correctly recognizes "I already know the answer, no
// agent needed" from its own grounding block would still report only the
// generic "completed after 0 dispatch(es)" line, discarding the real
// answer it was just given. This is the same class of gap specs/075 fixed
// for conversational chat, applied here to plan-task's own zero-dispatch
// case specifically.
// specs/105-orchestrator-fallback-deep-analysis/spec.md — extracted out
// of runOrchestratorSupervisor() so the zero-dispatch → deep-analysis
// upgrade can be tested directly with a given dispatchCount, without
// needing to drive the full LangGraph supervisor decision loop (which
// has no test-model seam of its own) to actually produce one. Reaching
// zero dispatches means the inspection IS the answer being returned, so
// spending one real analysis call here is proportionate — no other work
// happened for this request. Reuses fetchProjectInspection()'s own
// cache (already populated by the projectContext computed for
// grounding), so this is a cheap follow-up call, not a second
// independent computation. Fail-open: computeDeepProjectAnalysis()
// returning null (no key, harness failure, no client) leaves
// projectContext untouched — byte-identical to before this spec.
export async function resolveSupervisorFinalContext(
  task: OrchestratorTask,
  dispatchCount: number,
  projectContext: string | undefined,
): Promise<string | undefined> {
  if (dispatchCount !== 0) return projectContext
  const deep = await computeDeepProjectAnalysis(task.text, `orch-${task.id}`, taskConversations.get(task.id))
  if (!deep) return projectContext
  return projectContext ? `${projectContext}\n\n${deep}` : deep
}

export function composeSupervisorResult(task: OrchestratorTask, dispatchCount: number, projectContext?: string): string {
  const lines: string[] = []
  for (const step of task.planSteps ?? []) {
    const child = step.childTaskId ? tasks.get(step.childTaskId) : undefined
    if (!child) {
      lines.push(`${step.order}. [${step.skill}] ${step.status ?? "pending"} — not dispatched`)
      continue
    }
    const outcome = child.status === "completed"
      ? (child.result ?? "(completed, no result text)")
      : child.status === "failed"
        ? `failed: ${child.error ?? "(no error detail)"}`
        : child.status
    lines.push(`${step.order}. [${step.skill}] ${child.assignedAgent ?? "?"} — ${outcome}`)
  }
  if (dispatchCount === 0 && projectContext) {
    lines.push(`No agent dispatch was needed — answered directly from the Orchestrator's own project inspection:`, projectContext)
  } else {
    lines.push(`Supervisor run completed after ${dispatchCount} dispatch(es).`)
  }
  return boundTaskResult(lines.join("\n\n")).text
}

/** The only plan-task path since specs/051 Phase 3 (it replaced "send to
 *  Planning Agent, then watchPlanAndDispatch() the resulting text plan" —
 *  specs/038 Phase 1 — which specs/051 Phase 4 deletes entirely). Every
 *  supervisor-managed launch (`orchestrai`) already refused to start this
 *  process at all without a resolvable orchestrator key
 *  (`apps/supervisor/index.ts`'s own startup check), so the `!config`
 *  branch below is not a defensive net for a case that check should have
 *  already caught — it is the real, intended fail-closed behavior for the
 *  one thing that check cannot reach: this file started directly (`bun run
 *  orchestrator`, `bun run dev`), outside the supervisor's management,
 *  with no key configured. A real misconfiguration (invalid
 *  provider/model) fails this task closed with a named error either way,
 *  the same "not a silent fallback" precedent specs/026 established. */
async function runOrchestratorSupervisor(task: OrchestratorTask): Promise<void> {
  let config: ReturnType<typeof readLlmModelConfig>
  try {
    config = readLlmModelConfig(process.env, "orchestrator")
  } catch (err) {
    task.status = "failed"
    task.error = `plan-task is misconfigured: ${errorMessage(err)}`
    tasks.set(task.id, task)
    emitTaskState(task)
    return
  }
  if (!config) {
    // Real, reachable path when this process runs without the supervisor's
    // own startup key check — see this function's own comment above.
    task.status = "failed"
    task.error = "No provider key configured for plan-task — failing closed. Run via \"orchestrai\", which requires a key before starting anything, or set ORCHESTRAI_LLM_API_KEY / ORCHESTRAI_ORCHESTRATOR_LLM_API_KEY directly."
    tasks.set(task.id, task)
    emitTaskState(task)
    return
  }

  console.log(`[orchestrator] supervisor: ${describeLlmModelConfig(config)}`)

  task.status = "working"
  tasks.set(task.id, task)
  task.planSteps = []
  task.childTaskIds = []

  try {
    const model = await buildChatModel(config)
    const deps = buildOrchestratorSupervisorDeps(task)
    // specs/097-chat-answer-and-plan-description-honesty/spec.md — the
    // only real call site of runSupervisor(); previously never passed
    // maxDispatches, so it always used the module's own default.
    const maxDispatches = resolveSupervisorMaxDispatches()
    // specs/102-orchestrator-readonly-project-inspection/spec.md — once
    // per run, before the first (previously blind) skill decision.
    // "orch-<task.id>" matches the exact convention
    // buildOrchestratorSupervisorDeps() already uses for this same
    // task's own dispatched-step audit events, so this call's own
    // TOOL_CALL_START/RESULT correctly nests under this run's real
    // RUN_STARTED rather than appearing as an orphan event.
    const projectContext = await inspectTargetProject(task.text, `orch-${task.id}`, taskConversations.get(task.id)) ?? undefined
    const result = await runSupervisor(task.text, { model, deps, maxDispatches, projectContext })

    if (result.terminal === "done") {
      task.status = "completed"
      // Reuses the exact same projectContext value the model itself
      // was shown — the user-visible result and the model's own
      // grounding for "no dispatch needed" stay in sync by
      // construction, never two independently-computed copies.
      const finalContext = await resolveSupervisorFinalContext(task, result.dispatchCount, projectContext)
      task.result = composeSupervisorResult(task, result.dispatchCount, finalContext)
    } else {
      task.status = "failed"
      task.error = supervisorTerminalToTaskFailure(result.terminal)
      // specs/120-supervisor-parallel-write-dispatch/spec.md — a genuine,
      // real gap found while verifying this checkpoint: before this fix, a
      // non-"done" terminal (rejected/timeout/failed-ambiguous) left
      // task.result unset, so a parallel batch's partial effect — which
      // sibling actually wrote, which was rejected, which was skipped —
      // was reported only as a single generic error string, with no
      // per-step breakdown, even though every child task's own real
      // outcome was already sitting right there. composeSupervisorResult()
      // already reads each step's real child status/result/error
      // generically (it has no terminal-reason-specific logic at all), so
      // reusing it here needed no new code, just calling it on this path
      // too. This was a pre-existing gap in the sequential single-dispatch
      // path as well, not something this spec introduced — but this spec's
      // own "report a partial effect honestly" requirement is what
      // surfaced it, so it is fixed here rather than left for later.
      task.result = composeSupervisorResult(task, result.dispatchCount, undefined)
    }
    tasks.set(task.id, task)
    emitTaskState(task)
  } catch (err) {
    task.status = "failed"
    task.error = `Orchestrator supervisor run failed: ${errorMessage(err)}`
    tasks.set(task.id, task)
    emitTaskState(task)
  }
}

// ============================================================
// HONO APP
// ============================================================
// Exported so tests can exercise real routing via app.request() (Hono's own
// in-process test entry point — binds no port) rather than re-implementing
// routing logic. specs/028's own acceptance criterion — a direct-routed
// request must never reach the supervisor graph even with the flag set —
// needs exactly this: a real POST / through the real handler.
export const app = new Hono()

app.get("/healthz", (c) => c.json({
  status: "ok",
  agents: registry.size,
  tasks:  tasks.size,
  projectPath: process.env.ORCHESTRAI_PROJECT_PATH ?? process.cwd(),
  // specs/101-per-agent-tool-access-expansion/spec.md §C — a collapsed
  // capability snapshot (e.g. two online agents advertising the same
  // skill id) used to be visible only as a single console.log while
  // every request silently fell back to plan-task. Mirrors how every
  // agent already reports dependencies: {mcp: …}.
  capabilities: capabilitySnapshotStatus(),
  // specs/102-orchestrator-readonly-project-inspection/spec.md —
  // readiness() is a pure, synchronous snapshot (never pingReady(),
  // which performs real I/O and would make every /healthz call block on
  // this optional dependency). "disabled" distinguishes construction
  // never having been attempted (opted out or failed) from a real
  // client that is merely connecting/retrying/connected.
  mcp: orchestratorMcpClient ? orchestratorMcpClient.readiness() : { state: "disabled" },
}))

app.get("/agents", (c) => {
  const agents = Array.from(registry.values()).map(a => ({
    name:     a.card.name,
    url:      a.url,
    status:   a.status,
    skills:   a.card.skills.map(s => s.id),
    lastSeen: a.lastSeen,
  }))
  return c.json({ count: agents.length, agents })
})

// specs/108-durable-audit-trail/spec.md B6/B7 — read-only, strictly
// optional (a missing/disabled store returns an empty list, never an
// error — the same fail-open guarantee every other store.ts consumer in
// this file already has). params_json is already whitelisted at write
// time (packages/shared/audit.ts's whitelistAuditParams()), so nothing
// extra is filtered here.
const AUDIT_QUERY_LIMIT = 200
app.get("/audit", (c) => {
  const store = getSharedStore()
  if (!store) return c.json({ events: [] })
  const taskId = c.req.query("task")
  const events = store.listAuditEvents({ taskIds: taskId ? auditTaskIdsForQuery(taskId) : undefined, limit: AUDIT_QUERY_LIMIT })
  return c.json({ events })
})

app.post("/agents/register", async (c) => {
  const { url } = await c.req.json()
  if (!url) return c.json({ error: "url required" }, 400)
  const ok = await discoverAgent(url)
  if (!ok) return c.json({ error: `Could not reach agent at ${url}` }, 400)
  return c.json({ message: "Agent registered", agents: registry.size })
})

// ============================================================
// CONVERSATIONAL ASK LAYER (specs/044-conversational-ask-layer/spec.md)
// ============================================================
// POST /tasks below is deliberately untouched by all of this — /ask is
// purely additive, and every existing client, spec and test keeps the
// exact behavior it had (specs/044 Safety Constraints).

/** Tier 0 — answered from the live registry, no dispatch, no LLM. */
export function answerCapabilitiesFromState(): string {
  const online = [...registry.values()].filter((a) => a.status === "online")
  if (online.length === 0) return "No agents are online right now."

  const lines = [`${online.length} agent${online.length === 1 ? "" : "s"} online:`]
  for (const agent of online) {
    lines.push(`  • ${agent.card.name} — ${agent.card.skills.map((s) => s.id).join(", ") || "(no skills advertised)"}`)
  }
  return lines.join("\n")
}

/** Tier 0 — answered from the task store, no dispatch, no LLM. */
export function answerRecentTasksFromState(limit = 5): string {
  const recent = [...tasks.values()].slice(-limit).reverse()
  if (recent.length === 0) return "No tasks have run yet."

  const lines = [`${recent.length} most recent task${recent.length === 1 ? "" : "s"}:`]
  for (const task of recent) {
    lines.push(`  • ${task.skill} — ${task.status}${task.assignedAgent ? ` (${task.assignedAgent})` : ""}`)
  }
  return lines.join("\n")
}

// specs/091-chat-explain-last-failure/spec.md — "why did it fail?" is
// genuinely a state question (the answer is already sitting in the task
// store, no dispatch needed), but buildStateAnswer()'s own "state" branch
// only ever gave the generic roster+recent-task-list answer, never a
// specific task's own real error. Walks backward, the same direction
// answerRecentTasksFromState() already does, for the most recent FAILED
// task specifically, and returns its real skill/agent/error verbatim —
// no paraphrasing, no guessing.
/** Tier 0 — answered from the task store, no dispatch, no LLM. */
// specs/107-task-and-conversation-history/spec.md — the in-memory
// `tasks` Map is empty right after a restart; both callers below used to
// read only that, so "why did it fail?" silently lost its answer the
// moment the process restarted. Checks the durable store as a fallback
// — never as an override, since the live process's own in-memory state
// is always more current when it exists. Redacted rows (scan-secrets)
// surface only their skill/agent/status, matching what the raw task
// record itself always preserved; there is simply no detail text to
// show for those, by this spec's own deliberate design.
interface RecentFailure {
  skill: string
  agent: string | null
  detail: string
}
function findMostRecentFailure(): RecentFailure | null {
  const inMemory = [...tasks.values()].reverse().find((t) => t.status === "failed")
  if (inMemory) {
    return {
      skill: inMemory.skill,
      agent: inMemory.assignedAgent ?? null,
      detail: inMemory.error ?? inMemory.result ?? "(no further detail recorded)",
    }
  }
  const store = getSharedStore()
  if (!store) return null
  try {
    const row = store.listRecentTasks(1, "failed")[0]
    if (!row) return null
    return {
      skill: row.skill,
      agent: row.agent,
      detail: row.redacted ? "(no further detail recorded — this skill's result is never persisted)" : (row.result ?? "(no further detail recorded)"),
    }
  } catch {
    return null
  }
}

export function answerLastFailureFromState(): string {
  const failed = findMostRecentFailure()
  if (!failed) return "No recent task has failed."

  const agentPart = failed.agent ? ` (${failed.agent})` : ""
  return [
    `Most recent failure — ${failed.skill}${agentPart}:`,
    failed.detail,
  ].join("\n")
}

// specs/075-real-conversational-chat/spec.md — the router's own
// "state-question" kind no longer distinguishes capabilities from
// recent-task questions the way the two deleted pattern lists once did,
// so "state" answers with both. "conversation" is a short, deterministic
// greeting-shaped sentence — chat must never be blank and must never
// *require* a provider to say hello back; synthesizeAnswer() still
// phrases it more naturally when a key is configured, same as every
// other Tier 0 answer. "unclear" covers a genuine router failure (no
// key, no online capability, exhausted retries) — never a guess.
const CONVERSATION_GREETING = "Hi — I'm OrchestrAI's orchestrator. Ask what I can do, or tell me what you'd like done."

// specs/093-conversation-answer-context-blind/spec.md, amended by
// specs/124-conversation-answer-llm-synthesis/spec.md — this function is
// now GROUNDING MATERIAL for synthesis, not the final answer shown to the
// user (specs/124's call site replaces this text with a synthesized reply
// when one is available, falling back to this text verbatim only when
// synthesis is unconfigured/fails). It stays fully deterministic:
// real, already-computed state (the same source answerLastFailureFromState()
// already reads, never invented), never the user's actual message.
function buildConversationAnswer(priorTurns: { role: "user" | "assistant"; text: string }[]): string {
  if (priorTurns.length === 0) return CONVERSATION_GREETING

  const failed = findMostRecentFailure()
  if (failed) {
    const agentPart = failed.agent ? ` (${failed.agent})` : ""
    return `Got it. The most recent thing that didn't work was ${failed.skill}${agentPart} — want me to try that again, or ask me something else?`
  }
  return "Got it — what would you like me to do next?"
}

function buildStateAnswer(
  intent: NonNullable<AskClassification["stateIntent"]>,
  priorTurns: { role: "user" | "assistant"; text: string }[],
): string {
  if (intent === "state") {
    return [answerCapabilitiesFromState(), "", answerRecentTasksFromState()].join("\n")
  }
  if (intent === "failure") {
    return answerLastFailureFromState()
  }
  if (intent === "conversation") {
    return buildConversationAnswer(priorTurns)
  }
  return "I couldn't tell what you meant. Try rephrasing, or ask what I can do."
}

// specs/097-chat-answer-and-plan-description-honesty/spec.md — a closed,
// explicit set of fixed "nothing to report" strings buildStateAnswer()
// can return, carrying zero real data. Live-caught: appending one of
// these below its own AI-synthesized paraphrase (the existing
// `${synthesized}\n\n${raw}` pattern every Tier-0 answer used
// unconditionally) shows the same message twice with nothing gained —
// unlike the "state" intent's own real agent/task data, or a real
// recorded failure, where the raw block genuinely adds information a
// paraphrase could get wrong. Exact string match, deliberately not a
// heuristic — every member is a literal this file itself defines.
const CANNED_NO_DATA_ANSWERS = new Set<string>([
  CONVERSATION_GREETING,
  "Got it — what would you like me to do next?",
  "No recent task has failed.",
  "I couldn't tell what you meant. Try rephrasing, or ask what I can do.",
])

/** The most recent dispatched skill in a conversation, for follow-up
 *  reuse ("run it again"). Walks backwards so the newest wins. */
function latestDispatchedTurn(conversation: Conversation): ConversationTurn | undefined {
  for (let i = conversation.turns.length - 1; i >= 0; i--) {
    const turn = conversation.turns[i]
    if (turn.skill && turn.taskId) return turn
  }
  return undefined
}

function newTurn(role: ConversationTurn["role"], text: string, extra: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: allocateId("turn", () => false),
    role,
    text,
    timestamp: now(),
    ...extra,
  }
}

// specs/044 Phase 2 — assistant turns are real generated messages, so
// they ride the protocol's own message events. threadId carries the
// CONVERSATION id here, genuinely differing from a runId for the first
// time in this runtime (see packages/shared/ag-ui-events.ts's note).
// Emitted as one content event rather than token-by-token: honest about
// what this runtime actually does, and a client concatenating deltas
// handles both identically.
function emitAssistantMessage(turn: ConversationTurn): void {
  emit({ type: "TEXT_MESSAGE_START", messageId: turn.id, role: "assistant", timestamp: now() })
  emit({ type: "TEXT_MESSAGE_CONTENT", messageId: turn.id, delta: turn.text, timestamp: now() })
  emit({ type: "TEXT_MESSAGE_END", messageId: turn.id, timestamp: now() })
}

/** specs/044 Phase 2 — key-gated, not flag-gated, matching specs/038's
 *  precedent: the endpoint itself is the opt-in, and a configured key is
 *  what makes synthesis possible. Returns null whenever no usable model
 *  is configured, which is a normal outcome, not an error — the caller
 *  then answers with the deterministic material unchanged. */
// specs/097-chat-answer-and-plan-description-honesty/spec.md — a
// test-only call counter, mirroring __setTestRouterModel's own shape
// (apps/orchestrator/detect-skill.test.ts's precedent), so a test can
// directly prove synthesizeAnswer() was never invoked for a canned
// no-data answer — not just that its result happened to be unused.
// Never read or reset outside a test's own beforeEach/afterEach.
let __testSynthesisCallCount = 0
export function __getTestSynthesisCallCount(): number {
  return __testSynthesisCallCount
}
export function __resetTestSynthesisCallCount(): void {
  __testSynthesisCallCount = 0
}

// specs/124-conversation-answer-llm-synthesis/spec.md — test-only seam,
// mirroring __setTestProjectAnalysisModel()'s own established shape, so a
// test can prove synthesizeAnswer() is invoked with the real question and
// real grounding material (not just that it was called) without a real
// provider key.
let __testSynthesisModel: BaseChatModel | null = null
export function __setTestSynthesisModel(model: BaseChatModel | null): void {
  __testSynthesisModel = model
}

async function synthesizeAnswer(
  question: string,
  source: string,
  priorTurns: { role: "user" | "assistant"; text: string }[],
): Promise<string | null> {
  __testSynthesisCallCount += 1

  if (__testSynthesisModel) {
    try {
      return await runAnswerHarness({ model: __testSynthesisModel, question, source, priorTurns })
    } catch (err) {
      console.warn(`[orchestrator] answer synthesis failed, using raw result: ${errorMessage(err)}`)
      return null
    }
  }

  let config: ReturnType<typeof readLlmModelConfig>
  try {
    config = readLlmModelConfig(process.env, "conversation")
  } catch (err) {
    // A misconfigured provider must not silently degrade to raw output
    // without a trace, but it also must not break an answer that already
    // exists deterministically — log loudly, fall back.
    console.warn(`[orchestrator] answer synthesis misconfigured, using raw result: ${errorMessage(err)}`)
    return null
  }
  if (!config) return null

  try {
    const model = await buildChatModel(config)
    return await runAnswerHarness({ model, question, source, priorTurns })
  } catch (err) {
    console.warn(`[orchestrator] answer synthesis failed, using raw result: ${errorMessage(err)}`)
    return null
  }
}

/** Prior turns as harness context, oldest first, excluding the just-added
 *  user turn (which is passed separately as the question). */
function priorTurnsFor(conversation: Conversation, limit = 6): { role: "user" | "assistant"; text: string }[] {
  return conversation.turns
    .slice(0, -1)
    .slice(-limit)
    .map((turn) => ({ role: turn.role, text: turn.text }))
}

/** Phase 1's answer text for a dispatched task: the agent's own real
 *  result, verbatim. Phase 2 layers grounded natural-language synthesis
 *  on top of exactly this, never replacing it (specs/044). */
function answerTextForTerminalTask(task: OrchestratorTask): string {
  if (task.status === "failed") return `That failed: ${task.error ?? "no error reported"}`
  return task.result?.trim() || "(the agent returned no output)"
}

/** Watches a dispatched task to its terminal state and appends the
 *  assistant turn. Deliberately mirrors waitForChildTask()'s existing
 *  polling shape rather than inventing a second waiting mechanism —
 *  including its tolerance of input-required, which is exactly the state
 *  a Tier 1 answer sits in while a human decides. */
async function appendAnswerWhenTaskTerminates(
  conversationId: string,
  taskId: string,
  classification: AskClassification,
  maxWaitMs = 300_000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    await Bun.sleep(1000)
    const task = tasks.get(taskId)
    if (!task) return
    await syncTaskStatus(task)
    if (task.status !== "completed" && task.status !== "failed") continue

    const conversation = conversations.get(conversationId)
    if (!conversation) return

    // The deterministic answer, always. specs/044 Phase 2 layers a
    // synthesized sentence in front of it when a key is configured —
    // additive, never a replacement: `raw` stays in the turn and the
    // task's own result is untouched either way.
    const raw = answerTextForTerminalTask(task)
    const question = [...conversation.turns].reverse().find((t) => t.role === "user")?.text ?? task.text
    const synthesized = await synthesizeAnswer(question.trim(), raw, priorTurnsFor(conversation))

    const turn = newTurn("assistant", synthesized ? `${synthesized}\n\n${raw}` : raw, {
      tier: classification.tier,
      skill: classification.skill,
      reason: classification.reason,
      taskId,
      // specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md —
      // extended to this, the OTHER call site that composes
      // synthesized+raw (a dispatched Tier 1/2 task's own terminal
      // answer, e.g. a real `analyze-project` result) — the exact same
      // "still getting that" complaint Yusuf raised live against a real
      // task-status card, not just the Tier 0 /ask path the spec
      // originally scoped to. Same rule as the Tier 0 branch: `text`
      // stays the full, unchanged value regardless.
      ...(synthesized ? { summary: synthesized } : {}),
    })
    appendTurn(conversation, turn)
    emitAssistantMessage(turn)
    return
  }
}

app.post("/tasks", async (c) => {
  let body: unknown
  try { body = await c.req.json() } catch { return c.json({ error: "Malformed JSON body" }, 400) }

  const parsed = parseOrchestratorSubmission(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  const { text } = parsed

  const skill = await detectSkill(text)
  const dispatched = dispatchRootTask(text, skill)
  if (!dispatched.ok) {
    return c.json({ id: dispatched.taskId, status: "failed", error: dispatched.error })
  }
  return c.json({
    id:            dispatched.task.id,
    // specs/051 — reads the task's real status rather than a hardcoded
    // "assigned". Every dispatch path before suggest-agents' relocation
    // genuinely was "assigned" at this exact point (dispatch always
    // constructs the task with that status, then updates it later,
    // asynchronously), so this is behavior-neutral for them — it only
    // starts to matter for suggest-agents, the first skill in this
    // codebase that can already be "completed" by the time this response
    // is built.
    status:        dispatched.task.status,
    assignedAgent: dispatched.viaSupervisor ? "orchestrator-supervisor" : dispatched.task.assignedAgent,
    skill,
    isPlan:        dispatched.task.isPlan,
  })
})

// specs/044 Phase 1 — extracted verbatim from POST /tasks so /ask
// dispatches through the EXACT same path rather than a second copy of it.
// This repo has already been bitten three separate times by independently
// maintained duplicates of one routing rule (specs/015's `ci`-substring
// bug existed in the Orchestrator, DevOps and Planning simultaneously);
// a second dispatch path would be the same mistake. POST /tasks's
// observable behavior is unchanged — the existing supervisor-wiring suite
// exercises every branch below through the real app.request("/tasks").
export type RootDispatchResult =
  | { ok: false; taskId: string; error: string }
  | { ok: true; task: OrchestratorTask; viaSupervisor: boolean }

// specs/057-project-snapshot-and-cross-request-reuse/spec.md —
// resolveTargetPath() throws on an unresolvable path (no absolute path
// in text, no ORCHESTRAI_PROJECT_PATH); the cache-check/populate call
// sites must never let that throw escape into dispatchRootTask()'s own
// control flow — an unresolvable target simply means "nothing to key
// the cache on," identical in effect to a genuine cache miss.
function tryResolveTargetPathForCache(text: string): string | null {
  try {
    return resolveTargetPath(text)
  } catch {
    return null
  }
}

// specs/057 — the one skill with a cheaper cross-check available.
// git-status is dramatically cheaper than a full analyze-project (which
// also does a direct DevOps-to-Security A2A secrets pre-check), so
// paying for one extra git-status round trip to validate a cached
// analyze-project result is a real net win. A cross-check failure (the
// call itself errors, or the fresh text differs from what was cached)
// is treated identically to "invalidated" — never served, always a
// fresh real dispatch instead, which itself repopulates the cache.
async function resolveAnalyzeProjectFromCacheOrRedispatch(
  task: OrchestratorTask,
  target: string,
  cached: CachedResultRow,
  conversationId: string,
): Promise<void> {
  let validated = false
  try {
    const freshGitStatus = await callAgent("devops", `git status at "${target}"`, {
      timeoutMs: 5_000,
      callerName: "orchestrator",
      taskId: task.id,
      selectedSkill: "git-status",
    })
    validated = freshGitStatus === cached.gitFingerprint
  } catch {
    validated = false
  }

  if (validated) {
    task.status = "completed"
    task.result = cached.result
    tasks.set(task.id, task)
    emitTaskState(task)
    return
  }

  // Invalidated — dispatch a genuine fresh analyze-project through the
  // exact same real path a cache miss would take, reusing this task's
  // own id (already visible to any client watching it) rather than a
  // second one. Errors here surface as a normal task failure, the same
  // as any other agent dispatch failure.
  const agent = findAgentForSkill("analyze-project")
  if (!agent) {
    task.status = "failed"
    task.error = `No agent found for skill: analyze-project`
    tasks.set(task.id, task)
    emitTaskState(task)
    return
  }
  try {
    await sendTaskToAgent(agent, task.text, task.id, { selectedSkill: "analyze-project" })
    task.assignedAgent = agent.card.name
    tasks.set(task.id, task)
    subscribeToAgentStream(task).catch(() => {})
    void populateSnapshotCacheWhenTaskTerminates(conversationId, task.id, "analyze-project", target)
  } catch (err) {
    task.status = "failed"
    task.error = `Could not send task to agent: ${errorMessage(err)}`
    tasks.set(task.id, task)
    emitTaskState(task)
  }
}

// specs/057 — runs only for a conversation-scoped read-only dispatch.
// Polls the same in-memory tasks Map every other terminal-state watcher
// in this file already polls (appendAnswerWhenTaskTerminates's own
// established pattern) rather than inventing a second notification
// mechanism. A failed task is never cached — only a genuine completed
// result is worth reusing.
const CACHE_POPULATE_POLL_MS = 200
const CACHE_POPULATE_TIMEOUT_MS = 30_000

async function populateSnapshotCacheWhenTaskTerminates(
  conversationId: string,
  taskId: string,
  skill: string,
  target: string,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < CACHE_POPULATE_TIMEOUT_MS) {
    const task = tasks.get(taskId)
    if (!task) return
    if (task.status === "completed" && task.result !== undefined) {
      let gitFingerprint: string | null = null
      if (skill === "analyze-project") {
        try {
          gitFingerprint = await callAgent("devops", `git status at "${target}"`, {
            timeoutMs: 5_000,
            callerName: "orchestrator",
            taskId: `${taskId}-fingerprint`,
            selectedSkill: "git-status",
          })
        } catch {
          gitFingerprint = null // captured-fingerprint failure — this entry can never be served as a hit (see the null check at the call site above).
        }
      }
      getSharedStore()?.setCachedResult({
        kind: skill, projectRoot: target, targetRel: RESULT_CACHE_TARGET_REL,
        inputHash: RESULT_CACHE_INPUT_HASH, schemaVer: RESULT_CACHE_SCHEMA_VER,
        result: task.result, gitFingerprint, ttlMs: RESULT_CACHE_TTL_MS, producer: "orchestrator",
      })
      return
    }
    if (task.status === "failed") return
    await Bun.sleep(CACHE_POPULATE_POLL_MS)
  }
}

// specs/102-orchestrator-readonly-project-inspection/spec.md — exported
// so this function's own no-agent inspection fallback can be tested
// directly with an explicit skill. Real natural-language routing can
// never actually name "analyze-project"/"git-status" here when zero
// agents are online — the LLM router validates every proposal against
// the LIVE capability snapshot before using it, so with no agent
// advertising a skill, the router always falls through to "plan-task"
// instead (see CLAUDE.md's "the LLM router is now the only routing
// tier"). This branch's own real-world reach is therefore narrower than
// its original motivation assumed: a genuine defense-in-depth case (an
// agent going offline in the brief window between snapshot-build and
// this call), not the primary mechanism for the "--only orchestrator"
// scenario — that is composeSupervisorResult()'s own zero-dispatch
// surfacing, just above, fed by this same inspection capability. Kept
// here anyway: it is still correct, still costs nothing, and remains
// the right behavior for any future caller that reaches this function
// with an explicit skill outside the LLM-router path.
export function dispatchRootTask(text: string, skill: string, conversationId?: string): RootDispatchResult {
  const taskId = allocateId("task", (candidate) => tasks.has(candidate))
  // specs/044 — registered before ANY event is emitted for this task, so
  // even its RUN_STARTED carries the conversation as threadId. Doing this
  // after dispatch would leave the first event with the wrong thread.
  if (conversationId) taskConversations.set(taskId, conversationId)

  // specs/051-planning-retirement-and-required-key/spec.md Phase 1 —
  // suggest-agents used to be dispatched to the Planning Agent like any
  // other skill; relocated here ahead of Planning's own deletion (that
  // agent no longer exists to advertise the skill, so the `!agent` branch
  // just below would otherwise fail every request). Completes
  // synchronously — no HTTP call, no agent — but is still a real task with
  // a real id, visible in the Tasks list exactly as it was before.
  if (skill === "suggest-agents") {
    const task: OrchestratorTask = {
      id: taskId, text, skill,
      assignedAgent: "orchestrator",
      status: "completed",
      result: buildSuggestAgentsReply(text),
      createdAt: new Date(),
    }
    tasks.set(taskId, task)
    runStarted(taskId)
    emitTaskState(task)
    return { ok: true, task, viaSupervisor: false }
  }

  // specs/051 Phase 4 — real bug found live, not by `bun test` (every test
  // registers a fake "planning-agent" advertising "plan-task" precisely to
  // satisfy the `findAgentForSkill()` call below, which masked this): a
  // plan-task request used to reach the supervisor only AFTER
  // `findAgentForSkill("plan-task")` succeeded below, because Planning
  // Agent's own registry entry was what made that lookup succeed — the
  // supervisor dispatch further down was reached through, not instead of,
  // that lookup. With Planning deleted, no agent advertises "plan-task"
  // any more, so every plan-task request failed closed with "No agent
  // found for skill: plan-task" before ever reaching the supervisor —
  // caught by smoke-testing the real compiled binary end to end, not by
  // the test suite's own registry fake. Handled the same way
  // suggest-agents is just above: decided before `findAgentForSkill`
  // exists to gate it, since the supervisor was never really a
  // registry-discovered agent — it only ever borrowed Planning's entry to
  // pass this same check.
  if (skill === "plan-task") {
    const task: OrchestratorTask = {
      id: taskId, text, skill,
      assignedAgent: "orchestrator-supervisor",
      agentTaskId: `orch-${taskId}`,
      status: "assigned",
      createdAt: new Date(),
      isPlan: true,
    }
    tasks.set(taskId, task)
    runStarted(taskId)
    runOrchestratorSupervisor(task).catch(err => {
      task.status = "failed"
      task.error  = `Orchestrator supervisor run failed: ${err.message}`
      tasks.set(taskId, task)
      emitTaskState(task)
    })
    return { ok: true, task, viaSupervisor: true }
  }

  // specs/057-project-snapshot-and-cross-request-reuse/spec.md, storage
  // migrated onto the durable store by specs/106 B3 — a bare POST /tasks
  // with no conversationId still never consults or populates this cache
  // (a product-behavior choice, not a scoping mechanism — see the
  // result_cache constants' own comment above). Read-only skills only
  // (classifySkillTier(), the same authoritative classification
  // specs/060's own read-only fan-out gate already uses) — a
  // write-capable skill never reaches this branch at all.
  if (conversationId && classifySkillTier(skill) === "read-only" && !EXPLICIT_REFRESH_PATTERN.test(text)) {
    const target = tryResolveTargetPathForCache(text)
    if (target) {
      const cached = getSharedStore()?.getCachedResult({
        kind: skill, projectRoot: target, targetRel: RESULT_CACHE_TARGET_REL,
        inputHash: RESULT_CACHE_INPUT_HASH, schemaVer: RESULT_CACHE_SCHEMA_VER,
      })
      if (cached) {
        if (skill === "analyze-project") {
          // The one skill with a cheaper cross-check available. An entry
          // that never captured a fingerprint (the capture call itself
          // failed at population time) is never treated as a valid hit.
          if (cached.gitFingerprint !== null) {
            const task: OrchestratorTask = {
              id: taskId, text, skill,
              assignedAgent: "orchestrator", // served from cache, no agent dispatch this time
              // Set up front, matching the normal-dispatch task shape below —
              // needed so that IF this entry turns out invalidated,
              // resolveAnalyzeProjectFromCacheOrRedispatch()'s own fresh
              // sendTaskToAgent() call is polled correctly by the existing
              // appendAnswerWhenTaskTerminates()/syncTaskStatus() machinery,
              // which both key off task.agentTaskId.
              agentTaskId: `orch-${taskId}`,
              status: "working",
              createdAt: new Date(),
              isPlan: false,
            }
            tasks.set(taskId, task)
            runStarted(taskId)
            void resolveAnalyzeProjectFromCacheOrRedispatch(task, target, cached, conversationId)
            return { ok: true, task, viaSupervisor: false }
          }
        } else {
          // git-status (and any other read-only skill with no cheaper
          // cross-check than itself) — TTL alone is the gate; already
          // confirmed fresh above.
          const task: OrchestratorTask = {
            id: taskId, text, skill,
            assignedAgent: "orchestrator",
            status: "completed",
            result: cached.result,
            createdAt: new Date(),
            isPlan: false,
          }
          tasks.set(taskId, task)
          runStarted(taskId)
          emitTaskState(task)
          return { ok: true, task, viaSupervisor: false }
        }
      }
    }
  }

  const agent  = findAgentForSkill(skill)

  if (!agent) {
    // specs/102-orchestrator-readonly-project-inspection/spec.md — before
    // failing outright, try the Orchestrator's own direct inspection for
    // the narrow set of skills it can genuinely answer itself
    // (analyze-project, git-status). This is the exact scenario Yusuf
    // raised: "--only orchestrator" (no agents at all) used to fail every
    // project question here unconditionally. Purely additive — it only
    // ever fires on a path that already fails today, and falls through
    // to the identical pre-102 failure the moment inspection also
    // returns null (no client, unresolvable path, or a real call
    // failure).
    if (INSPECTION_FALLBACK_SKILLS.has(skill)) {
      const task: OrchestratorTask = {
        id: taskId, text, skill,
        assignedAgent: "orchestrator",
        status: "working",
        createdAt: new Date(),
      }
      tasks.set(taskId, task)
      runStarted(taskId)
      void inspectTargetProjectAsTaskResult(skill, text, `orch-${taskId}`, conversationId).then((result) => {
        if (result !== null) {
          task.status = "completed"
          task.result = result
          tasks.set(taskId, task)
          emitTaskState(task)
          return
        }
        task.status = "failed"
        task.error = `No agent found for skill: ${skill}`
        tasks.set(taskId, task)
        emittedTerminal.add(taskId)
        runError(taskId, `No agent found for skill: ${skill}`)
      })
      return { ok: true, task, viaSupervisor: false }
    }

    tasks.set(taskId, {
      id: taskId, text, skill,
      status: "failed",
      error: `No agent found for skill: ${skill}`,
      createdAt: new Date(),
    })
    // A run that ends before it ever reaches an agent still gets a proper
    // start/error pair, so a client never sees a terminal event for a run
    // it was never told about.
    runStarted(taskId)
    emittedTerminal.add(taskId)
    runError(taskId, `No agent found for skill: ${skill}`)
    return { ok: false, taskId, error: `No agent found for skill: ${skill}` }
  }

  // specs/051 Phase 4 — `skill` can never be "plan-task" here any more:
  // that case returns early, above, before this function ever calls
  // `findAgentForSkill()`. So this task is always a real, registry-found
  // agent dispatch, never the supervisor. `isPlan: false` stays explicit
  // (not just omitted) to keep POST /tasks's own JSON shape byte-identical
  // for every non-plan-task submission — `undefined` would silently drop
  // the field from the response instead of serializing `false`.
  const task: OrchestratorTask = {
    id: taskId, text, skill,
    assignedAgent: agent.card.name,
    agentTaskId: `orch-${taskId}`,  // deterministic — set up front so approve never races
    status: "assigned",
    createdAt: new Date(),
    isPlan: false,
  }
  tasks.set(taskId, task)
  runStarted(taskId)

  // specs/030 — `skill` was already authoritatively decided above
  // (detectSkill()'s result); send it so the agent executes exactly this,
  // never re-deriving it from `text`.
  sendTaskToAgent(agent, text, taskId, { selectedSkill: skill })
    .then(() => {
      // Live-stream this task's status from the agent instead of waiting for a poll
      subscribeToAgentStream(task).catch(() => {})
    })
    .catch(err => {
      task.status = "failed"
      task.error  = `Could not send task to agent: ${err.message}`
      tasks.set(taskId, task)
      emitTaskState(task)
    })

  // specs/057 — a genuine cache miss (or a read-only skill with no
  // conversationId at all) still populates the cache once this real
  // dispatch actually completes, so the NEXT request in this
  // conversation can benefit even though this one couldn't.
  if (conversationId && classifySkillTier(skill) === "read-only") {
    const target = tryResolveTargetPathForCache(text)
    if (target) void populateSnapshotCacheWhenTaskTerminates(conversationId, taskId, skill, target)
  }

  return { ok: true, task, viaSupervisor: false }
}

// specs/044 Phase 1 — the conversational surface. Additive: it creates
// real tasks through dispatchRootTask() above, so the approval gate, the
// task list and every AG-UI run event keep working untouched. The chat is
// a view onto that machinery, never a parallel one.
app.post("/ask", async (c) => {
  let body: unknown
  try { body = await c.req.json() } catch { return c.json({ error: "Malformed JSON body" }, 400) }

  const { question, conversationId } = (body ?? {}) as { question?: unknown; conversationId?: unknown }
  if (typeof question !== "string" || question.trim().length === 0) {
    return c.json({ error: "question required (non-empty string)" }, 400)
  }
  if (conversationId !== undefined && typeof conversationId !== "string") {
    return c.json({ error: "conversationId must be a string when provided" }, 400)
  }

  // Continue an existing conversation, or start one. An unknown id is a
  // client error rather than a silent new thread — otherwise a typo would
  // quietly lose the history the caller believed it was continuing.
  let conversation: Conversation
  if (conversationId) {
    const existing = conversations.get(conversationId)
    if (!existing) return c.json({ error: `Conversation not found: ${conversationId}` }, 404)
    conversation = existing
  } else {
    conversation = {
      id: allocateId("conv", (candidate) => conversations.has(candidate)),
      createdAt: new Date(),
      turns: [],
    }
    conversations.set(conversation.id, conversation)
    evictOldestConversationsIfNeeded()
  }

  const userTurn = newTurn("user", question.trim())
  appendTurn(conversation, userTurn)

  const previous = latestDispatchedTurn(conversation)
  const previousText = previous ? tasks.get(previous.taskId ?? "")?.text : undefined
  // specs/092-router-classification-conversation-context/spec.md — the
  // one call site that actually has a conversation to draw on. Reuses
  // priorTurnsFor() verbatim, the exact same bounded helper
  // synthesizeAnswer() already relies on for answer phrasing. specs/128
  // adds the last dispatched task's full text, which a long chat can push
  // out of that window.
  const classification = await classifyAsk(
    question,
    (text) => classifyRouterProposal(text, undefined, priorTurnsFor(conversation), previousText),
    {
      previousSkill: previous?.skill,
      previousText,
    },
  )

  // Tier 0 — answered from live state. No task, no dispatch. Synthesis
  // still applies when a key is configured, grounded in that same state
  // text and nothing else.
  if (classification.tier === 0 && classification.stateIntent) {
    const priorTurns = priorTurnsFor(conversation)
    const raw = buildStateAnswer(classification.stateIntent, priorTurns)
    // specs/124-conversation-answer-llm-synthesis/spec.md — a
    // "conversation" intent's raw answer (buildConversationAnswer()) is
    // now grounding material only, not a finished reply: it is a fixed
    // two-branch string blind to what the user actually said (this is
    // the bug specs/124 fixes — "thanks" and a real question about a
    // failure got the identical sentence). Synthesis runs for this
    // branch too, but its result REPLACES raw rather than stacking with
    // it (isConversationIntent below) — the specs/116 regression
    // ("there is 2 person responding me") came from stacking two
    // independently-phrased answers, not from synthesizing at all, and
    // there is no real "raw data" worth keeping collapsible for a reply
    // to "thanks" the way there is for a state/failure report.
    const isConversationIntent = classification.stateIntent === "conversation"
    // specs/097 — a canned, content-free raw answer has nothing for
    // synthesis to add; skip the call entirely (not just discard its
    // result) rather than show the same fixed sentence twice. Does not
    // apply to the conversation branch, which always attempts synthesis
    // (its raw text is dynamic, never a literal member of that set).
    const synthesized = !isConversationIntent && CANNED_NO_DATA_ANSWERS.has(raw)
      ? null
      : await synthesizeAnswer(question.trim(), raw, priorTurns)
    // specs/124 — fail-open: no key / a provider error / exhausted
    // grounding retries all return null here, and the conversation
    // branch falls back to raw (today's exact fixed string) unchanged.
    const answer = isConversationIntent
      ? (synthesized ?? raw)
      : synthesized ? `${synthesized}\n\n${raw}` : raw

    const turn = newTurn("assistant", answer, {
      tier: 0,
      reason: classification.reason,
      // specs/116 — the collapsed-by-default view's own source field;
      // never set for "conversation" (synthesis there replaces the
      // answer outright, so there is nothing separate to collapse),
      // never set when synthesis was skipped/unconfigured/failed (raw
      // alone is already the complete answer in that case too).
      ...(synthesized && !isConversationIntent ? { summary: synthesized } : {}),
    })
    appendTurn(conversation, turn)
    emitAssistantMessage(turn)

    return c.json({
      conversationId: conversation.id,
      tier: 0,
      reason: classification.reason,
      answer,
      requiresApproval: false,
    })
  }

  // Tiers 1 and 2 — real work, through the same dispatch path POST /tasks
  // uses. The assistant turn is appended once the task terminates.
  const skill = classification.skill ?? "plan-task"
  const dispatched = dispatchRootTask(classification.dispatchText ?? question.trim(), skill, conversation.id)

  if (!dispatched.ok) {
    appendTurn(conversation, newTurn("assistant", dispatched.error, {
      tier: classification.tier,
      skill,
      reason: classification.reason,
    }))
    return c.json({
      conversationId: conversation.id,
      tier: classification.tier,
      skill,
      reason: classification.reason,
      answer: dispatched.error,
      requiresApproval: false,
    })
  }

  // specs/046 — expose the existing task/turn relationship as soon as work is
  // dispatched, including while a Tier 1 task is still waiting for approval.
  // The terminal assistant turn will carry the same id later; clients render
  // each linked task once. This uses ConversationTurn's existing optional
  // fields and does not add a second task/conversation protocol.
  userTurn.taskId = dispatched.task.id
  userTurn.tier = classification.tier
  userTurn.skill = skill
  userTurn.reason = classification.reason

  appendAnswerWhenTaskTerminates(conversation.id, dispatched.task.id, classification).catch((err) => {
    console.error(`Ask answer watch failed: ${errorMessage(err)}`)
  })

  return c.json({
    conversationId: conversation.id,
    tier: classification.tier,
    skill,
    reason: classification.reason,
    taskId: dispatched.task.id,
    // Tier 1 skills are write-capable per SKILL_TIER_REGISTRY, so the task
    // may stop at input-required. The gate itself is unchanged — approving
    // still requires POST /tasks/:id/approve with the real actionId.
    requiresApproval: classification.tier === 1,
  })
})

app.get("/conversations", (c) => {
  return c.json({
    count: conversations.size,
    conversations: [...conversations.values()].map((conv) => {
      const seen = new Set<string>()
      const linked = [...conv.turns].reverse().flatMap((turn) => {
        if (!turn.taskId || seen.has(turn.taskId)) return []
        seen.add(turn.taskId)
        const task = tasks.get(turn.taskId)
        return task ? [task] : []
      })
      // Attention wins over recency, then active work, then the newest linked
      // task. This is a projection of deterministic task state, not a model-
      // generated conversation label.
      const representative = linked.find((task) => task.status === "input-required")
        ?? linked.find((task) => task.status === "working" || task.status === "assigned" || task.status === "pending")
        ?? linked[0]
      return {
        id: conv.id,
        createdAt: conv.createdAt,
        turnCount: conv.turns.length,
        lastTurnAt: conv.turns.length ? conv.turns[conv.turns.length - 1].timestamp : null,
        // specs/046 — bounded deterministic label; never model-generated.
        preview: conv.turns.find((turn) => turn.role === "user")?.text.slice(0, 120) ?? "New conversation",
        taskStatus: representative?.status ?? null,
      }
    }),
  })
})

app.get("/conversations/:id", (c) => {
  const conversation = conversations.get(c.req.param("id"))
  if (!conversation) return c.json({ error: "Conversation not found" }, 404)
  return c.json(conversation)
})

app.get("/tasks", (c) => {
  return c.json({ count: tasks.size, tasks: Array.from(tasks.values()).map(withConversationId) })
})

app.get("/tasks/:id", async (c) => {
  const id   = c.req.param("id")
  const task = tasks.get(id)
  if (!task) return c.json({ error: "Task not found" }, 404)

  await syncTaskStatus(task)
  return c.json(withConversationId(task))
})

app.post("/tasks/:id/approve", async (c) => {
  const id   = c.req.param("id")
  const task = tasks.get(id)
  if (!task) return c.json({ error: "Task not found" }, 404)

  // Sync latest status from agent before checking
  await syncTaskStatus(task)

  if (task.status !== "input-required") {
    return c.json({
      error: `Cannot approve — task status is "${task.status}", expected "input-required"`
    }, 409)
  }

  if (!task.agentTaskId) {
    return c.json({ error: "Task has no agentTaskId yet — try again in a moment" }, 400)
  }

  // Orchestrator forwards only the exact actionId it received and displayed
  // from the agent's own input-required preview — a client of the
  // Orchestrator cannot supply or override it.
  if (!task.approval?.actionId) {
    return c.json({ error: "No pending action preview available for this task" }, 409)
  }

  const agent = registry.get(task.assignedAgent!)
  if (!agent) return c.json({ error: "Assigned agent not found in registry" }, 404)

  try {
    const res = await fetch(`${agent.url}/tasks/${task.agentTaskId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: task.approval?.actionId }),
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "unknown" }))
      return c.json({ error: "Agent rejected approval", detail: err }, res.status === 409 ? 409 : 400)
    }

    task.status = "working"
    task.approval = undefined
    tasks.set(id, task)
    // The run can legitimately hit input-required again later (a plan whose
    // next step also needs approval), so clear the de-dup guard rather than
    // permanently suppressing further approval events for this task.
    emittedApproval.delete(id)
    emit({
      type: "CUSTOM",
      name: "orchestrai.approval-resolved",
      value: { taskId: id, decision: "approved" },
      timestamp: now(),
    })

    // The agent's SSE stream closed once it hit input-required — resume watching it
    // now that approval has kicked off execution again.
    subscribeToAgentStream(task).catch(() => {})

    return c.json({
      id,
      status: "working",
      message: `Approved — forwarded to ${agent.card.name}`
    })
  } catch (err) {
    return c.json({ error: `Could not reach agent: ${errorMessage(err)}` }, 500)
  }
})

app.post("/tasks/:id/reject", async (c) => {
  const id   = c.req.param("id")
  const task = tasks.get(id)
  if (!task) return c.json({ error: "Task not found" }, 404)

  await syncTaskStatus(task)

  // A reject must require an existing input-required task — it must never
  // manufacture a task or corrupt an already-terminal one (E2E finding H2).
  if (task.status !== "input-required") {
    return c.json({
      error: `Cannot reject — task status is "${task.status}", expected "input-required"`
    }, 409)
  }
  if (!task.approval?.actionId) {
    return c.json({ error: "No pending action preview available for this task" }, 409)
  }

  const agent = task.assignedAgent ? registry.get(task.assignedAgent) : undefined
  if (agent && task.agentTaskId) {
    try {
      const res = await fetch(`${agent.url}/tasks/${task.agentTaskId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId: task.approval.actionId }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }))
        return c.json({ error: "Agent rejected the rejection request", detail: err }, res.status === 409 ? 409 : 400)
      }
    } catch (err) {
      return c.json({ error: `Could not reach agent: ${errorMessage(err)}` }, 500)
    }
  }

  task.status = "failed"
  task.error  = "Rejected by user"
  task.approval = undefined
  tasks.set(id, task)
  emittedApproval.delete(id)
  // specs/028 — this line is the ONLY place this set is populated: a real
  // rejection request reached this exact point, past both earlier guards
  // (status was genuinely "input-required", a real actionId existed).
  rejectedByOrchestrator.add(id)
  emit({
    type: "CUSTOM",
    name: "orchestrai.approval-resolved",
    value: { taskId: id, decision: "rejected" },
    timestamp: now(),
  })
  emitTaskState(task)
  return c.json({ id, status: "failed", message: "Rejected" })
})

// specs/089-plan-step-skip-continue/spec.md (Option B) — a third approval
// outcome, distinct from reject: the write does not happen (identical
// agent-side effect to a reject — the same agent /reject endpoint is
// reused below, since the agent has no reason to know or care whether the
// Orchestrator is calling this a "skip" or a "reject"; only the
// Orchestrator's own bookkeeping differs), but the RUN is not terminal —
// the adaptive supervisor is re-consulted and may propose a DIFFERENT
// skill next, each reaching its own normal approval gate. Only meaningful
// for a plan step's own child task; a direct (non-plan) task has no "next
// step" for a skip to preserve, so it's refused here with a named error
// pointing at reject instead.
app.post("/tasks/:id/skip", async (c) => {
  const id   = c.req.param("id")
  const task = tasks.get(id)
  if (!task) return c.json({ error: "Task not found" }, 404)

  await syncTaskStatus(task)

  if (!task.parentTaskId) {
    return c.json({
      error: "Cannot skip — this is not a plan step's own child task (no \"next step\" to continue to). Use reject instead."
    }, 400)
  }

  // Identical validation shape to reject, above.
  if (task.status !== "input-required") {
    return c.json({
      error: `Cannot skip — task status is "${task.status}", expected "input-required"`
    }, 409)
  }
  if (!task.approval?.actionId) {
    return c.json({ error: "No pending action preview available for this task" }, 409)
  }

  const agent = task.assignedAgent ? registry.get(task.assignedAgent) : undefined
  if (agent && task.agentTaskId) {
    try {
      // Reused deliberately: the agent's own /reject endpoint already does
      // exactly what a skip needs at the agent level (discard the pending
      // action, never execute it, mark the child task failed) — there is
      // no agent-side concept of "skip" distinct from "reject" to invent.
      const res = await fetch(`${agent.url}/tasks/${task.agentTaskId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId: task.approval.actionId }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }))
        return c.json({ error: "Agent rejected the skip request", detail: err }, res.status === 409 ? 409 : 400)
      }
    } catch (err) {
      return c.json({ error: `Could not reach agent: ${errorMessage(err)}` }, 500)
    }
  }

  task.status = "failed"
  task.error  = "Skipped by user"
  task.approval = undefined
  tasks.set(id, task)
  emittedApproval.delete(id)
  // specs/089 — this line is the ONLY place this set is populated: a real
  // skip request reached this exact point, past both earlier guards
  // (status was genuinely "input-required", a real actionId existed, and
  // this is genuinely a plan step's own child task).
  skippedByOrchestrator.add(id)
  emit({
    type: "CUSTOM",
    name: "orchestrai.approval-resolved",
    value: { taskId: id, decision: "skipped" },
    timestamp: now(),
  })
  emitTaskState(task)
  return c.json({ id, status: "failed", message: "Skipped" })
})

// ============================================================
// PARALLEL WRITE DISPATCH — disjointness gate and grouped approval
// (specs/120-supervisor-parallel-write-dispatch/spec.md)
// ============================================================

/** specs/120 §3 — a stored ApprovalPreview's real OUTPUT path(s): the
 *  single-file `target`, or every `files[].target` for a specs/114
 *  multi-file preview. Deliberately never the dispatch_skill call's own
 *  `target` argument, which is typically a project root, not an output
 *  path (see spec.md's Verified Current State). `resolvePath()` performs
 *  the same separator/relative-segment canonicalization the write path
 *  already applies — never case-folded, never prefix-matched. */
function resolvePreviewPaths(preview: ApprovalPreview): string[] {
  if (preview.files && preview.files.length > 0) return preview.files.map((f) => resolvePath(f.target))
  return [resolvePath(preview.target)]
}

export type DisjointWriteBatch =
  | { eligible: true; branches: OrchestratorTask[] }
  | { eligible: false }

/** specs/120 §3 — the disjointness gate. "The batch" is simply every
 *  currently-`input-required`, write-capable child of `parentId` right
 *  now: under this codebase's own existing sequential-wait invariant
 *  (`waitForChildTask()` blocks a write-capable dispatch until it reaches
 *  a TERMINAL state before the supervisor is ever consulted again, so the
 *  next skill can't even be decided, let alone dispatched, while the
 *  current one is still pending), more than one write-capable child of the
 *  same parent can only be simultaneously `input-required` if they were
 *  dispatched CONCURRENTLY by `dispatchBatch()` — sequential dispatch
 *  structurally cannot produce that overlap. No separate persisted "batch
 *  id" is needed to distinguish a genuine concurrent batch from two
 *  unrelated sequential steps that happen to overlap in time,  because
 *  that overlap cannot happen for a sequential pair in the first place.
 *  Fewer than two eligible branches, or any two sharing any output path,
 *  makes the whole batch ineligible — every branch then falls back to its
 *  own individual approval, exactly as today; nothing is discarded. */
export function computeDisjointBatch(parentId: string): DisjointWriteBatch {
  const branches = Array.from(tasks.values()).filter(
    (t) => t.parentTaskId === parentId && t.status === "input-required" && t.approval !== undefined && classifySkillTier(t.skill) === "write-capable",
  )
  if (branches.length < 2) return { eligible: false }

  const seenPaths = new Set<string>()
  for (const branch of branches) {
    for (const p of resolvePreviewPaths(branch.approval!)) {
      if (seenPaths.has(p)) return { eligible: false }
      seenPaths.add(p)
    }
  }
  return { eligible: true, branches }
}

/** specs/120 — the SAME agent-forwarding shape as POST /tasks/:id/skip,
 *  callable in-process (no HTTP round trip needed, since this runs inside
 *  the same process) for dispatchBatch()'s own sibling-skip. Deliberately
 *  a SEPARATE function from the existing route handler above, rather than
 *  a refactor of it, so that already-tested endpoint carries zero
 *  regression risk from this addition. Best-effort and silent: a child
 *  that has already resolved (approved moments earlier, or already
 *  terminal) by the time this fires is a no-op — it never forces an
 *  already-decided outcome, and never throws. */
async function performInternalSkip(id: string): Promise<void> {
  const task = tasks.get(id)
  if (!task) return
  await syncTaskStatus(task)
  if (task.status !== "input-required") return
  if (!task.approval?.actionId) return

  const agent = task.assignedAgent ? registry.get(task.assignedAgent) : undefined
  if (agent && task.agentTaskId) {
    try {
      const res = await fetch(`${agent.url}/tasks/${task.agentTaskId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId: task.approval.actionId }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return // best-effort — leave the task's own state alone on a forwarding failure
    } catch {
      return
    }
  }

  task.status = "failed"
  task.error = "Skipped by user"
  task.approval = undefined
  tasks.set(id, task)
  emittedApproval.delete(id)
  skippedByOrchestrator.add(id)
  emit({ type: "CUSTOM", name: "orchestrai.approval-resolved", value: { taskId: id, decision: "skipped" }, timestamp: now() })
  emitTaskState(task)
}

// specs/120 §4 — one review, N individually-`actionId`-bound approvals.
// THE LOAD-BEARING PROPERTY: this endpoint never constructs a shared or
// collapsed actionId anywhere — every decision is forwarded to its own
// agent's EXISTING, UNMODIFIED /approve or /reject with that branch's OWN
// actionId, exactly as the single-task endpoints above already do. This
// is an Orchestrator-side fan-out of N real approvals, never a new kind of
// approval. Fail-closed on every input, mirroring the single-task
// endpoints' own 400/409 shapes.
app.post("/tasks/:parentId/approve-batch", async (c) => {
  const parentId = c.req.param("parentId")
  const parent = tasks.get(parentId)
  if (!parent) return c.json({ error: "Task not found" }, 404)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Malformed JSON body" }, 400)
  }
  if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>).decisions)) {
    return c.json({ error: "'decisions' must be an array" }, 400)
  }
  const rawDecisions = (body as { decisions: unknown[] }).decisions

  type Decision = { childTaskId: string; actionId: string; decision: "approve" | "reject" }
  const parsed: Decision[] = []
  for (const raw of rawDecisions) {
    if (typeof raw !== "object" || raw === null) return c.json({ error: "every decision entry must be an object" }, 400)
    const { childTaskId, actionId, decision } = raw as Record<string, unknown>
    if (typeof childTaskId !== "string" || childTaskId.length === 0) {
      return c.json({ error: "every decision entry needs a non-empty 'childTaskId'" }, 400)
    }
    if (typeof actionId !== "string" || actionId.length === 0) {
      return c.json({ error: "every decision entry needs a non-empty 'actionId'" }, 400)
    }
    if (decision !== "approve" && decision !== "reject") {
      return c.json({ error: "every decision entry's 'decision' must be \"approve\" or \"reject\"" }, 400)
    }
    parsed.push({ childTaskId, actionId, decision })
  }

  const seenIds = new Set<string>()
  for (const d of parsed) {
    if (seenIds.has(d.childTaskId)) return c.json({ error: `duplicate childTaskId in decision list: ${d.childTaskId}` }, 400)
    seenIds.add(d.childTaskId)
  }

  // Every listed child must genuinely belong to :parentId and be
  // input-required RIGHT NOW, with its OWN currently-stored actionId
  // matching what was submitted — identical validation shape to the
  // single-task approve/reject endpoints above, per branch.
  for (const d of parsed) {
    const child = tasks.get(d.childTaskId)
    if (!child) return c.json({ error: `Task not found: ${d.childTaskId}` }, 409)
    await syncTaskStatus(child)
    if (child.parentTaskId !== parentId) return c.json({ error: `Task ${d.childTaskId} is not a child of ${parentId}` }, 409)
    if (child.status !== "input-required") {
      return c.json({ error: `Cannot decide ${d.childTaskId} — task status is "${child.status}", expected "input-required"` }, 409)
    }
    if (!child.approval?.actionId) return c.json({ error: `No pending action preview available for ${d.childTaskId}` }, 409)
    if (child.approval.actionId !== d.actionId) return c.json({ error: `actionId mismatch for ${d.childTaskId}` }, 409)
  }

  // Completeness: the decision list must name every currently-eligible
  // branch exactly once — no partial list, no branch outside the eligible
  // set. There is no implicit default for an unlisted branch.
  const batch = computeDisjointBatch(parentId)
  if (!batch.eligible) {
    return c.json({
      error: "This parent has no eligible disjoint write batch right now (fewer than two pending write-capable children, or their targets overlap) — use the individual per-task approve/reject endpoints instead.",
    }, 409)
  }
  const eligibleIds = new Set(batch.branches.map((b) => b.id))
  const listedIds = new Set(parsed.map((d) => d.childTaskId))
  const isComplete = eligibleIds.size === listedIds.size && [...eligibleIds].every((id) => listedIds.has(id))
  if (!isComplete) {
    return c.json({
      error: "The decision list must name every currently-eligible branch exactly once — no partial list, no branch outside the eligible set.",
    }, 400)
  }

  // Every validation passed — forward each decision concurrently to its
  // OWN owning agent's existing /approve or /reject, with that branch's
  // OWN actionId. No shared or collapsed actionId is constructed anywhere
  // above or below this line.
  const results = await Promise.all(parsed.map(async (d) => {
    const child = tasks.get(d.childTaskId)!
    const agent = registry.get(child.assignedAgent!)
    if (!agent) return { childTaskId: d.childTaskId, ok: false, error: "Assigned agent not found in registry" }
    try {
      const res = await fetch(`${agent.url}/tasks/${child.agentTaskId}/${d.decision === "approve" ? "approve" : "reject"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId: d.actionId }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }))
        return { childTaskId: d.childTaskId, ok: false, error: err }
      }
      if (d.decision === "approve") {
        child.status = "working"
        child.approval = undefined
        tasks.set(d.childTaskId, child)
        emittedApproval.delete(d.childTaskId)
        emit({ type: "CUSTOM", name: "orchestrai.approval-resolved", value: { taskId: d.childTaskId, decision: "approved" }, timestamp: now() })
        subscribeToAgentStream(child).catch(() => {})
      } else {
        child.status = "failed"
        child.error = "Rejected by user"
        child.approval = undefined
        tasks.set(d.childTaskId, child)
        emittedApproval.delete(d.childTaskId)
        rejectedByOrchestrator.add(d.childTaskId)
        emit({ type: "CUSTOM", name: "orchestrai.approval-resolved", value: { taskId: d.childTaskId, decision: "rejected" }, timestamp: now() })
        emitTaskState(child)
      }
      return { childTaskId: d.childTaskId, ok: true }
    } catch (err) {
      return { childTaskId: d.childTaskId, ok: false, error: errorMessage(err) }
    }
  }))

  return c.json({ parentId, results })
})

// specs/120 — a read-only companion so a client can learn, WITHOUT
// submitting any decision, whether a parent currently has a groupable
// write batch and what its branches are (each branch's own existing
// ApprovalPreview is already visible via GET /tasks/:id — this endpoint
// only adds the eligibility decision itself). Never mutates anything.
app.get("/tasks/:parentId/pending-batch", (c) => {
  const parentId = c.req.param("parentId")
  if (!tasks.has(parentId)) return c.json({ error: "Task not found" }, 404)
  const batch = computeDisjointBatch(parentId)
  if (!batch.eligible) return c.json({ eligible: false })
  return c.json({ eligible: true, branches: batch.branches.map((b) => ({ id: b.id, skill: b.skill, assignedAgent: b.assignedAgent, approval: b.approval })) })
})

// ============================================================
// DASHBOARD — shared render helpers (used by full page + live fragment)
// ============================================================
export function escapeDashboardHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character)
}

function renderAgentCards(): string {
  const allAgents = Array.from(registry.values())
  return allAgents.length === 0
    ? `<p style="color:#8b949e;font-size:13px">No agents registered yet</p>`
    : allAgents.map(a => {
        const taskCount = [...tasks.values()].filter((task) => task.assignedAgent === a.card.name).length
        return `
        <div class="agent-card" data-agent="${escapeDashboardHtml(a.card.name)}">
          <div class="agent-card-heading">
            <div class="agent-name">${escapeDashboardHtml(a.card.name)}</div>
            <span class="agent-state ${a.status}">${a.status === "online" ? "● online" : "○ offline"}</span>
          </div>
          <div class="agent-description">${escapeDashboardHtml(a.card.description)}</div>
          <div class="agent-url">${escapeDashboardHtml(a.url)}</div>
          <div class="agent-url">last seen ${escapeDashboardHtml(a.lastSeen.toLocaleString())} · ${taskCount} task${taskCount === 1 ? "" : "s"}</div>
          <div class="skills">
            ${a.card.skills.map(s => `<span class="skill">${escapeDashboardHtml(s.id)}</span>`).join("")}
          </div>
          <button class="btn gray agent-tasks" data-agent="${escapeDashboardHtml(a.card.name)}" onclick="openAgentTasks(this.dataset.agent)">View tasks</button>
        </div>
      `
      }).join("")
}

// specs/120-supervisor-parallel-write-dispatch/spec.md §7 — ADDITIVE ONLY:
// a new banner rendered above the existing task table, never a change to
// renderTaskRows()'s own per-row markup or the client's existing
// data-task-id row-patching. Every branch keeps its own individual
// Approve/Reject/Skip buttons in the table below exactly as before — this
// banner is purely a faster path for a disjoint batch, never a
// replacement for the individual controls. One banner per parent task
// that currently has an eligible disjoint write batch (there can be more
// than one plan waiting at once); computeDisjointBatch() is the single
// source of truth this reads, so a client and the /approve-batch endpoint
// itself can never disagree about what "eligible" means.
function renderGroupedBatchBanner(): string {
  const parentIds = new Set(Array.from(tasks.values()).map((t) => t.parentTaskId).filter((id): id is string => Boolean(id)))
  const banners: string[] = []
  for (const parentId of parentIds) {
    const batch = computeDisjointBatch(parentId)
    if (!batch.eligible) continue
    const branchRows = batch.branches.map((b) => {
      const targets = resolvePreviewPaths(b.approval!).join(", ")
      const risks = (b.approval!.risks ?? []).map((r) => `<li>${escapeDashboardHtml(r)}</li>`).join("")
      return `
        <div class="batch-branch" data-batch-child="${escapeDashboardHtml(b.id)}" data-action-id="${escapeDashboardHtml(b.approval!.actionId)}">
          <div class="batch-branch-head"><span class="badge">${escapeDashboardHtml(b.skill)}</span><span class="muted">${escapeDashboardHtml(b.assignedAgent ?? "")}</span></div>
          <div class="muted" style="font-size:12px">${escapeDashboardHtml(targets)}</div>
          <div>${escapeDashboardHtml(b.approval!.summary)}</div>
          ${risks ? `<ul class="approval-risks">${risks}</ul>` : ""}
          <div class="muted" style="font-size:11px">See this row's own "Details" button below for the full content diff before deciding.</div>
          <label class="muted" style="font-size:12px"><input type="checkbox" class="batch-approve-toggle" data-batch-child="${escapeDashboardHtml(b.id)}" checked> Approve this one (uncheck to reject)</label>
        </div>`
    }).join("")
    banners.push(`
      <div class="card batch-banner" data-batch-parent="${escapeDashboardHtml(parentId)}">
        <div class="batch-banner-head">
          <strong>${batch.branches.length} independent writes are ready for review together</strong>
          <span class="muted">(disjoint targets — each still gets its own individual approval underneath)</span>
        </div>
        ${branchRows}
        <div class="task-card-actions">
          <button class="btn green" data-batch-parent="${escapeDashboardHtml(parentId)}" onclick="submitBatch(this.dataset.batchParent)">Submit decisions</button>
        </div>
      </div>`)
  }
  return banners.join("")
}

function renderTaskRows(): string {
  const allTasks = Array.from(tasks.values()).reverse()
  return allTasks.length === 0
    ? `<tr><td colspan="5" class="empty">No tasks yet</td></tr>`
    : allTasks.map(t => {
        const mappedConversation = taskConversations.get(t.id)
        const sourceConversation = mappedConversation && conversations.has(mappedConversation) ? mappedConversation : ""
        return `
        <tr data-task-id="${escapeDashboardHtml(t.id)}" data-agent="${escapeDashboardHtml(t.assignedAgent ?? "")}" data-status="${escapeDashboardHtml(t.status)}" data-conversation="${escapeDashboardHtml(sourceConversation)}">
          <td><code title="${escapeDashboardHtml(t.id)}">${escapeDashboardHtml(t.id.slice(0, 20))}${t.id.length > 20 ? "…" : ""}</code></td>
          <td class="muted task-text" title="${escapeDashboardHtml(t.text)}">
            ${sourceConversation ? `<span style="color:#58a6ff" title="${escapeDashboardHtml(sourceConversation)}">chat · </span>` : ""}${t.parentTaskId ? `<span style="color:#8b949e">↳ child of ${escapeDashboardHtml(t.parentTaskId.slice(0, 15))}...</span> ` : t.isPlan ? `<span style="color:#d29922">📋 plan (${t.planSteps?.length ?? 0} steps)</span> ` : ""}${escapeDashboardHtml(t.text)}
            ${t.parentTaskId && t.status === "input-required"
              ? `<div style="color:#6e7681;font-size:11px;margin-top:2px">Note: this text is planning-time intent, not a promise — review the action in the approval preview before approving.</div>`
              : ""}
          </td>
          <td>${escapeDashboardHtml(t.assignedAgent ?? "-")}</td>
          <td><span class="badge ${escapeDashboardHtml(t.status)}">${escapeDashboardHtml(t.status)}</span></td>
          <td>
            ${t.status === "completed"
              ? `<button class="btn gray" onclick="viewFromRow(this)">View Result</button>`
              : t.status === "input-required"
                ? `<button class="btn green" data-decision-task="${escapeDashboardHtml(t.id)}" onclick="approve(this.dataset.decisionTask)">Approve</button>
                   <button class="btn red" data-decision-task="${escapeDashboardHtml(t.id)}" onclick="reject(this.dataset.decisionTask)">Reject</button>
                   ${t.parentTaskId ? `<button class="btn gray" data-decision-task="${escapeDashboardHtml(t.id)}" onclick="skip(this.dataset.decisionTask)">Skip</button>` : ""}
                   <button class="btn gray" onclick="viewFromRow(this)">Details</button>`
                : t.status === "failed"
                  ? `<button class="btn gray" onclick="viewFromRow(this)">View Error</button>`
                  : "-"
            }
          </td>
        </tr>
      `
      }).join("")
}

// POST /internal/audit-event — specs/021-ag-ui-event-protocol/spec.md.
// Agents push their audit events here the moment they happen (see
// packages/shared/audit.ts); the Orchestrator maps them onto AG-UI
// TOOL_CALL_* events and broadcasts them on /events. Agents stay entirely
// unaware of AG-UI — all protocol mapping lives here, in one place.
//
// Loopback-only in practice, same as every other service boundary in this
// prototype (CLAUDE.md: "No production-grade sandbox, authentication, or
// authorization exists"). Deliberately tolerant: a malformed or unknown
// payload is dropped with 204 rather than erroring, because a failure here
// must never surface as a problem in the calling agent's task path.
app.post("/internal/audit-event", async (c) => {
  let body: unknown
  try { body = await c.req.json() } catch { return c.body(null, 204) }
  const event = mapAuditPushToAgUiEvent(body, now())
  if (event) emit(event)

  // specs/113-live-audit-log-dashboard/spec.md — purely additive:
  // fires alongside the existing TOOL_CALL_* mapping above, from the
  // exact same push, for a second, different consumer (the dashboard's
  // durable-row-shaped live Audit tab, not the tool-call-activity
  // badge/Detail-view mechanism the mapping above already serves).
  // Silently produces nothing for a "start" phase push or an older
  // caller with no paramsWhitelisted field — never a breaking change to
  // the push contract.
  const auditValue = mapAuditPushToAuditEventValue(body, now())
  if (auditValue) {
    emit({ type: "CUSTOM", name: "orchestrai.audit-event", value: auditValue, timestamp: now() })
  }

  return c.body(null, 204)
})

// GET /events — SSE channel that dashboard and TUI both subscribe to.
// Emits AG-UI-shaped events (specs/021-ag-ui-event-protocol/spec.md): a
// STATE_SNAPSHOT on connect so a late/reconnecting client isn't missing
// everything that already happened, then live RUN_*/STEP_*/TOOL_CALL_*/
// CUSTOM events as they occur.
app.get("/events", (c) => {
  return new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        const send = (event: AgUiEvent) => {
          try {
            controller.enqueue(enc.encode(toSseFrame(event)))
          } catch {
            // controller already closed — listener will be cleaned up on abort
          }
        }

        const listener: ChangeListener = (event) => send(event)
        changeListeners.add(listener)

        // Connecting mid-run would otherwise mean an empty view until the
        // next event happens to fire. Send current state up front instead.
        send({
          type: "STATE_SNAPSHOT",
          snapshot: {
            agents: Array.from(registry.values()).map((a) => ({
              name: a.card.name,
              url: a.url,
              status: a.status,
              skills: a.card.skills.map((s) => s.id),
            })),
            tasks: Array.from(tasks.values()).map((t) => ({
              id: t.id,
              text: t.text,
              skill: t.skill,
              assignedAgent: t.assignedAgent,
              status: t.status,
              isPlan: t.isPlan,
              parentTaskId: t.parentTaskId,
            })),
          },
          timestamp: now(),
        })

        // Must stay comfortably under Bun.serve's default 10s per-request
        // idle timeout, or Bun force-closes the connection before this fires
        // (observed live as repeated "[Bun.serve]: request timed out after
        // 10 seconds" + browser ERR_INCOMPLETE_CHUNKED_ENCODING reconnect
        // churn). Do not raise this back toward/above 10000.
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(enc.encode(": heartbeat\n\n"))
          } catch {
            clearInterval(heartbeat)
          }
        }, 5000)

        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(heartbeat)
          changeListeners.delete(listener)
          try { controller.close() } catch {}
        })
      },
    }),
    {
      headers: {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
      },
    }
  )
})

// GET /dashboard/fragment — the live-refreshable pieces of the dashboard,
// re-using the exact same render functions as the full page below.
app.get("/dashboard/fragment", async (c) => {
  await Promise.allSettled(Array.from(tasks.values()).map(t => syncTaskStatus(t)))
  return c.json({
    agentsHtml: renderAgentCards(),
    rowsHtml:   renderTaskRows(),
    // specs/120-supervisor-parallel-write-dispatch/spec.md — additive third
    // field; an older client that doesn't read it is unaffected.
    batchHtml:  renderGroupedBatchBanner(),
  })
})

// ============================================================
// DASHBOARD
// ============================================================
app.get("/dashboard", async (c) => {
  // Sync ALL tasks from their agents before rendering
  await Promise.allSettled(Array.from(tasks.values()).map(t => syncTaskStatus(t)))

  const agentCards = renderAgentCards()
  const rows       = renderTaskRows()
  const batchBanner = renderGroupedBatchBanner()
  const targetProject = escapeDashboardHtml(process.env.ORCHESTRAI_PROJECT_PATH ?? process.cwd())
  const onlineAgentCount = [...registry.values()].filter((agent) => agent.status === "online").length

  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>OrchestrAI — Orchestrator</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{color-scheme:dark;--bg:#0d1117;--surface:#161b22;--surface2:#0f141b;--border:#30363d;--muted:#8b949e;--text:#c9d1d9;--blue:#58a6ff;--green:#3fb950;--amber:#d29922;--red:#f85149}
    html,body{min-height:100%}
    body{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--bg);color:var(--text);font-size:14px}
    button,input,select{font:inherit}
    button:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
    .skip-link{position:fixed;left:12px;top:-60px;z-index:1000;background:#fff;color:#111;padding:8px 12px;border-radius:4px}
    .skip-link:focus{top:12px}
    .app-header{position:sticky;top:0;z-index:50;display:grid;grid-template-columns:minmax(190px,1fr) auto minmax(260px,1fr);align-items:center;gap:20px;padding:14px 24px;border-bottom:1px solid var(--border);background:rgba(13,17,23,.96);backdrop-filter:blur(12px)}
    .brand{color:#f0f6fc;font-size:18px;font-weight:700;letter-spacing:-.02em}
    .brand span{color:var(--blue)}
    .global-nav{display:flex;gap:4px;padding:4px;border:1px solid var(--border);border-radius:8px;background:#0a0e14}
    .nav-tab{border:0;background:transparent;color:var(--muted);padding:7px 16px;border-radius:5px;cursor:pointer;font-weight:700}
    .nav-tab[aria-selected="true"]{color:#fff;background:#1f3a5c;box-shadow:inset 0 -2px 0 var(--blue)}
    .header-context{min-width:0;text-align:right;font-size:11px;color:var(--muted)}
    .target-context{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#e3b341;margin-bottom:3px}
    .connection-line{display:flex;justify-content:flex-end;gap:8px;align-items:center}
    .approval-count{color:var(--amber)}
    .workspace{padding:20px 24px;max-width:1800px;margin:0 auto}
    .view-panel[hidden]{display:none!important}
    .view-title{font-size:18px;color:#f0f6fc;margin-bottom:4px}
    .view-description{color:var(--muted);font-size:12px;margin-bottom:16px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.25rem}
    .chat-layout{display:grid;grid-template-columns:minmax(210px,280px) minmax(420px,1fr) minmax(220px,300px);gap:16px;min-height:calc(100vh - 116px)}
    .conversation-sidebar,.activity-rail{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:12px;min-height:0}
    .sidebar-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
    .sidebar-heading h2{margin:0}
    .conversation-list{display:flex;flex-direction:column;gap:6px;max-height:calc(100vh - 190px);overflow:auto}
    .conversation-item{width:100%;text-align:left;background:transparent;border:1px solid transparent;color:var(--text);border-radius:6px;padding:9px;cursor:pointer}
    .conversation-item:hover{background:#1c222b}
    .conversation-item.active{background:#17263a;border-color:#2a4a70}
    .conversation-preview{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;margin-bottom:4px}
    .conversation-meta{display:flex;justify-content:space-between;color:var(--muted);font-size:10px}
    .chat-main{display:flex;flex-direction:column;min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:9px;overflow:hidden}
    .chat-heading{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px}
    .chat-thread-id{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .chat-thread{flex:1;min-height:360px;max-height:calc(100vh - 255px);overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:20px;scroll-behavior:smooth}
    .chat-empty{margin:auto;max-width:560px;color:var(--muted);font-size:13px;line-height:1.7;text-align:center}
    .empty-examples{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:12px}
    .chat-turn-wrap{display:flex;flex-direction:column;max-width:84%}
    .chat-turn-wrap.user{align-self:flex-end;align-items:flex-end}
    .chat-turn-wrap.assistant{align-self:flex-start;align-items:flex-start}
    .chat-turn{padding:9px 12px;border-radius:10px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
    .chat-turn.user{background:#1f3a5c;color:#e6edf3;border:1px solid #2a4a70}
    .chat-turn.assistant{background:#0f141b;color:var(--text);border:1px solid var(--border)}
    .chat-turn.pending{align-self:flex-start;background:#161b22;color:var(--muted);border:1px dashed var(--border);font-style:italic}
    .turn-meta{font-size:10px;color:#6e7681;margin:4px 3px}
    /* specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md */
    .link-btn{background:none;border:none;padding:0;cursor:pointer;font:inherit;text-decoration:underline}
    .chat-turn-toggle{display:block;margin-top:6px;font-size:11px;color:#58a6ff}
    .task-card{width:min(620px,100%);margin-top:6px;border:1px solid var(--border);border-radius:7px;background:#0d1117;padding:10px 12px}
    .task-card.waiting{border-color:#6e551b;background:#18150d}
    .task-card-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
    .task-card-title{font-weight:700;color:#e6edf3}
    .task-card-summary{color:var(--muted);font-size:11px;line-height:1.5;white-space:pre-wrap;max-height:62px;overflow:hidden}
    .task-card-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
    .inline-approval{border-top:1px solid #5a4718;margin-top:10px;padding-top:10px}
    .inline-approval .approval-content-box{max-height:180px}
    .chat-composer{position:relative;border-top:1px solid var(--border);padding:12px 14px;background:#0f141b}
    .chat-composer .input-row{margin:0}
    .new-updates{display:none;position:absolute;right:18px;top:-40px}
    .activity-list{display:flex;flex-direction:column;gap:8px}
    .activity-item{border-bottom:1px solid #21262d;padding:7px 2px}
    .activity-item:last-child{border-bottom:0}
    .activity-title{display:flex;justify-content:space-between;gap:8px;font-size:11px}
    .activity-agent{color:var(--muted);font-size:10px;margin-top:3px}
    .operations-grid{display:grid;grid-template-columns:minmax(280px,380px) 1fr;gap:16px;align-items:start}
    .task-table-card{min-width:0;overflow:hidden}
    .table-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .table-scroll{overflow:auto}
    select{padding:7px 9px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px}
    .agents-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:16px}
    .agent-card{background:#0d1117;border:1px solid #30363d;border-radius:7px;padding:12px}
    .agent-card-heading{display:flex;justify-content:space-between;gap:8px;align-items:center}
    .agent-name{color:#58a6ff;font-size:13px;font-weight:bold;margin-bottom:2px}
    .agent-description{color:var(--text);font-size:11px;line-height:1.5;margin:6px 0}
    .agent-url{color:#8b949e;font-size:11px;margin-bottom:8px}
    .agent-state{font-size:10px;white-space:nowrap}.agent-state.online{color:var(--green)}.agent-state.offline{color:var(--red)}
    .agent-tasks{margin-top:10px}
    .skills{display:flex;gap:6px;flex-wrap:wrap}
    .skill{background:#1f2937;color:#9ca3af;padding:2px 8px;border-radius:20px;font-size:11px}
    .input-row{display:flex;gap:8px;margin-bottom:8px}
    input{flex:1;padding:8px 12px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-family:monospace;font-size:13px}
    input:focus{border-color:#58a6ff}
    .full-input{width:100%;padding:8px 12px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-family:monospace;font-size:13px;margin-bottom:8px}
    .quick{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;padding:8px 12px;border-bottom:1px solid #30363d;color:#8b949e;font-size:11px;text-transform:uppercase}
    td{padding:10px 12px;border-bottom:1px solid #21262d;font-size:13px;vertical-align:middle}
    .muted{color:#8b949e;font-size:12px}
    .chat-tier{display:inline-block;font-size:10px;letter-spacing:.04em;text-transform:uppercase;padding:1px 6px;border-radius:10px;margin-bottom:4px}
    .chat-tier.t0{background:#0f2114;color:#3fb950;border:1px solid #1e4620}
    .chat-tier.t2{background:#101c2e;color:#58a6ff;border:1px solid #1c3555}
    .chat-tier.t1{background:#3a2e12;color:#d29922;border:1px solid #5a4718}
    tr:last-child td{border-bottom:none}
    .empty{text-align:center;color:#8b949e;padding:2rem!important}
    code{background:#0d1117;padding:2px 6px;border-radius:3px;font-size:12px;color:#79c0ff}
    .badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold}
    .pending {background:#1f2937;color:#9ca3af}
    .assigned{background:#1c3a5e;color:#58a6ff}
    .working{background:#1c3a5e;color:#58a6ff}
    .input-required{background:#3a2f14;color:#d29922}
    .completed{background:#1a3a2a;color:#3fb950}
    .failed{background:#3a1a1a;color:#f85149}
    .btn{padding:5px 12px;border-radius:4px;border:none;cursor:pointer;font-size:12px;font-family:monospace;margin-right:4px}
    .btn:disabled{opacity:.55;cursor:not-allowed}
    .btn.blue{background:#1f6feb;color:#fff}
    .btn.green{background:#238636;color:#fff}
    .btn.red{background:#da3633;color:#fff}
    .btn.gray{background:#21262d;color:#c9d1d9;border:1px solid #30363d}
    .toast{position:fixed;bottom:1.5rem;right:1.5rem;padding:10px 16px;border-radius:6px;font-size:13px;display:none;z-index:999;color:#fff}
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
    .modal-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:1rem}
    .modal-decision-actions{display:none;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
    .return-thread{display:none}
    .mobile-pane-buttons{display:none;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border)}
    @media(max-width:1100px){.app-header{grid-template-columns:1fr auto}.header-context{grid-column:1/-1;text-align:left}.connection-line{justify-content:flex-start}.chat-layout{grid-template-columns:220px 1fr}.activity-rail{grid-column:1/-1}.activity-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}.operations-grid{grid-template-columns:1fr}}
    @media(max-width:720px){.app-header{position:static;grid-template-columns:1fr;padding:12px}.global-nav{width:100%}.nav-tab{flex:1;padding:8px}.header-context{text-align:left}.workspace{padding:12px}.chat-layout{display:block;min-height:0}.mobile-pane-buttons{display:flex}.conversation-sidebar,.activity-rail{display:none;margin-bottom:10px}.conversation-sidebar.mobile-open,.activity-rail.mobile-open{display:block}.conversation-list{max-height:180px}.chat-thread{min-height:50vh;max-height:55vh;padding:12px}.chat-turn-wrap{max-width:96%}.operations-grid{display:block}.operations-grid>.card{margin-bottom:12px}.table-toolbar{align-items:stretch}.table-toolbar select{flex:1}.target-context{white-space:normal;word-break:break-all}.modal{width:96%;max-height:92vh;padding:1rem}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
  </style>
</head>
<body>
  <a class="skip-link" href="#workspace">Skip to workspace</a>
  <header class="app-header">
    <div class="brand">Orchestr<span>AI</span></div>
    <nav class="global-nav" role="tablist" aria-label="Workspace views" onkeydown="handleTabKey(event)">
      <button id="tab-chat" class="nav-tab" role="tab" aria-selected="true" aria-controls="panel-chat" tabindex="0" onclick="navigateTo('chat', conversationId)">Chat</button>
      <button id="tab-tasks" class="nav-tab" role="tab" aria-selected="false" aria-controls="panel-tasks" tabindex="-1" onclick="navigateTo('tasks')">Tasks</button>
      <button id="tab-agents" class="nav-tab" role="tab" aria-selected="false" aria-controls="panel-agents" tabindex="-1" onclick="navigateTo('agents')">Agents</button>
      <button id="tab-audit" class="nav-tab" role="tab" aria-selected="false" aria-controls="panel-audit" tabindex="-1" onclick="navigateTo('audit')">Audit</button>
    </nav>
    <div class="header-context">
      <span class="target-context" title="${targetProject}">project: ${targetProject}</span>
      <span class="connection-line" role="status" aria-live="polite"><span><span id="liveDot" style="color:#8b949e">●</span> <span id="liveLabel">connecting…</span></span><span id="agentCount">${onlineAgentCount} agents online</span><span id="approvalCount" class="approval-count">0 approvals</span><button class="btn gray" onclick="refreshNow()">Refresh</button></span>
    </div>
  </header>

  <main id="workspace" class="workspace">
    <section id="panel-chat" class="view-panel" role="tabpanel" aria-labelledby="tab-chat" tabindex="0">
      <div class="chat-layout">
        <aside class="conversation-sidebar" aria-label="Conversations">
          <div class="sidebar-heading"><h2>Conversations</h2><button class="btn blue" onclick="newConversation()">New</button></div>
          <div id="conversationList" class="conversation-list"><div class="muted">No conversations yet</div></div>
        </aside>
        <section class="chat-main" aria-label="Current conversation">
          <div class="mobile-pane-buttons"><button id="mobileConversationsButton" class="btn gray" aria-expanded="false" onclick="toggleMobilePane('conversations')">Conversations</button><button id="mobileActivityButton" class="btn gray" aria-expanded="false" onclick="toggleMobilePane('activity')">Activity</button></div>
          <div class="chat-heading"><div><h1 id="chatTitle" class="view-title">New conversation</h1><div id="chatMeta" class="chat-thread-id">Ask OrchestrAI to inspect or operate on your project.</div></div><span id="chatReason" class="muted"></span></div>
          <div id="chatThread" class="chat-thread" tabindex="0" aria-live="polite" aria-label="Conversation messages">
            <div class="chat-empty">Ask a question or request work.<div class="empty-examples"><button class="btn gray" onclick="sendAsk('what agents are online?')">Available agents</button><button class="btn gray" onclick="sendAsk('what is my git status?')">Git status</button><button class="btn gray" onclick="sendAsk('is there test coverage?')">Test coverage</button></div></div>
          </div>
          <div class="chat-composer">
            <button id="newUpdates" class="btn blue new-updates" onclick="followChatUpdates()">New updates ↓</button>
            <div class="input-row"><label for="askInput" class="skip-link">Ask OrchestrAI</label><input id="askInput" type="text" autocomplete="off" placeholder="Ask OrchestrAI anything…" onkeydown="if(event.key==='Enter') sendAsk()" /><button id="askButton" class="btn blue" onclick="sendAsk()">Send</button></div>
          </div>
        </section>
        <aside class="activity-rail" aria-label="Recent activity"><div class="sidebar-heading"><h2>Activity</h2><span class="muted">live</span></div><div id="activityList" class="activity-list"><div class="muted">No task activity yet</div></div></aside>
      </div>
    </section>

    <section id="panel-tasks" class="view-panel" role="tabpanel" aria-labelledby="tab-tasks" tabindex="0" hidden>
      <h1 class="view-title">Tasks</h1><p class="view-description">Complete execution history, evidence, and approval controls.</p>
      <div class="operations-grid">
        <div class="card"><h2>Send Task <span class="muted">advanced</span></h2><div class="input-row"><label for="taskInput" class="skip-link">Task instruction</label><input id="taskInput" type="text" placeholder="e.g. analyze project at C:\\path\\to\\project" onkeydown="if(event.key==='Enter') sendTask()" /><button class="btn blue" onclick="sendTask()">Send</button></div><div class="quick"><button class="btn gray" onclick="q('analyze my project')">Analyze</button><button class="btn gray" onclick="q('git status')">Git Status</button><button class="btn gray" onclick="q('dockerize bun app on port 3000')">Dockerfile</button><button class="btn gray" onclick="q('create ci pipeline for bun')">CI Pipeline</button><button class="btn gray" onclick="q('create gitignore for bun')">.gitignore</button><button class="btn gray" onclick="q('what agents do I need to deploy my app?')">Suggest Agents</button><button class="btn gray" onclick="q('setup my project from scratch')">Setup From Scratch</button><button class="btn gray" onclick="q('build and deploy my bun app')">Build &amp; Deploy</button></div></div>
        <div id="groupedBatchBanner">${batchBanner}</div>
        <div class="card task-table-card"><div class="table-toolbar"><label for="statusFilter" class="muted">Status</label><select id="statusFilter" onchange="applyTaskFilters()"><option value="">All statuses</option><option value="pending">Pending</option><option value="assigned">Assigned</option><option value="working">Working</option><option value="input-required">Waiting approval</option><option value="completed">Completed</option><option value="failed">Failed</option></select><label for="agentFilter" class="muted">Agent</label><select id="agentFilter" onchange="applyTaskFilters()"><option value="">All agents</option></select><button class="btn gray" onclick="clearTaskFilters()">Clear filters</button></div><div class="table-scroll"><table><thead><tr><th>Task ID</th><th>Text</th><th>Agent</th><th>Status</th><th>Actions</th></tr></thead><tbody id="taskRows">${rows}</tbody></table></div></div>
      </div>
    </section>

    <section id="panel-agents" class="view-panel" role="tabpanel" aria-labelledby="tab-agents" tabindex="0" hidden>
      <h1 class="view-title">Agents</h1><p class="view-description">Discovered services and their advertised high-level capabilities.</p><div id="agentCards" class="agents-grid">${agentCards}</div><div class="card"><h2>Register Agent <span class="muted">advanced/local</span></h2><label for="agentUrl" class="muted">Agent URL</label><input class="full-input" id="agentUrl" placeholder="http://localhost:3002" /><button class="btn green" onclick="registerAgent()">Register Agent</button></div>
    </section>

    <section id="panel-audit" class="view-panel" role="tabpanel" aria-labelledby="tab-audit" tabindex="0" hidden>
      <h1 class="view-title">Audit</h1><p class="view-description">Every MCP/A2A call this stack has durably recorded — survives a restart. Read-only. Parameters are already redacted before storage; a leaked value here would be a real bug.</p>
      <div class="card">
        <div class="table-toolbar"><label for="auditTaskFilter" class="muted">Task ID</label><input id="auditTaskFilter" type="text" placeholder="filter by task id (optional)" onkeydown="if(event.key==='Enter') loadAuditEvents()" /><button class="btn blue" onclick="loadAuditEvents()">Load</button><button class="btn gray" onclick="document.getElementById('auditTaskFilter').value='';loadAuditEvents()">Clear filter</button></div>
        <div class="table-scroll"><table><thead><tr><th>Time</th><th>Kind</th><th>Caller</th><th>Target</th><th>Task</th><th>Outcome</th><th>Duration</th><th>Result</th><th>Params</th></tr></thead><tbody id="auditRows"><tr><td colspan="9" class="muted">Not loaded yet — click Load.</td></tr></tbody></table></div>
      </div>
    </section>
  </main>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <div class="overlay" id="overlay" onclick="closeModal()">
    <div class="modal" id="taskModal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onclick="event.stopPropagation()" onkeydown="handleModalKey(event)">
      <h3 id="modal-title">Result</h3>
      <div id="modal-approval" class="approval-card" style="display:none"></div>
      <pre id="modal-body"></pre>
      <button id="modal-raw-toggle" class="approval-rawtoggle" style="display:none" onclick="toggleRawJson()">Show raw JSON</button><div id="modalDecisionActions" class="modal-decision-actions"></div><div class="modal-actions"><button id="returnThreadButton" class="btn gray return-thread" onclick="returnToConversation()">Return to conversation</button><button id="modalCloseButton" class="btn gray" onclick="closeModal()">Close</button></div>
    </div>
  </div>

  <script>
    function toast(msg, color) {
      const t = document.getElementById('toast')
      t.textContent = msg
      t.style.background = color || '#238636'
      t.style.display = 'block'
      setTimeout(() => t.style.display = 'none', 2500)
    }

    // specs/046 — dependency-free view state. Hashes contain identifiers only;
    // task results, prompts and approval data never enter browser history.
    const VIEW_NAMES = ['chat', 'tasks', 'agents', 'audit']
    let activeView = 'chat'
    let conversationId = null
    let activeConversation = null
    let conversationSummaries = []
    let taskCache = {}
    let returnConversationId = null
    let chatFollow = true
    let lastRenderedTurnCount = 0
    let modalReturnFocus = null
    const decisionInFlight = new Set()

    function parseDashboardHash(rawHash) {
      const raw = String(rawHash || '').replace(/^#/, '')
      if (!raw) return { view: 'chat', id: null }
      const slash = raw.indexOf('/')
      const view = (slash < 0 ? raw : raw.slice(0, slash)).toLowerCase()
      if (!VIEW_NAMES.includes(view)) return { view: 'chat', id: null }
      if (slash < 0 || slash === raw.length - 1) return { view, id: null }
      try {
        return { view, id: decodeURIComponent(raw.slice(slash + 1)) || null }
      } catch {
        return { view: 'chat', id: null }
      }
    }

    function dashboardHash(view, id) {
      if (!VIEW_NAMES.includes(view)) return '#chat'
      return '#' + view + (id ? '/' + encodeURIComponent(id) : '')
    }

    function navigateTo(view, id) {
      const next = dashboardHash(view, id)
      if (window.location.hash === next) applyLocation()
      else window.location.hash = next
    }

    async function applyLocation() {
      const route = parseDashboardHash(window.location.hash)
      activeView = route.view
      for (const view of VIEW_NAMES) {
        const selected = view === route.view
        const tab = document.getElementById('tab-' + view)
        const panel = document.getElementById('panel-' + view)
        tab.setAttribute('aria-selected', selected ? 'true' : 'false')
        tab.tabIndex = selected ? 0 : -1
        panel.hidden = !selected
      }

      if (route.view === 'chat') {
        hideModalOnly()
        if (route.id) await loadConversation(route.id)
        else if (conversationId || activeConversation) resetConversationView()
      } else if (route.view === 'tasks') {
        if (route.id) await showTaskModal(route.id)
        else hideModalOnly()
      } else if (route.view === 'audit') {
        hideModalOnly()
        // Poll-on-demand, not live-streaming (specs/108's own deliberate
        // scope decision — see that spec's own B7 section) — load once
        // when the tab is first opened, not re-fetched on every refresh
        // cycle the way Tasks/Agents are.
        if (document.getElementById('auditRows').dataset.loaded !== 'true') await loadAuditEvents()
      } else {
        hideModalOnly()
        if (route.id) focusAgent(route.id)
      }
    }

    function handleTabKey(event) {
      const current = VIEW_NAMES.indexOf(parseDashboardHash(window.location.hash).view)
      let next = current < 0 ? 0 : current
      if (event.key === 'ArrowRight') next = (next + 1) % VIEW_NAMES.length
      else if (event.key === 'ArrowLeft') next = (next - 1 + VIEW_NAMES.length) % VIEW_NAMES.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = VIEW_NAMES.length - 1
      else return
      event.preventDefault()
      const view = VIEW_NAMES[next]
      document.getElementById('tab-' + view).focus()
      navigateTo(view, view === 'chat' ? conversationId : null)
    }

    function toggleMobilePane(which) {
      const conversationPane = document.querySelector('.conversation-sidebar')
      const activityPane = document.querySelector('.activity-rail')
      const showConversations = which === 'conversations' && !conversationPane.classList.contains('mobile-open')
      const showActivity = which === 'activity' && !activityPane.classList.contains('mobile-open')
      conversationPane.classList.toggle('mobile-open', showConversations)
      activityPane.classList.toggle('mobile-open', showActivity)
      document.getElementById('mobileConversationsButton').setAttribute('aria-expanded', String(showConversations))
      document.getElementById('mobileActivityButton').setAttribute('aria-expanded', String(showActivity))
    }

    function focusAgent(name) {
      const cards = Array.from(document.querySelectorAll('#agentCards [data-agent]'))
      const match = cards.find((card) => card.dataset.agent === name)
      if (!match) {
        toast('Agent is no longer available', '#da3633')
        return
      }
      match.scrollIntoView({ block: 'center' })
      const button = match.querySelector('button')
      if (button) button.focus()
    }

    window.addEventListener('hashchange', applyLocation)

    // ============================================================
    // LIVE UPDATES — specs/021-ag-ui-event-protocol/spec.md
    //
    // Consumes AG-UI events incrementally: a task's row is patched in place
    // by id, and its tool calls are appended live as they happen, instead of
    // the previous "any event -> refetch and innerHTML-replace both lists"
    // approach. The fragment refetch is kept ONLY for structural changes
    // that add/remove rows (a brand-new task, a new agent), because those
    // rows are server-rendered HTML; everything else patches in place.
    // ============================================================
    // specs/046 Amendment 1 (2026-09-03) — a real, live-caught regression
    // against this file's own comment above: a multi-step plan produces a
    // burst of STEP_STARTED/STEP_FINISHED/TOOL_CALL_* events well outside
    // any single 300ms debounce window, so the OLD innerHTML = rowsHtml
    // here tore down and rebuilt the entire table body several times in
    // quick succession — visible as flashing/flicker while a plan ran.
    // Keyed by data-task-id, the same key renderTaskRows() already emits:
    // a row whose HTML is unchanged is left completely untouched (no
    // node replacement, no flash); a row whose content changed is
    // replaced by itself only; a genuinely new task is inserted in the
    // server's own order; a row for a task no longer in the response is
    // removed. Pure DOM operation, no new dependency.
    function patchTaskRows(container, newHtml) {
      const template = document.createElement('template')
      template.innerHTML = newHtml
      const newRows = Array.from(template.content.querySelectorAll('tr[data-task-id]'))

      // The empty-state row ("No tasks yet") has no data-task-id and is
      // simplest to just swap wholesale — it's one row, never mid-plan.
      if (newRows.length === 0) {
        container.innerHTML = newHtml
        return
      }

      const existingByKey = new Map()
      // A leftover empty-state row (or anything else with no data-task-id,
      // e.g. a stray "toolcalls" evidence row that lost its own task) is
      // never a match for a keyed newRow below, so without this it would
      // sit in the table forever once real tasks start arriving.
      const staleUnkeyed = []
      for (const row of Array.from(container.children)) {
        if (row.dataset && row.dataset.taskId) existingByKey.set(row.dataset.taskId, row)
        else if (!row.classList.contains('toolcalls')) staleUnkeyed.push(row)
      }

      // A matched (already-present) row is never reordered relative to any
      // other matched row: task insertion order (a Map) never changes once
      // a task exists, and rowsHtml is always the same reversed order — so
      // an existing row is always already exactly where it belongs among
      // the other existing rows. Only a genuinely new task (always the
      // newest, so always at the very front) is ever moved with
      // insertBefore. This is load-bearing, not a style choice: an earlier
      // version called insertBefore(node, cursor) unconditionally, and when
      // the very first row's own content changed, replaceWith() had
      // already detached the node cursor was still pointing at that same
      // iteration, so insertBefore threw the "node before which the new
      // node is to be inserted is not a child of this node" error on
      // almost every refresh whose newest task's row changed - caught by
      // refreshNow()'s try/catch and surfaced only as the generic
      // "Could not refresh workspace" toast, never the real error.
      let cursor = container.firstElementChild
      for (const newRow of newRows) {
        const key = newRow.dataset.taskId
        let node = existingByKey.get(key)
        if (node) {
          existingByKey.delete(key)
          if (node.outerHTML !== newRow.outerHTML) {
            node.replaceWith(newRow) // only rows whose content actually changed are touched
            node = newRow
          }
        } else {
          if (newRow !== cursor) container.insertBefore(newRow, cursor) // a new task, placed before the cursor
          node = newRow
        }
        cursor = node.nextElementSibling
      }
      // Anything left in existingByKey is a task no longer in the response.
      for (const stale of existingByKey.values()) stale.remove()
      for (const stale of staleUnkeyed) stale.remove()
    }

    async function refreshNow() {
      try {
        // The fragment endpoint first synchronizes all task states. Fetch its
        // HTML before the JSON projections so task cards cannot be hydrated
        // from a status older than the row that was just rendered.
        const fragmentResponse = await fetch('/dashboard/fragment')
        if (!fragmentResponse.ok) throw new Error('refresh failed')
        const frag = await fragmentResponse.json()
        document.getElementById('agentCards').innerHTML = frag.agentsHtml
        patchTaskRows(document.getElementById('taskRows'), frag.rowsHtml)
        // specs/120-supervisor-parallel-write-dispatch/spec.md — additive;
        // an older cached page without this container simply skips it.
        const batchContainer = document.getElementById('groupedBatchBanner')
        if (batchContainer && typeof frag.batchHtml === 'string') batchContainer.innerHTML = frag.batchHtml
        const [taskResponse, conversationResponse] = await Promise.all([fetch('/tasks'), fetch('/conversations')])
        if (!taskResponse.ok || !conversationResponse.ok) throw new Error('refresh failed')
        const [taskData, conversationData] = await Promise.all([taskResponse.json(), conversationResponse.json()])
        updateTaskData(taskData.tasks || [])
        updateConversationList(conversationData.conversations || [])
        // Re-attach any live tool-call detail the refetched HTML just wiped.
        for (const [taskId, calls] of Object.entries(toolCalls)) {
          for (const call of Object.values(calls)) renderToolCall(taskId, call)
        }
        applyTaskFilters()
        document.getElementById('agentCount').textContent =
          document.querySelectorAll('#agentCards .agent-state.online').length + ' agents online'
        const route = parseDashboardHash(window.location.hash)
        if (route.view === 'tasks' && route.id && document.getElementById('overlay').style.display === 'flex') {
          await showTaskModal(route.id)
        }
      } catch (err) {
        // Logged, not swallowed: a bare catch{} here previously hid the
        // real cause of every refresh failure behind this one generic
        // toast, including the specs/046 Amendment 2 regression - the only
        // reason that root cause took real investigation to find.
        console.error('refreshNow failed:', err)
        toast('Could not refresh workspace', '#da3633')
      }
    }

    // specs/113-live-audit-log-dashboard/spec.md — one badge color per
    // real kind value, so "MCP tool call" vs "A2A call" vs "a real
    // command executed" is legible at a glance instead of plain text
    // indistinguishable from the columns beside it. An unrecognized
    // kind (a stale cached bundle against a future server) falls back
    // to the original plain-text rendering rather than an empty cell.
    const KIND_LABEL = {
      'mcp-tool-call':     { text: 'MCP',  color: '#58a6ff' },
      'a2a-call':          { text: 'A2A',  color: '#3fb950' },
      'command-execution': { text: 'EXEC', color: '#d29922' },
    }
    function renderKindBadge(kind) {
      const label = KIND_LABEL[kind]
      if (!label) return escapeHtml(kind)
      return '<span class="badge" style="color:' + label.color + '">' + label.text + '</span>'
    }

    const AUDIT_ROW_LIMIT = 200

    // specs/113-live-audit-log-dashboard/spec.md — the one place a row's
    // markup is produced, called from both the historical GET /audit
    // fetch and the live SSE append below, so the two can never visually
    // drift. "params" is always a real object here — the historical
    // caller parses its own paramsJson string once before calling this;
    // the live caller already has one from the CUSTOM event's own value.
    function renderAuditRow(e) {
      const time = new Date(e.ts).toLocaleString()
      const resultSummary = 'resultBytes=' + e.resultBytes + (e.resultTruncated ? ' (truncated)' : '')
      const paramsSummary = Object.entries(e.params || {}).map(([k, v]) => k + '=' + v).join(', ')
      return '<tr>' +
        '<td>' + escapeHtml(time) + '</td>' +
        '<td>' + renderKindBadge(e.kind) + '</td>' +
        '<td>' + escapeHtml(e.caller) + '</td>' +
        '<td>' + escapeHtml(e.target) + '</td>' +
        '<td>' + escapeHtml(e.taskId || '') + '</td>' +
        '<td>' + escapeHtml(e.outcome) + '</td>' +
        '<td>' + escapeHtml(e.durationMs) + 'ms</td>' +
        '<td>' + escapeHtml(resultSummary) + '</td>' +
        '<td class="muted">' + escapeHtml(paramsSummary) + '</td>' +
        '</tr>'
    }

    // specs/113-live-audit-log-dashboard/spec.md — live-appends a row
    // from a real orchestrai.audit-event CUSTOM push, alongside the
    // still-unchanged poll-on-demand fetch below (which remains the
    // source of truth for history/filtering). A no-op while the panel
    // has never been opened this session, or while an active task-id
    // filter doesn't match this event's own taskId — the live view must
    // never silently contradict what was explicitly filtered for.
    function prependLiveAuditRow(value) {
      const rowsEl = document.getElementById('auditRows')
      if (rowsEl.dataset.loaded !== 'true') return
      const taskFilter = document.getElementById('auditTaskFilter').value.trim()
      if (taskFilter && value.taskId !== taskFilter) return
      rowsEl.insertAdjacentHTML('afterbegin', renderAuditRow(value))
      while (rowsEl.children.length > AUDIT_ROW_LIMIT) {
        rowsEl.removeChild(rowsEl.lastElementChild)
      }
    }

    // specs/108-durable-audit-trail/spec.md B7 — poll-on-demand/poll-on-
    // filter-change remains the source of truth for history/filtering
    // (specs/113's own live path above is a notification channel, not a
    // replacement). params_json is already whitelisted server-side
    // before it ever reaches this browser; nothing extra is filtered
    // here, only rendered.
    async function loadAuditEvents() {
      const taskFilter = document.getElementById('auditTaskFilter').value.trim()
      const rowsEl = document.getElementById('auditRows')
      rowsEl.innerHTML = '<tr><td colspan="9" class="muted">Loading…</td></tr>'
      try {
        const url = taskFilter ? '/audit?task=' + encodeURIComponent(taskFilter) : '/audit'
        const res = await fetch(url)
        if (!res.ok) throw new Error('audit fetch failed')
        const data = await res.json()
        const events = data.events || []
        rowsEl.dataset.loaded = 'true'
        if (events.length === 0) {
          rowsEl.innerHTML = '<tr><td colspan="9" class="muted">No audit events recorded' + (taskFilter ? ' for this task' : '') + '.</td></tr>'
          return
        }
        rowsEl.innerHTML = events.map((e) => {
          let params = {}
          try { params = JSON.parse(e.paramsJson || '{}') } catch { params = {} }
          return renderAuditRow(Object.assign({}, e, { params }))
        }).join('')
      } catch (err) {
        console.error('loadAuditEvents failed:', err)
        rowsEl.innerHTML = '<tr><td colspan="9" class="muted">Could not load audit events.</td></tr>'
      }
    }

    let refreshTimer = null
    function scheduleRefresh() {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(refreshNow, 300)  // debounce bursts of events
    }

    function setLive(connected) {
      const dot   = document.getElementById('liveDot')
      const label = document.getElementById('liveLabel')
      dot.style.color   = connected ? '#3fb950' : '#f85149'
      label.textContent = connected ? 'live' : 'reconnecting...'
    }

    // taskId -> toolCallId -> {name, caller, outcome, durationMs, content}
    const toolCalls = {}

    function rowFor(taskId) {
      return Array.from(document.querySelectorAll('#taskRows tr[data-task-id]'))
        .find((row) => row.dataset.taskId === taskId) || null
    }

    /** Patches just the status badge of an existing row, no refetch. */
    function patchStatus(taskId, status) {
      if (taskCache[taskId]) taskCache[taskId].status = status
      const row = rowFor(taskId)
      if (!row) { scheduleRefresh(); return }   // row doesn't exist yet — needs the server's HTML
      row.dataset.status = status
      const badge = row.querySelector('.badge')
      if (badge) {
        badge.className = 'badge ' + status
        badge.textContent = status
      }
      // Action buttons differ per status (View Result / Approve+Reject) and
      // are server-rendered; a status change that crosses one of those
      // boundaries still needs the fragment.
      if (status === 'completed' || status === 'input-required' || status === 'failed') {
        scheduleRefresh()
      }
      renderActivity()
      if (activeConversation) renderConversation(activeConversation)
    }

    /** Renders/updates one tool call as a line under its task's row. */
    function renderToolCall(taskId, call) {
      const row = rowFor(taskId)
      if (!row) return
      let host = row.nextElementSibling
      if (!host || !host.classList.contains('toolcalls')) {
        host = document.createElement('tr')
        host.className = 'toolcalls'
        host.innerHTML = '<td colspan="5" style="padding:0 1rem 0.5rem 2rem"></td>'
        row.parentNode.insertBefore(host, row.nextSibling)
      }
      const cell = host.firstElementChild
      let line = cell.querySelector('[data-call="' + call.id + '"]')
      if (!line) {
        line = document.createElement('div')
        line.setAttribute('data-call', call.id)
        line.style.cssText = 'font-family:ui-monospace,monospace;font-size:11.5px;color:#8b949e;padding:2px 0'
        cell.appendChild(line)
      }
      const icon = call.outcome === undefined ? '⋯'
                 : call.outcome === 'completed' ? '✓' : '✗'
      const color = call.outcome === undefined ? '#58a6ff'
                  : call.outcome === 'completed' ? '#3fb950' : '#f85149'
      const timing = call.durationMs !== undefined ? ' · ' + call.durationMs + 'ms' : ''
      line.innerHTML =
        '<span style="color:' + color + '">' + icon + '</span> ' +
        (call.caller ? '<span style="color:#6e7681">' + call.caller + ' → </span>' : '') +
        '<span style="color:#d29922">' + call.name + '</span>' + timing
    }

    const events = new EventSource('/events')
    events.onopen  = () => setLive(true)
    events.onerror = () => setLive(false)

    // Each AG-UI event type gets its own listener — the protocol puts the
    // type in the SSE "event:" line, so EventSource dispatches them by name
    // and there's no need to switch on a field.
    events.addEventListener('STATE_SNAPSHOT', () => scheduleRefresh())
    events.addEventListener('RUN_STARTED',    () => scheduleRefresh())
    events.addEventListener('RUN_FINISHED',   (e) => patchStatus(JSON.parse(e.data).runId, 'completed'))
    events.addEventListener('RUN_ERROR',      (e) => patchStatus(JSON.parse(e.data).runId, 'failed'))
    // specs/113-live-audit-log-dashboard/spec.md — orchestrai.audit-event
    // is handled here directly (a live row append, never a full
    // workspace refresh); every other orchestrai.* CUSTOM name keeps the
    // original unconditional scheduleRefresh() behavior, unchanged.
    events.addEventListener('CUSTOM', (e) => {
      const ev = JSON.parse(e.data)
      if (ev.name === 'orchestrai.audit-event') {
        prependLiveAuditRow(ev.value)
        return
      }
      scheduleRefresh()
    })
    events.addEventListener('STEP_STARTED',   () => scheduleRefresh())
    events.addEventListener('STEP_FINISHED',  () => scheduleRefresh())
    // specs/044 — an assistant turn landed. The event is the nudge; the
    // conversation store is re-read for the content, so the thread can
    // never drift from what the server actually recorded.
    events.addEventListener('TEXT_MESSAGE_END', () => refreshConversation())

    events.addEventListener('TOOL_CALL_START', (e) => {
      const ev = JSON.parse(e.data)
      toolCalls[ev.runId] = toolCalls[ev.runId] || {}
      toolCalls[ev.runId][ev.toolCallId] = {
        id: ev.toolCallId, name: ev.toolCallName, caller: ev.caller
      }
      renderToolCall(ev.runId, toolCalls[ev.runId][ev.toolCallId])
    })

    events.addEventListener('TOOL_CALL_RESULT', (e) => {
      const ev = JSON.parse(e.data)
      const calls = toolCalls[ev.runId] = toolCalls[ev.runId] || {}
      const call = calls[ev.toolCallId] = calls[ev.toolCallId] || { id: ev.toolCallId, name: ev.toolCallId }
      call.outcome = ev.outcome
      call.durationMs = ev.durationMs
      call.content = ev.content
      renderToolCall(ev.runId, call)
    })

    async function registerAgent() {
      const url = document.getElementById('agentUrl').value.trim()
      if (!url) return
      const res  = await fetch('/agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      })
      const data = await res.json()
      if (data.error) { toast(data.error, '#da3633'); return }
      toast('Agent registered!')
      scheduleRefresh()
    }

    async function sendTask(text) {
      const inp = document.getElementById('taskInput')
      const txt = text ?? inp.value.trim()
      if (!txt) return
      const res  = await fetch('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: txt })
      })
      const data = await res.json()
      inp.value = ''
      if (data.error) { toast(data.error, '#da3633'); return }
      toast('Sent to: ' + (data.assignedAgent || 'unknown'))
      scheduleRefresh()
    }

    function q(text) { sendTask(text) }

    // ---------------------------------------------------------
    // specs/046 — shared task/conversation projections. GET endpoints remain
    // authoritative; the browser keeps only a disposable rendering cache.
    // ---------------------------------------------------------
    function escapeChat(text) {
      const div = document.createElement('div')
      div.textContent = String(text ?? '')
      return div.innerHTML
    }

    function statusLabel(status) {
      return ({ pending: 'queued', assigned: 'queued', working: 'running',
        'input-required': 'waiting for approval', completed: 'completed', failed: 'failed' })[status] || status
    }

    function tierLabel(tier) {
      if (tier === 0) return '<span class="chat-tier t0">answered from state</span>'
      if (tier === 2) return '<span class="chat-tier t2">read-only</span>'
      if (tier === 1) return '<span class="chat-tier t1">needs approval</span>'
      return ''
    }

    function formatTime(value) {
      if (!value) return ''
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
    }

    function rebuildAgentFilter() {
      const select = document.getElementById('agentFilter')
      const previous = select.value
      const names = new Set()
      Object.values(taskCache).forEach((task) => { if (task.assignedAgent) names.add(task.assignedAgent) })
      document.querySelectorAll('#agentCards [data-agent]').forEach((card) => names.add(card.dataset.agent))
      select.innerHTML = '<option value="">All agents</option>' + Array.from(names).sort().map((name) =>
        '<option value="' + escapeChat(name) + '">' + escapeChat(name) + '</option>'
      ).join('')
      if (Array.from(select.options).some((option) => option.value === previous)) select.value = previous
    }

    function renderActivity() {
      const host = document.getElementById('activityList')
      const recent = Object.values(taskCache)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 6)
      host.innerHTML = recent.length ? recent.map((task) =>
        '<div class="activity-item"><button class="conversation-item" data-task="' + escapeChat(task.id) + '" onclick="openTaskFromActivity(this.dataset.task)">' +
        '<span class="activity-title"><span>' + escapeChat(task.skill) + '</span><span class="badge ' + escapeChat(task.status) + '">' + escapeChat(statusLabel(task.status)) + '</span></span>' +
        '<span class="activity-agent">' + escapeChat(task.assignedAgent || 'unassigned') + '</span></button></div>'
      ).join('') : '<div class="muted">No task activity yet</div>'
    }

    function updateTaskData(taskList) {
      taskCache = Object.fromEntries(taskList.map((task) => [task.id, task]))
      const approvals = taskList.filter((task) => task.status === 'input-required').length
      document.getElementById('approvalCount').textContent = approvals + (approvals === 1 ? ' approval' : ' approvals')
      rebuildAgentFilter()
      renderActivity()
      if (activeConversation) renderConversation(activeConversation)
      syncDecisionButtons()
    }

    function applyTaskFilters() {
      const status = document.getElementById('statusFilter').value
      const agent = document.getElementById('agentFilter').value
      document.querySelectorAll('#taskRows tr[data-task-id]').forEach((row) => {
        const visible = (!status || row.dataset.status === status) && (!agent || row.dataset.agent === agent)
        row.hidden = !visible
        const evidence = row.nextElementSibling
        if (evidence && evidence.classList.contains('toolcalls')) evidence.hidden = !visible
      })
    }

    function clearTaskFilters() {
      document.getElementById('statusFilter').value = ''
      document.getElementById('agentFilter').value = ''
      applyTaskFilters()
    }

    function openAgentTasks(agent) {
      navigateTo('tasks')
      const select = document.getElementById('agentFilter')
      if (Array.from(select.options).some((option) => option.value === agent)) select.value = agent
      applyTaskFilters()
    }

    function openTaskFromActivity(taskId) {
      returnConversationId = null
      navigateTo('tasks', taskId)
    }

    function updateConversationList(items) {
      conversationSummaries = items.slice().sort((a, b) =>
        new Date(b.lastTurnAt || b.createdAt).getTime() - new Date(a.lastTurnAt || a.createdAt).getTime()
      )
      const host = document.getElementById('conversationList')
      host.innerHTML = conversationSummaries.length ? conversationSummaries.map((summary) => {
        const active = summary.id === conversationId ? ' active' : ''
        const state = summary.taskStatus
          ? '<span class="badge ' + escapeChat(summary.taskStatus) + '">' + escapeChat(statusLabel(summary.taskStatus)) + '</span>'
          : '<span>' + summary.turnCount + ' turns</span>'
        return '<button class="conversation-item' + active + '" data-conversation="' + escapeChat(summary.id) + '" onclick="navigateTo(\\'chat\\', this.dataset.conversation)">' +
          '<span class="conversation-preview">' + escapeChat(summary.preview || 'New conversation') + '</span>' +
          '<span class="conversation-meta"><span>' + escapeChat(formatTime(summary.lastTurnAt || summary.createdAt)) + '</span>' + state + '</span></button>'
      }).join('') : '<div class="muted">No conversations yet</div>'
    }

    async function refreshConversationList() {
      const res = await fetch('/conversations')
      if (!res.ok) return
      const data = await res.json()
      updateConversationList(data.conversations || [])
    }

    function resetConversationView() {
      conversationId = null
      activeConversation = null
      lastRenderedTurnCount = 0
      document.getElementById('chatTitle').textContent = 'New conversation'
      document.getElementById('chatMeta').textContent = 'Ask OrchestrAI to inspect or operate on your project.'
      document.getElementById('chatReason').textContent = ''
      renderConversation(null)
      updateConversationList(conversationSummaries)
    }

    async function loadConversation(id) {
      const requestedId = id
      const res = await fetch('/conversations/' + encodeURIComponent(requestedId))
      if (parseDashboardHash(window.location.hash).id !== requestedId) return
      if (!res.ok) {
        conversationId = null
        activeConversation = null
        document.getElementById('chatTitle').textContent = 'Conversation unavailable'
        document.getElementById('chatMeta').textContent = requestedId
        document.getElementById('chatThread').innerHTML = '<div class="chat-empty">This conversation is no longer available. It may have been evicted or the server may have restarted.<div class="empty-examples"><button class="btn blue" onclick="newConversation()">New conversation</button></div></div>'
        return
      }
      const conversation = await res.json()
      if (conversationId !== conversation.id) {
        chatFollow = true
        lastRenderedTurnCount = 0
      }
      conversationId = conversation.id
      activeConversation = conversation
      document.getElementById('chatTitle').textContent = conversation.turns[0]?.text.slice(0, 80) || 'Conversation'
      document.getElementById('chatMeta').textContent = 'thread ' + conversation.id + ' · ' + conversation.turns.length + ' turns'
      document.getElementById('chatReason').textContent = ''
      renderConversation(conversation)
      updateConversationList(conversationSummaries)
    }

    function taskSummary(task) {
      if (task.error) return task.error
      if (task.result) return task.result
      if (task.isPlan && task.planSteps?.length) return task.planSteps.map((step) => step.order + '. ' + step.description + ' — ' + (step.status || 'pending')).join('\\n')
      return task.text || 'Task is in progress.'
    }

    // specs/046 Amendment 1 (2026-09-03) — a plan's OWN task.status never
    // becomes input-required; only the children it dispatches one at a
    // time do (specs/028/038). Before this, a chat-linked plan with a real,
    // actionId-bound child waiting for approval showed only a running
    // badge — the approval was never bypassed, just invisible from this
    // one surface. Looks up the child purely from taskCache, which
    // updateTaskData() already populates from the same GET /tasks this
    // page already fetches — no new endpoint, no new field.
    function findWaitingPlanChild(task) {
      if (!task.isPlan || !task.childTaskIds?.length) return null
      for (const childId of task.childTaskIds) {
        const child = taskCache[childId]
        if (child && child.status === 'input-required') return child
      }
      return null
    }

    function renderApprovalBlock(approvalTask, disabled) {
      // specs/089-plan-step-skip-continue/spec.md (Option B) — Skip only
      // offered for a plan step's own child task, matching the endpoint's
      // own scope restriction (POST /tasks/:id/skip refuses a direct
      // task). approvalTask.parentTaskId comes straight off the same real
      // GET /tasks data this whole card already renders from.
      const skipButton = approvalTask.parentTaskId
        ? '<button class="btn gray" data-decision-task="' + escapeChat(approvalTask.id) + '" onclick="skip(this.dataset.decisionTask)"' + disabled + '>Skip</button>'
        : ''
      // specs/097-chat-answer-and-plan-description-honesty/spec.md — same
      // scoping as the Skip button: a plan step's own description (shown
      // above this card, either as the step's own task text or the "Step
      // ... needs your approval" note) is planning-time intent, not a
      // promise of the exact action.
      const descriptionNote = approvalTask.parentTaskId
        ? '<div class="muted" style="font-size:11px;margin-bottom:6px">Note: the description above is planning-time intent, not a promise — review the action below before approving.</div>'
        : ''
      return '<div class="inline-approval">' + descriptionNote + '<div class="approval-card">' + renderApprovalCard(approvalTask.approval) + '</div><div class="task-card-actions">' +
        '<button class="btn green" data-decision-task="' + escapeChat(approvalTask.id) + '" onclick="approve(this.dataset.decisionTask)"' + disabled + '>Approve</button>' +
        '<button class="btn red" data-decision-task="' + escapeChat(approvalTask.id) + '" onclick="reject(this.dataset.decisionTask)"' + disabled + '>Reject</button>' +
        skipButton + '</div></div>'
    }

    function renderTaskCard(task, sourceConversationId) {
      if (!task) return '<div class="task-card"><div class="muted">Loading linked task…</div></div>'
      const waitingChild = findWaitingPlanChild(task)
      const waiting = (task.status === 'input-required' || waitingChild) ? ' waiting' : ''
      let approval = ''
      if (task.status === 'input-required' && task.approval) {
        approval = renderApprovalBlock(task, decisionInFlight.has(task.id) ? ' disabled' : '')
      } else if (waitingChild && waitingChild.approval) {
        const note = '<div class="muted" style="margin-bottom:6px">Step "' + escapeChat(waitingChild.skill || '') + '" needs your approval:</div>'
        approval = note + renderApprovalBlock(waitingChild, decisionInFlight.has(waitingChild.id) ? ' disabled' : '')
      }
      return '<div class="task-card' + waiting + '"><div class="task-card-head"><span class="task-card-title">' + escapeChat(task.skill) + '</span>' +
        '<span class="badge ' + escapeChat(task.status) + '">' + escapeChat(statusLabel(task.status)) + '</span><span class="muted">' + escapeChat(task.assignedAgent || 'unassigned') + '</span></div>' +
        '<div class="task-card-summary">' + escapeChat(taskSummary(task).slice(0, 1200)) + '</div><div class="task-card-actions">' +
        '<button class="btn gray" data-task="' + escapeChat(task.id) + '" data-conversation="' + escapeChat(sourceConversationId) + '" onclick="openTaskFromChat(this.dataset.task, this.dataset.conversation)">View task details</button></div>' + approval + '</div>'
    }

    function renderConversation(conv, pendingNote) {
      const thread = document.getElementById('chatThread')
      if (!conv || !conv.turns.length) {
        thread.innerHTML = '<div class="chat-empty">Ask a question or request work.<div class="empty-examples"><button class="btn gray" onclick="sendAsk(\\'what agents are online?\\')">Available agents</button><button class="btn gray" onclick="sendAsk(\\'what is my git status?\\')">Git status</button><button class="btn gray" onclick="sendAsk(\\'is there test coverage?\\')">Test coverage</button></div></div>'
        document.getElementById('newUpdates').style.display = 'none'
        return
      }

      const wasAtBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48
      const seenTasks = new Set()
      const html = conv.turns.map((turn) => {
        const badge = turn.role === 'assistant' ? tierLabel(turn.tier) : ''
        const taskHtml = turn.taskId && !seenTasks.has(turn.taskId)
          ? (seenTasks.add(turn.taskId), renderTaskCard(taskCache[turn.taskId], conv.id))
          : ''
        const meta = '<div class="turn-meta">' + escapeChat(turn.role === 'user' ? 'You' : 'OrchestrAI') + ' · ' + escapeChat(formatTime(turn.timestamp)) + (turn.skill ? ' · ' + escapeChat(turn.skill) : '') + '</div>'
        // specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md —
        // collapsed by default: a turn with a real summary (only ever
        // set for a synthesized "state"/"failure" answer) shows just
        // that, with a toggle to reveal the full text. Both variants are
        // rendered as ordinary escaped TEXT NODE content (never an HTML
        // attribute — escapeChat() doesn't escape quote characters,
        // which is safe for text nodes but not for "..." attribute
        // values) and swapped by visibility, never re-fetched.
        const hasSummary = Boolean(turn.summary) && turn.summary !== turn.text
        const bodyHtml = hasSummary
          ? '<span class="chat-turn-summary">' + escapeChat(turn.summary) + '</span>' +
            '<span class="chat-turn-full" style="display:none">' + escapeChat(turn.text) + '</span>' +
            '<button class="link-btn chat-turn-toggle" onclick="toggleChatTurnFull(this)">▸ full report</button>'
          : escapeChat(turn.text)
        return '<div class="chat-turn-wrap ' + turn.role + '">' + meta + '<div class="chat-turn ' + turn.role + '">' + badge + bodyHtml + '</div>' + taskHtml + '</div>'
      }).join('')

      thread.innerHTML = html + (pendingNote ? '<div class="chat-turn pending">' + escapeChat(pendingNote) + '</div>' : '')
      const hasNewTurns = conv.turns.length > lastRenderedTurnCount
      lastRenderedTurnCount = conv.turns.length
      if (chatFollow || wasAtBottom) {
        thread.scrollTop = thread.scrollHeight
        document.getElementById('newUpdates').style.display = 'none'
      } else if (hasNewTurns) {
        document.getElementById('newUpdates').style.display = 'block'
      }
    }

    // specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md — pure
    // visibility toggle between the two sibling spans renderConversation()
    // already rendered; no re-fetch, no server round trip.
    function toggleChatTurnFull(btn) {
      const container = btn.parentElement
      const summarySpan = container.querySelector('.chat-turn-summary')
      const fullSpan = container.querySelector('.chat-turn-full')
      const showingFull = fullSpan.style.display !== 'none'
      summarySpan.style.display = showingFull ? '' : 'none'
      fullSpan.style.display = showingFull ? 'none' : ''
      btn.textContent = showingFull ? '▸ full report' : '▾ collapse'
    }

    async function refreshConversation(pendingNote) {
      if (!conversationId) return
      await loadConversation(conversationId)
      if (pendingNote && activeConversation) renderConversation(activeConversation, pendingNote)
      await refreshConversationList()
    }

    function newConversation() {
      resetConversationView()
      navigateTo('chat')
      document.getElementById('askInput').focus()
    }

    function followChatUpdates() {
      chatFollow = true
      const thread = document.getElementById('chatThread')
      thread.scrollTop = thread.scrollHeight
      document.getElementById('newUpdates').style.display = 'none'
    }

    function openTaskFromChat(taskId, sourceConversationId) {
      returnConversationId = sourceConversationId || conversationId
      navigateTo('tasks', taskId)
    }

    async function sendAsk(text) {
      const input = document.getElementById('askInput')
      const button = document.getElementById('askButton')
      const question = text ?? input.value.trim()
      if (!question || button.disabled) return
      input.value = ''
      input.disabled = true
      button.disabled = true
      button.textContent = 'Sending…'
      try {
        const res = await fetch('/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(conversationId ? { question, conversationId } : { question })
        })
        const data = await res.json()
        if (!res.ok || data.error) { toast(data.error || 'Question failed', '#da3633'); return }
        conversationId = data.conversationId
        if (data.taskId) {
          taskCache[data.taskId] = { id: data.taskId, skill: data.skill, status: 'assigned', text: question, createdAt: new Date().toISOString() }
        }
        navigateTo('chat', data.conversationId)
        await refreshNow()
        if (data.taskId) await refreshConversation(data.requiresApproval ? 'Task dispatched. Approval details will appear here when the agent reaches the gate.' : 'Task dispatched. Live status will appear here.')
      } catch {
        toast('Could not reach the Orchestrator', '#da3633')
      } finally {
        input.disabled = false
        button.disabled = false
        button.textContent = 'Send'
        input.focus()
      }
    }

    function setDecisionState(id, inFlight) {
      if (inFlight) decisionInFlight.add(id)
      else decisionInFlight.delete(id)
      syncDecisionButtons()
    }

    function syncDecisionButtons() {
      document.querySelectorAll('[data-decision-task]').forEach((button) => {
        button.disabled = decisionInFlight.has(button.dataset.decisionTask)
      })
    }

    async function decide(id, decision) {
      if (decisionInFlight.has(id)) return
      setDecisionState(id, true)
      try {
        const res = await fetch('/tasks/' + encodeURIComponent(id) + '/' + decision, { method: 'POST' })
        const data = await res.json()
        if (!res.ok || data.error) { toast(data.error || 'Decision failed', '#da3633'); return }
        const toastText = decision === 'approve' ? 'Approved!' : decision === 'skip' ? 'Skipped — plan continues' : 'Rejected'
        const toastColor = decision === 'approve' ? '#238636' : decision === 'skip' ? '#d29922' : '#da3633'
        toast(toastText, toastColor)
        await refreshNow()
        if (conversationId) await refreshConversation()
      } catch {
        toast('Could not submit decision', '#da3633')
      } finally {
        setDecisionState(id, false)
      }
    }

    function approve(id) { return decide(id, 'approve') }
    function reject(id) { return decide(id, 'reject') }
    // specs/089-plan-step-skip-continue/spec.md (Option B) — same decide()
    // machinery, a third decision string matching the new endpoint's own
    // path segment (POST /tasks/:id/skip) exactly.
    function skip(id) { return decide(id, 'skip') }

    // specs/120-supervisor-parallel-write-dispatch/spec.md §4/§7 — reads
    // each branch's own checkbox state (checked = approve, unchecked =
    // reject) and its server-issued actionId straight off the DOM the
    // server itself just rendered, then posts ONE decision list to the
    // grouped endpoint. Every decision still carries its own real
    // childTaskId/actionId pair — this never constructs anything the
    // server would treat as a shared approval.
    async function submitBatch(parentId) {
      const banner = document.querySelector('[data-batch-parent="' + CSS.escape(parentId) + '"]')
      if (!banner) return
      const branches = Array.from(banner.querySelectorAll('[data-batch-child]'))
      const decisions = branches.map((el) => ({
        childTaskId: el.dataset.batchChild,
        actionId: el.dataset.actionId,
        decision: el.querySelector('.batch-approve-toggle').checked ? 'approve' : 'reject',
      }))
      const button = banner.querySelector('[onclick^="submitBatch"]')
      if (button) button.disabled = true
      try {
        const res = await fetch('/tasks/' + encodeURIComponent(parentId) + '/approve-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decisions }),
        })
        const data = await res.json()
        if (!res.ok || data.error) { toast(data.error || 'Batch decision failed', '#da3633'); return }
        toast('Batch submitted — ' + decisions.filter((d) => d.decision === 'approve').length + ' approved', '#238636')
        await refreshNow()
      } catch {
        toast('Could not submit batch decision', '#da3633')
      } finally {
        if (button) button.disabled = false
      }
    }

    // specs/033-dashboard-approval-preview-card/spec.md — rendering only.
    // The raw JSON below (modal-body) is always the exact, unchanged
    // JSON.stringify(approval, null, 2) this modal has always shown; the
    // card is a second, additive presentation of the identical data, never
    // a reformatting/reinterpretation of it. No new field is read from the
    // response and target always comes straight from approval.target —
    // never reconstructed from parameters.
    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]))
    }

    // specs/040-approval-preview-content-diff/spec.md — Decision A
    // (dependency-free line diff). Canonical implementation:
    // packages/shared/line-diff.ts. Ported verbatim here rather than
    // imported, the same constraint (and the same solution)
    // specs/033/035 already established for renderApprovalCard()/
    // escapeHtml() themselves — this file's approval card is a browser
    // <script> template string with no bundler linking it to that module.
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

    // specs/040 Decision B: 64 KiB (matches packages/shared/audit.ts's
    // TASK_RESULT_MAX_BYTES — this browser context has no import seam to
    // that module either, so the number is restated, not imported).
    // Checked against the combined pair; over the cap omits the block
    // entirely with a note, never a truncated partial diff — the full
    // value is always available via the raw-JSON toggle regardless.
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

    // specs/114-coder-multi-file-edit-and-create/spec.md — a sibling to
    // contentPreviewHtml() above, for a multi-file proposal (Coder's
    // edit-files skill). Reuses the exact same computeLineDiff()
    // algorithm and CONTENT_PREVIEW_MAX_BYTES cap per file, never a new
    // diff mechanism — one labeled block (path + EDIT/NEW badge) per
    // file, looping instead of one single content/previousContent pair.
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

    async function showTaskModal(id) {
      const wasOpen = document.getElementById('overlay').style.display === 'flex'
      const res = await fetch('/tasks/' + encodeURIComponent(id))
      const approvalEl = document.getElementById('modal-approval')
      const rawToggle = document.getElementById('modal-raw-toggle')
      const bodyEl = document.getElementById('modal-body')
      const decisionActions = document.getElementById('modalDecisionActions')
      const modal = document.getElementById('taskModal')
      const returnButton = document.getElementById('returnThreadButton')
      rawJsonVisible = false

      if (!res.ok) {
        document.getElementById('modal-title').textContent = 'Task unavailable'
        approvalEl.style.display = 'none'
        rawToggle.style.display = 'none'
        decisionActions.style.display = 'none'
        bodyEl.style.display = 'block'
        bodyEl.textContent = 'This task no longer exists: ' + id
        returnButton.style.display = returnConversationId ? 'inline-block' : 'none'
        modal.setAttribute('role', 'dialog')
        openModal(!wasOpen)
        return
      }

      const data = await res.json()
      taskCache[data.id] = data
      let body
      if (data.status === 'input-required' && data.approval) {
        document.getElementById('modal-title').textContent = 'Approval preview — ' + id
        body = JSON.stringify(data.approval, null, 2)
        approvalEl.innerHTML = renderApprovalCard(data.approval)
        approvalEl.style.display = 'block'
        rawToggle.style.display = 'inline'
        rawToggle.textContent = 'Show raw JSON'
        bodyEl.style.display = 'none'
        const disabled = decisionInFlight.has(id) ? ' disabled' : ''
        // specs/089-plan-step-skip-continue/spec.md (Option B) — Skip only
        // for a plan step's own child task, mirroring renderApprovalBlock()
        // above and the endpoint's own scope restriction.
        const skipButton = data.parentTaskId
          ? '<button class="btn gray" data-decision-task="' + escapeChat(id) + '" onclick="skip(this.dataset.decisionTask)"' + disabled + '>Skip</button>'
          : ''
        decisionActions.innerHTML = '<button class="btn green" data-decision-task="' + escapeChat(id) + '" onclick="approve(this.dataset.decisionTask)"' + disabled + '>Approve</button><button class="btn red" data-decision-task="' + escapeChat(id) + '" onclick="reject(this.dataset.decisionTask)"' + disabled + '>Reject</button>' + skipButton
        decisionActions.style.display = 'flex'
        modal.setAttribute('role', 'alertdialog')
      } else {
        document.getElementById('modal-title').textContent = 'Result — ' + id
        const result = data.result ?? data.error ?? '(empty)'
        body = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        approvalEl.style.display = 'none'
        approvalEl.innerHTML = ''
        rawToggle.style.display = 'none'
        bodyEl.style.display = 'block'
        decisionActions.style.display = 'none'
        decisionActions.innerHTML = ''
        modal.setAttribute('role', 'dialog')
      }

      if (data.isPlan && data.planSteps && data.planSteps.length) {
        const stepLines = data.planSteps.map((step) =>
          step.order + '. [' + step.skill + '] ' + step.description + ' — ' + (step.status ?? 'pending') + (step.childTaskId ? ' (' + step.childTaskId + ')' : '')
        ).join('\\n')
        body += '\\n\\n=== Plan Steps ===\\n' + stepLines
      }
      bodyEl.textContent = body
      returnButton.style.display = returnConversationId ? 'inline-block' : 'none'
      openModal(!wasOpen)
    }

    function openModal(shouldFocus) {
      const overlay = document.getElementById('overlay')
      if (overlay.style.display !== 'flex') modalReturnFocus = document.activeElement
      overlay.style.display = 'flex'
      if (shouldFocus !== false) document.getElementById('modalCloseButton').focus()
    }

    function hideModalOnly() {
      const overlay = document.getElementById('overlay')
      const wasOpen = overlay.style.display === 'flex'
      overlay.style.display = 'none'
      if (wasOpen && modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus()
      modalReturnFocus = null
    }

    function view(id, sourceConversationId) {
      returnConversationId = sourceConversationId || null
      navigateTo('tasks', id)
    }

    function viewFromRow(button) {
      const row = button.closest('tr[data-task-id]')
      if (row) view(row.dataset.taskId, row.dataset.conversation)
    }

    function closeModal() {
      const route = parseDashboardHash(window.location.hash)
      if (route.view === 'tasks' && route.id) navigateTo('tasks')
      else hideModalOnly()
    }

    function returnToConversation() {
      const id = returnConversationId
      returnConversationId = null
      hideModalOnly()
      if (id) navigateTo('chat', id)
    }

    function handleModalKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeModal()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(document.getElementById('taskModal').querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter((element) => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }

    document.getElementById('chatThread').addEventListener('scroll', (event) => {
      const thread = event.currentTarget
      chatFollow = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48
      if (chatFollow) document.getElementById('newUpdates').style.display = 'none'
    })

    refreshNow().finally(() => applyLocation())
  </script>
</body>
</html>`)
})

// ============================================================
// STARTUP
// ============================================================
// Migrated to packages/shared/agent-registry.ts so every agent URL is
// overridable via its ORCHESTRAI_<AGENT>_URL env var — required for Docker
// Compose, where each agent is a separate container and "localhost" from
// inside the orchestrator container does not reach them (see
// specs/009-dockerization/spec.md).
// specs/051-planning-retirement-and-required-key/spec.md — Planning
// Agent deleted; agentRegistry.planning no longer exists.
const KNOWN_AGENTS = [
  agentRegistry.devops,
  agentRegistry.testing,
  agentRegistry.documentation,
  agentRegistry.security,
  // specs/082-code-review-agent/spec.md — the entire routing change this
  // new agent needs: findAgentForSkill()/buildCapabilitySnapshot() below
  // already iterate the live registry generically, with no per-agent
  // branch anywhere in the routing path.
  agentRegistry.codeReview,
  // specs/083-coder-agent/spec.md — same one-line addition, same reasoning.
  agentRegistry.coder,
]

// specs/136 — see ./agent-liveness.ts. Runs concurrently per agent; one
// slow agent never delays another's check.
const agentLiveness = new AgentLivenessTracker()

export async function checkAgentLiveness(tracker: AgentLivenessTracker = agentLiveness): Promise<void> {
  const results = await Promise.all(
    Array.from(registry.entries()).map(async ([name, agent]) => [name, await tracker.check(name, agent)] as const),
  )
  const wentOffline = results.filter(([, result]) => result === "went-offline").map(([name]) => name)
  for (const name of wentOffline) {
    console.warn(`[orchestrator] agent ${name} marked offline after ${AGENT_OFFLINE_AFTER_FAILURES} consecutive failed health checks`)
  }
  if (wentOffline.length > 0) agentsUpdated()
}

async function startDiscovery() {
  console.log("Discovering agents...")
  await Promise.allSettled(KNOWN_AGENTS.map(discoverAgent))

  // Retry every 10 seconds for any agent that is offline — and, since
  // specs/136, health-check every online one on the same tick.
  setInterval(async () => {
    void checkAgentLiveness()
    for (const url of KNOWN_AGENTS) {
      const existing = [...registry.values()].find(a => a.url === url)
      if (!existing || existing.status === "offline") {
        const ok = await discoverAgent(url)
        if (ok) console.log(`Late discovery: ${url}`)
      }
    }
  }, 10000)
}

// Guarded so this module can be imported for its pure functions (detectSkill,
// parsePlanText, etc.) in unit tests without binding a real port or starting
// live agent discovery as a side effect. Exported as a named start()
// (specs/017-standalone-binary-distribution/spec.md) so a combined binary can
// also start it on demand the same way `import.meta.main` does today.
export async function start(): Promise<void> {
  loadRecentConversationsFromStore()
  await startDiscovery()

  const PORT = resolveServicePort("orchestrator")
  const orchestratorHttpServer = serve({ fetch: app.fetch, port: PORT })
  console.log(`
Orchestrator running
Dashboard  -> http://localhost:${PORT}/dashboard
Tasks      -> POST http://localhost:${PORT}/tasks
Agents     -> GET  http://localhost:${PORT}/agents
plan-task planner: ${describeSupervisorStartupState()}
`)

  // specs/102-orchestrator-readonly-project-inspection/spec.md — the
  // Orchestrator previously had no shutdown path at all: no SIGINT/
  // SIGTERM handler, and the serve() handle wasn't even retained. That
  // was harmless while the process owned nothing worth stopping; it now
  // does — one callTool() against an unreachable MCP server leaves a
  // perpetual 5-second-interval reconnect loop running for the rest of
  // the process's life (OrchestraiMcpClient's own connectionLoop()).
  // Mirrors packages/agents/documentation/index.ts's own existing shape.
  // specs/106-persistence-store-and-result-cache/spec.md B2 — retention
  // runs only in the Orchestrator (one owner, no cross-process
  // contention): once at startup, then every 15 minutes. A missing/
  // unopenable store is the normal fail-open case, not an error.
  const RESULT_CACHE_MAX_ROWS = 2000
  const RETENTION_INTERVAL_MS = 15 * 60 * 1000
  // specs/107-task-and-conversation-history/spec.md — added to this same
  // Orchestrator-only sweep, not a second interval.
  const TASKS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
  const TASKS_MAX_ROWS = 10_000
  const MAX_STORED_CONVERSATIONS = 200
  const MAX_STORED_TURNS_PER_CONVERSATION = 500
  // specs/108-durable-audit-trail/spec.md — added to this same
  // Orchestrator-only sweep, not a third interval.
  const AUDIT_EVENTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
  const AUDIT_EVENTS_MAX_ROWS = 50_000
  function pruneResultCacheOnce(): void {
    try {
      const store = getSharedStore()
      store?.pruneResultCache(RESULT_CACHE_MAX_ROWS)
      store?.pruneTasks(TASKS_MAX_AGE_MS, TASKS_MAX_ROWS)
      store?.pruneConversations(MAX_STORED_CONVERSATIONS, MAX_STORED_TURNS_PER_CONVERSATION)
      store?.pruneAuditEvents(AUDIT_EVENTS_MAX_AGE_MS, AUDIT_EVENTS_MAX_ROWS)
      // specs/110-approval-state-survives-a-restart/spec.md B0 — added to
      // this same Orchestrator-only sweep, not a fourth interval. Deletes
      // expired 'pending' rows and every 'claimed' row regardless of
      // expiry (an unresolved claim always means an ambiguous, possibly-
      // crashed execution — see that spec's own "Crash during execution"
      // section for why it is never re-restored, only eventually swept).
      store?.pruneExpiredPendingActions(Date.now())
    } catch (err) {
      console.warn(`[orchestrator] store retention sweep failed: ${errorMessage(err)}`)
    }
  }
  pruneResultCacheOnce()
  const retentionTimer = setInterval(pruneResultCacheOnce, RETENTION_INTERVAL_MS)
  retentionTimer.unref()

  let stopping = false
  async function shutdown(): Promise<void> {
    if (stopping) return
    stopping = true
    clearInterval(retentionTimer)
    flushAuditBufferForShutdown()
    if (orchestratorMcpClient) await orchestratorMcpClient.stop()
    orchestratorHttpServer.stop(true)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

if (import.meta.main) {
  await start()
}
