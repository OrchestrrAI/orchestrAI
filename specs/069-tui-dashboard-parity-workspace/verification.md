## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/069-tui-dashboard-parity-workspace/spec.md` (`status:
implemented`, **`verification: pending`**; amends `012`; `plan.md`-backed,
**multi-phase**) brings the TUI toward the browser dashboard's
information architecture — a left conversations rail, a centre
Chat|Tasks|Agents workspace, a right agent-status rail. The spec is
explicit that this is *the single largest and riskiest change in this
codebase's history* (`apps/tui/index.tsx` took 16 rounds under `012`
plus a phase set under `047`, almost all fixing terminal-row-overflow
bugs that only appear in a live PTY), so it lands **phase by phase, each
phase gated on a live Yusuf terminal pass** — `bun test`/`typecheck`
cannot see a rendered frame.

**Phase 1 (implemented 2026-09-10) — the shell only.** New pure geometry
in `apps/tui/tui-state.ts`: `computeShellLayout({width,height})` (the
responsive-collapse breakpoint table — right rail at ≥110 cols, left
rail full at ≥100 / a 6-col strip at ≥84 / hidden below, a 1-col gap
between shown regions, `centerWidth` derived) and
`computeShellRegionHeight()`, both unit-tested (`tui-state.test.ts`,
including an 80→220 width sweep asserting no region+gap ever exceeds the
usable width and the centre never underflows). `index.tsx` gains a
`renderShell(center, footer)` wrapper + `renderLeftRail()` (the existing
`chatConversations`, newest first) + `renderRightRail()` (agent ●/○ list
+ a recent-tasks strip) — all from **already-polled state, no new
fetch**. The **Tasks and Agents** modes now render through the shell;
**Chat stays a full-screen view** (folding it into the centre Chat tab
is Phase 2's entire job). Overlays (Help / Detail / new-task input /
too-small) stay full-screen early returns (Phase 4 reconciles them).
Every keybinding path (`resolveKeyOwner`/`resolveModeKey`/the a-r
double-press machine/filters/`c`/`h`/follow-latest) is untouched, and
`computeTaskWindow`'s `reservedRows` still matches the unchanged
header/footer chrome exactly. **The load-bearing safety property**: at
the 80×24 minimum both rails collapse away and `centerWidth == width -
2`, i.e. byte-close to the pre-069 full-width render — the rails only
appear once there is real width to spend. Live-smoked at 80×24 in a real
PTY (renders clean, both rails collapsed). **Not verified**: the wider
sizes where the rails actually appear — the implementing environment's
PTY is fixed at 80×24, so that (and the zoomed-out long-task-list pass)
is Yusuf's, and **Phase 2 does not start until he confirms it**. Phases
2–4 (Chat as a centre tab; inline approvals + live right-rail status;
polish + retire the old overlays) are in `plan.md`, not started.

**Phase 2 (implemented 2026-09-12) — Chat folds into the shell.** Chat
now renders through the exact same `renderShell()` Phase 1 built for
Tasks/Agents, replacing the old full-screen block. The retired
`computeChatScrollHeight()` (specs/047's own fix for a real flexGrow/
header-corruption bug) is deleted entirely — its replacement,
`computeShellChatScrollHeight()`, reserves against the *shared* shell
chrome (verified equal to `computeTaskWindow()`'s own `reservedRows`
formula) instead of the full screen. The composer's 6 rows moved INSIDE
the centre panel's own budget (shrinking the scrollbox when open)
specifically so the shell's footer stays exactly one row always,
matching Tasks/Agents' own invariant — letting the footer itself grow to
6 rows when the composer opens would have made the rails' fixed
`shellRegionHeight` (computed once, without knowing about the composer)
disagree with the real available space, reintroducing the exact
overflow-bug class this file's 16-plus rounds of history are full of.
The left rail's conversation list needed **zero new wiring**: it already
read the same `chatConversationId`/`chatConversations` state Chat itself
uses — it simply never appeared before because Chat was full-screen.
Content and every keybinding are unchanged; inline task cards for a
dispatched turn already existed (`specs/046`) and needed no change here.
A small, additive UI fix landed alongside this at Yusuf's request: the
Help view (`?`) now has a line explaining that mouse tracking being on
is why a plain click-drag doesn't do native terminal text selection, and
that holding Shift while selecting works around it in most terminals —
it replaces a blank separator line rather than adding a new row, so the
Help view's own row budget (already right at the 80×24 minimum with 1
row of margin) is unaffected. `bun test` 899 pass, typecheck clean.
Live-smoked in a real 80×24 PTY: the new "Chat — thread N/M" title row
renders at the same starting row Tasks/Agents' own titles do, footer and
scrollbox both render within bounds, no overflow — and, as designed,
both rails stay correctly hidden at 80 columns, so this pass could not
confirm the rails actually appearing next to Chat at a wider size.
**Not verified**: ~120×32 and a zoomed-out terminal, where the rails
show up alongside Chat for the first time — Yusuf's terminal, same
standard as Phase 1. **Phase 3 does not start until he confirms it.**

**Two real bugs found and fixed live during that same verification pass,
2026-09-12, not assumed away.** (1) The composer's label and typed-input
rows collapsed onto the same terminal row the moment the composer
opened — exactly the "`overflow:"hidden"` doesn't reliably clip here, it
overwrites" class of bug this file has hit before (`specs/047` Phase 2).
The composer box had no *explicit* height, relying on natural sizing
inside a now budget-constrained container — `computeShellChatScrollHeight()`
already assumed it would be exactly 6 rows when shrinking the scrollbox,
but nothing forced the actual render to match that assumption. Fixed by
giving the box an explicit `height: 6`, closing the ambiguity the same
way `init-form.tsx`'s `FieldRow` already does for the same shape.
(2) The header's own `project: ... approvals: N` line showed genuine
stray leftover characters interleaved into otherwise-correct text
(`"project:AC:\...-servers approvals:v0"`). Root cause: that line's
available width for the project path was computed from
`` `approvals: ${approvalCount}`.length ``, a value that changes digit
count as `approvalCount` changes, and the path itself changes length
exactly once when it resolves from the placeholder to a real value —
either shift moves where later text starts between two frames, and this
renderer doesn't reliably clear a cell whose new content is shorter than
what was there before. Fixed by reserving a **fixed** budget for the
approvals suffix regardless of its real digit count and padding the
whole composed line to always be exactly the same total length, so two
consecutive renders can never disagree about where anything sits.
Live-smoked in a real PTY: the composer's label and input now render on
two distinct rows; the header line renders correctly (the frame-to-frame
shift itself couldn't be reproduced in this sandbox's static PTY, which
has no live-changing agent/approval state, but the fix directly removes
the mechanism that caused it).

See specs/108-durable-audit-trail/verification.md for the relocated narrative covering this checkpoint.

See specs/115-tui-navigation-redraw-and-answer-clarity/verification.md for the relocated narrative covering this checkpoint.
