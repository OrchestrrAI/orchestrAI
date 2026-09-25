// specs/028-orchestrator-langgraph-supervisor/spec.md
//
// Phase 2: the supervisor graph in isolation. Nothing in this file is wired
// into the running Orchestrator yet — this module is dead code until
// Phase 3 imports and flag-gates it. It depends on narrow injected function
// types for dispatch/wait (mirroring specs/026's McpToolCaller interface),
// never importing apps/orchestrator/index.ts directly, so every test here
// needs no HTTP server, no real agents, and no live model.
//
// LangGraph is used for the same single reason as specs/026: a genuine
// multi-turn decide-act-observe loop. Nothing here uses LangGraph's
// persistence/checkpointing or interrupt/resume features (spec: "No
// interrupt(), no checkpointer, no persistence change").
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { z } from "zod"
import { callProviderWithRetry } from "../../packages/shared/llm-model-factory"

// ============================================================
// SAFETY REGISTRY (Proposed Behavior 6)
// ============================================================
// One authoritative classification table. Deliberately separate from
// SUPERVISOR_ALLOWED_SKILLS below even though their key sets currently
// match exactly — keeping them as two independent structures is what makes
// drift a real, catchable failure mode instead of a tautology. See
// supervisor-graph.test.ts's "registry drift" tests.
export type SkillTier = "read-only" | "write-capable"

export const SKILL_TIER_REGISTRY: Record<string, SkillTier> = {
  // Tier 2 — read-only, per CLAUDE.md's own tiering.
  "analyze-project": "read-only",
  "git-status": "read-only",
  "scan-secrets": "read-only",
  "check-gitignore-coverage": "read-only",
  "audit-dependencies": "read-only",
  // specs/079-phase-a-connect-orphaned-tools/spec.md — the two new
  // read-only DevOps skills.
  "docker-status": "read-only",
  "git-diff": "read-only",
  // Tier 1 — write-capable. document-api and run-tests/check-coverage are
  // CONDITIONALLY write-capable in the real agents (only when explicitly
  // asked to save, or when a runner is actually detected) — classified
  // write-capable here regardless, per the spec's own conservative-default
  // rule: a skill that can ever write must never be registered read-only.
  dockerize: "write-capable",
  "create-ci": "write-capable",
  "create-gitignore": "write-capable",
  "create-compose": "write-capable",
  "generate-readme": "write-capable",
  "document-api": "write-capable",
  "run-tests": "write-capable",
  "check-coverage": "write-capable",
  // specs/079-phase-a-connect-orphaned-tools/spec.md — DevOps's three
  // new write/execute-capable skills. build-image and verify-deployment
  // execute real commands (docker build/run); commit-changes alters git
  // history. All three go through the exact same actionId-bound
  // approval gate as every other write-capable skill — no exception.
  "build-image": "write-capable",
  "verify-deployment": "write-capable",
  "commit-changes": "write-capable",
  // specs/080-run-command-approved-execution/spec.md — a general
  // execution primitive; always write-capable regardless of what the
  // particular command turns out to be, per this table's own
  // conservative-default rule.
  "run-command": "write-capable",
  // specs/081-testing-write-tests-skill/spec.md — writes a real file;
  // write-capable like every other write skill in this table.
  "write-tests": "write-capable",
  // specs/082-code-review-agent/spec.md — read-only, no approval gate;
  // the first genuinely new agent's own skill.
  "review-diff": "read-only",
  // specs/083-coder-agent/spec.md — writes a real file (an approved,
  // grounded anchored edit); write-capable like every other write skill.
  "edit-file": "write-capable",
  // specs/114-coder-multi-file-edit-and-create/spec.md — writes real
  // files (a bounded, approved, per-file-grounded multi-file batch);
  // write-capable like every other write skill.
  "edit-files": "write-capable",
  // specs/119-coder-verify-loop-and-reviewer-depth/spec.md Part B — a
  // bounded verify-and-fix loop that writes real files; write-capable
  // like every other write skill in this table, regardless of the
  // command-approval reuse (B1) happening inside the agent's own
  // resume path, which this table has no visibility into and doesn't
  // need — the classification here is about the SKILL, not any one
  // execution's internal argv-reuse decision.
  "edit-and-verify": "write-capable",
}

/** The skills the supervisor may choose to dispatch — what the model is
 *  actually offered, as opposed to SKILL_TIER_REGISTRY's classification of
 *  them. Kept as a literal separate array (not `Object.keys(...)`) so an
 *  edit to one without the other is a real drift a test can catch. */
export const SUPERVISOR_ALLOWED_SKILLS = [
  "analyze-project",
  "git-status",
  "scan-secrets",
  "check-gitignore-coverage",
  "audit-dependencies",
  "docker-status",
  "git-diff",
  "dockerize",
  "create-ci",
  "create-gitignore",
  "create-compose",
  "generate-readme",
  "document-api",
  "run-tests",
  "check-coverage",
  "build-image",
  "verify-deployment",
  "commit-changes",
  "run-command",
  "write-tests",
  "review-diff",
  "edit-file",
  "edit-files",
  "edit-and-verify",
] as const

