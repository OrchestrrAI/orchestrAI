# Verification: CLAUDE.md Under a Hard Size Budget — Relocate Per-Spec History into specs/

Status: **closed `verified` by Yusuf, 2026-09-23**, after a review round (two nits, both fixed) and an independent live re-verification pass. Original implementer evidence below; closure evidence appended at the end.

## Automated results (Verification Plan items 1–6)

1. **Size.** `CLAUDE.md` is **72,859 bytes / 72,552 characters** (`wc -c` equivalent: byte count of the file; the check itself counts `content.length` = 72,552 UTF-16 units). Budget: 150,000. Comfortably under, with headroom deliberately left for future present-tense additions. (Re-measured after the round-2 review fixes — the fail-modes reword in the Agent LLM harnesses section grew the file by 105 characters; the implementation-pass figures were 72,752 bytes / 72,447 characters.)
2. **Governance gate.** `bun run specs:catalog` → `Generated spec catalogs for 117 specs.` `bun run specs:check` →
   ```
   CLAUDE.md is 72552 characters, within the 150000-character budget.
   Spec governance check passed for 117 specs.
   ```
   (Output re-captured after the round-2 review fixes; the original captured count of 72352 had drifted stale through post-evidence edits — review round 1, item 4. Catalog freshness is validated by the same green `specs:check` run.)
3. **Forced failure path (recorded, then reverted).** With `CLAUDE_MD_MAX_CHARACTERS` temporarily lowered to `70_000`:
   ```
   CLAUDE.md is 70635 characters, 635 over the 70000-character budget. Relocate
   per-spec historical narrative into specs/<NNN>/verification.md (see
   specs/118) and keep CLAUDE.md to present-tense current state.
   error: script "specs:check" exited with code 1
   ```
   Constant restored to `150_000` immediately after; `specs:check` green again.
