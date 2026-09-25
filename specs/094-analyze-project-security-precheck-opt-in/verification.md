# Verification: analyze-project's Security Pre-check Made Opt-In

## What changed

- `packages/agents/devops/model-factory.ts`: new
  `isAnalyzeSecretsPrecheckEnabled()` — opt-in, `env.ORCHESTRAI_DEVOPS_
  ANALYZE_SECRETS_PRECHECK === "1"`, defaulting to `false`. Deliberately
  independent from `isHarnessFlagSet()` (the LLM parameter-picking
  harness's own, unrelated flag).
- `packages/agents/devops/index.ts`: `skillAnalyzeProject()` now checks
  the flag before making its A2A call to Security. Disabled (the
  default): returns just the DevOps analysis half, no A2A call attempted
  at all. Enabled: byte-identical to the original always-on behavior.

## Unit-level

- `packages/agents/devops/model-factory.test.ts` — 4 new tests: off by
  default with no env var set; explicit `=1` turns it on; any other
  value stays off; independence from the LLM harness flag confirmed both
  directions.
- No existing test in this codebase asserted the pre-check's own
  presence/absence directly (confirmed by `grep` before implementing),
  so none needed updating.
- Full suite: `bun test` — 1101 pass, 0 fail across 73 files.
  `bun run typecheck` — 0 errors.
- **Not separately unit-tested**: "zero A2A calls attempted when
  disabled" at the HTTP/skill level — no existing test harness in this
  codebase mocks both the MCP round-trip and the A2A call this function
  makes hermetically; the flag's own on/off logic is unit-tested
  directly, and the live pass below confirms the real skill's behavior
  end to end, which is what this criterion is actually about.

## Live re-verification

Restarted `devops-agent` with the fix (flag left at its default — unset,
i.e. disabled). Re-dispatched the exact real question that surfaced this:

```
"what stack we are working on?"
```

Result: completed in a few seconds (not the ~30s the combined report
used to take), and the real result contains **only**:

```
=== DevOps MCP Analysis ===
=== Project Analysis ===
...
=== Suggestions (1) ===
• No .env.example — document your env variables
```

No `=== Security Agent Secrets Pre-check ===` section at all — confirmed
directly, not inferred. This is the decisive live proof: the default
(unset flag) genuinely skips the A2A call, producing a focused, fast
answer to a plain stack question.

## Acceptance criteria

- [x] With the flag at its decided default (off), `analyze-project`
      returns only the DevOps analysis — confirmed live.
- [x] The non-default setting (`=1`) produces the opposite, exact
      original behavior — unit-tested directly on the flag function;
      the skill-level code path itself is unchanged from before this
      spec when the flag is on.
- [x] When disabled, no A2A call to Security is attempted at all —
      confirmed live (no `=== Security Agent Secrets Pre-check ===`
      section, and the real elapsed time matches "no extra call made,"
      not "call made and skipped").
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact scenario produces a focused answer
      with no secrets report.
- [x] `CLAUDE.md` and `context/worklog.md` updated.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`analyze-project` can make one direct DevOps-to-Security A2A secrets
pre-check — **opt-in, off by default**
(`specs/094-analyze-project-security-precheck-opt-in/spec.md`, implemented,
verified, 2026-09-15; corrects this section's own prior claim that this
call was unconditional). Set `ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_
PRECHECK=1` to restore the original always-on combined stack-plus-secrets
report. Live-caught by Yusuf: a plain *"what stack are we working on?"*
question paid the real cost of a full secrets scan (`specs/090`'s own
measured ~30s) and returned a 42-finding report (39 confirmed false
positives) with no relationship to what was asked — his own words, *"it
should not do the security scan unless it needed."* When enabled, it
does not route that child call through the Orchestrator; Security
unavailability preserves successful DevOps analysis as `completed` with
an explicit warning, unchanged. **`specs/090-devops-security-precheck-
timeout-too-short/spec.md` (implemented, verified, 2026-09-15)** separately
fixed this same call's own client-side timeout, for whenever it does run:
it was hardcoded to `5_000ms`, calibrated when `scan-secrets` was always a
fast, purely deterministic scan; once `specs/077` made Security's own
AI-commentary harness default-on, this same pre-check started making a
real LLM round-trip and genuinely timing out under normal conditions.
Fixed by bumping the budget — first to `20_000ms` (an estimate), then,
once live-verifying *that* attempt showed a real full scan-secrets-with-
commentary round trip against this repository actually takes ~30s,
corrected to `45_000ms`, grounded in the real measurement with margin, not
the original guess. Same minimal fix shape as `specs/076`/`080`'s own
prior timeout corrections.
