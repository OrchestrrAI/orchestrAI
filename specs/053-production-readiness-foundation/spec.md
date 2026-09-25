---
id: 053-production-readiness-foundation
title: Production-Readiness Foundation — Capability Routing, Project-Aware Operations, Testing, and TUI Input
area: production-readiness
change_type: enhancement
status: archived
verification: not-applicable
created: 2026-09-05
updated: 2026-09-05
approved_by: null
approved_on: null
implemented_on: null
amends:
  - 011-remaining-agents-mcp
  - 030-authoritative-skill-dispatch-and-capability-catalog
  - 040-approval-preview-content-diff
  - 044-conversational-ask-layer
  - 047-tui-conversation-operations-navigation
  - 048-guided-init-experience
supersedes: []
superseded_by:
  - 054-capability-driven-llm-routing
  - 055-provider-call-budgets-and-transient-error-handling
  - 056-devops-preflight-and-idempotent-writes
  - 057-project-snapshot-and-cross-request-reuse
  - 058-testing-agent-multi-ecosystem-runner-detection
  - 059-tui-bracketed-paste-support
related:
  - 020-semantic-intent-fallback
  - 028-orchestrator-langgraph-supervisor
  - 029-shared-llm-provider-gemini
  - 039-per-component-llm-provider-config
  - 042-llm-harness-devops
  - 045-supervisor-port-preflight-timeout
  - 051-planning-retirement-and-required-key
  - 052-ci-plan-task-dispatch-smoke-test
---

# Spec: Production-Readiness Foundation — Capability Routing, Project-Aware Operations, Testing, and TUI Input

> Review gate: **ARCHIVED, 2026-09-05, before approval — never
> implemented.** (Not `superseded`: this repository's own governance
> rules reserve that status for a checkpoint that was actually approved
> and implemented before being replaced — this one was withdrawn while
> still a draft, so `archived` plus the `superseded_by` links below is
> the accurate combination.) This checkpoint bundled seven largely
> independent workstreams (routing, provider reliability, DevOps write safety,
> project-snapshot caching, Testing Agent detection, TUI paste, and a
> cross-cutting evaluation harness) into one draft, amending six existing
> specs at once. At Yusuf's request, it was split into six independently
> approvable, independently verifiable checkpoints — matching this
> repository's own established practice (compare `specs/041`/`042`/`043`:
> three separate specs for three per-agent LLM harnesses, never one
> combined "LLM harness foundation") rather than one large diff that is
> harder to verify end to end:
>
> - `specs/054-capability-driven-llm-routing` — §1
> - `specs/055-provider-call-budgets-and-transient-error-handling` — §5
>   (explicitly deprioritized by Yusuf for his own current use, since
>   already off the free tier; kept as its own approvable checkpoint for
>   later)
> - `specs/056-devops-preflight-and-idempotent-writes` — §3
> - `specs/057-project-snapshot-and-cross-request-reuse` — §2
> - `specs/058-testing-agent-multi-ecosystem-runner-detection` — §4
> - `specs/059-tui-bracketed-paste-support` — §6
>
> §7 (a cross-cutting fixture/evaluation matrix) was not split into its
> own spec — each of the six above carries its own Verification Plan,
> matching how every other spec in this repository already verifies
> itself, rather than introducing a separate "testing spec for the
> specs." The content below is preserved as the original combined
> proposal for historical reference; it is not current guidance and
> should not be implemented as written.

## Purpose

Make OrchestrAI dependable for real developer workflows without removing its
deterministic safety boundary. The current prototype is safe for a narrow set
of supported project shapes, but it can guess the wrong test runner, repeat
inspection and work across related requests, prepare a create operation for an
artifact that already exists, and reject normal terminal paste input.

This checkpoint replaces those rigid assumptions with project-aware,
capability-driven behavior while preserving deterministic validation,
approval, audit, timeout, and fail-closed guarantees.

The intended result is:

```text
Natural-language request
  -> fast deterministic route when unambiguous
  -> Agent-Card capability route when ambiguous
  -> project snapshot and preflight
  -> typed operation proposal
  -> deterministic policy validation
  -> approval for state changes
  -> bounded MCP execution
  -> structured result, audit record, and reusable evidence
```

## Verified Current State

The following facts were verified against the repository on 2026-09-05:

