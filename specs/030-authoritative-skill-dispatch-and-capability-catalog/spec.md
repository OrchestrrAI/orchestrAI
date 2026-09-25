---
id: 030-authoritative-skill-dispatch-and-capability-catalog
title: Authoritative Skill Dispatch and Agent-Card Capability Catalog
area: routing-planning
change_type: fix
status: implemented
verification: verified
created: 2026-08-16
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-16
implemented_on: 2026-08-16
amends:
  - 006-runtime-stabilization
  - 026-llm-harness-langgraph-planning
supersedes: []
superseded_by: []
related:
  - 028-orchestrator-langgraph-supervisor
  - 029-shared-llm-provider-gemini
---

# Spec: Authoritative Skill Dispatch and Agent-Card Capability Catalog

> Status history: **APPROVED by Yusuf on 2026-08-16, with one review
> correction applied before approval** — Planning's direct-request
> discovery is bound to `packages/shared/agent-registry.ts`'s fixed five
> URLs, not a new configurable endpoint (see section 2 and the safety
> constraints). **IMPLEMENTED the same day, and VERIFIED on 2026-08-20** —
> see
> `specs/030-authoritative-skill-dispatch-and-capability-catalog/verification.md`
> for full evidence, including the live Gemini re-run against a real
> target project and one real operational incident it surfaced (and
> corrected) along the way.

## Purpose

Fix the live-discovered routing defect where the Orchestrator selected a
read-only `git-status` plan step, but the DevOps Agent re-read the step's
natural-language description, noticed the word `Dockerfile`, and changed the
operation to write-capable `dockerize`.

The fix makes the Orchestrator's validated high-level skill selection
authoritative across dispatch. It also removes Planning's fixed
`KNOWN_SKILL_IDS` catalog: the LLM receives a bounded high-level capability
catalog derived from currently available Agent Cards. Operational agents
continue to own the mapping from a high-level skill to internal code or an
MCP tool. The planner does not learn or select privileged MCP tool names.

The target boundary is:

```text
Agent Cards -> bounded high-level capability catalog -> Planning proposes
            -> Orchestrator validates selectedSkill -> owning agent executes
            -> owning agent maps selectedSkill to internal/MCP implementation
```

## Verified Current State

- The Orchestrator discovers `/.well-known/agent.json` documents into its
  in-memory registry. Every card already declares `skills[]` with `id`, `name`,
  and `description`; `findAgentForSkill()` already uses those discovered IDs.
- `parsePlanText()` preserves each model-emitted `step.skill`, and
  `dispatchPlanStep()` stores that skill on the Orchestrator child task and
  chooses the owning agent from the live registry.
- `sendTaskToAgent()` then drops that selection. Its outgoing envelope contains
  only `{ id, message: { role, parts: [{ text }] } }`.
- `packages/shared/task-envelope.ts` has no skill or capability field.
- Every receiving agent calls its own `detectSkill(task.text)` in
  `processTask()`, so descriptive text can replace the Orchestrator's decision.
- The exact live failure is recorded in 026/029 verification evidence. The
  Orchestrator child stored `skill: git-status`; its description mentioned an
  observed `Dockerfile`; DevOps's detector gives `dockerfile` higher priority
  than `git status`; the resulting approval preview targeted
  `create_dockerfile`. The approval gate held, the file hash stayed unchanged,
  and the action was rejected.
- Planning's LangGraph prompt and validator use a hand-maintained
  `KNOWN_SKILL_IDS` array. `validatePlanOutput()` also contains a second fixed
  skill-to-agent mapping for rendering `Agents needed`.
- Planning's MCP boundary is separate: `READ_ONLY_TOOL_NAMES` intentionally
  contains only `git_status` and `analyze_project`. Agent Cards describe agent
  skills, not MCP privileges; that fixed tool allow-list is a structural
  security boundary and must remain fixed in this checkpoint.
- The shared A2A client also sends text-only envelopes. Its caller may know the
  intended target skill, but the receiving agent currently re-detects from
  prose.
- There is no authenticated internal-agent transport. `message.role: "agent"`
  is descriptive metadata, not proof of caller identity. Skill selection is
  therefore never treated as authorization; approval remains independent.

## Proposed Behavior

### 1. Extend the shared envelope with bounded routing context

Add optional, backward-compatible fields to the validated agent envelope:

```ts
interface ValidatedTask {
  id: string
  message: ValidatedTaskMessage
  text: string
  selectedSkill?: string
  capabilities?: CapabilityEntry[]
}

interface CapabilityEntry {
  agentName: string
  skillId: string
}
```

