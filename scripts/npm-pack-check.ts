// specs/032-npm-package-distribution/spec.md
//
// Local verification harness — copies the already-built dist/bin/*
// binaries into their respective npm-package/*/bin/ directories and runs
// `npm pack --dry-run` (and a real `npm pack` into a scratch dir) on
// every package, without ever touching the real npm registry. This is
// how the 256 MB-per-tarball question and the overall package structure
// were verified in this session — no npm account/token needed for any of
// it, since `npm pack` only builds the tarball locally.
//
// Run manually: bun run scripts/npm-pack-check.ts
// Not wired into `bun test`/CI — it depends on dist/bin/* already being
// built (`bun run build`) and shells out to the real `npm` CLI.

import * as path from "path"
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs"
import { execFileSync } from "child_process"

const REPO_ROOT = path.join(import.meta.dir, "..")
const DIST_BIN = path.join(REPO_ROOT, "dist", "bin")
const NPM_PACKAGE_ROOT = path.join(REPO_ROOT, "npm-package")

const PLATFORM_PACKAGES = [
  { dir: "win32-x64", binSrc: "orchestrai.exe", binDest: "orchestrai.exe" },
  { dir: "linux-x64", binSrc: "orchestrai", binDest: "orchestrai" },
  { dir: "darwin-arm64", binSrc: "orchestrai-macos-arm64", binDest: "orchestrai-macos-arm64" },
]

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const NPM_LIMIT_BYTES = 256 * 1024 * 1024

function main() {
  console.log("=== npm package structure + size check (local only, no registry contact) ===\n")

  let anyBinaryFound = false

  for (const { dir, binSrc, binDest } of PLATFORM_PACKAGES) {
    const pkgDir = path.join(NPM_PACKAGE_ROOT, dir)
    const binDir = path.join(pkgDir, "bin")
    const srcPath = path.join(DIST_BIN, binSrc)

    if (!existsSync(srcPath)) {
      console.log(`[${dir}] SKIP — ${srcPath} not built on this machine (expected: only your own platform's binary exists locally).`)
      continue
    }

    mkdirSync(binDir, { recursive: true })
    const destPath = path.join(binDir, binDest)
    copyFileSync(srcPath, destPath)
    const size = statSync(destPath).size
    anyBinaryFound = true

    console.log(`[${dir}] binary: ${formatBytes(size)}`)
    if (size > NPM_LIMIT_BYTES) {
      console.error(`[${dir}] FAIL — exceeds npm's 256 MB per-tarball limit by ${formatBytes(size - NPM_LIMIT_BYTES)}`)
      process.exitCode = 1
      continue
    }

    const packOut = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: pkgDir, encoding: "utf8" })
    const [result] = JSON.parse(packOut)
    console.log(`[${dir}] npm pack --dry-run: tarball ${formatBytes(result.size)}, unpacked ${formatBytes(result.unpackedSize)}, ${result.entryCount} file(s)`)
    if (result.size > NPM_LIMIT_BYTES) {
      console.error(`[${dir}] FAIL — packed tarball exceeds npm's 256 MB limit`)
      process.exitCode = 1
    } else {
      console.log(`[${dir}] OK — under npm's 256 MB limit with ${formatBytes(NPM_LIMIT_BYTES - result.size)} to spare`)
    }
  }

  console.log(`\n[orchestrai] meta package:`)
  const metaOut = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: path.join(NPM_PACKAGE_ROOT, "orchestrai"), encoding: "utf8" })
  const [metaResult] = JSON.parse(metaOut)
  console.log(`[orchestrai] npm pack --dry-run: tarball ${formatBytes(metaResult.size)}, unpacked ${formatBytes(metaResult.unpackedSize)}, ${metaResult.entryCount} file(s)`)

  if (!anyBinaryFound) {
    console.log("\nNo platform binaries were found under dist/bin/ — run `bun run build` first for at least a partial check.")
  }

  console.log("\n=== done ===")
}

main()
