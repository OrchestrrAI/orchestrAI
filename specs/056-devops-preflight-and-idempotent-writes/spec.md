---
id: 056-devops-preflight-and-idempotent-writes
title: DevOps Preflight and Idempotent Writes — Never a Silent Overwrite
area: agent-integration
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-05
updated: 2026-09-06
approved_by: Yusuf
approved_on: 2026-09-06
implemented_on: 2026-09-06
amends:
  - 040-approval-preview-content-diff
supersedes:
  - 053-production-readiness-foundation
superseded_by: []
related:
  - 042-llm-harness-devops
  - 057-project-snapshot-and-cross-request-reuse
---

# Spec: DevOps Preflight and Idempotent Writes — Never a Silent Overwrite

> Review gate: **APPROVED 2026-09-06 by Yusuf.** Split out of
> `specs/053-production-readiness-foundation/spec.md` §3 at Yusuf's
> request. Deliberately scoped without the cross-request caching layer
> (`specs/057`) — this spec's preflight re-inspects the real filesystem
> on every write request, fresh, which is simpler and safer than caching
> and does not depend on 057 being approved or implemented first.

## Purpose

`specs/040-approval-preview-content-diff/spec.md` already made every
write-capable preview show *what* will be written, with a genuine diff
on overwrite. It did not add an explicit **operation classification** —
today, DevOps's write skills always compute a create/overwrite preview
and let the human reviewing the diff notice "this file already exists
and is identical," rather than the system itself recognizing that and
never proposing a no-op write at all.

Read directly from `packages/agents/devops/index.ts` and
`packages/mcp/index.ts`, 2026-09-05: `prepareWriteAction()` computes the
target path and calls the MCP tool's own `dry_run:true` path
unconditionally to get preview content; the non-dry-run write path calls
`writeFile()` directly with no first-class "does this already match?"
check. An identical re-run of `dockerize` against an already-correct
Dockerfile still produces a full create/overwrite approval preview
rather than recognizing there is nothing to do.

## Verified Current State

- `packages/agents/devops/index.ts`'s `prepareWriteAction()`
  (deterministic path) and `prepareWriteActionOrHarness()` (LLM-harness
  overlay, `specs/042`) both compute target/output paths and preview
  content before any approval exists; neither classifies the *kind* of
  operation being proposed.
- `packages/mcp/index.ts`'s four write tools
  (`create_dockerfile`/`create_github_action`/`create_dockercompose`/
  `create_gitignore`) each accept `dry_run` (`specs/040`) and otherwise
  call `writeFile()` directly on approval — there is no existing-content
  comparison inside the tool itself.
- `ApprovalPreview` (`packages/shared/approval.ts`, extended by
  `specs/040`) already carries `content`/`previousContent` — the exact
  fields an operation classification would be computed from; no new
  field is required to detect "identical," only new logic that reads
  the two fields it already has.
