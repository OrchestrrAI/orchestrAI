import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { buildSanitizedTestEnv, detectRunner, parseCoveragePercent, parseTestCounts } from "./test-runner"

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "orchestrai-runner-"))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function writePkg(dir: string, pkg: object) {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg))
}

describe("detectRunner — existing Bun/pytest behavior, unaffected", () => {
  test(
    "detects bun from a bare package.json test script (no competing lockfile)",
    withTempDir(async (dir) => {
      writePkg(dir, { scripts: { test: "bun test" } })
      expect(await detectRunner(dir)).toEqual({ kind: "detected", runner: "bun" })
    }),
  )

  test(
    "detects pytest from requirements.txt",
    withTempDir(async (dir) => {
      writeFileSync(path.join(dir, "requirements.txt"), "pytest\n")
      expect(await detectRunner(dir)).toEqual({ kind: "detected", runner: "pytest" })
    }),
  )

  test(
    "returns unsupported when nothing is configured",
    withTempDir(async (dir) => {
      expect(await detectRunner(dir)).toEqual({ kind: "unsupported" })
    }),
  )
})

describe("detectRunner — specs/058 real multi-ecosystem detection", () => {
  test(
    "a real Node/Jest fixture is detected as Jest, not Bun — the exact regression this spec fixes",
    withTempDir(async (dir) => {
      writePkg(dir, { scripts: { test: "jest" }, devDependencies: { jest: "^29.0.0" } })
      writeFileSync(path.join(dir, "package-lock.json"), "{}")
      expect(await detectRunner(dir)).toEqual({ kind: "detected", runner: "jest" })
    }),
  )

  test(
    "a real Node/Jest fixture is detected via jest.config.js alone",
    withTempDir(async (dir) => {
      writePkg(dir, { scripts: { test: "jest" } })
      writeFileSync(path.join(dir, "jest.config.js"), "module.exports = {}")
      expect(await detectRunner(dir)).toEqual({ kind: "detected", runner: "jest" })
    }),
  )

  test(
    "a real Node/Vitest fixture is detected as Vitest",
    withTempDir(async (dir) => {
      writePkg(dir, { scripts: { test: "vitest run" }, devDependencies: { vitest: "^1.0.0" } })
      writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 6")
      expect(await detectRunner(dir)).toEqual({ kind: "detected", runner: "vitest" })
    }),
  )

  test(
    "a real npm fixture (package-lock.json, no framework signal) is detected as npm",
    withTempDir(async (dir) => {
      writePkg(dir, { scripts: { test: "node ./run-tests.js" } })
      writeFileSync(path.join(dir, "package-lock.json"), "{}")
      expect(await detectRunner(dir)).toEqual({ kind: "detected", runner: "npm" })
    }),
  )

  test(
    "a real pnpm fixture (pnpm-lock.yaml, no framework signal) is detected as pnpm",
    withTempDir(async (dir) => {
      writePkg(dir, { scripts: { test: "node ./run-tests.js" } })
      writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 6")
      expect(await detectRunner(dir)).toEqual({ kind: "detected", runner: "pnpm" })
    }),
  )

  test(
    "a real yarn fixture (yarn.lock, no framework signal) is detected as yarn",
    withTempDir(async (dir) => {
      writePkg(dir, { scripts: { test: "node ./run-tests.js" } })
      writeFileSync(path.join(dir, "yarn.lock"), "# yarn lockfile v1")
      expect(await detectRunner(dir)).toEqual({ kind: "detected", runner: "yarn" })
    }),
  )

  test(
    "two conflicting lockfiles (npm and pnpm both present) report ambiguity, never a silent pick",
    withTempDir(async (dir) => {
      writePkg(dir, { scripts: { test: "node ./run-tests.js" } })
      writeFileSync(path.join(dir, "package-lock.json"), "{}")
      writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 6")
      const result = await detectRunner(dir)
      expect(result.kind).toBe("ambiguous")
      if (result.kind === "ambiguous") {
        expect(result.candidates.sort()).toEqual(["npm", "pnpm"])
      }
    }),
  )

  test(
    "two conflicting framework signals (jest and vitest both configured) report ambiguity",
    withTempDir(async (dir) => {
      writePkg(dir, { scripts: { test: "run-tests" } })
      writeFileSync(path.join(dir, "jest.config.js"), "module.exports = {}")
      writeFileSync(path.join(dir, "vitest.config.ts"), "export default {}")
      const result = await detectRunner(dir)
      expect(result.kind).toBe("ambiguous")
      if (result.kind === "ambiguous") {
        expect(result.candidates.sort()).toEqual(["jest", "vitest"])
      }
    }),
  )

  test(
    "an unparseable package.json falls through to the other checks rather than throwing",
    withTempDir(async (dir) => {
      writeFileSync(path.join(dir, "package.json"), "{ not valid json")
      writeFileSync(path.join(dir, "requirements.txt"), "pytest\n")
      expect(await detectRunner(dir)).toEqual({ kind: "detected", runner: "pytest" })
    }),
  )
})

