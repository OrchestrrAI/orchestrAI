## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

- `apps/tui` is no longer read-only: `specs/012-tui-interactive/spec.md`
  (implemented, live-verified) added keyboard-driven approve/reject
  (double-press confirm), task submission through the Orchestrator,
  agent-pane navigation/filtering, agent detail view, direct-to-agent task
  submission (bypassing the Orchestrator on purpose, mirroring what a
  browser could do by hitting an agent's own dashboard directly), and a
  `?` help view (now a separate full-screen view, not a third box stacked
  below Agents/Tasks — found to matter for layout correctness under load,
  not just cosmetic). It polls rather than uses SSE, a deliberate
  simplification from `specs/010-tui-cli/spec.md`'s original proposal. Later rounds
  added a Tasks-pane view-clear with undo (`c`), a completed/failed hide
  toggle (`h`), and auto-following the newest task; a real terminal-row-
  overflow bug (task rows exceeding the actual terminal height corrupting
  the display) was found and fixed via two decisive live tests from Yusuf
  rather than guesswork — see that spec's thirteenth round.

See specs/030-authoritative-skill-dispatch-and-capability-catalog/verification.md for the relocated narrative covering this checkpoint.

See specs/108-durable-audit-trail/verification.md for the relocated narrative covering this checkpoint.

See specs/113-live-audit-log-dashboard/verification.md for the relocated narrative covering this checkpoint.

See specs/114-coder-multi-file-edit-and-create/verification.md for the relocated narrative covering this checkpoint.

See specs/044-conversational-ask-layer/verification.md for the relocated narrative covering this checkpoint.

See specs/016-orchestrai-supervisor/verification.md for the relocated narrative covering this checkpoint.
