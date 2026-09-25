---
id: 023-spec-governance-and-catalog
title: Spec Governance, Lifecycle Metadata, and Catalog
area: spec-governance
change_type: governance
status: implemented
verification: verified
created: 2026-08-16
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-16
implemented_on: 2026-08-16
amends: []
supersedes: []
superseded_by: []
related:
  - 022-ag-ui-demo-stabilization
  - 024-spec-folder-migration
---

# Spec: Spec Governance, Lifecycle Metadata, and Catalog

> Status history: **APPROVED by Yusuf and IMPLEMENTED AND VERIFIED on
> 2026-08-16.** See Implementation and Verification Results below.
>
> Layout amendment: `specs/024-spec-folder-migration/spec.md` later replaced
> this checkpoint's flat-file naming/location decision with immutable numbered
> feature directories. The lifecycle, verification, schema, catalog, and SDD
> rules established here remain active; flat-layout passages below are retained
> as historical implementation evidence, not current authoring guidance.

## Purpose

Make `specs/` understandable and safe for a new teammate or coding agent
without requiring them to reconstruct lifecycle state from prose, unchecked
acceptance boxes, `CLAUDE.md`, and the worklog.

The repository will retain one stable Markdown file per decision/change while
adding:

- machine-readable lifecycle metadata in every spec;
- one generated human catalog and one generated JSON catalog;
- a checked schema and validator;
- explicit lifecycle and supersession rules;
- CI and pre-commit enforcement; and
- a one-time reconciliation of stale status statements.

This is the governance checkpoint that must complete before the pending AG-UI
stabilization work or any LangGraph, Google ADK, Traycer, or Pi integration
specification proceeds.

## Verified Current State

The audit on 2026-08-16 found 22 spec files before this draft and 23 including
this draft.

### What already works

- All feature/change specs use the stable `kebab-case.spec.md` filename style.
- Specifications preserve useful approval decisions, acceptance criteria, and
  verification evidence.
- `CLAUDE.md` defines a strong SDD review gate: specify, review, approve,
  implement, verify, and log.
- CI runs type checking and tests, and the repository pre-commit hook runs the
  test suite.

### Current governance gaps

1. There is no catalog or machine-readable schema.
2. Status is free-form prose and is missing entirely from the foundational
   Testing, Documentation, and Security specs.
3. A checked acceptance box is sometimes being used as status evidence, while
   older specs retain unchecked manual criteria even though the feature exists.
4. Lifecycle state and verification confidence are conflated. For example, an
   implementation may exist while one manual visual check remains pending.
5. Several opening status blocks are stale:
   - `specs/009-dockerization/spec.md` says implementation is in progress although its
     verified results and repository code show completion;
   - `specs/011-remaining-agents-mcp/spec.md` says implementation is in progress although
     its acceptance criteria and current architecture show completion;
   - `specs/021-ag-ui-event-protocol/spec.md` advertises a `toolCallId` limitation that a
     later verified amendment in the same file fixed.
6. Historical foundational specs describe direct filesystem/process execution
   as the current architecture even though later MCP and approval specs revised
   those boundaries.
7. There is no automated protection against duplicate IDs, invalid lifecycle
   transitions, broken metadata references, or a stale generated catalog.
8. Renaming or moving files would currently break many references across
   `CLAUDE.md`, `README.md`, other specs, and context documents.

## Decisions Proposed for Approval

### Decision 1 — Keep the flat directory and stable filenames

All current specs remain directly under `specs/`. Existing filenames will not
be renamed or moved during this checkpoint.

Reasons:

- the repository has only 22 specs, so nested folders do not improve discovery
  enough to justify migration cost;
- filenames are already consistent and serve as stable IDs in many references;
- `git mv` preserves Git history but cannot preserve Markdown references or
  external links automatically; and
- the catalog solves discovery without destabilizing existing handoffs.

New feature/change specs MUST use:

```text
specs/<kebab-case-id>.spec.md
```

The governance guide and generated artifacts are the only non-`.spec.md` files
allowed at the root of `specs/`.

Reconsider subfolders only in a separately reviewed migration if the active
catalog becomes materially hard to navigate (guideline: more than 50 active
specs or a demonstrated ownership/navigation problem). A numeric filename
prefix is explicitly rejected because it couples identity to an ordering that
will change.

### Decision 2 — Separate lifecycle from verification

Every spec receives YAML frontmatter with these required keys:

