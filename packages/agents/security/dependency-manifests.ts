// specs/085-multi-ecosystem-dependency-audit/spec.md
//
// Real, ecosystem-specific manifest/lockfile parsing — pure file
// reading throughout, no execution anywhere (see the spec's own
// design-history note for why an execution-based alternative was
// considered and rejected). Every parser here is read directly against
// a real, documented format; nothing is guessed.
import { existsSync } from "fs"
import { readFile } from "fs/promises"
import * as path from "path"

// specs/099-tui-port-url-and-analyze-project-stack-awareness/spec.md —
// detectEcosystem()/Ecosystem/EcosystemDetection/MANIFEST_FILES_CHECKED
// moved verbatim to packages/shared/detect-ecosystem.ts so
// packages/mcp/index.ts's own analyze_project tool can reuse them
// without this codebase's foundational MCP layer depending on an
// agent-specific package. Re-exported here unchanged so every existing
// import site in this file's own directory stays byte-identical.
export { type Ecosystem, type EcosystemDetection, detectEcosystem, MANIFEST_FILES_CHECKED } from "../../shared/detect-ecosystem"

export interface DependencyEntry {
  name: string
  version: string
}

// ============================================================
// npm — package.json (existing logic, extracted verbatim, unchanged)
// ============================================================
export interface NpmManifestResult {
  dependencies: Record<string, string>
  unpinned: [string, string][]
}

export async function readNpmManifest(projectPath: string): Promise<NpmManifestResult> {
  const pkgPath = path.join(projectPath, "package.json")
  let pkg: any
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
  } catch (err: any) {
    throw new Error(`Could not parse package.json: ${err.message}`)
  }
  const dependencies: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const unpinned = Object.entries(dependencies).filter(([, version]) => version === "*" || version === "latest") as [string, string][]
  return { dependencies, unpinned }
}

// specs/085 §3 — npm's own package-lock.json (lockfileVersion 2/3, the
// version every current npm produces), checked live against npm's own
// real docs before this was written: a flat top-level `packages` object
// mapping each install path (e.g. "node_modules/left-pad", or a nested
// path for a duplicated transitive dependency) to {version, ...} — the
// full resolved tree, direct AND transitive, already flattened, no
// manual tree-walking needed. The root project's own entry uses the key
// "" and is skipped (it isn't a dependency of itself).
export async function readNpmLockfile(projectPath: string): Promise<DependencyEntry[] | null> {
  const lockPath = path.join(projectPath, "package-lock.json")
  if (!existsSync(lockPath)) return null
  let lock: any
  try {
    lock = JSON.parse(await readFile(lockPath, "utf-8"))
  } catch (err: any) {
    throw new Error(`Could not parse package-lock.json: ${err.message}`)
  }
  const packages = lock.packages
  if (!packages || typeof packages !== "object") return null

  const result: DependencyEntry[] = []
  for (const [key, meta] of Object.entries(packages)) {
    if (key === "") continue // the root project's own entry, not a dependency
    const version = (meta as any)?.version
    if (typeof version !== "string") continue
    // e.g. "node_modules/foo" or "node_modules/foo/node_modules/bar" — the
    // real package name is the last "node_modules/<name>" segment. A
    // scoped package ("@scope/name") keeps its own slash intact.
    const match = key.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/)
    const name = match?.[1]
    if (!name) continue
    result.push({ name, version })
  }
  return result
}

// ============================================================
// PyPI — requirements.txt / pyproject.toml
// ============================================================
// specs/085 §2 — one dependency per line, name==version (exact pin) or
// any other operator/no version at all (a range or unconstrained — both
// flagged unpinned, extending the existing unpinned concept to mean "no
// exact version," not just npm's two literal strings). Comment lines
// (#) and blank lines skipped; -r other.txt includes not followed
// (Non-Goals).
const REQUIREMENTS_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(==|>=|<=|~=|!=|>|<)?\s*([^\s;#]*)/

export function parseRequirementsTxt(content: string): NpmManifestResult {
  const dependencies: Record<string, string> = {}
  const unpinned: [string, string][] = []
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("#") || line.startsWith("-")) continue
    const match = line.match(REQUIREMENTS_LINE)
    if (!match) continue
    const [, name, operator, version] = match
    const spec = operator ? `${operator}${version}` : (version || "")
    dependencies[name!] = spec
    if (operator !== "==" || !version) {
      unpinned.push([name!, spec || "(no version specified)"])
    }
  }
  return { dependencies, unpinned }
}

