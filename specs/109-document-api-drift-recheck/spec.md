---
id: 109-document-api-drift-recheck
title: "Documentation's Write Path Gains the Post-Approval Drift Recheck"
area: documentation-agent
change_type: fix
status: implemented
verification: verified
created: 2026-09-22
updated: 2026-09-22
approved_by: Yusuf
approved_on: 2026-09-22
implemented_on: 2026-09-22
amends:
  - 040-approval-preview-content-diff
  - 041-llm-harness-documentation
  - 056-devops-preflight-and-idempotent-writes
  - 104-deferred-work-register
related:
  - 081-testing-write-tests-skill
  - 083-coder-agent
  - 110-approval-state-survives-a-restart
supersedes: []
superseded_by: []
---

# Spec: Documentation's Write Path Gains the Post-Approval Drift Recheck

> Status: **IMPLEMENTED, VERIFIED, 2026-09-22.** Closes `specs/104`'s
> own item A8 ("Documentation's write path never adopted the post-
> approval drift recheck", risk: medium). Drafted as a direct
> prerequisite for `specs/110` (approval state survives a restart): a
> persisted-and-restored approval is only as safe as the recheck that
> runs before it executes, and Documentation is the one write-capable
> agent with no recheck at all today — found during that spec's own
> grounding investigation, not assumed.
>
> **A real, previously-untracked gap was found and fixed while
> implementing this spec, not by inspection.** The `document-api`
> branch of `processTask()` never fetched the target's own existing
> content at preview time at all — `overwrite` stayed permanently
> `false` and `previousContent` permanently `undefined` even when
> genuinely overwriting a real file, so every `document-api` preview
> looked like a fresh create regardless of the truth. This would have
> made the new fingerprint meaningless (fingerprinting an always-
> `undefined` value, then failing the very first real overwrite as
> "drift"), so fixing it was a necessary, in-scope consequence of this
> spec's own stated behavior, not scope creep — the existence check
> now mirrors `generate-readme`'s own, split via
> `path.dirname()`/`path.basename()`. Live-verified against a real
> running Documentation agent, no mocks: a real `generate-readme`
> create, a real overwrite scenario with a genuine manual mutation
> between preview and approval correctly refused (the file left holding
> the mutation, not corrupted), and the identical two scenarios for
> `document-api`'s own save-to path — all four confirmed against real
> HTTP requests and real files on disk. See `verification.md`.

## Purpose

`generate-readme` and `document-api` (when writing) gain the identical
approval-to-write drift guarantee DevOps (`specs/056`), Testing
(`specs/081`), and Coder (`specs/083`) already have: the target's
content is re-fingerprinted immediately before the real write, and a
mismatch refuses the write and requires a fresh preflight.

## Current behavior

`packages/agents/documentation/index.ts`'s `PendingAction`
(lines 480–493) has no `fingerprint` field. `resumeTask()`
(605–634) writes `action.content` unconditionally once `action` is
found — no re-read of the target, no comparison against anything. This
is the narrower `specs/040` guarantee only (a source file can't drift
between preview and *approval*, because `content` is computed once and
reused verbatim) without the stronger `specs/056` one (the target file
itself can drift between approval and the *actual write*, and nothing
here notices).

Every other write-capable agent already has this: `packages/agents/
devops/index.ts:872` (`fingerprint = computeContentFingerprint(preflight.previousContent)`)
and its recheck at 945–973; `packages/agents/testing/index.ts:491` and
611–629; `packages/agents/coder/index.ts:270` and 320–348. All three
share the same shape: fingerprint the target's content (not the content
being written) at preview time, re-read and re-fingerprint immediately
before the write, refuse on mismatch with an explicit "resubmit for a
fresh preflight" error. `PATH_NOT_FOUND_PREFIX`-shaped errors
(`packages/shared/write-preflight.ts:25`) are treated as benign
(absent → absent is a legitimate create), matching DevOps's and
Testing's own handling — never Coder's stricter variant, since
Documentation's own preview already treats "the target doesn't exist
yet" as a normal, expected create case (`generate-readme`'s own
`overwrite`/`note` logic at lines 545–556), the same as DevOps.

