# Verification — 126 write-tests description-grounded routing

Date: 2026-09-24. Provider: gemini (from the fixture's own
`.orchestrai/config.env`). Target: `C:\Users\moham\test-target-project`.

## Setup

An isolated, headless stack running this branch's code, so the user's
own already-running stack (installed binary, default ports 3000–3008)
was never touched:

```
ORCHESTRAI_PERSIST=0 ORCHESTRAI_<SERVICE>_PORT=50xx \
  bun run orchestrai --only orchestrator,testing-agent,devops-agent \
  --project C:\Users\moham\test-target-project --headless
```

`ORCHESTRAI_PERSIST=0` kept this run out of the fixture's shared
`orchestrai.db`. Every write-capable step was **rejected**; the fixture's
`src/` was listed after each run and still held only `config.ts`,
`index.ts` and `server.ts`.

## Live results

1. **Vague request, first wording.** `POST /tasks` "can you create the test
   cases for that project ?" → `skill: plan-task` (previously routed
   straight to `write-tests` and failed with "No source file named").
   The planner's first step was `run-command` with argv `["git",
   "ls-files"]` (to list files) — correct but an extra approval. Approved
   (read-only listing on the fixture); the next step was `write-tests`
   with child text `write-tests: write tests for src/server.ts — …`,
   which reached `input-required` with a real preview targeting
   `src/server.test.ts`. Rejected; nothing written.
2. **Wording refined** (still within this spec's scope — description
   text only): the supervisor description now says to choose files from
   the read-only inspection it already has, or `analyze-project`, and
   never to use `run-command` just to list files.
3. **Vague request, refined wording.** Same prompt → `plan-task`; the
   first and only step was `write-tests` with child text `write-tests:
   write tests for src/server.ts — …`, reaching `input-required` with the
   target `src/server.test.ts`. No `run-command` step. Rejected; nothing
   written.
4. **Named request (regression).** "write tests for src/server.ts" →
   `skill: write-tests`, `assignedAgent: testing-agent`, `isPlan: false`,
   reached `input-required`. Rejected; nothing written.

Routing is an LLM judgment; these are observed results from single runs,
not a guarantee for every phrasing.

## Automated

- `bun run typecheck` — 0 errors.
- `packages/agents/testing/index.test.ts`: new test — the `write-tests`
  card description is ≤ `MAX_SKILL_DESCRIPTION_BYTES` (283 of 300 bytes)
  and states its one-named-file scope.
- `apps/orchestrator/supervisor-graph.test.ts`: new test — the system
  prompt carries `SKILL_DESCRIPTIONS["write-tests"]`, including the
  name-the-file and one-step-per-file instructions.
- `bun test` full suite with `ORCHESTRAI_MCP_PORT=5999` — 1490 pass, 2
  skip, 0 fail. Without that override, one pre-existing test
  (`packages/agents/devops/index.test.ts`, "analyze-project — reaches a
  terminal state gracefully with no live MCP server") fails only because
  the user's own stack was listening on the default MCP port 3006; it
  passes with the port pointed elsewhere, and this spec changed no DevOps
  file.

## Observed, out of scope

The previewed `src/server.test.ts` imported `app` from `"../src/server"`.
First flagged here as a likely broken path; re-checked and that was
wrong: from `src/`, `../` is the project root, so it resolves to
`src/server.ts`, which does `export default app`. The import is correct,
just a roundabout form of `"./server"`. No issue.
