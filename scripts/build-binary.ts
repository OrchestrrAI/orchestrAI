// specs/017-standalone-binary-distribution/spec.md
//
// Compiles the entire OrchestrAI runtime (all 4 agents, the MCP HTTP
// server, the Orchestrator, the TUI, and the supervisor's own dispatch
// logic) into ONE standalone executable via `bun build --compile`, using
// apps/supervisor/index.ts as the single entry point — that file already
// dynamically imports every service by name (SERVICE_STARTERS), so `bun
// build --compile` bundles all of them into the one output binary; only
// the subcommand actually invoked at runtime executes.
//
// `--define ORCHESTRAI_COMPILED='"true"'` is what apps/supervisor/index.ts
// checks to know it's running standalone (self-spawn children as `service
// <name>`) rather than in dev mode (spawn via `bun run <script>`) — a
// documented, stable Bun build feature, confirmed directly by a spike
// before this script was written, not an assumption.
//
// Host-platform-only in this pass (see the spec's Non-Goals) — no
// cross-compilation matrix.

import * as path from "path"
import { mkdirSync, statSync } from "fs"

const REPO_ROOT = path.join(import.meta.dir, "..")
const ENTRY = path.join(REPO_ROOT, "apps/supervisor/index.ts")
const OUT_DIR = path.join(REPO_ROOT, "dist/bin")
const IS_WINDOWS = process.platform === "win32"
const OUT_NAME = "orchestrai" + (IS_WINDOWS ? ".exe" : "")
const OUT_PATH = path.join(OUT_DIR, OUT_NAME)

function bunTarget(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  return `bun-${platform}-${arch}`
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB`
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })

  const target = bunTarget()
  console.log(`[build] Compiling one standalone binary for ${target}...`)
  console.log(`[build] Entry: ${ENTRY}`)
  console.log(`[build] Output: ${OUT_PATH}`)

  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      `--define`,
      `ORCHESTRAI_COMPILED="true"`,
      `--target=${target}`,
      ENTRY,
      "--outfile",
      OUT_PATH,
    ],
    {
      cwd: REPO_ROOT,
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    console.error(`[build] bun build --compile failed (exit ${exitCode})`)
    process.exit(exitCode)
  }

  const size = statSync(OUT_PATH).size
  console.log(`\n[build] === Done ===`)
  console.log(`[build] ${OUT_PATH}`)
  console.log(`[build] Size: ${formatBytes(size)}`)
  console.log(`[build] Run it: ${IS_WINDOWS ? OUT_PATH : `./${path.relative(REPO_ROOT, OUT_PATH)}`}`)
  console.log(`[build] Or a single service: ${OUT_NAME} service <name>`)
  console.log(`[build] Or the TUI: ${OUT_NAME} tui`)
  console.log(`[build] ===========\n`)
}

main().catch((err) => {
  console.error("[build] Fatal error:", err)
  process.exit(1)
})
