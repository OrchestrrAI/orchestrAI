---
id: 086-code-review-coder-default-on
title: Code Review and Coder Agents Also Default-On, Same as the Other Four
area: agents
change_type: enhancement
status: implemented
verification: pending
created: 2026-09-14
updated: 2026-09-14
approved_by: Yusuf
approved_on: 2026-09-14
implemented_on: 2026-09-14
amends:
  - 077-agent-enabled-means-llm-on-by-default
  - 082-code-review-agent
  - 083-coder-agent
related:
  - 064-supervisor-startup-key-check-non-blocking
supersedes: []
superseded_by: []
---

# Spec: Code Review and Coder Agents Also Default-On, Same as the Other Four

> Review gate: **APPROVED 2026-09-14 by Yusuf.**
>
> Direct follow-up to `specs/077`, same day. That spec deliberately
> excluded Code Review/Coder — added a `defaultOn: false` field for
> exactly these two, reasoning that they have no deterministic fallback
> at all (every task fails without a key, not "falls back to a
> template"), a materially bigger default-behavior consequence than the
> other four's flip. Yusuf's own call, after that tradeoff was laid out
> plainly: *"OK that will be great, I need this even for every one of
> it to be enabled"* — confirmed the fail-per-task/warn-at-startup shape
> specifically, not fail-at-process-startup. This spec is the small,
> mechanical extension that carries `specs/077`'s own exact pattern to
> these two remaining agents, now that the consequence has been stated
> and accepted directly rather than assumed.

## Purpose

`specs/077` flipped DevOps/Documentation/Security/Testing from opt-in
(`=== "1"`) to opt-out (`!== "0"`) for their own LLM harnesses, but
structurally excluded Code Review (`review-diff`) and Coder
(`edit-file`) via `AGENT_LLM_HARNESSES`'s own `defaultOn: false` field —
those two remain `=== "1"` required. This spec removes that one
remaining inconsistency: all six agents with an LLM harness now share
the identical default-on rule, closing the gap `specs/077` itself
named as "deliberately not this spec's own scope" rather than leaving
it open indefinitely.

## Verified Current State

Read 2026-09-14:

- `packages/agents/code-review/model-factory.ts:28-29`,
  `packages/agents/coder/model-factory.ts:27-28`: each still has
  `env.ORCHESTRAI_<AGENT>_LLM_HARNESS === "1"` — unchanged by
  `specs/077`, confirmed by that spec's own `verification.md` and by
  `git diff --stat` showing zero touches to either file.
- `apps/supervisor/init-wizard.ts`'s `AGENT_LLM_HARNESSES` table: the
  `code-review-agent`/`coder-agent` rows carry `defaultOn: false`,
  the other four `defaultOn: true` — the exact mechanism this spec
  needs to flip, already in place from `specs/077`.
- `apps/supervisor/index.ts`'s `resolveAgentLlmKeyRequirements()`
  already reads `defaultOn` per row (`h.defaultOn ? env[h.envVar] !==
  "0" : env[h.envVar] === "1"`) — no new logic needed here, only the
  table's own two `false` values need to become `true`.
- Neither agent has a deterministic fallback: `review-diff`
  (`packages/agents/code-review/index.ts`) and `edit-file`
  (`packages/agents/coder/index.ts`) both fail every task closed with a
  named error when the harness is on but misconfigured — confirmed by
  `specs/082`/`083`'s own "Fail-closed, not fail-open" sections. This
  is the one genuinely different consequence from `specs/077`'s own
  four agents, named directly to Yusuf before this spec was drafted,
  not assumed away.

## Proposed Behavior

### 1. The two remaining model-factory.ts flips

`packages/agents/code-review/model-factory.ts` and
`packages/agents/coder/model-factory.ts`'s own `isHarnessFlagSet()`
change from `=== "1"` to `!== "0"` — the identical one-line change
`specs/077` already made for the other four. `=0` remains a real,
permanent opt-out.

### 2. `AGENT_LLM_HARNESSES`'s two rows flip to `defaultOn: true`

`apps/supervisor/init-wizard.ts`: `code-review-agent`/`coder-agent`
join the other four. `resolveAgentLlmKeyRequirements()`
(`apps/supervisor/index.ts`) needs **no code change** — it already
reads `defaultOn` generically; flipping the table's own two values is
the entire mechanism.

### 3. Fail-per-task, warn-at-startup — never fail-at-process-startup

This is the specific, direct decision Yusuf confirmed, not a default
assumed from `specs/064`'s precedent alone: starting Code Review or
Coder with no resolvable key **does not** prevent either process from
starting. `resolveAgentLlmKeyRequirements()`'s existing non-blocking
startup warning (unchanged mechanism, now reachable for these two by
default) names the missing/misconfigured key loudly at startup; the
actual failure — every `review-diff`/`edit-file` task failing closed
with the exact named error `082`/`083` already produce — happens only
when a task is actually attempted, identical in shape to what an
explicit `=1` with no key already does today. Nothing about *how* the
failure is reported changes; only *how commonly* it's reached does,
since it no longer needs an explicit opt-in first to become reachable.

### 4. The startup message wording updates to match

`readLlmHarnessStartupState()`'s `"disabled (default) — review-diff
will fail closed until enabled"` (Code Review) / equivalent Coder
wording updates to `"disabled (explicit opt-out —
ORCHESTRAI_CODE_REVIEW_LLM_HARNESS=0) — review-diff will fail closed
until re-enabled"`, matching the reworded pattern `specs/077` already
used for the other four.

## Scope

- `packages/agents/code-review/model-factory.ts`,
  `packages/agents/coder/model-factory.ts`: the default flip + startup
  message wording.
- `apps/supervisor/init-wizard.ts`: `AGENT_LLM_HARNESSES`'s two rows'
  `defaultOn` field, `true`.
- Tests: both agents' `model-factory.test.ts` (default-on, explicit
  `=0` opt-out, `=1` still works — the exact three-state pattern
  `specs/077` already established for the other four);
  `resolveAgentLlmKeyRequirements()`'s own test file gains the
  mirror-image cases (these two now behave like the default-on group,
  not the still-opt-in group — that describe block in
  `startup-llm-key.test.ts` is deleted, since after this spec there is
  no longer any opt-in-only agent left to test).
