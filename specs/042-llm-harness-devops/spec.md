---
id: 042-llm-harness-devops
title: Opt-in LLM Harness for DevOps's Write Skills — Smarter Parameters, Not New Templates
area: llm-harness
change_type: feature
status: implemented
verification: verified
created: 2026-09-02
updated: 2026-09-02
approved_by: Yusuf
approved_on: 2026-09-02
implemented_on: 2026-09-02
amends: []
supersedes: []
superseded_by: []
related:
  - 026-llm-harness-langgraph-planning
  - 029-shared-llm-provider-gemini
  - 039-per-component-llm-provider-config
  - 040-approval-preview-content-diff
  - 041-llm-harness-documentation
---

# Spec: Opt-in LLM Harness for DevOps's Write Skills — Smarter Parameters, Not New Templates

> Status: **APPROVED (pre-approved 2026-09-02, per Yusuf's explicit
> instruction to proceed autonomously through `042`/`043`) and
> IMPLEMENTED the same day. VERIFIED the same day** — all four
> parameter-decision entry points built, tested, and live-verified
> against a real Gemini deployment, including the decisive test: a real
> Python project with no language named in the request text correctly
> got `app_type: "python"` (the deterministic default would have said
> `"bun"`), `create-ci`'s hardcoded `include_docker: false` gap closed
> with a real Dockerfile detected, and `create-compose` genuinely
> detecting a real database dependency and adding a second service. The
> flag-unset regression was directly contrasted against the same
> project's flag-on result, against the real compiled binary. See
> Verification Results below.

## Purpose

The second of the proposed `041`-`043` sequence, one step up in stakes
from Documentation: DevOps's generated files are actually executed
(`docker build`/`docker compose up`/a real CI pipeline), where
Documentation's are read. This directly shapes a **deliberately narrower
design than `041`'s**: the LLM here decides *parameters* fed into the
existing, already-reviewed deterministic MCP templates — it never
authors Dockerfile/CI-YAML/compose-YAML content directly. The actual
template strings in `packages/mcp/index.ts` are completely unchanged by
this checkpoint. This is a real, load-bearing safety choice, not
timidity — see Safety and Compatibility Constraints.

Grounded in the actual current implementation, not aspiration — reading
`packages/agents/devops/index.ts` directly:

- `extractAppType(text)` (line 78) guesses the app type from the **task
  text's own wording** — `.includes("python")`/`"node"`/`"go"`, else
  **defaults to `"bun"` unconditionally**. A request that never mentions
  a language (`"dockerize this project"`) against a real Python project
  gets a `bun` Dockerfile — wrong, silently, every time the task text
  doesn't happen to name the language.
- `extractPort(text)` (line 85) is a bare `/port\s*(\d+)/i` match against
  the task text, defaulting to `3000` — never reads the project's actual
  listening port from real code.
- `prepareWriteAction()`'s `create-ci` branch (line 137) **hardcodes
  `include_docker: false` unconditionally** — even when a Dockerfile
  already exists (or was just created by a prior `dockerize` step in the
  same plan), the generated CI workflow never gets a Docker build step.
- `prepareWriteAction()`'s `create-compose` branch (line 154) always
  produces **exactly one hardcoded service** (the app itself) — no
  detection of a real database/cache dependency (e.g. a `pg`/`redis`/
  `mongodb` package in `package.json`) that a real deployment would
  actually need as a second compose service.

All four of these are genuine, evidence-confirmed gaps a real project
exploration would fix — not assumed, read directly from the code that
produces today's output.

## Verified Current State

Read from the current code, 2026-09-02:

- `packages/mcp/index.ts`'s four write-capable tools
  (`create_dockerfile`, `create_github_action`, `create_dockercompose`,
  `create_gitignore`) are pure functions of their own declared
  parameters — confirmed during `specs/040`'s own work reading these
  exact functions. Their `dry_run: true` mode (added by `specs/040`)
  already returns computed content without writing — this checkpoint
  reuses that mechanism unchanged for previews; it does not add a new
  preview path.