// specs/121-skill-description-grounded-routing/spec.md — one entry per
// SUPERVISOR_ALLOWED_SKILLS id, each value copied verbatim from that
// skill's real Agent Card `description` (never re-worded), so the model
// can distinguish same-family pairs like edit-file/edit-files instead of
// seeing bare ids only. Kept as its own record, mirroring
// SKILL_TIER_REGISTRY's own stated convention just above: a real,
// catchable drift test (see supervisor-graph.test.ts) rather than deriving
// one array from the other.
export const SKILL_DESCRIPTIONS: Record<(typeof SUPERVISOR_ALLOWED_SKILLS)[number], string> = {
  "analyze-project": "Analyze DevOps files and include a Security Agent secrets pre-check",
  "git-status": "Get git repository status",
  "scan-secrets": "Search project files for hardcoded API keys, tokens, and credentials",
  "check-gitignore-coverage": "Verify sensitive file patterns (.env, credentials) are actually gitignored",
  "audit-dependencies": "Flag unpinned dependency versions and (opt-in) check for real known vulnerabilities via OSV.dev — npm, Python, Go, PHP, and Java/Maven",
  "docker-status": "Report current Docker containers and images",
  "git-diff": "Show staged and/or unstaged changes",
  dockerize: "Generate a production-ready Dockerfile",
  "create-ci": "Generate GitHub Actions workflow",
  "create-gitignore": "Generate .gitignore file",
  "create-compose": "Generate a docker-compose.yml for a single-service setup",
  "generate-readme": "Create a README.md from project structure and package.json",
  "document-api": "Scan a Hono/Express file for routes and generate an API reference doc",
  "run-tests": "Detect the project's test runner and, after human approval, run it and report pass/fail",
  "check-coverage": "Run tests with coverage reporting (approval required) if the runner supports it",
  "build-image": "Build a Docker image from a generated Dockerfile and report the real build output",
  "verify-deployment": "Start a built image briefly and confirm it actually boots",
  "commit-changes": "Create a git commit from the current staged and unstaged changes",
  "run-command": "Run an explicit or LLM-proposed command in the target project, after human approval of the exact argv",
  "write-tests": "Write a test file for ONE specific source file, in the project's detected test framework — requires human approval before writing, and a separate approval to run it. The step description MUST name that file, e.g. \"write tests for src/foo.ts\", or the step fails. For a whole-project request (\"write tests for my project\"), choose real source files from the read-only project inspection you already have (or analyze-project, which needs no approval — never run-command just to list files), then dispatch one write-tests step per chosen file, each description naming its file.",
  "review-diff": "Review staged and unstaged changes in a project for correctness issues, grounded in real file:line citations from the diff",
  // specs/133 — the step description is the child task's text, and Coder
  // only finds the file from "edit <path>" in it; a multi-file change goes
  // to ONE edit-files step (one approval, every file preflighted, and no
  // same-target edit-file writes for the duplicate-write refusal to block).
  "edit-file": "Propose a precise, grounded edit to ONE existing file (an exact, uniquely-occurring span replaced with new content), shown as a content diff and requiring human approval before it's written. The step description MUST begin \"edit <relative/path.ext>: <what to change>\", e.g. \"edit src/config.ts: add a comment line at the top\", or the step fails. For a change to two or more files, use ONE edit-files step instead of several edit-file steps.",
  "edit-files": "Propose a coherent, potentially multi-file change from a free-form instruction — the model explores the real project (read_project_file/analyze_project/git_status/git_diff) to decide which files need touching, including creating new files, and every edit is shown as a content diff and requires human approval before anything is written. Bounded to 6 files per proposal. Use it whenever a request changes or creates more than one file: ONE edit-files step whose description carries the whole instruction, never several edit-file steps.",
  "edit-and-verify": "Propose a coherent, potentially multi-file change, then propose and run a real verification command (e.g. the project's tests) — a genuine failure feeds back into a follow-up fix, bounded at 3 iterations. Every edit and the first run of any distinct command is individually human-approved; only a byte-identical command re-run within the same task skips a redundant prompt.",
}

/** Fail-closed classification (Proposed Behavior 6): an unregistered skill
 *  is the most dangerous case, never read-only. */
export function classifySkillTier(skill: string): SkillTier {
  return SKILL_TIER_REGISTRY[skill] ?? "write-capable"
}

// ============================================================
// DISPATCH OUTCOME — the effect-certainty contract (Proposed Behavior 5)
// ============================================================
export type DispatchOutcome =
  | { kind: "completed" }
  | { kind: "rejected"; effect: "none" }
  // specs/089-plan-step-skip-continue/spec.md (Option B) — a distinct
  // outcome from "rejected": the run is NOT terminal on a skip. The one
  // structural guarantee kept is that the literal skipped skill id can
  // never be re-proposed in this same run (enforced in dispatchNode(),
  // not here) — every other skill, write-capable or read-only, keeps
  // dispatching normally, each reaching its own full approval gate.
  | { kind: "skipped"; effect: "none" }
  | { kind: "failed-safe"; effect: "none" }
  | { kind: "failed-ambiguous"; effect: "unknown" }
  | { kind: "timeout"; effect: "unknown" }

/** Raw facts the injected `wait()` reports. Deliberately narrow — this is
 *  the entire surface the classification adapter reads from. */
export interface WaitResult {
  status: "completed" | "failed" | "timeout"
  /** A TRUSTED fact from the Orchestrator's own record that it forwarded a
   *  rejection for this child task — never derived from `status` or from
   *  matching error text. See the adversarial test: a `failed` task whose
   *  error string happens to read "Rejected by user" but was NOT actually
   *  rejected through the Orchestrator must NOT set this to true. */
  wasRejectedByOrchestrator: boolean
  /** specs/089-plan-step-skip-continue/spec.md — the same trusted-fact
   *  shape as wasRejectedByOrchestrator above, but for a skip: TRUE only
   *  when the Orchestrator's own record shows a skip was genuinely
   *  forwarded for this child task through POST /tasks/:id/skip, never
   *  derived from status or error text. */
  wasSkippedByOrchestrator: boolean
  /** The approval preview's `target`, when one existed — used for
   *  duplicate-write prevention. Absent for skills that never produced an
   *  approval preview (e.g. read-only skills, or a write skill that failed
   *  before reaching one). */
  target?: string
}

