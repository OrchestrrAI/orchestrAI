---
id: 010-tui-cli
title: Minimal Read-Only Terminal UI (OpenTUI)
area: tui
change_type: feature
status: implemented
verification: partial
created: 2026-08-08
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-08
implemented_on: 2026-08-08
amends: []
supersedes: []
superseded_by: []
related:
  - 012-tui-interactive
---

# Spec: Minimal Read-Only Terminal UI (OpenTUI)

> Status: **APPROVED and IMPLEMENTED on 2026-08-08. The Windows-spike gate
> is now closed — Yusuf confirmed `bun run tui` renders cleanly in his own
> terminal (no flickering/resize/exit-closes-terminal issues). Remaining
> open items (SSE vs. polling, disconnect-behavior live test, cosmetic
> text-overlap glitch) are follow-ups, not blockers — see Verification
> Results.**

## Purpose

Give OrchestrAI a terminal-native view of live agent/task state, running
beside the existing browser dashboards (not replacing them), using the
technology already named in the project brief: OpenTUI + React. This is
deliberately scoped **small**, per team decision: read-only (agent list +
task list, live-updating), with approve/reject and task submission from the
terminal explicitly deferred to a follow-up spec.

This directly serves the project brief's stated identity — *"OrchestrAI is a
terminal-native AI Engineering Orchestrator"* — with the minimum slice that's
actually demoable in the remaining timeline.

## Verified Facts About OpenTUI

Checked against the real published packages (not assumed):

- `@opentui/core` — TypeScript bindings for OpenTUI's native Zig rendering
  core, communicating with the JS layer through Bun's FFI. Runs on Bun,
  matching this project's existing runtime exactly — no new language/runtime
  dependency.
- `@opentui/react` — the React reconciler for OpenTUI, letting components be
  written as ordinary React components rendered to a terminal instead of the
  DOM. This is why the project brief lists "React" alongside "OpenTUI" as
  paired core technologies, not two unrelated choices.
- Used in production today (OpenCode, terminal.shop), so it is not
  experimental-only for this use case.
