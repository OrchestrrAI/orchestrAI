---
id: 041-llm-harness-documentation
title: Opt-in LLM Harness for Documentation's Write Skills
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
---

# Spec: Opt-in LLM Harness for Documentation's Write Skills

> Status: **APPROVED and IMPLEMENTED 2026-09-02. VERIFIED the same day**
> — both entry points (`runReadmeHarness`/`runApiDocHarness`) built,
> tested, and live-verified against a real Gemini deployment, including
> the decisive existing-README test: a distinctive marker sentence
> planted in a scratch README survived byte-for-byte into the
> LLM-generated content alongside genuinely new, accurate documentation.
> Fail-closed behavior, the route-grounding check, and the flag-unset
> regression (against the real compiled binary) were all independently
> confirmed live. See Verification Results below.

## Purpose

The first of the proposed `041`-`043` sequence named in the per-agent LLM
roadmap discussion: give Documentation's write skills genuine LLM
reasoning on the lowest-stakes agent in that roadmap, proving the pattern
generalizes past Planning (`specs/026`) before extending it to
higher-stakes DevOps content (`042`) or Security's advisory analysis
(`043`). Documentation was chosen first for exactly the reason named in
that discussion: a mediocre doc rarely breaks anything — worst case it's
reviewed and rejected, same as today — while DevOps's generated files are
executed, and Security's findings carry real consequence if wrong.

**Scope, decided explicitly with Yusuf (2026-09-02):** both of
Documentation's write skills, `generate-readme` and `document-api`, not
just the former — a deliberate widening from this spec's own first draft,
which had scoped to `generate-readme` alone matching `specs/026`'s own
"prove it small first" discipline. Reconsidered because the efficiency
win (one review cycle, not two) was judged to outweigh that discipline
here, on the understanding that the two skills genuinely need different
harness designs internally (see Proposed Behavior) — this is not
"the same change twice," it is two related but distinct designs reviewed
together.

Grounded in the actual current implementation, not aspiration — reading
`packages/agents/documentation/index.ts` directly:

- `generate-readme` is entirely mechanical. `computeReadmeContent()`
  (added by `specs/040`) reads `package.json`'s `name`/`description`/
  `scripts` and one flat top-level directory listing, then assembles a
  fixed template. No `description` in `package.json` → the README says
  `_No description provided._`, literally. No understanding of what the
  project does, no real usage guidance beyond echoing script names.
- `document-api` is mechanical in a specifically different way:
  `scanApiRoutes()` finds real routes via a narrow, reliable regex
  (`app.(get|post|put|delete)\(...\)`) — genuine, grounded pattern
  matching against real code, not a guess. But each route's
  *description* comes from a single comment line immediately above the
  match, or literally `"No description provided."` when there isn't
  one. `buildApiDoc()` then renders one heading and one description line
  per route — no parameters, no request/response shape, no examples.

**This asymmetry directly shapes the two designs below**: `generate-readme`
has nothing reliable to ground on, so the model explores freely from the
project root. `document-api` already has something reliable — the
regex-discovered route list — so the model is *given* that list and asked
to write better documentation *for those specific routes*, not asked to
rediscover routes itself from scratch (which would risk inventing
endpoints that don't exist in the file — a materially worse failure mode
than a merely mediocre description).

## Verified Current State

Read from the current code, 2026-09-02:

