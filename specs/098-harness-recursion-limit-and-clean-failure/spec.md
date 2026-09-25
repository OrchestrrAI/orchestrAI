---
id: 098-harness-recursion-limit-and-clean-failure
title: "Every Agent LLM Harness Gets an Explicit Recursion Limit, a Clean Failure Message, and Coder Gains File-Type-Aware Early Refusal"
area: agents
change_type: fix
status: implemented
verification: verified
created: 2026-09-15
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-15
implemented_on: 2026-09-15
amends:
  - 083-coder-agent
  - 042-llm-harness-devops
  - 041-llm-harness-documentation
  - 080-run-command-approved-execution
  - 081-testing-write-tests-skill
  - 082-code-review-agent
related:
  - 028-orchestrator-langgraph-supervisor
supersedes: []
superseded_by: []
---

# Spec: Every Agent LLM Harness Gets an Explicit Recursion Limit, a Clean Failure Message, and Coder Gains File-Type-Aware Early Refusal

> Status: **APPROVED 2026-09-15 by Yusuf** (extended in review, after Yusuf's
> own pushback — *"but isn't it issue to hit this limit?"* — to fix the real
> root cause for Coder specifically, not just clean up the failure message).
> Live-caught by Yusuf, 2026-09-15, in the
> Coder Agent's own `edit-file` skill: a real request looped through many
> repeated `read_project_file` calls and failed with a raw, unwrapped
> LangGraph internal error —
> `"LLM harness run failed: Recursion limit of 25 reached without hitting a
> stop condition. You can increase the limit by setting the 'recursionLimit'
> config key. Troubleshooting URL: https://docs.langchain.com/..."` — shown
> directly in the TUI.

## Purpose

Every one of this codebase's five real per-agent LangGraph harnesses (DevOps,
Documentation, Testing — two graphs, Code Review, Coder) calls `graph.invoke()`
with **no explicit `recursionLimit`**, so every one of them silently relies on
LangGraph's own internal default of 25 total graph steps. When a harness's own
tool-calling loop doesn't converge quickly enough — the model keeps reading
files without producing a final structured proposal — the run doesn't fail
with a clean, named OrchestrAI-style error the way every other harness failure
in this codebase does; it fails with LangGraph's own raw internal exception
text, including a `docs.langchain.com` troubleshooting URL, surfaced verbatim
to the end user via each agent's own generic `catch (err) { ... error:
\`LLM harness run failed: ${errorMessage(err)}\` }` wrapper. This is both a
legibility gap (a confusing, implementation-leaking error message) and a
consistency gap (the one other real LangGraph-based component in this
codebase, the adaptive supervisor's own `supervisor-graph.ts`, already sets an
explicit, project-chosen `recursionLimit` — the agent-level harnesses were
never brought in line with that precedent).

## Verified Current State

- `apps/orchestrator/supervisor-graph.ts`'s `runSupervisor()` calls
  `graph.invoke(..., { recursionLimit })` with an explicit,
  project-chosen `DEFAULT_RECURSION_LIMIT = 50` — confirmed directly.
  This is the **only** `graph.invoke()` call site in the codebase that
  sets one.
- The following five harness files call `graph.invoke()` with **no**
  second (config) argument at all, confirmed by reading each directly —
  six total call sites:
  - `packages/agents/coder/llm-harness.ts` (`runEditFileHarness()`)
  - `packages/agents/code-review/llm-harness.ts`
  - `packages/agents/devops/llm-harness.ts`
  - `packages/agents/documentation/llm-harness.ts`
  - `packages/agents/testing/llm-harness.ts` (two separate graphs — the
    `run-command` fallback harness and the `write-tests` harness)
  - `packages/agents/security/llm-harness.ts` deliberately has **no**
    `StateGraph` at all (`specs/043`'s own documented reason — no tool
    to call, a plain structured-completion retry loop instead), so it
    is unaffected by this spec and out of scope.
- `@langchain/langgraph` exports a distinguishable `GraphRecursionError`
  class (confirmed directly in the installed package's own
  `dist/errors.d.ts`) — the exhaustion case can be detected
  structurally (`error instanceof GraphRecursionError`), not by string
  matching the message text.
