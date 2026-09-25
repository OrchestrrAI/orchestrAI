---
id: 004-configurable-project-paths
title: Configurable Target Project Paths
area: project-targeting
change_type: feature
status: implemented
verification: verified
created: 2026-08-08
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-08
implemented_on: 2026-08-08
amends: []
supersedes: []
superseded_by: []
related:
  - 018-supervisor-project-path
---

# Spec: Configurable Target Project Paths

> Status: **IMPLEMENTED AND VERIFIED on 2026-08-08 after Yusuf's approval.**

## Purpose

Remove the machine-specific fallback path from OrchestrAI's agents so the same
runtime can operate on different local projects and different developer
machines without editing source code.

This spec concerns the **target project path** that agents inspect or modify.
It is distinct from the **OrchestrAI installation path** used to locate
OrchestrAI's own source and configuration.

## Current Behavior

The DevOps, Testing, Documentation, and Security agents each contain a separate
`extractPath()` implementation with this fallback:

```text
C:\Users\moham\devops-mcp-server
```

The Orchestrator and agent dashboards also contain quick-action text with that
same path. As a result:

- tasks without an explicit path silently operate on Yusuf's repository path;
- the demo is not portable to another user or target project;
- path parsing and fallback behavior are duplicated across four agents;
- unquoted explicit paths containing spaces are not parsed correctly;
- Orchestrator `.env` loading also contains an absolute installation path,
  although that is a separate installation/configuration concern.

The MCP server is different: its tools already receive explicit structured
path parameters. MCP path schemas are not part of this fallback change.

## Proposed Resolution Order

Every affected agent must resolve its input/target path in this order:

```text
1. Explicit path in task text
2. ORCHESTRAI_PROJECT_PATH environment variable
3. Clear validation error — never guess a target directory
```

The first non-empty value wins.

Examples:

```powershell
# Explicit path wins over all defaults
analyze project at C:\work\sample-app

# Configure the default target for the current PowerShell session
$env:ORCHESTRAI_PROJECT_PATH = 'C:\work\sample-app'
bun run dev

# With neither source configured, return an actionable error
analyze my project
```

Expected error:

```text
No target project configured. Provide an absolute path in the task or set ORCHESTRAI_PROJECT_PATH.
```

`process.cwd()` is deliberately not a target fallback. With the current
development command it is normally the OrchestrAI repository, not necessarily
the user's intended project. A future `orchestrai` CLI may explicitly capture
the caller's original working directory and pass it as configuration, but that
behavior is outside this change.

## Path Parsing Rules

The shared resolver must support:

- Windows absolute paths such as `C:\work\sample-app`;
- Unix absolute paths such as `/home/user/sample-app`;
- double-quoted paths containing spaces;
- single-quoted paths containing spaces;
- the existing `at`, `in`, `to`, and `from` task phrases;
- trimming surrounding whitespace and quotes.

Both explicit task paths and `ORCHESTRAI_PROJECT_PATH` must be absolute. A
relative value returns a clear validation error instead of being resolved
against an uncertain working directory.

Unquoted paths containing spaces are not required because their boundary is
ambiguous in free-form task text. Documentation and dashboard examples must
show quotes when a path contains spaces.

Examples that must resolve correctly:

```text
analyze project at C:\work\sample-app
analyze project at "C:\work projects\sample-app"
run tests in '/home/user/work projects/sample-app'
```

The resolver returns a normalized absolute path. It does not create the path.
The owning skill remains responsible for checking whether it expects an
existing directory, an existing source file, or a future output file.

## Proposed Shared Helper

Add one deterministic resolver under `packages/shared` and import it from the
four affected agents instead of retaining duplicated fallback helpers.

Proposed behavior contract:

```ts
resolveTargetPath(
  taskText: string,
  options?: {
    env?: Record<string, string | undefined>
  }
): string
```

`env` is injectable only to make precedence easy to test. Production calls use
`process.env` by default.

The exact function/file name may change during implementation if repository
conventions require it, but the resolution behavior and one-source-of-truth
requirement must remain.

## Affected Runtime Components

Replace local target-path fallback logic in:

- `packages/agents/devops/index.ts`
- `packages/agents/testing/index.ts`
- `packages/agents/documentation/index.ts`
- `packages/agents/security/index.ts`

Planning Agent does not access the filesystem and does not need the resolver.
The Orchestrator passes original request context into child tasks, so an
explicit parent-task path must continue to reach every planned child step.

### Documentation Agent exception

