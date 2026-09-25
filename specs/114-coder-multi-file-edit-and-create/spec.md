---
id: 114-coder-multi-file-edit-and-create
title: "Coder Agent v2: Multi-File Edits and New-File Creation"
area: coder-agent
change_type: feature
status: implemented
verification: partial
created: 2026-09-22
updated: 2026-09-23
approved_by: Yusuf
approved_on: 2026-09-22
implemented_on: 2026-09-23
amends:
  - 083-coder-agent
  - 098-harness-recursion-limit-and-clean-failure
  - 101-per-agent-tool-access-expansion
  - 110-approval-state-survives-a-restart
related:
  - 104-deferred-work-register
  - 082-code-review-agent
  - 040-approval-preview-content-diff
  - 056-devops-preflight-and-idempotent-writes
supersedes: []
superseded_by: []
---

# Spec: Coder Agent v2: Multi-File Edits and New-File Creation

> Status: **IMPLEMENTED, verification: partial** — see
> `verification.md` for the full record. Requested directly by Yusuf: "the
> coder and reviewer agent is need more and more care and upgrade so i
> can tell it something like what i tell you and it can do it." Given a
> staged roadmap (self-verification via `run_command`/`run_tests`
> first, then multi-file edits, then new-file creation, then deep
> analysis access for Code Review), Yusuf's own explicit choice was
> multi-file edits — and, in the same session, to fold new-file
> creation into this same spec rather than leave it for later (it was
> `specs/083`'s own third-named v1 limitation, alongside multi-file and
> self-verification). Self-verification (`run_command`/`run_tests`
> access, `specs/104` item A5) and Code Review's own deep-analysis
> access (`specs/104` item A11's remainder) remain explicitly deferred
> to their own future specs — both are separate risk classes needing
> their own approval, per `specs/078`'s own ordering rule.

## Current behavior (verified against the real code)

`packages/agents/coder/index.ts`'s only skill, `edit-file`, is
single-file, single-hunk, existing-file-only — all three limits stated
explicitly in `specs/083`'s own "Future Upgrade Path." Concretely:

- `extractTargetFileToken()` (line 113) matches exactly one
  `\.\w+`-suffixed token after `edit`/`modify`/`change` — there is no
  parsing path for more than one file.
- `handleEditFileSkill()` (line 194) reads exactly one file via
  `read_project_file`, and explicitly fails closed if it doesn't exist
  (line 249-251: `"edit-file requires an existing file to edit (see
  specs/083's own Future Upgrade Path for new-file creation)"`).
- `EditFileAction`/`EditFileActionSchema` (lines 144-175) carry exactly
  one `relativePath`/`content`/`previousContent`/`fingerprint` quadruple.
- `buildApprovalPreview()` (line 177) produces one `ApprovalPreview`
  with the single-file `content`/`previousContent`/`fingerprint`
  fields `specs/040`/`specs/056` already defined for every write-capable
  skill in this codebase.
- `packages/agents/coder/llm-harness.ts`'s `runEditFileHarness()`
  returns exactly one `EditProposal` (`{old_text, new_text}`) or a
  `Refusal` — never a set.

## Proposed behavior

### A new skill, `edit-files`, alongside the untouched `edit-file`

Matches this codebase's own established precedent (`specs/081` added
`write-tests` as a new skill rather than widening `run-tests`;
`specs/079` added five new DevOps skills rather than widening
`dockerize`) — the existing, already-proven single-file path stays
byte-identical, zero regression risk, and the new capability is
additive. `agentCard.skills` gains a second entry:

```ts
{
  id: "edit-files",
  name: "Edit Files",
  description: "Propose a coherent, potentially multi-file change from a free-form instruction — the model explores the real project (read_project_file/analyze_project/git_status/git_diff) to decide which files need touching, including creating new files, and every edit is shown as a content diff and requires human approval before anything is written. Bounded to 6 files per proposal.",
  examples: ["edit-files at C:\\path: rename the Logger class to AppLogger everywhere it's used", "edit-files at C:\\path: extract the shared validation logic in src/routes into a new src/validation.ts module"],
}
```

