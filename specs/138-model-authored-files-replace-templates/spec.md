---
id: 138-model-authored-files-replace-templates
title: The Model Authors Every File and Test Command; All Templates Removed
area: llm-harness
change_type: feature
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 042-llm-harness-devops
  - 041-llm-harness-documentation
  - 101-per-agent-tool-access-expansion
  - 104-deferred-work-register
supersedes: []
superseded_by: []
related:
  - 040-approval-preview-content-diff
  - 056-devops-preflight-and-idempotent-writes
  - 077-agent-enabled-means-llm-on-by-default
  - 079-phase-a-connect-orphaned-tools
  - 110-approval-state-survives-a-restart
  - 129-deny-orchestrai-state-dir
  - 134-devops-harness-sees-the-request
  - 137-plan-step-acts-only-on-its-own-step
  - 058-testing-agent-multi-ecosystem-runner-detection
  - 080-run-command-approved-execution
  - 111-testing-documentation-routing-fixes
---

# Spec: The Model Authors Every File and Test Command; All Templates Removed

> Status: **APPROVED by Muhamad-Yussuf on 2026-09-25** ("ok approved").

## Purpose

Deferred item A4 (`specs/104`) records Yusuf's request: *"why will need a
template we can write just the needed docker file for it"*. Today every
DevOps file is a fixed template, and the model only picks a few parameters.
A template cannot express multi-stage builds beyond its one shape, other
runtimes, system packages, custom build steps, CI lint/typecheck jobs,
compose volumes or healthchecks. It also produces the same file for very
different projects.

This spec removes every file template in the runtime. The model writes the
whole file from the real project. Because these files get **executed**
(`docker build`, a real CI run, `docker compose up`), every file passes
deterministic validation *before* the human ever sees the preview. The
human then approves the exact file, as today.

Scope decisions made for this spec (Yusuf, 2026-09-25):
- the safety design is **validate after writing**;
- templates are **removed**, not kept as a fallback;
- it covers **all four DevOps files**;
- **every other agent** was checked for templates;
- and (added after review) Testing's fixed test-command profiles are
  removed too, so **every test command is proposed by the model**.

## Verified Current State — the template inventory

A search of all six agents, the MCP server and the supervisor for
file-generating templates found exactly these:

| # | Template | Where | The model decides today | Executed by |
|---|---|---|---|---|
| 1 | `create_dockerfile` (bun/node/python/go multi-stage) | `packages/mcp/index.ts:480` | `app_type`, `port` | `build-image` (`docker_build`), `verify-deployment` (`docker_run`) |
| 2 | `create_github_action` (bun/node/python) | `packages/mcp/index.ts:585` | `app_type`, `include_docker` | GitHub, on every push/PR |
| 3 | `create_dockercompose` | `packages/mcp/index.ts:658` | the service list | `docker compose up` |
| 4 | `create_gitignore` | `packages/mcp/index.ts:700` | `project_type`, extra patterns | nothing (read by git) |
| 5 | Documentation's deterministic README builder `computeReadmeContent()` | `packages/agents/documentation/index.ts:140` | nothing (used only when the Documentation LLM is off) | nothing (read by people) |
| 6 | Documentation's deterministic API-doc builder `buildApiDoc()` | `packages/agents/documentation/index.ts:266` | nothing (only when the LLM is off) | nothing |
| 7 | Testing's fixed test-command profiles `RUNNER_ARGV` (bun, npm, pnpm, yarn, jest, vitest, pytest; plain and coverage) | `packages/shared/test-runner.ts:27`, executed by the MCP `run_tests` tool | nothing (for a detected runner) | the test run itself |

Checked and **not** templates:
- **Testing's `detectRunner()`** (`specs/058`): manifest-based detection. It
  stays. `write-tests` uses it for the test framework and the output path,
  and it becomes a *hint* for the model's test command.
- **Coder, Code Review, Security:** no templates. Coder's and Testing's
  `write-tests` content is already model-authored and grounded.
- **The supervisor's guided init**: writes its own `config.env` from the
  user's form input; that is configuration, not a project file. (It also
  adds `.orchestrai/` to the target `.gitignore`, a one-line append that
  stays.)

