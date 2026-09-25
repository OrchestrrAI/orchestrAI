# Plan: TUI Conversation and Operations Navigation

> Approved 2026-09-03, Option C: implement Phases 1-5 in one continuous pass,
> with one mandatory stop — after Phase 2's own exit gate below, before Phase 3
> starts — to hand Yusuf a short real-terminal checklist (resize/zoom, a full
> task list, first-frame integrity) and wait for his confirmation. This is
> where specs/012's historical layout regressions were actually found, and
> Phase 2 is the phase that touches that exact risk (reservedRows, box
> structure); Phases 3-5 build on top of it, so catching a Phase 2 regression
> before they land is materially cheaper than after.

## Handoff Note

This plan is written to be **self-sufficient for a different implementing
agent** (e.g. Codex) picking up from any phase boundary, not just a summary
for whoever already has this conversation's context. Every phase below names
exact files, exact function/constant names already in the codebase, and the
specific historical bug each constraint exists to prevent, with a file:line
reference where one is stable. The PTY verification recipe (used for Phase 1
and required again at Phase 5) is written out in full — install command,
script, known-harmless failure mode — so it can be reproduced from this
document alone, without needing to ask a previous session how it was done.

If you are a different agent continuing this work: read this whole file plus
`spec.md` (especially "Revisions Since Drafting — 2026-09-03") before writing
any code. Do not skip Phase 1's own verification step (below) if you are
re-deriving or re-checking it — "the tests pass" is necessary but was
deliberately not treated as sufficient; a live PTY run against the real
compiled TUI is what actually caught that the refactor was behavior-preserving,
not just type-correct.

## Phase 1 — Pin regressions and extract state machines — **COMPLETE** (commit `2c8018f`)

Delivered exactly as scoped, verified, and committed. Recorded here so a
different agent starting at Phase 2 knows what already exists and does not
re-do it.

**What was built:**

- `apps/tui/tui-state.ts` (new) — a pure, dependency-free module (no
  `@opentui/react`, no `React` import — testable with `bun:test` alone, no
  terminal). Exports:
  - `mergeTasksById`, `normalizeRemoteTasks`, `computeVisibleTasks` — the
    task merge/filter pipeline (direct submissions, Orchestrator tasks,
    remote-agent tasks, `dismissedIds`, `hideDone`).
  - `computeClampedTaskIndex`, `computeClampedAgentIndex`,
    `nextIndexOnArrowUp`, `nextIndexOnArrowDown` — selection clamping and
    follow-latest semantics.
  - `computeTaskWindow` (+ exported `HARD_TASK_ROW_CAP = 20`) — the
    row-budget arithmetic. **This is the single highest-risk function in the
    file**: specs/012's second, thirteenth, and fourteenth rounds all trace
    back to this exact arithmetic being wrong. Any Phase 2 layout change
    that touches box structure must update this function's inputs
    (`TaskWindowInput`), not re-derive the arithmetic inline elsewhere.
  - `resolveKeyOwner` (+ `KeyOwner` type, `KeyOwnerState`) — the key-input
    precedence chain: `input > chatInput > chat > detail > agentDetail >
    help > global`. Phase 2's `1`/`2`/`3` and `Tab`/`Shift+Tab` mode
    shortcuts must be inserted into this same function/precedence, not a
    second, parallel if-chain.
  - `resolveConfirmPress` (+ `CONFIRM_WINDOW_MS = 1500`, `PendingConfirm`
    type) — the `a`/`r` double-press confirmation state machine.
  - `findWaitingPlanChild` (+ `TaskRowLike` type) — spec Revision (a)'s
    plan-child resolver, mirroring
    `apps/orchestrator/index.ts`'s own `findWaitingPlanChild` (the browser
    fix). **Not yet wired into any rendering — that is Phase 4's job.**
- `apps/tui/tui-state.test.ts` (new) — 45 tests covering every export above,
  including the specific "Help open with many tasks" row-budget scenario
  Yusuf reproduced live, and the plan-child resolver's load-bearing property
  (selects the child, never the plan, never the newest non-waiting child).
- `apps/tui/index.tsx` — every inline occurrence of the logic above now
  calls the extracted function instead (imports at the top of the file from
  `./tui-state`). No behavior was intentionally changed; see Verification
  below for how "unintentional" was checked, not assumed.
