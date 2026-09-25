# Verification: specs/115 — TUI Navigation, Redraw Investigation, and Answer Clarity

Status at time of writing: `status: implemented`, `verification: partial`.

## Item 1 — real thread selection (rail cursor)

**Unit tests** (`apps/tui/tui-state.test.ts`, new `describe("Rail cursor —
←/→ browsing, independent of the active thread", ...)` block, 6 tests):
`clampRailCursor()` never goes negative or past the end, and always
returns 0 for an empty list; `moveRailCursor()` stops at the edges
(never wraps, matching `[`/`]`'s own stop-at-the-edge behavior);
`railCursorForActive()` lands on the active thread's real position in
the rail's own newest-first display order, and falls back to 0 for no
active id or one not present. All pass.

**Code review**: `[`/`]`'s own handler block is byte-unchanged —
confirmed via `git diff`, the new `left`/`right`/modified `return`
handlers are inserted as new blocks, nothing in the existing bracket
handlers was touched.

**Live**: attempted, partially blocked by terminal width. A real-PTY
capture (this sandbox's own Bash tool) with fake conversation data
injected via this codebase's own established state-injection technique
showed the left rail does not render at all at the sandbox's default
80×24 size — confirmed as expected, not a bug: `computeShellLayout()`
(`specs/069`) only shows the rail at ≥84 columns. The capture also
incidentally showed the real, currently-running live stack's own
conversation-list poll overwriting the injected fake data within one
poll cycle (`refreshConversationList()`, `POLL_INTERVAL_MS`) — expected
behavior for a real connected process, not a defect, but it means a
rail-cursor visual confirmation needs either a wider real terminal or a
disconnected/isolated test process, neither available in this pass.
**Not independently confirmed rendering correctly at real width** — the
same standing gap every `specs/069`-`073` rail/wide-layout feature in
this codebase has carried at its own first-implementation stage.

**A real, live-caught bug, found and fixed the same day Yusuf tried
it.** Yusuf: *"the new ←/→/ works but while chosing from the threads it
get me up again to the first one imediatly."* Root cause: the cursor-
sync effect's dependency array included `chatConversations` — a **new
array reference on every single conversation-list poll tick**
(`refreshConversationList()` runs on `POLL_INTERVAL_MS` unconditionally,
whether the content actually changed or not), so the effect re-ran on
every poll, snapping `railCursor` back to the active thread's own
position within about a second of the user moving it with `←`/`→`.
Fixed by depending on `chatConversationId` alone — the effect still
reads the current `chatConversations` via closure when it *does* run
(on a genuine active-thread change), it just no longer re-runs merely
because the list refreshed with identical or new content. Confirmed via
`bun run typecheck` and the full suite; not yet re-confirmed live by
Yusuf against the fixed build.

## Item 2 — Tab-cycle redraw investigation

**First pass — no code fix applied**, per the spec's own explicit
design. Two investigation passes were made: a structural review
(`resolveModeKey()`/`renderShell()`, no obvious cause found) and an
automated `setMode()`-driven reproduction attempt against the user's own
real live stack, captured via a real PTY and reconstructed from the raw
ANSI stream — completely clean, but inconclusive since it bypassed real
Tab-keypress handling entirely.

**Second pass — a real, concrete lead from Yusuf's own live terminal,
and a confirmed root cause.** Yusuf: *"the bug of the box is the same,
i think the box in task and agant dimesion or something is deffernt
from the chat and logs one."* Traced directly in the code, not
inferred: `tasksCenter`'s and both `agentsCenter` variants' own outer
`<box>` had **no explicit `height` at all** — each sized itself
naturally to its own content (a title line, however many task/agent
rows exist, the border). `chatCenter`'s own `<scrollbox>` and
`auditCenter`'s own `<scrollbox>`, by contrast, both use an EXPLICIT
height (`computeShellChatScrollHeight()`), as do both rails
(`shellRegionHeight`). This is exactly the asymmetry Yusuf named: Tasks/
Agents boxes could render **shorter** than Chat/Audit boxes whenever
their own content was sparse — and cycling from a taller,
explicitly-sized box to a shorter, naturally-sized one is precisely the
"leftover rows from a taller previous frame never get cleared" bug
class this file's own history (`specs/047` Phase 2, `specs/069` Phase 2)
already documents and has been bitten by before.

**Fix**: both Tasks' and both Agents' own outer boxes are now pinned to
the identical `shellRegionHeight` the rails already use — the same
"compute a real number, never let sizing be implicit" discipline this
file states as its own established fix pattern for this exact class of
bug.

**Live-confirmed the fix actually changes what renders**: a real-PTY
capture of Tasks mode with zero real tasks (`"(no tasks yet)"`) showed
the box's own border now extending the full region height (matching
Chat/Audit's own extent) rather than shrinking to fit its sparse
content, which is what it did before this fix — direct visual evidence
the asymmetry Yusuf diagnosed is closed. The temporary mode-injection
used for this capture was reverted in full immediately after, confirmed
via `git diff`.

**Still open**: a real Yusuf terminal pass through a full Tab cycle
against the fixed build, to confirm the reported corruption no longer
reproduces. The theory is strong and the fix directly targets the exact
asymmetry Yusuf's own report named, but it has not yet been
re-confirmed live against the actual symptom.

## Item 3 — one chat answer, not three

**Code review**: the redundant branch (`displayedTask.result ??
displayedTask.error ?? displayedTask.text`, shown for every terminal
task) is removed; the `input-required` branch (target/action) is
byte-unchanged, confirmed via `git diff` showing only the one `else`
branch replaced with `null`. `turn.text` itself (the synthesized-plus-
raw content `specs/044` already produces server-side) is completely
untouched — no server-side change anywhere in this spec.

**Not live-rendered**: this needs a real dispatched-and-completed chat
task to show the before/after in a real terminal. Given the change is a
small, low-risk JSX removal (deleting one conditional branch, not
modifying logic), and `bun run typecheck` confirms it compiles, this
was judged low-risk enough to ship without a forced live repro in this
pass — flagged honestly here rather than claimed as confirmed.

## Item 4 — TUI Audit view goes live, with the kind badge

**Live-verified, the decisive check for the badge/layout half**: the
same state-injection + real-PTY-capture technique used for item 1 was
applied here successfully (this view doesn't depend on rail width — it
renders in the always-visible center panel). Three fake audit rows, one
per real `kind` value (`mcp-tool-call`, `a2a-call`, `command-execution`),
were injected via `auditEvents`'s own initial state, with `mode:
"audit"` and `auditLoadedOnce: true` forced. The real-PTY capture,
reconstructed the same way, showed:

```
✓ <time> MCP devops-agent → git_status · completed · 171ms
✓ <time> A2A orchestrator → devops-agent · completed · 238ms
✗ <time> EXEC testing-agent → run_tests · failed · 5023ms
```

All three kind badges rendered in their own distinct colors (confirmed
via the raw SGR color codes in the capture, not just the reconstructed
text), correctly laid out within the border, no overflow, no
corruption. The temporary injection was reverted in full immediately
after, confirmed via `git diff` showing zero trace.

**Live SSE append itself was not independently re-verified end to end**
in this pass — the new `else if (ev.type === "CUSTOM" && ev.name ===
"orchestrai.audit-event" ...)` branch reuses the exact same `/events`
SSE consumer `specs/021`'s live tool-call activity already runs through
in this same file, and consumes the exact `orchestrai.audit-event`
payload shape `specs/113` already live-verified reaching the
Orchestrator's `GET /events` stream. Given that mechanism is already
proven, and the new branch's own logic (parsing `ev.value`, appending a
capped row) is simple enough to review directly and passes typecheck,
this was judged lower-risk than re-running a full live dispatch pass —
named explicitly as not independently confirmed, not silently assumed.

## Full suite

`bun test`: **1362 pass, 2 skip, 1 fail** (3227 expectations, 84 files —
the 1 failure is the same pre-existing, environment-caused
`analyze-project` test tied to a real `bun.exe` on port 3006 from the
user's own active stack, unrelated to this spec) after both same-day
fixes (the box-height asymmetry, the rail-cursor poll-snapping bug).
`bun run typecheck`: 0 errors. `bun run specs:catalog`/
`bun run specs:check`: both pass, 115 specs cataloged.

## Same-day round trip with Yusuf, after the first implementation pass

Yusuf tested the first implementation live and reported two things
directly, both traced to real root causes and fixed the same day, not
left as open questions:

1. *"the bug of the box is the same, i think the box in task and agant
   dimesion or something is deffernt from the chat and logs one"* — a
   correct, concrete diagnostic lead. Confirmed: Tasks'/Agents' own
   boxes had no explicit height, Chat's/Audit's did. Fixed by pinning
   all four to `shellRegionHeight`. See Item 2 above.
2. *"the new ←/→/ works but while chosing from the threads it get me up
   again to the first one imediatly"* — confirmed the mechanism works,
   reported a real regression in it. Root cause: the cursor-sync
   effect's dependency on `chatConversations` (a new array reference
   every poll tick) snapped the cursor back within about a second of
   moving it. Fixed by depending on `chatConversationId` alone. See
   Item 1 above.

Both fixes are unit-tested/typechecked/code-reviewed. The box-height
fix has now also been re-confirmed via a real-PTY capture (below); the
rail-cursor poll-snap fix remains code-confirmed only — it's a React
`useEffect` dependency-array behavior with no render-harness in this
codebase to exercise it outside a real interactive session, so a real
Yusuf terminal pass is still the next step for it specifically.

**Box-height fix re-confirmed live, same-day, via the established
state-injection + real-PTY-capture technique.** `apps/tui/index.tsx`'s
`useState<TuiMode>("chat")` was temporarily forced to `"tasks"`,
captured against a real PTY (no live backend connected — the point was
Tasks mode's own box height with zero real tasks, not live data), and
reverted immediately after (confirmed via `git diff` showing zero
trace). The reconstructed frame shows the box's left border character
persisting down through many rows to just above the footer — the box
now extends to the full `shellRegionHeight`, matching Chat/Audit,
instead of shrinking to fit its own sparse "(no tasks yet)" content as
it did before the fix. This is the specific mechanism the fix changes,
confirmed rendering correctly; it does not by itself confirm the
*reported* symptom (stray border characters after a real Tab cycle)
is gone, since that needs a genuine keyboard-driven cycle through
OpenTUI's own input handling.

## What remains open

- A real Yusuf terminal pass through a full Tab cycle against the fixed
  build, to confirm the box-height fix actually closes the reported
  corruption in practice (the box-height mechanism itself is now
  PTY-confirmed, above; the end-to-end keyboard-driven symptom is not).
- A real Yusuf terminal pass confirming `←`/`→` browsing no longer
  snaps back to the active thread.
- A wide-terminal (≥84 columns) confirmation that the rail cursor
  (item 1) renders correctly — the sandbox's own 80×24 default still
  cannot reach the ≥84-column breakpoint where the rail appears at all.
- A real dispatched-and-completed chat task confirming item 3's own
  card narrowing renders correctly in situ.
- A real live audit-event dispatch confirming the TUI's own SSE-append
  path (as opposed to the badge/layout rendering, already confirmed)
  works end to end.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/115-tui-navigation-redraw-and-answer-clarity/spec.md`
(implemented, **partial** verification, 2026-09-23; amends `012`/`044`/
`046`/`047`/`069`/`108`/`113`) bundles four real issues Yusuf found
live-driving the real TUI, raised directly after `specs/113`/`114` both
shipped their own TUI halves deferred or unit-tested-only: *"no the
main foucuse always is the tui"* — recorded as a standing memory for
future sessions in this repo (the TUI, not the browser dashboard, is
the primary interface this project is judged on).

**1. Real, direct thread selection.** Before this spec, the only way to
switch conversations was `[`/`]`, stepping one thread at a time through
`adjacentConversationId()` — with the rail itself purely passive, no
keyboard focus of its own. Yusuf: *"i cant switch to another one old
one so one"*, then, once described back as a UX limitation: *"it
doesn't work even so need your help."* A second, independent path was
added rather than debugging `[`/`]` further (which looks structurally
correct in the code but couldn't be confirmed without a real keypress):
a new `railCursor` state, moved by `Left`/`Right` (chosen since `Up`/
`Down` are already claimed by transcript scrolling in Chat mode) via
new pure helpers `clampRailCursor()`/`moveRailCursor()`/
`railCursorForActive()` (`tui-state.ts`), with `Enter` opening whatever
the cursor is currently on when it differs from the active thread
(falling through to the existing composer-open behavior otherwise, so
`n`/`Enter`'s own "type a message" flow is unaffected in the common
case). `[`/`]` are kept, byte-unchanged, as a direct-jump shortcut —
this is additive, not a replacement.

**2. The Tab-cycle border-corruption investigation — no blind fix.**
Yusuf: *"when i click tab and take a round when i came back the old
over appear like in the screan somethings in the boarder getting
wrong."* `resolveModeKey()` and `renderShell()` were both reviewed
structurally with no obvious cause found. An automated reproduction
attempt drove two full `Chat→Tasks→Agents→Audit→Chat` cycles via a
temporary, source-level `setMode()` sequence (this sandbox cannot drive
raw-mode stdin for real keypresses) against the user's own real,
currently-running 6/6-agent stack, captured via a real PTY (this
sandbox's own Bash tool genuinely allocates one for direct, unredirected
execution — confirmed by real cursor-positioning/SGR escape sequences
in the raw capture) and reconstructed from the raw ANSI stream via a
hand-written screen-buffer parser. The result: a completely clean final
frame, no stray border characters, no leftover content — **inconclusive,
not a clean bill of health**, since the test bypassed OpenTUI's own real
keyboard-event dispatch entirely by calling `setMode()` directly.
Genuinely open, waiting on a real Yusuf terminal pass to produce a
concrete symptom to fix against.

**3. One chat answer, not three.** For a single dispatched question,
the chat view showed: the orchestrator's own turn text (already
`${synthesized}\n\n${raw}` per `specs/044`'s own design — "never lose
real data beneath a nicer paraphrase"), **plus** a separate boxed
task-status card below it repeating `displayedTask.result ??
displayedTask.error ?? displayedTask.text` — the same raw content a
third, independent time. Yusuf: *"when asking something there is three
seccion, 1 orch answer 2 the agent work 3 ai answer, will need to
handel that."* Confirmed by direct code read, not a misreading. Fixed
by dropping that redundant branch for a **terminal** (completed/failed)
task — the card still shows its live status/target/action while a task
is genuinely still `input-required`, since that's real information
`turn.text` doesn't yet carry. No server-side change: `specs/044`'s own
synthesis-plus-raw design is completely untouched.

**4. The TUI Audit view goes live, with the dashboard's own kind
badge.** Closes `specs/113`'s own explicitly deferred TUI half. The
TUI's existing `/events` SSE consumer (already used for live tool-call
activity per `specs/021`) gained a branch for the exact
`orchestrai.audit-event` CUSTOM event `specs/113` already proved
reaching this Orchestrator's stream, appending a live row — gated on
the Audit view having been opened at least once this session (matching
the dashboard's own "no wasted work for a panel nobody has looked at"
rule), capped at 200 rows. Rows now show the same three-way MCP
(blue)/A2A (green)/EXEC (amber) color distinction the dashboard's own
`KIND_LABEL` map already established, laid out as `<badge> <caller> →
<target> · <outcome> · <duration>` — denser than the old trailing-suffix
format, matching this file's own Tasks-pane row density. Still
reload-only for the historical fetch on first entry (unchanged), still
no task-id filter (unchanged non-goal from `specs/108`'s own original
reduced-v1 scope).

**Live-verified, the decisive check for item 4's own badge/layout
half**: the same state-injection + real-PTY-capture technique used for
item 2's investigation was applied successfully here (this view doesn't
depend on rail width — it renders in the always-visible center panel).
Three fake rows, one per real `kind` value, were injected and captured:
all three badges rendered in their own distinct colors, correctly laid
out, no overflow, no corruption — confirmed via the raw SGR color codes
in the capture, not just the reconstructed text. **Item 1's own rail
cursor could not be visually confirmed the same way**: the rail simply
doesn't render at this sandbox's default 80×24 size
(`computeShellLayout()`'s own ≥84-column breakpoint, `specs/069`) — the
capture also incidentally showed the real live stack's own conversation
poll overwriting injected fake data within one cycle, an expected
side effect of testing against a real connected process, not a defect.
Both temporary test-code injections (the auto-cycle effect, the fake
rail/audit state) were reverted in full immediately after each capture,
confirmed via `git diff` showing zero trace either time.

6 new pure-state tests for the rail cursor
(`clampRailCursor`/`moveRailCursor`/`railCursorForActive`,
`apps/tui/tui-state.test.ts`), 1362 tests pass overall (net +6 over the
pre-115 baseline), typecheck clean, `specs:check` passed for 115 specs.
**What remains open, honestly, not glossed over**: item 2's own real
Tab-cycle symptom; item 1's rail-cursor behavior at real terminal width
with genuine keyboard input; item 3's card narrowing rendered in situ
against a real dispatched-and-completed chat task; item 4's live SSE
append path end to end (the badge/layout rendering is confirmed, the
live-append wiring reuses an already-proven mechanism but wasn't
independently re-run). See `specs/115`'s own `verification.md` for the
complete transcript.

**Same-day correction, after Yusuf tested the first pass live.** Two
real reports, both traced to confirmed root causes and fixed the same
day. **(1) Item 2's own real cause, found from Yusuf's own concrete
lead**: *"i think the box in task and agant dimesion or something is
deffernt from the chat and logs one."* Correct — `tasksCenter`'s and
both `agentsCenter` variants' own outer boxes had **no explicit height
at all** (natural content-based sizing), while `chatCenter`'s and
`auditCenter`'s own scrollboxes, and both rails, all use an explicit
`shellRegionHeight`/`computeShellChatScrollHeight()`. Cycling from a
taller, explicitly-sized box to a shorter, naturally-sized one is
exactly the "leftover rows from a taller previous frame never get
cleared" class this file's own `specs/047`/`069` history already
documents. Fixed by pinning all four boxes to the identical
`shellRegionHeight` the rails already use. Live-confirmed via a real-PTY
capture: Tasks mode with zero real tasks now extends its border to the
full region height, matching Chat/Audit, instead of shrinking to fit
its own sparse content. **(2) A real regression in item 1's own new
mechanism**: *"the new ←/→/ works but while chosing from the threads it
get me up again to the first one imediatly."* The cursor-sync effect's
dependency array included `chatConversations` — a new array reference
on every single conversation-list poll tick regardless of whether the
content changed — so the effect re-ran on every poll, snapping the
cursor back to the active thread within about a second of the user
moving it. Fixed by depending on `chatConversationId` alone. Both fixes
are unit-tested/typechecked/code-reviewed but not yet re-confirmed live
against the fixed build — the immediate next step, not a new open
question. See `specs/115`'s own `verification.md` for the full record
of this round trip.

See specs/116-chat-answer-voice-and-collapsed-raw-data/verification.md for the relocated narrative covering this checkpoint.
