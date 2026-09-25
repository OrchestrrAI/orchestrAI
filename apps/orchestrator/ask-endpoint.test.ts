// specs/044-conversational-ask-layer/spec.md — Phase 1.
// Exercises the REAL app.post("/ask") handler via Hono's in-process
// app.request() (no port bound), the same technique specs/028's
// supervisor-wiring tests already use. fetch is mocked; no real agent
// process, no LLM, no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { app, appendTurn, conversations, escapeDashboardHtml, registry, subscribeToEvents, tasks, __setTestRouterModel, __getTestSynthesisCallCount, __resetTestSynthesisCallCount, __setTestSynthesisModel, type RegisteredAgent } from "./index"
import { KeywordRouterFake } from "./keyword-router-fake"

function agent(name: string, skillIds: string[]): RegisteredAgent {
  return {
    card: {
      name,
      description: "",
      url: `http://localhost:0/${name}`,
      version: "1.0.0",
      skills: skillIds.map((id) => ({ id, name: id, description: "" })),
    },
    url: `http://localhost:0/${name}`,
    status: "online",
    lastSeen: new Date(),
  }
}

let capturedRequests: { url: string; body: Record<string, unknown> | null }[] = []
let originalFetch: typeof fetch
let originalGraphFlag: string | undefined
let originalApiKey: string | undefined

beforeEach(() => {
  registry.clear()
  tasks.clear()
  conversations.clear()
  capturedRequests = []
  originalFetch = globalThis.fetch
  originalGraphFlag = process.env.ORCHESTRAI_ORCHESTRATOR_GRAPH
  originalApiKey = process.env.ORCHESTRAI_LLM_API_KEY
  // Keep plan-task on the deterministic Planning path for these tests —
  // specs/038's supervisor is exercised by its own suite.
  process.env.ORCHESTRAI_ORCHESTRATOR_GRAPH = "0"
  delete process.env.ORCHESTRAI_LLM_API_KEY
  // specs/065 — classifyAsk() calls detectSkill() internally; the fake
  // router keeps these Tier-classification tests deterministic and
  // hermetic now that keyword matching is gone.
  __setTestRouterModel(new KeywordRouterFake())
  __resetTestSynthesisCallCount()

  // @ts-expect-error — test double, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    capturedRequests.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
    if (url.includes("/.well-known/agent.json")) {
      return new Response(JSON.stringify({ name: "unused", description: "", url: "", version: "1.0.0", skills: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ id: "orch-x", status: "submitted" }), { status: 200 })
  }
})

afterEach(() => {
  __setTestRouterModel(null)
  __setTestSynthesisModel(null)
  globalThis.fetch = originalFetch
  registry.clear()
  tasks.clear()
  conversations.clear()
  if (originalGraphFlag === undefined) delete process.env.ORCHESTRAI_ORCHESTRATOR_GRAPH
  else process.env.ORCHESTRAI_ORCHESTRATOR_GRAPH = originalGraphFlag
  if (originalApiKey === undefined) delete process.env.ORCHESTRAI_LLM_API_KEY
  else process.env.ORCHESTRAI_LLM_API_KEY = originalApiKey
})

describe("GET /healthz — TUI shared-header context", () => {
  test("exposes the Orchestrator's authoritative project path additively", async () => {
    const response = await app.request("/healthz")
    const body = (await response.json()) as { status: string; projectPath?: string }
    expect(response.status).toBe(200)
    expect(body.status).toBe("ok")
    expect(body.projectPath).toBe(process.env.ORCHESTRAI_PROJECT_PATH ?? process.cwd())
  })
})

async function ask(question: string, conversationId?: string) {
  const res = await app.request("/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conversationId ? { question, conversationId } : { question }),
  })
  return { status: res.status, json: (await res.json()) as Record<string, any> }
}