- `ChatTurn` interface gained `taskId?: string`; `TaskRow` interface gained
  `childTaskIds?: string[]`. Both fields already arrive on the exact
  `GET /conversations/:id` and `GET /tasks` responses this file already
  polls — the `GET /tasks` poll casts the raw server JSON directly to
  `TaskRow[]`, so no mapping code needed to change for the field to start
  flowing through, only the type declaration was missing. **Nothing reads
  either field yet** — Phase 4 wires them in.

**Verification performed (do not re-derive from scratch — reuse this
record):**

- `bun test` — 630/630 (585 pre-existing + 45 new).
- `bun run typecheck` — 0 errors.
- `bun run specs:catalog && bun run specs:check` — clean, 47 specs.
- **Live PTY-driven proof of byte-identical behavior** — the load-bearing
  check, not the unit tests above. Full reproducible recipe in "PTY
  Verification Harness" below. Summary of what was actually done: an
  isolated scratch Orchestrator was started on port 3010 (never touching a
  real 3000-3006 session, if one is running — see the harness section for
  exactly how), the real compiled TUI was spawned under a genuine
  pseudo-terminal, and three captures were taken and compared against the
  pre-refactor captures byte-for-byte: (1) boot render — identical; (2) `?`
  opening the real Help overlay — identical; (3) `Tab` switching pane focus
  (now routed through `resolveKeyOwner`) — the `▶` marker moved from Tasks
  to Agents exactly as before.

**Exit gate met**: keys and selection have deterministic tests, and were
confirmed unchanged in the real running program, before any layout code in
Phase 2.

## PTY Verification Harness — Reproducible Recipe

Used for Phase 1's own verification above, and **required again at Phase 5**
(and optionally at Phase 2's exit gate, to supplement — never replace — the
human check). Written out completely so a different agent/session can run it
without needing to ask how it was done previously. This is a scratch tool:
`node-pty` is installed **outside the repo**, in a temp/scratch directory —
never added to `package.json`, per this spec's own "No new dependency"
constraint. It exists only for the implementing agent's own verification, the
same role a temporary local Playwright install played for spec 046's browser
verification.

### One-time setup (per session/agent)

```bash
mkdir -p /path/to/scratch/tui-check
cd /path/to/scratch/tui-check
npm init -y
npm install node-pty --no-save   # pulls a prebuilt binary on Windows; no build toolchain needed
```

### The driver script

Save as `drive-tui.js` in that same scratch directory. Adjust `REPO`,
`bunPath` (must be an **absolute** path — Windows ConPTY does not resolve a
bare command name via `PATH` the way Unix `spawn` does; find it with `where
bun` first), and the key sequence sent in `main()` for whatever is being
verified this time.

```js
const pty = require('node-pty')
const fs = require('fs')
const path = require('path')

const REPO = 'C:\\path\\to\\devops-mcp-server'   // absolute path to the repo
const OUT_DIR = __dirname
const bunPath = 'C:\\Users\\<you>\\.bun\\bin\\bun.exe'  // absolute path; `where bun` to find it

const cols = 100
const rows = 32

const term = pty.spawn(bunPath, ['run', 'apps/tui/index.tsx'], {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: REPO,
  env: {
    ...process.env,
    ORCHESTRAI_ORCHESTRATOR_URL: 'http://localhost:3010',  // the scratch Orchestrator's port
  },
})

let buffer = ''
term.onData((data) => { buffer += data })

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

function snapshot(label) {
  const clean = stripAnsi(buffer)
  fs.writeFileSync(path.join(OUT_DIR, `snap-${label}.txt`), clean)
  console.log(`--- snapshot: ${label} (${clean.length} chars clean) ---`)
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function main() {
  await wait(4000) // let it boot and do its first poll
  snapshot('01-boot')

  buffer = ''
  term.write('1')   // example: press the Chat mode key once Phase 2 adds it
  await wait(1000)
  snapshot('02-chat-mode')

  // ... send whatever keys are relevant to what you're verifying this run ...

  term.kill()
  await wait(500)
  process.exit(0)
}

main().catch((e) => { console.error('SCRIPT FAILED', e); process.exit(1) })
```

Run it: `node drive-tui.js`. Snapshots land as `snap-<label>.txt` in the
scratch directory — plain, ANSI-stripped text, so they're readable and
diffable directly.