- `packages/agents/documentation/index.ts`'s `computeReadmeContent(
  projectPath, taskId)` and `computeApiDoc(text, taskId)` (both added by
  `specs/040`, splitting pure content computation out from the write) are
  the exact two targets this checkpoint enhances — each already called
  once at approval-preview time, its result stored and reused verbatim at
  write time (`processTask()`/`resumeTask()`).
- **`specs/040`'s content-preview machinery already Just Works for
  whatever either function returns**, LLM-generated or not — the
  `ApprovalPreview.content`/`previousContent` fields, the diff rendering
  in all three UI surfaces, and the drift-prevention guarantee (content
  computed once, reused verbatim at write time) all already exist and
  need zero changes for this checkpoint. This is the concrete payoff of
  building `040` first, not an assumption.
- `scanApiRoutes(content)` (line 209) and `buildApiDoc(targetPath,
  endpoints)` (line 234) are the exact functions named above — confirmed
  by reading them directly, not from memory of what they probably do.
  `resolveDocumentApiTarget()` (`specs/036`, unaffected by this
  checkpoint) is what decides *which file* to document; this checkpoint
  only changes what happens once that target is already known.
- **The reference pattern already exists and is proven**:
  `packages/agents/planning/llm-harness.ts` (`specs/026`) is a LangGraph
  tool-calling loop — bind read-only tools, let the model decide/call/
  observe/decide again, validate the final output, retry-with-feedback
  (bounded) on invalid output, fail closed on exhausted retries or any
  other error. `READ_ONLY_TOOL_NAMES` is a structurally-enforced
  allow-list (`buildReadOnlyTools()` throws if ever bound to anything
  outside it) — asserted directly in `llm-harness.test.ts`, not just
  policy. This checkpoint reuses the identical shape for its shared graph
  mechanics, not a new design.
- **All required dependencies are already present, workspace-wide.** The
  root `package.json` already lists `@langchain/core`, `@langchain/
  langgraph`, and the three provider adapters (Planning's own
  dependencies from `specs/026`/`029`) — this is a Bun workspace with one
  shared dependency tree, not per-agent `package.json` files. Zero new
  dependency, zero binary-size measurement needed.
- **`specs/039`'s per-component provider resolution already supports
  adding a new component with no change to its own resolution logic** —
  `readLlmModelConfig(env, component)`'s `LlmComponent` type is the only
  thing that needs a new member (`"documentation"`, shared by both
  skills — this is one agent, one flag, not a flag per skill); the
  two-tier lookup, validation, and credential-safe reporting are all
  already generic.
- **Documentation's own MCP client already has the one tool both skills
  need**: `mcpClient` (`packages/agents/documentation/index.ts`) is
  constructed with `requiredTools: ["read_project_file",
  "write_project_file"]`. `read_project_file` already doubles as both a
  single-file read and a directory listing (passing `"."` as
  `relative_path`) — confirmed by `computeReadmeContent()`'s own existing
  use of exactly this. No new MCP tool is needed for either skill.
- **Neither skill's harness needs a capability snapshot.** Planning's
  output names other agents' skills (`N. [skill-id] Description`), so it
  depends on an invocation-scoped catalog of what skills exist. Both
  harnesses here produce prose/markdown for one already-known skill each
  — nothing for either to name, so `specs/030`'s capability-catalog
  machinery is simply not needed, a genuine simplification versus the
  reference pattern, not an oversight.
- **A real gap in this spec's own first draft, found by Yusuf directly**:
  `computeReadmeContent()` has zero awareness of an existing README when
  generating a new one — it always writes fresh from `package.json` plus
  a directory listing. The existing content is fetched only *afterward*,
  purely for the diff a human reviewer sees (`specs/040`'s
  `previousContent`, computed once in `processTask()`'s approval branch
  via `readProjectPath(target, "README.md", task.id)` when a prior file
  is detected). This checkpoint's original draft inherited the same
  blind spot for the LLM path — the model might *notice* `README.md` in
  a directory listing and choose to read it, but nothing guaranteed that
  or told it what to do with it. Fixed below by reusing that same
  already-fetched value directly as harness context, rather than hoping
  the model rediscovers it at the cost of an extra tool call.

## Proposed Behavior

1. **New env var, mirroring Planning's naming, one flag for the whole
   agent**: `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=1` (default unset/
   disabled) gates *both* skills together — not a separate flag per
   skill. A distinct flag from Planning's bare `ORCHESTRAI_LLM_HARNESS`,
   since components opt in independently, matching `specs/028`'s own
   precedent of a distinct flag per component. `ORCHESTRAI_LLM_API_KEY`/
   `_PROVIDER`/`_MODEL` (shared) or their `ORCHESTRAI_DOCUMENTATION_LLM_*`
   per-component overrides (`specs/039`) supply the provider/model/key.
2. **New module** `packages/agents/documentation/llm-harness.ts` with a
   **shared graph core and two distinct entry points**, structurally
   mirroring `packages/agents/planning/llm-harness.ts`:
   - **Exactly one read-only tool bound, for both**: `read_project_file`,
     wrapping `mcpClient.callTool()` exactly like Planning's
     `git_status`/`analyze_project` tools do.
     `READ_ONLY_TOOL_NAMES = ["read_project_file"] as const`, with the
     identical build-time allow-list-enforcement `buildReadOnlyTools()`
     already uses — copied, not reinvented. **No write-capable tool
     (`write_project_file`) is ever bound to the graph** — structural,
     asserted directly in a test, the same non-negotiable line
     `specs/026` already drew. One allow-list, tested once, applies to
     both entry points below — not two separately-maintained lists that
     could drift.
   - **`runReadmeHarness(options)`** — the model starts with the project
     root path and explores freely (package.json, source files, nested
     directories, as many or as few `read_project_file` calls as it
     needs) before producing final README markdown. **When an existing
     `README.md` is present, its content is passed directly as part of
     the harness's starting context — not left for the model to
     rediscover.** This is the exact same value `specs/040`'s
     `previousContent` already fetches in `processTask()`'s approval
     branch (`readProjectPath(target, "README.md", task.id)`, only when
     `overwrite` resolves to `true`) — reused, not fetched twice, so
     this costs no extra tool call. The system prompt instructs the
     model explicitly: preserve or build on sections that are still
     accurate (especially anything that reads as manually written, not
     auto-generated boilerplate), update what's stale, fill in what's
     missing — an incremental revision, not a blind wholesale rewrite
     each time it runs. Absent a prior README, this context is simply
     omitted and the model writes fresh, unchanged from the
     no-existing-file case. Output validation is deliberately
     light-touch: invalid means empty, whitespace-only, or below a small
     minimum length — bounded retry-with-feedback on invalid output;
     everything else accepted as-is. This checkpoint does not validate
     markdown structure or factual accuracy — the human approval step is
     the real quality gate.
   - **`runApiDocHarness(options)`** — the model is given the **already
     deterministically-discovered** route list (`scanApiRoutes()`'s own
     output — unchanged, still the sole source of *which routes exist*)
     as part of its starting context, plus the target file's path. It
     may call `read_project_file` to read that file (and any others it
     wants — imports, related modules) before writing fuller
     documentation for those specific routes. **Grounding check as
     part of validation**: the response must reference every
     method+path pair from the discovered list (a simple substring/
     presence check, not semantic understanding) — reprompted with
     feedback if a discovered route is missing, the same bounded-retry
     shape as the readme path. This is deliberately *not* a "does the
     model's route list match reality" check (the model isn't asked to
     produce a route list at all) — it only confirms the model actually
     wrote about what was actually found, not something else entirely.
   - Neither entry point takes a capability snapshot parameter (see
     Verified Current State).
3. **New module** `packages/agents/documentation/model-factory.ts`,
   mirroring Planning's own file exactly: owns
   `isHarnessFlagSet()`/`readLlmHarnessConfig()`/
   `readLlmHarnessStartupState()`, delegating to the shared
   `packages/shared/llm-model-factory.ts` with `component:
   "documentation"`. Shared by both skills — one config resolution, not
   two.
4. **Call-site behavior, mirroring specs/026/028's exact fail-closed
   precedent — not a graceful degrade to either deterministic path.**
   With the flag unset (default), both skills are **byte-identical to
   today** — `computeReadmeContent()`/`computeApiDoc()` run unchanged,
   nothing in this checkpoint is reachable. With the flag set, for
   either skill:
   - **A call-site reordering is required, not just an added branch.**
     `processTask()`'s `generate-readme` branch today computes `content`
     first and only fetches `previousContent` afterward (existing
     `index.ts`, confirmed by reading it directly). For the harness to
     receive the existing README as context (see `runReadmeHarness()`
     above), that order flips when the flag is set: fetch
     `previousContent` first (the same existing `pathExists`/
     `readProjectPath` check, unchanged), then pass it into the harness
     call. The deterministic (flag-unset) branch keeps its current order
     — this reordering is scoped to the LLM path only, not a behavior
     change to the existing default.
   - **No valid provider key configured** → the task fails closed with a
     named, actionable error, exactly `specs/026`/`028`'s existing
     precedent. **Never a silent fallback to the deterministic path** —
     an operator who opted in and misconfigured it must find out, not
     unknowingly keep receiving mechanical output while believing the
     LLM path is active. This mirrors the load-bearing safety principle
     this codebase has enforced at every prior LLM checkpoint,
     deliberately not relaxed here just because a "good" deterministic
     fallback happens to exist for both skills.
   - **A run failure** (API error, timeout, tool failure, exhausted
     retries on invalid or ungrounded output) → same fail-closed
     treatment, task failed with a named error. Still never a silent
     substitution.
   - **A successful run** → the LLM-produced content is returned in
     exactly the shape each existing `compute*()` function already
     returns (a `Promise<string>`), so the existing preview/write
     plumbing (`specs/040`) needs no changes at all to consume either.
5. **Startup reporting**, mirroring Planning's
   `readLlmHarnessStartupState()`: names the resolved provider/model/
   source-variable (never a credential) at Documentation's own process
   startup, distinguishable from Planning's own line if both happen to
   be active. One line for the agent, not one per skill.

## Scope

- `packages/agents/documentation/llm-harness.ts` (new) — shared graph
  core plus `runReadmeHarness()`/`runApiDocHarness()`.
- `packages/agents/documentation/model-factory.ts` (new).
- `packages/agents/documentation/index.ts` — both the `generate-readme`
  and `document-api` write branches of `processTask()` call the
  respective harness when the flag is set; `computeReadmeContent()`/
  `computeApiDoc()` unchanged and still called when it isn't; startup
  reporting.
- `packages/shared/llm-model-factory.ts` — `LlmComponent` gains
  `"documentation"`.
- Tests: the new harness module's own coverage for both entry points
  (mirroring `llm-harness.test.ts`'s structure — the shared read-only
  allow-list assertion, validation/retry logic for each entry point
  including the route-grounding check, fail-closed paths),
  `model-factory.test.ts` equivalent, and
  `packages/shared/llm-model-factory.test.ts` extended for the new
  component.
- `CLAUDE.md`, `README.md`, `context/worklog.md`.

## Safety and Compatibility Constraints

Identical in kind to `specs/026`'s, restated for this surface:

- **The approval gate is completely untouched.** `generate-readme`
  already requires approval unconditionally; `document-api`'s write path
  already requires approval whenever a save path is present (unchanged
  condition). This checkpoint only changes how the *content* shown in an
  already-existing approval is computed, never whether approval is
  required or how it's granted.
- **No write-capable tool reachable from either graph entry point —
  structural, not policy**, identical enforcement mechanism to
  `specs/026`'s `buildReadOnlyTools()`, one allow-list shared by both.
- **`document-api`'s route *discovery* stays fully deterministic.** The
  LLM is given `scanApiRoutes()`'s output, never asked to reproduce or
  re-derive it — the set of routes documented can never be something the
  model invented, only something the existing regex actually found in
  the real file.
- **Never a silent fallback once the flag is active** — see Proposed
  Behavior point 4. Both deterministic paths exist and are unchanged, but
  are only ever reached when the flag is unset, never as an
  error-recovery substitute for an active, misconfigured, or failed
  harness run.
- **With the flag unset (the default), byte-identical to before this
  spec, for both skills** — verified live via the compiled binary, not
  just `bun test`, matching every prior LLM-checkpoint's own verification
  bar.
- **No credential ever logged, in a startup summary or otherwise** —
  reuses `specs/039`'s existing `describeLlmModelConfig()` exactly.

## Out of Scope / Non-Goals

- Any change to DevOps, Testing, or Security — the proposed `042`/`043`,
  each needing its own approval.
- Any change to the approval gate, `ApprovalPreview`'s shape, or the
  diff-rendering machinery — `specs/040` already provides everything
  this checkpoint needs unmodified.
- Any change to `specs/038`'s still-pending Planning-retirement decision
  — unrelated component.
- Any change to `resolveDocumentApiTarget()`/`specs/036`'s existing
  target-file resolution — this checkpoint only changes what happens
  once a target file is already known.
- Any change to `scanApiRoutes()`'s own regex/detection logic — it
  remains the sole, unchanged source of *which routes exist*.
- Validating the LLM's output for factual accuracy, tone, or markdown
  correctness beyond "non-trivially empty" (readme) / "mentions every
  discovered route" (document-api) — the human approval step is the
  actual quality gate, not this checkpoint's validation logic.
- A capability-catalog dependency (`specs/030`) — not needed, see
  Verified Current State.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] With `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS` unset, both
      `generate-readme` and `document-api` are byte-identical to before
      this spec — **verified live against the real compiled binary**
      (`dist/bin/orchestrai.exe`, not just `bun run`/`bun test`): a
      `generate-readme` request produced the exact old mechanical
      template (`## Project Structure`, the "no scripts found in
      package.json" placeholder), startup logged
      `LLM harness: disabled (default)`.
