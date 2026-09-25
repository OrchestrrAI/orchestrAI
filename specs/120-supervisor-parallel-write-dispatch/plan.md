# Plan: 120 — Parallel write dispatch, grouped approval, disjointness gate

> This plan cannot broaden `spec.md`. It sequences the approved scope only.

Four phases with very different risk. Phase 1 is a small deletion in an
already-live-proven mechanism. Phase 3 introduces a new trust boundary — an
endpoint that fans approvals out to write-capable agents — and is where the
adversarial work belongs. Phase 4 touches the file carrying 16+ rounds of
terminal-overflow history.

The phases are ordered so that **Phase 1+2 alone are shippable and already
deliver the demo-visible property** (three agents proposing at once). If the
demo date closes in, stop after Phase 2 and the checkpoint still has a result.

## Phase 0 — Establish that organic multi-write fan-out actually happens

The spec's named highest-uncertainty item, and it is not a code question.
`specs/060` shipped correct fan-out code that produced **no** organic fan-out
on its first live attempt; the model did not emit multiple `dispatch_skill`
calls until the prompt was tuned a day later.

1. With Phase 1's gate change only (no grouped approval, no UI), run real plans
   against a real provider and record whether the model emits multiple
   write-capable `dispatch_skill` calls in one turn, and how often.
2. Tune `buildSystemPrompt()` until it does, or record that it will not.

**Exit gate:** a written finding in `verification.md`. If the model will not
reliably fan out write steps, every later phase is building UI for something
that never fires — stop and report that, rather than continuing.

## Phase 1 — Widen the fan-out gate

1. Drop `allReadOnly` from `dispatchNode()`'s eligibility condition.
2. Rename `dispatchReadOnlyBatch()` → `dispatchBatch()`; classify each branch
   by its **own** tier instead of the hardcoded `"read-only"`.
3. Define the three newly-reachable outcomes: `rejected` and
   `failed-ambiguous` terminal, `skipped` non-terminal recording
   `skippedSkillIds`.
4. Per-branch reservation of `dispatchedWriteKeys` and `skippedSkillIds`
   alongside the two existing bound reservations.
5. Skip still-`input-required` siblings on any terminal outcome, reusing the
   existing `POST /tasks/:id/skip` path.

**Exit gate:** existing `supervisor-graph.test.ts` passes **unmodified**, and
several write children reach `input-required` simultaneously with distinct
`actionId`s. Individual approvals still work exactly as today.

## Phase 2 — The disjointness gate, decision only

Land the gate before anything consumes it, so its behavior is provable on its
own.

1. Read each write branch's stored `ApprovalPreview`; collect `preview.target`
   plus every `preview.files[].target`.
2. Compare as exact canonical paths — never prefix, fuzzy, or
   case-insensitive.
3. Emit the eligible/ineligible decision and audit it. **Nothing acts on it
   yet**; every branch still gets an individual approval either way.

**Exit gate:** eligibility computed correctly for distinct paths, identical
paths, and a `specs/114` multi-file preview overlapping another branch's single
target — with behavior still byte-identical to Phase 1 in every case.

## Phase 3 — The grouped approval endpoint

The new trust boundary. Adversarial tests land in the same commit as the
mechanism, not after.

1. `POST /tasks/:parentId/approve-batch` with its full validation: child
   membership, `input-required` status, `actionId` match, and a complete,
   non-duplicated decision list. Every failure mode fail-closed with the
   existing 400/409 shapes.
2. Fan out to each agent's **unmodified** `/approve` or `/reject` with that
   branch's own `actionId`, concurrently via `Promise.all`.
3. Assert structurally that no code path constructs a shared `actionId` or
   approves a branch not named in the decision list.
4. Adversarial coverage: another parent's child; a child listed twice; a valid
   `actionId` paired with the wrong `childTaskId`; the same list submitted
   twice.
5. Confirm each branch still reaches its own agent's fingerprint drift recheck,
   and that one branch failing it does not disturb its siblings.

**Exit gate:** a real grouped approval writing multiple files concurrently
through unmodified agents, plus every refusal case proven.

## Phase 4 — Clients

TUI first, because it is the riskier of the two and the project's primary
interface.

1. **TUI**: grouped review listing each branch's skill, agent, resolved target,
   and existing bounded per-file summary lines, with per-branch approve/reject
   and one confirm. Reuse `computeShellLayout()` and
   `computeShellChatScrollHeight()` — do not derive new height budgets. Verify
   in a real PTY at 80×24 using the established state-injection + PTY-capture
   technique.
2. **Dashboard**: grouped card with each branch's existing labeled diff block,
   per-branch controls, one submit; keyed by parent, branches keyed by child.
3. Both fall back to today's individual cards when ineligible or when a batch
   has a single write branch.

**Exit gate:** the live scenarios — one grouped review approved, one
overlapping batch degrading to individual approvals, one mixed approve/reject
group ending the run with an honest partial-effect report.

## Phase 5 — Docs and closure

`CLAUDE.md` gains present-tense sentences plus `See specs/120` (per
`specs/118`'s budget — narrative belongs in `verification.md`). Worklog entry.
Full gates: `bun test`, `bun run typecheck`, `bun run specs:catalog`, `bun run
specs:check`.

## Rollback

Phases are commit boundaries. Phase 1+2 deliver the demo-visible concurrency
with the approval gate completely untouched, and are independently useful if
Phases 3–4 are abandoned. Phase 3 is reversible by not routing any client to
the new endpoint — it is additive, and no existing approval path is modified by
it.
