// OrchestrAI — process supervisor (specs/016-orchestrai-supervisor/spec.md)
// and combined-binary dispatcher (specs/017-standalone-binary-distribution/spec.md).
//
// A single-entry replacement for manually starting 6+ terminals, on top of
// what `bun run dev` already does. Adds: port preflight before starting
// anything, ordered startup (MCP HTTP server + agents first, Orchestrator
// last, gated on real /healthz readiness), prefixed logs per service, a
// startup summary, `--only <service[,service...]>` for debugging a subset,
// and a clean Ctrl+C shutdown that doesn't orphan children — none of which
// `bun run --parallel` (used by `bun run dev`) provides on its own.
//
// This same file is also the entry point compiled into the single
// standalone `orchestrai` executable (`bun run build`). `service <name>`
// and `tui` subcommands let the compiled binary start exactly one thing
// in-process (used by the supervisor to self-spawn children when
// compiled, and directly useful for manual debugging either way).
//
// Deliberately NOT included (see specs' Non-Goals): the stdio MCP server
// (`bun run mcp` — a separate external-compatibility surface, not part of
// this 7-service A2A runtime), `--version`, and any change to `bun run
// dev` itself, which remains the simpler original option.

import * as path from "path"
import * as net from "net"
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, appendFileSync } from "fs"
import { configPaths as wizardConfigPaths, parseConfigEnv, runInitWizard, AGENT_LLM_HARNESSES, findStaleLlmVariables } from "./init-wizard"
import { checkStartupLlmKeys, type StartupKeyRequirement } from "../../packages/shared/llm-model-factory"
import { resolveServicePort, DEFAULT_SERVICE_PORTS, type ServicePortName } from "../../packages/shared/service-ports"

// specs/018-supervisor-project-path/spec.md: config file the compiled binary
// looks for next to itself, containing one line — an absolute path.
export const PROJECT_CONFIG_FILENAME = "orchestrai.project.txt"

// Pure and independently testable: given each candidate source's already-
// read value (or undefined/empty if that source doesn't apply), returns
// the first match in priority order. Does no I/O itself — apps/supervisor/
// index.ts's own project-path.test.ts exercises this directly without
// needing real files/env/cwd.
export function resolveProjectPath(sources: {
  flagValue?: string
  envValue?: string
  configFileValue?: string
  cwd?: string
}): { path: string; source: string } | null {
  if (sources.flagValue?.trim()) return { path: sources.flagValue.trim(), source: "--project" }
  if (sources.envValue?.trim()) return { path: sources.envValue.trim(), source: "ORCHESTRAI_PROJECT_PATH (already set)" }
  if (sources.configFileValue?.trim()) return { path: sources.configFileValue.trim(), source: PROJECT_CONFIG_FILENAME }
  if (sources.cwd?.trim()) return { path: sources.cwd.trim(), source: "current directory" }
  return null
}

/** specs/051-planning-retirement-and-required-key/spec.md §2 — pure and
 *  independently testable, matching `resolveProjectPath()`'s own shape
 *  just above: given which services are actually starting (by name) and
 *  the environment, returns one `StartupKeyRequirement` per agent whose
 *  own harness is on. Does no I/O and reads no global state itself —
 *  apps/supervisor's own startup-llm-key.test.ts exercises it directly
 *  without spawning anything or touching real env vars.
 *
 *  Scoped to agent harnesses only — the Orchestrator's own requirement is
 *  a separate, always-true-when-it-starts condition (not tied to a
 *  harness toggle), composed in at the call site instead of folded in
 *  here, so this stays testable as one clear concern. */
// specs/077-agent-enabled-means-llm-on-by-default/spec.md — moves with
// each agent's own model-factory.ts default flip: a `defaultOn` row
// (DevOps/Documentation/Security/Testing) is "on" whenever its env var
// isn't the literal "0"; a non-default row (Code Review/Coder, still
// genuinely opt-in) is "on" only with an explicit "1" — unchanged. This
// keeps the non-blocking startup warning firing for exactly the agents
// whose harness is actually active, matching each model-factory.ts's
// own isHarnessFlagSet() condition rather than drifting from it.
export function resolveAgentLlmKeyRequirements(
  startingServiceNames: string[],
  env: Record<string, string | undefined>,
): StartupKeyRequirement[] {
  return AGENT_LLM_HARNESSES.filter((h) => {
    if (!startingServiceNames.includes(h.agent)) return false
    return h.defaultOn ? env[h.envVar] !== "0" : env[h.envVar] === "1"
  }).map((h) => ({ component: h.component, reason: `${h.label} is on` }))
}

// Set only by scripts/build-binary.ts's `--define`, never in a normal
// `bun run` invocation — a documented, stable Bun feature (confirmed via
// `bun build --help` and a direct spike before writing the corresponding
// spec), not an assumption about Bun's internal compiled-binary path
// format. `typeof` on an undeclared identifier is safe (evaluates to
// "undefined", never throws), so this is safe to reference unconditionally
// in dev mode where the identifier was never defined at all.
declare const ORCHESTRAI_COMPILED: string | undefined
const isCompiled = typeof ORCHESTRAI_COMPILED !== "undefined"

// Every service this dispatcher can start on demand, by name. Dynamic
// imports so `bun build --compile` bundles all of them into the one output
// binary, but only the branch actually selected at runtime executes its
// start() — importing a module no longer has a side effect (see each
// service's own start()/import.meta.main guard).
const SERVICE_STARTERS: Record<string, () => Promise<void>> = {
  "devops-agent": async () => (await import("../../packages/agents/devops/index")).start(),
  "testing-agent": async () => (await import("../../packages/agents/testing/index")).start(),
  "documentation-agent": async () => (await import("../../packages/agents/documentation/index")).start(),
  "security-agent": async () => (await import("../../packages/agents/security/index")).start(),
  "code-review-agent": async () => (await import("../../packages/agents/code-review/index")).start(),
  "coder-agent": async () => (await import("../../packages/agents/coder/index")).start(),
  "mcp:http": async () => (await import("../../packages/mcp/http")).start(),
  "orchestrator": async () => (await import("../orchestrator/index")).start(),
}

