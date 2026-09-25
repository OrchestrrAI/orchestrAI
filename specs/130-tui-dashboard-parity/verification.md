# Verification — 130 TUI parity with the dashboard

## Phase 1 — approvals work everywhere they're shown (2026-09-25)

### What changed
- Details accept `a`/`r`/`s` (press twice) whatever opened them, not just
  Chat. They find direct-to-agent tasks too, show the key hint and confirm
  hint for every source, and close after a decision.
- The header's approvals count uses `countWaitingApprovals()`
  (`apps/tui/tui-state.ts`): every known task (Orchestrator, direct,
  agent-reported), deduplicated by id, ignoring the agent filter, `c`
  dismissals and `h` hide-done.
- `formatApprovalRows()` labels the kind the way the dashboard does ("MCP
  tool call", "Command", "File write"), and adds an `Argv` row (a JSON
  array, so a token with spaces is unambiguous) and an `Overwrite` yes/no
  row.
- In Chat with more than one approval waiting, `a`/`r`/`s` open the
  newest one's details without arming anything, instead of refusing.
- The chat card shows the specs/097 planning-intent reminder for a
  waiting plan step, and its hint reads `[a] review & decide · [2] open
  Tasks`.
- The help line for `a / r / s` describes the new behavior.

### Pre-existing bug found and fixed on the way
Closing any full-screen view (Details, Help) back to the shell, or
switching modes, left the screen corrupted:
- The header's two lines were drawn on one row
  (`project:AC:\Users…  4 Audit ● live`, where the `A` is "OrchestrAI"
  showing through the space after `project:`).
- The chat title row disappeared, and panels shifted one column.

This is the exact corruption in Yusuf's own earlier screenshot. Esc
alone reproduced it, so it predates this spec.

- **Cause:** every top-level view returned an identical root
  `<box style={{ flexDirection: "column", padding: 1 }}>`, so React reused
  it across views, and the Details view's bordered, padded third child
  was reused as the shell's panel row with stale padding and border.
- **A forced full repaint (tried first) did not help:** the renderer was
  faithfully drawing a wrong layout, not stale pixels.
- **Fix:** each top-level view's root now has its own `key`
  (`view-shell-<mode>`, `view-detail`, `view-help`, `view-input`,
  `view-too-small`), so React builds each view fresh.

### Real-terminal check (node-pty + @xterm/headless, 140×40)
Isolated stack on ports 5000–5008 (`--only orchestrator,devops-agent`,
`ORCHESTRAI_PERSIST=0`) against `C:\Users\moham\test-target-project`, with
three waiting approvals created in one conversation: a direct
`dockerize` and the specs/120 two-branch release plan.

| Step | Result |
|---|---|
| Boot | Header `approvals: 3` |
| Open thread | Cards show `[a] review & decide · [2] open Tasks`; the plan step's card shows the planning-intent reminder |
| `a` (2 waiting in thread) | Opened the newest (`create-gitignore`) details, with `a/r/s confirm`, `Action: MCP tool call: create_gitignore` and `Overwrite: yes — replaces an existing file` |
| `r` | Details show `Press r again to reject child-…` |
| `r` | Rejected; details closed; sibling `create-ci` auto-skipped; plan failed; `approvals: 1` |
| `2` → select `dockerize` → Enter | Details opened from Tasks, with `a/r confirm` and `Overwrite: no — creates a new file` |
| `r`, `r` | Rejected from Tasks-opened details; `approvals: 0` |
| Details → Esc, Help → Esc, Chat → Tasks → Chat | Before the key fix: garbled header every time. After it: a clean two-line header, chat title and borders every time |

Every write was rejected; no Dockerfile or CI file was created in the
fixture.

### Automated
- `apps/tui/format-approval-rows.test.ts`: kind labels, an `Argv` row as
  a JSON array, and `Overwrite` yes/no (absent when unset).
- `apps/tui/tui-state.test.ts`: `countWaitingApprovals` counts each id
  once across all sources and ignores every view filter.
