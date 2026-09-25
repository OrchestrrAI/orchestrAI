import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { writeFile, mkdir, readdir, readFile, stat, realpath } from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import { execFile as execFileCb } from "child_process"
import { promisify as promisifyFn } from "util"
import { buildSanitizedTestEnv } from "../shared/test-runner"
import { lintWorkflowStructure } from "../shared/devops-file-validation"
import { detectEcosystem, type Ecosystem } from "../shared/detect-ecosystem"

const execFileAsync = promisifyFn(execFileCb)

// ============================================================
// PROJECT-FILE PATH CONTAINMENT (specs/011-remaining-agents-mcp/spec.md)
// ============================================================
// The single highest-risk piece of new code in this checkpoint — a new
// generic file-access primitive, not a narrow single-purpose tool. Every
// path is canonicalized and checked against the project root twice: once
// syntactically (before touching the filesystem) and once via realpath (to
// catch a symlink inside the root pointing outside it).

const SENSITIVE_FILENAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /\.pfx$/i,
  /\.p12$/i,
]

// specs/123-safe-env-template-filename-exemption/spec.md — an exact
// basename allow-list, never a loosened regex: these four names are the
// well-known, git-committable, placeholder-only convention (the entire
// point of the convention is that they're safe to share, unlike `.env`
// itself), so they're checked BEFORE the broad `.env` pattern above. A
// decoy like `.env.example.local` is not literally one of these four
// names, so it still falls through to (and is caught by) the pattern
// above, unchanged.
const SAFE_ENV_TEMPLATE_FILENAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
])

function isSensitiveFilename(name: string): boolean {
  if (SAFE_ENV_TEMPLATE_FILENAMES.has(name.toLowerCase())) return false
  return SENSITIVE_FILENAME_PATTERNS.some((re) => re.test(name))
}

// specs/129 — OrchestrAI's own per-project state (config.env with the
// provider API key, supervisor.log, orchestrai.db) lives in the target
// project. A basename check can't protect it (config.env matches nothing
// above), so any path through this directory is denied outright.
export const ORCHESTRAI_STATE_DIR = ".orchestrai"

export function isInOrchestraiStateDir(absolutePath: string, root: string): boolean {
  const relative = path.relative(root, absolutePath)
  return relative.split(/[\\/]+/).some((segment) => segment.toLowerCase() === ORCHESTRAI_STATE_DIR)
}

class PathContainmentError extends Error {}

async function containPath(projectRoot: string, relativePath: string): Promise<string> {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new PathContainmentError("project_root must be an absolute path")
  }
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new PathContainmentError("relative_path must be a non-empty string")
  }
  if (relativePath.includes("\0")) {
    throw new PathContainmentError("relative_path must not contain a null byte")
  }
  if (path.isAbsolute(relativePath)) {
    throw new PathContainmentError("relative_path must not be an absolute path")
  }

  const root = path.resolve(projectRoot)
  const resolved = path.resolve(root, relativePath)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new PathContainmentError("relative_path escapes project_root")
  }

  // Symlink-escape check via realpath, walking up to the nearest existing
  // ancestor (the target itself may not exist yet, e.g. a write target).
  let checkTarget = resolved
  while (!existsSync(checkTarget)) {
    const parent = path.dirname(checkTarget)
    if (parent === checkTarget) break
    checkTarget = parent
  }
  const stateDirDenied = `OrchestrAI's own state directory is denied: ${ORCHESTRAI_STATE_DIR}`
  if (isInOrchestraiStateDir(resolved, root)) throw new PathContainmentError(stateDirDenied)

  if (existsSync(checkTarget) && existsSync(root)) {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(checkTarget)])
    const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
    if (realTarget !== realRoot && !realTarget.startsWith(realRootWithSep)) {
      throw new PathContainmentError("relative_path escapes project_root (symlink)")
    }
    // specs/129 — an in-root symlink pointing into the state dir.
    if (isInOrchestraiStateDir(realTarget, realRoot)) throw new PathContainmentError(stateDirDenied)
  }

  const baseName = path.basename(resolved)
  if (isSensitiveFilename(baseName)) {
    throw new PathContainmentError(`sensitive file denied: ${baseName}`)
  }

  return resolved
}

