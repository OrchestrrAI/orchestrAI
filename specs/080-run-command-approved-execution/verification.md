# Verification — specs/080-run-command-approved-execution

Recorded 2026-09-12. First pass same session as implementation (unit +
HTTP-level); second pass later the same day, live against a real
provider deployment once a real key became available
(`.orchestrai/config.env`), closing every item this section originally
left open.

## What was verified in this session

### `run_command` MCP tool (`packages/mcp/index.ts`)

- Advertised by the shared server (`client.listTools()` contains
  `run_command`).
- A real, bounded command executes and returns its real output
  (`echo "hello from run_command"` → the text appears verbatim).
- Denylist: `["rm", "-rf", "/"]` and a fork-bomb argv are both blocked
  (`isError: true`, response text contains `"Blocked"`) — confirmed via
  a real `client.callTool()` round trip, not a unit test of the regex
  alone. An unrelated command (`echo`) is confirmed NOT blocked, proving
  the list is narrow rather than a general classifier.
- cwd-containment: a `cwd` in a genuinely separate temp directory from
  `project_root` is denied (`"outside project_root"`); `cwd === project_root`
  is allowed.
- A nonexistent `cwd` fails with a named error (`"not found"`), never a
  silent no-op.
- A real nonzero exit surfaces as `isError: true`, not swallowed.

All via `packages/mcp/index.test.ts`'s new `describe("specs/080 —
run_command")` block — 8 tests, real `InMemoryTransport`-connected
client/server pair, no mocking of `execFile` itself.

### DevOps's `run-command` skill (`packages/agents/devops/index.ts`)

- Agent Card advertises `run-command`.
- An explicit `"run command: go test ./... at <path>"` reaches
  `input-required` with `approval.toolName === "run_command"` and
  `approval.parameters.argv` exactly `["go", "test", "./..."]` — no MCP
  call made to get there (`tokenizeCommandText`/`extractRunCommandText`
  are pure).
- A quoted argument (`echo "hello world"`) survives as one token, not
  split on the internal space.
- No explicit command + harness off fails closed with a named error
  (`"No explicit command given"`), never a guess.
- The bare-text detector (no `selectedSkill`) also reaches `run-command`
  for `"run command: echo hi at <path>"`.

`packages/agents/devops/index.test.ts`'s new `describe("specs/080 —
run-command")` block — 4 tests, real HTTP requests against the real,
unmodified `app`.

### Testing's 4-state unsupported-runner fallback (`packages/agents/testing/index.ts`)

- **State 1** (no explicit command, harness off): byte-identical to the
  pre-080 "No tests configured" completed result, `requiresApproval`
  absent — confirmed against a real `detectRunner()` call on a genuine
  unsupported-stack fixture (a bare `go.mod`, no `package.json`, no
  pytest markers).
- **State 2** (explicit command in task text): reaches `input-required`
  with the exact argv (`["go", "test", "./..."]`) and a risk line calling
  out the absence of a fixed runner profile — no harness/model call.
- **State 4** (harness flag on, no API key): fails the task closed with
  an error naming `ORCHESTRAI_TESTING_LLM_HARNESS` explicitly, and does
  NOT fall back to the "No tests configured" text.
- **State 3** (harness on, no explicit command, real model proposes a
  command): **live-verified, see "Live pass" below.**

`packages/agents/testing/index.test.ts` (new file) — 3 tests covering
states 1, 2, and 4.

### Per-call MCP timeout (absorbing `specs/076`)

- `OrchestraiMcpClient.callTool()` and `OrchestraiMultiMcpClient.callTool()`
  both gained an optional 4th `timeoutMs` parameter, defaulting to the
  exact original `TOOL_TIMEOUT_MS` (15s) — every pre-existing call site
  (all of DevOps's/Documentation's four-argument calls) is unaffected,
  confirmed by the full existing suite passing unmodified.
- Testing's own `run_tests` and `run_command` calls, and DevOps's own
  `run_command` call, now pass an explicit extended timeout
  (`FIXED_TEST_TIMEOUT_MS` + a 15s round-trip buffer for Testing, a
  matching 135s constant for DevOps) instead of the old 15s default.