- **Out of scope / unchanged**: any change to `review-diff`/`edit-file`'s
  own fail-closed behavior once the harness is genuinely active and
  misconfigured — that shape is exactly right already and this spec
  does not touch it. Any change to the classic wizard's own write path
  — it already writes `=1` unconditionally for every selected agent in
  `AGENT_LLM_HARNESSES` regardless of `defaultOn`, confirmed unaffected
  by `specs/077`'s own implementation.

## Safety and Compatibility Constraints

- **No approval-gate change of any kind** — `edit-file` is already
  Tier 1/approval-gated (`specs/083`); this spec only changes whether
  its harness is active by default, never the write-approval mechanism
  itself.
- **Explicit `=0` is a real, working, permanent opt-out** for both
  agents, never removed or deprecated.
- **The process never refuses to start over a missing key for either
  agent** — the non-blocking startup warning names it; the specific
  task fails closed the moment one is actually attempted. This is the
  one point this spec states most explicitly, since it's the direct
  answer to the question that prompted this spec.
- **Byte-identical behavior for `=1`.** Anyone who already explicitly
  set either flag to `1` sees no change at all.

## Out of Scope / Non-Goals

- Any change to what either harness actually does once active, or to
  its own fail-closed error wording/shape.
- Any change to `SKILL_TIER_REGISTRY`, the approval gate, or either
  agent's own MCP tool access.
- Adding a deterministic fallback to either skill — explicitly not
  attempted; the entire premise of both agents (`specs/082`/`083`) is
  that no non-LLM answer exists for "review this diff" or "make this
  specific code change."

## Acceptance Criteria

- [ ] Starting Code Review/Coder with no
      `ORCHESTRAI_<AGENT>_LLM_HARNESS` set at all does not prevent
      either process from starting. **Not yet live-verified** — see
      `verification.md`.
- [ ] With no key configured and the harness on by default, the
      startup summary names the missing key; a `review-diff`/
      `edit-file` task attempted in that state fails closed with the
      exact same named error `082`/`083` already produce for an
      explicit `=1`-with-no-key case. **Not yet live-verified.**
- [x] `ORCHESTRAI_<AGENT>_LLM_HARNESS=0` is a real, working opt-out —
      confirmed at the unit level (`isHarnessFlagSet()` returns
      `false`, `readLlmHarnessConfig()` returns `null`, identical to
      the pre-`086` "disabled" shape).
- [x] `ORCHESTRAI_<AGENT>_LLM_HARNESS=1` is unaffected — confirmed at
      the unit level.
- [x] `resolveAgentLlmKeyRequirements()`'s non-blocking startup warning
      fires for these two agents by default, matching the other four —
      confirmed by unit test.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] `CLAUDE.md` (Phase D/E sections, plus `specs/077`'s own new
      section) and `context/worklog.md` updated.

## Verification Plan

- Unit: both agents' `model-factory.test.ts`, the three-state pattern;
  `startup-llm-key.test.ts`'s now-unified default-on coverage.
- Live, with a real provider key: start Coder with no harness variable
  set at all and confirm a real `edit-file` request genuinely uses the
  harness (the same live scenario `specs/083`'s own verification
  already exercised with an explicit `=1`) — the decisive proof this is
  really on by default. The same scenario with `=0` confirming the
  task now fails closed with the pre-`086` "not enabled" message
  instead.
- Live: no key configured at all, confirming the process starts, the
  startup warning names the missing key, and a `review-diff`/
  `edit-file` task fails closed with the exact named error — proving
  the "warn, don't block" behavior directly, not just by code reading.

## Approval Requested

Approve to proceed. Amends `specs/077` (extends its own `defaultOn`
mechanism to the two agents it deliberately excluded) and `specs/082`/
`083` (each agent's own startup-message wording). Nothing is
implemented until then.
