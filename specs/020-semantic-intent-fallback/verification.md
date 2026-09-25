## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

The semantic fallback (`specs/020-semantic-intent-fallback/spec.md`, implemented) only ever runs when every keyword branch above misses — it never overrides a keyword match. It uses `minishlab/potion-base-8M` (Model2Vec static embeddings distilled from a real sentence transformer: tokenize → look up one vector per token → mean-pool → cosine-similarity against a small hand-written example set per skill — no inference engine, no network call, no LLM). A classification is only returned when both its top score (`>= 0.30`) and its margin over the runner-up (`>= 0.05`) clear threshold; otherwise `classifyIntent()` returns `null` and the existing `plan-task` default applies unchanged. `plan-task` is itself one of the classifier's competing arms, not just the fallback-of-last-resort, so genuinely broad/plan-shaped language still lands there on its own merits. The classifier may select write-capable skills — this is deliberate; the approval gate (unchanged, still fully deterministic, keyed on skill not on how it was chosen) is the safety boundary, not skill restriction. The model weights (~30 MB) are fetched by `bun run fetch-model` into a gitignored `models/` directory (checksum-verified, never committed) and are embedded into the compiled binary at build time via a runtime-gated dynamic-import pattern (`packages/shared/intent-classifier-embedded-assets.ts`, mirroring `apps/supervisor/index.ts`'s `SERVICE_STARTERS`); with the model absent, `detectSkill()` degrades to keyword-only behavior byte-identically, and `bun test`/`bun run typecheck` both still pass. A task's own target-path clause is stripped (`stripPathPhrases()` in `packages/shared/index.ts`) before embedding — leaving it in was found to dilute the mean-pooled vector below threshold for otherwise-confident matches.

There are focused Bun tests for shared target-path resolution (including the
false-positive path-parsing fallback), the shared task-envelope
parser/IDs/approval/A2A-client contracts, the MCP server factory, DevOps
audit/result-size bounds, and Orchestrator/Planning keyword routing
(`apps/orchestrator/detect-skill.test.ts`,
`packages/agents/planning/skill-plan-task.test.ts`). There is also
`packages/shared/strip-path-phrases.test.ts` (7 tests, path-clause
stripping for the semantic fallback — see below) and a semantic-fallback
`describe` block inside `detect-skill.test.ts` itself, whose cases use
`test.skipIf(!modelAvailable)` so they skip cleanly rather than fail when
`bun run fetch-model` hasn't been run. `bun test` currently reports 138
passed, 0 failed, 211 expectations across 14 files with the model present
(CI runs without it, so those specific cases skip there — the rest of the
suite, including a test asserting `detectSkill()` never throws regardless
of classifier state, is unaffected either way). There are
two CI workflows: `.github/workflows/ci.yml` (install/typecheck/test on
every push and PR to `main`) and `.github/workflows/build-binaries.yml`
(builds and smoke-tests the standalone binary natively on both Windows and
Linux runners, `main`-push and manual-dispatch only — see
`specs/019-cicd-recreate-and-binary-builds/spec.md`). There is no broader lint
configuration.

- `specs/020-semantic-intent-fallback/spec.md` (implemented, live-verified) added
  a local semantic fallback to `detectSkill()` — keyword matching stays
  first and unchanged; `minishlab/potion-base-8M` (Model2Vec static
  embeddings, no inference engine, no network) is consulted only when every
  keyword branch misses, gated by both a score and a margin threshold. Not
  an LLM; distinct from the separate "LLM-based routing" tier
  `specs/054-capability-driven-llm-routing/spec.md` later added below it
  in `detectSkill()`'s own resolution order. `bun run fetch-model` is optional everywhere
  except before `bun run build` if the compiled binary should include it;
  `models/` stays gitignored and out of the repo. One accepted cosmetic
  limitation: importing `@huggingface/transformers` triggers a harmless
  `onnxruntime-node` stderr warning on process start (backend
  auto-registration side effect; no ONNX inference path is ever actually
  used or exercised) — see that spec's Verification Results.

See specs/026-llm-harness-langgraph-planning/verification.md for the relocated narrative covering this checkpoint.

See specs/017-standalone-binary-distribution/verification.md for the relocated narrative covering this checkpoint.

See specs/016-orchestrai-supervisor/verification.md for the relocated narrative covering this checkpoint.

See specs/054-capability-driven-llm-routing/verification.md for the relocated narrative covering this checkpoint.
