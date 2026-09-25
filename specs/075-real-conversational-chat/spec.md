---
id: 075-real-conversational-chat
title: Make Chat a Real Conversation — LLM-Classified Intent, Live Progress, Real Findings
area: orchestrator
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-11
updated: 2026-09-14
approved_by: Yusuf
approved_on: 2026-09-14
implemented_on: 2026-09-14
amends:
  - 044-conversational-ask-layer
  - 054-capability-driven-llm-routing
  - 065-llm-only-skill-routing
related:
  - 028-orchestrator-langgraph-supervisor
  - 069-tui-dashboard-parity-workspace
supersedes: []
superseded_by: []
---

# Spec: Make Chat a Real Conversation — LLM-Classified Intent, Live Progress, Real Findings

> Review gate: **APPROVED 2026-09-14 by Yusuf.**
>
> Written from live screenshots, 2026-09-11/12. Yusuf typed `hello` and
> got a five-skill project-wide analysis; *"so now are you working
> fine?"* got **"Supervisor run completed after 2 dispatch(es)."**;
> *"that is what i say"* (a plain retort) triggered `git-status` +
> `analyze-project`. His words: *"that is very stiuped ?!"*, *"the
> chating should be real one it's very suck now"*.
>
> **Revised 2026-09-12** after discussion: the original draft's own §2
> (a deterministic greeting pattern list) was itself an instance of the
> exact thing Yusuf separately asked to move away from — "make it
> through the llm... i need to reduce or remove the deterministic from
> the project." Rewritten to classify intent with the existing
> capability router (already the sole mechanism naming a skill,
> `specs/065`) instead of adding another hardcoded phrase list, and to
> narrate real progress during a run rather than only reacting to it.

## Purpose

Chat is currently incapable of holding a conversation, for two
independent, structural reasons — plus a third gap this revision adds:
a run in progress is silent until it's over.

**(a) Anything the router can't match becomes a project-wide work
order.** `detectSkill()` is `tryCapabilityRoute(...) ?? "plan-task"`
(`specs/065`). Correct for `POST /tasks` — an explicit task submission
with no matching skill genuinely should be planned. Wrong for
`POST /ask`, where the same fallback turns *"hello"* into a real
adaptive-supervisor run. A chat message that names no work should be
**answered**, not executed — and the decision of *which* kind of
non-dispatch answer (a capability question, a history question, or
just chit-chat) should come from the same LLM classification this
codebase already trusts for the harder "which skill" decision, not a
second, narrower hardcoded pattern list layered in front of it.

**(b) A plan-task's answer is a dispatch counter, not its findings.**
`runOrchestratorSupervisor()` sets, on success:

```ts
task.result = `Supervisor run completed after ${result.dispatchCount} dispatch(es).`
```

Every child's real output is discarded at the parent. `/ask` hands that
sentence to `synthesizeAnswer()` as the **only** grounding material —
the synthesizer isn't broken, it's starved.

**(c) A run in progress shows only a static "…thinking".** The chat's
own `chatPending` state is one fixed string for the entire run,
regardless of whether the supervisor is still deciding, a child is
mid-dispatch, or an approval is pending. Real progress already exists —
`STEP_STARTED`/`TOOL_CALL_START` events already flow to the TUI over
the same SSE stream `specs/021` built — nothing surfaces it.

## Verified Current State

Read 2026-09-11/12:

- `apps/orchestrator/ask-classifier.ts`'s `classifyAsk()`: Tier 0 is a
  closed set of exactly two hardcoded patterns — `CAPABILITY_PATTERNS`
  and `RECENT_TASK_PATTERNS`. Everything else calls `detect(trimmed)`
  (`detectSkill()`) and dispatches whatever comes back.
