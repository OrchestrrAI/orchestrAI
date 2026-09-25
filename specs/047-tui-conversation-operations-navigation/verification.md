# Verification: TUI Conversation and Operations Navigation

Date: 2026-09-06 (corrected; originally 2026-09-05, see the Phase 4/5
correction note below for why)

Result: **verified**. All five phases are implemented. Phase 4/5's own
record was rewritten 2026-09-06 after its first version made
unfalsifiable claims a review caught and could not confirm (see below),
and replaced with real PTY-harness evidence plus Yusuf's own direct
real-terminal confirmation for both the Phase 2 gate and Phase 5's own
matrix — the two things a harness alone could never establish. Every
`specs/012` round that reached this exact class of claim needed a real
human at a real terminal; this spec is no exception, and that step
genuinely happened here, not merely asserted.

## Phase 1

Commit `2c8018f` extracted the task/filter/selection/row-budget/key-owner/
confirmation/plan-child state into `apps/tui/tui-state.ts`. Its own unit,
typecheck, governance, and live PTY evidence is recorded in `plan.md`.

## Phase 2 — Automated evidence

- Added Chat-default `chat | tasks | agents` state and pure `resolveModeKey()`
  handling for `1`/`2`/`3`, Tab, Shift+Tab, and wrapping in both directions.
- Inputs and overlays retain priority through `resolveKeyOwner()`; Chat is now
  a peer mode, not an overlay/key owner.
- Tasks and Agents render as separate full-screen modes. Task Detail and the
  task composer replace the list instead of stacking below it.
- Re-derived the Tasks-only row budget. The removed Agents pane no longer
  consumes rows; the visible filter legend consumes exactly one row.
- Added the approved optional `projectPath` field to `GET /healthz`; the TUI
  uses `project unavailable` with an older response.
- Agent skill text and high-density labels are bounded/shortened for the
  minimum-width terminal.
- Full repository suite: `bun test` — **632 pass, 0 fail**, 1,283
  expectations across 48 files at the final implementation pass.
- TypeScript: `bun run typecheck` — **0 errors**.
- Spec governance: `bun run specs:check` — **47 specs valid**.

## Phase 2 — PTY behavioral evidence

The real TUI was launched through a genuine interactive PTY at 80×24 against
the real services on ports 3000–3006 with
`ORCHESTRAI_PROJECT_PATH=C:\Users\moham\test-target-project`.

- Booted in `[1 Chat]` and changed to Tasks/Agents with `2`/`3`, forward Tab,
  and the real Shift+Tab escape sequence. No other mode remained rendered.
- The shared header changed active brackets and showed `● live · 5/5 agents`,
  the authoritative target path, and the waiting-approval count.
- Typed `1 2 3 a r Tab` in both Chat/task input paths; the text remained input
  and did not trigger navigation or approval. A literal Tab key also did not
  switch modes while the input owned focus.
- Submitted 18 read-only `git-status` tasks in addition to existing tasks. The
  80×24 Tasks screen stayed bounded, followed the newest row, and reported the
  hidden count.
- Opened the selected task's exact Detail view with the full task list present;
  Detail replaced the list and stayed inside the terminal.
- Opened Agent Detail, then used `f` on `testing-agent`; the TUI switched to
  Tasks with the `testing-agent` filter and only matching rows.
- A real `run-tests` task reached `input-required`. The first `a` showed a hint
  naming its exact ID; switching to reject and pressing `r×2` rejected that
  exact task. No test command fired.
- A separate mock Orchestrator on port 3010 exposed one inert waiting task.
  `a×2` produced `APPROVED exact mock-approval-1` at the mock endpoint and
  updated only that row to `completed`; no MCP tool or command existed behind
  the mock. This proves approval routing without authorizing a real write.
- All test processes were stopped and ports 3000–3010 were confirmed clear.

### Regression found and fixed during the PTY pass

The inherited Help content overflowed 80×24 and visibly corrupted rows. It was
reduced to a bounded 15-line terminal reference and rerun with a full task
list: Help replaced Tasks and ended at row 22 without overflow. The first
Detail implementation also retained the list above it; arithmetic showed that
could not fit at 80×24, so Detail/composer were changed to replacement views
and rerun before this evidence was recorded.

### Two more regressions found and fixed the same way, in a self-review pass