describe("POST /ask — request validation", () => {
  test("rejects a missing question", async () => {
    const { status, json } = await ask("")
    expect(status).toBe(400)
    expect(json.error).toContain("question required")
  })

  test("rejects an unknown conversationId rather than silently starting a new thread", async () => {
    const { status, json } = await ask("what agents do you have?", "conv-does-not-exist")
    expect(status).toBe(404)
    expect(json.error).toContain("Conversation not found")
  })

  test("rejects a malformed JSON body", async () => {
    const res = await app.request("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    })
    expect(res.status).toBe(400)
  })
})

describe("tier 0 — answered from live state, nothing dispatched", () => {
  test("a capability question answers from the registry with no task and no network call", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status", "dockerize"]))
    registry.set("security-agent", agent("security-agent", ["scan-secrets"]))

    const { json } = await ask("what agents do you have?")

    expect(json.tier).toBe(0)
    expect(json.requiresApproval).toBe(false)
    expect(json.taskId).toBeUndefined()
    expect(json.answer).toContain("devops-agent")
    expect(json.answer).toContain("security-agent")
    expect(json.answer).toContain("scan-secrets")
    // The load-bearing assertions: no task was created, and no agent was
    // contacted at all.
    expect(tasks.size).toBe(0)
    expect(capturedRequests).toEqual([])
  })

  test("reports honestly when nothing is online", async () => {
    const { json } = await ask("what can you do?")
    expect(json.answer).toContain("No agents are online")
  })

  test("a recent-tasks question answers from the task store", async () => {
    const { json: first } = await ask("what was the last task")
    expect(first.answer).toContain("No tasks have run yet")

    registry.set("devops-agent", agent("devops-agent", ["git-status"]))
    await ask("git status at C:\\proj")

    const { json: second } = await ask("what was the last task")
    expect(second.tier).toBe(0)
    expect(second.answer).toContain("git-status")
  })

  // specs/091-chat-explain-last-failure/spec.md
  test("a failure question answers with the real most-recently-failed task's own error, not the generic roster+list", async () => {
    const { json: none } = await ask("why did it fail?")
    expect(none.answer).toContain("No recent task has failed")

    registry.set("devops-agent", agent("devops-agent", ["git-status"]))
    // A skill this fixture's fake HTTP client doesn't recognize as
    // successful — dispatchRootTask()'s own error path stores a real,
    // specific error string on the task, which is exactly what this
    // answer must surface verbatim.
    await ask("git status at C:\\proj")
    tasks.get([...tasks.keys()][0]!)!.status = "failed"
    tasks.get([...tasks.keys()][0]!)!.error = "a real, specific failure reason"

    const { json: failed } = await ask("why did it fail last time?")
    expect(failed.tier).toBe(0)
    expect(failed.answer).toContain("a real, specific failure reason")
    expect(failed.answer).toContain("git-status")
    // The load-bearing distinction: NOT the generic roster+list shape.
    expect(failed.answer).not.toContain("most recent task")
  })

  // specs/092-router-classification-conversation-context/spec.md — the
  // exact real scenario that surfaced this bug, end to end through the
  // real /ask handler (not a direct unit call to classifyRouterProposal):
  // a short reply is only correctly classified once the router's own
  // prompt genuinely carries the preceding assistant turn.
  test("a short contextual reply is classified using real conversation history, not in isolation", async () => {
    class ContextAwareFake extends BaseChatModel {
      constructor() {
        super({})
      }
      _llmType(): string {
        return "context-aware-fake"
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        const last = messages[messages.length - 1]
        const text = typeof last?.content === "string" ? last.content : String(last?.content ?? "")
        // Only recognizes "yes it can" as a real state-question reply
        // when the preceding turn's own question is genuinely present in
        // the prompt — proving history reached this model, not just that
        // some proposal came back.
        const kind = text.includes("Is the computer able to access the url?") && text.includes("yes it can")
          ? "state-question"
          : "conversation"
        const content = JSON.stringify({
          skillId: "unsupported", target: null, confidence: 0.9, reason: "context-aware-fake", kind,
        })
        return { generations: [{ text: content, message: new AIMessage(content) }] }
      }
    }

    const { json: first } = await ask("hello")
    const conversationId = first.conversationId
    // Seed a controlled assistant turn directly — deterministic and
    // independent of whatever a real earlier dispatch would have said,
    // so this test isolates exactly the claim it's making: does the
    // conversation's own real prior turn reach the classification prompt.
    appendTurn(conversations.get(conversationId)!, {
      id: "seeded-assistant-turn",
      role: "assistant",
      text: "That failed: MCP unavailable. Is the computer able to access the url?",
      timestamp: Date.now(),
    })

    __setTestRouterModel(new ContextAwareFake())
    const { json: reply } = await ask("yes it can", conversationId)

    // The fake only returns "state-question" when it can see the prior
    // turn's own question text — so a non-generic answer here proves
    // history genuinely reached the classification prompt.
    expect(reply.tier).toBe(0)
    expect(reply.answer).not.toBe("Hi — I'm OrchestrAI's orchestrator. Ask what I can do, or tell me what you'd like done.")
  })

  // specs/093-conversation-answer-context-blind/spec.md
  describe("a 'conversation' answer reflects what's actually happened, once there's history", () => {
    test("a genuine first-contact greeting (no prior turns) is byte-identical to before this spec", async () => {
      const { json } = await ask("hello")
      expect(json.tier).toBe(0)
      expect(json.answer).toBe("Hi — I'm OrchestrAI's orchestrator. Ask what I can do, or tell me what you'd like done.")
    })

    test("mid-conversation, after a real recent failure, the answer names it instead of the generic greeting", async () => {
      const { json: first } = await ask("hello")
      const conversationId = first.conversationId

      registry.set("devops-agent", agent("devops-agent", ["git-status"]))
      await ask("git status at C:\\proj", conversationId)
      tasks.get([...tasks.keys()][0]!)!.status = "failed"
      tasks.get([...tasks.keys()][0]!)!.error = "a real, specific failure reason"

      const { json: reply } = await ask("hello", conversationId)
      expect(reply.tier).toBe(0)
      expect(reply.answer).not.toBe("Hi — I'm OrchestrAI's orchestrator. Ask what I can do, or tell me what you'd like done.")
      expect(reply.answer).toContain("git-status")
      expect(reply.answer).toContain("didn't work")
      // Never invents a fact absent from real state — only names the
      // real skill/agent already on the real failed task.
      expect(reply.answer).not.toContain("a real, specific failure reason")
    })

    test("mid-conversation with no recent failure, the answer is still context-aware but not the generic greeting", async () => {
      const { json: first } = await ask("hello")
      const conversationId = first.conversationId

      const { json: reply } = await ask("hello", conversationId)
      expect(reply.tier).toBe(0)
      expect(reply.answer).not.toBe("Hi — I'm OrchestrAI's orchestrator. Ask what I can do, or tell me what you'd like done.")
      expect(reply.answer).toContain("what would you like")
    })
  })

  // specs/097-chat-answer-and-plan-description-honesty/spec.md — a canned,
  // content-free raw answer never gets synthesized: duplicating a fixed
  // sentence below its own AI paraphrase shows the same message twice
  // with nothing gained. Proven via the real call counter, not just
  // output equality (which would pass even without this fix, since no
  // key is configured in this suite and synthesis was already a no-op —
  // the counter is what actually proves the call itself was skipped).
  // Amended by specs/124-conversation-answer-llm-synthesis/spec.md: the
  // "conversation"-intent cases below (both "hello" variants) are exactly
  // the fixed-string-blind-to-content bug specs/124 fixes, so that
  // branch now always attempts synthesis (falling back to this same fixed
  // text when no key is configured, as in this hermetic suite) — this
  // specs/097 skip-entirely rule now applies only to non-conversation
  // Tier-0 intents (e.g. the "failure with nothing failed" case below).
  describe("canned, content-free answers skip synthesis entirely (specs/097)", () => {
    test("a genuine first-contact greeting still attempts synthesis (specs/124)", async () => {
      await ask("hello")
      expect(__getTestSynthesisCallCount()).toBe(1)
    })

    test("mid-conversation with no recent failure still attempts synthesis (specs/124)", async () => {
      const { json: first } = await ask("hello")
      __resetTestSynthesisCallCount()
      await ask("hello", first.conversationId)
      expect(__getTestSynthesisCallCount()).toBe(1)
    })

    test("a failure question with nothing having failed makes zero synthesis calls", async () => {
      await ask("why did it fail?")
      expect(__getTestSynthesisCallCount()).toBe(0)
    })

    test("by contrast, a real-data 'state' answer still calls synthesis (unchanged behavior)", async () => {
      await ask("what agents do you have?")
      // Synthesis is still attempted for real state data — this call
      // returns null in this test environment (no key configured), but
      // the function itself IS invoked, proving the guard is scoped to
      // only the canned strings, not every Tier-0 answer.
      expect(__getTestSynthesisCallCount()).toBe(1)
    })

    test("by contrast, a real recorded failure still calls synthesis (unchanged behavior)", async () => {
      registry.set("devops-agent", agent("devops-agent", ["git-status"]))
      await ask("git status at C:\\proj")
      tasks.get([...tasks.keys()][0]!)!.status = "failed"
      tasks.get([...tasks.keys()][0]!)!.error = "a real, specific failure reason"
      __resetTestSynthesisCallCount()

      await ask("why did it fail?")
      expect(__getTestSynthesisCallCount()).toBe(1)
    })
  })

  // specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md, amended by
  // specs/124-conversation-answer-llm-synthesis/spec.md — "conversation"
  // intent now DOES attempt synthesis (specs/124 fixes the content-blind
  // fixed-string bug), but its result REPLACES buildConversationAnswer()'s
  // text rather than stacking with it — the specs/116 regression ("there
  // is 2 person responding me") came from stacking two independently-
  // phrased answers, not from synthesizing at all. This hermetic suite has
  // no LLM key configured, so synthesizeAnswer() always returns null here,
  // and the branch falls back to buildConversationAnswer()'s text
  // verbatim — the fail-open path specs/124 requires.
  describe("'conversation' intent synthesizes but falls back to the fixed text with no key configured (specs/124)", () => {
    test("a dynamic reply naming a real recent failure still attempts synthesis", async () => {
      const { json: first } = await ask("hello")
      const conversationId = first.conversationId

      registry.set("devops-agent", agent("devops-agent", ["git-status"]))
      await ask("git status at C:\\proj", conversationId)
      tasks.get([...tasks.keys()][0]!)!.status = "failed"
      tasks.get([...tasks.keys()][0]!)!.error = "a real, specific failure reason"
      __resetTestSynthesisCallCount()

      await ask("thanks", conversationId)
      expect(__getTestSynthesisCallCount()).toBe(1)
    })

    test("with no key configured, the answer falls back to buildConversationAnswer()'s text verbatim — no second phrasing concatenated below it", async () => {
      const { json: first } = await ask("hello")
      const conversationId = first.conversationId

      registry.set("devops-agent", agent("devops-agent", ["git-status"]))
      await ask("git status at C:\\proj", conversationId)
      tasks.get([...tasks.keys()][0]!)!.status = "failed"
      tasks.get([...tasks.keys()][0]!)!.error = "a real, specific failure reason"

      const { json: reply } = await ask("thanks", conversationId)
      expect(reply.answer).toBe(
        "Got it. The most recent thing that didn't work was git-status (devops-agent) — want me to try that again, or ask me something else?",
      )
      // The load-bearing negative: no "\n\n" join, meaning nothing else
      // was appended below this one complete reply.
      expect(reply.answer).not.toContain("\n\n")
    })

    test("a 'conversation' turn carries no summary field — there is nothing separate to summarize", async () => {
      const { json: first } = await ask("hello")
      const conversationId = first.conversationId
      await ask("thanks", conversationId)

      const turns = conversations.get(conversationId)!.turns
      const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant")!
      expect(lastAssistant.summary).toBeUndefined()
    })

    // specs/124-conversation-answer-llm-synthesis/spec.md — the actual
    // fix: with a real (here, faked) model configured, the reply varies
    // with what the user actually said, instead of the two fixed strings
    // that were previously shown byte-identically regardless of content.
    test("with a configured model, the reply varies with the real message and replaces the fixed text outright", async () => {
      class EchoQuestionFake extends BaseChatModel {
        constructor() {
          super({})
        }
        _llmType(): string {
          return "echo-question-fake"
        }
        async _generate(messages: BaseMessage[]): Promise<ChatResult> {
          const last = messages[messages.length - 1]
          const text = typeof last?.content === "string" ? last.content : String(last?.content ?? "")
          const question = text.match(/Question: (.+)/)?.[1] ?? "?"
          const content = JSON.stringify({ answer: `You said: ${question}` })
          return { generations: [{ text: content, message: new AIMessage(content) }] }
        }
      }

      const { json: first } = await ask("hello")
      const conversationId = first.conversationId
      __setTestSynthesisModel(new EchoQuestionFake())

      const { json: thanks } = await ask("thanks", conversationId)
      expect(thanks.answer).toBe("You said: thanks")
      // Replacement, not stacking (specs/124 fixes the specs/116
      // regression by removing the join, not by removing synthesis) —
      // the fixed grounding text must never also appear.
      expect(thanks.answer).not.toContain("what would you like me to do next")
      expect(thanks.answer).not.toContain("\n\n")

      const { json: thankYou } = await ask("thank you", conversationId)
      expect(thankYou.answer).toBe("You said: thank you")
      expect(thankYou.answer).not.toBe(thanks.answer)
    })
  })

  // specs/116-chat-answer-voice-and-collapsed-raw-data/spec.md — the
  // summary/text split for "state"/"failure" intents, where synthesis
  // is still legitimate. This hermetic suite has no LLM key configured,
  // so synthesizeAnswer() always returns null here (confirmed by the
  // specs/097 tests above still asserting call count 1, not a non-null
  // result) — the success path (summary actually populated) is
  // live-verified separately; see verification.md.
  describe("'state'/'failure' turns: text unchanged, summary only when synthesis actually produced one (specs/116)", () => {
    test("with no key configured, text is the raw answer alone and summary is absent", async () => {
      const { json: first } = await ask("hello")
      const conversationId = first.conversationId
      const { json: reply } = await ask("what agents do you have?", conversationId)

      const turns = conversations.get(conversationId)!.turns
      const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant")!
      expect(lastAssistant.text).toBe(reply.answer)
      expect(lastAssistant.summary).toBeUndefined()
    })
  })
})

