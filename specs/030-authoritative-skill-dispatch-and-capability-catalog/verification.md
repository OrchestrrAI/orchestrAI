# Verification: Authoritative Skill Dispatch and Agent-Card Capability Catalog

## Status

`verified` — every automated gate passes, the exact live regression from
026/029's verification evidence is confirmed fixed against the real
compiled binary, and the remaining live Gemini re-run (plan.md Phase 5,
steps 2–5) has now been completed against a real target project, with raw
event capture as evidence. **026 and 029 move to `verification: verified`
in the same update** — this checkpoint's own acceptance criterion.

## Implemented evidence

All five phases from `plan.md` are implemented, each committed separately:

- **Phase 1** — `packages/shared/task-envelope.ts` gains bounded, optional
  `selectedSkill`/`capabilities` fields; new
  `packages/shared/agent-capabilities.ts` normalizes agent registry data
  into a bounded `{agentName, skillId}[]` snapshot (online-only, excludes
  Planning's own skills, rejects ambiguous ownership, sorts
  deterministically, never a hardcoded fallback).
- **Phase 2** — the Orchestrator's `sendTaskToAgent()` transmits an
  authoritative `selectedSkill` for both root tasks and plan children;
  `buildCapabilitySnapshot()` builds Planning's catalog from the live
  registry, returning `null` (never a partial/broken snapshot) on any
  normalization failure.
- **Phase 3** — all five agents run the same
  `validateSelectedSkillOwnership()` check before task storage, and resolve
  `task.selectedSkill ?? detectSkill(text)` in `processTask()`. The shared
  A2A client gained an optional `selectedSkill`; DevOps's existing
  `scan-secrets` call to Security now uses it.
- **Phase 4** — `KNOWN_SKILL_IDS` and the hardcoded skill-to-agent mapping
  are removed from `llm-harness.ts` entirely, replaced by an
  invocation-scoped `capabilities` parameter. New
  `packages/agents/planning/capability-discovery.ts` provides Planning's
  own bounded fallback discovery for direct requests, hardcoded to exactly
  the five URLs in `packages/shared/agent-registry.ts` — the correction
  applied before approval, closing the one gap found during spec review.

One review-time correction, applied to `spec.md`/`plan.md` **before**
implementation began, not discovered mid-work: the original draft's
"bounded read-only discovery against the configured local Agent Card URLs"
was unbounded — Planning had never made an outbound HTTP call to a peer
agent before this checkpoint, and no host allowlist was specified. Fixed to
bind discovery to exactly the fixed five-agent registry, with an explicit
safety-constraint bullet ruling out any new env var or config surface.

## Automated evidence

- `bun test`: **256 passed, 0 failed**, 472 expectations across 26 files —
  86 tests added across the four implementation phases (44 + 12 + 26 + 23,
  overlapping slightly with pre-existing suites re-counted after edits).
- `bun run typecheck`: exited 0 at every phase boundary, not just at the
  end.
- `bun run specs:check`: passed for 30 specs.
- `git diff --check` against the pre-030 baseline (`HEAD~4`): passed, no
  whitespace errors.
- No network calls required for any of the above — all MCP/model calls in
  tests are mocked or injected; the one incidental exception is documented
  below.

### Incidental note, not a defect

Two new test files
(`packages/agents/skill-ownership-http.test.ts`,
`packages/agents/planning/capability-discovery.test.ts` indirectly via
`packages/mcp/index.test.ts` running in parallel) exercise real
`OrchestraiMcpClient.callTool()` calls without mocking the client, and in
this development environment happened to reach a live MCP server already
running on the default port from a prior session. All assertions concern
**routing/structure** (which skill executed, whether `input-required` was
reached), never the MCP call's actual success — so this had no effect on
correctness or determinism of the suite, but is recorded here for honesty
rather than presented as a fully network-isolated test run.

## Compiled-binary evidence (Windows)