Yusuf asked whether the Phase 2 result could be checked independently before
his own real-terminal pass — the same "check it yourself like the browser"
request that produced spec 046's Amendment 2. A fresh PTY run (this time
using `@xterm/headless`, a real terminal-screen-buffer emulator, rather than
naive ANSI-stripped text — chosen specifically because naive stripping
cannot distinguish a real corruption from a harmless multi-frame redraw
artifact, and this pass needed to tell the two apart with confidence) found
two more real bugs the first Phase 2 pass had missed, both confirmed present
at the actual 80×24 supported minimum, not just below it:

1. **The Chat scrollbox's `flexGrow`/`flexShrink` corrupted the header
   rendered above it.** Isolated by direct A/B: the identical scrollbox with
   an explicit numeric `height` instead of `flexGrow` rendered the header
   correctly; Detail's own scrollbox (fixed `height: 12`, never `flexGrow`)
   was never affected. Fixed with `computeChatScrollHeight()`
   (`apps/tui/tui-state.ts`), a real computed row budget — the same
   discipline `computeTaskWindow()` already uses, for the same reason.
2. **The header's project-path line and the Chat footer's status line were
   both unbounded** and could wrap onto the row below on a narrow terminal,
   which is the same cursor-position-wraparound corruption class
   `computeTaskWindow()`'s own comments already document for Tasks rows —
   here reaching the *header itself*. Fixed: `overflow: "hidden"` on the
   header box (matching the existing Tasks/Agents box pattern) plus
   `bounded()` applied to both the project path and the Chat footer status
   line, the same truncation helper already used elsewhere in this file.

**Verified via the PTY harness at every currently-supported size** (80×24,
120×40, 80×24 with the composer open): header renders correctly, Tasks with
a real 18-task dispatched load stays bounded with a correct hidden-count
indicator, Help and Detail both render cleanly with a full list underneath,
no row-count overflow anywhere. 5 new tests
(`apps/tui/tui-state.test.ts`), including one pinning the exact live-verified
80×24 value. `bun test` 648/648 (up from 643). `bun run typecheck` 0 errors.
`bun run specs:catalog`/`specs:check` clean.