- **Live-reproduced, 2026-09-15**: a real `edit-file` request against
  Coder reached this exact failure — the TUI showed a real sequence of
  many successful `read_project_file` calls (never converging on a
  final proposal) followed by
  `"LLM harness run failed: Recursion limit of 25 reached without
  hitting a stop condition. You can increase the limit by setting the
  \"recursionLimit\" config key. Troubleshooting URL:
  https://docs.langchain.com/oss/javascript/langgraph/GRAPH_RECURSION_LIMIT/"`
  — LangGraph's own raw internal error text, not an OrchestrAI-authored
  message.
- Every affected harness's own calling agent (`index.ts`) already has a
  generic `catch (err) { ...error: \`LLM harness run failed:
  ${errorMessage(err)}\` }` wrapper around the harness call — confirmed
  for Coder directly; the same shape is used by the other four agents
  (each independently implemented, per this codebase's own
  per-agent-copy precedent), so a clean error thrown *from inside* the
  harness function reaches the user correctly formatted without needing
  to touch five separate agent files' own catch sites.

### The real root cause behind the live reproduction, not just its symptom

Checked directly, not assumed: the real request that produced the live
failure above was `"edit C:\...\package.json : adding some comments"` —
confirmed via the Orchestrator's own real task record. **JSON has no
valid comment syntax at all** — there is no way to satisfy this
instruction correctly. Yusuf's own direct pushback (*"but isn't it
issue to hit this limit?"*) is correct: raising the bound and cleaning
up the failure message alone still lets this exact case burn the full
budget on wasted exploration before failing — it doesn't make the
system any faster or smarter at recognizing that the request was
unsatisfiable from the start.

