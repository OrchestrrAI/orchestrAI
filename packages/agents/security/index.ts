import { Hono } from "hono"
import { serve } from "bun"
import { existsSync } from "fs"
import { readdir, readFile } from "fs/promises"
import * as path from "path"
import { resolveTargetPath } from "../../shared"
import { resolveServicePort } from "../../shared/service-ports"
import { parseTaskEnvelope, readJsonBody, validateSelectedSkillOwnership, type ValidatedTask } from "../../shared/task-envelope"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { buildChatModel, isExternalDataFlagSet, isHarnessFlagSet, readLlmHarnessConfig, readLlmHarnessStartupState } from "./model-factory"
import { runAuditDependenciesEnrichment, runGitignoreEnrichment, runScanSecretsEnrichment } from "./llm-harness"
import { fetchVulnDetails, MAX_DETAIL_FETCHES_PER_PACKAGE, queryOsvBatch, type DependencyRef } from "./osv-client"
import {
  detectEcosystem,
  MANIFEST_FILES_CHECKED,
  readComposerLockfile,
  readComposerManifest,
  readGoMod,
  readNpmLockfile,
  readNpmManifest,
  readPomXml,
  readPyPiManifest,
  type DependencyEntry,
  type Ecosystem,
} from "./dependency-manifests"
import { startTaskPersistenceSweep } from "../../shared/store"

// ============================================================
// TYPES
// ============================================================
type TaskStatus = "submitted" | "working" | "completed" | "failed"

interface TaskResult {
  id: string
  status: TaskStatus
  result?: string
  error?: string
  step?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ============================================================
// LLM COMMENTARY (specs/043-llm-harness-security/spec.md)
// ============================================================
// Strictly additive: appends a clearly separate section after the
// deterministic report text, never touches it. With the flag unset,
// returns baseText completely unchanged — byte-identical to pre-043
// behavior. A harness failure (missing config, API error, exhausted
// retries) never fails the task and never silently omits that
// enrichment was attempted — it appends an explicit "AI commentary
// unavailable" notice instead. This deliberately differs from specs/026/
// 041/042's "fail the whole task closed" precedent: those skills' write
// or plan output would otherwise be indistinguishable from a silent
// fallback, but Security's deterministic findings are already complete
// and safe on their own — discarding them on an enrichment failure would
// make the flag strictly worse than leaving it off, for no safety
// benefit. See the spec's "Fail-open-on-report, fail-closed-on-claim"
// section.
async function withAiCommentary(
  baseText: string,
  run: (model: BaseChatModel) => Promise<string | null>,
): Promise<string> {
  if (!isHarnessFlagSet()) return baseText

  const unavailable = (reason: string) => `${baseText}\n\n=== AI Commentary ===\nAI commentary unavailable: ${reason}`

  let config
  try {
    config = readLlmHarnessConfig()
  } catch (err) {
    return unavailable(`invalid LLM harness configuration: ${errorMessage(err)}`)
  }
  if (!config) {
    return unavailable("ORCHESTRAI_SECURITY_LLM_HARNESS=1 is set but ORCHESTRAI_LLM_API_KEY is missing")
  }

  let model: BaseChatModel
  try {
    model = await buildChatModel(config)
  } catch (err) {
    return unavailable(`could not construct LLM provider: ${errorMessage(err)}`)
  }

  let section: string | null
  try {
    section = await run(model)
  } catch (err) {
    return unavailable(`enrichment run failed: ${errorMessage(err)}`)
  }

  if (section === null) return unavailable("the model's response could not be validated after retries")
  return `${baseText}\n\n${section}`
}

// ============================================================
// AGENT CARD
// ============================================================
// specs/048-guided-init-experience/spec.md: exported so the setup form's
// display-only agent-catalog test can assert against the real skill ids
// rather than a hand-copied guess. No behavior change — still only ever
// served live via GET /.well-known/agent.json for anything routing-related.
export const agentCard = {
  name: "security-agent",
  description: "Scans projects for exposed secrets and risky configuration",
  url: `http://localhost:${resolveServicePort("security")}`,
  version: "1.0.0",
  skills: [
    {
      id: "scan-secrets",
      name: "Scan for Exposed Secrets",
      description: "Search project files for hardcoded API keys, tokens, and credentials",
      examples: ["scan for secrets at C:\\path\\to\\project"],
    },
    {
      id: "check-gitignore-coverage",
      name: "Check .gitignore Coverage",
      description: "Verify sensitive file patterns (.env, credentials) are actually gitignored",
      examples: ["check gitignore coverage at C:\\path\\to\\project"],
    },
    {
      id: "audit-dependencies",
      name: "Audit Dependencies",
      description: "Flag unpinned dependency versions and (opt-in) check for real known vulnerabilities via OSV.dev — npm, Python, Go, PHP, and Java/Maven",
      examples: ["audit dependencies at C:\\path\\to\\project"],
    },
  ],
}

// specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md —
// derived from the Agent Card above, never a separate hand-maintained
// list, so ownership can never drift from what this agent advertises.
const OWNED_SKILL_IDS = new Set(agentCard.skills.map((s) => s.id))

// ============================================================
// TASK STORE
// ============================================================
const tasks = new Map<string, TaskResult>()

// specs/107-task-and-conversation-history/spec.md B4 — Security's own
// TaskResult carries no skill/createdAt, so a small side map records
// both at the one place processTask() already computes them (its own
// selectedSkill-or-detectSkill() line), rather than threading two new
// fields through every existing tasks.set() call site in this file.
const taskMeta = new Map<string, { skill: string; createdAt: number }>()

// Broadened per specs/013-security-skill-detection/spec.md: every previous
// path to this agent (Orchestrator routing, dashboard preset buttons)
// already required roughly this same narrow keyword to arrive here in the
// first place, so the gap was invisible until direct-to-agent submission
// (apps/tui) let someone pick this agent without needing to also guess its
// internal keyword. Checked most-specific-first so a sentence containing
// more than one trigger still lands on the most precise match.
function detectSkill(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes("gitignore"))                                                 return "check-gitignore-coverage"
  if (lower.includes("depend") || lower.includes("audit") ||
      lower.includes("vulnerab") || lower.includes("package"))                     return "audit-dependencies"
  if (lower.includes("secret") || lower.includes("scan") || lower.includes("credential") ||
      lower.includes("leak") || lower.includes("security") || lower.includes("secure"))
                                                                                     return "scan-secrets"
  return "unknown"
}

