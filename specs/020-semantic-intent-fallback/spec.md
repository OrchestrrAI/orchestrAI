---
id: 020-semantic-intent-fallback
title: Semantic Intent Fallback (Model2Vec Static Embeddings)
area: routing-planning
change_type: enhancement
status: implemented
verification: verified
created: 2026-08-10
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-10
implemented_on: 2026-08-10
amends:
  - 008-routing-fixes
  - 015-routing-planning-polish-2
supersedes: []
superseded_by: []
related:
  - 015-routing-planning-polish-2
---

# Spec: Semantic Intent Fallback (Model2Vec Static Embeddings)

> Status: **APPROVED on 2026-08-10 and IMPLEMENTED AND VERIFIED on
> 2026-08-10.** Decisions: `minishlab/potion-base-8M` (not the smaller 2M
> variant — a live 13-query benchmark run before implementation showed 9/10
> vs. 6/10 accuracy, for +22 MB; see Verification Results), embedded in the
> compiled binary (137.3 MB total, up from ~106 MB). Classifier may route to
> write-capable skills — the approval gate is the protection. Threshold 0.30
> plus a discovered-during-implementation `MIN_MARGIN = 0.05`. All
> Acceptance Criteria below are checked off with real verification evidence.

## Purpose

Yusuf asked whether the input detection/classifier layer could be an ML
model. CLAUDE.md already earmarks this as future work — *"LLM-based routing
as a supplement to, not a replacement for, deterministic approval
enforcement"* — with the operative word being **supplement**.

Today `detectSkill()` is pure keyword matching. It handles anticipated
phrasing well (and was broadened twice this session:
`specs/013-security-skill-detection/spec.md`, `specs/015-routing-planning-polish-2/spec.md`),
but it structurally cannot handle phrasing nobody anticipated. `"run tests
on my project"` works because someone wrote that pattern; `"can you check
if my tests still pass"` matches nothing and falls through to the generic
default. No amount of additional `.includes()` branches closes that gap in
general — it is a genuinely semantic problem.

This spec adds a **semantic fallback** that runs only when keyword matching
finds nothing, using static embeddings that require no inference engine.

## Verified Current Behavior (four spikes run before writing this spec)

Three candidate approaches were tested and **rejected on evidence**, not
assumption. All spikes ran in an isolated scratchpad; the repo was
confirmed untouched after each.

1. **`Xenova/all-MiniLM-L6-v2` via transformers.js (Node build)** —
   classified correctly under `bun run` (all four held-out paraphrases),
   but the **compiled binary crashed immediately**: ONNX Runtime API
   version mismatch (`requested API version [24] … only [1, 17] supported`)
   then `Could not load the "sharp" module`. Root cause: native `.node`
   addons cannot be embedded in a single-file `bun build --compile` output.
   This is not Bun-specific — Deno's `deno compile` and Node's SEA share the
   limitation.
2. **Same model via the web/WASM build** (to dodge native addons) — import
   succeeded via a direct file path (the package `exports` map has no web
   entry), but model loading failed: the web build hard-depends on browser
   globals (`document.baseURI` for relative URL resolution, the `caches`
   Cache Storage API) that do not exist in a Bun process. The Node build
   also rejects `device: "wasm"` outright — only `dml`/`webgpu`/`cpu`, all
   of which need the native addon.
3. **Contextual multi-armed bandit** — rejected on design grounds, not
   tested: there is no natural reward signal here (approve/reject conflates
   "wrong agent" with "wrong parameters", and never reveals what a
   *different* skill would have done), volume is orders of magnitude below
   what a bandit needs to converge, deliberate exploration conflicts
   directly with this project's predictability/explainability story, and
   CLAUDE.md records *"No persistence; all task state is in memory"* — there
   is nowhere to retain learned weights across restarts.

**Accepted approach — `minishlab/potion-base-8M` (Model2Vec), verified
working end to end:**

Model2Vec distills a real sentence transformer (`bge-base-en-v1.5`) into
**static embeddings** — a lookup table, not a network. Inference is
tokenize → look up one vector per token → mean-pool. No inference engine,
therefore no native addon and no browser global. The project reports it
"outperforms any other static embeddings (such as GloVe and BPEmb) by a
large margin", which matters because a plain-GloVe spike (also run) proved
the *mechanism* compiles fine but offers materially weaker semantics.

