---
id: 134-devops-harness-sees-the-request
title: DevOps Parameter Harnesses See the User's Request, So Stated Values Like a Port Are Honored
area: llm-harness
change_type: fix
status: implemented
verification: verified
created: 2026-09-25
updated: 2026-09-25
approved_by: Muhamad-Yussuf
approved_on: 2026-09-25
implemented_on: 2026-09-25
amends:
  - 042-llm-harness-devops
supersedes: []
superseded_by: []
related:
  - 040-approval-preview-content-diff
  - 077-agent-enabled-means-llm-on-by-default
  - 130-tui-dashboard-parity
---

# Spec: DevOps Parameter Harnesses See the User's Request, So Stated Values Like a Port Are Honored

> Status: **APPROVED by Muhamad-Yussuf on 2026-09-25** ("ok go ahead in them all"), together with specs 133–136. **IMPLEMENTED and VERIFIED live** the same day — see `verification.md`.

## Purpose

Found live during spec 130 phase 1: "dockerize my bun app on port 4000"
produced an approval preview with `port: 3000`. The user stated the value
explicitly, and the preview silently replaced it. The human can still
reject, but a demo that asks for port 4000 and gets 3000 looks broken, and
a reviewer might approve without noticing.

## Verified Current State

- **Deterministic path.** `extractPort(text)`
  (`packages/agents/devops/index.ts:173`) reads `port <n>` from the task
  text, defaulting to 3000. With the harness off, "port 4000" gives 4000.
- **Harness path (on by default, `specs/077`).** For `dockerize`, the
  harness result replaces the deterministic port:
  `{ ...deterministic.args, app_type: params.app_type, port: params.port }`
  (`index.ts:437`).
- **The harness never sees the request.** `RunHarnessBaseOptions`
  (`llm-harness.ts:359`) carries `model`, `mcpClient`, `taskId`,
  `projectRoot` and `maxRetries`, but not the task text.
  - The graph starts with `[SystemMessage(systemPrompt),
    HumanMessage("Begin.")]` (`llm-harness.ts:300`).
  - `buildDockerizeSystemPrompt()` (`:324`) tells the model to determine
    "the REAL application type and port this project actually uses — never
    guess", from the project files alone.
  - So an explicit request is invisible to the model, and its
    project-derived answer wins.
- **The same gap affects all four template harnesses:** `dockerize`,
  `create-ci`, `create-gitignore` and `create-compose`
  (`runDockerizeHarness`, `runCreateCiHarness`,
  `runCreateGitignoreHarness`, `runCreateComposeHarness`). None receives
  the request text; each decides only from the project.
  `runRunCommandHarness` takes an optional `hint` and is out of scope.
- **What stays deterministic (`specs/042`):** every target path
  (`app_name`, `output_path`) is never model-decided, and the templates
  themselves are deterministic.
- **What protects the write:** the preview's content is computed once and
  reused verbatim at write time (`specs/040`), and preflight and the
  fingerprint recheck guard the write (`specs/056`).

## Proposed Behavior

Pass the user's request into every DevOps template harness, so the model
honors values the user stated and still derives everything else from the
project (the choice made for this spec, over a deterministic override).

1. `RunHarnessBaseOptions` gains an optional `requestText?: string`.
   `prepareWriteActionOrHarness()` (`index.ts`) passes the task
   text for `dockerize`, `create-ci`, `create-gitignore` and
   `create-compose`.
2. When `requestText` is present, the first human message carries it
   instead of the bare "Begin.". The message is bounded in length (the
   request is truncated to a fixed cap, e.g. 2,000 characters, before
   inclusion) and clearly delimited as the user's request.
3. Each of the four system prompts gains one rule: **a value the request
   states explicitly (for example a port, app type, workflow name or extra
   ignore pattern) must be used as stated. Only values the request leaves
   unspecified are determined from the project files.** The existing "never
   guess" instruction still applies to what the request does not say.
4. Output validation is unchanged. The same Zod schemas are used, and a
   request cannot widen what a parameter may be (e.g. `port` stays a
   positive integer, and `app_type` stays within its enum).
5. With `requestText` absent (any existing caller or test), behavior is
   byte-identical to today, including the "Begin." message.

## Scope

- `packages/agents/devops/llm-harness.ts`: the option, the first message,
  and the four system prompts.
- `packages/agents/devops/index.ts`: pass the task text at the four call
  sites.
- `packages/agents/devops/llm-harness.test.ts` (and `index.test.ts` where
  call sites are covered).
- `CLAUDE.md` (a present-tense adjustment to the DevOps harness sentence),
  the worklog, and this spec's `verification.md`.

## Safety and Compatibility Constraints

- **Prompt-injection surface.** The request text is user input and is
  already the input of every other harness in this repo. Here the model
  can only return schema-validated parameters for a deterministic template.
  Its tools stay read-only (`READ_ONLY_TOOL_NAMES`, enforced at graph
  build). Target paths stay deterministic. The human still approves the
  exact previewed content. No new capability is granted.
- **Bounded input.** The request is truncated to a fixed cap before
  inclusion.
- **Fail-closed behavior is unchanged** (`specs/042`): a harness failure
  still fails the task with a named error. There is no fallback to the
  deterministic guess.
- **This is a model judgment, not a guarantee.** The model is told to use
  stated values; it is not structurally forced to. This is the accepted
  trade-off of the chosen approach, and it is why the live verification
  repeats the request.

## Out of Scope / Non-Goals

- A deterministic post-harness override of explicitly stated values
  (considered; not chosen). It can be added later as its own spec if live
  runs show the model ignoring stated values.
- `run-command`'s harness (`hint` already exists; different job).
- Any change to templates, target-path logic, preflight, fingerprints or
  approvals.
- The Documentation, Testing, Code Review and Coder harnesses.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] The four template harnesses receive the request text. With it, the
      first human message contains the (bounded) request. Without it, the
      message is exactly "Begin." as today. Unit-tested with a fake model
      that records its input messages.
- [x] Each of the four system prompts carries the "stated values win"
      rule. Unit-tested.
- [x] Live, harness on: "dockerize my bun app on port 4000" previews
      `port: 4000`, in at least 3 of 3 runs.
- [x] Live, harness on: "dockerize my bun app" (no port) still previews a
      project-derived port, as today.
- [x] Live, harness on: one `create-compose` request stating a port shows
      that port in its preview.
- [x] `bun run typecheck` 0 errors; `bun test` no regressions.
- [x] Documentation and worklog are updated.

## Verification Plan

- Unit:
  - With a fake chat model, assert the messages each harness sends, with
    and without `requestText`, including truncation at the cap.
  - Assert the prompt rule's presence in all four prompts.
  - Assert that schema validation still rejects an out-of-range port.
- Live: an isolated stack (`--only orchestrator,devops-agent`) with a real
  key, against the test fixture. Submit the requests above through
  `POST /tasks`. Record each preview's parameters in `verification.md`,
  reject every approval, and confirm the fixture's hash baseline.

## Approval Requested

Approval authorizes passing the bounded request text into the four DevOps
template harnesses and adding the "stated values win" prompt rule. It does
not authorize a deterministic override, any change to other harnesses, or
any change to templates, paths, preflight or approvals.