Other relevant facts:
- **How DevOps writes today.** It writes through the template tools
  themselves (`writeFile` inside each MCP tool, with `dry_run` for the
  preview, `specs/040`). DevOps does **not** have `write_project_file`
  (`packages/agents/devops/mcp-client.ts` `REQUIRED_TOOLS`). Only Coder,
  Documentation and Testing do.
- **Checks that exist today.**
  - `lint_ci_workflow` validates a workflow file's structure, but only
    *after* it is written (`packages/agents/devops/index.ts:1054`).
  - Preflight, the content fingerprint and the drift recheck apply to all
    four writes (`specs/056`).
  - Pending approvals survive a restart (`specs/110`).
- **With `ORCHESTRAI_DEVOPS_LLM_HARNESS=0`**, the four skills run the
  deterministic template path. With `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=0`,
  Documentation uses templates 5 and 6.
- **The four MCP tools are also on the external stdio surface** (Claude
  Desktop/Code), per the architecture.
- **Test commands today.**
  - For a *detected* runner, `run-tests` and `check-coverage` use
    `RUNNER_ARGV` via the MCP `run_tests` tool, with no model and no key
    needed.
  - For an unsupported or ambiguous runner, the model already proposes the
    argv (`runTestCommandHarness`, `specs/080`/`111`), executed via
    `run_command`.
  - Both tools run with the same minimal environment allow-list
    (`buildSanitizedTestEnv()`), no shell and a 120 s timeout.
  - Every invocation is individually approved (`specs/080`: no
    auto-approve, no trusted-command memory).
  - `parseTestCounts()`/`parseCoveragePercent()` read the pass/fail counts
    and coverage from known runners' output.
  - Only Testing calls `run_tests`. Coder lists it in `requiredTools` but
    never calls it; its verification goes through `run_command`.

## Proposed Behavior

### 1. The model writes the whole file (DevOps: all four skills)
- One DevOps authoring harness per file kind (`dockerize`, `create-ci`,
  `create-compose`, `create-gitignore`), each built on the existing
  read-only tool loop:
  - `READ_ONLY_TOOL_NAMES` is unchanged, and the harness must read the real
    project (manifests, entry points, lockfiles, existing
    Dockerfile/workflows).
  - It gets the request via `specs/134` and the step and background via
    `specs/137`.
  - It returns `{ "content": <full file>, "summary": <one line> }`, or a
    refusal `{ "refused": true, "reason": … }` when the project genuinely
    can't support the file.
- **Target paths stay deterministic** (`Dockerfile`, `docker-compose.yml`,
  `.github/workflows/ci.yml`, `.gitignore` under the resolved project
  root). The model never chooses where a file goes.

### 2. Validation before the preview (the safety design)
A new pure module, `packages/shared/devops-file-validation.ts`, runs on the
model's content. **A failing file gets one retry, with the exact
violations fed back to the model, then fails closed with them named.** No
preview is ever shown for an invalid file. The checks:

- **Dockerfile**
  - Every `FROM` image is on an allow-list of official runtime and base
    images (e.g. `oven/bun`, `node`, `python`, `golang`, `rust`,
    `eclipse-temurin`, `mcr.microsoft.com/dotnet/*`, `alpine`, `debian`,
    `ubuntu`, `gcr.io/distroless/*`), or is a named earlier stage.
  - No `curl … | sh` / `wget … | bash`-style pipe-to-shell.
  - No `ADD` from a URL.
  - No secrets baked in: no `ENV`/`ARG` whose name matches the existing
    sensitive-name patterns and whose value is literal.
  - No `--privileged`-style build flags.
  - It must contain at least one `FROM`, and one `CMD` or `ENTRYPOINT`.
  - **Grounding:** every `COPY`/`ADD` source that is a concrete path (not
    `.`, not a glob, not `--from=` a stage) must exist in the project,
    checked via `read_project_file`. This is the `specs/100`-style
    grounding, applied where it transfers.
