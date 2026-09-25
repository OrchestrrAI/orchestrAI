import { createHash, randomUUID } from "node:crypto"
import { cp, lstat, mkdtemp, open, readdir, realpath, stat } from "node:fs/promises"
import { existsSync, type Dirent } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { SKILL_TIER_REGISTRY } from "../apps/orchestrator/supervisor-graph"
import { DOCKER_BASE_IMAGE_ALLOWLIST, isAllowListedImage, validateDevOpsFile, type DevOpsFileKind } from "../packages/shared/devops-file-validation"
import { resolveServicePort } from "../packages/shared/service-ports"

// specs/141 — defaults follow ORCHESTRAI_<SERVICE>_PORT (specs/073); the
// full-URL variables still win.
const DEFAULT_ORCHESTRATOR_URL = `http://localhost:${resolveServicePort("orchestrator")}`
const DEFAULT_MCP_URL = `http://127.0.0.1:${resolveServicePort("mcpHttp")}/mcp`
const DEFAULT_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 250
const TERMINAL_STATUSES = new Set(["completed", "failed"])

// specs/142 — scenario groups. `core` is the original six and the default;
// `real` approves everything, only on a temp copy, only with --allow-writes.
export const DEMO_GROUPS = ["core", "chat", "parallel", "safety", "real"] as const
export type DemoGroup = (typeof DEMO_GROUPS)[number]
const GROUP_TIMEOUT_MS: Record<DemoGroup, number> = {
  core: 180_000, chat: 240_000, parallel: 240_000, safety: 480_000, real: 1_800_000,
}

export interface DemoOptions {
  project?: string
  orchestrator: string
  allowWrites: boolean
  timeoutMs: number
  help: boolean
  groups: DemoGroup[]
}

/** `--groups` value → ordered, de-duplicated groups. `all` means every
 *  preview group, plus `real` when writes are allowed. */
export function parseGroups(value: string, allowWrites: boolean): DemoGroup[] {
  const wanted = new Set<DemoGroup>()
  for (const raw of value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    if (raw === "all") {
      for (const group of DEMO_GROUPS) if (group !== "real" || allowWrites) wanted.add(group)
    } else if ((DEMO_GROUPS as readonly string[]).includes(raw)) {
      wanted.add(raw as DemoGroup)
    } else {
      throw new Error(`Unknown group "${raw}" — expected ${DEMO_GROUPS.join(", ")} or all`)
    }
  }
  if (wanted.size === 0) throw new Error("--groups needs at least one group")
  if (wanted.has("real") && !allowWrites) throw new Error("The real group approves writes — add --allow-writes")
  return DEMO_GROUPS.filter((group) => wanted.has(group))
}

/** The default overall budget for a set of groups (sum of each group's). */
export function defaultTimeoutFor(groups: DemoGroup[]): number {
  return groups.reduce((sum, group) => sum + GROUP_TIMEOUT_MS[group], 0)
}

/** What a demo copy leaves out: dependencies and OrchestrAI's own state. */
export function shouldCopyEntry(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/)
  return !parts.includes("node_modules") && !parts.includes(".orchestrai")
}

/** The committed demo app (specs/142), the default target. */
export const DEMO_APP_DIR = resolve(import.meta.dir, "..", "context", "demo", "demo-app")

// specs/131 — the DevOps→Security secrets pre-check is opt-in (specs/094),
// so scenario 2 only requires the A2A event when the flag is on.
export function securityPrecheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK === "1"
}

// specs/131 — routing is one LLM judgment (specs/065), so scenario 5 asserts
// the route is read-only rather than naming the exact skill.
export function isReadOnlyRoute(skill: string | undefined): boolean {
  return skill !== undefined && SKILL_TIER_REGISTRY[skill] === "read-only"
}

interface TaskView {
  id: string
  status: string
  skill?: string
  assignedAgent?: string
  parentTaskId?: string
  planSteps?: Array<{ stepName?: string; status?: string }>
  error?: string
  result?: string
  approval?: { actionId?: string; summary?: string; target?: string; content?: string; argv?: string[]; files?: Array<{ target?: string; content?: string }> }
}

interface AgentView {
  name: string
  url: string
  status: string
}

function usage(): string {
  return [
    "Usage: bun run demo:ag-ui -- [options]",
    "",
    "Runs against a fresh temp copy of the demo app (context/demo/demo-app) unless --project is given.",
    "",
    "Options:",
    "  --groups <list>        core (default), chat, parallel, safety, real, or all",
    "  --allow-writes         Allow the real group: approves every step, on a temp copy only",
    "  --project <path>       Target your own project instead of the demo app",
    "  --orchestrator <url>   Orchestrator URL (default: localhost on ORCHESTRAI_ORCHESTRATOR_PORT)",
    "  --timeout-ms <number>  Overall bounded runtime (default: depends on the groups)",
    "  --help                 Show this help",
  ].join("\n")
}