// PEP 621's own [project.dependencies] array (a list of PEP 508 strings
// like "requests>=2.0") vs. Poetry's own [tool.poetry.dependencies]
// table (a map of name -> version-spec string, or name -> {version:
// ...}). Both real, both genuinely different shapes — checked against
// real example files before this was written, not assumed. Deliberately
// not a general TOML parser (no new dependency, matching lint_ci_
// workflow's own precedent) — narrow, targeted extraction for exactly
// these two known shapes.
export function parsePyprojectToml(content: string): NpmManifestResult {
  const dependencies: Record<string, string> = {}
  const unpinned: [string, string][] = []

  const pep621Match = content.match(/\[project\][^[]*?dependencies\s*=\s*\[([\s\S]*?)\]/)
  if (pep621Match) {
    const entries = pep621Match[1]!.match(/["']([^"']+)["']/g) ?? []
    for (const raw of entries) {
      const spec = raw.slice(1, -1).trim()
      const specMatch = spec.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(==|>=|<=|~=|!=|>|<)?\s*(.*)$/)
      if (!specMatch) continue
      const [, name, operator, version] = specMatch
      const versionSpec = operator ? `${operator}${version}` : ""
      dependencies[name!] = versionSpec
      if (operator !== "==" || !version) unpinned.push([name!, versionSpec || "(no version specified)"])
    }
    return { dependencies, unpinned }
  }

  const poetryMatch = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/)
  if (poetryMatch) {
    const lines = poetryMatch[1]!.split("\n")
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (line.length === 0 || line.startsWith("#")) continue
      const kv = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/)
      if (!kv) continue
      const [, name, rawValue] = kv
      if (name === "python") continue // the Python version constraint itself, not a real package
      const versionStr = rawValue!.trim().replace(/^["']|["']$/g, "")
      // A table value like { version = "^1.0", ... } — extract just the version field.
      const tableVersion = versionStr.match(/version\s*=\s*["']([^"']+)["']/)
      const spec = tableVersion ? tableVersion[1]! : versionStr
      dependencies[name!] = spec
      if (spec !== "" && !/^\d/.test(spec)) unpinned.push([name!, spec])
      else if (spec === "*" || spec === "") unpinned.push([name!, spec || "(no version specified)"])
    }
  }

  return { dependencies, unpinned }
}

export async function readPyPiManifest(projectPath: string, manifestFile: string): Promise<NpmManifestResult> {
  const filePath = path.join(projectPath, manifestFile)
  let content: string
  try {
    content = await readFile(filePath, "utf-8")
  } catch (err: any) {
    throw new Error(`Could not read ${manifestFile}: ${err.message}`)
  }
  return manifestFile === "requirements.txt" ? parseRequirementsTxt(content) : parsePyprojectToml(content)
}

// ============================================================
// Go — go.mod
// ============================================================
// specs/085 §2 — require block entries, "module version" per line. Go's
// own module versions are already exact (github.com/foo/bar v1.2.3), so
// there is no "unpinned" concept here at all — the unpinned section of
// the report is simply omitted for Go (see index.ts's own caller).
// Handles both the block form (require (...)) and a single-line
// `require module version` statement. Modern go.mod (1.17+) marks
// indirect dependencies with a trailing "// indirect" comment — kept in
// the result (not filtered out), since an indirect dependency is a real
// dependency that can genuinely be vulnerable.
export function parseGoMod(content: string): DependencyEntry[] {
  const result: DependencyEntry[] = []
  const blockMatch = content.match(/require\s*\(([\s\S]*?)\)/)
  if (blockMatch) {
    for (const rawLine of blockMatch[1]!.split("\n")) {
      const line = rawLine.trim()
      if (line.length === 0 || line.startsWith("//")) continue
      const entry = line.match(/^(\S+)\s+(v\S+)/)
      if (entry) result.push({ name: entry[1]!, version: entry[2]! })
    }
  }
  const singleLineMatches = content.matchAll(/^require\s+(\S+)\s+(v\S+)/gm)
  for (const m of singleLineMatches) result.push({ name: m[1]!, version: m[2]! })
  return result
}

export async function readGoMod(projectPath: string): Promise<DependencyEntry[]> {
  const filePath = path.join(projectPath, "go.mod")
  let content: string
  try {
    content = await readFile(filePath, "utf-8")
  } catch (err: any) {
    throw new Error(`Could not read go.mod: ${err.message}`)
  }
  return parseGoMod(content)
}