/**
 * THE single place raw status becomes a DispatchOutcome. Pure, deterministic,
 * model-free — the model never sees `WaitResult`, only the `DispatchOutcome`
 * this produces. `failed` defaults to `failed-ambiguous`; `failed-safe` is
 * reachable only through the read-only-tier path, never as a fallback.
 */
export function classifyDispatchOutcome(wait: WaitResult, tier: SkillTier): DispatchOutcome {
  if (wait.status === "timeout") return { kind: "timeout", effect: "unknown" }
  if (wait.status === "completed") return { kind: "completed" }
  // wait.status === "failed" from here on. Skip is checked before reject —
  // the two are mutually exclusive facts (only one endpoint can have been
  // the one genuinely forwarded), but checking skip first documents that a
  // skip is the more specific/deliberate outcome of the two.
  if (wait.wasSkippedByOrchestrator) return { kind: "skipped", effect: "none" }
  if (wait.wasRejectedByOrchestrator) return { kind: "rejected", effect: "none" }
  if (tier === "read-only") return { kind: "failed-safe", effect: "none" }
  return { kind: "failed-ambiguous", effect: "unknown" }
}

// ============================================================
// INJECTED DEPENDENCIES — mirrors specs/026's McpToolCaller interface
// ============================================================
export interface DispatchResult {
  childTaskId: string
}

export interface SupervisorDeps {
  /** Mirrors dispatchPlanStep(): submits a child task, returns its id, or
   *  null if no agent advertises the skill. Never throws for "no agent". */
  dispatch(skill: string, target: string, description: string): Promise<DispatchResult | null>
  /** Mirrors waitForChildTask(), but returns the structured facts the
   *  adapter needs instead of mutating shared state and returning void. */
  wait(childTaskId: string): Promise<WaitResult>
  /** specs/120-supervisor-parallel-write-dispatch/spec.md — optional so
   *  every existing test double (MockDeps, ConcurrencyProbeDeps) still
   *  satisfies this interface unmodified. Called only from dispatchBatch()
   *  when one branch of a concurrent write-capable batch produces a
   *  run-ending outcome (rejected/failed-ambiguous/timeout): every OTHER
   *  still-`input-required` sibling is skipped so no orphaned approval
   *  prompt survives a dead run, and so this batch's own wait-loop can
   *  actually terminate rather than hang on a human who will never be
   *  asked to act on a run that's already over. A caller with no skip()
   *  (or a child that already resolved before this fires) safely no-ops —
   *  the sibling's own in-flight wait() promise still resolves with
   *  whatever its real, independent outcome turns out to be. */
  skip?(childTaskId: string): Promise<void>
}

// ============================================================
// BOUNDS (Proposed Behavior 7)
// ============================================================
// specs/097-chat-answer-and-plan-description-honesty/spec.md — raised
// from 10 to 30. Live-caught: a genuine "make sure that repo is
// production ready" request, with specs/089's own skip feature
// correctly keeping the plan alive through several deliberate skips,
// legitimately ran out of budget at exactly 10 real dispatch attempts —
// not a bug in the bound-checking logic itself (it worked exactly as
// designed), but real evidence 10 is too low a ceiling for a broad,
// multi-concern request once a few steps get skipped.
export const DEFAULT_MAX_DISPATCHES = 30
export const DEFAULT_MAX_ATTEMPTS_PER_SKILL = 2 // 1 retry
export const DEFAULT_RECURSION_LIMIT = 50 // generous relative to DEFAULT_MAX_DISPATCHES; the dispatch-count bound is the real limit

// specs/097-chat-answer-and-plan-description-honesty/spec.md — the same
// resolution shape packages/shared/service-ports.ts's resolveServicePort()
// already established: an env var wins when set to a valid positive
// integer, otherwise the default applies. Never throws — a misconfigured
// value degrades to the default rather than disabling the bound or
// crashing the run.
export const SUPERVISOR_MAX_DISPATCHES_ENV_VAR = "ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES"

export function resolveSupervisorMaxDispatches(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SUPERVISOR_MAX_DISPATCHES_ENV_VAR]
  if (raw === undefined || raw === "") return DEFAULT_MAX_DISPATCHES
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_DISPATCHES
  return parsed
}

export type TerminalReason =
  | "done"
  | "rejected"
  | "timeout"
  | "failed-ambiguous"
  | "max-dispatches-reached"
  | "max-skill-attempts-reached"

// ============================================================
// AUDIT (Proposed Behavior 8)
// ============================================================
// `auditLog` in graph state is this module's own fully isolated, no-network
// record — every safety test in this file asserts against it directly, with
// no real Orchestrator, no HTTP, no injected deps beyond the mocks. The
// REAL emitAuditEvent()/emitAuditStart() calls (the same shared mechanism
// every agent already uses) live in apps/orchestrator/index.ts's own
// buildOrchestratorSupervisorDeps() instead of here — that function has the
// parent task id this module deliberately does not, which
// mapAuditPushToAgUiEvent() needs to correlate TOOL_CALL_* events with this
// run's other AG-UI events (see that function's own comment for the bug
// this avoided).
export type SupervisorAuditEntry =
  // specs/060-supervisor-parallel-read-only-dispatch/spec.md — toolCallCount
  // records how many tool calls the model's turn actually contained,
  // whether or not every one of them was acted on. Additive: always
  // present from this spec onward, on every decision entry, single-call
  // turns included — a batch that included calls this run chose to
  // ignore (a mixed/write-capable batch falling back to the single-call
  // path) is now visible in the log rather than silently invisible.
  | { type: "decision"; skill: string | null; target?: string; description?: string; reason: string; toolCallCount?: number; timestamp: number }
  | { type: "dispatch"; skill: string; target: string; outcome: DispatchOutcome["kind"]; durationMs: number; timestamp: number }

