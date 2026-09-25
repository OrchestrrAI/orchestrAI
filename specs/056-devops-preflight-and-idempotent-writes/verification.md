# Verification: DevOps Preflight and Idempotent Writes

Date: 2026-09-06

Result: **verified**.

## What changed

- `packages/shared/write-preflight.ts` (new) — pure `classifyWritePreflight(newContent, readOutcome)`, returning
  `{kind:"create"|"no-op"|"update"|"blocked", previousContent?, reason?}`.
  A deterministic adapter separated from the MCP-calling wrapper, the same
  "pure classification, unit-tested separately from the live call" shape
  `apps/orchestrator/supervisor-graph.ts`'s `classifyDispatchOutcome()`
  already established in this codebase.
- `packages/shared/approval.ts` — `ApprovalPreview` gains `fingerprint?:
  string`; new `computeContentFingerprint(content: string | undefined):
  string` (SHA-256 hex, or the sentinel `"absent"` for a genuinely-absent
  target so a `create` is fingerprinted too, not skipped).
- `packages/agents/devops/index.ts`:
  - `preflightWrite()` fetches the target's real current content via the
    existing `read_project_file` MCP tool (already required for this
    agent since specs/042) and delegates classification to
    `classifyWritePreflight()`.
  - `processTask()`'s write branch now: computes the would-be content via
    the existing `dry_run:true` path, preflights it, and branches —
    `blocked` fails the task closed with the real reason; `no-op`
    completes immediately with an explicit "already up to date" message
    and **never builds a `PendingAction` or calls a write-capable MCP
    tool at all**; `create`/`update` proceed to a normal approval
    preview, now also carrying the previously-**never-populated**
    `previousContent`/`fingerprint` fields (a real, pre-existing gap
    found while implementing: `buildApprovalPreview()` never set
    `previousContent` for DevOps before this spec, so specs/040's diff
    rendering — already wired up in the dashboard — was silently dead
    code for every DevOps write; it works for Documentation, which does
    set it. This spec incidentally fixes that too, since preflighting a
    write requires reading the existing content anyway.)
  - `resumeTask()` re-reads the target and recomputes its fingerprint
    immediately before the real MCP write call; a mismatch (or the
    target's existence flipping to unreadable/disappeared) fails the
    resume closed with an explicit "resubmit for a fresh preflight"
    error, never proceeding to write over content the human never
    reviewed.
  - Both new degrade paths (an "unknown"/unimplemented skill with no
    `toolName`/`args`; a dry-run failure) skip preflighting entirely and
    fall back to the exact pre-056 approval shape — `fingerprint`/
    `projectRoot` stay unset on the action, and `resumeTask()`'s guard
    (`action?.fingerprint !== undefined`) means the fingerprint recheck
    is itself skipped for these, matching pre-056 behavior byte for
    byte.

## Verified

- `bun run typecheck` — 0 errors.
- `bun test` — 736 pass, 0 fail, 1441 expectations across 49 files (up
  from 727/1427 pre-change: 6 new `write-preflight.test.ts` cases for
  all four classification kinds plus an exact-match-only edge case, 3
  new `computeContentFingerprint` cases in `approval.test.ts`).
- **Live pass against real `mcp:http` + the real exported DevOps Hono
  app** (`app.request()`, no port bind for DevOps itself; a temporary
  `mcp:http` instance started on the otherwise-free `:3006` for this
  pass only, confirmed stopped and the port free again afterward — this
  did not touch or restart Yusuf's own already-running session), a real
  scratch project, all four acceptance-criteria scenarios in one
  sequence:
  1. **Create** — target absent: `approval.overwrite=false`,
     `approval.fingerprint="absent"`. Approved; file genuinely appears on
     disk.
  2. **No-op — the exact defect this spec exists to fix**: an identical
     `dockerize` re-run against the now-correct Dockerfile completed
     immediately (`status=completed`, `result="Already up to date — ...
     No write performed."`) with **no `approval` object at all** — proven
     directly from the real audit log, not inferred: the only
     `create_dockerfile` MCP calls for that task's id are the
     `dry_run:true` preview call and nothing else; no non-dry-run
     `create_dockerfile` call ever fired.
  3. **Update** — a real content difference (a different port number):
     `approval.overwrite=true`, `approval.previousContent` genuinely
     present — the specs/040 diff rendering now has real data to render
     for DevOps for the first time (see the dead-code finding above).
  4. **The adversarial drift case, live-reproduced**: a preview built,
     the target file then manually mutated on disk (simulating a change
     between preview and execution), then approved. The real write was
     **refused**: `status=failed`, `error='Target "..." changed after
     approval but before this write — refusing to overwrite unreviewed
     content. Resubmit for a fresh preflight.'`, and the file's content
     on disk was confirmed to **still be the manual mutation**, not the
     approved Dockerfile content and not further corrupted — the write
     genuinely never executed.
- **All four write-capable DevOps skills covered by the same
  classification/fingerprint logic**: confirmed by code inspection — the
  preflight/fingerprint wiring lives in `processTask()`'s single shared
  `NEEDS_APPROVAL` branch and `resumeTask()`'s single shared execution
  path, not duplicated per skill; `dockerize` was the one live-exercised
  above (matching specs/040's own precedent of live-verifying one
  representative skill end to end while relying on shared-code-path
  reasoning for the other three, since all four share `prepareWriteAction()`/
  `processTask()`/`resumeTask()` already).

## Out of scope, confirmed untouched

`git diff --stat` confirms the changed files are
`packages/shared/write-preflight.ts` (new),
`packages/shared/write-preflight.test.ts` (new),
`packages/shared/approval.ts`, `packages/shared/approval.test.ts`, and
`packages/agents/devops/index.ts` — no change to `packages/mcp/index.ts`'s
four template functions, the approval gate's own `actionId`
generation/validation, the 409/400 error shapes, or `specs/057`'s deferred
caching layer (every read in this spec is fresh, no cache introduced).

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/056-devops-preflight-and-idempotent-writes/spec.md` (implemented,
**verified**) closed a real gap `specs/040`'s diff preview left open: a
write skill always computed a full create/overwrite preview and let the
human notice "this already matches," rather than the system itself
recognizing that and never proposing a no-op write at all. Before any
approval preview is built, a deterministic preflight
(`packages/shared/write-preflight.ts`'s pure `classifyWritePreflight()`,
fed the real target content via the existing `read_project_file` MCP
tool) classifies the operation as `create`/`no-op`/`update`/`blocked`. An
exact `no-op` never reaches a write-capable MCP tool call — the task
completes immediately with an explicit "already up to date" result;
`blocked` (an unreadable target — permission, containment, or sensitive-
filename denial) fails closed with the real reason. `create`/`update`
proceed exactly as `specs/040` already implemented, now additionally
binding the approval to a content fingerprint
(`packages/shared/approval.ts`'s `computeContentFingerprint()`, SHA-256,
with a distinct `"absent"` sentinel so a `create` is fingerprinted too)
that is re-verified immediately before the real write in `resumeTask()`
— a target that changed after approval but before execution fails the
write closed and requires a fresh preflight, extending specs/040's own
preview-to-approval drift guarantee to cover drift occurring *after*
approval as well. Applies uniformly to all four DevOps write skills.
**One incidental, pre-existing gap found and fixed along the way**:
`buildApprovalPreview()` never actually set `previousContent` for DevOps
before this spec — specs/040's diff rendering (already wired up in both
dashboards) was silently dead code for every DevOps write; preflighting
a write requires reading the existing content anyway, so this spec fixes
that gap as a side effect, not a separate change. Live-verified against
a real `mcp:http` instance and the real exported DevOps app: an identical
`dockerize` re-run completed as a genuine no-op with the real audit log
confirming no non-dry-run `create_dockerfile` call ever fired; a real
port-number change produced a genuine `previousContent` diff; and the
adversarial case — approve a preview, then mutate the target file on
disk before the write executes — was refused with the file confirmed to
still hold the manual mutation, not further corrupted. `specs/057`'s
cross-request caching layer remains deliberately unaddressed here — every
read in this spec is fresh on every request.

See specs/109-document-api-drift-recheck/verification.md for the relocated narrative covering this checkpoint.

See specs/079-phase-a-connect-orphaned-tools/verification.md for the relocated narrative covering this checkpoint.

See specs/081-testing-write-tests-skill/verification.md for the relocated narrative covering this checkpoint.

See specs/057-project-snapshot-and-cross-request-reuse/verification.md for the relocated narrative covering this checkpoint.