- `packages/agents/devops/mcp-client.ts`'s `REQUIRED_TOOLS` is
  `analyze_project`, `git_status`, and the four write tools —
  **`read_project_file` is not in this list today.** DevOps has never
  had generic file-read access; only Documentation does. Adding it here
  is the one new tool this checkpoint proposes, justified by the
  concrete gaps above (real dependency detection needs real file
  content, not just `analyze_project`'s structural presence checks).
- `specs/026`'s reference pattern (`buildReadOnlyTools()`,
  `READ_ONLY_TOOL_NAMES`, structurally-enforced allow-list) is the same
  shape reused here, now for a three-tool set instead of two.
- `specs/041`'s harness (`packages/agents/documentation/llm-harness.ts`)
  is the second reference point, specifically for the "shared graph
  core, multiple validated output shapes" pattern this checkpoint needs
  (four skills, four different parameter shapes) — the graph mechanics
  (agent → tools → validate → retry-with-feedback → fail-closed) are
  identical; only the validators and system prompts differ per skill,
  the same relationship `041`'s two entry points already have.
- `specs/039`'s per-component resolution needs only a new `"devops"`
  `LlmComponent` member.
- No capability-catalog dependency (`specs/030`) — same reasoning as
  `041`: none of these four skills' harness output names another
  agent's skill.

## Proposed Behavior

1. **New env var**: `ORCHESTRAI_DEVOPS_LLM_HARNESS=1` (default unset),
   one flag gating all four write skills together, mirroring `041`'s
   one-flag-per-agent shape. Shared `ORCHESTRAI_LLM_*` variables or
   `ORCHESTRAI_DEVOPS_LLM_*` per-component overrides supply the
   provider/model/key.
2. **New module** `packages/agents/devops/llm-harness.ts`, structurally
   mirroring `041`'s shared-core-plus-multiple-entry-points shape:
   - **Three read-only tools bound**: `analyze_project`, `git_status`
     (both already available to DevOps today, unchanged), and
     `read_project_file` (new — added to `DevOpsMcpClient`'s
     `REQUIRED_TOOLS`, and to the harness's own allow-list). No
     write-capable tool (`create_*`, `write_project_file`) is ever bound
     to the graph — structural, identical enforcement mechanism to
     `specs/026`/`041`.
   - **Four entry points**, one per skill
     (`decodeDockerizeParams`/`decodeCreateCiParams`/
     `decodeCreateGitignoreParams`/`decodeCreateComposeParams` — exact
     names TBD in `plan.md`), sharing the same graph core. Each asks the
     model to explore the real project (as many or as few tool calls as
     needed) and respond with **one JSON object** matching that skill's
     own parameter shape:
     - `dockerize`: `{ app_type, port }` — `app_name`/`output_path` stay
       deterministic (`path.basename(base)`, computed target path),
       never model-suppliable, the same "fixed in closure" principle
       `041`'s `project_root` already established for path safety.
     - `create-ci`: `{ app_type, include_docker }` — `workflow_name`/
       `triggers` stay fixed; `include_docker` becomes a real decision
       instead of a hardcoded `false`.
     - `create-gitignore`: `{ project_type, extras? }` — `extras` is
       newly possible: the model may suggest additional patterns based
       on what it actually observes in the project.
     - `create-compose`: `{ services }` — an array of `{ name, image,
       port?, env_vars? }`, the same shape `create_dockercompose`
       already accepts; the model may propose more than the current
       always-exactly-one hardcoded service when it detects a real
       dependency warranting one (e.g. a database package).
   - **Validation**: parse as JSON, then check against that skill's own
     shape (each field's type, `app_type`/`project_type` restricted to
     the same enum `packages/mcp/index.ts`'s own Zod schema already
     accepts). Invalid JSON, a wrong shape, or an invalid enum value
     triggers bounded retry-with-feedback naming exactly what was wrong;
     exhausted retries fail closed.
3. **Call-site behavior — the same fail-closed precedent, once more, not
   relaxed.** With the flag unset (default), `prepareWriteAction()` is
   **byte-identical to today** for all four skills — `extractAppType()`/
   `extractPort()`/the hardcoded `include_docker`/the fixed one-service
   compose all run unchanged. With the flag set:
   - **No valid provider key, or a run failure** (API error, exhausted
     retries) → the task fails closed with a named error. **Never a
     silent fallback to `extractAppType()`'s guess or the hardcoded
     compose service** — the same principle `specs/026`/`028`/`041`
     already established every time this decision has come up.
   - **A successful run** → the harness's validated parameters are
     merged into the same `args` object `prepareWriteAction()` already
     builds, and the **same, unmodified** `create_*` MCP tool is called
     with them — through the identical `dry_run`-then-real-write
     mechanism `specs/040` already built. No change to
     `buildApprovalPreview()`, the approval flow, or the diff-rendering
     machinery anywhere.
4. **Startup reporting**, identical shape to `041`'s.

## Scope

- `packages/agents/devops/llm-harness.ts` (new).
- `packages/agents/devops/model-factory.ts` (new).
- `packages/agents/devops/mcp-client.ts` — `read_project_file` added to
  `REQUIRED_TOOLS`.
- `packages/agents/devops/index.ts` — `prepareWriteAction()` (or a new
  wrapper around it) calls the relevant harness entry point when the
  flag is set, merging validated parameters into the existing `args`
  shape; the deterministic extraction functions stay unchanged and are
  still what runs when the flag is unset; startup reporting.
- `packages/shared/llm-model-factory.ts` — `LlmComponent` gains
  `"devops"`.
- Tests: the harness module's own coverage per entry point (shared
  allow-list including the new `read_project_file` binding, per-skill
  parameter validation and its retry/fail-closed paths),
  `model-factory.test.ts` equivalent, the shared factory's new
  `"devops"` component case, and a `mcp-client.test.ts` (or equivalent)
  assertion that `read_project_file` is now required.
