---
id: 080-run-command-approved-execution
title: "Phase B: run-command — a General, Per-Invocation-Approved Execution Primitive"
area: devops-agent
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-12
updated: 2026-09-12
approved_by: Yusuf
approved_on: 2026-09-12
implemented_on: 2026-09-12
amends:
  - 006-runtime-stabilization
  - 042-llm-harness-devops
  - 058-testing-agent-multi-ecosystem-runner-detection
  - 039-per-component-llm-provider-config
related:
  - 078-capability-upgrade-roadmap
  - 079-phase-a-connect-orphaned-tools
supersedes:
  - 076-run-tests-timeout-mismatch
superseded_by: []
---

# Spec: Phase B: run-command — a General, Per-Invocation-Approved Execution Primitive

> Review gate: **APPROVED by Yusuf, 2026-09-12. Implemented and fully
> live-verified the same day** — every Acceptance Criterion below is
> checked, including all three items that needed a real provider key
> (closed via a real credential supplied directly from
> `.orchestrai/config.env`; see the Acceptance Criteria section and
> `verification.md` for the full transcript, including the honest
> Go/Rust-toolchain substitution note).
>
> `specs/078-capability-upgrade-roadmap/spec.md` names this Phase B and
> requires its own spec before implementation — and unlike Phase A, this
> adds a genuinely new **risk class** (the roadmap's own class 4:
> "executing a model-chosen command under per-call human approval"), so
> it gets the extra scrutiny every prior first-of-its-kind capability in
> this codebase has needed. Yusuf approved the shape explicitly
> (*"thats a great thing but with the gate"*), then corrected this
> draft's own first-pass scoping: **not DevOps-only**. His question —
> *"why only the devops can use this tool?"* — surfaced that the
> original DevOps-only scoping was justified by the wrong rule
> (`specs/030`'s skill-ownership-must-be-unambiguous applies to skill
> *ids*, not MCP tool *access* — nothing stops two agents sharing a
> tool, `read_project_file` already is). The real reason Testing was
> deferred was narrower — it has no LLM harness yet — and Yusuf's own
> call, offered directly, was to pull that forward into this spec rather
> than defer it: *"Pull Testing's harness forward into this spec too."*

## Purpose

Every execution in this codebase today is a **fixed, hand-written
command** — `RUNNER_ARGV`'s 7 entries, `docker build`/`docker run`'s own
literal argv construction. That's exactly right for known cases, and
exactly why Testing can't run tests for Go, Rust, Maven, or .NET (or
anything nobody's added yet): there is no command in the table for
them, and an LLM confined to the same fixed enum can't produce `go test`
any more than a human scanning the same list could.

The fix isn't a smarter lookup. It's moving the safety boundary from
*"only these pre-approved commands may run"* to *"a human reviews the
exact command before it runs, every single time"* — the same principle
this repository's own approval gate already applies to every other
write. `run-command` is that: the model (or a human, directly) proposes
a real command; nothing executes until a person has seen the exact
argv and approved it. And because the motivating case for this whole
phase was specifically *"the LLM decides the stack and what to run"*
for **testing**, Testing Agent is a first-class consumer here, not an
afterthought — including gaining the LLM harness infrastructure it has
never had at all.

## Verified Current State

Read 2026-09-12:

- `packages/mcp/index.ts`'s `safeExec()` (just rewritten by
  `specs/079`): takes a real argv array, checks it against
  `ALLOWED_PREFIXES` (17 fixed token sequences), rejects anything else.
  This is the boundary `run-command` changes — not `execFile`'s
  `shell:false` guarantee (untouched, non-negotiable), the **allowlist**
  layered in front of it.
- **Tool access is already shared across agents today** — confirmed
  directly: `read_project_file` is in both DevOps's and Documentation's
  own `requiredTools`. There is no structural or precedent reason
  `run_command` must belong to only one agent. `specs/030`'s
  skill-ownership rule (a *skill id* must resolve to exactly one owning
  agent) is a completely different axis and doesn't apply to tool
  access at all — this draft's first pass conflated the two.
- `packages/agents/testing/index.ts`: `requiredTools: ["run_tests"]`
  only. No `model-factory.ts`, no harness flag, no per-component
  provider/model resolution — confirmed the ONLY agent with none of
  this machinery at all (DevOps/Documentation/Security each have their
  own `model-factory.ts` following an identical shape).
  `packages/shared/llm-model-factory.ts`'s `LLM_COMPONENTS` is
  `["orchestrator", "documentation", "devops", "security",
  "conversation"]` — `"testing"` is absent.