**Two findings deliberately not fixed here, and why:** a 60×20 resize (below
the spec's own documented 80×24 minimum) still shows real corruption —
correctly out of scope, since the graceful "terminal too small" fallback
this exact case needs is explicitly Phase 5's own scope
(`plan.md`'s "Add the 80×24 minimum-viewport check"), not a Phase 2
regression to patch around. A single stray border character appears on one
row of the Help overlay, likely from an emoji/symbol's terminal column width
being miscounted (📋/↳/⇄/◆) — cosmetic, doesn't corrupt surrounding rows or
cause overflow, left as a minor follow-up rather than expanding this pass's
scope.

## Phase 2 — Real Terminal Check (required before Phase 3)

Awaiting Yusuf. Please return pass/fail plus any visible issue for each item:

1. Start the TUI. Confirm Chat is the default and
   `[1 Chat] [2 Tasks] [3 Agents]` is visible.
2. Resize narrower, wider, then zoom out. Confirm no overlap/corruption and no
   first-frame corruption.
3. Switch with `1`/`2`/`3`, Tab, and Shift+Tab. Confirm each mode is genuinely
   full-screen with no bleed.
4. With a fairly full Tasks list, open Help and then Task Details. Confirm no
   overflow/corruption.
5. In the new-task composer, type text containing `1`, `2`, `3`, `a`, `r`, and
   `Tab`. Confirm they are entered as text rather than shortcuts.

**Status: confirmed by Yusuf directly, 2026-09-06 — pass on all five
items.** (Replaces a prior version of this line making the same claim
with no traceable source, introduced by the commit corrected elsewhere
in this document; re-confirmed here directly rather than left standing
on that commit's own word.) This is the real gate this section names —
Phase 3 in fact proceeded before it was recorded, per Yusuf's own
explicit direction at the time ("Just keep this verification for now and
go for phase 3"), a deliberate exception stated honestly then and
unchanged now; this entry closes the gate itself, not retroactively
the decision to proceed without it.

## Phase 3 — Real Chat viewport and threads

Most of Phase 3's scope (real scrollbox, line-break preservation,
sticky-bottom pause/resume, bounded thread navigation, new-thread
confirmation, evicted-thread state) was already delivered inside the same
commit that shipped "Phase 2" (`fd9a0d4` and its predecessor) — confirmed by
reading the real code, not assumed. See `plan.md`'s own Phase 3 section for
the full accounting of what was already there versus what this pass
actually added.

**One real bug found and fixed**, the same way Phase 2's layout bugs were —
a live PTY pass exercising the one behavior not yet exercised live:
navigating `[`/`]` from a cold start, before ever dispatching a question of
one's own. `chatConversations` (the list `[`/`]` walks) was only ever
populated as a side effect of already having a `conversationId` selected,
so a fresh session's `[`/`]` did nothing even with real conversations
sitting on the server — directly contradicting spec section 2's own
requirement. Fixed by extracting `refreshConversationList()` and polling it
independently of whether a conversation is already selected.

**Live evidence**, real Orchestrator on ports 3000–3006, real dispatched
conversations (not synthetic fixtures):
- `]` from a cold start (`chatConversationId` never set) landed on a real,
  pre-existing 8-turn conversation (`conv-367c6127-...`), confirming the fix.
- That conversation's real multi-line plan-rejection message ("=== Plan
  for: ... No actionable steps could be determined... Try describing a
  specific DevOps, testing, documentation, or security task.") rendered
  across multiple real rows with line breaks intact — not flattened to one
  line, not truncated at 300 characters.
- Scrolled up (Up ×5): the visible content genuinely changed to an earlier
  turn, confirming real scroll movement, not a no-op.
- Dispatched a real new turn to that exact conversation via `/ask` while
  scrolled up: the real `[new updates — End to follow]` banner appeared.
- Pressed `End`: view jumped to the tail and the banner cleared.
- **Not literally exercised at the full 100-turn server bound** — dispatching
  100 real turns against the live session was judged disproportionate for
  marginal additional confidence, since the scrollbox's own rendering has no
  turn-count-dependent code path (one `scrollY` box with a computed height
  budget, independent of content volume). Recorded honestly as inferred from
  architecture plus a real ~19-turn thread, not literally fixtured at 100.

`bun test` 648/648, `bun run typecheck` 0 errors, `bun run specs:catalog`/
`specs:check` clean for 47 specs. No new pure-testable surface from the
`refreshConversationList()` fix itself — it's effect/polling wiring, the
same category Phase 1's own module explicitly scopes pure logic away from.

**Exit gate met**, with the 100-turn caveat above stated plainly rather than
implied as fully covered.

**Status: Yusuf confirmed "yes" for all checklist items.** Phase 2 Real Terminal Check is passed, and authorization granted to continue to Phase 4 (Phase 3 having been completed previously).

## Phase 4 and 5 — correction, 2026-09-06

**The record below this note, as it stood after the 2026-09-05 commit
that first claimed Phase 4/5 complete, has been replaced.** That version
made unfalsifiable claims ("Submitting input and verifying the chat
interface was successful", "Yusuf verified... directly in his real
terminal") with no task IDs, no captured buffers, no specifics — a real
departure from this spec's own Phase 1–3 evidentiary standard above, and
from every other spec in this repository. It also shipped with a code
regression: the same commit truncated an existing, load-bearing
explanatory comment mid-sentence (`apps/tui/index.tsx`, the "Help is a
separate full-screen view" comment lost its final clause when the new
viewport check was inserted after it) and left three lines of raw
AI-assistant reasoning committed as code comments
(`// Wait, the spec says "..."`. `// We will render it exactly as
requested.`). Both are fixed. Neither affected runtime behavior — `bun
test` was 717/717 and `bun run typecheck` clean throughout — but the
verification claims attached to that commit could not be trusted as
written, so they are replaced here with real evidence, gathered directly
rather than asserted.

**One thing that commit's diff got right, confirmed by reading it, not
assumed wrong along with everything else**: the Chat card's own
`findWaitingPlanChild(linkedRoot, taskById)` call is safe to make
unconditionally (the function already guards `!task.isPlan` and returns
`null`), and is a genuine improvement over the prior inline
`conversationWaitingTasks.find(...)` logic it replaced.

**A real, specific risk was checked, not merely code-reviewed away.**
The new `if (width < 80 || height < 24)` viewport guard reads
`useTerminalDimensions()` — the exact hook this same file's own
eleventh-round comment (a few hundred lines below, at the root `<box>`)
documents as capable of returning `0`/stale on the very first render
frame, before the resize observer's first real measurement arrives. A
naive `<` comparison against a stale `0` would show "Terminal is too
small" on a perfectly normal terminal, on mount — the exact class of
first-frame corruption this codebase has fought before. Checked live,
not reasoned about: captured the screen at 200ms after spawn (the
earliest possible capture) through a settled boot at 120×40 — no false
positive at any point, including the very first frame.

**Live PTY evidence, real `node-pty` + `@xterm/headless` harness,
captured screen buffers checked into this directory**
(`evidence-phase4-5/`, scanned for credential leakage before commit —
clean; raw script output quoted below rather than paraphrased):

```
00-first-200ms: 120x40 tooSmall=false — earliest possible capture after spawn
01-boot-800ms:  120x40 tooSmall=false
02-boot-settled:120x40 tooSmall=false — Chat mode, real header "● live · 4/4 agents"
03-tasks-mode:  120x40 tooSmall=false — real task rows from the live stack
04-back-to-chat:120x40 tooSmall=false
05-below-minimum:60x20 tooSmall=true  — real fallback: "Terminal is too small /
                                          Minimum required: 80×24 / Current size: 60×20"
06-recovered:   120x40 tooSmall=false — fallback cleared after resizing back up
07-exact-minimum:80x24 tooSmall=false — the documented minimum itself is usable,
                                          not misclassified as below it
```

**The actual load-bearing safety property — a plan's Chat card must show
its real waiting CHILD, never the plan root — checked against a genuine
live dispatch, not a fixture.** `POST /ask {"question":"build and deploy
my bun app"}` against the real running stack produced a real plan,
`task-cce54ace-f9f1-464b-906b-e88b6eb27dd9`, which the adaptive
supervisor genuinely dispatched to four real children in sequence
(`analyze-project`, `git-status`, `scan-secrets`, `dockerize`), the last
reaching a real `input-required` state:
`child-c0e5673a-9e22-4ab5-ab7b-9d1db11fb736`. Driving a real TUI process
through the PTY harness to that exact conversation: the Chat card
rendered `⏸ devops-agent · dockerize · input-required — approval
required`, with the real target path and the real MCP tool summary.
Pressing `2` opened the Detail overlay with header line `Details —
child-c0e5673a-9e22-4ab5-ab7b-9d1db11fb736` — the real child's id,
**never** `task-cce54ace-...`, the plan root.

**The a/r-decide-from-Chat path (Phase 4 item 4), exercised live and
confirmed via the real API afterward, not just visually inferred.**
Pressing `r` once on that same conversation showed the confirm hint
`Press r again to reject child-c0e5673a-9e22-4ab5-ab7b-9d1db11fb736` —
again the exact real child id. Pressing `r` a second time rejected it;
`GET /tasks/child-c0e5673a-...` immediately afterward returned
`{"status":"failed","error":"Rejected by user"}`, and the target
`Dockerfile` was confirmed untouched (its on-disk timestamp predates
this verification pass). This is the same double-press-confirm pattern
`specs/012`/`037` already established, now proven to route to the exact
child a Chat-linked plan produces.

**Not verified**: a genuine, unassisted real-terminal session (a human
typing at a physical keyboard, not a PTY harness). Every prior
`specs/012` round that reached this exact class of claim needed one, and
this spec's own Phase 2 gate is still explicitly marked pending
above — this correction does not change that. What is verified here is
everything the PTY harness can honestly establish: the viewport guard
does not false-positive on a normal terminal, the real fallback renders
correctly at genuine below-minimum sizes and recovers, and the
plan-child safety property holds against a real live dispatch, not a
fixture. `bun test` 717/717, `bun run typecheck` 0 errors,
`bun run specs:check` clean, confirmed after these fixes, not before
them.

## Phase 5 — Real Terminal Matrix (closed 2026-09-06)

Confirmed by Yusuf directly, the same day as the Phase 2 re-confirmation
above and by the same standard — his own word taken as the source, not
itemized into a cross-examination the way the harness evidence above is,
consistent with how Phase 2's own re-confirmation was recorded.

1. **Resize/zoom in a real terminal** — pass.
2. **Layout under a full task list at a zoomed-out size** — pass.
3. **First-frame integrity** (does anything corrupt on the very first
   paint) — pass.
4. **One real controlled write, approved, confirmed matching its exact
   previewed content** — pass. Target: `C:\Users\moham\test-target-project`
   (the same scratch target this spec's own PTY evidence above already
   used) — no cleanup needed on this session's end; confirmed directly
   with Yusuf before recording this line.

This was the one item separating `verification: partial` from `verified`
after the Phase 4/5 correction above. With it closed, and Phase 2's own
gate closed in the prior worklog entry, every phase of this spec now has
either direct PTY-harness evidence or Yusuf's own direct real-terminal
confirmation — see `status`/`verification` in `spec.md`'s own frontmatter
for the resulting lifecycle state.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

See specs/069-tui-dashboard-parity-workspace/verification.md for the relocated narrative covering this checkpoint.

See specs/115-tui-navigation-redraw-and-answer-clarity/verification.md for the relocated narrative covering this checkpoint.

See specs/068-init-providers-first-flow-and-model-picker/verification.md for the relocated narrative covering this checkpoint.
