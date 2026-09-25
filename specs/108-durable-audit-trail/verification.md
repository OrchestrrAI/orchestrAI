# Verification: A Durable, Queryable Audit Trail

Status: **partial**, 2026-09-22 — B6 and the dashboard's own B7 half are
fully verified. The TUI's own B7 half is implemented, unit-tested, and
got a genuine real-PTY rendering pass (see below) that caught and fixed
two real bugs; what remains unconfirmed is specifically real
*keyboard-driven* navigation into the view, not its rendering.

## Automated

- `bun test`: 1307 pass, 0 fail, 2 skip (pre-existing, unrelated) across
  83 files. `bun run typecheck`: 0 errors. `bun run specs:check`: 107
  specs.
- `packages/shared/store.test.ts`: 10 new tests for `insertAuditEvents()`
  (batched write, empty-array no-op), `listAuditEvents()` (task-id
  filter, newest-first ordering, `params_json` round-trip), and
  `pruneAuditEvents()` (age cap, row-count cap).
- `packages/shared/audit.test.ts`: 9 new tests. `whitelistAuditParams()`
  — the real safety mechanism — checked directly: a `run_command`-shaped
  `argv` array dropped entirely (and confirmed absent from the
  serialized output, not just the object's own key); real file paths
  (strings) dropped, booleans/numbers survive; real file content (a
  string) dropped; nested objects/arrays dropped wholesale, never
  partially included; a stable hash of the full params always present,
  correlating identical (undisclosed) params without ever storing them.
  `emitAuditEvent()`'s own batched sink tested end to end against a real
  scratch-directory store: an event is buffered then flushed on
  shutdown and readable back; the size threshold (20) auto-flushes
  before any explicit call; `ORCHESTRAI_PERSIST=0` never throws and
  buffers nothing durably.
- `apps/orchestrator/audit-endpoint.test.ts` (new, 4 tests): `GET /audit`
  with no store returns an empty list, never an error; real events
  written directly to the store come back newest-first; `?task=<id>`
  filters correctly; a `run_command`-shaped event's stored params
  contain no argv, confirmed through the real endpoint end to end, not
  just the whitelist function in isolation.
- `apps/orchestrator/dashboard-audit-tab.test.ts` (new, 2 tests): the
  real generated `/dashboard` HTML contains the Audit tab, its panel,
  the task-id filter input, the `loadAuditEvents()` function, the real
  `/audit` fetch call, and the updated 4-entry `VIEW_NAMES` array
  (confirming hash routing and arrow-key tab navigation both reach it
  generically); a second test confirms the Audit panel's own markup
  contains no POST/approve/reject call anywhere — genuinely read-only.
- `apps/tui/tui-state.test.ts`: `resolveModeKey()`'s existing tests
  updated for the real, expected behavior change — Tab now cycles
  through 4 modes instead of 3 (Agents no longer wraps directly to
  Chat; it now reaches Audit first), the same class of test update this
  codebase's own precedent already established when a new table/agent/
  mode joins a shared cycle (e.g. specs/082's six `init-form-state.test.ts`
  updates for the 5th agent).

## Real bugs found and fixed via a genuine real-PTY smoke pass

**Pass 1 — the initial (Chat) frame.** A one-shot real-PTY capture of
the TUI's default startup frame (`bun run apps/tui/index.tsx` — this
environment's own Bash tool genuinely allocates a TTY for stdout, even
though stdin isn't one) rendered cleanly at 80×24 — the new `4 Audit`
header label sits at columns 2-53, comfortably inside the 80-column
bound, with no wrap or corruption of the header row (the exact failure
class this file's own 16+ rounds of terminal-overflow history are
about).

Attempting to then drive the TUI interactively from that same pass —
piping `"4"` into stdin to switch to Audit mode — did not work: piped
stdin does not replicate a real PTY's raw-mode byte stream, so
OpenTUI's own keypress handling never received it.

**Pass 2 — the Audit view's own content, via the established
state-injection technique.** Pointed out directly: this repo's own
`specs/069`-`073` already solved exactly this class of problem by
temporarily forcing a component's initial state in source, capturing a
real render, then reverting — never claiming this substitutes for real
keystrokes, but proving the *rendering* is correct once that state is
reached by any means. Applied here: `useState<TuiMode>("chat")`
temporarily changed to `useState<TuiMode>("audit")`, a real one-shot
capture taken, then reverted (confirmed via `git diff` showing zero
trace of the change afterward).

That capture showed the real idle → loading → result lifecycle,
because the Audit view's own `useEffect` auto-loads on first entry and
the real fetch against no running Orchestrator genuinely failed and
resolved through all three states in one process run:
1. `"Not loaded yet — press r to load."` — the true initial render.
2. `"Loading…"` — the auto-load effect firing.
3. The failed-fetch resolution — and here a **second real bug** was
   caught: the content area rendered the exact same `"No audit events
   recorded."` text a genuine empty-but-successful query would show,
   while the footer separately said `"Error loading audit trail: Unable
   to connect..."` — an honestly contradictory pair a real user would
   see side by side. Fixed with a new `auditLoadFailed` flag,
   distinguishing "queried successfully, zero rows" from "the query
   itself failed" — now rendering `"Could not load — see status line
   below. Press r to retry."` instead. Re-captured after the fix and
   confirmed the corrected message renders, at a safe column, with the
   same footer error alongside it — no overflow introduced by the
   longer string.

All three states rendered within the bordered box's own scrollbox with
no corruption, no wrapped rows, and correct clearing between frames
(each transition's own leftover characters from the previous frame's
text were properly blanked, not left interleaved — the specific defect
class a prior round of this file's own history hit for a completely
different line).

**What this pass does and does not prove, stated precisely.** It proves
the Audit view's own rendering — across three real, distinct states —
is correct at 80×24, and it found two real bugs a static single-frame
check would have missed. It does **not** prove genuine keyboard-driven
navigation into the view (pressing `4` or Tab from a live session) or
that the `r` reload key is actually received and processed by OpenTUI's
own input handling — the state-injection technique forces a mode's
*initial* render by construction, it never exercises a real keypress.
That distinction is what keeps `verification` at `partial` rather than
`verified`, precisely, not the view's rendering correctness.

## The decisive live test (B6 + dashboard)

Real Gemini key (`.orchestrai/config.env`, already present from earlier
session work), the real compiled runtime (`bun run orchestrai`), no
mocks.

**Setup**: `bun run orchestrai --only devops-agent,orchestrator`.

**Step 1 — real MCP calls, the real whitelist proven end to end.** A
real `git-status` dispatch and a real, approved `run-command` (`echo
hello-audit-test`) both completed. `GET /audit?task=<the run-command
task's own agent-side id>` returned exactly one event whose
`paramsJson` was `{"retried":false,"paramsHash":"565454ae9d3e5761"}` —
no `argv`, no command text anywhere. The literal acceptance criterion,
confirmed against the real running stack, not a unit test in isolation.
The same run's `git-status` event's own `paramsJson` was equally
minimal — no `repo_path`.

**Step 2 — the decisive check: a full process kill and restart.**
`taskkill /F /IM bun.exe` killed every process (a hard kill, not a
graceful shutdown — `flushAuditBufferForShutdown()` never ran; the
batching interval had already flushed both events to the real store in
the ~20+ seconds between the calls and the kill, which is itself a
real, honest observation about this sink's actual behavior under an
abrupt stop). `bun run orchestrai --only orchestrator` started a
genuinely fresh process. `GET /audit` returned the identical two
events, byte-identical — restart survival confirmed by a real HTTP
request against a genuinely restarted process, not inferred from the
database alone.

Process cleanly torn down afterward, ports confirmed free via
`netstat`. `.orchestrai/orchestrai.db` confirmed `git check-ignore`d
throughout.

## Known gaps, stated honestly

- Genuine keyboard-driven navigation into the TUI Audit view (pressing
  `4`/Tab from a live session) and the `r` reload key actually being
  received by OpenTUI's own input handling were not confirmed — the
  view's own *rendering* was, via the state-injection technique above;
  real keystrokes still need a real terminal on Yusuf's own machine,
  the same standing gap every TUI checkpoint here carries, now narrowed
  to specifically "does a real keypress reach this code" rather than
  "does this code render correctly."
- The TUI view's v1 has no task-id filter, a deliberate scope reduction
  made during implementation (not in the original approved revision's
  own wording) to avoid adding a new text-input mode to this
  already-fragile file in the same pass — reload-only for now.
- The batched sink's behavior under a genuine hard crash (buffered-but-
  not-yet-flushed events lost) was not specifically forced — the live
  pass's own kill happened to land after the periodic flush had already
  run. This matches the spec's own stated, accepted risk ("a lost
  buffer on a hard crash is accepted: the console line already exists,
  and audit is a record, not a control"), not a gap in what was
  verified.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/108-durable-audit-trail/spec.md` (implemented, **partial**
verification) adds `audit_events` onto `specs/106`'s own store — the
trail this system has always *emitted* (`console.log`, live SSE) but
never *kept*. **Revised before implementation, on direct request**: the
original draft was a bare `GET /audit?task=…` endpoint with no way to
actually see the trail short of `curl`. Yusuf, once told that plainly:
*"do both"* — a dashboard Audit tab and a TUI Audit view. This was a
material scope change to an already-approved spec, so it returned to
`draft` and was re-approved before any code was written, per this
repo's own working procedure.

**B6 — the table, a third batched sink, the real safety mechanism.**
`packages/shared/audit.ts`'s `emitAuditEvent()` gains a third sink
beside the existing two (console.log, the Orchestrator SSE push) —
neither of those changes; this is purely additive. The comment there
used to call `console.log` "the durable record" — corrected, since it's
stdout, reaching disk only incidentally via `specs/066`'s log
redirection into a file truncated fresh on every run. The real safety
mechanism is `whitelistAuditParams()`: rather than a per-tool allowlist,
every **string, array, and nested object** is dropped unconditionally —
only booleans and numbers survive — plus a stable SHA-256 hash of the
full (undisclosed) params, so two calls with identical params can still
be correlated without ever storing what they were. This is structurally
narrower than "know which fields are sensitive per tool": a `run_command`
call's `argv` (an array), a real file path (a string), and real file
content (a string) are all dropped by the same one rule, not three
separate ones that could each be gotten wrong. Batched, not one row per
call — the one genuinely high-volume table in this codebase (a row per
MCP/A2A call) — flushed on a 2-second interval, a 20-event size
threshold, or a clean shutdown; a lost buffer on a hard crash is
accepted (the console.log line already exists regardless). Retention
(7 days or 50,000 rows) joins `specs/106`'s own existing Orchestrator-
only sweep, not a third interval. `GET /audit?task=…` on the
Orchestrator is the read surface — fail-open like everything else in
this store, an empty list rather than an error when the store is
unavailable.

**B7 — dashboard Audit tab.** A fourth tab alongside the existing
Chat|Tasks|Agents workspace (`specs/046`), same inline-template-string
rendering convention, a task-id filter re-querying `GET /audit?task=…`.
Poll-on-demand, not live-streamed — a deliberate scope decision: this
codebase already has a real live stream (`GET /events`, `specs/021`) for
"what's happening right now"; this view exists specifically for history
that already happened, which a live feed doesn't help with, and
building one on top of a batched, multi-process writer would have been
real, avoidable complexity for a low-value-per-row table already
sequenced last for exactly that reason.

**B7 — TUI Audit view, the higher-risk half.** A fourth top-level mode
(`4`, alongside Chat/Tasks/Agents in the existing Tab-cycle and
`renderShell()` machinery) — reachable, unit-tested for its own pure
mode-cycling math (`resolveModeKey()`), but the one place this spec's
own honesty about risk paid off: `apps/tui/index.tsx` has 16+ rounds of
real terminal-overflow bug history (`specs/012`/`047`/`069`), so the new
view deliberately reuses `computeShellChatScrollHeight()` **verbatim**
(no new height arithmetic) rather than deriving a parallel formula, and
ships with a genuinely reduced v1 scope — no task-id filter (the
dashboard's own text-entry filter needs a new input-mode this pass
didn't add here), reload-only.

**Two real bugs found via a genuine real-PTY smoke pass, not by
inspection.** Pass 1: a one-shot real-PTY capture of the TUI's default
startup frame (this sandbox's own Bash tool genuinely allocates a TTY
for stdout) confirmed the new `4 Audit` header label renders cleanly at
80×24 with no overflow; piping a keypress into stdin to then switch to
Audit mode was tried and confirmed **not** to work (piped stdin doesn't
replicate a real PTY's raw-mode byte stream). Pass 2, pointed out
directly by Yusuf ("you can check terminal... you did that many time
before"): this repo's own `specs/069`-`073` already established the
right technique for exactly this — temporarily force the component's
initial state in source, capture a real render, revert. Applied here
(`useState<TuiMode>("chat")` → `"audit"`, captured, reverted — confirmed
via `git diff` showing zero trace afterward), this forced the Audit
view's own real idle → loading → result lifecycle to render in one
process run, since its `useEffect` auto-loads on first entry. All three
states rendered cleanly with no corruption — and caught a genuine
second bug: a failed fetch rendered the identical `"No audit events
recorded."` text a genuine empty-but-successful query shows, while the
footer separately reported the real connection error — an honestly
contradictory pair a real user would see together. Fixed with a new
`auditLoadFailed` flag distinguishing the two cases, re-captured and
confirmed the corrected message renders safely. **What this precisely
does and does not prove**: the view's own rendering across three real
states is now demonstrated correct; genuine keyboard-driven navigation
into the view (pressing `4`/Tab) and the `r` key actually reaching
OpenTUI's own input handling remain unconfirmed — the state-injection
technique forces a mode's *initial* render by construction, it never
exercises a real keypress. That narrower, more precise gap is what
keeps this spec's own `verification` at `partial`, not the rendering
itself.