- `packages/shared/test-runner.ts`'s `detectRunner()`
  (`specs/058`): on `{kind: "unsupported"}`, the calling skill
  (`run_tests` MCP tool, and `packages/agents/testing/index.ts`'s own
  skill handlers) report `"No tests configured..."` as a **completed**
  result — no approval ever offered, because there is genuinely nothing
  to run. This is the exact dead end `run-command` removes.
- `packages/shared/test-runner.ts`'s `buildSanitizedTestEnv()`: an
  existing, already-used minimal env allowlist — the precedent this
  spec's own environment handling follows, not a new invention.
- `packages/shared/test-runner.ts`'s `FIXED_TEST_TIMEOUT_MS = 120_000`
  and `TEST_OUTPUT_MAX_BYTES` (64 KiB) — the existing bounded-execution
  precedent `run_tests` already established; `run-command` needs the
  same shape.
- `packages/shared/mcp-client.ts`'s `OrchestraiMcpClient.callTool()`:
  hardcodes `TOOL_TIMEOUT_MS = 15_000` as the **client-side** MCP
  request timeout, applied to every tool uniformly — `specs/076`'s own
  diagnosed bug (`run_tests` already needs up to 120s server-side but
  the client gives up at 15s), which would immediately reproduce for
  `run-command`. Never implemented as its own spec; absorbed here as a
  structural prerequisite. `specs/076` itself is superseded by this fix.
- `packages/agents/devops/model-factory.ts` (and Documentation's/
  Security's own, identical in shape): one flag
  (`ORCHESTRAI_<AGENT>_LLM_HARNESS`), `readLlmHarnessConfig()` delegating
  to the shared `readLlmModelConfig(env, component)`, a startup-state
  summary function. The exact template `packages/agents/testing/
  model-factory.ts` follows in this spec.
- `apps/orchestrator/supervisor-graph.ts`'s `SKILL_TIER_REGISTRY`: an
  unregistered skill defaults to write-capable/approval-required,
  fail-closed.

## Proposed Behavior

### 1. A new MCP tool: `run_command`

`packages/mcp/index.ts` gains `run_command`, parameterized as
`{ argv: string[], cwd: string }` — **an array, never a string**, no
shell, no re-parsing, no injection surface, identical in shape to every
tool `specs/079` already fixed. Execution: `execFileAsync(argv[0],
argv.slice(1), { cwd, timeout: RUN_COMMAND_TIMEOUT_MS, shell: false,
env: <sanitized allowlist> })`, output bounded the same way `run_tests`
already bounds its own (64 KiB, explicit truncation marker).

Two defense-in-depth checks, layered in front of the approval gate,
never a substitute for it:
- A minimal, hand-written denylist of unambiguously destructive
  patterns (`rm -rf /`, `format`, `mkfs`, `dd if=`, a shutdown/reboot
  command, a disk-wipe pattern), rejected before the tool ever runs.
  Not the safety mechanism — human approval is — this only catches an
  unmistakable catastrophe even if an approval was somehow rushed
  through without reading it closely.
- `cwd` must resolve inside the resolved target project root (the same
  path-containment discipline `read_project_file`/`write_project_file`
  already enforce).

### 2. DevOps gains a general-purpose `run-command` skill

Tier 1, approval-gated — every invocation, unconditionally, no
exceptions, no trusted-command memory. Two ways the command is decided:
**explicit** (named directly in the task text, parsed by a simple safe
tokenizer, no model involved, works regardless of harness state), or
**LLM-proposed** (when `ORCHESTRAI_DEVOPS_LLM_HARNESS=1` and no explicit
command was given — the existing flag, no new one for DevOps). Grounded
in the project's real files via the existing read-only
`analyze_project`/`read_project_file` tools, same "look before deciding"
pattern `042`'s other harness functions already use, returning a
structured `{ argv: string[], reason: string }` via the same
closed-schema/retry/validate shape every other harness call already
uses.

### 3. Testing Agent gains its own LLM harness AND uses run-command as its unsupported-stack fallback

**New**, correcting this spec's own first draft: Testing was the actual
motivating case (*"even the LLM decide the stack and what to run"*),
so it gets real infrastructure, not just access to someone else's tool.

- `packages/agents/testing/model-factory.ts` (new) — the identical
  template DevOps/Documentation/Security already use:
  `ORCHESTRAI_TESTING_LLM_HARNESS`, `readLlmHarnessConfig()` delegating
  to `readLlmModelConfig(env, "testing")`, a startup-state summary.
  `LLM_COMPONENTS` gains `"testing"`.
- Testing's `requiredTools` gains `read_project_file` (already exists,
  Tier 2, read-only) so its harness can ground a proposal in real
  project files, and `run_command`.
