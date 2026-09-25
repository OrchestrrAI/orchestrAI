# Verification: specs/114 — Coder Agent v2: Multi-File Edits and New-File Creation

Status at time of writing: `status: implemented`, `verification: partial`.

## Unit tests

`packages/agents/coder/llm-harness.ts` gained `runEditFilesHarness()`,
`MultiFileProposalSchema`, `MAX_FILES_PER_EDIT`, `GroundedFileChange`,
and `MultiFileHarnessResult`, with 12 new tests in
`llm-harness.test.ts`'s new `describe("runEditFilesHarness", ...)`
block, all against the same `ScriptedChatModel`/`PathAwareMcpToolCaller`
test-double pattern the pre-existing `edit-file` tests already use — no
network call, no live credential:

- A fully-grounded multi-file proposal (one edit, one create) is
  returned as-is.
- Each file is grounded independently — one ambiguous file triggers
  retry-with-feedback naming it specifically, the other file's
  already-correct entry is unaffected.
- A proposal naming more than `MAX_FILES_PER_EDIT` files is rejected
  with feedback naming the real count and the bound, not silently
  truncated.
- On final retry exhaustion with a mixed grounded/ungrounded result,
  the largest grounded subset seen across any attempt is salvaged —
  never fewer than the best attempt achieved.
- Zero grounded files across every attempt fails closed with `null`.
- A path escaping the project root fails the harness immediately — no
  retry.
- A refusal response ends the run immediately with the model's own
  real reason — zero grounding calls.
- Proposing `create` for a path that already exists is ungrounded
  (`edit` should have been used instead), and the inverse (`edit` for
  a path that doesn't exist).

`packages/agents/coder/index.test.ts` gained a `describe("specs/114 —
detectSkill routes edit-files", ...)` block and a `describe("specs/114
— edit-files fail-closed preconditions", ...)` block, mirroring the
file's own existing `edit-file` precondition coverage exactly (no
description → named error; no resolvable project root → distinct named
error; harness flag off → named error mentioning
`ORCHESTRAI_CODER_LLM_HARNESS`) — the file's own harness-off convention
means these exercise real HTTP requests against the real, unmodified
app with zero live MCP server needed, matching the file's own stated
design.

`packages/agents/coder/index.test.ts`'s pre-existing Agent Card test was
updated (a legitimate behavior change, not a test-only patch) to assert
both `edit-file` and `edit-files` are advertised, in order.

Full suite: `bun test` → **1357 pass, 2 skip, 1 fail** (3212
expectations, 84 files). The one failure is the same pre-existing,
environment-caused `analyze-project` test tied to a real `bun.exe` on
port 3006 from the user's own active stack, unrelated to this spec.
`bun run typecheck` — 0 errors. `bun run specs:catalog` then `bun run
specs:check` — both pass, 114 specs cataloged.

## Registration mechanics

Mirroring `specs/082`/`specs/083`'s own precedent of a small,
mechanical checklist per new skill:

- `apps/supervisor/agent-catalog.ts`'s `AGENT_CATALOG` — `coder-agent`
  entry updated to `["edit-file", "edit-files"]`.
- `apps/orchestrator/supervisor-graph.ts`'s `SKILL_TIER_REGISTRY` —
  `edit-files: "write-capable"` added.
- `apps/orchestrator/supervisor-graph.ts`'s `SUPERVISOR_ALLOWED_SKILLS`
  — `"edit-files"` added, keeping the two structures independently
  listed (not derived from each other) per the file's own stated
  drift-detection design; `supervisor-graph.test.ts`'s existing
  registry-drift tests pass unmodified, confirming the two tables still
  agree.
- `packages/shared/agent-card-skill-collision.test.ts` — confirms
  `edit-files` collides with no other agent's own skill id (4/4 pass).
- Confirmed NOT needed, by direct check (unlike `specs/082`'s own
  missed `PORT_ROW_LABELS` touchpoint): no per-agent
  `Record<AgentName, ...>` exhaustiveness type exists that a new
  *skill* (as opposed to a new *agent*) would trip — `bun run
  typecheck` passed clean on the first attempt after the four edits
  above, with no further gap surfacing.