```yaml
---
id: 004-configurable-project-paths
title: Configurable Target Project Paths
status: implemented
verification: verified
created: 2026-08-08
updated: 2026-08-08
approved_by: Yusuf
approved_on: 2026-08-08
implemented_on: 2026-08-08
supersedes: []
superseded_by: []
related: []
---
```

At this checkpoint, `id` matched the flat filename. After the approved layout
migration, it MUST equal the numbered parent directory. Dates use `YYYY-MM-DD`.
Unknown historical dates may be `null`; they must not be guessed. New specs
created after this checkpoint must provide `created` and `updated` dates.

Allowed lifecycle values:

| `status` | Meaning |
|---|---|
| `draft` | Under review; implementation is not authorized. |
| `approved` | Explicitly approved; implementation may start. |
| `implemented` | Approved behavior exists in the repository. |
| `superseded` | A later spec replaces this spec's governing decision. |
| `archived` | Retained only as history and no longer active guidance. |

Allowed verification values:

| `verification` | Meaning |
|---|---|
| `pending` | Required verification has not run. |
| `partial` | Implementation exists, but named checks remain incomplete. |
| `verified` | All required acceptance evidence is recorded. |
| `not-applicable` | No implementation verification applies, with a reason in the spec. |

`implemented` does not imply `verified`. This prevents a pending manual TUI
check from falsely making implemented code look absent, and prevents existing
code from being called fully verified without evidence.

### Decision 3 — Frontmatter is the lifecycle source of truth

The catalog is derived from frontmatter. Acceptance checkboxes and narrative
status history remain evidence, not lifecycle state.

- A material scope/behavior change to an approved spec returns it to `draft`,
  clears approval metadata, and requires re-approval.
- Verification-only evidence may update `verification`, `updated`, and the
  results section without reopening approval when behavior does not change.
- Status corrections that only reconcile metadata with existing evidence are
  documentation corrections and do not authorize runtime changes.
- Supersession must be explicit and reciprocal: if A lists B in
  `superseded_by`, B lists A in `supersedes`.
- `related` expresses extension/dependency context without claiming that one
  spec fully replaces another.
- Historical prose is preserved where useful but labeled `Historical
  Baseline` when it no longer describes current architecture.

### Decision 4 — Generate catalogs; never maintain duplicate status by hand

Implementation adds:

```text
specs/README.md          governance guide + generated catalog table
specs/catalog.json       generated machine-readable catalog
specs/schema/spec.schema.json   machine-readable metadata schema
scripts/spec-catalog.ts  check/write command
```

`specs/README.md` contains a generated table with:

- ID and title;
- lifecycle status;
- verification state;
- updated date;
- approval/implementation dates when known; and
- supersession relationships.

The table groups entries into `Draft`, `Approved`, `Implemented`,
`Superseded`, and `Archived`; verification remains a separate column.

`specs/catalog.json` exists for agents and tooling. Both catalog outputs are
generated from frontmatter and MUST NOT become competing sources of truth.
Generated sections carry an explicit "do not edit" marker.

Commands:

```text
bun run specs:catalog   # validate and regenerate catalog outputs
bun run specs:check     # read-only validation; fail if outputs are stale
```

The implementation may add the small `yaml` package as a dev dependency for
standards-compliant frontmatter parsing. A custom partial YAML parser is not
acceptable because it would silently create another undocumented schema.

### Decision 5 — Enforce governance in local and CI workflows

`specs:check` MUST fail with an actionable file-specific message for:

- missing or malformed frontmatter;
- filename/ID mismatch or duplicate IDs;
- missing required keys or invalid enum/date types;
- impossible state combinations (for example `draft` with approval metadata,
  or `implemented` with no approval evidence unless explicitly marked as a
  migrated historical exception);
- references in `supersedes`, `superseded_by`, or `related` that do not resolve;
- non-reciprocal or cyclic supersession;
- a generated `specs/README.md` or `specs/catalog.json` that differs from the
  current frontmatter; and
- an unapproved spec claiming completed implementation acceptance criteria
  added after governance adoption.

The validator does not infer status from prose or checkboxes and does not scan
`context/history.md` for link validity; that file is deliberately historical.

Enforcement is added to:

- `.github/workflows/ci.yml` before type checking/tests; and
- `.githooks/pre-commit` before the existing test command.

The hook remains fail-closed if Bun is unavailable. CI and the hook call only
the read-only `specs:check`; neither rewrites files automatically.

