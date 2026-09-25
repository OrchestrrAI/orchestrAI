# Verification: specs/102 — Orchestrator Read-Only Project Inspection

## What changed

**A new, optional MCP client on the Orchestrator** (`apps/orchestrator/index.ts`),
bound to the same four general-inspection tools `specs/101` gave every
code-reasoning agent: `analyze_project`, `read_project_file`,
`git_status`, `git_diff`. Construction (`buildOrchestratorMcpClient()`)
is wrapped in `try/catch` and never `start()`ed eagerly.

**`inspectTargetProject()`** — the single function where the "strictly
optional" guarantee lives. Cache-first via `specs/057`'s existing
`projectSnapshotCache`, sharing one cache entry with a real dispatched
`analyze-project` skill call.

**`runOrchestratorSupervisor()`** calls it once per run and threads the
result into `runSupervisor()`'s new optional `projectContext` parameter,
which `buildSystemPrompt()` (`apps/orchestrator/supervisor-graph.ts`)
appends to the prompt when present — byte-identical with none.

**`composeSupervisorResult()`** gains a new case: when the supervisor
makes zero real dispatches and `projectContext` was available, the real
inspection content replaces the generic `"completed after 0
dispatch(es)"` line.

**`dispatchRootTask()`'s own no-agent branch** gains a precondition:
for `analyze-project`/`git-status` specifically, try direct inspection
before failing.

**`/healthz`** gains an `mcp` field. **The Orchestrator gains a minimal
shutdown** (none existed before). **`docker-compose.yml`**'s
`orchestrator` service gains `ORCHESTRAI_MCP_URL`/
`ORCHESTRAI_MCP_ALLOWED_HOSTS`.

## A real design flaw found and fixed during implementation, not shipped as first drafted

The approved spec's own acceptance criteria assumed
`dispatchRootTask()`'s no-agent branch was the primary path for the
motivating "--only orchestrator" scenario. Writing the first end-to-end
test proved this false: `specs/065`'s LLM router validates every
proposal against the *live* capability snapshot before using it, so
with zero agents online it can never legitimately name
`analyze-project`/`git-status` — it always falls through to `plan-task`
first. `dispatchRootTask()`'s no-agent branch is real defense-in-depth
(a genuine, if narrower, race-condition case), not the scenario's actual
fix.

The actual fix is `composeSupervisorResult()`'s new zero-dispatch case,
extending `specs/075`'s own precedent for the identical class of gap in
conversational chat. This was implemented, tested, and documented as
the corrected mechanism — see the spec's own status banner and Purpose
section for the full record. `dispatchRootTask()`'s fallback was kept
(it is still correct and free) and is directly tested with an explicit
skill rather than through the router path that cannot actually reach it
in the scenario that motivated this spec.

A further, related, honestly-named gap: `dispatchPlanStep()` (a
*separate* function from `dispatchRootTask()`) has its own independent
no-agent handling, untouched by this spec. See the spec's own Non-Goals
for the full explanation of what this does and does not cover.

## Test results

- `bun test` (full suite): **1201 pass, 0 fail, 2 skip** (pre-existing,
  unrelated) — net **+24** over the pre-102 baseline of 1177.
- `bun run typecheck`: 0 errors.
- `bun run specs:catalog` / `bun run specs:check`: pass, 101 specs.
- New `apps/orchestrator/orchestrator-inspection.test.ts` (24 tests):
  construction-never-throws (5), `inspectTargetProject()` degradation
  and cache behavior (7), `buildSystemPrompt()` additive-only (2),
  `inspectTargetProjectAsTaskResult()` shape (4),
  `dispatchRootTask()`'s no-agent fallback exercised directly (4), plus
  the real-agent-preferred-over-fallback case (1) and the fallback-set
  membership check.
- Extended `apps/orchestrator/compose-supervisor-result.test.ts`: 2 new
  tests proving the new zero-dispatch branch fires only when
  `dispatchCount === 0`, and that a real dispatch's own result is never
  overridden by `projectContext` even when supplied.
- `apps/orchestrator/supervisor-graph.test.ts` and
  `supervisor-wiring.test.ts`: unmodified, still passing — confirms
  `buildSystemPrompt()`'s new optional parameter is genuinely additive.

## Live verification

Started the real MCP HTTP server and a real Orchestrator process
(`ORCHESTRAI_PROJECT_PATH` pointed at a real scratch git repo, no
provider key configured).