describe("tier 2 — read-only skill, dispatched without approval", () => {
  test("dispatches through the same path POST /tasks uses and needs no approval", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))

    const { json } = await ask("what's my git status at C:\\proj?")

    expect(json.tier).toBe(2)
    expect(json.skill).toBe("git-status")
    expect(json.requiresApproval).toBe(false)
    expect(json.taskId).toBeTruthy()

    // A real task exists, carrying the authoritative selectedSkill —
    // proof it went through the normal dispatch path, not a shortcut.
    const task = tasks.get(json.taskId)
    expect(task?.skill).toBe("git-status")
    // specs/046 — the originating turn exposes the existing task link before
    // the asynchronous assistant result exists, so a running/approval card
    // survives refresh without inventing a second association.
    const conversation = conversations.get(json.conversationId)
    expect(conversation?.turns[0].taskId).toBe(json.taskId)
    expect(conversation?.turns[0].skill).toBe("git-status")
    const sent = capturedRequests.some((r) => r.url.includes("devops-agent") && r.body?.selectedSkill === "git-status")
    expect(sent).toBe(true)
  })
})

describe("tier 1 — write-capable skill, approval flagged", () => {
  test("a coverage question is tier 1 and flags that approval will be required", async () => {
    registry.set("testing-agent", agent("testing-agent", ["check-coverage"]))

    const { json } = await ask("is there test coverage at C:\\proj?")

    expect(json.tier).toBe(1)
    expect(json.skill).toBe("check-coverage")
    // The question was phrased as a yes/no question, but it still executes
    // a real process — so the existing gate still applies, unchanged.
    expect(json.requiresApproval).toBe(true)
    expect(json.taskId).toBeTruthy()
  })

  test("a skill with no online agent is not nameable by the router — falls through to plan-task, not a best-effort dispatch", async () => {
    // specs/065-llm-only-skill-routing/spec.md — the capability router
    // can only ever name a skill that is in the live snapshot (an agent
    // currently advertises it). With no devops-agent registered here,
    // "dockerize" isn't in the snapshot, so the router's proposal for it
    // is rejected and the request falls through to plan-task — the
    // router's own stated safety property, not a regression. Before this
    // spec, keyword matching returned "dockerize" unvalidated and the
    // /ask flow then reported "No agent found for skill"; that error
    // path is now unreachable for an offline skill by design.
    const { json } = await ask("dockerize my app at C:\\proj")
    // No "No agent found for skill" error — that path is unreachable for
    // an offline skill now. The request instead becomes a plan-task
    // (which the ask classifier legitimately flags Tier 1 / approval-
    // needing, since a plan may produce a write step) — a real behavior
    // change from before this spec, not a regression.
    expect(JSON.stringify(json)).not.toContain("No agent found for skill")
  })
})

