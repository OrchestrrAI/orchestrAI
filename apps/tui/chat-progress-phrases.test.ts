// specs/075-real-conversational-chat/spec.md §4 — the phrase-table
// lookup driving live chat progress narration. Pure, no rendering.
import { describe, expect, test } from "bun:test"
import { skillFromStepName, progressPhraseForSkill, progressPhraseForTool } from "./chat-progress-phrases"

describe("skillFromStepName", () => {
  test("strips the leading ordinal", () => {
    expect(skillFromStepName("1. git-status")).toBe("git-status")
    expect(skillFromStepName("12. dockerize")).toBe("dockerize")
  })

  test("tolerates no ordinal at all", () => {
    expect(skillFromStepName("git-status")).toBe("git-status")
  })
})

describe("progressPhraseForSkill", () => {
  test("returns the specific phrase for a known skill", () => {
    expect(progressPhraseForSkill("git-status")).toBe("checking git status…")
    expect(progressPhraseForSkill("dockerize")).toBe("writing a Dockerfile…")
    expect(progressPhraseForSkill("analyze-project")).toBe("analyzing your project…")
  })

  test("falls back to a generic phrase for an unlisted skill — never silently blank", () => {
    expect(progressPhraseForSkill("some-future-skill")).toBe("running some-future-skill…")
  })

  test("every skill in the table produces a non-empty phrase", () => {
    for (const skill of ["git-status", "git-diff", "docker-status", "scan-secrets", "check-gitignore-coverage",
      "audit-dependencies", "dockerize", "create-ci", "create-gitignore", "create-compose", "generate-readme",
      "document-api", "run-tests", "check-coverage", "build-image", "verify-deployment", "commit-changes",
      "run-command", "write-tests", "review-diff", "edit-file"]) {
      expect(progressPhraseForSkill(skill).length).toBeGreaterThan(0)
    }
  })
})

describe("progressPhraseForTool", () => {
  test("narrates the tool name as-is, no lookup table needed", () => {
    expect(progressPhraseForTool("git_status")).toBe("git_status…")
    expect(progressPhraseForTool("devops-agent")).toBe("devops-agent…")
  })
})
