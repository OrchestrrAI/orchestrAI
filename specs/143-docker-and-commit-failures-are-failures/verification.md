# specs/143 — verification

## Result

Implemented on branch `fix/143-docker-commit-failures`, 2026-09-25.

## What changed

- `packages/mcp/index.ts`:
  - New `execOrFail()`: same allow-list and no-shell boundary as
    `safeExec()`, but a non-zero exit throws with stdout+stderr plus
    `[exit code N]`, and a timeout throws a named error.
  - New `execToolResult()` turns that into an MCP `isError` result.
  - `docker_build` and `git_commit` (both the add and the commit) use it.
    `git_commit`'s "path not found" and "not a git repo" are now errors too.
  - `docker_run`: a failed `docker run` is an error ("could not be
    started"), and a container that didn't stay up returns its `❌` report
    as `isError`.
  - The read-only status calls keep `safeExec()`.
- `packages/agents/devops/index.ts`: `defaultImageName()` lowercases the
  folder name and replaces disallowed characters (fallback `app`).
  `extractImageTag()` uses it, and an explicit `image_tag:` is untouched.
- `scripts/ag-ui-demo.ts`: the specs/142 workarounds are removed. Copies
  are named by `mkdtemp` again (random capitals), and step 7 trusts the
  task status.

## Automated

- `packages/mcp/index.test.ts`:
  - `git_commit`: nothing to commit → `isError` with `[exit code N]`; not a
    repo → `isError`; a real commit → not an error.
  - With Docker running (they did run, 0 skipped): a broken Dockerfile →
    `docker_build` `isError` with the exit code; a container that exits at
    once → `docker_run` `isError` with `❌`; an invalid (capitalized)
    reference → `isError` "could not be started".
- `packages/agents/devops/index.test.ts`: `MyApp` → `myapp`,
  `orchestrai-demo-real-i8HBOh` → `orchestrai-demo-real-i8hboh`,
  `My App!` → `my-app`, `___` → `app`; an explicit `image_tag` is kept.
- 62/62 in those two files; typecheck 0; full suite recorded below.

## Live (isolated stack 5000–5008)

- Folder `GoodCaps143`: `build-image` → tag `goodcaps143:latest`,
  completed. `verify-deployment` → completed, ✅ the container stayed
  running.
- Folder `BrokenCaps143` (`RUN exit 3`): `build-image` → **failed**. The
  error carries Docker's output ("exit code: 3") and `[exit code N]`.
- The plan "build … and then make sure the container starts" on the
  broken folder:
  - the build step failed and **no start step was dispatched**;
  - the plan failed with "reconciliation required" (specs/028
    `failed-ambiguous`).
- The same request through `/ask`, then "what did we just do? did it
  work?". The recap answered **"No, it did not work … the build-image
  tasks … failed."** Before this fix, it claimed the image was built and
  verified.

## Found, confirmed, and fixed here (item 5)

The first real story on this branch failed at step 7, honestly. The
build-image task ended `failed` with `MCP error -32000: Connection closed`
after 10,061 ms. Docker hadn't failed: the image
(`orchestrai-demo-real-jwnd4h:latest`) existed afterwards, so the build
finished while the agent's connection was dropped. The MCP server stayed
healthy the whole time.

**How it was confirmed:**
1. A direct 24 s `docker_build` over MCP HTTP succeeded, and a 27 s build
   through the DevOps agent succeeded. So the server and HTTP layer were
   fine, and the failure was intermittent.
2. A deterministic probe with the real `OrchestraiMcpClient` against a
   real HTTP MCP server:
   - a 1.5 s tool call was started;
   - after 200 ms, a failed ping was forced (`pingReady(1)`);
   - the ping returned false and the state went to `connecting`;
   - **the in-flight call rejected with `MCP error -32000: Connection
     closed`**, the exact live error.
3. A normal ping during a call took 4 ms and succeeded. So the trigger is
   a ping that's slow under load (the live run: a real base-image pull
   plus `bun install`, with the Orchestrator's 10 s health checks hitting
   `/healthz`; the failure landed at 10.06 s). The old 500 ms limit is
   easy to exceed on a loaded Windows machine.

**The fix** (`packages/shared/mcp-client.ts`):
- an in-flight call count;
- a failed ping with calls in flight keeps the connection and only
  reports not-ready;
- a failed ping while idle still reconnects;
- both cases log a warning;
- the ping timeout is now 2 s.

**Regression tests:** `packages/shared/mcp-client-ping.test.ts`, 3 tests.
On the old code the in-flight test fails with the exact live error; on the
new code all 3 pass. All five MCP agents' `/healthz` use this client, so
the fix covers every agent.

## Real story on this branch

A re-run of `demo:ag-ui --groups real --allow-writes` passed 9/9 on a
mixed-case copy (`orchestrai-demo-real-BHm8ik`):
- `build-image` completed with tag `orchestrai-demo-real-bhm8ik:latest`;
- `verify-deployment` completed with ✅.

This time step 7 passed on the task status alone, with no text-sniffing
workaround. The test images were removed afterwards.

A final real story on the complete fix (restarted stack): **9/9 passed** on
`orchestrai-demo-real-U0B1qH`, with no "MCP ping failed" warning in the
stack log. The demo images were removed afterwards.