// ============================================================
// RECURSIVE FILE WALK — Windows-safe readdir, never ls/shell.
// Hard-excludes node_modules/.git/dist/build so scans stay fast
// and don't drown in dependency-tree noise.
// ============================================================
// specs/129 — .orchestrai is OrchestrAI's own state (API key, logs, db).
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".orchestrai"])

function isScannableFile(name: string): boolean {
  if (name.startsWith(".env")) return true
  return [".ts", ".js", ".json", ".yml", ".yaml"].some(ext => name.endsWith(ext))
}

async function walkFiles(root: string): Promise<string[]> {
  const results: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return  // unreadable directory — skip it, don't fail the whole scan
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue  // never descend into these
        await walk(path.join(dir, entry.name))
      } else if (entry.isFile() && isScannableFile(entry.name)) {
        results.push(path.join(dir, entry.name))
      }
    }
  }

  await walk(root)
  return results
}

// ============================================================
// SKILL — SCAN FOR SECRETS
// ============================================================
function maskSecret(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length)
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

// High-confidence: well-known key/token prefixes. Checked in this order so a
// key like "sk-ant-..." is labeled Anthropic, not misfiled as a generic OpenAI key.
const HIGH_CONFIDENCE_RULES: { regex: RegExp; label: string }[] = [
  { regex: /sk-ant-[a-zA-Z0-9_-]{10,}/, label: "Anthropic API key" },
  { regex: /ghp_[a-zA-Z0-9]{10,}/,      label: "GitHub token" },
  { regex: /AKIA[0-9A-Z]{10,}/,         label: "AWS access key" },
  { regex: /sk-[a-zA-Z0-9_-]{10,}/,     label: "OpenAI API key" },
]

