---
id: 027-ag-ui-core-adoption
title: Official AG-UI Core Adoption
area: ag-ui
change_type: migration
status: implemented
verification: verified
created: 2026-08-16
updated: 2026-08-20
approved_by: Yusuf
approved_on: 2026-08-20
implemented_on: 2026-08-20
amends:
  - 021-ag-ui-event-protocol
supersedes: []
superseded_by: []
related:
  - 022-ag-ui-demo-stabilization
  - 028-orchestrator-langgraph-supervisor
---

# Spec: Official AG-UI Core Adoption

> Approved 2026-08-20 (Option A, below). Implemented and verified the same
> day — see `verification.md`.

## Purpose

Replace the hand-defined AG-UI event types in
`packages/shared/ag-ui-events.ts` with the official `@ag-ui/core` package's
types and runtime schemas, **with no change to the emitted wire format** and
no change to any consumer.

`specs/021-ag-ui-event-protocol/spec.md` deliberately hand-defined these
types rather than taking the dependency, on an explicit
minimal-new-dependency posture, while noting the field names were chosen to
match the real protocol so a real AG-UI client could parse the stream
unchanged. This checkpoint tests that claim by actually adopting the real
types — turning a stated intention into a verified one — and removes a
hand-maintained copy of someone else's protocol definition.

This checkpoint is deliberately narrow and carries no behavioral change. It
is a precondition for `specs/028-orchestrator-langgraph-supervisor/spec.md`,
which should not be attempting a protocol-source migration and an
orchestration-architecture change in the same reviewable unit.

## Verified Current State

- `packages/shared/ag-ui-events.ts` hand-defines nine event types
  (`RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_STARTED`,
  `STEP_FINISHED`, `TOOL_CALL_START`, `TOOL_CALL_RESULT`, `STATE_SNAPSHOT`,
  `CUSTOM`) plus `toSseFrame()` and the `AuditPushPayload` interface.
- `TEXT_MESSAGE_*`, `REASONING_*`, and `STATE_DELTA` are deliberately
  absent — `specs/021` documents that emitting them would fabricate
  structure this runtime does not produce.
- Three OrchestrAI-specific `CUSTOM` event names exist as protocol
  extensions: `orchestrai.approval-required`, `orchestrai.approval-resolved`,
  `orchestrai.agents-update`. AG-UI has no native human-in-the-loop
  primitive; `specs/021` records these as informational-only.
- Consumers: the Orchestrator's `GET /events` SSE endpoint, the browser
  dashboard's per-event-type listeners, and `apps/tui/index.tsx`'s
  hand-rolled stream reader. `scripts/ag-ui-demo.ts` captures the stream as
  NDJSON and can therefore produce a byte-comparable baseline.
- `@ag-ui/core@0.0.58` exists on npm — "TypeScript definitions & runtime
  schemas for the Agent-User Interaction (AG-UI) Protocol". Its sole
  dependency is **`zod ^3.22.4`**, while this repository currently resolves
  `zod@4.4.3` (`bun.lock`), which `packages/mcp` uses for its tool schemas.
  Whether both coexist cleanly is **unverified and must be proven by actual
  install**, not assumed.

### Verified package contents (inspected, not assumed)

`@ag-ui/core@0.0.58` was unpacked and inspected during drafting. It ships
**real runtime zod schemas**, not only types — all nine event types
OrchestrAI emits have a corresponding schema (`RunStartedEventSchema`,
`RunFinishedEventSchema`, `RunErrorEventSchema`, `StepStartedEventSchema`,
`StepFinishedEventSchema`, `ToolCallStartEventSchema`,
`ToolCallResultEventSchema`, `StateSnapshotEventSchema`,
`CustomEventSchema`).

`BaseEventSchema` is declared `.passthrough()`, so OrchestrAI's
non-standard extra fields (`caller` on `TOOL_CALL_START`, `outcome` on
`STEP_FINISHED`, `durationMs` on `TOOL_CALL_RESULT`) are **preserved rather
than rejected**.

### Two real protocol incompatibilities, found by inspection

`specs/021` claimed OrchestrAI's field names "deliberately match the real
protocol so any AG-UI client can parse this stream unchanged." **That claim
is false for at least two of the nine event types**, which is precisely
what type-only adoption would have hidden:

1. **`TOOL_CALL_RESULT` is missing a required field.**
   `ToolCallResultEventSchema` requires `messageId: z.string()` — not
   optional. OrchestrAI's `ToolCallResultEvent`
   (`packages/shared/ag-ui-events.ts`) emits `type`, `runId`, `toolCallId`,
   `content`, `outcome`, `durationMs`, `timestamp` — **no `messageId`**.
   Runtime validation of this event against the official schema fails today.