- When `detectRunner()` returns `{kind: "unsupported"}` for `run-tests`/
  `check-coverage`:
  - **No explicit command in the task text, harness off** (today's
    exact behavior, unchanged): a **completed** result reporting no
    tests configured — no approval offered, byte-identical to today.
  - **Explicit command given** (`"run tests: go test ./..."`): parsed
    deterministically, dispatched through `run-command`'s own approval
    flow — works with no harness at all.
  - **Harness on, no explicit command**: the harness proposes a real
    test command for the detected (but table-unsupported) stack,
    dispatched through the identical approval flow.
  - A harness flag set but genuinely misconfigured (no key) fails the
    task closed with a named error, the same fail-closed precedent
    every other harness already establishes — it never silently falls
    back to "no tests configured" once the flag says it should be able
    to do better.

This is a real, deliberate behavior change from today, stated
explicitly: an "unsupported" runner **can now become approval-required**
instead of always completing immediately — only when a real command is
actually available (explicit or proposed), never otherwise.

### 4. The MCP client's timeout becomes per-call (absorbs specs/076)

`OrchestraiMcpClient.callTool()` gains an optional per-call timeout
parameter, defaulting to the existing `TOOL_TIMEOUT_MS` (15s) for every
existing call site — byte-identical for `analyze_project`,
`create_dockerfile`, etc. `run_tests` and the new `run_command` both
request a longer timeout matching their own real execution budget,
closing `specs/076`'s diagnosed gap (this repo's own ~30-40s suite
timing out at 15s) as a structural side effect of building this
correctly, not a separately-shipped fix.

## Scope

- `packages/mcp/index.ts`: `run_command` tool, the denylist check, the
  cwd-containment check.
- `packages/agents/devops/index.ts` + `llm-harness.ts`: the general
  `run-command` skill — detection, explicit parsing, LLM-proposal path,
  approval preview.
- `packages/agents/testing/model-factory.ts` (new),
  `packages/agents/testing/llm-harness.ts` (new): Testing's own harness
  infrastructure, mirroring DevOps/Documentation/Security exactly.
- `packages/agents/testing/index.ts`: `requiredTools` gains
  `read_project_file`/`run_command`; the unsupported-runner branch
  gains the explicit/LLM-proposed fallback described in §3.
- `packages/shared/llm-model-factory.ts`: `LLM_COMPONENTS` gains
  `"testing"`.
- `packages/shared/mcp-client.ts`: `callTool()`'s optional per-call
  timeout parameter (closes `specs/076`).
- `apps/orchestrator/supervisor-graph.ts`: `run-command` registered
  Tier 1 in `SKILL_TIER_REGISTRY`/`SUPERVISOR_ALLOWED_SKILLS`. (The
  Testing fallback reuses `run-tests`/`check-coverage`'s own existing
  Tier 1 classification — no new skill id there.)
- `apps/supervisor/agent-catalog.ts`: DevOps's skill list gains
  `run-command`.
- `apps/supervisor/init-wizard.ts`'s `AGENT_LLM_HARNESSES`: Testing
  joins DevOps/Documentation/Security — the guided-init form's own
  "selecting the agent enables its harness" wiring (once `specs/077`
  lands) picks this up automatically; until then, unaffected either way
  (Testing simply gets an askable harness toggle like the other three
  already have).
- Tests: the denylist and cwd-containment checks; explicit-command
  parsing for both DevOps and Testing; the approval preview shape for
  both the deterministic and LLM-proposed paths (the LLM path testable
  the same way `042`'s own harness tests already are, with a fake
  model); the per-call timeout parameter; Testing's unsupported-runner
  branch across all four states in §3.