interface ServiceDef {
  name: string
  scriptRelPath: string
  // specs/073-configurable-service-ports/spec.md — which
  // ORCHESTRAI_<SERVICE>_PORT this def's port resolves from.
  portKey: ServicePortName
  port: number
  dependsOnMcp?: boolean
}

// Resolved relative to this file's own location, not process.cwd() — so
// `bun run orchestrai` behaves the same regardless of which directory it's
// invoked from. Matches this repo's existing target-project-path resolver,
// which rejects a cwd-based fallback for the same reason.
const REPO_ROOT = path.join(import.meta.dir, "..", "..")

// `port` below is each service's default, for any pre-merge access (e.g.
// --help text, --only name validation). It is NOT the value actually used
// to preflight/spawn/health-check — main() calls resolveServicePorts() to
// refresh every `port` field in place from real env, after
// `.orchestrai/config.env` has been merged into process.env (see that call
// site's own comment for why the ordering matters: these defs are
// evaluated at module-load time, before that merge has happened).
const MCP_HTTP: ServiceDef = { name: "mcp:http", scriptRelPath: "packages/mcp/http.ts", portKey: "mcpHttp", port: DEFAULT_SERVICE_PORTS.mcpHttp }
// specs/051-planning-retirement-and-required-key/spec.md — Planning
// Agent deleted; port 3001 is freed, not reassigned.
const AGENTS: ServiceDef[] = [
  { name: "devops-agent", scriptRelPath: "packages/agents/devops/index.ts", portKey: "devops", port: DEFAULT_SERVICE_PORTS.devops, dependsOnMcp: true },
  { name: "testing-agent", scriptRelPath: "packages/agents/testing/index.ts", portKey: "testing", port: DEFAULT_SERVICE_PORTS.testing, dependsOnMcp: true },
  { name: "documentation-agent", scriptRelPath: "packages/agents/documentation/index.ts", portKey: "documentation", port: DEFAULT_SERVICE_PORTS.documentation, dependsOnMcp: true },
  { name: "security-agent", scriptRelPath: "packages/agents/security/index.ts", portKey: "security", port: DEFAULT_SERVICE_PORTS.security },
  // specs/082-code-review-agent/spec.md — the first genuinely new agent;
  // a real MCP client (git_diff/read_project_file), unlike Security.
  { name: "code-review-agent", scriptRelPath: "packages/agents/code-review/index.ts", portKey: "codeReview", port: DEFAULT_SERVICE_PORTS.codeReview, dependsOnMcp: true },
  // specs/083-coder-agent/spec.md — the second genuinely new agent; a
  // real MCP client (read_project_file/write_project_file).
  { name: "coder-agent", scriptRelPath: "packages/agents/coder/index.ts", portKey: "coder", port: DEFAULT_SERVICE_PORTS.coder, dependsOnMcp: true },
]
const ORCHESTRATOR: ServiceDef = { name: "orchestrator", scriptRelPath: "apps/orchestrator/index.ts", portKey: "orchestrator", port: DEFAULT_SERVICE_PORTS.orchestrator }

/** specs/073-configurable-service-ports/spec.md — refreshes every
 *  ServiceDef's `port` field in place from `resolveServicePort()`, which
 *  reads `process.env` fresh at call time. Exported (pure-ish: mutates the
 *  module-level defs, reads only `env`) so it can be called deliberately
 *  after `.orchestrai/config.env` has been merged into `process.env`,
 *  never relying on module-load-time evaluation order. */
export function resolveServicePorts(): void {
  MCP_HTTP.port = resolveServicePort(MCP_HTTP.portKey)
  for (const svc of AGENTS) svc.port = resolveServicePort(svc.portKey)
  ORCHESTRATOR.port = resolveServicePort(ORCHESTRATOR.portKey)
}

const ALL_STARTABLE: ServiceDef[] = [MCP_HTTP, ...AGENTS] // everything except Orchestrator, which is always started last
const ALL_NAMES = [...ALL_STARTABLE.map((s) => s.name), ORCHESTRATOR.name]

const HEALTH_TIMEOUT_MS = 15_000
const HEALTH_POLL_INTERVAL_MS = 300
const SHUTDOWN_GRACE_MS = 5_000