A real bug from this same category was caught and fixed during this
verification pass, not anticipated in the original plan: the
`AGENT_CATALOG` update itself had been drafted in an earlier part of
this session but never actually applied before a context interruption,
which the full test suite caught immediately as the `AGENT_CATALOG
matches each agent's own real agentCard.skills > coder-agent` failure
— fixed before this spec was called done, not left for a later pass.

## Live verification

A genuinely isolated two-process scratch stack (mcp:http on port
19706, coder-agent on port 19708, `ORCHESTRAI_MCP_URL` pointed
explicitly at the scratch MCP server) was started with real Gemini
credentials (`gemini-3.1-flash-lite`), confirmed connected via
`/healthz` (`mcp.state: "connected"`, all 17 real MCP tools
discovered).

**Scenario 1 — genuine multi-file discovery and write, no file named in
the request.** A real scratch project (`src/logger.ts` with a `Logger`
class, `src/app.ts` importing and using it) received:

> "edit-files at \<path\>: rename the Logger class to AppLogger
> everywhere it's used, and create a new file src/constants.ts
> exporting a LOG_PREFIX constant that Logger uses instead of the
> hardcoded '[LOG]' string"

The real model discovered and proposed exactly 3 files with no file
path given in the request text: `src/logger.ts` (edit — renamed the
class and used the new import), `src/app.ts` (edit — updated the
import and instantiation), `src/constants.ts` (create — a new file with
the real `LOG_PREFIX` export). All three were correctly grounded
(`old_text` matched real content for the edits; the create path was
confirmed absent). Approved: all three files landed on disk
byte-identical to the preview — confirmed by reading the real files
after the write, not just trusting the task's own result text.

**Scenario 2 — the all-or-nothing drift refusal.** A second real
2-file proposal (`src/handler.ts`, `src/util.ts`, both simple numeric
edits) reached `input-required`. `src/util.ts` was manually mutated on
disk before approving (simulating a human editing the file during the
approval window). Approving the stale preview was refused with:

> "Target \"src\\util.ts\" changed after approval but before this
> write — refusing to write any file in this batch."

Confirmed decisively via the real files on disk afterward:
`src/handler.ts` — the file that had **not** itself drifted — was still
completely unwritten (its original, pre-approval content), proving the
refusal genuinely covers the whole batch, not just the drifted file.
`src/util.ts` still held the manual mutation, confirmed not further
corrupted.

Both scratch processes and the scratch directory were cleaned up
afterward (`taskkill /F` by discovered PID, `rm -rf` on the scratch
project directory).

## What remains unverified (why `verification: partial`, not `verified`)

- **The TUI's Detail overlay's own bounded-summary rendering was never
  exercised in a real terminal.** `formatApprovalRows()`'s new
  `approval.files` branch (`apps/tui/index.tsx`) is covered by 4 new
  focused unit tests in `format-approval-rows.test.ts` (one row per
  file with real +/- counts, the trailing dashboard-pointer note, no
  full diff lines leaking in, the empty-array fallback to the
  single-file path) and passes `bun run typecheck`, but no real 80×24
  PTY capture was performed — the same standing gap every TUI
  checkpoint in this codebase carries, and this implementing
  environment has no raw-mode stdin to drive one.
