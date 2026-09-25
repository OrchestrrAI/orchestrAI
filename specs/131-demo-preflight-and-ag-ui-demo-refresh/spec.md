---
id: 131-demo-preflight-and-ag-ui-demo-refresh
title: Demo Preflight Check and a Working AG-UI Demo Script
area: quality-gates
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 021-ag-ui-event-protocol
supersedes: []
superseded_by: []
related:
  - 094-analyze-project-security-precheck-opt-in
  - 065-llm-only-skill-routing
  - 129-deny-orchestrai-state-dir
---

# Spec: Demo Preflight Check and a Working AG-UI Demo Script

> Status: **APPROVED by Muhamad-Yussuf on 2026-09-25** ("ok approved go on"). Hackathon demo
> hardening.

## Purpose

Two demo aids, neither of which changes product runtime behavior:

1. `bun run demo:ag-ui` (`scripts/ag-ui-demo.ts`) is the scripted
   end-to-end rehearsal. Two of its six scenarios fail against the
   current system:
   - Scenario 2 requires a DevOps→Security A2A event, but the secrets
     pre-check has been opt-in since specs/094.
   - Scenario 5 ("semantic fallback") requires deterministic routing of a
     phrasing to `scan-secrets`. That tier was deleted in specs/065, and
     routing is now an LLM judgment.
2. There is no one-command preflight. The live-demo failures seen so
   far — wrong folder (config not loaded), stale processes holding ports,
   an expired or rate-limited key, a terminal too small for the TUI — are
   each quick to detect but easy to miss under pressure.

## Proposed Behavior

### A. `scripts/ag-ui-demo.ts`
- Scenario 2 checks whether the pre-check is enabled. When
  `ORCHESTRAI_DEVOPS_ANALYZE_SECRETS_PRECHECK=1`, it requires the Security
  A2A event, as today. When it isn't set, it requires the analysis to
  complete with no A2A event, and prints that the pre-check is opt-in.
- Scenario 5 becomes "LLM routing: read-only": the same prompt must
  complete as a read-only skill with MCP tool events and no approval. The
  exact skill is printed, not asserted.
- Stale comments, and the preflight's "four agents" wording, are updated.
  `scripts/ag-ui-demo.test.ts` is updated to match.

### B. New `scripts/demo-preflight.ts` (`bun run demo:preflight`)
A read-only report with one line per check (PASS / WARN / FAIL) and a
non-zero exit on any FAIL. It never kills a process, never changes a
file, and never prints a key.
- **Config:** `<cwd>/.orchestrai/config.env` exists and has a provider,
  a model and a non-empty key. Reported as "present", never the value.
- **Key live:** one minimal provider call through the existing
  `buildChatModel()`. A 429 or quota error is reported as a WARN with the
  provider's message; an auth failure is a FAIL.
- **Ports:** each resolved service port (the same
  `packages/shared/service-ports.ts` resolution the supervisor uses) is
  free, or else a stack is already up and healthy on it; stray `bun` or
  `orchestrai` processes are listed.
- **Terminal:** at least 110×30 is a PASS; 80×24 to 110×30 is a WARN
  (rails hidden); smaller is a FAIL.
- **Fixture:** optional `--baseline <ref>`. The fixture is a git repo at
  that ref (WARN otherwise).
- **Opt-ins:** the pre-check flag and OSV external data, shown as
  on/off.
- **With `--live`, when a stack is running:** every `/healthz` is OK, the
  Orchestrator reports `capabilities.ok`, `/events` delivers a
  `STATE_SNAPSHOT`, and `read_project_file .orchestrai/config.env` is
  denied (the specs/129 guard).
- `package.json` gains `"demo:preflight"`.

## Safety and Compatibility Constraints

- Neither script is part of the runtime; nothing under `apps/` or
  `packages/` changes.
- The preflight only reads, and redacts every secret it sees.

## Acceptance Criteria

- [x] Explicit approval recorded before implementation.
- [x] `bun run demo:ag-ui` passes against a live stack with the pre-check
  flag both off and on.
- [x] `bun run demo:preflight` passes on a correctly set-up fixture, and
  reports FAIL or WARN for each induced problem: wrong folder, busy port,
  small terminal, missing key.
- [x] Unit tests for the preflight's pure check functions;
  `scripts/ag-ui-demo.test.ts` updated; `bun run typecheck` 0 errors;
  `bun test` no regressions.
- [x] No key value appears in any preflight output (asserted by a test).
