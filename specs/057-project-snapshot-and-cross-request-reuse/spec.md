---
id: 057-project-snapshot-and-cross-request-reuse
title: Project Snapshot and Safe Cross-Request Read Reuse
area: orchestrator
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-05
updated: 2026-09-06
approved_by: Yusuf
approved_on: 2026-09-06
implemented_on: 2026-09-06
amends: []
supersedes:
  - 053-production-readiness-foundation
superseded_by: []
related:
  - 044-conversational-ask-layer
  - 056-devops-preflight-and-idempotent-writes
---

# Spec: Project Snapshot and Safe Cross-Request Read Reuse

> Review gate: **APPROVED 2026-09-06 by Yusuf**, including the concrete
> cache-invalidation design resolved during review (see Proposed
> Behavior below). Split out of
> `specs/053-production-readiness-foundation/spec.md` §2 at Yusuf's
> request. **Deliberately sequenced after `specs/056`**: this spec
> reuses the same fingerprint concept `056` introduces for write
> preflight; approving `056` first is not a hard technical dependency
> (the two modules can be built independently) but keeps one fingerprint
> definition authoritative instead of two independently-invented ones.

## Purpose

Every task the Orchestrator dispatches — including a `plan-task` run
through the adaptive supervisor — starts from zero project knowledge.
A conversation that asks "what's the project's status," then two turns
later "now dockerize it," re-runs `analyze-project`/`git-status` from
scratch rather than reusing what the first request already, genuinely,
just inspected. This is correct-but-wasteful for read-only inspection,
and it is the literal opposite of the guarantee a *write* action needs
(which must always re-check current state immediately before writing,
never trust a stale view — `specs/056`'s own concern).

This spec adds a bounded, fingerprinted cache for **read-only**
inspection results only, scoped to a conversation, so a follow-up
question in the same thread doesn't force the adaptive supervisor (or a
direct request) to redo an inspection nothing has invalidated.

## Verified Current State

- The adaptive supervisor (`apps/orchestrator/supervisor-graph.ts`)
  builds fresh graph state per `plan-task` run; nothing persists a prior
  run's own tool observations into a later, separate task.
- `specs/044-conversational-ask-layer/spec.md` already introduced
  bounded, per-conversation state (`chatConversations`, the thread the
  TUI/dashboard both read) — the closest existing precedent for "state
  scoped to a conversation, not a single request," though it holds
  message history, not inspection results.
- No module in this repository currently computes or stores a content
  fingerprint of a target project's own files for reuse across requests
  (distinct from `specs/040`'s per-*file* content fingerprint used at
  approval time, which this spec's fingerprint concept is modeled on but
  does not share code with, since that one is single-file and
  write-path-specific).

## Proposed Behavior

**Concrete design, resolved during review** (the original draft
deliberately left the exact mechanism open — this is the decision):
the Orchestrator has no direct filesystem access to a target project at
all (confirmed: `apps/orchestrator/index.ts` never imports `fs`/reads a
project path itself — every inspection is a real HTTP dispatch to an
agent). "Detected filesystem change" is therefore checked via the
**cheapest already-available real signal**, not a new filesystem probe:

- Cache entries are keyed by `(conversationId, skill, target)` and store
  the skill's own completed result text plus a `computedAt` timestamp.
- **`analyze-project`** (the expensive case — it also does a direct
  DevOps-to-Security A2A secrets pre-check): a cache hit is
  cross-checked with one extra, much cheaper `git-status` dispatch
  (`callAgent("devops", ..., {selectedSkill: "git-status"})`) before
  being served. The entry also stores the exact `git-status` output text
  captured at cache-population time; if the fresh cross-check text
  matches, the cache is served; if it differs (or the cross-check itself
  fails), the cache is discarded and a normal fresh dispatch happens,
  repopulating the cache afterward. An entry that never captured a
  fingerprint (the capture call itself failed) is never served as a hit.
- **`git-status`** (and any other read-only skill with no cheaper
  cross-check than itself): validity is TTL-only — there is no cheaper
  real signal than running `git-status` itself to check `git-status`'s
  own freshness, so the TTL is the *primary*, not merely secondary,
  gate for this one skill. This is a stated, deliberate carve-out, not
  an oversight.
- **Explicit refresh**: a request whose raw text matches
  `/\b(refresh|recheck|re-check|latest|again)\b/i` skips the cache
  check entirely, treated as a genuine miss.
- **Bounded**: a fixed TTL (5 minutes), a fixed max entries per
  conversation (20, oldest evicted first), and a fixed max number of
  conversations tracked at all (100, oldest evicted first) — no
  unbounded growth.

**A write action never trusts this cache, ever, regardless of its
age** — `specs/056`'s own preflight already always re-reads and
re-fingerprints its target immediately before a real write; this spec's
cache is a read-path optimization only and must not be consulted on the
write path in place of that fresh check.

## Scope