export function parseDemoArgs(argv: string[], env = process.env): DemoOptions {
  const options: DemoOptions = {
    project: env.ORCHESTRAI_PROJECT_PATH,
    orchestrator: env.ORCHESTRAI_ORCHESTRATOR_URL ?? DEFAULT_ORCHESTRATOR_URL,
    allowWrites: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
    groups: ["core"],
  }
  let groupsArg: string | undefined
  let timeoutGiven = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--allow-writes") options.allowWrites = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else if (arg === "--project" || arg === "--orchestrator" || arg === "--timeout-ms" || arg === "--groups") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
      index += 1
      if (arg === "--project") options.project = value
      else if (arg === "--orchestrator") options.orchestrator = value
      else if (arg === "--groups") groupsArg = value
      else {
        timeoutGiven = true
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 5_000) {
          throw new Error("--timeout-ms must be an integer of at least 5000")
        }
        options.timeoutMs = parsed
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (groupsArg !== undefined) options.groups = parseGroups(groupsArg, options.allowWrites)
  if (!timeoutGiven) options.timeoutMs = defaultTimeoutFor(options.groups)
  return options
}

function boundedSignal(overall: AbortSignal, milliseconds = 5_000): AbortSignal {
  return AbortSignal.any([overall, AbortSignal.timeout(milliseconds)])
}

async function fetchJson<T>(url: string, overall: AbortSignal, init?: RequestInit, perCallMs?: number): Promise<T> {
  const response = await fetch(url, { ...init, signal: boundedSignal(overall, perCallMs) })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`${init?.method ?? "GET"} ${url} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function mcpHealthUrl(): string {
  const configured = new URL(process.env.ORCHESTRAI_MCP_URL ?? DEFAULT_MCP_URL)
  configured.pathname = "/healthz"
  configured.search = ""
  configured.hash = ""
  return configured.toString()
}

async function preflight(orchestrator: string, signal: AbortSignal): Promise<void> {
  const base = orchestrator.replace(/\/$/, "")
  await fetchJson(`${base}/healthz`, signal)
  const registry = await fetchJson<{ agents: AgentView[] }>(`${base}/agents`, signal)
  const online = registry.agents.filter((agent) => agent.status === "online")
  if (online.length < 5) {
    throw new Error(`Preflight expected 5 online agents; found ${online.length}`)
  }
  await Promise.all(online.map((agent) => fetchJson(`${agent.url.replace(/\/$/, "")}/healthz`, signal)))
  await fetchJson(mcpHealthUrl(), signal)
}

class EventCollector {
  readonly events: Record<string, any>[] = []
  private readonly listeners = new Set<(event: Record<string, any>) => void>()
  private pump?: Promise<void>
  private capture?: FileHandle

  constructor(
    private readonly url: string,
    private readonly signal: AbortSignal,
    readonly capturePath: string,
  ) {}

  async connect(): Promise<void> {
    this.capture = await open(this.capturePath, "wx")
    const response = await fetch(`${this.url.replace(/\/$/, "")}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: this.signal,
    })
    if (!response.ok || !response.body) throw new Error(`Could not open AG-UI stream: HTTP ${response.status}`)
    this.pump = this.consume(response.body)
    await this.waitFor((event) => event.type === "STATE_SNAPSHOT", "initial STATE_SNAPSHOT")
  }

  mark(): number {
    return this.events.length
  }

  async waitFor(
    predicate: (event: Record<string, any>) => boolean,
    description: string,
    from = 0,
  ): Promise<Record<string, any>> {
    const existing = this.events.slice(from).find(predicate)
    if (existing) return existing

    return new Promise((resolvePromise, reject) => {
      const onAbort = () => finish(() => reject(this.signal.reason ?? new Error(`Timed out waiting for ${description}`)))
      const listener = (event: Record<string, any>) => {
        if (predicate(event)) finish(() => resolvePromise(event))
      }
      const finish = (settle: () => void) => {
        this.listeners.delete(listener)
        this.signal.removeEventListener("abort", onAbort)
        settle()
      }
      this.listeners.add(listener)
      this.signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (!this.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
        const frames = buffer.split("\n\n")
        buffer = frames.pop() ?? ""
        for (const frame of frames) {
          const data = frame.split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (!data) continue
          let event: Record<string, any>
          try { event = JSON.parse(data) } catch { continue }
          this.events.push(event)
          await this.capture?.write(`${JSON.stringify(event)}\n`)
          for (const listener of this.listeners) listener(event)
        }
      }
    } catch (error) {
      if (!this.signal.aborted) throw error
    } finally {
      await reader.cancel().catch(() => {})
    }
  }

  async close(): Promise<void> {
    await this.pump?.catch(() => {})
    await this.capture?.close().catch(() => {})
  }
}

// POST /tasks makes the LLM routing call before it answers (specs/065), so
// it can take far longer than a plain GET; 5 s timed out live (specs/131).
const POST_TASK_TIMEOUT_MS = 60_000

async function postTask(base: string, text: string, signal: AbortSignal): Promise<TaskView> {
  return fetchJson<TaskView>(`${base}/tasks`, signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }, POST_TASK_TIMEOUT_MS)
}

async function waitForTask(
  base: string,
  taskId: string,
  predicate: (task: TaskView) => boolean,
  description: string,
  signal: AbortSignal,
): Promise<TaskView> {
  while (!signal.aborted) {
    const task = await fetchJson<TaskView>(`${base}/tasks/${encodeURIComponent(taskId)}`, signal)
    if (predicate(task)) return task
    await Bun.sleep(POLL_INTERVAL_MS)
  }
  throw signal.reason ?? new Error(`Timed out waiting for ${description}`)
}

async function requireCompleted(base: string, taskId: string, signal: AbortSignal): Promise<TaskView> {
  const task = await waitForTask(base, taskId, (view) => TERMINAL_STATUSES.has(view.status), "task completion", signal)
  if (task.status !== "completed") throw new Error(`Task ${taskId} failed: ${task.error ?? "unknown error"}`)
  return task
}

