import { describe, expect, test } from "bun:test"
import { stripPathPhrases } from "./index"

// specs/020-semantic-intent-fallback/spec.md — stripPathPhrases() feeds the
// semantic classifier's embedding step. Found live: a naive single-match
// strip breaks on ordinary sentences containing an earlier, spurious
// "preposition + single word" match before the real path clause. These
// tests pin that exact regression.
describe("stripPathPhrases", () => {
  test("strips a trailing Windows path clause", () => {
    expect(stripPathPhrases("wrap this up in a container image at C:/Users/moham/test-target-project"))
      .toBe("wrap this up in a container image")
  })

  test("strips a trailing Windows path clause with backslashes", () => {
    expect(stripPathPhrases("make sure there's no leaked api key in here at C:\\Users\\moham\\app"))
      .toBe("make sure there's no leaked api key in here")
  })

  test("strips a trailing POSIX path clause", () => {
    expect(stripPathPhrases("check gitignore coverage at /home/user/project")).toBe("check gitignore coverage")
  })

  test("does NOT strip an earlier, ordinary 'in/at/to/from + word' that isn't a real path", () => {
    // The exact regression: "in a" (a spurious match) sits before the real
    // path clause; naive first-match stripping consumed "in a" and left
    // "at C:\..." completely unstripped.
    expect(stripPathPhrases("wrap this up in a container image at C:\\my-app"))
      .toBe("wrap this up in a container image")
  })

  test("leaves ordinary prose with no path at all unchanged", () => {
    expect(stripPathPhrases("is my repo clean or are there uncommitted changes"))
      .toBe("is my repo clean or are there uncommitted changes")
  })

  test("strips a quoted path", () => {
    expect(stripPathPhrases('analyze the project at "C:\\Users\\a b\\app"')).toBe("analyze the project")
  })

  test("strips a 'save to'/'write to' output clause too", () => {
    expect(stripPathPhrases('document the API at C:\\app\\index.ts save to "C:\\app\\API.md"'))
      .toBe("document the API")
  })
})