- [x] `READ_ONLY_TOOL_NAMES` contains exactly `read_project_file`;
      binding any other tool throws at graph-build time — asserted
      directly (`llm-harness.test.ts`), shown to apply to both entry
      points, plus a direct test that `project_root` is fixed in closure
      regardless of what the model might try to pass.
- [x] With the flag set and a real provider key, `generate-readme`'s
      model genuinely calls `read_project_file` at least once before
      producing content — **verified live**: 5 real `read_project_file`
      calls against a real scratch project before the final content was
      produced (confirmed via the audit log, not assumed from the output
      alone).
- [x] With the flag set and a real provider key, `document-api`'s
      response references every route `scanApiRoutes()` actually found
      in a real target file — **verified live**: both `GET /health` and
      `POST /tasks` (the two real routes in a scratch Hono file) appeared
      in the generated doc, with genuinely richer content than the
      deterministic template (real status codes, content types, response
      bodies) — not just route names echoed back. The grounding-check
      retry itself is unit-tested directly (a response missing a
      discovered route triggers exactly one retry naming it).
- [x] With the flag set but no valid provider key, both skills fail
      closed with a named, actionable error — **verified live** for
      `generate-readme`: task status `"failed"`, error named the exact
      missing variable, and no file was written. Confirmed the
      deterministic path is never silently substituted (the failure
      happened before any content was ever produced).
