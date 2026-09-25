import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { spawnSync } from "child_process"
import { createMcpServer } from "./index"

// specs/079-phase-a-connect-orphaned-tools/spec.md — the Docker-dependent
// tests below need a real, reachable Docker daemon, not just the CLI
// installed (this sandbox has the CLI but no running daemon). Mirrors
// this codebase's own `test.skipIf(!modelAvailable)` pattern
// (detect-skill.test.ts) — skip cleanly rather than fail when the real
// dependency isn't present.
function isDockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["ps"], { timeout: 5000 })
    return result.status === 0
  } catch {
    return false
  }
}
const dockerAvailable = isDockerAvailable()

describe("shared MCP server factory", () => {
  test("creates a connectable server with the mapped DevOps tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createMcpServer()
    const client = new Client({ name: "mcp-factory-test", version: "1.0.0" })

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const tools = await client.listTools()
      const names = tools.tools.map((tool) => tool.name)
      expect(names).toContain("analyze_project")
      expect(names).toContain("git_status")
      expect(names).toContain("write_project_file")
      // specs/138 — the file templates and the fixed-command test tool are gone.
      for (const removed of ["create_dockerfile", "create_github_action", "create_dockercompose", "create_gitignore", "run_tests"]) {
        expect(names).not.toContain(removed)
      }

      const analysis = await client.callTool({
        name: "analyze_project",
        arguments: { project_path: process.cwd() },
      })
      // See specs/014-typecheck-ci/spec.md — the SDK's callTool() result type
      // isn't narrowable generically; cast to the shape actually returned.
      const content = analysis.content as { type: string; text: string }[]
      const text = content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n")
      expect(text).toContain("=== Project Analysis ===")
    } finally {
      await client.close()
      await server.close().catch(() => undefined)
    }
  })
})