// ============================================================
// specs/080-run-command-approved-execution/spec.md — run_command's own
// defense-in-depth checks. Neither is the safety mechanism (the calling
// agent's own actionId-bound human approval is) — both exist only to
// catch an unmistakable case even if an approval were somehow rushed
// through without reading it closely.
// ============================================================

// A deliberately small, hand-written list of unambiguously destructive
// patterns — never an attempt at a general "is this command safe"
// classifier, which doesn't exist and isn't the point. Matched against
// the joined argv purely as a regex scan, never passed to a shell.
const RUN_COMMAND_DENYLIST: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\b[^\n]*-[a-z]*r[a-z]*f[a-z]*\s+\/(\s|$)/i, reason: "recursive force-delete rooted at \"/\"" },
  { pattern: /\bformat\b/i, reason: "disk format command" },
  { pattern: /\bmkfs\b/i, reason: "filesystem creation (wipes a device)" },
  { pattern: /\bdd\b[^\n]*\bif=/i, reason: "raw disk copy (dd if=...)" },
  { pattern: /\b(shutdown|reboot|halt)\b/i, reason: "system shutdown/reboot command" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb pattern" },
  // specs/129 — OrchestrAI's own state dir (holds the provider API key).
  { pattern: /(^|[\s\\/"'=])\.orchestrai([\\/"'\s]|$)/i, reason: "access to OrchestrAI's own .orchestrai state directory (holds the provider API key)" },
]

function checkRunCommandDenylist(argv: string[]): string | null {
  const joined = argv.join(" ")
  for (const { pattern, reason } of RUN_COMMAND_DENYLIST) {
    if (pattern.test(joined)) return reason
  }
  return null
}

// A plain synchronous syntactic containment check — deliberately lighter
// than containPath()'s own realpath/symlink-escape verification (used
// for file read/write targets, a higher-stakes surface): here it's a
// second layer behind the real safety mechanism (human approval of the
// exact argv, which already shows the real cwd), not the sole guard
// against an adversarial path.
function isPathContainedSync(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(rootWithSep)
}

// ============================================================
// SECURITY — Command allowlist (critical for demo safety)
// ============================================================
// specs/079-phase-a-connect-orphaned-tools/spec.md §7 — each entry is a
// real token sequence, checked token-by-token against the real argv,
// never a string prefix. The old string-prefix check
// (`cmd.startsWith(p)`) was also subtly wrong on its own terms: e.g.
// "git statusFOO".startsWith("git status") is true even though the
// second real token isn't "status" — a false-positive the array form
// can't produce, since it compares whole tokens.
const ALLOWED_PREFIXES: string[][] = [
  ["git", "status"], ["git", "log"], ["git", "diff"], ["git", "branch"],
  ["git", "add"], ["git", "commit"], ["git", "show"],
  ["docker", "ps"], ["docker", "images"], ["docker", "stats"],
  ["docker", "build"], ["docker", "inspect"], ["docker", "run"], ["docker", "stop"],
  ["bun", "test"], ["bun", "run"], ["bun", "install"],
  ["ls"], ["cat"], ["pwd"], ["echo"],
]

// specs/079-phase-a-connect-orphaned-tools/spec.md §7 — takes a real argv
// array, never a command string to be re-split. The previous shape
// (`safeExec(cmd: string, cwd?)`) built its own command as a template
// string and then re-split it on whitespace before exec — safe from
// shell injection (execFile, shell:false — no shell ever parses the
// string) but genuinely wrong for any argument containing a space
// (a Windows path, or — the more serious case, live-caught while
// grounding this spec — a multi-word git commit message: the old
// `git commit -m "${message}"` was wrapped in shell-style quotes that
// then got torn apart by the SAME whitespace split, so a message like
// "fix bug" arrived as the two broken tokens `"fix` and `bug"`,
// quote characters included, never a working multi-word commit).
// specs/079-phase-a-connect-orphaned-tools/spec.md's own `docker_build`
// call was found, live, to genuinely time out here: a real `docker
// build` pulling a base image for the first time plus a real
// `bun install` routinely exceeds the original hardcoded 15s — the
// exact class of client/server timeout mismatch specs/076/080 already
// fixed for run_tests/run_command, just not yet applied to this
// call site. `timeoutMs` is optional and defaults to the original
// 15000, so every other existing call site (git status/diff/commit,
// docker_status, docker_run) is byte-identical.
async function safeExec(argv: string[], cwd?: string, timeoutMs: number = 15000): Promise<string> {
  const allowed = ALLOWED_PREFIXES.some((prefix) => prefix.every((token, i) => argv[i] === token))
  if (!allowed) throw new Error(`Blocked command: "${argv.join(" ")}"`)
  const [bin, ...args] = argv
  try {
    const { stdout, stderr } = await execFileAsync(bin!, args, {
      cwd: cwd ?? process.cwd(),
      timeout: timeoutMs,
      shell: false,
    })
    return (stdout + stderr).trim()
  } catch (err: any) {
    return err.stderr?.trim() || err.message || "Command failed"
  }
}

// specs/143 — safeExec() above returns a failure's text as if it were
// normal output, which is right for the read-only status calls but made a
// failed docker build/run or git commit look like success (the task ended
// "completed" and the recap claimed it worked). execOrFail() has the same
// allow-list and no-shell boundary but THROWS on a non-zero exit, with the
// full output plus "[exit code N]" (the specs/138 run_command shape).
export async function execOrFail(argv: string[], cwd?: string, timeoutMs: number = 15000): Promise<string> {
  const allowed = ALLOWED_PREFIXES.some((prefix) => prefix.every((token, i) => argv[i] === token))
  if (!allowed) throw new Error(`Blocked command: "${argv.join(" ")}"`)
  const [bin, ...args] = argv
  try {
    const { stdout, stderr } = await execFileAsync(bin!, args, {
      cwd: cwd ?? process.cwd(),
      timeout: timeoutMs,
      shell: false,
    })
    return (stdout + stderr).trim()
  } catch (err: any) {
    if (err.killed) throw new Error(`Command timed out after ${timeoutMs}ms: ${argv.join(" ")}`)
    const output = [err.stdout, err.stderr].map((part: unknown) => (part === undefined || part === null ? "" : String(part))).join("\n").trim()
    const code = typeof err.code === "number" ? err.code : "?"
    throw new Error(`${output || err.message || "Command failed"}\n[exit code ${code}]`)
  }
}

/** Runs an executing tool's command and turns a failure into an MCP error
 *  result, so the calling agent fails its task instead of completing it. */
async function execToolResult(argv: string[], cwd?: string, timeoutMs?: number) {
  try {
    return { content: [{ type: "text" as const, text: await execOrFail(argv, cwd, timeoutMs) }] }
  } catch (err) {
    return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
}

// ============================================================
// HELPERS
// ============================================================
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
  return (bytes / 1024 / 1024).toFixed(1) + " MB"
}

// ============================================================
// MCP SERVER
// ============================================================
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "orchestrai-devops",
    version: "2.2.0",
  })

// ============================================================
// CATEGORY 1: GIT TOOLS
// ============================================================

server.tool(
  "git_status",
  "Get full git status of a repository including staged, unstaged, and untracked files",
  {
    repo_path: z.string().optional().describe("Absolute path to the git repo — defaults to current working directory"),
  },
  async ({ repo_path }) => {
    const repoPath = repo_path ?? process.cwd()
    if (!existsSync(repoPath)) {
      return { content: [{ type: "text", text: `Path not found: ${repoPath}` }] }
    }
    if (!existsSync(path.join(repoPath, ".git"))) {
      return { content: [{ type: "text", text: `Not a git repo: ${repoPath}\nRun: git init` }] }
    }
    const [status, branch, log] = await Promise.all([
      safeExec(["git", "status", "--short"], repoPath),
      safeExec(["git", "branch", "--show-current"], repoPath),
      safeExec(["git", "log", "--oneline", "-5"], repoPath),
    ])
    const report = [
      `Branch: ${branch}`,
      `\nStatus:\n${status || "(clean — nothing to commit)"}`,
      `\nLast 5 commits:\n${log}`,
    ].join("\n")
    return { content: [{ type: "text", text: report }] }
  }
)

server.tool(
  "git_diff",
  "Show git diff for staged or unstaged changes",
  {
    repo_path: z.string().optional().describe("Absolute path to the git repo — defaults to current working directory"),
    staged: z.boolean().default(false).describe("Show staged changes (true) or unstaged (false)"),
    file: z.string().optional().describe("Specific file to diff (optional)"),
  },
  async ({ repo_path, staged, file }) => {
    const repoPath = repo_path ?? process.cwd()
    if (!existsSync(repoPath)) {
      return { content: [{ type: "text", text: `Path not found: ${repoPath}` }] }
    }
    if (!existsSync(path.join(repoPath, ".git"))) {
      return { content: [{ type: "text", text: `Not a git repo: ${repoPath}` }] }
    }
    const argv = ["git", "diff"]
    if (staged) argv.push("--cached")
    if (file) argv.push("--", file)
    const diff = await safeExec(argv, repoPath)
    return {
      content: [{ type: "text", text: diff || "No changes found." }]
    }
  }
)

server.tool(
  "git_commit",
  "Stage all changes and create a git commit with a message",
  {
    repo_path: z.string().optional().describe("Absolute path to the git repo — defaults to current working directory"),
    message: z.string().describe("Commit message — be descriptive"),
    files: z.array(z.string()).optional().describe("Specific files to stage (omit for all)"),
  },
  async ({ repo_path, message, files }) => {
    const repoPath = repo_path ?? process.cwd()
    if (!existsSync(repoPath)) {
      return { content: [{ type: "text", text: `Path not found: ${repoPath}` }], isError: true }
    }
    if (!existsSync(path.join(repoPath, ".git"))) {
      return { content: [{ type: "text", text: `Not a git repo: ${repoPath}` }], isError: true }
    }
    const addArgv = files?.length ? ["git", "add", ...files] : ["git", "add", "-A"]
    const added = await execToolResult(addArgv, repoPath)
    if ("isError" in added) return added
    return execToolResult(["git", "commit", "-m", message], repoPath)
  }
)

// ============================================================
// CATEGORY 2: DOCKER TOOLS
// ============================================================

server.tool(
  "docker_status",
  "Get status of all Docker containers and images on the system",
  {},
  async () => {
    const [containers, images] = await Promise.all([
      safeExec(["docker", "ps", "-a"]),
      safeExec(["docker", "images"]),
    ])
    const report = [
      "=== Containers ===",
      containers || "(no containers)",
      "\n=== Images ===",
      images || "(no images)",
    ].join("\n")
    return { content: [{ type: "text", text: report }] }
  }
)

// A real image build genuinely needs headroom beyond a quick status
// check — pulling a base image plus a real dependency install
// routinely exceeds 15s, live-confirmed while closing out this spec's
// own build-image acceptance criterion. Matches the same order of
// magnitude as run_command's own 120s server-side budget.
const DOCKER_BUILD_TIMEOUT_MS = 180_000

server.tool(
  "docker_build",
  "Build a Docker image from a Dockerfile in a given directory",
  {
    context_path: z.string().describe("Path to the directory containing the Dockerfile"),
    image_tag: z.string().describe("Tag for the image e.g. myapp:latest"),
    dockerfile: z.string().default("Dockerfile").describe("Dockerfile name (default: Dockerfile)"),
  },
  async ({ context_path, image_tag, dockerfile }) => {
    if (!existsSync(context_path)) throw new Error(`Context path not found: ${context_path}`)
    return execToolResult(
      ["docker", "build", "-f", dockerfile, "-t", image_tag, "."],
      context_path,
      DOCKER_BUILD_TIMEOUT_MS,
    )
  }
)

// specs/079-phase-a-connect-orphaned-tools/spec.md §5 — starts a built
// image with a FIXED, safe lifecycle policy: always --rm (auto-remove),
// always a bounded observation window, and the only caller-supplied
// values are the image tag and an optional port mapping. Never accepts
// arbitrary `docker run` flags, an entrypoint override, or a volume
// mount — this reports whether the image actually boots, it does not
// stand up a real deployment.
const DOCKER_RUN_OBSERVE_MS = 2000

server.tool(
  "docker_run",
  "Start a built Docker image with a fixed, safe lifecycle policy (--rm auto-remove, a short bounded observation window) and report whether it actually started and stayed running. Never accepts arbitrary docker run flags — only an image tag and an optional port mapping.",
  {
    image_tag: z.string().describe("Image tag to run, e.g. myapp:latest"),
    port: z.number().optional().describe("Host port to map to the same container port, e.g. 3000"),
    container_name: z.string().optional().describe("Name for the container (default: an auto-generated one)"),
  },
  async ({ image_tag, port, container_name }) => {
    const name = container_name ?? `orchestrai-verify-${Date.now()}`
    const runArgv = ["docker", "run", "--rm", "-d", "--name", name]
    if (port) runArgv.push("-p", `${port}:${port}`)
    runArgv.push(image_tag)
    let runResult: string
    try {
      runResult = await execOrFail(runArgv)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text", text: `❌ Container "${name}" could not be started.\n\ndocker run output:\n${reason}` }], isError: true }
    }

    await new Promise((resolve) => setTimeout(resolve, DOCKER_RUN_OBSERVE_MS))

    const statusResult = await safeExec(["docker", "ps", "--filter", `name=${name}`, "--format", "{{.Status}}"])
    const isRunning = statusResult.trim().length > 0

    // Always clean up — --rm only removes the container once it stops,
    // so a still-running one must be explicitly stopped or it would
    // leak past this tool call. Best-effort: a stop failure (already
    // exited, e.g. a crash-looping image) is not itself an error here.
    await safeExec(["docker", "stop", name]).catch(() => undefined)

    const report = [
      isRunning
        ? `✅ Container "${name}" started and was still running after ${DOCKER_RUN_OBSERVE_MS}ms.`
        : `❌ Container "${name}" did not stay running after ${DOCKER_RUN_OBSERVE_MS}ms — it exited or failed to start.`,
      "",
      "docker run output:",
      runResult || "(no output)",
      "",
      "Status check:",
      statusResult || "(container not found — exited or failed to start)",
    ].join("\n")
    // specs/143 — a container that didn't stay up is a failed verification.
    return isRunning ? { content: [{ type: "text", text: report }] } : { content: [{ type: "text", text: report }], isError: true }
  }
)

// specs/079-phase-a-connect-orphaned-tools/spec.md §5 — a deliberately
// minimal, dependency-free structural check (specs/040's own precedent
// for not adding a parsing dependency where a lighter check suffices):
// confirms the file has the two keys a GitHub Actions workflow must
// have and flags tab-indentation (invalid YAML), never a full schema
// validation and never a live Actions run.
server.tool(
  "lint_ci_workflow",
  "Validate a GitHub Actions workflow file's basic structure (has top-level 'on:' and 'jobs:' keys, no tab-indentation). A structural sanity check, not full YAML schema validation, and never runs the workflow.",
  {
    workflow_path: z.string().describe("Absolute path to the workflow YAML file"),
  },
  async ({ workflow_path }) => {
    if (!existsSync(workflow_path)) {
      return { content: [{ type: "text", text: `Path not found: ${workflow_path}` }], isError: true }
    }
    const raw = await readFile(workflow_path, "utf-8")
    // specs/138 — the same rules DevOps applies before a workflow is ever
    // previewed, shared so the two can never drift.
    const issues = lintWorkflowStructure(raw)
    const report = issues.length > 0
      ? `Issues found (${issues.length}):\n${issues.map((i) => `• ${i}`).join("\n")}`
      : "No structural issues found — has 'on:' and 'jobs:' keys, no tabs."
    return { content: [{ type: "text", text: report }] }
  }
)

// specs/079-phase-a-connect-orphaned-tools/spec.md §5 — LOCAL manifest
// data only, no network call of any kind. Deliberately not real
// vulnerability/CVE data — that needs a network-access policy decision
// specs/078's own Phase F hasn't made yet. This only reports what's
// actually declared, which today's audit-dependencies skill (Security
// Agent) doesn't have real installed-version data to work from at all.
server.tool(
  "audit_dependencies_local",
  "Report a project's declared dependency versions from its own package.json — no network call, no vulnerability database, purely local manifest data.",
  {
    project_path: z.string().describe("Absolute path to the project root"),
  },
  async ({ project_path }) => {
    if (!existsSync(project_path)) {
      return { content: [{ type: "text", text: `Path not found: ${project_path}` }], isError: true }
    }
    const pkgPath = path.join(project_path, "package.json")
    if (!existsSync(pkgPath)) {
      return { content: [{ type: "text", text: "No package.json found — nothing to audit." }] }
    }
    let pkg: any
    try {
      pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
    } catch (err: any) {
      return { content: [{ type: "text", text: `package.json is not valid JSON: ${err.message}` }], isError: true }
    }
    const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }
    const entries = Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))
    const report = entries.length > 0
      ? entries.map(([name, version]) => `${name}: ${version}`).join("\n")
      : "(no dependencies declared)"
    return { content: [{ type: "text", text: report }] }
  }
)

