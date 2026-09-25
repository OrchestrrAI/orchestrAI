# OrchestrAI Specification Governance and Catalog

This directory is the source of truth for intended behavior and acceptance
criteria. Runtime truth remains the current code when documents drift.

## Authoring workflow

1. Allocate the next immutable three-digit sequence and create
   `<NNN-kebab-case-id>/spec.md` from
   [`templates/spec-template.md`](./templates/spec-template.md), with metadata
   matching [`schema/spec.schema.json`](./schema/spec.schema.json).
2. Assign one stable primary `area`, one `change_type`, and any one-way
   `amends` links. Use `related` only for untyped cross-cutting context.
3. Keep lifecycle `status` separate from `verification` confidence.
4. Present a `draft` for review; do not implement it before explicit approval.
5. Keep newly discovered in-scope work in the same draft. Create a later
   checkpoint only when an implemented decision needs independent approval,
   migration, risk control, or verification.
6. A material post-approval scope change returns the spec to `draft`.
7. Use one-way `amends` for a partial extension. Record whole-spec
   `supersedes` / `superseded_by` replacement in both specs.
8. Run `bun run specs:catalog`, then `bun run specs:check`.

Only `spec.md` is mandatory. Add `plan.md` for multi-phase/risky work and
`verification.md` for substantial evidence; never create empty companion
files. Plans cannot broaden an approved spec, and verification artifacts do not
own lifecycle status independently.

Where history lives — one ownership rule, stated identically in `CLAUDE.md`
and `AGENTS.md`:

| File | Owns |
|---|---|
| `CLAUDE.md` | Current architecture, conventions, gates, commands. Present tense. Budget-capped. |
| `specs/<NNN>/spec.md` | The approved decision and its acceptance criteria. |
| `specs/<NNN>/verification.md` | That checkpoint's evidence **and its narrative record** — what was live-caught, what was tried, what a pass found. |
| `context/worklog.md` | Dated, per-work-unit handoff entries. Append-only. |
| `context/history.md` | Pre-spec-governance historical discussion. Frozen; not appended to. |

A checkpoint's narrative goes to its own `verification.md`, never to
`CLAUDE.md`; `CLAUDE.md` gains at most a present-tense sentence plus a spec
pointer, and `bun run specs:check` enforces its 150,000-character budget.

## Lifecycle model

| Status | Meaning |
|---|---|
| `draft` | Under review; implementation is not authorized. |
| `approved` | Explicitly approved; implementation may begin. |
| `implemented` | Approved behavior exists in the repository. |
| `superseded` | A later spec replaces this governing decision. |
| `archived` | Retained as history and no longer active guidance. |

| Verification | Meaning |
|---|---|
| `pending` | Required verification has not run. |
| `partial` | Implementation exists, but named checks remain incomplete. |
| `verified` | All required acceptance evidence is recorded. |
| `not-applicable` | No implementation verification applies; the spec must explain why. |

Normal progression is `draft → approved → implemented`. Verification is
independent. A material change after approval returns the spec to `draft`
and clears approval metadata. Supersession links must be reciprocal.

## Area and checkpoint model

An `area` is a long-lived feature or engineering initiative. Each numbered
directory is an immutable specification/checkpoint, and one area may contain
many checkpoints. The six change types are `feature`, `enhancement`,
`fix`, `migration`, `spike`, and `governance`.

`amends` changes part of an older checkpoint without invalidating its history;
the catalog derives the reverse `amended by` relationship. `supersedes`
means whole-spec replacement and remains reciprocal. Do not create a new
checkpoint for a tiny correction already inside an approved scope.

Do not hand-edit the catalog below or `catalog.json`; both are generated from
spec frontmatter. Numbered specification/checkpoint directory names are stable
creation IDs, not priorities, and must never be renumbered.

<!-- GENERATED:SPEC-CATALOG:START -->

## Lifecycle summary

| Status | Count |
|---|---:|
| `draft` | 1 |
| `approved` | 2 |
| `implemented` | 137 |
| `superseded` | 0 |
| `archived` | 2 |

| Verification | Count |
|---|---:|
| `pending` | 6 |
| `partial` | 35 |
| `verified` | 98 |
| `not-applicable` | 3 |

## Specifications by area

## `ag-ui`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`021-ag-ui-event-protocol`](./021-ag-ui-event-protocol/spec.md) | AG-UI Event Protocol for the Dashboard/TUI Live Layer | `feature` | `implemented` | `verified` | [verification](./021-ag-ui-event-protocol/verification.md) | 2026-08-16 | 2026-08-10 | 2026-08-10 | — | `022-ag-ui-demo-stabilization`, `027-ag-ui-core-adoption`, `108-durable-audit-trail`, `113-live-audit-log-dashboard`, `131-demo-preflight-and-ag-ui-demo-refresh` | — | — |
| [`022-ag-ui-demo-stabilization`](./022-ag-ui-demo-stabilization/spec.md) | AG-UI Demo and TUI Stabilization | `enhancement` | `implemented` | `partial` | [plan](./022-ag-ui-demo-stabilization/plan.md), [verification](./022-ag-ui-demo-stabilization/verification.md) | 2026-08-16 | 2026-08-16 | 2026-08-16 | `021-ag-ui-event-protocol` | — | — | — |
| [`027-ag-ui-core-adoption`](./027-ag-ui-core-adoption/spec.md) | Official AG-UI Core Adoption | `migration` | `implemented` | `verified` | [verification](./027-ag-ui-core-adoption/verification.md) | 2026-08-20 | 2026-08-20 | 2026-08-20 | `021-ag-ui-event-protocol` | `044-conversational-ask-layer`, `113-live-audit-log-dashboard` | — | — |
| [`141-audit-push-honors-orchestrator-port`](./141-audit-push-honors-orchestrator-port/spec.md) | Agents Send Live Audit Events to the Configured Orchestrator Port | `fix` | `implemented` | `verified` | — | 2026-09-25 | 2026-09-25 | 2026-09-25 | `073-configurable-service-ports` | — | — | — |

## `agent-integration`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`005-mcp-agent-integration`](./005-mcp-agent-integration/spec.md) | MCP Agent Integration and Direct A2A Checkpoint | `feature` | `implemented` | `verified` | [verification](./005-mcp-agent-integration/verification.md) | 2026-08-16 | 2026-08-08 | 2026-08-08 | — | `011-remaining-agents-mcp`, `108-durable-audit-trail` | — | — |
| [`011-remaining-agents-mcp`](./011-remaining-agents-mcp/spec.md) | Testing and Documentation Agents as MCP Clients | `enhancement` | `implemented` | `verified` | [verification](./011-remaining-agents-mcp/verification.md) | 2026-08-16 | 2026-08-08 | 2026-08-08 | `005-mcp-agent-integration` | `053-production-readiness-foundation`, `076-run-tests-timeout-mismatch`, `079-phase-a-connect-orphaned-tools`, `102-orchestrator-readonly-project-inspection`, `123-safe-env-template-filename-exemption`, `129-deny-orchestrai-state-dir` | — | — |
| [`056-devops-preflight-and-idempotent-writes`](./056-devops-preflight-and-idempotent-writes/spec.md) | DevOps Preflight and Idempotent Writes — Never a Silent Overwrite | `enhancement` | `implemented` | `verified` | [verification](./056-devops-preflight-and-idempotent-writes/verification.md) | 2026-09-06 | 2026-09-06 | 2026-09-06 | `040-approval-preview-content-diff` | `079-phase-a-connect-orphaned-tools`, `109-document-api-drift-recheck`, `110-approval-state-survives-a-restart` | `053-production-readiness-foundation` | — |

## `agent-llm-harnesses`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`125-configurable-harness-recursion-limit`](./125-configurable-harness-recursion-limit/spec.md) | Configurable Shared LLM Harness Tool-Call Recursion Limit | `enhancement` | `implemented` | `verified` | [verification](./125-configurable-harness-recursion-limit/verification.md) | 2026-09-24 | 2026-09-24 | 2026-09-24 | `083-coder-agent`, `098-harness-recursion-limit-and-clean-failure` | — | — | — |

