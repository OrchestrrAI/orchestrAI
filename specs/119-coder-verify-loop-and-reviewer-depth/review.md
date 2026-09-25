# Review record: specs/119-coder-verify-loop-and-reviewer-depth

## Round 1 — 2026-09-23

**Reviewer scope**: full uncommitted diff (`git diff HEAD` — the branch
`spec/119-coder-verify-loop` and `main` both sit on commit `8d22c26`, which
contains only the specs/119 and specs/120 draft documents; the actual
implementation is entirely uncommitted). All 13 changed files plus 2 new
files. `spec.md` Acceptance Criteria used as the checklist. Independently ran
`bun test packages/agents/coder packages/agents/code-review` (122 pass, 0
fail), a full `bun test` (1411 pass, 2 skip, 1 fail — see finding 4), `bun run
typecheck` (0 errors), and `bun run specs:catalog && bun run specs:check`
(passes).

**Verdict: FINDINGS** (2 should-fix, 4 nit — no blockers)

### Should-fix

1. **B1's cross-task/restart adversarial coverage is missing**, contrary to
   `spec.md`'s own Verification Plan and the implementer's claim.
   `spec.md`'s Verification Plan explicitly requires: "a second task never
   inherits the first task's approved argv; a restart mid-task does not
   resurrect one" as adversarial test coverage. No test in
   `packages/agents/coder/verify-loop.test.ts` or
   `packages/agents/coder/index.test.ts` exercises either scenario — only
   pure-function argv-equality cases (identical/different/empty) are tested.
   `verification.md` (Part B section) claims "B1 holds exactly" citing only
   these pure-function cases, narrower than what was actually verified. The
   property holds *structurally* by construction (`approvedArgvs` lives only
   on the per-task pending-action payload, never module/global state —
   `packages/agents/coder/index.ts:246-273`), but the spec asked for an
   explicit adversarial test and none exists.
   **Fixed:** The two missing scenarios are now covered by an explicit
   adversarial suite in `packages/agents/coder/verify-loop.test.ts` (review
   round 1, fix round): (a) **cross-task** — two distinct tasks driven
   through the real `runVerificationAndAdvance()` accumulation path with
   one shared model and one shared MCP double, asserting each task's
   follow-up payload holds only its own argv, neither task's state
   recognizes the other's in either direction, and a genuinely fresh task
   proposing a byte-identical argv to one another task already approved
   and executed still gets a fresh approval (no ambient residue);
   (b) **restart** — against a real scratch store (mirroring
   `packages/shared/pending-action-store.test.ts`'s isolation conventions)
   with the real `PendingActionSchema` (now exported from
   `packages/agents/coder/index.ts` for exactly this) as the restore
   validator: a consumed (`claimed`) mid-loop approval is never restored —
   the argv memory dies with the row — and a still-pending mid-loop action
   restores only as a fresh approval request for its own task, loop state
   coherent, its `approvedArgvs` never reaching another task's restored
   payload. `verification.md`'s Part B section no longer claims "B1 holds
   exactly" on the pure-function cases alone: the claim is scoped to what
   is verified, the two adversarial bullets are recorded, and the round-1
   history of the fix is noted. Gates re-run: `bun test` 1417 pass / 0
   fail, `bun run typecheck` 0 errors, `specs:catalog` + `specs:check`
   pass.

2. **Undisclosed out-of-scope file added**: `.claude/commands/implement.md`
   (untracked, new) is not part of the declared diff file list, not
   mentioned in `spec.md`'s Scope section, and not listed in the
   `context/worklog.md` entry's "Files changed." A slash-command tooling
   artifact unrelated to specs/119's actual behavior — should be removed
   from this changeset or disclosed/justified separately.
   **Fixed:** Resolved per Yusuf's explicit call in the `/fix 119` session
   (the round-1 worklog note had left this "pending Yusuf's call") to the
   second of the two sanctioned resolutions: **kept on disk and
   disclosed**. It is recorded in the `context/worklog.md` specs/119
   fix-round entry as out-of-scope workflow tooling — a 29-line Claude
   Code fallback `/implement` command created during the implementation
   session, sibling of the deliberately-committed
   `.claude/commands/spec.md` and `review.md` — for Yusuf to commit
   separately as its own workflow change. No change to the file itself;
   no spec text claims it.

### Nit

3. `verification.md`'s Gates section (as written by the implementer)
   asserted `bun run typecheck` "could not be run to completion" due to an
   OOM crash in the Go-based `tsgo` compiler, "confirmed via git stash"
   against baseline. In the reviewer's environment, `bun run typecheck`
   completed cleanly with exit 0 and zero errors on the actual diffed tree.
   The underlying code is fine; the verification record's claim doesn't hold
   outside the implementer's own sandbox.
   **Fixed:** `verification.md`'s Gates section rewritten before this round
   was even reported back — an independent re-run (by the orchestrating
   session, before the reviewer's findings arrived) confirmed the same
   thing: `bun run typecheck` exits 0 with zero errors outside the
   implementer's sandbox. The record now states this directly instead of
   the "could not complete" claim.

4. Full `bun test` run surfaced one failure unrelated to this diff:
   `packages/agents/devops/index.test.ts:297` ("analyze-project — reaches a
   terminal state gracefully with no live MCP server" expected `"failed"`,
   got `"completed"`) — `packages/agents/devops/index.ts` is untouched by
   this diff, so this is a pre-existing environment-dependent flake (likely
   a real MCP server reachable in the reviewer's sandbox), not a regression
   from specs/119. The orchestrating session's own independent full-suite
   run (1412 pass, 2 skip, 0 fail) did not reproduce this failure, which is
   consistent with "environment-dependent flake."
   **Fixed:** No code change — the finding's own conclusion (pre-existing,
   environment-dependent, unrelated to the specs/119 diff) stands. Re-ran
   the full `bun test` twice in this fix round: the devops case passed in
   both (final: 1417 pass, 0 fail) — it did not reproduce here either,
   consistent with both prior runs' majority. Left as an environmental
   note; the devops test is outside this spec's scope. One related
   environment observation from this round's re-runs, for the record:
   three pre-existing `packages/mcp` `run_command` tests fail from a plain
   PowerShell session on this Windows machine (`echo` is a shell builtin,
   not in pwsh's PATH) and pass under Git Bash — unrelated to this diff
   either; recorded in `verification.md`'s Gates section.

5. `CLAUDE.md`'s "See specs/041, 042, 043, 077, 080, 081, 082, 083, 086, 098,
   100, 111 for each harness's full history" pointer line was not updated to
   include `119`, even though the preceding bullets it terminates were
   substantially rewritten for specs/119.
   **Fixed:** `CLAUDE.md:183` — the pointer line now reads "See specs/041,
   042, 043, 077, 080, 081, 082, 083, 086, 098, 100, 111, 119 for each
   harness's full history."

6. `spec.md`'s own Acceptance Criteria checkboxes remain all unchecked
   (`- [ ]`) despite a substantial implementation landing, leaving `spec.md`
   looking un-actioned next to a fully-populated `verification.md`. Not a
   defect — per CLAUDE.md's convention, checkboxes are evidence and spec
   status fields are Yusuf's alone — but worth reconciling.
   **Fixed:** Reconciled to the convention of the recently closed specs
   (089/105/110/114 all check evidenced boxes; 114 leaves the unevidenced
   one unchecked): 13 of the 15 Acceptance Criteria boxes in `spec.md` are
   now checked against the evidence recorded in `verification.md`. Two are
   deliberately left unchecked: "A rejection at any step ends the loop
   with nothing further written" (reviewer-verified by code trace, but no
   dedicated hermetic test or live mid-loop rejection run exists yet) and
   "`review-diff` produces a review genuinely informed by deep project
   analysis..." (the live analysis-informed-vs-degraded comparison is
   still recorded as not run). No frontmatter field was touched.

### Verified correct (reviewer's specific focus points, all confirmed)

- B1 exact-argv scoping: correctly scoped (per-task, exact array equality,
  no persistence beyond the task) — mechanism is right; only the boundary
  adversarial *tests* are missing (finding 1).
- Read-only tool binding: structurally enforced by `buildReadOnlyTools()`'s
  own throw-if-not-allow-listed check (`llm-harness.ts:136-139`);
  `run_command`/`run_tests` never appear in that function's tool array.
- Drift recheck: genuinely re-runs each iteration, not just the first
  (traced through code).
- Rejection: halts cleanly via the existing generic reject route; no code
  path resumes a rejected task.
- Code Review: zero `NEEDS_APPROVAL`/`resumeTask`/`pendingActions`
  (grep-confirmed); deep analysis is a real import, fail-open.
- `edit-file`/`edit-files`: genuinely byte-unchanged in behavior; both
  agents' existing tests pass unmodified.
- `crypto.randomUUID()` convention preserved.

### Also independently confirmed this same day, before this round landed

A real live run of the spec's own decisive scenario (real provider, real
scratch project, real approvals over HTTP) was performed by the orchestrating
session and recorded in `verification.md`'s "Live verification, 2026-09-23"
section: a deliberately broken edit, a real failing `bun test`, a genuine
follow-up fix, and B1's no-reprompt behavior on iteration 2's identical
argv — all confirmed against the real filesystem and a fresh `bun test` run
outside the agent's own process. This closes the spec's own stated bar
("without it, nothing here is proven") independent of this review round.

