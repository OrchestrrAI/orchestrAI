# Verification — 128 router resolves contextual replies

Date: 2026-09-24. Provider: gemini (fixture's own config). Isolated
headless stack (`--only orchestrator,devops-agent`, ports 5000–5008,
`ORCHESTRAI_PERSIST=0`) against `C:\Users\moham\test-target-project`,
driven through `POST /ask` in one conversation, the same endpoint the
TUI chat uses. Every write-capable task was rejected; no Dockerfile was
created.

## Scenario and results

| Turn | You said | Routed | Text dispatched to the agent |
|---|---|---|---|
| 1 | dockerize my bun app on port 4000 | dockerize | dockerize my bun app on port 4000 |
| 2 | why did that fail? | Tier 0, failure | (answered from state) |
| 3 | yes, try it again | dockerize | dockerize my bun app on port 4000 |
| 4 | yes | dockerize | dockerize my bun app on port 4000 |
| 5 | same thing but for a node app | dockerize | dockerize my node app on port 4000 |

Before this spec, turns 3–5 would have dispatched the raw message
("yes", …) — the exact failure in the original report.

## What the runs changed

1. **First run** (schema + prompt only): turns 3–4 correct; turn 5 became
   "Generate a production-ready Dockerfile configured for port 5050"
   (different turn-5 wording at the time) — a paraphrase that dropped
   "bun". The prompt was tightened to start from the earlier request's
   own words and change only what the new message changes.
2. **Second run**: turn 5 ("same thing but for a node app", deliberately
   different from the prompt's own example) became "dockerize for a node
   app" — port lost. Cause: by turn 5 the 6-turn window no longer
   contained turn 1. Fixed by passing the last dispatched task's full
   text (`lastRequest`, spec item 5).
3. **Third run**: all five turns correct, as tabled above.

Routing and rewriting are LLM judgments; these are observed single runs.

## Automated

- `packages/shared/capability-router.test.ts`: `resolvedRequest` only in
  the system prompt when history exists; schema accepts it and still
  validates without it; `lastRequest` appears only with prior turns and
  before the message to classify.
- `apps/orchestrator/ask-classifier.test.ts`: a non-blank
  `resolvedRequest` is dispatched (tier unchanged), null/undefined/blank
  fall back to the message, Tier 0 ignores it.
- `bun run typecheck` 0 errors; `bun test` 1505 pass / 2 skip / 0 fail.

## Unrelated observation

The fixture showed changes written 21:03–21:09 (`README.md`,
`src/index.ts`, `src/server.test.ts`, `tests/index.test.ts`), before
these runs and from the user's own session; left untouched.
