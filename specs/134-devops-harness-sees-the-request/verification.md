# Verification — 134 DevOps parameter harnesses see the user's request

## What changed (2026-09-25)
- `packages/agents/devops/llm-harness.ts`:
  - `RunHarnessBaseOptions` (and the internal graph options) gain an
    optional `requestText`.
  - `buildHarnessStartMessage()` opens the run with the request between
    `<<<REQUEST` / `REQUEST>>>` markers, capped at
    `MAX_HARNESS_REQUEST_CHARS` (2,000) with `… [truncated]`, then
    "Begin.". With no request (or a blank one), the message is exactly
    "Begin.", as before.
  - `STATED_VALUES_RULE` ("a value the request states explicitly … use
    exactly that value; determine from the project only what the request
    leaves unspecified") is added to the dockerize, create-ci,
    create-gitignore and create-compose system prompts.
- `packages/agents/devops/index.ts`: `prepareWriteActionOrHarness()` passes
  the task text to all four harnesses.
- Unchanged: the Zod output schemas, deterministic target paths,
  templates, preflight, fingerprints, approvals, fail-closed behavior, and
  the run-command harness.

## Automated
- `packages/agents/devops/llm-harness.test.ts` (the fake model now records
  the messages it receives):
  - the start message: absent, blank, delimited, and truncated at the cap;
  - dockerize receives the request and the rule;
  - with no request the message is exactly "Begin.";
  - create-ci, create-gitignore and create-compose each carry the rule and
    the request;
  - an out-of-range port is still rejected by the schema.
- `bun run typecheck` 0 errors; full `bun test` in the commit below.

## Live check
Isolated stack (`--only orchestrator,devops-agent`, `ORCHESTRAI_PERSIST=0`)
against `C:\Users\moham\test-target-project`. The harness was on (the
fixture's config sets `ORCHESTRAI_DEVOPS_LLM_HARNESS=1`; the stack log
shows `llm harness (dockerize): provider gemini …`).

| Request | Preview parameters |
|---|---|
| "dockerize my bun app on port 4000", run 1 | `app_type: bun, port: 4000` |
| same, run 2 | `port: 4000` |
| same, run 3 | `port: 4000` |
| "dockerize my bun app" (no port) | `port: 3000`. The fixture declares no port, so this is the model's project-based choice, unchanged |
| "create a docker compose file for my bun app on port 4500" | service `test-target-project`, `port: 4500` |

Before this spec, spec 130 phase 1 recorded "dockerize my bun app on port
4000" previewing `port: 3000`. Target paths (`output_path`, `app_name`)
were deterministic in every run. All 5 approvals were rejected, and the
fixture's SHA-256 snapshot matched afterwards.

## Limits (as the spec accepted)
Honoring stated values is a model judgment, steered by the prompt rule, not
a structural guarantee. It held in 3/3 runs plus the compose run. If it
ever regresses, the deterministic override named in the spec's non-goals is
the next step.
