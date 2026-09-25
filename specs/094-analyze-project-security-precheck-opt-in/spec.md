---
id: 094-analyze-project-security-precheck-opt-in
title: "analyze-project's Security Secrets Pre-check Runs Unconditionally — Make It Opt-In"
area: agents
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-15
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-15
implemented_on: 2026-09-15
amends: []
related:
  - 090-devops-security-precheck-timeout-too-short
supersedes: []
superseded_by: []
---

# Spec: analyze-project's Security Secrets Pre-check Runs Unconditionally — Make It Opt-In

> Review gate: **APPROVED 2026-09-15 by Yusuf — Option A (opt-in, default
> OFF).**
>
> Raised directly by Yusuf, 2026-09-15,
> after watching a plain *"what stack we are working on?"* question take
> real extra time and produce a huge, mostly-irrelevant 42-finding secrets
> report alongside the actual stack answer. His own words: *"it should not
> do the security scan unless it needed."*

## Purpose

Every single `analyze-project` call — regardless of what was actually
asked — makes a mandatory, hardcoded A2A call to Security for a full
secrets scan (`packages/agents/devops/index.ts`'s `skillAnalyzeProject()`).
This predates the spec-numbering system (git history shows it introduced
in an early `a2a-devops-to-sec` commit) and is documented in `CLAUDE.md` as
deliberate — but "deliberate at the time it was written" and "still the
right default now that `analyze-project` is reachable from a plain
conversational question, not just a deployment-prep plan step" are
different claims. A simple *"what's the tech stack?"* question has no
obvious relationship to "audit this codebase for leaked secrets," and
paying the real latency/token cost of a full scan-plus-commentary pass
(`specs/090`'s own ~30s measured cost) for every stack question is a real,
disproportionate tax on the common case.

## Verified Current State

- `packages/agents/devops/index.ts:526-548` (`skillAnalyzeProject()`):
  unconditionally calls `callAgent("security", ..., {selectedSkill:
  "scan-secrets"})` after every `analyze_project` MCP call, no flag, no
  condition, no way to skip it per-request or per-deployment.
- **Live-reproduced, 2026-09-15**: a plain `"what stack we are working on?"`
  question, dispatched through `POST /ask`, resolved to `analyze-project`
  and returned a combined result — the real, useful stack analysis
  (`hasPackageJson`, `hasBunLock`, file listing) followed immediately by
  a 42-finding secrets report (39 of them confirmed false positives by
  the report's own AI commentary) that has nothing to do with what was
  asked.
- No existing test in this codebase asserts the pre-check's own presence
  or absence directly (confirmed by `grep` across
  `packages/agents/devops/*.test.ts`) — this is genuinely free of
  test-migration risk, not just low-risk.
- `specs/090-devops-security-precheck-timeout-too-short/spec.md`
  (implemented, verified, 2026-09-15) already fixed this same call's own
  timeout budget — a related, but narrower fix (this call now completes
  reliably; this spec is about whether it should run at all, every time).

## Proposed Behavior

A new flag, `ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK`, gates the call in
`skillAnalyzeProject()` — **opt-in, defaults to OFF** (decided,
2026-09-15): the pre-check never runs unless someone explicitly sets `=1`.
When disabled (the default), `analyze-project` returns exactly the DevOps
analysis half, with no A2A call to Security at all — not even attempted,
not even a "skipped" note, clean and fast. Setting `=1` restores exactly
today's combined stack-plus-secrets behavior for anyone who wants it.

## Scope

- `packages/agents/devops/model-factory.ts` (or a new, narrowly-scoped
  helper alongside it): the new flag's own read function, following this
  codebase's own established `isHarnessFlagSet()`-style pattern.
- `packages/agents/devops/index.ts`: `skillAnalyzeProject()`'s own
  conditional around the Security A2A call.
- **Out of scope**: any change to Security's own `scan-secrets` skill
  itself, callable directly and unaffected either way; any change to
  `specs/090`'s own timeout fix (still applies whenever the pre-check does
  run); DevOps's own four *write* skills and their real
  `ORCHESTRAI_DEVOPS_LLM_HARNESS` flag (`specs/042`/`077`) — a completely
  separate, unrelated gate.

## Safety and Compatibility Constraints

- **Fail-open behavior, when the pre-check does run, is completely
  unchanged** — a Security failure/timeout still never fails
  `analyze-project` itself.
- **No change to Security's own `scan-secrets` skill, its safety
  properties, or its accessibility as a standalone, directly-dispatchable
  skill** — this only gates one specific caller's own automatic use of it.

## Out of Scope / Non-Goals

- Any smarter, content-based heuristic for "does this request need a
  security check" (e.g. keyword detection) — a flag is the same
  deliberate, simple mechanism this codebase already uses for every other
  opt-in/opt-out capability; no new inference layer.
- Any change to how `plan-task`'s own adaptive supervisor decides whether
  to dispatch a standalone `scan-secrets` step — untouched, already
  capable of that independently of this pre-check.

## Acceptance Criteria

- [x] With the flag at its decided default, `analyze-project` behaves
      per that decision (either the pre-check runs or it doesn't).
- [x] The non-default setting produces the opposite, exact behavior —
      both directions unit-tested.
- [x] When disabled, no A2A call to Security is attempted at all (not
      just a fast no-op) — confirmed live (no existing test harness in
      this codebase mocks both the MCP round-trip and the A2A call this
      function makes; the flag's own on/off logic is unit-tested
      directly, and the live pass confirms the real skill's behavior).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] A live re-run of the exact scenario that surfaced this — a plain
      stack question — produces a focused answer with no secrets report,
      once the flag is set per the decided default.
- [x] `CLAUDE.md` and `context/worklog.md` updated, including a
      correction to the existing "analyze-project makes one direct
      DevOps-to-Security A2A secrets pre-check" sentence, which currently
      states this as unconditional.

## Verification Plan

- Unit: both flag states, the "zero calls attempted when disabled"
  assertion, `analyze-project`'s own core result unaffected either way.
- Live, with a real provider key: the exact real scenario re-run once
  the flag is set to the decided default.

## Approval Requested

**Approved 2026-09-15 by Yusuf — Option A (opt-in, default OFF).**
