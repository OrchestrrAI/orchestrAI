---
id: 024-spec-folder-migration
title: Numbered Feature Folders for Specification Artifacts
area: spec-governance
change_type: migration
status: implemented
verification: verified
created: 2026-08-16
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-16
implemented_on: 2026-08-16
amends:
  - 023-spec-governance-and-catalog
supersedes: []
superseded_by: []
related:
  - 023-spec-governance-and-catalog
---

# Spec: Numbered Feature Folders for Specification Artifacts

> Status: **APPROVED by Yusuf, IMPLEMENTED AND VERIFIED on 2026-08-16.**
> See `verification.md` for the acceptance matrix, failures/retries, and final
> evidence.

## Purpose

Evolve the newly governed flat `specs/*.spec.md` collection into stable,
numbered feature folders that can hold a specification, implementation plan,
and verification record without turning one Markdown file into an indefinitely
growing mixed-purpose document.

The target structure keeps the lifecycle schema, generated catalogs, and
validation delivered by `spec-governance-and-catalog`; it changes artifact
location and authoring conventions, not the underlying lifecycle decisions.

## Verified Current State

- `specs/` contains 23 governed specs before this draft and 24 including it.
- Every current spec has schema-validated frontmatter and a stable kebab-case
  ID. Twenty-two are implemented, one existing feature spec is draft, and this
  migration becomes the second draft until approved.
- `scripts/spec-catalog.ts` currently discovers only root-level
  `specs/*.spec.md` and enforces `id === filename without .spec.md`.
- `specs/schema/spec.schema.json`, `specs/README.md`, and `specs/catalog.json` are all
  at the root of `specs/`.
- Current specs usually embed proposed plan, acceptance criteria, and
  verification results in one file. Splitting existing prose mechanically
  would risk losing context and producing duplicate sources of truth.
- Active documentation contains many references to the existing
  `specs/<id>.spec.md` paths. Historical `context/history.md` and dated
  `context/worklog.md` entries intentionally preserve earlier statements.
- The approved governance spec explicitly requires a separate reviewed
  migration before moving or renaming specs. This document is that migration.

## Target Structure

```text
specs/
├── README.md
├── catalog.json
├── schema/
│   └── spec.schema.json
├── templates/
│   ├── spec-template.md
│   ├── plan-template.md
│   └── verification-template.md
├── 001-testing-agent/
│   └── spec.md
├── 002-documentation-agent/
│   └── spec.md
├── 003-security-agent/
│   └── spec.md
├── ...
├── 022-ag-ui-demo-stabilization/
│   ├── spec.md
│   └── plan.md
├── 023-spec-governance-and-catalog/
│   ├── spec.md
│   └── verification.md
└── 024-spec-folder-migration/
    ├── spec.md
    ├── plan.md
    └── verification.md
```

Only `spec.md` is mandatory in every numbered feature folder. `plan.md` and
`verification.md` are created when they contain useful information; empty
boilerplate companion files are prohibited.

## Stable Number Assignment

Numbers record creation sequence, never priority, status, dependency order, or
execution order. Once assigned, a number and directory name never change.

The initial mapping follows the repository's historical work sequence recorded
in the specs and worklog. Same-checkpoint ties use the known authoring order.

| Numbered directory | Current spec |
|---|---|
| `001-testing-agent/` | `specs/001-testing-agent/spec.md` |
| `002-documentation-agent/` | `specs/002-documentation-agent/spec.md` |
| `003-security-agent/` | `specs/003-security-agent/spec.md` |
| `004-configurable-project-paths/` | `specs/004-configurable-project-paths/spec.md` |
| `005-mcp-agent-integration/` | `specs/005-mcp-agent-integration/spec.md` |
| `006-runtime-stabilization/` | `specs/006-runtime-stabilization/spec.md` |
| `007-parsing-and-sse-reliability-fixes/` | `specs/007-parsing-and-sse-reliability-fixes/spec.md` |
| `008-routing-fixes/` | `specs/008-routing-fixes/spec.md` |
| `009-dockerization/` | `specs/009-dockerization/spec.md` |
| `010-tui-cli/` | `specs/010-tui-cli/spec.md` |
| `011-remaining-agents-mcp/` | `specs/011-remaining-agents-mcp/spec.md` |
| `012-tui-interactive/` | `specs/012-tui-interactive/spec.md` |
| `013-security-skill-detection/` | `specs/013-security-skill-detection/spec.md` |
| `014-typecheck-ci/` | `specs/014-typecheck-ci/spec.md` |
| `015-routing-planning-polish-2/` | `specs/015-routing-planning-polish-2/spec.md` |
| `016-orchestrai-supervisor/` | `specs/016-orchestrai-supervisor/spec.md` |
| `017-standalone-binary-distribution/` | `specs/017-standalone-binary-distribution/spec.md` |
| `018-supervisor-project-path/` | `specs/018-supervisor-project-path/spec.md` |
| `019-cicd-recreate-and-binary-builds/` | `specs/019-cicd-recreate-and-binary-builds/spec.md` |
| `020-semantic-intent-fallback/` | `specs/020-semantic-intent-fallback/spec.md` |
| `021-ag-ui-event-protocol/` | `specs/021-ag-ui-event-protocol/spec.md` |
| `022-ag-ui-demo-stabilization/` | `specs/022-ag-ui-demo-stabilization/spec.md` |
| `023-spec-governance-and-catalog/` | `specs/023-spec-governance-and-catalog/spec.md` |
| `024-spec-folder-migration/` | `specs/024-spec-folder-migration/spec.md` |

