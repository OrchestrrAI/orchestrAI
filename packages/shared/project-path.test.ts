import { describe, expect, test } from "bun:test"
import {
  extractExplicitTargetPath,
  resolveTargetPath,
  TARGET_PATH_REQUIRED_ERROR,
} from "./index"

describe("specs/140 — a path after 'for' or 'on'", () => {
  test("'for <path>:' in a plan request resolves to that path", () => {
    expect(extractExplicitTargetPath("prepare a release for C:\\proj: create a Dockerfile")).toBe("C:\\proj")
  })
  test("'on <path>' resolves to that path", () => {
    expect(extractExplicitTargetPath("run the tests on /srv/app")).toBe("/srv/app")
  })
  test("ordinary 'for'/'on' phrases are not paths", () => {
    expect(extractExplicitTargetPath("write tests for login")).toBeNull()
    expect(extractExplicitTargetPath("run on port 4000")).toBeNull()
  })
  test("the plan-step text still resolves the named path, and env loses", () => {
    expect(resolveTargetPath("dockerize: Create a Dockerfile\n\nprepare a release for C:\\proj: in parallel …", {
      env: { ORCHESTRAI_PROJECT_PATH: "C:\\other" },
    })).toBe("C:\\proj")
  })
  test("a save destination is still never the target", () => {
    expect(extractExplicitTargetPath("document api for login save to C:\\docs\\api.md")).toBeNull()
  })
})

