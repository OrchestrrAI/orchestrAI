# Plan: Authoritative Skill Dispatch and Agent-Card Capability Catalog

> Draft implementation plan. Do not execute until
> `specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md` is
> explicitly approved.

## Phase 1 — Shared protocol and capability normalization

1. Add bounded optional `selectedSkill` and capability entries to the shared
   task-envelope parser and types.
2. Add shared pure Agent Card/capability types and a normalizer that emits only
   deterministic `{ agentName, skillId }` entries.
3. Add injected-fetch discovery support for direct Planning fallback, hardcoded
   to the five URLs in `packages/shared/agent-registry.ts` only — no new env
   var or config surface — without real network calls in tests.
4. Test all size/identifier bounds, Planning/offline exclusion, duplicate
   ownership, deterministic sorting, empty catalog, and legacy envelopes.

Exit gate: focused shared tests and typecheck pass; no caller uses the new
fields yet.

## Phase 2 — Orchestrator capability snapshot and authoritative dispatch

1. Reuse the shared Agent Card validation/normalization in discovery.
2. Build a capability snapshot from the current online operational registry for
   every Orchestrator-routed `plan-task` request.
3. Extend `sendTaskToAgent()` to transmit `selectedSkill` and optional
   capabilities.
4. Send the Orchestrator-selected skill for root tasks and `step.skill` for plan
   children.
5. Revalidate ownership immediately before dispatch; fail stale/ambiguous
   selections without sending or rerouting.
6. Add envelope-capture tests for root, plan-child, stale, and malicious-
   description cases.

Exit gate: the Orchestrator's stored skill and outgoing `selectedSkill` are
identical in every tested path.

## Phase 3 — Agent execution and A2A propagation

1. In each agent, derive the local ownership set from its exposed Agent Card.
2. Use a valid explicit selection exactly; use the detector only when the field
   is absent; reject invalid/foreign selection before task storage.
3. Keep every existing approval set and execution mapping unchanged.
4. Add optional `selectedSkill` to `callAgent()` and update existing calls where
   the target skill is already known.
5. Add table-driven all-agent tests plus the exact `git-status`/`Dockerfile`
   regression and inverse `dockerize` safety regression.

Exit gate: prose cannot override an explicit selection, and write approval
behavior is unchanged.

## Phase 4 — Dynamic Planning catalog

1. Pass the Orchestrator snapshot into Planning's harness invocation.
2. For direct Planning requests without a snapshot, use bounded shared Agent
   Card discovery; fail closed if it cannot produce an unambiguous catalog.
3. Remove `KNOWN_SKILL_IDS` and the fixed skill-to-agent mapping.
4. Build prompt IDs, output validation, and `Agents needed` from the invocation
   catalog.
5. Keep `READ_ONLY_TOOL_NAMES` unchanged and independently asserted.
6. Update mocked graph tests to inject catalogs and prove add/remove/stale
   behavior without provider or network calls.

Exit gate: changing injected Agent Cards changes available plan skills without
editing Planning code, while MCP access remains fixed.

## Phase 5 — Full and live verification

1. Run focused suites, full `bun test`, typecheck, spec governance, diff check,
   and standalone build/smoke.
2. With a replacement key configured only in Yusuf's terminal, repeat the
   Planning-owned read-tool scenario and capture sanitized raw events.
3. Assert every downstream child executes its named skill; specifically,
   `git-status` text containing `Dockerfile` stays read-only.
4. Repeat the out-of-scope zero-step case.
5. Fingerprint the external fixture, run the one-step write plan, observe
   `input-required`, verify unchanged, reject, and verify unchanged again.
6. Write `verification.md`, update docs/worklog, and only then move 026/029 to
   `verified` if every gate—including exact-skill execution—passes.
7. Update draft 028 to list implemented/verified 030 as a precondition before
   supervisor implementation.

Exit gate: no known mismatch remains between planned, dispatched, and executed
skill identity; 026/029 verification can close honestly.

## Stop conditions

Stop and return the spec for review if implementation would require any of:

- deriving MCP tool access or safety tier from Agent Cards;
- accepting Agent Card prose in the model prompt;
- weakening approval or treating routing metadata as authentication;
- removing legacy detector compatibility;
- adding a dependency or external service;
- implementing any part of 027 or 028;
- approving a write during verification.