- **Out of scope / unchanged**: any change to `ALLOWED_PREFIXES` or the
  fixed-command tools `specs/079` already shipped; `RUNNER_ARGV`/
  `detectRunner()` itself (Phase B′'s own deterministic expansion stays
  complementary — the table is still the free, certain first answer for
  the 7 it already covers); any change to the approval gate's mechanism
  itself; giving any agent *besides* DevOps and Testing access to
  `run_command` in this pass.

## Safety and Compatibility Constraints

- **The human approval gate is the safety boundary, not the denylist.**
  The denylist is explicitly defense-in-depth, never sufficient on its
  own — every invocation requires the identical `actionId`-bound
  approval flow every other Tier 1 skill already uses, no fast path, no
  auto-approve, no cross-invocation memory.
- **No shell is ever involved.** `argv` is always a real array;
  `execFileAsync(bin, args, {shell:false})` — unchanged from every
  other tool in this codebase.
- **`cwd` is always contained inside the resolved target project.**
- **Bounded, never unbounded** — a fixed, generous timeout and the
  existing 64 KiB output cap, the same "bounded, never hang" precedent
  `specs/045`/the adaptive supervisor's own dispatch bounds already
  established.
- **Every existing tool/skill/agent is byte-identical when its own
  harness stays off or its own explicit-command path isn't used.** In
  particular: Testing's unsupported-runner result is **identical to
  today** whenever no explicit command is given and the (new, opt-in,
  default-off) harness flag is unset — proven by the existing test
  suite passing unmodified.
- **Fail-closed on a misconfigured or absent LLM harness**, matching
  every prior harness precedent: a request that needs the model (no
  explicit command, harness flag on) but can't resolve a working key
  fails the task closed with a named error — never a silent fallback to
  "no tests configured" once the flag says it should be able to do
  better, and never a guessed command either.

## Out of Scope / Non-Goals

- Removing or relaxing `ALLOWED_PREFIXES` for the existing fixed-command
  tools.
- Any auto-approval, "trusted command," or approval-caching mechanism.
- Giving Documentation, Security, or the Orchestrator itself access to
  `run_command` in this pass — a real, separate future decision.
- Any change to `RUNNER_ARGV`/`detectRunner()` — Phase B′ remains
  complementary, not superseded.
- Testing gaining its full "writes tests" capability (`specs/078`'s
  Phase C) — this spec only gives Testing the harness *infrastructure*
  and one narrow use of it (proposing a command for an unsupported
  stack), not test authoring.
- Network access of any kind from within a `run-command` invocation.

## Acceptance Criteria

