# Verification: specs/103 — analyze-project Gains Real, Grounded Codebase Analysis

## What changed

**`packages/agents/devops/llm-harness.ts`** — a new
`runProjectAnalysisHarness()`, reusing the existing
`buildHarnessGraph()`/`runHarness()` core unchanged. The shared
`validate` field type was widened to allow an async function (path
grounding needs a real MCP call per candidate path); every pre-existing
synchronous validator satisfies the widened type without any change.

Grounding (`groundObservations()`) re-verifies each cited path by
actually calling `read_project_file` against it — never trusting the
model's own claim, never regex-scraping prose. Salvage-on-exhaustion is
implemented as closure state (`bestGrounded`) updated on every attempt,
mirroring `specs/100`'s own pattern.

**`packages/agents/devops/index.ts`** — `skillAnalyzeProject()` gains
one additive step: `computeCodebaseAnalysisSection()`, fail-open,
appending an explicit `"Codebase analysis unavailable: <reason>"` note
on any harness failure rather than failing the task.
`renderCodebaseAnalysis()` deterministically renders the validated,
grounded structure — the model never writes final report text directly.

**`apps/orchestrator/index.ts`** — `fetchProjectInspection()`'s cache key
changed from `"analyze-project"` (shared with a real dispatched skill
result) to a distinct `ORCHESTRATOR_INSPECTION_CACHE_SKILL`, amending
`specs/102`'s own original decision now that the skill's output is
genuinely richer than the tool-only inspection.

**`apps/orchestrator/supervisor-graph.ts`** — `buildSystemPrompt()` gains
one additive line (only when `projectContext` is present) telling the
supervisor not to redundantly dispatch `analyze-project` purely to
re-orient itself — a prompt nudge, not a structural guarantee.

## Test results

- `bun test` (full suite): **1223 pass, 0 fail, 2 skip** (pre-existing,
  unrelated) — net **+15** over the pre-103 baseline of 1208.
- `bun run typecheck`: 0 errors.
- `bun run specs:catalog` / `bun run specs:check`: pass, 103 specs.
- New coverage: `packages/agents/devops/llm-harness.test.ts` (+8 tests —
  fully-grounded first attempt, zero-observation validity, ungrounded
  retry-then-success, exhausted-retries salvage, exhausted-retries
  zero-grounded-to-null, malformed-JSON retry, path-dedup-to-one-check,
  optional tool use, and the prompt-embedding proof); a new
  `describe` block in `packages/agents/devops/index.test.ts` for
  `renderCodebaseAnalysis()`'s pure rendering (+3 tests) and a
  no-live-server graceful-termination check (+1); two
  `apps/orchestrator/orchestrator-inspection.test.ts` tests rewritten to
  assert the corrected cache-key separation, plus one new test
  confirming the inspection's own cache still works correctly in
  isolation; two new `buildSystemPrompt` tests for the nudge line's
  presence/absence.

## Live verification

