## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

- `specs/004-configurable-project-paths/spec.md` is approved and implemented.
- `specs/005-mcp-agent-integration/spec.md` is approved, implemented, and verified;
  its Testing/Documentation/Security MCP target-state items remain out of scope.
- `specs/006-runtime-stabilization/spec.md`,
  `specs/007-parsing-and-sse-reliability-fixes/spec.md`,
  `specs/008-routing-fixes/spec.md`, `specs/009-dockerization/spec.md`,
  `specs/010-tui-cli/spec.md`, `specs/011-remaining-agents-mcp/spec.md`,
  `specs/012-tui-interactive/spec.md`, `specs/013-security-skill-detection/spec.md`,
  `specs/014-typecheck-ci/spec.md`, `specs/015-routing-planning-polish-2/spec.md`,
  `specs/016-orchestrai-supervisor/spec.md`,
  `specs/017-standalone-binary-distribution/spec.md`,
  `specs/018-supervisor-project-path/spec.md`,
  `specs/019-cicd-recreate-and-binary-builds/spec.md`, and
  `specs/020-semantic-intent-fallback/spec.md` are all approved and
  implemented. The first three
  are fully verified. `specs/009-dockerization/spec.md` is live-verified end to end
  (`docker compose up` brings up all 7 services correctly). `specs/010-tui-cli/spec.md`
  is implemented and live-verified against real data; its Windows-Terminal
  compatibility gate was confirmed closed directly by Yusuf running
  `bun run tui` in his own terminal (no flickering/resize/exit-closes-
  terminal issues) on 2026-08-08 — `verification` stays `partial` for a
  different, still-open reason: the kill/restart-Orchestrator
  disconnect-behavior path was never live-tested (see that spec's
  Verification Results).
  `specs/012-tui-interactive/spec.md` added keyboard-driven approve/reject/task
  submission plus (across sixteen extension rounds, all logged in its own
  Verification Results) agent-pane navigation/filtering, agent details,
  direct-to-agent submission, a full-screen help view, fixes for duplicate/
  missing rows in the filtered task view, a Tasks-pane view-clear with undo
  (`c`) and a completed/failed hide toggle (`h`), and auto-following the
  newest task like a chat/log view. Its core interactivity, including real
  keyboard-driven navigation and layout under load, is now live-verified by
  Yusuf directly (not just from this sandboxed shell) — see that spec's
  thirteenth-through-sixteenth rounds for the two decisive live tests
  (clearing an overfull task list; zooming the terminal out) that isolated
  a real terminal-row-overflow bug, and the sixth round's own honest note
  that some earlier rounds' fixes were later found to be red herrings or,
  in one case (the eleventh round), an active regression — corrected in
  the twelfth round once real evidence (a screenshot) proved it, not
  glossed over. `specs/013-security-skill-detection/spec.md`
  broadened Security's own `detectSkill()` so common free-form phrasing
  (`"scan"`, `"security check my project"`, etc.) is recognized instead of
  falling through to `"unknown"` — live-verified end to end.
  `specs/014-typecheck-ci/spec.md` took `bunx tsc --noEmit` from 201 errors to 0 and
  added the `bun run typecheck` script the existing CI workflow already
  called but had nothing to run. `specs/015-routing-planning-polish-2/spec.md` closed
  the three routing gaps listed just above (now historical, not current).
  `specs/016-orchestrai-supervisor/spec.md` (implemented, **verified**)
  added `bun run orchestrai` (`apps/supervisor/index.ts`) — live-verified
  for port preflight, ordered startup, prefixed logs, `--only` (including
  its warned MCP-auto-include behavior), the auto-launched TUI viewer in
  a real terminal, and no-orphaned-processes-after-shutdown. The
  supervisor's exact shutdown code path (as opposed to Windows/Bun's own
  signal-emulation layer) is a genuine, honestly-recorded curiosity, not
  a blocker: Yusuf's own real-terminal Ctrl+C test (2026-09-01, the
  auto-launched-TUI path) needed two presses, not one, and neither of
  `shutdown()`'s own log lines ever appeared — the third consistent data
  point showing this. The property that actually matters, zero orphaned
  processes and every port free, was independently re-confirmed right
  after via `Get-CimInstance`/`netstat`, not just inferred from the
  terminal returning to a prompt. The help text and the viewer's own
  startup log line were reworded to describe the real two-press sequence
  instead of implying one press suffices.

See specs/102-orchestrator-readonly-project-inspection/verification.md for the relocated narrative covering this checkpoint.

See specs/054-capability-driven-llm-routing/verification.md for the relocated narrative covering this checkpoint.
