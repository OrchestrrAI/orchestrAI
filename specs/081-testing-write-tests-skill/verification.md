# Verification — specs/081-testing-write-tests-skill

Recorded 2026-09-12, same session as implementation.

## Unit / HTTP-level (`packages/agents/testing/index.test.ts`, `describe("specs/081 — write-tests")`)

10 tests, real HTTP requests against the real, unmodified `app` — no
mocked skill resolution:

- Agent Card advertises `write-tests`.
- `"write tests for foo.ts at <path>"` detects `write-tests`, not
  `run-tests` (the ordering-hazard regression `specs/079`/`080` already
  had to fix for their own new skills, pinned here for this one too).
- No explicit source file → fails closed (`"No source file named"`),
  never a guess.
- An unsupported-runner project (a bare `go.mod`, no `package.json`) →
  fails closed naming the real reason.
- A source file resolving outside the project root (`../../etc/passwd.ts`)
  → refused.
- Harness off → fails closed (`ORCHESTRAI_TESTING_LLM_HARNESS=1` named
  in the error).
- Harness on but no key → fails closed with a distinctly different
  message (`ORCHESTRAI_LLM_API_KEY is missing`), confirming the two
  failure states are genuinely told apart, not collapsed into one.

Full suite: **949 pass, 2 skip (pre-existing, Docker-daemon-gated,
unrelated), 0 fail** across 951 tests — net +7 over `specs/080`'s own
942. `bun run typecheck`: 0 errors.

## Live pass, 2026-09-12 (real Gemini deployment, real key)

Same real `mcp:http` + `testing-agent` stack setup as `specs/080`'s own
live pass: `ORCHESTRAI_TESTING_LLM_HARNESS=1`,
`ORCHESTRAI_LLM_PROVIDER=gemini`, `ORCHESTRAI_LLM_MODEL=gemini-3.5-flash`,
the real key from `.orchestrai/config.env` (never echoed, logged, or
committed).

**Fixture**: a real, minimal `bun`-detected scratch project
(`package.json` with `scripts.test`, no lockfile — resolves to
`{kind:"detected", runner:"bun"}` per `detectRunner()`'s own documented
default) containing a real, genuinely untested `math.ts`:

```ts
export function clamp(value: number, min: number, max: number): number { ... }
export function isEven(n: number): boolean { ... }
```

**Step 1 — `write-tests` genuinely authors correct, grounded tests.**
Submitted `"write tests for math.ts at <scratch>"`. Reached
`input-required` with `step: "waiting for human approval — will write:
math.test.ts"` — the deterministic path derivation (`<name>.test.ts`
beside the source) worked correctly. The approval's `content` field
contained real, syntactically valid `bun:test` code:

```ts
import { expect, test, describe } from "bun:test";
import { clamp, isEven } from "./math";

describe("clamp", () => {
  test("should clamp value to min if below range", () => { expect(clamp(1, 5, 10)).toBe(5); });
  test("should clamp value to max if above range", () => { expect(clamp(15, 5, 10)).toBe(10); });
  test("should return value if within range", () => { expect(clamp(7, 5, 10)).toBe(7); });
});

describe("isEven", () => {
  test("should return true for even numbers", () => { expect(isEven(4)).toBe(true); expect(isEven(0)).toBe(true); expect(isEven(-2)).toBe(true); });
  test("should return false for odd numbers", () => { expect(isEven(3)).toBe(false); expect(isEven(-1)).toBe(false); });
});
```

Genuinely grounded: both real functions are exercised, including real
boundary cases (`clamp`'s below/above/within-range, `isEven`'s
negative-number case) that go beyond a trivial restatement of the
source — not a hallucinated or disconnected response.

**Step 2 — approval writes exactly what was previewed, and does NOT
execute it.** Approved. The real file `math.test.ts` was found on disk
afterward, byte-for-byte identical to the approval's own `content`
field. The task's `result` explicitly stated: *"Approving this write
did NOT run it — dispatch run-tests separately to execute it."* No
`run_tests`/`run_command` MCP call occurred as a side effect — confirmed
by the task's own terminal state (`completed`, no runner output, no
pass/fail counts) and by the fact a genuinely separate request was
required for execution (Step 3).

**Step 3 — a separate, second approval is required to execute it, and
it genuinely passes.** Submitted a new, independent `"run tests at
<scratch>"` request. Reached its own fresh `input-required` with a new
`actionId` (`{"executable":"bun","argv":["bun","test"], ...}`) — a
completely separate approval cycle, not a continuation of Step 1's own
`actionId`. Approved: the real `bun test` process ran and reported
**5 pass, 0 fail** — the AI-authored tests genuinely execute correctly
against the real source code they test:

