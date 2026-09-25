import { describe, expect, test } from "bun:test"
import { resolveProjectPath } from "./index"

describe("resolveProjectPath — specs/018-supervisor-project-path/spec.md priority order", () => {
  test("--project wins over everything else", () => {
    const result = resolveProjectPath({
      flagValue: "C:\\flag",
      envValue: "C:\\env",
      configFileValue: "C:\\config",
      cwd: "C:\\cwd",
    })
    expect(result).toEqual({ path: "C:\\flag", source: "--project" })
  })

  test("an already-set env var wins over the config file and cwd", () => {
    const result = resolveProjectPath({
      envValue: "C:\\env",
      configFileValue: "C:\\config",
      cwd: "C:\\cwd",
    })
    expect(result).toEqual({ path: "C:\\env", source: "ORCHESTRAI_PROJECT_PATH (already set)" })
  })

  test("the config file wins over cwd", () => {
    const result = resolveProjectPath({
      configFileValue: "C:\\config",
      cwd: "C:\\cwd",
    })
    expect(result?.path).toBe("C:\\config")
  })

  test("cwd is the last resort", () => {
    const result = resolveProjectPath({ cwd: "C:\\cwd" })
    expect(result).toEqual({ path: "C:\\cwd", source: "current directory" })
  })

  test("nothing resolved when every source is absent", () => {
    expect(resolveProjectPath({})).toBeNull()
  })

  test("blank/whitespace-only values are treated as absent, falling through to the next source", () => {
    const result = resolveProjectPath({
      flagValue: "   ",
      envValue: "",
      configFileValue: "\n",
      cwd: "C:\\cwd",
    })
    expect(result).toEqual({ path: "C:\\cwd", source: "current directory" })
  })

  test("values are trimmed", () => {
    const result = resolveProjectPath({ flagValue: "  C:\\my-app  " })
    expect(result?.path).toBe("C:\\my-app")
  })
})