function printHelp(): void {
  console.log(`OrchestrAI Supervisor

Starts the MCP HTTP server, all 4 agents, and the Orchestrator with port
preflight, readiness-gated ordering (Orchestrator last, after agents
report healthy), prefixed logs, and a startup summary. Additive to
\`bun run dev\`, not a replacement for it.

When run in a real interactive terminal, the terminal viewer opens
automatically once everything is healthy — no separate \`tui\` command
needed. When output is redirected/piped (a log file, a background job,
CI), it stays headless automatically instead, so scripted/background runs
are never surprised by an interactive UI trying to attach to a non-TTY.
Either way, Ctrl+C stops everything with no orphaned processes. When the
terminal viewer is open, this can take two presses in practice (live-
confirmed 2026-09-01): the first is consumed by the viewer's own
raw-mode keyboard handling and exits it; the second reaches the
supervisor and stops the backend services.

Usage:
  bun run orchestrai [--only <name[,name...]>] [--project <path>] [--headless] [--help]
  bun run orchestrai init             # interactive setup wizard (or: i)
  bun run orchestrai service <name>   # start exactly one service
  bun run orchestrai tui              # start only the terminal viewer

Options:
  --only <names>   Start only the named service(s) (comma-separated).
                   Valid names: ${ALL_NAMES.join(", ")}
                   devops-agent/testing-agent/documentation-agent
                   automatically also start mcp:http if it isn't already
                   selected (printed as a note, never silent).
  --project <path> The project the agents should analyze/modify. If
                   omitted, resolved in this order: an already-set
                   ORCHESTRAI_PROJECT_PATH env var, a .orchestrai/${PROJECT_CONFIG_FILENAME}
                   in the current directory (written by \`orchestrai init\`),
                   a ${PROJECT_CONFIG_FILENAME} file next to the binary
                   (compiled mode only), then the current directory.
                   Printed at startup either way — never a silent guess. A
                   per-task explicit path always still works regardless of
                   any of this.
  --headless       Never open the terminal viewer, even in a real
                   terminal — stay in plain log-output mode.
  --help           Show this help and exit without starting anything.

\`init\` (specs/031-interactive-init-wizard/spec.md): an interactive prompt
flow asking for the target path, which services to run, and whether to
enable the LLM harness (provider/model/key). On confirmation it writes
<target>/.orchestrai/ so a plain \`orchestrai\` run from that directory
needs no flags at all. An explicit flag or an already-set env var always
still overrides what was saved.

Examples:
  bun run orchestrai                    # opens the viewer automatically in a real terminal
  bun run orchestrai init               # interactive setup, run once per project
  bun run orchestrai --project "C:\\my-app"
  bun run orchestrai --headless         # backend only, plain logs, even interactively
  bun run orchestrai --only devops-agent
  bun run orchestrai --only security-agent,documentation-agent
  bun run orchestrai --only orchestrator
  bun run orchestrai service security-agent
  bun run orchestrai tui
`)
}

function parseArgs(argv: string[]): { only?: string[]; help: boolean; headless: boolean; project?: string } {
  let only: string[] | undefined
  let help = false
  let headless = false
  let project: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      help = true
    } else if (arg === "--headless") {
      headless = true
    } else if (arg === "--project") {
      const value = argv[i + 1]
      if (value) {
        project = value
        i++
      }
    } else if (arg?.startsWith("--project=")) {
      project = arg.slice("--project=".length)
    } else if (arg === "--only") {
      const value = argv[i + 1]
      if (value) {
        only = value.split(",").map((s) => s.trim()).filter(Boolean)
        i++
      }
    } else if (arg?.startsWith("--only=")) {
      only = arg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean)
    }
  }
  return { only, help, headless, project }
}

// Binding to the port ourselves and immediately releasing it is a more
// reliable "is this free" check than a health-endpoint probe (which would
// misreport "free" for a port occupied by something that isn't even
// listening yet, or a non-HTTP process).
export type PortCheckResult = { free: true } | { free: false; reason: "in-use" | "timeout" }

// specs/045-supervisor-port-preflight-timeout/spec.md — live-caught,
// 2026-09-02: this had no timeout at all. A just-released port can sit
// in a transitional state on Windows where a new bind neither errors nor
// succeeds promptly, and listen()'s Promise then never resolves — the
// await in the preflight loop below blocked forever with zero output,
// not even an error. waitForHealthy() just below already bounds its own
// wait for exactly this class of risk; this one didn't. 3000ms matches
// the AbortSignal.timeout(3000) waitForHealthy() already uses for its
// own network probe, rather than inventing a second differently-tuned
// constant for the same "how long do we wait on the network stack"
// question. A timeout resolves `free: false` — the same safe "refuse to
// start" outcome a genuine conflict produces, since either cause makes
// starting a service on that port unsafe.
const PORT_CHECK_TIMEOUT_MS = 3000

// specs/045 — test-only injection seam. `net.createServer` is a
// read-only ESM binding in this runtime (Bun rejects reassigning it),
// so the "listen() never settles" condition the timeout exists for
// can't be simulated by monkey-patching the module. `createServer` lets
// a test substitute a server double whose `listen()` deliberately never
// emits "error" or "listening", proving the bound holds without needing
// to reproduce the real (narrow, Windows-timing-dependent) trigger.
// Production code never passes this — the default is the real `net`.
export function isPortFree(
  port: number,
  overrides: { timeoutMs?: number; createServer?: () => net.Server } = {},
): Promise<PortCheckResult> {
  const timeoutMs = overrides.timeoutMs ?? PORT_CHECK_TIMEOUT_MS
  const createServer = overrides.createServer ?? (() => net.createServer())

  return new Promise((resolve) => {
    let settled = false
    const srv = createServer()

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // Resolve immediately, without waiting on close()'s own callback —
      // close() can hang in the exact same stuck state that motivated
      // this fix in the first place, so waiting on it would reintroduce
      // an unbounded wait one line later. close() is still called, for
      // best-effort cleanup, but nothing here depends on it completing.
      srv.removeAllListeners()
      srv.close()
      resolve({ free: false, reason: "timeout" })
    }, timeoutMs)

    srv.once("error", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ free: false, reason: "in-use" })
    })
    srv.once("listening", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      srv.close(() => resolve({ free: true }))
    })
    srv.listen(port, "127.0.0.1")
  })
}

async function waitForHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      // Not up yet — keep polling until the deadline.
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
  }
  return false
}

interface RunningChild {
  def: ServiceDef
  proc: ReturnType<typeof Bun.spawn>
}

const children: RunningChild[] = []