- **CI workflow**
  - It passes the existing `lint_ci_workflow` structural rules, run on the
    content *before* the write (the lint logic moves into the shared pure
    module; the MCP tool keeps using it).
  - Every `uses:` action is on an allow-list of owners (`actions/*`,
    `docker/*`, `oven-sh/setup-bun`, `github/*`) and pinned to a tag or SHA.
  - No `pull_request_target` trigger.
  - No `curl | sh`.
  - No `secrets.*` beyond `GITHUB_TOKEN` unless the project already
    references that secret.
  - `permissions` is not `write-all`.
- **Compose**
  - Every `image:` is on the Dockerfile allow-list, or is the app's own
    image built from the project (`build: .`).
  - No `privileged: true`, no `network_mode: host`, no `pid: host`.
  - No bind mount of `/`, `/var/run/docker.sock`, or any path outside the
    project.
  - No literal values for sensitive-named env vars.
- **.gitignore** (light: it is never executed)
  - Must still ignore `.orchestrai/` (the `specs/129` state dir with the
    provider key).
  - Must not un-ignore (`!`) any sensitive-name pattern (`.env*`, keys).

All allow-lists are exported constants with tests. Widening one is a
normal reviewed code change; no environment-variable override is added.

### 3. Writing without templates
- DevOps gains `write_project_file` in `REQUIRED_TOOLS`, used **only** by
  these four skills, **only** from `resumeTask()` after approval.
  - It already writes these exact files today through the template tools.
    This moves the write to the shared, path-contained,
    sensitive-name-denying tool, with no new effect.
  - This is the explicit `specs/101` decision: a write tool shared with a
    fourth agent, for the same four targets.
- **What stays the same for every write** (`specs/040/056/110`):
  - the content is computed once at preview and written verbatim;
  - preflight classifies create, no-op, update or blocked;
  - the fingerprint recheck runs before the write;
  - the pending action survives a restart;
  - `lint_ci_workflow` still runs after a CI write, as a second check.

### 4. Removing the templates
- **The four MCP template tools are deleted**, from both the HTTP and stdio
  surfaces, along with their tests. External stdio MCP clients use
  `write_project_file` for such files instead (named in the changelog and
  `CLAUDE.md`).
