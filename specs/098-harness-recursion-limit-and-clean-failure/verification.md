# Verification: specs/098 — Harness Recursion Limit, Clean Failure, Coder Refusal Shape

## What changed

- **Fix 1 & 2 (all 5 harness files, 6 `graph.invoke()` call sites)**:
  `packages/agents/{coder,code-review,devops,documentation,testing}/
  llm-harness.ts` all gained a local `HARNESS_RECURSION_LIMIT = 20`
  constant and an explicit `{ recursionLimit: HARNESS_RECURSION_LIMIT }`
  passed to `graph.invoke()`. Each call site is now wrapped in a
  `try/catch` that catches `GraphRecursionError` (a real, exported
  LangGraph class) specifically and re-throws a clean, named error
  naming the real skill; every other error type is re-thrown completely
  unchanged.
- **Fix 3 (Coder only)**: `EditProposalSchema` became a discriminated
  union (`EditProposal | Refusal`); a new `RefusalSchema` (`{refused:
  true, reason: string}`); `buildEditFileSystemPrompt()` now names the
  target file's real extension and documents both response shapes,
  telling the model to refuse immediately (not keep exploring) when a
  request is structurally impossible for that file type;
  `validateNode()` recognizes a refusal immediately (no retry, no
  further exploration); `packages/agents/coder/index.ts` surfaces the
  model's own real reason as the task's error.

## Acceptance criteria

- [x] All six `graph.invoke()` call sites pass an explicit
      `recursionLimit: HARNESS_RECURSION_LIMIT` (`= 20`).
- [x] A scripted model that never stops calling the read-only tool
      produces the new clean, named error message — not LangGraph's raw
      internal text or troubleshooting URL — for every one of the five
      harness files (dedicated test per file).
- [x] A genuinely unrelated error thrown during `graph.invoke()` still
      propagates completely unchanged (dedicated test per file).
- [x] A scripted model returning Coder's new refusal shape immediately
      ends the run with the model's own real reason — zero further tool
      calls or retries after that response.
- [x] A scripted model returning Coder's normal edit shape is completely
      unaffected.
- [x] The exact real live-reproduced scenario is re-run live and now
      fails with a specific, real reason rather than exhausting the
      recursion budget.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] Every pre-existing test in the five affected files passes
      unmodified (Coder's own 5 pre-existing test assertions needed a
      narrowing fix for the new union return type — a mechanical
      follow-on of the type change itself, not a behavior change; a new
      `asEdit()` test helper makes this explicit).

## Test results

- `packages/agents/coder/llm-harness.test.ts`: 33 pass (net +6 new:
  recursion-limit clean message, unrelated-error passthrough, refusal
  immediate-stop, refusal-vs-normal-edit regression coverage).
- `packages/agents/devops/llm-harness.test.ts`: 22 pass (net +2).
- `packages/agents/code-review/llm-harness.test.ts`: net +2.
- `packages/agents/documentation/llm-harness.test.ts`: net +2.
- `packages/agents/testing/llm-harness.test.ts` (**new file** — no
  dedicated harness-level test file existed for Testing before this
  spec, a real pre-existing gap, not introduced here): 6 tests covering
  both of Testing's own graphs (`run-command` fallback, `write-tests`).
- `bun test` (full suite): 1148 pass, 0 fail (net +16 over specs/097's
  own 1132 baseline).
- `bun run typecheck`: 0 errors.
- `bun run specs:catalog`/`specs:check`: pass, 97 specs.

## Live verification

Against the real running stack (a real Gemini deployment, this
repository as the target project): restarted `coder-agent` alone to
load the new code (confirmed still discoverable by the Orchestrator's
own registry with no restart needed there).

Re-ran the exact real scenario that surfaced this bug — `edit
package.json: adding some comments` — through several iterations
finding the correct real request phrasing along the way (Coder's own
`extractTargetFileToken()` requires the filename directly after
`edit`/`modify`/`change`, and the shared `resolveTargetPath()` requires
an `at`/`in`/`to`/`from` trigger word before the project path; earlier
attempts hit these two genuine, pre-existing, unrelated parsing
requirements — not this spec's own bug — before landing on the correct
shape: `"edit package.json at <project root>: adding some comments"`).

**Result**: `{"error":"Cannot make this edit: Standard JSON
(package.json) does not support comments. Adding comments to a JSON
file would make it invalid JSON."}` — the model recognized the request
was structurally impossible immediately and refused with a real,
specific reason, rather than exhausting 20+ rounds of confused file
exploration and failing with LangGraph's own raw internal error text.
This is the decisive, direct confirmation of both Fix 2/3's own real
purpose: the root cause (an unsatisfiable instruction) is now
recognized fast, with a real explanation — not just a nicer failure
message after the same wasted exploration.

