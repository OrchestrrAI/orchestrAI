# Verification: Browser Conversation and Operations Workspace

Date: 2026-09-03

Result: **partial**. The implementation, generated browser program, API flow,
and repository gates pass. A real browser backend was unavailable in this
session, so visual and interactive browser claims remain unverified rather than
being inferred from HTML.

## Verified implementation

- `GET /dashboard` renders one Chat-default application shell with semantic
  `Chat`, `Tasks`, and `Agents` tabs/panels, no navigation checkbox, one Ask
  composer, and the existing advanced task and agent controls in their own
  views.
- Hash helpers safely parse/serialize `#chat`, `#tasks`, and `#agents` IDs,
  encode path characters, and fall back to Chat for malformed/unknown input.
- The bounded conversation summary now includes a maximum-120-character first
  question preview and a deterministic representative task status without full
  turn history.
- A dispatched `/ask` attaches the real task ID to its originating user turn
  immediately. The eventual assistant turn may carry the same ID; the browser
  deduplicates by task ID, so pending/running/approval state has one card.
- Task cards, the Tasks table, activity summary, agent filters, task details,
  and conversation return links all project the existing task/conversation
  stores. No new task store, polling loop, event connection, or action ID is
  introduced.
- Inline and modal approval controls call the unchanged approve/reject routes,
  disable duplicate decisions in flight, and reuse the existing structured
  preview/content-diff renderer. Background state never auto-opens a modal.
- Agent Card names, descriptions, URLs, and skills are escaped before server
  rendering. Focus visibility, tab keyboard handling, modal Escape/focus trap,
  polite live regions, mobile conversation/activity controls, responsive
  breakpoints, and reduced-motion CSS are present and covered structurally.
- Generated inline JavaScript was extracted from the real `/dashboard` response
  and compiled with `new Function(...)`: syntax valid.

## Automated evidence

- Focused suite: `bun test apps/orchestrator/ask-endpoint.test.ts` — **28 pass,
  0 fail**.
- Full suite: `bun test` — **571 pass, 0 fail**, 1,148 expectations across 47
  files.
- TypeScript: `bun run typecheck` — **0 errors**.
- Spec governance: `bun run specs:check` — **47 specs valid**.
- Standalone build: `bun run build` — **success**, 1,423 modules bundled into
  `dist/bin/orchestrai.exe` (141.0 MB); compiled `--help` smoke passed without
  starting services.
- Generated dashboard: no duplicate static DOM IDs; exactly one
  `new EventSource('/events')`; untrusted Agent Card payloads remain escaped.
- The direct `POST /tasks` response shape and all existing approval/AG-UI tests
  remain green.

## Isolated live-HTTP evidence

The current app was served from the edited source on port 3010, leaving Yusuf's
older processes on ports 3000–3006 untouched. A real request completed:

```text
question:          what agents are online?
tier:              0
requiresApproval:  false
conversation list: 1
stored turns:      2
answer:             No agents are online right now.
```

This proves the implemented server page and conversation endpoints start and
operate together; it is not evidence of browser layout or keyboard behavior.

## Still required for `verified`

- Run the real page at approximately 1440×900, 1024×768, and 390×844.
- Exercise mouse and keyboard tab switching, browser back/forward, stale hashes,
  dialog focus restoration/trapping, mobile conversation/activity controls,
  and scroll-away/new-update behavior.
- Exercise a live read-only agent task and a controlled write task through
  `input-required`, inspect the exact target/diff, then Reject and fingerprint
  the target to prove it remained unchanged.
- Visually exercise long content, 50 conversations, 30 tasks, SSE disconnect/
  reconnect, and the 64 KiB approval-preview omission state.

The in-app browser runtime returned no available browser backend during this
session. No unrelated browser tool or source-only claim was substituted.

## Amendment 1 (2026-09-03)

Both gaps were found by Yusuf live-testing the exact scenario above with a
real Gemini deployment: a plan-shaped chat request whose child dispatches
included write-capable steps.

### Fix 1 — a plan's waiting child's approval, surfaced in its chat card

**Automated, real behavioral proof, not string-presence checks.** The real
`findWaitingPlanChild()`/`renderTaskCard()` functions were extracted from
the actual `/dashboard` response and executed via `new Function(...)`
against fake task data (no jsdom — `escapeChat()`'s one DOM dependency was
given a minimal real-behavior stub; every other function in the chain is
genuinely pure): `apps/orchestrator/ask-endpoint.test.ts`, 6 new tests —
finds the one real `input-required` child among completed/pending
siblings; returns `null` for a non-plan task and for a plan with no
waiting child; a plan with no waiting child still renders its plain
step-list summary with no approval block; a plan **with** a waiting child
renders that child's real target/actionId, and — the load-bearing safety
assertion — the Approve/Reject buttons carry the **child's** id
(`data-decision-task="child-2"`), never the parent plan's; a
directly-dispatched (non-plan) task's own approval is unaffected.

