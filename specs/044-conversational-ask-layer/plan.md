# Implementation Plan: Conversational Ask Layer

This plan implements `044-conversational-ask-layer/spec.md`. It cannot
broaden that spec. **Not authorized until the spec is approved.**

## Preconditions

- Explicit approval of `spec.md`'s Phases 1–4 scope — **pending** (hard
  stop; no implementation before it).
- `specs/038` Phase 1 at `verification: verified` — **met** (commit
  `56f022b`); the supervisor being default is what makes `specs/027`'s
  "no LLM token stream" premise false, which Phase 2 depends on.
- Clean working tree at start; each phase is its own commit.

## Phases

### Phase 1 — Conversation model, `POST /ask`, deterministic tiers

Server-side only, fully exercisable with `curl`. No client work, no LLM.

- `apps/orchestrator/ask-classifier.ts` (new, pure): resolve a question to
  `{ tier: 0 | 1 | 2, skill?, reason }` by reusing the existing
  `detectSkill()` and `SKILL_TIER_REGISTRY`. Tier 0 is a small, explicit
  set of state-answerable intents (agents/skills/capabilities, prior task
  lookup) — deliberately narrow, everything else falls to 1/2 via the
  registry. Unregistered skill ⇒ write-capable, unchanged.
- `apps/orchestrator/index.ts`: `Conversation`/`Turn` types; a bounded
  `conversations` Map; `POST /ask`; `GET /conversations/:id`; Tier 0
  answered inline from `registry`/`tasks`; Tiers 1/2 dispatched through
  the **existing** `sendTaskToAgent()` path with the answer turn appended
  on terminal state. Follow-up turns pass prior turns as context.
- Tests: classifier over all 13 registry skills + unknown; conversation
  store bounds; `/ask` for each tier against a mocked agent; a regression
  test asserting `POST /tasks` is unchanged.
- Gate: `bun test`, `bun run typecheck` green. Commit.

### Phase 2 — Grounded answer synthesis + AG-UI `TEXT_MESSAGE_*`

- `apps/orchestrator/answer-harness.ts` (new): synthesis from real
  material only, Zod-validated shape, bounded numeric grounding check,
  retry-with-feedback, **fail open** to the raw result. Mirrors
  `packages/agents/security/llm-harness.ts` (no graph — single
  structured completion, same reasoning as `043`).
- `packages/shared/ag-ui-events.ts`: add `TEXT_MESSAGE_START` /
  `_CONTENT` / `_END` from `@ag-ui/core`, wired into `validateAgUiEvent()`.
  Update the file-header comment that currently states these are omitted,
  citing this spec and the changed premise.
- `apps/orchestrator/index.ts`: emit them for assistant turns; `threadId`
  = conversation id.
- `packages/shared/test-runner.ts` + `packages/agents/testing/index.ts`:
  coverage-percentage extraction and surfacing (deterministic, no LLM).
- Tests: grounding rejection/retry/fail-open with a scripted fake model;
  schema validation of the three new events; coverage extraction against
  real captured runner output.
- Gate: `bun test`, `bun run typecheck` green. Commit.

### Phase 3 — Dashboard chat panel

- `apps/orchestrator/index.ts`'s inline dashboard HTML: a chat panel
  (thread, input → `/ask`, inline approval → the **existing**
  `POST /tasks/:id/approve` with the real `actionId`), consuming
  `TEXT_MESSAGE_*` over the existing `EventSource('/events')`. The
  existing task table/modal untouched.
- Verified in-process via `app.fetch()` (the technique `specs/035`/`040`
  already use) plus a real browser pass.
- Gate: `bun test`, `bun run typecheck` green. Commit.

### Phase 4 — TUI chat view

- `apps/tui/index.tsx`: a **full-screen** chat view behind a key, in the
  same shape as the existing `?` help view. Explicitly **not** a third
  stacked box — `specs/012`'s thirteenth round and the comment at
  `apps/tui/index.tsx:915` are the reasons, and this constraint is
  load-bearing, not stylistic.
- Live: exercised in a real terminal, including the two tests that caught
  the original overflow bug (a full task list; a zoomed-out terminal).
- Gate: `bun test`, `bun run typecheck`, `bun run build` green. Commit.

### Phase 5 — Live verification + documentation

- Run `spec.md`'s Verification Plan live list end to end (both with and
  without a provider key), record results in `verification.md`, tick the
  acceptance criteria, set `verification` honestly.
- `CLAUDE.md` (new "Conversational ask layer" section; correct the
  `specs/027` "no TEXT_MESSAGE_*" statement; note `threadId` now differs
  from `runId`), `README.md`, `context/worklog.md`.
- `bun run specs:catalog` + `bun run specs:check`. Commit.

## Affected Paths

- `apps/orchestrator/index.ts`, `ask-classifier.ts` (new),
  `answer-harness.ts` (new), and their tests
- `packages/shared/ag-ui-events.ts`, `packages/shared/test-runner.ts`
- `packages/agents/testing/index.ts`
- `apps/tui/index.tsx`
- `CLAUDE.md`, `README.md`, `context/worklog.md`
- `specs/044-.../spec.md`, `plan.md`, `verification.md`

## Rollback / Recovery

Every phase is additive and independently revertable. Phases 1–2 add new
endpoints and event types without altering any existing one; Phases 3–4
add UI surfaces beside the existing ones. `POST /tasks` and the approval
gate are untouched throughout, so a revert at any phase leaves the
pre-044 runtime fully intact. There is no migration and no persisted
state to unwind.

## Completion Checklist

- [ ] Every approved acceptance criterion maps to a phase and its evidence.
- [ ] No out-of-scope behavior introduced (approval gate, `detectSkill()`
      outcomes, `POST /tasks`, supervisor internals all untouched).
- [ ] `bun test` / `typecheck` / `specs:check` / `build` green after each phase.
- [ ] Live results recorded; `verification` set honestly.
- [ ] Worklog entry written; handoff complete.