**Deliberately no explicit multi-file-name parsing.** This is the real
design decision behind "tell it what I tell you": the task text is a
free-form instruction with **no required file list** — the model
decides which files need touching itself, using the read-only tools it
already has bound (`specs/101`: `read_project_file`, `analyze_project`,
`git_status`, `git_diff`). Building a reliable "list of files" text
grammar was considered and rejected as low-value, fragile natural-
language parsing for a case the LLM router (`specs/065`) already
handles better — a real user's request is free text either way, and
`selectedSkill` is authoritative once the Orchestrator has routed it
(`specs/030`), so `detectSkill()`'s own role here (direct-to-agent
dispatch only, bypassing the Orchestrator) needs only a narrow,
best-effort heuristic, not a precise one.

### Per-file proposal shape, in the harness

`packages/agents/coder/llm-harness.ts` gains a second entry point,
`runEditFilesHarness()`, sharing the exact same read-only tool set,
recursion limit, and retry-with-feedback core `runEditFileHarness()`
already uses — **no widening of `READ_ONLY_TOOL_NAMES`**, this skill
still never binds a write-capable tool; the actual write happens only
after human approval, in `resumeTask()`, exactly like today.

```ts
const FileEditSchema = z.object({
  path: z.string().min(1),   // relative to project root
  action: z.literal("edit"),
  old_text: z.string().min(1),
  new_text: z.string(),
})
const FileCreateSchema = z.object({
  path: z.string().min(1),
  action: z.literal("create"),
  content: z.string(),
})
const MultiFileProposalSchema = z.object({
  files: z.array(z.union([FileEditSchema, FileCreateSchema])).min(1).max(MAX_FILES_PER_EDIT),
})
```

`MAX_FILES_PER_EDIT = 6` — a real, grounded bound (matching
`HARNESS_RECURSION_LIMIT`'s own "grounded, not placeholder" precedent):
large enough for a genuine coherent refactor across a handful of
related files, small enough that a human can still meaningfully review
every diff in one sitting. A proposal naming more files than the bound
is rejected by the same Zod-shape validation every other harness
parameter already goes through, with feedback naming the real count and
the bound, giving the model a chance to narrow its own scope rather
than failing closed immediately — mirroring the existing
retry-with-feedback shape, not a new mechanism.

### Grounding — per-file, both actions

The same structural-enforcement style every harness in this codebase
already uses, extended per file:

- **`action: "edit"`**: `old_text` must occur **exactly once** in that
  specific file's own real, current content — read via
  `read_project_file` for each named path (not just the one file
  `edit-file` reads today). Zero or ambiguous occurrences trigger the
  same bounded retry-with-feedback shape `runEditFileHarness()` already
  uses, naming the specific offending file and reason.
- **`action: "create"`**: the path must **not already exist** — grounded
  by a real `read_project_file` call expected to fail with
  `PATH_NOT_FOUND_PREFIX` (the exact inverse of `edit-file`'s existing
  "must already exist" check); a path that does exist triggers
  retry-with-feedback naming the collision, since `edit-files` never
  silently overwrites a file the model meant to create fresh — that's
  what `action: "edit"` is for.
- **Path containment**: every proposed path is resolved and checked
  against the project root exactly the way `edit-file`'s own
  `relativePath.startsWith("..")` check already works, applied per
  file — a path escaping the project root is rejected outright, no
  retry (the same fail-closed shape a plainly-invalid request already
  gets, not a correctable mistake).

**Salvage on exhaustion, matching `specs/082`'s own precedent, applied
here for the first time in Coder**: unlike `edit-file`'s own "nothing
to salvage, a single proposal either grounds or it doesn't," a
multi-file proposal genuinely can have some files ground and others
not. On final retry exhaustion, the largest fully-grounded subset seen
across any attempt is salvaged and presented for approval — covering
**fewer files than originally proposed, never more** — with an explicit
note listing which files were dropped and why. The task fails closed
only when **zero** files in the final attempt ground successfully.

### The approval preview — a new, additive field, not a rewrite

`packages/shared/approval.ts`'s `ApprovalPreview` gains one new optional
field:

```ts
files?: {
  target: string
  action: "edit" | "create"
  content?: string
  previousContent?: string
  fingerprint: string
}[]
```

Used **only** by `edit-files` — every existing write-capable skill in
this codebase leaves it `undefined` and is completely unaffected;
`content`/`previousContent`/`fingerprint` (the single-file fields)
similarly stay unused by `edit-files`, which sets `target` to a short
human-readable summary (e.g. `"3 files in src/ (2 edits, 1 new)"`)
instead. This mirrors exactly how `commit-changes` (`specs/079`)
already diverges from the single-file shape (a diff of a *commit*, not
a file) without needing its own preview `kind` — `files[]` is the
analogous divergence for "a diff of *several* files."

### The write path — all-or-nothing preflight, best-effort execution

`resumeTask()`'s drift recheck, extended per file: **before writing
any file, re-verify every file's fingerprint** (existing content for
an edit, `PATH_NOT_FOUND_PREFIX` confirmed for a create) — if **any**
file has drifted since the preview was shown, refuse the **entire**
batch, matching `edit-file`'s own "no partial edit to salvage on
drift" precedent, now extended to "no partial multi-file write on
drift." Only once every file passes its own recheck does the write
loop begin.

