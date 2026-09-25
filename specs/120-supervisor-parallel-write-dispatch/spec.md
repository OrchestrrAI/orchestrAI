---
id: 120-supervisor-parallel-write-dispatch
title: "Parallel Write Dispatch with Grouped Approval Over Disjoint Targets"
area: llm-harness
change_type: feature
status: implemented
verification: verified
created: 2026-09-23
updated: 2026-09-25
approved_by: Yusuf
approved_on: 2026-09-24
implemented_on: 2026-09-24
amends:
  - 060-supervisor-parallel-read-only-dispatch
  - 028-orchestrator-langgraph-supervisor
  - 040-approval-preview-content-diff
supersedes: []
superseded_by: []
related:
  - 089-plan-step-skip-continue
  - 097-chat-answer-and-plan-description-honesty
  - 056-devops-preflight-and-idempotent-writes
  - 114-coder-multi-file-edit-and-create
  - 046-browser-conversation-operations-workspace
  - 069-tui-dashboard-parity-workspace
  - 119-coder-verify-loop-and-reviewer-depth
---

# Spec: Parallel Write Dispatch with Grouped Approval Over Disjoint Targets

> Review gate: **APPROVED 2026-09-24 by Yusuf.** Not yet implemented.

## Purpose

Raised by Yusuf, sourced from **judge feedback on the first demo**: the system
executes one step at a time, and it does not look like a multi-agent
orchestrator while doing it. A plan with three write steps runs `dockerize` to
completion — proposal, approval, write — before `create-ci` is even dispatched.
Three agents exist; one works at a time; the other two idle.

`specs/060` fixed exactly this for read-only steps and deliberately stopped
there, because `specs/028`'s own deferred question — *"concurrent execution
against a shared approval gate needs its own analysis"* — was the hard half.
This checkpoint is that analysis, and unlike `060` it does not sidestep the
approval gate: it addresses it directly.

Three things become concurrent, in this order:

```text
  dockerize        [propose] ──┐  → Dockerfile
  create-ci        [propose] ──┼─ all three WORKING at once
  generate-readme  [propose] ──┘  → README.md
                               └─ output paths all differ → eligible
                               └─ ONE grouped review showing all three diffs
                                  approve once
                                        └─ [write] ──┐
                                           [write] ──┼─ writes land together
                                           [write] ──┘
```

And when they are not eligible, the batch degrades to the safe shape rather
than failing:

```text
  create-gitignore [propose] ──┐  → .gitignore
  edit-files       [propose] ──┘  → .gitignore
                               └─ SAME FILE → no grouped review;
                                  every branch falls back to its own
                                  individual approval, one at a time
```

**The load-bearing design decision, stated up front: the grouped approval is an
Orchestrator-side fan-out of N individually-bound approvals, never one approval
covering N actions.** Each write still executes only from its owning agent's
own `resumeTask()`, with its own `actionId` validated by that agent exactly as
today. The group is a review and dispatch convenience in the Orchestrator and
the two clients. **No agent is modified by this spec at all.**

## Verified Current State

Read directly from the code on 2026-09-23.

**The fan-out machinery already exists and is live-proven.**

- `dispatchReadOnlyBatch()` (`apps/orchestrator/supervisor-graph.ts:587` —
  line numbers current as of `specs/119`'s 2026-09-24 landing, which added
  an 8-line `SKILL_TIER_REGISTRY` entry ahead of this code; re-check before
  implementing)
  dispatches via `Promise.all(toDispatch.map(deps.dispatch))` and awaits via
  `Promise.all(dispatched.map(deps.wait))` (lines 631–632).
- `dispatchNode()`'s gate (lines ~425–427) admits a batch only when
  `allToolCalls.length > 1 && allDispatchSkillCalls && allReadOnly`. A single
  write-capable entry anywhere disqualifies the whole turn back to the
  single-call path acting on `allToolCalls[0]`.
- `specs/060`'s `verification.md` records a **real live three-step fan-out on
  2026-09-15**, with overlapping timestamps that "could not be produced by
  anything except genuine `Promise.all()` fan-out." It also records that the
  **first** live attempt (2026-09-14) observed *no* organic fan-out at all —
  the model did not emit multiple `dispatch_skill` calls until the prompt
  invited it. Fan-out is proven but **model-dependent**.

**Nothing serializes a write-capable task today except the plan loop itself.**

- Every agent stores `pendingActions` as `Map<taskId, PendingAction>`
  (`packages/agents/devops/index.ts:145`, `packages/agents/coder/index.ts:205`,
  same shape in Documentation and Testing) — keyed by task, so two different
  tasks on the **same** agent can both hold a pending action simultaneously.
