# Verification: AG-UI Demo and TUI Stabilization

## Status

`partial` — implementation, Windows automation/live flows, and Yusuf's
real-terminal TUI visual check all pass. Native Linux execution remains
the only open item.

## Automated evidence

- `bun test`: 158 passed, 0 failed, 281 expectations across 18 files.
- `bun run typecheck`: exited 0.
- `bun run specs:check`: passed for 25 specs.
- `git diff --check`: passed.
- `rg -n 'console\.(log|error|warn)' apps/tui/index.tsx`: no matches.
- Focused audit mapping proves START/RESULT pairing, distinct caller-minted
  IDs, legacy fallback, and non-throwing rejection of invalid pushes.
- Focused TUI reduction proves START/FINISHED pairing and a 50-step per-run
  retention bound.
- Demo argument tests prove environment/default selection, explicit override,
  opt-in writes, and invalid-argument rejection.

## Windows live evidence

The stack was started through the supervisor with all five agents plus MCP
healthy, then stopped through its SIGTERM cleanup path.

### Default, non-mutating mode

Command:

```text
bun run demo:ag-ui -- --project C:\Users\moham\test-target-project --timeout-ms 120000
```

Result: passed all six state-driven scenarios with 41 captured AG-UI events.
The before/after target fingerprint matched. Final raw capture:

```text
C:\Users\moham\AppData\Local\Temp\orchestrai-ag-ui-f55acc56-0514-4e64-8b76-0aa4bb5d1922.ndjson
```

### Explicit write mode

Command:

```text
bun run demo:ag-ui -- --project C:\Users\moham\AppData\Local\Temp\orchestrai-agui-write-022-6b2e1c7d --timeout-ms 120000 --allow-writes
```

Result: passed all default scenarios plus one approved `create_gitignore`
action with 46 captured events. The runner reported that `.gitignore` did not
exist beforehand, named the exact target before approval, and left the created
fixture for manual inspection/cleanup. Final raw capture:

```text
C:\Users\moham\AppData\Local\Temp\orchestrai-ag-ui-64848a3a-51ab-40c7-b028-1c19e1a96ea6.ndjson
```

An earlier write attempt against `C:\Users\moham\test-target-project` failed
closed with `EPERM` because that already-running MCP process could not write
outside the sandbox. It changed no file. The rerun used the explicit OS-temp
fixture above and passed.

## Real-terminal TUI check (Yusuf, live)

Confirmed by Yusuf directly in a real interactive terminal on 2026-08-16:
the TUI works fine — no redraw garbling or corruption observed during live
use. This closes remaining manual/platform check #2 below (step-indicator
badge, Detail view, and disconnect/reconnect behavior all functioning as
intended). Not re-derived from a sandboxed shell capture — this is the same
class of live confirmation `specs/012-tui-interactive/spec.md` required
before treating prior TUI rounds as trustworthy.

## Remaining manual/platform checks

1. Run the default command on native Linux and record its raw capture.
2. ~~In Yusuf's real Windows terminal, start a multi-step plan and confirm
   the step indicator, Detail view, and redraw behavior~~ — done, see above.

Do not change verification to `verified` until the Linux check is also
recorded.
