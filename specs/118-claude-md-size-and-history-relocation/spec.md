---
id: 118-claude-md-size-and-history-relocation
title: "CLAUDE.md Under a Hard Size Budget: Relocate Per-Spec History into specs/"
area: spec-governance
change_type: governance
status: implemented
verification: verified
created: 2026-09-23
updated: 2026-09-23
approved_by: Yusuf
approved_on: 2026-09-23
implemented_on: 2026-09-23
amends:
  - 023-spec-governance-and-catalog
  - 025-spec-area-grouping
supersedes: []
superseded_by: []
related:
  - 024-spec-folder-migration
  - 104-deferred-work-register
---

# Spec: CLAUDE.md Under a Hard Size Budget: Relocate Per-Spec History into specs/

> Status: **IMPLEMENTED and VERIFIED 2026-09-23.** Approved by Yusuf 2026-09-23;
> closed by Yusuf after the review round (two nits fixed) and a live re-verification
> pass against the real `bun run specs:check` surface.

## Purpose

`CLAUDE.md` is the operating guide every coding agent in this repository reads
before touching anything. It is currently **392,109 characters** and grows with
every checkpoint, because the established convention has been to append each
spec's full reasoning-and-verification narrative to it. That convention has
produced a genuinely valuable record — and an operating guide no agent can
afford to read in full, which defeats the file's own purpose.

This checkpoint sets a hard budget of **150,000 characters** for `CLAUDE.md`,
relocates the per-spec historical narratives to the spec folders that own them,
and adds an enforced check so the file cannot silently regrow. Nothing is
deleted: every relocated paragraph survives verbatim at its new address.

This is a governance change. It alters where documentation lives and adds one
check to an existing script. It changes **no runtime behavior, no protocol, no
approval gate, and no spec's lifecycle status**.

## Verified Current State

Measured against the repository on 2026-09-23, not estimated:

- `CLAUDE.md` — **392,109 characters** (`wc -c`). The budget this spec sets is
  150,000, so roughly **62% of the file must move**.
- Largest sections, by characters (`awk` over `## ` headings):

  | Chars | Section |
  |---:|---|
  | 37,300 | `## Target project resolution` |
  | 27,969 | `## Known limitations and technical debt` |
  | 16,753 | `## Adaptive supervisor (Orchestrator) …` |
  | 15,179 | `## Task and plan flow` |
  | 14,791 | `## Human approval and safety` |
  | 12,148 | `## Phase D: Code Review Agent …` |
  | 12,020 | `## Planning Agent (retired) …` |
  | 10,822 | `## Phase E: Coder Agent v1 …` |
  | 10,712 | `## Opt-in LLM harness (Documentation)` |
  | 10,137 | `## Orchestrator's own read-only project inspection` |

  In every one of these, the majority of the text is **historical narrative
  about one or more numbered specs** — what was live-caught, what was tried,
  what a verification pass found — not a statement of current behavior an agent
  needs before editing code. `## Target project resolution`, the single largest
  section, is mostly npm-publish, release-tag, and init-wizard history
  (`specs/031`–`073`, `specs/032`) with only a few hundred characters of actual
  current resolution rules.
- `specs/` currently holds **117 checkpoint directories** (`001`…`117`); the
  next free number is **118**. **76** already have `verification.md`; **17**
  have `plan.md`.
- **`specs/README.md` is generated in full** — not just the block between the
  `GENERATED:SPEC-CATALOG` markers. `buildMarkdownCatalog()`
  (`scripts/spec-catalog.ts:315`) emits the entire file, including the
  "Authoring workflow", "Lifecycle model", and "Area and checkpoint model"
  prose, as a template literal. Any governance-text change must be made in that
  script, not by editing `specs/README.md`. `CLAUDE.md`'s own current wording
  ("never edit `specs/README.md`'s generated section") understates this.
- The catalog's **Artifacts** column is derived from `hasVerification` /
  `hasPlan` (`scripts/spec-catalog.ts:320-326`), so creating new
  `verification.md` files legitimately changes generated catalog output.
