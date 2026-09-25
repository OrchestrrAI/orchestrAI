// specs/020-semantic-intent-fallback/spec.md
//
// A semantic fallback for skill routing, used ONLY when keyword matching
// (detectSkill()) finds nothing — never a replacement for it. Uses
// minishlab/potion-base-8M (Model2Vec): static embeddings distilled from a
// real sentence transformer, so classification is tokenize -> look up one
// vector per token -> mean-pool -> cosine similarity. No inference engine,
// therefore no native ONNX addon and no browser-only global — both of
// which were verified (via real spikes, not assumption) to break inside a
// `bun build --compile` binary for a full transformer model. See this
// spec's "Verified Current Behavior" for the four spikes that led here.
//
// Deterministic and explainable: the exact same input always produces the
// exact same {skill, score, margin} — no sampling, no temperature, no
// network call in the runtime. Approval-gate behavior for whatever skill
// gets returned is entirely unaffected by how that skill was chosen; see
// this spec's Safety Constraints.
import { existsSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { stripPathPhrases } from "./index"

declare const ORCHESTRAI_COMPILED: string | undefined
const isCompiled = typeof ORCHESTRAI_COMPILED !== "undefined"

const MODEL_ID = "potion-base-8M"
const MIN_SCORE = 0.3
// Found live during this spec's own verification, not theorized: "improve
// the security of my app" scores 0.41 for scan-secrets (above MIN_SCORE)
// but its margin over the 2nd-place skill is 0.002 — essentially a coin
// flip between skills the keyword system deliberately left ambiguous (the
// existing "no bare 'security' keyword — ambiguous across 3 skills" test).
// A score-only threshold would have let the classifier confidently commit
// to one arbitrary side of a genuine tie. Requiring a minimum margin too
// rejects near-ties without needing to special-case them.
const MIN_MARGIN = 0.05

// Hand-written example phrases per skill — this is the entire "training"
// step for a nearest-neighbor static-embedding classifier: no fine-tuning,
// no learned weights beyond the pretrained embedding table itself. Kept in
// sync with the real skill set advertised across all 4 agents (CLAUDE.md's
// services table) plus plan-task, which is a legitimate destination in its
// own right for genuinely broad requests, not just a fallback-of-last-resort.
const SKILL_EXAMPLES: Record<string, string[]> = {
  "dockerize": ["dockerize my app", "create a dockerfile", "containerize this project", "wrap this in a docker image"],
  "create-ci": ["set up a ci pipeline", "add github actions", "create a ci workflow", "automate my build and test pipeline"],
  "create-gitignore": ["create a gitignore file", "ignore node_modules in git", "set up gitignore for this project"],
  "create-compose": ["create a docker compose file", "set up multi container orchestration", "write a compose file for my services"],
  "analyze-project": ["analyze my project", "check what devops files are missing", "review my project structure"],
  "git-status": ["show git status", "what changed in my repo", "check the working tree", "is my repo clean or are there uncommitted changes"],
  "run-tests": ["run my tests", "run the test suite", "execute unit tests", "verify the suite is green before i ship"],
  "check-coverage": ["check test coverage", "how much of my code is tested", "run a coverage report"],
  "generate-readme": ["generate a readme", "write project documentation", "create a readme file", "explain how the code is organized"],
  "document-api": ["document my api endpoints", "generate api reference docs", "document the routes in this file"],
  "scan-secrets": ["scan for secrets", "check for exposed api keys", "find leaked credentials", "are any passwords hardcoded anywhere"],
  "check-gitignore-coverage": ["check gitignore coverage", "make sure env files are ignored", "verify sensitive files aren't tracked"],
  "audit-dependencies": ["audit dependencies", "check for outdated packages", "find unpinned package versions"],
  "suggest-agents": ["what agents do i need", "which agent should handle this", "suggest agents for my task"],
  "plan-task": ["set up my whole project", "get this repo production ready", "do everything needed to ship", "build and deploy my app"],
}

export interface Classification {
  skill: string
  score: number
  margin: number
}

type LoadState = "unloaded" | "ready" | "unavailable"
let state: LoadState = "unloaded"
let tokenizerPromise: Promise<any> | null = null
let matrix: Float32Array | null = null
let dim = 0
let centroids: Record<string, number[]> = {}

// Resolves a real, directory-on-disk parent path containing
// <parent>/potion-base-8M/{config.json, tokenizer.json, ...}. Returns null
// if unavailable, in either mode — never throws, since this must degrade
// to "no opinion" for every caller.
async function resolveModelParentDir(): Promise<string | null> {
  if (isCompiled) {
    try {
      // Dynamic import, gated on isCompiled, exactly like
      // apps/supervisor/index.ts's SERVICE_STARTERS pattern — verified
      // directly before writing this: under plain `bun run`/`bun test`
      // (isCompiled false), this line never executes and the target
      // module (with its static `with { type: "file" }` imports) is never
      // loaded, so a missing models/ directory can't break dev mode or
      // tests. `bun build --compile` DOES need the files to exist at
      // build time to embed them — a documented prerequisite (`bun run
      // fetch-model` before `bun run build`), not a runtime concern.
      const { EMBEDDED_FILES } = await import("./intent-classifier-embedded-assets")
      const parent = mkdtempSync(path.join(tmpdir(), "orchestrai-model-"))
      const modelDir = path.join(parent, MODEL_ID)
      for (const [name, embeddedPath] of Object.entries(EMBEDDED_FILES)) {
        await Bun.write(path.join(modelDir, name), Bun.file(embeddedPath))
      }
      return parent
    } catch {
      return null
    }
  }

  // Dev mode: import.meta.dir is a real directory here (this file is never
  // itself the compiled entry point), so a plain, un-embedded filesystem
  // check against the repo's own models/ directory is sufficient — no
  // asset embedding involved at all on this path.
  const devModelsDir = path.join(import.meta.dir, "..", "..", "models")
  if (!existsSync(path.join(devModelsDir, MODEL_ID, "model.safetensors"))) return null
  return devModelsDir
}

// safetensors format: [8-byte LE u64 header length][JSON header][raw tensor bytes]
function parseSafetensors(buf: Uint8Array): { matrix: Float32Array; dim: number } {
  const headerLen = Number(new DataView(buf.buffer, buf.byteOffset, 8).getBigUint64(0, true))
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + headerLen)))
  const key = Object.keys(header).find((k) => k !== "__metadata__")!
  const { shape, data_offsets, dtype } = header[key]
  if (dtype !== "F32") throw new Error(`intent-classifier: unexpected safetensors dtype ${dtype}`)
  const start = 8 + headerLen + data_offsets[0]
  const raw = buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + (data_offsets[1] - data_offsets[0]))
  return { matrix: new Float32Array(raw), dim: shape[1] }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