- DevOps currently maps `dockerize` directly to the fixed MCP tool
  `create_dockerfile`; the deterministic action computes the target path and
  output path before the optional LLM harness is consulted. See
  `packages/agents/devops/index.ts` (`prepareWriteAction()` and
  `prepareWriteActionOrHarness()`).
- The optional DevOps LLM harness only overlays parameters such as runtime and
  port. It cannot change the operation from create to validate, update, or
  no-op. This protects paths but also means that an existing Dockerfile can be
  discovered and still reach the create/overwrite preview.
- The MCP server exposes `create_dockerfile` with a `dry_run` flag, but its
  non-dry-run path writes the generated content directly with `writeFile()`.
  It has no first-class existing-artifact operation contract.
- `packages/shared/test-runner.ts` supports only `bun` and `pytest`. Any valid
  `package.json` containing a `scripts.test` string is classified as Bun,
  regardless of whether the project actually uses npm, pnpm, yarn, Jest,
  Vitest, or another Node runner.
- The Testing Agent advertises only `run-tests` and `check-coverage`, and its
  approval preview is built from the fixed runner table. It does not expose a
  read-only test-discovery result or a confidence/ambiguity state.
- Each new supervisor task starts with a fresh graph state. The runtime has no
  project snapshot or result cache that can safely connect a prior status
  request with a later deployment request. Repeated requests therefore repeat
  inspection by design.
- Routing remains keyword-first, then local semantic fallback, then
  `plan-task`. The repository has not implemented an LLM routing tier. Agent
  Cards already advertise agent-owned capability identifiers and are the
  existing discovery surface.
- `apps/tui/index.tsx` uses keyboard handling and `<input>` components but does
  not subscribe to OpenTUI's paste event. `apps/supervisor/init-form.tsx`
  manually appends one-character printable sequences to path/model buffers, so
  bracketed paste payloads are ignored there as well.
- The current test suite and typecheck provide broad regression coverage, but
  there is no fixture matrix proving runner selection across multiple language
  ecosystems, artifact idempotency, cross-request snapshot reuse, or paste
  behavior in a real PTY.

## Proposed Behavior

### 1. Capability-driven routing

The existing deterministic fast paths remain for clearly recognizable
requests. An LLM router may be consulted only when keyword matching and the
local semantic classifier both fail or report ambiguity.

The LLM router must receive the currently discovered Agent-Card capabilities,
not a separately hardcoded ownership list. It must return a structured proposal
containing at least:

- advertised capability identifier;
- target project, if one is present;
- proposed operation and requested scope;
- confidence and a short reason;
- whether the request is read-only, state-changing, or unsupported.

The Orchestrator must validate that proposal against the live Agent Card and a
deterministic policy table before dispatch. A missing, stale, or ambiguous
capability produces a clarification or unsupported response; it never causes
an arbitrary tool call.

Existing skill identifiers remain compatible aliases while Agent-Card
advertisements become the source of truth for ownership and supported
capabilities.

### 2. Project snapshot and safe reuse

Read-only project inspection produces a normalized snapshot containing, where
available:

- canonical project root;
- detected language, package manager, and build/test profiles;
- relevant manifests and configuration files;
- existence and content fingerprints of managed artifacts;
- Git state and inspection timestamp.

The snapshot is scoped to a conversation/task context and includes a file
fingerprint. It may be reused for a related read-only request only while the
fingerprint is unchanged and its TTL has not expired. A write action always
performs a final preflight regardless of snapshot age. The user can explicitly
request a refresh, and filesystem changes invalidate reuse.

Read-only results may be reused when safe; write actions must never be skipped
solely because a previous task had a similar natural-language description.

### 3. Mandatory preflight and idempotent state changes

Every state-changing action must perform a deterministic preflight before an
approval preview or MCP write call. The preflight classifies the requested
operation as one of:

- `create` — target is absent;
- `no-op` — target exists and already matches the desired content/condition;
- `update` — target exists and a bounded diff can be shown;
- `replace` — replacement is materially destructive and needs an explicit
  decision;
- `blocked` — target cannot be safely inspected or the operation is unsupported.

The approval record must bind the operation, canonical target, current content
fingerprint, proposed content fingerprint, and immutable parameters. Before
execution, the runtime must re-check the current fingerprint; a changed target
invalidates the approval and requires a new preflight.