### Decision 6 — Migrate and reconcile every existing spec in one checkpoint

The implementation will add frontmatter to all specs and generate the first
catalog. Initial classification, subject to verification during
implementation:

| Spec | Status | Verification |
|---|---|---|
| `ag-ui-demo-stabilization` | `draft` | `pending` |
| `spec-governance-and-catalog` | `implemented` after this checkpoint | `verified` after all criteria pass |
| `ag-ui-event-protocol` | `implemented` | `verified` |
| `cicd-recreate-and-binary-builds` | `implemented` | `verified` |
| `configurable-project-paths` | `implemented` | `verified` |
| `dockerization` | `implemented` | `verified` |
| `documentation-agent` | `implemented` | `partial` |
| `mcp-agent-integration` | `implemented` | `verified` |
| `orchestrai-supervisor` | `implemented` | `partial` |
| `parsing-and-sse-reliability-fixes` | `implemented` | `verified` |
| `remaining-agents-mcp` | `implemented` | `verified` |
| `routing-fixes` | `implemented` | `verified` |
| `routing-planning-polish-2` | `implemented` | `verified` |
| `runtime-stabilization` | `implemented` | `verified` |
| `security-agent` | `implemented` | `partial` |
| `security-skill-detection` | `implemented` | `verified` |
| `semantic-intent-fallback` | `implemented` | `verified` |
| `standalone-binary-distribution` | `implemented` | `verified` |
| `supervisor-project-path` | `implemented` | `verified` |
| `testing-agent` | `implemented` | `partial` |
| `tui-cli` | `implemented` | `partial` |
| `tui-interactive` | `implemented` | `partial` |
| `typecheck-ci` | `implemented` | `verified` |

The foundational agent specs stay `implemented` rather than `superseded`:
later specs changed their execution path and safety policy but did not replace
the agents' core feature contracts. Their `related` metadata will point to the
specs that revised them, and a visible historical-baseline notice will direct
readers to current architecture.

During migration, stale opening status prose is corrected or replaced by a
short status-history section. Approval quotations and verification evidence
are preserved. `context/worklog.md` is append-only: an old "uncommitted"
statement is corrected by a new entry, never rewritten as if history differed.

The generic spec-status reconciliation item in
`specs/022-ag-ui-demo-stabilization/spec.md` is narrowed to AG-UI/TUI-specific docs and
linked to this completed governance checkpoint, avoiding duplicate ownership.

## Implementation Scope

After approval, this checkpoint includes:

1. Add and document the metadata schema.
2. Add metadata to every existing spec.
3. Add deterministic catalog generation and read-only validation.
4. Add focused unit tests for parsing, lifecycle rules, relationship rules,
   and stale-output detection.
5. Generate the human and JSON catalogs.
6. Reconcile the specifically identified stale status/baseline statements.
7. Add `specs:catalog` and `specs:check` package scripts.
8. Enforce `specs:check` in CI and pre-commit.
9. Update `CLAUDE.md` and `README.md` to point contributors to the governance
   guide/catalog and require metadata for new specs.
10. Append the implementation and verification record to
    `context/worklog.md`.

## Safety and Compatibility Constraints

- No runtime, agent, MCP, A2A, AG-UI, approval, routing, or TUI behavior changes.
- No existing spec file is renamed, moved, deleted, or silently rewritten.
- Existing user changes and the unapproved AG-UI draft remain intact.
- Catalog generation must be deterministic across Windows and Linux (sorted by
  stable ID, LF-normalized generated content).
- `specs:check` is read-only and must not mutate the working tree.
- Migration dates and approval identities must come from existing spec/worklog
  evidence or Git history; unknown values remain explicitly `null`.
- A catalog mismatch explains how to repair it (`bun run specs:catalog`).
- YAML parsing must be safe-data parsing only; no executable tags or code
  evaluation.

## Out of Scope / Non-Goals

- Renaming specs, adding numeric prefixes, or reorganizing them into folders.
- Rewriting historical design narratives to look current.
- Automatically deciding whether Yusuf approved a spec from chat text.
- Automatically changing lifecycle status after implementation or tests.
- A hosted spec registry, database, web UI, issue-tracker integration, or GitHub
  approval bot.