- [x] A run failure (simulated or real) fails the task closed with a
      named error for both skills, never falling back to
      `computeReadmeContent()`/`computeApiDoc()` — unit-tested directly
      (tool-call throwing an error, exhausted retries on invalid/
      ungrounded output) for both entry points.
- [x] LLM-produced content from both skills flows through `specs/040`'s
      existing preview/diff/drift-prevention machinery with zero code
      changes there — **verified live**: both live-generated previews
      correctly carried `content` (and `previousContent` for the readme
      overwrite case) with no changes needed to `packages/shared/
      approval.ts` or any rendering surface.
- [x] When a real existing `README.md` is present, `runReadmeHarness()`
      receives its content as context (not rediscovered via an extra
      tool call — confirmed by call-count or trace, not assumed) and the
      real, live-generated output shows evidence of building on it. **The
      single strongest piece of live evidence in this whole checkpoint**:
      a scratch README contained a distinctive marker sentence
      (`MAGIC_MARKER_PRESERVE_ME: ...`); the live-generated preview
      contained that exact sentence, byte-for-byte, alongside genuinely
      new content (accurate API endpoint documentation from reading
      `index.ts`) — proof the harness both received the prior content and
      built on it rather than replacing it wholesale. With no existing
      README (a separate live case), behavior was plain generation with
      no `previousContent`, as designed.
