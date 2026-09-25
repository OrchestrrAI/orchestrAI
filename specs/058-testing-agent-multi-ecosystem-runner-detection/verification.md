# Verification: Testing Agent — Real Multi-Ecosystem Runner Detection

Date: 2026-09-06

Result: **verified**.

## What changed

- `packages/shared/test-runner.ts`: `detectRunner()` now returns a
  `DetectionResult` (`{kind:"detected",runner}` |
  `{kind:"ambiguous",candidates}` | `{kind:"unsupported"}`) instead of a
  plain `Runner` string that conflated "no tests" with every unrecognized
  shape. Framework signals (Jest/Vitest config file or `devDependencies`)
  are checked ahead of package-manager lockfiles — a real Jest/Vitest
  project's framework and its package manager are complementary signals,
  not competing ones, so this ordering does not itself create ambiguity.
  Ambiguity is reserved for two conflicting signals of the *same* kind:
  two lockfiles, or two framework configs. `RUNNER_ARGV` gained five new
  fixed-argv profiles (`npm`, `pnpm`, `yarn`, `jest`, `vitest`) alongside
  the existing `bun`/`pytest` — every one a hand-written argv array, no
  free-form command ever accepted.
- `packages/agents/testing/index.ts` (`processTask`) and
  `packages/mcp/index.ts` (`run_tests` tool) — both call sites that used
  to branch on `runner === "none"` now branch on `detection.kind`,
  reporting `"unsupported"` exactly as `"none"` used to (unchanged
  message) and reporting `"ambiguous"` as a new, honest, non-error
  `completed` result naming the real conflicting candidates and asking
  for a resubmission — never a silent pick, never a `failed` task.

## Verified

- `bun run typecheck` — 0 errors.
- `bun test` — 727 pass, 0 fail, 1427 expectations across 48 files (up
  from the 717/1401 pre-change baseline: 19 tests now live in
  `test-runner.test.ts`, replacing the prior 9 — every acceptance
  criterion below has its own dedicated case against a **real** temp
  fixture directory, not a mock):
  - Existing Bun/pytest fixtures unaffected — same detected profile
    (`{kind:"detected",runner:"bun"}` for a bare `package.json` with no
    competing lockfile; `pytest` from `requirements.txt`) as before this
    spec.
  - Real Jest fixture (via `devDependencies.jest` **and** separately via
    a bare `jest.config.js`) → detected `jest`, not `bun` — the exact
    regression named in this spec's Purpose.
  - Real Vitest fixture → detected `vitest`.
  - Real npm/pnpm/yarn fixtures (a lockfile present, no framework
    signal) → detected `npm`/`pnpm`/`yarn` respectively.
  - Two conflicting lockfiles (`package-lock.json` + `pnpm-lock.yaml`) →
    `ambiguous`, candidates `["npm","pnpm"]`.
  - Two conflicting framework configs (`jest.config.js` +
    `vitest.config.ts`) → `ambiguous`, candidates `["jest","vitest"]`.
  - A malformed `package.json` falls through to the Python check rather
    than throwing.
  - `RUNNER_ARGV` — every one of the five new profiles has a non-empty
    `plain`/`coverage` argv array; the two pre-existing entries'
    argv is unchanged byte-for-byte.
- **Live pass against the real exported Hono app** (`app.fetch()`, no
  port bind — the same in-process technique specs/035 already
  established, chosen specifically so this did not require restarting or
  disturbing the already-running `testing-agent` session on `:3003`),
  submitting real A2A-envelope tasks against real temp-directory
  fixtures and reading back the real `GET /tasks/:id` approval preview a
  human would actually see:
  ```
  [jest]        status=input-required   would run: npx jest
  [vitest]      status=input-required   would run: npx vitest run --coverage
  [npm]         status=input-required   would run: npm test
  [ambiguous]   status=completed        Ambiguous — more than one test runner is plausible: npm, yarn.
  [bun-default] status=input-required   would run: bun test
  ```
  This is the decisive evidence for the acceptance criteria: the Jest
  fixture's approval preview correctly reads `npx jest`, never `bun
  test`; `check-coverage` against the Vitest fixture correctly appended
  `--coverage`; the ambiguous fixture (two real lockfiles) completed
  with an honest report and no approval/runner attempt at all; the
  pre-existing bare-`package.json` case is byte-identical to before this
  spec (`bun test`).

## Result-kind distinctions

The spec's "results additionally distinguish... test failure / runner
failure / unsupported / timeout / MCP failure" criterion is satisfied as
follows, confirmed by reading the code paths directly (not all five
re-verified via a fresh live run — the runner-failure/timeout/MCP-failure
paths are `resumeTask()`'s existing, unmodified error handling, already
covered by this repo's pre-existing test suite, and untouched by this
spec):
- **Unsupported** — new `{kind:"unsupported"}` branch, live-verified
  above (unchanged message from before this spec).
- **Ambiguous** — new `{kind:"ambiguous"}` branch, live-verified above.
- **Test failure** vs **runner failure** vs **timeout** vs **MCP
  failure** — unchanged, pre-existing `resumeTask()` logic
  (`parseTestCounts()` on a completed run vs. `callTool()` throwing vs.
  the MCP tool's own timeout/spawn-failure text) — this spec adds no new
  runner-failure/timeout classification of its own; it only fixes what
  profile is selected before execution.

## Out of scope, confirmed untouched

`git diff --stat` confirms the only files changed are
`packages/shared/test-runner.ts`, `packages/shared/test-runner.test.ts`,
`packages/agents/testing/index.ts`, and `packages/mcp/index.ts` — no
change to `Bun.spawn()`'s argument-array/`shell:false` boundary, the
approval gate, timeout bound (`FIXED_TEST_TIMEOUT_MS`), or output-size
cap (`TEST_OUTPUT_MAX_BYTES`), and no Go/Rust/Maven/.NET support added.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/058-testing-agent-multi-ecosystem-runner-detection/spec.md`
(implemented, **verified**) replaced `detectRunner()`'s old
`package.json`-presence guess (any project with a `scripts.test` string
was classified `"bun"`, wrong for a real npm/pnpm/yarn/Jest/Vitest
project) with real manifest/lockfile/config detection, returning a
`DetectionResult` (`detected` | `ambiguous` | `unsupported`) instead of a
plain string. Framework signals (Jest/Vitest config or `devDependencies`)
are checked ahead of package-manager lockfiles — complementary, not
competing, signals — so a real Jest project's own lockfile doesn't
trigger a false ambiguity; ambiguity is reserved for two conflicting
signals of the same kind (two lockfiles, or two framework configs), which
reports the real candidates and asks for a resubmission rather than
picking one silently. `RUNNER_ARGV` gained five new fixed-argv profiles
(`npm`, `pnpm`, `yarn`, `jest`, `vitest`) alongside the existing
`bun`/`pytest` — every one a hand-written argv array, same `shell:false`
boundary, same approval gate, unchanged. Go/Rust/Maven/.NET are
explicitly deferred. Live-verified via the real exported Hono app
(`app.fetch()`, no port bind) against real temp-directory fixtures: a
Jest fixture's approval preview correctly reads `npx jest` (never `bun
test`), a Vitest `check-coverage` fixture appended `--coverage`, an
npm/pnpm/yarn fixture resolved to its own `<pm> test`, a two-lockfile
fixture completed with an honest ambiguity report and no runner
attempted, and the pre-existing bare-`package.json` case stayed
byte-identical to before this spec.

See specs/080-run-command-approved-execution/verification.md for the relocated narrative covering this checkpoint.

See specs/081-testing-write-tests-skill/verification.md for the relocated narrative covering this checkpoint.