## Proposed behavior

1. `PendingAction` gains `fingerprint?: string`, computed at preview
   time via the same `computeContentFingerprint()`
   (`packages/shared/approval.ts`) every other agent already imports,
   over `previousContent` — the target's state at preview time, not the
   content about to be written. `previousContent` is `undefined` for a
   fresh create (no README/doc exists yet); `computeContentFingerprint(undefined)`
   already returns the `"absent"` sentinel, so a create is fingerprinted
   too, consistent with every other agent's own handling.
2. `resumeTask()` re-derives the target's real root/relative-path
   split — `generate-readme`: root = `action.target`, relative path =
   `"README.md"` (matching `writeReadmeFile()`'s own shape at line
   220–227); `document-api`: root = `path.dirname(action.target)`,
   relative path = `path.basename(action.target)` (matching
   `writeApiDoc()`'s own shape at line 373–382) — re-reads it via the
   existing `readProjectPath()` helper, and compares
   `computeContentFingerprint(currentContent)` against
   `action.fingerprint`. A `PATH_NOT_FOUND_PREFIX`-shaped read failure
   is treated as benign only when `action.fingerprint === "absent"`
   (mirroring DevOps's own benign-only-when-expected handling); any
   other read failure, or any fingerprint mismatch, fails the task
   closed with an explicit message naming the drift and asking for a
   fresh preflight — the identical wording pattern DevOps/Testing/Coder
   already use, ported verbatim in shape, not reworded ad hoc.
3. No change to `buildApprovalPreview()`'s own shape, the preview UI, or
   any dashboard/TUI rendering — `fingerprint` is never surfaced on the
   wire (`ApprovalPreview.fingerprint` already exists as an optional
   field per `specs/056`; Documentation simply starts populating the
   agent-local `PendingAction`'s own copy, the same internal-only field
   every other agent already carries).

## Scope

- `packages/agents/documentation/index.ts`: `PendingAction`, the two
  preview-construction sites (`generate-readme` at ~532–563,
  `document-api` at ~564–578), `resumeTask()` (605–634).
- Tests: `packages/agents/documentation/*.test.ts` gains the same shape
  of coverage `specs/056`'s own DevOps tests established — a stale
  approval (target mutated between preview and approval) refused with
  the drift error; an unchanged target proceeds normally; a genuine
  create (no prior file) still fingerprints and rechecks correctly.

Out of scope: any change to `generate-readme`/`document-api`'s own
content-computation logic, the LLM harness (`specs/041`), or
`document-api`'s own read-only (non-approval) path. No new MCP tool —
`read_project_file` is already bound and already used for this exact
purpose elsewhere in this file.

## Safety constraints

- Fail-closed on any ambiguity, matching every sibling agent: a read
  failure that isn't the specific benign "doesn't exist and wasn't
  expected to" case refuses the write.
- No behavior change for the approve-happy-path when nothing drifted —
  byte-identical output to today, confirmed by a direct before/after
  comparison, not just "no test broke."

## Acceptance criteria

- [x] A `generate-readme` approval whose target README is mutated
      between preview and approval is refused with a drift error; the
      file on disk still holds the manual mutation, not corrupted.
- [x] The identical scenario for `document-api`'s own save-to path.
- [x] An unmutated target still writes normally, byte-identical to
      today's behavior.
- [x] A genuine create (no prior file) still previews and writes
      correctly, with `fingerprint: "absent"` never spuriously
      triggering a refusal.
- [x] Every pre-existing Documentation test passes unmodified.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.

## Verification plan

- Unit: the four scenarios above, mirroring `specs/056`'s own DevOps
  test shapes directly.
- Live, if a target project is available: a real `generate-readme`
  preview, a real manual mutation of the target file before approving,
  a real refusal confirmed, and a real successful write on a clean
  retry.

## Non-goals

- `specs/104`'s other open items (A9 and beyond) — this closes only A8.
- Any change to how `specs/110` will persist approval state — this spec
  exists purely so that a *future* persisted-and-restored Documentation
  approval has a real fingerprint to recheck against, the same
  prerequisite every other agent already satisfies.
