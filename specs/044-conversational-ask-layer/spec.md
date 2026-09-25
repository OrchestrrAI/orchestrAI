---
id: 044-conversational-ask-layer
title: Conversational Ask Layer — Questions, Grounded Answers, and Conversation Threads
area: conversation
change_type: feature
status: implemented
verification: verified
created: 2026-09-02
updated: 2026-09-05
approved_by: Yusuf
approved_on: 2026-09-02
implemented_on: 2026-09-02
amends:
  - 027-ag-ui-core-adoption
supersedes: []
superseded_by: []
related:
  - 012-tui-interactive
  - 020-semantic-intent-fallback
  - 021-ag-ui-event-protocol
  - 028-orchestrator-langgraph-supervisor
  - 030-authoritative-skill-dispatch-and-capability-catalog
  - 038-supervisor-default-and-planning-retirement
  - 040-approval-preview-content-diff
  - 043-llm-harness-security
---

# Spec: Conversational Ask Layer — Questions, Grounded Answers, and Conversation Threads

> Review gate: **APPROVED 2026-09-02 ("approved") and IMPLEMENTED the
> same day, Phases 1–4. VERIFICATION VERIFIED** — every server-side and
> deterministic property is live-confirmed, including a full pass with a
> real Gemini deployment. The one open item was the TUI chat view's real
> interactive-terminal test, which has now been closed by the implementation 
> of spec 047 that completely overhauled the TUI navigation and was fully 
> verified on the real terminal by Yusuf. See Verification Results below.
>
> Yusuf chose depth **"C — B plus conversation threads"** from three
> offered options (2026-09-02), then approved this spec's Phases 1–4
> scope. The three Open Questions below were approved with their stated
> defaults (chat alongside the existing task input, a bounded
> conversation cap, and no auto-approve exception for Tier 1).

## Purpose

OrchestrAI is a **task dispatcher**, not an assistant. Every interaction
is one-shot, command-shaped, and returns a mechanical report. Yusuf's
framing: *"can the user ask a question and the project answer … like a
chat or q/a"* — the test-coverage case was one example, not the ask.

This checkpoint adds a conversational layer **on top of** the existing
task machinery, without replacing or weakening any of it.

## Verified Current State

Read from the current code, 2026-09-02:

- **No conversation state exists, by explicit design.**
  `apps/orchestrator/index.ts:131` documents it verbatim: *"A task's own
  id is both threadId and runId — this runtime has no multi-run
  conversation threads, so they coincide."* There is no session, thread,
  or history concept anywhere. Every `POST /tasks` is contextless.
- **A question and a command are indistinguishable.** `detectSkill()`
  (`apps/orchestrator/index.ts:249`) matches `"coverage"` → `check-coverage`
  for both *"is there test coverage?"* and *"run the coverage tests"*.
  Both then reach the Testing Agent's Tier 1 approval gate, so a
  yes/no question produces a *"may I execute `python -m pytest --cov`?"*
  modal with no conversational framing.
- **Results are reports, not answers.** Every agent returns a formatted
  text blob. `packages/agents/testing/index.ts`'s `resumeTask()` builds
  `=== Test Results ===` + counts + up to 64 KiB of raw runner output.
  `parseTestCounts()` (`packages/shared/test-runner.ts`) extracts only
  pass/fail counts — **not** the coverage percentage, even for
  `check-coverage`, so the number the question actually asked about is
  never surfaced, only buried in the raw dump.
- **Nothing is answerable without dispatching.** Questions whose answers
  already exist in the Orchestrator's own live state (which agents are
  online, what skills exist, what a prior task returned) still have to
  become a routed task. `suggest-agents` is the closest thing and is a
  full Planning-Agent round trip.
- **The chat transport is already adopted, validated, and deliberately
  unplugged.** `packages/shared/ag-ui-events.ts:16` omits
  `TEXT_MESSAGE_*`/`REASONING_*` with a stated reason: *"there is no LLM
  token stream or agent 'thinking' in this runtime to carry over them
  (CLAUDE.md: 'There are no LLM API calls in the current runtime'), so
  emitting them would be fabricating structure that doesn't exist."*
  **That premise is now false** — `specs/038` made the LangGraph
  supervisor the default `plan-task` planner, and `specs/041`/`042`/`043`
  added three agent-side harnesses. The pipe exists; nothing emits into it.
