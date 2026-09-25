# specs/138 — verification

## Result

Implemented and verified. `build-image` was first skipped (Docker daemon
down), then run once Docker was up: an approved, model-authored Dockerfile
on the bun scratch copy built successfully with a real `docker build`. `pytest --cov` on the Python scratch project
could not produce coverage because pytest-cov isn't installed in this
environment — the run itself went through the gate and was reported honestly.

## Automated

- `packages/shared/devops-file-validation.test.ts` — 32 tests, one or more per
  rule (images, pipe-to-shell, `ADD <url>`, literal secrets, ungrounded `COPY`,
  unpinned/non-allow-listed actions, `pull_request_target`, `write-all`,
  privileged/host/socket compose, `.gitignore` missing `.orchestrai/` or
  un-ignoring `.env`), plus good files for bun, node, python and go.
- `packages/agents/devops/llm-harness.test.ts` — authoring harness: one retry
  carrying the violations, a second failure fails closed naming them, a
  refusal reaches no preview.
- `packages/mcp/index.test.ts` — the four `create_*` tools and `run_tests` are
  absent; `run_command` keeps a non-zero exit's full output plus
  `[exit code N]`.
- `packages/shared/test-runner.test.ts` — counts/coverage parsers on captured
  bun, jest, vitest, pytest and go output; unrecognized output yields `null`.
- Testing and skill-ownership tests: model-proposed argv, explicit
  `run command:` wins, harness off fails closed naming specs/138.
- `grep` finds no remaining caller of `RUNNER_ARGV`, `run_tests` or any
  `create_*` tool (the `analyze_project` suggestions that still named the
  deleted tools were reworded to name the DevOps skills).
- `bun run typecheck` 0 errors; `bun test` (with `ORCHESTRAI_MCP_PORT=5999`)
  1631 pass / 2 skip / 0 fail.

## Live (isolated stack on 5000–5008; scratch copies of the fixture)

- `dockerize`, `create-ci`, `create-compose` and `create-gitignore` each
  previewed a project-specific file that passed validation, for the bun
  fixture and a small Python app. The Python compose file added Redis because
  `requirements.txt` needs it.
- "dockerize on port 4000" previewed port 4000.
- A request for `evil/miner:latest` was previewed as the allow-listed
  `oven/bun:1-alpine`, never as asked.
- `generate-readme` previewed a model-authored README grounded in the real
  files (rejected).
- `run-tests` on bun proposed `bun test` and, once approved, completed with
  5 passed / 1 failed. On Python it proposed `pytest` and completed with 2/0.
  `check-coverage` on bun proposed `bun test --coverage` → 100%.
- The specs/120 release plan still fans out: `dockerize` and `create-ci`
  were both `input-required` at once and `pending-batch` reported
  `eligible: true`.
- Everything pending was rejected; the fixture hash baseline is unchanged.

## Found and fixed during live verification

- A failing test suite was reported as a *failed* task and pytest's stdout was
  lost: `run_command` returned only stderr on a non-zero exit. It now returns
  stdout+stderr plus `[exit code N]`, and Testing treats that as a completed
  run that reports its failures ("Exit: non-zero …"). A timeout, a refusal or
  a missing executable still fails the task.

## Found and later fixed

- A plan request naming a path as "… for `<abs path>`: …" previewed writes
  into `ORCHESTRAI_PROJECT_PATH`. First attributed to specs/137. On
  inspection the cause is the target-path resolver, which recognizes a path
  only after at/in/to/from and never after "for". The plan steps did carry
  the full request. Fixed by specs/140.
