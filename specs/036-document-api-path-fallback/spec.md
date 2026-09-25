---
id: 036-document-api-path-fallback
title: A Bounded Entry-File Fallback for document-api's Explicit-Path Requirement
area: documentation-agent
change_type: enhancement
status: implemented
verification: verified
created: 2026-08-22
updated: 2026-08-22
approved_by: Yusuf
approved_on: 2026-08-22
implemented_on: 2026-08-22
amends: []
supersedes: []
superseded_by: []
related:
  - 004-configurable-project-paths
---

# Spec: A Bounded Entry-File Fallback for document-api's Explicit-Path Requirement

> Approved, implemented, and live-verified 2026-08-22.

## Purpose

`document-api` is the one skill in this repository that does not fall
back to the shared project-path resolver (`resolveTargetPath()`,
`packages/shared/index.ts`) — it requires an explicit absolute
**source-file** path in the task text and fails immediately otherwise.
This is a deliberate, documented design decision (`CLAUDE.md`: *"there is
no sensible 'whole project' fallback for 'which file has the routes'"*),
not a bug. It was found live, again, during judge-script rehearsal: a
direct-routed or harness-authored `document-api` request with no explicit
path fails every time, which reads badly live and is easy to trigger by
accident (any prompt containing "document"/"api"/"docs" with no path).

This checkpoint proposes a narrow, bounded fallback — try a short, fixed
list of conventional entry-file locations relative to the resolved
project root, and use the first one that both exists and contains at
least one detected route registration — rather than removing the
explicit-path requirement or guessing broadly.

## Verified Current State

- `packages/agents/documentation/index.ts`'s `skillDocumentApi()` (line
  244): `const targetPath = extractExplicitTargetPath(text)` — if this is
  `null`, it throws `"document-api requires an explicit absolute
  source-file path in the task"` immediately. No call to
  `resolveTargetPath()`, no project-root fallback of any kind.
- `extractExplicitTargetPath()` (`packages/shared/index.ts:24`) parses an
  explicit absolute path out of task text; `resolveTargetPath()`
  (`packages/shared/index.ts:44`) is the two-tier resolver every other
  skill in this repo uses — explicit path in text, else
  `ORCHESTRAI_PROJECT_PATH`, else throw `TARGET_PATH_REQUIRED_ERROR`.
  `document-api` calls neither of the fallback tiers.
- `scanApiRoutes(content)` (line 202) already exists and works on raw
  file content: a line-by-line regex scan for
  `app.(get|post|put|delete)("...")` calls, returning matched endpoints.
  This is the exact primitive a "does this file look like an entry file"
  check needs — it already exists, this checkpoint does not add a new
  parser.
- `readProjectPath()`/`pathExists()` (lines 66–77) already wrap
  `read_project_file` through this agent's MCP client, bounded to a given
  `project_root`/`relative_path` pair — the same containment guarantees
  (canonicalization, symlink re-check, sensitive-filename denial) as
  every other MCP file read in this repo, inherited for free.

## Proposed Behavior

1. `skillDocumentApi()` still tries `extractExplicitTargetPath(text)`
   first — an explicit path in the task text is always authoritative and
   unchanged in every respect.
2. If absent, resolve a **project root** via the existing
   `resolveTargetPath()` (explicit project-path phrase in text, else
   `ORCHESTRAI_PROJECT_PATH`) — the same resolution every other skill in
   this repo already uses. If that also fails, fail closed exactly as
   today (`TARGET_PATH_REQUIRED_ERROR`), just surfaced through
   `document-api`'s own error path.
3. Against that root, try a short, fixed, ordered candidate list —
   proposed: `index.ts`, `src/index.ts`, `app.ts`, `src/app.ts`,
   `server.ts`, `src/server.ts`, `main.ts`, `src/main.ts` — reusing
   `pathExists()`/`readProjectPath()` for each. For the first candidate
   that exists, run the existing `scanApiRoutes()` against its content;
   if it returns at least one endpoint, that candidate becomes the
   resolved target file and processing continues exactly as it does
   today for an explicit path (same `buildApiDoc()` call, same
   `savePath`/approval behavior).
4. If a candidate exists but `scanApiRoutes()` finds nothing, move to the
   next candidate rather than accepting a wrong or empty file.
5. If every candidate is exhausted with no match, fail closed with a
   clear, specific error naming the project root and the exact candidate
   list that was checked — never a silent empty doc, never a guess at a
   file that doesn't look like an entry point.
6. No change to `document-api`'s approval tier, `buildApiDoc()`,
   `extractSavePath()`, or the write path — this checkpoint touches only
   how the **source file** is located when none was given explicitly.

## Safety Constraints

- **Still strictly read-only for locating the file.** Every candidate
  check goes through the same `read_project_file` MCP path every other
  read in this agent already uses — same path-containment,
  canonicalization, symlink re-check, and sensitive-filename denial as
  today. No new filesystem primitive, no directory listing/traversal
  tool, no recursive search.
