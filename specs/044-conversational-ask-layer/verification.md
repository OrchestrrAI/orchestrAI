## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**Live-verified with a real Gemini deployment, the exact scenario this
checkpoint started from**: *"is there test coverage?"* → Tier 1 →
approved through the real gate → the real runner executed 4 real tests →
*"Yes, there is test coverage, and it is at 100% for lines across all
files, with all 4 tests passing"* — correctly selecting the **line**
coverage figure over the **funcs** figure sitting right next to it in
the same raw output, with the full deterministic report still completely
present beneath the synthesized sentence. A Tier 0 question and a
genuine (non-scripted) follow-up both answered correctly, grounded in
real state. See that spec's Verification Results for the full record.

The TUI gained a **full-screen** chat view (`k`), built on the
exact early-return structure the `?` help view already uses rather than
a third box stacked below Agents/Tasks — load-bearing, not stylistic:
`specs/012`'s thirteenth–sixteenth rounds fixed real terminal-overflow
bugs, and this view adds nothing to that combined-height budget while
it's showing, since it's the only thing rendered.

See specs/027-ag-ui-core-adoption/verification.md for the relocated narrative covering this checkpoint.

See specs/115-tui-navigation-redraw-and-answer-clarity/verification.md for the relocated narrative covering this checkpoint.

See specs/097-chat-answer-and-plan-description-honesty/verification.md for the relocated narrative covering this checkpoint.
