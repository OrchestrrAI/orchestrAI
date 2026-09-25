# Verification: specs/123-safe-env-template-filename-exemption

## What changed

- `packages/mcp/index.ts`: added `SAFE_ENV_TEMPLATE_FILENAMES` (exact
  basename set: `.env.example`, `.env.sample`, `.env.template`,
  `.env.dist`), checked case-insensitively before the existing
  `SENSITIVE_FILENAME_PATTERNS` in `isSensitiveFilename()`. Updated
  `read_project_file`'s tool description to mention the exemption.
- `packages/mcp/project-file-tools.test.ts`: new adversarial coverage —
  all four exempted names (plus a mixed-case variant) on both read and
  write; a decoy (`.env.example.local`) confirming the exemption is exact-
  name, not a loosened pattern; `.env.local` and `.env` itself confirmed
  unaffected.

## Automated verification

- `bun test packages/mcp/project-file-tools.test.ts` — 27 pass, 0 fail.
- `bun test packages/mcp` — 59 pass, 2 skip (pre-existing, unrelated), 0 fail.
- `bun test` (full suite) — **1466 pass, 2 skip, 0 fail.** (Notably, the
  previously-flaky `devops/index.test.ts` "no live MCP server" case now
  passes too — the stray global `orchestrai` process from earlier in this
  session is apparently no longer listening on port 3006.)
- `bun run typecheck` — **not clean**, but for reasons unrelated to this
  spec: `apps/supervisor/index.ts` and `apps/supervisor/init-web.ts` (files
  this spec never touches) currently fail typecheck against concurrent,
  uncommitted, in-progress changes to `apps/supervisor/init-form-state.ts`/
  `init-form.tsx` (git status confirms those two files are modified,
  unrelated to this session's work — apparently another concurrent spec's
  in-progress implementation, likely specs/122). Confirmed unrelated:
  `packages/mcp/index.ts` and `project-file-tools.test.ts` (this spec's
  only touched files) have no reported errors; the full test suite passes
  (Bun's runner transpiles but doesn't type-check as strictly as `tsc`,
  and the actual runtime logic here is simple and test-covered). Whoever
  is mid-implementing that other spec should re-run typecheck once their
  own work lands.
- `bun run specs:catalog` / `bun run specs:check` — clean, 122 spec
  directories, `CLAUDE.md` within budget.

## Live verification

Ran an isolated `mcp:http` instance (port 5006, separate from the user's
own live stack on 4006 — deliberately not touched, since it was mid-session
for the user) and called `read_project_file`/`write_project_file` directly
against a fresh scratch project via a small MCP client script:

```
write .env.example -> isError: undefined | Wrote 49 bytes to .env.example
read .env.example  -> isError: undefined | ORCHESTRAI_LLM_API_KEY=
                                             ORCHESTRAI_LLM_PROVIDER=
write .env.example.local (decoy) -> isError: true | Denied: sensitive file denied: .env.example.local
write .env (real)  -> isError: true | Denied: sensitive file denied: .env
```

Exactly the intended behavior: the exempted name works end-to-end (write
then read-back matches); the decoy and the real `.env` both remain denied.
The isolated test process was stopped afterward.

## Acceptance criteria — status

- [x] Explicit approval recorded (Yusuf, 2026-09-24, via direct chat
      instruction).
- [x] `read_project_file`/`write_project_file` both succeed for the four
      exempted names (case-insensitively) — unit-tested and live-confirmed.
- [x] `.env`, `.env.local`, and a `.env.example.local` decoy all remain
      denied — unit-tested and live-confirmed (`.env`, `.env.example.local`);
      `.env.production`/`.env.development`/`.env.test` covered by the
      unchanged shared regex, not independently re-tested (same pattern,
      no new risk).
- [x] `bun test` passes (1466/0). `bun run typecheck` has pre-existing,
      unrelated failures from a concurrent in-progress change — not this
      spec's files, documented above.
- [x] Live check performed and passed (see above).
- [x] `context/worklog.md` entry appended.

## Known limitations / next step

- The exemption is deliberately narrow (four exact names) — a project
  using a different template convention (e.g. `.env.defaults`) stays
  denied, per this spec's own Out of Scope section; a real, named case can
  widen it later.
- The unrelated `apps/supervisor` typecheck breakage should be re-checked
  by whoever is implementing that concurrent change once it lands.