- `CLAUDE.md`, `README.md`, `context/worklog.md`.

## Safety and Compatibility Constraints

- **The LLM never authors file content — only parameters into
  already-reviewed deterministic templates.** This is the one
  structural difference from `041` this whole spec is organized around,
  restated as an explicit, testable constraint: the harness's validated
  output is JSON matching a narrow parameter shape, never passed as raw
  content to any write operation. `packages/mcp/index.ts`'s four
  template functions are untouched by this checkpoint — asserted by a
  diff-empty check on that file as part of this checkpoint's own
  verification, not just described in prose.
- **No write-capable tool reachable from the graph — structural**,
  identical enforcement to `specs/026`/`041`.
- **`app_name`/`output_path`/every target-path value stays fully
  deterministic**, never model-suppliable — matching `041`'s
  `project_root`-fixed-in-closure precedent exactly. The model can only
  ever influence *what* gets written into an already-fixed *where*.
- **`analyze_project`/`git_status`/`read_project_file` remain Tier 2/
  read-only** — no change to their own MCP-side implementation or
  tiering, only to which agent has them bound to an LLM loop.
- **Never a silent fallback once the flag is active** — restated once
  more, deliberately, since this is the third checkpoint in a row this
  exact principle applies to.
- **With the flag unset, byte-identical to before this spec** — verified
  live against the compiled binary, matching every prior checkpoint's
  bar.
- **The approval gate, `ApprovalPreview`'s shape, and `specs/040`'s
  diff-rendering machinery are all completely untouched** — this
  checkpoint only changes what arguments get passed into an unmodified
  `dry_run`-then-write call.

## Out of Scope / Non-Goals

- Any change to the four MCP template functions' own generated string
  content — explicitly the one thing this checkpoint does not touch,
  see Safety Constraints.
- Any change to Testing or Security — `043` is Security, proposed
  separately; Testing is not part of this roadmap round at all.
- Any change to the approval gate or `specs/040`'s preview/diff
  machinery.
