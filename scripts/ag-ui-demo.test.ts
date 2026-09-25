import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { DEMO_APP_DIR, defaultTimeoutFor, isReadOnlyRoute, maxConcurrentSteps, parseDemoArgs, parseGroups, securityPrecheckEnabled, shouldCopyEntry } from "./ag-ui-demo"

describe("specs/142 demo groups", () => {
  test("default is core only, with the core budget", () => {
    const options = parseDemoArgs([], {})
    expect(options.groups).toEqual(["core"])
    expect(options.timeoutMs).toBe(defaultTimeoutFor(["core"]))
  })

  test("all means every preview group, plus real only with --allow-writes", () => {
    expect(parseGroups("all", false)).toEqual(["core", "chat", "parallel", "safety"])
    expect(parseGroups("all", true)).toEqual(["core", "chat", "parallel", "safety", "real"])
  })

  test("named groups keep the fixed order and drop duplicates", () => {
    expect(parseGroups("safety, chat,chat", false)).toEqual(["chat", "safety"])
  })

  test("real needs --allow-writes; unknown names are rejected", () => {
    expect(() => parseGroups("real", false)).toThrow("--allow-writes")
    expect(() => parseGroups("wat", false)).toThrow("Unknown group")
    expect(() => parseDemoArgs(["--groups"], {})).toThrow("requires a value")
  })

  test("an explicit timeout wins over the group budget", () => {
    expect(parseDemoArgs(["--groups", "all", "--timeout-ms", "9000"], {}).timeoutMs).toBe(9000)
  })

  test("copies leave out dependencies and OrchestrAI state", () => {
    expect(shouldCopyEntry("src/pricing.ts")).toBeTrue()
    expect(shouldCopyEntry(".git/HEAD")).toBeTrue()
    expect(shouldCopyEntry("node_modules/hono/index.js")).toBeFalse()
    expect(shouldCopyEntry(".orchestrai\\config.env")).toBeFalse()
  })
})

describe("specs/142 demo app", () => {
  test("the demo app is committed with its deliberate gaps", () => {
    expect(existsSync(join(DEMO_APP_DIR, "tests", "pricing.test.ts"))).toBeTrue()
    expect(existsSync(join(DEMO_APP_DIR, "src", "inventory.ts"))).toBeTrue()
    expect(existsSync(join(DEMO_APP_DIR, "Dockerfile"))).toBeFalse()
  })

  test("OrchestrAI's own bun test never runs the demo app's failing test", () => {
    const repo = join(DEMO_APP_DIR, "..", "..", "..")
    const result = Bun.spawnSync(["bun", "test", "context/demo/demo-app"], { cwd: repo, stdout: "pipe", stderr: "pipe" })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    expect(output).not.toContain("(fail)")
    expect(output).not.toMatch(/\b1 fail\b/)
  }, 30_000)
})

describe("specs/131 scenario expectations", () => {
  test("the Security A2A pre-check is expected only when opted in", () => {
    expect(securityPrecheckEnabled({})).toBeFalse()
    expect(securityPrecheckEnabled({ ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK: "0" })).toBeFalse()
    expect(securityPrecheckEnabled({ ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK: "1" })).toBeTrue()
  })

  test("scenario 5 accepts any read-only skill and rejects writes", () => {
    expect(isReadOnlyRoute("scan-secrets")).toBeTrue()
    expect(isReadOnlyRoute("dockerize")).toBeFalse()
    expect(isReadOnlyRoute("plan-task")).toBeFalse()
    expect(isReadOnlyRoute(undefined)).toBeFalse()
  })
})

describe("AG-UI demo arguments", () => {
  test("uses environment defaults without enabling writes", () => {
    const options = parseDemoArgs([], {
      ORCHESTRAI_PROJECT_PATH: "C:\\work\\fixture",
      ORCHESTRAI_ORCHESTRATOR_URL: "http://localhost:3999",
    })
    expect(options.project).toBe("C:\\work\\fixture")
    expect(options.orchestrator).toBe("http://localhost:3999")
    expect(options.allowWrites).toBeFalse()
  })

  test("explicit arguments override the environment", () => {
    const options = parseDemoArgs([
      "--project", "C:\\work\\other",
      "--orchestrator", "http://localhost:3000",
      "--timeout-ms", "30000",
      "--allow-writes",
    ], { ORCHESTRAI_PROJECT_PATH: "C:\\work\\fixture" })
    expect(options.project).toBe("C:\\work\\other")
    expect(options.timeoutMs).toBe(30_000)
    expect(options.allowWrites).toBeTrue()
  })

  test("rejects unknown, missing, and unsafe timeout arguments", () => {
    expect(() => parseDemoArgs(["--wat"])).toThrow("Unknown argument")
    expect(() => parseDemoArgs(["--project"])).toThrow("requires a value")
    expect(() => parseDemoArgs(["--timeout-ms", "100"])).toThrow("at least 5000")
  })
})

describe("real story — parallel steps", () => {
  const started = (runId: string) => ({ type: "STEP_STARTED", runId })
  const finished = (runId: string) => ({ type: "STEP_FINISHED", runId })

  test("overlapping steps count as parallel", () => {
    expect(maxConcurrentSteps([started("p"), started("p"), started("p"), finished("p"), finished("p"), finished("p")], "p")).toBe(3)
  })
  test("strictly sequential steps never exceed one", () => {
    expect(maxConcurrentSteps([started("p"), finished("p"), started("p"), finished("p")], "p")).toBe(1)
  })
  test("only the given plan's steps are counted", () => {
    expect(maxConcurrentSteps([started("p"), started("other"), finished("p")], "p")).toBe(1)
    expect(maxConcurrentSteps([], "p")).toBe(0)
  })
})