`selectedSkill` and `capabilities` are protocol data, never parsed from
message prose. Validation must enforce conservative identifier patterns,
per-field lengths, maximum entry counts, unique `(agentName, skillId)` pairs,
and a maximum total serialized byte size. Invalid routing context returns a
controlled HTTP 400 before task storage or background work begins.

The exact bounds are implementation constants covered by tests and documented
in code; they may be chosen during implementation only within these ceilings:
maximum 32 agents, 32 skills per agent, 256 total capability entries, 128
bytes per identifier, and 32 KiB total capability JSON. Smaller bounds are
allowed; larger bounds require re-review.

### 2. Agent Cards are the high-level capability source of truth

Create a shared capability normalizer that consumes validated Agent Card
data and emits only `{ agentName, skillId }` entries. It must:

- include only currently online operational agents available to the caller;
- exclude Planning's own `plan-task`/`suggest-agents` skills to prevent
  recursive plans;
- exclude card descriptions, examples, URLs, and arbitrary prose from the LLM
  prompt surface;
- reject malformed IDs and ambiguous duplicate skill IDs owned by more than
  one agent, rather than choosing the first discovered agent;
- sort deterministically so prompt content and tests do not depend on
  discovery order;
- return an explicit empty/error state when no usable operational capability
  exists, never a hardcoded fallback catalog.

For normal Orchestrator-routed plan tasks, the Orchestrator builds this snapshot
from its already-discovered live registry and includes it in the Planning task
envelope. For a direct Planning request with no supplied snapshot, Planning may
perform bounded read-only discovery through the same shared normalizer —
**restricted to exactly the five agent URLs already defined in
`packages/shared/agent-registry.ts`, the same fixed set the shared A2A client
already resolves against.** This introduces no new configurable endpoint, env
var, or URL surface: Planning gains no ability to fetch an operator-supplied
or task-supplied URL. This is a deliberate tightening found during spec
review — Planning has never made an outbound HTTP call to a peer agent before
this checkpoint, so the discovery boundary must be exactly as fixed as the
registry it reuses, not a new configurable capability. If discovery is
unavailable or ambiguous, the LLM path fails closed to zero steps with a
clear warning; it does not restore `KNOWN_SKILL_IDS` as a fallback.

### 3. Planning uses the supplied/discovered catalog dynamically

Remove the fixed high-level `KNOWN_SKILL_IDS` array and fixed skill-to-agent
rendering table from the Planning harness. Each invocation receives a
capability catalog and uses it for:

- the system prompt's allowed high-level skill IDs;
- final plan validation;
- dynamic `Agents needed` rendering via `skillId -> agentName`;
- rejection of an unavailable, ambiguous, or invented skill.

The catalog is invocation-scoped. A model cannot add a skill by mentioning it
in output. An empty catalog produces `NO_PLAN`/zero steps without invoking the
model where practical.

This change does **not** derive MCP tool access from Agent Cards.
`READ_ONLY_TOOL_NAMES` remains exactly the separately reviewed fixed allow-list
of `git_status` and `analyze_project`; no write-capable MCP tool becomes bound.

### 4. The Orchestrator dispatches an authoritative `selectedSkill`

Change `sendTaskToAgent()` to accept and transmit the skill already selected
and validated by the Orchestrator. Apply this to both root routed tasks and
parsed plan children. A plan child's value is exactly `step.skill`; descriptive
text remains context only.

Immediately before dispatch, the Orchestrator revalidates `selectedSkill`
against the current live registry, not only the earlier capability snapshot.
If the agent went offline, removed the skill, or ownership became ambiguous,
the step fails closed and is not sent. This handles snapshot staleness without
silently rerouting.

### 5. Receiving agents honor explicit selection and preserve legacy requests

Each agent computes its execution skill as follows:

1. If `selectedSkill` is present, validate it against that agent's own current
   Agent Card skill IDs and execute exactly it.
2. If it is absent, retain the existing `detectSkill(text)` behavior for direct
   dashboards, legacy clients, and old A2A callers.
3. If it is present but malformed, unknown, or owned by another agent, reject
   before storing/processing the task. Never fall back to text detection for an
   invalid explicit selection.

Agents derive their ownership set from the same Agent Card object they expose;
no new per-agent skill allow-list is introduced.

### 6. A2A callers may preserve an already-selected target skill

Add an optional `selectedSkill` to the shared A2A call options. When a caller
deliberately requests a named capability—such as DevOps asking Security for
`scan-secrets`—it sends that ID explicitly. Legacy A2A calls without the field
remain compatible and use target-agent text detection.

