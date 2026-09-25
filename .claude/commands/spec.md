---
description: Draft a new spec for an idea (Opus planning session, specs/ workflow)
argument-hint: <one-line idea>
model: opus
---

Draft a new specification for this idea:

$ARGUMENTS

This is a planning conversation — follow the repo's governed spec workflow:

1. Read `CLAUDE.md`, `specs/README.md`, and `specs/templates/spec-template.md`
   first. Inspect the relevant current code before proposing anything
   (source-of-truth order: current code > specs > CLAUDE.md > context/).
2. Find the next free three-digit checkpoint number under `specs/` (verify
   against the existing directories; never reuse or renumber one).
3. Ask me clarifying questions BEFORE writing the draft when scope is
   ambiguous — my answers shape the spec.
4. Create `specs/NNN-kebab-case-id/spec.md` from the template. Frontmatter
   must match `specs/schema/spec.schema.json`: `status: draft`,
   `verification: pending`, a correct `area` and `change_type`, and
   `amends`/`related` links where applicable. Add `plan.md` only if the work
   is multi-phase or risky — never create empty companion files.
5. Run `bun run specs:catalog` and then `bun run specs:check`; fix any
   validation errors they report.
6. Append a short entry to `context/worklog.md` recording the draft (the
   idea, the key design decisions, and the open questions I should review) —
   matching that file's entry format.
7. Present the draft summary and STOP. Never set `status: approved` —
   approval is mine alone. Never start implementing — implementation happens
   in OpenCode via `/implement NNN` on the GLM-5.3 implementer.
