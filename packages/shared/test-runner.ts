import { existsSync } from "fs"
import { readFile } from "fs/promises"
import * as path from "path"

// ============================================================
// SHARED TEST-RUNNER HELPERS
// ============================================================
// specs/138: the fixed command table (RUNNER_ARGV) and the MCP run_tests
// tool that executed it were removed — the model now proposes every test
// command (each individually approved, run via run_command). What stays:
// detectRunner() (a hint for that proposal, and write-tests' framework
// choice), the sanitized environment run_command uses, and the result
// parsers, now best-effort across more runners.

// specs/058-testing-agent-multi-ecosystem-runner-detection/spec.md — the
// original two-value Runner ("bun" | "pytest" | "none") classified ANY
// package.json with a scripts.test string as "bun", regardless of whether
// the project actually used npm/pnpm/yarn or ran Jest/Vitest under the
// hood. RunnerProfile is every command this table can actually produce;
// DetectionResult is the richer, honest answer detectRunner() now returns
// — never a guess when the real signal is missing or conflicting.
export type RunnerProfile = "bun" | "npm" | "pnpm" | "yarn" | "jest" | "vitest" | "pytest"

export type DetectionResult =
  | { kind: "detected"; runner: RunnerProfile }
  | { kind: "ambiguous"; candidates: RunnerProfile[] }
  | { kind: "unsupported" }

export const FIXED_TEST_TIMEOUT_MS = 120_000
export const TEST_OUTPUT_MAX_BYTES = 64 * 1024

// Minimal cross-platform allowlist required for executable lookup and
// temporary/user directories. Never spreads the full parent environment —
// ORCHESTRAI_* and any secret/token/password/credential values are excluded
// by construction (allowlist, not a denylist).
const ENV_ALLOWLIST_KEYS = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "windir",
  "TEMP", "TMP", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "ComSpec",
]

export function buildSanitizedTestEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.NO_COLOR = "1"
  env.FORCE_COLOR = "0"
  return env
}

async function readJsonIfPresent(filePath: string): Promise<any | null> {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(await readFile(filePath, "utf-8"))
  } catch {
    return null
  }
}

function hasDependency(pkg: any, name: string): boolean {
  return Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name])
}

const JEST_CONFIG_FILES = ["jest.config.js", "jest.config.ts", "jest.config.cjs", "jest.config.mjs", "jest.config.json"]
const VITEST_CONFIG_FILES = ["vitest.config.js", "vitest.config.ts", "vitest.config.mjs", "vitest.config.cjs"]

// specs/058 — real, evidence-grounded signals, never a package.json-
// presence guess. Framework signals (Jest/Vitest) are checked ahead of
// package-manager lockfiles: a real Jest project almost always also has
// an npm/pnpm/yarn lockfile, and running the framework directly (`npx
// jest`) is a more specific, more correct answer than the generic `<pm>
// test` — the two are complementary, not competing, so this ordering is
// not itself a source of ambiguity. Ambiguity is reserved for genuinely
// conflicting signals of the SAME kind: two framework configs, or two
// package-manager lockfiles, both present at once.
export async function detectRunner(projectPath: string): Promise<DetectionResult> {
  const pkgPath = path.join(projectPath, "package.json")
  const pkg = await readJsonIfPresent(pkgPath)
  const hasTestScript = Boolean(pkg?.scripts && typeof pkg.scripts.test === "string")

  if (pkg && hasTestScript) {
    const frameworkCandidates: RunnerProfile[] = []
    const hasJestConfig = JEST_CONFIG_FILES.some((f) => existsSync(path.join(projectPath, f))) || Boolean(pkg.jest) || hasDependency(pkg, "jest")
    const hasVitestConfig = VITEST_CONFIG_FILES.some((f) => existsSync(path.join(projectPath, f))) || hasDependency(pkg, "vitest")
    if (hasJestConfig) frameworkCandidates.push("jest")
    if (hasVitestConfig) frameworkCandidates.push("vitest")

    if (frameworkCandidates.length > 1) return { kind: "ambiguous", candidates: frameworkCandidates }
    if (frameworkCandidates.length === 1) return { kind: "detected", runner: frameworkCandidates[0] }

    const lockfileCandidates: RunnerProfile[] = []
    if (existsSync(path.join(projectPath, "bun.lock")) || existsSync(path.join(projectPath, "bun.lockb"))) lockfileCandidates.push("bun")
    if (existsSync(path.join(projectPath, "package-lock.json"))) lockfileCandidates.push("npm")
    if (existsSync(path.join(projectPath, "pnpm-lock.yaml"))) lockfileCandidates.push("pnpm")
    if (existsSync(path.join(projectPath, "yarn.lock"))) lockfileCandidates.push("yarn")

    if (lockfileCandidates.length > 1) return { kind: "ambiguous", candidates: lockfileCandidates }
    if (lockfileCandidates.length === 1) return { kind: "detected", runner: lockfileCandidates[0] }

    // No competing lockfile at all — the original, unchanged default.
    return { kind: "detected", runner: "bun" }
  }

  if (existsSync(path.join(projectPath, "requirements.txt")) ||
      existsSync(path.join(projectPath, "pyproject.toml"))) {
    return { kind: "detected", runner: "pytest" }
  }

  return { kind: "unsupported" }
}