- Implementing `specs/022-ag-ui-demo-stabilization/spec.md`.
- Adopting `@ag-ui/*`, LangGraph, Google ADK, Traycer, or Pi Agent.
- Closing the manual/live verification gaps recorded by older specs; this
  checkpoint catalogs those gaps honestly instead.

## Acceptance Criteria

- [x] Yusuf explicitly approves this spec before implementation starts.
- [x] Every then-current specification had valid frontmatter matching the
  schema, with an ID matching its flat filename. The later numbered migration
  revalidated all metadata against parent-directory IDs.
- [x] Lifecycle status and verification confidence are represented separately.
- [x] All migrated values are backed by repository evidence; unknown historical
  dates are `null`, not guessed.
- [x] `specs/README.md` clearly explains authoring, review, transition,
  supersession, and catalog-regeneration rules.
- [x] `specs/README.md` and `specs/catalog.json` are generated deterministically
  from spec frontmatter and contain all specs exactly once.
- [x] `bun run specs:catalog` regenerates both outputs successfully.
- [x] `bun run specs:check` exits 0 on the repository and performs no writes.
- [x] Focused tests prove rejection of malformed metadata, duplicate/mismatched
  IDs, invalid lifecycle combinations, broken/non-reciprocal relationships,
  cycles, and stale generated output.
- [x] CI and pre-commit run the read-only governance check.
- [x] Identified stale status blocks and foundational historical baselines are
  reconciled without deleting approval or verification evidence.
- [x] No spec files were renamed, moved, or deleted.
- [x] `bun run typecheck` exits 0.
- [x] `bun test` passes with no regression from the pre-implementation baseline.
- [x] `git diff --check` passes.
- [x] `CLAUDE.md`, `README.md`, the AG-UI stabilization draft, and
  `context/worklog.md` accurately describe the new governance workflow.

## Verification Plan

After approval and implementation:

1. Run the focused catalog/metadata tests.
2. Run `bun run specs:catalog`, then `bun run specs:check` twice to prove
   deterministic, clean output.
3. Capture `git status --short`, run `bun run specs:check`, and confirm status
   is byte-for-byte unchanged to prove the check command is read-only.
4. Introduce malformed metadata in an isolated temporary fixture and verify
   each actionable failure path without modifying a real spec.
5. Run `bun run typecheck`, `bun test`, and `git diff --check`.
6. Inspect the generated Markdown catalog for all lifecycle groups and every
   spec exactly once.
7. Review the final diff to confirm no runtime source files or spec paths
   changed.

## Implementation and Verification Results

Implemented on 2026-08-16 after Yusuf's explicit approval:

- Added standards-compliant YAML parsing through the `yaml` dev dependency,
  `specs/schema/spec.schema.json`, and `scripts/spec-catalog.ts`.
- Migrated all 23 specs without renaming, moving, or deleting any spec file.
- Generated `specs/README.md` and `specs/catalog.json`; both contain all 23
  specs exactly once and are deterministically sorted by stable ID.
- Added seven focused governance tests (13 expectations) covering valid parse,
  malformed metadata, mismatched/duplicate IDs, lifecycle rules, broken and
  non-reciprocal relationships, cycles, deterministic order, and stale output.
- Added `specs:catalog` and read-only `specs:check`; SHA-256 hashes before and
  after `specs:check` proved that the check does not rewrite catalog files.
- Wired `specs:check` into CI and the existing pre-commit hook before tests.
- Reconciled the known stale opening statuses and marked foundational agent
  descriptions as historical baselines with current-spec pointers.
- Updated `CLAUDE.md`, `README.md`, and the still-unapproved AG-UI stabilization
  draft without changing runtime behavior or approving that separate draft.

Final verification:

- `bun run specs:check`: passed for 23 specs.
- `bun run typecheck`: passed with 0 errors.
- `bun test`: 145 passed, 0 failed, 224 expectations across 15 files (the
  previous 138-test runtime suite plus 7 governance tests).
- `git diff --check`: passed.
- CI/hook wiring was inspected and the shared `specs:check` command passed.
  A direct `sh .githooks/pre-commit` invocation was unavailable from this
  PowerShell environment because `sh` is not on `PATH`; Git/CI shell execution
  was therefore not separately simulated.

## Approval Record

Yusuf approved this specification on 2026-08-16. That approval covered the
metadata migration, generated catalogs, `yaml` dev dependency, and CI/hook
enforcement. It did not approve the separate AG-UI stabilization draft or any
LangGraph, Google ADK, Traycer, Pi, or other framework integration.
