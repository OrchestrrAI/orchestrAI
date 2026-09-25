# Plan — 078 System-Wide Capability Upgrade Roadmap

Each phase becomes **its own numbered spec** needing its own approval.
This file holds per-phase scope and exit gates so the ordering argument
lives in one place and a later phase can't quietly widen.

The rule from `spec.md`: **a phase adding a new risk class does not
begin until the phase proving the mechanism it depends on is
`verification: verified`.**

---

## Track 0 — make what exists work (parallel, already drafted)

Not capability work. Neither blocks nor is blocked by A–F.

| Spec | What | State |
|---|---|---|
| `075` | Chat answers instead of dispatching; real findings in a plan-task result; live step progress | draft (revised) |
| `076` | `run-tests` client timeout (15s) vs runner budget (120s) mismatch | draft |
| `077` | Selecting an agent ⇒ its LLM harness on by default | draft |

---

## Phase A — Connect and extend what exists

**Risk classes 1–2.** Nothing here is a new kind of risk; it is the
groundwork Phase B's approval path depends on.

**A1 — DevOps `build-image`** (wraps the orphaned `docker_build`)
- Tier 1, approval-gated exactly like `dockerize`.
- Closes generate→verify for the highest-value case: "write me a
  Dockerfile" can finally be followed by "and prove it builds" — the
  literal question asked live (*"that's my repo can you deploy it?"*).
- Real build output surfaced, bounded by the existing 64 KiB
  `boundTaskResult()` path. A failed build is a *useful result*, not an
  error to swallow.