**Live, real machine, real running agents, a genuinely dispatched
multi-step plan** — not simulated. An isolated scratch Orchestrator
instance was run on port 3010 (temporary source edit, reverted and
confirmed via `git diff` immediately after, never committed) against
Yusuf's own already-running `devops-agent`/`testing-agent`, leaving his
live session on ports 3000–3006 completely untouched throughout
(`netstat` confirmed unchanged process/port count before and after).
`POST /ask {"question": "build and deploy my bun app"}` genuinely
dispatched a 4-step plan through Planning's deterministic path; its
`run-tests` step reached a real `input-required` with a real `actionId`
while the plan's own root task already showed `completed` (the
pre-existing, unrelated `watchPlanAndDispatch()` quirk this checkpoint
does not touch). `GET /dashboard` confirmed `findWaitingPlanChild`/
`patchTaskRows` present in the real served HTML. The real child was then
rejected through the real `POST /tasks/:id/reject` using the exact
`actionId`-bound id the fix's own logic would have sourced the
button from — completing the real loop the unit tests proved in
isolation.

### Fix 2 — Tasks table keyed diff instead of full replace

**Automated**: the real `patchTaskRows()` source was extracted and
syntax-validated via `new Function(...)` (this suite has no jsdom to
execute real DOM mutation, and adding one would violate this spec's own
"no new dependency" constraint — matching the exact precedent this file's
own hash-parser test already established for pure functions, extended
here to a syntax-only check for the one function that genuinely needs a
DOM); confirmed the old `taskRows'.innerHTML = frag.rowsHtml` blanket
replace is genuinely gone from the served page; confirmed the new
function keys rows by `data-task-id`, the same attribute
`renderTaskRows()` already emits server-side, so no protocol/shape
change was needed.

**Live**: the same real multi-step plan above exercised the fragment
refresh path under real dispatch/status-change events. **Not yet
confirmed**: an actual human eye on a real browser watching for the
absence of visual flicker — the mechanism (keyed diff, unchanged nodes
untouched) is proven correct by code and tests, but "does it *look*
smooth" is inherently a visual judgment call needing the same real
browser session this spec's original scope was already waiting on.

### Verified together

`bun test` — 579 passed, 0 failed (up from 571 pre-amendment: 6 tests for
Fix 1, 3 for Fix 2). `bun run typecheck` — 0 errors. `bun run
specs:catalog` + `bun run specs:check` — clean for 47 specs. Binary size
delta measured via `wc -c`, not estimated: 147,837,952 → 147,841,536
bytes, **+3,584 bytes**, zero new dependency. Neither fix touched
`POST /ask`, task dispatch, tier classification, or any server response
shape — the full pre-existing suite passed unchanged throughout.

### Still open

- The visual "no flicker" confirmation for Fix 2 (needs a real browser).
- Everything already listed as "Still required for `verified`" above,
  from the original scope — unchanged by this amendment.

## Amendment 2 (2026-09-03)

Found by Yusuf almost immediately after Amendment 1 shipped: "Could not
refresh workspace with almost every output," reproduced even in a fresh
Incognito window with no extensions — ruling out the browser-extension
interference that a console screenshot he'd shared initially suggested,
and pointing at Amendment 1's own new `patchTaskRows()` function.

**Root cause, confirmed by code inspection against the documented DOM
`insertBefore` contract, not guessed**: the loop's `cursor` variable was
captured once per iteration and reused as `insertBefore`'s reference
node even after that same node could already have been detached by
`replaceWith()` earlier in the same iteration — which happens whenever
the table's first (newest, since tasks render newest-first) row's own
content changes between two refreshes, i.e. almost every dispatch.

**Fix**: an already-matched row is never reordered relative to other
matched rows in the first place (task insertion order — a `Map` —
never changes once a task exists, so a matched row is already exactly
where it belongs); `insertBefore` is now only ever called for a
genuinely new row, using a `cursor` reference that is always freshly
read from the previous iteration's real, still-attached node.

