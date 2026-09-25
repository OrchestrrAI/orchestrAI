# Review findings — spec 118

Findings from the Claude Code review passes (`/review 118`), one round per
section. `/fix` consumes findings marked `Status: OPEN (fix)` and marks each
resolved one with a `Fixed:` line. Chat text is not the record — this file
is.

## Round 1 — 2026-09-23 — VERDICT: FINDINGS

1. **should-fix** — `opencode.json:4`, `.opencode/agents/implementer.md:4`,
   `.opencode/agents/verifier.md:4` — provider rename
   `opencode/glm-5.3(-flash)` → `opencode-go/glm-5.3(-flash)` present in the
   working tree but outside spec 118's Scope; should not ride in a
   spec-118 commit.
   Status: CLOSED — no code change. Resolution is commit discipline: the
   three files land in their own `chore(workflow):` commit; spec 118's
   commit excludes them.
2. **should-fix** — the CLAUDE.md size gate runs only in `specs:check`
   (check mode); `specs:catalog` (write mode) gives no size signal.
   Status: CLOSED — round 2 confirmed the check-only behavior matches the
   spec's own "advisory in scope, blocking in effect" constraint. Accepted
   as designed.
3. **nit** — the budget counts `content.length` (UTF-16 units), not bytes:
   72,447 units vs 72,752 bytes by `wc -c`.
   Status: CLOSED — informational; `verification.md` line 7 already records
   both numbers and explains the difference.
4. **nit** — `verification.md` recorded 72,352 characters while the live
   file measured 72,447 — evidence drift from post-evidence edits.
   Status: FIXED 2026-09-23 (was OPEN (fix) — line 7 was updated by the
   implementer's final pass, but line 10's captured gate output still read
   the stale `72352`).
   Fixed: re-ran `bun run specs:check` after this round's edits and
   refreshed `specs/118-…/verification.md` items 1–2 with the real
   post-fix measurements — 72,859 bytes / 72,552 characters, captured gate
   output now reads `CLAUDE.md is 72552 characters, within the
   150000-character budget.` — each with an inline note explaining the
   re-capture. Recorded evidence now matches the live file.

## Round 2 — 2026-09-23 — VERDICT: FINDINGS

1. **should-fix** — same three-file provider-pin set as Round 1 item 1.
   Status: CLOSED — same resolution: commit split at close; explicitly not
   part of spec 118's implementation work.
2. **nit** — `scripts/spec-catalog.test.ts` — `checkClaudeMdSize(0).ok` is
   asserted but its `.message` content is never checked for this call
   (unlike the under/at/over cases, which all assert message substrings).
   Status: FIXED 2026-09-23.
   Fixed: `scripts/spec-catalog.test.ts:152-155` — the zero case now binds
   the result and asserts its message pins the count (`"CLAUDE.md is 0
   characters"`) and names the budget (`CLAUDE_MD_MAX_CHARACTERS`),
   matching the under/at/over cases' message assertions.
3. **nit** — `CLAUDE.md:174` — the blanket "DevOps, Documentation, Testing,
   Code Review, and Coder fail closed once the harness is active" reads as
   all-harness-output fail-closed; DevOps's own analyze-project
   deep-analysis layer is fail-open (carved out in the next sentence, but
   skimmable past). Reword for clarity.
   Status: FIXED 2026-09-23.
   Fixed: `CLAUDE.md:174` — the fail-closed sentence now carries the
   carve-out itself ("with one carve-out inside that set: DevOps's
   `analyze-project` deep-analysis layer (`specs/103`) **fails open**, as
   does Security's commentary layer"), so the exception cannot be skimmed
   past; the fail-open rationale (deterministic scan/report as core
   content, explicit `"…unavailable: <reason>"` note, task still
   completes) is unchanged in substance. Wording verified against
   `packages/agents/devops/index.ts:569-604` (fail-open deep analysis) and
   `:394,:436-441` (fail-closed run-command and file-writing paths).

### Round 2 verification highlights (no action — recorded as evidence)

- Zero-duplication sweep across all 107 relocated `## Narrative record`
  blocks: 328 long (≥200-char) paragraphs extracted, 0 duplicated verbatim
  across any two verification.md files.
- All 107 narrative-record headings byte-identical.
- `git diff HEAD --stat -- 'specs/*/spec.md'` empty — no spec.md touched;
  35 new verification.md files untracked, matching the constraint.
- `bun run specs:check` green: CLAUDE.md is 72,447 characters, within the
  150,000-character budget.
- Condensed CLAUDE.md safety claims spot-verified against live source
  (DevOps NEEDS_APPROVAL/EXECUTING_SKILLS, ORCHESTRAI_MCP_ALLOWED_HOSTS
  loopback default, ORCHESTRAI_ORCHESTRATOR_INSPECTION=0 opt-out,
  DEFAULT_MAX_DISPATCHES = 30) — all matched.
- No factual condensation errors, no misattributed or duplicated narrative,
  no runtime files under apps/ or packages/ touched, no spec frontmatter
  modified.