**A real, disclosed limitation, not solved by this spec**: there is no
cross-file atomic transaction at the `write_project_file` MCP-tool
level — each file is still one independent tool call. If file 3 of 5
succeeds and file 4 fails (a genuine filesystem error mid-batch, not a
drift case already caught above), the task result states **exactly**
which files were written and which weren't, rather than claiming a
false all-or-nothing guarantee for that specific failure mode. This
mirrors the honesty `specs/110`'s own "Crash during execution" section
already established for a different partial-completion risk in this
codebase — named explicitly rather than glossed over, and left as a
real limitation for a future spec to consider (a two-phase write with
a rollback list, e.g.) rather than solved here under this spec's own
time budget.

### Dashboard and TUI rendering

**Dashboard**: `renderApprovalCard()` (`apps/orchestrator/index.ts:3976`,
ported per-instance to DevOps's own dashboard too, matching
`specs/035`'s existing precedent) branches on `approval.files` being
present: instead of one `computeLineDiff()` call, it loops over
`files[]` and renders one labeled diff block per file (path + action
badge — "EDIT"/"NEW" — above each), reusing the exact same
`computeLineDiff()` algorithm per file, never a new diff mechanism.

**TUI — deliberately a compact summary, not N inline diffs.** Given
this file's own 16+-round terminal-overflow-bug history
(`specs/012`/`047`/`069`), rendering a variable, potentially-large
number of full diffs inside the Detail overlay's existing fixed-height
scrollbox is exactly the unbounded-content risk class those rounds
exist to prevent. Instead, the Detail overlay's approval block shows
one summary line per file (`EDIT src/a.ts (+3/-1)` / `NEW
src/validation.ts (+42 lines)`, using `computeLineDiff()`'s own line
counts, never the full diff text) plus one note: `"Full diffs: see the
dashboard's Audit/Tasks view for this task."` This is bounded by
construction (one short line per file, capped at `MAX_FILES_PER_EDIT`
= 6 lines maximum) rather than needing its own live-terminal
verification gate the way a genuinely new scrolling mechanism would —
still, given this file's own established discipline, the actual
rendered output should be confirmed in a real terminal before this
spec is marked verified, not merely asserted correct from the code.

## Scope

In scope: the new `edit-files` skill (Agent Card, harness, action
handler, approval preview extension, drift-recheck extension,
restore-on-restart schema extension), new-file creation as one of the
two per-file actions, dashboard multi-file diff rendering, the TUI's
own bounded summary rendering.

Out of scope, explicitly: Coder self-verification
(`run_command`/`run_tests` access, `specs/104` item A5 — its own
future spec); Code Review's own deep-analysis access (`specs/104` item
A11's remainder); any change to `edit-file`'s own existing single-file
behavior; cross-file atomic write transactions (named as a real,
disclosed limitation above, not attempted); file deletion (only
`edit`/`create`, never `delete`, in this version).

## Safety constraints

- **The approval gate is completely unchanged in kind, only extended
  in shape.** A multi-file proposal still requires the identical
  `actionId`-bound `POST /tasks/:id/approve` every other write-capable
  skill already uses — `files[]` is additive data on the same
  `ApprovalPreview`, not a new approval mechanism.
- **No write-capable tool is ever bound to the harness** — identical to
  `edit-file`'s own existing structural guarantee
  (`READ_ONLY_TOOL_NAMES`, checked at graph-build time). The model
  proposes; `resumeTask()`, after human approval, executes — unchanged.
- **Bounded, never unbounded.** `MAX_FILES_PER_EDIT` is a hard cap
  enforced by the Zod schema itself (`.max(MAX_FILES_PER_EDIT)`), not a
  soft guideline the model could exceed and have silently truncated.
- **Fail-closed, matching `specs/083`'s own precedent** — there is no
  deterministic fallback for "make this specific multi-file change";
  the harness off, misconfigured, or exhausting retries with zero
  grounded files all fail the task closed with a named error, exactly
  as `edit-file` already does.
- **All-or-nothing drift refusal**, stated above — a target that
  changed after approval but before write, for even one file in the
  batch, refuses the entire batch rather than writing a subset the
  human never actually reviewed in that exact form.

## Acceptance criteria

- [x] A real free-form instruction naming no explicit files, against a
      real scratch project, produces a genuine multi-file proposal
      (at least 2 files, including at least one `create`) that the
      model discovered itself via its own read-only tool calls.
      Live-verified: "rename the Logger class to AppLogger everywhere
      it's used, and create a new file src/constants.ts..." correctly
      produced a real 3-file proposal (2 edits, 1 create) with no file
      named in the request text.
- [x] Every proposed file's grounding is independently verified — unit
      tested directly (`llm-harness.test.ts`'s "each file is grounded
      independently" test: one file ambiguous, the other already
      correct, retry-with-feedback names only the offending file).
      Not separately forced live (the live pass's own real model
      grounded both files correctly on the first attempt both times) —
      covered by the hermetic unit test instead, matching this
      codebase's own established precedent for this class of scenario
      (`specs/083`'s own not-found/ambiguous-anchor case).
- [x] A proposal naming more than `MAX_FILES_PER_EDIT` files is
      rejected with feedback naming the real count and the bound, not
      silently truncated. Unit-tested directly.
- [x] On final retry exhaustion with a mixed grounded/ungrounded
      result, the grounded subset is salvaged and reaches approval;
      with zero grounded files, the task fails closed. Unit-tested
      directly (both the salvage and the zero-grounded-files cases).
- [x] Approving a multi-file proposal writes every file exactly as
      previewed. Live-verified: all 3 files landed on disk
      byte-identical to the preview. The dashboard's approval card
      rendering (one labeled diff per file, EDIT/NEW badge) is
      implemented and code-reviewed but not exercised in a real
      browser — see verification.md.
- [x] A manual mutation of any one file between preview and approval
      refuses the entire batch — no partial write — with the
      unmutated files confirmed still unwritten. Live-verified: a
      2-file proposal with `util.ts` manually mutated before approval
      was refused entirely, with `handler.ts` (never itself mutated)
      confirmed still holding its pre-approval content, not written.
- [x] `edit-file`'s own existing behavior (single-file, all its
      existing tests) is unchanged — full regression check. All
      pre-existing `llm-harness.test.ts`/`index.test.ts` tests for
      `edit-file` pass unmodified.
- [ ] The TUI's Detail overlay renders the bounded per-file summary
      correctly at 80×24 in a real terminal — live-verified, not just
      asserted from the code, per this file's own established
      standard. Not yet performed — needs a real interactive terminal,
      the same standing gap every TUI checkpoint in this codebase
      carries; covered by focused unit tests
      (`format-approval-rows.test.ts`) in the meantime.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.

## Verification plan

- Unit: the new harness's own grounding/salvage/bound tests
  (mirroring `llm-harness.test.ts`'s existing coverage style for
  `edit-file`), the approval-preview extension, the all-or-nothing
  drift-recheck logic, the restore-on-restart schema.
- Live: a real scratch project, a real multi-file free-form
  instruction (a genuine rename-across-files or extract-a-module case),
  confirming the model's own file discovery, a real multi-file
  approval reaching the dashboard with correct per-file diffs, and a
  real drift-refusal scenario (mutate one of several files before
  approving).
- Live, TUI-specific: the bounded summary rendering, confirmed in a
  real terminal per this file's own established verification standard
  for `apps/tui/index.tsx` changes.

## Non-goals

- Coder self-verification (`specs/104` item A5) — its own future spec.
- Code Review's own deep-analysis access (`specs/104` item A11's
  remainder) — its own future spec.
- File deletion as a third per-file action.
- Cross-file atomic write transactions.
- Any change to `edit-file`'s own existing single-file skill.