- `scripts/spec-catalog.ts` exposes `runCatalog(mode: "check" | "write")`;
  `bun run specs:check` calls the `check` mode, which today validates spec
  frontmatter, relationships, and catalog freshness only — it makes no
  assertion about any other documentation file. It has its own test file,
  `scripts/spec-catalog.test.ts` (168 lines).
- `AGENTS.md` (2,708 chars) tells OpenCode that "its full operating guide is
  `CLAUDE.md`" and restates the source-of-truth order. It names no other
  history location.
- `context/history.md` (51,249 chars) and `context/worklog.md` (709,476 chars)
  also hold history, with no written rule separating their ownership from
  `CLAUDE.md`'s. This is why the same material has accumulated in three places.
- ~~No git hooks are installed (`.git/hooks` has only samples), despite a
  worklog entry describing a "pre-commit hook" run.~~ **Correction,
  2026-09-23, found at closure: this drafting-time claim was wrong.** The
  repository sets `core.hooksPath = .githooks`, and `.githooks/pre-commit`
  genuinely exists and runs — observed firing on this checkpoint's own commit,
  executing `bun run specs:check` (including the new size gate) followed by
  the full `bun test` suite. `.git/hooks` holding only samples is exactly what
  a configured `core.hooksPath` produces, so that directory listing was
  misleading evidence, not absent evidence. The conclusion below is unchanged
  and if anything strengthened: the enforced check still lands in
  `bun run specs:check`, which is both a routinely-run command *and* — as it
  turns out — already invoked by the real pre-commit hook, so the budget is
  enforced on every commit without this spec adding a hook of its own.

## Proposed Behavior

### 1. A hard, checked size budget

`CLAUDE.md` must be **≤ 150,000 characters**. `bun run specs:check` fails with
a named, actionable message reporting the real count and the budget when it is
exceeded; it prints the count on success. The limit is a single exported named
constant in `scripts/spec-catalog.ts`, so it is changed deliberately, in one
place, never by drift.

### 2. Per-spec narrative moves into that spec's `verification.md`

Each relocated narrative is appended to `specs/<NNN-…>/verification.md` —
created from nothing where the spec has none — under a single, uniform heading:

```
## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)
```

**Relocated text is copied verbatim.** It is not rewritten, summarized, or
re-verified as part of this move. This is what makes the whole change
reviewable: the destination content must diff clean against the removed source
text.

**Attribution rule for a narrative naming several specs.** The narrative goes
in full to the spec whose behavior it primarily describes (normally the newest
spec the paragraph is *about*, not the older specs it amends). Every other spec
named in it gets a one-line pointer appended under the same heading: `See
specs/<NNN>/verification.md for the relocated narrative covering this
checkpoint.` No paragraph is duplicated in two files.

### 3. What `CLAUDE.md` keeps

The surviving file is present-tense and answers "what is true now, and what
must I not break" — nothing else. Retained sections:

- Project; Source-of-truth order
- Current architecture; Repository layout; Current services and skills
- Task and plan flow — current routing/dispatch behavior only
- Human approval and safety — the gates, tiers, `actionId` binding, and the
  "when adding a write-capable skill" checklist, **kept substantively**; this
  is the one section where brevity is not worth risk
- Live event protocol (AG-UI) — the current event set and the
  informational-only rule for approval `CUSTOM` events
- Commands; Target project resolution — the resolution rules, stripped of
  release/publishing/init history
- Working procedure — plus the new rules from §5
- Verification status; Known limitations and technical debt; Current
  recommended priority

Each condensed section ends with a pointer naming the specs that own its
history (`See specs/106, 107, 108, 110.`). Pointers are inline and
topic-scoped — **no exhaustive per-spec index is added to `CLAUDE.md`**;
`specs/README.md` is already that catalog, and duplicating it would consume the
budget this spec exists to protect.

A short new section, `## Where history lives`, states the ownership rule (§5)
explicitly for any agent reading the file cold.

### 4. Condensation is rewriting, and is bounded

