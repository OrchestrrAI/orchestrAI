# Verification: Official AG-UI Core Adoption

## Status

`verified` as of 2026-08-20 — Option A implemented: `@ag-ui/core` adopted
as the runtime schema source, all nine emitted event types conform, every
event is runtime-validated before reaching the SSE stream, and a live
before/after capture confirms the wire-format change is limited to exactly
the two documented fields.

## Dependency gate

- `bun add @ag-ui/core@0.0.58 --exact` (root) plus an explicit
  `"@ag-ui/core": "0.0.58"` and `"zod": "^3.22.4"` added to
  `packages/shared/package.json` — bun resolves a package-local zod@3
  alongside the repository's existing root/`packages/mcp` zod@4.4.3 (Bun
  workspaces do not force one hoisted version across packages). No
  downgrade to `packages/mcp`'s zod was made or needed.
- `bun run typecheck`: 0 errors — proves the two zod majors coexist at the
  type level as well as at install time, not just that `bun install`
  succeeded.
- `bun test`: full suite unaffected by the dependency add alone (confirmed
  before any source change).

## Compatibility matrix (all nine emitted event types)

Produced by `packages/shared/ag-ui-events.test.ts`'s
`describe("compatibility matrix — all nine emitted event types validate")`,
which runs one real-shaped instance of every event type this runtime
constructs through `validateAgUiEvent()` (the actual `@ag-ui/core` runtime
schemas, plus OrchestrAI's own local schemas for the three `CUSTOM` value
payloads):

| Event type | Validates | Extra fields OrchestrAI adds | Schema-required fields OrchestrAI omits |
|---|---|---|---|
| `RUN_STARTED` | yes | — | — |
| `RUN_FINISHED` | yes (after fix) | — | — (was: bare-string `outcome`, non-conformant) |
| `RUN_ERROR` | yes | — | — |
| `STEP_STARTED` | yes | — | — |
| `STEP_FINISHED` | yes | `outcome` (optional, not in official schema) | — |
| `TOOL_CALL_START` | yes | `caller` (optional, not in official schema) | — |
| `TOOL_CALL_RESULT` | yes (after fix) | `outcome`, `durationMs` | — (was: `messageId`, non-conformant) |
| `STATE_SNAPSHOT` | yes | — | — |
| `CUSTOM` (all 3 `orchestrai.*` names) | yes | — (`value` shape covered by OrchestrAI's own local schemas, not `@ag-ui/core`) | — |

The two originally-incompatible types (`TOOL_CALL_RESULT`, `RUN_FINISHED`)
are the only ones that changed. `BaseEventSchema`'s `.passthrough()`
already tolerated OrchestrAI's extra fields (`caller`, `outcome` on
`STEP_FINISHED`) without any change needed.

## Runtime validation

- `packages/shared/ag-ui-events.ts` exports `validateAgUiEvent()`, mapping
  each `AgUiEventType` to its official `@ag-ui/core` schema
  (`STANDARD_EVENT_SCHEMAS`) and each of the three `CUSTOM` extension names
  to a local zod schema (`CUSTOM_VALUE_SCHEMAS`) matching the exact shapes
  `apps/orchestrator/index.ts` constructs.
- `apps/orchestrator/index.ts`'s `emit()` calls `validateAgUiEvent()` on
  every event before delivering it to subscribers. The validation-failure
  policy: `console.warn` naming the event type and field path, then the
  event is still delivered — a schema disagreement never blocks the live
  stream. Verified directly in
  `apps/orchestrator/ag-ui-validation-policy.test.ts` against the real
  `emit()`/`subscribeToEvents()` pair (not a reimplementation): a
  deliberately malformed `RUN_FINISHED` (the old bare-string `outcome`
  shape) is confirmed both delivered to the subscriber and logged with
  `RUN_FINISHED` in the warning text; a well-formed event produces no
  warning.
- "Fails the test suite" is achieved by the compatibility-matrix tests
  themselves (`ok: true` is asserted directly against every real
  event-construction shape) rather than by throwing inside `emit()` at
  request time — a request-time throw would itself violate the "never take
  down the live stream" requirement, including inside tests that exercise
  the live server.

## Negative tests

`packages/shared/ag-ui-events.test.ts`'s
`describe("negative tests — validation actually rejects malformed events")`
— 7 tests, each asserting `ok: false` with a non-empty `errors` array:

