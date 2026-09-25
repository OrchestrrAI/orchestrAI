# Plan: Production-Readiness Foundation

> This plan is subordinate to `spec.md`; it cannot broaden the approved scope.

## Phase 1 — Contracts and evidence

- Freeze the capability proposal, snapshot, operation-classification, runner
  profile, and paste event contracts.
- Add pure tests for each contract before wiring runtime behavior.
- Add representative repository fixtures and sanitized evidence helpers.

## Phase 2 — Project-aware preflight

- Implement snapshot/fingerprint collection and refresh/invalidation rules.
- Add deterministic preflight for existing artifacts and content diffs.
- Bind approval to operation and content fingerprints; re-check before write.
- Preserve existing MCP tool compatibility while preventing silent overwrite.

## Phase 3 — Capability routing and provider budgets

- Expose Agent-Card capability metadata to the ambiguous-request router.
- Add structured LLM routing only below keyword and local-classifier paths.
- Validate every proposal against live capabilities and policy.
- Add per-request model-call/time budgets and explicit quota/error outcomes.

## Phase 4 — Testing Agent

- Add read-only discovery and approved multi-ecosystem runner profiles.
- Improve approval previews, result parsing, diagnostics, coverage, and reuse.
- Verify unsupported and ambiguous projects fail safely rather than guessing.

## Phase 5 — TUI input and release verification

- Wire bracketed paste into all text-entry surfaces, including masked input.
- Run real PTY checks and multi-process preflight checks.
- Run repository tests, typecheck, governance checks, CI checks, and manual
  provider verification where credentials are available.
- Update documentation and worklog with evidence and remaining limitations.

## Sequencing constraints

- Do not implement runtime phases before `spec.md` approval.
- Do not add a new tool until its Agent-Card metadata, schema, safety tier,
  timeout, audit behavior, and fixture coverage are specified.
- Do not weaken a failed-ambiguous or changed-fingerprint result to improve
  demo convenience without a new approved decision.
