# Verification: Guided Init — Spawn the Auto-Launched TUI as a Separate Process

Date: 2026-09-06

Result: **partial**. The code change is narrow, typechecks, and passes the
full existing suite unchanged; the non-TTY/`--headless` path is confirmed
structurally and live unaffected. The one property this spec exists to
fix — no crash when `orchestrai init` → `^S` opens the workspace TUI after
the setup form's own renderer — needs Yusuf's real terminal to confirm, the
same class of check specs/047/048 already established this repo's own PTY
harness cannot substitute for (rendering-nesting behavior specifically).

## What changed

`apps/supervisor/index.ts`'s `main()`, inside the existing `shouldOpenTui`
branch: replaced `await (await import("../tui/index")).start()` (in-process)
with `Bun.spawn()`ing the exact same `orchestrai tui` entry point as its own
child process, `stdin`/`stdout`/`stderr` all `"inherit"`, `env: process.env`,
not added to the `children` array `shutdown()` sweeps. `git diff --stat`
confirms exactly one file touched, 32 insertions / 13 deletions — no other
file in the repository was changed.

## Verified

- `bun run typecheck` — 0 errors.
- `bun test` — 717 pass, 0 fail, 1401 expectations across 48 files —
  byte-identical to the pre-change baseline (this change has no unit-testable
  surface of its own; every acceptance criterion below the pure-typecheck
  line is a real-process/real-terminal property).
- **Dev-mode command resolution**: `apps/tui/index.tsx` exists at the exact
  path the new `tuiCommand` array resolves to
  (`path.join(REPO_ROOT, "apps/tui/index.tsx")`), confirmed directly against
  the filesystem, not assumed.
- **Non-TTY/`--headless` path unaffected, live**: `bun run apps/supervisor/
  index.ts --headless --only devops-agent` run directly in this
  non-interactive shell (`process.stdout.isTTY` is false here regardless of
  the flag) — printed the existing stale-variable warnings, resolved the
  project path, and reached the existing port-preflight check
  (correctly refusing because port 3002 was already in use by another
  session on this machine) — proving the code path up to and including
  `shouldOpenTui`'s own gating runs exactly as before. `shouldOpenTui =
  Boolean(process.stdout.isTTY) && !headless` is unchanged by this spec, so
  this run never entered the new spawn branch at all — consistent with
  the acceptance criterion that `--headless` and non-TTY startups stay
  byte-identical to before.

## Not yet done — needs Yusuf's real terminal

Per the spec's own Verification Plan, this is not substitutable:

1. **The actual repro from spec 048's finding**: `orchestrai init` → fill
   the form → `^S` → confirm the stack starts and the workspace TUI opens
   in the same window with no crash. This is the one property this spec
   exists to fix.
2. **The existing two-step quit still works**: quitting the TUI (its own
   keyboard quit) returns control cleanly; a second Ctrl+C (or the TUI's
   own quit key) still stops the backend via the existing `shutdown()`
   path — same documented behavior as before this spec, now via a spawned
   process rather than an in-process call.
3. **No-orphan check** after a launched-then-quit run — every port free,
   no child process left behind, the same check specs/016/045 already
   established.

Until Yusuf runs these, `verification` stays `partial` and `specs/
048-guided-init-experience/verification.md`'s own open finding stays open —
this spec's code is in place but its actual effect (no crash) is unconfirmed
outside a real terminal, exactly the caveat specs/047/048 both already
recorded honestly for this same class of property.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

See specs/066-supervisor-log-suppression-during-tui/verification.md for the relocated narrative covering this checkpoint.