- **The deterministic DevOps parameter path is deleted.** With
  `ORCHESTRAI_DEVOPS_LLM_HARNESS=0` (or no key), these four skills **fail
  closed** with a named error ("model-authored files require the DevOps
  LLM; templates were removed in specs/138"). The startup key check
  (`specs/064`) names this consequence for DevOps, as it already does for
  Code Review and Coder.
- **Documentation's templates 5 and 6 are deleted.** With
  `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=0`, `generate-readme` and
  `document-api` fail closed the same way.
  - `scanApiRoutes()` (deterministic route *discovery*) is a scanner, not a
    template, and stays: it grounds the model's API doc (`specs/100`).
- The `specs/134` parameter harnesses and `STATED_VALUES_RULE` are
  replaced by the authoring harnesses. The stated-values rule carries over
  into the authoring prompts ("a port or version the user states must
  appear as stated").

### 5. The model proposes every test command (Testing)
- `run-tests` and `check-coverage` always ask the model for the argv, using
  the existing `runTestCommandHarness`, extended with:
  - `detectRunner()`'s result as a hint (the detected runner and its
    evidence, or "none" / "ambiguous: X vs Y");
  - whether coverage was requested;
  - the step and background (`specs/137`).
- The proposal is `{ argv, reason }`, with no shell string.
- It executes via `run_command` (same sanitized env, no shell, timeout,
  output cap, cwd containment and denylist), after its own approval, as
  model-proposed commands already do today. Everything from `specs/080` is
  unchanged:
  - one approval per invocation;
  - no auto-approve;
  - no trusted-command memory;
  - the preview shows the exact argv.
- **Deleted:** `RUNNER_ARGV`, the MCP `run_tests` tool (both surfaces, with
  its tests), and `run_tests` in Testing's and Coder's `requiredTools`.
- **Result parsing becomes best effort.** `parseTestCounts()` and
  `parseCoveragePercent()` still run on the output, and are extended to the
  common formats of the proposed runners. When they recognize nothing, the
  result says "counts not recognized" and shows the (capped) raw output.
  They never invent a number.
- **With the Testing LLM off or no key,** `run-tests` and `check-coverage`
  fail closed with the same named "templates were removed in specs/138"
  error.
- `write-tests` is unchanged: its framework and output path still come
  from `detectRunner()`, and running the new test file stays a separate
  approval.

## Scope

- `packages/shared/devops-file-validation.ts` (new) + tests: the
  validators and allow-lists, and the moved `lint_ci_workflow` logic.
- `packages/agents/devops/llm-harness.ts`: the four authoring harnesses,
  replacing the parameter harnesses.
- `packages/agents/devops/index.ts`:
  - the four skills build pending actions from validated content;
  - they write via `write_project_file`;
  - the deterministic template path is removed;
  - they fail closed without the harness.
- `packages/agents/devops/mcp-client.ts`: `REQUIRED_TOOLS` gains
  `write_project_file` and loses the four `create_*` tools.
- `packages/mcp/index.ts` (+ tests): delete the four `create_*` tools, and
  move the lint logic to shared.
- `packages/agents/documentation/index.ts` (+ tests): delete templates 5
  and 6 and the harness-off paths that used them.
- `packages/shared/test-runner.ts`: remove `RUNNER_ARGV` (keep
  `detectRunner()`, `buildSanitizedTestEnv()` and the parsers; widen the
  parsers).
- `packages/agents/testing/index.ts` + `llm-harness.ts`: `run-tests` and
  `check-coverage` always use the model's proposal via `run_command`; the
  harness gains the detection hint, the coverage flag and step/background;
  it fails closed when off.
- `packages/mcp/index.ts`: delete the `run_tests` tool.
  `packages/agents/coder/index.ts`: drop `run_tests` from `requiredTools`.
- `apps/supervisor` startup key check, `apps/tui` and the dashboard: only
  the wording that names templates.
- Docs: `CLAUDE.md` (the several sentences describing templates,
  parameter-only DevOps and the deterministic fallbacks);
  `specs/104` A4 marked resolved by this spec; the worklog; this spec's
  `verification.md`.

## Safety and Compatibility Constraints

- **The approval gate is unchanged, and remains the final guarantee.**
  Validation only decides whether a preview may be shown at all.
- **Validation is deterministic and fail-closed.** A validator that can't
  parse the content rejects it; it never guesses "probably fine". The model
  never sees or influences the validator beyond receiving its violation
  messages on retry.
- **Tools stay read-only during authoring** (`READ_ONLY_TOOL_NAMES`
  unchanged). The write happens only after approval, via the path-contained
  `write_project_file`.
- **Execution stays separately gated.** `build-image`, `verify-deployment`
  and running CI are separate approvals, exactly as now. A validated
  Dockerfile is still never built without its own approval.
- **Breaking changes, stated plainly.**
  - DevOps file skills, Documentation's skills, and Testing's `run-tests` /
    `check-coverage` now **require** a working LLM key. There is no
    template fallback.
  - External stdio MCP clients lose the four `create_*` tools and
    `run_tests`. `run_command` remains.
- **Test commands keep every execution guarantee.** The safety of a test
  command never rested on `RUNNER_ARGV` alone: it is the individual,
  `actionId`-bound approval of the exact argv (`specs/080`), plus
  `run_command`'s sanitized env, no-shell execution, cwd containment and
  denylist. All of these apply unchanged. The model proposes; the human
  approves each invocation.
- `specs/110` restart survival: new pending actions keep the same
  `kind: "write"` schema (content plus fingerprint). Rows persisted before
  this change that name a deleted tool fail Zod restore validation and are
  discarded with a warning, as `specs/110` already does for any invalid row.

## Out of Scope / Non-Goals

- Changing `detectRunner()`, or `write-tests`' framework and output-path
  logic.
- Any auto-approve or remembered test command (`specs/080` stays absolute).
- Model-authored files outside these six (e.g. Kubernetes manifests,
  Terraform). A later spec can add a file kind with its own validator.
- An environment override of the allow-lists.
- Running `docker build` or CI as part of validation (that's the separately
  approved `build-image`/`verify-deployment`).

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] `devops-file-validation.ts` accepts realistic good files for bun, node,
      python and go. It rejects each listed violation with a named reason:
      a non-allow-listed image, pipe-to-shell, `ADD <url>`, a literal
      secret, an ungrounded `COPY` source, an unpinned or non-allow-listed
      action, `pull_request_target`, `write-all`, privileged/host/socket
      compose settings, a `.gitignore` missing `.orchestrai/` or
      un-ignoring `.env`. Unit-tested per rule.