- A `grep` for `mutex`/`queue`/`inFlight`/`isBusy`/`semaphore` across every
  agent's `index.ts` returns nothing. No agent serializes task handling.
- Concurrent write-capable children are therefore **structurally possible
  today and simply never driven**.

**The outcome classifier already distinguishes every case this needs.**
`classifyDispatchOutcome()` (line 174) returns `timeout`, `completed`,
`skipped`, `rejected`, `failed-safe` (read-only tier only), and
`failed-ambiguous` (fail-closed default for write-capable). The single-dispatch
path (lines 501–556) treats `rejected`, `timeout`, `failed-ambiguous` as
terminal; `skipped` loops back recording `skippedSkillIds`;
`completed`/`failed-safe` loop back.

`dispatchReadOnlyBatch()` documents that `rejected`/`skipped`/
`failed-ambiguous` are **structurally unreachable** for its branches, because a
read-only skill has no approval gate. Widening to write-capable skills makes
all three reachable for the first time.

**The approval preview already carries the resolved target path.**
`ApprovalPreview` (`packages/shared/approval.ts`, `specs/040`) carries the
target plus the exact `content` that will be written, computed once at preview
time and reused verbatim at write time. `specs/114` added `files[]` — one
`{target, action, content?, previousContent?, fingerprint}` per file — for
Coder's multi-file edits. **The disjointness check in this spec reads exactly
these fields and needs no new data.**

**Duplicate-write prevention is not batch-aware.** `dispatchedWriteKeys`
(`${skill}::${target}`) is checked only in the single-dispatch path;
`dispatchReadOnlyBatch()` never consults or reserves it, correctly — read-only
skills never populate it.

**A `dispatch_skill` call's `target` is not an output path.** It is typically a
project root: `dockerize` and `create-ci` carry the same `target` string and
differ only in the output path their previews resolve later. Disjointness is
therefore **not** computable at dispatch time — only after previews exist.
This is why the check sits where it does in §3.

**Both clients render approvals per task, not as a singleton.** The TUI
computes `approvalCount` across visible tasks (`apps/tui/index.tsx:537`) and
drives approval from the selected task; the dashboard keys approval cards to
the waiting **child's** id, never the parent's. Neither has been exercised with
more than one pending approval at once, and neither has any concept of a group.

## Proposed Behavior

### 1. The fan-out gate admits write-capable skills

`dispatchNode()`'s eligibility condition drops the `allReadOnly` requirement. A
turn fans out when **every** entry is a `dispatch_skill` call and there is more
than one. A `finish` call or any unrecognized tool name anywhere still
disqualifies the whole turn back to the single-call path — never a partial
fan-out. Mixed read-only and write-capable entries are eligible; read-only
branches simply never reach `input-required` and are not part of any group.

### 2. The batch reserves write keys and skips per branch, before any dispatch

`dispatchReadOnlyBatch()` (renamed `dispatchBatch()`) gains further per-branch
reservations alongside the two it already performs. Before any network call, in
the model's own listed order, each branch is checked against:

- the remaining dispatch budget (unchanged);
- the skill's remaining per-skill attempts (unchanged);
- `skippedSkillIds` — refused exactly as the single-dispatch path already
  refuses it (`specs/089`);
- **`dispatchedWriteKeys`, plus keys reserved by earlier branches in this same
  batch** — a turn naming `(dockerize, /proj)` twice dispatches it once and
  records `duplicate-write-refused` for the second.

Each refusal emits its own `decision` audit entry with its existing reason
string and the turn's `toolCallCount`, matching `060`'s per-branch audit shape.

### 3. The disjointness gate decides grouped versus individual approval

Once every write-capable branch in the batch has reached `input-required`, each
one's stored `ApprovalPreview` is read and its **resolved output paths**
collected — `preview.target`, plus every `preview.files[].target` for a
multi-file preview (`specs/114`). Paths are compared after the same
canonicalization the write path already applies, as exact path equality — never
prefix, fuzzy, or case-insensitive matching.

- **All paths across all branches distinct** → the batch is **eligible**, and
  proceeds to the grouped approval in §4.
- **Any two branches share any path** → the batch is **ineligible**. Every
  branch falls back to its own individual approval, presented one at a time,
  exactly as approvals work today. **Nothing is discarded, nothing fails, no
  branch is skipped** — the concurrency of §1 is already banked, and only the
  grouped review is withheld.

The ineligible path is the important one: it is the safe existing behavior, not
an error. A batch that cannot be grouped still ran its proposals concurrently,
which is most of the wall-clock win and all of the visible one.

