import { OrchestraiMcpClient } from "../../shared/mcp-client"

export type { McpConnectionState, McpReadiness } from "../../shared/mcp-client"

const REQUIRED_TOOLS = [
  "analyze_project",
  "git_status",
  // specs/138 — the four create_* template tools are gone. DevOps writes
  // its model-authored, validated files through the shared,
  // path-contained write_project_file, only from resumeTask() after
  // approval (the specs/101 decision to share this write tool with DevOps).
  "write_project_file",
  // specs/042-llm-harness-devops/spec.md — DevOps previously had no generic
  // file-read access, only structural checks via analyze_project. Added for
  // the opt-in LLM harness's parameter-decision tools (real dependency
  // detection needs real file content, e.g. package.json's dependencies) —
  // read-only, Tier 2, same tool Documentation's harness already uses.
  "read_project_file",
  // specs/079-phase-a-connect-orphaned-tools/spec.md — these four were
  // already fully implemented on the shared MCP server (packages/mcp/
  // index.ts) but never reachable by any agent; connecting them is this
  // spec's whole first half. docker_status/git_diff back the new
  // read-only docker-status/git-diff skills; docker_build/docker_run
  // back build-image/verify-deployment; git_commit backs commit-changes.
  "docker_build",
  "docker_run",
  "docker_status",
  "git_diff",
  "git_commit",
  // New tools this spec adds (packages/mcp/index.ts).
  // specs/101-per-agent-tool-access-expansion/spec.md §B — this was
  // "lint_ci_workflow" AND "audit_dependencies_local" here since
  // specs/079, but audit_dependencies_local was never actually called
  // from any skill — a hard startup dependency on a capability nothing
  // exercised. Its own justification is also now superseded:
  // specs/085 gave Security real multi-ecosystem manifest parsing
  // (npm/PyPI/Go/Packagist/Maven, plus lockfile widening), strictly a
  // superset of what this npm-only, package.json-only tool ever
  // offered, and wiring it into analyze-project's report would have
  // reintroduced the npm-centric noise specs/099 just removed from that
  // same report. Removed from here; it stays registered on the MCP
  // server (packages/mcp/index.ts) for the external stdio surface —
  // only this hard startup dependency is removed, not the tool itself.
  // lint_ci_workflow, by contrast, IS now wired (into create-ci's own
  // post-write path — see index.ts's resumeTask()) and stays required.
  "lint_ci_workflow",
  // specs/080-run-command-approved-execution/spec.md §2 — the general,
  // per-invocation-approved execution primitive backing DevOps's own
  // run-command skill.
  "run_command",
]

/**
 * Thin, behavior-preserving wrapper around the shared MCP client
 * (specs/011-remaining-agents-mcp/spec.md) — DevOps's observed behavior
 * (caller name "devops-agent", these required tools, same URL resolution)
 * is unchanged by this extraction.
 */
export class DevOpsMcpClient extends OrchestraiMcpClient {
  constructor(rawUrl?: string) {
    super({ callerName: "devops-agent", requiredTools: REQUIRED_TOOLS, url: rawUrl })
  }
}
