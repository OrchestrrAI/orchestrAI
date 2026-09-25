---
id: 127-write-tests-names-test-file-location
title: write-tests Harness Is Told Where Its Test File Will Be Written
area: testing-agent
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-24
updated: 2026-09-24
approved_by: Muhamad-Yussuf
approved_on: 2026-09-24
implemented_on: 2026-09-24
amends:
  - 081-testing-write-tests-skill
supersedes: []
superseded_by: []
related:
  - 126-write-tests-description-grounded-routing
---

# Spec: write-tests Harness Is Told Where Its Test File Will Be Written

> Status history: **APPROVED by Muhamad-Yussuf on 2026-09-24** ("can you
> enhance that to mention the file ?"). IMPLEMENTED and VERIFIED the same day.


## Purpose

During `specs/126`'s live check, a previewed `src/server.test.ts`
imported its source as `"../src/server"`. That resolves correctly, but it
shows the model was guessing: the harness prompt names the source file
and never says where the test file itself will be written, so every
relative import is inferred rather than known.

## Verified Current State

- `handleWriteTestsSkill()` (`packages/agents/testing/index.ts`) already
  computes `testRelativePath = deriveTestFilePath(source, runner)` —
  deterministically, before calling the harness — but never passes it.
- `buildWriteTestsSystemPrompt()` (`packages/agents/testing/llm-harness.ts`)
  receives only the project root, source path, source content and runner.

## Proposed Behavior

1. `runWriteTestsHarness()` takes a required `testRelativePath`; the
   caller passes the value it already computes.
2. The system prompt states where the test file will be written and,
   for JS/TS runners, the exact import specifier for the source file
   relative to that location (TS extensions stripped, forward slashes,
   `./` prefix). For `pytest`, it states the location only — Python
   imports are module-based, not relative file paths.
3. The specifier is computed by a pure exported helper,
   `sourceImportSpecifier()`, so it is unit-testable.

## Safety and Compatibility Constraints

- The output path stays 100% deterministic and never model-suppliable —
  the prompt only reports the path the caller already chose.
- No change to grounding, retries, the tool allow-list, approval, or the
  fingerprint recheck.

## Non-Goals

- Rejecting a response whose import differs from the suggested one — the
  specifier is guidance, not a validated constraint.

## Acceptance Criteria

- [x] Explicit approval recorded before implementation.
- [x] `testRelativePath` is passed from the caller into the prompt.
- [x] `sourceImportSpecifier()` unit tests: sibling file → `./name`,
  nested/parent directories, Windows backslash input, `.js` kept, `pytest`
  → `null`.
- [x] `bun run typecheck` 0 errors; `bun test` no regressions.
- [x] Live: a `write-tests` preview for `src/server.ts` imports it as
  `./server`.

## Verification Record (2026-09-24)

- Unit: 7 new tests in `packages/agents/testing/llm-harness.test.ts`
  (`sourceImportSpecifier()` cases plus both prompt shapes); the 3
  existing `runWriteTestsHarness` tests pass the new required field.
- `bun run typecheck` 0 errors; `bun test` (with `ORCHESTRAI_MCP_PORT=5999`,
  since the user's own stack held 3006) 1497 pass / 2 skip / 0 fail.
- Live, isolated headless stack on ports 5000–5008 (`ORCHESTRAI_PERSIST=0`),
  gemini, fixture `C:\Users\moham\test-target-project`: "write tests for
  src/server.ts" → preview for `src/server.test.ts` imports
  `import app from "./server"` (previously `"../src/server"`). Rejected;
  fixture `src/` unchanged.