```
(pass) clamp > should clamp value to min if below range [0.12ms]
(pass) clamp > should clamp value to max if above range [0.09ms]
(pass) clamp > should return value if within range [0.02ms]
(pass) isEven > should return true for even numbers [0.05ms]
(pass) isEven > should return false for odd numbers [0.04ms]

 5 pass
 0 fail
```

All scratch artifacts (`body-wt*.json`, `scratch-submit-wt*.js`, the
temp scratch directory) and both background processes were removed
after the pass; `git status` is clean.

## Live pass 2: `pytest` syntax, real second Gemini deployment run

Same real stack. `pytest` (9.1.1) was installed for this pass so the
generated tests could genuinely execute, not just parse. Fixture: a
real `requirements.txt`-detected scratch project with a genuinely
untested `strings.py` (`reverse_words`, `is_palindrome`).

Submitted `"write tests for strings.py at <scratch>"`. Correctly
derived `test_strings.py` (the `pytest`-specific naming convention, not
the JS/TS `.test.ts` shape). The real model produced genuine `pytest`
syntax — plain `def test_...():` functions using bare `assert`, no
`bun:test`-style imports at all:

```py
from strings import reverse_words, is_palindrome

def test_reverse_words():
    assert reverse_words("hello world") == "world hello"
    assert reverse_words("pytest is great") == "great is pytest"
    assert reverse_words("") == ""
    assert reverse_words("  multiple   spaces  ") == "spaces multiple"

def test_is_palindrome():
    assert is_palindrome("racecar") is True
    assert is_palindrome("A man a plan a canal Panama") is True
    assert is_palindrome("hello") is False
    assert is_palindrome("") is True
```

Approved: written byte-identical to the preview. A genuinely separate,
second `run-tests` request resolved to `python -m pytest` (its own
fresh `actionId`); approved, a real `pytest` process ran:

```
============================= test session starts =============================
platform win32 -- Python 3.12.10, pytest-9.1.1, pluggy-1.6.0
rootdir: ...
collected 2 items

test_strings.py ..                                                       [100%]

============================== 2 passed in 0.03s ==============================
```

**2 passed, 0 failed** — the generated edge case
(`reverse_words("  multiple   spaces  ") == "spaces multiple"`, correct
because Python's `str.split()` with no arguments collapses runs of
whitespace) is not just plausible, it's actually correct.

## Live pass 3: the drift-recheck refusal

Fixture: a real `bun`-detected scratch project with `util.ts`
(`double`). Submitted `"write tests for util.ts"`, reached
`input-required` with a real preview for `util.test.ts`. **Before
approving**, the target file was manually overwritten on disk with
unrelated content (`"// manually mutated between preview and
approval"`), simulating exactly the adversarial window `specs/056`'s
own fingerprint mechanism exists to close. Approving the now-stale
action was refused:

```
{"status":"failed","error":"Target \"util.test.ts\" changed after approval
but before this write — refusing to overwrite unreviewed content. Resubmit
for a fresh preflight."}
```

The file on disk was confirmed to still hold the manual mutation
afterward — not overwritten with the AI-generated content, and not
further corrupted.

## Live pass 4: rejection creates nothing

Fixture: a real `bun`-detected scratch project with `nums.ts`
(`square`). Submitted `"write tests for nums.ts"`, reached
`input-required` with a real preview for `nums.test.ts`. Rejected
instead of approved: task terminated
`{"status":"failed","error":"Rejected by user"}`. The scratch
directory's filesystem was confirmed to contain no `nums.test.ts` at
all afterward — proof by absence, not inference.

All scratch artifacts and background processes from passes 2–4 were
removed after each pass; `git status` is clean.

## Summary

