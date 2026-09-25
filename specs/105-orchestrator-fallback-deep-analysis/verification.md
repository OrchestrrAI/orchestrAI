# Verification: specs/105 — Shared Project Analysis, Reachable With DevOps Off

## What changed

**`packages/shared/project-analysis.ts`** (new) — the entire `specs/103`
deep-analysis implementation, moved verbatim: schema, grounding
(`groundObservations()`/`verifyPathExists()`), the strengthened system
prompt, `runProjectAnalysisHarness()`, `renderCodebaseAnalysis()`. Carries
its own self-contained copy of the generic LangGraph tool-calling core
(`HarnessState`/`buildReadOnlyTools()`/`buildHarnessGraph()`/
`runHarness()`/`validateJsonParams()`), matching every other agent's own
independent-copy convention. Also exports `getCachedProjectAnalysis()`,
a stub returning `null` until `specs/106` wires it to the real store.

**`packages/agents/devops/index.ts`/`llm-harness.ts`** — import the moved
functions from shared instead of defining them locally. Zero behavior
change.

**`apps/orchestrator/index.ts`** — two new call sites:

- `computeDeepProjectAnalysis()` — the shared building block both new
  call sites use. Key-gated (no resolvable `"orchestrator"` LLM config →
  `null`), fail-open throughout.
- `resolveSupervisorFinalContext()` — extracted out of
  `runOrchestratorSupervisor()` so the zero-dispatch → deep-analysis
  upgrade is directly testable with a given `dispatchCount`, without
  needing to drive the full LangGraph supervisor decision loop (which
  has no test-model seam of its own — a pre-existing gap, not introduced
  here). Wired into the real call site unchanged.
- `inspectTargetProjectAsTaskResult()`'s `analyze-project` branch now
  appends the deep analysis after the shallow text via the same
  `computeDeepProjectAnalysis()`.
- A new test-only seam, `__setTestProjectAnalysisModel()`, mirrors
  `__setTestRouterModel()`'s established shape.

## A design correction found and fixed before implementation, not after

The original 2026-09-21 draft of this spec targeted
`inspectTargetProjectAsTaskResult()` as the fix for "analyze the project
in chat, with DevOps off." Tracing the real code before writing anything
showed this was wrong: with DevOps offline, the LLM router cannot name
`analyze-project` at all (it only proposes skills in the live capability
snapshot), so a chat request always falls to `plan-task` and — per
`specs/103`'s own supervisor nudge — typically reaches
`composeSupervisorResult()`'s **zero-dispatch** branch instead. The spec
was rewritten to target that branch before any code was written. See the
spec's own status banner for the full record.

## Test results

- `bun test` (full suite): **1240 pass, 0 fail, 2 skip** (pre-existing,
  unrelated) — net **+16** over the pre-105 baseline of 1224.
- `bun run typecheck`: 0 errors.
- `bun run specs:catalog`/`specs:check`: pass, 107 specs.
- `packages/shared/project-analysis.test.ts` (new, 13 tests): every
  `specs/103` grounding/salvage/fail-open test, moved verbatim, passing
  unmodified against the new location; plus the `getCachedProjectAnalysis()`
  stub test.
- `packages/agents/devops/llm-harness.test.ts`: the moved tests removed
  (now living in `project-analysis.test.ts`), the remaining 23 DevOps
  write-skill-harness tests pass unmodified — confirming zero behavior
  change for DevOps.
- `apps/orchestrator/orchestrator-inspection.test.ts`: 15 new tests —
  `computeDeepProjectAnalysis()`'s five fail-open/success paths;
  `resolveSupervisorFinalContext()`'s four dispatch-count/fallback
  cases; three new `inspectTargetProjectAsTaskResult()` cases (deep
  analysis appended, degrades to shallow-only with no key, `git-status`
  never attempts the deep path at all).
- Confirmed via `git diff`: `fetchProjectInspection()` and
  `dispatchRootTask()`'s own agent-routing logic (`findAgentForSkill()`)
  both have **zero** edits — the two properties this spec's own safety
  constraints require to stay untouched.

## Live verification

A real Gemini deployment (`.orchestrai/config.env`'s real key, this
session's standing authorization), a real scratch project (`package.json`
declaring `hono`, `src/index.ts` with two real Hono routes), the
Orchestrator started **alone** — confirmed via `GET /healthz` →
`"agents":0` — genuinely no DevOps process running anywhere.

