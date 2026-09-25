---
id: 046-browser-conversation-operations-workspace
title: Browser Conversation and Operations Workspace
area: dashboard
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-02
updated: 2026-09-03
approved_by: Yusuf
approved_on: 2026-09-02
implemented_on: 2026-09-03
amends:
  - 033-dashboard-approval-preview-card
  - 044-conversational-ask-layer
supersedes: []
superseded_by: []
related:
  - 021-ag-ui-event-protocol
  - 027-ag-ui-core-adoption
  - 040-approval-preview-content-diff
  - 047-tui-conversation-operations-navigation
---

# Spec: Browser Conversation and Operations Workspace

> Review gate: **Original scope APPROVED 2026-09-02 and IMPLEMENTED
> 2026-09-03 — that stands, unchanged.** Real-browser testing the same
> day surfaced two genuine gaps in what was actually approved, recorded
> below as **"Amendment 1 — 2026-09-03", APPROVED 2026-09-03 ("yes"),
> implementation in progress.** This repository's own governance tooling
> rejects representing "done, plus one pending addition" inside a single
> spec's lifecycle `status` (a `draft` file cannot carry approval/
> implementation metadata or completed acceptance boxes — confirmed live
> by running `bun run specs:check` against exactly that attempt), so
> Amendment 1's own approval is tracked here as prose, through the same
> conversation, rather than through `status`.
>
> Approval, original and amended, is for this browser-only interaction
> and information-architecture checkpoint. The terminal companion
> remains a separate unapproved draft in
> `specs/047-tui-conversation-operations-navigation/spec.md`.

## Purpose

Turn the Orchestrator dashboard from one long page containing registration,
task submission, chat, and a task table into a coherent workspace with three
connected views:

```text
Chat    = ask, direct, follow up, and understand
Tasks   = inspect execution, review evidence, approve, reject, and debug
Agents  = understand available capabilities and service health
```

This is navigation, not a preference, so it must be represented by views/tabs,
never by a checkbox. Chat becomes the default entry point for a normal user;
Tasks remains the complete operational source of truth. Neither replaces the
other.

## Verified Current State

- `apps/orchestrator/index.ts` renders the dashboard as one server-generated
  HTML document with inlined CSS and JavaScript. There is no browser framework,
  client router, or build step for dashboard assets.
- The page currently shows agent registration and cards, `Send Task`, an `Ask`
  card, and the full Tasks table in one vertical document. The `Ask` card was
  intentionally additive in 044, but it is now visually disconnected from the
  task row and approval it creates.
- The browser remembers only one page-local `conversationId`. It does not render
  the existing `GET /conversations` list or let a user return to another live
  in-memory thread.
- A conversation turn already carries `taskId?`, and the Orchestrator already
  exposes the task, conversation, approval, and AG-UI event data needed for a
  linked UI. No second task or conversation store is required.
- A Tier 1 question currently tells the user to find its approval in the Tasks
  table below. It does not render the linked task's state or approval preview
  inside Chat.
- Specs 033 and 040 already provide a safe approval presentation: prominent
  target, action, parameters, risks, optional content/diff, and unchanged raw
  JSON. This checkpoint must reuse that same data and must not re-derive it.
- The dashboard consumes `/events` and patches live task state. It already
  listens for 044's `TEXT_MESSAGE_END`, but the chat is refreshed as a single
  panel rather than as part of a navigable workspace.
- Conversations are deliberately in memory and bounded to 50 threads and 100
  turns per thread. This checkpoint does not add persistence.

## Amendment 1 — 2026-09-03: Multi-Step Plan Approval and Non-Flashing Task Updates

Found live by Yusuf while doing the real-browser verification pass this
spec's own "Still required for `verified`" section already called for —
not a new testing session, the same one, still in progress. Both are
genuine gaps in what was actually built, confirmed against the real
code below, not assumed from behavior alone.

### Gap 1 — a plan's own child approvals never reach the chat card

`renderTaskCard()` (`apps/orchestrator/index.ts`) renders exactly one
card per turn, sourced from `taskCache[turn.taskId]` — the **root**
task `/ask` dispatched:

```js
const approval = task.status === 'input-required' && task.approval
  ? ... : ''
```

