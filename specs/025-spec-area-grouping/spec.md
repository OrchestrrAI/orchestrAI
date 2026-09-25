---
id: 025-spec-area-grouping
title: Specification Area Grouping and Amendment Semantics
area: spec-governance
change_type: enhancement
status: implemented
verification: verified
created: 2026-08-16
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-16
implemented_on: 2026-08-16
amends:
  - 023-spec-governance-and-catalog
  - 024-spec-folder-migration
supersedes: []
superseded_by: []
related:
  - 023-spec-governance-and-catalog
  - 024-spec-folder-migration
---

# Spec: Specification Area Grouping and Amendment Semantics

> Status: **APPROVED by Yusuf, IMPLEMENTED AND VERIFIED on 2026-08-16.**
> See `verification.md` for the acceptance matrix and exact evidence.

## Purpose

Make the catalog distinguish a long-lived feature or engineering area from the
individual specification checkpoints that evolve it.

The numbered directories currently identify specifications, but the governance
documentation sometimes calls them "feature folders." That wording implies one
directory equals one feature. The repository already disproves that model:

- `021-ag-ui-event-protocol` and `022-ag-ui-demo-stabilization` are two
  checkpoints in the same AG-UI area; and
- `023-spec-governance-and-catalog` and `024-spec-folder-migration` are two
  checkpoints in the same specification-governance area.

The intended model is:

```text
engineering area / initiative
└── one or more immutable numbered specification checkpoints
```

This preserves approval and implementation history without presenting related
checkpoints as unrelated features.

## Verified Current State

- The catalog contains 24 specifications before this draft and groups them only
  by lifecycle status.
- A numbered directory name is immutable and its `id` must match
  `<NNN-kebab-case>/spec.md`.
- Frontmatter is closed: `scripts/spec-catalog.ts` rejects every key not listed
  in its required-key set, and `specs/schema/spec.schema.json` sets
  `additionalProperties: false`.
- Existing relationships express whole-spec replacement (`supersedes` /
  `superseded_by`) or an untyped association (`related`). They cannot say that
  one checkpoint changes only part of an older decision.
- `023` retains the original flat-layout decision as historical evidence and
  documents that `024` later amended that layout. The relationship is currently
  represented only as `related` plus prose.
- Generated `specs/README.md` and `specs/catalog.json` are protected by
  `bun run specs:check`, with focused tests in `scripts/spec-catalog.test.ts`.
- No existing specification needs to be moved, renumbered, deleted, or have its
  lifecycle/verification state changed to implement grouping.

## Proposed Behavior

### 1. Add three required metadata fields

Every specification frontmatter will add:

```yaml
area: ag-ui
change_type: enhancement
amends:
  - 021-ag-ui-event-protocol
```

#### `area`

- Required, singular, and formatted as stable lower-case kebab-case.
- Identifies the primary long-lived feature or engineering area.
- Is not a filesystem path, ownership assignment, lifecycle state, or ordering
  mechanism.
- Does not require related checkpoints to be stored together physically.
- Must not be renamed merely for presentation; an intentional area rename is a
  reviewed metadata migration.

A single primary area is deliberate. Multi-area arrays would duplicate a
checkpoint in the human catalog and make ownership ambiguous. Cross-cutting
associations continue to use `related`.

#### `change_type`

Required and restricted to:

| Value | Meaning |
|---|---|
| `feature` | Introduces the first usable capability in an area. |
| `enhancement` | Extends an existing capability or contract. |
| `fix` | Corrects behavior that was already intended. |
| `migration` | Changes representation, layout, storage, or integration shape while preserving the governing capability. |
| `spike` | Time-bounded evaluation that does not itself approve adoption. |
| `governance` | Establishes engineering process, policy, validation, or quality gates. |

The type describes the checkpoint, not its current lifecycle status.

#### `amends`

- Required as a unique array of specification IDs; use `[]` when empty.
- Means this checkpoint changes or extends part of an older specification while
  leaving the older implementation/history meaningful.
- Is directional: the newer checkpoint names the older one.
- Does not require a reciprocal `amended_by` field in historical frontmatter.
- Must reference existing IDs, must not reference itself, and must not contain
  a cycle.
- Must not be used where the newer contract replaces the entire governing
  specification; that remains the reciprocal `supersedes` / `superseded_by`
  relationship.

The generated catalogs will derive `amended_by` from all `amends` edges so
future amendments do not require editing completed historical specs.

### 2. Group the human catalog by area

The generated `specs/README.md` will contain:

1. a compact lifecycle summary with counts by status and verification;
2. authoring and lifecycle guidance; and
3. an alphabetical **Specifications by area** section.

