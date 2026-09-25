---
description: Review a spec's implementation diff (reviewer subagent, Sonnet)
argument-hint: <spec number, e.g. 118>
model: sonnet
---

Use the reviewer subagent to review the implementation of spec $1.

Setup: find the spec directory under `specs/` whose name starts with `$1`.
The reviewer needs three inputs from you:

- (a) the full spec — its Acceptance Criteria are the review checklist;
- (b) the complete diff for this spec's implementation — work out the right
  git comparison yourself (e.g. `git diff main...HEAD` on a `spec/NNN-*`
  branch, or the uncommitted working tree) and state which you used;
- (c) the `CLAUDE.md` conventions that apply to the touched files (approval
  gates, tiering, protocol shapes).

Do not fix anything — report only. Relay the reviewer's findings verbatim,
severity-ordered, ending with its verdict line (`VERDICT: CLEAN` or
`VERDICT: FINDINGS`).

Then persist the findings for the cross-tool loop: write them to
`specs/$1-*/review.md` — numbered, each severity-tagged (blocker /
should-fix / nit) with file:line references — under a dated `## Round N`
heading. Create the file on the first round; append later rounds; keep
earlier rounds' findings, marked with `Fixed:` lines where they were
resolved. If the verdict is CLEAN, record that in the file too, so the
other tool can see the loop is closed. Never overwrite another round's
record.

Finally tell me the next step: FINDINGS → run `/fix $1` (all open findings)
or `/fix $1 <numbers>` (a subset) in OpenCode; CLEAN → run `/verify $1` in
OpenCode and proceed to closure.