**Verification, genuinely executed this time, not syntax-only**: a new
`apps/orchestrator/ask-endpoint.test.ts` suite ("Amendment 2") extracts
the real `patchTaskRows()` source from the served `/dashboard` HTML and
runs it against a minimal hand-rolled DOM enforcing the same
"`insertBefore`'s reference must be a current child" rule a real
browser enforces — no jsdom, matching this file's own established
precedent for DOM-touching functions. Methodologically confirmed, not
assumed: temporarily reverting only the loop's fix (keeping the new
tests unchanged) reproduced the exact live error message
("`the node before which the new node is to be inserted is not a
child of this node`") on 3 of the 4 new tests; reapplying the fix
passed all 4. `bun test` 583/583 (up from 579, +4). `bun run
typecheck` 0 errors. `bun run specs:catalog`/`specs:check` clean.

**Real-browser confirmation, obtained the same day.** A temporary local
Playwright install (scratch-only, never added as a project dependency)
drove the real, installed system Chrome against an isolated scratch
Orchestrator process running this exact fix: 6 rapid chat dispatches
(each forcing the newest row's status through real transitions, the
exact crash pattern) produced zero toasts and zero page errors; a
second run dispatched a real `dockerize` write request end to end —
reached a genuine `input-required` approval in the chat UI, clicked the
real Approve button, and completed cleanly with the real generated
Dockerfile content rendered, zero toast.

Yusuf then reported the toast still appearing on his own machine "after
action like the approval." Root-caused as a stale process rather than a
further bug: `refreshNow()`'s `catch {}` had no error binding at all
(fixed separately, see below, to log the real error going forward), and
a Bun process holds whatever code was in memory at startup regardless
of what's since changed on disk — no hot reload. After Yusuf fully
restarted the Orchestrator process and hard-refreshed the browser, he
confirmed directly: **"ok worked fine now."** Amendment 2 is closed with
both automated (genuine DOM-execution tests), sandboxed-live (Playwright
against real Chrome), and Yusuf's own real-machine confirmation — the
first of specs 046's fixes to clear all three.

**Follow-up in the same session**: `refreshNow()`'s `catch {}` was
changed to `catch (err) { console.error('refreshNow failed:', err); ... }`
so any *future* failure in this function is diagnosable directly from
the browser console, rather than requiring the kind of live
reproduction work this investigation needed. Diagnostic-only, no
behavior change; `bun test` 583/583, `bun run typecheck` 0 errors.

**A second, smaller bug found in `patchTaskRows()` in the same
investigation, not reported by Yusuf**: the old empty-state placeholder
row ("No tasks yet", no `data-task-id`) was never tracked in
`existingByKey` (keyed only by `data-task-id`), so once the first real
task ever arrived it was inserted ahead of the placeholder but the
placeholder itself was never removed — permanently stale, harmless
otherwise. Fixed by also collecting any unkeyed row (explicitly
excluding a client-inserted `toolcalls` evidence row, which must stay
untouched) and removing it once real task rows exist. Two new tests
added: one asserting the placeholder is gone after the first real task
patches in (confirmed to fail against the pre-fix code, reproducing
`container.children.length` staying 2 instead of 1, and to pass against
the fix), one asserting a `toolcalls` row is never swept up by the same
cleanup. `bun test` 585/585 (up from 583, +2). `bun run typecheck` 0
errors.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

Clients: spec 046 (implemented, partial verification) reorganized the
Orchestrator dashboard into a Chat-default **Chat | Tasks | Agents** workspace.
The existing bounded conversations are selectable; a chat-dispatched task is
linked to its originating user turn immediately and renders once from the real
task state, including the existing structured approval/diff and unchanged
approve/reject routes. Tasks preserves advanced submission, quick actions,
filters, evidence and details; Agents preserves escaped Agent Cards and manual
registration. Dependency-free hashes carry only view/IDs, and one shared SSE
connection serves all panels. Automated and isolated live-HTTP evidence passes;
real-browser widths/history/keyboard interaction remain pending because no
browser backend was available in the implementation session.

**Amendment 1** (same day, folded into spec 046 itself rather than a new
number, at Yusuf's own request after live-testing a real Gemini-dispatched
plan) fixed two real bugs: a `plan-task`'s root task never reaches
`input-required` itself — only its dispatched children do — so
`renderTaskCard()` now finds a waiting plan child and surfaces *its*
approval, Approve/Reject buttons keyed to the child's id, never the
parent's; and the Tasks table's every debounced refresh was fully
replacing `innerHTML`, contradicting the file's own "patches in place"
comment and visibly flashing during a plan's event burst — fixed with a
`data-task-id`-keyed diff (`patchTaskRows()`) that only touches changed
rows. Both live-verified against a real dispatched plan on an isolated
scratch instance (port 3010, Yusuf's own running session on 3000-3006
untouched) reaching a genuine `input-required` child and a real reject;
9 new focused tests. The visual "no flicker" claim is mechanism-proven,
not yet eyeballed in a real browser — same open item as the rest of 046.

See specs/108-durable-audit-trail/verification.md for the relocated narrative covering this checkpoint.

See specs/069-tui-dashboard-parity-workspace/verification.md for the relocated narrative covering this checkpoint.
