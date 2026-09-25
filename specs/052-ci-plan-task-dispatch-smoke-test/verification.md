## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`ci.yml`'s own final step (`specs/052-ci-plan-task-dispatch-smoke-test/
spec.md`, implemented) starts a real `devops-agent`+`orchestrator` stack
via `bun run` and submits two real requests — `suggest-agents` and
`plan-task` — asserting only the *synchronous* half of each response
(`assignedAgent`/`status`), never a real provider call. This exists
because `bun test` alone missed a real regression on 2026-09-05:
`dispatchRootTask()` briefly required a registry lookup that only a real
agent (or a hand-built test fixture standing in for one) could satisfy,
and every test in `supervisor-wiring.test.ts` manufactured exactly that
fixture, so `plan-task` was completely unreachable in the real running
system while `bun test` stayed green. The env var
`ORCHESTRAI_LLM_API_KEY` this step sets is deliberately non-functional —
plan-task's initial dispatch response returns before its real LLM call
is even awaited, so no real credential or provider call is ever needed
to prove the dispatch path itself is intact.
