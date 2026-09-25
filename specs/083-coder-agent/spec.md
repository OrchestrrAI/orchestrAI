---
id: 083-coder-agent
title: "Phase E: Coder Agent v1 — Write-Capable Source Edits"
area: coder-agent
change_type: feature
status: implemented
verification: partial
created: 2026-09-14
updated: 2026-09-14
approved_by: Yusuf
approved_on: 2026-09-14
implemented_on: 2026-09-14
amends: []
related:
  - 078-capability-upgrade-roadmap
  - 081-testing-write-tests-skill
  - 082-code-review-agent
  - 056-devops-preflight-and-idempotent-writes
  - 040-approval-preview-content-diff
  - 073-configurable-service-ports
supersedes: []
superseded_by: []
---

# Spec: Phase E: Coder Agent v1 — Write-Capable Source Edits

> **This is explicitly v1, not the final shape of a Coder Agent.** Every
> narrowing decision below (single-hunk, single-file, no new-file
> creation, no auto-chained review, external projects only) was a
> deliberate choice to ship the smallest safe slice first — the same
> pattern `specs/082` used (diff-hunks-only, then widened after direct
> feedback) and `specs/081` used (one file per approval). Read "Future
> Upgrade Path" near the end before assuming any v1 limit is permanent
> or before proposing a v2 — it names exactly what each one would need,
> so the next engineer or agent picking this up doesn't have to
> rediscover the tradeoff from scratch.
>
> **Approved by Yusuf, 2026-09-14, and implemented the same day.**
> `specs/078-capability-upgrade-roadmap/spec.md`'s own `plan.md` left
> this phase as "sketch only... needs its own spec *and* plan," gated on
> Phase C (`081`) and Phase D (`082`) reaching `verification: verified`.
> Those two phases sit at
> `verification: partial` for reasons unrelated to the mechanism this
> phase depends on — `082`'s own new-agent-integration path and grounding
> harness are proven live (twice: once against `bun run`, once against
> the actual compiled `dist/bin/orchestrai.exe`), and its own open item
> is a Docker-compose packaging gap, not a correctness question; `079`'s
> own open item is an unrelated third-party stdio-MCP-server gap that
> Phase E was never gated on. Yusuf's own explicit call, given directly
> this session: proceed on the strength of the proven mechanism rather
> than continue blocking on Docker Desktop's local availability.

## Purpose

This is the roadmap's **risk class 5**: writing model-authored *source
code* — the first phase in this codebase where a model's own output can
change program *behavior*, not just documentation content (`041`), tool
*parameters* (`042`), or a test file whose worst failure mode is loud
and harmless (`081`). `specs/078`'s own Ordering Principle requires both
of Phase E's inherited risks — model-authored file content (class 3,
`041`/`081`) and reviewing a diff for correctness (class 1 + LLM,
`082`) — to already be proven before this phase begins. Both are.

The literal question this phase answers: *"can OrchestrAI make a real,
reviewable code change to my project, not just tell me what's wrong or
write me a new test?"*

## Verified Current State

Read directly from the real files below before drafting this section —
nothing here is assumed.

**`packages/mcp/index.ts`'s `write_project_file`** (lines 870-897) is a
**whole-file** write only: `content: string`, `overwrite: boolean`. It
has no notion of a partial edit, a line range, or an anchor. It reuses
the same `containPath()` containment check and sensitive-filename
denial `read_project_file` already has. This tool is reused **completely
unmodified** by this spec — see "The key design insight" below for why.