// specs/066-supervisor-log-suppression-during-tui/spec.md — when the
// auto-launched TUI (specs/062) takes over the terminal, it's spawned
// with stdin/stdout/stderr: "inherit", meaning its screen IS this
// process's own stdout. Nothing previously stopped spawnService()'s own
// prefixed-log console.log/console.error calls from continuing to write
// raw lines onto that exact same screen for the rest of the run — every
// real MCP tool call, dispatch, or audit event corrupted the TUI's own
// rendered box mid-use. Live-caught, 2026-09-09/10: a real conversation
// worked (the TUI genuinely received and processed input — this was
// never a keyboard bug), but the screen became unreadable the moment
// real backend activity started logging.
//
// Redirection, not deletion: every suppressed line is still written, in
// order, to a file — nothing a --headless run would have shown is lost,
// it just isn't fighting the TUI for the same screen. Unset by default,
// so every non-TUI run (headless, `bun run dev`, CI, any non-TTY
// invocation) is byte-identical to before this spec — this flag is only
// ever set once, immediately before the TUI child spawns.
let childLogsSuppressed = false
let supervisorLogPath: string | null = null

// Exported so specs/066-supervisor-log-suppression-during-tui/spec.md's
// own regression test can exercise the suppression gate directly,
// matching this file's own existing pattern of exporting otherwise-
// internal logic purely for direct testability (see resolveProjectPath/
// resolveAgentLlmKeyRequirements above).
export function writeChildLog(line: string, isError: boolean): void {
  if (childLogsSuppressed && supervisorLogPath) {
    try {
      appendFileSync(supervisorLogPath, line + "\n")
    } catch {
      // Best-effort — a log write must never be why the supervisor itself
      // crashes. Falling back to console here would reintroduce the exact
      // corruption this mechanism exists to prevent, so a failed write is
      // silently dropped, not redirected back to the screen.
    }
    return
  }
  if (isError) console.error(line)
  else console.log(line)
}

/** Test-only setter for the module state writeChildLog() reads — real
 *  startup code sets these two variables directly, at exactly one point
 *  (main()'s shouldOpenTui branch), never through this function. */
export function __setChildLogSuppressionForTests(suppressed: boolean, logPath: string | null): void {
  childLogsSuppressed = suppressed
  supervisorLogPath = logPath
}

async function pipePrefixed(
  stream: ReadableStream<Uint8Array> | null | undefined,
  name: string,
  write: (line: string) => void,
): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) write(`[${name}] ${line}`)
    }
  } catch {
    // Stream closed underneath us (process exited) — nothing to do.
  }
  if (buffer.trim()) write(`[${name}] ${buffer}`)
}

// Dev mode: re-execs with the exact same Bun binary already running this
// supervisor (process.execPath), not a bare "bun" string that would depend
// on PATH resolution being correct on the target machine — byte-for-byte
// the same spawn behavior already verified in specs/016-orchestrai-supervisor/spec.md.
// Compiled mode: process.execPath now IS the one standalone binary, so it
// re-invokes itself with `service <name>`, which the dispatch block below
// routes to SERVICE_STARTERS — no Bun, no source .ts files needed at
// runtime.
function resolveSpawnCommand(def: ServiceDef): string[] {
  if (isCompiled) return [process.execPath, "service", def.name]
  return [process.execPath, "run", path.join(REPO_ROOT, def.scriptRelPath)]
}

function spawnService(def: ServiceDef): RunningChild {
  // REPO_ROOT (via import.meta.dir) is only a real, valid directory in dev
  // mode. Inside a compiled standalone binary, import.meta.dir resolves to
  // Bun's internal virtual path for the embedded bundle (e.g.
  // `B:\~BUN\root` on Windows) — traversing `..` from that gives a
  // nonexistent directory, and passing it as `cwd` breaks Bun.spawn()
  // entirely (confirmed live: a self-spawn failed with a misleading ENOENT
  // on the *target executable*, not the cwd, until this was found and
  // fixed — see specs/017-standalone-binary-distribution/spec.md's
  // Verification Results). In compiled mode there's no script path to
  // resolve relative to anyway, so just inherit the parent's real cwd
  // (wherever the user actually invoked the binary from) by omitting `cwd`.
  const proc = Bun.spawn(resolveSpawnCommand(def), {
    cwd: isCompiled ? undefined : REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  void pipePrefixed(proc.stdout, def.name, (line) => writeChildLog(line, false))
  void pipePrefixed(proc.stderr, def.name, (line) => writeChildLog(line, true))
  const child: RunningChild = { def, proc }
  children.push(child)
  return child
}

// specs/067-supervisor-kill-orphaned-children-on-exit/spec.md — the
// synchronous last-resort backstop. `process.on("exit")` fires for
// (almost) every way the event loop ends — a normal return, an uncaught
// exception, an explicit process.exit(), and after a signal handler has
// run — but its handler MUST be synchronous, so this can only hard-kill,
// with no grace period and no await. That's acceptable here: by the time
// `exit` fires the supervisor is already going away, and the in-memory
// task state that a graceful SIGINT would let a child flush is gone with
// the supervisor regardless. The graceful path (shutdown() below, from
// SIGINT/SIGTERM/SIGHUP) still runs first whenever it can; this only
// covers the paths that currently leak the whole stack — most visibly a
// Windows console-window close, which raises CTRL_CLOSE_EVENT and is not
// delivered as SIGINT/SIGTERM.
export function killAllChildrenSync(list: readonly Pick<RunningChild, "proc">[] = children): void {
  for (const c of list) {
    try {
      c.proc.kill("SIGKILL")
    } catch {
      // already exited, or the handle is gone — nothing to do.
    }
  }
}

/** specs/074-fix-exit-backstop-argument-bug/spec.md — the actual
 *  `process.on("exit", ...)` listener. Node/Bun always invokes an "exit"
 *  listener with the process's numeric exit code
 *  (`listener(code)`) — passing `killAllChildrenSync` itself as the
 *  listener let that code land directly in its own `list` parameter,
 *  overriding the `= children` default with a plain number and crashing
 *  `for (const c of list)` before killing anything, on every single
 *  exit. This wrapper's own parameter absorbs and discards whatever
 *  Node passes, so `killAllChildrenSync()` is always called with
 *  genuinely zero arguments — exported so a test can simulate Node's
 *  real invocation shape directly, not just the already-tested
 *  explicit-list behavior of `killAllChildrenSync` itself. */
export function runExitBackstop(_exitCode?: number): void {
  killAllChildrenSync()
}

async function shutdown(): Promise<void> {
  console.log("\n[supervisor] Shutting down...")
  for (const c of children) {
    try {
      c.proc.kill("SIGINT")
    } catch {
      // already exited
    }
  }
  const allExited = Promise.all(children.map((c) => c.proc.exited))
  const timedOut = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SHUTDOWN_GRACE_MS))
  const outcome = await Promise.race([allExited.then(() => "exited" as const), timedOut])
  if (outcome === "timeout") {
    for (const c of children) {
      if (c.proc.exitCode === null) {
        console.log(`[supervisor] Force-stopping ${c.def.name} (didn't exit within ${SHUTDOWN_GRACE_MS}ms)`)
        try {
          c.proc.kill("SIGKILL")
        } catch {
          // already exited
        }
      }
    }
  }
  console.log("[supervisor] All processes stopped.")
}

