#!/usr/bin/env node
// specs/032-npm-package-distribution/spec.md
//
// Dispatcher npm's "bin" field points at. The real binary is NOT
// downloaded at runtime — it's installed by npm itself, as one of three
// mutually-exclusive optionalDependencies (orchestrai-win32-x64,
// orchestrai-linux-x64, orchestrai-darwin-arm64), each restricted to its
// own platform via package.json's "os"/"cpu" fields, so exactly one of
// them physically lands in node_modules on any given install. This is
// the same pattern esbuild/swc/turbo use, and it sidesteps needing any
// download/checksum code at runtime at all — npm's own registry already
// verifies each tarball's integrity during install.
//
// (An earlier design in this same checkpoint instead downloaded the
// binary from this repository's GitHub Releases at first run. Reworked
// away from that: this repository is private, so an unauthenticated
// bunx/npx invocation on a machine with no repo access could never reach
// GitHub's Releases API or asset-download endpoints — confirmed live via
// plain unauthenticated curl returning 404 on both. Publishing the binary
// through npm's own registry has no dependency on GitHub repo visibility
// at all.)

"use strict"

const path = require("path")
const { spawnSync } = require("child_process")
const { chmodSync, existsSync } = require("fs")

// One fixed platform package per supported platform+arch — mirrors
// npm-package/*/package.json's own "os"/"cpu" restrictions exactly.
const PLATFORM_PACKAGES = {
  "win32-x64": { pkg: "orchestrai-windows-x64", bin: "orchestrai.exe" },
  "linux-x64": { pkg: "orchestrai-linux-x64", bin: "orchestrai" },
  "darwin-arm64": { pkg: "orchestrai-darwin-arm64", bin: "orchestrai-macos-arm64" },
}

function platformKey() {
  return `${process.platform}-${process.arch}`
}

function resolveBinaryPath() {
  const entry = PLATFORM_PACKAGES[platformKey()]
  if (!entry) {
    throw new Error(
      `No orchestrai build is published for ${platformKey()}. ` +
        `Supported: ${Object.keys(PLATFORM_PACKAGES).join(", ")}. ` +
        `See https://github.com/Muhamad-Yussuf/devops-mcp-server#readme for building from source instead.`,
    )
  }
  // Resolve the platform package's own package.json first, then join the
  // known relative bin path onto its directory — rather than
  // require.resolve()-ing the binary's deep sub-path directly. Found live
  // (a real WSL/global-install report, binary confirmed present on disk
  // in exactly the expected location, yet the deep-path resolve() still
  // failed) that the direct approach is fragile in at least one real
  // global-install layout, for a reason not fully pinned down. Resolving
  // package.json is the same pattern esbuild's own installer uses for
  // this exact reason — it only depends on Node finding the package
  // directory at all, not on any deep multi-segment specifier resolution.
  let pkgDir
  try {
    pkgDir = path.dirname(require.resolve(path.join(entry.pkg, "package.json")))
  } catch {
    throw new Error(
      `The "${entry.pkg}" optional dependency isn't installed. ` +
        `This usually means the install ran with --no-optional or ` +
        `--ignore-scripts, or npm's platform detection didn't select it. ` +
        `Try reinstalling without those flags.`,
    )
  }

  const binPath = path.join(pkgDir, "bin", entry.bin)
  if (!existsSync(binPath)) {
    throw new Error(
      `The "${entry.pkg}" optional dependency is installed at ${pkgDir}, ` +
        `but its expected binary is missing at ${binPath}. The install may ` +
        `be corrupted — try "npm uninstall -g orchestrai && npm cache clean ` +
        `--force && npm i -g orchestrai" to reinstall cleanly.`,
    )
  }
  return binPath
}

function main() {
  let binPath
  try {
    binPath = resolveBinaryPath()
  } catch (err) {
    console.error(`orchestrai: ${err.message}`)
    process.exit(1)
  }

  // Defensive, not decorative: found live that orchestrai-linux-x64@0.1.1
  // and orchestrai-darwin-arm64@0.1.1 were both published from a Windows
  // machine, where NTFS has no Unix executable bit — npm/tar faithfully
  // preserved that absence, so a fresh install landed the binary as
  // `-rw-r--r--` and every install failed with EACCES on first launch.
  // Re-asserting the bit here at run time fixes existing (and any future)
  // published tarballs without needing a republish of the multi-hundred-MB
  // platform packages. Windows binaries don't have this concept at all, so
  // this is skipped there; failures are swallowed; spawnSync's own error
  // handling below still catches a genuinely unusable binary.
  if (process.platform !== "win32") {
    try {
      chmodSync(binPath, 0o755)
    } catch {
      // Best-effort — if this fails (e.g. a read-only filesystem), the
      // spawnSync below will surface whatever the real problem is.
    }
  }

  const result = spawnSync(binPath, process.argv.slice(2), { stdio: "inherit" })
  if (result.error) {
    console.error(`orchestrai: failed to launch the platform binary: ${result.error.message}`)
    process.exit(1)
  }
  process.exit(result.status === null ? 1 : result.status)
}

main()
