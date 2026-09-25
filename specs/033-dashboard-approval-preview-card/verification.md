# Verification: Structured Dashboard Approval-Preview Card

## Status

`verified` as of 2026-08-21 — implemented, live-verified against real
`input-required` tasks for all six write-capable skills, raw-JSON output
confirmed byte-identical to pre-change behavior, no console errors.

## Implemented evidence

- `apps/orchestrator/index.ts`'s dashboard `<style>` block gained
  `.approval-card`/`.approval-row`/`.approval-target`/`.approval-params`/
  `.approval-risks`/`.approval-actionid`/`.approval-rawtoggle` rules.
- The modal markup gained `<div id="modal-approval">` (the structured
  card) and a `Show raw JSON` / `Hide raw JSON` toggle button, both
  hidden by default.
- New client-side functions: `escapeHtml()`, `renderApprovalCard()`,
  `toggleRawJson()`. `view(id)` now branches: for `input-required` tasks
  it renders the card, hides the raw `<pre>`, and shows the toggle; for
  any other status the card and toggle stay hidden and the raw `<pre>` is
  shown exactly as before — unconditionally, not gated behind any new
  flag.
- `renderApprovalCard()` reads only fields already present on
  `ApprovalPreview` (`target`, `toolName`/`executable`/`argv`,
  `parameters`, `overwrite`, `risks`, `actionId`, `kind`) — no new field is
  requested from or sent to the server. `target` is rendered directly from
  `approval.target`, never reconstructed from `parameters`.

## Automated evidence

- `bun test`: 277 passed, 0 failed, 499 expect() calls (unchanged from
  before this change — a rendering-only change adds no new automated
  test surface of its own, per the spec's own Verification Plan).
- `bun run typecheck`: 0 errors.
- `bun run specs:check`: passed for 33 specs.

## Live evidence

Full `bun run orchestrai --project <fixture>` stack, real browser
(`read_page`/`javascript_tool`/`computer` against the live dashboard),
fixture reset to clean before and after every run.

### Card renders correctly for all six write-capable skills

| Skill | Target rendered | Card visible |
|---|---|---|
| `dockerize` | `...\test-target-project\Dockerfile` | yes |
| `create-gitignore` | `...\test-target-project\.gitignore` | yes |
| `create-ci` | `...\test-target-project\.github\workflows\ci.yml` | yes |
| `create-compose` | `...\test-target-project\docker-compose.yml` | yes |
| `generate-readme` | `...\test-target-project` | yes |
| `run-tests` | `...\test-target-project` | yes |

Each submitted as a real task against the running stack, each reached
`input-required` with a real server-issued `actionId`, each rendered via
the actual `renderApprovalCard()` function (not a mock), confirmed by
reading `.approval-target`'s live `textContent` and the presence of the
`.approval-risks` list in the rendered DOM.

### Raw JSON is byte-identical to pre-change output

For the `dockerize` task: fetched `GET /tasks/:id`, computed
`JSON.stringify(data.approval, null, 2)` independently in the browser,
clicked the toggle, and compared it against `#modal-body`'s live
`textContent`. **Exact match** (`matchesExpected: true`), and the toggle
correctly flips `Show raw JSON` ↔ `Hide raw JSON`.

### Non-approval "Result" view is unaffected

Submitted a read-only `analyze-project` task, opened its modal: title
read `Result — <id>`, `#modal-approval` stayed hidden and empty,
`#modal-raw-toggle` stayed hidden, `#modal-body` displayed immediately
with the exact `=== DevOps MCP Analysis ===...` text it always has —
confirming the branch for non-`input-required` tasks is byte-for-byte
unchanged.

### Approve/reject unchanged

- `create-gitignore` and `dockerize` tasks rejected via the real
  `POST /tasks/:id/reject` endpoint: both reached `failed`, and the
  fixture project's working tree was confirmed clean (`git status
  --porcelain`) after every rejection across all six skill tests — no
  file was ever written by a rejected preview.
- The approve/reject buttons' `fetch()` calls and request bodies are
  untouched by this change (verified by inspection — `approve()`/
  `reject()` functions were not modified).

### No console errors

`read_console_messages` with `onlyErrors: true` returned empty at every
checkpoint during this verification.

## Scope discipline

- No change to `ApprovalPreview` (`packages/shared/approval.ts`), the
  approval gate's server-side logic, or any HTTP contract — confirmed by
  `git diff` touching only `apps/orchestrator/index.ts`'s dashboard HTML
  string.
- `apps/tui/index.tsx`'s equivalent gap is untouched, per this spec's own
  Non-Goals — it remains a separate, deliberately deferred checkpoint.

## Known limitations

- The dashboard has no light/dark theme support at all (confirmed, not
  assumed) — a single fixed dark palette. The spec's acceptance criterion
  about correct rendering "in both light and dark" is satisfied vacuously;
  there is only one theme to render correctly, and it does.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

See specs/051-planning-retirement-and-required-key/verification.md for the relocated narrative covering this checkpoint.

See specs/030-authoritative-skill-dispatch-and-capability-catalog/verification.md for the relocated narrative covering this checkpoint.

See specs/040-approval-preview-content-diff/verification.md for the relocated narrative covering this checkpoint.