- The approval binds `actionId` to immutable parameters, re-checked
  before write (`specs/040`'s own load-bearing guarantee) — the
  fingerprint-recheck this spec adds is an extension of that existing
  mechanism, not a new one.

## Proposed Behavior

Before an approval preview is built for any DevOps write skill, a
deterministic preflight classifies the operation as exactly one of:

- `create` — target is absent;
- `no-op` — target exists and its content already matches what would be
  written;
- `update` — target exists and differs; the existing `specs/040` diff
  covers this case already, unchanged;
- `blocked` — the target cannot be safely read (permission error,
  outside project bounds, or another existing safety check already
  rejects it).

An exact `no-op` **never reaches a write-capable MCP tool call** — the
task completes immediately with an explicit "already up to date" result,
the same shape a genuinely-nothing-to-do read-only task already
produces. `create` and `update` behave exactly as `specs/040` already
implemented, with one addition: the stored `ApprovalPreview` also binds
the **current** content's fingerprint, and immediately before the real
write call, the target is re-read and re-fingerprinted — a changed
fingerprint invalidates the approval and requires a fresh preflight
rather than writing over content the human never actually reviewed
(closing the exact drift window `specs/040`'s own Verification Results
already demonstrated for its own scope, extended here to cover a change
occurring *after* approval rather than only between preview-computation
and approval).

This preflight/fingerprint contract applies uniformly to all four
existing DevOps write tools — Dockerfiles, Compose files, CI workflows,
and `.gitignore` — not only the Dockerfile example above.

## Scope

- `packages/agents/devops/index.ts`: `prepareWriteAction()`/
  `prepareWriteActionOrHarness()` gain the create/no-op/update/blocked
  classification, computed from the same content-fetch path `specs/040`
  already uses.
- `packages/shared/approval.ts`: `ApprovalPreview` gains a content
  fingerprint field (a hash, not the full content again — `content`/
  `previousContent` already carry that).
- The four write-capable resume paths (wherever `POST /tasks/:id/approve`
  currently reaches DevOps's write execution): a fingerprint re-check
  immediately before the real MCP write call.
- No change to `packages/mcp/index.ts`'s four template functions
  themselves (their generated content is unchanged) — only to when and
  whether they are ever called at all.

## Safety and Compatibility Constraints

- **An existing artifact is never silently overwritten** — a `no-op`
  produces no write call; an `update` still requires the same human
  approval `specs/040` already requires, now bound to a fingerprint that
  is re-verified rather than trusted.
- **`blocked` fails closed with an actionable explanation**, never a
  guessed or partial write.
- **No change to the approval gate's own mechanics** — `actionId`
  generation, the `POST /tasks/:id/approve`/`reject` endpoints, and the
  409/400 error shapes for a stale/missing `actionId` are untouched;
  this spec adds a *new* reason an approval can be invalidated
  (fingerprint mismatch), using the existing invalidation shape.
- Byte-identical behavior for the `create` case (target genuinely
  absent) and the already-verified `update`-with-diff case from
  `specs/040` — this spec only changes behavior for the previously-
  unhandled `no-op` case and adds the post-approval fingerprint check.

## Out of Scope / Non-Goals

- Project snapshot caching across multiple requests — a target is always
  freshly read for this spec's own preflight; `specs/057` is the
  separate, optional layer that would let a *read-only* inspection be
  reused, and it does not change this spec's write-path guarantee that a
  write always re-checks fresh regardless of any cache.
- Documentation's or Security's own write/report paths — DevOps only in
  this spec; a documentation-agent equivalent (if wanted) would be its
  own checkpoint, following this one's own precedent.
- Any new write-capable skill or MCP tool.
- Changing what content the four templates generate.

## Acceptance Criteria

- [x] Re-running `dockerize` against an already-correct Dockerfile
      produces a `no-op` result with no MCP write call, proven by
      asserting the MCP tool mock/spy was never invoked, not just by
      checking the final file content.
- [x] A changed Dockerfile still produces the existing `specs/040` diff
      preview, unaffected by this spec's own classification step.
- [x] Approving a preview, then modifying the target file before the
      approval is acted on, causes the write to be rejected and requires
      a fresh preflight — the adversarial case this spec exists for.
- [x] All four write-capable DevOps skills (not only `dockerize`) are
      covered by the same classification and fingerprint-recheck logic.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Pure tests for the classification function against fixture pairs
  (absent/identical/different/unreadable target).
- A live scratch-project pass: an identical re-run confirmed as a
  genuine no-op (no file mtime/hash change, no MCP call in the audit
  log); a real content change confirmed to still produce the `specs/040`
  diff; the adversarial post-approval-mutation case confirmed to reject
  the write, mirroring `specs/040`'s own live-verified adversarial test
  exactly but for a mutation that happens *after* approval instead of
  before it.

## Approval Requested

Not yet requested. This spec needs Yusuf's review and explicit approval
before any implementation, per CLAUDE.md Working procedure step 8.