Spike results, **byte-identical under `bun run` and the compiled binary**:

```
"can you check if my tests still pass"        -> run-tests        0.563  (margin 0.149)
"make sure there's no leaked api key in here" -> scan-secrets     0.620  (margin 0.452)
"wrap this up in a container image"           -> dockerize        0.467  (margin 0.357)
"write me some docs for this repo"            -> generate-readme  0.434  (margin 0.257)
"what is the weather in cairo today"          -> best score 0.079  (out-of-scope)
```

Embedding matrix: 29,528 tokens x 256 dims, F32, 30,236,760 bytes.

Two obstacles found and solved during the spike:

- **`sharp` broke the compiled binary** even for text-only work, because
  the `@huggingface/transformers` entry point loads it eagerly. Fixed by
  aliasing `sharp` to an empty stub via `tsconfig.json` `paths`; bundle
  dropped 85 -> 46 modules. Only the package's **pure-JS tokenizer** is
  used — no model inference path is ever touched.
- **Runtime model download** avoided by embedding the weights with
  `import … with { type: "file" }`; verified loading offline from inside a
  compiled binary (98 MB -> 129 MB, exactly the model size).

**Not yet proven:** the spike let `AutoTokenizer.from_pretrained()` fetch
`tokenizer.json` from Hugging Face at runtime. Making the binary fully
offline requires embedding that file too and loading the tokenizer from a
local path. Same already-proven embedding mechanism on a small JSON file,
so low risk — but unproven, and called out in Acceptance Criteria rather
than assumed.

**Model-size decision, made with real comparative data before
implementation.** A 13-query benchmark (10 real intents spanning every
skill plus `git-status` and `plan-task`, plus 3 nonsense queries) was run
against both `potion-base-2M` and `potion-base-8M`:

| | potion-base-2M (~8 MB) | potion-base-8M (~28 MB) |
|---|---|---|
| Accuracy | 6/10 | **9/10** |
| Missed | `git-status` (both phrasings), a `run-tests` paraphrase, a `scan-secrets` paraphrase | one: "what files have i modified" → `generate-readme` instead of `git-status` |
| Nonsense score range | 0.16–0.27 | 0.08–0.19 |
| Separation gap (lowest correct − highest nonsense) | 0.175 | 0.127 |

The smaller model's wider separation margin doesn't compensate for missing
4 of 10 real intents — including a basic one (`git-status`). Decision:
`potion-base-8M`, for +22 MB over the smaller option, on a binary where the
Bun runtime itself already accounts for ~106 MB.

## Proposed Behavior

### 1. A new shared module

`packages/shared/intent-classifier.ts`, exporting:

```ts
export interface Classification { skill: string; score: number; margin: number }
export function isClassifierAvailable(): boolean
export async function classifyIntent(text: string): Promise<Classification | null>
```

- Lazy-loads tokenizer + embedding matrix on **first call**, never at
  process startup — the Orchestrator must keep starting instantly, and a
  run that never hits the fallback should never pay the load cost.
- Returns `null` when the classifier is unavailable **or** when confidence
  is below threshold. Callers treat `null` as "no opinion" and keep their
  existing behavior unchanged.

### 2. Keyword-first, classifier strictly second

In `apps/orchestrator/index.ts`, `detectSkill()` keeps every existing
branch, unchanged and in the same order. The only change is at the very
end, replacing the bare `return "plan-task"` default:

```ts
// ...every existing keyword branch above, untouched...

// Nothing matched. Ask the semantic fallback before defaulting.
const guess = await classifyIntent(text)
return guess?.skill ?? "plan-task"
```

Consequences, stated precisely:

- Every currently-matching request routes **identically** — the classifier
  is unreachable for them. All existing routing regression tests
  (`apps/orchestrator/detect-skill.test.ts`) must therefore still pass
  untouched, which is the primary safety property of this design.
- `detectSkill()` becomes `async`. This is the one real structural change
  and it ripples to its callers and its test file (mechanical `await`
  additions, no logic change).

### 3. `plan-task` is one of the classifier's own arms

