// @ts-nocheck
// specs/020-semantic-intent-fallback/spec.md
//
// `@ts-nocheck` above is required, not cosmetic: `bun run typecheck` must
// pass whether or not `bun run fetch-model` has been run, but tsc's own
// module resolution needs these files to exist on disk to typecheck this
// file's imports, regardless of the fact that they're only ever reached
// via a runtime-gated dynamic import elsewhere (confirmed: neither
// tsconfig `exclude` — still resolved as a reachable dependency — nor
// ambient `declare module` wildcards — don't apply to relative-path
// specifiers, only bare/non-relative ones — suppress this).
//
// Compiled-mode-only. This module must NEVER be statically imported by
// intent-classifier.ts — only ever via a runtime-gated dynamic
// `await import(...)`, exactly like apps/supervisor/index.ts's
// SERVICE_STARTERS pattern. Verified directly before writing this file: a
// static `with { type: "file" }` import of a missing file throws at
// module-load time even under plain `bun run` (not just `--compile`),
// which would break graceful degradation for anyone who hasn't run
// `bun run fetch-model` yet. Dynamic import is lazy — this module (and its
// static file imports below) is only ever loaded when isCompiled is true,
// so `bun test`/`bun run orchestrator` never touch it and never require
// these files to exist. `bun build --compile`, in contrast, DOES need
// these files to exist at build time — a deliberate, documented
// prerequisite (run `bun run fetch-model` before `bun run build` for the
// classifier to be included), not a violation of runtime graceful
// degradation, which is about `bun test`/dev-mode behavior only.
import configFile from "../../models/potion-base-8M/config.json" with { type: "file" }
import tokenizerFile from "../../models/potion-base-8M/tokenizer.json" with { type: "file" }
import tokenizerConfigFile from "../../models/potion-base-8M/tokenizer_config.json" with { type: "file" }
import specialTokensFile from "../../models/potion-base-8M/special_tokens_map.json" with { type: "file" }
import weightsFile from "../../models/potion-base-8M/model.safetensors" with { type: "file" }

export const EMBEDDED_FILES = {
  "config.json": configFile,
  "tokenizer.json": tokenizerFile,
  "tokenizer_config.json": tokenizerConfigFile,
  "special_tokens_map.json": specialTokensFile,
  "model.safetensors": weightsFile,
} as const