- `TOOL_CALL_RESULT` missing the required `messageId` → rejected, error
  path includes `messageId`.
- `RUN_FINISHED` with the old bare-string `outcome: "success"` (specs/021's
  original shape) → rejected.
- `RUN_STARTED` with `runId` as a number instead of a string → rejected,
  error path includes `runId`.
- `STEP_STARTED` missing the required `stepName` → rejected, error path
  includes `stepName`.
- `CUSTOM orchestrai.approval-required` missing `skill` → rejected against
  its local value schema, error path prefixed `value.`.
- `CUSTOM orchestrai.approval-resolved` with an invalid `decision` value →
  rejected.
- `CUSTOM orchestrai.agents-update` with a non-numeric `count` → rejected.

## Wire-format change: live before/after capture

Captured with `bun run demo:ag-ui` against the reusable fixture project
(`C:\Users\moham\test-target-project`), full 7-process stack
(`bun run dev`), real HTTP/SSE — not a unit-test simulation.

**Methodology note, found live:** the first before/after attempt showed a
41-vs-51 event-count mismatch. Investigation found the shared fixture
project had accumulated untracked artifacts (`Dockerfile`,
`docker-compose.yml`, `README.md`, `.github/`, a stray compiled binary)
from earlier, unrelated live-testing sessions in this repository's history
— Planning's deterministic keyword plan for `"setup project at ..."`
reads the target directory's existing contents to decide which steps are
still needed, so a dirty fixture produces a genuinely different (but
correct) plan than a clean one. This was a fixture-hygiene confound, not a
regression in either code path. Resolved by `git clean -fdx` (plus
`git checkout -- .gitignore` for one leftover tracked-file modification)
on the fixture before each capture; both captures below are against the
identical clean baseline and produced identical event-type counts (41
events each, same per-type breakdown) before any diff was taken.

- **Before** (code stashed back to pre-migration `specs/021` shape):
  `bun run demo:ag-ui` — 41 events captured, all 6 scenarios passed.
- **After** (this spec's code): `bun run demo:ag-ui` — 41 events captured,
  all 6 scenarios passed.
- Both captures normalized (timestamps zeroed; `runId`/`threadId`/
  `toolCallId`/`messageId`/`value.taskId`/approval-preview fields mapped to
  positional placeholders — genuinely varying per-run identifiers, not
  wire-format structure) and diffed. The only structural differences:
  - `TOOL_CALL_RESULT` gained `messageId` (the fix).
  - `RUN_FINISHED.outcome` changed from a bare string to
    `{"type": "success"}` (the fix).
  - `durationMs` values differ (inherently timing-varying, expected).
  - The initial `STATE_SNAPSHOT`'s agent list ordering differs (agent
    discovery is a concurrent race between 5 processes reporting readiness
    in a not-strictly-ordered sequence — pre-existing nondeterminism,
    unrelated to and unaffected by this migration).
  - No other field, event type, or event count differs.
- Every one of the 41 real "after" events was additionally run through
  `validateAgUiEvent()` directly (not the hand-built matrix fixtures):
  **41 checked, 0 failed validation.**

## Dashboard and TUI confirmation

- Live `bun run dev` stack, task submitted via `POST /tasks`
  (`check git status at "C:/Users/moham/test-target-project"`), observed
  via the browser dashboard (`GET /dashboard`): the task row rendered
  `completed` with a live tool-call line
  (`✓ devops-agent → git_status · 134ms`), and the full task/agent history
  from the demo captures rendered correctly. `read_console_messages`
  reported zero console errors.
- Live TUI (`bun run apps/tui/index.tsx --headless`) against the same
  running stack: connected (`● live`), rendered all 5 discovered agents,
  and rendered the submitted task as `completed` in the Tasks pane. Exit
  code 0, no crash.
- Both consumers required zero source changes — `messageId` and the
  restructured `outcome` are both fields/shapes neither client reads
  today (`grep` confirmed no `RUN_FINISHED.outcome` or `TOOL_CALL_RESULT.
  messageId` consumer in either `apps/orchestrator/index.ts`'s dashboard
  fragment or `apps/tui/index.tsx` before this change), so the "Option A"
  cost the spec anticipated (consumer updates) did not materialize in
  practice — the two fields were purely additive/restructured from every
  actual consumer's point of view.