For a direct single-skill question (e.g. *"is there a test in my
application?"*), the root task **is** the one that reaches
`input-required` — this works correctly, live-confirmed by Yusuf.

For a request that resolves to `plan-task` — routed through the
adaptive supervisor by default since `specs/038` — the root task's own
`status` never becomes `input-required`; only the **children** it
dispatches one at a time (`dockerize`, `create-compose`,
`generate-readme`, …) do. `renderTaskCard()` has no path to any of
those child task IDs at all, so a chat-dispatched plan can genuinely
have a write sitting at a real, `actionId`-bound approval gate — safe,
unchanged, exactly as `specs/028`/`038` designed — while the chat view
shows only a `running` badge with no indication anything needs a
decision. The approval itself was never bypassed or weakened; it was
simply invisible from this one surface. Confirmed this is real scope,
not a bug in existing scope: this spec's own Product Interaction Model
said *"Chat renders **one** compact execution card"* — singular — and
never described a plan's own children.

**Proposed fix**: when a linked task is a plan (`task.isPlan`), the
chat card also surfaces its `planSteps`/`childTaskIds` — specifically,
whichever child (if any) is currently `input-required` gets its own
inline approval block, using the exact same `renderApprovalCard()` this
spec already uses for a single task, not a new rendering path. A plan
with no child currently waiting renders as it does today (the step-list
summary). This reuses `GET /tasks/:id`'s already-present
`planSteps`/`childTaskIds` fields — no new endpoint, no protocol change.

### Gap 2 — the Tasks table fully replaces itself on every refresh, causing visible flashing

`refreshNow()`:
```js
document.getElementById('taskRows').innerHTML = frag.rowsHtml
```
Debounced to 300ms (`scheduleRefresh()`), but a multi-step plan (the
same scenario as Gap 1) produces a burst of `STEP_STARTED`/
`STEP_FINISHED`/`TOOL_CALL_*` events well outside any single debounce
window — so the whole table body is torn down and rebuilt several times
in quick succession while a plan runs, which is what reads as
"flashing." This is a real regression against this spec's own already-
approved promise that *"AG-UI task events update the card in
place"* — the individual-row `patchStatus()` path already does that
correctly; the fragment-refresh path this falls back to for structural
changes (a row appearing/disappearing, or crossing into
`completed`/`input-required`/`failed`) does not.

**Proposed fix**: replace the full-body `innerHTML` swap with a keyed
diff against `frag.rowsHtml` — reuse existing `<tr data-task-id>` rows
in place, insert genuinely new rows, remove genuinely gone ones. No new
dependency; a small, pure, unit-testable diff function operating on two
DOM node lists keyed by `data-task-id`.

Neither fix touches the approval gate itself, `POST /ask`, task
dispatch, tier classification, or any server-side protocol — both are
presentation-layer fixes to data the browser already receives.

## Research Basis — Principles, Not Product Copying

The following sources were reviewed on 2026-09-02. They inform interaction
principles only. OrchestrAI keeps its own visual language, agent model, task
protocol, approval policy, and local-first constraints.

- [OpenAI's Codex app introduction](https://openai.com/index/introducing-the-codex-app/)
  describes agent work as separate threads and places change review in the
  thread. Principle adopted: preserve conversational context while making real
  work inspectable. Not copied: worktrees, cloud state, or Codex's layout.
- [GitHub's agent-session guidance](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)
  separates session lists from detailed logs and supports follow-up steering.
  Principle adopted: progressive disclosure from a concise activity card to a
  complete execution record. Not copied: pull-request or GitHub session UI.
- [Traycer's public repository](https://github.com/traycerai/traycer) describes a
  durable task session usable through Chat or Terminal. Principle adopted: the
  same underlying work identity should survive surface changes. Not copied:
  Traycer boards, provider management, collaboration model, or terminology.
- [W3C's tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) defines
  semantic tab relationships and predictable keyboard movement. Principle
  adopted: native, accessible view navigation rather than styled generic divs.
- [W3C's alert-dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/)
  distinguishes a genuine interrupting confirmation from an ordinary status
  message. Principle adopted: approval is explicit and accessible, but the UI
  must not surprise-open a modal merely because background work reached a gate.

## Product Interaction Model

### 1. One shell, three views

The dashboard gets a persistent application shell:

```text
OrchestrAI     Chat | Tasks | Agents     project target     live status
-----------------------------------------------------------------------
                         active view
```

- `Chat`, `Tasks`, and `Agents` are real semantic tabs with corresponding
  panels. Use native buttons where possible and WAI-ARIA tab semantics where a
  custom tablist is necessary.
- `Chat` is the default when no view is encoded in the URL.
- Browser history/deep-link state uses a dependency-free hash form:
  `#chat[/<conversationId>]`, `#tasks[/<taskId>]`, or `#agents[/<agentName>]`.
  Back/forward navigation must work without a page reload.
- The global header always shows the configured target project and SSE
  connection state. A user must never approve a write without the target being
  visible both globally and in the approval card.
- View choice is client-only. It never changes routing, execution, approval,
  or server state.

### 2. Chat view — intent first

At wide desktop widths, Chat uses three regions:

```text
conversation list | conversation transcript + composer | activity summary
```

- **Conversation list:** newest-first bounded list from `GET /conversations`,
  first-question preview, last-activity time, running/approval indicator, and a
  clear `New conversation` action. No model-generated titles are introduced.
- **Transcript:** user and assistant turns, timestamps, tier/source labels, and
  linked execution cards. Raw task output is not duplicated into every chat
  bubble; it remains available through task details.
- **Composer:** one primary input, one send action, Enter to submit, visible
  disabled/sending state, and example prompts only in the empty state. Do not
  keep a second `Send Task` form inside Chat.
- **Activity summary:** online-agent count and recent/running/approval-needed
  tasks. It is supporting context, not a second full Tasks table.
- On narrow screens the conversation list and activity summary become
  user-opened drawers/sections; the transcript and composer retain priority.

Selecting an evicted or unknown conversation from a stale hash must show a
clear bounded “conversation is no longer available” state and offer `New
conversation`; it must not silently attach the message to another thread.

### 3. A task is visible inside the conversation that created it

For every turn with `taskId`, Chat renders one compact execution card based on
the real task:

- skill and assigned agent;
- state using both text and color (`queued`, `running`, `waiting for approval`,
  `completed`, `failed`, `rejected` as applicable);
- current plan/tool summary when available, without dumping audit payloads;
- elapsed/finished time when already available from real state;
- `View task details`, which switches to `#tasks/<taskId>` and opens the existing
  detail presentation.

AG-UI task events update the card in place. Switching views or conversations
must not start a second poller/event stream or create duplicate task records.
When the user scrolls away from the bottom, new output must not force-scroll
them; show a `New updates` control that returns to the latest turn.

### 4. Approval appears where attention already is, but remains one gate

When a chat-linked task reaches `input-required`, its card expands using the
existing `ApprovalPreview` fields:

- prominent target first;
- action and parameters;
- risks;
- content or line diff under spec 040's existing 64 KiB display rule;
- `Approve`, `Reject`, and `Open full details` actions.

The card calls the existing Orchestrator approve/reject endpoints. It does not
accept or construct an `actionId`; the server continues to forward its stored
one. While a decision is in flight, both buttons are disabled. The final
decision remains visible in the thread as audit context rather than making the
card disappear.

Do not automatically open a modal when background work reaches approval. Announce
the state through a polite live region and a visible global approval count.
Only a dialog the user deliberately opens may be marked modal; if so, focus is
trapped, the target/title describes the action, Escape closes without approving,
and focus returns to the invoking control.

One click on a clearly labeled `Approve` remains the existing authorization
gesture. This checkpoint does not invent a second confirmation or weaken the
server's existing action-bound approval.

### 5. Tasks view — complete operations and review

Move, do not delete, the existing operational features into Tasks:

- advanced `Send Task` form and quick actions;
- task table with existing statuses/actions and live tool-call evidence;
- filters for status and agent, plus a clear-filter action;
- task detail/approval modal with structured preview, content/diff, and raw JSON;
- parent/child plan relationships and origin markers where already available.

Opening `#tasks/<taskId>` selects the task and exposes its full details. A task
created in Chat includes a `Return to conversation` link when its conversation
is still present. A legacy/direct task with no conversation has no fake link.

### 6. Agents view — capability and health, not conversation

Move agent cards and registration into Agents:

- online/offline state and last-seen value;
- Agent Card description and advertised high-level skill IDs;
- task count/filter link for that agent;
- manual registration form clearly labeled as an advanced/local operation.

Agent descriptions and skills are rendered as untrusted text, never HTML. Agent
Card content does not become authorization, matching spec 030.

### 7. Shared language and visual hierarchy

- Use `Chat`, `Tasks`, and `Agents` consistently in browser and terminal.
- Reserve green for completed/safe success, blue for active/read-only, amber for
  waiting/approval, and red for failed/rejected. Text/icon labels are mandatory;
  color alone never carries state.
- Show human-readable short IDs by default and make full IDs copyable in detail.
- Keep the existing restrained dark developer-tool aesthetic. The generated
  concept image is inspiration only, not a pixel contract.
- Motion is limited to subtle state indication and respects
  `prefers-reduced-motion`.

## Implementation Shape

- Keep plain server-rendered HTML/CSS/JavaScript. No React/Vue/router/CSS
  framework or new build pipeline is justified for this checkpoint.
- Extract pure dashboard rendering/view-state helpers from the growing inline
  template where that is necessary for focused tests. Do not introduce a second
  copy of approval-card, task-state, or escaping rules.
- Reuse the existing endpoints and one `/events` connection. A narrowly additive
  response field is allowed only if implementation proves the existing
  `turn.taskId`, task map, and conversation endpoints cannot express a required
  link; stop for re-review before changing the task protocol.
- Bound rendered thread/task lists to the existing server limits. Do not log or
  put full task results in URL hashes, DOM data attributes, or browser storage.

## Safety, Accessibility, and Compatibility Constraints

- **Approval remains server-authoritative.** Presentation can move; action IDs,
  ownership checks, and tier classification cannot.
- **No hidden target.** Global project target plus the preview's exact target
  remain visible for every approval.
- **No model-derived status or safety labels.** Task state and tier come only
  from deterministic server data.
- **No approval from notifications or keyboard accidents.** Background events
  may announce a pending approval but never focus or activate its button.
- **Semantic navigation.** Tabs, buttons, tables, headings, focus indicators,
  labels, and live regions are keyboard- and screen-reader-operable.
- **Responsive without feature loss.** At narrow width, details move behind
  explicit controls; approve/reject and target information do not disappear.
- **Legacy APIs unchanged.** `POST /tasks`, `POST /ask`, task approval endpoints,
  Agent Cards, and AG-UI schemas retain their behavior.
- **No new dependency.** A discovered need for a framework/router/component
  library returns this spec for review.

## Scope

- Orchestrator browser dashboard markup, CSS, and client-side behavior.
- Dependency-free view/hash state and focused tests.
- Conversation list, linked task cards, cross-view links, and live updates.
- Reuse of the existing structured approval/content-diff presentation in Chat.
- Responsive and accessibility behavior.
- Dashboard-focused automated and real-browser verification.
- Documentation and worklog updates after implementation.

## Out of Scope / Non-Goals

- TUI changes; those belong only to spec 047.
- Conversation/task persistence across process restarts.
- Authentication, multiple users, remote sharing, or cloud synchronization.
- Worktrees, pull-request review, model/provider selection, boards, epics, or
  reproducing Codex/GitHub/Traycer product structures.
- A frontend framework, design system dependency, syntax highlighter, or router.
- Token-by-token provider streaming or exposing hidden model reasoning.
- Changing task routing, agent skills, Agent Cards, MCP bindings, or approval
  tier policy.
- Editing proposed file content inside an approval preview.
- Mobile-native application work. The browser must be responsive, not a new app.

## Acceptance Criteria

- [x] Yusuf explicitly approves this spec before runtime/UI implementation.
- [x] `Chat`, `Tasks`, and `Agents` are accessible top-level views; no checkbox
      controls navigation, and Chat is the no-hash default.
- [ ] Hash navigation is reversible with browser back/forward and safely handles
      unknown/evicted conversation, task, and agent IDs.
- [ ] Chat lists existing bounded conversations, creates a new thread, switches
      threads without context leakage, and clearly identifies its current thread.
- [ ] Every chat-dispatched task renders one live linked execution card sourced
      from its real task state; legacy tasks get no invented conversation.
- [ ] `View task details` opens the exact task in Tasks, and an eligible task can
      return to its source conversation.
- [ ] A chat-linked Tier 1 task renders the exact existing approval target,
      action, risks, parameters, and content/diff rules; approval/rejection uses
      the unchanged server endpoint and remains visible after the decision.
- [ ] A pending approval is announced without surprise-opening or focusing a
      modal. No keyboard path can approve merely by switching views.
- [x] The Tasks view preserves the existing Send Task, quick actions, task rows,
      live tool evidence, detail modal, approve/reject, and raw JSON behavior.
- [x] The Agents view preserves registration and renders live cards/skills as
      escaped text; clicking an agent can filter/open its tasks.
- [x] One SSE connection drives all views; repeated view switches do not create
      duplicate events, requests, task cards, or decisions.
- [ ] Transcript auto-follow pauses when the user scrolls up and exposes a clear
      path back to new updates.
- [ ] Keyboard-only and screen-reader-oriented checks cover tab navigation,
      focus restoration, live status, dialog semantics, labels, and color-
      independent states.
- [ ] Manual browser checks pass at approximately 1440×900, 1024×768, and
      390×844, including long text, 50 conversations, 30 tasks, disconnected SSE,
      an approval diff, and an oversized-content omission notice.
- [x] Existing API/approval/AG-UI tests pass unchanged; focused dashboard tests,
      `bun test`, `bun run typecheck`, `bun run specs:check`, and `bun run build`
      pass.
- [x] Documentation distinguishes implemented/automated behavior from the real-
      browser checks that remain pending.

## Amendment 2 — 2026-09-03: patchTaskRows() Threw on Almost Every Refresh

Found live by Yusuf almost immediately after Amendment 1 shipped: the
dashboard showed "Could not refresh workspace" (`refreshNow()`'s generic
catch-all toast) on almost every chat exchange, even in a fresh
Incognito window with no extensions — ruling out the browser-extension
interference initially suspected from the console screenshot he'd
shared, and pointing squarely at Amendment 1's own new code.

### Root cause

`patchTaskRows()` — the keyed-diff function Amendment 1 introduced to
fix the Tasks table's own flashing — had a stale-reference bug in its
own reordering path:

```js
let cursor = container.firstElementChild
for (const newRow of newRows) {
  ...
  if (node) {
    ...
    if (node.outerHTML !== newRow.outerHTML) {
      node.replaceWith(newRow)   // detaches `node` (== cursor, on row 1) from the DOM
      node = newRow
    }
  } else {
    node = newRow
  }
  if (node !== cursor) container.insertBefore(node, cursor)   // cursor may already be detached
  cursor = node.nextElementSibling
}
```

On the loop's first iteration, `cursor` is captured as the table's
*current* first row. Tasks are rendered newest-first
(`renderTaskRows()`'s own `Array.from(tasks.values()).reverse()`), so
the first row is always the most recently dispatched task — exactly
the one whose status/content changes right after almost every chat
exchange. When that row's content differs, `node.replaceWith(newRow)`
detaches the old row from the table — but `cursor` still holds a
reference to that same now-detached element. The very next line,
`container.insertBefore(node, cursor)`, passes that detached element as
the reference node, which is standard-DOM-illegal
(`insertBefore`'s second argument must be a current child or `null`)
and throws `NotFoundError: the node before which the new node is to be
inserted is not a child of this node`. `refreshNow()`'s try/catch
swallows it into the generic toast, hiding the real error — which is
why the console only ever showed unrelated noise.

### Fix

An already-matched row is never reordered relative to any other
matched row in the first place: task insertion order (a `Map`) never
changes once a task exists, and `renderTaskRows()` always emits the
same reversed order, so a matched row is already exactly where it
belongs among the other matched rows — `insertBefore` was only ever
needed for a genuinely new task (always the newest, so always
insertable at the current front). Removing the unconditional
`insertBefore` for matched rows removes the stale-reference path
entirely; a brand-new row still uses `cursor`, but that reference is
always freshly read from the previous iteration's real, still-attached
node, never one that iteration itself just detached.

### Verification

Automated, genuinely executed, not syntax-only: `apps/orchestrator/
ask-endpoint.test.ts`'s new "Amendment 2" suite extracts the real
`patchTaskRows()` source from the served `/dashboard` HTML and runs it
against a minimal hand-rolled DOM (`insertBefore`/`replaceWith`/
`nextElementSibling`, enforcing the same "reference must be a current
child" rule a real browser enforces) — no jsdom, matching this file's
own existing precedent. Confirmed methodologically, not just by
inspection: reverting only the fix (keeping the new tests) reproduces
the exact live error message on 3 of 4 new tests; reapplying the fix
passes all 4. `bun test` 583/583 (up from 579). `bun run typecheck` 0
errors.

**Real-browser confirmation obtained the same day**: a Playwright run
against real Chrome (isolated scratch server, no browser plugin
dependency) reproduced zero toasts across rapid dispatches and a full
dockerize-and-approve flow; Yusuf then confirmed directly on his own
machine after restarting the Orchestrator process ("ok worked fine
now") — see verification.md's Amendment 2 section for the full record.

**A second, smaller bug found in the same function while investigating,
not reported by Yusuf**: the old empty-state placeholder row ("No tasks
yet", no `data-task-id`) was never in `existingByKey` (keyed only by
`data-task-id`), so once the first real task ever arrived it was
inserted ahead of the placeholder but the placeholder itself was never
removed — a harmless but permanently stale extra row. Fixed by also
tracking any unkeyed row (excluding a client-inserted `toolcalls`
evidence row, which must never be swept up) and removing it once real
task rows exist. Two new tests (one for the removal, one proving an
evidence row survives untouched); confirmed the removal test fails
against the pre-fix code and passes against the fix. `bun test`
585/585, `bun run typecheck` 0 errors.

### Amendment 1
- [x] A chat-linked plan (`task.isPlan`) whose current child is
      `input-required` renders that child's real approval inline, using
      the unchanged `renderApprovalCard()`/approve/reject path — no new
      `actionId` source, no protocol change.
- [x] A plan with no child currently waiting still renders its step-list
      summary exactly as today.
- [x] The Tasks table updates via a keyed diff, not a full `innerHTML`
      replace — mechanism proven (real dispatch through a real
      multi-step plan; the old blanket-replace line confirmed gone).
      **Visual "no flicker" confirmation still needs a real browser** —
      not claimed as done; see Verification Results.
- [x] Neither fix changes `POST /ask`, task dispatch, tier
      classification, or any server response shape — asserted by the
      existing suite passing unchanged plus new focused tests.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check`,
      `bun run build` pass; binary size delta measured.

### Amendment 2
- [x] `patchTaskRows()` no longer throws when the newest (first) row's
      own content changes between two refreshes — the exact live-caught
      regression, reproduced verbatim against the old code and confirmed
      gone against the fixed code.
- [x] A genuinely new task is still inserted at the front; a task no
      longer present is still removed; an unmatched row is never
      replaced or moved (same node reference before and after).
- [x] Fix is a pure reordering-logic change inside `patchTaskRows()` —
      no change to `POST /ask`, task dispatch, tier classification, the
      keying scheme (`data-task-id`), or any server response shape.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] Real-browser confirmation that the toast no longer appears in
      practice — both a same-day Playwright-against-real-Chrome run
      (6 rapid dispatches, a real dockerize-and-approve flow) and
      Yusuf's own real-machine confirmation after restarting the
      Orchestrator process ("ok worked fine now"). See verification.md.

## Verification Plan

- **Pure tests:** hash parser/serializer; selected-view fallback; unknown IDs;
  thread ordering; task/conversation link selection; escaped untrusted text.
- **In-process dashboard tests:** required landmarks/tab semantics, one composer
  in Chat, old controls present in their new views, structured approval fields,
  reduced-motion rule, and no duplicate DOM IDs.
- **API/event tests:** one conversation/task identity across view switches; task
  state patches the linked card; approval decision changes both card and Tasks
  row without changing the underlying preview/result.
- **Adversarial safety tests:** malicious Agent Card/turn text stays escaped;
  stale task links fail clearly; double-click while an approval request is in
  flight sends at most one effective decision; no actionId is client-generated.
- **Real browser:** keyboard-only navigation and focus; responsive widths listed
  above; back/forward; scroll-away/new-update behavior; SSE reconnect; complete
  read-only question and controlled write/reject with target fingerprinting.
- **Repository gates:** full test suite, typecheck, spec governance, build,
  compiled smoke, and `git diff --check`.

## Approval Requested

**Original scope (already approved 2026-09-02, already implemented
2026-09-03 — not being re-requested):** the browser workspace described
above: three connected views, Chat-default navigation, conversation
switching, task links/cards, accessible inline approval presentation
using existing server data, responsive behavior, focused
extraction/tests, and documentation.

**Amendment 1 (2026-09-03, already approved with Yusuf's "yes"):**
surfacing a plan's own currently-waiting child approval inline in its
chat card, and replacing the Tasks table's full-`innerHTML` refresh
with a keyed diff — both described in "Amendment 1" above, both
presentation-only fixes to data the browser already receives, neither
touching the approval gate, task dispatch, or any server protocol.

**Amendment 2 (2026-09-03, a same-day bug fix in Amendment 1's own new
code, applied while diagnosing Yusuf's live "Could not refresh
workspace" report — not new scope, correcting a regression in work
already approved above):** the stale-reference fix to `patchTaskRows()`
described in "Amendment 2" above. Presented here for the record, not
as a pending approval request.

Neither the original scope nor either amendment authorizes spec 047's
TUI work, a framework or dependency, persistence, auth, protocol/
routing/tier changes, hidden reasoning, or imitation of any researched
product.