An existing artifact must never be silently overwritten. An exact `no-op` must
not call a write-capable MCP tool. If preflight fails, the system fails closed
with an actionable explanation.

This contract applies to Dockerfiles, Compose files, CI workflows,
documentation, ignore files, generated configuration, and commits—not only
the Dockerfile example.

### 4. Testing Agent capability expansion

The Testing Agent gains a read-only discovery phase and an approved runner
profile registry. Profiles must cover, where detected and explicitly
supported, Bun, npm, pnpm, yarn, Jest, Vitest, Python/pytest, Go, Rust,
Maven/Gradle, and .NET.

Detection must inspect actual manifests, lockfiles, scripts, and test-file
patterns. It must not infer Bun merely because `package.json` has a test
script. If multiple profiles are plausible, the agent reports the ambiguity
and asks the user to choose; it does not guess.

Execution remains fixed-argv, `shell:false`, timeout-bounded, output-bounded,
and approval-gated according to the existing approved policy. No free-form
command, shell fragment, or caller-supplied executable is accepted.

Results must include, when supported:

- selected profile and evidence for the selection;
- passed, failed, skipped, and errored counts;
- failed test identifiers and a bounded diagnostic excerpt;
- duration and timeout status;
- coverage percentage and source, when requested and parseable;
- a clear distinction between test failure, runner failure, unsupported
  profile, and MCP/provider failure.

Results are reusable only when the project fingerprint, profile, scope, and
relevant environment policy match.

### 5. Provider and execution reliability

LLM-enabled paths must have a per-request model-call budget, bounded total
runtime, and explicit provider error classification. Retry is permitted only
for safe, clearly transient model failures; ambiguous tool/write failures are
not automatically retried. Quota exhaustion must be surfaced as a provider
state, not reported as an empty plan.

The supervisor must preserve existing approval and dispatch bounds. A model
failure must not trigger a direct-execution bypass.

### 6. TUI paste and input correctness

All TUI text-entry surfaces must accept OpenTUI bracketed paste through the
library paste event mechanism, decode the payload as text, normalize terminal
line endings, and insert it into the active field without interpreting pasted
characters as commands.

This includes chat, new-task input, project paths, model names, and masked API
keys. Paste handling must have a bounded size, preserve spaces in paths, avoid
logging secrets, and retain existing Enter, Tab, Escape, backspace, and
Ctrl+C behavior.

The UI must show a clear error for oversized or unsupported paste input rather
than silently truncating a path or credential.

### 7. Evaluation and audit evidence

The implementation must add a fixture matrix covering supported and ambiguous
project types, existing and missing artifacts, unchanged and changed files,
provider failures, and repeated requests. It must include a real PTY check for
paste and at least one real multi-process check for capability discovery and
preflight behavior.

Audit records continue to include caller, capability/tool, parameters,
timestamp, duration, outcome, and bounded result metadata. Secrets must be
redacted and results truncated by a stated limit before persistence or display.

## Scope

The approved implementation may change:

- Orchestrator routing and Agent-Card capability validation;
- shared project snapshot, fingerprint, and operation-preflight modules;
- DevOps artifact planning and MCP write contracts;
- Testing Agent discovery, runner profiles, execution result parsing, and tests;
- provider call budgeting/error classification for the supervisor;
- TUI and guided-init input handling;
- relevant unit, integration, fixture, PTY, and CI checks;
- affected README, `CLAUDE.md`, `specs/README.md` generated catalog output, and
  `context/worklog.md` after implementation.

Expected implementation files include the existing modules under
`apps/orchestrator`, `apps/tui`, `apps/supervisor`, `packages/agents/testing`,
`packages/agents/devops`, `packages/mcp`, and `packages/shared`; exact new
module names are an implementation detail and must not broaden this contract.

## Safety and Compatibility Constraints

- The deterministic safety/policy layer is retained. LLM routing can propose
  intent but cannot authorize, construct arbitrary shell commands, bypass
  path containment, bypass approval, or bypass MCP.
- Read-only actions and A2A communication remain approval-free but audited and
  timeout-bounded. State-changing actions retain human approval before the MCP
  write call.
- Existing skill IDs and current Agent Card endpoint remain backward-compatible
  during migration. A capability not advertised by the live Agent Card cannot
  be dispatched.