- `packages/shared/project-snapshot-cache.ts` (new): the pure
  cache/TTL/eviction data structure and its own key/entry types —
  no network calls, no agent knowledge, directly unit-testable.
- `apps/orchestrator/index.ts`'s `dispatchRootTask()` — shared by both
  `POST /tasks` and `/ask` (specs/044's own precedent: one dispatch
  path, not two independently-maintained copies). A read-only skill
  (`classifySkillTier()`, imported from `supervisor-graph.ts`, already
  the authoritative read-only/write-capable classification this
  codebase uses) dispatched **with a `conversationId`** consults the
  cache before a real agent dispatch; a request with no `conversationId`
  (a bare `POST /tasks` outside any conversation) is unaffected — this
  cache is conversation-scoped by design, matching `specs/044`'s own
  scoping precedent, and never applies without one.
- No change to any write-capable skill's own dispatch path — `specs/056`
  already governs write-path freshness and is unaffected by this spec's
  existence either way.

## Explicitly deferred from the original draft's Scope

The adaptive supervisor's own read-only dispatch step
(`apps/orchestrator/supervisor-graph.ts`'s `dispatchNode()`/
`dispatchReadOnlyBatch()`, specs/060) is **not** integrated with this
cache in this pass. That module is deliberately Orchestrator-agnostic —
its own `SupervisorDeps` interface has no concept of a conversation id
at all, and threading one through it would be a materially larger,
separate structural change than "consult a cache before a dispatch,"
better scoped as its own follow-up if the adaptive supervisor's own
read-only re-inspection cost is ever found to matter in practice. This
spec's integration point is `dispatchRootTask()` only.

## Safety and Compatibility Constraints

- **Read-only reuse only; never on a write path**, stated above and
  restated here because it is the one property this entire spec exists
  to get right — a stale write is a real, not hypothetical, risk this
  codebase has already designed around once (`specs/040`'s own drift-
  prevention finding).
- **Bounded TTL, bounded cache size per conversation** — no unbounded
  memory growth, matching this codebase's own existing bounds
  (`TASK_RESULT_MAX_BYTES`, the supervisor's dispatch/attempt limits).
- **Explicit invalidation beats implicit trust** — any detected
  filesystem change invalidates immediately; the TTL is a secondary,
  conservative backstop, not the primary correctness mechanism.
- No new persistence — this cache lives in the same in-memory scope
  every other piece of task state already does (CLAUDE.md's existing
  "No persistence; all task state is in memory" limitation is unchanged,
  not newly introduced by this spec).

## Out of Scope / Non-Goals

- Any change to write-path freshness guarantees — `specs/056` owns
  that property completely; this spec cannot weaken it.
- Cross-conversation or cross-user sharing of a snapshot — scoped
  strictly to one conversation, matching `specs/044`'s own existing
  conversation-scoping precedent.
- Testing Agent's own runner-detection reuse — `specs/058` decides
  independently whether and how its own results are cached; this spec
  only provides the general project-snapshot primitive, not a mandate
  that every agent must adopt it.
- Persisting a snapshot beyond process lifetime.

## Acceptance Criteria

- [x] A second `git-status` request in the same conversation, within
      TTL, reuses the cached result — proven by asserting the real
      `git-status` dispatch (`callAgent`/agent HTTP call) was not
      repeated, not merely that the response looked similar.
- [x] A second `analyze-project` request in the same conversation, with
      an unchanged `git-status` cross-check, reuses the cache without a
      full re-run — proven the same way; a *changed* `git-status`
      cross-check result forces a full fresh `analyze-project` dispatch.
- [x] A request with no `conversationId` never consults or populates the
      cache — `POST /tasks` behavior is provably unaffected by this
      spec's existence.
- [x] A write-capable skill's own dispatch is provably unaffected by
      this cache's presence or absence — the same before/after test
      `specs/056` already requires for its own fingerprint recheck, run
      once with this spec's cache populated and once without, identical
      result either way.
- [x] TTL expiry forces a fresh inspection even with no detected change.
- [x] Explicit-refresh wording in the request text bypasses the cache
      even when a valid entry exists.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Pure tests for the cache module itself: TTL expiry, bounded eviction
  (both per-conversation entry count and total conversation count),
  key isolation (different conversation/skill/target never collide).
- Integration tests against the real `dispatchRootTask()`/`/ask`
  surface with a mocked `callAgent`/`fetch`, no live agents: cache hit
  (no real call attempted), cache miss populates the cache, the
  `analyze-project` cross-check both matching (serves cache) and
  differing (forces a fresh dispatch), explicit-refresh text bypassing
  a valid entry, and the no-`conversationId` case never touching the
  cache at all.
- The write-path independence check named in Acceptance Criteria,
  against the real DevOps write dispatch path with the cache both
  populated and empty.

## Approval Requested

Not yet requested. This spec needs Yusuf's review and explicit approval
before any implementation, per CLAUDE.md Working procedure step 8.