Each area table will list checkpoints by immutable numeric ID and show title,
change type, lifecycle status, verification, artifacts, dates, `amends`, and
derived `amended by`. This replaces the current status-only sections; status
remains directly visible and summarized rather than becoming the top-level
grouping.

Example:

```text
AG-UI
├── 021  feature      implemented / verified
└── 022  enhancement  draft / pending       amends 021

Spec Governance
├── 023  governance   implemented / verified
├── 024  migration    implemented / verified  amends 023
└── 025  enhancement  draft / pending         amends 023, 024
```

### 3. Extend the machine catalog without duplicating source metadata

- Bump generated `catalog.json` from `schema_version: 2` to
  `schema_version: 3`.
- Preserve its flat `specs` list for simple consumers.
- Include the three new source fields on every item.
- Add derived `amended_by` to every generated item.
- Add a generated top-level `areas` index containing each area and its ordered
  specification IDs.

Frontmatter remains the only source of truth. `amended_by` and the area index
must never be hand-maintained.

### 4. Backfill the current specifications using an approved fixed map

Implementation must use this map rather than invent classifications midway:

| ID | Area | Change type | Amends |
|---|---|---|---|
| `001-testing-agent` | `testing-agent` | `feature` | — |
| `002-documentation-agent` | `documentation-agent` | `feature` | — |
| `003-security-agent` | `security-agent` | `feature` | — |
| `004-configurable-project-paths` | `project-targeting` | `feature` | — |
| `005-mcp-agent-integration` | `agent-integration` | `feature` | — |
| `006-runtime-stabilization` | `runtime-reliability` | `fix` | — |
| `007-parsing-and-sse-reliability-fixes` | `runtime-reliability` | `fix` | `004-configurable-project-paths`, `006-runtime-stabilization` |
| `008-routing-fixes` | `routing-planning` | `fix` | — |
| `009-dockerization` | `deployment` | `feature` | — |
| `010-tui-cli` | `tui` | `feature` | — |
| `011-remaining-agents-mcp` | `agent-integration` | `enhancement` | `005-mcp-agent-integration` |
| `012-tui-interactive` | `tui` | `enhancement` | `010-tui-cli` |
| `013-security-skill-detection` | `security-agent` | `fix` | `003-security-agent` |
| `014-typecheck-ci` | `quality-gates` | `governance` | — |
| `015-routing-planning-polish-2` | `routing-planning` | `fix` | `008-routing-fixes` |
| `016-orchestrai-supervisor` | `runtime-supervision` | `feature` | — |
| `017-standalone-binary-distribution` | `distribution` | `feature` | — |
| `018-supervisor-project-path` | `runtime-supervision` | `enhancement` | `016-orchestrai-supervisor`, `017-standalone-binary-distribution` |
| `019-cicd-recreate-and-binary-builds` | `ci-cd` | `feature` | `014-typecheck-ci`, `017-standalone-binary-distribution` |
| `020-semantic-intent-fallback` | `routing-planning` | `enhancement` | `008-routing-fixes`, `015-routing-planning-polish-2` |
| `021-ag-ui-event-protocol` | `ag-ui` | `feature` | — |
| `022-ag-ui-demo-stabilization` | `ag-ui` | `enhancement` | `021-ag-ui-event-protocol` |
| `023-spec-governance-and-catalog` | `spec-governance` | `governance` | — |
| `024-spec-folder-migration` | `spec-governance` | `migration` | `023-spec-governance-and-catalog` |
| `025-spec-area-grouping` | `spec-governance` | `enhancement` | `023-spec-governance-and-catalog`, `024-spec-folder-migration` |

This is a one-time metadata annotation. It must not rewrite the historical body,
approval evidence, acceptance results, or verification status of specifications
`001` through `024`.

### 5. Correct directory terminology

Active templates, generated guidance, `CLAUDE.md`, validator errors, and tests
will call the numbered directories **specification/checkpoint directories**, not
feature directories. No physical path changes are required.

Future authoring guidance will state:

- one area may contain many numbered checkpoints;
- a draft absorbs related scope discovered before approval/implementation;
- an implemented checkpoint is not reopened for a new material behavior change;
- a later checkpoint is justified only when it needs independent approval,
  migration, risk control, or verification; and
- tiny implementation corrections that remain inside an approved checkpoint do
  not receive a new specification solely to increase the sequence number.

## Scope

1. Extend `specs/schema/spec.schema.json` for `area`, `change_type`, and
   `amends`.
2. Extend `scripts/spec-catalog.ts` parsing, validation, relationship checks,
   human grouping, machine output, and terminology.
3. Extend `scripts/spec-catalog.test.ts` with focused metadata, amendment,
   grouping, derived-index, and compatibility tests.
4. Backfill the fixed metadata map into specifications `001` through `025`.
5. Update the spec template, generated catalog guidance, and relevant active
   `CLAUDE.md` authoring language.
