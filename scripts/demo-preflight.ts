// specs/131 — `bun run demo:preflight`: a read-only, one-line-per-check
// report of everything that has broken a live demo before (wrong folder,
// a missing or rate-limited key, busy ports, a small terminal, a fixture
// at the wrong ref). It never kills a process, never changes a file, and
// never prints a key: every line passes through redact() first.
import { execFile } from "node:child_process"
import { createServer } from "node:net"
import { promisify } from "node:util"
import { HumanMessage } from "@langchain/core/messages"
import { configPaths, readExistingWizardConfig } from "../apps/supervisor/init-wizard"
import { buildChatModel, classifyProviderError, readLlmModelConfig } from "../packages/shared/llm-model-factory"
import { OrchestraiMcpClient } from "../packages/shared/mcp-client"
import { DEFAULT_SERVICE_PORTS, resolveServicePort, type ServicePortName } from "../packages/shared/service-ports"

const execFileAsync = promisify(execFile)

export type CheckLevel = "PASS" | "WARN" | "FAIL"
export interface CheckResult { name: string; level: CheckLevel; detail: string }

export interface PreflightOptions { live: boolean; baseline?: string; skipKey: boolean; help: boolean }

export function parsePreflightArgs(argv: string[]): PreflightOptions {
  const options: PreflightOptions = { live: false, skipKey: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--live") options.live = true
    else if (arg === "--skip-key") options.skipKey = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else if (arg === "--baseline") {
      const value = argv[++i]
      if (!value) throw new Error("--baseline requires a git ref")
      options.baseline = value
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

/** Replaces every secret value (anything ≥ 8 chars) with a fixed marker. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]")
  }
  return out
}

/** Config: the wizard-written file in the folder the demo runs from. */
export function checkConfig(envPath: string, env: Record<string, string> | null): CheckResult {
  const name = "Config"
  if (!env) return { name, level: "FAIL", detail: `no ${envPath} — run from the project folder, or run \`orchestrai init\` there` }
  let config
  try {
    config = readLlmModelConfig(env)
  } catch (err) {
    return { name, level: "FAIL", detail: err instanceof Error ? err.message : String(err) }
  }
  if (!config) return { name, level: "FAIL", detail: `${envPath} has no API key (ORCHESTRAI_LLM_API_KEY)` }
  return { name, level: "PASS", detail: `provider ${config.provider}, model ${config.model}, key present` }
}

/** Key live: an auth failure is fatal; a rate limit or outage is a warning. */
export function classifyKeyFailure(err: unknown): CheckResult {
  const e = err as { status?: number; statusCode?: number; message?: string } | undefined
  const status = e?.status ?? e?.statusCode
  const message = (e?.message ?? String(err)).split("\n")[0]!.slice(0, 200)
  if (status === 401 || status === 403 || (status !== 429 && /auth|api key|unauthori[sz]ed|permission/i.test(message))) {
    return { name: "Key live", level: "FAIL", detail: `rejected by the provider: ${message}` }
  }
  if (status === 429 || /quota|rate limit|resource exhausted/i.test(message) || classifyProviderError(err) === "transient") {
    return { name: "Key live", level: "WARN", detail: `provider busy or rate-limited: ${message}` }
  }
  return { name: "Key live", level: "FAIL", detail: message }
}

export function checkTerminal(columns: number | undefined, rows: number | undefined): CheckResult {
  const name = "Terminal"
  if (!columns || !rows) return { name, level: "WARN", detail: "not a terminal — run this in the terminal you'll demo from" }
  const size = `${columns}×${rows}`
  if (columns >= 110 && rows >= 30) return { name, level: "PASS", detail: `${size} (both rails visible)` }
  if (columns >= 80 && rows >= 24) return { name, level: "WARN", detail: `${size} — side rails hidden below 110×30` }
  return { name, level: "FAIL", detail: `${size} — the TUI needs at least 80×24` }
}

export interface PortState { service: ServicePortName; port: number; free: boolean; healthy: boolean }

export function checkPorts(states: PortState[]): CheckResult {
  const name = "Ports"
  const busy = states.filter((s) => !s.free)
  if (busy.length === 0) return { name, level: "PASS", detail: `all ${states.length} free` }
  const unhealthy = busy.filter((s) => !s.healthy)
  if (unhealthy.length === 0) return { name, level: "PASS", detail: `stack already up and healthy on ${busy.map((s) => s.port).join(", ")}` }
  return { name, level: "FAIL", detail: `busy with no healthy service: ${unhealthy.map((s) => `${s.service}:${s.port}`).join(", ")} — stop the stale process` }
}

export function checkOptIns(env: Record<string, string | undefined>): CheckResult {
  const precheck = env.ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK === "1" ? "on" : "off"
  const osv = env.ORCHESTRAI_SECURITY_EXTERNAL_DATA === "1" ? "on" : "off"
  return { name: "Opt-ins", level: "PASS", detail: `Security pre-check ${precheck}, OSV external data ${osv}` }
}

export function checkBaseline(ref: string | undefined, head: string | null, refSha: string | null, dirty: boolean): CheckResult {
  const name = "Fixture"
  if (!ref) return { name, level: "PASS", detail: "no --baseline given (skipped)" }
  if (head === null) return { name, level: "WARN", detail: "project is not a git repo — can't confirm the baseline" }
  if (refSha === null) return { name, level: "WARN", detail: `ref "${ref}" not found` }
  if (head !== refSha) return { name, level: "WARN", detail: `HEAD ${head.slice(0, 8)} is not ${ref} (${refSha.slice(0, 8)})` }
  if (dirty) return { name, level: "WARN", detail: `at ${ref}, but the working tree has changes` }
  return { name, level: "PASS", detail: `clean at ${ref}` }
}

export function exitCodeFor(results: CheckResult[]): number {
  return results.some((r) => r.level === "FAIL") ? 1 : 0
}

// ---- side-effecting probes (read-only) ----

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => server.close(() => resolve(true)))
    server.listen(port, "127.0.0.1")
  })
}

