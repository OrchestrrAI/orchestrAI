---
description: Implement an approved spec (Claude fallback implementer) — e.g. /implement 119
argument-hint: <spec number, e.g. 119>
model: sonnet
---

Implement spec $1.

First: find the spec directory under `specs/` whose name starts with `$1`,
read the spec completely, and check its frontmatter. If `status:` is not
exactly `approved`, STOP and report — a draft is not authorization. If the
spec has a `plan.md`, follow its phase order exactly, including any Phase 0
spike and its exit gate, before later phases.

Then implement exactly what the spec authorizes — its Acceptance Criteria are
the definition of done. No scope creep, no drive-by refactors. Run
`bun test`, `bun run typecheck`, and `bun run specs:check` for what you
changed and make them pass; report the real final output, pass or fail.

Never touch any spec's status fields — `status`, `approved_by`,
`approved_on`, `implemented_on` are Yusuf's alone. Do not commit or push;
leave the working tree for review.

Once the gates pass, append a concise entry to `context/worklog.md` in that
file's own format (Objective / Files changed / Decisions / Verification with
the real results / Known limitations).

Finish with a concise report: files changed and why (file:line), commands run
with their real results, and anything you skipped or flagged.
