---
id: 014-typecheck-ci
title: Make Type Checking Reproducible and CI Actually Pass
area: quality-gates
change_type: governance
status: implemented
verification: verified
created: 2026-08-09
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-09
implemented_on: 2026-08-09
amends: []
supersedes: []
superseded_by: []
related:
  - 019-cicd-recreate-and-binary-builds
---

# Spec: Make Type Checking Reproducible and CI Actually Pass

> Status: **APPROVED ("Approve both") and IMPLEMENTED on 2026-08-09. See
> Verification Results below.**

## Purpose

CLAUDE.md's own priority list (#2) calls for "reproducible type checking
and broader repository tests/CI." `.github/workflows/ci.yml` (modified
externally earlier this session — left as-is per instruction) already
calls `bun run typecheck`, but that script does not exist in `package.json`
at all, and even if it did, `bunx tsc --noEmit` reports 201 real errors
right now. As it stands, any push or PR gets a red CI check for two
independent reasons stacked on top of each other.

## Verified Current Behavior

- `package.json` has no `"typecheck"` script (confirmed by reading it).
- `bunx tsc --noEmit` now actually **runs** (TypeScript is a declared
  devDependency, added earlier this session) — it previously could not run
  reliably per CLAUDE.md's older caveat; that caveat is now stale in the
  "cannot run" sense, though the newly-surfaced 201 errors are a real,
  separate problem.
- The errors cluster into three root causes, confirmed by reading the
  actual failures and the relevant type declarations:
  1. **`apps/tui/index.tsx` (~140 of the 201 errors, TS7026)** —
     `tsconfig.json` sets `"jsx": "react-jsx"` with no `jsxImportSource`,
     so TypeScript resolves JSX intrinsics (`<box>`, `<text>`,
     `<scrollbox>`, etc.) against the plain `react` package's own
     `JSX.IntrinsicElements`, which has no idea what a `<box>` is.
     `@opentui/react` ships its own `jsx-namespace.d.ts` declaring exactly
     these intrinsics — it's just never wired up. Fix is a one-line
     per-file pragma, not a rewrite.
  2. **`packages/shared/mcp-client.ts`, `packages/mcp/index.test.ts`,
     `packages/mcp/project-file-tools.test.ts` (~55 errors)** — the
     installed MCP SDK version's `client.callTool()` return type has an
     `unknown`-typed `content` field (a passthrough/looser schema than the
     nominal `CallToolResult` shape actually returned at runtime).
     **Correction found during implementation:** `mcp-client.ts:274-276`
     was *not* already a working pattern as this draft assumed — it fails
     the same way (`result.content` is `unknown` there too). All three
     files needed the same fix: an explicit cast to
     `{ type: string; text: string }[]` immediately after the SDK call,
     applied consistently rather than copying an existing correct example.
  3. **`apps/orchestrator/index.ts` (3 errors)** — one `JSON.parse()` result
     used without a local type annotation (`detail` inferred as `unknown`,
     same shape gap as elsewhere in the same function that already has one
     two lines above it); and one comparison TypeScript reports as having
     "no overlap" — see Non-Goals/Follow-up below, this one needs a look,
     not a blind cast.

## Proposed Behavior

1. Add `"typecheck": "tsc --noEmit"` to `package.json` scripts — makes the
   already-existing CI step resolve to something real.
2. Fix category 1: add `/** @jsxImportSource @opentui/react */` as the
   first line of `apps/tui/index.tsx` (scoped to that one file, not a
   global `tsconfig.json` change — no other file in the repo emits JSX, so
   there's no reason to widen the global JSX source and risk affecting
   anything else).
3. Fix category 2: apply the same content-casting pattern already used
   correctly in `mcp-client.ts:274-276` at the remaining call sites in
   `packages/mcp/index.test.ts` and `packages/mcp/project-file-tools.test.ts`
   (test-only files — no production code path changes).