// ============================================================
// Packagist — composer.json / composer.lock
// ============================================================
// specs/085 §2 — JSON, same shape as package.json: require/require-dev
// objects, Composer's own version-constraint syntax (^, ~, exact).
// Platform packages (php, ext-*, lib-*) are EXCLUDED entirely — they
// aren't real installable packages OSV could ever have data for.
// A real, previously-undiscovered bug found while writing this file's
// own tests: an earlier version of this regex was /^(php|hhvm|ext-|...)/
// with no boundary after "php"/"hhvm" — it matched "phpunit/phpunit" as
// a prefix match, silently excluding a completely real, common package
// from the audit. "php"/"hhvm" are exact platform-package names (no
// real Packagist package is named exactly that); "ext-"/"lib-"/
// "composer-" genuinely are safe prefix matches, since no real package
// vendor namespace collides with them the way "php" does with "phpunit".
const PLATFORM_PACKAGE = /^(php|hhvm)$|^(ext-|lib-|composer-)/

function isPinnedComposerVersion(spec: string): boolean {
  // A bare, exact version string (e.g. "2.9.1") — no range operator,
  // no wildcard, no "dev-"/branch alias.
  return /^\d+(\.\d+){0,3}(-[\w.]+)?$/.test(spec.trim())
}

export async function readComposerManifest(projectPath: string): Promise<NpmManifestResult> {
  const filePath = path.join(projectPath, "composer.json")
  let pkg: any
  try {
    pkg = JSON.parse(await readFile(filePath, "utf-8"))
  } catch (err: any) {
    throw new Error(`Could not parse composer.json: ${err.message}`)
  }
  const raw: Record<string, string> = { ...(pkg.require ?? {}), ...(pkg["require-dev"] ?? {}) }
  const dependencies: Record<string, string> = {}
  const unpinned: [string, string][] = []
  for (const [name, spec] of Object.entries(raw)) {
    if (PLATFORM_PACKAGE.test(name)) continue
    dependencies[name] = spec
    if (!isPinnedComposerVersion(spec)) unpinned.push([name, spec])
  }
  return { dependencies, unpinned }
}

// specs/085 §3 — composer.lock's real structure, confirmed against a
// real, live file (composer/composer's own repository), not assumed:
// top-level packages/packages-dev arrays, each entry a {name, version,
// ...} object.
export async function readComposerLockfile(projectPath: string): Promise<DependencyEntry[] | null> {
  const lockPath = path.join(projectPath, "composer.lock")
  if (!existsSync(lockPath)) return null
  let lock: any
  try {
    lock = JSON.parse(await readFile(lockPath, "utf-8"))
  } catch (err: any) {
    throw new Error(`Could not parse composer.lock: ${err.message}`)
  }
  const entries = [...(lock.packages ?? []), ...(lock["packages-dev"] ?? [])]
  const result: DependencyEntry[] = []
  for (const entry of entries) {
    if (typeof entry?.name === "string" && typeof entry?.version === "string") {
      result.push({ name: entry.name, version: entry.version })
    }
  }
  return result
}

// ============================================================
// Maven — pom.xml
// ============================================================
// specs/085 §2 — XML, no new parsing dependency (the same "no new
// package" principle specs/040/079 already established). A narrow,
// dependency-free extraction targets <dependency>...</dependency>
// blocks and their <groupId>/<artifactId>/<version> children
// specifically — not a general XML parser. Package name built as
// "groupId:artifactId", matching OSV's own documented format exactly.
function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return match ? match[1]!.trim() : null
}

export function parsePomXml(content: string): DependencyEntry[] {
  // Same-file <properties> substitution only — a placeholder defined in
  // a parent POM (Maven's own multi-module inheritance) is NOT
  // resolved; that dependency is reported with its literal unresolved
  // ${...} string rather than guessed at or silently dropped.
  const properties: Record<string, string> = {}
  const propsBlock = content.match(/<properties>([\s\S]*?)<\/properties>/)
  if (propsBlock) {
    const propMatches = propsBlock[1]!.matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)
    for (const m of propMatches) properties[m[1]!] = m[2]!.trim()
  }

  function resolve(value: string): string {
    const placeholder = value.match(/^\$\{([\w.-]+)\}$/)
    if (!placeholder) return value
    return properties[placeholder[1]!] ?? value // unresolved: keep the literal placeholder
  }

  const result: DependencyEntry[] = []
  const depBlocks = content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)
  for (const block of depBlocks) {
    const body = block[1]!
    const groupId = extractTag(body, "groupId")
    const artifactId = extractTag(body, "artifactId")
    const rawVersion = extractTag(body, "version")
    if (!groupId || !artifactId) continue
    const version = rawVersion ? resolve(rawVersion) : "(no version specified)"
    result.push({ name: `${groupId}:${artifactId}`, version })
  }
  return result
}

export async function readPomXml(projectPath: string): Promise<DependencyEntry[]> {
  const filePath = path.join(projectPath, "pom.xml")
  let content: string
  try {
    content = await readFile(filePath, "utf-8")
  } catch (err: any) {
    throw new Error(`Could not read pom.xml: ${err.message}`)
  }
  return parsePomXml(content)
}
