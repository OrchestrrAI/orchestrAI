---
id: 143-docker-and-commit-failures-are-failures
title: Failed Docker Builds, Runs and Commits Fail Their Task; Image Tags Are Lowercase; Health Pings Never Kill Work
area: devops-agent
change_type: fix
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 079-phase-a-connect-orphaned-tools
supersedes: []
superseded_by: []
related:
  - 028-orchestrator-langgraph-supervisor
  - 138-model-authored-files-replace-templates
  - 142-demo-rehearsal-more-scenarios
---

# Spec: Failed Docker Builds, Runs and Commits Fail Their Task; Image Tags Are Lowercase; Health Pings Never Kill Work

> Approved by Muhamad-Yussuf on 2026-09-25.

## Purpose

Found live by the specs/142 real story. The user asked to build and start
the image; both steps failed in Docker, but both tasks ended `completed`.
So the plan reported success, and the chat recap told the user the image
was built and verified. **That's false**, and it's the worst kind of error
for a tool whose selling point is honest reporting.

## Verified Current State

- `safeExec()` (`packages/mcp/index.ts`) catches every non-zero exit and
  **returns** the error text as ordinary output. Callers can't tell
  "ran and failed" from "ran and succeeded".
- `docker_build` returns that text as a normal (non-error) tool result, so
  the DevOps agent marks `build-image` `completed`.
- `docker_run` builds a report that starts `❌ … did not stay running`, but
  also returns it as a normal result, so `verify-deployment` is
  `completed`.
- `git_commit` goes through `safeExec` the same way, so a failed commit
  would also report success.
- `extractImageTag()` (`packages/agents/devops/index.ts`) defaults the tag
  to `<project folder name>:latest` unchanged. Docker requires lowercase
  repository names, so a folder like `MyApp` (or the demo's random temp
  suffix) always fails: `invalid tag … repository name must be lowercase`.
- Downstream: the supervisor classifies outcomes from task status
  (specs/028). A write-capable skill that really failed but reports
  `completed` is never treated as `failed-ambiguous`, so the run continues
  and the recap is wrong.

## Proposed Behavior

1. **A failed execution is an error result.** Add `execOrFail()` beside
   `safeExec()`: same allow-list and no-shell boundary, but on a non-zero
   exit it throws with the combined stdout+stderr plus `[exit code N]` (the
   specs/138 `run_command` shape). Use it for:
   - `docker_build` (the build);
   - `docker_run`'s `docker run` step;
   - `git_commit`.
   Each tool returns `isError: true` with that text.
2. **`docker_run` fails when the container didn't stay up.** A `❌`
   report is returned with `isError: true`, and the report text is kept
   whole so the user still sees why.
3. **The DevOps agent fails the task.** `resumeTask()` already fails a
   task when its MCP call throws, so `build-image`, `verify-deployment`
   and `commit-changes` end `failed` with the real output. The supervisor
   then sees `failed-ambiguous` (write-capable, specs/028), ends the run,
   and the recap is built from real failures.
4. **Valid default image tags.** The default tag is the folder name
   lowercased, with any character Docker disallows replaced by `-`, and
   leading or trailing separators trimmed; empty falls back to `app`. An
   explicit `image_tag: name:tag` in the request is used as given (Docker
   still validates it, and now a failure is reported honestly).

5. **A health ping never kills work in flight.** *(Added 2026-09-25 at
   Yusuf's instruction, "check the timeout issue first and solve it in 143
   if it is real", after the mechanism was confirmed. See
   verification.md.)* `OrchestraiMcpClient.pingReady()`
   (`packages/shared/mcp-client.ts`, used by every MCP agent's `/healthz`)
   closed the client on any ping failure, which killed tool calls in
   flight ("MCP error -32000: Connection closed") even when the server
   finished the work. Now:
   - the client counts its in-flight calls, and a failed ping with calls
     in flight only reports not-ready, keeping the connection;
   - a failed ping with nothing in flight still reconnects, as before;
   - both cases log a warning, never silently;
   - the ping timeout rises from 500 ms to 2 s (inside the Orchestrator's
     3 s health-check timeout).

## Scope

`packages/mcp/index.ts` (`execOrFail`, three tools), `packages/shared/mcp-client.ts` (`pingReady`, in-flight count), `packages/agents/devops/index.ts`
(`extractImageTag`), tests, `CLAUDE.md`, worklog. Afterwards
`scripts/ag-ui-demo.ts` can drop its specs/142 text-sniffing workaround
for step 7 (kept only as long as this spec is unimplemented).

## Safety and Compatibility Constraints

- Same allow-list, no shell, same timeouts.
- The read-only callers (`git status/branch/log`, `docker ps/images`, the
  status check inside `docker_run`) keep `safeExec()`. Their text is
  informational, and a failure there is already visible in the report.
- Nothing about approval changes. A failure after approval was already
  possible; now it's reported as one.

## Out of Scope / Non-Goals

- Retrying a failed build.
- Changing `docker_run`'s fixed lifecycle policy.
- An audit of every `safeExec()` caller beyond the three named tools.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] Unit: `execOrFail` throws with output plus `[exit code N]` on a
      non-zero exit and returns output on success; the three tools return
      `isError` on failure; `docker_run` returns `isError` when the
      container didn't stay running.
- [x] Unit: default tags — `MyApp` → `myapp:latest`,
      `orchestrai-demo-real-i8HBOh` →
      `orchestrai-demo-real-i8hboh:latest`, `My App!` →
      `my-app:latest`, an explicit `image_tag:` is untouched.
- [x] Live: in a folder with capitals, `build-image` builds and
      `verify-deployment` starts the container. A deliberately broken
      Dockerfile makes `build-image` end `failed` with Docker's output, and
      a plan containing it stops there. Its recap doesn't claim success.
- [x] Unit (item 5): a failed ping during a call keeps the connection and
      the call completes; a failed ping with nothing in flight reconnects
      and logs; a normal ping during a call succeeds. The first test fails
      on the old code with the exact live error.
- [x] typecheck 0; `bun test` no regressions; `CLAUDE.md` and worklog
      updated.