**The decisive test.** `POST /tasks {"text":"analyze the project"}`
correctly routed to `plan-task` (confirming the router truly cannot name
`analyze-project` with no agent online). The real completed result:

```
1. [analyze-project] failed — not dispatched
2. [git-status] failed — not dispatched

No agent dispatch was needed — answered directly from the Orchestrator's
own project inspection:
...
=== Codebase Analysis ===
Stack: Node.js with Hono web framework
Structure: Single-module structure with source files under src/
(including src/index.ts) and project configuration in package.json
Observations:
• The project uses Hono as its core web framework as declared in
  package.json and imported in src/index.ts. (package.json, src/index.ts)
• Basic endpoints for health checking and order creation are defined in
  src/index.ts. (src/index.ts)
• The project lacks foundational DevOps files such as a Dockerfile,
  .gitignore, and CI pipeline configuration. (package.json, src/index.ts)
Based on 2 real, verified path reference(s) within this project.
```

The supervisor genuinely attempted two dispatches (both failed — no
agent — `dispatchCount` stayed 0), then `resolveSupervisorFinalContext()`
fired and produced a real, grounded deep analysis — correctly
identifying the real Hono framework (not just "Node.js"), grounded in
real paths. The audit log confirms every one of these calls —
`analyze_project`, `git_status`, five separate `read_project_file` calls
— was made with `"caller":"orchestrator"`, never routed through a
nonexistent DevOps process.

**The no-key regression, live-confirmed**: restarted the Orchestrator
with no LLM key configured at all (still zero agents online) and
resubmitted the identical request. `plan-task` failed closed immediately
with the exact pre-105 error — this spec's new code is gated behind the
same key resolution `runOrchestratorSupervisor()` already required, so
it is structurally unreachable in this case, not merely untested.