async function main(): Promise<void> {
  const { only, help, headless, project } = parseArgs(process.argv.slice(2))

  if (help) {
    printHelp()
    process.exit(0)
  }

  // Auto-open the terminal viewer only when attached to a real interactive
  // terminal — process.stdout.isTTY is false when output is redirected to
  // a file, piped, or run detached/backgrounded (exactly how this repo's
  // own verification commands run it), so those never unexpectedly try to
  // attach an interactive renderer to a non-TTY. `--headless` forces plain
  // log-output mode even in a real terminal, for anyone who wants that.
  const shouldOpenTui = Boolean(process.stdout.isTTY) && !headless

  // specs/031-interactive-init-wizard/spec.md — a wizard-written config at
  // <cwd>/.orchestrai/, if present, loaded before anything else below.
  // Deliberately keyed off cwd, not an already-resolved project path:
  // `orchestrai init` writes into the directory it's run from (Option B —
  // "cd my-app && orchestrai init" mirrors the plain "cd my-app &&
  // orchestrai" invocation shape), and works identically in dev mode and
  // compiled mode, unlike the next-to-binary config file below. Every
  // loaded env var only fills in a gap — an explicit flag or an
  // already-set env var always still wins, same rule specs/018 already
  // established for the project path.
  const wizardPaths = wizardConfigPaths(process.cwd())
  let wizardProjectPathValue: string | undefined
  if (existsSync(wizardPaths.projectPath)) {
    try {
      wizardProjectPathValue = readFileSync(wizardPaths.projectPath, "utf8").trim() || undefined
    } catch {
      // Unreadable — treat as absent.
    }
  }
  if (existsSync(wizardPaths.envPath)) {
    try {
      const wizardEnv = parseConfigEnv(readFileSync(wizardPaths.envPath, "utf8"))
      for (const [key, value] of Object.entries(wizardEnv)) {
        if (process.env[key] === undefined) process.env[key] = value
      }
    } catch {
      // Unreadable — treat as absent, same as the project-path file above.
    }
  }
  // specs/051-planning-retirement-and-required-key/spec.md §4 — a config
  // (this one's own file, or the shell environment directly) may still
  // carry a variable that used to configure real behavior and now
  // configures nothing. Checked here, after the wizard file above has been
  // merged into process.env but before anything acts on it, so both
  // sources are covered by one call. Never fatal — a leftover flag from a
  // previous version must never brick a startup, only be named.
  for (const { variable, note } of findStaleLlmVariables(process.env)) {
    console.warn(`[supervisor] warning: ${variable} is set but no longer does anything — ${note}`)
  }

  // specs/073-configurable-service-ports/spec.md — must run after the
  // config.env merge above, never before: MCP_HTTP/AGENTS/ORCHESTRATOR are
  // module-top-level consts evaluated at import time, so a port override
  // saved to .orchestrai/config.env would otherwise never be seen by the
  // preflight/health-check/startup-summary code below, which all read
  // these defs' `.port` field.
  resolveServicePorts()

  // ORCHESTRAI_ONLY has no meaning outside this wizard-config path — it
  // only ever feeds `only` when the --only flag itself wasn't passed.
  let effectiveOnly = only
  if (!effectiveOnly && process.env.ORCHESTRAI_ONLY) {
    const fromConfig = process.env.ORCHESTRAI_ONLY.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    if (fromConfig.length > 0) effectiveOnly = fromConfig
  }

  // specs/018-supervisor-project-path/spec.md — a supervisor-level convenience
  // layered on top of (not a change to) each agent's own unchanged
  // resolveTargetPath() policy. Only ever injects ORCHESTRAI_PROJECT_PATH
  // into this process's own env (inherited by every spawned child) when
  // something actually resolved; never silent about which source won.
  let configFileValue: string | undefined
  if (isCompiled) {
    const configPath = path.join(path.dirname(process.execPath), PROJECT_CONFIG_FILENAME)
    if (existsSync(configPath)) {
      try {
        configFileValue = readFileSync(configPath, "utf8").trim()
      } catch {
        // Unreadable config file — treat as absent, fall through to cwd.
      }
    }
  }
  // specs/031: the wizard's own per-project config ranks above the
  // generic next-to-binary one — it's more specific to this invocation.
  const resolvedProject = resolveProjectPath({
    flagValue: project,
    envValue: process.env.ORCHESTRAI_PROJECT_PATH,
    configFileValue: wizardProjectPathValue || configFileValue,
    cwd: process.cwd(),
  })
  if (resolvedProject) {
    process.env.ORCHESTRAI_PROJECT_PATH = resolvedProject.path
    // resolveProjectPath() doesn't distinguish which physical file won at
    // the "config file" tier — disambiguate here so the startup log is
    // never a silent guess about which of the two it actually was.
    const source =
      resolvedProject.source === PROJECT_CONFIG_FILENAME && wizardProjectPathValue
        ? `${wizardPaths.projectPath} (orchestrai init)`
        : resolvedProject.source
    console.log(`[supervisor] Project path: ${resolvedProject.path} (source: ${source})`)
  } else {
    console.log("[supervisor] No project path resolved — each task will need an explicit absolute path, or agents will report a clear error.")
  }

  let toStart: ServiceDef[] = ALL_STARTABLE
  let startOrchestrator = true

  if (effectiveOnly && effectiveOnly.length > 0) {
    const unknown = effectiveOnly.filter((n) => !ALL_NAMES.includes(n))
    if (unknown.length > 0) {
      console.error(`Unknown service name(s): ${unknown.join(", ")}`)
      console.error(`Valid names: ${ALL_NAMES.join(", ")}`)
      process.exit(1)
    }
    const requested = new Set(effectiveOnly)
    toStart = ALL_STARTABLE.filter((s) => requested.has(s.name))
    startOrchestrator = requested.has(ORCHESTRATOR.name)

    // specs/106-persistence-store-and-result-cache/spec.md — a real gap
    // found while live-verifying that spec: the Orchestrator itself
    // (specs/102's own read-only MCP client, default-on) was never
    // considered here at all — it isn't a ServiceDef in ALL_STARTABLE/
    // toStart, it's started separately via the startOrchestrator flag
    // below, so `--only orchestrator` (and `--only orchestrator,<agent
    // with no MCP dependency>`) silently left mcp:http unstarted despite
    // the Orchestrator needing it for every one of specs/102/105/106's
    // own fallback-analysis paths. ORCHESTRAI_ORCHESTRATOR_INSPECTION=0
    // (the same opt-out buildOrchestratorMcpClient() itself honors)
    // means the Orchestrator won't even try to connect, so it's excluded
    // from this check the same way a dependent agent would be.
    const orchestratorWantsMcp = startOrchestrator && process.env.ORCHESTRAI_ORCHESTRATOR_INSPECTION !== "0"
    const dependentServices = toStart.filter((s) => s.dependsOnMcp)
    const needsMcp = dependentServices.length > 0 || orchestratorWantsMcp
    const mcpAlreadySelected = toStart.some((s) => s.name === MCP_HTTP.name)
    if (needsMcp && !mcpAlreadySelected) {
      const dependentNames = dependentServices.map((s) => s.name).concat(orchestratorWantsMcp ? [ORCHESTRATOR.name] : [])
      const verb = dependentNames.length > 1 ? "require" : "requires"
      console.log(`[supervisor] note: ${dependentNames.join(", ")} ${verb} the MCP HTTP server — also starting ${MCP_HTTP.name}`)
      toStart = [MCP_HTTP, ...toStart]
    }
  }

  // specs/051-planning-retirement-and-required-key/spec.md §2/§3
  // originally made a resolvable provider key a startup-BLOCKING
  // requirement for any component that will actually make an LLM call
  // this run. specs/064-supervisor-startup-key-check-non-blocking/
  // spec.md (2026-09-10) softened that to a warning: every direct,
  // keyword-routed skill in this system (dockerize, analyze-project,
  // git-status, and every DevOps/Testing/Documentation/Security
  // deterministic path) needs no provider key at all, so blocking
  // startup entirely for a capability the operator may not even intend
  // to use this run was a real, unnecessary cost — found while preparing
  // a live demo. Nothing about the actual fail-closed guarantee changes:
  // `runOrchestratorSupervisor()`'s own per-request check (and each
  // opt-in agent harness's own) already fails a key-needing request
  // closed with this exact same named reasoning, completely independent
  // of this startup check — see that spec's own Verified Current State
  // for the direct proof those paths don't depend on this one. This
  // check now only prints the same information earlier, when it's known
  // in advance, rather than gating whether the process starts at all.
  //
  // The Orchestrator's own requirement (added in specs/051 §3, once removing the
  // deterministic fallback made it genuinely true that it's "the only
  // plan-task planner") is added directly here rather than folded into
  // resolveAgentLlmKeyRequirements() — that function is specifically about
  // agent harnesses (`toStart` never contains "orchestrator", a separate
  // ServiceDef started via the `startOrchestrator` flag below, not through
  // `toStart`), and keeping the two composed here rather than merged
  // keeps each one's own tests about exactly one concern.
  //
  // Scope note, stated rather than silently assumed: this check runs at
  // the SUPERVISOR level (`orchestrai`/`bun run orchestrai`), the same
  // boundary port preflight and health checks already live at. It does
  // not reach `bun run dev` or a bare `bun run <service>` invocation
  // (including a bare `orchestrator`), which remain exactly as permissive
  // as they always were — `runOrchestratorSupervisor()`'s own fail-closed
  // branch is what protects that path instead, per-request rather than at
  // startup.
  const llmKeyRequirements = resolveAgentLlmKeyRequirements(
    toStart.map((s) => s.name),
    process.env,
  )
  if (startOrchestrator) {
    llmKeyRequirements.push({ component: "orchestrator", reason: "the only plan-task planner" })
  }

  if (llmKeyRequirements.length > 0) {
    const { missing, misconfigured } = checkStartupLlmKeys(process.env, llmKeyRequirements)
    if (missing.length > 0 || misconfigured.length > 0) {
      // specs/064 — warns, does not exit. Every deterministic, keyword-
      // routed skill needs no key at all and will work fine; only an
      // actual plan-task/ask/opt-in-harness request will hit this,
      // already fails that one request closed on its own, unrelated to
      // whether this warning was ever printed.
      console.warn("[supervisor] LLM configuration is incomplete — starting anyway, since not every feature needs a key:")
      for (const { component, reason } of missing) {
        console.warn(`  - ${component}: no provider key configured (${reason})`)
      }
      for (const { component, reason, error } of misconfigured) {
        console.warn(`  - ${component}: ${error} (${reason})`)
      }
      console.warn("[supervisor] Run \"orchestrai init\" to configure a provider and key, or set the")
      console.warn("[supervisor] ORCHESTRAI_LLM_* / ORCHESTRAI_<COMPONENT>_LLM_* variables directly.")
      console.warn("[supervisor] A request that actually needs one of the above will fail closed with a named")
      // specs/138 — the file templates and fixed test commands are gone, so
      // these skills have nothing to fall back to without a key.
      console.warn("[supervisor] error at that point. Without a key there is no fallback for: DevOps file skills")
      console.warn("[supervisor] (Dockerfile/CI/compose/.gitignore), Documentation, Testing's test runs, Code Review")
      console.warn("[supervisor] and Coder. Read-only skills (git status/diff, analysis, security scans) are unaffected.")
    }
  }

  const portsToCheck = startOrchestrator ? [...toStart, ORCHESTRATOR] : toStart
  for (const svc of portsToCheck) {
    const result = await isPortFree(svc.port)
    if (!result.free) {
      // specs/045 — a timeout is a real, distinct outcome from a genuine
      // conflict, so it's named rather than folded into the same generic
      // message. Both still refuse to start, unchanged — the message is
      // the only thing that differs.
      const cause = result.reason === "timeout"
        ? "timed out checking whether it's free (a recently-freed port can briefly do this)"
        : "is already in use"
      console.error(`[supervisor] Port ${svc.port} (${svc.name}) ${cause} — refusing to start anything.`)
      console.error(`[supervisor] Find and stop whatever's using it, then retry.`)
      process.exit(1)
    }
  }

  if (toStart.length === 0 && !startOrchestrator) {
    console.error("[supervisor] Nothing to start — check your --only value.")
    process.exit(1)
  }

  console.log(`[supervisor] Starting: ${toStart.map((s) => s.name).join(", ")}${startOrchestrator ? " (then orchestrator once ready)" : ""}`)
  for (const svc of toStart) spawnService(svc)

  const results: { name: string; port: number; healthy: boolean }[] = []
  if (toStart.length > 0) {
    console.log("[supervisor] Waiting for services to report healthy...")
    const outcomes = await Promise.all(
      toStart.map(async (svc) => ({ name: svc.name, port: svc.port, healthy: await waitForHealthy(svc.port, HEALTH_TIMEOUT_MS) })),
    )
    results.push(...outcomes)
  }

  if (startOrchestrator) {
    spawnService(ORCHESTRATOR)
    const healthy = await waitForHealthy(ORCHESTRATOR.port, HEALTH_TIMEOUT_MS)
    results.push({ name: ORCHESTRATOR.name, port: ORCHESTRATOR.port, healthy })
  }

  console.log("\n[supervisor] === Startup summary ===")
  for (const r of results) {
    const mark = r.healthy ? "✓" : "✗ (not healthy within timeout)"
    console.log(`  ${mark}  ${r.name.padEnd(20)} http://localhost:${r.port}/dashboard`)
  }
  console.log("[supervisor] =======================\n")

  const anyUnhealthy = results.some((r) => !r.healthy)
  if (anyUnhealthy) {
    console.log("[supervisor] One or more services did not report healthy in time — they may still be starting, or something's wrong. Check the logs above.")
  }

  process.on("SIGINT", () => {
    shutdown().then(() => process.exit(0))
  })
  process.on("SIGTERM", () => {
    shutdown().then(() => process.exit(0))
  })
  // specs/067 — a Windows console close is surfaced to a Node/Bun
  // process as SIGHUP by the common terminal hosts (Windows Terminal,
  // conhost); Ctrl+Break is SIGBREAK. Handle both the same graceful way,
  // so shutdown() gets to run before the process dies rather than
  // leaving only the synchronous exit backstop.
  process.on("SIGHUP", () => {
    shutdown().then(() => process.exit(0))
  })
  process.on("SIGBREAK", () => {
    shutdown().then(() => process.exit(0))
  })
  // specs/067 — the backstop for every exit path a signal handler
  // doesn't catch (an uncaught throw, a kill -9 of the supervisor, a
  // console close the host didn't map to SIGHUP). Registered once, here,
  // after the children exist to be swept.
  // specs/074-fix-exit-backstop-argument-bug/spec.md — registered as
  // runExitBackstop, not killAllChildrenSync itself; see that function's
  // own comment for why passing killAllChildrenSync directly crashed on
  // every exit since specs/067 introduced it.
  process.on("exit", runExitBackstop)

  if (shouldOpenTui) {
    // specs/066-supervisor-log-suppression-during-tui/spec.md — engaged
    // only here, right before the TUI takes the screen, so there's no
    // window where a line could still hit the console after it has.
    // Written under the resolved target project (matching where
    // `orchestrai init` already writes .orchestrai/config.env), falling
    // back to cwd when nothing resolved — same fallback `main()`'s own
    // "No project path resolved" branch above already accepts.
    const logDir = path.join(resolvedProject?.path ?? process.cwd(), ".orchestrai")
    try {
      mkdirSync(logDir, { recursive: true })
      supervisorLogPath = path.join(logDir, "supervisor.log")
      writeFileSync(supervisorLogPath, "") // fresh file each run
    } catch {
      // Couldn't create the log dir/file — fall back to not suppressing
      // rather than silently discarding every backend log line; a
      // corrupted-but-informative screen beats a clean-but-silent one.
      supervisorLogPath = null
    }
    console.log("[supervisor] Opening terminal viewer... (Ctrl+C exits the viewer; press it again to stop the backend services)")
    if (supervisorLogPath) {
      console.log(`[supervisor] Backend service logs from here on go to ${supervisorLogPath} instead of this screen.`)
      childLogsSuppressed = true
    }
    // specs/062-guided-init-tui-as-child-process/spec.md — spawned as its
    // own process, not imported and called in-process. Calling tui's own
    // start() directly here used to create a SECOND CliRenderer/React root
    // in this same process whenever guided-init's setup form (specs/048)
    // had already created and destroyed one for itself — an upstream
    // @opentui/react limitation, not a bug in either surface's own logic,
    // that crashed the entire app (backend included) about a second after
    // every service reported healthy. A fresh child process always has
    // zero prior renderers, so it can't hit that limitation at all.
    // Reuses the exact `orchestrai tui` entry point dispatch() already
    // exposes — same resolved-command shape resolveSpawnCommand() already
    // uses for every other self-spawned service, just with inherited
    // stdio (the TUI needs the real keyboard/screen, not a piped/prefixed
    // log line) and not added to `children` (it's a foreground,
    // terminal-owning process the user already controls directly via its
    // own quit key, not a background service for shutdown() to sweep).
    const tuiCommand = isCompiled
      ? [process.execPath, "tui"]
      : [process.execPath, "run", path.join(REPO_ROOT, "apps/tui/index.tsx")]
    const tuiProc = Bun.spawn(tuiCommand, {
      cwd: isCompiled ? undefined : REPO_ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    })
    // Blocks until the user quits the viewer — correct here, unlike the
    // old in-process call: the existing SIGINT handler above still does
    // the real backend cleanup once the user presses Ctrl+C again (or
    // this awaited exit falls through to the same "stay alive while
    // children run" wait below).
    await tuiProc.exited
  }

  // Keep the supervisor alive as long as any child is running (also
  // covers the shouldOpenTui case above — the TUI's own renderer/keyboard
  // listener keeps the event loop busy independently of this await).
  await Promise.all(children.map((c) => c.proc.exited))
}