This gate is what makes the grouped preview honest. Two branches writing the
same file would otherwise be reviewed against previews computed before either
write landed, and the second would be refused after approval by the fingerprint
recheck — a confusing outcome this gate converts into a clean upfront decision.

### 4. Grouped approval: one review, N individually-bound approvals

A new Orchestrator endpoint, `POST /tasks/:parentId/approve-batch`, accepts a
body listing an explicit decision per branch:

```text
{ decisions: [ { childTaskId, actionId, decision: "approve" | "reject" }, ... ] }
```

Validation, all fail-closed:

- every listed `childTaskId` must be a child of `:parentId` that is currently
  `input-required` — otherwise HTTP 409;
- every `actionId` must match that child's currently stored pending action —
  a missing one is HTTP 400, a stale or mismatched one HTTP 409, mirroring the
  existing per-task approve/reject contract exactly;
- **every eligible branch must appear exactly once** — a partial or duplicated
  decision list is HTTP 400. There is no implicit default for an unlisted
  branch.

The endpoint then forwards each decision to the owning **agent's existing,
unmodified** `POST /tasks/:id/approve` or `/reject`, with that branch's own
`actionId`. Approvals are forwarded concurrently via `Promise.all`, which is
what makes the writes land together.

**What this does not do, deliberately: it does not create a shared or
collapsed `actionId`.** N approvals are still N `actionId`-bound approvals
against N agents; the endpoint is an Orchestrator-side fan-out of them. Every
agent-side guarantee — `actionId` validation, the `specs/056`/`114`
content-fingerprint drift recheck immediately before the real write,
`specs/110`'s `claimPendingAction()` single-consumption boundary — is reached
unchanged, on every branch, on every write.

A branch whose fingerprint recheck fails still fails closed individually. A
grouped approval is not a promise that every write succeeds; it is one review
interaction over N independently-verified writes.

### 5. Rejecting inside a group

A grouped decision list may mix approvals and rejections. Approved branches
execute; rejected branches are discarded via the agent's own `/reject`.

**`specs/028`'s guarantee is preserved: if any branch is rejected, the run ends
once the approved branches reach a terminal state.** The supervisor is never
re-consulted after a rejection, so a rejected `dockerize` can never be followed
by `create-compose` attempting the same effect.

**A plan can therefore now end with a partial effect** — some writes landed,
one was rejected, the run stopped. Today's strictly sequential path cannot
produce that. It is accepted deliberately and reported explicitly (§7), never
hidden.

**Confirmed by Yusuf, 2026-09-23**, against the stated alternative: discard the
rejected branch, execute the approved ones, and let the supervisor continue —
`specs/089`'s skip semantics applied to rejection. That alternative is better
demo behavior, since one veto would not kill the plan, but it reopens exactly
the effect-collision hole `028` closed. Run-ends-on-rejection is the decision;
`skip` remains the mechanism for "not this step, but keep going," unchanged.

### 6. Write-specific outcomes, previously unreachable, get defined handling

Per branch, after `classifyDispatchOutcome(waited[i], tier)` using the branch's
**own** tier rather than a hardcoded `"read-only"`:

| Outcome | Batch behavior |
|---|---|
| `completed` | Observation fed back. Unchanged. |
| `failed-safe` | Observation fed back. Read-only branches only, unchanged. |
| `timeout` | **Ends the run** — already `060`'s policy (`anyTimeout`), unchanged. |
| `rejected` | **Ends the run**, per §5. |
| `failed-ambiguous` | **Ends the run** — a write-capable skill's unexplained failure is terminal, exactly as in the single-dispatch path. |
| `skipped` | **Does not end the run.** The skill id joins `skippedSkillIds`; other branches proceed. Matches `specs/089` exactly. |

Every branch's own outcome — successes included — is recorded in `auditLog`
before a terminal outcome ends the run, matching `060`'s `anyTimeout` handling.

On any terminal outcome, any sibling still sitting at `input-required` is
skipped via the existing `POST /tasks/:id/skip` path (`specs/089`), which
reuses the agent's own `/reject` to discard the pending action
non-destructively. No orphaned approval prompt survives a dead run.

### 7. Clients render the group; composed results report it honestly

- **TUI** (`apps/tui/index.tsx`): a grouped approval presents one review
  listing every branch with its skill, agent, resolved target, and the existing
  bounded per-file summary lines (`specs/114`), with a per-branch
  approve/reject toggle and one confirm. Existing single approvals are
  untouched. Per this file's standing 16-rounds-of-overflow-bugs rule, the
  group view must reuse `computeShellLayout()`/`computeShellChatScrollHeight()`
  rather than deriving new height budgets, and must be verified in a real PTY.
