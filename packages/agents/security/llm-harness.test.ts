// specs/043-llm-harness-security/spec.md — tests the enrichment layer's
// structured-output validation, retry-with-feedback, CVE/version-claim
// rejection, and fail-closed-to-null behavior against a mocked chat model.
// No network calls, no live API credentials, no LangGraph/tool-calling
// involved — this harness deliberately has neither (see llm-harness.ts's
// own header comment for why). Mirrors packages/agents/devops/
// llm-harness.test.ts's ScriptedChatModel test double.
import { describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import {
  AuditDependenciesEnrichmentSchema,
  containsForbiddenVulnerabilityClaim,
  runAuditDependenciesEnrichment,
  runGitignoreEnrichment,
  runScanSecretsEnrichment,
} from "./llm-harness"

// ============================================================
// TEST DOUBLE
// ============================================================
class ScriptedChatModel extends BaseChatModel {
  public callCount = 0
  private index = 0
  constructor(private readonly responses: (AIMessage | Error)[]) {
    super({})
  }
  _llmType(): string {
    return "scripted-fake-chat-model"
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.callCount += 1
    const message = this.responses[Math.min(this.index, this.responses.length - 1)]
    this.index += 1
    if (message instanceof Error) throw message
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] }
  }
}

function textMessage(text: string): AIMessage {
  return new AIMessage({ content: text })
}

// ============================================================
// containsForbiddenVulnerabilityClaim — pure function, no model needed
// ============================================================
describe("containsForbiddenVulnerabilityClaim", () => {
  test("flags an explicit CVE identifier", () => {
    expect(containsForbiddenVulnerabilityClaim("This is affected by CVE-2023-12345.")).toBe(true)
  })

  test("flags a lowercase CVE identifier", () => {
    expect(containsForbiddenVulnerabilityClaim("see cve-2021-44228 for details")).toBe(true)
  })

  test("flags a version-range comparison", () => {
    expect(containsForbiddenVulnerabilityClaim("versions < 4.17.21 are vulnerable")).toBe(true)
  })

  test("does not flag general, non-specific commentary", () => {
    expect(containsForbiddenVulnerabilityClaim("Unpinned dependencies can pull in unreviewed changes.")).toBe(false)
  })

  test("does not flag a plain version mention with no comparison operator", () => {
    expect(containsForbiddenVulnerabilityClaim("this project currently uses version 4.17.21")).toBe(false)
  })
})

// ============================================================
// runScanSecretsEnrichment
// ============================================================
describe("runScanSecretsEnrichment", () => {
  const findings = [
    { index: 0, file: "src/config.ts", line: 12, confidence: "MEDIUM CONFIDENCE", label: "hardcoded password", maskedValue: "CHAN...TION" },
  ]

  test("returns validated commentary on a well-formed first response", async () => {
    const model = new ScriptedChatModel([
      textMessage('{"perFinding":[{"findingIndex":0,"likelyFalsePositive":true,"note":"Looks like a placeholder value"}],"summary":"One likely false positive."}'),
    ])
    const result = await runScanSecretsEnrichment({ model, findings })
    expect(result).toEqual({
      perFinding: [{ findingIndex: 0, likelyFalsePositive: true, note: "Looks like a placeholder value" }],
      summary: "One likely false positive.",
    })
    expect(model.callCount).toBe(1)
  })

  test("strips a markdown code fence", async () => {
    const model = new ScriptedChatModel([
      textMessage('```json\n{"perFinding":[{"findingIndex":0,"likelyFalsePositive":false,"note":"Looks real"}]}\n```'),
    ])
    const result = await runScanSecretsEnrichment({ model, findings })
    expect(result?.perFinding[0].likelyFalsePositive).toBe(false)
  })

  test("retries once on invalid JSON, then succeeds", async () => {
    const model = new ScriptedChatModel([
      textMessage("not json at all"),
      textMessage('{"perFinding":[{"findingIndex":0,"likelyFalsePositive":true,"note":"fixed"}]}'),
    ])
    const result = await runScanSecretsEnrichment({ model, findings })
    expect(result?.perFinding[0].note).toBe("fixed")
    expect(model.callCount).toBe(2)
  })

  test("fails closed to null after exhausting retries on persistently invalid output", async () => {
    const model = new ScriptedChatModel([textMessage("still not json"), textMessage("still not json"), textMessage("still not json")])
    const result = await runScanSecretsEnrichment({ model, findings, maxRetries: 2 })
    expect(result).toBeNull()
    expect(model.callCount).toBe(3) // initial + 2 retries
  })

  test("fails closed to null on a model/API error, with no retry against a broken connection", async () => {
    const model = new ScriptedChatModel([new Error("network unreachable")])
    const result = await runScanSecretsEnrichment({ model, findings })
    expect(result).toBeNull()
    expect(model.callCount).toBe(1)
  })
})