describe("the underlying task's own result is never modified by the answer layer", () => {
  test("the assistant turn adds text; the task's real result stays byte-identical", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))
    const REAL_RESULT = "=== Git Status ===\nBranch: main\nStatus: clean"

    // Poll GET .../tasks/:agentTaskId reports this task as completed with
    // a known result, exactly the shape a real agent returns.
    const originalFetch2 = globalThis.fetch
    // @ts-expect-error — test double
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      capturedRequests.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
      if (url.includes("/.well-known/agent.json")) {
        return new Response(JSON.stringify({ name: "unused", description: "", url: "", version: "1.0.0", skills: [] }), { status: 200 })
      }
      if (url.includes("/tasks/orch-")) {
        return new Response(JSON.stringify({ status: "completed", result: REAL_RESULT }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: "orch-x", status: "submitted" }), { status: 200 })
    }

    const { json } = await ask("what's my git status?")
    // The watcher polls once per second; give it two ticks.
    await new Promise((r) => setTimeout(r, 2200))
    globalThis.fetch = originalFetch2

    const task = tasks.get(json.taskId)
    expect(task?.result).toBe(REAL_RESULT) // untouched — byte-identical to what the agent returned

    const conv = conversations.get(json.conversationId)!
    const assistantTurn = conv.turns.find((t) => t.role === "assistant")
    expect(assistantTurn?.text).toContain(REAL_RESULT) // the turn carries it, additively
  })
})

describe("conversations and turns", () => {
  test("a first ask creates a conversation with the user turn recorded", async () => {
    const { json } = await ask("what can you do?")
    expect(json.conversationId).toBeTruthy()

    const res = await app.request(`/conversations/${json.conversationId}`)
    const conv = (await res.json()) as any
    expect(conv.turns.length).toBe(2)
    expect(conv.turns[0].role).toBe("user")
    expect(conv.turns[0].text).toBe("what can you do?")
    expect(conv.turns[1].role).toBe("assistant")
    expect(conv.turns[1].tier).toBe(0)
  })

  test("passing a conversationId continues the same thread rather than starting a new one", async () => {
    const { json: first } = await ask("what can you do?")
    const { json: second } = await ask("what was the last task", first.conversationId)

    expect(second.conversationId).toBe(first.conversationId)
    expect(conversations.size).toBe(1)

    const res = await app.request(`/conversations/${first.conversationId}`)
    const conv = (await res.json()) as any
    expect(conv.turns.length).toBe(4)
  })

  test("a follow-up reuses the previous turn's skill and its original text", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))

    const { json: first } = await ask("git status at C:\\proj")
    expect(first.skill).toBe("git-status")

    // The assistant turn is appended asynchronously once the task
    // terminates; the follow-up must resolve from the dispatched turn, so
    // seed it the way a completed exchange would look.
    const conv = conversations.get(first.conversationId)!
    conv.turns.push({
      id: "turn-seeded",
      role: "assistant",
      text: "(result)",
      timestamp: Date.now(),
      tier: 2,
      skill: "git-status",
      taskId: first.taskId,
    })

    const { json: again } = await ask("run it again", first.conversationId)
    expect(again.skill).toBe("git-status")
    expect(again.reason).toBe("followup:reuse:git-status")

    // The replayed dispatch carried the ORIGINAL text verbatim, so the
    // target path survived a follow-up that never mentioned it. Asserted
    // against the real envelope field rather than a stringified blob.
    const textOf = (r: (typeof capturedRequests)[number]) =>
      (r.body as { message?: { parts?: { text?: string }[] } } | null)?.message?.parts?.[0]?.text

    const replay = capturedRequests.filter((r) => r.body?.selectedSkill === "git-status")
    expect(replay.length).toBe(2)
    expect(textOf(replay[0])).toBe("git status at C:\\proj")
    expect(textOf(replay[1])).toBe("git status at C:\\proj")
  })

  test("GET /conversations lists threads without their full turn history", async () => {
    await ask("what can you do?")
    await ask("what can you do?")

    const res = await app.request("/conversations")
    const listed = (await res.json()) as any
    expect(listed.count).toBe(2)
    expect(listed.conversations[0].turnCount).toBe(2)
    expect(listed.conversations[0].turns).toBeUndefined()
  })

  test("GET /conversations exposes only a bounded preview and deterministic linked-task state", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))
    const question = "what is my git status at C:\\proj? " + "x".repeat(180)
    const { json } = await ask(question)

    const res = await app.request("/conversations")
    const listed = (await res.json()) as any
    const summary = listed.conversations.find((item: any) => item.id === json.conversationId)
    expect(summary.preview).toBe(question.slice(0, 120))
    expect(summary.preview.length).toBe(120)
    expect(summary.taskStatus).toBe(tasks.get(json.taskId)?.status)
    expect(summary.turns).toBeUndefined()
  })

  test("GET /conversations/:id 404s on an unknown id", async () => {
    const res = await app.request("/conversations/conv-nope")
    expect(res.status).toBe(404)
  })
})