`buildEditFileSystemPrompt()` (`packages/agents/coder/llm-harness.ts`)
gives the model the target file's real content and instruction, and
tells it it "may call `read_project_file` ... as many or as few times
as you need" — genuinely open-ended, with **no instruction anywhere
telling the model it's allowed to conclude a request can't be
satisfied and say so directly**, only encouragement to keep exploring.
Coder is the one harness in this codebase where this specifically
matters: unlike DevOps (writes a fixed template type — Dockerfile/CI
YAML — always valid for its own skill), Documentation (writes
Markdown), or Testing (writes a test file in a known, detected
framework's own syntax), Coder edits an **arbitrary target file of
whatever type the human names**, with an **arbitrary free-text
instruction** — the one place in this codebase where "this instruction
is structurally impossible for this file type" is a real, recurring
risk category, not a one-off.

## Proposed Behavior

1. **An explicit, bounded `recursionLimit` on all six `graph.invoke()`
   calls.** Each harness's own system prompt already tells the model it
   may call its one read-only tool "as many or as few times as you
   need" — genuinely open-ended, but not unbounded in practice: these
   are narrow, single-skill exploration-then-propose loops (read a
   handful of related files, then emit one structured proposal), not
   the adaptive supervisor's own multi-step plan. A shared numeric
   constant, high enough to comfortably accommodate a real "explore a
   few related files, retry validation, converge" run, low enough to
   still fail closed in a reasonable time rather than silently running
   long: `HARNESS_RECURSION_LIMIT = 20` (a real number, grounded in the
   observed real Coder failure — the live-reproduced run made many real
   `read_project_file` calls without ever converging, so raising the
   bound alone is not treated as sufficient by itself, see item 2). One
   local constant per harness file (matching this codebase's own
   independent-per-agent-copy convention every other harness constant
   already follows), same value across all five, not a shared imported
   module.
2. **`GraphRecursionError` is caught and re-thrown as a clean, named
   OrchestrAI error**, inside each `run<X>Harness()` function itself —
   never leaking LangGraph's own raw message or troubleshooting URL to
   the end user. Message names the real skill and states plainly what
   happened and a concrete next step: e.g. *"The `edit-file` harness
   could not converge on a proposal within `${HARNESS_RECURSION_LIMIT}`
   tool-call rounds — try a narrower, more specific instruction naming
   exactly what should change."* Every other error type from
   `graph.invoke()` (a genuine API/provider error, a bad-key failure,
   etc.) is **unaffected** — re-thrown exactly as before, reaching each
   agent's own existing generic wrapper unchanged.
3. **Coder gains a real, structurally-recognized refusal shape — not
   just a prose instruction hoping the model behaves.** Matching this
   spec's own item 2 preference (detect structurally via a real schema,
   never by guessing at free-text shape), `EditProposalSchema` becomes a
   discriminated union: the existing `{ old_text, new_text }` edit shape,
   plus a new `{ refused: true, reason: <string> }` shape the model may
   return instead when the requested change cannot be validly expressed
   in the target file's own syntax. `buildEditFileSystemPrompt()`
   (Coder only — the other four harnesses write a fixed, always-valid
   content type for their own skill, so this doesn't apply to them)
   names the target file's real extension explicitly and documents both
   response shapes, telling the model directly it's expected to return
   the refusal shape rather than search for a workaround when one
   genuinely doesn't exist. `validateNode()` recognizes a refusal
   response immediately — no retry, no further exploration — and the
   harness returns it distinctly from a normal validation failure, so
   `index.ts`'s own catch site can surface the model's real, specific
   reason as the task's final error (e.g. *"Cannot make this edit:
   JSON does not support comments."*) instead of either the generic
   "could not be validated after retries" message or a wasted run
   through the full recursion budget.

## Scope

- `packages/agents/coder/llm-harness.ts`,
  `packages/agents/code-review/llm-harness.ts`,
  `packages/agents/devops/llm-harness.ts`,
  `packages/agents/documentation/llm-harness.ts`,
  `packages/agents/testing/llm-harness.ts` (both graphs): the
  `HARNESS_RECURSION_LIMIT` constant, the `graph.invoke()` call site's
  own new `{ recursionLimit: HARNESS_RECURSION_LIMIT }` argument, and a
  `try { ... } catch (err) { if (err instanceof GraphRecursionError)
  throw new Error(...clean message...); throw err }` wrapper around
  that same call.
- `packages/agents/coder/llm-harness.ts` additionally: the
  `EditProposalSchema` discriminated union (edit shape + refusal
  shape), `buildEditFileSystemPrompt()`'s new file-extension-naming and
  refusal-shape instructions, `validateNode()`'s new immediate-refusal
  branch, and `packages/agents/coder/index.ts`'s own catch/result
  handling to surface a refusal's real reason as the task's error.
- Tests: one focused test per affected harness file proving (a) a
  scripted model that never stops calling the tool is caught and
  produces the new clean error message, not the raw LangGraph text, and
  (b) a genuinely unrelated thrown error (e.g. a provider failure) still
  propagates completely unchanged — the catch is scoped to
  `GraphRecursionError` specifically, not a blanket swallow. For Coder
  specifically: a scripted model returning the new refusal shape
  produces the task's own real reason as its error, with **zero**
  further tool calls or retries after that response (proving the
  refusal is recognized immediately, not treated as invalid JSON); a
  scripted model returning the normal edit shape is completely
  unaffected (regression coverage for the existing, unmodified path).
- **Out of scope**: `packages/agents/security/llm-harness.ts` (no
  `StateGraph`, structurally unaffected); the adaptive supervisor's own
  `supervisor-graph.ts` (already has an explicit, correct
  `recursionLimit`, untouched); any change to the four non-Coder
  harnesses' own tools or system prompts, or to any harness's existing
  retry-with-feedback validation loop for a genuinely malformed
  response (a separate, already-correct mechanism this spec does not
  touch — only Coder's own new, distinct refusal path is added).

## Safety and Compatibility Constraints

- **Fail-closed, unchanged** — a harness that can't converge already
  failed the whole task closed (no partial/guessed proposal); this spec
  only changes *what the resulting error message says*, *how many
  tool-call rounds are allowed before that happens*, and (Coder only)
  *how quickly a genuinely unsatisfiable request is recognized* — never
  whether a failure occurs or what happens after one.
- **No change to any of the four non-Coder harnesses' own real tool
  access, system prompt content, or validation/grounding logic** — this
  is purely a bound + error-message clarity fix for them.
- **The catch is scoped to exactly `GraphRecursionError`** — every other
  failure mode (a real provider error, a malformed response exhausting
  retries, a tool call failing) is re-thrown completely unchanged, so
  none of those failure paths' own existing behavior or tests are
  affected.
- **Coder's new refusal shape can never itself become a write** — a
  refusal produces no `old_text`/`new_text` at all, so it structurally
  cannot reach `index.ts`'s own approval-preview construction; the
  approval gate and `write_project_file` are completely untouched by
  this addition.
- **A refusal is a real, structural schema branch, not a heuristic
  guess at free-text shape** — matching this spec's own item 2
  preference for structural detection (`GraphRecursionError`) over
  string-matching; the model's refusal is validated by the same Zod
  schema mechanism every other harness parameter already is.

## Out of Scope / Non-Goals

- Raising `DEFAULT_RECURSION_LIMIT` on the adaptive supervisor itself
  (`specs/028`, already 50, already explicit — unrelated to this gap).
- Any change to Security's own harness (no `StateGraph`).
- Adding an equivalent refusal shape to the other four harnesses — none
  of them face Coder's specific risk (an arbitrary target file type
  paired with an arbitrary free-text instruction); DevOps/Documentation/
  Testing always write a fixed, always-valid content type for their own
  skill, so there is no evidence-backed case for this there, matching
  this codebase's own "increase capability/complexity only where a real
  need is shown" principle (`specs/042`).
- A shared, imported constant/helper across the five harness files —
  matching this codebase's own established "independent copy per
  agent" convention (the same reasoning `specs/041`/`042`/`080`/`081`/
  `082`/`083` each already state for why their own harness code isn't
  shared), not attempted here.