**`packages/shared/approval.ts`'s `ApprovalPreview`** already carries
everything a single-file edit needs: `content` (the exact content that
will be written, computed once at preview time and reused verbatim at
write time — `specs/040`'s own load-bearing guarantee), `previousContent`
(present only when overwriting — enables a diff instead of two unrelated
blocks), and `fingerprint` (`computeContentFingerprint()`, `specs/056`'s
own drift guard, re-verified immediately before the real write). **All
three fields already exist and are already wired through `resumeTask()`
for every DevOps/Documentation/Testing write skill.** Nothing about this
shape is single-purpose to any one skill.

**`packages/shared/line-diff.ts`'s `computeLineDiff()`/
`buildContentPreview()`** is a dependency-free line diff already
rendered by all three clients (the Orchestrator dashboard, DevOps's own
dashboard, and the TUI — `specs/040`'s own Decision A/B). It operates on
any `(before, after)` string pair; it has no awareness of *how* the
"after" content was produced (a whole-file LLM rewrite in `041`, a
DevOps-computed template in `042`, or — as this spec proposes — a
spliced anchored replacement).

**`specs/081`'s `write-tests` skill** already established the "no
guessing" precedent this spec reuses directly: an explicit source file
path must be named in the task text; absent one, the task fails closed
rather than picking a file. It also established the fail-closed (not
Security's fail-open) precedent for a skill with no deterministic
fallback — "there is no non-LLM answer for `write tests for this file`"
maps directly onto "there is no non-LLM answer for `make this specific
code change."

**`specs/082`'s `code-review-agent`** proved the full new-agent
integration path is cheap: one real routing-registry line
(`KNOWN_AGENTS`), a mechanical mirror at every other registration point,
and a genuine 7th touchpoint (`apps/supervisor/init-form.tsx`'s
`PORT_ROW_LABELS`) that only `tsc`'s own exhaustiveness check caught —
expect and budget for finding the same or an equivalent gap again here,
not to skip it.

**No anchored/range-based edit tool exists anywhere in this codebase.**
This genuinely is new surface — but, per the design below, it turns out
to require no new MCP tool and no new approval-preview shape, only new
*agent-level* reasoning about *where* in an already-fetched file to make
a change.

## Proposed Behavior

### 1. A new agent: `coder-agent`, port 3008

A brand-new agent (`packages/agents/coder/`), not a skill bolted onto
DevOps or Testing — mirrors `specs/082`'s own new-agent precedent.
Reasons this is the right call, not the low-effort default: DevOps's
identity is infrastructure actions (`dockerize`, `create-ci`, `run-
command`); Testing's is test execution and (as of `081`) test
*authorship* specifically; folding general source editing into either
would blur an already-established boundary the roadmap's own phase
separation (`C` vs. `E`) argues against. One skill: `edit-file`.

### 2. Edit granularity: anchored replacement, not a whole-file rewrite

The model does not regenerate an entire file. It identifies a precise
span of the file's **real, current content** to replace — `old_text` —
and supplies its replacement, `new_text`. This is a deliberate
precision/safety choice over a whole-file rewrite (which `041`/`042`
already use safely for their own, lower-stakes outputs): a large file
with one small requested change should produce a small, reviewable
diff, and an LLM asked to reproduce an entire file verbatim except for
one change is a real, avoidable source of accidental corruption
elsewhere in the file.

### 3. The key design insight: this needs almost no new plumbing

A single-file anchored edit still ultimately produces one full "before"
and one full "after" file content pair — **exactly** the
`content`/`previousContent` shape `ApprovalPreview` already has. The
"anchored" constraint is purely how the *model* is asked to express its
own proposed change; it is not a new approval-preview shape, and it
requires **no new client-rendering work** in any of the three existing
approval-card surfaces. Consequently, **no new MCP tool is needed
either** — `read_project_file` (already existing, already read-only,
already in every other harness's own allow-list) supplies the real
content to the harness, and `write_project_file` (already existing,
completely unmodified) performs the final, already-approved write. This
matches `specs/042`'s own stated principle: increase tool surface only
where the implementation shows a real need — here, none exists.

### 4. The harness: `runEditFileHarness()`

A new LangGraph tool-calling harness (`packages/agents/coder/
llm-harness.ts`), structurally identical to every prior harness in this
codebase: one read-only tool bound (`read_project_file`,
`READ_ONLY_TOOL_NAMES`-enforced the same way `buildReadOnlyTools()`
already throws on any other binding), producing one structured,
Zod-validated response:

```ts
const EditProposalSchema = z.object({
  old_text: z.string().min(1),
  new_text: z.string(),
})
```

(`new_text` may legitimately be an empty string — a pure deletion is a
valid edit; `old_text` may not be empty — there is nothing to anchor
against.)

### 5. The grounding validator — the actual safety mechanism

`old_text` must appear in the file's real, current content as an
**exact, contiguous substring, exactly once**:

- **Zero occurrences** → retry-with-feedback: "This text was not found
  verbatim in the file — quote it exactly as it appears, including
  whitespace."
- **Two or more occurrences** → retry-with-feedback: "This text appears
  N times — it is ambiguous which one to replace. Give a longer, more
  specific span that is unique."
- Exhausted retries → the task **fails closed**, the same precedent
  `081`/`082` already established: there is no deterministic fallback
  for "make this specific code change."

This is the same structural-enforcement style
`containsForbiddenVulnerabilityClaim()` (`043`) and `isGrounded()`
(`082`) already use — a validator checked in code against the real
source, not a prompt instruction alone.

### 6. The skill handler: `handleEditFileSkill()`

1. Resolve the target project root via the shared `resolveTargetPath()`
   resolver, unmodified (external target projects only — see Scope).
2. **Require an explicit file path in the task text** — the same "no
   guessing" precedent `081`'s `write-tests` already established. Absent
   one, fail closed with a named error.
3. **Require the task text to also describe the change to make.** There
   is no sensible default instruction for "edit this file" alone — a
   task like `"edit src/foo.ts"` with no further description fails
   closed with a named error naming what's missing, distinct from the
   no-path error above.
4. Read the real file content via `read_project_file`.
5. Run `runEditFileHarness()`.
6. On a grounded, validated result: splice `old_text` → `new_text` into
   the real original content (string replacement — `old_text` has
   already been proven unique by step 5, so this is unambiguous) to
   produce the full new file content.
7. Build the `ApprovalPreview` exactly as `generate-readme`/`write-tests`
   already do: `content` = new full file, `previousContent` = old full
   file, `fingerprint` = `computeContentFingerprint()` of the **original**
   content. Stored once, reused verbatim at write time — `specs/040`'s
   own load-bearing guarantee, unmodified.
8. `resumeTask()` re-verifies that fingerprint immediately before calling
   `write_project_file` with the already-computed `content`,
   `overwrite: true`. A mismatch (the file changed between preview and
   approval) refuses the write and requires a fresh preview —
   `specs/056`'s own exact drift-recheck pattern. **No additional
   re-grounding check is needed at write time**: an unchanged fingerprint
   means the file is byte-identical to preview time, so `old_text`'s
   uniqueness still holds by construction.

### 7. Fail-closed, not fail-open

`ORCHESTRAI_CODER_LLM_HARNESS` unset, or set with a misconfigured/
unresolvable key, fails every `edit-file` task closed with a named
error. There is no non-LLM answer for "make this specific code change" —
the same precedent `081`/`082` already established, deliberately not
Security's fail-open shape (which exists only because Security always
has a real deterministic scan to fall back on; this skill has none).

## Scope

**In scope:**
- One new agent, `coder-agent`, port 3008, one skill: `edit-file`.
- Anchored single-file, single-hunk edit, per the design above.
- The grounding validator and its bounded retry-with-feedback loop.
- Full registration-point wiring (see `plan.md`).

**Explicitly out of scope for this phase (v1 non-goals, not silently
narrowed):**
- **Multi-hunk edits within one file/task.** A second edit to the same
  file is a second task — the same one-approval-per-file precedent
  `081` already established.
- **Multi-file batch under one approval.** The existing `ApprovalPreview`
  shape structurally cannot express this without new work this spec
  does not attempt; a multi-file change is several independent task
  submissions.
- **Creating a brand-new file.** The anchored-edit concept has no
  meaning against a file that doesn't exist yet; `write_project_file`
  already supports fresh creates, but that shape belongs to a
  `generate-readme`-like flow, not this skill.
- **Automatically routing an edit through `code-review-agent`
  afterward.** The human approval on the diff card is this skill's own
  safety mechanism; composing it with a follow-up automated review is a
  possible future workflow, not a requirement here.
- **Editing OrchestrAI's own running source tree.** Same
  `resolveTargetPath`/`ORCHESTRAI_PROJECT_PATH` convention every other
  write-capable skill already uses, unmodified — external target
  projects only. Self-modification while running is a materially
  different, higher-stakes question this spec does not attempt to
  answer.
- Go/Rust/other-language-specific editing conventions beyond what the
  model itself already knows — no new per-language tooling.

## Safety and Compatibility Constraints

- **The approval gate is never weakened.** `edit-file` goes through the
  exact same `actionId`-bound `resumeTask()` flow every other
  write-capable skill already uses. `SKILL_TIER_REGISTRY` gains
  `"edit-file": "write-capable"` — an unregistered skill already
  defaults to write-capable/approval-required, fail-closed, so this is
  belt-and-suspenders, not a new mechanism.
- **The grounding validator is structural, not a prompt instruction
  alone** — checked in code against the real file content, the same
  enforcement style `043`'s CVE guard and `082`'s diff-grounding
  validator already use.
- **The fingerprint drift-recheck is unmodified from `specs/056`'s own
  pattern** — reused, not reinvented.
- **No new MCP tool, no new write-capable surface.**
  `read_project_file`/`write_project_file` are both reused completely
  unmodified — `READ_ONLY_TOOL_NAMES` and the write-tool's own
  containment/sensitive-filename checks are untouched by this spec.
- **No shell execution anywhere in this path** — the harness only calls
  `read_project_file` (read-only); the actual disk write goes through
  the existing, unmodified `write_project_file`.
- **Fail-closed with no deterministic fallback**, matching `081`/`082`.

## Out of Scope / Non-Goals

See "Explicitly out of scope" under Scope above — restated here per this
repo's own template convention: multi-hunk edits, multi-file batches,
new-file creation, auto-chained review, and self-editing OrchestrAI's own
source are all deliberately not attempted in this phase.

## Future Upgrade Path (v2+, not this phase)

Each v1 narrowing decision has a concrete, already-identified upgrade
path — recorded here so a later engineer or agent doesn't have to
re-derive the tradeoff, and doesn't mistake a v1 boundary for a
permanent architectural limit:

- **Multi-hunk edits in one file/task.** The grounding validator
  (§5) already generalizes to a *list* of `{old_text, new_text}` pairs
  with no change to its own logic — validate each independently against
  the original content, then apply all of them to produce the final
  file. The real new work would be the retry-with-feedback UX when only
  *some* hunks in a batch ground correctly (salvage the good ones vs.
  fail the whole batch — `specs/082`'s own salvage-on-exhaustion design
  for `review-diff` is the direct precedent to reuse, not reinvent).
- **Multi-file batch under one approval.** Needs a genuine new
  `ApprovalPreview` shape (today's is one `target`/`content`/
  `previousContent` triple) and new rendering in all three client
  surfaces (`specs/040`'s two dashboards + the TUI) — real, scoped UI
  work, not a backend-only change. Worth doing once single-file `edit-
  file` has real usage evidence, the same "prove it narrow first" order
  this whole roadmap has followed.
- **New-file creation.** `write_project_file` already supports a fresh
  create (`overwrite: false` against a nonexistent path) — a `create-
  file` skill needs no anchored-edit machinery at all, closer in shape
  to `generate-readme` than to `edit-file`. Likely its own small, separate
  skill on this same agent rather than an extension of `edit-file`
  itself.
- **Auto-chained review.** Once `edit-file` has real usage, wiring a
  completed edit's own diff straight into `code-review-agent`'s
  `review-diff` (as a suggested, still-human-approved follow-up, never
  automatic) is a plan-task-shaped composition — the adaptive supervisor
  (`specs/028`) already knows how to sequence two skills; this would be
  a new multi-step plan pattern for it to learn, not a change to either
  agent.
- **Editing OrchestrAI's own source tree.** Needs its own explicit
  safety analysis (self-modification while running) before it's even a
  design question, not just a scope toggle — deliberately not
  pre-answered here.

## Acceptance Criteria

- [x] A real anchored edit lands correctly on a real file: a genuine,
      unique `old_text` span is correctly replaced with `new_text`, the
      rest of the file byte-identical, approved write matching the
      preview exactly. Live-verified with a real Gemini deployment.
- [x] A not-found anchor (the model's proposed `old_text` doesn't exist
      verbatim in the real file) triggers retry-with-feedback and, on
      exhaustion, fails the task closed — never a guessed or partial
      edit. Hermetically confirmed (`llm-harness.test.ts`); a live
      provider pass is still the Verification Plan's own remaining item.
- [x] An ambiguous anchor (the proposed `old_text` matches more than
      once) triggers a distinct retry-with-feedback message and, on
      exhaustion, fails the task closed. Hermetically confirmed
      (`llm-harness.test.ts`).
- [x] A drift-refusal: preview shown, target file mutated before
      approval, approval refused with a named error, file left holding
      the manual mutation, not corrupted. Live-verified.
- [x] A rejection creates nothing — the file is byte-identical before
      and after a rejected preview. Live-verified (md5 hash confirmed
      identical before and after rejection).
- [x] No explicit file path in the task text fails closed with a named
      error, no MCP call made. Confirmed via real HTTP requests against
      the real, unmodified app (`index.test.ts`).
- [x] No description of the intended change in the task text fails
      closed with a named error, distinct from the no-path error.
      Confirmed via real HTTP requests (`index.test.ts`).
- [x] Harness flag off fails every task closed with a named error, past
      a resolvable project root. Confirmed via real HTTP requests
      (`index.test.ts`). **The "on but no resolvable key" sub-case is
      the same code path** (`readLlmHarnessConfig()` returning `null`)
      already proven for every other harness in this codebase, but not
      separately unit-tested here — recorded honestly, not implied.
- [x] The LLM router names `edit-file` with zero hardcoded routing
      change — the same exit-gate scenario `082` already proved for
      `review-diff`. Live-verified: with `coder-agent` the only agent
      online, a natural-language request with no `selectedSkill`
      resolved to `{"assignedAgent":"coder-agent","skill":"edit-file"}`
      purely from the live capability snapshot.
- [x] Every registration touchpoint from `plan.md`'s own list is wired
      and typechecks clean. No additional gap beyond the plan's own list
      was found this time — `bun run typecheck` passed clean on the
      first attempt after wiring every listed touchpoint.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` all pass;
      the full pre-existing suite is unaffected — 1009 pass, 0 fail
      (net +26 over the pre-083 baseline), typecheck clean, specs:check
      passed for 83 specs. Six pre-existing tests in
      `init-form-state.test.ts` needed updating for the 6th agent
      joining shared tables (the `AGENTS` fixture array,
      `modelsRows()`/`agentLlmFieldsFor()`/`formStateToWizardConfig()`
      expectations) — the same class of legitimate update `specs/082`'s
      own addition required, not a test-only patch.

## Verification Plan

- Unit-level: the grounding validator (not-found, ambiguous, exactly-
  once, deletion-to-empty-string) and the harness's own retry/fail-
  closed behavior via a `ScriptedChatModel`/`MockMcpToolCaller` pair,
  mirroring `082`'s own `llm-harness.test.ts`.
- HTTP-level: Agent Card shape, fail-closed preconditions (no path, no
  description, no live MCP server), skill detection — mirroring `082`'s
  own `index.test.ts`.
- Live: a real Gemini deployment, a real scratch project with a genuine,
  targeted bug or improvement, a real anchored edit correctly proposed,
  grounded, previewed, approved, and landed — byte-comparison against
  the preview. The not-found/ambiguous-anchor and drift-refusal
  scenarios reproduced live, not just unit-tested. The router-naming
  scenario reproduced through the real Orchestrator with other agents
  isolated, the same methodology `082` already used.
- Registration: `bun run typecheck` as the structural backstop that
  already caught `082`'s own missed 7th touchpoint — treated as a real
  check, not a formality.

## Approval Requested

**Approved by Yusuf, 2026-09-14, and implemented the same day.** See
`verification.md` for the live-pass record; `verification: partial`
reflects what remains genuinely open (the live-provider pass), not any
unresolved design question.