async function rejectTask(base: string, taskId: string, signal: AbortSignal): Promise<void> {
  await fetchJson(`${base}/tasks/${encodeURIComponent(taskId)}/reject`, signal, { method: "POST" })
}

async function runDefaultScenarios(
  base: string,
  project: string,
  events: EventCollector,
  signal: AbortSignal,
): Promise<void> {
  console.log("1/6 git-status: MCP lifecycle")
  let mark = events.mark()
  const gitStatus = await postTask(base, `git status at "${project}"`, signal)
  await requireCompleted(base, gitStatus.id, signal)
  await events.waitFor((event) => event.type === "TOOL_CALL_START" && event.runId === gitStatus.id, "git-status tool start", mark)
  await events.waitFor((event) => event.type === "TOOL_CALL_RESULT" && event.runId === gitStatus.id, "git-status tool result", mark)
  await events.waitFor((event) => event.type === "RUN_FINISHED" && event.runId === gitStatus.id, "git-status run finish", mark)

  const precheck = securityPrecheckEnabled()
  console.log(`2/6 analyze-project: MCP${precheck ? " plus direct Security A2A" : " (Security pre-check is opt-in and off)"}`)
  mark = events.mark()
  const analysis = await postTask(base, `analyze my project at "${project}"`, signal)
  await requireCompleted(base, analysis.id, signal)
  const mcpStart = await events.waitFor((event) => event.type === "TOOL_CALL_START" && event.runId === analysis.id && event.toolCallName === "analyze_project", "analyze_project MCP start", mark)
  await events.waitFor((event) => event.type === "TOOL_CALL_RESULT" && event.runId === analysis.id && event.toolCallId === mcpStart.toolCallId, "analyze_project MCP result", mark)
  const sawA2a = events.events.slice(mark).some((event) => event.type === "TOOL_CALL_START" && event.runId === analysis.id && event.toolCallName === "security-agent")
  if (precheck) {
    const a2aStart = await events.waitFor((event) => event.type === "TOOL_CALL_START" && event.runId === analysis.id && event.toolCallName === "security-agent", "Security A2A start", mark)
    await events.waitFor((event) => event.type === "TOOL_CALL_RESULT" && event.runId === analysis.id && event.toolCallId === a2aStart.toolCallId, "Security A2A result", mark)
  } else if (sawA2a) {
    throw new Error("Security A2A pre-check ran although ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK is not 1")
  }

  console.log("3/6 approval-gated write: reject without mutation")
  mark = events.mark()
  const write = await postTask(base, `dockerize bun app on port 4000 at "${project}"`, signal)
  await waitForTask(base, write.id, (task) => task.status === "input-required", "write approval", signal)
  await events.waitFor((event) => event.type === "CUSTOM" && event.name === "orchestrai.approval-required" && event.value?.taskId === write.id, "approval-required event", mark)
  await rejectTask(base, write.id, signal)
  await waitForTask(base, write.id, (task) => task.status === "failed", "rejected task", signal)
  await events.waitFor((event) => event.type === "CUSTOM" && event.name === "orchestrai.approval-resolved" && event.value?.taskId === write.id && event.value?.decision === "rejected", "approval rejection event", mark)
  await events.waitFor((event) => event.type === "RUN_ERROR" && event.runId === write.id, "rejected run error", mark)

  console.log("4/6 multi-step plan: observe steps and reject its write child")
  mark = events.mark()
  // Name the path explicitly so the plan's steps target this project, not
  // the configured default (the resolver scans every "at/in/to/from/for/on
  // <path>" clause and keeps the first absolute one — specs/087, specs/140).
  const plan = await postTask(base, `setup project at "${project}"`, signal)
  await events.waitFor((event) => event.type === "STEP_STARTED" && event.runId === plan.id, "plan step start", mark)
  let rejectedChild: TaskView | undefined
  while (!signal.aborted && !rejectedChild) {
    const listing = await fetchJson<{ tasks: TaskView[] }>(`${base}/tasks`, signal)
    rejectedChild = listing.tasks.find((task) => task.parentTaskId === plan.id && task.status === "input-required")
    if (!rejectedChild) await Bun.sleep(POLL_INTERVAL_MS)
  }
  if (!rejectedChild) throw new Error("Plan never produced an approval-gated child")
  await rejectTask(base, rejectedChild.id, signal)
  await waitForTask(base, rejectedChild.id, (task) => task.status === "failed", "rejected plan child", signal)
  await events.waitFor((event) => event.type === "STEP_FINISHED" && event.runId === plan.id && event.outcome === "failed", "failed plan step", mark)

  console.log("5/6 LLM routing: read-only")
  mark = events.mark()
  const routed = await postTask(base, `make sure there's no leaked api key in here at "${project}"`, signal)
  if (!isReadOnlyRoute(routed.skill)) {
    throw new Error(`LLM routing chose ${routed.skill ?? "unknown"}, which is not a read-only skill`)
  }
  console.log(`    routed to ${routed.skill}`)
  await requireCompleted(base, routed.id, signal)
  await events.waitFor((event) => event.type === "RUN_FINISHED" && event.runId === routed.id, "read-only route finish", mark)
  if (events.events.slice(mark).some((event) => event.type === "CUSTOM" && event.name === "orchestrai.approval-required" && event.value?.taskId === routed.id)) {
    throw new Error("A read-only route asked for approval")
  }

  console.log("6/6 synthetic correlation: two distinct caller-provided IDs")
  mark = events.mark()
  for (const callId of ["demo-call-A", "demo-call-B"]) {
    await fetchJson(`${base}/internal/audit-event`, signal, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phase: "start",
        kind: "mcp-tool-call",
        caller: "demo-runner",
        target: "git_status",
        taskId: "demo-correlation",
        callId,
      }),
    })
  }
  for (const callId of ["demo-call-A", "demo-call-B"]) {
    await events.waitFor((event) => event.type === "TOOL_CALL_START" && event.toolCallId === callId, `synthetic ${callId}`, mark)
  }
}