- Making `recursionLimit` itself configurable per component (e.g. an
  `ORCHESTRAI_<AGENT>_HARNESS_RECURSION_LIMIT` env var) — a real,
  plausible future follow-up in the same shape as `specs/097`'s own
  dispatch-limit fix, but not raised as a live problem yet and not
  attempted here; `20` is chosen as a concrete, grounded default, not a
  placeholder needing external tuning.

## Acceptance Criteria

- [x] All six `graph.invoke()` call sites pass an explicit
      `recursionLimit: HARNESS_RECURSION_LIMIT` (`= 20`).
- [x] A scripted model that never stops calling the read-only tool
      produces the new clean, named error message (mentioning the real
      skill and the real limit value) — not LangGraph's raw internal
      text or troubleshooting URL — for every one of the five harness
      files.
- [x] A genuinely unrelated error thrown during `graph.invoke()` (e.g. a
      simulated provider failure) still propagates completely unchanged
      — proving the catch is scoped to `GraphRecursionError` alone, not
      a blanket swallow.
- [x] A scripted model returning Coder's new refusal shape immediately
      ends the run with the model's own real reason as the task's error
      — zero further tool calls or retries after that response.
- [x] A scripted model returning Coder's normal edit shape is completely
      unaffected — existing behavior, existing tests, unchanged.
- [x] The exact real live-reproduced scenario (`edit package.json:
      adding some comments`) is re-run live and now fails with a
      specific, real reason (e.g. naming that JSON has no comment
      syntax) rather than exhausting the recursion budget.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] Every pre-existing test in the five affected files passes
      unmodified.

## Verification Plan

- Unit: every acceptance criterion above, one dedicated test per
  affected harness file, plus Coder's own additional refusal-shape
  coverage.
- Live: re-run the exact real request that surfaced this bug (`edit
  package.json: adding some comments`) and confirm it now fails fast
  with the model's own real, specific reason instead of exhausting the
  recursion budget; separately confirm a genuinely hard-but-satisfiable
  `edit-file` request still succeeds unaffected.

## Approval Requested

Not yet requested — presented for review.