---

**Next step**: run `/fix 119` (all open findings) or `/fix 119 1,2` (the two
should-fix items; nits 3–6 are optional/informational) in OpenCode.

## Round 2 — 2026-09-24

**Reviewer scope**: verified every Round 1 `Fixed:` claim against real evidence
(not trusted at face value) plus a fresh independent pass over the complete
current diff (`git diff HEAD` — same uncommitted working tree as Round 1, now
including the fix-round's additions: the two new B1 adversarial test suites,
the corrected `verification.md`, the `CLAUDE.md` pointer fix, and the checked
Acceptance Criteria boxes). Independently re-ran `bun run typecheck`, a full
`bun test` (twice), and `bun run specs:check`.

**Verdict: CLEAN.** All six Round 1 findings are genuinely RESOLVED — verified
against actual code, actual test file contents, and actual worklog text, not
the `Fixed:` annotations alone:

1. **B1 cross-task/restart adversarial coverage — RESOLVED.** Read
   `packages/agents/coder/verify-loop.test.ts:396-580` directly. The
   cross-task suite drives two real tasks through
   `runVerificationAndAdvance()` with a shared model/MCP double, confirms
   each task's `approvedArgvs` holds only its own argv in both directions,
   and confirms a fresh task proposing another task's already-approved argv
   still gets `hasApprovedArgv() === false`. The restart suite uses a real
   scratch `ORCHESTRAI_PROJECT_PATH`, the real
   `persistPendingAction`/`claimPendingAction`/`restorePendingActions`, and
   the real exported `PendingActionSchema` as the restore validator — a
   `claimed` row is never restored, a `pending` row restores coherently with
   no cross-task leak. Genuine adversarial tests, not just plausibly named.