- `packages/shared/capability-router.ts`'s `runCapabilityRouter()` is
  **already** the one LLM call that names a skill for any text
  (`specs/054`/`065`) — one structured-output completion, a closed Zod
  schema (`CapabilityRouterProposalSchema`), bounded retry-with-feedback,
  validated by the caller against the live capability snapshot before
  ever being trusted. It already returns a `kind` field
  (`"read-only"|"state-changing"|"unsupported"`) alongside the skill id.
  This is the natural extension point — extending its own closed output
  schema, not building a second, separate LLM call.
- `apps/orchestrator/index.ts`'s `detectSkill()` returns `"plan-task"`
  whenever the router doesn't resolve a live skill — the fallback that
  makes (a) happen for `/ask`.
- `apps/orchestrator/index.ts:951` — the dispatch-counter line, the only
  thing a completed plan-task ever reports; findings are discarded.
- `answerTextForTerminalTask(task)`/`synthesizeAnswer()`
  (`specs/044`) — unchanged, already fails open to raw text on any
  synthesis error; never the broken part.
- `apps/tui/index.tsx`'s `chatPending` (`setChatPending("thinking…")`,
  `apps/tui/index.tsx:939`) is set once at dispatch and only cleared at
  terminal state; the SSE handler already parses `STEP_STARTED`/
  `TOOL_CALL_START`/`TOOL_CALL_RESULT` events for the Tasks pane's own
  live badges (`apps/tui/index.tsx:776-796`) — the raw signal already
  reaches the client, it's just never read by the chat view.
- `runSupervisor()`'s return value / `task.childTaskIds` already have
  every dispatched step's real outcome — nothing new to fetch.

## Proposed Behavior

### 1. One LLM classification decides skill-or-no-skill-at-all — no new pattern list

`CapabilityRouterProposalSchema`'s `kind` enum gains two more closed
values: `"state-question"` and `"conversation"`, alongside the existing
`"read-only"|"state-changing"|"unsupported"`. The router's own system
prompt is extended to explain them: *"if the request is asking what
OrchestrAI/its agents can do, or about recent task history, respond
with kind 'state-question'; if it's a greeting, thanks, or otherwise
has no actionable intent, respond with kind 'conversation'; otherwise
pick a real skill id or 'unsupported'."* Still one call, still the same
closed-schema/retry/validate shape every other use of this router
already has — no new LLM integration pattern, no second provider call
per message.

`ask-classifier.ts`'s two hardcoded pattern constants
(`CAPABILITY_PATTERNS`, `RECENT_TASK_PATTERNS`) are **deleted**.
`classifyAsk()` calls the router (through a shared helper both it and
`detectSkill()` use — see below) and reads `kind` directly instead of
string-matching the question itself.

**`detectSkill()` (used by `POST /tasks`) is unaffected in observable
behavior**: `kind === "state-question"` or `"conversation"` both map to
the existing `"plan-task"` fallback there, byte-identical to how
`"unsupported"` already does — `POST /tasks` never gains a new outcome,
it just now also treats "this is chit-chat" the same considered way it
already treats "no skill fits." The one shared extraction point (a new
`classifyRouterProposal()` or equivalent) is what keeps the two
endpoints from re-diverging the way `specs/065`'s original `?? "plan-
task"` fallback already did once.

A message that *does* name real work is unaffected — same router call,
same validation against the live snapshot, same dispatch.

### 2. `/ask` answers `"state-question"`/`"conversation"` without dispatching

Zero dispatch, zero child task, zero approval surface — same as the
original draft's `"conversation"` intent, now reached via the router's
own classification instead of a pattern list. `buildStateAnswer()`
still produces the deterministic state text (agents online, recent
tasks) for `"state-question"`; a short deterministic fallback sentence
covers `"conversation"` when no key is configured (chat must never be
blank and must never *require* a provider to say hello back).
`synthesizeAnswer()` (unchanged) phrases either one conversationally
when a key exists.

### 3. A plan-task's result carries what actually happened