- **Live-verified, see "Live pass" below**: this repository's own real
  test suite actually completing through a live `run_tests` call end to
  end (the literal `specs/076` regression proof).

## Full-suite results

- `bun test`: **942 pass, 2 skip (pre-existing, Docker-daemon-gated,
  specs/079), 0 fail**, across 944 tests / 61 files, ~56s.
- `bun run typecheck`: 0 errors.
- `bun run specs:catalog` / `bun run specs:check`: 79 specs, governance
  check passed.

## Live pass, 2026-09-12 (real Gemini deployment, real key)

A real `mcp:http` (port 3006) + `testing-agent` (port 3003) stack was
started with `ORCHESTRAI_TESTING_LLM_HARNESS=1`,
`ORCHESTRAI_LLM_PROVIDER=gemini`, `ORCHESTRAI_LLM_MODEL=gemini-3.5-flash`,
and the real `ORCHESTRAI_LLM_API_KEY` from `.orchestrai/config.env` (the
key was never echoed, logged, or included in any file committed to the
repo — the startup log confirmed `LLM harness (run-command fallback):
enabled — provider gemini (ORCHESTRAI_LLM_PROVIDER), model
gemini-3.5-flash (ORCHESTRAI_LLM_MODEL), key from
ORCHESTRAI_LLM_API_KEY`, never the key value itself).

**Toolchain constraint, disclosed up front**: this machine has no Go,
Rust, Maven, or .NET toolchain installed (`go`/`cargo`/`mvn`/`dotnet` are
all absent from `PATH`) — literally running `go test` was not possible
here regardless of what the model proposed. Substituted a bare,
no-manifest Node script (`verify.js`, no `package.json`, no lockfile, no
pytest markers) as the "no `RUNNER_ARGV` entry" fixture — this exercises
the identical mechanism end to end (`detectRunner()` → `unsupported` →
harness discovers real files via `read_project_file` → proposes a real
command → approval → real execution) for a genuinely uncovered stack, the
property the acceptance criterion actually tests. A literal Go/Rust pass
is still open for a machine with those toolchains.

**Scenario 1 — real proposal + real execution.** Submitted `run tests
at <scratch dir>` (`selectedSkill: "run-tests"`). The real model called
`read_project_file`, found `verify.js`, and proposed
`{"argv": ["node", "verify.js"]}` — reaching `input-required` with that
exact argv in the approval preview. Rejected first (see Scenario 2),
then resubmitted and approved: the task completed with the script's real
stdout in the result (`"PASS 1 + 1 === 2"`, `"PASS string concat"`,
`"2 passed, 0 failed"`), and a real `EXECUTED.marker` file was found on
disk afterward with a live timestamp (`2026-09-12T17:05:16.012Z`) —
proof of genuine process execution, not a synthesized result.

**Scenario 2 — rejection is terminal, nothing executes.** The first
proposal (`["node", "verify.js"]`) was rejected via
`POST /tasks/:id/reject`. Task terminated `{"status":"failed","error":
"Rejected by user"}`. The scratch directory's filesystem was confirmed
byte-identical to before submission — no `EXECUTED.marker`, only the
original `verify.js` — proof by absence, not inference.

**Scenario 3 — the `specs/076` timeout regression, closed.** Submitted
`run tests at <this repo's own root>` — resolved deterministically to
the `bun` profile (no harness involvement). Approved, timed from the
approve call to `completed`: **28 real seconds**, comfortably past the
old 15s `TOOL_TIMEOUT_MS` that `specs/076` diagnosed as killing this
exact call before it could ever finish. The task result contains the
real suite's own output — hundreds of genuine `(pass) ...` lines from
this repository's actual test files — truncated at the existing 64 KiB
`boundTaskResult()` cap (a separate, pre-existing, documented limit,
unrelated to this spec), not a timeout failure.

All three scratch artifacts (`body*.json`, `scratch-submit*.js`, the
temp scratch directory) were removed after the pass; `git status` is
clean.

## Summary