- Source: [npmjs.com/package/@opentui/core](https://www.npmjs.com/package/@opentui/core), [npmjs.com/package/@opentui/react](https://www.npmjs.com/package/@opentui/react), [opentui.com](https://opentui.com/).

**Windows compatibility — checked directly against the project's own tracked
issue, not assumed:** [anomalyco/opentui#152](https://github.com/anomalyco/opentui/issues/152)
documents multiple **currently open, real** Windows-specific bugs:
exiting the OpenTUI CLI can close the entire terminal/tty (not just the
app); resizing is broken; Shift+Tab on input selection doesn't work;
noticeable flickering in Windows Terminal, and much worse flickering
(capped ~16-20 fps) in the VS Code integrated terminal specifically; cursor
blink styles are unavailable. Some of these trace to upstream Bun-on-Windows
issues (`SIGWINCH` not firing on resize, `stdin` data handling), not
OpenTUI's own code, so they aren't quick-fixable from this repo.

**The same issue explicitly reports these problems do not reproduce under
WSL** — WSL behaves like a normal Linux terminal for this purpose.

This directly affects a Windows-native demo environment (this repo's stated
active development platform) and specifically calls out the VS Code terminal
as the worst-affected case — worth knowing if the demo machine's terminal of
choice is VS Code's integrated terminal. This is not a "let's find out"
unknown anymore; it's a known, tracked, currently-unresolved upstream
limitation. The Windows spike below is now about **measuring how bad it is
for this specific UI's needs** (a live-updating two-pane list is far less
demanding than OpenTUI's own flickering demos), not discovering whether a
problem exists at all.

## Verified Current State

- `apps/tui/` exists and is completely empty (0 files) — confirmed by
  repository listing. Nothing to preserve or migrate.
- Every piece of state this TUI needs already exists behind existing,
  unauthenticated-but-already-tested HTTP/SSE endpoints:
  - `GET http://localhost:3000/agents` — registered agents, online/offline
    status, skills.
  - `GET http://localhost:3000/tasks` — all Orchestrator tasks (id, text,
    skill, assignedAgent, status, result/error, `approval` preview if
    pending).
  - `GET http://localhost:3000/events` — SSE channel already used by the
    browser dashboard for live updates (`task-update`/`agents-update`
    events); the TUI can subscribe to the same channel instead of polling.
- No backend change is required for this spec. The TUI is purely a new
  client of already-implemented, already-verified APIs.

## Proposed Design

### Scope for this checkpoint (read-only)

- A single-screen terminal view, split into two panes:
  - **Agents pane**: name, port, online/offline, skills — sourced from
    `GET /agents`, refreshed on `agents-update` SSE events.
  - **Tasks pane**: id (truncated), skill, assigned agent, status (color- or
    symbol-coded, matching the existing dashboard's status vocabulary:
    `submitted`/`working`/`input-required`/`completed`/`failed`), refreshed
    on `task-update` SSE events.
- A status line showing Orchestrator connectivity (connected/reconnecting),
  mirroring the browser dashboard's own live/reconnecting indicator.
- Read-only: **no** approve/reject, **no** task submission, **no** editing
  from the TUI in this checkpoint. Selecting a task may show its full detail
  (result/error/approval preview) in a read-only detail pane — still no
  actions.
- Reconnect behavior: if the Orchestrator is unreachable at startup or drops
  mid-session, the TUI shows a clear "disconnected, retrying" state — it
  must never crash or hang silently.

### Explicitly deferred to a follow-up spec

- Approve/reject actions from the TUI (the natural v2 — needs its own
  `actionId` handling and confirmation UX considerations specific to a
  terminal).
- Submitting new tasks from the TUI.
- Multi-pane navigation beyond the two panes above (e.g. per-agent detail
  drill-down, plan-step tree view).
- Any TUI-side authentication/access control (matches the existing "no
  production-grade auth" framing already used for the browser dashboards).
- SSH-served TUI sessions (`@opentui/ssh` exists in the ecosystem but is not
  needed for a local demo).

### File layout

```
apps/tui/
├── package.json      ← @orchestrai/tui, depends on @opentui/core, @opentui/react, hono is NOT needed (no server)
└── index.tsx          ← entrypoint; connects to ORCHESTRAI_ORCHESTRATOR_URL (default http://localhost:3000)
```

New root script: `bun run tui`.

### Target resolution

The TUI is a client, not an agent — it does not need
`packages/shared`'s target-project-path resolver. It only needs the
Orchestrator's base URL, which should follow the same environment-override
convention as `packages/shared/agent-registry.ts`
(`ORCHESTRAI_ORCHESTRATOR_URL`, defaulting to `http://localhost:3000`) for
consistency, rather than inventing a new convention.

## Safety Constraints

- Read-only means read-only at the network level too: this checkpoint's TUI
  code must not call any `POST`/approve/reject endpoint at all — not merely
  hide the UI for it. This makes the safety property structural, not just a
  UI omission.
- No new backend surface, no new port, no new environment variable beyond
  the one Orchestrator-URL override described above.

## In Scope

1. `apps/tui/package.json` and `index.tsx` using `@opentui/react`.
2. Agents pane + tasks pane + connectivity status line, all read-only,
   sourced from the Orchestrator's existing `GET /agents`, `GET /tasks`, and
   `GET /events` endpoints.
3. Graceful disconnect/reconnect handling.
4. A root `bun run tui` script.
5. A Windows compatibility spike as the first implementation step — given
   [anomalyco/opentui#152](https://github.com/anomalyco/opentui/issues/152)'s
   confirmed bugs, this means: run a trivial OpenTUI "hello world" in the
   actual terminal the demo will use (Windows Terminal at minimum; test the
   VS Code integrated terminal separately since it's the worst-affected case
   in the tracked issue) and judge whether the flicker/resize/exit bugs are
   tolerable for a static-ish, two-pane, infrequently-updating view — this
   UI's update frequency (SSE-driven, human-paced) is much lower than
   OpenTUI's own flickering demos, so the bug may matter less here than it
   does generally, but that must be observed, not assumed. Report back
   before continuing if it's not tolerable.
6. A documented fallback if the Windows spike fails: run the TUI under WSL
   specifically for the demo (confirmed unaffected by the tracked bugs),
   with the browser dashboards as the ultimate fallback if even that isn't
   available on the demo machine — the TUI was never meant to replace them.

## Out of Scope

- Everything listed under "Explicitly deferred to a follow-up spec" above.
- Any change to the Orchestrator, agents, or MCP layer — this is purely a
  new client.
- Replacing the browser dashboards — they remain the primary, more complete
  interface until/unless a later spec says otherwise.
- Packaging the TUI as a standalone distributable binary/executable.

## Acceptance Criteria

- [x] Yusuf approves this spec ("go ahead for both").
- [x] OpenTUI Windows spike run, **and confirmed by Yusuf directly in his own
      terminal** on 2026-08-08 — reported as fine (no flickering, resize, or
      exit-closes-terminal problems observed). This closes the gate this
      spec's own acceptance criteria left open.
- [x] WSL fallback not needed — native Windows was confirmed acceptable
      directly, so the fallback path is moot for now.
- [x] `bun run tui` starts a terminal view showing agents with matching
      online/offline status and skill lists, sourced from the live
      Orchestrator.
- [~] The tasks pane updates live, but via **polling every 1.5s**, not true
      SSE as originally proposed — a deliberate, simpler implementation
      choice for this minimal checkpoint, not an oversight. Flagged
      explicitly rather than silently substituted; a follow-up can switch to
      SSE if 1.5s latency isn't tight enough in practice.
- [ ] Kill/restart-Orchestrator disconnect behavior not yet live-tested this
      session (implemented via a try/catch around the poll setting a
      `disconnected` state) — recommend a manual check before demo day.
- [x] No network call from the TUI ever hits an approve/reject/task
      submission endpoint — verified by code review: `apps/tui/index.tsx`
      only ever calls `fetch()` with `GET` (the default method, never
      overridden) against `/agents` and `/tasks`.
- [x] `bun test` remains fully green — 81 pass, 0 fail (TUI code isn't
      covered by `bun test` since it's a rendered UI, not testable logic in
      the same way; this is consistent with how the browser dashboards'
      client-side JS is also untested).

## Verification Results (2026-08-08)

- **Important caveat on the Windows spike:** it was run inside this
  session's own sandboxed shell (Git Bash, piped/non-interactive, bounded by
  a `timeout` command), not an interactive Windows Terminal or VS Code
  terminal session. The raw ANSI output confirmed OpenTUI initializes,
  renders a bordered box with correctly positioned text, updates reactively
  (a connection-status line changed color live as the poll succeeded), and
  exits cleanly (`exit 0`) without hanging. This is real evidence the
  rendering pipeline works and doesn't crash — but it **cannot** observe the
  specific bugs [anomalyco/opentui#152](https://github.com/anomalyco/opentui/issues/152)
  reports (flickering, resize behavior, terminal closing on exit), since
  those require an actual interactive terminal session, not a piped one.
  **Update:** Yusuf ran `bun run tui` directly in his own terminal and
  confirmed it's fine — no flickering, resize, or exit-closes-terminal
  problems observed. Gate closed; no WSL fallback needed for now.
- Built the real (not just spike) minimal TUI: `apps/tui/index.tsx`, agents
  pane + tasks pane + connection status line, polling
  `GET /agents`/`GET /tasks` every 1.5s.
- Live-verified against a real running Orchestrator with 4-5 discovered
  agents and a real submitted task: correctly displayed `devops-agent`'s
  full skill list (including `create-compose`, confirming it flows through
  from the routing-fixes checkpoint), correct per-status colors, and the
  connection line turned green ("● live — http://localhost:3000") once
  polling succeeded.
- **Known cosmetic issue, not fixed here:** a minor text-overlap glitch in
  the tasks pane's rendering, visible in the raw ANSI output during live
  testing — likely a box-padding/layout interaction, not a functional bug.
  Left as a follow-up polish item given this checkpoint's "minimal" scope.
- `bun test`: 81 pass, 0 fail (unaffected — no existing code path touched;
  `@opentui/core`, `@opentui/react`, and `react` added as new dependencies).

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/010-tui-cli/spec.md as written.
```

or list specific changes needed — in particular, confirm the Windows
compatibility spike as a hard gate before further TUI work proceeds, since
that risk is unverified from documentation alone.