**A2 — DevOps `docker-status`** (wraps the orphaned `docker_status`)
- Read-only, Tier 2, no approval. Makes A1 inspectable ("did the image
  actually land?").

**A3 — read-only `git-diff` skill** (wraps the orphaned `git_diff`)
- Read-only, Tier 2. Answers "what changed?" — impossible today — and
  is the **required input for Phase D**.
- Owned by DevOps (it already owns `git-status`); skill ownership must
  be unambiguous per `specs/030`'s capability-snapshot rule.

**A3′ — DevOps `commit-changes`** (wraps the orphaned `git_commit`,
decision 7 — connected, not left orphaned)
- Tier 1, approval-gated. The one write in this phase that alters
  history rather than producing an inspectable file, so its approval
  preview is held to a higher bar than a normal file write: it must show
  the real, already-staged diff (via A3's own `git-diff`) **and** the
  exact commit message verbatim before anything runs — never a
  paraphrase or summary standing in for the real change.
- `git add`/`git commit` are already on `safeExec()`'s allowlist — no
  new execution surface, a new skill over an existing one.
- Scope question for its spec: stage-all vs. caller-specified paths: the
  existing `git_commit` MCP tool stages everything (`git add -A` then
  commit); worth deciding explicitly whether that's the skill's real
  behavior or whether it should require an explicit file list, given the
  approval preview can only show what's *already staged* at generation
  time — a file staged between preview and approval must fail the same
  fingerprint recheck `specs/056` already established for every other
  write.

**A4 — new fixed tools** (approved, decision 1)
- `docker_run` — start the built image, bounded, and report whether it
  actually **boots**; the real end of "can you deploy it?". Container
  lifecycle (auto-remove, port, timeout) must be fixed policy, not
  model-chosen.
- CI workflow lint — validate the GitHub Actions YAML we emit (today
  nothing checks it).
- Dependency install/audit — real dependency state, which also gives
  Phase F something honest to build on.

**A5 — multi-endpoint MCP support** (decision 3; independent, can land
in parallel with A1–A4)
- `OrchestraiMcpClient` currently holds one `url` and requires *all*
  `requiredTools` on that single server (finding 6). Becomes a list of
  endpoints, each with its own required-tool set, its own connection
  lifecycle and its own `/healthz` reporting.
- **The loopback/`http:`-only rule is untouched.** This unlocks exactly
  the locally-run third-party ecosystem (official filesystem server,
  Docker MCP, Playwright MCP, Postgres MCP) with **no new trust
  boundary**, because those bind loopback. Hosted remote servers stay
  deferred — they operate on their own service's data and cannot touch
  a local repository anyway.

**A6 — fix `safeExec()`'s argv handling** (prerequisite for Phase B)
- It re-splits its own command string on whitespace, so a
  `context_path`/`image_tag`/`dockerfile` containing a space becomes the
  wrong argv. Safe today (`execFile`, `shell:false` ⇒ no injection) but
  wrong, and A1/A4 make it user-controllable. Pass a real argv array
  instead of a string to be re-parsed.

**Exit gate:** a real `build-image` → `docker_run` sequence live, on a
real generated Dockerfile — image builds, container boots, output
surfaces, approval engages; a deliberately broken Dockerfile produces a
legible failure; a real `commit-changes` run shows the real staged diff
and message in its preview and produces a genuine commit only after
approval, refused if the staged state changed after preview generation.
Plus one locally-run third-party MCP server genuinely connected
alongside ours.

---

## Phase B — The general approved-execution primitive

**Risk class 4 — new.** Approved with the gate (decision 2). Gated on
Phase A verified, which proves execute-then-approve on fixed commands
first. **Also delivers "the LLM decides the stack and what to run"
(decision 5) — that is this phase, not a separate one.**

- A `run_command` MCP tool: the model proposes a real command; **every
  single invocation** goes through the existing `actionId`-bound
  approval flow, showing the exact argv a human is signing off on.
- Non-negotiable boundaries, all inherited unchanged from today's fixed
  execution: argv array (never a shell string), `shell:false`, bounded
  timeout, bounded output, sanitized env allowlist, fully audit-logged.
- **`ALLOWED_PREFIXES` is replaced by a human, never by nothing.** No
  auto-approve, no "trusted commands" list, no approve-all-in-batch.
  That single constraint is the entire reason this is acceptable.
- What it unlocks immediately: running tests for *any* stack (Go, Rust,
  Maven, .NET, anything unanticipated), plus every future one-off
  capability without a new tool per case.
- Open design question for its spec: which agent owns it. DevOps is the
  natural home (it already owns execution), but a case exists for the
  Orchestrator owning it so any agent can request execution.

**Exit gate:** a real `go test` (or equivalent for a stack with **no**
entry in `RUNNER_ARGV`) proposed by the model, approved by a human, run
successfully — proving any-stack capability end to end; plus a rejected
proposal confirmed to execute nothing.

---

## Phase B′ — Deterministic ecosystem expansion (any time after A)

**Risk class 1.** Complementary to Phase B, not replaced by it: a
lockfile-derived answer is instant, free and certain, so known
ecosystems keep using it and `run_command` covers the rest.

- Go, Rust, Maven/Gradle, .NET detection + `RUNNER_ARGV` entries —
  exactly the follow-up `specs/058`'s own Out of Scope invited.
- Coverage-percent parsing for npm/pnpm/yarn/jest/vitest, which `058`
  shipped detection for but never parsed (its own stated gap). Needs
  real captured output per runner, same evidence standard `044` used.
- `create_dockercompose`'s YAML indentation bug — `specs/042`'s own
  flagged-but-unfixed incidental finding.

**Exit gate:** real fixture projects per ecosystem, run live through the
real agent — `058`'s own standard (detection alone is insufficient; the
command must actually run and report real counts).

---

## Phase C — Testing writes tests

**Risk class 3** (and class 4 for unknown stacks, once B lands).
Approved and promoted ahead of a general Coder Agent (decision 6).

- New Testing skill: generate test files for a target, written under the
  existing `specs/040` approval-with-content-diff flow — the same shape
  `generate-readme` already uses, so the review surface is precedented.
- Then **actually run them** via existing `run_tests` (or Phase B's
  `run_command` for an unsupported stack) and report real pass/fail.
  The generate→verify loop closing inside a single agent.
- Gives Testing its first LLM harness, fixing finding 5.
- Why this is the right first code-authoring step: a bad test file fails
  loudly and harmlessly; bad source code fails quietly. Same reasoning
  that made Documentation the first harness target in `041`.
- Design constraints for its spec: never overwrite an existing test file
  without showing the diff; never modify source under test; generated
  tests must be *runnable* (a test that cannot execute is a failure of
  this skill, not a neutral outcome).

**Exit gate:** real generated tests for a real project, approved, run
live, producing genuine pass/fail — including the case where the
generated tests legitimately *fail* against buggy source, which must
read as a real finding rather than a skill error.

---

## Phase D — Code Review Agent (read-only)

**Risk class 1 + LLM.** Depends on A3 (`git-diff`).

- First genuinely new agent. Consumes `git-diff` + `read_project_file`,
  runs an LLM harness, **writes nothing** — so no approval gate is
  needed at all, the same reasoning that made Security the safest of
  `041`–`043`.
- Grounding constraint inherited from `043`'s CVE guard: every comment
  must reference a real file and line present in the real diff; the
  validator rejects one that cites anything absent from it.
- Proves, at minimal risk, the full new-agent integration path:
  registry/`KNOWN_AGENTS`, live capability-snapshot participation (so
  the LLM router names its skills with zero routing changes),
  TUI/dashboard visibility, its own configurable port (`specs/073`),
  guided-init `AGENT_CATALOG` entry.

**Exit gate:** a real review of a real diff in this repository, with a
planted issue it must catch and a planted non-issue it must not invent;
plus confirmation the router names its skill with no hardcoded change.

---

## Phase E — Coder Agent (write-capable source edits)

**Risk class 5.** Gated on **both** C and D verified — they are strictly
smaller versions of the same two risks (model-authored files;
diff-based review).

Sketch only; needs its own spec *and* plan:

- New edit tooling beyond `write_project_file`'s whole-file write — a
  reviewable edit needs anchored/range replacement.
- A diff-based approval preview materially larger than any existing card
  (`specs/040` is the foundation; multi-file source review is a distinct
  UI problem).
- Hard scoping of what it may touch, including an explicit answer to
  "may it edit this repository."
- The model supplies content, never a command or executable — except
  through Phase B's own gated primitive.

**Not specced further until C and D close**, deliberately, so it
inherits real evidence rather than assumptions.

---

## Phase F — Security depth / external data

**Risk class 6.** Independent of C–E; can follow B′ any time.

- Real vulnerability data (CVE/advisory) and/or license checking — what
  would let `audit-dependencies` make the claims `specs/043`
  structurally forbids today precisely because nothing can ground them.
- **Requires a policy decision first:** may an agent reach an external
  network service per task? Today the only outbound calls are LLM
  provider calls and `specs/063`'s setup-time model listing. This would
  be the first runtime, per-task external dependency, with its own
  offline/rate-limit/failure semantics.

**Exit gate:** the policy decision recorded, then a real audit against a
project with a genuinely known-vulnerable pinned dependency.

---

## Deferred open decisions

Recorded so they don't get lost, each explicitly **not** rejected:

1. **Hosted/remote MCP servers** (non-loopback, `https:`) — deferred
   with no loss of local capability (finding 7).
2. **External/internet A2A agents** — deferred per decision 4. Needs
   real A2A spec conformance (today's protocol is explicitly an
   approximation) plus a trust decision about sending project paths and
   task content to a remote service.

`git_commit` is **no longer on this list** — Yusuf reversed the first
draft's recommendation 2026-09-12; it's connected in Phase A (A3′) like
every other orphaned tool.

---

## Live results log

- **Roadmap drafted 2026-09-12**, revised the same day after Yusuf's
  decisions (recorded in `spec.md` → Decisions Taken). Inventory
  source-verified: 13 MCP tools; DevOps 7 / Testing 1 / Documentation
  2 / Security 0 direct-`fs`; 4 tools orphaned; one MCP endpoint per
  agent; loopback-only confirmed not to block *local* third-party
  servers.
- **Approved 2026-09-12 by Yusuf** ("ok started"), with one correction
  to the draft: `git_commit` connected in Phase A (A3′), not left
  orphaned.
- **Phase A implemented 2026-09-12** (`specs/079-phase-a-connect-
  orphaned-tools/spec.md`, `verification: partial`). All of A1–A6
  landed: `build-image`/`docker-status`/`git-diff`/`commit-changes`
  connected; `docker_run`/`lint_ci_workflow`/`audit_dependencies_local`
  added; `safeExec()`'s argv fix (which turned out to also fix a
  real, already-live multi-word-commit-message bug, not just the
  spaced-path case); `OrchestraiMultiMcpClient` added or multi-endpoint
  support. Live-verified against real processes: `git-diff` and
  `docker-status` both genuinely round-tripped; `commit-changes`'s full
  flow (preview → drift-refusal → real commit landing, confirmed in
  `git log`) all live-proven against a real scratch git repo.
  `build-image`/`verify-deployment` and the two Docker-dependent unit
  tests are blocked on a live Docker daemon (none in this sandbox) —
  needs Yusuf's machine. A genuinely third-party MCP server as a second
  endpoint was checked and found to need a stdio bridge (most community
  servers, including the official filesystem one, are stdio-only,
  structurally distinct from this HTTP-only client) — the generic
  multi-endpoint mechanism itself is live-proven against two real,
  separate HTTP servers instead; see `specs/079`'s own verification.md
  for the full finding. Phase B/B′ not started.