The receiving agent still validates ownership. The field is not proof of
identity and never bypasses approval. A2A calls remain logged and timeout-
bounded under the existing policy.

### 7. Selection is routing, never authorization

`selectedSkill` chooses code; it does not classify safety or grant approval.
Existing per-agent approval policy remains authoritative:

- explicit `git-status` executes the read-only path without approval, even if
  its description mentions `Dockerfile`, `compose`, or another write keyword;
- explicit `dockerize` always reaches the existing `actionId`-bound
  `input-required` path, even if its description says `git status`;
- no model, capability snapshot, Agent Card, user text, or A2A caller can mark
  a write skill read-only or provide/pre-approve an `actionId`.

### 8. Audit the selected skill and selection mode

Task/audit evidence must distinguish `selectionMode: "explicit"` from
`selectionMode: "detected"` and record the bounded selected skill ID. It must
not log the capability catalog wholesale or repeat Agent Card prose. Existing
result and secret-redaction bounds remain unchanged.

## Scope

- `packages/shared/task-envelope.ts` and tests — optional `selectedSkill` and
  bounded capability snapshot parsing.
- A shared Agent Card capability normalizer/discovery helper and focused tests.
- `apps/orchestrator/index.ts` and tests — build capability snapshots, include
  them for Planning, send/revalidate authoritative skills for root tasks and
  plan children.
- `packages/agents/planning/llm-harness.ts`, Planning configuration/wiring, and
  tests — dynamic Agent Card-derived skill catalog; remove fixed high-level
  skill and agent mappings.
- All five agent entrypoints and focused tests — honor validated explicit
  selection; retain detection only when the field is absent.
- `packages/shared/a2a-client.ts` and tests — optional explicit target skill;
  update existing named A2A calls where the target capability is already known.
- `CLAUDE.md`, `README.md`, `context/worklog.md`, 026/029 verification records,
  and this checkpoint's `verification.md` after implementation/verification.

## Safety and Compatibility Constraints

- **Approval is unchanged and independent.** Explicit routing cannot approve,
  downgrade, or execute a write action.
- **Invalid explicit selection fails closed.** Never recover by re-detecting
  from text when `selectedSkill` was supplied but rejected.
- **Agent Cards provide skills, not MCP privileges.** Do not generate Planning
  MCP bindings, execution commands, approval tiers, or tool names from cards.
- **No Agent Card prose in the model catalog.** Only bounded normalized agent
  and skill identifiers enter the prompt; descriptions/examples remain outside
  this checkpoint's prompt surface.
- **Duplicate skill ownership is an error.** Never depend on discovery order.
- **Snapshot staleness is revalidated.** Dispatch uses the current live registry
  and fails rather than rerouting to another agent or skill.
- **Backward compatibility is deliberate.** Envelopes without new fields keep
  existing text detection. Existing public `{ text }` Orchestrator submissions
  do not gain a caller-controlled skill override.
- **No false trust claim.** Without authenticated A2A transport, role or routing
  fields are not caller authentication. The safety boundary remains validation,
  agent ownership, tool restrictions, and human approval.
- **Planning's discovery egress is fixed, not configurable.** Direct-request
  discovery may only target the five URLs already in
  `packages/shared/agent-registry.ts`. No new env var, task field, or config
  file may widen this set — found during spec review as the one place this
  checkpoint would otherwise introduce new outbound capability without a
  bound.
- **No network calls in automated tests.** Agent Card discovery and task
  transport use injected fakes. Live verification uses only the external test
  fixture and sanitized bounded evidence.
- **No new dependency is required.** If implementation discovers one is
  necessary, stop and return the spec for review.

## Out of Scope / Non-Goals

- Implementing 027 or 028, changing AG-UI protocol types, or introducing the
  Orchestrator LangGraph supervisor.
- Exposing all MCP tools to Planning or generating MCP permissions from Agent
  Cards.
- Changing Planning's two fixed read-only MCP bindings.
- Moving approval policy into Agent Cards or trusting a card's claim that a
  skill is read-only.
- Cryptographic A2A authentication, service identity, signed envelopes, mTLS,
  or a general zero-trust service mesh.
- Removing legacy text detection from direct agent requests.
- Adding new agent skills, renaming existing skills, changing their behavior,
  or changing routing keywords.
- Solving model latency, model-output determinism, token streaming, or prompt
  quality beyond replacing the fixed skill catalog.
- Approving or executing a write during live verification.

## Acceptance Criteria

