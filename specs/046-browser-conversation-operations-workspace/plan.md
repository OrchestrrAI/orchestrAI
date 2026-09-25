# Plan: Browser Conversation and Operations Workspace

> Draft implementation plan. Stop before code changes until
> `specs/046-browser-conversation-operations-workspace/spec.md` is explicitly
> approved.

## Phase 1 — Protect the existing contracts

1. Capture focused tests for the current task form, quick actions, task table,
   task modal, approval preview/raw view, agent registration/cards, Ask endpoint,
   conversation list, and one-event-stream behavior.
2. Extract only the pure view/hash/rendering seams needed to test the redesign;
   keep the Hono endpoints and server stores untouched.
3. Implement and test the bounded hash-state parser/serializer.

Exit gate: current controls and API behavior are pinned before they move.

## Phase 2 — Application shell and navigation

1. Add the persistent header, target/live indicators, and semantic Chat/Tasks/
   Agents tablist.
2. Move existing controls into the corresponding panels without changing their
   handlers.
3. Make Chat the no-hash default and support back/forward/deep links.
4. Add responsive single-column/drawer behavior without hiding safety data.

Exit gate: all three views are reachable by mouse and keyboard; existing actions
still call the same endpoints.

## Phase 3 — Conversation and execution integration

1. Render the bounded conversation list and deterministic first-question labels.
2. Link turns to real tasks through `turn.taskId`; add live execution cards.
3. Implement Chat → Task and eligible Task → Chat navigation.
4. Share the existing SSE/task cache across all panels; add scroll-away/new-
   update behavior.

Exit gate: switching views never duplicates state, requests, events, or tasks.

## Phase 4 — Approval, accessibility, and failure states

1. Reuse the exact structured approval/content-diff rendering in a linked Chat
   task card.
2. Add disabled-in-flight decision controls, durable decision state, approval
   count, and non-disruptive live-region announcements.
3. Complete semantic labels, focus order/restoration, visible focus, escaped
   untrusted text, reduced motion, disconnected/empty/stale states.
4. Run focused adversarial and compatibility tests.

Exit gate: approval is easier to find but no easier to trigger accidentally.

## Phase 5 — Real-browser verification and documentation

1. Run the full repository gates and compiled smoke test.
2. Test keyboard-only use and 1440×900, 1024×768, and 390×844 layouts.
3. Exercise maximum bounded thread/task lists, long content, SSE reconnect, and
   approval content/diff/oversize states.
4. Run a read-only question and a controlled write/reject against a disposable
   target with before/after fingerprints.
5. Record exact evidence in `verification.md`; update CLAUDE.md, README.md, and
   the worklog only for verified behavior.

Exit gate: the dashboard is usable as Chat-first and Operations-complete in a
real browser, not only present in generated HTML.

## Stop Conditions

Return for review if implementation would require a new dependency/framework,
task/protocol or tier change, client-generated action IDs, persistence/auth,
TUI edits, or removal of an existing dashboard capability.