- No generic `run_any_command`, unrestricted file read/write, or model-supplied
  absolute path is introduced.
- Existing targets are never overwritten without an explicit operation,
  content diff, immutable approval binding, and final fingerprint check.
- Provider keys, test environment secrets, and masked input are never included
  in logs, audit payloads, or model prompts unless an already-approved policy
  explicitly permits the minimum required value.
- Existing MCP stdio/HTTP process separation and fail-closed behavior remain
  unchanged.
- This checkpoint must not require a live billable provider for deterministic
  unit tests or CI smoke tests. Real-provider verification remains a separately
  recorded manual check.

## Out of Scope / Non-Goals

- Removing deterministic approval, path, command, timeout, audit, or
  effect-certainty enforcement.
- Supporting arbitrary user-provided shell commands or unrestricted filesystem
  access.
- Full official A2A protocol adoption or multi-user/distributed persistence.
- A complete container sandbox for untrusted test code; the existing approval
  and bounded execution contract remains the baseline, while sandboxing is a
  later security checkpoint.
- Fully autonomous production deployment, cloud credentials, rollback, or
  infrastructure provisioning.
- Replacing LangGraph or the Orchestrator with a separate framework.
- Guaranteeing every ecosystem's runner in this checkpoint; unsupported or
  ambiguous ecosystems must be reported explicitly and safely.
- Treating a single successful fixture as proof of production readiness.

## Acceptance Criteria

- [ ] Agent-Card capability data is the ownership source of truth, while legacy
      skill IDs continue to work as compatibility aliases.
- [ ] An LLM router is consulted only for keyword/classifier misses or
      ambiguity, returns structured output, and cannot bypass deterministic
      validation or approval.
- [ ] A project snapshot is fingerprinted, scoped, TTL-bounded, refreshable,
      and invalidated after filesystem changes.
- [ ] Every write-capable operation performs preflight and classifies create,
      no-op, update, replace, or blocked before approval/execution.
- [ ] An unchanged existing artifact produces no write call; a changed one
      produces a bounded diff and an approval bound to current/proposed hashes.
- [ ] A target changed after approval causes the write to be rejected and
      requires a new preflight.
- [ ] Testing no longer classifies every `package.json` test script as Bun;
      supported profiles and ambiguity behavior are proven with fixtures.
- [ ] Testing results distinguish test failures, runner failures, unsupported
      profiles, timeouts, and provider/MCP failures.
- [ ] Model calls have a bounded per-request budget and quota failures are
      surfaced explicitly without an execution fallback.
- [ ] Chat, new-task, init path/model, and masked-key TUI fields accept
      bracketed paste in a real PTY, with size limits and secret-safe behavior.
- [ ] The fixture suite covers at least Bun, Node/Jest or Vitest, Python,
      Go/Rust or another unsupported profile, existing Dockerfile no-op/update,
      repeated requests, and provider failure.
- [ ] `bun test`, `bun run typecheck`, `bun run specs:check`, and relevant live
      verification pass.
- [ ] User/developer documentation and `context/worklog.md` record the final
      behavior, evidence, and remaining limitations.

## Verification Plan

1. Add pure tests for capability validation, snapshot invalidation, runner
   detection, operation classification, fingerprint changes, and provider
   budget/error states.
2. Add fixture repositories representing each supported runner and ambiguous or
   unsupported layouts. Verify that no fixture executes an unapproved command.
3. Exercise an existing identical Dockerfile and prove no write call occurs;
   exercise a changed Dockerfile and prove the preview contains the diff;
   modify the file after approval and prove execution is rejected.
4. Run a real multi-process Orchestrator/agent flow proving capability
   discovery, project preflight, and authoritative dispatch.
5. Run the TUI and guided-init flows in a PTY, pasting paths, multiline task
   text, model names, and a masked key; capture sanitized evidence only.
6. Exercise provider quota/timeout errors with a fake provider or deterministic
   test double. Confirm no direct tool fallback and no unbounded retry.
7. Run the repository's full test, typecheck, and spec-governance checks, then
   record live limitations separately from passing automated evidence.

## Approval Requested

Approval authorizes drafting implementation work for this production-readiness
foundation only. It does not authorize implementation before the approval is
recorded, and it does not authorize arbitrary shell execution, unrestricted
filesystem access, removal of the approval/policy layer, cloud deployment, or
full test sandboxing.
