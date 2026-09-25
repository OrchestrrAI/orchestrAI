---
id: 001-testing-agent
title: Testing Agent
area: testing-agent
change_type: feature
status: implemented
verification: partial
created: 2026-08-07
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-07
implemented_on: 2026-08-07
amends: []
supersedes: []
superseded_by: []
related:
  - 011-remaining-agents-mcp
  - 015-routing-planning-polish-2
  - 006-runtime-stabilization
---

# Spec: Testing Agent

> Historical baseline: the Testing Agent exists, but later specs moved test
> execution behind MCP and made every detected runner Tier 1 approval-gated.
> See `remaining-agents-mcp` and `runtime-stabilization` in the catalog.
> Original unchecked manual criteria remain recorded below, so verification is
> classified as `partial` rather than silently inferred.

## Purpose

Runs test suites for a target project and reports pass/fail results. Slots into
the existing multi-agent plan execution as the `run-tests` skill, which the
Orchestrator already tries to dispatch (see `plan_execution.md` — step 4 currently
fails with "No agent for skill: run-tests" because this agent doesn't exist yet).

## Position in the System

```
Orchestrator (:3000)
        ↓ A2A
Testing Agent (:3003)   ← NEW
        ↓ Bun.spawn (no MCP — same pattern as DevOps Agent's git-status)
   bun test / npm test / pytest (target project)
```

Same architectural pattern as `packages/agents/devops/index.ts` and
`packages/agents/planning/index.ts`: standalone Hono app, in-memory task Map,
Agent Card at `/.well-known/agent.json`, browser dashboard.

## Agent Card

```json
{
  "name": "testing-agent",
  "description": "Runs test suites and reports results before deployment",
  "url": "http://localhost:3003",
  "version": "1.0.0",
  "skills": [
    {
      "id": "run-tests",
      "name": "Run Tests",
      "description": "Detect and run the project's test suite, report pass/fail",
      "examples": ["run tests for bun project at C:\\path\\to\\project"]
    },
    {
      "id": "check-coverage",
      "name": "Check Coverage",
      "description": "Run tests with coverage reporting if the runner supports it",
      "examples": ["check test coverage at C:\\path\\to\\project"]
    }
  ]
}
```

## Input

Task text following the same free-text + path-extraction convention as the
DevOps Agent (`extractPath()` helper — reuse the same regex):

```
"run tests for bun project at C:\Users\moham\devops-mcp-server"
"check test coverage at C:\Users\moham\devops-mcp-server"
```

## Runner Detection

In order of priority, inspect the target path:

1. `package.json` exists AND has a `"test"` script → use `bun test` (or the
   script's declared runner if it's not bun — but default to `bun test` since
   this whole project is Bun-based)
2. `requirements.txt` or `pyproject.toml` exists → use `pytest`
3. Neither found → return `"No tests configured for this project"` as a
   **successful** result (not an error) — this must NOT block plan execution

## Output Format

```
=== Test Results ===
Project: <path>
Runner: bun test

Passed: 4
Failed: 0
Duration: 1.2s

<raw test runner output, truncated to reasonable length>
```

If no tests configured:
```
=== Test Results ===
Project: <path>
No tests configured — no package.json test script, pytest, or test files found.
```

## Behavior Rules

- **Read-only, no human approval required** — running tests doesn't write files,
  same tier as `analyze-project` and `git-status` in the DevOps Agent (i.e. NOT
  added to any `NEEDS_APPROVAL` set)
- **Must not throw on test failures** — a failing test suite is a valid
  completed result (`status: "completed"`) with failure details in the text,
  not a `status: "failed"` task. Task-level `failed` is reserved for actual
  execution errors (bad path, runner crashed to start, etc.)
- Follow the exact Windows-safety rules from CLAUDE.md: use `Bun.spawn()` for
  the test runner (matches `skillGitStatus` pattern in the DevOps Agent),
  never `exec()` with a shell string
- Default port: **3003** (already reserved in CLAUDE.md's ports table)
- Reuse the `detectSkill()` / task processor / dashboard structure from
  `packages/agents/devops/index.ts` — don't reinvent the pattern, copy and
  adapt it

## File Location

```
packages/agents/testing/
├── package.json     ← @orchestrai/agent-testing, depends on hono
└── index.ts
```

## Integration Points

1. Add `"http://localhost:3003"` to the Orchestrator's `KNOWN_AGENTS` array in
   `apps/orchestrator/index.ts` so it's auto-discovered like the other two agents
2. No changes needed to `parsePlanText()` or `dispatchPlanStep()` — they already
   look up agents generically by skill id via `findAgentForSkill()`

## Acceptance Criteria

- [ ] `GET http://localhost:3003/.well-known/agent.json` returns the Agent Card above
- [ ] `GET http://localhost:3003/dashboard` renders (same visual style as DevOps/Planning dashboards)
- [ ] Orchestrator auto-discovers testing-agent on startup (check console log)
- [ ] Sending `"run tests for bun project at C:\Users\moham\devops-mcp-server"` directly
      to `POST http://localhost:3003/` completes without requiring approval
- [ ] Re-running the full plan from `plan_execution.md`
      (`"build and deploy my bun app at C:\Users\moham\devops-mcp-server"`)
      now dispatches step 4 `[run-tests]` to testing-agent instead of skipping it
- [ ] A project with no test script returns a completed (not failed) result
      saying tests aren't configured
- [ ] No shell string execution anywhere in the new file — `Bun.spawn()` only

## Explicitly Out of Scope

- Coverage percentage parsing/formatting beyond raw runner output (nice-to-have, not required)
- Support for test runners other than bun test / pytest
- Persisting test history across restarts (in-memory Map is fine, same as other agents)
