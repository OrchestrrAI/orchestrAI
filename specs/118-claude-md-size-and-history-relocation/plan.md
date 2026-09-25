# Plan: 118 — CLAUDE.md size budget and history relocation

> This plan cannot broaden `spec.md`. It sequences the approved scope only.

The risk here is not technical difficulty — it is **content loss across a
240,000-character move touching up to 117 directories**. The phases exist so
that the destructive step (deleting text from `CLAUDE.md`) never runs before
its destination is written and confirmed.

## Phase 0 — Snapshot and inventory (no file is modified)

1. Record the exact pre-change state: `wc -c CLAUDE.md`, `git rev-parse HEAD`,
   and the per-section character table (the `awk` command in `spec.md`'s
   Verified Current State).
2. Build a mapping table, committed as working notes in the eventual
   `verification.md` for this spec: every `## ` section of `CLAUDE.md` →
   `keep` / `condense` / `relocate`, and for each `relocate`, the single owning
   spec id plus the other spec ids that get a pointer.
3. Flag in that table any section whose owning spec is genuinely ambiguous, and
   resolve it before Phase 2 rather than guessing mid-move.

**Exit gate:** the mapping table covers 100% of `CLAUDE.md`'s sections, with no
section unassigned.

## Phase 1 — The guard, first and alone

Land the size check *before* any content moves, so the budget is a measured
fact throughout the rest of the work rather than a claim at the end.

1. `scripts/spec-catalog.ts`: exported constant (e.g.
   `CLAUDE_MD_MAX_CHARACTERS = 150_000`), a pure checking function taking the
   real character count, and its call inside `runCatalog`'s `check` mode.
   Success prints the count; failure names the count, the budget, and the
   overage.
2. `scripts/spec-catalog.test.ts`: under, exactly at, and over the limit.
3. Expect `bun run specs:check` to **fail** at this point — `CLAUDE.md` is
   still 392 KB. That failure is the proof the check works; record it.

**Exit gate:** `bun test` passes; `specs:check` fails for exactly the size
reason and no other.

## Phase 2 — Relocate, additively (nothing is deleted yet)

Working in batches by spec-number range so each batch is independently
reviewable:

1. For each `relocate` row, append the verbatim narrative to the owning spec's
   `verification.md` under the uniform heading, creating the file where absent.
2. Append the one-line pointers to the other named specs.
3. After each batch: `git diff --stat specs/` must show only `verification.md`
   files.

**Exit gate:** every relocate row is written; `CLAUDE.md` is still byte-identical
to its pre-change state. At this moment the content exists in **two** places —
deliberately, so the next phase's deletions are diffable against a live
original.

## Phase 3 — Cut and condense `CLAUDE.md`

1. Remove the relocated text.
2. Condense the surviving sections per `spec.md` §3/§4, present tense, with
   inline `See specs/NNN` pointers.
3. Add `## Where history lives`.
4. Re-measure after every few sections; stop condensing once comfortably under
   budget rather than cutting further for its own sake.

**Exit gate:** `wc -c CLAUDE.md` ≤ 150,000 and `bun run specs:check` passes.

## Phase 4 — Cross-document consistency

1. `scripts/spec-catalog.ts` authoring-workflow prose: the ownership rule.
2. `bun run specs:catalog` to regenerate `specs/README.md` + `catalog.json`.
3. `AGENTS.md`: the ownership table pointer.
4. `context/history.md`: the one-line frozen note at the top.

**Exit gate:** `specs:catalog` then `specs:check` both clean; the catalog diff
is only new Artifacts links plus the prose change.

## Phase 5 — Verification and worklog

Run `spec.md`'s Verification Plan items 1–9 in order, including the forced
failure-path test (item 3) and the safety-content read-through (item 8).
Record results — including anything that could not be confirmed — in
`specs/118-claude-md-size-and-history-relocation/verification.md`, then append
the dated `context/worklog.md` entry.

## Rollback

Phases 2 and 3 are separated precisely so rollback is cheap: until Phase 3 is
committed, reverting is `git checkout -- specs/`. After Phase 3, the
pre-change `CLAUDE.md` is one `git show <Phase-0 HEAD>:CLAUDE.md` away, which
is also the source for every verbatim diff in Verification Plan item 7.
