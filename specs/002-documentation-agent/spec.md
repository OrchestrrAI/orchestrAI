---
id: 002-documentation-agent
title: Documentation Agent
area: documentation-agent
change_type: feature
status: implemented
verification: partial
created: 2026-08-07
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-07
implemented_on: 2026-08-07
amends: []
supersedes: []
superseded_by: []
related:
  - 011-remaining-agents-mcp
  - 008-routing-fixes
  - 006-runtime-stabilization
---

# Spec: Documentation Agent

> Historical baseline: the Documentation Agent exists, but later specs moved
> its privileged reads/writes behind MCP and strengthened approval integrity.
> See `remaining-agents-mcp`, `routing-fixes`, and `runtime-stabilization` in
> the catalog. Original unchecked manual criteria remain recorded below, so
> verification is classified as `partial` rather than silently inferred.

## Purpose

Generates and maintains project documentation — README files, API docs, and
inline code comments — as part of the SDLC pipeline. Fills the "Documentation
Agent" role listed in the original team submission's example agents.

## Position in the System

```
Orchestrator (:3000)
        ↓ A2A
Documentation Agent (:3004)   ← NEW
        ↓ Node fs APIs (no MCP, same pattern as DevOps Agent's file-gen skills)
   README.md / docs/ files in target project
```

Same architectural pattern as `packages/agents/devops/index.ts`: standalone
Hono app, in-memory task Map, Agent Card, browser dashboard, human approval
gate on writes.

## Agent Card

```json
{
  "name": "documentation-agent",
  "description": "Generates and updates project documentation",
  "url": "http://localhost:3004",
  "version": "1.0.0",
  "skills": [
    {
      "id": "generate-readme",
      "name": "Generate README",
      "description": "Create a README.md from project structure and package.json",
      "examples": ["generate a README for the project at C:\\path\\to\\project"]
    },
    {
      "id": "document-api",
      "name": "Document API Endpoints",
      "description": "Scan a Hono/Express file for routes and generate an API reference doc",
      "examples": ["document the API at C:\\path\\to\\project\\index.ts"]
    }
  ]
}
```

## Input

Free-text + path extraction, same convention as DevOps Agent's `extractPath()`:

```
"generate a README for the project at C:\Users\moham\devops-mcp-server"
"document the API at C:\Users\moham\devops-mcp-server\apps\orchestrator\index.ts"
```

## generate-readme Behavior

1. Read `package.json` at the target path (name, description, dependencies)
2. Read the top-level directory structure (reuse `readdir` pattern from
   `skillAnalyzeProject` in the DevOps Agent — same Windows-safe approach)
3. Detect if a `Dockerfile` exists → add a "Running with Docker" section
4. Detect if `.github/workflows/` exists → add a "CI/CD" badge/section
5. Produce a README with these sections in order:
   - Title (from package.json name, or folder name if missing)
   - Description (from package.json description, or a placeholder)
   - Project Structure (the directory tree)
   - Getting Started (bun install / bun run based on detected package.json scripts)
   - Docker (only if Dockerfile detected)
   - CI/CD (only if workflows detected)
6. **This is a write operation — requires human approval** (add `"generate-readme"`
   to whatever `NEEDS_APPROVAL` set exists in the agent)
7. If a README.md already exists at the target path, do NOT silently overwrite —
   include a note in the approval-pending message: "README.md already exists —
   approving will overwrite it"

## document-api Behavior

1. Read the target `.ts` file (must be a file path, not a directory — validate
   and return a clear error if given a directory)
2. Use a regex scan (not a full TS parser — keep this simple) to find Hono
   route registrations: patterns like `app.get(`, `app.post(`, `app.put(`,
   `app.delete(` followed by a route string
3. For each match, extract: HTTP method, path, and any comment on the line
   immediately above it (if present) as the description
4. Output format:
   ```
   # API Reference — <file path>

   ## GET /healthz
   Health check endpoint

   ## POST /tasks
   Submit a new task
   ```
5. **This is read-only** unless the user also asks to save it to a file — if no
   output path is given in the task text, just return the doc as task result
   text (no approval needed). If an output path IS given (matches "save to" or
   "write to" in the text), treat it as a write operation requiring approval.

## Output Format (generate-readme, after approval)

```
README.md created at <path>

<full README content preview>
```

## Behavior Rules

- Follow CLAUDE.md Windows rules: `readdir()` not `ls`, no shell string exec
- `generate-readme` and any "save to file" variant of `document-api` go through
  the same human-in-the-loop pattern as DevOps Agent's `NEEDS_APPROVAL` set
- Default port: **3004**
- Copy the task processor / dashboard structure from
  `packages/agents/devops/index.ts` — don't reinvent

## File Location

```
packages/agents/documentation/
├── package.json     ← @orchestrai/agent-documentation
└── index.ts
```

## Integration Points

- Add `"http://localhost:3004"` to Orchestrator's `KNOWN_AGENTS`
- No changes needed to `parsePlanText()` — generic skill lookup already works
- Consider whether Planning Agent's `skillPlanTask()` should suggest
  `[generate-readme]` as a step when the task mentions "documentation" or
  "docs" — optional, not required for v1

## Acceptance Criteria

- [ ] `GET http://localhost:3004/.well-known/agent.json` returns the Agent Card
- [ ] `GET http://localhost:3004/dashboard` renders in the same visual style
- [ ] Orchestrator auto-discovers documentation-agent on startup
- [ ] `generate-readme` on a project with a Dockerfile produces a README
      that includes a Docker section
- [ ] `generate-readme` pauses at `input-required` and only writes after approval
- [ ] `document-api` against `apps/orchestrator/index.ts` correctly lists at
      least: `/healthz`, `/agents`, `/tasks` (POST), `/tasks/:id` (GET)
- [ ] `document-api` without a save path returns text only, no approval needed

## Explicitly Out of Scope

- Full TypeScript AST parsing (regex-based route detection is good enough)
- Auto-updating existing README sections (full overwrite only, with the
  overwrite warning noted above)
- Documenting non-Hono frameworks (Express, Fastify, etc.)
- Markdown linting or formatting validation