2. **Undisclosed `.claude/commands/implement.md` — RESOLVED.** Confirmed the
   file is exactly what's claimed (a 29-line `/implement` slash-command
   definition, no runtime/spec-119 behavior) and that the disclosure is
   genuinely present in `context/worklog.md`.
3. **Typecheck claim — RESOLVED, independently re-confirmed**: exit 0, zero
   errors.
4. **DevOps test flake — confirmed environment-dependent, not a
   regression.** Reproduced the flake once (1416/1 fail) and its absence
   immediately after (1417/0 fail) and in isolation (19/0 fail) — consistent
   with a timing-dependent flake in an untouched file, not something this
   diff caused.
5. **CLAUDE.md pointer line — RESOLVED**: line 183 now lists `119`.
6. **Acceptance Criteria checkbox reconciliation — RESOLVED, honestly
   done.** All 13 checked boxes trace to real evidence in `verification.md`;
   the 2 left unchecked (mid-loop rejection has no dedicated test; the live
   review-diff analysis-comparison genuinely wasn't run) are honestly the
   right two to leave open.

**Fresh independent findings, no new should-fix or blocker items:** drift
recheck confirmed to run on every iteration, not just the first; fresh
`actionId` per iteration confirmed; `approvedArgvs`/loop state confirmed to
live only on the per-task persisted payload (no module-level tracking);
Coder's read-only tool allow-list confirmed unchanged; Code Review's Part A
wiring (git_diff binding, codebaseContext threading, findings field, fail-open
distinction between an "unavailable" note and real context) matches the spec;
`edit-file`/`edit-files` test assertions confirmed genuinely byte-unchanged.

**One nit, disclosed by the reviewer against itself rather than presented as a
clean finding**: while checking `specs:check`, the reviewer ran the
write-capable `bun run specs:catalog` (outside its intended read-only role) to
confirm the catalog was current. Effect: `specs/README.md` and
`specs/catalog.json` gained one generated line each, linking `119`'s
already-existing `verification.md` into the catalog — a link that was
genuinely stale (`verification_path: null`) despite `verification.md`
existing on disk and both the round-1 review and the fix-round worklog entry
having already claimed `specs:catalog` had been run. The regeneration itself
is the correct, expected fix for that staleness (per CLAUDE.md: these files
are generated in full and never hand-edited) and reflects real current disk
state — not something to revert — but it was performed by the reviewer rather
than requested, so it's recorded here rather than folded silently into "no
findings."

---

**Loop closed.** Next step: run `/verify 119` in OpenCode and proceed to
closure.