### Running against a real, isolated Orchestrator

The TUI needs a live Orchestrator to poll. To avoid disturbing anyone's real
session on ports 3000-3006, run an isolated instance on a different port
using **the exact technique already established across specs 028/046/047's
own verification**:

1. Temporarily edit the one line `const PORT = 3000` to `const PORT = 3010`
   in `apps/tui/../orchestrator/index.ts`'s `start()` function.
2. Start it in the background: `bun run apps/orchestrator/index.ts` (from the
   repo root). Confirm with `curl http://localhost:3010/healthz`.
3. **Revert the port edit immediately** — the already-running process keeps
   3010 in memory regardless (Bun interprets TypeScript at process start;
   editing the file afterward does not affect an already-running process).
   Confirm the revert with `git diff` showing zero remaining diff on that
   line before doing anything else.
4. Point the harness at it via `ORCHESTRAI_ORCHESTRATOR_URL=http://localhost:3010`
   (already in the script above).
5. When done: find and kill only that scratch process by its PID
   (`netstat`-and-`taskkill` on Windows), and confirm via `netstat` that
   ports 3000-3006 (a real session, if one exists) were never touched.

No agent processes are required for most checks (0 agents online is a valid,
useful state to test against — empty-state rendering, disconnected behavior,
etc.). For scenarios needing a real dispatched task or plan (Phase 4's
plan-child card, Phase 5's controlled write/reject), also start the specific
real agent(s) needed the same way, or point at agents already running in a
real session — reading their `/tasks` is safe; only dispatching a **write**
task requires care about whose queue it lands in.

### Known-harmless failure mode

After `term.kill()`, `node-pty`'s own Windows ConPTY cleanup path sometimes
throws `Error: AttachConsole failed` from
`node_modules/node-pty/lib/conpty_console_list_agent.js`. This happens
**after** all snapshots have already been written — it is not a failure of
the thing being tested, just node-pty's own exit-time console handling on
Windows. Confirmed by checking the snapshot files exist and are non-empty
before treating any run as failed.

### What this proves, and what it does not

Proves genuine behavior: does a key do what it should, does the screen show
what it should, does mode-switching/selection/approval-flow work against a
real running program. Does **not** reliably prove pixel-perfect layout —
stripping ANSI cursor-positioning codes to get plain text loses some
inter-cell whitespace, so a captured buffer is honest evidence of behavior
and weak evidence of appearance. This is exactly why Phase 5 still requires
Yusuf's own real-terminal pass for the visual/layout matrix — see that
phase's own exit gate.

## Phase 2 — Three-mode shell — **IMPLEMENTED; AWAITING HUMAN GATE**

Implementation and the automated/PTY half of the exit gate completed on
2026-09-03. The first 80×24 PTY pass exposed Help overflow and a stacked
Detail/list overflow risk; both were corrected before the final pass. See
`verification.md` for the exact evidence. Per Option C, Phase 3 remains
blocked until Yusuf returns the real-terminal checklist below.

**Do not start this phase without having read Phase 1's own "What was
built" list above** — every new key/selection concern in this phase routes
through `resolveKeyOwner`/`computeTaskWindow`, not new parallel logic.

1. Add explicit mode state: `const [mode, setMode] = useState<"chat" |
   "tasks" | "agents">("chat")`, replacing today's `activePane: "agents" |
   "tasks"` (`apps/tui/index.tsx`'s own `Pane` type) and the separate
   `showChat`/`showHelp` booleans' role in deciding what's on screen. Chat is
   the default mode per spec section 1 ("Chat is the initial mode so the
   primary product action is discoverable").
2. Add the stable two-row header (project path is not currently shown in the
   TUI at all — pull it from the same source the Orchestrator dashboard uses,
   `ORCHESTRAI_PROJECT_PATH`/`process.cwd()` fallback per
   `specs/018-supervisor-project-path/spec.md`. The documented stop condition
   was reached: no response exposed it. Yusuf approved an additive optional
   `projectPath` field on the existing `GET /healthz` response on 2026-09-03;
   consume that field and render `project unavailable` for an older server
   that omits it. Do not create a new endpoint.) and the
   live/agent-count/approval-count line already computed
   (`agents.filter/length`, `visibleTasks.filter(status==="input-required").length`).
3. Extend `resolveKeyOwner`'s `KeyOwnerState`/`KeyOwner` with the mode
   dimension, OR (simpler, and closer to a pure addition) keep
   `resolveKeyOwner` exactly as-is for **overlay** precedence (it already
   correctly says "none of input/chatInput/detail/agentDetail/help is open"
   via returning `"global"`) and add a **second**, separately-tested pure
   function — e.g. `resolveModeKey(key, currentMode): Mode | null` — that
   only ever gets consulted when `resolveKeyOwner(...) === "global"`. This
   keeps the already-tested overlay precedence untouched and isolates the
   new behavior in its own small, independently testable function, matching
   Phase 1's own pattern (small pure function + its own test block in
   `tui-state.test.ts`) rather than growing one function's responsibility.
4. Implement `1`/`2`/`3` direct mode switch and `Tab`/`Shift+Tab` cyclic
   switch, both only reachable when `resolveKeyOwner(...) === "global"` (spec
   section 1: "While a composer/input is focused, printable keys and Tab
   belong to that control. Global mode shortcuts do not fire.").
5. Move today's stacked Agents+Tasks render (`apps/tui/index.tsx`'s final
   `return (...)` block, roughly its last ~220 lines) into two **separate**
   early-return blocks, following the **exact existing pattern** Help and
   Chat already use (`if (showChat) { return (...) }` /
   `if (showHelp) { return (...) }`, immediately before the final `return`).
   This is not a new technique — it is applying the pattern the file's own
   comments already call "load-bearing, not stylistic" (search
   `apps/tui/index.tsx` for that exact phrase) to Tasks and Agents too.
6. Convert Detail/AgentDetail into replacement overlays *within* the Tasks/
   Agents mode's own screen (never a third box) — they already are
   conditionally-rendered replacements of the footer region
   (`{detail ? (...) : agentDetail ? (...) : inputMode ? (...) : (...)}` in
   the current final block); moving Tasks/Agents to their own full-screen
   mode does not change this internal structure, only what wraps it.
7. **Re-derive `computeTaskWindow`'s inputs for the new one-mode-at-a-time
   layout.** This is the step most likely to reintroduce specs/012's own
   bug class if done carelessly: today's `reservedRows` accounts for
   Agents-box-height + Tasks-box-height + one overlay, compounded, because
   both boxes are always on screen together. Once Tasks is its own
   full-screen mode, Agents' own box height is **not** part of Tasks
   mode's budget at all — recompute `reservedRows`/`AGENTS_BOX_CHROME`
   usage accordingly (likely simplifying it, not complicating it, since one
   mode no longer has to share the screen with the other). Add fresh
   `tui-state.test.ts` cases for the new, mode-scoped budget **before**
   wiring it into JSX, exactly like Phase 1 did for the old combined one.

**Exit gate — do not proceed to Phase 3 without both of these:**

- Automated: full `bun test` pass, plus new tests for the mode-scoped row
  budget and `resolveModeKey`, plus a PTY harness run confirming every
  action (approve/reject, filter, detail open, agent filter→Tasks handoff)
  still targets the exact same entity as before the move (same technique as
  Phase 1's verification, extended to mode-switching key sequences).
- **Human, not substitutable**: hand Yusuf this exact checklist and record
  his verbatim response in `verification.md` under a "Phase 2 — Real
  Terminal Check" heading, mirroring the format spec 046's own
  `verification.md` already uses (see that file for the pattern — dated
  section, what was asked, what came back):
  1. Start the TUI in a real terminal. Confirm it starts in Chat mode and
     `[1 Chat] [2 Tasks] [3 Agents]` is visible in the header.
  2. Resize the terminal narrower, then wider, then zoom out (smaller font).
     Confirm no corrupted/overlapping text at any size, and no first-frame
     corruption on initial launch.
  3. Switch through all three modes with `1`/`2`/`3`, then with `Tab`/
     `Shift+Tab`. Confirm each mode is genuinely full-screen (nothing from
     another mode bleeds through).
  4. With a real, fairly full Tasks list (dispatch several real tasks first),
     open Help, then a task's Details. Confirm no overflow/corruption —
     this is the exact scenario that broke in specs/012's second and
     thirteenth rounds.
  5. Type into the new-task composer text that contains `1`, `2`, `3`, `a`,
     `r`, `Tab` characters. Confirm they're entered as text, not
     interpreted as mode/approval shortcuts.

Do **not** proceed to Phase 3 until Yusuf's response to that checklist is
recorded, whether by this session or a different one — this is the plan's
own mandatory Option C stop point, not a suggestion.

## Phase 3 — Real Chat viewport and threads — **COMPLETE** (commit `fd9a0d4` + one same-day fix below)

Items 1, 2, 4, and 5 below were already delivered as part of what the Phase
2 commit actually shipped (the concurrent implementation session merged
Phase 3's core scope into the same pass) — confirmed by reading the real
code, not assumed from the commit message: `apps/tui/index.tsx`'s Chat
render already uses a real `<scrollbox ref={chatScrollRef} ...>` with no
`.slice(-12)`/`.split("\n").join(" · ")`/`.slice(0, 300)` anywhere;
`chatFollow`/`chatNewUpdates`/`isChatAtBottom` implement sticky-bottom
pause/resume; `adjacentConversationId`/`[`/`]` implement bounded
navigation; the `c` handler already has the press-twice new-thread
confirmation plus `chatEvicted` state. `apps/tui/tui-state.test.ts` already
had a `describe("Chat thread navigation and scroll-follow state", ...)`
block covering the pure logic (`adjacentConversationId`, `isChatAtBottom`).

Item 3 (sticky-bottom pause/resume as pure functions) is satisfied by
`isChatAtBottom` already existing in `tui-state.ts` with its own tests —
no further extraction was needed.

1. ~~Replace `chatTurns.slice(-12)` with a scrollbox~~ — already done.
2. ~~Preserve line breaks~~ — already done; live-confirmed below (a real
   multi-line plan-rejection message rendered across multiple real rows).
3. ~~Extract sticky-bottom pause/resume as pure functions~~ — already
   satisfied by the existing `isChatAtBottom`.
4. ~~Bounded conversation navigation~~ — already done, but see the real bug
   found in it below.
5. ~~`c` new-thread confirmation and evicted-thread state~~ — already done.

**One real bug found and fixed the same way the Phase 2 layout bugs were**
— a live PTY pass, this time specifically exercising `[`/`]` from a fresh
session that had never dispatched its own question: `chatConversations`
(the list `[`/`]` navigate through) was only ever populated as a side
effect of `refreshChat()`, which itself only ever ran once a
`conversationId` was already known — so on a cold start, with real
conversations existing server-side, `[`/`]` did nothing at all. This
directly contradicted section 2's own "`[` and `]` move through the
bounded server conversation list." Fixed by extracting
`refreshConversationList()` and calling it independently whenever
`mode === "chat"`, regardless of whether a conversation is already
selected, firing immediately rather than waiting a full poll interval.

**Exit gate, live-verified**: navigated `]` from a cold start (no prior
`chatConversationId`) directly to a real, pre-existing 8-turn conversation
on the live Orchestrator, confirming the fix; its multi-line plan-rejection
message rendered across multiple real rows with line breaks intact, not
flattened. Scrolled up (Up arrow ×5) — confirmed the view genuinely moved
(different, earlier turn visible). Dispatched a real new turn to that exact
conversation via `/ask` while scrolled up — the real `[new updates — End to
follow]` banner appeared. Pressed `End` — view jumped to the tail and the
banner cleared. All against real Orchestrator data, not a synthetic
fixture. **Not literally fixtured at the full 100-turn bound** — dispatching
100 real turns against the live session was judged disproportionate load for
marginal additional confidence, given the scrollbox's own content handling
has no turn-count-dependent code path (verified architecture: one
`scrollY`-enabled box with a computed height budget, independent of how
many turns it holds). `bun test` 648/648, `bun run typecheck` 0 errors.

## Phase 4 — Linked tasks and exact Chat/Tasks approval

1. Wire `findWaitingPlanChild` (already written and tested in Phase 1) into
   the Chat card renderer: for a linked turn whose task `isPlan`, call
   `findWaitingPlanChild(task, taskById)` — build `taskById` from the same
   `mergedTasks`/`tasks` state already in scope, do not fetch anything new.
2. Render the bounded task card exactly as spec section 3/4 describe (3-row
   card; attention card naming the waiting step, target, and `[2] review in
   Tasks` when a plan or direct task is `input-required`). Approval wording is
   derived only from that real state, never from `/ask`'s tier or
   `requiresApproval` possibility flag; clear the running presentation when the
   linked task becomes terminal.
3. Switch Chat → Tasks by **exact task ID** — when the linked task is a
   plan, that means the **child's** ID (`findWaitingPlanChild(...).id`),
   never the plan's own ID. This is the specific property spec Revision (a)
   exists to guarantee; test it explicitly (mirror
   `apps/orchestrator/ask-endpoint.test.ts`'s own "the load-bearing safety
   assertion" test for the browser fix — Approve/Reject/selection must key
   off the child, never the parent).
4. Reuse `resolveConfirmPress`, `formatApprovalRows`, and the existing decision
   endpoints for Chat. Only when the current conversation resolves to exactly
   one waiting task may `a`/`r` open its exact preview and the repeated key send
   its decision. With zero or multiple waiting tasks, do not decide and direct
   the user to Tasks. Input continues to own all printable keys.
5. Keep `a`/`r` ×2 and `v` raw JSON in Tasks byte-for-byte compatible and ensure
   Tasks-mode selection lands on the correct task ID when arriving from Chat.

**Exit gate**: dispatch a real multi-step plan (e.g. via `POST /ask` with
"build and deploy my bun app" against a real Planning/DevOps stack — the
same phrase specs 038/044/046 already used for this exact purpose), confirm
via the PTY harness that Chat shows the correct step's attention card, direct
`a`/`r` ×2 targets that real waiting child (not the plan), `2` selects the same
child in Tasks, and the decision updates the Chat card afterward. Also fixture
zero and multiple waiting candidates and prove Chat cannot decide either case.

## Phase 5 — Layout hardening and live verification

1. Add the 80×24 minimum-viewport check and a below-minimum fallback view,
   without ever setting explicit root width/height (see
   `apps/tui/index.tsx`'s own comment on the eleventh-round regression this
   caused previously — search for "REVERTED (eleventh round's own fix
   caused a worse regression" — do not repeat that exact mistake).
2. Run full `bun test`, `bun run typecheck`, `bun run specs:check`, and
   `bun run build` (confirm the compiled binary still starts and the TUI
   still launches from it, same smoke-test level spec 046 used for the
   Orchestrator).
3. Run the PTY harness (recipe above) for the full behavioral matrix: key
   ownership across all three modes, exact plan-child selection against a
   real dispatched plan, scroll pause/resume, disconnect/reconnect
   (kill and restart the scratch Orchestrator mid-session, confirm the TUI
   recovers), and the 80×24/below-minimum states. Record every captured
   buffer as evidence in `verification.md`.
4. Hand Yusuf the remaining real-terminal matrix the harness cannot cover —
   resize/zoom, layout under full task-list bounds, first-frame integrity,
   and a controlled write reaching the full preview then rejected with an
   unchanged target fingerprint (same fingerprinting technique specs
   028/046 already used: hash or diff the target file before and after,
   confirm byte-identical). Record his result verbatim, not paraphrased.
5. Record exact terminal evidence in `verification.md`, keeping
   harness-proven and Yusuf-proven claims **visibly separate** — do not
   blend them into one undifferentiated "verified" claim; update CLAUDE.md,
   README.md, and worklog only for behavior actually confirmed by one of
   the two.
6. Only after the live matrix passes, close spec 044's superseded
   first-generation TUI verification gap and move its verification state to
   `verified`.

**Exit gate**: the real terminal remains stable under the historical
failure modes, not merely under unit rendering — this is the standard every
prior specs/012 round was eventually held to, and this checkpoint is no
exception.

## Stop Conditions

Return for review if implementation would require a new dependency, browser
or server/protocol changes, a weaker/implicit Chat confirmation, explicit root
sizing, persistence/auth, or removal of an existing TUI capability.

If a different agent than the one that wrote this plan is continuing the
work: a stop condition also includes any point where this plan's own
guidance turns out to be wrong or incomplete against the real current code —
re-verify the specific claim against the actual file (line numbers may have
shifted) rather than either blindly following stale guidance or silently
reinterpreting the spec's intent. When in doubt, that is itself a reason to
return for review rather than guess.
