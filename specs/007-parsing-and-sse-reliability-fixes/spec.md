---
id: 007-parsing-and-sse-reliability-fixes
title: Target-Path Parsing Fallback and Orchestrator SSE Reliability Fixes
area: runtime-reliability
change_type: fix
status: implemented
verification: verified
created: 2026-08-08
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-08
implemented_on: 2026-08-08
amends:
  - 004-configurable-project-paths
  - 006-runtime-stabilization
supersedes: []
superseded_by: []
related:
  - 006-runtime-stabilization
---

# Spec: Target-Path Parsing Fallback and Orchestrator SSE Reliability Fixes

> Status: **APPROVED by Yusuf on 2026-08-08 ("Approved
> specs/007-parsing-and-sse-reliability-fixes/spec.md as written"). IMPLEMENTED and
> VERIFIED on 2026-08-08; results recorded in Verification Results below.**

## Purpose

Fix two small, independent, low-risk reliability defects found during manual
hands-on testing on 2026-08-08, after the runtime-stabilization checkpoint was
implemented:

1. A false-positive natural-language path match in
   `extractExplicitTargetPath()` throws before `resolveTargetPath()` can ever
   fall back to a correctly-configured `ORCHESTRAI_PROJECT_PATH`.
2. The Orchestrator's `/events` SSE heartbeat interval is longer than Bun's
   default per-request idle timeout, causing every live-dashboard SSE
   connection to be forcibly closed roughly every 10 seconds and immediately
   reconnected.

Both are demo-reliability bugs, not architecture or protocol changes. This is
a small, bounded checkpoint — not a general parsing-engine rewrite and not a
change to the A2A/MCP protocol, approval model, or ID/audit contracts
delivered in `specs/006-runtime-stabilization/spec.md`.

## Relationship to Existing Specifications

`specs/006-runtime-stabilization/spec.md` is implemented and verified; this draft
does not reopen or change anything in it. Its "Out of Scope" section already
named "natural-language prepositions" as deferred parsing work — this spec is
that deferred follow-up, scoped narrowly to the two reproduced defects below
rather than a general parsing rewrite (case-sensitive runtime detection, `ci`
substring in a directory name, and Documentation output paths with spaces
remain separately deferred and are explicit non-goals here).

## Issue 1 — Explicit-path false positive defeats the configured fallback

### Verified current behavior

`packages/shared/index.ts:6-32`:

```ts
const EXPLICIT_PATH_PATTERN = /(?:^|\s)(?:at|in|to|from)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i

function normalizeAbsolutePath(value: string, source: string): string {
  ...
  throw new Error(`${source} must be an absolute path: ${candidate}`)
}

export function extractExplicitTargetPath(taskText: string): string | null {
  const inputOnly = taskText.replace(OUTPUT_PATH_PATTERN, "")
  const match = inputOnly.match(EXPLICIT_PATH_PATTERN)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value ? normalizeAbsolutePath(value, "Task path") : null
}

export function resolveTargetPath(taskText, options = {}): string {
  const explicitPath = extractExplicitTargetPath(taskText)   // <- throws here
  if (explicitPath) return explicitPath
  const configuredPath = (options.env ?? process.env).ORCHESTRAI_PROJECT_PATH?.trim()
  if (configuredPath) return normalizeAbsolutePath(configuredPath, "ORCHESTRAI_PROJECT_PATH")
  throw new Error(TARGET_PATH_REQUIRED_ERROR)
}
```

The regex treats any plain-English occurrence of `at`, `in`, `to`, or `from`
as introducing a path, then unconditionally calls `normalizeAbsolutePath()` on
whatever non-space token follows. That function throws (does not return
`null`) when the candidate isn't absolute. Because `extractExplicitTargetPath`
propagates that throw instead of catching it, `resolveTargetPath` never
reaches its own `ORCHESTRAI_PROJECT_PATH` fallback line — a plain sentence
containing one of those four words followed by an ordinary word breaks path
resolution even when a correct default is configured.

Reproduced live on 2026-08-08 (`context/e2e-validation-2026-08-08.md` already
recorded the same root cause under "Natural language before path"):

```
resolveTargetPath(
  "if i need fully deploy how to do that in steps my project will be in bun",
  { env: { ORCHESTRAI_PROJECT_PATH: "C:\\Users\\moham\\orch-scratch" } }
)
=> throws "Task path must be an absolute path: do"
```

`ORCHESTRAI_PROJECT_PATH` was valid and configured; the caller still gets a
confusing failure instead of the configured default being used.

### Proposed behavior

`extractExplicitTargetPath()` must never throw. A syntactic match that does
not resolve to a real absolute path is not an explicit path — it is treated
exactly like "no explicit path found," and resolution continues to the
`ORCHESTRAI_PROJECT_PATH` fallback and then to the existing required-error.

Proposed implementation shape (illustrative, not final):

```ts
export function extractExplicitTargetPath(taskText: string): string | null {
  const inputOnly = taskText.replace(OUTPUT_PATH_PATTERN, "")
  const match = inputOnly.match(EXPLICIT_PATH_PATTERN)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  if (!value) return null
  try {
    return normalizeAbsolutePath(value, "Task path")
  } catch {
    return null   // syntactic match that isn't a real absolute path — not an explicit path
  }
}
```

`resolveTargetPath()` itself is unchanged: it still throws
`TARGET_PATH_REQUIRED_ERROR` with the existing message when neither an
explicit path nor a configured default resolves — behavior for a task with a
genuinely malformed *quoted* path (e.g. `at "not-absolute"`) is preserved,
since a quoted value that fails to normalize is still routed through the same
try/catch and correctly falls back rather than silently ignoring an obvious
user intent to supply a path. This is a deliberate trade-off: a quoted "path"
that isn't absolute will now fall back to the configured default (or the
generic required-path error) instead of surfacing the more specific "must be
an absolute path" message. This is judged safer than the current behavior,
where an accidental match on ordinary prose crashes resolution outright.