- **Dashboard** (`apps/orchestrator/`): one grouped approval card containing
  each branch's existing labeled diff block, per-branch approve/reject
  controls, and one submit, keyed by parent id with each branch keyed by its
  own child id.
- **Both** fall back to today's individual approval cards whenever the batch is
  ineligible (§3) or contains a single write branch.
- `composeSupervisorResult()` (`specs/075`) reports a batch's steps as having
  run concurrently, and a run ended by a rejection states plainly which sibling
  writes had already landed and which were skipped.

### 8. The system prompt may name several independent steps

`buildSystemPrompt()` is widened again — `specs/060` widened it for read-only
steps only. The model may call `dispatch_skill` more than once in a turn when
the steps are **independent**: neither depends on what the other returns, and
neither writes a file the other writes. It is still told it will see every real
outcome before deciding again, and that each write reaches a human approval.

Per `060`'s live record this wording is what actually determines whether
fan-out fires, and it is the highest-uncertainty part of this change.

## Scope

- `apps/orchestrator/supervisor-graph.ts` — fan-out gate; `dispatchBatch()`
  (renamed); per-branch write-key/skipped-skill reservation; per-branch tier
  classification; terminal-outcome handling; `buildSystemPrompt()`.
- `apps/orchestrator/index.ts` — the disjointness gate; `POST
  /tasks/:parentId/approve-batch` and its validation; concurrent approval
  forwarding; sibling-skip on terminal outcome; `composeSupervisorResult()`.
- `apps/tui/index.tsx` — grouped approval view.
- Orchestrator dashboard — grouped approval card.
- Tests across the above; `CLAUDE.md`; `context/worklog.md`.

**No agent is modified.** No agent-side approval endpoint is added or changed.
`ApprovalPreview` gains no field — the gate reads what `specs/040`/`114`
already store.

## Safety and Compatibility Constraints

- **No shared or collapsed `actionId`, ever.** N writes are N
  `actionId`-bound approvals against N agents. The grouped endpoint fans them
  out; it does not replace them.
- **Every agent-side guarantee is reached unchanged on every branch**:
  `actionId` validation, the `specs/056`/`114` content-fingerprint drift
  recheck immediately before the real write, and `specs/110`'s
  `claimPendingAction()` single-consumption boundary. A branch whose recheck
  fails fails closed individually.
- **The grouped endpoint is fail-closed on every input**: unknown or
  non-`input-required` child, mismatched or stale `actionId`, and partial or
  duplicated decision lists are all refused. No branch has an implicit default.
- **The disjointness gate compares exact canonical paths** — never prefix,
  fuzzy, or case-insensitive. Any overlap withholds only the grouped review;
  every branch still gets its own individual approval.
- **Rejection stays terminal for the run** (`specs/028`), and siblings still
  pending are skipped rather than left prompting.
- **`failed-ambiguous` stays terminal** for a write-capable branch;
  `classifySkillTier()`'s fail-closed default for an unregistered skill is
  untouched.
- **Bounds are reserved per branch before any network call** (`060`,
  unchanged); the duplicate-write refusal now also applies within one batch.
- A single `dispatch_skill` call, and a turn containing `finish` or an
  unrecognized tool name, behave byte-identically to today.
- `ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES` (`specs/097`) keeps its meaning and
  default of 30.
- **A known, accepted limit, stated rather than papered over:** the
  disjointness gate covers branches writing the same *output* path. It does not
  detect a branch whose *content* was derived from a file another branch
  rewrites — the fingerprint recheck protects the target, not the inputs. The
  system prompt asks for independent steps; that is guidance, not a structural
  guarantee.

## Out of Scope / Non-Goals

- **Any collapsed, shared, or implicit approval.** No "approve all" that is not
  an explicit per-branch decision list; no batch approval spanning more than
  one parent task; no persisted approval memory of any kind.
- Concurrent writes to the **same** file — structurally excluded by §3.
- Any agent-side change, including any change to an agent's own approval or
  rejection endpoints.
- Widening any agent's multi-file write bound (`MAX_FILES_PER_EDIT = 6`).
- Any change to `SKILL_TIER_REGISTRY`'s classifications or its fail-closed
  default.
- Orchestrator-side restart recovery for a mid-batch run, including a group
  half-approved when the Orchestrator restarts — the open gap `CLAUDE.md`
  already records, not narrowed here.