Unchanged from the original draft. `runOrchestratorSupervisor()`'s
success branch composes its result from the real per-dispatch outcomes
— skill id, agent, status, and each child's own result text, in
dispatch order — instead of only a dispatch count (which stays, as a
trailing line). Deterministic assembly of data the parent already owns
the ids of; no model involved. Bound by the existing
`boundTaskResult()`/`TASK_RESULT_MAX_BYTES` (64 KiB) path, same explicit
truncation marker on overflow. This is what gives `synthesizeAnswer()`
real material to work with for the first time.

### 4. Live progress during a run — real events, not a static placeholder

While a dispatched turn is in flight, `chatPending` narrates the
**real, current step** instead of a fixed "thinking…", driven by the
SSE events the TUI already receives: `STEP_STARTED` → the step's own
skill/agent name; `TOOL_CALL_START` → the specific tool in flight.

**Deliberately a deterministic phrase lookup, not a further LLM call, and
here's the tradeoff, worth being explicit about rather than silently
picking one side**: a live ticker has to update the instant an event
arrives — adding a model call per step would make the status lag behind
the real work it's describing, cost money per step instead of once per
turn, and risks the narration finishing *after* the step it describes
already has. A small fixed table (`{"git-status": "checking git
status…", "dockerize": "writing a Dockerfile…", "analyze-project":
"analyzing your project…", ...}`, one entry per skill already in
`SKILL_TIER_REGISTRY`, falling back to `"running ${skill}…"` for
anything not in the table so a future skill is never silently blank) is
instant, free, and — because skill ids are already a small, closed,
human-legible set — loses very little compared to a paraphrase. The
**final** answer once the whole run completes still goes through
`synthesizeAnswer()` exactly as in §2/§3 — the one place an LLM
genuinely adds value here is composing the finished findings into
prose, not narrating an in-progress event whose entire content is
already "which skill, which agent."

If this tradeoff is wrong for what you want, say so before I implement
it — the alternative (a real per-step LLM paraphrase) is a small,
separable change to make later without touching anything else in this
spec.

## Scope

- `packages/shared/capability-router.ts`: the two new `kind` values, the
  extended system prompt, schema update.
- `apps/orchestrator/index.ts`: a shared classification helper used by
  both `detectSkill()` (maps the two new kinds to the existing
  `"plan-task"` fallback, unchanged observable behavior) and the `/ask`
  handler; `buildStateAnswer()`'s conversation-intent text;
  `runOrchestratorSupervisor()`'s result composition;
  `STEP_STARTED`/`TOOL_CALL_START` already emitted, unchanged.
- `apps/orchestrator/ask-classifier.ts`: delete `CAPABILITY_PATTERNS`/
  `RECENT_TASK_PATTERNS` and the string-matching Tier 0 branch; replace
  with reading the router's `kind`. `isFollowUpRequest()`'s own closed
  pattern set is **untouched** — reference resolution ("run it again")
  is a harder, separate problem this spec doesn't attempt (see Non-Goals,
  carried over unchanged from the original draft).
- `apps/tui/index.tsx`: `chatPending` driven by the SSE handler's
  already-parsed `STEP_STARTED`/`TOOL_CALL_START` events via the new
  phrase table, instead of one fixed string.
- Tests: `capability-router.test.ts` (both new `kind` values, schema
  validation), `ask-classifier.test.ts` (rewritten for router-driven
  classification, real-work-request regression), `detectSkill()`
  unaffected-behavior tests, the composed plan-task result, and the
  phrase-table lookup (including its fallback for an unlisted skill).
- **Out of scope / unchanged**: `POST /tasks`' own routing and its
  `plan-task` default; the approval gate and `SKILL_TIER_REGISTRY`;
  `synthesizeAnswer()` and its grounding check; `isFollowUpRequest()`'s
  closed pattern set; the adaptive supervisor's own decision loop,
  prompts, and bounds.

## Safety and Compatibility Constraints