4. **Gates.** `bun run typecheck` → 0 errors (twice during the session it crashed with a Go-runtime `out of memory` inside `tsgo`'s parallel checker — the machine's commit limit was saturated by the concurrent user session, not by this change; a serialized rerun, `GOMAXPROCS=1`, completes clean, and the same command passed earlier in the session). `bun test` → **1372 pass, 2 skip, 3 fail**. The 3 failures are `specs/080 — run_command` tests in `packages/mcp/index.test.ts` that execute a real `["echo", …]` argv via `execFile` — **Windows has no `echo` executable** (`Executable not found in $PATH: "echo"`), so they fail identically with or without this spec's changes: proven by stashing every tracked change this session made and re-running the file (same 3 fail). They are pre-existing environmental failures, out of this spec's scope to fix (that would be a runtime change). `scripts/spec-catalog.test.ts` → 14 pass (12 pre-existing + 2 new budget tests).
5. **Diff shape.** `git diff --stat specs/` → **0 `spec.md` files modified**; 72 `verification.md` files modified (appends only) + 35 new `verification.md` files (untracked); plus regenerated `specs/README.md`/`specs/catalog.json`. The catalog diff vs HEAD additionally contains the spec-118 row and lifecycle-count changes that were already present uncommitted from the 2026-09-23 drafting session (recorded in that session's worklog entry); this implementation's incremental catalog diff is exactly the new `[verification]` Artifacts links plus the authoring-workflow ownership prose.
6. **Pointers.** `specs/NNN` references in the restructured `CLAUDE.md`: **86 distinct ids, zero dangling** (each matches a real `specs/NNN-*` directory).

## Verbatim audit (item 7)

14 relocated blocks byte-matched against `git show HEAD:CLAUDE.md` (exact-substring check against the destination `verification.md`), covering the spec's required sample set and more:

| Block (old lines) | Destination | Result |
|---|---|---|
| 6094–6108 | `012-tui-interactive` (early) | MATCH |
| 1151–1219 | `042-llm-harness-devops` (mid) | MATCH |
| 1526–1684 | `106-persistence-store-and-result-cache` | MATCH |
| 1810–1924 | `108-durable-audit-trail` | MATCH |
| 2079–2197 and 5736–5765 | `110-approval-state-survives-a-restart` (both blocks) | MATCH |
| 2950–3078 | `114-coder-multi-file-edit-and-create` | MATCH |
| 4176–4312 | `115-tui-navigation-redraw-and-answer-clarity` | MATCH |
| 4316–4428 | `116-chat-answer-voice-and-collapsed-raw-data` | MATCH |
| 111–136, 896–974, 4738–4798, 5970–6031, 6202–6234 | 094 / 040 / 089 / 032 / 054 (extra coverage) | MATCH |

Pointer spot-checks (named-but-not-owner specs carry the one-line pointer): `020` → 054 and 016; `004` → 016; `029` → 026; `037` → 030; `104` → 103 — all present.

## Safety-content audit (item 8)

The surviving approval/safety, target-path, and MCP-boundary content was checked statement-by-statement against the pre-change file. Verified present in the restructured file: the full approval-required skill lists; `actionId` binding with immutable pending parameters (400 missing / 409 stale); audit caps (512 UTF-8 bytes / 64 KiB `TASK_RESULT_MAX_BYTES`); DevOps MCP 409/`-32001` reconnect-once; the 4-step write-capable-skill checklist (verbatim); untrusted-input and no-shell principles (`Bun.spawn()` argv / `execFile` `shell: false` / `safeExec()`); skip-not-terminal + `skippedSkillIds` + `s`×2/Skip-button scope; rejection-terminal and `DispatchOutcome` classification with **unregistered-skill-defaults-write-capable**; every env-var name and default (all 23 checked programmatically: `ORCHESTRAI_LLM_API_KEY`/`_PROVIDER`/`_MODEL`, all six `ORCHESTRAI_<AGENT>_LLM_HARNESS` flags with the `!== "0"` opt-out semantics, `ORCHESTRAI_SECURITY_EXTERNAL_DATA=1` opt-in, `ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK=1` + 45s timeout, `ORCHESTRAI_SUPERVISOR_MAX_DISPATCHES` default 30, `ORCHESTRAI_PERSIST=0`, `ORCHESTRAI_ORCHESTRATOR_INSPECTION=0`, `ORCHESTRAI_ORCHESTRATOR_URL`/`_PORT` via `resolveOrchestratorUrl()`, ports/URL overrides, dead `ORCHESTRAI_ORCHESTRATOR_GRAPH`/`ORCHESTRAI_LLM_HARNESS` with the stale-variable warning); store fail-open rules with `0600` POSIX, PRAGMAs, and all retention bounds; pending-action TTLs (24h write / 1h command), `claimPendingAction()`, Zod restore validation, and the excluded DevOps paths; compute-once-reuse-verbatim preview content, `dry_run`, oversized-omits-entirely, fingerprint recheck; loopback-only MCP, dual-transport prohibition, `realpath()` containment + sensitive-filename denial, `run_command` denylist-as-defense-in-depth with per-invocation approval and no-auto-approve-ever; skill-id single-owner refusal; harness fail-closed vs fail-open per component; `HARNESS_RECURSION_LIMIT = 20`, `MAX_FILES_PER_EDIT = 6`, OSV cap 3/package; the three-step target-path resolution order with no-cwd-fallback, the full `document-api` entry-candidate list, and the four-source supervisor chain.

Deliberate corrections (docs made to match already-implemented code, not content loss): the stale pre-`065` "direct routing recognizes … narrow triggers" paragraph is gone (that tier is deleted); the services table now lists the current skill sets (079/080/081/114 additions); Code Review's harness is documented default-on (per `specs/086`), not opt-in; the stale "138 passed" test counts are refreshed.

One nuance recorded as condensation (b), not relocation: the inline `specs/030` bug retelling inside Task-and-plan-flow step 6 was condensed away — the identical story survives verbatim in `specs/030/verification.md`'s relocated block.

## Cold-read check (item 9)

The restructured `CLAUDE.md` answers, without consulting `specs/`: services and ports (architecture diagram + services table, including the retired 3001); which skills need approval (Human approval and safety); how to run the stack (Commands: dev vs orchestrai vs build, dashboards, MCP pre-flight); how target paths resolve (Target project resolution, including guided init's current state); what the spec workflow requires (Working procedure, including the hard stop and the new history-ownership rule).

## Phase 0 mapping table (working notes — the full relocation record)

106 relocation blocks were extracted from pre-change `CLAUDE.md` (line ranges inclusive) and appended verbatim under the uniform heading `## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)`. Every other spec named in a block received the one-line pointer. Attribution follows the spec's rule ("the spec whose behavior it primarily describes; normally the newest spec the paragraph is about"); judgment calls are flagged.

| Old CLAUDE.md section | Disposition | Relocated blocks → owner |
|---|---|---|
| Project | keep | — |
| Source-of-truth order | keep | — |
| Current architecture | condense | 111–136 → 094 |
| Repository layout | keep | — |
| Current services and skills | keep (updated to current skills) | — |
| Task and plan flow | condense | 245–253 → 065; 255 → 020; 257–290 → 054; 292–342 → 065; 344–377 → 096 |
| Planning Agent (retired) | relocate | 381–411 → 051; 413–512 → 026 †; 514–560 → 030 ‡ |
| Adaptive supervisor | condense | 579–617 → 064; 628–743 → 028; 745–792 → 060; 794–820 → 038 |
| Per-component LLM provider config | relocate | 824–892 → 039 |
| Approval preview content and diffs | relocate | 896–974 → 040 |
| Opt-in LLM harness (Documentation) | relocate | 978–1013, 1085–1118 → 041; 1014–1083 → 100; 1120–1130 → 077; 1132–1147 → 111 |
| Opt-in LLM harness (DevOps) | relocate | 1151–1219 → 042; 1221–1257 → 056; 1259–1266 → 077 |
| Deep project analysis | relocate | 1270–1421 → 103 |
| Shared project analysis | relocate | 1425–1522 → 105 |
| A local SQLite store | relocate | 1526–1684 → 106 |
| Tasks and chat survive a restart | relocate | 1688–1806 → 107 |
| A durable, queryable audit trail | relocate | 1810–1924 → 108 |
| The dashboard's Audit tab goes live | relocate | 1928–2036 → 113 |
| Documentation drift recheck | relocate | 2040–2075 → 109 |
| A pending approval survives a restart | relocate | 2079–2197 → 110 |
| Capability roadmap and Phase A | relocate | 2201–2217 → 078; 2219–2336 → 079 |
| Phase B: run_command | relocate | 2340–2471 → 080; 2473–2482 → 077 |
| Phase C: write-tests | relocate | 2486–2573 → 081 |
| Phase D: Code Review Agent | relocate | 2577–2742 → 082; 2744–2756 → 083; 2758–2770 → 086 |
| Phase E: Coder Agent v1 | relocate | 2774–2867 → 083; 2869–2878 → 086; 2880–2946 → 098 |
| Coder Agent v2 | relocate | 2950–3078 → 114 |
| Opt-in LLM harness (Security) | relocate | 3082–3177 → 043; 3179–3189 → 077 |
| Phase F: OSV.dev | relocate | 3193–3299 → 084 |
| Multi-ecosystem dependency auditing | relocate | 3303–3421 → 085 |
| TUI orchestrator URL resolution | relocate | 3425–3475 → 099 |
| Conversational ask layer | condense | 3491–3504 → 091; 3506–3523 → 092; 3525–3548 → 093; 3593–3602, 3632–3637 → 044; 3604–3630 → 046 |
| Chat gains real intent classification | relocate | 3641–3719 → 075 |
| Every agent LLM harness opt-out | relocate | 3723–3790 → 077 |
| Code Review and Coder default-on | relocate | 3794–3843 → 086 |
| Project snapshot and cross-request reuse | relocate (superseded by 106) | 3847–3882 → 057 |
| Provider call budgets | relocate | 3886–3950 → 055 |
| Live event protocol (AG-UI) | condense | 3954–3988 → 027 |
| TUI bracketed paste | relocate | 4025–4063 → 059 |
| TUI dashboard-parity workspace | relocate | 4067–4172 → 069 |
| TUI thread selection / audit view | relocate | 4176–4312 → 115 |
| Chat: one voice | relocate | 4316–4428 → 116 |
| Tool sharing and skill ownership | relocate + restate rules | 4432–4524 → 101 |
| Orchestrator read-only inspection | relocate + restate | 4545–4676 → 102 (carve-outs: 4578–4590 → 103; 4660–4676 → 101); 4678–4706 → 112 |
| Human approval and safety | keep substantively | 4738–4798 → 089; 4800–4879 → 097; 4892–4915 → 058; 4917–4938 → 111 |
| Commands | keep + condense | 5003–5035 → 066; 5037–5066 → 017 |
| Target project resolution | keep rules + condense init | 5079–5098 → 087; 5100–5115 → 088; 5155–5176 → 031; 5178–5211 → 034; 5213–5230, 5262–5287 → 050 §; 5232–5260 → 070; 5289–5336 → 063; 5338–5376 → 068; 5378–5435 → 071; 5437–5467 → 095; 5469–5517 → 072; 5519–5587 → 073; 5589–5642 → 049 |
| Verification status | refresh | 5664–5684 → 020 ¶; 5686–5700 → 052 |
| Known limitations and technical debt | condense | 5724–5729 → 073; 5736–5765 → 110; 5772–5778 → 085; 5779–5783 → 083; 5785–5847 → 016 **; 5849–5866 → 067; 5868–5889 → 074; 5891–5908 → 045; 5910–5929 → 017; 5930–5936 → 018; 5937–5968 → 019 ††; 5970–6032, 6034–6060, 6062–6089 → 032; 6094–6108 → 012; 6120–6133 → 020 |
| Working procedure | keep + new §5 rules | — |
| Current recommended priority | condense | 6202–6234 → 054 ¶ |
| Where history lives (new) | added | — |

Attribution judgment calls, recorded per the spec's rule:

- † 413–512 → 026, not 029: the block is 026's harness design extended by 029 (provider parsing); 026 is the primary subject, 029 receives a pointer.
- ‡ 514–560 → 030, not 037: one flowing paragraph — 030's live-incident story whose tail records the 033/035/037 preview-card lineage that fixed the incident's finding. 033 designed the card, 035/037 ported it; 030 is the anchor. 033/035/037 receive pointers.
- § 5262–5287 → 050: the Models-view and hand-edit-merge paragraphs name no spec of their own; they are 050-era guided-init additions (judgment from context).
- ¶ 5664–5684 → 020 and 6202–6234 → 054: roll-call paragraphs naming many specs; "newest spec named" applied.
- ** 5785–5847 → 016, not 020: the early-era status roll-call names 004–020; its detailed weight lands on 016's supervisor story, and 020's own full narrative relocates separately (6120–6133).
- †† 5937–5968 → 019, not 032: the `specs/032` correction sentence is embedded mid-paragraph in 019's story and is inseparable for verbatim extraction; 032 receives a pointer.
- Correction paragraphs ("Correction, YYYY-MM-DD — …") go uniformly to the correcting spec (077, 086, 100, 111, 095, 072, 064, 067, 074, 103, 112), except the inseparable mid-paragraph case above.

## Phase-by-phase execution record (per plan.md)

- **Phase 0**: `wc -c CLAUDE.md` = 392,109; `git rev-parse HEAD` = `7bece0368ec9b19dae64029f0bcf17ec76f0b239`; per-section character table captured (matches the spec's Verified Current State). Mapping table above covers 100% of sections.
- **Phase 1**: guard landed first, alone. `bun test scripts/spec-catalog.test.ts` green; `bun run specs:check` **failed for exactly the size reason** (`CLAUDE.md is 389810 characters, 239810 over the 150000-character budget`) — recorded as the proof the check works. (389,810 is `content.length` in UTF-16 units; the byte count is 392,109 — the file contains multi-byte characters. The check reports characters, as specified.)
- **Phase 2**: relocation ran additively via a temporary script (kept outside the repository, in the OS temp directory, then deleted — no new repo files beyond the authorized outputs). 107 spec directories touched: 72 appends + 35 new `verification.md` files. `CLAUDE.md` byte-identical at this point (verified via `git status`). Boundary audit ran before writing: every block's first/last line checked; six off-by-one/mid-paragraph boundaries were caught and fixed before any file was written.
- **Phase 3**: `CLAUDE.md` rewritten present-tense (70,635 → 72,752 bytes after the safety audit's restoration fixes), all retained sections per spec §3, per-section `See specs/NNN` pointers, new `## Where history lives`.
- **Phase 4**: ownership rule added to `buildMarkdownCatalog()`'s template, catalog regenerated, `AGENTS.md` gained the identical rule + table, `context/history.md` gained the one-line frozen note.
- **Phase 5**: this record + the worklog entry.

## Known limitations / honest gaps

- The `bun test` suite has 3 pre-existing Windows-environment failures (`specs/080` `run_command` tests executing `echo`, which Windows lacks as an executable) — proven pre-existing by stash-and-rerun, unchanged in count by this work, and out of scope to fix here (runtime).
- Two other pre-existing uncommitted modifications exist in the working tree from before this session (`.opencode/agents/*`, `opencode.json`, `context/worklog.md`'s 118-draft entry, and the catalog files regenerated during spec 118's drafting); they were left untouched.
- The 150,000 figure appears in prose in `CLAUDE.md`, `AGENTS.md`, and the generated `specs/README.md`; the enforced source of truth remains the single exported constant `CLAUDE_MD_MAX_CHARACTERS` — the check's own messages always name the real budget on every run.
- The relocation's attribution choices (recorded above) are the implementing agent's application of the spec's "normally the newest" rule; a reviewer sampling any block can re-derive them from the table.

---

## Closure evidence (review round + independent re-verification, 2026-09-23)

### Review round

A read-only reviewer pass against the spec's Acceptance Criteria returned
`VERDICT: FINDINGS` — one should-fix (out of scope, see below) and two nits,
both since fixed:

1. **`scripts/spec-catalog.test.ts`** — the zero-length case asserted only
   `.ok`, not its message, unlike the under/at/over cases. Fixed; it now
   asserts `CLAUDE.md is 0 characters` and the budget value.
2. **`CLAUDE.md:174`** — "DevOps, Documentation, Testing, Code Review, and
   Coder **fail closed**" read as a flat per-agent rule, true only for
   DevOps's four *write* skills; `analyze-project`'s deep-analysis layer is
   fail-open (`specs/103`). Both facts were present and individually correct,
   but a skimming reader could have taken the wrong one. Rewritten to name the
   carve-out inline.

The reviewer also ran two checks at a scale the sampled audits did not reach,
both clean:

- **Zero-duplication sweep across the full relocation** — 328 paragraphs of
  ≥200 characters extracted from all 107 `## Narrative record` blocks, **0
  duplicated verbatim between any two `verification.md` files**. This is the
  spec's §2 "no paragraph duplicated in two files" rule checked exhaustively,
  not sampled.
- **Uniform-heading check** — all 107 relocation headings byte-identical.

It spot-verified condensed safety claims against live source —
`NEEDS_APPROVAL`/`EXECUTING_SKILLS` and the `build-image`/`verify-deployment`
approval path (`packages/agents/devops/index.ts:787-844`),
`ORCHESTRAI_MCP_ALLOWED_HOSTS` loopback defaults, the
`ORCHESTRAI_ORCHESTRATOR_INSPECTION=0` opt-out, and
`DEFAULT_MAX_DISPATCHES = 30` — all matched the condensed prose exactly. **No
factual error introduced by condensation was found, and no relocated narrative
was found misattributed or duplicated.**

### Independent live re-verification (Verification Plan items 1–3, 6)

Run against the real `bun run specs:check` CLI surface after the fixes landed,
not against unit tests:

1. **Green path.** `CLAUDE.md is 72552 characters, within the
   150000-character budget.` / `Spec governance check passed for 117 specs.`,
   exit 0. (72,552 characters / 72,859 bytes — the 307-unit gap is em-dashes
   and `≤`; the check counts UTF-16 units, so `wc -c` will never agree
   exactly.)

2. **Exact-boundary probe — not previously exercised.** `CLAUDE.md` was padded
   to *precisely* 150,000 characters:

   ```
   CLAUDE.md is 150000 characters, within the 150000-character budget.   exit 0
   ```

   Three more characters appended:

   ```
   CLAUDE.md is 150003 characters, 3 over the 150000-character budget. Relocate
   per-spec historical narrative into specs/<NNN>/verification.md (see
   specs/118) and keep CLAUDE.md to present-tense current state.         exit 1
   ```

   The bound is **inclusive**, matching the spec's "≤ 150,000" wording, and
   the overage arithmetic is correct at the boundary itself. File restored and
   md5-confirmed afterward.

3. **Missing-file path.** `CLAUDE.md` moved away → `CLAUDE.md is missing; the
   spec governance check requires it`, exit 1. No stack trace.

4. **Tamper probe on the ownership rule — the one genuinely open question this
   spec's design raised.** The spec puts the ownership table in the
   *generated* `specs/README.md`, so whether a hand-edit there is detectable
   matters. The `context/worklog.md` row was rewritten to `TAMPERED`:

   ```
   specs/README.md is stale; run bun run specs:catalog                   exit 1
   ```

   The freshness gate covers the generated **prose**, not just the catalog
   tables — so the ownership rule cannot silently drift from its generator in
   `scripts/spec-catalog.ts`. Restored; green again.

5. **Mode separation confirmed.** The size check fires only in `check` mode;
   `bun run specs:catalog` (write) with `CLAUDE.md` deliberately 90,000
   characters over budget still exits 0. This matches the spec's "advisory in
   scope but blocking in effect" constraint exactly — the gate lives on
   `specs:check`, which `AGENTS.md` now names as a required gate.

6. **Constraint re-checks.** `git diff HEAD --name-only | grep 'spec\.md'` →
   empty (no `spec.md` body or frontmatter touched during implementation). All
   86 distinct `specs/NNN` pointers in the restructured `CLAUDE.md` resolve to
   real directories. The identical ownership table appears in `CLAUDE.md`,
   `AGENTS.md`, and the generated `specs/README.md`.

### Scope note carried out of the review

The reviewer's one should-fix was **not a defect in this checkpoint's own
work**: five workflow-tooling files sat in the same uncommitted working tree
without being in this spec's Scope — `opencode.json`,
`.opencode/agents/implementer.md`, `.opencode/agents/verifier.md` (a
one-line `opencode/` → `opencode-go/` provider rename each), plus
`.claude/commands/review.md` and `.opencode/commands/fix.md` (substantive
edits that appeared mid-session). Resolved at closure by committing them
**separately** from spec 118, so the 118 commit contains only its declared
scope.

### Deliberately not done

Per the spec's own Non-Goals, no relocated narrative was corrected or
re-verified during the move — stale text moved exactly as written. Nothing in
`context/worklog.md` or `context/history.md` was restructured beyond the one
new entry and the one frozen note.

### One drafting-time claim corrected at closure

`spec.md`'s Verified Current State asserted that no git hooks are installed,
citing `.git/hooks` holding only samples. **That was wrong.** This repository
sets `core.hooksPath = .githooks`, and `.githooks/pre-commit` exists and runs —
observed firing on this checkpoint's own commit, executing
`bun run specs:check` (size gate included) and then the full suite:
`1375 pass, 2 skip, 0 fail` across 84 files. A `.git/hooks` directory holding
only samples is precisely what a configured `core.hooksPath` looks like, so
that listing was misleading evidence rather than absent evidence.

The design conclusion is unchanged and strengthened: putting the budget check
in `bun run specs:check` means it is enforced on every commit through the
existing hook, without this spec adding a hook of its own. The bullet is struck
through and corrected in place rather than rewritten, per this repository's own
convention of leaving the original claim visible alongside what it got wrong.