// ============================================================
// specs/142 — shared helpers for the new groups
// ============================================================
interface AskReply {
  conversationId: string
  tier?: number
  skill?: string
  taskId?: string
  answer?: string
  requiresApproval?: boolean
}

async function ask(base: string, question: string, signal: AbortSignal, conversationId?: string): Promise<AskReply> {
  return fetchJson<AskReply>(`${base}/ask`, signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conversationId ? { question, conversationId } : { question }),
  }, POST_TASK_TIMEOUT_MS)
}

async function childrenOf(base: string, parentId: string, signal: AbortSignal): Promise<TaskView[]> {
  const listing = await fetchJson<{ tasks: TaskView[] }>(`${base}/tasks`, signal)
  return listing.tasks.filter((task) => task.parentTaskId === parentId)
}

type Decision = "approve" | "reject" | "skip"

/** Follows a task (and a plan's children) to the end, answering every
 *  approval with `decide`. A task can ask more than once (edit-and-verify),
 *  so each approval is keyed by its own actionId. Returns the final root
 *  view and how many approvals were answered. */
async function driveTask(
  base: string,
  rootId: string,
  decide: (task: TaskView) => Decision,
  signal: AbortSignal,
): Promise<{ root: TaskView; answered: number; decisions: Decision[] }> {
  const handled = new Set<string>()
  const decisions: Decision[] = []
  while (!signal.aborted) {
    const root = await fetchJson<TaskView>(`${base}/tasks/${encodeURIComponent(rootId)}`, signal)
    if (TERMINAL_STATUSES.has(root.status)) return { root, answered: handled.size, decisions }
    const waiting = [root, ...await childrenOf(base, rootId, signal)].filter((task) => task.status === "input-required")
    for (const task of waiting) {
      const view = await fetchJson<TaskView>(`${base}/tasks/${encodeURIComponent(task.id)}`, signal)
      const key = view.approval?.actionId ?? `${view.id}:${view.status}`
      if (view.status !== "input-required" || handled.has(key)) continue
      handled.add(key)
      const decision = decide(view)
      decisions.push(decision)
      console.log(`    ↳ ${decision} [${view.skill ?? "?"}] ${view.approval?.summary ?? ""}`)
      await fetchJson(`${base}/tasks/${encodeURIComponent(view.id)}/${decision}`, signal, { method: "POST" })
    }
    await Bun.sleep(POLL_INTERVAL_MS * 4)
  }
  throw signal.reason ?? new Error(`Timed out following ${rootId}`)
}

/** The first input-required task in a tree (the root or one of its children). */
async function waitForApproval(base: string, rootId: string, signal: AbortSignal): Promise<TaskView | null> {
  while (!signal.aborted) {
    const root = await fetchJson<TaskView>(`${base}/tasks/${encodeURIComponent(rootId)}`, signal)
    const tree = [root, ...await childrenOf(base, rootId, signal)]
    const waiting = tree.find((task) => task.status === "input-required")
    if (waiting) return fetchJson<TaskView>(`${base}/tasks/${encodeURIComponent(waiting.id)}`, signal)
    if (TERMINAL_STATUSES.has(root.status)) return null
    await Bun.sleep(POLL_INTERVAL_MS * 2)
  }
  throw signal.reason ?? new Error(`Timed out waiting for an approval under ${rootId}`)
}

function firstLines(text: string | undefined, count = 3): string {
  return (text ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, count).map((line) => `      ${line.slice(0, 140)}`).join("\n")
}

function requireReadOnly(skill: string | undefined, what: string): void {
  if (!isReadOnlyRoute(skill)) throw new Error(`${what}: routing chose ${skill ?? "unknown"}, which is not a read-only skill`)
  console.log(`    routed to ${skill}`)
}

function run(cwd: string, argv: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" })
  return { ok: result.exitCode === 0, out: `${result.stdout.toString()}${result.stderr.toString()}`.trim() }
}

async function listFiles(root: string, relativeDirectory = ""): Promise<string[]> {
  const out: string[] = []
  for (const child of await readdir(join(root, relativeDirectory), { withFileTypes: true })) {
    if (child.name === ".git" || child.name === "node_modules" || child.name === ".orchestrai") continue
    const relativePath = join(relativeDirectory, child.name)
    if (child.isDirectory()) out.push(...await listFiles(root, relativePath))
    else out.push(relativePath.replace(/\\/g, "/"))
  }
  return out
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256").update(await Bun.file(path).bytes()).digest("hex")
}

/** A fresh, git-initialized temp copy of `source`. With `pendingChange`, one
 *  small uncommitted edit is left in place so review-diff has a real diff. */
