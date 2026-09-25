---
id: 058-testing-agent-multi-ecosystem-runner-detection
title: Testing Agent — Real Multi-Ecosystem Runner Detection, Never a Guess
area: testing-agent
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-05
updated: 2026-09-06
approved_by: Yusuf
approved_on: 2026-09-06
implemented_on: 2026-09-06
amends:
  - 001-testing-agent
supersedes:
  - 053-production-readiness-foundation
superseded_by: []
related:
  - 044-conversational-ask-layer
  - 057-project-snapshot-and-cross-request-reuse
---

# Spec: Testing Agent — Real Multi-Ecosystem Runner Detection, Never a Guess

> Review gate: **APPROVED 2026-09-06 by Yusuf.** Split out of
> `specs/053-production-readiness-foundation/spec.md` §4 at Yusuf's
> request.

## Purpose

`packages/shared/test-runner.ts`'s `detectRunner()` classifies **any**
project with a `package.json` containing a `scripts.test` string as
`"bun"` — regardless of whether the project actually uses npm, pnpm,
yarn, Jest, Vitest, or anything else. Confirmed directly, 2026-09-05
(`detectRunner()`, line 49: `if (pkg.scripts && typeof pkg.scripts.test
=== "string") return "bun"`). For a real Node/Jest project, this
produces a wrong runner command in the approval preview a human is asked
to sign off on — not a crash, a *plausible-looking wrong answer*, which
is a worse failure mode than an explicit "I don't know."

## Verified Current State

- `packages/shared/test-runner.ts`: `Runner = "bun" | "pytest" | "none"`.
  `RUNNER_ARGV` hardcodes exactly these two real commands
  (`["bun","test"]`/`["python","-m","pytest"]`, plus their `--coverage`/
  `--cov` variants). `detectRunner()` checks `requirements.txt`/
  `pyproject.toml` for `pytest`, and otherwise treats *any*
  `package.json` with a test script as Bun.
- `packages/agents/testing/index.ts`: `agentCard.skills` advertises
  `run-tests` and `check-coverage`; both require human approval before
  execution ("Executing a runner requires human approval" — the agent's
  own Agent Card description, confirmed verbatim). Execution uses
  `Bun.spawn()` with a fixed argv array, `shell:false` — this spec does
  not change that boundary.
- `parseTestCounts()`/`parseCoveragePercent()`
  (`packages/shared/test-runner.ts`, the latter added by `specs/044`)
  parse real captured output from exactly the two supported runners
  above; no other runner's output format is recognized today.
- No existing test fixture exercises a non-Bun Node project, a Go
  project, a Rust project, or any other ecosystem against this agent.

## Proposed Behavior

`detectRunner()` is replaced by a real, manifest/lockfile/test-file-
pattern-based detector, not a `package.json`-presence heuristic. It must
recognize, where explicitly implemented and only where genuinely
detectable with confidence:

- **Bun** — `bun.lock`/`bun.lockb` present, or `package.json` without a
  competing lockfile;
- **npm** — `package-lock.json` present;
- **pnpm** — `pnpm-lock.yaml` present;
- **yarn** — `yarn.lock` present;
- **Jest** — a `jest` config file or `package.json`'s own `jest` key, or
  `jest` present in `devDependencies`;
- **Vitest** — analogous detection via `vitest.config.*`/
  `devDependencies`;
- **pytest** — unchanged from today, `requirements.txt`/`pyproject.toml`
  naming it.

Ecosystems named in `specs/053`'s original draft but **not** committed
to in this spec's own scope (Go, Rust, Maven/Gradle, .NET) are
explicitly deferred — see Out of Scope. Adding a new supported profile
here means adding both its detection rule and its `RUNNER_ARGV` entry
together; a profile is never "half-detected."

**When more than one profile is plausible** (e.g. both `package-lock.json`
and `bun.lock` present, or a `package.json` test script exists with no
recognizable framework signal), the agent reports the ambiguity in its
result and asks the human which to use — it never silently picks one.
**When no profile is recognized at all**, the result says so explicitly,
distinct from a genuine "found tests, they failed" result.