**Strict optionality, the load-bearing property — confirmed against a
real running process, not just tests:**

```
$ curl http://localhost:3000/healthz   (mcp:http reachable, not yet used)
{"status":"ok","agents":2,"tasks":0,"projectPath":"...","capabilities":{"ok":true},
 "mcp":{"state":"disconnected","url":"http://127.0.0.1:3006/mcp","discoveredTools":[]}}

$ [kill mcp:http]
$ curl http://localhost:3000/healthz   (mcp:http now dead)
{"status":"ok", ... same as above — Orchestrator completely unaffected}
```

The Orchestrator started cleanly, reported `status: "ok"` before ever
touching MCP (lazy-connect confirmed), and continued reporting healthy
after `mcp:http` was killed mid-run — the exact guarantee this spec's
safety story depends on, demonstrated against a real process rather
than only asserted in a unit test.

**Shutdown** — the process was stopped and confirmed to exit (not
hang). **Not confirmed as a clean interactive SIGINT specifically**:
this sandbox's only means of stopping the process (Windows
`Stop-Process`) does not deliver a real SIGINT the way an interactive
terminal's Ctrl+C does — the same standing limitation
`specs/016`/`067`/`074` already documented for this exact class of
test.

## Closed live, 2026-09-20 — the zero-dispatch grounding path, with a real key

Yusuf: *"the real api key is here in the conf in orch folder in this
repo, and you can run a reall terminal test without me"* — a real
Gemini key was already present in `.orchestrai/config.env` (gitignored,
confirmed via `git check-ignore`). This closes the single most
important item this spec's own verification record had left open.

**Setup**: a real scratch git project (`package.json`, `math.js`, a
real `git commit`, then a real uncommitted change so `git status` had
something genuine to report). Full stack started via
`bun run orchestrai --project <scratch>`, confirming all 7 services
healthy with real Gemini config for every component
(`gemini-3.5-flash-lite` orchestrator/coder, `gemini-3.1-flash-lite`
DevOps, etc.).

**The decisive test — `--only orchestrator`, genuinely zero agents**:
restarted the Orchestrator alone (`bun run orchestrai --project
<scratch> --only orchestrator`); `GET /agents` confirmed `count: 0`.
Dispatched a real `POST /tasks {"text": "what language and stack is
this project using?"}`:

```
$ curl -X POST :3000/tasks -d '{"text":"what language and stack is this project using?"}'
{"id":"task-...","status":"working","assignedAgent":"orchestrator-supervisor","skill":"plan-task", ...}
```

