# Verification — specs/077-agent-enabled-means-llm-on-by-default

Implemented and recorded 2026-09-14, same session as approval.

## Scope correction found during implementation, not assumed away

This spec's own "Verified Current State" claimed Testing Agent "has no
`model-factory.ts`, no harness flag at all — genuinely out of scope."
That was already stale by the time implementation began: `specs/080`
(implemented the same day as this spec's own draft) gave Testing its
own `packages/agents/testing/model-factory.ts` and
`ORCHESTRAI_TESTING_LLM_HARNESS` flag. Confirmed directly with Yusuf
before implementing (not assumed): **Testing is now in scope too**,
flipped the same way as DevOps/Documentation/Security. See the spec's
own amended opening blockquote for the full record.

## What changed

1. **Four `model-factory.ts` files flipped**
   (`packages/agents/{devops,documentation,security,testing}/
   model-factory.ts`): `isHarnessFlagSet()` changed from
   `env.ORCHESTRAI_<AGENT>_LLM_HARNESS === "1"` to `!== "0"` — absent,
   empty, or any value other than the literal string `"0"` now means
   on. The `readLlmHarnessStartupState()` "disabled" summary text was
   reworded from `"disabled (default)"` to `"disabled (explicit
   opt-out — ORCHESTRAI_<AGENT>_LLM_HARNESS=0)"`, more accurate now
   that disabled is no longer the default. `isExternalDataFlagSet()`
   (`specs/084`, Security's separate network-access flag) is completely
   untouched — confirmed by reading the file, not just claimed.

2. **Code Review/Coder deliberately excluded, structurally, not by
   convention.** `AGENT_LLM_HARNESSES` (`apps/supervisor/
   init-wizard.ts`) gained a `defaultOn` field: `true` for the four
   agents above, `false` for `code-review-agent`/`coder-agent` — those
   two have no deterministic fallback at all (`review-diff`/`edit-file`
   produce nothing without a working LLM call), a materially bigger
   default-behavior change this spec never proposed making for them.
   Their own `model-factory.ts` files are untouched, confirmed by
   `git diff` showing zero changes to either.

3. **`resolveAgentLlmKeyRequirements()`** (`apps/supervisor/index.ts`)
   now reads each row's own `defaultOn` field instead of one uniform
   `=== "1"` check: a `defaultOn` row is "on" whenever its env var isn't
   `"0"`; a non-`defaultOn` row still needs an explicit `"1"` — matching
   each agent's own `isHarnessFlagSet()` condition exactly, so the
   non-blocking startup warning (`specs/064`) fires for exactly the
   agents whose harness is genuinely active.

4. **The classic wizard's per-agent y/n question is deleted**
   (`apps/supervisor/init-wizard.ts`'s `runInitWizardInner()`): every
   selected agent with a harness now writes `agentLlm[field] = true`
   unconditionally, over the full `AGENT_LLM_HARNESSES` table (Code
   Review/Coder included, matching `formStateToWizardConfig()`'s own
   existing behavior for those two — writing an explicit `=1` for them
   when selected was already correct and is unrelated to this spec's
   own runtime-default change).

## A real test regression found and fixed, not assumed away

Flipping the runtime default broke 12 pre-existing tests across 6
files, all of which had implicitly relied on "no env var set" meaning
"harness off" — exactly the assumption this spec exists to invert:

- **`apps/supervisor/startup-llm-key.test.ts`** — fully rewritten: new
  cases for "no env var set → on by default," "`=0` → real opt-out,"
  and a second describe block confirming Code Review/Coder's own
  opt-in-only behavior is unaffected.
- **Three `model-factory.test.ts` files** (devops/documentation/
  security) — each gained a "no env var set → on by default" test and
  an explicit `=0`-opt-out test, replacing the old "not opted in" tests
  that no longer described real behavior.
- **`packages/agents/skill-ownership-http.test.ts`** — this file tests
  `specs/030`'s skill-ownership/dispatch mechanics, not any harness;
  added a file-scoped `beforeAll`/`afterAll` that explicitly sets all
  four harness vars to `"0"` for the file's duration, so its
  deterministic-path assertions (e.g. `dockerize` reaching
  `input-required` via `create_dockerfile`, never the harness) stay
  correct and intentional rather than accidentally exercising the new
  default.
- **`packages/agents/devops/index.test.ts`** — the one test
  specifically about the harness-OFF `run-command` fallback now sets
  `ORCHESTRAI_DEVOPS_LLM_HARNESS=0` explicitly for its own duration.
- **`packages/agents/testing/index.test.ts`** — same fix for the
  equivalent "state 1, harness off" test.

## Unit-level

- Each of the four agents' `model-factory.test.ts`: on-by-default
  (absent var), explicit `=0` opt-out (byte-identical `null` config to
  the old disabled state), explicit `=1` unaffected — all three states
  covered per agent.
- `apps/supervisor/startup-llm-key.test.ts`: default-on agents' full
  matrix (absent/`"0"`/`"1"`/any-other-value), plus Code Review/Coder's
  own still-opt-in-only behavior as a separate describe block.
- `bun run typecheck` — 0 errors.
- Full suite — 1076 pass, 0 fail, 2575 `expect()` calls, confirmed
  stable across two consecutive runs.

## What was not live-verified

No live provider credentials were available at the point this
implementation finished in this session (this session's own Gemini
free-tier quota had already been exhausted twice earlier the same day —
see specs/055's and specs/075's own `verification.md`/CLAUDE.md
records). The spec's own Verification Plan calls for a live pass:
starting DevOps with no harness variable set at all and confirming a
real `dockerize` call genuinely uses the LLM path (real app-type
detection from file content, `042`'s own original live-verification
scenario) rather than the old deterministic guess, plus the same
scenario with `=0` confirming the exact original deterministic output
returns. Neither was performed live this session — recorded honestly,
not assumed proven by the unit-level `isHarnessFlagSet()`/
`readLlmHarnessConfig()` coverage alone, real as that coverage is.
`verification` stays `pending` until a live pass confirms this; the
mechanism itself (the boolean flip, unit-tested exhaustively) is not in
doubt — what's unconfirmed is the live behavioral claim ("richer
content, not a template") the acceptance criteria themselves assert.

## Out of scope, confirmed untouched

- Any change to what a harness actually does once active — only
  whether it's active by default; every harness's own internal logic
  (`runReadmeHarness()`, `runRunCommandHarness()`, `runEnrichment()`,
  etc.) is untouched, confirmed via `git diff --stat`.
- The Orchestrator's own adaptive-supervisor requirement (`specs/051`)
  — already unconditional, untouched.
- `specs/070`'s TUI/browser form behavior — already correct before this
  spec; this only brought the classic wizard in line with it.
- Per-component provider/model/key resolution (`specs/039`/`063`) — no
  change to `readLlmModelConfig()` or any provider-resolution logic.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**Correction, 2026-09-14 — no longer opt-in.**
`specs/077-agent-enabled-means-llm-on-by-default/spec.md` (implemented,
**pending** verification) flipped `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS`
from opt-in (`=== "1"`) to opt-out (`!== "0"`): starting Documentation
at all now activates its real harness unless explicitly disabled with
`=0`. Yusuf's own words: *"enabling an agent should mean you will make
it llm just that."* Everything else in this section is unchanged —
same mechanism, same fail-closed behavior once active, same `=1`
behavior for anyone who already set it explicitly. See that spec's own
section below for the full record, including why this needed a live
pass this session didn't have credentials left to perform.

**Correction, 2026-09-14 — no longer opt-in.**
`specs/077-agent-enabled-means-llm-on-by-default/spec.md` (implemented,
**pending** verification) flipped `ORCHESTRAI_DEVOPS_LLM_HARNESS` from
opt-in (`=== "1"`) to opt-out (`!== "0"`): starting DevOps at all now
activates its real harness (app-type detection, real `include_docker`/
service-dependency detection) unless explicitly disabled with `=0`.
Everything else in this section is unchanged. See `specs/077`'s own
section below for the full record.

**Correction, 2026-09-14 — no longer opt-in.**
`specs/077-agent-enabled-means-llm-on-by-default/spec.md` (implemented,
**pending** verification) flipped `ORCHESTRAI_TESTING_LLM_HARNESS` from
opt-in (`=== "1"`) to opt-out (`!== "0"`) — added to that spec's own
scope mid-implementation once it was found Testing already had a
harness (this section) despite that spec's own drafting-time claim
otherwise. Starting Testing at all now activates its harness (the
`run_command` proposal for an unsupported stack, and `write-tests`'s
own authoring call) unless explicitly disabled with `=0`. See
`specs/077`'s own section for the full record.

**Correction, 2026-09-14 — no longer opt-in.**
`specs/077-agent-enabled-means-llm-on-by-default/spec.md` (implemented,
**pending** verification) flipped `ORCHESTRAI_SECURITY_LLM_HARNESS`
from opt-in (`=== "1"`) to opt-out (`!== "0"`): starting Security at
all now activates its real AI-commentary enrichment layer unless
explicitly disabled with `=0`. Completely independent of
`ORCHESTRAI_SECURITY_EXTERNAL_DATA` (`specs/084`, real OSV.dev network
access) — that flag stays genuinely opt-in, untouched by this spec.
Everything else in this section is unchanged, including the
fail-open-on-report/fail-closed-on-claim behavior once active. See
`specs/077`'s own section below for the full record.

`specs/077-agent-enabled-means-llm-on-by-default/spec.md` (implemented,
**pending** verification, 2026-09-14; amends `039`/`041`/`042`/`043`/
`031`/`080`) flips the runtime default for all four of this codebase's
agent-level LLM harnesses — DevOps, Documentation, Security, and
Testing. Yusuf's own words: *"enabling an agent should mean you will
make it llm just that."* `specs/070` already made this true for the
guided-init TUI/browser forms (selecting an agent there writes its
harness `=1`); this spec makes it true everywhere else — the runtime
itself, and the classic prompt wizard.

**The flip, one line per agent**: each `model-factory.ts`'s
`isHarnessFlagSet()` changed from `=== "1"` (opt-in) to `!== "0"`
(opt-out) — absent, empty, or anything but the literal string `"0"`
now means on. `=0` remains a real, permanent, working opt-out for a
cost-conscious or key-less setup. `=1` is completely unaffected.

**A real scope correction found during implementation, not assumed
away**: the spec's own drafting-time claim that Testing "has no
harness, genuinely out of scope" was already stale by the time
implementation began — `specs/080` gave Testing its own harness the
same day. Confirmed directly with Yusuf before implementing: Testing
joined the other three, flipped the same way.

**Code Review and Coder deliberately stayed genuinely opt-in in this
spec's own scope** — `AGENT_LLM_HARNESSES` (`apps/supervisor/
init-wizard.ts`) gained a `defaultOn` field, `false` for exactly those
two: they have **no deterministic fallback at all** (`review-diff`/
`edit-file` produce nothing without a working LLM call), a materially
bigger default-behavior change than "richer content instead of a
template," which is all the other four ever risk.
`resolveAgentLlmKeyRequirements()` (`apps/supervisor/index.ts`) reads
this field directly so the supervisor's own non-blocking startup key
check (`specs/064`) keeps matching each agent's real condition exactly,
rather than drifting from it. **Superseded the same day —
`specs/086-code-review-coder-default-on/spec.md` flips these two as
well**, once Yusuf confirmed directly that the fail-per-task/
warn-at-startup consequence (stated plainly, not assumed) was the
intended tradeoff. See that spec's own section below.

**The classic wizard's per-agent y/n harness question is deleted** —
every selected agent with a harness now writes `=1` unconditionally,
the same rule `formStateToWizardConfig()` (`specs/070`) already applies
to the TUI/browser forms. All three surfaces agree for the first time:
selecting the agent is the only decision.

**A real test regression found and fixed, not assumed away**: flipping
the default broke 12 pre-existing tests across 6 files that had
implicitly relied on "no env var set" meaning "harness off" — exactly
the assumption this spec inverts. Fixed by rewriting the affected
tests to either assert the new default-on behavior directly, or (for
files genuinely about something else, like `skill-ownership-http.
test.ts`'s `specs/030` dispatch-mechanics coverage) explicitly opting
the harness out for that file's own duration so its deterministic-path
assertions stay intentional. 1076 tests pass (0 fail, confirmed stable
across two consecutive runs), typecheck clean.

**Not yet live-verified**: no live provider credentials were available
at the point this implementation finished in this session (the day's
own Gemini free-tier quota had already been exhausted twice earlier the
same day — see specs/055's and specs/075's own records). The spec's own
Verification Plan — a real `dockerize` call with no harness variable
set at all genuinely using real app-type detection, and the identical
scenario with `=0` reproducing the exact original deterministic output
— was not performed live this session. The mechanism itself (the
boolean flip) is exhaustively unit-tested and not in doubt; what's
unconfirmed is the live behavioral claim the acceptance criteria
themselves assert. See `specs/077`'s own `verification.md` for the
complete record.

See specs/094-analyze-project-security-precheck-opt-in/verification.md for the relocated narrative covering this checkpoint.

See specs/100-document-api-grounded-llm-route-discovery-fallback/verification.md for the relocated narrative covering this checkpoint.

See specs/106-persistence-store-and-result-cache/verification.md for the relocated narrative covering this checkpoint.

See specs/086-code-review-coder-default-on/verification.md for the relocated narrative covering this checkpoint.
