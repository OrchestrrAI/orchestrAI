# Verification — 133 supervisor names the file in every edit-file step

## What changed (2026-09-25)
- `SKILL_DESCRIPTIONS["edit-file"]` (`apps/orchestrator/supervisor-graph.ts`)
  now says:
  - it handles ONE existing file;
  - the step description MUST begin `"edit <relative/path.ext>: <what to
    change>"`, or the step fails;
  - a change to two or more files is ONE `edit-files` step.
- `SKILL_DESCRIPTIONS["edit-files"]` names itself as the choice whenever a
  request changes or creates more than one file.
- Coder's `edit-file` Agent Card description (read by the router,
  specs/121) now says "ONE existing file … For two or more files, use
  edit-files instead." It is 224 bytes, under the 300-byte
  `MAX_SKILL_DESCRIPTION_BYTES` cap, so it is never truncated.
- Coder's parser, its refusal text, the child-text format, the
  duplicate-write key and the dispatch `target` meaning are unchanged.

## Automated
- `apps/orchestrator/supervisor-graph.test.ts`: the new wording in both
  descriptions, and its presence in the system prompt's valid-skills line.
- `packages/agents/coder/index.test.ts`: the card wording, and that it fits
  the byte cap.
- `packages/shared/agent-card-skill-collision.test.ts` still passes.
- `bun run typecheck` 0 errors; full `bun test` in the commit below.

## Live check
Isolated stack on ports 5000–5008 (`--only
orchestrator,devops-agent,coder-agent`, `ORCHESTRAI_PERSIST=0`, gemini key
from the fixture's config) against `C:\Users\moham\test-target-project`.

| Request | Result |
|---|---|
| The exact spec 130 phase 2 failure, "Edit two files in <path>: add … at the top of src/config.ts, and … at the top of src/server.ts", 3 runs | 3/3 routed straight to `edit-files`: one proposal editing `src\config.ts` and `src\server.ts`. None failed with "No file named" |
| A mixed request forcing a plan ("…comment at the top of src/config.ts and … src/server.ts, and also create a .gitignore for bun"), 2 runs | 2/2 planned step 1 `[edit-files] "Add // config module at the top of src/config.ts and // server entry at the top of src/server.ts"` and step 2 `[create-gitignore]`, dispatched concurrently |
| "edit src/config.ts: add a one-line comment // config module at the top" | Routed to `edit-file`; preview targets `src\config.ts` |
| specs/120 regression: "Prepare this project for release - create a .gitignore and a GitHub Actions CI workflow" | Both writes dispatched concurrently; `pending-batch` `eligible: true`; `g` in the TUI opened "Grouped review — 2 parallel writes" with both branches |

Every approval was rejected, and the fixture's SHA-256 snapshot matched
at the end.

### The original failure's `target` values
They could not be recovered. That run had persistence off, and the
supervisor's decision `auditLog` is returned only inside the graph run; the
Orchestrator never logs or stores it.

The code settles the question the spec raised:
- The duplicate-write refusal is reserved per branch inside a concurrent
  batch too (`supervisor-graph.ts:680-688`).
- Both `edit-file` children were dispatched.
- So the model must have passed two different `target` strings, not the
  project root twice.

The spec's analysis was therefore right about the rule ("same target is
refused"). The live failure simply didn't hit it. After this change the
question is moot for multi-file requests: none of the 5 multi-file runs
produced an `edit-file` step.

## Found, not fixed
**A step's child text leaks the parent's other work into `edit-files`.**
- In both mixed-request plans, the `edit-files` proposal also edited
  `.gitignore`, which was the other step's job.
- A child's text is `` `${skill}: ${description} — ${parentTask.text}` ``
  (`apps/orchestrator/index.ts:1237`), and Coder's free-form harness took
  the whole parent request as its instruction.
- Safety held: the two branches share `.gitignore`, so specs/120's gate
  answered `eligible: false`, and each branch kept its own individual
  approval. Nothing could write the file twice without a separate review.
- But it spoils the demo scene's grouped review for mixed requests.
- Fixing it (e.g. marking the parent text as context only, or scoping
  `edit-files` to the step description) changes the child-text contract
  shared by every agent, so it needs its own spec.