// Medium-confidence: generic key/secret/password assignments
const MEDIUM_CONFIDENCE_RULES: { regex: RegExp; label: string }[] = [
  { regex: /api[_-]?key\s*[:=]\s*["']([a-zA-Z0-9_-]{16,})["']/i, label: "hardcoded API key" },
  { regex: /secret\s*[:=]\s*["']([a-zA-Z0-9_-]{16,})["']/i,      label: "hardcoded secret" },
  { regex: /password\s*[:=]\s*["'](.+?)["']/i,                   label: "hardcoded password" },
]

const PLACEHOLDER_VALUES = new Set([
  "your-password-here", "xxx", "changeme", "password", "example", "placeholder", "todo",
])

interface SecretHit {
  confidence: "HIGH CONFIDENCE" | "MEDIUM CONFIDENCE"
  label: string
  value: string
}

function scanLineForSecret(line: string): SecretHit | null {
  for (const rule of HIGH_CONFIDENCE_RULES) {
    const match = line.match(rule.regex)
    if (match) return { confidence: "HIGH CONFIDENCE", label: rule.label, value: match[0] }
  }
  for (const rule of MEDIUM_CONFIDENCE_RULES) {
    const match = line.match(rule.regex)
    if (match) {
      const value = match[1]
      if (PLACEHOLDER_VALUES.has(value.toLowerCase())) continue  // skip obvious placeholders
      return { confidence: "MEDIUM CONFIDENCE", label: rule.label, value }
    }
  }
  return null
}

async function skillScanSecrets(text: string): Promise<string> {
  const projectPath = resolveTargetPath(text)
  if (!existsSync(projectPath)) throw new Error(`Path not found: ${projectPath}`)

  const files = await walkFiles(projectPath)

  const findings: { file: string; line: number; hit: SecretHit }[] = []
  for (const file of files) {
    let content: string
    try {
      content = await readFile(file, "utf-8")
    } catch {
      continue  // unreadable file (binary, permissions) — skip it
    }
    content.split("\n").forEach((line, idx) => {
      const hit = scanLineForSecret(line)
      if (hit) findings.push({ file: path.relative(projectPath, file), line: idx + 1, hit })
    })
  }

  const header = [
    `=== Secret Scan ===`,
    `Path: ${projectPath}`,
    `Files scanned: ${files.length}`,
    ``,
  ]

  if (findings.length === 0) {
    return [...header, `No exposed secrets detected in ${files.length} files scanned.`].join("\n")
  }

  const body: string[] = []
  for (const f of findings) {
    body.push(
      `[${f.hit.confidence}] ${f.file}:${f.line}`,
      `  Pattern: ${f.hit.label}`,
      `  Value: ${maskSecret(f.hit.value)} (redacted)`,
      ``,
    )
  }
  body.push(`Total findings: ${findings.length}`)

  const baseText = [...header, ...body].join("\n")

  return withAiCommentary(baseText, async (model) => {
    const enrichment = await runScanSecretsEnrichment({
      model,
      findings: findings.map((f, idx) => ({
        index: idx,
        file: f.file,
        line: f.line,
        confidence: f.hit.confidence,
        label: f.hit.label,
        maskedValue: maskSecret(f.hit.value),
      })),
    })
    if (!enrichment) return null

    // specs/043 — the deterministic section above prints no index (kept
    // byte-identical to pre-043 output with the flag unset), so
    // commentary correlates back to a finding by file:line instead.
    const lines = [`=== AI Commentary ===`]
    for (const pf of enrichment.perFinding) {
      const f = findings[pf.findingIndex]
      const locator = f ? `${f.file}:${f.line}` : `finding ${pf.findingIndex}`
      lines.push(`${locator} — ${pf.likelyFalsePositive ? "Likely false positive" : "Flagged"}: ${pf.note}`)
    }
    if (enrichment.summary) lines.push(``, enrichment.summary)
    return lines.join("\n")
  })
}

// ============================================================
// SKILL — CHECK .GITIGNORE COVERAGE
// ============================================================
const REQUIRED_GITIGNORE_PATTERNS = [".env", ".env.*", "node_modules/", "*.key", "*.pem", "dist/", "build/"]

// Exact-line match against the gitignore's entries (trimmed) — a bare
// "node_modules" line still covers "node_modules/" (trailing slash just
// means "directory only" in gitignore syntax), so compare without it.
// Plain substring search is too loose here: e.g. "*.tsbuildinfo" contains
// the substring "build" without actually ignoring a build/ directory.
function isPatternCovered(gitignoreLines: string[], pattern: string): boolean {
  const bare = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern
  return gitignoreLines.includes(bare) || gitignoreLines.includes(pattern)
}

// specs/043 — top-level plus one level deep, same EXCLUDED_DIRS exclusions
// walkFiles() already uses. Only feeds the opt-in AI Commentary section
// (see withAiCommentary); the deterministic pattern check above never
// reads this.
async function shallowDirectoryListing(root: string): Promise<string[]> {
  const results: string[] = []
  let topEntries
  try {
    topEntries = await readdir(root, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of topEntries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      results.push(`${entry.name}/`)
      try {
        const nested = await readdir(path.join(root, entry.name), { withFileTypes: true })
        for (const n of nested) results.push(`${entry.name}/${n.name}${n.isDirectory() ? "/" : ""}`)
      } catch {
        // unreadable nested directory — skip it, same tolerance walkFiles() uses.
      }
    } else {
      results.push(entry.name)
    }
  }
  return results
}

async function skillCheckGitignoreCoverage(text: string): Promise<string> {
  const projectPath   = resolveTargetPath(text)
  if (!existsSync(projectPath)) throw new Error(`Path not found: ${projectPath}`)

  const gitignorePath = path.join(projectPath, ".gitignore")
  const lines = [`=== .gitignore Coverage ===`, `Path: ${projectPath}`, ``]

  if (!existsSync(gitignorePath)) {
    lines.push(`[CRITICAL] No .gitignore file found at this path.`)
    return lines.join("\n")
  }

  const content      = await readFile(gitignorePath, "utf-8")
  const contentLines = content.split("\n").map(l => l.trim()).filter(Boolean)

  const covered = REQUIRED_GITIGNORE_PATTERNS.filter(p => isPatternCovered(contentLines, p))
  const missing = REQUIRED_GITIGNORE_PATTERNS.filter(p => !isPatternCovered(contentLines, p))

  lines.push(
    `Covered patterns: ${covered.length ? covered.join(", ") : "(none)"}`,
    `Missing patterns: ${missing.length ? missing.join(", ") : "(none)"}`,
    ``,
  )

  const envExists  = existsSync(path.join(projectPath, ".env"))
  const envCovered = contentLines.includes(".env") || contentLines.includes(".env.*")

  if (envExists && !envCovered) {
    lines.push(`[CRITICAL] .env file exists in the project and is NOT covered by .gitignore!`)
  } else if (envExists) {
    lines.push(`.env file exists and IS covered by .gitignore.`)
  } else {
    lines.push(`No .env file present in the project.`)
  }

  const baseText = lines.join("\n")

  return withAiCommentary(baseText, async (model) => {
    const directoryListing = await shallowDirectoryListing(projectPath)
    const enrichment = await runGitignoreEnrichment({ model, coveredPatterns: covered, missingPatterns: missing, directoryListing })
    if (!enrichment) return null
    if (enrichment.additionalSuggestions.length === 0) return `=== AI Commentary ===\nNo additional patterns suggested beyond the deterministic check above.`

    const out = [`=== AI Commentary ===`, `Additional suggestions based on files actually present in this project:`]
    for (const s of enrichment.additionalSuggestions) out.push(`  - ${s.pattern}: ${s.reason}`)
    return out.join("\n")
  })
}

// ============================================================
// specs/084-security-external-vulnerability-data/spec.md — real
// vulnerability data from OSV.dev, wholly separate from the LLM
// commentary layer above: no model ever sees or produces this text.
// Only reached when ORCHESTRAI_SECURITY_EXTERNAL_DATA=1 — with the
// flag unset, this function is never called and audit-dependencies'
// output is byte-identical to before this spec.
// ============================================================
const VULN_SECTION_HEADER = "=== Known Vulnerabilities (OSV.dev) ==="

/** Strips a common semver-range prefix (^, ~, >=, <=, >, <, =) to get a
 *  best-effort concrete version to query OSV with — OSV's own
 *  querybatch wants one real version, not a range, to check against
 *  its stored affected-version ranges server-side. A dependency with
 *  no usable concrete version left after stripping (e.g. still empty)
 *  is simply not queried — never a guessed version. */
function toConcreteVersion(rangeSpec: string): string | null {
  // "*"/"latest" have no real version to query at all — the existing
  // unpinned-version check above already flags these; querying OSV with
  // the literal string "*" would be meaningless, not a best effort.
  if (rangeSpec === "*" || rangeSpec === "latest") return null
  const stripped = rangeSpec.replace(/^[\^~]|^>=|^<=|^[><=]/, "").trim()
  return stripped.length > 0 ? stripped : null
}

/** specs/085 §5 — the vulnerability section's OWN sub-header names its
 *  real source whenever that differs from the primary manifest (a
 *  lockfile was used instead) — never the top-level header, which stays
 *  ecosystem-labeled only (or unlabeled for npm), completely independent
 *  of this. */
function vulnSectionHeader(sourceLabel: string | null): string {
  return sourceLabel ? `=== Known Vulnerabilities (OSV.dev, via ${sourceLabel}) ===` : VULN_SECTION_HEADER
}

/** Fail-open per specs/043's own exact precedent: any failure here
 *  (network, timeout, malformed response) is caught and rendered as an
 *  explicit "unavailable" note, never thrown up to fail the whole task —
 *  the unpinned-version check above it, and any LLM commentary below
 *  it, are both completely unaffected either way. */
async function buildVulnerabilitySection(deps: Record<string, string>, ecosystem: Ecosystem, sourceLabel: string | null): Promise<string> {
  const header = vulnSectionHeader(sourceLabel)
  try {
    const packages: DependencyRef[] = Object.entries(deps)
      .map(([name, version]) => ({ name, version: toConcreteVersion(String(version)) }))
      .filter((p): p is DependencyRef => p.version !== null)

    if (packages.length === 0) {
      return `${header}\nNo known vulnerabilities found.`
    }

    const idsByPackage = await queryOsvBatch(packages, { ecosystem })
    const vulnerable = Array.from(idsByPackage.entries()).filter(([, ids]) => ids.length > 0)

    if (vulnerable.length === 0) {
      return `${header}\nNo known vulnerabilities found.`
    }

    const lines = [header]
    for (const [name, ids] of vulnerable) {
      const capped = ids.slice(0, MAX_DETAIL_FETCHES_PER_PACKAGE)
      const version = packages.find((p) => p.name === name)?.version ?? "?"
      const details = await fetchVulnDetails(capped)
      if (details.length === 0) {
        lines.push(`  - ${name}@${version}: ${capped.join(", ")} (details unavailable)`)
        continue
      }
      for (const d of details) {
        lines.push(`  - ${name}@${version}: ${d.id}${d.summary ? ` — ${d.summary}` : ""}`)
      }
    }
    return lines.join("\n")
  } catch (err) {
    return `${header}\nVulnerability data unavailable: ${errorMessage(err)}`
  }
}

// ============================================================
// specs/085-multi-ecosystem-dependency-audit/spec.md — real ecosystem
// detection + per-ecosystem manifest/lockfile parsing, all pure file
// reading (packages/agents/security/dependency-manifests.ts), no
// execution anywhere. npm's own unpinned-check section stays computed
// from package.json alone, unconditionally, so it (and the unlabeled
// top-level header) is byte-identical to before this spec regardless of
// whether a lockfile is present — see that spec's own §3 for the full
// reasoning behind this split.
// ============================================================
const ECOSYSTEM_HEADER_LABEL: Record<Ecosystem, string> = {
  npm: "", // deliberately unlabeled — the pre-085 exact header, unconditionally
  PyPI: " (PyPI)",
  Go: " (Go)",
  Packagist: " (Packagist)",
  Maven: " (Maven)",
}

/** specs/085 §3 — the vulnerability-lookup dependency list prefers a
 *  lockfile when one exists (npm/Packagist only — see that spec's own
 *  per-ecosystem breakdown for why Go/Python/Maven have no equivalent),
 *  because completeness (direct + transitive) is exactly what that
 *  check benefits from. Falls back to the same list the unpinned-check
 *  section already used when no lockfile exists — never a separate,
 *  independently-maintained dependency list. */
async function resolveVulnCheckSource(
  ecosystem: Ecosystem,
  projectPath: string,
  manifestDeps: DependencyEntry[],
): Promise<{ entries: DependencyEntry[]; sourceLabel: string | null }> {
  if (ecosystem === "npm") {
    const lock = await readNpmLockfile(projectPath)
    if (lock) return { entries: lock, sourceLabel: "package-lock.json" }
  }
  if (ecosystem === "Packagist") {
    const lock = await readComposerLockfile(projectPath)
    if (lock) return { entries: lock, sourceLabel: "composer.lock" }
  }
  return { entries: manifestDeps, sourceLabel: null }
}

// ============================================================
// SKILL — AUDIT DEPENDENCIES
// ============================================================
async function skillAuditDependencies(text: string): Promise<string> {
  const projectPath = resolveTargetPath(text)
  if (!existsSync(projectPath)) throw new Error(`Path not found: ${projectPath}`)

  const detection = detectEcosystem(projectPath)
  if (!detection) {
    throw new Error(`No dependency manifest found at: ${projectPath} (checked: ${MANIFEST_FILES_CHECKED.join(", ")})`)
  }
  const { ecosystem, manifestFile } = detection

  // dependencies: the full list (for the "Total dependencies" count and
  // the vuln-check fallback); unpinned: only the subset with a
  // non-exact version (empty, and not shown at all, for Go — see below).
  let dependencies: DependencyEntry[]
  let unpinned: [string, string][]
  let hasUnpinnedConcept = true

  if (ecosystem === "npm") {
    const result = await readNpmManifest(projectPath)
    dependencies = Object.entries(result.dependencies).map(([name, version]) => ({ name, version: String(version) }))
    unpinned = result.unpinned
  } else if (ecosystem === "PyPI") {
    const result = await readPyPiManifest(projectPath, manifestFile)
    dependencies = Object.entries(result.dependencies).map(([name, version]) => ({ name, version: String(version) }))
    unpinned = result.unpinned
  } else if (ecosystem === "Go") {
    dependencies = await readGoMod(projectPath)
    unpinned = []
    hasUnpinnedConcept = false // Go module versions are always exact — nothing to flag
  } else if (ecosystem === "Packagist") {
    const result = await readComposerManifest(projectPath)
    dependencies = Object.entries(result.dependencies).map(([name, version]) => ({ name, version: String(version) }))
    unpinned = result.unpinned
  } else {
    dependencies = await readPomXml(projectPath)
    unpinned = []
    hasUnpinnedConcept = false // Maven versions in a POM are declarations, not ranges — same reasoning as Go
  }

  const lines = [
    `=== Dependency Audit${ECOSYSTEM_HEADER_LABEL[ecosystem]} ===`,
    `Path: ${projectPath}`,
    `Total dependencies: ${dependencies.length}`,
    ``,
  ]

  if (hasUnpinnedConcept) {
    if (unpinned.length === 0) {
      lines.push("All dependencies are pinned.")
    } else {
      lines.push("Unpinned versions:")
      unpinned.forEach(([name, version]) => lines.push(`  - ${name}: "${version}"`))
    }
  }

  let baseText = lines.join("\n")

  // specs/084 §2/§4 — a third, wholly separate, deterministic section;
  // computed BEFORE withAiCommentary() so any LLM commentary below still
  // only ever sees deterministic text, never makes its own external call.
  if (isExternalDataFlagSet()) {
    const { entries, sourceLabel } = await resolveVulnCheckSource(ecosystem, projectPath, dependencies)
    const depsRecord: Record<string, string> = {}
    for (const d of entries) depsRecord[d.name] = d.version
    baseText += `\n\n${await buildVulnerabilitySection(depsRecord, ecosystem, sourceLabel)}`
  }

  const allDependencies: Record<string, string> = {}
  for (const d of dependencies) allDependencies[d.name] = d.version

  return withAiCommentary(baseText, async (model) => {
    const enrichment = await runAuditDependenciesEnrichment({
      model,
      unpinned: unpinned.map(([name, version]) => ({ name, version: String(version) })),
      allDependencies,
    })
    if (!enrichment) return null
    if (enrichment.generalNotes.length === 0) return `=== AI Commentary ===\nNo additional risk notes beyond the deterministic check above.`

    return [`=== AI Commentary ===`, ...enrichment.generalNotes.map((n) => `  - ${n}`)].join("\n")
  })
}

// ============================================================
// TASK PROCESSOR
// ============================================================
// All three skills are read-only — no NEEDS_APPROVAL set, no resumeTask.
// This agent never writes to disk, so no task ever reaches input-required.
async function processTask(task: ValidatedTask): Promise<void> {
  const text  = task.text
  // specs/030 — an authoritative selection wins outright; absent selection
  // falls back to the existing detector, unchanged.
  const skill = task.selectedSkill ?? detectSkill(text)
  taskMeta.set(task.id, { skill, createdAt: Date.now() })

  tasks.set(task.id, { id: task.id, status: "working", step: `Skill detected: ${skill}` })

  try {
    let result = ""
    if (skill === "scan-secrets")                 result = await skillScanSecrets(text)
    else if (skill === "check-gitignore-coverage") result = await skillCheckGitignoreCoverage(text)
    else if (skill === "audit-dependencies")       result = await skillAuditDependencies(text)
    else result = `Skill "${skill}" not implemented yet`
    tasks.set(task.id, { id: task.id, status: "completed", result })
  } catch (err) {
    tasks.set(task.id, { id: task.id, status: "failed", error: errorMessage(err) })
  }
}

// ============================================================
// HONO APP
// ============================================================
export const app = new Hono()

app.get("/.well-known/agent.json", (c) => c.json(agentCard))
app.get("/healthz", (c) => c.json({ status: "ok", agent: agentCard.name, tasks: tasks.size }))

app.post("/", async (c) => {
  const bodyResult = await readJsonBody(c.req.raw)
  if (!bodyResult.ok) return c.json({ error: bodyResult.error }, 400)

  const parsed = parseTaskEnvelope(bodyResult.body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const { task } = parsed
  if (tasks.has(task.id)) return c.json({ error: `Task ID already exists: ${task.id}` }, 409)

  // specs/030 — reject an invalid/foreign explicit selection here, before
  // any storage or background work, and never fall back to text detection
  // for it. An absent selectedSkill always passes through unchanged.
  const ownership = validateSelectedSkillOwnership(task, OWNED_SKILL_IDS)
  if (!ownership.ok) return c.json({ error: ownership.error }, 400)

  tasks.set(task.id, { id: task.id, status: "submitted" })
  processTask(task).catch((err) => {
    tasks.set(task.id, { id: task.id, status: "failed", error: errorMessage(err) })
  })
  return c.json({ id: task.id, status: "submitted" })
})

app.get("/tasks", (c) => {
  return c.json({ count: tasks.size, tasks: Array.from(tasks.values()) })
})

app.get("/tasks/:id", (c) => {
  const task = tasks.get(c.req.param("id"))
  if (!task) return c.json({ error: "Task not found" }, 404)
  return c.json(task)
})

app.get("/tasks/:id/stream", (c) => {
  const id = c.req.param("id")
  return new Response(
    new ReadableStream({
      async start(controller) {
        const enc  = new TextEncoder()
        const send = (d: object) => controller.enqueue(enc.encode(`data: ${JSON.stringify(d)}\n\n`))
        for (let i = 0; i < 120; i++) {
          const t = tasks.get(id)
          if (!t) { send({ error: "not found" }); break }
          send(t)
          if (["completed", "failed"].includes(t.status)) break
          await Bun.sleep(500)
        }
        controller.close()
      }
    }),
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
  )
})

// ============================================================
// DASHBOARD — no Approve/Reject anywhere; every task either
// completes or fails on its own, no human-in-the-loop gate exists.
// ============================================================
app.get("/dashboard", (c) => {
  const all = Array.from(tasks.values()).reverse()

  const statusColor: Record<string, string> = {
    submitted: "#9ca3af",
    working:   "#58a6ff",
    completed: "#3fb950",
    failed:    "#f85149",
  }

  const rows = all.length === 0
    ? `<tr><td colspan="4" class="empty">No tasks yet — send one below</td></tr>`
    : all.map(t => `
        <tr>
          <td><code>${t.id}</code></td>
          <td><span class="badge" style="color:${statusColor[t.status] ?? "#fff"}">${t.status}</span></td>
          <td class="muted">${t.step ?? "-"}</td>
          <td>
            ${t.status === "completed" ? `
              <button class="btn gray" onclick="viewResult('${t.id}')">View Result</button>
            ` : t.status === "failed" ? `
              <button class="btn gray" onclick="viewError('${t.id}')">View Error</button>
            ` : "-"}
          </td>
        </tr>
      `).join("")

  const completed = all.filter(t => t.status === "completed").length
  const failed    = all.filter(t => t.status === "failed").length

  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>OrchestrAI — Security Agent</title>
  <meta charset="utf-8">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:2rem;font-size:14px}
    h1{color:#58a6ff;font-size:18px;margin-bottom:4px}
    .sub{color:#8b949e;font-size:12px;margin-bottom:1.5rem}
    .stats{display:flex;gap:12px;margin-bottom:1.5rem;flex-wrap:wrap}
    .stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 20px;min-width:110px}
    .stat-n{font-size:24px;font-weight:bold;color:#c9d1d9}
    .stat-l{font-size:11px;color:#8b949e;margin-top:2px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.25rem;margin-bottom:1.25rem}
    .card-title{font-size:13px;color:#58a6ff;margin-bottom:1rem;font-weight:bold}
    .quick{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
    .qbtn{background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:5px 12px;border-radius:4px;cursor:pointer;font-size:12px;font-family:monospace}
    .qbtn:hover{background:#30363d}
    .input-row{display:flex;gap:8px}
    input{flex:1;padding:8px 12px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-family:monospace;font-size:13px}
    input:focus{outline:none;border-color:#58a6ff}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;padding:8px 12px;border-bottom:1px solid #30363d;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
    td{padding:10px 12px;border-bottom:1px solid #21262d;font-size:13px;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    .empty{text-align:center;color:#8b949e;padding:2rem!important}
    code{background:#0d1117;padding:2px 6px;border-radius:3px;font-size:12px;color:#79c0ff}
    .badge{font-size:12px;font-weight:bold}
    .muted{color:#8b949e;font-size:12px}
    .btn{padding:4px 12px;border-radius:4px;border:none;cursor:pointer;font-size:12px;font-family:monospace;margin-right:4px}
    .btn.gray {background:#21262d;color:#c9d1d9;border:1px solid #30363d}
    .btn.blue {background:#1f6feb;color:#fff}
    .toast{position:fixed;bottom:1.5rem;right:1.5rem;padding:10px 16px;border-radius:6px;font-size:13px;display:none;z-index:999}
    .overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:center;justify-content:center}
    .modal{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.5rem;max-width:680px;width:90%;max-height:80vh;overflow-y:auto}
    .modal h3{color:#58a6ff;margin-bottom:1rem;font-size:14px}
    .modal pre{background:#0d1117;padding:1rem;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;line-height:1.6}
  </style>
</head>
<body>
  <h1>OrchestrAI — Security Agent</h1>
  <p class="sub">Port 3005 &nbsp;·&nbsp; Auto-refreshes every 3s</p>

  <div class="stats">
    <div class="stat"><div class="stat-n">${all.length}</div><div class="stat-l">Total</div></div>
    <div class="stat"><div class="stat-n" style="color:#3fb950">${completed}</div><div class="stat-l">Completed</div></div>
    <div class="stat"><div class="stat-n" style="color:#f85149">${failed}</div><div class="stat-l">Failed</div></div>
  </div>

  <div class="card">
    <div class="card-title">Send Task</div>
    <div class="quick">
      <button class="qbtn" onclick="q('scan for secrets in my project')">Scan for Secrets</button>
      <button class="qbtn" onclick="q('check gitignore coverage')">Check .gitignore</button>
      <button class="qbtn" onclick="q('audit dependencies')">Audit Dependencies</button>
    </div>
    <div class="input-row">
      <input id="inp" type="text" placeholder="or type a custom task and press Enter..."
        onkeydown="if(event.key==='Enter') send()" />
      <button class="btn blue" onclick="send()">Send</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Tasks</div>
    <table>
      <thead><tr><th>Task ID</th><th>Status</th><th>Step</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="toast" id="toast"></div>

  <div class="overlay" id="overlay" onclick="closeModal()">
    <div class="modal" onclick="event.stopPropagation()">
      <h3 id="modal-title">Result</h3>
      <pre id="modal-body"></pre>
      <button class="btn gray" style="margin-top:1rem" onclick="closeModal()">Close</button>
    </div>
  </div>

  <script>
    let n = Date.now()

    function toast(msg, color) {
      const t = document.getElementById('toast')
      t.textContent = msg
      t.style.background = color || '#238636'
      t.style.color = '#fff'
      t.style.display = 'block'
      setTimeout(() => t.style.display = 'none', 2500)
    }

    async function send(text) {
      const inp = document.getElementById('inp')
      const txt = text ?? inp.value.trim()
      if (!txt) return
      const id = 'task-' + (n++)
      await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, message: { role: 'user', parts: [{ text: txt }] } })
      })
      inp.value = ''
      toast('Submitted: ' + id)
      setTimeout(() => location.reload(), 1200)
    }

    function q(text) { send(text) }

    async function viewResult(id) {
      const r = await fetch('/tasks/' + id)
      const d = await r.json()
      document.getElementById('modal-title').textContent = 'Result — ' + id
      document.getElementById('modal-body').textContent = d.result || '(empty)'
      document.getElementById('overlay').style.display = 'flex'
    }

    async function viewError(id) {
      const r = await fetch('/tasks/' + id)
      const d = await r.json()
      document.getElementById('modal-title').textContent = 'Error — ' + id
      document.getElementById('modal-body').textContent = d.error || '(no error message)'
      document.getElementById('overlay').style.display = 'flex'
    }

    function closeModal() {
      document.getElementById('overlay').style.display = 'none'
    }

    setTimeout(() => location.reload(), 30000)
  </script>
</body>
</html>`)
})

// ============================================================
// START
// ============================================================
// Exported + guarded (specs/017-standalone-binary-distribution/spec.md) so a
// combined binary can import this module and start it on demand without
// it auto-starting merely by being imported. `bun run
// packages/agents/security/index.ts` is unaffected — import.meta.main is
// still true for that exact invocation, same as before this change.
const PORT = resolveServicePort("security")

export function start() {
  serve({ fetch: app.fetch, port: PORT })

  // specs/107-task-and-conversation-history/spec.md B4 — so a task
  // dispatched directly to this agent (A2A, TUI direct mode — never
  // routed through the Orchestrator) is still recorded. This agent has
  // no existing shutdown()/SIGINT handling to wire a stop() into, so the
  // sweep just runs for the process's lifetime like every other
  // module-level timer here (its own setInterval is already unref()'d).
  startTaskPersistenceSweep("security-agent", tasks, (id) => taskMeta.get(id) ?? null)

  const harnessStartup = readLlmHarnessStartupState()
  if (harnessStartup.warning) console.warn(`[security-agent] WARNING: ${harnessStartup.warning}`)
  console.log(`
Security Agent running
Dashboard → http://localhost:${PORT}/dashboard
Agent Card → http://localhost:${PORT}/.well-known/agent.json
LLM commentary: ${harnessStartup.summary}
`)
}

if (import.meta.main) {
  start()
}