// ============================================================
// CATEGORY 3: PROJECT ANALYSIS
// ============================================================
// specs/138 — the four create_* file-template tools that lived here were
// removed: DevOps now authors those files with its model, validates them
// (packages/shared/devops-file-validation.ts) and writes them via
// write_project_file after approval. The run_tests fixed-command tool was
// removed with them; test commands are model-proposed and run via
// run_command.

// specs/099-tui-port-url-and-analyze-project-stack-awareness/spec.md —
// replaces the old fixed hasPackageJson/hasBunLock pair (misleading for
// any non-npm project, and even understated the real npm case — a
// legitimate npm/yarn/pnpm project with no Bun involvement at all
// showed a false ❌). Detects the real ecosystem via the same shared
// detectEcosystem() Security's own audit-dependencies already uses
// (specs/085), then checks one real, ecosystem-appropriate
// manifest/lockfile pair — the real filename named directly in the
// printed line, not just implied by a generic key. Per specs/085's own
// documented findings: PyPI and Maven have no universal lockfile
// concept, so those two report a manifest line only.
function buildEcosystemManifestLines(projectPath: string): string[] {
  const detection = detectEcosystem(projectPath)
  if (!detection) {
    return ["❌ hasManifest (no recognized dependency manifest found — checked package.json, requirements.txt, pyproject.toml, go.mod, composer.json, pom.xml)"]
  }

  const manifestLine = `✅ hasManifest (${detection.manifestFile})`

  const lockfileByEcosystem: Record<Ecosystem, string[] | null> = {
    // Broadened from the old Bun-only check — any of these means the
    // dependency tree is genuinely locked, not just Bun's own.
    npm: ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
    PyPI: null,   // no universal lockfile concept (specs/085)
    Go: ["go.sum"],
    Packagist: ["composer.lock"],
    Maven: null,  // no standard lockfile concept at all (specs/085)
  }

  const candidates = lockfileByEcosystem[detection.ecosystem]
  if (candidates === null) return [manifestLine]

  const foundLockfile = candidates.find((name) => existsSync(path.join(projectPath, name)))
  const lockfileLine = foundLockfile
    ? `✅ hasLockfile (${foundLockfile})`
    : `❌ hasLockfile (checked: ${candidates.join(", ")})`
  return [manifestLine, lockfileLine]
}

