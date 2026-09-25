# AGENTS.md — OpenCode rules for this repository

This repository is **OrchestrAI**. Its full operating guide is
[`CLAUDE.md`](./CLAUDE.md) — written for coding agents generally, not only for
Claude Code. Read the sections of `CLAUDE.md` relevant to whatever you are
about to touch before changing it. If this file and `CLAUDE.md` disagree,
`CLAUDE.md` wins.

## Non-negotiable rules

1. **Spec gate.** No change to runtime behavior, architecture, protocols, or
   configuration without a spec under `specs/` whose frontmatter says
   `status: approved`. `draft` is not authorization. If the spec you were told
   to implement is not approved, stop and report instead of implementing.
2. **Status flips are human-only.** You never edit a spec's `status`,
   `approved_by`, `approved_on`, or `implemented_on` fields. Approval and
   closure belong to Yusuf alone.
3. **Source-of-truth order** (when sources disagree): current code > `specs/`
   > `CLAUDE.md` > `context/instructions.md` + `context/project.md` >
   `context/history.md` > older material. State disagreements openly instead
   of silently trusting the older document.
4. **Verification gates.** Whatever you change, run `bun test` and
   `bun run typecheck` and make them pass before reporting done. Spec-catalog
   validation: `bun run specs:check` (this also enforces `CLAUDE.md`'s
   150,000-character budget).

## Where history lives

One ownership rule, stated identically in `CLAUDE.md` and the generated
`specs/README.md`:

| File | Owns |
|---|---|
| `CLAUDE.md` | Current architecture, conventions, gates, commands. Present tense. Budget-capped. |
| `specs/<NNN>/spec.md` | The approved decision and its acceptance criteria. |
| `specs/<NNN>/verification.md` | That checkpoint's evidence **and its narrative record** — what was live-caught, what was tried, what a pass found. |
| `context/worklog.md` | Dated, per-work-unit handoff entries. Append-only. |
| `context/history.md` | Pre-spec-governance historical discussion. Frozen; not appended to. |

A checkpoint's narrative goes to its own `verification.md`, never to
`CLAUDE.md`; `CLAUDE.md` gains at most a present-tense sentence plus a spec
pointer.

## The two-tool workflow (Claude Code ⟷ OpenCode)

`specs/` is the contract between the two tools; a spec's `status:` field is
the only authorization signal. The slash commands below exist in the tool
that runs them — `/spec` and `/review` are Claude Code commands; `/implement`,
`/fix`, and `/verify` are OpenCode commands.

| Phase | Where | How |
|---|---|---|
| 1. Draft spec | Claude Code (Opus) | `/spec <idea>` |
| 2. Approve | Yusuf (human) | flips `status` → `approved`, sets `approved_by`/`approved_on` |
| 3. Implement | OpenCode (GLM-5.3) | `/implement NNN` — code + gates + worklog entry |
| 4. Review diff | Claude Code (Sonnet) | `/review NNN` |
| 5. Fix findings | OpenCode (GLM-5.3) | `/fix NNN` — resolves the numbered findings in `specs/NNN/review.md` — loop 4↔5 until clean |
| 6. Verify + close | OpenCode drafts evidence; Yusuf flips status | `/verify NNN`, then Yusuf sets `implemented` |

Every implementation or substantive fix round records itself in
`context/worklog.md` — the repo's own convention ("Documentation and worklog
are updated" is a standing spec acceptance criterion).

Review findings travel in `specs/<NNN>/review.md`, not in chat text:
`/review` (Claude Code) writes each round's numbered, severity-tagged
findings there under a dated round heading; `/fix` (OpenCode) consumes them
and marks each resolved finding with a `Fixed:` line. The file is the
loop's shared state across both tools.

## Cost hygiene

Stay scoped: one spec per session; read only what the spec touches instead of
re-exploring the repository; start a fresh session for unrelated work. Never
select a model above roughly $2/M input without Yusuf's explicit instruction —
expensive judgment work belongs to Claude Code, not here.