- [x] The four authoring harnesses: an invalid first answer gets exactly one
      retry, with the violations in the message; a second failure fails
      closed with the violations named; a refusal reaches no preview.
      Unit-tested with a scripted model.
- [x] Target paths are deterministic in all four skills (asserted).
- [x] DevOps writes these files only via `write_project_file` from
      `resumeTask()`. The four `create_*` tools are gone from the MCP
      server and from DevOps's `REQUIRED_TOOLS`. `grep` finds no remaining
      caller.
- [x] With the harness off or no key, the four DevOps skills and the two
      Documentation skills fail closed with the named error. The startup
      check names the consequence.
- [x] Preflight, fingerprint drift, restart survival and post-write
      `lint_ci_workflow` still work for model-authored files. Existing
      tests are adapted, and none deleted without a replacement.
- [x] Live, against the test fixture and one second project type (e.g. a
      small Python app):
      - `dockerize` previews a project-specific Dockerfile that passes
        validation;
      - `build-image`, approved, actually builds it (if Docker is
        available; otherwise recorded as skipped); **passed on the second run, once Docker was up**;
      - `create-ci`, `create-compose` and `create-gitignore` preview valid
        files;
      - "dockerize on port 4000" shows 4000;
      - the specs/120 release plan still fans out into the grouped review.
- [x] Testing: `RUNNER_ARGV` and the `run_tests` tool are gone, and no
      caller remains (`grep`).
      - `run-tests` / `check-coverage` preview a model-proposed argv, given
        the detection hint and coverage flag, and execute only via
        `run_command` after approval.
      - With the LLM off they fail closed with the named error.
      - Unit-tested with a scripted model.
- [x] Testing parsers: counts and coverage are recognized for bun, jest,
      vitest and pytest output; unrecognized output yields "counts not
      recognized", never a guessed number. Unit-tested with captured
      outputs.
- [x] Live: "run the tests" and "check coverage" on the bun fixture (and on
      the Python scratch fixture) preview a sensible argv. Approved on the
      fixture, they run, and report counts or coverage. Test runs don't
      modify the fixture; confirmed by the hash baseline.
- [x] Live: a request crafted to tempt a violation (e.g. "use the image
      evil/miner:latest") is refused or retried into a valid file, never
      previewed as asked.
- [x] `bun run typecheck` 0 errors; `bun test` no regressions.
- [x] Documentation and worklog are updated, and `specs/104` A4 is marked
      resolved.

## Verification Plan

- Unit:
  - Per-rule validator tests.
  - Authoring-harness retry and fail-closed behavior with a scripted
    model.
  - DevOps pending-action construction with no template tool.
  - MCP tool-list tests updated.
  - Documentation harness-off fails closed.
- Live:
  - An isolated stack (`--only orchestrator,devops-agent`, then
    `documentation-agent`) with a real key.
  - Two fixture projects: the existing bun fixture, plus a scratch Python
    fixture created for the run.
  - The requests above, including the tempting-violation request.
  - Approve at most `build-image` on a scratch copy; reject everything
    else.
  - Confirm the fixtures' hash baselines.

## Approval Requested

Approval authorizes:
- deleting all seven templates (four MCP file tools, two Documentation
  builders, Testing's `RUNNER_ARGV` with the `run_tests` tool);
- the model proposing every test command, each individually approved and
  executed via `run_command`;
- model-authored DevOps files with the deterministic pre-preview validators
  and allow-lists above;
- DevOps gaining `write_project_file` for these four targets;
- fail-closed behavior when the relevant LLM is off.

It does not authorize new file kinds, allow-list overrides, any
auto-approved or remembered command, changes to `detectRunner()`/
`write-tests`, or any change to the approval, preflight or fingerprint
machinery.