- **The dashboard's multi-file diff card rendering was not opened in a
  real browser.** `renderApprovalCard()`'s new `multiFileContentHtml()`
  branch (ported to both the Orchestrator's and DevOps's own dashboard,
  matching `specs/035`'s precedent) is implemented and reuses the
  exact, already-proven `computeLineDiff()` algorithm per file, but
  no screenshot or live browser interaction confirmed the rendered
  markup — matching this codebase's own established gap for prior
  dashboard-facing specs at this stage.
- **The not-found/ambiguous grounding retry was not forced live.** The
  real model in both live scenarios grounded every file correctly on
  the first attempt — `specs/083`'s own verification record already
  documented the identical difficulty forcing this organically against
  a real model (three deliberate attempts, still no live ambiguous
  retry), so this is covered by the hermetic unit test instead, per
  that spec's own accepted precedent.
- **The salvage-on-exhaustion path (a genuine mixed grounded/ungrounded
  final attempt) was not forced live** — covered by the dedicated unit
  test instead, the same standard `specs/082`'s own salvage-on-
  exhaustion coverage already established for `review-diff`.

## Non-goals confirmed untouched

- `edit-file`'s own existing single-file behavior: all of its
  pre-existing `llm-harness.test.ts`/`index.test.ts` tests pass
  unmodified.
- Coder self-verification (`specs/104` item A5) and Code Review's own
  deep-analysis access (`specs/104` item A11's remainder): neither
  touched.
- File deletion and cross-file atomic write transactions: neither
  implemented, both named as explicit, disclosed limitations in the
  spec's own "The write path" section.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/114-coder-multi-file-edit-and-create/spec.md` (implemented,
**partial** verification, 2026-09-23; amends `083`/`098`/`101`/`110`)
lifts two of `specs/083`'s own three named v1 limitations — single-file
only, no new-file creation — in one checkpoint, per Yusuf's own direct
request ("the coder and reviewer agent is need more and more care and
upgrade so i can tell it something like what i tell you and it can do
it"). Given a staged roadmap (self-verification via `run_command`/
`run_tests` first, then multi-file, then new-file creation, then Code
Review's own deep-analysis access), Yusuf's explicit choice was
multi-file edits — and, mid-session, to fold new-file creation into
this same spec rather than leave it separate. Self-verification
(`specs/104` item A5) and Code Review's own deep-analysis access
(`specs/104` item A11's remainder) remain explicitly deferred to their
own future specs, each its own risk class per `specs/078`'s ordering
rule.

**A new skill, `edit-files`, alongside the untouched `edit-file`** —
the existing single-file path stays byte-identical, zero regression
risk (`edit-file`'s own full pre-existing test suite passes unmodified).
**Deliberately no explicit file-list parsing**: the task text is a
free-form instruction with no required file names — the model decides
which files need touching itself, using the same bound read-only tools
`edit-file` already has (`specs/101`: `read_project_file`,
`analyze_project`, `git_status`, `git_diff`).

`packages/agents/coder/llm-harness.ts` gained a second entry point,
`runEditFilesHarness()`, sharing the exact same read-only tool set,
recursion limit, and retry-with-feedback core `runEditFileHarness()`
already uses — no widening of `READ_ONLY_TOOL_NAMES`, no write-capable
tool ever bound to the harness. Each proposed file is one of two
discriminated-union shapes — `{path, action: "edit", old_text,
new_text}` or `{path, action: "create", content}` — bounded to
`MAX_FILES_PER_EDIT = 6` by the Zod schema itself, not a soft
guideline. **Grounding is per-file, independently**: an `edit` needs
its `old_text` to occur exactly once in that specific file's own real
content (a real `read_project_file` call per named path, not just the
single file `edit-file` reads today); a `create` needs the path to
**not** already exist — the exact inverse of `edit-file`'s own "must
already exist" check. **Salvage-on-exhaustion, borrowed from
`specs/082`'s own precedent, applied here for the first time in
Coder**: on final retry exhaustion, the largest fully-grounded subset
seen across any attempt is salvaged and presented for approval —
covering fewer files than proposed, never more — with the dropped
files and their reasons surfaced explicitly; the task fails closed only
when zero files ground.

`packages/shared/approval.ts`'s `ApprovalPreview` gains one new
optional `files?: {target, action, content?, previousContent?,
fingerprint}[]` field, used only by `edit-files` — every existing
write-capable skill leaves it `undefined`, completely unaffected, the
same additive-divergence pattern `commit-changes` (`specs/079`) already
established for "a diff of several things, not one file."

**The write path is all-or-nothing preflight, best-effort execution** —
`resumeEditFilesAction()` re-verifies every file's fingerprint before
writing **any** file (refusing the entire batch on a single file's
drift, extending `edit-file`'s own "no partial write on drift"
precedent to the whole batch); a genuine mid-batch filesystem failure
(as opposed to drift, always caught first) is reported per-file,
honestly, rather than claiming a false all-or-nothing guarantee for
that specific failure mode — no cross-file atomic transaction exists at
the `write_project_file` MCP-tool level, a real, disclosed limitation
this spec does not solve.

**Dashboard**: `renderApprovalCard()` (both the Orchestrator's and
DevOps's own dashboard, matching `specs/035`'s porting precedent)
branches on `approval.files` being present, looping over the files and
rendering one labeled diff block per file (EDIT/NEW badge) via the
exact same `computeLineDiff()` algorithm, never a new diff mechanism.

**TUI — deliberately a compact summary, never N inline diffs.** Given
`apps/tui/index.tsx`'s own 16+-round terminal-overflow-bug history
(`specs/012`/`047`/`069`), the Detail overlay's `formatApprovalRows()`
renders one short line per file (`EDIT src/a.ts (+3/-1)` / `NEW
src/validation.ts (+42 lines)`, using `computeLineDiff()`'s own line
counts, never the full diff text) plus a trailing note pointing at the
dashboard for full diffs — bounded by construction (capped at
`MAX_FILES_PER_EDIT` = 6 lines maximum).

**A real registration bug found and fixed during this spec's own
verification, not anticipated in the plan**: an earlier part of the
same session had already drafted the `AGENT_CATALOG` update (adding
`edit-files` to Coder's display-only skill list) but a context
interruption meant it was never actually applied before this spec was
otherwise finished — caught immediately by the full test suite
(`AGENT_CATALOG matches each agent's own real agentCard.skills >
coder-agent`), fixed before the spec was called done. Full registration
mechanics for the new skill: `apps/supervisor/agent-catalog.ts`'s
`AGENT_CATALOG`, `apps/orchestrator/supervisor-graph.ts`'s
`SKILL_TIER_REGISTRY` (`edit-files: "write-capable"`) and
`SUPERVISOR_ALLOWED_SKILLS` — confirmed via `packages/shared/
agent-card-skill-collision.test.ts` that `edit-files` collides with no
other agent's own skill id, and via `bun run typecheck` that no further
`Record<AgentName, ...>`-style exhaustiveness gap exists for a new
*skill* (as opposed to a new *agent*, `specs/082`'s own missed
`PORT_ROW_LABELS` touchpoint) — clean on the first attempt.

**Live-verified against a real Gemini deployment**, a genuinely
isolated two-process scratch stack (mcp:http + coder-agent, real
credentials, `mcp.state: "connected"` confirmed via `/healthz`):

- **Genuine multi-file discovery with no file named in the request.**
  "edit-files at \<path\>: rename the Logger class to AppLogger
  everywhere it's used, and create a new file src/constants.ts
  exporting a LOG_PREFIX constant..." correctly produced a real 3-file
  proposal (2 edits, 1 create) the model discovered entirely on its
  own; approved, all three files landed on disk byte-identical to the
  preview, confirmed by reading the real files afterward.
- **The all-or-nothing drift refusal.** A second real 2-file proposal,
  with one of the two files (`util.ts`) manually mutated before
  approving, was refused entirely with the exact designed error — and
  decisively, the *other*, never-mutated file (`handler.ts`) was
  confirmed still completely unwritten, proving the refusal covers the
  whole batch, not just the drifted file.

**What stays unverified, honestly, not glossed over**: the TUI's own
bounded-summary rendering and the dashboard's own multi-file diff card
were both implemented and unit-tested but never exercised in a real
terminal or browser — the same standing gap every TUI/dashboard
checkpoint in this codebase carries at this stage. The not-found/
ambiguous-grounding retry and the salvage-on-exhaustion path were not
forced live (the real model grounded every file correctly on the first
attempt in both live scenarios) — covered by dedicated unit tests
instead, the same precedent `specs/082`/`specs/083` already established
for this exact class of hard-to-force-live scenario. 1357 tests pass
(net +17 over the pre-114 baseline — 12 new `llm-harness.test.ts`
tests, 4 new `format-approval-rows.test.ts` tests, 1 updated Agent Card
assertion), typecheck clean, `specs:check` passed for 114 specs. See
`specs/114`'s own `verification.md` for the complete transcript.