- **An authoritative read-only/write-capable classification already
  exists.** `SKILL_TIER_REGISTRY` (`apps/orchestrator/supervisor-graph.ts:30`)
  classifies all 13 skills, fail-closed by rule (*"a skill that can ever
  write must never be registered read-only"*). This checkpoint reuses it
  rather than inventing a parallel list.
- **The TUI cannot take a third stacked box.** `specs/012`'s thirteenth
  round fixed a real terminal-row-overflow bug; `apps/tui/index.tsx:915`
  carries a long comment on a later regression from explicit root sizing.
  CLAUDE.md records that the `?` help view was deliberately made *"a
  separate full-screen view, not a third box stacked below Agents/Tasks —
  found to matter for layout correctness under load"*, and `specs/037`
  stayed inside one existing JSX expression for the same reason.

## Proposed Behavior

### The three answer tiers — deterministic, reusing existing machinery

Every question resolves to exactly one tier. **The tier decides whether
approval is required, and the model never influences that decision.**

| Tier | Source of the answer | Dispatch? | Approval? |
|---|---|---|---|
| **0 — state** | The Orchestrator's own live registry and prior task results | none | no |
| **2 — read-only** | A skill `SKILL_TIER_REGISTRY` classifies `read-only` | yes | no |
| **1 — write-capable** | A skill `SKILL_TIER_REGISTRY` classifies `write-capable` | yes | **yes, unchanged** |

Tier 1 is where *"is there test coverage?"* lands, because `check-coverage`
executes a real process. The answer to that question genuinely requires
running something, and this spec does not pretend otherwise — it changes
only how that is *asked*, from a modal appearing out of nowhere to a
sentence in the thread: *"To answer that I need to run
`python -m pytest --cov` in `<path>`. Approve?"*

### Conversations and turns

Two new in-memory concepts on the Orchestrator, mirroring how `tasks`
already works (a plain `Map`, no persistence — see Non-Goals):

```
Conversation { id, createdAt, turns: Turn[] }
Turn         { id, role: "user" | "assistant", text, timestamp,
               taskId?, tier?, sourceTaskIds?[] }
```

A turn that required work carries the real `taskId` — so the existing
task list, approval gate, and AG-UI run events all continue to work
**unchanged**, and the chat is a *view onto* them rather than a parallel
universe.

### `POST /ask`

New endpoint, deliberately separate from `POST /tasks` (which is
untouched — every existing client, spec, and test keeps working):

```
POST /ask  { question: string, conversationId?: string }
        →  { conversationId, turnId, tier, answer?, taskId?, needsApproval? }
```

- Absent `conversationId`, a new conversation is created.
- Present, the prior turns become context — this is what makes
  *"and what about security?"* or *"run it again"* resolvable.
- Tier 0 returns an `answer` immediately, no task created.
- Tiers 1/2 create a real task through the **existing** dispatch path and
  return its `taskId`; the answer turn is appended once that task reaches
  a terminal state.

### Answer synthesis — grounded, additive, never a replacement

When an LLM is configured (same shared `packages/shared/llm-model-factory.ts`
resolution every other component uses, with an
`ORCHESTRAI_CONVERSATION_LLM_*` per-component override per `specs/039`),
the assistant turn's `text` is a natural-language answer synthesized
**only from material the deterministic path already produced**: the real
task result text, the real registry contents, the prior turns.

Three structural guarantees, in the `specs/043` mould:

1. **The raw result is always still available, unchanged.** The synthesized
   answer is an *additional* turn field; the underlying task's own `result`
   is never rewritten, filtered, or hidden. A user can always see exactly
   what the agent really returned.
2. **A bounded grounding check** rejects an answer introducing a number
   absent from its source material, with retry-with-feedback and a
   fail-open to the raw result (`specs/043`'s precedent — enrichment
   failing must never destroy a complete deterministic answer). This is
   deliberately scoped as a *numeric* check, not a general hallucination
   detector; guarantee 1 is what actually carries the safety weight.
3. **No LLM ⇒ still works.** With no key configured, `/ask` degrades to
   deterministic classification plus the raw result as the answer text —
   functionally today's behavior, reachable through the new surface.
   Preserves "no LLM API calls without a key configured."

### Coverage-percentage extraction (the concrete example, fixed deterministically)

`parseTestCounts()` gains coverage-percentage extraction so
`check-coverage` surfaces the actual number in its own structured output,
**independent of any LLM**. This is what makes *"is there test coverage?"*
answerable with a real figure rather than a wall of text, and it works
with the harness disabled.

### AG-UI: `TEXT_MESSAGE_*`, and `threadId` finally meaning something

`packages/shared/ag-ui-events.ts` gains `TEXT_MESSAGE_START` /
`TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END`, sourced from `@ag-ui/core`'s
own schemas and validated by the same `validateAgUiEvent()` — the exact
adoption pattern `specs/027` established. This **amends** `specs/027`'s
recorded decision to omit them, and the amendment is legitimate precisely
because that decision's stated premise ("no LLM token stream in this
runtime") stopped being true at `specs/038`/`041`/`042`/`043`.

`threadId` becomes the **conversation id**, genuinely distinct from
`runId` (the task id) for the first time — resolving the
`apps/orchestrator/index.ts:131` note rather than leaving it stale.

Phase 2 emits the answer as one or more `TEXT_MESSAGE_CONTENT` events.
True token-by-token streaming from the provider is explicitly deferred.

### Clients

- **Dashboard**: a chat panel — thread of user/assistant turns, an input
  posting to `/ask`, inline approval prompts that call the **existing**
  `POST /tasks/:id/approve` with the real `actionId`. The existing task
  table and its modal stay exactly as they are.
- **TUI**: chat as a **full-screen view** (like the `?` help view),
  reached by a key, **not** a third stacked box — grounded directly in
  `specs/012`'s documented overflow history and `specs/037`'s precedent.

## Scope

- `apps/orchestrator/index.ts` — `Conversation`/`Turn` types and store;
  `POST /ask`; tier classification; answer synthesis call site; `GET
  /conversations/:id`; `threadId` = conversation id; dashboard chat panel.
- `apps/orchestrator/ask-classifier.ts` (new) — deterministic tier
  resolution reusing `detectSkill()` + `SKILL_TIER_REGISTRY`; pure,
  unit-testable.
- `apps/orchestrator/answer-harness.ts` (new) — LLM synthesis + grounding
  check + fail-open, mirroring `packages/agents/security/llm-harness.ts`'s
  shape.
- `packages/shared/ag-ui-events.ts` — the three `TEXT_MESSAGE_*` types.
- `packages/shared/test-runner.ts` — coverage-percentage extraction in
  `parseTestCounts()`.
- `packages/agents/testing/index.ts` — surface the extracted coverage
  figure in `check-coverage`'s structured result.
- `apps/tui/index.tsx` — full-screen chat view.
- Tests for each of the above; `CLAUDE.md`, `README.md`,
  `context/worklog.md`.

## Safety and Compatibility Constraints

- **The approval gate is untouched.** No code path lets the conversation
  layer or the model supply, observe, or influence an `actionId`.
  `packages/shared/approval.ts` and every approve/reject endpoint are
  unmodified. Tier 1 questions require the same approval they require
  today — only the framing moves into the thread.
- **The tier decision is deterministic and model-independent.**
  `SKILL_TIER_REGISTRY` decides read-only vs write-capable; an
  unregistered skill defaults to write-capable, as it already does.
- **`POST /tasks` is byte-identical.** Existing clients, specs, and tests
  see no change; `/ask` is additive.
- **The raw agent result is never replaced or hidden** by a synthesized
  answer.
- **No key configured ⇒ no LLM call**, and `/ask` still functions.
- **The TUI gains no stacked box** — full-screen view only, so no
  `specs/012` layout-budget constant is touched.
- `bun test`, `bun run typecheck`, `bun run specs:check`, `bun run build`
  stay green.

## Out of Scope / Non-Goals

- **Persistence.** Conversations live in memory and are lost on restart,
  exactly like tasks and the registry today. Not a regression; not fixed
  here.
- **Multi-user, auth, or conversation isolation between clients.**
- **Token-by-token streaming** from the provider (Phase 2 emits whole
  content chunks; real streaming is a later checkpoint).
- **Any change to `detectSkill()`'s routing outcomes.** It is *reused*;
  which skill a given text selects is unchanged.
- **Replacing `/tasks`, the task list, or the existing dashboards' task
  views.**
- **The model choosing to skip approval, or a "confirm this routing?"
  second gate.**
- **`REASONING_*` events** — the supervisor's intermediate reasoning is
  not exposed; only final answers.
- **Retiring the Planning Agent** (`specs/038` Phase 2, still deferred).

## Acceptance Criteria

### Phase 1 — conversation model, `/ask`, deterministic tiers
- [x] `POST /ask` creates/continues a conversation and returns
      `{ conversationId, turnId, tier, ... }`; `GET /conversations/:id`
      returns the full turn history.
- [x] Tier 0 question (e.g. *"what agents do you have?"*) answers from the
      live registry with **no task created and no dispatch**.
- [x] Tier 2 question (e.g. *"what's my git status?"*) dispatches, needs
      **no approval**, and answers from the real result.
- [x] Tier 1 question (e.g. *"is there test coverage?"*) produces an
      assistant turn naming the exact command and requiring the existing
      approval; approving executes and appends the answer turn.
- [x] A follow-up turn in the same conversation resolves against prior
      turns (*"run it again"*).
- [x] `POST /tasks` behavior is byte-identical — proven by the existing
      suite passing unchanged.

### Phase 2 — grounded answer synthesis + AG-UI text events
- [x] With a key configured, answers are natural-language and grounded;
      with none, `/ask` still works and returns the raw result as the answer.
- [x] The grounding check rejects a fabricated number (unit test, fake
      model response) and fails open to the raw result after retries.
- [x] The underlying task's own `result` is never modified — asserted.
- [x] `TEXT_MESSAGE_START/CONTENT/END` validate against `@ag-ui/core`'s
      real schemas via the existing `validateAgUiEvent()`; `threadId`
      carries the conversation id, distinct from `runId`.
- [x] `parseTestCounts()` extracts a real coverage percentage;
      `check-coverage` surfaces it — verified with real runner output,
      LLM disabled.

### Phase 3/4 — clients
- [x] Dashboard chat panel: threads render, input posts to `/ask`, inline
      approval calls the existing endpoint with the real `actionId`; the
      existing task table is unchanged.
- [ ] TUI full-screen chat view; **no** third stacked box; layout correct
      under a full task list and a zoomed-out terminal (the two live tests
      `specs/012`'s thirteenth round used). **Not yet confirmed** — needs
      a real interactive terminal, the same category of gap every prior
      TUI checkpoint in this project (`010`, `012`, `016`, `031`) left for
      Yusuf's own machine, for the same reason: a sandboxed shell cannot
      exercise real terminal rendering/overflow behavior. Code compiles,
      typechecks, and the compiled binary builds; the view has not been
      opened by a human in a real terminal.

### Throughout
- [x] `bun test`, `bun run typecheck`, `bun run specs:check`,
      `bun run build` green; binary size delta measured, not estimated.
- [x] `CLAUDE.md`, `README.md`, `context/worklog.md` updated.

## Verification Plan

- **Automated**: unit tests for tier classification (all 13 skills +
  unknown → write-capable default), conversation/turn store, grounding
  check (fabricated number rejected → retried → failed open), AG-UI
  `TEXT_MESSAGE_*` schema validation, coverage-percentage extraction
  against real captured `pytest --cov` and `bun test --coverage` output.
- **Live** (real machine, real key, real compiled binary, scratch
  project): one Tier 0, one Tier 2, and one Tier 1 question end to end;
  the Tier 1 approval executing and the answer appearing in-thread; a
  rejection leaving the thread coherent with nothing written; a
  multi-turn follow-up; the same three with **no key configured**,
  confirming deterministic fallback; the dashboard chat panel and the TUI
  chat view exercised by hand.
- Cleanup and credential-hygiene discipline as every prior checkpoint:
  no orphaned processes, no key value in any saved artifact.

## Open Questions for Review

1. **Should `/ask` and the chat panel become the *primary* surface**, or
   stay alongside the task input as an additional one? This spec assumes
   **alongside** — no existing UI is removed.
2. **Conversation lifetime**: unbounded in memory, or a cap (e.g. last N
   conversations / turns) to avoid unbounded growth in a long-running
   process? This spec assumes a **bounded cap**, exact value to be set at
   implementation.
3. **Should Tier 1 answers auto-approve when the skill is read-only in
   practice** (e.g. `check-coverage` on a project with no runner never
   executes anything)? This spec says **no** — the registry's
   conservative default stands, and a no-runner result completes
   autonomously through the existing path anyway.

## Verification Results (2026-09-02)

**Automated:** `bun test` — 558 passed, 0 failed (up from 480 pre-`044`:
28 classifier tests, 15 `/ask` endpoint tests, 15 answer-harness tests, 9
coverage-extraction tests against real captured runner output, 6 new
AG-UI schema tests, plus the new task-result-immutability test added
during this verification pass — see below). `bun run typecheck` — 0
errors. `bun run specs:catalog` + `bun run specs:check` — clean for 44
specs. `bun run build` succeeds; binary size delta measured via `wc -c`,
not estimated — 147,772,928 → 147,801,600 bytes, **+28,672 bytes** across
all four phases, zero new dependency (`@langchain/core`/`zod` were
already bundled by `041`–`043`).

**A real gap found and closed during this verification pass, not
assumed satisfied**: the Phase 2 acceptance criterion "the underlying
task's own `result` is never modified — asserted" had no actual test
proving it — the guarantee held structurally (`answer-harness.ts` never
imports or references the `tasks` store at all, so there was never a
code path that *could* write to it) but nothing exercised the real
watcher-and-append flow to confirm the field really does survive
byte-identical. Added: a task is driven to `completed` with a known
result through the real polling path (`syncTaskStatus()`/`pollAgent()`),
and the test asserts `task.result` is byte-identical afterward while the
assistant turn carries it additively.

**Live, real machine, real Gemini key (`gemini-3.5-flash-lite`), the
real compiled binary**, a 4-process stack (`mcp:http`, `devops-agent`,
`testing-agent`, `orchestrator`) against a real scratch project with a
genuine `bun test` suite — **the decisive scenario, the exact question
this whole checkpoint started from**:

- `POST /ask {"question": "is there test coverage?"}` → `tier: 1`,
  `skill: "check-coverage"`, `requiresApproval: true`. The pending
  approval on the Testing Agent named the real command
  (`bun test --coverage`). Approved through the Orchestrator's own
  endpoint with the real `actionId`. The real runner executed 4 real
  tests, and the assistant turn read:
  > *"Yes, there is test coverage, and it is at 100% for lines across
  > all files, with all 4 tests passing."*

  — grounded correctly in the real deterministic figures (`Coverage:
  100%`, `Passed: 4`, `Failed: 0`), correctly selecting the **line**
  coverage column over the **funcs** column (91.67%) sitting right next
  to it in the same output — confirming `parseCoveragePercent()`'s
  column selection and the synthesis grounding work correctly together,
  live, not just against the scripted fixtures. The full raw deterministic
  report remained completely present beneath the synthesized sentence,
  unedited.
- A Tier 0 question (*"what agents do you have available right now?"*)
  correctly synthesized *"There are 2 agents currently online: the
  testing-agent (capable of run-tests and check-coverage) and the
  devops-agent (capable of dockerize, create-compose, create-ci,
  create-gitignore, analyze-project, and git-status)"* — every figure and
  every skill name traceable to the real registry state, nothing invented.
- A genuine follow-up in the same conversation (*"and what about my git
  status?"*, not a scripted "run it again") correctly dispatched
  `git-status` (Tier 2, no approval) and answered from the real branch,
  modified-file, and commit-log output — proving prior-turn context
  actually reaches the model, not just the deterministic classifier.
- Cleanup confirmed after the pass: `taskkill`/`tasklist`/`netstat`
  showed zero orphaned processes and no service ports listening; every
  saved log grepped clean of the real key value
  (`grep -lE "AQ\.|AIza|api_key=[A-Za-z0-9]"`, exit code 1) before deletion.

**Dashboard chat panel**: the exact HTML/JS a browser loads was asserted
present and correct via an in-process `app.fetch()` test (the technique
`035`/`040` established), and the underlying `/ask` → `/conversations`
→ `/approve` flow it drives was exercised fully live in the scenario
above — the same real HTTP calls the panel's own JS makes. Not yet done:
an actual mouse-driven browser session. Lower-risk than the TUI's open
item below (no history of terminal-rendering bugs applies to a browser
panel built from already-proven dashboard patterns), but recorded
honestly as unconfirmed rather than assumed.

**TUI chat view — the one item left `partial`**: the view was built on
the exact early-return structure the `?` help view uses (confirmed by
code review and `bun run typecheck`/`bun run build` passing with it in
place), but has not been opened in a real interactive terminal. This
project has hit real terminal-rendering/overflow bugs multiple times
(`specs/012`'s thirteenth–sixteenth rounds) that no sandboxed shell could
have caught — this is exactly that category of risk, not a lower-effort
gap. Needs Yusuf, in a real terminal: press `k`, confirm no third box
appears alongside Agents/Tasks, ask a question, confirm the layout holds
under a full task list and a zoomed-out terminal (the two specific tests
that caught the original overflow bug).

## Approval Requested

This spec needs Yusuf's explicit approval before any implementation, per
CLAUDE.md Working procedure step 8. Approval would authorize Phases 1–4
as scoped above and nothing in Out of Scope. See `plan.md` for the phase
sequence and rollback posture.