- `bun run build`: bundled 1,374 modules successfully.
- Size before this checkpoint (029's own measured baseline):
  **147,458,048 bytes**.
- Size after: **147,468,800 bytes**.
- Exact delta: **+10,752 bytes (~10.5 KiB)** — negligible, as expected: this
  checkpoint added no new npm dependency, only new TypeScript modules.

### Live smoke tests against the real compiled binary, not mocked

Started via `orchestrai.exe --only devops-agent,planning-agent`
(auto-included `mcp:http`). All three scenarios below were run as real HTTP
requests against the real compiled DevOps agent process, not unit tests:

1. **Flag-unset default startup** — Planning logged
   `LLM harness: disabled (default)`, matching every prior checkpoint's
   verified default.
2. **Exact regression, git-status direction** — submitted a task with
   `selectedSkill: "git-status"` and description text mentioning
   "Dockerfile", "docker-compose.yml", and "CI pipeline" verbatim (the same
   wording class as the live 026/029 failure). Result: `status: "completed"`
   via the real `git_status` MCP call path (reporting "Path not found" for
   the nonexistent test directory — the tool ran, which is what matters).
   **Never reached `input-required`.**
3. **Inverse regression, dockerize direction** — submitted a task with
   `selectedSkill: "dockerize"` and description text mentioning only git
   status. Result: `status: "input-required"` with a genuine
   `create_dockerfile` approval preview (`actionId`, real target path,
   real parameters). Rejected through the real `/reject` endpoint; the
   target directory was confirmed to not exist both before and after —
   **no write occurred.**
4. **Ownership rejection** — submitted a task with `selectedSkill:
   "scan-secrets"` (a Security skill) directly to the compiled DevOps
   agent. Result: **HTTP 400**, `"This agent does not own skill
   \"scan-secrets\""`, and a subsequent `GET /tasks/:id` returned **404** —
   confirmed no task storage occurred for the rejected submission.

## Live Gemini evidence — 2026-08-20

Stack started via `bun run orchestrai --project "C:\Users\moham\orch-scratch"`
with `ORCHESTRAI_LLM_HARNESS=1`, `ORCHESTRAI_LLM_PROVIDER=gemini`,
`ORCHESTRAI_LLM_MODEL=gemini-3.5-flash-lite`, and a live API key set only in
Yusuf's own terminal — never seen, stored, or logged by the assistant.
`orch-scratch` is a dedicated scratch project (contains deliberately planted
fake API-key strings for Security-agent testing), separate from this
repository. Raw sanitized events for the three scenarios below are in
`live-events.sanitized.ndjson`, alongside this file. The capture was
grepped for credential patterns before saving; the only matches were false
positives (task ids like `task-9b09d311` containing the substring `sk-9`
inside `ta**sk-9**b0...` — not a key).

### Scenario 1 — Planning-owned read-tool scenario, through the new dynamic catalog

Request: `"set up my whole project properly, from scratch"` (task
`task-c80c8948-...`). The captured event stream shows, in order:

```
TOOL_CALL_START  runId=task-c80c8948-...  toolCallName=analyze_project  caller=planning-agent
TOOL_CALL_START  runId=task-c80c8948-...  toolCallName=git_status       caller=planning-agent
TOOL_CALL_RESULT ... outcome=completed (analyze_project, 69ms)
TOOL_CALL_RESULT ... outcome=completed (git_status, 186ms)
RUN_FINISHED     runId=task-c80c8948-...  outcome=success
```

`caller: "planning-agent"` on both calls is the direct proof this ran
through the **new dynamic capability catalog**, not the removed
`KNOWN_SKILL_IDS` — the harness only reaches this call shape with a live
Gemini-driven decision loop. The resulting 7-step plan
(`git-status → analyze-project → create-gitignore → dockerize → create-ci
→ generate-readme → document-api`) used only catalog-valid skill ids and
correctly named `devops-agent`/`documentation-agent` as needed.

Every downstream child dispatched from that plan executed the **exact**
skill named in the plan — proven, not assumed: step 1 (`git-status`) and
step 2 (`analyze-project`) both completed via real `devops-agent` tool
calls (`caller: "devops-agent"` in the same capture, plus a real
`devops-agent → security-agent` A2A hop for the `analyze-project` secrets
pre-check), and step 3 (`create-gitignore`) reached a genuine
`input-required` approval preview rather than silently reinterpreting into
a different skill.

### Scenario 2 — Controlled write, reject, and fingerprint

Step 3 of the same plan (`create-gitignore`) stopped at `input-required`
with target `C:\Users\moham\orch-scratch\.gitignore` and a real `actionId`.
`orch-scratch` was fingerprinted before submission (8 entries: `.env`,
`.git`, `config.ts`, `index.ts`, `package.json`, `sample.test.ts`, plus the
two directories) and confirmed `.gitignore` was absent. Rejected via
`POST /tasks/:id/reject` with the real `actionId`. Result: child status
`failed`, **no `.gitignore` file created** (confirmed by directory listing
immediately after), and the parent plan correctly stopped — steps 4–7
remained `pending`, never dispatched, matching `watchPlanAndDispatch()`'s
existing stop-on-failure behavior.

### Scenario 3 — Out-of-scope, zero steps

Request: `"what is the capital of France and how many moons does Jupiter
have"`. Result: `status: completed`, zero plan steps, zero children
dispatched — the existing "No actionable steps could be determined from
this request" message, unchanged.

### A real operational incident, found and corrected during this run

The **first** attempt at this live run was started with no `--project`
flag, from within this repository's own working directory. Per
`specs/018-supervisor-project-path/spec.md`'s documented `process.cwd()`
fallback (working as specified, not a bug), the OrchestrAI repository
itself became the resolved target project. Two Tier-1 approval-gated plan
steps (`create-compose`, `create-ci`) were approved by a human without the
target mismatch being caught, overwriting this repository's real
`docker-compose.yml` (a documented, live-verified 7-service stack, down to
13 generic lines) and silently dropping the `bun run specs:check` step
from `.github/workflows/ci.yml`. Neither file had been committed yet;
both were restored with `git restore` before any damage became permanent.
The run was then redone correctly with `--project` set explicitly — see
above.

This was a real, live-discovered gap, not a hypothetical one: both the
TUI (`apps/tui/index.tsx`) and the dashboard
(`apps/orchestrator/index.ts`) render the entire approval object as an
undifferentiated `JSON.stringify(..., null, 2)` blob. The `target` field
(the full absolute path about to be written) is present in the data the
whole time — the gate itself was never bypassed — but neither client
visually distinguishes it from any other field, so a human approving
under normal conditions has no particular reason to notice it names the
wrong project. This is recorded here as a genuine finding from this
checkpoint's own live verification, not filed against `030` itself (the
authoritative-dispatch mechanism worked correctly throughout — this is a
UI-legibility gap in how the approval preview is presented, orthogonal to
whether the target is correct). Worth its own small, separately-approved
checkpoint: surface `approval.target` as its own labeled, prominent line
in both clients, ahead of the rest of the JSON detail.