Every acceptance criterion in the spec is now checked. Both language
families `detectRunner()` covers with a JS/TS-vs-Python syntax split
(`bun` and `pytest`) were exercised against a real model, producing
genuinely correct, genuinely executable test code in each case — not
merely plausible-looking output. The three safety mechanisms specific
to this skill (the drift recheck, rejection-creates-nothing, and the
two-separate-approvals structural guarantee) were each independently
confirmed live, not just asserted by code inspection. `specs/081` moves
to `verification: verified`.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/081-testing-write-tests-skill/spec.md` (implemented, **verified**,
2026-09-12) is Phase C: the roadmap's own risk class 5
("model-authored source code"), one step past `run_command`'s class 4
(a model-chosen *command*, still fixed by a human-reviewed argv) — the
first time this codebase lets a model author real source code that
becomes a real file on disk. Promoted ahead of the Coder Agent by
Yusuf's own decision 6 in `specs/078`. Design driven entirely by four
direct answers Yusuf gave before drafting: **(1)** a genuinely new
skill, used only when explicitly asked for. **(2)** the same
`read_project_file`/`write_project_file` + content-diff approval
pattern `generate-readme` already established (`specs/040`/`specs/041`).
**(3)** writing the test file and running it are always **two separate
approvals** — enforced structurally, not by convention: the function
handling this skill has no code path that reaches `run_tests`/
`run_command` at all. **(4)** one approval per file (chosen via
AskUserQuestion over "per test case" and "one approval per multi-file
batch," both lacking any precedent in this codebase's existing
approval UI).

**No guessing anywhere in this flow.** An explicit source file must be
named in the task text (`"write tests for src/foo.ts"`) — deciding
which untested file most needs one is a materially higher-stakes guess
than `document-api`'s own small conventional-entry-file fallback
(`specs/036`), so none is attempted; absent one, the task fails closed.
A **detected** (not ambiguous/unsupported) `detectRunner()`
(`specs/058`) result is also required — the harness needs to know the
real framework to write syntactically correct code in, and teaching it
to also guess a framework for an unknown stack is explicitly deferred
(compounding two guesses in one step). The new test file's own path is
**100% deterministic** given `(source path, detected runner)` — `bun`/
`npm`/`pnpm`/`yarn`/`jest`/`vitest` → `<name>.test.<ext>` beside the
source (this repo's own convention); `pytest` → `test_<name>.py` — the
model never chooses where to write, the same structural guarantee
`specs/042`'s four DevOps write skills already hold.

**`runWriteTestsHarness()`** (`packages/agents/testing/llm-harness.ts`)
is the first Testing/DevOps harness output that's raw source-code
content rather than a JSON parameter object — reads the real source
file via the already-bound `read_project_file`, is told the detected
framework by name, and returns the test file's real content verbatim
(markdown-fence-stripped if wrapped). A **grounding check** (a shallow,
deliberately non-semantic substring scan for real identifiers pulled
from the source — the same bar `document-api`'s own per-route grounding
check already sets) rejects and retries a response that references
nothing from the real file.

**A real, previously undocumented asymmetry found while grounding this
spec**: DevOps's write skills (`specs/056`) re-verify a content
fingerprint immediately before the real write, refusing if the target
drifted after approval; Documentation's own write path (`generate-
readme`/`document-api`) never adopted this at all — confirmed directly,
no `computeContentFingerprint`/`classifyWritePreflight` call exists
anywhere in `packages/agents/documentation/index.ts`, a deliberate
`specs/056` scope boundary at the time, not an oversight since found and
left unfixed. `write-tests` deliberately adopts DevOps's **stronger**
pattern, not Documentation's lighter one — a test file, once approved,
is very likely to be `run_command`/`run-tests`-approved and executed
shortly after, so the same "confirm nothing changed since a human last
looked at this" guarantee is judged worth it here specifically.

**Live-verified against a real Gemini deployment (`gemini-3.5-flash`),
the decisive end-to-end scenario**: a real scratch `bun` project with a
genuinely untested `math.ts` (`clamp`/`isEven`). `write-tests` correctly
derived `math.test.ts`, and the real model authored 5 genuine
`describe`/`test` cases — including real boundary cases (`clamp`'s
below/above/within-range, `isEven`'s negative-number case), not a
trivial restatement of the source. Approved: the file landed on disk
byte-identical to the preview, and the task's own result explicitly
stated the write did *not* execute anything. A **genuinely separate**,
second `run-tests` request was then required — its own fresh
`actionId`, its own independent approval — and only then did the real
`bun test` process run, reporting **5 pass, 0 fail**: the AI-authored
tests are not just plausible-looking, they genuinely pass against the
real code they test. **The `pytest` path was independently exercised
too**, with `pytest` installed for real: a real scratch project with a
genuinely untested `strings.py` (`reverse_words`/`is_palindrome`)
correctly derived `test_strings.py`, and the model wrote genuine
`pytest` syntax (plain `def test_...():`/`assert`, no `bun:test`-style
imports) — a real `python -m pytest` run then reported **2 pass, 0
fail**, including a correctly-handled whitespace-collapsing edge case.
**The drift recheck was also confirmed live**: a preview shown, the
target manually overwritten before approving, and the approval refused
with a named error, the file left holding the manual mutation, not
corrupted. **And rejection-creates-nothing was confirmed live** for
this skill specifically: a rejected preview left no file on disk at
all. 949 tests pass (0 fail; net +7 over `specs/080`'s own 942),
typecheck clean — every acceptance criterion in the spec is checked.
See `specs/081`'s own `verification.md` for the complete transcript.

See specs/109-document-api-drift-recheck/verification.md for the relocated narrative covering this checkpoint.

See specs/082-code-review-agent/verification.md for the relocated narrative covering this checkpoint.

See specs/083-coder-agent/verification.md for the relocated narrative covering this checkpoint.

See specs/111-testing-documentation-routing-fixes/verification.md for the relocated narrative covering this checkpoint.