4. Fix category 3's annotation gap the same way as its neighboring line.
5. **Investigate (not blindly fix) the "no overlap" comparison** at
   `apps/orchestrator/index.ts:309` — determine whether the SSE stream's
   early-exit-on-completion is genuinely dead code (the type narrowing
   suggests `task.status` can't be "completed"/"failed" at that point) and
   report back before deciding the fix: either the type declaration feeding
   into this is stale (safe to correct the type) or the early-exit really
   never fires (worth understanding why before just widening the type to
   make the error go away, since that would mask a real behavior gap
   instead of fixing it).
6. Once `bunx tsc --noEmit` is clean, verify `bun run typecheck` succeeds
   and the CI workflow's steps would pass in sequence locally
   (`bun install --frozen-lockfile && bun run typecheck && bun test`).

## Safety Constraints

- No behavior change to any runtime agent logic from categories 1-4 — these
  are type-annotation/pragma/cast fixes only, verified by `bun test`
  remaining green throughout and no change to any `.ts` file's actual
  runtime logic (only type-level casts/annotations/pragma comments).
- Category 5 is explicitly called out as "investigate first" specifically
  *because* it could be a real behavior gap, not because the type error is
  hard to silence — the safety constraint here is: do not add a type
  assertion that just suppresses the error without first confirming what
  the code is actually supposed to do.
- No change to `.github/workflows/ci.yml` (left as-is per prior
  instruction) — this spec only makes the script it already calls exist and
  succeed.

## In Scope

1. `package.json`: add the `typecheck` script.
2. `apps/tui/index.tsx`: one-line JSX pragma.
3. `packages/mcp/index.test.ts`, `packages/mcp/project-file-tools.test.ts`:
   apply the existing cast pattern from `mcp-client.ts`.
4. `apps/orchestrator/index.ts`: the annotation fix, plus the investigation
   (and then a fix, once its outcome is understood) for the "no overlap"
   comparison.
5. Verify `bunx tsc --noEmit` reports zero errors afterward.

## Out of Scope / Non-Goals

- Enabling any additional `tsconfig.json` strictness flags beyond what's
  already set — this is about making the *existing* configuration's
  results clean, not raising the bar further.
- Adding a lint configuration (ESLint/Biome) — not mentioned in CLAUDE.md's
  priority item, separate scope if wanted later.
- Fixing the "no overlap" comparison's *root behavior* sight-unseen before
  reporting what's actually going on — see Safety Constraints.

## Acceptance Criteria

- [x] Yusuf approves this spec ("Approve both").
- [x] `bun run typecheck` exists and exits 0 with zero errors.
- [x] `bun test` remains fully green (104+ pass, 0 fail) throughout.
- [x] The SSE early-exit investigation is reported back with a concrete
      finding (stale type vs. genuine dead code) before that specific fix
      lands.
- [x] A local dry-run of the CI workflow's three steps in sequence
      (`bun install --frozen-lockfile`, `bun run typecheck`, `bun test`)
      succeeds end to end.

## Verification Results (2026-08-09)

- **SSE early-exit investigation — finding: real code, TS limitation, not
  dead code.** Confirmed by reading `applyAgentUpdate()`
  (`apps/orchestrator/index.ts:216-240`): it directly mutates
  `task.status = "completed"` / `"failed"` in place on the passed-in
  object. `subscribeToAgentStream()`'s early-exit check three lines after
  that call was flagged by TS only because TypeScript's control-flow
  narrowing doesn't account for a property being mutated through an
  intervening function call — a well-known, long-standing TS limitation,
  not a bug in this code. Fix: `const currentStatus = task.status as
  OrchestratorTask["status"]` — an explicit cast (not just a wider type
  annotation, which TS still narrowed through) gives the comparison a
  fresh, honest starting point instead of masking or removing the check.
  Live-verified afterward: submitted a real `git-status` task through the
  full running stack and confirmed it reached `completed` correctly.
- Added `@types/react` as a devDependency — the actual remaining cause of
  most `apps/tui/index.tsx` errors after the JSX pragma fix (cascading
  "implicit any" from unresolved React hook generics), not a second
  unrelated problem.
- `apps/tui/index.tsx`'s `<input onSubmit>` prop required an `as any` cast
  in the end, not a reconstructed intersection type — the type expects
  `@opentui/core`'s own internal `SubmitEvent` class (not the DOM one,
  not importable from application code), and OpenTUI's runtime always
  calls the handler with a plain string in practice (confirmed throughout
  this session's live TUI testing).
- `bunx tsc --noEmit`: 201 errors → **0 errors**, confirmed both directly
  and via `bun run typecheck`.
- `bun test`: 104 pass, 0 fail, 168 expectations, 12 files — unchanged
  throughout every fix.
- Full local CI dry-run — `bun install --frozen-lockfile && bun run
  typecheck && bun test` — ran in exact sequence, exit 0.
- Live runtime sanity check: started the full `bun run dev` stack,
  submitted a real `git-status` task end to end, confirmed it reached
  `completed` with correct output — the SSE-narrowing fix touched real
  dispatch code, so this wasn't skipped.
- Incidentally found and removed a stray `nul` file at the repo root — a
  byproduct of this session's own earlier `bun build --outfile=/dev/null`
  verification commands on Windows (where `/dev/null` isn't a valid path,
  so Bun created a literal file named `nul` instead).

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/014-typecheck-ci/spec.md as written.
```

or list specific changes needed.
