// specs/138-model-authored-files-replace-templates/spec.md
//
// Deterministic checks every model-authored DevOps file must pass BEFORE a
// human ever sees its preview. These files get executed (`docker build`, a
// real CI run, `docker compose up`), so the model writing them is only
// half the story: these rules decide whether a preview may be shown at
// all. The human approval of the exact file remains the final guarantee.
//
// Every check is fail-closed: content a validator can't parse is rejected,
// never waved through. Allow-lists are exported constants; widening one is
// a normal reviewed code change (no environment override, by design).
import { parse as parseYaml } from "yaml"

export interface FileValidationResult {
  ok: boolean
  violations: string[]
}

function result(violations: string[]): FileValidationResult {
  return { ok: violations.length === 0, violations }
}

// ============================================================
// Allow-lists
// ============================================================
/** Official runtime/base images a Dockerfile `FROM` may use. An entry
 *  ending in "/" allows every image under that namespace. */
export const DOCKER_BASE_IMAGE_ALLOWLIST: readonly string[] = [
  "oven/bun", "node", "python", "golang", "rust", "eclipse-temurin", "maven", "gradle",
  "php", "ruby", "denoland/deno", "alpine", "debian", "ubuntu", "busybox", "nginx", "caddy",
  "scratch", "gcr.io/distroless/", "mcr.microsoft.com/dotnet/",
]

/** Well-known service images a compose file may add beside the app. */
export const COMPOSE_SERVICE_IMAGE_ALLOWLIST: readonly string[] = [
  ...DOCKER_BASE_IMAGE_ALLOWLIST,
  "postgres", "redis", "mysql", "mariadb", "mongo", "rabbitmq", "memcached",
]

/** GitHub Actions a workflow may use (owner/ or exact owner/name). */
export const CI_ACTION_ALLOWLIST: readonly string[] = ["actions/", "docker/", "github/", "oven-sh/setup-bun"]

// Environment/ARG names that must never carry a literal value.
const SENSITIVE_NAME = /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)/i
// `curl … | sh`-style pipe-to-shell.
const PIPE_TO_SHELL = /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|ash|dash|python3?|node|perl)\b/i

/** "docker.io/library/node:20-slim" → "node"; strips registry-default
 *  prefixes, the tag and any digest. */
export function imageRepository(image: string): string {
  let repo = image.trim().toLowerCase()
  repo = repo.replace(/@sha256:[0-9a-f]+$/, "")
  const lastSlash = repo.lastIndexOf("/")
  const colon = repo.indexOf(":", lastSlash + 1)
  if (colon >= 0) repo = repo.slice(0, colon)
  repo = repo.replace(/^docker\.io\/library\//, "").replace(/^docker\.io\//, "").replace(/^library\//, "")
  return repo
}

export function isAllowListedImage(image: string, allowList: readonly string[]): boolean {
  const repo = imageRepository(image)
  return allowList.some((entry) => (entry.endsWith("/") ? repo.startsWith(entry) : repo === entry))
}

// ============================================================
// Dockerfile
// ============================================================
/** Joins backslash-continued lines, drops comments and blank lines. */
function dockerfileInstructions(content: string): string[] {
  const joined = content.replace(/\\\r?\n/g, " ")
  return joined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

function copySources(args: string): string[] {
  const trimmed = args.trim()
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) return (parsed as string[]).slice(0, -1)
    } catch {
      return []
    }
  }
  const tokens = trimmed.split(/\s+/).filter((token) => !token.startsWith("--"))
  return tokens.slice(0, -1)
}

/** Validates a model-authored Dockerfile. `sourceExists(rel)` answers
 *  whether a COPY/ADD source path really exists in the project — the
 *  grounding check. */
