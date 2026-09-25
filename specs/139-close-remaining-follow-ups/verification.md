# Verification — 139 close the remaining follow-ups from specs 130–137

## B. Spec 130's two unobserved items, now observed live (2026-09-25)
The stack was `--only orchestrator,devops-agent`, with persistence on,
against `C:\Users\moham\test-target-project`. It ran read-only tasks
only.

**`child of <id>` rows.** A read-only plan, "Two separate things: check
my git status, and also analyze my project structure", gave `[git-status]`
and `[analyze-project]`, both completed.

| Size | Tasks rows |
|---|---|
| 140×40 | `≡ orchestrator- completed Two separate things: …` / `↳ devops-agent completed child of 6c9ba962 · git-status: Check the git …` / `↳ … child of 6c9ba962 · analyze-project: Analyze t…` |
| 80×24 | the same rows, truncated with `…` inside the row: `child of 6c9ba962 · git-status: Check th…` |

**Early refresh on `RUN_FINISHED`, measured.** A scratch driver
(`drive-139b.js`, never committed):
- listens on `GET /events`;
- runs the TUI in a real PTY at 140×40 in Tasks;
- submits a uniquely marked read-only task (`zz<n>… what is my git
  status?`, routed to `git-status`);
- takes a screen snapshot every 100 ms;
- records the delay from the `RUN_FINISHED` event to the first snapshot
  where that task's row reads `completed`.

| Run | Delay |
|---|---|
| 1 | 9 ms |
| 2 | 103 ms |
| 3 | 25 ms |
| 4 | 27 ms |
| 5 | 13 ms |

The spec's criterion was that every run is below 1.5 s. A stricter reading
was applied, because a poll alone would also land below 1.5 s:
- a poll-only update would spread uniformly over 0–1,500 ms (a mean of
  about 750 ms);
- all 5 runs landed within 103 ms (the snapshots have ±100 ms
  resolution).

So it is the SSE-triggered refresh, not the poll, that updates the row. No
fix was needed. Spec 130 moves to `verification: verified`.

## C. One Audit row is always one line
- `apps/tui/tui-state.ts`:
  - `clipText()`;
  - `fitAuditRow({ available, time, badge, caller, target, tail,
    compactTail })` gives the target the space first, then the caller
    (down to `AUDIT_CALLER_MIN_WIDTH` = 6);
  - when even that doesn't fit, it switches to `compactTail` (the outcome
    word dropped, since the ✓/✗ glyph already shows it), and clips the
    tail only as a last resort;
  - the row never exceeds `available`.
- `apps/tui/index.tsx`: the Audit row uses it with
  `available = centerWidth - 5` (border 2, padding 2, scrollbar 1). This
  is one column stricter than the spec's `centerWidth - 4`, because the
  scrollbar takes a column.
- **Found during implementation:** at 110×30 the centre is only 54
  columns (both rails are shown). There, the fixed parts of the longest
  row (a long time string plus `· completed · 120000ms · 64.0KB trunc`)
  exceed the space even with an empty caller and target. The
  compact-tail fallback exists for that case.
- **Unit tests** (`apps/tui/tui-state.test.ts`):
  - the longest real row fits at 80×24, 110×30 and 140×40 (using the real
    `computeShellLayout()` centre width);
  - the exact observed wrap now fits;
  - nothing is clipped when it fits;
  - the target keeps space first;
  - the tail fallback order;
  - `clipText` edge cases.
- **Live 80×24** (183 audit rows): every row is one line, with long
  callers clipped (`A2A orchestrat… → analyze-project · completed ·
  1012ms · 0B`). The spec 135-noted wrap
  (`orchestrator-supervisor → git-status … 1020ms · 0B`) no longer occurs.

## D. `edit-and-verify` fix iterations keep the plan background
- `packages/agents/coder/index.ts`:
  - `EditAndVerifyEditAction` / `EditAndVerifyCommandAction` and their Zod
    schemas gain an optional `planContext`;
  - it is set from `splitPlanStepText(text).context` when the task starts;
  - it is carried into every command action and next-edit action, and
    through `handleVerificationOutcome()` and both
    `runVerificationAndAdvance()` call sites.
- `packages/agents/coder/verify-loop.ts`: `VerificationContext.planContext`
  is passed as `context` to the fix-iteration `runEditFilesHarness()`.
- **Unit tests** (`packages/agents/coder/verify-loop.test.ts`), through the
  real `runVerificationAndAdvance()` and the real `PendingActionSchema`
  restore gate:
  - with `planContext`, the fix prompt carries the fenced background;
  - without it, there is no background;
  - a row without `planContext` (as saved before this change) and a new
    row with it both validate;
  - a non-string `planContext` is rejected.
- **Live: recorded as unit-verified only, as the spec allows.** Arranging
  a plan step whose first verification genuinely fails needs a
  deliberately broken scratch project and approved writes on it. The
  unit tests exercise the real loop and the real schema.

## Totals
- `bun run typecheck` 0 errors.
- `bun test` (`ORCHESTRAI_MCP_PORT=5999`): 1614 pass / 2 skip / 0 fail.
- The fixture's SHA-256 snapshot matched after every live run. Only
  read-only tasks ran.

## A test bug found by the pre-commit hook (fixed)
The first two commit attempts failed in the pre-commit `bun test`, but
never in 8 manual full runs. D's new test returned `kind: "failed"`, and
switching to `toMatchObject` surfaced the reason: `Proposed path "src/a.ts"
is outside the project root`.
- **Cause:** the test was written through a shell that collapsed `\` to
  `\`, so its project root landed in the source as `"C:\proj"`. In
  JavaScript that is `C:proj` (`\p` is `p`), a *drive-relative* path.
  `path.relative()` resolves it against the current directory on drive C,
  which differs between an interactive shell and the git hook's
  environment. That explains the environment-dependent result.
- **Fix:** both occurrences corrected to the escaped source form `"C:\\proj"`
  (a real `C:\proj` at runtime).
- **Checks:** a scan of every changed `.ts`/`.tsx` file for single-backslash
  Windows paths found no others.
- **The product code was never at fault;** its containment check correctly
  refused a path outside an unusual root.