## `agents`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`077-agent-enabled-means-llm-on-by-default`](./077-agent-enabled-means-llm-on-by-default/spec.md) | Selecting/Starting an Agent Enables Its LLM Harness by Default | `enhancement` | `implemented` | `pending` | [verification](./077-agent-enabled-means-llm-on-by-default/verification.md) | 2026-09-14 | 2026-09-14 | 2026-09-14 | `039-per-component-llm-provider-config`, `041-llm-harness-documentation`, `042-llm-harness-devops`, `043-llm-harness-security`, `031-interactive-init-wizard`, `080-run-command-approved-execution` | `086-code-review-coder-default-on`, `090-devops-security-precheck-timeout-too-short` | — | — |
| [`086-code-review-coder-default-on`](./086-code-review-coder-default-on/spec.md) | Code Review and Coder Agents Also Default-On, Same as the Other Four | `enhancement` | `implemented` | `pending` | [verification](./086-code-review-coder-default-on/verification.md) | 2026-09-14 | 2026-09-14 | 2026-09-14 | `077-agent-enabled-means-llm-on-by-default`, `082-code-review-agent`, `083-coder-agent` | — | — | — |
| [`090-devops-security-precheck-timeout-too-short`](./090-devops-security-precheck-timeout-too-short/spec.md) | DevOps's Own Security Secrets Pre-check Times Out Now That Security's AI Commentary Is Default-On | `fix` | `implemented` | `verified` | [verification](./090-devops-security-precheck-timeout-too-short/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `077-agent-enabled-means-llm-on-by-default`, `043-llm-harness-security` | — | — | — |
| [`094-analyze-project-security-precheck-opt-in`](./094-analyze-project-security-precheck-opt-in/spec.md) | analyze-project's Security Secrets Pre-check Runs Unconditionally — Make It Opt-In | `enhancement` | `implemented` | `verified` | [verification](./094-analyze-project-security-precheck-opt-in/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | — | — | — | — |
| [`098-harness-recursion-limit-and-clean-failure`](./098-harness-recursion-limit-and-clean-failure/spec.md) | Every Agent LLM Harness Gets an Explicit Recursion Limit, a Clean Failure Message, and Coder Gains File-Type-Aware Early Refusal | `fix` | `implemented` | `verified` | [verification](./098-harness-recursion-limit-and-clean-failure/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `083-coder-agent`, `042-llm-harness-devops`, `041-llm-harness-documentation`, `080-run-command-approved-execution`, `081-testing-write-tests-skill`, `082-code-review-agent` | `114-coder-multi-file-edit-and-create`, `125-configurable-harness-recursion-limit` | — | — |
| [`111-testing-documentation-routing-fixes`](./111-testing-documentation-routing-fixes/spec.md) | Ambiguous-Runner Harness Resolution and Read-Only document-api Harness Reachability | `fix` | `implemented` | `verified` | [verification](./111-testing-documentation-routing-fixes/verification.md) | 2026-09-22 | 2026-09-22 | 2026-09-22 | `058-testing-agent-multi-ecosystem-runner-detection`, `080-run-command-approved-execution`, `041-llm-harness-documentation`, `100-document-api-grounded-llm-route-discovery-fallback` | — | — | — |

## `architecture`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`078-capability-upgrade-roadmap`](./078-capability-upgrade-roadmap/spec.md) | System-Wide Capability Upgrade Roadmap | `governance` | `approved` | `pending` | [plan](./078-capability-upgrade-roadmap/plan.md), [verification](./078-capability-upgrade-roadmap/verification.md) | 2026-09-12 | 2026-09-12 | — | — | — | — | — |
| [`101-per-agent-tool-access-expansion`](./101-per-agent-tool-access-expansion/spec.md) | Expand Per-Agent Tool Access, and Write Down the Tool-vs-Skill Rule | `enhancement` | `implemented` | `partial` | [verification](./101-per-agent-tool-access-expansion/verification.md) | 2026-09-20 | 2026-09-20 | 2026-09-20 | `079-phase-a-connect-orphaned-tools`, `082-code-review-agent`, `083-coder-agent` | `114-coder-multi-file-edit-and-create`, `119-coder-verify-loop-and-reviewer-depth`, `138-model-authored-files-replace-templates` | — | — |
| [`102-orchestrator-readonly-project-inspection`](./102-orchestrator-readonly-project-inspection/spec.md) | Orchestrator Gains a Read-Only, Strictly Optional Project Inspection Capability | `enhancement` | `implemented` | `partial` | [verification](./102-orchestrator-readonly-project-inspection/verification.md) | 2026-09-20 | 2026-09-20 | 2026-09-20 | `011-remaining-agents-mcp`, `044-conversational-ask-layer`, `057-project-snapshot-and-cross-request-reuse`, `065-llm-only-skill-routing`, `072-init-form-empty-selection-means-no-agents`, `075-real-conversational-chat`, `087-target-path-resolver-first-match-bug` | `103-deep-project-analysis`, `105-orchestrator-fallback-deep-analysis`, `106-persistence-store-and-result-cache`, `112-plan-step-no-agent-inspection-fallback` | — | — |
| [`106-persistence-store-and-result-cache`](./106-persistence-store-and-result-cache/spec.md) | A Local SQLite Store, and No Redundant Expensive Work | `feature` | `implemented` | `verified` | [verification](./106-persistence-store-and-result-cache/verification.md) | 2026-09-22 | 2026-09-22 | 2026-09-22 | `057-project-snapshot-and-cross-request-reuse`, `102-orchestrator-readonly-project-inspection`, `105-orchestrator-fallback-deep-analysis` | `107-task-and-conversation-history`, `108-durable-audit-trail`, `110-approval-state-survives-a-restart` | — | — |
| [`108-durable-audit-trail`](./108-durable-audit-trail/spec.md) | A Durable, Queryable Audit Trail | `feature` | `implemented` | `partial` | [verification](./108-durable-audit-trail/verification.md) | 2026-09-22 | 2026-09-22 | 2026-09-22 | `005-mcp-agent-integration`, `021-ag-ui-event-protocol`, `106-persistence-store-and-result-cache` | `113-live-audit-log-dashboard`, `115-tui-navigation-redraw-and-answer-clarity`, `117-audit-trail-governance-and-investigation`, `136-orchestrator-task-and-agent-metadata` | — | — |
| [`110-approval-state-survives-a-restart`](./110-approval-state-survives-a-restart/spec.md) | Approval State Survives an Agent Restart | `feature` | `implemented` | `verified` | [verification](./110-approval-state-survives-a-restart/verification.md) | 2026-09-22 | 2026-09-22 | 2026-09-22 | `040-approval-preview-content-diff`, `056-devops-preflight-and-idempotent-writes`, `080-run-command-approved-execution`, `081-testing-write-tests-skill`, `083-coder-agent`, `106-persistence-store-and-result-cache`, `107-task-and-conversation-history` | `114-coder-multi-file-edit-and-create` | — | — |

## `ci-cd`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`019-cicd-recreate-and-binary-builds`](./019-cicd-recreate-and-binary-builds/spec.md) | Recreate CI Workflow + Add Cross-Platform Binary Build/Publish | `feature` | `implemented` | `verified` | [verification](./019-cicd-recreate-and-binary-builds/verification.md) | 2026-08-16 | 2026-08-09 | 2026-08-09 | `014-typecheck-ci`, `017-standalone-binary-distribution` | — | — | — |

## `code-review-agent`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`082-code-review-agent`](./082-code-review-agent/spec.md) | Phase D: Code Review Agent — the First Genuinely New Agent | `feature` | `implemented` | `verified` | [verification](./082-code-review-agent/verification.md) | 2026-09-14 | 2026-09-12 | 2026-09-12 | — | `086-code-review-coder-default-on`, `098-harness-recursion-limit-and-clean-failure`, `101-per-agent-tool-access-expansion`, `119-coder-verify-loop-and-reviewer-depth` | — | — |

## `coder-agent`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`083-coder-agent`](./083-coder-agent/spec.md) | Phase E: Coder Agent v1 — Write-Capable Source Edits | `feature` | `implemented` | `partial` | [plan](./083-coder-agent/plan.md), [verification](./083-coder-agent/verification.md) | 2026-09-14 | 2026-09-14 | 2026-09-14 | — | `086-code-review-coder-default-on`, `098-harness-recursion-limit-and-clean-failure`, `101-per-agent-tool-access-expansion`, `110-approval-state-survives-a-restart`, `114-coder-multi-file-edit-and-create`, `119-coder-verify-loop-and-reviewer-depth`, `125-configurable-harness-recursion-limit` | — | — |
| [`114-coder-multi-file-edit-and-create`](./114-coder-multi-file-edit-and-create/spec.md) | Coder Agent v2: Multi-File Edits and New-File Creation | `feature` | `implemented` | `partial` | [verification](./114-coder-multi-file-edit-and-create/verification.md) | 2026-09-23 | 2026-09-22 | 2026-09-23 | `083-coder-agent`, `098-harness-recursion-limit-and-clean-failure`, `101-per-agent-tool-access-expansion`, `110-approval-state-survives-a-restart` | `119-coder-verify-loop-and-reviewer-depth`, `130-tui-dashboard-parity` | — | — |
| [`119-coder-verify-loop-and-reviewer-depth`](./119-coder-verify-loop-and-reviewer-depth/spec.md) | Coder and Code Review as Iterating Agents: a Verify-and-Fix Loop, and Review With Real Project Depth | `feature` | `implemented` | `verified` | [plan](./119-coder-verify-loop-and-reviewer-depth/plan.md), [verification](./119-coder-verify-loop-and-reviewer-depth/verification.md) | 2026-09-25 | 2026-09-23 | 2026-09-24 | `083-coder-agent`, `082-code-review-agent`, `101-per-agent-tool-access-expansion`, `114-coder-multi-file-edit-and-create`, `080-run-command-approved-execution` | — | — | — |

## `conversation`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`044-conversational-ask-layer`](./044-conversational-ask-layer/spec.md) | Conversational Ask Layer — Questions, Grounded Answers, and Conversation Threads | `feature` | `implemented` | `verified` | [plan](./044-conversational-ask-layer/plan.md), [verification](./044-conversational-ask-layer/verification.md) | 2026-09-05 | 2026-09-02 | 2026-09-02 | `027-ag-ui-core-adoption` | `046-browser-conversation-operations-workspace`, `047-tui-conversation-operations-navigation`, `053-production-readiness-foundation`, `075-real-conversational-chat`, `091-chat-explain-last-failure`, `092-router-classification-conversation-context`, `093-conversation-answer-context-blind`, `097-chat-answer-and-plan-description-honesty`, `102-orchestrator-readonly-project-inspection`, `107-task-and-conversation-history`, `115-tui-navigation-redraw-and-answer-clarity`, `116-chat-answer-voice-and-collapsed-raw-data` | — | — |

## `conversational-ask-layer`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`124-conversation-answer-llm-synthesis`](./124-conversation-answer-llm-synthesis/spec.md) | Conversation-Intent Answers Are LLM-Synthesized, Not Two Fixed Strings | `fix` | `implemented` | `verified` | [verification](./124-conversation-answer-llm-synthesis/verification.md) | 2026-09-24 | 2026-09-24 | 2026-09-24 | `093-conversation-answer-context-blind`, `116-chat-answer-voice-and-collapsed-raw-data` | — | — | — |

## `dashboard`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`033-dashboard-approval-preview-card`](./033-dashboard-approval-preview-card/spec.md) | Structured Dashboard Approval-Preview Card | `enhancement` | `implemented` | `verified` | [verification](./033-dashboard-approval-preview-card/verification.md) | 2026-08-21 | 2026-08-21 | 2026-08-21 | — | `035-devops-dashboard-approval-preview-card`, `037-tui-approval-preview-card`, `040-approval-preview-content-diff`, `046-browser-conversation-operations-workspace`, `089-plan-step-skip-continue` | — | — |
| [`035-devops-dashboard-approval-preview-card`](./035-devops-dashboard-approval-preview-card/spec.md) | Extend the Approval-Preview Card to the DevOps Agent's Own Dashboard | `enhancement` | `implemented` | `verified` | [verification](./035-devops-dashboard-approval-preview-card/verification.md) | 2026-09-01 | 2026-08-22 | 2026-08-22 | `033-dashboard-approval-preview-card` | `040-approval-preview-content-diff`, `089-plan-step-skip-continue` | — | — |
| [`040-approval-preview-content-diff`](./040-approval-preview-content-diff/spec.md) | Approval Previews Show Real Content — a Diff When Overwriting | `enhancement` | `implemented` | `verified` | [verification](./040-approval-preview-content-diff/verification.md) | 2026-09-02 | 2026-09-02 | 2026-09-02 | `033-dashboard-approval-preview-card`, `035-devops-dashboard-approval-preview-card`, `037-tui-approval-preview-card` | `053-production-readiness-foundation`, `056-devops-preflight-and-idempotent-writes`, `079-phase-a-connect-orphaned-tools`, `109-document-api-drift-recheck`, `110-approval-state-survives-a-restart`, `120-supervisor-parallel-write-dispatch` | — | — |
| [`046-browser-conversation-operations-workspace`](./046-browser-conversation-operations-workspace/spec.md) | Browser Conversation and Operations Workspace | `enhancement` | `implemented` | `partial` | [plan](./046-browser-conversation-operations-workspace/plan.md), [verification](./046-browser-conversation-operations-workspace/verification.md) | 2026-09-03 | 2026-09-02 | 2026-09-03 | `033-dashboard-approval-preview-card`, `044-conversational-ask-layer` | `113-live-audit-log-dashboard`, `115-tui-navigation-redraw-and-answer-clarity`, `116-chat-answer-voice-and-collapsed-raw-data` | — | — |
| [`113-live-audit-log-dashboard`](./113-live-audit-log-dashboard/spec.md) | The Dashboard Audit Tab Goes Live, With a Legible Kind Badge (Phase 1: Dashboard Only) | `feature` | `implemented` | `partial` | [verification](./113-live-audit-log-dashboard/verification.md) | 2026-09-22 | 2026-09-22 | 2026-09-22 | `108-durable-audit-trail`, `021-ag-ui-event-protocol`, `027-ag-ui-core-adoption`, `046-browser-conversation-operations-workspace` | `115-tui-navigation-redraw-and-answer-clarity`, `117-audit-trail-governance-and-investigation` | — | — |

## `deployment`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`009-dockerization`](./009-dockerization/spec.md) | Dockerization of OrchestrAI's Own 7 Services | `feature` | `implemented` | `verified` | [verification](./009-dockerization/verification.md) | 2026-08-16 | 2026-08-08 | 2026-08-08 | — | — | — | — |

## `devops-agent`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`079-phase-a-connect-orphaned-tools`](./079-phase-a-connect-orphaned-tools/spec.md) | Phase A: Connect the Orphaned MCP Tools + Fix safeExec's Argv Handling | `enhancement` | `implemented` | `verified` | [verification](./079-phase-a-connect-orphaned-tools/verification.md) | 2026-09-15 | 2026-09-12 | 2026-09-12 | `011-remaining-agents-mcp`, `040-approval-preview-content-diff`, `056-devops-preflight-and-idempotent-writes` | `101-per-agent-tool-access-expansion`, `143-docker-and-commit-failures-are-failures` | — | — |
| [`080-run-command-approved-execution`](./080-run-command-approved-execution/spec.md) | Phase B: run-command — a General, Per-Invocation-Approved Execution Primitive | `enhancement` | `implemented` | `verified` | [verification](./080-run-command-approved-execution/verification.md) | 2026-09-12 | 2026-09-12 | 2026-09-12 | `006-runtime-stabilization`, `042-llm-harness-devops`, `058-testing-agent-multi-ecosystem-runner-detection`, `039-per-component-llm-provider-config` | `077-agent-enabled-means-llm-on-by-default`, `081-testing-write-tests-skill`, `097-chat-answer-and-plan-description-honesty`, `098-harness-recursion-limit-and-clean-failure`, `110-approval-state-survives-a-restart`, `111-testing-documentation-routing-fixes`, `119-coder-verify-loop-and-reviewer-depth` | `076-run-tests-timeout-mismatch` | — |
| [`103-deep-project-analysis`](./103-deep-project-analysis/spec.md) | analyze-project Gains Real, Grounded Codebase Analysis | `enhancement` | `implemented` | `partial` | [verification](./103-deep-project-analysis/verification.md) | 2026-09-21 | 2026-09-20 | 2026-09-20 | `042-llm-harness-devops`, `057-project-snapshot-and-cross-request-reuse`, `099-tui-port-url-and-analyze-project-stack-awareness`, `102-orchestrator-readonly-project-inspection` | `105-orchestrator-fallback-deep-analysis` | — | — |
| [`143-docker-and-commit-failures-are-failures`](./143-docker-and-commit-failures-are-failures/spec.md) | Failed Docker Builds, Runs and Commits Fail Their Task; Image Tags Are Lowercase; Health Pings Never Kill Work | `fix` | `implemented` | `verified` | [verification](./143-docker-and-commit-failures-are-failures/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `079-phase-a-connect-orphaned-tools` | — | — | — |

## `distribution`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`017-standalone-binary-distribution`](./017-standalone-binary-distribution/spec.md) | Standalone Binary Distribution — One Combined Executable | `feature` | `implemented` | `verified` | [verification](./017-standalone-binary-distribution/verification.md) | 2026-08-16 | 2026-08-09 | 2026-08-09 | — | `018-supervisor-project-path`, `019-cicd-recreate-and-binary-builds` | — | — |
| [`032-npm-package-distribution`](./032-npm-package-distribution/spec.md) | npm Package Distribution (bunx/npx orchestrai) | `feature` | `implemented` | `partial` | [verification](./032-npm-package-distribution/verification.md) | 2026-08-21 | 2026-08-21 | 2026-08-21 | — | — | — | — |

## `documentation`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`100-document-api-grounded-llm-route-discovery-fallback`](./100-document-api-grounded-llm-route-discovery-fallback/spec.md) | document-api Gains a Grounded LLM Route-Discovery Fallback for Non-JS/TS Files | `enhancement` | `implemented` | `verified` | [verification](./100-document-api-grounded-llm-route-discovery-fallback/verification.md) | 2026-09-20 | 2026-09-20 | 2026-09-20 | `041-llm-harness-documentation`, `036-document-api-path-fallback` | `111-testing-documentation-routing-fixes` | — | — |

## `documentation-agent`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`002-documentation-agent`](./002-documentation-agent/spec.md) | Documentation Agent | `feature` | `implemented` | `partial` | — | 2026-08-16 | 2026-08-07 | 2026-08-07 | — | — | — | — |
| [`036-document-api-path-fallback`](./036-document-api-path-fallback/spec.md) | A Bounded Entry-File Fallback for document-api's Explicit-Path Requirement | `enhancement` | `implemented` | `verified` | [verification](./036-document-api-path-fallback/verification.md) | 2026-08-22 | 2026-08-22 | 2026-08-22 | — | `100-document-api-grounded-llm-route-discovery-fallback` | — | — |
| [`109-document-api-drift-recheck`](./109-document-api-drift-recheck/spec.md) | Documentation's Write Path Gains the Post-Approval Drift Recheck | `fix` | `implemented` | `verified` | [verification](./109-document-api-drift-recheck/verification.md) | 2026-09-22 | 2026-09-22 | 2026-09-22 | `040-approval-preview-content-diff`, `041-llm-harness-documentation`, `056-devops-preflight-and-idempotent-writes`, `104-deferred-work-register` | — | — | — |

## `llm-harness`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`026-llm-harness-langgraph-planning`](./026-llm-harness-langgraph-planning/spec.md) | Opt-In LangGraph Tool-Calling Harness for the Planning Agent | `feature` | `implemented` | `verified` | [verification](./026-llm-harness-langgraph-planning/verification.md) | 2026-08-16 | 2026-08-16 | 2026-08-16 | — | `029-shared-llm-provider-gemini`, `030-authoritative-skill-dispatch-and-capability-catalog` | — | — |
| [`028-orchestrator-langgraph-supervisor`](./028-orchestrator-langgraph-supervisor/spec.md) | Opt-In LangGraph Adaptive Supervisor for the Orchestrator | `feature` | `implemented` | `verified` | [plan](./028-orchestrator-langgraph-supervisor/plan.md), [verification](./028-orchestrator-langgraph-supervisor/verification.md) | 2026-09-01 | 2026-09-01 | 2026-09-01 | — | `038-supervisor-default-and-planning-retirement`, `051-planning-retirement-and-required-key`, `055-provider-call-budgets-and-transient-error-handling`, `060-supervisor-parallel-read-only-dispatch`, `089-plan-step-skip-continue`, `097-chat-answer-and-plan-description-honesty`, `112-plan-step-no-agent-inspection-fallback`, `120-supervisor-parallel-write-dispatch`, `121-skill-description-grounded-routing`, `137-plan-step-acts-only-on-its-own-step` | — | — |
| [`029-shared-llm-provider-gemini`](./029-shared-llm-provider-gemini/spec.md) | Shared LLM Provider Factory and Gemini Support | `enhancement` | `implemented` | `verified` | [verification](./029-shared-llm-provider-gemini/verification.md) | 2026-08-16 | 2026-08-16 | 2026-08-16 | `026-llm-harness-langgraph-planning` | `039-per-component-llm-provider-config` | — | — |
| [`038-supervisor-default-and-planning-retirement`](./038-supervisor-default-and-planning-retirement/spec.md) | Adaptive Supervisor as Default Planner; Planning Retirement Deferred | `migration` | `implemented` | `verified` | [plan](./038-supervisor-default-and-planning-retirement/plan.md), [verification](./038-supervisor-default-and-planning-retirement/verification.md) | 2026-09-02 | 2026-09-02 | 2026-09-02 | `028-orchestrator-langgraph-supervisor` | `051-planning-retirement-and-required-key` | — | — |
| [`039-per-component-llm-provider-config`](./039-per-component-llm-provider-config/spec.md) | Per-Component LLM Provider Configuration | `enhancement` | `implemented` | `verified` | [verification](./039-per-component-llm-provider-config/verification.md) | 2026-09-01 | 2026-09-01 | 2026-09-01 | `029-shared-llm-provider-gemini` | `077-agent-enabled-means-llm-on-by-default`, `080-run-command-approved-execution` | — | — |
| [`041-llm-harness-documentation`](./041-llm-harness-documentation/spec.md) | Opt-in LLM Harness for Documentation's Write Skills | `feature` | `implemented` | `verified` | [verification](./041-llm-harness-documentation/verification.md) | 2026-09-02 | 2026-09-02 | 2026-09-02 | — | `077-agent-enabled-means-llm-on-by-default`, `098-harness-recursion-limit-and-clean-failure`, `100-document-api-grounded-llm-route-discovery-fallback`, `109-document-api-drift-recheck`, `111-testing-documentation-routing-fixes`, `138-model-authored-files-replace-templates` | — | — |
| [`042-llm-harness-devops`](./042-llm-harness-devops/spec.md) | Opt-in LLM Harness for DevOps's Write Skills — Smarter Parameters, Not New Templates | `feature` | `implemented` | `verified` | [verification](./042-llm-harness-devops/verification.md) | 2026-09-02 | 2026-09-02 | 2026-09-02 | — | `077-agent-enabled-means-llm-on-by-default`, `080-run-command-approved-execution`, `098-harness-recursion-limit-and-clean-failure`, `103-deep-project-analysis`, `134-devops-harness-sees-the-request`, `138-model-authored-files-replace-templates` | — | — |
| [`043-llm-harness-security`](./043-llm-harness-security/spec.md) | Opt-in LLM Harness for Security — Additive Commentary, Never a Filter | `feature` | `implemented` | `verified` | [verification](./043-llm-harness-security/verification.md) | 2026-09-02 | 2026-09-02 | 2026-09-02 | — | `077-agent-enabled-means-llm-on-by-default`, `090-devops-security-precheck-timeout-too-short` | — | — |
| [`055-provider-call-budgets-and-transient-error-handling`](./055-provider-call-budgets-and-transient-error-handling/spec.md) | Provider Call Budgets and Transient-vs-Terminal Error Handling | `enhancement` | `implemented` | `verified` | [verification](./055-provider-call-budgets-and-transient-error-handling/verification.md) | 2026-09-14 | 2026-09-08 | 2026-09-08 | `028-orchestrator-langgraph-supervisor` | — | `053-production-readiness-foundation` | — |
| [`060-supervisor-parallel-read-only-dispatch`](./060-supervisor-parallel-read-only-dispatch/spec.md) | Adaptive Supervisor — Parallel Dispatch, Read-Only Steps First | `enhancement` | `implemented` | `verified` | [verification](./060-supervisor-parallel-read-only-dispatch/verification.md) | 2026-09-15 | 2026-09-06 | 2026-09-06 | `028-orchestrator-langgraph-supervisor` | `120-supervisor-parallel-write-dispatch` | — | — |
| [`120-supervisor-parallel-write-dispatch`](./120-supervisor-parallel-write-dispatch/spec.md) | Parallel Write Dispatch with Grouped Approval Over Disjoint Targets | `feature` | `implemented` | `verified` | [plan](./120-supervisor-parallel-write-dispatch/plan.md), [verification](./120-supervisor-parallel-write-dispatch/verification.md) | 2026-09-25 | 2026-09-24 | 2026-09-24 | `060-supervisor-parallel-read-only-dispatch`, `028-orchestrator-langgraph-supervisor`, `040-approval-preview-content-diff` | `130-tui-dashboard-parity` | — | — |
| [`134-devops-harness-sees-the-request`](./134-devops-harness-sees-the-request/spec.md) | DevOps Parameter Harnesses See the User's Request, So Stated Values Like a Port Are Honored | `fix` | `implemented` | `verified` | [verification](./134-devops-harness-sees-the-request/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `042-llm-harness-devops` | — | — | — |
| [`138-model-authored-files-replace-templates`](./138-model-authored-files-replace-templates/spec.md) | The Model Authors Every File and Test Command; All Templates Removed | `feature` | `implemented` | `verified` | [verification](./138-model-authored-files-replace-templates/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `042-llm-harness-devops`, `041-llm-harness-documentation`, `101-per-agent-tool-access-expansion`, `104-deferred-work-register` | — | — | — |

## `mcp`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`076-run-tests-timeout-mismatch`](./076-run-tests-timeout-mismatch/spec.md) | run-tests Always Times Out on a Real Project — Client Timeout Shorter Than the Runner's Own Budget | `fix` | `archived` | `not-applicable` | [verification](./076-run-tests-timeout-mismatch/verification.md) | 2026-09-12 | — | — | `011-remaining-agents-mcp` | — | — | `080-run-command-approved-execution` |

## `mcp-file-tools`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`123-safe-env-template-filename-exemption`](./123-safe-env-template-filename-exemption/spec.md) | Exempt Safe .env Template Filenames From the Sensitive-Filename Denial | `fix` | `implemented` | `verified` | [verification](./123-safe-env-template-filename-exemption/verification.md) | 2026-09-24 | 2026-09-24 | 2026-09-24 | `011-remaining-agents-mcp` | `129-deny-orchestrai-state-dir` | — | — |
| [`129-deny-orchestrai-state-dir`](./129-deny-orchestrai-state-dir/spec.md) | Agents Can Never Read, Write, or List OrchestrAI's Own .orchestrai State Directory | `fix` | `implemented` | `verified` | [verification](./129-deny-orchestrai-state-dir/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `011-remaining-agents-mcp`, `123-safe-env-template-filename-exemption` | — | — | — |

## `orchestrator`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`051-planning-retirement-and-required-key`](./051-planning-retirement-and-required-key/spec.md) | Planning Agent Retirement and a Required Provider Key | `migration` | `implemented` | `verified` | [plan](./051-planning-retirement-and-required-key/plan.md), [verification](./051-planning-retirement-and-required-key/verification.md) | 2026-09-05 | 2026-09-05 | 2026-09-05 | `038-supervisor-default-and-planning-retirement`, `028-orchestrator-langgraph-supervisor` | `064-supervisor-startup-key-check-non-blocking` | — | — |
| [`057-project-snapshot-and-cross-request-reuse`](./057-project-snapshot-and-cross-request-reuse/spec.md) | Project Snapshot and Safe Cross-Request Read Reuse | `enhancement` | `implemented` | `verified` | [verification](./057-project-snapshot-and-cross-request-reuse/verification.md) | 2026-09-06 | 2026-09-06 | 2026-09-06 | — | `102-orchestrator-readonly-project-inspection`, `103-deep-project-analysis`, `106-persistence-store-and-result-cache` | `053-production-readiness-foundation` | — |
| [`064-supervisor-startup-key-check-non-blocking`](./064-supervisor-startup-key-check-non-blocking/spec.md) | Supervisor Startup Key Check — Warn, Don't Block | `enhancement` | `implemented` | `partial` | [verification](./064-supervisor-startup-key-check-non-blocking/verification.md) | 2026-09-10 | 2026-09-10 | 2026-09-10 | `051-planning-retirement-and-required-key` | — | — | — |
| [`075-real-conversational-chat`](./075-real-conversational-chat/spec.md) | Make Chat a Real Conversation — LLM-Classified Intent, Live Progress, Real Findings | `enhancement` | `implemented` | `partial` | [verification](./075-real-conversational-chat/verification.md) | 2026-09-14 | 2026-09-14 | 2026-09-14 | `044-conversational-ask-layer`, `054-capability-driven-llm-routing`, `065-llm-only-skill-routing` | `091-chat-explain-last-failure`, `092-router-classification-conversation-context`, `093-conversation-answer-context-blind`, `102-orchestrator-readonly-project-inspection`, `112-plan-step-no-agent-inspection-fallback`, `128-router-resolves-contextual-replies` | — | — |
| [`089-plan-step-skip-continue`](./089-plan-step-skip-continue/spec.md) | A Third Approval Outcome — Skip One Write-Capable Plan Step Without Ending the Whole Plan | `enhancement` | `implemented` | `verified` | [verification](./089-plan-step-skip-continue/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `028-orchestrator-langgraph-supervisor`, `012-tui-interactive`, `033-dashboard-approval-preview-card`, `035-devops-dashboard-approval-preview-card` | — | — | — |
| [`091-chat-explain-last-failure`](./091-chat-explain-last-failure/spec.md) | Chat's State-Question Answer Never Surfaces a Specific Task's Real Failure Reason | `enhancement` | `implemented` | `verified` | [verification](./091-chat-explain-last-failure/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `075-real-conversational-chat`, `044-conversational-ask-layer` | `092-router-classification-conversation-context`, `097-chat-answer-and-plan-description-honesty`, `107-task-and-conversation-history`, `116-chat-answer-voice-and-collapsed-raw-data` | — | — |
| [`092-router-classification-conversation-context`](./092-router-classification-conversation-context/spec.md) | The Router's Own Classification Call Is Blind to Conversation History — Only Answer Phrasing Sees It | `enhancement` | `implemented` | `verified` | [verification](./092-router-classification-conversation-context/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `044-conversational-ask-layer`, `054-capability-driven-llm-routing`, `065-llm-only-skill-routing`, `075-real-conversational-chat`, `091-chat-explain-last-failure` | `093-conversation-answer-context-blind`, `116-chat-answer-voice-and-collapsed-raw-data`, `128-router-resolves-contextual-replies` | — | — |
| [`093-conversation-answer-context-blind`](./093-conversation-answer-context-blind/spec.md) | The 'conversation' Tier 0 Answer Is a Fixed String, Blind to What Was Actually Said | `enhancement` | `implemented` | `verified` | [verification](./093-conversation-answer-context-blind/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `075-real-conversational-chat`, `044-conversational-ask-layer`, `092-router-classification-conversation-context` | `097-chat-answer-and-plan-description-honesty`, `116-chat-answer-voice-and-collapsed-raw-data`, `124-conversation-answer-llm-synthesis` | — | — |
| [`096-router-multi-concern-request-detection`](./096-router-multi-concern-request-detection/spec.md) | Router Recognizes Multi-Concern Requests and Routes Them to plan-task | `fix` | `implemented` | `verified` | [verification](./096-router-multi-concern-request-detection/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `065-llm-only-skill-routing` | — | — | — |
| [`097-chat-answer-and-plan-description-honesty`](./097-chat-answer-and-plan-description-honesty/spec.md) | Chat Answer De-Duplication, Plan-Step Description Honesty, and a Configurable Dispatch Limit | `fix` | `implemented` | `verified` | [verification](./097-chat-answer-and-plan-description-honesty/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `044-conversational-ask-layer`, `091-chat-explain-last-failure`, `093-conversation-answer-context-blind`, `030-authoritative-skill-dispatch-and-capability-catalog`, `080-run-command-approved-execution`, `028-orchestrator-langgraph-supervisor` | `116-chat-answer-voice-and-collapsed-raw-data` | — | — |
| [`099-tui-port-url-and-analyze-project-stack-awareness`](./099-tui-port-url-and-analyze-project-stack-awareness/spec.md) | TUI Follows ORCHESTRAI_ORCHESTRATOR_PORT, and analyze-project Becomes Stack-Aware | `fix` | `implemented` | `partial` | [verification](./099-tui-port-url-and-analyze-project-stack-awareness/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `073-configurable-service-ports`, `085-multi-ecosystem-dependency-audit` | `103-deep-project-analysis` | — | — |
| [`105-orchestrator-fallback-deep-analysis`](./105-orchestrator-fallback-deep-analysis/spec.md) | Shared Project Analysis — One Implementation, Reachable With DevOps Off | `enhancement` | `implemented` | `verified` | [verification](./105-orchestrator-fallback-deep-analysis/verification.md) | 2026-09-22 | 2026-09-22 | 2026-09-22 | `102-orchestrator-readonly-project-inspection`, `103-deep-project-analysis` | `106-persistence-store-and-result-cache` | — | — |
| [`107-task-and-conversation-history`](./107-task-and-conversation-history/spec.md) | Tasks and Chat Survive a Restart | `feature` | `implemented` | `verified` | [verification](./107-task-and-conversation-history/verification.md) | 2026-09-22 | 2026-09-22 | 2026-09-22 | `044-conversational-ask-layer`, `091-chat-explain-last-failure`, `106-persistence-store-and-result-cache` | `110-approval-state-survives-a-restart` | — | — |
| [`112-plan-step-no-agent-inspection-fallback`](./112-plan-step-no-agent-inspection-fallback/spec.md) | dispatchPlanStep() Gains the Same No-Agent Inspection Fallback dispatchRootTask() Already Has | `fix` | `implemented` | `partial` | [verification](./112-plan-step-no-agent-inspection-fallback/verification.md) | 2026-09-22 | 2026-09-22 | 2026-09-22 | `102-orchestrator-readonly-project-inspection`, `028-orchestrator-langgraph-supervisor`, `075-real-conversational-chat` | — | — | — |
| [`116-chat-answer-voice-and-collapsed-raw-data`](./116-chat-answer-voice-and-collapsed-raw-data/spec.md) | Chat: One Voice for Conversational Answers, and the Raw Report Collapses Behind the Synthesis | `fix` | `implemented` | `partial` | [verification](./116-chat-answer-voice-and-collapsed-raw-data/verification.md) | 2026-09-23 | 2026-09-23 | 2026-09-23 | `044-conversational-ask-layer`, `046-browser-conversation-operations-workspace`, `091-chat-explain-last-failure`, `092-router-classification-conversation-context`, `093-conversation-answer-context-blind`, `097-chat-answer-and-plan-description-honesty`, `115-tui-navigation-redraw-and-answer-clarity` | `124-conversation-answer-llm-synthesis` | — | — |
| [`117-audit-trail-governance-and-investigation`](./117-audit-trail-governance-and-investigation/spec.md) | Audit Trail: Record Human Decisions, and Make the Log Investigable | `enhancement` | `draft` | `pending` | — | 2026-09-23 | — | — | `108-durable-audit-trail`, `113-live-audit-log-dashboard`, `115-tui-navigation-redraw-and-answer-clarity` | — | — | — |
| [`136-orchestrator-task-and-agent-metadata`](./136-orchestrator-task-and-agent-metadata/spec.md) | Orchestrator Exposes Each Task's Conversation, Tracks Agent Liveness, and Matches a Task's Agent-Side Audit Events | `fix` | `implemented` | `verified` | [verification](./136-orchestrator-task-and-agent-metadata/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `108-durable-audit-trail` | — | — | — |

## `production-readiness`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`053-production-readiness-foundation`](./053-production-readiness-foundation/spec.md) | Production-Readiness Foundation — Capability Routing, Project-Aware Operations, Testing, and TUI Input | `enhancement` | `archived` | `not-applicable` | [plan](./053-production-readiness-foundation/plan.md) | 2026-09-05 | — | — | `011-remaining-agents-mcp`, `030-authoritative-skill-dispatch-and-capability-catalog`, `040-approval-preview-content-diff`, `044-conversational-ask-layer`, `047-tui-conversation-operations-navigation`, `048-guided-init-experience` | — | — | `054-capability-driven-llm-routing`, `055-provider-call-budgets-and-transient-error-handling`, `056-devops-preflight-and-idempotent-writes`, `057-project-snapshot-and-cross-request-reuse`, `058-testing-agent-multi-ecosystem-runner-detection`, `059-tui-bracketed-paste-support` |

## `project-targeting`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`004-configurable-project-paths`](./004-configurable-project-paths/spec.md) | Configurable Target Project Paths | `feature` | `implemented` | `verified` | [verification](./004-configurable-project-paths/verification.md) | 2026-08-16 | 2026-08-08 | 2026-08-08 | — | `007-parsing-and-sse-reliability-fixes`, `087-target-path-resolver-first-match-bug`, `088-target-path-resolver-trailing-colon-bug` | — | — |
| [`087-target-path-resolver-first-match-bug`](./087-target-path-resolver-first-match-bug/spec.md) | extractExplicitTargetPath() Stops at the First at/in/to/from Match, Even When It's Wrong | `fix` | `implemented` | `verified` | [verification](./087-target-path-resolver-first-match-bug/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `004-configurable-project-paths`, `007-parsing-and-sse-reliability-fixes`, `020-semantic-intent-fallback` | `088-target-path-resolver-trailing-colon-bug`, `102-orchestrator-readonly-project-inspection`, `140-target-path-for-and-on-prepositions` | — | — |
| [`088-target-path-resolver-trailing-colon-bug`](./088-target-path-resolver-trailing-colon-bug/spec.md) | normalizeAbsolutePath() Leaves a Stray Trailing Colon When a Path Is Immediately Followed by ':' | `fix` | `implemented` | `verified` | [verification](./088-target-path-resolver-trailing-colon-bug/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `004-configurable-project-paths`, `007-parsing-and-sse-reliability-fixes`, `020-semantic-intent-fallback`, `087-target-path-resolver-first-match-bug` | — | — | — |
| [`140-target-path-for-and-on-prepositions`](./140-target-path-for-and-on-prepositions/spec.md) | Target Path Named After "for" or "on" Is Recognized | `fix` | `implemented` | `verified` | — | 2026-09-25 | 2026-09-25 | 2026-09-25 | `087-target-path-resolver-first-match-bug` | — | — | — |

## `quality-gates`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`014-typecheck-ci`](./014-typecheck-ci/spec.md) | Make Type Checking Reproducible and CI Actually Pass | `governance` | `implemented` | `verified` | [verification](./014-typecheck-ci/verification.md) | 2026-08-16 | 2026-08-09 | 2026-08-09 | — | `019-cicd-recreate-and-binary-builds` | — | — |
| [`052-ci-plan-task-dispatch-smoke-test`](./052-ci-plan-task-dispatch-smoke-test/spec.md) | CI Smoke Test — plan-task and suggest-agents Actually Dispatch | `enhancement` | `implemented` | `verified` | [verification](./052-ci-plan-task-dispatch-smoke-test/verification.md) | 2026-09-05 | 2026-09-05 | 2026-09-05 | — | `065-llm-only-skill-routing` | — | — |
| [`131-demo-preflight-and-ag-ui-demo-refresh`](./131-demo-preflight-and-ag-ui-demo-refresh/spec.md) | Demo Preflight Check and a Working AG-UI Demo Script | `enhancement` | `implemented` | `verified` | [verification](./131-demo-preflight-and-ag-ui-demo-refresh/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `021-ag-ui-event-protocol` | `142-demo-rehearsal-more-scenarios` | — | — |
| [`142-demo-rehearsal-more-scenarios`](./142-demo-rehearsal-more-scenarios/spec.md) | More Scenarios in the AG-UI Demo Rehearsal | `enhancement` | `implemented` | `verified` | [verification](./142-demo-rehearsal-more-scenarios/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `131-demo-preflight-and-ag-ui-demo-refresh` | — | — | — |

## `routing-planning`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`008-routing-fixes`](./008-routing-fixes/spec.md) | Orchestrator and Planning Routing Fixes for Documentation and Security | `fix` | `implemented` | `verified` | [verification](./008-routing-fixes/verification.md) | 2026-08-16 | 2026-08-08 | 2026-08-08 | — | `015-routing-planning-polish-2`, `020-semantic-intent-fallback` | — | — |
| [`015-routing-planning-polish-2`](./015-routing-planning-polish-2/spec.md) | Routing/Planning Polish — Round 2 (Testing routing, ci-substring, "set up") | `fix` | `implemented` | `verified` | [verification](./015-routing-planning-polish-2/verification.md) | 2026-08-16 | 2026-08-09 | 2026-08-09 | `008-routing-fixes` | `020-semantic-intent-fallback` | — | — |
| [`020-semantic-intent-fallback`](./020-semantic-intent-fallback/spec.md) | Semantic Intent Fallback (Model2Vec Static Embeddings) | `enhancement` | `implemented` | `verified` | [verification](./020-semantic-intent-fallback/verification.md) | 2026-08-16 | 2026-08-10 | 2026-08-10 | `008-routing-fixes`, `015-routing-planning-polish-2` | `054-capability-driven-llm-routing`, `065-llm-only-skill-routing`, `087-target-path-resolver-first-match-bug`, `088-target-path-resolver-trailing-colon-bug` | — | — |
| [`030-authoritative-skill-dispatch-and-capability-catalog`](./030-authoritative-skill-dispatch-and-capability-catalog/spec.md) | Authoritative Skill Dispatch and Agent-Card Capability Catalog | `fix` | `implemented` | `verified` | [plan](./030-authoritative-skill-dispatch-and-capability-catalog/plan.md), [verification](./030-authoritative-skill-dispatch-and-capability-catalog/verification.md) | 2026-08-16 | 2026-08-16 | 2026-08-16 | `006-runtime-stabilization`, `026-llm-harness-langgraph-planning` | `053-production-readiness-foundation`, `097-chat-answer-and-plan-description-honesty`, `121-skill-description-grounded-routing` | — | — |
| [`054-capability-driven-llm-routing`](./054-capability-driven-llm-routing/spec.md) | Capability-Driven LLM Routing Tier, Validated Against Live Agent Cards | `enhancement` | `implemented` | `verified` | [verification](./054-capability-driven-llm-routing/verification.md) | 2026-09-15 | 2026-09-06 | 2026-09-06 | `020-semantic-intent-fallback` | `065-llm-only-skill-routing`, `075-real-conversational-chat`, `092-router-classification-conversation-context` | `053-production-readiness-foundation` | — |
| [`065-llm-only-skill-routing`](./065-llm-only-skill-routing/spec.md) | LLM-Only Skill Routing — Retire Keyword Matching and the Local Classifier | `migration` | `implemented` | `partial` | [verification](./065-llm-only-skill-routing/verification.md) | 2026-09-10 | 2026-09-10 | 2026-09-10 | `020-semantic-intent-fallback`, `054-capability-driven-llm-routing`, `052-ci-plan-task-dispatch-smoke-test` | `075-real-conversational-chat`, `092-router-classification-conversation-context`, `096-router-multi-concern-request-detection`, `102-orchestrator-readonly-project-inspection` | — | — |
| [`121-skill-description-grounded-routing`](./121-skill-description-grounded-routing/spec.md) | Skill-Description-Grounded Routing (Router and Adaptive Supervisor) | `fix` | `implemented` | `verified` | [verification](./121-skill-description-grounded-routing/verification.md) | 2026-09-24 | 2026-09-24 | 2026-09-24 | `030-authoritative-skill-dispatch-and-capability-catalog`, `028-orchestrator-langgraph-supervisor` | `126-write-tests-description-grounded-routing`, `133-supervisor-edit-file-names-its-file` | — | — |
| [`126-write-tests-description-grounded-routing`](./126-write-tests-description-grounded-routing/spec.md) | Route Whole-Project Test Requests to the Planner via write-tests' Own Description | `fix` | `implemented` | `verified` | [verification](./126-write-tests-description-grounded-routing/verification.md) | 2026-09-24 | 2026-09-24 | 2026-09-24 | `121-skill-description-grounded-routing`, `081-testing-write-tests-skill` | — | — | — |
| [`128-router-resolves-contextual-replies`](./128-router-resolves-contextual-replies/spec.md) | The Router Rewrites a Contextual Chat Reply into a Self-Contained Request | `fix` | `implemented` | `verified` | [verification](./128-router-resolves-contextual-replies/verification.md) | 2026-09-24 | 2026-09-24 | 2026-09-24 | `092-router-classification-conversation-context`, `075-real-conversational-chat` | — | — | — |
| [`133-supervisor-edit-file-names-its-file`](./133-supervisor-edit-file-names-its-file/spec.md) | Supervisor Names the File in Every edit-file Step, and Plans a Multi-File Change as One edit-files Step | `fix` | `implemented` | `verified` | [verification](./133-supervisor-edit-file-names-its-file/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `121-skill-description-grounded-routing` | — | — | — |
| [`137-plan-step-acts-only-on-its-own-step`](./137-plan-step-acts-only-on-its-own-step/spec.md) | Every Plan Step Acts Only on Its Own Step, With the Full Request as Background | `fix` | `implemented` | `verified` | [verification](./137-plan-step-acts-only-on-its-own-step/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `028-orchestrator-langgraph-supervisor` | `139-close-remaining-follow-ups` | — | — |

## `runtime-reliability`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`006-runtime-stabilization`](./006-runtime-stabilization/spec.md) | Demo Runtime Stabilization and Approval Integrity | `fix` | `implemented` | `verified` | [verification](./006-runtime-stabilization/verification.md) | 2026-08-16 | 2026-08-08 | 2026-08-08 | — | `007-parsing-and-sse-reliability-fixes`, `030-authoritative-skill-dispatch-and-capability-catalog`, `080-run-command-approved-execution` | — | — |
| [`007-parsing-and-sse-reliability-fixes`](./007-parsing-and-sse-reliability-fixes/spec.md) | Target-Path Parsing Fallback and Orchestrator SSE Reliability Fixes | `fix` | `implemented` | `verified` | [verification](./007-parsing-and-sse-reliability-fixes/verification.md) | 2026-08-16 | 2026-08-08 | 2026-08-08 | `004-configurable-project-paths`, `006-runtime-stabilization` | `087-target-path-resolver-first-match-bug`, `088-target-path-resolver-trailing-colon-bug` | — | — |

## `runtime-supervision`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`016-orchestrai-supervisor`](./016-orchestrai-supervisor/spec.md) | `orchestrai` Process Supervisor | `feature` | `implemented` | `verified` | [verification](./016-orchestrai-supervisor/verification.md) | 2026-09-01 | 2026-08-09 | 2026-08-09 | — | `018-supervisor-project-path`, `045-supervisor-port-preflight-timeout`, `066-supervisor-log-suppression-during-tui`, `067-supervisor-kill-orphaned-children-on-exit`, `073-configurable-service-ports` | — | — |
| [`018-supervisor-project-path`](./018-supervisor-project-path/spec.md) | Convenient Project-Path Configuration for the Supervisor/Binary | `enhancement` | `implemented` | `verified` | [verification](./018-supervisor-project-path/verification.md) | 2026-08-16 | 2026-08-09 | 2026-08-09 | `016-orchestrai-supervisor`, `017-standalone-binary-distribution` | — | — | — |
| [`045-supervisor-port-preflight-timeout`](./045-supervisor-port-preflight-timeout/spec.md) | Supervisor Port Preflight — Bounded Timeout, Never a Silent Hang | `fix` | `implemented` | `verified` | [verification](./045-supervisor-port-preflight-timeout/verification.md) | 2026-09-02 | 2026-09-02 | 2026-09-02 | `016-orchestrai-supervisor` | — | — | — |
| [`066-supervisor-log-suppression-during-tui`](./066-supervisor-log-suppression-during-tui/spec.md) | Suppress Raw Backend Logs Once the Auto-Launched TUI Owns the Terminal | `fix` | `implemented` | `partial` | [verification](./066-supervisor-log-suppression-during-tui/verification.md) | 2026-09-10 | 2026-09-10 | 2026-09-10 | `016-orchestrai-supervisor`, `062-guided-init-tui-as-child-process` | — | — | — |
| [`067-supervisor-kill-orphaned-children-on-exit`](./067-supervisor-kill-orphaned-children-on-exit/spec.md) | Supervisor — Kill Child Services on Any Parent Exit, Including Window Close | `fix` | `implemented` | `partial` | [verification](./067-supervisor-kill-orphaned-children-on-exit/verification.md) | 2026-09-10 | 2026-09-10 | 2026-09-10 | `016-orchestrai-supervisor` | `074-fix-exit-backstop-argument-bug` | — | — |

## `security-agent`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`003-security-agent`](./003-security-agent/spec.md) | Security Agent | `feature` | `implemented` | `partial` | — | 2026-08-16 | 2026-08-07 | 2026-08-07 | — | `013-security-skill-detection` | — | — |
| [`013-security-skill-detection`](./013-security-skill-detection/spec.md) | Broaden Security Agent's Own Skill Detection | `fix` | `implemented` | `verified` | [verification](./013-security-skill-detection/verification.md) | 2026-08-16 | 2026-08-09 | 2026-08-09 | `003-security-agent` | — | — | — |
| [`084-security-external-vulnerability-data`](./084-security-external-vulnerability-data/spec.md) | Phase F: Security Gains Real Vulnerability Data (OSV.dev) | `feature` | `implemented` | `partial` | [plan](./084-security-external-vulnerability-data/plan.md), [verification](./084-security-external-vulnerability-data/verification.md) | 2026-09-14 | 2026-09-14 | 2026-09-14 | — | — | — | — |
| [`085-multi-ecosystem-dependency-audit`](./085-multi-ecosystem-dependency-audit/spec.md) | audit-dependencies — Real Python, Go, PHP, and Java Support, Not npm-Only | `feature` | `implemented` | `verified` | [verification](./085-multi-ecosystem-dependency-audit/verification.md) | 2026-09-15 | 2026-09-14 | 2026-09-14 | — | `099-tui-port-url-and-analyze-project-stack-awareness` | — | — |

## `spec-governance`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`023-spec-governance-and-catalog`](./023-spec-governance-and-catalog/spec.md) | Spec Governance, Lifecycle Metadata, and Catalog | `governance` | `implemented` | `verified` | [verification](./023-spec-governance-and-catalog/verification.md) | 2026-08-16 | 2026-08-16 | 2026-08-16 | — | `024-spec-folder-migration`, `025-spec-area-grouping`, `118-claude-md-size-and-history-relocation` | — | — |
| [`024-spec-folder-migration`](./024-spec-folder-migration/spec.md) | Numbered Feature Folders for Specification Artifacts | `migration` | `implemented` | `verified` | [plan](./024-spec-folder-migration/plan.md), [verification](./024-spec-folder-migration/verification.md) | 2026-08-16 | 2026-08-16 | 2026-08-16 | `023-spec-governance-and-catalog` | `025-spec-area-grouping` | — | — |
| [`025-spec-area-grouping`](./025-spec-area-grouping/spec.md) | Specification Area Grouping and Amendment Semantics | `enhancement` | `implemented` | `verified` | [plan](./025-spec-area-grouping/plan.md), [verification](./025-spec-area-grouping/verification.md) | 2026-08-16 | 2026-08-16 | 2026-08-16 | `023-spec-governance-and-catalog`, `024-spec-folder-migration` | `118-claude-md-size-and-history-relocation` | — | — |
| [`104-deferred-work-register`](./104-deferred-work-register/spec.md) | Deferred Work Register — Known Gaps Not Yet Specced | `governance` | `approved` | `not-applicable` | [verification](./104-deferred-work-register/verification.md) | 2026-09-22 | 2026-09-20 | — | — | `109-document-api-drift-recheck`, `138-model-authored-files-replace-templates` | — | — |
| [`118-claude-md-size-and-history-relocation`](./118-claude-md-size-and-history-relocation/spec.md) | CLAUDE.md Under a Hard Size Budget: Relocate Per-Spec History into specs/ | `governance` | `implemented` | `verified` | [plan](./118-claude-md-size-and-history-relocation/plan.md), [verification](./118-claude-md-size-and-history-relocation/verification.md) | 2026-09-23 | 2026-09-23 | 2026-09-23 | `023-spec-governance-and-catalog`, `025-spec-area-grouping` | — | — | — |

## `supervisor`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`031-interactive-init-wizard`](./031-interactive-init-wizard/spec.md) | Interactive "orch init" Setup Wizard | `feature` | `implemented` | `verified` | [verification](./031-interactive-init-wizard/verification.md) | 2026-09-01 | 2026-08-21 | 2026-08-21 | — | `034-init-wizard-services-ux`, `048-guided-init-experience`, `049-guided-init-web-setup`, `050-init-per-agent-llm-toggles`, `077-agent-enabled-means-llm-on-by-default` | — | — |
| [`034-init-wizard-services-ux`](./034-init-wizard-services-ux/spec.md) | Init Wizard Services Prompt — Numbered Selection, No Infrastructure Choices | `enhancement` | `implemented` | `verified` | [verification](./034-init-wizard-services-ux/verification.md) | 2026-09-01 | 2026-08-21 | 2026-08-21 | `031-interactive-init-wizard` | `048-guided-init-experience`, `072-init-form-empty-selection-means-no-agents` | — | — |
| [`048-guided-init-experience`](./048-guided-init-experience/spec.md) | Guided Init — TUI Setup Form and Launch Handoff | `enhancement` | `implemented` | `partial` | [plan](./048-guided-init-experience/plan.md), [verification](./048-guided-init-experience/verification.md) | 2026-09-05 | 2026-09-04 | 2026-09-04 | `031-interactive-init-wizard`, `034-init-wizard-services-ux` | `050-init-per-agent-llm-toggles`, `053-production-readiness-foundation`, `059-tui-bracketed-paste-support`, `062-guided-init-tui-as-child-process`, `072-init-form-empty-selection-means-no-agents`, `073-configurable-service-ports`, `122-remove-init-save-and-start` | — | — |
| [`049-guided-init-web-setup`](./049-guided-init-web-setup/spec.md) | Guided Init — Browser Setup Page | `enhancement` | `implemented` | `partial` | [verification](./049-guided-init-web-setup/verification.md) | 2026-09-07 | 2026-09-04 | 2026-09-07 | `031-interactive-init-wizard` | — | — | — |
| [`050-init-per-agent-llm-toggles`](./050-init-per-agent-llm-toggles/spec.md) | Init — Per-Agent LLM Toggles, Model Overrides, and Non-Destructive Config Writes | `enhancement` | `implemented` | `verified` | [plan](./050-init-per-agent-llm-toggles/plan.md), [verification](./050-init-per-agent-llm-toggles/verification.md) | 2026-09-05 | 2026-09-04 | 2026-09-05 | `031-interactive-init-wizard`, `048-guided-init-experience` | `063-init-per-component-provider-and-key`, `070-init-agent-implies-llm-and-model-first-setup`, `071-models-view-inline-provider-in-picker` | — | — |
| [`062-guided-init-tui-as-child-process`](./062-guided-init-tui-as-child-process/spec.md) | Guided Init — Spawn the Auto-Launched TUI as a Separate Process | `fix` | `implemented` | `partial` | [verification](./062-guided-init-tui-as-child-process/verification.md) | 2026-09-06 | 2026-09-06 | 2026-09-06 | `048-guided-init-experience` | `066-supervisor-log-suppression-during-tui` | — | — |
| [`063-init-per-component-provider-and-key`](./063-init-per-component-provider-and-key/spec.md) | Init — Provider Credentials Tab and Live Per-Agent Model Discovery | `enhancement` | `implemented` | `partial` | [verification](./063-init-per-component-provider-and-key/verification.md) | 2026-09-10 | 2026-09-10 | 2026-09-10 | `050-init-per-agent-llm-toggles` | `068-init-providers-first-flow-and-model-picker`, `070-init-agent-implies-llm-and-model-first-setup`, `071-models-view-inline-provider-in-picker`, `132-init-multi-provider-keys` | — | — |
| [`068-init-providers-first-flow-and-model-picker`](./068-init-providers-first-flow-and-model-picker/spec.md) | Guided Init — Providers-First Flow and a Real Model Picker | `enhancement` | `implemented` | `partial` | [verification](./068-init-providers-first-flow-and-model-picker/verification.md) | 2026-09-10 | 2026-09-10 | 2026-09-10 | `063-init-per-component-provider-and-key` | `070-init-agent-implies-llm-and-model-first-setup`, `071-models-view-inline-provider-in-picker` | — | — |
| [`070-init-agent-implies-llm-and-model-first-setup`](./070-init-agent-implies-llm-and-model-first-setup/spec.md) | Guided Init — Agent Selection Implies LLM, and a Model-First Setup Screen | `enhancement` | `implemented` | `pending` | [verification](./070-init-agent-implies-llm-and-model-first-setup/verification.md) | 2026-09-10 | 2026-09-10 | 2026-09-10 | `050-init-per-agent-llm-toggles`, `068-init-providers-first-flow-and-model-picker`, `063-init-per-component-provider-and-key` | `071-models-view-inline-provider-in-picker`, `132-init-multi-provider-keys` | — | — |
| [`071-models-view-inline-provider-in-picker`](./071-models-view-inline-provider-in-picker/spec.md) | Fold Per-Agent Model & Provider Selection Into the Setup Screen (Retire the Models View) | `enhancement` | `implemented` | `pending` | [verification](./071-models-view-inline-provider-in-picker/verification.md) | 2026-09-11 | 2026-09-11 | 2026-09-11 | `050-init-per-agent-llm-toggles`, `063-init-per-component-provider-and-key`, `068-init-providers-first-flow-and-model-picker`, `070-init-agent-implies-llm-and-model-first-setup` | `072-init-form-empty-selection-means-no-agents`, `073-configurable-service-ports`, `095-init-models-section-orchestrator-conversation-rows`, `132-init-multi-provider-keys` | — | — |
| [`072-init-form-empty-selection-means-no-agents`](./072-init-form-empty-selection-means-no-agents/spec.md) | Guided Init Forms — An Explicitly Empty Agent Selection Means No Agents, Not All | `enhancement` | `implemented` | `partial` | [verification](./072-init-form-empty-selection-means-no-agents/verification.md) | 2026-09-11 | 2026-09-11 | 2026-09-11 | `034-init-wizard-services-ux`, `048-guided-init-experience`, `071-models-view-inline-provider-in-picker` | `102-orchestrator-readonly-project-inspection` | — | — |
| [`073-configurable-service-ports`](./073-configurable-service-ports/spec.md) | Configurable Service Ports (Env-Var Plumbing + Guided Init UI) | `enhancement` | `implemented` | `partial` | [verification](./073-configurable-service-ports/verification.md) | 2026-09-11 | 2026-09-11 | 2026-09-11 | `016-orchestrai-supervisor`, `048-guided-init-experience`, `071-models-view-inline-provider-in-picker` | `099-tui-port-url-and-analyze-project-stack-awareness`, `141-audit-push-honors-orchestrator-port` | — | — |
| [`074-fix-exit-backstop-argument-bug`](./074-fix-exit-backstop-argument-bug/spec.md) | Fix the Supervisor's exit Backstop — killAllChildrenSync Never Actually Ran | `fix` | `implemented` | `verified` | [verification](./074-fix-exit-backstop-argument-bug/verification.md) | 2026-09-11 | 2026-09-11 | 2026-09-11 | `067-supervisor-kill-orphaned-children-on-exit` | — | — | — |
| [`095-init-models-section-orchestrator-conversation-rows`](./095-init-models-section-orchestrator-conversation-rows/spec.md) | Guided Init's Models Section Gains orchestrator and conversation Rows | `enhancement` | `implemented` | `partial` | [verification](./095-init-models-section-orchestrator-conversation-rows/verification.md) | 2026-09-15 | 2026-09-15 | 2026-09-15 | `071-models-view-inline-provider-in-picker` | — | — | — |
| [`122-remove-init-save-and-start`](./122-remove-init-save-and-start/spec.md) | Remove the Same-Session "Save and Start" Path From orchestrai init | `fix` | `implemented` | `partial` | — | 2026-09-25 | 2026-09-24 | 2026-09-24 | `048-guided-init-experience` | — | — | — |
| [`132-init-multi-provider-keys`](./132-init-multi-provider-keys/spec.md) | Guided Init Keeps Every Registered Provider Key and Lets Any Row, Including the Default, Use Any of Them | `fix` | `implemented` | `verified` | [verification](./132-init-multi-provider-keys/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `063-init-per-component-provider-and-key`, `070-init-agent-implies-llm-and-model-first-setup`, `071-models-view-inline-provider-in-picker` | — | — | — |

## `testing-agent`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`001-testing-agent`](./001-testing-agent/spec.md) | Testing Agent | `feature` | `implemented` | `partial` | — | 2026-08-16 | 2026-08-07 | 2026-08-07 | — | `058-testing-agent-multi-ecosystem-runner-detection` | — | — |
| [`058-testing-agent-multi-ecosystem-runner-detection`](./058-testing-agent-multi-ecosystem-runner-detection/spec.md) | Testing Agent — Real Multi-Ecosystem Runner Detection, Never a Guess | `enhancement` | `implemented` | `verified` | [verification](./058-testing-agent-multi-ecosystem-runner-detection/verification.md) | 2026-09-06 | 2026-09-06 | 2026-09-06 | `001-testing-agent` | `080-run-command-approved-execution`, `111-testing-documentation-routing-fixes` | `053-production-readiness-foundation` | — |
| [`081-testing-write-tests-skill`](./081-testing-write-tests-skill/spec.md) | Phase C: write-tests — Testing Agent Authors a Real Test File | `feature` | `implemented` | `verified` | [verification](./081-testing-write-tests-skill/verification.md) | 2026-09-12 | 2026-09-12 | 2026-09-12 | `080-run-command-approved-execution` | `098-harness-recursion-limit-and-clean-failure`, `110-approval-state-survives-a-restart`, `126-write-tests-description-grounded-routing`, `127-write-tests-names-test-file-location` | — | — |
| [`127-write-tests-names-test-file-location`](./127-write-tests-names-test-file-location/spec.md) | write-tests Harness Is Told Where Its Test File Will Be Written | `enhancement` | `implemented` | `verified` | — | 2026-09-24 | 2026-09-24 | 2026-09-24 | `081-testing-write-tests-skill` | — | — | — |

## `tui`

| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`010-tui-cli`](./010-tui-cli/spec.md) | Minimal Read-Only Terminal UI (OpenTUI) | `feature` | `implemented` | `partial` | [verification](./010-tui-cli/verification.md) | 2026-08-16 | 2026-08-08 | 2026-08-08 | — | `012-tui-interactive` | — | — |
| [`012-tui-interactive`](./012-tui-interactive/spec.md) | Interactive TUI — Approve, Reject, and Submit from the Terminal | `enhancement` | `implemented` | `partial` | [verification](./012-tui-interactive/verification.md) | 2026-08-16 | 2026-08-08 | 2026-08-09 | `010-tui-cli` | `047-tui-conversation-operations-navigation`, `059-tui-bracketed-paste-support`, `069-tui-dashboard-parity-workspace`, `089-plan-step-skip-continue`, `115-tui-navigation-redraw-and-answer-clarity` | — | — |
| [`037-tui-approval-preview-card`](./037-tui-approval-preview-card/spec.md) | Structured Approval-Preview in the TUI Detail View | `enhancement` | `implemented` | `verified` | [verification](./037-tui-approval-preview-card/verification.md) | 2026-09-01 | 2026-09-01 | 2026-09-01 | `033-dashboard-approval-preview-card` | `040-approval-preview-content-diff`, `047-tui-conversation-operations-navigation` | — | — |
| [`047-tui-conversation-operations-navigation`](./047-tui-conversation-operations-navigation/spec.md) | TUI Conversation and Operations Navigation | `enhancement` | `implemented` | `verified` | [plan](./047-tui-conversation-operations-navigation/plan.md), [verification](./047-tui-conversation-operations-navigation/verification.md) | 2026-09-06 | 2026-09-03 | 2026-09-05 | `012-tui-interactive`, `037-tui-approval-preview-card`, `044-conversational-ask-layer` | `053-production-readiness-foundation`, `115-tui-navigation-redraw-and-answer-clarity` | — | — |
| [`059-tui-bracketed-paste-support`](./059-tui-bracketed-paste-support/spec.md) | TUI and Guided-Init Bracketed Paste Support | `enhancement` | `implemented` | `verified` | [verification](./059-tui-bracketed-paste-support/verification.md) | 2026-09-07 | 2026-09-07 | 2026-09-07 | `012-tui-interactive`, `048-guided-init-experience` | — | `053-production-readiness-foundation` | — |
| [`069-tui-dashboard-parity-workspace`](./069-tui-dashboard-parity-workspace/spec.md) | TUI — Dashboard-Parity Three-Panel Workspace | `enhancement` | `implemented` | `partial` | [plan](./069-tui-dashboard-parity-workspace/plan.md), [verification](./069-tui-dashboard-parity-workspace/verification.md) | 2026-09-12 | 2026-09-10 | 2026-09-10 | `012-tui-interactive` | `115-tui-navigation-redraw-and-answer-clarity`, `130-tui-dashboard-parity`, `135-tui-80-column-header-and-titles` | — | — |
| [`115-tui-navigation-redraw-and-answer-clarity`](./115-tui-navigation-redraw-and-answer-clarity/spec.md) | TUI: Real Thread Selection, a Tab-Cycle Redraw Investigation, One Chat Answer Instead of Three, and a More Declarative Audit View | `fix` | `implemented` | `partial` | [verification](./115-tui-navigation-redraw-and-answer-clarity/verification.md) | 2026-09-23 | 2026-09-23 | 2026-09-23 | `012-tui-interactive`, `044-conversational-ask-layer`, `046-browser-conversation-operations-workspace`, `047-tui-conversation-operations-navigation`, `069-tui-dashboard-parity-workspace`, `108-durable-audit-trail`, `113-live-audit-log-dashboard` | `116-chat-answer-voice-and-collapsed-raw-data`, `117-audit-trail-governance-and-investigation` | — | — |
| [`130-tui-dashboard-parity`](./130-tui-dashboard-parity/spec.md) | TUI Parity with the Orchestrator Dashboard | `enhancement` | `implemented` | `verified` | [verification](./130-tui-dashboard-parity/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `069-tui-dashboard-parity-workspace`, `114-coder-multi-file-edit-and-create`, `120-supervisor-parallel-write-dispatch` | `139-close-remaining-follow-ups` | — | — |
| [`135-tui-80-column-header-and-titles`](./135-tui-80-column-header-and-titles/spec.md) | TUI Header Fits 80 Columns, and Centre Titles (Audit, Chat) Show at 80×24 | `fix` | `implemented` | `verified` | [verification](./135-tui-80-column-header-and-titles/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `069-tui-dashboard-parity-workspace` | — | — | — |
| [`139-close-remaining-follow-ups`](./139-close-remaining-follow-ups/spec.md) | Close the Remaining Follow-ups From Specs 130–137 | `fix` | `implemented` | `verified` | [verification](./139-close-remaining-follow-ups/verification.md) | 2026-09-25 | 2026-09-25 | 2026-09-25 | `130-tui-dashboard-parity`, `137-plan-step-acts-only-on-its-own-step` | — | — | — |

<!-- GENERATED:SPEC-CATALOG:END -->