## Compiled-binary evidence

- `bun run build`, before (code stashed to pre-migration state):
  **147,468,800 bytes**.
- `bun run build`, after (this spec's code): **147,624,960 bytes**.
- **Delta: +156,160 bytes (+0.15 MiB)** — `@ag-ui/core` plus its own
  zod@3 dependency embedded into the compiled binary.
- Smoke-tested the compiled after-binary directly (not just `bun run dev`):
  `orchestrai.exe --project <fixture> --only orchestrator,devops-agent`
  reached `/healthz` and completed a real `git-status` task end to end
  with the correct branch/commit output.

## Automated evidence

- `bun test`: 277 passed, 0 failed, 499 expect() calls across 28 files
  (256 pre-existing + 21 new: 16 in `ag-ui-events.test.ts`, 2 in the new
  `ag-ui-validation-policy.test.ts`, 3 additional cases folded into
  `ag-ui-mapping.test.ts`'s existing suite via its `toMatchObject` assertion
  tolerating the new `messageId` field).
- `bun run typecheck`: 0 errors.
- `bun run specs:check`: passed for 30 specs.

## Scope discipline

- No event type beyond the existing nine is emitted — confirmed by
  inspecting every `emit()` call site; `TEXT_MESSAGE_*`/`REASONING_*`/
  `STATE_DELTA` remain absent per specs/021's original reasoning, which
  this spec explicitly kept unchanged.
- `@ag-ui/langgraph` was not touched — out of scope, reserved for
  `specs/028`.
- `AuditPushPayload` was not migrated — it remains OrchestrAI's own
  internal agent→Orchestrator shape, explicitly out of scope.

## Fixture hygiene follow-up

`C:\Users\moham\test-target-project` (the shared, reusable demo fixture)
was left `git clean`-reset by this verification run. Its accumulation of
untracked artifacts across unrelated past sessions is a real, mild
liability for any future "identical baseline" comparison against it —
worth a `git clean -fdx` as a standard first step before any future
before/after live capture using this fixture, not a new checkpoint on its
own.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`GET /events` on the Orchestrator emits **AG-UI-shaped events**
(`specs/021-ag-ui-event-protocol/spec.md`, implemented). As of
`specs/027-ag-ui-core-adoption/spec.md` (implemented, verified), the event
schema is sourced from the official `@ag-ui/core` package (pinned exact
version) rather than hand-defined, and every emitted event is
**runtime-validated** against `@ag-ui/core`'s own zod schemas
(`validateAgUiEvent()` in `packages/shared/ag-ui-events.ts`, called from
`emit()` in `apps/orchestrator/index.ts`) before reaching the SSE stream —
not type-only adoption. specs/021 originally claimed field names
"deliberately match the real protocol so any AG-UI client can parse the
stream unchanged"; specs/027 tested that claim against the real runtime
schemas and found it false for two of the nine event types
(`TOOL_CALL_RESULT` was missing a required `messageId`; `RUN_FINISHED.
outcome` was a bare string where the official schema requires a
discriminated-union object). Yusuf resolved that spec's Open Decision as
**Option A — conform the wire format** rather than merely document the
deviation: both fields are now fixed, and all nine event types genuinely
validate. A validation failure (a programming error in OrchestrAI, not a
runtime condition) is logged with the event type and field path and the
event is still delivered — a schema disagreement must never take down the
live stream a demo depends on. Only the subset this runtime can honestly
produce is defined/emitted — nine event types originally, **twelve as of
`specs/044-conversational-ask-layer/spec.md`**, which added
`TEXT_MESSAGE_START`/`_CONTENT`/`_END` for real conversational assistant
turns (see "Conversational ask layer" below) and formally amends this
paragraph's own prior claim that they were "deliberately absent, since
there is no LLM token stream here to carry over them" — true when written,
false once `038`/`041`–`043` existed. `REASONING_*` remains deliberately
absent for the original reason, unchanged: no intermediate model reasoning
is exposed, only final answers. Adopting `@ag-ui/core`'s full type surface
still does not authorize emitting any event beyond these twelve. The three
`orchestrai.*`
`CUSTOM` extension payloads have their own local zod schemas (`@ag-ui/
core`'s own `CustomEventSchema.value` is necessarily `z.any()`, so official
conformance alone would not catch a malformed extension payload).