Execution stays exactly as strict as today: fixed-argv, `shell:false`,
timeout-bounded, output-bounded, approval-gated. This spec changes what
runner is *selected* and *reported*, never how one is *executed*.

Results additionally distinguish, where the underlying signal allows it:

- a genuine test failure (the runner ran, some tests failed);
- a runner failure (the runner itself errored — wrong flags, crashed);
- an unsupported/ambiguous profile (no runner attempted at all);
- a timeout;
- an MCP/provider-layer failure (unrelated to the tests themselves).

## Scope

- `packages/shared/test-runner.ts`: the detector rewrite, `RUNNER_ARGV`
  additions for each newly-supported profile, and the ambiguity/
  unsupported result shapes.
- `packages/agents/testing/index.ts`: surfaces the new result
  distinctions (failure kind) in its existing task result/approval
  preview shape — no new endpoint, no new skill id.
- No change to `Bun.spawn()`'s argument-array/`shell:false` boundary, the
  approval requirement, or the existing timeout/output-size bounds.

## Safety and Compatibility Constraints

- **No free-form command, shell fragment, or caller-supplied executable
  is ever accepted** — every newly-supported profile's command is a
  fixed, hand-written argv array in `RUNNER_ARGV`, the same shape the
  existing two entries already use. Detecting *which* fixed command to
  run is the entire scope of this spec; it never becomes "run whatever
  the manifest says to run."
- **An ambiguous or unsupported project fails to a clear, honest report,
  never a guess** — this is the specific defect this spec exists to fix,
  restated as a hard constraint on the fix itself.
- **No change to the approval gate** — `run-tests`/`check-coverage`
  remain approval-required exactly as today, regardless of which
  profile was detected.
- Existing Bun/pytest detection and execution stay byte-identical for
  every project shape the current suite already covers — this is an
  addition of new, previously-absent capability, not a rewrite of what
  already works.

## Out of Scope / Non-Goals

- Go, Rust, Maven/Gradle, and .NET support — named in the original
  combined draft but deliberately deferred here; each is a distinct
  ecosystem with its own manifest/lockfile/test-pattern conventions and
  deserves its own evidence-grounded pass rather than being bundled in
  sight-unseen. A follow-up spec can add any of them using this spec's
  own detection-plus-argv pattern once real project fixtures exist to
  verify against.
- Result caching/reuse across requests — `specs/057`'s own snapshot
  layer, if approved, is a separate integration point; this spec's
  results are always freshly computed.
- Any change to `Bun.spawn()`'s security boundary, timeout bound, or
  output-size cap.
- A generic "run any test command" capability of any kind.

## Acceptance Criteria

- [x] A real Node/Jest fixture project is correctly detected as Jest,
      not Bun (the exact regression this spec exists to fix).
- [x] A real Node/Vitest, npm, pnpm, and yarn fixture project are each
      correctly detected.
- [x] A project with two plausible profiles reports ambiguity and asks
      for a choice, rather than picking one silently.
- [x] A project with no recognizable profile reports "unsupported,"
      distinct from "tests ran and failed."
- [x] Existing Bun/pytest fixtures are unaffected — same detected
      profile, same command, same result shape as before this spec.
- [x] Results distinguish test failure / runner failure / unsupported /
      timeout / MCP failure in at least one fixture case each.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Verification Plan

- Pure tests against real, minimal fixture directories for each newly-
  supported profile (a real `package.json` + real lockfile, not a
  hand-typed detection-only stub) plus the existing Bun/pytest fixtures
  re-run to confirm no regression.
- A live pass: a real scratch Jest project and a real scratch Vitest
  project each dispatched through the actual agent, approved, and
  confirmed to run the correct real command with real pass/fail counts
  — not just that detection alone picked the right label.
- The ambiguity and unsupported-profile cases each confirmed live
  against a real constructed fixture, not simulated.

## Approval Requested

Not yet requested. This spec needs Yusuf's review and explicit approval
before any implementation, per CLAUDE.md Working procedure step 8.