// specs/079-phase-a-connect-orphaned-tools/spec.md — connects
// docker_build/docker_status/git_diff/git_commit (already implemented,
// never reachable by any agent before this spec) plus three new tools,
// and fixes safeExec()'s command-string re-splitting bug.
describe("specs/079 — orphaned tools connected + new tools", () => {
  let tmpDir: string
  let client: Client
  let server: ReturnType<typeof createMcpServer>

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "mcp-phase-a-test-"))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    server = createMcpServer()
    client = new Client({ name: "mcp-phase-a-test", version: "1.0.0" })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    await client.close()
    await server.close().catch(() => undefined)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
    const content = result.content as { type: string; text: string }[]
    return content.filter((item) => item.type === "text").map((item) => item.text).join("\n")
  }

  function git(args: string[], cwd: string): void {
    const result = spawnSync("git", args, { cwd, timeout: 10000 })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.toString()}`)
    }
  }

  test("the shared server advertises every specs/079 tool", async () => {
    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name)
    for (const name of ["docker_build", "docker_status", "git_diff", "git_commit", "docker_run", "lint_ci_workflow", "audit_dependencies_local"]) {
      expect(names).toContain(name)
    }
  })

  // The real regression this spec fixes: the OLD safeExec built
  // `git commit -m "${message}"` as a template string, then re-split it
  // on whitespace — a multi-word message like "fix bug" would arrive as
  // the two broken tokens `"fix` and `bug"`, quote characters included,
  // never a working multi-word commit. git_commit is the one existing
  // tool where this was already live, real, user-facing breakage before
  // this spec — not just a hypothetical Windows-path case.
  test("git_commit: a multi-word commit message survives intact (the real safeExec regression)", async () => {
    git(["init"], tmpDir)
    git(["config", "user.email", "test@example.com"], tmpDir)
    git(["config", "user.name", "Test"], tmpDir)
    writeFileSync(path.join(tmpDir, "file.txt"), "hello\n")

    const result = await client.callTool({
      name: "git_commit",
      arguments: { repo_path: tmpDir, message: "fix bug in the widget" },
    })
    expect(textOf(result)).not.toContain("error")

    const log = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: tmpDir })
    // The old bug would have produced a broken/truncated message (or a
    // failed commit entirely, since `"fix` isn't a valid -m value on its
    // own) — this is the exact real message, verbatim, space and all.
    expect(log.stdout.toString().trim()).toBe("fix bug in the widget")
  })

  test("git_commit: files containing a space in their name still work", async () => {
    git(["init"], tmpDir)
    git(["config", "user.email", "test@example.com"], tmpDir)
    git(["config", "user.name", "Test"], tmpDir)
    const spacedName = "my file.txt"
    writeFileSync(path.join(tmpDir, spacedName), "hello\n")

    const result = await client.callTool({
      name: "git_commit",
      arguments: { repo_path: tmpDir, message: "add spaced file", files: [spacedName] },
    })
    expect(textOf(result)).not.toContain("error")
    const log = spawnSync("git", ["show", "--stat", "-1"], { cwd: tmpDir })
    expect(log.stdout.toString()).toContain(spacedName)
  })

  test("git_diff: reports a real diff for staged changes", async () => {
    git(["init"], tmpDir)
    git(["config", "user.email", "test@example.com"], tmpDir)
    git(["config", "user.name", "Test"], tmpDir)
    writeFileSync(path.join(tmpDir, "a.txt"), "one\n")
    git(["add", "a.txt"], tmpDir)

    const result = await client.callTool({
      name: "git_diff",
      arguments: { repo_path: tmpDir, staged: true },
    })
    expect(textOf(result)).toContain("a.txt")
  })

  test("lint_ci_workflow: a well-formed workflow reports no issues", async () => {
    const workflowPath = path.join(tmpDir, "ci.yml")
    writeFileSync(workflowPath, "name: CI\non:\n  push:\n    branches: [main]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n")
    const result = await client.callTool({ name: "lint_ci_workflow", arguments: { workflow_path: workflowPath } })
    expect(textOf(result)).toContain("No structural issues found")
  })

  test("lint_ci_workflow: flags a missing 'jobs:' key", async () => {
    const workflowPath = path.join(tmpDir, "ci.yml")
    writeFileSync(workflowPath, "name: CI\non:\n  push:\n    branches: [main]\n")
    const result = await client.callTool({ name: "lint_ci_workflow", arguments: { workflow_path: workflowPath } })
    expect(textOf(result)).toContain("Missing top-level 'jobs:' key")
  })

  test("lint_ci_workflow: flags tab indentation", async () => {
    const workflowPath = path.join(tmpDir, "ci.yml")
    writeFileSync(workflowPath, "name: CI\non:\n\tpush:\njobs:\n  ci:\n    runs-on: ubuntu-latest\n")
    const result = await client.callTool({ name: "lint_ci_workflow", arguments: { workflow_path: workflowPath } })
    expect(textOf(result)).toContain("tab")
  })

  test("audit_dependencies_local: reports real declared dependency versions", async () => {
    writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { hono: "^4.0.0" }, devDependencies: { typescript: "^5.0.0" } }),
    )
    const result = await client.callTool({ name: "audit_dependencies_local", arguments: { project_path: tmpDir } })
    const text = textOf(result)
    expect(text).toContain("hono: ^4.0.0")
    expect(text).toContain("typescript: ^5.0.0")
  })

  test("audit_dependencies_local: no package.json reports that honestly, not an error", async () => {
    const result = await client.callTool({ name: "audit_dependencies_local", arguments: { project_path: tmpDir } })
    expect(textOf(result)).toContain("No package.json found")
  })

  test.skipIf(!dockerAvailable)("docker_status: reports real containers and images (requires a live Docker daemon)", async () => {
    const result = await client.callTool({ name: "docker_status", arguments: {} })
    expect(textOf(result)).toContain("=== Containers ===")
  })

  test.skipIf(!dockerAvailable)("docker_build + docker_run: a real image builds and boots (requires a live Docker daemon)", async () => {
    writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM alpine:3.19\nCMD [\"sleep\", \"30\"]\n")
    const tag = `orchestrai-mcp-test-${Date.now()}`
    const buildResult = await client.callTool({
      name: "docker_build",
      arguments: { context_path: tmpDir, image_tag: tag, dockerfile: "Dockerfile" },
    })
    expect(textOf(buildResult).toLowerCase()).not.toContain("error")

    const runResult = await client.callTool({ name: "docker_run", arguments: { image_tag: tag } })
    expect(textOf(runResult)).toContain("✅")

    spawnSync("docker", ["rmi", "-f", tag])
  }, 30000)

  // specs/143 — a failed build, run or commit is an error result, so the
  // calling agent fails its task instead of reporting success.
  test("git_commit: nothing to commit is an error with the exit code", async () => {
    git(["init"], tmpDir)
    git(["config", "user.email", "test@example.com"], tmpDir)
    git(["config", "user.name", "Test"], tmpDir)
    const result = await client.callTool({ name: "git_commit", arguments: { repo_path: tmpDir, message: "empty" } })
    expect(result.isError).toBeTrue()
    expect(textOf(result)).toMatch(/\[exit code \d+\]/)
  })

  test("git_commit: a folder that isn't a git repo is an error", async () => {
    const result = await client.callTool({ name: "git_commit", arguments: { repo_path: tmpDir, message: "x" } })
    expect(result.isError).toBeTrue()
    expect(textOf(result)).toContain("Not a git repo")
  })

  test("git_commit: a real commit is not an error", async () => {
    git(["init"], tmpDir)
    git(["config", "user.email", "test@example.com"], tmpDir)
    git(["config", "user.name", "Test"], tmpDir)
    writeFileSync(path.join(tmpDir, "a.txt"), "a\n")
    const result = await client.callTool({ name: "git_commit", arguments: { repo_path: tmpDir, message: "add a" } })
    expect(result.isError).toBeFalsy()
  })

  test.skipIf(!dockerAvailable)("docker_build: a broken Dockerfile is an error with Docker's output (requires Docker)", async () => {
    writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM alpine:3.19\nRUN exit 3\n")
    const result = await client.callTool({
      name: "docker_build",
      arguments: { context_path: tmpDir, image_tag: `orchestrai-mcp-broken-${Date.now()}`, dockerfile: "Dockerfile" },
    })
    expect(result.isError).toBeTrue()
    expect(textOf(result)).toMatch(/\[exit code \d+\]/)
  }, 60000)

  test.skipIf(!dockerAvailable)("docker_run: a container that exits at once is an error (requires Docker)", async () => {
    writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM alpine:3.19\nCMD [\"true\"]\n")
    const tag = `orchestrai-mcp-exits-${Date.now()}`
    const build = await client.callTool({ name: "docker_build", arguments: { context_path: tmpDir, image_tag: tag, dockerfile: "Dockerfile" } })
    expect(build.isError).toBeFalsy()
    const run = await client.callTool({ name: "docker_run", arguments: { image_tag: tag } })
    expect(run.isError).toBeTrue()
    expect(textOf(run)).toContain("❌")
    spawnSync("docker", ["rmi", "-f", tag])
  }, 60000)

  test.skipIf(!dockerAvailable)("docker_run: an invalid image reference is an error (requires Docker)", async () => {
    const run = await client.callTool({ name: "docker_run", arguments: { image_tag: "Invalid-Capitals:latest" } })
    expect(run.isError).toBeTrue()
    expect(textOf(run)).toContain("could not be started")
  }, 30000)
})