async function fetchOk(url: string, ms = 3_000): Promise<Response | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) })
    return res.ok ? res : null
  } catch {
    return null
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout.trim()
  } catch {
    return null
  }
}

async function strayProcesses(): Promise<string[]> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true })
      return stdout.split(/\r?\n/)
        .map((line) => line.split('","').map((c) => c.replace(/"/g, "")))
        .filter(([image, pid]) => /^(bun|orchestrai)\.exe$/i.test(image ?? "") && Number(pid) !== process.pid)
        .map(([image, pid]) => `${image}:${pid}`)
    }
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,comm="])
    return stdout.split("\n").map((l) => l.trim().split(/\s+/))
      .filter(([pid, comm]) => /(^|\/)(bun|orchestrai)$/.test(comm ?? "") && Number(pid) !== process.pid)
      .map(([pid, comm]) => `${comm}:${pid}`)
  } catch {
    return []
  }
}

async function liveChecks(env: Record<string, string | undefined>, projectRoot: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const services = Object.keys(DEFAULT_SERVICE_PORTS) as ServicePortName[]
  const down: string[] = []
  for (const service of services) {
    if (!(await fetchOk(`http://127.0.0.1:${resolveServicePort(service, env)}/healthz`))) down.push(service)
  }
  results.push(down.length === 0
    ? { name: "Health", level: "PASS", detail: `all ${services.length} /healthz OK` }
    : { name: "Health", level: down.length === services.length ? "FAIL" : "WARN", detail: `not answering: ${down.join(", ")}` })

  const orch = `http://127.0.0.1:${resolveServicePort("orchestrator", env)}`
  const health = await fetchOk(`${orch}/healthz`)
  const body = health ? await health.json().catch(() => null) as { capabilities?: { ok?: boolean; error?: string } } | null : null
  results.push(body?.capabilities?.ok
    ? { name: "Capabilities", level: "PASS", detail: "routing snapshot OK" }
    : { name: "Capabilities", level: "FAIL", detail: body?.capabilities?.error ?? "Orchestrator /healthz has no capabilities.ok" })

  results.push(await checkStateSnapshot(`${orch}/events`))

  const mcp = new OrchestraiMcpClient({
    callerName: "demo-preflight",
    requiredTools: ["read_project_file"],
    url: `http://127.0.0.1:${resolveServicePort("mcpHttp", env)}/mcp`,
  })
  try {
    mcp.start()
    await mcp.callTool("read_project_file", { project_root: projectRoot, relative_path: ".orchestrai/config.env" }, "demo-preflight", 5_000)
    results.push({ name: "State-dir guard", level: "FAIL", detail: "read_project_file returned .orchestrai/config.env — the specs/129 guard is not active" })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    results.push(/\.orchestrai|denied|not allowed|refus/i.test(message)
      ? { name: "State-dir guard", level: "PASS", detail: "reading .orchestrai/config.env is denied" }
      : { name: "State-dir guard", level: "WARN", detail: `could not confirm: ${message.slice(0, 160)}` })
  } finally {
    await mcp.stop().catch(() => {})
  }
  return results
}