describe("resolveTargetPath", () => {
  test("explicit Windows path wins over environment configuration", () => {
    expect(resolveTargetPath("analyze project at C:\\work\\app", {
      env: { ORCHESTRAI_PROJECT_PATH: "C:\\other" },
    })).toBe("C:\\work\\app")
  })

  test("explicit Unix path wins over environment configuration", () => {
    expect(resolveTargetPath("run tests in /home/yusuf/app", {
      env: { ORCHESTRAI_PROJECT_PATH: "/home/other" },
    })).toBe("/home/yusuf/app")
  })

  test("supports a double-quoted Windows path containing spaces", () => {
    expect(resolveTargetPath('analyze project at "C:\\work projects\\sample app"', {
      env: {},
    })).toBe("C:\\work projects\\sample app")
  })

  test("supports a single-quoted Unix path containing spaces", () => {
    expect(resolveTargetPath("run tests in '/home/yusuf/work projects/app'", {
      env: {},
    })).toBe("/home/yusuf/work projects/app")
  })

  test("uses ORCHESTRAI_PROJECT_PATH when the task has no explicit path", () => {
    expect(resolveTargetPath("analyze my project", {
      env: { ORCHESTRAI_PROJECT_PATH: "C:\\configured\\app" },
    })).toBe("C:\\configured\\app")
  })

  test("accepts a quoted environment value", () => {
    expect(resolveTargetPath("analyze my project", {
      env: { ORCHESTRAI_PROJECT_PATH: '"C:\\configured apps\\app"' },
    })).toBe("C:\\configured apps\\app")
  })

  test("ignores a blank environment value and returns the actionable error", () => {
    expect(() => resolveTargetPath("analyze my project", {
      env: { ORCHESTRAI_PROJECT_PATH: "   " },
    })).toThrow(TARGET_PATH_REQUIRED_ERROR)
  })

  test("treats a relative explicit-path match as absent and falls back to the required-path error", () => {
    // "at projects/sample-app" syntactically matches EXPLICIT_PATH_PATTERN
    // but isn't a real absolute path — it must not throw the specific
    // "Task path must be an absolute path" error; it falls through like any
    // other task with no usable explicit path.
    expect(() => resolveTargetPath("analyze project at projects/sample-app", {
      env: {},
    })).toThrow(TARGET_PATH_REQUIRED_ERROR)
  })

  test("treats a relative explicit-path match as absent and falls back to ORCHESTRAI_PROJECT_PATH", () => {
    expect(resolveTargetPath("analyze project at projects/sample-app", {
      env: { ORCHESTRAI_PROJECT_PATH: "C:\\configured\\app" },
    })).toBe("C:\\configured\\app")
  })

  test("a false-positive preposition match on ordinary prose falls back to the configured path instead of throwing", () => {
    // Regression for the live-reported defect: "...how to do that..." matched
    // "to do" as if "do" were a path and threw before ever reaching
    // ORCHESTRAI_PROJECT_PATH.
    expect(resolveTargetPath(
      "if i need fully deploy how to do that in steps my project will be in bun",
      { env: { ORCHESTRAI_PROJECT_PATH: "C:\\Users\\moham\\orch-scratch" } },
    )).toBe("C:\\Users\\moham\\orch-scratch")
  })

  test("the same false-positive prose still produces the actionable error with no configured default", () => {
    expect(() => resolveTargetPath(
      "if i need fully deploy how to do that in steps my project will be in bun",
      { env: {} },
    )).toThrow(TARGET_PATH_REQUIRED_ERROR)
  })

  test("rejects a relative environment value", () => {
    expect(() => resolveTargetPath("analyze my project", {
      env: { ORCHESTRAI_PROJECT_PATH: "projects/sample-app" },
    })).toThrow("ORCHESTRAI_PROJECT_PATH must be an absolute path")
  })

  test("returns the actionable error when no target is configured", () => {
    expect(() => resolveTargetPath("analyze my project", { env: {} }))
      .toThrow(TARGET_PATH_REQUIRED_ERROR)
  })

  test("normalizes the selected absolute path", () => {
    expect(resolveTargetPath("analyze project at C:\\work\\one\\..\\app\\", {
      env: {},
    })).toBe("C:\\work\\app\\")
  })

  test("finds an explicit path preserved in planned child-task context", () => {
    const childText =
      "dockerize: Create a Dockerfile — build and deploy app at C:\\work\\planned-app"
    expect(resolveTargetPath(childText, { env: {} })).toBe("C:\\work\\planned-app")
  })

  test("does not mistake an output destination for an explicit target", () => {
    expect(extractExplicitTargetPath("document api save to C:\\docs\\api.md")).toBeNull()
    expect(extractExplicitTargetPath(
      "document api at C:\\src\\index.ts save to C:\\docs\\api.md",
    )).toBe("C:\\src\\index.ts")
  })

  // specs/087-target-path-resolver-first-match-bug/spec.md — a genuinely
  // new case, never covered before: a real absolute path IS present, but
  // only reachable past an earlier at/in/to/from match that isn't one.
  // The existing false-positive-prose tests above (lines 67-82) cover a
  // different case — no real path anywhere at all — where falling
  // through to the configured/error path is and remains correct.
  test("finds a real path that comes after an earlier false at/in/to/from match, instead of giving up", () => {
    expect(resolveTargetPath(
      "in the thing, check the project at C:\\real\\path",
      { env: {} },
    )).toBe("C:\\real\\path")
  })

  test("the exact real dispatched-step text that surfaced this bug now resolves correctly", () => {
    // Live-caught 2026-09-15: a real adaptive-supervisor plan step's own
    // auto-generated description ("...in the target directory to
    // understand its structure.") put a false match ("in the") before
    // the real path clause appended from the parent task's own text —
    // this used to throw TARGET_PATH_REQUIRED_ERROR even though a
    // genuine path was present.
    const realDispatchedStepText =
      "run-command: List files in the target directory to understand its structure. " +
      "— build and deploy the project at C:\\Users\\moham\\AppData\\Local\\Temp\\claude\\" +
      "c--Users-moham-devops-mcp-server\\d2d9d619-9806-4afb-bdf6-136a91d0eed2\\scratchpad\\live-verify-project"
    expect(resolveTargetPath(realDispatchedStepText, { env: {} })).toBe(
      "C:\\Users\\moham\\AppData\\Local\\Temp\\claude\\c--Users-moham-devops-mcp-server\\" +
        "d2d9d619-9806-4afb-bdf6-136a91d0eed2\\scratchpad\\live-verify-project",
    )
  })

  // specs/088-target-path-resolver-trailing-colon-bug/spec.md — a real
  // path IS present and is otherwise the only/first candidate, but a
  // colon immediately follows it with no space (the Coder Agent's own
  // "edit <file> at <path>: <instruction>" convention) and used to
  // survive into the resolved path, producing a directory that can
  // never exist on disk.
  test("strips a trailing colon that immediately follows the path clause", () => {
    expect(resolveTargetPath(
      "edit index.js at C:\\real\\path: do the thing",
      { env: {} },
    )).toBe("C:\\real\\path")
  })

  test("the exact real Coder Agent request text that surfaced this bug now resolves correctly", () => {
    // Live-caught 2026-09-15: two real "edit <file> at <path>: ..."
    // requests against the real Coder Agent both failed with "Target
    // file ... does not exist" even though the file was genuinely
    // present — the resolved path had picked up a stray trailing colon.
    const realCoderAgentText =
      "edit index.js at C:\\Users\\moham\\AppData\\Local\\Temp\\claude\\" +
      "c--Users-moham-devops-mcp-server\\d2d9d619-9806-4afb-bdf6-136a91d0eed2\\" +
      "scratchpad\\live-verify-project: change the greeting to say hello world"
    expect(resolveTargetPath(realCoderAgentText, { env: {} })).toBe(
      "C:\\Users\\moham\\AppData\\Local\\Temp\\claude\\c--Users-moham-devops-mcp-server\\" +
        "d2d9d619-9806-4afb-bdf6-136a91d0eed2\\scratchpad\\live-verify-project",
    )
  })
})