2. **`RUN_FINISHED.outcome` has an incompatible shape.** The official
   `RunFinishedOutcomeSchema` is a discriminated union on `type` — an
   *object*. OrchestrAI emits a bare **string**, `"success" | "interrupt"`.
   The field is optional, so omitting it would pass; emitting it as a
   string fails.

These are structural, not cosmetic, and they force a decision this
checkpoint cannot silently resolve — see Open Decision below.

## Proposed Behavior

1. Add `@ag-ui/core` as a dependency, pinned to an exact version.
2. Re-express `packages/shared/ag-ui-events.ts` in terms of `@ag-ui/core`'s
   exported types, retaining as local extensions:
   - `toSseFrame()` — OrchestrAI's own SSE serialization;
   - the three `orchestrai.*` `CUSTOM` event names;
   - `AuditPushPayload` — an internal agent→Orchestrator shape, not part of
     the AG-UI protocol at all, and explicitly out of this migration.
3. Keep the deliberate omission of `TEXT_MESSAGE_*`/`REASONING_*`/
   `STATE_DELTA`. Adopting the package's *types* must not become a reason to
   start emitting events this runtime cannot honestly produce; `specs/021`'s
   reasoning stands unchanged.
4. **Runtime validation, not just types.** Adopting `@ag-ui/core` for its
   TypeScript types alone would leave the principal safety benefit on the
   table. Every emitted event is validated against the corresponding
   `@ag-ui/core` runtime schema before being written to the SSE stream:
   - **A compatibility matrix covering all nine emitted event types**,
     recording for each: the official schema, whether OrchestrAI's payload
     validates, every field OrchestrAI adds beyond the schema, and every
     schema-required field OrchestrAI does not emit. Produced by running
     real events through the schemas, not by reading definitions.
   - **Negative tests** proving malformed standard events are actually
     rejected — a validation layer never observed to reject anything is not
     known to work.
   - **A defined validation-failure policy** (below).
   - **Separate validation for OrchestrAI's `CUSTOM` extensions**, whose
     `value` payloads are OrchestrAI-defined and outside the official
     schema's reach. These get their own local schemas rather than being
     silently exempted by `.passthrough()`.

5. **Validation-failure policy.** A validation failure is a **programming
   error in OrchestrAI, not a runtime condition to tolerate**: it means the
   Orchestrator constructed an event that does not conform. The policy is:
   log the failure with the offending event type and field path, emit the
   event anyway (so a schema disagreement can never take down the live
   stream a demo depends on), and **fail the test suite** if any event fails
   validation during tests. Fail-loud in development, fail-open in
   production — the inverse would let a schema mismatch break the dashboard.

6. **Wire format.** Subject to the Open Decision below, the emitted format
   is otherwise unchanged: field names and SSE framing remain byte-identical
   and the dashboard and TUI are not modified.

## Open Decision — resolved 2026-08-20: Option A

The two incompatibilities in Verified Current State put two of this spec's
own goals in direct conflict for `TOOL_CALL_RESULT` and `RUN_FINISHED`:
**"zero wire-format change"** and **"events validate against the official
schemas"** cannot both hold.

- **Option A — conform the wire format.** Add `messageId` to
  `TOOL_CALL_RESULT`; restructure `RUN_FINISHED.outcome` into the official
  object shape. All nine event types then genuinely validate. Cost: this is
  no longer a zero-behavior-change checkpoint — the dashboard and TUI both
  read these events and would need updating, and `specs/022`'s verified
  demo captures change shape.
- **Option B — document the deviation.** Keep the wire format exactly as
  is; validate the seven conforming event types; record the two deviations
  explicitly in the compatibility matrix as known non-conformance. Cost:
  `specs/021`'s "any AG-UI client can parse this unchanged" claim stays
  false, and must be corrected in that spec's text rather than left
  standing.

Yusuf chose **Option A** on 2026-08-20. All nine event types now genuinely
validate against the official `@ag-ui/core` schemas — see `verification.md`
for the compatibility matrix, the live before/after wire-format diff, and
dashboard/TUI confirmation.

## Scope

- `packages/shared/ag-ui-events.ts` — type source migration.
- `package.json` / `bun.lock` — add `@ag-ui/core`.
- Any file importing those types, only as required by the migration
  (`apps/orchestrator/index.ts`, `apps/tui/index.tsx`,
  `packages/shared/ag-ui-mapping.ts`).