- Any dependency on `specs/119`. If both land, a verify loop inside a grouped
  batch multiplies both the approval surface and the concurrency surface; that
  interaction deserves its own checkpoint.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] A turn naming several independent write-capable skills dispatches them
      concurrently — proven by overlapping timestamps, not by inspection.
- [x] Several write-capable children sit at `input-required` simultaneously,
      each with its own distinct `actionId`.
- [x] Disjoint output paths produce **one** grouped review listing every
      branch; approving it writes every approved branch, concurrently.
- [x] **No write executes without its own `actionId`-bound approval reaching
      its own agent's `resumeTask()`** — asserted directly, since the grouped
      endpoint is the one place this could regress.
- [x] Overlapping output paths withhold the grouped review and fall back to
      individual approvals, with **no branch discarded or failed**.
- [x] The grouped endpoint refuses: an unknown child, a child not
      `input-required`, a missing `actionId` (400), a stale/mismatched
      `actionId` (409), and a partial or duplicated decision list (400).
- [x] A mixed group — some approve, some reject — executes exactly the approved
      branches, discards the rejected ones, and ends the run.
- [x] A partial effect is reported honestly: which writes landed, which were
      rejected, which were skipped.
- [ ] A branch whose fingerprint drifted after the grouped approval fails
      closed individually, without affecting its siblings.
- [x] A `skipped` branch does not end the run; the skipped skill id cannot be
      re-proposed (`specs/089` preserved).
- [x] A `failed-ambiguous` write branch ends the run; still-pending siblings
      are skipped, leaving no orphaned prompt.
- [x] A batch naming the same `(skill, target)` twice dispatches it once and
      records `duplicate-write-refused`.
- [x] A single `dispatch_skill` call, and a turn containing `finish`, behave
      exactly as today — existing tests pass unmodified.
- [ ] TUI and dashboard both render the grouped review correctly and fall back
      cleanly when ineligible; the TUI is verified in a real PTY at 80×24.
- [x] `bun test`, `bun run typecheck`, and `bun run specs:check` pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

**Hermetic** (scripted fake model, injected `deps`, no network): concurrent
dispatch proven by overlapping timestamps in the existing concurrency-probe
style; the disjointness gate on distinct paths, on identical paths, and on a
multi-file preview whose `files[]` overlaps another branch's single target;
every grouped-endpoint refusal case; a mixed approve/reject group; a branch
failing its fingerprint recheck without disturbing siblings; each terminal
outcome ending the run with siblings skipped; `skipped` not ending it; in-batch
duplicate-write refusal; per-branch bound reservation; and the disqualification
cases falling back byte-identically.

**Adversarial, specifically on the grouped endpoint** — it is the new trust
boundary: a decision list naming another parent's child; a child listed twice;
a valid `actionId` paired with the wrong `childTaskId`; a decision list
submitted twice (the second must find no pending action and refuse).

**Live**, against a real provider and a real scratch project:

1. A real plan producing a **genuine organic multi-write fan-out**, three
   agents visibly `working` at once, one grouped review, and concurrent writes.
   `060`'s first live attempt saw no organic fan-out until the prompt was
   tuned; budget for the same iteration. **If the model will not reliably emit
   multiple write `dispatch_skill` calls, this checkpoint delivers nothing
   regardless of how correct the code is** — establish that first.
2. A real overlapping-target batch degrading to individual approvals, with
   every branch still completing.
3. A real mixed group (approve two, reject one): the two writes land, the run
   ends, and the partial effect is reported accurately.
4. Real observation in both clients, the TUI in a real PTY at 80×24 per its
   standing overflow-risk rule.

## Approval Requested

Approval authorizes: widening the supervisor's fan-out gate so a turn naming
several independent `dispatch_skill` calls dispatches them concurrently
regardless of tier; per-branch reservation of write keys and skipped-skill
refusals within a batch; per-branch tier-correct outcome classification with
`rejected`/`failed-ambiguous` terminal and `skipped` non-terminal; a
disjointness gate over resolved preview output paths that decides between a
grouped review and today's individual approvals; a new Orchestrator endpoint
`POST /tasks/:parentId/approve-batch` that validates and fans out N
individually-`actionId`-bound approvals to unmodified agents; grouped approval
rendering in the TUI and dashboard; and a system-prompt change inviting
multiple independent steps per turn.

Approval does **not** authorize: any shared, collapsed, or implicit
`actionId`; any approval spanning more than one parent task; any persisted
approval memory; concurrent writes to the same file; any agent-side change; any
change to `SKILL_TIER_REGISTRY` or the fingerprint drift recheck; or relaxing
the rule that a human rejection ends the run.