server.tool(
  "analyze_project",
  "Analyze a project directory structure and suggest DevOps improvements",
  {
    project_path: z.string().describe("Absolute path to the project root"),
  },
  async ({ project_path }) => {
    if (!existsSync(project_path)) {
      return { content: [{ type: "text", text: `Path not found: ${project_path}` }] }
    }

    const checks = {
      hasDockerfile:    existsSync(path.join(project_path, "Dockerfile")),
      hasDockerCompose: existsSync(path.join(project_path, "docker-compose.yml")),
      hasGitignore:     existsSync(path.join(project_path, ".gitignore")),
      hasEnvExample:    existsSync(path.join(project_path, ".env.example")),
      hasCI:            existsSync(path.join(project_path, ".github", "workflows")),
      hasReadme:        existsSync(path.join(project_path, "README.md")),
    }
    const ecosystemLines = buildEcosystemManifestLines(project_path)

    // Use Node API instead of ls — works on Windows and Unix
    let files: string[] = []
    try {
      const entries = (await readdir(project_path, { withFileTypes: true }))
        .filter(e => e.name.toLowerCase() !== ORCHESTRAI_STATE_DIR) // specs/129
      const fileList = entries.filter(e => e.isFile()).map(e => e.name)
      const dirList  = entries.filter(e => e.isDirectory()).map(e => `${e.name}/`)
      files = [...dirList.sort(), ...fileList.sort()]
    } catch (err: any) {
      files = [`Could not read directory: ${err.message}`]
    }

    // Check if git repo
    const isGitRepo = existsSync(path.join(project_path, ".git"))

    const suggestions: string[] = []
    if (!isGitRepo)           suggestions.push("Not a git repo — run: git init")
    if (!checks.hasDockerfile) suggestions.push("Missing Dockerfile — ask the DevOps agent to dockerize")
    if (!checks.hasCI)         suggestions.push("No CI pipeline — ask the DevOps agent to create-ci")
    if (!checks.hasGitignore)  suggestions.push("No .gitignore — ask the DevOps agent to create-gitignore")
    if (!checks.hasEnvExample) suggestions.push("No .env.example — document your env variables")
    if (!checks.hasReadme)     suggestions.push("No README.md — add project documentation")

    const report = [
      "=== Project Analysis ===",
      `Path: ${project_path}`,
      `Git repo: ${isGitRepo ? "✅ yes" : "❌ no"}`,
      "",
      "=== DevOps Checks ===",
      ...Object.entries(checks).map(([k, v]) => `${v ? "✅" : "❌"} ${k}`),
      ...ecosystemLines,
      "",
      "=== Files & Folders ===",
      files.join("\n"),
      "",
      suggestions.length
        ? `=== Suggestions (${suggestions.length}) ===\n${suggestions.map(s => `• ${s}`).join("\n")}`
        : "=== All DevOps files present ===",
    ].join("\n")

    return { content: [{ type: "text", text: report }] }
  }
)