- `CLAUDE.md`, `README.md`, `context/worklog.md`.

## Safety and Compatibility Constraints

- **Wire-format change is bounded by the resolved Open Decision** and proven
  by diffing a captured event stream before and after — never by reading the
  types and concluding they match. Under Option B, zero change. Under
  Option A, change limited to `TOOL_CALL_RESULT.messageId` and
  `RUN_FINISHED.outcome`, with both consumers updated in the same unit.
- **Consumer changes, if any, are limited to those two events.** Any other
  dashboard or TUI change means the migration altered the wire format
  unintentionally and has failed.
- **Validation must be observed rejecting something.** A validation layer
  with no passing negative test is not known to work and does not satisfy
  this spec.
- **No new emitted event types.** Adopting the full type surface does not
  authorize emitting any event beyond the existing nine.
- **The zod version mismatch is a gate, not a footnote.** If `@ag-ui/core`
  cannot resolve alongside `zod@4.4.3`, stop and report. Downgrading the
  repository's zod is **not** an acceptable workaround here — it would
  affect `packages/mcp`'s tool schemas, which is out of scope and carries
  its own risk.
- No change to the approval gate, task lifecycle, routing, or any agent.

## Out of Scope / Non-Goals

- **`@ag-ui/langgraph`.** Explicitly excluded from this checkpoint; it is
  evaluated in `specs/028` against an exact pinned version. See that spec
  for the recorded evidence on both sides.
- `@ag-ui/client` or any other `@ag-ui/*` package.
- Emitting `TEXT_MESSAGE_*`, `REASONING_*`, or `STATE_DELTA`.
- Any orchestration, routing, or LLM behavior change.
- Migrating `AuditPushPayload`, which is an internal OrchestrAI shape.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] `@ag-ui/core` resolves cleanly alongside `zod@4.4.3`, **verified by
      actual install plus a passing `bun run typecheck`** — the known
      version-range mismatch is proven resolved, not assumed.
- [x] **The Open Decision above is resolved by Yusuf** and this spec updated
      to state the chosen option before implementation begins.
- [x] **A compatibility matrix for all nine emitted event types** is
      recorded in `verification.md`, produced by running real events through
      `@ag-ui/core`'s schemas — listing per type: validates yes/no, extra
      fields OrchestrAI adds, and schema-required fields it omits.
- [x] **Every emitted event is runtime-validated** against its
      `@ag-ui/core` schema before reaching the SSE stream.
- [x] **Negative tests prove rejection actually happens**: malformed
      standard events (missing required field, wrong field type, wrong
      literal `type`) each fail validation in a test.
- [x] **The validation-failure policy is implemented and tested**: logs with
      event type and field path, still emits, and fails the test suite.
- [x] **OrchestrAI's three `CUSTOM` extension payloads have their own local
      schemas** and their own validation tests, rather than relying on
      `.passthrough()` to let anything through.
- [x] A `bun run demo:ag-ui` NDJSON capture taken **before** and **after**
      differs only as the resolved Open Decision permits (byte-identical
      under Option B; differing only in the two documented event types under
      Option A), modulo inherently-varying fields.
- [x] `bun test`, `bun run typecheck`, and `bun run specs:check` all pass.
- [x] The dashboard and TUI are confirmed working against the migrated
      stream — with zero source changes under Option B, or with their
      updates included and verified under Option A.
- [x] No new event type is emitted beyond the existing nine.
- [x] `bun run build` binary size delta measured and recorded.
- [x] `CLAUDE.md`, `README.md`, and `context/worklog.md` updated after the
      above pass.

## Verification Plan

- Automated: full suite, typecheck, spec governance.
- Wire compatibility: capture `bun run demo:ag-ui` NDJSON before and after,
  normalize inherently-varying fields, and diff. Any structural difference
  is a failure.
- Manual: open the browser dashboard and run the TUI against a live stack
  with the migration applied; confirm live tool-call lines, approval
  prompts, and step indicators still render — the same real-terminal
  standard `specs/022` required rather than a piped-output capture.
- `bun run build` before/after size comparison.

## Approval Requested

Approval authorizes adding `@ag-ui/core` and re-expressing
`packages/shared/ag-ui-events.ts` in terms of its types, with an unchanged
wire format.

It does not authorize adopting `@ag-ui/langgraph` or any other `@ag-ui/*`
package, emitting any new event type, or any orchestration/routing/LLM
change.