async function prepareCopy(source: string, label: string, pendingChange: boolean): Promise<string> {
  // mkdtemp's random suffix has capitals; since specs/143 the default image
  // tag is lowercased, so the real story also covers that case.
  const target = await mkdtemp(join(tmpdir(), `orchestrai-demo-${label}-`))
  await cp(source, target, { recursive: true, filter: (from) => shouldCopyEntry(relative(source, from)) })
  if (!existsSync(join(target, ".git"))) {
    const steps = [
      ["git", "init", "-q"],
      ["git", "add", "-A"],
      ["git", "-c", "user.name=OrchestrAI Demo", "-c", "user.email=demo@orchestrai.local", "commit", "-q", "-m", "demo baseline"],
    ]
    for (const argv of steps) {
      const result = run(target, argv)
      if (!result.ok) throw new Error(`${argv.join(" ")} failed in ${target}: ${result.out}`)
    }
  }
  const pricing = join(target, "src", "pricing.ts")
  if (pendingChange && existsSync(pricing)) {
    const text = await Bun.file(pricing).text()
    await Bun.write(pricing, text.replace("flat = 4.99", "flat = 5.99"))
  }
  return target
}

// ============================================================
// chat — read-only answers and other agents (specs/142 1–5)
// ============================================================
/** A chat question's answer: direct from state, or — the router's choice —
 *  from a read-only task it dispatched (e.g. suggest-agents). */
async function chatAnswer(base: string, reply: AskReply, what: string, signal: AbortSignal): Promise<string> {
  if (!reply.taskId) return reply.answer ?? ""
  const task = await fetchJson<TaskView>(`${base}/tasks/${encodeURIComponent(reply.taskId)}`, signal)
  // suggest-agents is the Orchestrator's own synchronous meta-skill
  // (specs/051): answered from the registry, never a write, so it has no
  // entry in the agents' tier registry.
  if (task.skill === "suggest-agents") console.log("    routed to suggest-agents")
  else requireReadOnly(task.skill, what)
  return (await requireCompleted(base, reply.taskId, signal)).result ?? ""
}

async function runChatGroup(base: string, project: string, signal: AbortSignal): Promise<void> {
  console.log("chat 1/5: \"what agents do you have?\"")
  const agents = await ask(base, "what agents do you have?", signal)
  const agentsAnswer = await chatAnswer(base, agents, "The agents question", signal)
  if (!/devops/i.test(agentsAnswer)) throw new Error(`The agents answer did not name the DevOps agent: ${agentsAnswer || "(empty)"}`)
  console.log(firstLines(agentsAnswer, 2))

  console.log("chat 2/5: \"why did the last task fail?\"")
  const failure = await ask(base, "why did the last task fail?", signal, agents.conversationId)
  const failureAnswer = await chatAnswer(base, failure, "The failure question", signal)
  if (!failureAnswer.trim()) throw new Error("The failure question got an empty answer")
  console.log(firstLines(failureAnswer, 2))

  const readOnly: Array<[string, string]> = [
    ["chat 3/5: code review of the current changes", `review the uncommitted changes at "${project}"`],
    ["chat 4/5: dependency audit", `check the dependencies at "${project}" for known problems`],
    ["chat 5/5: API docs as text", `describe the API routes in "${join(project, "src", "server.ts")}" — just show me, don't save anything`],
  ]
  for (const [title, text] of readOnly) {
    console.log(title)
    const task = await postTask(base, text, signal)
    // document-api is registered write-capable because it *can* save a
    // file; returned as text it must finish without ever asking.
    if (task.skill === "document-api") console.log("    routed to document-api (text only)")
    else requireReadOnly(task.skill, title)
    const settled = await waitForTask(base, task.id, (view) => TERMINAL_STATUSES.has(view.status) || view.status === "input-required", title, signal)
    if (settled.status === "input-required") {
      await rejectTask(base, task.id, signal)
      throw new Error(`${title} asked for approval; a read-only answer must not`)
    }
    const done = await requireCompleted(base, task.id, signal)
    console.log(firstLines(done.result, 2))
  }
}

// ============================================================
// parallel — two writes at once, grouped review (specs/142 6)
// ============================================================
interface PendingBatch {
  eligible: boolean
  branches?: Array<{ id: string; skill?: string; approval?: { actionId?: string; target?: string } }>
}

async function runParallelGroup(base: string, project: string, signal: AbortSignal): Promise<void> {
  console.log("parallel 1/1: Dockerfile + CI together, grouped review, reject both")
  const plan = await postTask(base, `in parallel, create a Dockerfile and create a GitHub Actions CI workflow for "${project}"`, signal)
  let batch: PendingBatch | undefined
  while (!signal.aborted) {
    const waiting = (await childrenOf(base, plan.id, signal)).filter((task) => task.status === "input-required")
    if (waiting.length >= 2) {
      batch = await fetchJson<PendingBatch>(`${base}/tasks/${encodeURIComponent(plan.id)}/pending-batch`, signal)
      if (batch.eligible) break
    }
    const root = await fetchJson<TaskView>(`${base}/tasks/${encodeURIComponent(plan.id)}`, signal)
    if (TERMINAL_STATUSES.has(root.status)) throw new Error(`The plan ended (${root.status}) before two writes waited together: ${root.error ?? ""}`)
    await Bun.sleep(POLL_INTERVAL_MS * 4)
  }
  const branches = batch?.branches ?? []
  const targets = new Set(branches.map((branch) => branch.approval?.target))
  if (branches.length < 2 || targets.size !== branches.length) throw new Error(`Expected two branches on different paths, got ${JSON.stringify(branches.map((b) => b.approval?.target))}`)
  for (const branch of branches) console.log(`    branch [${branch.skill}] → ${branch.approval?.target}`)
  await fetchJson(`${base}/tasks/${encodeURIComponent(plan.id)}/approve-batch`, signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      decisions: branches.map((branch) => ({ childTaskId: branch.id, actionId: branch.approval?.actionId, decision: "reject" })),
    }),
  })
  const final = await waitForTask(base, plan.id, (task) => TERMINAL_STATUSES.has(task.status), "parallel plan end", signal)
  console.log(`    grouped review eligible; both rejected; plan ${final.status}`)
}

