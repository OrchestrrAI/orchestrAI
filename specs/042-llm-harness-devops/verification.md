## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/042-llm-harness-devops/spec.md` (implemented, **verified**) — the
second of the per-agent LLM roadmap, one step up in stakes from
Documentation: DevOps's generated files are actually executed
(`docker build`, a real CI pipeline), where Documentation's are read.
This directly shaped a **deliberately narrower design than `041`'s**:
the LLM here decides *parameters* fed into the existing, unmodified,
already-reviewed deterministic MCP templates
(`packages/mcp/index.ts`) — it never authors Dockerfile/CI-YAML/
compose-YAML content itself. Those four template functions are
untouched by this checkpoint, confirmed by a real `git diff --stat`
check, not just described. Set `ORCHESTRAI_DEVOPS_LLM_HARNESS=1` (one
flag gating all four write skills together) alongside the shared LLM
variables every other harness uses.

Grounded in real, evidence-confirmed gaps, read directly from
`prepareWriteAction()`, not assumed: `extractAppType()` guesses the app
type from the **task text's own wording**, defaulting to `"bun"`
unconditionally when nothing's named — wrong, silently, for any project
whose language the request doesn't happen to mention. `create-ci`'s
`include_docker` was **hardcoded `false` unconditionally**, even when a
Dockerfile already exists. `create-compose` always produced **exactly
one hardcoded service**, with no detection of a real database/cache
dependency that would warrant a second one.

**One new tool added — the first case of the "increase tools where the
implementation shows a real need" principle actually being exercised**:
`read_project_file`, added to `DevOpsMcpClient`'s `REQUIRED_TOOLS`
(previously DevOps only had `analyze_project`/`git_status` — structural
checks, not real file content). Justified directly by the gaps above,
which need to read `package.json`/`requirements.txt`'s real dependencies,
not just presence/absence checks. Three read-only tools bound total
(`analyze_project`, `git_status`, `read_project_file`), one
structurally-enforced allow-list, no write-capable tool ever bound — the
same enforcement mechanism `specs/026`/`041` already use. Every target
path (`app_name`, `output_path`) stays exactly as deterministic with the
flag on as off — the model can only ever influence *what* gets written
into an already-fixed *where*.

Four entry points share one graph core, each producing one validated
JSON object matching that skill's own parameter shape
(`{ app_type, port }` for `dockerize`; `{ app_type, include_docker }`
for `create-ci`; `{ project_type, extras? }` for `create-gitignore`;
`{ services }` for `create-compose`) — invalid JSON, a wrong shape, or
an invalid enum value triggers bounded retry-with-feedback naming
exactly what was wrong. Same fail-closed precedent as every prior LLM
checkpoint, restated deliberately for a third time: once the flag is
active, a misconfigured key or a run failure fails the task closed,
never falls back to `extractAppType()`'s guess or the hardcoded compose
service.

**Live-verified against a real Gemini deployment, with a directly
contrasted before/after**: a scratch Python project (`requirements.txt`,
a `psycopg2-binary` dependency, a real `app.run(port=5000)` call) with
**no language named in the request text** — flag on: `dockerize`
correctly returned `app_type: "python"`, `port: 5000`; flag off, same
project, real compiled binary: the exact old `app_type: "bun"`,
`port: 3000` — proof both that the regression is byte-identical and
exactly what the fix changes. `create-ci` correctly returned
`include_docker: true` once a real Dockerfile existed, closing the
hardcoded-`false` gap. `create-compose` correctly detected the real
`psycopg2-binary` dependency and added a genuine `postgres:16` service
alongside the app's own — the deterministic path never does this. All
three approved writes matched their previews exactly (byte comparison).
One incidental finding, confirmed unrelated to this checkpoint via the
zero-diff check on `packages/mcp/index.ts`: `create_dockercompose`'s own
template has a pre-existing YAML indentation quirk (a `.trim()` on a
multi-line block strips the first service's leading indent) — flagged
for a future, separately-scoped fix, not addressed here. Binary size
delta: **+14,336 bytes**, zero new dependency.

See specs/103-deep-project-analysis/verification.md for the relocated narrative covering this checkpoint.

See specs/079-phase-a-connect-orphaned-tools/verification.md for the relocated narrative covering this checkpoint.

See specs/081-testing-write-tests-skill/verification.md for the relocated narrative covering this checkpoint.

See specs/082-code-review-agent/verification.md for the relocated narrative covering this checkpoint.

See specs/101-per-agent-tool-access-expansion/verification.md for the relocated narrative covering this checkpoint.

See specs/097-chat-answer-and-plan-description-honesty/verification.md for the relocated narrative covering this checkpoint.

See specs/050-init-per-agent-llm-toggles/verification.md for the relocated narrative covering this checkpoint.