### In scope

- Change `extractExplicitTargetPath()` in `packages/shared/index.ts` to
  swallow a normalization failure and return `null` instead of throwing.
- No change to `EXPLICIT_PATH_PATTERN`, `OUTPUT_PATH_PATTERN`,
  `normalizeAbsolutePath()`, or `resolveTargetPath()`'s fallback order.
- No change to any agent's call sites — they already call `resolveTargetPath`
  and handle its thrown `TARGET_PATH_REQUIRED_ERROR` the same way.

### Explicit non-goals

- Rewriting `EXPLICIT_PATH_PATTERN` to avoid matching ordinary prepositions in
  the first place (would reduce false positives further but is a larger,
  riskier regex change — deferred).
- Fixing the `ci`-in-directory-name misroute, case-sensitive runtime
  detection, or Documentation save-paths containing spaces — all remain
  separately deferred per `specs/006-runtime-stabilization/spec.md`'s existing
  Out of Scope list.
- Any change to Orchestrator's own `detectSkill()` keyword routing.

## Issue 2 — Orchestrator SSE heartbeat exceeds Bun's default idle timeout

### Verified current behavior

`apps/orchestrator/index.ts` `GET /events` (SSE channel the dashboard
subscribes to):

```ts
const heartbeat = setInterval(() => {
  try {
    controller.enqueue(enc.encode(": heartbeat\n\n"))
  } catch {
    clearInterval(heartbeat)
  }
}, 15000)   // <- fires every 15 seconds
```

The route is served via `serve({ fetch: app.fetch, port: PORT })` (Bun's
`serve`, imported from `"bun"`) with no explicit `idleTimeout` configured.
Bun's documented default per-request idle timeout is 10 seconds. Reproduced
live on 2026-08-08: with the Orchestrator dashboard open, the terminal
repeatedly logged

```
[Bun.serve]: request timed out after 10 seconds. Pass `idleTimeout` to configure.
```

and the browser console showed a matching stream of

```
Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING
```

on `GET /events`. Because the heartbeat (15s) never fires before Bun's own
10-second idle cutoff, every SSE connection is closed by the server itself
before it can keep itself alive. The browser's native `EventSource`
auto-reconnects immediately, so the dashboard's live-update feature still
functions, but the connection churns continuously — visible as the reconnect
log/console noise above and brief "reconnecting..." flicker of the dashboard's
live indicator, and a background load of one dropped+reopened HTTP connection
roughly every 10 seconds for as long as any dashboard tab stays open.

This is pre-existing code from the original checkpoint (`d14d855`), not
something introduced by `specs/006-runtime-stabilization/spec.md`'s
implementation; it was simply not exercised live until this manual test pass.

### Proposed behavior

Set the `/events` route's heartbeat interval below Bun's default idle
timeout, with margin, rather than trying to configure `idleTimeout` per-route
(Bun's `serve()` idle timeout is a server-level, not a per-route, setting, and
changing it would also affect every other route on the same Hono app,
including the task-processing endpoints that may legitimately want a longer
window for slow agent calls).

Proposed change: lower the `/events` heartbeat interval from `15000` to
`5000` (5 seconds) — comfortably under the 10-second default with margin for
scheduling jitter, while still being infrequent enough not to add meaningful
load. No other SSE endpoint (`GET /tasks/:id/stream` on any agent) has this
problem: those already poll and terminate within a bounded loop
(`Bun.sleep(500)` between explicit `send()` calls, not an idle wait for an
external event), so they are not part of this fix.

### In scope

- Change the single `15000` literal in the `/events` heartbeat `setInterval`
  in `apps/orchestrator/index.ts` to `5000`.