// ============================================================
// CATEGORY 4: TESTING/DOCUMENTATION AGENT TOOLS (specs/011-remaining-agents-mcp/spec.md)
// ============================================================

server.tool(
  "read_project_file",
  "Read a file's content, or list a directory's entries, within a project root. Path-contained (rejects traversal/absolute/symlink escapes) and denies known sensitive filenames (.env*, key/credential patterns) by default — except the well-known safe template names .env.example/.env.sample/.env.template/.env.dist. Tier 2, read-only.",
  {
    project_root: z.string().describe("Absolute path to the project root"),
    relative_path: z.string().describe("Path relative to project_root — must not be absolute or escape the root"),
  },
  async ({ project_root, relative_path }) => {
    let target: string
    try {
      target = await containPath(project_root, relative_path)
    } catch (err: any) {
      return { content: [{ type: "text", text: `Denied: ${err.message}` }], isError: true }
    }

    if (!existsSync(target)) {
      return { content: [{ type: "text", text: `Path not found: ${relative_path}` }], isError: true }
    }

    const info = await stat(target)
    if (info.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true })
      const listing = entries
        .filter((e) => e.name.toLowerCase() !== ORCHESTRAI_STATE_DIR) // specs/129 — never advertise it
        .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
        .sort()
        .join("\n")
      return { content: [{ type: "text", text: listing || "(empty directory)" }] }
    }

    const MAX_READ_BYTES = 1024 * 1024
    if (info.size > MAX_READ_BYTES) {
      return { content: [{ type: "text", text: `Denied: file too large (${info.size} bytes, limit ${MAX_READ_BYTES})` }], isError: true }
    }

    const content = await readFile(target, "utf-8")
    return { content: [{ type: "text", text: content }] }
  }
)