// Subcommand dispatch, checked before falling through to the full
// supervisor logic above. `service <name>` is what a compiled binary
// self-spawns as (see resolveSpawnCommand()); it's also directly useful
// for manual debugging in dev mode, same as `bun run <service-script>`.
async function dispatch(): Promise<void> {
  const [subcommand, arg] = process.argv.slice(2)

  if (subcommand === "service") {
    const starter = arg ? SERVICE_STARTERS[arg] : undefined
    if (!starter) {
      console.error(`Unknown service: ${arg ?? "(none given)"}`)
      console.error(`Valid names: ${Object.keys(SERVICE_STARTERS).join(", ")}`)
      process.exit(1)
    }
    await starter()
    return
  }

  if (subcommand === "tui") {
    await (await import("../tui/index")).start()
    return
  }

  // specs/031-interactive-init-wizard/spec.md, extended by
  // specs/048-guided-init-experience/spec.md §4 (routing + launch handoff).
  if (subcommand === "init" || subcommand === "i") {
    // specs/049-guided-init-web-setup/spec.md §5 — scan every token after
    // "init"/"i", not just the next positional one: this dispatcher's own
    // `[subcommand, arg]` destructuring only ever sees a single following
    // token, which would silently miss "--web --classic" entirely.
    const initFlags = process.argv.slice(3)
    const wantsWeb = initFlags.includes("--web")
    const wantsClassic = initFlags.includes("--classic")
    if (wantsWeb && wantsClassic) {
      console.error('"orchestrai init" cannot take both --web and --classic — choose one.')
      process.exit(1)
    }

    // specs/034-init-wizard-services-ux/spec.md: the wizard only ever
    // offers the 5 real agents as choices — mcp:http/orchestrator are
    // implied, not choosable (see init-wizard.ts).
    const allServiceNames = AGENTS.map((a) => a.name)

    // --classic or a non-TTY stdin (piped/redirected input — the exact
    // signal init-wizard.ts's own promptLine() already keys its non-raw-
    // mode fallback on) always gets the unchanged classic prompt wizard:
    // the new full-screen form needs real raw-mode keyboard input a
    // non-TTY stdin structurally cannot provide. --web is checked first —
    // it needs no TTY at all (the browser does the interacting), so a
    // headless/piped invocation of --web must still open the web form,
    // never silently fall back to the classic prompt wizard.
    // specs/122 — every branch now only ever resolves "saved" or
    // "cancelled" (InitOutcome's "started" variant is gone); `init` never
    // launches anything itself any more. It used to chdir into the target
    // and chain straight into main() in this same process — a same-session
    // hand-off that was never confirmed working on a real terminal
    // (specs/048/062/066 all stayed at verification: partial) and was
    // reproduced live as a genuine crash/hang (parent process dies,
    // backend children orphaned, terminal unresponsive) rather than
    // repaired. Each surface below already prints its own "Run
    // `orchestrai` (no flags)..." follow-up instruction.
    const useClassic = !wantsWeb && (wantsClassic || !process.stdin.isTTY)
    if (wantsWeb) {
      await (await import("./init-web")).runInitWebAndWrite(process.cwd())
    } else if (useClassic) {
      await runInitWizard(process.cwd(), allServiceNames)
    } else {
      // Dynamic import, matching the "tui" subcommand's own pattern
      // just above — keeps @opentui/react out of every other code
      // path's module graph until this one specific branch runs.
      const { runInitFormAndWrite, setDirExistsChecker } = await import("./init-form")
      setDirExistsChecker((p) => existsSync(p) && statSync(p).isDirectory())
      await runInitFormAndWrite(process.cwd())
    }
    return
  }

  await main()
}

if (import.meta.main) {
  dispatch().catch((err) => {
    console.error("[supervisor] Fatal error:", err)
    process.exit(1)
  })
}
