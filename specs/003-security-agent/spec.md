---
id: 003-security-agent
title: Security Agent
area: security-agent
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
  - 013-security-skill-detection
---

# Spec: Security Agent

> Historical baseline: the Security Agent exists and intentionally remains a
> direct, read-only filesystem client under the later `remaining-agents-mcp`
> decision. Routing, detection, and audit behavior were refined by later specs.
> Original unchecked manual criteria remain recorded below, so verification is
> classified as `partial` rather than silently inferred.

## Purpose

Scans a target project for common security issues — exposed secrets, unsafe
dependency patterns, and risky configuration — before code ships. Fills the
"Security Agent" role listed in the original team submission's example agents,
and gives the DevOps Agent's `NEEDS_APPROVAL` gate a natural upstream check.

## Position in the System

```
Orchestrator (:3000)
        ↓ A2A
Security Agent (:3005)   ← NEW
        ↓ Node fs APIs (no MCP — read-only, no external tool calls needed for v1)
   scans files under target project path
```

Same architectural pattern as the other agents: standalone Hono app, in-memory
task Map, Agent Card, browser dashboard. Unlike DevOps/Documentation Agents,
**all skills here are read-only** — this agent never writes files, so it needs
no approval gate at all.

## Agent Card

```json
{
  "name": "security-agent",
  "description": "Scans projects for exposed secrets and risky configuration",
  "url": "http://localhost:3005",
  "version": "1.0.0",
  "skills": [
    {
      "id": "scan-secrets",
      "name": "Scan for Exposed Secrets",
      "description": "Search project files for hardcoded API keys, tokens, and credentials",
      "examples": ["scan for secrets at C:\\path\\to\\project"]
    },
    {
      "id": "check-gitignore-coverage",
      "name": "Check .gitignore Coverage",
      "description": "Verify sensitive file patterns (.env, credentials) are actually gitignored",
      "examples": ["check gitignore coverage at C:\\path\\to\\project"]
    },
    {
      "id": "audit-dependencies",
      "name": "Audit Dependencies",
      "description": "Flag dependencies with no version pinning in package.json",
      "examples": ["audit dependencies at C:\\path\\to\\project"]
    }
  ]
}
```

## Input

Same free-text + path extraction convention as the other agents:

```
"scan for secrets at C:\Users\moham\devops-mcp-server"
"check gitignore coverage at C:\Users\moham\devops-mcp-server"
"audit dependencies at C:\Users\moham\devops-mcp-server"
```

## scan-secrets Behavior

1. Walk the target directory recursively (reuse Windows-safe `readdir` pattern),
   **excluding** `node_modules/`, `.git/`, `dist/`, `build/` — this is critical,
   scanning node_modules will produce thousands of false positives and be slow
2. For each text file (`.ts`, `.js`, `.json`, `.env*`, `.yml`, `.yaml`), scan
   line by line for patterns that look like secrets:
   - `api[_-]?key\s*[:=]\s*["'][a-zA-Z0-9_\-]{16,}["']`
   - `secret\s*[:=]\s*["'][a-zA-Z0-9_\-]{16,}["']`
   - `password\s*[:=]\s*["'].+["']` (excluding obvious placeholders like
     "your-password-here", "xxx", "changeme")
   - `sk-ant-`, `sk-`, `ghp_`, `AKIA` prefixes (Anthropic, OpenAI, GitHub, AWS
     key prefixes) — these are high-confidence matches
3. **Never print the actual matched secret value in the output** — redact it:
   show the file, line number, and a masked version (first 4 + last 4 chars,
   middle replaced with `...`)
4. Output format:
   ```
   === Secret Scan ===
   Path: <path>
   Files scanned: N

   [HIGH CONFIDENCE] .env:3
     Pattern: Anthropic API key
     Value: sk-a...9f2k (redacted)

   [MEDIUM CONFIDENCE] config.ts:12
     Pattern: hardcoded password
     Value: myse...cret (redacted)

   Total findings: 2
   ```
   If nothing found: `No exposed secrets detected in N files scanned.`

## check-gitignore-coverage Behavior

1. Read `.gitignore` at target path (if missing, report that as the top finding)
2. Check whether these patterns are covered: `.env`, `.env.*`, `node_modules/`,
   `*.key`, `*.pem`, `dist/`, `build/`
3. Output which of these are missing from `.gitignore`
4. Also check: does a `.env` file exist in the project AND is it NOT covered
   by `.gitignore`? That's a critical finding — flag it clearly.

## audit-dependencies Behavior

1. Read `package.json` dependencies + devDependencies
2. Flag any dependency using `"*"` or `"latest"` as its version (no pinning —
   a supply-chain risk)
3. This does NOT need to call npm/bun registry APIs or check for known CVEs —
   that's out of scope for v1, see below
4. Output format:
   ```
   === Dependency Audit ===
   Path: <path>
   Total dependencies: N

   Unpinned versions:
     - some-package: "*"
     - other-package: "latest"

   (or "All dependencies are pinned." if none found)
   ```

## Behavior Rules

- **All three skills are read-only — no `NEEDS_APPROVAL` entries at all** for
  this agent. It never writes to disk.
- Follow CLAUDE.md Windows rules: `readdir()` not `ls`, no shell exec of any kind
- Must exclude `node_modules/`, `.git/`, `dist/`, `build/` from any recursive
  scan — this is a hard requirement, not a nice-to-have (performance + noise)
- Default port: **3005**
- Copy task processor / dashboard structure from `packages/agents/devops/index.ts`,
  but the dashboard's "Actions" column will just show "View Result" (no
  Approve/Reject ever appears for this agent)

## File Location

```
packages/agents/security/
├── package.json     ← @orchestrai/agent-security
└── index.ts
```

## Integration Points

- Add `"http://localhost:3005"` to Orchestrator's `KNOWN_AGENTS`
- Consider adding a `[scan-secrets]` step to Planning Agent's `skillPlanTask()`
  output whenever the plan already includes `[dockerize]` or `[create-ci]` —
  running a secret scan before you containerize or set up CI is a sensible
  default order. Optional, not required for v1.

## Acceptance Criteria

- [ ] `GET http://localhost:3005/.well-known/agent.json` returns the Agent Card
- [ ] `GET http://localhost:3005/dashboard` renders, no Approve/Reject buttons anywhere
- [ ] Orchestrator auto-discovers security-agent on startup
- [ ] `scan-secrets` against a test file containing `ANTHROPIC_API_KEY=sk-ant-abc123...`
      finds it and redacts the value in the output (does not print it in full)
- [ ] `scan-secrets` explicitly skips `node_modules/` even if the target
      project has it (verify by timing — should be fast, not walk thousands of files)
- [ ] `check-gitignore-coverage` against this repo's own `.gitignore` correctly
      reports whether `.env` is covered
- [ ] `audit-dependencies` against this repo's root `package.json` runs without
      error even if all dependencies are pinned (empty findings is a valid result)
- [ ] No task from this agent ever reaches `input-required` status

## Explicitly Out of Scope

- Real CVE / vulnerability database lookups (would need `npm audit`,
  `bun audit`, or an external API — not implemented in v1)
- SAST (static application security testing) / code flow analysis
- Auto-fixing found issues (this agent reports only, never modifies files)
- Scanning binary files or archives
- Secret scanning inside git history (only scans current working tree files)
