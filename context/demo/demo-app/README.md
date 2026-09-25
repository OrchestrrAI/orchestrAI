# Demo shop

A tiny Bun + Hono shop API used by OrchestrAI's demo rehearsal
(`bun run demo:ag-ui`, specs/142). It is imperfect on purpose:

- `tests/pricing.test.ts` has one failing test (a bug in `applyDiscount`);
- `src/inventory.ts` has no tests;
- there is no Dockerfile, CI workflow, or compose file;
- `src/config.ts` holds a **fake** hardcoded key for the secret scan.

The demo never edits this folder. Each run copies it to a temp folder and
works on the copy. OrchestrAI's own `bun test` skips it (`bunfig.toml`).