async function checkStateSnapshot(url: string): Promise<CheckResult> {
  const name = "AG-UI stream"
  try {
    const res = await fetch(url, { headers: { Accept: "text/event-stream" }, signal: AbortSignal.timeout(5_000) })
    if (!res.ok || !res.body) return { name, level: "FAIL", detail: `/events HTTP ${res.status}` }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let seen = ""
    try {
      while (seen.length < 1_000_000) {
        const { done, value } = await reader.read()
        if (done) break
        seen += decoder.decode(value, { stream: true })
        if (seen.includes("STATE_SNAPSHOT")) return { name, level: "PASS", detail: "/events delivered STATE_SNAPSHOT" }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return { name, level: "FAIL", detail: "/events closed without a STATE_SNAPSHOT" }
  } catch (err) {
    return { name, level: "FAIL", detail: `/events: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function usage(): string {
  return [
    "Usage: bun run demo:preflight [--live] [--baseline <git ref>] [--skip-key]",
    "  Run from the folder you'll demo in (the one holding .orchestrai/config.env).",
    "  --live         also check a running stack (/healthz, capabilities, /events, state-dir guard)",
    "  --baseline     confirm the project is a clean git checkout at this ref",
    "  --skip-key     don't make the one small provider call that checks the key",
  ].join("\n")
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parsePreflightArgs(argv)
  if (options.help) {
    console.log(usage())
    return 0
  }
  const cwd = process.cwd()
  const { envPath } = configPaths(cwd)
  const existing = readExistingWizardConfig(cwd)
  const fileEnv = Object.keys(existing.env).length > 0 ? existing.env : null
  // The file wins for LLM settings, the way the supervisor merges it; the
  // shell environment fills anything the file doesn't set (ports, opt-ins).
  const env: Record<string, string | undefined> = { ...process.env, ...(fileEnv ?? {}) }
  const projectRoot = existing.projectPath ?? cwd
  const secrets = Object.entries(env).filter(([k]) => /API_KEY|TOKEN|SECRET/i.test(k)).map(([, v]) => v)

  const results: CheckResult[] = []
  results.push(checkConfig(envPath, fileEnv))

  if (options.skipKey) results.push({ name: "Key live", level: "WARN", detail: "skipped (--skip-key)" })
  else if (results[0]!.level !== "PASS") results.push({ name: "Key live", level: "FAIL", detail: "no usable config to test" })
  else {
    try {
      const model = await buildChatModel(readLlmModelConfig(env)!)
      await model.invoke([new HumanMessage("Reply with the single word: ok")], { signal: AbortSignal.timeout(30_000) })
      results.push({ name: "Key live", level: "PASS", detail: "one minimal provider call succeeded" })
    } catch (err) {
      results.push(classifyKeyFailure(err))
    }
  }

  const services = Object.keys(DEFAULT_SERVICE_PORTS) as ServicePortName[]
  const states: PortState[] = []
  for (const service of services) {
    const port = resolveServicePort(service, env)
    const free = await portIsFree(port)
    states.push({ service, port, free, healthy: free ? false : Boolean(await fetchOk(`http://127.0.0.1:${port}/healthz`)) })
  }
  const ports = checkPorts(states)
  results.push(ports)
  const stray = await strayProcesses()
  results.push(stray.length === 0
    ? { name: "Processes", level: "PASS", detail: "no other bun/orchestrai processes" }
    : { name: "Processes", level: ports.level === "FAIL" ? "WARN" : "PASS", detail: `other bun/orchestrai processes: ${stray.join(", ")}` })

  results.push(checkTerminal(process.stdout.columns, process.stdout.rows))

  const head = await git(projectRoot, ["rev-parse", "HEAD"])
  const refSha = options.baseline && head !== null ? await git(projectRoot, ["rev-parse", "--verify", `${options.baseline}^{commit}`]) : null
  const dirty = head !== null && ((await git(projectRoot, ["status", "--porcelain"])) ?? "") !== ""
  results.push(checkBaseline(options.baseline, head, refSha, dirty))
  results.push(checkOptIns(env))

  if (options.live) results.push(...await liveChecks(env, projectRoot))

  console.log(redact(`Demo preflight — ${cwd}`, secrets))
  for (const r of results) console.log(redact(`${r.level.padEnd(4)}  ${r.name.padEnd(16)} ${r.detail}`, secrets))
  const code = exitCodeFor(results)
  console.log(code === 0 ? "Ready." : "Not ready — fix the FAIL lines above.")
  return code
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  })
}