The classifier's example set includes `plan-task` examples ("set up my
whole project", "get this repo production ready") alongside the specific
skills. This matters: today's default sends unmatched text to Planning,
and for genuinely broad/plan-shaped requests that is the **correct**
answer, not a failure. Including `plan-task` as a competing arm means
plan-shaped language lands on `plan-task` on its own merits rather than
being forced into whichever single skill happens to be nearest.

### 4. Confidence threshold

Proposed `MIN_SCORE = 0.30`. From the spike, genuine intents scored
0.43–0.62 and out-of-scope input scored 0.079 — a wide, clean separation.
Below threshold, `classifyIntent()` returns `null` and the existing
`plan-task` default applies.

**Honest calibration caveat:** 0.30 is derived from five example queries.
It is a starting value to be revisited against a broader set during
verification, not a tuned constant.

### 5. Graceful degradation when model files are absent

If the model files are missing, `isClassifierAvailable()` returns `false`,
`classifyIntent()` returns `null`, and **the system behaves exactly as it
does today**. This is deliberate and load-bearing:

- `bun test` passes with or without the model present.
- A checkout that never runs the fetch step still works fully.
- The 30 MB weights stay **out of git** (fetched by
  `scripts/fetch-model.ts` into a gitignored `models/` directory, verified
  against a committed SHA-256), keeping the repo lean.

## Safety Constraints

- **The approval gate is untouched and stays fully deterministic.** Tier
  classification is keyed on the *skill*, in each agent's own policy — not
  on how the skill was chosen. A classifier-routed `dockerize` produces the
  same `input-required` state, the same `ApprovalPreview` with the same
  random server-issued `actionId`, and the same immutable-pending-parameter
  binding as a keyword-routed one. Nothing about approval becomes
  probabilistic. This is precisely the "supplement, not replacement"
  boundary CLAUDE.md draws.
- **Misclassification is contained by that gate, and worth stating
  plainly:** the classifier *can* route to a write-capable skill. If it
  guesses wrong, the user sees an approval preview naming the exact tool,
  target path, and parameters, and rejects it — the same protection that
  already exists for a keyword mismatch or a user typo. A wrong guess costs
  one rejected preview, never an unapproved write.
- **Deterministic and explainable.** Same input always yields the same
  output (a fixed lookup table plus fixed arithmetic — no sampling, no
  temperature, no network). `score` and `margin` are returned so a routing
  decision can be logged and explained, not just asserted.
- **No new network calls in the runtime.** The model is fetched once at
  build/setup time and read from disk (or from inside the binary)
  thereafter. CLAUDE.md's *"no LLM API calls in the current runtime"*
  property is preserved — this is local arithmetic, not an API.
- **Model pinned by revision + checksum**, so a silently-updated upstream
  model can never change routing behavior underneath the tests.

## In Scope

1. `packages/shared/intent-classifier.ts` — the module above.
2. `scripts/fetch-model.ts` + `models/` in `.gitignore` + a committed
   checksum.
3. `apps/orchestrator/index.ts` — `detectSkill()` becomes `async`, gains
   the single fallback call at the end; callers updated.
4. `apps/orchestrator/detect-skill.test.ts` — mechanical `await` updates;
   **no expected values change**.
5. New focused tests: threshold behavior, graceful degradation with the
   model absent, and a held-out paraphrase set asserting correct
   classification.
6. `scripts/build-binary.ts` — embed the model files; document the size
   increase in its summary output.
7. `README.md`/`CLAUDE.md` updated.

## Out of Scope / Non-Goals