Confirmed the router correctly fell through to `plan-task` (no agent
online to name `analyze-project` directly — exactly the mechanism
finding recorded in the spec's own status banner). The real completed
task:

```json
{
  "status": "completed",
  "planSteps": [{"order":1,"skill":"run-command","description":"Read package.json to inspect dependencies and configuration for language and stack details","status":"failed"}],
  "childTaskIds": [],
  "result": "1. [run-command] failed — not dispatched\n\nNo agent dispatch was needed — answered directly from the Orchestrator's own project inspection:\n\n=== Target Project (real, resolved path — use this, never a guess) ===\nC:\\Users\\moham\\AppData\\Local\\Temp\\live-verify-102\n\n=== Project Analysis ===\n...\n✅ hasManifest (package.json)\n❌ hasLockfile (...)\n\n=== Files & Folders ===\n.git/\nmath.js\npackage.json\n\n=== Git Status ===\nBranch: master\n\nStatus:\nM math.js\n\nLast 5 commits:\ndb8d973 add sum helper\nc55752a init scratch project"
}
```

Confirmed via the process's own audit log:

```
{"caller":"orchestrator","target":"analyze_project","taskId":"orch-task-...","outcome":"completed",...}
{"caller":"orchestrator","target":"git_status","taskId":"orch-task-...","outcome":"completed",...}
```

`caller: "orchestrator"` — not an agent — proves these were the
Orchestrator's own direct MCP calls, correctly correlated to the real
run via the `orch-<task.id>` convention. **Every claim in the
zero-dispatch design is now proven together, not separately**: the
supervisor tried a real dispatch (`run-command`) which genuinely failed
with no agent online (`dispatchCount` stayed `0`); `composeSupervisorResult()`'s
new branch fired; the real inspection content — the exact same block
the model's own prompt was grounded with — reached the task's final
result instead of the old generic `"completed after 0 dispatch(es)."`
line. The supervisor's own plan step additionally named `package.json`
specifically, a fact present only in the real `analyze_project`
grounding (`hasManifest (package.json)`), confirming the model
genuinely read and acted on the injected context, not a coincidence.

## specs/101 — a real, honest finding on the new tools' live usage

While the same real stack was up (all 6 agents, real key), three real
requests were dispatched specifically to see whether a genuine model
decision would reach for the new `specs/101` tools
(`analyze_project`/`git_status`/`git_diff`) now bound to each harness:

- **Coder** (`edit-file`, add a JSDoc comment to a real file with a
  real uncommitted change already present): called only
  `read_project_file` once, proposed a correct, well-grounded edit, and
  never called `git_diff`/`git_status`/`analyze_project`.
- **Documentation** (`generate-readme` against the same real project):
  called `read_project_file` four times (existence check, directory
  listing, `package.json`, `math.js`) and produced a genuinely accurate
  README — correctly describing the real `average()` function including
  its empty-array guard — without ever calling `analyze_project`.
- **Code Review** (`review-diff` against a real, genuinely broken diff
  — see below): called the pre-existing `git_diff` (the deterministic
  diff-fetch, not the new harness binding) and `read_project_file`
  once; never called the new `analyze_project`/`git_status` harness
  tools either.

**Consistent, honest finding across all three**: the new tools are
correctly bound, discoverable, and reachable (already proven via
`/healthz` and unit tests) — but in these three real requests, no model
chose to call them, because `read_project_file` alone already supplied
everything each task actually needed. This has a real structural
explanation, not just model preference: `read_project_file` returns the
*current real file content* directly, which already reveals the same
uncommitted-work signal `git_status`/`git_diff` would provide for a
single-file task — the new tools' marginal value is real (project-wide
structure, branch state) but wasn't needed by any of these three
specific, narrowly-scoped requests. Recorded honestly rather than
claimed as a positive result that wasn't observed.

**An incidental, decisive proof of Code Review's own correctness along
the way**: a real shell-scripting mistake while constructing the test
diff genuinely left a duplicate `sum` export and a truncated `median`
function in the scratch file. Code Review's real response correctly
identified both as blocking issues (`"Duplicate export 'sum'"`;
`median` "ends abruptly ... missing closing brace") — confirmed against
the actual `git diff` output, not assumed. An accidental but clean
adversarial test, not staged.

## Known limitations

- **Live-verified 2026-09-20** (was previously open): a real supervisor
  run reaching the zero-dispatch grounding-to-real-answer path through
  a genuine model decision — see above.
- **Not live-verified**: a clean interactive Ctrl+C shutdown specifically
  (see above) — the process-exit property was confirmed, the signal
  delivery mechanism was not.