Surviving text may be rewritten into present tense and merged across sections.
The bound: **a statement of current behavior may not be dropped merely for
length.** If a nuance is load-bearing (a safety property, a fail-closed vs
fail-open choice, a structural-not-conventional enforcement claim, an env-var
name and its default), it stays in `CLAUDE.md` even when its surrounding story
moves.

### 5. The ownership rule, written down in three places

One rule, stated in `CLAUDE.md`'s Working procedure, in the generated
`specs/README.md` authoring workflow (via `scripts/spec-catalog.ts`), and in
`AGENTS.md`:

| File | Owns |
|---|---|
| `CLAUDE.md` | Current architecture, conventions, gates, commands. Present tense. Budget-capped. |
| `specs/<NNN>/spec.md` | The approved decision and its acceptance criteria. |
| `specs/<NNN>/verification.md` | That checkpoint's evidence **and its narrative record** — what was live-caught, what was tried, what a pass found. |
| `context/worklog.md` | Dated, per-work-unit handoff entries. Append-only. |
| `context/history.md` | Pre-spec-governance historical discussion. Frozen; not appended to. |

A checkpoint's narrative goes to its own `verification.md`, never to
`CLAUDE.md`. `CLAUDE.md` gains at most a present-tense sentence plus a spec
pointer.

## Scope

- `CLAUDE.md` — restructured and condensed to ≤ 150,000 characters.
- `specs/<NNN-…>/verification.md` — up to 117 files touched; new files created
  where a spec has none.
- `scripts/spec-catalog.ts` — the size check, its exported limit constant, and
  the authoring-workflow prose in `buildMarkdownCatalog()`'s template.
- `scripts/spec-catalog.test.ts` — coverage for the new check (under, at, and
  over the limit).
- `specs/README.md`, `specs/catalog.json` — regenerated output only, never
  hand-edited.
- `AGENTS.md` — the ownership table pointer.
- `context/worklog.md` — one new dated entry (existing entries untouched).
- `context/history.md` — one added "frozen" note at the top; content untouched.

## Safety and Compatibility Constraints

- **No runtime code changes.** No file under `apps/`, `packages/`, or
  `docker-compose.yml`/`Dockerfile` is edited. `scripts/spec-catalog.ts` is a
  governance tool, not runtime.
- **No spec lifecycle changes.** No `status`, `verification`, `approved_by`,
  `approved_on`, `implemented_on`, `amends`, `supersedes`, or `related` field
  in any existing spec is edited. Appending a narrative to `verification.md`
  does **not** change that spec's `verification` confidence.
- **No `spec.md` body is edited.** Only `verification.md` files are written to.
- **No directory is renumbered, renamed, merged, or deleted.**
- **Nothing is deleted, only moved.** Every character removed from `CLAUDE.md`
  is either (a) present verbatim in a `verification.md`, or (b) a deliberate
  condensation whose current-behavior content survives per §4. The implementer
  records which, per section.
- **`specs/README.md` is never hand-edited** — the governance prose change goes
  into `scripts/spec-catalog.ts` and is regenerated.
- The size check is **advisory in scope but blocking in effect**: it fails
  `specs:check`, the same gate spec-catalog drift already fails. It must not be
  added to `bun test` or `bun run typecheck`, which have unrelated jobs.

## Out of Scope / Non-Goals

- Shrinking `context/worklog.md` (709 KB) or `context/history.md` (51 KB).
  Their ownership is *written down* here; neither is restructured.
- Any budget or check for `AGENTS.md`, `README.md`, or spec files themselves.
- Re-verifying, correcting, or updating any relocated narrative. If a relocated
  paragraph is stale or wrong, it stays exactly as written and is recorded as a
  finding, not fixed here.
- Introducing a new companion-file type (`notes.md` or similar). Narratives
  land in `verification.md`; the governance model keeps exactly three artifact
  kinds.
- A git hook, a CI workflow step, or any new `package.json` script.
- Changing the public `README.md`.

## Acceptance Criteria

