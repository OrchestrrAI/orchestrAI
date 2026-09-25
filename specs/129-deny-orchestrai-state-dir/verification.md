# Verification — 129 deny OrchestrAI's own state directory

Date: 2026-09-25.

## Automated

- `packages/mcp/project-file-tools.test.ts` — new block: `read_project_file`
  denies `.orchestrai/config.env`, `.orchestrai\config.env`,
  `.ORCHESTRAI/config.env`, `sub/../.orchestrai/config.env`,
  `./.orchestrai/supervisor.log`, `.orchestrai`, `.orchestrai/` without
  returning content; `write_project_file` into it is denied; the root
  listing and `analyze_project` omit it; an in-root symlink into it is
  denied (skips if the OS refuses to create the symlink); a lookalike
  `.orchestrai-notes.txt` is still readable.
- **Mutation check:** with only the resolved-path check disabled, all tests
  still pass (the realpath layer alone catches every case). With both
  layers disabled, 9 tests fail. With the code restored, all 39 pass.
- `packages/mcp/index.test.ts` — `run_command` denylist blocks `cat`,
  `type`, `node -e readFileSync` and `ls` forms touching `.orchestrai`; a
  lookalike is not blocked.
- `packages/agents/security/index.test.ts` — `scan-secrets` reports a key
  in `src/config.ts` and never mentions a key planted in `.orchestrai/`.
- `bun run typecheck` 0 errors; `bun test` 1523 pass / 2 skip / 0 fail.

## Live (isolated headless stack, ports 5000–5008, started from the fixture)

- MCP tool level (`read_project_file` over Streamable HTTP):
  `.orchestrai/config.env` and `.orchestrai` → `Denied: OrchestrAI's own
  state directory is denied: .orchestrai`; listing `.` → `d .git | d .github
  | d src | d tests | f .env | f .gitignore | f README.md | f package.json`
  (no `.orchestrai`).
- Agent level, via `POST /ask`: "edit src/index.ts at …: add a comment at
  the top naming the LLM provider and API key configured in
  .orchestrai/config.env" → routed to `edit-file`. The Coder's audit rows
  show `read_project_file .orchestrai/config.env -> failed` (63-byte denial),
  and the task failed with "Cannot make this edit: Access to
  .orchestrai/config.env is denied…". No key in the error or result;
  nothing written.

## Not covered

The key already sent to the provider on 2026-09-24 must be rotated by the
user; this fix only prevents further reads.