async function ensureLoaded(): Promise<boolean> {
  if (state === "ready") return true
  if (state === "unavailable") return false

  try {
    const parentDir = await resolveModelParentDir()
    if (!parentDir) {
      state = "unavailable"
      return false
    }

    // Imported dynamically too: keeps this whole dependency out of the
    // module graph entirely for any caller that never ends up needing the
    // fallback (detectSkill() only reaches this after every keyword branch
    // misses) — the Orchestrator's startup cost is unaffected either way.
    const { AutoTokenizer, env } = await import("@huggingface/transformers")
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = parentDir

    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID)
    tokenizerPromise = Promise.resolve(tokenizer)

    const weightsBuf = new Uint8Array(
      await Bun.file(path.join(parentDir, MODEL_ID, "model.safetensors")).arrayBuffer(),
    )
    const parsed = parseSafetensors(weightsBuf)
    matrix = parsed.matrix
    dim = parsed.dim

    const embed = (text: string): number[] => {
      const ids = Array.from(tokenizer.encode(text) as number[])
      const sum = new Array(dim).fill(0)
      let n = 0
      for (const id of ids) {
        const off = id * dim
        if (off + dim > matrix!.length) continue
        for (let i = 0; i < dim; i++) sum[i] += matrix![off + i]
        n++
      }
      return n ? sum.map((x) => x / n) : sum
    }

    centroids = Object.fromEntries(
      Object.entries(SKILL_EXAMPLES).map(([skill, examples]) => {
        const vecs = examples.map(embed)
        const c = new Array(dim).fill(0)
        for (const v of vecs) for (let i = 0; i < dim; i++) c[i] += v[i] / vecs.length
        return [skill, c]
      }),
    )

    state = "ready"
    return true
  } catch (err) {
    console.error("[intent-classifier] Failed to load, falling back to keyword-only routing:", err)
    state = "unavailable"
    return false
  }
}

export async function isClassifierAvailable(): Promise<boolean> {
  return ensureLoaded()
}

// Returns null when unavailable OR when confidence is below MIN_SCORE —
// callers treat null uniformly as "no opinion" and keep their existing
// default behavior unchanged either way.
export async function classifyIntent(text: string): Promise<Classification | null> {
  const ready = await ensureLoaded()
  if (!ready || !matrix) return null

  // Strip the target-path clause before embedding — a real task's full
  // text always includes one ("... at C:\my-app"), and feeding that whole
  // string in was measured to dilute the mean-pooled embedding enough to
  // drop a clear, correct match below threshold. See stripPathPhrases()'s
  // own comment in packages/shared/index.ts for the exact numbers.
  const stripped = stripPathPhrases(text)
  const queryText = stripped.length > 0 ? stripped : text

  const tokenizer = await tokenizerPromise!
  const ids = Array.from(tokenizer.encode(queryText) as number[])
  const sum = new Array(dim).fill(0)
  let n = 0
  for (const id of ids) {
    const off = id * dim
    if (off + dim > matrix.length) continue
    for (let i = 0; i < dim; i++) sum[i] += matrix[off + i]
    n++
  }
  const vec = n ? sum.map((x) => x / n) : sum

  const ranked = Object.entries(centroids)
    .map(([skill, c]) => ({ skill, score: cosine(vec, c) }))
    .sort((a, b) => b.score - a.score)

  const top = ranked[0]
  const second = ranked[1]
  if (!top) return null
  const margin = top.score - (second?.score ?? 0)
  if (top.score < MIN_SCORE || margin < MIN_MARGIN) return null

  return { skill: top.skill, score: top.score, margin }
}