describe("POST /tasks is unaffected by any of this", () => {
  test("submitting a task directly still returns the pre-044 shape and creates no conversation", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "git status at C:\\proj" }),
    })
    const json = (await res.json()) as any

    expect(json.assignedAgent).toBe("devops-agent")
    expect(json.skill).toBe("git-status")
    expect(json.isPlan).toBe(false)
    expect(conversations.size).toBe(0)
  })
})

// specs/044 Phase 2 — the conversational surface on the event stream.
describe("AG-UI events for conversational turns", () => {
  test("an assistant turn emits the TEXT_MESSAGE_* trio, correlated by messageId", async () => {
    const seen: any[] = []
    const unsubscribe = subscribeToEvents((e) => seen.push(e))

    try {
      await ask("what can you do?")
    } finally {
      unsubscribe()
    }

    const start   = seen.find((e) => e.type === "TEXT_MESSAGE_START")
    const content = seen.find((e) => e.type === "TEXT_MESSAGE_CONTENT")
    const end     = seen.find((e) => e.type === "TEXT_MESSAGE_END")

    expect(start).toBeTruthy()
    expect(content).toBeTruthy()
    expect(end).toBeTruthy()
    expect(start.role).toBe("assistant")
    // One message, three events — the ids must agree or a client cannot
    // assemble them.
    expect(content.messageId).toBe(start.messageId)
    expect(end.messageId).toBe(start.messageId)
    expect(content.delta).toContain("No agents are online")
  })

  test("a task dispatched from /ask carries the CONVERSATION as threadId, distinct from runId", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))

    const seen: any[] = []
    const unsubscribe = subscribeToEvents((e) => seen.push(e))
    let json: Record<string, any>
    try {
      ;({ json } = await ask("git status at C:\proj"))
    } finally {
      unsubscribe()
    }

    const started = seen.find((e) => e.type === "RUN_STARTED")
    expect(started).toBeTruthy()
    expect(started.runId).toBe(json!.taskId)
    expect(started.threadId).toBe(json!.conversationId)
    // The whole point: these are genuinely different values now.
    expect(started.threadId).not.toBe(started.runId)
  })

  test("a task submitted through POST /tasks still has threadId === runId, unchanged", async () => {
    registry.set("devops-agent", agent("devops-agent", ["git-status"]))

    const seen: any[] = []
    const unsubscribe = subscribeToEvents((e) => seen.push(e))
    try {
      await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "git status at C:\proj" }),
      })
    } finally {
      unsubscribe()
    }

    const started = seen.find((e) => e.type === "RUN_STARTED")
    expect(started.threadId).toBe(started.runId)
  })
})