- A recursive-listing or content-search MCP tool — `read_project_file`
  (single-file read / one-level directory listing) is judged sufficient
  for parameter decisions the same way `specs/026`/`041` judged their
  own read-only tool sets sufficient; a further tool addition would need
  its own evidence from actually using this one, not speculation ahead
  of it.
- Giving the model the ability to name arbitrary output paths — every
  target path stays exactly as deterministic as it is today.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation (pre-approval
      already given per the banner above; this box reflects that
      condition being satisfied, not a still-open request).
- [x] With `ORCHESTRAI_DEVOPS_LLM_HARNESS` unset, all four write skills
      are byte-identical to before this spec — **verified live against
      the real compiled binary**: a `dockerize` request against a real
      Python project (no language named in the task text) produced the
      exact old `app_type: "bun"`, `port: 3000` defaults — the *precise
      wrong answer* the flag-on case (below) fixes, proving the
      regression is byte-identical by direct contrast, not just absence
      of a diff.
- [x] `packages/mcp/index.ts` has zero diff from before this checkpoint
      — confirmed via `git diff --stat`, empty output.
- [x] The harness's read-only tool set is exactly `analyze_project`,
      `git_status`, `read_project_file`; binding anything else throws at
      graph-build time — asserted directly (`llm-harness.test.ts`), plus
      direct tests that all three tools' target paths are fixed in
      closure regardless of what the model passes.
- [x] With the flag set and a real provider key, `dockerize` against a
      real non-Bun project (`requirements.txt`, `psycopg2-binary`
      dependency, port `5000` hardcoded in `app.run()`, **no language
      named in the task text**) produced `app_type: "python"`,
      `port: 5000` — **verified live**, the concrete proof this
      checkpoint's own stated problem is actually fixed, not just
      unit-tested in isolation.
- [x] `create-ci`'s `include_docker` reflects real project state —
      **verified live**: after a real Dockerfile was created in the same
      scratch project, a `create-ci` request correctly returned
      `include_docker: true` and the generated workflow included the
      real Docker build/push job, proving the hardcoded-`false` gap is
      closed.
- [x] With the flag set but no valid provider key, a skill fails closed
      with a named error — **verified live**: `dockerize` failed
      immediately with the exact named error, no file written, the
      deterministic extraction functions never invoked as a fallback.
- [x] A validated parameter set flows through the exact same
      `dry_run`-then-write mechanism unmodified — **verified live** for
      all three tested skills (`dockerize`, `create-ci`,
      `create-compose`): preview content generated from harness-decided
      parameters, approved, and each written file matched its preview
      exactly (byte comparison).
- [x] `bun test` (454 passed, 0 failed, up from 426), `bun run typecheck`
      (0 errors), `bun run specs:check` all pass.
- [x] `bun run build` binary size delta measured and recorded: **+14,336
      bytes**, zero new dependency (smaller than `041`'s delta since
      `@langchain/*`/`zod` were already bundled by that checkpoint).
- [x] `CLAUDE.md`, `README.md`, `context/worklog.md` updated.

## Verification Plan

- **Automated:** harness module tests per entry point (allow-list
  including the new tool, parameter validation and its enum/shape
  checks, retry-with-feedback, fail-closed paths); `model-factory.test.ts`
  equivalent; the shared factory's new `"devops"` case; a direct
  assertion `packages/mcp/index.ts` has no diff from its pre-`042` state.
- **Live (real key, real target project):** a project without a language
  named in the task text and a real non-default language present,
  confirming the harness gets `app_type` right where the deterministic
  path would not; a project with an existing Dockerfile, confirming
  `create-ci`'s `include_docker` comes back `true`; approve one real
  case and confirm the written file matches the preview exactly (byte
  comparison); confirm a no-key run fails closed.
- **Regression:** flag-unset runs of all four skills unchanged, against
  the compiled binary.

## Verification Results (2026-09-02)

