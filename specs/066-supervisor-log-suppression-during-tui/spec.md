---
id: 066-supervisor-log-suppression-during-tui
title: Suppress Raw Backend Logs Once the Auto-Launched TUI Owns the Terminal
area: runtime-supervision
change_type: fix
status: implemented
verification: partial
created: 2026-09-10
updated: 2026-09-10
approved_by: Yusuf
approved_on: 2026-09-10
implemented_on: 2026-09-10
amends:
  - 016-orchestrai-supervisor
  - 062-guided-init-tui-as-child-process
related:
  - 021-ag-ui-event-protocol
supersedes: []
superseded_by: []
---

# Spec: Suppress Raw Backend Logs Once the Auto-Launched TUI Owns the Terminal

> Review gate: **APPROVED 2026-09-10 by Yusuf.** Written from a real,
> live bug Yusuf hit and screenshotted, 2026-09-09/10: ran
> `orchestrai.exe init`, the setup
> completed, the stack started, the terminal viewer auto-launched — and
> the screen showed a real, working conversation (the TUI genuinely
> received and processed input — this was never a keyboard/input bug)
> with raw backend log lines and audit JSON bleeding through underneath
> the TUI's own rendered box, making it unreadable and appear frozen.

## Purpose

`specs/062-guided-init-tui-as-child-process/spec.md`'s own verification
record explicitly flagged this exact end-to-end path — `init` completing
→ the stack starting → the TUI auto-launching → a person actually typing
into it — as **never confirmed live**, `verification: partial`, waiting
on "Yusuf's own real-terminal session." Yusuf's screenshot is that
session, and it surfaced a real, previously-undiscovered bug: the TUI
was never actually frozen or failing to receive keyboard input — a real
multi-step dispatch ran and a real answer was returned — but the screen
became unreadable because two independent things write to the exact same
terminal at once with no coordination between them.

## Verified Current State

Read from the current code, 2026-09-10:

- `spawnService()` (`apps/supervisor/index.ts` ~line 350) pipes every
  started service's stdout/stderr through `pipePrefixed()`, whose `write`
  callback is `(line) => console.log(line)` / `(line) => console.error
  (line)` — captured once, at spawn time, and called continuously for the
  entire life of the process. This is the mechanism behind the
  documented "prefixed logs" feature (`specs/016`) and is correct and
  necessary for the plain/headless case.
- When `shouldOpenTui` is true (`process.stdout.isTTY && !headless`),
  the supervisor spawns the TUI as a genuinely separate child process
  (`specs/062`) with `stdin: "inherit", stdout: "inherit", stderr:
  "inherit"` — meaning the TUI child's stdout **is** the exact same
  terminal fd the supervisor's own `console.log`/`console.error` calls
  above are still writing to, unconditionally, for the rest of the run.
- Nothing gates or redirects the `pipePrefixed()` writers once the TUI
  spawns. Every agent's own real, ongoing activity (an MCP tool call,
  a dispatched plan step, an audit event) keeps producing raw lines
  printed directly onto the terminal the TUI's raw-mode renderer is
  simultaneously trying to own and repaint — confirmed exactly in
  Yusuf's own screenshot: `=== DevOps Checks ===`, raw audit JSON, and
  `Dispatched step 2 [git-status] → devops-agent...` all visible bleeding
  through underneath the TUI's own rendered chat box.
- **The TUI already has a proper, structured way to show this same
  information without raw console output**: `specs/021-ag-ui-event-
  protocol/spec.md` gives it a live SSE event stream, and CLAUDE.md's own
  "Live event protocol" section confirms the TUI already consumes it —
  "surfacing live calls as a zero-row inline ⚙ badge plus a full list in
  the Detail view." Nothing the raw console spam shows is otherwise
  unavailable to a TUI user; it's a redundant, uncoordinated second
  channel writing to a screen the TUI already owns.
- `--headless` (`apps/supervisor/index.ts` ~line 200) already exists and
  already avoids this entirely, since no TUI is ever spawned to share
  the terminal — confirmed as tonight's working workaround: running the
  backend with `--headless` in one window and `orchestrai tui` in a
  separate window (never sharing stdio) does not hit this bug, because
  the two processes' stdout are never the same fd.

## Proposed Behavior

1. A module-level mutable flag (or equivalent) in `apps/supervisor/
   index.ts` — call it `childLogsSuppressed` — starts `false`.
   `pipePrefixed()`'s two `write` callbacks in `spawnService()` check it
   on every call: when `true`, the line is written to a single combined
   log file instead of `console.log`/`console.error` (see point 2, not
   silently dropped); when `false` (the default, and always the case for
   `--headless`/non-TTY/CI runs), behavior is byte-identical to today.
2. **Suppressed lines are written to a file, not discarded.** A single
   file under the target project's own `.orchestrai/` directory (e.g.
   `.orchestrai/supervisor.log`), append mode, created fresh each run.
   This preserves the exact same information the console would have
   shown — someone debugging a problem while the TUI is open can `tail`
   or open that file in another window — mirroring the very workaround
   already confirmed tonight (`--headless` in one window, `tui` in
   another), just without requiring the user to know that workaround in
   advance.
