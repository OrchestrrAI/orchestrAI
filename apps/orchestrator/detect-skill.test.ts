// specs/065-llm-only-skill-routing/spec.md
//
// Full rewrite. This file used to test three tiers of routing logic
// (keyword matching, then a local Model2Vec classifier, then — only as
// a last resort — the capability router). specs/065 retired the first
// two entirely: detectSkill() is now `tryCapabilityRoute(...) ??
// "plan-task"`, nothing else. Every scenario this file used to assert
// with a bare string (no injected model, real keyword logic) now needs
// either a real model (out of scope for `bun test` — see
// capability-router-detect-skill.test.ts for the injected-model
// coverage of the router's own proposal/validation logic) or asserts
// the one thing still true with no model and no key at all: everything
// falls through to plan-task, deterministically and without throwing.
import { describe, expect, test } from "bun:test"
import { detectSkill } from "./index"

describe("detectSkill — specs/065, no injected model and no real provider key", () => {
  // Mirrors this exact codebase's own fail-closed precedent
  // (classifySkillTier(), the original keyword/classifier fallback
  // chain before this spec): with the router itself unreachable (no
  // key resolvable in this test process's own environment —
  // tryBuildOrchestratorRouterModel() returns null), every request
  // resolves to the same "plan-task" default that has always meant
  // "nothing more specific was decided," regardless of what the text
  // says. This is the honest, deliberate cost of specs/065's own design
  // — restated directly here as the primary regression this file now
  // guards, not glossed over.
  test.each([
    "dockerize bun app on port 3000",
    "create ci pipeline for bun",
    "git status",
    "what agents do I need to deploy my app?",
    "build and deploy my bun app",
    "scan for secrets at C:\\work\\app",
    "generate a README for my project",
    "run the test suite",
    "absolutely nothing here matches any keyword at all",
  ])("with no resolvable key, every request — %s — resolves to plan-task, never throws", async (text) => {
    await expect(detectSkill(text)).resolves.toBe("plan-task")
  })

  test("never throws regardless of how unusual the input is", async () => {
    await expect(detectSkill("")).resolves.toBeString()
    await expect(detectSkill("   ")).resolves.toBeString()
    await expect(detectSkill("a".repeat(5000))).resolves.toBeString()
  })
})

// The router's own proposal/validation/fail-closed behavior — a valid
// proposal being used, an invalid one falling through, the new
// suggest-agents meta-skill, a write-capable skill passing through
// untouched to the approval gate — is exercised with a real injected
// fake model in capability-router-detect-skill.test.ts, which is now
// this codebase's own primary regression suite for detectSkill() as a
// whole, not a secondary one layered under keyword/classifier tests
// that no longer exist.