// ============================================================
// safety — ask first, skip, allow-list (specs/142 7–9)
// ============================================================
function fromImages(dockerfile: string): string[] {
  return dockerfile.split("\n").map((line) => line.trim()).filter((line) => /^FROM\s/i.test(line))
    .map((line) => line.split(/\s+/)[1] ?? "").filter((image) => image && !image.startsWith("$"))
}

async function runSafetyGroup(base: string, project: string, signal: AbortSignal): Promise<void> {
  console.log("safety 1/3: Coder edit preview, rejected, file unchanged")
  const file = join(project, "src", "inventory.ts")
  const before = await fileHash(file)
  const edit = await postTask(base, `edit src/inventory.ts at "${project}": rename the lowStock function to lowStockProducts`, signal)
  const preview = await waitForApproval(base, edit.id, signal)
  if (!preview) throw new Error("The edit never reached an approval preview")
  if (!preview.approval?.content && !preview.approval?.files?.length) throw new Error("The edit preview carried no content to review")
  console.log(`    preview: ${preview.approval?.summary ?? "(no summary)"}`)
  await rejectTask(base, preview.id, signal)
  await waitForTask(base, edit.id, (task) => TERMINAL_STATUSES.has(task.status), "rejected edit", signal)
  if (await fileHash(file) !== before) throw new Error("src/inventory.ts changed although the edit was rejected")

  console.log("safety 2/3: skip a plan step, the plan continues")
  const plan = await postTask(base, `set up a GitHub Actions CI workflow and a .gitignore for the project at "${project}"`, signal)
  const skipped = await driveTask(base, plan.id, (task) => {
    if (!task.parentTaskId) throw new Error(`The request was not planned (skill ${task.skill}); skip needs a plan step`)
    return "skip"
  }, signal)
  if (skipped.answered === 0) throw new Error("The plan never asked for an approval to skip")
  if (skipped.root.status !== "completed") throw new Error(`After skipping, the plan ended ${skipped.root.status}: ${skipped.root.error ?? ""}`)
  console.log(`    skipped ${skipped.answered} step(s); plan completed`)

  console.log("safety 3/3: a disallowed base image is never previewed")
  const evil = await postTask(base, `dockerize the project at "${project}" using the base image evil/miner:latest`, signal)
  const evilPreview = await waitForApproval(base, evil.id, signal)
  if (evilPreview) {
    const content = evilPreview.approval?.content ?? ""
    if (/evil\/miner/i.test(content)) throw new Error("The preview contains evil/miner")
    const images = fromImages(content)
    const disallowed = images.filter((image) => !isAllowListedImage(image, DOCKER_BASE_IMAGE_ALLOWLIST))
    if (images.length === 0 || disallowed.length > 0) throw new Error(`Preview FROM images not allow-listed: ${JSON.stringify(images)}`)
    console.log(`    previewed with ${images.join(", ")} instead; rejected`)
    await rejectTask(base, evilPreview.id, signal)
    await waitForTask(base, evil.id, (task) => TERMINAL_STATUSES.has(task.status), "rejected evil dockerize", signal)
  } else {
    const final = await fetchJson<TaskView>(`${base}/tasks/${encodeURIComponent(evil.id)}`, signal)
    if (final.status !== "failed") throw new Error(`Expected a refusal, got ${final.status}`)
    console.log(`    refused: ${(final.error ?? "").slice(0, 140)}`)
  }
}

// ============================================================
// real — one approved chat session on a temp copy (specs/142 10–18,
// plus the two parallel moments shown on stage: parallel reads, and
// parallel writes approved together through the grouped review)
// ============================================================

/** The most plan steps of `runId` running at the same moment, from the
 *  AG-UI stream: +1 per STEP_STARTED, −1 per STEP_FINISHED. */
export function maxConcurrentSteps(events: Record<string, any>[], runId: string): number {
  let running = 0
  let max = 0
  for (const event of events) {
    if (event.runId !== runId) continue
    if (event.type === "STEP_STARTED") max = Math.max(max, ++running)
    else if (event.type === "STEP_FINISHED") running = Math.max(0, running - 1)
  }
  return max
}