The metadata `id` changes once during this migration to match the complete
numbered directory name. All relationship IDs are rewritten through the same
explicit mapping. After migration, those numbered IDs are immutable.

## Artifact Contracts

### `spec.md` — governing contract

- Mandatory.
- Contains governed YAML metadata, purpose, verified current state, proposed
  behavior/decisions, scope, constraints, non-goals, acceptance criteria, and
  approval record.
- Its `id` MUST exactly match its parent directory name.
- It remains the only artifact that can authorize implementation.

### `plan.md` — implementation strategy

- Optional; recommended for multi-file, multi-phase, risky, or delegated work.
- Contains ordered phases, affected paths, prerequisites, migration/rollback
  considerations, and a checklist mapping back to acceptance criteria.
- Cannot broaden the approved `spec.md`. A material new decision must first be
  added to `spec.md` and re-approved.
- A plan is not lifecycle authority and carries no independent status.

### `verification.md` — evidence record

- Optional before implementation; required when verification detail would make
  `spec.md` unwieldy or when the result includes a test matrix/manual evidence.
- Contains environment, commands/checks, acceptance-criterion results,
  failures/retries, manual evidence, and known limitations.
- Determines whether the `spec.md` metadata may honestly move from `pending`
  or `partial` to `verified`, but does not set status independently.

### Templates

`specs/templates/` contains concise starter files for all three artifacts.
Templates use placeholders that cannot pass repository validation as real
specs and are excluded from catalog discovery.

## Migration Behavior

### 1. Move with Git history

Every current spec is moved with `git mv` to its mapped
`specs/<NNN-id>/spec.md` path. No original specification body, approval quote,
acceptance criterion, or verification result is deleted during migration.

The migration spec itself moves from the temporary current-convention path
`specs/024-spec-folder-migration/spec.md` to
`specs/024-spec-folder-migration/spec.md` as part of implementation.

### 2. Add useful companion artifacts only

- `024-spec-folder-migration/plan.md` records the executed migration order and
  rollback checkpoints.
- `024-spec-folder-migration/verification.md` records path, relationship,
  catalog, CI, typecheck, test, and diff evidence.
- `022-ag-ui-demo-stabilization/plan.md` extracts the already-proposed
  implementation sequence from its draft without approving or changing its
  scope. Its verification file is not created until implementation produces
  evidence.
- `023-spec-governance-and-catalog/verification.md` summarizes the existing
  completed governance evidence while the original detailed results remain in
  `spec.md` as historical approval context.
- Other historical specs retain embedded plans/results in `spec.md`; they gain
  companion files only during a future substantive revision, avoiding empty or
  duplicated artifacts.

### 3. Relocate shared governance assets

- Move `specs/schema/spec.schema.json` to `specs/schema/spec.schema.json`.
- Add the three templates under `specs/templates/`.
- Keep generated `specs/README.md` and `specs/catalog.json` at the root as the
  entry points for humans and tools.

### 4. Update catalog and validation rules

`scripts/spec-catalog.ts` will:

- discover exactly one `spec.md` under each direct child matching
  `^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$`;
- reject root-level `*.spec.md` files after migration;
- reject numbered feature directories with a missing `spec.md`;
- enforce `metadata.id === parent directory name`;
- keep lifecycle, date, relationship, cycle, and catalog-staleness checks;
- exclude `schema/`, `templates/`, and generated root files from feature
  discovery;
- emit catalog paths as `./<numbered-id>/spec.md`;
- include optional `plan` and `verification` artifact paths in `catalog.json`
  and the human catalog when present; and
- continue operating read-only in `specs:check` mode.

Focused tests will use isolated virtual/temporary structures and cover both the
new valid layout and rejected old/malformed layouts.

### 5. Rewrite active references and preserve history honestly

All active references in runtime/developer documentation, current specs,
scripts, tests, templates, and demo documentation are updated to numbered
paths/IDs. This includes at least:

- `CLAUDE.md` and `README.md`;
- every moved `spec.md` relationship and Markdown/code path;
- source comments/test names that cite governing specs;
- `context/instructions.md`, `context/project.md`, and `context/demo/` where
  current paths are referenced; and
- catalog/schema command documentation.

`context/history.md` and existing dated `context/worklog.md` entries are
historical records and are not rewritten. The final worklog entry includes the
old-to-new map and states that older literal paths are historical. The validator
does not treat those two historical files as active-link failures.

No redirect stub specs remain at old paths; duplicate governing files would be
more dangerous than an explicit one-time migration.