export async function validateDockerfile(
  content: string,
  sourceExists: (relativePath: string) => Promise<boolean>,
): Promise<FileValidationResult> {
  const violations: string[] = []
  const instructions = dockerfileInstructions(content)
  const stages = new Set<string>()
  let sawFrom = false
  let sawCmd = false

  for (const line of instructions) {
    const [rawKeyword = "", ...rest] = line.split(/\s+/)
    const keyword = rawKeyword.toUpperCase()
    const args = rest.join(" ")

    if (keyword === "FROM") {
      sawFrom = true
      const parts = rest.filter((part) => !part.startsWith("--"))
      const image = parts[0] ?? ""
      const asIndex = parts.findIndex((part) => part.toUpperCase() === "AS")
      if (image.includes("$")) {
        violations.push(`FROM "${image}" uses a variable — the base image must be written out so it can be checked`)
      } else if (!stages.has(image.toLowerCase()) && !isAllowListedImage(image, DOCKER_BASE_IMAGE_ALLOWLIST)) {
        violations.push(`FROM "${image}" is not an allow-listed base image (allowed: ${DOCKER_BASE_IMAGE_ALLOWLIST.join(", ")})`)
      }
      if (asIndex >= 0 && parts[asIndex + 1]) stages.add(parts[asIndex + 1]!.toLowerCase())
    }
    if (keyword === "CMD" || keyword === "ENTRYPOINT") sawCmd = true
    if (keyword === "ADD" && /(^|\s)(https?|ftp):\/\//i.test(args)) {
      violations.push(`ADD fetches a URL ("${args}") — download in a RUN step with a checksum, or COPY a project file`)
    }
    if (PIPE_TO_SHELL.test(line)) violations.push(`pipes a download straight into a shell: "${line}"`)
    if (/--privileged|--security=insecure|--allow-insecure/i.test(line)) violations.push(`uses an insecure/privileged flag: "${line}"`)
    if (keyword === "ENV" || keyword === "ARG") {
      const pairs = args.includes("=") ? [...args.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g)].map((m) => [m[1]!, m[2]!]) : [[rest[0] ?? "", rest.slice(1).join(" ")]]
      for (const [name, value] of pairs) {
        const bare = (value ?? "").replace(/^["']|["']$/g, "")
        if (SENSITIVE_NAME.test(name ?? "") && bare.length > 0 && !bare.startsWith("$")) {
          violations.push(`${keyword} ${name} bakes a literal secret into the image — pass it at runtime instead`)
        }
      }
    }
    if ((keyword === "COPY" || keyword === "ADD") && !/--from=/i.test(args)) {
      for (const source of copySources(args)) {
        const rel = source.replace(/^\.\//, "")
        if (rel === "" || rel === "." || /[*?[\]$]/.test(rel)) continue
        if (/^(https?|ftp):\/\//i.test(rel)) continue // reported above for ADD
        if (!(await sourceExists(rel))) violations.push(`${keyword} source "${source}" does not exist in the project`)
      }
    }
  }

  if (!sawFrom) violations.push("has no FROM instruction")
  if (!sawCmd) violations.push("has no CMD or ENTRYPOINT")
  return result(violations)
}

// ============================================================
// CI workflow
// ============================================================
/** The structural rules lint_ci_workflow has always applied, moved here
 *  so they also run on content BEFORE it is written. */
export function lintWorkflowStructure(raw: string): string[] {
  const issues: string[] = []
  if (!/^\s*on\s*:/m.test(raw)) issues.push("Missing top-level 'on:' key")
  if (!/^\s*jobs\s*:/m.test(raw)) issues.push("Missing top-level 'jobs:' key")
  if (raw.includes("\t")) issues.push("Contains tab characters — YAML requires spaces for indentation")
  return issues
}

const PINNED_REF = /^(v?\d+(\.\d+){0,2}|[0-9a-f]{40})$/

export function validateWorkflow(content: string, knownSecrets: readonly string[] = []): FileValidationResult {
  const violations = [...lintWorkflowStructure(content)]
  let doc: any
  try {
    doc = parseYaml(content)
  } catch (err) {
    return result([...violations, `is not valid YAML: ${err instanceof Error ? err.message : String(err)}`])
  }
  if (!doc || typeof doc !== "object") return result([...violations, "is not a YAML mapping"])

  const on = doc.on ?? doc[true as unknown as string] // YAML 1.1 parsers can read `on` as a boolean key
  const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : on && typeof on === "object" ? Object.keys(on) : []
  if (triggers.includes("pull_request_target")) violations.push("uses the pull_request_target trigger (runs untrusted PR code with repository secrets)")
  if (doc.permissions === "write-all") violations.push("grants permissions: write-all")

  const jobs = doc.jobs && typeof doc.jobs === "object" ? doc.jobs : {}
  for (const [jobName, job] of Object.entries<any>(jobs)) {
    if (job?.permissions === "write-all") violations.push(`job "${jobName}" grants permissions: write-all`)
    if (typeof job?.uses === "string" && !job.uses.startsWith("./")) violations.push(`job "${jobName}" calls a remote reusable workflow "${job.uses}"`)
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      if (typeof step?.uses === "string") {
        const uses: string = step.uses
        if (uses.startsWith("./")) continue
        const [name = "", ref] = uses.split("@")
        if (!CI_ACTION_ALLOWLIST.some((entry) => (entry.endsWith("/") ? name.startsWith(entry) : name === entry))) {
          violations.push(`uses action "${uses}", which is not allow-listed (allowed: ${CI_ACTION_ALLOWLIST.join(", ")})`)
        } else if (!ref || !PINNED_REF.test(ref)) {
          violations.push(`action "${uses}" is not pinned to a version tag or commit SHA`)
        }
      }
      if (typeof step?.run === "string" && PIPE_TO_SHELL.test(step.run)) violations.push(`a run step pipes a download straight into a shell: "${step.run.trim()}"`)
    }
  }

  const allowedSecrets = new Set(["GITHUB_TOKEN", ...knownSecrets])
  for (const match of content.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!allowedSecrets.has(match[1]!)) violations.push(`references secrets.${match[1]}, which the project doesn't already use`)
  }
  return result([...new Set(violations)])
}

// ============================================================
// docker-compose
// ============================================================
function isHostPathOutsideProject(source: string): boolean {
  const s = source.trim()
  if (s === "/var/run/docker.sock") return true
  if (s.startsWith("/") || s.startsWith("~") || s.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(s)) return true
  const normalized = s.replace(/\\/g, "/").replace(/^\.\//, "")
  return normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")
}

/** The host side of a short-syntax volume ("./data:/var/lib/x:ro" →
 *  "./data", "C:\\x:/y" → "C:\\x"); "" for an anonymous volume. */
function volumeSource(volume: string): string {
  const match = volume.match(/^([A-Za-z]:[\\/][^:]*|[^:]*):/)
  return match ? match[1]! : ""
}

export function validateCompose(content: string, projectName: string): FileValidationResult {
  const violations: string[] = []
  let doc: any
  try {
    doc = parseYaml(content)
  } catch (err) {
    return result([`is not valid YAML: ${err instanceof Error ? err.message : String(err)}`])
  }
  const services = doc && typeof doc === "object" ? doc.services : undefined
  if (!services || typeof services !== "object") return result(["has no services: mapping"])

  const ownImage = projectName.toLowerCase()
  for (const [name, svc] of Object.entries<any>(services)) {
    if (!svc || typeof svc !== "object") continue
    if (typeof svc.image === "string") {
      const repo = imageRepository(svc.image)
      const isOwn = svc.build !== undefined || repo === ownImage
      if (!isOwn && !isAllowListedImage(svc.image, COMPOSE_SERVICE_IMAGE_ALLOWLIST)) {
        violations.push(`service "${name}" uses image "${svc.image}", which is not allow-listed`)
      }
    } else if (svc.build === undefined) {
      violations.push(`service "${name}" has neither an image nor a build`)
    }
    if (svc.privileged === true) violations.push(`service "${name}" is privileged`)
    for (const key of ["network_mode", "pid", "ipc"]) {
      if (svc[key] === "host") violations.push(`service "${name}" uses ${key}: host`)
    }
    const caps = Array.isArray(svc.cap_add) ? svc.cap_add.map(String) : []
    if (caps.some((cap: string) => /^(ALL|SYS_ADMIN)$/i.test(cap))) violations.push(`service "${name}" adds dangerous capabilities (${caps.join(", ")})`)
    for (const volume of Array.isArray(svc.volumes) ? svc.volumes : []) {
      const source = typeof volume === "string" ? volumeSource(volume) : volume?.type === "bind" ? String(volume.source ?? "") : ""
      // A bare name ("data") is a named volume, not a host path.
      const isHostPath = source.includes("/") || source.includes("\\") || source.startsWith(".") || source.startsWith("~")
      if (source && isHostPath && isHostPathOutsideProject(source)) {
        violations.push(`service "${name}" mounts host path "${source}", which is outside the project`)
      }
    }
    const env = svc.environment
    const pairs: [string, unknown][] = Array.isArray(env)
      ? env.map((entry: unknown) => {
          const text = String(entry)
          const eq = text.indexOf("=")
          return eq >= 0 ? [text.slice(0, eq), text.slice(eq + 1)] : [text, ""]
        })
      : env && typeof env === "object" ? Object.entries(env) : []
    for (const [key, value] of pairs) {
      const literal = value === null || value === undefined ? "" : String(value)
      if (SENSITIVE_NAME.test(key) && literal.length > 0 && !literal.startsWith("$")) {
        violations.push(`service "${name}" sets ${key} to a literal value — use \${${key}} from the environment instead`)
      }
    }
  }
  return result(violations)
}

// ============================================================
// .gitignore
// ============================================================
const ORCHESTRAI_IGNORE_LINES = new Set([".orchestrai", ".orchestrai/", "/.orchestrai", "/.orchestrai/", ".orchestrai/*", "/.orchestrai/*", ".orchestrai/**"])
const SENSITIVE_UNIGNORE = /^!\s*.*(\.env|\.pem|\.key|id_rsa|id_ed25519|credentials|secret)/i
// The well-known safe template names read_project_file also allows (specs/129):
// un-ignoring these is normal and never exposes a real secret.
const SAFE_ENV_TEMPLATE_UNIGNORE = /^!\s*(.*\/)?\.env\.(example|sample|template|dist)$/i

export function validateGitignore(content: string): FileValidationResult {
  const lines = content.split(/\r?\n/).map((line) => line.trim())
  const violations: string[] = []
  if (!lines.some((line) => ORCHESTRAI_IGNORE_LINES.has(line))) {
    violations.push("must ignore .orchestrai/ (OrchestrAI's own state directory, which holds the provider key)")
  }
  for (const line of lines) {
    if (SENSITIVE_UNIGNORE.test(line) && !SAFE_ENV_TEMPLATE_UNIGNORE.test(line)) violations.push(`un-ignores a sensitive file pattern: "${line}"`)
  }
  return result(violations)
}

// ============================================================
// One entry point per file kind (used by the DevOps authoring harness)
// ============================================================
export type DevOpsFileKind = "dockerfile" | "ci-workflow" | "compose" | "gitignore"

export interface DevOpsFileValidationDeps {
  /** Grounding for Dockerfile COPY/ADD sources. */
  sourceExists: (relativePath: string) => Promise<boolean>
  /** The project's directory name — the app's own image name. */
  projectName: string
  /** Secrets the project's existing workflow already references. */
  knownSecrets?: readonly string[]
}

export async function validateDevOpsFile(kind: DevOpsFileKind, content: string, deps: DevOpsFileValidationDeps): Promise<FileValidationResult> {
  if (kind === "dockerfile") return validateDockerfile(content, deps.sourceExists)
  if (kind === "ci-workflow") return validateWorkflow(content, deps.knownSecrets ?? [])
  if (kind === "compose") return validateCompose(content, deps.projectName)
  return validateGitignore(content)
}

/** Secrets a workflow references (`secrets.NAME`), so a regenerated
 *  workflow may keep using the ones the project already relies on. */
export function referencedSecrets(workflow: string | undefined): string[] {
  if (!workflow) return []
  return [...new Set([...workflow.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))]
}
