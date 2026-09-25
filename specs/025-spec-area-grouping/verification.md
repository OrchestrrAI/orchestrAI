# Verification: Specification Area Grouping and Amendment Semantics

## Environment

- Date: 2026-08-16
- Platform: Windows / PowerShell
- Runtime: Bun 1.3.14

## Acceptance Matrix

| Area | Evidence | Result |
|---|---|---|
| Approval gate | Yusuf approved the exact metadata, catalog, JSON v3, and fixed-map wording before implementation | Pass |
| Required metadata | Schema and custom parser require `area`, `change_type`, and `amends`; all 25 specs validate | Pass |
| Classification map | Read-only catalog audit compared all 25 area/type/amends triples with the approved table: 0 mismatches | Pass |
| Amendment safety | Focused tests reject missing, self, duplicate, and cyclic amendments; no reciprocal historical edit is required | Pass |
| Supersession compatibility | Existing reciprocal target and cycle tests remain green and use separate graph logic | Pass |
| Human catalog | 15 alphabetical area sections retain type, status, verification, artifacts, dates, and replacement/amendment relationships | Pass |
| Machine catalog | `schema_version` is 3; deterministic `areas` and derived `amended_by` are present | Pass |
| Terminology | Active guidance and validator use specification/checkpoint terminology; historical titles/bodies remain historical | Pass |
| Idempotence | A second generation preserved both generated-file SHA-256 hashes | Pass |
| Repository checks | Catalog check, diff check, typecheck, focused tests, and full tests all pass | Pass |

## Commands and Results

- `bun test scripts/spec-catalog.test.ts`: 10 pass, 0 fail, 35 expectations.
- `bun run specs:catalog`: generated catalogs for 25 specs.
- `bun run specs:check`: governance check passed for 25 specs.
- Fixed-map audit: expected 25, actual 25, mismatch count 0.
- Generated catalog audit: schema version 3, 25 specs, 15 areas, and zero
  missing `area`, `change_type`, or `amends` fields.
- Area evidence:
  - `ag-ui`: `021-ag-ui-event-protocol`, `022-ag-ui-demo-stabilization`;
  - `spec-governance`: `023-spec-governance-and-catalog`,
    `024-spec-folder-migration`, `025-spec-area-grouping`.
- Idempotence hashes after repeated generation:
  - `specs/README.md`:
    `06CCFAE51EECD5D5717DDF48558B404BCF0037286DADF552CACEEEA3B8D1551F`;
  - `specs/catalog.json`:
    `868171863FDB0E5B019608BA9698EB3682DC918280FDCA6EDF72C178359B9975`.
- `bun run typecheck`: 0 errors.
- `bun test`: 148 pass, 0 fail, 246 expectations across 15 files.
- `git diff --check`: pass.

## Change-Scope Audit

- No specification directory was moved, deleted, merged, or renumbered.
- Specifications 001-024 received only the approved frontmatter classification;
  their bodies and lifecycle/verification values were not changed by this
  checkpoint.
- `025` alone advanced from draft through approved to implemented/verified and
  received its implementation evidence.
- AG-UI SDK work and LangGraph evaluation remain outside this checkpoint.

## Known Limitations

- `area` is deliberately singular. Cross-cutting context still uses `related`.
- Area renames are not automated and require a reviewed metadata migration.
- JSON catalog consumers must account for the explicit schema-version change
  from 2 to 3.