- `bun run typecheck` 0 errors; `bun test` (with `ORCHESTRAI_MCP_PORT=5999`,
  because the user's own stack held 3006) 1541 pass / 2 skip / 0 fail.

### Found, not fixed (outside phase 1)
- **Plan emoji width:** a Tasks row with the `📋` plan marker pushes one
  stray `│` past its border. The emoji is two cells wide in the terminal,
  but the TUI counts it as one. *(Fixed in phase 2, below.)*
- **Wrong port in `dockerize`:** "dockerize my bun app on port 4000"
  produced a preview with `port: 3000`, a DevOps parameter-extraction
  error. It matters for the demo and needs its own look.

## Phase 2 — details show the whole plan and every file (2026-09-25)

### What changed
- `TaskDetail` carries `planSteps` from `GET /tasks/:id`. Details render
  them through `formatPlanStepRows()` (`apps/tui/tui-state.ts`): one row
  per step, in order, as `N. [skill] description — status`, with a glyph
  and color per status. Descriptions are bounded to 120 characters, and
  there are at most 50 rows (the last one reads `… N more steps`). The
  live `STEP_*` rows are shown only when the server returns no steps.
- `formatApprovalRows()` renders a multi-file approval as a `NEW`/`EDIT`
  header row per file, followed by that file's own diff rows. It uses the
  same `buildContentPreview()` decision as the single-file path, through
  a shared `contentPreviewRows()` helper.
- `MAX_MULTI_FILE_DIFF_ROWS = 300` caps the diff rows across all files.
  Every file header stays. Past the cap, a final `… N more lines — v for
  raw` row appears. The rows sit inside Details' existing fixed-height
  scrollbox, so the layout doesn't grow. The "Full diffs: see the
  dashboard" line is gone.
- **Phase 1's emoji finding is fixed:** the Tasks plan marker and the two
  legend lines use `≡` (one cell) instead of `📋` (two). The live run
  showed the problem was worse than a stray `│`. The extra cell garbled
  the row's text (`Prephrv` for `Prepare`) and left junk characters on
  the same screen rows of the next view, including the Details overlay
  this phase changes.

### Real-terminal check (node-pty + @xterm/headless)
Isolated stack on ports 5000–5008 (`--only
orchestrator,devops-agent,coder-agent`, `ORCHESTRAI_PERSIST=0`) against
`C:\Users\moham\test-target-project`. Before the TUI opened, two real
waiting tasks were created: the two-step release plan (`create-ci` and
`create-gitignore`), and a routed `edit-files` proposal editing
`src/config.ts` and `src/server.ts`.

| Step | Result |
|---|---|
| Tasks (140×40) | Plan rows show `≡`, the text reads correctly, and borders line up |
| Enter on `edit-files` | `EDIT: …\src\config.ts (+1/-0)`, then `+: // reviewed for release` and context rows. No stray characters |
| Scroll down | The end of `config.ts`, then `EDIT: …\src\server.ts (+1/-0)` and its diff rows |
| Enter on the plan parent | `Plan steps:` then `⋯ 1. [create-ci] … — dispatched` and `⋯ 2. [create-gitignore] … — dispatched`, from `planSteps` (the TUI never saw these steps' live events) |
| Same at 80×24 | Everything inside the box, with the diff in the fixed scrollbox |

All three waiting approvals were then rejected. The fixture's
SHA-256 snapshot, taken before the run, still matched afterwards.

### Automated
- `apps/tui/format-approval-rows.test.ts`: each file's header is followed
  by its own diff rows; 2×200-line files are capped at 300 diff rows,
  with both headers kept and `… 100 more lines — v for raw`; no "more"
  line when everything fits; no "see the dashboard" text.
- `apps/tui/tui-state.test.ts`: `formatPlanStepRows` handles empty input,
  sorts by order, reads a missing status as `pending`, bounds the
  description, and applies the row cap with its "more" row.
- `bun run typecheck` 0 errors; `bun test` (`ORCHESTRAI_MCP_PORT=5999`)
  1546 pass / 2 skip / 0 fail.

### Found, not fixed (outside phase 2)
- **The supervisor split a two-file edit into two `edit-file` steps
  without naming the file in either.** "Edit two files in <path>: add … to
  src/config.ts, and … to src/server.ts" became two `edit-file` children,
  and both failed with "No file named". Rephrased as "one multi-file
  edit", it routed straight to `edit-files`. This is a planning-prompt
  issue (`specs/126` names one file per `write-tests` step, and
  `edit-file` needs the same).
- **The header wraps at 80 columns:** `● live · 2/2 agents` wraps to a
  second line in Details and is clipped in the shell view. This predates
  spec 130.

## Phase 3 — grouped review of a parallel-write batch (2026-09-25)

### What changed
- `g`, from Chat or from a plan (or one of its steps) in Tasks, fetches
  `GET /tasks/:parentId/pending-batch`. `resolveBatchParentId()` picks
  the plan: in Chat, the parent of the newest waiting plan step in the
  thread; in Tasks, the selected plan or the selected step's plan.
- When the server says the batch is not eligible, nothing opens and a
  status line says why. "Fewer than two write steps waiting" or "these
  steps write to the same file" is chosen from the TUI's own count
  (`countWaitingPlanChildren()`). Eligibility itself is always the
  server's `computeDisjointBatch()`.
- When eligible, a full-screen overlay opens (root key `view-batch`):
  - One bounded line per branch: decision marker, skill, agent, and every
    target (`formatBatchBranchLine()`).
  - Keys: `↑/↓` select, `a`/`r` set the decision (default approve),
    `Enter` toggles that branch's diff through `formatApprovalRows()`,
    `y` twice submits, and `Esc` closes the diff and then the overlay,
    submitting nothing.
  - The height is fixed: a title, one keys/hint row, and 12 list or diff
    rows (`BATCH_OVERLAY_ROWS`, the same height as the Details
    scrollbox).
- The submission is built by `buildBatchDecisions()`: every branch once,
  each with its own `actionId` (null if any is missing, so it is never
  sent). It goes out as one `POST /tasks/:parentId/approve-batch`, and the
  server forwards each decision to that agent's unmodified
  `/approve`/`/reject` (specs/120).
- A new `batchReview` key owner in `resolveKeyOwner()`, below `detail`
  and above `agentDetail`/`help`.
- The chat card reads "Grouped batch waiting — press g to review · [a]
  one at a time · [2] Tasks" when two or more steps of the card's plan
  are waiting. Chat's multi-waiting status message and Help name `g`.

### Found and fixed on the way
- **Chat card lines wrapped.** The card's `target:` line and phase 1's
  reminder line were bounded to `centerWidth - 4`. That counted the
  card's own border and padding but not the centre panel's, so both
  wrapped onto a second row. They are now bounded to `centerWidth - 8`.
- **Help garbled at 80×24.** The box holds exactly 16 rows of about 74
  characters. Phase 1's longer `a / r / s` line already wrapped, so the
  box overflowed, and the overflow overwrote rows (the title and the
  `v · d` row were overwritten). The blank spacer under the title went
  to the new `g` row, and both long lines were shortened to fit one row
  each. Re-checked clean at 80×24.

### Real-terminal check (node-pty + @xterm/headless)
Isolated stack on ports 5000–5008 (`--only orchestrator,devops-agent`,
`ORCHESTRAI_PERSIST=0`) against `C:\Users\moham\test-target-project`.
"Prepare this project for release - create a .gitignore and a GitHub
Actions CI workflow" was typed into the TUI's own Chat composer. The
supervisor fanned out `create-gitignore` and `create-ci` concurrently.

| Step | Result |
|---|---|
| Chat card | "Grouped batch waiting — press g to review · [a] one at a time · [2] Tasks"; after the width fix, every card line fits one row |
| `g` (140×40) | Overlay: `▶ [✓ approve] create-gitignore · devops-agent · …\.gitignore` and `[✓ approve] create-ci · devops-agent · …\.github\workflows\ci.yml` |
| `↓`, `r` | The second line becomes `[✗ reject ]`; the title reads `1 approve · 1 reject` |
| `Enter` | That branch's real preview: target, `MCP tool call: create_github_action`, `Overwrite: no`, parameters, and the file content |
| `Esc`, `Esc` | Back to Chat; "Grouped review closed — nothing submitted"; still `approvals: 2` |
| Fresh TUI with no thread open, `g` | "No plan step is waiting in this thread", and nothing opens |
| Open thread, `g`, `r` on `create-gitignore`, `y` | "Press y again to submit: 1 approve · 1 reject" |
| `y` | `approvals: 0`. The server shows `create-ci` completed and `create-gitignore` "Rejected by user"; the plan ended rejected (a rejection is terminal) |
| Tasks, the plan row, `g` | "No grouped batch: fewer than two write steps of this plan are waiting — use a/r on each"; no overlay |
| A second live batch at 80×24 and 110×30 | The overlay and the branch diff fit inside the box; `g` works on a selected step row |

`create-gitignore` was the branch rejected on purpose: approving it
would have overwritten the fixture's `.gitignore`, which has
uncommitted edits (it was also backed up first). The one file the
approval wrote, `.github/workflows/ci.yml`, was removed afterwards. The
second batch's branches were both rejected through the API. The fixture's
SHA-256 snapshot matched at the end.

### Automated
- `apps/tui/tui-state.test.ts`:
  - `resolveBatchParentId` (Chat newest-parent, Tasks plan/step, direct
    task/none/other mode → null).
  - `countWaitingPlanChildren`, `formatBatchBranchLine` (single and
    multi-file targets, missing fields).
  - `buildBatchDecisions` (own actionIds, default approve, null when an
    actionId is missing), `summarizeBatchDecisions`,
    `computeBatchListWindow`.
  - `resolveKeyOwner` precedence for `batchReview`.
- `bun run typecheck` 0 errors; `bun test` (`ORCHESTRAI_MCP_PORT=5999`)
  1555 pass / 2 skip / 0 fail.

## Phase 4 — information parity (2026-09-25)

### What changed
| Gap | Now |
|---|---|
| #14 Audit | `t` shows only the task selected in Tasks; `t` again shows everything. Each row also shows result bytes (`formatBytes`) and a `trunc` marker. |
| #11 Tasks | Keeps the last 100 tasks (`TUI_TASK_FETCH_LIMIT`, was 30); rows read `chat · …` and `child of <id> · …` (`formatTaskRowText`). `t` cycles all → waiting → running → failed → completed, shown in the title. |
| #9 Chat turns | The header line shows skill and local `HH:MM` from the server's `timestamp`. |
| #8 Conversation rail | Each row starts with a status glyph (⏸ ⋯ ✓ ✗ ·) and a relative time, e.g. `▶ ⏸ now create gitign…`. |
| #13 Agent details | `Last seen: HH:MM (at discovery) · Tasks: N`, counted over every Orchestrator task. |
| #15 Empty chat | The dashboard's three example prompts and eight quick tasks, as text. |
| #16 SSE | `RUN_FINISHED` / `RUN_ERROR` trigger the task poll and the open thread's refresh right away. |

Details on the Audit filter:
- It queries every id that task's events are recorded under
  (`auditTaskIdsFor`): the task's own id, used by the Orchestrator's A2A
  events, and `orch-<id>`, used by the agent's MCP events, since agents
  run it under that id.
- `GET /audit?task=` is exact-match. The live run confirmed a
  `git_status` event stored under `orch-task-4c4e…`, which the plain id
  alone would miss.
- Live SSE rows are filtered with `auditRowMatchesTask`.

### Real-terminal check (node-pty + @xterm/headless)
Isolated stack on ports 5000–5008 (`--only orchestrator,devops-agent`)
against `C:\Users\moham\test-target-project`. The chat items ran with
`ORCHESTRAI_PERSIST=0`. The Audit items ran with persistence on, because
`GET /audit` returns nothing without a store.

| Item | Seen |
|---|---|
| Empty chat | "Ask a question or request work…", the 3 examples, "Quick tasks:" and all 8 |
| Turn headers | `you git-status · 07:43`, `orch [read-only] git-status · 07:43` |
| Rail | `▶ ⏸ now create gitign…` and `✓ 1m what is my git…` |
| Tasks | Title `last 100`; rows `chat · what is my git status?` and `chat · create gitignore for bun` |
| `t` in Tasks | `[status: waiting — t]` shows only the waiting task; three more presses give `[status: completed — t]` with only the completed one |
| Audit, all | `Audit (142)`; rows end `· 105ms · 263B`, `· 32.4KB`, and so on |
| Audit, `t` | `Audit (1) — task 4c4e3a93 · t all`: only that task's `git_status` event; `t` again returns to everything |
| Agent details | Last seen and `Tasks: 2` on one row |
| Help at 80×24 | 16 rows, none wrapped, with the new `f · t` line |

The one write (the `.gitignore` approval from the chat run) was
rejected. The fixture's SHA-256 snapshot matched at the end.

### Automated
- `apps/tui/tui-state.test.ts` covers:
  - `formatRelativeTime`, including missing input, bad input and future
    times.
  - `formatClockTime`, `conversationStatusGlyph`, `formatBytes`.
  - `auditTaskIdsFor` / `auditRowMatchesTask`.
  - The status-filter cycle and matching, and `computeVisibleTasks` with
    a status filter. "all" and an absent filter change nothing.
  - `formatTaskRowText` / `shortTaskId`.
- `bun run typecheck` 0 errors; `bun test` (`ORCHESTRAI_MCP_PORT=5999`)
  1563 pass / 2 skip / 0 fail.

### Not seen live
- The `child of <id> · ` row text: unit-tested only. It uses the same
  render path as the `chat · ` marker, which was seen, but no plan ran in
  the phase 4 session.
- The early refresh on `RUN_FINISHED`/`RUN_ERROR`: implemented, not
  separately timed. The poll remains the source of truth either way.

### Found, not fixed
- **The chat marker only covers loaded threads.** `GET /tasks` carries no
  conversation id; the Orchestrator's `taskConversations` map is
  internal. The TUI marks tasks linked from threads it has loaded this
  session, so a fresh TUI shows no markers until a thread is opened.
  Matching the dashboard exactly needs a `conversationId` on `GET /tasks`,
  which is a server change.
- **The agent `lastSeen` field is set at discovery and never refreshed**
  (`apps/orchestrator/index.ts:738`). The dashboard labels it "last seen"
  as if it were live. The TUI says "(at discovery)".
- **At 80×24 the Audit title row is not shown.** This predates phase 4:
  the same capture with the phase 4 changes stashed shows it missing too.
- **The dashboard's own Audit filter has the same id problem.** It
  queries the exact id typed in, so a task's agent-side (`orch-…`) events
  need the prefixed id.

## Parity walk (2026-09-25)
Every row of the spec's gap table, against the TUI now:

| # | Gap | Phase | Status |
|---|---|---|---|
| 1 | Grouped batch review | 3 | Present (`g`) |
| 2 | Multi-file diffs | 2 | Present |
| 3 | a/r/s in details from any source | 1 | Present |
| 4 | Chat card with several waiting | 1 | Present (opens the newest; `g` for a batch) |
| 5 | Planning-intent reminder on the card | 1 | Present |
| 6 | Plan steps in details | 2 | Present (`planSteps`) |
| 7 | argv / overwrite / kind | 1 | Present |
| 8 | Rail status and time | 4 | Present |
| 9 | Turn time and skill | 4 | Present |
| 11 | Tasks bound, chat marker, child of, status filter | 4 | Present; the chat marker is limited to loaded threads (above) |
| 12 | Header approvals count | 1 | Present |
| 13 | Agent last-seen and task count | 4 | Present ("at discovery", above) |
| 14 | Audit task filter, bytes, truncation | 4 | Present (`t`) |
| 15 | Empty-chat examples | 4 | Present (display only) |
| 16 | SSE `RUN_*` refresh | 4 | Present (not separately timed) |

The two named out-of-scope items (registering an agent by URL, and a
"full report" toggle on every turn) remain out of scope.

## Closed by specs/139 (2026-09-25)
The two items this spec's phase 4 left unobserved were checked live under
specs/139 (see its `verification.md`):
- `child of <id> · …` Tasks rows seen at 140×40 and 80×24.
- The `RUN_FINISHED` early refresh measured at 9–103 ms over 5 runs, far
  below what a 1.5 s poll alone would give.

`verification` is now `verified`.