3. Immediately before spawning the TUI child (`apps/supervisor/index.ts`,
   the `shouldOpenTui` branch, before `Bun.spawn(tuiCommand, ...)`),
   set `childLogsSuppressed = true`. Every already-running child's
   ongoing log stream is redirected to the file starting at that exact
   moment — no gap where a line could still hit the console after the
   TUI has already taken over the screen.
4. **No change to `--headless`, `bun run dev`, CI, or any non-TTY run.**
   `shouldOpenTui` is unconditionally `false` in all of those, so
   `childLogsSuppressed` is never set and every line still goes straight
   to `console.log`/`console.error`, byte-identical to today.

## Scope

- `apps/supervisor/index.ts`: the `childLogsSuppressed` flag,
  `pipePrefixed()`'s two call sites in `spawnService()`, the log-file
  writer, and setting the flag before the TUI spawn.
- No change to `apps/tui/index.tsx` itself — it already renders correctly
  once nothing else is writing to its terminal; this spec removes the
  interference, not the TUI's own rendering.
- No change to `specs/021`'s AG-UI event stream or the TUI's existing
  live-activity display — both already work and are the intended way to
  see this information while the TUI is open.

## Safety and Compatibility Constraints

- **No information is silently lost.** Every line that would have
  printed to the console still exists, in the log file, the moment it's
  suppressed from the terminal — this is a redirection, not a deletion.
- **Zero behavior change for every run that doesn't auto-launch a TUI**
  (`--headless`, `bun run dev`, CI, any non-TTY invocation) — confirmed
  by `shouldOpenTui`'s own existing condition, unmodified by this spec.
- **The TUI's own rendering code is untouched** — this fixes the
  interference at its source (the supervisor's own logging), not by
  teaching the TUI to defend against or filter out corrupted input.

## Out of Scope / Non-Goals

- Any change to `specs/062`'s child-process spawn mechanism itself
  (already correct — it's specifically what made this bug findable
  instead of a same-process crash).
- Piping the log file's own contents into the TUI's own display (e.g. a
  "raw log" view/tab) — a plausible, separate follow-up, not required to
  fix the corruption itself.
- Any change to `pipePrefixed()`'s line-buffering/decoding logic — only
  its two call sites' `write` callback changes.
- Rotating, capping, or cleaning up the log file across runs — out of
  scope for a first fix; a fresh file per run is enough to unblock this.

## Acceptance Criteria

- [ ] **OPEN — needs Yusuf's own terminal.** `orchestrai.exe init` (or
      `bun run orchestrai`) run to completion in a real interactive
      terminal, with the TUI auto-launching: dispatching a real
      multi-step request (e.g. "is my application ok?", the exact phrase
      from Yusuf's own screenshot) produces a clean, uncorrupted TUI
      screen throughout — no raw log/audit text visible. This sandbox
      has no interactive terminal and structurally cannot run this; the
      binary is rebuilt and ready for it (141.0 MB, 2026-09-10).
- [ ] **OPEN — same live run.** That run's suppressed log lines are all
      present, in order, in `.orchestrai/supervisor.log`.
- [x] `--headless` and `bun run dev` runs are byte-identical to before
      this spec. Verified structurally, by construction rather than by
      output diff: `childLogsSuppressed` is set at exactly one place in
      the codebase — inside `main()`'s `shouldOpenTui` branch — and
      `shouldOpenTui` is `Boolean(process.stdout.isTTY) && !headless`,
      so it is unreachable for `--headless`, for `bun run dev` (which
      never runs this file's `main()` at all), and for every non-TTY/CI
      invocation. `writeChildLog()`'s own default path is the exact
      `console.log`/`console.error` call the two `pipePrefixed()` call
      sites used before this spec, asserted directly by the first two
      tests below.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
      Verified: `bun test` — 839 pass, 0 fail, 1621 expect() calls
      across 56 files (up from the pre-066 baseline of 831/0/1613/55 —
      the delta is exactly this spec's 8 new tests, in the new
      `apps/supervisor/child-log-suppression.test.ts`); `bun run
      typecheck` — 0 errors; `bun run specs:check` — pass, 65 specs.
- [x] `CLAUDE.md` and `context/worklog.md` updated, including correcting
      `specs/062`'s own "needs Yusuf's own real-terminal session" open
      item — this is the finding from that session.

## Verification Plan

- A focused test on `pipePrefixed()`'s call sites confirming the
  suppression flag gates console output correctly (fake writable
  streams, no real process spawn needed for this part).
- A live pass in a real terminal, repeating Yusuf's own exact scenario
  (`init` → auto-launch → a real dispatched request) — the only way this
  class of bug is ever actually confirmed fixed in this codebase, per
  every prior TUI checkpoint's own verification history.

## Approval Requested

**Approved 2026-09-10 by Yusuf.** Implementation proceeds.