6. Regenerate `specs/README.md` and `specs/catalog.json`.
7. Record implementation and verification evidence in this checkpoint's
   `verification.md` and `context/worklog.md` after approval.

## Safety and Compatibility Constraints

- Never renumber, move, delete, merge, or recreate an existing specification
  directory.
- Do not change lifecycle status, verification confidence, approval dates, or
  implementation dates while backfilling classification metadata.
- Do not rewrite historical spec bodies to make old decisions appear as though
  the new grouping model existed at the time.
- `supersedes` semantics and its reciprocal validation remain unchanged.
- `amends` must not imply that an older implemented checkpoint is invalid.
- Generated output must be deterministic on Windows and Linux.
- `bun run specs:check` remains read-only and must fail clearly for stale
  generated catalogs or invalid/missing metadata.
- Existing JSON catalog consumers receive an explicit schema-version bump
  rather than an unannounced structural change.

## Out of Scope / Non-Goals

- Merging `021` with `022` or `023` with `024`.
- Renumbering directories so one number represents an entire area.
- Changing any runtime, agent, MCP, A2A, approval, TUI, or SSE behavior.
- Adopting `@ag-ui/*`; that belongs in the revised `022` checkpoint.
- LangGraph, Traycer, Google ADK, LangChain, or Pi Agent evaluation.
- Assigning code ownership, teams, priorities, dependencies, milestones, or
  release versions through `area`.
- Supporting multiple primary areas on one specification.
- Automatically inferring areas or change types from titles.

## Acceptance Criteria

- [x] Yusuf explicitly approves the field names, enum, catalog layout, and
      fixed backfill map before implementation.
- [x] All specification frontmatter validates with required `area`,
      `change_type`, and `amends` fields.
- [x] Invalid area names, invalid change types, missing amendment targets,
      self-amendments, duplicate amendments, and amendment cycles are rejected.
- [x] `supersedes` and `amends` retain their distinct documented semantics.
- [x] Human catalog groups checkpoints by area while retaining visible status,
      verification, artifact, date, and relationship information.
- [x] JSON catalog is schema version 3 and contains deterministic `areas` and
      derived `amended_by` data.
- [x] The approved fixed map is applied without changing historical bodies or
      lifecycle/verification metadata.
- [x] Active guidance uses specification/checkpoint terminology and explains
      when to extend a draft versus create a new checkpoint.
- [x] Focused spec-catalog tests pass with new validation and grouping coverage.
- [x] `bun run specs:catalog`, `bun run specs:check`, `bun run typecheck`, and
      the full `bun test` suite pass.
- [x] `verification.md` and `context/worklog.md` record exact evidence and any
      remaining limitations.

## Verification Plan

1. Add focused parser tests for all new required fields and enum/pattern rules.
2. Add relationship tests for existing, missing, duplicate, self-referencing,
   and cyclic `amends` edges.
3. Snapshot/assert that area grouping is deterministic and that status remains
   visible.
4. Assert reverse `amended_by` and the JSON `areas` index are derived correctly.
5. Run write mode followed by check mode twice and confirm generated files do
   not change on the second pass.
6. Audit all 25 frontmatter blocks against the approved mapping.
7. Confirm no numbered directory path or historical spec body changed.
8. Run type checking and the full test suite.

## Approval Decisions Required

Approval must explicitly confirm:

1. field names: `area`, `change_type`, and one-way `amends`;
2. the six-value `change_type` enum;
3. area-first human catalog plus lifecycle summaries;
4. JSON catalog schema version 3 with derived `amended_by` and `areas`; and
5. the fixed classification map above.

Recommended approval wording:

```text
Approved specs/025-spec-area-grouping/spec.md with the proposed metadata,
catalog layout, JSON v3 output, and fixed 001-025 classification map.
```

## Implementation Results

Implemented on 2026-08-16 after the exact approval wording above:

- added the three required fields to the JSON schema, parser, template, and all
  25 specification frontmatter blocks;
- added one-way amendment reference/cycle validation while leaving reciprocal
  whole-spec supersession unchanged;
- generated lifecycle summaries and 15 alphabetical area sections in the human
  catalog;
- generated JSON catalog schema version 3 with a deterministic `areas` index
  and derived `amended_by` lists;
- corrected active authoring terminology without moving or renumbering a
  directory or rewriting historical spec bodies; and
- added focused coverage for required/invalid metadata, amendment graph safety,
  grouping, reverse derivation, JSON v3, discovery, and stale outputs.

Final verification: focused governance tests 10 pass/0 fail; full suite 148
pass/0 fail/246 expectations; typecheck 0 errors; catalog check and diff check
pass; repeated generation leaves both catalog SHA-256 hashes unchanged.
