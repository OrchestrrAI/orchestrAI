---
description: Implement an approved spec (GLM-5.3 implementer) — e.g. /implement 118
agent: implementer
---

Implement spec $1.

If no spec number was given, ask which spec before doing anything else.

First: find the spec directory under `specs/` whose name starts with `$1`
(e.g. `/implement 118` matches `specs/118-*/spec.md`), read the spec
completely, and check its frontmatter. If `status:` is not exactly
`approved`, STOP and report — do not implement a draft. If the spec has a
`plan.md`, follow its phases in order.

Then implement exactly what the spec authorizes — its Acceptance Criteria are
the definition of done. No scope creep. Run `bun test` and
`bun run typecheck` for what you changed and make them pass. Never touch any
spec's status fields — approval and closure are Yusuf's alone.

Once the gates pass, append a concise entry to `context/worklog.md` in that
file's own format (Objective / Files changed / Decisions / Verification with
the real results / Known limitations).

Finish with a concise report: files changed and why (file:line), commands run
with their real results, and anything you skipped or flagged.
