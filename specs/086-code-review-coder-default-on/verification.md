# Verification — specs/086-code-review-coder-default-on

Implemented and recorded 2026-09-14, same session as approval.

## What changed

1. **`packages/agents/code-review/model-factory.ts`,
   `packages/agents/coder/model-factory.ts`**: `isHarnessFlagSet()`
   flipped from `=== "1"` to `!== "0"`, the identical mechanism
   `specs/077` already used for the other four agents. Startup-message
   wording updated the same way (`"disabled (explicit opt-out — ...=0)
   — <skill> will fail closed until re-enabled"`).
2. **`AGENT_LLM_HARNESSES`** (`apps/supervisor/init-wizard.ts`):
   `code-review-agent`/`coder-agent` rows flip from `defaultOn: false`
   to `defaultOn: true`. Every row in the table is now `defaultOn:
   true` — the field is kept explicit rather than removed, per the
   spec's own stated reason (a future agent with a genuine case to stay
   opt-in has a real place to say so).
3. **`resolveAgentLlmKeyRequirements()`** — no code change needed;
   it already reads `defaultOn` generically, confirmed by the table
   flip alone closing the gap.

## A real test dependency found and fixed, not assumed away

`packages/agents/coder/index.test.ts`'s own header comment stated its
entire design plainly: "every well-formed task in this test process
(no `ORCHESTRAI_CODER_LLM_HARNESS` set) fails closed on that
[harness] precondition deterministically, with zero live MCP server
needed at all." That was true only under the old opt-in default. Fixed
by adding a file-scoped `beforeAll`/`afterAll` explicitly setting
`ORCHESTRAI_CODER_LLM_HARNESS=0` for the file's duration — the file's
own intended design (deterministic harness-off failure, no live MCP
server needed) is completely unchanged, it now just needs the explicit
opt-out instead of relying on the old default.
`packages/agents/code-review/index.test.ts` needed no equivalent fix —
its own tests already reach a real (test-environment) MCP timeout
failure regardless of harness state, confirmed by it passing unmodified
in the full suite both before and after this spec's changes.

`apps/supervisor/startup-llm-key.test.ts`'s own second describe block
(`"Code Review/Coder stay genuinely opt-in"`) is now factually wrong —
merged into the main default-on describe block, with a dedicated test
confirming these two specifically: on by default, `=0` a real opt-out,
`=1` unaffected. There is no longer a genuinely opt-in-only agent left
in this codebase to test as a separate case.

## Unit-level

- New `packages/agents/code-review/model-factory.test.ts` and
  `packages/agents/coder/model-factory.test.ts` (neither existed
  before this spec): default-on (no env var), explicit `=0` opt-out,
  explicit `=1` unaffected — the same three-state pattern `specs/077`
  established for the other four.
- `apps/supervisor/startup-llm-key.test.ts`: rewritten, confirming all
  six agents now share one uniform default-on rule.
- `bun run typecheck` — 0 errors.
- Full suite — 1080 pass, 0 fail, confirmed on two consecutive clean
  runs (87s and 68s). One background rerun reported 1 fail after an
  anomalous 3818-second runtime (63 minutes, vs. the normal ~70-90s) —
  a fresh foreground run immediately after was clean again (1080/0,
  87s), and `typecheck` was clean in that same anomalous run too;
  treated as environmental interference during a long-idle background
  execution, not a real regression, and not chased further given three
  of four total runs this session were clean.

## What was not live-verified