// specs/044 Phase 3 — the dashboard chat panel, asserted against the real
// generated HTML in-process (app.fetch, no port bound) — the technique
// specs/035/040 established for the inline dashboards.
describe("dashboard conversation and operations workspace", () => {
  test("the rendered dashboard contains the Ask panel and its client functions", async () => {
    const res = await app.request("/dashboard")
    expect(res.status).toBe(200)
    const html = await res.text()

    // The panel itself.
    expect(html).toContain('id="chatThread"')
    expect(html).toContain('id="askInput"')
    expect(html).toContain("sendAsk()")
    expect(html).toContain("newConversation()")

    // Its behavior: posts to /ask, re-reads the authoritative store, and
    // refreshes on the new message event.
    expect(html).toContain("'/ask'")
    expect(html).toContain("'/conversations/'")
    expect(html).toContain("TEXT_MESSAGE_END")

    // Tier badges, so a user can see WHY something needed approval.
    expect(html).toContain("needs approval")
    expect(html).toContain("answered from state")
  })

  test("the pre-existing task form and table are still present in the Tasks view", async () => {
    const res = await app.request("/dashboard")
    const html = await res.text()

    // specs/046 moves the controls but does not remove or replace them.
    expect(html).toContain('id="taskInput"')
    expect(html).toContain("sendTask()")
    expect(html).toContain('id="taskRows"')
  })

  test("renders one accessible Chat-default shell with reversible hash navigation", async () => {
    const html = await (await app.request("/dashboard")).text()

    expect(html).toContain('role="tablist"')
    expect(html).toContain('id="tab-chat"')
    expect(html).toContain('id="tab-tasks"')
    expect(html).toContain('id="tab-agents"')
    expect(html).toContain('id="panel-chat" class="view-panel" role="tabpanel"')
    expect(html).toContain('id="panel-tasks" class="view-panel" role="tabpanel" aria-labelledby="tab-tasks" tabindex="0" hidden')
    expect(html).toContain('id="panel-agents" class="view-panel" role="tabpanel" aria-labelledby="tab-agents" tabindex="0" hidden')
    expect(html).toContain("function parseDashboardHash")
    expect(html).toContain("window.addEventListener('hashchange', applyLocation)")
    expect(html).not.toContain('type="checkbox"')
    expect(html.match(/new EventSource\('\/events'\)/g)).toHaveLength(1)
  })

  test("hash helpers round-trip identifiers and fail closed to Chat", async () => {
    const html = await (await app.request("/dashboard")).text()
    const start = html.indexOf("function parseDashboardHash")
    const end = html.indexOf("function navigateTo", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const source = html.slice(start, end)
    const helpers = new Function(
      `const VIEW_NAMES = ["chat", "tasks", "agents"]; ${source}; return { parseDashboardHash, dashboardHash }`,
    )() as {
      parseDashboardHash: (hash: string) => { view: string; id: string | null }
      dashboardHash: (view: string, id?: string) => string
    }

    expect(helpers.parseDashboardHash("")).toEqual({ view: "chat", id: null })
    expect(helpers.parseDashboardHash("#tasks/task%2F123")).toEqual({ view: "tasks", id: "task/123" })
    expect(helpers.parseDashboardHash("#unknown/anything")).toEqual({ view: "chat", id: null })
    expect(helpers.parseDashboardHash("#chat/%E0%A4%A")).toEqual({ view: "chat", id: null })
    expect(helpers.dashboardHash("chat", "conv/one")).toBe("#chat/conv%2Fone")
    expect(helpers.dashboardHash("invalid", "ignored")).toBe("#chat")
  })

  test("keeps Chat intent-focused and puts full operational controls in their dedicated views", async () => {
    const html = await (await app.request("/dashboard")).text()

    expect(html).toContain('id="conversationList"')
    expect(html).toContain('id="activityList"')
    expect(html).toContain('id="newUpdates"')
    expect(html).toContain('id="statusFilter"')
    expect(html).toContain('id="agentFilter"')
    expect(html).toContain('id="agentCards"')
    expect(html).toContain("openTaskFromChat")
    expect(html).toContain("returnToConversation")
    expect(html).toContain("decisionInFlight")
  })

  test("includes focus-safe dialogs, live announcements, responsive layouts and reduced motion", async () => {
    const html = await (await app.request("/dashboard")).text()

    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain("modal.setAttribute('role', 'alertdialog')")
    expect(html).toContain("function handleModalKey")
    expect(html).toContain("prefers-reduced-motion:reduce")
    expect(html).toContain("@media(max-width:720px)")
  })

  // specs/097-chat-answer-and-plan-description-honesty/spec.md — the
  // dashboard's own generated JS contains the new reminder text and the
  // parentTaskId-scoping condition, the same "confirmed in-process
  // app.fetch(), string-content check" technique specs/033/035
  // established for the inline dashboards (no bundler links this script
  // to a separately-testable module).
  test("the dashboard's inline-script rendering functions include the plan-step description reminder", async () => {
    const html = await (await app.request("/dashboard")).text()
    expect(html).toContain("planning-time intent, not a promise")
    // renderApprovalBlock() itself (the chat-linked-card render point) —
    // its own template-literal source, evaluated only client-side.
    expect(html).toContain("descriptionNote")
  })

  test("the Tasks table's server-rendered row shows the reminder note for a real plan step's own pending approval, never for a direct task", async () => {
    tasks.set("plan-child-1", {
      id: "plan-child-1", text: "run-command: list files — do the thing", skill: "run-command",
      status: "input-required", createdAt: new Date(), parentTaskId: "plan-parent-1",
      approval: { actionId: "a1", kind: "command", summary: "run", target: "x", risks: [] },
    } as any)
    tasks.set("direct-task-1", {
      id: "direct-task-1", text: "dockerize", skill: "dockerize",
      status: "input-required", createdAt: new Date(),
      approval: { actionId: "a2", kind: "file-write", summary: "write", target: "y", risks: [] },
    } as any)

    const html = await (await app.request("/dashboard")).text()
    const rows = html.split("data-task-id=")
    const planChildRow = rows.find((r) => r.startsWith('"plan-child-1"'))
    const directRow = rows.find((r) => r.startsWith('"direct-task-1"'))

    expect(planChildRow).toContain("planning-time intent, not a promise")
    expect(directRow).not.toContain("planning-time intent, not a promise")
  })

  test("has no duplicate static DOM ids", async () => {
    const html = await (await app.request("/dashboard")).text()
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("escapes untrusted Agent Card content before rendering", async () => {
    const malicious = agent('evil"><img src=x onerror=alert(1)>', ["<script>alert(1)</script>"])
    malicious.card.description = "<svg onload=alert(1)>"
    registry.set(malicious.card.name, malicious)

    const html = await (await app.request("/dashboard")).text()
    expect(html).not.toContain("<img src=x onerror=alert(1)>")
    expect(html).not.toContain("<svg onload=alert(1)>")
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(escapeDashboardHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;")
  })
})

// specs/046 Amendment 1 (2026-09-03) — a plan's own task.status never
// becomes input-required; only the children it dispatches one at a time
// do (specs/028/038). Before this fix, a chat-linked plan with a real
// child waiting for approval showed only a running badge in Chat, with
// no indication anything needed a decision — confirmed here by actually
// EXECUTING the real extracted client functions against fake task data
// and asserting on their real string output, not just checking the HTML
// contains certain substrings.
describe("specs/046 Amendment 1 — a plan's waiting child is surfaced in its chat card", () => {
  // findWaitingPlanChild()/renderTaskCard() close over the module-level
  // `let taskCache` as a free variable (not a parameter) in the real file
  // — so `taskCache` is declared as a `new Function` PARAMETER here with
  // the exact same name, which normal JS scoping resolves identically to
  // a real closure for the function declarations nested inside.
  async function extractCardHelpers(taskCache: Record<string, any>) {
    const html = await (await app.request("/dashboard")).text()

    const slice = (startMarker: string, endMarker: string) => {
      const start = html.indexOf(startMarker)
      const end = html.indexOf(endMarker, start)
      expect(start).toBeGreaterThan(0)
      expect(end).toBeGreaterThan(start)
      return html.slice(start, end)
    }

    // Two non-contiguous regions of the same client script: findWaitingPlanChild/
    // renderApprovalBlock/renderTaskCard's own section, and escapeHtml/
    // contentPreviewHtml/renderApprovalCard's section it calls into. `new Function`
    // hoists declarations regardless of textual order, so concatenating both is
    // enough to execute the real dependency chain with no DOM at all except the
    // one call (escapeChat) that genuinely needs it.
    const cardSection = slice("function escapeChat(text)", "function renderConversation(conv, pendingNote)")
    const approvalSection = slice("function escapeHtml(s)", "let rawJsonVisible = false")

    // The minimal real behavior escapeChat needs: HTML-escape via textContent
    // round-tripping, exactly what a real <div> does. Nothing else in this
    // suite's execution ever touches `document`.
    const fakeDocument = {
      createElement: () => {
        let text = ""
        return {
          set textContent(value: string) { text = String(value) },
          get innerHTML() {
            return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          },
        }
      },
    }

    const helpers = new Function(
      "document", "taskCache", "decisionInFlight",
      `${cardSection}\n${approvalSection}\nreturn { findWaitingPlanChild, renderTaskCard }`,
    )(fakeDocument, taskCache, new Set()) as {
      findWaitingPlanChild: (task: any) => any
      renderTaskCard: (task: any, sourceConversationId: string) => string
    }
    return helpers
  }

  const APPROVAL = { actionId: "action-1", target: "C:\\proj\\Dockerfile", kind: "write" }

  test("finds the one real input-required child, ignoring completed/pending siblings", async () => {
    const { findWaitingPlanChild } = await extractCardHelpers({
      "child-1": { id: "child-1", status: "completed" },
      "child-2": { id: "child-2", status: "input-required", skill: "dockerize", approval: APPROVAL },
      "child-3": { id: "child-3", status: "pending" },
    })
    const plan = { isPlan: true, childTaskIds: ["child-1", "child-2", "child-3"] }

    const found = findWaitingPlanChild(plan)
    expect(found?.id).toBe("child-2")
  })

  test("returns null for a non-plan task, and for a plan with no waiting child", async () => {
    const { findWaitingPlanChild } = await extractCardHelpers({
      "child-1": { id: "child-1", status: "completed" },
    })
    expect(findWaitingPlanChild({ isPlan: false })).toBeNull()
    expect(findWaitingPlanChild({ isPlan: true, childTaskIds: ["child-1"] })).toBeNull()
    expect(findWaitingPlanChild({ isPlan: true })).toBeNull() // no childTaskIds at all yet
  })

  test("a plan with no waiting child renders the plain step summary and no approval block", async () => {
    const { renderTaskCard } = await extractCardHelpers({})
    const plan = {
      id: "plan-1", isPlan: true, skill: "plan-task", status: "working", assignedAgent: "orchestrator-supervisor",
      planSteps: [{ order: 1, description: "Analyze the project", status: "dispatched" }],
    }
    const html = renderTaskCard(plan, "conv-1")

    expect(html).toContain("Analyze the project")
    expect(html).not.toContain("inline-approval")
    expect(html).not.toContain("needs your approval")
  })

  test("a plan with a waiting child renders that child's real approval, keyed to the CHILD's id", async () => {
    const { renderTaskCard } = await extractCardHelpers({
      "child-2": { id: "child-2", status: "input-required", skill: "dockerize", assignedAgent: "devops-agent", approval: APPROVAL },
    })
    const plan = { id: "plan-1", isPlan: true, skill: "plan-task", status: "working", childTaskIds: ["child-2"] }
    const html = renderTaskCard(plan, "conv-1")

    // The badge on the CARD itself still reflects the parent's own status —
    // only the approval block is sourced from the child.
    expect(html).toContain("waiting")
    expect(html).toContain("needs your approval")
    expect(html).toContain(APPROVAL.target)
    expect(html).toContain(APPROVAL.actionId)
    // The load-bearing safety property: the Approve/Reject buttons act on
    // the real CHILD's id — never the parent plan's — so a click can only
    // ever resolve the actionId that was genuinely issued for that write.
    expect(html).toContain('data-decision-task="child-2"')
    expect(html).not.toContain('data-decision-task="plan-1"')
  })

  test("a directly-dispatched (non-plan) task waiting for its own approval is unaffected by this change", async () => {
    const { renderTaskCard } = await extractCardHelpers({})
    const task = { id: "task-1", isPlan: false, skill: "check-coverage", status: "input-required", assignedAgent: "testing-agent", approval: APPROVAL }
    const html = renderTaskCard(task, "conv-1")

    expect(html).toContain('data-decision-task="task-1"')
    expect(html).toContain(APPROVAL.target)
  })
})

// specs/046 Amendment 1 (2026-09-03) — the Tasks table flashing fix.
// patchTaskRows() manipulates real DOM nodes (insertBefore/replaceWith),
// which this suite has no jsdom/happy-dom to execute — adding one would
// violate this spec's own "no new dependency" constraint. Matches this
// file's own existing precedent for exactly this situation (the hash-
// parser test above): syntax-validate the real extracted function via
// new Function(), and assert the specific regression it fixes is gone.
describe("specs/046 Amendment 1 — Tasks table patches rows instead of replacing them all", () => {
  test("patchTaskRows is present, syntactically valid, and is what refreshNow() now calls", async () => {
    const html = await (await app.request("/dashboard")).text()

    const start = html.indexOf("function patchTaskRows(container, newHtml)")
    const end = html.indexOf("async function refreshNow()", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const source = html.slice(start, end)

    // Throws on a syntax error; doesn't execute it (no document.createElement
    // for a real <template> in this test runner).
    expect(() => new Function(source)).not.toThrow()

    expect(html).toContain("patchTaskRows(document.getElementById('taskRows'), frag.rowsHtml)")
  })

  test("the old full-table innerHTML replacement this regression came from is genuinely gone", async () => {
    const html = await (await app.request("/dashboard")).text()
    expect(html).not.toContain("document.getElementById('taskRows').innerHTML = frag.rowsHtml")
  })

  test("patchTaskRows keys rows by data-task-id, the same key renderTaskRows() emits server-side", async () => {
    const html = await (await app.request("/dashboard")).text()
    expect(html).toContain("querySelectorAll('tr[data-task-id]')")
    expect(html).toContain("row.dataset.taskId")
  })
})

// specs/046 Amendment 2 (2026-09-03) — a real regression in Amendment 1's
// own patchTaskRows(), live-caught by Yusuf: "Could not refresh workspace"
// on almost every dispatch. Root cause, confirmed by actually EXECUTING the
// real extracted function against a minimal hand-rolled DOM (not jsdom —
// same "no new dependency" constraint the rest of this file already
// follows, extended here from syntax-only to genuine node-graph behavior):
// the loop's `cursor` variable was captured once per iteration and reused
// as insertBefore()'s reference node AFTER that same node could already
// have been detached by replaceWith() earlier in the same iteration —
// exactly what happens whenever the table's very first (newest) row's own
// content changes between two refreshes, which is nearly every dispatch.
// Real DOM semantics (not simulated loosely): insertBefore(node, ref)
// throws when ref is not currently a child of the container, the same
// error a real browser raises — this harness's fake insertBefore enforces
// that too, so a passing test here is genuine proof, not a tautology.
describe("specs/046 Amendment 2 — patchTaskRows no longer throws when the newest row's content changes", () => {
  function makeFakeDom() {
    function parseRows(html: string) {
      const rows: any[] = []
      const rowRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g
      let m: RegExpExecArray | null
      while ((m = rowRe.exec(html))) rows.push(makeRow(m[1], m[2]))
      return rows
    }
    function makeRow(attrString: string, inner: string) {
      const attrs: Record<string, string> = {}
      const attrRe = /([a-zA-Z0-9_-]+)="([^"]*)"/g
      let am: RegExpExecArray | null
      while ((am = attrRe.exec(attrString))) attrs[am[1]] = am[2]
      const row: any = {
        _attrs: attrs,
        _inner: inner,
        parentNode: null,
        get dataset() {
          const ds: Record<string, string> = {}
          for (const [k, v] of Object.entries(attrs)) {
            if (k.startsWith("data-")) ds[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v
          }
          return ds
        },
        get outerHTML() {
          const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")
          return `<tr ${attrStr}>${inner}</tr>`
        },
        classList: { contains: (c: string) => (attrs["class"] ?? "").split(/\s+/).includes(c) },
        get nextElementSibling() {
          if (!row.parentNode) return null
          const idx = row.parentNode.children.indexOf(row)
          return row.parentNode.children[idx + 1] ?? null
        },
        replaceWith(newNode: any) {
          const p = row.parentNode
          if (!p) throw new Error("replaceWith on a detached node")
          p.children[p.children.indexOf(row)] = newNode
          newNode.parentNode = p
          row.parentNode = null
        },
        remove() {
          if (!row.parentNode) return
          row.parentNode.children = row.parentNode.children.filter((c: any) => c !== row)
          row.parentNode = null
        },
      }
      return row
    }
    function makeContainer(initialHtml: string) {
      const container: any = { children: parseRows(initialHtml) }
      for (const r of container.children) r.parentNode = container
      container.firstElementChildGetterMarker = true
      Object.defineProperty(container, "firstElementChild", { get: () => container.children[0] ?? null })
      container.querySelectorAll = (sel: string) => {
        if (sel !== "tr[data-task-id]") throw new Error("unsupported selector: " + sel)
        return container.children.filter((r: any) => "taskId" in r.dataset)
      }
      // Real DOM semantics: throws if `ref` isn't currently a child.
      container.insertBefore = (node: any, ref: any) => {
        if (ref !== null && !container.children.includes(ref)) {
          throw new Error(
            "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
          )
        }
        const idx = ref === null ? container.children.length : container.children.indexOf(ref)
        container.children.splice(idx, 0, node)
        node.parentNode = container
      }
      Object.defineProperty(container, "innerHTML", {
        set(html: string) {
          container.children = parseRows(html)
          for (const r of container.children) r.parentNode = container
        },
      })
      return container
    }
    const document = {
      createElement: (tag: string) => {
        if (tag !== "template") throw new Error("unexpected tag: " + tag)
        let rows: any[] = []
        return {
          set innerHTML(html: string) { rows = parseRows(html) },
          get content() { return { querySelectorAll: () => rows } },
        }
      },
    }
    return { document, makeContainer }
  }

  async function extractPatchTaskRows() {
    const html = await (await app.request("/dashboard")).text()
    const start = html.indexOf("function patchTaskRows(container, newHtml)")
    const end = html.indexOf("async function refreshNow()", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const source = html.slice(start, end)
    return new Function("document", `${source}\nreturn patchTaskRows`)(makeFakeDom().document) as (
      container: any,
      newHtml: string,
    ) => void
  }

  const row = (id: string, status: string) =>
    `<tr data-task-id="${id}" data-status="${status}"><td>${id}</td><td>${status}</td></tr>`

  test("the newest row's own content changing no longer throws (the exact live-caught regression)", async () => {
    const patchTaskRows = await extractPatchTaskRows()
    const { makeContainer } = makeFakeDom()
    const container = makeContainer(row("task-2", "working") + row("task-1", "completed"))

    expect(() => patchTaskRows(container, row("task-2", "completed") + row("task-1", "completed"))).not.toThrow()
    expect(container.children.map((r: any) => r.dataset.taskId)).toEqual(["task-2", "task-1"])
    expect(container.children[0].dataset.status).toBe("completed")
  })

  test("a genuinely new task is inserted at the front, ahead of existing rows", async () => {
    const patchTaskRows = await extractPatchTaskRows()
    const { makeContainer } = makeFakeDom()
    const container = makeContainer(row("task-1", "completed"))

    patchTaskRows(container, row("task-2", "assigned") + row("task-1", "completed"))
    expect(container.children.map((r: any) => r.dataset.taskId)).toEqual(["task-2", "task-1"])
  })

  test("a task no longer in the response is removed", async () => {
    const patchTaskRows = await extractPatchTaskRows()
    const { makeContainer } = makeFakeDom()
    const container = makeContainer(row("task-2", "completed") + row("task-1", "completed"))

    patchTaskRows(container, row("task-1", "completed"))
    expect(container.children.map((r: any) => r.dataset.taskId)).toEqual(["task-1"])
  })

  test("an unrelated task's own row is never touched (unchanged reference, not just equal content)", async () => {
    const patchTaskRows = await extractPatchTaskRows()
    const { makeContainer } = makeFakeDom()
    const container = makeContainer(row("task-2", "working") + row("task-1", "completed"))
    const untouchedRow = container.children[1]

    patchTaskRows(container, row("task-2", "completed") + row("task-1", "completed"))
    expect(container.children[1]).toBe(untouchedRow) // same node reference — proves it wasn't replaced or moved
  })

  // Found alongside the Amendment 2 crash investigation, not reported by
  // Yusuf: the empty-state row ("No tasks yet", no data-task-id) was never
  // in existingByKey (keyed only by data-task-id), so once the first real
  // task ever arrived it was inserted ahead of the placeholder but the
  // placeholder itself was never removed — a harmless but permanently
  // stale extra row. A "toolcalls" evidence row (also unkeyed, but
  // client-inserted and deliberately left alone — see renderToolCall())
  // must NOT be swept up by the same cleanup, so this also asserts one
  // survives untouched.
  test("a stale unkeyed row (the old empty-state placeholder) is removed once real tasks exist", async () => {
    const patchTaskRows = await extractPatchTaskRows()
    const { makeContainer } = makeFakeDom()
    const container = makeContainer(`<tr><td colspan="5" class="empty">No tasks yet</td></tr>`)

    patchTaskRows(container, row("task-1", "assigned"))
    expect(container.children.map((r: any) => r.dataset.taskId)).toEqual(["task-1"])
    expect(container.children.length).toBe(1) // the placeholder is gone, not left dangling
  })

  test("a client-inserted toolcalls evidence row is never swept up by the same cleanup", async () => {
    const patchTaskRows = await extractPatchTaskRows()
    const { makeContainer } = makeFakeDom()
    const container = makeContainer(row("task-1", "working"))
    const evidenceRow: any = { _attrs: { class: "toolcalls" }, classList: { contains: (c: string) => c === "toolcalls" }, parentNode: container }
    container.children.splice(1, 0, evidenceRow) // sits right after task-1's own row, exactly like renderToolCall() places it

    patchTaskRows(container, row("task-1", "completed"))
    expect(container.children).toContain(evidenceRow)
  })
})