// ============================================================
// GRAPH STATE
// ============================================================
const SupervisorState = Annotation.Root({
  messages: Annotation<(SystemMessage | HumanMessage | AIMessage)[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  auditLog: Annotation<SupervisorAuditEntry[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  dispatchCount: Annotation<number>({ reducer: (_c, u) => u, default: () => 0 }),
  skillAttemptCounts: Annotation<Record<string, number>>({ reducer: (_c, u) => u, default: () => ({}) }),
  dispatchedWriteKeys: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  // specs/089-plan-step-skip-continue/spec.md (Option B) — the literal
  // skill ids skipped so far this run. Mirrors dispatchedWriteKeys's own
  // accumulate-only shape; checked in dispatchNode() before any dispatch,
  // never cleared — the one structural guarantee this spec keeps.
  skippedSkillIds: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  terminal: Annotation<TerminalReason | null>({ reducer: (_c, u) => u, default: () => null }),
})

type SupervisorStateType = typeof SupervisorState.State

// ============================================================
// SUPERVISOR NODE — the model decides the next skill, or finish
// ============================================================
// Two tool schemas for STRUCTURED OUTPUT ONLY. Neither is auto-executed by
// a generic tool node (unlike specs/026's read-only MCP tools) — this
// module's own `dispatch` node inspects the chosen tool call directly,
// because a dispatch decision carries safety logic (bounds, duplicate-write
// prevention, classification) far past what a generic executor should own.
function buildDecisionTools() {
  const dispatchSkill = tool(async () => "", {
    name: "dispatch_skill",
    description: "Dispatch the next skill to run against the target project.",
    schema: z.object({
      skill: z.enum(SUPERVISOR_ALLOWED_SKILLS),
      target: z.string().describe("Absolute path to the target project."),
      description: z.string().describe("Short description of what this step does and why."),
    }),
  })
  const finish = tool(async () => "", {
    name: "finish",
    description: "Stop — no further skills need to run.",
    schema: z.object({ reason: z.string() }),
  })
  return [dispatchSkill, finish]
}

// specs/102-orchestrator-readonly-project-inspection/spec.md — an
// optional grounding block naming the real, already-resolved target
// project (and a real analyze-project/git-status summary) the
// Orchestrator itself gathered before this prompt was ever built.
// Deliberately additive: with no projectContext, this function's output
// is byte-identical to before this spec (asserted by a dedicated
// regression test) — a failed/skipped/opted-out inspection degrades
// silently to exactly today's blind-first-step prompt. This is also
// the direct fix for dispatch_skill's own `target` being model-invented
// today (see buildDecisionTools() above) — the real path is now stated,
// not left for the model to reconstruct from the request text, the
// same root cause specs/087/088 each had to patch after the fact.
// Exported (specs/102) purely so the byte-identical-with-no-context
// regression test can call it directly rather than round-tripping
// through a full graph invocation just to inspect a SystemMessage.
export function buildSystemPrompt(taskText: string, projectContext?: string): string {
  return [
    `You are the adaptive supervisor for OrchestrAI's Orchestrator.`,
    `A user asked: "${taskText}"`,
    ...(projectContext
      ? [
          "",
          `Here is what the Orchestrator already knows about the target project — use its real path for "target", never a guess:`,
          projectContext,
          // specs/103-deep-project-analysis/spec.md — a prompt nudge, not
          // a structural guarantee: dispatchPlanStep() has no cache
          // integration (specs/057 deferred it), so a dispatched
          // analyze-project step always pays its own real cost. This line
          // only reduces how often the model chooses to pay it when it
          // already has what it needs.
          `You already have the project's analysis above — do not dispatch analyze-project again purely to re-orient yourself. Only dispatch it if the user's own request specifically calls for a fresh or updated analysis.`,
        ]
      : []),
    ``,
    `Decide the next skill to dispatch, or call finish when nothing more is needed.`,
    // specs/060-supervisor-parallel-read-only-dispatch/spec.md — the one
    // addition this spec makes to the prompt. Deliberately narrow: only
    // read-only skills are ever named as fan-out candidates here, and the
    // structural gate in dispatchNode() is the real enforcement — this
    // wording only affects whether the model chooses to try, never
    // whether it is allowed to.
    // specs/060 originally invited only read-only fan-out here.
    // specs/120-supervisor-parallel-write-dispatch/spec.md widens this: any
    // skill, including a write-capable one, may be named alongside others
    // in one turn when every one of them is genuinely independent — neither
    // depends on what another returns, AND no two of them write the same
    // file. Each write-capable one still reaches its own human approval
    // before anything is written; naming several at once only makes them
    // propose concurrently, it never skips or merges their approvals.
    `If more than one skill (${SUPERVISOR_ALLOWED_SKILLS.join(", ")}) would be useful right now and each is genuinely independent — neither depends on what another returns, and no two of them write the same file — you may call dispatch_skill for each of them in this same turn; they will run concurrently. Each write-capable skill you name still reaches its own individual human approval before it writes anything — naming several at once never skips or combines that approval. If you are not sure two steps are independent, decide them one at a time instead.`,
    `You will see the real outcome of each dispatch before deciding again — react to what actually happened, not just your original plan.`,
    // specs/121-skill-description-grounded-routing/spec.md — each line
    // pairs a skill id with its own real description; read it carefully
    // when two ids look similar (e.g. a singular vs plural pair) — it is
    // the only thing that distinguishes what each one can actually do.
    `Valid skills:\n${SUPERVISOR_ALLOWED_SKILLS.map((id) => `  - ${id}: ${SKILL_DESCRIPTIONS[id]}`).join("\n")}`,
    `You may dispatch the same (skill, target) pair only once per run — a repeat will be refused.`,
  ].join("\n")
}

async function supervisorNode(state: SupervisorStateType, model: BaseChatModel) {
  const tools = buildDecisionTools()
  if (typeof model.bindTools !== "function") {
    throw new Error("Configured chat model does not support tool binding (bindTools)")
  }
  const modelWithTools = model.bindTools(tools, { tool_choice: "required" })
  // specs/055-provider-call-budgets-and-transient-error-handling/spec.md
  // — a rate limit or transient server error here used to fail the whole
  // run identically to a permanently bad key. Retried with bounded
  // backoff; a terminal failure (bad key, bad model) re-throws
  // immediately, unchanged from before this spec.
  const response = await callProviderWithRetry(() => modelWithTools.invoke(state.messages))
  return { messages: [response] }
}

// ============================================================
// DISPATCH NODE
// ============================================================
async function dispatchNode(state: SupervisorStateType, deps: SupervisorDeps, bounds: { maxDispatches: number; maxAttemptsPerSkill: number }) {
  const last = state.messages[state.messages.length - 1]
  const allToolCalls = last instanceof AIMessage ? (last.tool_calls ?? []) : []
  const toolCall = allToolCalls[0]

  // Bound check BEFORE any dispatch — enforced independently of what the
  // model chose. A dispatch that would exceed either bound never happens.
  if (state.dispatchCount >= bounds.maxDispatches) {
    return {
      terminal: "max-dispatches-reached" as const,
      auditLog: [{ type: "decision" as const, skill: null, reason: "max-dispatches-reached", toolCallCount: allToolCalls.length, timestamp: Date.now() }],
    }
  }

  if (!toolCall || toolCall.name !== "dispatch_skill") {
    // Should be unreachable — afterSupervisor() only routes here for a
    // dispatch_skill call — but fail closed rather than assume.
    return { terminal: "done" as const }
  }

  // specs/060-supervisor-parallel-read-only-dispatch/spec.md originally
  // gated this to read-only-only batches. specs/120-supervisor-parallel-
  // write-dispatch/spec.md widens it: a turn qualifies for concurrent
  // fan-out whenever every tool call is a dispatch_skill call and there is
  // more than one, REGARDLESS of tier — write-capable branches each still
  // reach their own full, individually `actionId`-bound human approval
  // inside dispatchBatch()'s own wait loop; nothing about fan-out relaxes
  // that gate. Fail-closed the same way classifySkillTier() already is: a
  // `finish` call or any unrecognized tool name anywhere in the turn
  // disqualifies the WHOLE batch — it never partially fans out. A
  // disqualified batch falls through to the exact pre-060 single-call path
  // below, acting only on allToolCalls[0]; the decision entry's
  // toolCallCount below always records how many calls the turn actually
  // contained, so an ignored extra call is never silently dropped without
  // a trace.
  const allDispatchSkillCalls = allToolCalls.every((tc) => tc.name === "dispatch_skill")
  if (allToolCalls.length > 1 && allDispatchSkillCalls) {
    return dispatchBatch(allToolCalls, state, bounds, deps)
  }

  const { skill, target, description } = toolCall.args as { skill: string; target: string; description: string }
  const tier = classifySkillTier(skill)
  const attemptsSoFar = state.skillAttemptCounts[skill] ?? 0

  if (attemptsSoFar >= bounds.maxAttemptsPerSkill) {
    return {
      terminal: "max-skill-attempts-reached" as const,
      auditLog: [{ type: "decision" as const, skill, target, description, reason: "max-skill-attempts-reached", toolCallCount: allToolCalls.length, timestamp: Date.now() }],
    }
  }

  // specs/089-plan-step-skip-continue/spec.md (Option B) — the one
  // structural guarantee a skip keeps: the literal skipped skill id can
  // never be re-proposed in this run. Refused BEFORE execution, the exact
  // same non-terminal shape as the duplicate-write refusal just below —
  // deps.dispatch() is never called, the supervisor is fed back an
  // observation and re-consulted normally. Every OTHER skill (including a
  // write-capable one) is unaffected — this is not a run-ending refusal.
  if (state.skippedSkillIds.includes(skill)) {
    return {
      messages: [new HumanMessage(`Refused: "${skill}" was explicitly skipped by the user earlier in this run and cannot be dispatched again. Choose a different action, or finish.`)],
      auditLog: [{ type: "decision" as const, skill, target, description, reason: "skipped-skill-refused", toolCallCount: allToolCalls.length, timestamp: Date.now() }],
    }
  }

  const writeKey = `${skill}::${target}`
  if (tier === "write-capable" && state.dispatchedWriteKeys.includes(writeKey)) {
    // Duplicate-write prevention (Proposed Behavior 4): refused BEFORE
    // execution, deps.dispatch() is never called for this attempt. Not
    // terminal — feeds back to the supervisor with the refusal so it can
    // choose something else.
    return {
      messages: [new HumanMessage(`Refused: (${skill}, ${target}) was already dispatched in this run. Choose a different action, or finish.`)],
      auditLog: [{ type: "decision" as const, skill, target, description, reason: "duplicate-write-refused", toolCallCount: allToolCalls.length, timestamp: Date.now() }],
    }
  }

  const decisionEntry: SupervisorAuditEntry = {
    type: "decision",
    skill,
    target,
    description,
    reason: "dispatched",
    toolCallCount: allToolCalls.length,
    timestamp: Date.now(),
  }

  const started = performance.now()
  const dispatched = await deps.dispatch(skill, target, description)
  if (!dispatched) {
    // No agent advertises this skill right now — same "no agent" case
    // dispatchPlanStep() already handles today. Not a model failure; feed
    // back so the supervisor can react.
    return {
      messages: [new HumanMessage(`No agent is currently online for skill "${skill}". Choose a different action, or finish.`)],
      auditLog: [decisionEntry],
    }
  }

  // Real emitAuditStart()/emitAuditEvent() calls for this dispatch happen
  // inside deps.dispatch()/deps.wait() themselves (the real implementation
  // in apps/orchestrator/index.ts) — not here. See this file's own AUDIT
  // section comment above for why.
  const wait = await deps.wait(dispatched.childTaskId)
  const durationMs = performance.now() - started
  const outcome = classifyDispatchOutcome(wait, tier)

  const dispatchAuditEntry: SupervisorAuditEntry = {
    type: "dispatch",
    skill,
    target,
    outcome: outcome.kind,
    durationMs,
    timestamp: Date.now(),
  }

  const newDispatchCount = state.dispatchCount + 1
  const newAttemptCounts = { ...state.skillAttemptCounts, [skill]: attemptsSoFar + 1 }
  const newWriteKeys = tier === "write-capable" ? [writeKey] : []

  // Terminal outcomes: the supervisor is never re-entered.
  if (outcome.kind === "rejected") {
    return {
      terminal: "rejected" as const,
      dispatchCount: newDispatchCount,
      skillAttemptCounts: newAttemptCounts,
      dispatchedWriteKeys: newWriteKeys,
      auditLog: [decisionEntry, dispatchAuditEntry],
    }
  }
  if (outcome.kind === "timeout") {
    return {
      terminal: "timeout" as const,
      dispatchCount: newDispatchCount,
      skillAttemptCounts: newAttemptCounts,
      dispatchedWriteKeys: newWriteKeys,
      auditLog: [decisionEntry, dispatchAuditEntry],
    }
  }
  if (outcome.kind === "failed-ambiguous") {
    return {
      terminal: "failed-ambiguous" as const,
      dispatchCount: newDispatchCount,
      skillAttemptCounts: newAttemptCounts,
      dispatchedWriteKeys: newWriteKeys,
      auditLog: [decisionEntry, dispatchAuditEntry],
    }
  }

  // specs/089-plan-step-skip-continue/spec.md (Option B) — a skip is NOT
  // terminal, unlike rejected/timeout/failed-ambiguous above. It loops
  // back exactly like completed/failed-safe below, but ALSO records the
  // skill in skippedSkillIds so dispatchNode()'s own guard above can
  // refuse it if the model tries to re-propose it later in this run.
  if (outcome.kind === "skipped") {
    return {
      messages: [new HumanMessage(`Step "${skill}" was explicitly skipped by the user — do not attempt this exact step or a workaround that achieves the same effect. You may try a different action, or finish.`)],
      dispatchCount: newDispatchCount,
      skillAttemptCounts: newAttemptCounts,
      dispatchedWriteKeys: newWriteKeys,
      skippedSkillIds: [skill],
      auditLog: [decisionEntry, dispatchAuditEntry],
    }
  }

  // completed or failed-safe: the only two other outcomes that loop back.
  const observation = outcome.kind === "completed"
    ? `"${skill}" completed successfully.`
    : `"${skill}" failed safely (no mutation occurred — it is read-only). You may try a different action.`

  return {
    messages: [new HumanMessage(observation)],
    dispatchCount: newDispatchCount,
    skillAttemptCounts: newAttemptCounts,
    dispatchedWriteKeys: newWriteKeys,
    auditLog: [decisionEntry, dispatchAuditEntry],
  }
}

// ============================================================
// BATCH DISPATCH (specs/060-supervisor-parallel-read-only-dispatch/spec.md,
// widened to write-capable skills by specs/120-supervisor-parallel-write-
// dispatch/spec.md)
// ============================================================
// Only ever called for a turn dispatchNode() has already confirmed is
// every-entry-dispatch_skill and has more than one entry. Bounds, the
// skipped-skill refusal, and the duplicate-write refusal are all checked
// and reserved per branch, in the model's own listed order, BEFORE any
// network call — a branch that fails any of them is never dispatched, not
// silently ignored (its own "decision" audit entry records why).
// Reservation is optimistic: a branch counted against the budget here that
// later turns out to have no online agent does not actually consume
// dispatchCount/skillAttemptCounts in the final state update below — see
// the second loop. That can only make this pass MORE conservative than
// strictly necessary (reserving budget for a dispatch that doesn't end up
// happening), never less — it can never cause a bound to be exceeded.
type BatchToolCall = NonNullable<AIMessage["tool_calls"]>[number]

async function dispatchBatch(
  toolCalls: BatchToolCall[],
  state: SupervisorStateType,
  bounds: { maxDispatches: number; maxAttemptsPerSkill: number },
  deps: SupervisorDeps,
) {
  const auditLog: SupervisorAuditEntry[] = []
  const toDispatch: { skill: string; target: string; description: string }[] = []
  let reservedDispatchCount = state.dispatchCount
  const reservedAttemptCounts: Record<string, number> = { ...state.skillAttemptCounts }
  // specs/120 — reserved per branch alongside the two bound checks below,
  // so a turn naming the same (skill, target) twice within one batch
  // dispatches it once, exactly like the single-dispatch path already does
  // across turns.
  const reservedWriteKeys = new Set(state.dispatchedWriteKeys)

  for (const tc of toolCalls) {
    const { skill, target, description } = tc.args as { skill: string; target: string; description: string }
    const attemptsSoFar = reservedAttemptCounts[skill] ?? 0
    const tier = classifySkillTier(skill)
    const writeKey = `${skill}::${target}`

    if (reservedDispatchCount >= bounds.maxDispatches) {
      auditLog.push({ type: "decision", skill, target, description, reason: "max-dispatches-reached", toolCallCount: toolCalls.length, timestamp: Date.now() })
      continue
    }
    if (attemptsSoFar >= bounds.maxAttemptsPerSkill) {
      auditLog.push({ type: "decision", skill, target, description, reason: "max-skill-attempts-reached", toolCallCount: toolCalls.length, timestamp: Date.now() })
      continue
    }
    // specs/120 — the two refusal reasons that were structurally
    // unreachable inside a batch before write-capable skills could ever
    // appear in one (a read-only skill never gets skipped or
    // duplicate-write-refused). Mirrors dispatchNode()'s own single-branch
    // checks exactly, just reserved per-branch instead of against live
    // graph state directly.
    if (state.skippedSkillIds.includes(skill)) {
      auditLog.push({ type: "decision", skill, target, description, reason: "skipped-skill-refused", toolCallCount: toolCalls.length, timestamp: Date.now() })
      continue
    }
    if (tier === "write-capable" && reservedWriteKeys.has(writeKey)) {
      auditLog.push({ type: "decision", skill, target, description, reason: "duplicate-write-refused", toolCallCount: toolCalls.length, timestamp: Date.now() })
      continue
    }

    auditLog.push({ type: "decision", skill, target, description, reason: "dispatched", toolCallCount: toolCalls.length, timestamp: Date.now() })
    toDispatch.push({ skill, target, description })
    reservedDispatchCount += 1
    reservedAttemptCounts[skill] = attemptsSoFar + 1
    if (tier === "write-capable") reservedWriteKeys.add(writeKey)
  }

  if (toDispatch.length === 0) {
    // Every branch was refused before any dispatch — nothing to dispatch or
    // await; feed back so the supervisor can choose something else. Not
    // terminal: the run-level bound check at the top of dispatchNode() is
    // what makes an already-fully-exhausted bound terminal; this is a batch
    // that arrived just as the budget ran out, or that named only
    // already-skipped/already-dispatched (skill, target) pairs.
    return {
      messages: [new HumanMessage(`All ${toolCalls.length} requested steps were refused: dispatch/attempt bounds already reached, or every named (skill, target) was already skipped or dispatched this run. Choose a different action, or finish.`)],
      auditLog,
    }
  }

  const started = performance.now()
  const dispatched = await Promise.all(toDispatch.map((b) => deps.dispatch(b.skill, b.target, b.description)))

  // specs/120 — a write-capable branch can now reach `input-required` and
  // sit there, potentially for a long time, waiting on a real human. A
  // plain `Promise.all(dispatched.map(deps.wait))` (specs/060's original
  // shape, correct only because a read-only skill can never reach
  // input-required) would leave every OTHER branch's approval prompt
  // dangling the moment one branch is rejected/times out/fails-ambiguous —
  // a human staring at a request to approve a step belonging to a run that
  // is already over. Instead: race the branches' own wait() promises as
  // they resolve, and the instant any ONE produces a run-ending outcome,
  // skip every still-in-flight sibling via deps.skip() so its own approval
  // prompt is withdrawn cleanly. Every branch's wait() promise is still
  // awaited to its own real resolution before this function returns — a
  // skip attempt is best-effort (deps.skip is optional, and a branch may
  // have already resolved on its own before the skip fires), never
  // fabricated: the outcome recorded for each branch is always what its
  // own wait() genuinely returned, never synthesized.
  const pending = new Map<number, Promise<{ i: number; wait: WaitResult | null }>>()
  for (let i = 0; i < toDispatch.length; i++) {
    const d = dispatched[i]
    pending.set(i, d ? deps.wait(d.childTaskId).then((wait) => ({ i, wait })) : Promise.resolve({ i, wait: null }))
  }

  const results: (WaitResult | null)[] = new Array(toDispatch.length).fill(null)
  let runEndingOutcome: DispatchOutcome["kind"] | null = null

  while (pending.size > 0) {
    const settled = await Promise.race(pending.values())
    pending.delete(settled.i)
    results[settled.i] = settled.wait
    if (!settled.wait) continue // no agent online for this branch — reported in the loop below

    const tier = classifySkillTier(toDispatch[settled.i].skill)
    const outcome = classifyDispatchOutcome(settled.wait, tier)
    if (!runEndingOutcome && (outcome.kind === "rejected" || outcome.kind === "failed-ambiguous" || outcome.kind === "timeout")) {
      runEndingOutcome = outcome.kind
      for (const j of pending.keys()) {
        const dj = dispatched[j]
        if (dj) await deps.skip?.(dj.childTaskId)
      }
    }
  }

  const messages: HumanMessage[] = []
  let newDispatchCount = state.dispatchCount
  const newAttemptCounts = { ...state.skillAttemptCounts }
  const newWriteKeys: string[] = []
  const newSkippedSkillIds: string[] = []
  let terminalReason: "rejected" | "timeout" | "failed-ambiguous" | null = null

  for (let i = 0; i < toDispatch.length; i++) {
    const branch = toDispatch[i]
    if (!dispatched[i]) {
      // No agent online for this skill right now — mirrors the
      // single-branch path's own "no agent" handling exactly: budget is
      // not consumed for a dispatch that never actually happened.
      messages.push(new HumanMessage(`No agent is currently online for skill "${branch.skill}". Choose a different action, or finish.`))
      continue
    }

    newDispatchCount += 1
    newAttemptCounts[branch.skill] = (newAttemptCounts[branch.skill] ?? 0) + 1

    const tier = classifySkillTier(branch.skill)
    // Mirrors the single-dispatch path's own newWriteKeys computation
    // exactly: a write-capable branch's key is recorded regardless of its
    // outcome, so the same (skill, target) pair cannot be re-proposed later
    // in this run even after a rejection/failure — unchanged pre-120
    // behavior, just now reachable from inside a batch too.
    if (tier === "write-capable") newWriteKeys.push(`${branch.skill}::${branch.target}`)

    const outcome = classifyDispatchOutcome(results[i]!, tier)
    auditLog.push({
      type: "dispatch", skill: branch.skill, target: branch.target,
      outcome: outcome.kind, durationMs: performance.now() - started, timestamp: Date.now(),
    })

    if (outcome.kind === "rejected" || outcome.kind === "timeout" || outcome.kind === "failed-ambiguous") {
      // specs/028's guarantee, preserved exactly inside a batch: the
      // supervisor is never re-consulted after one of these. No per-branch
      // observation message is needed — the run ends below.
      if (!terminalReason) terminalReason = outcome.kind
      continue
    }
    if (outcome.kind === "skipped") {
      // specs/089 (Option B), reachable inside a batch for the first time:
      // NOT terminal — the skill id joins skippedSkillIds so dispatchNode()
      // refuses it if re-proposed, but every other branch (this one
      // included, since it's already resolved) proceeds normally.
      newSkippedSkillIds.push(branch.skill)
      messages.push(new HumanMessage(`Step "${branch.skill}" was explicitly skipped by the user — do not attempt this exact step or a workaround that achieves the same effect. You may try a different action, or finish.`))
      continue
    }
    // completed or failed-safe — the only two outcomes that simply loop back.
    const observation = outcome.kind === "completed"
      ? `"${branch.skill}" completed successfully.`
      : `"${branch.skill}" failed safely (no mutation occurred — it is read-only). You may try a different action.`
    messages.push(new HumanMessage(observation))
  }

  if (terminalReason) {
    return {
      terminal: terminalReason,
      dispatchCount: newDispatchCount,
      skillAttemptCounts: newAttemptCounts,
      dispatchedWriteKeys: newWriteKeys,
      skippedSkillIds: newSkippedSkillIds,
      auditLog,
    }
  }

  return {
    messages,
    dispatchCount: newDispatchCount,
    skillAttemptCounts: newAttemptCounts,
    dispatchedWriteKeys: newWriteKeys,
    skippedSkillIds: newSkippedSkillIds,
    auditLog,
  }
}

// ============================================================
// GRAPH BUILD
// ============================================================
export interface BuildSupervisorGraphOptions {
  model: BaseChatModel
  deps: SupervisorDeps
  maxDispatches?: number
  maxAttemptsPerSkill?: number
  recursionLimit?: number
  // specs/102-orchestrator-readonly-project-inspection/spec.md — see
  // buildSystemPrompt()'s own comment. Threaded through only to
  // runSupervisor() below; buildSupervisorGraph() itself never reads it
  // (the prompt is built once, in runSupervisor(), before the graph is
  // ever invoked).
  projectContext?: string
}

export function buildSupervisorGraph(options: BuildSupervisorGraphOptions) {
  const maxDispatches = options.maxDispatches ?? DEFAULT_MAX_DISPATCHES
  const maxAttemptsPerSkill = options.maxAttemptsPerSkill ?? DEFAULT_MAX_ATTEMPTS_PER_SKILL

  function afterSupervisor(state: SupervisorStateType): "dispatch" | typeof END {
    const last = state.messages[state.messages.length - 1]
    const toolCall = last instanceof AIMessage ? last.tool_calls?.[0] : undefined
    if (toolCall?.name === "dispatch_skill") return "dispatch"
    return END
  }

  function afterDispatch(state: SupervisorStateType): "supervisor" | typeof END {
    if (state.terminal !== null) return END
    return "supervisor"
  }

  const graph = new StateGraph(SupervisorState)
    .addNode("supervisor", (state: SupervisorStateType) => supervisorNode(state, options.model))
    .addNode("dispatch", (state: SupervisorStateType) => dispatchNode(state, options.deps, { maxDispatches, maxAttemptsPerSkill }))
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", afterSupervisor, { dispatch: "dispatch", [END]: END })
    .addConditionalEdges("dispatch", afterDispatch, { supervisor: "supervisor", [END]: END })
    .compile()

  return { graph, recursionLimit: options.recursionLimit ?? DEFAULT_RECURSION_LIMIT }
}

// ============================================================
// ENTRY POINT
// ============================================================
export interface SupervisorRunResult {
  terminal: TerminalReason
  dispatchCount: number
  auditLog: SupervisorAuditEntry[]
}

export async function runSupervisor(taskText: string, options: BuildSupervisorGraphOptions): Promise<SupervisorRunResult> {
  const { graph, recursionLimit } = buildSupervisorGraph(options)
  const finalState = (await graph.invoke(
    { messages: [new SystemMessage(buildSystemPrompt(taskText, options.projectContext)), new HumanMessage(taskText)] },
    { recursionLimit },
  )) as SupervisorStateType
  return {
    terminal: finalState.terminal ?? "done",
    dispatchCount: finalState.dispatchCount,
    auditLog: finalState.auditLog,
  }
}