1307 tests pass (0 fail, 2 skip, unrelated), typecheck clean,
`specs:check` passed for 107 specs. **Live-verified end to end for B6
and the dashboard**, real Gemini key, real compiled runtime, no mocks: a
real `git-status` and a real, human-approved `run-command`
(`echo hello-audit-test`) both completed; `GET /audit` for the
`run-command` task returned exactly `{"retried":false,"paramsHash":
"565454ae9d3e5761"}` as its stored params — no `argv`, no command text —
the literal acceptance criterion confirmed against the real running
stack. The entire process stack was then killed
(`taskkill /F /IM bun.exe`, a hard kill, not a graceful shutdown — the
batching interval had already flushed both events in the ~20+ seconds
before the kill) and only the Orchestrator restarted fresh; `GET /audit`
returned the identical two events, byte-identical — restart survival
confirmed by a real HTTP request against a genuinely restarted process.
See `specs/108`'s own `verification.md` for the complete transcript,
including the honestly-stated TUI gap above and the observation that a
genuine hard-crash-before-flush scenario (buffered events lost, the
spec's own accepted risk) was not specifically forced.

This closes out the entire 105→108 plan Yusuf approved from *"i think
it's the time to have a place to save the chat, the resualts so on"* —
deep analysis reachable without DevOps (`105`), a local store with no
redundant expensive work (`106`), tasks and chat surviving a restart
(`107`), and a durable, dashboard-and-TUI-visible audit trail (`108`).

See specs/113-live-audit-log-dashboard/verification.md for the relocated narrative covering this checkpoint.

See specs/109-document-api-drift-recheck/verification.md for the relocated narrative covering this checkpoint.

See specs/115-tui-navigation-redraw-and-answer-clarity/verification.md for the relocated narrative covering this checkpoint.

See specs/110-approval-state-survives-a-restart/verification.md for the relocated narrative covering this checkpoint.
