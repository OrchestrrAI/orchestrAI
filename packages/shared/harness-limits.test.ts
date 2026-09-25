// specs/125-configurable-harness-recursion-limit/spec.md — the full
// input matrix for the one shared resolver every agent-level LLM
// harness's recursion bound resolves through. Mirrors the test shape
// resolveSupervisorMaxDispatches()'s own tests already established
// (apps/orchestrator/supervisor-graph.test.ts) — the same resolution
// contract, so the same proof.
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_HARNESS_RECURSION_LIMIT,
  HARNESS_RECURSION_LIMIT_ENV_VAR,
  resolveHarnessRecursionLimit,
} from "./harness-limits"

describe("resolveHarnessRecursionLimit — specs/125", () => {
  test("unset env var falls back to the default, and the shipped default is 40 (raised from 20 by specs/125)", () => {
    expect(resolveHarnessRecursionLimit({})).toBe(DEFAULT_HARNESS_RECURSION_LIMIT)
    expect(DEFAULT_HARNESS_RECURSION_LIMIT).toBe(40)
  })

  test("empty string falls back to the default", () => {
    expect(resolveHarnessRecursionLimit({ [HARNESS_RECURSION_LIMIT_ENV_VAR]: "" })).toBe(DEFAULT_HARNESS_RECURSION_LIMIT)
  })

  test("a real override value is honored exactly, via the test's own env argument", () => {
    expect(resolveHarnessRecursionLimit({ [HARNESS_RECURSION_LIMIT_ENV_VAR]: "20" })).toBe(20)
    expect(resolveHarnessRecursionLimit({ [HARNESS_RECURSION_LIMIT_ENV_VAR]: "64" })).toBe(64)
  })

  test("zero or a negative value falls back to the default — the bound can never be disabled this way", () => {
    expect(resolveHarnessRecursionLimit({ [HARNESS_RECURSION_LIMIT_ENV_VAR]: "0" })).toBe(DEFAULT_HARNESS_RECURSION_LIMIT)
    expect(resolveHarnessRecursionLimit({ [HARNESS_RECURSION_LIMIT_ENV_VAR]: "-5" })).toBe(DEFAULT_HARNESS_RECURSION_LIMIT)
  })

  test("a non-numeric value falls back to the default rather than throwing", () => {
    expect(resolveHarnessRecursionLimit({ [HARNESS_RECURSION_LIMIT_ENV_VAR]: "not-a-number" })).toBe(DEFAULT_HARNESS_RECURSION_LIMIT)
  })

  test("a non-integer value falls back to the default", () => {
    expect(resolveHarnessRecursionLimit({ [HARNESS_RECURSION_LIMIT_ENV_VAR]: "3.5" })).toBe(DEFAULT_HARNESS_RECURSION_LIMIT)
  })

  test("an absurdly large value is accepted — no upper clamp (the resolveSupervisorMaxDispatches precedent)", () => {
    expect(resolveHarnessRecursionLimit({ [HARNESS_RECURSION_LIMIT_ENV_VAR]: "999999" })).toBe(999999)
  })

  test("the env var name is exactly what the TUI init form and formatConfigEnv write", () => {
    // init writes it, the five harnesses read it — if either side ever
    // constructs the name differently the override silently does nothing,
    // which is the worst possible failure here.
    expect(HARNESS_RECURSION_LIMIT_ENV_VAR).toBe("ORCHESTRAI_HARNESS_RECURSION_LIMIT")
  })
})
