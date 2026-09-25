---
description: Address review findings for a spec (GLM-5.3 implementer) — e.g. /fix 118 <findings>
agent: implementer
---

Fix the review findings for spec $1.

If no spec number was given, ask which spec before doing anything else.

First: find the spec directory under `specs/` whose name starts with `$1`,
read the spec completely, and confirm its frontmatter says `status: approved`
— otherwise STOP and report.

The findings for this round come from `specs/$1-*/review.md` — the numbered,
severity-tagged list written by the Claude Code review pass. If $2 names
specific finding numbers (e.g. `/fix 118 2` or `/fix 118 2 and 3`), address
ONLY those; otherwise address every finding that has no `Fixed:` line yet.

Address ONLY the findings — nothing else. No refactors, no improvements
beyond them; anything else you notice gets reported, not fixed.

After fixing, re-run `bun test` and `bun run typecheck` and report the real
results. Append a `Fixed: <what changed, file:line>` line under each finding
you resolved, so the file shows the loop's state. If the round is
substantive, append a worklog entry to `context/worklog.md` (or extend
today's existing entry for the same spec). Keep the report tight: per
finding — what you changed and how it resolves it; then anything you
deliberately did not do.
