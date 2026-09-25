# specs/131 — verification

## Result

Implemented and verified on 2026-09-25.

## Automated

- `scripts/demo-preflight.test.ts`: argument parsing and every pure check
  (config, key-failure classification, terminal thresholds, ports, baseline,
  opt-ins, exit code, redaction), plus a full `main()` run in a temp folder
  asserting the configured key never appears in the output.
- `scripts/ag-ui-demo.test.ts`: scenario 2's opt-in rule and scenario 5's
  read-only route rule.
- typecheck 0; `bun test` 1647 pass / 0 fail.

## Live

- `bun run demo:ag-ui` against a full isolated stack (ports 5000–5008,
  scratch project): **passed 6/6 with the pre-check off** (123 events;
  scenario 2 printed "opt-in and off"), and **6/6 with it on** (135 events;
  Security A2A start/result seen). Scenario 5 routed to `scan-secrets`.
- `bun run demo:preflight` from the fixture: Ready (config, live key call,
  ports free). With `--live` against the running stack: all 8 `/healthz`
  OK, capabilities OK, `STATE_SNAPSHOT` delivered, `.orchestrai/config.env`
  read denied.
- Induced problems: wrong folder → Config FAIL, exit 1; config with no key →
  Config and Key FAIL; a stray listener on 3002 → Ports FAIL naming
  `devops:3002` and listing the process; a 70×20 PTY → Terminal FAIL, exit 1.
- Fixture hashes unchanged.

## Found during live verification

- **Fixed here:** the demo's POST /tasks shared the 5 s per-call limit, but
  POST now makes the LLM routing call first (specs/065), so scenario 5
  timed out. Task submission now allows 60 s.
- **Fixed later by specs/141:** agents send live
  audit events to `ORCHESTRAI_ORCHESTRATOR_URL` or a hardcoded
  `http://localhost:3000` (`packages/shared/audit.ts`), ignoring
  `ORCHESTRAI_ORCHESTRATOR_PORT`. On a custom Orchestrator port no
  `TOOL_CALL_*` events reach its `/events`, and they go to whatever is on
  3000 instead. The live runs above set `ORCHESTRAI_ORCHESTRATOR_URL`
  explicitly to work around it.