// specs/080-run-command-approved-execution/spec.md — run_command itself.
// This tool performs no approval check of its own (the calling agent's
// actionId-bound gate is what makes invoking it safe) — these tests only
// cover its own defense-in-depth (denylist, cwd-containment) and that a
// real argv actually executes bounded by timeout/output cap, exactly as
// documented in packages/mcp/index.ts's own comment on the tool.
describe("specs/080 — run_command", () => {
  let tmpDir: string
  let client: Client
  let server: ReturnType<typeof createMcpServer>

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "mcp-run-command-test-"))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    server = createMcpServer()
    client = new Client({ name: "mcp-run-command-test", version: "1.0.0" })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    await client.close()
    await server.close().catch(() => undefined)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
    const content = result.content as { type: string; text: string }[]
    return content.filter((item) => item.type === "text").map((item) => item.text).join("\n")
  }

  test("the shared server advertises run_command", async () => {
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toContain("run_command")
  })

  test("runs a real, bounded command and returns its output", async () => {
    const result = await client.callTool({
      name: "run_command",
      arguments: { argv: ["node", "-e", "console.log('hello from run_command')"], cwd: tmpDir, project_root: tmpDir },
    })
    expect(textOf(result)).toContain("hello from run_command")
    expect(result.isError).toBeFalsy()
  })

  test("denylist: a recursive force-delete rooted at \"/\" is blocked, never executed", async () => {
    const result = await client.callTool({
      name: "run_command",
      arguments: { argv: ["rm", "-rf", "/"], cwd: tmpDir, project_root: tmpDir },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("Blocked")
  })

  test("denylist: a fork bomb pattern is blocked", async () => {
    const result = await client.callTool({
      name: "run_command",
      arguments: { argv: [":() { :|:& };:"], cwd: tmpDir, project_root: tmpDir },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("Blocked")
  })

  // specs/129 — defense-in-depth behind approval for OrchestrAI's own state dir.
  test.each([
    [["cat", ".orchestrai/config.env"]],
    [["type", ".orchestrai\\config.env"]],
    [["node", "-e", "require('fs').readFileSync('.orchestrai/config.env')"]],
    [["ls", ".ORCHESTRAI"]],
  ])("denylist: %p touching .orchestrai is blocked, never executed", async (argv) => {
    const result = await client.callTool({ name: "run_command", arguments: { argv, cwd: tmpDir, project_root: tmpDir } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("Blocked")
  })

  test("denylist: a lookalike name is not blocked", async () => {
    const result = await client.callTool({
      name: "run_command",
      arguments: { argv: ["node", "-e", "console.log('.orchestrai-notes')"], cwd: tmpDir, project_root: tmpDir },
    })
    expect(result.isError).toBeFalsy()
  })

  test("a completely unrelated command is never denylisted (the list is narrow, not a general safety net)", async () => {
    const result = await client.callTool({
      name: "run_command",
      arguments: { argv: ["node", "-e", "console.log('totally fine')"], cwd: tmpDir, project_root: tmpDir },
    })
    expect(result.isError).toBeFalsy()
  })

  test("cwd-containment: a cwd outside project_root is denied", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "mcp-run-command-outside-"))
    try {
      const result = await client.callTool({
        name: "run_command",
        arguments: { argv: ["echo", "hi"], cwd: outside, project_root: tmpDir },
      })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain("outside project_root")
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("cwd-containment: cwd equal to project_root is allowed", async () => {
    const result = await client.callTool({
      name: "run_command",
      arguments: { argv: ["node", "-e", "console.log('same dir')"], cwd: tmpDir, project_root: tmpDir },
    })
    expect(result.isError).toBeFalsy()
  })

  test("a nonexistent cwd fails clearly rather than executing anywhere", async () => {
    const result = await client.callTool({
      name: "run_command",
      arguments: { argv: ["echo", "hi"], cwd: path.join(tmpDir, "does-not-exist"), project_root: tmpDir },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("not found")
  })

  test("a real command failure surfaces its own error, not a generic message", async () => {
    const result = await client.callTool({
      name: "run_command",
      arguments: { argv: ["node", "-e", "process.exit(7)"], cwd: tmpDir, project_root: tmpDir },
    })
    // A nonzero exit with no stderr still fails cleanly, not silently as success.
    expect(result.isError).toBe(true)
  })

  // specs/138 — a failing test suite prints its results to stdout; they
  // must survive a non-zero exit, with the exit code, so callers can tell
  // "ran and failed" from "could not run".
  test("a non-zero exit keeps stdout AND stderr, plus the exit code", async () => {
    const result = await client.callTool({
      name: "run_command",
      arguments: { argv: ["node", "-e", "console.log('3 passed, 1 failed'); console.error('boom'); process.exit(1)"], cwd: tmpDir, project_root: tmpDir },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as { text: string }[])[0]!.text
    expect(text).toContain("3 passed, 1 failed")
    expect(text).toContain("boom")
    expect(text.trimEnd().endsWith("[exit code 1]")).toBe(true)
  })

  test("a missing executable is still a plain error with no exit-code marker", async () => {
    const result = await client.callTool({
      name: "run_command",
      arguments: { argv: ["orchestrai-no-such-binary-xyz"], cwd: tmpDir, project_root: tmpDir },
    })
    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).not.toContain("[exit code")
  })
})

// specs/099-tui-port-url-and-analyze-project-stack-awareness/spec.md —
// analyze_project's own "DevOps Checks" section is now ecosystem-aware
// instead of unconditionally checking npm/Bun-specific files. Every
// case here uses a real scratch directory with real manifest files,
// never mocked file-presence.
describe("analyze_project — ecosystem-aware manifest/lockfile checks", () => {
  let tmpDir: string
  let client: Client
  let server: ReturnType<typeof createMcpServer>

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "mcp-analyze-ecosystem-test-"))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    server = createMcpServer()
    client = new Client({ name: "mcp-analyze-ecosystem-test", version: "1.0.0" })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    await client.close()
    await server.close().catch(() => undefined)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
    const content = result.content as { type: string; text: string }[]
    return content.filter((item) => item.type === "text").map((item) => item.text).join("\n")
  }

  test("a real PHP project reports composer.json/composer.lock — never hasBunLock", async () => {
    writeFileSync(path.join(tmpDir, "composer.json"), JSON.stringify({ name: "acme/app" }))
    writeFileSync(path.join(tmpDir, "composer.lock"), JSON.stringify({}))

    const result = await client.callTool({ name: "analyze_project", arguments: { project_path: tmpDir } })
    const text = textOf(result)

    expect(text).toContain("hasManifest (composer.json)")
    expect(text).toContain("hasLockfile (composer.lock)")
    expect(text).not.toContain("hasBunLock")
    expect(text).not.toContain("hasPackageJson")
  })

  test("a real npm project using only package-lock.json (no bun.lock at all) still reports its lockfile as present", async () => {
    writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "acme-app" }))
    writeFileSync(path.join(tmpDir, "package-lock.json"), JSON.stringify({}))

    const result = await client.callTool({ name: "analyze_project", arguments: { project_path: tmpDir } })
    const text = textOf(result)

    expect(text).toContain("hasManifest (package.json)")
    expect(text).toContain("hasLockfile (package-lock.json)")
    expect(text).toContain("✅ hasLockfile")
  })

  test("a project with none of the six known manifest files reports an explicit 'no recognized manifest' line, never a silently missing entry", async () => {
    // tmpDir starts genuinely empty — no manifest of any kind.
    const result = await client.callTool({ name: "analyze_project", arguments: { project_path: tmpDir } })
    const text = textOf(result)

    expect(text).toContain("no recognized dependency manifest found")
  })

  test("a real Go project reports go.mod/go.sum", async () => {
    writeFileSync(path.join(tmpDir, "go.mod"), "module acme.com/app\n\ngo 1.21\n")
    writeFileSync(path.join(tmpDir, "go.sum"), "")

    const result = await client.callTool({ name: "analyze_project", arguments: { project_path: tmpDir } })
    const text = textOf(result)

    expect(text).toContain("hasManifest (go.mod)")
    expect(text).toContain("hasLockfile (go.sum)")
  })

  test("a real Python project (requirements.txt) reports the manifest only — no lockfile concept", async () => {
    writeFileSync(path.join(tmpDir, "requirements.txt"), "requests==2.31.0\n")

    const result = await client.callTool({ name: "analyze_project", arguments: { project_path: tmpDir } })
    const text = textOf(result)

    expect(text).toContain("hasManifest (requirements.txt)")
    expect(text).not.toContain("hasLockfile")
  })

  test("a real Maven project (pom.xml) reports the manifest only — no standard lockfile concept", async () => {
    writeFileSync(path.join(tmpDir, "pom.xml"), "<project></project>")

    const result = await client.callTool({ name: "analyze_project", arguments: { project_path: tmpDir } })
    const text = textOf(result)

    expect(text).toContain("hasManifest (pom.xml)")
    expect(text).not.toContain("hasLockfile")
  })

  test("every universal check is byte-identical to before this spec, regardless of ecosystem", async () => {
    writeFileSync(path.join(tmpDir, "composer.json"), JSON.stringify({}))
    writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM php:8.3\n")
    writeFileSync(path.join(tmpDir, "README.md"), "# App\n")

    const result = await client.callTool({ name: "analyze_project", arguments: { project_path: tmpDir } })
    const text = textOf(result)

    expect(text).toContain("✅ hasDockerfile")
    expect(text).toContain("❌ hasDockerCompose")
    expect(text).toContain("❌ hasGitignore")
    expect(text).toContain("❌ hasEnvExample")
    expect(text).toContain("❌ hasCI")
    expect(text).toContain("✅ hasReadme")
  })
})