// specs/138 — RUNNER_ARGV was removed (the model proposes every test
// command), so the parsers must read many runners' output — and say
// "not recognized" (null) rather than invent a number.
describe("parseTestCounts / parseCoveragePercent — widened (specs/138)", () => {
  test("recognizes the common runners", () => {
    expect(parseTestCounts("Tests:       1 failed, 4 passed, 5 total")).toEqual({ passed: 4, failed: 1 }) // jest
    expect(parseTestCounts(" Tests  6 passed (6)")).toEqual({ passed: 6, failed: 0 }) // vitest
    expect(parseTestCounts("  3 passing (12ms)\n  1 failing")).toEqual({ passed: 3, failed: 1 }) // mocha
    expect(parseTestCounts("test result: ok. 7 passed; 0 failed; 0 ignored")).toEqual({ passed: 7, failed: 0 }) // cargo
    expect(parseTestCounts("Passed!  - Failed:     0, Passed:     9, Skipped: 0")).toEqual({ passed: 9, failed: 0 }) // dotnet
    expect(parseTestCounts("Tests run: 10, Failures: 1, Errors: 1, Skipped: 0")).toEqual({ passed: 8, failed: 2 }) // maven
    expect(parseTestCounts("=== RUN TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)")).toEqual({ passed: 1, failed: 1 }) // go -v
  })
  test("unrecognized output is null, never a guessed 0", () => {
    expect(parseTestCounts("ok  \texample.com/pkg\t0.012s")).toBeNull()
    expect(parseTestCounts("")).toBeNull()
  })
  test("coverage: istanbul's 4-column row uses % Lines; bun's 2-column row uses % Lines; go's statement coverage", () => {
    expect(parseCoveragePercent("All files |   81.25 |    60.5 |   77.77 |   80.64 |")).toBe(80.64)
    expect(parseCoveragePercent("All files         |   75.00 |   82.35 |")).toBe(82.35)
    expect(parseCoveragePercent("ok  \tpkg\t0.2s\tcoverage: 71.4% of statements")).toBe(71.4)
  })
})

describe("parseTestCounts", () => {
  test("parses bun test output", () => {
    expect(parseTestCounts("4 pass\n0 fail")).toEqual({ passed: 4, failed: 0 })
  })

  test("parses pytest output", () => {
    expect(parseTestCounts("4 passed, 1 failed")).toEqual({ passed: 4, failed: 1 })
  })
})

describe("buildSanitizedTestEnv", () => {
  test("excludes ORCHESTRAI_* and arbitrary ambient variables", () => {
    process.env.ORCHESTRAI_TEST_SECRET_PROBE = "should-not-appear"
    try {
      const env = buildSanitizedTestEnv()
      expect(env.ORCHESTRAI_TEST_SECRET_PROBE).toBeUndefined()
      expect(Object.keys(env).every((k) => !k.startsWith("ORCHESTRAI_"))).toBe(true)
    } finally {
      delete process.env.ORCHESTRAI_TEST_SECRET_PROBE
    }
  })

  test("sets NO_COLOR/FORCE_COLOR for readable output", () => {
    const env = buildSanitizedTestEnv()
    expect(env.NO_COLOR).toBe("1")
    expect(env.FORCE_COLOR).toBe("0")
  })
})
