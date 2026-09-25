# Implementation Plan: Specification Area Grouping

Completed on 2026-08-16 after `spec.md` received explicit approval. All seven
phases below were implemented in order and verified.

## Preconditions

- Yusuf approves the metadata names, type enum, catalog layout, JSON version,
  and fixed 001-025 mapping in `spec.md`.
- The current generated catalogs pass before implementation begins.

## Proposed Phases

1. Extend parser types and validation for `area`, `change_type`, and `amends`.
2. Add amendment graph validation and derived reverse relationships.
3. Add focused tests for metadata, amendment semantics, area grouping, and JSON
   generation.
4. Apply the approved metadata map to all 25 frontmatter blocks without
   changing their historical bodies or lifecycle evidence.
5. Replace status-first human catalog sections with lifecycle summaries plus
   deterministic area sections; emit JSON catalog schema version 3.
6. Update templates and active guidance from feature-folder to
   specification/checkpoint terminology.
7. Regenerate outputs, verify idempotence, run focused/full checks, and record
   evidence in `verification.md` and the worklog.

## Recovery Rules

- Stop if a mapping target is missing, a classification differs from the
  approved table, or a historical body/lifecycle field changes unexpectedly.
- Do not recover using reset, recursive deletion, renumbering, or regenerated
  frontmatter guesses.
- Correct only the explicit failed mapping or generator logic, then rerun all
  catalog and repository checks.