- [x] Startup reporting names the resolved provider/model/source, one
      line for the agent, distinguishable from Planning's own line, never
      a credential — verified live (`LLM harness: enabled — provider
      gemini (ORCHESTRAI_LLM_PROVIDER), model gemini-3.5-flash-lite
      (ORCHESTRAI_LLM_MODEL), key from ORCHESTRAI_LLM_API_KEY`) and in
      the no-key case (`enabled but unconfigured`, with the warning line
      separately logged).
- [x] `bun test` (426 passed, 0 failed, up from 401), `bun run typecheck`
      (0 errors), `bun run specs:check` all pass.
- [x] `bun run build` binary size delta measured and recorded: **+28,160
      bytes (~27.5 KB)**, confirmed zero new dependency (the delta is
      purely new code — `llm-harness.ts`/`model-factory.ts` — reusing
      `@langchain/*`/`zod`, already bundled for Planning's own harness).
- [x] `CLAUDE.md`, `README.md`, `context/worklog.md` updated.

## Verification Plan

- **Automated:** the harness module's own unit tests mirroring
  `llm-harness.test.ts`'s structure for both entry points (shared
  allow-list enforcement, validation/retry for each, the route-grounding
  check specifically, fail-closed paths, no live credentials required —
  matching how `specs/026`'s own provider tests work against fake
  credentials); `model-factory.test.ts` equivalent; the shared factory's
  new `"documentation"` component case.
- **Live (real key, real target project):** confirm `generate-readme`'s
  model genuinely reads project files before responding (not a guessed/
  templated response); confirm `document-api`'s response covers every
  route a real target file's `scanApiRoutes()` actually finds; confirm a
  no-key run fails closed with the named error for at least one skill and
  Documentation's own `/healthz`/logs show no silent fallback occurred;
  confirm resulting content renders correctly through `specs/040`'s diff
  UI in at least one surface; approve one real case per skill and confirm
  the written file matches the preview exactly (byte comparison).