server.tool(
  "write_project_file",
  "Write a file's content within a project root. Same path-containment and sensitive-filename denial as read_project_file. Refuses to overwrite an existing file unless overwrite is explicitly true. Tier 1, requires human approval upstream.",
  {
    project_root: z.string().describe("Absolute path to the project root"),
    relative_path: z.string().describe("Path relative to project_root — must not be absolute or escape the root"),
    content: z.string().describe("File content to write"),
    overwrite: z.boolean().default(false).describe("Must be true to overwrite an existing file"),
  },
  async ({ project_root, relative_path, content, overwrite }) => {
    let target: string
    try {
      target = await containPath(project_root, relative_path)
    } catch (err: any) {
      return { content: [{ type: "text", text: `Denied: ${err.message}` }], isError: true }
    }

    if (existsSync(target) && !overwrite) {
      return { content: [{ type: "text", text: `Refusing to overwrite existing file: ${relative_path} (set overwrite: true)` }], isError: true }
    }

    const dir = path.dirname(target)
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    await writeFile(target, content)

    return { content: [{ type: "text", text: `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${relative_path}` }] }
  }
)

// ============================================================
// CATEGORY 5: GENERAL APPROVED EXECUTION (specs/080-run-command-approved-execution/spec.md)
// ============================================================
// Every OTHER execution tool in this file is a fixed, hand-written
// command — deliberately NOT this one. run_command moves the safety
// boundary from "only these pre-approved commands may run" to "a human
// reviews the exact argv before it runs, every single time": it does
// NOT go through safeExec()/ALLOWED_PREFIXES at all (that allowlist is
// untouched, for every other tool in this file) — the calling agent's
// own actionId-bound approval gate is what makes invoking this safe,
// not a fixed prefix list. This tool itself performs no approval check
// of its own; it must only ever be reached from resumeTask(), after a
// human has already approved the exact argv shown in the preview.
const RUN_COMMAND_TIMEOUT_MS = 120_000
const RUN_COMMAND_OUTPUT_MAX_BYTES = 64 * 1024