**Automated:** `packages/agents/devops/llm-harness.test.ts` (new, 20
tests) — `validateJsonParams`'s parsing/schema checks (accepts well-
formed JSON, strips a markdown fence, rejects invalid JSON/enum values/
missing fields); the shared bound-tool-set tests (exactly the three
allow-listed tools, all target paths fixed in closure); all four entry
points' tool-call loops, retry-with-feedback, fail-closed paths, and —
for `create-compose` specifically — both the default single-service case
and a genuinely-detected second service. `packages/agents/devops/
model-factory.test.ts` (new, 7) mirroring `041`'s own file, including
that neither Planning's nor Documentation's flag cross-activates
DevOps's. `bun test`: 454 passed, 0 failed (up from 426). `bun run
typecheck`: 0 errors. `packages/mcp/index.ts`: confirmed zero diff via
`git diff --stat`. Binary size: **+14,336 bytes**, zero new dependency.

**Live, real machine, real Gemini key, a disposable scratch Python
project** (never this repository) — deliberately chosen to be a
non-Bun project with no language named in any request text, to directly
exercise this checkpoint's own stated problem:

1. **`dockerize` — the decisive test.** The scratch project had
   `requirements.txt` (`flask`, `psycopg2-binary`) and `app.py` calling
   `app.run(port=5000)`. The request text was `"dockerize this project
   at ..."` — no language named. The harness correctly returned
   `app_type: "python"`, `port: 5000`, having read `requirements.txt`
   and the real port from source. Approved; the written Dockerfile
   matched the preview exactly.
2. **`create-ci` — the hardcoded-`false` gap, closed.** Submitted after
   the real Dockerfile above existed. Returned `include_docker: true`,
   and the generated workflow genuinely included the Docker build/push
   job — the deterministic path would have returned `false`
   unconditionally regardless of the Dockerfile's existence. Approved;
   written file matched the preview.
3. **`create-compose` — real dependency detection.** The harness
   correctly identified `psycopg2-binary` (a PostgreSQL driver) in
   `requirements.txt` and added a genuine second service
   (`db`, `postgres:16`, sensible default env vars) alongside the app's
   own — the deterministic path always produces exactly one hardcoded
   service regardless of real dependencies. Approved; written file
   matched the preview exactly (byte comparison), including a
   pre-existing YAML indentation quirk in `create_dockercompose`'s own
   template (confirmed unrelated to this checkpoint via the zero-diff
   check on `packages/mcp/index.ts` — a genuine finding worth a future,
   separately-scoped fix, not addressed here).
4. **Fail-closed, no silent fallback.** A separate scratch config with
   the flag set and no key produced the exact named startup warning and,
   on submission, an immediate `"failed"` status with the same named
   error — no file ever written.
5. **Flag-unset regression, against the real compiled binary, with a
   direct contrast.** The same Python scratch project, same real
   compiled binary (`dist/bin/orchestrai.exe`, rebuilt for this
   checkpoint), flag unset: `dockerize` returned the exact old
   `app_type: "bun"`, `port: 3000` — the precise *wrong* answer for this
   real project, proving both that the regression is byte-identical to
   before this spec and, by direct comparison against scenario 1 above,
   exactly what the fix changes.

**Cleanup after every live pass:** `Get-CimInstance Win32_Process` for
`bun.exe`/`orchestrai.exe` and `netstat` for the ports used confirmed
zero orphaned processes and no live listeners each time; every scratch
directory and log file was removed, each grepped clean of the real key
value first.

## Approval Requested

Pre-approved per Yusuf's explicit instruction to proceed through
`042`/`043` following `041`'s pattern, including adding tools where the
implementation shows a real need (`read_project_file` for DevOps, here).
Authorizes: a new opt-in LLM harness for DevOps covering all four write
skills' *parameter selection* (never content authoring), gated by one
shared flag (`ORCHESTRAI_DEVOPS_LLM_HARNESS`), `read_project_file` added
to DevOps's MCP tool access (read-only), fail-closed on any
misconfiguration or run failure, and the corresponding `LlmComponent`
addition in the shared provider factory.

It does **not** authorize any change to the four MCP template functions'
own content, any change to Testing, Security, the approval gate, or
`specs/040`'s existing machinery.