- **Named, not fixed**: `dispatchPlanStep()`'s own separate no-agent
  handling is untouched — a plan step the supervisor actually dispatches
  (rather than recognizing up front from grounding that no dispatch is
  needed) still just fails if no agent owns its skill. See the spec's
  own Non-Goals.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/102-orchestrator-readonly-project-inspection/spec.md`
(implemented) is the follow-up `specs/101` deliberately split out — the
Orchestrator gains its own MCP client for the first time. Motivated
directly: *"if i don't run the agant that can run the analisize for
example the orch will not have the ablitiy to know about the
project."* Yusuf's own words scoped its shape: *"what if all the
analisize tools that the orch can reach when it is needed? just
that."*

**Read-only, strictly optional, never a skill.** Bound to the same four
general-inspection tools `specs/101` gave every code-reasoning agent
(`analyze_project`, `read_project_file`, `git_status`, `git_diff`).
Construction is wrapped in a `try/catch` — unlike every agent's own
module-scope client construction (a hard crash on a malformed
`ORCHESTRAI_MCP_URL`, acceptable for a required agent, never acceptable
for the component that coordinates everything) — and never `start()`ed
eagerly; the client's own existing lazy-connect design already handles
that. Never advertised as a skill, so no skill id gains a second owner
and `specs/101`'s own collision guard is unaffected.

**A real design flaw was caught and fixed during review, not shipped as
first drafted.** The first draft of this spec called
`analyze_project`/`git_status` fresh on every single `plan-task` run —
Yusuf caught it directly: *"but that will analyze the project with each
plan? why while if it done it once already?"* Corrected:
`inspectTargetProject()` now consults `specs/057`'s existing
`projectSnapshotCache` before calling any tool, populating it on a miss
using the identical entry shape a real dispatched `analyze-project`
skill call already writes. A bare `POST /tasks` (no `conversationId`)
still never touches the cache at all, matching `specs/057`'s own
existing rule exactly, not silently reintroducing a second caching
mechanism.

**A second real finding, made during implementation, not assumed from
drafting.** The approved spec's own acceptance criteria assumed a
project question with zero agents online would reach
`dispatchRootTask()`'s no-agent branch (`"No agent found for skill"`) —
checked directly and found false. The LLM router (`specs/065`)
validates every proposal against the **live** capability snapshot
before using it, so with no agent advertising `analyze-project`, the
router can never legitimately name it — it always falls through to
`"plan-task"` instead, before `dispatchRootTask()`'s no-agent branch is
ever reached. The real path for the motivating scenario is therefore
the adaptive supervisor's own **zero-dispatch result**: when the
supervisor is grounded with real project context and correctly decides
no agent dispatch is needed, `composeSupervisorResult()` used to report
only `"Supervisor run completed after 0 dispatch(es)."`, discarding the
real answer it was just given — the same class of gap `specs/075`
already fixed once for conversational chat, found again here for
plan-task's own zero-dispatch case. Fixed: `composeSupervisorResult()`
now surfaces the real inspection content in that specific case, reusing
the exact same `projectContext` value the model itself was shown, so
the user-visible result and the model's own grounding stay in sync by
construction. `dispatchRootTask()`'s own no-agent fallback is kept
regardless — it is still correct, still free, and remains the right
behavior for any future caller that reaches that function with an
explicit skill outside the LLM-router path (confirmed reachable and
tested directly, exported for exactly that purpose) — but it is
defense-in-depth, not the primary mechanism, and this file states that
honestly rather than as originally assumed.

**`/healthz` gains an `mcp` field** using `readiness()` (a pure,
synchronous snapshot — never `pingReady()`, which performs real I/O and
would make every `/healthz` call block on this optional dependency).
**The Orchestrator also gains a minimal shutdown** — it had none before
this spec, not even a retained `serve()` handle — because one
`callTool()` against an unreachable MCP server leaves a perpetual
5-second reconnect loop running for the rest of the process's life;
mirrors `packages/agents/documentation/index.ts`'s own existing
SIGINT/SIGTERM shape.

1201 tests pass (net +24 over `specs/101`'s own 1177 baseline),
typecheck clean, `specs:check` passed for 101 specs. Live-verified: the
Orchestrator starts and reports `status: "ok"` with `mcp:http`
unreachable, and continues reporting healthy after `mcp:http` is killed
mid-run — the strict-optionality guarantee confirmed against a real
process, not just asserted in tests.

**Closed live, 2026-09-20, once a real key was available** (Yusuf:
*"the real api key is here in the conf in orch folder in this repo,
and you can run a reall terminal test without me"*) — the single most
important open item. A real `orchestrai --only orchestrator` process
(confirmed via `GET /agents` → `count: 0`), a real Gemini key, a real
scratch git project: `POST /tasks {"text": "what language and stack is
this project using?"}` correctly routed to `plan-task` (the router
found no online agent to name directly, exactly the mechanism finding
above), the supervisor's own attempted `run-command` dispatch genuinely
failed with no agent online, and the task's real final result was
`"No agent dispatch was needed — answered directly from the
Orchestrator's own project inspection:"` followed by the real
`analyze_project`/`git_status` content — confirmed via the audit log as
`caller: "orchestrator"`, not an agent. The supervisor's own plan step
additionally named `package.json` specifically, a fact present only in
the real grounding block, confirming the model genuinely read and
acted on the injected context. See `specs/102`'s own `verification.md`
for the full transcript. **Still not live-verified**: a clean
interactive Ctrl+C shutdown (Windows `Stop-Process` in this sandbox
does not deliver a real SIGINT the way an interactive terminal does —
the same standing limitation `specs/016`/`067`/`074` already documented
for this exact class of test).

See specs/103-deep-project-analysis/verification.md for the relocated narrative covering this checkpoint.

See specs/105-orchestrator-fallback-deep-analysis/verification.md for the relocated narrative covering this checkpoint.

See specs/106-persistence-store-and-result-cache/verification.md for the relocated narrative covering this checkpoint.
