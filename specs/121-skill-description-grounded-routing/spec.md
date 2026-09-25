---
id: 121-skill-description-grounded-routing
title: Skill-Description-Grounded Routing (Router and Adaptive Supervisor)
area: routing-planning
change_type: fix
status: implemented
verification: verified
created: 2026-09-24
updated: 2026-09-24
approved_by: Yusuf
approved_on: 2026-09-24
implemented_on: 2026-09-24
amends:
  - 030-authoritative-skill-dispatch-and-capability-catalog
  - 028-orchestrator-langgraph-supervisor
supersedes: []
superseded_by: []
related:
  - 054-capability-driven-llm-routing
  - 065-llm-only-skill-routing
  - 083-coder-agent
  - 114-coder-multi-file-edit-and-create
  - 120-supervisor-parallel-write-dispatch
---

# Spec: Skill-Description-Grounded Routing (Router and Adaptive Supervisor)

> Status history: **APPROVED by Yusuf on 2026-09-24, IMPLEMENTED and
> VERIFIED the same day** — see this spec's own `verification.md` for full
> evidence, including two live routing checks against a real provider key.

## Purpose

Live-reproduced via the TUI: asking to create a new `.env.example` file
routed to the Coder agent's `edit-file` skill, which structurally cannot
create a file — it requires the target to already exist
(`packages/agents/coder/index.ts:526`, "edit-file requires an existing file
to edit") — and the task failed. The only skill that can create a new file
is `edit-files` (plural). Both routing tiers that could have made this
distinction were given nothing to distinguish the two skills with: both
prompts show the model a bare list of skill *ids* and nothing else, so
`edit-file` vs `edit-files` has to be guessed from the id strings alone.
This spec grounds both routing tiers in each skill's own, already-written,
code-authored Agent Card description so a same-family pair like this one
(or any future one) is actually distinguishable.

## Verified Current State

Two independent routing tiers each decide a skill id from a prose-free
prompt today:

1. **The capability router** (`packages/shared/capability-router.ts`,
   `runCapabilityRouter()`, specs/054/065) — used by `detectSkill()` for
   direct dispatch and by `/ask`'s classification. Its system prompt
   (`buildSystemPrompt()`) is built from `capabilities: CapabilityEntry[]`
   and states only `Currently online skills: <id>, <id>, ...`
   (`capability-router.ts:104-113`). `CapabilityEntry`
   (`packages/shared/task-envelope.ts:36-39`) is explicitly documented as
   "reduced to bare identifiers only — never card prose (description,
   examples, URL)", and `normalizeAgentCapabilities()`
   (`packages/shared/agent-capabilities.ts`) only ever receives
   `AgentCapabilitySource.skillIds: string[]` — the description is dropped
   before it ever reaches this module. This is a deliberate decision from
   specs/030 §2 ("exclude card descriptions, examples, URLs, and arbitrary
   prose from the LLM prompt surface"), made to fix a different, unrelated
   defect: an agent re-interpreting a step's free-text *description* to
   escalate what it executed (a receiving-agent-authority problem, closed
   by `selectedSkill` becoming authoritative — untouched by this spec).
   Not naming a skill at all was never the failure mode specs/030 was
   guarding against.
2. **The adaptive supervisor** (`apps/orchestrator/supervisor-graph.ts`,
   specs/028) — its `dispatch_skill` tool schema constrains `skill` to
   `z.enum(SUPERVISOR_ALLOWED_SKILLS)` (`supervisor-graph.ts:323`), and
   `buildSystemPrompt()`'s own `Valid skills: ${SUPERVISOR_ALLOWED_SKILLS
   .join(", ")}.` (`supervisor-graph.ts:387`) is the only place skills are
   named to the model — again bare ids, no descriptions.
   `SUPERVISOR_ALLOWED_SKILLS` (`supervisor-graph.ts:95-120`) is a fixed,
   hand-maintained array, independent from `SKILL_TIER_REGISTRY`
   (`supervisor-graph.ts:31-89`) by the same file's own stated convention
   ("keeping them as two independent structures is what makes drift a
   real, catchable failure mode instead of a tautology").

Both `edit-file` and `edit-files` already carry Agent Card descriptions
that state the distinction plainly (`packages/agents/coder/index.ts:69,82`)
— "an existing file" vs "...including creating new files" — but neither
routing tier is ever shown either string today.

Confirmed live: `bun run <the reworded request>` was not re-run as part of
drafting this spec (see Verification Plan) — the finding above is from
reading the routing code paths directly, matching the actually-observed
TUI failure.

## Proposed Behavior

Both tiers gain a short, bounded, code-authored description alongside each
skill id — sourced only from each agent's own static Agent Card
`description` field (identical trust level to `SUPERVISOR_ALLOWED_SKILLS`
itself: authored in code, not runtime/agent-controlled text), never from
free-form request text or a step's own planning-time description.

1. **Capability router.** `CapabilityEntry` gains an optional
   `description?: string`, still validated in `normalizeAgentCapabilities()`
   the same way every other field already is. `AgentCapabilitySource`'s
   `skillIds: string[]` becomes `skills: { id: string; description?: string
   }[]` (a mechanical shape change; every existing caller —
   `apps/orchestrator/index.ts`'s `computeCapabilitySnapshot()` — already
   has the full `agent.card.skills` array in hand and only has to stop
   discarding `description`). A description longer than
   `MAX_SKILL_DESCRIPTION_BYTES` (chosen during implementation, ceiling 300
   UTF-8 bytes) is truncated with a trailing `…`, never rejected — a
   too-long description is never a reason to fail the whole snapshot
   closed. `buildSystemPrompt()` renders each entry as `<skillId>:
   <description>` (or bare `<skillId>` when no description is present —
   e.g. the synthetic `orchestrator`/`suggest-agents` entry, which may keep
   none), one per line, sorted the same deterministic way ids are sorted
   today.
2. **Adaptive supervisor.** A new `SKILL_DESCRIPTIONS: Record<string,
   string>` constant in `supervisor-graph.ts`, one entry per
   `SUPERVISOR_ALLOWED_SKILLS` id, each value copied verbatim from that
   skill's real Agent Card description (not re-worded) — with a drift test
   mirroring the existing `SKILL_TIER_REGISTRY`-vs-`SUPERVISOR_ALLOWED_SKILLS`
   key-set check, so an added/removed skill that forgets its description
   entry is a real, caught failure. `buildSystemPrompt()`'s `Valid skills:
   ...` line is replaced with one `<skillId>: <description>` line per
   allowed skill.

Neither change affects what a *receiving* agent executes: `selectedSkill`
stays authoritative exactly as specs/030 established, and a receiving
agent's own skill dispatch (`handleEditFileSkill` etc.) is untouched —
descriptions only ever influence which skill id gets *proposed/dispatched*
in the first place, never what the receiving agent does once dispatched.

## Scope

- `packages/shared/task-envelope.ts` — `CapabilityEntry` shape and its
  validation bounds.
- `packages/shared/agent-capabilities.ts` — `AgentCapabilitySource` shape,
  `normalizeAgentCapabilities()`.
- `packages/shared/capability-router.ts` — `buildSystemPrompt()` rendering.
- `apps/orchestrator/index.ts` — `computeCapabilitySnapshot()`'s mapping
  from the live registry.
- `apps/orchestrator/supervisor-graph.ts` — `SKILL_DESCRIPTIONS` constant,
  `buildSystemPrompt()`'s `Valid skills:` line, and a drift test.
- Existing tests referencing `AgentCapabilitySource`/`CapabilityEntry`
  shapes across `packages/shared/*.test.ts` and
  `apps/orchestrator/*.test.ts`.

## Safety and Compatibility Constraints

- Descriptions entering either prompt are exclusively static, code-authored
  Agent Card text — never a plan step's own free-text `description`, never
  raw request text, never anything an agent could influence at runtime.
  This is the same boundary specs/030 already drew between "capability
  catalog" (trusted, code-authored) and "message prose" (untrusted); this
  spec only widens what the trusted side carries, it does not cross the
  boundary.
- `selectedSkill` remains the sole authority for what a receiving agent
  executes (specs/030) — completely unchanged by this spec.
- Per-description and total snapshot byte bounds stay enforced
  (`MAX_SKILL_DESCRIPTION_BYTES`, existing `MAX_CAPABILITY_JSON_BYTES`);
  a description is truncated, never a reason to fail the capability
  snapshot closed.
- `SKILL_TIER_REGISTRY`'s own conservative-default classification
  (unregistered = write-capable) is untouched; this spec does not change
  which skills require approval.
- Byte-identical prompt output is not preserved (an explicit, intended
  content change) — but the shape of `computeCapabilitySnapshot()`'s return
  value (`CapabilityEntry[] | null`, sorted, same failure modes) is
  otherwise unchanged.

## Out of Scope / Non-Goals

- Renaming `edit-file`/`edit-files` or any other skill id.
- Changing which skills are approval-gated or their tier classification.
- Adding Agent Card `examples` (only `description`) to either prompt —
  examples are longer and less structurally guaranteed to stay current;
  can be proposed separately if descriptions alone prove insufficient.
- Reconciling the three-different-ways-skill-id-collisions-are-handled gap
  already named in CLAUDE.md's "Tool sharing and skill ownership" section —
  unrelated to this spec.
- Making `SUPERVISOR_ALLOWED_SKILLS` live-discovered instead of a fixed
  array — a separate, larger change; this spec only adds descriptions to
  the existing fixed list.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] `CapabilityEntry` carries an optional, bounded `description`;
      `normalizeAgentCapabilities()` truncates an over-long description
      rather than failing the snapshot.
- [x] The capability router's system prompt includes each online skill's
      description alongside its id (unit-testable: assert the rendered
      prompt string contains both `edit-file`'s and `edit-files`'
      real descriptions when both are in the snapshot).
- [x] The supervisor's `SKILL_DESCRIPTIONS` map has exactly the same key
      set as `SUPERVISOR_ALLOWED_SKILLS`, enforced by a drift test; its
      system prompt's `Valid skills:` line includes each description.
- [x] `bun test` and `bun run typecheck` pass.
- [x] A live manual check (see Verification Plan) shows the reworded
      "create a new file that doesn't exist yet" request routing to
      `edit-files`, not `edit-file` — acknowledging the router is a real
      model judgment (per CLAUDE.md) and this is evidence, not a
      deterministic guarantee. **Performed and passed, twice — see
      verification.md.**
- [x] `context/worklog.md` gets a dated entry.

## Verification Plan

- Unit: `capability-router.test.ts` — prompt-content assertions for the
  new description rendering, including truncation at the byte bound and
  the no-description fallback (synthetic `orchestrator` entry).
- Unit: `agent-capabilities.test.ts` — `normalizeAgentCapabilities()`
  passes through and bounds-checks `description`.
- Unit: `supervisor-graph.test.ts` — the new drift test, plus a
  `buildSystemPrompt()` content assertion.
- Live: with a real provider key, dispatch the exact request that
  live-failed ("create a new .env.example file in the project root...")
  through the TUI or dashboard chat both before recording a baseline (if
  not already captured) and after implementation; record which skill was
  actually proposed in `verification.md`. Because the router's output can
  vary run to run, this is recorded as observed evidence, not a pass/fail
  gate on its own — the deterministic acceptance criteria above are the
  real gate.

## Approval Requested

Approval authorizes: adding an optional, bounded `description` field to the
capability-router's `CapabilityEntry`/`AgentCapabilitySource` pipeline and
rendering it in that router's prompt; adding a static `SKILL_DESCRIPTIONS`
map and drift test to the adaptive supervisor, and rendering it in its
prompt. It does not authorize renaming any skill, changing any approval
tier, or adding Agent Card `examples` to either prompt — those remain
separate, unapproved follow-ups if still needed after this lands.
