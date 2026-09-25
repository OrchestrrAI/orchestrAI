// specs/066-supervisor-log-suppression-during-tui/spec.md
//
// Real filesystem round-trips (a real scratch temp directory), matching
// this package's own existing precedent (port-preflight.test.ts,
// project-path.test.ts) — mocking only console.log/console.error, the
// same convention packages/shared/a2a-client.test.ts already uses.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import * as os from "os"
import * as path from "path"
import { __setChildLogSuppressionForTests, writeChildLog } from "./index"

let scratchDir: string
let logPath: string

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(os.tmpdir(), "orchestrai-log-suppress-"))
  logPath = path.join(scratchDir, "supervisor.log")
})

afterEach(() => {
  __setChildLogSuppressionForTests(false, null) // never leak state across tests
  rmSync(scratchDir, { recursive: true, force: true })
})

describe("writeChildLog — specs/066", () => {
  test("with suppression off (the default), a stdout line goes to console.log unchanged", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined)
    try {
      writeChildLog("[devops-agent] hello", false)
      expect(logSpy).toHaveBeenCalledWith("[devops-agent] hello")
    } finally {
      logSpy.mockRestore()
    }
  })

  test("with suppression off, a stderr line goes to console.error unchanged", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      writeChildLog("[devops-agent] uh oh", true)
      expect(errSpy).toHaveBeenCalledWith("[devops-agent] uh oh")
    } finally {
      errSpy.mockRestore()
    }
  })

  test("with suppression on, a line never reaches console.log at all", () => {
    __setChildLogSuppressionForTests(true, logPath)
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined)
    try {
      writeChildLog("[devops-agent] real work happening", false)
      expect(logSpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
    }
  })

  test("with suppression on, a line never reaches console.error either", () => {
    __setChildLogSuppressionForTests(true, logPath)
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      writeChildLog("[devops-agent] a real error", true)
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  test("with suppression on, the line is written to the real log file instead", () => {
    __setChildLogSuppressionForTests(true, logPath)
    writeChildLog("[devops-agent] first line", false)
    writeChildLog("[devops-agent] second line", true)
    const content = readFileSync(logPath, "utf8")
    expect(content).toBe("[devops-agent] first line\n[devops-agent] second line\n")
  })

  test("lines are appended in order across many calls, not overwritten", () => {
    __setChildLogSuppressionForTests(true, logPath)
    for (let i = 0; i < 5; i++) writeChildLog(`[devops-agent] line ${i}`, false)
    const lines = readFileSync(logPath, "utf8").trim().split("\n")
    expect(lines).toEqual(["line 0", "line 1", "line 2", "line 3", "line 4"].map((s) => `[devops-agent] ${s}`))
  })

  test("suppression with no log path configured falls back to console rather than silently discarding", () => {
    // Mirrors main()'s own fallback: if the log file/dir couldn't be
    // created, supervisorLogPath stays null and suppression never
    // actually engages — a corrupted-but-informative screen beats a
    // clean-but-silent one.
    __setChildLogSuppressionForTests(true, null)
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined)
    try {
      writeChildLog("[devops-agent] no log path set", false)
      expect(logSpy).toHaveBeenCalledWith("[devops-agent] no log path set")
    } finally {
      logSpy.mockRestore()
    }
  })

  test("a write to an unwritable path never throws — best-effort, never crashes the supervisor", () => {
    // A path inside a file (not a directory) can never be written to —
    // a reliable way to force appendFileSync's own failure without
    // relying on OS-specific permission behavior.
    const bogusPath = path.join(logPath, "nested", "impossible.log")
    __setChildLogSuppressionForTests(true, bogusPath)
    expect(() => writeChildLog("[devops-agent] this must not throw", false)).not.toThrow()
  })
})
