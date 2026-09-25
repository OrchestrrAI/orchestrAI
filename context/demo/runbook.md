# OrchestrAI — Demo Runbook

Every scenario below has been actually exercised live, most recently
against `C:\Users\moham\test-target-project` (a committed, reusable fixture
project — see below), through 2026-08-09, with sections 0/1/2/4/7 re-verified
against current `main` on 2026-08-20 (see `context/worklog.md` for the
exact dated verification entries for each item). Use this as a **rehearsal
checklist** — check boxes as you dry-run, uncheck for the next rehearsal.

> **Presenting to judges?** Use `context/demo/judge-script.md` instead —
> a timed 5-minute narrative with the exact prompts, what to say, expected
> outputs, likely questions, and fallbacks. This file is the broader
> rehearsal surface behind it.

Companion reference: `context/demo/protocol-cheat-sheet.html` — open it
alongside the terminal to narrate which mechanism (A2A-style, direct A2A,
MCP, internal-only, or — as of `specs/020-semantic-intent-fallback/spec.md` —
the local semantic classifier that only runs when no keyword matches)
fires at each step. Its section 02 ("Routing: keyword match, then a local
classifier") and one action-table row were added for that feature; the
rest predates the supervisor/TUI/binary work below and still accurately
covers the Orchestrator/agent/MCP protocol layer itself, which hasn't
changed.

## 0. Pre-flight (do this before every dry run and before judging)

- [ ] `git status` in **this** repo — confirm no leftover write-demo
      artifacts (a stray `Dockerfile`, `.github/`, or a modified
      `.gitignore` — these come from accidentally running a write demo
      against the real repo instead of the fixture project).
- [ ] Reset the fixture project to a clean state (safe to do every time —
      it's a disposable target, not this repo):
      ```powershell
      cd C:\Users\moham\test-target-project
      git checkout -- .
      git clean -fd
      cd C:\Users\moham\devops-mcp-server
      ```
- [ ] Set the target for the session:
      ```powershell
      $env:ORCHESTRAI_PROJECT_PATH = 'C:\Users\moham\test-target-project'
      ```
- [ ] Start the stack — three interchangeable options, pick based on what
      you want to show:
      - `bun run dev` — simplest, no lifecycle guarantees, all logs
        interleaved with no prefix.
      - `bun run orchestrai` — port preflight, ordered startup, prefixed
        logs, a startup summary, and (in a real terminal) the TUI opens
        automatically once everything's healthy.
      - `.\dist\bin\orchestrai.exe` (after `bun run build`, or downloaded
        from the repo's **Releases** page) — the standalone-binary story:
        no Bun, no source tree needed on the machine running it. Same
        auto-opening TUI behavior as `bun run orchestrai`.
- [ ] `curl http://localhost:3006/healthz` → `"status":"ok"`
- [ ] `curl http://localhost:3002/healthz` → `"ready":true`,
      `"dependencies":{"mcp":{"state":"connected", ...}}`
- [ ] All 6 remaining `/healthz` endpoints (3000, 3001, 3003, 3004, 3005)
      return `"status":"ok"`.
- [ ] Open `http://localhost:3000/dashboard` and confirm all 5 agents are
      listed under "Registered Agents".

### Automated AG-UI rehearsal (safe default)

From a second PowerShell/terminal after pre-flight succeeds:

```powershell
bun run demo:ag-ui -- --project C:\Users\moham\test-target-project
```

The runner performs its own health checks and then verifies six explicit,
state-driven scenarios: `git-status` MCP lifecycle, `analyze-project` MCP plus
Security A2A, a rejected write approval, a multi-step plan whose write child
is rejected, semantic fallback, and two distinct caller-minted correlation
IDs. It prints a unique raw NDJSON capture path under the OS temporary
directory at start and finish. The default mode never approves a write and
fails if the target working-tree fingerprint changes.

The optional write demonstration must be deliberate and must target a
disposable project outside this repository:

```powershell
bun run demo:ag-ui -- --project C:\Users\moham\test-target-project --allow-writes
```

It prints the exact target and whether `.gitignore` existed, approves only
that deterministic fixture action, and never resets or deletes it. Inspect
and clean the fixture manually afterward.

## 1. Tier 2 — autonomous reads (no approval, watch the terminal audit lines)

All typed into the Orchestrator's Send Task box unless noted.

- [ ] `git status` → completes immediately, shows branch/status.
      **Terminal tell:** one `"kind":"mcp-tool-call"` audit line,
      `"target":"git_status"`.
- [ ] `analyze my project` → completes immediately, combined result section
      labeled `=== DevOps MCP Analysis ===` then
      `=== Security Agent Secrets Pre-check ===`. Against the fixture, this
      finds 7 real (fake, fixture-only) secrets in `src/config.ts` and
      flags the missing Dockerfile/CI/README — a genuinely rich single-call
      demo. **Terminal tell:** two audit lines — `"kind":"mcp-tool-call"`
      then `"kind":"a2a-call"`, same `taskId`. This is the one action that
      hits all three mechanisms; see the cheat sheet's sequence diagram.
- [ ] `what agents do I need to deploy my app?` → Planning Agent's
      `suggest-agents` list.
- [ ] Direct to Security dashboard (`:3005`): `scan for secrets` (or now
      also just `scan`, `security check my project` — Security's own
      keyword detection was broadened this session, see
      `specs/013-security-skill-detection/spec.md`) → finds and redacts all 7
      fake secrets in the fixture, never prints the real value.
- [ ] Direct to Security dashboard: `check gitignore coverage` → the
      fixture's `.gitignore` covers `node_modules`/`dist/` but not
      `.env`/`.env.*`/`*.key`/`*.pem`/`build/` — shows the exact split, plus
      a CRITICAL warning that `.env` exists and isn't ignored.
- [ ] Direct to Security dashboard: `audit dependencies` → flags exactly
      `chalk: "*"` and `dayjs: "latest"`, not the properly-pinned `zod`/
      `hono`/`typescript`.
- [ ] Direct to Documentation dashboard (`:3004`): `document the API at
      C:/Users/moham/test-target-project/src/server.ts` (forward slashes —
      avoids a JSON-escaping headache with backslashes in curl/PowerShell)
      → extracts all 5 real Hono routes, **no approval prompt** — confirm
      this stays read-only. (`src/index.ts` has no HTTP routes, so pointing
      at it correctly reports none — that's real behavior, not a bug, if
      you want to show the distinction live.)

## 2. Tier 1 — approval-gated writes (the core "informed approval" story)

For each: **before** clicking Approve, point at the displayed target path
and parameters — that's the point of the demo. Confirm the file does not
exist yet.

- [ ] `dockerize bun app on port 4000` → `input-required`, shows
      `Tool: create_dockerfile`, resolved target, and exact parameters.
      Approve → `Dockerfile` appears with `EXPOSE 4000`. Confirm it did
      **not** exist before approval.
- [ ] `create ci pipeline for bun` → approve → `.github/workflows/ci.yml`
      appears.
- [ ] `create gitignore for bun` → **reject this one instead** → confirm no
      change to the existing `.gitignore`. This is the "rejection actually
      means nothing happens" beat.
- [ ] `create docker compose for bun on port 5050` → approve →
      `docker-compose.yml` appears referencing the same app name the
      Dockerfile above used.
- [ ] Direct to Documentation dashboard: `generate a readme for my project`
      → approve → `README.md` appears, pulled from the fixture's real
      `package.json` (name, description, scripts).

## 3. Testing Agent — Tier 1 command execution

- [ ] Direct to Testing dashboard (`:3003`): `run tests for my project` →
      `input-required`, shows the **exact** argv (`["bun","test"]`), the
      resolved cwd, and an explicit risk warning that approval doesn't make
      the test code safe. Approve → runs the fixture's real 4 passing
      tests, reports pass/fail counts.
- [ ] `check test coverage` → same flow, `["bun","test","--coverage"]`.
- [ ] **The "why this matters" beat:** add a test to the fixture that
      writes a marker file (`writeFileSync("mutation-marker.txt", "x")`
      inside a `test()` block), submit `run tests for my project`, and
      **reject** it. Show `mutation-marker.txt` does not exist. Then
      re-submit and **approve** — show the marker file now exists. Proves
      the approval gate is real, not decorative. Reset the fixture
      afterward (see step 0).

## 4. Multi-step plans (Planning Agent + sequential Orchestrator dispatch)

- [ ] `setup my project from scratch` (or `set up my project from scratch`
      — both the one-word and two-word forms route to Planning as of this
      session) → 3-step plan (`analyze-project → git-status →
      create-gitignore`), dispatched and watched sequentially; approve the
      gitignore step when it pauses.
- [ ] `build and deploy my bun app` → 4-step plan (`analyze-project →
      dockerize → create-ci → run-tests`); this plan's step count is locked
      by a regression test — if it's ever not exactly 4 steps, that's a
      real regression, not a wording change. Live-verified again this
      session against the fixture: `analyze-project` completed, `dockerize`
      correctly paused on approval, the rest queued sequentially.
- [ ] `prepare a complete project with docs and security` → 3-step plan
      (`analyze-project → scan-secrets → generate-readme`). **Say this
      exactly:** "Notice it only added the steps its own keywords matched —
      security and docs — not every possible step."
- [ ] **New this session:** `run tests on my project` typed directly into
      the **Orchestrator** (not a specific agent's dashboard) now routes
      straight to Testing — `"coverage"`/`"run test(s)"`/`"test suite"` are
      now direct Orchestrator triggers, closing the one gap where Testing
      was previously unreachable except via its own dashboard or a
      Planning-generated step.
- [ ] If you want a plan touching *every* skill in one shot: `build,
      deploy, test, document, and secure my bun app`.

## 5. The terminal UI (`apps/tui`) — an alternative to the browser dashboards

- [ ] With the stack started via `bun run orchestrai` (not `bun run dev`)
      in a real terminal, the TUI opens automatically once startup
      finishes — no separate command needed.
- [ ] `Tab` switches focus between the Agents and Tasks panes; `↑`/`↓`
      selects within whichever is focused.
- [ ] On the Agents pane: `Enter` opens an agent's full detail (URL, live
      status, complete skill list); `f` filters the Tasks pane to that
      agent's tasks (press again to clear, or `Esc`).
- [ ] With a filter active, `n` opens a new-task box that submits **directly
      to that agent**, bypassing Orchestrator routing on purpose — point
      out the row markers once it shows up in the Tasks pane: `→` (this
      TUI's own direct submission) vs. `⇄` (another agent's own A2A call,
      e.g. DevOps's `analyze-project` triggering a Security pre-check) vs.
      `◆` (that agent's own browser dashboard) — three different origins,
      never rendered identically.
- [ ] On the Tasks pane: `a`/`r` approve/reject an `input-required` task
      (press twice within 1.5s to confirm — a single press just shows a
      hint, doesn't act).
- [ ] Start a multi-step plan: the selected parent row shows a compact `▸N`
      active-step indicator, while Enter opens the bounded Detail list with
      completed/failed/running step markers alongside live tool calls.
- [ ] Keep the TUI open through an AG-UI disconnect/reconnect and confirm the
      display has no diagnostic-log lines or cursor/redraw garbling; task
      polling continues while the live stream retries silently.
- [ ] `?` opens a full keyboard-reference overlay at any time.
- [ ] `Ctrl+C` stops the TUI and every backend service together, cleanly.

## 6. The standalone binary and CI/CD

- [ ] `bun run build` → one ~106 MB executable, `dist/bin/orchestrai.exe`.
      Run it exactly like `bun run orchestrai` — same subcommands
      (`service <name>`, `tui`, `--only`, `--project`), no Bun required to
      run it once built.
- [ ] `.\dist\bin\orchestrai.exe --project "C:\Users\moham\test-target-project"`
      — shows the project-path resolution chain in the startup log
      (`--project` > env var > `orchestrai.project.txt` next to the binary
      > current directory).
- [ ] Point at the repo's **Actions** tab: `build-binaries.yml` builds
      Windows and Linux binaries natively (not cross-compiled — the Linux
      leg genuinely executes and smoke-tests its own output) on every push
      to `main`, and publishes both to a rolling **`latest` Release** — a
      stable, permanent, no-login-required-for-a-public-repo download link,
      not an expiring workflow artifact.

## 7. Adversarial / safety demonstrations (the "we hardened this" story)

- [ ] Malformed input: `curl -X POST http://localhost:3002/ -H
      "Content-Type: application/json" -d '{"id":"bad-1","message":{"role":
      "user"}}'` (missing `parts`) → HTTP 400, **not** a crash. Follow with
      `curl http://localhost:3000/healthz` to show the whole stack is still
      up.
- [ ] Duplicate task ID: submit the same `id` twice to any agent → second
      submission returns HTTP 409, first task's state is untouched.
- [ ] Stale/forged approval — **aim at the agent's own port (e.g. `:3002`),
      not the Orchestrator's `:3000`**: capture a real `actionId` from an
      `input-required` task, then POST to
      `http://localhost:3002/tasks/orch-<task-id>/approve` with a
      **different** actionId → HTTP 409 `Stale or mismatched actionId`,
      nothing executes. POST with no `actionId` at all → HTTP 400
      `'actionId' must be a non-empty string`.

      The port matters and this was previously ambiguous here. The
      Orchestrator deliberately does **not** accept a client-supplied
      `actionId` — it forwards the one it already holds from the agent's
      own preview (see the comment above the forward in
      `apps/orchestrator/index.ts`'s `POST /tasks/:id/approve`), precisely
      so a client cannot forge or override it. The consequence is that
      `POST :3000/tasks/<id>/approve` with an empty body **succeeds by
      design** and executes the write. That is correct behavior, but run as
      an "adversarial" demo it looks exactly like a broken gate. The
      enforcement boundary to demonstrate is the agent.
- [ ] MCP dependency failure and recovery (run this on isolated
      `mcp:http`/`devops-agent` processes, **not** the full `bun run
      --parallel`/`bun run dev` stack — killing one process under
      `--parallel` currently takes the whole stack down, a separate known
      limitation; `bun run orchestrai`'s own shutdown is intentional and
      clean, this specific scenario is about an unintentional crash):
      1. `bun run mcp:http` and `bun run devops-agent` in two terminals.
      2. Confirm `:3002/healthz` shows `ready:true`.
      3. Kill the `mcp:http` process. Within ~1 second, `:3002/healthz`
         shows `ready:false`.
      4. Restart `bun run mcp:http`. Within a few seconds (bounded backoff),
         `:3002/healthz` returns to `ready:true` automatically — no restart
         of DevOps needed.

## 8. Cleanup after every rehearsal

- [ ] Stop all processes (`Ctrl+C` if using `bun run orchestrai`/the
      compiled binary — this stops everything together; otherwise kill
      listeners on 3000–3006).
- [ ] Reset the fixture (see step 0) rather than deleting/recreating it —
      it's a committed, reusable project now, not disposable scratch space.
- [ ] `git status` in **this** repo — confirm no accidental write-demo
      artifacts leaked into the real project.
- [ ] `bun test` and `bun run typecheck` — confirm still green before
      ending the session.

## Known rough edges to route around, not fix live

- None currently known and unfixed. The two items previously listed here
  (ambiguous keyword routing for `run tests`/`document the API`/`scan for
  secrets`, and a directory path containing the substring `ci` misrouting
  to `create-ci`) were both fixed this session — see
  `specs/013-security-skill-detection/spec.md` and
  `specs/015-routing-planning-polish-2/spec.md`. If a new one surfaces during
  rehearsal, add it here with the exact repro text, and check
  `context/worklog.md`/`specs/` before assuming it's unfixed — it may
  already be resolved and just missing from this list.
- The TUI's auto-open-on-a-real-terminal behavior and the compiled binary's
  Ctrl+C shutdown mechanism (as opposed to their observable outcome, which
  is confirmed) have not been verified by Claude in a real interactive
  terminal — only by Yusuf directly. If either misbehaves during
  rehearsal, that's genuinely new information, not a known issue being
  routed around.
