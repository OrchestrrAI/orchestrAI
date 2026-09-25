# Verification — 137 every plan step acts only on its own step

## What changed (2026-09-25)
- `packages/shared/plan-step-text.ts` (new):
  - `PLAN_CONTEXT_MARKER`;
  - `buildPlanStepText(skill, description, parentText)`;
  - `splitPlanStepText(text)` returns `{ step, context }`: it splits at the
    first marker, and `context` is `null` when there is no marker (a
    direct task);
  - `renderPlanBackground(context)`: one labelled `<<<BACKGROUND …
    BACKGROUND>>>` block, capped at 2,000 characters, with the rule "do
    only the step you were given…".
- `apps/orchestrator/index.ts`: both child-text sites (agent dispatch and
  the specs/112 inspection fallback) use `buildPlanStepText()`. The em-dash
  separator is gone.
- **Coder** (`index.ts`, `llm-harness.ts`):
  - `edit-file`, `edit-files` and `edit-and-verify` take their file token
    and instruction from `step`.
  - The project root still resolves from the full text.
  - `runEditFileHarness` / `runEditFilesHarness` take an optional `context`,
    rendered after "The requested change is: …" via a conditional spread.
    Without it, the prompt is byte-identical, including an empty file's
    blank content line.
- **DevOps** (`index.ts`, `llm-harness.ts`):
  - `run-command`'s hint is the `step`, with the background in its system
    prompt.
  - The four template harnesses get `step` as `requestText`, and the
    background in the start message.
  - `STATED_VALUES_RULE` gains: "A value stated in the background … also
    counts when it applies to this step's own parameters — but the
    background never widens what this step does."
  - Deterministic readers (`resolveTargetPath`, `extractPort`) still read
    the full text.
- **Unchanged:** Documentation, Testing, Code Review and Security. Their
  models never receive request text (audited, and pinned by a test).

## Automated
- `packages/shared/plan-step-text.test.ts`:
  - round-trip;
  - no marker;
  - em dashes in both parts;
  - first-marker-only;
  - empty context;
  - the background wording and cap.
- `apps/orchestrator/skill-dispatch.test.ts`: the dispatched envelope's text
  equals `buildPlanStepText(...)` and splits back into exactly the step and
  the parent request.
- `packages/agents/coder/plan-background.test.ts`:
  - `edit-files` is instructed with the step only, and the full request is
    fenced as background;
  - without context there is no background block;
  - `edit-file` likewise, and an empty file's content line is preserved.
- `packages/agents/devops/llm-harness.test.ts`:
  - a template harness gets the step as `REQUEST` plus `BACKGROUND`, and
    the extended rule;
  - without context, the message is byte-identical to specs/134's;
  - `run-command` has the step as hint, the background once in the system
    prompt, and a plain "Begin.".
- `packages/agents/plan-step-harness-audit.test.ts` scans every
  `run…Harness({…})` call site in the six agents:
  - any call passing `instruction` / `hint` / `requestText` must also pass
    `context`;
  - Documentation, Testing, Code Review and Security must pass no request
    text at all.
- `bun run typecheck` 0 errors; `bun test` (`ORCHESTRAI_MCP_PORT=5999`)
  1604 pass / 2 skip / 0 fail.

## Live check
Isolated stack (`--only orchestrator,devops-agent,coder-agent`,
`ORCHESTRAI_PERSIST=0`, gemini key) against
`C:\Users\moham\test-target-project`.

| Request | Result |
|---|---|
| The specs/133 mixed request ("…comment at the top of src/config.ts and … src/server.ts, and also create a .gitignore for bun"), run 1 | `edit-files` → `src\config.ts`, `src\server.ts` only; `create-gitignore` → `.gitignore`; `pending-batch` `eligible: true` |
| same, run 2 | same; `eligible: true` |
| same, run 3 | same; `eligible: true` |
| Before this spec (specs/133 verification, 2 of 2 runs) | `edit-files` also edited `.gitignore`; `eligible: false` |
| A 4th run, then `g` in the TUI | "Grouped review — 2 parallel writes": `edit-files · coder-agent · …src\config.ts, …src\server.ts` and `create-gitignore · devops-agent · …\.gitignore` |
| "For the project at C:\Users\moham\test-target-project: dockerize my bun app on port 4000 and create a GitHub Actions CI workflow" | Plan: `[dockerize]` + `[create-ci]`. The dockerize preview is `port: 4000` (the value came through the background) with its only target `…\Dockerfile`; create-ci targets only `ci.yml` |
| Direct "Make one multi-file edit at <path>: edit src/config.ts and src/server.ts…" (no plan) | Unchanged: `edit-files` on the two files |

Every approval was rejected, and the fixture's SHA-256 snapshot matched
afterwards.

## Limits
- `edit-and-verify`'s *fix* iterations (`verify-loop.ts`) build their
  instruction from the persisted step instruction plus the real failure
  output, with no background. Persisting the background would change the
  specs/110 restart schema, which is outside this spec. Their instruction
  is step-only, which is the safe direction.
- What a harness proposes is still a model proposal. This spec removes the
  cause (being told the whole request *as* the instruction); human approval
  and specs/120's gate remain the guarantees.