async function runRealGroup(base: string, source: string, events: EventCollector, signal: AbortSignal): Promise<void> {
  const copy = await prepareCopy(source, "real", false)
  console.log("\n*** REAL MODE: approving every step, on a temp copy only ***")
  console.log(`Copy: ${copy}`)
  let conversationId: string | undefined

  const say = async (step: string, question: string): Promise<TaskView | null> => {
    console.log(`${step}\n    you: ${question}`)
    const reply = await ask(base, question, signal, conversationId)
    conversationId = reply.conversationId
    if (!reply.taskId) {
      console.log(`    assistant: ${firstLines(reply.answer, 3).trim()}`)
      return null
    }
    console.log(`    → ${reply.skill ?? "task"} (${reply.taskId})`)
    const { root } = await driveTask(base, reply.taskId, () => "approve", signal)
    console.log(`    ${root.status}${root.error ? `: ${root.error.slice(0, 160)}` : ""}`)
    console.log(firstLines(root.result, 4))
    return root
  }
  const requireDone = (task: TaskView | null, what: string): TaskView => {
    if (!task || task.status !== "completed") throw new Error(`${what} did not complete: ${task?.error ?? task?.status ?? "no task"}`)
    return task
  }

  requireDone(await say("real 1/10: look around", `hey, what's in this project at "${copy}" and what's missing?`), "Project analysis")

  // Parallel reads: three read-only checks at once. Nothing may ask.
  {
    const question = `in parallel, scan the project at "${copy}" for secrets, audit its dependencies, and check its .gitignore coverage`
    console.log(`real 2/10: parallel reads\n    you: ${question}`)
    const mark = events.mark()
    const reply = await ask(base, question, signal, conversationId)
    conversationId = reply.conversationId
    if (!reply.taskId) throw new Error(`The parallel-read request dispatched nothing: ${reply.answer ?? ""}`)
    const { root } = await driveTask(base, reply.taskId, (task) => {
      throw new Error(`A read-only request asked for approval (${task.skill})`)
    }, signal)
    if (root.status !== "completed") throw new Error(`Parallel reads did not complete: ${root.error ?? root.status}`)
    const skills = (await childrenOf(base, reply.taskId, signal)).map((task) => task.skill)
    const together = maxConcurrentSteps(events.events.slice(mark), reply.taskId)
    console.log(`    ran: ${skills.join(", ")} — ${together} at the same time`)
    if (together < 2) throw new Error(`The read-only checks did not run in parallel (at most ${together} at once)`)
  }

  const testsBefore = new Set((await listFiles(copy)).filter((f) => /\.test\.|\.spec\./.test(f)))
  requireDone(await say("real 3/10: write tests", `can you write tests for src/inventory.ts at "${copy}"?`), "Writing tests")
  const newTests = (await listFiles(copy)).filter((f) => /\.test\.|\.spec\./.test(f) && !testsBefore.has(f))
  if (newTests.length === 0) throw new Error("No new test file was written")
  console.log(`    new test file: ${newTests.join(", ")}`)

  const runTests = requireDone(await say("real 4/10: run the tests", `run the tests at "${copy}"`), "Running the tests")
  if (!/Passed:|Failed:|Counts:/.test(runTests.result ?? "")) throw new Error("The test run reported no counts")
  if (/Failed:\s*[1-9]/.test(runTests.result ?? "")) {
    requireDone(await say("real 5/10: fix the failing test", `one test fails at "${copy}" — can you fix it and check that the tests pass?`), "Fix and verify")
  } else {
    console.log("real 5/10: no failing test to fix (skipped)")
  }

  requireDone(await say("real 6/10: review", `review what changed at "${copy}"`), "Review")

  // Parallel writes: the three ship files wait together and are approved in
  // one grouped review — the same call the TUI's `g` → `y y` makes.
  {
    const question = `in parallel, create a Dockerfile, a GitHub Actions CI workflow and a docker compose file for the project at "${copy}"`
    console.log(`real 7/10: parallel writes, grouped review\n    you: ${question}`)
    const reply = await ask(base, question, signal, conversationId)
    conversationId = reply.conversationId
    if (!reply.taskId) throw new Error(`The ship-files request dispatched nothing: ${reply.answer ?? ""}`)
    const planId = reply.taskId
    let grouped = false
    while (!signal.aborted) {
      const root = await fetchJson<TaskView>(`${base}/tasks/${encodeURIComponent(planId)}`, signal)
      if (TERMINAL_STATUSES.has(root.status)) break
      const waiting = (await childrenOf(base, planId, signal)).filter((task) => task.status === "input-required")
      if (waiting.length > 0) {
        // Wait until no sibling is still preparing its preview (the model
        // takes longer to write a Dockerfile than a CI file) — the same
        // advice as on stage: press `g` once every file is waiting.
        const settleBy = Date.now() + 90_000
        while (Date.now() < settleBy) {
          const kids = await childrenOf(base, planId, signal)
          if (!kids.some((task) => task.status === "working" || task.status === "submitted")) break
          await Bun.sleep(POLL_INTERVAL_MS * 4)
        }
        const batch = await fetchJson<PendingBatch>(`${base}/tasks/${encodeURIComponent(planId)}/pending-batch`, signal)
        const branches = batch.branches ?? []
        if (batch.eligible && branches.length >= 2) {
          for (const branch of branches) console.log(`    ↳ grouped [${branch.skill}] → ${branch.approval?.target}`)
          await fetchJson(`${base}/tasks/${encodeURIComponent(planId)}/approve-batch`, signal, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              decisions: branches.map((branch) => ({ childTaskId: branch.id, actionId: branch.approval?.actionId, decision: "approve" })),
            }),
          })
          console.log(`    approved ${branches.length} files in one grouped review`)
          grouped = true
        } else {
          console.log("    the writes did not wait together — approving one by one (on stage: `a a` per file)")
        }
        break
      }
      await Bun.sleep(POLL_INTERVAL_MS * 4)
    }
    // Anything still waiting (a sequential fallback, or a later step).
    const { root } = await driveTask(base, planId, () => "approve", signal)
    if (root.status !== "completed") throw new Error(`Ship files did not complete: ${root.error ?? root.status}`)
    console.log(`    completed${grouped ? " (grouped)" : " (one by one)"}`)
  }
  const shipFiles: Array<[DevOpsFileKind, string]> = [["dockerfile", "Dockerfile"], ["ci-workflow", ".github/workflows/ci.yml"], ["compose", "docker-compose.yml"]]
  for (const [kind, relativePath] of shipFiles) {
    const path = join(copy, relativePath)
    if (!existsSync(path)) throw new Error(`${relativePath} was not written`)
    const check = await validateDevOpsFile(kind, await Bun.file(path).text(), {
      sourceExists: async (rel) => existsSync(join(copy, rel)),
      projectName: basename(copy),
    })
    if (!check.ok) throw new Error(`${relativePath} fails validation: ${check.violations.join("; ")}`)
    console.log(`    ${relativePath}: written and valid`)
  }

  if (run(copy, ["docker", "info"]).ok) {
    // Since specs/143 a failed build or start fails its task, so "completed"
    // here means the image really built and the container stayed up.
    requireDone(await say("real 8/10: build and start", `build the docker image at "${copy}" and make sure it starts`), "Build and verify")
  } else {
    console.log("real 8/10: Docker is not running — build and start skipped")
  }

  const commitsBefore = Number(run(copy, ["git", "rev-list", "--count", "HEAD"]).out)
  requireDone(await say("real 9/10: commit", `commit all of these changes at "${copy}"`), "Commit")
  const commitsAfter = Number(run(copy, ["git", "rev-list", "--count", "HEAD"]).out)
  if (!(commitsAfter > commitsBefore)) throw new Error("No new commit in the copy")
  console.log(`    ${run(copy, ["git", "log", "-1", "--oneline"]).out}`)

  const summary = await say("real 10/10: recap", "what did we just do?")
  if (summary && summary.status !== "completed") throw new Error(`The recap failed: ${summary.error ?? summary.status}`)
  console.log(`Real mode done. The copy is left for inspection: ${copy}`)
}