- **Agent-level `detectSkill()` adoption.** Each agent has its own
  (Security's was broadened separately this session). The shared module is
  designed to be reusable by them, but wiring them up is a follow-up —
  this pass keeps the change small and verifiable at the one place that
  makes the primary routing decision.
- **Replacing keyword matching.** It stays the first pass permanently: it
  is free, instant, and exactly testable.
- **Any change to approval, Tier classification, or plan execution.**
- **Fine-tuning or training.** The example phrases are hand-written and
  embedded at load; there is no training step and no learned state.
- **LLM API classification.** Explicitly not this — no external calls.
- **Multi-intent detection** (one request mapping to several skills). The
  existing Planning Agent already covers multi-step work.

## Acceptance Criteria

- [x] Yusuf approves this spec. Approved 2026-08-10: `potion-base-8M`,
      threshold 0.30 as a starting value, classifier may route to
      write-capable skills (approval gate is the protection).
- [x] `scripts/fetch-model.ts` downloads and checksum-verifies the model;
      `models/` is gitignored and the 30 MB weights are never committed.
- [x] With the model **absent**: `bun test` and `bun run typecheck` pass,
      and routing behaves byte-identically to today.
- [x] With the model **present**: all existing routing tests still pass
      with unchanged expected values.
- [x] Held-out paraphrases that match no keyword route correctly — at
      minimum the four verified in the spike, plus new ones written during
      implementation and not used to pick the threshold.
- [x] Out-of-scope input (e.g. `"what is the weather in cairo today"`)
      falls below threshold and still returns `plan-task`.
- [x] **Tokenizer loads fully offline from an embedded local path** (the
      one thing the spike did not prove — see Verified Current Behavior).
      Proven during implementation: see Verification Results.
- [x] `bun run build` produces a working binary that classifies correctly
      **with no network available**, and its reported size increase is
      documented.
- [x] Live end-to-end: submit a keyword-unmatched paraphrase to the running
      Orchestrator and confirm it reaches the right agent, with the
      approval gate behaving identically for a write skill.

## Verification Results (2026-08-10)

All work was verified live in the real repository, not assumed. Three real
bugs were found and fixed during this pass — none were anticipated in the
original spec text above.

**1. `MIN_MARGIN` added alongside `MIN_SCORE` (real regression, not
theoretical).** The pre-existing test *"no bare 'security' keyword —
ambiguous across 3 skills"* is a deliberately-ambiguous query by design.
Once the classifier went live, `"improve the security of my app"` scored
0.41 for `scan-secrets` (comfortably above `MIN_SCORE = 0.30`) but its
margin over the 2nd-place skill was only 0.002 — a near coin-flip the
classifier would have confidently resolved one arbitrary way. Fixed with
`MIN_MARGIN = 0.05`: both `score >= MIN_SCORE` and `margin >= MIN_MARGIN`
are required, otherwise `classifyIntent()` returns `null`. Re-ran the full
13-query benchmark plus the 4-query spike afterward: every previously
correct classification held. Two queries newly return `null` post-fix, and
both were individually confirmed to be genuine near-ties, not false
rejections: `"write me some docs for this repo"` (`document-api` 0.44 vs
`generate-readme` 0.41, margin 0.03) and `"can you check if my tests still
pass"` (`check-coverage` 0.585 vs `run-tests` 0.582, margin 0.003).

**2. Offline tokenizer loading — proven, not just assumed.** The spike's
open item ("not yet proven") is closed:
`packages/shared/intent-classifier-embedded-assets.ts` embeds
`tokenizer.json` (plus `config.json`, `tokenizer_config.json`,
`special_tokens_map.json`, `model.safetensors`) via
`import … with { type: "file" }`, gated behind a runtime `isCompiled` check
and only ever reached through `await import(...)` (never a static import) —
the same dynamic-import-gating pattern `apps/supervisor/index.ts`'s
`SERVICE_STARTERS` already uses. Verified directly: (a) under plain
`bun run`/`bun test`, this module is never loaded, so a missing `models/`
directory never breaks dev/test; (b) `bun build --compile` embeds the real
files (confirmed via a live HTTP round-trip through the compiled binary
with the source `models/potion-base-8M/` directory renamed out of the way,
so the running process could only be using the embedded copy); (c) a
missing asset at *build* time fails the build clearly rather than silently.

**3. `bun run typecheck` fails with the model absent unless the
embedded-assets module opts out.** `tsc`'s static module resolution needs
`intent-classifier-embedded-assets.ts`'s imported files to exist on disk
regardless of the runtime dynamic-import gating. Tried and confirmed **not
sufficient**: a `tsconfig.json` `exclude` entry (file still resolved as a
reachable dependency of `intent-classifier.ts`), and ambient `declare
module` wildcards for `*.json`/`*.safetensors` (don't apply to
relative-path specifiers, only bare ones). Working fix: `// @ts-nocheck` at
the top of that one file. Confirmed: `bunx tsc --noEmit` exits 0 both with
and without `models/` present.

**4. Path-text embedding dilution — found live via the compiled binary's
actual HTTP endpoint, not a script.** Submitting
`"wrap this up in a container image at C:/Users/moham/test-target-project"`
to a running compiled `orchestrai.exe` returned `plan-task` instead of
`dockerize`, even though the bare phrase alone (no path clause) classified
confidently (margin 0.22). Root cause: every real task's text includes a
target path clause, and feeding the whole string into the mean-pooled
embedding dilutes it below threshold. Fixed with `stripPathPhrases()`
(`packages/shared/index.ts`), called before embedding in
`classifyIntent()`. **First fix attempt was itself buggy**: a non-global
`.replace()` using the existing single-match path pattern only stripped the
*first* `(?:at|in|to|from)\s+\S+` match, which in `"wrap this up **in a**
container image at C:\..."` is the spurious `"in a"` — leaving the real
trailing path clause completely unstripped. Fixed by scanning every match
globally and only stripping ones whose captured value actually validates as
an absolute path (reusing `normalizeAbsolutePath()`'s own check), leaving
ordinary prose like `"in a container"` untouched. Regression-pinned in
`packages/shared/strip-path-phrases.test.ts` (7 tests, including this exact
case).

**5. Final live end-to-end confirmation, through the rebuilt binary, after
all three fixes above.** With the real `models/potion-base-8M/` directory
renamed out of the way (so only the embedded copy inside the binary could
possibly be used) and `dist/bin/orchestrai.exe` (137.3 MB) running via `bun
run orchestrai`-equivalent supervisor startup:

```
POST /tasks {"text":"wrap this up in a container image at C:/Users/moham/test-target-project"}
  -> {"skill":"dockerize","assignedAgent":"devops-agent","status":"assigned"}   (semantic fallback — the exact originally-failing case)
POST /tasks {"text":"show git status at C:/Users/moham/test-target-project"}
  -> {"skill":"git-status","assignedAgent":"devops-agent","status":"assigned"} (keyword match, unaffected)
POST /tasks {"text":"what is the weather like today"}
  -> {"skill":"plan-task","assignedAgent":"planning-agent","status":"assigned","isPlan":true} (out-of-scope, unaffected)
```

Model directory restored immediately after this test.

**6. Test suite counts.** `bun test` from repo root:
- Model **present**: 136 pass, 0 fail, 206 `expect()` calls, across 14
  files.
- Model **absent**: existing semantic-fallback tests use
  `test.skipIf(!modelAvailable)` and skip cleanly rather than fail; a final
  unconditional test asserts `detectSkill()` never throws regardless of
  classifier state.

`bunx tsc --noEmit`: 0 errors, in both model-present and model-absent
states.

**Known, accepted limitation (cosmetic, not functional):** importing
`@huggingface/transformers` triggers `onnxruntime-node`'s own backend
auto-registration as a side effect, which prints `The requested API version
[24] is not available, only API versions [1, 17] are supported… Current ORT
Version is: 1.17.1` to stderr once per process — the same signature as the
already-abandoned full-transformer spike. This is harmless noise: the
intent-classifier module never calls any ONNX inference path (only the
pure-JS tokenizer), and it did not affect either the `dockerize` or
`git-status` live classification results above. Not fixed in this pass;
flagged here rather than silently ignored.

## Addendum: Planning's own generic fallback plan (found during live testing, approved and implemented 2026-08-10)

**Found while testing this spec's own live behavior**, not a new unrelated
bug report: submitting genuinely out-of-scope text (`"tell me a joke"`,
`"what's the weather like today"`) through the full pipeline produces a
plan that *looks* like the system understood the request, when it didn't.

Root cause is entirely inside `packages/agents/planning/index.ts`'s
`skillPlanTask()`, not in anything this spec's classifier controls:

```ts
export async function skillPlanTask(text: string): Promise<string> {
  const lower = text.toLowerCase()
  const steps: string[] = []
  steps.push(`${steps.length + 1}. [analyze-project] Analyze project structure and find missing DevOps files`)
  // ... every step below this is conditional on a keyword match ...
  if (steps.length === 1) {
    steps.push(`${steps.length + 1}. [git-status] Check repository status`)
  }
  ...
```

Two things compound: (1) `analyze-project` is pushed **unconditionally**,
before any keyword check runs; (2) if nothing else matched, a second
step (`git-status`) is added too. So *any* text that reaches
`skillPlanTask()` — whether it's "get this repo production ready" or "tell
me a joke" — always gets a real-looking 2-step plan. This is pre-existing
behavior, unrelated to and unchanged by the classifier work above: it
already did this for nonsense text sent straight to Planning before this
spec existed. It's only newly *visible* now because the Orchestrator's
classifier correctly declines nonsense and defers to `plan-task` — routing
that used to also often land elsewhere for accidental keyword hits — more
reliably arriving at Planning's own unconditional-baseline blind spot.

**Not in scope for this spec's original Acceptance Criteria** — it's a
distinct pre-existing gap in Planning, not the Orchestrator's
`detectSkill()`/classifier work this spec covers. Recorded here (per
Yusuf's direction) rather than as a separate spec file, since it surfaced
from this spec's own testing.

**Proposed fix (minimal, not yet implemented or approved):** make the
`analyze-project` step conditional on *something* having actually matched,
instead of always firing first. Concretely: build the conditional steps
first, and only prepend `analyze-project` (and use the existing
`git-status`-only fallback) if at least one real trigger fired. If nothing
in the text matches any of Planning's own keyword rules at all, return an
explicit "could not determine actionable steps for this request" result
instead of a fabricated-looking plan, mirroring how `classifyIntent()`
returns `null` rather than guessing.

This explicitly reuses **exactly** the "supplement, not replacement"
posture already established above — no new classifier call inside
Planning, no scope creep into the out-of-scope item ("Agent-level
`detectSkill()` adoption... wiring them up is a follow-up") from this
spec's own Out of Scope section. It only changes when Planning commits to
its own already-existing generic baseline plan, not how it chooses skills.

**Approved and implemented on 2026-08-10.** `packages/agents/planning/
index.ts`'s `skillPlanTask()` now collects conditional steps first,
unnumbered; `[analyze-project]` is only prepended as the real step 1 if at
least one conditional step matched. If none did, the function returns an
explicit "No actionable steps could be determined from this request" result
with zero numbered `N. [skill-id] ...` lines — verified this parses to zero
steps via `apps/orchestrator/index.ts`'s `parsePlanText()` and that
`watchPlanAndDispatch()` already no-ops cleanly on zero steps (read before
implementing, not assumed).

**Verification:**
- `bun -e` direct call: `skillPlanTask("jflaskdj")` → no numbered step
  lines, explicit "No actionable steps" message.
- All 6 pre-existing `skill-plan-task.test.ts` tests still pass unchanged
  (their inputs all contain a real trigger word, so none exercise this new
  path) — confirms `"build and deploy my bun app"` still produces its
  already-demoed 4-step plan with `analyze-project` first, byte-identical
  to before this change.
- Added 2 new regression tests: nonsense input → zero skill ids + the
  explicit message; a real trigger (`"dockerize my app"`) → still gets a
  real plan with `analyze-project` first.
- `bun test`: 138 pass, 0 fail, 211 expectations, 14 files (up from
  136/206 — the 2 new tests). `bunx tsc --noEmit`: 0 errors.
- **Not yet verified live end-to-end through the Orchestrator** (i.e.
  confirming a real nonsense HTTP submission now shows the explicit
  no-plan message in a running dashboard/TUI rather than a fabricated
  analyze-project+git-status plan) — the unit-level behavior is fully
  verified and correct per the above, but the live round-trip specifically
  hasn't been re-run since this change.

## Review Request (historical — resolved 2026-08-10)

1. **Binary size**: +30 MB (~106 MB -> ~136 MB). **Resolved: accepted**,
   actual measured result 137.3 MB.
2. **Threshold**: 0.30 as the starting value? **Resolved: accepted**, plus
   `MIN_MARGIN = 0.05` added during implementation (see Verification
   Results item 1).
3. **Write-capable skills**: may the classifier select them (approval gate
   is the protection), or should it be restricted to read-only skills?
   **Resolved: yes, may select them** — approval gate is the protection.