// ============================================================
// runGitignoreEnrichment
// ============================================================
describe("runGitignoreEnrichment", () => {
  test("returns validated additional suggestions grounded in the directory listing", async () => {
    const model = new ScriptedChatModel([
      textMessage('{"additionalSuggestions":[{"pattern":"terraform.tfstate","reason":"Real tfstate file found in the listing"}]}'),
    ])
    const result = await runGitignoreEnrichment({
      model,
      coveredPatterns: [".env"],
      missingPatterns: ["*.pem"],
      directoryListing: ["terraform.tfstate", "main.tf"],
    })
    expect(result?.additionalSuggestions).toEqual([{ pattern: "terraform.tfstate", reason: "Real tfstate file found in the listing" }])
  })

  test("accepts an empty suggestions array when nothing is warranted", async () => {
    const model = new ScriptedChatModel([textMessage('{"additionalSuggestions":[]}')])
    const result = await runGitignoreEnrichment({ model, coveredPatterns: [], missingPatterns: [], directoryListing: [] })
    expect(result?.additionalSuggestions).toEqual([])
  })

  test("rejects a response missing the required field, retries, then fails closed if still invalid", async () => {
    const model = new ScriptedChatModel([textMessage('{"wrongField":[]}'), textMessage('{"wrongField":[]}'), textMessage('{"wrongField":[]}')])
    const result = await runGitignoreEnrichment({ model, coveredPatterns: [], missingPatterns: [], directoryListing: [], maxRetries: 2 })
    expect(result).toBeNull()
    expect(model.callCount).toBe(3)
  })
})

// ============================================================
// runAuditDependenciesEnrichment — the CVE/version-claim rejection path
// ============================================================
describe("runAuditDependenciesEnrichment", () => {
  const options = {
    unpinned: [{ name: "left-pad", version: "*" }],
    allDependencies: { "left-pad": "*", express: "^4.18.0" },
  }

  test("returns validated general notes when no forbidden claim is present", async () => {
    const model = new ScriptedChatModel([
      textMessage('{"generalNotes":["An unpinned dependency can silently pull in unreviewed future changes."]}'),
    ])
    const result = await runAuditDependenciesEnrichment({ model, ...options })
    expect(result?.generalNotes).toEqual(["An unpinned dependency can silently pull in unreviewed future changes."])
  })

  test("rejects a response asserting a specific CVE identifier, retries with corrective feedback, then succeeds", async () => {
    const model = new ScriptedChatModel([
      textMessage('{"generalNotes":["This is affected by CVE-2023-12345, upgrade immediately."]}'),
      textMessage('{"generalNotes":["Unpinned dependencies carry general upgrade risk."]}'),
    ])
    const result = await runAuditDependenciesEnrichment({ model, ...options })
    expect(result?.generalNotes).toEqual(["Unpinned dependencies carry general upgrade risk."])
    expect(model.callCount).toBe(2)
  })

  test("fails closed to null when every retry keeps asserting a forbidden claim", async () => {
    const claimResponse = textMessage('{"generalNotes":["versions < 4.17.21 are known vulnerable"]}')
    const model = new ScriptedChatModel([claimResponse, claimResponse, claimResponse])
    const result = await runAuditDependenciesEnrichment({ model, ...options, maxRetries: 2 })
    expect(result).toBeNull()
    expect(model.callCount).toBe(3)
  })

  test("schema alone (without the CVE guard) would have accepted the forbidden-claim response — confirms the guard is load-bearing", () => {
    const parsed = AuditDependenciesEnrichmentSchema.safeParse({ generalNotes: ["CVE-2023-12345 applies here"] })
    expect(parsed.success).toBe(true) // shape is valid; only the dedicated guard rejects the content
  })
})