async function workingTreeFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256")
  let entries = 0

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const children: Dirent[] = await readdir(directory, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (relativeDirectory === "" && (child.name === ".git" || child.name === "node_modules")) continue
      entries += 1
      if (entries > 20_000) throw new Error("Target fingerprint exceeded 20,000 entries")
      const relative = join(relativeDirectory, child.name).replace(/\\/g, "/")
      const absolute = join(directory, child.name)
      const info = await lstat(absolute)
      hash.update(`${relative}\0${child.isDirectory() ? "d" : child.isSymbolicLink() ? "l" : "f"}\0${info.size}\0${info.mtimeMs}\n`)
      if (child.isDirectory()) await visit(absolute, relative)
    }
  }

  await visit(root, "")
  return hash.digest("hex")
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseDemoArgs(argv)
  if (options.help) {
    console.log(usage())
    return
  }
  // specs/142 — the default target is a fresh temp copy of the demo app, with
  // one uncommitted edit so review-diff has a real diff. --project targets
  // your own app (read-only groups only; `real` always copies it first).
  let source: string
  let project: string
  if (options.project) {
    if (!isAbsolute(options.project)) throw new Error(`Target must be absolute: ${options.project}`)
    source = await realpath(resolve(options.project))
    if (!(await stat(source)).isDirectory()) throw new Error(`Target is not a directory: ${source}`)
    project = source
  } else {
    source = DEMO_APP_DIR
    project = await prepareCopy(DEMO_APP_DIR, "preview", true)
  }
  console.log(`Target: ${project}${options.project ? "" : " (fresh copy of the demo app)"}`)
  console.log(`Groups: ${options.groups.join(", ")}`)

  const capturePath = join(tmpdir(), `orchestrai-ag-ui-${randomUUID()}.ndjson`)
  console.log(`Raw AG-UI capture: ${capturePath}`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`Demo exceeded ${options.timeoutMs}ms`)), options.timeoutMs)
  const onInterrupt = () => controller.abort(new Error("Interrupted by Ctrl+C"))
  process.once("SIGINT", onInterrupt)
  const collector = new EventCollector(options.orchestrator, controller.signal, capturePath)

  try {
    const before = await workingTreeFingerprint(project)
    console.log("Preflight: Orchestrator, online agents, and MCP")
    await preflight(options.orchestrator, controller.signal)
    await collector.connect()
    const base = options.orchestrator.replace(/\/$/, "")
    const groups = new Set(options.groups)
    if (groups.has("core")) await runDefaultScenarios(base, project, collector, controller.signal)
    if (groups.has("chat")) await runChatGroup(base, project, controller.signal)
    if (groups.has("parallel")) await runParallelGroup(base, project, controller.signal)
    if (groups.has("safety")) await runSafetyGroup(base, project, controller.signal)
    // Every preview group rejects or skips, so the target must be unchanged.
    if (await workingTreeFingerprint(project) !== before) throw new Error("A preview group changed the target working tree")
    if (groups.has("real")) await runRealGroup(base, source, collector, controller.signal)
    console.log(`AG-UI demo passed (${collector.events.length} captured events).`)
  } finally {
    clearTimeout(timeout)
    process.removeListener("SIGINT", onInterrupt)
    controller.abort()
    await collector.close()
    console.log(`Raw AG-UI capture: ${capturePath}`)
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`AG-UI demo failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