- [ ] Explicit approval is recorded before implementation.
- [ ] `wc -c CLAUDE.md` reports **≤ 150,000**.
- [ ] `bun run specs:check` passes, and its output names the real `CLAUDE.md`
      character count against the 150,000 budget.
- [ ] The size limit exists as one exported named constant in
      `scripts/spec-catalog.ts`; `scripts/spec-catalog.test.ts` covers under,
      at, and over the limit.
- [ ] Every relocated narrative is present verbatim under the uniform
      `## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)`
      heading in exactly one spec's `verification.md`, with one-line pointers in
      the other specs it names.
- [ ] No spec's frontmatter is modified, and no `spec.md` body is modified —
      provable by `git diff`.
- [ ] `CLAUDE.md` retains: current architecture, repository layout, the
      services/skills table, current routing/dispatch behavior, the full
      approval-gate rules and write-capable-skill checklist, the AG-UI event
      set, commands, target-path resolution rules, working procedure, known
      limitations, and current priority.
- [ ] `CLAUDE.md` contains the new `## Where history lives` section, and the
      identical ownership rule appears in `AGENTS.md` and in the generated
      `specs/README.md`.
- [ ] Every `specs/NNN` pointer in the restructured `CLAUDE.md` resolves to a
      real directory (no dangling reference).
- [ ] `bun run specs:catalog` then `bun run specs:check` are clean; the only
      catalog diff is new `verification` links in the Artifacts column and the
      updated authoring-workflow prose.
- [ ] `bun test` and `bun run typecheck` pass, unchanged in count except for
      the new spec-catalog tests.
- [ ] `context/worklog.md` has a dated entry for this work.

## Verification Plan

Automated, and reproducible by anyone:

1. `wc -c CLAUDE.md` — the single headline number.
2. `bun run specs:catalog && bun run specs:check` — clean; capture the
   size-check line from the output.
3. Force the failure path: temporarily lower the constant below the real count,
   confirm `specs:check` exits non-zero with the actionable message, restore.
   (Recorded, then reverted — this repo's established pattern for a temporary
   test aid.)
4. `bun test` and `bun run typecheck`.
5. `git diff --stat specs/` — confirm **only** `verification.md` files appear
   (plus regenerated `README.md`/`catalog.json`). Any `spec.md` in that list is
   a failure.
6. `grep -o 'specs/[0-9]\{3\}' CLAUDE.md | sort -u` compared against
   `ls specs/` — zero dangling pointers.

Manual, proportional to the risk of losing content:

7. **Verbatim audit of a sample.** For at least 8 relocated sections spanning
   the range (one early — e.g. `specs/012`; one mid — `specs/042`; several
   recent — `106`, `108`, `110`, `114`, `115`, `116`), diff the removed
   `CLAUDE.md` text against the destination `verification.md` text and confirm a
   byte-level match.
8. **Safety-content audit.** Read the surviving approval/safety, target-path,
   and MCP-boundary sections end to end against the pre-change file and confirm
   no gate, tier, env-var name, default, or fail-closed/fail-open statement was
   lost. This is the one section where a condensation error has real
   consequences, so it is checked by reading, not by sampling.
9. **Cold-read check.** Confirm the restructured `CLAUDE.md` answers, without
   consulting `specs/`: what the services and ports are, which skills need
   approval, how to run the stack, how target paths resolve, and what the spec
   workflow requires.

## Approval Requested

Approval authorizes: relocating per-spec historical narrative out of
`CLAUDE.md` into the owning spec's `verification.md` verbatim; condensing the
surviving `CLAUDE.md` to present-tense current-state under a 150,000-character
budget; adding that budget as an enforced check in `bun run specs:check` with
test coverage; and writing the file-ownership rule into `CLAUDE.md`,
`AGENTS.md`, and the generated `specs/README.md`.

Approval does **not** authorize: any runtime code change; any edit to a spec's
frontmatter or `spec.md` body; any lifecycle or verification-status change;
renumbering, renaming, or deleting any spec directory; correcting or
re-verifying relocated content; restructuring `context/worklog.md` or
`context/history.md`; or any new script, hook, or CI step beyond the single
size check described above.