A real Gemini deployment (`.orchestrai/config.env`'s real key, this
session's standing authorization), a real scratch project
(`package.json` declaring `hono`, `src/index.ts` with two real Hono
routes, `src/db.ts`, a real git init/commit).

**Harness off — byte-identical regression.** The real completed result
against the scratch project was exactly the pre-103 deterministic report
— no `Codebase Analysis` section, confirmed by direct comparison against
the harness-on run below.

**Harness on — a real, grounded analysis.** The real completed result:

```
=== Codebase Analysis ===
Stack: Node.js (JavaScript)
Structure: The project is a minimal Node.js application containing a
single 'src/' directory for source code and a 'package.json' file at
the root.
Observations:
• The project lacks a dependency lockfile, which poses a risk for
  reproducible builds across different environments. (package.json)
• The project is currently missing standard version control ignore
  patterns... (.git/)
• The source code is confined to the 'src/' directory... (src/)
Based on 3 real, verified path reference(s) within this project.
```

**An honest, disclosed finding, not glossed over**: the audit log
confirms the model called `read_project_file` exactly three times —
`package.json`, `.git/`, and `src/` (the directory listing only). It
never opened `src/index.ts`, so it never discovered the real Hono
routes or that the source is genuinely TypeScript, reporting the
shallower "Node.js (JavaScript)" instead. Grounding worked exactly as
designed — every citation is a real path, nothing fabricated — but the
depth of exploration in this one real run was shallower than the
scratch project actually warranted. This is a property of the model's
own judgment about what's worth reading, the same class of finding
`specs/101`'s own verification record already disclosed for its new
tools (reachable and correctly bound, but not always chosen).

**Closed the same day — prompt strengthened, re-verified live.**
`buildProjectAnalysisSystemPrompt()` was originally purely permissive
("call read_project_file as many or as few times as you need"), which
is what let the model stop at directory listings above. Strengthened,
prompt-wording-only, no change to the grounding mechanism or output
shape: the prompt now states explicitly that a directory listing or a
manifest dependency is a hint, not confirmation, and that the model
must actually open and read real source file content before naming the
stack. Re-run against a freshly recreated, identically-shaped scratch
project (same `package.json`/`src/index.ts`/`src/db.ts`), same real
Gemini deployment. The real result this time:

```
Stack: Hono (Node.js/Bun)
...
• The project uses the Hono web framework, as evidenced by the import
  statement and app instantiation in the source code. (src/index.ts, package.json)
• Application entry point and core routing are located in src/index.ts,
  which exposes a basic Hono app object. (src/index.ts)
• The project lacks a dependency lockfile despite having explicit Hono
  dependencies... (package.json)
• There is a 'db.ts' file in the source directory suggesting integration
  with a database layer, though it remains unverified in scope. (src/db.ts)
```

The audit log confirms `read_project_file` was called on `src/index.ts`
(twice) and `src/db.ts` this time, not just directory listings — the
model correctly identified the real Hono framework, grounded explicitly
in "the import statement and app instantiation in the source code."
This is now the current, verified behavior — the shallow-exploration
finding above is left in place as the honest record of what motivated
the fix, not retroactively erased.

**Fail-open — confirmed live, not just by unit test.** Restarted with a
deliberately invalid `ORCHESTRAI_DEVOPS_LLM_MODEL`. The real completed
result:

```
=== Codebase Analysis ===
Codebase analysis unavailable: models/this-model-does-not-exist is not
found for API version v1beta, or is not supported for generateContent.
```

Task status was **`completed`**, not `failed` — the full deterministic
report (all six presence checks, the suggestions) was fully intact
above the unavailable note, with the real provider error message
surfaced verbatim rather than a generic string.

All three scratch processes (`mcp:http`, `devops-agent`) and the scratch
project were cleaned up after the pass; one stray process from an
earlier live-verification pass in this same session (`mcp:http` on
port 3006, left running from the specs/100 pass) was found and killed
before this pass began, confirmed via `netstat`.

## Known limitations

- The model's real exploration depth in the first live run was shallower
  than ideal — closed the same day via a prompt strengthening, re-verified
  live against a freshly recreated project with the identical shape (see
  above). One data point of the fix working is not a guarantee of
  consistent depth on every future run; model behavior can still vary,
  the same non-determinism this codebase's own routing has already
  documented elsewhere.
- Decision 4 (a deep-analysis capability reachable from agents other
  than DevOps) is explicitly out of this spec's scope — tracked as
  `specs/104`'s own A11.
- The supervisor's redundant-dispatch nudge (Decision 3) was verified
  only as a byte-present/byte-absent prompt property, not against a real
  adaptive-supervisor run choosing not to dispatch `analyze-project`
  redundantly — that would require a real multi-step plan-task session,
  which this pass did not include. The underlying mechanism it nudges
  around (no envelope-field guarantee) is unchanged and was already
  correctly understood as a soft signal, not a hard one.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/103-deep-project-analysis/spec.md` (implemented, **partial**
verification) gives `analyze-project` its first real code reading.
Before this spec, `analyze_project`'s entire output — six presence
booleans, a flat one-level directory listing, a fixed 1-to-1 suggestion
mapping — was derived from file **existence** alone, never file
**content**, despite being the only skill in this system whose name
promises analysis. It was also the only DevOps skill that never reached
DevOps's own default-on harness (`specs/042`).

Directly re-raised by Yusuf, 2026-09-20, after 101/102 shipped without
addressing it: *"the defention of the analization doesn't means to get
the git and the list of files, it should be more and more deep into the
code base like code desigen battern language many other."* Live-caught
the same day, a real dispatched `analyze-project` request against a
real repo completed correctly and returned only the presence checklist
— confirmed, not assumed, that `specs/101`/`102` (tool access and
Orchestrator reach) had never touched what this skill actually computes.

**Two constraints found while grounding the spec, both load-bearing.**
(1) `specs/102`'s Orchestrator inspection calls `analyze_project` on
every `plan-task` run specifically because it is *"fast, local, no LLM
involved"* — so the depth added here lives entirely in DevOps's own
**skill** (`skillAnalyzeProject()`), never in the MCP tool itself, which
stays byte-identical. This also means no new MCP tool was needed:
`specs/101` already bound DevOps's harness to exactly the right
read-only set (`analyze_project`/`git_status`/`git_diff`/
`read_project_file`) — the first genuine consumer of that widening,
which `specs/101`'s own verification record had honestly noted no real
model had yet chosen to use. (2) `specs/102`'s own deliberate
cache-sharing between its inspection and a real dispatched
`analyze-project` result — *"whichever happens first in a conversation
grounds the other for free"* — was correct only while both produced
identical shallow output. This spec **amends that decision**: the
Orchestrator's inspection now writes to a distinct
`ORCHESTRATOR_INSPECTION_CACHE_SKILL` cache key, so it can never
silently pre-populate the shared slot with a shallow result and starve
a later real request of the deep one.

**Four design decisions, settled through direct back-and-forth before
writing code, not assumed:**

1. **The harness prompt is pre-fed the real, already-computed flat
   directory listing and manifest content** (the exact text
   `analyze_project` already produced, handed over verbatim) — confirmed
   directly that `analyze_project`'s own `readdir()` call is
   single-level and non-recursive, so this is genuinely small (one
   screen of names), never a codebase dump. Real source file content is
   only ever read on-demand, one file at a time, via the same bound
   `read_project_file` tool every harness in this codebase already uses
   — pre-feeding removes only the redundant first few tool rounds a
   cold start would spend re-deriving known facts, it changes nothing
   about what the model is allowed to read.
2. **Structured, validated output, not free-form prose** — the harness
   returns `{ stack, structure, observations: [{ text, paths }] }`,
   validated against a Zod schema exactly like DevOps's four write
   skills already do. Each observation's cited paths are a real
   structured field, so grounding is a genuine field check, not a
   regex-scrape of rendered text. `renderCodebaseAnalysis()` — a pure,
   exported function — is the only place that shapes the final report
   text; the model never writes it directly.
3. **Always deep when the harness is on, no shallow-dispatch mechanism.**
   Checked directly: the adaptive supervisor's own plan-step dispatch
   (`dispatchPlanStep()`) never consults `specs/057`'s cache at all —
   that integration was explicitly deferred and remains deferred — so
   every plan containing an `analyze-project` step pays this harness's
   real cost freshly, every time. A hard guarantee (an `analysisDepth`
   field on the shared task envelope, forcing plan-step dispatches
   shallow) was considered and deliberately not adopted without live
   evidence the cost actually bites; instead, `buildSystemPrompt()`
   gained one added line — only when `projectContext` is present —
   telling the supervisor it is already grounded and should not
   dispatch `analyze-project` again purely to re-orient. Stated plainly:
   this is a prompt nudge, not a structural guarantee.
4. **DevOps-only, deliberately, and named as a real remaining gap.**
   `specs/101`'s single-skill-owner rule means this exact skill cannot
   be duplicated onto Code Review, Coder, or the Orchestrator. What
   already exists is narrower: those agents' own harnesses can already
   *reach for* project context while doing their own job (`specs/101`),
   and the Orchestrator's own inspection deliberately stays shallow
   (constraint 1 above). A genuinely shared, multi-agent-reachable deep
   analysis capability is real, additional scope this spec does not
   attempt — recorded as `specs/104`'s own item A11 rather than folded
   in silently, the same mistake this session had just caught itself
   making once already.

**Grounding — the real safety mechanism, the same structural-enforcement
style every prior harness in this codebase uses**: every cited path is
re-verified by an actual `read_project_file` call against it inside the
validator (`groundObservations()`) — never trusted from the model's own
claim, never inferred from a transcript of earlier reads. An ungrounded
citation triggers the same bounded retry-with-feedback every harness
here already uses, naming the specific bad path; on exhausted retries,
the largest fully-grounded subset seen across any attempt is salvaged
(`specs/082`'s own "don't discard a real finding to punish one
hallucinated one" precedent, implemented as closure state updated on
every attempt before a rejection is returned); zero grounded
observations ever produced omits the section entirely with an explicit
note. This does not make an observation *correct* — a real path can
still be cited alongside a wrong claim about it — it makes an
observation *checkable*, and the spec states that limit explicitly
rather than overclaiming.

**Fail-open, not fail-closed** — deliberately the opposite of
`specs/082`/`specs/100`'s shape, and for the reason those lack: there
*is* a complete, correct, useful deterministic report here worth
preserving. A harness failure of any kind (missing key, provider error,
exhausted retries, recursion limit) appends an explicit
`"Codebase analysis unavailable: <reason>"` note and the task still
**completes**, matching `specs/043`'s own precedent for Security's
commentary layer.

**Live-verified against a real Gemini deployment**: a real scratch
project (a genuine `package.json` declaring `hono`, `src/index.ts` with
two real Hono routes, `src/db.ts`). Harness off reproduced the exact
pre-103 checklist-only output. Harness on produced a real
`Codebase Analysis` section with three grounded observations, each
citing a real, verified path. **An honest, disclosed finding, not
smoothed over**: the audit log showed the real model called
`read_project_file` on `package.json`, `.git/`, and `src/` (the
directory listing only) — it never opened `src/index.ts`, so it reported
the shallower "Node.js (JavaScript)" rather than identifying the real
TypeScript/Hono stack. Grounding held perfectly (nothing fabricated);
the depth of exploration in this one real run was simply shallower than
the project warranted — a property of the model's own judgment, the
same class of honest negative finding `specs/101`'s own verification
record already disclosed for its new tools. The fail-open path was also
confirmed live with a genuinely broken model config: the task
**completed**, not failed, with the full deterministic report intact
above a specific, real provider error message, never a generic string.

1223 tests pass (net +15 over `specs/102`'s own 1208 baseline),
typecheck clean, `specs:check` passed for 103 specs. See `specs/103`'s
own `verification.md` for the complete transcript, including the two
`specs/102`-era cache-sharing tests deliberately rewritten (not silently
deleted) to assert the corrected, intentional reversal.

**Closed the same day, 2026-09-21 — the shallow-exploration finding
fixed and re-verified live.** `buildProjectAnalysisSystemPrompt()` was
originally purely permissive about tool use, which is what let the model
stop at a directory listing above. Strengthened, wording-only — no
change to the grounding mechanism, no new tool, no change to the
validated output shape: the prompt now states plainly that a directory
listing or a manifest dependency is a hint, not confirmation, and
requires actually reading real source content before naming the stack.
Re-verified live against a freshly recreated, identically-shaped scratch
project, same real Gemini deployment: the model correctly reported
`"Hono (Node.js/Bun)"`, explicitly grounded in *"the import statement and
app instantiation in the source code"* — the audit log confirmed
`read_project_file` was actually called on `src/index.ts` and `src/db.ts`
this time, not just directory listings. The original shallow-run finding
is left in the record above as the honest account of what motivated the
fix, not retroactively erased.

**Correction, 2026-09-20 — no longer a shared cache entry.**
`specs/103-deep-project-analysis/spec.md` amends the design described in
this paragraph as originally shipped: this inspection and a real
dispatched `analyze-project` skill result used to deliberately share one
cache key (*"whichever happens first in a conversation grounds the
other for free"*). That was correct only while both produced identical
shallow tool output. Once DevOps's own `analyze-project` skill gained
real, model-authored depth (`specs/103`), sharing a key would have let
this inspection's own shallow, no-LLM call silently pre-populate the
cache with the shallow result and starve a later real `analyze-project`
request of the deep one. Fixed with a distinct cache key
(`ORCHESTRATOR_INSPECTION_CACHE_SKILL`) — the two no longer collide. See
`specs/103`'s own section below for the full record.

See specs/105-orchestrator-fallback-deep-analysis/verification.md for the relocated narrative covering this checkpoint.

See specs/106-persistence-store-and-result-cache/verification.md for the relocated narrative covering this checkpoint.

See specs/110-approval-state-survives-a-restart/verification.md for the relocated narrative covering this checkpoint.
