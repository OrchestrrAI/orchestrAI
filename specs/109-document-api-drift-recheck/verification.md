# Verification: Documentation's Write Path Gains the Post-Approval Drift Recheck

Status: **verified**, 2026-09-22.

## Automated

- `bun test`: 1307 pass, 0 fail, 2 skip (pre-existing, unrelated) across
  83 files. `bun run typecheck`: 0 errors. `bun run specs:check`: 109
  specs.
- Every pre-existing `packages/agents/documentation/*.test.ts` test
  (40 tests, 4 files) passes unmodified — no regression to the
  synchronous-failure-path coverage those files already establish.
- No new `bun test` cases were added for the drift-recheck behavior
  itself, deliberately matching `approval-content.test.ts`'s own stated
  methodology (see that file's header comment): Documentation's
  `mcpClient` is a real, unmockable singleton with no dependency-
  injection seam, so a real content-compute/read-verify round trip
  costs ~3s per MCP call in this no-live-server test environment —
  "too slow and too timing-dependent to be a good permanent bun test
  case... real content-preview correctness... is verified live." This
  spec follows that exact precedent rather than inventing a different
  standard for itself.

## A real, previously-untracked gap found while implementing, not by inspection

`document-api`'s own branch of `processTask()` (before this spec) never
fetched the target's existing content at preview time — `overwrite`
stayed permanently `false`, `previousContent` permanently `undefined`.
Fingerprinting an always-`undefined` value would have made the new
recheck fail the very first genuine overwrite as "drift" (the real file
found at write time would never match the `"absent"` fingerprint
recorded at preview time). Fixed by adding the same existence check
`generate-readme` already had, split via `path.dirname()`/
`path.basename()` since `document-api`'s own target is a full save path
rather than a project root with a fixed filename.

## The decisive live test

Real Documentation agent (`bun run orchestrai --only documentation-agent`,
`ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=0` to exercise the deterministic
path — the recheck logic is identical regardless of which path computed
the content), a real scratch project, no mocks.

**Scenario 1 — `generate-readme`, fresh create.** A real preview showed
`fingerprint: "absent"`, `overwrite: false` (no README existed yet).
Approved with no mutation: the file written matched the preview
exactly, byte-identical.

**Scenario 2 — `generate-readme`, the decisive drift refusal.** A
second real preview against the now-existing README correctly showed
`overwrite: true`, a real `previousContent`, and a real SHA-256
fingerprint. The target was manually mutated (`echo "MANUALLY MUTATED
BY THE USER BEFORE APPROVAL" > README.md`) before approving. The
approval was correctly refused: `"Target ... changed after approval
but before this write — refusing to overwrite unreviewed content.
Resubmit for a fresh preflight."` The file was confirmed to still hold
the manual mutation afterward — not corrupted, not overwritten.

**Scenario 3 — `document-api`, fresh create.** Identical to Scenario 1
for the save-to path: a real preview against a genuine `app.ts` (a real
Hono route) showed `fingerprint: "absent"`; approved cleanly, the
written `API.md` matched the preview exactly.

**Scenario 4 — `document-api`, the decisive drift refusal.** A second
real preview against the now-existing `API.md` correctly showed
`overwrite: true` and a real `previousContent`/fingerprint — proving
the newly-added existence-check fix (the real gap found above) works
correctly, not just for `generate-readme`. The target was manually
mutated before approving; the approval was correctly refused with the
identical error shape, and the file was confirmed to still hold the
manual mutation afterward.

Process cleanly torn down afterward; all scratch files and directories
removed.

## Known gaps

None — every acceptance criterion is directly, live-verified against
the real running agent, matching the standard this file's own existing
test suite already established for exactly this class of correctness
claim.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/109-document-api-drift-recheck/spec.md` (implemented, **verified**)
closes `specs/104`'s own tracked item A8: `generate-readme`/`document-api`
gain the same approval-to-write drift guarantee DevOps (`specs/056`),
Testing (`specs/081`), and Coder (`specs/083`) already have —
`resumeTask()` re-fingerprints the real target immediately before the
write and refuses on any mismatch, rather than writing the
already-computed content unconditionally as it did before this spec.
Drafted as a direct prerequisite for `specs/110` (approval state
surviving an agent restart): a persisted-and-restored approval is only
as safe as the recheck that runs before it executes, and Documentation
was the one write-capable agent with no recheck at all.

**A real, previously-untracked gap found and fixed while implementing,
not by inspection**: `document-api`'s own branch of `processTask()`
never fetched the target's existing content at preview time — `overwrite`
stayed permanently `false`, `previousContent` permanently `undefined`,
even for a genuine overwrite. Fingerprinting an always-`undefined` value
would have made the new recheck fail the very first real overwrite as
"drift." Fixed with the same existence check `generate-readme` already
had, split via `path.dirname()`/`path.basename()` since `document-api`'s
own target is a full save path rather than a project root with a fixed
filename.

**Live-verified against a real running Documentation agent, no mocks**,
following the exact methodology this agent's own test suite already
established (`approval-content.test.ts`'s own header comment: a real
MCP round trip is too slow/timing-dependent for a permanent `bun test`
case, so drift-recheck correctness is verified live): a real
`generate-readme` create; a real overwrite scenario with a genuine
manual mutation of the target between preview and approval, correctly
refused with the file left holding the mutation, not corrupted; and the
identical two scenarios for `document-api`'s own save-to path,
confirming the newly-added existence-check fix works there too. 1307
tests pass (0 fail, unmodified from `specs/108`'s own baseline),
typecheck clean, `specs:check` passed for 109 specs. See `specs/109`'s
own `verification.md` for the complete transcript.

See specs/110-approval-state-survives-a-restart/verification.md for the relocated narrative covering this checkpoint.
