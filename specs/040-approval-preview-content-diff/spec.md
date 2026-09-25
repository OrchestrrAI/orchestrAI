---
id: 040-approval-preview-content-diff
title: Approval Previews Show Real Content — a Diff When Overwriting
area: dashboard
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-01
updated: 2026-09-02
approved_by: Yusuf
approved_on: 2026-09-02
implemented_on: 2026-09-02
amends:
  - 033-dashboard-approval-preview-card
  - 035-devops-dashboard-approval-preview-card
  - 037-tui-approval-preview-card
supersedes: []
superseded_by: []
related:
  - 006-runtime-stabilization
  - 011-remaining-agents-mcp
---

# Spec: Approval Previews Show Real Content — a Diff When Overwriting

> Status: **APPROVED and IMPLEMENTED 2026-09-02. VERIFIED the same day**
> — both Open Decisions resolved (A: dependency-free line diff; B: omit
> oversized content with a note, never truncate), the backend content-
> computation and all three UI surfaces implemented, and live-verified
> against a real scratch target project including the load-bearing
> adversarial case: content mutated *after* preview but *before* approval
> never leaked into the actual write. See Verification Results below.

## Purpose

Every write-capable skill's approval preview today shows *that* a file
will be written and *where* — never *what*. That was a reasonable gap
while every write skill was one of a handful of fixed templates a human
could recite from memory (a `dockerize` Dockerfile is always one of four
known strings). It stops being reasonable the moment a component's
content becomes non-deterministic — the explicit premise of the proposed
`041`-`043` sequence (LLM-generated Documentation/DevOps/Security
content). Approving a preview that can't show what it's actually
approving is a rubber stamp, not a review. This checkpoint has to land
**before** any of those, since none of them can safely ship without it.

## Verified Current State

Read from the current code, 2026-09-01:

- **`ApprovalPreview`** (`packages/shared/approval.ts`) carries
  `actionId`, `kind`, `summary`, `target`, `toolName?`, `parameters?`,
  `executable?`, `argv?`, `cwd?`, `timeoutMs?`, `overwrite?: boolean`,
  `risks`. **There is no field for the content being written, for any
  `kind`.**
- **DevOps's four write-capable MCP tools are pure functions of their
  own parameters — no file reads, no randomness.** Confirmed by reading
  each one directly in `packages/mcp/index.ts`: `create_dockerfile`
  (line 257) selects one of four hardcoded templates by `app_type` and
  interpolates `port`/`app_name`; `create_github_action` (line 353),
  `create_dockercompose` (line 421), and `create_gitignore` (line 458)
  are the same shape — deterministic string assembly from their declared
  Zod parameters, then `writeFile()`. The exact content that *will* be
  written is fully computable from the same `parameters` object
  `packages/agents/devops/index.ts`'s `buildApprovalPreview()` (line
  181) already has in hand at preview time — **today it's simply
  discarded**, since the MCP tool alone ever calls the template
  functions, and only at actual-write time.
- **Documentation's `generate-readme` is the opposite shape: content
  depends on reading the real target project**, not just static
  parameters. `skillGenerateReadme()`
  (`packages/agents/documentation/index.ts`, line 101) reads
  `package.json` and a directory listing via `read_project_file`, then
  assembles the README — but this function is **only ever called from
  `resumeTask()`** (line 434), strictly after approval. The approval
  preview built beforehand (`buildApprovalPreview()`, line 355) never
  computes or sees the content.
- **`document-api`'s write path already has the right internal shape,
  just not wired to preview.** `skillDocumentApi(text, allowWrite,
  taskId)` (line 294) computes and returns `doc` regardless of
  `allowWrite`, only conditionally calling `write_project_file` at the
  end when it's `true`. The existing read-only call path
  (`allowWrite=false`) already produces exactly the content a preview
  would need — `processTask()`'s approval branch (line 380) simply never
  calls it before storing the pending action.
