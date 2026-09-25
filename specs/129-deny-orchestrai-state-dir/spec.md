---
id: 129-deny-orchestrai-state-dir
title: Agents Can Never Read, Write, or List OrchestrAI's Own .orchestrai State Directory
area: mcp-file-tools
change_type: fix
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 011-remaining-agents-mcp
  - 123-safe-env-template-filename-exemption
supersedes: []
superseded_by: []
related:
  - 031-interactive-init-wizard
  - 043-llm-harness-security
  - 080-run-command-approved-execution
---

# Spec: Agents Can Never Read, Write, or List OrchestrAI's Own .orchestrai State Directory

> Status history: **APPROVED by Muhamad-Yussuf on 2026-09-25** (the demo
> plan's WS1, then "go ahead"). IMPLEMENTED and VERIFIED live the same day.

## Purpose

A secret leak, confirmed live. Guided init writes the target project's
`<target>/.orchestrai/config.env`, which holds `ORCHESTRAI_LLM_API_KEY` in
plaintext (a deliberate demo-scale decision, CLAUDE.md "Guided init"). The
same directory also holds `supervisor.log` and `orchestrai.db`.

`read_project_file` blocks only sensitive **basenames** (`^\.env`, `.pem`,
`.key`, …). `config.env` matches none of them, so the whole directory is
readable. `C:\Users\moham\test-target-project\.orchestrai\supervisor.log`
lines 11–12 (2026-09-24) show the Coder agent's edit-files harness calling
`read_project_file` on `.orchestrai/supervisor.log` and
`.orchestrai/config.env` (407 bytes), which sent the key to the LLM
provider as model context.

## Verified Current State

- `containPath()` (`packages/mcp/index.ts`) is the one check behind both
  `read_project_file` and `write_project_file`. It covers containment
  (syntactic and realpath) and basename sensitivity, and nothing checks
  directory segments.
- `read_project_file` on a directory returns a listing, so a listing of
  `.` shows `d .orchestrai`, and a listing of `.orchestrai` shows every
  file in it.
- `analyze_project` lists top-level entries, including `.orchestrai/`.
- The Security agent walks the target directly with `fs`
  (`packages/agents/security/index.ts`, `EXCLUDED_DIRS`), and
  `.orchestrai` is not excluded.
- `run_command` can run `cat .orchestrai/config.env` after human approval.
  Its denylist has no rule for it.
- No other agent reads the target directly; all go through the MCP tools.

## Proposed Behavior

1. `containPath()` rejects any path with a segment equal to `.orchestrai`
   (case-insensitive), checking both the resolved path and the realpath.
   That covers `a/../.orchestrai/x`, `.ORCHESTRAI\config.env`, the
   directory itself, and an in-root symlink pointing into it.
   - Error: `OrchestrAI's own state directory is denied: .orchestrai`.
   - Applies to read, write and list.
2. Directory listings (`read_project_file` on a directory, and
   `analyze_project`'s top-level file list) omit `.orchestrai`, so the
   model is never shown the directory.
3. The Security agent adds `.orchestrai` to `EXCLUDED_DIRS`.
4. The `run_command` denylist gains a rule blocking any argv that
   references a `.orchestrai` path segment. This is defense-in-depth
   behind the human approval, the same role every existing denylist rule
   has.

## Safety and Compatibility Constraints

- Denying is strictly narrowing: no previously denied path becomes
  allowed. The existing checks are unchanged, including the specs/123
  template exemption.
- OrchestrAI itself still reads and writes `.orchestrai` through its own
  code (the supervisor, init and store). Only the agent-facing MCP tools
  and the Security walker are restricted.

## Non-Goals

- Moving the key out of the plaintext file (a separate decision).
- Rotating the leaked key. The user must do that; it has already been
  sent to the provider.

## Acceptance Criteria

- [x] Explicit approval recorded before implementation.
- [x] `read_project_file` denies `.orchestrai/config.env`, `.orchestrai`,
  `.ORCHESTRAI/config.env`, `sub/../.orchestrai/config.env`, and an in-root
  symlink pointing into `.orchestrai`.
- [x] `write_project_file` denies a target inside `.orchestrai`.
- [x] Listing `.` via `read_project_file`, and `analyze_project`'s file
  list, omit `.orchestrai`.
- [x] Security's secret scan never reports a file under `.orchestrai`.
- [x] `run_command` with `["cat", ".orchestrai/config.env"]` is blocked.
- [x] All existing containment tests pass unchanged; `bun run typecheck`
  0 errors; `bun test` no regressions.
- [x] Live: a request to read `.orchestrai/config.env` comes back
  `Denied`.