- **Regression:** flag-unset runs of both skills unchanged, confirmed
  against the compiled binary.

## Verification Results (2026-09-02)

**Automated:** `packages/agents/documentation/llm-harness.test.ts` (new,
17 tests) — `validateApiDocOutput`'s grounding check (accepts full
coverage, rejects and names a missing route, rejects too-short output,
accepts extra routes beyond the list since coverage-only is the deliberate
scope); the shared bound-tool-set tests (only `read_project_file`, never
`write_project_file`, `project_root` fixed in closure regardless of what
the model passes); `runReadmeHarness()`'s tool-call loop, existing-README
context (zero tool calls needed when the content is already supplied),
retry-with-feedback, exhausted-retries fail-closed, and tool-error-as-
observation-not-crash; `runApiDocHarness()`'s equivalent set plus the
route-set-comes-only-from-the-argument property made visible at the
full-harness level. `packages/agents/documentation/model-factory.test.ts`
(new, 7) mirroring Planning's own file exactly, including that Planning's
own flag does not cross-activate Documentation's. `bun test`: 426 passed,
0 failed (up from 401 before this checkpoint). `bun run typecheck`: 0
errors. Binary size: **+28,160 bytes**, zero new dependency confirmed.

**Live, real machine, real Gemini key, disposable scratch projects**
(never this repository):

1. **`generate-readme`, real content, real exploration.** Against a
   scratch project with a real `package.json` and a Hono `index.ts`, the
   model made 5 genuine `read_project_file` calls (confirmed via the
   audit log) before producing content correctly identifying the project
   as a Hono-based task API and documenting both real endpoints with
   accurate descriptions — materially better than the deterministic
   template's `_No description provided._`/echoed-script-names shape.
2. **The existing-README property — the decisive evidence for this whole
   checkpoint.** The scratch project's `README.md` contained a
   distinctive marker sentence
   (`MAGIC_MARKER_PRESERVE_ME: this exact sentence should survive...`).
   The live-generated preview contained that exact sentence, byte-for-
   byte, immediately followed by genuinely new, accurate content (a
   correct "Getting Started" section and both real API endpoints).
   Approved; the written file matched the preview exactly.
3. **`document-api`, grounded and genuinely richer.** Submitted against
   the same scratch file's two real routes (`GET /health`, `POST
   /tasks`). The generated doc covered both, with real HTTP status codes,
   content types, and response body shapes — far beyond the deterministic
   template's one-line-per-route shape. Approved; the written file
   matched the preview exactly. (A first attempt used a forward-slash
   save path that `extractSavePath()`'s regex doesn't match, correctly
   routing to the unaffected read-only path instead — confirms that
   regex's existing behavior, not a bug found.)
4. **Fail-closed, no silent fallback.** A separate scratch config with
   the flag set and no key produced the exact named startup warning
   (`enabled but unconfigured`) and, on a real task submission, an
   immediate `"failed"` status with the same named error — no file was
   ever written, confirming the deterministic template was never
   silently substituted.
5. **Flag-unset regression, against the real compiled binary**, not just
   `bun run`/`bun test`: `dist/bin/orchestrai.exe` (rebuilt for this
   checkpoint) logged `LLM harness: disabled (default)` at startup and
   produced the exact old mechanical template on a real request.

**Cleanup after every live pass:** `Get-CimInstance Win32_Process` for
`bun.exe`/`orchestrai.exe` and `netstat` for the ports used confirmed
zero orphaned processes and no live listeners each time; every scratch
directory and temp request-body file was removed afterward; every
startup log was grepped clean of the real key value before deletion.

## Approval Requested

Approval authorizes: a new opt-in LLM harness for Documentation, covering
both `generate-readme` and `document-api`'s write path, gated by one
shared flag (`ORCHESTRAI_DOCUMENTATION_LLM_HARNESS`), structurally
mirroring `specs/026`'s read-only tool-calling pattern with exactly one
tool (`read_project_file`) shared by both entry points, `document-api`'s
route set kept fully deterministic (the model only ever documents routes
already found by the unchanged `scanApiRoutes()`), fail-closed on any
misconfiguration or run failure for either skill (never a silent fallback
to either existing deterministic path), and the corresponding
`LlmComponent` addition in the shared provider factory.

It does **not** authorize any change to any other agent, the approval
gate, `specs/040`'s existing preview/diff machinery, `specs/036`'s target
resolution, or `scanApiRoutes()`'s own detection logic.