// specs/044-conversational-ask-layer/spec.md — Phase 2, deterministic half.
//
// check-coverage is the one skill that adds --coverage/--cov, yet nothing
// ever extracted the number it produces: parseTestCounts() below reads
// only pass/fail counts, so "is there test coverage?" could only ever be
// answered by a human scanning the raw dump. These two patterns were
// written against REAL captured output from both supported runners, not
// from documentation:
//
//   bun test --coverage   All files         |   75.00 |  100.00 |
//                         (File | % Funcs | % Lines | Uncovered Line #s)
//
//   pytest --cov          TOTAL              7      1    86%
//
// Line coverage is the reported figure for bun (the second column), since
// that is the conventional headline metric and the one pytest's own
// single percentage corresponds to. Returns null rather than guessing
// when neither shape is present — an absent number must read as absent,
// never as zero. specs/058 adds no new coverage-percent pattern for
// npm/pnpm/yarn/jest/vitest — each has its own output format this
// codebase has no real captured sample of yet; an absent number there is
// the honest result, not a regression.
const PYTEST_COVERAGE_PATTERN = /^TOTAL\s+.*?(\d+(?:\.\d+)?)\s*%/m

// specs/138 — the "All files |" summary row: bun prints 2 numeric columns
// (% Funcs, % Lines); jest/vitest (istanbul) print 4 (% Stmts, % Branch,
// % Funcs, % Lines). Line coverage is the headline either way, so pick it
// by column count rather than assume bun's layout. `go test -cover` prints
// "coverage: 71.4% of statements".
const ALL_FILES_ROW = /^All files\s*\|(.*)$/m
const GO_COVERAGE_PATTERN = /coverage:\s*(\d+(?:\.\d+)?)%\s+of statements/

export function parseCoveragePercent(output: string): number | null {
  const allFiles = output.match(ALL_FILES_ROW)
  if (allFiles) {
    const numbers = allFiles[1]!.split("|").map((cell) => parseFloat(cell.trim())).filter((n) => Number.isFinite(n))
    const lines = numbers.length >= 4 ? numbers[3] : numbers[1]
    if (lines !== undefined && Number.isFinite(lines)) return lines
  }
  for (const pattern of [PYTEST_COVERAGE_PATTERN, GO_COVERAGE_PATTERN]) {
    const match = output.match(pattern)
    if (match) {
      const value = parseFloat(match[1]!)
      if (Number.isFinite(value)) return value
    }
  }
  return null
}

/** Pass/fail counts from a test run's output, or null when the output
 *  isn't in a recognized format — never a guessed number (specs/138: the
 *  command is model-proposed now, so any runner's output can arrive).
 *  Recognized: bun ("4 pass"/"0 fail"); pytest, jest, vitest, cargo
 *  ("4 passed", "1 failed"); mocha ("4 passing"/"1 failing"); dotnet
 *  ("Passed: 4", "Failed: 1"); maven surefire ("Tests run: 5, Failures: 1,
 *  Errors: 0"); verbose go test ("--- PASS:"/"--- FAIL:" lines). A count
 *  absent from a recognized format (e.g. no failures printed) is 0. */
export function parseTestCounts(output: string): { passed: number; failed: number } | null {
  const surefire = [...output.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/g)].pop()
  if (surefire) {
    const run = parseInt(surefire[1]!), failures = parseInt(surefire[2]!), errors = parseInt(surefire[3]!)
    return { passed: Math.max(0, run - failures - errors), failed: failures + errors }
  }
  const dotnetPassed = output.match(/Passed:\s*(\d+)/)
  if (dotnetPassed) {
    const dotnetFailed = output.match(/Failed:\s*(\d+)/)
    return { passed: parseInt(dotnetPassed[1]!), failed: dotnetFailed ? parseInt(dotnetFailed[1]!) : 0 }
  }
  const passMatch = output.match(/(\d+)\s+(?:pass(?:ed)?|passing)\b/i)
  const failMatch = output.match(/(\d+)\s+(?:fail(?:ed)?|failing)\b/i)
  if (passMatch || failMatch) {
    return { passed: passMatch ? parseInt(passMatch[1]!) : 0, failed: failMatch ? parseInt(failMatch[1]!) : 0 }
  }
  const goPass = (output.match(/^\s*--- PASS:/gm) ?? []).length
  const goFail = (output.match(/^\s*--- FAIL:/gm) ?? []).length
  if (goPass + goFail > 0) return { passed: goPass, failed: goFail }
  return null
}