- Add a short comment explaining the constraint (heartbeat interval must stay
  under Bun's default `idleTimeout`) so a future edit doesn't reintroduce it.

### Explicit non-goals

- Setting a global `idleTimeout` on the Orchestrator's `serve()` call — out of
  scope because it is a server-wide setting with effects on unrelated routes
  that have not been reviewed here.
- Changing agent-level `/tasks/:id/stream` SSE endpoints — not affected by
  this defect (see above).
- Any change to `EventSource` client reconnect/backoff behavior in the
  dashboard — the native browser default is sufficient once the server stops
  forcing an unnecessary disconnect.

## Safety Constraints

- Both changes are confined to non-security-relevant, non-protocol code: a
  pure string/path-normalization helper and an SSE keep-alive interval
  constant.
- Neither change touches approval state, task identity, MCP/A2A behavior, or
  audit logging established by `specs/006-runtime-stabilization/spec.md`.
- Neither change introduces a new dependency, environment variable, port, or
  public API.

## Acceptance Criteria

- [x] Yusuf explicitly approves this spec — "Approved
      specs/007-parsing-and-sse-reliability-fixes/spec.md as written" (2026-08-08).
- [x] `extractExplicitTargetPath()` returns `null` (never throws) for a
      syntactic match that isn't a real absolute path.
- [x] `resolveTargetPath()` falls back to a configured
      `ORCHESTRAI_PROJECT_PATH` when the task text contains a false-positive
      preposition match, reproduced with the exact sentence from this report.
- [x] `resolveTargetPath()` still throws `TARGET_PATH_REQUIRED_ERROR` when
      neither an explicit path nor `ORCHESTRAI_PROJECT_PATH` resolves.
- [x] Existing `packages/shared/project-path.test.ts` cases continue to pass
      unchanged (one case's assertion was intentionally updated, per this
      spec's approved behavior change, not left silently broken — see
      Verification Results).
- [x] A new regression test reproduces the exact reported sentence and
      asserts it falls back to the configured path instead of throwing.
- [x] A new regression test confirms a genuinely malformed relative-path match
      (`at projects/sample-app`, the same `extractExplicitTargetPath` code
      path a quoted malformed path would take) with no configured default
      still produces the existing `TARGET_PATH_REQUIRED_ERROR`, not a silent
      success.
- [x] Orchestrator's `/events` heartbeat interval is below Bun's default
      10-second idle timeout.
- [x] Live verification: with the Orchestrator dashboard open for 65+
      seconds, zero `[Bun.serve]: request timed out` lines appeared in the
      Orchestrator's log.
- [x] `bun test` remains fully green after both changes.
- [x] No regression in the existing manual scenario list (dockerize approval,
      analyze-project combined result, etc.) re-run after the fix.

## Verification Results (2026-08-08)

- `bun test`: **52 pass, 0 fail, 89 expectations, 7 files** (up from 49/86/7
  before this checkpoint — 3 new cases added to
  `packages/shared/project-path.test.ts`).
- Updated the pre-existing "rejects a relative explicit path" test to assert
  the new, spec-approved behavior: it now expects `TARGET_PATH_REQUIRED_ERROR`
  instead of the old, more specific "Task path must be an absolute path"
  message, since a syntactic-but-non-absolute match is now treated as "no
  explicit path" rather than a hard error.
- Live: `POST /tasks` with `{"text":"if i need fully deploy how to do that in
  steps my project will be in bun"}` and `ORCHESTRAI_PROJECT_PATH` set to
  `C:\Users\moham\orch-scratch` — the generated plan's `analyze-project` step
  **completed** against the configured path (previously failed with `Task
  path must be an absolute path: do`). Its `dockerize` step correctly still
  reached `input-required` before any write, and was rejected to leave the
  scratch project untouched.
- Live: started the full `bun run dev` stack, opened the Orchestrator
  dashboard, left it open for 65+ seconds while running the check above, then
  scanned the Orchestrator's stdout log — **zero** occurrences of `timed out`.
- Bundle check: `bun build apps/orchestrator/index.ts --no-bundle
  --target=bun` transpiled cleanly after the heartbeat-interval change.
- Full stack (ports 3000–3006) stopped cleanly after verification; no
  processes or listeners left behind.

## Verification Plan

1. `bun test` — full suite, before and after, expect no regressions.
2. Unit: add the two new `project-path.test.ts` cases described above; run
   `bun test packages/shared/project-path.test.ts`.
3. Live: start `bun run dev`, open the Orchestrator dashboard, leave it open
   ≥60 seconds, confirm no idle-timeout log line and no console error.
4. Live: resubmit the exact reported sentence
   (`"if i need fully deploy how to do that in steps my project will be in bun"`)
   with `ORCHESTRAI_PROJECT_PATH` set to a disposable scratch project, confirm
   the plan's `analyze-project` step now resolves to the configured path
   instead of failing with `Task path must be an absolute path: do`.
5. Live: resubmit a task with a deliberately malformed quoted path and no
   `ORCHESTRAI_PROJECT_PATH` configured, confirm it still fails clearly
   (`TARGET_PATH_REQUIRED_ERROR`) rather than silently resolving to something
   unintended.

## Rollback

Both changes are single-purpose, single-file, few-line diffs
(`packages/shared/index.ts` and `apps/orchestrator/index.ts`) with no shared
state or migration — either can be reverted independently by re-applying the
prior literal (throw vs. return `null`; `5000` vs. `15000`) with no other
cleanup required.

## Review Request

Before implementation, Yusuf should explicitly answer either:

```text
Approved specs/007-parsing-and-sse-reliability-fixes/spec.md as written.
```

or list specific changes needed. No implementation is authorized by
discussion of the reproduction alone.