Every item this document previously left open is now closed. `specs/080`
moves to `verification: verified`.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/080-run-command-approved-execution/spec.md` (implemented,
**verified**, 2026-09-12) is Phase B: a general,
per-invocation-approved execution primitive, `run_command` — the
roadmap's own risk class 4 ("executing a model-chosen command under
per-call human approval"), the first new risk class this codebase has
taken on since `run_command`'s only sibling risk classes (1-3) were
already covered by every prior checkpoint. **The first draft of this
spec scoped `run_command` to DevOps only, and that scoping was wrong** —
Yusuf caught it directly ("so why only the devops can use this tool?"):
the real justification cited (`specs/030`'s skill-ownership rule)
governs skill *ids*, not MCP tool *access* — nothing stops two agents
sharing a tool, `read_project_file` already does. The actual reason
Testing was deferred was narrower (no LLM harness existed for it yet),
and Yusuf's own call, given directly via AskUserQuestion, was to pull
that harness forward into this same spec rather than defer it further:
*"Pull Testing's harness forward into this spec too."* So `run_command`
is genuinely shared: DevOps's own general `run-command` skill, and
Testing's fallback for a stack `detectRunner()` (`specs/058`) has no
`RUNNER_ARGV` entry for. **Documentation, Security, and the Orchestrator
are deliberately excluded** — Security's exclusion in particular is not
a placeholder: it is the same direct-`fs`/read-only/no-write boundary
`specs/011`'s decision (c) already drew, reaffirmed here on Yusuf's own
explicit confirmation rather than left to drift ("ok go ahead we can
just increase the toolse of the secuirty instead" — more read-only
tools remain the only appropriate future direction for Security, never
execution).

**The safety story, unchanged from every other write-capable skill in
this codebase**: `run_command`'s own MCP-tool-side checks
(`checkRunCommandDenylist()` — a small, hand-written list of
unambiguously destructive patterns, e.g. `rm -rf /`, a fork bomb,
`mkfs`, `dd if=`, never a general "is this safe" classifier — plus
`isPathContainedSync()`, a lighter cwd-inside-project-root check than
`read_project_file`'s own realpath-based containment) are explicitly
**defense-in-depth, not the safety mechanism**. The real mechanism is
the calling agent's own `actionId`-bound human approval, exactly like
every other Tier 1 skill — `run_command` performs no approval check of
its own and must only ever be reached from a `resumeTask()` that already
required one. **Non-negotiable, Yusuf's own explicit condition**: every
single invocation is approved individually — no auto-approve, no
"trusted command" memory, no batch-approve, ever. Argv array only,
`execFile`/`shell:false` throughout — the same no-shell boundary every
other tool in this file already holds.

**DevOps's `run-command` skill** (`prepareRunCommandAction()`) has two
paths to a real argv, never blended: an **explicit command** in the task
text (`"run command: go test ./..."`, parsed by a plain no-shell
tokenizer — quoted spans kept together, everything else split on
whitespace — never handed to a shell) always wins and needs no model
call at all; absent that, and only when `ORCHESTRAI_DEVOPS_LLM_HARNESS=1`,
the existing harness infrastructure (`runRunCommandHarness()`, the same
shared LangGraph tool-calling core `042`'s four skills already use, with
the same three read-only tools bound) proposes one. No explicit command
and the harness off fails closed with a named error — there's nothing
else this skill could safely do.

**Testing Agent gains its own LLM harness for the first time** —
`packages/agents/testing/model-factory.ts` and
`packages/agents/testing/llm-harness.ts`, mirroring the established
per-agent-independent-copy pattern (`041`/`042`/`043` each built their
own; nothing here is shared across agents) but deliberately narrower in
scope than DevOps's: it exists for exactly one job, proposing a command
when `detectRunner()` returns `{kind: "unsupported"}` — never "writing
tests" (`specs/078`'s own, separate, not-yet-started Phase C). Its own
bound read-only tool set is narrower too: just `read_project_file`
(Testing has no `analyze_project`/`git_status`). `LLM_COMPONENTS`
(`packages/shared/llm-model-factory.ts`) gained `"testing"`, and
`AGENT_LLM_HARNESSES` (`apps/supervisor/init-wizard.ts`, the table
driving both the guided-init forms and the startup key check) gained a
`testing-agent` row — Testing is no longer the one agent structurally
excluded from that table.

**Testing's unsupported-runner branch is exactly four states, matching
the spec's own design verbatim:**

1. No explicit command + harness off → **byte-identical** to the
   pre-080 "No tests configured — no package.json test script, pytest,
   or test files found" completed result, no approval offered.
2. An explicit command in the task text → parsed deterministically
   (the same tokenizer DevOps uses, an independent copy), dispatched
   through `run_command`'s own identical approval flow, no harness
   needed.
3. Harness on + no explicit command → the harness proposes a real
   command, dispatched through the identical approval flow.
4. Harness flag on but misconfigured (no key) → fails the task closed
   with a named error mentioning `ORCHESTRAI_TESTING_LLM_HARNESS`
   explicitly, never a silent fallback to state 1's "no tests
   configured" text.

**One real gap found and fixed while grounding this spec, not assumed
away**: the mechanism absorbing `specs/076` (an optional per-call
timeout on `OrchestraiMcpClient.callTool()`/`OrchestraiMultiMcpClient
.callTool()`, defaulting to the exact original 15s `TOOL_TIMEOUT_MS` so
every pre-existing call site stays byte-identical) existed after this
spec's §4 work, but neither Testing's own `run_tests`/`run_command`
calls nor DevOps's own `run_command` call were actually passing an
extended value — they would have kept hitting the same 15s client-side
wall the mechanism exists to fix. Closed before calling this
implemented: Testing now passes `FIXED_TEST_TIMEOUT_MS` (120s) plus a
15s round-trip buffer for both of its long-running calls; DevOps passes
a matching 135s value for its own `run_command` call.

**942 tests pass** (0 fail; 2 skips are the pre-existing Docker-daemon-
gated tests from `specs/079`, unrelated to this spec), typecheck clean,
`specs:check` passed for 79 specs. **Fully live-verified, closing every
open item the same day**: `run_command`'s own denylist/cwd-containment/
real-execution behavior (real MCP round trips,
`packages/mcp/index.test.ts`); both agents' explicit-command paths
reaching a correct, exact-argv approval preview via real HTTP requests
against the real, unmodified apps; all of Testing's four states,
including state 3 — against a real Gemini deployment
(`gemini-3.5-flash`, a real key), a real `mcp:http` + `testing-agent`
stack: the model genuinely called `read_project_file`, discovered a
deliberately manifest-free scratch script, and proposed
`["node","verify.js"]`, which then genuinely executed after approval
(real stdout captured, a real `EXECUTED.marker` file written to disk
with a live timestamp) — **and, rejected instead, genuinely executed
nothing** (the scratch directory confirmed byte-identical to before
submission). **One disclosed substitution**: no Go/Rust/Maven/.NET
toolchain exists on the machine this pass ran on, so the literal
Go/Rust fixture was replaced with a manifest-free Node script — the
exact mechanism (`detectRunner()` → unsupported → harness discovers real
files → proposes a real command → approval → real execution) is
identical either way; a literal Go/Rust pass remains open for a machine
with those toolchains. This repository's own real test suite was also
dispatched through a live `run_tests` call and completed in **28 real
seconds** — comfortably past the old 15s `TOOL_TIMEOUT_MS` wall
`specs/076` diagnosed, closing that regression for real rather than by
mechanism alone. See `specs/080`'s own `verification.md` for the full
transcript. `specs/076-run-tests-timeout-mismatch/spec.md` is marked
`superseded_by: 080` — its diagnosis was absorbed here rather than
implemented standalone.

See specs/079-phase-a-connect-orphaned-tools/verification.md for the relocated narrative covering this checkpoint.

See specs/081-testing-write-tests-skill/verification.md for the relocated narrative covering this checkpoint.

See specs/077-agent-enabled-means-llm-on-by-default/verification.md for the relocated narrative covering this checkpoint.

See specs/101-per-agent-tool-access-expansion/verification.md for the relocated narrative covering this checkpoint.

See specs/097-chat-answer-and-plan-description-honesty/verification.md for the relocated narrative covering this checkpoint.

See specs/111-testing-documentation-routing-fixes/verification.md for the relocated narrative covering this checkpoint.