- **No approval-content size cap exists because there's no content
  field to cap.** The closest precedent is
  `packages/shared/audit.ts`'s existing `TASK_RESULT_MAX_BYTES = 64 *
  1024` and `AUDIT_SUMMARY_MAX_BYTES = 512`, both already established
  and tested.
- **Three independent rendering surfaces**, all added by prior
  checkpoints and structurally similar: `renderApprovalCard()` in
  `apps/orchestrator/index.ts` (`specs/033`, line ~1620) and in
  `packages/agents/devops/index.ts` (`specs/035`, ported verbatim); and
  `formatApprovalRows()` in `apps/tui/index.tsx` (`specs/037`, line 117,
  pure and independently unit-tested in
  `apps/tui/format-approval-rows.test.ts`). All three read the same
  `ApprovalPreview` shape and would need the same new field(s) rendered.
  None of the three currently has a diff-rendering capability of any
  kind.

## Proposed Behavior

1. **`ApprovalPreview` gains two optional fields**:
   - `content?: string` — the exact content that will be written if
     approved.
   - `previousContent?: string` — the file's current content, present
     only when `overwrite` is true and a previous version genuinely
     exists (so the UI can render a diff instead of two unrelated
     blocks).

   Both are omitted entirely for non-`file-write` kinds (`mcp-tool`
   calls without a content-producing tool, `command`) — this checkpoint
   does not attempt to preview command output or arbitrary tool-call
   results, only file content.

2. **Content is computed once, at preview time, and reused verbatim at
   write time — never recomputed.** This is the load-bearing correctness
   property, not a performance detail: what a human approved must be
   exactly what gets written, even if the underlying source (for
   Documentation) could theoretically change in the window between
   preview and approval. Concretely:
   - **DevOps**: the four write-capable MCP tools gain a `dry_run?:
     boolean` parameter (default `false`). When `true`, they compute and
     return the same content, skip `writeFile()` entirely, and skip
     creating the output directory. `buildApprovalPreview()`'s call site
     calls the relevant tool with `dry_run: true` once, storing the
     returned content on the `PendingAction`. The real write, after
     approval, is an unmodified call with `dry_run` absent/`false` —
     since these tools are pure functions of the same parameters,
     nothing here risks divergence, but the stored preview content is
     still what's *displayed*, not recomputed for display.
   - **Documentation (`generate-readme`)**: `skillGenerateReadme()` is
     split into a pure content-computation half and a thin write half.
     The content half runs once when the approval preview is built,
     its result stored on the `PendingAction` and shown in the preview;
     `resumeTask()` writes that **stored** content directly via
     `write_project_file`, rather than calling the content-computation
     half a second time. This is the one case where recomputing really
     could differ (a source file edited in the approval window) — reuse
     closes that gap entirely, not just reduces it.
   - **Documentation (`document-api` when writing)**: `processTask()`'s
     existing approval branch calls `skillDocumentApi(text, false,
     taskId)` (the already-existing read-only path) once to obtain
     `doc`, stores it on the `PendingAction`. `resumeTask()` writes the
     stored `doc` directly instead of calling `skillDocumentApi(text,
     true, ...)` again.
   - **`previousContent`**: whenever `overwrite` is (or resolves to)
     `true`, the existing file is read once via the same mechanism
     (`read_project_file` for Documentation; DevOps has no analogous
     read today and does not gain one — see Non-Goals) at the same
     preview-construction moment, stored alongside `content`.

3. **Rendering**: all three surfaces (`apps/orchestrator/index.ts`,
   `packages/agents/devops/index.ts`, `apps/tui/index.tsx`) gain a new
   block, placed after the existing `Target`/`Action`/`Parameters` rows
   and before `Risks`:
   - `previousContent` present → a **line-based diff** (added/removed/
     unchanged lines, git-diff-style prefixes) between `previousContent`
     and `content`.
   - `content` present, no `previousContent` → the content shown plainly
     (this is a create, not an overwrite — nothing to diff against).
   - Neither present → **exactly today's rendering**, unchanged. This is
     the byte-identical fallback for every `kind` this checkpoint
     doesn't touch (`mcp-tool` calls with no content, `command`).
   - The existing raw-JSON toggle (033/035) and raw-JSON key (037)
     continue to show the complete `ApprovalPreview` object exactly as
     received, `content`/`previousContent` included — no new toggle
     needed, this checkpoint only adds a rendered view on top.

4. **Size cap**: reusing the existing, already-tested
   `TASK_RESULT_MAX_BYTES` (64 KiB) precedent from
   `packages/shared/audit.ts`, checked against the combined
   `content`/`previousContent` pair before rendering. Exceeding it
   **omits the diff/content block from the card entirely** (Decision B)
   — the card falls back to exactly today's rendering
   (target/action/parameters/risks) plus one explicit note: content
   exists but is too large to render inline, with a pointer to the raw
   view. This never touches what actually gets written — the stored,
   full content on the `PendingAction` is untouched regardless, and
   `GET /tasks/:id` and the existing raw-JSON toggle/key always return
   the complete, uncapped object either way. The cap only ever governs
   whether the *formatted card* attempts to render a diff at all.

## Decision A — resolved: dependency-free line diff (2026-09-02)

A small (~40-60 line), self-contained line-based diff (classic LCS or
Myers-lite) added to `packages/shared/`, used by all three rendering
surfaces. Matches this repo's demonstrated preference (`specs/031`
explicitly resolved to "no new dependency" after evaluating the
alternative) and avoids adding a package to three different runtime
surfaces (Orchestrator, DevOps agent, and the compiled binary via the
TUI) for one narrow purpose. The considered alternative — a small,
well-established diff package (e.g. `diff`, MIT) — was not chosen: less
code to write here, but a real dependency-size/binary-size cost across
three surfaces for a narrow, self-contained algorithm this repo can own
directly, consistent with how every prior dependency decision here has
gone.

## Decision B — resolved: omit the diff for oversized content (2026-09-02)

When `content`/`previousContent` together exceed 64 KiB, the card omits
the diff/content block entirely and shows a one-line note instead (see
Proposed Behavior point 4) — never a truncated, partial-looking diff.
Settled once it was clear the full content is **already** one click away
either way, unaffected by this choice: the existing raw-JSON toggle
(033/035) and raw-JSON key (037), plus `GET /tasks/:id` directly, all
already return the complete, uncapped object regardless of what the
formatted card shows. Given that, a card that looks fully reviewable
while silently withholding the back half of a large file was judged
strictly worse than one that's honest about what it isn't showing —
truncation buys the illusion of completeness without buying real access
to anything the omit option doesn't already provide one click away.

## Scope

- `packages/shared/approval.ts` — the two new optional fields.
- `packages/mcp/index.ts` — `dry_run` parameter on the four write-capable
  tools (`create_dockerfile`, `create_github_action`,
  `create_dockercompose`, `create_gitignore`).
- `packages/agents/devops/index.ts` — `buildApprovalPreview()` calls the
  relevant tool with `dry_run: true`; stores `content` on
  `PendingAction`.
- `packages/agents/documentation/index.ts` — splits
  `skillGenerateReadme()` into content-computation and write; wires both
  `generate-readme` and the write path of `document-api` to compute once
  at preview time and reuse the stored result at approval.
- `packages/shared/` — new dependency-free diff module (Decision A) and
  the shared size-cap/omission helper (reusing `TASK_RESULT_MAX_BYTES`).
- `apps/orchestrator/index.ts`, `packages/agents/devops/index.ts` (its
  dashboard's client-side `renderApprovalCard()`), `apps/tui/index.tsx`
  (`formatApprovalRows()`) — the new rendering block, in all three.
- Tests: the shared diff module; DevOps and Documentation's preview-time
  content computation (dry-run correctness, stored-content reuse, no
  drift); `formatApprovalRows()`'s existing focused unit coverage
  extended for the new rows; a size-cap/omission test.
- `CLAUDE.md`, `README.md`, `context/worklog.md`.

## Safety Constraints

- **The approval gate itself is completely untouched** — same as every
  prior card checkpoint (033/035/037). No change to `actionId` binding,
  the approve/reject endpoints, or `validateActionId()`. This checkpoint
  changes what a human *sees*, never what constitutes authorization.
- **What's previewed is exactly what's written, by construction, not by
  convention.** Storing computed content once and reusing it at write
  time (rather than recomputing) is a correctness requirement, not an
  optimization — asserted directly in tests for both DevOps (dry-run
  content byte-equal to the real write) and Documentation (a source file
  changed between preview and approval must not change what gets
  written).
- **`dry_run: true` must never write, never create the output
  directory, and never appear in `packages/mcp`'s own audit trail as a
  real write** — asserted adversarially (call with `dry_run: true`,
  assert the target file does not exist).
- **The size cap applies to what's rendered inline, never to what's
  written or to what `GET /tasks/:id` returns server-side.** Truncation
  is display-only and always explicitly marked, never silent.
- **No new write-capable surface.** This checkpoint reads existing
  content computation earlier and displays it; it adds no new file
  access beyond what each skill's approval already implied it would
  eventually do.

## Out of Scope / Non-Goals

- Adding LLM capability to any agent — that's `041`-`043`, which this
  checkpoint exists to make safe for, not to implement.
- A diff/content preview for `command`-kind approvals (Testing's
  `run-tests`/`check-coverage`) — there's no "content" to preview for a
  process execution; out of scope by definition of what `content` means
  here.
- DevOps gaining a `previousContent` read capability — none of its four
  write tools currently read the target before writing (they always
  `overwrite: true` unconditionally per `buildApprovalPreview()`'s
  existing hardcoded value), and adding one is a separate, larger
  decision (a new read path into MCP) not needed for this checkpoint's
  core goal (showing new content is already a major improvement over
  today's nothing).
- Syntax highlighting, rich diff UI (side-by-side, collapsible hunks) —
  a plain line-prefixed diff is the whole ambition here, matching this
  repo's consistently plain-terminal/plain-HTML aesthetic elsewhere.
- Editing the previewed content before approving — approve/reject remain
  binary, unchanged.
- Any change to `Security`'s scans (still entirely read-only, no
  approval flow exists for it today, unaffected by this checkpoint).

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation. (Decisions A
      and B are already resolved above, as of 2026-09-02.)
- [x] `ApprovalPreview.content`/`previousContent` are optional and
      absent by default — every existing test and every `kind` this
      checkpoint doesn't touch renders byte-identically to today.
- [x] DevOps's four write tools accept `dry_run: true`, return the exact
      content a real write would produce, write nothing, and create no
      directory — asserted directly, including the adversarial
      target-file-does-not-exist check (`packages/mcp/index.test.ts`).
- [x] A DevOps approval preview shows real, tailored-by-parameters
      content (not a generic placeholder) for at least `dockerize` —
      **verified live** against a real scratch target project: the
      preview showed the exact interpolated `LABEL app="orch-verify-040"`
      Dockerfile before any write occurred, and the file written after
      approval was byte-identical to what was previewed.
- [x] `generate-readme`'s approval preview shows the real computed
      README content; approving writes byte-identically what was
      previewed, even when the underlying source changes in between —
      **verified live**, including the specific adversarial case: a
      preview was computed and shown (content mentioning "UPDATED
      description to trigger a real diff"), `package.json`'s description
      was then changed again to a *third* value ("MUTATED AFTER
      PREVIEW — should never appear in the write") **before** approving,
      and the file actually written after approval still contained the
      previewed second value, never the third — direct, live proof of
      the drift-prevention guarantee, not just unit-tested in isolation.
- [x] `document-api`'s write-path approval preview shows the real
      computed doc content; same byte-identity guarantee as above. Not
      independently live-tested to the same depth as `generate-readme` —
      `writeApiDoc()` reuses the identical stored-content-reuse shape
      (confirmed by code inspection: both `resumeTask()` branches call a
      `write*(target, action.content, id)` function using only the
      already-stored value, no recomputation in either path), so the
      live-proven guarantee above applies by construction, not by a
      second independent live pass.
- [x] An overwrite case renders a diff; a fresh-create case renders
      plain content; a `kind` with no content renders exactly as before
      this spec. The underlying **data** for all three was confirmed
      live (the readme create/overwrite calls above produced exactly
      `content`-only and `content`+`previousContent` shapes
      respectively); the **rendering** of that data was confirmed
      in-process (both dashboards' `/dashboard` HTML, fetched via
      `app.fetch()` with no port bind, contains the new
      `contentPreviewHtml()`/`computeLineDiff()` functions and CSS
      classes — matching `specs/035`'s own established technique for
      this exact kind of check) plus the TUI's own unit-tested
      `formatApprovalRows()`. A literal rendered-pixel/terminal
      confirmation was not performed — recorded honestly, not implied.
- [x] Oversized content is handled per Decision B (omit + note, never
      truncate) — unit-tested (`buildContentPreview`'s dedicated
      Decision-B test group, plus each rendering surface's own omission
      case), not additionally live-tested: this is pure, deterministic
      logic with no live-only-observable behavior, unlike the
      drift-prevention guarantee above which specifically depended on
      real async timing unit tests couldn't fully exercise.
- [x] The existing raw-JSON toggle/key still shows the complete object,
      new fields included — unchanged code path (`JSON.stringify` of the
      whole `approval` object), confirmed by inspection.
- [x] `bun test` (401 passed, 0 failed), `bun run typecheck` (0 errors),
      `bun run specs:check` all pass.
- [x] `CLAUDE.md`, `README.md`, `context/worklog.md` updated.

## Verification Plan

- **Automated:** the diff module's own unit tests (added/removed/
  unchanged lines, identical inputs, empty-to-content, content-to-empty);
  `dry_run` correctness and no-write assertions for all four DevOps
  tools; Documentation's stored-content-reuse tests including the
  changed-source-between-preview-and-approval adversarial case; the
  oversized-content omission path; `formatApprovalRows()`'s existing
  suite extended.
- **Live (Yusuf's machine or this session's sandboxed shell, whichever
  can reach it):** trigger a real `dockerize` against a target project,
  confirm the preview shows the actual Dockerfile content before
  approving; trigger `generate-readme` against a project with an
  existing `README.md`, confirm a real diff renders; approve one case
  and confirm the written file matches the preview exactly (byte
  comparison, not eyeballing).
- **Regression:** every existing approval-flow test across
  `specs/006`/`033`/`035`/`037` still passes unmodified.

## Verification Results (2026-09-02)

**Automated:** `packages/shared/line-diff.ts` (new) — 16 tests: the LCS
diff algorithm (identical/empty/single-change/append/prepend/fully-
different inputs) and `buildContentPreview()`'s all four outcomes,
including Decision B's combined-pair (not per-field) size check.
`packages/mcp/index.test.ts` — 6 new `dry_run` tests across all four
DevOps write tools: real content returned, nothing written, no directory
created, and dry-run content byte-identical to a real write's. One real
regression found and fixed along the way:
`packages/agents/skill-ownership-http.test.ts`'s dockerize approval-flow
test checked task status immediately after submission with no poll —
correct while `buildApprovalPreview()` was synchronous, broken once it
started making a real `dry_run` MCP call first. Fixed with a bounded poll
(mirroring `apps/orchestrator/supervisor-wiring.test.ts`'s own
`waitForTaskStatus()` pattern already in this repo), not a longer fixed
sleep. `apps/tui/format-approval-rows.test.ts` — 5 new tests (plain
rows, diff rows with correct prefixes/tones, byte-identical when neither
field is present, the oversized-omission case, row ordering).
`packages/agents/documentation/approval-content.test.ts` (new) — 2 tests
covering the fast, deterministic synchronous-failure paths only; this
module's `mcpClient` is a real, unmockable singleton with no live server
in the test environment (the same already-documented constraint
`document-api-fallback.test.ts` established for its own success path),
so real content-correctness needed a live pass instead — see below.
`bun test`: 401 passed, 0 failed (up from 356 at the start of this whole
session's work). `bun run typecheck`: 0 errors.

**Live, real machine, disposable scratch target project** (never this
repository), no LLM/provider key needed — DevOps and Documentation's
write skills are fully deterministic:

1. **DevOps `dockerize`, real tailored content, byte-identical write.**
   Submitted directly to a live `devops-agent` process against a scratch
   project with a real `package.json`. The approval preview's `content`
   field held the exact interpolated Dockerfile
   (`LABEL app="orch-verify-040"`, `EXPOSE 3000`) — confirmed the target
   file did not exist before approving. After approving, the written
   file was byte-identical to the previewed content.
2. **`generate-readme`, create case.** No `README.md` existed yet. The
   preview correctly showed `overwrite: false`, real assembled content
   (project name and description from `package.json`, a real directory
   listing, a real "Running with Docker" section since the just-created
   Dockerfile was detected), and no `previousContent`. Approved; the
   written file matched the preview exactly.
3. **`generate-readme`, overwrite case, a real diff.** Changed
   `package.json`'s description, resubmitted. The preview now correctly
   showed `overwrite: true` plus both `content` (new description) and
   `previousContent` (old description) — a genuinely diffable pair, not
   synthesized. Rejected deliberately (no need to write it) before the
   next step.
4. **The adversarial drift-prevention case — the load-bearing property
   this whole checkpoint exists for.** Submitted again; once the preview
   was computed and returned (content mentioning "UPDATED description to
   trigger a real diff"), `package.json`'s description was changed a
   *third* time, to "MUTATED AFTER PREVIEW — should never appear in the
   write" — deliberately, after the preview had already been shown, before
   approving. Approved that same pending action. **The file actually
   written still contained the second (previewed) description, never the
   third (post-preview-mutation) one.** Direct, live, unambiguous proof
   that content is reused verbatim from preview time, not recomputed at
   write time.
5. **Dashboard HTML, in-process.** `app.fetch()` against `/dashboard` for
   both the Orchestrator and DevOps agent (no port bind, matching
   `specs/035`'s own established technique) confirmed the generated page
   contains `contentPreviewHtml()`, `computeLineDiff()`, and all five new
   CSS classes (`.approval-content-box`, `.approval-diff-added`,
   `.approval-diff-removed`, `.approval-omitted`).

**Cleanup after every live pass:** `Get-CimInstance Win32_Process` for
`bun.exe` and `netstat` for the ports used confirmed zero orphaned
processes and no live listeners; the scratch directory and every
temporary request-body file were removed afterward.

**Not performed, recorded honestly:** a literal rendered-pixel (browser)
or rendered-terminal (TUI) visual confirmation of the diff — what was
verified is that the underlying data is correct (live, above) and that
the rendering functions producing markup/rows from that exact data shape
are unit-tested and confirmed present in the real generated output. This
is the same class of gap this project has flagged honestly elsewhere
(e.g. `specs/016`'s outcome-confirmed/mechanism-unconfirmed distinction)
rather than glossed over.

## Approval Requested

Approval authorizes: the two new `ApprovalPreview` fields; `dry_run` on
DevOps's four write-capable MCP tools; splitting Documentation's content
computation from its write step for both `generate-readme` and
`document-api`; the new dependency-free line-diff module and its
rendering block in all three UI surfaces; and the size-cap/omission
mechanism for oversized content — per Decisions A and B above.

It does **not** authorize adding LLM capability to any agent (`041`-
`043`, each separately proposed later), any change to the approval
gate's own authorization logic, or a `previousContent` read path for
DevOps.
