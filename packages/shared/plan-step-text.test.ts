// specs/137-plan-step-acts-only-on-its-own-step/spec.md — the child-text
// marker, the split helper, and the one background wording every
// split-aware harness uses.
import { describe, expect, test } from "bun:test"
import {
  MAX_PLAN_BACKGROUND_CHARS,
  PLAN_CONTEXT_MARKER,
  buildPlanStepText,
  renderPlanBackground,
  splitPlanStepText,
} from "./plan-step-text"

describe("buildPlanStepText / splitPlanStepText", () => {
  test("round-trips: the step and the user's request come back apart", () => {
    const text = buildPlanStepText("edit-files", "Add a comment to src/a.ts and src/b.ts", "edit a and b, and also create a .gitignore")
    expect(text).toContain(PLAN_CONTEXT_MARKER)
    expect(splitPlanStepText(text)).toEqual({
      step: "edit-files: Add a comment to src/a.ts and src/b.ts",
      context: "edit a and b, and also create a .gitignore",
    })
  })

  test("a direct (non-plan) task has no marker: the whole text is the step, context is null", () => {
    expect(splitPlanStepText("edit-files at C:/p: rename Logger")).toEqual({ step: "edit-files at C:/p: rename Logger", context: null })
  })

  test("em dashes in either part never split it (the old separator's ambiguity)", () => {
    const text = buildPlanStepText("dockerize", "Build the image — port 4000", "ship it — dockerize on port 4000 — and add CI")
    expect(splitPlanStepText(text)).toEqual({
      step: "dockerize: Build the image — port 4000",
      context: "ship it — dockerize on port 4000 — and add CI",
    })
  })

  test("splits at the FIRST marker only", () => {
    const text = `step${PLAN_CONTEXT_MARKER}request with${PLAN_CONTEXT_MARKER}a marker inside`
    const { step, context } = splitPlanStepText(text)
    expect(step).toBe("step")
    expect(context).toBe(`request with${PLAN_CONTEXT_MARKER}a marker inside`.trim())
  })

  test("an empty request after the marker gives context null", () => {
    expect(splitPlanStepText(`step${PLAN_CONTEXT_MARKER}   `)).toEqual({ step: "step", context: null })
  })
})

describe("renderPlanBackground", () => {
  test("empty for no context; labelled and ruled when present", () => {
    expect(renderPlanBackground(null)).toBe("")
    expect(renderPlanBackground("  ")).toBe("")
    const block = renderPlanBackground("edit a and b, and also create a .gitignore")
    expect(block).toContain("<<<BACKGROUND")
    expect(block).toContain("edit a and b, and also create a .gitignore")
    expect(block).toContain("do only the step you were given")
  })

  test("caps the background at MAX_PLAN_BACKGROUND_CHARS", () => {
    const block = renderPlanBackground("x".repeat(MAX_PLAN_BACKGROUND_CHARS + 100))
    expect(block).toContain("x".repeat(MAX_PLAN_BACKGROUND_CHARS) + "… [truncated]")
    expect(block).not.toContain("x".repeat(MAX_PLAN_BACKGROUND_CHARS + 1))
  })
})
