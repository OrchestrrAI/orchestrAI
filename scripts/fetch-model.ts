// specs/020-semantic-intent-fallback/spec.md
//
// Downloads minishlab/potion-base-8M (Model2Vec static embeddings,
// distilled from bge-base-en-v1.5) into a gitignored models/ directory,
// verifying every file against a pinned SHA-256 so a silently-updated
// upstream model can never change routing behavior underneath the tests.
// Not run automatically by `bun install` — intent-classifier.ts degrades
// gracefully (returns null, defers to keyword-only routing) when these
// files are absent, so this script is opt-in, run once by whoever wants
// the semantic fallback available locally or in a build.

import { mkdirSync, existsSync } from "fs"
import * as path from "path"

const REPO_ROOT = path.join(import.meta.dir, "..")
const MODEL_ID = "minishlab/potion-base-8M"
const MODEL_DIR = path.join(REPO_ROOT, "models", "potion-base-8M")

// Pinned by hand against the exact files fetched for this spec's spike —
// not re-derived from whatever happens to be at the URL when this script
// runs. A checksum mismatch is treated as fatal, not silently ignored.
const FILES: { name: string; sha256: string }[] = [
  { name: "config.json", sha256: "2a6ac0e9aaa356a68a5688070db78fc3a464fefe85d2f06a1905ce3718687553" },
  { name: "tokenizer.json", sha256: "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50" },
  { name: "tokenizer_config.json", sha256: "6725995e3ab3039857ff5bd99178a7cdf42863abb04449e7bb31feb1f55fe567" },
  { name: "special_tokens_map.json", sha256: "a9e8fb6f99fb0b8803f0e6942fdf4d95d6645204620b67dc3310a1024bcbac59" },
  { name: "model.safetensors", sha256: "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2" },
]

async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function main(): Promise<void> {
  mkdirSync(MODEL_DIR, { recursive: true })

  for (const file of FILES) {
    const dest = path.join(MODEL_DIR, file.name)
    if (existsSync(dest)) {
      const existing = await sha256(await Bun.file(dest).arrayBuffer())
      if (existing === file.sha256) {
        console.log(`[fetch-model] ${file.name} already present and verified, skipping`)
        continue
      }
      console.log(`[fetch-model] ${file.name} present but checksum mismatch — re-downloading`)
    }

    console.log(`[fetch-model] Downloading ${file.name}...`)
    const url = `https://huggingface.co/${MODEL_ID}/resolve/main/${file.name}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to download ${file.name}: HTTP ${res.status}`)
    const buf = await res.arrayBuffer()

    const actual = await sha256(buf)
    if (actual !== file.sha256) {
      throw new Error(
        `[fetch-model] Checksum mismatch for ${file.name}: expected ${file.sha256}, got ${actual}. ` +
          `Refusing to save — the upstream model may have changed.`,
      )
    }

    await Bun.write(dest, buf)
    console.log(`[fetch-model] ${file.name} verified and saved (${(buf.byteLength / 1024).toFixed(0)} KB)`)
  }

  console.log(`\n[fetch-model] Done. Model files are in ${MODEL_DIR}`)
  console.log(`[fetch-model] The semantic intent fallback will now be available.`)
}

main().catch((err) => {
  console.error("[fetch-model] Failed:", err.message ?? err)
  process.exit(1)
})