- [x] A real command proposed by Testing's own harness for a project
      with **no entry in `RUNNER_ARGV` at all** runs successfully after
      approval, live — the decisive "any stack" proof. **Live-verified
      2026-09-12** against a real Gemini deployment (`gemini-3.5-flash`,
      a real key from `.orchestrai/config.env`), a real `mcp:http` +
      `testing-agent` stack, `ORCHESTRAI_TESTING_LLM_HARNESS=1`: a bare
      scratch project (one `verify.js` file, deliberately no
      `package.json`/lockfile/pytest markers — `detectRunner()` genuinely
      returned `unsupported`) was dispatched through `run-tests`; the
      real model called `read_project_file`, discovered `verify.js`, and
      proposed `["node", "verify.js"]` — approved, and the command
      genuinely executed (`node` process spawned, real stdout captured
      in the task result: `"PASS 1 + 1 === 2"`/`"PASS string concat"`/
      `"2 passed, 0 failed"`, plus a real `EXECUTED.marker` file written
      to disk with a live timestamp, confirming real process execution
      outside this session's own control). **Substitution note, disclosed
      not glossed over**: no Go/Rust/Maven/.NET toolchain exists on this
      machine (`go`/`cargo`/`mvn`/`dotnet` all absent from `PATH`), so
      the literal Go/Rust fixture Yusuf asked for could not be executed
      here — a bare no-manifest Node script was substituted, which
      exercises the identical mechanism (`detectRunner()` → unsupported
      → harness discovers real files → proposes a real command → approval
      → real execution) for a stack with zero `RUNNER_ARGV` coverage,
      the property that actually matters. A literal Go/Rust pass remains
      open for whichever machine has those toolchains installed.
- [x] The exact same request, rejected instead of approved, executes
      nothing — **live-verified 2026-09-12**, same session: the pending
      `run_command` approval for `["node", "verify.js"]` was rejected
      via `POST /tasks/:id/reject`; the task terminated `{"status":
      "failed","error":"Rejected by user"}` and the scratch directory's
      filesystem state was confirmed byte-identical to before
      submission (no `EXECUTED.marker`, only the original `verify.js`) —
      proof by absence, not inference.
- [x] An explicit command named directly in the task text runs through
      both DevOps's `run-command` and Testing's fallback with no
      harness/model involvement at all — live-verified via real HTTP
      requests against both agents' real, unmodified apps
      (`packages/agents/devops/index.test.ts`,
      `packages/agents/testing/index.test.ts`): the exact argv (including
      a quoted multi-word argument surviving as one token) appears in the
      approval preview, no MCP/model call made to get there.
- [x] With Testing's harness off and no explicit command, an
      unsupported-stack request is byte-identical to today (a completed
      "no tests configured" result, no approval offered) — confirmed via
      a real `detectRunner()` call against a genuine unsupported-stack
      fixture (a bare `go.mod`, no `package.json`).
- [x] The denylist rejects an unambiguously destructive pattern before
      it ever reaches approval — confirmed via a real
      `run_command` MCP call (`packages/mcp/index.test.ts`): a
      `rm -rf /`-shaped argv and a fork-bomb pattern are both blocked
      with `isError: true` and never reach `execFile`; an unrelated real
      command (`echo`) is confirmed NOT denylisted, proving the list is
      narrow, not a general safety net.
- [x] A `cwd` outside the resolved project root is refused — confirmed
      via a real `run_command` MCP call with a genuinely separate temp
      directory as `cwd`; `cwd === project_root` is confirmed allowed.
- [x] `run_tests`'s own real ~30-40s suite (this repository's own, the
      exact scenario that surfaced `specs/076`) now completes instead of
      timing out at 15s. **Live-verified 2026-09-12**, same session: this
      repository's own `bun test` (this repo's real suite — hundreds of
      real modules, real `(pass)` lines observed in the captured output)
      was dispatched through Testing's `run-tests` (resolved
      deterministically to the `bun` profile, no LLM harness needed for
      this scenario), approved, and **completed in 28 real seconds** —
      timed from the approve call to the `completed` status, comfortably
      past the old 15s `TOOL_TIMEOUT_MS` wall that `specs/076` diagnosed
      and would previously have killed this exact call. The task result
      itself contains the real suite's own output (hundreds of genuine
      `(pass) ...` lines), not a synthesized or truncated-to-nothing
      failure.
- [x] Every existing MCP tool call site, and every existing DevOps/
      Testing/Documentation/Security test, is unaffected — proven by
      the full existing suite passing unmodified (942 pass, 0 skip-
      relevant regressions, 0 fail; the 2 skips are the pre-existing
      Docker-daemon-gated tests from `specs/079`, unrelated to this spec).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass —
      942 pass / 2 skip / 0 fail across 944 tests, `tsc --noEmit` clean,
      `specs:check` passed for 79 specs.
- [x] `CLAUDE.md` and `context/worklog.md` updated; `specs/076` marked
      superseded by this spec.

## Verification Plan

- Unit: the denylist and cwd containment; explicit-command parsing for
  both agents; the LLM-proposal path with an injected fake model
  (mirroring `042`'s own harness test technique) for both DevOps and
  Testing; the approval preview's exact-argv content; the per-call
  timeout parameter's default-unchanged/override-honoured behavior;
  Testing's unsupported-runner branch across all four states.
- Live, with a real provider key: a genuine Go or Rust scratch project
  with zero `RUNNER_ARGV` support, dispatched through Testing's own
  `run-tests` with its harness on, approved, and confirmed to actually
  run and report real results. This repository's own real test suite
  run through `run_tests` (no longer timing out) as the `specs/076`
  regression proof.
- A live rejection pass: propose, reject, confirm nothing executed.

## Approval Requested

Approve to proceed. Implements `specs/078`'s Phase B, absorbs
`specs/076`, and gives Testing Agent its first-ever LLM harness (a real,
if narrowly-scoped, slice of Phase C pulled forward at Yusuf's own
direction). Nothing is implemented until approved.