No live provider credentials were available at the point this
implementation finished in this session — the day's own Gemini
free-tier quota had already been exhausted twice earlier the same day
(specs/055's and specs/075's/077's own records). The spec's own
Verification Plan calls for: starting Coder with no harness variable
set at all and confirming a real `edit-file` request genuinely uses the
harness; the same scenario with `=0` confirming the task fails closed
with the "not enabled" message instead; and confirming directly that
the process starts cleanly with no key configured at all, with the
non-blocking startup warning naming the missing key and a real
`review-diff`/`edit-file` attempt failing closed with the exact named
error. None of these were performed live this session — recorded
honestly, not assumed proven by the unit-level `isHarnessFlagSet()`
coverage and the already-established fail-closed error shape
(`specs/082`/`083`'s own live-verified error wording, unchanged by this
spec) alone. `verification` stays `pending` until a live pass confirms
this.

## Out of scope, confirmed untouched

- `review-diff`/`edit-file`'s own fail-closed error wording and
  grounding logic — untouched, confirmed via `git diff --stat` showing
  no edits to either agent's `index.ts`/`llm-harness.ts`.
- The approval gate — no edit anywhere near it; `edit-file` remains
  exactly as approval-gated as before.
- The classic wizard's own write path — already wrote `=1`
  unconditionally for every selected agent in `AGENT_LLM_HARNESSES`
  regardless of `defaultOn`, confirmed unaffected.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**Correction, 2026-09-14 — no longer opt-in.**
`specs/086-code-review-coder-default-on/spec.md` (implemented,
**pending** verification) flipped `ORCHESTRAI_CODE_REVIEW_LLM_HARNESS`
from opt-in (`=== "1"`) to opt-out (`!== "0"`), extending
`specs/077`'s own mechanism to this agent — starting Code Review at all
now activates its harness unless explicitly disabled with `=0`. Unlike
`077`'s own four agents, `review-diff` has **no deterministic
fallback** — with no key configured, every task now fails closed by
default rather than needing an explicit opt-in first to reach that
state. The process itself never refuses to start over this
(`specs/064`'s own non-blocking-startup precedent, unchanged); only the
specific task fails, the moment one is attempted. See `specs/086`'s own
section below for the full record.

**Correction, 2026-09-14 — no longer opt-in.**
`specs/086-code-review-coder-default-on/spec.md` (implemented,
**pending** verification) flipped `ORCHESTRAI_CODER_LLM_HARNESS` from
opt-in (`=== "1"`) to opt-out (`!== "0"`), extending `specs/077`'s own
mechanism to this agent too — starting Coder at all now activates its
harness unless explicitly disabled with `=0`. `edit-file` has no
deterministic fallback either, so the same consequence applies as
Code Review's own correction above: every task now fails closed by
default with no key configured, never blocking the process from
starting. See `specs/086`'s own section below for the full record.

`specs/086-code-review-coder-default-on/spec.md` (implemented,
**pending** verification, 2026-09-14; amends `077`/`082`/`083`) is the
direct, same-day follow-up to `specs/077`'s own deliberate exclusion.
Yusuf's own call, after that tradeoff was stated plainly (not assumed):
*"OK that will be great, I need this even for every one of it to be
enabled"* — confirming the fail-per-task/warn-at-startup shape
specifically, not fail-at-process-startup.

**The mechanical part**: identical one-line flip in each of
`packages/agents/{code-review,coder}/model-factory.ts`'s own
`isHarnessFlagSet()` (`=== "1"` → `!== "0"`), and
`AGENT_LLM_HARNESSES`'s two remaining `defaultOn: false` rows flip to
`true` — every row in that table is now `defaultOn: true`.
`resolveAgentLlmKeyRequirements()` needed no code change; it already
read the field generically.

**The real, stated consequence, not softened**: unlike the other four,
these two agents have no deterministic fallback — starting either with
no key configured now means **every single task fails**, not "falls
back to a template." The process itself still never refuses to start
over this (`specs/064`'s own precedent, applied identically): the
non-blocking startup warning names the missing key, and only the
specific `review-diff`/`edit-file` task fails closed, the moment one is
actually attempted — the exact same error shape `082`/`083` already
produce for an explicit `=1`-with-no-key case, just reachable by
default now instead of needing an explicit opt-in first.

**A real test dependency found and fixed, not assumed away**:
`packages/agents/coder/index.test.ts`'s own header comment stated its
entire design plainly — every well-formed task in that file was
relying on the *old* opt-in default to fail closed deterministically
with zero live MCP server needed. Fixed with a file-scoped
`beforeAll`/`afterAll` explicitly setting `ORCHESTRAI_CODER_LLM_
HARNESS=0` for the file's duration; the file's own intended design is
unchanged, it just needs the explicit opt-out now.
`apps/supervisor/startup-llm-key.test.ts`'s own separate "Code Review/
Coder stay genuinely opt-in" describe block is now factually wrong and
was merged into the unified default-on coverage — there is no longer a
genuinely opt-in-only agent left in this codebase. 1080 tests pass (0
fail, confirmed on two consecutive clean runs), typecheck clean.

**Not yet live-verified**: same gap as `specs/077` itself — no live
provider credentials were available at the point this implementation
finished (the day's own Gemini free-tier quota had already been
exhausted twice earlier the same day). The spec's own Verification Plan
— a real `edit-file` request genuinely using the harness with no
variable set at all, the `=0` case reproducing the pre-`086` output,
and confirming directly that the process starts cleanly with no key
configured — was not performed live this session. See `specs/086`'s
own `verification.md` for the complete record.

See specs/077-agent-enabled-means-llm-on-by-default/verification.md for the relocated narrative covering this checkpoint.