`document-api` expects an explicit source-file path, while most other skills
expect a project directory. The shared resolver may parse that explicit file
path, but `document-api` must not silently treat a default project directory as
a source file. If no explicit API source file is supplied, it must return a
clear validation error or preserve its currently specified input requirement.

`extractSavePath()` is a separate output-path parser and must not use
`ORCHESTRAI_PROJECT_PATH` as an implicit output filename.

## Dashboard and Documentation Changes

Remove Yusuf's absolute path from runtime dashboard placeholders and
quick-action buttons.

Quick actions should demonstrate fallback behavior with text such as:

```text
analyze my project
git status
dockerize bun app on port 3000
run tests
scan for secrets
```

Update `README.md` with:

- the three-level resolution order;
- PowerShell and Unix environment-variable examples;
- quoted paths containing spaces;
- a warning showing which target path will be used before approving writes.

Update `CLAUDE.md` after implementation so hardcoded target paths are no longer
listed as a current limitation.

## Orchestrator Installation `.env`

The current Orchestrator manually reads:

```text
C:\Users\moham\devops-mcp-server\.env
```

Implementation must remove this machine-specific installation path. This is
not the target-project fallback: OrchestrAI configuration must never be
resolved relative to an arbitrary target project in a way that could load that
project's secrets unintentionally.

Approved behavior: rely only on environment variables inherited by every
service. Remove the Orchestrator's custom absolute `.env` loader. Do not add a
replacement file loader in this change. This ensures target-project selection
cannot cause OrchestrAI to read a target project's secrets as configuration.

## Safety and Approval Rules

- This change must not weaken existing human-approval requirements.
- Before a write is approved, task output/approval context must continue to
  identify the resolved destination or overwrite risk.
- An invalid or missing path must fail clearly; it must not silently switch to
  Yusuf's repository or another hardcoded directory.
- Path normalization is not a filesystem sandbox. This spec does not claim
  that arbitrary user-accessible paths are isolated.
- Do not introduce shell-based path parsing or shell command construction.
- Do not log environment contents or secrets.

## Tests

Add focused Bun tests for the shared deterministic resolver covering:

1. explicit Windows path wins over environment configuration;
2. explicit Unix path wins over environment configuration;
3. double-quoted path with spaces;
4. single-quoted path with spaces;
5. environment variable used when no explicit path exists;
6. blank environment variable ignored;
7. relative explicit path rejected;
8. relative environment-variable path rejected;
9. actionable error when neither path source exists;
10. returned paths are normalized and absolute;
11. no hardcoded Yusuf path appears in runtime TypeScript.

Integration verification must exercise at least one read-only skill and one
approval-required write skill against a disposable target directory.

## Acceptance Criteria

- [x] Yusuf has reviewed and approved this spec before implementation begins.
- [x] One shared resolver implements `explicit → environment → error` precedence.
- [x] DevOps, Testing, Documentation, and Security use the shared resolver.
- [x] Explicit Windows and Unix paths continue to work.
- [x] Quoted paths containing spaces work.
- [x] `ORCHESTRAI_PROJECT_PATH` works for tasks without an explicit path.
- [x] Missing configuration returns the specified actionable error and never uses `process.cwd()`.
- [x] Planned child tasks preserve the explicit path from the parent request.
- [x] `document-api` does not mistake a default project directory for a source file.
- [x] Dashboard quick actions contain no user-specific absolute path.
- [x] Orchestrator no longer loads `.env` from a user-specific absolute path.
- [x] Target-project selection never implicitly loads the target project's `.env`.
- [x] Existing approval requirements and overwrite warnings remain effective.
- [x] Focused resolver tests pass.
- [x] Read-only integration verification passes against a disposable project.
- [x] A write task pauses for approval and writes only to the resolved disposable target after approval.
- [x] `README.md`, `CLAUDE.md`, and `context/worklog.md` describe the final implemented behavior.

## Explicitly Out of Scope

- Restricting target paths to a configured workspace root or sandbox.
- Remote/cloud workspaces.
- Container volume mapping.
- MCP tool schema changes; MCP callers already provide explicit paths.
- A graphical project picker or OpenTUI path selector.
- Persistent per-user configuration files.
- Changing service ports or agent discovery.
- Refactoring all duplicated agent protocol types.

## Approved Review Decisions

1. Precedence is `explicit task path → ORCHESTRAI_PROJECT_PATH → clear error`.
2. Configuration uses inherited environment variables only; no custom `.env` loader.
3. Paths containing spaces must be quoted.
4. Full path sandboxing remains out of scope for this hackathon change.