server.tool(
  "run_command",
  "Execute a real command (an argv array, never a shell string) inside a project directory, bounded by a timeout and output cap, with a minimal defense-in-depth denylist for unambiguously destructive patterns. Tier 1 — the calling agent's own approval gate, not this tool, is the real safety mechanism; every invocation must already be human-approved before this is ever called.",
  {
    argv: z.array(z.string()).min(1).describe("The command and its arguments, e.g. [\"go\", \"test\", \"./...\"] — never a shell string"),
    cwd: z.string().describe("Absolute working directory to run the command in"),
    project_root: z.string().describe("Absolute path to the project root — cwd must resolve inside this"),
  },
  async ({ argv, cwd, project_root }) => {
    const denyReason = checkRunCommandDenylist(argv)
    if (denyReason) {
      return { content: [{ type: "text", text: `Blocked: ${denyReason}` }], isError: true }
    }
    if (!isPathContainedSync(project_root, cwd)) {
      return { content: [{ type: "text", text: `Denied: cwd "${cwd}" is outside project_root "${project_root}"` }], isError: true }
    }
    if (!existsSync(cwd)) {
      return { content: [{ type: "text", text: `cwd not found: ${cwd}` }], isError: true }
    }

    const [bin, ...args] = argv
    try {
      const { stdout, stderr } = await execFileAsync(bin!, args, {
        cwd,
        timeout: RUN_COMMAND_TIMEOUT_MS,
        shell: false,
        env: buildSanitizedTestEnv(),
      })
      const raw = (stdout + "\n" + stderr).trim()
      const truncated = raw.length > RUN_COMMAND_OUTPUT_MAX_BYTES
      const bounded = truncated ? raw.slice(0, RUN_COMMAND_OUTPUT_MAX_BYTES) + "\n[Output truncated at 64 KiB]" : raw
      return { content: [{ type: "text", text: bounded || "(no output)" }] }
    } catch (err: any) {
      // specs/138 — a command that RAN and exited non-zero keeps its full
      // stdout AND stderr (a failing test suite prints its results to
      // stdout; returning only stderr lost them), plus the exit code, so a
      // caller can tell "ran and failed" from "could not run". Still an
      // error result: a non-zero exit is a failure for this tool.
      const output = [err.stdout, err.stderr].map((part: unknown) => (part === undefined || part === null ? "" : String(part))).join("\n").trim()
      if (typeof err.code === "number" && output) {
        const bounded = output.length > RUN_COMMAND_OUTPUT_MAX_BYTES ? output.slice(0, RUN_COMMAND_OUTPUT_MAX_BYTES) + "\n[Output truncated at 64 KiB]" : output
        return { content: [{ type: "text", text: `${bounded}\n[exit code ${err.code}]` }], isError: true }
      }
      const message = err.killed ? `Command timed out after ${RUN_COMMAND_TIMEOUT_MS}ms` : err.stderr?.toString().trim() || err.message || "Command failed"
      return { content: [{ type: "text", text: message }], isError: true }
    }
  }
)

  return server
}
