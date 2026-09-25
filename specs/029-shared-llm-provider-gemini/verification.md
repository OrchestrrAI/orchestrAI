# Verification: Shared LLM Provider Factory and Gemini Support

## Status

`verified` as of 2026-08-20 — the shared provider boundary, Gemini adapter,
automated tests, typecheck, governance checks, compiled-binary build, local
fail-closed smoke tests, and all three real Gemini scenarios pass at the
provider/graph/approval boundaries. The original run below exposed a
downstream skill-dispatch correctness blocker; that blocker is
`specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md`,
now implemented, and its own live Gemini re-run
(`specs/030-authoritative-skill-dispatch-and-capability-catalog/verification.md`)
repeated these same scenarios end to end through the new dynamic capability
catalog and confirmed the fix holds under real model output. 029's
acceptance requirement to close 026 is met.

## Implemented evidence

- `packages/shared/llm-model-factory.ts` is the sole concrete provider switch
  for Anthropic, OpenAI, and Gemini. It has no feature-activation flag and
  dynamically imports adapters only from `buildChatModel()`.
- Planning's `model-factory.ts` now owns only its opt-in
  `ORCHESTRAI_LLM_HARNESS` check and delegates configuration/construction to
  the shared factory.
- `@langchain/google` is exactly pinned to `0.2.2`; Gemini imports
  `ChatGoogle` from the package's Node entrypoint, `@langchain/google/node`.
- The API key is passed directly as `apiKey`. Runtime code does not set
  `GOOGLE_API_KEY`, `GEMINI_API_KEY`, or any global process configuration.
- Gemini requires an explicit `ORCHESTRAI_LLM_MODEL`; missing model or invalid
  provider configuration is caught by Planning and fails closed to the
  existing zero-step response.

## Automated evidence

- `bun test`: 181 passed, 0 failed, 337 expectations across 21 files.
- `bun run typecheck`: exited 0.
- `bun run specs:check`: passed for 29 specs.
- Eleven new focused tests cover Gemini configuration, required model and key,
  unknown-provider rejection, secret non-disclosure, unchanged Anthropic and
  OpenAI defaults, Planning-only activation, and construction of a
  `bindTools()`-capable `ChatGoogle` object with the configured key never
  leaking into any request URL. The original version of this test asserted
  zero `fetch()` calls during construction; that passed on Windows (this
  spec's original dev environment) but failed on GitHub Actions' Linux
  runner — `@langchain/google`'s underlying `google-auth-library` performs
  its own platform/credential-type detection when resolving `ChatGoogle`'s
  `platform`/`hasApiKey()`, and that detection triggers a real `fetch()` on
  some platforms even with an explicit `apiKey` supplied. That is a
  third-party library implementation detail this repository's code does not
  control, not a property this checkpoint can honestly guarantee, so the
  assertion was corrected to the property that actually matters — the
  configured key is never exposed in a request — rather than loosened
  silently. See `packages/shared/llm-model-factory.test.ts` for the fixed
  test and its inline explanation.
- The existing 12 graph tests continue to prove that only `git_status` and
  `analyze_project` are bound, retry behavior is bounded, and invalid output
  fails closed.

## Compiled-binary and smoke evidence (Windows)

- `bun run build` completed successfully, bundling 1,372 modules.
- Before 029: 146,875,392 bytes.
- After the pinned Google adapter: 147,458,048 bytes.
- Exact delta: +582,656 bytes (about +0.56 MiB).
- The compiled Planning service reached `/healthz` with the harness unset and
  reported `LLM harness: disabled (default)`.
- With the harness enabled, provider `gemini`, a fake key, and no model, the
  compiled service remained healthy, emitted the explicit missing-model
  warning, and reported `enabled but invalid`.
- Submitting `build and deploy my bun app` in that invalid state completed
  with zero executable steps and the standard no-actionable-steps message.
  The fake key appeared in neither the task result nor the startup warning.

## Live Gemini evidence — 2026-08-16

- `gemini-2.5-flash` first failed closed because Google no longer makes that
  model available to new users. No tool call or fallback occurred.
- After selecting `gemini-3.5-flash-lite`, Planning called both shared
  read-only MCP tools, received correlated successful results, and emitted a
  valid plan whose descriptions incorporated concrete observations.
- The out-of-scope request completed with zero steps, zero children, and zero
  tool calls.
- The deliberate write plan stopped at the real `actionId`-bound approval
  gate. The target hash/timestamp were unchanged before the decision and after
  rejection. No write was approved during the controlled scenario.
- Sanitized selected raw events are preserved in
  `live-events.sanitized.ndjson`. They include both Planning tool-call pairs,
  the controlled `approval-required`/`approval-resolved` pair, and the
  out-of-scope run boundaries. No API key or tool-result body is present.

The credential previously pasted into chat was not used, stored, logged, or
copied into any repository file.

## Verification blocker found live

The LLM correctly named a downstream step `git-status`, but its description
mentioned the observed `Dockerfile`. DevOps re-detected the combined child
text as `dockerize`, presenting a `create_dockerfile` approval even though the
Orchestrator task still said `skill: git-status`. The approval gate prevented
mutation and the action was rejected, but this violates plan-step semantic
integrity. Keep both 026 and 029 `partial` until that issue has its own
approved fix and regression evidence.

### Resolved — 2026-08-20

`specs/030-authoritative-skill-dispatch-and-capability-catalog/spec.md` is
that approved fix: the Orchestrator now sends an authoritative
`selectedSkill` on every dispatch, and every agent executes exactly that
skill rather than re-deriving one from description text. Its own live
Gemini re-run repeated this exact scenario shape (a plan step whose
description could plausibly redirect it) and confirmed each child executed
the skill the plan actually named. See
`specs/030-authoritative-skill-dispatch-and-capability-catalog/verification.md`
for the full record, including the raw event capture.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

See specs/051-planning-retirement-and-required-key/verification.md for the relocated narrative covering this checkpoint.

See specs/026-llm-harness-langgraph-planning/verification.md for the relocated narrative covering this checkpoint.