**Not independently live-tested**: the explicit-skill fallback path
(`inspectTargetProjectAsTaskResult()`). Attempted via
`POST /tasks {"id":..., "selectedSkill":"analyze-project"}`, but
`POST /tasks`'s own body parser (`parseOrchestratorSubmission()`) accepts
only `{"text": ...}` — it has no `selectedSkill` override, so `detectSkill()`
always resolves the skill itself and, per the same router constraint
above, can never resolve to `analyze-project` with no agent online. This
matches `specs/102`'s own already-documented precedent for this identical
fallback mechanism ("this fallback's real-world reach is defense-in-depth
... not the primary fix") — not a new gap this spec introduces. Covered
directly instead by the three unit tests in
`orchestrator-inspection.test.ts`.

All scratch processes (`mcp:http`, `orchestrator`) and the scratch
project were cleaned up after the pass; no leftover state.

## Known limitations

- The literal acceptance-criterion wording ("proven by a test that
  drives `runOrchestratorSupervisor()` to zero dispatches") was adapted:
  the zero-dispatch upgrade logic was extracted into
  `resolveSupervisorFinalContext()` and tested directly with an injected
  model, since the supervisor's own decision loop has no test-model seam
  of its own to drive it to zero dispatches deterministically. The true
  end-to-end path is confirmed by the live test above instead.
- The explicit-skill fallback's real-world reach remains the same
  narrow, defense-in-depth case `specs/102` already documented — not
  independently forced live in this pass, matching that spec's own
  precedent.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/105-orchestrator-fallback-deep-analysis/spec.md` (implemented,
**verified**) makes `specs/103`'s deep analysis (a) available when
DevOps is not running, and (b) exist as **one** implementation both
DevOps and the Orchestrator import, never two copies that could drift.
Yusuf: *"i need now a solution so i can use this analysize full feature
even if the devops is off without having redandunt work."*

**A design correction found and fixed before implementation, not
after.** The spec's own first draft (2026-09-21) targeted
`inspectTargetProjectAsTaskResult()` as the fix. Tracing the real code
before writing anything showed this was wrong: with DevOps offline, the
LLM router (`specs/065`) cannot name `analyze-project` at all — it only
proposes skills present in the live capability snapshot — so a chat
request always falls to `plan-task`, and, per `specs/103`'s own
supervisor nudge, typically reaches `composeSupervisorResult()`'s
**zero-dispatch** branch instead. The spec was rewritten to target that
branch before any code was written; the status banner keeps the original
wrong draft's reasoning as a recorded correction, not erased.

**`packages/shared/project-analysis.ts`** (new) is now the ONE
implementation — `specs/103`'s schema, grounding, strengthened prompt,
`runProjectAnalysisHarness()`, and `renderCodebaseAnalysis()`, moved
verbatim. Precedent for a `packages/shared` module making real LLM
calls: `packages/shared/capability-router.ts` already does exactly this.
The "per-agent independent harness copy" convention this codebase
otherwise follows exists because each agent's own harness is genuinely
agent-specific (different prompts, skills, tools) — this logic is
identical for every caller, so sharing it is correct, not an exception.
It carries its **own self-contained copy** of the generic LangGraph
tool-calling core (`HarnessState`/`buildReadOnlyTools()`/
`buildHarnessGraph()`/`runHarness()`/`validateJsonParams()`) rather than
importing DevOps's — DevOps's own copy stays untouched, still used by
its four write-skill harnesses. `packages/agents/devops/index.ts` now
imports from shared with **zero behavior change**, proven by every
`specs/103` test passing unmodified in its new home,
`packages/shared/project-analysis.test.ts`.

**Two new Orchestrator call sites, both fail-open and key-gated
(`specs/038`'s own precedent — no resolvable `"orchestrator"` key
silently degrades to the shallow text, never an error):**

1. **The chat path — what actually matters.**
   `resolveSupervisorFinalContext()`, called from
   `runOrchestratorSupervisor()`: when the supervisor makes **zero**
   dispatches, the inspection *is* the answer being returned, so
   spending one real analysis call is proportionate — no other work
   happened for this request. Reuses `fetchProjectInspection()`'s own
   cache (already populated by the grounding call moments earlier), so
   this is a cheap follow-up, never a second independent computation.
2. **The explicit-skill path.**
   `inspectTargetProjectAsTaskResult()`'s `analyze-project` branch now
   appends the deep analysis after the shallow text — what the spec's
   own first (wrong) draft had correctly identified, now secondary to
   the chat path above.

**Untouched, deliberately, confirmed by `git diff` showing zero edits**:
`fetchProjectInspection()` and `dispatchRootTask()`'s own agent-routing
logic (`findAgentForSkill()`). The former must stay fast and LLM-free
forever — it grounds *every* `plan-task` run, `specs/103`'s own
constraint 1. The latter means an online DevOps still routes exactly as
before; neither new call site is ever reached in that case.

**A real, pre-existing testing gap found while writing this checkpoint's
own tests, not introduced by it**: `runOrchestratorSupervisor()`'s own
decision model has no test-injection seam, so a test cannot drive it to
zero dispatches deterministically. Worked around by extracting the
zero-dispatch upgrade into the separately-testable
`resolveSupervisorFinalContext()`, exercised directly with a given
`dispatchCount` via a new `__setTestProjectAnalysisModel()` seam
(mirroring `__setTestRouterModel()`'s own established shape) — the true
end-to-end path is covered by live verification instead.

**Live-verified against a real Gemini deployment, the decisive
scenario**: the Orchestrator started **alone** — confirmed via
`GET /healthz` → `"agents":0`, genuinely no DevOps process anywhere. A
real `POST /tasks {"text":"analyze the project"}` correctly routed to
`plan-task` (confirming the router truly cannot name `analyze-project`
offline); the supervisor's own two attempted dispatches both failed (no
agent, `dispatchCount` stayed 0); the real completed result contained a
genuine, grounded `=== Codebase Analysis ===` section correctly
identifying **"Node.js with Hono web framework"** (not just "Node.js" —
the same depth fix `specs/103`'s own strengthened prompt already
established), citing real paths, backed by five real `read_project_file`
calls the audit log confirms were made with `"caller":"orchestrator"`,
never routed through a nonexistent DevOps process. Restarting with **no**
key configured at all reproduced the exact pre-105 fail-closed error —
this spec's new code is gated behind the same key resolution
`runOrchestratorSupervisor()` already required, so it is structurally
unreachable in that case, not merely untested. The explicit-skill
fallback's own live reach remains the same narrow, defense-in-depth case
`specs/102` already documented (the router structurally cannot name
`analyze-project` with no agent online, so `POST /tasks` has no way to
reach it even with an explicit skill field) — covered instead by direct
unit tests, matching that spec's own precedent for the identical gap.

1240 tests pass (net +16 over `specs/103`'s own 1224 baseline), typecheck
clean, `specs:check` passed for 107 specs. See `specs/105`'s own
`verification.md` for the complete transcript.

See specs/106-persistence-store-and-result-cache/verification.md for the relocated narrative covering this checkpoint.