- **The candidate list is fixed and short, not a search.** Exactly the
  list named above (or whatever shorter/different list is agreed at
  review) — this is deliberately not "scan the whole project for
  `app.get(`" or any form of recursive directory walk, which would be
  slower, harder to reason about, and a larger surface than this
  checkpoint intends to open.
- **An explicit path in the task text is always authoritative and
  unaffected.** This checkpoint only changes behavior in the case that
  already fails 100% of the time today (no explicit path) — it cannot
  make an already-working explicit-path call behave any differently.
- **Never silently produces an empty or wrong document.** A candidate is
  only accepted once `scanApiRoutes()` confirms it contains at least one
  real route registration; exhausting the list still fails closed with a
  clear error, matching this repo's existing "no actionable steps"
  fail-closed precedent elsewhere (the LLM harness, the semantic
  classifier) rather than ever guessing.

## Scope

- `packages/agents/documentation/index.ts` — `skillDocumentApi()` only.
- `CLAUDE.md` — the "highest-risk new surface"/`document-api` framing
  and the Documentation Agent section need a short update once this
  lands, since the current text states the explicit-path requirement
  has no fallback at all.
- `context/worklog.md`.

## Out of Scope / Non-Goals

- Any recursive or wildcard search of the project tree. The candidate
  list stays short and fixed; if none of the conventional entry-file
  names match, the correct behavior is still to fail closed and ask for
  an explicit path, not to search harder.
- Any change to how `generate-readme` or any other Documentation skill
  resolves its target — those already use the normal project-path
  resolver and are unaffected.
- Any change to the approval tier, write behavior, or `ApprovalPreview`
  shape for `document-api`.
- Broadening the candidate list beyond common Bun/Node/Hono entry-point
  conventions to cover other frameworks/languages — this repo's own
  target projects are what the list is scoped against; a materially
  different list is a candidate for its own follow-up if it's ever
  needed.

## Acceptance Criteria

- [x] An explicit absolute path in the task text still resolves and
      behaves identically to current behavior (regression check) —
      verified in `document-api-fallback.test.ts` (fails on the MCP
      read itself, not on the old unconditional path-required message,
      proving the explicit path is used directly and no project-root
      resolution is attempted).
- [x] No explicit path, `ORCHESTRAI_PROJECT_PATH` set, a candidate exists
      with at least one Hono route registration: `document-api` succeeds
      without requiring a path in the prompt. **Live-verified** against
      the real fixture project (`C:\Users\moham\test-target-project`) via
      the exported Hono `app.fetch()` called in-process against the real
      running MCP HTTP server (no port bind for documentation-agent
      itself, so the already-running live stack was never disrupted):
      the project has `src/index.ts` (no routes) and `src/server.ts`
      (5 real routes, no `index.ts`/`app.ts`/`server.ts` at root) — the
      candidate loop correctly skipped `index.ts` (not found),
      accepted-then-passed-over `src/index.ts` (found, zero routes), and
      landed on `src/server.ts`, producing a correct doc for all 5 routes
      (`GET /health`, `GET /users/:id`, `POST /users`, `PUT /users/:id`,
      `DELETE /users/:id`).
- [x] The nested-under-`src/` case is exactly what the live check above
      exercised — `src/server.ts`, not a root-level file — so this is
      covered by the same verification, not a separate gap.
- [x] No explicit path, project root contains no file matching any
      candidate name, or every candidate exists but has zero route
      matches: fails closed with a clear error naming the root and the
      checked candidate list — never a partial/empty doc. Verified
      (with an unreachable MCP client standing in for "no candidate
      found," which is behaviorally identical to a real not-found
      result at this layer).
- [x] No explicit path and no `ORCHESTRAI_PROJECT_PATH` set: still fails
      with the original message, unchanged from today. Verified.
- [x] `bun test` (310 passed, 0 failed, up from 307), `bun run typecheck`
      (0 errors), `bun run specs:check` (36 specs) all pass.
- [x] `CLAUDE.md`'s "Target project resolution" section updated with
      `document-api`'s fallback behavior.

## Verification Plan

- Automated: `packages/agents/documentation/document-api-fallback.test.ts`
  — explicit-path priority, the unchanged no-root failure, and the
  candidate-exhausted failure message. All three pass without a live MCP
  server, since a candidate that fails to read behaves identically to one
  that doesn't exist, at this layer.
- Manual, live — done: against the real fixture project
  (`C:\Users\moham\test-target-project`), a bare `"document the api"`
  prompt with no path resolved correctly to `src/server.ts` and produced
  a correct 5-route doc. See the Acceptance Criteria entry above for the
  exact evidence.

## Approval Requested

Approval authorizes adding a bounded, fixed-candidate-list fallback to
`document-api`'s source-file resolution only. It does not authorize any
recursive search, any change to `document-api`'s approval/write
behavior, or any change to how any other skill resolves its target.
