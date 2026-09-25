# Implementation Plan: Numbered Spec Feature Folders

This plan executes the approved `spec.md` without changing runtime behavior.

## Preconditions Completed

- Yusuf approved the fixed 001–024 mapping and optional-artifact policy.
- All 24 sources and destinations were resolved under `specs/`.
- Every source existed, every destination file was absent, and the mapping was
  confirmed unique before the first move.

## Execution Phases

1. Create the explicit numbered directories and move tracked specs with
   `git mv`; move current untracked drafts without overwriting destinations.
2. Move the schema under `schema/` and rewrite metadata IDs, relationships, and
   active path references through the approved one-to-one map.
3. Convert catalog discovery and validation to numbered feature directories.
4. Add templates and only the three scoped useful companion artifacts.
5. Regenerate human/machine catalogs and update active guidance.
6. Audit paths/relationships, run focused tests, typecheck, full tests, and
   formatting/name-status checks.
7. Record exact evidence in `verification.md`, the governing spec, and worklog.

## Recovery Rules

- Stop on a missing source, existing destination, out-of-root path, broken
  relationship, or unexplained deletion.
- Never use a recursive delete/reset to recover a partial migration.
- Repair only the explicit affected mapping, then rerun the complete validators.

## Completion Checklist

- [x] 24 numbered folders, exactly one `spec.md` each, zero root legacy specs.
- [x] IDs, relationships, catalogs, and active references use numbered paths.
- [x] Templates and scoped companion artifacts are present and non-empty.
- [x] Governance, typecheck, tests, diff, and name-status audits pass.
- [x] Final evidence and handoff are recorded.