## Known limitations

- The recursion-limit backstop itself (Fix 1/2) was not forced live for
  a genuinely-hard-but-not-structurally-impossible case that legitimately
  needs the full 20-round budget before failing — covered exhaustively
  by the unit test suite instead (a scripted model that never converges,
  for every one of the five harness files).
- Testing's own harness-level test coverage was previously non-existent
  (a real, pre-existing gap found and closed as part of this spec's own
  acceptance criteria, not a new regression).

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**Every agent-level LangGraph harness gets an explicit recursion limit,
a clean failure message, and Coder gains a real refusal shape.**
`specs/098-harness-recursion-limit-and-clean-failure/spec.md`
(implemented, **verified**, 2026-09-15; amends `083`/`042`/`041`/`080`/
`081`/`082`) fixed a real gap Yusuf hit live: a real `edit-file`
request against Coder looped through many `read_project_file` calls and
failed with LangGraph's own raw internal error text (*"Recursion limit
of 25 reached... Troubleshooting URL: https://docs.langchain.com/..."*)
shown directly in the TUI. Checked directly: **every one of this
codebase's five real per-agent LangGraph harnesses** (DevOps,
Documentation, Testing — two graphs, Code Review, Coder — six total
`graph.invoke()` call sites) had **no explicit `recursionLimit`**,
silently relying on LangGraph's own internal default of 25 — the
adaptive supervisor's own `supervisor-graph.ts` was the only
`graph.invoke()` call site in the codebase that already set one
(`DEFAULT_RECURSION_LIMIT = 50`, `specs/028`). Fixed with a local
`HARNESS_RECURSION_LIMIT = 20` constant per file (matching this
codebase's own independent-per-agent-copy convention) and a `try/catch`
around each `graph.invoke()` call that catches `GraphRecursionError` —
a real, distinguishable class `@langchain/langgraph` exports, confirmed
directly in the installed package rather than string-matching the
message text — re-throwing a clean, named OrchestrAI error; every other
error type is re-thrown completely unchanged.

**Yusuf's own direct pushback during review** (*"but isn't it issue to
hit this limit?"*) correctly identified that a bound + nicer message
alone doesn't fix the real problem. Checked the actual live request:
`"edit package.json: adding some comments"` — **JSON has no valid
comment syntax at all**, so the request was structurally unsatisfiable
from the start, and the model had no way to say so — only encouragement
to keep exploring. Coder is the one harness in this codebase where this
specifically matters: unlike DevOps/Documentation/Testing (which each
write a fixed, always-valid content type for their own skill), Coder
edits an **arbitrary target file of whatever type the human names**
with an **arbitrary free-text instruction** — the one place "this
instruction is structurally impossible for this file type" is a real,
recurring risk category. Fixed with a real, structurally-recognized
refusal shape (not a prose instruction hoping the model behaves,
matching this spec's own preference for structural detection over
string-matching): `EditProposalSchema` became a discriminated union
(the existing edit shape, plus `{refused: true, reason: <string>}`);
`buildEditFileSystemPrompt()` names the target file's real extension
and documents both shapes; `validateNode()` recognizes a refusal
immediately — no retry, no further exploration; `index.ts` surfaces the
model's own real reason as the task's error. A refusal structurally
cannot reach the approval gate (no `old_text`/`new_text` at all), so
this is purely additive to the existing safety story, not a new write
path. Testing's own harness-level test coverage was found to be
completely absent before this spec (a real, pre-existing gap, not a
regression) — closed with a new `packages/agents/testing/
llm-harness.test.ts` covering both of its graphs.

1148 tests pass (net +16 over `specs/097`'s own 1132 baseline),
typecheck clean, `specs:check` passed for 97 specs. **Live-verified
against the real running stack**: restarted only `coder-agent`,
re-dispatched the corrected real request shape (`"edit package.json at
<project root>: adding some comments"` — the exact original phrasing
turned out to also trip two genuinely separate, pre-existing, unrelated
parsing requirements found along the way: `extractTargetFileToken()`
needs the filename directly after `edit`/`modify`/`change`, and the
shared `resolveTargetPath()` needs an `at`/`in`/`to`/`from` trigger word
before the project path) and got back `"Cannot make this edit: Standard
JSON (package.json) does not support comments..."` — the model
recognized the impossibility immediately and refused with a real,
specific reason, instead of exhausting the recursion budget on wasted
exploration. See `specs/098`'s own `verification.md` for the complete
transcript.

See specs/099-tui-port-url-and-analyze-project-stack-awareness/verification.md for the relocated narrative covering this checkpoint.
