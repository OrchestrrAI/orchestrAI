import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkBaseline,
  checkConfig,
  checkOptIns,
  checkPorts,
  checkTerminal,
  classifyKeyFailure,
  exitCodeFor,
  main,
  parsePreflightArgs,
  redact,
} from "./demo-preflight"

describe("specs/131 demo preflight — pure checks", () => {
  test("arguments", () => {
    expect(parsePreflightArgs(["--live", "--baseline", "v1", "--skip-key"])).toEqual({ live: true, baseline: "v1", skipKey: true, help: false })
    expect(() => parsePreflightArgs(["--baseline"])).toThrow("requires a git ref")
    expect(() => parsePreflightArgs(["--wat"])).toThrow("Unknown argument")
  })

  test("config: missing folder is a FAIL naming the path; a key is reported only as present", () => {
    expect(checkConfig("X/.orchestrai/config.env", null).level).toBe("FAIL")
    expect(checkConfig("X/.orchestrai/config.env", null).detail).toContain("X/.orchestrai/config.env")
    expect(checkConfig("p", { ORCHESTRAI_LLM_PROVIDER: "anthropic" }).level).toBe("FAIL")
    const ok = checkConfig("p", { ORCHESTRAI_LLM_PROVIDER: "anthropic", ORCHESTRAI_LLM_API_KEY: "sk-ant-secret-value-123" })
    expect(ok.level).toBe("PASS")
    expect(ok.detail).toContain("key present")
    expect(ok.detail).not.toContain("sk-ant-secret-value-123")
  })

  test("key failures: auth is FAIL, rate limit and outage are WARN", () => {
    expect(classifyKeyFailure({ status: 401, message: "invalid x-api-key" }).level).toBe("FAIL")
    expect(classifyKeyFailure({ status: 429, message: "rate limit exceeded" }).level).toBe("WARN")
    expect(classifyKeyFailure({ message: "You exceeded your current quota" }).level).toBe("WARN")
    expect(classifyKeyFailure({ status: 503, message: "overloaded" }).level).toBe("WARN")
    expect(classifyKeyFailure({ status: 400, message: "model not found" }).level).toBe("FAIL")
  })

  test("terminal thresholds", () => {
    expect(checkTerminal(120, 40).level).toBe("PASS")
    expect(checkTerminal(80, 24).level).toBe("WARN")
    expect(checkTerminal(79, 24).level).toBe("FAIL")
    expect(checkTerminal(undefined, undefined).level).toBe("WARN")
  })

  test("ports: free or healthy passes; busy without a healthy service fails", () => {
    expect(checkPorts([{ service: "orchestrator", port: 3000, free: true, healthy: false }]).level).toBe("PASS")
    expect(checkPorts([{ service: "orchestrator", port: 3000, free: false, healthy: true }]).level).toBe("PASS")
    const busy = checkPorts([{ service: "devops", port: 3002, free: false, healthy: false }])
    expect(busy.level).toBe("FAIL")
    expect(busy.detail).toContain("devops:3002")
  })

  test("baseline and opt-ins", () => {
    expect(checkBaseline(undefined, null, null, false).level).toBe("PASS")
    expect(checkBaseline("v1", null, null, false).level).toBe("WARN")
    expect(checkBaseline("v1", "aaaa1111", "bbbb2222", false).level).toBe("WARN")
    expect(checkBaseline("v1", "aaaa1111", "aaaa1111", true).level).toBe("WARN")
    expect(checkBaseline("v1", "aaaa1111", "aaaa1111", false).level).toBe("PASS")
    expect(checkOptIns({ ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK: "1" }).detail).toContain("pre-check on")
  })

  test("exit code is non-zero only on a FAIL", () => {
    expect(exitCodeFor([{ name: "a", level: "WARN", detail: "" }])).toBe(0)
    expect(exitCodeFor([{ name: "a", level: "FAIL", detail: "" }])).toBe(1)
  })

  test("redact replaces every secret occurrence", () => {
    expect(redact("key=abcdefgh1234 again abcdefgh1234", ["abcdefgh1234"])).toBe("key=[redacted] again [redacted]")
  })
})

describe("specs/131 demo preflight — no key in output", () => {
  const originalCwd = process.cwd()
  let dir = ""
  afterEach(() => {
    process.chdir(originalCwd)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test("a full run never prints the configured key", async () => {
    dir = mkdtempSync(join(tmpdir(), "preflight-"))
    mkdirSync(join(dir, ".orchestrai"))
    const key = "sk-ant-THIS-MUST-NEVER-PRINT-0123456789"
    writeFileSync(join(dir, ".orchestrai", "config.env"), `ORCHESTRAI_LLM_PROVIDER=anthropic\nORCHESTRAI_LLM_API_KEY=${key}\n`)
    process.chdir(dir)
    const lines: string[] = []
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      await main(["--skip-key"])
    } finally {
      log.mockRestore()
    }
    const output = lines.join("\n")
    expect(output).toContain("Config")
    expect(output).toContain("key present")
    expect(output).not.toContain(key)
  }, 30_000)
})