- [ ] Yusuf explicitly approves this spec before runtime implementation.
- [ ] The shared envelope accepts bounded valid `selectedSkill`/capabilities,
      rejects malformed, oversized, duplicate, and ambiguous data before task
      storage, and remains compatible with legacy envelopes.
- [ ] Planning's high-level `KNOWN_SKILL_IDS` and fixed skill-to-agent mapping
      are removed; its prompt, validator, and agent rendering use only the
      invocation's normalized Agent Card-derived catalog.
- [ ] Planning never falls back to a hardcoded high-level catalog when cards
      are unavailable, empty, or ambiguous.
- [ ] Planning's fixed MCP tool allow-list remains exactly `git_status` and
      `analyze_project`; no Agent Card can expand it.
- [ ] The Orchestrator includes its validated selection on root dispatches and
      plan children, and revalidates ownership against the live registry just
      before sending.
- [ ] Every agent executes a valid explicit skill exactly and derives ownership
      from its exposed Agent Card; invalid/foreign explicit skills fail without
      text fallback or task-store mutation.
- [ ] Legacy direct envelopes with no explicit selection preserve current
      detector behavior and existing tests.
- [ ] The shared A2A client can send a known target skill; the receiver validates
      it, while legacy A2A calls remain supported.
- [ ] Exact regression: explicit `git-status` plus text mentioning `Dockerfile`,
      Compose, and other write keywords executes `git_status`, makes no
      `create_dockerfile` call, and never reaches `input-required`.
- [ ] Inverse safety regression: explicit `dockerize` plus text mentioning only
      read-only operations still reaches `input-required`; the target remains
      unchanged before rejection.
- [ ] Capability tests prove Planning excludes its own skills, excludes offline
      agents, sorts deterministically, rejects duplicate ownership, accepts a
      newly advertised valid operational skill without changing Planning code,
      and rejects a removed/stale skill at dispatch.
- [ ] Audits identify explicit versus detected selection without logging the
      full capability snapshot or secrets.
- [ ] `bun test`, `bun run typecheck`, `bun run specs:check`, and `bun run build`
      pass; the compiled default path and legacy direct-agent path are smoke-
      tested.
- [ ] Live Gemini verification repeats all three 026/029 scenarios with raw
      sanitized events: Planning-owned read tools influence the plan; an out-
      of-scope request dispatches zero steps; a deliberate write child stops at
      approval, remains unchanged, and is rejected.
- [ ] In the repeated read-only scenario, every downstream child executes the
      exact skill named in the plan; no description keyword changes it.
- [ ] If all criteria pass, 026 and 029 move to `verification: verified`, and
      028 records 030 as an implementation precondition.
- [ ] Documentation and the worklog describe only implemented and verified
      behavior.

## Verification Plan

- **Protocol unit tests:** valid/legacy envelopes; identifier and byte bounds;
  malformed catalog; duplicate ownership; no task-store mutation on rejection.
- **Capability unit tests:** normalize injected Agent Cards, exclude Planning
  and offline agents, deterministic order, empty/ambiguous fail-closed behavior,
  newly added/removed skill behavior.
- **Agent tests:** table-driven coverage for each agent proving explicit skill
  precedence, ownership rejection, legacy detection, and unchanged approval.
- **Orchestrator tests:** root and child dispatch envelopes preserve exact
  selected skills; stale capability revalidation blocks sending; descriptions
  cannot affect the transmitted selection.
- **Planning graph tests:** inject different catalogs into the same mocked graph;
  validate only advertised skills; render owning agents dynamically; assert the
  fixed MCP binding list separately.
- **A2A tests:** explicit target skill is transmitted and audited; invalid target
  rejection is bounded; absent field preserves current behavior.
- **Regression/live:** rerun the exact `git-status` description containing
  `Dockerfile` from the 2026-08-16 evidence and prove read-only execution. Then
  run zero-step and controlled write/reject scenarios with file fingerprinting
  and bounded sanitized SSE capture.
- **Repository gates:** full tests, typecheck, governance, build, compiled smoke,
  and `git diff --check`.

## Approval Requested

Approval authorizes the backward-compatible task-envelope extension, shared
Agent Card capability normalization, dynamic Planning skill catalog,
authoritative Orchestrator skill propagation/revalidation, all-agent explicit
skill handling, optional A2A target skill, focused regression tests, live
read-only/rejection verification, and documentation listed in Scope.

Approval does not authorize implementing 027/028, exposing MCP tools through
Agent Cards, changing approval policy, authenticating services, changing skill
behavior/keywords, adding dependencies, approving a write, or making any other
LLM/AG-UI architecture change.