- **The approval gate is untouched.** A conversational/state answer
  dispatches nothing, so it cannot reach the gate by construction. A
  real work request still goes through the exact same
  classify-validate-dispatch path as today.
- **The router's proposal is still validated against the live
  capability snapshot before being trusted** — a hallucinated `kind` or
  skill id is rejected exactly as `specs/054` already requires; failure
  falls back to `"plan-task"` for `detectSkill()`, or a deterministic
  "I couldn't tell what you meant" for `/ask`, never a guess.
- **Strictly fewer dispatches, never more.** Every change here either
  turns a would-be dispatch into an answer, or enriches an existing
  result. No new dispatch is ever added.
- **The live progress ticker never claims something completed that
  hasn't** — it only narrates `STEP_STARTED`/`TOOL_CALL_START` (in
  progress), never invents a result ahead of the real
  `STEP_FINISHED`/`TOOL_CALL_RESULT` event.
- **A real work request behaves identically** — the regression line
  every test here must pin: "dockerize this project" still routes,
  dispatches, and gates exactly as it does today.

## Out of Scope / Non-Goals

- Any change to `POST /tasks`' routing default.
- Streaming token-level chat output (AG-UI's `TEXT_MESSAGE_*` events
  already exist; no client renders live tokens — unchanged here).
- Multi-turn reference resolution ("run it again") beyond the existing
  closed-pattern `isFollowUpRequest()` — a genuinely harder problem,
  already named as future work before this spec existed.
- Per-step LLM paraphrasing of live progress (see §4's own tradeoff
  note) — a separable follow-up if the deterministic phrase table turns
  out to be the wrong call.
- The TUI's chat *layout* — `specs/069` Phase 2's job, complementary to
  this spec's *content* work.

## Acceptance Criteria

- [x] `hello` produces an immediate conversational reply, zero tasks
      created, zero dispatches. (Live-confirmed against a real Gemini
      deployment, 2026-09-15.)
- [x] *"so now are you working fine?"* is classified `state-question` or
      `conversation` by the router and answered directly, not dispatched.
      (Live-confirmed against a real Gemini deployment, 2026-09-15, using
      the exact original bug phrase.)
- [x] A genuine work request ("dockerize this project") still routes,
      dispatches, and reaches the identical approval gate. (Live-
      confirmed indirectly, 2026-09-15: real "build and deploy" requests
      this session repeatedly routed to `plan-task`, dispatched real
      child steps, and reached genuine `input-required` approval gates —
      see `specs/060`'s and `specs/087`'s own live evidence.)
- [ ] A completed `plan-task`'s result contains each dispatched step's
      skill, agent, status and real output.
- [ ] While a plan-task is running, chat shows the real current step
      (e.g. "checking git status…"), not a static "thinking…", updating
      as `STEP_STARTED`/`TOOL_CALL_START` events arrive.
- [ ] With a provider key configured, the final chat answer is a
      grounded natural-language summary of the real findings.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Unit: the router's two new `kind` values and schema validation; the
  shared classification helper's mapping for both `detectSkill()` and
  `/ask`; the composed plan-task result and its 64 KiB bound; the
  progress phrase table including its fallback for an unlisted skill.
- Live, with a real provider key and a real stack: `hello`, *"are you
  working fine?"*, *"that is what i say"* — each answered with zero
  dispatch; a real multi-step `plan-task` request whose chat view shows
  the step narration changing in real time and whose final answer names
  what the agents actually found.
- A live regression pass on a genuine work request, confirming routing,
  dispatch, and the approval gate are byte-identical to today.

## Approval Requested

Approve to proceed. Amends `specs/044` (the ask layer's tiering and
answer composition), `specs/054` (the capability router's own schema),
and `specs/065` (its `plan-task` fallback, now reached through one
shared, endpoint-aware classification instead of two independent
special cases). Nothing is implemented until then.