## Outcome

All acceptance criteria for this checkpoint are satisfied. `026` and `029`
move to `verification: verified` alongside `030` in this same update.
`028`'s precondition on `026` being verified is now satisfied by this
checkpoint's work, not a separate decision — `028` remains blocked only on
`027` being implemented and its own approval.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

That fix is `specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md`
(implemented and **verified** as of 2026-08-20): the Orchestrator now sends
an authoritative `selectedSkill` on every dispatch, every agent validates
and executes it exactly (never re-deriving one from free text when
present), and the exact regression is confirmed fixed live against the
real compiled binary — a `git-status` task whose description mentions
`Dockerfile`, `docker-compose.yml`, and a CI pipeline stays `git-status`
and never reaches `input-required`; the inverse (a `dockerize` task whose
description mentions only git status) still correctly reaches
`input-required`. A live Gemini re-run through the new dynamic capability
catalog (`bun run orchestrai --project <scratch-dir>`) then repeated all
three 026/029 scenarios end to end against a real target project —
Planning genuinely calling `git_status`/`analyze_project` before deciding
a plan, an out-of-scope request producing zero steps, and a controlled
write stopping at `input-required` and rejected with no file written —
closing specs 026 and 029 to `verification: verified` as well; see all
three specs' verification records, including one real operational
incident that run surfaced and corrected (an earlier attempt with no
`--project` flag defaulted its target to this repository itself, per
`specs/018`'s documented `process.cwd()` fallback, and two approval-gated
writes were approved without the target mismatch being caught — neither
file had been committed, both were restored with `git restore` before any
damage became permanent). That incident is recorded as a genuine
UI-legibility finding, not a gate failure: the approval preview's `target`
field was present in the data the whole time, just not visually
distinguished from the rest of the JSON detail in either client.
`specs/033-dashboard-approval-preview-card/spec.md` (implemented, verified)
fixed this for the browser dashboard: `target` now renders as its own
prominent, bordered line above a labeled action/parameters/risks card,
with the previous raw-JSON view still available (byte-identical) behind a
toggle. `specs/035-devops-dashboard-approval-preview-card/spec.md`
(implemented, **verified**) then ported the same card to the DevOps
agent's own dashboard (`:3002`) — confirmed directly by Yusuf via a real
browser click-through ("35 is verified all is good").
`specs/037-tui-approval-preview-card/spec.md` (implemented, **verified**)
closes the matching gap in the TUI's Detail overlay (`apps/tui/index.tsx`):
the `approval` block now renders as labeled rows — `Target` first and
high-contrast, each risk on its own flagged row, `parameters` as
`key: value` rows, `actionId` de-emphasised — with `v` toggling the
byte-identical raw JSON dump. It is a rendering-only change confined to
one JSX expression inside the existing fixed-height scrollbox, so it
touches no `specs/012` layout-budget constant; the pure
`formatApprovalRows()` helper has focused unit coverage
(`apps/tui/format-approval-rows.test.ts`). Live in-terminal verification
of the layout and the approve/reject flow (`a`×2/`r`×2 behaving unchanged,
Detail-overlay layout under a full task list at a zoomed-out terminal) was
confirmed directly by Yusuf ("37 verified").

See specs/051-planning-retirement-and-required-key/verification.md for the relocated narrative covering this checkpoint.

See specs/026-llm-harness-langgraph-planning/verification.md for the relocated narrative covering this checkpoint.

See specs/041-llm-harness-documentation/verification.md for the relocated narrative covering this checkpoint.

See specs/079-phase-a-connect-orphaned-tools/verification.md for the relocated narrative covering this checkpoint.

See specs/080-run-command-approved-execution/verification.md for the relocated narrative covering this checkpoint.

See specs/077-agent-enabled-means-llm-on-by-default/verification.md for the relocated narrative covering this checkpoint.