## Implementation Scope

After approval:

1. Create the numbered directories and move all 24 specs through the fixed map.
2. Rewrite metadata IDs and all relationship IDs.
3. Move the schema and add the three templates.
4. Add the three useful companion artifacts named above.
5. Update catalog discovery/generation/validation and focused tests.
6. Regenerate `README.md` and `catalog.json`.
7. Update all active path/ID references in scope.
8. Run governance, typecheck, tests, link/path audits, and diff verification.
9. Mark this spec implemented only after all evidence is written to its
   `verification.md` and the worklog.

## Safety and Compatibility Constraints

- No application/runtime behavior changes.
- Use only the approved explicit mapping; never derive destructive move targets
  from unchecked text, globs, status, or catalog order.
- Resolve and verify every source and destination under the repository's
  `specs/` directory before moving.
- Do not overwrite an existing destination directory/file.
- Preserve Git history with `git mv` for tracked files; move current untracked
  draft files without deleting their content.
- Never edit the user's unrelated `.claude/` working-tree content.
- Catalog output is deterministic across Windows/Linux and `specs:check`
  remains read-only.
- Relationship rewriting must be one-to-one and complete; no broken old IDs or
  partially migrated graph is accepted.
- The draft AG-UI spec remains `draft`/`pending`; extracting a plan does not
  approve it.
- If migration verification fails, do not hide or delete evidence. Repair the
  explicit mapping or restore the affected move before claiming completion.

## Out of Scope / Non-Goals

- Reprioritizing specs based on their number.
- Renumbering folders later.
- Splitting every historical spec into three files for visual symmetry.
- Changing any feature's approved behavior, lifecycle, or verification result
  except this migration spec after successful implementation.
- Implementing the AG-UI stabilization draft.
- Adopting AG-UI SDK packages, LangGraph, Google ADK, Traycer, or Pi Agent.
- Rewriting `context/history.md` or earlier dated worklog entries.
- Adding a hosted spec service, database, or issue-tracker integration.

## Acceptance Criteria

- [x] Yusuf explicitly approves this migration spec before any file move.
- [x] All 24 specs exist exactly once at their mapped numbered
  `<NNN-id>/spec.md` path; no root `*.spec.md` remains.
- [x] No specification body, approval record, acceptance criterion, or existing
  verification evidence is lost.
- [x] Every spec metadata ID equals its numbered parent directory, and every
  relationship resolves to a migrated numbered ID.
- [x] Schema exists only at `specs/schema/spec.schema.json`.
- [x] `specs/templates/` contains useful spec, plan, and verification templates.
- [x] `plan.md`/`verification.md` companion artifacts are present for the three
  features named in scope and no empty companion files are generated elsewhere.
- [x] `specs/README.md` and `specs/catalog.json` enumerate all 24 specs exactly
  once, use new paths/IDs, and expose optional artifact links where present.
- [x] `bun run specs:catalog` regenerates deterministic outputs.
- [x] `bun run specs:check` is read-only and rejects root-level legacy specs,
  malformed folder names, missing `spec.md`, ID/path mismatches, broken
  relationships, and stale catalog output.
- [x] Focused governance tests cover the new valid/rejected layouts.
- [x] Active repository references contain no old `specs/<id>.spec.md` paths or
  old unnumbered relationship IDs; historical context/worklog files are the
  documented exception.
- [x] `CLAUDE.md` and `README.md` teach the numbered-folder workflow and optional
  companion-artifact rules.
- [x] No application/runtime source behavior changes.
- [x] No unrelated `.claude/` content changes.
- [x] `bun run typecheck` exits 0.
- [x] `bun test` passes without regression.
- [x] `git diff --check` passes and the final name-status review shows only the
  approved moves/additions/edits, with no unexplained deletion.
- [x] `specs/024-spec-folder-migration/verification.md` and `context/worklog.md`
  record the final evidence and remaining limitations.

## Verification Plan

1. Validate the complete source/destination map before any move.
2. After moving, enumerate all numbered directories and assert one `spec.md`
   per directory and zero root `*.spec.md` files.
3. Run focused validator tests for valid folders, rejected legacy files,
   malformed numbers/names, missing specs, mismatched IDs, optional artifacts,
   relationships, and stale outputs.
4. Run `bun run specs:catalog` then `bun run specs:check` twice; compare hashes
   before/after check mode to prove it writes nothing.
5. Search active files for every old path and unnumbered relationship ID.
6. Run `bun run typecheck`, full `bun test`, and `git diff --check`.
7. Inspect `git diff --name-status` for the explicit 24 moves and absence of
   unrelated deletes/renames.
8. Record exact results in `verification.md` and append the worklog handoff.

## Implementation Result

The approved migration is complete. All 24 specs now live under their fixed
numbered feature directories; the schema, templates, catalog, validator, active
references, and three scoped companion-artifact sets match the target contract.
No runtime behavior changed. The AG-UI feature remains `draft`/`pending` and no
framework adoption was authorized.
